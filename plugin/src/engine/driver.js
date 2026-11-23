// E1 引擎 driver：接口定义 + mock/replay 两实现（S3；施工规格 .zcode/plans/e1-construction-spec.md §3 / §5-T3.6 前半）。
//
// 接口面（§3；生产实现 driver-session.js 在 S7b 落地，同一面）：
//   createDriver(kind, opts) → driver
//   driver.create({title, prompt, agent?, model?}) → { sessionId }     （异步）
//   driver.result(sessionId)  → { status: 'running'|'done'|'failed', text?, errorPart? }
//   driver.context(sessionId) → 原始 context 形状（脚本/录制件原样深拷贝返回，不假设字段）
//   driver.close?()           → 幂等；关闭后各操作拒（E1_DRIVER_CLOSED）
//   driver.calls              → 调用记录数组：create/result/context 逐次记
//     { seq, op, at, args, sessionId? | response? | error? }——T3.4「已完成步零 create 调用」
//     从 calls.filter(c => c.op === 'create') 取数；error 只记 code 不记 message（两种 kind 可深比对）。
//
// kind = 'mock'：确定性脚本化应答。场景集（validateScenarioSet 校验的纯数据）按 match 约束匹配
//   create 参数（match 只约束出现的键：prompt 必须全等，title/agent/model 出现即须全等）；
//   result/context 按场景逐项消费、末项粘滞；场景缺 context 的一律拒（E1_DRIVER_NO_CONTEXT）
//   ——规格 §2-2：context 真实形状未验证，mock 不得假设。场景缺 sessionId 时合成
//   sess_mock_<n>（每 driver 从 1 递增，无随机）；场景给了 sessionId 则它是定值：
//   同参数重复 create 返回同一 sessionId 并重置该会话的消费进度。
//   无场景匹配 → E1_DRIVER_NO_SCENARIO（严格缺省：漏脚本当场炸，不做"默认 done"掩护）。
//
// kind = 'replay'：从 fixtures/engine/replay/<日期>/ 的录制 JSON 回放。录制件由 S7a 真机产生，
//   本步（S3）交付加载器与空目录容错：目录不存在/为空不炸（构造成功、零录制），使用时报
//   E1_DRIVER_NO_SCENARIO。dir 缺省取 DEFAULT_REPLAY_ROOT 下字典序最大的日期子目录
//   （目录名约定 YYYY-MM-DD，字典序即时间序）；opts.dir 显式给路径时原样用。
//   录制件格式（S7a 按此落盘，加载期严格校验、坏件拒载 E1_DRIVER_REPLAY_FORMAT）：
//     { version: 1, recordedAt?, host?, note?, scenarios: [<与 mock 同一形状，sessionId 必填>] }
//   目录内 *.json 按文件名序全部载入；match 键全装载域唯一（重复即拒载）。
//
// 注入面（规格 §6）：now（默认 Date.now）与 fault.driverChaos 经构造参数传入，生产传 null；
//   禁止 monkey-patch、引擎内不用随机数。driverChaos 三态（T3.6 的 chaos={超时/半响应/重复回调}，
//   确定性定义）：
//     timeoutMs: true         → create/result/context 每次调用 reject（E1_DRIVER_CHAOS_TIMEOUT），
//                               不推进脚本游标、不建会话（引擎不回 = 无状态变化）；
//     halfResponse: true      → result 只回 { status }（text/errorPart 剥掉）、context 回 {}
//                               （半截响应；不发明字段名）；响应已到达，游标照常推进；
//     duplicateCallback: true → 每个新应答首次送达后立刻原样再投一次（同响应二次投递），之后
//                               照常前进——脚本 [A,B] 的 result 序列变 A,A,B,B,B…（末项粘滞不变）。
//   组合时序：先开箱检查 → 参数校验 → timeout 判定（拒）→ 匹配/取值 → half/duplicate 作用于送达值。
//
// model 编码（规格 §3/F4）：{providerID, id, variant?} 与 declaration.schema.json 同一约束，
//   从 schema 取（单一事实来源，不复制数字）；create 时校验（E1_DRIVER_BAD_ARGS），
//   各实现零转换直传——calls 里 args.model 深等于入参。create 面固定 {title, prompt, agent?, model?}：
//   title/prompt 必须非空字符串、未知键拒绝；不复制 declaration 的 8000 上限——那是声明校验器的
//   约束，ask 重派会在 prompt 后附错误文案，派生 prompt 不受声明上限管。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DECLARATION_SCHEMA } from './declaration.js'

