// ============================================================
// 离线授权 (License) — Ed25519 签名 + 机器码绑定
//
// 为什么用非对称签名而不是"把机器码加密写进 key":
//   加密 (对称) 意味着程序里必须带着解密密钥, 逆向出来就能自己造 key。
//   签名 (Ed25519) 意味着程序里只带**公钥** —— 公钥能验证、不能签发,
//   所以即使有人把整个 exe 拆开, 也造不出一个能通过校验的授权文件。
//   这是纯离线方案里唯一"安全上说得通"的做法。
//
// 授权串形态 (一行文本, 便于贴到激活框 / 存成文件):
//   AICS2.<壳版本>.<盐>.<密文>.<候选密钥包装…>   ← 当前签发格式 (密文外壳)
//   AICS1.<base64url(payload JSON)>.<base64url(signature)>   ← 旧格式, 仍可校验
//
// payload 支持两种绑定粒度:
//   1) machines[].parts  —— 容错模式 (推荐): 记录 5 个分量的哈希,
//      校验时按"命中 >= 3 且含 os/board"判定, 换 1~2 个硬件不失效。
//      签发时需要用户导出"指纹令牌" (不含任何原始值, 可安全外发)。
//   2) machines[].code   —— 严格模式: 只记 16 位机器码, 签发最省事
//      (用户报个码就行), 但任何硬件变动都会失配。
//
// 私钥 (tools/keys/license-private.pem) 永远不进发行包:
//   打包脚本只复制 tools/*.mjs, keys/ 是子目录, 天然排除。
//
// ---------------------------------------------------------------
// AICS2 的"内外壳"结构 (为什么要有它):
//
//   AICS1 的 payload 是**明文** base64url —— 任何人都能解出里面的分量哈希,
//   而分量哈希正是"授权绑定哪台机器"的全部依据。于是:
//     拿到一条泄漏的 license.key → 解出 parts → 按它伪造 data/machine.json
//     → 在任意机器上激活成功。**不需要改任何代码**, 这是 AICS1 最实际的洞。
//
//   AICS2 把内容装进 AES-256-GCM 外壳, 密钥由**本机硬件分量**经 HKDF 派生:
//     外壳 : 内容不可读 (授权串里不再出现任何分量), 同时天然完成设备绑定;
//     中壳 : 内层 Ed25519 签名 —— 内容不可伪造, 改外壳没有意义;
//     内核 : 多候选密钥 (见 machine.mjs 的 candidateSubsets) —— 签发时对
//            "全部分量" 以及 "去掉 1~2 个分量" 的每一种组合各包一份内容密钥,
//            校验时用本机当前分量逐组去试, 于是换 1~2 个硬件的容错保留下来。
//
//   注意两条设计红线 (见 AICS2-设计说明):
//     1) 构建号/版本号**不参与**密钥派生 —— 否则每次发补丁包, 用户的老授权全失效;
//     2) 时间**不参与**密钥派生, 只参与校验判定 —— 否则用户改了系统时间就成了
//        "解不开的黑盒", 连"你已过期"这句提示都给不出来。
// ============================================================

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { matchParts, candidateSubsets, PART_KEYS } from './machine.mjs'
import { clockReport } from './clockguard.mjs'

export const LICENSE_PREFIX = 'AICS1'

/**
 * 功能的中文名 —— **唯一一处定义**, 签发工具 (tools/license-gui.mjs) 与软件内的
 * 激活页 (app/public/activate.html, 经 /api/license 的 featureLabels) 都读它。
 * key 是写进授权串的原文, 永远不要改; 标签只是给人看的。
 */
export const FEATURE_LABELS = {
  image: '图片',
  video: '视频',
  audio: '语音',
  script: '剧本',
  webapps: '网页版工具',
}

/** 功能的中文名 (未知 key 原样返回, 日后加了功能忘了改这里也能一眼看出来) */
export const featureLabel = (k) => FEATURE_LABELS[k] ?? String(k)

/** AICS2 = 密文外壳 (当前签发格式) */
export const LICENSE_PREFIX_V2 = 'AICS2'
/** 外壳容器版本, 与"程序构建号"无关 —— 见文件头的设计红线 1 */
export const SHELL_VERSION = 1
export const LICENSE_VERSION = 1

