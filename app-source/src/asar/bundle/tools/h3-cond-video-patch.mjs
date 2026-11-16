#!/usr/bin/env node
// ============================================================
// H3 视觉条件尺寸兜底补丁: 参考图/参考视频与主 latent 不同尺寸时不再崩
//
// 症状 (2026-10-16 / 10-17 两台客户机都报):
//   comfy/ldm/minimax/model.py → _cond_video_rows → patchify_video
//   RuntimeError: shape '[1, 24, 1, 1, 22, 2, 40, 2]' is invalid for input of size 86400
//   （要 44×80 的 latent，实际给的是 60×60 —— 参考素材 960×960 方形、目标 704×1280）
//
// 根因: 前端提交图里，"参考视频"的帧序列没有按目标尺寸缩放（v2.2.0 已在前端修好:
//   app/src/services/comfy.ts 给 ref_videos 补了 ImageScale）。但**老前端 + 新程序包**的用户
//   仍旧会把未对齐的帧送进来 ⇒ 后端 patchify 的 reshape 当场崩（与视频多大无关，尺寸不等就必崩）。
//
// 修法(后端兜底，不动前端): 条件 latent 的 H/W 若不是 patch 的整数倍，**补到 patch 的整数倍**再 patchify。
//   · **必须是"补齐(ceil)"，不能是"裁掉(floor)"**：节点侧 layout 的 `img_update` 掩码按
//     `ceil(H/ph) * ceil(W/pw)` 算条件行数（实测 H=45/ph=2 ⇒ **23 行 = 920**），
//     而 `patchify_video` 内部是 `H // ph`（floor）⇒ 45 只能 patch 出 22 行（880）⇒ 对不上。
//     裁成 44 也一样（还是 22 行）—— 2026-10-17 第二版就是这么"修"的，用户照样报 880 vs 920。
//   · **只动 H/W，绝不动 T**：条件的帧数各不相同（参考图 T=1、参考视频 T=N），改 T 会让 cond 行数翻倍，
//     `all_video_rows[~img_update]` 报 `[20655,96] vs [1215,96]`（第一版把所有生成都弄崩的原因）。
//   · 补的是边缘 1 行/1 列（右/下），只影响条件参考的最外圈，代价远小于"整条链崩掉"；
//   · 幂等: 已打过的用 `[aics-patch]` 标记识别，重复调用直接跳过；
//   · 安全: 首次修改前留 `model.py.aics-orig`；匹配不到(上游改写法)就原样跳过并提示。
//
// 用法:
//   node tools\h3-cond-video-patch.mjs               # 打补丁(默认找程序目录里的 backends)
//   node tools\h3-cond-video-patch.mjs --root E:\Manke\backends
//   node tools\h3-cond-video-patch.mjs --check       # 只看状态, 不写
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')

const REL = ['h3', 'payload', 'backend', 'ComfyUI-H3', 'ComfyUI', 'comfy', 'ldm', 'minimax', 'model.py']

/** 条件行: H/W 不能整除 patch 时裁到整数倍（T 一律不动）, 再 patchify */
const LOOP_OLD = [
  '        for z in payload.get("cond_video_latents", []):',
  '            r = patchify_video(z.to(torch.float32), self.patch_size)',
].join('\n')
const LOOP_NEW = [
  '        # [aics-patch] 条件 latent 的 H/W 不是 patch 整数倍时, 补到整数倍再 patchify',
  '        #   ⚠️ 必须 **ceil 补齐**(layout 的 img_update 按 ceil 算行数), 不能用 floor 裁切 ——',
  '        #   裁切会让行数少一档(880 vs 920); 也 **绝不动 T**(参考图 T=1 / 参考视频 T=N, 改 T 会 ×17 行)。',
  '        _aics_ph, _aics_pw = self.patch_size[1], self.patch_size[2]',
  '        for z in payload.get("cond_video_latents", []):',
  '            _aics_h, _aics_w = z.shape[-2], z.shape[-1]',
  '            _aics_h2 = max(_aics_ph, ((_aics_h + _aics_ph - 1) // _aics_ph) * _aics_ph)',
  '            _aics_w2 = max(_aics_pw, ((_aics_w + _aics_pw - 1) // _aics_pw) * _aics_pw)',
  '            if (_aics_h2, _aics_w2) != (_aics_h, _aics_w):',
  '                z = torch.nn.functional.pad(z, (0, _aics_w2 - _aics_w, 0, _aics_h2 - _aics_h))',
  '            r = patchify_video(z.to(torch.float32), self.patch_size)',
].join('\n')

