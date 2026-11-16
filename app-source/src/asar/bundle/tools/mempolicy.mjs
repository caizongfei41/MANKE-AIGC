// 内存 + 显存监测与释放策略 —— 按硬件规模自适应
// ============================================================
// 为什么两个都要看:
//   内存 决定"模型能不能一直驻留"(实测 H3 曾占 48GB / Krea2 26GB)
//   显存 更"硬" —— 装不下就直接 OOM, 跟内存够不够无关
// 所以档位取**两者中更紧张的那个**。例:
//   128GB 内存 + 8GB 显存  → 显存紧 → aggressive(小显存机器根本不可能让两个模型同时驻留)
//    32GB 内存 + 24GB 显存 → 内存紧 → aggressive
//   128GB 内存 + 48GB 显存 → 两者都松 → keep
//
// 档位阈值(2026-09-14 按用户要求重新划线: **32GB 内存以上不再被限制**):
//   内存: ≥32GB keep / 24~32GB aggressive      (低于 24GB 属于"不符合最低要求", 另由 sysreq 拦)
//   显存: ≥16GB keep / 8~16GB balanced         (低于 8GB 同上)
//        16GB 才敢说"两套模型能同时驻留"; 12GB 卡切换模型类型时仍然必须让位。
//   档位取两者中更紧张的那个。含义:
//     keep       → 空闲期**不释放**模型(最省事, 下次生成最快)
//   注意: 中间档叫 balanced(不是 aggressive) —— aggressive 留给"低于最低要求"仍在硬跑的机器。
//     balanced   → 空闲期释放
//     aggressive → 空闲期释放 + 压力阈值更低(75%)
//   三者都遵守: 换后端时释放(旧模型用不上) + 压力超阈值立即释放 + 同类型任务继续保留
//   ⚠️ 阈值是"容量"分档, 不是"够不够跑 H3" —— 跑不跑得动由生成时的实际占用决定。
//
// 抽成独立模块的理由: 这是"策略", 必须能被确定性测试覆盖。依赖注入使它能纯函数测试。
import os from 'node:os'

/** 后端 kind → 中文名(提示语用; 与 server.mjs 的 BACKENDS.label 保持一致) */
export const BACKEND_LABEL = { h3: 'H3 视频', kear: 'Krea2 生图', indextts: 'IndexTTS 语音' }

/** 策略 → 人话(前端提示与诊断包共用) */
export const POLICY_TEXT = {
  keep: '配置宽裕：空闲时也保留模型，下次生成最快',
  balanced: '配置中等：空闲时释放模型以腾出显存/内存',
  aggressive: '配置偏紧：空闲时释放，且压力阈值更低，优先保证不爆',
}

/** 档位 → 方案名(界面展示"你这台机器走的是哪个方案") */
export const PLAN_TEXT = {
  keep: '轻量方案',
  balanced: '标准方案',
  aggressive: '积极方案',
}

/** 自动清理内存开关的说明(必须诚实说明代价) */
export const AUTO_FREE_HINT = {
  on: '开启：任务结束后自动卸掉模型腾出显存/内存（切换生成类型时上一个模型不再驻留；代价是下次生成要重新加载）',
  off: '关闭：模型常驻不释放，连续生成最快，也不会出现"排队中的任务等模型重新加载"（代价是显存/内存一直被占着）',
}

/**
 * "这台机器默认该不该开自动清理" —— 紧的机器默认开(否则切换模型类型容易 OOM),
 * 宽裕的机器默认关(用户不希望被过度限制)。
 * 只作为**初始值**, 用户改过之后以设置里的值为准。
 */
