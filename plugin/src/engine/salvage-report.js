// C3 失败打捞报告（优化方案 v3.1「C3」行，.zcode/plans/optimization-plan-v3.md §C 表）：
// run failed/interrupted 时也产报告——由盘上 journal 渲染，不依赖 run 主体存活。
// 中断（进程死 / run promise 拒绝 / fault.abortAt 崩溃）之后，run 主体什么都带不走，
// journal 三铁律保证盘上事实先于一切动作存在——报告正是这张底座的读端：只经 storage.read
// 读盘上 record，不建 journal 实例、不写 journal（resume.js 同款纯读端纪律）。
//
// 内容清单（计划原文写死，三件不少）：
//   1. 全部 done 步的 ask 结果——journal ask 事件 payload.value（脚本路径）；声明路径的步
//      没有 ask 事件（typedAsk 的结果落在 done 迁移 payload），其 ask 结果 = done payload
//      （result.text/sessionId）。两路同进一张表，来源列注明（ask 事件 / done payload）。
//   2. 失败点——failed/blocked 步的状态与错误 payload（计划钉死）＋在飞中断点
//      （dispatching/running）。中断 run 的报告若只认 failed/blocked 将零线索：崩溃现场
//      的步恰恰停在在飞态（S6 abortAt 崩位 = dispatching），它们就是全部线索。
//   3. visualize.js mermaid 图——renderRunReport 复用（声明路径 DAG 按步状态着色；脚本
//      路径 phase 时间线，outcome.status='failed' 尾红已支持）。mermaid 一律走
//      renderRunReport 的 markdown（```mermaid 围栏 + 图例），本文件不自己拼围栏。
//   4. 补段边界（C2；有 patch 事件才出节）——base→patched 指纹 + anchor + 应用时 callSeq
//      （script-patch.js applyPatch 落盘的 patch 事件 payload）。这是 spike 必答题⑥的
//      「事后审计锚点」：allow 后补段即在宿主进程内执行 F.run 副作用，报告必须能对出
//      「哪次执行跑的是哪份字节」。
//
// 落点与格式（计划原文「沿用现 run 报告路径，markdown + ```mermaid 围栏」）：本仓现存的
// per-run 落盘路径只有 journal 本身（makeJournalStorage → <主干>.journal.json），故报告
// 沿用同一目录同一主干：<主干>.report.md（salvageReportPath 推导；storage.file 形状认不出
// → 调用方显式传 reportPath，TypeError fail-fast——报告落点是接线事实，不静默发明）。
//
// journal 读数三态（journal.js 三铁律的读端镜像；渲染降级面）：
//   完好 record —— 全内容渲染；
//   撕裂 / 形状坏 / 读盘错 / 无记录 —— salvageable:false，如实注明（撕裂字节原样保留，
//   绝不重写 journal）；mermaid 图退到「全部未完成」的保守口径（resume 同款：宁可重跑，
//   不可假完成），ask/失败点两节如实写「无可打捞」。
//
// run 终局（报告头一行）：调用方给的 outcome.status 优先（run 主体活着才有）；否则由
// journal 推导：failed/superseded 步 → failed；blocked 步 → blocked；有步未全终态 →
// interrupted（run 主体死在半途）；盘上无步记账（脚本路径 record 只有事件，终局标记只在
// run 主体广播不落盘）→ unknown——推导不出就明说推导不出，不发明终局。
//
// 与 visualize.js 同哲学：纯渲染不抛，任何垃圾输入都返形状良好的结果（errors 逐条列），
// 不抛——报告生成跑在 run 终态之后，渲染炸了不该把一次其实可打捞的 run 拖成异常。
// TypeError 只留给程序级接线错误（runId 推导不出 / 注入面形状不对），与 scheduler 分轨同款。
//
// 注入面（§6 纪律；生产传缺省）：now（默认 Date.now；报告生成时刻全走它）、writeReport
// （(path, text) => void；默认 mkdirSync+writeFileSync——测试注入假写做「报告写失败」的
// 故障缝，禁 monkey-patch）。journal 只读不写；报告文件写失败 → {ok:false}，盘上 journal
// 分毫未动（报告是 run 之外的附加产物，它的失败不回滚任何引擎事实）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

import { validateJournalRecord } from './journal.js'
import { renderRunReport } from './visualize.js'

