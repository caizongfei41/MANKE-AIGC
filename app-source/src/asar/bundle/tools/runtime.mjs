// ============================================================
// Manke 运行期路径解析 — 开发 / 打包 双模式单一事实来源
//
// 解决的问题: server.mjs 原来把所有路径都写成 "相对 server.mjs 所在目录",
//   这在源码目录里跑没问题, 但打包成 exe 后:
//     - 程序本体进了只读的 app.asar, 不能往里写 data / profiles;
//     - 模型 (backends/, 上百 GB) 不进安装包, 必须允许用户另行指定位置。
//
// 于是把"到哪里读写"这件事集中到这里, 由调用方注入 appRoot / dataDir,
// 其余派生路径 (api-store / profiles / 三个后端根 / output 目录) 全部自动推导。
//
// 目录约定 (打包后):
//   <exeDir>/                      appRoot  — exe、启动-*.bat、backends/ 都在这一层
//     MankeLegacy.exe
//     data/                        dataDir  — 全部可写数据, 拷走即搬迁
//       profile/                   Chromium profile (localStorage: 项目/画布/历史)
//       profiles/<doubao|deepseek> 网页版登录态
//       api-store.json             Provider / API Key
//       settings.json              用户可改的配置 (backendsRoot 等)
//     backends/                    模型后端 (引导用户放置 / 或指向别处)
//
// 开发态 (node server.mjs) 默认 appRoot = 源码根、dataDir = 源码根/data,
// 但仍向后兼容读取根目录的 app/.api-store.json 与 app/.env。
// ============================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODEL_COMPONENTS, readManifest, modelStatus, tiersStatus, MODEL_API_VERSION, resolveComponentDir } from './models.mjs'

/** tools/ 目录 (本文件所在处) */
export const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url))
/** 源码根 = tools/ 的上一级 (即 server.mjs 所在目录) */
export const SRC_ROOT = path.resolve(TOOLS_DIR, '..')

/** 打包后的默认应用名, 用于 %APPDATA% 回退目录 (正式版改名: MankeLegacy → Manke) */
export const APP_DIR_NAME = 'Manke'
/** 改名前的回退目录名: 老安装的数据若在这里, 继续沿用 (见 resolvePaths) */
export const APP_DIR_NAME_LEGACY = 'MankeLegacy'

/**
 * 程序自身的版本信息 (version.json)。
 *
 * 位置约定: 源码态 = 仓库根; 打包态 = bundle/version.json (stage 会复制进去)。
 * 两处相对本文件的路径都是 `../version.json`, 所以一份代码同时吃两种情况。
 * 读不到时返回"未知", 绝不因为缺个文件就让程序起不来。
 */
export function readVersionInfo() {
  const fallback = {
    product: 'Manke',
    channel: 'unknown',
    program: { version: '0.0.0', build: 0, builtAt: '', gitCommit: '' },
    models: { packVersion: '', apiVersion: MODEL_API_VERSION, minProgramVersion: '' },
  }
  for (const f of [path.join(SRC_ROOT, 'version.json'), path.join(SRC_ROOT, 'bundle', 'version.json')]) {
    try {
      if (!fs.existsSync(f)) continue
      const j = JSON.parse(fs.readFileSync(f, 'utf-8'))
      if (!j || typeof j !== 'object') continue
      return { ...fallback, ...j, program: { ...fallback.program, ...(j.program || {}) }, models: { ...fallback.models, ...(j.models || {}) } }
    } catch { /* 下一个候选 */ }
  }
  return fallback
}

// ---------------------------------------------------------------- 目录可写性