/**
 * "这台机器默认该不该自动清理内存" —— 2026-09-25 按用户口径**改成保守默认**。
 *
 * 用户原话: "我们现在设计的清空缓存的机制可能还是有问题……就像我现在的电脑基本上不会出现
 *   缓存问题，但是强行给我清掉后，出现了一直排队和排队中的卡片一直没办法生成的问题，
 *   这个是很影响体验的……这个功能是否应该留给客户。"
 *
 * 为什么敢默认关:
 *   ① "两个模型同时驻留"这条早就有更硬的一道闸 —— **本机同一时刻只允许一路在线**
 *      (启动另一路时服务端会把当前那一路停掉, 显存随之还回来), 所以默认关不该导致
 *      "单卡被两套模型撑爆";
 *   ② 反过来, 默认开是有真实代价的: 任务之间反复卸/载让"排队中的卡片"看着像卡住 ——
 *      这正是用户实测踩到的体验问题;
 *   ③ 16GB 显存 / 24GB 内存以下的机器仍然默认开(那才是真的装不下第二套模型的档位)。
 *
 * 开关本身留在界面上(配置与启动 · 画布「设置」), 用户随时可以自己开回来。
 */
export function defaultAutoFree(ramGB, vramGB) {
  const ram = Number(ramGB) || 0
  const vram = Number(vramGB) || 0
  // 读到 0 说明这台机器我们**量不出来**(没有 nvidia-smi / 没读到内存) → 保守: 当作吃紧
  if (ram <= 0 || vram <= 0) return true
  const tight = vram < 16 || ram < 24
  return tight
}

const TIER_RANK = { keep: 2, balanced: 1, aggressive: 0 }
const pct = (x) => `${Math.round((x || 0) * 100)}%`

/**
 * **测试模式**: 把本机"看成"一台小机器 (2026-09-20 用户要求)。
 *
 * 用途: 在 20GB/128GB 的开发机上复现低配用户的真实处境 ——
 *   显存 12GB、内存 32GB。所有策略(memPolicy 档位、panic 阈值、按需释放、
 *   是否让两路模型同时在线)与显存/内存展示都会按这个"假硬件"来算,
 *   后台进程再用等效的 --vram-headroom 把显存真正卡住(见 server.mjs memoryLaunchArgs)。
 *
 * 开关: 环境变量 AICS_TEST_LIMITS=1 (可选 AICS_TEST_VRAM_GB / AICS_TEST_RAM_GB 覆盖默认值)。
 *   **只在启动进程时生效** —— 不写进设置、不落盘, 关掉限制就是不带这个变量重启。
 */
export function testLimits() {
  const on = process.env.AICS_TEST_LIMITS === '1'
  if (!on) return { on: false, vramGB: 0, ramGB: 0 }
  const vramGB = Math.max(1, Number(process.env.AICS_TEST_VRAM_GB) || 12)
  const ramGB = Math.max(1, Number(process.env.AICS_TEST_RAM_GB) || 32)
  return { on: true, vramGB, ramGB }
}

/** 按"总容量"和两个门槛挑档位 */
function pickTier(gb, hiGb, loGb) {
  if (gb >= hiGb) return 'keep'
  if (gb >= loGb) return 'balanced'
  return 'aggressive'
}

/** 物理内存快照。pressure = 已用占比(0~1)。 */
export function systemMemory() {
  const total = os.totalmem()
  const free = os.freemem()
  let totalMB = Math.round(total / 1048576)
  let freeMB = Math.round(free / 1048576)
  // 测试模式: 假装只有 32GB(按"实际占用不变、总量变小"来算压力, 与真机一致)
  const tl = testLimits()
  if (tl.on) {
    totalMB = Math.min(totalMB, tl.ramGB * 1024)
    freeMB = Math.max(0, totalMB - Math.max(0, Math.round((total - free) / 1048576)))
  }
  return {
    totalMB, freeMB, usedMB: totalMB - freeMB,
    totalGB: Math.round(totalMB / 1024),
    pressure: totalMB > 0 ? (totalMB - freeMB) / totalMB : 0,
    ...(tl.on ? { testLimited: true } : {}),
  }
}

/**
 * 综合内存与显存选档位。
 * @param {object} mem  systemMemory() 的结果(不传则实时读)
 * @param {object} vram 实时显存快照 { totalMB, usedMB, freeMB, totalGB, pressure }(没有独显时传 null)
 */