/** 报告文件后缀（与 makeJournalStorage 的 `.journal.json` 同目录同主干成对）。 */
export const SALVAGE_REPORT_SUFFIX = '.report.md'

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const brief = (v) => String(v?.message ?? v).slice(0, 160)

/** journal 步状态 → 报告节的归桶：failed/blocked = 计划钉死的失败点；dispatching/running = 在飞中断点。 */
const FAILURE_STATES = Object.freeze(['failed', 'blocked'])
const INFLIGHT_STATES = Object.freeze(['dispatching', 'running'])

/** markdown 表格单元格卫生：竖线转义、换行压平。 */
const cell = (v) => String(v).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')

/** 字符串原样、其余 compact JSON（JSON.stringify 不过的兜底 String——单元格卫生归 cell）。 */
function jsonish(v) {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

/** 截断（防长 payload 撑爆表）。 */
function capText(v, cap) {
  const text = jsonish(v)
  return text.length > cap ? `${text.slice(0, cap)}…` : text
}

/** 反引号单元格：`内容`（管道已转义、超长已截）。 */
const cellValue = (v, cap = 240) => `\`${cell(capText(v, cap))}\``

/** 报告路径推导：<storage.file 的 .journal.json> → 同目录同主干 .report.md；形状认不出 → null（调用方显式给）。 */
export function salvageReportPath(storage) {
  const file = storage?.file
  if (typeof file !== 'string' || !file.endsWith('.journal.json')) return null
  return `${file.slice(0, -'.journal.json'.length)}${SALVAGE_REPORT_SUFFIX}`
}

/** history 里倒找第一条 to===state 的迁移（payload 挂在终态迁移上；倒序是防御手搓 record 的形状漂移，resume.js 同款）。 */
function tailOfState(step, state) {
  const history = Array.isArray(step?.history) ? step.history : []
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i]
    if (isPlainObject(entry) && entry.to === state) return entry
  }
  return null
}

/**
 * 内容①采集：ask 结果全集 = journal ask 事件（payload.value 在位才算——ask-failed 不进，
 * 打捞面只认成功 ask）＋ done 步的 done payload（声明路径）。ask 事件已点名同一 stepId 时
 * done 步不重复列（脚本路径 record.steps 本无步，纯防御）。垃圾形状逐条软错误，不抛。
 */
function collectAskResults(record, errors) {
  const asks = []
  const askStepIds = new Set()
  const events = Array.isArray(record?.events) ? record.events : []
  events.forEach((event, index) => {
    if (!isPlainObject(event) || event.type !== 'ask') return
    if (!isPlainObject(event.payload) || !Object.hasOwn(event.payload, 'value')) {
      errors.push(`events[${index}]: ask 事件缺 payload.value，跳过（打捞面只认成功 ask）`)
      return
    }
    const stepId = typeof event.payload.stepId === 'string' && event.payload.stepId.length > 0 ? event.payload.stepId : null
    if (stepId !== null) askStepIds.add(stepId)
    asks.push({ source: 'ask-event', stepId, at: event.at, attempts: event.payload.attempts, value: event.payload.value })
  })
  const doneSteps = []
  const steps = isPlainObject(record?.steps) ? record.steps : {}
  for (const [stepId, step] of Object.entries(steps)) {
    if (!isPlainObject(step) || step.state !== 'done' || askStepIds.has(stepId)) continue
    const tail = tailOfState(step, 'done')
    doneSteps.push({
      source: 'done-payload',
      stepId,
      at: tail?.at,
      attempts: Number.isInteger(step.attempts) ? step.attempts : null,
      value: tail?.payload !== undefined ? tail.payload : {},
    })
  }
  return { asks, doneSteps }
}

/**
 * 内容②采集：失败点 = failed/blocked（kind:'failure'）＋ dispatching/running（kind:'inflight'，
 * 在飞中断点）。错误 payload = 该状态迁移的 payload（原样；无 → {}）。
 */
function collectFailurePoints(record) {
  const failures = []
  const inflight = []
  const steps = isPlainObject(record?.steps) ? record.steps : {}
  for (const [stepId, step] of Object.entries(steps)) {
    if (!isPlainObject(step) || typeof step.state !== 'string') continue
    const isFailure = FAILURE_STATES.includes(step.state)
    const isInflight = INFLIGHT_STATES.includes(step.state)
    if (!isFailure && !isInflight) continue
    const tail = tailOfState(step, step.state)
    const point = {
      stepId,
      state: step.state,
      kind: isFailure ? 'failure' : 'inflight',
      attempts: Number.isInteger(step.attempts) ? step.attempts : null,
      at: tail?.at,
      payload: tail?.payload !== undefined ? tail.payload : {},
    }
    const bucket = isFailure ? failures : inflight
    bucket.push(point)
  }
  return { failures, inflight }
}

