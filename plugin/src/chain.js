// 链文件（`~/.reeve/chain.json`）↔ Bifrost 的 `governance.routing_rules` 的**唯一映射处**。
//
// 为什么需要这一层：链原本写死在链基座里（仓库 `proxy/config.json` / 插件自带的
// `default-chain.json`），改一次要重启 Bifrost。使用者要的是"面板里调顺序、加回退"——
// 那就得有一份**只属于 REEVE 的小配置**，由插件读、由面板写，派生出的规则用
// `/api/routing/rules` 热更（实测：热改能持久、不用重启）。
//
// 分工（别越界）：
//   · chain.json 只说三件事：每档位「先打谁」（targets）、「打不通再打谁」（fallbacks）。
//   · provider 的 base_url / key / 路径覆盖仍然只在链基座里（那属部署，要重启）。
//   · 派生出的规则 id 固定 `reeve-<tier>`，CEL 固定 `model == "reeve/<tier>"`。
//
// 纯函数 + 注入式 IO：全部可在单测里跑（`plugin/test/chain.mjs`）。

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 三个档位（顺序即面板里的展示顺序，也是 priority 10/20/30 的由来）。 */
export const TIER_ORDER = Object.freeze(['flash', 'pro', 'multimodal'])

export const TIER_PRIORITY = Object.freeze({ flash: 10, pro: 20, multimodal: 30 })

/** target 的 TTFT 上限（实测列在 targets 上，不是 rule 上）。 */
export const DEFAULT_TTFT_MS = 30_000

export const CHAIN_VERSION = 1

/** 与运行时规则做"是否有差异"比对时要看的字段（服务端字段如 config_hash 不算）。 */
export const RULE_FIELDS = Object.freeze([
  'name',
  'cel_expression',
  'enabled',
  'targets',
  'fallbacks',
  'priority',
  'scope',
  'description',
])

export const TIER_DESC = Object.freeze({
  flash: '便宜、量大：探索 / 检索 / 照文档干活。',
  pro: '强推理：编排 / 规划 / 评审 / 审查。',
  multimodal: '多模态能力档：需要读图 / 读 PDF 的调用。',
})

export function defaultChainPath({ home = homedir() } = {}) {
  return join(home, '.reeve', 'chain.json')
}

export function tierRuleId(tier) {
  return `reeve-${tier}`
}

