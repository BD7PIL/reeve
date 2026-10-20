// 性能统计（Bifrost 归因 + 台账聚合）的验证：纯函数全测；HTTP 取数用注入的 fetch 测形状与降级。
//   node plugin/test/stats.mjs

import assert from 'node:assert/strict'

import {
  STATS_DEFAULTS, percentile, summarizeLatency, tierOfRuleName, normalizeLogRow, parseTs,
  aggregateBifrostRows, aggregateLedger, buildStats,
  fetchBifrostLogs, fetchBifrostModels, mergeModelCandidates,
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
  assert.equal(STATS_DEFAULTS.limit, 100)
  assert.equal(STATS_DEFAULTS.windowMs, 24 * 3600 * 1000)
  assert.equal(STATS_DEFAULTS.modelsIntervalMs, 30 * 60 * 1000, '模型目录别跟统计同频（探测会污染日志）')
  ok('percentile / summarizeLatency / 默认值')
}

// ---- 2. 档位名与行裁剪（内容一律不进快照） ----
{
  assert.equal(tierOfRuleName('reeve/pro'), 'pro')
  assert.equal(tierOfRuleName('reeve/multimodal'), 'multimodal')
  assert.equal(tierOfRuleName('reeve-flash'), null, 'id 形态不算（认的是 name）')
  assert.equal(tierOfRuleName('别的规则'), null)
  assert.equal(tierOfRuleName(null), null)

  const row = {
    id: 'r1', timestamp: '2026-10-19T18:27:05.640162901Z', provider: 'zhipuai-coding-plan', model: 'glm-5.3',
    routing_rule_name: 'reeve/pro', fallback_index: 0, status: 'success', latency: 6728.807349,
    content_summary: '这是完整提示词内容，绝不该进快照', input_history: 'x', raw_request: 'y', output_message: 'z',
    selected_key_name: 'zhipuai-primary', prompt_tokens: 10, completion_tokens: 2, total_tokens: 12,
  }
  const n = normalizeLogRow(row)
  assert.ok(!('content_summary' in n) && !('input_history' in n) && !('raw_request' in n) && !('output_message' in n), '内容字段一个都不留')
  assert.equal(n.id, 'r1')
  assert.equal(n.routing_rule_name, 'reeve/pro')
  assert.equal(n.latency, 6728.807349)
  assert.equal(n.total_tokens, 12)
  assert.equal(parseTs('2026-10-19T18:27:05.640162901Z') != null, true)
  assert.equal(parseTs('not a time'), null)
  ok('tierOfRuleName / normalizeLogRow（丢内容留计数）')
}

