// ============================================================
// 模型包 (Model Pack) —— 清单 / 体检 / 兼容判断
//
// 背景: 模型 (H3 视频 + Krea2 生图 + IndexTTS 语音) 合计上百 GB, 绝不跟着程序包走。
//   程序与模型从此是**两个独立发布物**:
//     程序包  Manke_程序包_v1.0.3_xxx.zip   几十~几百 MB, 改一行就发一次
//     模型包  漫客_模型包_v1.0.0_xxx        上百 GB, 只在模型真变时发一次
//
// 两者靠三样东西对接:
//   1) 位置: 由 data/settings.json 的 backendsRoot 指定 (留空 = 程序目录下的 backends/)
//   2) 清单: 模型包根目录的 models.manifest.json —— 记录包版本、契约号、各组件与关键文件指纹
//   3) 契约: models.apiVersion —— 程序按自己支持的契约号比对, 不匹配则明确提示, 而不是崩
//
// 设计取舍: 清单是"体检表"不是"封印"。缺少清单 (老用户直接把 backends/ 拷进来) 仍按
//   可用处理, 只在界面上标"未登记版本"; 有了清单才做契约校验。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** 程序当前支持的模型契约号 —— 只有"程序调用后端的方式"变了才 +1 (见 version.json) */
export const MODEL_API_VERSION = 1

export const MANIFEST_NAME = 'models.manifest.json'

/**
 * 三个模型组件的固定布局 (相对 backendsRoot) 与"必须存在的关键文件"。
 *
 * key 必须与 server.mjs 的 BACKENDS 键一致 (h3 / kear / indextts) —— 两处不一致会让
 * "哪个组件没装"这类判断各说各话。
 * tier: 该组件属于哪个可独立安装的包 (见 MODEL_TIERS)。
 */
export const MODEL_COMPONENTS = [
  {
    key: 'h3',
    label: 'H3 视频 (ComfyUI)',
    tier: 'video',
    rel: 'h3/payload/backend/ComfyUI-H3',
    markers: ['python_embeded/python.exe', 'ComfyUI/main.py'],
  },
  {
    key: 'kear',
    label: 'Krea2 生图 (ComfyUI)',
    tier: 'image',
    rel: 'comfyui-kear2',
    markers: ['python_embeded/python.exe', 'ComfyUI/main.py'],
  },
  {
    key: 'indextts',
    label: 'IndexTTS 语音',
    tier: 'voice',
    rel: 'indextts-tts',
    markers: ['python_embeded/python.exe', 'server.py'],
  },
  /**
   * 第 4 路 (2026-09-24 方案 A): Qwen-Image-2.1 生图 —— 与 Krea2 同属"生图包",
   * 但**是独立组件**: 用户可以选择只装 kear(老链路) 或再叠一个 qwen(4 步加速 + 更强的编辑)。
   * 布局差异: main.py 在组件根、python 在 env/ 下(conda 风格), 所以 markers 与上面三路不同。
   */
  {
    key: 'qwen',
    label: 'Qwen-Image-2.1 生图 (ComfyUI 0.37)',
    tier: 'image',
    rel: 'comfyui-qwen',
    markers: ['env/python.exe', 'main.py'],
    /**
     * 可选组件: 缺它不等于"生图包装坏了" —— 老生图包(只有 kear)照样算装好,
     * 界面不该因为它报"部分安装"。缺它只等于"图片卡里那个 Qwen 模型选不了"。
     */
    optional: true,
  },
]

/**
 * 模型包分层 —— 用户不必再为"只想用语音"去下 117GB。
 *
 * 三层可任意组合安装, 程序对"只装了其中一两层"是**正常状态**, 不是错误:
 * 缺哪层, 对应功能显示"未安装", 其余功能照常。
 * sizeHintGB 用于界面提示与磁盘检查 (实际体积以清单为准)。
 */
export const MODEL_TIERS = [
  {
    key: 'voice',
    label: '语音包',
    components: ['indextts'],
    sizeHintGB: 19,
    summary: 'IndexTTS 本地语音合成 + 音色克隆',
  },
  {
    key: 'image',
    label: '生图包',
    /** 必装: 只要 kear。qwen 是同一层里的**可选**第 4 路(见下面的 optional) */
    components: ['kear'],
    optional: ['qwen'],
    sizeHintGB: 51,
    summary: 'Krea2 文生图 + 参考改图 (图片 / 角色 / 场景卡片); 可另装 Qwen-Image-2.1 那一支',
  },
  {
    key: 'video',
    label: '视频包',
    components: ['h3'],
    sizeHintGB: 78,
    summary: 'H3 文生视频 / 图生视频 / 多参生视频',
  },
]

/**
 * 参考生图 (Qwen 参考编辑) 需要的模型文件 —— 与 app/src/services/kear.ts 的
 * 常量一一对应, 改一处必须改另一处。
 *
 * 为什么要单列: 老版生图包里只有 krea2 文生权重, 没有编辑权重与两个 LoRA。
 * 缺这些文件不算"装坏了", 而是"这一层还是旧版" —— 界面据此告诉用户:
 * 文生图照常能用, 想用参考生图就要换含参考生图的新版生图包。
 */