/** 去掉整行 `//` 注释（链文件与仓库里的 proxy/config.json 同风格：注释只可能是整行）。 */
export function stripLineComments(text) {
  return String(text)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

export function parseChainText(text) {
  return JSON.parse(stripLineComments(text))
}

/**
 * `"provider/model"` → `{provider, model}`；`"provider/"`→ `{provider, model:null}`
 * （链基座的约定：同模型换 provider）。认不出就返回 null（由调用方记问题）。
 */
export function parseTierRef(ref) {
  if (ref && typeof ref === 'object') {
    const provider = typeof ref.provider === 'string' ? ref.provider.trim() : ''
    const model = typeof ref.model === 'string' ? ref.model.trim() : ''
    return provider ? { provider, model: model || null } : null
  }
  if (typeof ref !== 'string') return null
  const s = ref.trim()
  const i = s.indexOf('/')
  if (i <= 0) return null
  const provider = s.slice(0, i).trim()
  const model = s.slice(i + 1).trim()
  return provider ? { provider, model: model || null } : null
}

export function formatTierRef({ provider, model }) {
  return `${provider}/${model ?? ''}`
}

/**
 * 把链文件里的 `tiers` 收拾成规范形（面板写来的、人手写的都过这一关）。
 * 返回 `{ tiers, problems }` —— problems 非空时**也**返回能用的部分（如实报，不静默丢）。
 */
export function normalizeTiers(raw) {
  const problems = []
  const tiers = {}
  if (raw == null || typeof raw !== 'object') return { tiers, problems }
  for (const tier of TIER_ORDER) {
    const spec = raw?.[tier]
    if (spec == null) continue
    if (typeof spec !== 'object') {
      problems.push(`${tier}: 不是对象`)
      continue
    }
    const targets = []
    for (const t of Array.isArray(spec.targets) ? spec.targets : []) {
      const parsed = parseTierRef(t)
      if (!parsed || !parsed.model) problems.push(`${tier}: 认不出的 target ${JSON.stringify(t)}`)
      else targets.push(parsed)
    }
    const fallbacks = []
    for (const f of Array.isArray(spec.fallbacks) ? spec.fallbacks : []) {
      const parsed = parseTierRef(f)
      if (!parsed) problems.push(`${tier}: 认不出的 fallback ${JSON.stringify(f)}`)
      else fallbacks.push(parsed.model ? formatTierRef(parsed) : `${parsed.provider}/`)
    }
    if (targets.length === 0 && fallbacks.length > 0) {
      // 只有回退、没有首选 —— 等于把第一个回退提到首选（比"整档消失"更接近人的意图）
      const first = parseTierRef(fallbacks.shift())
      if (first) targets.push(first)
      problems.push(`${tier}: 没写 targets，把第一个 fallback 提为首选`)
    }
    if (targets.length === 0) {
      problems.push(`${tier}: 既没有 targets 也没有 fallbacks，跳过`)
      continue
    }
    tiers[tier] = {
      targets,
      fallbacks,
      ...(typeof spec.description === 'string' ? { description: spec.description } : {}),
      ...(Number.isFinite(spec.ttftMs) ? { ttftMs: Number(spec.ttftMs) } : {}),
    }
  }
  return { tiers, problems }
}

/**
 * 一个档位 → 一条 routing rule。
 * `base` 是链基座里同 id 的规则：链文件没写 description / ttftMs 时从它继承
 * （免得每次热更都把人工写好的中文说明冲掉）。
 */
export function tierToRule(tier, spec, { base = null, priority = null } = {}) {
  const targets = (spec?.targets ?? []).map((t) => ({
    provider: t.provider,
    model: t.model,
    weight: 1,
    ttft_timeout_ms: Number(spec?.ttftMs ?? base?.targets?.[0]?.ttft_timeout_ms ?? DEFAULT_TTFT_MS),
  }))
  // weight 必须合计为 1（多 target 时均分）
  if (targets.length > 1) for (const t of targets) t.weight = 1 / targets.length
  return {
    id: tierRuleId(tier),
    name: `reeve/${tier}`,
    description: spec?.description ?? base?.description ?? TIER_DESC[tier] ?? '',
    enabled: spec?.enabled ?? base?.enabled ?? true,
    cel_expression: `model == "reeve/${tier}"`,
    targets,
    fallbacks: [...(spec?.fallbacks ?? [])],
    scope: spec?.scope ?? base?.scope ?? 'global',
    priority: Number(priority ?? spec?.priority ?? TIER_PRIORITY[tier] ?? base?.priority ?? 100),
  }
}

/** 三个档位 → 规则数组（按 priority 升序）。 */
export function tiersToRoutingRules(tiers) {
  const out = []
  for (const tier of TIER_ORDER) {
    if (!tiers?.[tier]) continue
    out.push(tierToRule(tier, tiers[tier]))
  }
  return out.sort((a, b) => a.priority - b.priority)
}

/**
 * 把档位合到链基座上：**providers 等一切照旧，只替换 `reeve-*` 那几条规则**。
 * tiers 为空（链文件缺失/坏掉）时原样返回 —— 这就是"回落到现状"。
 */
export function applyTiers(chain, tiers) {
  const baseRules = chain?.governance?.routing_rules ?? []
  const derived = []
  for (const tier of TIER_ORDER) {
    if (!tiers?.[tier]) continue
    const id = tierRuleId(tier)
    derived.push(tierToRule(tier, tiers[tier], { base: baseRules.find((r) => r?.id === id) ?? null }))
  }
  if (derived.length === 0) return chain ?? {}
  const ids = new Set(derived.map((r) => r.id))
  const kept = baseRules.filter((r) => r?.id && !ids.has(r.id))
  const governance = { ...(chain?.governance ?? {}) }
  governance.routing_rules = [...kept, ...derived].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
  return { ...(chain ?? {}), governance }
}

/**
 * 反向：从链基座（或运行时规则）反推档位 —— 用在"链文件还没建"时给面板/快照一个起点。
 * @param {Array<{id?:string,name?:string,targets?:any[],fallbacks?:any[]}>} rules
 */
export function tiersFromRules(rules) {
  const tiers = {}
  for (const tier of TIER_ORDER) {
    const id = tierRuleId(tier)
    const rule = (rules ?? []).find((r) => r?.id === id || r?.name === `reeve/${tier}`)
    if (!rule) continue
    const targets = (rule.targets ?? [])
      .map((t) => parseTierRef(t))
      .filter((t) => t && t.model)
    if (targets.length === 0) continue
    const fallbacks = (rule.fallbacks ?? [])
      .map((f) => parseTierRef(f))
      .filter(Boolean)
      .map((f) => (f.model ? formatTierRef(f) : `${f.provider}/`))
    tiers[tier] = {
      targets,
      fallbacks,
      ...(rule.description ? { description: rule.description } : {}),
      ...(rule.targets?.[0]?.ttft_timeout_ms ? { ttftMs: Number(rule.targets[0].ttft_timeout_ms) } : {}),
    }
  }
  return tiers
}

export function tiersFromChainDoc(chain) {
  return tiersFromRules(chain?.governance?.routing_rules)
}

/** 排序后的规范 JSON —— 用于"有没有差异"的比对（键序不同不算差异）。 */
export function canonicalJson(value) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out = {}
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k])
      return out
    }
    return v
  }
  return JSON.stringify(walk(value))
}

/** 两条规则在关心字段上是否一致（键序无关）。 */
export function rulesSame(a, b) {
  return RULE_FIELDS.every((k) => canonicalJson(a?.[k]) === canonicalJson(b?.[k]))
}

/**
 * 期望规则 vs 运行时规则 → 差异（收敛与快照共用一份判断）。
 * @returns {{drifted: boolean, missing: string[], changed: string[], extra: string[]}}
 */