/** 探测目录能否创建并写入 (用来决定 data/ 放 exe 旁边还是退回 %APPDATA%) */
export function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.write-probe-${process.pid}`)
    fs.writeFileSync(probe, '1', 'utf-8')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/** 用户配置 (data/settings.json) 的默认值 */
export const DEFAULT_SETTINGS = {
  /** 模型后端根目录; 留空 = <appRoot>/backends */
  backendsRoot: '',
  /** 服务端口 */
  port: 5173,
  /**
   * 按组件开关后端 (默认全开)。
   * 用途: 低配机器 / 只想用语音的机器, 可以关掉视频后端, 避免它跟着启动、占内存显存。
   * 与"是否安装"是两件事: 没装也属于关。
   */
  backendsEnabled: { h3: true, kear: true, indextts: true },
  /**
   * 按需启动后端 (默认开)。
   *   true  = 打开程序不预热, 谁被用到谁起来 (笔记本/弱机的默认, 省内存显存与首启时间)
   *   false = 打开程序就把三个后端全拉起来 (专用工作站/连续出片场景更顺手)
   */
  lazyBackends: true,
  /**
   * 手动启动 (默认开, 用户要求)。
   *   true  = 程序不自动拉起任何后端: 生成前也不自动启, 必须自己点「启动」。
   *   false = 生成时按需自动拉起 (用哪个起哪个)。
   */
  manualStart: true,
}

/**
 * 模型目录的"零成本"检查 —— 只判断关键文件在不在, 不递归扫描目录。
 *
 * 为什么单独留一个: 完整的模型体检要遍历上百 GB 的目录树, 只能按需触发
 *   (设置面板 / 诊断导出); 而程序启动、每次 /api/status 轮询都必须瞬间返回。
 *   分层的结果: 启动路径只回答"在不在", 用户点"体检"时才回答"多大、全不全"。
 */
export function quickModelCheck(backendsRoot) {
  const components = MODEL_COMPONENTS.map((c) => {
    /**
     * ⚠️ 2026-10-12: 这里以前直接用 `<backendsRoot>/<rel>` 两个 marker 一判了事 ——
     *   与 componentStatus(完整版) 是**两份实现**, 而且没有长路径处理、也不认"装歪"的形态。
     *   现在统一走 `resolveComponentDir`(标准位置 → 有界深搜), 两份口径一致。
     */
    const found = resolveComponentDir(backendsRoot, c)
    const dir = found.dir ?? path.join(backendsRoot, ...c.rel.split('/'))
    const missing = c.markers.filter((m) => !fs.existsSync(path.join(dir, ...m.split('/'))))
    return {
      key: c.key,
      label: c.label,
      tier: c.tier,
      path: dir,
      layout: found.kind,
      present: fs.existsSync(dir),
      installed: found.kind !== 'missing' && fs.existsSync(dir) && missing.length === 0,
      missingMarkers: missing,
    }
  })
  const installedCount = components.filter((c) => c.installed).length
  const tiers = tiersStatus(components)
  const manifest = readManifest(backendsRoot)
  let compat
  if (!manifest) {
    compat = installedCount > 0
      ? { ok: true, level: 'unknown', reason: `已装 ${installedCount}/${components.length} 个组件 (未登记版本, 可用)` }
      : { ok: false, level: 'missing', reason: '未找到模型包' }
  } else if (Number(manifest.apiVersion) !== MODEL_API_VERSION) {
    compat = {
      ok: false,
      level: 'mismatch',
      reason: `模型包契约号 ${manifest.apiVersion} 与本程序要求的 ${MODEL_API_VERSION} 不一致`,
    }
  } else if (installedCount < components.length) {
    // 分层安装是正常状态: 只装语音/生图不算错, 只是视频功能不可用
    compat = {
      ok: true,
      level: 'partial',
      reason: `已安装 ${installedCount}/${components.length} 个组件 (未装: ${components.filter((c) => !c.installed).map((c) => c.label).join('、') || '无'})`,
    }
  } else {
    compat = { ok: true, level: 'ok', reason: `模型包 v${manifest.packVersion}` }
  }
  return {
    root: backendsRoot,
    hasManifest: !!manifest,
    packVersion: manifest?.packVersion ?? '',
    apiVersion: manifest?.apiVersion ?? null,
    tier: manifest?.tier ?? '',
    /**
     * 清单原件(含每层 bytes/tier) —— 2026-09-28 加: "卸载模型"要显示"能释放多少空间",
     *   体积只从清单里读, **不遍历目录**(那是 modelsStatus 的 detail 路径, 上百 GB 要几十秒)。
     *   manifest 是装机时写好的小 json, 读它是零成本。
     */
    manifest,
    supportedApiVersion: MODEL_API_VERSION,
    components,
    tiers,
    installedCount,
    allInstalled: installedCount === components.length,
    compat,
  }
}

/** 读取 data/settings.json (不存在/损坏都退回默认值) */
export function readSettings(dataDir) {
  try {
    const f = path.join(dataDir, 'settings.json')
    if (!fs.existsSync(f)) return { ...DEFAULT_SETTINGS }
    const j = JSON.parse(fs.readFileSync(f, 'utf-8'))
    const merged = { ...DEFAULT_SETTINGS, ...(j && typeof j === 'object' ? j : {}) }
    // 嵌套对象单独合并: 否则用户只写了一个组件开关, 其余组件的默认值会被整块顶掉
    merged.backendsEnabled = {
      ...DEFAULT_SETTINGS.backendsEnabled,
      ...(j && typeof j.backendsEnabled === 'object' && j.backendsEnabled ? j.backendsEnabled : {}),
    }
    return merged
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * 读程序目录下的 MODELS-DIR.txt (一行绝对路径)。
 *
 * 为什么需要它: 批处理启动器 (start-*.bat) 读不了 JSON, 只能读一行文本;
 *   而程序读的是 settings.json。两个入口若各认各的, 就会出现"启动器找得到模型、
 *   程序找不到"的怪事。所以这里也认这个文件, 顺序: 显式注入 > settings.json > MODELS-DIR.txt
 */
export function readModelsDirFile(appRoot) {
  try {
    const f = path.join(appRoot, 'MODELS-DIR.txt')
    if (!fs.existsSync(f)) return ''
    const first = fs.readFileSync(f, 'utf-8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || ''
    return first.replace(/^"|"$/g, '').replace(/[\\/]+$/, '')
  } catch {
    return ''
  }
}

/** 写回 data/settings.json (原子写) */
export function writeSettings(dataDir, patch) {
  const next = { ...readSettings(dataDir), ...patch }
  const f = path.join(dataDir, 'settings.json')
  fs.mkdirSync(dataDir, { recursive: true })
  const tmp = `${f}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
  fs.renameSync(tmp, f)
  return next
}

