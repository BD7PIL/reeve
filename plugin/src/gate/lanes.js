// GATE 的路由与尝试计划 —— **纯逻辑**（可测的部分）。
//
// 路由优先级（含一条 omo 语义的细化）：
//   ① 请求的 model 就是链名（`tier1`）→ 走它；
//   ② 该 session 的 agent 有链，且请求的模型就是那条链的首选（或请求不是一个可直投的
//      `provider/model`）→ 走 agent 的链；
//   ③ 请求是一个可直投的 `provider/model`（provider 已在注册表里）→ 直投
//      —— 这条覆盖"人在 UI 里换了模型"：v1 时代那套也是"用户改模型就重建状态、尊重用户选择"；
//   ④ `chain_for_model` 命中（session/agent 不明时的兜底）→ 走那条链；
//   ⑤ `default_chain` → 走它；都没有 → null（调用方 404）。
//
// 尝试计划：静态过滤（provider 缺 base_url、键取不到、重复的 no-op）→ 会话状态（粘性起点、
// 冷却跳过、上限）。**第一个尝试永远保留**：哪怕全在冷却，请求也得有人接。
import { LANES } from './config.js'

/** `"provider/model"`：只在**第一个** `/` 切分（模型名本身可以带斜杠，如 9router 的 `oc/xxx`）。
 *  `@free` 是链里的**免费车道占位符**（请求时由 free.js 展开成真实候选；不是 provider）。
 *  `parseTarget('@free')` → `{ free: true }`。 */
export function parseTarget(spec) {
  const s = String(spec ?? '').trim()
  if (s === '@free') return { free: true }
  const i = s.indexOf('/')
  if (i <= 0 || i === s.length - 1) return null
  return { provider: s.slice(0, i), model: s.slice(i + 1) }
}

export const targetKey = (t) => (t?.free ? '@free' : `${t.provider}/${t.model}`)

/** 尝试的键（注意：attempt.provider 是**完整的 provider 对象**，要取 .id）。 */
export const attemptKey = (attempt) => `${attempt.provider.id}/${attempt.model}`

/** provider 的键：`none` = 不需要；`env.X` = 环境变量；其它 = 字面量（只允许本来就是公开的）；否则按 auth 列表找 auth.json。 */
export function resolveKeyFor(provider, { env = process.env, auth = {} } = {}) {
  if (provider.key === 'none') return { key: null, name: null }
  if (typeof provider.key === 'string' && provider.key.startsWith('env.')) {
    const v = env?.[provider.key.slice(4)]
    return typeof v === 'string' && v.length > 0 ? { key: v, name: provider.key } : null
  }
  if (typeof provider.key === 'string' && provider.key.length > 0) return { key: provider.key, name: `${provider.id}:literal` }
  for (const id of provider.auth ?? []) {
    const k = auth?.[id]?.key
    if (typeof k === 'string' && k.length > 0) return { key: k, name: `auth:${id}` }
  }
  return null
}

/** 该 provider 的模型目录端点（把 chat/completions 换成 models；只有 models_fetch 的 provider 会用）。 */
export const modelsPathOf = (provider) => String(provider.path ?? '').replace(/chat\/completions$/, 'models') || '/v1/models'

export function routeFor({ model, sessionID }, { config, sessions }) {
  if (typeof model !== 'string' || model.length === 0) return null
  const requested = parseTarget(model)
  const direct = config.providers?.[requested?.provider] ? requested : null
  const chainOf = (name, agent = null) => {
    const targets = config.chains[name].targets.map(parseTarget).filter(Boolean)
    return targets.length > 0 ? { kind: 'chain', chain: name, agent, targets, requestedModel: model } : null
  }
  // ① 请求的就是链名
  if (config.chains[model]) return chainOf(model)
  const agent = sessionID ? sessions.agentOf(sessionID) : null
  if (agent && config.agents[agent]) {
    const name = config.agents[agent]
    const primary = parseTarget(config.chains[name].targets[0])
    // ② 请求 == 该 agent 链的首选（或压根不是可直投的 provider/model）→ 走 agent 的链
    if (!direct || (primary && targetKey(primary) === targetKey(direct))) return chainOf(name, agent)
    // ③ 请求是**别的**可直投模型 → 尊重显式选择（人在 UI 里换了模型）
    return { kind: 'direct', chain: null, agent, targets: [direct], requestedModel: model }
  }
  // ④ 没有 agent 信息：chain_for_model 的显式声明优先于泛化直投
  if (config.chain_for_model[model]) return chainOf(config.chain_for_model[model], agent)
  if (direct) return { kind: 'direct', chain: null, agent, targets: [direct], requestedModel: model }
  // ⑤ 裸模型名（没有 `provider/` 前缀）→ 兜底链；写了 `provider/model` 却没人认识 → null（调用方 404）
  //    这一条是有意为之：绝不把"用户明确选的某个模型"悄悄换成兜底链里的另一个模型。
  if (!requested && config.default_chain) return chainOf(config.default_chain, agent)
  return null
}

