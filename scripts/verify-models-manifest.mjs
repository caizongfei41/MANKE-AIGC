#!/usr/bin/env node
/**
 * 模型包清单与文档一致性校验（CI 用，不下载大文件）。
 *
 * 校验：
 *   1. models/models.manifest.json 结构与取值合法；
 *   2. docs/MODELS.md 表格与清单完全一致（名称 / 大小 / SHA-256）；
 *   3. README / MODELS.md 中仍包含网盘链接与口令。
 *
 * 用法：node scripts/verify-models-manifest.mjs
 * 退出码：0 通过，1 失败
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = path.join(root, 'models', 'models.manifest.json')
const docsPath = path.join(root, 'docs', 'MODELS.md')
const readmePath = path.join(root, 'README.md')

const errors = []
const notes = []

function fail(msg) {
  errors.push(msg)
}

function readText(file) {
  if (!fs.existsSync(file)) {
    fail(`缺少文件: ${path.relative(root, file)}`)
    return ''
  }
  return fs.readFileSync(file, 'utf8')
}

const manifestText = readText(manifestPath)
let manifest
try {
  manifest = JSON.parse(manifestText)
} catch (e) {
  fail(`models.manifest.json 不是合法 JSON: ${e.message}`)
}

const packs = []
if (manifest) {
  if (manifest.schemaVersion !== 1) fail('schemaVersion 必须为 1')
  if (!manifest.download?.quark || !manifest.download?.code) fail('download.quark / download.code 缺失')
  if (!Array.isArray(manifest.packs) || manifest.packs.length === 0) fail('packs 必须是非空数组')

  const names = new Set()
  const hashes = new Set()
  const tiers = new Set(['video', 'image', 'qwen', 'voice'])
  for (const [i, p] of (manifest.packs ?? []).entries()) {
    const at = `packs[${i}]`
    if (typeof p.name !== 'string' || !/^漫客_模型包_[a-z0-9]+_v\d+(\.\d+)*\.7z$/.test(p.name)) {
      fail(`${at}.name 不合法: ${p.name}`)
    }
    if (names.has(p.name)) fail(`重复的包名: ${p.name}`)
    names.add(p.name)

    if (!Number.isSafeInteger(p.sizeBytes) || p.sizeBytes <= 0) fail(`${at}.sizeBytes 不合法`)
    if (typeof p.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(p.sha256)) fail(`${at}.sha256 必须是小写 64 位 hex`)
    if (hashes.has(p.sha256)) fail(`重复的 SHA-256: ${p.sha256}`)
    hashes.add(p.sha256)

    if (!tiers.has(p.tier)) fail(`${at}.tier 不合法: ${p.tier}`)
    if (typeof p.required !== 'boolean') fail(`${at}.required 必须是布尔值`)
    packs.push(p)
  }
}

// 解析 docs/MODELS.md 的表格：| `name` | tier | size | `sha` |
const docs = readText(docsPath)
const docRows = new Map()
for (const line of docs.split(/\r?\n/)) {
  const m = line.match(/^\|\s*`([^`]+\.7z)`\s*\|\s*([^|]+?)\s*\|\s*([\d,]+)\s*\|\s*`([0-9a-f]{64})`\s*\|/)
  if (!m) continue
  const [, name, tierLabel, sizeRaw, sha] = m
  docRows.set(name, {
    tierLabel: tierLabel.trim(),
    sizeBytes: Number(sizeRaw.replace(/,/g, '')),
    sha256: sha,
  })
}

if (packs.length && docRows.size === 0) fail('docs/MODELS.md 未解析到模型包表格')

for (const p of packs) {
  const row = docRows.get(p.name)
  if (!row) {
    fail(`docs/MODELS.md 缺少记录: ${p.name}`)
    continue
  }
  if (row.sizeBytes !== p.sizeBytes) fail(`${p.name} 大小不一致: docs=${row.sizeBytes} manifest=${p.sizeBytes}`)
  if (row.sha256 !== p.sha256) fail(`${p.name} SHA-256 不一致`)
}
for (const name of docRows.keys()) {
  if (!packs.some((p) => p.name === name)) fail(`docs/MODELS.md 多出未登记条目: ${name}`)
}

// 网盘链接/口令必须同时出现在 README 与 MODELS.md
const readme = readText(readmePath)
if (manifest?.download) {
  for (const [label, text] of [['README.md', readme], ['docs/MODELS.md', docs]]) {
    if (!text.includes(manifest.download.quark)) fail(`${label} 缺少网盘链接`)
    if (!text.includes(manifest.download.code)) fail(`${label} 缺少网盘口令`)
  }
}

if (notes.length) notes.forEach((n) => console.log(`::notice::${n}`))

if (errors.length) {
  for (const e of errors) console.error(`::error::${e}`)
  const summary = [
    '## 模型包清单校验失败',
    '',
    ...errors.map((e) => `- ${e}`),
  ].join('\n')
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n')
  process.exit(1)
}

const summary = [
  '## 模型包清单校验通过',
  '',
  `- 清单：\`models/models.manifest.json\`（${packs.length} 个包）`,
  `- 文档：\`docs/MODELS.md\` 与清单一致`,
  `- 网盘链接与口令：README / MODELS.md 均存在`,
  '',
  '| 包 | 大小 | SHA-256 |',
  '|----|------|---------|',
  ...packs.map((p) => `| \`${p.name}\` | ${p.sizeBytes.toLocaleString('en-US')} | \`${p.sha256.slice(0, 16)}…\` |`),
].join('\n')
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n')
console.log(summary)
