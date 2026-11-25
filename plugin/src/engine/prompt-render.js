// E1 引擎数据面渲染器（R.1②④⑤；蓝图 .zcode/plans/next-round-plan-v4.md R 节 R.1 逐条写死）。
//
// 职责：步间数据面的占位词法（R.1②，写死两条严格语法）与渲染（R.1④，纯函数导出件——
// 二期 dry_run 直接复用，dry_run 即其消费方，缝留好）与注入上限（R.1⑤，渲染期检查——
// output 是运行时产物编译期不可见，所以上限检查在渲染期不在编译期）。
//
// 占位词法（R.1②，逐字写死）：
//   仅两条严格语法——`{{outputs.<stepId>}}`（整对象）与 `{{outputs.<stepId>.<key>}}`（恰一层 key）。
//   无空白容差：`{{ outputs.x }}` 不匹配（编译错）。`<key>` 域 = 不含 `.` 与 `}` 的非空串、
//   恰一层——含点即按深 key 编译错；数组下标 = 编译错（两处文案同：「深数据请整对象引用或走
//   文件总线」）。被引用 stepId 禁止 `.`、`}` 与空白——该约束落在 declaration.js（validateDeclaration
//   步级约束，含点号 stepId 从源头消灭 `a.b` 歧义；本文件只管词法形状）。一切形如 `{{…}}` 而不
//   匹配两条语法者一律编译错（含字面 `{{`——prompt 需要字面花括号时改写文风或走文件总线，
//   取舍写进 SKILL §11）；未闭合的 `{{` 同编译错。单独出现的 `}}`/单个花括号不是占位符形状，
//   不扫描不报错。
//
// 渲染（R.1④）：单遍解析、仅限模板本体——先渲染后组装附言（retryPrompt/escalationPrompt 的
//   附言与答复文本中的字面 `{{` 因此不参与解析，调用方在 scheduler dispatch 期先 renderPrompt
//   再拼附言）。解析值一律 JSON.stringify 后注入（整对象与一层 key 同口径；注入字节的记账口径
//   与注入文本逐字节一致，杜绝「账面」与「实际」两套）。纯函数：不抛、不碰时钟/IO/随机，
//   任何垃圾输入都返形状良好的结果。
//
// 注入上限（R.1⑤）：单步全部占位符解析值 stringify 后 UTF-8 字节总和 ≤ STEP_OUTPUT_LIMIT_BYTES
//   （= 32768，与 journal 写入面上限同值对齐，防 O(N×payload) 写放大——常量单一事实来源在
//   本文件，scheduler 的写入侧检查 import 同一份）。重复引用重复累计；模板字面量不计入。
//   渲染后 prompt 豁免 8000 字符 schema 上限（那是模板本体的约束，声明校验器管；渲染后可达
//   ~40KB 是有意设计，非口径顺延——driver.js create 面本就不复制 8000 上限）。
export const STEP_OUTPUT_LIMIT_BYTES = 32768

/** 整对象引用：`{{outputs.<stepId>}}`——stepId 域不含 `.`、`}` 与空白（词法层）。 */
const REF_WHOLE = /^outputs\.([^.}\s]+)$/
/** 一层 key 引用：`{{outputs.<stepId>.<key>}}`——key 域不含 `.` 与 `}` 的非空串，恰一层。 */
const REF_KEYED = /^outputs\.([^.}\s]+)\.([^}.]+)$/
/** 数组下标形状（`outputs.x[0]`）——按 R.1② 一律编译错，先于两条合法语法判定。 */
const REF_SUBSCRIPT = /^outputs\.[^.\s}]*\[/
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 单个 `{{…}}` 内串的词法判定（不抛）。匹配两条语法 → { ok:true, stepId, key|null }
 * （key=null 即整对象引用）；不匹配 → { ok:false, error:编译错文案 }（文案按形状分型：
 * 数组下标/深 key 同归「深数据」，空白容差单列，其余归「不匹配语法」）。
 */
function matchPlaceholder(inner) {
  if (REF_SUBSCRIPT.test(inner)) {
    return { ok: false, error: `占位符 "{{${inner}}}"：数组下标不支持——深数据请整对象引用或走文件总线` }
  }
  const whole = inner.match(REF_WHOLE)
  if (whole) return { ok: true, stepId: whole[1], key: null }
  const keyed = inner.match(REF_KEYED)
  if (keyed) return { ok: true, stepId: keyed[1], key: keyed[2] }
  if (inner !== inner.trim()) {
    return {
      ok: false,
      error: `占位符 "{{${inner}}}"：无空白容差——写 "{{outputs.<stepId>}}" 或 "{{outputs.<stepId>.<key>}}"（花括号内侧不留空白）`,
    }
  }
  if (/^outputs\.[^.}\s]+\.[^.}]*\./.test(inner)) {
    return { ok: false, error: `占位符 "{{${inner}}}"：多层 key 不支持——深数据请整对象引用或走文件总线` }
  }
  return {
    ok: false,
    error: `占位符 "{{${inner}}}" 不匹配占位语法（仅 {{outputs.<stepId>}} 与 {{outputs.<stepId>.<key>}} 两形；字面花括号请改写文风或走文件总线）`,
  }
}