export const IMAGE_REFGEN_FILES = [
  'comfyui-kear2/models/diffusion_models/krea2_turbo_int8_convrot.safetensors',
  'comfyui-kear2/models/diffusion_models/qwen_image_edit_2509_int8_convrot.safetensors',
  'comfyui-kear2/models/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors',
  'comfyui-kear2/models/loras/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors',
]

/** 参考生图这一层是否就绪 (只看文件在不在, 不读体积 —— 快, 可以在自检里直接调) */
/**
 * 生成"真实文件排布"说明 —— 单一来源, 避免说明与包里的实际结构对不上。
 *
 * 背景 (2026-09-16 用户反馈"README-MODELS 的描述和模型包里的排布完全没有关联, 很容易误导"):
 *   说明文件过去是**手写**的三个平级文件夹名(h3\ comfyui-kear2\ indextts-tts\),
 *   而视频那一路在包里其实是 h3\payload\backend\ComfyUI-H3\…(两层壳), 用户解压后看到的
 *   跟说明对不上。现在按 MODEL_COMPONENTS 的 rel 生成 —— 布局一变, 说明自动跟着变。
 *
 * @param {string} target 目标目录的展示名 (默认 "程序目录\backends")
 */
export function componentLayoutLines(target = '程序目录\\backends') {
  const t = String(target).replace(/[\\/]+$/, '')
  const lines = []
  lines.push('包里/解压后看到的顶层 → 它在包里的真实结构（按模型清单生成，请整块移动，别拆开改名）：')
  lines.push('')
  for (const c of MODEL_COMPONENTS) {
    const segs = c.rel.split('/')
    const inner = segs.slice(1).join('\\')
    const left = inner ? `${segs[0]}\\${inner}\\` : `${segs[0]}\\`
    lines.push(`    ${left}`.padEnd(46) + ` →  ${t}\\${segs.join('\\')}\\` + (c.optional ? '   (可选)' : ''))
  }
  lines.push('')
  const requiredCount = MODEL_COMPONENTS.filter((c) => !c.optional).length
  const optionalCount = MODEL_COMPONENTS.length - requiredCount
  lines.push(`  必装的顶层就是 ${requiredCount} 个文件夹，挨个整块移动即可 —— 视频那个 h3\\ 里面还有`)
  lines.push('  payload\\backend\\ComfyUI-H3\\ 两层，那是它自带的结构，属正常现象。')
  if (optionalCount) {
    lines.push(`  标了「(可选)」的 ${optionalCount} 个是**多出来的一支**（当前是 comfyui-qwen\\）：`)
    lines.push('  有它，图片卡里可以多选一个 Qwen-Image-2.1；没有它，其它功能一样照常。')
  }
  return lines
}

/**
 * 生成时**真正会被加载**的模型文件（按后端加载器分类）。
 *
 * 为什么单列这张表: 用户报过"生成失败：模型文件不完整"的**误判** —— 关键是"下结论之前先核对"。
 *   核对要快(不能遍历 7 万个文件)且要准(只查这次生成要用的那几个), 所以按文件名逐个找:
 *     · 后端在线 → 直接问 /object_info, 拿 ComfyUI 自己认得的文件名清单(最权威);
 *     · 后端离线 → 在标准模型目录里找同名文件(不读内容, 毫秒级)。
 *
 * ⚠️ 与 app/src/services/comfy.ts 的 H3_MODELS 一一对应（hygiene 里有静态断言防止改一处漏一处）。
 *   turbo LoRA 是"三选一"档位: 只要有一个在就算齐(不同步数走不同文件)。
 */
export const GEN_MODEL_FILES = {
  h3: {
    /** 这几类都必须有 */
    required: {
      diffusion_models: [
        'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
        'minimax_h3_ref2va_pruned_int8_convrot.safetensors',
      ],
      // ⚠️ latent 上采样权重在**自己的目录**(latent_upscale_models), 不在 diffusion_models ——
      //   第一版把它写错目录, 于是"体检"把一台完全正常的机器判成"缺文件"(正是用户报的那类误判)。
      latent_upscale_models: ['minimax_h3_latent_upscaler_3d_bf16.safetensors'],
      vae: [
        'minimax_h3_video_vae_fp16.safetensors',
        'minimax_h3_audio_vae_fp32.safetensors',
      ],
      text_encoders: ['qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'],
    },
    /** 这几类"至少有一个" */
    anyOf: {
      loras: [
        // ★ 2026-09-30(模型包 v1.2.0): 作者那套低显加速流用的 lightx2v 4 步 v0.1;
        //   **多参(r2v)固定用它**(见 comfy.ts 的 pickTurboLora 与 docs/41 第 5 节)。
        'minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors',
        'minimax_h3_turbo_v4_step600_ema.safetensors',
        'minimax_h3_turbo_4step_ema_ckpt850.safetensors',
        'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
        'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors',
      ],
    },
  },
  kear: {
    required: {
      text_encoders: ['qwen_2.5_vl_7b_fp8_scaled.safetensors'],
    },
    anyOf: {
      diffusion_models: ['krea2_turbo_int8_convrot.safetensors'],
    },
  },
}

/** ComfyUI 各加载器的候选目录（后端离线时在这里按文件名找） */
const MODEL_DIRS = {
  diffusion_models: ['models/diffusion_models', 'models/unet'],
  latent_upscale_models: ['models/latent_upscale_models', 'models/upscale_models'],
  vae: ['models/vae'],
  text_encoders: ['models/text_encoders', 'models/clip', 'models/clip_gguf'],
  loras: ['models/loras'],
}

