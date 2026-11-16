// 最低配置检查 —— "这台机器能不能跑"的单一事实来源
// ============================================================
// 设计原则(2026-09-14 用户定调):
//   **不达标的机器不"想办法硬跑"** —— 强行去跑只会把配置压垮、浪费用户时间,
//   最后还是要报错。正确做法是**早点、清楚地告诉他"这台设备不符合最低要求"**。
//
// 最低要求(用户指定):
//   显卡 : NVIDIA, 20 系及以上 (RTX 20/30/40/50; 无型号数字的专业卡按算力 7.5 判定)
//   显存 : ≥ 8GB
//   内存 : ≥ 24GB
//
// ⚠️ 判定宁可"放过"也不"误杀": 拿不到型号数字且拿不到算力时判 **unknown(不拦)**,
//    只提示"无法识别, 请自行确认", 避免把一块能跑的新卡判死。
//
// 抽成独立模块: 这是"规则", 必须能被确定性单测覆盖(注入硬件参数即可)。

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * Windows「应用程序控制」状态 —— 智能应用控制(SAC) / WDAC 策略 (2026-09-15 测试反馈)。
 *
 * 为什么必须查它: 这类策略会**按文件**拦动态库。实测一台测试机上 H3 与 Krea2 一启动就
 * 退出码 1, 日志里是 import comfy.utils → torch._load_dll_libraries() 加载
 * torch\lib\shm.dll 被"应用程序控制策略"阻止(**WinError 4551**), 而 IndexTTS 那一路正常
 * —— 程序侧绕不开, 只能提前告诉用户去关 SAC / 加信任区, 而不是让他对着"退出码 1"发呆。
 *
 * 读注册表与策略目录, 不需要管理员权限:
 *   HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy → VerifiedAndReputablePolicyState
 *     0 = 关闭 / 1 = 开启(强制) / 2 = 评估模式(评估中也会拦)
 *   %WINDIR%\System32\CodeIntegrity\CiPolicies\Active\*.cip 存在 → 这台机器有 WDAC 策略
 */
export function appControlState() {
  const out = { sac: 'unknown', sacRaw: '', wdac: false, wdacFiles: [] }
  try {
    const r = execFileSync(
      'reg',
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy', '/v', 'VerifiedAndReputablePolicyState'],
      { encoding: 'utf-8', timeout: 4000, windowsHide: true },
    )
    const m = /VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(String(r))
    if (m) {
      const v = parseInt(m[1], 16)
      out.sacRaw = String(v)
      out.sac = v === 0 ? 'off' : v === 1 ? 'on' : v === 2 ? 'eval' : 'unknown'
    }
  } catch { /* 键不存在 = 从没启用过 SAC */ }
  try {
    const dir = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'CodeIntegrity', 'CiPolicies', 'Active')
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((n) => /\.cip$/i.test(n))
      out.wdac = files.length > 0
      out.wdacFiles = files
    }
  } catch { /* ignore */ }
  return out
}

/** 最低要求 —— 改这里就能调整门槛 */
export const MIN_REQ = {
  gpuMinSeries: 20,     // RTX/GTX 型号系列数字下限 (RTX 2060 = 20)
  gpuMinCompute: 7.5,   // 型号认不出来时的兜底: 算力 7.5 = Turing(20系) 一代
  vramMinMB: 8192,      // 8GB
  /** 推荐显存: 低于它的机器只能用"实验档"跑(见 check 里的 VRAM_TIGHT 提示) */
  vramRecommendedMB: 12288,
  ramMinGB: 24,
}

/** 从显卡名里取"系列数字": RTX 3080 → 30 / GTX 1660 → 16 / RTX 5090 → 50 / MX150 → 1 */
export function gpuSeriesOf(name) {
  const m = /\b(?:RTX|GTX|MX)\s*(\d{3,4})\b/i.exec(String(name || ''))
  if (!m) return null
  const num = Number(m[1])
  if (!Number.isFinite(num) || num <= 0) return null
  return Math.floor(num / 100)
}

/** 是不是 NVIDIA 卡(名字或 nvidia-smi 可用都算) */
export function isNvidia(name, present) {
  if (present) return true
  return /nvidia|geforce|quadro|tesla|rtx\b|gtx\b/i.test(String(name || ''))
}

