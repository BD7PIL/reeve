// E1 引擎生产 driver（S7b；施工规格 .zcode/plans/e1-construction-spec.md §3/§4-S7b/§5-T3.6 全量，
// 主计划 .zcode/plans/next-phase-plan-m1-m5.md M1.3）。宿主差异全部收敛在本文件；mock/replay（driver.js）不改。
//
// 事实底座（全部实测，不再假设）：
//   - findings-engine-face.md 五项（opencode 2.3.2 宿主进程内探针）：create → 扁平 .id（idData 恒 null）；
//     context 空会话返回 []（数组）；event.subscribe() AsyncIterable ✓；插件 env 无 OPENCODE_SERVER_PORT；
//     session 17 方法含 wait/prompt/context/get/remove/interrupt。
//   - wait 实测（2026-11-22，probe-pkg/index.js m13a 段，ask 附实测结论）：wait(sid) 裸形、
//     wait(sid,{timeoutMs}) 对象第二参形、idle 会话、running 会话、不存在会话——**全部即时抛
//     "Expected object"（ms=0/1，kind=threw）**。idUsable=true：create 的 .id 直用 wait/context 有效。
//   - S7a HTTP 面探针（证据区 .zcode/plans/evidence/s7a-probe-report.json）：缺省回环 127.0.0.1:4096 不可达；
//     插件 env OPENCODE_SERVER_PORT=null（双确认）；context 兜底路由 500；v1 message 列表形状 =
//     [{info:{role,...}, parts:[{type:'text'|'error'|'step-start'|'step-finish'|'reasoning',...}]}]；
//     实测事件五类（server.connected/session.created/session.updated/message.updated/message.part.updated），
//     session.execution.* 计 0 条；消息只落在 child id（driver 按 child id 读结果成立）。
//   - v2 face context 形状实测（2026-11-23，M1.3b/c 挂载探针 probe-raw-entry 逐条落盘）：**扁平条目**
//     {id, time:{created,firstToken,streamed,completed}, type:'user'|'assistant'|'idle', text?（user 扁平文）,
//     agent?, model?, content?:[{type:'reasoning'|'text', text}...]（assistant 产出轨）, finish?, cost?, tokens?}，
//     且 run 收尾后追加**非消息条** {type:'idle', outcome:'succeeded'}（实测四键：无 info 信封无 role；
//     与末条 assistant 的实测滞后仅 9-17ms）——role 必须 info.role/role/type 三级取。
//     P1.0 判据考古裁决（2026-11-26，evidence/m4/p10-decision.md）把 idle 升格为**终态前置门槛**
//     （A-idle-confirm）：末条 idle 在场才进终态分支，中段 assistant 的任何形状（含 m4 翻车的
//     「叙事 text」与 fresh 发现的「冻结流式条」）一律不作终态证据——旧「末条 assistant 带 text → done」
//     在 m4 4/4 误报（假 done 与真收敛差 5-29 分钟），judgeContext 已按裁决重写（见下方判定节）。
//     插件自建会话要**显式 agent+model** 才有 turn 产出
//     （model 缺省 → 2.3.2 桌面栈 turn 不启动；实测 agent:'general' + model:{providerID:'reeve',id:'standard'} 可用）。
//
// 对冻结规格的两处偏离（M1.3 定位声明）与实测修正（decisions，与蓝图冲突处以实测为准）：
//   1. **回环 HTTP 兜底删除**（findings-5 + probe item6：端口不在 env、缺省 4096 不可达）——本文件
//      只走 ctx face，零 fetch。E1 规格 §1「context 失败回环兜底」作废。
//   2. **wait 只试裸形且不做阻塞原语**：蓝图「wait 抛错/超时 → failed」假设 wait 正常阻塞到 idle；
//      实测 wait 全形态即时抛 "Expected object"——若按蓝图映射 failed，每步必败。故：每次 result()
//      仍**先试 wait(sessionId)（wait 优先；裸形 = idUsable 实测口径；{sessionID} 对象形未实测不采用）**，
//      抛错按「原语不可用」降级继续 context 解析（记进 calls 的 wait 字段），**不映射 failed**；
//      wait 有界（waitAttemptMs，注入 sleep 赛跑）防未来宿主 wait 真阻塞时挂死调用方。
//      「超时 → failed 交 journal 不无限等」由调度器的声明 timeoutMs 兜底成立（sweepTimeouts，
//      T3.2b 已测）；driver 自身不持超时——声明 timeoutMs 是 per-step 的，driver face 不携带。
//   3. **result = 单轮探针**（与 mock/replay 的 result 同语义）：wait 优先一次 + context 一次 +
//      末条 idle 门槛判定（A-idle-confirm），running 即刻返回。「重试禁忙等 backoff」由此成立：driver 内零定时器忙等——
//      重试节奏归调用方（scheduler 事件驱动 pollAll + sweep 兜底；typedAsk pollMs）。ask.js 头注
//      「事件驱动型调用方让 driver.result 自己挂起等待」在实测宿主上不成立（无可靠阻塞原语、
//      session.execution.* 缺失），等待活性由 events() 的合成 recheck 心跳保证（下）。
//   4. **context 读失败/挂死 → running（不结论）**：deep-memory 同款「读失败不结论、下轮再查」，
//      终不终局由调度器 timeoutMs 兜底；context 抛错不冒泡成 step failed（调度器把 result 抛错记
//      poll-error，那是程序级错误的通道——host face 瞬断不是）。
//
// 接口面（与 driver.js 同一契约）：
//   createSessionDriver(ctx, opts) → driver
//   driver.kind = 'session'
//   driver.create({title, prompt, agent?, model?}) → { sessionId }   （validateCreateArgs 同 mock/replay）
//   driver.result(sessionId)  → { status:'running'|'done'|'failed', text?, errorPart? }
//   driver.context(sessionId) → 宿主原始形状（照搬；读失败按 E1_DRIVER_CONTEXT_FAILED 抛——raw 面
//                               与 result 的容错读分轨）
//   driver.interrupt(sessionId) → undefined（ctx.session.interrupt({sessionID})，reeve index.js:372 同款键名）
//   driver.events()           → 新的 AsyncIterable（每次调用 = 独立订阅；单消费者语义）
//   driver.close()            → 幂等；关闭后四操作拒（E1_DRIVER_CLOSED）、事件流收尾
//   driver.calls              → { seq, op, at, args, sessionId?|response?|error?, wait?/parse?/contextNote?/dup? }
//                               （op ∈ create/result/context/interrupt；error 只记 code——mock/replay 同口径）
//   driver.executionEvents    → session.execution.* 原始形状记录（出现即记，cap executionEventCap）
//   driver.eventStats         → { seen, forwarded, dropped, executionRecorded, synthetic, hostErrors }
//
// events()（「事件 subscribe 记录 session.execution.*（出现即记形状，不阻塞主路径）」）：
//   - 宿主事件规范化为 { type, properties:{locationDirectory}, at, synthetic:false } 后投递
//     （locationDirectory 取 properties.locationDirectory ?? location.directory——后者是实测 v2 形状；
//     调度器 isForeignEvent 只认前者）。不做跨项目过滤（那是调度器的事，driver 只搬运）。
//   - **去抖**：非终末事件在 eventMinIntervalMs 窗口内只投一条（流式 part 事件风暴限频，禁忙等）；
//   - **终末事件旁路**（isTerminalishEvent，实测形状 + v1 idle 名）：session.execution.*、session.idle、
//     message.part.updated 的 step-finish/error part、message.updated 的 assistant+time.completed——
//     不吃去抖，必投（完成信号不能丢）；投后安排一次 trailing recheck（trailingRecheckMs 后投一条
//     合成 recheck，防「事件先于存储可见」竞态把终态读成 running 后再无事件）。
//   - **合成心跳**：每 heartbeatMs 投一条 { type:'reeve.recheck', synthetic:true }——实测宿主
//     session.execution.* 为 0 且事件通道不可依赖，心跳保证「无事件也终能被轮询到」的活性上界；
//     heartbeatMs=0 关闭。队列 cap 32：消费者不拉时丢合成保内存有界。
//   - 宿主流抛错/结束：记 hostErrors，合成通道保活到 close；events 流的 done 只由 close/return 触发。
//
// context 判定（judgeContext，导出供测试；P1.1 按 P1.0 裁决 A-idle-confirm 重写，裁决与失败模式表
//   在 evidence/m4/p10-decision.md）：**末条 v2 扁平 idle 条目是终态唯一入口**——
//   末条非 idle（含末条 assistant 带 text / finish:'stop' / finish:'tool-calls'、v1 信封、中段冻结
//   流式条）→ running（fail-open，m4 痛点 #1「中段叙事 text 被当终态」由此关死）；末条 idle 且
//   outcome==='succeeded'（实测词表单值）→ 回看末条 assistant 下结论：error part（或 info.error
//   形状容错）→ failed（errorPart：字符串直用、对象 JSON.stringify——deep-memory 同款），首个
//   非空 text part → done 取 text（error 优先于 text）；末条 idle 但 outcome 词表外/缺失 →
//   running 并记 shape 观测（失败模式 2 fail-open，禁扩大化为常态烧超时——正常路径 succeeded
//   立即终态，异常路径由调度器 per-step timeoutMs 兜底）。
//   容器形状容错（terminal-gate pickMessages 同款）：数组直用；{data|messages|history:[...]} 信封取数组；
//   认不出 → running（fail-open，绝不下结论）。
//
// 注入面（规格 §6；生产传 null/缺省）：now（默认 Date.now）、sleep（默认 setTimeout，
//   bounded 竞跑/去抖 trailing/心跳全走它）、fault.driverChaos（mock/replay 同三态）：
//     timeoutMs:true         → create/result/context 每次拒（E1_DRIVER_CHAOS_TIMEOUT），宿主不被触碰；
//     halfResponse:true      → result 只回 {status}、context 回 {}（宿主值已到，剥字段）；
//     duplicateCallback:true → 派生应答**发生变化**（vs 上次送达）的下一次调用先原样重投旧应答一次
//                              （脚本 [A,B] 的 A,A,B,B,B… 语义在状态派生世界的对应物）。
//   另注入 directory/parentID（create 时附在宿主 create 参数上——driver create 面固定四键，
//   目录/父会话是部署形态参数，归构造不归调用）；各 ms 间隔均可注入覆盖（默认 SESSION_DRIVER_DEFAULTS）。
//
// create 的宿主调用序：ctx.session.create({title, agent?, model?, directory?, parentID?}) →
//   .id ?? .data.id（§1 两形状兼容）→ ctx.session.prompt({sessionID, text, agent?}) await 回执
//   （实测回执形状 {id,sessionID,time,type,payload,delivery}）。prompt 拒 → create 拒
//   （E1_DRIVER_PROMPT_FAILED，调度器 dispatch-error 记账）；prompt 挂死 → create 挂 → 调度器
//   dispatching 超时兜底（不 await 的 dispatchStep 不拖主循环，T3.2b 语义）。
//   「journal 先落盘再 create」由调度器保证（dispatchStep：move(dispatching) 先于 driver.create），
//   driver 无 journal 面（§3 依赖方向：driver ← 无）。
import { validateCreateArgs } from './driver.js'

