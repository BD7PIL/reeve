// E1 引擎调度器（S4；施工规格 .zcode/plans/e1-construction-spec.md §3 / §5-T3.2、T3.2b、T3.5-scheduler 侧，
// 主计划 P3「调度按 DAG 拓扑 + 复用 concurrency 帽」）。
//
// 职责：把一份合法 declaration 跑到 run 级终态——拓扑序就绪集 dispatch、cap 内并发
// （复用 src/concurrency.js 租户的 acquire(key)→release() 形状）、步终态写 journal、
// 超时兜底独立于事件流。
//
// 主循环（§2-3）：订阅 events AsyncIterable（生产 = session.execution.* 的规范化事件，
// S7b driver-session 供给）→ 本项目事件到达才逐个 driver.result 轮询在飞步（deep-memory
// 「事件到达才查、无定时器轮询」同款）；零 idle 事件时兜底 sweep 独立推进——真实定时器只负责
// 「何时醒来再看一眼注入时钟」，超时判定一律用注入时钟的时间戳，事件丢了超时也要触发（§9）。
// 跨项目过滤（§1）：事件 properties.locationDirectory 为非空字符串且 ≠ directory → 丢弃，
// 不触碰 journal（deep-memory index.ts:180-186 同款；无 location 的 v1 形状放行）。
//
// 每步生命周期（journal 状态机 §3 + P4-E）：declared → dispatching → running →
// done | failed | blocked；dispatch 前先落盘 dispatching 再 driver.create（§1「attempt 先记账」）；
// create 产物先 markEngineSession 再 running（级联守卫锚点先于一切轮询存在）。步一旦 failed
// 即步终态：依赖闭包内未派步 declared→superseded（未派先废），调度器不自动重派——
// failed→dispatching 重入边的驱动归 S5 ask.js（校验重派）与 S6 resume.js（mid-flight 恢复）。
//
// P4-E escalation（escalation 选项，缺省不识别问句——E1 口径不变）：
//   挂起 —— running 步的 done 产出是问句（escalation.js parseQuestion 口径）→ running→blocked
//           （台账记 blocked，payload 带 question）+ journal 记 escalated 审计 + onEscalate 恰一次；
//           依赖闭包内的未派步停在 declared（挂起：readySteps 要求 deps 全 done），无依赖的
//           兄弟步照常派发与完成（只暂停依赖分支，兄弟继续——蓝图 §P4/T4.1）。blocked 步
//           不吃超时兜底（问句可以等人），consecutiveFailures 不动（问句不是失败）。
//   恢复 —— answerFor（非阻塞，同步拉）每轮醒来对每个挂起步拉一次；拿到非空字符串答复 →
//           journal 记 escalation-answered → blocked→dispatching（P4-E 恢复重入边）→ 以
//           escalationPrompt(原 prompt, 问句, 答复) 重派新会话（超时窗口随 lastDispatchAt 重开）。
//           answerFor 抛错/返非字符串 → 本轮不恢复，下轮再拉（监听方异常吞掉，广播同款）。
//           配了 answerFor 的 run 由调用方保证最终答复——问句未答且其余步全收时 run 保持
//           在飞等待（挂起语义）；无 answerFor（notify-only）且只剩挂起步 → run 终局
//           blocked(reason=escalation-pending)，步留在 blocked（跨调用恢复归 S6 接线，同 failed）。
//   熔断语义不变：blockedInfo（连续失败）仍停一切新派（含恢复派发）；run 级终态 reason 里
//   escalation-pending 优先于 consecutive-failures（journal fail-closed 的 journal-not-ok 仍最高）。
//
// P4-H hole（hole 选项，缺省不拉取——运行中交新声明，蓝图 §P4/T4.2「在飞不动/差量正确」）：
//   交接 —— hole.pull() 每轮 loop-top 非阻塞拉取（返回新声明对象或 null；同一对象引用不重复
//           应用，pull 抛错本轮吞掉下轮再拉）。拿到新声明 → validateDeclaration + runId 必须
//           同 run（hole 只交同 run 的修订计划，跨 run 归 matchAmend/A 件）→ 不合法即
//           TypeError fail-fast（程序错误语义，run promise 拒绝）。分类见 hole.js classifyHole：
//           未开始（declared 且未 claimed）差量替换——kept（同字节保留）/ changed（换成新内容，
//           journal 不重播种）/ dropped（declared→superseded，payload reason='hole-drop'）/
//           added（播种 declared）；已开始（dispatching/running/done/failed/blocked/superseded
//           或 claimed）一律不动——新计划点名也按旧身冻结（在飞步 create 不打断），没点名照旧
//           带在活跃计划（报表不丢账）。journal 迁移任一写败 → halted fail-closed。
//   计划 —— 差量落盘后活跃计划原地重建为新声明 ∩ 已开始旧步的合并（createArgs/pollAll/
//           readySteps/finish 快照全走新计划）；新步派发按合并计划的拓扑序（T4.2「新步序正确」）。
//           runId/title 锚点保持原 run（REEVE-E1 <runId> 不因交接改变）。审计：journal 记
//           hole 事件（五类清单），run 广播 hole，result.hole 回流最近一次交接摘要。
//
// run 级终态（§3）：
//   completed —— 全步 done；
//   failed    —— 有步终态 failed/superseded 但未触熔断；
//   blocked   —— journal fail-closed（reason=journal-not-ok）/ escalation 挂起未答
//                （reason=escalation-pending，P4-E）/ 连续失败熔断（reason=consecutive-failures，
//                RUN_FAILURE_LIMIT 默认 3，任一步成功清零；journal 记 run-blocked 事件）。
//
// fail-closed（T3.5 scheduler 侧）：任何 journal 操作返回 not-ok（torn/degraded/真实写抛错）
// → 就地停机：不再派发、不再轮询、不再广播 run 事件，run 返回 blocked(reason=journal-not-ok)。
// 「先落盘再动作」因此守恒：dispatching 落盘失败 → driver.create 一次都不会发生。
//
// 与 §3 签名的偏差（加法，不改既定面，沿 journal.js 先例）：
//   events?: AsyncIterable —— idle 事件源（缺省 = 零 idle 事件，仅超时兜底驱动，T3.2b 的脸）；
//   directory?: string     —— 本项目根（跨项目过滤比较基准；缺省不过滤）；
//   escalation?: { onEscalate?, answerFor? } —— P4-E 问句挂起/答复恢复（缺省不识别问句）；
//   hole?: { pull? } —— P4-H 运行中交接（缺省不拉取；pull 每轮 loop-top 拉一次新声明或 null）。
// fault 消费面（§6）：abortAt?: stepId[]——步轮到派发、dispatching 落盘之后、create 之前抛
// E1_ENGINE_ABORT（崩溃现场：journal 停在 dispatching、无会话产物、不等待其他在飞任务；
// 恢复归 S6 resume.js）。failWrite/driverChaos 由 journal/driver 自己消费，本文件不碰。
// abortAt 只挂在 declared→dispatching 的初派路径上；P4-E 的恢复派发（blocked→dispatching）
// 不吃 abortAt（注入点语义是「初派记账后崩」，恢复已在 run 内，不属于崩溃注入的靶面）。
//
// 时钟（§6）：now?: () => number（默认 Date.now）；journal 的 at 与超时判定全走它。
// 事件广播（onEvent）严格「先落盘再广播」：只在对应 journal 写成功后发，形状
// { kind:'run', runId, type, at, stepId?, sessionId? }；journal 自身的广播走 journal 的 onEvent。
import { Admission } from '../concurrency.js'
import { DECLARATION_DEFAULTS, validateDeclaration } from './declaration.js'
import { escalationPrompt, parseQuestion } from './escalation.js'
import { assertDriverFace } from './driver.js'
import { classifyHole } from './hole.js'

