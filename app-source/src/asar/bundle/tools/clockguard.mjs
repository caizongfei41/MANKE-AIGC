// ============================================================
// 时间轴守卫 (Time Guard) —— 防"改系统时间绕过到期"
//
// 威胁:
//   离线授权的到期检查用的是**本机系统时间** (Date.now())。
//   用户把系统时间调回授权期内, 过期检查立刻失效 —— 这是纯离线授权
//   最省事、也最常被用来延长使用期的一招, 比逆向程序便宜得多。
//
// 做法:
//   维护一条**只增不减的时间轴**, 三个锚点随每次运行往前推进:
//     firstSeen 首次运行 / lastSeen 最近一次运行 / maxSeen 历史最高水位
//   三处冗余落盘 (data/ 主文件 + profile 下的隐名副本 + 注册表 HKCU),
//   判定时取三处的**最大值** —— 删掉一处回滚不了, 因为另外两处还在。
//   每条锚点都带 HMAC 签名, 手改一个数字会被认出来并忽略。
//
// 判定:
//   now < maxSeen - 容差  →  时间被回拨。
//   容差默认 6 小时 (AICS_CLOCK_TOLERANCE_H 可改): NTP 校时、时区跳变、
//   休眠唤醒、虚拟机快照都会让时间小幅漂移, 卡太死会制造假故障。
//   默认**宽限策略**: 命中回拨只提示 + 记录, 不拦启动 (内测阶段用户机器
//   千奇百怪, 硬锁会变成一堆售后); 设 AICS_CLOCK_STRICT=1 才判为无效授权。
//
// 为什么水位**不自动下落**:
//   曾经想过"锚点跑到未来就自动忽略、按当前时间重来", 但那等于把证据擦掉 ——
//   作弊者只要先跑一次(水位抬到未来)再往回拨, 之后就没有任何回拨痕迹了。
//   所以水位只增不减, 只有超过 5 年这种**明显是 CMOS/主板电池失效**的离谱读数
//   才会被丢掉 (那种情况下 `exp` 检查本来也过不去, 提示语会指向"校时")。
//   代价: 系统时间曾经大幅度跑偏的机器会持续收到"回拨"提示 ——
//   默认宽限模式只是提示, 不影响使用; 需要清掉时见 resetClock 的说明。
//
// 两档判定 (避免把"时区/校时漂移"当成作弊):
//   tamper     回拨 > 容差(默认 6h)   → 记录 + 提示 (宽限模式下不拦)
//   hardTamper 硬证据, 或回拨 > 24h  → 严格模式(AICS_CLOCK_STRICT=1)下判为无效
//
// ---------------------------------------------------------------
// 多源交叉校验 (2026-09 第 3 步): 不看单一证据, 而是把五个来源摆在一起
//
//   水位对比  anchor    历史最高水位 vs 现在           中置信 (过去时钟可能本就偏快)
//   进程内单调 session 进程启动时的"钟对"              高置信 (进程内墙钟往回走 = 铁证)
//   开机时长  monotonic 上次记录的系统 uptime 与墙钟增量对比  高置信
//   开机时刻  bootTime  开机时刻只应越来越晚            高置信 (跨重启也成立)
//   文件时间戳 fs      data/ 里最新文件时间 vs 现在    中置信 (拷别人文件可能带未来时间)
//   网络时间  net      HTTP Date 头 (后台 30 分钟一次) 高置信 (离线时自动跳过)
//
//   tamper     = 水位超容差, 或任一来源给出的回拨量超容差
//   hardTamper = 有高置信来源, 或水位回拨超过 24 小时
//
// 为什么"进程内单调"最硬: process.uptime() 只受 CPU 时钟影响, 与系统时间无关。
// 用户运行中把时间往回拨, 墙钟增量会明显小于单调增量 —— 这一步不需要历史数据,
// 也不需要联网, 是纯离线环境下最可靠的一招。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { licenseSecrets } from './license-secrets.mjs'

