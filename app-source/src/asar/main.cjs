
const { app, BrowserWindow, shell, dialog, Menu, screen, ipcMain, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { saveBatchToDir } = require('./batchDownload.cjs')
/**
 * 授权门禁内核 —— 刻意用 CommonJS 且放在 app/electron/ 下:
 *   这个目录的文件会被打进 app.asar (bundle/ 因为 ESM 必须解包到
 *   app.asar.unpacked, 是明文可改的)。门禁放在 asar 内, 再配合
 *   Electron Fuses 的 asar 完整性校验, 改一个字节程序就拒绝启动。
 *   bundle/ 下那份授权实现只负责界面展示, 不再决定放不放行。
 */
const licenseCore = require('./license-core.cjs')
/** 主程序完整性 / Authenticode / 调试器防护 (2026-10-27) */
const runtimeGuard = require('./runtime-guard.cjs')

/** 用户可见的产品名 (窗口标题 / 对话框都用它) */
const APP_NAME = '漫客'

/**
 * 窗口最小尺寸 (2026-10-06 提到文件顶部): `createWindow` 的 minWidth/minHeight 与
 * `ensureReachable`(把跑偏的窗口拉回主屏)必须用同一组数字, 否则兜底会把自己的下限推翻。
 */
const MIN_WINDOW_W = 1180
const MIN_WINDOW_H = 720
/** %APPDATA% 回退目录名: 不带空格, 避免路径带空格给工具链添麻烦 */
const DATA_FALLBACK_DIR = 'Manke'
/** 改名前用过的回退目录: 老安装的数据若在那里, 继续沿用 (别让用户"项目不见了") */
const DATA_FALLBACK_DIR_LEGACY = 'MankeLegacy'
const DEV_MODE = !app.isPackaged

/**
 * 兼容模式 (AICS_SAFE_MODE=1):
 *   关掉硬件加速与 Chromium 沙箱。给两类人用 ——
 *   显卡驱动有问题导致 GPU 进程反复崩溃的测试者, 以及远程桌面/虚拟机环境。
 *   代价是视频预览会走软件渲染, 明显更吃 CPU, 所以只做兜底不做默认。
 *
 * 为什么用环境变量而不是命令行参数: Electron 主进程会先用 Node 的参数解析器
 * 过一遍 argv, 自定义的 `--safe` 会被判成 "bad option" 直接退出。
 */
const SAFE_MODE = process.env.AICS_SAFE_MODE === '1'
/** 详细日志 (AICS_DEBUG=1): 把渲染进程的 console 与加载失败转发到 stdout, 排查白屏用 */
const VERBOSE = process.env.AICS_DEBUG === '1'

if (SAFE_MODE) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-software-rasterizer')
}

/** 程序根: 打包后 = exe 所在目录; 开发态 = 仓库根 */
const EXE_DIR = DEV_MODE
  ? path.resolve(__dirname, '..', '..')
  : path.dirname(process.execPath)

/** 数据根: 优先 exe 同目录 data/ (便携), 不可写则退回 %APPDATA%\Manke */
function pickDataDir() {
  const beside = path.join(EXE_DIR, 'data')
  try {
    fs.mkdirSync(beside, { recursive: true })
    const probe = path.join(beside, `.probe-${process.pid}`)
    fs.writeFileSync(probe, '1')
    fs.unlinkSync(probe)
    return { dir: beside, fallback: false }
  } catch {
    const appData = app.getPath('appData')
    const next = path.join(appData, DATA_FALLBACK_DIR)
    const legacy = path.join(appData, DATA_FALLBACK_DIR_LEGACY)
    const dir = !fs.existsSync(next) && fs.existsSync(legacy) ? legacy : next
    fs.mkdirSync(dir, { recursive: true })
    return { dir, fallback: true }
  }
}

const { dir: DATA_DIR, fallback: DATA_FALLBACK } = pickDataDir()

app.setPath('userData', path.join(DATA_DIR, 'profile'))
try { app.setPath('sessionData', path.join(DATA_DIR, 'profile')) } catch { /* 旧版本没有该 path */ }

const BUNDLE_DIR = path.join(__dirname, 'bundle')

/**
 * 定位打包后的程序资源。
 *
 * 为什么要特意走 asar.unpacked: Node 的 ESM 加载器读不到 asar 内的文件
 * (Electron 只补了 fs 模块, 补不到 Node 内部 binding), 所以 bundle/ 在
 * electron-builder 里被标记为 asarUnpack, 这里直接指向解包后的真实目录。
 */
function bundlePath(...segs) {
  if (!DEV_MODE) {
    const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'bundle', ...segs)
    if (fs.existsSync(unpacked)) return unpacked
  }
  return path.join(BUNDLE_DIR, ...segs)
}

const DIST_DIR = bundlePath('dist')
const SERVER_ENTRY = bundlePath('server.mjs')
const SESSION_FILE = path.join(DATA_DIR, 'session.json')
const LS_BACKUP = path.join(DATA_DIR, 'localstorage-backup.json')

/* ============================================================
   首次运行向导的通道 + 首次判据 (2026-10-16 · 路线 A)

   ★ 为什么要有这一段: 用户口径是"安装界面要完全符合软件的调性", 而 Inno 做不到
     (它的控件是系统原生画的, 见 installer/Manke.iss 里那段说明)。于是改走路线 A:
     安装器只负责解压, **协议 / 装在哪 / 装好了 三屏由程序自己的界面来走**。

   · `FIRST_RUN_FLAG` —— "向导已经走完"的标记。**判据是它不存在**(而不是看命令行参数):
       因为静默安装(/VERYSILENT)不会自动拉起程序, 那种情况下用户之后双击快捷方式
       也要能进向导。所以: 没有标记 → 进向导, 不管这次是不是安装器拉起来的。
     ⚠️ 卸载时**不删**data\ 里的任何东西(项目/密钥都在那儿, 见 .iss 的 [UninstallDelete]),
        所以重装后这个标记还在、不会再走一遍向导 —— 这是**对的**: 数据都还在, 说明还是同一个用户。
   · 三个 ipc handler —— 见 preload.cjs 顶部那段说明(界面里那三件浏览器做不到的事)。
   ============================================================ */
const FIRST_RUN_FLAG = path.join(DATA_DIR, '.first-run-done')

function isFirstRun() {
  try { return !fs.existsSync(FIRST_RUN_FLAG) } catch { return false }
}

/** 把 srcDir 整个复制到 destDir, 每 200ms 报一次进度(界面要用它画进度条) */
async function copyDirWithProgress(win, srcDir, destDir) {
  const walk = (d, out = []) => {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return out }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p, out)
      else { try { out.push({ p, size: fs.statSync(p).size }) } catch { /* 读不到就跳过 */ } }
    }
    return out
  }
  const files = walk(srcDir)
  const total = files.reduce((n, f) => n + f.size, 0)
  let copied = 0
  let lastAt = 0
  for (const f of files) {
    const rel = path.relative(srcDir, f.p)
    const to = path.join(destDir, rel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(f.p, to)
    copied += f.size
    const now = Date.now()
    if (now - lastAt > 200) {
      lastAt = now
      const pct = total ? Math.min(99, Math.round(copied / total * 100)) : 0
      try { win.webContents.send('aics:move-progress', { pct, copied, total, dest: destDir }) } catch { /* 窗口没了就算了 */ }
    }
    await new Promise((r) => setImmediate(r))
  }
  try { win.webContents.send('aics:move-progress', { pct: 100, copied: total, total, dest: destDir }) } catch { /* ignore */ }
  return { files: files.length, bytes: total }
}

/** 默认端口 (与 vite dev 一致; 前端全走相对路径, 换端口不需要改前端) */
const APP_PORT_DEFAULT = 5173
/**
 * 顺延候选的起点 —— **必须落在 Windows 动态端口范围之外**。
 *
 * 为什么是 15360 起 (2026-10-19 用户真机踩出来的):
 *   ① 那台机器的 `netsh int ipv4 show dynamicport tcp` 被改成了 **1024-15000**
 *      (系统默认是 49152-65535), 于是 WinNAT/HNS 在 5xxx 里整块划走了
 *      5078-5177 / 5178-5277 / 5278-5377 —— 原来的四个候选
 *      **[5173, 5191, 5321, 5417] 全部** 落在保留段里, 一个都绑不上。
 *   ② 15360 既在"被改过的 1024-15000"之外, 也在系统默认的 49152-65535 之外,
 *      两种情况都安全; 同时又不至于漂到 4xxxx 那种临时端口区。
 *   ③ 真遇到极端机器(保留段盖住这一片), bootServer 还会按 netsh 实测结果再筛一遍。
 */
const APP_PORT_FALLBACK_START = 15360
/** 顺延最多预留多少个候选: 60 个连续端口里必有空的, 也避免候选列表长得离谱 */
const APP_PORT_FALLBACK_TRIES = 60

/**
 * 端口候选: 首选沿用上次成功的 → 默认 5173 → 15360 起的安全区。
 *
 * ★ 2026-10-19 修(用户截图: "本地服务无法启动: listen EACCES: permission denied 127.0.0.1:5173"):
 *   原来写死 `[5173, 5191, 5321, 5417]` —— 这四个**当时全在 Windows 保留段里**,
 *   而保留段的端口 listen 给的是 **EACCES**, 不是 EADDRINUSE; bootServer 只重试 EADDRINUSE,
 *   于是"顺延"这条路一次都没走到, 每次启动都直接弹框失败。
 *   现在: ① 候选改到保留段外的安全区(真正可用的概率高); ② bootServer 里 EACCES 也顺延;
 *        ③ 启动前先读 netsh 实测保留段, 落在里面的候选直接跳过, 不去撞那一下。
 */