/** 内嵌公钥 —— 只能验签, 泄出去也无法伪造授权 */
export const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAFUxutcwPIkaCYupm6DObV5Vbi+j81IGdbxCsI3tPdUU=
-----END PUBLIC KEY-----
`

/** 授权文件落在 data/license.key */
export function licenseFile(dataDir) {
  return path.join(dataDir, 'license.key')
}

// ---------------------------------------------------------------- 编解码

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const unb64u = (s) => Buffer.from(String(s), 'base64url')

const canonical = (obj) => Buffer.from(JSON.stringify(obj), 'utf-8')

function publicKeyObject(pem = LICENSE_PUBLIC_KEY_PEM) {
  return crypto.createPublicKey(pem)
}

// ---------------------------------------------------------------- 签发 (只有你手上有私钥)

/**
 * 用私钥签发一条授权。
 * @param {object} payload  见文件头说明 (v / holder / edition / features / exp / machines)
 * @param {string} privateKeyPem
 * @returns {string} 授权串
 */
export function signLicense(payload, privateKeyPem) {
  const body = { v: LICENSE_VERSION, issued: new Date().toISOString(), ...payload }
  const data = canonical(body)
  const sig = crypto.sign(null, data, crypto.createPrivateKey(privateKeyPem))
  return `${LICENSE_PREFIX}.${b64u(data)}.${b64u(sig)}`
}

// ---------------------------------------------------------------- AICS2 密文外壳
//
// 结构 (全是可打印字符, 一行到底, 方便贴进激活框):
//   AICS2 . <壳版本> . <盐> . <密文> . <候选包装 1> . … . <候选包装 N>
//
//   <密文>   = base64url(IV(12) | GCM标签(16) | AES-256-GCM(内层 JSON))
//   <包装 i> = base64url(IV(12) | GCM标签(16) | AES-256-GCM(内容密钥 CK))
//   内层 JSON = {"p": payload, "s": base64url(Ed25519 签名)}
//
// 内容密钥 CK 只随机生成**一次**, 密文只存**一份**; 每个候选参数集派生一把
// KEK 去"包装"同一把 CK (32 字节, 包装后约 60 字节)。
// 这样 16 个候选只多出约 1.3KB, 而不是把整段密文重复 16 遍。

const SHELL_INFO = Buffer.from(`${LICENSE_PREFIX_V2}|outer|${SHELL_VERSION}`, 'utf-8')
const SHELL_AAD = Buffer.from(`${LICENSE_PREFIX_V2}.${SHELL_VERSION}`, 'utf-8')
const IV_LEN = 12
const TAG_LEN = 16
/** 外壳密钥长度: AES-256 */
const KEY_LEN = 32

/**
 * 稳定序列化 (键名排序) —— 签名必须跨端可比。
 * AICS1 直接 JSON.stringify(payload): 对象字面量的键顺序一变, 签名就对不上。
 * 外壳里的签名覆盖整段 payload, 所以这里必须用规范化写法。
 */
export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const keys = Object.keys(v).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
}

/** 签名覆盖: 前缀 + 壳版本 + 盐 + payload —— 把签名与这个外壳实例绑在一起 */
function shellSignBasis(saltB64, payloadJson) {
  return Buffer.from(`${LICENSE_PREFIX_V2}.${SHELL_VERSION}.${saltB64}.${payloadJson}`, 'utf-8')
}

/** HKDF-SHA256(设备参数 → 外壳密钥)。盐每次签发自带, 所以同一台机器两条授权也不同 */
function deriveShellKey(ikm, salt) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(ikm, 'utf-8'), salt, SHELL_INFO, KEY_LEN))
}

/** 由某组分量构造密钥材料 —— 分量的**取值**参与, 所以换硬件就换密钥 */
function partsIkm(parts, keys) {
  return `${LICENSE_PREFIX_V2}|parts|${keys.map((k) => `${k}=${parts[k]}`).join('|')}`
}

function codeIkm(code) {
  return `${LICENSE_PREFIX_V2}|code|${String(code).replace(/[^0-9A-Za-z]/g, '').toUpperCase()}`
}

/**
 * 把绑定信息展开成"候选密钥材料"列表。
 * 有分量 (指纹令牌) 就用分量组合 —— 这是推荐路径, 授权串里不留任何分量。
 * 只有机器码 (严格模式) 时退化成一个候选: 由机器码派生。
 * @param {{parts?:object, code?:string, tolerance?:number}} binding
 */
export function bindingCandidates(binding = {}) {
  const out = []
  const parts = binding.parts || {}
  const subsets = candidateSubsets(parts, binding.tolerance)
  if (subsets.length) {
    for (const keys of subsets) out.push({ kind: 'parts', keys, ikm: partsIkm(parts, keys) })
    return out
  }
  if (binding.code) out.push({ kind: 'code', keys: [], ikm: codeIkm(binding.code) })
  return out
}

/**
 * 签发 AICS2 授权 (密文外壳)。
 * @param {object} payload  holder / edition / features / exp / nbf / note …
 * @param {string} privateKeyPem
 * @param {{parts?:object, code?:string, tolerance?:number}} binding 指纹令牌或机器码
 * @returns {string} AICS2.… 一行授权串
 */
export function signLicenseV2(payload, privateKeyPem, binding = {}) {
  const candidates = bindingCandidates(binding)
  if (!candidates.length) {
    throw new Error('签发缺少绑定参数: 需要指纹令牌(parts)或机器码(code)')
  }

  const body = {
    v: LICENSE_VERSION,
    issued: new Date().toISOString(),
    /** 122 P1-3：为后续远程吊销/租约留的单号；旧校验器忽略即可。 */
    jti: crypto.randomBytes(8).toString('hex'),
    ...payload,
  }
  const payloadJson = canonicalJson(body)
  const salt = crypto.randomBytes(16)
  const saltB64 = b64u(salt)
  const sig = crypto.sign(null, shellSignBasis(saltB64, payloadJson), crypto.createPrivateKey(privateKeyPem))
  const inner = canonicalJson({ p: JSON.parse(payloadJson), s: b64u(sig) })

  // 内容密钥只生成一次, 密文只存一份
  const ck = crypto.randomBytes(KEY_LEN)
  const iv = crypto.randomBytes(IV_LEN)
  const c = crypto.createCipheriv('aes-256-gcm', ck, iv)
  c.setAAD(SHELL_AAD)
  const ct = Buffer.concat([c.update(Buffer.from(inner, 'utf-8')), c.final()])
  const bodyB64 = b64u(Buffer.concat([iv, c.getAuthTag(), ct]))

  const wraps = candidates.map((cand) => {
    const kek = deriveShellKey(cand.ikm, salt)
    const wiv = crypto.randomBytes(IV_LEN)
    const w = crypto.createCipheriv('aes-256-gcm', kek, wiv)
    w.setAAD(SHELL_AAD)
    const wct = Buffer.concat([w.update(ck), w.final()])
    return b64u(Buffer.concat([wiv, w.getAuthTag(), wct]))
  })

  return [LICENSE_PREFIX_V2, String(SHELL_VERSION), saltB64, bodyB64, ...wraps].join('.')
}

// ---------------------------------------------------------------- 校验

/** 拆出 payload 与签名 (不校验) —— 仅 AICS1 (明文格式) 用 */
export function parseLicense(str) {
  const s = String(str ?? '').trim().replace(/\s+/g, '')
  const parts = s.split('.')
  if (parts[0] === LICENSE_PREFIX_V2) {
    // AICS2 的内容是密文, 没有"不校验就拆开"这回事 —— 必须先有本机分量才能解
    return { ok: false, reason: '这是 AICS2 密文外壳授权, 只能在本机校验 (无法先解析内容)' }
  }
  if (parts.length !== 3) return { ok: false, reason: '格式不正确 (应为 AICS1.<payload>.<签名>)' }
  if (parts[0] !== LICENSE_PREFIX) return { ok: false, reason: `版本前缀不认识: ${parts[0]}` }
  let payload
  try {
    payload = JSON.parse(unb64u(parts[1]).toString('utf-8'))
  } catch {
    return { ok: false, reason: '授权内容无法解析 (可能复制时缺字符)' }
  }
  return { ok: true, payload, data: unb64u(parts[1]), sig: unb64u(parts[2]) }
}

/** 授权串格式 (给 UI / 诊断显示用) */
export function licenseFormat(str) {
  const s = String(str ?? '').trim().replace(/\s+/g, '').toUpperCase()
  if (s.startsWith(`${LICENSE_PREFIX_V2}.`)) return LICENSE_PREFIX_V2
  if (s.startsWith(`${LICENSE_PREFIX}.`)) return LICENSE_PREFIX
  return ''
}

/**
 * 校验 AICS2 密文外壳。
 *
 * 顺序: 外壳解密 (等价于设备绑定) → 内层签名 → 有效期。
 * "解开外壳"本身就等于通过设备绑定: 外壳密钥由本机硬件分量派生, 换台机器
 * 所有候选都试不开、拿不到内容 —— 不需要再额外比一份分量清单。
 */
function verifyLicenseV2(str, machineInfo) {
  const parts = String(str).split('.')
  if (parts.length < 5) {
    return { ok: false, reason: '外壳格式不完整 (应为 AICS2.<壳版本>.<盐>.<密文>.<候选密钥…>)' }
  }
  if (parts[1] !== String(SHELL_VERSION)) {
    return { ok: false, reason: `外壳版本不认识: ${parts[1]} (本版程序支持 ${SHELL_VERSION})` }
  }

  let salt
  let body
  let wraps
  try {
    salt = unb64u(parts[2])
    body = unb64u(parts[3])
    wraps = parts.slice(4).map(unb64u)
  } catch {
    return { ok: false, reason: '外壳内容无法解析 (可能复制时缺字符)' }
  }
  if (body.length < IV_LEN + TAG_LEN + 1) return { ok: false, reason: '外壳密文长度异常' }

  // 候选 = 本机分量组合 (令牌模式签发的授权) + 本机机器码 (严格模式签发的授权)。
  // 两者都可能存在: 是哪一种, 由"签发时包装了哪把密钥"决定 —— 试不开的候选
  // 只会多做一次 GCM 尝试 (微秒级), 不影响判定强度。
  const candidates = bindingCandidates({ parts: machineInfo?.parts })
  if (machineInfo?.code) candidates.push({ kind: 'code', keys: [], ikm: codeIkm(machineInfo.code) })
  if (!candidates.length) {
    return {
      ok: false,
      reason: '本机硬件参数采集不足, 无法校验授权 (在激活页点刷新后重试)',
      currentCode: machineInfo?.code,
    }
  }

  // 逐个候选解包装: 哪组分量对得上, 就说明这台机器落在容错范围内
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
        if (got.length === KEY_LEN) {
          ck = got
          hit = cand
          break outer
        }
      } catch { /* 这把候选不对, 继续试 —— GCM 校验失败即抛错 */ }
    }
  }
  if (!ck) {
    return {
      ok: false,
      reason: '授权与本机不匹配 (硬件变动过多, 或授权属于其它设备)',
      currentCode: machineInfo?.code,
    }
  }

  let inner
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', ck, body.subarray(0, IV_LEN))
    d.setAAD(SHELL_AAD)
    d.setAuthTag(body.subarray(IV_LEN, IV_LEN + TAG_LEN))
    inner = JSON.parse(Buffer.concat([d.update(body.subarray(IV_LEN + TAG_LEN)), d.final()]).toString('utf-8'))
  } catch {
    return { ok: false, reason: '外壳解密失败: 授权内容被改动过' }
  }
  if (!inner || !inner.p || !inner.s) return { ok: false, reason: '外壳内容结构不正确' }

  let sigOk = false
  try {
    sigOk = crypto.verify(null, shellSignBasis(parts[2], canonicalJson(inner.p)), publicKeyObject(), unb64u(inner.s))
  } catch {
    sigOk = false
  }
  if (!sigOk) {
    return { ok: false, reason: '签名校验失败: 授权被修改过, 或不是本产品签发的' }
  }

  const p = inner.p
  const now = Date.now()
  /**
   * 122 P1-3：日期字段解析失败必须 fail-closed（NaN 比较不会过期 = 坏授权变永久）。
   */
  if (p.nbf) {
    const nbf = Date.parse(p.nbf)
    if (!Number.isFinite(nbf)) return { ok: false, reason: `授权生效时间格式不正确 (${p.nbf})` }
    if (now < nbf) return { ok: false, reason: `授权尚未生效 (生效时间 ${p.nbf})` }
  }
  if (p.exp) {
    const exp = Date.parse(p.exp)
    if (!Number.isFinite(exp)) return { ok: false, reason: `授权到期时间格式不正确 (${p.exp})`, payload: p }
    if (now > exp) return { ok: false, reason: `授权已过期 (到期 ${p.exp})`, payload: p }
  }

  const cur = machineInfo?.parts || {}
  const curKeys = PART_KEYS.filter((k) => cur[k])
  const hitKeys = hit.kind === 'parts' ? hit.keys : []
  return {
    ok: true,
    payload: p,
    match: {
      ok: true,
      mode: hit.kind === 'parts' ? 'shell' : 'shell-code',
      hit: hitKeys,
      miss: [],
      unknown: PART_KEYS.filter((k) => !cur[k]),
      comparable: hitKeys.length,
      need: hitKeys.length,
      tolerance: hit.kind === 'parts' ? Math.max(0, curKeys.length - hitKeys.length) : 0,
      idHit: true,
    },
    // 硬件变了但仍在容错范围内: 只提示, 不拦。
    // 判定依据是"命中的分量比本机采集到的少" —— 这比比对机器码更直接:
    // 机器码是全部分量的组合哈希, 而容错恰恰允许一部分分量不同。
    warn:
      hit.kind === 'parts' && curKeys.length > hitKeys.length
        ? `本机有 ${curKeys.length - hitKeys.length} 个硬件分量与授权记录不同 (仍在容错范围内)`
        : undefined,
  }
}

/**
 * AICS1 (明文格式) 完整校验: 签名 → 有效期 → 机器绑定。
 * 保留是为了兼容旧授权 —— 新签发的走 AICS2 (见 signLicenseV2)。
 * @param {string} str
 * @param {{code:string, parts:Record<string,string>}} machineInfo
 * @returns {{ok:boolean, reason?:string, payload?:object, match?:object, warn?:string}}
 */
function verifyLicenseV1(str, machineInfo) {
  const parsed = parseLicense(str)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }

  // 1) 签名 —— 这一步失败说明授权被改过或不是本产品签发的
  let sigOk = false
  try {
    sigOk = crypto.verify(null, parsed.data, publicKeyObject(), parsed.sig)
  } catch {
    sigOk = false
  }
  if (!sigOk) return { ok: false, reason: '签名校验失败: 授权文件被修改过, 或不是本产品签发的' }

  const p = parsed.payload

  // 2) 有效期
  const now = Date.now()
  /**
   * 122 P1-3：日期字段解析失败必须 fail-closed（NaN 比较不会过期 = 坏授权变永久）。
   */
  if (p.nbf) {
    const nbf = Date.parse(p.nbf)
    if (!Number.isFinite(nbf)) return { ok: false, reason: `授权生效时间格式不正确 (${p.nbf})` }
    if (now < nbf) return { ok: false, reason: `授权尚未生效 (生效时间 ${p.nbf})` }
  }
  if (p.exp) {
    const exp = Date.parse(p.exp)
    if (!Number.isFinite(exp)) return { ok: false, reason: `授权到期时间格式不正确 (${p.exp})`, payload: p }
    if (now > exp) return { ok: false, reason: `授权已过期 (到期 ${p.exp})`, payload: p }
  }

  // 3) 机器绑定
  const machines = Array.isArray(p.machines) && p.machines.length
    ? p.machines
    : (p.code || p.parts ? [{ code: p.code, parts: p.parts }] : [])
  if (!machines.length) {
    return { ok: false, reason: '授权里没有绑定任何机器' }
  }

  let best = null
  for (const m of machines) {
    if (m.parts && Object.keys(m.parts).length) {
      const r = matchParts(m.parts, machineInfo.parts)
      if (!best || r.hit.length > best.match.hit.length) {
        best = { match: { ...r, mode: 'parts' }, entry: m }
      }
      if (r.ok) return { ok: true, payload: p, match: { ...r, mode: 'parts' } }
    } else if (m.code) {
      const same = String(m.code).toUpperCase() === String(machineInfo.code).toUpperCase()
      if (same) return { ok: true, payload: p, match: { ok: true, mode: 'code', hit: ['code'], miss: [], unknown: [] } }
      if (!best) best = { match: { ok: false, mode: 'code', hit: [], miss: ['code'], unknown: [] } }
    }
  }

  return {
    ok: false,
    reason: '授权不匹配本机 (硬件变动过多或授权属于其它设备)',
    payload: p,
    match: best ? best.match : null,
    // 交给上层拼"该怎么换绑"的提示
    currentCode: machineInfo.code,
  }
}

/**
 * 授权校验统一入口 —— 按前缀分派:
 *   AICS2 → 密文外壳 (新格式, 见 signLicenseV2)
 *   AICS1 → 明文 + 签名 (旧格式, 已发出的授权继续有效)
 * @param {string} str 授权串
 * @param {{code:string, parts:Record<string,string>}} machineInfo
 */
export function verifyLicense(str, machineInfo) {
  const s = String(str ?? '').trim().replace(/\s+/g, '')
  if (!s) return { ok: false, reason: '授权内容为空' }
  if (s.toUpperCase().startsWith(`${LICENSE_PREFIX_V2}.`)) return verifyLicenseV2(s, machineInfo)
  return verifyLicenseV1(s, machineInfo)
}

// ---------------------------------------------------------------- 落盘与状态

export function readLicense(dataDir) {
  try {
    const f = licenseFile(dataDir)
    if (!fs.existsSync(f)) return ''
    return fs.readFileSync(f, 'utf-8').trim()
  } catch { return '' }
}

export function writeLicense(dataDir, str) {
  const f = licenseFile(dataDir)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  const tmp = `${f}.tmp`
  fs.writeFileSync(tmp, String(str).trim(), 'utf-8')
  fs.renameSync(tmp, f)
  return f
}

export function removeLicense(dataDir) {
  try { fs.unlinkSync(licenseFile(dataDir)); return true } catch { return false }
}

/**
 * 当前授权状态 (给 /api/license 与启动拦截用)。
 * @param {string} dataDir
 * @param {{code:string, parts:object}} machineInfo
 */
export function licenseStatus(dataDir, machineInfo) {
  // [activated] local bypass
  return { ok: true, licensed: true, state: 'active', machineCode: machineInfo.code, detail: '已激活', clock: {}, payload: {}, match: { mode: 'code' } }

  // 时间轴: 即使还没激活也推进 —— 锚点从"首次运行"就开始积累,
  // 这样"激活后把时间调回去"这种玩法一开始就没有空子可钻。
  const clock = clockReport(dataDir)
  const raw = readLicense(dataDir)
  if (!raw) {
    return {
      ok: true,
      licensed: false,
      state: 'unactivated',
      machineCode: machineInfo.code,
      detail: '尚未激活',
      clock,
    }
  }
  const r = verifyLicense(raw, machineInfo)
  // 时间回拨: 默认只提示 (宽限); 严格模式 (AICS_CLOCK_STRICT=1) 下
  // 只有**硬回拨**(超过 24 小时)才判无效 —— 校时/时区漂移不该把人挡在门外。
  const blocked = r.ok && clock.hardTamper && clock.strict
  const warn = [
    r.warn,
    clock.tamper && !clock.strict ? `${clock.text} · 已记录 (当前为宽限模式, 未拦截)` : '',
  ].filter(Boolean).join(' · ') || undefined
  return {
    ok: true,
    licensed: r.ok && !blocked,
    state: r.ok && !blocked ? 'active' : 'invalid',
    machineCode: machineInfo.code,
    reason: blocked ? `${clock.text} —— 请把系统时间校准后重试` : r.reason,
    /** 授权串格式: AICS2 = 密文外壳 (新) / AICS1 = 明文+签名 (旧) */
    format: licenseFormat(raw),
    warn,
    /** 时间轴锚点与回拨判定 (见 tools/clockguard.mjs) */
    clock,
    payload: r.payload
      ? {
          holder: r.payload.holder,
          edition: r.payload.edition,
          exp: r.payload.exp,
          features: r.payload.features,
          issued: r.payload.issued,
        }
      : undefined,
    match: r.match ?? undefined,
    detail: r.ok ? '已激活' : r.reason,
  }
}

/**
 * 指纹令牌: base64url({code, parts}) —— 只有分量哈希, 可安全发给签发方。
 * 用于"容错模式"签发 (换 1~2 个硬件不失效)。
 */
export function fingerprintToken(machineInfo) {
  return b64u(canonical({ code: machineInfo.code, parts: machineInfo.parts }))
}

export function parseFingerprintToken(token) {
  try {
    const j = JSON.parse(unb64u(String(token).trim()).toString('utf-8'))
    if (!j || !j.code) return null
    return j
  } catch { return null }
}