/** 本文件提供的 kind；生产 kind 'session' 由 driver-session.js（S7b）另行提供。 */
export const DRIVER_KINDS = Object.freeze(['mock', 'replay'])
/** result 应答的合法 status。 */
export const DRIVER_RESULT_STATUS = Object.freeze(['running', 'done', 'failed'])
/** 录制件格式版本（S7a 按此落盘；加载期 version 必须全等）。 */
export const SCENARIO_VERSION = 1
/** 录制件顶层允许字段（严格：未知键拒载）。 */
export const RECORDING_FILE_FIELDS = Object.freeze(['version', 'recordedAt', 'host', 'note', 'scenarios'])
/** 全部 driver 错误的 code 清单（错误用普通 Error + code，不建类层级）。 */
export const DRIVER_ERROR_CODES = Object.freeze([
  'E1_DRIVER_CLOSED',
  'E1_DRIVER_BAD_ARGS',
  'E1_DRIVER_UNKNOWN_SESSION',
  'E1_DRIVER_NO_CONTEXT',
  'E1_DRIVER_NO_SCENARIO',
  'E1_DRIVER_REPLAY_FORMAT',
  'E1_DRIVER_SCENARIO_INVALID',
  'E1_DRIVER_CHAOS_TIMEOUT',
])
/** replay 缺省根目录：plugin/test/fixtures/engine/replay/（<日期>/ 子目录由 S7a 产生）。 */
export const DEFAULT_REPLAY_ROOT = fileURLToPath(new URL('../../test/fixtures/engine/replay', import.meta.url))

/** model 子树的约束节点——单一事实来源是 declaration.schema.json，本文件不复制数字。 */
const MODEL_NODE = DECLARATION_SCHEMA.properties.steps.items.properties.model
const CREATE_ARG_FIELDS = Object.freeze(['title', 'prompt', 'agent', 'model'])
const SCENARIO_FIELDS = Object.freeze(['name', 'match', 'sessionId', 'result', 'context'])
const MATCH_FIELDS = Object.freeze(['prompt', 'title', 'agent', 'model'])

const driverError = (code, message) => {
  const e = new Error(message)
  e.code = code
  return e
}
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

/** 规范化 JSON 字符串（键排序递归）——深度相等与 match 键都用它比（场景/录制件都是 JSON 数据）。 */
function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (isPlainObject(v)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'undefined'
}
const deepEqual = (a, b) => canonicalJson(a) === canonicalJson(b)

/**
 * 按 declaration.schema.json 的 model 子树校验（子集语义与 declaration.js 的 walkSchema 一致：
 * type / required / properties / additionalProperties:false / minLength）。返回错误数组。
 */
function modelErrors(model, path, errors) {
  if (!isPlainObject(model)) {
    errors.push(`${path}: 必须是对象（得到 ${typeName(model)}）`)
    return
  }
  for (const key of MODEL_NODE.required ?? []) {
    if (!Object.hasOwn(model, key)) errors.push(`${path}: 缺失必填字段 "${key}"`)
  }
  const allowed = Object.keys(MODEL_NODE.properties)
  for (const key of Object.keys(model)) {
    const sub = MODEL_NODE.properties[key]
    if (!sub) {
      if (MODEL_NODE.additionalProperties === false) errors.push(`${path}: 未知字段 "${key}"（允许：${allowed.join(', ')}）`)
      continue
    }
    const v = model[key]
    if (sub.type === 'string' && typeof v !== 'string') errors.push(`${path}.${key}: 必须是字符串（得到 ${typeName(v)}）`)
  }
}