/** 缺省间隔（毫秒；opts 可逐项覆盖，0 = 关闭心跳）。 */
export const SESSION_DRIVER_DEFAULTS = Object.freeze({
  waitAttemptMs: 10_000,
  contextReadMs: 10_000,
  eventMinIntervalMs: 1_000,
  trailingRecheckMs: 1_500,
  heartbeatMs: 5_000,
  executionEventCap: 20,
})

/** 本文件的错误码（前四个与 driver.js 共用；后四个是宿主 face 每操作的失败码）。 */
export const SESSION_DRIVER_ERROR_CODES = Object.freeze([
  'E1_DRIVER_CLOSED',
  'E1_DRIVER_BAD_ARGS',
  'E1_DRIVER_UNKNOWN_SESSION',
  'E1_DRIVER_CHAOS_TIMEOUT',
  'E1_DRIVER_CREATE_FAILED',
  'E1_DRIVER_PROMPT_FAILED',
  'E1_DRIVER_CONTEXT_FAILED',
  'E1_DRIVER_INTERRUPT_FAILED',
])

const EVENT_QUEUE_CAP = 32
const RECHECK_TYPE = 'reeve.recheck'
const BOUNDED_TIMEOUT = Symbol('e1-session-driver-bounded-timeout')

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const brief = (e) => String(e?.message ?? e).slice(0, 160)
const stableJson = (v) => {
  try {
    return JSON.stringify(v)
  } catch {
    return undefined
  }
}
const driverError = (code, message) => {
  const e = new Error(message)
  e.code = code
  return e
}
const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 有界执行：宿主 promise 与 sleepFn(ms) 赛跑，返回 {kind:'ok'|'threw'|'timeout'}。宿主挂死不拖调用方。 */
async function bounded(promise, ms, sleepFn) {
  const guarded = promise.then(
    (value) => ({ kind: 'ok', value }),
    (error) => ({ kind: 'threw', error }),
  )
  guarded.catch(() => {}) // 迟到的 rejects 不得成为 unhandledRejection
  const winner = await Promise.race([guarded, sleepFn(ms).then(() => BOUNDED_TIMEOUT)])
  return winner === BOUNDED_TIMEOUT ? { kind: 'timeout' } : winner
}

