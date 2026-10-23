// GATE 的自动免费车道。
//
// 为什么需要它：免费档（OpenCode Free / OpenRouter `:free` / NVIDIA 免费额度）的**模型列表会变**
// 且**时好时坏**。写死候选会腐坏；写一个"管理器"定时改配置又会 churn 用户的文件。这里的做法是：
//   · 链里只写占位符 `@free`；
//   · 请求时按"发现到的、未冷却的、有键的"候选**展开**成真实 provider/model；
//   · 发现结果带 TTL（`free.refresh_seconds`），失败保留上一份好列表并如实记错误；
//   · 失败的免费模型按 **ref** 进全局冷却（连续 `failure_threshold` 次 → `failure_cooldown_seconds`），
//     全部冷却/不可用 → 本次直接走链里的付费候选（不硬撞限流）。
//
// 时间与 IO 全部注入（`now` / `fetchImpl`），测试用假时钟 + 发现源 stub，不 sleep、不出网。
import { parseTarget, resolveKeyFor, targetKey } from './lanes.js'

export const FREE_TOKEN = '@free'

/** 免费过滤规则（与上游自己的"免费"口径对齐；opencode 排掉已知非免费的 v4-flash）。 */
export const FREE_FILTERS = Object.freeze({
  'opencode-free': (id) => id !== 'deepseek-v4-flash-free' && (id.endsWith('-free') || id === 'big-pickle'),
  'openrouter-free': (id) => id.endsWith(':free'),
  all: () => true,
})

const asList = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter((x) => x.length > 0) : [])

/**
 * @param {object} opts
 * @param {() => object|null} opts.getConfig 归一化后的当前配置（热更后即时生效）
 * @param {() => object} [opts.getAuth] auth.json
 * @param {() => number} [opts.now]
 * @param {Function} [opts.fetchImpl]
 * @param {{debug?: Function}|null} [opts.logger]
 * @param {number} [opts.timeoutMs] 发现请求超时（不能把首笔请求拖太久）
 */
