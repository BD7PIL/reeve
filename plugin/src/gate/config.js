// GATE 配置加载与归一化。
//
// 配置来源（按序）：options.fallbackConfigPath → ~/.config/opencode/reeve-fallback.jsonc → 打包的 default-fallback.json。
// 规则与仓库其它组件同一条：**坏文件当作"未变更"**（保留上一份好配置、如实报问题），缺文件回落打包默认。
// jsonc 支持整行 `//` 注释（与引擎侧 opencode.jsonc 同风格）。
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 打包的兜底配置（无用户配置时用它）。 */
export const BUNDLED_FALLBACK_PATH = fileURLToPath(new URL('../../default-fallback.json', import.meta.url))

/**
 * 机器上的用户配置（三端共享同一份）。
 * 形状说明：`~/.config/opencode/reeve/` 这一个**目录**是三端共享面（开发机上是 junction → 仓内
 * `.config/opencode/reeve/`，对端由 ocrc sync 同步这个目录），配置文件放里面；以后要再加
 * "策略/车道"之类的小配置也进这个目录，别再散落。
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
      problems.push(`policy.${key} 类型不对（忽略）`)
      continue
    }
    policy[key] = v
  }
  policy.retry_on_errors = (Array.isArray(policy.retry_on_errors) ? policy.retry_on_errors : []).filter((n) => Number.isFinite(n))

  const providers = {}
  for (const [id, v] of Object.entries(asRecord(src.providers) ?? {})) {
    const p = asRecord(v)
    if (!p) {
      problems.push(`providers.${id} 不是对象（忽略）`)
      continue
    }
    if (typeof p.base_url !== 'string' || p.base_url.length === 0) {
      problems.push(`providers.${id} 缺 base_url（不可达，候选会被跳过）`)
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

  const chains = {}
  for (const [name, v] of Object.entries(asRecord(src.chains) ?? {})) {
    const targets = asStrings(asRecord(v)?.targets)
    if (targets.length === 0) {
      problems.push(`chains.${name} 没有 targets（忽略）`)
      continue
    }
    chains[name] = { targets }
  }

  const agents = {}
  for (const [agent, chain] of Object.entries(asRecord(src.agents) ?? {})) {
    if (typeof chain !== 'string' || !chains[chain]) {
      problems.push(`agents.${agent} 指向的链不存在：${String(chain)}（忽略）`)
      continue
    }
    agents[agent] = chain
  }

  const chainForModel = {}
  for (const [model, chain] of Object.entries(asRecord(src.chain_for_model) ?? {})) {
    if (typeof chain !== 'string' || !chains[chain]) {
      problems.push(`chain_for_model.${model} 指向的链不存在：${String(chain)}（忽略）`)
      continue
    }
    chainForModel[model] = chain
  }

  const defaultChain = typeof src.default_chain === 'string' && chains[src.default_chain] ? src.default_chain : Object.keys(chains)[0] ?? null
  if (defaultChain === null) problems.push('没有可用的链（default_chain 缺失）')

  return { schema: 1, policy, providers, chains, agents, chain_for_model: chainForModel, default_chain: defaultChain, problems }
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
      if (p === bundledPath) return { config: null, from: null, problems: [], error: `配置读不动：${String(err).slice(0, 160)}` }
    }
  }
  return { config: null, from: null, problems: [], error: '没有可读的配置（用户配置与打包默认都失败）' }
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