/** 其余步清点（声明序无关——按 record.steps 键序）：declared 未派 / superseded 连带作废。 */
function collectRest(record) {
  const pending = []
  const superseded = []
  const steps = isPlainObject(record?.steps) ? record.steps : {}
  for (const [stepId, step] of Object.entries(steps)) {
    if (!isPlainObject(step) || typeof step.state !== 'string') continue
    if (step.state === 'superseded') superseded.push(stepId)
    else if (step.state === 'declared') pending.push(stepId)
  }
  return { pending, superseded }
}

/**
 * 补段边界采集（C2；patch 事件由 script-patch.js applyPatch 落盘，payload 自由形——
 * journal 只查 {type, at}）：逐笔收 {patchSeq, baseFingerprint, patchedFingerprint, anchor,
 * holeRef?, appliedAfterCallSeq, reason, source, at}。payload 缺失/形状坏 → 软错误跳过
 * （报告不抛，与 ask 采集同轨）。
 */
function collectPatches(record, errors) {
  const patches = []
  const events = Array.isArray(record?.events) ? record.events : []
  events.forEach((event, index) => {
    if (!isPlainObject(event) || event.type !== 'patch') return
    if (!isPlainObject(event.payload)) {
      errors.push(`events[${index}]: patch 事件缺 payload，跳过`)
      return
    }
    const p = event.payload
    patches.push({
      at: event.at,
      patchSeq: Number.isInteger(p.patchSeq) ? p.patchSeq : null,
      baseFingerprint: typeof p.baseFingerprint === 'string' ? p.baseFingerprint : null,
      patchedFingerprint: typeof p.patchedFingerprint === 'string' ? p.patchedFingerprint : null,
      anchor: typeof p.anchor === 'string' ? p.anchor : null,
      holeRef: isPlainObject(p.holeRef) ? p.holeRef : null,
      appliedAfterCallSeq: Number.isInteger(p.appliedAfterCallSeq) ? p.appliedAfterCallSeq : null,
      reason: typeof p.reason === 'string' ? p.reason : null,
      source: typeof p.source === 'string' ? p.source : null,
    })
  })
  return patches
}

/**
 * journal 终局推导（outcome 缺席时的兜底；口径见头注）：failed/superseded → failed；
 * blocked → blocked；有步未全终态 → interrupted；无步记账（脚本路径）→ unknown。
 */
function deriveStatus(record) {
  if (!isPlainObject(record)) return 'unknown'
  const states = Object.values(isPlainObject(record.steps) ? record.steps : {})
    .map((step) => (isPlainObject(step) && typeof step.state === 'string' ? step.state : null))
    .filter((state) => state !== null)
  if (states.length === 0) return 'unknown'
  if (states.some((state) => state === 'failed' || state === 'superseded')) return 'failed'
  if (states.some((state) => state === 'blocked')) return 'blocked'
  if (states.every((state) => state === 'done')) return 'completed'
  return 'interrupted'
}

/** 推导态的一行解释（报告头注明口径，不让读者猜「interrupted 是谁判的」）。 */
const STATUS_NOTE = Object.freeze({
  failed: '（journal 推导——有 failed/superseded 步）',
  blocked: '（journal 推导——有 blocked 步）',
  interrupted: '（journal 推导——run 主体未交终局，步停在半途；现场见失败点节）',
  completed: '（journal 推导——全步 done）',
  unknown: '（无法推导——盘上无步记账；脚本路径的终局标记只在 run 主体广播、不落盘）',
})