/** run 级连续失败熔断上限（§1：默认 3，任一步成功清零）。 */
export const RUN_FAILURE_LIMIT = 3
/** 兜底 sweep 的真实定时器上限（毫秒）：注入时钟跳变最迟这么久被 sweep 看到。 */
export const SWEEP_TICK_MS = 200
/** abortAt 崩溃注入的错误 code（S6 resume 识别用）。 */
export const ABORT_CODE = 'E1_ENGINE_ABORT'
/** journal 带 mid-flight 步（非 declared/done）时拒绝启动的 code（S4 只接干净 run；恢复归 S6）。 */
export const NOT_FRESH_CODE = 'E1_ENGINE_NOT_FRESH'

const TERMINAL_STATES = Object.freeze(['done', 'failed', 'superseded'])
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const codeError = (code, message) => {
  const e = new Error(message)
  e.code = code
  return e
}
const brief = (v) => String(v?.message ?? v).slice(0, 160)

/**
 * 并发帽（§3「复用 concurrency 租户的 acquire/release 形状」）：
 *   缺省/null → 无限（Admission 0=无限同款）；正整数 → Admission({limits:{default:n}})（0=无限）；
 *   带 acquire(key) 的对象 → 原样用（调用方注入的租户闸门，acquire 返回 release 函数）。
 */
function createCapGate(cap) {
  if (cap === undefined || cap === null) return new Admission()
  if (typeof cap === 'number') {
    if (!Number.isInteger(cap) || cap < 0) throw new TypeError(`run: cap 数字形式必须是 ≥0 整数（0=无限；得到 ${cap}）`)
    return cap === 0 ? new Admission() : new Admission({ limits: { default: cap } })
  }
  if (isPlainObject(cap) && typeof cap.acquire === 'function' && (cap.release === undefined || typeof cap.release === 'function')) return cap
  throw new TypeError('run: cap 必须是 ≥0 整数（0=无限）或带 acquire(key)→release() 的租户形状对象（concurrency.js Admission 同款）')
}

/** §1 跨项目过滤：locationDirectory 非空且 ≠ directory → 丢；无 location（v1）或未配 directory → 放行。 */
function isForeignEvent(event, directory) {
  if (directory === undefined) return false
  const loc = isPlainObject(event) ? event.properties?.locationDirectory : undefined
  return typeof loc === 'string' && loc.length > 0 && loc !== directory
}