/** 校验 create 参数面（{title, prompt, agent?, model?}，未知键拒绝）。返回 { ok, errors }。 */
export function validateCreateArgs(args) {
  const errors = []
  if (!isPlainObject(args)) {
    errors.push(`create 参数: 必须是对象（得到 ${typeName(args)}）`)
    return { ok: false, errors }
  }
  for (const key of Object.keys(args)) {
    if (!CREATE_ARG_FIELDS.includes(key)) errors.push(`create: 未知字段 "${key}"（允许：${CREATE_ARG_FIELDS.join(', ')}）`)
  }
  for (const key of ['title', 'prompt']) {
    const v = args[key]
    if (typeof v !== 'string' || v === '') errors.push(`create.${key}: 必须是非空字符串（得到 ${v === undefined ? '缺省' : typeName(v)}）`)
  }
  if (args.agent !== undefined && (typeof args.agent !== 'string' || args.agent === '')) {
    errors.push(`create.agent: 必须是非空字符串（得到 ${typeName(args.agent)}）`)
  }
  if (args.model !== undefined) modelErrors(args.model, 'create.model', errors)
  return { ok: errors.length === 0, errors }
}

/** scenario 的 match 键（规范化 JSON 串）：装载域唯一性与深度相等都靠它。 */
const matchKeyOf = (scenario) => canonicalJson({
  prompt: scenario.match.prompt,
  ...(scenario.match.title !== undefined ? { title: scenario.match.title } : {}),
  ...(scenario.match.agent !== undefined ? { agent: scenario.match.agent } : {}),
  ...(scenario.match.model !== undefined ? { model: scenario.match.model } : {}),
})

/**
 * 校验场景集（mock 与 replay 共用的同一结构；纯函数不抛，错误累积）。
 * scenario 形状：{ name, match: { prompt, title?, agent?, model? }, sessionId?, result: [<应答>…], context?: [<原始形状>…] }
 * 应答形状：{ status: 'running'|'done'|'failed', text?, errorPart? }（未知键拒绝）。
 * set 级性质：sessionId 与 match 键各自全装载域唯一（首见不报、其后逐处报）。
 */