/**
 * 「**这几个具体文件**在盘上吗」—— 把"真缺模型包"和"后端没重扫"彻底分开 (2026-10-02)。
 *
 * 为什么必须有它(两次真机同现象): genFilesHealth 的 LoRA 判据是 **anyOf** ——
 *   "至少有一只 turbo LoRA 就算齐"。老模型包(v1.0/v1.1)里只有 v4/850/8step 那几只,
 *   于是被判成"文件齐全"; 可**多参(r2v)固定要**的
 *   `minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors`(模型包 v1.2.0 才进包)其实不在,
 *   界面就给出"点重启、别重下"这种**没用的建议**(2026-10-01 与 10-02 测试机两次截图一模一样)。
 *
 * 判据改成: 调用方把**这次图里真正用到的文件名**传进来, 这里在组件的模型目录里逐个找 ——
 *   · 都在盘上 → 盘没问题, 是**后端启动时扫的旧清单** → 该重启这一路;
 *   · 有找不到的 → **确实缺文件** → 该装最新模型包(缺的名字原样报出来)。
 *
 * @param {string} componentRel 组件相对 backendsRoot 的目录(见 MODEL_COMPONENTS)
 * @param {string[]} names 文件名(basename 即可; 传相对路径也只取末段)
 * @returns {{ found: string[], missing: string[] }}
 */
export function filesInComponent(backendsRoot, componentRel, names = []) {
  const root = path.join(backendsRoot, ...componentRel.split('/'))
  const roots = modelSearchRoots(root)
  const extraRoots = extraModelPathsRoots(root)
  const found = []
  const missing = []
  let truncated = false
  for (const raw of names) {
    const n = path.basename(String(raw ?? '').trim())
    if (!n) continue
    const hit = findFileUnder([...roots, ...extraRoots], n)
    if (hit.truncated) truncated = true
    if (hit.file) found.push(n)
    else missing.push(n)
  }
  /**
   * ⚠️ 2026-10-12 用户: "模型有就是有，没有就是没有" —— 只有**穷举完确实没有**才允许说"缺"。
   *   `exhaustive=false` 表示这次没扫完(目录太多/读不动/自定义目录没解析全) ⇒ 调用方一律按
   *   "查不出来"处理, **不许**下"缺文件"的结论(见 server.mjs 的 /api/models/health)。
   */
  return { found, missing, extraRoots, exhaustive: !truncated }
}

/**
 * 「去哪找这个文件」的候选根 —— **穷举模型的落地目录**, 而不是只看几个写死的子目录。
 *
 * ⚠️ 2026-10-12: 以前只 readdir 几个写死的子目录(`models/diffusion_models`、`models/loras`…)的**直接子项** ⇒
 *   文件放在子目录里(如 `models/loras/H3/xxx.safetensors`)或别的模型目录下就会被判成"缺" ——
 *   这正是用户说的"没缺却说缺"。现在按 ComfyUI 自己的口径: 把整棵 models 树都算上。
 */
function modelSearchRoots(componentRoot) {
  const roots = []
  for (const base of [componentRoot, path.join(componentRoot, 'ComfyUI')]) {
    const m = path.join(base, 'models')
    try { if (fs.existsSync(longPath(m))) roots.push(m) } catch { /* 下一个 */ }
  }
  /** 兜底: 有些打包把模型直接铺在组件根的 known 子目录下(没有 models\ 这一层) */
  for (const rel of Object.values(MODEL_DIRS).flat()) {
    const d = path.join(componentRoot, ...rel.split('/'))
    try { if (fs.existsSync(longPath(d))) roots.push(d) } catch { /* 下一个 */ }
  }
  return [...new Set(roots)]
}

/**
 * `extra_model_paths.yaml` 里额外挂的模型目录 —— ComfyUI 支持把模型放在**包外**的盘上,
 *   这时后端能列出这些文件, 而我们只扫包内就会误判"缺"。
 * ⚠️ 只做**保守**解析(不引 yaml 依赖): 取 `base_path:` 的值 + 其它**看起来像路径**的值
 *   (含 `/` 或 `\` 或盘符), 相对路径按 base_path 拼。解析不出来就当没有(宁可说"没扫全")。
 */
function extraModelPathsRoots(componentRoot) {
  const out = []
  const files = [
    path.join(componentRoot, 'extra_model_paths.yaml'),
    path.join(componentRoot, 'ComfyUI', 'extra_model_paths.yaml'),
  ]
  for (const f of files) {
    let txt = ''
    try { txt = fs.readFileSync(f, 'utf-8') } catch { continue }
    /** ⚠️ 相对路径都按 **yaml 自己所在的目录** 解析(ComfyUI 就是这个口径): kear 包里写的是 `base_path: ../` */
    const yamlDir = path.dirname(f)
    let basePath = ''
    for (const line of txt.split(/\r?\n/)) {
      if (/^\s*#/.test(line) || !line.includes(':')) continue
      const idx = line.indexOf(':')
      const key = line.slice(0, idx).trim()
      const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '')
      if (!val) continue
      if (key === 'base_path') {
        basePath = path.isAbsolute(val) ? val : path.resolve(yamlDir, val)
        out.push(basePath)
        continue
      }
      if (/[/\\]/.test(val) || /^[A-Za-z]:/.test(val)) {
        out.push(path.isAbsolute(val) ? val : path.join(basePath || yamlDir, val))
      }
    }
  }
  return [...new Set(out)].filter((d) => { try { return fs.existsSync(longPath(d)) } catch { return false } })
}