const SECRETS = licenseSecrets().legacyClock
const SECRET = licenseSecrets().clock
/** 锚点结构版本: 2 起带上 uptime / 开机时刻 (第 3 步多源校验需要) */
const VERSION = 2
/** 默认容差: 6 小时 */
const DEFAULT_TOLERANCE_MS = 6 * 60 * 60 * 1000
/** 超过 now + 5 年的读数一律丢弃 (只用来过滤主板电池失效那类离谱读数) */
const MAX_FUTURE_MS = 5 * 365 * 24 * 60 * 60 * 1000
/** 硬回拨阈值: 超过它才在严格模式下判无效 */
const HARD_TAMPER_MS = 24 * 60 * 60 * 1000
/** 落盘节流: 两次写入间隔小于这个值就跳过 (读状态可能被频繁调用) */
const TOUCH_THROTTLE_MS = 60 * 1000
/** 读缓存: /api/license 会被频繁轮询 (激活页每 2 秒一次), 别每次都去查注册表 */
const REPORT_CACHE_MS = 30 * 1000
const EVENTS_KEEP = 5

const REG_KEY = 'HKCU\\Software\\Manke\\TimeGuard'

/** 进程启动时的"钟对": 墙钟 + 单调时钟。运行中改系统时间, 两者增量会打架 */
const PROC_BASE = { wall: Date.now(), mono: process.uptime() * 1000 }

/** 网络时间探针缓存: 只在后台刷新, 判定时永远读缓存, 绝不阻塞授权检查 */
const NET = { at: 0, offsetMs: null, source: '', error: '', busy: false }
const NET_TTL_MS = 30 * 60 * 1000
const NET_TIMEOUT_MS = 2500
/** 这里只取 HTTP 响应头里的 Date (秒级即可), 不传任何业务数据 */
const NET_URLS = ['https://www.baidu.com/', 'https://api.siliconflow.cn/']

/** 每台机器一份最近一次判定结果, 避免高频轮询反复读盘/查注册表 */
const REPORT_CACHE = new Map()

export const CLOCK_ANCHOR_VERSION = VERSION

/** 容差 (毫秒); 环境变量 AICS_CLOCK_TOLERANCE_H 以小时为单位 */
export function clockToleranceMs() {
  const h = Number(process.env.AICS_CLOCK_TOLERANCE_H)
  if (Number.isFinite(h) && h >= 0 && h <= 24 * 30) return Math.round(h * 3600_000)
  return DEFAULT_TOLERANCE_MS
}

/** 严格模式: 命中回拨即判授权无效 (默认关闭 = 只提示) */
export function clockStrict() {
  return process.env.AICS_CLOCK_STRICT === '1'
}

// ---------------------------------------------------------------- 锚点编解码

/**
 * 签名覆盖的字段 —— 必须是"三处锚点都存得下的那一组"。
 * 曾经写成"除 sig 之外的全部字段", 结果文件里有 events/updatedAt、
 * 注册表里没有, 同一份记录在注册表里永远验不过 (自己坑自己)。
 * events 只是给排障看的流水, 不参与判定, 因此不进签名。
 */
const SIGNED_FIELDS = ['v', 'firstSeen', 'lastSeen', 'maxSeen', 'uptimeMs', 'bootTimeMs', 'runs']

function signWith(rec, secret) {
  const basis = JSON.stringify(SIGNED_FIELDS.map((k) => [k, rec[k] ?? 0]))
  return crypto.createHmac('sha256', secret).update(basis, 'utf-8').digest('hex').slice(0, 32)
}

function sign(rec) {
  return signWith(rec, SECRET)
}

/** v1 (第 2 步) 的签名规则: 只覆盖五个数字, 用于平滑迁移, 不清水位 */
export function signAnchorV1With(rec, secret) {
  const basis = [1, rec.firstSeen, rec.lastSeen, rec.maxSeen, rec.runs ?? 0].join('|')
  return crypto.createHmac('sha256', secret).update(basis, 'utf-8').digest('hex').slice(0, 32)
}

export function signAnchorV1(rec) {
  return signAnchorV1With(rec, SECRET)
}