export function validateScenarioSet(scenarios) {
  const errors = []
  if (!Array.isArray(scenarios)) {
    errors.push(`scenarios: 必须是数组（得到 ${typeName(scenarios)}）`)
    return { ok: false, errors }
  }
  const seenSession = new Map() // sessionId → 首见下标
  const seenMatch = new Map() // matchKey → 首见下标
  scenarios.forEach((s, i) => {
    const at = `scenarios[${i}]`
    if (!isPlainObject(s)) {
      errors.push(`${at}: 必须是对象（得到 ${typeName(s)}）`)
      return
    }
    for (const key of Object.keys(s)) {
      if (!SCENARIO_FIELDS.includes(key)) errors.push(`${at}: 未知字段 "${key}"（允许：${SCENARIO_FIELDS.join(', ')}）`)
    }
    if (typeof s.name !== 'string' || s.name === '') errors.push(`${at}.name: 必须是非空字符串`)
    if (!isPlainObject(s.match)) {
      errors.push(`${at}.match: 必须是对象（得到 ${s.match === undefined ? '缺省' : typeName(s.match)}）`)
    } else {
      for (const key of Object.keys(s.match)) {
        if (!MATCH_FIELDS.includes(key)) errors.push(`${at}.match: 未知字段 "${key}"（允许：${MATCH_FIELDS.join(', ')}）`)
      }
      if (typeof s.match.prompt !== 'string' || s.match.prompt === '') errors.push(`${at}.match.prompt: 必须是非空字符串`)
      for (const key of ['title', 'agent']) {
        if (s.match[key] !== undefined && (typeof s.match[key] !== 'string' || s.match[key] === '')) {
          errors.push(`${at}.match.${key}: 必须是非空字符串（得到 ${typeName(s.match[key])}）`)
        }
      }
      if (s.match.model !== undefined) modelErrors(s.match.model, `${at}.match.model`, errors)
    }
    if (s.sessionId !== undefined && (typeof s.sessionId !== 'string' || s.sessionId === '')) {
      errors.push(`${at}.sessionId: 必须是非空字符串（得到 ${typeName(s.sessionId)}）`)
    } else if (typeof s.sessionId === 'string') {
      if (seenSession.has(s.sessionId)) errors.push(`${at}.sessionId: 与 scenarios[${seenSession.get(s.sessionId)}] 重复 "${s.sessionId}"`)
      else seenSession.set(s.sessionId, i)
    }
    if (!Array.isArray(s.result) || s.result.length === 0) {
      errors.push(`${at}.result: 必须是非空数组（应答脚本至少 1 条；得到 ${s.result === undefined ? '缺省' : typeName(s.result)}）`)
    } else {
      s.result.forEach((r, j) => {
        const rat = `${at}.result[${j}]`
        if (!isPlainObject(r)) {
          errors.push(`${rat}: 必须是对象（得到 ${typeName(r)}）`)
          return
        }
        for (const key of Object.keys(r)) {
          if (!['status', 'text', 'errorPart'].includes(key)) errors.push(`${rat}: 未知字段 "${key}"（允许：status, text, errorPart）`)
        }
        if (!DRIVER_RESULT_STATUS.includes(r.status)) {
          errors.push(`${rat}.status: 必须是 ${DRIVER_RESULT_STATUS.join('|')} 之一（得到 ${r.status === undefined ? '缺省' : JSON.stringify(r.status)}）`)
        }
        for (const key of ['text', 'errorPart']) {
          if (r[key] !== undefined && typeof r[key] !== 'string') errors.push(`${rat}.${key}: 必须是字符串（得到 ${typeName(r[key])}）`)
        }
      })
    }
    if (s.context !== undefined) {
      if (!Array.isArray(s.context) || s.context.length === 0) {
        errors.push(`${at}.context: 必须是非空数组（原始 context 形状逐条记录；得到 ${typeName(s.context)}）`)
      } else {
        s.context.forEach((c, j) => {
          if (!isPlainObject(c)) errors.push(`${at}.context[${j}]: 必须是对象（原始 context 形状整体记录；得到 ${typeName(c)}）`)
        })
      }
    }
    if (isPlainObject(s) && isPlainObject(s.match)) {
      const key = matchKeyOf(s)
      if (seenMatch.has(key)) errors.push(`${at}: match 与 scenarios[${seenMatch.get(key)}] 重复（match 键须唯一）`)
      else seenMatch.set(key, i)
    }
  })
  return { ok: errors.length === 0, errors }
}

/** 接口自检：driver 必须有 create/result/context 三个函数（close 可选、须为函数）；requireCalls 时须有 calls 数组。 */
export function assertDriverFace(driver, label = 'driver', { requireCalls = false } = {}) {
  const missing = []
  for (const op of ['create', 'result', 'context']) {
    if (typeof driver?.[op] !== 'function') missing.push(op)
  }
  if (driver?.close !== undefined && typeof driver.close !== 'function') missing.push('close(非函数)')
  if (requireCalls && !Array.isArray(driver?.calls)) missing.push('calls(数组)')
  if (missing.length > 0) throw driverError('E1_DRIVER_BAD_ARGS', `${label}: 缺驱动面 ${missing.join(', ')}`)
}