// ---------------------------------------------------------------- 主解析

/**
 * 解析全部运行期路径。
 *
 * @param {object} [opts]
 * @param {string} [opts.appRoot]       程序根 (exe 所在目录 / 源码根)。默认 SRC_ROOT
 * @param {string} [opts.dataDir]       可写数据根。默认 <appRoot>/data, 不可写则退回 %APPDATA%
 * @param {string} [opts.distDir]       前端产物目录。默认 SRC_ROOT/app/dist (打包时由主进程注入)
 * @param {string} [opts.backendsRoot]  模型后端根。默认 settings.backendsRoot → <appRoot>/backends
 * @param {number} [opts.port]          监听端口
 * @param {boolean} [opts.packaged]     是否运行在打包形态 (影响 .env 查找位置)
 */
export function resolvePaths(opts = {}) {
  const appRoot = path.resolve(opts.appRoot ?? SRC_ROOT)
  const packaged = opts.packaged === true

  // 1) 数据根: 优先显式注入 → 其次 exe 同目录 data/ → 最后 %APPDATA%
  let dataDir = opts.dataDir ? path.resolve(opts.dataDir) : path.join(appRoot, 'data')
  let dataFallback = false
  if (!opts.dataDir && !isWritable(dataDir)) {
    const appData = process.env.APPDATA || os.homedir()
    const next = path.join(appData, APP_DIR_NAME)
    const legacy = path.join(appData, APP_DIR_NAME_LEGACY)
    // 改名 (MankeLegacy → Manke) 之前的老安装, 若数据在旧目录里, 继续用它 ——
    // 否则升级后用户会看到"项目/授权都不见了"
    dataDir = !fs.existsSync(next) && fs.existsSync(legacy) ? legacy : next
    dataFallback = true
    isWritable(dataDir)
  }
  if (opts.dataDir) fs.mkdirSync(dataDir, { recursive: true })

  const settings = readSettings(dataDir)

  // 2) 模型后端根: 显式注入 > settings.json > MODELS-DIR.txt > <appRoot>/backends
  const modelsDirFile = readModelsDirFile(appRoot)
  const backendsRoot = path.resolve(
    opts.backendsRoot || settings.backendsRoot || modelsDirFile || path.join(appRoot, 'backends'),
  )

  // 3) 前端产物: 打包时由主进程指向 asar 内 dist; 开发态 = app/dist
  const distDir = path.resolve(opts.distDir ?? path.join(SRC_ROOT, 'app', 'dist'))

  // 4) 配置存储: 统一落在 data/, 但兼容旧位置 (根目录 app/.api-store.json)
  const legacyStore = path.join(SRC_ROOT, 'app', '.api-store.json')
  const apiStoreFile = path.join(dataDir, 'api-store.json')
  if (!packaged && !fs.existsSync(apiStoreFile) && fs.existsSync(legacyStore)) {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.copyFileSync(legacyStore, apiStoreFile)
    } catch { /* 迁移失败则忽略, 走新建 */ }
  }

  // 5) .env (仅开发态 / 兼容): 打包后不再从源码目录读, 放 data/ 便于用户手改
  const envCandidates = [
    path.join(dataDir, '.env'),
    path.join(SRC_ROOT, 'app', '.env'),
    path.join(appRoot, 'app', '.env'),
  ]

  // 6) 三个模型后端的根目录与输出目录 (由 backendsRoot 派生)
