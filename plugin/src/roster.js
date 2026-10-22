// subagent 名册 —— 注入到 `subagent` 工具的描述里。
//
// 为什么需要它：REEVE 的 8 个 subagent 都标了 `hidden: true`（前台不可见、
// openchamber 的 @ 提及列表也不列它们）。代价是**引擎自己的
// "Available subagents:" 宣传段也会把它们滤掉**（v2.0.32
// `packages/core/src/tool/plugin/subagent.ts` 的 context 钩子只列 `!agent.hidden`）。
// → 于是由本插件把名册**补回工具描述**：人看不见，模型看得见。
//
// 这份名册与 `agents/*.md` 一一对应（名字必须逐字一致，否则 subagent 工具会回
// "Unknown agent"）。`plugin/test/unit.mjs` 里有一条测试盯着"名字不漂移"。

export const ROSTER_MARKER = 'REEVE 名册'

/** name = agents/<name>.md 的文件名；duty 与那些文件的 description 同义。 */
export const SUBAGENT_ROSTER = Object.freeze([
  { name: 'scout', duty: '代码库侦察：回答"X 在哪里、怎么工作的"，带 路径:行号。只读' },
  { name: 'librarian', duty: '外部资料检索：外部库/规范/上游怎么规定的，每条带 URL。只读' },
  { name: 'planner', duty: '把需求写成"不携带上下文的执行者也能照着干完"的实施文档。不写代码' },
  { name: 'critic', duty: '计划评审：多轮 × 多角度，默认立场是不通过。只读' },
  { name: 'advisor', duty: '对抗性顾问：找出方案最可能失败的那个假设与代价。只读' },
  { name: 'executor', duty: '执行者：照实施文档干活，唯一的实现者。不重新设计、不扩大范围' },
  { name: 'reviewer', duty: '代码 diff 审查：五维 + 结构化输出（severity/category/path/行号/锚点）。只读' },
  { name: 'looker', duty: '视觉识别：读取磁盘上的图片/PDF/截图，回答颜色、布局、OCR、图表。只读' },
])

/**
 * 生成要追加到 `subagent` 工具描述后面的段落。
 * @param {ReadonlyArray<{name:string,duty:string}>} roster
 */
export function buildSubagentRoster(roster = SUBAGENT_ROSTER) {
  return [
    `可用 subagent（${ROSTER_MARKER} —— 它们在前台不可见，只能由你委派；\`agent\` 参数逐字取下面的名字）：`,
    ...roster.map((a) => `- ${a.name}: ${a.duty}`),
  ].join('\n')
}

/**
 * 幂等地把名册接进一段工具描述：已经有标记就原样返回（钩子每回合都会触发）。
 * @returns {string}
 */
export function withRoster(description, roster = SUBAGENT_ROSTER) {
  const base = typeof description === 'string' ? description : ''
  if (base.includes(ROSTER_MARKER)) return base
  return base.length > 0 ? `${base}\n\n${buildSubagentRoster(roster)}` : buildSubagentRoster(roster)
}