export function memPolicy(mem, vram) {
  const m = mem || systemMemory()
  const v = vram && vram.totalMB > 0 ? vram : null

  // 内存: ≥32GB 不再限制(用户明确要求); 24~32GB 偏紧; <24GB 属"不符合最低要求"(sysreq 拦)
  const memTier = pickTier(m.totalGB, 32, 24)
  // 显存: ≥16GB 宽裕; 8~16GB 偏紧; <8GB 属"不符合最低要求"
  const vramTier = v ? pickTier(v.totalGB, 16, 8) : null

  // 取更紧张的那个 —— 显存不够就直接 OOM, 不能因为"内存很大"就放行
  let policy = memTier
  let policySource = 'mem'
  if (vramTier && TIER_RANK[vramTier] < TIER_RANK[memTier]) {
    policy = vramTier
    policySource = 'vram'
  }

  const panicAt = policy === 'keep' ? 0.90 : policy === 'balanced' ? 0.85 : 0.75
  const memPanic = m.pressure >= panicAt
  /**
   * 显存"紧急"判定 —— 2026-09-17 重写 (用户反馈"用 ComfyUI 生成很快, 用画布特别慢")。
   *
   * 旧逻辑: `vram.pressure >= panicAt(0.90)` 就算紧急 → 立刻卸模型。
   * 但 20GB 卡跑 17.9GB 的模型, 加载完**必然**是 90%+ 占用 —— 这是**正常工作状态**,
   * 不是压力。于是每次生成刚结束就被判"显存压力过高"、把模型卸掉; 下一次生成又要重新
   * 加载(几十秒)。用户体感就是"ComfyUI 里几秒钟出图, 画布里要等一分钟"。
   *
   * 新逻辑: 看**还剩多少显存**够不够保住桌面 —— 这正是"给桌面留显存"那条承诺的意思:
   *   · 知道剩余量时: 剩余 < 预留值(默认 0.8GB) 才算紧急;
   *   · 拿不到剩余量时(个别驱动): 退回按占用率, 但阈值抬到 0.97(几乎真没了)。
   * 这样"模型占着显存但桌面还有余量"就不会再触发卸载, 模型得以保留、下一次生成直接开跑。
   */
  const vramFloorMB = Number.isFinite(v?.freeMB) ? 800 : null
  const vramPanic = v
    ? (vramFloorMB !== null ? v.freeMB < vramFloorMB : v.pressure >= 0.97)
    : false
  const panic = memPanic || vramPanic
  const panicReason = panic ? (memPanic && vramPanic ? '内存与显存' : memPanic ? '内存' : '显存') : ''

  return {
    ...m,
    vram: v,
    policy,
    planText: PLAN_TEXT[policy],
    policySource,           // 'mem' | 'vram' —— 是哪一边决定了当前档位
    memTier,
    vramTier,
    panicAt,
    panic,
    panicReason,
    policyText: POLICY_TEXT[policy],
    summary:
      `内存 ${m.totalGB}GB（已用 ${pct(m.pressure)}）` +
      (v ? ` · 显存 ${v.totalGB}GB（已用 ${pct(v.pressure)}）` : ' · 未检测到独显信息') +
      ` → ${policy}（由${policySource === 'vram' ? '显存' : '内存'}决定）`,
  }
}

/**
 * 决定这次到底要不要真的释放。
 *
 * @param {string} kind     刚刚用完的后端
 * @param {'auto'|'cache'|'models'} level  auto = 走策略; 其它 = 手动, 照做
 * @param {string} nextKind 队列里下一个任务要用的后端('' = 队列空)
 * @param {object} p        memPolicy() 的结果(注入以便单测)
 * @param {boolean} autoFree 用户开关"自动清理内存"。false = **一律不自动释放**(开关是唯一权威;
 *   要启动另一路后端时的"让位"走 launchBackend, 不经过这里)
 */
