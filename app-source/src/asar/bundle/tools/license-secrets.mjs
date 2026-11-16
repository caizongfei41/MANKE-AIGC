// ============================================================
// 授权/时间轴 HMAC 密钥（构建期每版随机）
//
// 122 P1-2：旧版把 CACHE_GUARD_SECRET / CLOCK_SECRET 硬编码在源码里，
// 泄漏一次就是"全版本万能钥匙"。现在 stage 会在 bundle/ 生成
// license-secrets.json；运行期优先读它，源码态没有文件则回退旧常量。
//
// ⚠️ 这个文件在 bundle/ 里（明文），定位是"限制泄漏影响面到当前版本"，
//    不是密码学意义上的秘密；真正防篡改仍靠 asar / 签名（见 122 边界）。
// ============================================================
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const LEGACY_CACHE_GUARD_SECRET = 'aics.machine.guard.v1.7f3a9c1e5b8d2046'
export const LEGACY_CLOCK_SECRET = 'aics.timeguard.v1.9d2f7c4b6a1e8035'

let cached

/** 读取 bundle/license-secrets.json；不存在/损坏就返回旧常量 */
export function licenseSecrets() {
  if (cached) return cached
  cached = {
    cacheGuard: LEGACY_CACHE_GUARD_SECRET,
    clock: LEGACY_CLOCK_SECRET,
    legacyCacheGuard: [LEGACY_CACHE_GUARD_SECRET],
    legacyClock: [LEGACY_CLOCK_SECRET],
  }
  try {
    const file = fileURLToPath(new URL('../license-secrets.json', import.meta.url))
    const j = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (j && typeof j.cacheGuard === 'string' && j.cacheGuard.length >= 16) cached.cacheGuard = j.cacheGuard
    if (j && typeof j.clock === 'string' && j.clock.length >= 16) cached.clock = j.clock
    if (Array.isArray(j?.legacy?.cacheGuard)) cached.legacyCacheGuard.push(...j.legacy.cacheGuard.filter((s) => typeof s === 'string'))
    if (Array.isArray(j?.legacy?.clock)) cached.legacyClock.push(...j.legacy.clock.filter((s) => typeof s === 'string'))
  } catch { /* 源码态/旧包：回退旧常量 */ }
  cached.legacyCacheGuard = [...new Set([cached.cacheGuard, ...cached.legacyCacheGuard, LEGACY_CACHE_GUARD_SECRET])]
  cached.legacyClock = [...new Set([cached.clock, ...cached.legacyClock, LEGACY_CLOCK_SECRET])]
  return cached
}