// ---- 脚本消费原语：逐项前进、末项粘滞；duplicateCallback 把每个新应答立即原样再投一次 ----
function takeScripted(list, state, duplicate) {
  if (duplicate && state.pending) {
    state.pending = false
    return list[Math.max(state.cursor - 1, 0)]
  }
  const entry = list[Math.min(state.cursor, list.length - 1)]
  if (state.cursor < list.length) state.cursor += 1
  if (duplicate) state.pending = true
  return entry
}

/**
 * mock/replay 共核：同一场景集结构、同一匹配/消费/chaos/calls 语义——两实现只差
 * 「场景从哪来」与「sessionId/context 缺省时怎么办」（mock 合成 id、context 拒；
 * replay 用录制 id、缺录制拒）。这正是 T3.6「双实现对同一场景行为一致」的结构保证。
 */
function createScriptedDriver({ kind, scenarios, sources = [], recordings = null, now, chaos, sessionIdOf, replayNote = '' }) {
  const sessions = new Map() // sessionId → { scenario, resultState, contextState }
  const calls = []
  let seq = 0
  let closed = false

  const findScenario = (args) =>
    scenarios.find((s) => {
      const m = s.match
      if (!deepEqual(m.prompt, args.prompt)) return false
      if (m.title !== undefined && m.title !== args.title) return false
      if (m.agent !== undefined && m.agent !== args.agent) return false
      if (m.model !== undefined && !deepEqual(m.model, args.model)) return false
      return true
    }) ?? null

  const record = (op, args) => {
    const r = { seq: ++seq, op, at: now(), args }
    calls.push(r)
    return r
  }

  const assertOpen = (op) => {
    if (closed) throw driverError('E1_DRIVER_CLOSED', `${kind} driver 已 close，${op} 拒绝执行`)
  }

  const chaosTimeout = (op) => {
    if (chaos.timeoutMs) throw driverError('E1_DRIVER_CHAOS_TIMEOUT', `${kind} driver chaos: ${op} 超时（fault.driverChaos.timeoutMs 注入，引擎不回）`)
  }

  const noScenarioError = (args) =>
    driverError(
      'E1_DRIVER_NO_SCENARIO',
      recordings
        ? `${kind}: 没有录制匹配本次 create（dir=${recordings.dir}${recordings.files.length > 0 ? `，files=${recordings.files.join(',')}` : ''}）${replayNote}`
        : `${kind}: 没有场景匹配本次 create（prompt=${JSON.stringify(args.prompt)}；已装载 ${scenarios.length} 条场景）`,
    )

  return {
    kind,
    calls,
    ...(recordings ? { recordings } : {}),

    async create(args) {
      const r = record('create', structuredClone(args))
      try {
        assertOpen('create')
        const bad = validateCreateArgs(args)
        if (!bad.ok) throw driverError('E1_DRIVER_BAD_ARGS', `create: ${bad.errors.join('；')}`)
        chaosTimeout('create')
        const scenario = findScenario(args)
        if (!scenario) throw noScenarioError(args)
        const sessionId = sessionIdOf(scenario)
        sessions.set(sessionId, { scenario, resultState: { cursor: 0, pending: false }, contextState: { cursor: 0, pending: false } })
        r.sessionId = sessionId
        return { sessionId }
      } catch (e) {
        r.error = e.code ?? 'E1_DRIVER_ERROR'
        throw e
      }
    },

    async result(sessionId) {
      const r = record('result', { sessionId })
      try {
        assertOpen('result')
        if (typeof sessionId !== 'string' || sessionId === '') throw driverError('E1_DRIVER_BAD_ARGS', `result: sessionId 必须是非空字符串（得到 ${sessionId === undefined ? '缺省' : typeName(sessionId)}）`)
        chaosTimeout('result')
        const session = sessions.get(sessionId)
        if (!session) throw driverError('E1_DRIVER_UNKNOWN_SESSION', `${kind}: result 未知 sessionId "${sessionId}"（本 driver 没 create 过它）`)
        const entry = takeScripted(session.scenario.result, session.resultState, chaos.duplicateCallback)
        const response = chaos.halfResponse ? { status: entry.status } : structuredClone(entry)
        r.response = structuredClone(response)
        return response
      } catch (e) {
        r.error = e.code ?? 'E1_DRIVER_ERROR'
        throw e
      }
    },

    async context(sessionId) {
      const r = record('context', { sessionId })
      try {
        assertOpen('context')
        if (typeof sessionId !== 'string' || sessionId === '') throw driverError('E1_DRIVER_BAD_ARGS', `context: sessionId 必须是非空字符串（得到 ${sessionId === undefined ? '缺省' : typeName(sessionId)}）`)
        chaosTimeout('context')
        const session = sessions.get(sessionId)
        if (!session) throw driverError('E1_DRIVER_UNKNOWN_SESSION', `${kind}: context 未知 sessionId "${sessionId}"（本 driver 没 create 过它）`)
        if (!Array.isArray(session.scenario.context) || session.scenario.context.length === 0) {
          throw driverError(
            'E1_DRIVER_NO_CONTEXT',
            recordings
              ? `${kind}: 录制未含 "${sessionId}" 的 context（S7a 录制时须把 context 原始形状逐次记入 scenario.context）`
              : `${kind}: 场景未脚本化 "${sessionId}" 的 context——context 真实形状未验证（规格 §2-2），mock 不假设，脚本里给 scenario.context 才可读`,
          )
        }
        const entry = takeScripted(session.scenario.context, session.contextState, chaos.duplicateCallback)
        const response = chaos.halfResponse ? {} : structuredClone(entry)
        r.response = structuredClone(response)
        return response
      } catch (e) {
        r.error = e.code ?? 'E1_DRIVER_ERROR'
        throw e
      }
    },

    close() {
      closed = true
    },
  }
}

