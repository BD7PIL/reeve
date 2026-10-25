// 档位的**模型注册** —— 让 opencode.jsonc 里不再需要一份 models 映射。
//
// 为什么能做：v2 的插件 API 有 `ctx.provider.transform(editor => editor.models.set(id, models))`
//（`packages/plugin/src/promise/provider.ts` @v2.0.27），`Model.Info` 也能从最小形状造出来。
//
// 规则（顺序即优先级）：
//   - 配置里已经写了的模型条目**不动**（配置说话时以配置为准）；
//   - 只补上缺的那几个档位；
//   - 端点（baseURL / key）**插件注册不了** —— `Provider.Info` 只有 {id,name,activation,package,integrationID}，
//     `Connection.Info` 只是凭据引用，`Integration.Method` 只是"怎么拿凭据"，都没有 URL。
//     所以配置里那两行是**irreducible** 的（见 config/opencode.sample.jsonc）。
//
// 另一处简化：代理端口不再让用户重复写 —— 从 `providers.reeve.settings.baseURL` 里推。

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 五个档位。全部声明能吃图：引擎才不会在发给 GATE 之前剥掉附件。
 * 真正“这档能不能收图”由 GATE 的图片路由决定：
 *   reasoning 的 glm-5.3 是纯文本 → 图片请求改走 vision；
 *   其余档位的链目标本身就是 image-capable（reeve/free 的免费池自带 require_image 过滤）。
 *
 * reeve/free 是免费池专用链（free-only = [@free]）：候选只有免费模型池，池空或
 * 全败即 502，永不落到付费——这是档位语义，不是故障。
 *
 * limit 是各档**付费候选的最小值**（GLM-5.3(-flash) / DeepSeek V4 Flash / LMUAI 均
 * 1M 上下文；输出最小 131,072）。免费池是动态的，不参与静态 limit——窄上下文的
 * 免费模型由引擎在请求时自行截断。0.1.x 曾写死 200k/32k，严重低估（同款 GLM 直连
 * 显示 1M），会提前触发压缩——0.2.0 修正。
 */
export const REEVE_TIERS = Object.freeze([
  { id: 'flash', modelID: 'reeve/flash', name: 'REEVE flash', images: true },
  { id: 'standard', modelID: 'reeve/standard', name: 'REEVE standard', images: true },
  { id: 'pro', modelID: 'reeve/pro', name: 'REEVE pro', images: true },
  { id: 'multimodal', modelID: 'reeve/multimodal', name: 'REEVE multimodal', images: true },
  { id: 'free', modelID: 'reeve/free', name: 'REEVE free', images: true },
])

/** 付费四档共享的 limit（链上付费候选的最小值；见 REEVE_TIERS 注释）。
 *  reeve/free 例外：链里没有付费候选，context 用 FREE_CONTEXT_FLOOR（见 STATIC_TIER_META 注释）。 */
export const TIER_LIMIT = Object.freeze({ context: 1_000_000, output: 131_072 })

/** reeve/free 的 context 下限（与 GATE `free.context_floor` 默认值一致）：免费池模型在
 *  models.dev 查不到 limit 时声明这个值，引擎照它提前压缩——不虚标 1M 让上游报错烧链。 */
export const FREE_CONTEXT_FLOOR = 131_072

/** 档位元数据的**静态兜底**（2026-10-25 从 models.dev 钉死）。只在 GATE 的
 *  `/gate/model-meta` 拿不到（冷启动 / GATE 没起 / 查无条目）时用；动态值永远优先。
 *  cost 语义是**链首跳**：standard/multimodal 首跳 zhipu glm-5.3-flash、pro 首跳 glm-5.3、
 *  flash/free 首跳 `@free`（$0 = 首跳免费；回落到付费候选时实际花费更高）。 */
export const STATIC_TIER_META = Object.freeze({
  flash: { cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
  standard: { cost: { input: 0.15, output: 0.5, cache_read: 0.03, cache_write: 0 }, released: '2026-08-26' },
  pro: { cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 }, released: '2026-08-14' },
  multimodal: { cost: { input: 0.15, output: 0.5, cache_read: 0.03, cache_write: 0 }, released: '2026-08-26' },
  free: { cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
})

/** 五档共享的推理强度变体（id = reasoningEffort，形状与 opencode.jsonc 的 v2 variants 一致）。
 *  引擎把选中的变体翻译成请求体里的 `reasoning_effort`，GATE 只换 model、其余透传；
 *  上游不认识某个档位时由链换下一候选。每次 buildTierModel 生成新数组，不共享可变引用。 */
export const TIER_VARIANTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])