function makeRecord(prev, now, extra = {}) {
  const rec = {
    v: VERSION,
    // 水位只增不减 —— 见文件头"为什么水位不自动下落"
    firstSeen: Math.min(prev?.firstSeen ?? now, now),
    lastSeen: Math.max(prev?.lastSeen ?? now, now),
    maxSeen: Math.max(prev?.maxSeen ?? now, now),
    /** 上次记录时的系统开机时长 (毫秒) 与当时的开机时刻 —— 第 3 步的两个交叉校验源 */
    // 必须取整后再签名: 注册表里只能存整数字符串, 不取整的话"签名覆盖 27.0084,
    // 读回来是 27" 就永远对不上 (自己坑自己)。
    uptimeMs: Math.round(Number.isFinite(extra.uptimeMs) ? extra.uptimeMs : (prev?.uptimeMs ?? 0)),
    // 开机时刻保存**最晚**见过的一次: 开机时刻只应越来越晚,
    // 之后若读到更早的, 就说明时钟被往回拨过 (即使中间重启了也一样)。
    bootTimeMs: Math.round(Math.max(
      Number.isFinite(extra.bootTimeMs) ? extra.bootTimeMs : -Infinity,
      prev?.bootTimeMs ?? -Infinity,
    )),
    runs: (prev?.runs ?? 0) + 1,
    updatedAt: now,
    events: prev?.events ?? [],
  }
  if (!Number.isFinite(rec.bootTimeMs)) rec.bootTimeMs = now
  rec.sig = sign(rec)
  return rec
}

// ---------------------------------------------------------------- 多源探针

/** 系统开机时长 (毫秒)。取不到就返回 NaN */
export function systemUptimeMs() {
  try {
    const s = os.uptime()
    return Number.isFinite(s) ? s * 1000 : NaN
  } catch { return NaN }
}

/**
 * 文件时间戳探针: data 目录里最新被写过的时间。
 * 只扫**程序自己的目录** —— 系统目录里可能有别的程序写入的未来时间戳, 不可信。
 * mtime 会随文件写入变成"当时的系统时间", 于是时间被往回拨之后,
 * 先前写下的文件就"跑到未来"了。
 */
function newestFileMtime(dir, { depth = 2, limit = 600 } = {}) {
  let newest = { ms: 0, file: '' }
  let scanned = 0
  const walk = (d, level) => {
    if (level > depth || scanned > limit) return
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (scanned > limit) return
      const p = path.join(d, e.name)
      try {
        if (e.isDirectory()) {
          // profile/ 里是浏览器缓存(几万个文件), 只下探一层就够, 别拖慢授权检查
          if (e.name === 'node_modules' || e.name === 'Cache' || e.name === 'Code Cache') continue
          walk(p, level + 1)
        } else {
          scanned++
          const st = fs.statSync(p)
          if (st.mtimeMs > newest.ms) newest = { ms: st.mtimeMs, file: p }
        }
      } catch { /* 单个文件读不到不影响 */ }
    }
  }
  walk(dir, 0)
  return { ms: newest.ms, file: newest.file, scanned }
}

/**
 * 网络时间探针 (后台刷新, 判定时只读缓存)。
 * 只读 HTTP 响应头的 Date, 不发送任何业务数据; 失败就跳过, 不影响授权。
 */
async function probeNetNow() {
  for (const url of NET_URLS) {
    try {
      const t0 = Date.now()
      const res = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'manual',
        signal: AbortSignal.timeout(NET_TIMEOUT_MS),
      })
      const t1 = Date.now()
      const header = res.headers.get('date')
      try { await res.body?.cancel() } catch { /* 头拿到就够了 */ }
      if (!header) continue
      const t = Date.parse(header)
      if (!Number.isFinite(t)) continue
      // Date 只有秒级精度, 用请求前后的本地中点做对齐, 误差 ≲ 1 秒
      const localMid = (t0 + t1) / 2
      NET.offsetMs = t - localMid
      NET.source = url
      NET.error = ''
      NET.at = Date.now()
      return true
    } catch (e) {
      NET.error = e?.name === 'TimeoutError' ? '超时' : (e?.message ?? '失败')
    }
  }
  NET.offsetMs = null
  NET.source = ''
  NET.at = Date.now()
  return false
}

/** 需要时在后台刷新网络时间; 调用方永远不等它 */
function refreshNetIfStale(now, allowNet) {
  // AICS_CLOCK_NET=0: 完全不联网校时 (只看本机四个来源)
  if (!allowNet || process.env.AICS_CLOCK_NET === '0' || NET.busy) return
  if (NET.offsetMs !== null && now - NET.at < NET_TTL_MS) return
  if (NET.at && now - NET.at < 60_000) return   // 失败后退避 1 分钟再试
  NET.busy = true
  probeNetNow().catch(() => {}).finally(() => { NET.busy = false })
}

/** 给测试/诊断用: 当前网络时间缓存 */
export function netClockState() {
  return { ...NET }
}