/**
 * 纯渲染：盘上 journal record → 打捞报告 markdown（永不因数据形状抛；TypeError 只归程序错误）。
 * @param {object} input
 *   - runId: 非空字符串（报告标题锚点；writeSalvageReport 从 declaration/journalRecord 推导）
 *   - declaration?: 声明对象（可选；给了走 renderRunReport 声明路径 DAG）
 *   - journalRecord?: 盘上 record（{runId, updatedAt, steps, events}；null/缺省 = 盘上无可用记录）
 *   - outcome?: run 级结果（可选；{status, reason?, error?}——run 主体活着才有）
 *   - note?: journal 侧异常说明（撕裂/形状坏/读盘错/无记录的一句人话；null = 完好）
 *   - now?: () => number（默认 Date.now；报告生成时刻）
 * @returns {{ok:true, errors, markdown, salvageable, status, statusSource, askResults,
 *            doneSteps, failurePoints, inflightPoints, patches, graph}}
 */
export function renderSalvageReport(input = {}) {
  const { runId, declaration = null, journalRecord = null, outcome = null, note = null, now } = input ?? {}
  if (typeof runId !== 'string' || runId.length === 0) throw new TypeError('renderSalvageReport: runId 必须是非空字符串')
  if (now !== undefined && typeof now !== 'function') throw new TypeError('renderSalvageReport: now 必须是 () => number')
  if (journalRecord !== null && journalRecord !== undefined && !isPlainObject(journalRecord)) {
    throw new TypeError('renderSalvageReport: journalRecord 必须是盘上 record 形状的对象或 null')
  }
  if (outcome !== null && outcome !== undefined && !isPlainObject(outcome)) {
    throw new TypeError('renderSalvageReport: outcome 必须是 {status, reason?, error?} 形状的对象或 null')
  }
  if (note !== null && note !== undefined && typeof note !== 'string') {
    throw new TypeError('renderSalvageReport: note 必须是字符串或 null')
  }
  const nowFn = now ?? Date.now
  const errors = []
  const record = isPlainObject(journalRecord) ? journalRecord : null

  const { asks, doneSteps } = collectAskResults(record, errors)
  const { failures, inflight } = collectFailurePoints(record)
  const rest = collectRest(record)
  const patches = collectPatches(record, errors)
  const askResults = [...asks, ...doneSteps]
  const failurePoints = [...failures, ...inflight]

  // run 终局：outcome.status 优先（来源=调用方），journal 推导兜底（来源=journal）。
  // note 在 → 推导同样拒绝消费 record（与图的 deny 口径一致）。
  const derived = note !== null ? 'unknown' : deriveStatus(record)
  const outcomeStatus = isPlainObject(outcome) && typeof outcome.status === 'string' && outcome.status.length > 0 ? outcome.status : null
  const status = outcomeStatus ?? derived
  const statusSource = outcomeStatus !== null ? 'outcome' : 'journal'

  // 内容③：mermaid 图（renderRunReport 复用）。outcome 透传调用方的；否则推导 failed 传
  // {status:'failed'}（脚本尾红，计划点名「failed 尾红已支持」）、completed 同理；interrupted/
  // blocked/unknown 不传（脚本尾=running=「停在这里」的如实读法；声明路径着色本就不吃 outcome）。
  const graphOutcome =
    outcomeStatus !== null ? outcome : derived === 'failed' ? { status: 'failed' } : derived === 'completed' ? { status: 'completed' } : null
  // note（撕裂/读错/无记录）在 → 图不消费 record（deny 语义）：「全部未完成」的保守口径必须
  // 真成立，不能嘴上保守、图上照画。
  const graph = renderRunReport({
    declaration: isPlainObject(declaration) ? declaration : null,
    journalRecord: note !== null ? null : record,
    outcome: graphOutcome,
  })

  // ---- 报告头 ----
  const lines = [`# Run 打捞报告：${runId}`, '']
  lines.push(
    `- 生成：${new Date(nowFn()).toISOString()}（journal 驱动——run failed/interrupted 也产报告；只读盘上 journal，不依赖 run 主体存活。优化方案 v3.1 C3）`,
  )
  const outcomeBits = []
  if (isPlainObject(outcome)) {
    if (typeof outcome.reason === 'string' && outcome.reason.length > 0) outcomeBits.push(`reason=${outcome.reason}`)
    if (outcome.error !== undefined && outcome.error !== null) outcomeBits.push(`error=${cell(capText(outcome.error, 160))}`)
  }
  let outcomeLine = `- run 终局：${status}`
  if (outcomeBits.length > 0) outcomeLine += `（${outcomeBits.join(' · ')}）`
  outcomeLine += statusSource === 'outcome' ? '——来源：调用方 outcome' : (STATUS_NOTE[status] ?? '')
  lines.push(outcomeLine)
  if (note !== null) {
    lines.push(`- journal：${note}`)
  } else if (record !== null) {
    const stepCount = Object.keys(isPlainObject(record.steps) ? record.steps : {}).length
    const eventCount = Array.isArray(record.events) ? record.events.length : 0
    const updatedAt = Number.isFinite(record.updatedAt) ? new Date(record.updatedAt).toISOString() : String(record.updatedAt)
    lines.push(`- journal：完好——${stepCount} 步 / ${eventCount} 事件，updatedAt=${updatedAt}`)
  } else {
    lines.push('- journal：无可读记录')
  }
  lines.push('')

  // ---- 内容③：mermaid 节 ----
  lines.push('## mermaid 图', '')
  if (note !== null) {
    lines.push(`> ⚠ ${note}；图按「全部未完成」的保守口径画（宁可重跑，不可假完成）。`, '')
  }
  if (graph.ok && !graph.empty) {
    lines.push(graph.markdown)
  } else if (graph.ok && graph.empty) {
    lines.push('> （无可渲染节点——journal 里还没有已发生的步/phase）', '')
  } else {
    for (const error of graph.errors) lines.push(`> mermaid 渲染不可用：${error}`)
    lines.push('')
  }

  // ---- 内容①：ask 结果节 ----
  lines.push(`## ask 结果（共 ${askResults.length} 条）`, '')
  if (askResults.length === 0) {
    lines.push('（无可打捞的 ask 结果）', '')
  } else {
    lines.push('| # | 来源 | step | 结果 | attempts |', '| --- | --- | --- | --- | --- |')
    askResults.forEach((result, index) => {
      const source = result.source === 'ask-event' ? 'ask 事件' : 'done payload'
      // done payload 的「结果」优先取 result.text（那才是 ask 拿回的答案）；整个 payload 留给
      // 形状不合时的兜底（sessionId 等细节归 journal，报告不逐字段复读）。
      const answer = result.source === 'done-payload' && typeof result.value?.result?.text === 'string' ? result.value.result.text : result.value
      lines.push(`| ${index + 1} | ${source} | ${cell(result.stepId ?? '—')} | ${cellValue(answer)} | ${result.attempts ?? '—'} |`)
    })
    lines.push('')
  }

  // ---- 内容②：失败点节 ----
  lines.push(`## 失败点（共 ${failurePoints.length} 条）`, '')
  if (failurePoints.length === 0) {
    lines.push('（journal 里没有 failed/blocked/在飞步）', '')
  } else {
    lines.push('| step | 状态 | attempts | 错误 payload |', '| --- | --- | --- | --- |')
    for (const point of failurePoints) {
      const stateCell = point.kind === 'inflight' ? `${point.state}（在飞中断）` : point.state
      const payloadKeys = isPlainObject(point.payload) ? Object.keys(point.payload).length : point.payload !== undefined ? 1 : 0
      const payloadCell = payloadKeys > 0 ? cellValue(point.payload) : '（无）'
      lines.push(`| ${cell(point.stepId)} | ${stateCell} | ${point.attempts ?? '—'} | ${payloadCell} |`)
    }
    lines.push('')
  }

  // ---- 补段边界节（C2；有 patch 事件才出节——非补段 run 的报告字节与既往零差异）----
  // 补段边界（base→patched 指纹 + anchor）是「事后审计锚点」（spike 必答题⑥）：allow 后补段
  // 即在宿主进程内执行 F.run 副作用，报告必须能让读者对出「哪次执行跑的是哪份字节」。
  if (patches.length > 0) {
    lines.push(`## 补段边界（共 ${patches.length} 次）`, '')
    lines.push(
      '| patch | anchor | base 指纹 | patched 指纹 | 应用时 callSeq | reason | source | holeRef |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
    )
    for (const p of patches) {
      lines.push(
        `| ${p.patchSeq ?? '—'} | ${cell(p.anchor ?? '—')} | \`${cell(p.baseFingerprint ?? '—')}\` | \`${cell(p.patchedFingerprint ?? '—')}\` | ${p.appliedAfterCallSeq ?? '—'} | ${cell(p.reason ?? '—')} | ${cell(p.source ?? '—')} | ${p.holeRef !== null ? cellValue(p.holeRef) : '—'} |`,
      )
    }
    lines.push('')
  }

  // ---- 其余步清点（一行；declared 未派与 superseded 连带作废不在上两节，缺席会让读者误读全貌）----
  const restParts = []
  if (rest.pending.length > 0) restParts.push(`未派: ${rest.pending.join(', ')}`)
  if (rest.superseded.length > 0) restParts.push(`superseded(连带作废): ${rest.superseded.join(', ')}`)
  lines.push(restParts.length > 0 ? `其余步清点：${restParts.join(' · ')}` : '其余步清点：无')

  const markdown = `${lines.join('\n')}\n`
  return {
    ok: true,
    errors,
    markdown,
    salvageable: record !== null,
    status,
    statusSource,
    askResults,
    doneSteps,
    failurePoints,
    inflightPoints: inflight,
    patches,
    graph,
  }
}

