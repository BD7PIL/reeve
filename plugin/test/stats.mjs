// 性能统计（GATE 台账聚合 + 编排台账）的验证：纯函数全测；IO（台账尾读 / 模型目录）用注入与真文件测。
//   node plugin/test/stats.mjs

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  aggregateGateRows, aggregateLedger, buildStats,fetchGateFree, fetchGateModels, fetchGateVersion, mergeModelCandidates,modelRef, parseGateRow,parseTs, percentile, 
  readLedgerTail, 
  STATS_DEFAULTS, summarizeLatency, 
} from '../src/stats.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- 1. 百分位与延迟汇总 ----
{
  assert.equal(percentile([], 0.5), null)
  assert.equal(percentile([10], 0.95), 10)
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3, '最近秩：5 个取第 3 个')
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10)
  assert.equal(percentile([3, 1, 2], 0.5), 2, '输入不用先排序')
  assert.equal(percentile([1, null, undefined, NaN, 2], 0.5), 1, '非数字丢掉（只剩 2 个 → 中位取第 1 个）')

  const s = summarizeLatency([1004.4, 2000.6, 300.2])
  assert.deepEqual(s, { n: 3, avg: 1102, p50: 1004, p95: 2001, max: 2001 }, '四舍五入到毫秒')
  assert.deepEqual(summarizeLatency([]), { n: 0, avg: null, p50: null, p95: null, max: null })
  assert.equal(STATS_DEFAULTS.intervalMs, 60_000)
  ok('百分位 / 延迟汇总 / 默认值')
}

// ---- 2. 台账行：解析与引用 ----
{
  assert.equal(parseTs('2026-10-22T01:00:00.000Z'), Date.parse('2026-10-22T01:00:00.000Z'))
  assert.equal(parseTs('不是时间'), null)
  const row = { provider: 'zhipuai-coding-plan', model: 'glm-5.3-flash' }
  assert.equal(modelRef(row), 'zhipuai-coding-plan/glm-5.3-flash')
  assert.equal(modelRef({ provider: 'x' }), null)
  assert.deepEqual(parseGateRow('{"a":1}'), { a: 1 })
  assert.equal(parseGateRow('{半截'), null, '坏行丢，不猜')
  assert.equal(parseGateRow(''), null)
  ok('台账行：时间戳 / 模型引用 / 坏行丢弃')
}

// ---- 3. 聚合：请求级与尝试级 ----
{
  const now = Date.parse('2026-10-22T02:00:00.000Z')
  const mk = (o) => ({ ts: new Date(now - 1000).toISOString(), chain: 'free-first', provider: 'p1', model: 'm1', lane: 'native', key: null, latency_ms: 100, retries: 0, detail: null, ...o })
  const rows = [
    // 请求 1：第一次失败（429）→ 第二次成功（换 provider）
    mk({ req: 1, n: 1, status: 'error', code: 429, latency_ms: 40, detail: 'status:429' }),
    mk({ req: 1, n: 2, provider: 'p2', model: 'm2', status: 'ok', code: 200, latency_ms: 60 }),
    // 请求 2：一次成功
    mk({ req: 2, n: 1, agent: 'scout', status: 'ok', code: 200, latency_ms: 30 }),
    // 请求 3：两次都失败（链耗尽）
    mk({ req: 3, n: 1, status: 'error', code: 500, latency_ms: 20, detail: 'status:500' }),
    mk({ req: 3, n: 2, provider: 'p2', model: 'm2', status: 'error', code: null, latency_ms: 25, detail: 'network' }),
    // 旧行没有 req（按"每行一次调用"算）
    mk({ status: 'ok', code: 200, latency_ms: 10 }),
    // 窗口外的行（不进统计）
    mk({ req: 9, n: 1, status: 'ok', code: 200, ts: new Date(now - STATS_DEFAULTS.windowMs - 60_000).toISOString() }),
  ]
  const agg = aggregateGateRows(rows, { now, windowMs: STATS_DEFAULTS.windowMs })
  assert.equal(agg.used, 6, '窗口外的 1 行被排除')
  assert.equal(agg.attempts, 6)
  assert.equal(agg.requests, 4, 'req=1/2/3 + 一条无 req 的旧行')
  assert.equal(agg.attemptsOk, 3)
  assert.equal(agg.attemptsError, 3)
  assert.equal(agg.requestsOk, 3, 'req1 末次成功、req2 成功、无 req 旧行本身成功')
  assert.equal(agg.requestsError, 1, '只有 req3 末次失败')
  assert.equal(agg.fallback.requests, 2, 'req1 与 req3 有换候选')
  assert.equal(agg.fallback.hops, 2, '各 1 跳')
  assert.deepEqual(agg.fallback.byIndex, { 1: 4, 2: 2 })
  assert.equal(agg.byChain.length, 1, '同一 chain 聚成一行')
  assert.equal(agg.byChain[0].chain, 'free-first')
  assert.equal(agg.byChain[0].agent, 'scout', 'agent 取链上第一次见到的非空值')
  assert.deepEqual(agg.byChain[0].providers.map((p) => p.ref), ['p1/m1', 'p2/m2'])
  assert.equal(agg.byModel[0].ref, 'p1/m1')
  assert.equal(agg.attemptLatency.n, 6)
  assert.equal(agg.requestLatency.n, 4, '一次调用一条总耗时')
  assert.equal(agg.requestLatency.max, 100, 'req1 = 40+60')
  assert.equal(agg.window.relaxed, false)
  ok('聚合：请求/尝试两级口径、fallback 跳数、按链/供应商/模型')
}

