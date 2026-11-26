// Engine runs：E1 引擎运行的步卡/进度（M2.5②；D 线打磨，优化方案 v3「D」节）。
//
// 数据源：快照的 `engine.runs`（plugin/src/snapshot.js 的 projectEngineRuns 投影——面板不自己算，
// 与 tasks/stats 同哲学：数字由插件聚合，面板只渲染）。快照里没有这一节（旧插件 / 没跑过引擎）
// 就整节不画 —— 「没有这个功能」与「功能空转」是两件事。
//
// D 线增量（每一件都以"数据真的在"为前提，缺了就退回上一档渲染，绝不假装）：
//   D1 四态一眼可辨：run 卡按状态着左条（completed 绿 / running 主色 / failed 红 / blocked 琥珀）
//     + run 级状态徽标；失败步整行 error 微染 + 左竖条（CSS :has 徽标 tone）；
//     耗时（startedAt→updatedAt / 在飞→now）与重试（attempts>1 →「尝试 ×n」）可见。
//   D2 DAG 视图：声明路径 steps+deps → 按依赖深度分列的图（SVG 覆层画边，宿主 token 着色，
//     同 plugin/src/engine/visualize.js 的六视觉桶）+ 可展开的 mermaid 源（与报告围栏同一形状，
//     面板 iframe 不引 mermaid.js——离线 + 体积，图自己画，源照给）；
//     脚本路径 phase 时间线（链式 chips，尾段随 run 结果着色——同 visualize.js 规则）。
//   D3 审批卡：kind=script 且 status=blocked 且 producer 给了摘要/命令集/分叉说明时，
//     画 workflow-script 审批卡（脚本摘要 + 静态扫描命令集 + phase 列表 + 分叉说明 +
//     静态扫描边界说明）。挂起而没带材料的 run 只照常画行卡——不编造审批材料。
//
// 只读纪律：本模块不碰 writeFile，不 startSession/prompt（check.mjs 的守门盯着）。
// 状态徽标照 journal 七态原样着色（done=绿 · running/dispatching=主色 · declared/未知=中性 ·
// failed=红 · blocked=警示 · superseded=中性）；kind（declaration/script）与状态 ID 永不翻译。

import { badge, kitIcon, list, section, stat } from './kit.js'
import { t } from './i18n.js'
import { el, fmtAgo, fmtMs } from './util.js'

/** journal 状态 → 徽标色（unknown/null → neutral：「不知道」不吵不绿）。 */
export const ENGINE_STATE_TONE = {
  done: 'success',
  running: 'primary',
  dispatching: 'primary',
  declared: 'neutral',
  pending: 'neutral',
  failed: 'error',
  blocked: 'warning',
  superseded: 'neutral',
}

/** run 级状态 → 徽标色。 */
export const RUN_STATUS_TONE = {
  running: 'primary',
  completed: 'success',
  failed: 'error',
  blocked: 'warning',
}

// journal 七态 → 六视觉桶（与 plugin/src/engine/visualize.js 的 BUCKET_OF_STATE 同表：
// dispatching 并进 running，declared/未知并进 pending——「不知道 ≠ 进行中」）。
const BUCKET_OF_STATE = Object.freeze({
  done: 'done',
  running: 'running',
  dispatching: 'running',
  declared: 'pending',
  failed: 'failed',
  blocked: 'blocked',
  superseded: 'superseded',
})

const bucketOf = (state) => BUCKET_OF_STATE[state] ?? 'pending'

// mermaid classDef（与 visualize.js 的 BUCKET_CLASSDEFS 逐字同表——面板给出去的源要能
// 原样粘进报告围栏渲染）。只进 <pre> 文本，不参与面板 DOM 配色（配色走宿主 token CSS）。
const MERMAID_CLASSDEFS = Object.freeze([
  'classDef st-done fill:#1a7f37,stroke:#1a7f37,color:#ffffff',
  'classDef st-running fill:#0969da,stroke:#0969da,color:#ffffff',
  'classDef st-pending fill:#8c959f,stroke:#8c959f,color:#ffffff',
  'classDef st-failed fill:#cf222e,stroke:#cf222e,color:#ffffff',
  'classDef st-blocked fill:#9a6700,stroke:#9a6700,color:#ffffff',
  'classDef st-superseded fill:#6e7781,stroke:#adbac7,stroke-dasharray:4 3,color:#ffffff',
])

