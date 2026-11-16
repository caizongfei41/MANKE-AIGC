// ============================================================
// 批量下载的落盘内核（主进程调用）
//
// 用户口径（2026-10-26）：批量下载只选一次文件夹，不能为每个文件挨个弹系统保存框。
// 这里按文件顺序流式写入，自动补扩展名、处理重名，单个失败不中断整批。
// 与 Electron / dialog 解耦，便于用本地 HTTP 服务做真实落盘自测。
// ============================================================
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg',
}
const SAFE_EXT = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'mp4', 'webm', 'mov', 'mkv',
  'wav', 'mp3', 'm4a', 'ogg', 'flac', 'aac', 'txt', 'json', 'bin',
])
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

function extensionFromUrl(src) {
  try {
    const u = new URL(src)
    for (const key of ['name', 'filename', 'file']) {
      const value = u.searchParams.get(key)
      if (!value) continue
      const ext = path.extname(value).slice(1).toLowerCase()
      if (SAFE_EXT.has(ext)) return ext
    }
    const ext = path.extname(u.pathname).slice(1).toLowerCase()
    return SAFE_EXT.has(ext) ? ext : ''
  } catch { return '' }
}

function cleanBaseName(value) {
  let base = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+([.])/g, '$1')
    .replace(/[. ]+$/g, '')
  if (!base) base = 'canvas-media'
  if (WINDOWS_RESERVED.test(base)) base = `_${base}`
  return base.slice(0, 120).trim() || 'canvas-media'
}

function fileNameFor(item, src, mime) {
  const raw = String(item?.name || 'canvas-media').trim() || 'canvas-media'
  const rawExt = path.extname(raw).slice(1).toLowerCase()
  let base = cleanBaseName(rawExt && SAFE_EXT.has(rawExt) ? raw.slice(0, -(rawExt.length + 1)) : raw)
  const ext = (SAFE_EXT.has(rawExt) && rawExt)
    || MIME_EXT[String(mime || '').split(';')[0].trim().toLowerCase()]
    || extensionFromUrl(src)
    || 'bin'
  return `${base}.${ext === 'jpeg' ? 'jpg' : ext}`
}

function uniqueTarget(dir, wanted) {
  const ext = path.extname(wanted)
  const stem = wanted.slice(0, ext ? -ext.length : undefined)
  let candidate = wanted
  for (let i = 2; i < 10000; i += 1) {
    if (!fs.existsSync(path.join(dir, candidate))) return path.join(dir, candidate)
    candidate = `${stem} (${i})${ext}`
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`)
}

async function writeResponse(target, result) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.part`)
  try {
    if (result.body && typeof Readable.fromWeb === 'function') {
      await pipeline(Readable.fromWeb(result.body), fs.createWriteStream(tmp))
    } else {
      fs.writeFileSync(tmp, Buffer.from(await result.arrayBuffer()))
    }
    const st = fs.statSync(tmp)
    if (!st.isFile() || st.size <= 0) throw new Error('下载到的文件是空的')
    fs.renameSync(tmp, target)
    return st.size
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    throw e
  }
}

function decodeDataUrl(src) {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(src)
  if (!m) throw new Error('这条内容是无效的数据地址')
  const mime = m[1] || 'application/octet-stream'
  const body = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]))
  return { mime, body }
}

/**
 * @param {string} dir 目标文件夹（已由主进程原生选择框确定）
 * @param {Array<{src:string,name?:string}>} items
 * @param {{fetchImpl?:Function, timeoutMs?:number, maxItems?:number}} [options]
 */
async function saveBatchToDir(dir, items, options = {}) {
  const targetDir = path.resolve(String(dir || ''))
  if (!dir || !fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    return { ok: false, dir: targetDir, msg: '目标文件夹不存在或不可写' }
  }
  const list = Array.isArray(items) ? items.filter((it) => it && typeof it.src === 'string' && it.src) : []
  const maxItems = Number(options.maxItems) > 0 ? Number(options.maxItems) : 2000
  if (!list.length) return { ok: false, dir: targetDir, msg: '没有可下载的产物' }
  if (list.length > maxItems) return { ok: false, dir: targetDir, msg: `一次最多下载 ${maxItems} 个文件` }
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 10 * 60_000
  const files = []
  const errors = []

  for (const item of list) {
    const src = String(item.src)
    let target = ''
    try {
      if (/^data:/i.test(src)) {
        const got = decodeDataUrl(src)
        const wanted = fileNameFor(item, src, got.mime)
        target = uniqueTarget(targetDir, wanted)
        fs.writeFileSync(target, got.body)
        if (!got.body.length) throw new Error('下载到的文件是空的')
        files.push({ ok: true, name: path.basename(target), bytes: got.body.length })
        continue
      }
      const u = new URL(src)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`不支持的地址协议：${u.protocol}`)
      const res = await fetchImpl(src, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const mime = String(res.headers.get('content-type') || '')
      const wanted = fileNameFor(item, src, mime)
      target = uniqueTarget(targetDir, wanted)
      const bytes = await writeResponse(target, res)
      files.push({ ok: true, name: path.basename(target), bytes })
    } catch (e) {
      if (target) {
        try { fs.rmSync(target, { force: true }) } catch { /* ignore */ }
      }
      const msg = e instanceof Error ? e.message : String(e)
      errors.push({ name: cleanBaseName(item?.name || 'canvas-media'), msg })
      files.push({ ok: false, name: cleanBaseName(item?.name || 'canvas-media'), msg })
    }
  }

  return {
    ok: errors.length === 0,
    partial: files.some((x) => x.ok) && errors.length > 0,
    dir: targetDir,
    total: list.length,
    saved: files.filter((x) => x.ok).length,
    failed: errors.length,
    files,
    errors,
  }
}

module.exports = { saveBatchToDir, fileNameFor, cleanBaseName, uniqueTarget }

