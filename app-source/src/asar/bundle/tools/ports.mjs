// ============================================================
// Windows 保留（排除）TCP 端口段 —— 落在里面的端口**任何程序都绑不上**。
//
// 为什么要单独一个模块 + 单独自测 (2026-10-12):
//   真机复现到一类"根本不是残留进程"的"端口占用"：`netsh int ipv4 show excludedportrange protocol=tcp`
//   显示系统保留段 8179-8278, 而四个后端端口 8188/8189/8190/8191 **正好全在里面** ——
//   python 起不来, 日志是 `PermissionError: [Errno 13] winerror 10013 ... bind on ('127.0.0.1', 8188)`。
//   界面上却只会说"启动后退出/端口被占", 用户按"清残留"折腾半天也没用(这就是"很严重"的那条)。
//   所以: 起进程**之前**先查一眼, 属这种情况直说 + 给出两条真出路(见 server.mjs 的 launchBackend)。
// ============================================================

/**
 * 解析 `netsh int ipv4 show excludedportrange protocol=tcp` 的输出。
 *   只认"两个数字一行"的表格行; 中文/乱码行一律忽略(命令是系统命令, 输出可能是 GBK)。
 *   ⚠️ **带 `*` 的那几行不算**: 它们标的是 "Administered port exclusions"(管理员手工加的白名单),
 *     那种保留**恰恰是为了让我们的程序能绑上**(社区治 WSL 抢 8188 的那套命令加的就是它) ——
 *     把它也算成"绑不上"会对做过修复的机器误判。
 * @returns {Array<{start:number,end:number}>}
 */
export function parseExcludedPortRanges(text) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*(\d{1,5})\s+(\d{1,5})\s*$/.exec(line)
    if (!m) continue
    const start = Number(m[1])
    const end = Number(m[2])
    if (start > 0 && end >= start && end <= 65535) out.push({ start, end })
  }
  return out
}

/** 这个端口落在哪个保留段里(没有 → null)。`ranges` 传 parseExcludedPortRanges 的结果。 */
export function rangeForPort(ranges, port) {
  const p = Number(port)
  if (!p || !Array.isArray(ranges)) return null
  return ranges.find((r) => p >= r.start && p <= r.end) ?? null
}

/**
 * 自动搬迁时从哪个端口开始找。
 *
 * 为什么是 8970 这一族: 四路默认端口是 8188-8191, 而 WinNAT/Hyper-V/WSL 的动态保留段
 *   常年在 8xxx 那一片来回划(本机就是 8179-8278)。往上挪到 8970 以后落在同一片的风险小得多,
 *   而且四个端口仍然**挨着**(8970/8971/8972/8973), 出问题时看一眼日志就能对上号。
 *   ⚠️ 这里只是"从哪儿开始找", 不是"一定用这个" —— 真用哪个由 pickRelocatedPort 逐个数着试。
 */
export const RELOCATE_PORT_START = 8970

/**
 * 给"默认端口被系统保留、绑不上"的那一路列出**候选替代端口**(按优先级从前往后)。
 *
 * 为什么返回一串而不是"直接返回一个": 判断"这个端口现在有没有人在听"要做一次 TCP 连接(异步,
 *   最多 300ms), 而真正要用的往往就是第一个候选 —— 所以这里只做**纯**筛选, 由调用方按顺序探,
 *   探到第一个空着的就用。这样这段决策逻辑能脱离系统环境自测(见 tools/selftest/ports-reserved.mjs)。
 *
 * 筛掉两类(都是硬条件):
 *   ① 落在保留段里(`ranges`) —— 那种端口任何程序都绑不上, 试都不用试;
 *   ② 已经在 `taken` 里 —— 四路之间不许撞车, 也不许占应用自己的端口。
 *
 * @param {object} [o]
 * @param {number[]} [o.taken]   已经定下来的端口(含应用自己的端口)
 * @param {Array<{start:number,end:number}>} [o.ranges]  保留段
 * @param {number} [o.start]     从哪个端口开始列
 * @param {number} [o.tries]     最多列多少个
 * @returns {number[]} 候选端口(可能为空 → 调用方走"只能给用户实话"那条老路)
 */
export function relocatePortCandidates({
  taken = [], ranges = [],
  start = RELOCATE_PORT_START, tries = 200,
} = {}) {
  const used = new Set((Array.isArray(taken) ? taken : []).map(Number))
  const from = Number(start) || RELOCATE_PORT_START
  const limit = Math.max(1, Number(tries) || 200)
  const out = []
  for (let p = from; p <= 65535 && p < from + limit; p += 1) {
    if (used.has(p)) continue
    if (rangeForPort(ranges, p)) continue
    out.push(p)
  }
  return out
}
