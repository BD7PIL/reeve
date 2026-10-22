#!/usr/bin/env node
/**
 * 覆盖率硬门槛（reeve 仓）：读 `plugin/coverage/coverage-summary.json`
 * （`npm --prefix plugin run test:coverage` 的 c8 产物），与
 * `scripts/coverage-baseline.json` 逐指标比较，任一低于基线即 exit 1。
 *
 * 基线语义：**只升不降**。发现覆盖变高了不要改基线——那一次提升要连同改进
 * （新测试）一起提交；这里的数字是下限，不是目标。
 *
 * 比较用整数百分点（向下取整），v8 的千分位抖动不应红 CI。
 * 与 ocrc 的同名脚本同一套规则（那边用 vitest/v8，这边用 c8 包 node 自跑）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const summaryPath = join(root, 'plugin', 'coverage', 'coverage-summary.json')
const baselinePath = join(root, 'scripts', 'coverage-baseline.json')

function pct(entry) {
  // json-summary 每个文件给 {covered, total}，pct 由我们算（避免依赖字段命名差异）。
  if (!entry || typeof entry.total !== 'number' || entry.total === 0) return 100
  return Math.floor((entry.covered / entry.total) * 100)
}

const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))

const failures = []

// 1) 全局三项（对 total 键）。
const total = summary.total ?? {}
for (const metric of ['statements', 'branches', 'functions']) {
  const floor = (baseline.global ?? {})[metric]
  if (floor === undefined) continue
  const entry = total[metric]
  if (!entry) { failures.push(`global ${metric}: summary 缺指标`); continue }
  const got = pct(entry)
  if (got < floor) failures.push(`global ${metric}: ${got}% < 基线 ${floor}%`)
}

// 2) 重点路径：键相对 `plugin/`（如 `src/index.js`），以 `/` 结尾 = 目录聚合并计。
const byNorm = new Map(Object.keys(summary).filter((k) => k !== 'total').map((k) => [k.replaceAll('\\', '/'), k]))
for (const [want, floors] of Object.entries(baseline.paths ?? {})) {
  const suffix = `plugin/${want}`
  const isDir = want.endsWith('/')
  const matches = [...byNorm.keys()].filter((k) => (isDir ? k.includes(`/${suffix}`) : k === suffix || k.endsWith(`/${suffix}`)))
  if (matches.length === 0) { failures.push(`重点路径 ${want}: summary 里找不到`); continue }

  let entry
  if (isDir) {
    entry = {}
    for (const metric of ['statements', 'branches', 'functions']) {
      entry[metric] = { covered: 0, total: 0 }
      for (const k of matches) { entry[metric].covered += summary[byNorm.get(k)][metric].covered; entry[metric].total += summary[byNorm.get(k)][metric].total }
    }
  } else {
    entry = summary[byNorm.get(matches[0])]
  }

  for (const metric of ['statements', 'branches', 'functions']) {
    const floor = floors[metric]
    if (floor === undefined) continue
    const e = entry[metric]
    if (!e) { failures.push(`${want} ${metric}: summary 缺指标`); continue }
    const got = pct(e)
    if (got < floor) failures.push(`${want} ${metric}: ${got}% < 基线 ${floor}%`)
  }
}

if (failures.length > 0) {
  console.error('覆盖率低于基线（只升不降；提基线请连同新测试一起提交）：')
  for (const f of failures) console.error(`  - ${f}`)
  console.error('基线文件：scripts/coverage-baseline.json')
  process.exit(1)
}
console.log(`覆盖率达标（global ${(baseline.global ?? {}).statements}/${(baseline.global ?? {}).branches}/${(baseline.global ?? {}).functions} + ${Object.keys(baseline.paths ?? {}).length} 条重点路径）`)