// ---- 4. 聚合：空与"窗口外兜底" ----
{
  const now = Date.now()
  const empty = aggregateGateRows([], { now })
  assert.equal(empty.used, 0)
  assert.deepEqual(empty.fallback.byIndex, {})
  assert.equal(empty.byChain.length, 0)
  const old = aggregateGateRows([{ ts: new Date(now - STATS_DEFAULTS.windowMs - 1000).toISOString(), chain: 'c', provider: 'p', model: 'm', status: 'ok', latency_ms: 5, req: 1, n: 1 }], { now })
  assert.equal(old.used, 1)
  assert.equal(old.window.relaxed, true, '窗口内没有行 → 用读到的行并如实标 relaxed')
  ok('聚合：空输入 / 窗口兜底（relaxed）')
}

// ---- 5. 编排台账聚合（原样保留的行为） ----
{
  const agg = aggregateLedger(
    [
      { agent: 'executor', state: 'completed', startedAt: 1000, endedAt: 1500 },
      { agent: 'executor', state: 'error', startedAt: 2000, endedAt: 2100, timedOut: true },
      { agent: 'scout', state: 'running', startedAt: 3000, statusUncertain: true },
    ],
    { now: 5000 },
  )
  assert.equal(agg.totals.n, 3)
  assert.equal(agg.totals.ok, 1)
  assert.equal(agg.totals.error, 1)
  assert.equal(agg.totals.running, 1)
  assert.equal(agg.totals.timedOut, 1)
  assert.equal(agg.totals.uncertain, 1)
  assert.equal(agg.byAgent.find((a) => a.agent === 'executor').latency.max, 500)
  ok('编排台账：状态计数 / 时长 / 超时与不确定')
}