export function decideRelease(kind, level, nextKind, p, autoFree = true) {
  if (level !== 'auto') return { doIt: true, level, reason: '手动释放' }
  const m = p || memPolicy()

  // ⓪ 用户关掉了"自动清理内存" → 什么都不卸(见下面的说明)。文案要说清"为什么没清"。
  const off = autoFree === false

  /**
   * ★ 2026-09-25 改动: 关掉开关就是**真的关掉** —— 连"压力兜底"也不卸。
   *
   * 用户原话: "这个功能是否应该留给客户……强行给我清掉后，出现了一直排队和排队中的卡片
   *   一直没办法生成的问题，这个是很影响体验的。"
   * 以前 off 只是"不主动卸", 压力一高仍然会卸(注释写着"不管开关") —— 结果就是用户明明关了,
   *   批量生成跑到一半模型还是被卸掉, 下一张要重新读十几 GB 权重, 卡片看起来就是"一直排队中"。
   * 现在: 开关 = 唯一权威。关掉后**只**在"要启动另一路后端、必须给它腾地方"时才会释放
   *   (那条走的是 launchBackend 里的让位逻辑, 不经过这里), 这两种语义分开之后, 用户能预期。
   */
  if (off) {
    return {
      doIt: false, policy: m.policy,
      reason: `「自动清理内存」已关闭：保留模型不释放（${m.summary.split(' → ')[0]}）。开启后会在任务结束时释放，但下次生成需要重新加载、会更慢`,
    }
  }

  // ① 紧急: 内存或显存任一超阈值 → 立刻卸, 不管什么档位(用户明确开着这个开关时才走这里)
  if (m.panic) {
    const vramPart = m.vram ? ` / 显存 ${pct(m.vram.pressure)}（可用 ${m.vram.freeMB}MB）` : ''
    return {
      doIt: true, level: 'models', policy: m.policy,
      reason: `${m.panicReason}压力过高：内存 ${pct(m.pressure)}（可用 ${m.freeMB}MB）${vramPart}，立即释放`,
    }
  }
  // ② 下一个任务换后端 → 当前模型一定用不上, 卸
  if (nextKind && nextKind !== kind) {
    return {
      doIt: true, level: 'models', policy: m.policy,
      reason: `下一个任务用「${BACKEND_LABEL[nextKind] ?? nextKind}」，${BACKEND_LABEL[kind] ?? kind} 的模型用不上了`,
    }
  }
  // ③ 下一个任务还是同一个后端 → **保留**。
  //    理由: 模型此刻已经在显存/内存里了, 保留它**不会再占新空间**;
  //    而卸掉它只换来"下一次生成要重新加载"(慢, 且可能因空间被别人占了而失败)。
  //    真正的危险(压力上去)已经在 ① 里被 panic 拦掉了 —— 所以这里不按档位一刀切,
  //    这正是"不影响用户体验"的关键。
  if (nextKind === kind) {
    return {
      doIt: false, policy: m.policy,
      reason: `${m.summary.split(' → ')[0]}，同类型任务继续，保留模型直接开始下一个`,
    }
  }
  /**
   * ④ 队列空了 → **一律先保留**, 交给"空闲自动卸载"那条路去收尾。
   *
   * ⚠️ 2026-09-18 改 (用户反馈"连着生成 4 张图片, 第 5 张就卡顿"):
   *   以前这里是"内存中等/较紧的机器, 队列一空就把模型卸掉"。可是用户的实际动作是**手点**:
   *   生成第 1 张 → 队列空 → 卸模型 → 第 2 张又要把 12.8GB 权重重新读一遍 —— 慢机器上这就是
   *   几十秒的"卡顿", 而他只觉得"怎么越用越卡"。用户是连着的, 队列却是"一空就卸"。
   *   现在: 空闲卸载交给 idleCheck(默认 10 分钟没动静才卸) —— 连续生成的那几分钟模型一直在,
   *   生成完真的走开了也会被自动清掉; 只有压力真的过高(①)才立刻卸。
   */
  return {
    doIt: false, policy: m.policy,
    reason: `${m.summary.split(' → ')[0]}，先保留模型（空闲超过设定时长会自动释放；压力过高时仍会立即卸）`,
  }
}

// (原 idleReleaseLevel 已删除: 空闲释放现在按"空闲时长"判定并直接卸模型,
//  见 server.mjs 的 idleCheck —— 硬件档位只决定保不保留, 不该决定"要不要腾显存")
