// E1 引擎声明校验器（S1；施工规格 .zcode/plans/e1-construction-spec.md §3 / T3.1）。
//
// 依赖方向：declaration.js ← declaration.schema.json——结构性约束（允许字段、必填、
// 类型、prompt ≤8000、maxAttempts ≥1、timeoutMs ≥1000）从 schema 文件读，本文件不复制数字；
// schema 表达不了的图性质（stepId 唯一、deps 无环/无自指/无未知引用）与 R.1 数据面编译检查
// （stepId 字符约束、占位词法、引用三查——词法判定与渲染共用 prompt-render.js）在这里用代码补。
// validateDeclaration(decl) → { ok, errors[] }：纯函数，不抛（任何垃圾输入都返形状良好的
// 结果），错误累积（一次报全，不首错即停）。本校验器无时钟/无随机/fault 面——那些注入点
// 属于 journal/scheduler/ask（规格 §6），声明校验是纯数据判定。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { scanTemplate } from './prompt-render.js'

/** schema 文件路径（打包面内，与 declaration.js 同目录）。 */
export const DECLARATION_SCHEMA_PATH = fileURLToPath(new URL('./declaration.schema.json', import.meta.url))
/** 解析后的 schema 文档；下游（driver/scheduler）可复用同一份，别再各自读盘。 */
export const DECLARATION_SCHEMA = JSON.parse(readFileSync(DECLARATION_SCHEMA_PATH, 'utf8'))

const ROOT = Object.freeze({ label: 'declaration' })
const TYPE_LABEL = Object.freeze({ string: '字符串', integer: '整数', object: '对象', array: '数组', boolean: '布尔', null: 'null' })

/** 步级允许字段与默认值——都从 schema 取（单一事实来源），供下游与测试交叉核对。 */
const STEP_FIELDS_SCHEMA = DECLARATION_SCHEMA.properties.steps.items.properties
export const DECLARATION_FIELDS = Object.freeze(Object.keys(DECLARATION_SCHEMA.properties))
export const STEP_FIELDS = Object.freeze(Object.keys(STEP_FIELDS_SCHEMA))
export const DECLARATION_DEFAULTS = Object.freeze({
  maxAttempts: STEP_FIELDS_SCHEMA.maxAttempts.default,
  timeoutMs: STEP_FIELDS_SCHEMA.timeoutMs.default,
})

const describeValue = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const joinPath = (parent, key) => (parent === null ? key : `${parent}.${key}`)

function matchesType(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'object':
      return isObject(value)
    case 'array':
      return Array.isArray(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return true // 未声明的 type 关键字不设限
  }
}

/**
 * 走 schema 子集（本仓用到的关键字：type / required / properties /
 * additionalProperties（false → 未知字段报错；schema 对象 → 未声明键逐键校验，Q5 metadata 用；
 * true/缺省 → 放行）/ items / minLength / maxLength / minimum）。
 * 类型不符即停在当前节点（内层形状留给类型修复后重报），错误累积不中断。
 */
