// ============================================================
// 低驱动兼容栈选择器
//
// 背景: H3 / Krea2 / 千问 用的是 torch 2.13/2.14 +cu130 (CUDA 13.0), 要求 NVIDIA 驱动 >= 580.88。
//       公测机型里必然有一批驱动更旧 —— 让它们也能跑, 而不是崩掉
//       (用户反馈的 0xC0000005 就是"驱动撑不起 cu130, 但 torch 照调 CUDA api")。
//       包里额外带一套 **同版本号** 的 2.13.0+cu126 (CUDA 12.6, 只需驱动 >= 560.76)。
//
// ⚠️ 2026-10-06 增补: **千问也吃这套栈**(实测: 前置 _vendor/cu126 后千问真能起服务,
//   `/system_stats` 自报 pytorch_version=2.13.0+cu126、cuda:0 RTX 3080)。
//   所以 COMPAT_KINDS 从 h3/kear 扩到 h3/kear/qwen —— 一套 4GB 兜住三条 CUDA 路。
//   唯一**明确不给**的是 IndexTTS: 它自带 torch 2.8.0+cu128, 换栈反而可能把语音后端搞坏。
//
// 为什么是 .pth 而不是 PYTHONPATH:
//   实测这两个后端的 python_embeded 带 python313._pth -> 走隔离模式,
//   **PYTHONPATH 会被完全忽略**; 但那个 ._pth 里有 `import site`,
//   所以 site-packages 下的 .pth 会被执行, 且在 .pth 里 sys.path.insert(0, ...)
//   能真正改变 `import torch` 解析到哪一个 —— 见 h3test/_make_cu126_vendor.py 的实测记录。
//
// 判定依据: cuDriverGetVersion() 返回"驱动支持的最高 CUDA 版本"(如本机 13030 = 支持 13.3)。
//   低于 13000 就说明驱动撑不起 CUDA 13, 切到 cu126 栈。
//   这比解析 nvidia-smi 的驱动号更可靠(不用知道每个 CUDA 版本对应的驱动下限)。
//
// 覆盖方式: 环境变量 AICS_CUDA_MODE=cu126|cu130 (排障/强制用)
// ============================================================
import fs from 'node:fs'
import path from 'node:path'

export const COMPAT_PTH_NAME = 'zz_aics_cuda_compat.pth'/** 内容版本标记: 变了就重写各后端的 .pth(便于以后升级选择逻辑) */
export const COMPAT_PTH_MARK = '# aics-cuda-compat-v2'

/** 选择器本体(纯 ASCII, 因为要嵌进 .pth 单行) */
const INNER = [
  'import os, sys, ctypes',
  '_base = os.path.dirname(os.path.abspath(sys.executable))',
  "_app = (os.environ.get('AICS_APP_ROOT') or '').strip()",
  '_cands = []',
  "if _app:",
  "    _cands.append(os.path.join(_app, '_vendor', 'cu126'))",
  'for _n in range(10):',
  "    _cands.append(os.path.join(_base, *(['..'] * _n), '_vendor', 'cu126'))",
  '_vendor = None',
  'for _c in _cands:',
  "    if os.path.isfile(os.path.join(_c, 'torch', '__init__.py')):",
  '        _vendor = os.path.abspath(_c)',
  '        break',
  'if _vendor:',
  "    _mode = (os.environ.get('AICS_CUDA_MODE') or '').strip().lower()",
  "    _use = (_mode == 'cu126')",
  "    if _mode == 'cu130':",
  '        _use = False',
  "    elif _mode != 'cu126':",
  '        try:',
  "            _nv = ctypes.WinDLL('nvcuda.dll')",
  '            _v = ctypes.c_int()',
  '            _nv.cuDriverGetVersion(ctypes.byref(_v))',
  '            _use = _v.value < 13000',
  '        except Exception:',
  '            _use = False',
  '    if _use:',
  '        sys.path.insert(0, _vendor)',
].join('\n')

/** .pth 文件内容: 单行 import 形式(site.addpackage 只认以 import 开头的行) */
export const COMPAT_PTH_CONTENT = COMPAT_PTH_MARK + '\n' + 'import sys; exec(' + JSON.stringify(INNER) + ')\n'

/**
 * 把选择器写进某个后端环境的 site-packages。幂等: 内容一致就不重写。
 * 注意 `_vendor/cu126` 不存在时这个 .pth 也不会做任何事(它只在找到 torch 时才插路径),
 * 所以"没有兼容层的包"装上它同样安全。
 * @returns {'written'|'unchanged'|'skipped'}
 */
export function installCompatPth(pythonEmbededDir) {
  try {
    const sp = path.join(pythonEmbededDir, 'Lib', 'site-packages')
    if (!fs.existsSync(sp)) return 'skipped'
    const p = path.join(sp, COMPAT_PTH_NAME)
    if (fs.existsSync(p)) {
      try {
        if (fs.readFileSync(p, 'utf8') === COMPAT_PTH_CONTENT) return 'unchanged'
      } catch { /* 读不到就当需要重写 */ }
    }
    fs.writeFileSync(p, COMPAT_PTH_CONTENT, 'utf8')
    return 'written'
  } catch {
    return 'skipped'
  }
}

/** 兼容栈在包里存在吗(判断"这台机器能不能被兜住") */
export function vendorExists(packageRoot) {
  try {
    return fs.existsSync(path.join(packageRoot, '_vendor', 'cu126', 'torch', '__init__.py'))
  } catch {
    return false
  }
}

/**
 * 从某个后端环境里移除选择器。
 * ⚠️ 必须用它兜住"不是每个后端都该装"这件事:
 *   IndexTTS 用的是自己的 torch 2.8.0+cu128 —— 如果它的环境里也有我们的 .pth,
 *   在低驱动机器上会被换成 2.13.0+cu126, 很可能把语音后端搞坏。
 * 只有 COMPAT_KINDS 里的那几路(h3 / kear / qwen)需要这个文件。
 */
export function removeCompatPth(pythonEmbededDir) {
  try {
    const p = path.join(pythonEmbededDir, 'Lib', 'site-packages', COMPAT_PTH_NAME)
    if (fs.existsSync(p)) {
      fs.unlinkSync(p)
      return 'removed'
    }
    return 'absent'
  } catch {
    return 'failed'
  }
}

/**
 * 只该装这几个后端(它们才是 torch cu130)。
 *   2026-10-06 起把 **qwen 也纳入**: 实测同一套 _vendor/cu126 能让千问正常起服务
 *   (千问的 python 在 conda 风格的 env\ 下, site-packages 同样是 env\Lib\site-packages, .pth 照常被执行)。
 *   indextts **永远不许**进这个表。
 */
export const COMPAT_KINDS = ['h3', 'kear', 'qwen']