/**
 * 读盘 → 渲染 → 落盘（C3 的写入口；报告永远尝试产出——failed/interrupted 时也产）。
 * journal 只经 storage.read 读（读失败/撕裂/形状坏/无记录 → 降级为如实注明的报告，
 * salvageable:false；撕裂字节原样保留，绝不重写 journal）。报告写失败 → {ok:false}。
 * @param {object} input
 *   - storage: {read}（makeJournalStorage 产物或同形状）——盘上 journal 的唯一真相源
 *   - declaration?: 声明对象（可选；mermaid 声明路径 + runId 推导来源）
 *   - outcome?: run 级结果（可选；run 主体活着才传）
 *   - reportPath?: 非空字符串（缺省 = salvageReportPath(storage)；推导不出且未传 → TypeError）
 *   - now?: () => number（默认 Date.now；报告生成时刻）
 *   - writeReport?: (path, text) => void（默认 mkdirSync+writeFileSync；测试注入假写做故障缝）
 * @returns {{ok:true, path, bytes, salvageable, status, statusSource, askResults, failurePoints,
 *            doneSteps, inflightPoints, patches, markdown, errors}} |
 *           {{ok:false, reason:'report-write-failed', path, error}}
 * @throws {TypeError} storage/reportPath/writeReport 形状不对，或 runId 推导不出
 */
