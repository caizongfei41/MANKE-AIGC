// ============================================================
// 机器码 (Machine Code) — 离线设备指纹
//
// 目标: 在没有云端服务的前提下, 给一台 Windows 机器算出一个**稳定**的短标识,
//       用于把授权文件绑定到具体设备。
//
// 取哪几个源, 以及各自的"稳定性"权衡:
//   os    HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid
//         随 Windows 安装生成, 装系统/重置会变; 重装驱动/换硬件不变。稳定 ★★★★
//   board Win32_ComputerSystemProduct.UUID (主板 SMBIOS UUID)
//         换主板才变。稳定 ★★★★★   (部分廉价主板填 0000... 需容错)
//   bios  Win32_BIOS.SerialNumber
//         部分厂家为默认串/空, 需容错。稳定 ★★★
//   cpu   Win32_Processor.ProcessorId
//         换 CPU 才变; 少数虚拟化环境为空。稳定 ★★★★
//   disk  C: 的卷序列号 (Win32_LogicalDisk.VolumeSerialNumber)
//         重装系统(格式化 C:)会变, 插拔硬盘不影响。稳定 ★★★
//
// 结论: 单个源都不可靠, 所以 **五个源分别哈希后各自保留**, 机器码 = 五者组合哈希。
//       授权文件里同时存这五个分量的哈希, 校验时按"命中几个"判定 ——
//       换一个硬件 (例如换硬盘) 仍可判为同一台机器, 换整机则必然不匹配。
//       这比"只比一个总哈希"友好得多, 内测阶段能省掉大量售后换绑。
//
// 隐私: 原始值 (MachineGuid / 主板 UUID 等) **不落盘也不外发**,
//       只保存 SHA-256 前 16 hex 的分量哈希 —— 不可逆, 泄不出去。
// ============================================================

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { licenseSecrets } from './license-secrets.mjs'

/** 参与指纹的分量, 顺序固定 (顺序会进哈希, 不能随便改) */
export const PART_KEYS = ['os', 'board', 'bios', 'cpu', 'disk']

export const PART_LABELS = {
  os: '操作系统',
  board: '主板',
  bios: 'BIOS',
  cpu: '处理器',
  disk: '系统盘',
}

/**
 * 判定"同一台机器"所需的最少命中分量数。
 *
 * 允许的变动量 = 2 个分量 (例如换硬盘 + 重装系统), 因为:
 *   - 要求全中太脆: 用户换个硬盘就得找你换绑, 内测阶段沟通成本比防住的风险还高;
 *   - 放到 2 个也不会误放: 换一台机器时 os(系统GUID)/board(主板UUID)/cpu/disk **同时**变,
 *     命中数必然为 0, 不可能蒙混过关 —— 这几个分量互相独立, 不存在巧合相同的可能。
 * 采集到的分量越少就越严 (最少要求命中 2 个)。
 */
export function requiredHits(comparableCount) {
  if (comparableCount <= 2) return comparableCount
  return Math.max(2, comparableCount - 2)
}

/**
 * 比对授权里记录的分量与当前机器 —— 返回命中情况。
 * 判定规则: 命中数 >= requiredHits, 且 (命中里含 操作系统/主板 之一, 或命中数 >= 3)。
 */
export function matchParts(licensed = {}, current = {}) {
  const comparable = PART_KEYS.filter((k) => licensed[k] && current[k])
  const hit = comparable.filter((k) => licensed[k] === current[k])
  const miss = comparable.filter((k) => licensed[k] !== current[k])
  const unknown = PART_KEYS.filter((k) => !licensed[k] || !current[k])

  const need = requiredHits(comparable.length)
  const idHit = ['os', 'board'].some((k) => hit.includes(k))
  const ok = hit.length >= need && (idHit || hit.length >= 3)

  return { ok, hit, miss, unknown, comparable: comparable.length, need, idHit }
}

/** 允许变动的分量上限 (外壳密钥的多候选派生用, 与 requiredHits 的语义保持一致) */
export const MAX_TOLERANCE = 2