const MERMAID_BUCKETS = Object.freeze(['done', 'running', 'pending', 'failed', 'blocked', 'superseded'])

const stateBadge = (state) => {
  const key = `estate.${String(state ?? '')}`
  const label = t(key)
  return { label: label === key ? String(state ?? '?') : label, tone: ENGINE_STATE_TONE[state] ?? 'neutral' }
}

const statusBadge = (status) => {
  const key = `runstatus.${String(status ?? '')}`
  const label = t(key)
  return label === key ? null : { label, tone: RUN_STATUS_TONE[status] ?? 'neutral' }
}

const kindLabel = (kind) => (kind === 'script' ? t('runs.kindScript') : t('runs.kindDeclaration'))

const count = (steps, state) => (steps ?? []).filter((s) => s.state === state).length

/** mermaid 节点标签转义（visualize.js 的 mermaidLabel 同规则：压平 → 截断 → 实体转义）。 */
function mermaidLabel(value) {
  const raw = String(value).replace(/\\/g, '/').replace(/[\r\n\t]+/g, ' ')
  const capped = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw
  return capped.replace(/#/g, '#35;').replace(/"/g, '#quot;')
}

/** 声明 steps+deps → mermaid（flowchart LR + classDef；与 visualize.js renderDeclarationDag 同形状）。 */
function mermaidOfSteps(steps) {
  const idOf = new Map()
  const byBucket = new Map()
  const lines = ['flowchart LR']
  steps.forEach((s, i) => {
    const id = `n${i}`
    idOf.set(s.stepId, id)
    const bucket = bucketOf(s.state)
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), id])
    lines.push(`    ${id}["${mermaidLabel(s.stepId)}"]`)
  })
  const edgeSeen = new Set()
  for (const s of steps) {
    if (edgeSeen.has(s.stepId)) continue
    edgeSeen.add(s.stepId)
    for (const dep of s.deps ?? []) {
      if (!idOf.has(dep) || dep === s.stepId) continue
      lines.push(`    ${idOf.get(dep)} --> ${idOf.get(s.stepId)}`)
    }
  }
  lines.push(...MERMAID_CLASSDEFS)
  for (const bucket of MERMAID_BUCKETS) {
    const ids = byBucket.get(bucket)
    if (ids?.length) lines.push(`    class ${ids.join(',')} st-${bucket}`)
  }
  return lines.join('\n')
}

/**
 * 依赖深度（最长路；环不炸——迭代到不动点或步数上限为止，环上步如实排进后面的列）。
 * 未知 dep（不在步表里）与自引用当没有这条边。
 */
function dagColumns(steps) {
  const ids = new Set(steps.map((s) => s.stepId))
  const depsOf = new Map(steps.map((s) => [s.stepId, (s.deps ?? []).filter((d) => ids.has(d) && d !== s.stepId)]))
  const depth = new Map()
  for (let round = 0; round <= steps.length; round++) {
    let changed = false
    for (const [id, deps] of depsOf) {
      const d = deps.length ? Math.max(...deps.map((x) => depth.get(x) ?? -1)) + 1 : 0
      if ((depth.get(id) ?? -1) < d) {
        depth.set(id, d)
        changed = true
      }
    }
    if (!changed) break
  }
  return depth
}

/**
 * 声明 DAG：按依赖深度分列（LR），节点 chip 按视觉桶着色，边画在 SVG 覆层。
 * render 时树还没挂进文档，边在挂载后的 rAF 里量（offsetLeft/offsetTop 不受滚动影响）。
 */
