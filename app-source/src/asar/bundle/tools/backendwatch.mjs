// 后端启动全程监测 —— 冷启动判据 / 日志告警 / 相位判定
// ============================================================
// 抽成独立模块的理由: 这三块都是"判断"逻辑, 必须能被确定性测试覆盖。
// 上次的教训: 只靠"把包跑一遍看结果", 于是三个后端一个都没起来、界面空转 8 分钟都没人发现。
//
// 设计要点:
//  1) 冷启动判据来自**目标程序自己的运行痕迹**(__pycache__ / triton 缓存 / ComfyUI user 配置),
//     不是我们自己的标记文件 —— 否则"用户重新解压一份新包"会被误判成"跑过"。
//     实测: 真实首次启动 12 分钟, 已跑过的机器十几秒。
//  2) 告警在**输出到达时**就判, 不等进程退出 —— 这是"全程监测"的核心。
//  3) 相位判定必须区分"安静"与"卡死": 冷启动期间程序会长时间无输出(编译字节码/CUDA kernel),
//     阈值要放宽, 且**有输出在动就绝不判定停滞**。
import fs from 'node:fs'
import path from 'node:path'

/** 判定"这台机器第一次跑该后端"的痕迹路径(返回 [原因, 路径] 列表) */
export function coldProbePaths(kind, root, homeDir) {
  if (!root) return []
  const home = homeDir || ''
  if (kind === 'h3') {
    return [
      ['ComfyUI 首次运行(无 __pycache__ 字节码)', path.join(root, 'ComfyUI', '__pycache__')],
      ['Python 依赖未编译过(torch 无 __pycache__)', path.join(root, 'python_embeded', 'Lib', 'site-packages', 'torch', '__pycache__')],
      ['CUDA kernel 未编译过(triton 缓存为空)', path.join(root, 'cache', 'triton')],
      ['ComfyUI 用户配置未生成(user/ 为空)', path.join(root, 'ComfyUI', 'user')],
    ]
  }
  if (kind === 'kear') {
    return [
      ['ComfyUI 首次运行(无 __pycache__ 字节码)', path.join(root, 'ComfyUI', '__pycache__')],
      ['Python 依赖未编译过(torch 无 __pycache__)', path.join(root, 'python_embeded', 'Lib', 'site-packages', 'torch', '__pycache__')],
      ['CUDA kernel 未编译过(用户目录 triton 缓存为空)', home ? path.join(home, '.triton', 'cache') : ''],
      ['ComfyUI 用户配置未生成(user/ 为空)', path.join(root, 'ComfyUI', 'user')],
    ]
  }
  if (kind === 'indextts') {
    return [
      ['首次运行(无 __pycache__ 字节码)', path.join(root, '__pycache__')],
      ['Python 依赖未编译过(torch 无 __pycache__)', path.join(root, 'python_embeded', 'Lib', 'site-packages', 'torch', '__pycache__')],
    ]
  }
  return []
}

/**
 * 这台机器上该后端是否属于冷启动。
 * ⚠️ 判据 **宁可判冷**: 判冷只是放宽超时 + 文案更耐心;
 *    误判成"热"会让正常但慢的首次启动被判失败, 那个代价大得多。
 */
export function coldStart(kind, root, homeDir) {
  // 测试/排障开关: 强制按冷启动处理。用途是把"真·首次启动"的界面与超时路径在本地回归 ——
  // 真首次(要重新编译上千个模块与 CUDA kernel)在已经跑过的开发机上无法复现。
  if (process.env.AICS_FORCE_COLD === '1') {
    return { cold: true, reasons: ['[诊断] 已强制按"首次运行"处理 (AICS_FORCE_COLD=1)'] }
  }
  const reasons = []
  for (const [why, p] of coldProbePaths(kind, root, homeDir)) {
    if (!p) continue
    let warm = false
    try {
      const st = fs.existsSync(p) ? fs.statSync(p) : null
      if (st && st.isDirectory()) warm = fs.readdirSync(p).length > 0
      else if (st && st.isFile()) warm = st.size > 0
    } catch { warm = false }
    if (!warm) reasons.push(why)
  }
  return { cold: reasons.length > 0, reasons }
}

