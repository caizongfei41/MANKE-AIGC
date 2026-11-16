// ============================================================
// 模型包指纹与「包坏了 / 机器坏了」判定（2026-10-30）
//
// 为什么单独成模块：
//   客户那台机器上 4 个模型包**体积全部与官方逐字节一致**，解压却全部 CRC Failed。
//   体积一致只能证明"长度对"，证明不了"内容对" —— 只有 SHA256 能把责任分开：
//     · SHA256 一致 → 包是好的，是这台机器读/解时算错了（内存 or CPU 不稳）
//     · SHA256 不一致 → 包在下载/拷贝过程中坏了，重拷一份
//   这套判定既要给**安装器**用（解压一报 CRC 就自动算），也要能**单独测**（selftest），
//   所以从 server.mjs 抽出来，两边 import 同一份。
//
// ⚠️ 新包发布时：这里的 KNOWN_PACK_SHA256、server.mjs 的 KNOWN_PACK_BYTES、
//   以及 tools/pack-health/pack-check.ps1 的 $KNOWN 三处一起补。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

/**
 * 官方包的 SHA256 —— 算的是 **.7z 文件本身**，不是解压后内容。
 * （已用 certutil 对 `7z h -scrcSHA256` 交叉验证：两者对同一个文件给出同一个值。）
 */
export const KNOWN_PACK_SHA256 = {
  '漫客_模型包_video_v1.2.0.7z': 'a16577a9b5e9768a9a9105b995cc821517c8c80c95ca2852399a6ab8d6ed798e',
  '漫客_模型包_video_v1.1.0.7z': '467140107e89a3a57cee3802d6938d1d702b28919b355aa399597e66b1e9ee9b',
  '漫客_模型包_image_v1.1.0.7z': 'a7eaff5b4fee64a4d9712c6f2ffe0f3986476c882dd598ea45a4a57ded753a3b',
  '漫客_模型包_qwen_v1.1.0.7z': 'bc1278e031698ae6ad5375d9e4d580bdf3b932089a9e4c646109234205d4a42c',
  '漫客_模型包_voice_v1.1.0.7z': '2396a902916cf9e0825819088b4c85039a15cd3785c12860f8ebf36b614d152c',
}

/** 流式算 SHA256（异步读，不阻塞事件循环；大包几十秒，只在失败时做） */
export function sha256OfFile(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const st = fs.createReadStream(file)
    st.on('data', (d) => h.update(d))
    st.on('end', () => { try { resolve(h.digest('hex')) } catch (e) { reject(e) } })
    st.on('error', reject)
  })
}

/**
 * 解压报 CRC 之后的一句话结论 —— 这是"包坏 / 机器坏"唯一的分界线。
 * @param {string} file 包文件路径
 * @param {string} [officialOverride] 覆盖官方值（测试用）
 * @returns {Promise<string>} 人话；不在对照表里或算不出来就返回空串（不瞎断言）
 */
export async function packShaVerdict(file, officialOverride) {
  const name = path.basename(String(file || ''))
  const official = officialOverride ?? KNOWN_PACK_SHA256[name]
  if (!official) return ''
  let got = ''
  try { got = await sha256OfFile(file) } catch { return '' }
  if (got === official) {
    return 'SHA256 与官方**一致** → 这份包内容是好的，问题在**这台机器**：解压时算错了'
      + '（内存或 CPU 不稳定；Intel 13/14 代 i7/i9 的已知问题就是解压大文件报 CRC）。'
      + '\n｜怎么办：① 跑 Windows 内存诊断（Win+R → mdsched.exe，重启后出结果）'
      + ' ② 进 BIOS 关掉 CPU 超频 / 内存 XMP，或把 BIOS 更新到含 0x12B 微码的版本'
      + ' ③ 把这个包拷到**另一台机器**解压同一个包验证'
  }
  return `SHA256 与官方**不一致**（这份 ${got.slice(0, 16)}… / 官方 ${official.slice(0, 16)}…）`
    + ' → 包在下载或拷贝过程中已经坏了（体积对得上，内容对不上）。'
    + '\n｜怎么办：重新拷一份，**不要断点续传**；拷完先用「模型包体检」核对 SHA256 再装'
}

/** 这个包名有没有官方指纹（没有就别断言"对不对"，只说算出来的值） */
export function hasKnownSha(name) {
  return !!KNOWN_PACK_SHA256[path.basename(String(name || ''))]
}
                    