function createMockDriver(opts) {
  const scenarios = opts.scenarios ?? []
  const v = validateScenarioSet(scenarios)
  if (!v.ok) throw driverError('E1_DRIVER_SCENARIO_INVALID', `mock: 场景集不合法：\n  ${v.errors.join('\n  ')}`)
  let mockSeq = 0
  return createScriptedDriver({
    kind: 'mock',
    scenarios,
    now: opts.now ?? Date.now,
    chaos: opts.fault?.driverChaos ?? {},
    sessionIdOf: (s) => s.sessionId ?? `sess_mock_${++mockSeq}`,
  })
}

// ---- replay：加载 fixtures/engine/replay/<日期>/ 下的录制件 ----
const replayFormatError = (message) => driverError('E1_DRIVER_REPLAY_FORMAT', `replay: 录制件不合法——${message}`)

/** 字典序最大的日期子目录（目录名约定 YYYY-MM-DD）；根不存在/无子目录 → null。 */
function latestDatedDir(root) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  return dirs.length > 0 ? join(root, dirs[dirs.length - 1]) : null
}

function resolveReplayDir(opts) {
  if (opts.dir) return opts.dir
  const root = opts.root ?? DEFAULT_REPLAY_ROOT
  if (opts.date) return join(root, opts.date)
  return latestDatedDir(root) ?? root
}

/**
 * 装载一个日期目录下的全部录制件（*.json 按文件名序）。目录不存在/为空 → { scenarios: [], files: [] }
 * （空目录容错：构造不炸，使用时报 E1_DRIVER_NO_SCENARIO）。坏件在装载期拒（E1_DRIVER_REPLAY_FORMAT）。
 */
