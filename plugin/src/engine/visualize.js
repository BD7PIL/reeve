// E1 引擎可视化（M2.5①；蓝图 .zcode/plans/next-phase-plan-m1-m5.md「M2.4/M2.5」行）：
// 「自动 mermaid DAG：声明路径 = steps+deps 直渲；脚本路径 = phase 事件时间线渲染
// （脚本静态结构不可预知，如实画时间线）；节点按 journal 状态着色，进 markdown 报告」。
//
// 定位：**纯渲染器**——不读盘、不触时钟、不 import 引擎任何执行件（declaration.js 的
// validateDeclaration 是登记/执行侧的守门，渲染器不复查图性质，图长什么样就画什么；
// 环/自指等垃圾边如实画出——「如实」优先于「体面」，且渲染器绝不因数据形状半坏而抛）。
// 与 declaration.js 同哲学：任何垃圾输入都返形状良好的结果（{ok:false, errors[]}），
// 不抛（报告生成跑在 run 终态之后，渲染炸了不该把一次其实跑完的 run 拖成异常）。
//
// 两条路径（M2.5① 原文分轨）：
//   声明路径  节点 = declaration.steps（stepId），边 = deps（dep --> step：依赖先跑）；
//             状态 = journal 的步记账（listSteps() / 盘上 record.steps 同形——都读 .state），
//             journal 里没有的步（尚未播种/快照缺节）一律 pending——「不知道 ≠ 进行中」。
//   脚本路径  脚本不是步（script-runner：journal 只记事件，无步状态机），静态结构不可预知
//             → 只画**已发生的 phase 事件**，按 at 时间先后连成一条链（时间线，不是图）；
//             尾节点的着色看 run 结果（outcome.status）：completed 全 done；failed 尾红；
//             在飞/未知 → 尾 running（脚本此刻大概率还在尾 phase 里）。phase 事件之间夹的
//             ask/run/log 事件只用来判「该 phase 之后还有没有动静」，不进节点。
//
// 着色（M2.5①「节点按 journal 状态着色」）：journal 七态收敛到六个视觉桶（done/running/
// pending/failed/blocked/superseded；ask 点名的四桶 done/running/pending/failed 全覆盖，
// blocked 与 superseded 是 journal 实有状态，不能静默混进别桶误导读者）：
//   done→绿 · running→蓝 · pending→灰 · failed→红 · blocked→琥珀 · superseded→虚线灰。
// dispatching（在飞）视觉上并进 running 桶（同为进行中），declared 并进 pending 桶。
// classDef 用实色底 + 白字（宿主深浅两主题下都可读；报告是 markdown，主题由阅读方定）。
//
// 输出：mermaid（flowchart LR 语句）与 markdown（```mermaid 围栏 + 一行图例）两个面；
// 围栏用三反引号——调用方把它整段嵌进自己的报告模板即可。节点 ID 一律 n0..nN（首见序），
// 标签转义后再进引号（" → #quot; · # → #35; · 反斜杠/换行压平 · 超长截断），杜绝
// 「步名里带个引号就把整张图渲染挂了」这类事。
//
// 注入面：无（纯函数；测试也不需要时钟/故障注入——这是 M2.5① 的渲染面，不是执行面）。
// 「不在飞」的判定走显式 outcome.status 参数，不看任何真实时钟。

/** journal 状态 → 视觉桶（M2.5① 点名 done/running/pending/failed 四桶 + journal 实有的另两态）。 */
export const STATE_BUCKETS = Object.freeze(['done', 'running', 'pending', 'failed', 'blocked', 'superseded'])

/** 桶 → mermaid classDef 名（常量导出，测试与下游报告模板可对照）。 */
export const BUCKET_CLASS = Object.freeze({
  done: 'st-done',
  running: 'st-running',
  pending: 'st-pending',
  failed: 'st-failed',
  blocked: 'st-blocked',
  superseded: 'st-superseded',
})