function renderDag(run) {
  const steps = run.steps ?? []
  const depth = dagColumns(steps)
  // 列数 = 最大深度 + 1（深度从 0 起算；差一会让最深列的步整列丢掉）
  const colCount = Math.max(0, ...[...depth.values()]) + 1
  const byCol = []
  for (const s of steps) {
    const d = depth.get(s.stepId) ?? 0
    ;(byCol[d] ??= []).push(s)
  }
  const grid = el('div', {
    class: 'oc-dag',
    'data-run-dag': run.runId,
    'aria-label': t('runs.dagAria'),
    style: `grid-template-columns:repeat(${colCount}, minmax(96px, 1fr))`,
  })
  const nodeEls = new Map()
  for (let c = 0; c < colCount; c++) {
    const col = el('div', { class: 'oc-dag-col' })
    for (const s of byCol[c] ?? []) {
      const chip = el('span', {
        class: 'oc-dag-node',
        'data-bucket': bucketOf(s.state),
        'data-dag-node': s.stepId,
        // Q5b：声明步有 description 显示人话标签，无则回退 stepId；stepId 留在 title 里保身份可查
        title: `${s.stepId} · ${stateBadge(s.state).label}`,
        text: s.description || s.stepId,
      })
      if (s.attempts > 1) {
        chip.append(el('span', { class: 'oc-dag-retry', text: `×${s.attempts}`, title: t('runs.attempts', { n: s.attempts }) }))
      }
      nodeEls.set(s.stepId, chip)
      col.append(chip)
    }
    grid.append(col)
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'oc-dag-edges')
  svg.setAttribute('data-dag-edges', run.runId)
  svg.setAttribute('aria-hidden', 'true')
  const wrap = el('div', { class: 'oc-dag-wrap' }, [grid, svg])

  const edgePairs = []
  for (const s of steps) {
    for (const dep of s.deps ?? []) {
      if (nodeEls.has(dep) && dep !== s.stepId) edgePairs.push([dep, s.stepId])
    }
  }
  let tries = 0
  const draw = () => {
    // 幂等：重画前清掉旧边（轮询期间布局可能还在动）
    svg.replaceChildren()
    const w = wrap.scrollWidth
    const h = Math.max(wrap.scrollHeight, wrap.clientHeight)
    svg.setAttribute('width', String(w))
    svg.setAttribute('height', String(h))
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
    for (const [from, to] of edgePairs) {
      const a = nodeEls.get(from)
      const b = nodeEls.get(to)
      if (!a || !b) continue
      const x1 = a.offsetLeft + a.offsetWidth
      const y1 = a.offsetTop + a.offsetHeight / 2
      const x2 = b.offsetLeft
      const y2 = b.offsetTop + b.offsetHeight / 2
      const dx = Math.max(16, (x2 - x1) / 2)
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('class', 'oc-dag-edge')
      path.setAttribute('d', `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`)
      svg.append(path)
    }
  }
  const tick = () => {
    tries++
    if (wrap.isConnected) {
      try {
        draw()
      } catch {
        /* 布局竞态（测量时被挪动/隐藏）：下一轮重画 */
      }
      // 画完（边数齐）就停；没挂上或还没画齐就定时重试——rAF 在后台页会被节流，不能只靠它
      if (svg.childElementCount >= edgePairs.length) return
    }
    if (tries <= 150) setTimeout(tick, 33)
  }
  // 微任务里先画一次：render 返回后调用方同步 append，微任务时树已挂上、布局可按需测量
  // （快照每轮刷新会整节重建，新节靠自己的微任务即时画齐——轮询只是兜底，不是主路径）
  queueMicrotask(() => {
    try {
      draw()
    } catch {
      /* 兜底轮询会重画 */
    }
  })
  requestAnimationFrame(tick)
  return wrap
}

/** mermaid 源折叠块（与报告围栏同一形状；面板 iframe 不引 mermaid.js，源照给）。 */
function dagSourceBlock(run) {
  const node = el('details', { class: 'oc-advanced oc-dag-details' })
  const summary = el('summary', { class: 'oc-micro oc-muted' })
  summary.append(kitIcon(el('span', { class: 'oc-chev' }), 'chevron', 12), el('span', { text: t('runs.dagSource') }))
  node.append(summary)
  node.append(el('pre', { class: 'oc-pre oc-mono oc-micro', 'data-dag-source': run.runId, text: mermaidOfSteps(run.steps ?? []) }))
  return node
}

/**
 * 脚本路径 phase 时间线：链式 chips，尾段随 run 结果着色（visualize.js 同规则：
 * completed 全 done / failed 尾红 / 在飞未知尾 running）。`plan: true` = 审批卡里的
 * phase 名序表——还没跑，全部中性 chip，不假着色。
 */