/** 来源的中文名 (提示语 / 诊断报告共用) */
export const SOURCE_LABELS = {
  anchor: '水位对比',
  session: '进程内单调时钟',
  monotonic: '开机时长对比',
  bootTime: '开机时刻单调性',
  fs: '文件时间戳',
  net: '网络时间',
}

function evidenceText(anchorHit, evidence) {
  const names = []
  if (anchorHit) names.push(SOURCE_LABELS.anchor)
  for (const e of evidence) names.push(SOURCE_LABELS[e.source] ?? e.source)
  return names.length ? '来源: ' + [...new Set(names)].join(' + ') : '来源: 未知'
}

/** 解析一条锚点记录; 签名不对 / 结构不对 → 判为无效 */
function parseRecord(raw) {
  let j
  try {
    j = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return { ok: false, reason: '解析失败' }
  }
  if (!j || typeof j !== 'object') return { ok: false, reason: '结构不对' }
  for (const k of ['firstSeen', 'lastSeen', 'maxSeen']) {
    if (!Number.isFinite(Number(j[k]))) return { ok: false, reason: `缺少 ${k}` }
  }
  if (j.v === 1) {
    // 第 2 步写下的老锚点: 认得出来就继续用它的水位 (只是没有 uptime/开机时刻),
    // 下一次落盘会自动升级成 v2。直接丢弃会白白让水位归零。
    if (!SECRETS.some((secret) => j.sig === signAnchorV1With(j, secret))) {
      return { ok: false, reason: '签名不匹配 (被改过)' }
    }
    return { ok: true, record: { ...j, uptimeMs: 0, bootTimeMs: 0 }, legacy: true }
  }
  if (j.v !== VERSION) return { ok: false, reason: `版本不认识: ${j.v}` }
  if (!SECRETS.some((secret) => j.sig === signWith(j, secret))) {
    return { ok: false, reason: '签名不匹配 (被改过)' }
  }
  return { ok: true, record: j }
}

// ---------------------------------------------------------------- 三处存放位置

export function anchorLocations(dataDir) {
  return {
    main: path.join(dataDir, 'timeguard.json'),
    profile: path.join(dataDir, 'profile', '.aics-ts'),
    registry: process.platform === 'win32' ? REG_KEY : '',
  }
}

function readFileAnchor(file) {
  try {
    if (!fs.existsSync(file)) return { name: file, present: false }
    return { name: file, present: true, ...parseRecord(fs.readFileSync(file, 'utf-8')) }
  } catch (e) {
    return { name: file, present: true, ok: false, reason: `读取失败: ${e.message}` }
  }
}

function writeFileAnchor(file, rec) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(rec), 'utf-8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

function regQueryValues() {
  if (process.platform !== 'win32') return null
  try {
    // stderr 必须吞掉: 键不存在时 reg 会打印"系统找不到指定的注册表项", 那是正常情况
    const out = execFileSync('reg', ['query', REG_KEY], {
      encoding: 'utf-8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    const vals = {}
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s+(\S+)\s+REG_SZ\s+(.+)$/)
      if (m) vals[m[1]] = m[2].trim()
    }
    return vals
  } catch {
    return null // 键不存在 = 这类源还没建, 不算异常
  }
}

function readRegistryAnchor() {
  if (process.platform !== 'win32') return { name: 'registry', present: false, unsupported: true }
  const vals = regQueryValues()
  if (!vals) return { name: 'registry', present: false }
  const recent = {
    v: VERSION,
    firstSeen: Number(vals.first),
    lastSeen: Number(vals.last),
    maxSeen: Number(vals.ts),
    uptimeMs: Number(vals.up ?? 0),
    bootTimeMs: Number(vals.boot ?? 0),
    runs: Number(vals.runs ?? 0),
    updatedAt: Number(vals.last),
    sig: vals.sig,
  }
  const okNow = parseRecord(recent)
  if (okNow.ok) return { name: 'registry', present: true, ...okNow }
  // 老版本注册表记录没有 v/up/boot 两个值, 按 v1 的签名规则再试一次
  const legacy = parseRecord({
    v: 1,
    firstSeen: recent.firstSeen,
    lastSeen: recent.lastSeen,
    maxSeen: recent.maxSeen,
    runs: recent.runs,
    updatedAt: recent.updatedAt,
    sig: vals.sig,
  })
  return { name: 'registry', present: true, ...(legacy.ok ? legacy : okNow) }
}