/**
 * 容器形状容错（terminal-gate pickMessages 同款）：数组直用；{data|messages|history:[...]} 取数组；
 * 认不出 → null。
 */
function pickMessages(transcript) {
  if (Array.isArray(transcript)) return transcript
  if (!isPlainObject(transcript)) return null
  for (const key of ['data', 'messages', 'history']) {
    if (Array.isArray(transcript[key])) return transcript[key]
  }
  return null
}

/**
 * assistant 消息的产出判定（error 优先于 text；parts/content 双容器 + 顶层 text 扁平回退）。
 * P1.1 起只从 judgeContext 的 idle 分支被调（末条 idle succeeded 后回看末条 assistant）——
 * 本函数自身不是终态入口，裸调它不构成 done 依据。判定：
 *   error part → failed（errorPart：字符串直用、对象 JSON.stringify——deep-memory 同款）；
 *   首个非空 text part → done 取 text；assistant 自身带非空 text（v2 扁平形状）→ done 取之；
 *   其余 → running（无结论/冻结条，fail-open）。shape 记判定依据（calls.parse 与测试用）。
 */
function verdictOfAssistant(entry, shape) {
  const parts = Array.isArray(entry?.parts) ? entry.parts : Array.isArray(entry?.content) ? entry.content : []
  const errorPart = parts.find((p) => p?.type === 'error') ?? entry?.info?.error ?? entry?.error ?? null
  if (errorPart != null) {
    return {
      status: 'failed',
      errorPart: typeof errorPart === 'string' ? errorPart : (stableJson(errorPart) ?? String(errorPart)),
      shape: 'assistant-error',
    }
  }
  for (const part of parts) {
    if (part?.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
      return { status: 'done', text: part.text, shape }
    }
  }
  if (typeof entry?.text === 'string' && entry.text.length > 0) {
    return { status: 'done', text: entry.text, shape: `${shape}-flat` }
  }
  return { status: 'running', shape: 'assistant-no-verdict' }
}

