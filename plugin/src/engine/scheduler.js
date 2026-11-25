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
// 每步生命周期（journal 状态机 §3 + P4-E + P1.2）：declared → dispatching → running →
// done | failed | blocked；dispatch 前先落盘 dispatching 再 driver.create（§1「attempt 先记账」）；
// create 产物先 markEngineSession 再 running（级联守卫锚点先于一切轮询存在）。failed 一般即步
// 终态：依赖闭包内未派步 declared→superseded（未派先废），调度器不自动重派——
// failed→dispatching 重入边归 S5 ask.js（校验重派）与 S6 resume.js（mid-flight 恢复）。
// 唯一例外是 P1.2 窄域重试（见下）：schema/outputs 校验失败的 failed 步由主循环在 cooldown
// 到期后自动重派（resumeRetries），其余 failed 步的语义一字不动。
//
// P1.2 声明步产出校验（step.schema/outputs 接线——m4「四步回复从未被验」的假完成通道封堵）：
//   校验点 —— pollAll 的 done 分支内、move(running→done) 之前（合法边 running→failed 在；
//           done 无出边，done 后校验为时序非法）。escalation 问句判定在前（P4-E 语义不变：
//           问句产出是挂起不是坏产出，不过 schema）。
//   校验内容 —— ① step.schema 在场：回复文本须合法 JSON 且过 declaration.js validateValue
//           （ask.js judgeOutput 同口径；payload errors 沿用 ask 形状）→ ② step.outputs 在场：
//           逐项盘上存在且为文件（existsSync && statSync().isFile()；~/ 以注入 homedir 展开，
//           其余字面；路径形式判据在 declaration.js 单一事实来源）。任一不过 → 可重试失败
//           （running→failed，payload reason ∈ RETRYABLE_REASONS；outputs 失败形状
//           {reason:'outputs-missing', missing[], attempt, retryNote?}）。
//   窄域重试 —— 仅上述两类进重试环；driver 级失败保持既有终态语义。不可重试分类表（逐 code）：
//           journal-not-ok（fail-closed 闩）/ run-mismatch（journal 撕裂）/ E1_ENGINE_BAD_SESSION
//           与 driver.create/result 抛错（failDispatch/pollAll 既有终态路径）/ timeout
//           （sweepTimeouts 终态，ask.js F6 同口径）/ output-over-limit 与 injection-over-limit
//           （R.1 数据面两条确定性失败：上限是常量不是运行态，重试无意义）——一律不进重试环。尝试未耗尽前不触发
//           supersedeDescendants、不计入 consecutiveFailures；耗尽那次 failed 才计入（可能触发
//           既有熔断——耗尽触发熔断时 run 终局 = blocked(reason=consecutive-failures)，步级
//           payload 仍为 outputs-missing/schema-invalid）。熔断打断 pendingRetry = 停新派语义的
//           自然延伸：blockedInfo 后 resumeRetries 不再派，收口时挂起步在 finish() 显示
//           retry-pending。重试间隔 = 固定 cooldown（默认 30s，retry.cooldownMs 可配，判定全走
//           注入时钟）——指数退避与 ±抖动不抄（子会话成本分钟级，非网络请求毫秒级）。失败
//           payload 的 retryNote 记「为何不重试/何时重试」（lightflow engine.py 显式备注先例）。
//   重派 —— cooldown 到期由主循环 resumeRetries 走 failed→dispatching 重入边（状态机唯一
//           重入边），prompt = retryPrompt（ask.js F6 同款错误附言 + 末次重派 nudge），
//           超时窗口随 lastDispatchAt 重开（P4-E 恢复派发同款——appendStepState 的 dispatching
//           语义自带）。attempts 走 appendStepState 既有计数；maxAttempts = 含初派的总尝试上限。
//   终局判定 —— cooldown 挂起的步不计入收口：调度器内存 pendingRetry 集（journal 态仍 failed，
//           调度器视其非终态——P4-E blocked 非终态先例）；收口前提 = 全部步 ∈ 终态 **且
//           pendingRetry 为空**。叶子步在 cooldown 而其余全终态 → run 不收口（等重试耗尽或
//           成功——m4 的 report 步正是此场景，静默丢重试 = 修好的假完成通道换个形态回来）。
//   fs 注入缝 —— scheduler 自身零内建依赖（时钟/journal/driver 全注入同款）：outputs 盘上检查
//           与 ~/ 展开的 fs 面（existsSync/statSync/homedir）经构造参数注入（fs 选项，缺省
//           DEFAULT_FS_FACE），假 fs 给测试/fault。
//
// R.1 数据面（步间结构化产出 + 占位渲染；蓝图 .zcode/plans/next-round-plan-v4.md R.1 ①④⑤⑥⑦）：
//   产出持久面 —— 步 done 时若带 schema → 校验通过对象即该步结构化产出：running→done 迁移
//           payload 增 `output`（对象；无 schema 步无此键）；广播面 emit('step-done') 不重复
//           存储（广播不带 output，journal 是唯一持久真相）。写入上限：output JSON.stringify
//           后 UTF-8 字节 ≤ STEP_OUTPUT_LIMIT_BYTES（32768，与注入面上限同值对齐，防
//           O(N×payload) 写放大）——超限 → 该步 failed（reason=output-over-limit，payload 带
//           bytes/limit，不可重试；大数据声明 outputs 落盘走文件总线）。
//   产出回收 —— 预扫对已 done 步增回收 output（与 textOf 同款读 done 迁移尾条 payload.output，
//           structuredClone 解耦 journal 内部引用）——resume/amend/hole 重建后续跑时下游注入有源。
//   渲染（dispatch 期）—— 每步派发先 renderPrompt(step.prompt, outputOf)（prompt-render.js 纯
//           函数导出件），**先渲染后组装附言**：retryPrompt/escalationPrompt 附言与答复文本中的
//           字面 `{{` 不参与二次替换。渲染后 prompt 豁免 8000 字符 schema 上限（那是模板本体的
//           约束；渲染后可达 ~40KB 是有意设计）。无占位符的步渲染即原样（零行为差异）。
//   注入上限（渲染期检查）—— 单步全部占位符解析值 stringify 后 UTF-8 字节总和 ≤ 32768
//           （重复引用重复累计；模板字面量不计入——renderPrompt 返回 injectedBytes 并自检），
//           超限 → 步 failed（reason=injection-over-limit，payload 带 bytes/limit，不可重试——
//           确定性失败重试无意义）。缺产出/缺 key 的渲染失败同轨终态（结构上被引用三查 +
//           deps-done 排序排除，防御性保留）。
//   hole×R 陈旧防护（⑦）—— applyHole 对 next 声明的 changed/pinned-异内容 步查引用闭包：若
//           存在已 done 的引用下游（沿引用闭包级联传递），下游产出已按旧上游落账而 pinned 只能
//           按旧身冻结——拒绝整次交接（TypeError「先 drop 下游或改完再交」——fail-closed，
//           宁重跑不假完成）。pinned 同字节重投（hole 常态）恒放行。
//
// P4-E escalation（escalation 选项，缺省不识别问句——E1 口径不变）：
//   挂起 —— running 步的 done 产出是问句（escalation.js parseQuestion 口径）→ running→blocked
//           （台账记 blocked，payload 带 question）+ journal 记 escalated 审计 + onEscalate 恰一次；
//           依赖闭包内的未派步停在 declared（挂起：readySteps 要求 deps 全 done），无依赖的
//           兄弟步照常派发与完成（只暂停依赖分支，兄弟继续——蓝图 §P4/T4.1）。blocked 步
//           不吃超时兜底（问句可以等人），consecutiveFailures 不动（问句不是失败）。
//   恢复 —— answerFor（非阻塞，同步拉）每轮醒来对每个挂起步拉一次；拿到答复（Q3 契约：
//           非空字符串旧形状按 source='unknown' 归一，或 {answer, operator?, source?} 对象，
//           归一见 escalation.js normalizeAnswer）→ journal 记 escalation-answered（payload 带
//           answer/operator/source）→ blocked→dispatching（P4-E 恢复重入边）→ 以
//           escalationPrompt(原 prompt, 问句, 答复) 重派新会话（超时窗口随 lastDispatchAt 重开）。
//           answerFor 抛错/返未答形状（null/空串/垃圾）→ 本轮不恢复，下轮再拉（监听方异常吞掉，广播同款）。
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
import { retryPrompt } from './ask.js'
import { DECLARATION_DEFAULTS, validateDeclaration, validateValue } from './declaration.js'
import { escalationPrompt, normalizeAnswer, parseQuestion } from './escalation.js'
import { assertDriverFace } from './driver.js'
import { DEFAULT_FS_FACE, FS_FACE_FNS } from './fs-face.js'
import { classifyHole } from './hole.js'
import { STEP_OUTPUT_LIMIT_BYTES, renderPrompt, scanTemplate } from './prompt-render.js'