/**
 * 列出"可接受的参数集" —— AICS2 密文外壳的多候选密钥派生用。
 *
 * 为什么不用 matchParts 那套"命中几个"的判定:
 *   那种判定要求授权里**明文存着分量哈希**, 于是任何拿到授权串的人都能解出
 *   本机分量, 再伪造一份 machine.json 在别的机器上激活。改成"每个参数集派生
 *   一把密钥、逐把去试"之后, 授权串里不再需要出现任何分量, 容错却更强。
 *
 * 语义: 返回所有"大小 >= 分量数 - tolerance"的分量组合 (且至少 2 个分量)。
 *   5 个分量 / tolerance 2 → 全部分量(1) + 少一个(5) + 少两个(10) = 16 组。
 *   签发时对每一组各包装一份内容密钥; 校验时用本机当前分量逐组去试,
 *   于是"换 1~2 个硬件"仍然命中, 换了整机则一组都试不开。
 *
 * 顺序取自 PART_KEYS, 保证签发端与校验端枚举出完全相同的组合。
 * @param {Record<string,string>} parts 分量哈希表
 * @param {number} [tolerance] 允许变动的分量数 (0 = 严格, 默认 2)
 * @returns {string[][]} 每个元素是一组分量键名
 */
export function candidateSubsets(parts, tolerance = MAX_TOLERANCE) {
  const present = PART_KEYS.filter((k) => parts?.[k])
  const n = present.length
  if (n < 2) return []

  const raw = Number(tolerance)
  const tol = Number.isFinite(raw) ? Math.max(0, Math.min(MAX_TOLERANCE, Math.floor(raw))) : MAX_TOLERANCE
  const minSize = Math.max(2, n - tol)

  const out = []
  const seen = new Set()
  const acc = []
  const walk = (start) => {
    if (acc.length >= minSize) {
      const key = acc.join('|')
      if (!seen.has(key)) {
        seen.add(key)
        out.push(acc.slice())
      }
    }
    if (acc.length >= n) return
    for (let i = start; i < n; i++) {
      acc.push(present[i])
      walk(i + 1)
      acc.pop()
    }
  }
  walk(0)
  // 大集合优先: 校验时先试"最完整"的组合, 命中结果更有解释力
  // (整机没变 → 命中全部分量; 只变了硬盘 → 命中除硬盘外的 4 个)
  out.sort((a, b) => b.length - a.length)
  return out
}

// ---------------------------------------------------------------- 采集

function regQuery(key, value) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', value], {
      encoding: 'utf-8', windowsHide: true, timeout: 5000,
    })
    const m = out.match(/REG_SZ\s+(.+)/)
    return m ? m[1].trim() : ''
  } catch { return '' }
}

/** PowerShell + CIM 取硬件信息; 一次会话里把需要的都取回来, 避免五次慢启动 */
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
  } catch {
    return {}
  }
}

/** 过滤掉厂家没填的占位值 (全 0 / 全 F / 常见默认串), 否则会对所有同型号机器算出一个码 */
function useful(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  if (/^0+$/.test(s)) return ''
  if (/^F+$/i.test(s)) return ''
  if (/^(to be filled|default string|none|n\/a|system serial number|\.+)$/i.test(s)) return ''
  if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(s)) return ''
  return s
}

/** 采集原始分量 (不外发, 用完即弃) */
export function collectRawParts() {
  const hw = process.platform === 'win32' ? psQueryAll() : {}
  return {
    // 读不到 MachineGuid 就**留空**, 不能退化成 计算机名+用户名:
    // 那玩意儿同名机器会撞码, 等于把"绑定到这台机器"悄悄降级成"绑定到这个名字"。
    os: useful(regQuery('HKLM\\SOFTWARE\\Microsoft\\Cryptography', 'MachineGuid')),
    board: useful(hw.board),
    bios: useful(hw.bios),
    cpu: useful(hw.cpu),
    disk: useful(hw.disk),
  }
}

/** 同步睡一会儿 (采集重试之间用; 不能用 await, 因为 gate 侧是同步流程) */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* 不支持就跳过 */ }
}