/**
 * 在若干根目录下**有界**地找同名文件(大小写不敏感, 只看文件名 —— 与 ComfyUI 的清单口径一致)。
 *   maxDirs 触顶 → truncated=true ⇒ 调用方按"没扫全"处理(绝不因此说"缺文件")。
 */
function findFileUnder(roots, name, { maxDirs = 4000, maxDepth = 6 } = {}) {
  let visited = 0
  let truncated = false
  const want = String(name).toLowerCase()
  const stack = roots.map((dir) => ({ dir, depth: 0 }))
  while (stack.length) {
    const { dir, depth } = stack.pop()
    if (visited >= maxDirs) { truncated = true; break }
    let entries = []
    try { entries = fs.readdirSync(longPath(dir), { withFileTypes: true }) } catch { continue }
    visited += 1
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isFile() && e.name.toLowerCase() === want) return { file: p, truncated }
      if (e.isDirectory() && depth < maxDepth) stack.push({ dir: p, depth: depth + 1 })
    }
  }
  return { file: null, truncated }
}

/** 一批文件名在若干根目录下的落地情况(一次遍历问一批, 省得每个名字都重扫一遍) */
function filesUnderRoots(roots, names) {
  const want = new Map()
  for (const raw of names) {
    const n = path.basename(String(raw ?? '').trim())
    if (n) want.set(n.toLowerCase(), n)
  }
  const found = []
  let visited = 0
  let truncated = false
  const MAX_DIRS = 4000
  const MAX_DEPTH = 6
  const stack = roots.map((dir) => ({ dir, depth: 0 }))
  while (stack.length && want.size) {
    const { dir, depth } = stack.pop()
    if (visited >= MAX_DIRS) { truncated = true; break }
    let entries = []
    try { entries = fs.readdirSync(longPath(dir), { withFileTypes: true }) } catch { continue }
    visited += 1
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isFile() && want.has(e.name.toLowerCase())) {
        found.push(want.get(e.name.toLowerCase()))
        want.delete(e.name.toLowerCase())
        continue
      }
      if (e.isDirectory() && depth < MAX_DEPTH) stack.push({ dir: p, depth: depth + 1 })
    }
  }
  return { found, exhaustive: !truncated }
}

/**
 * 「这次生成要用的模型文件齐不齐」—— 快查(只做 readdir + 名称比对), 结论保守:
 *   ⚠️ 2026-10-02 起, **"这次到底要哪个文件"优先走 filesInComponent()** —— 见它的说明:
 *     下面那份清单里的 LoRA 是 anyOf(至少一只 turbo LoRA 就算齐), 老模型包会被误判成"齐全"。
 *   level='complete'   文件都在(可以放心排除"模型文件不完整"这个原因)
 *   level='incomplete' **确定**缺哪个文件(才允许告诉用户"要补模型包")
 *   level='unknown'    查不出来(目录不存在/没有清单)—— 什么都不下结论
 * @param {string} componentRel 组件相对 backendsRoot 的目录(见 MODEL_COMPONENTS)
 * @param {string} key          'h3' | 'kear'
 */
export function genFilesHealth(backendsRoot, componentRel, key) {
  const spec = GEN_MODEL_FILES[key]
  if (!spec) return { level: 'unknown', reason: `没有登记 ${key} 的模型文件清单` }
  const root = path.join(backendsRoot, ...componentRel.split('/'))
  if (!fs.existsSync(root)) return { level: 'unknown', reason: '组件目录不存在（后端没装）' }
  const missing = []
  const found = []
  /**
   * ⚠️ 2026-10-12: 判"某类目录里有没有这个文件"改成 **树状穷举**(与 filesInComponent 同一套口径) ——
   *   以前只 readdir 那几个子目录的**直接子项**, 文件放在更深的子目录里(或挂到 extra_model_paths 的
   *   包外目录)就会被判成"缺"。这个函数以前是"另写一份", 两份判断口径不一致正是误判的来源。
   */
  const allRoots = modelSearchRoots(root).concat(extraModelPathsRoots(root))
  const lookIn = (sub, names) => {
    const hits = filesUnderRoots(allRoots, names)
    void sub
    return names.filter((n) => hits.found.includes(path.basename(n)))
  }
  let truncated = false
  for (const [, names] of Object.entries(spec.required ?? {})) {
    const hits = filesUnderRoots(allRoots, names)
    if (!hits.exhaustive) truncated = true
    for (const n of names) {
      if (hits.found.includes(path.basename(n))) found.push(n)
      else missing.push(n)
    }
  }
  for (const [sub, names] of Object.entries(spec.anyOf ?? {})) {
    const hits = filesUnderRoots(allRoots, names)
    if (!hits.exhaustive) truncated = true
    const hit = names.find((n) => hits.found.includes(path.basename(n)))
    if (hit) found.push(hit)
    else missing.push(`(${sub} 里一个都没有: ${names[0]} …)`)
  }
  /**
   * 保守兜底: 一个模型目录都没找到 → 说明这个后端的模型**不在我们认识的那几种布局里**,
   * 这种情况下"找不到文件"完全可能是我们看错了地方 —— 判 unknown, 绝不判"缺文件"。
   * (第一版就踩过: H3 的 latent 权重放在 latent_upscale_models, 被误判成缺失。)
   */
  if (!allRoots.length) return { level: 'unknown', reason: '没有找到任何模型目录, 无法判断文件是否齐全' }
  /** 没扫完 → 不许下"缺"的结论(与 filesInComponent 的 exhaustive 同一口径) */
  if (truncated) return { level: 'unknown', reason: '模型目录太大/读不全, 这次没扫完(不下结论)', missing, found }
  return missing.length
    ? { level: 'incomplete', missing, found }
    : { level: 'complete', found }
}