/** run 级连续失败熔断上限（§1：默认 3，任一步成功清零）。 */
export const RUN_FAILURE_LIMIT = 3
/** 兜底 sweep 的真实定时器上限（毫秒）：注入时钟跳变最迟这么久被 sweep 看到。 */
export const SWEEP_TICK_MS = 200
/** abortAt 崩溃注入的错误 code（S6 resume 识别用）。 */
export const ABORT_CODE = 'E1_ENGINE_ABORT'
/** journal 带 mid-flight 步（非 declared/done）时拒绝启动的 code（S4 只接干净 run；恢复归 S6）。 */
export const NOT_FRESH_CODE = 'E1_ENGINE_NOT_FRESH'
/** P1.2 窄域重试的固定 cooldown（毫秒；retry.cooldownMs 可配——指数退避与 ±抖动不抄，子会话成本分钟级）。 */
export const RETRY_COOLDOWN_MS = 30_000
/** P1.2 可重试失败 reason 域（窄域：仅两类校验失败；结构性/timeout 保持既有终态语义，不进重试环）。 */
export const RETRYABLE_REASONS = Object.freeze(['outputs-missing', 'schema-invalid'])

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
 *       answerFor(record) => 非空字符串 | { answer, operator?, source? } | null|undefined：
 *         非阻塞答复源，每轮醒来对每个挂起步拉一次（escalation.js normalizeAnswer 归一）；
 *         非空字符串旧形状按 source='unknown' 兼容（现 TypeError 硬校验不破）；对象形状的
 *         source ∈ harness/api/panel 落 escalation-answered payload（Q3 来源归档，operator
 *         非空字符串才收）；抛错/其他形状本轮跳过。
 *   - hole: { pull? }——P4-H 运行中交接（缺省不拉取）。pull() => 新声明对象 | null|undefined：
 *       每轮 loop-top 非阻塞拉一次；同一对象引用不重复应用，pull 抛错本轮吞掉；返回的新声明
 *       须过 validateDeclaration 且 runId 同 run（否则 TypeError，run promise 拒绝——程序错误）。
 *       差量口径见 hole.js：未开始步替换（kept/changed/dropped/added），已开始步一律不动。
 *   - retry:  { cooldownMs? }——P1.2 窄域重试（缺省 = 固定 cooldown RETRY_COOLDOWN_MS = 30s）。
 *       仅 schema/outputs 校验失败进重试环（RETRYABLE_REASONS）；cooldown 判定全走注入时钟；
 *       cooldownMs ≥0 整数（0 = 立即重派）。
 *   - fs:     { existsSync, statSync, homedir }——P1.2 outputs 盘上检查与 ~/ 展开的 fs 面
 *       （缺省 DEFAULT_FS_FACE；测试/fault 注假 fs——scheduler 自身零内建依赖）。
 * @returns {Promise<{status:'completed'|'failed'|'blocked', runId, at, reason?, journal?,
 *                     escalation?: {stepId, question}[], hole?,
 *                     steps, completed: string[], failed: string[], superseded: string[], pending: string[]}>}
 *   steps[id] 对 cooldown 挂起中的校验失败步（journal 态 failed、重试待派）带
 *   retryPending: 'failed(retry-pending, attempt N/M, cooldown 剩 Xs)'（P1.2 第 9 条报告形状）。
 *   reason ∈ journal-not-ok | escalation-pending | consecutive-failures（escalation-pending
 *   只在 escalate 挂起未答的终局出现；escalation 数组列出挂起步与其问句）。hole = 最近一次
 *   交接摘要 { added, dropped, changed, pinned, kept, at }（从未交接则无此键）。
 * @throws {TypeError} declaration/journal/driver/cap/fault/events/escalation/hole 形状不合法（程序错误）
 * @throws {Error&{code:E1_ENGINE_ABORT}} fault.abortAt 命中（崩溃注入，journal 停在该步 dispatching）
 * @throws {Error&{code:E1_ENGINE_NOT_FRESH}} journal 带 mid-flight 步（非 declared/done）
 */
