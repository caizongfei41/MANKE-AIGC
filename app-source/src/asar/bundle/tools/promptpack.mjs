// ============================================================
// 提示词包 (Prompt Pack) —— 把内置提示词从"静态前端资源"里挪出来
//
// 为什么要这么做:
//   内置提示词(角色单/三视图、场景风格正负向、剧本体裁/题材/写法)是产品里
//   最容易被直接抄走的东西 —— 而它们原来就躺在 dist 的 JS 里, F12 一搜就有。
//   现在改成: 源码照旧写在 app/src/data/presets.ts (人看着改最方便),
//   构建时由 vite 插件把**这些字符串抽出来 + 从产物里抹掉**,
//   stage 再把抽出来的内容加密成 bundle/prompts.pack,
//   运行时由本地服务解密并经 /api/prompts 下发给界面回填。
//
// 诚实说明边界 (别把它当加密):
//   密钥在程序里, 有逆向能力的人仍能从内存/协议里拿到明文 ——
//   这一步拦的是"打开 F12 搜提示词"和"解压 dist 抄文案",
//   把抄走的成本从 10 分钟抬到需要动逆向。真要完全保护只能服务端化。
//   另一层价值: 未激活时 /api/prompts 直接 403 —— 内置提示词成了授权功能的一部分。
// ============================================================

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 与 app/vite.config.ts 的抽取插件共用同一份格式; 换密钥等于旧包作废 (需重新打包) */
const KEY_SECRET = 'aics.promptpack.v1.4c8e1b73d29f6504'
const MAGIC = Buffer.from('AICSPP1')
const VERSION = 1
const IV_LEN = 12
const TAG_LEN = 16

function deriveKey(salt) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(KEY_SECRET, 'utf-8'), salt,
    Buffer.from(`AICSPP|${VERSION}`, 'utf-8'), 32))
}

/** 明文 JSON → 加密包 (随机盐 + AES-256-GCM) */
export function encryptPromptPack(json) {
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(IV_LEN)
  const key = deriveKey(salt)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(json), 'utf-8')), c.final()])
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv, c.getAuthTag(), ct])
}

/** 加密包 → 明文 JSON (失败返回 null, 调用方给降级提示) */
export function decryptPromptPack(buf) {
  try {
    const b = Buffer.from(buf)
    if (b.length < MAGIC.length + 1 + 16 + IV_LEN + TAG_LEN + 1) return null
    if (!b.subarray(0, MAGIC.length).equals(MAGIC)) return null
    if (b[MAGIC.length] !== VERSION) return null
    let o = MAGIC.length + 1
    const salt = b.subarray(o, o + 16); o += 16
    const iv = b.subarray(o, o + IV_LEN); o += IV_LEN
    const tag = b.subarray(o, o + TAG_LEN); o += TAG_LEN
    const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(salt), iv)
    d.setAuthTag(tag)
    const json = Buffer.concat([d.update(b.subarray(o)), d.final()]).toString('utf-8')
    return JSON.parse(json)
  } catch {
    return null
  }
}

/**
 * 读提示词包。
 * @param {{srcRoot:string, packaged:boolean, bundleDir?:string}} opts
 *   packaged → 读 <bundleDir|srcRoot/bundle>/prompts.pack (加密)
 *   开发态   → 读 app/.prompt-pack.json (vite 抽取插件写的明文, 便于边改边看)
 */
export function readPromptPack(opts) {
  const { srcRoot, packaged } = opts
  if (packaged) {
    // 打包态 srcRoot 就是 bundle/ (tools/ 在 bundle/tools 下), 但源码态跑打包分支时
    // 也可能传仓库根 —— 两个候选都试一遍, 免得路径约定变了就静默失效。
    const files = [path.join(srcRoot, 'prompts.pack'), path.join(srcRoot, 'bundle', 'prompts.pack')]
    const file = files.find((f) => fs.existsSync(f))
    if (!file) return { ok: false, reason: `提示词包缺失 (找过: ${files.join(' / ')})` }
    const j = decryptPromptPack(fs.readFileSync(file))
    return j ? { ok: true, pack: j, source: 'pack' } : { ok: false, reason: '提示词包解密失败 (被改动过或密钥不匹配)' }
  }
  const dev = path.join(srcRoot, 'app', '.prompt-pack.json')
  try {
    if (!fs.existsSync(dev)) {
      return { ok: false, reason: '开发态还没有抽取结果 (先打开一次前端页面即可生成 app/.prompt-pack.json)' }
    }
    return { ok: true, pack: JSON.parse(fs.readFileSync(dev, 'utf-8')), source: 'dev-json' }
  } catch (e) {
    return { ok: false, reason: `开发态提示词包读取失败: ${e.message}` }
  }
}