export function createFreeLane({ getConfig, getAuth = () => ({}), now = Date.now, fetchImpl = fetch, logger = null, timeoutMs = 2500 } = {}) {
  /** providerId -> { at, models: string[], error: string|null, from: string|null, sig: string } */
  const cache = new Map()
  /** ref -> { fails: number, until: number }（全局，跨 session：坏模型对所有人都坏） */
  const cooldowns = new Map()
  const inflight = new Map()
  /** models.dev 的 modalities：{ at, map: Map<ref, boolean>|null, error, inflight } */
  const modalityCache = { at: 0, map: null, error: null, inflight: null }

  const freeCfg = () => {
    const f = getConfig()?.free
    return f && typeof f === 'object' ? f : { enabled: false, max: 0, providers: [], prefer: [], deny: [], static: {}, sources: {} }
  }
  const providers = () => getConfig()?.providers ?? {}
  const policy = () => getConfig()?.policy ?? {}

  const hasKey = (provider) => {
    try {
      return resolveKeyFor(provider, { env: process.env, auth: getAuth() ?? {} }) !== null
    } catch {
      return false
    }
  }

  const sourceOf = (free, id) => {
    const staticList = free.static?.[id]
    if (Array.isArray(staticList)) return { kind: 'static', models: asList(staticList) }
    const src = free.sources?.[id]
    if (src && typeof src.url === 'string' && src.url.length > 0) {
      return { kind: 'fetch', url: src.url, filter: FREE_FILTERS[src.filter] ?? FREE_FILTERS['opencode-free'] }
    }
    return null
  }

  const doLoad = async (id, { force = false } = {}) => {
    const free = freeCfg()
    const provider = providers()[id]
    // 调用方（discovered/warm）已保证 provider 存在且带 base_url；这里不再重复判空（否则是测不到的死分支）
    const src = sourceOf(free, id)
    if (!src) {
      const st = { at: now(), models: [], error: '没有发现源（static 或 sources）', from: null, sig: `none:${id}` }
      cache.set(id, st)
      return st
    }
    if (src.kind === 'static') {
      const st = { at: now(), models: src.models, error: null, from: 'static', sig: `static:${id}` }
      cache.set(id, st)
      return st
    }
    const ttlMs = Math.max(30, Number(free.refresh_seconds ?? 300)) * 1000
    const prev = cache.get(id)
    if (!force && prev && prev.sig === src.url && now() - prev.at < ttlMs && prev.error === null) return prev
    try {
      const res = await fetchImpl(src.url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      const raw = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
      const models = [...new Set(raw.map((m) => (typeof m === 'string' ? m : m?.id)).filter((x) => typeof x === 'string' && x.length > 0).filter(src.filter))]
      const next = { at: now(), models, error: null, from: src.url, sig: src.url }
      cache.set(id, next)
      return next
    } catch (err) {
      // 拉不到就**保留上一份好列表**（免费池抖一下不该让链里突然没有免费候选）
      const next = { at: now(), models: prev?.models ?? [], error: String(err?.message ?? err).slice(0, 140), from: src.url, sig: src.url }
      cache.set(id, next)
      logger?.debug?.(`[gate] 免费车道发现失败 ${id}：${next.error}`)
      return next
    }
  }

  const load = (id, opts) => {
    if (!inflight.has(id)) {
      const p = doLoad(id, opts).finally(() => inflight.delete(id))
      inflight.set(id, p)
    }
    return inflight.get(id)
  }

  /**
   * 免费池的模态元数据（models.dev）：只拉一次，TTL 6h；失败保留上一份好数据。
   * 不能用 Zen 的 `/models`：它只有 id/object/created/owned_by，没有 modalities。
   */
  const loadModalities = async () => {
    const free = freeCfg()
    if (free.require_image !== true) return modalityCache
    const ttlMs = Math.max(60, Number(free.modality_ttl_seconds ?? 21_600)) * 1000
    if (modalityCache.map && now() - modalityCache.at < ttlMs) return modalityCache
    if (modalityCache.inflight) return modalityCache.inflight
    const url = typeof free.modality_url === 'string' && free.modality_url.length > 0 ? free.modality_url : 'https://models.dev/api.json'
    modalityCache.inflight = (async () => {
      try {
        const res = await fetchImpl(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(Math.max(timeoutMs, 15_000)),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = await res.json()
        const map = new Map()
        for (const [pid, provider] of Object.entries(body ?? {})) {
          const models = provider?.models
          if (!models || typeof models !== 'object') continue
          for (const [mid, model] of Object.entries(models)) {
            const input = Array.isArray(model?.modalities?.input)
              ? model.modalities.input
              : Array.isArray(model?.input)
                ? model.input
                : null
            map.set(`${pid}/${mid}`, input ? input.includes('image') : model?.attachment === true)
          }
        }
        modalityCache.map = map
        modalityCache.at = now()
        modalityCache.error = null
      } catch (err) {
        modalityCache.error = String(err?.message ?? err).slice(0, 140)
        logger?.debug?.(`[gate] 免费池模态元数据拉取失败（保留上一份）：${modalityCache.error}`)
      } finally {
        modalityCache.inflight = null
      }
      return modalityCache
    })()
    return modalityCache.inflight
  }

  const isCooling = (ref) => {
    const c = cooldowns.get(ref)
    if (!c) return false
    // until=0 表示"失败次数还没到阈值"：**保留计数**，不能当成已过期删掉（否则永远攒不到阈值）
    if (c.until === 0) return false
    if (now() >= c.until) {
      cooldowns.delete(ref)
      return false
    }
    return true
  }

  const denySet = () => new Set(asList(freeCfg().deny))
  const denied = (c, deny) => deny.has(c.ref) || deny.has(c.model)

  /** 当前可发现的免费候选（provider 顺序 × 目录顺序）。不发请求时靠 TTL 缓存。 */
  const discovered = async () => {
    const free = freeCfg()
    if (!free.enabled) return []
    const requireImage = free.require_image === true
    let modalities = null
    if (requireImage) {
      const m = await loadModalities()
      modalities = m.map
      // 元数据从未成功拿到 → 没有可靠证据证明哪个免费模型能吃图；宁可走付费，也不退回纯文本。
      if (!modalities) return []
    }
    const out = []
    for (const id of asList(free.providers)) {
      const provider = providers()[id]
      if (!provider?.base_url || !hasKey(provider)) continue
      const st = await load(id)
      for (const model of st.models ?? []) {
        const ref = `${id}/${model}`
        if (requireImage && modalities.get(ref) !== true) continue
        out.push({ provider: id, model, ref })
      }
    }
    return out
  }

  /** prefer 里可以是 full ref（`opencode/x`）或裸模型名；命中的排最前，其余保持发现序。 */
  const rank = (list, prefer) => {
    const out = []
    const seen = new Set()
    for (const p of prefer) {
      for (const c of list) {
        if (seen.has(c.ref)) continue
        if (c.ref === p || c.model === p) {
          out.push(c)
          seen.add(c.ref)
          break
        }
      }
    }
    for (const c of list) if (!seen.has(c.ref)) out.push(c)
    return out
  }

  const capFor = () => {
    const free = freeCfg()
    const maxAttempts = Math.max(1, Number(policy().max_fallback_attempts ?? 3))
    // 永远给付费兜底留一跳：免费最多占 maxAttempts - 1
    return Math.max(0, Math.min(Number(free.max ?? 0), maxAttempts - 1))
  }

  /**
   * 把 targets 里的 `@free` 换成本次要试的真实候选。
   * @returns {{targets: Array<object>, expanded: string[], dynamic: boolean}}
   */
  const expand = async (targets, { maxAttempts = null } = {}) => {
    const list = Array.isArray(targets) ? targets : []
    const hasToken = list.some((t) => t?.free)
    if (!hasToken) return { targets: list, expanded: [], dynamic: false }
    const base = list.filter((t) => !t?.free)
    const free = freeCfg()
    const cap = maxAttempts === null ? capFor() : Math.max(0, Math.min(Number(free.max ?? 0), Math.max(1, Number(maxAttempts)) - 1))
    if (!free.enabled || cap === 0) return { targets: base, expanded: [], dynamic: true }
    const deny = denySet()
    const explicit = new Set(base.map((t) => targetKey(t)))
    const all = (await discovered()).filter((c) => !denied(c, deny) && !isCooling(c.ref) && !explicit.has(c.ref))
    const picked = rank(all, asList(free.prefer)).slice(0, cap)
    const expandedTargets = picked.map((c) => ({ provider: c.provider, model: c.model, auto: true }))
    const out = []
    let injected = false
    for (const t of list) {
      if (t?.free) {
        if (!injected) {
          out.push(...expandedTargets)
          injected = true
        }
        continue
      }
      out.push(t)
    }
    return { targets: out, expanded: picked.map((c) => c.ref), dynamic: true }
  }

  /** 只对 `@free` 展开出来的候选记全局健康（显式候选沿用按 session 的冷却）。 */
  const noteAttempt = (attempt, ok) => {
    if (attempt?.auto !== true) return
    const providerId = attempt.provider?.id ?? attempt.provider
    const ref = `${providerId}/${attempt.model}`
    if (ok) {
      cooldowns.delete(ref)
      return
    }
    const free = freeCfg()
    const threshold = Math.max(1, Number(free.failure_threshold ?? 3))
    const cur = cooldowns.get(ref) ?? { fails: 0, until: 0 }
    cur.fails += 1
    if (cur.fails >= threshold) cur.until = now() + Math.max(0, Number(free.failure_cooldown_seconds ?? 600)) * 1000
    cooldowns.set(ref, cur)
  }

  /** 面板/快照用的运行态（不触发新的发现请求：只读缓存；缓存为空则如实报 0/未刷新）。 */
  const runtime = () => {
    const free = freeCfg()
    const provs = []
    for (const id of asList(free.providers)) {
      const provider = providers()[id]
      const st = cache.get(id)
      provs.push({
        id,
        ready: Boolean(provider?.base_url) && hasKey(provider),
        models: st?.models?.length ?? 0,
        error: st?.error ?? null,
        at: st?.at ?? null,
        source: st?.from ?? null,
      })
    }
    const cooling = [...cooldowns.entries()]
      .filter(([, c]) => now() < c.until)
      .map(([ref, c]) => ({ ref, fails: c.fails, until: c.until }))
    return {
      enabled: free.enabled !== false,
      max: Number(free.max ?? 0),
      cap: capFor(),
      providers: provs,
      cooling,
      prefer: asList(free.prefer),
      deny: asList(free.deny),
      require_image: free.require_image === true,
      modality_ready: Boolean(modalityCache.map),
      modality_error: modalityCache.error,
    }
  }

  /** 当前展开预览（面板用；会按 TTL 触发发现）。 */
  const snapshot = async () => {
    const free = freeCfg()
    const cfg = getConfig()
    let chain = null
    let expandedRefs = []
    if (free.enabled !== false && cfg?.chains) {
      const hit = Object.entries(cfg.chains).find(([, c]) => (c.targets ?? []).some((t) => t === FREE_TOKEN))
      if (hit) {
        chain = hit[0]
        const parsed = (hit[1].targets ?? []).map(parseTarget).filter(Boolean)
        const out = await expand(parsed, { maxAttempts: policy().max_fallback_attempts })
        expandedRefs = out.expanded
      }
    }
    return { ...runtime(), chain, expand: expandedRefs }
  }

  /** 启动/热更后的后台预热（失败静默，不阻塞）。 */
  const warm = () => {
    const free = freeCfg()
    if (free.enabled === false) return
    if (free.require_image === true) void loadModalities().catch(() => {})
    for (const id of asList(free.providers)) {
      if (providers()[id]?.base_url && hasKey(providers()[id])) void load(id).catch(() => {})
    }
  }

  return { expand, noteAttempt, isCooling, discovered, snapshot, runtime, warm, capFor }
}