export function writeSalvageReport(input = {}) {
  const { storage, declaration = null, outcome = null, reportPath, now, writeReport } = input ?? {}
  if (!isPlainObject(storage) || typeof storage.read !== 'function') {
    throw new TypeError('writeSalvageReport: storage 必须是 {read}（makeJournalStorage 产物或同形状）——报告只读盘上 journal')
  }
  if (reportPath !== undefined && (typeof reportPath !== 'string' || reportPath.length === 0)) {
    throw new TypeError('writeSalvageReport: reportPath 必须是非空字符串')
  }
  if (writeReport !== undefined && typeof writeReport !== 'function') {
    throw new TypeError('writeSalvageReport: writeReport 必须是 (path, text) => void（缺省 mkdirSync+writeFileSync）')
  }
  const path = reportPath ?? salvageReportPath(storage)
  if (!path) {
    throw new TypeError('writeSalvageReport: 报告路径推导不出（storage.file 不是 .journal.json 结尾）——显式传 reportPath')
  }

  // 盘上 journal 读数：读失败/撕裂/形状坏/无记录全降级为如实注明（journal 三铁律读端镜像）。
  let raw = null
  let readError = null
  try {
    raw = storage.read()
  } catch (error) {
    readError = error
  }
  let note = null
  let record = null
  if (readError !== null) {
    note = `journal 读盘失败（${brief(readError)}）——按撕裂保守口径处理`
  } else if (raw == null) {
    note = '盘上无 journal 记录（崩在首次落盘之前）'
  } else {
    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
    if (!isPlainObject(parsed)) {
      note = 'journal 撕裂（unparseable）——撕裂字节原样保留，本报告不尝试修复'
    } else {
      record = validateJournalRecord(parsed)
      if (!record) note = 'journal 形状坏（shape-invalid）——按撕裂保守口径处理'
    }
  }

  // runId：declaration 优先，盘上 record 兜底；两处都拿不到 = 接线错误，TypeError fail-fast
  // （报告没有 runId 锚点就是废纸——落点文件名都靠它，不静默编一个）。
  const runId =
    (isPlainObject(declaration) && typeof declaration.runId === 'string' && declaration.runId.length > 0 && declaration.runId) ||
    (record !== null && typeof record.runId === 'string' && record.runId.length > 0 && record.runId) ||
    null
  if (!runId) throw new TypeError('writeSalvageReport: runId 推导不出（declaration/journalRecord 都没有）——传 declaration 或用合法 journal')

  const rendered = renderSalvageReport({
    runId,
    declaration: isPlainObject(declaration) ? declaration : null,
    journalRecord: record,
    outcome: isPlainObject(outcome) ? outcome : null,
    note,
    now,
  })
  try {
    if (writeReport !== undefined) {
      writeReport(path, rendered.markdown)
    } else {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, rendered.markdown, 'utf8')
    }
  } catch (error) {
    return { ok: false, reason: 'report-write-failed', path, error: brief(error) }
  }
  return {
    ok: true,
    path,
    bytes: rendered.markdown.length,
    salvageable: rendered.salvageable,
    status: rendered.status,
    statusSource: rendered.statusSource,
    askResults: rendered.askResults,
    doneSteps: rendered.doneSteps,
    failurePoints: rendered.failurePoints,
    inflightPoints: rendered.inflightPoints,
    patches: rendered.patches,
    markdown: rendered.markdown,
    errors: rendered.errors,
  }
}