/** 角色三级取值：v1 {info:{role}} 信封 → 顶层 role → v2 扁平 type（user/assistant）。 */
const roleOf = (message) => message?.info?.role ?? message?.role ?? (message?.type === 'user' || message?.type === 'assistant' ? message.type : undefined)

/**
 * context 解析消息数组判定（P1.1 A-idle-confirm 判据；裁决规则与失败模式表 evidence/m4/p10-decision.md
 * 裁决规则①/②写死，2026-11-26 fresh + retro 双段实测背书）：
 *
 *   前置门槛：终态判定只认【末条】v2 扁平 idle 条目（实测四键 {id, time:{created}, type:'idle',
 *   outcome}、无 info 信封——判定式 `entry.type === 'idle' && !isPlainObject(entry.info)`）。
 *   idle 只在真实收敛（末条 assistant 完成）后由宿主同步追加（实测滞后 9-17ms，等待代价可忽略）。
 *
 *   - 末条非 idle → running（fail-open），无论末条 assistant 长什么样——text / finish:'stop' /
 *     finish:'tool-calls' 的叙事 text 都不是终态证据（失败模式 4：m4 4/4 误报 done，假 done 与
 *     真收敛差 5-29 分钟）；中段冻结流式条（finish/completed 恒缺，fresh 实测失败模式 3）既不作
 *     running 证据也不作终态证据——终态判定只看末条条目，不发明「存在无 finish 条目 → running」
 *     类全局规则（否则冻结条永不更新、会话永远 running）。
 *   - 末条 idle 且 outcome==='succeeded'（实测词表单值 ["succeeded"]）→ 回看末条 assistant 下
 *     结论（verdictOfAssistant：error 优先于 text）；回看不到 assistant → running（fail-open）。
 *   - 末条 idle 但 outcome 词表外/缺失/非字符串 → running 并记 shape 观测（失败模式 2 fail-open，
 *     绝不发明失败语义；禁扩大化为常态烧超时——正常路径 succeeded 立即终态，异常路径由调度器
 *     per-step timeoutMs 兜底，失败模式 1：idle 永不出现同样步至 timeoutMs 判 failed 不无限等）。
 *   - v1 {info:{role}} 信封形状写死口径（裁决规则②-2）：不被 A 判据豁免——v1-only transcript
 *     （无 v2 idle 尾条）恒 running 交 timeoutMs 兜底；带 type:'idle' 键的 v1 条目因 info 信封
 *     在场不构成门槛（v1 面现役不可达：回环 HTTP 兜底已删）。
 *   - 容器形状容错（terminal-gate pickMessages 同款）：数组直用；{data|messages|history:[...]}
 *     信封取数组；认不出 → running（fail-open，绝不下结论）。
 * shape 字段记录判定依据（calls.parse 与测试用）。
 */