/**
 * 扫描模板里的全部占位符（编译期与渲染期共用的同一词法；纯函数不抛）。
 * @param {string} template 模板本体（声明步的 prompt）
 * @returns {{ ok: boolean, refs: string[], errors: string[] }}
 *   refs = 被引用 stepId（首现序去重；供引用三查用）；errors = 词法编译错文案
 *   （调用方自行加 path 前缀，如 `steps[0].prompt: …`）。ok === (errors.length === 0)。
 */
export function scanTemplate(template) {
  const refs = []
  const errors = []
  if (typeof template !== 'string') return { ok: false, refs, errors: ['模板必须是字符串'] }
  let pos = 0
  while (true) {
    const open = template.indexOf('{{', pos)
    if (open === -1) break
    const close = template.indexOf('}}', open + 2)
    if (close === -1) {
      errors.push(`未闭合的 "{{"（缺配对 "}}"）：${JSON.stringify(template.slice(open, open + 24))}——字面花括号请改写文风或走文件总线`)
      break
    }
    const verdict = matchPlaceholder(template.slice(open + 2, close))
    if (verdict.ok) {
      if (!refs.includes(verdict.stepId)) refs.push(verdict.stepId)
    } else {
      errors.push(verdict.error)
    }
    pos = close + 2
  }
  return { ok: errors.length === 0, refs, errors }
}

/**
 * 渲染模板（R.1④ 纯函数导出件；不抛）。outputs 只读—— plain object（stepId → 产出）或
 * Map 同形；缺产出/缺 key 按失败返回（宁失败不猜）。解析值一律 JSON.stringify 注入；
 * 注入字节 = 逐占位符 stringify 文本的 UTF-8 字节和（重复引用重复累计；模板字面量不计）。
 *
 * @param {string} template 模板本体（先渲染后组装附言——附言由调用方拼在返回的 prompt 之后）
 * @param {object|Map} outputs stepId → 结构化产出（journal done 迁移 payload.output）
 * @returns {{ ok: true, prompt: string, injectedBytes: number, refs: string[] }} 渲染成功；
 *          prompt = 渲染后全文（不再含 `{{outputs.…}}` 占位符），injectedBytes = 注入字节总和，
 *          refs = 被引用 stepId（首现序去重）
 *        | {{ ok: false, reason: 'unmatched-placeholder', error, errors?, refs? }}
 *          模板含不匹配占位语法的 `{{…}}`（未过编译校验的模板；error/errors 为词法文案）
 *        | {{ ok: false, reason: 'missing-output', stepId, key? }} 被引用步产出不可得
 *        | {{ ok: false, reason: 'missing-key', stepId, key }} 被引产出上取不到该 key
 *        | {{ ok: false, reason: 'injection-over-limit', bytes, limit }}
 *          注入字节总和超 STEP_OUTPUT_LIMIT_BYTES（R.1⑤；scheduler 据此 failed，不可重试）
 */
export function renderPrompt(template, outputs) {
  if (typeof template !== 'string') {
    return { ok: false, reason: 'unmatched-placeholder', error: '模板必须是字符串', refs: [] }
  }
  const scan = scanTemplate(template)
  if (!scan.ok) {
    return { ok: false, reason: 'unmatched-placeholder', error: scan.errors[0], errors: scan.errors, refs: scan.refs }
  }
  const get = (id) => {
    if (isPlainObject(outputs) && Object.hasOwn(outputs, id)) return { found: true, value: outputs[id] }
    if (outputs instanceof Map && outputs.has(id)) return { found: true, value: outputs.get(id) }
    return { found: false }
  }
  let prompt = ''
  let injectedBytes = 0
  let pos = 0
  while (true) {
    const open = template.indexOf('{{', pos)
    if (open === -1) {
      prompt += template.slice(pos)
      break
    }
    prompt += template.slice(pos, open)
    const close = template.indexOf('}}', open + 2)
    const m = matchPlaceholder(template.slice(open + 2, close)) // scan 已过，必 ok
    const got = get(m.stepId)
    if (!got.found || got.value === undefined) {
      return { ok: false, reason: 'missing-output', stepId: m.stepId, ...(m.key !== null ? { key: m.key } : {}) }
    }
    let value = got.value
    if (m.key !== null) {
      if ((!isPlainObject(value) && !Array.isArray(value)) || !Object.hasOwn(value, m.key) || value[m.key] === undefined) {
        return { ok: false, reason: 'missing-key', stepId: m.stepId, key: m.key }
      }
      value = value[m.key]
    }
    const injected = JSON.stringify(value)
    if (injected === undefined) {
      return { ok: false, reason: 'missing-output', stepId: m.stepId, ...(m.key !== null ? { key: m.key } : {}) }
    }
    injectedBytes += Buffer.byteLength(injected, 'utf8')
    prompt += injected
    pos = close + 2
  }
  if (injectedBytes > STEP_OUTPUT_LIMIT_BYTES) {
    return { ok: false, reason: 'injection-over-limit', bytes: injectedBytes, limit: STEP_OUTPUT_LIMIT_BYTES }
  }
  return { ok: true, prompt, injectedBytes, refs: scan.refs }
}
