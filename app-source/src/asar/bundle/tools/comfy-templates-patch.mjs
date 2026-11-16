#!/usr/bin/env node
// ============================================================
// ComfyUI 模板示例图补丁: 让"模型包不含模板示例图"不再在日志里报 ERROR
//
// 症状 (2026-10-04 用户: "这次发了模型包之后，有一些机型出现了这个报错"):
//   Krea2 后端启动日志里出现
//     [ERROR] Failed to resolve template asset paths: Package
//             'comfyui_workflow_templates_media_api' is not installed for asset
//             'api_bfl_flux2_max_sofa_swap-1.webp' ...
//   有的机型则是
//     [ERROR] No workflow template assets found. Did the packages install correctly?
//
// 根因 (两边源码都读过, 不是猜的):
//   · `comfyui-workflow-templates` 的 METADATA 把五个 media 包写成**硬依赖**
//     (media-api / media-video / media-image / media-other / media-assets-01);
//   · 我们的模型包**故意剔掉了那五个包** —— 它们是 ComfyUI 自带"模板浏览器"的示例图/预览图,
//     实测每层 392MB(五件 wheel 合计)× 三层 ≈ **1.2GB**, 而 Manke 从不打开 ComfyUI 的模板界面,
//     所以打包规则把它们排除(见 tools/pack-models.mjs 的 SOFT_EXCLUDES、tools/clean-model-junk.mjs);
//   · 新版 ComfyUI 核心(0.31.x)在**启动时**会为模板解析一遍图片路径:
//       老写法: 只要有一张图缺 → 整个 asset_map 放弃 + `logging.error('Failed to resolve...')`;
//       新写法: 单张缺失会 continue, 但**一张都没解析到时**仍打 `logging.error('No workflow template assets found...')`。
//     两种写法在"示例图被剔掉的包"上都会打 ERROR —— 这就是用户看到的"报错"。
//
// 影响: **纯日志噪音, 不影响生成** —— 那张图只服务 ComfyUI 自带模板浏览器的缩略图,
//   解析失败只是 `/templates/<path>` 这条静态路由不注册(见 ComfyUI/server.py 里 use_legacy_templates 那段),
//   Manke 生成链路一行都不经过它(后端照常 "Starting server" + 生成正常)。
//
// 修法(比"把 1.2GB 装回去"划算得多): 把这段解析改成**逐张容错**, 并把"一张都没有"从 error 降成 info,
//   文案里写明"这是 Manke 精简模型包的预期结果"。两条分支(严格/已容错)都覆盖, 幂等, 首次修改留 .aics-orig。
//
// 用法:
//   node tools\comfy-templates-patch.mjs                # 打补丁(默认找程序目录里的 backends)
//   node tools\comfy-templates-patch.mjs --root D:\Manke\backends
//   node tools\comfy-templates-patch.mjs --check        # 只看状态, 不写
//   node tools\comfy-templates-patch.mjs --quiet        # 只在真的改了东西时输出(给程序自动调用)
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')

/** 幂等标记: 文件里出现它就说明这一份已经打过了 */
const MARK = '# Manke: 模板示例图按需缺省'

/** 老写法(严格: 第一张缺就整段放弃并报 ERROR) —— 原文逐字符匹配 */
const STRICT = [
  '        asset_map: Dict[str, str] = {}',
  '        try:',
  '            for entry in template_entries:',
  '                for asset in entry.assets:',
  '                    asset_map[asset.filename] = get_asset_path(',
  '                        entry.template_id, asset.filename',
  '                    )',
  '        except Exception as exc:',
  '            logging.error(f"Failed to resolve template asset paths: {exc}")',
  '            return None',
].join('\n')

/** 打补丁后的写法(逐张容错; 与较新核心自带的写法一致, 只是多了标记注释) */
const TOLERANT = [
  `        ${MARK}(模型包剔掉了 392MB/层的模板示例图包)`,
  '        asset_map: Dict[str, str] = {}',
  '        for entry in template_entries:',
  '            for asset in entry.assets:',
  '                try:',
  '                    asset_map[asset.filename] = get_asset_path(',
  '                        entry.template_id, asset.filename',
  '                    )',
  '                except FileNotFoundError:',
  '                    # 这张示例图不在包里 —— 跳过它, 不要让整张表作废',
  '                    continue',
  '                except Exception as exc:',
  '                    logging.error(f"Failed to resolve template asset paths: {exc}")',
  '                    return None',
].join('\n')

/** "一张都没解析到"这一句: 在我们这种精简包里是**预期**, 降成 info */
const EMPTY_ERROR = [
  '        if not asset_map:',
  '            logging.error("No workflow template assets found. Did the packages install correctly?")',
  '            return None',
].join('\n')