export function refGenStatus(backendsRoot) {
  const missing = []
  for (const rel of IMAGE_REFGEN_FILES) {
    const f = path.join(backendsRoot, ...rel.split('/'))
    if (!fs.existsSync(longPath(f))) missing.push(path.basename(rel))
  }
  return { ok: missing.length === 0, missing, total: IMAGE_REFGEN_FILES.length }
}

/** 组件 key → tier 定义 */
export function tierOfComponent(key) {
  return MODEL_TIERS.find((t) => t.components.includes(key)) ?? null
}

/**
 * 可**单独发一个包**的可选组件(当前只有 qwen)。
 *
 * 背景 (2026-09-24 用户拍板): "模型包为选装，不默认打包进入原来的生图包" ——
 *   生图包(约 51GB)照旧只发 kear; Qwen-Image-2.1 单独一个包, 谁想用谁装。
 */
export const OPTIONAL_PACK_KEYS = MODEL_COMPONENTS.filter((c) => c.optional).map((c) => c.key)

/**
 * 打包/校验时"一个包"到底装哪些组件 —— 参数是分层名(含可选包名) 或 'all'。
 *   分层名(image/video/voice) → 该层**必装**组件(可选件绝不偷偷塞进去)
 *   可选包名(qwen)            → 就那一个组件
 *   不认识                     → null(调用方据此报"未知分层")
 */
export function componentsOfPack(key) {
  const k = String(key || '').trim().toLowerCase()
  if (!k || k === 'all') return MODEL_COMPONENTS
  const tier = MODEL_TIERS.find((t) => t.key === k)
  if (tier) return MODEL_COMPONENTS.filter((c) => c.tier === k && !c.optional)
  const one = MODEL_COMPONENTS.find((c) => c.key === k && c.optional)
  return one ? [one] : null
}

/**
 * 按分层汇总安装情况 (给自己看"能做什么", 而不是"缺了什么")。
 *
 * optional 里的组件只是**列出来让用户看得见**(它也在这一层里), 不参与 ready/installed
 *   的计数 —— 否则只装老生图包(kear)的客户会看到"生图包 · 部分安装", 属于误判。
 */
export function tiersStatus(components) {
  return MODEL_TIERS.map((t) => {
    const required = t.components ?? []
    const optional = t.optional ?? []
    const mine = components.filter((c) => required.includes(c.key) || optional.includes(c.key))
    const installed = mine.filter((c) => c.installed && required.includes(c.key)).length
    return {
      key: t.key,
      label: t.label,
      summary: t.summary,
      sizeHintGB: t.sizeHintGB,
      installed,
      total: required.length,
      ready: installed === required.length && required.length > 0,
      components: mine.map((c) => c.key),
      /** 可选组件(有就顺带显示, 没有不影响 ready) */
      optional: mine.filter((c) => optional.includes(c.key)).map((c) => ({ key: c.key, installed: c.installed })),
    }
  })
}

export function manifestPath(backendsRoot) {
  return path.join(backendsRoot, MANIFEST_NAME)
}

/**
 * Windows 长路径前缀。
 *
 * 为什么必须有: 模型目录里有大量深层嵌套 (ComfyUI 的 site-packages 之类),
 * 路径很容易超过 260 字符。Node 在 Windows 上遇到超长路径会直接抛错 —— 如果遍历时
 * "catch 掉继续走", 结果就是**清单里的文件数悄悄少算上万**, 而没人发现。
 * 加 \\?\ 前缀可以绕开这个限制 (要求绝对路径 + 反斜杠)。
 */
export function longPath(p) {
  if (process.platform !== 'win32') return p
  const abs = path.resolve(p)
  if (abs.startsWith('\\\\?\\')) return abs
  return abs.length >= 240 ? `\\\\?\\${abs}` : abs
}

/** 读取模型包清单; 不存在/损坏都返回 null (调用方走"未登记"分支) */
export function readManifest(backendsRoot) {
  try {
    const f = manifestPath(backendsRoot)
    if (!fs.existsSync(f)) return null
    const j = JSON.parse(fs.readFileSync(f, 'utf-8'))
    return j && typeof j === 'object' ? j : null
  } catch {
    return null
  }
}

function shortHash(file, bytes = 4 * 1024 * 1024) {
  try {
    const f = longPath(file)
    const st = fs.statSync(f)
    const fd = fs.openSync(f, 'r')
    const len = Math.min(bytes, st.size)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, 0)
    fs.closeSync(fd)
    return crypto.createHash('sha256').update(String(st.size)).update(buf).digest('hex').slice(0, 16)
  } catch {
    return ''
  }
}

/**
 * 目录体积统计。
 * quick=true 时带时间预算 (默认 15s/组件), 超时则标 sizeExact=false —— 上百 GB 的
 * 目录做精确统计要几分钟, 不该卡在启动路径上。
 */
