// ============================================================
// 授权门禁内核 (CommonJS, 随主进程打进 app.asar)
//
// 为什么要有这一份"重复实现":
//   bundle/ 下的 server.mjs 与 tools/*.mjs 必须解包到 app.asar.unpacked
//   (Node 的 ESM 加载器读不到 asar 内部), 那些文件是**明文**,
//   改一个 if 就能让界面显示"已激活"。
//   所以真正的门禁放在这里: 它在 app.asar 内, 配合 Electron Fuses 的
//   asar 完整性校验 —— 改一个字节程序直接拒绝启动。
//
// 它只做一件事: **决定放不放行**。界面上的授权详情仍然由
//   server.mjs 的 /api/license 提供 (那份是明文的, 但它不再决定放行)。
//
// ⚠️ 与 tools/license.mjs + tools/machine.mjs + tools/clockguard.mjs
//    是同一套格式的两份实现, 改动其中任何一处都必须同步另一处,
//    并由 work/_test_license_core.mjs 交叉验证 (两份实现必须给出同样的结论)。
// ============================================================

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

/**
 * 122 P1-2：构建期随机密钥。stage 会把 license-secrets.json 写进 bundle；
 * 这里优先读它，源码态/旧包没有文件才回退旧常量。
 * 旧常量仍放进兼容列表，保证老 machine.json / timeguard.json 还能读。
 */
const LEGACY_CACHE_GUARD_SECRET = 'aics.machine.guard.v1.7f3a9c1e5b8d2046'
const LEGACY_CLOCK_SECRET = 'aics.timeguard.v1.9d2f7c4b6a1e8035'
function loadBuildSecrets() {
  const out = {
    cacheGuard: LEGACY_CACHE_GUARD_SECRET,
    clock: LEGACY_CLOCK_SECRET,
    legacyCacheGuard: [LEGACY_CACHE_GUARD_SECRET],
    legacyClock: [LEGACY_CLOCK_SECRET],
  }
  const candidates = [
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'bundle', 'license-secrets.json'),
  ]
  for (const file of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (j && typeof j.cacheGuard === 'string' && j.cacheGuard.length >= 16) out.cacheGuard = j.cacheGuard
      if (j && typeof j.clock === 'string' && j.clock.length >= 16) out.clock = j.clock
      if (Array.isArray(j?.legacy?.cacheGuard)) out.legacyCacheGuard.push(...j.legacy.cacheGuard.filter((s) => typeof s === 'string'))
      if (Array.isArray(j?.legacy?.clock)) out.legacyClock.push(...j.legacy.clock.filter((s) => typeof s === 'string'))
      break
    } catch { /* 下一个候选 */ }
  }
  out.legacyCacheGuard = [...new Set([out.cacheGuard, ...out.legacyCacheGuard, LEGACY_CACHE_GUARD_SECRET])]
  out.legacyClock = [...new Set([out.clock, ...out.legacyClock, LEGACY_CLOCK_SECRET])]
  return out
}
const BUILD_SECRETS = loadBuildSecrets()

// ---------------------------------------------------------------- 常量 (与 ESM 侧保持一致)

