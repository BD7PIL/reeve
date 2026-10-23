// 性能统计：把 **GATE 台账**（请求级归因）与编排台账（任务级）聚合成面板要看的形状。
//
// 分工（两条取数路径，别混）：
//   · GATE 侧 = "请求级归因"：哪条链（chain）、真打了谁（provider/model）、第几次尝试（n）、
//     成没成、多久、有没有重试。**只有 GATE 知道真模型是谁** —— 引擎侧的 session 记录里
//     模型名永远是 `reeve/pro` 这类别名（见 PROGRESS §6.2 归因边界）。
//   · 编排侧 = "任务级台账"：谁派给了谁、跑多久、超时/停止/对账、在飞与排队。
//
// 取数：GATE 的台账是 JSONL（`~/.reeve/gate.jsonl`，插件与 GATE 同进程、同机器）——
// 直接按行读、只聚合窗口内的行。**不问 HTTP、不要 token**（旧代理层那套已随退役删除）。
// 空网/只读盘的机器上读不到就如实标 unavailable，面板给出手工核对的办法。
//
// 行形状（gate/lanes.js 的 attemptRow，**没有密钥材料**）：
//   ts, req, n, chain, agent, provider, model, lane, key(键的"名字"), status('ok'|'error'),
//   code, latency_ms, retries, detail

import { t } from './locale.js'

export const STATS_DEFAULTS = Object.freeze({
  /** 轮询间隔（unref 定时器，失败只记日志） */
  intervalMs: 60_000,
  /** 每次读多少行（读的是台账**尾部**的若干行） */
  limit: 400,
  /** 聚合窗口：只有落在这个窗口里的行参与统计 */
  windowMs: 24 * 60 * 60 * 1000,
  /** 模型目录的刷新间隔（`/v1/models` 会去上游探测池；别跟统计同频） */
  modelsIntervalMs: 30 * 60 * 1000,
  timeoutMs: 6_000,
})

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

/** `provider/model` 的引用串（链里就是这个写法）。 */
export function modelRef(row) {
  return row?.provider && row?.model ? `${row.provider}/${row.model}` : null
}

export function parseTs(value) {
  const t = Date.parse(String(value ?? ''))
  return Number.isFinite(t) ? t : null
}

/** 台账一排（`createLedger.readLine` 的产物解析后）→ 行对象；坏行返回 null（调用方丢）。 */
export function parseGateRow(line) {
  try {
    const row = JSON.parse(String(line))
    return row && typeof row === 'object' ? row : null
  } catch {
    return null
  }
}

/**
 * GATE 台账行 → 归因统计（请求级 + 尝试级）。
 *
 * 口径：
 *   · 一次调用 = 一个 `req`（没有 `req` 的旧行按"每行一次调用"算，如实）；
 *     `n` 是这一次调用里的第几次尝试（1 起）；失败换候选 → n 递增。
 *   · `fallbackRequests` = 尝试次数 >1 的调用；`fallbackHops` = Σ(n_max − 1)。
 *   · 调用级成败看**最后一次尝试**的状态（换到谁成功就是成功）。
 *   · 延迟分两层：`attemptLatency`（单次上游往返）与 `requestLatency`（一次调用的总耗时 = 同一 req 的 latency_ms 之和）。
 */