// ── Q4 机器读数契约（v4.3 计划 Q4 行）：runStatusCode 六码映射 + --status 单命令入口 ──
// 盘上 journal 的机器读数：run 以状态码说话（编排方/脚本 if 判断的入口），渲染面（上面的
// markdown 报告）照旧不受影响。入参 = 盘上 record 对象或 null（torn——CLI 负责读文件 +
// validateJournalRecord，认不出合法 record 就传 null，本函数不自己读盘）。
//
// 六码：0 completed / 1 failed / 2 blocked-escalation / 3 interrupted / 4 journal-torn /
// 5 unknown。优先级对齐 scheduler.finish（escalation-pending > 熔断 > failed——混合现场先判
// 挂起）：其中熔断（scheduler.js:396 的 run-blocked 事件）在六码里无独立码，其现场在盘上
// 就是 failed 步（熔断由连续失败触发，failed 步必然在账），故按 failed 读出；可判的先后序
// 只有「挂起先于 failed」——这正是混合现场的验收断言点（1 failed + 1 挂起 → 2 非 1）。
// blocked-escalation 推导 = 事件级判据（escalated 无 escalation-answered 配对）非纯状态扫描
// （blocked 步态只说明曾经挂起过，答复与否只有事件流水能证明）。

/** 六码字典（名 → 码；消费方按名引用，不散落魔法数）。 */
export const RUN_STATUS_CODES = Object.freeze({
  completed: 0,
  failed: 1,
  'blocked-escalation': 2,
  interrupted: 3,
  'journal-torn': 4,
  unknown: 5,
})

/** 码 → 名（CLI 打印与测试断言用）。 */
const RUN_STATUS_NAMES = new Map(Object.entries(RUN_STATUS_CODES).map(([name, code]) => [code, name]))

/**
 * blocked-escalation 事件级判据：存在无 escalation-answered 配对的 escalated 事件。
 * 同一步可多次挂起-答复（挂起→答复→再挂起），按事件序逐对消耗：escalated 入账、answered
 * 销账；销账时不越步Id乱配（本步无挂起则不误销别步——防手搓 journal 的重复答复串味）。
 * payload 缺可用 stepId 的事件归全局兜底桶（scheduler 落盘必带 stepId，此桶纯防御）。
 */
function hasPendingEscalation(record) {
  const events = Array.isArray(record?.events) ? record.events : []
  const open = new Map() // stepId → 未答复 escalated 计数
  let openUnknown = 0
  for (const event of events) {
    if (!isPlainObject(event)) continue
    const payload = isPlainObject(event.payload) ? event.payload : null
    const stepId = payload !== null && typeof payload.stepId === 'string' && payload.stepId.length > 0 ? payload.stepId : null
    if (event.type === 'escalated') {
      if (stepId === null) openUnknown += 1
      else open.set(stepId, (open.get(stepId) ?? 0) + 1)
    } else if (event.type === 'escalation-answered') {
      if (stepId !== null && (open.get(stepId) ?? 0) > 0) open.set(stepId, open.get(stepId) - 1)
      else if (stepId === null && openUnknown > 0) openUnknown -= 1
    }
  }
  if (openUnknown > 0) return true
  for (const count of open.values()) {
    if (count > 0) return true
  }
  return false
}