/** 造一个最小的 `Model.Info`（照 `Model.Info.default()` 的形状，能力按档位给）。 */
export function buildTierModel(tier, providerID = 'reeve') {
  return {
    id: tier.id,
    modelID: tier.modelID,
    providerID,
    name: tier.name,
    capabilities: {
      tools: true,
      input: tier.images ? ['text', 'image'] : ['text'],
      output: ['text'],
    },
    variants: TIER_VARIANTS.map((id) => ({ id, settings: { reasoningEffort: id } })),
    time: { released: 0 },
    cost: [],
    status: 'active',
    enabled: true,
    limit: tier.id === 'free' ? { context: FREE_CONTEXT_FLOOR, output: TIER_LIMIT.output } : { ...TIER_LIMIT },
  }
}

/**
 * 合并：保留已有的，补上缺的档位。
 * @param {Array<{id: string}>} existing 运行时已有的模型（可能为空）
 * @param {ReadonlyArray<typeof REEVE_TIERS[number]>} tiers
 * @param {string} providerID
 * @returns {Array<object>} 要 set 回去的完整数组
 */
export function mergeTierModels(existing, tiers = REEVE_TIERS, providerID = 'reeve') {
  const have = new Set((existing ?? []).map((m) => m?.id).filter(Boolean))
  const added = tiers.filter((t) => !have.has(t.id)).map((t) => buildTierModel(t, providerID))
  return [...(existing ?? []), ...added]
}

/**
 * 从引擎配置里读 `providers.reeve.settings.baseURL` → 代理该在哪个 host:port 上服务。
 * 读不到就返回 null（调用方退回 options.proxy.port / 默认端口）。
 * **只读**：插件永不写引擎配置。
 */
export function parseEndpointFromConfig(text, providerID = 'reeve') {
  try {
    const stripped = String(text)
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    const json = JSON.parse(stripped)
    const base = json?.providers?.[providerID]?.settings?.baseURL
    if (typeof base !== 'string' || base.length === 0) return null
    const url = new URL(base)
    return { baseURL: base, host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) }
  } catch {
    return null
  }
}

/** 读配置目录里的 opencode.json / opencode.jsonc（哪个先读到用哪个）。 */
export async function readEndpoint({ configDir = null, readFileImpl = readFile, providerID = 'reeve' } = {}) {
  const dir = configDir ?? join(homedir(), '.config', 'opencode')
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    try {
      const text = await readFileImpl(join(dir, name), 'utf8')
      const found = parseEndpointFromConfig(text, providerID)
      if (found) return { ...found, from: join(dir, name) }
    } catch {
      /* 换下一个 */
    }
  }
  return null
}
/**
 * 要藏起来的内置 agent —— 前台只留编排者（见 PROGRESS §6.1）。
 * 由插件在启动时设置 `hidden: true`，所以配置里不再需要 `agents` 块。
 * 希望某个内置 agent 重新可见：删掉这里的 id，或者在配置里显式写 `agents.<id>.hidden = false`
 * （**配置后应用**，会覆盖这里的设置）。
 */
export const BUILTINS_TO_HIDE = Object.freeze(['build', 'plan', 'general', 'explore'])

/** 把默认 agent 设为编排者（存在才设；配置里的 `default_agent` 优先级更高）。 */
export function pickDefaultAgent(editor, id = 'foreman') {
  try {
    if (editor.get(id)) {
      editor.default(id)
      return true
    }
  } catch {
    /* 读不到就当不存在 */
  }
  return false
}

/**
 * GATE 该在哪个 `host:port` 上服务（纯函数，四级回落：显式 gate → 旧 proxy 键 → 配置里的端点 → 默认）。
 * 抽出来是为了**可测**：真实回落链要碰机器上的真实配置（和真实的 18080），不该在单测里跑。
 */
export function resolveGateEndpoint({ gate = null, proxy = null, endpoint = null, fallbackPort = 8080, fallbackHost = '127.0.0.1' } = {}) {
  return {
    port: Number(gate?.port ?? proxy?.port ?? endpoint?.port ?? fallbackPort),
    host: gate?.host ?? endpoint?.host ?? fallbackHost,
  }
}
