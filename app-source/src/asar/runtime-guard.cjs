// ============================================================
// 主程序运行时防护 (CommonJS, 打进 app.asar)
//
// 与 Electron Fuses 的分工：
//   · Fuses 保证 app.asar 不可改，且不能把 exe 当 node 起；
//   · 这里保证 asarUnpack 的 bundle/** 也没被替换，并核对发布证书；
//   · 启动时拒绝调试器附加，运行中定时复查。
//
// 这是纵深防御，不是“不可逆加固”。正式发行仍必须用受信任的 Authenticode
// 证书签名；没有证书时，攻击者可以整体替换 exe/安装器，任何进程内自检都救不了。
// ============================================================
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync, execFile } = require('node:child_process')

const MANIFEST_FILE = 'bundle-integrity.json'
const POLICY_FILE = 'release-policy.json'

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const normThumb = (s) => String(s || '').replace(/[^0-9a-f]/gi, '').toUpperCase()
function winPsEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  const root = env.SystemRoot || env.windir || 'C:\\Windows'
  env.PSModulePath = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
  return env
}

function walk(root, rel = '') {
  const out = []
  const dir = path.join(root, rel)
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = rel ? path.join(rel, ent.name) : ent.name
    if (ent.isDirectory()) out.push(...walk(root, next))
    else if (ent.isFile()) out.push(next.replace(/\\/g, '/'))
  }
  return out
}

/** 和 tools/bundle-integrity.mjs 同一格式；运行时独立实现，避免依赖构建脚本。 */
function verifyBundle(bundleRoot, manifest) {
  const problems = []
  if (!manifest || manifest.version !== 1 || manifest.algorithm !== 'sha256'
    || !manifest.files || typeof manifest.files !== 'object') return ['完整性清单格式不正确']
  const expected = new Set(Object.keys(manifest.files))
  const actual = new Set(walk(bundleRoot))
  for (const rel of expected) {
    const abs = path.join(bundleRoot, ...rel.split('/'))
    if (!fs.existsSync(abs)) { problems.push(`缺少 ${rel}`); continue }
    if (sha256File(abs) !== manifest.files[rel]) problems.push(`被修改 ${rel}`)
  }
  for (const rel of actual) if (!expected.has(rel)) problems.push(`多出未知文件 ${rel}`)
  return problems
}

/**
 * 轻量检查，不依赖 PowerShell：关闭 Fuses 后仍要挡住常见的 --inspect / NODE_OPTIONS 旁路。
 * 返回空字符串 = 没发现；否则返回人话原因。
 */
function debuggerFlagReason(opt = {}) {
  const argv = [...(opt.execArgv ?? process.execArgv ?? []), ...(opt.argv ?? process.argv ?? [])].join(' ')
  const env = opt.env ?? process.env
  if (/--inspect(?:-brk|-port)?(?:=|\s|$)/i.test(argv)) return '检测到 --inspect 调试参数'
  // 注意：process.debugPort 在普通 Node 进程里也默认是 9229，不代表已监听调试器，
  // 不能用它做判据（实测会把正常启动全拦掉）。真正的端口监听由 --inspect 参数体现，
  // 运行中附加的调试器由下面的原生检测负责。
  if (/--inspect(?:-brk|-port)?(?:=|\s|$)/i.test(String(env.NODE_OPTIONS || ''))) return '检测到 NODE_OPTIONS 调试参数'
  return ''
}

/** 读取 Windows Authenticode 签名；拿不到签名信息时返回 status=Unknown，不伪造成功。 */
function authenticodeStatus(exePath) {
  if (process.platform !== 'win32') return { status: 'Unsupported', thumbprint: '', subject: '', message: '' }
  try {
    const ps = [
      'Import-Module Microsoft.PowerShell.Security',
      '$s = Get-AuthenticodeSignature -LiteralPath $env:AICS_VERIFY_FILE',
      '$o = [pscustomobject]@{',
      '  Status = [string]$s.Status',
      '  Message = [string]$s.StatusMessage',
      '  Thumbprint = if ($s.SignerCertificate) { [string]$s.SignerCertificate.Thumbprint } else { "" }',
      '  Subject = if ($s.SignerCertificate) { [string]$s.SignerCertificate.Subject } else { "" }',
      '}',
      '$o | ConvertTo-Json -Compress',
    ].join('\n')
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf-8', windowsHide: true, timeout: 12000,
      env: winPsEnv({ AICS_VERIFY_FILE: exePath }),
    })
    return JSON.parse(String(out).trim() || '{}')
  } catch (e) {
    return { status: 'Unknown', thumbprint: '', subject: '', message: String(e?.message || e) }
  }
}

/** 检查 exe 是否为发布策略指定证书签出的有效签名。 */
function verifyExecutableSignature(exePath, policy) {
  const want = normThumb(policy?.authenticode?.thumbprint)
  if (!want) return { ok: false, reason: '发布策略缺少 Authenticode 证书指纹' }
  const sig = authenticodeStatus(exePath)
  const got = normThumb(sig.thumbprint)
  if (sig.status !== 'Valid') {
    return { ok: false, reason: `exe 的 Authenticode 签名状态为 ${sig.status || 'Unknown'}` }
  }
  if (got !== want) {
    return { ok: false, reason: `exe 签名者 ${got || '(空)'} 与发布策略 ${want} 不一致` }
  }
  return { ok: true, status: sig.status, thumbprint: got, subject: sig.subject }
}