/**
 * ⚠️ 2026-10-12: 这四个根**先按标准布局算, 找不到再认"装歪"的形态**(见 models.mjs 的 resolveComponentDir)。
 *   为什么必须在这里做: 启动/输出目录/健康检查全都从这几个根派生 —— 只在"检测"那一层宽容,
 *   用户还是会卡在"界面说装了、一点启动就说没装"。
 */
const rootOf = (key, fallbackRel) => {
  const comp = MODEL_COMPONENTS.find((c) => c.key === key)
  const expected = path.join(backendsRoot, ...(fallbackRel ?? comp?.rel ?? '').split('/'))
  if (!comp) return expected
  const found = resolveComponentDir(backendsRoot, comp)
  return found.dir ?? expected
}
const h3Root = rootOf('h3')
const kearRoot = rootOf('kear')
const indexttsRoot = rootOf('indextts')
/**
 * 第 4 路 (2026-09-24 方案 A): Qwen-Image-2.1 生图后端。
 * 与前三路不同的两点: ① 它是"ComfyUI 当根目录"的布局(main.py 在根, 不在 ComfyUI/ 下);
 * ② 它用 conda 风格的 env\python.exe, 不是 python_embeded\python.exe。
 */
const qwenRoot = rootOf('qwen')
/**
 * 第 5 路 (2026-09-25): 本地小文本模型(提示词优化用)。
 *   组件目录只放模型权重(models/<模型名>/), 运行环境借 H3 自带的 python_embeded ——
 *   所以它**不需要**单独的 python, 也不会因为缺组件而挡住其它后端。
 */
const textRoot = path.join(backendsRoot, 'text')

  return {
    appRoot,
    dataDir,
    dataFallback,
    packaged,
    port: Number(opts.port ?? process.env.AICS_PORT ?? settings.port ?? 5173),
    settings,
    /** MODELS-DIR.txt 的内容 (批处理启动器认的那个; 空串=没写) */
    modelsDirFile,

    distDir,
    apiStoreFile,
    envCandidates,
    /** 网页版 (豆包/DeepSeek) 独立浏览器窗口的 profile 根 */
    webappProfileRoot: path.join(dataDir, 'profiles'),
    /** Electron 的 Chromium profile (localStorage 落这里) */
    chromiumProfileDir: path.join(dataDir, 'profile'),

    backendsRoot,
  h3Root,
  kearRoot,
  indexttsRoot,
  qwenRoot,
  textRoot,
    /** 模型包: 启动时只做零成本判断; 完整体检用 modelsStatus() 按需触发 */
    modelsRoot: backendsRoot,
    modelsQuick: () => quickModelCheck(backendsRoot),
    modelsStatus: (o = {}) => modelStatus(backendsRoot, { quick: true, ...o }),
    /** 程序版本信息 (version.json 由 stage 复制进包; 开发态读仓库根) */
    versionInfo: readVersionInfo(),
  outputDirs: {
    h3: path.join(h3Root, 'ComfyUI', 'output'),
    kear: path.join(kearRoot, 'ComfyUI', 'output'),
    indextts: path.join(indexttsRoot, 'output'),
    qwen: path.join(qwenRoot, 'output'),
    text: path.join(textRoot, 'output'),
  },
    /** 三个后端的启动脚本 (appRoot 下载着, 作为"没有 exe 引导时"的兜底) */
    batDir: appRoot,
  }
}

/** 从候选路径里找第一个存在的 .env, 返回其内容; 都没有则空串 */
export function readEnvFile(candidates) {
  for (const f of candidates) {
    try {
      if (f && fs.existsSync(f)) return fs.readFileSync(f, 'utf-8')
    } catch { /* 忽略不可读的候选 */ }
  }
  return ''
}
                         