export function judgeContext(transcript) {
  const messages = pickMessages(transcript)
  if (!messages) return { status: 'running', shape: 'unknown' }
  if (messages.length === 0) return { status: 'running', shape: 'empty' }
  const last = messages[messages.length - 1]
  if (last?.type === 'idle' && !isPlainObject(last?.info)) {
    const outcome = typeof last?.outcome === 'string' ? last.outcome : null
    if (outcome !== 'succeeded') return { status: 'running', shape: `idle-${outcome ?? 'unknown'}` }
    const assistant = [...messages].reverse().find((m) => roleOf(m) === 'assistant')
    if (!assistant) return { status: 'running', shape: 'idle-no-assistant' }
    return verdictOfAssistant(assistant, 'assistant-text-v2-idle')
  }
  // A 前置门槛关死：末条不是 v2 idle 形状 → running（末条是 assistant 记 assistant-no-idle——
  // m4 翻车分支的观测名；其余（user 等）记 last-not-idle）
  return roleOf(last) === 'assistant'
    ? { status: 'running', shape: 'assistant-no-idle' }
    : { status: 'running', shape: 'last-not-idle' }
}

/**
 * 终末事件形状（实测 + v1 idle 名）：session.execution.*（蓝图点名）、session.idle（v1 等价物）、
 * message.part.updated 的 step-finish/error part、message.updated 的 assistant+time.completed。
 * 终末事件旁路去抖必投（完成信号不能丢）并触发 trailing recheck。
 */
export function isTerminalishEvent(raw) {
  const type = raw?.type
  if (typeof type !== 'string') return false
  if (type.startsWith('session.execution.')) return true
  if (type === 'session.idle') return true
  if (type === 'message.part.updated') {
    const partType = raw?.data?.part?.type
    return partType === 'step-finish' || partType === 'error'
  }
  if (type === 'message.updated') {
    const info = raw?.data?.info
    return info?.role === 'assistant' && info?.time?.completed != null
  }
  return false
}

/**
 * 生产 driver 工厂（宿主差异收敛点；mock/replay 的 kind 'session' 不经 createDriver——契约测试钉死
 * createDriver('session') 拒装并指路本文件，故独立工厂）。
 * @param {*} ctx 宿主 setup(ctx) 交进的 face 对象：ctx.session.{create,prompt,context} 必需
 *   （实测宿主 17 方法全部在位），wait/interrupt/event 可缺（缺 = 降级记录，对应操作降级/拒）。
 * @param {object} opts
 *   - now?:   () => number（calls.at / 去抖窗口全走它；默认 Date.now）
 *   - sleep?: (ms) => Promise（bounded 竞跑 / trailing / 心跳全走它；默认 setTimeout——测试注入可控时钟）
 *   - fault?: { driverChaos?: { timeoutMs?, halfResponse?, duplicateCallback? } }（生产传 null）
 *   - directory?: string / parentID?: string —— create 时附在宿主 create 参数上（部署形态参数）
 *   - 其余 ms 间隔见 SESSION_DRIVER_DEFAULTS（waitAttemptMs/contextReadMs/eventMinIntervalMs/
 *     trailingRecheckMs/heartbeatMs/executionEventCap）
 * @throws {TypeError} ctx face 缺失或 opts 形状不合法（程序错误 fail-fast，scheduler 同轨）
 */
