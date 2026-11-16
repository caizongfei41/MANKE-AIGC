// ============================================================
// 网页版外部工具 (豆包 / DeepSeek) — 共用实现
//
// 被两处复用, 保证行为一致 (单一事实来源):
//   - server.mjs            → 独立运行 (启动工具\启动-Manke.bat) 时的 /api/webapps
//   - app/vite.config.ts    → vite dev 时的同名中间件
//
// 为什么不做 iframe 内嵌 (实测结论, 见 h3test/_embed_probe.py):
//   - DeepSeek: 响应头 `content-security-policy: frame-ancestors 'none'` **强制**,
//     iframe 被浏览器直接拦掉, 页面完全不加载 (实测报 "The request has been blocked")。
//   - 豆包: frame-ancestors 只出现在 `content-security-policy-report-only` 里 (只上报不拦),
//     iframe 确实能渲染、点登录也能弹出扫码; 但登录态是 HttpOnly + SameSite=None 的
//     第三方 cookie, 受 Chromium 第三方 cookie 限制影响, 会话不能保证留住。
//
// 所以采用最稳的形态: **独立浏览器窗口 + 项目内持久化 profile**
//   `--app=<url>`                      → 无地址栏窗口, 观感接近桌面客户端
//   `--user-data-dir=profiles/<目标>`  → cookie 落在项目目录, 首次扫码一次长期免登录,
//                                        且完全不碰用户自己浏览器的 profile
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** 可打开的网页版站点 */
export const WEBAPP_TARGETS = {
  doubao: {
    label: '豆包',
    url: 'https://www.doubao.com/chat/',
    desc: '字节豆包网页版 · 抖音 / 飞书 / 手机号扫码登录',
  },
  deepseek: {
    label: 'DeepSeek',
    url: 'https://chat.deepseek.com/',
    desc: 'DeepSeek 网页版 · 微信 / 手机号 / 邮箱登录',
  },
}

const PF = process.env['ProgramFiles'] || 'C:\\Program Files'
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
const LOCALAPPDATA = process.env['LOCALAPPDATA'] || ''

/** 浏览器内核候选: 优先 Edge, 其次 Chrome (覆盖 Windows 常见安装位置) */
export const BROWSER_CANDIDATES = [
  { name: 'Edge', exe: path.join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
  { name: 'Edge', exe: path.join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
  { name: 'Chrome', exe: path.join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe') },
  { name: 'Chrome', exe: path.join(PF86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
  { name: 'Chrome', exe: path.join(LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') },
]

/** 找到第一个存在的浏览器内核; 都没有则返回 null */
export function findBrowser() {
  for (const b of BROWSER_CANDIDATES) {
    try { if (b.exe && fs.existsSync(b.exe)) return b } catch { /* 路径非法则跳过 */ }
  }
  return null
}

/** 浏览器首次运行后才会生成 Default/ 子目录, 用它判断该站点是否已经进去过(即登录态可能已存在) */
export function isProfileReady(profileRoot, target) {
  try { return fs.existsSync(path.join(profileRoot, target, 'Default')) } catch { return false }
}

/** 站点列表 + 浏览器探测结果 + 各站点登录态是否已初始化 */
export function webAppState(profileRoot) {
  const browser = findBrowser()
  const apps = Object.entries(WEBAPP_TARGETS).map(([id, t]) => ({
    id,
    label: t.label,
    url: t.url,
    desc: t.desc,
    profileReady: isProfileReady(profileRoot, id),
  }))
  return {
    ok: true,
    browser: browser ? { name: browser.name, exe: browser.exe } : null,
    profileRoot,
    apps,
  }
}

/** 打开某站点的独立窗口 (首次会返回 first=true, 提示需要扫码) */
export function openWebApp(profileRoot, target) {
  const t = WEBAPP_TARGETS[target]
  if (!t) return { ok: false, msg: `未知站点: ${target}` }
  const browser = findBrowser()
  if (!browser) {
    return { ok: false, msg: '没找到 Edge / Chrome 浏览器', detail: '请先安装 Microsoft Edge 或 Google Chrome' }
  }
  const dir = path.join(profileRoot, target)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (e) {
    return { ok: false, msg: '无法创建 profile 目录', detail: String(e) }
  }
  const first = !isProfileReady(profileRoot, target)
  const args = [
    `--app=${t.url}`,
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1180,820',
  ]
  try {
    spawn(browser.exe, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref()
  } catch (e) {
    return { ok: false, msg: '启动浏览器失败', detail: String(e) }
  }
  return {
    ok: true,
    first,
    browser: browser.name,
    profileDir: dir,
    detail: first
      ? `已打开 ${t.label}。请在这个窗口里扫码登录一次, 之后会一直保持登录`
      : `已打开 ${t.label} 窗口`,
  }
}

/** 清除某站点的登录态 (删掉它的 profile 目录; 带路径护栏, 只允许删 profiles/<已知站点>) */
export function resetWebApp(profileRoot, target) {
  const t = WEBAPP_TARGETS[target]
  if (!t) return { ok: false, msg: `未知站点: ${target}` }
  const dir = path.resolve(profileRoot, target)
  const guard = path.resolve(profileRoot) + path.sep
  if (!dir.startsWith(guard)) {
    return { ok: false, msg: '拒绝删除: 目标不在 profiles 目录内', detail: dir }
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return { ok: true, detail: `已清除 ${t.label} 的登录态, 下次打开需要重新扫码` }
  } catch (e) {
    return { ok: false, msg: '清除失败', detail: String(e) }
  }
}
   