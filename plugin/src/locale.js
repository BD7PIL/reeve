// 插件侧宿主可见文案的语言层。
//
// 为什么需要：GATE 的 config problems、免费模型池的发现错误、端点自举的 detail、
// 统计的空响应标签都会进快照，面板原样显示给使用者。面板已经跟随宿主语言，
// 这些字符串不能仍是硬编码中文（英文宿主会出现"英文壳 + 中文错误"）。
//
// 来源顺序（`options.locale === 'auto'` 或未设置时）：
//   ① `REEVE_LOCALE` 环境变量（测试/运维显式指定）
//   ② OpenChamber 的 settings.json（`locale` 字段；桌面端与引擎同一用户）
//   ③ `OPENCODE_LOCALE` / `LC_ALL` / `LANG`
//   ④ 英文
//
// 纪律：ID（链名 / provider / agent / 模型 / 配置键）永不翻译；上游 provider 的报错原文透传。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const EN = {
  'gate.problem.policyType': 'policy.{key} has the wrong type (ignored)',
  'gate.problem.providerNotObject': 'providers.{id} is not an object (ignored)',
  'gate.problem.providerNoBaseUrl': 'providers.{id} has no base_url (unreachable; candidates are skipped)',
  'gate.problem.freeStaticNotArray': 'free.static.{id} is not an array (ignored)',
  'gate.problem.freeSourceNoUrl': 'free.sources.{id} has no url (ignored)',
  'gate.problem.freeProviderUnconfigured': 'free.providers lists an unconfigured provider: {id} (skipped)',
  'gate.problem.chainNoTargets': 'chains.{name} has no targets (ignored)',
  'gate.problem.agentMissingChain': 'agents.{agent} points at a missing chain: {chain} (ignored)',
  'gate.problem.chainForModelMissingChain': 'chain_for_model.{model} points at a missing chain: {chain} (ignored)',
  'gate.problem.noChains': 'No usable chains (default_chain is missing)',
  'gate.error.readFailed': 'Cannot read the config: {error}',
  'gate.error.noConfig': 'No readable config (both the user config and the bundled default failed)',
  'free.error.noSource': 'No discovery source (static or sources)',
  'free.error.emptyResponse': 'Empty response',
  'stats.error.readLedger': 'Cannot read the request ledger: {error}',
  'stats.unknownChain': '(no chain)',
  'stats.unknownProvider': '(unknown)',
  'stats.unknownAgent': '(not attributed)',
  'endpoint.exists': 'providers.reeve already exists (add-only)',
  'endpoint.invalidJson': 'Config is not valid JSON (untouched): {error}',
  'endpoint.noRoot': 'No top-level object found (untouched)',
  'endpoint.verifyFailed': 'baseURL missing after insert (not written)',
  'endpoint.insertedInvalid': 'Invalid JSON after insert (not written): {error}',
  'endpoint.addedInProviders': 'Added providers.{id} inside the providers object',
  'endpoint.addedNewKey': 'Added providers.{id} (new providers key)',
  'endpoint.noFile': 'No config file to edit (create it via the app or launcher)',
  'endpoint.created': 'Created the config file',
  'manual.warning':
    'reeve/manual was removed in 0.2.0 (it was a single-target tier; pick a model in the composer instead). ' +
    'Change "model": "reeve/manual" to "reeve/standard" and remove the manual chain from the fallback config.',
}

const ZH = {
  'gate.problem.policyType': 'policy.{key} 类型不对（忽略）',
  'gate.problem.providerNotObject': 'providers.{id} 不是对象（忽略）',
  'gate.problem.providerNoBaseUrl': 'providers.{id} 缺 base_url（不可达，候选会被跳过）',
  'gate.problem.freeStaticNotArray': 'free.static.{id} 不是数组（忽略）',
  'gate.problem.freeSourceNoUrl': 'free.sources.{id} 缺 url（忽略）',
  'gate.problem.freeProviderUnconfigured': 'free.providers 含未配置的 provider：{id}（会被跳过）',
  'gate.problem.chainNoTargets': 'chains.{name} 没有 targets（忽略）',
  'gate.problem.agentMissingChain': 'agents.{agent} 指向的链不存在：{chain}（忽略）',
  'gate.problem.chainForModelMissingChain': 'chain_for_model.{model} 指向的链不存在：{chain}（忽略）',
  'gate.problem.noChains': '没有可用的链（default_chain 缺失）',
  'gate.error.readFailed': '配置读不动：{error}',
  'gate.error.noConfig': '没有可读的配置（用户配置与打包默认都失败）',
  'free.error.noSource': '没有发现源（static 或 sources）',
  'free.error.emptyResponse': '空响应',
  'stats.error.readLedger': '读台账失败：{error}',
  'stats.unknownChain': '(未标链)',
  'stats.unknownProvider': '(未知)',
  'stats.unknownAgent': '(未标注)',
  'endpoint.exists': 'providers.reeve 已存在（只加不改）',
  'endpoint.invalidJson': '配置不是合法 JSON（不碰）：{error}',
  'endpoint.noRoot': '找不到顶层对象（不碰）',
  'endpoint.verifyFailed': '插入后校验不到 baseURL（不写）',
  'endpoint.insertedInvalid': '插入后不是合法 JSON（不写）：{error}',
  'endpoint.addedInProviders': '在 providers 对象里新增 providers.{id}',
  'endpoint.addedNewKey': '新建 providers 键并写入 providers.{id}',
  'endpoint.noFile': '没有配置文件可改（由使用者/启动器创建）',
  'endpoint.created': '新建配置文件',
  'manual.warning':
    'reeve/manual 已在 0.2.0 移除（单目标档位；会话里直接选模型即可）。' +
    '请把配置里的 "model": "reeve/manual" 改成 "reeve/standard"，并删掉 fallback 配置里的 manual 链。',
}

let locale = 'en'

export function normalizeLocale(value) {
  return typeof value === 'string' && /^zh(?:-|_|$)/i.test(value) ? 'zh-CN' : 'en'
}

/** 选项 → 环境 → 英文。只读一次 settings（失败不影响运行）。 */
export function detectLocale(options = {}, env = process.env, readFileImpl = readFileSync) {
  const explicit = options?.locale
  if (explicit && explicit !== 'auto') return normalizeLocale(explicit)
  if (env.REEVE_LOCALE) return normalizeLocale(env.REEVE_LOCALE)
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), '.config')
  try {
    const settings = JSON.parse(readFileImpl(join(configHome, 'openchamber', 'settings.json'), 'utf8'))
    if (settings?.locale) return normalizeLocale(settings.locale)
  } catch {
    /* 没有 OpenChamber 配置（CLI / 服务端）→ 看环境变量 */
  }
  const fromEnv = env.OPENCODE_LOCALE || env.LC_ALL || env.LANG || ''
  return normalizeLocale(fromEnv)
}

export function setLocale(value) {
  locale = normalizeLocale(value)
  return locale
}

export const getLocale = () => locale

export function t(key, vars = null) {
  const table = locale === 'zh-CN' ? ZH : EN
  let out = table[key] ?? EN[key] ?? key
  if (vars) {
    out = out.replace(/\{(\w+)\}/g, (whole, name) => (vars[name] == null ? whole : String(vars[name])))
  }
  return out
}
