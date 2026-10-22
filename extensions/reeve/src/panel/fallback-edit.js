// 面板的配置编辑引擎（**纯函数、零依赖**：不 import SDK，Node 里可直接测）。
//
// 它编辑的是 GATE 的配置 `~/.config/opencode/reeve/fallback.jsonc` —— 一份**带注释的 JSONC**。
// 保存时不做"整份重新序列化"：那会把使用者手写的注释、字段顺序、排版全冲掉
// （上一代面板写的是纯 JSON 的 chain.json，没有这个负担；换成共享配置后有了）。
//
// 做法：**只重写被编辑的那几节**（chains / agents / policy / chain_for_model / default_chain），
// 其余字节原样保留。做法本身要能兜底：
//   · 找得到小节（顶层 `"key": {…}`，字符串感知地扫到配对的 `}`）→ 只替换这一段的文本；
//   · 找不到（比如键压根没写过、或文件被改成了别的形状）→ 由调用方决定：插入新小节或整份写。
// 所有函数都是纯的：给文本 + 新值 → 新文本；坏输入抛带原因的错（面板把它显示出来）。
//
// 为什么值得有单测（check.mjs 里跑）：这里的 bug 会**静默吃掉使用者的注释**或写出坏 JSON，
// 而 GATE 遇到坏配置只会"保留上一份"（听起来安全，实际是"你保存了但它没生效"）。

/** 去掉整行 `//` 注释后解析（与插件侧同一套规则：注释只可能是整行）。 */
export function parseJsonc(text) {
  const stripped = String(text)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
  return JSON.parse(stripped)
}

/** 字符串感知的"从这个 `{` 找到它的配对 `}`"；返回 `}` 的下标。 */
export function matchBrace(text, openIndex) {
  if (text[openIndex] !== '{' && text[openIndex] !== '[') throw new Error('matchBrace：起点不是 { 或 [')
  const open = text[openIndex]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = openIndex; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === open) depth += 1
    else if (c === close) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  throw new Error('matchBrace：括号不配对')
}

/** 字符串感知的括号深度（`index` 之前已开、未闭的 `{`/`[` 数）。 */
export function depthAt(text, index) {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = 0; i < index; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') depth += 1
    else if (c === '}' || c === ']') depth = Math.max(0, depth - 1)
  }
  return depth
}

/** 顶层某个键的**值区间**（`{start, end}` 闭开区间）或 null。
 *  "顶层" = 键本身在根对象第一层（深度 1）—— 否则 `providers` 里一个叫 `chains` 的
 *  provider 会把真正的 chains 节顶掉（这种偷梁换柱不能发生）。
 *  值可以是对象/数组（按配对括号取），也可以是标量（取到同层的 `,` 或根对象收尾 `}` 之前）。 */
export function findTopLevelSection(text, key) {
  const needle = `"${key}"`
  let from = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at < 0) return null
    from = at + needle.length
    if (depthAt(text, at) !== 1) continue
    const rest = text.slice(from)
    const m = /^\s*:\s*([\s\S])/.exec(rest)
    if (!m) continue
    const valueAt = from + m[0].length - 1
    const c = text[valueAt]
    if (c === '{' || c === '[') {
      let end
      try {
        end = matchBrace(text, valueAt)
      } catch {
        return null
      }
      return { start: valueAt, end: end + 1 }
    }
    // 标量：扫到同层的 `,` 或收尾 `}`（字符串里的不算）
    let inStr = false
    let esc = false
    for (let i = valueAt; i < text.length; i++) {
      const ch = text[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === ',' || ch === '}') return { start: valueAt, end: i }
    }
    return null
  }
}

/** 把 JSON 值按 2 空格缩进渲染成文本（数组/对象/标量都行）。 */
export function renderValue(value, indent = 0) {
  const pad = '  '.repeat(indent)
  const inner = '  '.repeat(indent + 1)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map((v) => `${inner}${renderValue(v, indent + 1)}`)
    return `[\n${items.join(',\n')}\n${pad}]`
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length === 0) return '{}'
    const lines = keys.map((k) => `${inner}${JSON.stringify(k)}: ${renderValue(value[k], indent + 1)}`)
    return `{\n${lines.join(',\n')}\n${pad}}`
  }
  return JSON.stringify(value)
}