/**
 * 告警规则。sev=error → 直接说明"这一路起不来"; sev=warn → 只记录。
 * 注意 Traceback 在 ComfyUI 里很常见(自定义节点 import 失败常被 catch), 所以降为 warn。
 */
export const ALERT_RULES = [
  // cudaErrorMemoryAllocation 就是 CUDA 的 OOM 错误码(cudaError_t=2), 归显存而非"崩溃"
  { code: 'VRAM_INSUFFICIENT', sev: 'error', re: /CUDA error:\s*out of memory|CUDA out of memory|OutOfMemoryError|cudaErrorMemoryAllocation|out of memory allocating/i },
  { code: 'DRIVER_TOO_OLD', sev: 'error', re: /CUDA driver version is insufficient|CUDA not available on this system|no kernel image is available|Found no NVIDIA driver/i },
  { code: 'BACKEND_CRASHED', sev: 'error', re: /Windows fatal exception|access violation|please send a crash report/i },
  /**
   * ★ 2026-10-30 客户现场 (RTX 5070 Ti 16GB / 驱动 617.42):
   *   采样 6 步全跑完, 出片时 VAE 解码栽在"权重从内存/磁盘回读"上, 进程以 access violation 没了。
   *   日志原话: `GetOverlappedResult failed error=1450` / `hostbuf_read_file_slice: file read failed`
   *            / `hostbuf_file_reader_read failed` / `HostBuffer.read_file_slice failed`
   *   error=1450 = ERROR_NO_SYSTEM_RESOURCES(页面文件太小/系统资源耗尽), **不是驱动版本问题**。
   *   放在 BACKEND_CRASHED **之后**: 两条会同时命中, 前端取最后一条 error 告警,
   *   这样界面上给的是"内存不够"这条能落地的结论, 而不是笼统的"崩溃"。
   */
  { code: 'HOST_MEMORY_SHORTAGE', sev: 'error', re: /hostbuf_file_reader_read failed|HostBuffer\.read_file_slice failed|hostbuf_read_file_slice|xfer_file_read|GetOverlappedResult failed|DefaultCPUAllocator: not enough memory/i },
  /**
   * ★ 2026-10-12 客户机实测(用户转来的现场): Krea2 起不来, 日志里是
   *
   *   OSError: [WinError 1114] 动态链接库(DLL)初始化例程失败。
   *     Error loading "…\python_embeded\Lib\site-packages\torch\lib\c10.dll" or one of its dependencies.
   *   紧接着  Windows fatal exception: access violation   (同一个 _load_dll_libraries)
   *
   *   ⚠️ 这跟"端口被占 / 模型包缺文件 / 显存不够"**都不是一回事**, 处置办法也完全不同, 必须单独认出来:
   *     · torch 的 DLL 初始化失败 ⇒ 多半是 **VC++ 运行库**缺失/过旧(那两个 ComfyUI 包只自带
   *       vcruntime140*.dll, 没自带 msvcp140.dll —— 得靠系统的 VC++ 2015-2022 运行库), 或者
   *       **显卡驱动撑不起默认的 CUDA 13 栈**;
   *     · 所以: 先**自动换包内 CUDA 12.6 兼容栈重试一次**(见 server.mjs), 不行再由
   *       diagnoseTorchDllInit 给出**实测过的**结论与出路(缺哪个说哪个)。
   *   放在 BACKEND_CRASHED **之后**: 两条会同时命中, 而前端取的是"最后一条 error 告警",
   *   这样界面上给出来的才是这条更精确、更可执行的结论。
   */
  { code: 'TORCH_DLL_INIT', sev: 'error', re: /WinError\s*1114|DLL initialization routine failed|初始化例程失败|c10\.dll/i },
  { code: 'PORT_CONFLICT', sev: 'error', re: /Address already in use|error while attempting to bind|WinError 10048|Only one usage of each socket address/i },
  { code: 'SECURITY_BLOCKED', sev: 'error', re: /PermissionError|Access is denied|WinError 5\b|DLL load failed|blocked by your security/i },
  // 应用程序控制/智能应用控制/WDAC 拦截动态库 (2026-09-15 测试反馈):
  //   torch\lib\shm.dll 被"应用程序控制策略"阻止 → WinError 4551 → OSError → 退出码 1。
  //   单独一条规则, 因为它的处置办法(关 SAC / 加信任区 / WDAC 白名单)与普通杀软拦截不同。
  { code: 'POLICY_BLOCKED', sev: 'error', re: /WinError\s*4551|\b4551\b|application control polic|smart app control|应用程序控制|智能应用控制|CodeIntegrity|blocked by (?:application|policy)/i },
  { code: 'MODEL_MISSING', sev: 'error', re: /No such file or directory|FileNotFoundError|model not found|Cannot find the model/i },
  { code: 'DEP_MISSING', sev: 'warn', re: /ModuleNotFoundError|ImportError/i },
  { code: 'TRACEBACK', sev: 'warn', re: /Traceback \(most recent call last\)/i },
]

