// E1 引擎 escalation（P4-E；蓝图 unified-run-plan-p0-p5.md §P4「escalation 分支暂停/兄弟继续，
// T4.1 门」，E1 规格 .zcode/plans/e1-construction-spec.md §3「escalation 走 onEscalate 回调，
// P4 接面板，E1 先落 journal blocked + 台账」）。
//
// 职责：问句产出的识别 + 恢复派发 prompt 的组装——纯函数，无时钟、无 IO、无 journal 面
// （时钟/fault/回调注入面都在消费方 scheduler.js 的构造参数里，§6 纪律）。
//
// 「步产出问句」判定口径（P4-E 约定，全引擎唯一事实来源）：result.status === 'done' 且
// text 是合法 JSON **对象**、且对象带非空字符串 `question` 字段。其余一切 done 产出都不是
// 问句（E1「done 即产出」口径不变；escalation 选项缺省时调度器根本不做本判定）。问句之外
// 的对象键原样保留在 output 里（面板可读，引擎不解释、不校验）。
//
// 调度侧语义（scheduler.js 消费，T4.1）：
//   问句 → 步 running→blocked（台账记 blocked，payload 带 question）+ journal 记 escalated
//   审计事件 + onEscalate 恰一次；依赖闭包内的未派步停在 declared（挂起——readySteps 要求
//   deps 全 done，天然不派），无依赖的兄弟步照常派发与完成（只暂停依赖分支）。
//   答复 → answerFor 非阻塞拉到非空字符串：journal 记 escalation-answered、blocked→dispatching
//   （P4-E 在 journal 状态机新增的唯一恢复重入边，attempts/lastDispatchAt 照 dispatching 语义
//   刷新——超时窗口重开），以 escalationPrompt 组装的「原 prompt + 问句 + 答复」重派新会话。
/** 问句判定键（步产出 JSON 对象里标识问句的字段名）。 */
export const ESCALATION_QUESTION_KEY = 'question'

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 判定一份 done 产出是不是问句。不是 → null；是 → { question, output }
 * （question = 问句字符串；output = 解析后的完整对象，深含义由调用方自担——本函数不深拷贝，
 * JSON.parse 产物天然独占）。任何解析失败/形状不符都安静地返 null（问句识别永不抛错）。
 */
export function parseQuestion(text) {
  if (typeof text !== 'string') return null
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null
  const question = parsed[ESCALATION_QUESTION_KEY]
  if (typeof question !== 'string' || question.length === 0) return null
  return { question, output: parsed }
}

/**
 * 恢复派发的 prompt：原 prompt + 问句 + 人工答复（与 ask.js retryPrompt 同风格：确定性模板，
 * 测试按本函数算 mock 场景的 match.prompt，再断言实际 create 的 prompt 逐字符相等）。
 */
export function escalationPrompt(prompt, question, answer) {
  const notice = `[reeve escalation] 本步上一轮产出了一个待裁决问句（步已挂起等待人工答复）。以下是人工答复，请依据答复继续完成本步并给出最终产出。\n问句：${question}\n答复：${answer}`
  return `${prompt}\n\n${notice}`
}
