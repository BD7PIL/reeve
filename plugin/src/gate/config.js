// GATE 配置加载与归一化。
//
// 配置来源（按序）：options.fallbackConfigPath → ~/.config/opencode/reeve-fallback.jsonc → 打包的 default-fallback.json。
// 规则与仓库其它组件同一条：**坏文件当作"未变更"**（保留上一份好配置、如实报问题），缺文件回落打包默认。
// jsonc 支持整行 `//` 注释（与引擎侧 opencode.jsonc 同风格）。
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { t } from '../locale.js'

/** 打包的兜底配置（无用户配置时用它）。 */
export const BUNDLED_FALLBACK_PATH = fileURLToPath(new URL('../../default-fallback.json', import.meta.url))

/**
 * 机器上的用户配置（三端共享同一份）。
 * 形状说明：`~/.config/opencode/reeve/` 这一个**目录**是三端共享面（开发机上是 junction → 仓内
 * `.config/opencode/reeve/`，对端由 ocrc sync 同步这个目录），配置文件放里面；以后要再加
 * "策略/通道"之类的小配置也进这个目录，别再散落。
 */
export function defaultFallbackConfigPath({ home = homedir() } = {}) {
  return join(home, '.config', 'opencode', 'reeve', 'fallback.jsonc')
}

export const POLICY_DEFAULTS = Object.freeze({
  retry_on_errors: Object.freeze([401, 402, 403, 429, 500, 503, 529]),
  max_fallback_attempts: 3,
  cooldown_seconds: 60,
  restore_primary_after_cooldown: false,
  first_prompt_watchdog_ms: 90_000,
  provider_retries: 1,
  models_ttl_seconds: 300,
  session_ttl_seconds: 1800,
})

const DEFAULT_PATH = '/v1/chat/completions'
export const LANES = Object.freeze({ NATIVE: 'native', PASSTHROUGH: 'passthrough' })

/** 免费模型池的默认值（面板可改；见 docs/FREE-LANE.md）。 */
export const FREE_DEFAULTS = Object.freeze({
  enabled: true,
  max: 3,
  providers: Object.freeze(['opencode', 'openrouter', 'nvidia']),
  refresh_seconds: 300,
  failure_threshold: 3,
  failure_cooldown_seconds: 600,
  prefer: Object.freeze([]),
  deny: Object.freeze([]),
  // 免费池只保留 image-capable 模型：模态从 models.dev 动态读取（不再维护静态白名单）
  require_image: false,
  modality_url: 'https://models.dev/api.json',
  modality_ttl_seconds: 21_600,
  static: Object.freeze({}),
  sources: Object.freeze({
    // 公开模型列表（不需要键；拉不到只影响该 provider，请求照常降级到付费）
    opencode: Object.freeze({ url: 'https://opencode.ai/zen/v1/models', filter: 'opencode-free' }),
    openrouter: Object.freeze({ url: 'https://openrouter.ai/api/v1/models', filter: 'openrouter-free' }),
  }),
})

export function stripLineComments(text) {
  return String(text)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

const asRecord = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
const asStrings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length > 0) : [])

/**
 * 归一化 + 校验。**不抛**：把能用的一部分留下，问题如实收集进 `problems`（面板与日志据此报）。
 */