const LICENSE_PREFIX = 'AICS1'
const LICENSE_PREFIX_V2 = 'AICS2'
const SHELL_VERSION = 1
const LICENSE_VERSION = 1
const PART_KEYS = ['os', 'board', 'bios', 'cpu', 'disk']
const MAX_TOLERANCE = 2
const SHELL_INFO = Buffer.from(`${LICENSE_PREFIX_V2}|outer|${SHELL_VERSION}`, 'utf-8')
const SHELL_AAD = Buffer.from(`${LICENSE_PREFIX_V2}.${SHELL_VERSION}`, 'utf-8')
const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32
const CACHE_GUARD_SECRET = BUILD_SECRETS.cacheGuard
const CLOCK_SECRET = BUILD_SECRETS.clock
const CACHE_GUARD_SECRETS = BUILD_SECRETS.legacyCacheGuard
const CLOCK_SECRETS = BUILD_SECRETS.legacyClock
const CLOCK_VERSION = 2
const CLOCK_SIGNED_FIELDS = ['v', 'firstSeen', 'lastSeen', 'maxSeen', 'uptimeMs', 'bootTimeMs', 'runs']
const CLOCK_DEFAULT_TOLERANCE_MS = 6 * 60 * 60 * 1000
const CLOCK_HARD_TAMPER_MS = 24 * 60 * 60 * 1000
const CLOCK_MAX_FUTURE_MS = 5 * 365 * 24 * 60 * 60 * 1000
const REG_KEY = 'HKCU\\Software\\Manke\\TimeGuard'
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 内嵌公钥 —— 与 tools/license.mjs 的 LICENSE_PUBLIC_KEY_PEM 必须一致 */
const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAFUxutcwPIkaCYupm6DObV5Vbi+j81IGdbxCsI3tPdUU=
-----END PUBLIC KEY-----
`

// ---------------------------------------------------------------- 小工具

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const unb64u = (s) => Buffer.from(String(s), 'base64url')

/** 稳定序列化 (键名排序) —— 与 ESM 侧 canonicalJson 完全一致 */
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const keys = Object.keys(v).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
}

function publicKeyObject() {
  return crypto.createPublicKey(LICENSE_PUBLIC_KEY_PEM)
}

function deriveShellKey(ikm, salt) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(ikm, 'utf-8'), salt, SHELL_INFO, KEY_LEN))
}

const partsIkm = (parts, keys) => `${LICENSE_PREFIX_V2}|parts|${keys.map((k) => `${k}=${parts[k]}`).join('|')}`
const codeIkm = (code) => `${LICENSE_PREFIX_V2}|code|${String(code).replace(/[^0-9A-Za-z]/g, '').toUpperCase()}`

/** 分量组合: 大小 >= 分量数 - 容差, 且至少 2 个 (与 candidateSets 一致) */
function candidateSets(parts, tolerance = MAX_TOLERANCE) {
  const present = PART_KEYS.filter((k) => parts && parts[k])
  const n = present.length
  if (n < 2) return []
  const tol = Math.max(0, Math.min(MAX_TOLERANCE, Number.isFinite(tolerance) ? Math.floor(tolerance) : MAX_TOLERANCE))
  const minSize = Math.max(2, n - tol)
  const out = []
  const seen = new Set()
  const acc = []
  const walk = (start) => {
    if (acc.length >= minSize) {
      const key = acc.join('|')
      if (!seen.has(key)) { seen.add(key); out.push(acc.slice()) }
    }
    if (acc.length >= n) return
    for (let i = start; i < n; i++) { acc.push(present[i]); walk(i + 1); acc.pop() }
  }
  walk(0)
  out.sort((a, b) => b.length - a.length)
  return out
}

// ---------------------------------------------------------------- 硬件指纹

function regQuery(key, value) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', value], {
      encoding: 'utf-8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    const m = out.match(/REG_SZ\s+(.+)/)
    return m ? m[1].trim() : ''
  } catch { return '' }
}

function psQueryAll() {
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$r = [ordered]@{}',
    '$r.board = (Get-CimInstance Win32_ComputerSystemProduct).UUID',
    '$r.bios  = (Get-CimInstance Win32_BIOS).SerialNumber',
    '$r.cpu   = (Get-CimInstance Win32_Processor | Select-Object -First 1).ProcessorId',
    '$r.disk  = (Get-CimInstance Win32_LogicalDisk -Filter "DeviceID=\'C:\'").VolumeSerialNumber',
    '$r | ConvertTo-Json -Compress',
  ].join('; ')
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf-8', windowsHide: true, timeout: 20000,
    })
    return JSON.parse(out.trim() || '{}')
  } catch { return {} }
}

function useful(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  if (/^0+$/.test(s)) return ''
  if (/^F+$/i.test(s)) return ''
  if (/^(to be filled|default string|none|n\/a|system serial number|\.+)$/i.test(s)) return ''
  if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(s)) return ''
  return s
}

const sha16 = (s) => crypto.createHash('sha256').update(String(s), 'utf-8').digest('hex').slice(0, 16)

let partsCache = null

/** 同步睡一会儿 (采集重试之间用) */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* 不支持就跳过 */ }
}

/**
 * 采集本机五个分量 (只做一次, 之后走内存缓存)。
 * ⚠️ 分量少于 3 个要重试: 冷启动那一下 PowerShell/CIM 可能还没热或被安全软件卡住,
 *    只拿到 os 一个分量时算出来的是**另一个机器码**(与 tools/machine.mjs 同一口径,
 *    实测: 完整 = 4QDP-0F17-SX7A-P3AG / 只有 os = 6P4M-E89A-VJNP-1MQM) ——
 *    同一台机器两个码 = 管理员按其中一个签发的授权永远验不过。
 */
function collectParts() {
  if (partsCache) return partsCache
  const read = () => {
    const hw = process.platform === 'win32' ? psQueryAll() : {}
    return {
      os: useful(regQuery('HKLM\\SOFTWARE\\Microsoft\\Cryptography', 'MachineGuid')),
      board: useful(hw.board),
      bios: useful(hw.bios),
      cpu: useful(hw.cpu),
      disk: useful(hw.disk),
    }
  }
  let raw = read()
  for (let i = 1; i < 3 && PART_KEYS.filter((k) => raw[k]).length < 3; i++) {
    sleepSync(350)
    raw = read()
  }
  const parts = {}
  for (const k of PART_KEYS) parts[k] = raw[k] ? sha16(raw[k]) : ''
  partsCache = parts
  return parts
}

function crockford(buf, len) {
  let out = ''
  let bits = 0
  let acc = 0
  for (const byte of buf) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5 && out.length < len) {
      out += CROCKFORD[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
    if (out.length >= len) break
  }
  return out
}

function codeFromParts(parts) {
  const basis = PART_KEYS.map((k) => parts[k] || '-').join('|')
  const digest = crypto.createHash('sha256').update(basis, 'utf-8').digest()
  const c = crockford(digest, 16)
  return c.replace(/(.{4})(?=.)/g, '$1-')
}

/** 缓存守卫: 与 tools/machine.mjs 的 cacheGuard 一致 (把分量一起签进去) */
function cacheGuardWith(code, seed, parts, secret) {
  const basis = PART_KEYS.map((k) => (parts && parts[k]) || '').join(',')
  return crypto.createHmac('sha256', secret)
    .update(`${code}|${seed}|${basis}`, 'utf-8')
    .digest('hex')
    .slice(0, 32)
}
function cacheGuard(code, seed, parts) {
  return cacheGuardWith(code, seed, parts, CACHE_GUARD_SECRET)
}

/**
 * 取得本机分量。
 * 优先用 data/machine.json 的缓存 (省掉 1~3 秒的硬件采集), 但必须通过
 * 缓存守卫校验 —— 守卫由**实时读取的 MachineGuid**参与 HMAC, 所以把整个
 * data 目录拷到另一台电脑时, 这份缓存会立刻失效, 门禁不会跟着走。
 * 守卫对不上就退回自己采集 (慢一点, 但结论可靠)。
 */
function machineParts(dataDir) {
  try {
    const file = path.join(dataDir, 'machine.json')
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (j && j.code && j.parts) {
        // 守卫只需要一次注册表读取 (~30ms), 不用重新跑一遍硬件采集
        const seed = regQuery('HKLM\\SOFTWARE\\Microsoft\\Cryptography', 'MachineGuid')
        const code = codeFromParts(j.parts)
        const guardOk = seed
          ? CACHE_GUARD_SECRETS.some((s) => j.guard === cacheGuardWith(code, seed, j.parts, s))
          : false
        if (guardOk && j.code === code) {
          /** 旧版本密钥命中的缓存顺手迁移到当前构建密钥，下次不用再试旧值。 */
          if (seed && j.guard !== cacheGuard(code, seed, j.parts)) {
            try {
              j.guard = cacheGuard(code, seed, j.parts)
              fs.writeFileSync(file, JSON.stringify(j, null, 2), 'utf-8')
            } catch { /* 写不动不影响本次判定 */ }
          }
          const present = PART_KEYS.filter((k) => j.parts[k])
          return { parts: j.parts, code, source: 'cache', present, partial: !!j.partial, weak: present.length < 3 }
        }
      }
    }
  } catch { /* 缓存坏了就用实时采集 */ }
  /**
   * 缓存缺失/对不上 (跨机复制、系统重装、手工改过) → 自己采集, 并且**把结果冻下来**。
   *
   * ★ 为什么门禁也要写这份缓存 (2026-10-02 修; 用户报"有一台电脑授权就是不行"):
   *   以前只有服务端(打开激活页时)会写 machine.json —— 门禁每次启动都实时采集一次。
   *   而机器码 = 五个分量哈希的哈希, 少一个分量就是另一个码(实测差一个分量就完全不同)。
   *   冷启动 PowerShell 没热 / 被安全软件卡住时只拿得到 os → 门禁算出来的是"残缺码",
   *   页面稍后采集到完整分量 → 显示的是"完整码"; 管理员按页面那个码签发,
   *   门禁这边(或下一次启动)又是另一个码 → 客户端永远报"授权与本机不匹配"。
   *   现在: 谁先采集谁就把这份指纹冻下来, 门禁与页面从此读同一份, 码不再漂移。
   */
  const parts = collectParts()
  const code = codeFromParts(parts)
  const present = PART_KEYS.filter((k) => parts[k])
  try {
    const file = path.join(dataDir, 'machine.json')
    const seed = regQuery('HKLM\\SOFTWARE\\Microsoft\\Cryptography', 'MachineGuid')
    const rec = {
      code, parts, present, partial: present.length < PART_KEYS.length, weak: present.length < 3,
      collectedAt: new Date().toISOString(), platform: process.platform,
      frozen: true, cached: false, frozenBy: 'gate',
    }
    if (seed) rec.guard = cacheGuard(code, seed, parts)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(rec, null, 2), 'utf-8')
  } catch { /* 写不动不影响本次判定 */ }
  return { parts, code, source: 'live', present, partial: present.length < PART_KEYS.length, weak: present.length < 3 }
}

// ---------------------------------------------------------------- 授权校验

function shellSignBasis(saltB64, payloadJson) {
  return Buffer.from(`${LICENSE_PREFIX_V2}.${SHELL_VERSION}.${saltB64}.${payloadJson}`, 'utf-8')
}

function checkExpiry(p) {
  const now = Date.now()
  /**
   * 122 P1-3：日期字段解析失败必须 fail-closed。
   * 旧写法 `now > Date.parse('乱写')` 恒为 false（NaN 比较），等于把坏授权当永久。
   */
  if (p.nbf) {
    const nbf = Date.parse(p.nbf)
    if (!Number.isFinite(nbf)) return `授权生效时间格式不正确 (${p.nbf})`
    if (now < nbf) return `授权尚未生效 (生效时间 ${p.nbf})`
  }
  if (p.exp) {
    const exp = Date.parse(p.exp)
    if (!Number.isFinite(exp)) return `授权到期时间格式不正确 (${p.exp})`
    if (now > exp) return `授权已过期 (到期 ${p.exp})`
  }
  return ''
}

/** AICS2 密文外壳。解开外壳本身就等于通过设备绑定 */
function verifyV2(str, mi) {
  const segs = String(str).split('.')
  if (segs.length < 5) return { ok: false, reason: '外壳格式不完整' }
  if (segs[1] !== String(SHELL_VERSION)) return { ok: false, reason: `外壳版本不认识: ${segs[1]}` }

  let salt, body, wraps
  try {
    salt = unb64u(segs[2]); body = unb64u(segs[3]); wraps = segs.slice(4).map(unb64u)
  } catch { return { ok: false, reason: '外壳内容无法解析' } }
  if (body.length < IV_LEN + TAG_LEN + 1) return { ok: false, reason: '外壳密文长度异常' }

  const candidates = []
  for (const keys of candidateSets(mi.parts)) candidates.push({ kind: 'parts', keys, ikm: partsIkm(mi.parts, keys) })
  if (mi.code) candidates.push({ kind: 'code', keys: [], ikm: codeIkm(mi.code) })

  let ck = null
  let hit = null
  outer:
  for (const cand of candidates) {
    const kek = deriveShellKey(cand.ikm, salt)
    for (const w of wraps) {
      if (w.length < IV_LEN + TAG_LEN + 1) continue
      try {
        const d = crypto.createDecipheriv('aes-256-gcm', kek, w.subarray(0, IV_LEN))
        d.setAAD(SHELL_AAD)
        d.setAuthTag(w.subarray(IV_LEN, IV_LEN + TAG_LEN))
        const got = Buffer.concat([d.update(w.subarray(IV_LEN + TAG_LEN)), d.final()])
        if (got.length === KEY_LEN) { ck = got; hit = cand; break outer }
      } catch { /* 换下一把候选 */ }
    }
  }
  if (!ck) return { ok: false, reason: '授权与本机不匹配 (硬件变动过多, 或授权属于其它设备)' }

  let inner
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', ck, body.subarray(0, IV_LEN))
    d.setAAD(SHELL_AAD)
    d.setAuthTag(body.subarray(IV_LEN, IV_LEN + TAG_LEN))
    inner = JSON.parse(Buffer.concat([d.update(body.subarray(IV_LEN + TAG_LEN)), d.final()]).toString('utf-8'))
  } catch { return { ok: false, reason: '外壳解密失败: 授权内容被改动过' } }
  if (!inner || !inner.p || !inner.s) return { ok: false, reason: '外壳内容结构不正确' }

  let sigOk = false
  try {
    sigOk = crypto.verify(null, shellSignBasis(segs[2], canonicalJson(inner.p)), publicKeyObject(), unb64u(inner.s))
  } catch { sigOk = false }
  if (!sigOk) return { ok: false, reason: '签名校验失败: 授权被修改过, 或不是本产品签发的' }

  const expErr = checkExpiry(inner.p)
  if (expErr) return { ok: false, reason: expErr, payload: inner.p }
  return { ok: true, payload: inner.p, match: { mode: hit.kind === 'parts' ? 'shell' : 'shell-code', hit: hit.keys } }
}

/** 分量命中判定 (容错规则与 tools/machine.mjs 的 matchParts 一致) */
function matchParts(licensed = {}, current = {}) {
  const comparable = PART_KEYS.filter((k) => licensed[k] && current[k])
  const hit = comparable.filter((k) => licensed[k] === current[k])
  const need = comparable.length <= 2 ? comparable.length : Math.max(2, comparable.length - 2)
  const idHit = ['os', 'board'].some((k) => hit.includes(k))
  return hit.length >= need && (idHit || hit.length >= 3)
}

/** AICS1 明文格式 (旧授权, 仍要能放行) */
function verifyV1(str, mi) {
  const segs = String(str).split('.')
  if (segs.length !== 3 || segs[0] !== LICENSE_PREFIX) return { ok: false, reason: '格式不正确' }
  let payload
  let sig
  let data
  try {
    data = unb64u(segs[1]); sig = unb64u(segs[2])
    payload = JSON.parse(data.toString('utf-8'))
  } catch { return { ok: false, reason: '授权内容无法解析' } }
  let sigOk = false
  try { sigOk = crypto.verify(null, data, publicKeyObject(), sig) } catch { sigOk = false }
  if (!sigOk) return { ok: false, reason: '签名校验失败' }
  const expErr = checkExpiry(payload)
  if (expErr) return { ok: false, reason: expErr, payload }
  const machines = Array.isArray(payload.machines) && payload.machines.length
    ? payload.machines
    : (payload.code || payload.parts ? [{ code: payload.code, parts: payload.parts }] : [])
  if (!machines.length) return { ok: false, reason: '授权里没有绑定任何机器' }
  for (const m of machines) {
    if (m.parts && Object.keys(m.parts).length) {
      if (matchParts(m.parts, mi.parts)) return { ok: true, payload, match: { mode: 'parts' } }
    } else if (m.code) {
      if (String(m.code).toUpperCase() === String(mi.code).toUpperCase()) {
        return { ok: true, payload, match: { mode: 'code' } }
      }
    }
  }
  return { ok: false, reason: '授权不匹配本机' }
}

/** 按前缀分派 */
function verifyLicense(str, mi) {
  const s = String(str ?? '').trim().replace(/\s+/g, '')
  if (!s) return { ok: false, reason: '授权内容为空' }
  if (s.toUpperCase().startsWith(`${LICENSE_PREFIX_V2}.`)) return verifyV2(s, mi)
  return verifyV1(s, mi)
}

function licenseFile(dataDir) {
  return path.join(dataDir, 'license.key')
}

function readLicense(dataDir) {
  try {
    const f = licenseFile(dataDir)
    if (!fs.existsSync(f)) return ''
    return fs.readFileSync(f, 'utf-8').trim()
  } catch { return '' }
}

function licenseFormat(str) {
  const s = String(str ?? '').trim().replace(/\s+/g, '').toUpperCase()
  if (s.startsWith(`${LICENSE_PREFIX_V2}.`)) return LICENSE_PREFIX_V2
  if (s.startsWith(`${LICENSE_PREFIX}.`)) return LICENSE_PREFIX
  return ''
}

// ---------------------------------------------------------------- 时间轴 (门禁侧精简版)

const clockToleranceMs = () => {
  const h = Number(process.env.AICS_CLOCK_TOLERANCE_H)
  if (Number.isFinite(h) && h >= 0 && h <= 24 * 30) return Math.round(h * 3600_000)
  return CLOCK_DEFAULT_TOLERANCE_MS
}

const clockStrict = () => process.env.AICS_CLOCK_STRICT === '1'

function clockSignWith(rec, secret) {
  const basis = JSON.stringify(CLOCK_SIGNED_FIELDS.map((k) => [k, rec[k] ?? 0]))
  return crypto.createHmac('sha256', secret).update(basis, 'utf-8').digest('hex').slice(0, 32)
}

function clockSign(rec) {
  return clockSignWith(rec, CLOCK_SECRET)
}

function clockSignV1With(rec, secret) {
  const basis = [1, rec.firstSeen, rec.lastSeen, rec.maxSeen, rec.runs ?? 0].join('|')
  return crypto.createHmac('sha256', secret).update(basis, 'utf-8').digest('hex').slice(0, 32)
}

function clockSignV1(rec) {
  return clockSignV1With(rec, CLOCK_SECRET)
}

/** 只读第一处锚点 (门禁不比诊断报告, 有一份可信的就够) */
function clockSkew(dataDir) {
  const anchors = []
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'timeguard.json'), 'utf-8'))
    if (j && Number.isFinite(Number(j.maxSeen))) anchors.push(j)
  } catch { /* 没有就算了 */ }
  const now = Date.now()
  let maxSeen = 0
  for (const j of anchors) {
    const okSig = CLOCK_SECRETS.some((secret) => {
      const signed = j.v === CLOCK_VERSION ? clockSignWith(j, secret) : (j.v === 1 ? clockSignV1With(j, secret) : '')
      return !!signed && signed === j.sig
    })
    if (!okSig) continue
    const top = Math.max(Number(j.maxSeen), Number(j.lastSeen), Number(j.firstSeen))
    if (top > now + CLOCK_MAX_FUTURE_MS) continue
    maxSeen = Math.max(maxSeen, Number(j.maxSeen))
  }
  const skewMs = Math.max(0, maxSeen - now)
  const toleranceMs = clockToleranceMs()
  return {
    tamper: skewMs > toleranceMs,
    hardTamper: skewMs > CLOCK_HARD_TAMPER_MS,
    skewMs,
    toleranceMs,
    strict: clockStrict(),
    text: skewMs > toleranceMs ? `检测到系统时间回拨约 ${(skewMs / 3600_000).toFixed(1)} 小时` : '',
  }
}

// ---------------------------------------------------------------- 对外入口

/**
 * 门禁判定。
 * @param {string} dataDir 数据目录 (打包态 = exe 同级 data/)
 * @param {{requireLicense?:boolean}} [opts]
 * @returns {{licensed:boolean,state:'active'|'unactivated'|'invalid',reason?:string,
 *            machineCode:string,format?:string,holder?:string,exp?:string,clock:object}}
 */
function checkLicense(dataDir, opts = {}) {
  const mi = machineParts(dataDir)
  const clock = clockSkew(dataDir)
  const raw = readLicense(dataDir)
  /**
   * 机器码口径一并回给主进程 (日志/窗口标题都写它):
   *   partsCount / partial 用来提醒"这台机器分量没采全, 别急着按这个码签发"。
   */
  const base = {
    machineCode: mi.code, clock, partsSource: mi.source,
    partsCount: (mi.present ?? []).length, partial: !!mi.partial, weak: !!mi.weak,
  }

  if (!raw) return { ...base, licensed: false, state: 'unactivated', reason: '尚未激活' }

  const r = verifyLicense(raw, mi)
  const format = licenseFormat(raw)
  if (!r.ok) return { ...base, licensed: false, state: 'invalid', reason: r.reason, format }

  // 时间被大幅回拨 + 严格模式 → 不放行
  if (clock.hardTamper && clock.strict) {
    return {
      ...base, licensed: false, state: 'invalid', format,
      reason: `${clock.text} —— 请把系统时间校准后重试`,
      holder: r.payload?.holder, exp: r.payload?.exp,
    }
  }
  return {
    ...base,
    licensed: true,
    state: 'active',
    format,
    holder: r.payload?.holder,
    exp: r.payload?.exp,
    warn: clock.tamper ? `${clock.text} · 已记录 (宽限模式)` : undefined,
  }
}

module.exports = {
  checkLicense,
  verifyLicense,
  machineParts,
  codeFromParts,
  clockSkew,
  licenseFile,
  readLicense,
  licenseFormat,
  // 供交叉验证测试用
  _internals: {
    candidateSets, canonicalJson, collectParts, codeFromParts, cacheGuard,
    PART_KEYS, LICENSE_PREFIX, LICENSE_PREFIX_V2,
  },
}
   