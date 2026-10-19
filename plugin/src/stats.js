// 性能统计：把 Bifrost 的调用日志与本地台账**聚合成面板要看的形状**。
//
// 分工（两条取数路径，别混）：
//   · Bifrost 侧 = "请求级归因"：哪一档（routing_rule_name）、真打了谁（provider/model）、
//     是第几跳回退（fallback_index）、成没成、多久。**只有 Bifrost 知道真模型是谁** ——
//     引擎侧的 session 记录里模型名永远是 `reeve/pro` 这类别名（见 PROGRESS §6.2 归因边界）。
//   · 编排侧 = "任务级台账"：谁派给了谁、跑多久、超时/停止/对账、在飞与排队。
//
// 取数顺序（每步降级，最后如实标 unavailable）：
//   ① `GET /api/logs`（需 setup token —— 插件自己写的 600 文件）→ 实测形状见下
//   ② 不产出统计：面板显示"拿不到"，并给出手工核对的办法
// 为什么不做 logs.db 直读：引擎运行时里的 node:sqlite 版本未知（Bifrost 的库用了较新的
// 索引语法，EL7 的 python3.6 读它直接报 malformed schema）—— 直读是**最后**的手段，先不做。
//
// **实测形状**（2026-10-19 EL7，Bifrost 2.3.0）：
//   GET /api/logs?limit=N&offset=0[&sort_by=timestamp&order=desc|asc]
//   → 200 `{ has_logs, logs:[…], pagination:{limit,offset,sort_by,order,total_count}, stats:{…} }`
//   行里的关键字段：`id, timestamp(ISO, 纳秒), provider, model, fallback_index, number_of_retries,
//   routing_rule_id, routing_rule_name, selected_key_name, latency(ms, 浮点), upstream_latency,
//   overhead_latency, status('success'|'error'), stream, session_id, user_agent, app`
//   · 排序参数生效（order=asc 拿到最旧的）；未知参数**被静默忽略**（试过 content=false 等一律无效）
//   · `content_summary` 里是**完整提示词内容**，每行约 6.7 KB —— 聚合时一律丢掉（面板不该看内容）
//   · 无 token → 401；limit 上限在 1000（5000 → 400）
//   · `stats` 块除 total_requests 外全是 0，不可信 → 自己按行聚合
//
// 因此轮询策略：先 `limit=1` 探一下（`total_count` + 最新 id 就是"有没有变"的指纹），
// 变了才抓 `limit` 行回来聚合 —— 空闲时每分钟只有一次 6 KB 的请求。

export const STATS_DEFAULTS = Object.freeze({
  /** 轮询间隔（unref 定时器，失败只记日志） */
  intervalMs: 60_000,
  /** 每次抓多少行（抓的是**最新**的若干行） */
  limit: 100,
  /** 聚合窗口：只有落在这个窗口里的行参与统计 */
  windowMs: 24 * 60 * 60 * 1000,
  /** 模型目录的刷新间隔（`/v1/models` 会真去上游探测并被 Bifrost 记日志 —— 别跟统计同频） */
  modelsIntervalMs: 30 * 60 * 1000,
  timeoutMs: 6_000,
})

/** 面板要的形状里保留哪些字段 —— 其余（尤其 content_summary）一律丢掉。 */
const KEEP_FIELDS = [
  'id',
  'timestamp',
  'provider',
  'model',
  'fallback_index',
  'number_of_retries',
  'routing_rule_id',
  'routing_rule_name',
  'selected_key_name',
  'latency',
  'upstream_latency',
  'status',
  'stream',
  'session_id',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
]

// ── 纯函数（可测） ─────────────────────────────────────────────────────────

/** 最近秩百分位（不做插值 —— 面板看的是"典型有多慢"，不是数学分位）。输入会被排序副本。 */
export function percentile(values, p) {
  const xs = (values ?? []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (xs.length === 0) return null
  const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1))
  return xs[idx]
}

/** 一组延迟（毫秒）→ `{n, avg, p50, p95, max}`；一个数都没有就返回 n=0 的空壳。 */
export function summarizeLatency(values) {
  const xs = (values ?? []).filter((v) => Number.isFinite(v))
  if (xs.length === 0) return { n: 0, avg: null, p50: null, p95: null, max: null }
  const round = (v) => (v == null ? null : Math.round(v))
  return {
    n: xs.length,
    avg: round(xs.reduce((s, v) => s + v, 0) / xs.length),
    p50: round(percentile(xs, 0.5)),
    p95: round(percentile(xs, 0.95)),
    max: round(Math.max(...xs)),
  }
}