/**
 * 一次请求要按什么顺序试哪些候选。
 * `keyPicker(provider)` 可注入：默认取"第一个有 key 的 auth id"；服务侧会传一个带轮转的实现
 * （同 provider 多把键时按序轮转；测试用确定性序钉住）。
 * @returns {{ chainName: string, agent: string|null, ordered: Array<object>, keys: string[], skipped: Array<{target:string, why:string}> }}
 */
export function planAttempts(route, { config, sessions, sessionID = null, keyPicker = null } = {}) {
  const chainName = route.chain ?? `direct:${targetKey(route.targets[0])}`
  const sid = sessionID ?? '(anon)'
  const pick = keyPicker ?? ((provider) => resolveKeyFor(provider, { env: config.env, auth: config.auth }))
  const skipped = []
  const seen = new Set()
  const staticTargets = []
  for (const t of route.targets) {
    if (t?.free) {
      skipped.push({ target: '@free', why: 'unexpanded' })
      continue
    }
    const key = targetKey(t)
    if (seen.has(key)) {
      skipped.push({ target: key, why: 'no-op' })
      continue
    }
    seen.add(key)
    const provider = config.providers[t.provider]
    if (!provider?.base_url) {
      skipped.push({ target: key, why: 'no-provider' })
      continue
    }
    const resolved = pick(provider)
    if (resolved === null) {
      skipped.push({ target: key, why: 'no-key' })
      continue
    }
    staticTargets.push({ provider, model: t.model, auto: t.auto === true, key: resolved.name, authorization: resolved.key === null ? null : `Bearer ${resolved.key}` })
  }
  const keys = staticTargets.map((t) => `${t.provider.id}/${t.model}`)
  // `@free` 展开出来的候选是**逐请求动态**的（列表会变），所以不能用按索引的粘性指针：
  // 动态链从 0 起，靠按 ref 的冷却（会话 + 免费车道全局）跳过刚失败过的项。
  const start = config.chains[route.chain] && route.kind === 'chain' && !route.dynamicFree ? sessions.startIndex(sid, chainName, keys) : 0
  let ordered = staticTargets.slice(start)
  const notCooling = ordered.filter((t) => !sessions.isCooling(sid, chainName, `${t.provider.id}/${t.model}`))
  if (notCooling.length > 0) ordered = notCooling
  ordered = ordered.slice(0, Math.max(1, Number(config.policy.max_fallback_attempts ?? 3)))
  return { chainName, agent: route.agent ?? null, ordered, keys, skipped }
}

/** 转发给上游时要剥掉的头（逐跳头 + 长度/编码 + authorization 由车道替换）。 */
export const STRIP_FORWARD_HEADERS = Object.freeze([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'proxy-authorization',
  'te',
  'trailer',
  'accept-encoding',
  'authorization',
])

export function forwardedHeaders(inHeaders, { authorization = null } = {}) {
  const out = {}
  const strip = new Set(STRIP_FORWARD_HEADERS)
  for (const [k, v] of Object.entries(inHeaders ?? {})) {
    if (v === undefined) continue
    if (strip.has(String(k).toLowerCase())) continue
    out[k] = v
  }
  if (authorization !== null) out.authorization = authorization
  return out
}

/**
 * 这一跳实际发什么。
 *   · passthrough 车道：头**逐字**转发（含 UA 与四个 x-opencode-session*：客户端身份是它的全部意义），只换 Authorization；
 *   · native 车道：只发最小集（content-type/accept/我们自己的 UA + Authorization）——不把会话头漏给第三方上游。
 * body：把 `model` 换成候选的模型名，其余原样（tools 等不动）；非 JSON body 原样透传。
 */
export function buildUpstreamRequest({ attempt, inHeaders, bodyText, version = 'gate' }) {
  const url = `${attempt.provider.base_url}${attempt.provider.path}`
  let headers
  if (attempt.provider.lane === LANES.PASSTHROUGH) {
    headers = forwardedHeaders(inHeaders, { authorization: attempt.authorization })
  } else {
    headers = {
      'content-type': inHeaders?.['content-type'] ?? 'application/json',
      accept: inHeaders?.accept ?? '*/*',
      'user-agent': `reeve-gate/${version}`,
    }
    if (attempt.authorization !== null) headers.authorization = attempt.authorization
  }
  let body = bodyText
  try {
    const parsed = JSON.parse(bodyText)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      parsed.model = attempt.model
      body = JSON.stringify(parsed)
    }
  } catch {
    // 非 JSON：原样透传（不去猜它）
  }
  return { url, headers, body }
}

/** 台账一行（**不带任何密钥**：只记 provider id、模型、键的"名字"）。
 *  `req` = 本次调用在本进程内的序号（把同一请求的多次尝试串起来）；`n` = 第几次尝试（1 起）。 */
export function attemptRow({ ts, chainName, agent, attempt, status, code, latencyMs, retries = 0, detail = null, req = null, n = null }) {
  const row = {
    ts,
    req,
    n,
    chain: chainName,
    agent: agent ?? null,
    provider: attempt.provider.id,
    model: attempt.model,
    lane: attempt.provider.lane,
    key: attempt.key ?? null,
    status,
    code: code ?? null,
    latency_ms: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
    retries,
    detail,
  }
  // 只有 `@free` 展开出来的候选才带这个标记（面板/统计据此区分"自动免费"与显式候选）
  if (attempt.auto === true) row.auto = true
  return row
}