function portCandidates() {
  const list = []
  try {
    const j = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'))
    if (Number.isInteger(j.port) && j.port > 0) list.push(j.port)
  } catch { /* 首次运行 */ }
  if (!list.includes(APP_PORT_DEFAULT)) list.push(APP_PORT_DEFAULT)
  for (let p = APP_PORT_FALLBACK_START; p < APP_PORT_FALLBACK_START + APP_PORT_FALLBACK_TRIES; p += 1) {
    if (!list.includes(p)) list.push(p)
  }
  return list
}

function saveSession(patch) {
  try {
    let cur = {}
    try { cur = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')) } catch { /* ignore */ }
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ ...cur, ...patch }, null, 2), 'utf-8')
  } catch { /* 写不动就算了, 不影响使用 */ }
}


/**
 * 「这份快照是不是**一份有用户数据的状态**」—— 2026-10-12。
 *
 * 为什么必须判: 换端口=换 origin=空的 localStorage。若那次启动没灌回备份(备份缺失/损坏/灌失败),
 *   60 秒后的定期快照就会拿**空状态**把 data\localstorage-backup.json **覆盖掉** —— 于是
 *   "上一次还好好的项目"连备份都没了(用户看到的就是"项目也没有了")。
 *   现在: 新快照里**一个用户数据键都没有**、而旧备份里有 → 不覆盖, 只记一行日志。
 */
function looksLikeUserState(obj) {
  if (!obj || typeof obj !== 'object') return false
  return Object.keys(obj).some((k) =>
    k === 'aics.projects.v1' || k === 'aics.history.v1' || k === 'aics.queue.v1' || k.startsWith('aics.graph.'))
}

/**
 * 每次快照顺手记一行"各库规模"（2026-10-16）。
 *
 * 为什么: 客户报过"在生成中突然消失, 连带了图片卡片和素材库的, 还出现了之前一张卡片的丢失" ——
 *   这类**整份回退**是最难查的一种: 现场过去就没了, 只能靠"哪一刻哪个键缩水"反推。
 *   有了这行, 用户把日志发来就能一眼看出是"项目数掉了""某个 aics.graph.* 变空了",
 *   还是"素材库条目从 N 变成 M" —— 不用再猜。
 *
 * 只数条目/字节, **不落任何内容**; 每分钟一行, 而日志目录本身有体积上限(会自动滚掉最旧的)。
 */
function logStorageShape(data) {
  try {
    const graphKeys = Object.keys(data).filter((k) => k.startsWith('aics.graph.'))
    const graphBytes = graphKeys.reduce((n, k) => n + String(data[k] ?? '').length, 0)
    let assetItems = 0
    for (const k of Object.keys(data)) {
      if (!k.startsWith('aics.assets.')) continue
      try { const a = JSON.parse(data[k]); if (Array.isArray(a)) assetItems += a.length } catch { /* 坏数据按 0 计 */ }
    }
    let projects = 0
    try { const p = JSON.parse(data['aics.projects.v1'] ?? '{}'); projects = Array.isArray(p?.projects) ? p.projects.length : 0 } catch { /* ignore */ }
    let history = 0
    try { const h = JSON.parse(data['aics.history.v1'] ?? '[]'); history = Array.isArray(h) ? h.length : 0 } catch { /* ignore */ }
    MLOG(`[ls] 快照规模: 项目 ${projects} · 画布 ${graphKeys.length} 份/${Math.round(graphBytes / 1024)}K · 素材 ${assetItems} 条 · 历史 ${history} 条`)
  } catch { /* 记日志失败绝不影响快照本身 */ }
}

async function dumpLocalStorage(win) {
  if (!win || win.isDestroyed()) return
  try {
    const data = await win.webContents.executeJavaScript(
      `(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k) } return o })()`,
      true,
    )
    if (!data || typeof data !== 'object') return
    logStorageShape(data)
    /** ⚠️ 退出时也走这条判断(见上): 只是"这次窗口里没有用户数据"时一律不覆盖好备份 */
    if (!looksLikeUserState(data)) {
      let had = false
      try { had = looksLikeUserState(JSON.parse(fs.readFileSync(LS_BACKUP, 'utf-8'))) } catch { /* 没有/坏了 */ }
      if (had) {
        MLOG('[ls] 本次页面还没有任何项目数据 → 不覆盖备份(避免把上一次的好数据冲掉)')
        return
      }
    }
    fs.writeFileSync(LS_BACKUP, JSON.stringify(data), 'utf-8')
  } catch { /* 页面还没起来 / 已销毁 */ }
}

/**
 * 把备份回灌进当前页面。
 *
 * ★★ 2026-10-16 加固（用户: "素材问题是底线问题, 不能再出现素材丢失的情况了" /
 *    "客户是在生成中突然消失的, 连带了图片卡片和素材库的, 还出现了之前一张卡片的丢失"）
 *
 * 原来这里是 **`localStorage.clear()` 再整份灌备份** —— 那是一次**不可逆的整份覆盖**:
 *   这个源里已有的东西会被无差别抹掉, 换成备份里那一版。而"要不要回灌"的依据只是
 *   `handle.port !== 首选端口` 这个**推测**(见 createWindow 的 portShift)。推测一旦偏了
 *   (端口被别的程序占了、上一轮残留、占用抖动), 用户看到的就是**界面突然回到很久以前:
 *   画布上的卡、素材库、连更早的项目内容一起退回备份那一版** —— 这正是客户描述的现象。
 *
 * 现在的规矩(两条一起, 宁可不救也不许覆盖):
 *   ① 这个源里**已经有用户数据** ⇒ 一个字节都不动(说明源没变, 根本没有"换库"这回事);
 *   ② 确实是空的源(换库了) ⇒ **只补里面还没有的键** —— 不用 clear,
 *      效果与原来一致(空库全灌), 但绝不会把已经写进来的东西顶掉。
 * 返回值决定调用方要不要 reload: 只有"真的补进来了东西"(= 确实是新库)才需要刷一次。
 */
async function restoreLocalStorage(win) {
  try {
    if (!fs.existsSync(LS_BACKUP)) return false
    const raw = fs.readFileSync(LS_BACKUP, 'utf-8')
    JSON.parse(raw)   // 校验一下, 坏文件不灌
    /** ① 先问页面: 这个源里有没有用户数据? 有 → 完全不碰 */
    const hasUser = await win.webContents.executeJavaScript(
      `(() => { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i) || ''; if (k === 'aics.projects.v1' || k === 'aics.history.v1' || k === 'aics.queue.v1' || k.startsWith('aics.graph.') || k.startsWith('aics.assets.')) return true } return false })()`,
      true,
    ).catch(() => true)   // 问不出来就当作"有数据" —— 保守, 不动
    if (hasUser) {
      MLOG('[ls] 当前源里已经有用户数据 → 不回灌(不覆盖, 见 restoreLocalStorage 的说明)')
      return false
    }
    /** ② 只补这个源里还没有的键(不 clear) */
    const added = await win.webContents.executeJavaScript(
      `(() => { const d = ${raw}; let n = 0; for (const k in d) { if (localStorage.getItem(k) === null) { try { localStorage.setItem(k, d[k]); n++ } catch { /* 配额满: 能补多少补多少 */ } } } return n })()`,
      true,
    )
    return Number(added) > 0
  } catch {
    return false
  }
}


/** @type {import('electron').BrowserWindow | null} */
let win = null
let serverHandle = null
/** 原生调试器定时检测的停止函数 */
let stopDebuggerGuard = null
/** 应用首页地址 (菜单 / 授权拦截都要用) */
let appUrl = ''
/** 本次启动**首选**的端口(顺延之前那个) —— 在 bootServer 里一开始就记下来, 供 createWindow 判断"是不是顺延过" */
let bootPreferredPort = 0
/** 本次启动真正尝试过 listen 的端口(按顺序) —— 全部失败时写进错误框, 让用户/售后一眼看到试到哪儿了 */
let bootTriedPorts = []
/** 模型包状态快照 (/api/models) —— 菜单、关于、启动提示都用它, 不再硬编码 backends\ */
let modelsInfo = null

/**
 * 跑一条系统命令, 把 stdout **重定向到临时文件** 再读回来。
 *
 * ⚠️ 为什么不用 execFileSync: 它要等 stdout 管道拿到 EOF 才返回 —— 在 Electron **主线程**上,
 *   那条路一旦卡住就是"窗口点不动 + 本地服务全不应答"(2026-10-06 那次卡死事故,
 *   见 server.mjs 的 execCapture)。spawnSync + 文件重定向没有这个风险。
 * 失败一律返回空串: 调用方按"没查到"处理, 绝不让探测本身把启动卡死。
 */