/**
 * 采集分量 —— **分量太少就重试**。
 *
 * 为什么必须重试 (2026-10-02 用户报「有一个人的电脑授权就是不行」后实测确认的坑):
 *   冷启动那一下 PowerShell/CIM 可能还没热、或被安全软件卡住 → `psQueryAll()` 返回空,
 *   于是这台机器只拿得到 os 一个分量。而**分量参与机器码的哈希**, 少两个分量就是**另一个码**:
 *     完整采集 → 4QDP-0F17-SX7A-P3AG      只拿到 os → 6P4M-E89A-VJNP-1MQM (实测)
 *   结果是"同一台机器两次算出来的机器码不一样" —— 管理员按某一刻看到的码签发,
 *   客户端在另一刻校验, 必然对不上; 这就是"签了码还是不认/只能用老格式顶一下"的根因。
 *   所以: 分量少于 3 个时最多再试 3 轮(每轮间隔 350ms), 把"冷启动抖动"挡在门外。
 */
export function collectRawPartsStable(tries = 3) {
  let raw = collectRawParts()
  for (let i = 1; i < tries && PART_KEYS.filter((k) => raw[k]).length < 3; i++) {
    sleepSync(350)
    raw = collectRawParts()
  }
  return raw
}

const sha16 = (s) => crypto.createHash('sha256').update(String(s), 'utf-8').digest('hex').slice(0, 16)

// ---------------------------------------------------------------- 编码

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'   // 去掉易混的 I L O U

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

/** 16 位字符 → XXXX-XXXX-XXXX-XXXX */
export function formatCode(code) {
  const c = String(code).replace(/[^0-9A-Z]/gi, '').toUpperCase().slice(0, 16)
  return c.replace(/(.{4})(?=.)/g, '$1-')
}

// ---------------------------------------------------------------- 缓存守卫
//
// data/ 是"拷走即搬迁"的便携目录, 但 machine.json 记的是**这台机器**的指纹。
// 用户把整个程序文件夹复制到另一台电脑时, 缓存会跟着过去 —— 若不校验,
// 新机器就会读到老机器的指纹, 与随包带过去的 license.key 完美匹配:
// 于是"复制文件夹"就等于"在新机器上白嫖已激活状态"。这是必须堵死的洞。
//
// 做法: 缓存里存一个 guard, 由**实时采集的本机 MachineGuid** 参与 HMAC 得出。
// 读缓存时重算比对, 对不上说明这份缓存不属于本机 (跨机复制 / 系统重装),
// 直接丢弃、按真实硬件重新采集 —— 于是拿不到能匹配授权的指纹, 门禁生效。
// MachineGuid 取自注册表, 只需一次 reg query (约 30~80ms), 比全量采集快两个数量级。
// HMAC 密钥内嵌, 使"手工编造一份 machine.json"也需先逆向出密钥, 抬高伪造门槛。
//
// v2 (2026-09): guard 的覆盖面从"机器码 + 种子"扩到**全部五个分量**。
// 之前只签机器码, 分量本身不在 HMAC 里 —— 于是知道密钥的人可以攒一份
// "机器码对得上、分量随便填"的缓存。AICS2 外壳密钥是由分量派生的, 分量被伪造
// 就等于绑定的意义被掏空, 所以这里必须一起签进去。
// 副作用: 老缓存读不过 → 重新采集一次 (约 1~3s), 机器码本身不变, 授权不受影响。
const CACHE_GUARD_SECRETS = licenseSecrets().legacyCacheGuard
const CACHE_GUARD_SECRET = licenseSecrets().cacheGuard

/** 实时取本机 MachineGuid (读不到返回空串) */
function liveSeed() {
  return regQuery('HKLM\\SOFTWARE\\Microsoft\\Cryptography', 'MachineGuid')
}

function cacheGuardWith(code, seed, parts, secret) {
  // 分量必须一起进 HMAC: 只签机器码的话, 分量可以被随意编造,
  // 而 AICS2 外壳密钥正是由分量派生的 (见 candidateSubsets 的说明)。
  const basis = PART_KEYS.map((k) => parts?.[k] ?? '').join(',')
  return crypto
    .createHmac('sha256', secret)
    .update(`${code}|${seed}|${basis}`, 'utf-8')
    .digest('hex')
    .slice(0, 32)
}

function cacheGuard(code, seed, parts) {
  return cacheGuardWith(code, seed, parts, CACHE_GUARD_SECRET)
}

/** 由分量哈希算出机器码 */
export function codeFromParts(parts) {
  const basis = PART_KEYS.map((k) => parts[k] || '-').join('|')
  const digest = crypto.createHash('sha256').update(basis, 'utf-8').digest()
  return formatCode(crockford(digest, 16))
}