/**
 * 只替换顶层 `key` 这一节的文本；这一节不存在时在根对象末尾**追加**。
 * 返回 `{text, replaced: boolean}`。
 */
export function replaceSection(text, key, value) {
  const span = findTopLevelSection(text, key)
  const rendered = renderValue(value, 0).replace(/\n/g, '\n  ')
  if (span) {
    return { text: `${text.slice(0, span.start)}${rendered}${text.slice(span.end)}`, replaced: true }
  }
  // 追加：找一个能插的根对象收尾 `}`（文件最后一个 `}`）
  const closeAt = text.lastIndexOf('}')
  if (closeAt < 0) throw new Error('配置文件里没有根对象收尾的 } —— 不猜，拒绝写入')
  const before = text.slice(0, closeAt)
  const after = text.slice(closeAt)
  const needsComma = /[^{[\s,]\s*$/.test(before.replace(/\/\/[^\n]*\n?/g, ''))
  const glue = needsComma ? ',\n' : '\n'
  return { text: `${before}${glue}  ${JSON.stringify(key)}: ${rendered}\n${after}`, replaced: false }
}

/** 配置 → 面板的规范化视图（缺的补默认，坏的地方记进 problems）。 */
export function viewOf(doc) {
  const problems = []
  const out = { chains: {}, agents: {}, chain_for_model: {}, default_chain: null, policy: {} }
  const asRecord = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
  for (const [name, spec] of Object.entries(asRecord(doc?.chains) ?? {})) {
    const targets = Array.isArray(spec?.targets) ? spec.targets.map((t) => String(t)) : []
    if (targets.length === 0) problems.push(`chains.${name} 没有 targets（GATE 会忽略这一条链）`)
    out.chains[name] = { targets }
  }
  for (const [agent, chain] of Object.entries(asRecord(doc?.agents) ?? {})) {
    if (typeof chain === 'string' && chain) out.agents[agent] = chain
    else problems.push(`agents.${agent} 不是链名（忽略）`)
  }
  for (const [model, chain] of Object.entries(asRecord(doc?.chain_for_model) ?? {})) {
    if (typeof chain === 'string' && chain) out.chain_for_model[model] = chain
  }
  if (typeof doc?.default_chain === 'string' && doc.default_chain) out.default_chain = doc.default_chain
  out.policy = asRecord(doc?.policy) ?? {}
  out.free = freeViewOf(doc?.free)
  return { view: out, problems }
}

/**
 * 视图 → 面板保存时真正写出去的三节 + 校验。
 * 校验只看**结构性错误**（空链、引用了不存在的链、重名的候选），语义好坏留给使用者。
 */
export function planSave(view, { isRef = defaultIsRef } = {}) {
  const problems = []
  const chains = {}
  for (const [name, spec] of Object.entries(view?.chains ?? {})) {
    const seen = new Set()
    const targets = []
    for (const t of spec?.targets ?? []) {
      const ref = String(t ?? '').trim()
      if (!ref) continue
      if (!isRef(ref)) {
        problems.push(`chains.${name}：认不出的候选 ${ref}（要写成 provider/model）`)
        continue
      }
      if (seen.has(ref)) {
        problems.push(`chains.${name}：候选 ${ref} 重复（GATE 会当 no-op 跳过）`)
        continue
      }
      seen.add(ref)
      targets.push(ref)
    }
    if (targets.length === 0) {
      problems.push(`chains.${name}：一条候选都没有（GATE 会忽略这条链）`)
      continue
    }
    chains[name] = { targets }
  }
  if (Object.keys(chains).length === 0) problems.push('至少要有一条链')
  const agents = {}
  for (const [agent, chain] of Object.entries(view?.agents ?? {})) {
    if (!chain) continue
    if (!chains[chain] && chain !== view?.default_chain) problems.push(`agents.${agent}：指向不存在的链 ${chain}`)
    agents[agent] = chain
  }
  const chainForModel = {}
  for (const [model, chain] of Object.entries(view?.chain_for_model ?? {})) {
    if (!chain) continue
    if (!chains[chain]) problems.push(`chain_for_model.${model}：指向不存在的链 ${chain}`)
    chainForModel[model] = chain
  }
  const defaultChain = view?.default_chain ?? null
  if (defaultChain && !chains[defaultChain]) problems.push(`default_chain 指向不存在的链 ${defaultChain}`)
  const p = view?.policy ?? {}
  const num = (v, d) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v))
  const policy = {
    max_fallback_attempts: Math.max(1, num(p.max_fallback_attempts, 3)),
    cooldown_seconds: Math.max(0, num(p.cooldown_seconds, 60)),
    restore_primary_after_cooldown: p.restore_primary_after_cooldown === true,
    provider_retries: Math.max(0, num(p.provider_retries, 1)),
  }
  const free = freeViewOf(view?.free)
  return { chains, agents, chain_for_model: chainForModel, default_chain: defaultChain, policy, free, problems }
}