/** classDef 定义行（顺序即图例顺序）。实色底 + 白字，深浅主题都成立。 */
export const BUCKET_CLASSDEFS = Object.freeze([
  'classDef st-done fill:#1a7f37,stroke:#1a7f37,color:#ffffff',
  'classDef st-running fill:#0969da,stroke:#0969da,color:#ffffff',
  'classDef st-pending fill:#8c959f,stroke:#8c959f,color:#ffffff',
  'classDef st-failed fill:#cf222e,stroke:#cf222e,color:#ffffff',
  'classDef st-blocked fill:#9a6700,stroke:#9a6700,color:#ffffff',
  'classDef st-superseded fill:#6e7781,stroke:#adbac7,stroke-dasharray:4 3,color:#ffffff',
])

const BUCKET_OF_STATE = Object.freeze({
  done: 'done',
  running: 'running',
  dispatching: 'running', // 在飞 = 进行中（视觉桶只有六格，journal 的 dispatching 并入 running）
  declared: 'pending', // 已播种未派 = 未开始
  failed: 'failed',
  blocked: 'blocked',
  superseded: 'superseded',
})

/** journal 状态 → 视觉桶；未知/缺省一律 pending（「不知道」不是「进行中」，也不能假红假绿）。 */
export function stateBucket(state) {
  return BUCKET_OF_STATE[state] ?? 'pending'
}

const LABEL_CAP = 80

/** mermaid 节点标签转义：先截断（防劈开转义实体）再压反斜杠/换行/制表，引号与 # 用 mermaid 实体。 */
function mermaidLabel(value) {
  const raw = String(value).replace(/\\/g, '/').replace(/[\r\n\t]+/g, ' ')
  const capped = raw.length > LABEL_CAP ? `${raw.slice(0, LABEL_CAP)}…` : raw
  return capped.replace(/#/g, '#35;').replace(/"/g, '#quot;')
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 从 journal 步记账（listSteps() 或盘上 record.steps，两者 .state 同位）读单步状态。 */
function stepStateOf(stepsMap, stepId) {
  if (!isPlainObject(stepsMap)) return null
  const entry = stepsMap[stepId]
  return isPlainObject(entry) && typeof entry.state === 'string' ? entry.state : null
}

/** 渲染结果的公共骨架（空图也返 ok:true + empty:true——「没东西可画」与「输入是垃圾」是两件事）。 */
const frame = (extra = {}) => ({ ok: false, errors: [], empty: false, mermaid: '', markdown: '', ...extra })

/** 组 markdown：```mermaid 围栏 + 一行图例（图例顺序 = BUCKET_CLASSDEFS 顺序）。 */
function toMarkdown(mermaid) {
  const legend = '图例：绿=done · 蓝=running（含 dispatching） · 灰=pending（含 declared/未知） · 红=failed · 琥珀=blocked · 虚灰=superseded'
  return ['```mermaid', mermaid, '```', '', legend, ''].join('\n')
}

/** 把桶分组拼成 `class n0,n1 st-xxx` 行（空桶不产行；顺序跟 BUCKET_CLASSDEFS）。 */
function classLines(byBucket) {
  const lines = []
  for (const bucket of STATE_BUCKETS) {
    const ids = byBucket.get(bucket)
    if (ids?.length) lines.push(`class ${ids.join(',')} ${BUCKET_CLASS[bucket]}`)
  }
  return lines
}

/**
 * 声明路径：steps+deps 直渲 DAG。
 * @param {object} input
 *   - declaration: {runId?, steps: [{stepId, deps?}]}（渲染器不复查 schema/图性质——那归 declaration.js）
 *   - journalSteps: journal 步记账（listSteps() 返回值或盘上 record.steps；缺省/缺步 = pending）
 * @returns {{ok, errors, empty, mermaid, markdown, nodeCount, edgeCount}} 纯函数不抛；
 *   ok=false 仅当 declaration 形状根本不可用（非对象 / steps 不是数组）。
 */
export function renderDeclarationDag(input = {}) {
  const { declaration, journalSteps = null } = input ?? {}
  if (!isPlainObject(declaration) || !Array.isArray(declaration.steps)) {
    return frame({ errors: ['declaration: 必须是 {steps:[…]} 形状（渲染不可用）'] })
  }
  const errors = []
  const nodes = [] // {id, label, bucket}（首见序）
  const idOf = new Map() // stepId → 节点 ID
  const byBucket = new Map() // 桶 → [节点 ID]
  for (const step of declaration.steps) {
    const stepId = isPlainObject(step) && typeof step.stepId === 'string' && step.stepId.length > 0 ? step.stepId : null
    if (!stepId) {
      errors.push('steps: 有缺 stepId（非字符串/空）的步，跳过不画')
      continue
    }
    if (idOf.has(stepId)) {
      errors.push(`steps: 重复 stepId "${stepId}"，只画首见`)
      continue
    }
    const state = stepStateOf(journalSteps, stepId)
    const bucket = stateBucket(state)
    if (state !== null && BUCKET_OF_STATE[state] === undefined) {
      errors.push(`steps["${stepId}"]: journal 状态 "${state}" 不认识，按 pending 画`)
    }
    const id = `n${nodes.length}`
    idOf.set(stepId, id)
    nodes.push({ id, label: stepId, bucket })
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), id])
  }
  if (nodes.length === 0) return frame({ ok: true, empty: true, errors })

  const edges = []
  const edgeSeen = new Set() // 重复 stepId 的 deps 与同一条边重复声明都不重复画（节点首见，边唯一）
  for (const step of declaration.steps) {
    const stepId = isPlainObject(step) ? step.stepId : null
    if (typeof stepId !== 'string' || !idOf.has(stepId) || edgeSeen.has(`step:${stepId}`)) continue
    edgeSeen.add(`step:${stepId}`)
    if (!Array.isArray(step.deps)) continue
    for (const dep of step.deps) {
      if (typeof dep !== 'string' || dep.length === 0) {
        errors.push(`steps["${stepId}"]: deps 有非字符串项，跳过该边`)
        continue
      }
      if (dep === stepId) {
        errors.push(`steps["${stepId}"]: 自引用边不画（环画出来也只是自环，信息量为零）`)
        continue
      }
      const from = idOf.get(dep)
      if (!from) {
        errors.push(`steps["${stepId}"]: 依赖 "${dep}" 不在步表里，跳过该边`)
        continue
      }
      const key = `${from}->${idOf.get(stepId)}`
      if (edgeSeen.has(key)) continue
      edgeSeen.add(key)
      edges.push(`${from} --> ${idOf.get(stepId)}`)
    }
  }

  const lines = ['flowchart LR']
  for (const node of nodes) lines.push(`    ${node.id}["${mermaidLabel(node.label)}"]`)
  lines.push(...edges.map((e) => `    ${e}`))
  lines.push(...BUCKET_CLASSDEFS.map((d) => `    ${d}`))
  lines.push(...classLines(byBucket).map((l) => `    ${l}`))
  const mermaid = lines.join('\n')
  return frame({ ok: true, mermaid, markdown: toMarkdown(mermaid), nodeCount: nodes.length, edgeCount: edges.length, errors })
}

