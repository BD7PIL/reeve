// 面板的中文显示映射：链名 / agent 名 / 服务商名 →「中文名 + 原始 ID」。
//
// 纪律：
//   · **只用于显示**。写回配置的永远是原始 ID —— 这里绝不参与 save/planSave。
//   · 未知 ID 回退原样显示（用户可以自建链/自定义模型，映射表不装作认识它们）。
//   · 品牌名（OpenCode/OpenRouter/NVIDIA/REEVE）不翻译。
//   · 术语表：GATE→路由引擎、agent→智能体、provider→服务商、candidate→模型、
//     ledger→任务记录、@free→免费车道。品牌与协议名（JSONL、P95）保留。

/** 链名 → 显示名（副标始终显示原始 ID，所以这里只管主标签）。 */
export const CHAIN_LABELS = Object.freeze({
  reasoning: '推理',
  standard: '通用',
  'free-first': '免费优先',
  vision: '视觉',
})

/** agent ID → 显示名。 */
export const AGENT_LABELS = Object.freeze({
  foreman: '编排',
  planner: '规划',
  advisor: '顾问',
  critic: '评审',
  executor: '执行',
  reviewer: '审查',
  scout: '侦察',
  librarian: '检索',
  looker: '视觉',
})

/** 服务商 ID → 显示名。 */
export const PROVIDER_LABELS = Object.freeze({
  opencode: 'OpenCode',
  openrouter: 'OpenRouter',
  nvidia: 'NVIDIA',
  'zhipuai-coding-plan': '智谱',
  deepseek: 'DeepSeek',
  lmuai: 'LMUAI',
})

/** 引擎档位（chain_for_model 的键）→ 显示名。 */
export const TIER_LABELS = Object.freeze({
  'reeve/flash': 'REEVE flash（免费优先）',
  'reeve/standard': 'REEVE standard（通用）',
  'reeve/pro': 'REEVE pro（强推理）',
  'reeve/multimodal': 'REEVE multimodal（视觉）',
})

/** 链名 → 主显示名；未知链回退原始 ID。 */
export const chainLabel = (chain) => CHAIN_LABELS[String(chain ?? '')] ?? String(chain ?? '')

/** 是不是内置链名（决定要不要把原始 ID 作为副标显示）。 */
export const hasChainLabel = (chain) => CHAIN_LABELS[String(chain ?? '')] !== undefined

/** agent ID → 显示名；未知回退原 ID。 */
export const agentLabel = (agent) => AGENT_LABELS[String(agent ?? '')] ?? String(agent ?? '')

/** 服务商 ID → 显示名；未知回退原 ID。 */
export const providerLabel = (provider) => PROVIDER_LABELS[String(provider ?? '')] ?? String(provider ?? '')

/** 档位模型全名 → 显示名；未知回退原 ID。 */
export const tierLabel = (model) => TIER_LABELS[String(model ?? '')] ?? String(model ?? '')

/** `provider/model` → { title, sub }：短模型名做标题，服务商中文名做副标。 */
export function modelRefParts(ref) {
  const s = String(ref ?? '')
  const i = s.indexOf('/')
  if (i <= 0) return { title: s, sub: '' }
  return { title: s.slice(i + 1), sub: providerLabel(s.slice(0, i)) }
}