export function aggregateGateRows(rows, { now = Date.now(), windowMs = STATS_DEFAULTS.windowMs } = {}) {
  const withTs = (rows ?? [])
    .filter((r) => r && (r.provider || r.model))
    .map((r) => ({ row: r, at: parseTs(r.ts) }))
  const since = now - windowMs
  const inWindow = withTs.filter((x) => x.at != null && x.at >= since)
  // 窗口内一条都没有（机器闲了很久）→ 退成"就用读到的这些行"，并如实标 relaxed
  const relaxed = inWindow.length === 0 && withTs.length > 0
  const used = relaxed ? withTs : inWindow

  const chains = new Map()
  const providers = new Map()
  const models = new Map()
  const byReq = new Map()
  const byAttemptIndex = {}
  const attemptLatencies = []
  let ok = 0
  let error = 0

  for (const [idx, { row, at }] of used.entries()) {
    const isOk = row.status === 'ok'
    if (isOk) ok += 1
    else error += 1
    const lat = Number(row.latency_ms)
    if (Number.isFinite(lat)) attemptLatencies.push(lat)
    const n = Number(row.n)
    const nIdx = Number.isFinite(n) && n >= 1 ? n : 1
    byAttemptIndex[nIdx] = (byAttemptIndex[nIdx] ?? 0) + 1

    const chainKey = row.chain ?? t('stats.unknownChain')
    const bucket =
      chains.get(chainKey) ??
      { chain: chainKey, agent: null, n: 0, ok: 0, error: 0, hops: 0, latency: [], providers: new Map() }
    if (!bucket.agent && row.agent) bucket.agent = row.agent
    bucket.n += 1
    if (isOk) bucket.ok += 1
    else bucket.error += 1
    if (nIdx > 1) bucket.hops += 1
    if (Number.isFinite(lat)) bucket.latency.push(lat)
    const ref = modelRef(row)
    if (ref) bucket.providers.set(ref, (bucket.providers.get(ref) ?? 0) + 1)
    chains.set(chainKey, bucket)

    const p = providers.get(row.provider ?? t('stats.unknownProvider')) ?? { provider: row.provider ?? '(未知)', n: 0, ok: 0, error: 0, latency: [], lastAt: null }
    p.n += 1
    if (isOk) p.ok += 1
    else p.error += 1
    if (Number.isFinite(lat)) p.latency.push(lat)
    if (at != null && (p.lastAt == null || at > p.lastAt)) p.lastAt = at
    providers.set(p.provider, p)

    if (ref) {
      const m = models.get(ref) ?? { ref, provider: row.provider, model: row.model, n: 0, ok: 0, error: 0, lastAt: null }
      m.n += 1
      if (isOk) m.ok += 1
      else m.error += 1
      if (at != null && (m.lastAt == null || at > m.lastAt)) m.lastAt = at
      models.set(ref, m)
    }

    // 没有 `req` 的旧行按"每行一次调用"算（诚实：不能让它们被错并成一次）
    const reqKey = row.req != null ? String(row.req) : `row:${idx}`
    const req = byReq.get(reqKey) ?? { attempts: 0, maxN: 0, lastOk: null, chain: chainKey, totalMs: 0, at: null }
    req.attempts += 1
    if (nIdx > req.maxN) req.maxN = nIdx
    req.lastOk = isOk
    if (Number.isFinite(lat)) req.totalMs += lat
    if (at != null && (req.at == null || at > req.at)) req.at = at
    byReq.set(reqKey, req)
  }

  let fallbackRequests = 0
  let fallbackHops = 0
  let requestsOk = 0
  let requestsError = 0
  const requestLatencies = []
  for (const req of byReq.values()) {
    if (req.maxN > 1) {
      fallbackRequests += 1
      fallbackHops += req.maxN - 1
    }
    if (req.lastOk === true) requestsOk += 1
    else requestsError += 1
    if (req.totalMs > 0) requestLatencies.push(req.totalMs)
  }

  const tsList = used.map((x) => x.at).filter((v) => v != null)
  return {
    window: {
      ms: windowMs,
      since: relaxed ? (tsList.length ? Math.min(...tsList) : null) : since,
      until: tsList.length ? Math.max(...tsList) : null,
      relaxed,
    },
    fetched: (rows ?? []).length,
    used: used.length,
    attempts: used.length,
    requests: byReq.size,
    attemptsOk: ok,
    attemptsError: error,
    requestsOk,
    requestsError,
    attemptLatency: summarizeLatency(attemptLatencies),
    requestLatency: summarizeLatency(requestLatencies),
    fallback: { requests: fallbackRequests, hops: fallbackHops, byIndex: byAttemptIndex },
    byChain: [...chains.values()]
      .map(({ latency, providers: ps, ...rest }) => ({
        ...rest,
        latency: summarizeLatency(latency),
        providers: [...ps.entries()]
          .map(([ref, n]) => ({ ref, n }))
          .sort((a, b) => b.n - a.n)
          .slice(0, 8),
      }))
      .sort((a, b) => b.n - a.n),
    byProvider: [...providers.values()]
      .map((p) => ({ provider: p.provider, n: p.n, ok: p.ok, error: p.error, lastAt: p.lastAt, latency: summarizeLatency(p.latency) }))
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
    const agent = r.agent ?? t('stats.unknownAgent')
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
 * `source` 三态：`gate.ledger`（拿到了）/ `unavailable`（拿不到，附 error）/ `disabled`。
 */
export function buildStats({ gate = null, orchestrate = null, now = Date.now(), windowMs = STATS_DEFAULTS.windowMs, source = 'unavailable', error = null, checkedAt = null } = {}) {
  return { generatedAt: now, checkedAt, windowMs, source, error, gate, orchestrate }
}

// ── IO（薄，注入 fetch 便于测试） ────────────────────────────────────────────

/**
 * 读 GATE 台账的**尾部**若干行（JSONL）。只读文件尾 —— 台账会轮转，但就算没轮转也不该整读。
 * 第一行可能是被截断的半行 → 丢掉（解析失败的行一律丢，不猜）。
 * @returns {{rows: any[], truncated: boolean, error: string|null}}
 */
export async function readLedgerTail({ path, limit = STATS_DEFAULTS.limit, tailBytes = 512 * 1024, readFileImpl = null, statImpl = null } = {}) {
  const { open, stat } = await import('node:fs/promises')
  const doStat = statImpl ?? stat
  const doOpen = readFileImpl ?? open
  let fh = null
  try {
    const st = await doStat(path)
    const start = Math.max(0, Number(st.size) - tailBytes)
    fh = await doOpen(path, 'r')
    const len = Number(st.size) - start
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, start)
    const text = buf.toString('utf8')
    const lines = text.split('\n').filter((l) => l.trim().length > 0)
    const truncated = start > 0
    const body = truncated ? lines.slice(1) : lines
    const rows = body.map(parseGateRow).filter(Boolean)
    return { rows: rows.slice(-limit), truncated, error: null }
  } catch (err) {
    return { rows: [], truncated: false, error: String(err?.message ?? err).slice(0, 140) }
  } finally {
    if (fh) await fh.close().catch(() => {})
  }
}

/**
 * 免费模型池运行态（`/gate/free`）：发现源状态、当前展开、冷却。
 * 读不到不算错——面板会显示"未就绪"，请求侧照常降级到付费。
 */
export async function fetchGateFree({ port, host = '127.0.0.1', fetchImpl = fetch, timeoutMs = STATS_DEFAULTS.timeoutMs } = {}) {
  try {
    const res = await fetchImpl(`http://${host}:${port}/gate/free`, { signal: AbortSignal.timeout(timeoutMs) })
    if (res.status !== 200) return { error: `HTTP ${res.status}` }
    const doc = await res.json()
    return doc && typeof doc === 'object' ? { ...doc, error: null } : { error: t('free.error.emptyResponse') }
  } catch (err) {
    return { error: String(err?.message ?? err).slice(0, 140) }
  }
}

/** GATE 的运行态（/gate/version）：开关快照轮询用。读不到返回 {doc:null,error}，不抛。 */
export async function fetchGateVersion({ port, host = '127.0.0.1', fetchImpl = fetch, timeoutMs = STATS_DEFAULTS.timeoutMs } = {}) {
  try {
    const res = await fetchImpl(`http://${host}:${port}/gate/version`, { signal: AbortSignal.timeout(timeoutMs) })
    if (res.status !== 200) return { doc: null, error: `HTTP ${res.status}` }
    const doc = await res.json()
    return { doc: doc && typeof doc === 'object' ? doc : null, error: null }
  } catch (err) {
    return { doc: null, error: String(err?.message ?? err).slice(0, 140) }
  }
}

/** GATE 自己的模型目录（`provider/model` ∪ 链名）—— 面板选择器的候选来源之一。 */
export async function fetchGateModels({ port, host = '127.0.0.1', fetchImpl = fetch, timeoutMs = STATS_DEFAULTS.timeoutMs } = {}) {
  try {
    const res = await fetchImpl(`http://${host}:${port}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) })
    if (res.status !== 200) return { models: [], chains: [], error: `HTTP ${res.status}` }
    const doc = await res.json()
    const chains = []
    const models = (Array.isArray(doc?.data) ? doc.data : [])
      .map((m) => {
        const ref = String(m?.id ?? '')
        if (m?.owned_by === 'reeve') {
          chains.push(ref)
          return null
        }
        const i = ref.indexOf('/')
        if (i <= 0) return null
        return { ref, provider: ref.slice(0, i), model: ref.slice(i + 1), context: Number(m?.context_length) || null }
      })
      .filter(Boolean)
    return { models, chains, error: null }
  } catch (err) {
    return { models: [], chains: [], error: String(err?.message ?? err).slice(0, 140) }
  }
}

/**
 * 面板选择器的候选 = GATE 目录（声明 ∪ 池）∪ 链上已经在用的 ∪ 引擎注册的（reeve/*）。
 * 发现不全就如实标出来（每条候选带 sources），而不是假装列表就是全集。
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
  for (const m of discovered) add(m, 'gate')
  for (const ref of chained) add(ref, 'chain')
  for (const m of engine) add(m, 'engine')
  return [...out.values()].sort((a, b) => a.ref.localeCompare(b.ref))
}