export function dirStats(dir, { quick = true, budgetMs = 15000 } = {}) {
  let files = 0
  let bytes = 0
  let exact = true
  let unreadable = 0
  const t0 = Date.now()
  const stack = [dir]
  while (stack.length) {
    if (quick && Date.now() - t0 > budgetMs) { exact = false; break }
    const cur = stack.pop()
    let ents
    try { ents = fs.readdirSync(longPath(cur), { withFileTypes: true }) }
    catch { unreadable++; continue }
    for (const ent of ents) {
      const p = path.join(cur, ent.name)
      if (ent.isDirectory()) { stack.push(p); continue }
      files++
      try { bytes += fs.statSync(longPath(p)).size } catch { unreadable++ }
    }
  }
  return { files, bytes, exact, unreadable }
}

/** 单个组件的体检结果 */
export function componentStatus(backendsRoot, comp, { quick = true } = {}) {
  const found = resolveComponentDir(backendsRoot, comp)
  const dir = found.dir ?? path.join(backendsRoot, ...comp.rel.split('/'))
  const present = fs.existsSync(dir)
  const missing = []
  const markers = {}
  for (const m of comp.markers) {
    const f = path.join(dir, ...m.split('/'))
    if (fs.existsSync(longPath(f))) markers[m] = shortHash(f)
    else missing.push(m)
  }
  const stats = present ? dirStats(dir, { quick }) : { files: 0, bytes: 0, exact: true }
  return {
    key: comp.key,
    label: comp.label,
    path: dir,
    /** 期望位置没找到、但在别处找到了 → 'found'(见 resolveComponentDir); 标准布局是 'expected' */
    layout: found.kind,
    expectedPath: found.expected,
    /** 可选组件: 不影响"装没装全"的结论, 只影响"这个模型能不能选" */
    optional: comp.optional === true,
    present,
    installed: present && missing.length === 0,
    missingMarkers: missing,
    markers,
    files: stats.files,
    bytes: stats.bytes,
    sizeExact: stats.exact,
    // 读不到的文件/目录数: 正常应为 0; 不为 0 时体积与文件数都不可信 (见长路径说明)
    unreadable: stats.unreadable ?? 0,
  }
}

/**
 * 按 `rel` 找组件目录 —— **先标准位置, 找不到再在 backendsRoot 下**有界地**深搜**。
 *
 * ⚠️ 2026-10-12 用户: "很多人在安装模型包后会提示这一路模型还没装…必须要正确检测，不能出现误判"。
 *
 *   以前只有一条路: `<backendsRoot>/<rel>` 下逐个 markers 存在就算装了。而用户解压模型包时最常见的两种
 *   装歪, 都会让这条判据**在文件明明都在的前提下**报"还没装":
 *     a) 把包解压进了 `backends\` 里 → 变成 `backends\backends\h3\payload\…`
 *        (或者解压到一个子目录里 → `backends\<包名>\backends\h3\…`);
 *     b) 少剥/多剥一层壳 → `…\ComfyUI-H3\payload\backend\ComfyUI-H3\…`。
 *
 *   深搜是**有界 + 剪枝**的: 只往下走 6 层、最多看 600 个目录, 并且**跳过**那些不可能再套一层组件的
 *   目录名(`models` / `output` / `input` / `web` / `custom_nodes` / `python_embeded` / `env` …) ——
 *   所以最坏情况也只是几百次 existsSync, 冷启动那一下完全无感; 标准布局**一次命中, 不搜**。
 *
 * @returns {{ dir: string|null, kind: 'expected'|'found'|'missing', expected: string }}
 */
export function resolveComponentDir(backendsRoot, comp, { maxDepth = 6, maxDirs = 600 } = {}) {
  const expected = path.join(backendsRoot, ...comp.rel.split('/'))
  const hasAll = (d) => comp.markers.every((m) => fs.existsSync(longPath(path.join(d, ...m.split('/')))))
  if (hasAll(expected)) return { dir: expected, kind: 'expected', expected }
  /**
   * 深搜时**还要认目录名**: h3 与 kear 的 markers 完全一样(`python_embeded/python.exe` + `ComfyUI/main.py`),
   *   光看 markers 会把 `comfyui-kear2` 当成 H3(实测踩到)。这里要求候选目录名 = 标准布局最后一段
   *   (`ComfyUI-H3` / `comfyui-kear2` / `indextts-tts` / `comfyui-qwen`, 忽略大小写)。
   *   标准位置**不做这个限制**(那里本来就是权威路径)。
   */
  const wantName = String(comp.rel).split('/').filter(Boolean).pop().toLowerCase()
  const isMine = (d) => path.basename(d).toLowerCase() === wantName && hasAll(d)
  /** 剪枝名单: 这些目录名下面不可能再套一层"组件根"(见函数头) */
  const SKIP = new Set([
    'models', 'output', 'input', 'temp', 'tmp', 'web', 'custom_nodes', 'python_embeded', 'env',
    'lib', 'site-packages', '__pycache__', 'node_modules', '.git', 'user', 'settings', 'log', 'logs',
  ])
  let visited = 0
  const walk = (dir, depth) => {
    if (visited >= maxDirs || depth > maxDepth) return null
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink?.()) continue
      const name = e.name.toLowerCase()
      if (SKIP.has(name)) continue
      visited += 1
      const sub = path.join(dir, e.name)
      if (isMine(sub)) return sub
      const hit = walk(sub, depth + 1)
      if (hit) return hit
    }
    return null
  }
  const hit = fs.existsSync(backendsRoot) ? walk(backendsRoot, 0) : null
  return { dir: hit, kind: hit ? 'found' : 'missing', expected }
}

