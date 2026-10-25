// 档位元数据（成本/limit/发布时间）的内存缓存 —— 数据源是 GATE 的 `/gate/model-meta`。
//
// 为什么是"异步刷新 + 同步读"：引擎的 provider transform 回调是**同步**的（每次 rebuild
// 全量重放，见引擎 core/src/state.ts），不能 await。所以这里异步刷新，transform 只读最近
// 一份；一份都没有时调用方回落 `models.js` 的 STATIC_TIER_META。
//
// 刷新时机由 index.js 驱动：挂在既有的 GATE 状态轮询上（2s 一次、TTL 兜底、链热更时 force），
// 不另开定时器、不另开文件 watcher。签名（不含 computedAt）变了由调用方决定要不要
// `ctx.provider.reload()` 把新数据推进 composer。
//
// 失败纪律与 GATE 一致：拉不到就**保留上一份好数据**并如实记错误，绝不打断任何人。

/**
 * @param {object} opts
 * @param {() => string|null} opts.getGateBase 当前 GATE 的 `http://127.0.0.1:<port>`；没起 → null（跳过刷新）
 * @param {{debug?: Function}|null} [opts.logger]
 * @param {() => number} [opts.now]
 * @param {Function} [opts.fetchImpl]
 * @param {number} [opts.ttlMs] 刷新间隔下限（GATE 状态轮询每 2s 调一次，靠它挡掉重复拉取）
 * @param {number} [opts.timeoutMs] 单次拉取超时（环回请求，2s 足够；失败不影响任何请求）
 */
export function createTierMeta({ getGateBase, logger = null, now = Date.now, fetchImpl = fetch, ttlMs = 5 * 60_000, timeoutMs = 2_000 } = {}) {
  let cache = null
  let sig = ''
  let at = 0
  let inflight = null
  let lastError = null

  const refresh = async ({ force = false } = {}) => {
    const base = getGateBase()
    if (!base) return cache
    if (!force && cache && now() - at < ttlMs) return cache
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const res = await fetchImpl(`${base}/gate/model-meta`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = await res.json()
        if (!body || typeof body !== 'object' || !body.tiers || typeof body.tiers !== 'object') throw new Error('bad payload')
        const { computedAt: _computedAt, ...data } = body
        const nextSig = JSON.stringify(data)
        cache = data
        sig = nextSig
        at = now()
        lastError = null
      } catch (err) {
        lastError = String(err?.message ?? err).slice(0, 140)
        logger?.debug?.(`[reeve] 档位元数据刷新失败（保留上一份/兜底）：${lastError}`)
      } finally {
        inflight = null
      }
      return cache
    })()
    return inflight
  }

  return {
    refresh,
    /** 某档位（`reeve/<id>`）的动态元数据；没有 → null（调用方走静态兜底）。 */
    tierMeta: (tierModelID) => {
      const meta = cache?.tiers?.[tierModelID]
      return meta && typeof meta === 'object' && Object.keys(meta).length > 0 ? meta : null
    },
    /** 数据签名（不含 computedAt）——变了才值得 provider.reload。 */
    get signature() {
      return sig
    },
    /** 是否还在 TTL 内（调用方决定要不要现在刷）。 */
    fresh: () => cache !== null && now() - at < ttlMs,
    get error() {
      return lastError
    },
  }
}

/**
 * 把档位元数据合进 Model.Info。缺的字段不动（limit 是部分合并；cost/released 只在有数据时写）。
 * @param {{cost?: object, limit?: object, time?: {released: number}, id: string}} model 引擎的 Model.Info（可变草稿）
 * @param {{cost?: {input,output,cache_read,cache_write}, limit?: {context,output,input?}, released?: string}|null} meta
 * @returns {boolean} 是否有实际变化（调用方据此决定要不要 editor.models.set）
 */
export function applyTierMeta(model, meta) {
  if (!model || !meta) return false
  let changed = false
  if (meta.cost && Number.isFinite(meta.cost.input) && Number.isFinite(meta.cost.output)) {
    const next = [
      {
        input: meta.cost.input,
        output: meta.cost.output,
        cache: { read: Number.isFinite(meta.cost.cache_read) ? meta.cost.cache_read : 0, write: Number.isFinite(meta.cost.cache_write) ? meta.cost.cache_write : 0 },
      },
    ]
    if (JSON.stringify(model.cost) !== JSON.stringify(next)) {
      model.cost = next
      changed = true
    }
  }
  if (meta.limit && Number.isFinite(meta.limit.context)) {
    const next = {
      ...model.limit,
      context: meta.limit.context,
      ...(Number.isFinite(meta.limit.output) ? { output: meta.limit.output } : {}),
      ...(Number.isFinite(meta.limit.input) ? { input: meta.limit.input } : {}),
    }
    if (JSON.stringify(model.limit) !== JSON.stringify(next)) {
      model.limit = next
      changed = true
    }
  }
  if (typeof meta.released === 'string' && meta.released.length > 0) {
    const ts = Date.parse(meta.released)
    if (Number.isFinite(ts) && model.time?.released !== ts) {
      model.time = { ...(model.time ?? {}), released: ts }
      changed = true
    }
  }
  return changed
}