/* ============================================================
   显卡驱动判定 (2026-10-06 用户)
   ------------------------------------------------------------
   用户原话: "在日志里面也做一个判定, 用户的版本是什么, 大概的解决方案是什么, 可以提醒用户"。

   为什么单独成一块: 程序和模型包里带的 torch 是**按 CUDA 版本编译**的, 而 CUDA 运行时
   只能跑在"驱动够新"的机器上。驱动不够时不是抛 Python 异常, 而是**底层内存访问违规**
   (Windows 退出码 0xC0000005 = 3221225477) —— Python 层 try/except 抓不住, 进程被系统
   直接干掉, 日志里连 traceback 都没有。用户看到的现象是"视频一直生成不出来 / 启动就离线"。

   两条门槛与包内实际带的运行库一一对应:
     · CUDA 13   (torch 2.13.0+cu130 / 2.14.0+cu130, 默认栈) → 驱动 ≥ 580.88
     · CUDA 12.6 (torch 2.13.0+cu126, 包内兼容栈)            → 驱动 ≥ 560.76
   CUDA 12.x 有"最小版本兼容", 所以兼容栈的真实下限是 12.0 的基础驱动 525.60;
   低于它连兼容栈也起不来 —— 那种机器只能升级驱动。

   判定"宁可放过": 读不到版本 → unknown, 只提示不拦 (与 checkSysreq 同一原则)。
   ============================================================ */
export const DRIVER_REQ = {
  /** 默认栈: 包里 torch 编译时用的 CUDA 13, 需要 NVIDIA 580 系驱动 */
  cu130: { need: 580.88, label: 'CUDA 13（默认栈）' },
  /** 兼容栈: 包内自带 torch 2.13.0+cu126, 需要 560 系驱动 */
  cu126: { need: 560.76, label: 'CUDA 12.6（兼容栈）' },
  /** CUDA 12.x 最小版本兼容下限 (12.0 基础驱动) —— 兼容栈的绝对地板 */
  cu12Base: { need: 525.60, label: 'CUDA 12.x 下限' },
  /**
   * 我们验证过的驱动大版本上限: 超过它只提示"偏新", **不当作故障**。
   *   取 699 = 现役 6xx 系列(含参考机 610.88)都算验证过; 7xx 起才是没见过的。
   *   这一档只用来回答用户那句"是不是我驱动太新了" —— 新驱动本身不会让 CUDA 崩,
   *   真正的坑是**显卡架构**太老(见 archNote), 别把两者混为一谈。
   */
  testedMaxMajor: 699,
}