/** `reeve/pro` → `pro`；不是 REEVE 的档位规则就返回 null（"不属于本层"）。 */
export function tierOfRuleName(name) {
  const m = /^reeve\/(flash|pro|multimodal)$/.exec(String(name ?? ''))
  return m ? m[1] : null
}

/** 丢内容、留计数：面板只该看归因与延迟，不该看提示词。 */
export function normalizeLogRow(row) {
  const out = {}
  for (const k of KEEP_FIELDS) if (k in row) out[k] = row[k]
  return out
}

/** `provider/model` 的引用串（链里就是这个写法）。 */
export function modelRef(row) {
  return row?.provider && row?.model ? `${row.provider}/${row.model}` : null
}

export function parseTs(value) {
  const t = Date.parse(String(value ?? ''))
  return Number.isFinite(t) ? t : null
}

/**
 * 抓回来的行 → 归因统计。
 * `source` 只表达"这批数字从哪来"，`window` 里给出实际覆盖的时间范围（别让面板假装是 24h）。
 *
 * ⚠️ 两条实测出来的口径（都踩到过）：
 *   · **`model` 为空的行不是调用**：那是 Bifrost 去上游探 `/v1/models` 的痕迹（rule 为 null、
 *     model 为空串）。实测一次探测每 7 个 provider 就写 7 行 —— 混进来会把"调用次数"灌爆。
 *     所以按"有 model"过滤，并如实报出过滤了多少行。
 *   · **status 有三态**：`success` / `error` / `cancelled`（客户端把流掐了）。cancelled 不算失败。
 */
export function aggregateBifrostRows(rows, { now = Date.now(), windowMs = STATS_DEFAULTS.windowMs } = {}) {
  const normalized = (rows ?? []).map(normalizeLogRow)
  const withTs = normalized.map((r) => ({ row: r, at: parseTs(r.timestamp) }))
  const probes = withTs.filter((x) => !x.row.model)
  const calls = withTs.filter((x) => x.row.model)
  const since = now - windowMs
  const inWindow = calls.filter((x) => x.at != null && x.at >= since)
  // 窗口内一条都没有（机器闲了很久）→ 退成"就用抓到的这些行"，并如实标 relaxed
  const relaxed = inWindow.length === 0 && calls.length > 0
  const used = relaxed ? calls : inWindow

  const tiers = new Map()
  const providers = new Map()
  const models = new Map()
  let fallbackHops = 0
  let fallbackRequests = 0
  const byIndex = {}
  let ok = 0
  let error = 0
  let cancelled = 0
  const latencies = []

  for (const { row, at } of used) {
    const isOk = row.status === 'success'
    const isCancelled = row.status === 'cancelled'
    if (isOk) ok += 1
    else if (isCancelled) cancelled += 1
    else error += 1
    const lat = Number(row.latency)
    if (Number.isFinite(lat)) latencies.push(lat)

    const tier = tierOfRuleName(row.routing_rule_name)
    const bucketKey = tier ?? '(非 REEVE 档位)'
    const bucket =
      tiers.get(bucketKey) ??
      { tier, rule: row.routing_rule_name ?? null, n: 0, ok: 0, error: 0, cancelled: 0, fallbackRequests: 0, fallbackHops: 0, latency: [], providers: new Map() }
    bucket.n += 1
    if (isOk) bucket.ok += 1
    else if (isCancelled) bucket.cancelled += 1
    else bucket.error += 1
    const fb = Number(row.fallback_index) || 0
    if (fb > 0) {
      bucket.fallbackRequests += 1
      bucket.fallbackHops += fb
      fallbackRequests += 1
      fallbackHops += fb
    }
    byIndex[fb] = (byIndex[fb] ?? 0) + 1
    if (Number.isFinite(lat)) bucket.latency.push(lat)
    const ref = modelRef(row)
    if (ref) bucket.providers.set(ref, (bucket.providers.get(ref) ?? 0) + 1)
    tiers.set(bucketKey, bucket)

    const p = providers.get(row.provider ?? '(未知)') ?? { provider: row.provider ?? '(未知)', n: 0, ok: 0, error: 0, cancelled: 0, latency: [], lastAt: null }
    p.n += 1
    if (isOk) p.ok += 1
    else if (isCancelled) p.cancelled += 1
    else p.error += 1
    if (Number.isFinite(lat)) p.latency.push(lat)
    if (at != null && (p.lastAt == null || at > p.lastAt)) p.lastAt = at
    providers.set(p.provider, p)

    if (ref) {
      const m = models.get(ref) ?? { ref, provider: row.provider, model: row.model, n: 0, ok: 0, error: 0, lastAt: null }
      m.n += 1
      if (isOk) m.ok += 1
      else if (!isCancelled) m.error += 1
      if (at != null && (m.lastAt == null || at > m.lastAt)) m.lastAt = at
      models.set(ref, m)
    }
  }

  const tsList = used.map((x) => x.at).filter((v) => v != null)
  const TIER_ORDER = ['flash', 'pro', 'multimodal']
  const tierRows = [...tiers.values()]
    .map((b) => ({
      tier: b.tier,
      rule: b.rule,
      n: b.n,
      ok: b.ok,
      error: b.error,
      cancelled: b.cancelled,
      fallbackRequests: b.fallbackRequests,
      fallbackHops: b.fallbackHops,
      latency: summarizeLatency(b.latency),
      providers: [...b.providers.entries()]
        .map(([ref, n]) => ({ ref, n }))
        .sort((a, b) => b.n - a.n),
    }))
    .sort((a, b) => {
      const ia = a.tier ? TIER_ORDER.indexOf(a.tier) : 99
      const ib = b.tier ? TIER_ORDER.indexOf(b.tier) : 99
      return ia - ib || b.n - a.n
    })

  return {
    window: {
      ms: windowMs,
      since: relaxed ? (tsList.length ? Math.min(...tsList) : null) : since,
      until: tsList.length ? Math.max(...tsList) : null,
      relaxed,
    },
    fetched: normalized.length,
    probes: probes.length,
    used: used.length,
    total: used.length,
    ok,
    error,
    cancelled,
    latency: summarizeLatency(latencies),
    fallback: { requests: fallbackRequests, hops: fallbackHops, byIndex },
    byTier: tierRows,
    byProvider: [...providers.values()]
      .map((p) => ({ provider: p.provider, n: p.n, ok: p.ok, error: p.error, cancelled: p.cancelled, lastAt: p.lastAt, latency: summarizeLatency(p.latency) }))
      .sort((a, b) => b.n - a.n),
    byModel: [...models.values()].sort((a, b) => b.n - a.n).slice(0, 20),
  }
}

