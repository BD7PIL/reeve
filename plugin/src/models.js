// 四个档位的**模型注册** —— 让 opencode.jsonc 里不再需要一份 models 映射。
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

/** 四个档位。`images` 决定这一档声明不声明"能吃图"（只有视觉档声明）。 */
export const REEVE_TIERS = Object.freeze([
  { id: 'flash', modelID: 'reeve/flash', name: 'REEVE flash（免费优先链）', images: false },
  { id: 'coding', modelID: 'reeve/coding', name: 'REEVE coding（中型链）', images: false },
  { id: 'pro', modelID: 'reeve/pro', name: 'REEVE pro（强推理链）', images: false },
  { id: 'multimodal', modelID: 'reeve/multimodal', name: 'REEVE multimodal（视觉链）', images: true },
])

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
    variants: [],
    time: { released: 0 },
    cost: [],
    status: 'active',
    enabled: true,
    limit: { context: 200_000, output: 32_000 },
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
