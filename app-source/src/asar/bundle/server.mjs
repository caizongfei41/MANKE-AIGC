// ============================================================
// 漫客 — 独立本地服务 (零第三方依赖)
//
// 作用: 把原本依赖 Vite dev server 的全部能力搬进一个可独立运行的服务,
//   双击 "启动工具\启动-Manke.bat" 即可使用完整应用 (不再需要 npm run dev)。
//
//   1) 托管 app/dist 前端产物     → http://127.0.0.1:5173/          (完整应用: 项目列表 / 画布)
//   2) 托管启动台控制台           → http://127.0.0.1:5173/console   (根目录 index.html)
//   3) 反向代理三个本地后端 + Agnes 云端 (含 WebSocket, 实时进度)
//        /comfy/*    → 127.0.0.1:8188   (H3 视频, 含 ws)
//        /kear/*     → 127.0.0.1:8189   (Krea2 生图, 含 ws)
//        /indextts/* → 127.0.0.1:8190   (IndexTTS 语音)
//        /agnes/*    → https://apihub.agnes-ai.com (服务端注入 Authorization)
//   4) 本地 API
//        GET  /api/status              → 三后端在线状态 (服务端探测, 无跨域问题)
//        POST /api/launch?name=h3|kear|indextts → 静默托管启动后端(无窗口, 日志落盘)
//        POST /api/open-folder         → 打开产物所在目录并高亮
//        GET/POST/PUT/DELETE /api/providers[...] → Provider 增删改查 + 测连通
//        GET/POST/PATCH/DELETE /api/voices[...] → 音色库: 列表/克隆/改名/删除
//        GET  /api/voices/<id>/audio   → 试听音色参考音频 (支持 Range)
//        (直接读写 backends/indextts-tts/voices.json, 改完立即生效, 免重启 8190)
//        GET  /api/webapps             → 网页版站点(豆包/DeepSeek) + 浏览器探测 + 登录态
//        POST /api/webapps/open|reset  → 用独立窗口打开网页版 / 清除其登录态
//        (独立浏览器窗口 + 项目内 profiles/ 持久化 cookie, 扫码一次长期免登录)
//
// 端口: 默认 5173 (与 vite dev 一致, 应用内相对路径全部无需改动)
//        可用环境变量 AICS_PORT 覆盖。
// ============================================================

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
// 网页版外部工具 (豆包/DeepSeek) 的实现: 与 vite dev 中间件共用同一份
import { webAppState, openWebApp, resetWebApp } from './tools/webapps.mjs'
// 低驱动兼容栈(CUDA 12.6): 让驱动 < 580.88 的机器也能跑 H3/Krea2
import { installCompatPth, removeCompatPth, vendorExists, COMPAT_KINDS } from './tools/compat_pth.mjs'
/** 「装完模型包该自动重启哪几路」的判定(纯函数, 见该文件头部说明与 hygiene H253) */
import { planInstallRestart } from './tools/backendrestart.mjs'
import { coldStart, scanAlerts, recPhase, silentLimitSec, timeoutHintSec, PHASE_TEXT } from './tools/backendwatch.mjs'
import {
  systemMemory, memPolicy, decideRelease,
  POLICY_TEXT, PLAN_TEXT, AUTO_FREE_HINT, defaultAutoFree, BACKEND_LABEL,
  testLimits,
} from './tools/mempolicy.mjs'
// 最低配置检查(不达标的机器不"想办法硬跑", 直接说清楚)
import { checkSysreq, MIN_REQ, appControlState, driverAdvice, DRIVER_REQ } from './tools/sysreq.mjs'
/**
 * 「固定内存(pinned memory)要不要关」的判定 —— 单独成模块才有法单测
 *   （见 tools/selftest/pinned-memory.mjs）。⚠️ 新增 tools/*.mjs 被 server.mjs import 时,
 *   必须同步加进 app/electron/stage.mjs 的 TOOLS_ALLOWLIST, 否则打出来的包启动即崩。
 */
import { pinnedMemoryDecision } from './tools/launchprofile.mjs'
// 运行期路径解析: 开发态 = 源码根, 打包态 = exe 同目录 + data/ (单一事实来源)
import { resolvePaths, readEnvFile, readVersionInfo, SRC_ROOT } from './tools/runtime.mjs'
// 离线授权: 机器码指纹 (tools/machine.mjs) + Ed25519 验签 (tools/license.mjs)
import { getMachineInfo } from './tools/machine.mjs'
import { sha256OfFile, packShaVerdict } from './tools/pack-sha.mjs'
import { licenseStatus, writeLicense, removeLicense, fingerprintToken, FEATURE_LABELS } from './tools/license.mjs'
// 时间轴守卫: 三处锚点 + 时间回拨判定 (tools/clockguard.mjs)
import { clockReport, SOURCE_LABELS } from './tools/clockguard.mjs'
// 内置提示词包: 产物里不留明文, 这里解密后经 /api/prompts 下发 (tools/promptpack.mjs)
import { readPromptPack } from './tools/promptpack.mjs'
// 模型包: 程序与模型分开发布后, 靠清单 + 契约号判断"这两个版本能不能配合用"
// MODEL_COMPONENTS 也在用(安装模型包的"这层装没装"判据) —— 漏了它就会
// ReferenceError: MODEL_COMPONENTS is not defined, 而且会直接冒到界面上的红色提示(实测)
import {
  describeStatus, MODEL_TIERS, refGenStatus, MODEL_COMPONENTS, componentStatus,
  genFilesHealth, filesInComponent, resolveComponentDir, findModelPackFiles, findExistingModelRoot,
  MODEL_API_VERSION,
} from './tools/models.mjs'
import { parseExcludedPortRanges, rangeForPort, relocatePortCandidates, RELOCATE_PORT_START } from './tools/ports.mjs'

/**
 * 这是不是"内部开发版(未归档)"—— 与主进程同一口径: **只看布局, 不看可写文件**。
 *
 *   · 正式发行包: `<...>\resources\app.asar.unpacked\bundle\server.mjs` —— 路径里含 `app.asar`
 *   · 内部开发版: `<...>\resources\app\bundle\server.mjs` —— 路径里不含(asar:false)
 *
 * ⚠️ 2026-10-01 加固(打正式包时发现): 上一版看的是"同目录有没有 `bundle/dev-build.json`",
 *   而 bundle/ 是解包在 asar 外面的 —— 发行版里丢一个同名文件就能让 /api/prompts 不再校验授权、
 *   把加密的提示词包直接吐出来。改成布局判定后, 这个条件在发行包里无法伪造(要伪造就得先把
 *   app.asar 抹掉, 而那样程序根本起不来 —— 见 main.cjs 里 devUnpackedBuild 的说明)。
 */
/**
 * 授权门禁开关（2026-10-28 122 P0-2）。
 *
 * 旧实现靠 `import.meta.url` 猜"是不是 app.asar 布局"，并且 packaged 由调用方随便传；
 * 复制一份 bundle 出去用 `node server.mjs` 跑，两个开关都变成 false → 门禁全关。
 * 现在**默认拒绝**：只有主进程在 bootServer() 里显式注入 gate 才决定是否要求授权；
 * 直接 `node server.mjs` 必须显式 `AICS_DEV_GATE_DISABLED=1` 才进入开发态。
 */
let GATE = { requireLicense: true, token: '' }
function licenseRequired() {
  return GATE.requireLicense === true
}

// ---------------------------------------------------------------- 路径与常量
//
// 所有路径都来自 resolvePaths() (见 tools/runtime.mjs)。P 由 startServer() 注入,
// 因此同一个 server.mjs 既能 `node server.mjs` 直接跑, 也能被 Electron 主进程
// 以 { appRoot, dataDir, distDir, port } 拉起 —— 模式差异全部收敛在注入参数里。

/** @type {ReturnType<typeof resolvePaths>} */
let P = null
let PORT = 5173

/**
 * 本次安装的实例身份（2026-10-25）。
 *
 * 客户机上常同时存在另一套 ComfyUI 或旧版 Manke H3；它们也能回答 H3 专用节点，
 * 单凭节点名无法证明“这是我这次安装拉起的后端”。实例 ID 放在 data\ 下（升级程序不丢），
 * 每次受管启动通过环境变量交给后端，再由后端身份端点原样回报。程序同时核对程序版本与模型契约。
 */
let INSTANCE_ID_CACHE = ''
function currentInstanceId() {
  if (INSTANCE_ID_CACHE) return INSTANCE_ID_CACHE
  try {
    const file = path.join(P.dataDir, 'instance-id.txt')
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : ''
    if (/^[A-Za-z0-9-]{8,128}$/.test(old)) {
      INSTANCE_ID_CACHE = old
      return old
    }
    const next = randomUUID()
    fs.mkdirSync(P.dataDir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, next + '\n', 'utf8')
    fs.renameSync(tmp, file)
    INSTANCE_ID_CACHE = next
    return next
  } catch {
    /** 极端只读场景：本次进程内仍保持稳定；重启后无法持久，自然会被身份核对拦下 */
    INSTANCE_ID_CACHE = INSTANCE_ID_CACHE || randomUUID()
    return INSTANCE_ID_CACHE
  }
}

/** 当前程序期望后端回报的身份（仅本机使用，不含密钥） */
function expectedBackendIdentity() {
  const p = P?.versionInfo?.program ?? {}
  return {
    instanceId: currentInstanceId(),
    programVersion: String(p.version ?? ''),
    build: String(p.build ?? ''),
    modelApiVersion: String(MODEL_API_VERSION),
    backendsRoot: String(P?.backendsRoot ?? ''),
  }
}

const HOST = '127.0.0.1'
const AGNES_UPSTREAM = 'https://apihub.agnes-ai.com'

/** 三个模型后端的端口与探测方式; 根目录由 P.backendsRoot 派生 (不写死) */
const BACKENDS = {
  h3: {
    label: 'H3 视频', port: 8188, probe: '/system_stats',
    bat: 'start-h3-video-8188.bat',
  },
  kear: {
    label: 'Krea2 生图', port: 8189, probe: '/system_stats',
    bat: 'start-kear2-image-8189.bat',
  },
  indextts: {
    label: 'IndexTTS 语音', port: 8190, probe: '/status',
    bat: 'start-indextts-voice-8190.bat',
  },
  /**
   * 第 4 路 (2026-09-24 方案 A): Qwen-Image-2.1 生图。
   * 独立一路的原因: 它要 ComfyUI ≥0.37(2.1 的节点), 而现役 Krea2 那路是 0.31.1 ——
   *   升级那一路会牵扯 Krea2 与 2509-edit 两条已经跑通的工作流, 风险不划算。
   */
  qwen: {
    label: 'Qwen 生图 2.1', port: 8191, probe: '/system_stats',
    bat: 'start-qwen-image-8191.bat',
  },
  /**
   * 第 5 路 (2026-09-25): **本地小文本模型**(提示词优化用, 不占显存)。
   * 用户口径: "能不能引入小一点的文本模型呢，另外完全摒弃掉API优化提示词的路子"。
   * 实测(24 线程 / Qwen2.5-0.5B-Instruct): 加载 1.6s · ~10-12 tok/s · 内存 ~1.2GB · 显存 0;
   * 一次 300 token 的改写要 25~35 秒 —— 比云端慢, 但零成本、零联网、素材不出本机。
   * 探针用 /health(我们自己写的 worker, 见 tools/local-text/serve.py)。
   */
  text: {
    label: '本地文本模型', port: 8192, probe: '/health',
    bat: 'start-local-text-8192.bat',
  },
}

/**
 * ⚠️ **只给测试用的端口覆盖口子**（2026-10-12）。
 *
 * 为什么必须要有它: 这台开发机的 Windows 保留段(8179-8278)盖住了四个真实后端端口 ⇒ 连"假监听器"
 *   都绑不上, 于是"别人占了我的端口/端口串台/半死不活"这些极端情况**根本没法在真机上模拟**。
 *   有了这个口子, 探针可以把四路端口整体挪到 9188-9191 去模拟(`AICS_TEST_PORTS=h3:9188,kear:9189,…`)。
 * ⚠️ 默认**不生效**; 只影响服务端自己的"拉后端 + 反代 + 探测"(前端一律走 /comfy、/kear 这类路径, 不认端口)。
 */
for (const pair of String(process.env.AICS_TEST_PORTS || '').split(',')) {
  const m = /^\s*([a-z0-9]+)\s*:\s*(\d{2,5})\s*$/i.exec(pair)
  if (!m) continue
  const kind = m[1].toLowerCase()
  const port = Number(m[2])
  if (BACKENDS[kind] && port > 0 && port < 65536) BACKENDS[kind].port = port
}

/**
 * **出厂默认端口**的快照(在 AICS_TEST_PORTS 覆盖之后取, 所以测试口子给的端口在这里就是"默认")。
 *
 * 为什么需要它: 自动搬迁是"拿默认端口跟系统保留段比一比"。如果直接读 `BACKENDS[kind].port`,
 *   同一个进程里第二次 startServer(开发态热重启/探针) 读到的是**上次搬过的端口**,
 *   于是会把"已经搬过"误判成"默认端口可用", 顺手把搬迁记录抹掉、下一次又搬一遍。
 */
const DECLARED_PORTS = Object.fromEntries(Object.entries(BACKENDS).map(([k, b]) => [k, b.port]))

/**
 * 某个后端对应的模型组件安装状态 (键与 BACKENDS 一致)。
 * 用途: 分层模型包里"没装的组件"要能被识别出来, 不要当成故障。
 */
function componentOf(kind) {
  try {
    return P.modelsQuick().components.find((c) => c.key === kind) ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 小工具

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
}

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

function sendJson(res, status, payload) {
  // 已经回过一次了就别再写头(否则抛 ERR_HTTP_HEADERS_SENT)。超限请求体就是这种情况:
  // readBody 先回 413, 业务 handler 还会再去 sendJson 一次。
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

/**
 * 读 JSON 请求体, **带上限** (2026-09-20 · 代码评估报告 P1「readBody 无大小上限」)。
 *
 * 以前是 `for await (const c of req) chunks.push(c)` —— 谁都能往内存里灌一个任意大的 body
 * (本机门禁只挡"外部网页发起的", 挡不住本机脚本写错或者前端 bug 循环重试),
 * 而且走 readBody 的那些接口(/api/assets/put 的 base64、/api/store/put 等)没有任何自己的上限
 * (handleAssetsPutBlob 走的是原始二进制上传, 它有自己的上限, **不过 2026-10-12 审计 §2.5 之前
 *  它踩了同一个 `for await` 中途 return 的坑**: 413 会被 RST 吃掉 —— 已改成"手动 data/end +
 *  边收边写临时文件 + 先排空再回 413", 见那个函数)。
 * 现在: 累计超过 BODY_MAX_BYTES 立刻回 413 并断开连接, 不再继续读。
 */
const BODY_MAX_BYTES = 64 * 1024 * 1024
/**
 * 审计第二批(2026-10-12)要用的三个闸门数值。
 *
 * ⚠️ 环境变量是**只给测试用**的口子(与 AICS_TEST_PORTS 同一思路): 生产默认值写死在这里,
 *   环境变量**只能把闸门调小/调短** —— 否则要造一个 2GB 的请求、或者枯等 3 分钟, 才验得了一次。
 *   · AICS_PROXY_IDLE_MS    反代"上游多久没动静就当它挂了"(默认 180s)
 *   · AICS_BLOB_MAX_MB      上传 blob 的体积上限(默认 2048MB)
 *   · AICS_LOCALIZE_MAX_MB  /api/assets/localize 远端下载上限(默认 512MB)
 *   · AICS_WS_CONNECT_MS / AICS_WS_IDLE_MS  WebSocket 转发: 建连上限(默认 10s) / 建连后空闲上限(默认 20min)
 */
function testNum(name, def) {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : def
}
const PROXY_IDLE_MS = () => testNum('AICS_PROXY_IDLE_MS', 180_000)
/**
 * 长同步接口的空闲超时（2026-10-28 用户日志）：
 *   IndexTTS 的 POST /indextts/tts 是**同步阻塞**的 —— 推理 25 步期间服务端不返回任何字节，
 *   默认 180s 空闲超时会在 3 分钟时主动断开，后端日志就是 WinError 10053。
 *   8GB 卡实测 22~30s/步，25 步要 9~13 分钟；给 45 分钟，避免正常推理被误杀。
 *   只放宽 TTS 这一条；其它反代仍用默认 180s。
 */
function proxyIdleMsFor(prefix, rest) {
  if (prefix === '/indextts' && /^\/tts(?:\?|$)/.test(String(rest || ''))) return 45 * 60_000
  return PROXY_IDLE_MS()
}
/**
 * IndexTTS 正在推理的**进程内租约**（2026-10-28 用户日志）。
 *
 * 现场：语音推理 15 分钟，期间 `/status` 探测超时，应用每 60s 把 IndexTTS 标成离线；
 * 00:49 用户/队列又启动 H3，两个模型在 8GB 卡上互相抢显存，s2mel 从 22s/步恶化到 136s/步。
 * 这个租约不依赖后端 /status：只要 `/indextts/tts` 请求还在，就：
 *   · 探测直接认为它在线（不标红）；
 *   · 独占在线把其它模型启动视为冲突（除非用户强制）。
 */
let indexttsBusy = 0
let indexttsBusySince = 0
function indexttsLeaseStart() {
  indexttsBusy += 1
  if (indexttsBusy === 1) indexttsBusySince = Date.now()
}
function indexttsLeaseEnd() {
  indexttsBusy = Math.max(0, indexttsBusy - 1)
  if (indexttsBusy === 0) indexttsBusySince = 0
}
const BLOB_MAX_BYTES = () => testNum('AICS_BLOB_MAX_MB', 2048) * 1024 * 1024
const LOCALIZE_MAX_BYTES = () => testNum('AICS_LOCALIZE_MAX_MB', 512) * 1024 * 1024
const WS_CONNECT_MS = () => testNum('AICS_WS_CONNECT_MS', 10_000)
const WS_IDLE_MS = () => testNum('AICS_WS_IDLE_MS', 20 * 60_000)

async function readBody(req, res) {
  /**
   * ⚠️ 这里**故意不用 `for await (const c of req)`**: 消费中途 throw/break 会让 async iterator
   * 调 stream.return() → 直接把套接字销毁, 刚写出去的 413 会被 RST 吃掉(实测: 客户端只看得到
   * "连接被重置", 完全不知道是体积超限)。改成手动监听 data/end, 超限时"回 413 + 丢包 + 正常收尾"。
   */
  return await new Promise((resolve) => {
    const chunks = []
    let total = 0
    let settled = false
    const done = (val) => { if (settled) return; settled = true; resolve(val) }
    const onData = (c) => {
      total += c.length
      if (total > BODY_MAX_BYTES) {
        if (res && !res.headersSent) {
          sendJson(res, 413, {
            ok: false,
            msg: `请求体太大（上限 ${Math.round(BODY_MAX_BYTES / 1024 / 1024)}MB）`,
          })
        }
        // 停止累积; 剩下的字节继续走(丢弃), 连接保持完好, 413 能正常送达客户端。
        // 返回空对象而不是抛错: 调用方拿到空 body 后自己的"缺少参数"提示会被 sendJson 的
        // headersSent 守卫吞掉, 不会有二次写头/未捕获异常。
        chunks.length = 0
        req.removeListener('data', onData)
        req.removeListener('end', onEnd)
        req.resume()
        done({})
        return
      }
      chunks.push(c)
    }
    const onEnd = () => {
      const txt = Buffer.concat(chunks).toString('utf-8')
      if (!txt) { done({}); return }
      try { done(JSON.parse(txt)) } catch { done({}) }
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', () => done({}))
  })
}

function log(...args) {
  console.log('[aics]', ...args)
  appLogWrite(args.map((a) => {
    if (typeof a === 'string') return a
    try { return JSON.stringify(a) } catch { return String(a) }
  }).join(' '))
}

/**
 * 应用自身日志**落盘** (2026-09-20)。
 *
 * 为什么补上这一段:
 *   ① 诊断包与「运行环境日志」的读取端一直在找 `data/logs/app-*.log`(见 5992 行附近),
 *      但写入端此前只剩 console.log —— 于是用户点"导出运行环境日志"时内容少得可怜
 *      (他反馈过"配置启动页面的运行环境日志无法导出")。
 *   ② 用户要的"谁把后端停的 / 当时有没有任务在跑"这类关键事实, 只进后端自己的 log 文件时,
 *      一旦那个进程没被托管(手动启动的、被外部停掉的)就没有任何档案可查。
 * 实现: 攒够一批或 400ms 再落盘(日志调用很频繁, 不能每条都同步写);
 *   单文件超过 20MB 就改成 `.1` 备份一份继续写, 不会无限长大。
 */
let appLogBuf = []
let appLogTimer = null
function appLogFileName() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `app-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.log`
}
function flushAppLog() {
  if (appLogTimer) { clearTimeout(appLogTimer); appLogTimer = null }
  if (!appLogBuf.length) return
  const text = appLogBuf.join('\n') + '\n'
  appLogBuf = []
  try {
    const dir = LOG_DIR()
    ensureDir(dir)
    const file = path.join(dir, appLogFileName())
    try {
      if (fs.statSync(file).size > 20 * 1024 * 1024) fs.renameSync(file, `${file}.1`)
    } catch { /* 首次写入 / 改名失败都不影响继续写 */ }
    fs.appendFileSync(file, text)
  } catch { /* 磁盘只读等情况: 静默, 绝不因为日志写不进去影响功能 */ }
}
function appLogWrite(oneLine) {
  try {
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    appLogBuf.push(`[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}] ${oneLine}`)
    if (appLogBuf.length >= 200) flushAppLog()
    else if (!appLogTimer) appLogTimer = setTimeout(flushAppLog, 400)
  } catch { /* ignore */ }
}
process.on('exit', flushAppLog)

/**
 * 云端报错 → **大白话 + 一句怎么办**。
 *
 * 为什么要有它 (2026-09-17 用户要求"生成提示错误的尽量都用大白话, 并且附上简单的提示"):
 *   以前卡片/右下角弹出的是 `云端 HTTP 401 → POST https://…: {"error":…}` —— 用户看不懂,
 *   只能截图来问。现在第一句是人话结论, 第二句是"下一步点哪里", 平台原始报文挪到最后
 *   (它只在真要排查时才看, 不该占第一屏)。整条用 `｜` 分隔, 单行 toast 里也能读。
 *
 * 【2026-09-24 用户: "报错提示优化, 必须要简洁, 用户能够知道发生了什么, 如何解决"】
 *   上一版把原因和办法写成了长句(例: "先确认这台电脑能正常上网；公司/校园网或开着代理时最容易这样,
 *   换手机热点试一次"), 卡片上要读三四行。现在**限量**:
 *     ① 结论 ≤16 字(不含"…失败："前缀)  ② 怎么办 ≤22 字  ③ 前两段合计 ≤40 字
 *   这一套跟前端 friendlyError.ts 完全一致 —— 前端看到带"｜怎么办"的串会**原样透传**,
 *   所以服务端拼的文案必须自己就达标。
 *   体检: _dev/tests/_audit_error_text_all.mjs；结构: tools/selftest/friendly-errors.mjs D8/D9。
 */
/**
 * 平台说"**任务失败**(failed)"时，"怎么办"必须**看它的原话**，不能一律劝用户改提示词。
 *
 * ★ 2026-10-15 客户实报（走自建代理桥 `h3-cloud`）：
 *   平台原话是 `fetch failed` —— 那是**桥自己连不上同机 ComfyUI**（它配置页上明写着"ComfyUI 连不上 ✗"），
 *   而这里原来硬编码成「怎么办：**换掉敏感内容（真人/品牌）**」⇒ 用户跑去改提示词、换题材，白折腾一大圈。
 *   这类"原话与建议对不上"的错，比不报错更坏：它把人**指向错误的方向**。
 */
function failedTaskHint(text) {
  const t = String(text || '')
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|socket hang up|aborted|network/i.test(t)) {
    /**
     * ⚠️ 这里是**用户直接看到的字**，不许用 Markdown 的 `**`（落屏就是可见星号），
     *   也不要写成长句 —— 而且这两条以前 A11 扫不到（它只扫 msg/detail/note 字段，
     *   扫不到 `return` 出来的文案），2026-10-15 就漏出来过一次：截图里写着
     *   「平台/网关**连不上它自己的后端**」。现在 A11 已把本函数体也纳入扫描。
     */
    return '平台连不上它自己的后端（自建桥多为同机 ComfyUI 没起、或端口填错）'
  }
  if (/out of memory|OOM|显存|内存不足|CUDA error/i.test(t)) return '显存或内存不够——降一档分辨率或时长再试'
  if (/timeout|timed out|超时/i.test(t)) return '超时了——稍后重试'
  if (/sensitive|blocked|moderation|审核|违规|安全|policy/i.test(t)) return '换掉可能违规的内容（真人/品牌）'
  /** 认不出来就别猜：把原话原样交出去，比编一个看起来合理的建议强 */
  return '看下面的平台原话——整段发给部署方或我们'
}

function friendlyCloudError({ action = '生成', status = 0, body = '', url = '', extra = '' } = {}) {
  const text = String(body || '')
  const re = (r) => r.test(text)
  let why = ''
  let hint = ''
  /**
   * ★ 2026-10-12 Agnes 中国站实测得到的四条**平台原话** → 人话。
   *   必须排在最前面: 它们带的 HTTP 状态(503/400/401)会和下面那些通用分支撞车,
   *   兜到"连不上云端服务 / key 无效 / 模型没权限"上, 用户就完全看不出真因了。
   *   (例: 客户在中国站填了国际站的模型名 → 503 model_not_found, 而通用分支会说是"服务不可用"。)
   */
  if (re(/model_not_found|无可用渠道|no available channel/i)) {
    why = '这个站点没有这个模型'
    hint = '换该站支持的模型名：Agnes 中国站的视频只有 agnes-video-2.5-flash'
  } else if (re(/video_queue_(full|unavailable)|视频队列/i)) {
    /**
     * ★ 2026-10-12 实测(用户新购的 Token Plan Starter, 国际站 apihub.agnes-ai.com):
     *   503 `video_queue_full` 是**平台侧的排队容量**, 与 key、套餐余量、参数都无关 ——
     *   同一把 key、同一份参数连续建单: 前 6 次全是它, 第 7 次(约 3 分钟后)就建单成功了。
     *   两个必须守住的点:
     *     · 这条要排在 503 通用分支**前面**, 否则会被说成"平台自己出故障了", 真因看不出;
     *     · 不能说成"余额/额度不够" —— 用户会白跑一趟充值(实测这把 key 视频额度 0/500 没用过)。
     *   还有一句要写进话术: 平台**网页版能出片 ≠ API 通道有空位**, 那是两套容量池
     *   (官方 FAQ 原话: 「免费 Key 与 Token Plan Key 使用不同的限制池」)。
     */
    why = '平台的视频通道正挤满'
    hint = '这是平台侧排队，跟你的 key、套餐余额、参数都没关系——等几分钟再点一次即可'
  } else if (re(/输入图边长必须|边长必须在\s*256/i)) {
    why = '参考图尺寸不合规'
    hint = '参考图每边要在 256–5760 像素之间：换一张更大的图，或先裁一下'
  } else if (re(/素材必须是公网|合法\s*Base64/i)) {
    why = '参考素材格式不对'
    hint = '平台只认公网 http(s) 链接或裸 base64：把本地素材先收进素材库再引用'
  } else if (status === 0 || re(/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|socket hang up|network|aborted/i)) {
    why = '连不上云端服务'
    hint = '检查网络或代理，换热点试一次'
  } else if (status === 401 || re(/invalid[\s_-]*(token|api[\s_-]*key)|unauthor|authentication|token not provided|无效的令牌|未提供令牌/i)) {
    why = 'key 无效或已过期'
    hint = '去「API」面板重新粘贴 key'
  } else if (status === 402 || re(/insufficient|balance|arrears|欠费|余额不足|额度不足|充值/i)) {
    why = '账号余额/额度不够'
    hint = '去平台充值或开通套餐'
  } else if (status === 403 && re(/quota|credit|套餐/i)) {
    why = '账号额度用完了'
    hint = '去平台看套餐余量'
  } else if (status === 403) {
    why = '这把 key 没这个模型的权限'
    hint = '去平台开通它，或换一个模型'
  } else if (status === 404) {
    why = '接口地址或模型名不对'
    /**
     * ⚠️ 2026-10-03 用户现场: 火山方舟的模型广场写的是「DeepSeek-V4-Flash正式版」, 而接口要的是
     *   Model ID(`deepseek-v4-flash-260425`)。用户把中文显示名当成模型名填进清单 → 平台回
     *   `404 InvalidEndpointOrModel.NotFound: The model or endpoint DeepSeek-V4-Flash正式版 does not exist`。
     *   404 的响应里只要出现中文, 十有八九就是"把中文显示名当模型名了" —— 单独点出来, 不然用户
     *   只会以为"模型名不对", 完全想不到该去哪儿拿那串英文 ID。
     */
    hint = /[\u4e00-\u9fa5]/.test(text)
      ? '你填的看起来是模型的「中文名」—— 接口要的是 Model ID(英文/数字/连字符, 例如 deepseek-v4-flash-260425): 去模型广场整段复制那串 ID'
      : '模型名整段复制；地址在「高级」里改'
  } else if (status === 413) {
    why = '参考图太大'
    hint = '换张小图（短边 ≤2048）再试'
  } else if (status === 429 || re(/rate limit|too many|并发|频率/i)) {
    why = '平台限流了'
    hint = '等 1~5 分钟再点一次'
    /**
     * ⚠️ 2026-10-05 用户现场(智谱 BigModel, 模型名写成 glm-4.7-flash):
     *   平台回的是 `429 {"code":"1305","message":"该模型当前访问量过大，请您稍后再试"}` ——
     *   看着像限流, 实际是**模型不存在**(实测同一把 key: glm-4.7 → 200, glm-4.7-flash → 1305 之后就没声响)。
     *   所以限流这条也得带一句"核对模型 ID", 否则用户只会一直等, 永远查不出来。
     */
    if (re(/访问量过大|排队|overload|model|模型/i)) {
      hint = '等 1~5 分钟再点一次；若一直这样，多半不是你的 key 的问题：'
        + '① 核对模型 ID（去「API」面板点『拉取模型』用清单里的原文 —— 有些平台对"不存在的模型"也回这条）；'
        + '② 换同平台的另一个模型（例如同系列的 flash / pro）再试'
    }
  } else if (status === 503 || re(/queue is full|overload|队列已满/i)) {
    why = '平台在排队，队列满了'
    hint = '过几分钟再点一次'
  } else if (status >= 500) {
    why = '平台自己出故障了'
    hint = '等几分钟再试'
  } else if (status === 400 && re(/model|模型/i)) {
    why = '模型名不对或没开通'
    hint = '去平台复制完整的模型 ID'
  } else if (status === 400 && re(/size|resolution|像素|分辨率|width|height|aspect/i)) {
    why = '这个模型不支持当前尺寸'
    hint = '换一档分辨率或画幅再试'
  } else if (status === 400 && re(/prompt|content|sensitive|审核|违规|安全/i)) {
    why = '提示词被平台挡下了'
    hint = '换掉可能违规的词再试'
  } else if (status === 400) {
    why = '平台不接受这次参数'
    hint = '按卡片默认档位再试'
  } else {
    why = '平台返回了错误'
    hint = '稍后重试，还失败就发我们'
  }
  const parts = [`${action}失败：${why}${status ? `（HTTP ${status}）` : ''}`]
  if (hint) parts.push(`怎么办：${hint}`)
  if (extra) parts.push(extra)
  if (url) parts.push(`请求地址：${url}`)
  // 平台原话只留前 120 字: 错误码多半就在最前面; 要完整报文看「配置与启动 → 导出日志」
  if (text) parts.push(`平台原话：${text.slice(0, 120)}`)
  return parts.join('｜')
}

// ---------------------------------------------------------------- 云端 API 平台目录 + 连接存储 (v2)
// 2026-09-15 重构: 面板改成"先选平台 → 再选类型(文字/图片/视频)"两步。
//   · 平台目录只提供 **接口地址 + 协议形状**(这是接口规范, 不是替你选模型);
//   · **绝不预置任何模型名** —— 模型由用户自己填, 或点「拉取模型」从 /models 勾选。
//   · 一个连接(一个 key)可同时挂三类模型; 面板三个板块各看各的。
// 明文 key 只落磁盘, 对前端只暴露掩码。

/** 三个板: 文字 / 图片 / 视频 */
const API_KINDS = ['text', 'image', 'video']

/**
 * 协议形状 (shape) —— 决定服务端怎么发请求、怎么取结果:
 *   openai-chat      POST {path} {model,messages}            → choices[0].message.content
 *   openai-image     POST {path} {model,prompt,size,n}       → data[0].url | data[0].b64_json
 *   ark-task         火山方舟: POST {submit} → id → GET {poll}
 *   dashscope-task   阿里百炼: POST {submit} + X-DashScope-Async: enable → output.task_id → GET {poll}
 *   modelscope-task  魔搭:     POST {submit} + X-ModelScope-Async-Mode: true → task_id → GET {poll}
 *   generic-task     自定义:   POST {submit} → 自适应提取 url / task_id → GET {poll}
 */
/** Agnes(图片/视频)官方支持的比例集合 —— 卡片给的确切像素要就近贴合, 否则会被判非法 */
const AGNES_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9']

const API_PLATFORMS = [
  {
    /**
     * ★ 2026-10-14 新增: 用户自建的「云端租显卡 + 反向代理 ComfyUI」方案(配套工具 tools/h3-cloud)。
     *
     * 为什么单独给一个平台, 而不是让用户走「自定义 (OpenAI 兼容)」:
     *   走自定义要用户自己填 **Base URL + Key + 模型名 + 提交路径 + 轮询路径** 五样,
     *   错一样就是"生成失败"且看不出错在哪(这正是"自定义"那条路最容易卡住新手的地方)。
     *   这里把除了 Base URL / Key 之外的**全都预置好**, 契约来自 docs/67 §1.1~1.3 与 tools/h3-cloud 的实测:
     *     · 建任务 `POST /v1/videos`
     *       {model, prompt, seconds(**数字**), size(**小写 x** 的 宽x高), images(≤9 张, data:/http),
     *        steps, sage_attention} —— **不发 `mode`**(平台按 images.length 自己分流: 0=文生/1=图生/≥2=多参);
     *     · 查任务 `GET /v1/videos/{id}`
     *       → `running`(+`progress`/`stageText`) / `succeeded`(+`video_url`) / `failed`(+`message`);
     *     · 成片地址必须**免鉴权可直连**(程序下载产物时不带 Authorization, 见 docs/65 §5.7);
     *     · 进度刻度与画布本地**同一把尺子**(准备 1→30 / 采样 30→88 / 收尾 88→100),
     *       所以服务端把 `progress`/`stageText` 原样透传给卡片就行, 不在中间做任何换算。
     *   ⚠️ 改这里之前先看 `tools/h3-cloud/使用说明.md` 第五节的接口一览 —— 两边是同一份契约。
     */
    id: 'h3-cloud',
    /** 前面的 `★` 是**显著标注**: 这一条要一眼能从平台列表里认出来(用户要求) */
    label: '★ H3 云端算力',
    vendor: 'AutoDL.Art · 扫码登录',
    baseUrl: 'https://autodl.art/api/v1/comfyui',
    modelsPath: '/v1/models',
    /**
     * 2026-10-29 改成一个平台: 不再是「自己租卡跑 h3-cloud」。
     * 客户扫码登录 AutoDL（壳子保存网站登录态，只用于代传参考图），
     * 再填一个 ComfyUI 分组 token；文生视频/多参考都直连 AutoDL。
     * 旧连接仍保留：baseUrl 不是 autodl.art 时 videoEndpoints 会按 generic-task 走。
     */
    note: '点击进入 H3 云端算力：先扫码登录 AutoDL（只用于代传参考图），再填 ComfyUI 分组 token。'
      + '文生视频与多参考由壳子自动上传图片并提交；默认测试档 1 秒 480p。'
      + '旧的自建 h3-cloud 连接仍保留，不会被覆盖。',
    types: {
      video: {
        shape: 'autodl-art',
        submit: '/comfyui_workflow/minimax_h3_z0901',
        poll: '/comfyui_workflow/result/{id}',
        pollSec: 4,
      },
    },
  },
  {
    id: 'agnes',
    /**
     * ★ 2026-10-12 用户: "把两个网站彻底分开, 标注站点, 教程也是同理, 要统一口径"。
     *   统一口径(四处必须一致: 平台卡 / 教程弹窗 / 报错话术 / 交接文档):
     *     国际站 = Agnes 国际站 · 官网 agnes-ai.com    · 控制台 platform.agnes-ai.com · 接口 apihub.agnes-ai.com
     *     中国站 = Agnes 中国站 · 官网 agnes-ai.cn     · 控制台 platform.agnes-ai.cn   · 接口 api.agnes-ai.cn
     *   名字里必须带"国际站/中国站"这几个字 —— 两站的 key 互不通用, 用户拿错站点的 key 是本轮客户问题的
     *   第一现场(表现为 401 无效令牌), 而以前两边都只叫"Agnes", 用户根本不知道要去哪注册。
     */
    label: 'Agnes 国际站',
    // 厂商那行保持**所有平台一样的短格式**(品牌 · 域名) —— 长篇解释去教程弹窗里看(2026-10-12 用户口径)
    vendor: 'Agnes AI · agnes-ai.com',
    baseUrl: 'https://apihub.agnes-ai.com',
    modelsPath: '/v1/models',
    // ⚠️ Agnes 的 /v1/models 是**完全公开**的(实测: 拿假 key 甚至不带 Authorization 也返回 200 + 完整清单),
    //    所以"能拉到模型"在这家**不能**证明 key 可用 —— 生成时才第一次真正鉴权(401 Invalid token)。
    //    这个标记让 probe 成功后**额外做一次带鉴权的真实校验**(见 runProbe), 否则用户会看到
    //    "连通 · 发现 12 个模型"却每次生成都失败, 完全查不出原因。
    publicModels: true,
    // 原来的 `agnes-ai.com/doc/overview` 会 302 跳到**英文站** `/en/docs/...` —— 换成用户实际给的中文快速开始页
    docsUrl: 'https://www.agnes-ai.com/zh-Hans/docs/quickstart',
    note: '站点: 国际站（官网 agnes-ai.com · 控制台 platform.agnes-ai.com · 接口 apihub.agnes-ai.com）。'
      + '一个 key 通吃 文字 / 图片(agnes-image-2.5-flash) / 视频(agnes-video-2.5[-flash]); 视频 4~12 秒'
      + '(卡片更短会自动抬到 4 秒)。⚠️ 与中国站是两个账号、两套 key, 互不通用。',
    types: {
      text: { shape: 'openai-chat', path: '/v1/chat/completions' },
      // 图片契约(2026-09-17 逐条核对 agnes-ai.com/doc/agnes-image-25-flash):
      //   · response_format **不能放顶层**(官方明确写"放顶层会报错"), 必须放 extra_body
      //   · 参考图/多图合成放 extra_body.image, 而且是**数组**(支持 URL 或 data:base64)
      //   · size 用档位 1K/2K/3K/4K 配 ratio(16:9…); 1280x720 这类确切尺寸不是原生输出, 会被归一化
      //   · 没有 n 这个参数
      image: {
        shape: 'openai-image', path: '/v1/images/generations',
        edit: { field: 'image', array: true, inExtraBody: true },
        extraBody: { response_format: 'url' },
        // size 走档位(卡片给的确切像素按短边折算: 480P/720P→1K, 1080P→2K), 比例贴到官方支持的那几个
        sizeTier: 'agnes',
        ratioSet: AGNES_RATIOS,
        dropN: true,
      },
      // 视频契约(2026-09-17 核对 agnes-ai.com/doc/agnes-video-25):
      //   建任务 POST /v1/videos {model,prompt,mode,seconds,size,aspect_ratio}
      //   **取结果不是 /v1/videos/{id}**, 而是 query 形式且必须带 model_name:
      //        GET /agnesapi?video_id=<ID>&model_name=<MODEL>
      //   mode 只有 text / keyframe(首帧) / reference(多参考) 三种(以前发 text2video 是错的);
      //   size 只有 720P/1080P/1K/2K; seconds 是字符串 "4".."12"
      video: {
        shape: 'agnes-video',
        submit: '/v1/videos',
        poll: '/agnesapi?video_id={id}&model_name={model}',
        // 官方文档写"每 1~2 秒轮询一次", 但实测网关会回 429 "too many video status queries" ——
        // 5 秒起步, 遇到 429 还会自动退避(见 runCloudVideoTask)
        pollSec: 5,
        modeField: { text: 'text', image: 'keyframe', multi: 'reference' },
      },
    },
  },
  {
    id: 'ark',
    label: '火山方舟',
    vendor: '字节跳动 · Volcengine Ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    modelsPath: '/models',
    docsUrl: 'https://www.volcengine.com/docs/82379/1541523',
    note: '一个 key 覆盖 豆包(文字) / Seedream(图片) / Seedance(视频); 视频时长按秒指定',
    types: {
      text: { shape: 'openai-chat', path: '/chat/completions' },
      // 官方图片生成 API 参数: model / prompt / image(string|string[]) / size / response_format
      //   / watermark(**默认 true = 默认打水印**) / output_format / sequential_image_generation
      //   注意: **没有 n**; 参考图字段就叫 image, 单张给字符串、多张给数组
      image: {
        shape: 'openai-image', path: '/images/generations',
        edit: { field: 'image', array: true },
        extraTop: { watermark: false },
        dropN: true,
      },
      // 官方"创建视频生成任务"走结构化字段: resolution / ratio / duration(秒) / watermark(默认 false)
      video: { shape: 'ark-task', submit: '/contents/generations/tasks', poll: '/contents/generations/tasks/{id}' },
    },
  },
  {
    id: 'bailian',
    label: '阿里百炼',
    vendor: '阿里云 · DashScope',
    baseUrl: 'https://dashscope.aliyuncs.com',
    modelsPath: '/compatible-mode/v1/models',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/qwen-image-api',
    note: '文字走 OpenAI 兼容模式; qwen-image 系走多模态同步接口, wanx 系与视频走 DashScope 异步任务',
    types: {
      text: { shape: 'openai-chat', path: '/compatible-mode/v1/chat/completions' },
      // ⚠️ 百炼**没有** OpenAI 兼容的出图接口: POST /compatible-mode/v1/images/generations 实测 HTTP 404
      //    (两种拼写都试过), 所以这一栏以前是"怎么点都生成不了"。改走 DashScope 原生异步任务:
      //      qwen-image / qwen-image-edit → /api/v1/services/aigc/multimodal-generation/generation
      //      wanx 系列                    → /api/v1/services/aigc/text2image/image-synthesis
      //    两者都要 X-DashScope-Async: enable, 拿 output.task_id 再轮询 /api/v1/tasks/{id}。
      image: {
        shape: 'dashscope-image',
        submit: '/api/v1/services/aigc/multimodal-generation/generation',
        submitAlt: ['/api/v1/services/aigc/text2image/image-synthesis'],
        poll: '/api/v1/tasks/{id}',
        // DashScope 尺寸串用 `*` 分隔(1280*720); qwen-image-2.0 系要求总像素在 512*512~2048*2048
        sizeStyle: 'dashscope',
        // 官方文档: qwen-image 系走多模态同步接口(input.messages), wanx 系走 text2image(input.prompt)
        // —— 按模型名分流, 别把两种形状混在一起
        qwenMultimodal: true,
      },
      video: { shape: 'dashscope-task', submit: '/api/v1/services/aigc/video-generation/video-synthesis', poll: '/api/v1/tasks/{id}' },
    },
  },
  {
    id: 'modelscope',
    label: '魔搭 ModelScope',
    vendor: '阿里 · ModelScope 推理',
    baseUrl: 'https://api-inference.modelscope.cn',
    modelsPath: '/v1/models',
    docsUrl: 'https://www.modelscope.cn/docs/model-service/API-Inference/intro',
    note: '文字/图片走 API-Inference; 魔搭不提供视频生成接口(视频请用别的平台)',
    types: {
      text: { shape: 'openai-chat', path: '/v1/chat/completions' },
      // 魔搭的图片是**异步任务**: POST 拿 task_id → 带 X-ModelScope-Task-Type 轮询 /v1/tasks/{id}
      // (实测: 提交返回 {task_status,task_id}, 42 秒后任务 SUCCEED, 图在 output_images[0])
      image: {
        shape: 'openai-image', path: '/v1/images/generations',
        poll: '/v1/tasks/{id}', pollHeaders: { 'X-ModelScope-Task-Type': 'image_generation' },
        // 魔搭免费档要排队(实测同一模型从 42 秒到 >5 分钟不等) —— 5 分钟的轮询上限太紧,
        // 会在"其实已经排到一半"的时候判超时, 用户看到的就是"生成不了"。
        pollTimeoutMs: 600_000,
        // 官方参数表: model / prompt / negative_prompt / size("1024x1024") / seed / steps / guidance
        //   / image_url(图生图: 图片 URL 或 data:base64) / loras —— **没有 n**
        dropN: true,
        // ⚠️ 参考图字段官方叫 image_url(不是 image)
        //   参数表写的是 string(单张), 所以只有一张时给字符串、多张才给数组
        edit: { field: 'image_url', array: true, singleIfOne: true },
        dropTopResponseFormat: true,   // 官方参数表里没有 response_format(返回固定是 output_images)
      },
    },
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    vendor: 'SiliconFlow · 聚合',
    baseUrl: 'https://api.siliconflow.cn',
    modelsPath: '/v1/models',
    docsUrl: 'https://docs.siliconflow.cn/docs/api/images-generations-post',
    note: '聚合: 文字(Qwen/DeepSeek/GLM…) / 图片(Kolors/FLUX/Qwen-Image) / 视频(Wan 系列, 提交+POST轮询)',
    types: {
      text: { shape: 'openai-chat', path: '/v1/chat/completions' },
      // 官方(创建图片生成请求)参数: model / prompt / negative_prompt / **image_size("宽x高")**
      //   / seed / num_inference_steps / guidance_scale(Kolors) / cfg(Qwen-Image)
      //   / image(URL 或 data:base64) —— **没有 size 这个参数**, 发 size 会被忽略、分辨率不生效
      //   多参考: image / image2 / image3, 后两个**仅 Qwen/Qwen-Image-Edit-2509** 支持
      image: {
        shape: 'openai-image', path: '/v1/images/generations',
        sizeField: 'image_size',
        sizeSkipIfModel: /qwen-image-edit/i,     // 官方明确: 这两个模型不支持 image_size
        watermarkHeader: { 'X-Enable-Watermark': '0' },  // 默认会打"AI生成"水印
        dropTopResponseFormat: true,   // 官方参数表里没有 response_format(返回固定是 images[].url)
        dropN: true,                   // 官方参数表里也没有 n
        edit: { field: 'image', array: false, extraFields: ['image2', 'image3'], extraIfModel: /qwen-image-edit-2509/i },
      },
      // 硅基流动的视频是 POST /v1/video/submit → POST /v1/video/status {requestId}(注意: 状态查询也是 POST)
      video: { shape: 'siliconflow-task', submit: '/v1/video/submit', poll: '/v1/video/status' },
    },
  },
  {
    id: 'custom',
    label: '自定义 (OpenAI 兼容)',
    vendor: '任意兼容端点 / 自建中转',
    baseUrl: 'https://',
    modelsPath: '/v1/models',
    note: '地址与各类路径都可以自己改; 视频默认按"提交 → 轮询"通用形状',
    types: {
      text: { shape: 'openai-chat', path: '/v1/chat/completions' },
      image: { shape: 'openai-image', path: '/v1/images/generations' },
      video: { shape: 'generic-task', submit: '/v1/videos', poll: '/v1/videos/{id}' },
    },
  },
]

/**
 * ★ 2026-10-12 **中国站**（用户给的测试 key 实测出来的）:
 *   · 中国站的接口是 **`https://api.agnes-ai.cn`**。
 *     ⚠️ 别把 `apihub.agnes-ai.cn` 当成"中国站的网关" —— 2026-10-12 实测(逐把 key 打三台 host 的 /v1/models):
 *         中国站 key → api.agnes-ai.cn **200**(5 个模型) / apihub.agnes-ai.cn **401 无效的令牌**
 *         国际站 key → api.agnes-ai.cn **401** / apihub.agnes-ai.com 200 / apihub.agnes-ai.cn **200**
 *       即 `apihub.agnes-ai.cn` 是**国际网关的另一个域名**(大陆可达的镜像), 它只认国际站的 key。
 *       (上一轮曾据此写成"中国站按租户分网关", 是**读错了对照** —— 已更正, 别再用那个说法。)
 *   · **两把 key 不通用**: 中国站的 key 打国际站 hub 会回 `401 Invalid token`, 反之亦然 ——
 *     所以单独作为一个平台让用户选, 而不是把用户的中国站 key 塞进国际站那个入口;
 *   · 模型清单也**不一样**(实测只有 5 个): 视频只有 **`agnes-video-2.5-flash`** ——
 *     用国际站的名字 `agnes-video-2.5` 会被 `503 model_not_found: …无可用渠道（distributor）` 全拒,
 *     **这正是客户"多重参考生成视频用不了"的第一现场**。
 *   shapes/paths 与国际站同一套(实测: 建任务 `POST /v1/videos`, 取结果 `GET /agnesapi?video_id=…&model_name=…`)。
 */
{
  const intl = API_PLATFORMS.find((p) => p.id === 'agnes')
  if (intl) {
    /**
     * ★ 2026-10-12 用户: "在选平台列表, 国际站和中国站要上下排布, 不要隔太开了"。
     *   原来是 `push`(排到整张榜的**最后**), 于是"国际站"在第 1 行、"中国站"在第 7 行,
     *   中间隔了火山/百炼/魔搭/硅基/自定义五家 —— 用户要对照着挑的时候得来回滚。
     *   改成**紧跟在国际站后面**插入(位置由 intl 的下标算, 不写死数字)。
     */
    API_PLATFORMS.splice(API_PLATFORMS.indexOf(intl) + 1, 0, {
      ...intl,
      id: 'agnes-cn',
      label: 'Agnes 中国站',
      vendor: 'Agnes AI · agnes-ai.cn',
      baseUrl: 'https://api.agnes-ai.cn',
      // 中国站的中文文档(实测 200) —— 国际站的 quickstart 在 agnes-ai.com, 别互相串
      docsUrl: 'https://www.agnes-ai.cn/zh-Hans/docs/quickstart',
      note: '站点: 中国站（官网 agnes-ai.cn · 控制台 platform.agnes-ai.cn · 接口 api.agnes-ai.cn）。'
        + '实测模型(2026-10-12): 视频 agnes-video-2.5-flash · 图片 agnes-image-2.1-flash / agnes-image-2.5-flash · '
        + '文本 agnes-2.5-flash / agnes-3.0-flash。⚠️ 没有 agnes-video-2.5（那是国际站的, 用它会 503 model_not_found）; '
        + '参考素材必须是「公网 http(s) URL」或「裸 base64」——带 data: 前缀会被判非法; '
        + '视频通道挤满时会回 video_queue_full / video_queue_unavailable, 隔几分钟重试即可（与余额、参数无关）',
    })
  }
}

function platformDef(id) {
  return API_PLATFORMS.find((p) => p.id === id) ?? API_PLATFORMS[API_PLATFORMS.length - 1]
}

/** 一条连接某类能力的形状定义 (以平台目录为默认) */
function typeDef(rec, kind) {
  return platformDef(rec.platform).types[kind] ?? null
}

function shapeOf(rec, kind) {
  return typeDef(rec, kind)?.shape ?? (kind === 'video' ? 'generic-task' : kind === 'image' ? 'openai-image' : 'openai-chat')
}

/** 凭模型名猜它属于哪一类 —— 只用于"拉取模型"时给建议, 用户可改 */
function guessKind(id) {
  const s = String(id || '').toLowerCase()
  // 先排除"不是生成模型"的一堆: 向量/重排/语音识别/语音合成/OCR/审核/翻译专用
  // (硅基流动这类聚合站一次返回上百个, 不排掉的话它们会被误当成"文字模型"塞进剧本卡下拉)
  if (/embedding|embed-|rerank|bge-|sentence|whisper|asr|tts|voice|speech|ocr|moderation|vision-embedding|sensevoice|cosyvoice/.test(s)) return ''
  // ⚠️ 别把厂商名当视频特征: MiniMax 既有对话模型(M1/M3)也有视频模型(Hailuo/video-01),
  //    所以这里只认"视频味儿"的词, 不认 minimax 本身。
  if (/seedance|veo|sora|kling|wan2|wanx|hailuo|minimax-video|video-01|vidu|pika|runway|luma|video|i2v|t2v|vace/.test(s)) return 'video'
  if (/seedream|seededit|flux|stable-diffusion|sd3|dall-e|gpt-image|qwen-image|kolors|cogview|wanx-v1|image|nano-banana|doubao-seedream/.test(s)) return 'image'
  if (/gpt|claude|gemini|qwen|glm|deepseek|moonshot|kimi|doubao|llama|mistral|yi-|chat|abab|agnes/.test(s)) return 'text'
  // 认不出的名字: 带这些通用后缀的通常是对话模型(pro/flash/turbo/instruct...)
  if (/(^|[-_.])(pro|flash|turbo|mini|instruct|chat|reason|thinking|4o|o1|o3)([-_.]|$)/.test(s)) return 'text'
  // 聚合站的 id 形如 "厂商/模型"(MiniMax/MiniMax-M3、Shanghai_AI_Laboratory/Intern-S2-Preview…),
  // 排除了上面那些"非生成模型"之后, 这类绝大多数是对话模型 → 兜底归到文字。
  // (这只是给用户在"拉取模型"里的**建议勾选**, 归错了可以手动改。)
  if (s.includes('/')) return 'text'
  return ''
}

/** 模型列表规范化: 数组 / 逗号 / 换行分隔 → 去空去重 */
function normModels(v) {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，\n]/) : []
  return [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))]
}

/** 路径规范化: 必须是 / 开头的绝对路径; 空值用默认 */
function normPath(v, dflt) {
  const s = String(v ?? '').trim()
  if (!s) return dflt
  return s.startsWith('/') ? s : `/${s}`
}

/** 连接里的三类配置规范化(只保留用户真的配了模型的类) */
function normTypes(input) {
  const out = {}
  for (const kind of API_KINDS) {
    const src = input && typeof input === 'object' ? input[kind] : null
    if (!src) continue
    const models = normModels(src.models)
    if (!models.length) continue
    if (kind === 'video') {
      out.video = { models, submit: src.submit ? normPath(src.submit) : undefined, poll: src.poll ? normPath(src.poll) : undefined }
    } else {
      out[kind] = { models, path: src.path ? normPath(src.path) : undefined }
    }
  }
  return out
}

/** v1 老记录(只有 videoModels) → v2 连接 */
function migrateV1(p) {
  const prefix = String(p.apiPrefix || '').replace(/\/+$/, '')
  const vpath = normPath(p.videoPath, '/videos')
  const models = normModels(p.videoModels)
  const types = {}
  if (models.length) {
    types.video = { models, submit: normPath(`${prefix}${vpath}`), poll: normPath(`${prefix}${vpath}/{id}`) }
  }
  // 老记录的平台按域名认一下, 认得出就挂到对应平台(否则保持"自定义")
  const host = String(p.baseUrl || '')
  const platform = /volces\.com|volcengine/.test(host) ? 'ark'
    : /dashscope|aliyuncs/.test(host) ? 'bailian'
      : /modelscope/.test(host) ? 'modelscope'
        : 'custom'
  return {
    id: p.id || randomUUID(),
    platform,
    name: p.name || 'API',
    baseUrl: String(p.baseUrl || '').replace(/\/+$/, ''),
    apiKey: p.apiKey || '',
    enabled: p.enabled !== false,
    note: p.note,
    createdAt: p.createdAt || Date.now(),
    types,
  }
}

function maskKey(key) {
  if (!key) return '(未填 key)'
  if (key.length <= 8) return '****'
  return `****${key.slice(-4)}`
}

class ApiStore {
  constructor(file) {
    this.file = file
    this.data = { version: 2, connections: [] }
    /** 选择"不保存在本地"的密钥只活在本进程内存里，重启即失效 */
    this.sessionKeys = new Map()
    this.load()
  }
  load() {
    try {
      if (!fs.existsSync(this.file)) return
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8'))
      if (parsed && Array.isArray(parsed.connections)) {
        this.data.version = 2
        this.data.connections = parsed.connections
        // 平台目录里已经不提供的类型(例: 魔搭现在没有视频生成接口)留着只会让用户配出一条跑不通的连接
        for (const c of this.data.connections) {
          const def = platformDef(c.platform)
          for (const k of Object.keys(c.types || {})) {
            if (!def.types[k]) {
              log(`清理连接「${c.name}」的 ${k} 类模型: 该平台已不提供这一类`)
              delete c.types[k]
            }
          }
        }
        /**
         * ★ 2026-10-12: 老默认连接名跟着平台改名一起归位。
         *   "Agnes 聚合" / "Agnes AI" / "Agnes AI (免费)" 都是**当年系统按平台名自动填的默认值**,
         *   平台名改成「Agnes 国际站」之后, 清单里就会出现"名字叫聚合、旁边却标注国际站"这种自相矛盾的显示 ——
         *   而用户最需要一眼看出自己这条是哪個站的。
         *   只改**与老默认名逐字相同**的那些; 用户自己起过的名字一律不碰。
         */
        const OLD_AGNES_DEFAULTS = new Set(['Agnes 聚合', 'Agnes AI', 'Agnes AI (免费)'])
        let renamed = 0
        for (const c of this.data.connections) {
          if (c.platform === 'agnes' && OLD_AGNES_DEFAULTS.has(String(c.name || ''))) {
            c.name = platformDef(c.platform).label
            renamed += 1
          }
        }
        if (renamed) {
          log(`把 ${renamed} 条连接的旧默认名归一到新平台名(Agnes 国际站)`)
          this.save()
        }
        return
      }
      // v1(只有 providers[].videoModels) → v2 连接, 平滑迁移, 不丢配置
      if (parsed && Array.isArray(parsed.providers)) {
        this.data.connections = parsed.providers.map(migrateV1)
        this.save()
        log(`云端 API 配置已迁移到 v2: ${this.data.connections.length} 条连接`)
      }
    } catch (e) {
      log('读取 .api-store.json 失败, 使用空存储:', e.message)
    }
  }
  save() {
    try {
      // 防"双实例互相覆盖": 本进程内存里是空的、而磁盘上还有连接 → 说明另一实例(或上次运行)
      // 已经写过配置, 这次写会把用户填好的 key 抹掉。宁可只读也不覆盖(只记日志)。
      if (this.data.connections.length === 0 && fs.existsSync(this.file)) {
        try {
          const cur = JSON.parse(fs.readFileSync(this.file, 'utf-8'))
          const n = Array.isArray(cur?.connections) ? cur.connections.length : 0
          if (n > 0) {
            log(`拒绝用空配置覆盖磁盘上的 ${n} 条连接(疑似多实例同时运行), 本次不写入`)
            return
          }
        } catch { /* 磁盘文件坏了 → 允许写入重建 */ }
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8')
      fs.renameSync(tmp, this.file)
    } catch (e) {
      log('写入 .api-store.json 失败:', e.message)
    }
  }
  getById(id) { return this.data.connections.find((p) => p.id === id) }
  keyOf(rec) {
    if (!rec) return ''
    return rec.apiKey || this.sessionKeys.get(rec.id) || ''
  }
  /** 旧接口保留: /agnes 代理兜底取 key(剧本卡老链路暂未切到新框架) */
  getKeyByPlatform(platform) {
    /**
     * ★ 2026-10-12 审计 §2.2: 原来是 `x.platform === platform || x.types?.text` —— 那个 `||` 让
     *   **任意带 text 能力**的连接都能命中(豆包 / DeepSeek / 自定义…)。于是"用户登记过随便一条
     *   text 连接、但没登记 agnes"时, **别家的 key 会被当成 agnes 的 key**, 以 `Authorization: Bearer`
     *   明文发给 apihub.agnes-ai.com —— 属凭据外泄。
     *   现在只认**平台精确匹配**; 如果哪天真需要"文本兜底", 必须另设显式开关, 不许再用隐式 `||`。
     */
    const p = this.data.connections.find((x) => x.platform === platform && x.enabled && this.keyOf(x))
    return p ? this.keyOf(p) : ''
  }
  /**
   * 按平台取**整条连接**(不只是 key)。
   * ★ 2026-10-12 两站分开之后必须有这个: Agnes 国际站与中国站是**两个平台、两个 hub**
   *   (`apihub.agnes-ai.com` vs `api.agnes-ai.cn`), 只拿 key 拼不出请求 —— 必须连 baseUrl 一起带上,
   *   否则就会把中国站的 key 发到国际站的地址上(那是把凭据发错门, 会被回 401 无效令牌)。
   */
  getConnByPlatform(platform) {
    return this.data.connections.find((x) => x.platform === platform && x.enabled && this.keyOf(x))
  }
  create(input) {
    const platform = API_PLATFORMS.some((t) => t.id === input.platform) ? input.platform : 'custom'
    const saveKeyLocal = input.saveKeyLocal !== false
    const rec = {
      id: randomUUID(),
      name: input.name || platformDef(platform).label,
      platform,
      baseUrl: String(input.baseUrl || '').replace(/\/+$/, ''),
      apiKey: saveKeyLocal ? (input.apiKey || '') : '',
      saveKeyLocal,
      enabled: true,
      note: input.note,
      types: normTypes(input.types),
      createdAt: Date.now(),
    }
    if (!saveKeyLocal && input.apiKey) this.sessionKeys.set(rec.id, input.apiKey)
    this.data.connections.push(rec)
    this.save()
    return rec
  }
  update(id, patch) {
    const rec = this.getById(id)
    if (!rec) return null
    if (patch.name !== undefined) rec.name = patch.name
    if (patch.platform !== undefined && API_PLATFORMS.some((t) => t.id === patch.platform)) rec.platform = patch.platform
    if (patch.baseUrl !== undefined) rec.baseUrl = String(patch.baseUrl).replace(/\/+$/, '')
    if (patch.apiKey) {
      const saveKeyLocal = patch.saveKeyLocal !== undefined ? patch.saveKeyLocal !== false : rec.saveKeyLocal !== false
      rec.saveKeyLocal = saveKeyLocal
      if (saveKeyLocal) {
        rec.apiKey = patch.apiKey
        this.sessionKeys.delete(rec.id)
      } else {
        rec.apiKey = ''
        this.sessionKeys.set(rec.id, patch.apiKey)
      }
    } else if (patch.saveKeyLocal !== undefined && patch.saveKeyLocal !== (rec.saveKeyLocal !== false)) {
      rec.saveKeyLocal = patch.saveKeyLocal !== false
      if (rec.saveKeyLocal) {
        const key = this.sessionKeys.get(rec.id)
        if (key) rec.apiKey = key
        this.sessionKeys.delete(rec.id)
      } else if (rec.apiKey) {
        this.sessionKeys.set(rec.id, rec.apiKey)
        rec.apiKey = ''
      }
    }
    if (patch.enabled !== undefined) rec.enabled = patch.enabled
    if (patch.note !== undefined) rec.note = patch.note
    // types 是"按类整块替换": 前端回写哪几类就覆盖哪几类; dropTypes 用于清空某一类
    if (patch.types !== undefined) rec.types = { ...rec.types, ...normTypes(patch.types) }
    if (Array.isArray(patch.dropTypes)) for (const k of patch.dropTypes) delete rec.types[k]
    this.save()
    return rec
  }
  remove(id) {
    const before = this.data.connections.length
    this.data.connections = this.data.connections.filter((p) => p.id !== id)
    const changed = this.data.connections.length !== before
    if (changed) {
      this.sessionKeys.delete(id)
      this.save()
    }
    return changed
  }
  safeList() {
    return this.data.connections.map((p) => {
      const { apiKey, ...rest } = p
      const key = this.keyOf(p)
      return { ...rest, keyPreview: maskKey(key), hasKey: !!key, keyPersisted: !!apiKey, imageEdit: imageEditInfo(p) }
    })
  }
}

function safeOne(rec) {
  const { apiKey, ...rest } = rec
  const key = apiKeyOf(rec)
  return { ...rest, keyPreview: maskKey(key), hasKey: !!key, keyPersisted: !!apiKey, imageEdit: imageEditInfo(rec) }
}

/**
 * 给前端看的"这个平台改图怎么传参考图"(前端据此提示"只能吃第一张")。
 * 注意 extraIfModel 是正则, 不能直接进 JSON → 折成 supportsMulti / multiNote 两个字段。
 */
function imageEditInfo(rec) {
  const e = typeDef(rec, 'image')?.edit
  if (!e) return null
  const supportsMulti = !!e.array || Array.isArray(e.extraFields)
  return {
    field: e.field,
    array: !!e.array,
    supportsMulti,
    multiNote: Array.isArray(e.extraFields)
      ? '多张参考图只在 Qwen/Qwen-Image-Edit-2509 这类支持 image2/image3 的模型上生效'
      : undefined,
  }
}

function loadEnvKey() {
  try {
    const txt = readEnvFile(P.envCandidates)
    if (!txt) return ''
    const m = txt.match(/^\s*AGNES_API_KEY\s*=\s*(.+)\s*$/m)
    return m ? m[1].trim() : ''
  } catch { return '' }
}

let envAgnesKey = ''
/** @type {ApiStore} */
let store = null

function apiKeyOf(rec) {
  return rec?.apiKey || store?.keyOf(rec) || ''
}

/** 装载 Provider 存储。路径随运行模式变化, 所以延迟到 startServer() 里执行。 */
function initStore() {
  envAgnesKey = loadEnvKey()
  store = new ApiStore(P.apiStoreFile)
}

/** baseUrl + 绝对路径 拼接(避免出现 //) */
function joinUrl(base, p) {
  const b = String(base || '').replace(/\/+$/, '')
  const s = String(p || '')
  return `${b}${s.startsWith('/') ? s : `/${s}`}`
}

function authHeaders(rec) {
  const key = apiKeyOf(rec)
  /**
   * AutoDL.Art 的 ComfyUI 分组 token 是**明文** Authorization（实测不带 Bearer）。
   * 只对 baseUrl 指向 autodl.art 的 H3 云端算力生效；旧自建 h3-cloud 仍走 Bearer。
   */
  if (rec.platform === 'h3-cloud' && /autodl\.art/i.test(String(rec.baseUrl || ''))) {
    return { Authorization: key, 'Content-Type': 'application/json', Accept: 'application/json' }
  }
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' }
}

/**
 * 这个平台的"模型清单"接口是不是**公开**的(不认 key 也给数据)?
 *
 * 为什么要问: 实测 Agnes 的 GET /v1/models 拿假 key(甚至完全不带 Authorization)都返回 200 + 完整清单。
 * 于是"拉取模型成功"根本不能证明 key 可用 —— 用户看到"连通 · 发现 12 个模型", 点生成却每次都
 * 401 Invalid token, 报的现象就是"能抓模型但生成不了"。这类平台必须再真调一次才能下结论。
 * 反向也成立: 清单接口本身要鉴权的平台(实测: 硅基流动/火山 会 401), 200 就已经证明 key 能用了,
 * 不用多花额度 —— 所以这里先**动态探一次**(魔搭也属于匿名可取清单的那一类, 实测同样会走到真调)。
 */
async function modelsPathIsPublic(rec) {
  try {
    const url = joinUrl(rec.baseUrl, platformDef(rec.platform).modelsPath || '/v1/models')
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
    return r.ok
  } catch { return false }
}

/**
 * 带鉴权的**最小真实调用** —— 只回答一个问题: 这个 key 到底能不能用来生成。
 * 优先用文字类(最便宜); 没有文字类就花一次最小出图; 都没有就不猜(交给生成时暴露)。
 */
async function verifyKeyForReal(rec, models) {
  const list = (models ?? []).map(String)
  // 挑一个"最便宜/最可能免费"的模型试跑: 聚合站的清单里往往把 pro/alpha 排在最前面(要额度),
  // 拿它去试跑会因为**额度不足**回 403, 被误判成"key 无效"(实测踩到)。
  const cheapFirst = (kind) => list.find((m) => guessKind(m) === kind && /flash|mini|turbo|lite|free/i.test(m))
    ?? list.find((m) => guessKind(m) === kind) ?? list[0] ?? ''
  const pickText = cheapFirst('text')
  const pickImg = cheapFirst('image')
  /** 只有"鉴权错"才算 key 坏 —— 模型名不对/额度不足/没开通模型 都不能说 key 无效(会误报) */
  const looksLikeAuthError = (status, body) =>
    status === 401
    || (status === 403 && !/quota|balance|billing|insufficient|credit|余额|额度|欠费|充值/i.test(body || ''))
    || /invalid[\s_-]*(token|api[\s_-]*key)|unauthor|authentication|api[\s_-]*key.*(invalid|incorrect|not)/i.test(body || '')
  /** 额度/计费类错误: key 是好的, 但这个账号没钱/没订阅 */
  const looksLikeQuota = (body) => /quota|balance|billing|insufficient|credit|余额|额度|欠费|充值/i.test(body || '')
  const textPath = rec.types?.text?.path || typeDef(rec, 'text')?.path
  const imgDef = typeDef(rec, 'image')
  try {
    if (textPath && pickText) {
      const r = await fetch(joinUrl(rec.baseUrl, textPath), {
        method: 'POST',
        headers: authHeaders(rec),
        body: JSON.stringify({ model: pickText, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(40_000),
      })
      const t = await r.text().catch(() => '')
      if (r.ok) return { ok: true, verified: 'text', detail: `key 真实可用(已用 ${pickText} 试跑一次最小对话)` }
      if (looksLikeQuota(t)) return { ok: true, verified: '', detail: `连接正常，但额度不够（HTTP ${r.status}）｜怎么办：去平台充值或开通套餐｜平台原话：${t.slice(0, 120)}` }
      if (looksLikeAuthError(r.status, t)) return { ok: false, detail: authFailMsg('调用', r.status, t) }
      return { ok: true, verified: '', detail: `key 能用，但试跑报错（HTTP ${r.status}）｜怎么办：从平台文档复制模型名` }
    }
    if (imgDef && pickImg) {
      const r = await fetch(joinUrl(rec.baseUrl, rec.types?.image?.path || imgDef.path || '/v1/images/generations'), {
        method: 'POST',
        headers: authHeaders(rec),
        body: JSON.stringify({ model: pickImg, prompt: 'ping', n: 1, size: '1024x1024' }),
        signal: AbortSignal.timeout(120_000),
      })
      const t = await r.text().catch(() => '')
      if (r.ok) return { ok: true, verified: 'image', detail: `key 真实可用(已用它试跑一次最小出图)` }
      if (looksLikeQuota(t)) return { ok: true, verified: '', detail: `连接正常，但额度不够（HTTP ${r.status}）｜怎么办：去平台充值或开通套餐｜平台原话：${t.slice(0, 120)}` }
      if (looksLikeAuthError(r.status, t)) return { ok: false, detail: authFailMsg('出图', r.status, t) }
      return { ok: true, verified: '', detail: `key 能用，但试跑出图报错（HTTP ${r.status}）｜怎么办：从平台文档复制模型名` }
    }
  } catch (e) {
    return { ok: true, verified: '', detail: `清单可用, 但真实校验没跑通(${e instanceof Error ? e.message : String(e)}) —— 以生成结果为准` }
  }
  return { ok: true, verified: '', detail: '' }
}

  function authFailMsg(what, status, body) {
    // 以前这里解释了半句"清单接口不校验 key" —— 用户不需要知道为什么, 只需要知道去换 key
    return `${what}失败：key 无效（HTTP ${status}）`
      + '｜怎么办：去平台换一把新 key'
      + `｜平台原话：${String(body || '').slice(0, 120)}`
  }

/**
 * 「模型清单」可能不在平台默认的那个路径上 —— 见下面 runProbe 的现场说明。
 * 按"最可能 → 兜底"排一串候选, 逐个试。
 */
function modelsPathCandidates(rec) {
  const def = platformDef(rec.platform)
  const out = []
  const push = (p) => { const s = String(p || '').trim(); if (s && !out.includes(s)) out.push(s) }
  push(def.modelsPath)
  /**
   * ★ 2026-10-05 用户现场(智谱 BigModel, 平台选的"自定义(OpenAI 兼容)"):
   *   base = https://open.bigmodel.cn/api/paas/v4, 对话路径被填成 /chat/completions,
   *   而 `custom` 平台默认的清单路径是 "/v1/models" → 拼出来 "…/v4/v1/models" → HTTP 404。
   *   后果不只是"拉不到模型": 「测试连接」也走这条, 于是面板上显示"连接失败",
   *   可实际上 key 与对话接口都是好的(实测 glm-4.7 回 200) ——
   *   用户看到的就是"这个平台连不上", 完全查不出原因。
   * 修法: 从"用户实际填的对话路径"推出清单路径(把结尾的 /chat/completions 换成 /models),
   *   再兜底试 "/models" 与 "/v1/models"。哪家端点前缀怎么摆都不怕。
   */
  const textPath = rec?.types?.text?.path || def.types?.text?.path || ''
  const m = /^(.*?)\/?(?:chat\/completions|completions)$/i.exec(String(textPath))
  if (m) push((m[1] || '') + '/models')
  push('/models')
  push('/v1/models')
  return out
}

/** 拉模型清单 GET {base}{modelsPath}; 平台不给 /models 时返回 ok 但清单为空(手填即可) */
async function runProbe(rec) {
  const def = platformDef(rec.platform)
  const candidates = modelsPathCandidates(rec)
  /** 命中的那条(响应体在这里就解析掉 —— Response 的 body 只能读一次) */
  let hit = null
  /** 全都没命中时拿最后一条报错(401/403 优先, 那是"key 无效"的确定结论) */
  let lastErr = { status: 0, txt: '', url: joinUrl(rec.baseUrl, candidates[0]) }
  for (const p of candidates) {
    const u = joinUrl(rec.baseUrl, p)
    try {
      const r = await fetch(u, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKeyOf(rec)}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      })
      const body = await r.text().catch(() => '')
      if (r.ok) {
        let models = []
        try {
          const j = JSON.parse(body)
          if (Array.isArray(j.data)) models = j.data.map((m) => m.id).filter(Boolean)
          else if (Array.isArray(j.models)) models = j.models.map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean)
        } catch { /* 不是 JSON(比如返回了个网页) → 当成"没有清单", 仍算连得上 */ }
        hit = { status: r.status, models, url: u }
        break
      }
      lastErr = { status: r.status, txt: body, url: u }
      // 401/403 是真的"key 不对", 换路径也白搭 → 立刻收手
      if (r.status === 401 || r.status === 403) break
    } catch (e) {
      lastErr = { status: 0, txt: e instanceof Error ? e.message : String(e), url: u }
    }
  }
  try {
    if (!hit) {
      // 401/403 说人话: 这一步就是"key 能不能用"的判定, 别只甩一个英文 HTTP 码
      const isAuth = lastErr.status === 401 || lastErr.status === 403
      return {
        ok: false, status: lastErr.status,
          detail: isAuth
            ? `连接失败：key 无效（HTTP ${lastErr.status}）｜怎么办：去平台换一把新 key｜平台原话：${String(lastErr.txt).slice(0, 120)}`
            : friendlyCloudError({ action: '连接测试', status: lastErr.status, body: lastErr.txt, url: lastErr.url }),
      }
    }
    const models = hit.models
    // 「能列出模型」≠「key 能用」—— 只在这家清单是公开接口时才需要额外验一次(否则 200 已经证明 key 可用)
    const mustVerify = def.publicModels === true || (models.length > 0 && await modelsPathIsPublic(rec))
    if (mustVerify && models.length > 0) {
      const v = await verifyKeyForReal(rec, models)
      if (!v.ok) return { ok: false, status: 200, publicModels: true, models: [], detail: v.detail }
      return {
        ok: true, status: hit.status, models: models.slice(0, 400).map(String),
        publicModels: true, verified: v.verified, verifyDetail: v.detail,
      }
    }
    return { ok: true, status: hit.status, models: models.slice(0, 400).map(String) }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

/** 模型清单 → 归类建议(只建议, 用户可改) */
function groupSuggest(models) {
  const suggest = { text: [], image: [], video: [], unknown: [] }
  for (const mid of models ?? []) {
    const k = guessKind(mid)
    ;(suggest[k] || suggest.unknown).push(String(mid))
  }
  return suggest
}

async function handleProviders(req, res) {
  const url = (req.url ?? '').split('?')[0]
  const rest = url.slice('/api/providers'.length)
  const method = (req.method ?? 'GET').toUpperCase()

  // 平台目录: 前端"第一步选平台"的数据源(不含任何密钥)
  if (url === '/api/api-platforms') {
    return sendJson(res, 200, { ok: true, platforms: API_PLATFORMS, kinds: API_KINDS })
  }

  if (method === 'GET' && (rest === '' || rest === '/')) {
    return sendJson(res, 200, { ok: true, providers: store.safeList() })
  }
  if (method === 'POST' && (rest === '' || rest === '/')) {
    const body = await readBody(req, res)
      if (!body.baseUrl || !/^https?:\/\//.test(body.baseUrl)) {
        return sendJson(res, 400, { ok: false, msg: '保存失败：接口地址不对｜怎么办：从平台文档整段复制「Base URL」' })
      }
      if (!body.apiKey) return sendJson(res, 400, { ok: false, msg: '保存失败：还没填 API Key｜怎么办：去平台「密钥」页面复制一把' })
    // 兜底: 一条没有任何模型的连接是"用不了"的(实测用户勾完模型没点「加入勾选」就保存, 面板显示 0 个模型)
    //   —— 前端已经会拦并自动带上勾选项, 这里再挡一道, 保证任何客户端都建不出空连接。
    //   (编辑路径不受影响: 清空某一类是合法操作, 走 PUT。)
      if (!Object.keys(normTypes(body.types)).length) {
        return sendJson(res, 400, { ok: false, msg: '保存失败：这条连接还没选模型｜怎么办：点「拉取模型清单」勾几个' })
      }
    const rec = store.create(body)
    return sendJson(res, 200, { ok: true, provider: safeOne(rec) })
  }

  // 草稿探测(还没保存连接时也能"拉取模型"): POST /api/providers/probe {platform, baseUrl, apiKey}
  if (method === 'POST' && rest === '/probe') {
    const body = await readBody(req, res)
    const tmp = {
      platform: body.platform || 'custom',
      baseUrl: String(body.baseUrl || '').replace(/\/+$/, ''),
      apiKey: body.apiKey || '',
    }
    if (!/^https?:\/\//.test(tmp.baseUrl)) return sendJson(res, 400, { ok: false, detail: '接口地址要写成 http:// 或 https:// 开头（从平台文档里整段复制 Base URL）' })
    if (!tmp.apiKey) return sendJson(res, 400, { ok: false, detail: '还没填 API Key：去平台的「API Key / 密钥」页面复制一把再填进来' })
    const r = await runProbe(tmp)
    if (!r.ok) return sendJson(res, 200, { ok: false, detail: r.detail ?? `连接失败 HTTP ${r.status ?? '?'}` })
    return sendJson(res, 200, {
      ok: true, models: r.models, suggest: groupSuggest(r.models),
      publicModels: !!r.publicModels, verifyDetail: r.verifyDetail ?? '',
      detail: (r.models?.length ?? 0) > 0
        ? `连通 · 发现 ${r.models.length} 个模型${r.verifyDetail ? ` · ${r.verifyDetail}` : ''}`
        : '连通 · 该平台不提供模型清单, 请手动填写模型名',
    })
  }

  const m = rest.match(/^\/([^/]+)(\/test|\/probe-models)?$/)
  if (!m) return sendJson(res, 404, { ok: false, msg: 'not found' })
  const id = m[1]
  const isTest = m[2] === '/test'
  /** 「检测哪些模型真能用」 —— 见下面 POST 处理块(2026-10-03 用户实报"拉取全部也生成失败") */
  const isProbeModels = m[2] === '/probe-models'

  if (method === 'PUT') {
    const rec = store.update(id, await readBody(req, res))
    if (!rec) return sendJson(res, 404, { ok: false, msg: '这条连接已经不在了（可能刚被删掉）｜怎么办：关掉面板重新打开一次「API」' })
    return sendJson(res, 200, { ok: true, provider: safeOne(rec) })
  }
  if (method === 'DELETE') {
    if (!store.remove(id)) return sendJson(res, 404, { ok: false, msg: '这条连接已经不在了（可能已经删过一次）｜怎么办：关掉面板重新打开一次「API」' })
    return sendJson(res, 200, { ok: true })
  }
  if (method === 'POST' && isTest) {
    const rec = store.getById(id)
    if (!rec) return sendJson(res, 404, { ok: false, msg: '这条连接已经不在了（可能刚被删掉）｜怎么办：关掉面板重新打开一次「API」' })
    if (!apiKeyOf(rec)) return sendJson(res, 400, { ok: false, msg: '这条连接还没填 key｜怎么办：点它的「编辑」，把平台上的 key 粘进去' })
    const r = await runProbe(rec)
    // 拉回来的模型按名字给"归类建议"(只建议, 用户可改)
    const suggest = groupSuggest(r.models)
    if (r.ok) {
      return sendJson(res, 200, {
        ok: true, models: r.models, suggest,
        publicModels: !!r.publicModels, verifyDetail: r.verifyDetail ?? '',
        detail: (r.models?.length ?? 0) > 0
          ? `连通 · 发现 ${r.models.length} 个模型${r.verifyDetail ? ` · ${r.verifyDetail}` : ''}`
          : '连通 · 该平台不提供模型清单, 请手动填写模型名',
      })
    }
    return sendJson(res, 200, { ok: false, detail: r.detail ?? `连接失败 HTTP ${r.status ?? '?'}` })
  }
  /**
   * 「检测哪些模型真能用」 POST /api/providers/:id/probe-models  { kind, models[] }
   *
   * ⚠️ 2026-10-03 用户实报: "开通界面的模型名字和真正的接口名字其实是不对应的…而且全部拉取后, 再生成也是失败的"。
   *   实测(用用户本机的火山 key): `GET /api/v3/models` 返回的是**135 个全量目录**(含 2024 年的老豆包),
   *   而其中绝大多数在他账号上**根本调不通**; 他开通的那个模型在开通页叫「DeepSeek-V4-Flash正式版」,
   *   接口 ID 却是 `deepseek-v4-flash-ga-260731`(`-ga-` = 正式版), 他猜的 `deepseek-v4-flash-260425`
   *   是另一个版本 → 404 InvalidEndpointOrModel.NotFound。
   *   → 光"拉取清单"没法解决, 必须**替用户试一次**才知道哪个能用。文字类一次 max_tokens=1, 花费可忽略;
   *     图片/视频要真出图(会花钱) → 这里不检测, 由前端说明。
   */
  if (method === 'POST' && isProbeModels) {
    const rec = store.getById(id)
    if (!rec) return sendJson(res, 404, { ok: false, msg: '这条连接已经不在了（可能刚被删掉）｜怎么办：关掉面板重新打开一次「API」' })
    if (!apiKeyOf(rec)) return sendJson(res, 400, { ok: false, msg: '这条连接还没填 key｜怎么办：点它的「编辑」，把平台上的 key 粘进去' })
    const body = await readBody(req, res)
    const kind = String(body?.kind || 'text')
    const list = (Array.isArray(body?.models) ? body.models : []).map(String).filter(Boolean).slice(0, 220)
    if (!list.length) return sendJson(res, 400, { ok: false, msg: '没有要检测的模型' })
    if (kind !== 'text') {
      return sendJson(res, 200, { ok: true, probed: 0, usable: 0, results: [], detail: '图片/视频要真的出一次图才知道能不能用（会花钱），所以这里只自动检测文字模型' })
    }
    if (shapeOf(rec, 'text') !== 'openai-chat') {
      return sendJson(res, 200, { ok: true, probed: 0, usable: 0, results: [], detail: '这家平台的文字接口不是 OpenAI 兼容形状，没法自动检测' })
    }
    const path = rec.types?.text?.path || typeDef(rec, 'text')?.path || '/v1/chat/completions'
    const results = []
    for (const model of list) {
      try {
        const out = await postWithBusyRetry({
          url: joinUrl(rec.baseUrl, path),
          headers: authHeaders(rec),
          body: { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
          timeoutMs: 20000,
          logTag: 'probe-model',
        })
        if (out.status >= 200 && out.status < 300) {
          results.push({ model, status: 'ok', detail: '可用' })
          continue
        }
        let code = ''
        let msg = ''
        try { const j = JSON.parse(out.text); code = String(j?.error?.code || ''); msg = String(j?.error?.message || '') } catch { msg = String(out.text || '').slice(0, 120) }
        const both = `${code} ${msg}`
        const status = /not\s*open|ModelNotOpen|未开通/i.test(both) ? 'not-open'
          : /InvalidEndpointOrModel|NotFound|does not exist|不存在的模型/i.test(both) ? 'not-found'
            : out.status === 401 ? 'auth'
              : /quota|balance|额度|余额|欠费|arrears/i.test(both) ? 'quota'
                : 'error'
        results.push({ model, status, http: out.status, detail: code || msg.slice(0, 90) })
      } catch (e) {
        results.push({ model, status: 'error', detail: String(e?.message ?? e).slice(0, 90) })
      }
    }
    const usable = results.filter((r) => r.status === 'ok').length
    return sendJson(res, 200, {
      ok: true, probed: results.length, usable, results,
      detail: usable
        ? `${results.length} 个里 ${usable} 个现在就能用（其余：未开通 ${results.filter((r) => r.status === 'not-open').length} / 名字不对 ${results.filter((r) => r.status === 'not-found').length}）`
        : `${results.length} 个一个都用不了 —— 去平台的「开通管理」把要用的模型开通（火山还要求账户有余额/资源包）`,
    })
  }
  return sendJson(res, 405, { ok: false, msg: 'method not allowed' })
}

// ---------------------------------------------------------------- 云端视频任务
// 提交(POST submit) → 自适应解析(同步出 URL / task_id 轮询) → 前端轮询 status 取产物 URL。
// 明文 key 一直在服务端, 不下发。
//
// ⚠️ 2026-09-18 重做 (用户要求"全部修好"): 任务态**落盘 + 重启后续查**。
//   旧实现把任务放在内存 Map 里, 程序一重启/崩溃 → 前端只能收到"这个任务查不到了",
//   而平台那边可能已经出片 —— 用户白等、白花钱。现在:
//     · 每条任务(含平台侧 id/提交参数)写 data/cloud-tasks.json (防抖落盘);
//     · 重启时把 status=running 的任务**恢复轮询**(平台侧 id 还在, 完全能续上);
//     · 出片后**服务端自己把视频落进 data/assets**, 并登记成"待认领", 前端启动时
//       拉回去补进生成历史 + 弹一句提示(哪怕当时程序是关着的)。
//   超时也从 10 分钟放宽到 30 分钟, 且超时只标状态、不丢任务记录(还能手动再看)。
const cloudVideoTasks = new Map()   // id → {id,status,url,error,abort,createdAt,...}
const CLOUD_VIDEO_TIMEOUT_MS = 30 * 60 * 1000
const CLOUD_TASKS_FILE = () => path.join(P.dataDir, 'cloud-tasks.json')

function loadCloudTasks() {
  try {
    const f = CLOUD_TASKS_FILE()
    if (!fs.existsSync(f)) return []
    const arr = JSON.parse(fs.readFileSync(f, 'utf-8'))
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

let cloudTasksSaveTimer = null
function saveCloudTasks() {
  if (cloudTasksSaveTimer) return
  cloudTasksSaveTimer = setTimeout(() => {
    cloudTasksSaveTimer = null
    try {
      const dir = P.dataDir
      fs.mkdirSync(dir, { recursive: true })
      const f = CLOUD_TASKS_FILE()
      const tmp = `${f}.tmp`
      // 只存"还能用得上"的: 最近 24 小时, 且不含 abort 这类瞬时字段
      const arr = [...cloudVideoTasks.values()]
        .filter((t) => Date.now() - (t.createdAt || 0) < 24 * 3600_000)
        .map((t) => ({
           id: t.id, status: t.status, url: t.url, error: t.error,
           createdAt: t.createdAt, finishedAt: t.finishedAt || 0,
           providerId: t.providerId, model: t.model, prompt: t.prompt,
           remoteId: t.remoteId || '', elapsed: t.elapsed || 0,
           savedPath: t.savedPath || '', claimed: !!t.claimed,
           /**
            * ⚠️ 2026-09-23: nodeId / requestedSeconds 必须一起落盘 ——
            *   这里以前是**白名单**(上面那几个字段之外的都丢), 于是"用户关程序后云端出片"
            *   那条任务重启后不知道属于哪张卡, 只能塞进历史, 卡片上仍是空的(用户反馈的"会丢失")。
            */
           nodeId: t.nodeId || '', requestedSeconds: t.requestedSeconds ?? undefined,
         }))
      fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf-8')
      fs.renameSync(tmp, f)
    } catch (e) {
      log('[cloud-video] 任务落盘失败(不影响生成):', e?.message ?? e)
    }
  }, 800)
  if (cloudTasksSaveTimer.unref) cloudTasksSaveTimer.unref()
}

/** 出片后由服务端自己把远端视频落到 data/assets (程序关着也能保住产物) */
async function saveCloudVideoToAssets(task) {
  if (!task?.url || task.savedPath) return
  try {
    const r = await fetch(task.url, { signal: AbortSignal.timeout(120000) })
    /**
     * ★ 2026-10-30（用户: "云端也自动落盘到本地，素材问题是底线"）:
     *   以前这里 `return` 就算了 —— 那一次没下下来，任务里 savedPath 永远是空，
     *   前端再失败就只剩一个会过期的链接。现在一律进持久重试队列，服务端自己接着试。
     */
    if (!r.ok) { localizeQueueAdd(task.url, `下载失败 HTTP ${r.status}`); return }
    const buf = Buffer.from(await r.arrayBuffer())
    if (!buf.length) { localizeQueueAdd(task.url, '远端返回空文件'); return }
    if (buf.length > 512 * 1024 * 1024) {
      log(`[cloud-video] 产物 ${(buf.length / 1073741824).toFixed(2)}GB 超过 512MB 上限，未落盘（可在设置里调大）`)
      return
    }
    const ext = /\.webm/i.test(task.url) ? 'webm' : 'mp4'
    const name = `${createHash('sha1').update(buf).digest('hex')}.${ext}`
    /** 云端视频 → 落到"视频"那个目录(没配置就是默认 <数据目录>/assets) */
    const f = assetPathFor(name)
    if (!fs.existsSync(f)) fs.writeFileSync(f, buf)
    task.savedPath = `/api/assets/file?name=${encodeURIComponent(name)}`
    log(`[cloud-video] 已把云端产物落到本地: ${name} (${(buf.length / 1048576).toFixed(1)}MB)`)
  } catch (e) {
    log('[cloud-video] 保存云端产物失败(结果链接仍在, 已排入落盘重试队列):', e?.message ?? e)
    localizeQueueAdd(task.url, String(e?.message ?? e))
  } finally {
    saveCloudTasks()
  }
}

/** 递归从响应体里提取第一个视频 URL (各平台字段形状不一) */
function extractVideoUrl(j, depth = 0) {
  if (!j || typeof j !== 'object' || depth > 5) return ''
  // 明确是视频字段的直接取
  if (typeof j.video_url === 'string' && j.video_url) return j.video_url
  if (typeof j.videoUrl === 'string' && j.videoUrl) return j.videoUrl
  if (typeof j.video === 'string' && /^https?:\/\/|^\//.test(j.video)) return j.video
  // ⚠️ 火山方舟(Ark)的任务结果长这样: {"status":"succeeded","content":{"video_url":"…","last_frame_url":"…"}}
  //    —— 视频在 content 里, 而 content 以前不在遍历名单里, 于是任务明明成功了却报
  //    "任务已完成但未识别到视频 URL"(用户看到的就是生成不了)。这里改成: 遍历本层所有键,
  //    "视频味儿"的键优先, 封面/首帧/音频/遮罩这类键直接跳过(否则会误抓 last_frame_url 这张图)。
  const prefer = []
  const rest = []
  for (const k of Object.keys(j)) {
    if (/(image|frame|cover|poster|thumb|mask|audio|sprite)/i.test(k)) continue
    ;(/video|content|data|output|results?|generations?|url/i.test(k) ? prefer : rest).push(k)
  }
  for (const k of [...prefer, ...rest]) {
    const v = j[k]
    // 形如 xxx_url / video / link 的字符串直接当候选(Agnes 的成片在 metadata.url)
    if (typeof v === 'string' && /url|video|link|play/i.test(k) && /^(https?:\/\/|\/)/.test(v)) return v
    if (Array.isArray(v) && v.length) {
      for (const item of v) {
        if (typeof item === 'string' && /^https?:\/\/|^\//.test(item)) return item
        const u = extractVideoUrl(item, depth + 1)
        if (u) return u
      }
    } else if (v && typeof v === 'object') {
      const u = extractVideoUrl(v, depth + 1)
      if (u) return u
    }
  }
  // 兜底: 本层的 url 字段
  if (typeof j.url === 'string' && /^https?:\/\/|^\//.test(j.url)) return j.url
  return ''
}

/** 递归提取任务 id (task_id/taskId/id/request_id) */
function extractTaskId(j, depth = 0) {
  if (!j || typeof j !== 'object' || depth > 3) return ''
  /**
   * AutoDL 顶层带 `request_id`，真正的任务号在 `data.task_id`；
   * 以前先看顶层 request_id，会把 client_id/请求号当任务号去轮询，
   * 平台回 InternalError「工作流不可用」。所以 data 里的任务号优先。
   */
  if (j.data && typeof j.data === 'object' && !Array.isArray(j.data)) {
    const inner = j.data.task_id || j.data.taskId
    if (typeof inner === 'string' && inner) return inner
  }
  // ⚠️ video_id 优先: Agnes 的建任务响应里同时有 id/task_id(任务号) 与 video_id ——
  //    它的取结果接口只认 GET /agnesapi?video_id=…, 拿 task_id 去查是查不到的。
  //    (其它平台没有 video_id 字段, 不受影响)
  for (const k of ['video_id', 'task_id', 'taskId', 'request_id', 'requestId', 'id']) {
    const v = j[k]
    if (typeof v === 'string' && v) return v
    if (typeof v === 'number') return String(v)
  }
  for (const k of ['data', 'output', 'result']) {
    const v = j[k]
    if (Array.isArray(v) && v.length) {
      const tid = extractTaskId(v[0], depth + 1)
      if (tid) return tid
    } else if (v && typeof v === 'object') {
      const tid = extractTaskId(v, depth + 1)
      if (tid) return tid
    }
  }
  return ''
}

/**
 * 本地相对路径参考图(/kear/view?... /comfy/view?...) → base64 dataURL (远端 API 不认相对路径)
 *
 * ⚠️ ⚠️ 2026-10-12 血泪: 这里**绝对不能**写成 `{'/kear': BACKENDS.kear.port, …}` ——
 *   那是在**模块加载那一刻**把端口"拍"下来的快照。而端口自动搬迁(applyBackendPortAutoRelocate)
 *   发生在 `startServer` 里, 比模块加载晚 ⇒ 快照永远是**默认端口 8188-8192**,
 *   于是"后端明明搬到了 8971, 应用却还去连 8189" —— 现象是: 模型起来了、端口在听、
 *   但界面一直说"未在运行 / 启动中", 日志里每几秒一行 `端口拒绝连接 → 立即标记离线`。
 *   所以这里只存**前缀 → 哪一路**, 端口一律现取(见 httpRoutes / localMediaPort)。
 */
const LOCAL_MEDIA_ROUTE_KINDS = { '/kear': 'kear', '/comfy': 'h3', '/indextts': 'indextts' }
/** 本地素材路由前缀 → 这一路**现在**的端口(现取, 不用快照) */
function localMediaPort(prefix) {
  const kind = LOCAL_MEDIA_ROUTE_KINDS[prefix]
  return (kind && BACKENDS[kind]?.port) || 0
}
async function toRemoteImage(src) {
  const s = String(src || '')
  if (!s) return null
  if (s.startsWith('data:') || /^https?:\/\//i.test(s)) return s
  // 画布上的"本地化产物"素材(/api/assets/file?name=xxx) → 直接读盘转 dataURL
  if (s.startsWith('/api/assets/file')) {
    try {
      const name = new URL(s, 'http://x').searchParams.get('name') || ''
      if (!name || /[\\/]/.test(name) || name.includes('..')) return null
      /** 跨目录找(用户换过保存位置以后, 老文件照样要读得到) */
      const abs = findAssetFile(name)
      if (!abs) return null
      const ext = path.extname(name).toLowerCase()
      const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.webp' ? 'image/webp'
          : ext === '.gif' ? 'image/gif'
            : ext === '.mp4' ? 'video/mp4'
              : 'image/png'
      return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`
    } catch { return null }
  }
  for (const route of Object.keys(LOCAL_MEDIA_ROUTE_KINDS)) {
    const port = localMediaPort(route)
    if (!port) continue
    if (s.startsWith(`${route}/`)) {
      const r = await fetch(`http://127.0.0.1:${port}${s.slice(route.length)}`, { signal: AbortSignal.timeout(30000) })
      if (!r.ok) throw new Error(`读取本地参考图失败 ${s}: HTTP ${r.status}`)
      const buf = Buffer.from(await r.arrayBuffer())
      const ct = r.headers.get('content-type') || 'image/png'
      return `data:${ct};base64,${buf.toString('base64')}`
    }
  }
  return null   // 未知前缀 → 丢弃(不阻塞提交)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * AutoDL.Art 网站登录态（只用于代传参考图）。
 * Inference 仍用客户填的 ComfyUI 分组 token，两者不要混。
 */
function autodlSessionFile() {
  return path.join(P.dataDir, 'autodl-web-token.json')
}
function readAutodlWebToken() {
  try {
    const j = JSON.parse(fs.readFileSync(autodlSessionFile(), 'utf-8'))
    const t = String(j?.token || '').trim()
    return t.length > 20 ? t : ''
  } catch { return '' }
}
async function autodlUploadOne(src, token) {
  const s = String(src || '')
  if (/^https?:\/\//i.test(s)) return s
  const m = /^data:((?:image|audio)\/[a-z0-9.+-]+);base64,(.+)$/i.exec(s)
  if (!m) throw new Error('参考素材格式不支持｜怎么办：换成 PNG/JPG/WebP 或 MP3/WAV 后重新生成')
  const mime = m[1].toLowerCase()
  const buf = Buffer.from(m[2], 'base64')
  if (!buf.length) throw new Error('参考素材是空的｜怎么办：重新上传这份素材')
  const md5 = createHash('md5').update(buf).digest('hex')
  const auth = { Authorization: token }
  const pre = await fetch('https://autodl.art/api/v1/file/before_upload', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ md5, file_size: buf.length }),
    signal: AbortSignal.timeout(30_000),
  })
  const pj = await pre.json().catch(() => null)
  if (!pre.ok || pj?.code !== 'Success' || !pj?.data?.token) {
    throw new Error(`参考图上传失败：AutoDL 登录态没通过｜怎么办：在 H3 云端算力页重新扫码登录｜平台原话：${String(pj?.msg || pj?.code || `HTTP ${pre.status}`).slice(0, 80)}`)
  }
  const ext = mime.includes('jpeg') ? 'jpg'
    : mime.includes('webp') ? 'webp'
      : mime.includes('png') ? 'png'
        : mime.includes('mpeg') || mime.includes('mp3') ? 'mp3'
          : mime.includes('wav') ? 'wav'
            : mime.includes('flac') ? 'flac'
              : mime.includes('m4a') ? 'm4a'
                : mime.startsWith('audio/') ? 'wav' : 'png'
  const filename = `aics-ref-${md5.slice(0, 10)}.${ext}`
  const fd = new FormData()
  fd.append('md5', md5)
  fd.append('chunk', '0')
  fd.append('chunks', '1')
  fd.append('chunk_size', String(buf.length))
  fd.append('file', new Blob([buf], { type: mime }), filename)
  /**
   * ⚠️ before_upload 给的 host 是 https://oss.codewithgpu.com:8000，
   * 该证书 2026-10-18 已过期；实测同源 https://autodl.art/api/v1/file 可正常收 multipart，
   * 所以这里不用 host，避免把客户带进证书错误。
   */
  const up = await fetch('https://autodl.art/api/v1/file', {
    method: 'POST',
    headers: { ...auth, FileToken: pj.data.token },
    body: fd,
    signal: AbortSignal.timeout(120_000),
  })
  const uj = await up.json().catch(() => null)
  if (!up.ok || uj?.code !== 'Success') {
    throw new Error(`参考图上传失败：AutoDL 没接收文件｜怎么办：重试；仍失败就到 H3 云端算力页重登｜平台原话：${String(uj?.msg || uj?.code || `HTTP ${up.status}`).slice(0, 80)}`)
  }
  const vals = uj?.data && typeof uj.data === 'object' ? Object.values(uj.data) : []
  const url = vals.find((v) => typeof v === 'string' && /^https?:\/\//i.test(v))
  if (!url) throw new Error('参考图上传失败：平台没返回公网地址｜怎么办：换一张图重试')
  return url
}
async function autodlUploadImages(images) {
  const out = []
  let token = ''
  for (const img of images) {
    if (/^https?:\/\//i.test(String(img))) { out.push(String(img)); continue }
    if (!token) {
      token = readAutodlWebToken()
      if (!token) {
        throw new Error('参考图需要先登录 AutoDL｜怎么办：打开 API 面板 → H3 云端算力 → 扫码登录')
      }
    }
    out.push(await autodlUploadOne(img, token))
  }
  return out
}


/**
 * "排队/限流"类 HTTP 状态 —— 这类失败**不是**参数错, 等一会儿再发就能成, 不该当生成失败直接甩给用户。
 * 实测(2026-09-17) Agnes 出图高峰期频繁回 503 `text image queue is full` / `image queue is full`,
 * 用户看到的就是"点了生成没反应/生成不了"。这里统一带退避重试, 重试完才报错。
 */
const CLOUD_BUSY_STATUS = new Set([429, 500, 502, 503, 504])

/** POST + 排队退避重试; 返回最后一次的 {status, text, url, tries} */
async function postWithBusyRetry({ url, headers, body, timeoutMs, logTag = 'cloud', attempts = 4, signal }) {
  /** 调用方传进来的中断信号(例如"前端取消/关掉连接")与超时合并成一个信号 */
  const withTimeout = (ms) => (signal
    ? AbortSignal.any([signal, AbortSignal.timeout(ms)])
    : AbortSignal.timeout(ms))
  let last = null
  for (let i = 0; i < attempts; i++) {
    let r
    try {
      r = await fetch(url, {
        method: 'POST', headers, body: JSON.stringify(body), signal: withTimeout(timeoutMs),
      })
    } catch (e) {
      last = { status: 0, text: `请求异常: ${e?.message ?? e}`, url, tries: i + 1 }
      if (i < attempts - 1) { await sleep(2000 * (i + 1)); continue }
      return last
    }
    const text = await r.text()
    last = { status: r.status, text, url, tries: i + 1 }
    if (!CLOUD_BUSY_STATUS.has(r.status)) return last
    if (i < attempts - 1) {
      const ra = Number(r.headers.get('retry-after'))
      const wait = Number.isFinite(ra) && ra > 0 ? Math.min(30, ra) * 1000 : Math.min(20_000, 2000 * Math.pow(2, i))
      log(`[${logTag}] HTTP ${r.status} 排队/限流 → ${Math.round(wait / 1000)}s 后重试(${i + 2}/${attempts})`)
      await sleep(wait)
    }
  }
  return last
}

/** 该连接的视频三件套: 形状 + 提交路径 + 轮询路径(连接级覆盖 > 平台默认) */
function videoEndpoints(rec) {
  const d = typeDef(rec, 'video') || {}
  const t = rec.types?.video || {}
  /** 旧的 h3-cloud 连接（baseUrl 还是 127.0.0.1:8600）继续走 generic-task，别被新平台默认值带跑。 */
  const oldH3Cloud = rec.platform === 'h3-cloud' && !/autodl\.art/i.test(String(rec.baseUrl || ''))
  return {
    shape: t.shape || (oldH3Cloud ? 'generic-task' : (d.shape || 'generic-task')),
    submit: t.submit || d.submit || '/v1/videos',
    poll: t.poll || d.poll || '/v1/videos/{id}',
    pollSec: d.pollSec,
  }
}

/** 尺寸串 "1280x720" → 平台要的比例串 "16:9" (火山用文本参数指定比例) */
function ratioOf(size) {
  const m = String(size || '').match(/^(\d+)\s*[xX*]\s*(\d+)$/)
  if (!m) return ''
  const w = Number(m[1]), h = Number(m[2])
  if (!w || !h) return ''
  const g = (a, b) => (b ? g(b, a % b) : a)
  const d = g(w, h)
  return `${w / d}:${h / d}`
}

/**
 * Agnes 的视频只有 720P / 1080P / 1K / 2K 四档, 而且 2.5-flash **只吃 720P**(其它值直接 400)。
 * 卡片给的是 "832x480" 这种确切尺寸 → 按短边落到最近的档位。
 */
function agnesVideoSize(size, model) {
  if (/flash/i.test(String(model || ''))) return '720P'
  const m = String(size || '').match(/^(\d+)\s*[xX*]\s*(\d+)$/)
  const short = m ? Math.min(Number(m[1]), Number(m[2])) : 0
  if (short >= 1080) return '1080P'
  return '720P'
}

/** 轮询模板里除了 {id} 还要支持 {model}(Agnes 的取结果接口必须带 model_name) */
function fillPollTemplate(tpl, id, model) {
  return String(tpl || '')
    .replace('{id}', encodeURIComponent(String(id ?? '')))
    .replace('{model}', encodeURIComponent(String(model ?? '')))
}

/** 按平台形状拼"提交"请求体 —— 各家字段形状不同, 都在这里翻译 */
/**
 * 画布尺寸 → AutoDL 工作流的 resolution 标签。
 * z0901（文生）与 z0902（多图）的 768p 括号宽高不同，不能混用。
 */
function autodlResolutionLabel(size, workflow) {
  const m = String(size || '').match(/(\d+)\s*[xX*]\s*(\d+)/)
  const w = m ? Number(m[1]) : 864
  const h = m ? Number(m[2]) : 480
  const landscape = w >= h
  const short = Math.min(w, h)
  const plain = workflow === 'minimax_h3_lightx2v_v5'
    || workflow === 'minimax_h3_lightx2v'
    || workflow === 'minimax_h3_zm_u24'
  /** z0901/z0902 有 480/768/1088/1440；v5 有 480/768/1080；lightx2v、zm_u24 最高 768。 */
  let tier
  if (workflow === 'minimax_h3_z0901' || workflow === 'minimax_h3_z0902') {
    tier = short >= 1400 ? 1440 : short >= 950 ? 1088 : short >= 650 ? 768 : 480
  } else if (workflow === 'minimax_h3_lightx2v_v5') {
    tier = short >= 1000 ? 1080 : short >= 650 ? 768 : 480
  } else {
    tier = short >= 650 ? 768 : 480
  }
  const dir = landscape ? '横' : '竖'
  if (plain) {
    const square = Math.abs(w - h) / Math.max(w, h) < 0.08
    return `${tier}p${square ? '(1:1)' : dir}`
  }
  const dims = {
    480: [864, 480],
    768: workflow === 'minimax_h3_z0902' ? [1376, 768] : [1344, 768],
    1088: [1920, 1088],
    1440: [2560, 1440],
  }[tier]
  const [lw, lh] = dims
  const [dw, dh] = landscape ? [lw, lh] : [lh, lw]
  return `${tier}p${dir}(${dw}*${dh})`
}

function buildVideoRequest(rec, payload) {
  const { shape, submit } = videoEndpoints(rec)
  let url = joinUrl(rec.baseUrl, submit)
  const headers = authHeaders(rec)
  const images = Array.isArray(payload.images) ? payload.images : []
  /**
   * 提交时**真正发出去**的时长 + 是否被平台上限夹过 (2026-09-23 测试人员反馈"提交 15 秒只出 4 秒")。
   * 以前这里只有"字段名"进日志, 时长到底发了多少查不出来 —— 现在把值也记上(不含提示词/参考图, 无隐私问题)。
   */
  const reqSeconds = Number(String(payload.seconds ?? '').replace(/[^\d.]/g, '')) || 0
  let sentSeconds = reqSeconds || undefined
  let durationNote = ''
  let body
  if (shape === 'autodl-art') {
    /**
     * AutoDL.Art ComfyUI 工作流（画布四选一）：
     *   H3 文生视频   → z0901
     *   H3 图生视频   → lightx2v_v5（单图/多图参考）
     *   H3 多参考     → z0902 六图一致性
     *   H3 首尾帧     → lightx2v（first_frame/last_frame）
     * 全部只收 http(s) URL；dataURL 正常路径已在 submit 前上传成 COS URL。
     */
    const modelName = String(payload.model || '')
    const refType = String(payload.refType || '')
    const singleH3 = !refType && /H3 云端算力/.test(modelName)
    if (/续拍/.test(refType)) {
      throw new Error('H3 云端算力不支持「续拍」｜怎么办：续拍请切回「本地 H3」；云端可用文生/图生/多参考/首尾帧')
    }
    const isFlf = /首尾帧/.test(refType) || (!refType && /首尾帧/.test(modelName))
    const isImage = /图生/.test(refType) || (!refType && /图生/.test(modelName)) || (singleH3 && images.length === 1)
    const isMulti = /多参|多参考/.test(refType) || (!refType && /多参考/.test(modelName)) || (singleH3 && images.length > 1)
    if (isMulti && Array.isArray(payload.videos) && payload.videos.length) {
      throw new Error('H3 云端算力的多参考暂不支持参考视频｜怎么办：参考视频请用本地 H3；云端仍支持 9 图 + 3 音频')
    }
    const workflow = isFlf ? 'minimax_h3_lightx2v'
      : isImage ? 'minimax_h3_lightx2v_v5'
        : isMulti ? 'minimax_h3_zm_u24'
          : 'minimax_h3_z0901'
    /** AutoDL H3 只有 16:9 / 9:16（plain 工作流另有 1:1），没有 4:3 / 21:9。 */
    const sm = String(payload.size || '').match(/(\d+)\s*[xX*]\s*(\d+)/)
    if (sm) {
      const sw = Number(sm[1]), sh = Number(sm[2])
      const ar = sw / sh
      const plainWf = workflow === 'minimax_h3_lightx2v_v5' || workflow === 'minimax_h3_lightx2v' || workflow === 'minimax_h3_zm_u24'
      const landscapeOk = ar >= 1.6 && ar <= 1.95
      const portraitOk = ar >= 0.51 && ar <= 0.625
      const squareOk = plainWf && Math.abs(ar - 1) <= 0.08
      const ok = landscapeOk || portraitOk || squareOk
      if (!ok) {
        throw new Error(`H3 云端不支持 ${sw}×${sh} 这个画幅｜怎么办：画幅改成 16:9 或 9:16（4:3 / 21:9 已灰，平台枚举里没有）`)
      }
    }
    url = joinUrl(rec.baseUrl, `/comfyui_workflow/${workflow}`)
    const secs = Math.max(1, Math.min(15, Math.round(Number(String(payload.seconds ?? '').replace(/[^\d.]/g, '')) || 5)))
    sentSeconds = secs
    if (reqSeconds && sentSeconds !== reqSeconds) {
      durationNote = `${rec.label}这个模型最多 15 秒、最少 1 秒，已按 ${sentSeconds} 秒提交（你要 ${reqSeconds} 秒）`
    }
    body = { prompt: String(payload.prompt || ''), duration: secs, resolution: autodlResolutionLabel(payload.size, workflow) }
    const refs = images.slice(0, 9)
    if (isFlf) {
      if (refs.length < 2) throw new Error('首尾帧需要两张参考图（首帧 + 尾帧）｜怎么办：连两张图，或改选「H3 图生视频」')
      body.first_frame = refs[0]
      body.last_frame = refs[1]
    } else if (isImage || isMulti || refs.length) {
      if (!refs.length) throw new Error('这个工作流需要参考图｜怎么办：连一张图，或改选「H3 文生视频」')
      for (let i = 0; i < refs.length; i++) {
        if (!/^https?:\/\//i.test(String(refs[i]))) {
          throw new Error('参考图还没上传成公网地址｜怎么办：在 H3 云端算力页先扫码登录 AutoDL，再重新生成')
        }
        body[`ref_image_${i}`] = refs[i]
      }
      if (isMulti) {
        const auds = (Array.isArray(payload.audios) ? payload.audios : []).slice(0, 3)
        for (let i = 0; i < auds.length; i++) {
          if (!/^https?:\/\//i.test(String(auds[i]))) {
            throw new Error('参考音频还没上传成公网地址｜怎么办：重新生成，或先移除音频参考')
          }
          body[`ref_audio_${i}`] = auds[i]
        }
      }
    } else if (refs.length) {
      throw new Error('「H3 文生视频」不需要参考图｜怎么办：改选「H3 图生视频」或「H3 多参考」')
    }
  } else if (shape === 'ark-task') {
    // 火山方舟(创建视频生成任务, 2026-09 官方文档): 参数走**结构化字段**,
    //   body = {model, content:[{type:'text'},{type:'image_url'}], resolution, ratio, duration}
    //   resolution: "480p"/"720p"/"1080p"; ratio: 16:9…; duration: 整数秒
    //   (老写法把 `--ratio 16:9 --dur 5` 塞进提示词, 官方新文档已改成上面这套结构化参数)
    const content = [{ type: 'text', text: String(payload.prompt || '') }]
    for (const u of images) content.push({ type: 'image_url', image_url: { url: u } })
    const m = String(payload.size || '').match(/^(\d+)\s*[xX*]\s*(\d+)$/)
    const shortSide = m ? Math.min(Number(m[1]), Number(m[2])) : 0
    const resolution = shortSide >= 1080 ? '1080p' : shortSide >= 720 ? '720p' : '480p'
    const secs = Math.min(12, Math.max(3, Math.round(Number(String(payload.seconds ?? '').replace(/[^\d.]/g, '')) || 5)))
    sentSeconds = secs
    if (reqSeconds && secs !== reqSeconds) durationNote = `${rec.label}这个模型最多 12 秒, 已按 ${secs} 秒提交（你要 ${reqSeconds} 秒）`
    body = {
      model: payload.model,
      content,
      resolution,
      ratio: nearestRatio(payload.size, ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9']),
      duration: secs,
    }
  } else if (shape === 'dashscope-task') {
    // 阿里百炼: 必须带 X-DashScope-Async: enable, 结果从 output.task_id 取
    headers['X-DashScope-Async'] = 'enable'
    const parameters = {}
    // ⚠️ 百炼的尺寸串是 `1280*720`(星号), 不是 `1280x720` —— 原样发过去会 InvalidParameter
    if (payload.size) parameters.size = dashscopeSize(payload.size, '1280*720')
    if (payload.seconds) parameters.duration = payload.seconds
    sentSeconds = Number(payload.seconds) || undefined
    body = { model: payload.model, input: { prompt: payload.prompt }, parameters }
    if (images.length) body.input.img_url = images[0]
  } else if (shape === 'modelscope-task') {
    // 魔搭: 同一个 images/generations 加异步头, 拿 task_id 再去 /v1/tasks/{id}
    headers['X-ModelScope-Async-Mode'] = 'true'
    body = { model: payload.model, prompt: payload.prompt }
    if (payload.seconds) body.duration = payload.seconds
    sentSeconds = Number(payload.seconds) || undefined
    if (images.length) body.image_url = images[0]
  } else if (shape === 'siliconflow-task') {
    // 硅基流动: POST /v1/video/submit {model,prompt,image_size,image?} → { requestId }
    body = { model: payload.model, prompt: payload.prompt }
    if (payload.size) body.image_size = payload.size
    if (payload.seconds) body.duration = payload.seconds
    sentSeconds = Number(payload.seconds) || undefined
    if (images.length) body.image = images[0]
  } else if (shape === 'agnes-video') {
    // Agnes 视频: POST /v1/videos {model,prompt,mode,seconds,size,aspect_ratio}
    //   mode: text(纯文) / keyframe(首帧) / reference(多参考图) —— 官方文档的三种模式
    //   size: 只有 720P/1080P/1K/2K (2.5-flash 只吃 720P); seconds: 字符串 "4"~"12"
    const modeMap = (typeDef(rec, 'video') || {}).modeField || {}
    const mode = images.length > 1
      ? (modeMap.multi || 'reference')
      : images.length === 1 ? (modeMap.image || 'keyframe') : (modeMap.text || 'text')
    // 卡片可能给 1s/2s(本地 H3 支持), Agnes 最小 4 秒 —— 抬到 4 并夹住上限, 否则直接 400
    const secs = Math.min(12, Math.max(4, Number(String(payload.seconds ?? '').replace(/[^\d.]/g, '')) || 5))
    sentSeconds = Math.round(secs)
    if (reqSeconds && sentSeconds !== reqSeconds) {
      durationNote = sentSeconds < reqSeconds
        ? `${rec.label}这个模型最多 12 秒, 已按 ${sentSeconds} 秒提交（你要 ${reqSeconds} 秒）`
        : `${rec.label}这个模型最少 4 秒, 已按 ${sentSeconds} 秒提交（你要 ${reqSeconds} 秒）`
    }
    body = {
      model: payload.model,
      prompt: payload.prompt,
      mode,
      seconds: String(Math.round(secs)),
      size: agnesVideoSize(payload.size, payload.model),
      // 官方只认这几个比例(832x480 这种会化简成 26:15 → 直接 400)
      aspect_ratio: nearestRatio(payload.size, AGNES_RATIOS),
    }
    /**
     * ★ 2026-10-12 中国站实测(用户给的测试 key):
     *   · 参考素材平台只认「公网 http(s) URL」或「**裸 base64**」—— 带 `data:` 前缀会被判非法,
     *     平台原话: `素材必须是公网 http(s) URL 或合法 Base64`。而画布上的本地素材**恰好就是 data: 形态**,
     *     所以这里统一把前缀剥掉再发(不剥的话多参/图生必然 400, 这正是客户"用不了多参"的原因之一)。
     *   · 上限按文档: 图 **≤8 张**(原来我们只截 5 张, 白白少给了 3 张额度); 参考图边长必须 256–5760。
     */
    const asRef = (u) => {
      const s = String(u ?? '')
      return s.startsWith('data:') ? s.replace(/^data:[^,]+,/, '') : s
    }
    if (images.length === 1) body.first_frame = asRef(images[0])
    else if (images.length > 1) body.images = images.slice(0, 8).map(asRef)
  } else {
    // 自定义/通用: 宽松字段, 服务端自适应解析返回
    body = { model: payload.model, prompt: payload.prompt }
    if (payload.seconds != null) body.seconds = payload.seconds
    sentSeconds = Number(payload.seconds) || undefined
    if (payload.size) body.size = payload.size
    if (images.length) body.images = images
    /**
     * ★ 2026-10-08 用户: "云端 H3 中是否加入了采样和加速的请求字段, 没有的话就再调整一下"。
     *   采样步数与加速原来**一个都没发**（云端一直吃平台默认值）。现在按"平台支持就生效、
     *   不支持就会被忽略"的口径带上；平台若因未知字段直接 400，下面的提交段会自动
     *   退回最小字段集（model+prompt）重试一次，不会把这次生成判死。
     */
    if (Number(payload.steps) > 0) body.steps = Math.round(Number(payload.steps))
    if (payload.sageAttention === true) {
      body.sage_attention = true
      if (payload.sageMode) body.sage_mode = String(payload.sageMode)
    }
    // 少数平台对"文生视频/图生视频"要求显式 mode(Agnes 就是: 不带直接 invalid_request)
    const modeMap = (typeDef(rec, 'video') || {}).modeField
    if (modeMap) body.mode = images.length ? (modeMap.image || 'image2video') : (modeMap.text || 'text2video')
  }
  // 排查/排障用: 只打形状与字段名, 不打内容(提示词/参考图可能很长且含隐私)
  // 时长也打进日志(只是数字, 不含提示词/参考图): 排查"提交 15 秒只出 4 秒"这类问题时,
  // 一眼能看出"我们要的是多少、实际发出去的是多少"(2026-09-23 测试人员反馈)
  log(`[cloud-video] ${rec.name} shape=${shape} → ${url.replace(/^https?:\/\/[^/]+/i, '')} 时长=${sentSeconds ?? '-'}(要 ${reqSeconds || '-'}) 字段=[${Object.keys(body).join(',')}]`)
  return { url, headers, body, shape, sentSeconds, requestedSeconds: reqSeconds || undefined, durationNote }
}

async function runCloudVideoTask(task, rec, payload, prebuilt = null) {
  // 恢复出来的任务: 平台侧任务号还在 → 直接续查, 不再重复提交(否则会白花一次配额)
  if (task.remoteId) return pollCloudVideoTask(task, rec, payload, String(task.remoteId))
  const ep = videoEndpoints(rec)
  const req = prebuilt || buildVideoRequest(rec, payload)
  task.shape = req.shape
  task.sentSeconds = req.sentSeconds
  task.durationNote = req.durationNote || ''
  try {
    // ── 提交 ──
    //
    // 提交带两个自适应:
    //   · 429 限流(聚合平台免费档常见) → 退避重试 3 次, 而不是直接判失败
    //   · 平台嫌字段多(返回 invalid_json / unknown field) → 去掉可选字段用最小体再试一次
    const post = async (payload) => {
      const r = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120_000),
      })
      return { status: r.status, text: await r.text() }
    }
    let out = null
    /**
     * ★ 2026-10-12 实测(用户刚买的 Agnes Token Plan Starter, 国际站): 同一个文生任务连续建单,
     *   **前 6 次全是 503 `video_queue_full`, 第 7 次(约 3 分钟)才建单成功** ——
     *   即"队列满"是**分钟级**的临时容量问题, 不是靠改参数能绕开的。
     *   原来只等 5+10+15=30 秒就判失败, 用户看到的就是"点了生成 → 直接失败", 而其实再等等就能成。
     *   现在把窗口拉到约 3 分钟(退避封顶 30 秒)。等待期间任务保持 running, 用户随时可取消。
     */
    const submitAttempts = 10
    for (let attempt = 0; attempt < submitAttempts; attempt++) {
      out = await post(req.body)
      // 429 限流与 503 队列满都算"排队", 等一会儿再来; 其它状态直接判
      if (!CLOUD_BUSY_STATUS.has(out.status)) break
      task.error = '' // 限流不算错误, 继续等
      const waitMs = Math.min(30_000, 5000 * (attempt + 1))
      log(`[cloud-video] 提交 HTTP ${out.status} 排队/限流 → ${Math.round(waitMs / 1000)}s 后重试(${attempt + 2}/${submitAttempts})`)
      await sleep(waitMs)
      if (task.abort) throw new Error('已取消')
    }
    if (out.status === 400 && /invalid_json|unknown|unexpected|unsupported/i.test(out.text) && Object.keys(req.body).length > 2
      && !(rec.platform === 'h3-cloud' && /autodl\.art/i.test(String(rec.baseUrl || '')))) {
      const minimal = { model: req.body.model, prompt: req.body.prompt }
      out = await post(minimal)
    }
    const txt = out.text
    if (out.status < 200 || out.status >= 300) {
      // 429 分两种: 免费档的"频率/并发"限制(等几分钟就行) vs 真的额度用尽 —— 说法要分开,
      // 否则用户会以为"我的钱花完了"(实测 Agnes 免费档回的就是 "API rate limit for free users")
      throw new Error(friendlyCloudError({
        action: '生视频', status: out.status, body: txt, url: req.url,
        extra: out.status === 429 || out.status === 503 ? `已自动重试 ${submitAttempts} 次` : '',
      }))
    }
      let j
      try { j = JSON.parse(txt) } catch {
        throw new Error(`生视频失败：这不是接口地址｜怎么办：核对「高级」里的提交地址｜平台原话：${txt.slice(0, 120)}`)
      }

    // ── 自适应: 同步返回产物 URL → 直接完成 ──
    const direct = extractVideoUrl(j)
    if (direct) { task.status = 'done'; task.url = direct; return }
    const tid = extractTaskId(j)
      if (!tid) throw new Error(`生视频失败：这不是视频模型｜怎么办：从文档复制完整的视频模型 ID｜平台原话：${txt.slice(0, 120)}`)
    task.remoteId = String(tid)
    saveCloudTasks()
    return pollCloudVideoTask(task, rec, payload, String(tid))
  } catch (e) {
    task.status = 'error'
    task.error = task.abort ? '已取消' : (e?.message ?? String(e))
    task.finishedAt = Date.now()
    saveCloudTasks()
  }
}

/**
 * 轮询平台任务直到出片/失败 (提交成功后进入, 或**重启后从 remoteId 恢复**进入)。
 * 用连接/平台给的 poll 模板替换 {id}; 模板里没有 {id} 或 404 时降级 ?task_id=。
 */
async function pollCloudVideoTask(task, rec, payload, tid) {
  const ep = videoEndpoints(rec)
  const req = buildVideoRequest(rec, payload)
  try {
    const pollTemplate = ep.poll || '/v1/videos/{id}'
    const hasSlot = pollTemplate.includes('{id}')
    const pollByBody = req.shape === 'siliconflow-task' || (!hasSlot && /(^|\/)video\/status/.test(pollTemplate))
    const pollUrl = (t) => joinUrl(rec.baseUrl, fillPollTemplate(pollTemplate, t, payload.model))
    // 各家建议的轮询间隔不同(Agnes 官方写 1~2 秒, 但实测它的网关会回
    // "too many video status queries" —— 所以给它留足间隔, 默认 4 秒)
    const basePollMs = Math.max(1000, Math.min(15000, (Number(ep.pollSec) || 4) * 1000))
    let pollEveryMs = basePollMs
    const deadline = Date.now() + CLOUD_VIDEO_TIMEOUT_MS
    let alt = false
    /**
     * ★ 2026-10-12 实测(国际站 apihub.agnes-ai.com, 用户新购 Token Plan Starter):
     *   同一批文生任务里, 有一条建单后**在 `pending`/progress=0 上停了 21 分钟**才开始跑
     *   (created 09:51:39Z → started 10:12:34Z), 之后 2 分 39 秒出片。
     *   → "队列满"是真的, 但**不是一直排不上**, 而是分钟级的排队; 所以:
     *     ① 排队期不要把状态查得太勤(21 分钟 × 4 秒 = 300 多次, 平台会回 "too many video status queries"),
     *        下面按"排队就逐渐放慢到 20 秒"处理, 跑起来再恢复原节奏;
     *     ② 拖到超时也要能自证清白: 一次都没进过 in_progress → 明说是平台没排上队,
     *        而不是含糊的"排队超 30 分钟"。
     */
    let sawRunning = false
    while (Date.now() < deadline) {
      if (task.abort) throw new Error('已取消')
      await sleep(pollEveryMs)
      let pr
      let u
      if (pollByBody) u = joinUrl(rec.baseUrl, pollTemplate)
      else if (alt || !hasSlot) {
        // 模板里没有 {id}(或带 {id} 的那条 404 了) → 退化成 ?task_id= 形式
        const stem = joinUrl(rec.baseUrl, pollTemplate.replace(/\{id\}.*$/, '').replace(/[?&]$/, ''))
        u = `${stem}${stem.includes('?') ? '&' : '?'}task_id=${encodeURIComponent(tid)}`
      } else u = pollUrl(tid)
      try {
        const pollAuth = (rec.platform === 'h3-cloud' && /autodl\.art/i.test(String(rec.baseUrl || '')))
          ? { Authorization: apiKeyOf(rec), Accept: 'application/json' }
          : { Authorization: `Bearer ${apiKeyOf(rec)}`, Accept: 'application/json' }
        pr = await fetch(u, pollByBody
          ? {
              method: 'POST',
              headers: { ...pollAuth, 'Content-Type': 'application/json' },
              body: JSON.stringify({ requestId: tid, task_id: tid }),
              signal: AbortSignal.timeout(20000),
            }
          : { headers: pollAuth, signal: AbortSignal.timeout(20000) })
      } catch { continue }   // 轮询瞬时网络错误 → 继续重试
      if (pr.status === 404 && !alt && hasSlot) { alt = true; continue }
      if (!pr.ok) {
        const ptxt = (await pr.text().catch(() => '')).slice(0, 160)
        // 429/5xx 是"问得太勤/网关忙", **不是**任务失败 —— 退避后继续等, 别把任务判死
        if (pr.status === 429 || pr.status >= 500) {
          pollEveryMs = Math.min(30_000, Math.round(pollEveryMs * 1.6))
          log(`[cloud-video] 轮询 HTTP ${pr.status}(问得太勤), 退避到 ${Math.round(pollEveryMs / 1000)}s 再问`)
          continue
        }
        throw new Error(friendlyCloudError({ action: '查询生成进度', status: pr.status, body: ptxt, url: u }))
      }
      const pj = await pr.json().catch(() => null)
      if (!pj) continue
      if (pj.code && pj.code !== 'Success') {
        throw new Error(`生视频失败：AutoDL 返回 ${pj.code}｜怎么办：${failedTaskHint(pj.msg || pj.code)}｜平台原话：${String(pj.msg || '').slice(0, 120)}`)
      }
      const url = extractVideoUrl(pj)
      // 平台回传了真实进度(如 h3-cloud 的 progress/stageText)就记下, 让画布进度条按真进度爬
      if (typeof pj.progress === 'number') task.cloudProgress = Math.max(0, Math.min(100, Math.round(pj.progress)))
      if (typeof pj.stageText === 'string') task.cloudStageText = String(pj.stageText)
      if (url) {
        task.status = 'done'
        task.url = url
        task.finishedAt = Date.now()
        task.elapsed = task.finishedAt - (task.createdAt || task.finishedAt)
        saveCloudTasks()
        await saveCloudVideoToAssets(task)   // 服务端自己落一份, 程序关着也不丢产物
        saveCloudTasks()
        return
      }
      const st = String(pj.status ?? pj.state ?? '').toLowerCase()
      // 只要出现过一次非"排队"的状态, 就说明上游确实开始跑了(与"压根没排上队"区分开)
      if (st && !/pending|queue|created|submit|waiting/.test(st)) sawRunning = true
      /**
       * 排队中就放慢问的节奏(4s → 最多 20s): 实测排队期可以长达 21 分钟, 一直 4 秒问一次
       * 既浪费又会被平台当成"刷状态"。一旦真的跑起来了, 立刻回到正常节奏, 别拖慢进度显示。
       */
      if (!sawRunning) pollEveryMs = Math.min(20_000, Math.round(pollEveryMs * 1.25))
      else if (pollEveryMs !== basePollMs) pollEveryMs = basePollMs
      if (/fail|error|cancel/.test(st)) {
        const msg = pj.error?.message ?? pj.message ?? pj.failure_reason ?? st
          /** ⚠️ "怎么办"按**平台原话**给（见 failedTaskHint 的说明）—— 原来硬编码成"换掉敏感内容"会把人指错方向 */
          throw new Error(`生视频失败：平台说任务失败（${st}）｜怎么办：${failedTaskHint(msg)}｜平台原话：${String(msg).slice(0, 120)}`)
      }
      if (/succe|complet|done|finish/.test(st)) {
          throw new Error(`生视频失败：平台没给视频地址｜怎么办：确认模型 ID 是视频模型｜平台原话：${JSON.stringify(pj).slice(0, 120)}`)
      }
      // 否则视为 running, 继续轮询
    }
      throw new Error(sawRunning
        ? '生视频失败：跑了 30 分钟还没出片｜怎么办：过几分钟再点一次生成'
        : '生视频失败：平台 30 分钟都没排上队（上游一直没开始跑）｜怎么办：这是平台侧的排队容量问题，跟你的 key、参数、余额都没关系——换个时段再试，或找平台确认这个分组的视频通道')
  } catch (e) {
    task.status = 'error'
    task.error = task.abort ? '已取消' : (e?.message ?? String(e))
    task.finishedAt = Date.now()
    saveCloudTasks()
  }
}

function handleAutodlStatus(req, res) {
  const token = readAutodlWebToken()
  let at = 0
  try { at = Number(JSON.parse(fs.readFileSync(autodlSessionFile(), 'utf-8')).at) || 0 } catch { /* ignore */ }
  return sendJson(res, 200, { ok: true, loggedIn: !!token, at })
}

async function handleAutodlSession(req, res) {
  const body = await readBody(req, res)
  const token = String(body.token || '').trim()
  if (token.length < 20) return sendJson(res, 400, { ok: false, msg: '登录态无效：没有拿到网站 token' })
  try {
    fs.mkdirSync(P.dataDir, { recursive: true })
    fs.writeFileSync(autodlSessionFile(), JSON.stringify({ token, at: Date.now() }), 'utf-8')
    return sendJson(res, 200, { ok: true })
  } catch (e) {
    return sendJson(res, 500, { ok: false, msg: `保存登录态失败：${e instanceof Error ? e.message : String(e)}` })
  }
}

async function handleAutodlUpload(req, res) {
  const body = await readBody(req, res)
  const token = readAutodlWebToken()
  if (!token) return sendJson(res, 400, { ok: false, msg: '还没登录 AutoDL｜怎么办：在 H3 云端算力页扫码登录' })
  try {
    const url = await autodlUploadOne(String(body.data || body.dataUrl || ''), token)
    return sendJson(res, 200, { ok: true, url })
  } catch (e) {
    return sendJson(res, 400, { ok: false, msg: e instanceof Error ? e.message : String(e) })
  }
}

async function handleCloudVideoSubmit(req, res) {
  const body = await readBody(req, res)
    const rec = store.getById(String(body.providerId || ''))
    if (!rec || !apiKeyOf(rec) || rec.enabled === false) {
        return sendJson(res, 400, { ok: false, msg: '生视频失败：这条 API 连接不可用｜怎么办：去顶栏「API」面板检查' })
    }
  // 顺手清理 1 小时前的旧任务, 防内存累积
  const now = Date.now()
  for (const [k, t] of cloudVideoTasks) if (now - t.createdAt > 3600_000) cloudVideoTasks.delete(k)

  const payload = { model: String(body.model || ''), prompt: String(body.prompt || '') }
  if (body.seconds != null && Number.isFinite(Number(body.seconds))) payload.seconds = Number(body.seconds)
  if (body.size) payload.size = String(body.size)
  if (Array.isArray(body.audios) && body.audios.length) payload.audios = body.audios.filter((x) => typeof x === 'string' && x).slice(0, 3)
  if (Array.isArray(body.videos) && body.videos.length) payload.videos = body.videos.filter((x) => typeof x === 'string' && x).slice(0, 3)
  if (body.refType) payload.refType = String(body.refType)
  /**
   * ★ 2026-10-08 用户: "云端 H3 中是否加入了采样和加速的请求字段, 没有的话就再调整一下"。
   *   这里以前**只收 model/prompt/seconds/size**（外加图片），前端就算带上 steps / sageAttention
   *   也会在这一步被丢掉 —— 所以线上一直"看起来不支持"。现在把它们也收进 payload，
   *   由 buildVideoRequest 的通用分支写进平台请求体（平台不支持会被忽略）。
   */
  if (Number(body.steps) > 0) payload.steps = Math.round(Number(body.steps))
  if (body.sageAttention === true) {
    payload.sageAttention = true
    if (body.sageMode) payload.sageMode = String(body.sageMode)
  }
  const images = []
  for (const s of (Array.isArray(body.images) ? body.images : [])) {
    try {
      const v = await toRemoteImage(s)
      if (v) images.push(v)
    } catch (e) {
      return sendJson(res, 400, { ok: false, msg: e instanceof Error ? e.message : String(e) })
    }
  }
  if (images.length) payload.images = images
  if (images.length && rec.platform === 'h3-cloud' && /autodl\.art/i.test(String(rec.baseUrl || ''))) {
    try {
      payload.images = await autodlUploadImages(images)
    } catch (e) {
      return sendJson(res, 400, { ok: false, msg: e instanceof Error ? e.message : String(e) })
    }
  }
  if (payload.audios?.length) {
    const auds = []
    for (const s of payload.audios) {
      try {
        const v = await toRemoteImage(s)
        if (v) auds.push(v)
      } catch (e) {
        return sendJson(res, 400, { ok: false, msg: e instanceof Error ? e.message : String(e) })
      }
    }
    payload.audios = auds
    if (auds.length && rec.platform === 'h3-cloud' && /autodl\.art/i.test(String(rec.baseUrl || ''))) {
      try {
        payload.audios = await autodlUploadImages(auds)
      } catch (e) {
        return sendJson(res, 400, { ok: false, msg: e instanceof Error ? e.message : String(e) })
      }
    }
  }
  /**
   * ★ 2026-10-08 真机实报（云端服务器收不到参考图）—— **不许静默**。
   *   卡内上传的参考如果是 `localmedia:<id>` 伪协议，服务端 `toRemoteImage()` 认不出来会
   *   直接丢掉那一张；全都被丢时 `images` 为空 ⇒ 平台收到的请求体里没有 images（对方按文档验收
   *   就报"reference_count = 0"）。这里改成：**客户端确实给了参考图、却一张都没转成可发送地址**时，
   *   当面报错并说清怎么办，而不是偷偷按"文生"提交。
   */
  const refsFromClient = Array.isArray(body.images) ? body.images.filter((x) => typeof x === 'string' && x) : []
  if (refsFromClient.length && !images.length) {
    return sendJson(res, 400, {
      ok: false,
      msg: '参考图都没能转成可发送的地址（多半是没落盘/本地副本已丢）｜怎么办：'
        + '把那张参考卡删掉后重新上传一次；若还在，确认程序已正常启动再重试',
    })
  }

  const task = {
    id: randomUUID(), status: 'running', url: '', error: '', abort: false, createdAt: Date.now(),
    // 落盘要用的上下文 (重启后靠这些 + remoteId 继续轮询)
    providerId: String(body.providerId || ''), model: String(body.model || ''),
    prompt: String(body.prompt || '').slice(0, 500),
    /**
     * 发起这次生成的**画布卡片 id** (2026-09-23 修"云端视频在卡片上会丢失"):
     *   用户提交后关程序/刷新, 云端照样在出片 —— 有这个 id, 程序再打开时就能把产物
     *   **补回那张卡**; 没有的话只能塞进「历史」, 卡片在用户眼里就是空的。
     */
    nodeId: String(body.nodeId || '') || undefined,
    /** 这次"要的时长 / 真正发出去的时长" —— 回来时前端要拿它跟产物实际时长对比 (2026-09-23) */
    requestedSeconds: payload.seconds ?? undefined,
  }
  cloudVideoTasks.set(task.id, task)
  saveCloudTasks()
  /**
   * 先算一次"要提交什么"(纯函数) —— 好处有两个:
   *   ① 时长被平台上限夹过时, 立刻回一句人话给前端 Toast, 不用等出片才知道 (2026-09-23);
   *   ② 同一份请求直接交给下面的任务用, 不重复构造、日志也只打一行。
   */
  let pre
  try {
    pre = buildVideoRequest(rec, payload)
  } catch (e) {
    cloudVideoTasks.delete(task.id)
    saveCloudTasks()
    return sendJson(res, 400, { ok: false, msg: e instanceof Error ? e.message : String(e) })
  }
  void runCloudVideoTask(task, rec, payload, pre)   // 异步跑, 前端轮询
  sendJson(res, 200, {
    ok: true, id: task.id,
    sentSeconds: pre.sentSeconds, requestedSeconds: pre.requestedSeconds,
    note: pre.durationNote || undefined,
  })
}

function handleCloudVideoStatus(req, res) {
  const q = new URL(req.url ?? '/', 'http://x').searchParams
  const t = cloudVideoTasks.get(q.get('id') ?? '')
    if (!t) return sendJson(res, 404, { ok: false, msg: '生视频失败：任务查不到了｜怎么办：回卡片重新点「生成」' })
  sendJson(res, 200, {
    ok: true, status: t.status, url: t.url, error: t.error,
    /** 服务端已经把产物落进 data/assets 时给这个(前端优先用它, 省一次下载) */
    savedPath: t.savedPath || '',
    elapsed: (t.finishedAt || Date.now()) - t.createdAt,
    /** 提交时的时长口径 —— 前端用它跟"产物实际时长"对比, 不一致就提醒用户 (2026-09-23) */
    sentSeconds: t.sentSeconds ?? undefined,
    /** 平台侧回传的真实进度(0-100)+阶段文案 —— 画布识别到 progress 就按真进度爬进度条, 没有则退回旧的秒数兜底 (2026-10-14, 见 h3-cloud 进度回传) */
    progress: t.cloudProgress ?? undefined,
    stageText: t.cloudStageText ?? undefined,
    requestedSeconds: t.requestedSeconds ?? undefined,
  })
}

async function handleCloudVideoCancel(req, res) {
  const body = await readBody(req, res)
  const t = cloudVideoTasks.get(String(body.id || ''))
  if (t) {
    t.abort = true
    // 明确告诉用户: 我们只能停止"等结果", 远端任务本身取消不了
    if (t.status === 'running') t.error = '已取消（平台那边的任务可能仍会跑完，产出不会再收回来）'
    t.status = t.status === 'done' ? 'done' : 'error'
    t.finishedAt = Date.now()
    saveCloudTasks()
  }
  sendJson(res, 200, { ok: true })
}

/**
 * 重启后要"送还给用户"的云端任务 (2026-09-18):
 *   程序关着的时候云端出片了 → 服务端已经把视频落进 data/assets。
 *   前端启动时拉这个列表, 把结果补进生成历史 + 提示一句, 再 ack 掉。
 */
function handleCloudVideoPending(req, res) {
  const out = []
  for (const t of cloudVideoTasks.values()) {
    if (t.claimed) continue
    if (t.status !== 'done' && t.status !== 'error') continue
    out.push({
      id: t.id, status: t.status, url: t.url, savedPath: t.savedPath || '',
      error: t.error || '', prompt: t.prompt || '', model: t.model || '',
      /** 属于哪张画布卡片 —— 前端靠它把产物补回卡片(2026-09-23) */
      nodeId: t.nodeId || '',
      at: t.finishedAt || t.createdAt || 0, elapsed: t.elapsed || 0,
    })
  }
  out.sort((a, b) => a.at - b.at)
  sendJson(res, 200, { ok: true, tasks: out.slice(-20) })
}

async function handleCloudVideoAck(req, res) {
  const body = await readBody(req, res)
  const ids = Array.isArray(body?.ids) ? body.ids.map(String) : [String(body?.id ?? '')]
  for (const id of ids) {
    const t = cloudVideoTasks.get(id)
    if (t) t.claimed = true
  }
  saveCloudTasks()
  sendJson(res, 200, { ok: true })
}

// ---------------------------------------------------------------- 云端文字生成
// POST /api/cloud-text  { providerId, model, prompt | messages, temperature?, maxTokens?, tools?, toolChoice? }
// 只走 OpenAI 兼容 chat/completions (火山方舟 / 阿里百炼兼容模式 / 魔搭 / 自定义 都吃这个形状)。
// 明文 key 始终留在服务端, 前端只拿结果。
/**
 * 真流式文字：把上游 chat/completions 的 SSE 转成 NDJSON 给 Electron 渲染层。
 * 事件：{"type":"text","delta":"..."} / {"type":"done","toolCalls":[...]} / {"type":"error",...}
 * 上游拒绝 tools 时返回 nativeToolsUnsupported=true，前端退回非流式兼容路径。
 */
async function streamCloudText(res, rec, payload, nativeTools, signal) {
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  const send = (event) => {
    if (res.writableEnded) return
    res.write(`${JSON.stringify(event)}\n`)
  }
  const path = rec.types?.text?.path || typeDef(rec, 'text')?.path || '/v1/chat/completions'
  let out
  try {
    out = await fetch(joinUrl(rec.baseUrl, path), {
      method: 'POST',
      headers: { ...authHeaders(rec), Accept: 'text/event-stream' },
      body: JSON.stringify({ ...payload, stream: true }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
    })
  } catch (e) {
    send({ type: 'error', message: `生成文字失败：${e instanceof Error ? e.message : String(e)}` })
    res.end()
    return
  }
  if (out.status < 200 || out.status >= 300) {
    const bodyText = await out.text().catch(() => '')
    send({
      type: 'error',
      nativeToolsUnsupported: nativeTools.length > 0
        && /tool|function|unsupported|not\s*support|invalid[^\n]*(?:parameter|argument)|参数[^\n]*(?:不支持|无效)/i.test(bodyText),
      message: friendlyCloudError({ action: '生成文字', status: out.status, body: bodyText, url: out.url }),
    })
    res.end()
    return
  }
  const reader = out.body?.getReader()
  if (!reader) {
    send({ type: 'error', message: '生成文字失败：平台没有返回流式响应' })
    res.end()
    return
  }
  const decoder = new TextDecoder()
  const calls = []
  let buffer = ''
  let usage = null
  let sentAny = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        let chunk
        try { chunk = JSON.parse(data) } catch { continue }
        if (chunk?.usage) usage = chunk.usage
        const delta = chunk?.choices?.[0]?.delta
        if (!delta) continue
        const content = delta.content
        const text = Array.isArray(content)
          ? content.map((part) => typeof part === 'string' ? part : (part?.text || '')).filter(Boolean).join('')
          : (typeof content === 'string' ? content : '')
        if (text) {
          sentAny = true
          send({ type: 'text', delta: text })
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            const index = Number(call?.index) || 0
            const entry = calls[index] || (calls[index] = { id: '', name: '', arguments: '' })
            if (call?.id) entry.id = String(call.id)
            const fn = call?.function || {}
            if (fn?.name) entry.name = String(fn.name)
            if (fn?.arguments) entry.arguments += String(fn.arguments)
          }
        }
      }
    }
  } catch (e) {
    if (!res.writableEnded) {
      send({ type: 'error', message: `生成文字失败：${e instanceof Error ? e.message : String(e)}` })
    }
    res.end()
    return
  }
  const toolCalls = calls.filter((call) => call && call.name).map((call, index) => ({
    id: call.id || `cloud-stream-tool-${Date.now().toString(36)}-${index}`,
    name: call.name,
    arguments: call.arguments || '{}',
  }))
  if (!sentAny && !toolCalls.length) {
    send({ type: 'error', message: '生成文字失败：平台没有返回文字或工具调用' })
  } else {
    send({ type: 'done', toolCalls, usage })
  }
  res.end()
}

async function handleCloudText(req, res) {
  const body = await readBody(req, res)
  const rec = store.getById(String(body.providerId || ''))
    if (!rec || !apiKeyOf(rec) || rec.enabled === false) {
      return sendJson(res, 400, { ok: false, msg: '生成文字失败：这条 API 连接不可用｜怎么办：去顶栏「API」面板检查' })
    }
    if (shapeOf(rec, 'text') !== 'openai-chat') {
      return sendJson(res, 400, { ok: false, msg: `生成文字失败：这不是文字接口｜怎么办：改用「自定义」连接，核对请求地址｜响应形态：${shapeOf(rec, 'text')}` })
    }
    const model = String(body.model || '').trim()
    if (!model) return sendJson(res, 400, { ok: false, msg: '生成文字失败：还没选模型｜怎么办：在卡片的「模型」下拉里选一个' })
  const path = rec.types?.text?.path || typeDef(rec, 'text')?.path || '/v1/chat/completions'
  const messages = Array.isArray(body.messages) && body.messages.length
    ? body.messages
    : [{ role: 'user', content: String(body.prompt || '') }]
  const payload = { model, messages }
  if (body.temperature != null) payload.temperature = Number(body.temperature)
  if (body.maxTokens != null) payload.max_tokens = Number(body.maxTokens)
  const nativeTools = Array.isArray(body.tools)
    ? body.tools.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const name = String(item.name || '').trim()
      if (!name) return []
      return [{
        type: 'function',
        function: {
          name,
          description: String(item.description || ''),
          parameters: item.parameters && typeof item.parameters === 'object'
            ? item.parameters
            : { type: 'object', properties: {} },
        },
      }]
    }).slice(0, 64)
    : []
  if (nativeTools.length) {
    payload.tools = nativeTools
    payload.tool_choice = body.toolChoice === 'required' ? 'required' : 'auto'
  }
  try {
    /**
     * 2026-09-27: 前端"取消"→ 浏览器断掉这条 HTTP → 这里也把上游请求断掉。
     *   否则用户在卡片上点了取消, 云平台的生成还在自己跑(白花额度/时间),
     *   而且前端要等它返回才收得回进度条。
     */
    const abortCtl = new AbortController()
    res.on('close', () => { if (!res.writableEnded) abortCtl.abort() })
    if (body.stream === true) {
      return await streamCloudText(res, rec, payload, nativeTools, abortCtl.signal)
    }
    // 排队/限流(429/503)自动退避重试 —— 聚合平台高峰期很常见, 直接报错用户只会看到"生成不了"
    let out = await postWithBusyRetry({
      url: joinUrl(rec.baseUrl, path),
      headers: authHeaders(rec),
      body: payload,
      timeoutMs: Number(body.timeoutMs) || 180_000,
      logTag: 'cloud-text',
      signal: abortCtl.signal,
    })
    let nativeToolsUnsupported = false
    if (nativeTools.length && out.status >= 400 && out.status < 500
      && /tool|function|unsupported|not\s*support|invalid[^\n]*(?:parameter|argument)|参数[^\n]*(?:不支持|无效)/i.test(out.text)) {
      /**
       * 聚合平台与部分模型的兼容层会直接拒绝 tools / tool_choice。
       * 只在错误明确指向工具能力时重试一次“无工具”请求；普通鉴权、余额、
       * 模型不存在等错误必须原样暴露，不能靠重试掩盖。
       */
      nativeToolsUnsupported = true
      const fallback = { ...payload }
      delete fallback.tools
      delete fallback.tool_choice
      out = await postWithBusyRetry({
        url: joinUrl(rec.baseUrl, path),
        headers: authHeaders(rec),
        body: fallback,
        timeoutMs: Number(body.timeoutMs) || 180_000,
        logTag: 'cloud-text-json-fallback',
        signal: abortCtl.signal,
      })
    }
    const txt = out.text
    if (out.status < 200 || out.status >= 300) {
      return sendJson(res, 400, { ok: false, msg: friendlyCloudError({
        action: '生成文字', status: out.status, body: txt, url: out.url,
        extra: out.tries > 1 ? `已自动重试 ${out.tries} 次` : '',
      }) })
    }
      let j
      try { j = JSON.parse(txt) } catch {
        return sendJson(res, 400, { ok: false, msg: `生成文字失败：这不是接口地址｜怎么办：核对「高级」里的请求地址｜平台原话：${txt.slice(0, 120)}` })
      }
      const content = j?.choices?.[0]?.message?.content ?? j?.output?.text ?? j?.text ?? ''
      const text = Array.isArray(content)
        ? content.map((part) => {
          if (typeof part === 'string') return part
          if (part && typeof part === 'object' && typeof part.text === 'string') return part.text
          return ''
        }).filter(Boolean).join('\n')
        : String(content ?? '')
      const message = j?.choices?.[0]?.message || {}
      const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      const calls = rawCalls.flatMap((call, index) => {
        if (!call || typeof call !== 'object') return []
        const fn = call.function && typeof call.function === 'object' ? call.function : call
        const name = String(fn?.name || '').trim()
        if (!name) return []
        return [{
          id: String(call.id || `cloud-tool-${Date.now().toString(36)}-${index}`),
          name,
          arguments: typeof fn?.arguments === 'string' ? fn.arguments : JSON.stringify(fn?.arguments ?? {}),
        }]
      })
      const legacyFn = message.function_call && typeof message.function_call === 'object'
        ? message.function_call
        : null
      if (legacyFn && String(legacyFn.name || '').trim()) {
        calls.push({
          id: `cloud-tool-${Date.now().toString(36)}-legacy`,
          name: String(legacyFn.name).trim(),
          arguments: typeof legacyFn.arguments === 'string'
            ? legacyFn.arguments
            : JSON.stringify(legacyFn.arguments ?? {}),
        })
      }
      if (!text && !calls.length) {
        return sendJson(res, 400, { ok: false, msg: `生成文字失败：平台没返回文字｜怎么办：换一个对话类模型再试｜平台原话：${JSON.stringify(j).slice(0, 120)}` })
      }
    sendJson(res, 200, {
      ok: true,
      text,
      toolCalls: calls,
      nativeToolsUnsupported,
      model,
      usage: j?.usage ?? null,
    })
  } catch (e) {
    sendJson(res, 400, { ok: false, msg: e instanceof Error ? e.message : String(e) })
  }
}

// ---------------------------------------------------------------- 云端图片生成
// POST /api/cloud-image { providerId, model, prompt, size?, n? } → { url }
// 走 OpenAI 兼容 images/generations(url 或 b64_json 两种返回都吃)。

/** 递归找图片地址(各家字段不一: data[].url / output_images[] / images[].url / url) */
function extractImageUrl(j, depth = 0) {
  if (!j || typeof j !== 'object' || depth > 4) return ''
  if (typeof j.url === 'string' && /^(https?:|data:)/.test(j.url)) return j.url
  if (typeof j.image_url === 'string' && j.image_url) return j.image_url
  // 阿里百炼 DashScope: 图片在 output.results[].url; qwen-image 走多模态接口时在
  // output.choices[0].message.content[].image —— 都靠下面的递归 + 这里的 image 字段兜住。
  if (typeof j.image === 'string' && /^(https?:|data:)/.test(j.image)) return j.image
  for (const k of ['output_images', 'images', 'data', 'outputs', 'results', 'result', 'output', 'content', 'choices', 'message']) {
    const v = j[k]
    if (Array.isArray(v) && v.length) {
      const f = v[0]
      if (typeof f === 'string' && /^(https?:|data:)/.test(f)) return f
      const u = extractImageUrl(f, depth + 1)
      if (u) return u
    } else if (v && typeof v === 'object') {
      const u = extractImageUrl(v, depth + 1)
      if (u) return u
    }
  }
  return ''
}

/**
 * 异步出图平台(魔搭这类)的任务轮询: 提交返回 task_id → GET {poll} + 专用请求头 → 取图。
 * 没有配 poll 的平台直接返回空串(走同步分支)。
 */
async function pollCloudImage(rec, taskId, timeoutMs = 300_000) {
  const def = typeDef(rec, 'image') || {}
  const tpl = def.poll
  if (!tpl) return ''
  const url = joinUrl(rec.baseUrl, tpl.replace('{id}', encodeURIComponent(taskId)))
  const headers = { ...authHeaders(rec), ...(def.pollHeaders || {}) }
  const deadline = Date.now() + timeoutMs
  let last = '(还没拿到状态)'
  while (Date.now() < deadline) {
    await sleep(3000)
    let r
    try {
      r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
    } catch (e) { last = `轮询请求失败(${e?.message ?? e})`; continue }   // 瞬时网络错误 → 继续轮询
    if (!r.ok) { last = `轮询 HTTP ${r.status}`; continue }
    const j = await r.json().catch(() => null)
    if (!j) { last = '轮询响应非 JSON'; continue }
    // 任务状态可能在三处: 顶层(魔搭/硅基) / output 里(阿里百炼) / status
    const st = String(j.task_status ?? j.status ?? j.output?.task_status ?? '').toLowerCase()
    const u = extractImageUrl(j)
    if (u && !/fail|error|cancel/.test(st)) return u
      if (/fail|error|cancel/.test(st)) {
        const detail = j.errors ?? j.error ?? j.output?.message ?? j.message ?? j.output ?? j
        const detailText = typeof detail === 'string' ? detail : JSON.stringify(detail)
        throw new Error(`出图失败：平台说任务失败（${st}）｜怎么办：${failedTaskHint(detailText)}｜平台原话：${detailText.slice(0, 120)}`)
      }
    last = `任务还在跑(${st || '进行中'})`
  }
  // 把"最后一次状态"一起抛出去 —— 免费档排队时, 用户看到的应该是"排队太久"而不是干巴巴一句超时
    throw new Error(`出图失败：排队超 ${Math.round(timeoutMs / 60000)} 分钟｜怎么办：过几分钟再点一次生成｜最后状态：${last}`)
}

/**
 * DashScope(阿里百炼)的尺寸串规则:
 *   · 分隔符是 `*`(1280*720), 卡片给的 `1280x720` 原样发过去会被判 InvalidParameter;
 *   · qwen-image-2.0 系: 官方要求**总像素在 512*512 ~ 2048*2048 之间**(4K 级别的 2048*2048=4.19M),
 *     比例保持不变, 超了就按面积等比缩, 不够就放大;
 *   · 宽高都对齐到 8 的倍数(avoid 出现 1927*1084 这类值)。
 */
function dashscopeSize(size, dflt = '1024*1024', minPx = 512 * 512, maxPx = 2048 * 2048) {
  const m = String(size || '').match(/^(\d+)\s*[xX*]\s*(\d+)$/)
  if (!m) return dflt
  let w = Number(m[1]); let h = Number(m[2])
  const px = w * h
  if (px > maxPx) { const k = Math.sqrt(maxPx / px); w = Math.round(w * k); h = Math.round(h * k) }
  else if (px < minPx) { const k = Math.sqrt(minPx / px); w = Math.round(w * k); h = Math.round(h * k) }
  const snap = (v) => Math.max(64, Math.round(v / 8) * 8)
  return `${snap(w)}*${snap(h)}`
}

/** 在给定比例集合里挑最接近的(比较对数比, 避免"竖图被判成横图") */
function nearestRatio(size, supported = AGNES_RATIOS) {
  const m = String(size || '').match(/^(\d+)\s*[xX*]\s*(\d+)$/)
  if (!m) return supported[0]
  const want = Number(m[1]) / Number(m[2])
  let best = supported[0]
  let bestDiff = Infinity
  for (const r of supported) {
    const [a, b] = r.split(':').map(Number)
    const diff = Math.abs(Math.log((a / b) / want))
    if (diff < bestDiff) { bestDiff = diff; best = r }
  }
  return best
}

/**
 * Agnes 图片的 size 只吃档位 1K/2K/3K/4K(确切像素不是它的原生输出, 会被归一化) —— 按短边像素推档。
 * 卡片的 720P(1280x720 短边 720) → 1K; 1080P(1920x1080) → 2K; 480P(856x480) → 1K。
 */
function agnesImageTier(size) {
  const s = String(size || '')
  if (/^[1-4]K$/i.test(s)) return s.toUpperCase()
  const m = s.match(/^(\d+)\s*[xX*]\s*(\d+)$/)
  if (!m) return '1K'
  const short = Math.min(Number(m[1]), Number(m[2]))
  if (short >= 2500) return '4K'
  if (short >= 1500) return '3K'
  if (short >= 1024) return '2K'
  return '1K'
}

async function handleCloudImage(req, res) {
  const body = await readBody(req, res)
  const rec = store.getById(String(body.providerId || ''))
    if (!rec || !apiKeyOf(rec) || rec.enabled === false) {
      return sendJson(res, 400, { ok: false, msg: '生图失败：这条 API 连接不可用｜怎么办：去顶栏「API」面板检查' })
    }
    const imgShape = shapeOf(rec, 'image')
    if (imgShape !== 'openai-image' && imgShape !== 'dashscope-image') {
      return sendJson(res, 400, { ok: false, msg: `生图失败：这不是图片接口｜怎么办：改用「自定义」连接，核对请求地址｜响应形态：${imgShape}` })
    }
    const model = String(body.model || '').trim()
    if (!model) return sendJson(res, 400, { ok: false, msg: '生图失败：还没选模型｜怎么办：在卡片的「模型」下拉里选一个' })
    const prompt = String(body.prompt || '').trim()
    if (!prompt) return sendJson(res, 400, { ok: false, msg: '生图失败：还没写提示词｜怎么办：在卡片的输入框里写一句画面描述' })
  const path = rec.types?.image?.path || typeDef(rec, 'image')?.path || '/v1/images/generations'
  const imgDef = typeDef(rec, 'image') || {}
  const base = { model, prompt, ...(imgDef.extraTop || {}) }
  // 少数平台没有 n 参数(Agnes) —— 带上会被判非法字段
  if (!imgDef.dropN) base.n = Number(body.n) > 0 ? Number(body.n) : 1
  if (body.size) {
    // 有的平台只认**档位**(Agnes: 1K/2K/3K/4K)+ 比例, 不认 1280x720 这类确切尺寸
    const skipSize = imgDef.sizeSkipIfModel && imgDef.sizeSkipIfModel.test(model)
    if (imgDef.sizeTier === 'agnes') base.size = agnesImageTier(body.size)
    else if (imgDef.sizeField === 'image_size') { if (!skipSize) base.image_size = String(body.size) }
    else base.size = String(body.size)
  }
  if (imgDef.ratioSet) base.ratio = nearestRatio(body.size, imgDef.ratioSet)

  // ── 参考改图(图生图) ──
  // 实测(2026-09-15): 硅基流动与魔搭都走**同一个 images/generations**, 用 `image` 传参考图
  //   (字符串: dataURL 或 http URL), 且**必须带 image_size**(只给 size 会报参数无效)。
  //   返回: 硅基流动同步给 images[0].url; 魔搭是异步任务(见下方 pollCloudImage)。
  const refs = []
  for (const s of (Array.isArray(body.images) ? body.images.slice(0, 3) : [])) {
    try {
      const u = await toRemoteImage(s)
      if (u) refs.push(u)
    } catch (e) {
      return sendJson(res, 400, { ok: false, msg: e instanceof Error ? e.message : String(e) })
    }
  }
  // 有的平台把"附加参数"和"参考图"都放在 extra_body 里(Agnes), 不许出现在顶层
  const extraBody = { ...(imgDef.extraBody || {}) }
  if (refs.length) {
    const edit = imgDef.edit || {}
    const editField = edit.field || 'image'
    const editArr = !!edit.array
    if (edit.inExtraBody) {
      extraBody[editField] = editArr ? refs : refs[0]
    } else if (edit.extraFields && (!edit.extraIfModel || edit.extraIfModel.test(model))) {
      // 硅基流动: 官方多参考走 image / image2 / image3 三个字段(仅 Qwen-Image-Edit-2509)
      base[editField] = refs[0]
      refs.slice(1, 1 + edit.extraFields.length).forEach((u, i) => { base[edit.extraFields[i]] = u })
    } else {
      // 多数平台(uptime: 火山/魔搭/自定义)参考图就是顶层一个字段, 尺寸字段照旧保留
      // singleIfOne: 官方参数表写 string 的平台(魔搭 image_url), 只有一张时给字符串
      base[editField] = editArr && !(edit.singleIfOne && refs.length === 1) ? refs : refs[0]
    }
  }
  if (Object.keys(extraBody).length) base.extra_body = extraBody
  // 排障: 只打形状/字段名/参考图张数, 不打内容
  log(`[cloud-image] ${rec.name} ${refs.length ? `改图 refs=${refs.length}(${typeDef(rec, 'image')?.edit?.array ? '数组' : '仅首张'})` : '文生图'} 形状=${imgShape} 字段=[${Object.keys(base).join(',')}] 尺寸=${base.image_size || base.size || '(未传)'}`)
  const timeoutMs = Number(body.timeoutMs) || 300_000
  /** 发一次; 返回里带上**真实 URL** —— 报 404/400 时用户才知道是哪个地址出的问题 */
  const call = async (payload, pathOverride, extraHeaders) => {
    const full = joinUrl(rec.baseUrl, pathOverride || path)
    return await postWithBusyRetry({
      url: full,
      headers: { ...authHeaders(rec), ...(imgDef.watermarkHeader || {}), ...(extraHeaders || {}) },
      body: payload,
      timeoutMs,
      logTag: 'cloud-image',
    })
  }

  try {
    // 报错统一走 friendlyCloudError: 大白话结论 + 一句"怎么办" + 平台原话(放最后)
    const fail = (out) => sendJson(res, 400, {
      ok: false,
      msg: friendlyCloudError({
        action: '生图', status: out?.status ?? 0, body: out?.text ?? '', url: out?.url ?? path,
        extra: (out?.tries ?? 1) > 1 ? `已自动重试 ${out.tries} 次` : '',
      }),
    })

    // ── 阿里百炼: 走 DashScope 原生异步出图 ──
    // 它**没有** OpenAI 兼容的 images/generations(那地址实测 404), 出图要:
    //   POST {多模态端点|text2image} + X-DashScope-Async: enable → output.task_id → 轮询 /api/v1/tasks/{id}
    if (imgShape === 'dashscope-image') {
      const d = typeDef(rec, 'image') || {}
      // 官方两条路: qwen-image 系 = 多模态同步(input.messages); wanx 系 = text2image 异步(input.prompt)
      const isQwenImage = !!d.qwenMultimodal && /qwen-image|qwen-vl|qwen-image-edit/i.test(model)
      const endpoints = [...new Set(
        (isQwenImage
          ? [rec.types?.image?.path, d.submit, ...(d.submitAlt || [])]
          : refs.length
            // 带参考图的非 qwen 模型: 官方改图端点是 image2image, 先试它
            ? [rec.types?.image?.path, '/api/v1/services/aigc/image2image/image-synthesis', ...(d.submitAlt || []), d.submit]
            : [rec.types?.image?.path, ...(d.submitAlt || []), d.submit]
        ).filter(Boolean),
      )]
      const parameters = { size: dashscopeSize(body.size), n: 1, watermark: false }
      let out = null
      for (const p of endpoints) {
        const payload = isQwenImage
          // qwen-image: content 里放 {text} 与参考图 {image}(data:base64 官方支持)
          ? {
              model,
              input: { messages: [{ role: 'user', content: [...refs.map((u) => ({ image: u })), { text: prompt }] }] },
              parameters,
            }
          // wanx 系: 文生图 input.prompt; 带参考图的改图走官方的 image2image(base_image_url)
          : { model, input: refs.length ? { prompt, base_image_url: refs[0] } : { prompt }, parameters }
        // qwen-image 官方推荐同步(一次拿结果); wanx 必须异步
        out = await call(payload, p, isQwenImage ? {} : { 'X-DashScope-Async': 'enable' })
        if (out.status !== 404) break      // 404 = 这个模型不走这条端点 → 换下一条试
      }
      if (!out || out.status < 200 || out.status >= 300) return fail(out)
        let j
        try { j = JSON.parse(out.text) } catch {
          return sendJson(res, 400, { ok: false, msg: `生图失败：平台返回的不是数据｜怎么办：核对「高级」里的请求地址｜平台原话：${out.text.slice(0, 120)}` })
        }
      let imgUrl = extractImageUrl(j)
      const taskId = j?.output?.task_id || j?.task_id || ''
      if (!imgUrl && taskId && d.poll) imgUrl = await pollCloudImage(rec, String(taskId), Number(d.pollTimeoutMs) || timeoutMs)
        if (!imgUrl) return sendJson(res, 400, { ok: false, msg: `生图失败：平台没返回图片地址｜怎么办：去百炼控制台复制模型 ID｜平台原话：${JSON.stringify(j).slice(0, 120)}` })
      /**
       * ★ 2026-10-30: 云端产物**在服务端就落盘**，不再等前端记得调 /api/assets/localize。
       *   用户原话「我需要的是云端也自动落盘到本地，素材问题是底线」——
       *   以前前端一关 / 那一次下载失败，这条产物就只剩一个会过期的临时链接。
       *   落不下来会进持久重试队列（localizeReturnUrl 内部），返回值里如实标 localized/pending。
       */
      const loc = await localizeReturnUrl(imgUrl)
      return sendJson(res, 200, { ok: true, url: loc.url, remote: loc.remote, localized: loc.localized, pending: loc.pending, model })
    }

    // response_format 不是每个平台都认 → 先带, 400 时去掉再试一次
    // (Agnes 是"顶层带它就直接报错", 所以它的 response_format 走 extra_body, 这里不能加)
    const topLevelFormat = (imgDef.extraBody?.response_format || imgDef.dropTopResponseFormat)
      ? base
      : { ...base, response_format: 'url' }
    let out = await call(topLevelFormat)
    if (out.status === 400 && /response_format/i.test(out.text)) out = await call(base)
    // 字段校验严格的平台(多带一个 n / size 就 400) → 用最小体再试一次(仅纯文生图; 改图不能丢参考图)
    if (out.status === 400 && !refs.length
      && /invalid|unknown|unexpected|unsupported|unrecognized|extra|not allowed|不支持|无效/i.test(out.text)) {
      out = await call({ model, prompt })
    }
    if (out.status < 200 || out.status >= 300) {
      return fail(out)
    }
      let j
      try { j = JSON.parse(out.text) } catch {
        return sendJson(res, 400, { ok: false, msg: `生图失败：这不是图片接口｜怎么办：核对「高级」里的请求地址｜平台原话：${out.text.slice(0, 120)}` })
      }
    const item = Array.isArray(j?.data) ? j.data[0] : null
    let imgUrl = item?.url || item?.image_url || ''
    if (!imgUrl && item?.b64_json) imgUrl = `data:image/png;base64,${item.b64_json}`
    if (!imgUrl) imgUrl = extractImageUrl(j)
    // 异步出图平台(魔搭): 提交只回 task_id → 轮询任务直到出图
    if (!imgUrl) {
      const taskId = j?.task_id || j?.requestId || j?.request_id || j?.output?.task_id || ''
      if (taskId && (typeDef(rec, 'image')?.poll)) {
        imgUrl = await pollCloudImage(rec, String(taskId), Number(typeDef(rec, 'image')?.pollTimeoutMs) || timeoutMs)
      }
    }
      if (!imgUrl) return sendJson(res, 400, { ok: false, msg: `生图失败：平台没返回图片地址｜怎么办：从文档复制完整的出图模型 ID｜平台原话：${JSON.stringify(j).slice(0, 120)}` })
    /** ★ 2026-10-30: 同 qwen 分支 —— 出图即在服务端落盘，落不下来进重试队列 */
    const loc2 = await localizeReturnUrl(imgUrl)
    sendJson(res, 200, { ok: true, url: loc2.url, remote: loc2.remote, localized: loc2.localized, pending: loc2.pending, model, revisedPrompt: item?.revised_prompt ?? null })
  } catch (e) {
    sendJson(res, 400, { ok: false, msg: e instanceof Error ? e.message : String(e) })
  }
}

// ---------------------------------------------------------------- 诊断与错误分类
// 设计原则:
//   1) 判定放在服务端做一次, 前端只负责显示 —— 避免两边各写一套分类逻辑慢慢跑偏
//   2) "导出日志"给用户的是一个 zip, 里面 00-摘要.txt 是人话结论, 06-后端日志/ 是关键证据
//   3) 强制脱敏: key/token/secret 一律不进包
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')

/** 全后端是否已就绪 —— 用于时间线去重(只在翻转点记一次) */
let lastAllReady = false

/** 启动时间线: 区分"慢"和"死", 也是故障复盘的第一手材料 */
const STARTUP_TIMELINE = []
function timeline(event, extra) {
  try {
    STARTUP_TIMELINE.push({ t: Date.now(), event, ...(extra ? { extra } : {}) })
    if (STARTUP_TIMELINE.length > 600) STARTUP_TIMELINE.shift()
  } catch { /* ignore */ }
}

let capSeq = 0

/**
 * 同步跑一条外部命令 —— **输出走临时文件, 不走管道**(2026-10-06 卡死事故后定死)。
 *
 * 为什么不再用 `execFileSync`: 它在 Windows 上要等 stdout/stderr 管道拿到 **EOF** 才返回。
 *   只要被拉起的那个进程把句柄留给了孙子进程(或者它自己卡在驱动调用里), 就算 `timeout`
 *   到了, 父进程也可能永远等下去 —— 而这发生在 **Electron 主进程**里, 一挂就是窗口点不动 +
 *   本地服务全不应答(2026-10-06 用户遇到的那次)。重定向到文件后, spawnSync 只需等
 *   **子进程退出**, timeout 才真正可打断。
 *
 * 语义与 execFileSync 一致: 返回 stdout; 非零退出/超时则抛错(错误对象带 .status/.stdout/.stderr)。
 */
function execCapture(cmd, args, { timeout = 20000, windowsHide = true } = {}) {
  const base = path.join(os.tmpdir(), `aics-cap-${process.pid}-${++capSeq}`)
  const outPath = `${base}.out`
  const errPath = `${base}.err`
  let ofd = null
  let efd = null
  try {
    ofd = fs.openSync(outPath, 'w')
    efd = fs.openSync(errPath, 'w')
    const r = spawnSync(cmd, args, { timeout, windowsHide, stdio: ['ignore', ofd, efd] })
    const so = fs.readFileSync(outPath, 'utf8')
    const se = fs.readFileSync(errPath, 'utf8')
    if (!r || r.error || r.status !== 0) {
      const e = new Error(r?.error?.message || `${cmd} 退出码 ${r?.status ?? '?'}`)
      e.status = r?.status ?? null
      e.stdout = so
      e.stderr = se
      throw e
    }
    return so
  } finally {
    try { if (ofd !== null) fs.closeSync(ofd) } catch { /* ignore */ }
    try { if (efd !== null) fs.closeSync(efd) } catch { /* ignore */ }
    try { fs.unlinkSync(outPath) } catch { /* ignore */ }
    try { fs.unlinkSync(errPath) } catch { /* ignore */ }
  }
}

/** 跑一条外部命令并拿到输出; 失败也返回可读文本(不抛) */
function runCapture(cmd, args, timeout = 20000) {
  try {
    return execCapture(cmd, args, { timeout }) || ''
  } catch (e) {
    const head = `[command failed: ${cmd} ${args.join(' ')}] exit=${e?.status ?? '?'}`
    return `${head}\n${e?.stdout ?? ''}${e?.stderr ?? ''}`.trim() + '\n'
  }
}

/**
 * **异步**版 execCapture —— 只在"一条命令要跑几百毫秒以上、又不能卡住界面"的地方用。
 *
 * ⚠️ 为什么必须有它(同一课, 踩过两次): 本地服务与窗口**共用一条线程**, 同步等子进程 =
 *   等待期间整个软件假死。`execCapture` 的注释里记着 2026-10-06 那次卡死事故;
 *   7z 解压那处也是从 `execFileSync` 改成了 `spawn`(见 handleModelsInstall)。
 *   但 `execCapture` 对**短命令**(几百毫秒的探测/查询)仍然合适 —— 它更简单、不会漏收输出。
 *
 * 语义: 收 stdout/stderr(各截尾 8KB, 够看报错), 到点强杀并如实返回; 永不抛、永不挂住。
 * ⚠️ 只在"子进程不会把 stdout 句柄留给孙子进程"时用(我们跑的是自己的 python, 符合)。
 */
function execCaptureAsync(cmd, args, { timeout = 30000, windowsHide = true } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { windowsHide, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ ok: false, stdout: '', stderr: String(e), status: null })
    }
    let so = ''
    let se = ''
    let settled = false
    const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v) }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      done({ ok: false, stdout: so, stderr: `${se}\n[超时 ${timeout}ms, 已强杀]`, status: null })
    }, timeout)
    child.stdout?.on('data', (d) => { so += String(d); if (so.length > 8000) so = so.slice(-8000) })
    child.stderr?.on('data', (d) => { se += String(d); if (se.length > 8000) se = se.slice(-8000) })
    child.on('error', (e) => done({ ok: false, stdout: so, stderr: `${se}${e?.message ?? e}`, status: null }))
    child.on('close', (code) => done({ ok: code === 0, stdout: so, stderr: se, status: code }))
  })
}

/**
 * 显卡信息 / 显存快照 / 每进程显存 —— 三个读入口**只读缓存, 绝不在这里跑 nvidia-smi**。
 *
 * 2026-10-06 卡死事故之后定死这条规矩:
 *   主进程 = 窗口 + 本地服务共用同一个线程(见 `app/electron/main.cjs` 的 bootServer → startServer)。
 *   而前端每 2 秒轮一次 `/api/backends/runtime`, 那条路上是
 *   `gpuMemoryCached()` → `gpuMemoryNow()` → **execFileSync(nvidia-smi)** (以及 60 秒一次的 gpuInfo())。
 *   平时一次 60~300ms, 看不出来; 可一旦 nvidia-smi 自己卡在驱动里, `execFileSync` 的 timeout
 *   在 Windows 上并不可靠 —— 它要等**管道 EOF**, 只要子进程把 stdout/stderr 句柄留给了孙子进程,
 *   父进程就会被永久挂住。结果是整个 UI 线程一起死: 窗口点不动、HTTP 全不应答、日志停在同一秒、
 *   CPU 增量 0 —— 用户看到的就是"软件开一会儿就没了, 连最大化都点不到"。
 *
 * 现在: 真正的采样全在下面的 `read*Async`(spawn, 不阻塞事件循环)。上面三个读入口只返回
 *   **最近一次采样**并顺手把到期的那部分丢给后台刷新 —— 单次读取永远 <1ms, 与驱动状态彻底解耦。
 *   允许的陈旧度: 显卡信息 60 秒 · 显存 1.5 秒 · 每进程显存 10 秒。
 *   需要"就在此刻"的读数(释放核验)走的本来就是 `gpuMemoryNowAsync()`, 不受这里影响。
 */
const GPU_SAMPLE_TTL = { info: 60_000, mem: 1_500, per: 10_000 }
const gpuSample = { info: null, infoAt: 0, mem: null, memAt: 0, perProc: {}, perAt: 0, busy: false }

/** 还没有采样结果时的占位(语义与老代码一致: present=false = 没读到独显) */
function emptyGpuInfo() {
  return { at: 0, present: false, name: '', driverVersion: '', vramTotal: 0, computeCap: null, source: '' }
}

/** nvidia-smi --query-gpu 的一行 → info; 返回是否已命中 */
function fillGpuInfoFromLine(info, ln, withCap) {
  if (!ln || ln.startsWith('[') || !ln.includes(',')) return false
  const parts = ln.split(',').map((s) => s.trim())
  const [name, drv, vram] = parts
  info.name = name || ''
  info.driverVersion = drv || ''
  info.vramTotal = Number(vram) || 0
  const cap = withCap && parts[3] ? Number(parts[3]) : NaN
  info.computeCap = Number.isFinite(cap) && cap > 0 ? cap : null
  info.present = !!drv
  info.source = 'nvidia-smi'
  return true
}

/** 异步读显卡信息(带注册表兜底) */
async function readGpuInfoAsync() {
  const info = emptyGpuInfo()
  const smi = path.join(SYS32, 'nvidia-smi.exe')
  const exe = fs.existsSync(smi) ? smi : 'nvidia-smi'
  // 先带 compute_cap 查(配置门槛要用): 老驱动/老 nvidia-smi 不认这个字段会整条失败,
  // 所以拿不到结果时退回不带它的查询 —— 不能因为一个可选字段丢掉整块显卡信息。
  let out = await runCaptureAsync(exe, ['--query-gpu=name,driver_version,memory.total,compute_cap', '--format=csv,noheader,nounits'], 12000)
  const withCap = /,/.test(String(out))
  if (!withCap) {
    out = await runCaptureAsync(exe, ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader,nounits'], 12000)
  }
  for (const raw of String(out).split(/\r?\n/)) {
    if (fillGpuInfoFromLine(info, raw.trim(), withCap)) break
  }
  if (!info.present) {
    // 兜底: 注册表。驱动版本形如 32.0.16.1088 -> NVIDIA 版本 610.88 (取后 5 位加小数点)
    for (const idx of ['0000', '0001']) {
      const key = `HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\${idx}`
      const desc = await runCaptureAsync(path.join(SYS32, 'reg.exe'), ['query', key, '/v', 'DriverDesc'], 8000)
      const ver = await runCaptureAsync(path.join(SYS32, 'reg.exe'), ['query', key, '/v', 'DriverVersion'], 8000)
      const mv = ver.match(/REG_SZ\s+([0-9.]+)/)
      const md = desc.match(/REG_SZ\s+(.+)/)
      if (mv) {
        const digits = mv[1].replace(/\./g, '')
        const tail = digits.slice(-5)
        info.driverVersion = tail.length === 5 ? `${Number(tail.slice(0, 3))}.${tail.slice(3)}` : mv[1]
        info.name = (md?.[1] ?? '').trim()
        info.present = /nvidia/i.test(info.name)
        info.source = 'registry'
        break
      }
    }
  }
  /**
   * 排障/自测钩子: 强制一个驱动版本号 (`set AICS_FAKE_DRIVER=560.50`)。
   *
   * 为什么要留这个口子: 驱动判定的**文案分支**是给"我们手上没有的那种老驱动机器"写的,
   *   而这类机器恰恰是出问题的那些 —— 没有它就只能靠嘴念代码, 验证不了
   *   "日志里到底会不会写出正确的结论"。装机的反馈机也可以让用户临时设一下,
   *   快速确认"是驱动这条链的问题"还是别的问题。只影响判定与展示, 不改真实硬件行为。
   */
  {
    const fake = String(process.env.AICS_FAKE_DRIVER ?? '').trim()
    if (fake) {
      info.driverVersion = fake
      info.present = true
      info.source = (info.source ? `${info.source}+` : '') + 'AICS_FAKE_DRIVER'
    }
  }
  info.at = Date.now()
  return info
}

/** 异步读显存快照; 拿不到返回 null(调用方自动退化为"只看内存") */
async function readGpuMemAsync() {
  const smi = path.join(SYS32, 'nvidia-smi.exe')
  const exe = fs.existsSync(smi) ? smi : 'nvidia-smi'
  const out = await runCaptureAsync(exe, ['--query-gpu=memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'], 8000)
  for (const raw of String(out).split(/\r?\n/)) {
    const ln = raw.trim()
    if (!ln || ln.startsWith('[') || !ln.includes(',')) continue
    const [t, u, f] = ln.split(',').map((x) => Number(x.trim()))
    if (!Number.isFinite(t) || t <= 0) continue
    const used = Number.isFinite(u) ? u : 0
    // 测试模式: 假装这是一块 12GB 的卡(占用按真实值, 超出部分裁掉) —— 策略与展示都按它算
    const tl = testLimits()
    if (tl.on) {
      const cap = tl.vramGB * 1024
      const cu = Math.min(Math.max(0, Math.round(used)), cap)
      return {
        totalMB: cap, usedMB: cu, freeMB: Math.max(0, cap - cu),
        totalGB: tl.vramGB, pressure: cu / cap, source: 'test-limits',
      }
    }
    return {
      totalMB: Math.round(t),
      usedMB: Math.round(used),
      freeMB: Number.isFinite(f) ? Math.round(f) : Math.round(t - used),
      totalGB: Math.round(t / 1024),
      pressure: used / t,
      source: 'nvidia-smi',
    }
  }
  return null
}

/** 异步读每进程显存占用 { pid: MiB } */
async function readPerProcAsync() {
  const map = {}
  const smi = path.join(SYS32, 'nvidia-smi.exe')
  const exe = fs.existsSync(smi) ? smi : 'nvidia-smi'
  const out = await runCaptureAsync(exe, ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'], 8000)
  for (const raw of String(out).split(/\r?\n/)) {
    const ln = raw.trim()
    if (!ln || ln.startsWith('[') || !ln.includes(',')) continue
    const [pid, mem] = ln.split(',').map((x) => x.trim())
    const p = Number(pid)
    const m = Number(mem)
    if (Number.isFinite(p) && Number.isFinite(m)) map[p] = m
  }
  return map
}

/** 采一次样(spawn 异步, 三个查询并行)。parts 指定只刷新哪几项 */
async function sampleGpuAsync(parts = ['info', 'mem', 'per']) {
  if (gpuSample.busy) return
  gpuSample.busy = true
  try {
    await Promise.all(parts.map(async (p) => {
      if (p === 'info') { gpuSample.info = await readGpuInfoAsync(); gpuSample.infoAt = Date.now() }
      else if (p === 'mem') { gpuSample.mem = await readGpuMemAsync(); gpuSample.memAt = Date.now() }
      else { gpuSample.perProc = await readPerProcAsync(); gpuSample.perAt = Date.now() }
    }))
  } catch { /* 采样失败就留上一次的值, 绝不影响调用方 */ } finally { gpuSample.busy = false }
}

/** 三个读入口共用的"该刷新了吗": 只把到期的项丢后台, 自己立刻返回 */
function ensureGpuSample() {
  if (gpuSample.busy) return
  const now = Date.now()
  const stale = []
  if (now - gpuSample.infoAt >= GPU_SAMPLE_TTL.info) stale.push('info')
  if (now - gpuSample.memAt >= GPU_SAMPLE_TTL.mem) stale.push('mem')
  if (now - gpuSample.perAt >= GPU_SAMPLE_TTL.per) stale.push('per')
  if (stale.length) void sampleGpuAsync(stale)
}

/** 显卡信息(读缓存; 还没采到时给"没读到独显"的占位, 与老行为一致) */
function gpuInfo() {
  ensureGpuSample()
  return gpuSample.info ?? emptyGpuInfo()
}

/**
 * 最低配置检查(显存 ≥8GB / 内存 ≥24GB / NVIDIA 20 系及以上)。
 * 放在服务端算一次, 前端只负责显示 —— 与错误分类同理, 规则只能有一份。
 */
function sysreqNow() {
  const g = gpuInfo()
  const m = systemMemory()
  return checkSysreq({
    ramGB: m.totalGB,
    vramMB: g.vramTotal,
    gpuName: g.name,
    computeCap: g.computeCap,
    gpuPresent: g.present === true,
    driverVersion: g.driverVersion,
  })
}

/**
 * 「自动清理内存」是否开启。
 * 设置里显式设过就以它为准; 没设过时**按配置推导**: 偏紧的机器默认开, 宽裕的默认关
 * (用户明确要求: 32GB 内存以上的机器不该被过度限制)。
 */
function autoFreeEnabled() {
  try {
    const v = P.settings && P.settings.autoFreeMemory
    if (typeof v === 'boolean') return v
  } catch { /* ignore */ }
  const g = gpuInfo()
  return defaultAutoFree(systemMemory().totalGB, Math.round((g.vramTotal || 0) / 1024))
}

/** 面板/诊断包用的一条人话(方案 + 开关 + 快照) */
function memPlanText() {
  const m = memPolicy(undefined, gpuMemoryNow())
  return `${m.planText}（${m.policy}） · 自动清理内存${autoFreeEnabled() ? '已开启' : '已关闭'} · ${m.summary}`
}

/**
 * 显存快照 —— **读缓存**(真正的一次读在 readGpuMemAsync, 见上面 gpuSample 一节)。
 * 没有独显 / 还没采到时返回 null, 调用方(策略)会自动退化为"只看内存"。
 */
function gpuMemoryNow() {
  ensureGpuSample()
  return gpuSample.mem
}

/**
 * 每个进程的显存占用 { pid: MiB } —— 同样**读缓存**。
 * 用它当"模型是否还在显卡里"的直接证据 —— 比全局 used 更准(不受其它程序干扰)。
 */
function perProcessVram() {
  ensureGpuSample()
  return gpuSample.perProc
}

/**
 * 异步版 nvidia-smi (spawn, 不阻塞事件循环)。
 *
 * 为什么必须有一份异步的(2026-09-19 用户反馈"点了释放很久没反应, 像卡住"):
 *   当时上面那两个函数内部是 execFileSync —— 同步阻塞整个 Node 事件循环。平时(空闲)一次
 *   nvidia-smi 只要 100~300ms, 看不出问题; 但**生成中**显卡满载时, nvidia-smi 自己要
 *   等驱动回话, 一次能到 1~3 秒。而"释放核验"是每 2 秒查一次、最多查 30 秒的那种循环,
 *   于是那 30 秒里服务端几乎一直在"卡住自己": 前端所有请求(状态轮询、素材读写、日志)
 *   全排队, 用户看到的就是"点了一下, 整个界面像死了一样"。
 *   释放核验与中断后的复查一律改用这两个异步版本。
 *   ⚠️ 2026-10-06: 上面那两个已经改成"只读缓存"(见 gpuSample 一节) —— 它们连 100ms 都不占了,
 *   但**需要"就在此刻"读数的路径仍然用这里的异步版本**, 不要再退回同步。 */
function runCaptureAsync(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const finish = (v) => { if (!settled) { settled = true; resolve(v) } }
    let ch
    try {
      ch = spawn(cmd, args, { windowsHide: true })
    } catch { return finish('') }
    const timer = setTimeout(() => { try { ch.kill() } catch { /* ignore */ } finish(out) }, timeout)
    ch.stdout?.on('data', (d) => { out += String(d) })
    ch.stderr?.on('data', () => { /* 忽略 */ })
    ch.on('error', () => { clearTimeout(timer); finish('') })
    ch.on('close', () => { clearTimeout(timer); finish(out) })
  })
}

async function gpuMemoryNowAsync() {
  try {
    const smi = path.join(SYS32, 'nvidia-smi.exe')
    const exe = fs.existsSync(smi) ? smi : 'nvidia-smi'
    const out = await runCaptureAsync(exe, ['--query-gpu=memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'])
    for (const raw of String(out).split(/\r?\n/)) {
      const ln = raw.trim()
      if (!ln || ln.startsWith('[') || !ln.includes(',')) continue
      const [t, u, f] = ln.split(',').map((x) => Number(x.trim()))
      if (!Number.isFinite(t) || t <= 0) continue
      const used = Number.isFinite(u) ? u : 0
      // 测试模式(异步版): 同 gpuMemoryNow, 按 12GB 卡来算
      const tl2 = testLimits()
      if (tl2.on) {
        const cap = tl2.vramGB * 1024
        const cu = Math.min(Math.max(0, Math.round(used)), cap)
        return {
          totalMB: cap, usedMB: cu, freeMB: Math.max(0, cap - cu),
          totalGB: tl2.vramGB, pressure: cu / cap, source: 'test-limits',
        }
      }
      return {
        totalMB: Math.round(t),
        usedMB: Math.round(used),
        freeMB: Number.isFinite(f) ? Math.round(f) : Math.round(t - used),
        totalGB: Math.round(t / 1024),
        pressure: used / t,
        source: 'nvidia-smi',
      }
    }
  } catch { /* ignore */ }
  return null
}

async function perProcessVramAsync() {
  const map = {}
  try {
    const smi = path.join(SYS32, 'nvidia-smi.exe')
    const exe = fs.existsSync(smi) ? smi : 'nvidia-smi'
    const out = await runCaptureAsync(exe, ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'])
    for (const raw of String(out).split(/\r?\n/)) {
      const ln = raw.trim()
      if (!ln || ln.startsWith('[') || !ln.includes(',')) continue
      const [pid, mem] = ln.split(',').map((x) => x.trim())
      const p = Number(pid)
      const m = Number(mem)
      if (Number.isFinite(p) && Number.isFinite(m)) map[p] = m
    }
  } catch { /* ignore */ }
  return map
}

/**
 * 驱动判定的**三档摘要**(给既有调用点用的兼容壳)。
 *
 * 真正的判定与文案在 tools/sysreq.mjs 的 driverAdvice() 里(单一事实来源, 可单测):
 *   它多分了"过低(连兼容栈都撑不起)"与"偏新(比验证过的还新)"两档 —— 原来这里只看
 *   主版本 ≥580 就 OK, 于是 580.30 这种"看着够新其实不够"的驱动会被判成达标。
 */
function driverVerdict(v) {
  const a = driverAdvice({ driverVersion: v })
  if (a.code === 'UNKNOWN') return 'UNKNOWN_NO_NVIDIA_SMI'
  if (a.code === 'TOO_OLD_NEED_580' || a.code === 'TOO_OLD_FAR') return 'TOO_OLD_NEED_580'
  return 'OK_580_PLUS'
}

/** 端口占用者 (用于 PORT_CONFLICT 的人话提示) */
/**
 * ★ 2026-10-12 审计 §3.4: 这个函数是**同步** `netstat -ano`(12 秒上限), 而且**没有缓存** ——
 *   自检/诊断那几条路会**按路数反复调**它, 期间事件循环被占住 ⇒ 那一两秒里所有请求(含状态轮询、
 *   反代)一起排队, 界面上就是"点自检就卡一下"。
 *   这里加一层 3 秒 TTL 缓存(与 `backendIdentityOnPort` 的 20 秒缓存同一思路, 只是更短):
 *   "谁占着这个端口"本来就变化很慢, 3 秒内的重复提问没有意义。
 *   ⚠️ 真正要"立刻看现状"的地方(启动前的端口身份核对)本来就另有 20 秒的结论缓存, 不吃这一层。
 */
const portHolderCache = new Map()
function portHolder(port, ttlMs = 3000) {
  const hit = portHolderCache.get(port)
  if (hit && Date.now() - hit.at < ttlMs) return hit.holder
  const holder = portHolderUncached(port)
  portHolderCache.set(port, { at: Date.now(), holder })
  return holder
}
function portHolderUncached(port) {
  try {
    const out = runCapture(path.join(SYS32, 'netstat.exe'), ['-ano'], 12000)
    const re = new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i')
    for (const ln of String(out).split(/\r?\n/)) {
      const m = ln.match(re)
      if (!m) continue
      const pid = m[1]
      const tl = runCapture(path.join(SYS32, 'tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], 8000)
      const nm = (String(tl).split(',')[0] || '').replace(/"/g, '').trim()
      return { pid, name: nm || '?' }
    }
  } catch { /* ignore */ }
  return null
}

/**
 * 端口上的占用者是不是**我们自己那套后端**留下的? (2026-10-06)
 *
 * 判据 = 进程的可执行文件就在模型包目录(backendsRoot)里 —— 那是只有本程序拉起来的进程
 *   才会出现的路径(各个后端的 python_embeded\python.exe / conda env\python.exe)。
 *   用户自己另开的 ComfyUI 在别处 → 一律判 false, 我们绝不去碰别人的进程
 *   (与 killTree 的约定一致)。
 */
/** 某 PID 的可执行文件路径(拿不到就给空串) */
function pidExePath(pid) {
  try {
    const out = runCapture('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ExecutablePath`,
    ], 8000)
    return String(out).trim()
  } catch { return '' }
}

/**
 * 这个 PID **现在**还是"我们自己的进程"吗（可执行文件在模型包目录 backendsRoot 下）。
 *
 * ⚠️ 两个用途，第二个是安全底线：
 *   ① 端口占用者判定 —— 只结束我们拉起的后端，用户自己另开的同类程序一律不碰。
 *   ② **按 PID 杀之前的放行条件**：run-state.json 里记的 PID 是**上一次进程**写的，
 *      而 Windows 会**复用 PID** —— 直接 taskkill 有可能打到用户新开的、完全无关的程序上
 *      （2026-10-10 彻底检查"残留进程"时发现并加固）。
 */
function pidIsOurs(pid) {
  const id = Number(pid)
  const root = String(P.backendsRoot ?? '').trim().toLowerCase()
  if (!id || !root) return false
  const exe = pidExePath(id).toLowerCase()
  return !!exe && exe.startsWith(root)
}

function portHolderIsOurs(holder) {
  return pidIsOurs(holder?.pid)
}

/** 某个路径属于哪一路的模型包(按各路的根目录前缀判) —— '' = 不是我们任何一路 */
function packKindOfPath(p) {
  const s = String(p || '').toLowerCase()
  if (!s) return ''
  const roots = { h3: P.h3Root, kear: P.kearRoot, indextts: P.indexttsRoot, qwen: P.qwenRoot, text: P.textRoot }
  for (const [k, root] of Object.entries(roots)) {
    if (root && s.startsWith(String(root).toLowerCase())) return k
  }
  return ''
}

/** 问后端自己的安装身份端点；老后端没有这个路由时返回 ok:false。 */
async function readBackendIdentity(port, { timeout = 2500 } = {}) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/aics/identity`, {
      cache: 'no-store', signal: AbortSignal.timeout(timeout),
    })
    if (!r.ok) return { ok: false }
    const j = await r.json()
    return j && j.ok === true ? { ok: true, payload: j } : { ok: false }
  } catch { return { ok: false } }
}

/** 外部端口是否至少“像 H3” —— 用于把旧 H3 和普通 ComfyUI 分开说清楚。 */
async function looksLikeH3Backend(port, { timeout = 2500 } = {}) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/object_info/MiniMaxH3ImageToVideo`, {
      cache: 'no-store', signal: AbortSignal.timeout(timeout),
    })
    if (!r.ok) return false
    const j = await r.json()
    return !!j && Object.keys(j).length > 0
  } catch { return false }
}

function identityMismatches(actual, expected) {
  const out = []
  if (Number(actual?.markerVersion) !== 1) out.push('缺少身份标记协议 v1')
  if (!actual?.instanceId || actual.instanceId !== expected.instanceId) out.push('安装实例 ID 不一致')
  if (!actual?.programVersion || actual.programVersion !== expected.programVersion) out.push('程序版本不一致')
  if (!actual?.modelApiVersion || actual.modelApiVersion !== expected.modelApiVersion) out.push('模型契约不一致')
  return out
}

/**
 * 判定端口上的 H3 到底属于谁。**只认当前 backendsRoot 内的进程 + 四重身份同时匹配**：
 *   exe 路径属于本安装，实例 ID / 程序版本 / 模型契约都对上，才算 trusted。
 * 外部路径上的 H3（哪怕它也有我们的节点）一律 external-h3，默认不自动复用。
 */
async function assessBackendIdentity(kind, { ttlMs = 20000 } = {}) {
  const b = BACKENDS[kind]
  if (!b) return { ok: true, state: 'unknown', trusted: false }
  const holder = portHolderCached(b.port, ttlMs)
  if (!holder) return { ok: true, state: 'free', trusted: false, port: b.port }
  if (!(await portBusy(b.port).catch(() => false))) return { ok: true, state: 'free', trusted: false, port: b.port }
  const packKind = packKindOfPath(holder.exe)
  const currentPath = packKind === kind
  const expected = expectedBackendIdentity()
  const base = {
    ok: true,
    port: b.port,
    pid: holder.pid,
    processName: holder.name,
    exe: String(holder.exe || ''),
    currentPath,
    expected,
  }
  if (packKind && packKind !== kind) {
    return { ...base, state: 'other-pack', trusted: false, otherKind: packKind }
  }
  if (kind !== 'h3') {
    return { ...base, state: currentPath ? 'current-unverified' : 'foreign', trusted: false, supported: false }
  }
  const idn = await readBackendIdentity(b.port)
  const actual = idn.ok ? idn.payload : null
  const h3Like = !!actual || await looksLikeH3Backend(b.port)
  if (!currentPath) {
    return {
      ...base,
      state: h3Like ? 'external-h3' : 'foreign',
      trusted: false,
      actual,
      canAutoRestart: false,
    }
  }
  if (!actual) {
    return { ...base, state: 'current-unverified', trusted: false, actual: null, canAutoRestart: true }
  }
  const mismatches = identityMismatches(actual, expected)
  if (mismatches.length) {
    const state = mismatches.some((x) => x.includes('安装实例')) ? 'instance-mismatch'
      : mismatches.some((x) => x.includes('程序版本')) ? 'version-mismatch'
        : mismatches.some((x) => x.includes('模型契约')) ? 'model-mismatch'
          : 'current-unverified'
    return { ...base, state, trusted: false, actual, mismatches, canAutoRestart: true }
  }
  return { ...base, state: 'trusted', trusted: true, actual, mismatches: [] }
}

/**
 * ★ 2026-10-12 用户: "客户在 comfyui 启动了模型，端口出现混淆…你该如何处理？"
 *
 *   真机模拟(见 `_dev/tmp/_probe_port_extremes.mjs`)抓到的两个**谎报**:
 *     · 8188 上坐着一个**冒牌 ComfyUI**(答 /system_stats, 但没有我们的任何节点) ⇒ 旧逻辑只做一次 TCP connect
 *       就判"在线", 点启动还回 `ok:true「已静默启动 H3 视频」` —— 其实我们的 python 根本绑不上端口;
 *     · 8189 上坐着的其实是**我们自己的 H3**(端口串台) ⇒ 照样被当成"Krea2 在线"。
 *
 *   这里给每一路做一张"身份证"(先看进程 exe 落在哪个包的目录里, 再对**专属节点/权重**问一句 HTTP),
 *   得到四种结论: free / ours(本包) / ours-external(别人的进程但确实以这一路的身份答话) /
 *   other-pack(坐着我们**别的**一路 = 串台) / foreign(别人的程序)。还答不出来就 unknown(保守, 不据此拒启动)。
 *   持有者信息 + 结论都缓存 20 秒(前端 5 秒一轮探测, 不该每次都跑 netstat+WMI+HTTP)。
 */
const IDENTITY_PROBE = {
  /** 这三路都能用"专属节点在不在"当身份证(h3/qwen 的节点是我们自己加进包里的) */
  h3: '/object_info/MiniMaxH3ImageToVideo',
  qwen: '/object_info/QwenImage21Cache',
  /** Krea2 那套没有专属节点名 → 问它的权重清单里有没有 krea2 那只 */
  kear: '/object_info/UNETLoader',
  /** 语音那路是自己的 server.py, /status 的形状就是身份证 */
  indextts: '/status',
}
const IDENTITY_MATCH = {
  kear: (txt) => /krea2/i.test(txt),
}
const holderCache = new Map() // port -> { at, holder }（占用者一般不会秒变）
const identCache = new Map()  // kind -> { at, verdict }

/** 停止 / 重启 / 新进程绑定端口之后，身份与占用者都必须重新读，不能吃旧缓存。 */
function invalidateBackendIdentity(kind) {
  const b = BACKENDS[kind]
  if (kind) identCache.delete(kind)
  if (b?.port) {
    holderCache.delete(b.port)
    portHolderCache.delete(b.port)
  }
  try { portListenCache.clear() } catch { /* 尚未初始化 */ }
}

function portHolderCached(port, ttlMs = 20000) {
  const hit = holderCache.get(port)
  if (hit && Date.now() - hit.at < ttlMs) return hit.holder
  /** ttl=0 = fresh：连内层 3 秒的 netstat 缓存也要作废，否则刚刚换代的外部进程会拿旧 PID 判身份 */
  if (ttlMs <= 0) portHolderCache.delete(port)
  const holder = portHolder(port)
  const val = holder ? { pid: Number(holder.pid), name: holder.name, exe: pidExePath(holder.pid) } : null
  holderCache.set(port, { at: Date.now(), holder: val })
  return val
}

async function backendIdentityOnPort(kind, { ttlMs = 20000 } = {}) {
  const b = BACKENDS[kind]
  if (!b) return { kind: 'unknown' }
  const hit = identCache.get(kind)
  if (hit && Date.now() - hit.at < ttlMs) return hit.verdict
  const verdict = await (async () => {
    /**
     * H3 走**安装身份**，不再只看“它能回答 H3 节点”。
     * 旧版 Manke / 另一个盘的 H3 也会答节点；唯一可靠判据是当前 backendsRoot 的进程 +
     * 本次安装实例 ID / 程序版本 / 模型契约全部匹配。外部 H3 默认绝不复用。
     */
    if (kind === 'h3') {
      const a = await assessBackendIdentity(kind, { ttlMs })
      const holder = a.pid ? { pid: a.pid, name: a.processName, exe: a.exe } : null
      if (a.state === 'free') return { kind: 'free' }
      if (a.state === 'other-pack') return { kind: 'other-pack', holder, otherKind: a.otherKind, identity: a }
      if (a.state === 'trusted') return { kind: 'ours', holder, identity: a }
      if (a.state === 'external-h3') return { kind: 'external-h3', holder, identity: a }
      if (a.state === 'foreign') return { kind: 'foreign', holder, identity: a }
      if (a.state === 'unknown') return { kind: 'unknown', holder, identity: a }
      return { kind: 'ours-unverified', holder, identity: a }
    }
    const holder = portHolderCached(b.port)
    if (!holder) return { kind: 'free' }
    if (await portBusy(b.port).catch(() => false) === false) return { kind: 'free' }
    const packKind = packKindOfPath(holder.exe)
    if (packKind === kind) return { kind: 'ours', holder }
    if (packKind) return { kind: 'other-pack', holder, otherKind: packKind }
    /** 不是我们包里的进程 → 只有"它确实以这一路的身份答话"才算我们另一份拷贝 */
    const path = IDENTITY_PROBE[kind]
    if (!path) return { kind: 'foreign', holder }
    try {
      const r = await fetch(`http://127.0.0.1:${b.port}${path}`, { signal: AbortSignal.timeout(3500) })
      if (!r.ok) return { kind: 'foreign', holder }
      const txt = await r.text().catch(() => '')
      const ok = IDENTITY_MATCH[kind]
        ? IDENTITY_MATCH[kind](txt)
        /** ComfyUI 对不认识的节点回 200 + `{}`(不是 404) ⇒ 必须看"里面有没有东西", 不能只看 r.ok */
        : (() => { try { return Object.keys(JSON.parse(txt || '{}') ?? {}).length > 0 } catch { return false } })()
      return ok ? { kind: 'ours-external', holder } : { kind: 'foreign', holder }
    } catch {
      /**
       * 它**收下了连接但不回话**(半死不活/正在忙)。这时:
       *   · 进程 exe 读得到、且不在我们的模型目录里 → 判 foreign(silent) —— 别人的卡死程序, 不能当"我们的在线";
       *   · exe 都读不到(权限/WMI 失败) → unknown(保守, 调用方不许据此拒启动)。
       */
      return holder.exe ? { kind: 'foreign', holder, silent: true } : { kind: 'unknown', holder }
    }
  })()
  identCache.set(kind, { at: Date.now(), verdict })
  return verdict
}

/**
 * 某一路后端**自带的** python.exe 在哪 —— 只用来做"环境装没装"的判断与提示。
 *
 * ⚠️ 2026-09-28 修: 以前这里是一串三元表达式, **没有 qwen / text 分支** →
 *   kind='qwen' 会落到 indextts 那一支, 于是"装了生图包 + 千问包, 没装语音包"的机器会被判成
 *   "Qwen 生图 2.1 未安装 · 缺少运行环境: …\indextts-tts\python_embeded\python.exe"
 *   —— 明明是装好的, 提示却指着另一路的文件, 用户只会觉得"它就是打不开"。
 *   现在四路各归各: h3/kear/indextts 是 python_embeded 布局; qwen 是 conda 风格的 env\;
 *   text(本地小文本模型)借 H3 的环境, 不单独放 python。
 */
function backendPyPath(kind) {
  switch (kind) {
    case 'h3': return path.join(P.h3Root, 'python_embeded', 'python.exe')
    case 'kear': return path.join(P.kearRoot, 'python_embeded', 'python.exe')
    case 'indextts': return path.join(P.indexttsRoot, 'python_embeded', 'python.exe')
    case 'qwen': return path.join(P.qwenRoot, 'env', 'python.exe')
    case 'text': return path.join(P.h3Root, 'python_embeded', 'python.exe')
    default: return path.join(P.h3Root, 'python_embeded', 'python.exe')
  }
}

/* ============================================================
   模型包"缺文件"自愈 (2026-09-28 · 测试机型千问后端起不来的真凶)
   ------------------------------------------------------------
   现场: 测试机装完千问包, 后端起 0 秒就退:
     ModuleNotFoundError: No module named 'comfy_api.input'
     (comfy_api\latest\_io.py 第 1387 行 import 的就是它)
   把"本机装好的 comfyui-qwen"与我们发出去的 .7z 逐文件比对, 结论很明确:
     · 千问包 **少了 comfy_api\input\{__init__,basic_types,video_types}.py 三个文件**(源码里有、包里没有);
     · 视频包少了我们自研的 ComfyUI-AiCanvas-H3 精修节点(程序会探测, 缺了只是少个加分项);
     · 生图 / 语音两个包干净(只少了本机测试图/产物, 属于正常排除)。
   为什么会有这种漏: 压缩那步是**人工跑的 7z** —— 只要参数里出现 `-xr!input` 这类"按名字排除",
   就会把 ComfyUI 的**代码模块** `comfy_api\input\` 一起排掉(tools/pack-layer.mjs 里记着 9/16 踩过同款)。

   处理(两条腿走路):
     ① 这里做**自愈**: app 包自带这几个关键文件(tools/backend-addons/<层>/…), 启动后端前缺什么补什么
        —— 测试机只要覆盖安装新程序就能用, 不用重下 34GB 模型包;
     ② 打包侧加了校验工具(`node tools/verify-model-pack.mjs <7z> <层>`)与打包期断言, 以后发之前先过一遍。
   ============================================================ */
/**
 * 这一层后端在磁盘上的根目录。
 * ⚠️ 名字别叫 backendRootOf —— server.mjs 里已有一个同名函数(冷启动判定用, 只认 h3/kear/indextts),
 *    ESM 下重复声明同名函数会直接语法错误(实测踩到)。
 */
function layerRootOf(kind) {
  switch (kind) {
    case 'h3': return P.h3Root
    case 'kear': return P.kearRoot
    case 'indextts': return P.indexttsRoot
    case 'qwen': return P.qwenRoot
    case 'text': return P.textRoot
    default: return ''
  }
}

/** 随程序附带的"模型包可能缺掉的关键文件"目录(打进 bundle 的 tools/backend-addons) */
function backendAddonRootOf(kind) {
  /** 与 tools/local-text/serve.py 同一套定位方式: 认 server.mjs 自己所在的目录(打包后 = bundle/) */
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'tools', 'backend-addons', kind)
}

/**
 * 把 app 自带的关键文件补进这一层(只补**缺失**的, 绝不覆盖已有文件)。
 * @returns 补了哪些(相对路径), 空数组 = 本来就不缺
 */
function healBackendFiles(kind) {
  const addon = backendAddonRootOf(kind)
  const root = layerRootOf(kind)
  if (!addon || !root) return []
  try { if (!fs.existsSync(addon) || !fs.existsSync(root)) return [] } catch { return [] }
  const healed = []
  const walk = (rel) => {
    const from = path.join(addon, rel)
    let ents = []
    try { ents = fs.readdirSync(from, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { walk(r); continue }
      const to = path.join(root, ...r.split('/'))
      try { if (fs.existsSync(to)) continue } catch { continue }
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true })
        fs.copyFileSync(path.join(addon, rel, e.name), to)
        healed.push(r)
      } catch { /* 只读盘/被占用: 补不上也不能挡启动 */ }
    }
  }
  walk('')
  return healed
}

/** 单个后端的诊断结论: 前端弹窗、摘要、提示语都用它 */
function classifyBackend(kind, probe, rt, gpu) {
  const b = BACKENDS[kind]
  const label = b.label
  const py = backendPyPath(kind)

  if (probe?.online) {
    return { code: 'OK', title: `${label} 就绪`, detail: '', action: '' }
  }
  if (!fs.existsSync(py)) {
    return {
      code: 'MODEL_MISSING',
      title: `${label} 未安装`,
      detail: `缺少运行环境: ${py}`,
      action: `把 ${label} 整套目录放回 backends 目录, 或重新解压完整包`,
    }
  }
  const crashTail = (rt?.tail ?? []).join('\n')
  if (rt?.managed && rt.exitCode !== null && rt.exitCode !== 0) {
    /**
     * 进程被 Windows **加载器**直接掐掉: 连 Python 都没起来, 所以日志里一个字都没有。
     *   0xC0000135 = STATUS_DLL_NOT_FOUND; 0xC000007B = STATUS_INVALID_IMAGE_FORMAT。
     *   Node 把退出码报成有符号数, 两种写法都收(实测本机复现千问包时拿到的是 -1073741515)。
     *
     * ⚠️ 2026-09-28 实测背景: 千问包的环境是 conda 风格 env\, 原生依赖 + MSVC 运行时都在
     *   env\Library\bin\ —— 旧版启动环境没把它加进 PATH, 干净机器上一启动就是这个退出码,
     *   界面却只能显示"-1073741515", 用户完全不知道该干什么。现在直接给结论与做法。
     */
    const LOADER_DLL_NOT_FOUND = [-1073741515, 3221225781]
    const LOADER_BAD_IMAGE = [-1073741701, 3221225595]
    if (LOADER_DLL_NOT_FOUND.includes(Number(rt.exitCode))) {
      return {
        code: 'ENV_DLL_MISSING',
        title: `${label} 的运行环境缺依赖库`,
        detail: '后端的 Python 没能启动（Windows 报"找不到 DLL"）',
        action: '用最新程序包覆盖安装一次即可（新版启动环境会把 env\\Library\\bin 加进 PATH）',
      }
    }
    if (LOADER_BAD_IMAGE.includes(Number(rt.exitCode))) {
      return {
        code: 'ENV_BAD_IMAGE',
        title: `${label} 的运行环境不完整`,
        detail: '后端程序被 Windows 判定为"镜像格式不对"（通常是解压不完整或被杀软改过文件）',
        action: '把这层模型包重新解压一次（覆盖到 backends 下同名目录）',
      }
    }
    /**
     * ★ 2026-10-30 客户现场 (RTX 5070 Ti 16GB / 64GB 内存 / 驱动 617.42):
     *   H3 把 6 步采样完整跑完, 卡在**出片时的 VAE 解码**上, 进程直接以 access violation 没了。
     *   崩溃前日志里的原话是这几种之一:
     *     aimdo: xfer_file_read_at: GetOverlappedResult failed error=1450
     *     aimdo: hostbuf_read_file_slice: file read failed handle=… size=…
     *     !!! Exception during processing !!! hostbuf_file_reader_read failed
     *     !!! Exception during processing !!! HostBuffer.read_file_slice failed
     *   含义一致: 显存装不下整套权重 → aimdo 把一部分**暂存到内存/磁盘**, 解码时再读回来读不动了。
     *
     *   为什么必须单独认这一类: 旧版把它们全归到下面的 "access violation → 驱动过低",
     *   于是这台驱动 617.42(远高于 580.88)的机器被要求"去重装驱动" —— 界面自己都自相矛盾
     *   (02-显卡 那节写着"满足 ≥580.88", 结论却是 DRIVER_TOO_OLD), 用户照着弄一晚上也不会好。
     *   error=1450 = ERROR_NO_SYSTEM_RESOURCES: 页面文件太小 / 非分页资源耗尽时, 异步
     *   (overlapped)读就会栽在这里 —— 该给的是"加虚拟内存 / 关占内存的程序 / 降一档",
     *   不是"换驱动"。
     */
    if (/hostbuf_file_reader_read failed|HostBuffer\.read_file_slice failed|hostbuf_read_file_slice|xfer_file_read|GetOverlappedResult failed|DefaultCPUAllocator: not enough memory/i.test(crashTail)) {
      const vramGB = gpu.vramTotal ? Math.round(gpu.vramTotal / 1024) : 0
      const ramGB = systemMemory().totalGB
      const lp = launchProfile()
      return {
        code: 'HOST_MEMORY_SHORTAGE',
        title: `${label} 内存不够，权重回读失败`,
        detail: `显存 ${vramGB ? vramGB + ' GB' : '不足'} 装不下这一版 H3 的整套权重（模型约 20GB + 文本编码器约 15GB + VAE 约 5GB），`
          + '程序只能把它们暂存到宿主内存，出片解码时读不回来（日志: hostbuf_file_reader_read failed / error=1450）。'
          + '这是内存侧的资源不足，**不是显卡驱动的问题**。'
          + (lp.pinnedTooBig
            ? '本机已按新规则自动关闭固定内存，重启这一路后端即可生效。'
            : ''),
        action: '① 升级到最新程序（这一版修了"16GB 显存却仍开启固定内存"的问题，会把那部分不可换页内存让出来）；'
          + '② 把 Windows 虚拟内存改成「系统管理的大小」，或手动给到 32GB 以上（error=1450 就是提交内存/页面文件不够）；'
          + '③ 关掉夸克/浏览器/剪辑软件等吃内存的程序再出片；'
          + '④ 出片降到 720P、5 秒再试（VAE 解码这一步的峰值最小）',
      }
    }
    if (/out of memory|cudaErrorMemoryAllocation/i.test(crashTail)) {
      return {
        code: 'VRAM_INSUFFICIENT',
        title: `${label} 显存不足`,
        detail: `显卡 ${gpu.vramTotal ? Math.round(gpu.vramTotal / 1024) + ' GB' : '?'}, 加载模型时显存被占满`,
        action: '关闭其它占用显卡的程序; 不要同时使用视频和图片; 降低分辨率或时长',
      }
    }
    /**
     * 驱动类**只认这三句真话**（它们是 CUDA 自己报的"驱动不行"）。
     *   ⚠️ "access violation" 不再是其中之一: 那是"进程访存出错"的通用外壳,
     *   驱动太老、显存被打爆、指针越界、上面那条 hostbuf 回读失败, 全都长这样。
     *   只有**驱动版本确实不达标**时才能报 DRIVER_TOO_OLD, 否则就是在把用户往错方向带。
     */
    if (/CUDA not available|No CUDA GPUs|CUDA driver version is insufficient/i.test(crashTail)) {
      return {
        code: 'DRIVER_TOO_OLD',
        title: `${label} 显卡驱动版本过低`,
        detail: `当前驱动 ${gpu.driverVersion || '未知'}，需要 580.88 以上`,
        action: '更新 NVIDIA 驱动（自定义安装 + 勾选执行清洁安装），装完重启电脑',
      }
    }
    if (/access violation/i.test(crashTail)) {
      const adv = driverAdvice(gpu, { compatAvailable: false })
      if (adv.code === 'TOO_OLD_FAR' || adv.code === 'TOO_OLD_NEED_580') {
        return {
          code: 'DRIVER_TOO_OLD',
          title: `${label} · ${adv.title}`,
          detail: adv.detail,
          action: adv.action,
        }
      }
      /** 驱动明明够(这台是 617.42) → 就是后端自己崩了, 如实说, 别再往驱动上引 */
      const lastErr = (rt?.tail ?? []).map((x) => String(x)).reverse()
        .find((x) => /ERROR|Exception|failed|fatal/i.test(x)) ?? ''
      return {
        code: 'BACKEND_CRASHED',
        title: `${label} 推理时崩溃退出`,
        detail: `当前驱动 ${gpu.driverVersion || '未知'}`
          + (adv.code === 'UNKNOWN' ? '（没能确认版本，但也不是它导致这次退出）' : '，满足要求（≥ 580.88）')
          + '；崩溃发生在推理过程中（日志里是 access violation，不是驱动版本不足）'
          + (lastErr ? `。日志: ${lastErr.slice(0, 160)}` : ''),
        action: '先按「导出日志」留证据；然后把出片降到 720P / 5 秒重试一次，仍崩就把诊断包发给管理员',
      }
    }
    // 应用程序控制 / 智能应用控制 / WDAC / 安全软件 拦截动态库 (2026-09-15 测试反馈)
    //   实测现象: H3 与 Krea2 都是"启动后退出码 1", 日志里是
    //     import comfy.utils → torch._load_dll_libraries() → torch\lib\shm.dll
    //     → 被"应用程序控制策略"阻止 (WinError 4551) → OSError
    //   以前这里只匹配 DLL load failed/WinError 126/193, 且提示很笼统("加入信任项"),
    //   于是界面上只显示"退出码 1", 用户完全不知道要关什么。现在单独识别并给出步骤。
    if (/WinError\s*4551|4551\b|application control polic|smart app control|应用程序控制|智能应用控制|blocked by (your )?(security|policy)|CodeIntegrity|\\bshm\.dll\b/i.test(crashTail)) {
      return {
        code: 'POLICY_BLOCKED',
        title: `${label} 被 Windows「应用程序控制」拦截`,
        detail: '系统策略阻止了后端需要的 torch 动态库（torch\\lib\\shm.dll，WinError 4551）。'
          + '这不是模型或程序损坏 —— 同一台机器上另一路后端能跑，说明是"按文件放行"的策略在拦。',
        action: '① 先双击程序目录里的 fix-model-files.bat（解除"来自网络"的文件标记，并打印策略状态）；'
          + '② 还是不行 → 设置 → 隐私和安全性 → Windows 安全中心 → 应用和浏览器控制 → 智能应用控制 → 关（若显示"已开启"）；'
          + '③ 装了火绒/360/EDR 的，把程序目录（如 D:\\Manke）加入信任区；'
          + '④ 企业管控的机器（WDAC）需要管理员加白名单；'
          + '⑤ 最后再考虑用语音包里同版本 torch\\lib\\shm.dll 覆盖',
      }
    }
    if (/DLL load failed|LoadLibrary|WinError 126|WinError 193/i.test(crashTail)) {
      return {
        code: 'SECURITY_BLOCKED',
        title: `${label} 组件被系统安全策略拦截`,
        detail: '后端依赖的动态库没能加载（应用控制策略 / 内核隔离 / 杀软拦截）',
        action: '按说明把本程序目录加入信任/排除项后重试',
      }
    }
    return {
      code: 'BACKEND_CRASHED',
      title: `${label} 启动后意外退出`,
      detail: `退出码 ${rt.exitCode}，已记录最后 80 行日志`,
      action: '点「导出日志」并联系管理员',
    }
  }
  const holder = portHolder(b.port)
  if (holder && !(rt?.managed && rt.running)) {
    return {
      code: 'PORT_CONFLICT',
      title: `端口 ${b.port} 被占用`,
      detail: `占用进程: ${holder.name} (pid ${holder.pid})`,
      action: '一键释放（若是上次残留）或关闭该程序后重试',
    }
  }
  /**
   * 驱动与显卡(靠 CUDA 的三路): H3 / Krea2 / Qwen (2026-10-06 补上千问)。
   *   千问的 torch 是 2.14.0+cu130, 门槛与 H3 一样是 580.88; 它 2026-10-06 起也进
   *   COMPAT_KINDS —— 装了「低驱动兼容补丁」(或带 _vendor 的完整包)时由 .pth 自动切 cu126,
   *   没装时驱动不达标就是必崩(这时 compatForKind 为假, 正好落进下面的 DRIVER_TOO_OLD)。
   * ⚠️ 三条路在包内带兼容栈时会被 .pth 自动切到 cu126, 那种情况**不算故障**:
   *   不能报 DRIVER_TOO_OLD, 否则用户按提示去升驱动, 真正的问题还在别处。
   */
  if (kind === 'h3' || kind === 'kear' || kind === 'qwen') {
    const compatForKind = COMPAT_KINDS.includes(kind) && cudaCompat().available
    const adv = driverAdvice(gpu, { compatAvailable: compatForKind })
    if (!compatForKind && (adv.code === 'TOO_OLD_FAR' || adv.code === 'TOO_OLD_NEED_580')) {
      return {
        code: 'DRIVER_TOO_OLD',
        title: `${label} · ${adv.title}`,
        detail: adv.detail,
        action: adv.action,
      }
    }
    if (!gpu.present) {
      return {
        code: 'NO_NVIDIA_GPU',
        title: '没有检测到 NVIDIA 显卡',
        detail: 'H3 视频 / Krea2 生图 / Qwen 生图都需要 NVIDIA 显卡（CUDA）',
        action: '如为 AMD/Intel 显卡，仅语音功能可用',
      }
    }
  }
  if (rt?.managed && rt.running) {
    const mins = Math.round((Date.now() - rt.startedAt) / 60000)
    if (Date.now() - rt.startedAt > 5 * 60 * 1000) {
      return { code: 'TIMEOUT', title: `${label} 加载超时`, detail: `已等待 ${mins} 分钟仍未就绪`, action: '检查磁盘空间/是否过慢，或点「一键重启后端」重试' }
    }
    return { code: 'LOADING', title: `${label} 正在加载`, detail: `已等待 ${mins} 分钟`, action: '' }
  }
  return { code: 'NOT_STARTED', title: `${label} 未启动`, detail: '', action: '点「重新检测」或「一键重启后端」' }
}

/** 脱敏: 任何像密钥/令牌的键值都不进诊断包 */
const SECRET_KEY_RE = /(apikey|api_key|api-key|token|secret|password|passwd|authorization|cookie|credential|session|license)/i
function redact(value, depth = 0) {
  if (depth > 8) return '<max-depth>'
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k)) out[k] = (v === '' || v == null) ? v : '***'
      else out[k] = redact(v, depth + 1)
    }
    return out
  }
  return value
}
function redactJson(obj) { return JSON.stringify(redact(obj), null, 2) }

// ---- 最小 ZIP 写出器 (deflate + CRC32, Node 自带 zlib, 无第三方依赖) ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function writeZip(zipPath, entries) {
  const d = new Date()
  const dosTime = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31)
  const dosDate = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31)
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(String(e.name).replace(/\\/g, '/'), 'utf8')
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8')
    const comp = zlib.deflateRawSync(raw)
    const crc = crc32(raw)
    const h = Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50, 0)
    h.writeUInt16LE(20, 4)
    h.writeUInt16LE(0x0800, 6)   // UTF-8 文件名标志
    h.writeUInt16LE(8, 8)        // deflate
    h.writeUInt16LE(dosTime, 10)
    h.writeUInt16LE(dosDate, 12)
    h.writeUInt32LE(crc, 14)
    h.writeUInt32LE(comp.length, 18)
    h.writeUInt32LE(raw.length, 22)
    h.writeUInt16LE(name.length, 26)
    h.writeUInt16LE(0, 28)
    locals.push(h, name, comp)
    centrals.push({ name, crc, comp: comp.length, raw: raw.length, offset })
    offset += h.length + name.length + comp.length
  }
  const cds = []
  let cdSize = 0
  for (const c of centrals) {
    const h = Buffer.alloc(46)
    h.writeUInt32LE(0x02014b50, 0)
    h.writeUInt16LE(20, 4)
    h.writeUInt16LE(20, 6)
    h.writeUInt16LE(0x0800, 8)
    h.writeUInt16LE(8, 10)
    h.writeUInt16LE(dosTime, 12)
    h.writeUInt16LE(dosDate, 14)
    h.writeUInt32LE(c.crc, 16)
    h.writeUInt32LE(c.comp, 20)
    h.writeUInt32LE(c.raw, 24)
    h.writeUInt16LE(c.name.length, 28)
    h.writeUInt32LE(c.offset, 42)
    cds.push(h, c.name)
    cdSize += h.length + c.name.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(centrals.length, 8)
  end.writeUInt16LE(centrals.length, 10)
  end.writeUInt32LE(cdSize, 12)
  end.writeUInt32LE(offset, 16)
  ensureDir(path.dirname(zipPath))
  fs.writeFileSync(zipPath, Buffer.concat([...locals, ...cds, end]))
}

// ---- 各分项采集 ----
function fmtLocal(ts) {
  try { return new Date(ts).toLocaleString('zh-CN') } catch { return String(ts) }
}
function machineJson() {
  const m = os
  return {
    time: fmtLocal(Date.now()),
    appRoot: P.appRoot, dataDir: P.dataDir, backendsRoot: P.backendsRoot, packaged: P.packaged === true,
    platform: process.platform, arch: process.arch,
    os: `${m.type()} ${m.release()} ${m.version()}`,
    cpu: (m.cpus()?.[0]?.model ?? '').trim(),
    cpuCount: m.cpus()?.length ?? 0,
    totalMemMB: Math.round((m.totalmem() ?? 0) / 1048576),
    freeMemMB: Math.round((m.freemem() ?? 0) / 1048576),
    hostname: m.hostname(),
    user: process.env.USERNAME || process.env.USER || '',
    systemRoot: process.env.SystemRoot || '',
    temp: os.tmpdir(),
    nodeVersion: process.version,
    electron: process.versions?.electron ?? null,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
}
function diagGpuText() {
  const parts = []
  const smi = fs.existsSync(path.join(SYS32, 'nvidia-smi.exe')) ? path.join(SYS32, 'nvidia-smi.exe') : 'nvidia-smi'
  parts.push('# 显卡汇总 (name, driver_version, memory.total/used/free)')
  parts.push(runCapture(smi, ['--query-gpu=name,driver_version,memory.total,memory.used,memory.free', '--format=csv'], 15000))
  parts.push('# 占用显存的进程 (管理员运行才能看全)')
  parts.push(runCapture(smi, ['--query-compute-apps=pid,process_name,used_memory', '--format=csv'], 15000))
  parts.push('# nvidia-smi 完整输出 (前 200 行)')
  parts.push(runCapture(smi, [], 15000).split(/\r?\n/).slice(0, 200).join('\n') + '\n')
  parts.push('# 注册表驱动信息 (兜底)')
  for (const idx of ['0000', '0001']) {
    const key = `HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\${idx}`
    parts.push(`--- ${idx} ---`)
    parts.push(runCapture(path.join(SYS32, 'reg.exe'), ['query', key, '/v', 'DriverDesc'], 8000))
    parts.push(runCapture(path.join(SYS32, 'reg.exe'), ['query', key, '/v', 'DriverVersion'], 8000))
  }
  return parts.join('\n')
}
/**
 * 某一路后端 python 环境里装的 torch 版本 —— 读 dist-info **目录名**, 瞬时且不起进程。
 * @param root  该后端根目录
 * @param inner site-packages 相对 root 的层级
 *   · python_embeded 布局(H3/Krea2/IndexTTS): python_embeded\Lib\site-packages
 *   · conda env 布局(千问):                 env\Lib\site-packages
 */
function torchVersionFromDistInfo(root, inner = ['python_embeded', 'Lib', 'site-packages']) {
  try {
    const sp = path.join(root, ...inner)
    const hit = fs.readdirSync(sp).find((n) => /^torch-[\d.]+/.test(n))
    /**
     * 返回**干净的版本号**(2.13.0+cu130), 不是 dist-info 目录名。
     *   以前直接回 "torch-2.13.0+cu130.dist-info" —— 写进日志/诊断包又长又像路径,
     *   远程看一眼根本反应不过来那是"包里带的 torch 版本"。
     */
    return hit ? hit.replace(/^torch-/, '').replace(/\.dist-info$/, '') : null
  } catch { return null }
}

/** 某一路后端**实际在用**的 torch(千问是 conda 布局, 路径不一样) */
function torchOf(kind) {
  switch (kind) {
    case 'h3': return torchVersionFromDistInfo(P.h3Root)
    case 'kear': return torchVersionFromDistInfo(P.kearRoot)
    case 'indextts': return torchVersionFromDistInfo(P.indexttsRoot)
    case 'qwen': return torchVersionFromDistInfo(P.qwenRoot, ['env', 'Lib', 'site-packages'])
    default: return null   // text: 借 H3 的环境且只跑 CPU, 不报运行库
  }
}
function diagCudaJson() {
  const out = {
    note: 'torch 版本直接读 dist-info(瞬时); CUDA 可用性用包内 python 实测(可能较慢)',
    h3: { torch: torchOf('h3') },
    kear: { torch: torchOf('kear') },
    indextts: { torch: torchOf('indextts') },
    qwen: { torch: torchOf('qwen') },
    gpu: gpuInfo(),
    driverVerdict: driverVerdict(gpuInfo().driverVersion),
    /** 完整判定(版本 + 档次 + 怎么办) —— 导日志的人只看这一段就够了 */
    driverAdvice: driverAdvice(gpuInfo(), { compatAvailable: cudaCompat().available }),
    cudaCompat: cudaCompat(),
    compatNote: 'mode=cu126 表示走包内兼容栈(torch 2.13.0+cu126); 由 _vendor/cu126 与 .pth 选择器决定, 也可用 AICS_CUDA_MODE 强制'
      + '。选择器装给三条 CUDA 路 H3 / Krea2 / 千问(COMPAT_KINDS): 千问的 .pth 在 backends\\comfyui-qwen\\env\\Lib\\site-packages,'
      + '共用同一套兼容栈(2026-10-06 实测千问能吃)。IndexTTS 自带 torch 2.8.0+cu128, 明确不装 —— 它不受驱动闸门影响',
  }
  const py = path.join(P.h3Root, 'python_embeded', 'python.exe')
  if (fs.existsSync(py)) {
    const code = "import sys,json,torch;print('@@'+json.dumps({'python':sys.version.split()[0],'torch':torch.__version__,'cuda_runtime':torch.version.cuda,'cuda_available':torch.cuda.is_available(),'device_count':torch.cuda.device_count(),'device_name':(torch.cuda.get_device_name(0) if torch.cuda.is_available() else None),'capability':(list(torch.cuda.get_device_capability(0)) if torch.cuda.is_available() else None),'arch_list':(torch.cuda.get_arch_list() if torch.cuda.is_available() else None)}))"
    try {
      const raw = execCapture(py, ['-u', '-c', code], { timeout: 120000 })
      const line = String(raw).split(/\r?\n/).filter((l) => l.startsWith('@@')).pop()
      out.h3Probe = line ? JSON.parse(line.slice(2)) : { error: 'no @@ line', raw: String(raw).slice(-1500) }
    } catch (e) {
      out.h3Probe = {
        error: 'probe crashed (这本身就是重要证据)',
        exitCode: e?.status ?? null,
        output: String((e?.stdout ?? '') + (e?.stderr ?? '')).slice(-4000),
      }
    }
  } else {
    out.h3Probe = { error: 'h3 python not found' }
  }
  return JSON.stringify(out, null, 2)
}
function diagPortsText(diag) {
  const ports = [...Object.values(BACKENDS).map((b) => b.port), PORT]
  const out = runCapture(path.join(SYS32, 'netstat.exe'), ['-ano'], 15000)
  const lines = String(out).split(/\r?\n/).filter((l) => ports.some((p) => l.includes(`:${p}`)))
  const parts = ['# 相关端口 (netstat -ano)', lines.join('\n') || '(无)', '', '# 占用者判定']
  for (const p of ports) {
    const h = portHolder(p)
    parts.push(`  ${p}: ${h ? `${h.name} (pid ${h.pid})` : '空闲'}`)
  }
  parts.push('', '# 后端探测结果')
  for (const [kind, pr] of Object.entries(diag.probes)) {
    parts.push(`  ${kind}: online=${pr?.online} detail=${pr?.detail ?? ''}`)
  }
  return parts.join('\n')
}
function diagProcessText(diag) {
  const parts = ['# 相关进程', '']
  // 两个 exe 名都查: 正式版是 Manke.exe, 老安装 (改名前的 Beta) 是 MankeLegacy.exe
  for (const img of ['python.exe', 'Manke.exe', 'MankeLegacy.exe', 'node.exe', 'cmd.exe']) {
    parts.push(`--- ${img} ---`)
    parts.push(runCapture(path.join(SYS32, 'tasklist.exe'), ['/FI', `IMAGENAME eq ${img}`, '/FO', 'TABLE', '/NH'], 10000))
  }
  parts.push('# 本服务托管的后端 (pid / 日志 / 状态)')
  for (const [kind, rt] of Object.entries(diag.runtime)) {
    parts.push(`  ${kind}: ${JSON.stringify({ managed: rt.managed, running: rt.running, pid: rt.pid, exitCode: rt.exitCode, logFile: rt.logFile })}`)
  }
  return parts.join('\n')
}
function diagAppLog() {
  const parts = ['# 应用日志']
  try {
    const files = fs.readdirSync(LOG_DIR()).filter((n) => n.startsWith('app-')).sort()
    if (!files.length) parts.push('(暂无应用日志)')
    for (const f of files.slice(-2)) {
      parts.push(`--- ${f} ---`)
      parts.push(fs.readFileSync(path.join(LOG_DIR(), f), 'utf8').slice(-200000))
    }
  } catch { parts.push('(读取失败)') }
  try {
    const rs = RUN_STATE()
    parts.push('', '# run-state.json')
    parts.push(fs.existsSync(rs) ? fs.readFileSync(rs, 'utf8') : '(不存在)')
  } catch { /* ignore */ }
  return parts.join('\n')
}
function diagSettings() {
  try {
    const p = path.join(P.dataDir, 'settings.json')
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {}
  } catch (e) { return { error: String(e) } }
}
function diagGraph() {
  // 画布数据在渲染进程的 localStorage 里; 主进程每分钟 dump 到 data/localstorage-backup.json。
  // 这里只导出"结构 + 参数", 不含素材二进制(体积小, 也不泄露用户素材内容)。
  try {
    const p = path.join(P.dataDir, 'localstorage-backup.json')
    if (!fs.existsSync(p)) return JSON.stringify({ note: '没有找到画布快照(localstorage-backup.json)' }, null, 2)
    const all = JSON.parse(fs.readFileSync(p, 'utf8'))
    const key = Object.keys(all).find((k) => /graph/i.test(k))
    if (!key) return JSON.stringify({ note: '快照里没有画布数据', keys: Object.keys(all) }, null, 2)
    const g = typeof all[key] === 'string' ? JSON.parse(all[key]) : all[key]
    const nodes = (g.nodes ?? []).map((n) => ({
      id: n.id, kind: n.type ?? n.data?.kind, pos: n.position,
      keys: Object.keys(n.data ?? {}),
      promptLen: typeof n.data?.prompt === 'string' ? n.data.prompt.length : undefined,
      hasOutput: !!(n.data?.output ?? n.data?.media),
      error: n.data?.error ?? undefined,
    }))
    const edges = (g.edges ?? []).map((e) => ({ source: e.source, target: e.target }))
    return JSON.stringify({ note: '仅结构+参数, 不含素材内容', nodeCount: nodes.length, edgeCount: edges.length, nodes, edges }, null, 2)
  } catch (e) { return JSON.stringify({ error: String(e) }, null, 2) }
}
function diagTimeline() {
  const lines = ['# 启动时间线 (相对服务启动)']
  const t0 = STARTUP_TIMELINE[0]?.t ?? Date.now()
  for (const e of STARTUP_TIMELINE) {
    lines.push(`  +${String(((e.t - t0) / 1000).toFixed(1)).padStart(7)}s  ${e.event}${e.extra ? '  ' + JSON.stringify(e.extra) : ''}`)
  }
  lines.push('', '# 本服务托管的后端耗时')
  for (const [kind, rt] of Object.entries(backendRuntime())) {
    if (!rt.managed) { lines.push(`  ${kind}: (非托管)`); continue }
    lines.push(`  ${kind}: pid=${rt.pid} 进程起=${fmtLocal(rt.startedAt)} 首行输出=${rt.firstOutputAt ? fmtLocal(rt.firstOutputAt) : '无'} 退出码=${rt.exitCode ?? '-'} 运行中=${rt.running}`)
  }
  return lines.join('\n')
}
function diagLicense() {
  try {
    const m = getMachineInfo({ dataDir: P.dataDir })
    const st = licenseStatus(P.dataDir, m)
    return JSON.stringify({
      note: '不含私钥; 机器码可对外(用于签发)',
      machineCode: m?.code ?? m?.machineCode ?? null,
      status: st,
    }, null, 2)
  } catch (e) { return JSON.stringify({ error: String(e) }, null, 2) }
}

/** 00-摘要.txt: 管理者/我第一眼看的就是它 */
function renderSummary(diag) {
  const gpu = diag.gpu
  const lines = []
  const ver = P.versionInfo ?? {}
  const mdl = P.modelsQuick ? P.modelsQuick() : null
  lines.push('【Manke 诊断摘要】')
  lines.push(`时间      : ${fmtLocal(diag.at)}`)
  lines.push(`程序版本  : v${ver.program?.version ?? '?'} (build ${ver.program?.build ?? '?'}, ${ver.channel ?? '?'}, ${ver.program?.gitCommit || 'no-git'})`)
  if (ver.program?.watermark) lines.push(`分发水印  : ${ver.program.watermark}${ver.program.watermarkedFor ? ' (发给: ' + ver.program.watermarkedFor + ')' : ''}`)
  if (mdl) lines.push(`模型包    : ${mdl.packVersion ? 'v' + mdl.packVersion + ' · ' : ''}契约 ${mdl.supportedApiVersion} · ${mdl.compat.reason}`)
  lines.push(`程序目录  : ${P.appRoot}`)
  lines.push(`数据目录  : ${P.dataDir}`)
  lines.push(`模型目录  : ${P.backendsRoot}`)
  lines.push(`打包模式  : ${P.packaged === true ? '是' : '否'}`)
  lines.push('')
  lines.push('--- 显卡 ---')
  lines.push(`型号      : ${gpu.name || '(未检测到)'}`)
  lines.push(`驱动版本  : ${gpu.driverVersion || '(未知)'}`)
  /**
   * 驱动判定从 2026-10-06 起不只是一句"够不够", 而是"什么版本 / 我们怎么判 / 该怎么办"
   *   —— 导出的诊断摘要要能直接回答用户"我这台到底行不行、要做什么"。
   */
  {
    const compat = cudaCompat()
    const adv = driverAdvice(gpu, { compatAvailable: compat.available })
    lines.push(`驱动判定  : ${adv.level}（${adv.code}）—— ${adv.detail}`)
    if (adv.archNote) lines.push(`显卡注意  : ${adv.archNote}`)
    if (adv.action) lines.push(`处理建议  : ${adv.action}`)
    lines.push(`运行库    : ${compat.available
      ? `包内 CUDA 12.6 兼容栈已自带 · 当前走 ${compat.mode}`
      : '包内没有 CUDA 12.6 兼容栈（驱动不达标时无退路）'}`)
  }
  lines.push(`显存      : ${gpu.vramTotal ? gpu.vramTotal + ' MiB' : '(未知)'}`)
  lines.push(`来源      : ${gpu.source || '-'}${gpu.computeCap ? ' · 算力 ' + gpu.computeCap : ''}`)
  const sr0 = sysreqNow()
  lines.push('')
  lines.push('--- 配置要求 ---')
  lines.push(`结论      : ${sr0.ok ? (sr0.unknown ? '基本满足（有无法识别的项）' : '满足最低要求') : '不符合最低要求'}`)
  for (const f of sr0.fails) lines.push(`不达标    : ${f.label} —— ${f.detail}`)
  for (const n of sr0.notes) lines.push(`待确认    : ${n.label} —— ${n.detail}`)
  lines.push(`释放策略  : ${memPlanText()}`)
  {
    const lp = launchProfile()
    lines.push(`启动档位  : ${lp.label} · ${lp.reason}${lp.pinnedMemory ? '' : ' · 已关闭固定内存(pinned memory)'}`)
  }
  {
    // 授权与时间轴: 排障时最先被问到的两件事 —— "激活了吗 / 时间对不对"
    try {
      const st = licenseStatus(P.dataDir, machine())
      const ck = st.clock ?? clockReport(P.dataDir)
      lines.push('')
      lines.push('--- 授权与时间轴 ---')
      lines.push(`机器码    : ${st.machineCode}`)
      lines.push(`授权状态  : ${st.licensed ? '已激活' : st.state === 'invalid' ? '无效' : '未激活'}${
        st.format ? ' · ' + st.format : ''}${st.licensed && st.payload?.holder ? ' · ' + st.payload.holder : ''}`)
      if (st.licensed && st.payload?.exp) lines.push(`到期      : ${String(st.payload.exp).slice(0, 10)}`)
      if (st.state === 'invalid' && st.reason) lines.push(`无效原因  : ${st.reason}`)
      if (ck) {
        lines.push(`时间轴    : 首次 ${fmtLocal(ck.firstSeen)} · 最近 ${fmtLocal(ck.lastSeen)} · 水位 ${fmtLocal(ck.maxSeen)}`)
      lines.push(`时间判定  : ${ck.tamper
        ? `${ck.hardTamper ? '硬回拨' : '回拨'}${ck.hardTamper && ck.strict ? ' (严格模式: 已判无效)' : ' (宽限模式: 仅提示)'}`
        : '正常'} · 容差 ${(ck.toleranceMs / 3600_000).toFixed(1)} 小时`)
        if (ck.tamper) lines.push(`回拨幅度  : 约 ${(ck.skewMs / 3600_000).toFixed(1)} 小时`)
        const bad = (ck.sources ?? []).filter((s) => s.present && !s.ok)
        if (bad.length) lines.push(`锚点异常  : ${bad.map((s) => `${s.name}(${s.reason ?? '未知'})`).join(', ')}`)
        if (ck.futureReads) lines.push(`未来读数  : ${ck.futureReads} 处被丢弃 (超出 now+24h)`)
        // 多源交叉校验: 五个来源各自看到什么
        for (const c of ck.checks ?? []) {
          const name = (SOURCE_LABELS[c.source] ?? c.source).padEnd(8)
          const skew = c.ok ? `${c.skewMs >= 0 ? '+' : ''}${(c.skewMs / 3600_000).toFixed(2)} 小时` : '不可用'
          const hit = c.ok && c.skewMs > (ck.toleranceMs ?? 0) ? '  ← 命中' : ''
          lines.push(`  ${name}: ${skew}  ${c.detail ?? ''}${hit}`)
        }
      }
    } catch (e) {
      lines.push(`授权信息  : 读取失败 —— ${e?.message ?? e}`)
    }
  }
  lines.push('')
  lines.push('--- 三个后端 ---')
  for (const [kind, r] of Object.entries(diag.diagnosis)) {
    const pr = diag.probes[kind] ?? {}
    lines.push(`${(BACKENDS[kind]?.label ?? kind).padEnd(10)}: ${r.code.padEnd(18)} 端口 ${BACKENDS[kind]?.port} ${pr.online ? '在线' : '离线'}  ${r.title}`)
  }
  lines.push('')
  lines.push('--- 模型包安装 ---')
  for (const l of diagModelPacksBrief()) lines.push(l)
  const codes = Object.values(diag.diagnosis).map((r) => r.code)
  const firstBad = codes.find((c) => c !== 'OK' && c !== 'LOADING') ?? (codes.includes('LOADING') ? 'LOADING' : 'OK')
  const worst = diag.diagnosis[Object.keys(diag.diagnosis).find((k) => diag.diagnosis[k].code === firstBad)] ?? {}
  lines.push('')
  lines.push('--- 结论 ---')
  lines.push(`DIAGNOSIS: ${firstBad}`)
  if (worst.detail) lines.push(`详情      : ${worst.detail}`)
  if (worst.action) lines.push(`建议动作  : ${worst.action}`)
  if (firstBad === 'OK') lines.push('三个后端全部就绪, 未发现问题。')
  lines.push('')
  lines.push('（详细证据见本压缩包内的 02-显卡 / 03-CUDA / 04-端口 / 06-后端日志 / 10-启动时间线）')
  return lines.join('\n')
}

async function collectDiagnostics() {
  const runtime = backendRuntime()
  const probes = {}
  for (const kind of Object.keys(BACKENDS)) probes[kind] = await probeBackend(kind)
  const gpu = gpuInfo()
  const diag = { at: Date.now(), gpu, runtime, probes, diagnosis: {} }
  for (const kind of Object.keys(BACKENDS)) {
    diag.diagnosis[kind] = classifyBackend(kind, probes[kind], runtime[kind], gpu)
  }
  diag.summaryText = renderSummary(diag)
  return diag
}

/** 12-配置要求.txt: 最低要求是否满足 + 当前内存/显存释放策略 */
function diagSysreqText() {
  const sr = sysreqNow()
  const g = gpuInfo()
  const lines = []
  lines.push('【配置要求检查】')
  lines.push(`结论      : ${sr.ok ? (sr.unknown ? '基本满足（有无法识别的项）' : '满足最低要求') : '不符合最低要求'}`)
  lines.push(`最低要求  : 显存 ≥ ${MIN_REQ.vramMinMB / 1024}GB · 内存 ≥ ${MIN_REQ.ramMinGB}GB · NVIDIA ${MIN_REQ.gpuMinSeries} 系及以上`)
  lines.push(`实际      : ${sr.summary}`)
  lines.push(`显卡算力  : ${g.computeCap ?? '(没读到)'}`)
  for (const f of sr.fails) lines.push(`[不达标] ${f.label} —— ${f.detail}`)
  for (const n of sr.notes) lines.push(`[待确认] ${n.label} —— ${n.detail}`)
  lines.push('')
  lines.push('【内存/显存释放策略】')
  lines.push(`方案      : ${memPlanText()}`)
  lines.push(`自动清理内存: ${autoFreeEnabled() ? '开启' : '关闭'}`)
  lines.push(`说明      : ${autoFreeEnabled() ? AUTO_FREE_HINT.on : AUTO_FREE_HINT.off}`)
  lines.push(`档位含义  : keep=${POLICY_TEXT.keep} / balanced=${POLICY_TEXT.balanced} / aggressive=${POLICY_TEXT.aggressive}`)
  lines.push('')
  lines.push('注: 无论开关如何, 内存/显存压力过高时都会自动兜底释放(紧急阈值为档位对应的 90/85/75%)。')
  return lines.join('\n')
}

/* ---------------------------------------------------------------- 模型包安装现场
 *
 * 2026-10-30 加 —— 客户"某个模型包始终装不上"时, 上一份诊断包缺三样关键证据:
 *   ① 客户机上那个 .7z 到底多少字节（和官方一对比就知道是不是没传完 / 传坏了）
 *   ② 程序盘/数据盘/包所在盘还剩多少（解压要先落 1.02 倍 + 1.5GB 余量）
 *   ③ 解压用的 7z.exe 是哪个版本（版本不一致才可能"我们这儿解得开、他那儿打不开"）
 * 没有这三样, 只能靠猜; 有了就能直接下结论: 包是坏的 / 盘满了 / 解压器不对 / 都不是(那就是硬件)。
 */

const MODEL_INSTALL_RECORD = () => path.join(P.dataDir, 'models-install.json')

/**
 * 对外发过的包体积（字节）。只用于"你这份和官方不一样大"的提示 ——
 * 名字对不上就只报字节数, 不乱下结论。新包发布时在这里补一行。
 */
const KNOWN_PACK_BYTES = {
  '漫客_模型包_video_v1.2.0.7z': 64585988356,
  '漫客_模型包_video_v1.1.0.7z': 63561052533,
  '漫客_模型包_image_v1.1.0.7z': 45856050766,
  '漫客_模型包_qwen_v1.1.0.7z': 36278795405,
  '漫客_模型包_voice_v1.1.0.7z': 13182037386,
}

/** 人话体积（诊断包用, 0.01GB 精度足够看出"少了 3GB"） */
function fmtSize(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + 'GB'
  if (n >= 1048576) return (n / 1048576).toFixed(1) + 'MB'
  return n + ' 字节'
}

let sevenZDescCache = null
/**
 * 解压器版本行。客户那儿解不开、我们这儿好好的, 第一件事就是比这个 ——
 * 同一份 .7z 在 7-Zip 22.01 上 CRC 全过、在别的版本上炸, 那是版本/兼容问题, 不是包坏。
 */
function sevenZVersionText() {
  if (sevenZDescCache != null) return sevenZDescCache
  const sevenZ = path.join(P.appRoot, '7z.exe')
  if (!fs.existsSync(sevenZ)) { sevenZDescCache = '(程序目录里没有 7z.exe)'; return sevenZDescCache }
  let out = ''
  try { out = execCapture(sevenZ, ['i'], { timeout: 20000 }) } catch { out = '' }
  const line = String(out || '').split(/\r?\n/).find((l) => /7-Zip\s+\d/i.test(l)) || ''
  // 只留 "7-Zip 22.01 (x64)" —— 后面那串版权字样对判断没用, 还占诊断摘要的宽度
  const short = (line.match(/7-Zip\s+[\d.]+(\s*\((?:x64|x86|arm64)\))?/i) || [])[0]
  sevenZDescCache = (short || line).trim() || '(读不到版本)'
  return sevenZDescCache
}

/** 去重后的「盘符 剩多少」（程序盘 / 数据盘 / 模型盘 / 额外目录 —— 同一个盘只报一次） */
function drivesFreeText(extraDirs = []) {
  const seen = new Map()
  for (const dir of [P.appRoot, P.dataDir, P.backendsRoot, ...extraDirs]) {
    if (!dir) continue
    const root = path.parse(dir).root
    if (!root || seen.has(root)) continue
    const free = freeSpaceBytes(dir)
    seen.set(root, free == null ? '读不到' : '剩 ' + fmtSize(free))
  }
  return [...seen.entries()].map(([r, v]) => `${r.replace(/[\\/]+$/, '')} ${v}`).join(' · ') || '(读不到磁盘信息)'
}

function loadInstallRecord() {
  try { return JSON.parse(fs.readFileSync(MODEL_INSTALL_RECORD(), 'utf-8')) } catch { return null }
}

/**
 * 写下"这一次装的是什么"。诊断用, **写不进去绝不影响安装** ——
 * 所以整段 try/catch, 不抛。
 */
function saveInstallRecord(rec) {
  try {
    fs.mkdirSync(P.dataDir, { recursive: true })
    fs.writeFileSync(MODEL_INSTALL_RECORD(), JSON.stringify(rec, null, 2) + '\n', 'utf-8')
  } catch { /* 诊断记录写不进去就算了 */ }
}

/** 一个包文件 → 记录项（大小 + 时间 + 与官方体积的差） */
function packMetaOf(file) {
  const name = path.basename(file)
  let bytes = null
  let mtimeMs = null
  try { const st = fs.statSync(file); bytes = st.size; mtimeMs = st.mtimeMs } catch { /* 读不到就留 null */ }
  const official = KNOWN_PACK_BYTES[name] ?? null
  return { name, path: file, bytes, mtimeMs, official }
}

/** 官方体积对照那句话（名字不认识就空着, 不瞎断言） */
function packSizeVerdict(meta) {
  if (meta.official == null || meta.bytes == null) return ''
  if (meta.bytes === meta.official) return '· 与官方一致'
  const diff = meta.bytes - meta.official
  return `· ⚠ 与官方差 ${fmtSize(Math.abs(diff))}（官方 ${meta.official} 字节, 这份${diff > 0 ? '多' : '少'}了）`
}

/** 摘要里那几行（轻量: 不扫目录, 只读安装记录 + 盘剩余） */
function diagModelPacksBrief() {
  const out = []
  out.push(`解压器    : ${sevenZVersionText()}`)
  const rec = loadInstallRecord()
  if (rec) {
    const packs = rec.packs ?? []
    const results = rec.results ?? []
    const bad = results.filter((r) => !r.ok)
    /**
     * ⚠ 空 results ≠ 成功。安装跑到一半程序被杀/断电时, 记录里只有"开始"没有"结果";
     *   这里要是写成"全部成功", 支持侧就会把一次真失败当成装好了(2026-10-30 实测踩到)。
     */
    const verdict = !results.length
      ? '没有结果（安装没跑完/被中断）'
      : bad.length ? `失败 ${bad.length}` : '全部成功'
    out.push(`最近安装  : ${fmtLocal(rec.at)} · ${packs.length} 个包 · ${verdict}${rec.dir ? ' · ' + rec.dir : ''}`)
    for (const p of packs) {
      const extra = packSizeVerdict(p)
      out.push(`  ${p.name}  ${p.bytes == null ? '(读不到大小)' : p.bytes + ' 字节'}${extra ? ' ' + extra : ''}`)
    }
  } else {
    out.push('最近安装  : (没有记录 —— 这一版之后还没装过模型包)')
  }
  out.push(`盘剩余    : ${drivesFreeText()}`)
  return out
}

/** 13-模型包.txt: 解压器 / 磁盘 / 最近一次安装 / 现场还能看到的包文件 */
function diagModelPacksText() {
  const lines = []
  const sevenZ = path.join(P.appRoot, '7z.exe')
  const rec = loadInstallRecord()

  lines.push('【模型包安装现场】')
  lines.push('（"某个包装不上"先看这里: 包多大 · 盘剩多少 · 谁在解压）')
  lines.push('')
  lines.push('--- 解压器 ---')
  lines.push(`版本      : ${sevenZVersionText()}`)
  lines.push(`路径      : ${sevenZ}${fs.existsSync(sevenZ) ? '' : '  ← 不存在'}`)
  lines.push('')
  lines.push('--- 磁盘剩余 ---')
  lines.push(`盘        : ${drivesFreeText(rec?.dir ? [rec.dir] : [])}`)
  {
    const tmp = path.join(P.appRoot, '_models_incoming')
    let note = '不存在（正常）'
    if (fs.existsSync(tmp)) {
      let bytes = 0
      let files = 0
      const walk = (d, depth) => {
        if (depth > 6) return
        let es = []
        try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
        for (const e of es) {
          const f = path.join(d, e.name)
          if (e.isDirectory()) walk(f, depth + 1)
          else { try { bytes += fs.statSync(f).size; files++ } catch { /* ignore */ } }
        }
      }
      walk(tmp, 0)
      note = files === 0
        ? '还在（空目录 —— 安装被中断时留下的，无害，下次安装会重新用）'
        : `还在（${files} 个文件 / ${fmtSize(bytes)}）—— 上一次解压没清干净, 占着盘`
    }
    lines.push(`解压临时区: ${tmp} —— ${note}`)
  }
  lines.push('')

  lines.push('--- 最近一次安装 ---')
  if (!rec) {
    lines.push('(没有记录 —— 这一版之后还没点过安装)')
  } else {
    lines.push(`时间      : ${fmtLocal(rec.at)}`)
    lines.push(`选的目录  : ${rec.dir || '-'}`)
    lines.push(`包        :`)
    for (const p of rec.packs ?? []) {
      const when = p.mtimeMs ? '  ' + fmtLocal(p.mtimeMs) : ''
      const v = packSizeVerdict(p)
      lines.push(`  ${p.name}  ${p.bytes == null ? '(读不到大小)' : p.bytes + ' 字节'}${when}${v ? '  ' + v : ''}`)
    }
    lines.push(`结果      :`)
    if (!(rec.results ?? []).length) lines.push('  (还没跑完, 或当时没走到解压)')
    for (const r of rec.results ?? []) {
      const tag = r.ok ? (r.skipped ? '已装过, 跳过' : '成功') : String(r.msg ?? '失败')
      lines.push(`  ${r.ok ? '✓' : '✗'} ${r.pack}: ${tag}`)
    }
    if (rec.finishedAt) lines.push(`结束时间  : ${fmtLocal(rec.finishedAt)}`)
    if (rec.driveFreeAfter) lines.push(`装完盘剩余: ${rec.driveFreeAfter}`)
  }
  lines.push('')

  lines.push('--- 现场还能找到的包 ---')
  const dirs = []
  const push = (d) => { if (d && !dirs.includes(d) && fs.existsSync(d)) dirs.push(d) }
  if (rec?.dir) push(rec.dir)
  push(path.dirname(P.appRoot))
  try { push(path.join(os.homedir(), 'Downloads')) } catch { /* ignore */ }
  try { push(path.join(os.homedir(), 'Desktop')) } catch { /* ignore */ }
  /**
   * ⚠ 只列**像模型包**的东西。第一版不过滤, 结果把 `\$RECYCLE.BIN` 里的回收站条目和
   *   客户硬盘上几十个无关 .zip（AE 插件、字体、截图）全打印出来了 —— 既没法看, 也没必要
   *   把客户的文件名列进支持包。规则: 名字里带 模型包/model, 或者本来就是 .7z。
   */
  const looksLikePack = (name) => /模型包|model/i.test(name) || /\.7z(\.\d+)?$/i.test(name)
  const junkDir = (full) => /\$RECYCLE\.BIN|System Volume Information|\/node_modules\//i.test(full)
  const found = []
  const seenPath = new Set()
  for (const d of dirs) {
    let list = []
    try { list = findModelPackFiles(d, { maxDepth: 2, maxDirs: 200 }) } catch { list = [] }
    for (const p of list) {
      if (seenPath.has(p.path) || junkDir(p.path) || !looksLikePack(p.name)) continue
      seenPath.add(p.path)
      found.push(p)
    }
  }
  if (!found.length) lines.push('(在 安装目录 / 其上级 / 下载 / 桌面 都没扫到 .7z 模型包)')
  for (const p of found.slice(0, 8)) {
    const meta = { name: p.name, bytes: p.bytes, official: KNOWN_PACK_BYTES[p.name] ?? null }
    const v = packSizeVerdict(meta)
    lines.push(`  ${p.name}  ${p.bytes} 字节  ${fmtLocal(p.mtimeMs)}  ${p.path}${v ? '  ' + v : ''}`)
  }
  if (found.length > 8) lines.push(`  …还有 ${found.length - 8} 个`)
  lines.push('')
  lines.push('【怎么读这份】')
  lines.push('① 某个包"与官方差 x GB" → 这份拷贝没传完/传坏了, 别断点续传, 换通路重拷;')
  lines.push('② 体积都对但解压仍 CRC 失败 → 不是包的问题: 先换一台机器解压同一个包, 或查内存/硬盘(_models_incoming 是否残留、盘是否报错);')
  lines.push('③ 7-Zip 版本不是 22.01 → 先比版本再怀疑包。')
  return lines.join('\n')
}

function diagEntries(diag) {
  const e = []
  e.push({ name: '00-摘要.txt', data: diag.summaryText })
  e.push({ name: '01-机器.json', data: JSON.stringify(machineJson(), null, 2) })
  e.push({ name: '02-显卡.txt', data: diagGpuText() })
  e.push({ name: '03-CUDA.json', data: diagCudaJson() })
  e.push({ name: '04-端口.txt', data: diagPortsText(diag) })
  e.push({ name: '05-进程.txt', data: diagProcessText(diag) })
  for (const kind of Object.keys(BACKENDS)) {
    // ⚠️ 之前这里只看 BACKEND_PROCS: 后端不是本进程拉起时(上一轮进程/手工启动/服务重启过)
    //    整段日志不会进包 —— 用户反馈的"运行环境日志无法导出"就是它。改成扫磁盘日志文件。
    const files = backendLogFiles(kind)
    if (!files.length) {
      e.push({ name: `06-后端日志/${kind}.log`, data: '（这一路从未启动过，没有日志文件）' })
      continue
    }
    files.slice(0, 4).forEach((f, i) => {
      const name = i === 0 ? `06-后端日志/${kind}.log` : `06-后端日志/${kind}-历史${i}.log`
      e.push({ name, data: safeReadText(f) })
    })
  }
  try {
    for (const f of fs.readdirSync(LOG_DIR()).filter((n) => n.startsWith('crash-')).sort().slice(-5)) {
      e.push({ name: `06-后端日志/${f}`, data: fs.readFileSync(path.join(LOG_DIR(), f), 'utf8') })
    }
  } catch { /* ignore */ }
  e.push({ name: '07-应用日志.txt', data: diagAppLog() })
  e.push({ name: '08-设置.json', data: redactJson(diagSettings()) })
  e.push({ name: '09-画布结构.json', data: diagGraph() })
  e.push({ name: '10-启动时间线.txt', data: diagTimeline() })
  e.push({ name: '11-授权.txt', data: diagLicense() })
  e.push({ name: '12-配置要求.txt', data: diagSysreqText() })
  /** 13: 客户"某个包装不上"时最缺的三样证据(包多大 / 盘剩多少 / 谁在解压) */
  e.push({ name: '13-模型包.txt', data: diagModelPacksText() })
  return e
}

// ---------------------------------------------------------------- 后端状态探测

/**
 * 三路后端探测（带 1.5 秒缓存）。
 *
 * 为什么：/api/status 会被三处同时轮询（启动状态机 2 秒一次、画布顶栏监测 5 秒一次、
 * 设置面板打开时再刷一次），每次都真去连三个端口 —— 重复劳动 + 白白占用事件循环。
 * 1.5 秒缓存让"同一时刻的多方询问"合并成一次探测；用户点了启动/停止后最多晚 1.5 秒看到变化。
 */
let probeAllCache = { at: 0, val: null }
async function probeAllBackendsCached(ttlMs = 1500) {
  if (probeAllCache.val && Date.now() - probeAllCache.at < ttlMs) return probeAllCache.val
  const kinds = Object.keys(BACKENDS)
  const results = await Promise.all(kinds.map(probeBackend))
  const out = {}
  for (const r of results) out[r.kind] = r
  probeAllCache = { at: Date.now(), val: out }
  return out
}

async function probeBackend(kind) {
  const b = BACKENDS[kind]
  const base = { kind, label: b.label, port: b.port }
  /**
   * IndexTTS 推理时 Python 线程可能短时间占住，/status 2.5s 会超时；
   * 不能因此把正在干活的语音后端标红（否则独占在线会放别的模型进来抢显存）。
   */
  if (kind === 'indextts' && indexttsBusy > 0) {
    return { ...base, online: true, modelLoaded: true, loading: false, busy: true, voices: null, langs: null }
  }
  try {
    const r = await fetch(`http://127.0.0.1:${b.port}${b.probe}`, {
      signal: AbortSignal.timeout(kind === 'indextts' ? 10_000 : 2500),
    })
    if (!r.ok) return { ...base, online: false, detail: `HTTP ${r.status}` }
    const mrec = BACKEND_PROCS.get(kind)
    if (mrec && !mrec.readyAt) {
      mrec.readyAt = Date.now()
      timeline('backend-ready', { kind, afterMs: mrec.readyAt - mrec.startedAt })
    }
    // 它能答上来 = 已恢复 → 清掉"掉线日志"的去重时间戳, 下次再掉立刻记一笔 (P3)
    offlineLoudAt.delete(kind)
    const j = await r.json().catch(() => null)
    if (kind === 'indextts') {
      // /status 的 voices 是数量(number), 不是数组; 兼容数组与其它字段名
      const raw = j?.voices ?? j?.n_voices
      const voices = Array.isArray(raw) ? raw.length : (typeof raw === 'number' ? raw : null)
      return {
        ...base,
        online: true,
        modelLoaded: j?.model_loaded === true,
        loading: j?.loading === true,
        voices,
        langs: Array.isArray(j?.langs) ? j.langs : null,
      }
    }
    const dev = Array.isArray(j?.devices) ? j.devices[0] : null
    let queueRunning = null
    try {
      const q = await fetch(`http://127.0.0.1:${b.port}/queue`, { signal: AbortSignal.timeout(2000) })
      if (q.ok) {
        const qj = await q.json()
        queueRunning = qj?.queue_running?.length ?? null
      }
    } catch { /* 队列信息可选 */ }
    return {
      ...base,
      online: true,
      queueRunning,
      vramTotal: dev?.vram_total ?? null,
      vramFree: dev?.vram_free ?? null,
      device: dev?.name ?? null,
    }
  } catch (e) {
    // code 让前端能区分"端口直接拒绝"(ECONNREFUSED → 后端已停, 立刻变红)
    // 与"探测超时"(后端在忙 → 保留上一次状态, 避免状态灯乱闪)
    const anyE = e
    const code = anyE?.cause?.code || anyE?.code || ''
    return {
      ...base, online: false,
      detail: e instanceof Error ? e.message : String(e),
      code: String(code || ''),
    }
  }
}

async function handleStatus(req, res) {
  const kinds = Object.keys(BACKENDS)
  const out = await probeAllBackendsCached()
  const results = kinds.map((k) => out[k])
  // "首次"的判据是**目标程序自己的运行痕迹**(__pycache__ / triton 缓存 / user 配置),
  // 不是我们的标记文件 —— 否则"用户重新解压一份新包"会被误判成跑过。
  // 踩过: 首次启动实测可达 12 分钟, 而热机只要十几秒, 用热机数据定超时会误报失败。
  const marker = path.join(P.dataDir, '.first-run-done')
  const colds = kinds.map((k) => ({ kind: k, ...coldStartOf(k) }))
  const firstRun = colds.some((c) => c.cold)
  const coldReasons = colds.filter((c) => c.cold)
    .map((c) => `${c.kind}: ${c.reasons.join(' / ')}`)
  try {
    if (results.every((r) => r.online)) {
      ensureDir(P.dataDir)
      fs.writeFileSync(marker, new Date().toISOString(), 'utf8')
      // 只在"从没全就绪 → 全就绪"的翻转点记一次 —— 这个函数每次轮询都会跑,
      // 不判翻转会把时间线刷屏(踩过: 2 秒一条 all-backends-ready)
      if (!colds.some((c) => c.cold) && !lastAllReady) timeline('all-backends-ready')
      lastAllReady = true
    } else {
      lastAllReady = false
    }
  } catch { /* ignore */ }
  sendJson(res, 200, {
    ok: true, backends: out, port: PORT, firstRun, coldStart: colds, coldReasons,
    /** 按需启动: 前端据此判断"后端没起"是正常状态而不是故障 */
    lazy: lazyBackendsEnabled(),
    /** 手动启动: 前端据此**不做**自动重试拉起 (否则就是"模型自启动") */
    manual: manualStartEnabled(),
    // 版本三件套: 程序自己 / 模型包 / 两者契约 —— 前端与诊断包都靠它避免"版本对不上"的糊涂账
    version: {
      program: P.versionInfo?.program?.version ?? '',
      build: P.versionInfo?.program?.build ?? 0,
      channel: P.versionInfo?.channel ?? '',
      gitCommit: P.versionInfo?.program?.gitCommit ?? '',
      /** 分发水印 (每个内测包唯一): 激活页页脚与诊断包都会带, 便于定位泄漏来源 */
      watermark: P.versionInfo?.program?.watermark ?? '',
    },
    models: (() => {
      const m = P.modelsQuick()
      return {
        root: m.root, packVersion: m.packVersion, apiVersion: m.apiVersion,
        supportedApiVersion: m.supportedApiVersion, compat: m.compat,
        /** totalCount 只数必装组件 —— qwen 是可选第 4 路, 不该把它算成"缺一个" */
        installedCount: m.installedCount, totalCount: m.requiredCount ?? m.components.length,
      }
    })(),
    // 最低配置检查(前端据此"强制提示不符合最低要求") + 自动清理内存开关状态
    sysreq: sysreqNow(),
    autoFree: autoFreeEnabled(),
    autoFreeHint: autoFreeEnabled() ? AUTO_FREE_HINT.on : AUTO_FREE_HINT.off,
    /** 空闲自动卸载: 0 = 关闭, 其它为分钟数(默认 10) */
    idleFreeMinutes: idleFreeMinutes(),
    memPlan: (() => { const m = memPolicy(undefined, gpuMemoryNow()); return { policy: m.policy, planText: m.planText, summary: m.summary } })(),
    /** 启动档位(低显存适配): 前端据此显示"你这台机器走哪一档 + 低配提示" */
    launch: launchProfile(),
  })
}

// ---------------------------------------------------------------- 启动后端

// ---------------------------------------------------------------- 后端进程托管
// 为什么不再开"独立黑窗口"、改成自己 spawn 托管:
//   1) 独立窗口的输出滚掉就没了 —— 出问题时我们什么都拿不到, 只能让用户去读窗口
//   2) 拿不到 PID —— 关软件时没法清理端口; 意外退出后面会留残留
//   3) 拿不到输出 —— 进度条只能靠端口轮询, 又慢又假
// 托管后: stdout/stderr 双写(落盘 + 内存 tail), PID 落 run-state.json,
//         关软件时按记录的 PID 树清理, 下次启动自动清残留。
// 后端一律静默托管, **不开任何窗口**。
// 需要看后端的实时输出时, 用排障启动器(start-h3-video-8188.bat 等), 或看 data/logs/ 与诊断包。
const LOG_MAX_BYTES = 30 * 1024 * 1024   // 单文件 30MB 后轮转
const LOG_KEEP = 3                       // 保留 3 份历史
const LOG_DIR_MAX = 100 * 1024 * 1024    // logs 目录总量上限 100MB
const TAIL_LINES = 400                   // 内存里保留的最近行数

/** kind -> { child, pid, startedAt, logPath, tail[], exited, exitCode, ... } */
const BACKEND_PROCS = new Map()
/**
 * 最近一次"主动停掉某一路"的时间 (2026-10-06)。
 *   给启动前的端口残留判定用: 刚停完还占着端口的进程, 一律按**残留**处理(结束它),
 *   不许被当成"这一路已经在跑"而放过去 —— 否则「重启」会变成静默不生效。
 */
const BACKEND_STOPPED_AT = new Map()

const LOG_DIR = () => path.join(P.dataDir, 'logs')
const RUN_STATE = () => path.join(P.dataDir, 'run-state.json')

function ensureDir(d) {
  try { fs.mkdirSync(d, { recursive: true }) } catch { /* ignore */ }
}

/** 某个后端的 python_embeded 目录(兼容栈选择器就装在它的 site-packages 里) */
function backendPythonDir(kind) {
  if (kind === 'h3') return path.join(P.h3Root, 'python_embeded')
  if (kind === 'kear') return path.join(P.kearRoot, 'python_embeded')
  if (kind === 'indextts') return path.join(P.indexttsRoot, 'python_embeded')
  /**
   * 千问的 python 在 **conda 风格的 env\** 下(不是 python_embeded\), 而 site-packages
   * 同样是 `<env>\Lib\site-packages` —— 所以这里返回 env\ 就够 installCompatPth 拼对路径。
   * 2026-10-06 起千问也进 COMPAT_KINDS(实测能吃同一套 _vendor/cu126)。
   */
  if (kind === 'qwen') return path.join(P.qwenRoot, 'env')
  return null
}

/**
 * 当前该用哪套 CUDA 运行时。
 * 包里带两套同版本号的 torch: 2.13.0+cu130(默认, 需驱动 >=580.88) 和 2.13.0+cu126(兼容, 需 >=560.76)。
 * 判定与 .pth 里一致: 驱动主版本 < 580 就走 cu126。
 */
function cudaCompat() {
  const available = vendorExists(P.appRoot)
  const v = gpuInfo().driverVersion
  const a = driverAdvice({ driverVersion: v })
  if (!available) return { available: false, mode: 'cu130', driver: v || '', reason: 'no-vendor' }
  if (a.code === 'UNKNOWN') return { available: true, mode: 'cu130', driver: v || '', reason: 'driver-unknown' }
  /**
   * ⚠️ 门槛必须与 tools/sysreq.mjs 的 driverAdvice 完全一致(以前这里只比主版本 ≥580):
   *    580.30 这种"看着够新其实不够"的驱动会被判成 cu130, 但 .pth 选择器按
   *    cuDriverGetVersion 判定, 实际会走 cu126 —— 两边口径不一致, 日志就会自相矛盾。
   */
  if (a.code === 'TOO_OLD_FAR') return { available: true, mode: 'cu126', driver: v, reason: 'driver-too-old' }
  if (a.code === 'TOO_OLD_NEED_580') return { available: true, mode: 'cu126', driver: v, reason: 'auto' }
  return { available: true, mode: 'cu130', driver: v, reason: 'auto' }
}

/**
 * 这一路后端**实际用的运行库**是什么(日志头与诊断包都要能看到)。
 * 2026-10-06 起三条 CUDA 路(H3 / Krea2 / 千问)都进 COMPAT_KINDS, 共用同一套 _vendor/cu126;
 * 只有语音路(IndexTTS)自带 torch 2.8.0+cu128、明确不参与切换 —— 这句也要写进日志, 免得远程瞎猜。
 */
function stackLabelFor(kind) {
  if (kind === 'text') return '本地小文本模型(纯 CPU, 不占显存、不看驱动)'
  const t = torchOf(kind)
  if (kind === 'indextts') return `torch ${t || '?'}（语音路自带, 不参与 CUDA 兼容栈切换）`
  if (!t) return '(没读到 torch 版本：该路模型包可能没装全)'
  if (!COMPAT_KINDS.includes(kind)) return `torch ${t} —— 本路没装兼容栈选择器（代码里漏了这一路），驱动不达标就会崩`
  if (!cudaCompat().available) return `torch ${t} —— 包里没有 CUDA 12.6 兼容栈，驱动不达标就会崩（可装「低驱动兼容补丁」）`
  return cudaCompat().mode === 'cu126'
    ? `torch ${t} → 已切到包内 CUDA 12.6 兼容栈（torch 2.13.0+cu126）`
    : `torch ${t}（驱动达标，走默认栈）`
}

/**
 * 写进**每一路后端启动日志头**的"显卡与驱动"判定 (2026-10-06 用户)。
 *
 * 为什么要写进日志头而不是只在界面弹一下:
 *   这类故障(0xC0000005)是原生崩溃, 用户导出的日志里只有
 *   "Windows fatal exception: access violation" 一行, 用户看不懂、
 *   客服也判断不出是驱动问题。把"这台机器什么卡 / 什么驱动 / 我们怎么判的 /
 *   该怎么办"固定在**每次启动的第一屏**, 就不需要任何人再去猜。
 */
function gpuLogHead(kind) {
  try {
    const g = gpuInfo()
    const adv = driverAdvice(g, { compatAvailable: vendorExists(P.appRoot) })
    const vram = g.vramTotal ? `${(g.vramTotal / 1024).toFixed(1)}GB` : '未知'
    const lines = [
      `[gpu] 本机显卡 ${g.name || '(未识别)'} · 驱动 ${g.driverVersion || '(未知)'}`
        + ` · 算力 ${g.computeCap ?? '未知'} · 显存 ${vram}`,
      `[gpu] 驱动判定 ${adv.level}（${adv.code}）—— ${adv.detail}`,
    ]
    if (adv.action) lines.push(`[gpu] 处理建议 ${adv.action}`)
    if (adv.archNote) lines.push(`[gpu] 注意 ${adv.archNote}`)
    lines.push(`[gpu] 本路运行库 ${stackLabelFor(kind)}`)
    lines.push(`[gpu] 门槛参考 默认栈需驱动 ≥ ${DRIVER_REQ.cu130.need} · `
      + `CUDA 12.6 兼容栈需 ≥ ${DRIVER_REQ.cu126.need} · 兼容栈在包内${vendorExists(P.appRoot) ? '已自带' : '缺失'}`)
    return lines.join('\n') + '\n'
  } catch { return '' }
}

/** 把选择器 .pth 同步到各后端环境: H3/Krea2/千问 装, 其余确保没有(IndexTTS 有自己的 torch 2.8+cu128) */
function syncCompatPth() {
  const changed = []
  for (const kind of Object.keys(BACKENDS)) {
    const dir = backendPythonDir(kind)
    if (!dir) continue
    const r = COMPAT_KINDS.includes(kind) ? installCompatPth(dir) : removeCompatPth(dir)
    if (r === 'written' || r === 'removed' || r === 'failed') changed.push(`${kind}:${r}`)
  }
  return changed
}

function logPathFor(kind) {
  const d = new Date()
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return path.join(LOG_DIR(), `${kind}-${stamp}.log`)
}

/**
 * 某一路后端**磁盘上真实存在的日志文件**(按改动时间从新到旧)。
 *
 * 为什么要有它: 之前导出诊断包 / 拼日志时只看 BACKEND_PROCS(本进程托管的后端) ——
 *   后端是"上一轮进程起的 / 手工敲命令起的 / 服务重启过"时, 这里没有记录,
 *   于是日志整段缺失(用户反馈"运行环境日志无法导出"就是这个)。
 * 现在改成: 托管记录的 logPath 优先, 其次扫 logs 目录里 `<kind>-*.log`(含轮转的 .1/.2)。
 */
function backendLogFiles(kind) {
  const out = []
  const push = (p) => { if (p && fs.existsSync(p) && !out.includes(p)) out.push(p) }
  const rec = BACKEND_PROCS.get(kind)
  push(rec?.logPath)
  push(logPathFor(kind))              // 当天文件(即使本进程没托管, 只要今天起过就在)
  try {
    const dir = LOG_DIR()
    const names = fs.readdirSync(dir)
      .filter((n) => n.startsWith(`${kind}-`) && n.includes('.log'))
      .map((n) => {
        let m = 0
        try { m = fs.statSync(path.join(dir, n)).mtimeMs } catch { /* ignore */ }
        return { n, m }
      })
      .sort((a, b) => b.m - a.m)
      .map((x) => x.n)
    for (const n of names) push(path.join(dir, n))
  } catch { /* 目录还没建 */ }
  return out
}

/** 安全读文本文件(截断到 max 字节, 避免诊断包/复制内容爆炸) */
function safeReadText(p, max = 400_000) {
  try {
    const txt = stripAnsiText(fs.readFileSync(p, 'utf-8'))
    return txt.length > max ? `…(仅保留尾部 ${max} 字符)\n${txt.slice(-max)}` : txt
  } catch (e) {
    return `(读取失败: ${e?.message ?? e})`
  }
}

/** 日志轮转: 单文件超限就重命名成 .1/.2..., 目录总量超限就淘汰最旧的 */
function rotateLogs(cur) {
  try {
    ensureDir(LOG_DIR())
    if (fs.existsSync(cur) && fs.statSync(cur).size > LOG_MAX_BYTES) {
      for (let i = LOG_KEEP - 1; i >= 1; i--) {
        const a = `${cur}.${i}`
        if (fs.existsSync(a)) { try { fs.renameSync(a, `${cur}.${i + 1}`) } catch { /* ignore */ } }
      }
      try { fs.renameSync(cur, `${cur}.1`) } catch { /* ignore */ }
    }
    const files = fs.readdirSync(LOG_DIR()).map((n) => {
      const p = path.join(LOG_DIR(), n)
      try { const st = fs.statSync(p); return { p, size: st.size, mtime: st.mtimeMs } } catch { return null }
    }).filter(Boolean).sort((a, b) => a.mtime - b.mtime)
    let total = files.reduce((s, f) => s + f.size, 0)
    for (const f of files) {
      if (total <= LOG_DIR_MAX) break
      try { fs.unlinkSync(f.p); total -= f.size } catch { /* ignore */ }
    }
  } catch { /* 日志出问题绝不能影响启动 */ }
}

function writeRunState() {
  try {
    ensureDir(P.dataDir)
    const procs = []
    for (const [kind, rec] of BACKEND_PROCS) {
      if (rec.exited || !rec.pid) continue
      procs.push({ kind, pid: rec.pid, startedAt: rec.startedAt, logFile: path.basename(rec.logPath) })
    }
    fs.writeFileSync(RUN_STATE(), JSON.stringify({ updatedAt: Date.now(), procs }, null, 2), 'utf8')
  } catch { /* ignore */ }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' }
}

/** 只杀我们记录的 PID 树; 绝不"按端口杀进程"(用户可能自己开了别的同类程序) */
function killTree(pid, hard = false) {
  try {
    const args = ['/PID', String(pid), '/T']
    if (hard) args.push('/F')
    const c = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' })
    c.on('error', () => { /* ignore */ })
  } catch { /* ignore */ }
}

/** 启动时清理上次残留 (强制退出/断电后 run-state.json 会留下 PID) */
/**
 * 请本地文本模型把显存让出来(但它**不停进程**)。
 *   为什么需要: H3 跑起来要 19.4/20GB —— 文本模型若还占着 1~3GB, 视频那一路就会爆显存。
 *   为什么不停进程: 它下次要用的代价只有"重新加载模型"(0.5B 约 2 秒), 而进程留着能保住
 *   已经下好的 tokenizer 与 transformers 环境, 比每次冷启快得多。
 */
async function freeTextVram() {
  try {
    const r = await fetch(`http://127.0.0.1:${BACKENDS.text.port}/unload`, {
      method: 'POST', signal: AbortSignal.timeout(3000),
    })
    return r.ok
  } catch { return false }   // 没起/已退出都算正常
}

function cleanupStaleBackends() {
  try {
    if (!fs.existsSync(RUN_STATE())) return
    const st = JSON.parse(fs.readFileSync(RUN_STATE(), 'utf8'))
    const killed = []
    for (const p of st.procs ?? []) {
      if (!p.pid) continue
      if (processAlive(p.pid)) {
        /**
         * ★ 2026-10-10 安全加固（彻底检查"残留进程"时发现）:
         *   run-state.json 里的 PID 是**上一次**进程写的，而 Windows 会**复用 PID**。
         *   以前这里直接 killTree —— 万一那个号已经被系统分给了别的程序（用户刚开的
         *   编辑器/浏览器/另一个 ComfyUI），就等于**误杀用户的东西**。
         *   现在先验"这个 PID 的 exe 还在我们的模型包目录里"，不是就跳过（并记一行日志）。
         */
        if (!pidIsOurs(p.pid)) {
          console.log(`[backends] run-state 的 pid ${p.pid}(${p.kind}) 现在不是本程序的进程`
            + '(PID 可能已被系统复用), 跳过不杀')
          continue
        }
        /**
         * ⚠️ 2026-10-02 补(用户第三次贴日志问"H3 为什么莫名 SIGTERM"): 这条清理路径以前**只写我们
         *   自己的控制台**, 被清掉那个后端的日志文件里只剩一个 `exited … signal=SIGTERM`。
         *   最常见的就是**升级/重启程序的那一刻**: 旧服务进程还没退干净, 它名下的 H3 被新服务当
         *   "上次残留"清掉 —— 而且那行 `exited` 是**旧服务**写的, 旧版本代码里没有原因行, 于是
         *   升级前后那一段日志永远看不出是谁停的(用户就是这么被绊住的)。
         *   现在: 清之前先往**那个后端自己的日志文件**尾部追一行原因(run-state 里记了 logFile)。
         */
        try {
          const lf = p.logFile ? path.join(LOG_DIR(), p.logFile) : ''
          if (lf && fs.existsSync(lf)) {
            fs.appendFileSync(lf,
              `\n===== 主动关闭：上次程序退出时残留的后端进程，本次启动已清理（pid ${p.pid}） =====\n`, 'utf8')
          }
        } catch { /* 记不上也不影响清理 */ }
        killTree(p.pid, true)
        killed.push(`${p.kind}#${p.pid}`)
      }
    }
    fs.unlinkSync(RUN_STATE())
    if (killed.length) console.log('[backends] 已清理上次残留进程:', killed.join(', '))
  } catch { /* ignore */ }
}

/** 托管启动一个后端: spawn + stdout/stderr 落盘 + tail + PID 记录 */
/**
 * 剥掉 ANSI 颜色/控制码。
 * ComfyUI / IndexTTS 的日志带颜色, 直接显示会变成 "[0;33m[WARNING][0m" 这类乱码
 * —— 这是"配置与启动页特别乱"的主要来源。落盘、内存 tail、读磁盘三条路都要过它。
 */
function stripAnsiText(s) {
  return String(s)
    .replace(/\u001b\][^\u0007]*\u0007/g, '')                    // OSC ... BEL
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')                 // CSI (颜色/光标)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')    // 其它控制字符
}

/**
 * 「torch 的 DLL 初始化失败」的**实测诊断** (2026-10-12 客户机现场)。
 *
 * 用户转来的原文:
 *   `OSError: [WinError 1114] 动态链接库(DLL)初始化例程失败。 Error loading
 *    "D:\Manke\backends\comfyui-kear2\python_embeded\Lib\site-packages\torch\lib\c10.dll" or one of its dependencies.`
 *   紧接着 `Windows fatal exception: access violation`(同一个 `_load_dll_libraries`)。
 *
 * 这不是端口问题、也不是模型文件缺失 —— 是 **torch 的 c10.dll 在初始化阶段就失败**。常见真因三类,
 * 而客户机上到底是哪一类**必须实测**才知道(用户要求: "这些话术必须是因为真正的缺失导致的"):
 *   ① **VC++ 运行库缺失/过旧** —— 实测口径: 那两个 ComfyUI 包**只自带 `vcruntime140*.dll`, 不自带
 *      `msvcp140.dll`**(千问那个 conda 包自带全套, 所以它不受影响), 于是 H3/Krea2 都得靠系统的
 *      VC++ 2015-2022 运行库; 客户机没装/装的是旧版 → c10.dll 一初始化就炸(正好是 WinError 1114)。
 *   ② **显卡驱动撑不起默认的 CUDA 13 栈** —— 这时换包内自带的 CUDA 12.6 兼容栈就能起来(已自动重试一次)。
 *   ③ **杀软/EDR 拦了或注入了 torch 的 dll**。
 * 所以这里**逐条查**, 只把**确实查出来的**写进诊断, 并给出对应的那一条出路。
 */
function diagnoseTorchDllInit(kind) {
  const b = BACKENDS[kind]
  const out = [`【诊断】${b.label} 的 torch 运行库没能初始化(DLL 初始化例程失败 / WinError 1114)`]
  const add = (s) => out.push(s)
  try {
    const pyExe = backendPyPath(kind)
    const pyRoot = pyExe ? path.dirname(pyExe) : ''
    /** ① 现在跑的是哪个栈 + 驱动 */
    try {
      const c = cudaCompat()
      let stack = ''
      try { stack = stackLabelFor(kind) } catch { /* ignore */ }
      add(`· 这一路现在用的运行库: ${stack || '(读不到)'}`)
      add(`· 显卡驱动: ${c.driver || '读不到'} · 兼容栈: ${c.available ? '包内有(可切 cu126, 需驱动 ≥ 560.76)' : '包内没有'}`)
    } catch { /* ignore */ }
    /** ② MSVC 运行库: 包内 python 目录 + 系统目录逐个数 */
    const NEED = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']
    const inPack = []
    const notInPack = []
    for (const n of NEED) {
      let ok = false
      try { ok = !!(pyRoot && fs.existsSync(path.join(pyRoot, n))) } catch { ok = false }
      ;(ok ? inPack : notInPack).push(n)
    }
    add(`· 模型包内自带的: ${inPack.length ? inPack.join('、') : '一个都没有'}`
      + (notInPack.length ? ` —— 缺 ${notInPack.join('、')}(这两个包历来只带 vcruntime140*.dll, 要靠系统那份)` : ''))
    const sysDir = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
    const sysFound = []
    const sysMissing = []
    for (const n of NEED) {
      const p = path.join(sysDir, n)
      try {
        if (fs.existsSync(p)) sysFound.push(`${n}(${Math.round(fs.statSync(p).size / 1024)}KB)`)
        else sysMissing.push(n)
      } catch { sysMissing.push(n) }
    }
    add(`· 系统里的 VC++ 运行库(${sysDir}): ${sysFound.length ? sysFound.join('、') : '一个都没有'}`
      + (sysMissing.length ? ` —— 缺 ${sysMissing.join('、')}` : ''))
    add('怎么办:')
    if (sysMissing.length) {
      add(`  ① 【最可能】这台机器缺 ${sysMissing.join('、')} —— 装一次「Microsoft Visual C++ 2015-2022 Redistributable (x64)」`
        + `(微软官网搜 vc_redist.x64.exe), 装完不用重启本程序, 直接再点一次「启动」。`)
    } else {
      add('  ① 系统的 VC++ 运行库看着是全的 —— 那就先试下一条。')
    }
    add('  ② 更新一次显卡驱动(默认栈要 ≥ 580.88; 程序已自动用包内 CUDA 12.6 兼容栈重试过一次)。')
    add('  ③ 杀毒/安全软件把 torch 的 dll 拦了或注入了: 把本程序目录与模型目录加进白名单, 再重启程序。')
    add(`  ④ 都不行: 把 data\\logs\\crash-${kind}-*.log 发给客服(这一份里带着上面这些实测数据)。`)
  } catch (e) {
    add(`· (诊断本身出错: ${e && e.message ? e.message : e})`)
  }
  return out.join('\n')
}

/** 「换兼容栈重试」**每个进程每一路只做一次**(免得两头来回重试打成乒乓) */
const COMPAT_RETRIED = new Set()

/**
 * 见 diagnoseTorchDllInit: 默认 CUDA 栈上 torch 的 DLL 初始化失败 → 自动换包内 cu126 兼容栈重试**一次**。
 * 只在: 命中该告警 + 包内确实有兼容栈 + 现在不是 cu126 + 没人显式指定过 AICS_CUDA_MODE + 没重试过 时动手。
 */
function retryWithCompatStackOnce(kind, rec) {
  try {
    if (!rec || rec.stopping) return
    if (!(rec.alerts ?? []).some((a) => a.code === 'TORCH_DLL_INIT')) return
    if (COMPAT_RETRIED.has(kind)) return
    if (process.env.AICS_CUDA_MODE) return
    if (rec.compatStack === 'cu126') return
    const c = cudaCompat()
    if (!c.available || c.mode === 'cu126') return
    COMPAT_RETRIED.add(kind)
    log(`[launch] ${BACKENDS[kind].label}: 默认 CUDA 栈上 torch 的 DLL 初始化失败 → 自动改用包内 CUDA 12.6 兼容栈重试一次`)
    setTimeout(() => {
      launchBackend(kind, { compatStack: 'cu126', autoRetry: true })
        .then((r) => { if (r?.ok) log(`[launch] ${BACKENDS[kind].label}: 兼容栈重试已发起 (${r.detail || ''})`) })
        .catch(() => { /* 起不来就走诊断那条路 */ })
    }, 1500)
  } catch { /* ignore */ }
}

function managedSpawn(kind, a) {
  const b = BACKENDS[kind]
  ensureDir(LOG_DIR())
  const logPath = logPathFor(kind)
  rotateLogs(logPath)
  const stream = fs.createWriteStream(logPath, { flags: 'a' })
    const head = `\n===== ${new Date().toLocaleString('zh-CN')} start ${b.label} (${b.port}) =====\n`
      /**
       * 把这次启动**实际用的 PATH 前缀**写进日志头 (2026-09-28)。
       *   千问那一路的 conda env\Library\bin 是个真坑(见 backendEnv 的注释): 远程排障时
       *   "这台机器到底有没有把它加进去"必须一眼可见, 而不是让用户去猜为什么 import ssl 会崩。
       *   只写与实际后端相关的几条(进程自带的 python 目录 + 它旁边的原生依赖目录)。
       */
      + (() => {
        try {
          const pyExe = a?.pyExe
          if (!pyExe || !/python(w)?\.exe$/i.test(pyExe)) return ''
          const env = a?.env ?? {}
          const first = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean).slice(0, 5)
          return first.length ? `[env] PATH 前置: ${first.join(' ; ')}\n` : ''
        } catch { return '' }
      })()
      /** 这次启动前"补齐了哪些模型包缺失文件" —— 远程排障就看这一行(千问包缺 comfy_api\input 那件事) */
      + (Array.isArray(a?.healed) && a.healed.length ? `[heal] 已补齐 ${a.healed.length} 个缺失文件: ${a.healed.join(', ')}\n` : '')
      /**
       * 显卡与驱动判定 (2026-10-06 用户: "在日志里面也做一个判定, 用户的版本是什么,
       *   大概的解决方案是什么, 可以提醒用户")。
       * 放在日志头 = 每次启动都能看到"现在这台机器是什么卡/什么驱动/我们会怎么走",
       * 出问题导日志时这一屏就在最上面, 不用再问用户"你驱动多少"。
       */
      + gpuLogHead(kind)
  stream.write(head)

  // 历史日志预热 (2026-09-14): 新起的进程往往只吐一两行 —— 最典型的是 IndexTTS,
  //   启动只报一句 "model loading in background", 于是前端日志卡片看起来"什么都没有",
  //   用户会以为后端没起来。这里把该日志文件已有的尾部先塞进 tail:
  //   · 卡片一打开就有内容可看 (含上一次运行的记录)
  //   · 紧接着就是本次启动的分隔行, 一眼能分清哪段是本次的
  const seededTail = (() => {
    try {
      return stripAnsiText(fs.readFileSync(logPath, 'utf-8')).split(/\r?\n/)
        .filter((l) => l.trim()).slice(-24).map((l) => l.slice(0, 220))
    } catch { return [] }
  })()

  const child = spawn(a.pyExe, a.args, {
    cwd: a.cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // PYTHONUNBUFFERED 必须有: stdout 是管道时默认块缓冲, 不设的话日志和进度关键字会延迟很久
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', ...a.env },
  })
  /** 新进程即将绑定端口：旧的占用者/身份结论立即作废 */
  invalidateBackendIdentity(kind)

  const rec = {
    kind, pid: child.pid, child, logPath, startedAt: Date.now(), stream,
    tail: seededTail, exited: false, exitCode: null, signal: null,
    sawFirstOutput: false, firstOutputAt: null, sawVram: false, sawReadyHint: false,
    // 全程监测用: 最后一次"听到动静"的时间 / 累计输出行数 / 命中的告警
    lastOutputAt: Date.now(), lineCount: 0, alerts: [],
    cold: coldStartOf(kind).cold,
    /** 这次启动被**强制**走的 CUDA 栈(只有"兼容栈重试"那条路会填) —— 见 retryWithCompatStackOnce */
    compatStack: String(a?.env?.AICS_CUDA_MODE || '') || null,
  }
  BACKEND_PROCS.set(kind, rec)
  writeRunState()
  timeline('backend-launch', { kind, pid: child.pid })

  const onData = (buf) => {
    const text = stripAnsiText(buf.toString('utf8'))
    try { stream.write(text) } catch { /* ignore */ }
    // 全程监测: 每次收到输出都刷新"最后动静时间", 前端据此区分"在动"与"卡住"
    rec.lastOutputAt = Date.now()
    if (!rec.sawFirstOutput) {
      rec.sawFirstOutput = true
      rec.firstOutputAt = Date.now()
      timeline('backend-first-output', { kind, afterMs: rec.firstOutputAt - rec.startedAt })
    }
    if (/Total VRAM/i.test(text)) rec.sawVram = true
    if (/Starting server|To see the GUI|model loaded|Uvicorn running/i.test(text)) rec.sawReadyHint = true
    for (const ln of text.split(/\r?\n/)) {
      if (!ln.trim()) continue
      rec.tail.push(ln)
      rec.lineCount++
      if (rec.tail.length > TAIL_LINES) rec.tail.shift()
    }
    // 错误关键字即时捕获 —— 这是"全程监测"的核心: 不等进程退出就知道出什么事了
    try {
      for (const a of scanAlerts(rec, text)) {
        if (a.sev === 'error') timeline('backend-alert', { kind, code: a.code, sample: a.sample })
      }
    } catch { /* ignore */ }
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)

  child.on('error', (e) => {
    try { stream.write(`\n[spawn error] ${e?.message ?? e}\n`) } catch { /* ignore */ }
  })
  child.on('exit', (code, signal) => {
    rec.exited = true
    rec.exitCode = code
    rec.signal = signal
    timeline('backend-exit', { kind, code, livedMs: Date.now() - rec.startedAt })
    const secs = Math.round((Date.now() - rec.startedAt) / 1000)
    try { stream.write(`\n===== exited code=${code} signal=${signal} after ${secs}s =====\n`) } catch { /* ignore */ }
    /**
     * ⚠️ 2026-10-01 补 (用户连着两次贴日志问"H3 为什么莫名 SIGTERM")。
     *
     *   我们自己发起的停止都会**先**写一行 `===== 主动关闭：<原因> =====`(见 noteStop) ——
     *   反过来, 日志里没有那一行, 就说明这次退出**不是本程序停的**: 程序被强杀
     *   (任务管理器 / 安装包覆盖 / 更新器)、系统回收、或者后端自己崩。
     *   把这句话直接写进日志, 以后不用再靠猜。
     */
    if (!rec.stopping) {
      try {
        stream.write('\n⚠️ 这次退出不是本程序发起的（上面没有「主动关闭：…」那一行）。\n'
          + '   常见来源：① 程序被强制结束（任务管理器 / 覆盖安装 / 更新器）'
          + '　② 系统回收内存　③ 后端自己崩（看上面的 traceback，另有一份 crash-*.log）。\n')
      } catch { /* ignore */ }
    }
    /**
     * ★ 2026-10-12: "torch 的 DLL 初始化失败"(客户机现场) —— 诊断要在 stream.end() **之前**写进日志。
     *   ⚠️ 这一行踩过一次: 写在 end() 之后 → `ERR_STREAM_WRITE_AFTER_END` 是**异步的 'error' 事件**,
     *   外面那层 try/catch 接不住, 直接把整个服务端进程带崩(探针第一版就是这么暴露的)。
     */
    if (code !== 0 && !rec.stopping) {
      try {
        const torchAlert = (rec.alerts ?? []).find((x) => x.code === 'TORCH_DLL_INIT')
        if (torchAlert && !torchAlert.hint) torchAlert.hint = diagnoseTorchDllInit(kind)
        /** 诊断同时落到**后端日志**和下面的 crash-*.log —— 用户"发一个文件过来"就带着全部现场 */
        rec.torchHint = torchAlert?.hint || ''
        if (rec.torchHint) stream.write(`\n${rec.torchHint}\n`)
      } catch { /* ignore */ }
    }
    try { stream.end() } catch { /* ignore */ }
    if (code !== 0 && !rec.stopping) {
      /**
       * 非正常退出: 留一份崩溃记录(最后 80 行 + 上面那段**实测诊断**) —— 用户"发一个文件过来"就带着现场。
       *   注: 我们自己主动 kill 的(关软件/重启后端)不算崩溃, 由 rec.stopping 标记。
       * 另外: 命中"torch 的 DLL 初始化失败"时, 这里再自动换包内 CUDA 12.6 兼容栈**重试一次**
       *   (见 retryWithCompatStackOnce)。
       */
      try {
        const crash = path.join(LOG_DIR(), `crash-${kind}-${Date.now()}.log`)
        fs.writeFileSync(crash,
          `backend: ${b.label} (${kind})\nexit code: ${code}\nsignal: ${signal}\n` +
          `started: ${new Date(rec.startedAt).toLocaleString('zh-CN')}\n` +
          `lived: ${secs}s\n\n--- last ${Math.min(80, rec.tail.length)} lines ---\n` +
          rec.tail.slice(-80).join('\n') + '\n'
          + (rec.torchHint ? `\n--- 诊断(实测) ---\n${rec.torchHint}\n` : ''), 'utf8')
        /** 「torch 的 DLL 初始化失败」→ 换兼容栈重试一次(见该函数说明; 只在命中时动手) */
        retryWithCompatStackOnce(kind, rec)
      } catch { /* ignore */ }
    }
    writeRunState()
  })

  return rec
}

/** 停止所有由本服务托管的后端 */
/**
 * 给某个后端的日志文件补一行"人话"说明 (2026-09-20)。
 *
 * 为什么需要: 用户反馈"H3 后端莫名其妙挂掉" —— 查日志只看到
 *   `===== exited code=null signal=SIGTERM after 272s =====`, 完全不知道是谁停的。
 *   ComfyUI 自己崩会留 traceback; 只有**我们主动停**才会是这种干净的 SIGTERM。
 *   现在每次主动停/重启都写一行"来源 + 当时有没有任务在跑", 这类问题再也不用猜。
 */
async function noteStop(kind, why) {
  const rec = kind ? BACKEND_PROCS.get(kind) : null
  let busy = null
  if (kind) { try { busy = await comfyQueueBusy(kind) } catch { busy = null } }
  const suffix = busy === true ? '（当时有任务在跑！）' : busy === false ? '（当时没有任务在跑）' : ''
  const line = `\n===== 主动关闭：${why}${suffix} =====\n`
  try { if (rec?.stream) rec.stream.write(line) } catch { /* ignore */ }
  log(`[backend] 主动关闭 ${kind || '(全部)'}：${why}${busy === true ? ' · 有任务在跑' : ''}`)
}

/**
 * 回收**某一路端口上**的残留进程。
 *
 * ★ 2026-10-10 抽出来（用户反馈："关闭软件后还是会有残留进程，彻底检查一下"）：
 *   这段原来**只写在"停单路"分支里**（`if (onlyKind && BACKENDS[onlyKind])`），
 *   于是**退出程序走的全停路径根本没有端口兜底** —— 手工启动的后端、上一次程序留下的
 *   孙子进程，退出时一个都不会被清掉，这就是"关软件后还有残留"的主因。
 *
 * 安全约定（**不许改**）：只结束**可执行文件就在模型包目录里**的进程（portHolderIsOurs）——
 *   用户自己另开的 ComfyUI / 别的同类程序一律不碰，只记一条日志并**如实回报**为未清干净。
 *   判据从"进程名像 python"升级成"exe 路径在我们 backendsRoot 下"（后者才既准又安全）。
 */
async function reclaimPort(kind, { rounds = 6, deadline = 0, stopped = [], leftovers = [] } = {}) {
  const b = BACKENDS[kind]
  if (!b) return
  for (let i = 0; i < rounds; i++) {
    if (!(await portBusy(b.port))) return
    const holder = portHolder(b.port)
    if (!holder) return
    if (!portHolderIsOurs(holder)) {
      log(`[backend] ${b.label} 端口 ${b.port} 仍被 ${holder.name}(pid ${holder.pid}) 占着 —— `
        + '不是本程序拉起的进程, 没有动它')
      leftovers.push(`${kind}#${holder.pid}(${holder.name})`)
      return
    }
    killTree(Number(holder.pid), true)
    stopped.push(`${kind}#${holder.pid}(port)`)
    log(`[backend] ${b.label}: 端口 ${b.port} 上还有没退干净的进程(pid ${holder.pid}), 已结束`)
    await new Promise((s) => setTimeout(s, 600))
    if (deadline && Date.now() > deadline) return
  }
}

async function shutdownBackends(onlyKind = '') {
  const t0 = Date.now()
  // onlyKind 非空 = 只停这一路 (设置面板每张卡片上的「停止」按钮)。
  // 不传 = 全停 (退出程序时用)。
  const live = [...BACKEND_PROCS.values()].filter((r) => !r.exited && (!onlyKind || r.kind === onlyKind))
  const stopped = []
  const leftovers = []
  if (onlyKind) BACKEND_STOPPED_AT.set(onlyKind, Date.now())
  for (const r of live) {
    r.stopping = true   // 标记: 主动关闭, 不要被当成崩溃
    try { r.child.kill() } catch { /* ignore */ }
    killTree(r.pid, false)
  }
  if (live.length) await new Promise((s) => setTimeout(s, 1500))
  for (const r of live) {
    if (!r.exited) killTree(r.pid, true)
    stopped.push(`${r.kind}#${r.pid}`)
  }
  /**
   * 兜底: 停完再核一遍端口 —— 必须确认**端口真的空出来了**。
   *
   * ① 端口上有东西、但没有托管记录: 常见于"后端是手工启动的 / 上个程序进程留下的"。
   * ② 有托管记录、进程树也结束了, 但端口**还挂着**: 多半是"启动中被强制下掉"留下的孙子进程。
   *
   * ★ 2026-10-10: **全停（退出程序）也做**，不再只做单路（原因见 reclaimPort 的注释）。
   *   ⚠️ 时间预算：Electron 的 before-quit 只等 6 秒就 `app.exit(0)`，所以这里必须留余量 ——
   *   单路给 5s、全停给 4.5s，超预算就带着 leftovers 如实返回，由下次启动自愈接手。
   */
  const kinds = onlyKind ? [onlyKind] : Object.keys(BACKENDS)
  const deadline = t0 + (onlyKind ? 5000 : 4500)
  for (const k of kinds) {
    if (Date.now() > deadline) break
    await reclaimPort(k, { rounds: onlyKind ? 6 : 3, deadline, stopped, leftovers })
  }
  /** 端口真的都空了吗（最后再核一次，作为"清干净"的判据） */
  /**
   * 日志窗口（独立控制台）是 **detached** 的、不会跟着我们退出 —— 单独收掉（2026-10-10）。
   * 它是"关软件后还有残留进程"的另一半来源：窗口里的 `Get-Content -Wait` 会一直挂着。
   */
  for (const s of closeLogWindows(onlyKind)) stopped.push(s)
  let clean = leftovers.length === 0
  if (clean) {
    for (const k of kinds) {
      const b = BACKENDS[k]
      if (b && (await portBusy(b.port))) { clean = false; break }
    }
  }
  /**
   * 运行状态文件只在"全停 **且确实清干净**"时才删。
   *
   * ★ 2026-10-10 修（关键）: 以前是**无条件删** —— 只要有一个进程没清掉（或那个进程压根不在
   *   我们的记录里），下次启动的自愈 `cleanupStaleBackends()` 就**失去线索**（它依赖这个文件），
   *   残留会一直留着。现在没清干净就**保留**文件，让下次启动接着收拾。
   * 停单路时仍然保留（否则下次启动会以为所有后端都没跑过）。
   */
  if (!onlyKind && clean) {
    try { if (fs.existsSync(RUN_STATE())) fs.unlinkSync(RUN_STATE()) } catch { /* ignore */ }
  }
  if (!clean) {
    log(`[backends] 没清干净（保留 run-state 供下次启动自愈）: ${leftovers.join(', ') || '端口仍被占用'}`)
  }
  return { ok: true, stopped, clean, leftovers }
}

// ---------------------------------------------------------------- 冷启动探测 / 全程监测
// 判定逻辑全部在 tools/backendwatch.mjs 里(可被单元测试覆盖), 这里只是"带上本机路径"的薄包装。
// 为什么抽出去: 上次把判定内联在 2000 行的 server.mjs 里, 只能"跑一遍看看",
// 于是三个后端一个都没起来、界面空转 8 分钟都没被发现。
const COLD_CACHE = new Map()
const COLD_TTL_MS = 30000

function backendRootOf(kind) {
  if (kind === 'h3') return P.h3Root
  if (kind === 'kear') return P.kearRoot
  if (kind === 'indextts') return P.indexttsRoot
  return null
}

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ''
}

/** 冷启动判定(30 秒缓存: 启动瞬间反复查目录没意义, 而且痕迹很快就变了) */
function coldStartOf(kind) {
  const hit = COLD_CACHE.get(kind)
  if (hit && Date.now() - hit.at < COLD_TTL_MS) return hit.val
  const val = coldStart(kind, backendRootOf(kind), homeDir())
  COLD_CACHE.set(kind, { at: Date.now(), val })
  return val
}

/**
 * 与上面 (1087 行) 的 `sleep` 是同一个东西 —— 以前 server.mjs 里有两份一模一样的定义
 * (代码评估报告 P1 里点名的"重复 sleep"), 这里直接复用, 免得以后只改一处。
 */
const sleepMs = sleep

async function comfyQueueBusy(kind) {
  const b = BACKENDS[kind]
  if (!b || kind === 'indextts') return false
  try {
    const r = await fetch(`http://127.0.0.1:${b.port}/queue`, { signal: AbortSignal.timeout(4000) })
    if (!r.ok) return false
    const q = await r.json()
    return (q.queue_running ?? []).length > 0 || (q.queue_pending ?? []).length > 0
  } catch { return false }
}

/**
 * 某一路"现在有没有活在跑" —— 独占在线守门用 (2026-09-20)。
 *
 * ComfyUI 两路(H3/Krea2)看 /queue; 语音那一路(IndexTTS)不是 ComfyUI, 只能看它自己的 /status:
 *   loading=true(正在加载模型) 视为忙; 端口不通/查不到 → 按"不忙"处理(宁可放行也不误拦,
 *   真正在跑的任务会被下面"停进程"这一步暴露出来, 而且语音任务很短)。
 */
async function otherBackendBusy(kind) {
  if (kind === 'indextts') {
    /** 进程内租约优先：推理中即使 /status 一时答不上来，也绝不能被当成空闲。 */
    if (indexttsBusy > 0) return true
    try {
      const r = await fetch(`http://127.0.0.1:${BACKENDS.indextts.port}/status`, { signal: AbortSignal.timeout(3000) })
      if (!r.ok) return false
      const s = await r.json()
      return s?.loading === true || s?.busy === true
    } catch { return false }
  }
  return comfyQueueBusy(kind)
}

/**
 * 语音推理开始前，确保别的重模型已经让位（2026-10-28 docx）。
 * 现场：Qwen 正在出图时 IndexTTS 开始推理，H3 又在 00:49 启动；
 * 8GB 卡上三套权重抢显存，第一次 s2mel 918s，第二次才 2s/步。
 * 这里在第一条 TTS 请求前：别的模型忙 → 409 让用户等/停；空闲 → 停掉进程再跑。
 */
async function ensureIndexttsExclusive() {
  for (const other of ['h3', 'kear', 'qwen']) {
    const rec = BACKEND_PROCS.get(other)
    if (!rec || rec.exited) continue
    if (await otherBackendBusy(other)) return { ok: false, other }
    try {
      await shutdownBackends(other)
      log(`[tts] 独占：已停止 ${BACKENDS[other].label}，把显存让给语音`)
    } catch { /* 停不掉也继续，至少尝试过 */ }
  }
  return { ok: true }
}

/**
 * 这一路是不是"**正在启动/加载、还没接过活**"? (2026-10-06)
 *
 * 用户反馈的现象: 反复点不同模型的「启动」→ 正在启动的那一路被「独占在线」当成"别路在线"
 *   直接停掉 → 一个刚 spawn 出来、还没把端口绑稳的进程被强杀, 很容易留下一截残留
 *   (没退干净的进程 / 半开的监听), 之后这一路就一直起不来, 表现为"视频一直生成不出来"。
 *
 * 判据只认"它还没开始接活":
 *   · 端口还没在听 (还在 import / 加载依赖) → 启动中;
 *   · 端口在听, 但日志还停在 booting / loading 相位 → 启动中
 *     (ComfyUI 会先绑端口再加载权重; IndexTTS 更是"先监听端口、再后台加载模型");
 *   · 日志已经安静超过该相位的上限(像卡死) → **不算**启动中, 交给"切换时清理"那条路,
 *     否则一个真卡死的后端会把用户锁死在这里。
 *
 * 一旦端口答话且不在加载相位, 就不算启动中 —— 独占在线的老规则照旧(可以被切换、可以被停)。
 */
async function startingBackend(kind) {
  const rec = BACKEND_PROCS.get(kind)
  if (!rec || rec.exited) return null
  const now = Date.now()
  const cold = coldStartOf(kind).cold
  const phase = recPhase(rec, now, cold)
  const portUp = BACKENDS[kind]?.port ? await portBusy(BACKENDS[kind].port) : false
  if (portUp && phase !== 'booting' && phase !== 'loading') return null
  const silentSec = Math.round((now - (rec.lastOutputAt || rec.startedAt)) / 1000)
  if (silentSec > silentLimitSec(cold) + 15) return null   // 安静太久 = 像卡死, 不要把人锁死
  return { pid: rec.pid, phase, portUp, silentSec, ageMs: now - rec.startedAt }
}



/**
 * 释放某个后端的显存/内存, 并**核验**是否真的回落。
 *
 * 为什么必须核验: ComfyUI 的 POST /free 只是 set_flag 后立刻返回 200, 真正的卸载由它自己的
 * worker 在处理完一个任务之后才执行(ComfyUI/main.py:400)。所以"HTTP 200"完全不能代表
 * "已释放" —— 之前的日志就是这么谎报的(用户反馈里的第 3 条)。
 *
 * level:
 *   'cache'  → 只释放 torch 缓存(free_memory), 安全、瞬时, 随时可做
 *   'models' → 连模型一起卸载(unload_models), 真正把内存/显存让出来, 但下次生成要重新加载
 *
 * 核验手段: `nvidia-smi --query-compute-apps` 查该后端进程的显存占用, 轮询到回落为止。
 * (IndexTTS 的 /free 是同步的, 返回即已释放, 不需要轮询。)
 */
/**
 * 只"发一次卸载请求"(不等核验) —— 给启动路径的"按需腾资源"用。
 *
 * 背景(2026-09-17): 启动一个重后端前要先把另一路让位。freeBackendNow 自带最多 30 秒的
 *   核验轮询(给手动按钮用, 那里必须知道"到底卸掉没有"), 放在启动路径上会把每次切换拖成 30 秒。
 *   这里只负责把 HTTP 请求递过去 + 立刻返回; "到底卸掉没有"由调用方用全卡显存短轮询判断。
 */
async function requestFreeModels(kind) {
  const b = BACKENDS[kind]
  if (!b) return false
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 8000)
    const r = await fetch(`http://127.0.0.1:${b.port}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // ⚠️ 必须带 body: ComfyUI 端是 `await request.json()`, 空 body 会直接抛异常(实测踩过)
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: ctl.signal,
    })
    clearTimeout(t)
    return r.ok
  } catch { return false }
}

/**
 * 往某一路后端发一个 JSON POST(或空 POST), 成功返回 true。
 * 统一带上超时: 后端在忙的时候 fetch 会一直挂着 —— 那正是"点一下就没反应"的来源。
 */
async function postToBackend(kind, pathName, body = null, timeoutMs = 5000) {
  const b = BACKENDS[kind]
  if (!b) return false
  try {
    const r = await fetch(`http://127.0.0.1:${b.port}${pathName}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    return r.ok
  } catch { return false }
}

/**
 * "把这一路后端的活停下": 清掉排队 + 请求中断当前任务, 1.2 秒后复查是否真的停了。
 *
 * ⚠️ 实测结论(2026-09-19, 本机 RTX 3080 + H3):
 *   ComfyUI 的 `POST /interrupt` 对 **H3 的自定义采样器无效** ——
 *   `custom_nodes/ComfyUI-MiniMax-H3-Turbo/__init__.py` 的采样循环里**没有任何中断检查**
 *   (全文 0 处 interrupt / throw_exception_if_processing_interrupted), 所以那条"全局中断"
 *   只会打一行日志, 采样照跑到完。表现就是用户反馈的:
 *   "视频中途停掉 → 显存一直不还 → 手动释放也没反应 → 只能重启模型"。
 *   `POST /queue {clear:true}` 倒是立刻生效 —— 排队的后续任务能马上清掉(这条必须做,
 *   否则取消之后排队的任务会一个接一个接着跑)。
 *   所以这里如实返回 stillRunning, 由调用方决定要不要升级成"停进程"(停进程 2 秒内就把
 *   19.9GB 还给系统, 代价是下次生成要重新加载模型)。
 * 生图那一路(Krea2)用的是 ComfyUI 原生 KSampler, /interrupt 是有效的。
 */
async function interruptBackend(kind, { waitMs = 1500 } = {}) {
  if (!BACKENDS[kind]) return { ok: false, kind, reason: 'unknown-kind' }
  const out = { ok: true, kind, cleared: false, interrupted: false, stillRunning: false, waitedMs: 0 }
  if (kind === 'indextts') {
    // IndexTTS 的 /free 是同步的、任务也短, 没有中断接口 —— 不假装有
    out.note = '语音后端没有中断接口（任务本身很短）'
    return out
  }
  out.cleared = await postToBackend(kind, '/queue', { clear: true })
  out.interrupted = await postToBackend(kind, '/interrupt')
  /**
   * 等它真的停下来再下结论 —— 但等多久要分场景:
   *   · 手动点「释放显存」: 只等 1.5 秒。停不下来就赶紧回报 blocked, 让用户立刻看到
   *     "停止并释放"这条路 —— 他要的是马上拿回显存, 不是等我们复查。
   *   · 点「取消生成」: 给到 8 秒。实测(2026-09-19)中断是**每个算子检查一次**
   *     (comfy/ops.py:34 run_every_op), 小任务 1~2 秒就停; 但超大任务里单个算子本身
   *     就要跑几分钟(用户那条 1920×1088×362 帧, 第 0 步就卡了 3 分 22 秒),
   *     中断要等当前算子做完才生效。所以"取消"不能只等 1.2 秒就说"停不下来",
   *     也不能无限等 —— 8 秒还没停就如实告诉用户, 并给出立即可行的「停止」。
   */
  const budget = Math.max(0, Number(waitMs) || 0)
  let waited = 0
  let still = true
  for (;;) {
    const step = waited === 0 ? Math.min(1200, budget) : Math.min(2500, Math.max(0, budget - waited))
    if (step > 0) await sleepMs(step)
    waited += step
    still = await comfyQueueBusy(kind)
    if (!still || waited >= budget) break
  }
  out.waitedMs = waited
  out.stillRunning = still
  log(`[interrupt] ${BACKENDS[kind].label} 清排队=${out.cleared ? 'ok' : '失败'} 中断=${out.interrupted ? '已发送' : '失败'} 等待=${(waited / 1000).toFixed(1)}s → ${out.stillRunning ? '任务仍在跑(大任务的单个算子要跑很久)' : '已停止'}`)
  return out
}

async function freeBackendNow(kind, level = 'models') {
  const b = BACKENDS[kind]
  if (!b) return { ok: false, kind, reason: 'unknown-kind' }
  const rec = BACKEND_PROCS.get(kind)
  const pid = rec?.pid ?? null
  const isComfy = kind === 'h3' || kind === 'kear'
  // IndexTTS 只支持缓存级(它的 /free 没有 unload 参数, 只 empty_cache + gc)
  const effLevel = isComfy ? level : 'cache'

  // ⚠️ 从这里往下到轮询结束, 一律用**异步** nvidia-smi:
  //    生成中显卡满载时同步调用会把事件循环卡住 1~3 秒/次, 轮询 30 秒 = 界面像死机。
  const before = pid !== null ? ((await perProcessVramAsync())[pid] ?? null) : null
  // 全局显存兜底: Windows(WDDM) 下"单进程显存"读不到(nvidia-smi 给 [N/A]),
  //   于是核验永远看不到回落, 界面只会说"未观测到回落" —— 明明释放成功也这么说。
  //   拿全卡已用量的变化作旁证: 释放 15GB 这种量级, 别的程序的小波动盖不住。
  const gpuBefore = (await gpuMemoryNowAsync())?.usedMB ?? null
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 8000)
    const r = await fetch(`http://127.0.0.1:${b.port}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // ⚠️ 必须带 body: ComfyUI 端是 `await request.json()`, 空 body 会直接抛异常(用户反馈第 4 条)
      body: JSON.stringify({ unload_models: effLevel === 'models', free_memory: true }),
      signal: ctl.signal,
    })
    clearTimeout(t)
    if (!r.ok) return { ok: false, kind, level: effLevel, reason: `HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, kind, level: effLevel, reason: 'unreachable', detail: String(e?.message ?? e) }
  }

  // 同步后端: 返回即已释放
  if (!isComfy) {
    const afterSync = pid !== null ? ((await perProcessVramAsync())[pid] ?? null) : null
    return { ok: true, kind, level: effLevel, released: true, sync: true, vramBefore: before, vramAfter: afterSync }
  }

  /**
   * 异步后端(ComfyUI): 轮询核验。
   *
   * ⚠️ 2026-09-19 实测两处修正(用户反馈"点了释放很久没反应"):
   *   ① **无事可释放时不要傻等**: 以前不看情况一律轮询满 30 秒。实测本机(WDDM)单进程显存
   *      读数是 [N/A] → perProcessVram() 里根本没有这个 pid → before=null, 代码仍会轮询满
   *      30 秒才回。用户点一下"释放显存"，明明马上就没事了, 却要转 30 秒。
   *      现在: 全卡已用本来就不到 3GB(不可能装着十几 GB 的模型) → 立刻判定"无需释放"返回。
   *   ② 轮询上限 30 → 15 秒, 间隔 2s → 1.5s: 真正的卸载实测 2~3 秒内就能看到回落
   *      (H3 卸载 15GB 那次 2.4 秒就测到了), 30 秒是多余的兜底。
   */
  if (gpuBefore !== null && gpuBefore < 3000) {
    return {
      ok: true, kind, level: effLevel, released: true, nothingToFree: true, waitedMs: 0,
      vramBefore: before, vramAfter: before, gpuBefore, gpuAfter: gpuBefore, measuredBy: 'global',
      note: '该后端当前没有已加载的模型占用显存（全卡已用不足 3GB）',
    }
  }
  const deadline = Date.now() + 15000
  let after = before
  let gpuAfter = gpuBefore
  let waited = 0
  let byGlobal = false
  while (Date.now() < deadline) {
    await sleepMs(1500)
    waited += 1500
    after = pid !== null ? ((await perProcessVramAsync())[pid] ?? null) : null
    gpuAfter = (await gpuMemoryNowAsync())?.usedMB ?? gpuAfter
    if (before !== null && after !== null) {
      if (after < Math.max(256, before * 0.7)) break
      continue
    }
    // 单进程读数不可用 → 看全卡是否掉了可观的一截(≥2GB)
    if (gpuBefore !== null && gpuAfter !== null && gpuBefore - gpuAfter >= 2048) { byGlobal = true; break }
  }
  // before === null 表示这个进程当前没有任何显存占用记录 → 本来就没有模型在显卡里,
  // 这属于"无需释放", 而不是"释放失败"(否则第一次生成前调用会永远报失败)。
  // after === null 表示释放后该进程已完全不在显存占用列表里 → 一定释放成功。
  const nothingToFree = before === null
  const globalDropped = gpuBefore !== null && gpuAfter !== null && gpuBefore - gpuAfter >= 2048
  const released = nothingToFree || after === null || after < Math.max(256, before * 0.7) || globalDropped
  /**
   * ⚠️ 本机(WDDM)读不到"单进程显存"(nvidia-smi 给 [N/A]), 于是 before 永远是 null。
   *   这种情况下不能说"没有已加载的模型"(那是假话, 用户明明刚生成完), 只能说
   *   "读不到单进程读数, 已按全卡变化判断"。文案要说实话。
   */
  const perProcUnavailable = before === null && gpuBefore !== null && gpuBefore >= 3000
  return {
    ok: true, kind, level: effLevel, released, nothingToFree, waitedMs: waited,
    vramBefore: before, vramAfter: after,
    droppedMiB: (before !== null && after !== null) ? before - after : null,
    gpuBefore, gpuAfter,
    verified: !perProcUnavailable,
    /** 这次"释放成功"是按哪个口径判断的 (per-process 读不到时用全卡) */
    measuredBy: byGlobal || (nothingToFree && globalDropped) ? 'global' : (before !== null ? 'per-process' : 'none'),
    note: released
      ? (perProcUnavailable
        ? `本机读不到单进程显存占用，已按全卡已用判断（${gpuBefore ?? '?'} → ${gpuAfter ?? '?'} MiB）`
        : (nothingToFree ? '该后端当前没有已加载的模型占用显存' : ''))
      : '未观测到显存回落 —— ComfyUI 的卸载由它的 worker 在「处理完一个任务」后才执行, 队列空闲时标记会一直挂着',
  }
}

/** 给前端/诊断包用的运行时快照 */
/**
 * 给"监控轮询"用的显存快照。
 *
 * 2026-10-06: `gpuMemoryNow()` 自己已经是**读缓存**了(真正的 nvidia-smi 在 readGpuMemAsync,
 *   由后台异步采样填充), 这里不再需要第二层缓存 —— 保留这个函数只是让既有调用点不必改。
 * 历史教训: 它以前内部是 execFileSync(nvidia-smi)。前端每 2 秒轮一次, 服务端就等于每秒
 *   "卡住自己"一次(2026-09-14 实测: 切页、点按钮发涩); 那次只是发涩, 2026-10-06 是把
 *   整个窗口一起卡死。同步外部命令**不许**再回到这条路上。
 */
function gpuMemoryCached() {
  return gpuMemoryNow()
}

function backendRuntime() {
  const out = {}
  for (const kind of Object.keys(BACKENDS)) {
    const rec = BACKEND_PROCS.get(kind)
    const cold = coldStartOf(kind)
    if (!rec) { out[kind] = { managed: false, running: false, cold }; continue }
    const now = Date.now()
    const silentSec = Math.round((now - (rec.lastOutputAt || rec.startedAt)) / 1000)
    const phase = recPhase(rec, now, cold.cold)
    out[kind] = {
      managed: true,
      running: !rec.exited,
      pid: rec.pid,
      startedAt: rec.startedAt,
      elapsedMs: now - rec.startedAt,
      exitCode: rec.exitCode,
      signal: rec.signal,
      logFile: path.basename(rec.logPath),
      sawFirstOutput: rec.sawFirstOutput,
      firstOutputAt: rec.firstOutputAt,
      sawVram: rec.sawVram,
      sawReadyHint: rec.sawReadyHint,
      // 全程监测字段
      phase,
      phaseText: PHASE_TEXT[phase] || '',
      silentSec,
      silentLimitSec: silentLimitSec(cold.cold),
      lastOutputAt: rec.lastOutputAt,
      lineCount: rec.lineCount,
      lastLine: rec.tail.length ? String(rec.tail[rec.tail.length - 1]).slice(0, 300) : '',
      alerts: rec.alerts.slice(-12),
      cold,
      // 冷启动要留足时间(实测真实的首次可达 12 分钟), 热启动 5 分钟足够
      timeoutHintSec: timeoutHintSec(cold.cold),
      tail: rec.tail.slice(-60),
    }
  }
  return out
}

/**
 * "进程还在、端口却不响应"的判定 —— 这是"掉线后很久连不上"的真实成因:
 *   后端卡死时进程没退, 端口还在 LISTENING, 但 HTTP 不答。
 *   此时点「启动」只会得到"已在运行"(死胡同), 必须给用户一条明确的"重启"出路。
 * 只在托管进程活着时检查; 探测用快超时(2s) —— 这里要的是"这个端口此刻答不答"。
 *
 * ⚠️ 2026-09-17 重写 (用户实测: 一键渲染时弹"Krea2 生图 的进程还在, 但 8189 端口没有响应
 *    （通常是卡死）现在强制重启它吗?", 而实际只是"刚起/正在加载/正在生成"—— 点下去反而会把
 *    正在跑的活杀掉)。旧实现**单次 2 秒探测失败就判卡死**, 在慢机器上几乎必踩:
 *    · 模型加载/采样时后端可能几十秒不答 HTTP(尤其 16GB 机器在换页), 2 秒探测必然超时;
 *    · 进程刚起来还没就绪时, 端口本来就不答。
 * 现在要求四个条件**同时**成立才算卡死:
 *   ① 连续 ≥3 次探测都失败, 且跨度 ≥15 秒 (一次抖动不算);
 *   ② 这一路**以前确实就绪过** (sawReadyHint / sawFirstOutput) —— 从没就绪过就是"还在启动";
 *   ③ 日志已经安静超过该阶段的上限 (silentLimitSec) —— 加载/采样时日志一直在动, 那种不算;
 *   ④ 不处于 spawning/booting/loading/ready-hint 这些"正在启动"相位。
 * 不满足就返回 null, 让调用方走"等待就绪"那条路 (前端会显示"已等待 N 秒…"), 而不是吓人一跳。
 */
const stuckProbeStreak = new Map()

async function stuckBackend(kind) {
  const live = BACKEND_PROCS.get(kind)
  if (!live || live.exited) { stuckProbeStreak.delete(kind); return null }
  const probe = await probeBackend(kind).catch(() => null)
  if (probe?.online) { stuckProbeStreak.delete(kind); return null }
  const now = Date.now()
  const cold = coldStartOf(kind)
  const phase = recPhase(live, now, cold.cold)
  const silentSec = Math.round((now - (live.lastOutputAt || live.startedAt)) / 1000)
  const quietLongEnough = silentSec > silentLimitSec(cold.cold)
  const stillStarting = !live.sawReadyHint && !live.sawFirstOutput
  const startingPhase = phase === 'spawning' || phase === 'booting' || phase === 'loading'
    || phase === 'ready-hint' || phase === 'ready-hint-quiet'

  const streak = stuckProbeStreak.get(kind) ?? { n: 0, firstAt: now }
  streak.n += 1
  stuckProbeStreak.set(kind, streak)
  const spanSec = Math.round((now - streak.firstAt) / 1000)

  if (stillStarting || startingPhase || !quietLongEnough || streak.n < 3 || spanSec < 15) {
    // 还没到"真卡死"的判据 → 交给"等待就绪"(前端会显示已等待多久)
    log(`[ensure] ${BACKENDS[kind].label} 端口暂时不答(${probe?.detail || probe?.error || 'timeout'}), `
      + `但进程还在启动/加载中(相位 ${phase}, 日志安静 ${silentSec}s, 连失 ${streak.n} 次/${spanSec}s) → 继续等, 不判卡死`)
    return null
  }
  const b = BACKENDS[kind]
  return {
    msg: `${b.label} 的进程还在，但 ${b.port} 端口连续 ${streak.n} 次没响应（约 ${spanSec} 秒）`,
    detail: `日志也已经 ${silentSec} 秒没有新输出 —— 多半是真卡死了。`
      + '点「强制重启」会结束它再重新拉起（当前正在跑的任务会丢失）；'
      + '如果你刚点生成、还在加载模型，先点「取消」再等一会儿。',
  }
}

/**
 * Windows 保留（排除）的 TCP 端口段 —— 落在里面的端口**任何程序都绑不上**
 * （实测报 `winerror 10013`，而不是"被别的进程占用"的 10048）。
 *
 * 为什么要它: 2026-10-12 真机复现到 "四个后端端口全在 8179-8278 保留段里" 的现场，
 *   界面上只会说"启动后退出/端口被占"，用户按"清残留"折腾半天也没用。
 * 取数: `netsh int ipv4 show excludedportrange protocol=tcp`（**不需要管理员**），缓存 5 分钟
 *   （保留段是系统级、不会秒变）；非 Windows 或读不到 → 返回空数组（绝不因此拦住启动）。
 */
let reservedRangesCache = { at: 0, list: [] }
function reservedTcpRanges() {
  if (Date.now() - reservedRangesCache.at < 5 * 60 * 1000) return reservedRangesCache.list
  let list = []
  try {
    if (process.platform === 'win32') {
      /** ⚠️ 走 execCapture(输出重定向到文件, 不用管道) —— 见它的说明: netsh 这类系统命令在管道上卡过 */
      const out = execCapture('netsh', ['int', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'], { timeout: 6000 })
      list = parseExcludedPortRanges(out)
    }
  } catch { list = [] }
  reservedRangesCache = { at: Date.now(), list }
  return list
}

/** 这个端口是不是落在保留段里(是 → 返回那一段, 否则 null) */
function portInReservedRange(port) {
  return rangeForPort(reservedTcpRanges(), port)
}

/**
 * 本次启动里"哪几路被自动搬过端口" —— 键 = kind, 值 = { from, to, range }。
 * 由 /api/backends/state 带出去: 前端据此把端口号显示对, 并弹**一次**说明。
 */
let BACKEND_PORT_RELOCATION = {}

/**
 * ★★ 2026-10-12 真机: 用户四张截图 —— H3 / Krea2 / IndexTTS / Qwen **四路全部启动失败**,
 *   每张都是「端口 8188 / 8189 / 8190 / 8191 被 Windows 保留着」。
 *
 * 真因: Windows 把 8179-8278 这段保留给了系统组件(Hyper-V / WSL / WinNAT) ⇒ 这四个端口
 *   **任何程序都绑不上**(后端原话 `winerror 10013 访问权限不允许`)。
 *
 * 上一版是"如实告诉用户 + 给三条管理员命令 / 建议重启电脑"。诊断没错, 但**出路不对**:
 *   · 客户机上多半没有管理员权限, 也不该为了用一个软件去改系统网络设置;
 *   · "重启一次电脑"本来就不保证 —— 保留段是系统动态划的, 重启后可能还在、也可能换一段;
 *   · 结果就是"软件装好了、一个模型都起不来", 等于不可用。
 *
 * 现在: 起进程**之前**先探一次, **默认端口被系统保留就自动搬到一个能用的端口**,
 *   并把这次选择记进 `data\settings.json` 的 `backendPorts`(下次启动沿用, 端口不乱跳)。
 *   前端一律走 `/comfy`、`/kear` 这类反代路径(不认端口), 显示用的端口号从
 *   `/api/backends/state` 取 —— 所以搬完之后**用户什么都不用做**。
 *
 * ⚠️ **只在"系统保留"这一种情况下搬**。端口被**别的程序**占着时**不搬**:
 *   那是"用户自己另起了一套 ComfyUI", 搬过去会变成两套权重同时驻留、显存翻倍;
 *   那种情况仍旧按老规矩"拒绝启动 + 说实话"(见 launchBackend 里的端口身份核对)。
 */
async function applyBackendPortAutoRelocate() {
  BACKEND_PORT_RELOCATION = {}
  /** 测试口子显式指定过端口 → 一切照它来, 不做自动搬迁(否则探针没法稳定模拟) */
  if (process.env.AICS_TEST_PORTS) return
  const ranges = reservedTcpRanges()
  if (!ranges.length) return
  const saved = (P.settings?.backendPorts && typeof P.settings.backendPorts === 'object') ? P.settings.backendPorts : {}
  /** 已经定下来的端口(含应用自己的 5173) —— 后面的路不许再撞上来 */
  const taken = [Number(PORT) || 0].filter(Boolean)
  const nextSaved = { ...saved }
  const kinds = Object.keys(BACKENDS)
  let moved = false

  /** 从 start 起往上找第一个"不在保留段、没人在听、前面几路也没占"的端口 */
  const findPort = async (start) => {
    for (const p of relocatePortCandidates({ taken, ranges, start, tries: 200 })) {
      if (await portBusy(p)) continue
      return p
    }
    return 0
  }

  for (let i = 0; i < kinds.length; i += 1) {
    const kind = kinds[i]
    const b = BACKENDS[kind]
    /** ⚠️ 以**出厂默认**为准(见 DECLARED_PORTS): 同一个进程里第二次跑也要从 8188 这一族开始判断 */
    const wanted = DECLARED_PORTS[kind] ?? b.port
    b.defaultPort = wanted
    b.port = wanted
    const range = rangeForPort(ranges, wanted)
    if (!range) {
      taken.push(wanted)
      /**
       * 默认端口这次可用 → **回到默认**, 并抹掉上次那条搬迁记录。
       * 这样"用户自己按三条命令把保留段腾出来了 / 系统重新划分了"之后, 程序会自动回到 8188 这一族,
       * 不需要谁去清配置 —— 日志里也看得出这一步。
       */
      if (saved[kind]) { delete nextSaved[kind]; moved = true }
      continue
    }
    /** 上次搬去的那个端口这次还能用 → 沿用(免得每次启动端口都在跳) */
    let port = Number(saved[kind]) || 0
    const savedOk = port > 0 && !rangeForPort(ranges, port) && !taken.includes(port) && !(await portBusy(port))
    if (!savedOk) port = await findPort(RELOCATE_PORT_START + i)
    if (!port) {
      log(`[port] ${b.label}: 端口 ${wanted} 落在 Windows 保留段 ${range.start}-${range.end} 里, 而且没找到可用的替代端口`)
      continue
    }
    b.defaultPort = wanted
    b.port = port
    taken.push(port)
    BACKEND_PORT_RELOCATION[kind] = { from: wanted, to: port, range: { start: range.start, end: range.end } }
    if (Number(saved[kind]) !== port) { nextSaved[kind] = port; moved = true }
  }

  if (moved) {
    try {
      const { writeSettings } = await import('./tools/runtime.mjs')
      writeSettings(P.dataDir, { backendPorts: nextSaved })
      P.settings = { ...P.settings, backendPorts: nextSaved }
    } catch (e) {
      log(`[port] 记下搬迁后的端口失败(不影响这次使用): ${e && e.message ? e.message : e}`)
    }
  }
  for (const [kind, m] of Object.entries(BACKEND_PORT_RELOCATION)) {
    log(`[port] ${BACKENDS[kind].label} 的默认端口 ${m.from} 被 Windows 保留段 ${m.range.start}-${m.range.end} 盖住(任何程序都绑不上) → 本次自动改用 ${m.to}`)
  }
  if (Object.keys(BACKEND_PORT_RELOCATION).length) {
    log('[port] 已自动绕开被系统保留的端口, 用户不需要做任何事(想换回默认端口才需要管理员命令: net stop winnat → netsh int ipv4 add excludedportrange protocol=tcp startport=<端口> numberofports=1 → net start winnat)')
  }
}

/**
 * 拉起一个后端。
 *
 * 2026-09-17 起改成 async: 启动前"按需腾资源"要真的等对方把显存/内存让出来
 *   (以前是 `void shutdownBackends()` 发完就走 → 两路同时加载, 反而更容易撑爆)。
 *   调用点一共有 5 处(代理兜底/启动接口/ensure/重启/自动预热), 都已 await。
 */
/**
 * ⚠️ `opts = {}` 不能省（2026-10-17 实测）：下面会读 `opts.compatStack`，
 *   而 `/api/ensure`（点生成时自动把后端拉起来那条路）调用时**不带第二个参数** ⇒
 *   `TypeError: Cannot read properties of undefined (reading 'compatStack')` → 整个 ensure 回 500，
 *   表现就是"点生成没反应 / 后端起不来"。三个调用点（6422 / 7653 / 8221）都是单参调用。
 */
async function launchBackend(kind, opts = {}) {
  const b = BACKENDS[kind]
  if (!b) return { ok: false, msg: `未知后端: ${kind}` }
  /**
   * ★★ 2026-10-12 用户: "没开全量的情况下，还是要注意模型可能会出现端口占用，没有彻底杀掉的情况，
   *   这个是很严重的，请按照最高标准做这个事情"。
   *
   *   实测抓到一类**根本不是"残留"**的"端口占用"：Windows 把一段端口**保留给了系统组件**
   *   (Hyper-V / WSL / WinNAT；`netsh int ipv4 show excludedportrange protocol=tcp` 能看到)。
   *   真机现场: 保留段 8179–8278 正好盖住四个后端端口, python 起不来, 日志里是
   *     `PermissionError: [Errno 13] winerror 10013 ... bind on ('127.0.0.1', 8188)`
   *   —— 而界面上只会说"启动后退出/端口被占", 用户按"清残留"折腾半天也没用。
   *   这里**开进程之前**先查一次, 属这种情况就直说(不 spawn、不留半死不活的进程), 并给出两条真出路。
   */
  /**
   * ⚠️ 这是**安全网**, 正常路径下用不到: 启动时 applyBackendPortAutoRelocate 已经把
   *   "落在保留段里"的那几路搬走了。留着它是因为保留段是系统**动态**划的 —— 程序开着的时候
   *   也可能冒出一段新的把当前端口盖住(`netsh` 结果这里缓存 5 分钟, 所以下面要**重新查一次**)。
   *   真撞上就地再搬一次, 而不是把用户丢回"你去跑三条管理员命令"。
   */
  const reserved = rangeForPort(reservedTcpRanges(), b.port)
  if (reserved) {
    reservedRangesCache = { at: 0, list: [] }        // 让上面那次判断不作数, 下面重算
    const freshRange = portInReservedRange(b.port)
    if (freshRange) {
      const taken = [Number(PORT) || 0, ...Object.values(BACKENDS).map((x) => x.port)]
      const moved = await (async () => {
        for (const p of relocatePortCandidates({ taken, ranges: reservedTcpRanges(), start: RELOCATE_PORT_START })) {
          if (await portBusy(p)) continue
          return p
        }
        return 0
      })()
      if (moved) {
        log(`[launch] ${b.label}: 端口 ${b.port} 落在 Windows 保留段 ${freshRange.start}-${freshRange.end} 里 → 就地改用 ${moved}`)
        b.defaultPort = DECLARED_PORTS[kind] ?? b.port
        b.port = moved
        BACKEND_PORT_RELOCATION = { ...BACKEND_PORT_RELOCATION, [kind]: { from: b.defaultPort, to: moved, range: { start: freshRange.start, end: freshRange.end } } }
        portListenCache.clear()
        try {
          const { writeSettings } = await import('./tools/runtime.mjs')
          writeSettings(P.dataDir, { backendPorts: { ...(P.settings?.backendPorts ?? {}), [kind]: moved } })
        } catch { /* 记不住也就这一次, 不影响启动 */ }
      } else {
        /**
         * 连一个替代端口都找不到(理论上不该发生 —— 65535 个里挑 200 个都被占/被保留)。
         * 这时才回到"如实告诉用户"这条老路, 并且把**两条出路**写清楚、能读:
         *   ⚠️ 文案里**不要出现 `**`** —— 那是 Markdown 的加粗记号, 到了 toast 里是**可见的星号**,
         *     用户看到的就是"这\*\*不是\*\*残留进程没杀干净"这种脏字(2026-10-12 用户截图里就是这个)。
         */
        log(`[launch] 拒绝: ${b.label} 端口 ${b.port} 落在 Windows 保留段 ${freshRange.start}-${freshRange.end} 里, 且无可用替代端口`)
        return {
          ok: false, portReserved: true, reserved: freshRange,
          msg: `${b.label} 起不来：端口 ${b.port} 被 Windows 保留着`,
          detail: `系统组件（Hyper-V / WSL / WinNAT）把 ${freshRange.start}-${freshRange.end} 这一段保留走了，`
            + `任何程序都绑不上（后端原话：winerror 10013 访问权限不允许）。这不是残留进程没杀干净，`
            + `也不是模型包的问题。\n`
            + `怎么办（二选一）：`
            + `① 一劳永逸：以【管理员】身份打开 PowerShell，依次执行这三条（执行期间网络会闪一下）——`
            + ` net stop winnat`
            + ` → netsh int ipv4 add excludedportrange protocol=tcp startport=${b.port} numberofports=1`
            + ` → net start winnat`
            + `② 或者重启一次电脑，让保留段重新分配（不保证下次还会空出来）。`,
        }
      }
    }
  }
  /**
   * ★★ 2026-10-12 「端口混淆 / 别人的程序占着这一路」—— **不 spawn、不谎报"已启动"**。
   *   真机模拟抓到的现场: 8188 上坐着别人的 ComfyUI, 旧逻辑照样 spawn 我们的 python(必绑不上),
   *   还回一句 `ok:true「已静默启动 H3 视频」` —— 用户以为起了, 一点生成就各种怪错。
   */
  {
    const idn = await backendIdentityOnPort(kind)
    /**
     * ★ 2026-10-25: 外部 H3 **绝不自动复用**。
     *   旧版 Manke 也带 H3 节点，能答我们的节点名并不能证明它扫描的是本次安装的模型目录。
     *   真正可复用的只有状态 trusted（当前 backendsRoot + 实例 ID/版本/契约全部匹配）。
     *   （其它三路仍保留原来的 ours-external 行为，本次隔离范围只针对会误报模型文件的 H3。）
     */
    if (idn.kind === 'external-h3') {
      const h = idn.holder
      const a = idn.identity ?? {}
      const actual = a.actual ?? {}
      return {
        ok: false, skipped: true, occupied: true, portOccupied: true, externalH3: true,
        occupiedBy: { pid: h.pid, name: h.name, kind: 'h3', exe: String(h.exe || '').slice(-160) },
        msg: `${b.label} 这次先不启动：${b.port} 端口上跑的是外部 H3`,
        detail: `检测到外部 H3（pid ${h.pid}），它的可执行文件不在本次安装的模型目录里，`
          + `所以本程序不会复用它，也不会结束它。\n`
          + `它报告的安装：实例 ${actual.instanceId ? String(actual.instanceId).slice(0, 12) + '…' : '未提供'}`
          + ` · 版本 ${actual.programVersion || '未知'} · 模型契约 ${actual.modelApiVersion || '未知'}\n`
          + `怎么办：关闭那个 H3（或把它改到别的端口），再从本程序启动；不要重装模型包。`,
      }
    }
    if (idn.kind === 'ours-unverified') {
      const h = idn.holder
      const a = idn.identity ?? {}
      const why = (a.mismatches ?? []).join('、') || '旧后端没有安装身份标记'
      const busy = await comfyQueueBusy(kind).catch(() => true)
      if (busy) {
        return {
          ok: false, conflict: true, blockedByIdentity: true, identityState: a.state,
          msg: `${b.label} 这个旧后端正在生成，暂不替换`,
          detail: `端口 ${b.port} 上的是本安装目录里的旧进程(pid ${h.pid})，但身份未通过：${why}。`
            + `它现在有任务在跑，程序不会打断。怎么办：等任务结束后点「重启」，再重新生成。`,
        }
      }
      log(`[launch] ${b.label}: 当前安装的旧后端身份未通过(${why}), 空闲中 → 自动替换`)
      try { killTree(Number(h.pid), true) } catch { /* ignore */ }
      for (let i = 0; i < 10 && await portBusy(b.port); i += 1) await new Promise((s) => setTimeout(s, 400))
      invalidateBackendIdentity(kind)
      if (await portBusy(b.port)) {
        return {
          ok: false, blockedByIdentity: true, identityState: a.state,
          msg: `${b.label} 的旧后端还没退干净`,
          detail: `旧进程(pid ${h.pid})身份未通过：${why}；端口 ${b.port} 仍被占着。请点一次「重启」再试。`,
        }
      }
      // 旧进程已经安全退出：继续走正常启动流程，新进程会带本次安装身份。
    }
    if (idn.kind === 'ours-external') {
      const h = idn.holder
      log(`[launch] ${b.label}: 端口 ${b.port} 上已有这一路在跑(pid ${h.pid}, 不是本程序拉起的), 直接用它`)
      return {
        ok: true, skipped: true, managed: false, already: true, external: true,
        pid: Number(h.pid),
        detail: `${b.label} 已经在运行（pid ${h.pid}，不是本次启动拉起的），直接用它`,
      }
    }
    if (idn.kind === 'foreign' || idn.kind === 'other-pack') {
      const h = idn.holder
      const who = `${h.name}(pid ${h.pid})`
      const otherLabel = idn.otherKind ? (BACKENDS[idn.otherKind]?.label ?? idn.otherKind) : ''
      log(`[launch] 拒绝: ${b.label} 端口 ${b.port} 被 ${who} 占着${idn.otherKind ? `(看着是 ${otherLabel})` : ''}${idn.silent ? '(它没答话)' : ''} —— 不是本程序拉起的, 不动它`)
      return {
        ok: false, skipped: true, occupied: true, blocking: idn.otherKind || '', portOccupied: true,
        occupiedBy: { pid: h.pid, name: h.name, kind: idn.otherKind || '', exe: String(h.exe || '').slice(-120) },
        msg: idn.kind === 'other-pack'
          ? `${b.label} 这次先不启动：${b.port} 端口上跑的是「${otherLabel}」`
          : `${b.label} 这次先不启动：${b.port} 端口被别的程序占着`,
        detail: idn.kind === 'other-pack'
          /**
           * ⚠️ 用户看得到的文案里**不许出现 `**`** —— 那是 Markdown 的加粗记号, 落到 toast / 卡片上
           *   就是**可见的星号**(2026-10-12 用户为这事贴过两次截图: "这**不是**残留进程没杀干净")。
           */
          ? `端口 ${b.port} 上那个进程是本程序另一路的后端（${otherLabel}），不是 ${b.label} —— 这就是"端口串台"。\n`
            + `怎么办：到顶栏「模型」把「${otherLabel}」停止（或点它的「重启」让它回到自己的端口），再启动这一路。`
          : `端口 ${b.port} 上坐着 ${who}${idn.silent ? '（它收下了连接但不回话，多半是卡住了）' : ''}，`
            + `它的可执行文件不在本程序的模型目录里 —— 那是别人的程序，本程序不会去动别人的进程`
            + `（所以也不会"帮你把它杀掉"）。\n`
            + `怎么办：① 到那个程序里把它关掉（或改掉它的端口），再点这一路的「启动」；`
            + `② 如果你就是想用那个程序，请从本程序的模型包里启动它，本程序会自动认出来。`,
      }
    }
  }
  /** ⚠️ 真启动优先: 这一路(以及任何一路)要起来了 → 立刻叫停后台的权重预热, 别跟加载抢磁盘 */
  cancelPrewarm()
  // 测试/排障开关: 只报告"已发起", 不真的拉起进程 (AICS_NO_AUTOLAUNCH=1)
  if (process.env.AICS_NO_AUTOLAUNCH === '1') {
    return { ok: true, skipped: true, detail: `${b.label} 已跳过启动 (AICS_NO_AUTOLAUNCH=1)` }
  }
  // ---- 分层安装 / 手动停用: 这两种情况都**不该**去 spawn ----
  //  以前无论装没装都往下走, 结果是"没装视频包"的机器在日志里反复出现 python 找不到,
  //  用户看到一片红。现在明确区分"未安装"与"已停用", 并且只回一句人话。
  const comp = componentOf(kind)
  if (comp && !comp.installed) {
    const t = comp.tier ? MODEL_TIERS.find((x) => x.key === comp.tier) : null
    const guide = BACKEND_GUIDE[kind] ?? {}
    return {
      // needsInstall 沿用既有语义: 前端据此把卡片显示成"未安装"并给出去哪放的引导,
      // 而不是当成"启动失败"反复重试 (分层安装下这是常态, 不是故障)。
      ok: false, skipped: true, notInstalled: true, needsInstall: true,
      msg: `${b.label} 未安装${t ? `（缺少${t.label}）` : ''}`,
      detail: `未在 ${P.backendsRoot} 找到运行环境。`
        + (t ? `该组件属于${t.label}（约 ${t.sizeHintGB}GB）。` : '')
        + (guide.hint ?? '')
        + (comp.missingMarkers?.length ? `缺的关键文件：${comp.missingMarkers.join('、')}。` : '')
        + LAYOUT_HINT,
    expectPath: guide.expect ? guide.expect(P) : '',
    backendsRoot: P.backendsRoot,
  }
  }
  if (P.settings?.backendsEnabled?.[kind] === false) {
    return {
      ok: false, skipped: true, disabled: true,
      msg: `${b.label} 已停用`,
      detail: '在设置里可以重新启用 (低配机器建议只保留需要的后端)',
    }
  }
  // 目标后端本来就在跑 → 幂等返回, 别做任何"腾资源"的多余动作
  {
    const mine = BACKEND_PROCS.get(kind)
    if (mine && !mine.exited) {
      return { ok: true, managed: true, already: true, pid: mine.pid, detail: `${b.label} 已在运行 (pid ${mine.pid})` }
    }
  }

  /**
   * ── 独占在线: 本机同一时刻**只允许一个模型在线** (2026-09-20 用户要求) ──
   *
   * 用户实测: "先启动了视频模型, 又在设置里点了图片模型 —— 视频模型依旧显示在线"。
   * 旧做法是"温和卸载(卸模型、留进程)": 显存是让出来了, 可进程还在、端口还在听 →
   *   状态灯照旧绿着, 用户根本判断不出谁在用机器; 而且只要它下一回合被唤醒加载模型,
   *   就是两套权重同时驻留换页(又慢又不稳的根源)。
   *
   * 现在的规则(与前端队列的调度一致, 见 app/src/services/queueRunner.ts 的 dispatchLocal):
   *   · 起这一路之前, 把**其它所有在线模型**都停掉(进程级) → 状态灯随即变红, 谁在跑一目了然;
   *   · 对方正在生成任务 → 默认**拒绝启动**, 并说明"等它跑完 / 先停掉它"两条路;
   *     用户在确认框里点过之后带 force=1 才会强停它(会中断它的任务)。
   *   · 端口在听但进程不归我们管(用户自己起的 ComfyUI) → 停不掉, 但可以请它把模型卸载掉,
   *     并且它正在跑任务时同样按"冲突"处理。
   *
   * 注: 这一步不再受「自动清理内存」开关影响 —— 那个开关管的是"空闲时要不要释放"，
   *   而"只有一个模型在线"是产品约定, 关掉开关也不该出现两个模型同时占显存。
   */
  /** externalNote: 独占口径下"别路端口被外部进程占着"这种**没法自动处理**的情况, 如实带进回执(见下面的硬闸门) */
  const guard = { freed: [], stopped: [], busySkipped: [], reason: '', externalNote: '' }
  /**
   * 本地文本模型(第 5 路)是**轻量、可 CPU** 的一路, 不参与"独占在线":
   *   · 它自己要起来时 → 不去停 H3/Krea2(它们占着卡, 它自己会按空闲显存回落到 CPU);
   *   · 别的重模型要起来时 → 不停它的进程, 只请它 **POST /unload** 把显存让出来(下次要用再按空闲显存上/不上 GPU)。
   * 这样"写提示词 → 开模型生成 → 再改提示词"这条日常来回都不会互相打断。
   */
  if (kind !== 'text') await freeTextVram()
  /**
   * ⚠️ 2026-10-11: 「模型全量常驻」开着时**整段跳过** —— 那正是用户要的"切换不用重启进程"。
   *   代价(多模型同占显存/内存)由用户在设置里知情选择, 这里只记一行日志。
   */
  if (kind !== 'text' && allModelsOnlineEnabled()) {
    const running = Object.keys(BACKENDS).filter((k) => {
      const rec = BACKEND_PROCS.get(k)
      return !!rec && !rec.exited
    })
    if (running.length) {
      log(`[launch] 模型全量常驻: 不停其它模型(当前在线 ${running.map((k) => BACKENDS[k].label).join('、')}), `
        + `直接起 ${b.label} —— 显存不够时后端会自己换页或起不来`)
    }
  } else if (kind !== 'text') {
    const prof = launchProfile()
    const vramGB = prof.vramGB
    const ramGB = prof.ramGB
    /** 允许"掀掉正在启动中的那一路"的只有两种来源: 用户在确认框点过(force=1) / 启动预热(preheat) */
    const mayDisplaceStarting = opts?.force === true || opts?.preheat === true
    for (const other of Object.keys(BACKENDS)) {
      if (other === kind) continue
      if (other === 'text') continue   // 文本模型上面已单独处理(只让显存, 不停进程)
      const rec = BACKEND_PROCS.get(other)
      const managedAlive = !!(rec && !rec.exited)
      // 托管进程活着, 或者端口上确实有人在听(用户自己起的后端) → 都算"在线"
      const online = managedAlive || await portBusy(BACKENDS[other].port)
      if (!online) continue
      /**
       * ⓪ (2026-10-06) 对方**正在启动/加载、还没接过活** → 默认不掀它(见 startingBackend)。
       *   以前这里只看"① 正在生成任务", 于是"用户连点不同模型的启动"会把正在启动的那一路
       *   直接 kill 掉 —— 刚拉起来、还没绑稳端口的进程被强杀很容易留下残留, 之后这一路就
       *   一直起不来 (用户反馈: 端口被占用 / 视频一直生成不出来)。
       *   现在如实拒绝, 并把"等它就绪 / 先停掉它"两条路写给用户; 用户在确认框点过才强停。
       */
      const starting = managedAlive ? await startingBackend(other) : null
      if (starting && !mayDisplaceStarting) {
        log(`[launch] 拒绝: ${BACKENDS[other].label} 正在启动中(${starting.phase} · 已 ${Math.round(starting.ageMs / 1000)}s), 不掀它`)
        return {
          ok: false, conflict: true, starting: true, blocking: other,
          msg: `${b.label} 这次先不启动：${BACKENDS[other].label} 正在启动中`,
          detail: `它还没就绪${starting.portUp ? '' : '（端口还没起来）'} —— 启动中的模型被强制结束, `
            + `容易留下没退干净的进程/端口, 之后这一路就一直起不来（就是"点了半天出不来片"那种）。`
            + `怎么办：① 等 ${BACKENDS[other].label} 就绪（顶栏那个环转完）再点这一路；`
            + `② 确实要马上用，就先在「模型」抽屉里把 ${BACKENDS[other].label}「停止」，再启动 ${b.label}。`,
          memory: { vramGB, ramGB },
        }
      }
      if (starting) {
        log(`[launch] ${opts?.preheat ? '预热' : 'force=1'}: 停掉正在启动中的 ${BACKENDS[other].label}`)
      }
      // ① 对方正在生成 → 不打扰它, 但也不许两个模型同时在线: 拒绝本次启动
      if (await otherBackendBusy(other)) {
        guard.busySkipped.push(BACKENDS[other].label)
        if (!opts?.force) {
          log(`[launch] 拒绝: ${BACKENDS[other].label} 正在生成任务(只允许一个模型在线)`)
          return {
            ok: false, conflict: true, blocking: other,
            msg: `${b.label} 这次先不启动：${BACKENDS[other].label} 正在生成任务，本机同一时刻只在线一个模型`,
            detail: `两套模型同时驻留会让显存与内存来回换页 —— 正在跑的那个任务会变得极慢，甚至看起来像卡死/丢任务。`
              + `怎么办：① 等 ${BACKENDS[other].label} 跑完（推荐，队列会自动接手下一个）；`
              + `② 确实要马上用，就在「配置与启动」把 ${BACKENDS[other].label}「停止」再启动 ${b.label}（会中断它当前的任务）。`,
            memory: { vramGB, ramGB },
          }
        }
        log(`[launch] force=1: 用户确认, 停掉正在生成任务的 ${BACKENDS[other].label}`)
      }
      // ② 停掉它(托管进程 → 停进程 + 等它退干净; 非托管 → 只能请它卸掉模型)
      if (managedAlive) {
        /**
         * ⚠️ 2026-10-01 补: 这里以前**不写原因就 kill** —— 被停那一路的日志里只剩一个
         *   `exited ... signal=SIGTERM`，用户看日志只会问"H3 为什么莫名挂掉"(连着两次真发生)。
         *   现在按既有约定先写一行 `===== 主动关闭：… =====` 到**对方**的日志里。
         */
        await noteStop(other, `独占在线：启动 ${b.label} 需要腾出显存/内存`)
        try { await shutdownBackends(other) } catch { /* 停不掉也要继续, 至少试过了 */ }
        guard.stopped.push(BACKENDS[other].label)
        /**
         * ★★ 2026-10-12 用户: "没开全量的情况下，还是要注意模型可能会出现端口占用，没有彻底杀掉的情况，
         *   这个是很严重的，请按照最高标准做这个事情"。
         *
         *   独占口径的全部意义就是"同一时刻只有一个模型在线"。可**停不干净**时继续往下起，
         *   就变成两套权重同时在卡上(换页/抢显存)，用户看到的是"越切越慢、甚至起不来"。
         *   所以这里加一道**硬闸门**: 停完之后**核端口** ——
         *     · 端口还挂着**本程序拉起的**残留(pid 还是我们的) → **拒绝启动**这一路, 并说清 pid 与怎么处理;
         *     · 端口被**别人的**进程占着(用户自己开的 ComfyUI) → 不动它(仓库既有规矩), 但必须**如实写进回执**,
         *       别让用户以为"独占已经生效了"。
         */
        if (await portBusy(BACKENDS[other].port)) {
          let holder = portHolder(BACKENDS[other].port)
          /**
           * 还能是"我们的"残留 → **再补一刀**(最高标准: 能自己收干净就别甩给用户)。
           *   shutdownBackends 里已经收过一轮(6 次/5 秒预算), 走到这里多半是进程树里还有更犟的孙子进程。
           */
          if (holder && portHolderIsOurs(holder)) {
            log(`[launch] ${BACKENDS[other].label} 端口 ${BACKENDS[other].port} 仍被本程序残留 pid ${holder.pid} 占着 —— 再收一次`)
            killTree(Number(holder.pid), true)
            for (let i = 0; i < 8 && await portBusy(BACKENDS[other].port); i++) await new Promise((s) => setTimeout(s, 400))
            if (!(await portBusy(BACKENDS[other].port))) holder = null
          }
          const oursStuck = !!(holder && portHolderIsOurs(holder))
          if (oursStuck) {
            log(`[launch] 拒绝: ${BACKENDS[other].label} 停止后端口 ${BACKENDS[other].port} 仍被本程序的 pid ${holder.pid} 占着 —— 独占没生效, 不往下起`)
            return {
              /** stuckPort: 让前端知道"强行停掉它"这条路不适用(它已经不在托管里了, 是端口上的残留) */
              ok: false, conflict: true, blocking: other, stuckPort: true,
              msg: `${b.label} 这次先不启动：${BACKENDS[other].label} 没退干净`,
              detail: `它已经不在托管里了，但端口 ${BACKENDS[other].port} 还被 pid ${holder.pid} 占着 `
                + `（那是本程序之前拉起的进程，没退干净）。两套模型同时驻留会把显存/内存来回换页，越切越慢。\n`
                + `怎么办：① 在下面把 ${BACKENDS[other].label} 再点一次「停止」（或「停止并释放」），等它那一行变成"离线"再启动 ${b.label}；\n`
                + `② 实在卡住：重启一次本程序 —— 它启动时会清掉上一次残留的后端进程（这是本程序自己的收尾，不是让你重装什么）。`,
              memory: { vramGB, ramGB },
            }
          }
          guard.externalNote = `${BACKENDS[other].label} 的端口 ${BACKENDS[other].port} 还被 ${holder.name}(pid ${holder.pid}) 占着`
            + `（不是本程序拉起的进程，没有动它）`
          log(`[launch] 注意: ${BACKENDS[other].label} 端口 ${BACKENDS[other].port} 被外部进程 ${holder.name}(pid ${holder.pid}) 占着, 不动它, 继续起 ${b.label}`)
        } else {
          log(`[launch] 独占在线: 已停止 ${BACKENDS[other].label}(进程已退出, 端口已空, 显存与内存一并还回)`)
        }
      } else {
        const asked = await requestFreeModels(other)
        guard.freed.push(`${BACKENDS[other].label}（非托管进程，只请它卸载了模型）`)
        log(`[launch] 独占在线: ${BACKENDS[other].label} 不是本程序启动的, 只请求它卸载模型(${asked ? '已请求' : '请求失败'})`)
      }
    }
    const parts = []
    if (guard.stopped.length) parts.push(`已自动关闭 ${guard.stopped.join('、')}`)
    if (guard.freed.length) parts.push(guard.freed.join('、'))
    if (guard.externalNote) parts.push(guard.externalNote)
    if (parts.length) guard.reason = `本机同一时刻只在线一个模型：${parts.join('；')}`
  }
  /**
   * 端口残留自愈 (2026-10-06)。
   *
   * 走到这里 = 这一路**没有**托管记录(有的话上面早就幂等返回了)。若它的端口还有人在听, 只有
   *   两种可能:
   *     ① 上一轮"启动中被强制下掉"留下的进程没退干净 → 不处理的话这一路永远起不来
   *        (用户反馈的"端口被占用, 视频一直生成不出来");
   *     ② 用户自己另开的同类后端(或者上一轮程序留下的、但还在正常接活的进程) → **绝不杀**。
   *   区分: 进程可执行文件在模型包目录里 = 我们自己的; 再用 HTTP 探一次 —— 还能答话 = 正在
   *   正常接活, 直接按"已在运行"如实回报, 不去动它; 不答话 = 死残留, 结束掉再启动。
   */
  if (await portBusy(b.port)) {
    const holder = portHolder(b.port)
    const ours = holder && /^python|^pythonw/i.test(holder.name) && portHolderIsOurs(holder)
    if (ours) {
      const snap = await probeBackend(kind).catch(() => null)
      /**
       * ⚠️ "还能答话"只有在**不是刚被我们停掉**的情况下才算"已经在跑"(上一轮程序留下的健康进程)。
       *   刚停完还占着端口 = 没退干净的残留(典型: 重启那一路), 必须结束它, 否则「重启」会静默不生效。
       */
      const justStopped = Date.now() - (BACKEND_STOPPED_AT.get(kind) ?? 0) < 60_000
      if (snap?.online && !justStopped) {
        log(`[launch] ${b.label}: 端口 ${b.port} 上已有本程序的后端在跑(pid ${holder.pid}), 不再重复拉起`)
        return {
          ok: true, managed: false, already: true, external: true, pid: Number(holder.pid),
          detail: `${b.label} 已在运行 (pid ${holder.pid}, 不是本次启动拉起的)`,
        }
      }
      log(`[launch] ${b.label}: 端口 ${b.port} 上还挂着没退干净的进程(pid ${holder.pid}), 先结束它再启动`)
      killTree(Number(holder.pid), true)
      for (let i = 0; i < 8 && await portBusy(b.port); i++) await new Promise((s) => setTimeout(s, 400))
      if (await portBusy(b.port)) {
        return {
          ok: false,
          msg: `${b.label} 起不来：端口 ${b.port} 还被占着`,
          detail: `刚结束掉一个残留进程(pid ${holder.pid}), 但端口还没空出来 —— 等 10 秒再点一次「启动」；`
            + `一直不行就重启一次本程序（它会清理上次残留的进程）。`,
        }
      }
    } else if (holder) {
      log(`[launch] ${b.label}: 端口 ${b.port} 被 ${holder.name}(pid ${holder.pid}) 占着, 不是本程序拉起的, 不处理`)
    }
  }
  const cold = coldStartOf(kind)
  if (cold.cold) log(`[boot] ${b.label} 检测到冷启动(首次运行, 会慢很多): ${cold.reasons.join('; ')}`)
  const bat = path.join(P.batDir, b.bat)
  /**
   * 模型包"缺文件"自愈 (2026-09-28) —— 与上面 H3 Turbo 补丁同一个道理:
   *   放在**启动前**, 让老用户只更新程序包就拿到修复, 不用重下几十 GB 模型包。
   *   现场: 测试机装完千问包后端起 0 秒就退, 日志里是
   *     `ModuleNotFoundError: No module named 'comfy_api.input'` ——
   *   我们把发出去的 .7z 与本机装好的那份逐文件比对, 确认包里**少了 comfy_api\input\ 三个文件**。
   *   详见 healBackendFiles 的注释。
   */
  const healedFiles = healBackendFiles(kind)
  if (healedFiles.length) {
    log(`[heal] ${b.label}: 已补齐 ${healedFiles.length} 个缺失文件 → `
      + `${healedFiles.slice(0, 4).join(', ')}${healedFiles.length > 4 ? ` …(共 ${healedFiles.length} 个)` : ''}`)
  }

  /**
   * ComfyUI 模板示例图容错补丁 (2026-10-04 用户: "这次发了模型包之后，有一些机型出现了这个报错")。
   *
   * 现场: Krea2 启动日志里 [ERROR] Failed to resolve template asset paths: Package
   *   'comfyui_workflow_templates_media_api' is not installed for asset 'api_bfl_flux2_max_sofa_swap-1.webp'
   *   (有的层是 [ERROR] No workflow template assets found. Did the packages install correctly?)
   *
   * 根因: `comfyui-workflow-templates` 把五个 media 包(模板浏览器的示例图)写成**硬依赖**,
   *   而我们的模型包**故意剔掉了它们** —— 每层 392MB × 三层 ≈ 1.2GB, 而 Manke 从不打开
   *   ComfyUI 的模板界面。新版 ComfyUI 核心在启动时会为模板解析一遍图片路径, 缺图就整段放弃并打 ERROR。
   *
   * 这是**纯日志噪音, 不影响生成**(后端照常 "Starting server"), 但用户/客户看到 [ERROR] 会以为包坏了。
   * 所以这里在**启动前**把它改成"逐张容错 + 空表降级成 info" —— 与上面两条修法同一个道理:
   *   老用户只更新程序包就拿到修复, 不用重下 1.2GB 模板示例图。
   * 幂等 + 首次修改留 `frontend_management.py.aics-orig`; 匹配不到(别的 ComfyUI 版本)就原样跳过。
   */
  try {
    const { patchLayer } = await import('./tools/comfy-templates-patch.mjs')
    const patched = patchLayer(layerRootOf(kind)).filter((r) => r.status === 'patched')
    if (patched.length) {
      log(`[templates-patch] ${b.label}: 已让"模板示例图缺失"不再报 ERROR(${patched.map((r) => r.note).join(' + ')})`
        + ` · 原文件备份为 .aics-orig`)
    }
  } catch (e) {
    log(`[templates-patch] 打补丁失败(不影响启动): ${e?.message ?? e}`)
  }

  // 优先用 python.exe 直接启动 (绕开 .bat 的 GBK 编码问题); 找不到再退回 .bat
  const attempts = []
  if (kind === 'h3') {
    /**
     * 启 H3 之前先把 Turbo 节点的一处 bug 打上补丁 (2026-09-19):
     *   「多参生视频 + 参考视频」会直接崩在 adaln 注入上(tensor 3 vs 2)——
     *   模型侧把参考视频也算一行视觉条件, 而 LoRA 节点只认 image。详见 tools/h3-turbo-patch.mjs。
     * 幂等 + 首次修改留 __init__.py.aics-orig 备份; 匹配不到就跳过(不碰用户的文件)。
     * 放在**启动前**而不是安装时: 老用户只需更新程序包就能拿到这个修复, 不用重下 59GB 视频包。
     */
    try {
      const { patchH3TurboNode } = await import('./tools/h3-turbo-patch.mjs')
      const r = patchH3TurboNode(P.backendsRoot, { log })
      if (r.status === 'fixed') log(`[h3-patch] 已修 Turbo 节点: 参考视频不再崩(原文件备份为 __init__.py.aics-orig)`)
      else if (r.status === 'nomatch') log(`[h3-patch] 跳过(节点版本不同): ${r.detail}`)
    } catch (e) {
      log(`[h3-patch] 打补丁失败(不影响启动): ${e?.message ?? e}`)
    }
    /**
     * 视觉条件尺寸兜底 (2026-10-17, 两台客户机同一个 patchify 崩):
     *   老前端把"参考视频/参考图"按**原尺寸**送进来时, H3 的 `_cond_video_rows` 会 reshape 崩
     *   (`shape '[...]' is invalid for input of size ...`)。前端在 v2.2.0 已给参考视频补了 ImageScale,
     *   但**"老前端 + 新程序包"**的用户仍旧会踩 ⇒ 后端再兜一层: 尺寸对不上就插值到主 latent 再 patchify。
     *   幂等 + 首次留 `model.py.aics-orig`, 匹配不到就跳过(不碰用户的文件)。
     */
    try {
      const { patchH3CondVideo } = await import('./tools/h3-cond-video-patch.mjs')
      const r = patchH3CondVideo(P.backendsRoot, { log })
      if (r.status === 'fixed') log(`[h3-patch] 已修: 参考素材尺寸不一致时自动对齐到主 latent(不再崩)`)
      else if (r.status === 'nomatch') log(`[h3-patch] 视觉条件兜底跳过(模型版本不同): ${r.detail}`)
    } catch (e) {
      log(`[h3-patch] 视觉条件兜底失败(不影响启动): ${e?.message ?? e}`)
    }
    attempts.push({
      pyExe: path.join(P.h3Root, 'python_embeded', 'python.exe'),
      // --disable-auto-launch: ComfyUI 默认会在启动时自己打开浏览器展示它的界面
      //   (cli_args.py 里 auto_launch 默认 True → main.py 调 webbrowser.open)。
      //   那样用户每启动一次视频/图片后端就蹦一个浏览器窗口, 必须显式关掉。
      // 内存/显存相关参数见 memoryLaunchArgs() 的说明
      //
      // ⚠️ 关于「RTX 超分」失败 (NvVFX_CreateEffect failed) 的结论 —— 别再来回改启动参数:
      //   2026-09-19 实测定位到真因是 **后端所在路径含非 ASCII(中文)字符**。
      //   同一份 nvvfx 运行时(文件哈希逐字节一致)分别放在两个位置, 只换路径:
      //     C:\_aics_probe\ascii_dir\nvvfx    → VideoSuperRes(...).load() 成功
      //     C:\_aics_probe\中文目录\nvvfx      → 必失败: The requested feature is not yet implemented (code -2)
      //   装机目录 D:\Manke(全 ASCII) 上, 2K·RTX 出片成功(480P/1秒/2步 → 2560×1440, 24~25 秒),
      //   且与分配器无关: cudaMallocAsync(ComfyUI 默认) 和 native 都能成功
      //   (曾一度怀疑 cudaMallocAsync 并加过 --disable-cuda-malloc, 后经对照证明是误判, 已撤掉)。
      //   也排除了: 显存不足(剩 1.8GB 时仍能创建)、SDK/驱动不兼容、文件损坏。
      //   → 用户报这个错时先看「模型目录」是不是中文路径; 前端已在超分抽屉里做提示(不拦)。
      args: [path.join(P.h3Root, 'ComfyUI', 'main.py'), '--windows-standalone-build',
             '--disable-auto-launch', ...memoryLaunchArgs(),
             '--listen', '127.0.0.1', '--port', String(b.port)],
      cwd: P.h3Root,
      /**
       * ⚠️ TRITON_CACHE_DIR 必须是**纯 ASCII 路径** (2026-09-25 实测踩到)。
       *
       * 以前写的是 `path.join(P.h3Root, 'cache', 'triton')` —— 安装/模型目录一旦含中文
       *   (例如 D:\本地无限画布\backends\...), SageAttention 第一次编译 Triton 内核就崩:
       *     File "...\sageattention\triton\quant_per_thread.py", line 187, in per_thread_int8
       *     UnicodeDecodeError: 'utf-8' codec can't decode byte 0xb1 in position 3
       *   (0xB1 正是 GBK 里"本"的首字节 —— Triton 把带中文路径的元数据按本地编码写、再按
       *    UTF-8 读回来, 直接炸在采样节点 SamplerCustomAdvanced 上, 表现为"生视频失败"。)
       * 注意: PYTHONUTF8=1 与 TMP/TEMP 的 ASCII 化都已经在 backendEnv 里做了, 仍然会炸 ——
       *   唯一没被管到的就是这条 TRITON_CACHE_DIR。所以它统一落到 asciiSafeBase() 底下,
       *   和 TORCH_EXTENSIONS_DIR / tmp 同一处, 装机目录叫什么名字都不再影响加速内核。
       */
      env: backendEnv(path.join(P.h3Root, 'python_embeded', 'python.exe'),
        { TRITON_CACHE_DIR: path.join(extPaths().base, 'triton') }),
    })
  } else if (kind === 'kear') {
    attempts.push({
      pyExe: path.join(P.kearRoot, 'python_embeded', 'python.exe'),
      args: [path.join(P.kearRoot, 'ComfyUI', 'main.py'), '--disable-auto-launch',
             ...memoryLaunchArgs(),
             '--listen', '127.0.0.1', '--port', String(b.port)],
      cwd: path.join(P.kearRoot, 'ComfyUI'),
      env: backendEnv(path.join(P.kearRoot, 'python_embeded', 'python.exe')),
    })
} else if (kind === 'indextts') {
  attempts.push({
    pyExe: path.join(P.indexttsRoot, 'python_embeded', 'python.exe'),
    args: [path.join(P.indexttsRoot, 'server.py'), '--host', '127.0.0.1', '--port', String(b.port)],
    cwd: P.indexttsRoot,
      // TORCH_CUDA_ARCH_LIST 固定成"编译预编译内核时用的那一份":
      //   ① 模型包里带着 BigVGAN 的预编译内核, 运行时直接加载(见 cuda/load.py 顶部注释);
      //   ② 万一用户机器有工具链、真走了 JIT, 架构列表一致 → torch 的构建缓存键也一致,
      //      不会因为"识别到不同显卡"而重新编译。
    env: backendEnv(path.join(P.indexttsRoot, 'python_embeded', 'python.exe'),
      { TORCH_CUDA_ARCH_LIST: BIGVGAN_ARCH_LIST }),
  })
} else if (kind === 'qwen') {
  /**
   * Qwen-Image-2.1 生图 (2026-09-24 方案 A 第 4 路)。
   * 与前两路 ComfyUI 的区别: 它的 main.py 在组件**根目录**(不是 ComfyUI/main.py),
   *   python 在 conda 风格的 env\ 下(不是 python_embeded\) —— 抄参数前先看这两点。
   * 模型就在组件自带的 models\ 里, 不需要 --extra-model-paths-config。
   */
  attempts.push({
    pyExe: path.join(P.qwenRoot, 'env', 'python.exe'),
    args: [path.join(P.qwenRoot, 'main.py'), '--disable-auto-launch',
      ...memoryLaunchArgs(),
      '--listen', '127.0.0.1', '--port', String(b.port)],
    cwd: P.qwenRoot,
    env: backendEnv(path.join(P.qwenRoot, 'env', 'python.exe')),
  })
} else if (kind === 'text') {
  /**
   * 本地小文本模型 (2026-09-25 第 5 路): 提示词优化/翻译专用, **纯 CPU、不占显存**。
   *
   * 运行环境借 H3(或 Krea2)自带的 python_embeded —— 里面有 torch + transformers, 不必再装一份;
   * 模型权重放 backends/text/models/(发模型包时带上, 或用「下载本地小模型」按钮拉)。
   * worker 是我们自己的 tools/local-text/serve.py(OpenAI 兼容的极小接口, 见文件头)。
   */
  const pyCandidates = [
    path.join(P.h3Root, 'python_embeded', 'python.exe'),
    path.join(P.kearRoot, 'python_embeded', 'python.exe'),
  ]
  const textPy = pyCandidates.find((p) => fs.existsSync(p))
  if (textPy) {
    /** worker 脚本永远在 server.mjs 旁边(打包后是 bundle\tools\local-text\serve.py, 开发态是仓库 tools\...) */
    const textWorker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tools', 'local-text', 'serve.py')
    try { fs.mkdirSync(P.textRoot, { recursive: true }) } catch { /* 目录建不出来就让 spawn 自己报 */ }
    if (!fs.existsSync(textWorker)) log(`[text] 找不到 worker 脚本: ${textWorker}`)
    attempts.push({
      pyExe: textPy,
      args: [textWorker],
      cwd: P.textRoot,
      env: backendEnv(textPy, {
        AICS_TEXT_MODEL: path.join(P.textRoot, 'models'),
        AICS_TEXT_PORT: String(b.port),
        /**
         * 显存策略(2026-09-25 用户: "模型如果用显存载入呢"):
         *   默认 auto —— worker 自己看**当前空闲显存**, 够(≥2.5GB)就用 GPU/fp16, 不够就退 CPU/int8。
         *   这样"先写提示词(卡空着)→ 再开 H3"正好吃到 GPU; 而 H3 已经占着 19/20GB 时不会硬塞进去。
         *   拉起 H3/Krea2/Qwen 之前, 服务端还会先 POST /unload 让它把显存让出来(见 freeTextBackend)。
         */
        AICS_TEXT_DEVICE: process.env.AICS_TEXT_DEVICE || 'auto',
        AICS_TEXT_VRAM_GB: process.env.AICS_TEXT_VRAM_GB || '4',
        /**
         * 常驻(2026-09-25 用户: "提示词这个模型要常驻是最好的"):
         *   IDLE=0 表示**不因空闲卸载**; 只有别的重模型要显存时才让它让位, 让位后它自己会装回来。
         */
        AICS_TEXT_IDLE_SEC: process.env.AICS_TEXT_IDLE_SEC || '0',
        AICS_TEXT_RESIDENT: process.env.AICS_TEXT_RESIDENT || '1',
      }),
    })
  }
}

  for (const a of attempts) {
    /** 把"这次补齐了哪些缺失文件"带进 spawn 规格 → 日志头里能看到(远程排障就靠这一行) */
    if (healedFiles.length) a.healed = healedFiles
    /**
     * ★ 2026-10-12: 强制走包内 CUDA 12.6 兼容栈(见 retryWithCompatStackOnce)。
     *   .pth 选择器读的就是这个环境变量(见 tools/compat_pth.mjs), 所以一处注入, 这一路的每个
     *   尝试都生效。
     */
    if (opts.compatStack && a.env) a.env = { ...a.env, AICS_CUDA_MODE: String(opts.compatStack) }
    if (!fs.existsSync(a.pyExe)) continue
    // 已在托管中 → 幂等返回, 避免重复拉起把显存吃爆
    const live = BACKEND_PROCS.get(kind)
    if (live && !live.exited) {
      return { ok: true, managed: true, already: true, pid: live.pid, detail: `${b.label} 已在运行 (pid ${live.pid})` }
    }
    // 永远托管启动: 静默运行(无窗口) + 日志落盘 + PID 可清理。
    // 把实际生效的内存相关参数写进日志 —— 排障时"到底带没带 --vram-headroom/--cache-none"
    // 一眼可见(用户实测时我们就吃过"不知道参数有没有生效"的亏)。
    if (kind === 'h3' || kind === 'kear') {
      // 去掉脚本路径, 保留完整参数(含 --vram-headroom 1.5 这类"标志 + 值")
      const p = launchProfile()
      // 档位也打出来 —— 排障时"这台机器走的是哪一档、有没有关固定内存"一眼可见
      log(`[launch] ${b.label} 档位=${p.label}(显存${p.vramGB || '?'}GB/内存${p.ramGB}GB) 参数: ${a.args.slice(1).join(' ')}`)
    }
    const rec = managedSpawn(kind, a)
    /**
     * ⚠️ 2026-09-25 用户: "翻译也不用本地模型呢" —— 现在**提示词优化与语言切换都不再用本地文本模型**,
     *   所以这一路**不再自动预加载**(避免白占 4GB 显存、影响 H3 出片)。
     *   后端与 worker 都保留着(以后要接"本地模型润色"直接 POST /text/preload 就能启用),
     *   只是默认闲置: 用户不主动碰它, 它就不加载模型、不占显存。
     */
    return {
      ok: true, managed: true, pid: rec.pid,
      detail: `已静默启动 ${b.label} (pid ${rec.pid})，首次加载模型可能需 1~3 分钟`
        + (healedFiles.length ? ` · 已自动补齐 ${healedFiles.length} 个模型包缺失文件` : '')
        + (guard.reason ? ` · ${guard.reason}` : ''),
      freed: guard.stopped,
    }
  }

  if (fs.existsSync(bat)) {
    // 兜底路径(直接跑 python 的环境缺失时才走到这里)也走托管: 同样静默、同样收日志、同样能清理。
    const live2 = BACKEND_PROCS.get(kind)
    if (live2 && !live2.exited) {
      return { ok: true, managed: true, already: true, pid: live2.pid, detail: `${b.label} 已在运行 (pid ${live2.pid})` }
    }
    // .bat 兜底: 环境同样要带 ninja 目录/英文临时目录, 且告诉 .bat 模型放在哪
    /** ⚠️ 2026-09-28: 以前这里也没 qwen 分支(会落到 indextts) → conda 的 env\Library\bin
     *  就进不了 PATH。统一走 backendPyPath(kind), 四路各归各。 */
    const pyForBat = backendPyPath(kind)
    const rec = managedSpawn(kind, {
      pyExe: process.env.ComSpec || 'cmd.exe',
      args: ['/c', bat],
      cwd: P.batDir,
      env: backendEnv(pyForBat, { AICS_MODELS: P.backendsRoot }),
    })
    return {
      ok: true, managed: true, pid: rec.pid,
      detail: `已静默启动 ${b.label} (via ${b.bat}, pid ${rec.pid})`
        + (healedFiles.length ? ` · 已自动补齐 ${healedFiles.length} 个模型包缺失文件` : '')
        + (guard.reason ? ` · ${guard.reason}` : ''),
      freed: guard.stopped,
    }
  }

  // 没有可执行环境 → 给出"去哪里放模型"的引导, 而不是一句冷冰冰的报错
  const guide = BACKEND_GUIDE[kind] ?? {}
  return {
    ok: false,
    needsInstall: true,
    msg: `${b.label} 后端还没安装`,
    detail: `未在 ${P.backendsRoot} 找到运行环境。${guide.hint ?? ''}${LAYOUT_HINT}`,
    expectPath: guide.expect(P) ?? '',
    backendsRoot: P.backendsRoot,
  }
}

/**
 * 「装歪了也能认」——2026-10-12 用户: "很多人在安装模型包后会提示这一路模型还没装…不能出现误判"。
 *   检测本体在 `tools/models.mjs` 的 `resolveComponentDir`(标准位置 → 有界深搜, 见那里的说明);
 *   这句是**真的找不到时**给用户的那条出路(前两种装歪会被自动认出来, 认不出来时多半不是布局问题)。
 */
const LAYOUT_HINT = '（解压多一层 backends\\backends\\… 或少剥一层壳都能自动认出来；'
  + '仍报"没装"就用设置里的「模型目录」指到真正的那个 backends 目录，或看「模型目录」里列出的实际路径）'

/** 三个后端各自"应该长什么样"的引导文案 (未安装模型时展示给用户) */
const BACKEND_GUIDE = {
  h3: {
    hint: '把 H3 视频后端整套目录放到 backends/h3/payload/backend/ComfyUI-H3/ 下 (需含 python_embeded\\python.exe 与 ComfyUI\\main.py)。',
    expect: (p) => path.join(p.h3Root, 'python_embeded', 'python.exe'),
  },
  kear: {
    hint: '把 Krea2 生图后端放到 backends/comfyui-kear2/ 下 (需含 python_embeded\\python.exe 与 ComfyUI\\main.py)。',
    expect: (p) => path.join(p.kearRoot, 'python_embeded', 'python.exe'),
  },
  indextts: {
    hint: '把 IndexTTS 语音后端放到 backends/indextts-tts/ 下 (需含 python_embeded\\python.exe 与 server.py)。',
    expect: (p) => path.join(p.indexttsRoot, 'python_embeded', 'python.exe'),
  },
  /** 第 4 路 (2026-09-24): Qwen-Image-2.1 —— 布局与上面三路不同, 提示必须写准 */
  qwen: {
    hint: '把 Qwen-Image-2.1 生图后端放到 backends/comfyui-qwen/ 下 (需含 env\\python.exe 与 main.py, 模型在其自带 models\\ 里)。',
    expect: (p) => path.join(p.qwenRoot, 'env', 'python.exe'),
  },
  /** 第 5 路 (2026-09-25): 本地小文本模型 —— **选装**, 缺它不影响任何生成, 只少了"本地 AI 优化提示词" */
  text: {
    hint: '把本地小文本模型放到 backends/text/models/Qwen2.5-0.5B-Instruct/ (HF 格式: config.json + model.safetensors + tokenizer*)。'
      + '运行环境借 H3 自带的 python_embeded, 不需要单独装 Python。缺它时提示词优化会自动退回"本地框架整理"。',
    expect: (p) => path.join(p.textRoot, 'models'),
  },
}

// ---------------------------------------------------------------- 打开产物目录

function handleOpenFolder(req, res) {
  /**
   * ★ 2026-10-12 审计 §3.3: 这里原来有两处"能把资源管理器开到数据目录/输出目录以外"的口子:
   *   ① `dir` 分支用 `want.startsWith(root)` —— 经典**前缀漏判**: `…\dataX` 也算"在 data 里";
   *   ② `subfolder` / `filename` **完全没有消毒** —— `..\..\..\Windows` 这种能直接把 explorer 开出去。
   *   只影响"打开哪个文件夹"(不读不写), 但该收的口子要收, 而且要与 `handleAssetsFile` /
   *   `resolveOutputFile` 同一套口径, 别每个接口各写一份。
   */
  const pathInside = (base, rel, { allowSubdir = true } = {}) => {
    const b = path.resolve(base)
    const s = String(rel ?? '')
    if (!s) return b
    /** 绝对路径 / 盘符 / UNC 一律不认(只接受相对 base 的子路径) */
    if (path.isAbsolute(s) || /^[a-zA-Z]:/.test(s) || s.startsWith('\\\\') || s.startsWith('//')) return null
    /** 文件名字段不许带目录分隔符(它只是"选中哪一个文件") */
    if (!allowSubdir && /[\\/]/.test(s)) return null
    const p = path.resolve(b, s)
    return p === b || p.startsWith(b + path.sep) ? p : null
  }
  readBody(req, res).then((body) => {
    // 直接给绝对目录(如诊断包导出目录) —— 只允许 data 目录内, 避免被当成任意路径打开
    if (body.dir) {
      const want = path.resolve(String(body.dir))
      const root = path.resolve(P.dataDir)
      /** ⚠️ 必须比 `root + sep`(或正好等于 root): 只比 `startsWith(root)` 会让 `…\dataX` 蒙混过关 */
      if (want !== root && !want.startsWith(root + path.sep)) {
        return sendJson(res, 400, { ok: false, msg: '只允许打开数据目录内的文件夹' })
      }
      try { fs.mkdirSync(want, { recursive: true }) } catch { /* ignore */ }
      spawn('cmd.exe', ['/c', 'start', '""', 'explorer.exe', want], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref()
      return sendJson(res, 200, { ok: true, detail: { dir: want } })
    }
    /**
     * ★ 2026-10-30 云端链接（那条历史没本地化成功）：
     *   以前把 `https://…` 整串当 filename → 报「非法的文件名(不许带路径分隔符)」，
     *   用户看不懂，也不知道下一步做什么。这里换成能照做的一句话。
     */
    if (body.remote) {
      return sendJson(res, 400, {
        ok: false,
        code: 'REMOTE_ONLY',
        msg: '这条记录存的是云端链接，文件还没存到本地｜怎么办：先点「下载」另存一份，或重新生成一次（生成完会自动存到本地）',
      })
    }
    /**
     * ★ 2026-10-30 本机绝对路径（早期记录 / 外部导入存成了 `D://…//x.mp4`）。
     *   只允许"我们自己的目录"（素材目录 + 各路输出目录 + 数据目录），别的一句拒绝 ——
     *   这个接口是"打开资源管理器"，不该变成任意路径打开器。
     */
    if (body.abs) {
      const want = path.resolve(String(body.abs))
      const roots = [...assetRoots(), ...Object.values(P.outputDirs), P.dataDir]
        .filter(Boolean).map((d) => path.resolve(String(d)))
      const inside = roots.some((r) => want === r || want.startsWith(r + path.sep))
      if (!inside) return sendJson(res, 403, { ok: false, msg: '这条记录的文件不在允许打开的目录里' })
      if (!fs.existsSync(want)) return sendJson(res, 404, { ok: false, msg: '这个文件已经不在了（可能被清理或移走）' })
      spawn('cmd.exe', ['/c', 'start', '""', 'explorer.exe', `/select,${want}`], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref()
      return sendJson(res, 200, { ok: true, detail: { dir: path.dirname(want), file: want } })
    }
    const filename = body.filename ?? ''
    const subfolder = body.subfolder ?? ''
    const backend = body.backend
    const outputDir = P.outputDirs[backend] ?? P.outputDirs.h3

    /**
     * ★ 2026-10-18 修「打开历史中的文件夹 → 打开失败·非法的文件名(不许带路径分隔符)」:
     *   历史里的 `output.filename` 存的是**本地化地址**（`/api/assets/file?name=<hash>.mp4`），
     *   前端把它当 filename 原样传进来 ⇒ 撞上下面那条"文件名不许带分隔符"的消毒，**每条历史都开不了**。
     *   现在: 前端把这类地址拆成 `asset`，这里在**素材目录**（默认目录 + 用户改过的 mediaDirs，见 assetRoots）
     *   里找到那份副本并用 explorer 高亮；真找不到就明确说"文件不在了"，不再甩一个看不懂的校验错误。
     */
    if (body.asset) {
      const hit = findAssetFile(String(body.asset))
      if (!hit) return sendJson(res, 404, { ok: false, msg: '这个文件已经不在了（可能被清理或移走）' })
      spawn('cmd.exe', ['/c', 'start', '""', 'explorer.exe', `/select,${hit}`], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref()
      return sendJson(res, 200, { ok: true, detail: { dir: path.dirname(hit), file: hit } })
    }

    /** ⚠️ 消毒后再用: 越界的 subfolder/filename 直接拒绝(不再"照单全收") */
    const targetDir = pathInside(outputDir, subfolder)
    if (targetDir === null) {
      return sendJson(res, 400, { ok: false, msg: '非法的子目录(只能打开输出目录内)' })
    }
    const absPath = filename ? pathInside(targetDir, filename, { allowSubdir: false }) : ''
    if (absPath === null) {
      return sendJson(res, 400, { ok: false, msg: '非法的文件名(不许带路径分隔符)' })
    }
    const selectFile = absPath && fs.existsSync(absPath) ? absPath : null

    const arg = selectFile ? `/select,${selectFile}` : targetDir
    spawn('cmd.exe', ['/c', 'start', '""', 'explorer.exe', arg], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref()

    sendJson(res, 200, { ok: true, detail: { dir: targetDir, file: selectFile } })
  }).catch((e) => sendJson(res, 500, { ok: false, msg: '打开失败', detail: String(e) }))
}

// ---------------------------------------------------------------- 素材本地化
//
// 背景 (2026-09-13 问题3): 画布素材(生成产出)以 /comfy/view?… 或 /kear/view?… 相对
// URL 存进节点 output, 这类地址依赖对应后端进程运行才能取到文件。用户期望"打开画布
// 本地素材就显示", 不依赖 H3/Kear 是否在线。
//
// 方案: 生成成功回填 output 后(此刻后端在线), 前端调 POST /api/assets/localize 把
// 产物文件复制到 <dataDir>/assets/ 下, 返回 /api/assets/file?name=<hash><ext> 的
// 静态地址 —— 画布重开、后端离线都不影响显示。复制一次后按文件名幂等(重复调用直接
// 返回已有地址, 不重复占盘)。
//
//   POST /api/assets/localize   {url: "/comfy/view?filename=…&subfolder=…&type=…" | "/kear/view?…"}
//                               → {ok, url: "/api/assets/file?name=<hash><ext>"}
//   GET  /api/assets/file?name=<hash><ext>   → 文件内容 (静态, 无后端依赖)

/** @deprecated 用 DEFAULT_ASSETS_DIR()(可配置存储位置后, 这个"唯一目录"的概念已经不成立了) */
const ASSETS_DIR = () => path.join(P.dataDir, 'assets')

// ---------------------------------------------------------------- 可配置存储位置 (2026-09-26 用户要求)
/**
 * 用户原话: "生成好的文件保存位置要可以在设置中调整，分为图片，视频和音频，在发包后默认还是原来的，
 *   更改会自动迁移，保证数据安全，包括项目管理的位置也要可以自定义"。
 *
 * 语义(刻意保守, 以"不丢数据"为第一优先):
 *   · `settings.mediaDirs = { image, video, audio }` 空字符串 = **默认**(<数据目录>/assets);
 *   · `settings.projectsDir` 空字符串 = 默认(<数据目录>/store);
 *   · 读取/删除/存在性判定一律**跨目录找**(默认目录 + 三个自定义目录), 所以改了目录之后
 *     老文件照样能显示、能删 —— 不会出现"换目录后历史里的图全打不开";
 *   · 写新文件时按类型落到对应目录;
 *   · 改设置时**先复制(不删原件)再切换**, 复制完核对文件数与总字节数, 对不上就不改设置 ——
 *     最坏情况只是多占一份磁盘, 绝不会丢。
 */
const MEDIA_KINDS = ['image', 'video', 'audio']
const DEFAULT_ASSETS_DIR = () => path.join(P.dataDir, 'assets')
const DEFAULT_STORE_DIR = () => path.join(P.dataDir, 'store')

/** 这一类媒体该落到哪个目录(空=默认) */
function mediaDirFor(kind) {
  const d = P.settings?.mediaDirs?.[kind]
  const s = typeof d === 'string' ? d.trim() : ''
  return s || DEFAULT_ASSETS_DIR()
}
/** 本地副本可能存在的位置(默认 + 三个自定义, 去重) —— 读取/删除/判定都要挨个找 */
function assetRoots() {
  return [...new Set([DEFAULT_ASSETS_DIR(), ...MEDIA_KINDS.map(mediaDirFor)])]
}
/** 按文件名找一份本地副本(带越界防护) */
function findAssetFile(name) {
  const n = String(name ?? '')
  if (!n || /[\\/]/.test(n) || n.includes('..')) return null
  for (const dir of assetRoots()) {
    const p = path.join(dir, n)
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p } catch { /* 下一个 */ }
  }
  return null
}
/** 按扩展名判断这块副本属于图片/视频/音频 —— 决定新文件落哪个目录 */
function mediaKindOfName(name) {
  const e = path.extname(String(name ?? '')).toLowerCase()
  if (/^\.(mp4|webm|mov|mkv|avi|m4v)$/.test(e)) return 'video'
  if (/^\.(mp3|wav|m4a|flac|ogg|aac|opus)$/.test(e)) return 'audio'
  return 'image'
}
/** 写文件前确保目标目录存在, 返回绝对路径 */
function assetPathFor(name) {
  const dir = mediaDirFor(mediaKindOfName(name))
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, name)
}

/**
 * 迁移一个目录里的**某一类**文件到新目录(复制, 不删原件)。
 * @returns {{ copied:number, skipped:number, bytes:number, from:string, to:string, ok:boolean, msg?:string }}
 */
/**
 * 存储位置迁移的**后台任务**状态 (§3.5)。
 *   GET /api/settings/migrate 原样回给前端(设置面板据此显示进度)。
 *   语义: 迁移**不删原件**; 只有整趟核对通过才切换设置(见 runStorageMigrate)。
 */
let MIGRATE = null
const migrateLabel = () => (MIGRATE ? `${MIGRATE.phaseText}（${MIGRATE.done}/${MIGRATE.total} 个文件）` : '')

/**
 * ★ 2026-10-12 审计 §3.5: 这个函数以前是**同步**的(`fs.copyFileSync` 逐个文件) ——
 *   素材可能几十 GB, 复制期间**请求不返回、界面全无反应, 也没有任何进度**(用户的原话是"像卡死")。
 * 现在: 全部改成 `fs.promises.*`, 每复制一个文件都 `await`(天然让出事件循环) ⇒ 迁移期间
 *   状态轮询/反代/界面操作全都照常; 同时把进度写进 MIGRATE, 前端能看到"第几个/多少字节"。
 * ⚠️ 语义一个字没改: 只复制不删、目标已有同尺寸就跳过、最后核对"目标 >= 源"才允许切换。
 */
async function migrateMediaFiles(fromDir, toDir, kind) {
  const out = { copied: 0, skipped: 0, bytes: 0, from: fromDir, to: toDir, ok: true }
  try {
    if (!fromDir || path.resolve(fromDir) === path.resolve(toDir)) return { ...out, skipped: -1 }
    if (!fs.existsSync(fromDir)) return out                       // 源目录还没有 → 没什么可搬的
    fs.mkdirSync(toDir, { recursive: true })
    /** 先数一遍(只 stat, 很便宜) —— 有了总数前端才能显示"第几个/共几个" */
    const files = []
    let expectCount = 0; let expectBytes = 0
    for (const f of await fs.promises.readdir(fromDir)) {
      const src = path.join(fromDir, f)
      let st
      try { st = await fs.promises.stat(src) } catch { continue }
      if (!st.isFile()) continue
      if (mediaKindOfName(f) !== kind) continue                   // 只搬这一类
      expectCount += 1; expectBytes += st.size; files.push({ f, src, size: st.size })
    }
    if (MIGRATE) { MIGRATE.total += expectCount; MIGRATE.totalBytes += expectBytes }
    for (const { f, src, size } of files) {
      const dst = path.join(toDir, f)
      if (fs.existsSync(dst)) {
        try {
          if ((await fs.promises.stat(dst)).size === size) {
            out.skipped += 1
            if (MIGRATE) MIGRATE.done += 1      // 跳过也算"处理过了", 进度照走(否则会看着卡住)
            continue
          }
        } catch { /* 覆盖 */ }
      }
      await fs.promises.copyFile(src, dst)                           // ⚠️ await: 这里是"不卡界面"的关键
      out.copied += 1; out.bytes += size
      if (MIGRATE) { MIGRATE.done += 1; MIGRATE.bytes += size; MIGRATE.label = migrateLabel() }
    }
    // 核对: 目标目录里这一类文件数/总字节 必须 >= 源目录(不删原件, 所以只可能多)
    let gotCount = 0; let gotBytes = 0
    for (const f of await fs.promises.readdir(toDir)) {
      const dst = path.join(toDir, f)
      try {
        const st = await fs.promises.stat(dst)
        if (!st.isFile() || mediaKindOfName(f) !== kind) continue
        gotCount += 1; gotBytes += st.size
      } catch { /* ignore */ }
    }
    if (gotCount < expectCount || gotBytes < expectBytes) {
      return { ...out, ok: false, msg: `迁移不完整(源 ${expectCount} 个/${expectBytes} 字节, 目标 ${gotCount} 个/${gotBytes} 字节), 已保留原目录、未切换` }
    }
  } catch (e) {
    return { ...out, ok: false, msg: String(e?.message ?? e).slice(0, 200) }
  }
  return out
}

/**
 * 存储位置迁移的**后台跑腿**(§3.5)。
 *
 * 为什么要有它: 迁移可能动几十 GB。以前是在 `/api/settings` 的请求里同步复制 —— 请求不返回、
 *   界面全无反应。现在: 请求立刻返回 `{ migrating: true }`, 真正的复制在这里跑; 前端轮询
 *   `GET /api/settings/migrate` 看进度, 完成后再刷新设置。
 *
 * ⚠️ 安全语义**一个字没改**(见上面那段"刻意保守"的注释):
 *   · 只复制不删; 目标已有同尺寸文件就跳过;
 *   · 任何一步失败 / 核对不通过 → **不改设置**(`P.settings` 与 `data\settings.json` 都不动),
 *     原目录一个字节没丢, 用户可以直接重试或换个目录;
 *   · 只有整趟核对通过, 才写盘并更新内存里的 `P.settings`。
 */
async function runStorageMigrate(next, jobs) {
  try {
    const steps = []
    for (const job of jobs) {
      MIGRATE.phase = job.kind === 'projects' ? 'projects' : job.kind
      MIGRATE.phaseText = job.kind === 'projects' ? '正在迁移项目目录' : `正在迁移${MEDIA_KIND_LABEL[job.kind] ?? job.kind}`
      const r = job.kind === 'projects'
        ? await migrateStoreFiles(job.from, job.to)
        : await migrateMediaFiles(job.from, job.to, job.kind)
      if (!r.ok) throw new Error(r.msg || '迁移不完整')
      steps.push({ kind: job.kind, ...r })
    }
    /** 核对通过才切: 写盘 + 更新内存(与以前的顺序完全一致, 只是挪到了后台) */
    const { writeSettings } = await import('./tools/runtime.mjs')
    writeSettings(P.dataDir, next)
    P.settings = { ...P.settings, ...next }
    MIGRATE.ok = true
    MIGRATE.msg = '已完成, 设置已切换（原目录的文件一个都没删, 确认没问题后可以自己清掉）'
    MIGRATE.steps = steps
    log(`[storage] 迁移完成: ${steps.map((s) => `${s.kind} 复制 ${s.copied}/跳过 ${s.skipped}`).join(' · ')}`)
  } catch (e) {
    MIGRATE.ok = false
    MIGRATE.msg = `${String(e?.message ?? e).slice(0, 200)}｜没有改动任何设置：原目录的文件一个都没动, 可以再试一次或换一个目录`
    log(`[storage] 迁移失败(未切换设置): ${String(e?.message ?? e).slice(0, 200)}`)
  } finally {
    MIGRATE.running = false
    MIGRATE.finishedAt = Date.now()
  }
}

/** 媒体类的中文名(进度文案用) */
const MEDIA_KIND_LABEL = { image: '图片', video: '视频', audio: '音频', projects: '项目' }

/** 迁移项目管理目录(store 下的 *.json), 同样只复制不删 */
/** 同 migrateMediaFiles: 改成异步 + 报进度(§3.5)。项目管理目录通常很小, 但口径要一致 */
async function migrateStoreFiles(fromDir, toDir) {
  const out = { copied: 0, skipped: 0, bytes: 0, from: fromDir, to: toDir, ok: true }
  try {
    if (!fromDir || path.resolve(fromDir) === path.resolve(toDir)) return { ...out, skipped: -1 }
    if (!fs.existsSync(fromDir)) return out
    fs.mkdirSync(toDir, { recursive: true })
    const files = []
    let expectCount = 0; let expectBytes = 0
    for (const f of await fs.promises.readdir(fromDir)) {
      if (!/\.json$/i.test(f)) continue
      const src = path.join(fromDir, f)
      let st
      try { st = await fs.promises.stat(src) } catch { continue }
      if (!st.isFile()) continue
      expectCount += 1; expectBytes += st.size; files.push({ f, src, size: st.size })
    }
    if (MIGRATE) { MIGRATE.total += expectCount; MIGRATE.totalBytes += expectBytes }
    for (const { f, src, size } of files) {
      const dst = path.join(toDir, f)
      if (fs.existsSync(dst)) {
        try {
          if ((await fs.promises.stat(dst)).size === size) {
            out.skipped += 1
            if (MIGRATE) MIGRATE.done += 1
            continue
          }
        } catch { /* 覆盖 */ }
      }
      await fs.promises.copyFile(src, dst)
      out.copied += 1; out.bytes += size
      if (MIGRATE) { MIGRATE.done += 1; MIGRATE.bytes += size; MIGRATE.label = migrateLabel() }
    }
    let gotCount = 0
    for (const f of await fs.promises.readdir(toDir)) if (/\.json$/i.test(f)) gotCount += 1
    if (gotCount < expectCount) {
      return { ...out, ok: false, msg: `迁移不完整(源 ${expectCount} 个 json, 目标 ${gotCount} 个), 已保留原目录、未切换` }
    }
  } catch (e) {
    return { ...out, ok: false, msg: String(e?.message ?? e).slice(0, 200) }
  }
  return out
}

/** 把 /comfy/view 或 /kear/view 的相对 URL 解析为后端 output 目录里的绝对路径 */
function resolveOutputFile(urlStr) {
  const s = String(urlStr || '')
  // 语音后端不走 ComfyUI 那套 /view?filename=…, 它的是 /audio/<file> (前端加前缀后是 /indextts/audio/<file>)。
  // 2026-09-16 用户反馈"停掉图片模型后画布生成的内容就失效"时发现: 语音的产物**压根没进本地化流程**,
  // 于是只留在后端 URL 上 —— 后端一停就播不了。这里补上, 并容忍 outputDirs 指向不同目录的部署。
  const a = s.match(/^\/indextts\/audio\/(.+)$/)
  if (a) {
    let fn = a[1]
    try { fn = decodeURIComponent(fn) } catch { /* 保底用原串 */ }
    fn = fn.replace(/^.*[\\/]/, '')
    if (!fn || /\.\./.test(fn)) return null
    const bases = [P.outputDirs?.indextts, P.indexttsRoot ? path.join(P.indexttsRoot, 'output') : ''].filter(Boolean)
    for (const base of bases) {
      const abs = path.resolve(base, fn)
      if (!abs.startsWith(path.resolve(base))) continue
      if (fs.existsSync(abs)) return { abs, ext: path.extname(fn).toLowerCase() }
    }
    return null
  }
/** 第 4 路 qwen 与前三路同一套 /view 约定 (2026-09-24) */
const m = s.match(/^\/(comfy|kear|indextts|qwen)\/view\?(.*)$/)
if (!m) return null
const backend = m[1] === 'comfy' ? 'h3' : m[1] === 'kear' ? 'kear' : m[1] === 'qwen' ? 'qwen' : 'indextts'
  const q = new URLSearchParams(m[2])
  const filename = q.get('filename')
  if (!filename) return null
  const subfolder = q.get('subfolder') || ''
  const type = q.get('type') || 'output'
  if (type !== 'output' && type !== 'temp') return null
  const base = P.outputDirs[backend]
  if (!base) return null
  // 防目录穿越: filename/subfolder 只允许 [\w. -] 类字符
  if (/[\\/]/.test(filename) || /\.\./.test(subfolder)) return null
  const abs = path.resolve(base, subfolder, filename)
  if (!abs.startsWith(path.resolve(base))) return null
  return { abs, ext: path.extname(filename).toLowerCase() }
}

/**
 * 远端产物(http/https) → 下载并落到本地素材目录。
 *
 * ★ 2026-10-30 从 handleAssetsLocalize 里抽出来 —— 用户原话：
 *   「我需要的是云端也自动落盘到本地，素材问题是底线」。
 *   以前只有前端主动调 /api/assets/localize 才会落盘；前端一关、或者那一次下载失败，
 *   这条产物就**只剩一个会过期的临时链接**。抽成函数之后，服务端自己也能调（见 localizeReturnUrl），
 *   落不下来就进持久化重试队列（见 localizeQueueAdd），不靠前端记得。
 *
 * @returns {{ok:boolean, name?:string, url?:string, bytes?:number, cached?:boolean, status?:number, msg?:string}}
 */
async function downloadRemoteToAssets(url, { timeoutMs = 180_000 } = {}) {
  const guessExt = (u, ct) => {
    const byCt = /image\/(png|jpeg|jpg|webp|gif)/.exec(ct || '')?.[1]
    if (byCt) return `.${byCt === 'jpeg' ? 'jpg' : byCt}`
    if (/video\//.test(ct || '')) return '.mp4'
    if (/audio\//.test(ct || '')) return '.mp3'
    const m = /\.(png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|m4a)(\?|$)/i.exec(String(u))
    return m ? `.${m[1].toLowerCase().replace('jpeg', 'jpg')}` : '.bin'
  }
  const hash = createHash('sha1').update(String(url)).digest('hex').slice(0, 24)
  const dir = mediaDirFor(mediaKindOfName(url))
  fs.mkdirSync(dir, { recursive: true })
  /** 同一 URL 幂等：已经下过就直接复用（重启后重试也不会重复占盘） */
  const known = fs.readdirSync(dir).find((f) => f.startsWith(hash + '.'))
  if (known) {
    return { ok: true, name: known, url: `/api/assets/file?name=${encodeURIComponent(known)}`, cached: true, bytes: 0 }
  }
  let r
  try {
    r = await fetch(String(url), { signal: AbortSignal.timeout(Math.max(5000, timeoutMs)) })
  } catch (e) {
    return { ok: false, msg: `下载失败：${e instanceof Error ? e.message : String(e)}` }
  }
  if (!r.ok) return { ok: false, status: 400, msg: `下载远端产物失败 HTTP ${r.status}` }
  /**
   * ★ 2026-10-12 审计 §2.6: 不能 `Buffer.from(await r.arrayBuffer())` —— url 来自请求体,
   *   只校验了 `^https?://`，**没有体积上限**: 指向超大/无限流地址就是 OOM + 磁盘被写满。
   * 现在: 先看 content-length 快速拒, 再**边下边数**兜住"分块传输/不报长度"。
   */
  const maxBytes = LOCALIZE_MAX_BYTES()
  const declared = Number(r.headers.get('content-length') || 0)
  if (declared > maxBytes) {
    try { r.body?.cancel?.() } catch { /* ignore */ }
    return { ok: false, status: 413, msg: `远端产物太大（${Math.round(declared / 1048576)}MB，上限 ${Math.round(maxBytes / 1048576)}MB）` }
  }
  const parts = []
  let got = 0
  try {
    for await (const chunk of r.body ?? []) {
      got += chunk.length
      if (got > maxBytes) {
        try { r.body?.cancel?.() } catch { /* ignore */ }
        return { ok: false, status: 413, msg: `远端产物太大（已超过上限 ${Math.round(maxBytes / 1048576)}MB）` }
      }
      parts.push(chunk)
    }
  } catch (e) {
    return { ok: false, msg: `下载中断：${e instanceof Error ? e.message : String(e)}` }
  }
  const buf = Buffer.concat(parts)
  if (!buf.length) return { ok: false, msg: '远端产物是空的（0 字节）' }
  const name = hash + guessExt(url, r.headers.get('content-type'))
  /** 写之前再按**最终文件名**定一次目录（有的链接没扩展名，靠 content-type 才定下来） */
  const finalPath = assetPathFor(name)
  fs.writeFileSync(finalPath, buf)
  log(`云端产物已本地化: ${name} (${(buf.length / 1048576).toFixed(2)}MB)`)
  return { ok: true, name, url: `/api/assets/file?name=${encodeURIComponent(name)}`, bytes: buf.length }
}

/* ---------------------------------------------------------------- 落盘重试队列
 *
 * 用户口径（2026-10-30）：「我需要的是云端也自动落盘到本地，素材问题是底线」。
 *
 * 为什么必须持久化: 云端给的链接是**临时签名链接**，几分钟到几小时就失效。一次网络抖动 /
 *   磁盘忙 / 程序被关，那个窗口就过去了 —— 之后前端再怎么点都下不回来。
 *   所以落不下来时必须**记到磁盘**，由服务端自己按退避重试，不依赖前端是否还开着。
 *
 * 语义:
 *   · 同一个 URL 只排一条（幂等）；落盘文件名由 URL 决定，重试成功也不会产生第二份；
 *   · 退避 10s → 20s → 40s → … 上限 5 分钟；超过 24 小时或 60 次就放弃并留痕（诊断可查）；
 *   · 队列文件写不进去不影响落盘本身（诊断/补偿是旁路）。
 */
const LOCALIZE_QUEUE_FILE = () => path.join(P.dataDir, 'localize-queue.json')
const LOCALIZE_GIVEUP_MS = 24 * 3600_000
const LOCALIZE_MAX_TRIES = 60

let LOCALIZE_Q = { pending: [], stats: { done: 0, givenUp: 0 } }
let localizeQueueLoaded = false

function loadLocalizeQueue() {
  if (localizeQueueLoaded) return LOCALIZE_Q
  localizeQueueLoaded = true
  try {
    const j = JSON.parse(fs.readFileSync(LOCALIZE_QUEUE_FILE(), 'utf-8'))
    LOCALIZE_Q = {
      pending: Array.isArray(j.pending) ? j.pending.filter((x) => x && /^https?:\/\//i.test(String(x.url || ''))) : [],
      stats: { done: Number(j?.stats?.done) || 0, givenUp: Number(j?.stats?.givenUp) || 0 },
    }
  } catch { LOCALIZE_Q = { pending: [], stats: { done: 0, givenUp: 0 } } }
  return LOCALIZE_Q
}

let localizeSaveTimer = null
function writeLocalizeQueueNow() {
  try {
    const f = LOCALIZE_QUEUE_FILE()
    fs.mkdirSync(path.dirname(f), { recursive: true })
    const tmp = f + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(LOCALIZE_Q, null, 2), 'utf-8')
    fs.renameSync(tmp, f)
  } catch (e) { log('[localize] 队列落盘失败(不影响重试):', e?.message ?? e) }
}
/**
 * @param immediate true = 立刻同步写盘。
 *
 * ⚠️ 2026-10-30 实测踩到：原来一律 800ms 后合写，**新进队**也走这条 —— 用户点完生成就关程序
 *   （或被任务管理器结束），这 800ms 里的排队项直接蒸发，"落不下来"变成"永远落不下来"。
 *   所以规则改成：**进队立刻写**（关键路径，必须落地），出队/退避才合并写。
 */
function saveLocalizeQueue({ immediate = false } = {}) {
  if (immediate) {
    if (localizeSaveTimer) { clearTimeout(localizeSaveTimer); localizeSaveTimer = null }
    writeLocalizeQueueNow()
    return
  }
  /** 合并写: 一批重试会连续改数组, 800ms 内的多次改动只写一次盘 */
  if (localizeSaveTimer) return
  localizeSaveTimer = setTimeout(() => {
    localizeSaveTimer = null
    writeLocalizeQueueNow()
  }, 800)
  if (localizeSaveTimer.unref) localizeSaveTimer.unref()
}

/** 排一条待落盘（同一个 URL 不重复排；已经排过就只刷新时间） */
function localizeQueueAdd(url, reason = '') {
  const u = String(url || '')
  if (!/^https?:\/\//i.test(u)) return
  const q = loadLocalizeQueue()
  const hit = q.pending.find((x) => x.url === u)
  if (hit) { hit.lastSeeAt = Date.now(); if (reason) hit.lastError = String(reason).slice(0, 300); saveLocalizeQueue(); return }
  q.pending.push({
    url: u, firstAt: Date.now(), lastAt: 0, nextAt: Date.now() + 10_000,
    tries: 0, lastError: String(reason || '').slice(0, 300),
  })
  /** 进队是关键路径：必须立刻落盘，程序被强杀也要能接着补 */
  saveLocalizeQueue({ immediate: true })
}

/** 这个 URL 是否已经落过盘（给"打开历史"用：命中就直接把记录换成本地地址） */
function localizeLookup(url) {
  const u = String(url || '')
  if (!/^https?:\/\//i.test(u)) return ''
  const hash = createHash('sha1').update(u).digest('hex').slice(0, 24)
  for (const dir of assetRoots()) {
    try {
      const hit = fs.readdirSync(dir).find((f) => f.startsWith(hash + '.'))
      if (hit) return `/api/assets/file?name=${encodeURIComponent(hit)}`
    } catch { /* 下一个目录 */ }
  }
  return ''
}

/** 走一轮：把到期的待落盘项挨个试一遍 */
async function localizeQueueTick() {
  const q = loadLocalizeQueue()
  if (!q.pending.length) return
  const now = Date.now()
  for (const it of [...q.pending]) {
    if (it.nextAt > now) continue
    /** 先看是不是已经被别的路径（前端调用 / 上次重试）落好了 —— 落好了就直接出队 */
    const have = localizeLookup(it.url)
    if (have) {
      q.pending = q.pending.filter((x) => x !== it)
      q.stats.done += 1
      log(`[localize] 重试队列: 已存在本地副本，出队 ${it.url.slice(0, 80)}`)
      saveLocalizeQueue()
      continue
    }
    it.tries += 1
    it.lastAt = Date.now()
    const r = await downloadRemoteToAssets(it.url, { timeoutMs: 120_000 }).catch((e) => ({ ok: false, msg: String(e?.message ?? e) }))
    if (r.ok) {
      q.pending = q.pending.filter((x) => x !== it)
      q.stats.done += 1
      log(`[localize] 重试成功: ${r.name}`)
    } else {
      it.lastError = String(r.msg || '下载失败').slice(0, 300)
      const giveUp = it.tries >= LOCALIZE_MAX_TRIES || (Date.now() - (it.firstAt || Date.now())) > LOCALIZE_GIVEUP_MS
      if (giveUp) {
        q.pending = q.pending.filter((x) => x !== it)
        q.stats.givenUp += 1
        log(`[localize] 放弃（${it.tries} 次 / ${it.lastError}）: ${it.url.slice(0, 80)}`)
      } else {
        it.nextAt = Date.now() + Math.min(300_000, 10_000 * Math.pow(2, Math.min(5, it.tries)))
      }
    }
    /** 出队（无论是成是弃）立刻写，免得重启后又去重试已经处理完的项 */
    saveLocalizeQueue({ immediate: r.ok === true })
  }
}

/**
 * 服务端"把这条云端产物落到本地"的统一出口。
 *
 * @param remote 远端地址（非 http 原样返回，例如 dataURL / 本地静态地址）
 * @param budgetMs 这一次愿意等多久（云端出图时用户本来就在等，给 20s；后台补时给长一点）
 * @returns {{url:string, remote:string, localized:boolean, pending:boolean, reason:string}}
 */
async function localizeReturnUrl(remote, { budgetMs = 20_000 } = {}) {
  const u = String(remote || '')
  if (!/^https?:\/\//i.test(u)) return { url: u, remote: '', localized: true, pending: false, reason: '' }
  const have = localizeLookup(u)
  if (have) return { url: have, remote: u, localized: true, pending: false, reason: '' }
  const r = await downloadRemoteToAssets(u, { timeoutMs: budgetMs }).catch((e) => ({ ok: false, msg: String(e?.message ?? e) }))
  if (r.ok && r.url) return { url: r.url, remote: u, localized: true, pending: false, reason: '' }
  /** 落不下来 → 进持久化队列，服务端自己接着试（不靠前端记着） */
  localizeQueueAdd(u, r.msg)
  return { url: u, remote: u, localized: false, pending: true, reason: String(r.msg || '下载失败') }
}

/** 落盘结果查询（GET 单条 / POST 批量）—— 见路由处的说明 */
async function handleAssetsLocalizedLookup(req, res) {
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url ?? '', 'http://x').searchParams.get('url') || ''
      const local = localizeLookup(url)
      const inQueue = !!loadLocalizeQueue().pending.find((x) => x.url === String(url))
      return sendJson(res, 200, { ok: true, url: local, pending: !local && inQueue })
    }
    if (req.method === 'POST') {
      const body = await readBody(req, res)
      const urls = Array.isArray(body.urls) ? body.urls.slice(0, 300).map(String) : []
      const map = {}
      let pending = 0
      for (const u of urls) {
        if (!/^https?:\/\//i.test(u)) continue
        const local = localizeLookup(u)
        if (local) { map[u] = local; continue }
        pending += 1
        /** 老记录里还是远端链接的，顺手排进队列 —— 链接可能还没过期，服务端会接着试 */
        localizeQueueAdd(u, '打开历史时仍在远端')
      }
      return sendJson(res, 200, { ok: true, map, pending })
    }
    return sendJson(res, 405, { ok: false, msg: '这个接口只认 GET / POST' })
  } catch (e) {
    sendJson(res, 500, { ok: false, msg: String(e?.message ?? e) })
  }
}

async function handleAssetsLocalize(req, res) {
  try {
    const body = await readBody(req, res)
    const url = String(body.url || '')
    // ── 云端产物(https 远端链接) → 下载到本地素材库 ──
    if (/^https?:\/\//i.test(url)) {
      /**
       * defer = 只要"收下这件事"，不占住这次请求：
       *   大文件/慢链路时前端不必把请求吊着，服务端排队自己下（关掉程序也在队列里）。
       */
      if (body.defer === true) {
        const have = localizeLookup(url)
        if (have) return sendJson(res, 200, { ok: true, url: have, cached: true })
        localizeQueueAdd(url, '前端选择延后落盘')
        return sendJson(res, 200, { ok: true, pending: true })
      }
      const r = await downloadRemoteToAssets(url)
      if (!r.ok) {
        /** 失败也排进队列 —— 这正是"底线"：这一次下不动，不代表以后也下不动 */
        localizeQueueAdd(url, r.msg)
        return sendJson(res, r.status || 500, { ok: false, msg: r.msg || '下载失败', url, pending: true })
      }
      return sendJson(res, 200, { ok: true, url: r.url, name: r.name, bytes: r.bytes, cached: !!r.cached })
    }
    const parsed = resolveOutputFile(url)
    if (!parsed) {
      return sendJson(res, 400, { ok: false, msg: '无法解析的产物地址(支持 /comfy/view、/kear/view、/indextts/audio)', url })
    }
    if (!fs.existsSync(parsed.abs)) {
      return sendJson(res, 404, { ok: false, msg: '产物文件不存在(后端可能未启动或已被清理)', url, file: parsed.abs })
    }
    /**
     * ⚠️ 名字必须跟着**这一份文件**走, 不能只跟 URL 走 (2026-09-21 修用户实测的"选 1080P 出 480")。
     *   URL 里的 filename 是 `Canvas_Krea2_<卡片id>_<序号>.png`: 卡片 id 跨项目会重名,
     *   后端重启后序号又从 00001 开始 —— 同一个 URL 会指向另一张完全不同的图。
     *   把源文件的 **大小 + mtime** 一起参与哈希: 重复本地化仍幂等, 文件被重新生成就一定换新名字。
     */
    const srcStat = fs.statSync(parsed.abs)
    const hash = createHash('sha1')
      .update(`${url}|${srcStat.size}|${Math.round(srcStat.mtimeMs)}`)
      .digest('hex').slice(0, 24)
    const ext = parsed.ext || '.bin'
    /** 按这份文件的类型落到对应目录(图片/视频/音频可分开配) */
    const target = assetPathFor(hash + ext)
    if (!fs.existsSync(target)) {
      fs.copyFileSync(parsed.abs, target)
    }
    const name = path.basename(target)
    sendJson(res, 200, { ok: true, url: `/api/assets/file?name=${encodeURIComponent(name)}` })
  } catch (e) {
    sendJson(res, 500, { ok: false, msg: '素材本地化失败', detail: String(e) })
  }
}

// ---------------------------------------------------------------- 模型包"一次到位"安装
//
// 用户要求 (2026-09-16): 客户不可能有耐心去"解压→找对那一层→搬进 backends"。
// 所以做成: 选一个**目录** → 程序自动认领里面所有模型包 → 解压 → 把组件归位到 <模型目录>\
// → 刷新 models.manifest.json → 卡片变绿。全程有进度可查。
//
// 关键点(都是踩过的坑):
//   * 解压必须用自带的 7z.exe(程序包内置), 不能要求客户装 7-Zip;
//   * 解压到**临时目录**, 成功才搬, 失败不影响现有安装;
//   * 组件要在**任意深度**里找 —— 解压软件多套一层同名文件夹是常态;
//   * 搬动用"同盘 rename", 跨盘才退化成复制(耗时, 会提示)。

let installTask = null

/**
 * 7z 退出码 → 人话。
 *
 * 为什么单独做 (2026-09-16 用户报"安装图片模型时出现退出码 2"): 以前只把数字抛给用户,
 * 谁也不知道 2 是什么意思。7z 的码其实很固定:
 *   0=正常 / 1=有警告(个别文件跳过) / 2=**致命错误: 打不开或写不进去** / 7=命令行错误 /
 *   8=内存不足 / 255=被中断
 * 而"打不开"实测(本机用 7z 22.01 复现)只有几种原因, 说清楚用户自己就能定位。
 */
function sevenZExitHint(code) {
  switch (code) {
    case 1: return '有警告(个别文件被跳过, 通常不影响使用)'
    case 2: return '7z 致命错误: 包打不开或写不进去'
    case 7: return '7z 命令行错误(参数不对, 一般不会出现)'
    case 8: return '内存不足'
    case 255: return '被中断(用户取消或进程被杀)'
    default: return code == null ? '进程被异常结束' : `未知退出码 ${code}`
  }
}

/**
 * 用 7z 的**列表**模式预检一个包: 只读文件头, 大包也是秒级。
 * 返回 { ok, code, totalBytes, msg }:
 *   · ok=false 时 msg 是 7z 自己的原话(例如 "Unexpected end of archive"), 直接展示给用户;
 *   · totalBytes = 解压后的总大小, 用来做空间预检。
 */
function probe7zArchive(sevenZ, pack) {
  return new Promise((resolve) => {
    let totalBytes = 0
    let tail = []
    let buf = ''
    const eat = (d) => {
      buf += String(d)
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const l of lines) {
        const m = /^Size = (\d+)$/.exec(l)
        if (m) totalBytes += Number(m[1])
        tail.push(l)
        if (tail.length > 60) tail.shift()
      }
    }
    let child
    try {
      child = spawn(sevenZ, ['l', '-slt', '--', pack], { windowsHide: true })
    } catch (e) {
      return resolve({ ok: false, code: null, totalBytes: 0, msg: String(e?.message ?? e) })
    }
    child.stdout?.on('data', eat)
    child.stderr?.on('data', eat)
    child.on('error', (e) => resolve({ ok: false, code: null, totalBytes: 0, msg: String(e?.message ?? e) }))
    child.on('exit', (code) => {
      // 只保留"短句"错误 —— 7-Zip 的报错里常带一整行完整路径(含中文还可能被控制台按 GBK 输出),
      // 直接甩给用户又长又乱; 真正有用的是 "Is not archive" / "Unexpected end of archive" 这种。
      // 只留"短句"错误: 7-Zip 的报错行里常带完整路径(还要过一遍控制台编码),
      // 甩给用户又长又乱; 真正有用的是 "Is not archive" / "Unexpected end of archive" 这种。
      const errs = tail
        .map((l) => l.trim())
        .filter((l) => l && !/[A-Za-z]:\\/.test(l) && l.length <= 120
          && /ERROR|Can ?not|Is not|Unexpected|not enough|CRC|archive/i.test(l))
        .slice(-2)
      const fallback = code === 2 ? '文件不是有效的压缩包(常见于没下载完 / 分卷缺失)' : sevenZExitHint(code)
      resolve({ ok: code === 0, code, totalBytes, msg: (errs.length ? errs.join(' | ') : fallback).slice(0, 160) })
    })
  })
}

/** 目标盘剩余空间(字节); 拿不到返回 null */
function freeSpaceBytes(dir) {
  try {
    const st = fs.statfsSync(dir)
    return Number(st.bavail) * Number(st.bsize)
  } catch { return null }
}

/** 目录选择框(浏览器/开发态兜底): Electron 装机版优先走主进程原生 dialog。 */
async function handlePickDir(req, res) {
  try {
    // ⚠️ 不能直接读 PowerShell 的标准输出拿路径: PS 5.1 往管道写的是**系统代码页(GBK)**,
    //    Node 按 UTF-8 解 → 中文路径变乱码 → 后面 readdir 全失败(表现为"没识别到文件夹里的 7z")。
    //    所以让它把结果写成 **UTF-8 文件**, 我们再读文件 —— 编码问题一次性绕开。
    // 输出文件放临时目录: 程序目录可能是只读/受限的(Program Files、企业策略), 写不进去会让
    // “选了目录却被当成取消”再次出现。临时目录始终可写。
    const outFile = path.join(os.tmpdir(), `aics-pick-dir-${process.pid}-${Date.now()}.txt`)
    try { fs.rmSync(outFile, { force: true }) } catch { /* ignore */ }
    const psPath = outFile.replace(/'/g, "''")
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$d.Description = "选择模型包文件夹或已解压的模型目录"',
      `if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [System.IO.File]::WriteAllText('${psPath}', $d.SelectedPath, (New-Object System.Text.UTF8Encoding($false))) }`,
    ].join('; ')
    // ⚠️ 异步等待: 用同步版会让整个本地服务在对话框打开期间停住(状态轮询全断)。
    const run = await execCaptureAsync('powershell', ['-NoProfile', '-STA', '-Command', ps], { timeout: 300000 })
    const dir = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf-8').trim() : ''
    try { fs.rmSync(outFile, { force: true }) } catch { /* ignore */ }
    if (dir) return sendJson(res, 200, { ok: true, canceled: false, dir })
    if (!run.ok) {
      const why = String(run.stderr || run.stdout || '').trim().split(/\r?\n/).slice(-2).join(' | ').slice(0, 300)
      return sendJson(res, 500, {
        ok: false,
        canceled: false,
        msg: `打不开文件夹选择框${run.status != null ? `（PowerShell 退出码 ${run.status}）` : ''}${why ? `：${why}` : ''}`,
      })
    }
    return sendJson(res, 200, { ok: false, canceled: true, dir: '' })
  } catch (e) {
    return sendJson(res, 500, { ok: false, msg: String(e.message || e) })
  }
}

const COMPONENT_DIRS = [
  { name: 'indextts-tts', key: 'indextts', marker: 'server.py' },
  { name: 'comfyui-kear2', key: 'kear', marker: 'python_embeded/python.exe' },
  { name: 'h3', key: 'h3', marker: 'payload/backend/ComfyUI-H3/python_embeded/python.exe' },
  /** 选装第 4 路(2026-09-24): 单独一个包, 谁想用谁装; 布局与其它三路不同(env\ 而不是 python_embeded\) */
  { name: 'comfyui-qwen', key: 'qwen', marker: 'env/python.exe' },
]

/**
 * 每一路对应哪个包 (安装界面按卡片展示)。
 * 前三个是"图片/视频/音频"三个主包; qwen 是**选装包** —— 它跟 kear 同属生图,
 * 但按用户要求(2026-09-24 "模型包为选装, 不默认打包进入原来的生图包")单列一张卡。
 */
const TIER_OF_KEY = { kear: 'image', h3: 'video', indextts: 'voice', qwen: 'qwen' }

/** 从包名猜层: 我们自己的包是 漫客_模型包_<tier>_v*.7z; 猜不出来再看包内组件 */
function guessTierByName(file) {
  const n = path.basename(file).toLowerCase()
  // 选装包先判: 它名字里只有 qwen, 不会被下面的 image 规则(生图/图片/kear)吃掉
  if (/qwen/.test(n)) return 'qwen'
  if (/image|kear|生图|图片/.test(n)) return 'image'
  if (/video|h3|视频/.test(n)) return 'video'
  if (/voice|tts|audio|语音|音频/.test(n)) return 'voice'
  return ''
}

/** 这个包里是哪一层? 名字认不出就列一次包内结构(只读头部, 很快) */
function detectTierOfPack(file, sevenZ) {
  const byName = guessTierByName(file)
  if (byName) return byName
  try {
    const vol = /\.7z\.001$/i.test(file) ? file : file
    const list = execCapture(sevenZ, ['l', vol], { timeout: 120000 })
    if (/comfyui-qwen/i.test(list)) return 'qwen'
    if (/indextts-tts/i.test(list)) return 'voice'
    if (/comfyui-kear2/i.test(list)) return 'image'
    if (/ComfyUI-H3/i.test(list)) return 'video'
  } catch { /* 列不出来就返回空 */ }
  return ''
}

/**
 * 同一层留了多个版本时，只取**最新的一份**。
 * findModelPackFiles 已按 mtime 倒序；这里保持“先遇到的那份”即可。
 */
function latestPackPerTier(packs, sevenZ) {
  const byTier = new Map()
  for (const pack of packs) {
    const tier = detectTierOfPack(pack, sevenZ)
    if (tier && !byTier.has(tier)) byTier.set(tier, pack)
  }
  return byTier
}

/** 已装判定: 组件关键文件在不在(与 /api/models 同一套判据) */
function tierInstalled(tier) {
  const c = MODEL_COMPONENTS.find((x) => TIER_OF_KEY[x.key] === tier)
  if (!c) return false
  /**
   * ⚠️ 2026-10-12: 走 `resolveComponentDir`(标准布局 → 有界深搜认"装歪") —— 与界面那份 `/api/models`
   *   和启动用的根目录**同一个口径**, 避免"面板说装了、这里说没装"。
   */
  const found = resolveComponentDir(P.backendsRoot, c)
  return found.kind !== 'missing'
}

/**
 * 只**检测**不安装: 告诉界面"这个目录里有哪些层、哪层已经装了" —— 用户确认要装什么再动手。
 * (2026-09-16 用户要求: 不能检测到就直接装, 要有三张卡片让客户自己选)
 */
async function handleModelsScan(req, res) {
  const body = await readBody(req, res)
  const dir = String(body.dir || '').trim()
  if (!dir || !fs.existsSync(dir)) return sendJson(res, 400, { ok: false, msg: '请选择一个存在的文件夹' })
  const sevenZ = path.join(P.appRoot, '7z.exe')
  let all = []
  try { all = fs.readdirSync(dir) } catch { /* ignore */ }
  /**
   * 2026-10-25 修复: 同时认两种用户现场 ——
   *   ① 压缩包（可以在所选目录的下一两层，不再只认第一层）；
   *   ② 已经解压好的模型目录（h3 / comfyui-kear2 / indextts-tts / comfyui-qwen）。
   * 以前只 readdir 第一层并过滤 .7z/.zip，选到“已解压模型”或“包在子目录里”都会四张卡全空。
   */
  const archives = findModelPackFiles(dir)
  const existing = findExistingModelRoot(dir)
  if (!archives.length && !existing) {
    const sample = all.slice(0, 8).join(', ')
    return sendJson(res, 400, {
      ok: false,
      code: 'model-not-found',
      dir,
      files: all.length,
      msg: '这个文件夹里没有找到模型包，也没有找到已解压的模型。'
        + '\n请选择：① 放有 .7z / .zip 的下载目录（可在外层文件夹），或 ② 含 h3、comfyui-kear2、indextts-tts 的模型目录。'
        + `\n当前文件夹：${dir}`
        + `\n我看到的是：${sample || '(空目录)'}`,
    })
  }
  const packsByTier = latestPackPerTier(archives.map((p) => p.path), sevenZ)
  /**
   * 四张卡片: 图片 / 视频 / 音频 三个主包 + 一个**选装**包(Qwen-Image-2.1)。
   * optional 标记给界面: 选装包默认**不勾选**, 且没下这个包也不算"缺"。
   */
  const SCAN_TIERS = [
    { tier: 'image', optional: false },
    { tier: 'video', optional: false },
    { tier: 'voice', optional: false },
    { tier: 'qwen', optional: true },
  ]
  const tiers = SCAN_TIERS.map(({ tier, optional }) => {
    if (!packsByTier.size) {
      /** 已解压模式: “装没装”按**所选目录里真正存在的组件**算，而不是当前 backendsRoot */
      const key = Object.keys(TIER_OF_KEY).find((k) => TIER_OF_KEY[k] === tier)
      const hit = existing?.components.find((c) => c.key === key) ?? null
      return {
        tier, installed: !!hit, pack: null, optional,
        existing: !!hit, existingPath: hit?.path ?? null,
      }
    }
    const pack = packsByTier.get(tier) ?? null
    let found = null
    if (pack) {
      const st = fs.statSync(pack)
      found = { name: path.basename(pack), bytes: st.size }
    }
    return { tier, installed: tierInstalled(tier), pack: found, optional }
  })
  return sendJson(res, 200, {
    ok: true,
    dir,
    files: all.length,
    mode: packsByTier.size ? 'archives' : 'existing',
    root: existing?.root ?? null,
    existingComponents: existing?.components ?? [],
    ambiguousExistingRoot: existing?.ambiguous ?? false,
    archives: archives.map((x) => ({ name: x.name, relative: x.relative, bytes: x.bytes })),
    tiers,
  })
}

/** 在解压结果里"任意深度"找组件顶层目录 —— 多套一层也能认领 */
function findComponents(root, depth = 0, hit = {}) {
  if (depth > 4) return hit
  let ents = []
  try { ents = fs.readdirSync(root, { withFileTypes: true }) } catch { return hit }
  for (const e of ents) {
    if (!e.isDirectory()) continue
    const p = path.join(root, e.name)
    const c = COMPONENT_DIRS.find((x) => x.name.toLowerCase() === e.name.toLowerCase())
    if (c && !hit[c.key]) {
      const ok = fs.existsSync(path.join(p, ...c.marker.split('/')))
      if (ok) { hit[c.key] = { ...c, path: p }; continue }
    }
    findComponents(p, depth + 1, hit)
  }
  return hit
}

/**
 * 重启一路后端(**不退出软件**, 不碰别的路)。
 *
 * 两个调用点共用这一份实现 (以前只有 /api/backends/restart 里那一坨):
 *   · 用户点顶栏「模型」里的「重启」;
 *   · **模型包安装完成后自动重启**(2026-10-01, 见 handleModelsInstall 尾部)。
 *
 * ⚠️ 调用方负责先判"忙不忙": 正在生成时重启会把当前任务作废
 *   (两个调用点都有 comfyQueueBusy / otherBackendBusy 的守卫)。
 */
async function restartBackend(kind, reason = '用户点击了「重启」') {
  await noteStop(kind, reason)
  BACKEND_STOPPED_AT.set(kind, Date.now())   // 见 BACKEND_STOPPED_AT: 刚停完的端口残留要按残留处理
  const rec = BACKEND_PROCS.get(kind)
  if (rec && !rec.exited) {
    rec.stopping = true   // 主动重启, 不算崩溃
    try { rec.child.kill() } catch { /* ignore */ }
    killTree(rec.pid, true)
    await new Promise((s) => setTimeout(s, 1200))
    rec.exited = true
    BACKEND_PROCS.delete(kind)
  }
  invalidateBackendIdentity(kind)
  return launchBackend(kind)
}

async function handleModelsInstall(req, res) {
  const body = await readBody(req, res)
  const dir = String(body.dir || '').trim()
  if (!dir || !fs.existsSync(dir)) return sendJson(res, 400, { ok: false, msg: '请选择一个存在的文件夹' })
  if (installTask?.running) return sendJson(res, 409, { ok: false, msg: '上一个安装任务还没跑完', task: installTask })

  const sevenZ = path.join(P.appRoot, '7z.exe')
  if (!fs.existsSync(sevenZ)) return sendJson(res, 500, { ok: false, msg: `程序目录里缺少 7z.exe（当前版本可能还没有内置解压），路径: ${sevenZ}` })

  // 扫描: .7z / .7z.001(分卷起始) / .zip；与 /api/models/scan 共用同一套有界子目录搜索
  let all = []
  try { all = fs.readdirSync(dir) } catch { /* ignore */ }
  const archives = findModelPackFiles(dir)
  /** 每层只用最新版本的包，避免同一目录里 v1.1/v1.2 都留着时重复解压 */
  const packsByTier = latestPackPerTier(archives.map((p) => p.path), sevenZ)
  // 只装用户**勾选**的层; 已装的那层直接跳过(客户一包包下载、全部下完再点一次也不会重复解压)
  const wantTiers = Array.isArray(body.tiers) && body.tiers.length ? body.tiers.map((t) => String(t)) : null
  const selected = wantTiers
    ? wantTiers.map((tier) => packsByTier.get(tier)).filter(Boolean)
    : [...packsByTier.values()]
  if (!selected.length) {
    const existing = findExistingModelRoot(dir)
    if (existing && !archives.length) {
      return sendJson(res, 409, {
        ok: false,
        code: 'already-extracted',
        dir,
        root: existing.root,
        msg: '这个目录里的模型已经解压好了，不需要重新安装。请点「使用这个目录」，程序会直接切换到它。',
      })
    }
    // 把"我到底看到了什么"一起返回 —— 一眼分清是选错目录、还是路径编码不对(实测就踩过后者)
    const sample = all.slice(0, 8).join(', ')
    return sendJson(res, 400, {
      ok: false,
      msg: wantTiers
        ? '你勾选的模型层在所选目录及其子目录里没有对应的压缩包'
        : `所选目录及其子目录里没有 .7z / .zip 模型包。我看到的是: ${sample || '(空目录)'}`,
      dir,
      files: all.length,
    })
  }

  /**
   * 记一份"这次装的是哪几个包"到 data/models-install.json —— 诊断包靠它回答
   *   "客户那份包多大、和官方一样吗"(2026-10-30: 没有这条记录时只能靠猜)。
   * 先写开始, 结束时(见下方 finally)再把结果补上; 写不进去不影响安装。
   */
  const installRec = {
    at: Date.now(),
    dir,
    sevenZ: sevenZVersionText(),
    packs: selected.map(packMetaOf),
    results: [],
    driveFreeBefore: drivesFreeText([dir]),
  }
  saveInstallRecord(installRec)

  installTask = {
    running: true, phase: '准备', current: 0, total: selected.length, log: [], results: [],
    /** 装完自动重启了哪几路 / 哪几路因为正在出图不敢重启(界面据此说"能不能直接点生成") */
    autoRestarted: [], needsManualRestart: [],
    startedAt: new Date().toISOString(),
  }
  const T = installTask
  /**
   * 安装日志上限 (代码评估报告 P1: "installTask.log 无上限")。
   * 整个安装过程只增不减, 而且 installTask 常驻内存给 /api/models/install-status 轮询 ——
   * 逐包解压 120GB 时能攒出上千条。这里只保留最近 500 条(前端展示也就几十条)。
   */
  const INSTALL_LOG_MAX = 500
  const say = (m) => {
    T.log.push(m)
    if (T.log.length > INSTALL_LOG_MAX) T.log.splice(0, T.log.length - INSTALL_LOG_MAX)
    log('[install] ' + m)
  }

  const installJob = (async () => {
    const tmpRoot = path.join(P.appRoot, '_models_incoming')
    fs.mkdirSync(tmpRoot, { recursive: true })
    /** 这次真正**新归位**的组件 key(用来决定装完要重启哪几路) */
    const installedKeys = []
    for (const pack of selected) {
      const base = path.basename(pack)
      T.current++
      // 已装过的层直接跳过 —— 关键是**在解压之前**就跳过: 客户分几次下载、最后又点一次时,
      // 不该把 19~59GB 再解压一遍(实测用户就是这么被坑的)。
      const packTier = detectTierOfPack(pack, sevenZ)
      if (packTier && tierInstalled(packTier)) {
        say(`${base}: ${packTier} 这层已经装好了, 跳过`)
        T.results.push({ pack: base, ok: true, skipped: true, moved: [], msg: '已安装，跳过' })
        continue
      }
      T.phase = `解压 ${base}`
      const tmp = path.join(tmpRoot, base.replace(/\.(7z(\.001)?|zip)$/i, ''))
      try {
        // ① 预检: 这个包到底能不能打开(只读头, 秒级) —— 打不开就别白等几分钟再报"退出码 2"
        T.phase = `检查 ${base}`
        say(`检查 ${base} …`)
        /**
         * 包体积也写进安装日志(2026-10-30): CRC 失败时第一件事就是"这份和官方一样大吗",
         *   让日志自己带着答案, 别等客户再导一次诊断包。
         */
        try {
          const meta = packMetaOf(pack)
          if (meta.bytes != null) {
            const verdict = meta.official != null && meta.bytes !== meta.official
              ? `（官方 ${meta.official} 字节, 这份${meta.bytes > meta.official ? '多' : '少'}了 ${Math.abs(meta.bytes - meta.official)} 字节 → 拷贝没完成/已损坏）`
              : (meta.official != null ? '（与官方体积一致）' : '')
            say(`${base}: ${meta.bytes} 字节${verdict}`)
          }
        } catch { /* 读不到大小不影响安装 */ }
        const probe = await probe7zArchive(sevenZ, pack)
        if (!probe.ok) {
          const why = `这个包打不开${probe.msg ? `（7z: ${probe.msg}）` : ''}。`
            + '常见原因: ① 没下载完 / 拷贝中断（文件比源小） ② 分卷没下齐（.7z.001/.002/… 必须同名放一起） '
            + '③ 文件被改过或根本不是压缩包 ④ 网盘/杀软拦截读取。请重新校验并重传这个包。'
          say(`${base}: ${why}`)
          T.results.push({ pack: base, ok: false, msg: why })
          continue
        }
        // ② 空间预检: 解压到 <程序目录>\_models_incoming, 所以看那个盘的剩余空间
        if (probe.totalBytes > 0) {
          const need = probe.totalBytes
          const free = freeSpaceBytes(P.appRoot)
          if (free !== null && free < need * 1.02 + 1_500_000_000) {
            const why = `磁盘空间不足: 解压这个包需要约 ${(need / 1073741824).toFixed(1)}GB, `
              + `${path.parse(P.appRoot).root} 只剩 ${(free / 1073741824).toFixed(1)}GB。`
              + '请清理磁盘, 或把程序装到空间更大的盘上再装模型。'
            say(`${base}: ${why}`)
            T.results.push({ pack: base, ok: false, msg: why })
            continue
          }
        }
        fs.rmSync(tmp, { recursive: true, force: true })
        fs.mkdirSync(tmp, { recursive: true })
        say(`解压 ${base} → 临时目录（大包要几分钟，请稍等）`)
        // ⚠️ 必须用 spawn(异步): 早先这里用 execFileSync, 它**阻塞事件循环** ——
        //    解压 12GB 的几分钟里整个本地服务都卡住, 界面直接假死(用户实测"软件直接卡住了")。
        //    同时用 -bsp1 拿 7z 自己的百分比进度, 让界面有具体数字可看。
        await new Promise((resolve, reject) => {
          const child = spawn(sevenZ, ['x', '-y', `-o${tmp}`, pack, '-bsp1', '-bso0'], { windowsHide: true })
          const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } reject(new Error('解压超时(60分钟)')) }, 3600_000)
          let buf = ''
          child.stdout?.on('data', (d) => {
            buf += String(d)
            const lines = buf.split(/\r|\n/)
            buf = lines.pop() ?? ''
            for (const l of lines) {
              const m = /(\d{1,3})%/.exec(l)
              if (m) T.phase = `解压 ${base} · ${m[1]}%`
            }
          })
          // 7z 的报错走 stderr, 以前完全没接 —— 出问题时只有一串数字, 没人知道为什么.
          let errBuf = ''
          child.stderr?.on('data', (d) => {
            errBuf += String(d)
            if (errBuf.length > 4000) errBuf = errBuf.slice(-4000)
          })
          child.on('error', (e) => { clearTimeout(timer); reject(e) })
          child.on('exit', async (code) => {
            clearTimeout(timer)
            if (code === 0) return resolve()
            const detail = errBuf.split(/\r?\n/).map((s) => s.trim())
              .filter((s) => s && !/^\d{1,3}%/.test(s)).slice(-3).join(' | ')
            /**
             * ★ 2026-10-30：CRC 失败时**自动算一次 SHA256**并与官方比对。
             *
             * 客户那台机器的四个包体积全部与官方逐字节一致，解压却全部 CRC Failed ——
             * 不带上 SHA256，支持侧只能靠猜"是包坏了还是机器坏了"。现在失败当场给出结论：
             *   一致 → 包是好的，是这台机器算错了（内存/CPU）；不一致 → 包在拷贝时坏了。
             * 代价：失败后多读一遍这个文件（45GB 约一分钟），只在失败时才做。
             */
            let shaNote = ''
            if (/CRC Failed|Data Error/i.test(errBuf)) {
              T.phase = `校验 ${base}（算 SHA256，判断是包坏了还是机器算错）…`
              say(`${base}: 检测到 CRC 校验失败，正在算 SHA256 与官方比对（大包约 1 分钟）…`)
              shaNote = await packShaVerdict(pack).catch(() => '')
              if (shaNote) {
                T.phase = `校验 ${base}（已出判定）`
                for (const line of String(shaNote).split('\n')) say(`  判定: ${line}`)
              }
            }
            reject(new Error(`解压失败(${sevenZExitHint(code)}${code != null ? ` · 7z 退出码 ${code}` : ''})`
              + (detail ? `：${detail}` : '')
              + (code === 2 ? '。多半是包不完整、磁盘写满, 或路径太长/被安全软件拦截。' : '')
              + (shaNote ? `\n【自动判定】${shaNote}` : '')))
          })
        })
        const found = findComponents(tmp)
        const keys = Object.keys(found)
        if (!keys.length) {
          T.results.push({ pack: base, ok: false, msg: '包里没找到可认领的模型组件（h3 / comfyui-kear2 / indextts-tts / comfyui-qwen）' })
          say(`${base}: 没有可认领的组件，跳过`)
          continue
        }
        T.phase = `归位 ${base}`
        const moved = []
        for (const k of keys) {
          const c = found[k]
          const dst = path.join(P.backendsRoot, c.name)
          if (fs.existsSync(dst)) { moved.push(`${c.name}(已存在, 跳过)`); continue }
          try {
            fs.renameSync(c.path, dst)                     // 同盘: 瞬间; 跨盘会抛 EXDEV
            moved.push(c.name)
            installedKeys.push(k)
          } catch {
            say(`${c.name}: 跨盘移动，正在复制（这一步慢）`)
            fs.cpSync(c.path, dst, { recursive: true })
            fs.rmSync(c.path, { recursive: true, force: true })
            moved.push(`${c.name}(复制)`)
            installedKeys.push(k)
          }
        }
        say(`${base}: 已归位 ${moved.join(', ')}`)
        T.results.push({ pack: base, ok: true, moved })
      } catch (e) {
        T.results.push({ pack: base, ok: false, msg: String(e.message || e) })
        say(`${base}: 失败 ${String(e.message || e)}`)
      } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 临时目录留着不影响 */ }
      }
    }
    // 刷新清单(版本/契约/体积), 让程序立刻认到
    T.phase = '刷新清单'
    try {
      const { buildManifest } = await import('./tools/models.mjs')
      const m = buildManifest(P.backendsRoot, { deep: false })
      fs.writeFileSync(path.join(P.backendsRoot, 'models.manifest.json'), JSON.stringify(m, null, 2) + '\n', 'utf-8')
      say('models.manifest.json 已刷新')
    } catch (e) { say('清单刷新失败(不影响使用): ' + String(e.message || e)) }
    try { fs.rmdirSync(path.join(P.appRoot, '_models_incoming')) } catch { /* 非空就留着 */ }

    /**
     * 装完 → **替用户把正在跑的那几路重启一遍** (2026-10-01 用户: "用户重新安装模型包后,
     *   默认就是去点生成, 但是会显示模型包没有安装或者缺失这种误导, 优化一下")。
     *
     * 为什么必须在这一步做, 而不是丢一句"记得去顶栏重启":
     *   ComfyUI 认得的权重清单是它**启动时扫一遍**的结果 —— 只解压不重启, 点生成照样回
     *   `Value not in list: …safetensors`, 界面就变成了"模型包没装 / 缺文件"。而用户装完的
     *   下一个动作**必然**是点生成, 中间那次"手动重启"从来不会发生。
     *
     * 安全阀:
     *   · 没在跑的那一路不碰(它下次启动自然会扫到新权重);
     *   · 正在生成的那一路不碰(重启会作废当前任务), 只留一句日志提示手动重启。
     */
    if (installedKeys.length) {
      // 刚装完: 之前"缺文件"的体检结论(60 秒缓存)立刻失效, 否则紧接着那次自检还会误判
      modelsHealthCache.clear()
      /** 先探一遍各路现况(在跑吗 / 在出图吗) —— "重启谁"这个决定见 tools/backendrestart.mjs */
      const state = {}
      for (const k of new Set(installedKeys)) {
        if (!BACKENDS[k]) continue
        const rec = BACKEND_PROCS.get(k)
        const running = !!(rec && !rec.exited)
        state[k] = {
          running,
          busy: running
            ? await (k === 'indextts' ? otherBackendBusy(k) : comfyQueueBusy(k)).catch(() => false)
            : false,
        }
      }
      const plan = planInstallRestart(installedKeys, BACKENDS, state)
      for (const label of plan.skipIdle) say(`${label}: 没在运行，下次启动会自动扫到新权重`)
      for (const label of plan.skipBusy) say(`${label}: 正在生成中，装完请到顶栏「模型」手动重启这一路`)
      const done = []
      for (const { kind, label } of plan.restart) {
        T.phase = `重启 ${label}`
        say(`${label}: 重启中（让它重新扫一遍权重清单）…`)
        try {
          const r = await restartBackend(kind, '模型包安装完成，自动重启')
          if (r && r.ok === false) say(`${label}: 重启没成功 —— ${r.msg ?? ''}`)
          else done.push(label)
        } catch (e) {
          say(`${label}: 重启异常 ${String(e.message || e)}`)
        }
      }
      T.autoRestarted = done
      T.needsManualRestart = plan.skipBusy
      if (done.length) {
        log(`[install] 已自动重启: ${done.join('、')} —— 新权重生效, 可以直接点生成`)
        say(`已自动重启：${done.join('、')}（新权重已生效，可以直接点生成）`)
      }
    }
    T.phase = '完成'
  })()
  /**
   * 解锁兜底 (2026-09-20 代码评估报告 P0-7)。
   *
   * 以前这个 IIFE 尾部**没有 catch**: 逐包的 try/catch 只盖住了循环体, 而循环之外的语句
   * (mkdirSync / readdirSync / 刷新清单)一旦抛错(盘满、目录被占用、权限不足 —— 都是装模型
   * 时的常见故障), 就是"未捕获的 Promise 拒绝 + T.running 永远停在 true"。
   * 后果很硬: 之后每次点安装都被 409「上一个安装任务还没跑完」拒绝, 必须重启程序才能恢复,
   * 而用户拿不到任何原因。现在无论如何都会解锁, 并把失败原因写进日志与结果里。
   */
  void installJob.catch((e) => {
    const msg = `安装任务异常中断: ${e && e.message ? e.message : e}`
    say(msg)
    T.results.push({ pack: '(整体)', ok: false, msg })
    T.phase = '失败'
  }).finally(() => {
    T.running = false
    T.finishedAt = new Date().toISOString()
    /** 把结果补进安装记录(诊断包要用): 每个包成没成、为什么不成、装完盘还剩多少 */
    try {
      installRec.results = T.results.map((r) => ({
        pack: r.pack, ok: !!r.ok, skipped: !!r.skipped,
        msg: r.msg ? String(r.msg).slice(0, 600) : '',
      }))
      installRec.finishedAt = Date.now()
      installRec.driveFreeAfter = drivesFreeText([dir])
      saveInstallRecord(installRec)
    } catch { /* 诊断用, 失败不抛 */ }
  })

  return sendJson(res, 200, { ok: true, started: true, packs: selected.map((p) => path.basename(p)) })
}

function handleAssetsFile(req, res) {
  const q = new URL(req.url ?? '', 'http://x').searchParams
  const name = q.get('name') || ''
  if (!name || /[\\/]/.test(name) || name.includes('..')) {
    return sendJson(res, 400, { ok: false, msg: 'bad name' })
  }
  /** 跨目录找: 换过保存位置之后, 老副本在新目录、新副本在自定义目录, 都要能打开 */
  const file = findAssetFile(name)
  if (!file || !serveFile(req, res, file)) {
    sendJson(res, 404, { ok: false, msg: 'file not found' })
  }
}

/**
 * 删除本地素材副本 (2026-09-20 用户要求: "卡片删了素材库里的文件还在" + "历史里没有删除本地文件的功能")
 *
 *   POST /api/assets/delete?name=<hash.ext>   或 body: { names: ["a.png","b.mp4"] }
 *   → { ok, deleted: [...], missing: [...], refused: [...] }
 *
 * 只动 `<数据目录>/assets/` 这一层:
 *   · 名字里带路径分隔符、`..`、空名 → 一律拒绝(不给任何越界机会);
 *   · 文件不存在 → 也算成功(记进 missing), 让前端的"删除"幂等、不报错;
 *   · 只删文件, 不删目录、不递归。
 * 注意: 这是**不可恢复**的删除 —— 前端必须在用户确认后才调它(见历史/素材库的确认弹窗)。
 */
async function handleAssetsDelete(req, res) {
  let names = []
  try {
    const q = new URL(req.url ?? '', 'http://x').searchParams
    const one = q.get('name')
    if (one) names.push(one)
    if (!names.length) {
      const body = await readBody(req, res).catch(() => null)
      if (body && Array.isArray(body.names)) names = body.names.map(String)
    }
  } catch { /* 下面统一按空处理 */ }
  names = names.map((s) => s.trim()).filter(Boolean)
  if (!names.length) return sendJson(res, 400, { ok: false, msg: '没有给出要删除的文件名' })

  const deleted = []; const missing = []; const refused = []
  for (const name of names) {
    if (!name || /[\\/]/.test(name) || name.includes('..')) { refused.push(name); continue }
    /** 跨目录找(默认目录 + 三个自定义目录): 用户换过保存位置, 老副本也要删得掉 */
    const file = findAssetFile(name)
    try {
      if (!file) { missing.push(name); continue }
      // 只删文件(不是目录), 且必须真的在 assets 目录里
      const st = fs.statSync(file)
      if (!st.isFile()) { refused.push(name); continue }
      const inRoots = assetRoots().some((d) => path.dirname(path.resolve(file)) === path.resolve(d))
      if (!inRoots) { refused.push(name); continue }
      fs.unlinkSync(file)
      deleted.push(name)
    } catch (e) {
      refused.push(`${name}(${e?.code || e?.message || 'failed'})`)
    }
  }
  if (deleted.length) log(`[assets] 删除本地文件 ${deleted.length} 个: ${deleted.slice(0, 6).join(', ')}${deleted.length > 6 ? ' …' : ''}`)
  return sendJson(res, 200, { ok: true, deleted, missing, refused })
}

/**
 * POST /api/assets/check   { srcs: ["/api/assets/file?name=…", "/kear/view?…", …] }
 *   → { ok: true, missing: [...], checked: n, unknown: n }
 *
 * 用途 (2026-09-20 用户反馈"素材库里会出现消失的图片的占位图"): 素材列表里那条记录指向的
 *   文件在磁盘上已经没了(被删 / 被清理 / 后端产物没了), 前端就会渲染成一个打不开的破图占位。
 *   这里让服务端一次性判定"哪些地址的文件**真的**不在了", 前端据此把条目摘掉, 不再出现破图。
 *
 * 三条铁律:
 *   ① 只做存在性判定, **永远不删任何东西**(删除是另一个接口, 必须用户确认);
 *   ② 判不了的一律算 unknown —— 断网/后端没起/远端 http(s)/dataURL 绝不能当成"素材丢了";
 *   ③ 一次请求完成整个列表的判定(逐条 existsSync, 不读文件内容, 160 条也只是一瞬)。
 */
async function handleAssetsCheck(req, res) {
  let srcs = []
  try {
    const body = await readBody(req, res)
    if (body && Array.isArray(body.srcs)) srcs = body.srcs.map(String)
  } catch { /* 下面按空列表处理 */ }
  srcs = [...new Set(srcs.map((s) => s.trim()).filter(Boolean))].slice(0, 1000)

  const missing = []
  let checked = 0
  let unknown = 0
  for (const s of srcs) {
    // ① 本地静态副本: /api/assets/file?name=<hash>.<ext>
    if (s.startsWith('/api/assets/file')) {
      let name = ''
      try { name = new URL(s, 'http://x').searchParams.get('name') || '' } catch { /* 落到 unknown */ }
      if (!name || /[\\/]/.test(name) || name.includes('..')) { unknown += 1; continue }
      checked += 1
      /** 跨目录判定: 只要在任一存放目录里就算"还在"(否则换目录后会把素材误判成丢了) */
      if (!findAssetFile(name)) missing.push(s)
      continue
    }
    // ② 还没本地化过的老数据: /comfy/view、/kear/view、/qwen/view、/indextts/audio(用同一套解析器)
    if (/^\/(comfy|kear|indextts|qwen)\//.test(s)) {
      const parsed = resolveOutputFile(s)
      // 解析不出绝对路径(后端目录没配 / 文件已不在) → 保守算 unknown, 不报 missing
      if (!parsed) { unknown += 1; continue }
      checked += 1
      if (!fs.existsSync(parsed.abs)) missing.push(s)
      continue
    }
    // ③ dataURL / blob: / localmedia: / 远端 http(s): 服务端管不着, 交给前端自己兜底
    unknown += 1
  }
  return sendJson(res, 200, { ok: true, missing, checked, unknown })
}

// ---------------------------------------------------------------- 音色库 (IndexTTS)
//
// 音色清单的唯一事实来源是 backends/indextts-tts/voices.json, 而 IndexTTS 后端
// (voice_engine.list_voices / resolve_voice) **每次调用都从磁盘重读**该文件,
// 所以这里直接读写文件即可让改动立刻对语音合成生效 —— 无需重启 8190 后端。
//
//   GET    /api/voices            列出全部音色(含时长/是否有参考音频)
//   POST   /api/voices            {name,audio_b64,gender} 克隆新音色 (转交 8190 做降噪/归一化)
//   PATCH  /api/voices/:id        {name} 重命名
//   DELETE /api/voices/:id        删除音色(同时删掉参考音频文件)
//   GET    /api/voices/:id/audio  试听参考音频 (支持 Range, 便于 <audio> 拖动进度)

const VOICES_MANIFEST = () => path.join(P.indexttsRoot, 'voices.json')
const VOICES_DIR = () => path.join(P.indexttsRoot, 'voices')

function readVoiceManifest() {
  try {
    const j = JSON.parse(fs.readFileSync(VOICES_MANIFEST(), 'utf-8'))
    return Array.isArray(j) ? j : []
  } catch { return [] }
}

function writeVoiceManifest(list) {
  fs.mkdirSync(path.dirname(VOICES_MANIFEST()), { recursive: true })
  fs.writeFileSync(VOICES_MANIFEST(), JSON.stringify(list, null, 2), 'utf-8')
}

/** 只读 wav 头部(4KB)推算时长/采样率, 不整文件加载 (参考音频动辄几十 MB)
 *  注意: 不能按固定偏移取 data 大小 —— ffmpeg 出的 wav 会在 fmt 后插 LIST/INFO 块,
 *  必须按 RIFF 块链逐个走, 否则会把 LIST 的 size 当成音频数据长度 (时长算成 0)。 */
function wavMeta(file) {
  try {
    const size = fs.statSync(file).size
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(4096)
    const n = fs.readSync(fd, buf, 0, 4096, 0)
    fs.closeSync(fd)
    if (n < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
      return null
    }
    let off = 12
    let byteRate = 0
    let sampleRate = 0
    let channels = 0
    let dataSize = 0
    while (off + 8 <= n) {
      const id = buf.toString('ascii', off, off + 4)
      const sz = buf.readUInt32LE(off + 4)
      const body = off + 8
      if (id === 'fmt ' && body + 16 <= n) {
        channels = buf.readUInt16LE(body + 2)
        sampleRate = buf.readUInt32LE(body + 4)
        byteRate = buf.readUInt32LE(body + 8)
      } else if (id === 'data') {
        dataSize = sz
        break
      }
      off = body + sz + (sz % 2)   // RIFF 块按偶数字节对齐
    }
    if (!byteRate) return null
    if (!dataSize || dataSize > size) dataSize = size - 44
    return {
      dur: Math.round((dataSize / byteRate) * 10) / 10,
      sampleRate,
      channels,
    }
  } catch { return null }
}

/**
 * 找到某条音色的实际参考音频文件。
 *
 * manifest 里的 audio_path 是**写入时的绝对路径**, 可能是别的机器 / 别的目录
 * (例如打包前在源码目录里建的音色) —— 换机后就失效了。所以:
 *   1) audio_path 指的文件确实在 → 用它;
 *   2) 否则回退到本目录 voices/<id>.wav → 语音库能随整个文件夹迁移。
 */
function resolveVoiceFile(v) {
  const p = v?.audio_path || ''
  /**
   * ★ 2026-10-12 审计 §3.8: 这里原本"`audio_path` 指的文件存在就直接用它", 没有任何约束 ——
   *   而 `/api/voices/:id/audio` 会把返回的文件**当音频流出去**, 于是 manifest 被改过之后
   *   能把**任意本地文件**（.key / .json / .png …）从这个接口吐出来。
   * ⚠️ 为什么**不**直接"只能在本目录内"(那是最省事的写法): 见上面 6622 行那段注释 ——
   *   `audio_path` 可能是**别的机器/别的目录**写进去的绝对路径, 一刀切会把这台机器上
   *   "换过目录之后老音色还能试听"的功能弄坏。
   *   所以取**中间那档**: 保留跨目录能力, 但只认**音频扩展名** —— 想借这个口子捞非音频文件就没门了。
   *   (`removeVoiceFile` 那条"只能删本目录内"的规则不动: 删是不可恢复的, 该严就严。)
   */
  const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.ogg', '.flac', '.aac', '.opus'])
  if (p && AUDIO_EXT.has(path.extname(p).toLowerCase()) && fs.existsSync(p)) return p
  const local = path.join(VOICES_DIR(), `${v?.id}.wav`)
  return fs.existsSync(local) ? local : null
}

/** 音色条目 -> 前端友好的扁平结构 */
function toVoiceDTO(v) {
  const file = resolveVoiceFile(v)
  const exists = !!file
  const meta = file ? wavMeta(file) : null
  return {
    id: v.id,
    name: v.name,
    gender: v.gender || 'unknown',
    source: v.source || 'builtin',
    created_at: v.created_at || '',
    hasAudio: exists,
    dur: meta?.dur ?? null,
    sampleRate: meta?.sampleRate ?? null,
  }
}

/** 在 manifest 里按 id 找条目 (同时回传索引) */
function findVoiceIndex(list, id) {
  return list.findIndex((v) => String(v.id) === String(id))
}

/** 删除音色的参考音频文件 (限定在 voices/ 目录内, 防越界) */
function removeVoiceFile(v) {
  // 优先删本目录 voices/<id>.wav, 其次才看 manifest 的 audio_path ——
  // 两者都必须落在 voices/ 内, 越界路径一律不删 (防"manifest 被改后删到别处")。
  const candidates = [path.join(VOICES_DIR(), `${v?.id}.wav`), v?.audio_path].filter(Boolean)
  const root = path.resolve(VOICES_DIR())
  for (const c of candidates) {
    const abs = path.resolve(c)
    if (abs !== root && !abs.startsWith(root + path.sep)) continue
    try { fs.unlinkSync(abs); return true } catch { /* 试下一个 */ }
  }
  return false
}

/** 带 Range 的音频流 (浏览器 <audio> 试听需要) */
function serveAudioFile(req, res, file) {
  let st
  try { st = fs.statSync(file) } catch { return sendJson(res, 404, { ok: false, msg: '音频不存在' }) }
  const total = st.size
  const type = mimeOf(file)
  const range = req.headers.range
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    let start = m && m[1] ? Number(m[1]) : 0
    let end = m && m[2] ? Number(m[2]) : total - 1
    if (!(start >= 0) || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` })
      return res.end()
    }
    if (!(end >= start) || end >= total) end = total - 1
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    })
    return fs.createReadStream(file, { start, end }).pipe(res)
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': total,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  })
  fs.createReadStream(file).pipe(res)
}

/** 把克隆请求转交 8190 后端 (它负责降噪/裁剪/归一化, 并写入 voices.json) */
async function cloneVoiceViaBackend(name, audio_b64, gender) {
  const r = await fetch(`http://127.0.0.1:${BACKENDS.indextts.port}/voices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, audio_b64, gender }),
    signal: AbortSignal.timeout(120000),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j?.ok) throw new Error(j?.error || `IndexTTS 后端返回 HTTP ${r.status}`)
  return j.voice
}

async function handleVoices(req, res) {
  const urlPath = (req.url ?? '/').split('?')[0]
  const rest = urlPath.slice('/api/voices'.length)
  const method = (req.method ?? 'GET').toUpperCase()

  // 试听参考音频: /api/voices/<id>/audio
  const audioMatch = rest.match(/^\/([^/]+)\/audio$/)
  if (audioMatch && method === 'GET') {
    const list = readVoiceManifest()
    const i = findVoiceIndex(list, decodeURIComponent(audioMatch[1]))
    if (i < 0) return sendJson(res, 404, { ok: false, msg: '音色不存在' })
    const file = resolveVoiceFile(list[i])
    if (!file) return sendJson(res, 404, { ok: false, msg: '该音色没有参考音频' })
    return serveAudioFile(req, res, file)
  }

  if (method === 'GET' && (rest === '' || rest === '/')) {
    return sendJson(res, 200, { ok: true, voices: readVoiceManifest().map(toVoiceDTO) })
  }

  if (method === 'POST' && (rest === '' || rest === '/')) {
    const body = await readBody(req, res)
    const name = String(body.name ?? '').trim()
    const audio_b64 = String(body.audio_b64 ?? '')
    const gender = String(body.gender ?? 'unknown')
    if (!name) return sendJson(res, 400, { ok: false, msg: '请填写音色名称' })
    if (!audio_b64) return sendJson(res, 400, { ok: false, msg: '请选择参考音频' })
    try {
      const v = await cloneVoiceViaBackend(name, audio_b64, gender)
      log(`音色克隆成功: ${v?.name} (${v?.id})`)
      return sendJson(res, 200, { ok: true, voice: toVoiceDTO(v ?? {}) })
    } catch (e) {
      return sendJson(res, 500, { ok: false, msg: '音色克隆失败', detail: e instanceof Error ? e.message : String(e) })
    }
  }

  const m = rest.match(/^\/([^/]+)$/)
  if (!m) return sendJson(res, 404, { ok: false, msg: 'not found' })
  const id = decodeURIComponent(m[1])
  const list = readVoiceManifest()
  const i = findVoiceIndex(list, id)
  if (i < 0) return sendJson(res, 404, { ok: false, msg: '音色不存在' })

  if (method === 'PATCH' || method === 'PUT') {
    const body = await readBody(req, res)
    const name = String(body.name ?? '').trim()
    if (!name) return sendJson(res, 400, { ok: false, msg: '名称不能为空' })
    if (list.some((v, k) => k !== i && v.name === name)) {
      return sendJson(res, 409, { ok: false, msg: '已存在同名音色' })
    }
    const before = list[i].name
    list[i].name = name
    writeVoiceManifest(list)
    return sendJson(res, 200, { ok: true, voice: toVoiceDTO(list[i]), renamedFrom: before })
  }

  if (method === 'DELETE') {
    const removed = list.splice(i, 1)[0]
    writeVoiceManifest(list)
    const fileGone = removeVoiceFile(removed)
    log(`音色已删除: ${removed?.name} (${removed?.id}) 文件清理=${fileGone}`)
    return sendJson(res, 200, { ok: true, removed: { id: removed.id, name: removed.name }, fileGone })
  }

  return sendJson(res, 405, { ok: false, msg: 'method not allowed' })
}

// ---------------------------------------------------------------- 网页版外部工具 (豆包 / DeepSeek)
//
// 为什么不做 iframe 内嵌 (实测结论, 见 h3test/_embed_probe.py):
//   - DeepSeek: 响应头 `content-security-policy: frame-ancestors 'none'` **强制**,
//     iframe 被浏览器直接拦掉, 页面完全不加载。
//   - 豆包: frame-ancestors 只在 `content-security-policy-report-only` 里 (只上报不拦),
//     iframe 能渲染、也能弹出扫码, 但登录态是 HttpOnly + SameSite=None 的第三方 cookie,
//     会被 Chromium 的第三方 cookie 限制影响, 会话不能保证留住。
//
// 所以用最稳的形态: **独立浏览器窗口 + 项目内持久化 profile**
//   `--app=<url>` 打开无地址栏窗口 (观感接近桌面客户端);
//   `--user-data-dir=profiles/<target>` 让 cookie 落在项目目录里 →
//   首次扫码登录一次, 之后打开即免登录, 且完全不碰你自己浏览器的 profile。
//
//   GET  /api/webapps        → 站点列表 + 浏览器探测结果 + profile 是否已初始化
//   POST /api/webapps/open   → {target} 打开窗口
//   POST /api/webapps/reset  → {target} 清除该 profile (退出登录 / 换账号)
//
// 实现放在 tools/webapps.mjs, 与 vite dev 的中间件共用同一份 (单一事实来源)。
// profile 根目录由 P.webappProfileRoot 提供 (= <dataDir>/profiles)。

// ---------------------------------------------------------------- 反向代理

/**
 * 反代前缀表 —— **只记前缀与是哪一路**, 端口一律在请求那一刻现取。
 *
 * ⚠️⚠️ 2026-10-12 血泪(别再改回去): 以前这里写的是 `port: BACKENDS.h3.port` —— 那是**模块加载时**
 *   把端口拍成快照。而"端口被 Windows 保留 → 自动搬迁"发生在 `startServer` 里(比模块加载晚),
 *   快照于是永远停在默认的 8188-8192 ⇒ **后端搬走了, 反代还往旧端口打**:
 *   模型进程好端端在 8971 上听着, 界面却一直"未在运行/启动中", 日志里每几秒一行
 *   `[proxy] Krea2 生图 端口拒绝连接 → 立即标记离线`。**一条请求都到不了后端**。
 *   现在端口现取: 搬到哪儿都立刻跟上, 也一样能吃到测试口子 AICS_TEST_PORTS。
 */
const HTTP_ROUTES = [
  { prefix: '/comfy', kind: 'h3', ws: true },
  { prefix: '/kear', kind: 'kear', ws: true },
  { prefix: '/indextts', kind: 'indextts', ws: false },
  /** 第 4 路: Qwen-Image-2.1 生图 (2026-09-24) */
  { prefix: '/qwen', kind: 'qwen', ws: true },
  /** 第 5 路: 本地小文本模型 (2026-09-25 · 提示词优化/翻译, 纯 CPU) */
  { prefix: '/text', kind: 'text', ws: false },
]

/** 反向代理前缀 → 后端键 (按需启动时, 请求打到哪个前缀就拉起哪个后端) */
const BACKEND_OF_ROUTE = { '/comfy': 'h3', '/kear': 'kear', '/indextts': 'indextts', '/qwen': 'qwen', '/text': 'text' }

/**
 * 是否启用"按需启动"。
 *
 * 默认开启, 理由: 打开程序就把三个后端全拉起来, 对弱机是三重打击 ——
 *    ① 首启要等三套 Python 环境先后初始化; ② 内存/显存被三个进程分掉;
 *    ③ 用户可能今天只想用语音, 视频后端白占 1GB+ 显存。
 * 关掉 (settings.json: "lazyBackends": false) 就回到"启动即预热"的老行为, 适合专用工作站。
 */
function lazyBackendsEnabled() {
  return P.settings?.lazyBackends !== false
}

/**
 * 「模型全量常驻」—— 打开后**关掉独占在线**(settings.json: `"allModelsOnline": true`)。
 *
 * 默认关。打开 = 用户明确接受"多个模型的权重同时占显存/内存"这个代价, 换来"切换不用重启进程"。
 * ⚠️ 只影响 launchBackend 里那段"起这一路先把别的停掉"; 不影响:
 *   · "同一路一次只跑一个任务"(队列那条规则照旧, 见 queueRunner 的 lane);
 *   · 对方的进程**正在生成任务**时仍会拒绝(由调用方给 force 才强停, 见 launchBackend 里的冲突判定)。
 */
function allModelsOnlineEnabled() {
  return P.settings?.allModelsOnline === true
}

/** 权重页缓存预热是否开着(默认开; settings.json: `"prewarmWeights": false` 可关) */
function prewarmEnabled() {
  return P.settings?.prewarmWeights !== false
}

/**
 * 杀软排除 (2026-10-11 用户要求"杀软排除")。
 *
 * 为什么要它: 模型包几十 GB 的大权重, 每次冷启动都要整份读一遍 —— 而 Windows Defender 会**逐块扫描**
 *   这些新读到的文件, 这正是"首次启动特别慢、第二次就快"的经典原因(实测这台机顺序读 ≈4.3GB/s,
 *   39GB 理论才 9 秒, 真实启动远不止 —— 扫描与解压都叠在上面)。
 * 做法: ① 查(`Get-MpPreference -ExclusionPath`) —— 不需要管理员;
 *      ② 加(`Add-MpPreference`) —— **需要管理员**, 所以走 UAC 弹一次; 用户取消就如实说"没加成"。
 * 判据: 只报事实(已排除/未排除/系统没有 Defender/加失败), 不假装成功。
 */
/**
 * 权重「页缓存预热」 (2026-10-11 用户要求"权重页缓存预热")。
 *
 * 干什么: 后台**顺序读**这一路的大权重文件, 把内容顶进操作系统的 page cache —— 真正启动时
 *   权重就从内存里来, 不再等磁盘。本机实测顺序读 ≈4.3GB/s(H3 一次要用 ≈39GB), 内存大(本机 130GB)
 *   的机器收益明显; 内存小的机器反而会把有用的缓存挤掉, 所以：
 *     · **限速**(默认每 8MB 歇 12ms ≈ 700MB/s 上限), 不抢生成/读盘的带宽;
 *     · **一有后端要启动就立刻中止**(launchBackend 开头会 cancelPrewarm) —— 别和真正的加载抢 I/O;
 *     · 只预热"已启用且当前不在线"的那一路; 单次最多 90 秒/最多 3 个最大文件(先热最大的那几个)。
 * ⚠️ 它**不加载任何模型、不碰显存**, 只是读文件; 随时可以打断, 失败也不影响任何功能。
 */
const PREWARM = new Map()   // kind → { running, done, bytes, total, files, startedAt, cancelled, stopped }
function prewarmState(kind) {
  const s = PREWARM.get(kind)
  return s ? { kind, running: !!s.running, bytes: s.bytes, total: s.total, files: s.files, stopped: s.stopped || '' } : null
}
function cancelPrewarm(kind) {
  for (const [k, s] of PREWARM) {
    if (!s.running) continue
    if (kind && k !== kind) continue
    s.cancelled = true
    s.stopped = kind ? `${BACKENDS[k]?.label ?? k} 要启动了, 让路` : '有新任务要跑, 让路'
  }
}
/** 找这一路最大的几个权重文件(只找 .safetensors/.sft/.gguf/.pth, 只找 models 目录, 不递归太久) */
function prewarmTargets(kind, maxFiles = 3) {
  const roots = []
  if (kind === 'h3') roots.push(path.join(P.h3Root, 'payload', 'backend', 'ComfyUI-H3', 'ComfyUI', 'models'))
  else if (kind === 'kear') roots.push(path.join(P.kearRoot, 'payload', 'backend', 'ComfyUI-Krea2', 'ComfyUI', 'models'))
  else if (kind === 'qwen') roots.push(path.join(P.qwenRoot, 'payload', 'backend', 'ComfyUI-Qwen', 'ComfyUI', 'models'))
  const out = []
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    const walk = (d, depth) => {
      if (depth > 4) return
      let ents = []
      try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const e of ents) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) { walk(p, depth + 1); continue }
        if (!/\.(safetensors|sft|gguf|pth)$/i.test(e.name)) continue
        try { out.push({ path: p, size: fs.statSync(p).size }) } catch { /* ignore */ }
      }
    }
    walk(root, 0)
  }
  return out.sort((a, b) => b.size - a.size).slice(0, maxFiles)
}
async function prewarmBackend(kind, { budgetMs = 90000 } = {}) {
  const b = BACKENDS[kind]
  if (!b) return { ok: false, msg: `未知后端: ${kind}` }
  if (!prewarmEnabled()) return { ok: true, skipped: true, msg: '已关掉权重预热（设置里可以打开）' }
  const cur = PREWARM.get(kind)
  if (cur && cur.running) return { ok: true, already: true, ...prewarmState(kind) }
  /** 已经在线 / 正在启动 → 没必要预热(它自己就在读) */
  const rec = BACKEND_PROCS.get(kind)
  if ((rec && !rec.exited) || await portBusy(b.port)) {
    return { ok: true, skipped: true, msg: `${b.label} 已经在线, 不用预热` }
  }
  const targets = prewarmTargets(kind)
  const total = targets.reduce((n, t) => n + t.size, 0)
  const st = { running: targets.length > 0, done: false, bytes: 0, total, files: targets.map((t) => path.basename(t.path)), startedAt: Date.now(), cancelled: false, stopped: '' }
  PREWARM.set(kind, st)
  if (!targets.length) { st.running = false; st.done = true; return { ok: true, ...prewarmState(kind), msg: '没找到可预热的权重文件（模型可能装在别的目录）' } }
  log(`[prewarm] ${b.label}: 开始预热 ${targets.length} 个权重文件(共 ${(total / 1073741824).toFixed(1)}GB, 限速 ~700MB/s)`)
  ;(async () => {
    const CHUNK = 8 * 1024 * 1024
    const buf = Buffer.allocUnsafe(CHUNK)
    try {
      for (const t of targets) {
        if (st.cancelled) break
        let fd = null
        try { fd = fs.openSync(t.path, 'r') } catch { continue }
        try {
          let pos = 0
          for (;;) {
            if (st.cancelled) break
            if (Date.now() - st.startedAt > budgetMs) { st.stopped = '预热到时间预算了(下次再接着热)'; break }
            const n = fs.readSync(fd, buf, 0, CHUNK, pos)
            if (n <= 0) break
            pos += n
            st.bytes += n
            if (pos % (64 * 1024 * 1024) < CHUNK) await new Promise((r) => setTimeout(r, 96))   // 限速(每 64MB 歇 96ms)
          }
        } finally { try { if (fd != null) fs.closeSync(fd) } catch { /* ignore */ } }
      }
    } catch (e) {
      st.stopped = String((e && e.message) || e).slice(0, 120)
    } finally {
      st.running = false; st.done = true
      log(`[prewarm] ${b.label}: ${st.cancelled ? '已中止' : '结束'} —— 读了 ${(st.bytes / 1073741824).toFixed(1)}GB`
        + `${st.stopped ? `（${st.stopped}）` : ''}`)
    }
  })()
  return { ok: true, ...prewarmState(kind) }
}

let defenderCache = { at: 0, val: null }
function defenderState({ force = false } = {}) {
  if (!force && defenderCache.val && Date.now() - defenderCache.at < 60000) return defenderCache.val
  const roots = [P.backendsRoot]
  let val = { supported: false, excluded: false, paths: [], roots, reason: '' }
  try {
    if (process.platform !== 'win32') {
      val.reason = '只有 Windows 有 Defender 排除这一套'
    } else {
      const out = execCapture('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        '(Get-MpPreference).ExclusionPath -join "`n"',
      ], { timeout: 15000 })
      val.supported = true
      val.paths = String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      val.excluded = val.paths.some((p) => {
        const a = p.replace(/[\\/]+$/, '').toLowerCase()
        return roots.some((r) => {
          const b = String(r).replace(/[\\/]+$/, '').toLowerCase()
          return a === b || b.startsWith(a + '\\') || a.startsWith(b + '\\')
        })
      })
    }
  } catch (e) {
    /** 拿不到(非 Defender 环境/被策略挡/超时) —— 如实说"判不出来", 不要编一个状态 */
    val.reason = String((e && e.message) || e).slice(0, 200)
  }
  defenderCache = { at: Date.now(), val }
  return val
}

/** 把模型目录加进 Defender 排除项(需管理员 → 走一次 UAC; 返回加入之后的真实状态) */
async function addDefenderExclusion() {
  const root = String(P.backendsRoot || '')
  if (process.platform !== 'win32') return { ok: false, msg: '只有 Windows 支持' }
  if (!root) return { ok: false, msg: '还没配置模型目录' }
  const before = defenderState({ force: true })
  if (!before.supported) return { ok: false, msg: `读不到 Defender 设置：${before.reason || '未知原因'}`, state: before }
  if (before.excluded) return { ok: true, already: true, msg: '这个目录已经在排除项里了', state: before }
  /**
   * ⚠️ `-Verb RunAs` 会弹 UAC —— 用户点"否"时 Start-Process 直接抛错, 这里如实回报。
   *   命令用**参数数组**拼(不拼字符串), 免得路径里的空格/中文被拆坏。
   */
  const psArgs = [
    '-NoProfile', '-NonInteractive', '-Command',
    `Add-MpPreference -ExclusionPath '${root.replace(/'/g, "''")}'`,
  ]
  try {
    await execCaptureAsync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Start-Process -FilePath powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @(${psArgs.map((a) => `'${a.replace(/'/g, "''")}'`).join(',')})`,
    ], { timeout: 120000 })
  } catch (e) {
    return {
      ok: false,
      msg: '没能加进排除项（多半是 UAC 里点了「否」，或不是管理员）',
      detail: String((e && e.message) || e).slice(0, 200),
    }
  }
  const after = defenderState({ force: true })
  if (after.excluded) return { ok: true, msg: '已把模型目录加进排除项（下次启动后端就不会再被逐块扫描）', state: after }
  return { ok: false, msg: '命令跑完了，但排除项里还是没看到这个目录 —— 可能被安全策略挡了', state: after }
}

/**
 * 空闲多久自动卸载模型(分钟)。0 = 关闭。
 * 默认 10 分钟: 比"切换即卸"宽松得多, 正常连着做东西时完全不会触发,
 * 只有真的走开了(挂机)才把显存还回去。设置里可改(5/10/30/关闭)。
 * 测试钩子: AICS_IDLE_FREE_MIN=1 可压到 1 分钟, 便于观察效果。
 */
function idleFreeMinutes() {
  const env = Number(process.env.AICS_IDLE_FREE_MIN)
  if (Number.isFinite(env) && env >= 0) return env
  const v = P.settings?.idleFreeMinutes
  if (typeof v === 'number' && v >= 0) return v
  return 10
}

/**
 * 两个 ComfyUI 后端共用的"内存/显存"启动参数。
 *
 * ⚠️ 2026-09-27 更新: `--fast-disk` 不再无条件带 —— 它会让权重以**磁盘**为后备,
 *   内存宽裕的机器(≥32GB)反而因此每步都去读盘, 画布大一点就慢几十倍(用户实测 1426 s/步)。
 *   现在只有内存 < 32GB 的机器才带它(那种机器不带就装不下模型)。详见 memoryLaunchArgs。
 *
 * 2026-09-14 用户要求: **不要在机器上留任何内存/显存限制**。
 *   调试期为压测加过的三条已全部去掉:
 *     · --vram-headroom 1.5 —— 它让 ComfyUI 硬留 1.5GB 显存不给模型用(人为限制)
 *     · --reserve-vram 1     —— 更早的预留写法, 同样属于限制
 *     · 内存 < 32GB 自动 --cache-none —— 拿"每次重算节点"换省内存, 不该偷偷降速
 *   只保留 --fast-disk: 它是"权重以磁盘为后盾按需加载"的**加载策略**, 不封顶任何资源,
 *   而且 H3 的启动脚本本来就一直带着它。要连它也去掉, 说一声即可。
 */
/**
 * 启动档位 (2026-09-15 · 低显存适配)
 *
 * 背景(大规模测试反馈): 8G 显存机器上 ComfyUI 的 DynamicVRAM **读权重分片失败**, H3 与 Krea2 都起不来。
 *   查它的实现: 分片要靠"固定内存(pinned memory)"当宿主缓冲, 上限是 `内存 × 40%`(Windows),
 *   而申请量约等于"模型大小 ×2" —— 16G 内存的机器只允许固定 ~6.4G, 分配不到就报分片读取失败。
 *   另外我们过去**无条件**带 `--vram-headroom 0.8`: 在 8G 卡上等于先扣掉 0.8G, 雪上加霜。
 *
 * 现在按机器自动分三档(用户设置只在宽裕档生效, 免得"设了 1.5G 预留"的机器把 8G 卡压死):
 *   low  低配档 : <12G 显存 或 <32G 内存 → 关固定内存(--disable-pinned-memory) + 不预留显存
 *   mid  标准档 : <16G 显存 或 <48G 内存 → 预留 0.5G
 *   high 宽裕档 : 其余 → 用用户设置(默认 0.8G, 保桌面流畅)
 *
 * ★ 2026-10-30 追加一条**与档位无关**的判据(见 launchProfile 里的长注释):
 *   显存 < 24GB（装不下这一版 H3 的 20GB 模型 → 必然走宿主缓冲）**且** 关掉固定内存后剩下的
 *   内存装不下 40GB 暂存权重时, 也关固定内存。64GB 内存 + 16GB 显存正好卡在这个边界,
 *   表现就是出片解码时 hostbuf_file_reader_read failed / error=1450 崩溃。
 */
let _launchProfileCache = { at: 0, val: null }
export function launchProfile() {
  if (_launchProfileCache.val && Date.now() - _launchProfileCache.at < 30_000) return _launchProfileCache.val
  const tl = testLimits()
  const vramGB = tl.on ? tl.vramGB : Math.round((gpuInfo().vramTotal || 0) / 1024)
  const ramGB = systemMemory().totalGB
  const userHeadroom = desktopVramGB()
  let key, label, headroom, reason
  if ((vramGB > 0 && vramGB < 12) || ramGB < 32) {
    key = 'low'; label = '低配档'; headroom = 0
    reason = `显存 ${vramGB || '?'}GB / 内存 ${ramGB}GB 偏紧：关闭固定内存、不预留显存，优先保证能跑起来`
  } else if ((vramGB > 0 && vramGB < 16) || ramGB < 48) {
    key = 'mid'; label = '标准档'; headroom = Math.min(userHeadroom, 0.5)
    reason = `显存 ${vramGB || '?'}GB / 内存 ${ramGB}GB 中等：预留 ${headroom}GB 给桌面`
  } else {
    key = 'high'; label = '宽裕档'; headroom = userHeadroom
    reason = `显存 ${vramGB || '?'}GB / 内存 ${ramGB}GB 宽裕：预留 ${headroom}GB 给桌面`
  }
  /**
   * ★ 2026-10-30 客户现场（RTX 5070 Ti 16GB / 64GB 内存 / 驱动 617.42 · v2.10.31）:
   *   出片采样 6 步全跑完, 卡在 **VAE 解码**, 进程以 access violation 没了。日志三行连击:
   *     aimdo: xfer_file_read_at: GetOverlappedResult failed error=1450
   *     aimdo: hostbuf_read_file_slice: file read failed handle=0x930 size=33554432
   *     !!! Exception during processing !!! hostbuf_file_reader_read failed
   *   同一个包里还夹着一句 `DefaultCPUAllocator: not enough memory: 7372800 bytes`（7MB 都申请不到）。
   *   客户反馈"同款机型别的机器没这个错", 而且"自己起的 ComfyUI 也不报" —— 差别就在我们这条启动参数上。
   *
   *   病根是「固定内存」这一档: 这一版 ComfyUI 在 Windows 上把
   *     MAX_PINNED_MEMORY = 内存 × 40%              → 64GB 机器 = 26059MB（日志原文 "Enabled pinned memory 26059.0"）
   *     pinned_hostbuf_size(size) = min(size, 上限) × 2 → H3 的 20GB 模型想要 40GB 宿主缓冲
   *   固定内存**不可换页**: 先钉掉 25.6GB, 剩下 38.4GB 要装 40.5GB 暂存权重（模型 20 + 文本 15 + VAE 5）
   *   → 提交内存打满 → 7MB 都申请不到, 异步读返回 error=1450（ERROR_NO_SYSTEM_RESOURCES）, 进程直接崩。
   *   64GB 内存 + 16GB 显存**正好卡在边界上** —— 内存更大的机器够用, 所以"同款不一定复现"。
   *
   *   判据不能还是"显存 < 12GB 才关": 16GB 卡同样装不下这一版 H3 的 20GB 模型。
   *   该问的是"关掉固定内存后剩下的内存, 够不够装下这 40GB 暂存权重"。
   *   判定本身抽在 tools/launchprofile.mjs（可单测, 见 tools/selftest/pinned-memory.mjs）。
   */
  const pinned = pinnedMemoryDecision({ vramGB, ramGB })
  const pinnedMemory = key !== 'low' && pinned.pinned
  const val = { key, label, vramGB, ramGB, headroom, reason: reason + pinned.why, pinnedMemory, pinnedTooBig: pinned.pinnedTooBig }
  _launchProfileCache = { at: Date.now(), val }
  return val
}

export function memoryLaunchArgs() {
  const p = launchProfile()
  /**
   * ⚠️ 2026-09-27 —— `--fast-disk` 改成**只在内存紧张的机器上带**。
   *
   * 用户实测(这台 20GB 显存 / 128GB 内存的机器):
   *   · 自己用模型包自带的 `run_nvidia_gpu.bat` 起 ComfyUI, 同一套 H3 工作流跑 21:9·720P·12 秒没问题;
   *   · 从画布起(带 `--fast-disk`)同样的活儿**每一步采样要 23 分钟**(日志实测 1426 s/it),
   *     整条 2 小时以上 —— 看着就是"跑不出来"。
   *
   * 那个参数在本模型包里的含义(见 comfy/cli_args.py):
   *   "Prefer disk-backed dynamic loading and offload over unpinned RAM.
   *    Can be faster for users with fast NVME disks."
   *   即: **优先用磁盘当权重的后备**, 不用普通内存。内存小的机器(装不下模型)靠它才能跑;
   *   但内存宽裕时, 它反而把每步要用的权重从磁盘重新读 —— 画布稍微大一点(显存装不下工作集)
   *   就退化成硬盘带宽决定速度, 于是出现几十倍甚至上百倍的慢速。
   * 内存 ≥ 32GB 的机器改成**常规内存加载**(与用户手动启动一致), 只有内存 < 32GB 的机器才保留它。
   */
  const ramTight = p.ramGB > 0 && p.ramGB < 32
  return [
    ...(ramTight ? ['--fast-disk'] : []),
    /**
     * 关掉固定内存的两种情况:
     *   ① 低配档（<12G 显存 / <32G 内存）—— 这正是 8G/16G 机器"读分片失败"的根因所在；
     *   ② 2026-10-30 起: 显存装不下模型(必须走宿主缓冲) 且 内存也塞不下那 40GB 暂存权重。
     *      客户那台 64GB+16GB 就是第 ② 类, 日志里 `Enabled pinned memory 26059.0` + 40GB Staged
     *      = 提交内存 66GB > 可用, 出片解码时 hostbuf 回读直接 error=1450。
     */
    ...(p.pinnedMemory ? [] : ['--disable-pinned-memory']),
    ...(effectiveHeadroom() > 0 ? ['--vram-headroom', String(effectiveHeadroom())] : []),
  ]
}

/**
 * 自测钩子 (2026-10-06) —— 只给 `_dev/tmp` 里的探针用, 不改变任何运行行为。
 *
 * 为什么需要: "另一路正在启动时不许掀掉它"这条守卫只有在**服务端进程内部**才能构造出
 *   场景(伪造一条"托管中、还没就绪"的运行记录)。探针在同一个进程里 startServer(), 于是
 *   直接借这几个内部引用去断言, 不必真去拉起一个几十 GB 的后端。
 */
export function __aicsInternals() {
  return { BACKEND_PROCS, BACKENDS, launchBackend, startingBackend, shutdownBackends, portBusy, portHolder,
    /**
     * 2026-10-30 追加: 崩溃分诊要能被**单独喂料**验证 —— 客户那三种报错
     *   (hostbuf 回读失败 / access violation / CUDA 自报驱动不行) 必须落到不同结论上。
     *   只给 _dev/tmp 与 tools/selftest 用, 不改任何运行行为。
     */
    classifyBackend, launchProfile }
}

/**
 * 实际下发的 --vram-headroom。
 *
 * 测试模式下要**真正卡住显存**: 例如 20GB 的卡模拟 12GB → 预留 8GB
 *   (再加上用户自己设的桌面预留), 于是后端的可用显存就等效于 12GB 卡。
 *   这不是"演给界面看", 而是让 ComfyUI 真的在 12GB 里工作 —— 低配机器的
 *   "换页/极慢/爆显存"这些现象才会真实复现出来。
 */
function effectiveHeadroom() {
  const p = launchProfile()
  const tl = testLimits()
  if (!tl.on) return p.headroom
  const realGB = Math.round((gpuInfo().vramTotal || 0) / 1024)
  const reserve = Math.max(0, realGB - tl.vramGB)
  return Math.round((reserve + p.headroom) * 10) / 10
}

/**
 * 「给桌面留显存」(GB) —— 默认 0.8, 0 = 完全不预留。
 *
 * 这是**保桌面**的开关, 不是限制模型: ComfyUI 的 --vram-headroom 会把"其它程序已占的显存"
 * 也算进来, 始终留出这么一块完全空闲。20GB 卡跑 17.9GB 的模型时, 不预留就会把显存吃到 97%,
 * Windows 只能把桌面/浏览器的显存换到内存 → 画布整页发涩(2026-09-15 用户实测反馈)。
 * 留 0.8GB 对生成速度几乎没有影响(模型本来就要流式加载), 但浏览器明显跟手。
 * 设置面板可改成 0 / 0.5 / 0.8 / 1.5GB。
 */
function desktopVramGB() {
  const v = Number(P.settings?.desktopVramGB)
  if (Number.isFinite(v) && v >= 0) return Math.round(v * 10) / 10
  return 0.8
}

/** 手动启动模式: 程序不自动拉起任何后端 (默认开, 见 runtime.mjs 的说明) */
function manualStartEnabled() {
  return P.settings?.manualStart !== false
}

/* ============================================================
   后端子进程环境 (2026-09-15 · P0 修复)
   两个长期存在的坑:
     ① **ninja 找不到**: 后端自带的 ninja.exe 就在 <root>\python_embeded\Scripts\ 里,
        但 torch.utils.cpp_extension 是用 **PATH** 去找它的 —— 我们从来没把这两个目录
        加进子进程 PATH, 于是 IndexTTS 的 BigVGAN 自定义 CUDA 内核永远编译不了
        (报 "Ninja is required to load C++ extensions"), 只能退回慢速 torch 实现。
        注意这是"包里有、但没暴露", 不是用户缺环境。
     ② **中文路径**: torch 扩展编译要用 ninja/MSVC 在扩展目录里生成构建文件, 路径含中文
        (尤其中文用户名 C:\Users\张三) 极易失败; 临时文件同理。所以把
        TORCH_EXTENSIONS_DIR / TMP / TEMP 指到**纯英文**目录。
   ============================================================ */

/**
 * 预编译 BigVGAN CUDA 内核时使用的架构列表(见 tools/build-bigvgan-kernel.py)。
 * 固定它有两个作用: ① 跨机器编译缓存键一致, 预编译产物不会被判"过期"而重编;
 * ② 覆盖主流 NVIDIA 卡(7.5/8.0/8.6/8.9/9.0)并附带 12.0 的 PTX, 新卡由驱动再 JIT。
 */
const BIGVGAN_ARCH_LIST = '7.5;8.0;8.6;8.9;9.0;12.0+PTX'

/** 纯 ASCII 的落盘根: 数据目录本身是英文就用它, 否则退到 ProgramData */
function asciiSafeBase() {
  const isAscii = (s) => !!s && !/[^\x00-\x7F]/.test(s)
  if (isAscii(P.dataDir)) return P.dataDir
  const pd = process.env.ProgramData || 'C:\\ProgramData'
  return path.join(pd, 'Manke')
}

let _extPathsCache = null
/** torch 扩展编译目录 + 子进程临时目录 (都是英文短路径, 建一次复用) */
function extPaths() {
  if (_extPathsCache) return _extPathsCache
  const base = asciiSafeBase()
  const extDir = path.join(base, 'torch_ext')
  const tmpDir = path.join(base, 'tmp')
  try { ensureDir(extDir) } catch { /* 盘不可写就交给系统默认 */ }
  try { ensureDir(tmpDir) } catch { /* 同上 */ }
  _extPathsCache = { base, extDir, tmpDir, baseIsAscii: base === P.dataDir }
  return _extPathsCache
}

/** 安装/数据路径里有没有非 ASCII 字符(给"建议换英文目录"的提示用) */
function hasNonAsciiPath(...parts) {
  return parts.some((s) => !!s && /[^\x00-\x7F]/.test(String(s)))
}

/**
 * 后端 python 子进程的运行环境。
 * @param pyExe 该后端自带的 python.exe(用它的目录推出 python_embeded / Scripts)
 * @param extra 该后端特有的环境变量(如 TRITON_CACHE_DIR)
 */
function backendEnv(pyExe, extra = {}) {
  const root = path.dirname(pyExe)                     // …\python_embeded 或 …\env
  const scripts = path.join(root, 'Scripts')
  /**
   * ⚠️ 2026-09-28 真机定位: 千问模型包"装上了但打不开"的根因就是这里少了 conda 的 Library\bin。
   *
   *   第 4 路(Qwen)的环境是 **conda 风格 env\**(包内 env\conda-meta\history 写着
   *   `conda create -p …\comfyui-qwen\env python=3.13`), 它的原生依赖不在 env\ 根下, 而在
   *   **env\Library\bin\**: libssl-3-x64.dll / libcrypto-3-x64.dll / sqlite3.dll / liblzma.dll /
   *   libbz2.dll / libexpat.dll / ffi-8.dll / zlib.dll —— 连 **MSVC 运行时**
   *   (msvcp140*.dll / vcruntime140*.dll / concrt140.dll) 都只在那一条目录里。
   *   而 stdlib 的扩展模块 env\DLLs\_ssl.pyd / _hashlib.pyd / _sqlite3.pyd / _lzma.pyd 就依赖它们,
   *   Windows 找依赖 DLL 的顺序里没有"兄弟目录", 只看 加载模块所在目录 + 程序目录 + 系统目录 + PATH
   *   —— conda 正是靠"激活时把 Library\bin 前置进 PATH"才成立的。
   *
   *   以前这里只加 `env` + `env\Scripts`:
   *     · 打包机上有 Miniconda + VC++ 运行时兜着 → 看着一切正常;
   *     · 测试机型(干净系统)一 `import ssl` 就 "DLL load failed while importing _ssl"
   *       → ComfyUI 连启动都进不去 → 用户看到的就是"装了千问包, 打不开"。
   *
   *   现在按 conda 的规矩把这几条目录一并前置(存在才加 → python_embeded 布局的三路行为不变)。
   */
  const condaDirs = [
    path.join(root, 'Library', 'bin'),
    path.join(root, 'Library', 'mingw-w64', 'bin'),
    path.join(root, 'Library', 'usr', 'bin'),
    path.join(root, 'DLLs'),
  ].filter((d) => { try { return fs.existsSync(d) } catch { return false } })
  const parts = [root, ...condaDirs, scripts, process.env.PATH || ''].filter(Boolean)
  const { extDir, tmpDir } = extPaths()
  return {
    ...process.env,
    // ① PATH: 让 torch 找得到包内的 ninja(以及 Scripts 里的其它小工具)
    PATH: parts.join(path.delimiter),
    Path: parts.join(path.delimiter),                  // Windows 上两种写法都写, 免得某个库只读 Path
    // ② 编码: 中文路径/中文输出都别炸
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
    /**
     * ④ 程序目录: 兼容栈选择器(tools\compat_pth.mjs 写进 site-packages 的 .pth)靠它找到
     *    `<程序目录>\_vendor\cu126`。为什么必须有: 选择器原本只会"从解释器目录一层层往上找",
     *    而**模型目录可以放到别的盘**(MODELS-DIR.txt) —— 那种布局下往上找只会走到那块盘的盘根,
     *    永远看不见程序目录里的兼容栈(补丁包就白装了, 还查不出原因)。
     */
    AICS_APP_ROOT: P.appRoot,
    /**
     * 安装身份（H3 的 ComfyUI-AiCanvas-Identity-v1 节点会原样回报）：
     *   · instanceId 证明“当前这次安装”；
     *   · programVersion/build 防止升级后继续复用升级前的旧进程；
     *   · modelApiVersion 防止旧模型契约的后端混进来。
     * 其它后端忽略这三个变量，不会改变它们的行为。
     */
    ...(() => {
      const id = expectedBackendIdentity()
      return {
        AICS_INSTANCE_ID: id.instanceId,
        AICS_PROGRAM_VERSION: id.programVersion,
        AICS_BUILD: id.build,
        AICS_MODEL_API_VERSION: id.modelApiVersion,
        AICS_BACKENDS_ROOT: id.backendsRoot,
      }
    })(),
    // ③ 纯英文的编译/临时目录
    TORCH_EXTENSIONS_DIR: extDir,
    TMP: tmpDir,
    TEMP: tmpDir,
    ...extra,
  }
}

/**
 * 裸后端地址(/comfy、/kear、/h3、/indextts)的落地页。
 *
 * 背景(2026-09-14 用户反馈): 这三条前缀是整段反向代理, 所以浏览器打开
 * `http://127.0.0.1:<应用端口>/comfy` 会**直接渲染出 ComfyUI 的原始界面** ——
 * 用户会看到一个陌生页面, 以为是应用出了故障, 还可能在上面误操作。
 *
 * 应用真正需要的只是子路径(/comfy/view 取图、/comfy/queue、/comfy/prompt、
 * /comfy/ws 等), 所以这里把"裸地址"拦下来给一句人话, 子路径照常代理。
 * ⚠️ 新增用到的子路径不受影响(它们在 `/comfy/xxx` 形式下), 只有 `/comfy`(带不带斜杠) 被拦。
 */
function sendBackendLanding(res, route) {
  const label = ({ 8188: 'H3 视频', 8189: 'Krea2 生图', 8190: 'IndexTTS 语音' })[route.port] || '本地模型后端'
  const html = `<!doctype html><meta charset="utf-8"><title>${label} · 本地模型服务</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#14161c;color:#e6e8ee;font:15px/1.75 system-ui,"Microsoft YaHei",sans-serif}
.b{max-width:600px;padding:30px 34px;border:1px solid #2a2e39;border-radius:14px;background:#1a1d25;box-shadow:0 18px 50px rgba(0,0,0,.4)}
h1{margin:0 0 12px;font-size:19px}p{margin:0 0 9px;color:#a7adbb}code{background:#22262f;padding:2px 7px;border-radius:6px;color:#cdd3e0}
a{display:inline-block;margin-top:16px;padding:9px 18px;border-radius:9px;background:#3b6ef6;color:#fff;text-decoration:none;font-weight:600}</style>
<div class="b"><h1>${label} 的本地服务（原始接口页面）</h1>
<p>这是本机模型后端在 <code>127.0.0.1:${route.port}</code> 上的原始界面，应用本身不需要打开它。</p>
<p><b>请不要在这里操作</b>，也不要关闭它 —— 它是被应用自动拉起的后台服务。</p>
<p>要生成内容，请回到应用窗口：画布 → 对应卡片上点生成。</p>
<a href="http://127.0.0.1:${PORT}/">回到应用</a></div>`
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
  res.end(html)
}

function matchRoute(url) {
  const clean = (url ?? '').split('?')[0]
  const hit = HTTP_ROUTES.find((r) => clean === r.prefix || clean.startsWith(r.prefix + '/'))
  if (!hit) return undefined
  /** ⚠️ **端口在这里现取**(不是在模块加载时拍快照) —— 见 HTTP_ROUTES 上的血泪说明 */
  return { ...hit, port: BACKENDS[hit.kind]?.port ?? 0 }
}

/** 读某一路后端日志的最后 n 行(给"已停止"这类错误带上现场线索) */
function lastLogLines(kind, n = 3) {
  try {
    const files = backendLogFiles(kind)
    if (!files.length) return []
    const txt = stripAnsiText(fs.readFileSync(files[0], 'utf-8'))
    return txt.split(/\r?\n/).filter((l) => l.trim()).slice(-n).map((l) => l.slice(0, 160))
  } catch { return [] }
}

/**
 * 代理层发现端口没人听(ECONNREFUSED) → **立刻**标记离线, 不等状态轮询。
 *
 * 为什么需要(用户实测): 后端崩掉后, 前端状态灯因为"连续 2 次失败才判离线"的防抖
 *   还能绿 10~15 秒; 用户正好在这段时间点生成, 就得到一句纯技术的 502, 而灯还是绿的。
 *   服务端本来第一秒就知道真相 —— 这里把它主动告诉前端(清探测缓存, 下次 /api/status 真探)。
 */
/** kind → 上次记录"掉线"日志的时刻(用于去重刷屏, 见 markBackendOffline) */
const offlineLoudAt = new Map()

function markBackendOffline(kind, detail) {
  try {
    probeAllCache = { at: 0, val: null }
    const rec = BACKEND_PROCS.get(kind)
    if (rec) rec.probeFailedAt = Date.now()
    /**
     * 日志/时间线**只在第一次掉线时说一次**, 不是每个请求都说 (2026-09-19 P3)。
     *
     * 以前每来一个"端口拒绝"就写一行 `[proxy] X 端口拒绝连接 → 立即标记离线`，
     * 而前端状态灯每 5 秒就要探 3 路(每路 2 个接口) —— 后端没启动时服务端日志被这行刷满，
     * 用户导出日志发过来，真正有用的几行全被埋了。
     * 现在: 一个后端 60 秒内最多说一次；它一旦能答上来就清掉(见 proxyToLocal 成功分支的清理)。
     */
    const last = offlineLoudAt.get(kind) ?? 0
    if (Date.now() - last < 60_000) return
    offlineLoudAt.set(kind, Date.now())
    timeline('backend-refused', { kind, detail: String(detail || '').slice(0, 120) })
    log(`[proxy] ${BACKENDS[kind]?.label ?? kind} 端口拒绝连接 → 立即标记离线`)
  } catch { /* 标记失败不影响请求本身 */ }
}

/**
 * "只读探测"路径 —— 这几个接口只用来问"后端在不在、忙不忙"，不做实际生成。
 *
 * 为什么要单独列出来 (2026-09-19 P3):
 *   后端没启动时，前端状态灯每 5 秒探一次 /system_stats、/queue、/status，每个都拿到 502,
 *   浏览器控制台红一片、服务端日志也刷屏。但"它没在跑"对探测来说是一个**正常答案**，
 *   不该用 5xx 表达 —— 502 只留给"真的要生成却连不上"那种情况(那里必须是人话错误)。
 */
const PROBE_PATHS = new Set(['/system_stats', '/queue', '/status'])

/** /api/models/health 的结果缓存(60 秒) —— 错误路径上不该反复扫盘 */
const modelsHealthCache = new Map()

async function proxyToLocal(req, res, route) {
  const rest = (req.url ?? '').slice(route.prefix.length) || '/'
  /**
   * 提前失败前**必须把请求体排空**, 否则连接会被强制关掉。
   *
   * 现场 (2026-09-28 用户截图): 上传参考图是多部分(multipart)大 body, 后端那一刻不在答时,
   *   `p.on('error')` 里直接 `res.end(JSON)` —— 请求体还剩一多半没被读走, Node 关连接,
   *   浏览器看到的就是 `TypeError: Failed to fetch`(截图里"原话"那句),
   *   我们写好的"模型没在运行｜怎么办：点顶部「模型」启动它"根本传不到页面上。
   *   文生图没有请求体 → 一直没事, 这也正是"文生图/Krea2 正常, 带参考图上传才失败"的原因。
   *   (理论上服务端可以回早响应, 但**必须在读完 body 之后**再关连接。)
   */
  const drainReqThen = (capMs = 10_000) => new Promise((resolve) => {
    if (req.readableEnded || req.complete) return resolve()
    let done = false
    const fin = () => { if (!done) { done = true; clearTimeout(timer); resolve() } }
    const timer = setTimeout(fin, capMs)
    req.on('end', fin)
    req.on('close', fin)
    req.on('error', fin)
    try { req.resume() } catch { fin() }
  })
  /** 统一的"提前失败"出口: 排空请求体 → 带上 Connection: close 再回 JSON */
  const failEarly = async (status, body, extraHeaders = {}) => {
    await drainReqThen()
    if (!res.headersSent) {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v)
      res.setHeader('Connection', 'close')
    }
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }
  // ---- 按需启动的兜底 (lazy 模式) ----
  // 用户没有主动启动后端, 但请求已经打到它的端口了 (例如点了生成)。这时一边把后端拉起来,
  // 一边立刻返回 503 + 机器可读的标记, 让前端把"正在启动"显示出来并稍后重试 ——
  // 绝不能让这个请求挂在那里等 1~3 分钟, 那会表现为"点生成没反应"。
  // 反过来, 只要请求进来就把后端拉起, 也就等于"用哪个起哪个", 不需要用户理解后端概念。
  const kindForRoute = BACKEND_OF_ROUTE[route.prefix]
  // 手动启动模式下**不**做代理兜底拉起 —— 用户要求"不点启动就不该自己起来"
  if (kindForRoute && lazyBackendsEnabled() && !manualStartEnabled()) {
    const live = BACKEND_PROCS.get(kindForRoute)
    if (!live || live.exited) {
      const r = await launchBackend(kindForRoute)
      if (r && r.ok) {
        await failEarly(503, {
          ok: false, starting: true, kind: kindForRoute,
          msg: `${BACKENDS[kindForRoute].label} 正在启动, 请稍候重试`,
          detail: r.detail || '',
        }, { 'Retry-After': '5' })
        return
      }
      /**
       * 被"另一路正在启动"的守卫拦下 (2026-10-06): 这不是"马上就好", 不能回 503 ——
       *   前端对 502/503 的 JSON 会**一直等它上线再重发**(见 services/backendGate.ts),
       *   而这一路是被我们自己拒绝的, 等多久都不会起来。直接给 409 + 人话, 让用户看到原因。
       */
      if (r && r.conflict) {
        await failEarly(409, {
          ok: false, conflict: true, starting: r.starting === true, kind: kindForRoute,
          msg: r.msg || `${BACKENDS[kindForRoute].label} 暂时不能启动`,
          detail: r.detail || '',
        })
        return
      }
      // 启动失败 (未安装/已停用/环境缺失) → 走下面正常转发, 由 502 分支给出人话错误
      if (r && r.detail) log(`[lazy] ${kindForRoute} 无法按需启动: ${r.detail}`)
    }
  }
  const headers = { ...req.headers }
  // ComfyUI 对带 Origin/Referer 的请求一律 403, 转发前剥离
  delete headers.origin
  delete headers.referer
  headers.host = `127.0.0.1:${route.port}`

  const indexttsTts = route.prefix === '/indextts' && /^\/tts(?:\?|$)/.test(String(rest || ''))
  let indexttsLeaseDone = false
  const releaseIndexttsLease = () => {
    if (!indexttsTts || indexttsLeaseDone) return
    indexttsLeaseDone = true
    indexttsLeaseEnd()
  }
  if (indexttsTts) indexttsLeaseStart()
  if (indexttsTts && indexttsBusy === 1) {
    const exclusive = await ensureIndexttsExclusive()
    if (!exclusive.ok) {
      indexttsLeaseEnd()
      await failEarly(409, {
        ok: false,
        error: `${BACKENDS[exclusive.other]?.label || exclusive.other} 正在生成，语音不能同时跑｜`
          + '怎么办：等它跑完，或先到顶栏「模型」停掉它，再生成语音',
      })
      return
    }
  }

  const p = http.request({
    host: '127.0.0.1', port: route.port, method: req.method, path: rest, headers,
  }, (pres) => {
    /** 上游已经回包 = 推理结束，租约可以释放（下载 wav 的字节不算推理）。 */
    pres.once('end', releaseIndexttsLease)
    pres.once('close', releaseIndexttsLease)
    res.writeHead(pres.statusCode ?? 502, pres.headers)
    pres.pipe(res)
  })
  /**
   * 客户端提前关连接**不释放**租约：后端可能还在推理（日志里 3 分钟断连后它继续跑到 15 分钟）。
   * 只有上游真正结束/报错才释放，否则会在推理中途把 H3/Qwen 放进来抢显存。
   */
  /**
   * ★ 2026-10-12 审计 §2.4: 这条上游请求以前**没有超时**。
   *   后端进程活着、端口在听, 但对某个请求长时间不回包(大算子卡住 / 半开连接)时,
   *   这个请求连同它的 socket 缓冲会**永久占着**, 而且前端重试会越堆越多 ——
   *   表现就是用户说的"点了生成没反应"。
   * 现在: 上游**连续 N 秒一个字节都没有**才断开(是空闲超时, **不是总时长** ——
   *   流式下载、长响应照常, 只要还有数据在走就不会被掐)。
   * ⚠️ 这里 destroy 会走下面的 `p.on('error')` 统一出口(排空请求体 + 回人话错误), 不另写一套。
   */
  const proxyIdleMs = proxyIdleMsFor(route.prefix, rest)
  p.setTimeout(proxyIdleMs, () => {
    const idleSec = Math.round(proxyIdleMs / 1000)
    const k = BACKEND_OF_ROUTE[route.prefix]
    if (k) markBackendOffline(k, `上游 ${idleSec} 秒没有响应`)
    log(`[proxy] ${k ? BACKENDS[k].label : route.prefix} 上游 ${idleSec}s 无响应 → 主动断开(见审计 §2.4)`)
    const err = new Error(`上游 ${idleSec} 秒没有响应`)
    err.code = 'AICS_PROXY_IDLE'
    err.idleSec = idleSec
    try { p.destroy(err) } catch { /* ignore */ }
  })
  p.on('error', async (e) => {
    releaseIndexttsLease()
    /**
     * ★ 2026-10-12 审计 §3.9: 这个监听器是 **async** —— 里面一旦抛出来(比如往已断开的连接写响应),
     *   就是一次 **unhandledRejection**, 而 Node 15+ 默认**直接终止进程**(整个程序没了)。
     *   这里把整段包起来自己吞掉: 错误处理本身失败, 也绝不该把服务带走。
     */
    try {
    // ── 人话错误 + 立即标离线 (P0 修复) ──
    const kind = BACKEND_OF_ROUTE[route.prefix]
    const refused = e?.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(e?.message ?? '')
    if (kind && refused) markBackendOffline(kind, e.message)
    const label = kind ? (BACKENDS[kind]?.label ?? '本地模型后端') : '本地模型后端'
    /**
     * 只读探测路径 + 后端确实没在跑 → **回 200 + 机器可读的 offline 标记** (2026-09-19 P3)。
     *
     * 为什么: 502 会被浏览器判成"请求出错"打在控制台(红字), 服务端也会记一笔 ——
     *   可"它没在跑"对探测来说就是正常答案, 前端只要拿这个事实把状态灯变红就行。
     * 只对 /system_stats、/queue、/status 这么做; 真正要干活的路径(/prompt、/view…)
     *   仍然回 502 + 人话错误(那里用户正在点生成, 必须看到原因)。
     */
    if (kind && refused && PROBE_PATHS.has(rest.split('?')[0])) {
      await failEarly(200, {
        ok: false, offline: true, probe: true, kind,
        msg: `${label} 未在运行`,
        detail: e.message,
      })
      return
    }
    const tail = kind ? lastLogLines(kind, 3) : []
    const lastLine = tail.length ? tail[tail.length - 1] : ''
      /**
       * ★ 2026-10-12 审计 §2.4: **空闲超时**那条要单独说清楚 —— 它不是"没启动"(端口在听、进程在跑),
       *   也不是"网络抖一下", 而是这一路卡住了(大算子卡死 / 半开连接)。给用户的出路是「重启」, 不是"等 10 秒重试"。
       */
      const idleSec = e?.idleSec ?? 0
      const msg = refused && kind
        // 日志尾巴也只留 120 字: 它是"原话"性质的东西, 不该把前两段挤走
        ? `生成失败：${label}没在运行｜怎么办：点顶部「模型」启动它，再点生成` + (lastLine ? `｜日志最后一行：${lastLine.slice(0, 120)}` : '')
        : idleSec > 0
          ? `生成失败：${label}长时间没有响应（已等 ${idleSec} 秒）｜怎么办：它可能卡住了，点「模型」里这一路的「重启」`
          : `生成失败：${label}没响应｜怎么办：等 10 秒重试；还不行点「重启」｜地址：127.0.0.1:${route.port}`
    await failEarly(502, {
      ok: false, kind: kind ?? null, offline: !!(refused && kind),
      msg, detail: e.message, tail,
    })
    } catch (err) {
      /** 见上面 try 的说明: 这里**必须**吞掉, 否则 async 监听器抛错 = unhandledRejection = 进程终止 */
      try { log(`[proxy] 错误处理本身失败(已吞掉, 不影响服务): ${err?.message ?? err}`) } catch { /* ignore */ }
    }
  })
  /** 客户端提前断开时别让管道把 error 抛到进程上 */
  req.on('error', () => { /* 忽略: 连接已断 */ })
  req.pipe(p)
}

function proxyToAgnes(req, res) {
  const rest = (req.url ?? '').slice('/agnes'.length) || '/'
  const headers = { ...req.headers }
  /**
   * ★ 2026-10-12 两站彻底分开: 这条老链路(剧本卡)原来把上游**写死**成 `apihub.agnes-ai.com`(国际站),
   *   key 也只认国际站那条连接 —— 用户若只登记了「Agnes 中国站」, 剧本卡必然回 401「无效的令牌」。
   *   现在: 上游 host 跟着**用户实际登记的那条连接**走(优先国际站, 没有再退中国站);
   *   只有在"一条 Agnes 连接都没有"时才回落到 .env 里的老国际站 key 与地址。
   *   原则: **绝不把中国站的 key 发到国际站的地址上**(发错门 = 凭据外泄, 而且 100% 401)。
   */
  const conn = store.getConnByPlatform('agnes') || store.getConnByPlatform('agnes-cn')
  let upstream
  try { upstream = new URL(conn?.baseUrl || AGNES_UPSTREAM) } catch { upstream = new URL(AGNES_UPSTREAM) }
  const key = conn ? apiKeyOf(conn) : envAgnesKey
  if (key) headers.authorization = `Bearer ${key}`
  headers.host = upstream.host

  const p = https.request({
    host: upstream.hostname, port: Number(upstream.port) || 443, method: req.method, path: rest, headers,
  }, (pres) => {
    res.writeHead(pres.statusCode ?? 502, pres.headers)
    pres.pipe(res)
  })
  p.on('error', (e) => {
    if (!res.headersSent) {
      res.statusCode = 502
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
    }
    res.end(JSON.stringify({ ok: false, msg: '云端 Agnes 请求失败', detail: e.message }))
  })
  req.pipe(p)
}

// ---------------------------------------------------------------- 静态文件

/**
 * 静态文件响应 (带 **HTTP Range 支持**)。
 *
 * ⚠️ 2026-09-18 修 (用户反馈"生成完的视频点播放没反应"): 以前一律 200 + 整文件,
 *   **不认 Range 头**。而浏览器的 <video> 是靠 Range 请求做"先取 moov、再按需取段"的:
 *   服务器不认 Range → 浏览器只能把整个文件下完再解析 → 实测 6MB/4K 视频要 **8 秒**
 *   才出第一帧(用户看到的就是"点了播放没反应"), 大文件更久, 拖动进度条也会失效。
 *   现在按 RFC 7233 返回 206 + Content-Range + Accept-Ranges, 起播/拖动都走按需取段。
 */
function serveFile(req, res, file) {
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return false
    const headers = {
      'Content-Type': mimeOf(file),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    }
    const rangeRaw = String(req?.headers?.range ?? '').trim()
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeRaw)
    if (m) {
      let start = m[1] === '' ? null : Number(m[1])
      let end = m[2] === '' ? null : Number(m[2])
      // 后缀范围 "bytes=-N" = 最后 N 字节
      if (start === null && end !== null) { start = Math.max(0, st.size - end); end = st.size - 1 }
      if (start === null) start = 0
      if (end === null || end >= st.size) end = st.size - 1
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` })
        res.end()
        return true
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 })
      fs.createReadStream(file, { start, end }).pipe(res)
      return true
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size })
    fs.createReadStream(file).pipe(res)
    return true
  } catch { return false }
}

function serveStatic(req, res, rootDir, urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '')
  const target = path.resolve(rootDir, rel)
  /**
   * 防目录穿越 (2026-09-20 · 代码评估报告 P1「前缀匹配漏判」)。
   *
   * 以前是 `target.startsWith(resolve(rootDir))` —— 经典漏判: 同级存在一个**名字以 rootDir 开头**
   *   的目录时就能穿出去。实测(rootDir = …/app/dist, 同级 …/app/dist-secret):
   *   `/../dist-secret/x.txt` 解析成 …/app/dist-secret/x.txt, 而它确实"以 …/app/dist 开头" → 放行。
   *   现在用 path.relative 判: 结果以 `..` 开头或为绝对路径 = 在根目录之外 → 拒。
   */
  const rootAbs = path.resolve(rootDir)
  const relToRoot = path.relative(rootAbs, target)
  if (relToRoot === '' ) return serveFile(req, res, target)
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return false
  return serveFile(req, res, target)
}

// ---------------------------------------------------------------- 主服务

/**
 * 本机服务门禁 (2026-09-20 · 代码评估报告 P1「本机 HTTP 服务无 Host / Origin 校验」)。
 *
 * 只监听 127.0.0.1 是必要的, 但**不充分**:
 *   ① CSRF: 任意网页里 `fetch('http://127.0.0.1:5173/api/assets/delete?name=x.png', {method:'POST'})`
 *      属于"简单请求", 浏览器不会预检, 请求会被真的执行 —— 也就是"随便点开一个网页就能删你本地文件"。
 *      /api/backends/shutdown、/api/store/delete 这些同理。
 *   ② DNS rebinding: 攻击者把自己的域名解析到 127.0.0.1, 页面就成了"同源", 跨域读取限制也绕过了。
 *
 * 判据(命中即拒), 尽量只挡"从外部页面发起的":
 *   · Host 的主机名必须是 127.0.0.1 / localhost / ::1（rebinding 用的正是域名, 一击必中）
 *   · 带 Origin 且主机名不是本机 → 拒（跨站 fetch/XHR 一律带 Origin）
 *   · 带 Referer 且主机名不是本机 → 拒（img/form 这类不带 Origin 的跨站请求靠它兜）
 *   · Sec-Fetch-Site: cross-site → 拒（现代 Chromium/Edge 必带, 最省事的一道）
 * 放行: 程序自己的页面(同源)、Electron 主进程、本机命令行/脚本(curl、npm 脚本都没有 Origin)。
 */
function hostnameOfHostHeader(h) {
  const s = String(h || '').trim()
  if (!s) return ''
  if (s.startsWith('[')) {                       // [::1]:5173
    const i = s.indexOf(']')
    return s.slice(1, i < 0 ? undefined : i).toLowerCase()
  }
  const i = s.lastIndexOf(':')
  // 只有一个冒号才当 "主机:端口" 拆(纯 IPv6 不带方括号时冒号很多, 整串当主机名)
  return (i > 0 && s.indexOf(':') === i ? s.slice(0, i) : s).toLowerCase()
}
function hostnameOfUrl(u) {
  try { return new URL(String(u)).hostname.toLowerCase() } catch { return '' }
}
function isLocalHostname(n) {
  return n === '127.0.0.1' || n === 'localhost' || n === '::1' || n === '[::1]'
}

let gateBlockedCount = 0
let gateLastLogAt = 0
function localOnlyGate(req) {
  const hostRaw = String(req.headers.host || '')
  const hostName = hostnameOfHostHeader(hostRaw)
  if (!hostName) return { ok: false, why: '缺少 Host 头' }
  if (!isLocalHostname(hostName)) return { ok: false, why: `Host=${hostRaw}` }
  const origin = String(req.headers.origin || '')
  if (origin && origin !== 'null' && !isLocalHostname(hostnameOfUrl(origin))) {
    return { ok: false, why: `Origin=${origin}` }
  }
  const referer = String(req.headers.referer || '')
  if (referer && !isLocalHostname(hostnameOfUrl(referer))) {
    return { ok: false, why: `Referer=${referer}` }
  }
  const site = String(req.headers['sec-fetch-site'] || '')
  if (site === 'cross-site') return { ok: false, why: 'Sec-Fetch-Site: cross-site' }
  return { ok: true, why: '' }
}

/** 拦下来时记一条(节流: 首次 + 之后每 50 次), 万一挡到了自家功能, 日志里能立刻看出来 */
function logGateBlock(req, why) {
  gateBlockedCount += 1
  const now = Date.now()
  if (gateBlockedCount === 1 || now - gateLastLogAt > 60_000) {
    gateLastLogAt = now
    log(`[gate] 拒绝非本机来源的请求: ${req.method} ${String(req.url || '').slice(0, 120)} (${why}) 累计 ${gateBlockedCount}`)
  }
}

function createServer(embedded) {
  const server = http.createServer(async (req, res) => {
  const urlPath = (req.url ?? '/').split('?')[0]

  // 0) 门禁: 先挡住"从别的网页发过来的"请求, 再谈业务
  {
    const g = localOnlyGate(req)
    if (!g.ok) {
      logGateBlock(req, g.why)
      res.statusCode = 403
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, msg: '拒绝：这个请求不是从本机程序页面发起的', why: g.why }))
      return
    }
  }

  try {
    // 1) 本地 API
    if (urlPath.startsWith('/api/providers') || urlPath === '/api/api-platforms') return await handleProviders(req, res)
    // 云端文字 / 图片生成 (走已登记的连接, key 不下发前端)
    if (urlPath === '/api/cloud-text') return await handleCloudText(req, res)
    if (urlPath === '/api/cloud-image') return await handleCloudImage(req, res)
    // 云端视频任务: 提交/轮询/取消
        if (urlPath === '/api/autodl/status') return handleAutodlStatus(req, res)
        if (urlPath === '/api/autodl/session') return await handleAutodlSession(req, res)
        if (urlPath === '/api/autodl/upload') return await handleAutodlUpload(req, res)
        if (urlPath === '/api/cloud-video/submit') return await handleCloudVideoSubmit(req, res)
        if (urlPath === '/api/cloud-video/status') {
          /** ★ 2026-10-12 审计 §3.6: 只读接口**只认 GET** —— 以前谁来都能"POST 一下", 语义混乱且无 405 */
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, msg: '这个接口只认 GET' })
          return handleCloudVideoStatus(req, res)
        }
        if (urlPath === '/api/cloud-video/cancel') return await handleCloudVideoCancel(req, res)
        if (urlPath === '/api/cloud-video/pending') return handleCloudVideoPending(req, res)
        if (urlPath === '/api/cloud-video/ack' && req.method === 'POST') return await handleCloudVideoAck(req, res)
    if (urlPath === '/api/voices' || urlPath.startsWith('/api/voices/')) return await handleVoices(req, res)
    if (urlPath === '/api/status') {
      /** ★ 2026-10-12 审计 §3.6: 只读接口只认 GET(见 /api/cloud-video/status 那条的说明) */
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, msg: '这个接口只认 GET' })
      return await handleStatus(req, res)
    }
    // 整机内存快照 (MB) —— 前端在"要不要自动关掉超分"这种预判里用它兜底:
    //   后端在线时优先用 ComfyUI system_stats 报的 ram_*, 后端刚起来还没探到时用这个。
    if (urlPath === '/api/mem') {
      const m = systemMemory()
      return sendJson(res, 200, { ok: true, totalMB: m.totalMB, freeMB: m.freeMB, totalGB: m.totalGB, pressure: m.pressure })
    }
    // 素材本地化: 生成产物复制到 data/assets/ 供离线加载 (问题3)
    if (urlPath === '/api/assets/localize' && req.method === 'POST') return await handleAssetsLocalize(req, res)
    /**
     * 落盘结果查询（2026-10-30）—— 前端打开历史/卡片时问一句"这条云端链接落到本地了吗"。
     *   GET  /api/assets/localized?url=…            → {ok, url: 本地地址或 '', pending}
     *   POST /api/assets/localized {urls:[…]}       → {ok, map:{远端:本地}, pending:N}
     *
     * 为什么要这个: 云端产物在服务端落盘是**异步**的（排队重试），前端那条历史里存的可能还是
     *   远端链接。每次打开历史时问一遍，命中了就把记录改成本地副本 —— 用户感知是"过一会儿就好了"，
     *   而不是"这条永远打不开"。顺带把还没落盘的 URL 排进队列（存量的老记录也能被补上）。
     */
    if (urlPath === '/api/assets/localized') return await handleAssetsLocalizedLookup(req, res)
    /** 落盘队列状态（诊断/支持用）: 还有几条没落下来、最近一次为什么失败 */
    if (urlPath === '/api/assets/localize-queue' && req.method === 'GET') {
      const q = loadLocalizeQueue()
      return sendJson(res, 200, {
        ok: true,
        pending: q.pending.length,
        done: q.stats.done,
        givenUp: q.stats.givenUp,
        items: q.pending.slice(0, 20).map((x) => ({
          url: x.url.length > 120 ? x.url.slice(0, 120) + '…' : x.url,
          tries: x.tries, lastError: x.lastError, firstAt: x.firstAt, lastAt: x.lastAt,
        })),
      })
    }
    /**
     * GET /api/h3/outputs?since=<ms> —— **上次没来得及登记的出片**(2026-10-12 用户报
     *   "生成视频的时候突然回到项目页面, 生成的内容也不见了")。
     *
     *   为什么需要它: 程序异常退出/被强关时, 前端那条任务的状态全没了, 但**后端可能已经把片子算完写盘了**;
     *   而"登记进历史/素材库"这一步是前端做的 —— 不做这一步, 用户就再也找不到那个文件(它静静躺在 output 里)。
     *   这里只**列出**比 since 新的视频文件(不复制、不改动任何东西), 由前端拿去走
     *   `/api/assets/localize` 收进素材库 + 写一条历史(带"上次没来得及登记"的注)。
     */
    if (urlPath === '/api/h3/outputs' && req.method === 'GET') {
      const since = Number(new URL(req.url ?? '', 'http://x').searchParams.get('since') ?? 0) || 0
      const root = P.outputDirs?.h3 ?? ''
      const items = []
      const walk = (dir, rel, depth) => {
        if (!dir || depth > 3 || items.length >= 60) return
        let entries = []
        try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          const abs = path.join(dir, e.name)
          if (e.isDirectory()) { walk(abs, rel ? `${rel}/${e.name}` : e.name, depth + 1); continue }
          if (!/\.(mp4|webm|mkv|mov)$/i.test(e.name)) continue
          let st = null
          try { st = fs.statSync(abs) } catch { continue }
          if (st.mtimeMs <= since) continue
          items.push({ filename: e.name, subfolder: rel, mtime: Math.round(st.mtimeMs), bytes: st.size })
        }
      }
      walk(root, '', 0)
      items.sort((a, b) => b.mtime - a.mtime)
      return sendJson(res, 200, { ok: true, root, since, items: items.slice(0, 20) })
    }
    // 用户上传素材: 落盘 + 只回路径 (替代把 base64 塞进节点数据)
        if (urlPath === '/api/assets/put' && req.method === 'POST') return await handleAssetsPut(req, res)
        if (urlPath === '/api/assets/put-blob' && req.method === 'POST') return await handleAssetsPutBlob(req, res)
    if (urlPath === '/api/assets/file' && req.method === 'GET') return handleAssetsFile(req, res)
    if (urlPath === '/api/assets/check' && req.method === 'POST') return await handleAssetsCheck(req, res)
    // 删除本地素材副本 (用户要求: 卡片删掉/历史里也要能把本地文件真删掉)
    if (urlPath === '/api/assets/delete' && req.method === 'POST') return await handleAssetsDelete(req, res)
    // 浏览器解不开的视频(HEVC/H.265) → 让模型包里的 python 出一张封面 (2026-10-07 · docs\63 遗留 b)
    if (urlPath === '/api/media/poster' && req.method === 'POST') return await handleMediaPoster(req, res)
    if (urlPath === '/api/license') return await handleLicense(req, res)
    if (urlPath === '/api/prompts') return handlePrompts(req, res)
    /**
     * ★ 2026-10-12 审计 §3.5: 迁移进度查询(设置面板在迁移期间轮询它)。只读, 不触发任何事。
     */
    if (urlPath === '/api/settings/migrate' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        running: !!MIGRATE?.running,
        state: MIGRATE ? { ...MIGRATE } : null,
      })
    }
    if (urlPath === '/api/settings') return await handleSettings(req, res)
    /**
     * 把模型目录加进 Windows Defender 排除项 (2026-10-11 用户要求"杀软排除")。
     *   会在系统里弹一次 UAC; 用户点"否"/没权限 → 如实回报失败(不假装成功)。
     */
    if (urlPath === '/api/antivirus/exclude' && req.method === 'POST') {
      const r = await addDefenderExclusion()
      log(`[antivirus] 加排除项: ${r.ok ? '成功' : '失败'} — ${r.msg || ''}`)
      return sendJson(res, 200, r)
    }
    /**
     * 权重页缓存预热 (2026-10-11): 后台顺序读这一路的大权重, 把内容顶进 page cache,
     * 真正启动时就少等磁盘。**一有后端要启动就自动中止**(见 launchBackend 开头的 cancelPrewarm)。
     */
    if (urlPath === '/api/backends/prewarm') {
      const kind = String(new URL(req.url ?? '', 'http://x').searchParams.get('kind') ?? '').toLowerCase()
      if (!BACKENDS[kind]) return sendJson(res, 400, { ok: false, msg: `未知后端: ${kind}` })
      if (req.method === 'GET') return sendJson(res, 200, { ok: true, state: prewarmState(kind) })
      /**
       * ★ 2026-10-12 审计 §2.1: 这也是"**真的把后端拉起来**"的入口(预热 = 起进程 + 加载权重),
       *   未激活时同样不许动 —— 与 /api/launch、/api/ensure 对齐。(上面的 GET 只是查状态, 不拦。)
       */
      { const blocked = licenseGateBlocked(); if (blocked) return sendJson(res, 403, blocked) }
      const r = await prewarmBackend(kind)
      return sendJson(res, 200, r)
    }
    // 模型包状态: 程序与模型分开更新后, 这里回答"模型装在哪、是哪个版本、能不能配合"
    if (urlPath === '/api/models') {
      /** ★ 2026-10-12 审计 §3.6: 只读接口只认 GET */
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, msg: '这个接口只认 GET' })
      return handleModels(req, res)
    }
    /**
     * 生成失败时的**模型文件体检** (2026-09-20 用户反馈误判):
     *   有些机器会弹"生成失败：模型文件不完整", 而用户根本没动过模型文件 —— 让他白白重下 60GB。
     *   这里给前端一个"下结论之前先核对"的接口: 按**这次生成真正会加载的那几个文件名**去查
     *   (只 readdir 比对名字, 毫秒级), 结论保守:
     *     · complete   → 文件都在, 报错文案里**不许**再提"文件不完整/重下"
     *     · incomplete → 明确缺哪个(只有这种情况才建议补模型包)
     *     · unknown    → 查不出来就什么都不说
     * 结果缓存 60 秒(模型目录不会秒变), 避免错误路径上反复扫盘。
     */
    if (urlPath === '/api/models/health' && req.method === 'GET') {
      const qs = new URL(req.url ?? '', 'http://x').searchParams
      const kind = String(qs.get('kind') ?? '').toLowerCase()
      // ⚠️ 用 MODEL_COMPONENTS（带 rel 布局信息）而不是 componentOf（那是"装没装"的快照, 没有 rel）
      const comp = MODEL_COMPONENTS.find((c) => c.key === kind)
      if (!comp) return sendJson(res, 400, { ok: false, msg: `未知后端: ${kind || '(空)'}` })
      /**
       * `need=` (2026-10-02): 调用方把**这次图里真正用到的文件名**列出来 —— 有它就**按这些名字核盘**,
       *   不再用 genFilesHealth 那份"至少有一只 turbo LoRA 就算齐"的 anyOf 清单。
       *   为什么(两次真机同现象): 老模型包只有 v4/850/8step 那几只 turbo LoRA → anyOf 判"齐全",
       *   可多参固定要的 lightx2v v0.1 其实不在 → 界面给"点重启、别重下"这种**没用的建议**。
       *   带上 need 之后: 都在盘上 → complete(该重启这一路) · 有缺的 → incomplete(该装最新模型包)。
       */
      const need = String(qs.get('need') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12)
      const cacheKey = need.length ? `${kind}|${[...need].sort().join(',')}` : kind
      const hit = modelsHealthCache.get(cacheKey)
      if (hit && Date.now() - hit.at < 60000) return sendJson(res, 200, { ok: true, kind, cached: true, ...hit.val })
      let val
      try {
        let h = genFilesHealth(P.backendsRoot, comp.rel, kind)
        if (need.length) {
          const spec = filesInComponent(P.backendsRoot, comp.rel, need)
          /**
           * ⚠️ 2026-10-12 用户: "模型有就是有，没有就是没有" —— 只有**穷举完确实没有**才许说"缺"。
           *   `exhaustive=false`(目录太多没扫完 / 读不动) ⇒ 一律降级成 unknown(查不出来),
           *   宁可不下结论, 也不许把"我们没扫全"说成"你缺文件"。
           */
          h = spec.exhaustive
            ? (spec.missing.length
              ? { level: 'incomplete', missing: spec.missing, found: spec.found }
              : { level: 'complete', missing: [], found: spec.found })
            : { level: 'unknown', reason: '模型目录太大/读不全, 这次没扫完(不下结论)', missing: spec.missing, found: spec.found }
        }
        const st = componentStatus(P.backendsRoot, comp, { quick: true })
        val = {
          level: h.level,
          missing: h.missing ?? [],
          found: h.found ?? [],
          reason: h.reason ?? '',
          need,
          /** 这一路额外挂的模型目录(extra_model_paths.yaml) —— 排障时能看出"为什么后端能列出包外的文件" */
          extraRoots: (h.extraRoots ?? []).slice(0, 6),
          installed: st ? st.installed : null,
          missingMarkers: st ? st.missingMarkers : [],
          root: P.backendsRoot,
        }
      } catch (e) {
        val = { level: 'unknown', reason: String(e?.message ?? e).slice(0, 200) }
      }
      modelsHealthCache.set(cacheKey, { at: Date.now(), val })
      return sendJson(res, 200, { ok: true, kind, ...val })
    }
    // 模型包"一次到位"安装: 选一个目录 → 自动认领里面的模型包(2026-09-16 用户要求)
    if (urlPath === '/api/models/pick-dir' && req.method === 'POST') return await handlePickDir(req, res)
  if (urlPath === '/api/models/scan' && req.method === 'POST') return await handleModelsScan(req, res)
  if (urlPath === '/api/models/install' && req.method === 'POST') return await handleModelsInstall(req, res)
  /** 卸载模型包 (2026-09-28 用户: "增加卸载模型的 选项") */
  if (urlPath === '/api/models/uninstall' && req.method === 'POST') return await handleModelsUninstall(req, res)
  if (urlPath === '/api/models/uninstall/status') return handleModelsUninstallStatus(req, res)
    if (urlPath === '/api/models/install-status' && req.method === 'GET') return sendJson(res, 200, { ok: true, task: installTask })
    // 首启自检: 六项体检 (显卡驱动/内存/磁盘/模型分层/端口/后端), 每项带可执行的下一步
    if (urlPath === '/api/selfcheck') {
      /**
       * ★ 2026-10-12 审计 §3.6: 这个接口会**真扫盘**(而且里面还有同步子进程), 以前 `POST /api/selfcheck`
       *   能随便触发一遍 —— 只读的东西就该只认 GET。
       */
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, msg: '这个接口只认 GET' })
      return await handleSelfCheck(req, res)
    }
    // 本地文档存储: 磁盘存真相, localStorage 只当启动缓存 (见 handleStore* 的说明)
    if (urlPath === '/api/store/list' && req.method === 'GET') return handleStoreList(req, res)
    if (urlPath === '/api/store/get' && req.method === 'GET') return handleStoreGet(req, res)
        if (urlPath === '/api/store/put' && req.method === 'POST') return await handleStorePut(req, res)
        if (urlPath === '/api/store/delete' && req.method === 'POST') return await handleStoreDelete(req, res)
    // 打开某一路后端的日志窗口 (后端仍由应用托管, 关窗口不停后端)
    // 直接读磁盘日志尾部 (内存 tail 为空时的兜底, 例如后端是上一轮进程或手工启动的)
    if (urlPath === '/api/backends/log' && req.method === 'GET') return handleBackendLog(req, res)
    // 一站式日志文本(启动界面的"复制日志"用它): 环境摘要 + 时间线 + 三路后端 + 应用/崩溃日志
    if (urlPath === '/api/logs/bundle' && req.method === 'GET') return await handleLogsBundle(req, res)
    /**
     * 前端(渲染进程)报错落盘 —— 2026-10-16。
     * 与上面那条是一对: bundle 负责"把日志读出来", 这条负责"把界面的报错写进去",
     * 两边落到**同一本** data/logs/app-<日期>.log, 所以导出包里自动就有前端日志。
     */
    if (urlPath === '/api/applog' && req.method === 'POST') return await handleAppLog(req, res)
    if (urlPath === '/api/backends/log-window') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, msg: 'POST only' })
      const kind = String(new URL(req.url ?? '', 'http://x').searchParams.get('kind') ?? '').toLowerCase()
      const r = openBackendLogWindow(kind)
      return sendJson(res, 200, { ...r, kind })
    }
    if (urlPath === '/api/launch' || urlPath === '/api/launch-h3') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, msg: 'POST only' })
      // 未激活不启动模型 (门禁落在真正干活的入口上, 不只是界面)
      { const blocked = licenseGateBlocked(); if (blocked) return sendJson(res, 403, blocked) }
      let name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? ''
      if (!name) name = String((await readBody(req, res)).name ?? '')
      if (urlPath === '/api/launch-h3') name = 'h3'
      name = name.toLowerCase()
      // 手动启动模式: 只放行"用户显式点击"(user=1); 屏蔽掉前端打开页面时的自动拉起
      const explicitLaunch = new URL(req.url ?? '', 'http://x').searchParams.get('user') === '1'
      if (manualStartEnabled() && !explicitLaunch) {
        return sendJson(res, 200, {
          ok: false, skipped: true, manual: true, kind: name,
          msg: `${BACKENDS[name]?.label ?? name} 未自动启动`,
          detail: '当前是手动启动模式：请点「启动」或「一键启动」',
        })
      }
      // 进程活着、端口却不响应 = 卡死。以前点「启动」只会回一句"已在运行", 用户只能重启整个程序;
      // 现在如实回报, 由用户确认后走「重启」把它掀掉重来 (2026-09-14 用户反馈第 2 条)。
      if (explicitLaunch) {
        const stuck = await stuckBackend(name)
        if (stuck) return sendJson(res, 200, { ok: false, stuck: true, kind: name, ...stuck })
      }
      // force=1 = 用户已经确认"就算另一路正在生成也要抢资源"(会中断它) —— 见 launchBackend 里的说明
      const forceLaunch = new URL(req.url ?? '', 'http://x').searchParams.get('force') === '1'
      const r = await launchBackend(name, { force: forceLaunch })
      return sendJson(res, r.ok ? 200 : 500, r)
    }
    // 按需启动: 前端在"要生成东西"前调一次, 把目标后端拉起来 (幂等; 已运行时直接返回)
    if (urlPath === '/api/ensure') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, msg: 'POST only' })
      /**
       * ★ 2026-10-12 审计 §2.1: **门禁只有落在"真正做事的那个入口"上才算数**。
       *   `/api/launch` 有这道闸, `/api/ensure` 以前**没有** —— 于是发行版未激活时,
       *   地址栏或改过的前端只要 `POST /api/ensure?kind=h3&user=1`, 一样能把本地模型拉起来,
       *   授权形同虚设(见 licenseGateBlocked 自己的注释: "只有落在真正做事的入口上才算数")。
       *   这里与 /api/launch 的写法完全对齐。
       */
      { const blocked = licenseGateBlocked(); if (blocked) return sendJson(res, 403, blocked) }
      const kind = String(new URL(req.url ?? '', 'http://x').searchParams.get('kind') ?? '').toLowerCase()
      if (!BACKENDS[kind]) return sendJson(res, 400, { ok: false, msg: `未知后端: ${kind}` })
      // 手动启动模式: 只拦"自动代劳"那条路 (生成前的 ensure)。
      // ⚠️ 用户显式点「启动 / 一键启动」时必须放行 —— 否则按钮点了没反应(这里踩过一次)。
      const explicit = new URL(req.url ?? '', 'http://x').searchParams.get('user') === '1'
      if (manualStartEnabled() && !explicit) {
        const live = BACKEND_PROCS.get(kind)
        if (!live || live.exited) {
          return sendJson(res, 200, {
            /**
             * ★ 2026-10-12 审计 §2.3: **契约要和 /api/launch 对齐** —— 那边这个分支是
             *   `skipped:true, manual:true`, 而这里以前漏了 `skipped`; 前端 `ensureBackend` 的判据是
             *   `j.skipped === true && j.manual === true` ⇒ 匹配不上就掉进"等就绪"的 `for(;;)`,
             *   默认**干等 15 分钟**(卡片/队列挂"正在准备…")。这正是用户反复报的"点生成没反应"。
             *   ⚠️ 两个端点的返回体形状**必须**一起改: 只改一边就会再漂回去(加断言见 backend-truth / ensure-contract)。
             */
            ok: false, skipped: true, manual: true, kind,
            msg: `${BACKENDS[kind].label} 尚未启动`,
            detail: '当前是手动启动模式：请到「配置与启动」页点「启动」或「一键启动」',
          })
        }
      }
      // 卡死(进程在、端口不答)时明确回报, 前端据此提示"重启" —— 否则这里只会回"已在运行"
      const stuck = await stuckBackend(kind)
      if (stuck) return sendJson(res, 200, { ok: false, stuck: true, kind, ...stuck })
      const r = await launchBackend(kind)
      // 一律 200: "未安装/已停用"也是有效结论, 前端要原样显示, 不该被当网络错误吞掉
      return sendJson(res, 200, { ...r, kind, lazy: lazyBackendsEnabled() })
    }
    // 后端运行时快照 (前端进度条靠它; tail 是日志最后 60 行)
    // 默认走快路径(不跑分类, 分类要查 netstat/tasklist); 需要结论时加 ?diag=1
    if (urlPath === '/api/backends/runtime' && req.method === 'GET') {
      const wantDiag = new URL(req.url ?? '', 'http://x').searchParams.get('diag') === '1'
      const rt = backendRuntime()
      const out = {
        ok: true,
        backends: rt,
        gpu: gpuInfo(),
        // 用带 2 秒缓存的显存快照: 这个接口是 2 秒一次的轮询, 不该每次都同步跑 nvidia-smi
        memory: memPolicy(undefined, gpuMemoryCached()),
        cudaCompat: cudaCompat(),
        // 测试模式(12G 显存/32G 内存)开关状态 —— 界面据此显示一枚角标
        testLimits: testLimits(),
        /**
         * 「模型全量常驻」当前值 (2026-10-11) —— 顶栏「模型」抽屉据此决定:
         *   还要不要锁"一次只能启动一个模型"那条规矩(常驻开 = 起新的一路不停旧的, 前端就不该拦)。
         * 放在这个快照里是因为抽屉本来就为角标取它一次, 不必再加一次往返。
         */
        allModelsOnline: allModelsOnlineEnabled(),
        timeline: STARTUP_TIMELINE.slice(-80),
      }
      if (wantDiag) {
        const probes = {}
        for (const kind of Object.keys(BACKENDS)) probes[kind] = await probeBackend(kind)
        const gpu = gpuInfo()
        out.probes = probes
        out.diagnosis = {}
        for (const kind of Object.keys(BACKENDS)) out.diagnosis[kind] = classifyBackend(kind, probes[kind], rt[kind], gpu)
      }
      return sendJson(res, 200, out)
    }
    /**
     * 后端"在不在"的权威口径 (2026-09-20 · 用户核心反馈: "后台明明在, 也没报错, 前端却判它掉了/失败了")。
     *
     * 为什么不能只看 HTTP 探针:
     *   ComfyUI 的 HTTP 服务与推理在**同一个事件循环**里。它一旦进入 VAE 解码 / RTX 超分 /
     *   20GB 权重加载这类长算子, 整段时间不接新请求 —— 前端 /system_stats 探针必超时。
     *   实测: H3 出片那一段直连 /system_stats 连续 3 次 12 秒不回, 而进程活着、端口在听、
     *   任务在正常推进。以前前端据此把状态灯判红, 用户以为挂了去点停止/重启 → 真把任务杀了。
     *
     * 这里给出一份**不依赖后端 HTTP 线程**的事实:
     *   · procAlive     —— 我们托管的那个进程还在吗(读我们自己的进程表, 零成本)
     *   · portListening —— 8188/8189/8190 端口有人在听吗(只做一次 TCP connect, 300ms 超时)
     *   端口在听 = 后端**在线**, HTTP 不答只说明它**忙**。前端据此把灯显示成"忙"(黄)而不是"掉线"(红)。
     * 结果缓存 1.5 秒: 前端三路并发探测时不会重复连。
     */
    /**
     * GET /api/backends/identity?kind=h3[&fresh=1]
     *
     * 生成前的“来源闸门”：先确认端口上连的是不是**本次安装**的 H3，再谈模型文件。
     * 返回 state / trusted / actual / expected / mismatches；外部 H3 与旧进程都 trusted=false。
     */
    if (urlPath === '/api/backends/identity' && req.method === 'GET') {
      const qs = new URL(req.url ?? '', 'http://x').searchParams
      const kind = String(qs.get('kind') ?? 'h3').toLowerCase()
      if (!BACKENDS[kind]) return sendJson(res, 400, { ok: false, msg: `未知后端: ${kind}` })
      const fresh = qs.get('fresh') === '1'
      const a = await assessBackendIdentity(kind, { ttlMs: fresh ? 0 : 20000 })
      let busy = null
      if (a.state !== 'free' && a.pid) {
        busy = await comfyQueueBusy(kind).catch(() => null)
      }
      return sendJson(res, 200, { ...a, kind, busy })
    }
    if (urlPath === '/api/backends/state' && req.method === 'GET') {
      const out = {}
      for (const kind of Object.keys(BACKENDS)) {
        const rec = BACKEND_PROCS.get(kind)
        const procAlive = !!(rec && !rec.exited)
        const portListening = await portListeningCached(kind)
        /**
         * ★ 2026-10-12: 端口上有人在听**不等于**"我们这一路在线" —— 可能是别人自己起的 ComfyUI,
         *   也可能是我们**另一路**串台坐在这儿。以前只看 TCP connect ⇒ 灯是绿的、点生成却各种怪错。
         *   现在给每路做一次身份核对(结论缓存 20s, 见 backendIdentityOnPort): 不是这一路 → **不报在线**,
         *   并把"被谁占着"如实带出去(前端显示"端口被占用"而不是绿的"空闲")。
         */
        let occupied = false
        let occupiedBy = null
        let identityInfo = null
        /**
         * 端口上那一份的**身份结论**(ours / ours-external / foreign / other-pack / unknown / free)。
         * ⚠️ 只在我们自己托管的进程不在(procAlive=false)时才去核对 —— 托管的进程活着就是我们自己。
         */
        let identity = 'ours'
        if (portListening && !procAlive) {
          const idn = await backendIdentityOnPort(kind)
          identity = idn.kind
          identityInfo = idn.identity ?? null
          if (idn.kind === 'foreign' || idn.kind === 'other-pack'
            || idn.kind === 'external-h3' || idn.kind === 'ours-unverified') {
            occupied = true
            occupiedBy = {
              pid: idn.holder?.pid ?? null, name: idn.holder?.name ?? '', kind: idn.otherKind || '',
              exe: String(idn.holder?.exe || '').slice(-160),
            }
          }
        }
        /**
         * ★ 2026-10-14 修（测试机实报: "接入云端 API 时, 生图模型下面会出两个本地模型;
         *   启动 K2 图生图时又自动把千问拉起来了"）。
         *
         * 病根就在下面这一行: 以前写的是 `(portListening && !occupied) || procAlive` ——
         *   而 `occupied` 只在认出 **foreign / other-pack** 时才为真,
         *   **身份判不出来(unknown)时它保持 false** ⇒ 端口上任何一个"认不出来的程序"
         *   都会被报成"这一路在线"(实测: 测试机上 8191 被别的程序占着, 千问被报成在线)。
         *
         * 后果是连锁的两步, 正是用户看到的两件事:
         *   ① 图片卡的「生图模型」是**按 online 列选项**的(见 ImageBody 的 localModelEnabled)
         *      → 冒出用户从没启动过的「Qwen-Image-2.1」;
         *   ② 生成时"哪一路在线就用哪一路"(GenerateButton 的 beKindLive)
         *      → 直接去 ensure 那一路, 把用户刚启动的 Krea2 停掉、转而**真把千问拉起来**。
         *
         * 现在改成**只有能确认是本路才算在线**:
         *   · procAlive —— 我们托管的那个进程还活着;
         *   · ours —— 端口上的进程 exe 就在我们这一路的模型包里;
         *   · ours-external —— 进程不在我们包里, 但它**确实以这一路的身份答话**(专属节点/权重)。
         * 认不出来(unknown) ⇒ **不算在线**, 也不算"被占用"(occupied 仍为 false) ——
         *   因为"被占用"会去拦用户手动启动, 而"认不出"不该阻塞任何人(与 backendIdentityOnPort
         *   自己那句"unknown 保守, 调用方不许据此拒启动"同一口径)。
         */
        const oursOnPort = portListening && (identity === 'ours' || (kind !== 'h3' && identity === 'ours-external'))
        out[kind] = {
          /**
           * ★ 2026-10-12: **实际在用**的端口 + 默认端口。
           *   默认端口被 Windows 保留段盖住时, 服务端会自动搬走(见 applyBackendPortAutoRelocate),
           *   前端显示端口号一律从这里取 —— 不然界面会说"端口 8188 被占着", 而其实早就不在 8188 上了。
           */
          port: BACKENDS[kind].port,
          defaultPort: BACKENDS[kind].defaultPort ?? null,
          /** 这一路是不是这次启动**被自动搬过**(前端据此弹一次说明, 见 app/src/services/backendPorts.ts) */
          relocated: BACKEND_PORT_RELOCATION[kind] ?? null,
          managed: !!rec,
          procAlive,
          portListening,
          /** 端口上那一份的身份结论(前端可据此区分"被占"与"认不出") */
          identity,
          /** H3: 安装实例 / 版本 / 契约的完整核对结果；其它路为 null */
          identityInfo,
          /** 综合口径: 我们托管的进程活着, 或端口上**确认是这一路** → 在线(忙不忙另说) */
          online: procAlive || oursOnPort,
          /** 端口被**别的**程序/别的路占着(不是这一路) —— 前端据此显示"端口被占用" */
          occupied,
          occupiedBy,
          pid: rec?.pid ?? null,
          exitCode: rec?.exitCode ?? null,
          signal: rec?.signal ?? null,
          lastLine: rec?.tail?.length ? String(rec.tail[rec.tail.length - 1]).slice(0, 200) : '',
          lastOutputAt: rec?.lastOutputAt ?? null,
        }
      }
      return sendJson(res, 200, {
        ok: true, ts: Date.now(), backends: out,
        /** 全部**实际在用**的端口(前端一次就能拿到, 不用逐路读) */
        ports: Object.fromEntries(Object.keys(BACKENDS).map((k) => [k, BACKENDS[k].port])),
        defaults: Object.fromEntries(Object.keys(BACKENDS).map((k) => [k, BACKENDS[k].defaultPort ?? BACKENDS[k].port])),
        relocated: BACKEND_PORT_RELOCATION,
      })
    }
    // 导出诊断包 (zip): 12 个文件 + 强制脱敏; 同时回传文本摘要(前端复制到剪贴板)
    if (urlPath === '/api/diagnostics/export' && req.method === 'POST') {
      const diag = await collectDiagnostics()
      const d = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
      const zipPath = path.join(P.dataDir, 'diagnostics', `Manke-诊断-${stamp}.zip`)
      writeZip(zipPath, diagEntries(diag))
      let bytes = 0
      try { bytes = fs.statSync(zipPath).size } catch { /* ignore */ }
      log(`[diag] 已导出诊断包 ${zipPath} (${bytes} 字节)`)
      return sendJson(res, 200, {
        ok: true, path: zipPath, dir: path.dirname(zipPath), bytes,
        summary: diag.summaryText, diagnosis: diag.diagnosis,
      })
    }
    // 只要文本摘要(几十字), 供"复制诊断信息发给管理员"
    if (urlPath === '/api/diagnostics/summary' && req.method === 'GET') {
      const diag = await collectDiagnostics()
      return sendJson(res, 200, { ok: true, summary: diag.summaryText, diagnosis: diag.diagnosis, gpu: diag.gpu })
    }
    /**
     * 停掉某一路"正在跑的活"(卡片上的取消/中断走后端):
     *   清排队的后续任务(立刻生效) + 请求中断当前任务 + 1.2 秒后复查。
     * 为什么不用前端直接打 /comfy/interrupt: 那样只发了中断、没清排队, 取消之后排队的
     *   任务会接着一个个跑(用户反馈里的"明明停了又自己生成"); 而且前端拿不到"到底停没停"
     *   这个事实, 只能干等。现在由服务端统一做并把 stillRunning 如实回报。
     */
    if (urlPath === '/api/backends/interrupt' && req.method === 'POST') {
      { const blocked = licenseGateBlocked(); if (blocked) return sendJson(res, 403, blocked) }
      const u = new URL(req.url ?? '', 'http://x').searchParams
      const k = (u.get('kind') ?? '').toLowerCase()
      if (!k || !BACKENDS[k]) return sendJson(res, 400, { ok: false, msg: `未知后端: ${k || '(空)'}` })
      // wait: 观察多久再下结论(取消 8 秒 / 其它场景 1.5 秒) —— 见 interruptBackend 里的说明
      const wait = Number(u.get('wait') ?? 1500)
      return sendJson(res, 200, await interruptBackend(k, { waitMs: Number.isFinite(wait) ? wait : 1500 }))
    }
    // 释放显存/内存(带核验)。前端手动按钮与 queueRunner 的任务级释放都走这里。
    if (urlPath === '/api/backends/free' && req.method === 'POST') {
      { const blocked = licenseGateBlocked(); if (blocked) return sendJson(res, 403, blocked) }
      const q = new URL(req.url ?? '', 'http://x').searchParams
      const want = q.get('kind') || 'all'
      const rawLevel = q.get('level')
      const level = rawLevel === 'cache' ? 'cache' : rawLevel === 'models' ? 'models' : 'auto'
      const nextKind = q.get('next') || ''
      /**
       * force=1 = **用户手点**的释放(卡片上的「释放显存」)。
       * 与自动释放的区别(2026-09-19 用户反馈"手动点了很久没反应, 像卡住"):
       *   ① 自动释放"后端正在生成就跳过"是为了不打扰生成 —— 但手动点了还跳过, 用户看到
       *      的就是"点了没反应", 而按钮当时还会谎报成功(见前端 freeMemory)。手动 = 照做。
       *   ② 手动释放前先"清排队 + 请求中断", 把还没开始的任务清掉; 正在跑的如果这个模型
       *      根本不吃中断信号(H3 就是这个情况), 就**如实回报** blocked, 由前端给出
       *      "停止后端(2 秒释放)"这条唯一可行的路, 而不是让用户干等。
       */
      const force = q.get('force') === '1' || q.get('force') === 'true'
      const kinds = want === 'all' ? Object.keys(BACKENDS) : [want]
      const results = []
      // ⚠️ 策略对象必须在循环外算一次并**传给 decideRelease** —— 漏传的话它会内部回退成
      // "只看内存"的 memPolicy(), 显存档位与显存紧急判定就全部失效(实测时理由里会写
      // "未检测到独显信息", 是发现这个 bug 的线索)。
      const mp = memPolicy(undefined, gpuMemoryNow())
      for (const k of kinds) {
        if (!BACKENDS[k]) { results.push({ ok: false, kind: k, reason: 'unknown-kind' }); continue }
        const probe = await probeBackend(k)
        if (!probe.online) { results.push({ ok: false, kind: k, reason: 'offline' }); continue }
        if (await comfyQueueBusy(k)) {
          if (!force) {
            // 自动释放: 生成中绝不打扰 —— 这是"不影响生成"的第一道保障
            results.push({ ok: true, kind: k, skipped: true, reason: '后端正在生成任务，暂不释放' })
            continue
          }
          // 手动释放: 先清排队 + 请求中断, 再看它到底停没停
          const it = await interruptBackend(k)
          if (it.stillRunning) {
            results.push({
              ok: false, kind: k, blocked: true, stillRunning: true, canStop: true,
              cleared: it.cleared, interrupted: it.interrupted,
              reason: '这个模型不响应中断，正在跑的任务还在占显存 —— 只有「停止」能把显存立刻还回来',
            })
            continue
          }
        }
        const plan = force
          ? { doIt: true, level: level === 'cache' ? 'cache' : 'models', reason: '手动释放' }
          : decideRelease(k, level, nextKind, mp, autoFreeEnabled())
        if (!plan.doIt) {
          results.push({ ok: true, kind: k, skipped: true, reason: plan.reason, policy: plan.policy?.policy, totalGB: plan.policy?.totalGB })
          continue
        }
        const r = await freeBackendNow(k, plan.level)
        r.reason = plan.reason
        r.policy = plan.policy?.policy
        log(`[mem] ${BACKENDS[k].label} 释放(${r.level}) -> ${r.released === false ? '未回落' : 'ok'} | ${plan.reason}${r.vramBefore != null ? ` | ${r.vramBefore} -> ${r.vramAfter} MiB` : ''}`)
        results.push(r)
      }
      return sendJson(res, 200, { ok: true, memory: mp, results })
    }

    if (urlPath === '/api/backends/shutdown' && req.method === 'POST') {
      { const blocked = licenseGateBlocked(); if (blocked) return sendJson(res, 403, blocked) }
      // ?name=kear → 只停这一路 (设置面板每张卡片的「停止」); 不带 name → 全停 (退出程序)
      const sp = new URL(req.url ?? '', 'http://x').searchParams
      const only = String(sp.get('name') ?? '').toLowerCase()
      const force = sp.get('force') === '1'
      if (only && !BACKENDS[only]) return sendJson(res, 400, { ok: false, msg: `未知后端: ${only}` })
      /**
       * 正在生成时不许悄悄停 (2026-09-20 · 用户反馈"视频模型后端挂掉/任务一直转"):
       *   实测日志里 H3 是被 `SIGTERM` 停掉的(不是它自己崩), 而停掉之后前端那条任务就永远转圈。
       *   现在: 这一路有任务在跑 → 先回 409 让前端确认("正在生成中, 确定要停?"), 用户确认后带 force=1 再来。
       *   (程序退出时的"全停"不受影响 —— 那种情况没有可确认的界面。)
       */
      if (only && !force) {
        const busy = await comfyQueueBusy(only).catch(() => false)
        if (busy) {
          return sendJson(res, 409, {
            ok: false, code: 'BUSY',
            msg: `${BACKENDS[only].label} 正在生成中，停止会让当前任务作废`,
          })
        }
      }
      await noteStop(only, only ? '用户点击了「停止」' : '程序退出，全部停止')
      return sendJson(res, 200, await shutdownBackends(only))
    }
    // 一键重启单个后端 (不退出软件)
    if (urlPath === '/api/backends/restart' && req.method === 'POST') {
      { const blocked = licenseGateBlocked(); if (blocked) return sendJson(res, 403, blocked) }
      let rk = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? ''
      if (!rk) rk = String((await readBody(req, res)).name ?? '')
      rk = rk.toLowerCase()
      const forceRestart = new URL(req.url ?? '', 'http://x').searchParams.get('force') === '1'
      if (rk && BACKENDS[rk] && !forceRestart) {
        const busy = await comfyQueueBusy(rk).catch(() => false)
        if (busy) {
          return sendJson(res, 409, {
            ok: false, code: 'BUSY',
            msg: `${BACKENDS[rk].label} 正在生成中，重启会让当前任务作废`,
          })
        }
      }
      const r = await restartBackend(rk, '用户点击了「重启」')
      return sendJson(res, r.ok ? 200 : 500, r)
    }
    if (urlPath === '/api/open-folder') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, msg: 'POST only' })
      return handleOpenFolder(req, res)
    }
    // 网页版外部工具 (豆包 / DeepSeek): 独立浏览器窗口 + data/profiles 持久化 profile
    if (urlPath === '/api/webapps' && req.method === 'GET') {
      return sendJson(res, 200, webAppState(P.webappProfileRoot))
    }
    if (urlPath === '/api/webapps/open' || urlPath === '/api/webapps/reset') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, msg: 'POST only' })
      const body = await readBody(req, res)
      const target = String(body.target ?? '')
      const isOpen = urlPath.endsWith('/open')
      const r = isOpen
        ? openWebApp(P.webappProfileRoot, target)
        : resetWebApp(P.webappProfileRoot, target)
      if (r.ok) log(`网页版: ${isOpen ? '打开' : '清除登录态'} ${target}`)
      return sendJson(res, r.ok ? 200 : 400, r)
    }

    // 2) 控制台已整合进应用落地页, /console 跳转过去
    if (urlPath === '/console' || urlPath === '/console/') {
      res.statusCode = 302
      res.setHeader('Location', '/')
      return res.end()
    }

    // 3) 反向代理
    if (urlPath === '/agnes' || urlPath.startsWith('/agnes/')) return proxyToAgnes(req, res)
    const route = matchRoute(urlPath)
    if (route) {
      // 裸地址(带不带尾斜杠) → 不暴露后端界面, 只给一句人话; 子路径照常代理
      const bare = urlPath === route.prefix || urlPath === route.prefix + '/'
      // 埋点: 有人"用浏览器打开后端地址"(顶层导航)就记一笔 ——
      // 用来定位"ComfyUI 界面又出现了"到底是谁打开的(参照页/请求来源一目了然)
      const navMode = String(req.headers['sec-fetch-mode'] || '')
      if (bare || navMode === 'navigate') {
        const line = [
          new Date().toLocaleString('zh-CN'), req.method, req.url,
          'mode=' + (navMode || '?'),
          'referer=' + (req.headers.referer || '(无)'),
          'ua=' + String(req.headers['user-agent'] || '').slice(0, 70),
        ].join(' | ')
        log('[nav] ' + line)
        try {
          ensureDir(LOG_DIR())
          fs.appendFileSync(path.join(LOG_DIR(), 'nav-hits.log'), line + '\n')
        } catch { /* ignore */ }
      }
      if (bare) return sendBackendLanding(res, route)
      return proxyToLocal(req, res, route)
    }

    /**
     * ★ 2026-10-12 审计 §3.1: 所有 API 分支都过完了, 还叫 `/api/**` 的一律 404。
     *
     *   以前这里没有兜底 ⇒ 未知的 `/api/*` 会落到下面的 SPA 回退, 返回 **200 + index.html**。
     *   实测确认过(装机版 `GET /api/definitely-not-a-route-xyz` → 200 + text/html) —— 于是
     *   "接口名写错 / 版本不匹配 / 这个接口已下线" 这些情况, 前端只拿到一句 JSON 解析错误,
     *   真因被完全盖住(审计报告把这一条列为中危, 判断是对的)。
     */
    if (urlPath === '/api' || urlPath.startsWith('/api/')) {
      return sendJson(res, 404, {
        ok: false,
        msg: `接口不存在: ${urlPath}｜怎么办：检查调用的路径名；若这个功能是新版才有的, 说明程序与前端版本不一致`,
      })
    }
    // 4) 静态资源 + SPA 回退
    //    /activate → 激活页 (独立静态页, 不走 SPA, 未授权时也能打开)
    if (urlPath === '/activate' && serveFile(req, res, path.join(P.distDir, 'activate.html'))) return
    if (urlPath !== '/' && serveStatic(req, res, P.distDir, urlPath)) return
    if (serveFile(req, res, path.join(P.distDir, 'index.html'))) return

    res.statusCode = 503
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(`<h2>前端产物缺失</h2><p>未找到 <code>${P.distDir}</code>。</p>`)
  } catch (e) {
    log('请求处理异常:', urlPath, e)
    if (!res.headersSent) sendJson(res, 500, { ok: false, msg: String(e) })
    else res.end()
  }
  })

  // WebSocket 升级转发 (ComfyUI 实时进度 /ws)
  server.on('upgrade', (req, socket, head) => {
    // 同一道门禁也要管 ws: 别的网页可以 new WebSocket('ws://127.0.0.1:5173/...') 顶着同源限制连进来
    {
      const g = localOnlyGate(req)
      if (!g.ok) {
        logGateBlock(req, g.why)
        socket.destroy()
        return
      }
    }
    const urlPath = (req.url ?? '').split('?')[0]
    const route = matchRoute(urlPath)
    if (!route || !route.ws) {
      socket.destroy()
      return
    }
    const rest = (req.url ?? '').slice(route.prefix.length) || '/'
    const upstream = net.connect(route.port, '127.0.0.1', () => {
      const headers = { ...req.headers }
      delete headers.origin
      delete headers.referer
      headers.host = `127.0.0.1:${route.port}`
      let raw = `${req.method} ${rest} HTTP/1.1\r\n`
      for (const [k, v] of Object.entries(headers)) {
        if (Array.isArray(v)) for (const vv of v) raw += `${k}: ${vv}\r\n`
        else raw += `${k}: ${v}\r\n`
      }
      raw += '\r\n'
      upstream.write(raw)
      if (head && head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
      /**
       * 建连之后换成**宽松**的空闲上限(见审计 §2.4): 进度 WS 在长算子里本来就可能安静几分钟,
       *   所以这里只用来兜"半开连接一辈子挂着", 20 分钟没一个字节才收掉。
       */
      upstream.setTimeout(WS_IDLE_MS(), () => {
        try { upstream.destroy() } catch { /* ignore */ }
        try { socket.destroy() } catch { /* ignore */ }
      })
    })
    /**
     * ★ 2026-10-12 审计 §2.4: 建连/握手阶段以前也没有上限 —— 上游半开(收下 SYN 不回)时
     *   这条 WS 会一直挂着, 只有 'error' 才会清理。10 秒建不起来就当它死了。
     */
    upstream.setTimeout(WS_CONNECT_MS(), () => {
      try { upstream.destroy() } catch { /* ignore */ }
      try { socket.destroy() } catch { /* ignore */ }
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log(`端口 ${PORT} 已被占用。可能已有一个 Manke 服务在运行。`)
      log(`可设 AICS_PORT 换端口, 例如: set AICS_PORT=5180 && node server.mjs`)
    } else {
      log('服务错误:', e)
    }
    // 作为库被 Electron 拉起时, 由 startServer 的 reject 统一处理退出, 不在这里强杀进程
    if (!embedded) process.exit(1)
  })

  return server
}

// ---------------------------------------------------------------- 离线授权 (/api/license)
//
// 设计取舍见 tools/license.mjs 头部。这里只做"取指纹 / 读状态 / 导入授权"三件事,
// 强制与否交给使用方 (环境变量 AICS_REQUIRE_LICENSE=1 时 Electron 主进程会拦启动)。

/** 机器指纹采集要拉一次 PowerShell (1~3s), 所以进程内缓存, 且只在真的访问授权时才采集 */
let machineCache = null
function machine() {
  if (!machineCache) machineCache = getMachineInfo({ dataDir: P.dataDir })
  return machineCache
}

async function handleLicense(req, res) {
  const method = (req.method ?? 'GET').toUpperCase()

  if (method === 'GET') {
    const m = machine()
    const status = licenseStatus(P.dataDir, m)
    return sendJson(res, 200, {
      ...status,
      fingerprintToken: fingerprintToken(m),
      /**
       * 指纹采集状态 (2026-10-02): 分量没采全时页面要提醒"先点重试再把这个码发出去"。
       * 为什么重要: 机器码是五个分量哈希拼出来的 —— 少一个分量就是**另一个码**,
       * 管理员按残缺码签发的授权, 客户端分量补齐后就永远对不上(实测踩过)。
       */
      machine: {
        code: m.code,
        present: m.present ?? [],
        partsCount: (m.present ?? []).length,
        partial: m.partial ?? (m.present ?? []).length < 5,
        /** 弱指纹 (≤2 个分量) 才需要提示重新采集; 4/5 是正常机器(主板 BIOS 序列号常是占位串) */
        weak: m.weak ?? (m.present ?? []).length < 3,
        frozen: m.frozen === true || m.cached === true,
        source: m.cached ? 'cache' : 'live',
      },
      /** 功能 key → 中文名 (同一份定义见 tools/license.mjs, 激活页据此显示中文) */
      featureLabels: FEATURE_LABELS,
      // 打包版 (embedded/packaged) 一律强制激活 —— 停在激活页, 激活后自动进主界面。
      // L1 改造: **不再接受 AICS_REQUIRE_LICENSE=0** 关闭拦截 —— 那是发行版里
      // 最短的一条绕过路径 (不改任何文件, 只加一个环境变量)。真正的门禁已移到
      // Electron 主进程 (app/electron/license-core.cjs, 在 app.asar 内), 这里的
      // 字段只用于界面提示。
      // 开发态 (node server.mjs 直跑) 默认宽限, 设 AICS_REQUIRE_LICENSE=1 才硬拦。
      requireLicense: licenseRequired(),
      parts: m.parts,
      present: m.present,
    })
  }

    if (method === 'POST') {
      const body = await readBody(req, res)
      /**
       * 「重新采集指纹」(2026-10-02 加)。
       *
       * 为什么需要它: 机器码现在是**冻结**的 —— 谁先采集谁把结果写进 data/machine.json,
       * 之后不再随采集结果漂移(这才是授权能长期有效的前提)。但万一第一次采集是残缺的
       * (冷启动 PowerShell 被安全软件拦着, 只拿到 1~4 个分量), 冻下来的就是个残缺指纹,
       * 页面上会亮一条提示, 并给一颗按钮让用户**显式**重采一次 —— 绝不会自己偷偷换码。
       *
       * 安全: 这里只删本机的 machine.json 再实时采集一遍(分量只能来自真实硬件),
       *       守卫由本进程重算 —— 无法用它把缓存伪造成"别的机器"。
       */
      if (body.action === 'refingerprint' || body.action === 'refresh-fingerprint') {
        try {
          const f = path.join(P.dataDir, 'machine.json')
          if (fs.existsSync(f)) fs.rmSync(f, { force: true })
          machineCache = null                       // 丢掉进程内缓存, 逼它重新采集
          const m2 = getMachineInfo({ dataDir: P.dataDir, refresh: true })
          return sendJson(res, 200, {
            ok: true,
            machineCode: m2.code,
            machine: {
              code: m2.code,
              present: m2.present ?? [],
              partsCount: (m2.present ?? []).length,
              partial: m2.partial ?? (m2.present ?? []).length < 5,
              weak: m2.weak ?? (m2.present ?? []).length < 3,
              frozen: true,
              source: 'live',
            },
            detail: '已重新采集本机指纹（机器码以这次为准）',
          })
        } catch (e) {
          return sendJson(res, 200, { ok: false, msg: '重新采集失败: ' + (e?.message ?? e) })
        }
      }
      if (body.action === 'clear' || body.action === 'deactivate') {
      // 只删本地授权文件; 已签发的授权串仍然有效, 用户可再次导入
      const gone = removeLicense(P.dataDir)
      return sendJson(res, 200, { ok: true, detail: gone ? '已清除本机授权' : '本机原本就没有授权文件' })
    }
    const key = String(body.key ?? '').trim()
    if (!key) return sendJson(res, 400, { ok: false, msg: '请粘贴授权串或 license.key 的内容' })

    // 先校验再落盘 —— 免得把垃圾文件持久化了还要用户手动清理
    const m = machine()
    const { verifyLicense } = await import('./tools/license.mjs')
    const r = verifyLicense(key, m)
    if (!r.ok) {
      return sendJson(res, 400, {
        ok: false,
        msg: r.reason ?? '授权校验未通过',
        machineCode: m.code,
        currentCode: r.currentCode,
      })
    }
    // 时间轴: 命中"硬回拨"(超过 24 小时)且处于严格模式时, 连激活都不让过。
    // 宽限模式 (默认) 只记录 + 提示, 免得时区/NTP 漂移把正常用户卡在门外。
    const clock = clockReport(P.dataDir, { force: true })
    if (clock.hardTamper && clock.strict) {
      return sendJson(res, 400, {
        ok: false,
        msg: `${clock.text} —— 请把系统时间校准后重试`,
        machineCode: m.code,
        clock,
      })
    }
    writeLicense(P.dataDir, key)
    log(`授权已激活: ${r.payload?.holder ?? '-'} / 到期 ${r.payload?.exp?.slice(0, 10) ?? '永久'}${
      clock.tamper ? ' · 时间告警: ' + clock.text : ''}`)
    return sendJson(res, 200, {
      ok: true,
      licensed: true,
      payload: r.payload,
      machineCode: m.code,
      detail: '激活成功',
      clock,
      warn: clock.tamper ? `${clock.text} · 已记录 (当前为宽限模式)` : undefined,
    })
  }

  return sendJson(res, 405, { ok: false, msg: 'method not allowed' })
}

// ---------------------------------------------------------------- 内置提示词 (/api/prompts)
//
// 为什么要走接口而不是打包进前端 bundle:
//   角色单/三视图、场景风格正负向、剧本体裁/题材/写法这些提示词是产品里最
//   容易被直接抄走的东西, 而它们原来明文躺在 dist 的 JS 里 (F12 一搜就有)。
//   现在构建时抽出来加密成 bundle/prompts.pack (见 tools/promptpack.mjs),
//   这里解密后下发, 前端 applyPromptPack() 回填。
//
// 顺带成了**授权功能的一部分**: 打包版未激活时直接 403 —— 试用期拿不到内置
// 提示词, 生成效果会有明显差距。开发态 (node server.mjs 直跑) 不拦, 方便改词。
/**
 * 未激活放行判断 (2026-09-15) —— 打包版未激活时, **不允许启动 / 重启 / 释放后端**。
 *
 * 为什么服务端也要拦一道: 界面上的门禁(app/src/components/LicenseGate.tsx)能挡住正常操作,
 * 但地址栏直接敲 /api/launch?name=h3&user=1 一样能把模型跑起来 ——
 * 门禁只有落在"真正做事的那个入口"上才算数。开发态 requireLicense=false, 不影响调试。
 *
 * 返回 null = 放行; 返回对象 = 拦截(直接 sendJson 403 给前端)。
 */
function licenseGateBlocked() {
  const requireLicense = licenseRequired()
  if (!requireLicense) return null
  const st = licenseStatus(P.dataDir, machine())
  if (st.licensed) return null
  return {
    ok: false,
    needActivation: true,
    msg: '尚未激活：这个版本未激活时不能启动本地模型',
    reason: st.reason ?? '尚未激活',
    machineCode: st.machineCode,
  }
}

function handlePrompts(req, res) {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method !== 'GET') return sendJson(res, 405, { ok: false, msg: 'method not allowed' })

  const requireLicense = licenseRequired()
  if (requireLicense) {
    const st = licenseStatus(P.dataDir, machine())
    if (!st.licensed) {
      return sendJson(res, 403, {
        ok: false,
        msg: '内置提示词需要激活后使用',
        reason: st.reason ?? '尚未激活',
        machineCode: st.machineCode,
      })
    }
  }

  // srcRoot 约定与 readVersionInfo 一致: 源码态 = 仓库根, 打包态 = bundle/
  const r = readPromptPack({ srcRoot: SRC_ROOT, packaged: P.packaged === true })
  if (!r.ok) {
    log(`[prompts] 读取失败: ${r.reason}`)
    return sendJson(res, 500, { ok: false, msg: r.reason })
  }
  return sendJson(res, 200, { ok: true, source: r.source, pack: r.pack })
}

// ---------------------------------------------------------------- 运行期设置 (/api/settings)
//
// 模型 (backends/) 不进安装包, 所以"模型放哪"必须可配。这里读写 data/settings.json,
// 前端设置页据此展示"当前指向的目录 / 是否已安装", 并允许改成任意盘符。

function settingsSnapshot() {
  const exists = (k) => {
    if (k === 'h3') return fs.existsSync(path.join(P.h3Root, 'python_embeded', 'python.exe'))
    if (k === 'kear') return fs.existsSync(path.join(P.kearRoot, 'python_embeded', 'python.exe'))
    if (k === 'qwen') return fs.existsSync(path.join(P.qwenRoot, 'env', 'python.exe'))
    return fs.existsSync(path.join(P.indexttsRoot, 'python_embeded', 'python.exe'))
  }
  return {
    ok: true,
    appRoot: P.appRoot,
    dataDir: P.dataDir,
    dataFallback: P.dataFallback === true,
    packaged: P.packaged,
    port: PORT,
    backendsRoot: P.backendsRoot,
    settings: P.settings,
    // 自动清理内存开关(显式值或按配置推导的默认值)
    autoFree: autoFreeEnabled(),
    /** 空闲自动卸载时长(分钟, 0=关闭) —— 与 autoFree 一样放顶层, 面板直接读 */
    idleFreeMinutes: idleFreeMinutes(),
    /** 模型全量常驻(关掉"独占在线") —— 面板据此显示开关状态与风险说明 */
    allModelsOnline: allModelsOnlineEnabled(),
    /**
     * 杀软排除状态 (2026-10-11): 模型包几十 GB 的大权重被 Defender 逐块扫描是"首次启动特别慢"的
     * 经典原因。面板据此显示"已排除 / 未排除"并给一键加入(UAC 一次)。
     */
    defender: (() => { const d = defenderState(); return { supported: d.supported, excluded: d.excluded, root: String(P.backendsRoot || ''), reason: d.reason } })(),
    /** 权重页缓存预热开关状态(面板据此显示开/关) */
    prewarmWeights: prewarmEnabled(),
    /** 给桌面/浏览器留的显存 (GB, 0=完全不预留; 改后需重启对应后端才生效) */
    desktopVramGB: desktopVramGB(),
    resolved: {
      h3: P.h3Root,
      kear: P.kearRoot,
      indextts: P.indexttsRoot,
      qwen: P.qwenRoot,
    },
    /** 三个后端的产物 (生成文件) 目录, 历史面板"打开文件夹"用 */
    outputDirs: P.outputDirs,
    /**
     * 存储位置 (2026-09-26): 用户配的值 + **实际生效的路径**。
     *   前者空字符串表示"用默认", 后者是界面要显示给人看的真实路径。
     */
    storage: {
      mediaDirs: {
        image: String(P.settings?.mediaDirs?.image ?? ''),
        video: String(P.settings?.mediaDirs?.video ?? ''),
        audio: String(P.settings?.mediaDirs?.audio ?? ''),
      },
      projectsDir: String(P.settings?.projectsDir ?? ''),
      effective: {
        image: mediaDirFor('image'),
        video: mediaDirFor('video'),
        audio: mediaDirFor('audio'),
        projects: storeDir(),
        defaultAssets: DEFAULT_ASSETS_DIR(),
        defaultStore: DEFAULT_STORE_DIR(),
      },
    },
    /** 是否就位。qwen 是第 4 路(可选): 没装也不影响 kear 的生图, 只是模型下拉里选了它会报"未安装" */
    installed: { h3: exists('h3'), kear: exists('kear'), indextts: exists('indextts'), qwen: exists('qwen') },
    /** 用户是否启用各后端 (未装/停用都不参与自动启动) */
    enabled: Object.fromEntries(
      Object.keys(BACKENDS).map((k) => [k, P.settings?.backendsEnabled?.[k] !== false]),
    ),
    /** 按需启动: true = 用到才起 (默认); false = 打开程序就预热三个后端 */
    lazy: lazyBackendsEnabled(),
  }
}

/**
 * POST /api/assets/put  { dataUrl }  → { ok, url }
 *
 * 用途: 用户上传的参考素材 (图/音/视频) 以前被前端读成 **base64 dataURL 直接塞进节点数据**,
 *   于是整份画布文档被撑大 —— 几张 JPEG 就能顶穿 localStorage 的 5MB 上限。
 *   现在改成"落盘 + 只存路径": 前端把 dataURL 传上来, 这里按内容哈希写进 data/assets/,
 *   返回 /api/assets/file?name=… (与生成产物共用同一套静态服务与目录)。
 * 幂等: 同一个文件重复上传只会命中同一份 (内容哈希命名), 不重复占盘。
 */
/**
 * POST /api/assets/put-blob?name=xxx.mp4   (body = 原始二进制)
 *
 * 用途: **用户从外部拖进画布的大素材**(视频/音频/大图)要落盘。
 *   这些文件以前只存在浏览器的 IndexedDB 里(清缓存/换 profile 就没了, 用户反馈"素材很容易丢"),
 *   走 dataURL 上传会多 33% 体积、几十上百 MB 还要在内存里拼字符串 —— 所以这里直接收二进制。
 *   命名仍然按内容哈希(与 /api/assets/put 同一套), 重复拖同一个文件不会重复占盘。
 * 上限 2GB; 超过就走 dataURL 那条老路也一样会被拒, 不如在这里明确拒绝。
 */
async function handleAssetsPutBlob(req, res) {
  const q = new URL(req.url ?? '', 'http://x').searchParams
  const orig = String(q.get('name') || 'file.bin')
  const extFromName = (orig.match(/\.([a-z0-9]{1,5})$/i)?.[1] || '').toLowerCase()
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  const extFromMime = ({
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp',
    'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  })[mime] || ''
  const SAFE = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'mp3', 'wav', 'm4a', 'ogg', 'mp4', 'webm', 'mov'])
  const ext = (extFromName && SAFE.has(extFromName)) ? extFromName
    : (extFromMime || 'bin')
  try {
    /**
     * ★ 2026-10-12 审计 §2.5 —— 原来这里是 `for await (const c of req) { … return sendJson(413) }`:
     *   ① 中途 `return` 会触发 async iterator 的 `return()` → 对 `IncomingMessage` 就是 **destroy()**,
     *      刚写出的 413 会被 **RST 吃掉**, 客户端只看到"连接被重置", 完全不知道是体积超限
     *      (同一个坑 `readBody` 顶部早就写着, 这里当时漏了);
     *   ② `chunks.push` 把**整包**攒在内存里 —— 上限 2GB, 真拖一个 2GB 进去就是 2GB 常驻内存。
     * 现在: 手动 data/end(**先排空再回 413**) + **边收边写临时文件**(增量算 sha1, 不占内存) +
     *   按写入背压 pause/resume, 收完再 `rename` 成内容寻址的正式名字。
     */
    const cap = BLOB_MAX_BYTES()
    const dir = path.dirname(assetPathFor(`x.${ext}`))   // 最终目录**只由扩展名决定**, 先算出来
    fs.mkdirSync(dir, { recursive: true })
    const tmp = path.join(dir, `.upload-${randomUUID()}.part`)
    const out = fs.createWriteStream(tmp)
    const hash = createHash('sha1')
    let total = 0
    const rmTmp = () => { try { out.destroy() } catch { /* ignore */ } try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ } }
    const received = await new Promise((resolve) => {
      let settled = false
      const done = (v) => { if (!settled) { settled = true; resolve(v) } }
      const onData = (c) => {
        total += c.length
        if (total > cap) {
          rmTmp()
          req.removeListener('data', onData)
          req.removeListener('end', onEnd)
          req.resume()   // 余下的字节照收照丢: 连接保持完好, 413 才送得到客户端
          if (!res.headersSent) sendJson(res, 413, { ok: false, msg: `文件太大（上限 ${Math.round(cap / 1024 / 1024)}MB）` })
          done(null)
          return
        }
        hash.update(c)
        if (!out.write(c)) {           // 背压: 磁盘跟不上就先别从套接字读
          req.pause()
          out.once('drain', () => { try { req.resume() } catch { /* ignore */ } })
        }
      }
      const onEnd = () => out.end(() => done('ok'))
      req.on('data', onData)
      req.on('end', onEnd)
      req.on('error', () => { rmTmp(); done(null) })
      out.on('error', () => { rmTmp(); done(null) })
    })
    if (received !== 'ok') return undefined    // 上面已经回过 413/断了, 这里什么都不用做
    if (total === 0) { rmTmp(); return sendJson(res, 400, { ok: false, msg: '内容为空' }) }
    const name = `${hash.digest('hex')}.${ext}`
    const f = assetPathFor(name)          // 按类型落到对应目录(上传的图/视频/音频)
    const existed = fs.existsSync(f)
    if (existed) fs.rmSync(tmp, { force: true })
    else fs.renameSync(tmp, f)            // 同目录改名: 原子, 不会留下半个文件
    return sendJson(res, 200, {
      ok: true, name, bytes: total, deduped: existed,
      url: `/api/assets/file?name=${encodeURIComponent(name)}`,
    })
  } catch (e) {
    return sendJson(res, 500, { ok: false, msg: `写入失败: ${e && e.message ? e.message : e}` })
  }
}

/**
 * 给"浏览器解不开的视频"补一张封面 (2026-10-07 · docs\63 遗留 (b))
 * ------------------------------------------------------------
 * 现场(真实数据实测): 用户拖进来的两个 mp4 是 **hvc1(HEVC/H.265)**, 文件完全正常
 *   (HTTP 200 / metadata 正常), 但 Chromium **没有 HEVC 解码器** —— `readyState=4` 而
 *   `videoWidth=0`, 前端抓帧**物理上**抓不出来, 只能"保留原封面 + 记原因 + 下次再试"。
 * 修法: 这类文件交给**模型包里的 python_embeded**(自带 PyAV/ffmpeg, HEVC 没问题)抓一帧,
 *   落成一张普通 jpg 素材 —— 前端拿到的就是一个和别的封面一模一样的
 *   `/api/assets/file?name=…jpg`, 从此不用再"换机器再试"。
 *
 * 为什么用模型包里的 python, 而不是去找一个 ffmpeg.exe:
 *   `P.h3Root` 是程序本来就认得的稳定路径(vite 启动脚本与后端识别都用它);
 *   模型包里那个 ffmpeg.exe 埋在 H3 控制台的 `resources\` 下, 路径没这层稳。
 * 为什么是**异步**子进程: 本地服务与窗口共用一条线程, 同步等 = 整片假死(与 7z 解压同一课)。
 *
 * 口径: `at` 默认 `5/24` 秒 —— 与前端 `POSTER_FRAME_OFFSET / POSTER_FPS`(片头往后第 5 帧)**同一个数**,
 *   由前端把值传上来, 这里只留一个兜底默认, 不另立第二处口径。
 * 幂等: 输出按**内容哈希**命名, 同一个视频抓第二次直接命中已有文件, 不重复占盘。
 */
const POSTER_FRAME_SECONDS = 5 / 24

/** 在模型包的 python 里跑的那段抓帧代码 (参数: 源文件 目标jpg 时间秒) */
const POSTER_HEVC_PY = `
import sys, json
def emit(o):
    print('@@' + json.dumps(o))
try:
    import av
except Exception as e:
    emit({'ok': False, 'msg': 'PyAV unavailable: %s' % e}); raise SystemExit(0)
src, dst, raw_at = sys.argv[1], sys.argv[2], float(sys.argv[3])
mode = sys.argv[4] if len(sys.argv) > 4 else ''
try:
    with av.open(src) as c:
        st = next((s for s in c.streams if s.type == 'video'), None)
        if st is None:
            emit({'ok': False, 'msg': 'no video stream'}); raise SystemExit(0)
        tb = float(st.time_base or av.time_base)
        duration = 0.0
        try:
            duration = float(st.duration * tb) if st.duration else 0.0
        except Exception:
            duration = 0.0
        if duration <= 0:
            try:
                duration = float(c.duration / av.time_base) if c.duration else 0.0
            except Exception:
                duration = 0.0
        at = max(0.0, duration - 0.05) if mode == 'last' and duration > 0 else max(0.0, raw_at)
        if mode == 'first':
            at = 0.0
        seek_at = min(at, max(0.0, duration - 0.1)) if duration > 0 else at
        # ⚠️ av 的 seek 只能落到**关键帧**: 直接取 seek 后的第一帧很可能就是第 0 帧(那段黑场)。
        #    所以再往后解几帧, 走到 >= at 为止(上限 240 帧, 防止关键帧间隔极长的怪文件卡住)。
        c.seek(int(seek_at / tb), stream=st)
        frame, n = None, 0
        for f in c.decode(st):
            n += 1
            frame = f
            if (f.time or 0) >= at or n >= 240:
                break
        if frame is None:                 # at 超过片长 → 退回第一帧, 总比没有强
            c.seek(0, stream=st)
            for f in c.decode(st):
                frame = f
                break
        if frame is None:
            emit({'ok': False, 'msg': 'no frame decoded'}); raise SystemExit(0)
        img = frame.to_image().convert('RGB')
        img.save(dst, quality=90)
        emit({'ok': True, 'codec': st.codec_context.name, 'w': img.size[0], 'h': img.size[1], 't': round(float(frame.time or 0), 3)})
except SystemExit:
    raise
except Exception as e:
    emit({'ok': False, 'msg': 'decode failed: %s' % e})
`

/** POST /api/media/poster { name, at? } → { ok, url, name, bytes, codec, at, t, size } */
async function handleMediaPoster(req, res) {
  const body = await readBody(req, res)
  const name = String(body?.name ?? '').trim()
  if (!name || /[\\/]/.test(name) || name.includes('..')) return sendJson(res, 400, { ok: false, msg: 'bad name' })
  const src = findAssetFile(name)
  if (!src) return sendJson(res, 404, { ok: false, msg: `找不到这个素材文件: ${name}` })
  const rawAt = Number(body?.at)
  /** 封面只需要片头，手动抓帧则要能到视频末尾；上限放到 1 小时，避免把异常请求拖死。 */
  const at = Number.isFinite(rawAt) && rawAt >= 0 ? Math.min(3600, rawAt) : POSTER_FRAME_SECONDS
  const mode = ['first', 'current', 'last'].includes(String(body?.mode ?? '')) ? String(body.mode) : ''
  const py = path.join(P.h3Root, 'python_embeded', 'python.exe')
  if (!fs.existsSync(py)) {
    return sendJson(res, 503, { ok: false, msg: '这台机器还没装视频模型包(缺 python_embeded), 这条兜底暂时用不了' })
  }
  const tmp = path.join(os.tmpdir(), `aics-poster-${process.pid}-${Date.now()}-${++capSeq}.jpg`)
  try {
    const r = await execCaptureAsync(py, ['-u', '-c', POSTER_HEVC_PY, src, tmp, String(at), mode], { timeout: 60000 })
    const line = String(r.stdout || '').split(/\r?\n/).filter((l) => l.startsWith('@@')).pop()
    let info = null
    try { info = line ? JSON.parse(line.slice(2)) : null } catch { info = null }
    if (!info?.ok) {
      const why = info?.msg || String(r.stderr || '').trim().split(/\r?\n/).slice(-2).join(' | ').slice(-300) || `python 退出码 ${r.status ?? '?'}`
      return sendJson(res, 500, { ok: false, msg: `后端也解不出这一帧: ${why}` })
    }
    const buf = fs.readFileSync(tmp)
    if (!buf.length) return sendJson(res, 500, { ok: false, msg: '后端抓到的帧是空的' })
    const outName = `${createHash('sha1').update(buf).digest('hex')}.jpg`
    const dst = assetPathFor(outName)
    if (!fs.existsSync(dst)) fs.writeFileSync(dst, buf)
    return sendJson(res, 200, {
      ok: true, name: outName, bytes: buf.length,
      url: `/api/assets/file?name=${encodeURIComponent(outName)}`,
      codec: info.codec ?? '', at: Number.isFinite(Number(info.t)) ? Number(info.t) : at,
      t: info.t ?? null, size: `${info.w ?? '?'}x${info.h ?? '?'}`,
    })
  } catch (e) {
    return sendJson(res, 500, { ok: false, msg: `写封面失败: ${e?.message ? e.message : e}` })
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
  }
}

async function handleAssetsPut(req, res) {
  const body = await readBody(req, res)
  const dataUrl = String(body?.dataUrl ?? '')
  const m = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/s.exec(dataUrl)
  if (!m) return sendJson(res, 400, { ok: false, msg: '只接受 base64 dataURL' })
  const mime = m[1].toLowerCase()
  const buf = Buffer.from(m[2], 'base64')
  if (!buf.length) return sendJson(res, 400, { ok: false, msg: '内容为空' })
  if (buf.length > 64 * 1024 * 1024) return sendJson(res, 413, { ok: false, msg: '文件过大 (上限 64MB)' })
  const ext = ({
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp',
    'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  })[mime] || 'bin'
  const name = `${createHash('sha1').update(buf).digest('hex')}.${ext}`
  try {
    const f = assetPathFor(name)
    if (!fs.existsSync(f)) fs.writeFileSync(f, buf)
    return sendJson(res, 200, {
      ok: true, name, bytes: buf.length,
      url: `/api/assets/file?name=${encodeURIComponent(name)}`,
      deduped: fs.existsSync(f),
    })
  } catch (e) {
    return sendJson(res, 500, { ok: false, msg: `写入失败: ${e && e.message ? e.message : e}` })
  }
}

// ---------------------------------------------------------------- 本地文档存储 (data/store)
//
// 背景: 项目/画布/素材/历史原先**只**存在浏览器的 localStorage 里 ——
//   上限 5MB、清缓存即丢、换端口换源就"消失"。这是长期最大的数据风险。
// 方案: 磁盘成为事实来源, localStorage 退化成"启动缓存"。前端每次落盘都镜像一份到这里;
//   若某次启动发现 localStorage 是空的(清了缓存/换了机器), 就从这里灌回去。
// 取舍: 接口保持极简 (list/get/put, 按 key 存取), 前端不用改任何数据结构。

const STORE_MAX_BYTES = 32 * 1024 * 1024   // 单份文档上限: 防止误传超大二进制把磁盘写满

/**
 * 项目管理目录 (2026-09-26 用户: "项目管理的位置也要可以自定义")。
 *   空 = 默认 <数据目录>/store。改目录时由 handleSettings 先**复制**一份过去(不删原件)再切换。
 */
function storeDir() {
  const d = P.settings?.projectsDir
  const s = typeof d === 'string' ? d.trim() : ''
  return s || DEFAULT_STORE_DIR()
}
function storeFileOf(key) {
  const hash = createHash('sha1').update(String(key)).digest('hex').slice(0, 24)
  return path.join(storeDir(), `${hash}.json`)
}
function readStoreIndex() {
  try {
    const f = path.join(storeDir(), 'index.json')
    if (!fs.existsSync(f)) return {}
    const j = JSON.parse(fs.readFileSync(f, 'utf-8'))
    return j && typeof j === 'object' ? j : {}
  } catch { return {} }
}
function writeStoreIndex(idx) {
  const dir = storeDir()
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, 'index.json')
  const tmp = `${f}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), 'utf-8')
  fs.renameSync(tmp, f)
}

/**
 * 日志窗口(独立控制台)的 PID 记录 —— ★ 2026-10-10 新增。
 *
 * 为什么需要: `openBackendLogWindow` 开的是一个 **detached** 的真实控制台窗口，里面跑
 *   `Get-Content … -Wait`（**会一直挂着**）。它由我们拉起，却不在 BACKEND_PROCS 里、也不在
 *   run-state 里 ⇒ 关软件时**没人管它** —— 用户看到的"关闭软件后还有残留进程"就有它一份。
 * 现在: 开窗口时把 PID 落到 `data\logwin\<kind>-<ts>.pid`（第二行写日志路径），退出时按
 *   **双重证据**（进程名是 powershell/pwsh + 命令行里能看到那个日志路径）精确关掉 ——
 *   双重证据是为了防 PID 复用误杀，与 pidIsOurs 同一个原则。
 */
const LOGWIN_DIR = () => path.join(P.dataDir, 'logwin')

/** 查一个 PID 的进程名与命令行（拿不到就给空） */
function processCmdInfo(pid) {
  const n = Number(pid)
  if (!n) return { name: '', cmdline: '' }
  try {
    const out = runCapture('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${n}"; if($p){ $p.Name + '|' + $p.CommandLine }`,
    ], 8000)
    const s = String(out).trim()
    const i = s.indexOf('|')
    return i < 0 ? { name: s, cmdline: '' } : { name: s.slice(0, i).trim(), cmdline: s.slice(i + 1) }
  } catch { return { name: '', cmdline: '' } }
}

/**
 * 关掉我们开的日志窗口。onlyKind 为空 = 全关（退出程序）；否则只关这一路的。
 * 返回被关掉的 `logwin#<pid>` 列表（进 stopped，便于日志里看出是谁关的）。
 */
function closeLogWindows(onlyKind = '') {
  const killed = []
  try {
    const dir = LOGWIN_DIR()
    if (!fs.existsSync(dir)) return killed
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.pid')) continue
      if (onlyKind && !f.startsWith(`${onlyKind}-`)) continue
      const p = path.join(dir, f)
      let pid = 0
      let logFile = ''
      try {
        const t = fs.readFileSync(p, 'utf8').split(/\r?\n/)
        pid = Number(String(t[0] ?? '').trim()) || 0
        logFile = String(t[1] ?? '').trim()
      } catch { /* ignore */ }
      try { fs.unlinkSync(p) } catch { /* ignore */ }
      if (!pid || !processAlive(pid)) continue
      const info = processCmdInfo(pid)
      if (!/^powershell|^pwsh/i.test(info.name)) continue
      // 命令行里要能看到那个日志路径 —— 否则不认（PID 可能已被复用）
      if (logFile && !info.cmdline.toLowerCase().includes(logFile.toLowerCase())) continue
      killTree(pid, true)
      killed.push(`logwin#${pid}`)
      log(`[backend] 已关闭日志窗口(pid ${pid})`)
    }
  } catch { /* ignore */ }
  return killed
}

/**
 * POST /api/backends/log-window?kind=
 *
 * 背景: 后端由应用**静默托管**(不弹窗口), 于是用户看不到任何输出了 —— 排障时无从下手。
 * 做法: 开一个真实控制台窗口, 用 PowerShell 实时跟随该后端的日志文件 (data/logs/*.log)。
 *   · 后端进程本身仍由应用托管 —— **关掉这个窗口不会停后端**
 *   · 想看原始输出、又不想让应用"弹一堆黑窗口"的用户, 需要时点一下即可
 */
function openBackendLogWindow(kind) {
  const b = BACKENDS[kind]
  if (!b) return { ok: false, msg: `未知后端: ${kind}` }
  const rec = BACKEND_PROCS.get(kind)
  const logFile = rec?.logPath || path.join(P.dataDir, 'logs', `${kind}.log`)
  if (!fs.existsSync(logFile)) {
    return { ok: false, msg: `还没有日志文件 (这一路还没启动过): ${logFile}` }
  }
  const title = `${b.label} 日志 - 关闭本窗口不会停止后端`
  /**
   * ★ 2026-10-10: 让窗口把自己的 PID 写下来（第二行写日志路径）——
   *   退出程序时 closeLogWindows() 靠这两条证据精确关掉它。
   *   注意：这里不再 detached 逃逸出托管，而是**登记在案**（原做法关软件后它会一直挂着）。
   */
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`
  const pidDir = LOGWIN_DIR()
  try { fs.mkdirSync(pidDir, { recursive: true }) } catch { /* ignore */ }
  const pidFile = path.join(pidDir, `${kind}-${Date.now().toString(36)}-${process.pid}.pid`)
  const psCmd = `Set-Content -LiteralPath ${q(pidFile)} -Value ($PID, ${q(logFile)}) -Encoding ascii; `
    + `Get-Content -LiteralPath ${q(logFile)} -Wait -Tail 200`
  spawn('cmd.exe', [
    '/c', 'start', `"${title}"`,
    'powershell', '-NoProfile', '-Command',
    psCmd,
  ], { detached: true, stdio: 'ignore', windowsHide: false, cwd: P.appRoot }).unref()
  return { ok: true, logFile, pidFile, detail: '已打开日志窗口 (实时跟随; 关窗口不影响后端运行; 退出程序时会自动关掉)' }
}

/**
 * GET /api/backends/log?kind=&lines=  —— 直接读**磁盘上的日志文件**尾部。
 *
 * 为什么需要它: 内存里的 tail 只对"本进程亲手拉起的后端"有效。
 *   · 8190 是上一次运行留下的进程 (服务重启后端口仍被占, 新进程没接管)
 *   · 或者后端是用户从排障 bat 手动启动的
 *   这两种情况下前端日志卡片拿到的是空数组, 看起来"日志一直没有"。
 *   日志文件本身一直都在写 (data/logs/<kind>-<日期>.log), 所以这里直接读文件。
 */
/**
 * GET /api/logs/bundle?lines=800
 *
 * "复制日志"按钮用的一站式文本: 环境摘要 + 启动时间线 + 三路后端日志 + 应用日志 + 崩溃日志。
 * 用户要求: 启动界面上的日志(启动阶段/自检结论)与运行中的所有日志信息**都要能一起复制**。
 * 只回文本(几十 KB), key/密码等敏感项走 diagSettings 的脱敏。
 */
async function handleLogsBundle(req, res) {
  const q = new URL(req.url ?? '', 'http://x').searchParams
  const lines = Math.max(50, Math.min(Number(q.get('lines')) || 800, 5000))
  const tailLines = (p) => {
    const txt = safeReadText(p, 2_000_000)
    const arr = txt.split(/\r?\n/).filter((l) => l.trim())
    /** 已知无害的行带上注解(见 annotateHarmlessLogLine) —— 复制日志时用户一眼能看懂 */
    if (arr.length <= lines) return annotateHarmlessLog(txt)
    return `…(仅保留最后 ${lines} 行, 共 ${arr.length} 行)\n${annotateHarmlessLog(arr.slice(-lines).join('\n'))}`
  }
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const parts = []
  let ver = ''
  try { ver = readVersionInfo()?.program?.version ?? '' } catch { /* ignore */ }
  parts.push(`Manke 日志汇总\n导出时间: ${stamp}${ver ? `\n程序版本: ${ver}` : ''}`)
  try {
    const diag = await collectDiagnostics()
    parts.push(`\n========== 环境摘要 ==========\n${diag.summaryText}`)
  } catch (e) {
    parts.push(`\n========== 环境摘要 ==========\n(收集失败: ${e?.message ?? e})`)
  }
  try { parts.push(`\n========== 启动时间线 ==========\n${diagTimeline()}`) } catch { /* ignore */ }
  for (const kind of Object.keys(BACKENDS)) {
    const files = backendLogFiles(kind)
    const rec = BACKEND_PROCS.get(kind)
    const head = `\n========== 后端 · ${BACKENDS[kind]?.label ?? kind} ==========\n` +
      `托管状态: ${rec ? (rec.exited ? `已退出(码 ${rec.exitCode})` : '本进程托管中') : '不是本进程拉起的(读磁盘日志)'}\n` +
      `日志文件: ${files.length ? files.map((f) => path.basename(f)).join(', ') : '(无)'}`
    parts.push(head + (files.length ? `\n${tailLines(files[0])}` : '\n（这一路从未启动过，没有日志文件）'))
  }
  try {
    const dir = LOG_DIR()
    const apps = fs.readdirSync(dir).filter((n) => n.startsWith('app-')).sort().slice(-2)
    for (const f of apps) parts.push(`\n========== 应用日志 ${f} ==========\n${tailLines(path.join(dir, f))}`)
    if (!apps.length) parts.push('\n========== 应用日志 ==========\n(暂无应用日志)')
  } catch { /* ignore */ }
  try {
    const dir = LOG_DIR()
    const crashes = fs.readdirSync(dir).filter((n) => n.startsWith('crash-')).sort().slice(-2)
    for (const f of crashes) parts.push(`\n========== 崩溃日志 ${f} ==========\n${tailLines(path.join(dir, f))}`)
  } catch { /* ignore */ }
  const text = parts.join('\n')
  sendJson(res, 200, { ok: true, text, bytes: Buffer.byteLength(text, 'utf-8'), lines })
}

/* ============================================================
   渲染进程(前端)的报错也进**同一本**应用日志 —— 2026-10-16

   ★ 起因（用户）: "带服务器的软件都会有控制台, 可以调用机子的日志, 判断会全面一点,
     我们是否也可以建立类似的呢?" → 决定先补最缺的那一环。

   此前前端只有"结论"(弹给用户看的那句提示), **没有任何书面记录** —— 而恰恰有相当一部分
   "提示与实际不符"就发生在前端这条链(ComfyUI 的原话是**前端**翻译的, 见 services/friendlyError.ts)。
   没有病历, 事后复盘只能靠猜; 也没法把"见过的真实错误"沉淀成语料(docs/79 第三节要的东西)。

   落盘复用**同一个** appLogWrite ⇒ 写进 data/logs/app-<日期>.log ⇒
   「导出日志」与 /api/logs/bundle 里**自动**就带上它了, 读取端一行都不用改。

   三道闸(前端一旦报错风暴, 这里是最后一道):
     ① 截断: text ≤600 字、stack ≤1200 字(堆栈前十行足够定位, 再长只是噪音);
     ② 限流: 10 秒窗口最多 40 条, 超出只记一行"已丢弃 N 条" —— 绝不能把用户磁盘刷爆;
     ③ 脱敏: 只抹**明显是凭据**的形态(sk-/cpk-/Bearer/key=…), 别的长串(哈希文件名、
        张量 shape、堆栈路径)一律**原样保留** —— 它们正是排查证据, 抹了等于白记。
   ============================================================ */
const APPLOG_MAX_TEXT = 600
const APPLOG_MAX_STACK = 1200
const APPLOG_WINDOW_MS = 10_000
const APPLOG_WINDOW_MAX = 40
let appLogWindow = { at: 0, n: 0, dropped: 0 }

/** 把"明显是凭据"的片段抹掉(只在落盘前用; 见上面第 ③ 条: 别误伤证据) */
function redactAppLog(s) {
  return String(s ?? '')
    .replace(/\b(?:sk|cpk)-[A-Za-z0-9_-]{6,}/g, (m) => `${m.slice(0, 4)}***`)
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{6,}/gi, '$1***')
    .replace(/((?:api[_-]?key|apikey|key|token|secret|password|authorization)\s*[=:]\s*)[^\s&,'"）)]{6,}/gi, '$1***')
}

/**
 * 抹凭据 + 截断(超长时**留一个省略号**)。
 * ⚠️ 省略号不是装饰: 没有它, 读日志的人分不清"这条原文就这么长"和"被我们截了" ——
 *   后者会让人以为前端只报了半句, 从而往错的方向查。
 */
function clipAppLog(s, max) {
  const t = redactAppLog(s)
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * POST /api/applog   { level, text, stack?, where?, extra? }
 *   level: error | warn | info(默认 error)
 *   where: 出事的页面/组件(前端填 location.hash 或组件名), 只在日志里看一眼用
 * @returns { ok, dropped? } —— 被限流丢弃时 dropped=true(前端不必重试, 也不该报错)
 */
async function handleAppLog(req, res) {
  let body = null
  try { body = await readBody(req, res) } catch { /* 下面按空处理 */ }
  if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, msg: '需要 JSON' })

  /** ② 限流(滑动窗口): 超了就丢弃, 但如实记一行, 免得"日志爆了"这件事本身没人知道 */
  const now = Date.now()
  if (now - appLogWindow.at > APPLOG_WINDOW_MS) {
    appLogWindow = { at: now, n: 0, dropped: appLogWindow.dropped }
  }
  appLogWindow.n += 1
  if (appLogWindow.n > APPLOG_WINDOW_MAX) {
    appLogWindow.dropped += 1
    /** 限流提示本身也要限流: 每满 50 条才写一行, 否则它自己就把日志刷爆了 */
    if (appLogWindow.dropped % 50 === 1) {
      log(`[renderer] 前端日志过多, 已丢弃 ${appLogWindow.dropped} 条`
        + `（${Math.round(APPLOG_WINDOW_MS / 1000)} 秒窗口上限 ${APPLOG_WINDOW_MAX} 条）`)
    }
    return sendJson(res, 200, { ok: true, dropped: true })
  }

  const level = ['error', 'warn', 'info'].includes(String(body.level)) ? String(body.level) : 'error'
  const where = String(body.where ?? '').slice(0, 120)
  const extra = String(body.extra ?? '').slice(0, 200)
  const text = clipAppLog(body.text, APPLOG_MAX_TEXT)
  const stack = clipAppLog(body.stack, APPLOG_MAX_STACK)
  if (!text && !stack) return sendJson(res, 200, { ok: true, empty: true })

  /**
   * 显式带 [renderer:级别] 前缀 —— 以后在这些日志里一眼能分清
   * "这是界面报的" 还是 "这是服务端自己报的"(后者不带这个前缀)。
   */
  log(`[renderer:${level}] ${text}${where ? ` @${where}` : ''}${extra ? ` (${extra})` : ''}`)
  /** 堆栈单独一行(换行压成 ⏎, 一条日志就是一行一条, 便于 grep 与导出后阅读) */
  if (stack) log(`[renderer:${level}] stack: ${stack.replace(/\s*\n\s*/g, ' ⏎ ')}`)
  return sendJson(res, 200, { ok: true })
}

/**
 * 「看着像报错、其实无害」的后端日志行 → 在原行**后面**追加一句人话注解。
 *
 * 为什么需要 (2026-10-04 用户: "这次发了模型包之后，有一些机型出现了这个报错"):
 *   模型包为了省 1.2GB 剔掉了 ComfyUI 模板浏览器的示例图包(comfyui_workflow_templates_media_*)。
 *   新版 ComfyUI 核心启动时会为模板解析一遍图片路径 → 缺图就打
 *     `[ERROR] Failed to resolve template asset paths: ...`(老核心) 或
 *     `[ERROR] No workflow template assets found...`(新核心);
 *   另外核心还会拿自己的 requirements 跟包里自带的模板/前端包版本比, 打一段 "WARNING WARNING" 的升级提示。
 *   这三类都是**预期行为, 与生成无关**, 但用户/客户看到 [ERROR]/WARNING 会以为模型包坏了。
 *
 * 处理: 程序侧的容错补丁(见 tools/comfy-templates-patch.mjs, 后端启动前自动打)已经让新的启动不再打那条 ERROR;
 *   这里再补一道"注解" —— 对**已经写进日志文件的历史行**也管用(文件是追加写的, 老行不会消失),
 *   复制日志时一眼就能看到"无害"的结论, 不必再问客服。
 * ⚠️ 只**追加**注解, 不改原行文字 —— 原文必须能原样对回上游/给支持排查。
 */
const HARMLESS_LOG_NOTES = [
  { re: /Failed to resolve template asset paths:/, note: '无害: 模型包不含模板浏览器的示例图(省 ~1.2GB), 与生成无关' },
  { re: /No workflow template assets found/, note: '无害: 同上, 示例图没随模型包发属预期, 与生成无关' },
  { re: /is lower than the recommended version/, note: '无害: 模型包自带的模板/前端包版本比上游建议的略低, 与生成无关' },
]
function annotateHarmlessLogLine(line) {
  const s = String(line ?? '')
  for (const n of HARMLESS_LOG_NOTES) if (n.re.test(s)) return `${s}    ← 【${n.note}】`
  return s
}
function annotateHarmlessLog(text) {
  const s = String(text ?? '')
  if (!/resolve template asset|No workflow template assets|lower than the recommended version/.test(s)) return s
  return s.split('\n').map(annotateHarmlessLogLine).join('\n')
}

function handleBackendLog(req, res) {
  const q = new URL(req.url ?? '', 'http://x').searchParams
  const kind = String(q.get('kind') ?? '').toLowerCase()
  const lines = Math.max(1, Math.min(Number(q.get('lines')) || 12, 200))
  if (!BACKENDS[kind]) return sendJson(res, 400, { ok: false, msg: `未知后端: ${kind}` })
  const file = logPathFor(kind)
  const rec = BACKEND_PROCS.get(kind)
  if (!fs.existsSync(file)) {
    return sendJson(res, 200, { ok: true, kind, file: path.basename(file), lines: [], note: '日志文件还没生成 (这一路从未启动过)' })
  }
  try {
    // 读磁盘时同样剥 ANSI: 文件里存着修复之前写下的历史日志, 那些行仍带颜色码
    const all = stripAnsiText(fs.readFileSync(file, 'utf-8')).split(/\r?\n/).filter((l) => l.trim())
    const stat = fs.statSync(file)
    /**
     * ⚠️ 2026-10-11 真机抓到的坑: **tqdm 的进度条是"一行里用 `\r` 反复重写"的**(H3 的采样条就是这样),
     *   按 `\n` 切行时整条进度会挤成一个几百字符的"巨行", 再被下面的 `slice(0, 220)` 截掉尾巴 ⇒
     *   前端拿到的**永远停在最早那两步**(6 步采样只读得到 0/6、1/6)。
     *   后果: 进度条的"日志回退"看着像卡死在 1/6(实测), 排障日志卡片里那行也是一坨黏在一起的状态。
     *   这里把每行按 `\r` 拆开、**每一帧当成独立一行**返回 —— 终端上本来就是这么显示的(被重写掉的帧看不见),
     *   所以前端"读日志回退"能一路看到 2/6、3/6…(server-guard 的 L0–L5 钉着这件事)。
     */
    const splitCrFrames = (s) => {
      const t = String(s ?? '')
      if (!t.includes('\r')) return [t]
      return t.split('\r').filter((x) => x.trim())
    }
    const src = ((rec && rec.tail && rec.tail.length) ? rec.tail : all).flatMap(splitCrFrames)
    /**
     * ★ 2026-10-12: 用户把"复制日志"的文本贴过来求助时, 我们要能**一次就定因** ——
     *   所以除了日志尾巴, 这里把"这台机器是什么卡/驱动/走哪个 CUDA 栈"、扫到的告警(+实测诊断 hint)、
     *   以及最近的崩溃文件路径一起带出去。以前只给一段没头没尾的尾巴, 客户机那台就只能靠猜。
     */
    const gpuLines = all.filter((l) => /^\[gpu\]|^\[env\]|^\[compat\]/.test(l.trim())).slice(-8)
    let crashFile = ''
    try {
      const dir = LOG_DIR()
      const cands = fs.readdirSync(dir).filter((n) => n.startsWith(`crash-${kind}-`)).sort()
      if (cands.length) crashFile = cands[cands.length - 1]
    } catch { /* ignore */ }
    return sendJson(res, 200, {
      ok: true, kind,
      file: path.basename(file),
      // 内存 tail 有内容时优先它(更新鲜), 否则用磁盘尾部
      lines: src.slice(-lines)
        .map((l) => annotateHarmlessLogLine(String(l).slice(0, 220)))
        .filter((l) => l.trim()),
      fromDisk: !(rec && rec.tail && rec.tail.length),
      bytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
      running: !!(rec && !rec.exited),
      /** 实际在用的端口(端口被系统保留时会被搬走, 前端显示别再用写死的默认值) */
      port: BACKENDS[kind]?.port ?? null,
      defaultPort: BACKENDS[kind]?.defaultPort ?? null,
      /** 现场三件套: 显卡/驱动/栈 + 告警(含实测诊断) + 崩溃文件 */
      gpuLines,
      alerts: (rec?.alerts ?? []).slice(-6).map((a) => ({ code: a.code, sev: a.sev, n: a.n, sample: a.sample, hint: a.hint })),
      crashFile,
    })
  } catch (e) {
    return sendJson(res, 500, { ok: false, msg: `读取日志失败: ${e && e.message ? e.message : e}` })
  }
}

/** GET /api/store/list — 已镜像到磁盘的所有 key (前端启动时据此回灌) */
function handleStoreList(req, res) {
  const idx = readStoreIndex()
  const keys = Object.entries(idx).map(([key, meta]) => ({
    key,
    bytes: Number(meta?.bytes) || 0,
    at: meta?.at || '',
  }))
  return sendJson(res, 200, { ok: true, dir: storeDir(), count: keys.length, keys })
}

/** GET /api/store/get?key=... — 取一份文档 */
function handleStoreGet(req, res) {
  const key = String(new URL(req.url ?? '', 'http://x').searchParams.get('key') ?? '')
  if (!key) return sendJson(res, 400, { ok: false, msg: 'missing key' })
  const f = storeFileOf(key)
  if (!fs.existsSync(f)) return sendJson(res, 404, { ok: false, msg: 'not found' })
  try {
    return sendJson(res, 200, { ok: true, key, value: JSON.parse(fs.readFileSync(f, 'utf-8')) })
  } catch (e) {
    return sendJson(res, 500, { ok: false, msg: `读取失败: ${e && e.message ? e.message : e}` })
  }
}

/** POST /api/store/put {key, value} — 写一份文档 (原子写) */
async function handleStorePut(req, res) {
  const body = await readBody(req, res)
  const key = String(body?.key ?? '')
  if (!key) return sendJson(res, 400, { ok: false, msg: 'missing key' })
  let text
  try { text = JSON.stringify(body?.value) } catch { return sendJson(res, 400, { ok: false, msg: 'value 无法序列化' }) }
  if (text === undefined) return sendJson(res, 400, { ok: false, msg: 'missing value' })
  const bytes = Buffer.byteLength(text)
  if (bytes > STORE_MAX_BYTES) {
    return sendJson(res, 413, { ok: false, msg: `单份文档过大 (${(bytes / 1048576).toFixed(1)}MB > 32MB)` })
  }
  try {
    const dir = storeDir()
    fs.mkdirSync(dir, { recursive: true })
    const f = storeFileOf(key)
    const tmp = `${f}.tmp`
    fs.writeFileSync(tmp, text, 'utf-8')
    fs.renameSync(tmp, f)
    const idx = readStoreIndex()
    idx[key] = { bytes, at: new Date().toISOString() }
    writeStoreIndex(idx)
    return sendJson(res, 200, { ok: true, key, bytes })
  } catch (e) {
    return sendJson(res, 500, { ok: false, msg: `写入失败: ${e && e.message ? e.message : e}` })
  }
}

// ---------------------------------------------------------------- 首启自检 (/api/selfcheck)

/**
 * POST /api/store/delete {key} — 删掉一份磁盘镜像 (含索引条目)
 *
 * 为什么必须有它 (2026-09-17 用户实测): 删除项目时前端只清了 localStorage,
 *   磁盘镜像还在 → 下次启动 restoreFromDisk 看"这个键在浏览器里没有"就又灌回来了,
 *   于是**已删除的项目以孤儿画布的形式复活** —— 队列里指向它的任务全都找不到项目,
 *   表现就是"点一键渲染没有任何反应"(用户机器上就躺着 18 条这样的记录 + 23 张卡的画布)。
 */
async function handleStoreDelete(req, res) {
  const body = await readBody(req, res)
  const key = String(body?.key ?? '')
  if (!key) return sendJson(res, 400, { ok: false, msg: 'missing key' })
  try {
    const f = storeFileOf(key)
    let removed = false
    if (fs.existsSync(f)) { fs.unlinkSync(f); removed = true }
    const idx = readStoreIndex()
    if (idx[key]) { delete idx[key]; writeStoreIndex(idx) }
    return sendJson(res, 200, { ok: true, key, removed })
  } catch (e) {
    return sendJson(res, 500, { ok: false, msg: `删除失败: ${e && e.message ? e.message : e}` })
  }
}

/** 端口是否被占用 (只连一下, 300ms 超时, 不干扰任何东西) */
function portBusy(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port })
    const done = (v) => { try { sock.destroy() } catch { /* ignore */ } resolve(v) }
    sock.setTimeout(300)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

/**
 * "这一路的端口在不在听" —— 带 1.5 秒缓存的版本, 给 /api/backends/state 用。
 * 与 HTTP 探针的区别: 它只做三次握手, 后端事件循环被长算子占住时**依然能答**,
 * 所以它是"进程还在不在"的可靠证据 (见 /api/backends/state 的说明)。
 */
const portListenCache = new Map()
async function portListeningCached(kind, ttlMs = 1500) {
  const port = BACKENDS[kind]?.port
  if (!port) return false
  const hit = portListenCache.get(kind)
  if (hit && Date.now() - hit.at < ttlMs) return hit.val
  const val = await portBusy(port)
  portListenCache.set(kind, { at: Date.now(), val })
  return val
}

/** 磁盘卷的文件系统类型 (NTFS/exFAT/FAT32...)。拿不到就返回空串, 不阻断体检 */
function volumeFsType(driveLetter) {
  if (!driveLetter) return ''
  const letter = String(driveLetter).replace(/:$/, '')
  // 首选 PowerShell 的 CIM 查询: 不需要管理员权限, Win10/11 都自带 Storage 模块。
  // (踩坑: fsutil fsinfo volumeinfo 需要管理员权限, 普通用户跑会失败, 于是文件系统一直"未知")
  try {
    const out = execCapture('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}:'").FileSystem`,
    ], { timeout: 8000 })
    const m = /(NTFS|ReFS|exFAT|FAT32|FAT16|FAT)\b/i.exec(String(out))
    if (m) return m[1].toUpperCase()
  } catch { /* 落到下面的兜底 */ }
  try {
    const out = execCapture('cmd.exe', ['/c', 'fsutil', 'fsinfo', 'volumeinfo', `${letter}:`], { timeout: 4000 })
    const m = /(NTFS|ReFS|exFAT|FAT32|FAT16|FAT)\b/i.exec(String(out))
    return m ? m[1].toUpperCase() : ''
  } catch { return '' }
}

/** 某个目录所在卷的剩余空间与文件系统 (模型盘与程序盘可能不是同一个卷) */
function diskInfo(dir) {
  try {
    const drive = path.parse(path.resolve(dir)).root.replace(/[\\/]/g, '')
    if (typeof fs.statfsSync !== 'function') return { ok: false, drive, reason: 'statfs-unsupported' }
    const st = fs.statfsSync(dir)
    const freeGB = (Number(st.bavail) * Number(st.bsize)) / 1073741824
    const totalGB = (Number(st.blocks) * Number(st.bsize)) / 1073741824
    return {
      ok: true, drive, freeGB: +freeGB.toFixed(1), totalGB: +totalGB.toFixed(1),
      fsType: volumeFsType(drive),
    }
  } catch (e) {
    return { ok: false, drive: '', reason: e && e.message ? e.message : String(e) }
  }
}

/**
 * 首启自检 —— 把"能不能跑、缺什么、怎么办"一次性讲清楚。
 *
 * 为什么不是只做一次启动检查: 各人机器差异极大 (显卡/驱动/内存/磁盘/装了几层模型),
 *   分诊比"报个错"有用得多。前端在配置页展示, 每项都带可执行的下一步。
 * 六项: 显卡与驱动 / 内存 / 磁盘与文件系统 / 模型包分层 / 端口 / 后端运行状态
 */
async function handleSelfCheck(req, res) {
  const quick = P.modelsQuick()
  const gpu = gpuInfo()
  const sr = sysreqNow()
  const compat = cudaCompat()
  const checks = []
  const push = (c) => checks.push(c)

  // ---- 1) 显卡与驱动 ----
  /**
   * 驱动判定统一走 driverAdvice(单一事实来源, 与启动日志头/诊断包同一份结论):
   *   · 过低(连兼容栈都撑不起)        → fail
   *   · 偏低 且 包里没带兼容栈        → fail(注定 0xC0000005 崩, 别再让用户反复点)
   *   · 偏低 且 有兼容栈              → warn(能跑, 只是慢)
   *   · 满足 / 偏新                   → 继续看配置要求
   */
  const drv = driverAdvice(gpu, { compatAvailable: compat.available })
  const gpuData = {
    name: gpu.name || '', driver: gpu.driverVersion || '', vramMB: gpu.vramTotal || 0,
    cudaMode: compat.mode, driverLevel: drv.level, driverCode: drv.code, driverNeed: drv.need,
  }
  if (sr.fails.some((f) => f.code === 'NO_NVIDIA')) {
    push({
      key: 'gpu', label: '显卡与驱动', status: 'fail',
      detail: '没有检测到 NVIDIA 显卡',
      action: '本地生成依赖 CUDA, 需要 NVIDIA 显卡。你仍可正常使用画布编排与云端接口',
      data: gpuData,
    })
  } else if (drv.code === 'TOO_OLD_FAR' || (drv.code === 'TOO_OLD_NEED_580' && !compat.available)) {
    push({
      key: 'gpu', label: '显卡与驱动', status: 'fail',
      detail: `${drv.title}：${drv.detail}`,
      action: drv.action,
      data: gpuData,
    })
  } else if (drv.code === 'TOO_OLD_NEED_580') {
    push({
      key: 'gpu', label: '显卡与驱动', status: 'warn',
      detail: drv.detail,
      action: drv.action,
      data: gpuData,
    })
  } else if (!sr.ok) {
    push({
      key: 'gpu', label: '显卡与驱动', status: 'warn',
      detail: sr.fails.map((f) => f.detail).join('；') || sr.summary,
      action: '低于推荐配置: 建议用较低分辨率/较短时长, 或在设置里只启用需要的后端',
      data: gpuData,
    })
  } else {
    push({
      key: 'gpu', label: '显卡与驱动', status: 'ok',
      detail: `${gpu.name} · 驱动 ${gpu.driverVersion} · 显存 ${Math.round((gpu.vramTotal || 0) / 1024)}GB`
        + ` · ${drv.level}${drv.code === 'NEWER_UNTESTED' ? '（比验证过的更新）' : ''}`
        + (drv.archNote ? ` · ${drv.archNote}` : ''),
      data: gpuData,
    })
  }

  // ---- 2) 内存 ----
  const mem = systemMemory()
  const ramLow = mem.totalGB < MIN_REQ.ramMinGB
  push({
    key: 'ram', label: '内存', status: ramLow ? 'warn' : 'ok',
    detail: `共 ${mem.totalGB}GB, 当前可用 ${Math.round(mem.freeMB / 1024)}GB (建议 ≥ ${MIN_REQ.ramMinGB}GB)`,
    action: ramLow ? '内存偏紧: 建议关闭视频后端 (设置 → 后端), 或加大内存' : undefined,
    data: { totalGB: mem.totalGB, freeGB: Math.round(mem.freeMB / 1024) },
  })

  // ---- 3) 磁盘与文件系统 (模型盘 + 程序盘) ----
  const modelDisk = diskInfo(P.backendsRoot)
  const appDisk = diskInfo(P.appRoot)
  const fat = modelDisk.fsType && /^FAT/.test(modelDisk.fsType)
  if (!modelDisk.ok) {
    push({
      key: 'disk', label: '磁盘空间', status: 'warn',
      detail: `无法读取模型目录所在卷的容量 (${modelDisk.reason || '未知原因'})`,
      data: { models: modelDisk, app: appDisk },
    })
  } else if (fat) {
    push({
      key: 'disk', label: '磁盘空间', status: 'fail',
      detail: `模型目录所在卷是 ${modelDisk.fsType}, 单个文件不能超过 4GB (模型有 19.5GB 的大文件)`,
      action: '把模型包放到 NTFS 或 exFAT 的硬盘上, 重新运行 set-models-dir.bat 指过去',
      data: { models: modelDisk, app: appDisk },
    })
  } else {
    const free = modelDisk.freeGB
    const notInstalled = quick.components.filter((c) => !c.installed)
    const needGB = notInstalled.reduce((n, c) => {
      const t = MODEL_TIERS.find((x) => x.key === c.tier)
      return n + (t ? t.sizeHintGB : 0)
    }, 0)
    const warn = needGB > 0 && free < needGB + 20
    push({
      key: 'disk', label: '磁盘空间', status: warn ? 'warn' : 'ok',
      detail: `${modelDisk.drive} 可用 ${free}GB / 共 ${modelDisk.totalGB}GB · ${modelDisk.fsType || '文件系统未知'}`
        + (needGB > 0 ? `；未安装的组件还需约 ${needGB}GB` : ''),
      action: warn ? '空间偏紧: 建议清理磁盘, 或只安装需要的模型层' : undefined,
      data: { models: modelDisk, app: appDisk, needGB },
    })
  }

  // ---- 4) 模型包分层 ----
  const tierLines = quick.tiers.map((t) =>
    `${t.ready ? '已装' : t.installed > 0 ? '部分' : '未装'} ${t.label}(约${t.sizeHintGB}GB)`)
  // 参考生图(Qwen 参考编辑)是生图包里的**新版能力**: 老生图包只有文生图权重。
  // 缺文件时如实说"这一层还是旧版", 而不是笼统报错 —— 文生图仍然照常可用。
  const refgen = refGenStatus(P.backendsRoot)
  const kearInstalled = quick.components.find((c) => c.key === 'kear')?.installed === true
  const refgenLine = !kearInstalled
    ? ''
    : refgen.ok
      ? ' · 参考生图(参考改图)就绪'
      : ` · 参考生图差 ${refgen.missing.length} 个模型文件(需新版生图包, 文生图不受影响)`
  const modelsData = {
    root: quick.root,
    packVersion: quick.packVersion,
    apiVersion: quick.apiVersion,
    supportedApiVersion: quick.supportedApiVersion,
    components: quick.components,
    tiers: quick.tiers,
    refGen: { ...refgen, kearInstalled },
  }
  if (quick.installedCount === 0) {
    push({
      key: 'models', label: '模型包', status: 'warn',
      detail: '一个模型组件都没装 —— 画布与素材管理可用, 本地生成不可用',
      action: '装模型包 (语音 19GB / 生图 23GB / 视频 78GB 任选), 解压后运行 set-models-dir.bat 指过去',
      data: modelsData,
    })
  } else if (quick.compat.level === 'mismatch') {
    push({
      key: 'models', label: '模型包', status: 'fail',
      detail: quick.compat.reason,
      action: '换成与当前程序版本配套的模型包 (看 版本信息.json 里的 models.apiVersion)',
      data: modelsData,
    })
  } else if (!quick.allInstalled) {
    push({
      key: 'models', label: '模型包', status: 'ok',
      detail: `已装 ${quick.installedCount}/${quick.requiredCount ?? quick.components.length} 个组件 · ${tierLines.join(' / ')}${refgenLine}`,
      action: '只装部分组件是正常用法; 想要视频功能再补视频包即可',
      data: modelsData,
    })
  } else {
    push({
      key: 'models', label: '模型包', status: 'ok',
      detail: `全部就绪${quick.packVersion ? ' · v' + quick.packVersion : ''} · ${tierLines.join(' / ')}${refgenLine}`,
      action: kearInstalled && !refgen.ok
        ? '文生图照常可用; 想用「参考生图(改图)」请换装含参考生图的新版生图包'
        : undefined,
      data: modelsData,
    })
  }

  // ---- 5) 端口 ----
  const portList = [PORT, ...Object.values(BACKENDS).map((b) => b.port)]
  const busy = []
  for (const p of portList) if (await portBusy(p)) busy.push(p)
  // 被自己的后端占着属于正常 (后端在跑), 只有"没装/没起却占着"才值得提醒
  const foreign = []
  for (const [kind, b] of Object.entries(BACKENDS)) {
    const comp = quick.components.find((c) => c.key === kind)
    if (!comp?.installed && busy.includes(b.port)) foreign.push(`${b.port}(${b.label}未安装却被占用)`)
  }
  push({
    key: 'ports', label: '端口', status: foreign.length ? 'warn' : 'ok',
    detail: busy.length ? `已监听: ${busy.join(', ')}` : '全部空闲',
    action: foreign.length ? `外部程序占用了 ${foreign.join(', ')}; 关掉它或改端口` : undefined,
    data: { total: portList, busy, foreign },
  })

  // ---- 6) 后端运行状态 ----
  const rt = backendRuntime()
  const lines = Object.keys(BACKENDS).map((k) => {
    const comp = quick.components.find((c) => c.key === k)
    const rec = rt[k] || {}
    if (!comp?.installed) return `${BACKENDS[k].label}: 未安装`
    if (P.settings?.backendsEnabled?.[k] === false) return `${BACKENDS[k].label}: 已停用`
    if (rec.running) return `${BACKENDS[k].label}: 运行中${rec.phaseText ? ' · ' + rec.phaseText : ''}`
    return `${BACKENDS[k].label}: 未启动`
  })
  const anyInstalled = quick.components.some((c) => c.installed)
  const anyRunning = Object.keys(BACKENDS).some((k) => rt[k]?.running)
  push({
    key: 'runtime', label: '后端状态', status: !anyInstalled ? 'skip' : anyRunning ? 'ok' : 'warn',
    detail: lines.join(' · '),
    action: anyInstalled && !anyRunning
      ? (manualStartEnabled()
        ? '当前是手动启动模式: 需要哪一路就点它的「启动」(首次加载需编译缓存, 可能十几分钟); 生成前必须先启动, 否则会提示未启动'
        : '本地模型会在第一次生成时自动启动 (首次需编译缓存, 最长十几分钟); 想提前预热, 点对应后端那一行的「启动」')
      : undefined,
    data: { runtime: rt },
  })

  // ---- 7) Windows 应用程序控制 (智能应用控制 / WDAC) ----
  //
  // 2026-09-15 测试反馈: 一台测试机上 H3 与 Krea2 一启动就退出码 1, 日志里是加载
  // torch\lib\shm.dll 被"应用程序控制策略"阻止(WinError 4551), 而 IndexTTS 那一路正常。
  // 这类拦截程序侧绕不开 —— 所以把状态提前摆出来, 让人在"点了启动却失败"之前就知道要关什么。
  const ac = appControlState()
  const acOn = ac.sac === 'on'
  const acEval = ac.sac === 'eval'
  push({
    key: 'appcontrol',
    label: '应用程序控制',
    status: acOn ? 'warn' : 'ok',
    detail: acOn
      ? '智能应用控制(SAC)已开启: 它会拦未签名的动态库, torch 的 shm.dll 就会被拦 —— 实测会让视频/生图两路后端一启动就退出(退出码 1)'
      : acEval
        ? '智能应用控制处于"评估模式": 通常不拦, 但若视频/生图一启动就退出(退出码 1), 先怀疑它'
        : ac.wdac
          ? `未启用智能应用控制; 检测到 ${ac.wdacFiles.length} 条代码完整性策略(系统自带或企业下发)`
          : '未启用智能应用控制, 也没有额外的代码完整性策略',
    action: (acOn || acEval)
      ? '如果后端一启动就退出(退出码 1): 先双击程序目录里的 fix-model-files.bat(解除"来自网络"标记并打印策略状态); 仍不行 → 设置 → 隐私和安全性 → Windows 安全中心 → 应用和浏览器控制 → 智能应用控制 → 关闭; 装了火绒/360/EDR 的把程序目录加入信任区; 企业管控机器要管理员加白名单'
      : undefined,
    data: ac,
  })

  const failCount = checks.filter((c) => c.status === 'fail').length
  const warnCount = checks.filter((c) => c.status === 'warn').length
  return sendJson(res, 200, {
    ok: true,
    overall: failCount ? 'fail' : warnCount ? 'warn' : 'ok',
    failCount, warnCount,
    checks,
    generatedAt: new Date().toISOString(),
    program: {
      version: P.versionInfo?.program?.version ?? '',
      build: P.versionInfo?.program?.build ?? 0,
      channel: P.versionInfo?.channel ?? '',
    },
  })
}

/**
 * 模型包状态 (/api/models)
 *   GET /api/models            → 零成本快照 (只判断关键文件在不在) —— 启动与轮询用
 *   GET /api/models?detail=1   → 完整体检 (顺带统计体积、比对清单) —— 设置面板"检查模型"用
 *
 * 这是"程序与模型分开发布"之后新增的对接点: 用户换了程序包而不动模型时, 靠它确认
 * 两边契约号一致; 模型装到别的盘时, 靠它告诉前端真实路径。
 */
function handleModels(req, res) {
  const detail = new URL(req.url ?? '', 'http://x').searchParams.get('detail') === '1'
  const quick = P.modelsQuick()
  const ver = P.versionInfo ?? {}
  const body = {
    ok: true,
    program: {
      version: ver.program?.version ?? '',
      build: ver.program?.build ?? 0,
      channel: ver.channel ?? '',
      gitCommit: ver.program?.gitCommit ?? '',
      builtAt: ver.program?.builtAt ?? '',
      /** 分发水印: 每个内测包唯一, 泄漏时按它倒查收件人 (台账见 dist/程序包/水印台账.json) */
      watermark: ver.program?.watermark ?? '',
    },
    models: {
      root: quick.root,
      packVersion: quick.packVersion,
      apiVersion: quick.apiVersion,
      supportedApiVersion: quick.supportedApiVersion,
      /** 这个模型包是哪一层的 (all / voice / image / video) */
      tier: quick.tier,
      compat: quick.compat,
      installedCount: quick.installedCount,
      totalCount: quick.requiredCount ?? quick.components.length,
      components: quick.components,
      /** 分层视图: 每层是否已装 (用户按"我能做什么"理解, 而不是"缺了什么") */
      tiers: quick.tiers,
    },
    /** 每个后端是否被用户启用 (与"是否安装"是两件事) */
    enabled: Object.fromEntries(
      Object.keys(BACKENDS).map((k) => [k, P.settings?.backendsEnabled?.[k] !== false]),
    ),
    hint: quick.compat.level === 'missing'
      ? '还没有安装模型包: 把模型包解压到任意目录, 再用程序目录里的 set-models-dir.bat 指过去 (只需装一次, 以后只更新程序包)。'
      : quick.compat.level === 'mismatch'
        ? '模型包与本程序不匹配: 请换成与当前程序版本对应的模型包。'
        : '模型目录已就绪。',
  }
  if (detail) {
    const full = P.modelsStatus({ quick: true })
    body.models.manifest = full.manifest
    body.models.components = full.components
    body.models.allInstalled = full.allInstalled
    body.models.detailText = describeStatus(full)
  }
  /**
   * 每层的已装体积 (2026-09-28, 给"卸载模型"用) —— 只从清单原件的 components[].bytes 读,
   * 不遍历目录。界面拿它显示"要释放多少空间"(例: 千问那层 ≈ 33.8 GB)。
   */
  const manifestComps = Array.isArray(quick.manifest?.components) ? quick.manifest.components : []
  body.models.sizes = Object.fromEntries(
    manifestComps.filter((c) => c && c.key).map((c) => [String(c.key), Number(c.bytes) || 0]),
  )
  return sendJson(res, 200, body)
}

/* ============================================================
   卸载模型包 (2026-09-28 用户: "增加卸载模型的 选项")
   ------------------------------------------------------------
   需求场景: 千问那层 36GB —— 装错了/不想用了, 用户得能自己删掉, 而不是被指去
   backends 目录里手删(删错一层整个 App 都起不来)。

   设计要点(每一条都是踩过的坑):
     · 粒度 = **组件**(≈ 一层): 生图 Krea2 / 视频 H3 / 语音 IndexTTS / 千问 Qwen。
       这样"只卸千问、Krea2 照常用"成立 —— 它俩同属生图层, 但目录是分开的。
     · 删的是 backends 下这一层的**顶层目录**(h3 / comfyui-kear2 / indextts-tts /
       comfyui-qwen / text), 不是组件清单里那个深层 rel(那是给"装没装"判定用的,
       删它会留下 h3\payload\backend\ 这种空壳)。text 那种"只是一个目录"的直接删。
     · 只接受组件 key, **绝不接受任意路径**; 解析完还要校验仍然落在 backendsRoot 之内。
     · 删之前先把这一路后端停掉(进程活着时文件删不干净)。
     · 几十 GB、几十万文件 —— **绝不能同步删**, 那会把整个服务(以及界面)冻住;
       起后台任务, 前端轮询进度, 界面上是"正在卸载…"。
     · 只动磁盘上的模型文件, **不碰 data/**(项目、素材、历史、授权都留着)。
   ============================================================ */
const UNINSTALL_TASKS = new Map()

/** 长路径前缀: 模型目录里 env\Lib\site-packages\… 的路径很容易越过 260 字符 */
function longPathFor(p) {
  const s = path.resolve(p)
  if (process.platform !== 'win32' || s.startsWith('\\\\?\\')) return s
  return s.startsWith('\\\\') ? `\\\\?\\UNC\\${s.slice(2)}` : `\\\\?\\${s}`
}

/** 这一层在 backends 下的顶层目录(卸载粒度) */
function componentTopDir(comp) {
  const root = path.resolve(P.backendsRoot)
  const top = String(comp.rel || '').split('/')[0]
  const dir = path.resolve(root, top)
  /** 安全闸: 解析结果必须仍在 backendsRoot 里(且不是 backendsRoot 自己) */
  if (dir !== root && dir.startsWith(root + path.sep)) return dir
  return ''
}

async function handleModelsUninstall(req, res) {
  const body = await readBody(req, res).catch(() => ({}))
  const key = String(body?.key ?? '').trim().toLowerCase()
  const comp = MODEL_COMPONENTS.find((c) => c.key === key)
  if (!comp) return sendJson(res, 400, { ok: false, msg: `未知模型组件: ${key || '(空)'}` })
  const dir = componentTopDir(comp)
  if (!dir) return sendJson(res, 400, { ok: false, msg: '拒绝执行: 路径不在模型目录内' })
  if (!fs.existsSync(dir)) return sendJson(res, 200, { ok: true, state: 'idle', msg: `${comp.label} 本来就没装` })

  const running = UNINSTALL_TASKS.get(key)
  if (running?.state === 'running') return sendJson(res, 200, { ok: true, state: 'running', msg: '正在卸载…' })

  const task = { state: 'running', at: Date.now(), msg: '正在停止这一路后端…', dir }
  UNINSTALL_TASKS.set(key, task)

  /** 后台干: 停后端 → 递归删 → 记结果。前端轮询 /api/models/uninstall/status 看进度。 */
  void (async () => {
    try {
      /** 后端进程活着时删不掉(占用), 先停。shutdownBackends 也会处理"手起的后端"。 */
      if (BACKENDS[key]) {
        task.msg = '正在停止这一路后端…'
        /** 同样按既有约定写明原因: 卸载模型把这一路停掉, 日志里要看得出来(2026-10-01 补) */
        await noteStop(key, '卸载模型：先把这一路后端停掉')
        try { await shutdownBackends(key) } catch { /* 停不掉也让删除去试 */ }
      }
      task.msg = '正在删除文件…'
      await fs.promises.rm(longPathFor(dir), { recursive: true, force: true, maxRetries: 2, retryDelay: 200 })
      if (fs.existsSync(dir)) throw new Error('还有文件没删掉（可能仍被占用）')
      task.state = 'done'
      task.msg = `${comp.label} 已卸载`
      /** 卸载后模型清单要重读一次: 下次 /api/models 就会显示"未装" */
      try { P.reloadModels?.() } catch { /* 没有这个钩子也无所谓, 清单本来就是每次现算 */ }
    } catch (e) {
      task.state = 'error'
      task.msg = `卸载失败: ${e instanceof Error ? e.message : String(e)}`
    }
  })()

  return sendJson(res, 200, { ok: true, state: 'running', key, dir, msg: `开始卸载 ${comp.label}` })
}

function handleModelsUninstallStatus(req, res) {
  const key = String(new URL(req.url ?? '', 'http://x').searchParams.get('key') ?? '').trim().toLowerCase()
  const t = UNINSTALL_TASKS.get(key)
  return sendJson(res, 200, t
    ? { ok: true, state: t.state, msg: t.msg }
    : { ok: true, state: 'idle' })
}

async function handleSettings(req, res) {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET') return sendJson(res, 200, settingsSnapshot())
  if (method === 'POST' || method === 'PUT') {
    const body = await readBody(req, res)

    // 用资源管理器打开模型目录 —— 用户要往里放 120GB 的东西, 得能一键跳过去
    if (body.action === 'openBackends' || body.action === 'openData' || body.action === 'openPath') {
      /**
       * openPath: 打开任意一个用户配置的目录(存储位置那几行要用)。
       *   安全边界: 只允许打开**已经配置过的**那几个目录之一 —— 不接受任意路径,
       *   免得变成"前端能指挥程序开任何文件夹"的通道。
       */
      const allowed = new Set([
        P.dataDir, P.backendsRoot, DEFAULT_ASSETS_DIR(), DEFAULT_STORE_DIR(),
        ...MEDIA_KINDS.map(mediaDirFor), storeDir(),
      ].map((p) => path.resolve(p)))
      let target = P.dataDir
      if (body.action === 'openBackends') target = P.backendsRoot
      else if (body.action === 'openPath') {
        const want = path.resolve(String(body.path || ''))
        if (!allowed.has(want)) return sendJson(res, 400, { ok: false, msg: '这个目录不在允许打开的列表里' })
        target = want
      }
      try { fs.mkdirSync(target, { recursive: true }) } catch { /* 只读盘就算了 */ }
      spawn('cmd.exe', ['/c', 'start', '""', 'explorer.exe', target], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref()
      return sendJson(res, 200, { ok: true, detail: target })
    }

    const next = {}
    if (body.backendsRoot !== undefined) next.backendsRoot = String(body.backendsRoot || '').trim()
    if (body.autoFreeMemory !== undefined) next.autoFreeMemory = body.autoFreeMemory === true
    // 空闲自动卸载: 0=关闭, 其它=分钟数(5/10/30)。取整并夹到合理区间, 防前端乱传
    if (body.idleFreeMinutes !== undefined) {
      const n = Math.round(Number(body.idleFreeMinutes))
      next.idleFreeMinutes = Number.isFinite(n) ? Math.max(0, Math.min(240, n)) : 10
    }
    // 给桌面留的显存(GB): 0 = 完全不预留。夹到 0~4GB, 一位小数
    if (body.desktopVramGB !== undefined) {
      const n = Number(body.desktopVramGB)
      next.desktopVramGB = Number.isFinite(n) ? Math.round(Math.max(0, Math.min(4, n)) * 10) / 10 : 0.8
    }
    // 按需启动 / 启动即预热 (笔记本/弱机 vs 专用工作站, 两种都有人要)
    if (typeof body.lazyBackends === 'boolean') next.lazyBackends = body.lazyBackends
    /**
     * 「模型全量常驻」= 关掉"独占在线" (2026-10-11 用户要求, 配一句风险告知)。
     *
     * 为什么需要: 用户反馈"切换模型特别慢" —— 慢的一大半来自独占在线那条规则:
     *   起 A 路前要把 B 路**进程级停掉**, 再起 A 时 python/torch/CUDA 又要从头初始化一遍。
     *   打开这个开关后, 起新的一路**不再停别人** —— 切回来时那一路还在, 秒切。
     *
     * 代价(界面上必须写明, 见 Toolbar 设置面板那条说明): 多个模型的权重会同时占显存/内存,
     *   显存不够时要么后端自己回落到内存换页(慢), 要么直接起不来。所以默认**关**。
     */
    if (typeof body.allModelsOnline === 'boolean') next.allModelsOnline = body.allModelsOnline
    /** 权重页缓存预热开关(默认开): 打开模型抽屉时后台热一热权重, 真正启动少等磁盘 */
    if (typeof body.prewarmWeights === 'boolean') next.prewarmWeights = body.prewarmWeights
    // 按组件启用/停用后端 (低配机可以只留语音/生图, 不启动视频后端)
    if (body.backendsEnabled && typeof body.backendsEnabled === 'object') {
      const cur = P.settings?.backendsEnabled ?? {}
      const merged = { ...cur }
      for (const k of Object.keys(BACKENDS)) {
        if (typeof body.backendsEnabled[k] === 'boolean') merged[k] = body.backendsEnabled[k]
      }
      next.backendsEnabled = merged
    }
    if (body.port !== undefined) {
      const p = Number(body.port)
      if (Number.isInteger(p) && p > 0 && p < 65536) next.port = p
    }
    /**
     * 存储位置 (2026-09-26 用户要求: 图片/视频/音频分别可配 + 项目管理目录可配)。
     *
     * 数据安全原则(为什么这么绕):
     *   ① **先复制、再切换** —— 复制完核对"文件数 + 总字节"都对得上, 才写设置; 对不上就原样返回,
     *      此时只是在新目录里多留了半份, 一个字节都没丢;
     *   ② **永远不删原目录** —— 用户确认没问题之后自己删, 我们不替他做不可恢复的事;
     *   ③ 读取/删除/存在性判定都是**跨目录找**(见 assetRoots), 所以切换那一刻起老文件立刻还能用,
     *      不会出现"换目录后历史/素材库里的图全打不开"。
     */
    let migrateReport = null
    /**
     * ★ 2026-10-12 审计 §3.5: 需要搬文件的活**不在请求里干了** —— 收集成 jobs, 交给后台
     *   (见 runStorageMigrate), 请求立刻返回。前端拿到 `migrating` 后轮询 `/api/settings/migrate`。
     */
    const migrateJobs = []
    if (body.mediaDirs !== undefined && body.mediaDirs && typeof body.mediaDirs === 'object') {
      if (MIGRATE?.running) {
        return sendJson(res, 409, {
          ok: false, migrating: true, msg: '上一次迁移还在进行中',
          detail: '等它跑完（设置面板上有进度）再改；现在改设置不会生效也不会丢文件',
        })
      }
      const nextMedia = { ...(P.settings?.mediaDirs ?? {}) }
      const steps = []
      for (const k of MEDIA_KINDS) {
        if (body.mediaDirs[k] === undefined) continue
        const target = String(body.mediaDirs[k] || '').trim()
        const from = mediaDirFor(k)
        if (target && path.resolve(target) !== path.resolve(from)) {
          migrateJobs.push({ kind: k, from, to: target })
        }
        nextMedia[k] = target
      }
      next.mediaDirs = nextMedia
      migrateReport = { media: steps }
    }
    if (body.projectsDir !== undefined) {
      const target = String(body.projectsDir || '').trim()
      const from = storeDir()
      if (target && path.resolve(target) !== path.resolve(from)) {
        migrateJobs.push({ kind: 'projects', from, to: target })
      }
      next.projectsDir = target
    }
    /** 有活要干 → 后台跑, 立刻回; 没活要干(只是改了别的设置) → 照旧同步写盘 */
    if (migrateJobs.length) {
      MIGRATE = {
        running: true, ok: null, msg: '', phase: migrateJobs[0].kind, phaseText: '正在准备迁移',
        total: 0, done: 0, bytes: 0, totalBytes: 0, startedAt: Date.now(), finishedAt: 0, jobs: migrateJobs.length,
      }
      log(`[storage] 开始后台迁移 ${migrateJobs.length} 项(${migrateJobs.map((j) => j.kind).join('/')}) —— 期间界面照常可用`)
      void runStorageMigrate(next, migrateJobs)
      return sendJson(res, 200, {
        ok: true, migrating: true, storage: migrateReport,
        detail: '已开始后台迁移（只复制不删原件）。迁移期间界面照常可用, 完成后会自动切换并提示。',
      })
    }
    const { writeSettings } = await import('./tools/runtime.mjs')
    writeSettings(P.dataDir, next)
    // 模型目录同时写 MODELS-DIR.txt (2026-09-15 测试反馈 P0):
    //   应用内改目录以前只写 data\settings.json, 而 START-HERE.bat / 三个单路启动脚本
    //   读的是程序目录下的 MODELS-DIR.txt —— 两边一旦不一致, 界面与独立启动脚本就"各说各话"
    //   (界面认新目录、启动脚本找旧目录)。这里把两个文件一次性对齐;
    //   反方向(set-models-dir.bat 改目录)由同目录的 set-models-dir.ps1 负责同步 settings.json。
    if (next.backendsRoot !== undefined) {
      const txt = path.join(P.appRoot, 'MODELS-DIR.txt')
      try {
        if (next.backendsRoot) fs.writeFileSync(txt, next.backendsRoot + '\r\n', 'utf-8')
        else fs.rmSync(txt, { force: true })   // 清空 = 回到默认 <程序目录>\backends
      } catch (e) {
        log('[settings] 同步 MODELS-DIR.txt 失败: ' + e.message)
      }
    }
    // 路径类改动要重建 P 才能生效 (端口改动需重启进程)
    P = resolvePaths({ appRoot: P.appRoot, dataDir: P.dataDir, distDir: P.distDir, packaged: P.packaged })
    initStore()
    return sendJson(res, 200, {
      ...settingsSnapshot(),
      needRestart: next.port !== undefined || next.backendsEnabled !== undefined,
      autoFree: autoFreeEnabled(),
      /** 迁移结果回给前端: "复制了几个 / 字节数 / 原目录在哪" —— 让用户看得见、可核对 */
      storage: migrateReport ?? undefined,
      detail: migrateReport
        ? (() => {
          const lines = []
          const m = migrateReport.media ?? []
          for (const s of m) {
            lines.push(`${s.kind === 'image' ? '图片' : s.kind === 'video' ? '视频' : '音频'}：已复制 ${s.copied} 个文件（${(s.bytes / 1048576).toFixed(1)}MB）到新目录`)
          }
          const p = migrateReport.projects
          if (p) lines.push(`项目管理：已复制 ${p.copied} 个 json 到新目录`)
          if (!lines.length) lines.push('保存位置已更新（新文件按新位置存放）')
          lines.push('原目录里的文件一个都没删，确认新目录没问题后可以自己清掉旧目录')
          return lines.join('；')
        })()
        : next.backendsEnabled !== undefined
        ? '后端开关已保存; 已启动的后端需要重启程序才会停下。'
        : next.idleFreeMinutes !== undefined
          ? (next.idleFreeMinutes > 0
            ? `空闲自动卸载已设为 ${next.idleFreeMinutes} 分钟：闲置这么久后卸掉模型腾出显存。`
            : '空闲自动卸载已关闭：不生成时模型也会一直占着显存。')
          : next.autoFreeMemory !== undefined
            /**
             * ⚠️ 2026-09-25: 文案跟着新语义走 —— 关掉是"真的不自动释放"(连压力兜底也不卸),
             *   开启才是"任务结束后释放"; 别再说"切换生成类型时释放", 那已经不准了。
             */
            ? `自动清理内存已${next.autoFreeMemory
              ? '开启（任务结束后释放已加载的模型腾显存/内存，下次生成需重新加载）'
              : '关闭（模型常驻不自动释放，连续生成最快）'}。`
            : '模型目录已更新, 界面立即生效; 端口改动需重启程序。',
    })
  }
  return sendJson(res, 405, { ok: false, msg: 'method not allowed' })
}

// ---------------------------------------------------------------- 对外入口

/** 确保可写目录存在 (打包后首次运行 data/ 是空的) */
function ensureRuntimeDirs() {
  for (const d of [P.dataDir, P.webappProfileRoot]) {
    try { fs.mkdirSync(d, { recursive: true }) } catch (e) { log(`创建目录失败 ${d}:`, e.message) }
  }
}

/**
 * 启动服务。
 * @param {Parameters<typeof resolvePaths>[0] & { autoOpen?: boolean, quiet?: boolean, embedded?: boolean }} [opts]
 * @returns {Promise<{ server: import('node:http').Server, port: number, url: string, paths: typeof P }>}
 */
export async function startServer(opts = {}) {
  /**
   * 122 P0-2：默认拒绝。
   *   · 正式包：main.cjs 的 bootServer 注入 gate.requireLicense=true；
   *   · 开发/测试：启动命令显式 AICS_DEV_GATE_DISABLED=1，或调用方显式传 gate:false；
   *   · 直接 node server.mjs：没有注入 → 必须授权（B1/B2 不再一条命令绕过）。
   */
  const gateOpt = opts.gate && typeof opts.gate === 'object' ? opts.gate : null
  const devAllow = process.env.AICS_DEV_GATE_DISABLED === '1'
  GATE = {
    requireLicense: gateOpt ? gateOpt.requireLicense === true : !devAllow,
    token: String(gateOpt?.token || ''),
  }
  P = resolvePaths(opts)
  if (gateOpt) log(`[license] gate 由调用方注入：requireLicense=${GATE.requireLicense}`)
  else if (devAllow) log('[license] AICS_DEV_GATE_DISABLED=1 → 开发态不启用授权门禁')
  else log('[license] 未注入 gate → 默认要求授权（开发请显式 AICS_DEV_GATE_DISABLED=1）')
  PORT = P.port
  initStore()
  ensureRuntimeDirs()
  /** 安装身份从第一次启动就落盘，后续升级/重启保持不变。 */
  currentInstanceId()

  /**
   * ★★ 2026-10-12: **端口自动化**要在"任何一处用到 BACKENDS[kind].port"之前跑完 ——
   *   反代路由、启动参数、探测、/api/backends/state 全都从 BACKENDS 取, 所以这里搬完就全局生效。
   *   见 applyBackendPortAutoRelocate 的说明: 只在"默认端口被系统保留"时才搬, 其余情形不动它。
   */
  await applyBackendPortAutoRelocate()

  /**
   * 显卡采样预热 (2026-10-06): GPU 的三个读入口现在一律"读缓存 + 后台异步刷新"(见 gpuSample 一节),
   * 所以先把第一次采样做完再往下走 —— 否则启动阶段那几行日志(以及第一条状态响应)会写成
   * "驱动 未知 / 显存 0"。这一步是异步的, 不阻塞事件循环, 也不会因为没独显而失败。
   */
  await sampleGpuAsync(['info', 'mem', 'per']).catch(() => { /* 没有独显也照常启动 */ })

  const server = createServer(opts.embedded === true)

  // 上次可能是被强杀/断电退出的 —— 按 run-state.json 清理残留后端进程
  cleanupStaleBackends()
  writeRunState()

  // 打开软件即自动拉起三个后端(幂等, 重复调用无害)。
  // 为什么放在服务端: 之前只由前端 boot.ts 调一次 /api/launch —— 于是当
  //   ① 服务重启(旧进程被杀, 前端页面还开着, store.started 已是 true → 不再调用)
  //   ② 前端某次请求失败(超时/被中断)
  // 就会出现"只有 H3 起来了、另外两个一直不启动"的假死状态(2026-09-14 用户实测)。
  // 前端仍会调一次做即时反馈, 但真正的兜底在这里。
  // 按需启动模式: 打开程序**不**预热任何后端 —— 谁被用到谁才起来 (见 lazyBackendsEnabled)。
  // 用户点生成时, 前端会调 /api/ensure, 代理层也有兜底, 所以不会出现"忘了启动"。
  if (process.env.AICS_NO_AUTOLAUNCH !== '1' && lazyBackendsEnabled()) {
    log('[auto] 按需启动模式: 不预热后端, 用到哪个起哪个 (可在设置里关闭)')
  } else if (process.env.AICS_NO_AUTOLAUNCH !== '1') {
    // 未激活绝不预热模型 (2026-09-15): 先看授权文件在不在(零成本, 不碰硬件指纹),
    // 不在就直接跳过; 在的话再走一次完整校验(有 machine.json 缓存, 通常几毫秒)。
    let bootBlocked = null
    try {
      if (!fs.existsSync(path.join(P.dataDir, 'license.key'))) bootBlocked = { ok: false, needActivation: true, msg: '尚未激活' }
    } catch { /* ignore */ }
    if (!bootBlocked) bootBlocked = licenseGateBlocked()
    if (bootBlocked) {
      log('[auto] 未激活: 不预热任何后端 —— 激活后在「配置与启动」页按需启动')
    } else {
    setTimeout(async () => {
      for (const kind of Object.keys(BACKENDS)) {
        try {
          // 分层安装: 没装的组件不启动, 也不写日志噪音 —— 这不是错误, 是"这台机器没装那层"
          const comp = componentOf(kind)
          if (comp && !comp.installed) {
            const t = comp.tier ? MODEL_TIERS.find((x) => x.key === comp.tier) : null
            log(`[auto] ${BACKENDS[kind].label} 跳过: 未安装${t ? `（缺少${t.label}）` : ''}`)
            continue
          }
          if (P.settings?.backendsEnabled?.[kind] === false) {
            log(`[auto] ${BACKENDS[kind].label} 跳过: 已在设置里停用`)
            continue
          }
          // preheat: 启动预热是"按顺序把每一路都拉一遍", 允许它掀掉上一路(否则会被
          //   "另一路正在启动中"的守卫拦住, 只剩第一路起来) —— 2026-10-06 新守卫的配套
          const r = await launchBackend(kind, { preheat: true })
          if (r.already) continue
          timeline('auto-launch', { kind, ok: r.ok === true, detail: r.detail || r.msg || '' })
          log(`[auto] ${r.detail || r.msg || kind}`)
        } catch (e) {
          log(`[auto] ${kind} 自动启动异常: ${e && e.message ? e.message : e}`)
        }
      }
    }, 2500)
    }
  }

  // 低驱动兼容栈: 把选择器 .pth 同步进后端环境(幂等; 只有 H3/Krea2 需要)
  try {
    const changed = syncCompatPth()
    if (changed.length) log('[compat] CUDA 兼容栈选择器:', changed.join(', '))
    const c = cudaCompat()
    if (c.available) log(`[compat] 兼容栈可用; 当前模式 ${c.mode} (驱动 ${c.driver || '未知'})`)
  } catch { /* 兼容层出问题不能影响启动 */ }

  /**
   * 云端视频任务恢复 (2026-09-18):
   *   上次退出时还在跑的云端任务, 任务号(remoteId)还在平台侧 —— 直接续查, 不重复提交。
   *   提交了一半就崩(还没拿到任务号)的, 明确标失败, 不让它一直显示"进行中"。
   */
  try {
    const saved = loadCloudTasks()
    for (const t of saved) {
      if (!t?.id) continue
      cloudVideoTasks.set(t.id, { ...t, abort: false })
    }
    const running = saved.filter((t) => t.status === 'running')
    for (const t of running) {
      // ⚠️ 必须改 Map 里那份(loadCloudTasks 的对象已被拷贝进 Map) —— 否则状态只在临时对象上改,
      //    界面上那条任务会永远停在"进行中"
      const live = cloudVideoTasks.get(t.id) || t
      const rec = store.getById(String(t.providerId || ''))
      if (!rec || !apiKeyOf(rec)) {
        live.status = 'error'
          live.error = '恢复失败：这条 API 连接已不在｜怎么办：去「API」面板重新添加'
        live.finishedAt = Date.now()
        continue
      }
      if (!t.remoteId) {
        live.status = 'error'
        live.error = '程序上次退出时还没拿到平台任务号，这条没跑完｜怎么办：回卡片重新点一次「生成」'
        live.finishedAt = Date.now()
        continue
      }
      const payload = { model: t.model || '', prompt: t.prompt || '' }
      // 时长口径跟着恢复: 出片后前端要拿它跟产物实测时长对比(2026-09-23)
      if (t.requestedSeconds != null) payload.seconds = t.requestedSeconds
      log(`[cloud-video] 恢复上次未完成的云端任务 ${t.id}（平台任务号 ${t.remoteId}）→ 继续等结果`)
      void pollCloudVideoTask(live, rec, payload, String(t.remoteId))
    }
    if (saved.length) {
      log(`[cloud-video] 已载入 ${saved.length} 条云端任务记录（其中 ${running.length} 条续查）`)
      saveCloudTasks()
    }
    /**
     * ★ 2026-10-30: 上次已经出片、但没来得及落盘的那些（程序被关/下载失败）——
     *   启动时补进队列。用户口径是"素材问题是底线"，不能因为换了次启动就把它留成外部链接。
     */
    let requeued = 0
    for (const t of cloudVideoTasks.values()) {
      if (t?.status === 'done' && t.url && !t.savedPath) { localizeQueueAdd(t.url, '启动时补落盘'); requeued += 1 }
    }
    if (requeued) log(`[localize] 启动补落盘: ${requeued} 条云端视频进队列`)
  } catch (e) {
    log('[cloud-video] 恢复任务失败(不影响启动):', e?.message ?? e)
  }

  await new Promise((resolve, reject) => {
    const onErr = (e) => reject(e)
    server.once('error', onErr)
    server.listen(PORT, HOST, () => {
      server.off('error', onErr)
      resolve()
    })
  })

  const url = `http://${HOST}:${PORT}`
  log('========================================')
  log('  漫客 本地服务已启动')
  log(`  应用 ${url}/`)
  if (P.packaged) log(`  数据目录 ${P.dataDir}`)
  log(`  模型目录 ${P.backendsRoot}`)
  {
    const tl = testLimits()
    if (tl.on) {
      log(`  ⚠ 测试模式已开启: 显存按 ${tl.vramGB}GB / 内存按 ${tl.ramGB}GB 计算`)
      log(`     （后端会带 --vram-headroom 真正卡住显存; 关掉限制 = 去掉环境变量 AICS_TEST_LIMITS 重启）`)
    }
  }
  log('========================================')

  /**
   * ── 云端产物落盘重试队列的常驻 worker（2026-10-30）──
   *
   * 用户口径：「我需要的是云端也自动落盘到本地，素材问题是底线」。
   * 云端给的是**临时签名链接**，落不下来必须由服务端自己接着试 —— 用户关掉页面、
   * 甚至关掉程序再打开，队列还在（data/localize-queue.json），照样补。
   * 15s 一轮，只有到期的项才动（各自指数退避），空队列时不发任何网络请求。
   */
  {
    const q = loadLocalizeQueue()
    if (q.pending.length) log(`[localize] 队列里有 ${q.pending.length} 条云端产物待落盘，继续重试`)
    const timer = setInterval(() => { void localizeQueueTick().catch(() => {}) }, 15_000)
    if (timer.unref) timer.unref()
  }

  // ── 空闲自动卸载 (2026-09-14 用户要求: "长时间挂着不该一直占显存") ──
  //
  // 与"切换后端即卸载"(见 queueRunner + decideRelease)是两件事, 互补:
  //   · 切换时卸载: 解决"两个模型抢显存" —— 生成一停下来就腾地方, 代价 +8.5s
  //   · 空闲时卸载: 解决"挂机一直占着" —— 用户去吃饭/睡觉, 不该让 20GB 显存一直被占
  //
  // 判据(三个都满足才动手):
  //   ① 后端在线且队列不忙(生成中绝不打扰 —— 这是硬约束)
  //   ② 距上次"忙"超过 idleFreeMinutes(默认 10 分钟, 0 = 关闭)
  //   ③ 该进程确实占着显存(>2GB, 说明有模型常驻; 没占就不必发请求)
  //
  // 为什么不用 ComfyUI 的 /free 定时乱发: 它只是给队列打标志, 由 worker 消费;
  //   队列空着时标志会一直挂着, 反而把真正的卸载压到下一个任务之后(实测踩过)。
  //   所以我们按"空闲时长"判断, 并且只在真的占着显存时才发。
  const IDLE_TICK_MS = 60 * 1000
  const idleSince = new Map()      // kind → 上次观测到"忙"的时间戳
  /**
   * 这一轮空闲期是否已经卸过。
   *
   * 为什么需要它: Windows(WDDM) 下 `nvidia-smi --query-compute-apps` 的显存列一律是 [N/A]
   *   (实测: `40780, [N/A]`), 所以 perProcessVram() 拿不到"这个后端占了多少显存"。
   *   原来靠 used >= 2048 当门槛 → 恒为 0 → **空闲卸载从来没触发过**
   *   (同一原因也让"释放后未观测到回落"成了常态: 判据本身读不到数)。
   *   改成: 只要求"每轮空闲卸一次", 后端再次忙起来才允许下一轮 —— 语义清晰且不依赖那个数。
   */
  const freedInIdle = new Set()
  const idleCheck = async () => {
    const minutes = idleFreeMinutes()
    if (minutes <= 0) return
    /**
     * ⚠️ 2026-09-25: 把 **qwen(8191)** 也纳入 —— 以前这里只遍历 h3/kear, 于是"挂了 10 分钟也不
     *   释放千问那 20GB 显存", 用户只能自己去点释放(体感就是"这功能对千问没用")。
     */
    for (const k of ['h3', 'kear', 'qwen']) {
      try {
        const probe = await probeBackend(k)
        if (!probe.online) { idleSince.delete(k); continue }
        const busy = await comfyQueueBusy(k)
        if (busy) { idleSince.set(k, Date.now()); freedInIdle.delete(k); continue }
        const since = idleSince.get(k) ?? Date.now()
        if (!idleSince.has(k)) { idleSince.set(k, since); continue }
        if (Date.now() - since < minutes * 60 * 1000) continue
        if (freedInIdle.has(k)) continue          // 这轮空闲已经卸过了
        const pid = BACKEND_PROCS.get(k)?.pid ?? null
        const used = pid !== null ? perProcessVram()[pid] : undefined
        // 只有"确实读到 0/很小"时才跳过; 读不到(Windows 常态)就按"可能占着"处理
        if (typeof used === 'number' && used < 2048) continue
        const r = await freeBackendNow(k, 'models')
        log(`[mem] 空闲 ${minutes} 分钟: 卸载 ${BACKENDS[k].label} 模型` +
          `${r.vramBefore != null ? ` | 显存 ${r.vramBefore} → ${r.vramAfter} MiB` : ''}`)
        freedInIdle.add(k)
      } catch { /* 后端离线或超时: 静默忽略 */ }
    }
  }
  // 先记下起点(避免刚启动就被判定"已空闲"), 之后每分钟检查一次
  for (const k of ['h3', 'kear', 'qwen']) idleSince.set(k, Date.now())
  const idleTimer = setInterval(() => { void idleCheck() }, IDLE_TICK_MS)
  if (idleTimer.unref) idleTimer.unref()

  // 自动打开浏览器到落地页 (Electron 形态自己开窗口, 不需要)
  const shouldOpen = opts.autoOpen !== false && !opts.embedded && !process.env.AICS_NO_OPEN
  if (shouldOpen) {
    spawn('cmd.exe', ['/c', 'start', '', `${url}/`], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  }

  /**
   * `log` 一并交出去: Electron 主进程自己的 console 在发行版里**没有落盘**(GUI 进程的 stdout
   * 是空的), 所以窗口侧的事件(渲染进程崩溃/无响应/窗口尺寸异常)过去只在开发态看得见。
   * 交一条 appLogWrite 给主进程, 这些事件才进得了 `data\logs\app-*.log`, 用户发日志过来就有现场。
   */
  return { server, port: PORT, url, paths: P, log }
}

/** 直接 `node server.mjs` 运行时自启; 被 import (例如 Electron 主进程) 时不自动监听 */
const INVOKED_DIRECTLY = (() => {
  try {
    const entry = process.argv[1]
    if (!entry) return false
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))
  } catch { return false }
})()

if (INVOKED_DIRECTLY) {
  startServer().catch((e) => {
    log('启动失败:', e)
    process.exit(1)
  })
}

                                                                                                   