/** 模型包文件名(.7z / .7z.001 / .zip) —— 扫描与安装必须共用这一条判据 */
export function isModelPackFile(name) {
  return /\.7z$/i.test(name) || /\.7z\.001$/i.test(name) || /\.zip$/i.test(name)
}

/** 扫描时绝不进入的目录: 要么是模型本体(几十万文件), 要么不可能放压缩包 */
const MODEL_PACK_SCAN_SKIP = new Set([
  'h3', 'comfyui-kear2', 'indextts-tts', 'comfyui-qwen',
  'models', 'output', 'input', 'temp', 'tmp', 'custom_nodes',
  'python_embeded', 'env', 'lib', 'site-packages', '__pycache__', 'node_modules', '.git',
])

/**
 * 在所选目录及其**有界**子目录中找模型压缩包。
 *
 * 背景(2026-10-25 用户实报): “安装后选择模型包、点击找位置，显示找不到模型包的位置”。
 *   旧实现只 `readdir` 第一层，用户把包放在“模型包\v1.2.0\”这种常见子目录里就全部漏掉。
 *   这里最多下探 3 层、最多看 400 个目录，并跳过模型本体目录 —— 找得到的范围变大，成本仍然可控。
 */
export function findModelPackFiles(root, { maxDepth = 3, maxDirs = 400 } = {}) {
  const out = []
  let visited = 0
  const walk = (dir, depth) => {
    if (visited >= maxDirs || depth > maxDepth) return
    let entries = []
    try { entries = fs.readdirSync(longPath(dir), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isFile() && isModelPackFile(e.name)) {
        try {
          const st = fs.statSync(longPath(full))
          out.push({ path: full, name: e.name, relative: path.relative(root, full), bytes: st.size, mtimeMs: st.mtimeMs })
        } catch { /* 读不到就跳过这一只 */ }
        continue
      }
      if (!e.isDirectory() || e.isSymbolicLink?.() || depth >= maxDepth) continue
      if (MODEL_PACK_SCAN_SKIP.has(e.name.toLowerCase())) continue
      visited += 1
      walk(full, depth + 1)
    }
  }
  if (fs.existsSync(root)) walk(root, 0)
  /** 同名版本可能留了好几份: 新的排前面, 同时间按路径稳定排序 */
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
}

/** 某个目录是否**按标准布局**同时具备一个组件的全部 markers */
function standardComponentAt(root, comp) {
  const dir = path.join(root, ...comp.rel.split('/'))
  const installed = comp.markers.every((m) => fs.existsSync(longPath(path.join(dir, ...m.split('/')))))
  return installed ? { key: comp.key, label: comp.label, tier: comp.tier, optional: comp.optional === true, path: dir } : null
}

/**
 * 从用户选的目录反推“已解压模型根目录”。
 *
 * 用户可能选:
 *   · 模型根本身（里面有 h3 / comfyui-kear2 / …）；
 *   · 外面还多套了一两层文件夹的下载/解压目录；
 *   · 某一个组件目录本身（例如 h3\）。
 * 所以候选 = 所选目录、父目录、最多两层子目录；只做**标准布局**的 markers 检查，不深搜模型内部。
 */
export function findExistingModelRoot(selected, { maxDirs = 80 } = {}) {
  const base = path.resolve(selected)
  const candidates = [{ root: base, distance: 0 }]
  /** 选到组件内部(例如 h3\payload\backend)时，向上 4 层仍能找回模型根 */
  let ancestor = base
  for (let i = 1; i <= 4; i += 1) {
    const up = path.dirname(ancestor)
    if (!up || up === ancestor) break
    ancestor = up
    candidates.push({ root: up, distance: i })
  }
  let visited = 0
  const addChildren = (dir, level) => {
    if (level > 2 || visited >= maxDirs) return
    let entries = []
    try { entries = fs.readdirSync(longPath(dir), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink?.() || visited >= maxDirs) continue
      if (MODEL_PACK_SCAN_SKIP.has(e.name.toLowerCase())) continue
      visited += 1
      const root = path.join(dir, e.name)
      candidates.push({ root, distance: level })
      addChildren(root, level + 1)
    }
  }
  addChildren(base, 1)
  const seen = new Set()
  const scored = []
  for (const c of candidates) {
    const key = c.root.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const components = MODEL_COMPONENTS.map((comp) => standardComponentAt(c.root, comp)).filter(Boolean)
    if (components.length) scored.push({ ...c, components })
  }
  scored.sort((a, b) => b.components.length - a.components.length || a.distance - b.distance || a.root.localeCompare(b.root))
  const best = scored[0] ?? null
  return best ? { root: best.root, components: best.components, ambiguous: scored.filter((x) => x.components.length === best.components.length).length > 1 } : null
}

/**
 * 当前模型安装状态 (给 /api/models 与启动提示用)。
 * @returns {{
 *   root:string, hasManifest:boolean, manifest:object|null,
 *   components:Array, installedCount:number, allInstalled:boolean,
 *   compat:{ok:boolean, level:'ok'|'unknown'|'mismatch', reason:string}
 * }}
 */
