#!/usr/bin/env node
// 上游"免费模型目录"契约哨兵（每日 CI 跑；不需要任何 key）。
//
// 为什么：GATE 的免费车道靠两个公开模型列表做自动发现，**列表形状变了不会报错**，只会静默
// 变成"没有免费候选 → 全走付费"。这里把"形状 + 免费项数量"钉住，漂移就红 + 开 issue。
//
//   node scripts/check-upstream-models.mjs
//
// 退出码：0 = 形状与数量都正常；1 = 漂移（带证据输出）。
const TIMEOUT_MS = 15_000
const MIN_FREE = 3

const opencodeFree = (id) => id !== 'deepseek-v4-flash-free' && (id.endsWith('-free') || id === 'big-pickle')
const openrouterFree = (id) => id.endsWith(':free')

async function fetchModels(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  const doc = await res.json()
  const list = Array.isArray(doc?.data) ? doc.data : Array.isArray(doc?.models) ? doc.models : null
  if (!list) throw new Error(`${url} → 响应里没有 data/models 数组（形状变了）`)
  const ids = list.map((m) => (typeof m === 'string' ? m : m?.id)).filter((x) => typeof x === 'string' && x.length > 0)
  if (ids.length < 10) throw new Error(`${url} → 只有 ${ids.length} 个模型（形状可疑）`)
  return ids
}

const checks = [
  { name: 'opencode zen', url: 'https://opencode.ai/zen/v1/models', filter: opencodeFree },
  { name: 'openrouter', url: 'https://openrouter.ai/api/v1/models', filter: openrouterFree },
]

let failed = 0
for (const c of checks) {
  try {
    const ids = await fetchModels(c.url)
    const free = ids.filter(c.filter)
    if (free.length < MIN_FREE) {
      failed += 1
      console.error(`FAIL ${c.name}：免费模型只有 ${free.length} 个（要求 ≥${MIN_FREE}）`)
      console.error(`  样本：${ids.slice(0, 10).join(', ')}`)
      continue
    }
    console.log(`PASS ${c.name}：${ids.length} 个模型，其中免费 ${free.length} 个（例：${free.slice(0, 4).join(', ')}）`)
  } catch (err) {
    failed += 1
    console.error(`FAIL ${c.name}：${String(err?.message ?? err).slice(0, 300)}`)
  }
}

if (failed) {
  console.error(`\n上游目录契约漂移 ${failed} 项 —— 免费车道的自动发现可能失效，检查 GATE 的 sources/filter。`)
  process.exit(1)
}
console.log('\n上游目录契约正常')