/**
 * 脚本路径：phase 事件时间线（事件序 = at 升序、同 at 保首见序；节点间连成链）。
 * @param {object} input
 *   - events: journal 事件数组 [{type, at, payload}]（record.events / result 内存镜像同形）
 *   - outcome: {status?}——run 结果（'completed'|'failed'|其他）：completed 全 done、failed 尾红、
 *     缺省/其他（在飞）尾 running。没有 phase 事件时 empty:true（脚本还没标过 phase）。
 * @returns {{ok, errors, empty, mermaid, markdown, phaseCount}}
 */
export function renderScriptTimeline(input = {}) {
  const { events, outcome = null } = input ?? {}
  if (!Array.isArray(events)) {
    return frame({ errors: ['events: 必须是事件数组（渲染不可用）'] })
  }
  const errors = []
  const phases = [] // {name, at, index}
  events.forEach((event, index) => {
    if (!isPlainObject(event) || event.type !== 'phase') return
    const name = isPlainObject(event.payload) && typeof event.payload.name === 'string' && event.payload.name.length > 0 ? event.payload.name : null
    if (!name) {
      errors.push(`events[${index}]: phase 事件缺 name，跳过`)
      return
    }
    phases.push({ name, at: typeof event.at === 'number' && Number.isFinite(event.at) ? event.at : index, index })
  })
  if (phases.length === 0) return frame({ ok: true, empty: true, errors })
  // at 升序；at 缺失（NaN/缺键）按首见序兜底——同 at 保持首见序（索引作次键，稳定）。
  phases.sort((a, b) => a.at - b.at || a.index - b.index)

  const status = isPlainObject(outcome) && typeof outcome.status === 'string' ? outcome.status : null
  const tailBucket = status === 'completed' ? 'done' : status === 'failed' ? 'failed' : 'running'
  const byBucket = new Map()
  const lines = ['flowchart LR']
  const ids = phases.map((phase, i) => {
    const id = `p${i}`
    const bucket = i === phases.length - 1 ? tailBucket : 'done' // 已被后续 phase 接上的都是过去 = done
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), id])
    lines.push(`    ${id}["${mermaidLabel(phase.name)}"]`)
    return id
  })
  for (let i = 1; i < ids.length; i++) lines.push(`    ${ids[i - 1]} --> ${ids[i]}`)
  lines.push(...BUCKET_CLASSDEFS.map((d) => `    ${d}`))
  lines.push(...classLines(byBucket).map((l) => `    ${l}`))
  const mermaid = lines.join('\n')
  return frame({ ok: true, mermaid, markdown: toMarkdown(mermaid), phaseCount: phases.length, errors })
}