export function modelStatus(backendsRoot, { quick = true } = {}) {
  const manifest = readManifest(backendsRoot)
  const components = MODEL_COMPONENTS.map((c) => componentStatus(backendsRoot, c, { quick }))
  /** 必装组件(kear/h3/indextts) —— "装没装全"只看它们; qwen 这类可选组件单列 */
  const required = components.filter((c) => !c.optional)
  const installedCount = required.filter((c) => c.installed).length
  const tiers = tiersStatus(components)

  let compat
  if (!manifest) {
    compat = installedCount > 0
      ? {
        ok: true,
        level: installedCount === required.length ? 'unknown' : 'partial-unknown',
        reason: installedCount === required.length
          ? '模型目录未登记版本 (可用; 建议安装官方模型包以获得版本校验)'
          : `已装 ${installedCount}/${required.length} 个组件, 且未登记版本 (可用; 建议用官方分层模型包)`,
      }
      : { ok: false, level: 'missing', reason: '未找到模型包 (三个组件都不在)' }
  } else if (Number(manifest.apiVersion) !== MODEL_API_VERSION) {
    compat = {
      ok: false,
      level: 'mismatch',
      reason: `模型包契约号 ${manifest.apiVersion} 与本程序要求的 ${MODEL_API_VERSION} 不一致, 请更新对应的程序包或模型包`,
    }
  } else if (installedCount < required.length) {
    // 分层安装是**正常状态**: 只装了语音/生图的用户不该看到"错误"
    const missing = required.filter((c) => !c.installed).map((c) => {
      const t = tierOfComponent(c.key)
      return `${c.label}（${t ? t.label : '未分组'}）`
    })
    compat = {
      ok: true,
      level: 'partial',
      reason: installedCount === 0
        ? '模型包为空'
        : `已安装 ${installedCount}/${required.length} 个组件; 未安装: ${missing.join('、')}`,
    }
  } else {
    compat = { ok: true, level: 'ok', reason: `模型包 v${manifest.packVersion} (契约 ${manifest.apiVersion})` }
  }

  return {
    root: backendsRoot,
    hasManifest: !!manifest,
    manifest,
    components,
    tiers,
    installedCount,
    /** 必装组件总数(界面上的 x/y 用它, 不含 qwen 这类可选项) */
    requiredCount: required.length,
    allInstalled: installedCount === required.length,
    compat,
  }
}

/**
 * 生成模型包清单 (打包模型包时写入, 也是"体检报告"的落盘形式)。
 * deep=true 时对关键文件做完整 sha256 (默认只做首 4MB 采样, 快得多且足够识别替换)。
 */
export function buildManifest(backendsRoot, {
  packVersion = '1.0.0',
  apiVersion = MODEL_API_VERSION,
  minProgramVersion = '1.0.0',
  host = '',
  builtAt = new Date().toISOString(),
  quick = true,
  /** 只登记某一层 (voice / image / video); 不传 = 三层全登记 */
  tier = '',
} = {}) {
  const wanted = tier ? MODEL_COMPONENTS.filter((c) => c.tier === tier) : MODEL_COMPONENTS
  const components = wanted.map((c) => {
    const st = componentStatus(backendsRoot, c, { quick })
    return {
      key: st.key,
      label: st.label,
      tier: c.tier,
      rel: c.rel,
      present: st.present,
      installed: st.installed,
      missingMarkers: st.missingMarkers,
      markers: st.markers,
      files: st.files,
      bytes: st.bytes,
      sizeExact: st.sizeExact,
      unreadable: st.unreadable,
    }
  })
  return {
    manifestVersion: 1,
    product: 'Manke',
    packVersion,
    apiVersion: Number(apiVersion),
    minProgramVersion,
    /** 这个包包含哪一层 (all = 三层都在) */
    tier: tier || 'all',
    builtAt,
    builtBy: host,
    root: path.basename(backendsRoot),
    components,
    totals: {
      files: components.reduce((n, c) => n + (c.files || 0), 0),
      bytes: components.reduce((n, c) => n + (c.bytes || 0), 0),
      installed: components.filter((c) => c.installed).length,
      total: components.length,
    },
  }
}

/** 人读的体检文本 (写进模型包 README / 命令行输出) */
export function describeStatus(status) {
  const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`
  const lines = [`模型目录: ${status.root}`, `状态: ${status.compat.reason}`]
  for (const t of status.tiers ?? []) {
    lines.push(`  ${t.ready ? '[已装]' : t.installed > 0 ? '[部分]' : '[未装]'} ${t.label.padEnd(6)} 约 ${t.sizeHintGB}GB —— ${t.summary}`)
  }
  for (const c of status.components) {
    const warn = c.unreadable ? `  [!] ${c.unreadable} 个条目读不到, 数字偏低` : ''
    lines.push(`  ${c.installed ? '[√]' : '[×]'} ${c.label.padEnd(22)} ${c.present ? `${c.files} 个文件 / ${mb(c.bytes)}${c.sizeExact ? '' : ' (估算)'}` : '未安装'}${warn}`)
    if (c.missingMarkers.length) lines.push(`      缺少: ${c.missingMarkers.join(', ')}`)
  }
  return lines.join('\n')
}
          