export function loadReplayScenarios(dir) {
  let names
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
  } catch {
    return { scenarios: [], files: [], sources: [] }
  }
  const scenarios = []
  const sources = []
  const seenMatch = new Map() // matchKey → `${name}#${i}`（文件内唯一性已由 validateScenarioSet 查过，这里查跨文件）
  const seenSession = new Map() // sessionId → 同上
  for (const name of names) {
    let doc
    try {
      doc = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch (e) {
      throw replayFormatError(`${name}: 不是合法 JSON（${e.message}）`)
    }
    if (!isPlainObject(doc)) throw replayFormatError(`${name}: 顶层必须是对象（得到 ${typeName(doc)}）`)
    for (const key of Object.keys(doc)) {
      if (!RECORDING_FILE_FIELDS.includes(key)) throw replayFormatError(`${name}: 顶层未知字段 "${key}"（允许：${RECORDING_FILE_FIELDS.join(', ')}）`)
    }
    if (doc.version !== SCENARIO_VERSION) throw replayFormatError(`${name}: version 必须是 ${SCENARIO_VERSION}（得到 ${JSON.stringify(doc.version) ?? typeName(doc.version)}）`)
    for (const field of ['recordedAt', 'host', 'note']) {
      if (doc[field] !== undefined && typeof doc[field] !== 'string') throw replayFormatError(`${name}.${field}: 必须是字符串（得到 ${typeName(doc[field])}）`)
    }
    if (!Array.isArray(doc.scenarios)) throw replayFormatError(`${name}.scenarios: 必须是数组（得到 ${typeName(doc.scenarios)}）`)
    const v = validateScenarioSet(doc.scenarios)
    if (!v.ok) throw replayFormatError(`${name}.${v.errors.join(`；${name}.`)}`)
    doc.scenarios.forEach((s, i) => {
      if (typeof s.sessionId !== 'string' || s.sessionId === '') {
        throw replayFormatError(`${name}.scenarios[${i}].sessionId: 录制件必填（回放要返回真实会话 id；mock 才允许合成）`)
      }
      const at = `${name}.scenarios[${i}]`
      if (seenSession.has(s.sessionId)) throw replayFormatError(`${at}.sessionId: 与 ${seenSession.get(s.sessionId)} 重复 "${s.sessionId}"（sessionId 须全装载域唯一）`)
      seenSession.set(s.sessionId, at)
      const mKey = matchKeyOf(s)
      if (seenMatch.has(mKey)) throw replayFormatError(`${at}: match 与 ${seenMatch.get(mKey)} 重复（match 键须全装载域唯一）`)
      seenMatch.set(mKey, at)
      scenarios.push(s)
      sources.push(`${name}#${i}`)
    })
  }
  return { scenarios, files: names, sources }
}

function createReplayDriver(opts) {
  const dir = resolveReplayDir(opts)
  const loaded = loadReplayScenarios(dir)
  return createScriptedDriver({
    kind: 'replay',
    scenarios: loaded.scenarios,
    sources: loaded.sources,
    recordings: { dir, files: loaded.files },
    now: opts.now ?? Date.now,
    chaos: opts.fault?.driverChaos ?? {},
    sessionIdOf: (s) => s.sessionId,
    replayNote: loaded.files.length === 0 ? `——dir 无可用录制（${dir} 不存在或没有 *.json），录制件由 S7a 真机录制后才有回放内容` : '',
  })
}

/**
 * driver 工厂（§3 接口面）。
 * @param {'mock'|'replay'} kind
 * @param {object} opts
 *   - mock：{ scenarios?, now?, fault? }——scenarios 见 validateScenarioSet。
 *   - replay：{ dir? | root?+date?, now?, fault? }——dir 显式路径；root 缺省 DEFAULT_REPLAY_ROOT，
 *     date 缺省取 root 下字典序最大的日期子目录。
 *   - fault.driverChaos：{ timeoutMs?, halfResponse?, duplicateCallback? }（§6；生产传 null）。
 */
export function createDriver(kind, opts = {}) {
  if (kind === 'mock') return createMockDriver(opts)
  if (kind === 'replay') return createReplayDriver(opts)
  throw driverError(
    'E1_DRIVER_BAD_ARGS',
    `createDriver: 未知 kind ${JSON.stringify(kind)}（允许：${DRIVER_KINDS.join(', ')}；生产 kind 'session' 由 driver-session.js 提供，S7b）`,
  )
}