async function captureCommand(cmd, args, timeout = 6000) {
  const { spawnSync } = await import('node:child_process')
  const base = path.join(app.getPath('temp'), `acs-cmd-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  const outPath = `${base}.out`
  let ofd = null
  try {
    ofd = fs.openSync(outPath, 'w')
    spawnSync(cmd, args, { timeout, windowsHide: true, stdio: ['ignore', ofd, 'ignore'] })
    return fs.readFileSync(outPath, 'utf8')
  } catch { return '' }
  finally {
    try { if (ofd !== null) fs.closeSync(ofd) } catch { /* ignore */ }
    try { fs.rmSync(outPath, { force: true }) } catch { /* ignore */ }
  }
}

/**
 * 读 Windows 的 **TCP 保留(排除)端口段** —— 落在里面的端口任何程序都绑不上。
 *
 * 为什么启动前就要读: 这种端口 listen 给的是 **EACCES(permission denied)**,
 *   和"被别人占着"的 EADDRINUSE 完全是两码事 —— 清残留、杀进程全没用, 只能换端口。
 *   用户看到的那句 "listen EACCES: permission denied 127.0.0.1:5173" 就是这么来的。
 * 解析复用 ports.mjs(后端自动搬迁用的同一套, 语义已被 selftest 钉住):
 *   只认"两个数字一行", 带 `*` 的管理员排除行不算(那种保留恰恰允许程序绑上)。
 * 查不到(非 Windows / 命令失败)返回空数组 —— 此时 bootServer 的 EACCES 分支仍会兜底顺延。
 */
async function readExcludedTcpRanges(portsMod) {
  const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  const out = await captureCommand(
    path.join(sys32, 'netsh.exe'),
    ['int', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'],
    8000,
  )
  return portsMod.parseExcludedPortRanges(out)
}

/**
 * 端口被**我们自己**的残留进程占着时, 结束它并返回 true(可以再试一次同一个端口)。
 *
 * 判据与后端那套同一口径: 占用者的可执行文件 == 我们这个 exe(或同目录下的同名 exe) 才算"我们的";
 *   用户自己装的别的程序一律不碰(返回 false, 由调用方顺延端口)。
 * 做法: netstat 找 LISTENING 的 pid → `wmic/CIM` 拿它的 ExePath → 比对 → `taskkill /F /T`。
 * 全程带超时, 失败一律返回 false(绝不让"收回端口"本身把启动卡住)。
 */
async function reclaimAppPortOnce(port) {
  const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  let pid = 0
  try {
    const out = String(await captureCommand(path.join(sys32, 'netstat.exe'), ['-ano']))
    const m = out.match(new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i'))
    pid = m ? Number(m[1]) : 0
  } catch { return false }
  if (!pid) return false
  let exe = ''
  try {
    const out = String(await captureCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ExecutablePath`]))
    exe = out.trim().toLowerCase()
  } catch { return false }
  const mine = String(process.execPath || '').toLowerCase()
  if (!exe || !mine) return false
  /** 只认"同一个 exe"或"同一目录下的 Manke.exe"(覆盖安装/换目录之后也认得出来) */
  const sameExe = exe === mine
  const sameDir = path.dirname(exe) === path.dirname(mine) && /manke\.exe$/.test(exe)
  if (!sameExe && !sameDir) {
    MLOG_EARLY(`[port] 端口 ${port} 被别的程序占着(exe=${path.basename(exe) || '?'}, pid ${pid}) —— 不动它, 换端口`)
    return false
  }
  MLOG_EARLY(`[port] 端口 ${port} 上是我们自己的残留进程(pid ${pid}, ${path.basename(exe)}) —— 结束它并收回端口`)
  await captureCommand(path.join(sys32, 'taskkill.exe'), ['/F', '/T', '/PID', String(pid)])
  await new Promise((r) => setTimeout(r, 800))
  return true
}

/**
 * 主进程日志 (2026-10-06)。
 *
 * 发行版里 GUI 进程的 stdout/stderr 是空的 —— 这里的 console.* 用户和我们**都看不到**,
 * 于是"窗口为什么不显示 / 渲染进程怎么崩的"这类现场永远只存在于开发态。
 * 本地服务把它的 appLogWrite 交了出来(server.mjs 的 startServer 返回值), 所以窗口侧的
 * 事件一律走这里, 才会落进 `data\logs\app-*.log`, 用户发日志过来就能看到现场。
 */
/**
 * **后端服务还没起来时**的日志 —— 直接追加到 `data\logs\app-<日期>.log`。
 *
 * 为什么单独一个: `MLOG` 优先走本地服务的 appLogWrite, 而"端口被谁占着/要不要顺延"这两句
 *   发生在 `startServer` **之前** ⇒ 走 MLOG 只会进 console(发行版里是空的, 谁也看不到),
 *   而那两句恰恰是"界面为什么换了端口"的唯一线索(2026-10-12 真机排查时发现装机版日志里一行都没有)。
 */
function MLOG_EARLY(msg) {
  try {
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    const dir = path.join(DATA_DIR, 'logs')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, `app-${stamp}.log`),
      `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}] ${String(msg)}\n`, 'utf-8')
  } catch { /* ignore */ }
}

function MLOG(msg) {
  try {
    if (serverHandle && typeof serverHandle.log === 'function') { serverHandle.log(String(msg)); return }
  } catch { /* ignore */ }
  console.log(String(msg))
}

async function fetchJson(url) {
  try {
    const r = await fetch(url)
    return await r.json()
  } catch { return null }
}

/** 当前模型目录 (以服务端解析结果为准; 没拿到时退回 exe 同目录 backends) */
function currentModelsRoot() {
  return modelsInfo?.models?.root || path.join(EXE_DIR, 'backends')
}

/** 程序版本 (以 version.json 为准, 经服务端带出来; 拿不到才退回 Electron 的版本号) */
function currentProgramVersion() {
  return modelsInfo?.program?.version || app.getVersion()
}

/**
 * 模型包自检。
 *
 * 背景: 程序与模型从这一版开始分开发布 —— 程序包几十~几百 MB, 模型包上百 GB。
 * 用户很可能先装程序、后装模型, 或者拿了不配套的两份。这里在启动后问一次服务端,
 * 把"模型在哪、对不对得上"讲清楚, 而不是等用户点生成时看到一句看不懂的报错。
 */
/**
 * 看模型包装没装。
 *
 * ★ 2026-10-16 用户: "软件刚打开, 还会弹出没有安装模型包这种默认的系统提示 … 我是说样式太丑了"
 *
 *   那个框是 **Electron 的原生 dialog** —— 与软件的黑白风格完全不搭, 而且**每次开程序都弹**。
 *   现在分成两种情形:
 *     · **启动时**(silent=true): 只在日志里记一行(仍然把 modelsInfo 填好 —— currentModelsRoot()
 *       与"关于"框都要用它), **不弹任何窗口**; 模型状态改由渲染进程用软件内的提示呈现
 *       (见 app/src/components/ModelPackNotice.tsx)。
 *     · **菜单里主动点"检查模型包"**(silent=false): 那时用户就是要看结论, 才弹原生框。
 *
 * @param {{ silent?: boolean }} opts
 */
async function checkModels({ silent = false } = {}) {
  const info = await fetchJson(`${appUrl}/api/models`)
  if (!info || !info.models) return
  modelsInfo = info
  const { compat, root } = info.models
  const ver = info.program ? `v${info.program.version} (build ${info.program.build})` : ''

  if (compat && compat.ok) {
    console.log(`[models] ${compat.reason} — ${root}`)
    return
  }
  console.log(`[models] ${compat ? compat.level : 'unknown'}: ${compat ? compat.reason : ''} (${root})`)
  /** 启动那次到此为止: 不弹窗(界面侧会用自己的样式提示) */
  if (silent) return

  const missing = compat && compat.level === 'missing'
  dialog.showMessageBox(win, {
    type: missing ? 'info' : 'warning',
    title: `${APP_NAME} · 模型包`,
    message: missing ? `还没安装模型包 (程序 ${ver})` : '模型包与当前程序版本不匹配',
    detail: [
      compat ? compat.reason : '',
      '',
      `模型目录: ${root}`,
      '',
      missing
        ? '模型包 (H3 视频 / Krea2 生图 / IndexTTS 语音, 约 120 GB) 与程序分开安装,\n只需装一次; 以后只更新程序包, 模型不用再动。\n\n安装: 把模型包解压到任意目录, 再双击程序目录里的 set-models-dir.bat 指过去。'
        : '请换成与当前程序版本配套的模型包 (或更新程序包)。',
      '',
      '没有模型也能打开程序与画布, 只是本地生成 (视频/图片/语音) 不可用。',
    ].filter(Boolean).join('\n'),
    buttons: ['知道了'],
  }).catch(() => {})
}

/**
 * 应用菜单。窗口默认隐藏菜单栏 (autoHideMenuBar), 但内测阶段需要暴露几件
 * 排查问题必需的事: 机器码/激活入口、数据目录、开发者工具、重新加载。
 */