/**
 * 原生调试器检测（Windows）。脚本自身出错时返回 false，避免安全软件短暂阻塞把用户挡在门外；
 * 只有明确拿到“有调试器”才拒绝。
 */
function remoteDebuggerAttached(pid = process.pid, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false)
    const type = [
      'using System;',
      'using System.Runtime.InteropServices;',
      'public static class AicsDbg {',
      '  [DllImport("kernel32.dll")] public static extern bool IsDebuggerPresent();',
      '  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CheckRemoteDebuggerPresent(IntPtr h, out bool present);',
      '}',
    ].join(' ').replace(/'/g, "''")
    const ps = [
      '$ErrorActionPreference = "Stop"',
      `Add-Type -TypeDefinition '${type}'`,
      '$p = Get-Process -Id ([int]$env:AICS_GUARD_PID) -ErrorAction Stop',
      '$remote = $false',
      '[void][AicsDbg]::CheckRemoteDebuggerPresent($p.Handle, [ref]$remote)',
      'if ([AicsDbg]::IsDebuggerPresent() -or $remote) { "1" } else { "0" }',
    ].join('; ')
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true, timeout: timeoutMs,
      env: winPsEnv({ AICS_GUARD_PID: String(pid) }),
    }, (err, stdout) => {
      if (err) return resolve(false)
      resolve(String(stdout || '').trim() === '1')
    })
  })
}

/**
 * 启动门禁。只在正式发行布局运行：asar 存在且不是开发裸包。
 * @returns {{ok:boolean, reason?:string, skipped?:boolean, policy?:object}}
 */
function enforceStartup(opt = {}) {
  if (opt.devMode === true || opt.unpackedBuild === true) return { ok: true, skipped: true }
  const here = opt.appDir || __dirname
  const bundleRoot = opt.bundleRoot || path.join(process.resourcesPath, 'app.asar.unpacked', 'bundle')
  const policyPath = path.join(here, POLICY_FILE)
  let policy
  try { policy = JSON.parse(fs.readFileSync(policyPath, 'utf-8')) }
  catch (e) { return { ok: false, reason: `缺少发布安全策略: ${e.message}` } }

  const dbg = debuggerFlagReason(opt.debugger)
  if (dbg) return { ok: false, reason: dbg, policy }

  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(here, MANIFEST_FILE), 'utf-8'))
    const problems = verifyBundle(bundleRoot, manifest)
    if (problems.length) {
      return { ok: false, reason: `程序资源完整性校验失败: ${problems.slice(0, 3).join('；')}`, policy }
    }
  } catch (e) {
    return { ok: false, reason: `无法读取程序资源完整性清单: ${e.message}`, policy }
  }

  if (policy.authenticode?.required === true) {
    const sig = verifyExecutableSignature(opt.exePath || process.execPath, policy)
    if (!sig.ok) return { ok: false, reason: `Windows 代码签名校验失败: ${sig.reason}`, policy }
  }
  return { ok: true, policy }
}

/**
 * 122 P0-3：启动后只复核"热文件"，避免攻击者启动后再替换 server/license/dist。
 * 全量 1033 个文件启动时已查过；这里每 60s 只查最容易下手的约 20 个。
 */
const HOT_FILE_RE = /^(server\.mjs|tools\/(license|machine|runtime)\.mjs|dist\/index\.html|dist\/assets\/[^/]+\.js)$/

function hotFileProblems(bundleRoot, manifestPath) {
  if (!bundleRoot || !manifestPath) return []
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) } catch {
    return [`无法读取完整性清单: ${manifestPath}`]
  }
  if (!manifest?.files) return ['完整性清单缺少 files']
  const problems = []
  for (const rel of Object.keys(manifest.files)) {
    if (!HOT_FILE_RE.test(rel)) continue
    const abs = path.join(bundleRoot, ...rel.split('/'))
    try {
      if (!fs.existsSync(abs)) problems.push(`缺少 ${rel}`)
      else if (sha256File(abs) !== manifest.files[rel]) problems.push(`被修改 ${rel}`)
    } catch (e) {
      problems.push(`无法读取 ${rel}: ${e.message}`)
    }
  }
  return problems
}

function startDebuggerGuard({
  onDetected, everyMs = 30000, firstDelayMs = 5000, bundleRoot = '', manifestPath = '',
} = {}) {
  let stopped = false
  let timer = null
  const hit = (why) => {
    if (stopped) return
    stopped = true
    try { onDetected?.(why) } catch { /* ignore */ }
  }
  const run = async () => {
    if (stopped) return
    const dbg = await remoteDebuggerAttached(process.pid)
    if (dbg) {
      hit('检测到调试器附加')
      return
    }
    const problems = hotFileProblems(bundleRoot, manifestPath)
    if (problems.length) hit(`程序资源在运行期被修改: ${problems.slice(0, 3).join('；')}`)
  }
  const first = setTimeout(run, Math.max(0, firstDelayMs))
  timer = setInterval(run, Math.max(5000, everyMs))
  return () => {
    stopped = true
    clearTimeout(first)
    clearInterval(timer)
  }
}

module.exports = {
  MANIFEST_FILE,
  POLICY_FILE,
  debuggerFlagReason,
  authenticodeStatus,
  verifyExecutableSignature,
  remoteDebuggerAttached,
  enforceStartup,
  startDebuggerGuard,
  _internals: { walk, verifyBundle, normThumb, hotFileProblems },
}