/** `provider/model`（模型名可带斜杠）；没有斜杠或斜杠在首尾都不算。`@free` 是链里的自动占位符。 */
export function defaultIsRef(ref) {
  const s = String(ref ?? '')
  if (s === '@free') return true
  const i = s.indexOf('/')
  return i > 0 && i < s.length - 1
}

const asStrings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length > 0) : [])
const clampInt = (v, min, max, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : dflt
}

/**
 * `free` 节的视图/保存共用归一化：保留未知键（例如 `sources` —— 面板不编辑它，
 * 但保存时绝不能把使用者手改的发现源冲掉），已知键按类型收敛并夹到安全范围。
 */
export function freeViewOf(raw) {
  const f = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const staticIn = f.static && typeof f.static === 'object' && !Array.isArray(f.static) ? f.static : {}
  const staticOut = {}
  for (const [id, list] of Object.entries(staticIn)) staticOut[id] = asStrings(list)
  return {
    ...f,
    enabled: f.enabled !== false,
    max: clampInt(f.max, 0, 8, 3),
    providers: Array.isArray(f.providers) ? asStrings(f.providers) : ['opencode', 'openrouter', 'nvidia'],
    refresh_seconds: clampInt(f.refresh_seconds, 30, 86_400, 300),
    failure_threshold: clampInt(f.failure_threshold, 1, 20, 3),
    failure_cooldown_seconds: clampInt(f.failure_cooldown_seconds, 60, 86_400, 600),
    prefer: asStrings(f.prefer),
    deny: asStrings(f.deny),
    static: staticOut,
  }
}

/**
 * 把一次保存**落到文本上**：只重写被改过的节，其余字节（含注释）保留。
 * 注意 `policy` 是整体替换（它的键少，整体写更好读）；`chains`/`agents`/`chain_for_model` 同理。
 */
export function applySave(text, planned, { sections = ['chains', 'agents', 'chain_for_model', 'policy', 'free', 'default_chain'] } = {}) {
  if (planned?.problems?.length) throw new Error(`配置有 ${planned.problems.length} 个问题，先改掉再保存：\n  ${planned.problems.join('\n  ')}`)
  let out = text
  let replaced = 0
  let appended = 0
  for (const key of sections) {
    const value = planned?.[key]
    if (value === undefined) continue
    const r = replaceSection(out, key, value)
    out = r.text
    if (r.replaced) replaced += 1
    else appended += 1
  }
  // 自校验：写出去的东西必须还能被解析（坏配置会被 GATE 拒收 —— "保存了但没生效"最难查）
  try {
    parseJsonc(out)
  } catch (err) {
    throw new Error(`写入前的自校验失败（配置仍原样保留）：${String(err?.message ?? err)}`)
  }
  return { text: out, replaced, appended }
}

/** 面板上的"这一条链谁在用"：agent → 链 的反查。 */
export function agentsForChain(view, chainName) {
  return Object.entries(view?.agents ?? {})
    .filter(([, c]) => c === chainName)
    .map(([a]) => a)
}

/** 候选排序建议：链上已用的、GATE 目录里的、引擎档位（面板只想给人一个好点的默认顺序）。 */
export function candidateList(snapshot, { exclude = [] } = {}) {
  const out = []
  const seen = new Set(exclude)
  const push = (ref, hint) => {
    if (seen.has(ref)) return
    seen.add(ref)
    out.push({ ref, hint })
  }
  for (const c of snapshot?.models?.candidates ?? []) push(c.ref, c.sources?.includes('gate') ? 'GATE 目录' : '链上/引擎')
  return out
}