/**
 * 台账（本地记录）→ 每 agent 的任务级统计。
 * 时长 = `endedAt - startedAt`（终态的才算；在飞的只报数）。
 */
export function aggregateLedger(records, { now = Date.now() } = {}) {
  const byAgent = new Map()
  const totals = { n: 0, ok: 0, error: 0, stopped: 0, running: 0, uncertain: 0, timedOut: 0 }
  const durations = []
  let firstAt = null
  let lastAt = null
  for (const r of records ?? []) {
    const agent = r.agent ?? '(未标注)'
    const b = byAgent.get(agent) ?? { agent, n: 0, ok: 0, error: 0, stopped: 0, running: 0, uncertain: 0, timedOut: 0, durations: [] }
    b.n += 1
    totals.n += 1
    const state = String(r.state ?? '')
    if (state === 'completed') {
      b.ok += 1
      totals.ok += 1
    } else if (state === 'error') {
      b.error += 1
      totals.error += 1
    } else if (state === 'stopped') {
      b.stopped += 1
      totals.stopped += 1
    } else if (state === 'running') {
      b.running += 1
      totals.running += 1
    }
    if (r.statusUncertain === true) {
      b.uncertain += 1
      totals.uncertain += 1
    }
    if (r.timedOut === true) {
      b.timedOut += 1
      totals.timedOut += 1
    }
    const start = Number(r.startedAt)
    const end = Number(r.endedAt)
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      b.durations.push(end - start)
      durations.push(end - start)
    }
    if (Number.isFinite(start) && (firstAt == null || start < firstAt)) firstAt = start
    if (Number.isFinite(end) && (lastAt == null || end > lastAt)) lastAt = end
    byAgent.set(agent, b)
  }
  return {
    totals: { ...totals, uncertain: totals.uncertain },
    window: { from: firstAt, until: lastAt, now },
    latency: summarizeLatency(durations),
    byAgent: [...byAgent.values()]
      .map(({ durations: d, ...rest }) => ({ ...rest, latency: summarizeLatency(d) }))
      .sort((a, b) => b.n - a.n),
  }
}

/**
 * 快照里的 `stats` 一节。
 * `source` 三态：`bifrost.api`（拿到了）/ `unavailable`（拿不到，附 error）/ `disabled`。
 */