function writeRegistryAnchor(rec, prev, opts = {}) {
  if (process.platform !== 'win32') return false
  // 值没变就不写 —— reg add 要起进程 (30~60ms), 别每次读状态都付这个代价
  // 但"读不出来"(老版本没有 v/up/boot 值, 或签名对不上) 时必须补写一次
  if (!opts.force && prev && prev.record?.maxSeen === rec.maxSeen && prev.record?.v === VERSION) return true
  const add = (name, value) => ['add', REG_KEY, '/v', name, '/t', 'REG_SZ', '/d', String(value), '/f']
  const quiet = { windowsHide: true, timeout: 5000, stdio: ['ignore', 'ignore', 'ignore'] }
  try {
    execFileSync('reg', add('v', rec.v), quiet)
    execFileSync('reg', add('ts', rec.maxSeen), quiet)
    execFileSync('reg', add('first', rec.firstSeen), quiet)
    execFileSync('reg', add('last', rec.lastSeen), quiet)
    execFileSync('reg', add('up', Math.round(rec.uptimeMs ?? 0)), quiet)
    execFileSync('reg', add('boot', Math.round(rec.bootTimeMs ?? 0)), quiet)
    execFileSync('reg', add('runs', rec.runs), quiet)
    execFileSync('reg', add('sig', rec.sig), quiet)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- 读取 / 判定

/**
 * 读出三处锚点并合并。
 * @param {string} dataDir
 * @param {number} [now]
 */
export function readAnchors(dataDir, now = Date.now()) {
  const loc = anchorLocations(dataDir)
  const sources = [readFileAnchor(loc.main), readFileAnchor(loc.profile), readRegistryAnchor()]
  const label = (s) => (
    s.name === 'registry' ? '注册表'
      : s.name === loc.main ? 'data/timeguard.json' : 'data/profile/.aics-ts'
  )

  let firstSeen = Infinity
  let lastSeen = 0
  let maxSeen = 0
  let uptimeMs = 0
  let bootTimeMs = 0
  let invalid = 0
  let future = 0
  let validCount = 0

  for (const s of sources) {
    if (!s.present) continue
    if (!s.ok) {
      invalid++
      continue
    }
    const r = s.record
    const top = Math.max(r.maxSeen, r.lastSeen, r.firstSeen)
    if (top > now + MAX_FUTURE_MS) {
      // 未来太远: 这次读数不可信, 丢弃 —— 否则"调一次未来"会把自己锁死
      future++
      continue
    }
    validCount++
    firstSeen = Math.min(firstSeen, r.firstSeen)
    lastSeen = Math.max(lastSeen, r.lastSeen)
    maxSeen = Math.max(maxSeen, r.maxSeen)
    if (Number.isFinite(Number(r.uptimeMs))) uptimeMs = Math.max(uptimeMs, Number(r.uptimeMs))
    if (Number.isFinite(Number(r.bootTimeMs))) bootTimeMs = Math.max(bootTimeMs, Number(r.bootTimeMs))
  }

  return {
    sources: sources.map((s) => ({
      name: label(s),
      present: !!s.present,
      ok: !!s.ok,
      reason: s.reason,
      unsupported: !!s.unsupported,
      maxSeen: s.ok ? s.record.maxSeen : undefined,
    })),
    firstSeen: validCount ? firstSeen : now,
    lastSeen: validCount ? lastSeen : now,
    maxSeen: validCount ? maxSeen : now,
    uptimeMs,
    bootTimeMs,
    invalid,
    future,
    hasAny: validCount > 0,
  }
}

/**
 * 推进时间轴并给出判定报告 (读授权状态时调用)。
 * @param {string} dataDir
 * @param {{force?:boolean, now?:number, monoMs?:number, sysUptimeMs?:number,
 *          netOffsetMs?:number, fsNewestMs?:number, net?:boolean, registry?:boolean}} [opts]
 *   now / monoMs / netOffsetMs / fsNewestMs 是给测试注入合成值的口子 (生产不传)
 *   registry:false 只写两个文件锚点, 不碰注册表 —— 自动化测试必须用它:
 *   注册表锚点是**全机共用**的, 测试塞进去的合成时间会把真机的锚点带偏。
 */
export function clockReport(dataDir, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  /**
   * 两个不同的单调量, 不能混:
   *   monoProc 进程内单调 Clock (process.uptime) —— 只在本次进程有效, 用来抓"运行中改时间";
   *   monoSys  系统开机时长 (os.uptime)     —— 跨进程/跨重启有效, 用来对比开机时长与开机时刻。
   * 早先把两者混成一个值, 结果应用一重启, 锚点里的 uptime 就和新进程对不上,
   * "开机时长对比"这一路直接被误判成"期间重启过系统"。
   */
  const monoProc = Number.isFinite(opts.monoMs) ? opts.monoMs : process.uptime() * 1000
  const monoSys = Number.isFinite(opts.sysUptimeMs) ? opts.sysUptimeMs : systemUptimeMs()
  const exotic = opts.force === true || Number.isFinite(opts.now)
  if (!exotic && REPORT_CACHE.has(dataDir)) {
    const hit = REPORT_CACHE.get(dataDir)
    // 用绝对值比较: force 检查可能带着合成时间戳进来, 缓存要能被它刷新
    if (Math.abs(now - hit.at) < REPORT_CACHE_MS) return hit.report
  }
  const before = readAnchors(dataDir, now)
  const toleranceMs = clockToleranceMs()
  const anchorSkewMs = Math.max(0, before.maxSeen - now)

  // ------------------------------------------------ 多源交叉校验
  refreshNetIfStale(now, opts.net !== false)
  const checks = []
  const add = (source, ok, skewMs, detail) => checks.push({ source, ok, skewMs: Math.round(skewMs), detail })

  // 1) 进程内单调时钟 —— 最硬的一条: 与系统时间无关
  const dWall = now - PROC_BASE.wall
  const dMono = monoProc - PROC_BASE.mono
  add('session', dMono > 5000, dMono - dWall, '进程内单调时钟')

  // 2) 开机时长 vs 墙钟增量 (同一次开机内)
  const sameBoot = Number.isFinite(monoSys) && before.hasAny && before.uptimeMs > 0 && monoSys >= before.uptimeMs
  if (sameBoot) {
    const dU = monoSys - before.uptimeMs
    const dW = now - before.lastSeen
    add('monotonic', dU > 5000, dU - dW, '开机时长与墙钟增量对比')
  } else {
    add('monotonic', false, 0, !Number.isFinite(monoSys) ? '取不到系统开机时长'
      : before.hasAny ? '期间重启过系统' : '还没有历史锚点')
  }

  // 3) 开机时刻只应越来越晚 (跨重启也成立)
  const nowBoot = monoSys > 0 ? now - monoSys : NaN
  if (before.hasAny && before.bootTimeMs > 0 && Number.isFinite(nowBoot)) {
    add('bootTime', true, before.bootTimeMs - nowBoot, '开机时刻单调性')
  } else {
    add('bootTime', false, 0, before.hasAny ? '没有开机时刻记录' : '还没有历史锚点')
  }

  // 4) 文件时间戳: data/ 里最新写过的文件不该"跑到未来"
  const fsProbe = Number.isFinite(opts.fsNewestMs)
    ? { ms: opts.fsNewestMs, file: '(注入)' }
    : newestFileMtime(dataDir)
  if (fsProbe.ms > 0) {
    add('fs', true, fsProbe.ms - now, `data/ 最新文件时间${fsProbe.file ? ' · ' + path.basename(fsProbe.file) : ''}`)
  } else {
    add('fs', false, 0, '没扫到文件')
  }

  // 5) 网络时间 (HTTP Date, 后台刷新; 离线时自动跳过)
  const netOffset = Number.isFinite(opts.netOffsetMs) ? opts.netOffsetMs : NET.offsetMs
  if (Number.isFinite(netOffset)) {
    add('net', true, netOffset, `网络时间 (${NET.source || '注入'})`)
  } else {
    add('net', false, 0, process.env.AICS_CLOCK_NET === '0'
      ? '已关闭 (AICS_CLOCK_NET=0)'
      : NET.error ? `不可用: ${NET.error}` : '还没取到')
  }

  const HIGH_CONFIDENCE = ['session', 'monotonic', 'bootTime', 'net']
  const evidence = checks.filter((c) => c.ok && c.skewMs > toleranceMs)
  const highEvidence = evidence.filter((c) => HIGH_CONFIDENCE.includes(c.source))
  const evidenceMaxMs = evidence.reduce((m, c) => Math.max(m, c.skewMs), 0)
  const skewMs = Math.max(anchorSkewMs, evidenceMaxMs)
  const tamper = anchorSkewMs > toleranceMs || evidence.length > 0
  const hardTamper = anchorSkewMs > HARD_TAMPER_MS || highEvidence.length > 0

  const events = tamper ? [{ at: now, skewMs, seen: before.maxSeen }] : []
  const merged = {
    // 水位取"历史最高"与"现在"的较大者: 正常使用时跟着现在走, 回拨时不下降
    firstSeen: Math.min(before.firstSeen, now),
    lastSeen: Math.max(before.lastSeen, now),
    maxSeen: Math.max(before.maxSeen, now),
  }

  // 落盘: 首次 / 超过节流间隔 / 命中回拨(必须留证据) 时才写
  const stale = !before.hasAny || Math.abs(now - before.lastSeen) > TOUCH_THROTTLE_MS
  const shouldWrite = opts.force === true || stale || tamper
  let wrote = false
  let runs = 0
  let history = events
  if (shouldWrite) {
    const loc = anchorLocations(dataDir)
    const prev = readFileAnchor(loc.main)
    const prevOk = prev.ok === true
    // 注册表那一份如果"没有"或"读不出来" (老版本 / 签名对不上 / 被删了),
    // 这次必须补写 —— 否则首次安装要等下一次超过节流间隔才建起这一份冗余。
    const regSource = before.sources.find((s) => s.name === '注册表')
    const regNeedsRepair = !!regSource && !regSource.unsupported && (!regSource.present || !regSource.ok)
    const rec = makeRecord(
      prevOk ? { ...prev.record, events: [...(prev.record.events ?? []), ...events].slice(-EVENTS_KEEP) } : null,
      now,
      { uptimeMs: monoSys, bootTimeMs: nowBoot },
    )
    rec.firstSeen = merged.firstSeen
    rec.maxSeen = merged.maxSeen
    rec.lastSeen = merged.lastSeen
    rec.sig = sign(rec)
    wrote = writeFileAnchor(loc.main, rec) || wrote
    wrote = writeFileAnchor(loc.profile, rec) || wrote
    // AICS_CLOCK_NO_REGISTRY=1: 整体不碰注册表 (自动化测试必须设,
    // 否则测试里的合成时间会写进全机共用的注册表锚点, 把真机带偏)
    if (opts.registry !== false && process.env.AICS_CLOCK_NO_REGISTRY !== '1') {
      wrote = writeRegistryAnchor(rec, prevOk ? prev : null, { force: regNeedsRepair }) || wrote
    }
    runs = rec.runs
    history = rec.events ?? events
  }

  const report = {
    ok: !tamper,
    tamper,
    /** 硬回拨 (高置信来源命中, 或水位回拨 > 24 小时): 严格模式下判无效 */
    hardTamper,
    strict: clockStrict(),
    skewMs,
    /** 只看水位的那一份回拨量 (与之相对 skewMs 是全体来源里的最大值) */
    anchorSkewMs,
    toleranceMs,
    firstSeen: merged.firstSeen,
    lastSeen: merged.lastSeen,
    maxSeen: merged.maxSeen,
    runs,
    invalidSources: before.invalid,
    futureReads: before.future,
    sources: before.sources,
    /** 五个交叉校验来源 (含未命中的, 便于排障时看"哪些源可用") */
    checks,
    /** 命中容差的来源 —— 提示语与诊断都基于它 */
    evidence,
    wrote,
    events: history,
    /** 给 UI / 日志用的一句话 */
    text: tamper
      ? `检测到系统时间回拨约 ${(skewMs / 3600_000).toFixed(1)} 小时（${evidenceText(anchorSkewMs > toleranceMs, evidence)}）`
      : '',
  }
  // 缓存总是刷新 (force 的语义就是"重新读一次真实状态")
  REPORT_CACHE.set(dataDir, { at: now, report })
  return report
}

/** 清空三处锚点 (排障 / 重置用) */
export function resetClock(dataDir) {
  const loc = anchorLocations(dataDir)
  for (const f of [loc.main, loc.profile]) {
    try { fs.unlinkSync(f) } catch { /* 不存在就算了 */ }
  }
  if (process.platform === 'win32') {
    try {
      execFileSync('reg', ['delete', REG_KEY, '/f'], {
        windowsHide: true, timeout: 5000, stdio: ['ignore', 'ignore', 'ignore'],
      })
    } catch { /* 不存在就算了 */ }
  }
}
   