function renderPhases(run, { plan = false } = {}) {
  const phases = run.phases ?? []
  // 尾段随 run 结果着色（visualize.js 同规则 + blocked→blocked：挂起的脚本不在飞，不假蓝）
  const tailBucket = run.status === 'completed' ? 'done' : run.status === 'failed' ? 'failed' : run.status === 'blocked' ? 'blocked' : 'running'
  const tailLabel = stateBadge(tailBucket === 'done' ? 'done' : tailBucket === 'failed' ? 'failed' : tailBucket === 'blocked' ? 'blocked' : 'running').label
  const row = el('div', {
    class: 'oc-phases',
    'data-run-phases': run.runId,
    ...(plan ? { 'data-approval': 'phases' } : {}),
    'aria-label': t('runs.phases', { names: phases.join(' → ') }),
  })
  phases.forEach((name, i) => {
    if (i > 0) row.append(el('span', { class: 'oc-phase-sep', 'aria-hidden': 'true', text: '→' }))
    const last = i === phases.length - 1
    const chip = el('span', {
      class: 'oc-phase',
      text: String(name),
      ...(plan ? {} : { 'data-bucket': last ? tailBucket : 'done' }),
      title: plan ? String(name) : `${name} · ${last ? tailLabel : stateBadge('done').label}`,
    })
    row.append(chip)
  })
  return row
}

/** D3 workflow-script 审批卡：脚本摘要 + 静态扫描命令集 + phase 列表 + 分叉说明 + 扫描边界说明。 */
function renderApprovalCard(run) {
  const card = el('div', { class: 'oc-approval', 'data-run-approval': run.runId })
  const head = el('div', { class: 'oc-bar' })
  head.append(badge({ label: t('runs.approvalTitle'), tone: 'warning' }).node)
  head.append(el('span', { class: 'oc-label', text: t('runs.approvalCard') }))
  card.append(head)

  if (run.summary) {
    const block = el('div', { class: 'oc-col oc-approval-block' })
    block.append(el('span', { class: 'oc-micro oc-muted', text: t('runs.approvalSummary') }))
    block.append(el('div', { class: 'oc-meta', 'data-approval-summary': run.runId, text: run.summary }))
    card.append(block)
  }

  if (Array.isArray(run.commands) && run.commands.length) {
    const block = el('div', { class: 'oc-col oc-approval-block' })
    block.append(el('span', { class: 'oc-micro oc-muted', text: t('runs.approvalCommands', { n: run.commands.length }) }))
    const cmds = el('div', { class: 'oc-col oc-approval-cmds' })
    for (const cmd of run.commands) cmds.append(el('code', { class: 'oc-approval-cmd oc-mono', text: String(cmd) }))
    block.append(cmds)
    card.append(block)
  }

  if (Array.isArray(run.phases) && run.phases.length) {
    const block = el('div', { class: 'oc-col oc-approval-block' })
    block.append(el('span', { class: 'oc-micro oc-muted', text: t('runs.phasesLabel') }))
    block.append(renderPhases(run, { plan: true }))
    card.append(block)
  }

  if (Array.isArray(run.forks) && run.forks.length) {
    const block = el('div', { class: 'oc-col oc-approval-block' })
    block.append(el('span', { class: 'oc-micro oc-muted', text: t('runs.approvalForks') }))
    for (const fork of run.forks) {
      block.append(el('div', { class: 'oc-approval-fork oc-micro', text: `· ${fork}` }))
    }
    card.append(block)
  }

  card.append(el('div', { class: 'oc-micro oc-muted oc-approval-caveat', 'data-approval-caveat': run.runId, text: t('runs.approvalCaveat') }))
  return card
}

/** 一次运行的步卡列表行（list kit 同款形状；步不可点开——journal 不带子会话号，别假装能开）。 */
function stepRows(run) {
  return (run.steps ?? []).map((s) => ({
    id: `${run.runId}#${s.stepId}`,
    title: s.stepId,
    subtitle: s.attempts > 1 ? t('runs.attempts', { n: s.attempts }) : '',
    badge: stateBadge(s.state),
    disabled: true,
  }))
}

/** run 级耗时：终态 = updatedAt−startedAt；在飞 = now−startedAt（活读数）。没有 startedAt 不画。 */
function durationText(run) {
  if (typeof run.startedAt !== 'number' || !Number.isFinite(run.startedAt)) return null
  const flying = run.status === 'running' || run.status == null
  const end = flying || typeof run.updatedAt !== 'number' ? Date.now() : run.updatedAt
  return t('runs.duration', { time: fmtMs(Math.max(0, end - run.startedAt)) })
}