// ---------------------------------------------------------------- 对外

/** 缓存文件: 避免每次启动都拉一次 PowerShell (首次约 1~3s) */
function cacheFile(dataDir) {
  return path.join(dataDir, 'machine.json')
}

/**
 * 取得本机指纹。
 * @param {object} [opts]
 * @param {string} [opts.dataDir] 缓存目录 (通常 <dataDir>)
 * @param {boolean} [opts.refresh] 忽略缓存, 重新采集
 */
export function getMachineInfo(opts = {}) {
  const { dataDir, refresh = false } = opts
  const file = dataDir ? cacheFile(dataDir) : ''

  if (!refresh && file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (j && j.code && j.parts) {
        const seed = liveSeed()
        // 种子取不到 (极少数环境注册表读不了) 时退回结构校验, 否则会每次全量采集
        const ok = seed
          ? CACHE_GUARD_SECRETS.some((s) => j.guard === cacheGuardWith(j.code, seed, j.parts, s))
          : false
        /** 缓存里的 code 必须与 parts 自洽 —— 否则这份缓存是"别的算法/别的机器"留下的, 不能认 */
        if (ok && j.code === codeFromParts(j.parts)) return { ...j, cached: true }
      }
      // guard 对不上 = 缓存不属于本机 (跨机复制 / 系统重装) → 落到下面重新采集。
      // 注意必须"整体丢弃"而不是"只替换 os 分量": 老机器的 board/cpu/disk 若留着、
      // 只换成新机器的 os, 反而会凑出"命中 4/5"的假匹配, 比不做校验更糟。
    } catch { /* 无缓存 / 缓存损坏 */ }
  }

  const raw = collectRawPartsStable()
  const parts = {}
  for (const k of PART_KEYS) parts[k] = raw[k] ? sha16(raw[k]) : ''

  const present = PART_KEYS.filter((k) => parts[k])
  const info = {
    code: codeFromParts(parts),
    parts,
    /** 哪些分量采集到了 (空的那几个不参与"命中数"分母, 但会照实记录) */
    present,
    /** 分量没齐 (本机只采到 1~4 个) —— 页面/日志要据此提醒"别急着按这个码签发" */
    partial: present.length < PART_KEYS.length,
    /**
     * **弱指纹**: 只采到 1~2 个分量(通常是 PowerShell/CIM 被安全软件拦了, 或系统盘不在 C:)。
     *   为什么单独标一个: 很多主板 BIOS 序列号是 "Default string" 之类被过滤掉 → 4/5 是**正常**的,
     *   那种机器不能弹"请重新采集"吓人; 真正该拦的是 ≤2 个分量 —— 这时机器码只靠 os 撑着,
     *   一旦某个分量时有时无, 码就会漂(见 P14)。
     */
    weak: present.length < 3,
    collectedAt: new Date().toISOString(),
    platform: process.platform,
    /** 这份指纹是**冻结**下来的: 以后每次启动都读它, 机器码不再随采集结果漂移 */
    frozen: true,
    cached: false,
  }

  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const seed = liveSeed()
      // 带上"本机守卫" —— 这份缓存被复制到别的电脑后会立刻失效
      const out = seed ? { ...info, guard: cacheGuard(info.code, seed, info.parts) } : info
      /**
       * ★ 冻结指纹 (2026-10-02 修): 写完这份 machine.json 之后, 这台机器的机器码就**定死**了。
       *
       *   为什么非冻不可: 机器码 = 五个分量哈希的哈希, 少一个分量就是另一个码。
       *   以前只有服务端写这份缓存, 而且是在"打开激活页"那一刻才写 —— 于是同一台机器在
       *   门禁首次启动(自己采集)与激活页(再采集一次)之间可能给出**两个不同的码**;
       *   管理员按其中一个签发的授权, 另一个环节就永远验不过(客户端只会说"授权与本机不匹配")。
       *   现在: 谁先采集, 谁就把结果冻下来 —— 门禁与页面从此读同一份, 码不再漂移。
       */
      fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf-8')
    } catch { /* 写不动不影响本次使用 */ }
  }
  return info
}
