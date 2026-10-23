// 面板的显示辅助：**技术标识不翻译**。
//
// 纪律：
//   · 链名 / agent / provider / 档位模型都是配置与引擎里的 ID，原样显示；
//     强行译成“推理/通用/侦察/智谱”只会让面板和配置文件对不上，读者还得反查。
//   · 解释性文案（分区标题、说明、下一步提示）保持中文。
//   · 品牌名（OpenCode/OpenRouter/NVIDIA/LMUAI/DeepSeek）保留原文。
//   · `modelRefParts` 只做展示拆分：短模型名做标题，provider ID 做副标；不翻译。

/** `provider/model` → { title, sub }：短模型名做标题，provider ID 做副标。 */
export function modelRefParts(ref) {
  const s = String(ref ?? '')
  const i = s.indexOf('/')
  if (i <= 0) return { title: s, sub: '' }
  return { title: s.slice(i + 1), sub: s.slice(0, i) }
}

/** 链 ID 原样显示。 */
export const chainLabel = (chain) => String(chain ?? '')

/** agent ID 原样显示。 */
export const agentLabel = (agent) => String(agent ?? '')

/** provider ID 原样显示。 */
export const providerLabel = (provider) => String(provider ?? '')

/** 档位模型全名原样显示。 */
export const tierLabel = (model) => String(model ?? '')

/** 链 ID 永远显示原文，所以不再额外重复一遍原始 ID。 */
export const hasChainLabel = () => false