/**
 * 报告入口：按数据源自动分轨（M2.5①「引擎报告内自动」——调用方只喂 run 的两样真相：
 * 声明与 journal，不自己判断走哪条路）。
 *   有 declaration（含 steps 数组）→ 声明路径 DAG（状态取 journalSteps）；
 *   否则 journalRecord 有 events → 脚本路径 phase 时间线；
 *   两样都没有 → ok:false（没数据不硬画）。
 * journalRecord 直接给盘上 record（{runId, steps, events}）即可；runId 两边都有且不同 →
 * ok:false（把别的 run 的状态画到这份声明上比不画更糟）。
 * @param {object} input
 *   - declaration: 声明对象（可选）
 *   - journalRecord: journal record（可选；{runId?, steps?, events?}）
 *   - outcome: {status?} run 级结果（脚本路径尾节点着色用；声明路径状态以 journal 为准，不用它）
 */
export function renderRunReport(input = {}) {
  const { declaration = null, journalRecord = null, outcome = null } = input ?? {}
  const errors = []
  if (!isPlainObject(declaration) && !isPlainObject(journalRecord)) {
    return { ok: false, mode: null, errors: ['没有可渲染的数据源：给 declaration（声明路径）或 journalRecord（脚本路径）'], empty: false, mermaid: '', markdown: '' }
  }
  const useDeclaration = isPlainObject(declaration) && Array.isArray(declaration.steps)
  const recordRunId = isPlainObject(journalRecord) && typeof journalRecord.runId === 'string' ? journalRecord.runId : null
  const declarationRunId = useDeclaration && typeof declaration.runId === 'string' ? declaration.runId : null
  if (useDeclaration && recordRunId && declarationRunId && recordRunId !== declarationRunId) {
    return {
      ok: false,
      mode: null,
      errors: [`runId 不匹配：declaration=${declarationRunId} · journal=${recordRunId}——拒绝把别的 run 的状态画到这份声明上`],
      empty: false,
      mermaid: '',
      markdown: '',
    }
  }
  if (useDeclaration) {
    const steps = isPlainObject(journalRecord) && isPlainObject(journalRecord.steps) ? journalRecord.steps : null
    const rendered = renderDeclarationDag({ declaration, journalSteps: steps })
    return { ...rendered, mode: 'declaration' }
  }
  // journalRecord 形状不足以画声明路径（无 steps 数组/无声明）→ 走脚本时间线
  if (isPlainObject(journalRecord) && Array.isArray(journalRecord.events)) {
    const rendered = renderScriptTimeline({ events: journalRecord.events, outcome })
    return { ...rendered, mode: 'script' }
  }
  errors.push('journalRecord: 缺 events 数组（脚本路径）或 declaration.steps 数组（声明路径）——无可渲染数据')
  return { ok: false, mode: null, errors, empty: false, mermaid: '', markdown: '' }
}