/** '610.88' → 610.88；读不出来 → null */
export function parseDriverVersion(v) {
  const m = /(\d{1,4})\.(\d{1,3})/.exec(String(v ?? '').trim())
  if (!m) return null
  const n = Number(`${m[1]}.${m[2]}`)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * 驱动判定 —— 日志、诊断包、自检页共用这一份结论。
 *
 * @param {object} gpu  { driverVersion, name, computeCap, present } (直接喂 gpuInfo() 即可)
 * @param {object} [opts]
 *   opts.compatAvailable  包里有没有 CUDA 12.6 兼容栈 (_vendor/cu126)
 * @returns {{
 *   code:'UNKNOWN'|'TOO_OLD_FAR'|'TOO_OLD_NEED_580'|'OK'|'NEWER_UNTESTED',
 *   level:string, version:string, num:number|null, need:number,
 *   compatUsable:boolean, compatAvailable:boolean,
 *   title:string, detail:string, action:string, archNote:string
 * }}
 */
export function driverAdvice(gpu, opts = {}) {
  const version = String(gpu?.driverVersion ?? '').trim()
  const num = parseDriverVersion(version)
  const compatAvailable = opts.compatAvailable === true
  const name = String(gpu?.name ?? '').trim()
  const cap = Number.isFinite(Number(gpu?.computeCap)) && Number(gpu?.computeCap) > 0
    ? Number(gpu.computeCap) : null
  /** 驱动撑不起 CUDA 13 时, 兼容栈能不能救 —— 要先过 12.x 的地板 */
  const compatUsable = num !== null && num >= DRIVER_REQ.cu12Base.need

  /**
   * 显卡架构这一条容易被忽略: CUDA 13 **取消了 Maxwell/Pascal/Volta**
   *   (最低 sm_75 = Turing/20 系)。这类卡即使驱动升到最新, cu130 的 torch
   *   照样报 cudaErrorNotSupported —— 用户会以为"我驱动明明很新"。
   */
  const archNote = (cap !== null && cap < MIN_REQ.gpuMinCompute)
    ? `显卡算力 ${cap} 低于 CUDA 13 要求的 ${MIN_REQ.gpuMinCompute}（Turing/20 系起）：`
      + '本机即使驱动够新，默认栈也起不来（cu126 兼容栈仍支持老架构）'
    : ''

  const base = {
    version, num,
    need: DRIVER_REQ.cu130.need,
    compatUsable, compatAvailable, archNote,
  }

  if (num === null) {
    return {
      ...base,
      code: 'UNKNOWN',
      level: '未知',
      title: '显卡/驱动未识别',
      detail: `没能读到 NVIDIA 驱动版本（nvidia-smi 无输出；${name || '没有识别到 NVIDIA 显卡'}）`,
      action: '确认已安装 NVIDIA 官方驱动；没有 NVIDIA 显卡时只能用云端接口与画布编排',
    }
  }

  if (num < DRIVER_REQ.cu12Base.need) {
    return {
      ...base,
      code: 'TOO_OLD_FAR',
      level: '过低',
      title: '显卡驱动过低',
      detail: `驱动 ${version} 太旧：连包内的 CUDA 12.6 兼容运行库都撑不起`
        + `（需要 ≥ ${DRIVER_REQ.cu126.need}，最低下限 ${DRIVER_REQ.cu12Base.need}）`,
      action: '必须更新 NVIDIA 驱动（官网 / GeForce Experience 下载，自定义安装 + 勾选"执行清洁安装"），装完重启电脑',
    }
  }

  if (num < DRIVER_REQ.cu130.need) {
    return compatAvailable
      ? {
        ...base,
        code: 'TOO_OLD_NEED_580',
        level: '偏低',
        title: '显卡驱动偏低（已走兼容栈）',
        detail: `驱动 ${version} 低于默认栈要求的 ${DRIVER_REQ.cu130.need}，已自动改用包内 CUDA 12.6 兼容运行库`,
        action: `能正常使用，但会失去 sageattention / comfy_kitchen 加速（生成略慢）；升级驱动到 ${DRIVER_REQ.cu130.need} 以上可恢复满速`,
      }
      : {
        ...base,
        code: 'TOO_OLD_NEED_580',
        level: '偏低',
        title: '显卡驱动偏低',
        detail: `驱动 ${version} 低于 ${DRIVER_REQ.cu130.need}，默认 CUDA 13 栈起不来 ——`
          + '会在初始化时以 0xC0000005（内存访问违规）直接退出，日志里没有 Python 报错',
        action: `① 升级 NVIDIA 驱动到 ${DRIVER_REQ.cu130.need} 以上（自定义安装 + 勾选"执行清洁安装"），装完重启电脑；`
          /**
           * ② 这条路 2026-10-06 起有了**正式交付物**: 用户拍板"单独发包"——
           *    dist\安装包\Manke_低驱动兼容补丁_cu126_v*.exe (tools\make-compat-patch.mjs 打)
           *    装完把 _vendor\cu126 与三份选择器 .pth 写进程序目录/三路环境, 不必升驱动。
           *    文案必须点名, 否则用户/客服只知道"换个安装包", 不知道去哪拿。
           */
          + '② 或安装官方「低驱动兼容补丁」（把 CUDA 12.6 兼容运行库补进程序目录，不必升驱动）',
      }
  }

  if (Math.floor(num) > DRIVER_REQ.testedMaxMajor) {
    return {
      ...base,
      code: 'NEWER_UNTESTED',
      level: '偏新',
      title: '显卡驱动比验证过的更新',
      detail: `驱动 ${version} 高于我们验证过的范围（验证到 6xx 系列），`
        + `本身满足默认栈要求（≥ ${DRIVER_REQ.cu130.need}）`,
      action: '一般无需处理；若出现异常退出 / 花屏 / 生成失败，可回退到 NVIDIA 官方稳定版驱动再试',
    }
  }

  return {
    ...base,
    code: 'OK',
    level: '满足',
    title: '显卡驱动满足要求',
    detail: `驱动 ${version} 满足 CUDA 13 默认栈要求（≥ ${DRIVER_REQ.cu130.need}）`,
    action: '',
  }
}

/**
 * 最低配置检查。
 *
 * @param {object} h
 *   h.ramGB       物理内存总量 (GB)
 *   h.vramMB      显存总量 (MiB)
 *   h.gpuName     显卡型号名 ('NVIDIA GeForce RTX 3080')
 *   h.computeCap  算力 (数字, 如 8.6; 取不到传 null/undefined)
 *   h.gpuPresent  nvidia-smi 是否读到卡
 *   h.driverVersion 驱动版本 (仅展示, 不参与判定)
 * @returns {{ok:boolean, unknown:boolean, fails:Array, notes:Array, min:object, summary:string, detail:string}}
 */
export function checkSysreq(h) {
  const ramGB = Number(h?.ramGB) || 0
  const vramMB = Number(h?.vramMB) || 0
  const name = String(h?.gpuName || '')
  const cap = Number.isFinite(Number(h?.computeCap)) && Number(h?.computeCap) > 0
    ? Number(h.computeCap) : null
  const nv = isNvidia(name, h?.gpuPresent === true)
  const series = gpuSeriesOf(name)

  const fails = []
  const notes = []

  // ---- 显卡 ----
  if (!nv) {
    fails.push({
      code: 'NO_NVIDIA',
      label: '没有检测到 NVIDIA 显卡',
      detail: '本地模型后端依赖 CUDA，需要 NVIDIA 显卡（AMD / Intel 显卡无法使用）',
    })
  } else if (series === null && cap === null) {
    notes.push({
      code: 'GPU_UNKNOWN',
      label: `显卡型号无法识别（${name || '未知'}）`,
      detail: `无法确认是否达到 ${MIN_REQ.gpuMinSeries} 系及以上，请自行确认`,
    })
  } else if (series !== null && series < MIN_REQ.gpuMinSeries) {
    fails.push({
      code: 'GPU_TOO_OLD',
      label: `显卡太旧（${name || `型号系列 ${series}`}）`,
      detail: `需要 ${MIN_REQ.gpuMinSeries} 系及以上（RTX 20/30/40/50）`,
    })
  } else if (series === null && cap !== null && cap < MIN_REQ.gpuMinCompute) {
    fails.push({
      code: 'GPU_TOO_OLD',
      label: `显卡算力不足（${cap}）`,
      detail: `需要算力 ≥ ${MIN_REQ.gpuMinCompute}（约等于 ${MIN_REQ.gpuMinSeries} 系及以上）`,
    })
  }

  // ---- 显存 ----
  if (vramMB > 0 && vramMB < MIN_REQ.vramMinMB) {
    fails.push({
      code: 'VRAM_LOW',
      label: `显存不足（${(vramMB / 1024).toFixed(1)}GB）`,
      detail: `需要 ≥ ${MIN_REQ.vramMinMB / 1024}GB`,
    })
  } else if (vramMB === 0 && nv) {
    notes.push({ code: 'VRAM_UNKNOWN', label: '没能读到显存容量', detail: '请确认显卡驱动已正确安装' })
  } else if (vramMB > 0 && vramMB < MIN_REQ.vramRecommendedMB) {
    // 8~12GB 显存: **能装能跑, 但属于实验档** —— 大测试反馈这个档位最容易出问题
    //   (DynamicVRAM 要频繁换页; 视频与生图两路重后端装不下, 会互相把显存撑爆)。
    //   这里只给"提示", 不拦人(用户明确要求不在机器上留限制)。
    notes.push({
      code: 'VRAM_TIGHT',
      label: `显存偏紧（${(vramMB / 1024).toFixed(1)}GB）`,
      detail: `建议 ≥ ${MIN_REQ.vramRecommendedMB / 1024}GB；此档位请一次只启动一个重模型（视频或图片），`
        + '并把 Windows 虚拟内存调到 32GB 以上，否则容易读到一半失败',
    })
  }

  // ---- 内存 ----
  if (ramGB > 0 && ramGB < MIN_REQ.ramMinGB) {
    fails.push({
      code: 'RAM_LOW',
      label: `内存不足（${ramGB}GB）`,
      detail: `需要 ≥ ${MIN_REQ.ramMinGB}GB`,
    })
  }

  /**
   * 哪些 note 才算"有**无法识别**的项"。
   * ⚠️ 2026-10-06 修(顺带清掉两条假红): 以前是"只要有 note 就算 unknown", 于是
   *   "3060Ti + 8GB 显存"这种**每一项都认出来了、只是显存偏紧**的机器, 摘要也被写成
   *   "基本满足（有无法识别的项）" —— 那不是认不出来, 是认出来了但偏紧, 对用户的含义完全不同。
   * 驱动未知(判定"宁可放过")不在这里: 它走 driverAdvice, 不进 checkSysreq 的 notes。
   */
  const UNKNOWN_NOTE_CODES = ['GPU_UNKNOWN', 'VRAM_UNKNOWN']
  const unknown = fails.length === 0 && notes.some((n) => UNKNOWN_NOTE_CODES.includes(n.code))
  const ok = fails.length === 0
  const head = ok
    ? (unknown ? '配置检查：基本满足（有无法识别的项）' : '配置检查：满足最低要求')
    : '该设备不符合最低要求'
  const parts = [
    `${name || '未知显卡'}（${(vramMB / 1024).toFixed(1)}GB 显存）`,
    `${ramGB}GB 内存`,
  ]
  return {
    ok,
    unknown,
    fails,
    notes,
    min: { ...MIN_REQ },
    /**
     * 结构化硬件事实 —— 前端"配置识别"卡片直接渲染这几项,
     * 不用去解析 summary 文案(文案一改界面就崩)。
     */
    facts: {
      ramGB,
      vramMB,
      gpuName: name,
      gpuSeries: series,
      computeCap: cap,
      nvidia: nv,
      driverVersion: String(h?.driverVersion || ''),
    },
    summary: `${head} · ${parts.join(' · ')}`,
    /** 给"不合格"提示块用的一行一行的说明 */
    detail: fails.length
      ? fails.map((f) => `${f.label} —— ${f.detail}`).join('\n')
      : notes.map((n) => `${n.label} —— ${n.detail}`).join('\n'),
  }
}
     