export function normalizeGateConfig(raw) {
  const problems = []
  const src = asRecord(raw) ?? {}
  const policy = { ...POLICY_DEFAULTS }
  const pSrc = asRecord(src.policy) ?? {}
  for (const key of Object.keys(POLICY_DEFAULTS)) {
    const v = pSrc[key]
    if (v === undefined) continue
    if (typeof v !== typeof POLICY_DEFAULTS[key] && !(Array.isArray(v) && Array.isArray(POLICY_DEFAULTS[key]))) {
      problems.push(t('gate.problem.policyType', { key }))
      continue
    }
    policy[key] = v
  }
  policy.retry_on_errors = (Array.isArray(policy.retry_on_errors) ? policy.retry_on_errors : []).filter((n) => Number.isFinite(n))

  const providers = {}
  for (const [id, v] of Object.entries(asRecord(src.providers) ?? {})) {
    const p = asRecord(v)
    if (!p) {
      problems.push(t('gate.problem.providerNotObject', { id }))
      continue
    }
    if (typeof p.base_url !== 'string' || p.base_url.length === 0) {
      problems.push(t('gate.problem.providerNoBaseUrl', { id }))
    }
    providers[id] = {
      id,
      base_url: typeof p.base_url === 'string' ? p.base_url.replace(/\/+$/, '') : '',
      path: typeof p.path === 'string' && p.path.length > 0 ? p.path : DEFAULT_PATH,
      auth: asStrings(p.auth).length > 0 ? asStrings(p.auth) : [id],
      key: typeof p.key === 'string' && p.key.length > 0 ? p.key : null,
      models: asStrings(p.models),
      models_fetch: p.models_fetch === true,
      lane: p.lane === LANES.PASSTHROUGH ? LANES.PASSTHROUGH : LANES.NATIVE,
      retries: Number.isFinite(p.retries) ? Number(p.retries) : policy.provider_retries,
    }
  }

  // 免费模型池：发现源 + @free 展开的偏好。全部有默认值；坏字段进 problems，不影响其余配置。
  const asInt = (v, min, max, dflt) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : dflt
  }
  const fSrc = asRecord(src.free) ?? {}
  const freeProviders = asStrings(fSrc.providers).length > 0 ? asStrings(fSrc.providers) : [...FREE_DEFAULTS.providers]
  const free = {
    enabled: fSrc.enabled !== false,
    max: asInt(fSrc.max, 0, 8, FREE_DEFAULTS.max),
    providers: freeProviders,
    refresh_seconds: asInt(fSrc.refresh_seconds, 30, 86_400, FREE_DEFAULTS.refresh_seconds),
    failure_threshold: asInt(fSrc.failure_threshold, 1, 20, FREE_DEFAULTS.failure_threshold),
    failure_cooldown_seconds: asInt(fSrc.failure_cooldown_seconds, 60, 86_400, FREE_DEFAULTS.failure_cooldown_seconds),
    prefer: asStrings(fSrc.prefer),
    deny: asStrings(fSrc.deny),
    require_image: fSrc.require_image === true,
    modality_url: typeof fSrc.modality_url === 'string' && fSrc.modality_url.length > 0 ? fSrc.modality_url : FREE_DEFAULTS.modality_url,
    modality_ttl_seconds: asInt(fSrc.modality_ttl_seconds, 60, 604_800, FREE_DEFAULTS.modality_ttl_seconds),
    static: {},
    sources: { ...FREE_DEFAULTS.sources },
  }
  for (const [id, list] of Object.entries(asRecord(fSrc.static) ?? {})) {
    if (!Array.isArray(list)) {
      problems.push(t('gate.problem.freeStaticNotArray', { id }))
      continue
    }
    free.static[id] = asStrings(list)
  }
  for (const [id, v] of Object.entries(asRecord(fSrc.sources) ?? {})) {
    const s = asRecord(v)
    if (!s || typeof s.url !== 'string' || s.url.length === 0) {
      problems.push(t('gate.problem.freeSourceNoUrl', { id }))
      continue
    }
    free.sources[id] = { url: s.url, filter: typeof s.filter === 'string' && s.filter.length > 0 ? s.filter : FREE_DEFAULTS.sources[id]?.filter ?? 'opencode-free' }
  }
  for (const id of free.providers) {
    if (!providers[id]) problems.push(t('gate.problem.freeProviderUnconfigured', { id }))
  }

  const chains = {}
  for (const [name, v] of Object.entries(asRecord(src.chains) ?? {})) {
    const targets = asStrings(asRecord(v)?.targets)
    if (targets.length === 0) {
      problems.push(t('gate.problem.chainNoTargets', { name }))
      continue
    }
    chains[name] = { targets }
  }

  const agents = {}
  for (const [agent, chain] of Object.entries(asRecord(src.agents) ?? {})) {
    if (typeof chain !== 'string' || !chains[chain]) {
      problems.push(t('gate.problem.agentMissingChain', { agent, chain: String(chain) }))
      continue
    }
    agents[agent] = chain
  }

  const chainForModel = {}
  for (const [model, chain] of Object.entries(asRecord(src.chain_for_model) ?? {})) {
    if (typeof chain !== 'string' || !chains[chain]) {
      problems.push(t('gate.problem.chainForModelMissingChain', { model, chain: String(chain) }))
      continue
    }
    chainForModel[model] = chain
  }

  const defaultChain = typeof src.default_chain === 'string' && chains[src.default_chain] ? src.default_chain : Object.keys(chains)[0] ?? null
  if (defaultChain === null) problems.push(t('gate.problem.noChains'))

  return { schema: 1, policy, providers, chains, agents, chain_for_model: chainForModel, default_chain: defaultChain, free, problems }
}

/**
 * 读配置：returns `{ config, from, problems, error }`。
 * `raw === null` 表示"这次没读到可用的一层"（调用方保留上一份好配置）。
 */
export async function loadGateConfig({ path = defaultFallbackConfigPath(), bundledPath = BUNDLED_FALLBACK_PATH, readFileImpl = readFile } = {}) {
  for (const p of [path, bundledPath]) {
    if (!p) continue
    try {
      const text = await readFileImpl(p, 'utf8')
      const parsed = JSON.parse(stripLineComments(text))
      const config = normalizeGateConfig(parsed)
      return { config, from: p, problems: config.problems, error: null }
    } catch (err) {
      // 用户配置读不动 → 试打包默认；打包默认也读不动 → 报错（调用方保留上一份）
      if (p === bundledPath) return { config: null, from: null, problems: [], error: t('gate.error.readFailed', { error: String(err).slice(0, 160) }) }
    }
  }
  return { config: null, from: null, problems: [], error: t('gate.error.noConfig') }
}

/**
 * 只 stat 的热更探针（与插件盯链文件的同一条纪律：**只 stat**，变了才重读）。
 * 返回 { stop }；`changed` 回调拿到新的 `{ config, from, error }`（坏文件由调用方决定保留旧的）。
 */
export function watchGateConfig({ path = defaultFallbackConfigPath(), bundledPath = BUNDLED_FALLBACK_PATH, intervalMs = 5000, onChange, readFileImpl = readFile, statImpl = stat }) {
  let marker = null
  const tick = async () => {
    let m = null
    try {
      const st = await statImpl(path)
      m = `${Number(st.mtimeMs)}:${Number(st.size)}`
    } catch {
      m = 'missing'
    }
    if (marker === null) {
      marker = m
      return
    }
    if (m === marker) return
    marker = m
    const next = await loadGateConfig({ path, bundledPath, readFileImpl })
    onChange?.(next)
  }
  const timer = setInterval(() => void tick().catch(() => {}), Math.max(200, intervalMs))
  timer.unref?.()
  // 立刻记一次基线：否则"启动后马上改文件"会被第一次 tick 当成基线吞掉（实测踩到）
  void tick().catch(() => {})
  return { stop: () => clearInterval(timer) }
}