export async function run(declaration, opts = {}) {
  const { journal, driver, cap, fault = null, onEvent, now, events, directory, escalation, hole, retry, fs } = opts ?? {}

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
  // P1.2 窄域重试面（缺省 = 固定 cooldown 30s；步无 schema/outputs 时全路径零接触）
  if (retry !== undefined && retry !== null && !isPlainObject(retry)) {
    throw new TypeError('run: retry 必须是对象或 null（{ cooldownMs? }；缺省 = 固定 cooldown 30s）')
  }
  if (retry?.cooldownMs !== undefined && (!Number.isInteger(retry.cooldownMs) || retry.cooldownMs < 0)) {
    throw new TypeError('run: retry.cooldownMs 必须是 ≥0 整数（毫秒；缺省 RETRY_COOLDOWN_MS）')
  }
  const retryCooldownMs = retry?.cooldownMs ?? RETRY_COOLDOWN_MS
  // P1.2 fs 面（缺省 DEFAULT_FS_FACE；scheduler 自身零内建依赖——假 fs 给测试/fault）
  if (fs !== undefined && fs !== null) {
    const missing = isPlainObject(fs) ? FS_FACE_FNS.filter((f) => typeof fs[f] !== 'function') : [...FS_FACE_FNS]
    if (!isPlainObject(fs) || missing.length > 0) {
      throw new TypeError(`run: fs 必须是 { ${FS_FACE_FNS.join(', ')} } 全函数面（缺：${missing.length > 0 ? missing.join(', ') : '对象形状'}）`)
    }
  }
  const fsFace = fs ?? DEFAULT_FS_FACE
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
  const outputOf = new Map() // stepId → 结构化产出（R.1① done 迁移 payload.output；无 schema 步无条目）
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
  // P1.2：stepId → { reason, errors, missing, attempt, maxAttempts, failedAt }——cooldown 挂起的
  // 校验失败步（journal 态仍 failed，调度器视其非终态；收口前提含 pendingRetry 为空）。
  const pendingRetry = new Map()
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
      // R.1⑥：数据面产出同回收（structuredClone 解耦 journal 内部引用）——resume/amend/hole
      // 重建后续跑时下游渲染注入有源；旧 journal done payload 无 output 键即无条目（旧盘兼容）。
      if (tail?.output !== undefined) outputOf.set(s.stepId, structuredClone(tail.output))
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

  // ---- P1.2：声明步产出校验（done 分支 move(running→done) 之前）与窄域重试 ----

  /** ② outputs 盘上存在检查：~/ 以注入 homedir 展开其余字面；必须存在且为文件（stat 抛错同判缺）。 */
  const missingOutputs = (step) => {
    const missing = []
    for (const p of step.outputs) {
      const path = p.startsWith('~/') ? `${fsFace.homedir()}${p.slice(1)}` : p
      let present = false
      try {
        present = fsFace.existsSync(path) && fsFace.statSync(path).isFile()
      } catch {
        present = false // 权限等 stat 异常与缺失同判——宁重试不假完成
      }
      if (!present) missing.push(path)
    }
    return missing
  }

  /**
   * ①② 校验器（R.1① 扩展）：schema 先行——校验通过对象即该步结构化产出（fail.output 之外的
   * 返回形状 { output }）；产出 stringify 后超写入上限（=注入上限，同值对齐）→ output-over-limit
   * （不可重试）；outputs 盘上检查殿后。无 schema 无 outputs → { output: undefined }（零接触；
   * done payload 无 output 键）。attempt = 本次失败的尝试号，journal 既有计数。
   */
  const judgeStepOutput = (step, text) => {
    const attempt = journal.getStepState(step.stepId)?.attempts ?? 0
    let output // 结构化产出（R.1①：schema 步 done payload 的 output 键）
    if (step.schema !== undefined) {
      const errors = []
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        errors.push(`产出不是合法 JSON：${brief(error)}`)
      }
      if (errors.length === 0) {
        const v = validateValue(parsed, step.schema, '产出')
        if (!v.ok) errors.push(...v.errors)
      }
      if (errors.length > 0) return { fail: { reason: 'schema-invalid', errors, attempt } }
      output = parsed
    }
    if (output !== undefined) {
      // R.1① journal 写入上限：Stringify 后 UTF-8 字节 ≤ 32768（Buffer.byteLength）——超限该步
      // failed（写入面与注入面上限同值对齐，防 O(N×payload) 写放大；大数据走 outputs 文件总线）。
      const bytes = Buffer.byteLength(JSON.stringify(output), 'utf8')
      if (bytes > STEP_OUTPUT_LIMIT_BYTES) {
        return {
          fail: {
            reason: 'output-over-limit',
            bytes,
            limit: STEP_OUTPUT_LIMIT_BYTES,
            attempt,
            retryNote: `结构化产出 ${bytes} 字节超写入上限 ${STEP_OUTPUT_LIMIT_BYTES}——确定性失败不重试；大数据改走 outputs 文件总线`,
          },
        }
      }
    }
    if (step.outputs !== undefined) {
      const missing = missingOutputs(step)
      if (missing.length > 0) return { fail: { reason: 'outputs-missing', missing, attempt } }
    }
    return { output }
  }

  /**
   * 可重试失败的收敛：running→failed（合法边）+ 窄域重试记账。尝试未耗尽 → pendingRetry 挂起
   * （让出 cap 槽位；不 supersede 下游、不计 consecutiveFailures——下游步停 declared 等本步 done，
   * readySteps 天然不派）；耗尽那次才走 terminalFailure（计入并可能触发既有熔断）。retryNote 记
   * 「为何不重试/何时重试」（lightflow engine.py 显式备注先例）。
   */
  const retryableFailure = (step, fail) => {
    const stepId = step.stepId
    const maxAttempts = step.maxAttempts ?? DECLARATION_DEFAULTS.maxAttempts
    const exhausted = fail.attempt >= maxAttempts
    const payload = {
      reason: fail.reason,
      ...(fail.errors !== undefined ? { errors: fail.errors } : {}),
      ...(fail.missing !== undefined ? { missing: fail.missing } : {}),
      attempt: fail.attempt,
      retryNote: exhausted
        ? `尝试已耗尽（${fail.attempt}/${maxAttempts}），不再重派`
        : `cooldown 挂起：第 ${fail.attempt + 1}/${maxAttempts} 次尝试将在固定 cooldown ${retryCooldownMs}ms 后重派`,
    }
    if (!move(stepId, 'running', 'failed', payload)) return // halted
    state.set(stepId, 'failed') // 镜像同步（journal 真相已落盘；cooldown 重派的 failed→dispatching stale-from 校验依赖它）
    releaseSlot(stepId)
    if (exhausted) {
      terminalFailure(step, payload, 'step-failed')
      return
    }
    pendingRetry.set(stepId, {
      reason: fail.reason,
      errors: fail.errors ?? [],
      missing: fail.missing ?? [],
      attempt: fail.attempt,
      maxAttempts,
      failedAt: nowFn(),
    })
    emit('step-failed', { stepId, ...(sessionOf.has(stepId) ? { sessionId: sessionOf.get(stepId) } : {}), detail: payload })
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
   * R.1④⑤ 渲染失败收敛：上限/缺产出是确定性失败，不进重试环——from→dispatching→failed 两笔
   * （declared/failed/blocked→dispatching 与 dispatching→failed 都是合法边；failDispatch 的
   * 「派发即败」同款双迁移），terminalFailure 走既有级联（下游作废 + 连败计数）。发生在 cap
   * acquire 之前——无 driver 调用、不占帽位。
   */
  const failRender = (step, rendered) => {
    const stepId = step.stepId
    if (!move(stepId, state.get(stepId), 'dispatching')) {
      claimed.delete(stepId)
      return
    }
    state.set(stepId, 'dispatching')
    const payload =
      rendered.reason === 'injection-over-limit'
        ? {
            reason: 'injection-over-limit',
            bytes: rendered.bytes,
            limit: rendered.limit,
            retryNote: `注入超上限（${rendered.bytes}/${rendered.limit} 字节）——确定性失败不重试；大数据改走 outputs 文件总线`,
          }
        : {
            reason: 'injection-failed',
            detail: rendered.error ?? rendered.reason,
            ...(rendered.stepId !== undefined ? { stepId: rendered.stepId } : {}),
            ...(rendered.key !== undefined ? { key: rendered.key } : {}),
            retryNote: '占位符解析失败——确定性失败不重试；检查被引用步产出与声明',
          }
    if (!move(stepId, 'dispatching', 'failed', payload)) {
      claimed.delete(stepId)
      return
    }
    claimed.delete(stepId)
    terminalFailure(step, payload, 'step-failed')
  }

  /**
   * 派发一步（初派 from=declared；P4-E 恢复派发 from=blocked，附言=escalationPrompt 组装件）。
   * from 取镜像当前态——journal 的 stale-from 校验与镜像一致，初派/恢复共用同一记账路径。
   * R.1④：先渲染模板本体（renderPrompt 纯函数；注入上限渲染期检查），再组装附言——`postscript`
   * 收「渲染后 prompt → 最终 prompt」的组装函数（retryPrompt/escalationPrompt），附言与答复
   * 文本中的字面 `{{` 因此不参与二次替换。
   *
   * 重入面写死：dispatchStep 只接三种 from 态——
   *   declared  初派（dispatchReady 的拓扑就绪集）；
   *   blocked   P4-E 答复驱动恢复（resumeEscalations；新会话新超时窗口，lastDispatchAt 刷新）；
   *   failed    attempt 循环的重入边（journal 状态机唯一 failed→dispatching 出边）——两个驱动方：
   *             P1.2 窄域重试（主循环 resumeRetries 在固定 cooldown 到期后自动重派 pendingRetry
   *             集里的校验失败步——仅 schema/outputs 两类，prompt = retryPrompt 错误附言，超时
   *             窗口随 lastDispatchAt 重开）；其余 failed 步仍归外部调用方接线（S5 ask.js 校验
   *             重派 / S6 resume.js mid-flight 恢复），冷却期（§1 同 step 两次 dispatch 间隔 60s，
   *             取上一条 dispatching 时间戳）由该调用方记账。非 pendingRetry 的 failed 步主循环
   *             永不自动重派（failed 即步终态，依赖闭包未派步 declared→superseded）。
   * running 不是重入态——对 running 步零重派：pollAll 只读 driver.result，result 'running' →
   * continue（等下一次事件/sweep 再查），running 的唯二出口是 done/failed（result 终值）与
   * sweepTimeouts 的 timeoutMs→failed（不无限等）。P1.1 A-idle-confirm 判据后（driver-session.js
   * judgeContext）driver 在真收敛（宿主追加末条 idle 条目）前恒报 running——m4「中段叙事 text 被
   * 当终态」不再提前判 done，多出来的 running 轮询只加深等待、绝不触发本函数重建会话/重发 prompt
   * （同会话二次 prompt 与同 step 双 in-flight 由此结构性排除）。
   */
  const dispatchStep = async (step, { postscript } = {}) => {
    const stepId = step.stepId
    claimed.add(stepId) // 同步占位：ready 计算不再选它（同 step 第二 in-flight 不成立）
    // R.1④⑤：先渲染后组装附言。渲染只解析模板本体（附言后拼），注入超限/缺产出在此收敛为终态。
    const rendered = renderPrompt(step.prompt, outputOf)
    if (!rendered.ok) {
      failRender(step, rendered)
      return
    }
    const prompt = typeof postscript === 'function' ? postscript(rendered.prompt) : rendered.prompt
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
      created = await driver.create({ ...createArgs(step), prompt }) // R.1④：create 收渲染后 prompt
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
   * 挂起步留在 blocked）。答复形状由 escalation.js normalizeAnswer 归一（Q3：非空字符串旧形状
   * 按 {operator:null, source:'unknown'} 兼容；或 {answer, operator?, source?} 对象）→
   * 先记 escalation-answered 台账（payload 带 answer/operator/source）再开恢复迁移
   * （先落盘再动作），escalationPrompt 组装重派——新会话新超时窗口（lastDispatchAt 刷新）。
   * 只处理本 run 挂起的问句档：手搓/历史 journal 里的 blocked 步没有档，不误恢复。
   */
  const resumeEscalations = () => {
    if (!canAnswer || halted || blockedInfo) return // 熔断时恢复派发一并停（与 dispatchReady 同口径）
    for (const step of declaration.steps) {
      const stepId = step.stepId
      if (state.get(stepId) !== 'blocked' || claimed.has(stepId) || !pendingQuestions.has(stepId)) continue
      const record = pendingQuestions.get(stepId)
      let pulled = null
      try {
        pulled = escalation.answerFor(record)
      } catch {
        continue // 答复源异常本轮跳过（监听方异常吞掉同款），下一轮再拉
      }
      const answer = normalizeAnswer(pulled) // null/空串/形状不符/垃圾 = 未答（旧「非字符串」口径的同款跳过）
      if (!answer) continue
      if (!note('escalation-answered', { stepId, answer: answer.answer, operator: answer.operator, source: answer.source, question: record.question })) return // halted
      // 与 escalated 成对（先落盘再广播）；payload 独立拷贝，广播面与盘上面不共引用。
      emit('escalation-answered', { stepId, answer: answer.answer, operator: answer.operator, source: answer.source, question: record.question })
      pendingQuestions.delete(stepId)
      // R.1④：先渲染后组装附言——答复文本中的字面 `{{` 不参与二次替换。
      void dispatchStep(step, { postscript: (base) => escalationPrompt(base, record.question, answer.answer) })
    }
  }

  // ---- P1.2：cooldown 到期的窄域重派（failed→dispatching 唯一重入边；prompt = retryPrompt 附言）----
  // 熔断时一并停（blockedInfo 先查——熔断打断冷却重试 = 停新派语义的自然延伸，与 resumeEscalations 同口径）；
  // cooldown 未到本轮跳过（判定全走注入时钟；真实唤醒节奏由既有 sweep 心跳供给，零新定时器）。
  const resumeRetries = () => {
    if (halted || blockedInfo) return
    const t = nowFn()
    for (const step of declaration.steps) {
      const entry = pendingRetry.get(step.stepId)
      if (!entry || t - entry.failedAt < retryCooldownMs) continue
      pendingRetry.delete(step.stepId) // 先摘牌再派：派发后无论成败都不再是「cooldown 挂起」——driver 级失败走结构性终态，校验再败由 retryableFailure 重新记账
      const attempt = entry.attempt + 1
      const errors =
        entry.reason === 'outputs-missing' ? entry.missing.map((p) => `产出文件缺失：${p}`) : entry.errors
      // R.1④：postscript 收组装函数——dispatchStep 先渲染模板本体，再拼错误附言（附言中的字面
      // `{{` 不参与二次替换）。
      void dispatchStep(step, { postscript: (base) => retryPrompt(base, errors, { attempt, maxAttempts: entry.maxAttempts }) })
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
    // R.1⑦ hole×R 陈旧防护（fail-closed）：next 的 changed/pinned 步携带「要改」的意图——
    // 若它被某个已 done 的引用下游指着（沿引用闭包级联传递），下游的 journal 产出已按旧上游
    // 落账，而引擎对已开始步只能按旧身冻结（pinned 不重跑）——作者的心智模型（上游会变、下游
    // 会对新上游重算）与盘面将静默分叉。拒绝整次交接（TypeError = 程序错误语义，run promise
    // 拒绝，零 journal 写）：先 drop 下游（交接里不点名）或改完再交。种子 = changed ∪
    // pinned-异内容（pinned 同字节 = 原样重投整份计划，不是改意，恒放行——hole 常态）；
    // 拒绝判据 = 已 done 且（不在种子集，或自身引用了别的种子）的 stale 步——种子自己已 done
    // 但无引用入边时不算下游（p4-H「叠加交接」同款现场照常放行）。无占位符的声明 refs 全空，
    // 此查恒通过（R.1 之前的行为逐位不变）。
    const canonicalJson = (v) => {
      if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
      if (isPlainObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
      return JSON.stringify(v) ?? 'undefined'
    }
    const oldById = new Map(declaration.steps.map((s) => [s.stepId, s]))
    const seeds = new Set(diff.changed)
    for (const id of diff.pinned) {
      const oldStep = oldById.get(id)
      const newStep = next.steps.find((s) => s.stepId === id)
      if (oldStep === undefined || canonicalJson(oldStep) !== canonicalJson(newStep)) seeds.add(id)
    }
    if (seeds.size > 0) {
      const refsOfMerged = new Map(diff.merged.map((s) => [s.stepId, scanTemplate(s.prompt).refs]))
      const stale = new Set(seeds)
      let staleGrew = true
      while (staleGrew) {
        staleGrew = false
        for (const [id, refs] of refsOfMerged) {
          if (stale.has(id)) continue
          if (refs.some((r) => stale.has(r))) {
            stale.add(id)
            staleGrew = true
          }
        }
      }
      const staleDone = [...stale].filter((id) => {
        if (state.get(id) !== 'done') return false
        if (!seeds.has(id)) return true // 纯引用下游（沿闭包传播进来的）
        return (refsOfMerged.get(id) ?? []).some((r) => r !== id && seeds.has(r)) // 种子自身还引用别的种子
      })
      if (staleDone.length > 0) {
        throw new TypeError(
          `run: hole 交接被拒绝（R.1 陈旧防护）：步 [${staleDone.join(', ')}] 已 done 且其引用闭包内有 changed/pinned-异内容 上游（[${[...seeds].join(', ')}]）——上游意图已变而下游产出已按旧上游落账。先 drop 下游（交接里不点名）或改完再交`,
        )
      }
    }
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
        // P1.2：校验点在 move(running→done) 之前——done 无出边，done 后校验为时序非法。
        // R.1①：judge 返回 { output } 或 { fail }；fail 分窄域可重试（schema-invalid/outputs-missing）
        // 与确定性终态（output-over-limit——不可重试，不进重试环）。
        const judged = judgeStepOutput(step, res.text)
        if (judged.fail) {
          const fail = judged.fail
          if (RETRYABLE_REASONS.includes(fail.reason)) {
            retryableFailure(step, fail)
          } else {
            const payload = {
              reason: fail.reason,
              ...(fail.bytes !== undefined ? { bytes: fail.bytes, limit: fail.limit } : {}),
              attempt: fail.attempt,
              ...(fail.retryNote !== undefined ? { retryNote: fail.retryNote } : {}),
            }
            if (move(stepId, 'running', 'failed', payload)) terminalFailure(step, payload, 'step-failed')
          }
          continue
        }
        // R.1①：持久面——schema 步 done payload 增 output（对象）；广播面 step-done 不重复存储。
        const donePayload = {
          result: { text: res.text },
          sessionId,
          ...(judged.output !== undefined ? { output: judged.output } : {}),
        }
        if (move(stepId, 'running', 'done', donePayload)) {
          if (judged.output !== undefined) outputOf.set(stepId, judged.output)
          terminalSuccess(stepId, res.text)
        }
      } else {
        // 'failed' 或未知 status 都按失败收敛（宁可失败，不悬挂）
        if (move(stepId, 'running', 'failed', { error: { status: res?.status, errorPart: res?.errorPart } })) {
          terminalFailure(step, { errorPart: res?.errorPart ?? null }, 'step-failed')
        }
      }
    }
  }

  const runningOrDispatching = () => declaration.steps.filter((s) => ['running', 'dispatching'].includes(state.get(s.stepId)))
  // P1.2：journal 意义的全终态只是收口的必要条件——cooldown 挂起（pendingRetry 非空）时不算
  // 收口（挂起步调度器视其非终态，P4-E blocked 非终态先例）。
  const allTerminal = () => declaration.steps.every((s) => TERMINAL_STATES.includes(state.get(s.stepId)))
  /** run 收口前提（P1.2 第 9 条）：全部步 ∈ 终态 且 pendingRetry 为空（等重试耗尽或成功）。 */
  const readyToClose = () => allTerminal() && pendingRetry.size === 0

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
      // P1.2 第 9 条报告形状：cooldown 挂起中的步显示 failed(retry-pending, attempt N/M, cooldown 剩 Xs)。
      const pr = pendingRetry.get(id)
      const remainSec = pr ? Math.max(0, Math.ceil((pr.failedAt + retryCooldownMs - at) / 1000)) : 0
      steps[id] = {
        state: stateOf(id),
        ...(entry ? { attempts: entry.attempts } : {}),
        ...(sessionOf.has(id) ? { sessionId: sessionOf.get(id) } : {}),
        ...(textOf.has(id) ? { text: textOf.get(id) } : {}),
        ...(pr ? { retryPending: `failed(retry-pending, attempt ${pr.attempt}/${pr.maxAttempts}, cooldown 剩 ${remainSec}s)` } : {}),
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
  // 挂起的 next() 跨 race 持久（P1.2 期间暴露的既有潜伏竞态之最小修复）：旧写法每轮 race 各起一个
  // next()，sleep 赢得 race 时挂起中的 next() 被丢弃却仍留在事件源的等待队列里——之后到达的 idle
  // 被喂给无人 await 的陈旧 promise，事件即丢（poll 推迟到下一事件；cooldown 挂起窗 > sweep 周期时
  // 必现）。改为 liveNext：直到真正被 race 消费才换新，事件零丢失。
  let liveNext = null
  const takeNext = () => (liveNext ??= nextEvent())
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
      if (readyToClose()) break // P1.2：收口前提 = 全部步终态 且 pendingRetry 为空（叶子步 cooldown 期不收口）
      // 熔断后排干在飞即终局——pendingRetry 挂起也被打断（熔断打断冷却重试 = 停新派语义的自然
      // 延伸：blockedInfo 后 resumeRetries 不再派，挂起步在 finish() 显示 retry-pending）。
      if (blockedInfo && runningOrDispatching().length === 0) break
      // P4-E：notify-only（无 answerFor）且只剩问句挂起 → 再无可推进之事，按 escalation-pending 终局；
      // 配了 answerFor 则不在此收——挂起等答复是设计语义（调用方保证最终答复或放弃 run）。
      if (escalationMode && !canAnswer && blockedSteps().length > 0 && runningOrDispatching().length === 0) break
      applyHole() // P4-H：运行中交接（差量替换未开始步，在飞步不动；合法新声明才应用）
      if (halted) break
      resumeEscalations() // P4-E：答复驱动恢复（先落台账再重派；answerFor 在才有效）
      if (halted) break
      resumeRetries() // P1.2：cooldown 到期的校验失败重派（failed→dispatching；熔断时一并停）
      if (halted) break
      dispatchReady() // 可能抛 E1_ENGINE_ABORT（崩溃注入语义，不等待在飞任务）
      if (halted) break
      const waiters = []
      if (iteratorLive) {
        waiters.push(
          takeNext().then((w) => {
            if (w.kind !== 'event') iteratorLive = false // 事件源结束/抛错：只丢事件通道，超时兜底照走
            return w
          }),
        )
      }
      waiters.push(sleep(sweepDelay()))
      const winner = await Promise.race(waiters)
      if (winner) liveNext = null // 非 undefined 的 winner 只能来自挂起的 next（sleep resolve undefined）——消费后换新
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