const EMPTY_INFO = [
  '        if not asset_map:',
  `            # ${MARK.replace('# ', '')}: 模板示例图包没随模型包发(省 ~1.2GB), 这里不是安装问题`,
  '            logging.info(',
  '                "Workflow template assets are not bundled in this Manke build (expected); "',
  '                "the ComfyUI template browser will show no previews."',
  '            )',
  '            return None',
].join('\n')

/** 这一层后端(ComfyUI 系)可能放 frontend_management.py 的地方 —— 广度优先找一遍, 深度封顶 */
const SKIP_DIRS = new Set(['models', 'output', 'input', 'temp', 'cache', '.git', 'node_modules', 'site-packages', '__pycache__'])
function findFrontendManagement(root, depth = 6) {
  const out = []
  const walk = (dir, d) => {
    if (d > depth) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory()) {
        if (e.name === 'frontend_management.py' && path.basename(dir) === 'app') out.push(path.join(dir, e.name))
        continue
      }
      if (SKIP_DIRS.has(e.name)) continue
      walk(path.join(dir, e.name), d + 1)
    }
  }
  walk(root, 0)
  return out
}

/** 只改这一处文件; 返回 { status, note } */
export function patchFrontendManagement(file, { check = false } = {}) {
  let src = ''
  try { src = fs.readFileSync(file, 'utf-8') } catch (e) {
    return { status: 'error', note: `读不了: ${e?.message ?? e}` }
  }
  /**
   * ⚠️ 必须先把换行统一成 LF 再匹配: 这些后端文件的换行是 **CRLF**,
   *   直接拿 `\n` 拼的多行模板去 includes 永远匹配不上(第一版就踩了)。
   *   写回时再按原样恢复, 不动别人的换行风格。
   */
  const crlf = src.includes('\r\n')
  const norm = src.replace(/\r\n/g, '\n')
  if (norm.includes(MARK) && norm.includes('the ComfyUI template browser will show no previews')) {
    return { status: 'already' }
  }
  const hasStrict = norm.includes(STRICT)
  const hasEmptyError = norm.includes(EMPTY_ERROR)
  if (!hasStrict && !hasEmptyError) {
    return { status: 'skip', note: '没找到可识别的写法(多半是另一版 ComfyUI) —— 原样不动' }
  }
  let next = norm
  const did = []
  if (hasStrict) { next = next.replace(STRICT, TOLERANT); did.push('逐张容错') }
  if (hasEmptyError) { next = next.replace(EMPTY_ERROR, EMPTY_INFO); did.push('空表降级') }
  if (next === norm) return { status: 'skip', note: '匹配到但替换后没变化' }
  if (crlf) next = next.replace(/\n/g, '\r\n')
  if (check) return { status: 'would-patch', note: did.join(' + ') }
  try {
    const bak = `${file}.aics-orig`
    if (!fs.existsSync(bak)) fs.copyFileSync(file, bak)
    fs.writeFileSync(file, next, 'utf-8')
  } catch (e) {
    return { status: 'error', note: `写不了: ${e?.message ?? e}` }
  }
  return { status: 'patched', note: did.join(' + ') }
}

/** 对一层后端根目录打补丁(找不到那个文件 = 这一层不是 ComfyUI, 静默跳过) */
export function patchLayer(root, opts = {}) {
  const files = findFrontendManagement(root)
  const results = []
  for (const f of files) results.push({ file: f, ...patchFrontendManagement(f, opts) })
  return results
}

/** 对一个 backends 根目录(里面是 comfyui-kear2 / comfyui-qwen / h3 …)**逐层**打补丁 */
export function patchAllLayers(backendsRoot, opts = {}) {
  const out = []
  let dirs = []
  try { dirs = fs.readdirSync(backendsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return out }
  for (const name of dirs) {
    for (const r of patchLayer(path.join(backendsRoot, name), opts)) out.push({ layer: name, ...r })
  }
  return out
}

/* ---------------- CLI ---------------- */
const isMain = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) } catch { return false }
})()
if (isMain) {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const quiet = args.includes('--quiet')
  const iRoot = args.indexOf('--root')
  const root = iRoot >= 0 ? args[iRoot + 1] : path.join(REPO_ROOT, 'backends')
  const results = patchAllLayers(root, { check })
  const changed = results.filter((r) => r.status === 'patched' || r.status === 'would-patch')
  const bad = results.filter((r) => r.status === 'error')
  if (!quiet || changed.length || bad.length) {
    console.log(`[comfy-templates] 根目录 ${root}${check ? '（--check 只报告不写）' : ''}`)
    if (!results.length) console.log('  （没找到任何 ComfyUI 的 frontend_management.py）')
    for (const r of results) {
      const rel = path.relative(root, r.file)
      console.log(`  [${r.status}] ${r.layer}/${rel}${r.note ? ' — ' + r.note : ''}`)
    }
  }
  process.exit(bad.length ? 1 : 0)
}
                    