// ============================================================
// 「装完模型包该自动重启哪几路」的判定 (2026-10-01)
//
// 背景 (用户: "用户重新安装模型包后, 默认就是去点生成, 但是会显示模型包没有安装或者缺失这种
//   误导, 优化一下…你找一个合适的方法"):
//   后端 (ComfyUI) 认得的权重清单是它**启动时扫一遍**的结果 —— 只解压不重启, 点生成照样回
//   `Value not in list: …safetensors`, 界面就成了"模型包没装 / 缺文件"。而用户装完的下一个
//   动作**必然是点生成**, 中间那次"手动去顶栏重启"从来不会发生。
//
// 所以由程序替他重启 —— 但"重启谁"必须是个**安全**的决定:
//   · 只认 BACKENDS 里登记过的 key(别的 key 一律忽略);
//   · 没在跑的不碰(它下次启动自然会扫到新权重, 白起一次浪费显存);
//   · 正在出图/加载的不碰(重启会作废当前任务), 只提示用户手动重启。
//
// 抽成纯函数是为了**能被钉进自测**(见 tools/selftest/hygiene.mjs 的 H253):
//   决策错了不是报错, 而是"悄悄把一个正在出图的任务干掉"或者"该重启的没重启", 很难事后发现。
// ============================================================

/**
 * @param {string[]} installedKeys 这次安装**真正归位**的组件 key (与 BACKENDS 同键)
 * @param {Record<string, {label?: string}>} backends 后端表
 * @param {Record<string, {running?: boolean, busy?: boolean}>} state 各路现况
 * @returns {{ restart: Array<{kind: string, label: string}>, skipIdle: string[], skipBusy: string[] }}
 *   restart  要重启的(按传入顺序去重)
 *   skipIdle 没在跑的(标签)
 *   skipBusy 正在出图、不能碰的(标签)
 */
export function planInstallRestart(installedKeys, backends, state = {}) {
  const restart = []
  const skipIdle = []
  const skipBusy = []
  for (const kind of [...new Set(installedKeys ?? [])]) {
    const b = backends?.[kind]
    if (!b) continue                       // 不是后端组件(例如只装了个别目录) → 忽略
    const st = state[kind] ?? {}
    if (!st.running) { skipIdle.push(b.label ?? kind); continue }
    if (st.busy) { skipBusy.push(b.label ?? kind); continue }
    restart.push({ kind, label: b.label ?? kind })
  }
  return { restart, skipIdle, skipBusy }
}