export function condVideoPatchFile(backendsRoot) {
  return path.join(backendsRoot, ...REL)
}

/**
 * 打补丁(幂等)。返回 { status, file, detail }
 *   status: 'fixed' 刚修好 | 'already' 已是修复版 | 'missing' 没装这一层 | 'nomatch' 版本对不上
 */
export function patchH3CondVideo(backendsRoot, { dryRun = false, log = () => {} } = {}) {
  const file = condVideoPatchFile(backendsRoot)
  if (!fs.existsSync(file)) return { status: 'missing', file, detail: '没找到 H3 模型源码(这一层可能没装)' }
  let src
  try {
    src = fs.readFileSync(file, 'utf-8')
  } catch (e) {
    return { status: 'nomatch', file, detail: `读不到: ${e.message}` }
  }
  /**
   * 新版标记（"补到整数倍"）才算已修；
   * 两个旧版都要识别出来、从 .aics-orig 还原后重打：
   *   ① "插值到主 latent"（v2.2.12，把单帧参考图拉成 T=17，所有生成全崩）
   *   ② "裁到整数倍"（v2.2.13，行数少一档 ⇒ 880 vs 920）
   */
  const NEW_MARK = '[aics-patch] 条件 latent 的 H/W 不是 patch 整数倍时, 补到整数倍'
  const OLD_MARKS = ['记下主 latent 的时空尺寸', 'patch 的整数倍, patchify 的 reshape 会崩 —— 裁到整数倍']
  if (src.includes(NEW_MARK)) {
    return { status: 'already', file, detail: '已是修复版' }
  }
  if (OLD_MARKS.some((m) => src.includes(m))) {
    const bak = `${file}.aics-orig`
    if (!fs.existsSync(bak)) {
      return { status: 'nomatch', file, detail: '检测到旧版补丁但没有 .aics-orig 备份 —— 请手动还原后重跑' }
    }
    src = fs.readFileSync(bak, 'utf-8')
    log('[h3-cond] 检测到旧版补丁 → 用 .aics-orig 还原后改打新版(ceil 补齐 H/W, 不动 T)')
  }
  /**
   * ⚠️ Windows 上这份 model.py 是 **CRLF** —— 直接用 `\n` 拼的匹配串会 includes 失败
   *   （第一版就是这么"版本对不上"的）。按文件实际行尾重建匹配串。
   */
  const nl = src.includes('\r\n') ? '\r\n' : '\n'
  const fix = (s) => s.split('\n').join(nl)
  const loopOld = fix(LOOP_OLD)
  if (!src.includes(loopOld)) {
    return { status: 'nomatch', file, detail: '找不到待修的那段(模型版本不同?) —— 未改动' }
  }
  const out = src.replace(loopOld, fix(LOOP_NEW))
  if (out === src) return { status: 'nomatch', file, detail: '替换无效 —— 未改动' }
  if (dryRun) return { status: 'fixed', file, detail: '(dry-run 未写入)' }
  /** 首次修改留一份原文件(只留一次, 不被后续覆盖) */
  const bak = `${file}.aics-orig`
  try {
    if (!fs.existsSync(bak)) fs.copyFileSync(file, bak)
  } catch (e) {
    log(`[h3-cond] 备份失败(继续修): ${e.message}`)
  }
  fs.writeFileSync(file, out, 'utf-8')
  return { status: 'fixed', file, detail: '条件 latent 的 H/W 不能整除 patch 时补齐到整数倍(ceil; 不动 T)' }
}

// ---------------------------------------------------------------- CLI
const argv = process.argv.slice(2)
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const i = argv.indexOf('--root')
  const root = i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : path.join(REPO_ROOT, 'backends')
  const r = patchH3CondVideo(root, { dryRun: argv.includes('--check'), log: (m) => console.log(m) })
  const label = {
    fixed: '✓ 已修',
    already: '✓ 已是修复版',
    missing: '· 没装 H3',
    nomatch: '⚠ 版本对不上(未改动)',
  }[r.status]
  console.log(`${label}  ${r.file}`)
  console.log(`   ${r.detail}`)
  process.exit(r.status === 'nomatch' ? 1 : 0)
}
     