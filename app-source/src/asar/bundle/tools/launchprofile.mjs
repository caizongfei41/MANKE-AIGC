// ============================================================
// 「固定内存(pinned memory)要不要关」—— 单一事实来源（2026-10-30）
//
// 背景（客户现场 · RTX 5070 Ti 16GB / 64GB 内存 / 驱动 617.42 / v2.10.31）：
//   H3 出片采样 6 步全跑完，卡在 **VAE 解码**，进程以 access violation 直接没了。
//   日志三行连击：
//     aimdo: xfer_file_read_at: GetOverlappedResult failed error=1450
//     aimdo: hostbuf_read_file_slice: file read failed handle=0x930 size=33554432
//     !!! Exception during processing !!! hostbuf_file_reader_read failed
//   同一个压缩包里还夹着一句 `DefaultCPUAllocator: not enough memory: 7372800 bytes`（7MB 都申请不到）。
//
//   error=1450 是 ERROR_NO_SYSTEM_RESOURCES —— **宿主侧**资源不足，不是显存、更不是驱动。
//
// 为什么会不足（看这一版 ComfyUI 的 comfy/model_management.py）：
//   MAX_PINNED_MEMORY = 内存 × 40%                 → 64GB 机器 = 26059MB
//        （客户日志原文：`[INFO] Enabled pinned memory 26059.0`）
//   pinned_hostbuf_size(size) = min(size, 上限) × 2 → H3 的 20GB 模型想要 40GB 宿主缓冲
//
//   固定内存是**不可换页**的。25.6GB 被钉住之后只剩 38.4GB，而这一版 H3 要暂存
//   （日志里的 Staged）≈ 40.5GB：模型 20 + 文本编码器 15 + VAE 5。
//   提交内存打满 → 连 7MB 都申请不到 → 异步读返回 1450 → 进程崩。
//
//   这也解释了客户那句"同款机型别的机器没这个错"：内存更大的机器
//   （比如 128GB → 固定上限 51.2GB，去掉后仍剩 76.8GB）就够用，64GB 刚好卡在边界上。
//   客户"自己起的 ComfyUI 不报"，是因为他自己那条启动命令没带 --vram-headroom，
//   走的是常规加载，不会把 40GB 全塞进宿主缓冲。
//
// 所以判据不能还是"显存 < 12GB 才关固定内存"（那是当初 8G 卡的结论）：
//   16GB 卡同样装不下这一版 H3 的 20GB 模型，一样要走宿主缓冲、一样会被固定内存挤死。
// 该问的是：**关掉固定内存之后剩下的内存，够不够装下这一路要暂存的 40GB 权重？**
//
// 社区里同一组报错的标准处置顺序也是：先 --disable-pinned-memory，
// 再谈 --fast-disk / --disable-mmap / 减小文本编码器。
// ============================================================

/** 这一版 H3 三件套的 Staged 总量（GB）：模型 20 + 文本编码器 15 + VAE 5，取自客户日志 */
export const H3_STAGED_GB = 40

/** 装得下 20GB 模型 + VAE/文本编码器余量的显存门槛（GB）；低于它必然走宿主缓冲 */
export const STREAM_VRAM_BELOW_GB = 24

/** 暂存之外还要留的余量（GB）：Electron 前端、Python、系统缓存都在这块里 */
export const STAGING_MARGIN_GB = 8

/**
 * @param {{ vramGB?: number, ramGB?: number }} m
 * @returns {{ pinned: boolean, pinnedTooBig: boolean, pinnedCapGB: number,
 *             ramLeftGB: number, stagedGB: number, mustStream: boolean, why: string }}
 *   pinned       —— 是否还开着固定内存（false 时启动参数要带 --disable-pinned-memory）
 *   pinnedTooBig —— 这次是不是被"装不下"这条新判据关掉的（用于诊断与界面说明）
 */
export function pinnedMemoryDecision(m = {}) {
  const vramGB = Number(m.vramGB) || 0
  const ramGB = Number(m.ramGB) || 0

  /** 与 ComfyUI 的 Windows 分支一致：MAX_PINNED_MEMORY = 内存 × 40% */
  const pinnedCapGB = ramGB > 0 ? ramGB * 0.4 : 0
  /** 固定内存钉住之后，留给暂存权重的内存 */
  const ramLeftGB = ramGB > 0 ? ramGB - pinnedCapGB : 0
  /** 显存装不下模型 → 必然走宿主缓冲（16GB 卡正是这一类） */
  const mustStream = vramGB > 0 && vramGB < STREAM_VRAM_BELOW_GB
  const pinnedTooBig = mustStream && ramGB > 0 && ramLeftGB < H3_STAGED_GB + STAGING_MARGIN_GB

  const why = pinnedTooBig
    ? `；显存 ${vramGB}GB 装不下 ${H3_STAGED_GB}GB 权重、固定内存又要再占 ${Math.round(pinnedCapGB)}GB，`
      + '已自动关闭固定内存（否则出片解码会报 hostbuf 回读失败 error=1450）'
    : ''

  return {
    pinned: !pinnedTooBig,
    pinnedTooBig,
    pinnedCapGB: Math.round(pinnedCapGB),
    ramLeftGB: Math.round(ramLeftGB),
    stagedGB: H3_STAGED_GB,
    mustStream,
    why,
  }
}