export function createRunsSection() {
  /** 渲染一次运行节（`.oc-section`）；没有数据返回 null（调用方无需判断）。 */
  function render(snapshot) {
    const runs = snapshot?.engine?.runs
    if (!Array.isArray(runs) || runs.length === 0) return null

    const totals = runs.reduce(
      (acc, run) => ({
        steps: acc.steps + (run.steps?.length ?? 0),
        done: acc.done + count(run.steps, 'done'),
        running: acc.running + count(run.steps, 'running') + count(run.steps, 'dispatching'),
        failed: acc.failed + count(run.steps, 'failed'),
      }),
      { steps: 0, done: 0, running: 0, failed: 0 },
    )

    const cells = el('div', { class: 'oc-stats' })
    cells.append(
      stat(t('runs.runs'), String(runs.length)),
      stat(t('runs.stepsDone'), `${totals.done}/${totals.steps}`, totals.steps > 0 && totals.done === totals.steps ? 'ok' : undefined),
      stat(t('runs.stepsRunning'), String(totals.running), totals.running ? 'info' : undefined),
      stat(t('runs.stepsFailed'), String(totals.failed), totals.failed ? 'err' : undefined),
    )

    const body = [cells]
    for (const run of runs) {
      const cardNode = el('div', { class: 'oc-run', 'data-run': run.runId, 'data-status': String(run.status ?? '') })

      const head = el('div', { class: 'oc-bar oc-bar-between' })
      const idCell = el('div', { class: 'oc-bar' })
      idCell.append(badge({ label: run.runId, tone: 'neutral' }).node)
      idCell.append(el('span', { class: 'oc-micro oc-muted', text: kindLabel(run.kind) }))
      head.append(idCell)
      const right = el('div', { class: 'oc-bar' })
      const total = run.steps?.length ?? 0
      right.append(el('span', { class: 'oc-micro oc-muted', text: t('runs.progress', { done: count(run.steps, 'done'), total }) }))
      const st = statusBadge(run.status)
      if (st) {
        const badgeKit = badge(st)
        badgeKit.node.firstElementChild?.setAttribute('data-run-status', String(run.status))
        right.append(badgeKit.node)
      }
      const dur = durationText(run)
      if (dur) right.append(el('span', { class: 'oc-micro oc-muted oc-nowrap', text: dur }))
      if (run.updatedAt) right.append(el('span', { class: 'oc-micro oc-muted', text: fmtAgo(run.updatedAt) }))
      head.append(right)
      cardNode.append(head)

      // 声明路径：有 deps → DAG（+ mermaid 源）；没有 → 步卡行（deps 数据没到不硬画图）
      const hasDeps = (run.steps ?? []).some((s) => Array.isArray(s.deps) && s.deps.length > 0)
      if (hasDeps) {
        cardNode.append(renderDag(run))
        cardNode.append(dagSourceBlock(run))
      } else {
        const rows = stepRows(run)
        if (rows.length) {
          cardNode.append(el('div', { class: 'oc-runs-steps' }, [list({ items: rows, ariaLabel: t('runs.aria'), emptyText: t('runs.noSteps') }).node]))
        }
      }

      // 脚本路径：phase 时间线（声明 run 的 phases 字段按 producer 给不给渲染，同一段代码）
      if (!hasDeps && Array.isArray(run.phases) && run.phases.length) {
        const row = el('div', { class: 'oc-bar oc-phases-line' })
        row.append(el('span', { class: 'oc-micro oc-muted', text: t('runs.phasesLabel') }))
        row.append(renderPhases(run))
        cardNode.append(row)
      }

      if (!hasDeps && !(run.steps ?? []).length && !(Array.isArray(run.phases) && run.phases.length)) {
        cardNode.append(el('div', { class: 'oc-micro oc-muted', text: t('runs.noSteps') }))
      }

      // D3 审批卡：挂起 + 脚本 + producer 带了材料（摘要/命令集/分叉）才画；缺材料不编造
      if (run.kind === 'script' && run.status === 'blocked' && (run.summary || run.commands?.length || run.forks?.length)) {
        cardNode.append(renderApprovalCard(run))
      }

      body.push(cardNode)
    }

    const node = section({ title: t('runs.title'), hint: t('runs.hint'), body })
    node.setAttribute('data-section', 'runs')
    return node
  }

  return { render }
}