/**
 * run 状态码（六码映射；Q4 机器读数契约的唯一读数口）。
 * @param {object|null} record 盘上 record 对象（validateJournalRecord 产物或同形状）或 null（torn——
 *   撕裂/形状坏/读盘错/无记录，CLI 侧已认不出合法 record）
 * @returns {number} RUN_STATUS_CODES 之一（0-5）
 * @throws {TypeError} record 既非对象也非 null（程序级接线错误，与渲染面分轨）
 */
export function runStatusCode(record) {
  if (record !== null && !isPlainObject(record)) {
    throw new TypeError('runStatusCode: record 必须是盘上 record 形状的对象或 null（torn）')
  }
  if (record === null) return RUN_STATUS_CODES['journal-torn']
  // 1) blocked-escalation 先判（事件级判据）——对齐 scheduler.finish 的 escalPending 先于
  //    blockedInfo/failed；混合现场（failed 步 + 挂起问句并存）必须读 2 非 1。
  if (hasPendingEscalation(record)) return RUN_STATUS_CODES['blocked-escalation']
  // 2) 步记账扫描（口径同 deriveStatus；blocked 步态若无事件级挂起佐证，按半途 interrupted
  //    读出——「挂起过」与「还挂着」的区别只有事件流水能证明）。
  const states = Object.values(isPlainObject(record.steps) ? record.steps : {})
    .map((step) => (isPlainObject(step) && typeof step.state === 'string' ? step.state : null))
    .filter((state) => state !== null)
  if (states.length === 0) return RUN_STATUS_CODES.unknown // 脚本路径 record 无步记账——推导不出就明说
  if (states.some((state) => state === 'failed' || state === 'superseded')) return RUN_STATUS_CODES.failed
  if (states.every((state) => state === 'done')) return RUN_STATUS_CODES.completed
  return RUN_STATUS_CODES.interrupted // declared/dispatching/running/blocked（无挂起佐证）——死在半途
}

/** 用法行（usage 错误打印；六码语义一并写死在这里，--help 无需单独旗标）。 */
const RUN_STATUS_USAGE =
  '用法：node plugin/src/engine/salvage-report.js --status <journalPath>（以状态码退出：' +
  '0 completed / 1 failed / 2 blocked-escalation / 3 interrupted / 4 journal-torn / 5 unknown）'

/**
 * --status 单命令入口（可注入 argv 直测；返回退出码，不自己 process.exit——退出码交给调用
 * 方/主守卫设 process.exitCode，stdout 自然冲刷）。读文件 + JSON.parse + validateJournalRecord
 * 是 CLI 的职责（计划写死）：认不出合法 record（撕裂/形状坏/读盘错/不存在）一律按 torn 传
 * null → 4。成功打一行「<码> <名>」（机器吃退出码，人看 stdout 一眼）；用法错 → 用法行进
 * stderr + 退出码 64（EX_USAGE，在六码域外，不与状态码混音）。
 * @param {string[]} argv 命令行参数（缺省 process.argv.slice(2)）
 * @returns {number} 退出码（0-5，或 64 = 用法错）
 */
export function runStatusCli(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--status' || typeof argv[1] !== 'string' || argv[1].length === 0) {
    process.stderr.write(`${RUN_STATUS_USAGE}\n`)
    return 64
  }
  let record = null
  try {
    let parsed = null
    try {
      parsed = JSON.parse(readFileSync(argv[1], 'utf8'))
    } catch {
      parsed = null // 撕裂/空文件：parse 不出形状，落 torn 口径
    }
    record = validateJournalRecord(parsed) // 合法返回原值，否则 null（形状坏/非对象）
  } catch {
    record = null // 读盘失败（不存在/无权限）：同 torn 口径
  }
  const code = runStatusCode(record)
  process.stdout.write(`${code} ${RUN_STATUS_NAMES.get(code)}\n`)
  return code
}

// 直跑主守卫（ESM 标准判据）：node plugin/src/engine/salvage-report.js --status <journalPath>
// 以状态码退出；被 import（测试/引擎内复用）时不触发。
const INVOKED_AS_CLI = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (INVOKED_AS_CLI) process.exitCode = runStatusCli(process.argv.slice(2))
