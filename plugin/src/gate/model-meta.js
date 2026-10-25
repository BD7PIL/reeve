// 档位元数据（成本 / limit / 发布时间）的计算器 —— GET /gate/model-meta 的应答体。
//
// 语义是**首跳**：composer 弹层想显示的是"这个档位正常情况下打谁、多少钱、多大上下文"，
// 所以链里写谁首跳就是谁；`@free` 首跳 = 恒 $0（免费是语义，不需要数据）+ 池内已知条目的
// 最小 limit（全无数据 → `free.context_floor`，引擎按声明值提前压缩，宁可早压也不虚标）。
//
// 数据源就是 GATE 已经拉在手里的 models.dev（6h TTL，零新增出网）。链里的 provider id
// 与 models.dev 的键不一定同名（zhipuai-coding-plan vs zhipuai），按三级解析：
//   ① 精确 provider 键 ② canonical_model_id ③ 全局唯一的 model id。
// **查无 / 歧义 → 该字段整体省略**（弹层显示"—"），绝不编数——上游覆盖会漂，诚实优于猜测。
import { FREE_TOKEN } from './free.js'

/** models.dev 的查找索引（canonical / 裸 model id → 条目）；每次计算建一次，量级 ~13k 无感。 */
function buildIndex(raw) {
  const byCanonical = new Map()
  const byModelId = new Map()
  for (const [pid, provider] of Object.entries(raw ?? {})) {
    const models = provider?.models
    if (!models || typeof models !== 'object') continue
    for (const [mid, model] of Object.entries(models)) {
      if (!model || typeof model !== 'object') continue
      const entry = { provider: pid, id: mid, model }
      const canonical = typeof model.canonical_model_id === 'string' ? model.canonical_model_id : null
      if (canonical && !byCanonical.has(canonical)) byCanonical.set(canonical, entry)
      if (!byModelId.has(mid)) byModelId.set(mid, [])
      byModelId.get(mid).push(entry)
    }
  }
  return { byCanonical, byModelId }
}

/** 链里写的 ref（`<链provider>/<model>`）→ models.dev 条目；查无/歧义 → null。 */
function resolveRef(raw, index, ref) {
  if (!raw || !index) return null
  const slash = ref.indexOf('/')
  if (slash <= 0) return null
  const providerId = ref.slice(0, slash)
  const modelId = ref.slice(slash + 1)
  const exact = raw[providerId]?.models?.[modelId]
  if (exact && typeof exact === 'object') return { provider: providerId, id: modelId, model: exact }
  const canonical = index.byCanonical.get(`${providerId}/${modelId}`)
  if (canonical) return canonical
  const hits = index.byModelId.get(modelId)
  return hits && hits.length === 1 ? hits[0] : null
}

/** models.dev 条目 → 弹层元数据；缺的字段整个不出现。 */
function metaOf(model) {
  const out = {}
  const c = model?.cost
  if (c && Number.isFinite(c.input) && Number.isFinite(c.output)) {
    out.cost = {
      input: c.input,
      output: c.output,
      cache_read: Number.isFinite(c.cache_read) ? c.cache_read : 0,
      cache_write: Number.isFinite(c.cache_write) ? c.cache_write : 0,
    }
  }
  const l = model?.limit
  if (l && Number.isFinite(l.context) && Number.isFinite(l.output)) {
    out.limit = Number.isFinite(l.input) ? { context: l.context, output: l.output, input: l.input } : { context: l.context, output: l.output }
  }
  if (typeof model?.release_date === 'string' && model.release_date.length > 0) out.released = model.release_date
  return out
}

/**
 * 算当前配置下的档位元数据。
 * @param {object} opts
 * @param {object} opts.config 归一化的 GATE 配置（chains / chain_for_model / free）
 * @param {object|null} opts.raw models.dev 的解析对象（还没拉到 → 只有 @free 聚合与 floor）
 * @param {Array<{provider: string, model: string, ref: string}>} [opts.pool] 当前可发现的免费候选
 * @param {() => number} [opts.now]
 */
export function computeModelMeta({ config, raw, pool = [], now = Date.now }) {
  const index = raw ? buildIndex(raw) : null
  const models = new Map()
  const metaForRef = (ref) => {
    if (!models.has(ref)) {
      const hit = resolveRef(raw, index, ref)
      const meta = hit ? metaOf(hit.model) : {}
      models.set(ref, Object.keys(meta).length > 0 ? meta : null)
    }
    return models.get(ref)
  }

  const chains = {}
  for (const [name, chain] of Object.entries(config?.chains ?? {})) {
    const first = (chain?.targets ?? [])[0]
    if (typeof first !== 'string' || first.length === 0) continue
    chains[name] = first
    if (first !== FREE_TOKEN) void metaForRef(first) // @free 的元数据走下面的聚合，不按 ref 解析
  }

  // `@free` 聚合：成本恒 0；limit 取池内已知条目的最小值，全无数据 → floor。
  const floor = Math.max(1, Number(config?.free?.context_floor ?? 131_072))
  let minContext = null
  let minOutput = null
  for (const c of pool) {
    const hit = resolveRef(raw, index, c.ref)
    const l = hit?.model?.limit
    if (!l) continue
    if (Number.isFinite(l.context) && (minContext === null || l.context < minContext)) minContext = l.context
    if (Number.isFinite(l.output) && (minOutput === null || l.output < minOutput)) minOutput = l.output
  }
  models.set(FREE_TOKEN, {
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: minContext ?? floor, ...(minOutput !== null ? { output: minOutput } : {}) },
  })

  // tiers：chain_for_model 的每个键 → 其链首跳的元数据（查无 → null，插件回落静态兜底）。
  const tiers = {}
  for (const [modelId, chainName] of Object.entries(config?.chain_for_model ?? {})) {
    const first = chains[chainName]
    if (first === undefined) continue
    tiers[modelId] = first === FREE_TOKEN ? models.get(FREE_TOKEN) : metaForRef(first)
  }

  return {
    computedAt: new Date(now()).toISOString(),
    tiers,
    chains,
    models: Object.fromEntries(models),
  }
}