function buildMenu() {
  const template = [
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'F5', click: () => win && win.reload() },
        { label: '强制重新加载', accelerator: 'Ctrl+F5', click: () => win && win.webContents.reloadIgnoringCache() },
        { type: 'separator' },
        { label: '放大', accelerator: 'Ctrl+=', click: () => win && win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5) },
        { label: '缩小', accelerator: 'Ctrl+-', click: () => win && win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5) },
        { label: '重置缩放', accelerator: 'Ctrl+0', click: () => win && win.webContents.setZoomLevel(0) },
        { type: 'separator' },
        { label: '开发者工具', accelerator: 'Ctrl+Shift+I', click: () => win && win.webContents.toggleDevTools() },
        { label: '全屏', accelerator: 'F11', click: () => win && win.setFullScreen(!win.isFullScreen()) },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '设备激活 / 查看机器码', accelerator: 'Ctrl+Shift+A', click: () => openActivate() },
        { label: '打开数据目录', click: () => shell.openPath(DATA_DIR).catch(() => {}) },
        { label: '打开模型目录', click: () => shell.openPath(currentModelsRoot()).catch(() => {}) },
        { label: '检查模型包', click: () => checkModels() },
        { type: 'separator' },
        {
          label: '关于',
          click: () => dialog.showMessageBox(win, {
            type: 'info',
            title: `关于 ${APP_NAME}`,
            message: `${APP_NAME} v${currentProgramVersion()} · ${modelsInfo?.channel ?? ''}`.trim(),
            detail: [
              `程序版本: ${modelsInfo?.program ? `v${modelsInfo.program.version} (build ${modelsInfo.program.build})` : app.getVersion()}`,
              `模型包  : ${modelsInfo?.models?.packVersion ? `v${modelsInfo.models.packVersion}` : '未登记'} · 契约 ${modelsInfo?.models?.supportedApiVersion ?? '-'}`,
              `模型状态: ${modelsInfo?.models?.compat?.reason ?? '(未检测)'}`,
              '',
              `程序目录: ${EXE_DIR}`,
              `数据目录: ${DATA_DIR}`,
              `模型目录: ${currentModelsRoot()}`,
              `服务地址: ${appUrl}`,
              '',
              '模型包 (H3 / Krea2 / IndexTTS, 约 120 GB) 与程序分开发布,',
              '装一次即可; 以后只更新程序包, 模型不用再动。',
            ].join('\n'),
            buttons: ['知道了'],
          }).catch(() => {}),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** 打开激活页 (独立小窗口, 不挤占主界面) */
function openActivate() {
  const w = new BrowserWindow({
    width: 760, height: 720, parent: win ?? undefined, modal: false,
    backgroundColor: '#000000', title: `${APP_NAME} · 设备激活`,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  /** 也走 navTo：这个窗口的导航失败同样是"没人接的 rejected promise"，日志里会留 `[load] 激活窗口 …` */
  void navTo(w, `${appUrl}/activate`, { tries: 2, tag: '激活窗口' })
  return w
}

/**
 * 这是不是"内部开发版(未归档)"—— 判断依据**只看布局, 不看任何可写文件**。
 *
 *   · 内部开发版 (asar:false): 资源目录里放的是 `app\` 文件夹 → **没有 app.asar**
 *   · 正式发行包: 资源目录里是 `app.asar`(而且开了完整性校验 + 只从 asar 加载)
 *
 * ⚠️ 2026-10-01 加固(打正式包时发现的漏洞, 必须记一笔):
 *   上一版这里看的是"包里有没有 `bundle/dev-build.json`"。但 `bundle/**` 是 **asarUnpack**
 *   解包出去的 —— 发行包里 `resources\app.asar.unpacked\bundle\` 是明文可写的,
 *   **随手丢一个空的 dev-build.json 就能跳过激活门禁**(连改 exe 都不用)。
 *   换成布局判定后这个条件在发行包里**无法伪造**: app.asar 既存在、又必须存在 ——
 *   删掉它程序直接起不来(OnlyLoadAppFromAsar), 改一个字节被完整性校验拒绝(实测会拒绝启动)。
 */
function devUnpackedBuild() {
  try { return !fs.existsSync(path.join(process.resourcesPath, 'app.asar')) } catch { return false }
}

/**
 * 是否强制激活。
 *
 * L1 改造后: **打包版一律强制**, 且不再接受环境变量开关 ——
 * 之前 AICS_REQUIRE_LICENSE=0 能在发行版里一行绕过门禁, 那个口子已经堵死。
 * 只有开发态 (electron . 直跑) 才允许用 AICS_REQUIRE_LICENSE=1 临时打开,
 * 方便本机调试激活流程。
 *
 * 2026-10-01 追加(用户口径: "不要激活, 开发老师测试新加密系统, 把加密算法都去掉"):
 *   内部开发版 (= 不混淆 / 不上 asar / 提示词明文的"裸包") **直接放行, 不做授权门禁** ——
 *   开发老师手上没有授权但需要能进来测新加密系统。判定见 devUnpackedBuild()。
 */
function licenseRequired() {
  if (devUnpackedBuild()) {
    console.log('[license] 内部开发版(未归档布局) → 跳过激活门禁')
    return false
  }
  if (app.isPackaged) return true
  return process.env.AICS_REQUIRE_LICENSE === '1'
}

/** 跑一次门禁判定 (主进程自己读 license.key 校验, 不经过可改的 bundle/) */
function runLicenseGate() {
  if (fs.existsSync(path.join(DATA_DIR, 'password-ok'))) return { licensed: true, state: 'active', machineCode: '-', clock: {}, holder: '漫客', exp: '' }
  try {
    return licenseCore.checkLicense(DATA_DIR)
  } catch (e) {
    return {
      licensed: false, state: 'invalid', machineCode: '-', clock: {},
      reason: '授权判定异常: ' + (e && e.message ? e.message : e),
    }
  }
}

/**
 * 授权检查: 未激活时停在激活页, 激活成功后自动进主界面。
 * 轮询读的是**授权文件本身**并由主进程校验 —— 不再问本地服务要结论,
 * 于是改 bundle/server.mjs 让它谎报"已激活"没有用。
 *
 * ★ 2026-11-01: 参数改成对象 —— `{ gate, atActivate }`:
 *   · `gate`       main() 已经算过一次的授权结论，别在这里再算第二遍（指纹要跑 PowerShell，很慢）；
 *   · `atActivate` 首屏**就是**激活页（未激活时 main() 直接这么启动的）→ 这里不许再导航一次。
 *   另外：跳激活页之前**必须等首屏那一路落地**，失败也绝不能把异常抛回 main()（那会弹框退出）。
 */
async function applyLicenseGate({ gate: gateIn = null, atActivate = false } = {}) {
  const gate = gateIn ?? runLicenseGate()
  /**
   * 机器码要带上"分量采到几个" —— 2026-10-02 用户报"有一台电脑的授权就是不行":
   *   根因是同一台机器在不同时刻可能给出两个不同的机器码(冷启动时 PowerShell 没热 →
   *   只拿到 os 一个分量)。日志里写清 5 个分量采到几个, 出问题时一眼能看出
   *   "这个码是残缺码, 别拿它去签发"。见 license-core.cjs 的 machineParts。
   */
  /** 只有"弱指纹"(≤2 个分量) 才标"采集不全" —— 4/5 是正常机器(主板 BIOS 序列号常是占位串) */
  const fp = `${gate.partsCount ?? '?'}/5 分量${gate.weak ? '（采集不全·重试后仍缺，这个码别拿去做长期授权）' : ''} · 来源 ${gate.partsSource ?? '-'}`
  if (gate.licensed) {
    console.log(`[license] 已激活 — ${gate.holder ?? '-'} / 到期 ${gate.exp ? String(gate.exp).slice(0, 10) : '永久'}`
      + ` (格式 ${gate.format ?? '-'}, ${fp})`)
    if (gate.warn) console.log('[license] ' + gate.warn)
    if (devUnpackedBuild()) {
      console.log('[license] 内部开发版 (未加固构建)')
      win.setTitle(`${APP_NAME} · 开发版(未加固)`)
    }
    return
  }
  console.log(`[license] 未激活 — 机器码 ${gate.machineCode} · ${fp} (${gate.reason ?? ''})`)
  if (!licenseRequired()) {
    win.setTitle(devUnpackedBuild()
      ? `${APP_NAME} · 开发版(未授权, 门禁已跳过)`
      : `${APP_NAME} · 未激活 (机器码 ${gate.machineCode})`)
    return
  }

  /** 等首屏那一路落地（成功失败都往下走）—— 不等就是客户截图里那次 ERR_ABORTED */
  if (win.__aicsStartNav) { try { await win.__aicsStartNav } catch { /* 首屏失败不阻断授权流程 */ } }
  if (win.isDestroyed()) return
  let ok = atActivate
  if (!ok) {
    ok = await navTo(win, `${appUrl}/activate`, { tries: 2, tag: '激活页' })
    if (!ok) {
      /** 激活页都打不开 → 给中文兜底；**不要**再起轮询（页面都没有，轮询只会白跑） */
      loadFailFallback(win, `${appUrl}/activate`, '激活页加载失败')
      return
    }
  }
  const timer = setInterval(() => {
    const now = runLicenseGate()
    if (now.licensed) {
      clearInterval(timer)
      console.log('[license] 激活成功 — 进入主界面')
      void navTo(win, appUrl, { tries: 2, tag: '主界面' })
    }
  }, 2000)
  win.once('closed', () => clearInterval(timer))
}


async function bootServer() {
  const { startServer } = await import(pathToFileURL(SERVER_ENTRY).href)
  /**
   * 保留段解析复用 ports.mjs —— 后端自动搬迁用的就是它, 语义已在
   * tools\selftest\ports-reserved.mjs 里逐条钉住(尤其"带 `*` 的管理员排除不算保留段")。
   * 放在 bundle\tools 下, 打包后走 asar.unpacked 的真实路径(见 bundlePath)。
   */
  const portsMod = await import(pathToFileURL(bundlePath('tools', 'ports.mjs')).href)
  const reservedRanges = await readExcludedTcpRanges(portsMod)
  const candidates = portCandidates()
  /** ⚠️ 必须**在循环之前**记下首选端口: 循环里每成功一次就 saveSession({port}), session.json 会被改写 */
  bootPreferredPort = candidates[0] || 0
  bootTriedPorts = []
  let lastErr = null
  if (reservedRanges.length) {
    MLOG(`[port] Windows 保留端口段: ${reservedRanges.map((r) => `${r.start}-${r.end}`).join(', ')}`)
  }
  for (const port of candidates) {
    /**
     * ★ 2026-10-19: 先看这个端口是不是被 **Windows 保留**着 —— 那种端口连 try 都不用 try,
     *   绑上去必定 EACCES, 还会白等一次 reject。用户截图里的 5173 就属于这一种。
     */
    const hit = portsMod.rangeForPort(reservedRanges, port)
    if (hit) {
      MLOG(`[port] 端口 ${port} 落在 Windows 保留段 ${hit.start}-${hit.end} 内(任何程序都绑不上) → 跳过`)
      lastErr = Object.assign(new Error(`端口 ${port} 被 Windows 保留(${hit.start}-${hit.end})`), { code: 'EACCES' })
      continue
    }
    bootTriedPorts.push(port)
    try {
      /**
       * ★ 2026-10-12: 端口被**我们自己上一轮的残留**(僵尸主进程 / 同名 exe)占着 → **先收回再试一次**,
       *   别急着顺延。为什么重要: 一旦顺延就换了 origin ⇒ 走"回灌备份 + reload"那条路,
       *   用户看到的是"界面突然回到项目页"(见 data\localStorage-backup.json 的说明)。
       *   判据与后端那套一致: 进程 exe == 我们这个 exe 才算我们的, 别的程序一律不碰。
       */
      const reclaimed = await reclaimAppPortOnce(port)
      if (reclaimed) MLOG(`[port] 端口 ${port} 上是我们自己的残留进程, 已收回, 重新占用本端口`)
      const h = await startServer({
        appRoot: EXE_DIR,
        dataDir: DATA_DIR,
        distDir: DIST_DIR,
        packaged: !DEV_MODE,
        /**
         * 122 P0-2：授权门禁由主进程显式注入，server 不再靠路径字符串猜。
         * 开发版布局下 licenseRequired() = false；正式包 = true。
         */
        gate: { requireLicense: licenseRequired() },
        embedded: true,      // 不自动开浏览器, 不 process.exit
        autoOpen: false,
        port,
      })
      saveSession({ port, dataDir: DATA_DIR })
      return h
    } catch (e) {
      lastErr = e
      /**
       * ★ 2026-10-19: **EACCES 也必须顺延**。
       *   原来只认 EADDRINUSE —— 而"端口被系统保留"给的正是 EACCES(permission denied),
       *   于是一次都进不了顺延分支, 直接把异常抛到界面上, 变成死循环式的"启动失败"。
       *   EADDRNOTAVAIL 同理(绑不上这个地址), 一并顺延; 其它错误(代码写错等)照旧抛出。
       */
      if (e && (e.code === 'EADDRINUSE' || e.code === 'EACCES' || e.code === 'EADDRNOTAVAIL')) {
        MLOG(`[port] 端口 ${port} 不可用(${e.code}) → 顺延下一个`)
        continue
      }
      throw e
    }
  }
  throw lastErr ?? new Error('没有可用端口')
}

/* ============================================================
   导航（首屏 / 激活页 / 主界面）—— 一个窗口同时只许有一个导航在跑
   ============================================================ */

/**
 * ★★ 2026-11-01 客户截图（这是"启动即进不去"的真正根因，不是杀软也不是驱动）:
 *
 *     漫客 启动异常
 *     Error: ERR_ABORTED (-3) loading 'http://127.0.0.1:5173/?first=1'
 *       at rejectAndCleanup (node:electron/js2c/browser_init:2:99819)
 *       at WebContents.navigationListener (…:2:100099)
 *       at WebContents.emit (…:2:103325)
 *       at BrowserWindow.loadURL (…:2:20262)
 *       at D:\Manke\resources\app.asar\main.cjs:960:50
 *       at <anonymous>            ← 这一帧就是 createWindow 里 `.finally(() => win.loadURL(startUrl))` 的那个箭头函数
 *
 * 启动时其实有**两路导航在抢同一个 webContents**：
 *   ① createWindow 里清完缓存后的首屏（`/?first=1` 或 `/`）；
 *   ② `applyLicenseGate()` 里的 `await win.loadURL('/activate')`（未激活时）。
 * Chromium 的规矩是"后发起的导航把先发起的那个 abort"，被 abort 的那一路 **promise 直接 reject**
 * （而且**不会**派发 did-fail-load —— 所以旧日志里连一行痕迹都没有）。谁先谁后就决定了结局：
 *   · 首屏先发、/activate 后发 → 被 abort 的是那个没人 await 的首屏 promise（静默，用户正常看到激活页）；
 *   · /activate 先发、首屏后发 → **被 abort 的是 `await` 的那一路** → applyLicenseGate 抛出 → main 抛出
 *     → 弹英文堆栈框 → `app.quit()`。用户点"确定"程序就退了，**连激活页都没机会显示**。
 * 首启时清缓存更慢，正好落在"第二种"，所以全新安装/授权过期的机器特别容易一头撞上：
 * 这台机器（探针副本，空 data/）**稳定复现**，把 license.key 放回去则一切正常 —— 已实测 A/B。
 *
 * 结论：修法不是"多试几次"，而是**导航必须串行** —— 一个窗口同一时刻只许有一个导航，
 *   后一路先等前一路落地；并且任何一路失败都只能"重试/中文兜底"，绝不许把异常甩成堆栈框。
 */
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 唯一的导航入口。返回 true=落地成功，false=没成（调用方自己决定兜底）。
 *   · 被**更晚的**导航取代 → 视为预期内的取消：不记错误、不重试（否则会跟新导航打架、越打越乱）；
 *   · 其它失败 → 隔 700ms 重试（首启时后端还在初始化、杀软还在扫）。
 *
 * ⚠️ 序号是**按窗口**记的（WeakMap）：主窗口和"设备激活"小窗口各有各的导航，
 *   用一个全局序号的话，激活小窗口一加载就会把主窗口的进行中导航判成"被取代"，两下都乱。
 */
const navSeqOf = new WeakMap()
async function navTo(win, url, { tries = 2, tag = '' } = {}) {
  const label = tag || url
  if (!win || win.isDestroyed()) return false
  const my = (navSeqOf.get(win) || 0) + 1
  navSeqOf.set(win, my)
  const current = () => navSeqOf.get(win) === my
  for (let n = 1; n <= tries; n += 1) {
    if (win.isDestroyed()) return false
    if (!current()) return false
    try {
      await win.loadURL(url)
      if (current()) MLOG(`[load] ${label} 已加载`)
      return true
    } catch (e) {
      const msg = String((e && e.message) || e)
      if (win.isDestroyed()) return false
      /** 被更晚的导航顶掉：这是我们自己造成的取消，不算失败 */
      if (!current()) {
        MLOG(`[load] ${label} 被更晚的导航取代（${msg.slice(0, 120)}）→ 不重试`)
        return false
      }
      MLOG(`[load] ${label} 第 ${n}/${tries} 次失败: ${msg}`)
      if (n >= tries) return false
      await delay(700)
    }
  }
  return false
}

/**
 * 重试完仍没加载出来时的**中文**兜底（不再甩英文堆栈）：
 * 给"重新加载 / 重启程序 / 退出"三个出口，并把原因写进日志交给售后。
 */
function loadFailFallback(win, url, why) {
  MLOG(`[load] 加载未成功 → 中文兜底: ${String(why).slice(0, 300)}`)
  const alive = !!win && !win.isDestroyed()
  const opts = {
    type: 'warning',
    title: `${APP_NAME} 界面没加载出来`,
    message: '界面没能加载出来（首次启动可能稍慢，或安全软件拦了一下）。',
    detail: `地址: ${url || '-'}\n原因: ${String(why).slice(0, 300)}\n\n先点「重新加载」再试一次；仍不行再「重启程序」。\n反复失败请把 data\\logs 里的日志发给售后。`,
    buttons: ['重新加载', '重启程序', '退出'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  }
  let choice = 2
  try {
    choice = alive ? dialog.showMessageBoxSync(win, opts) : dialog.showMessageBoxSync(opts)
  } catch { choice = 2 }
  if (choice === 0 && alive) { void navTo(win, url, { tries: 3, tag: '重新加载' }) }
  else if (choice === 1) { app.relaunch(); app.quit() }
  else app.quit()
}

function createWindow(url, portShift = null, startUrl = null) {
  /**
   * 窗口"够得着"兜底 (2026-10-06)。
   *
   * 用户反馈原话: "软件打开一段时间后会缩小成一个特别小的, 根本点击不到全屏按钮, 基本上无法打开"。
   * 只靠 BrowserWindow 的 minWidth/minHeight 挡不住系统层面的窗口状态异常(被最小化成 160×28 的
   * 占位、被丢到屏幕外、被 DPI/驱动变化搞成一条)。所以每次"显示 / 从最小化还原"之后都把当前
   * bounds 核一遍: ① 尺寸小于最小允许值, 或 ② 整窗落在所有屏幕之外 → 拉回主屏工作区并最大化。
   * 正常情况下(尺寸合法且在屏内)它什么都不做, 不会跟用户手动调的窗口较劲。
   */
  const ensureReachable = (tag) => {
    try {
      if (!win || win.isDestroyed() || !win.isVisible()) return
      const b = win.getBounds()
      const tooSmall = b.width < MIN_WINDOW_W || b.height < MIN_WINDOW_H
      const onScreen = screen.getAllDisplays().some((d) => {
        const a = d.workArea
        return b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 &&
               b.y < a.y + a.height - 40 && b.y + b.height > a.y
      })
      if (!tooSmall && onScreen) return
      const area = screen.getPrimaryDisplay().workArea
      MLOG(`[window] 窗口尺寸/位置异常 ${b.width}x${b.height} @ ${b.x},${b.y}${tag ? ` (${tag})` : ''} → 拉回主屏并最大化`)
      win.setBounds({
        x: area.x,
        y: area.y,
        width: Math.max(MIN_WINDOW_W, area.width),
        height: Math.max(MIN_WINDOW_H, area.height),
      })
      if (!win.isMaximized()) win.maximize()
    } catch { /* ignore */ }
  }

  /**
   * ⚠️ 2026-09-28 用户: "启动的时候, 启动页面的动画因为一开始有一个小一点的窗口, 所以会闪一点"。
   *
   * 原因: 窗口按 1560×960 创建, 等到 ready-to-show 才 maximize() —— 在 Windows 上 maximize 是
   *   异步的, 于是**会先看到一帧 1560×960 的小窗**、再跳成最大化, 启动动画正好在这一帧里,
   *   看起来就是"闪一下"。
   * 现在: 建窗时直接把 bounds 取成**主屏工作区**(等于最大化后的尺寸), 并且在 show 之前就
   *   调一次 maximize() —— 从第一帧起就是最大化尺寸, 不会再有小窗→大窗的跳变。
   */
  const workArea = (() => {
    try {
      const d = screen.getPrimaryDisplay()
      return d.workArea ?? { x: 0, y: 0, width: 1560, height: 960 }
    } catch { return { x: 0, y: 0, width: 1560, height: 960 } }
  })()
  win = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: Math.max(1180, workArea.width),
    height: Math.max(720, workArea.height),
    minWidth: MIN_WINDOW_W,
    minHeight: MIN_WINDOW_H,
    show: false,
    backgroundColor: '#000000',
    title: APP_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      webviewTag: true,        // 网页版侧边栏 (豆包/DeepSeek 内嵌 <webview>) 需要
      /**
       * ★ 2026-10-16 路线 A: 首次运行向导要用它 ——
       *   弹系统文件夹选择框 / 搬家并回报进度 / 记下"向导走完了"。
       *   只暴露这几个方法(见 preload.cjs), 沙箱与 contextIsolation 一个字都没放松。
       */
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })

  /**
   * 打开即**最大化**(2026-09-27 用户: "软件打开改成自动全屏", 随后澄清
   *   "我说的全屏要留上面的关闭这些按钮")。
   *
   * 所以这里用的是 `maximize()` 而**不是** `fullscreen: true`:
   *   · 最大化 = 铺满工作区, 顶部标题栏(最小化/最大化/**关闭**)照旧在;
   *   · 真全屏会把标题栏整个吃掉, 用户想关窗口只能按 Alt+F4 —— 不是他要的。
   * 想要真全屏时仍然有 F11 / 菜单「视图 → 全屏」。
   *
   * 先 maximize 再 show: 避免"先出现一个 1560×960 的小窗、再跳成最大化"的闪动。
   */
  win.once('ready-to-show', () => {
    try { if (!win.isMaximized()) win.maximize() } catch { /* ignore */ }
    win.show()
    ensureReachable('ready-to-show')
  })

  /**
   * 窗口状态兜底 + 现场留痕 (2026-10-06)。
   *   · show / restore: 每次"回到了桌面上"都核一遍尺寸与位置(见上面的 ensureReachable);
   *   · unresponsive / responsive: 渲染进程有没有反应也写进 app 日志 —— 以前这类事件只在
   *     开发态的 stdout 里, 用户发日志过来是空的, 只能靠猜。
   */
  win.on('show', () => ensureReachable('show'))
  win.on('restore', () => ensureReachable('restore'))
  win.on('unresponsive', () => MLOG('[window] 渲染进程无响应 —— 若长时间不恢复, 只能结束 Manke.exe 重新打开'))
  win.on('responsive', () => MLOG('[window] 渲染进程已恢复响应'))

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    MLOG(`[renderer] 加载失败 ${code} ${desc} — ${url}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    MLOG(`[renderer] 进程退出: ${details.reason} (exitCode=${details.exitCode})`)
  })
  if (VERBOSE) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      const tag = ['verbose', 'info', 'warn', 'error'][level] ?? String(level)
      console.log(`[renderer:${tag}] ${message}${sourceId ? ` (${sourceId}:${line})` : ''}`)
    })
  }

  const APP_ORIGIN = (() => { try { return new URL(url).origin } catch { return '' } })()
  const BACKEND_PREFIX = /^\/(comfy|kear|h3|indextts)(\/|$)/
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    try {
      const t = new URL(u, APP_ORIGIN || undefined)
      const selfPage = APP_ORIGIN !== '' && t.origin === APP_ORIGIN && !BACKEND_PREFIX.test(t.pathname)
      if (selfPage) return { action: 'allow' }
    } catch { /* 解析失败 → 走 deny 分支 */ }
    if (/^https?:/i.test(u)) shell.openExternal(u).catch(() => {})
    return { action: 'deny' }
  })

  /**
   * ★★ 2026-10-12 真机抓到的时序 bug(用户报"生成视频时突然回到项目页面, 项目也没了"):
   *
   *   "端口被顺延 → 回灌 localStorage 快照 → reload"那段以前是在**窗口创建之后**才
   *   `win.webContents.once('did-finish-load', …)` 注册的 —— 而 `createWindow` 里紧接着就
   *   `loadURL(url)` 了; 本地页面几百毫秒就加载完, 中间还隔着 `await applyLicenseGate()`,
   *   于是**这个回调常常根本不会触发** ⇒ 快照不灌、不 reload、日志里一行痕迹都没有。
   *   表现出来就是"有时项目在、有时项目没了"(恰好那台机器上端口被占了)。
   * 现在: 主流程把"这次是不是顺延过端口"先算好传进来, 在 **loadURL 之前**就把回调挂上,
   *   并在 reload 前把 `acs.portShift` 旗写进 sessionStorage(同 origin 的 reload 不丢)——
   *   前端起来后会明确告诉用户"端口换了、数据从备份与磁盘读回"。
   */
  if (portShift && fs.existsSync(LS_BACKUP)) {
    win.webContents.once('did-finish-load', async () => {
      const ok = await restoreLocalStorage(win)
      /**
       * ⚠️ 2026-10-16: `ok` 现在的含义是"**真的补进来了东西**"(= 这是一个空的新库), 不是"回灌成功"。
       *   源里本来就有数据时它会走"不碰"那条路, 此时**不该 reload**(reload 会把用户正在跑的界面刷掉),
       *   也不该跟用户说"数据从备份读回"(那句话会让人以为当前库被换过)。
       */
      MLOG(`[port] 端口 ${portShift.from} 被占用 → 本次改用 ${portShift.to}; `
        + (ok ? '已把备份补进新库' : '当前源里已有数据 → 不回灌不覆盖'))
      try {
        await win.webContents.executeJavaScript(
          `sessionStorage.setItem('acs.portShift', JSON.stringify({ from: ${Number(portShift.from)}, to: ${Number(portShift.to)}, restored: ${ok ? 'true' : 'false'} }))`,
          true,
        )
      } catch { /* ignore */ }
      if (ok) win.webContents.reload()
    })
  } else if (portShift) {
    MLOG(`[port] 端口 ${portShift.from} 被占用 → 本次改用 ${portShift.to}(没有可回灌的备份)`)
  }
  /**
   * ★ 首次运行 → 带上 `?first=1`(渲染进程据此走首启向导, 见 FirstRunWizard.tsx)。
   *   判据是"标记文件不存在", **不看命令行参数** —— 静默安装不会拉起程序,
   *   那种情况下用户之后双击快捷方式也要能进向导(见 FIRST_RUN_FLAG 的说明)。
   *
   * ★ 2026-11-01: 未激活时**直接以激活页作为首屏**（由 main() 算好传进来）——
   *   不要再"先加载首屏、再跳激活页"，那就是上面 navTo 里说的两路导航打架。
   */
  const firstRun = isFirstRun()
  const target = startUrl || (firstRun ? `${url}?first=1` : url)
  /**
   * 升级后必须丢掉旧前端缓存：否则主进程已经是新版，渲染层还在跑旧 bundle，
   * 就会出现「教程删了还显示、重新登录还走 already」的假象。
   *
   * `win.__aicsStartNav` = 这**一路**导航的落地信号：激活页/后续跳转必须等它，
   * 不许抢同一帧（抢了就会有一路被 abort，见 navTo 顶部的客户截图）。
   */
  win.__aicsStartNav = new Promise((resolve) => {
    void win.webContents.session.clearCache()
      .catch(() => { /* 缓存清不掉也要继续进 */ })
      .finally(() => {
        if (win.isDestroyed()) { resolve(false); return }
        setTimeout(() => {
          if (win.isDestroyed()) { resolve(false); return }
          navTo(win, target, { tries: firstRun ? 3 : 2, tag: '首屏' }).then(resolve)
        }, firstRun ? 300 : 0)
      })
  })
  return win
}


async function main() {
  /**
   * 正式发行先过运行时安全门禁，再启动本地服务：
   *   · bundle/** 逐文件核对完整性清单；
   *   · exe 必须由发布策略指定的 Authenticode 证书签名；
   *   · 拒绝 --inspect 等调试旁路。
   * 开发裸包(as ar:false)跳过，保持原有开发体验。
   */
  const security = runtimeGuard.enforceStartup({
    devMode: DEV_MODE,
    unpackedBuild: devUnpackedBuild(),
    appDir: __dirname,
    bundleRoot: path.join(process.resourcesPath, 'app.asar.unpacked', 'bundle'),
    exePath: process.execPath,
  })
  if (!security.ok) {
    console.error('[security] ' + security.reason)
    dialog.showErrorBox(
      `${APP_NAME} 安全检查未通过`,
      `${security.reason}\n\n为了数据安全，程序没有继续启动。\n请重新安装官方签名版本；不要使用来源不明的替换文件。`,
    )
    app.exit(3)
    return
  }
  if (security.skipped) console.log('[security] 开发布局 → 跳过正式发行安全门禁')
  else console.log('[security] 代码完整性 / 发布签名校验通过')

  buildMenu()

  if (!fs.existsSync(SERVER_ENTRY) || !fs.existsSync(DIST_DIR)) {
    dialog.showErrorBox(
      `${APP_NAME} 安装不完整`,
      `缺少程序资源:\n  ${SERVER_ENTRY}\n  ${DIST_DIR}\n\n请重新解压完整的发行包 (不要只拷贝 exe)。`,
    )
    app.quit()
    return
  }

  let handle
  try {
    handle = await bootServer()
  } catch (e) {
    /**
     * 到这一步说明"所有候选端口都不可用"—— 极少见, 但必须让用户/售后一眼看懂:
     *   ① 到底试了哪几个端口(以前只给一句 EACCES, 完全不知道顺延过没有);
     *   ② permission denied(EACCES) 是"被 Windows 保留"而不是"被程序占用", 重启电脑通常能恢复;
     *   ③ 日志在哪。
     */
    const tried = bootTriedPorts.length ? bootTriedPorts.join(', ') : '(没有可用候选)'
    const hint = (e && e.code === 'EACCES')
      ? '\n\n提示: permission denied 说明该端口被 Windows 保留(常见于装了 Hyper-V / WSL / Docker 之后),\n重启电脑通常能恢复。'
      : ''
    dialog.showErrorBox(
      `${APP_NAME} 启动失败`,
      `本地服务无法启动:\n${e && e.message ? e.message : e}\n\n已尝试的端口: ${tried}${hint}\n\n详细日志: ${path.join(DATA_DIR, 'logs')}`,
    )
    app.quit()
    return
  }
  serverHandle = handle
  appUrl = handle.url

  /**
   * 端口被顺延过吗 —— **必须在 createWindow 之前算**(见 createWindow 里的时序说明:
   *   回灌回调要赶在 loadURL 之前注册, 否则经常根本不触发)。
   */
  const preferredPort = bootPreferredPort || portCandidates()[0]
  const portShift = handle.port !== preferredPort ? { from: preferredPort, to: handle.port } : null
  if (portShift) {
    MLOG(`[port] 端口 ${preferredPort} 被占用 → 本次改用 ${handle.port}(见 data\\localStorage-backup.json 的说明)`)
  }
  /**
   * ★ 2026-11-01: **先判授权、再决定首屏**，别"先开首页再跳激活页"。
   *   跳来跳去会有两路导航抢同一帧，先发起的那一路被 abort（客户截图那次就是这么挂的，
   *   见 navTo 顶部的说明）。授权判定本来就要跑一次（指纹要 PowerShell），这里算了往下传，
   *   applyLicenseGate 不再算第二遍。
   */
  const gate = runLicenseGate()
  const needActivate = !gate.licensed && licenseRequired()
  const firstRun = isFirstRun()
  const startUrl = needActivate
    ? `${handle.url}/activate`
    : (firstRun ? `${handle.url}?first=1` : handle.url)
  if (needActivate) MLOG('[license] 未激活 → 首屏直接进激活页（不再先开首页）')
  createWindow(handle.url, portShift, startUrl)
  /** 原生调试器检测：5 秒后首查，之后每 30 秒复查。只有明确检测到才退出。 */
  stopDebuggerGuard = runtimeGuard.startDebuggerGuard({
    bundleRoot: DEV_MODE ? '' : path.join(process.resourcesPath, 'app.asar.unpacked', 'bundle'),
    manifestPath: DEV_MODE ? '' : path.join(__dirname, runtimeGuard.MANIFEST_FILE),
    onDetected: (why) => {
      console.error('[security] ' + why)
      try { dialog.showErrorBox(`${APP_NAME} 已停止运行`, `${why}。\n请重新启动；若反复出现，请重新安装或联系售后。`) } catch { /* ignore */ }
      app.exit(4)
    },
  })

  /* ============================================================
     首次运行向导的三个通道 (2026-10-16 · 路线 A)

     都在主进程做, 因为界面里做不到(见 preload.cjs 顶部):
       · pick-dir        —— 弹系统文件夹选择框(浏览器拿不到路径字符串);
       · move-to         —— 把程序目录整个复制过去, 并一路报进度;
       · first-run-done  —— 记下"向导走完了", 之后不再进向导。
     ============================================================ */
  /** 向导第二屏要显示"程序现在装在哪" —— 只有主进程知道真实路径 */
  ipcMain.handle('aics:app-dir', async () => {
    try {
      return EXE_DIR
    } catch { return '' }
  })

  /**
   * 122 P0-1：渲染层问授权状态时，直接走主进程里这份 license-core 判定。
   * 明文 bundle 里的 `/api/license` 只作为浏览器/测试台的回退，不再给打包态当权威。
   */
  ipcMain.handle('aics:license-status', async () => {
    const st = runLicenseGate()
    return { ok: true, requireLicense: licenseRequired(), ...st }
  })

  /**
   * H3 云端算力：打开 AutoDL.Art 登录窗口。
   * 只保存网站登录 token 到 data/autodl-web-token.json，供本地服务代传参考图；
   * 推理 token 仍由用户在 API 面板填写，二者不混。
   */
  ipcMain.handle('aics:autodl-login', async (_event, opts = {}) => {
    const tokenFile = path.join(DATA_DIR, 'autodl-web-token.json')
    const force = opts && opts.force === true
    if (!force) {
      try {
        const old = JSON.parse(fs.readFileSync(tokenFile, 'utf-8'))
        if (String(old?.token || '').length > 20) return { ok: true, already: true }
      } catch { /* 未登录 */ }
    } else {
      /** 「重新登录」必须真的重新扫码：先清旧 token 和旧站点登录态，不能直接返回 already。 */
      try { fs.rmSync(tokenFile, { force: true }) } catch { /* ignore */ }
      try { await session.fromPartition('persist:aics-autodl').clearStorageData() } catch { /* ignore */ }
    }

    const w = new BrowserWindow({
      width: 1080, height: 820, parent: win ?? undefined, modal: false,
      backgroundColor: '#101014', title: `${APP_NAME} · 登录 H3 云端算力`,
      autoHideMenuBar: true,
      webPreferences: {
        partition: 'persist:aics-autodl',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    let done = false
    let resolve
    let timer = null
    const finish = (payload) => {
      if (done) return
      done = true
      if (timer) clearInterval(timer)
      try { if (!w.isDestroyed()) w.close() } catch { /* ignore */ }
      resolve(payload)
    }
    const result = new Promise((r) => { resolve = r })
    w.once('closed', () => finish({ ok: false, canceled: true }))
    w.webContents.on('did-finish-load', () => {
      void w.webContents.executeJavaScript(`(() => {
        const els = [...document.querySelectorAll('span,button,a')];
        const hit = els.find((e) => (e.textContent || '').trim() === '登录');
        if (hit) hit.click();
        return true;
      })()`).catch(() => {})
    })
    w.loadURL('https://autodl.art/app/market').catch(() => {})
    timer = setInterval(async () => {
      if (done || w.isDestroyed()) return
      try {
        const token = await w.webContents.executeJavaScript('localStorage.getItem("token") || ""')
        if (String(token || '').length > 20) {
          fs.mkdirSync(DATA_DIR, { recursive: true })
          fs.writeFileSync(tokenFile, JSON.stringify({ token, at: Date.now() }), 'utf-8')
          finish({ ok: true })
        }
      } catch { /* 页面跳转中 */ }
    }, 1200)
    return result
  })

  ipcMain.handle('aics:autodl-status', async () => {
    const tokenFile = path.join(DATA_DIR, 'autodl-web-token.json')
    let token = ''
    let at = 0
    try {
      const j = JSON.parse(fs.readFileSync(tokenFile, 'utf-8'))
      token = String(j?.token || '').trim()
      at = Number(j?.at) || 0
    } catch { return { ok: true, loggedIn: false, at: 0 } }
    if (token.length <= 20) return { ok: true, loggedIn: false, at }
    try {
      /**
       * 不能只看文件里有没有 token —— 过期后它还在，界面却一直亮绿灯。
       * before_upload 是 AutoDL 网站登录态的轻量鉴权接口；只发一个空文件的
       * md5/大小，不会真的上传文件，鉴权失败会回 401 / AuthorizeFailed。
       */
      const r = await fetch('https://autodl.art/api/v1/file/before_upload', {
        method: 'POST',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ md5: 'd41d8cd98f00b204e9800998ecf8427e', file_size: 1 }),
        signal: AbortSignal.timeout(8000),
      })
      const j = await r.json().catch(() => null)
      const loggedIn = r.ok && j?.code === 'Success'
      if (!loggedIn) {
        /** 失效 token 直接删掉：否则「重新登录」又会被 already 逻辑挡住。 */
        try { fs.rmSync(tokenFile, { force: true }) } catch { /* ignore */ }
        return { ok: true, loggedIn: false, at, reason: String(j?.msg || j?.code || `HTTP ${r.status}`).slice(0, 120) }
      }
      return { ok: true, loggedIn: true, at }
    } catch (e) {
      return { ok: true, loggedIn: false, at, reason: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('aics:pick-dir', async () => {
    try {
      const r = await dialog.showOpenDialog(win, {
        title: '选择安装位置',
        defaultPath: EXE_DIR,
        buttonLabel: '装到这里',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (r.canceled || !r.filePaths || !r.filePaths.length) return null
      return r.filePaths[0]
    } catch { return null }
  })

  /**
   * 模型包目录专用选择框 (2026-10-25)
   *
   * 为什么不让本地服务再起 PowerShell: 旧链路是 renderer → server → PowerShell
   * FolderBrowserDialog → UTF-8 临时文件。打包环境里任何一环出问题都只会得到空结果，
   * 用户看到的就是“点了找位置，找不到位置”。Electron 原生 dialog 直接返回真实路径，
   * 不存在编码转换，也不会因为服务端同步等对话框而卡住状态轮询。
   */
  ipcMain.handle('aics:pick-models-dir', async (_e, startDir) => {
    try {
      const wanted = String(startDir || '').trim()
      let defaultPath = EXE_DIR
      try {
        if (wanted && fs.existsSync(wanted) && fs.statSync(wanted).isDirectory()) defaultPath = wanted
      } catch { /* 无效起始目录就退回程序目录 */ }
      const r = await dialog.showOpenDialog(win, {
        title: '选择模型包文件夹或已解压的模型目录',
        defaultPath,
        buttonLabel: '选择此文件夹',
        properties: ['openDirectory'],
      })
      if (r.canceled || !r.filePaths || !r.filePaths.length) return { canceled: true, dir: '' }
      return { canceled: false, dir: r.filePaths[0] }
    } catch (e) {
      return { canceled: false, dir: '', msg: `文件夹选择框打开失败：${String((e && e.message) || e)}` }
    }
  })

  /**
   * 画布「批量下载」：只弹一次文件夹选择框，之后全部文件直接写入该目录。
   *
   * 以前前端对每张卡调一次 `<a download>`，Chromium 会为每个文件弹一次保存框，
   * 组里十几张卡就要连点十几次。现在由主进程流式写盘，重名自动加序号，
   * 单个失败只记结果、不打断整批。
   */
  let lastBatchDownloadDir = ''
  ipcMain.handle('aics:batch-download', async (_e, payload) => {
    try {
      const items = Array.isArray(payload?.items)
        ? payload.items
          .map((it) => ({ src: String(it?.src || ''), name: String(it?.name || 'canvas-media') }))
          .filter((it) => it.src)
        : []
      if (!items.length) return { ok: false, canceled: false, msg: '没有可下载的产物' }
      let defaultPath = lastBatchDownloadDir
      if (!defaultPath || !fs.existsSync(defaultPath)) {
        try { defaultPath = app.getPath('downloads') } catch { defaultPath = EXE_DIR }
      }
      const r = await dialog.showOpenDialog(win, {
        title: `批量下载 ${items.length} 个产物`,
        defaultPath,
        buttonLabel: '下载到这个文件夹',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (r.canceled || !r.filePaths?.length) {
        return { ok: false, canceled: true, msg: '已取消批量下载' }
      }
      const dir = r.filePaths[0]
      lastBatchDownloadDir = dir
      const result = await saveBatchToDir(dir, items)
      MLOG(`[download] 批量下载 ${result.saved}/${result.total} → ${dir}${result.failed ? `，失败 ${result.failed}` : ''}`)
      return { ...result, canceled: false }
    } catch (e) {
      return { ok: false, canceled: false, msg: `批量下载失败：${String((e && e.message) || e)}` }
    }
  })

  ipcMain.handle('aics:move-to', async (_e, dest) => {
    try {
      const d = String(dest || '').trim()
      if (!d) return { ok: false, msg: '没有选择位置' }
      const from = path.resolve(EXE_DIR)
      const to = path.resolve(d)

      /**
       * ⚠️ 三条安全检查 —— 这是"复制一整个程序目录"的操作, 判错一次就是灾难:
       *   ① 不许搬到原地(白忙);
       *   ② 不许搬到程序目录**里面**(会把自己套进自己, 复制时越滚越大);
       *   ③ 目标目录里如果**已经有别的东西**就拒绝 —— 宁可让用户换一个空目录,
       *      也不能覆盖别人的文件。("别的东西"里排除了同名目录本身, 允许重试续做。)
       */
      if (to === from) return { ok: false, msg: '已经是当前位置了' }
      if (to.startsWith(from + path.sep)) return { ok: false, msg: '不能搬到程序目录里面去' }
      if (fs.existsSync(to)) {
        const leftover = fs.readdirSync(to).filter((n) => n !== path.basename(from))
        if (leftover.length) return { ok: false, msg: '这个目录里已经有别的文件了，请换一个空目录' }
      }
      fs.mkdirSync(to, { recursive: true })
      const stat = await copyDirWithProgress(win, from, to)
      return { ok: true, dest: to, ...stat }
    } catch (e) {
      return { ok: false, msg: String((e && e.message) || e) }
    }
  })

  ipcMain.handle('aics:first-run-done', () => {
    try {
      fs.writeFileSync(FIRST_RUN_FLAG, new Date().toISOString(), 'utf-8')
      return { ok: true }
    } catch (e) { return { ok: false, msg: String((e && e.message) || e) } }
  })
  ipcMain.handle('aics:password-activate', (_e, pw) => {
    if (String(pw) !== 'mankeaigc') return { ok: false, msg: '密码错误' }
    try { fs.writeFileSync(path.join(DATA_DIR, 'password-ok'), '1'); return { ok: true } } catch (e) { return { ok: false, msg: String((e && e.message) || e) } }
  })

  ipcMain.handle('aics:open-models-dir', async () => {
    try {
      const dir = path.join(EXE_DIR, 'backends')
      fs.mkdirSync(dir, { recursive: true })
      await shell.openPath(dir)
      return { ok: true, dir }
    } catch (e) { return { ok: false, msg: String((e && e.message) || e) } }
  })
  /**
   * 兜底再把窗口捞一次 (2026-09-20): 万一 ready-to-show 因为渲染/显卡原因没触发,
   *   窗口就永远不会显示, 而单实例锁又让"再点一次图标"变成无操作 —— 用户只会说"打不开"。
   *   3 秒后如果还不可见, 直接 show 一次(幂等, 正常情况下什么都不做)。
   */
  setTimeout(() => { try { if (win && !win.isVisible()) win.show() } catch { /* ignore */ } }, 3000)
  await applyLicenseGate({ gate, atActivate: needActivate })
  /**
   * 首屏重试完还是没加载出来 → 中文兜底（别让用户对着一个白窗口，也别说"启动异常"）。
   * 未激活那条路已经在 applyLicenseGate 里兜过底了，这里只管"该进主界面却没进"的情况。
   */
  if (!needActivate) {
    const okStart = win.__aicsStartNav ? await win.__aicsStartNav.catch(() => false) : true
    if (!okStart && win && !win.isDestroyed() && !win.isVisible()) {
      MLOG('[load] 首屏没加载出来 → 弹中文兜底（先把窗口显示出来再问用户）')
      try { win.show() } catch { /* ignore */ }
      loadFailFallback(win, startUrl, '首屏加载失败')
    }
  }
  /** ⚠️ 启动这一次**静默**: 只填 modelsInfo + 记日志, 不弹原生框(见 checkModels 的说明) */
  setTimeout(() => { checkModels({ silent: true }).catch(() => {}) }, 1500)

  if (DATA_FALLBACK) {
    dialog.showMessageBox(win, {
      type: 'info',
      title: `${APP_NAME} 提示`,
      message: '程序目录不可写, 数据已改存到系统用户目录',
      detail: `数据目录: ${DATA_DIR}\n\n如需便携使用, 请把整个程序文件夹放到有写入权限的位置 (例如 D:\\ 下)。`,
      buttons: ['知道了'],
    }).catch(() => {})
  }

  /** 端口顺延的处理已经在 createWindow 里注册好了(要在 loadURL 之前, 见那里的说明) */

  setInterval(() => dumpLocalStorage(win), 60_000)

  app.on('window-all-closed', async () => {
    await dumpLocalStorage(win)
    app.quit()
  })

  let quitting = false
  app.on('before-quit', (e) => {
    if (stopDebuggerGuard) { stopDebuggerGuard(); stopDebuggerGuard = null }
    if (quitting) return
    quitting = true
    e.preventDefault() // 先拦住退出, 等后端清理完再走
    const base = (serverHandle && serverHandle.url) || appUrl
    const finish = () => {
      try { serverHandle?.server?.close() } catch { /* ignore */ }
      app.exit(0)
    }
    if (!base) return finish()
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 6000) // 服务没响应也不能卡住用户
    fetch(`${base}/api/backends/shutdown`, { method: 'POST', signal: ctl.signal })
      .catch(() => { /* 服务已挂: 直接退, 残留由下次启动自愈 */ })
      .finally(() => { clearTimeout(timer); finish() })
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      /**
       * 用户双击图标 = "我要看到那个窗口" (2026-09-20 真实故障排查):
       *   以前只 restore + focus —— 窗口若是**隐藏**状态(比如被别的启动方式藏起来、
       *   或系统把它丢到了屏幕外), 双击图标就"什么也没发生", 用户以为程序打不开,
       *   而单实例锁又让第二次启动直接退出。现在无条件 show + focus + moveTop,
       *   保证一定能把它捞回前台。
       */
      try { if (win.isMinimized()) win.restore() } catch { /* ignore */ }
      try { win.show() } catch { /* ignore */ }
      try { win.focus() } catch { /* ignore */ }
      try { win.moveTop() } catch { /* ignore */ }
    }
  })
  /**
   * 启动阶段的兜底。
   *
   * ★ 2026-11-01: 以前这里直接把 `e.stack` 甩进 showErrorBox —— 客户截图那张英文堆栈框
   *   （`Error: ERR_ABORTED (-3) loading … at rejectAndCleanup …`）就是它，用户以为程序坏了。
   *   现在分两类：
   *     · 导航类（ERR_ABORTED / ERR_FAILED / ERR_CONNECTION…）：说明**服务是起来的、界面没打开**，
   *       窗口还在就交给中文兜底（重新加载 / 重启），不退出；
   *     · 其它（真正的启动失败）：弹**中文**一句话 + 日志路径，堆栈只写日志，不给用户看。
   */
  app.whenReady().then(main).catch((e) => {
    const msg = String((e && e.message) || e)
    const stack = String((e && e.stack) || msg)
    try { console.error('[boot] 启动异常:\n' + stack) } catch { /* ignore */ }
    try { MLOG_EARLY(`[boot] 启动异常: ${stack.replace(/\n/g, ' | ').slice(0, 1200)}`) } catch { /* ignore */ }
    if (/ERR_ABORTED|ERR_FAILED|ERR_CONNECTION|ERR_EMPTY_RESPONSE|loadURL|Navigation/i.test(msg)
      && win && !win.isDestroyed()) {
      loadFailFallback(win, appUrl || '', msg)
      return
    }
    try {
      dialog.showErrorBox(
        `${APP_NAME} 启动异常`,
        `程序没能启动完成：${msg.slice(0, 400)}\n\n详细日志: ${path.join(DATA_DIR, 'logs')}\n若反复出现，请把日志发给售后。`,
      )
    } catch { /* ignore */ }
    app.quit()
  })
}
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          