export function firstMatchLine(text, re) {
  for (const ln of String(text).split(/\r?\n/)) {
    if (re.test(ln)) return ln.trim().slice(0, 220)
  }
  return ''
}

/**
 * 全程扫描一段输出, 命中的告警累加到 rec.alerts 并返回"本次新命中"的列表。
 * rec 需要 { kind?, alerts: [] }。
 */
export function scanAlerts(rec, text) {
  if (!rec.alerts) rec.alerts = []
  const fresh = []
  for (const r of ALERT_RULES) {
    if (!r.re.test(text)) continue
    const hit = rec.alerts.find((a) => a.code === r.code)
    if (hit) {
      hit.n++
      hit.at = Date.now()
      const s = firstMatchLine(text, r.re)
      if (s) hit.sample = s
    } else {
      const a = { code: r.code, sev: r.sev, at: Date.now(), n: 1, sample: firstMatchLine(text, r.re) }
      rec.alerts.push(a)
      fresh.push(a)
    }
  }
  return fresh
}

/** 该不该把这一路视为"卡住"(silentSec 超过阈值)。冷启动阈值必须更宽。 */
export function silentLimitSec(cold) {
  return cold ? 240 : 90
}

/**
 * 进程侧相位(不含端口探测, 端口由 /api/status 判定; 两者结合才是最终结论)。
 * rec: { exited, stopping, sawFirstOutput, sawVram, sawReadyHint, startedAt, lastOutputAt }
 */
export function recPhase(rec, now, cold) {
  if (rec.exited) return rec.stopping ? 'stopped' : 'exited'
  const limit = silentLimitSec(cold)
  const silentSec = Math.round((now - (rec.lastOutputAt || rec.startedAt)) / 1000)
  if (rec.sawReadyHint) return silentSec > limit ? 'ready-hint-quiet' : 'ready-hint'
  if (!rec.sawFirstOutput) return silentSec > 90 ? 'no-output' : 'spawning'
  if (silentSec > limit) return 'stalled'
  if (rec.sawVram) return 'loading'
  return 'booting'
}

/** 给前端的超时建议: 冷启动实测可达 12 分钟, 必须留足 */
export function timeoutHintSec(cold) {
  return cold ? 1200 : 300
}

/** 相位 → 中文人话(前端与诊断包共用, 避免两边各写一套) */
export const PHASE_TEXT = {
  spawning: '正在启动进程',
  booting: '正在加载依赖',
  loading: '正在初始化显存',
  'ready-hint': '服务已响应，等待端口就绪',
  'ready-hint-quiet': '服务已响应，等待端口就绪',
  stalled: '较长时间没有新输出',
  'no-output': '进程已启动但还没有输出',
  stopped: '已停止',
  exited: '进程已退出',
}