// ---- 6. readLedgerTail：真文件尾读（含半行与坏行） ----
{
  const dir = await mkdtemp(join(tmpdir(), 'reeve-stats-'))
  try {
    const p = join(dir, 'gate.jsonl')
    const lines = []
    for (let i = 1; i <= 10; i++) lines.push(JSON.stringify({ req: i, n: 1, chain: 'c', provider: 'p', model: 'm', status: 'ok', latency_ms: i }))
    lines.push('{坏的半行')
    await writeFile(p, `${lines.join('\n')}\n`, 'utf8')
    const tail = await readLedgerTail({ path: p, limit: 3 })
    assert.equal(tail.error, null)
    assert.equal(tail.rows.length, 3, '只取尾部 limit 行')
    assert.deepEqual(tail.rows.map((r) => r.req), [8, 9, 10])
    const all = await readLedgerTail({ path: p, limit: 100 })
    assert.equal(all.rows.length, 10, '坏行被丢掉，不炸')
    const small = await readLedgerTail({ path: p, limit: 100, tailBytes: 200 })
    assert.equal(small.truncated, true, '只读尾部字节时标记 truncated')
    assert.ok(small.rows.length >= 1 && small.rows.length < 10, '截断后行数变少但仍能解析')
    const missing = await readLedgerTail({ path: join(dir, 'nope.jsonl') })
    assert.equal(missing.rows.length, 0)
    assert.ok(missing.error, '文件不存在 → 如实报错，不抛')
    ok('readLedgerTail：尾读 / 半行与坏行 / 截断标记 / 缺文件')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---- 7. fetchGateModels：形状与降级 ----
{
  const fetchOk = async () => ({ status: 200, json: async () => ({ object: 'list', data: [
    { id: '9router/oc/mimo-v2.6-flash-free', owned_by: '9router' },
    { id: 'free-first', owned_by: 'reeve' },
    { id: 'zhipuai-coding-plan/glm-5.3', owned_by: 'zhipuai-coding-plan' },
    { id: '裸名', owned_by: 'x' },
  ] }) })
  const r = await fetchGateModels({ port: 1, fetchImpl: fetchOk })
  assert.equal(r.error, null)
  assert.deepEqual(r.chains, ['free-first'], 'chain 名单独归到 chains')
  assert.deepEqual(r.models.map((m) => m.ref), ['9router/oc/mimo-v2.6-flash-free', 'zhipuai-coding-plan/glm-5.3'], '裸名丢掉')
  const bad = await fetchGateModels({ port: 1, fetchImpl: async () => ({ status: 503, json: async () => ({}) }) })
  assert.equal(bad.models.length, 0)
  assert.equal(bad.error, 'HTTP 503')
  const boom = await fetchGateModels({ port: 1, fetchImpl: async () => { throw new Error('boom') } })
  assert.equal(boom.error, 'boom')
  ok('fetchGateModels：目录 + 链名分离 / 坏状态与异常降级')
}

// ---- 7b. fetchGateFree：运行态透传与降级 ----
{
  const doc = { enabled: true, max: 3, cap: 3, providers: [{ id: 'opencode', ready: true, models: 2 }], expand: ['opencode/x-free'], cooling: [] }
  const good = await fetchGateFree({ port: 1, fetchImpl: async () => ({ status: 200, json: async () => doc }) })
  assert.equal(good.error, null)
  assert.deepEqual(good.expand, ['opencode/x-free'])
  const bad = await fetchGateFree({ port: 1, fetchImpl: async () => ({ status: 502, json: async () => ({}) }) })
  assert.equal(bad.error, 'HTTP 502')
  const empty = await fetchGateFree({ port: 1, fetchImpl: async () => ({ status: 200, json: async () => null }) })
  assert.equal(empty.error, '空响应')
  const boom = await fetchGateFree({ port: 1, fetchImpl: async () => { throw new Error('boom') } })
  assert.equal(boom.error, 'boom')
  ok('fetchGateFree：运行态透传 / HTTP 错 / 空响应 / 异常全部降级')
}

// ---- 7c. fetchGateVersion：运行态透传与降级 ----
{
  const good = await fetchGateVersion({ port: 1, fetchImpl: async () => ({ status: 200, json: async () => ({ name: 'reeve-gate', port: 18080 }) }) })
  assert.equal(good.error, null)
  assert.equal(good.doc.name, 'reeve-gate')
  const bad = await fetchGateVersion({ port: 1, fetchImpl: async () => ({ status: 503, json: async () => ({}) }) })
  assert.equal(bad.doc, null)
  assert.equal(bad.error, 'HTTP 503')
  const empty = await fetchGateVersion({ port: 1, fetchImpl: async () => ({ status: 200, json: async () => null }) })
  assert.equal(empty.doc, null)
  const boom = await fetchGateVersion({ port: 1, fetchImpl: async () => { throw new Error('boom') } })
  assert.equal(boom.error, 'boom')
  ok('fetchGateVersion：运行态 / HTTP 错 / 空 / 异常全部不抛')
}

// ---- 8. 候选合并 ----
{
  const out = mergeModelCandidates({
    discovered: [{ ref: 'a/m', context: 4096 }],
    chained: ['a/m', 'b/m', 'c/', 'no-slash'],
    engine: ['reeve/flash'],
  })
  assert.deepEqual(out.map((m) => m.ref), ['a/m', 'b/m', 'reeve/flash'])
  assert.deepEqual(out[0].sources, ['gate', 'chain'], '同一引用记多来源')
  assert.equal(out[0].context, 4096)
  ok('候选合并：去重 / 多来源 / 丢无斜杠与半引用')
}

// ---- 9. buildStats 形状 ----
{
  const s = buildStats({ gate: { used: 1 }, orchestrate: { totals: { n: 1 } }, now: 5, source: 'gate.ledger', checkedAt: 6 })
  assert.equal(s.source, 'gate.ledger')
  assert.equal(s.generatedAt, 5)
  assert.equal(s.checkedAt, 6)
  assert.equal(s.gate.used, 1)
  assert.equal(s.orchestrate.totals.n, 1)
  assert.equal(buildStats().source, 'unavailable')
  ok('buildStats：三态来源与字段')
}

console.log(`\n统计测试：${passed} 项全过`)