/**
 * 跑一份声明到 run 级终态。
 * @param {*} declaration 引擎运行声明（先过 validateDeclaration，不合法 = TypeError）
 * @param {object} opts
 *   - journal: createJournal 产物（写失败 fail-closed，T3.5）
 *   - driver:  createDriver 产物（assertDriverFace 校验）
 *   - cap:     并发帽（数字 / 租户形状对象 / 缺省无限）
 *   - fault:   { abortAt?: stepId[] }（§6；生产传 null）
 *   - onEvent: (event) => void——run 事件广播（先落盘再广播；回调抛错只吞掉）
 *   - now:     () => number（默认 Date.now；journal at 与超时判定全走它）
 *   - events:  AsyncIterable——idle 事件源（缺省 = 零 idle 事件）
 *   - directory: 本项目根（缺省不过滤）
 *   - escalation: { onEscalate?, answerFor? }——P4-E（缺省 = 不识别问句产出，E1 口径不变）。
 *       onEscalate(record)：问句挂起时恰一次（record = { kind:'escalation', runId, stepId,
 *         sessionId, question, output, attempt, at }）；抛错只吞掉（blocked 已落盘，面板自负责）。
 *       answerFor(record) => 非空字符串 | null|undefined：非阻塞答复源，每轮醒来对每个
 *         挂起步拉一次；非空字符串即恢复（escalationPrompt 重派），抛错/其他形状本轮跳过。
 *   - hole: { pull? }——P4-H 运行中交接（缺省不拉取）。pull() => 新声明对象 | null|undefined：
 *       每轮 loop-top 非阻塞拉一次；同一对象引用不重复应用，pull 抛错本轮吞掉；返回的新声明
 *       须过 validateDeclaration 且 runId 同 run（否则 TypeError，run promise 拒绝——程序错误）。
 *       差量口径见 hole.js：未开始步替换（kept/changed/dropped/added），已开始步一律不动。
 * @returns {Promise<{status:'completed'|'failed'|'blocked', runId, at, reason?, journal?,
 *                     escalation?: {stepId, question}[], hole?,
 *                     steps, completed: string[], failed: string[], superseded: string[], pending: string[]}>}
 *   reason ∈ journal-not-ok | escalation-pending | consecutive-failures（escalation-pending
 *   只在 escalate 挂起未答的终局出现；escalation 数组列出挂起步与其问句）。hole = 最近一次
 *   交接摘要 { added, dropped, changed, pinned, kept, at }（从未交接则无此键）。
 * @throws {TypeError} declaration/journal/driver/cap/fault/events/escalation/hole 形状不合法（程序错误）
 * @throws {Error&{code:E1_ENGINE_ABORT}} fault.abortAt 命中（崩溃注入，journal 停在该步 dispatching）
 * @throws {Error&{code:E1_ENGINE_NOT_FRESH}} journal 带 mid-flight 步（非 declared/done）
 */