function walkSchema(value, node, path, errors) {
  const type = node.type
  if (type !== undefined && !matchesType(value, type)) {
    if (type === 'integer' && typeof value === 'number') errors.push(`${label(path)}: 必须是整数（得到 ${value}）`)
    else errors.push(`${label(path)}: 必须是${TYPE_LABEL[type] ?? type}（得到 ${describeValue(value)}）`)
    return
  }
  if (isObject(value)) {
    for (const key of node.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${label(path)}: 缺失必填字段 "${key}"`)
    }
    const props = node.properties
    const additional = node.additionalProperties
    for (const key of Object.keys(value)) {
      const sub = props?.[key]
      if (sub !== undefined) {
        walkSchema(value[key], sub, joinPath(path, key), errors)
        continue
      }
      if (additional === false) {
        if (props !== undefined) errors.push(`${label(path)}: 未知字段 "${key}"（允许：${Object.keys(props).join(', ')}）`)
        continue
      }
      if (isObject(additional)) walkSchema(value[key], additional, joinPath(path, key), errors)
    }
  }
  if (Array.isArray(value) && node.items) {
    value.forEach((el, i) => {
      walkSchema(el, node.items, `${path ?? ''}[${i}]`, errors)
    })
  }
  if (typeof value === 'string') {
    if (node.minLength !== undefined && value.length < node.minLength) {
      errors.push(node.minLength === 1 ? `${label(path)}: 不能为空` : `${label(path)}: 长度 ${value.length} 低于下限 ${node.minLength}`)
    }
    if (node.maxLength !== undefined && value.length > node.maxLength) {
      errors.push(`${label(path)}: 长度 ${value.length} 超过上限 ${node.maxLength}`)
    }
  }
  if (typeof value === 'number' && node.minimum !== undefined && value < node.minimum) {
    errors.push(`${label(path)}: 必须 ≥ ${node.minimum}（得到 ${value}）`)
  }
}

/** 根层报错用 "declaration" 前缀，内层直接 path（steps[0].prompt）。 */
function label(path) {
  return path === null ? ROOT.label : path
}

/** Levenshtein 编辑距离（单字符插入/删除/替换，单位代价；两行 DP，O(len b) 空间）。 */
function editDistance(a, b) {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i]
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

/**
 * 未知 stepId 的最近候选（Q1 Did-you-mean；纯函数不抛）。
 * 算法写死（蓝图 .zcode/plans/next-round-plan-v4.md Q 节 Q1）：取编辑距离最小的候选，
 * 并列取字典序首；最小距离 > `max(2, ⌈unknown 长度/2⌉)` 时返 null 不附（防无关建议噪声）。
 * 消费场景两处：deps 未知引用（本文件 graphErrors）+ R.1 引用三查的未知 stepId
 * （R.1 落地后接本函数——含点号 stepId 的词法编译错同获候选；lightflow compiler.py:71-81 先例）。
 */
export function nearestStepId(unknown, candidates) {
  if (typeof unknown !== 'string' || unknown.length === 0) return null
  const threshold = Math.max(2, Math.ceil(unknown.length / 2))
  let best = null
  let bestDist = Infinity
  for (const candidate of candidates ?? []) {
    if (typeof candidate !== 'string') continue
    const d = editDistance(unknown, candidate)
    if (d < bestDist || (d === bestDist && (best === null || candidate < best))) {
      best = candidate
      bestDist = d
    }
  }
  return best !== null && bestDist <= threshold ? best : null
}

/** 图性质：stepId 唯一；deps 无未知引用、无自引用；其余边做环检测（自引用已单报，不进图）。 */
function graphErrors(decl, errors) {
  const steps = decl.steps
  if (!Array.isArray(steps)) return

  const firstSeen = new Map() // stepId → 首见下标
  steps.forEach((step, i) => {
    const id = isObject(step) ? step.stepId : undefined
    if (typeof id !== 'string') return
    if (firstSeen.has(id)) errors.push(`steps[${i}].stepId: 重复 "${id}"（首见 steps[${firstSeen.get(id)}]）`)
    else firstSeen.set(id, i)
  })

  const graph = new Map() // stepId → deps（自引用除外；非字符串/非数组的形状错已由 schema 层报）
  steps.forEach((step, i) => {
    if (!isObject(step) || typeof step.stepId !== 'string' || !Array.isArray(step.deps)) return
    const edges = []
    step.deps.forEach((dep, j) => {
      if (typeof dep !== 'string') return
      if (dep === step.stepId) errors.push(`steps[${i}].deps[${j}]: 自引用 "${dep}"`)
      else {
        if (!firstSeen.has(dep)) {
          const hint = nearestStepId(dep, firstSeen.keys())
          errors.push(`steps[${i}].deps[${j}]: 未知引用 "${dep}"（不在任何 stepId 里${hint ? `——最近候选 "${hint}"？` : ''}）`)
        }
        edges.push(dep)
      }
    })
    graph.set(step.stepId, edges)
  })

  // 环：DFS 灰染，灰边即环；每条灰边报一条（同一 SCC 多个环会各报一次，可接受）。
  const color = new Map() // 0 白 1 灰 2 黑
  const stack = []
  const visit = (id) => {
    color.set(id, 1)
    stack.push(id)
    for (const dep of graph.get(id) ?? []) {
      const c = color.get(dep) ?? 0
      if (c === 1) {
        const at = stack.indexOf(dep)
        errors.push(`steps: deps 环 ${[...stack.slice(at), dep].join(' → ')}`)
      } else if (c !== 2) {
        visit(dep)
      }
    }
    stack.pop()
    color.set(id, 2)
  }
  for (const id of graph.keys()) {
    if ((color.get(id) ?? 0) === 0) visit(id)
  }
}

// ── R.1 数据面编译检查（②stepId 字符约束 + 占位词法 + ③引用三查）──────────────

/**
 * stepId 字符约束（R.1②）：被引用 stepId 禁止包含 `.`、`}` 与空白——占位词法
 * `{{outputs.<stepId>[.<key>]}}` 里 stepId 与 key 的边界靠这些字符判定，含点号 stepId
 * 从源头消灭 `a.b` 歧义（含点号 stepId 的编译错同获 Q1 Did-you-mean 候选）。
 */
function stepIdLexiconErrors(steps, errors) {
  const ids = steps.filter((s) => isObject(s) && typeof s.stepId === 'string').map((s) => s.stepId)
  steps.forEach((step, i) => {
    if (!isObject(step) || typeof step.stepId !== 'string') return // 形状错已由 schema 层报
    const id = step.stepId
    if (!/[.}\s]/.test(id)) return
    const hint = nearestStepId(id, ids.filter((x) => x !== id))
    errors.push(
      `steps[${i}].stepId: 含 "."、"}" 或空白的 stepId 不允许（占位词法歧义源头，R.1）："${id}"${hint ? `——最近候选 "${hint}"？` : ''}`,
    )
  })
}

/**
 * 占位词法 + 引用三查（R.1②③；lightflow compiler.py:536-578 对应物）。
 * 词法：prompt 里一切 `{{…}}` 必须匹配两条严格语法（判定与渲染共用 prompt-render.js 的
 * scanTemplate——单一事实来源），不匹配一律编译错。三查逐占位符（引用闭包上游）：
 *   ① 被引用 stepId 存在（未知引用附 Q1 Did-you-mean 候选）；
 *   ② 在本步 deps 的传递闭包内（数据面引用必须沿依赖边——调度序保证注入时上游已 done）；
 *   ③ 被引用步声明了 schema（无 schema 步无结构化产出，无物可引）。
 */
function placeholderCompileErrors(decl, errors) {
  const steps = decl.steps
  if (!Array.isArray(steps)) return

  const byId = new Map() // stepId → { step, index }（重复 stepId 已由 graphErrors 单报，这里取首见）
  steps.forEach((step, i) => {
    if (isObject(step) && typeof step.stepId === 'string' && !byId.has(step.stepId)) byId.set(step.stepId, { step, index: i })
  })

  // deps 传递闭包（BFS，每步缓存；未知引用边已由 graphErrors 单报，这里只沿已知边走）
  const closureCache = new Map()
  const closureOf = (id) => {
    if (closureCache.has(id)) return closureCache.get(id)
    const seen = new Set()
    const queue = (byId.get(id)?.step.deps ?? []).filter((d) => typeof d === 'string' && byId.has(d))
    while (queue.length > 0) {
      const d = queue.shift()
      if (seen.has(d)) continue
      seen.add(d)
      queue.push(...(byId.get(d)?.step.deps ?? []).filter((x) => typeof x === 'string' && byId.has(x)))
    }
    closureCache.set(id, seen)
    return seen
  }

  steps.forEach((step, i) => {
    if (!isObject(step) || typeof step.prompt !== 'string') return // 形状错已由 schema 层报
    const scan = scanTemplate(step.prompt)
    for (const message of scan.errors) errors.push(`steps[${i}].prompt: ${message}`)
    for (const ref of scan.refs) {
      if (!byId.has(ref)) {
        const hint = nearestStepId(ref, byId.keys())
        errors.push(`steps[${i}].prompt: 占位符引用未知 stepId "${ref}"（不在任何 stepId 里${hint ? `——最近候选 "${hint}"？` : ''}）`)
        continue
      }
      if (!closureOf(step.stepId).has(ref)) {
        errors.push(`steps[${i}].prompt: 占位符引用 "${ref}" 不在本步 deps 传递闭包内（数据面引用必须沿依赖边——把 "${ref}" 加进本步 deps，或改走文件总线）`)
        continue
      }
      if (byId.get(ref).step.schema === undefined) {
        errors.push(`steps[${i}].prompt: 被引用步 "${ref}" 无 schema——该步无结构化产出可引用（给 "${ref}" 声明 schema，或改走文件总线）`)
      }
    }
  })
}

/**
 * outputs 路径形式判据（P1.2 第 6 条；平台无关，自写不依赖 path.isAbsolute——
 * Windows 判据要认盘符，POSIX 判据要认 // 与 /，isAbsolute 在两平台语义相反）：
 *   绝对路径 = Windows 盘符（^[A-Za-z]:[\/]）| UNC（^//）| POSIX 根（^/）；
 *   home 相对 = ^~/（引擎以 os.homedir() 展开，其余字面处理）。
 * 其余一切形式（相对路径、~user、file:// 等）都拒——判据单一事实来源在本文件，
 * declaration.schema.json 只约束类型与项数（1-8），两处注释互指。
 */
export function isEngineOutputsPath(s) {
  return typeof s === 'string' && /^([A-Za-z]:[\\/]|\/\/|\/|~\/)/.test(s)
}

/** outputs 数量与逐项形式检查（walkSchema 没有 minItems/maxItems/pattern，这里代码补；label 定报错前缀）。 */
function outputsErrors(outputs, label, errors) {
  if (!Array.isArray(outputs)) return // 类型错已由 schema 层报，这里不重复
  if (outputs.length < 1 || outputs.length > 8) {
    errors.push(`${label}: 项数必须 1-8（得到 ${outputs.length}）`)
  }
  outputs.forEach((p, j) => {
    if (typeof p === 'string' && !isEngineOutputsPath(p)) {
      errors.push(`${label}[${j}]: 必须是绝对路径或 ~/ 前缀（盘符/UNC/POSIX 根；相对路径与其余形式不收——得到 ${JSON.stringify(p)}）`)
    }
  })
}

/**
 * 校验引擎运行声明。
 * @param {*} decl 任意输入（含垃圾值）——不抛，一律返 { ok, errors }。
 * @returns {{ ok: boolean, errors: string[] }} ok === (errors.length === 0)
 */
export function validateDeclaration(decl) {
  const errors = []
  if (!isObject(decl)) {
    errors.push(`${ROOT.label}: 必须是对象（得到 ${describeValue(decl)}）`)
    return { ok: false, errors }
  }
  walkSchema(decl, DECLARATION_SCHEMA, null, errors)
  graphErrors(decl, errors)
  if (Array.isArray(decl.steps)) {
    stepIdLexiconErrors(decl.steps, errors) // R.1②：stepId 禁 . } 空白（含点号 stepId 同获 Q1 候选）
    placeholderCompileErrors(decl, errors) // R.1②③：占位词法 + 引用三查
    decl.steps.forEach((step, i) => {
      if (isObject(step) && step.outputs !== undefined) outputsErrors(step.outputs, `steps[${i}].outputs`, errors)
    })
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 单步形状校验（schema 的 steps.items 子树；报错 path 前缀 "step"）。
 * ask.js 的 step 入参校验用（S5 依赖「schema 校验」）。图性质（stepId 唯一 / deps 环、
 * 自指、未知引用）是**声明级**性质，单步无可查图，这里不查——ask 只执行一步，deps 不归它管。
 * 纯函数不抛，错误累积；与 validateDeclaration 同一 walkSchema 子集（单一事实来源）。
 */
export function validateStep(step) {
  const errors = []
  if (!isObject(step)) {
    errors.push(`step: 必须是对象（得到 ${describeValue(step)}）`)
    return { ok: false, errors }
  }
  walkSchema(step, DECLARATION_SCHEMA.properties.steps.items, 'step', errors)
  // R.1②：占位词法单步也查（ask 路径无渲染器，词法坏形/引用形状的 prompt 会原样漏给子会话）；
  // 引用三查是**声明级**性质（要全声明步表与 deps 图），单步无可查，这里不查。
  if (isObject(step) && typeof step.prompt === 'string') {
    for (const message of scanTemplate(step.prompt).errors) errors.push(`step.prompt: ${message}`)
  }
  if (isObject(step) && typeof step.stepId === 'string' && /[.}\s]/.test(step.stepId)) {
    errors.push(`step.stepId: 含 "."、"}" 或空白的 stepId 不允许（占位词法歧义源头，R.1）："${step.stepId}"`)
  }
  if (isObject(step) && step.outputs !== undefined) outputsErrors(step.outputs, 'step.outputs', errors)
  return { ok: errors.length === 0, errors }
}

/**
 * 任意值对任意 schema 子树校验（同一 walkSchema 子集；rootLabel 定根层报错前缀）。
 * ask.js 用 step.schema 校验子会话产出（declaration.schema.json：schema 是
 * 「结果 JSON Schema，ask.js 用它校验子会话产出」）。schema 非对象如实报 not-ok
 * （纯函数不抛原则不变；调用方在 validateStep 之后用它，schema 已保证是对象）。
 */
export function validateValue(value, schema, rootLabel = 'value') {
  const errors = []
  if (!isObject(schema)) {
    errors.push(`${rootLabel}.schema: 必须是对象（得到 ${describeValue(schema)}）`)
    return { ok: false, errors }
  }
  walkSchema(value, schema, rootLabel, errors)
  return { ok: errors.length === 0, errors }
}