export function buildStats({ bifrost = null, orchestrate = null, now = Date.now(), windowMs = STATS_DEFAULTS.windowMs, source = 'unavailable', error = null, checkedAt = null } = {}) {
  return { generatedAt: now, checkedAt, windowMs, source, error, bifrost, orchestrate }
}

// ── IO（薄，注入 fetch 便于测试） ────────────────────────────────────────────

function headers(token) {
  return token ? { 'X-Bifrost-Setup-Token': token } : {}
}

/**
 * 抓日志。/api/logs 的 `pagination.total_count` + 最新一行的 id 就是"有没有新东西"的指纹。
 * @returns {{rows: any[], total: number|null, signature: string|null, error: string|null}}
 */
export async function fetchBifrostLogs({
  port,
  host = '127.0.0.1',
  token = null,
  limit = STATS_DEFAULTS.limit,
  offset = 0,
  order = 'desc',
  fetchImpl = fetch,
  timeoutMs = STATS_DEFAULTS.timeoutMs,
} = {}) {
  const url = `http://${host}:${port}/api/logs?limit=${Number(limit)}&offset=${Number(offset)}&sort_by=timestamp&order=${order}`
  try {
    const res = await fetchImpl(url, { headers: headers(token), signal: AbortSignal.timeout(timeoutMs) })
    if (res.status !== 200) return { rows: [], total: null, signature: null, error: `HTTP ${res.status}` }
    const doc = await res.json()
    // 实测是 `logs`；`data` 只是当年的消费假设，留着兜底
    const rows = Array.isArray(doc?.logs) ? doc.logs : Array.isArray(doc?.data) ? doc.data : []
    const total = Number(doc?.pagination?.total_count)
    return {
      rows,
      total: Number.isFinite(total) ? total : null,
      signature: `${Number.isFinite(total) ? total : '?'}:${rows[0]?.id ?? '(空)'}`,
      error: null,
    }
  } catch (err) {
    return { rows: [], total: null, signature: null, error: String(err?.message ?? err).slice(0, 140) }
  }
}

/** Bifrost 自己发现出来的模型目录（`provider/model`）—— 面板选择器的候选来源之一。 */
export async function fetchBifrostModels({ port, host = '127.0.0.1', fetchImpl = fetch, timeoutMs = STATS_DEFAULTS.timeoutMs } = {}) {
  try {
    const res = await fetchImpl(`http://${host}:${port}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) })
    if (res.status !== 200) return { models: [], error: `HTTP ${res.status}` }
    const doc = await res.json()
    const models = (Array.isArray(doc?.data) ? doc.data : [])
      .map((m) => {
        const ref = String(m?.id ?? '')
        const i = ref.indexOf('/')
        if (i <= 0) return null
        return { ref, provider: ref.slice(0, i), model: ref.slice(i + 1), context: Number(m?.context_length) || null }
      })
      .filter(Boolean)
    return { models, error: null }
  } catch (err) {
    return { models: [], error: String(err?.message ?? err).slice(0, 140) }
  }
}

/**
 * 面板选择器的候选 = 发现出来的 ∪ 链上已经在用的 ∪ 引擎注册的（reeve/*）。
 * 为什么必须含"链上在用的"与"手工可填"：实测 `/v1/models` 只覆盖 4/7 个 provider
 * （zhipuai-coding-plan 的对话路径是自定义的，`/v1/models` 探不到；opencode zen 与
 * alibaba-cn 同理）。发现不全就如实标出来，而不是假装列表就是全集。
 */
export function mergeModelCandidates({ discovered = [], chained = [], engine = [] } = {}) {
  const out = new Map()
  const add = (m, source) => {
    const ref = typeof m === 'string' ? m : m?.ref
    // 认不出的、以及 `provider/`（同模型换 provider，不是完整引用）都丢掉
    const i = String(ref ?? '').indexOf('/')
    if (!ref || i <= 0 || i === ref.length - 1) return
    const cur = out.get(ref) ?? { ref, provider: ref.slice(0, i), model: ref.slice(i + 1), context: null, sources: [] }
    if (typeof m === 'object' && Number(m?.context)) cur.context = Number(m.context)
    if (!cur.sources.includes(source)) cur.sources.push(source)
    out.set(ref, cur)
  }
  for (const m of discovered) add(m, 'bifrost')
  for (const ref of chained) add(ref, 'chain')
  for (const m of engine) add(m, 'engine')
  return [...out.values()].sort((a, b) => a.ref.localeCompare(b.ref))
}