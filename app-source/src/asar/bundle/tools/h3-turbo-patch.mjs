#!/usr/bin/env node
// ============================================================
// H3 Turbo LoRA 节点补丁: 修「多参生视频 + 参考视频」直接崩的问题
//
// 症状 (2026-09-19 实测):
//   多参生视频里挂上任何**参考视频**, 后端就报
//     SamplerCustomAdvanced: The size of tensor a (3) must match the size of tensor b (2)
//   带不带参考视频的音轨都一样崩(所以与"音轨通道"无关)。
//
// 根因 (读两侧源码确认):
//   · 模型侧 comfy/ldm/minimax/model.py 的 PackedLayout 把**参考视频**也当成一行
//     `ref_img` 视觉条件 (kind == "video"/"video_audio" 分支里同样 append("ref_img")),
//     于是 DiT 需要的调制行数 M=3;
//   · 而 Turbo 节点的 _unique_t() 只认 `kind == "image"`
//     → 它只算出 M=2 → adaln 注入时 bv(3) 与 (av @ sv.T)(2) 对不上 → 崩。
//   (该 bug 上游 main 分支同样存在 —— 2026-09-19 核对过。)
//
// 修法: 把那一行的判定从 image 扩到 image/video/video_audio。
//   · 幂等: 已修过就直接跳过;
//   · 安全: 首次修改前留 `__init__.py.aics-orig`;
//   · 只改这一行, 匹配不到(用户换了别的版本)就原样跳过并提示。
//
// 用法:
//   node tools\h3-turbo-patch.mjs            # 打补丁(默认找程序目录里的 backends)
//   node tools\h3-turbo-patch.mjs --root D:\Manke\backends
//   node tools\h3-turbo-patch.mjs --check     # 只看状态, 不写
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')

const BUGGY = 'if payload.get("keyframes") or any(r.get("kind") == "image" for r in refs):'
const FIXED = 'if payload.get("keyframes") or any(r.get("kind") in ("image", "video", "video_audio") for r in refs):'
/** 已修过的两种写法(万一以后上游用别的写法修了, 也算"已修") */
const ALREADY = [
  FIXED,
  'for r in refs) if r.get("kind") != "audio"',
  'r.get("kind") in ("image", "video", "video_audio")',
]

const REL = ['h3', 'payload', 'backend', 'ComfyUI-H3', 'ComfyUI', 'custom_nodes', 'ComfyUI-MiniMax-H3-Turbo', '__init__.py']

export function turboNodeFile(backendsRoot) {
  return path.join(backendsRoot, ...REL)
}

/**
 * 打补丁(幂等)。返回 { status, file, detail }
 *   status: 'fixed' 刚修好 | 'already' 本来就是好的 | 'missing' 没装这一层 | 'nomatch' 版本对不上
 */
export function patchH3TurboNode(backendsRoot, { dryRun = false, log = () => {} } = {}) {
  const file = turboNodeFile(backendsRoot)
  if (!fs.existsSync(file)) return { status: 'missing', file, detail: '没找到 H3 节点(这一层可能没装)' }
  let src
  try { src = fs.readFileSync(file, 'utf-8') } catch (e) {
    return { status: 'nomatch', file, detail: `读不到: ${e.message}` }
  }
  if (ALREADY.some((s) => src.includes(s)) && !src.includes(BUGGY)) {
    return { status: 'already', file, detail: '已是修复版' }
  }
  if (!src.includes(BUGGY)) {
    return { status: 'nomatch', file, detail: '找不到待修的那一行(节点版本不同?) —— 未改动' }
  }
  const out = src.replace(BUGGY, FIXED)
  if (out === src) return { status: 'nomatch', file, detail: '替换无效 —— 未改动' }
  if (dryRun) return { status: 'fixed', file, detail: '(dry-run 未写入)' }
  // 首次修改留一份原文件(只留一次, 不被后续覆盖)
  const bak = `${file}.aics-orig`
  try {
    if (!fs.existsSync(bak)) fs.copyFileSync(file, bak)
  } catch (e) {
    log(`[h3-patch] 备份失败(继续修): ${e.message}`)
  }
  fs.writeFileSync(file, out, 'utf-8')
  return { status: 'fixed', file, detail: '已把视觉条件判定从 image 扩到 image/video/video_audio' }
}

// ---------------------------------------------------------------- CLI
const argv = process.argv.slice(2)
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  let root = path.join(REPO_ROOT, 'backends')
  let check = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = path.resolve(String(argv[++i] ?? ''))
    else if (argv[i] === '--check') check = true
  }
  const r = patchH3TurboNode(root, { dryRun: check, log: console.log })
  const icon = check
    ? { fixed: '→ 待修', already: '✔ 无需修', missing: '· 未安装', nomatch: '! 跳过' }[r.status]
    : { fixed: '✔ 已修', already: '✔ 无需修', missing: '· 未安装', nomatch: '! 跳过' }[r.status]
  console.log(`[h3-patch] ${icon}  ${r.file}\n           ${r.detail}`)
  process.exit(0)
}
     