export function rulesDrift(desired, runtime) {
  const want = new Map((desired ?? []).filter((r) => r?.id).map((r) => [r.id, r]))
  const have = new Map((runtime ?? []).filter((r) => r?.id).map((r) => [r.id, r]))
  const missing = []
  const changed = []
  const extra = []
  for (const [id, rule] of want) {
    const got = have.get(id)
    if (!got) missing.push(id)
    else if (!rulesSame(got, rule)) changed.push(id)
  }
  for (const id of have.keys()) if (!want.has(id)) extra.push(id)
  return { drifted: missing.length + changed.length + extra.length > 0, missing, changed, extra }
}

/**
 * 读链文件。三种结果都要能区分（面板会显示"没有链文件=用基座"）：
 *   · 不存在        → { exists:false, doc:null, tiers:null }
 *   · 存在但读不动/坏 → { exists:true,  doc:null, error:'…' }（视为"未变更"，不炸）
 *   · 存在且能读     → { exists:true,  doc, tiers, problems, marker }
 * `marker` 是变更检测的记号（mtime+size）。**先 stat 再读**：万一读的这一刻文件正在被换
 * （面板写是 temp+rename），记号会偏旧 → 下一个 tick 再收敛一遍（幂等，无害）；
 * 反过来（记号偏新）就会漏掉一次变更，那才是真 bug。
 */
export async function readChainFile({ path, readFileImpl = readFile, statImpl = stat } = {}) {
  let st = null
  try {
    st = await statImpl(path)
  } catch {
    return { exists: false, path, doc: null, tiers: null, problems: [], marker: null, mtimeMs: null, error: null }
  }
  const marker = `${Number(st.mtimeMs)}:${Number(st.size)}`
  const base = { exists: true, path, marker, mtimeMs: Number(st.mtimeMs) }
  try {
    const text = await readFileImpl(path, 'utf8')
    const doc = parseChainText(text)
    const { tiers, problems } = normalizeTiers(doc?.tiers)
    return { ...base, doc, tiers, problems, error: null }
  } catch (err) {
    return { ...base, doc: null, tiers: null, problems: [], error: String(err?.message ?? err).slice(0, 160) }
  }
}

/** 面板要写的形状（插件侧只用来生成"初始链文件"的建议内容，不自动写）。 */
export function buildChainDoc(tiers, { now = Date.now(), version = CHAIN_VERSION } = {}) {
  const out = {}
  for (const tier of TIER_ORDER) {
    const spec = tiers?.[tier]
    if (!spec) continue
    out[tier] = {
      targets: (spec.targets ?? []).map((t) => ({ provider: t.provider, model: t.model })),
      fallbacks: [...(spec.fallbacks ?? [])],
      ...(spec.description ? { description: spec.description } : {}),
      ...(Number.isFinite(spec.ttftMs) ? { ttftMs: Number(spec.ttftMs) } : {}),
    }
  }
  return { version, updatedAt: now, tiers: out }
}

/**
 * 链文件 + 链基座 → **实际该用哪份规则**。四种情形，一个有意的区分：
 *
 *   ① 没有链文件                   → 用链基座（首次安装的常态，也是"回落现状"）
 *   ② 链文件好且有三档             → 用它派生（只换 `reeve-*` 三条，providers 来自基座）
 *   ③ 链文件坏（JSON 解析不了 /    → **当作"未变更"**：留上一份好的（previous），
 *      声明了档位但一条都没活下来）    不要因为一次手滑把线上路由翻回基座
 *   ④ 链文件好但没有档位            → 用链基座（`tiers: {}` 是"恢复默认"的合法写法）
 *
 * `effective === null` 只在 ③ 出现 —— 调用方必须"什么都不改"，而不是拿 null 当"用基座"。
 *
 * @param {{base: object, from: string, file: object, previous?: object|null}} args
 * @returns {{effective: object|null, tiers: object, source: string, derived: boolean, stale: boolean, problems: string[], error: string|null}}
 */
export function resolveChain({ base, from, file, previous = null }) {
  const problems = [...(file?.problems ?? [])]
  const error = file?.error ?? null
  const exists = file?.exists === true
  const parsed = exists && file?.doc != null
  const usable = parsed && Object.keys(file?.tiers ?? {}).length > 0
  const declaredTiers = parsed ? Object.keys(file?.doc?.tiers ?? {}).length : 0

  if (!exists) {
    return { effective: base, tiers: tiersFromChainDoc(base), source: from, derived: false, stale: false, problems, error: null }
  }
  if (usable) {
    return {
      effective: applyTiers(base, file.tiers),
      tiers: file.tiers,
      source: file.path,
      derived: true,
      stale: false,
      problems,
      error: null,
    }
  }
  if (!parsed || declaredTiers > 0) {
    // 坏文件 → 当作未变更
    return {
      effective: null,
      tiers: previous?.tiers ?? tiersFromChainDoc(base),
      source: previous?.source ?? from,
      derived: previous?.derived === true,
      stale: true,
      problems,
      error: error ?? '链文件里的档位一条都没解析出来',
    }
  }
  // 好文件、明确没有档位 → 回落到链基座
  return { effective: base, tiers: tiersFromChainDoc(base), source: from, derived: false, stale: false, problems, error: null }
}