// ---- 3. Bifrost 行聚合：档位 × provider × 回退 × 延迟 ----
{
  const now = Date.parse('2026-10-19T19:00:00Z')
  const rows = [
    // 最新两行在窗口内：flash 跳到第 1 跳成功、pro 直连成功
    { id: 'a', timestamp: '2026-10-19T18:55:00Z', provider: 'zhipuai-coding-plan', model: 'glm-5.3-flash', routing_rule_name: 'reeve/flash', fallback_index: 1, status: 'success', latency: 5000, content_summary: 'x' },
    { id: 'b', timestamp: '2026-10-19T18:50:00Z', provider: 'zhipuai-coding-plan', model: 'glm-5.3', routing_rule_name: 'reeve/pro', fallback_index: 0, status: 'success', latency: 7000 },
    { id: 'c', timestamp: '2026-10-19T18:40:00Z', provider: 'xiaomi', model: 'mimo-v2.6-flash', routing_rule_name: 'reeve/flash', fallback_index: 0, status: 'success', latency: 900 },
    { id: 'd', timestamp: '2026-10-19T18:30:00Z', provider: 'opencode', model: 'mimo-v2.6-flash-free', routing_rule_name: 'reeve/flash', fallback_index: 0, status: 'error', latency: 2, error_details: 'no_key_supports_model' },
    { id: 'e', timestamp: '2026-10-19T18:20:00Z', provider: 'acme', model: 'm', routing_rule_name: null, fallback_index: 0, status: 'success', latency: 100 },
    // 模型发现探测：Bifrost 去上游探 /v1/models 会记这种行（model 为空）—— 必须排除，否则"调用次数"被灌爆
    { id: 'probe', timestamp: '2026-10-19T18:57:00Z', provider: 'opencode', model: '', routing_rule_name: null, fallback_index: 0, status: 'success', latency: 3 },
    // 客户端把流掐了：三态里的 cancelled，不算失败
    { id: 'cancel', timestamp: '2026-10-19T18:56:00Z', provider: 'lmuai', model: 'glm-5.3', routing_rule_name: 'reeve/pro', fallback_index: 1, status: 'cancelled', latency: 400 },
    { id: 'old', timestamp: '2026-10-10T00:00:00Z', provider: 'xiaomi', model: 'old', routing_rule_name: 'reeve/pro', fallback_index: 0, status: 'success', latency: 99999 },
  ]
  const agg = aggregateBifrostRows(rows, { now, windowMs: 3600_000 })
  assert.equal(agg.fetched, 8)
  assert.equal(agg.probes, 1, '模型发现探测要单独计数（面板会说明"已排除 N 行探测"）')
  assert.equal(agg.used, 6, '窗口外的 old 不参与统计；探测行不进调用统计')
  assert.equal(agg.total, 6)
  assert.equal(agg.ok, 4)
  assert.equal(agg.error, 1)
  assert.equal(agg.cancelled, 1, 'cancelled 单独算，别混进失败')
  assert.equal(agg.window.relaxed, false)
  assert.equal(agg.fallback.requests, 2, 'a 与 cancel 走了回退')
  assert.equal(agg.fallback.hops, 2)
  assert.deepEqual(agg.fallback.byIndex, { 0: 4, 1: 2 })

  const flash = agg.byTier.find((t) => t.tier === 'flash')
  assert.equal(flash.n, 3)
  assert.equal(flash.ok, 2)
  assert.equal(flash.error, 1)
  assert.equal(flash.fallbackRequests, 1)
  assert.equal(flash.rule, 'reeve/flash')
  assert.equal(flash.latency.n, 3)
  assert.equal(flash.latency.max, 5000)
  const pro = agg.byTier.find((t) => t.tier === 'pro')
  assert.equal(pro.n, 2, 'pro 档：b 成功 + cancel 取消')
  assert.equal(pro.cancelled, 1)
  assert.equal(pro.fallbackRequests, 1)
  assert.deepEqual(
    flash.providers.map((p) => p.ref).sort(),
    ['opencode/mimo-v2.6-flash-free', 'xiaomi/mimo-v2.6-flash', 'zhipuai-coding-plan/glm-5.3-flash'].sort(),
    '档位里真打了谁（次数相同则按出现顺序）',
  )

  assert.deepEqual(agg.byTier.map((t) => t.tier), ['flash', 'pro', null], '档位顺序固定，非 REEVE 的排最后')
  assert.equal(agg.byTier[2].n, 1, '非 REEVE 档位的调用也要如实列出来')
  assert.equal(agg.byProvider.find((p) => p.provider === 'xiaomi').n, 1, '窗口外的行不算（xiaomi 还有一行是 old）')
  assert.equal(agg.byProvider[0].provider, 'zhipuai-coding-plan', '按次数降序')
  assert.equal(agg.byModel.find((m) => m.ref === 'zhipuai-coding-plan/glm-5.3').n, 1)

  // 全都过期 → 退化用抓到的行，并如实标 relaxed（面板据此不假装是"近 24h"）
  const oldRow = rows.find((r) => r.id === 'old')
  const stale = aggregateBifrostRows([oldRow], { now, windowMs: 3600_000 })
  assert.equal(stale.used, 1)
  assert.equal(stale.window.relaxed, true)
  assert.equal(stale.window.since, Date.parse('2026-10-10T00:00:00Z'))
  const empty = aggregateBifrostRows([], { now })
  assert.equal(empty.total, 0)
  assert.equal(empty.latency.avg, null)
  assert.deepEqual(empty.byTier, [])
  ok('aggregateBifrostRows：档位/provider/回退/延迟 + 空与过期两种退化')
}

// ---- 4. 台账聚合（任务级） ----
{
  const now = Date.now()
  const recs = [
    { taskID: '1', agent: 'scout', state: 'completed', startedAt: 1000, endedAt: 3000 },
    { taskID: '2', agent: 'scout', state: 'completed', startedAt: 1000, endedAt: 11000 },
    { taskID: '3', agent: 'scout', state: 'error', startedAt: 5000, endedAt: 6000, timedOut: true, statusUncertain: true },
    { taskID: '4', agent: 'reviewer', state: 'stopped', startedAt: 7000, endedAt: null },
    { taskID: '5', agent: 'reviewer', state: 'running', startedAt: 8000, endedAt: null },
    { taskID: '6', agent: null, state: 'completed', startedAt: 9000, endedAt: 9500 },
  ]
  const agg = aggregateLedger(recs, { now })
  assert.deepEqual(agg.totals, { n: 6, ok: 3, error: 1, stopped: 1, running: 1, uncertain: 1, timedOut: 1 })
  assert.equal(agg.byAgent[0].agent, 'scout', '任务多的在前')
  const scout = agg.byAgent.find((a) => a.agent === 'scout')
  assert.equal(scout.n, 3)
  assert.equal(scout.error, 1)
  assert.equal(scout.timedOut, 1)
  assert.equal(scout.uncertain, 1)
  assert.equal(scout.latency.n, 3, '只有首尾齐全的算时长')
  assert.equal(scout.latency.p50, 2000)
  assert.equal(scout.latency.max, 10000)
  assert.equal(agg.byAgent.find((a) => a.agent === 'reviewer').latency.n, 0, '在飞的没有时长')
  assert.ok(agg.byAgent.some((a) => a.agent === '(未标注)'), '没写 agent 的记成 (未标注)')
  assert.equal(agg.window.from, 1000)
  assert.equal(agg.window.until, 11000)
  assert.equal(agg.latency.p95, 10000)
  ok('aggregateLedger：每 agent 的 成/败/停/在飞/超时/不确定 + p50/p95')
}