export function createSessionDriver(ctx, opts = {}) {
  if (!isPlainObject(ctx)) throw new TypeError('createSessionDriver: ctx 必须是宿主 setup(ctx) 交进的对象')
  for (const face of ['create', 'prompt', 'context']) {
    if (typeof ctx.session?.[face] !== 'function') {
      throw new TypeError(`createSessionDriver: ctx.session 缺必需 face ${face}（实测宿主 17 方法在位；缺 = 宿主差异，收敛本文件报缺）`)
    }
  }
  const { now, sleep, fault, directory, parentID, ...msOpts } = opts ?? {}
  if (now !== undefined && typeof now !== 'function') throw new TypeError('createSessionDriver: now 必须是 () => number')
  if (sleep !== undefined && typeof sleep !== 'function') throw new TypeError('createSessionDriver: sleep 必须是 (ms) => Promise')
  if (directory !== undefined && (typeof directory !== 'string' || directory.length === 0)) {
    throw new TypeError('createSessionDriver: directory 必须是非空字符串')
  }
  if (parentID !== undefined && (typeof parentID !== 'string' || parentID.length === 0)) {
    throw new TypeError('createSessionDriver: parentID 必须是非空字符串')
  }
  for (const [name, value] of Object.entries(msOpts)) {
    if (!(name in SESSION_DRIVER_DEFAULTS)) throw new TypeError(`createSessionDriver: 未知选项 "${name}"`)
    if (!Number.isInteger(value) || value < 0) throw new TypeError(`createSessionDriver: ${name} 必须是 ≥0 整数（毫秒）`)
  }
  if (fault !== undefined && fault !== null && !isPlainObject(fault)) throw new TypeError('createSessionDriver: fault 必须是对象或 null')

  const cfg = { ...SESSION_DRIVER_DEFAULTS, ...msOpts }
  const chaos = fault?.driverChaos ?? {}
  const nowFn = now ?? Date.now
  const sleepFn = sleep ?? sleepReal

  const sessions = new Set() // 本 driver create 过的会话（UNKNOWN_SESSION 判据）
  const calls = []
  const executionEvents = []
  const eventStats = { seen: 0, forwarded: 0, dropped: 0, executionRecorded: 0, synthetic: 0, hostErrors: 0 }
  const liveStreams = new Set()
  let seq = 0
  let closed = false
  // duplicateCallback 的状态派生对应物：上次送达值指纹 + 待重投件（result/context 分轨）
  let lastResultKey
  let pendingDupResult
  let lastContextKey
  let pendingDupContext

  const record = (op, args) => {
    const r = { seq: ++seq, op, at: nowFn(), args }
    calls.push(r)
    return r
  }
  const assertOpen = (op) => {
    if (closed) throw driverError('E1_DRIVER_CLOSED', `session driver 已 close，${op} 拒绝执行`)
  }
  const chaosTimeout = (op) => {
    if (chaos.timeoutMs) throw driverError('E1_DRIVER_CHAOS_TIMEOUT', `session driver chaos: ${op} 超时（fault.driverChaos.timeoutMs 注入，宿主不被触碰）`)
  }
  const assertKnown = (sessionId, op) => {
    if (!sessions.has(sessionId)) throw driverError('E1_DRIVER_UNKNOWN_SESSION', `session driver: ${op} 未知 sessionId "${sessionId}"（本 driver 没 create 过它）`)
  }
  const deliverResult = (raw) => (chaos.halfResponse ? { status: raw.status } : raw)

  // ---- wait 优先（decisions-2：裸形一次、有界、抛错降级不映射 failed）----
  async function attemptWait(sessionId, r) {
    if (typeof ctx.session.wait !== 'function') {
      r.wait = { status: 'unsupported' }
      return
    }
    const t0 = nowFn()
    const outcome = await bounded(Promise.resolve().then(() => ctx.session.wait(sessionId)), cfg.waitAttemptMs, sleepFn)
    const ms = nowFn() - t0
    if (outcome.kind === 'ok') r.wait = { status: 'resolved', ms }
    else if (outcome.kind === 'timeout') r.wait = { status: 'timeout', ms: cfg.waitAttemptMs }
    else r.wait = { status: 'threw', ms, error: brief(outcome.error) }
  }

  // ---- context 容错读（decisions-4：读失败/挂死 → null → running，不结论不冒泡）----
  async function readContextTolerant(sessionId, r) {
    const t0 = nowFn()
    const outcome = await bounded(Promise.resolve().then(() => ctx.session.context({ sessionID: sessionId })), cfg.contextReadMs, sleepFn)
    if (outcome.kind === 'ok') {
      r.contextMs = nowFn() - t0
      return outcome.value
    }
    if (outcome.kind === 'timeout') {
      r.contextNote = 'timeout'
    } else {
      r.contextNote = 'threw'
      r.contextError = brief(outcome.error)
    }
    return null
  }

  return {
    kind: 'session',
    calls,
    executionEvents,
    eventStats,

    async create(args) {
      const r = record('create', structuredClone(args))
      try {
        assertOpen('create')
        const bad = validateCreateArgs(args)
        if (!bad.ok) throw driverError('E1_DRIVER_BAD_ARGS', `create: ${bad.errors.join('；')}`)
        chaosTimeout('create')
        let created
        try {
          created = await ctx.session.create({
            title: args.title,
            ...(args.agent !== undefined ? { agent: args.agent } : {}),
            ...(args.model !== undefined ? { model: args.model } : {}), // {providerID, id, variant?} 零转换直传（F4）
            ...(directory !== undefined ? { directory } : {}),
            ...(parentID !== undefined ? { parentID } : {}),
          })
        } catch (error) {
          throw driverError('E1_DRIVER_CREATE_FAILED', `create: 宿主建会话失败：${brief(error)}`)
        }
        // §1 两形状兼容：v1 顶层 id / v2 {data:{id}} 信封（S7a 两条路由都实测在）
        const id = created?.id ?? created?.data?.id
        if (typeof id !== 'string' || id === '') {
          throw driverError(
            'E1_DRIVER_CREATE_FAILED',
            `create: 宿主返回缺非空 id（keys=${created && typeof created === 'object' ? Object.keys(created).join(',') : typeof created}）`,
          )
        }
        try {
          await ctx.session.prompt({ sessionID: id, text: args.prompt, ...(args.agent !== undefined ? { agent: args.agent } : {}) })
        } catch (error) {
          throw driverError('E1_DRIVER_PROMPT_FAILED', `create: 宿主 prompt 失败（session=${id}）：${brief(error)}`)
        }
        sessions.add(id)
        r.sessionId = id
        return { sessionId: id }
      } catch (e) {
        r.error = e.code ?? 'E1_DRIVER_ERROR'
        throw e
      }
    },

    async result(sessionId) {
      const r = record('result', { sessionId })
      try {
        assertOpen('result')
        if (typeof sessionId !== 'string' || sessionId === '') {
          throw driverError('E1_DRIVER_BAD_ARGS', `result: sessionId 必须是非空字符串（得到 ${sessionId === undefined ? '缺省' : typeof sessionId}）`)
        }
        chaosTimeout('result')
        assertKnown(sessionId, 'result')
        // duplicateCallback：待重投件先于新值送达且跳过宿主读（mock takeScripted 同款：dup 不消耗新取数）
        if (chaos.duplicateCallback && pendingDupResult !== undefined) {
          const dupRaw = pendingDupResult
          pendingDupResult = undefined
          r.dup = true
          const response = deliverResult(dupRaw)
          r.response = { ...response }
          return response
        }
        await attemptWait(sessionId, r)
        const transcript = await readContextTolerant(sessionId, r)
        const verdict = judgeContext(transcript)
        r.parse = verdict.shape
        const rawResponse =
          verdict.status === 'done'
            ? { status: 'done', text: verdict.text }
            : verdict.status === 'failed'
              ? { status: 'failed', errorPart: verdict.errorPart }
              : { status: 'running' }
        if (chaos.duplicateCallback) {
          const key = stableJson(rawResponse)
          if (key !== lastResultKey) pendingDupResult = rawResponse
          lastResultKey = key
        }
        const response = deliverResult(rawResponse)
        r.response = { ...response }
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
        if (typeof sessionId !== 'string' || sessionId === '') {
          throw driverError('E1_DRIVER_BAD_ARGS', `context: sessionId 必须是非空字符串（得到 ${sessionId === undefined ? '缺省' : typeof sessionId}）`)
        }
        chaosTimeout('context')
        assertKnown(sessionId, 'context')
        if (chaos.duplicateCallback && pendingDupContext !== undefined) {
          const dupRaw = pendingDupContext
          pendingDupContext = undefined
          r.dup = true
          r.response = dupRaw
          return chaos.halfResponse ? {} : dupRaw
        }
        let raw
        try {
          raw = await ctx.session.context({ sessionID: sessionId })
        } catch (error) {
          throw driverError('E1_DRIVER_CONTEXT_FAILED', `context: 宿主读取失败：${brief(error)}`)
        }
        if (chaos.duplicateCallback) {
          const key = stableJson(raw)
          if (key !== lastContextKey) pendingDupContext = raw
          lastContextKey = key
        }
        const response = chaos.halfResponse ? {} : raw
        r.response = response // 宿主原始对象照搬记录（不克隆——宿主每次给新对象，mock 才克隆）
        return response
      } catch (e) {
        r.error = e.code ?? 'E1_DRIVER_ERROR'
        throw e
      }
    },

    async interrupt(sessionId) {
      const r = record('interrupt', { sessionId })
      try {
        assertOpen('interrupt')
        if (typeof sessionId !== 'string' || sessionId === '') {
          throw driverError('E1_DRIVER_BAD_ARGS', `interrupt: sessionId 必须是非空字符串（得到 ${sessionId === undefined ? '缺省' : typeof sessionId}）`)
        }
        assertKnown(sessionId, 'interrupt')
        if (typeof ctx.session.interrupt !== 'function') {
          throw driverError('E1_DRIVER_BAD_ARGS', 'interrupt: 宿主缺 ctx.session.interrupt face（实测宿主在位；缺 = 宿主差异，拒并记录）')
        }
        try {
          await ctx.session.interrupt({ sessionID: sessionId })
        } catch (error) {
          throw driverError('E1_DRIVER_INTERRUPT_FAILED', `interrupt: 宿主打断失败：${brief(error)}`)
        }
        r.response = { interrupted: true }
        return undefined
      } catch (e) {
        r.error = e.code ?? 'E1_DRIVER_ERROR'
        throw e
      }
    },

    /** 事件流：每次调用 = 独立订阅（新 AsyncIterable）；单消费者语义。 */
    events() {
      assertOpen('events')
      return createEventStream()
    },

    close() {
      if (closed) return
      closed = true
      for (const closeStream of [...liveStreams]) closeStream()
    },
  }

  // ---- 事件泵（去抖 + 终末旁路 + trailing recheck + 心跳；全部走注入 sleep/now）----
  function createEventStream() {
    const queue = []
    let waiter = null
    let streamClosed = false
    let hostIter = null
    let lastForwardAt = -Infinity
    let lastLocation
    let trailingPending = false

    const rawDeliver = (item) => {
      if (waiter) {
        const w = waiter
        waiter = null
        w(item)
      } else {
        queue.push(item)
      }
    }

    if (typeof ctx.event?.subscribe === 'function') {
      try {
        const source = ctx.event.subscribe()
        hostIter = source[Symbol.asyncIterator]()
      } catch {
        hostIter = null
        eventStats.hostErrors += 1
      }
    }

    const pushSynthetic = () => {
      if (queue.length >= EVENT_QUEUE_CAP) {
        eventStats.dropped += 1 // 消费者不拉：丢合成保内存有界
        return
      }
      eventStats.synthetic += 1
      rawDeliver({ value: { type: RECHECK_TYPE, properties: { locationDirectory: lastLocation }, at: nowFn(), synthetic: true }, done: false })
    }

    const scheduleTrailing = () => {
      if (trailingPending) return
      trailingPending = true
      void sleepFn(cfg.trailingRecheckMs).then(() => {
        trailingPending = false
        if (!streamClosed && !closed) pushSynthetic()
      })
    }

    const handleRaw = (raw) => {
      eventStats.seen += 1
      const type = typeof raw?.type === 'string' ? raw.type : String(raw?.type ?? '')
      if (type.startsWith('session.execution.')) {
        eventStats.executionRecorded += 1
        if (executionEvents.length < cfg.executionEventCap) executionEvents.push({ at: nowFn(), event: raw }) // 出现即记形状
      }
      const loc = raw?.properties?.locationDirectory ?? raw?.location?.directory
      if (typeof loc === 'string' && loc.length > 0) lastLocation = loc
      const terminalish = isTerminalishEvent(raw)
      if (!terminalish && nowFn() - lastForwardAt < cfg.eventMinIntervalMs) {
        eventStats.dropped += 1
        return
      }
      lastForwardAt = nowFn()
      eventStats.forwarded += 1
      rawDeliver({ value: { type, properties: { locationDirectory: lastLocation }, at: nowFn(), synthetic: false }, done: false })
      if (terminalish) scheduleTrailing()
    }

    // 宿主泵：源抛错/结束只停宿主半边（记 hostErrors），合成通道保活到 close
    void (async () => {
      if (!hostIter) return
      try {
        while (true) {
          const chunk = await hostIter.next()
          if (chunk.done || streamClosed || closed) break
          handleRaw(chunk.value)
        }
      } catch {
        eventStats.hostErrors += 1
      }
    })()

    // 心跳：session.execution.* 实测 0 条、事件通道不可依赖——活性上界靠它（heartbeatMs=0 关）
    void (async () => {
      while (!streamClosed && !closed && cfg.heartbeatMs > 0) {
        await sleepFn(cfg.heartbeatMs)
        if (streamClosed || closed) break
        pushSynthetic()
      }
    })()

    const closeStream = () => {
      if (streamClosed) return
      streamClosed = true
      liveStreams.delete(closeStream)
      if (waiter) {
        const w = waiter
        waiter = null
        w({ done: true })
      }
      if (hostIter && typeof hostIter.return === 'function') {
        Promise.resolve()
          .then(() => hostIter.return())
          .catch(() => {})
      }
    }
    liveStreams.add(closeStream)

    return {
      [Symbol.asyncIterator]() {
        return this
      },
      async next() {
        if (queue.length > 0) return queue.shift() // close 后剩余项先排干再 done
        if (streamClosed || closed) return { done: true }
        return new Promise((resolve) => {
          waiter = resolve
        })
      },
      async return() {
        closeStream() // 消费者停（调度器 finally）：本流收尾，driver 仍开
        return { done: true }
      },
    }
  }
}