export async function run(declaration, opts = {}) {
  const { journal, driver, cap, fault = null, onEvent, now, events, directory, escalation, hole } = opts ?? {}

  // ---- 参数校验（程序错误 = TypeError，fail-fast；语义性失败走返回值，与 journal 分轨同哲学）----
  const verdict = validateDeclaration(declaration)
  if (!verdict.ok) throw new TypeError(`run: declaration 不合法：\n  ${verdict.errors.join('\n  ')}`)
  const runId = declaration.runId
  for (const face of ['appendStepState', 'recordEvent', 'markEngineSession', 'getStepState', 'listSteps', 'status']) {
    if (typeof journal?.[face] !== 'function') throw new TypeError(`run: journal 缺 face ${face}（createJournal 产物）`)
  }
  assertDriverFace(driver, 'run: driver')
  if (now !== undefined && typeof now !== 'function') throw new TypeError('run: now 必须是 () => number')
  if (onEvent !== undefined && typeof onEvent !== 'function') throw new TypeError('run: onEvent 必须是回调函数')
  if (fault !== null && fault !== undefined && !isPlainObject(fault)) throw new TypeError('run: fault 必须是对象或 null')
  const abortAt = fault?.abortAt
  if (abortAt !== undefined && (!Array.isArray(abortAt) || !abortAt.every((s) => typeof s === 'string'))) {
    throw new TypeError('run: fault.abortAt 必须是 stepId 字符串数组')
  }
  // P4-E escalation 面（缺省 null/undefined = 不识别问句；给了就至少形状要对）
  if (escalation !== undefined && escalation !== null && !isPlainObject(escalation)) {
    throw new TypeError('run: escalation 必须是对象或 null（{ onEscalate?, answerFor? }；缺省 = 不识别问句产出）')
  }
  if (escalation?.onEscalate !== undefined && typeof escalation.onEscalate !== 'function') {
    throw new TypeError('run: escalation.onEscalate 必须是 (record) => void 回调')
  }
  if (escalation?.answerFor !== undefined && typeof escalation.answerFor !== 'function') {
    throw new TypeError('run: escalation.answerFor 必须是 (record) => 非空字符串|null 的非阻塞回调')
  }
  const escalationMode = escalation !== undefined && escalation !== null
  const canAnswer = escalationMode && typeof escalation.answerFor === 'function'
  // P4-H hole 面（缺省 null/undefined = 不拉取）
  if (hole !== undefined && hole !== null && !isPlainObject(hole)) {
    throw new TypeError('run: hole 必须是对象或 null（{ pull? }；缺省 = 不接受运行中交接）')
  }
  if (hole?.pull !== undefined && typeof hole.pull !== 'function') {
    throw new TypeError('run: hole.pull 必须是 () => 新声明|null 的非阻塞回调')
  }
  const holePull = hole?.pull ?? null
  if (directory !== undefined && (typeof directory !== 'string' || directory.length === 0)) {
    throw new TypeError('run: directory 必须是非空字符串（缺省 = 不过滤跨项目事件）')
  }
  if (events !== undefined && events !== null && typeof events[Symbol.asyncIterator] !== 'function') {
    throw new TypeError('run: events 必须是 AsyncIterable（session.execution.* 事件源；缺省 = 零 idle 事件）')
  }
  const capGate = createCapGate(cap)
  const nowFn = now ?? Date.now
  const emit = (type, extra = {}) => {
    if (!onEvent) return
    try {
      onEvent({ kind: 'run', runId, type, at: nowFn(), ...extra })
    } catch {
      /* 监听方异常不回滚（journal 同款：持久化已成功） */
    }
  }

  // ---- journal 预检：torn/degraded 一律 fail-closed（T3.5：零 create、零广播）----
  const status0 = journal.status()
  if (!status0 || !status0.ok) {
    return {
      status: 'blocked', runId, at: nowFn(), reason: 'journal-not-ok', journal: status0 ?? null,
      steps: {}, completed: [], failed: [], superseded: [], pending: declaration.steps.map((s) => s.stepId),
    }
  }

  // ---- 镜像与依赖闭包（内存读数 mirror journal 成功写；一切以 journal 盘上真相为准）----
  const state = new Map() // stepId → 镜像态（null=未播种）
  const sessionOf = new Map() // stepId → sessionId（本 run 派发的）
  const stepOfSession = new Map() // sessionId → stepId
  const textOf = new Map() // stepId → done 时 result.text
  const releaseFns = new Map() // stepId → cap 槽位释放函数
  const claimed = new Set() // dispatchTask 在飞（含 cap 排队）的步——防同轮双派
  let stepsById = new Map(declaration.steps.map((s) => [s.stepId, s])) // 活跃计划步表（P4-H 交接后重建）
  let dependents = new Map() // dep → [stepId...]（supersede 闭包用；P4-H 交接后重建）
  /** 重建活跃计划图（初始化与 P4-H 交接共用；declaration 绑定原地换成合并计划）。 */
  const rebuildPlan = (steps) => {
    stepsById = new Map(steps.map((s) => [s.stepId, s]))
    dependents = new Map()
    for (const s of steps) {
      for (const d of s.deps) dependents.set(d, [...(dependents.get(d) ?? []), s.stepId])
    }
  }
  rebuildPlan(declaration.steps)
  const pendingQuestions = new Map() // P4-E：stepId → escalation record（本 run 挂起中的问句档）
  let lastHole = undefined // P4-H：最近应用的交接声明对象（引用去重；须先于 finish 的可达路径声明——播种失败在预扫期就收尾）
  let holeInfo = null // P4-H：最近一次交接摘要（result.hole 回流）

  let halted = null // null | { reason:'journal-not-ok' }——fail-closed 闩
  let blockedInfo = null // null | { trigger, failures, lastStep? }
  let consecutiveFailures = 0

  const move = (stepId, from, to, payload) => {
    const r = journal.appendStepState(stepId, from, to, payload)
    if (!r.ok) halted = { reason: 'journal-not-ok' }
    return r.ok ? r : null
  }
  const note = (type, payload) => {
    const r = journal.recordEvent(type, payload)
    if (!r.ok) halted = { reason: 'journal-not-ok' }
    return r.ok ? r : null
  }
  const releaseSlot = (stepId) => {
    const release = releaseFns.get(stepId)
    releaseFns.delete(stepId)
    try {
      release?.()
    } catch {
      /* 帽实现异常不回滚步终态 */
    }
  }

  // ---- 预扫：done/declared 可接（done 零 driver 调用——resume 友好），mid-flight 拒（归 S6）----
  for (const s of declaration.steps) {
    const known = journal.getStepState(s.stepId)
    const st = known ? known.state : null
    state.set(s.stepId, st)
    if (st !== null && st !== 'done' && st !== 'declared') {
      throw codeError(NOT_FRESH_CODE, `run: journal 里步 "${s.stepId}" 已处于 ${st}——S4 调度器只接全新 run 或「declared/done」续跑；mid-flight 恢复归 S6 resume.js`)
    }
    if (st === 'done') {
      // 历史尾条 payload 里回收上次的 sessionId/text（纯盘上读数，零 driver 调用）
      const tail = known.history.at(-1)?.payload
      if (typeof tail?.sessionId === 'string') sessionOf.set(s.stepId, tail.sessionId)
      if (typeof tail?.result?.text === 'string') textOf.set(s.stepId, tail.result.text)
    }
  }
  for (const s of declaration.steps) {
    if (state.get(s.stepId) !== null) continue
    if (!move(s.stepId, null, 'declared')) return finish() // 播种写败 → fail-closed
    state.set(s.stepId, 'declared')
  }

  // ---- dispatch（§1：先落盘 dispatching 再 create；create 产物先 markEngineSession 再 running）----
  const createArgs = (step) => ({
    title: `REEVE-E1 ${runId} ${step.stepId}`, // §2-1 锚点：title 前缀 REEVE-E1 <runId>（+stepId 保唯一）
    prompt: step.prompt,
    ...(step.agent !== undefined ? { agent: step.agent } : {}),
    ...(step.model !== undefined ? { model: step.model } : {}), // {providerID, id, variant?} 零转换直传（F4）
  })

  const terminalSuccess = (stepId, text) => {
    state.set(stepId, 'done')
    if (typeof text === 'string') textOf.set(stepId, text)
    releaseSlot(stepId)
    consecutiveFailures = 0 // §1：任一步成功清零
    emit('step-done', { stepId, ...(sessionOf.has(stepId) ? { sessionId: sessionOf.get(stepId) } : {}) })
  }

  const supersedeDescendants = (rootStepId) => {
    const queue = [...(dependents.get(rootStepId) ?? [])]
    while (queue.length > 0) {
      const id = queue.shift()
      if (state.get(id) !== 'declared' || claimed.has(id)) continue
      if (!move(id, 'declared', 'superseded', { reason: 'dep-failed', via: rootStepId })) return // halted
      state.set(id, 'superseded')
      emit('superseded', { stepId: id, via: rootStepId })
      queue.push(...(dependents.get(id) ?? []))
    }
  }

  const terminalFailure = (step, payload, type) => {
    const stepId = step.stepId
    state.set(stepId, 'failed')
    releaseSlot(stepId)
    consecutiveFailures += 1
    // 本步的 failed 写已在调用方落盘；先广播本步，再广播它连带的下游作废（各自的写各自先落盘）
    emit(type, { stepId, ...(sessionOf.has(stepId) ? { sessionId: sessionOf.get(stepId) } : {}), detail: payload })
    supersedeDescendants(stepId)
    if (halted) return
    if (consecutiveFailures >= RUN_FAILURE_LIMIT && !blockedInfo) {
      const info = { trigger: 'consecutive-failures', failures: consecutiveFailures, lastStep: stepId }
      if (!note('run-blocked', info)) return // halted
      blockedInfo = info
    }
  }

  const failDispatch = (step, fromState, error) => {
    const stepId = step.stepId
    // fromState='dispatching' = create 阶段的败（已记账）；其余（'declared'|'blocked'）= 帽拒的败，
    // 补记 from→dispatching→failed 两笔（blocked 一样走 P4-E 恢复派发的记账，attempts 照加）
    if (fromState !== 'dispatching' && !move(stepId, fromState, 'dispatching')) {
      claimed.delete(stepId)
      return
    }
    if (!move(stepId, 'dispatching', 'failed', { error: { code: error?.code ?? null, message: brief(error) } })) {
      claimed.delete(stepId)
      releaseSlot(stepId)
      return
    }
    claimed.delete(stepId)
    terminalFailure(step, { error: error?.code ?? null }, 'step-failed')
  }

  /**
   * 派发一步（初派 from=declared；P4-E 恢复派发 from=blocked，prompt=escalationPrompt 组装件）。
   * from 取镜像当前态——journal 的 stale-from 校验与镜像一致，初派/恢复共用同一记账路径。
   */
  const dispatchStep = async (step, { prompt } = {}) => {
    const stepId = step.stepId
    claimed.add(stepId) // 同步占位：ready 计算不再选它（同 step 第二 in-flight 不成立）
    let release = null
    try {
      release = await capGate.acquire(stepId) // concurrency 租户形状：超限排队，不失败
    } catch (error) {
      failDispatch(step, state.get(stepId), error) // 帽拒（自定义 cap 才可能）：按「派发即败」记账
      return
    }
    releaseFns.set(stepId, release)
    if (!move(stepId, state.get(stepId), 'dispatching')) {
      releaseSlot(stepId)
      claimed.delete(stepId)
      return // halted：create 一次都不会发生（T3.5「先落盘再动作」）
    }
    state.set(stepId, 'dispatching') // 镜像同步：dispatching 也吃超时兜底（create 挂死不悬挂）
    let created = null
    try {
      created = await driver.create({ ...createArgs(step), ...(prompt !== undefined ? { prompt } : {}) })
    } catch (error) {
      failDispatch(step, 'dispatching', error)
      return
    }
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      failDispatch(step, 'dispatching', codeError('E1_ENGINE_BAD_SESSION', 'driver.create 返回缺非空 sessionId'))
      return
    }
    if (!journal.markEngineSession(sessionId).ok) {
      halted = { reason: 'journal-not-ok' }
      releaseSlot(stepId)
      claimed.delete(stepId)
      return
    }
    if (!move(stepId, 'dispatching', 'running', { sessionId })) {
      releaseSlot(stepId) // halted：会话已建但 journal 停在 dispatching——孤儿会话归 S6 处理
      claimed.delete(stepId)
      return
    }
    state.set(stepId, 'running')
    sessionOf.set(stepId, sessionId)
    stepOfSession.set(sessionId, stepId)
    claimed.delete(stepId)
    emit('dispatch', { stepId, sessionId })
  }

  const readySteps = () =>
    declaration.steps.filter(
      (s) => state.get(s.stepId) === 'declared' && !claimed.has(s.stepId) && s.deps.every((d) => state.get(d) === 'done'),
    )

  const dispatchReady = () => {
    if (blockedInfo || halted) return // 熔断后只排干在飞，不再派新（含 P4-E 恢复派发）
    for (const step of readySteps()) {
      if (abortAt?.includes(step.stepId)) {
        // §6 abortAt：dispatching 落盘之后、create 之前崩（「先记账后崩」现场；不等待其他在飞任务）
        if (!move(step.stepId, 'declared', 'dispatching')) return
        state.set(step.stepId, 'dispatching')
        throw codeError(ABORT_CODE, `run: fault.abortAt 注入——步 "${step.stepId}" dispatching 落盘后中止（崩溃现场，resume 归 S6）`)
      }
      void dispatchStep(step) // cap 排队由租户闸门 await；完成/失败经 journal 与镜像回报
    }
  }

  // ---- P4-E：问句挂起 / 答复恢复（只暂停依赖分支，兄弟照常——蓝图 §P4/T4.1）----
  const blockedSteps = () => declaration.steps.filter((s) => state.get(s.stepId) === 'blocked')

  /** 问句挂起：台账记 blocked（payload 带 question）→ 审计 → 广播 → 面板回调（恰一次）。 */
  const escalateStep = (step, asked, sessionId) => {
    const stepId = step.stepId
    if (!move(stepId, 'running', 'blocked', { question: asked.question, sessionId })) return // halted
    state.set(stepId, 'blocked')
    releaseSlot(stepId) // 问句步让出 cap 槽位；恢复派发重新走 dispatchStep 的 acquire
    const record = {
      kind: 'escalation',
      runId,
      stepId,
      sessionId,
      question: asked.question,
      output: asked.output, // 完整产出对象（面板可读；journal 台账只落 question，盘上保持精瘦）
      attempt: journal.getStepState(stepId)?.attempts ?? null,
      at: nowFn(),
    }
    pendingQuestions.set(stepId, record)
    if (!note('escalated', { stepId, question: asked.question, sessionId })) return // halted
    emit('escalated', { stepId, question: asked.question, sessionId })
    if (escalation?.onEscalate) {
      try {
        escalation.onEscalate(record)
      } catch {
        /* 面板异常不回滚：blocked 与 escalated 已落盘（journal 广播同款） */
      }
    }
  }

  /**
   * 答复驱动的恢复：每个挂起步每轮醒来拉一次 answerFor（非阻塞；不配 answerFor 则永不恢复，
   * 挂起步留在 blocked）。非空字符串答复 → 先记 escalation-answered 台账再开恢复迁移
   * （先落盘再动作），escalationPrompt 组装重派——新会话新超时窗口（lastDispatchAt 刷新）。
   * 只处理本 run 挂起的问句档：手搓/历史 journal 里的 blocked 步没有档，不误恢复。
   */
  const resumeEscalations = () => {
    if (!canAnswer || halted || blockedInfo) return // 熔断时恢复派发一并停（与 dispatchReady 同口径）
    for (const step of declaration.steps) {
      const stepId = step.stepId
      if (state.get(stepId) !== 'blocked' || claimed.has(stepId) || !pendingQuestions.has(stepId)) continue
      const record = pendingQuestions.get(stepId)
      let answer = null
      try {
        answer = escalation.answerFor(record)
      } catch {
        continue // 答复源异常本轮跳过（监听方异常吞掉同款），下一轮再拉
      }
      if (typeof answer !== 'string' || answer.length === 0) continue // 非字符串/空串 = 未答
      if (!note('escalation-answered', { stepId, answer, question: record.question })) return // halted
      emit('escalation-answered', { stepId, answer, question: record.question }) // 与 escalated 成对（先落盘再广播）
      pendingQuestions.delete(stepId)
      void dispatchStep(step, { prompt: escalationPrompt(step.prompt, record.question, answer) })
    }
  }

  // ---- P4-H：运行中交新声明（未开始步差量替换，在飞步不动——蓝图 §P4/T4.2）----
  const applyHole = () => {
    if (!holePull || halted) return
    let next = null
    try {
      next = holePull()
    } catch {
      return // 拉取源异常本轮吞掉（答复源同款），下一轮再拉
    }
    if (!next || next === lastHole) return
    // 程序级校验 fail-fast：声明形状/runId 同 run。任一不过直接抛（run promise 拒绝），零 journal 写。
    const verdict = validateDeclaration(next)
    if (!verdict.ok) throw new TypeError(`run: hole 交接声明不合法：\n  ${verdict.errors.join('\n  ')}`)
    if (next.runId !== runId) {
      throw new TypeError(`run: hole 交接声明 runId "${next.runId}" 与运行 "${runId}" 不符——hole 只交同 run 的修订计划（跨 run 归 matchAmend/A 件）`)
    }
    const diff = classifyHole({
      currentSteps: declaration.steps,
      knownOf: (id) => state.get(id) ?? null,
      claimed,
      nextSteps: next.steps,
    })
    // 先落盘：dropped 废（declared→superseded）、added 播种（null→declared）；任一写败即 halted（fail-closed）
    for (const id of diff.dropped) {
      if (!move(id, 'declared', 'superseded', { reason: 'hole-drop' })) return
      state.set(id, 'superseded')
      emit('superseded', { stepId: id, via: 'hole' })
    }
    for (const id of diff.added) {
      if (!move(id, null, 'declared')) return
      state.set(id, 'declared')
    }
    // 再重建活跃计划（内存；声明是纯数据，journal 不存内容——changed 步派发时自然取新内容）
    declaration = { runId, steps: diff.merged }
    rebuildPlan(diff.merged)
    lastHole = next
    holeInfo = { added: diff.added, dropped: diff.dropped, changed: diff.changed, pinned: diff.pinned, kept: diff.kept, at: nowFn() }
    if (!note('hole', { added: diff.added, dropped: diff.dropped, changed: diff.changed, pinned: diff.pinned, kept: diff.kept })) return
    emit('hole', { added: diff.added, dropped: diff.dropped, changed: diff.changed, pinned: diff.pinned, kept: diff.kept })
  }

  // ---- 轮询（§2-3：事件到达才查）与超时兜底（§9：独立于事件流）----
  const pollAll = async () => {
    for (const step of declaration.steps) {
      if (halted) return
      const stepId = step.stepId
      if (state.get(stepId) !== 'running') continue
      const sessionId = sessionOf.get(stepId)
      let res = null
      try {
        res = await driver.result(sessionId)
      } catch (error) {
        if (move(stepId, 'running', 'failed', { error: { code: error?.code ?? null, message: brief(error) } })) {
          terminalFailure(step, { error: error?.code ?? null }, 'step-failed')
        }
        continue
      }
      if (res?.status === 'running') continue
      if (res?.status === 'done') {
        // P4-E：done 产出是问句 → 挂起（escalation 选项缺省时不判定，E1「done 即产出」不变）。
        // 依赖闭包停排由 readySteps 的 deps 全 done 要求天然保证；兄弟步在本循环照常处理。
        const asked = escalationMode ? parseQuestion(res.text) : null
        if (asked) {
          escalateStep(step, asked, sessionId)
          continue
        }
        if (move(stepId, 'running', 'done', { result: { text: res.text }, sessionId })) terminalSuccess(stepId, res.text)
      } else {
        // 'failed' 或未知 status 都按失败收敛（宁可失败，不悬挂）
        if (move(stepId, 'running', 'failed', { error: { status: res?.status, errorPart: res?.errorPart } })) {
          terminalFailure(step, { errorPart: res?.errorPart ?? null }, 'step-failed')
        }
      }
    }
  }

  const runningOrDispatching = () => declaration.steps.filter((s) => ['running', 'dispatching'].includes(state.get(s.stepId)))
  const allTerminal = () => declaration.steps.every((s) => TERMINAL_STATES.includes(state.get(s.stepId)))

  const sweepTimeouts = () => {
    for (const step of declaration.steps) {
      if (halted) return
      const stepId = step.stepId
      // dispatching 也吃超时（create 挂死不悬挂）；dispatching→failed 是合法边
      const st = state.get(stepId)
      if (st !== 'running' && st !== 'dispatching') continue
      const timeoutMs = step.timeoutMs ?? DECLARATION_DEFAULTS.timeoutMs
      const lastAt = journal.getStepState(stepId)?.lastDispatchAt
      if (!Number.isFinite(lastAt)) continue
      const t = nowFn()
      if (t - lastAt < timeoutMs) continue
      const payload = { reason: 'timeout', timeoutMs, elapsedMs: t - lastAt }
      if (!move(stepId, st, 'failed', payload)) return
      terminalFailure(step, { reason: 'timeout' }, 'step-timeout')
      if (halted) return
      note('timeout', { stepId, elapsedMs: payload.elapsedMs }) // §9：journal 记 timeout 事件
    }
  }

  // ---- 收尾：run 级终态与快照（blocked 优先级 halted > escalation-pending(P4-E) > 熔断/stall > failed > completed）----
  function finish() {
    const at = nowFn()
    const listed = halted ? null : journal.listSteps()
    const stateOf = (id) => listed?.[id]?.state ?? state.get(id) ?? null
    const ids = declaration.steps.map((s) => s.stepId)
    const byState = (st) => ids.filter((id) => stateOf(id) === st)
    const escalPending = halted ? [] : blockedSteps()
    const status = halted
      ? 'blocked'
      : escalPending.length > 0
        ? 'blocked'
        : blockedInfo
          ? 'blocked'
          : byState('failed').length + byState('superseded').length > 0
            ? 'failed'
            : 'completed'
    const steps = {}
    for (const s of declaration.steps) {
      const id = s.stepId
      const entry = listed?.[id]
      steps[id] = {
        state: stateOf(id),
        ...(entry ? { attempts: entry.attempts } : {}),
        ...(sessionOf.has(id) ? { sessionId: sessionOf.get(id) } : {}),
        ...(textOf.has(id) ? { text: textOf.get(id) } : {}),
      }
    }
    return {
      status,
      runId,
      at,
      ...(halted ? { reason: 'journal-not-ok', journal: journal.status() } : {}),
      ...(escalPending.length > 0
        ? { reason: 'escalation-pending', escalation: escalPending.map((s) => ({ stepId: s.stepId, question: pendingQuestions.get(s.stepId)?.question ?? null })) }
        : {}),
      ...(holeInfo ? { hole: holeInfo } : {}),
      ...(blockedInfo ? { reason: 'consecutive-failures', blocked: blockedInfo } : {}),
      steps,
      completed: byState('done'),
      failed: byState('failed'),
      superseded: byState('superseded'),
      // pending = 一切未到终态的步（含没来得及播种的——fail-closed 时它们也归「未完成」；P4-E 的 blocked 挂起步同列）
      pending: ids.filter((id) => !TERMINAL_STATES.includes(stateOf(id))),
    }
  }

  // ---- 主循环（§2-3：事件驱动重轮询 + 超时兜底独立于事件流）----
  const iterator = events ? events[Symbol.asyncIterator]() : null
  let iteratorLive = iterator !== null
  const nextEvent = async () => {
    try {
      const r = await iterator.next()
      return r.done ? { kind: 'events-end' } : { kind: 'event', value: r.value }
    } catch {
      return { kind: 'events-error' }
    }
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const sweepDelay = () => {
    let earliest = Infinity
    for (const step of declaration.steps) {
      const st = state.get(step.stepId)
      if (st !== 'running' && st !== 'dispatching') continue
      const lastAt = journal.getStepState(step.stepId)?.lastDispatchAt
      if (Number.isFinite(lastAt)) {
        earliest = Math.min(earliest, lastAt + (step.timeoutMs ?? DECLARATION_DEFAULTS.timeoutMs))
      }
    }
    if (!Number.isFinite(earliest)) return SWEEP_TICK_MS
    return Math.min(Math.max(earliest - nowFn(), 1), SWEEP_TICK_MS)
  }

  try {
    while (true) {
      if (halted) break
      if (allTerminal()) break
      if (blockedInfo && runningOrDispatching().length === 0) break // 熔断后排干在飞即终局
      // P4-E：notify-only（无 answerFor）且只剩问句挂起 → 再无可推进之事，按 escalation-pending 终局；
      // 配了 answerFor 则不在此收——挂起等答复是设计语义（调用方保证最终答复或放弃 run）。
      if (escalationMode && !canAnswer && blockedSteps().length > 0 && runningOrDispatching().length === 0) break
      applyHole() // P4-H：运行中交接（差量替换未开始步，在飞步不动；合法新声明才应用）
      if (halted) break
      resumeEscalations() // P4-E：答复驱动恢复（先落台账再重派；answerFor 在才有效）
      if (halted) break
      dispatchReady() // 可能抛 E1_ENGINE_ABORT（崩溃注入语义，不等待在飞任务）
      if (halted) break
      const waiters = []
      if (iteratorLive) {
        waiters.push(
          nextEvent().then((w) => {
            if (w.kind !== 'event') iteratorLive = false // 事件源结束/抛错：只丢事件通道，超时兜底照走
            return w
          }),
        )
      }
      waiters.push(sleep(sweepDelay()))
      const winner = await Promise.race(waiters)
      if (halted) continue
      if (winner && winner.kind === 'event') {
        if (!isForeignEvent(winner.value, directory)) await pollAll() // §1：非本项目事件不触碰 journal
      } else {
        sweepTimeouts()
      }
    }
  } finally {
    if (iterator && typeof iterator.return === 'function') {
      try {
        await iterator.return()
      } catch {
        /* 事件源关闭失败不掩盖主流程结果 */
      }
    }
  }

  const result = finish()
  if (!halted) {
    emit(result.status === 'completed' ? 'run-completed' : result.status === 'failed' ? 'run-failed' : 'run-blocked', {
      status: result.status,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    })
  }
  return result
}