// ---- 5. 取数：形状与降级（注入 fetch） ----
{
  const mkFetch = (status, body) => async (url) => ({ status, json: async () => (typeof body === 'function' ? body(url) : body), text: async () => JSON.stringify(body) })
  const payload = {
    has_logs: true,
    logs: [{ id: 'r1', provider: 'p', model: 'm', routing_rule_name: 'reeve/pro', status: 'success', latency: 1, content_summary: 'x' }],
    pagination: { limit: 1, offset: 0, sort_by: 'timestamp', order: 'desc', total_count: 28 },
    stats: { total_requests: 28 },
  }
  const good = await fetchBifrostLogs({ port: 18080, token: 't', limit: 1, fetchImpl: mkFetch(200, payload) })
  assert.equal(good.error, null)
  assert.equal(good.rows.length, 1)
  assert.equal(good.total, 28)
  assert.equal(good.signature, '28:r1', '指纹 = 总数 + 最新 id（用来跳过没变化的抓取）')

  const dataShape = await fetchBifrostLogs({ port: 1, fetchImpl: mkFetch(200, { data: [{ id: 'x' }] }) })
  assert.equal(dataShape.rows.length, 1, '`data` 只是兜底（实测是 logs）')
  assert.equal(dataShape.signature, '?:x', '拿不到 total_count 也不能炸')

  const bad = await fetchBifrostLogs({ port: 1, fetchImpl: mkFetch(401, {}) })
  assert.equal(bad.rows.length, 0)
  assert.equal(bad.error, 'HTTP 401')
  const thrown = await fetchBifrostLogs({ port: 1, fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.match(thrown.error, /ECONNREFUSED/)
  assert.equal(thrown.signature, null)

  const models = await fetchBifrostModels({ port: 18080, fetchImpl: mkFetch(200, { data: [{ id: 'xiaomi/mimo-v2.6-flash', context_length: 1048576 }, { id: 'bad' }, { id: 'lmuai/glm-5.3' }] }) })
  assert.equal(models.error, null)
  assert.deepEqual(models.models.map((m) => m.ref), ['xiaomi/mimo-v2.6-flash', 'lmuai/glm-5.3'], '认不出的（没有 provider/）丢掉')
  assert.equal(models.models[0].context, 1048576)
  assert.equal((await fetchBifrostModels({ port: 1, fetchImpl: mkFetch(500, {}) })).error, 'HTTP 500')
  ok('fetchBifrostLogs / fetchBifrostModels：形状 + 失败降级不抛')
}

// ---- 6. 模型候选的合并（发现不全时靠链与引擎补齐） ----
{
  const merged = mergeModelCandidates({
    discovered: [{ ref: 'xiaomi/mimo-v2.6-flash', context: 1_048_576 }, { ref: 'lmuai/glm-5.3' }],
    chained: ['zhipuai-coding-plan/glm-5.3', 'lmuai/glm-5.3', 'weird/'],
    engine: ['reeve/flash', 'reeve/pro', 'reeve/multimodal'],
  })
  const byRef = Object.fromEntries(merged.map((m) => [m.ref, m]))
  assert.equal(merged.length, 6, '并集去重（lmuai 只出现一次）')
  assert.deepEqual(byRef['lmuai/glm-5.3'].sources.sort(), ['bifrost', 'chain'], '同一个模型两处都在 → 来源标两个')
  assert.equal(byRef['zhipuai-coding-plan/glm-5.3'].sources[0], 'chain', 'zhipuai 探不到 /v1/models → 靠链补上')
  assert.equal(byRef['reeve/pro'].sources[0], 'engine')
  assert.ok(!('weird/' in byRef), '`provider/`（同模型换 provider）不是完整引用，不进候选')
  assert.equal(byRef['xiaomi/mimo-v2.6-flash'].context, 1_048_576)
  assert.deepEqual(mergeModelCandidates({}), [])
  ok('mergeModelCandidates：发现 ∪ 链上在用的 ∪ 引擎注册的')
}

// ---- 7. 快照那一节的形状 ----
{
  const s = buildStats({ now: 5, windowMs: 3600_000, source: 'bifrost.api', bifrost: { total: 1 }, orchestrate: { totals: { n: 0 }, queue: { active: 0, waiting: 1 } }, checkedAt: 4 })
  assert.equal(s.generatedAt, 5)
  assert.equal(s.checkedAt, 4)
  assert.equal(s.source, 'bifrost.api')
  assert.equal(s.error, null)
  assert.equal(s.orchestrate.queue.waiting, 1)
  const down = buildStats({ now: 1, source: 'unavailable', error: 'HTTP 401' })
  assert.equal(down.bifrost, null)
  assert.equal(down.error, 'HTTP 401')
  assert.deepEqual(buildStats().source, 'unavailable', '默认就是"拿不到"，不假装有数据')
  ok('buildStats：三态来源 + 窗口 + 排队数')
}

console.log(`\n统计测试：${passed} 项全过`)