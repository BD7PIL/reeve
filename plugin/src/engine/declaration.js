// E1 引擎声明校验器（S1；施工规格 .zcode/plans/e1-construction-spec.md §3 / T3.1）。
//
// 依赖方向：declaration.js ← declaration.schema.json——结构性约束（允许字段、必填、
// 类型、prompt ≤8000、maxAttempts ≥1、timeoutMs ≥1000）从 schema 文件读，本文件不复制数字；
// schema 表达不了的图性质（stepId 唯一、deps 无环/无自指/无未知引用）在这里用代码补。
// validateDeclaration(decl) → { ok, errors[] }：纯函数，不抛（任何垃圾输入都返形状良好的
// 结果），错误累积（一次报全，不首错即停）。本校验器无时钟/无随机/fault 面——那些注入点
// 属于 journal/scheduler/ask（规格 §6），声明校验是纯数据判定。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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
 * additionalProperties:false / items / minLength / maxLength / minimum）。
 * 类型不符即停在当前节点（内层形状留给类型修复后重报），错误累积不中断。
 */
function walkSchema(value, node, path, errors) {
  const type = node.type
  if (type !== undefined && !matchesType(value, type)) {
    if (type === 'integer' && typeof value === 'number') errors.push(`${label(path)}: 必须是整数（得到 ${value}）`)
    else errors.push(`${label(path)}: 必须是${TYPE_LABEL[type] ?? type}（得到 ${describeValue(value)}）`)
    return
  }
  if (isObject(value) && node.properties) {
    for (const key of node.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${label(path)}: 缺失必填字段 "${key}"`)
    }
    const allowed = Object.keys(node.properties)
    for (const key of Object.keys(value)) {
      const sub = node.properties[key]
      if (!sub) {
        if (node.additionalProperties === false) errors.push(`${label(path)}: 未知字段 "${key}"（允许：${allowed.join(', ')}）`)
        continue
      }
      walkSchema(value[key], sub, joinPath(path, key), errors)
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
        if (!firstSeen.has(dep)) errors.push(`steps[${i}].deps[${j}]: 未知引用 "${dep}"（不在任何 stepId 里）`)
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
