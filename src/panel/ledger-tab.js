// Tasks tab：本地记账的子Tasks列表（谁派的、什么状态、跑了多久。
//
// 会话树那一段**去掉了**：宿主自己就有会话列表（点日期/会话切换器，面板再抄一份只会
// 让人分不清哪个才是权威。这里只留宿主没有的东西 —— 子Tasks台账。
// roster/注册数这类"编排面证据"是调试信息，收在「Chains」tab 的Diagnostics里，这里不再展示。

import { button, empty, list, section as kitSection, stat } from './kit.js'
import { agentLabel } from './labels.js'
import { STATE_LABEL, STATE_TONE, el, fmtDur } from './util.js'

const mutedText = (text) => el('div', { class: 'oc-micro oc-muted', text })

export function createLedgerTab({ host }) {
  /** 列表过滤：All / running / error。defaultAll。 */
  const state = { filter: 'all' }
  function render(section, snapshot, read) {
    section.replaceChildren()

    if (!snapshot) {
      const denied = read?.tried?.some((t) => t.code === 'NOT_GRANTED' || t.code === 'BAD_PATH')
      section.append(
        empty({
          title: 'No task data yet',
          body: denied
            ? 'Filesystem permission is not granted — approve it in Settings → Extensions, then refresh.'
            : 'The plugin writes it to options.snapshotPath (default ~/.reeve/ledger.json).',
        }),
      )
      if (!denied && read?.tried?.length) {
        section.append(mutedText(read.tried.map((t) => `${t.code} · ${t.path}`).join('；')))
      }
      return
    }

    const doc = snapshot
    const tasks = doc.tasks ?? []
    const running = tasks.filter((t) => t.state === 'running')
    const deadline = tasks.filter((t) => t.timedOut).length

    const facts = el('div', { class: 'oc-col' })
    const cells = el('div', { class: 'oc-stats' })
    cells.append(
      stat('Tasks', String(tasks.length)),
      stat('Running', String(running.length)),
      stat('Errors', String(tasks.filter((t) => t.state === 'error').length), tasks.some((t) => t.state === 'error') ? 'err' : undefined),
      stat('Timed out', String(deadline), deadline ? 'warn' : undefined),
    )
    facts.append(cells)
    section.append(facts)

    const filters = [
      { id: 'all', label: 'All', n: tasks.length },
      { id: 'running', label: 'Running', n: running.length },
      { id: 'error', label: 'Errors', n: tasks.filter((t) => t.state === 'error').length },
    ]
    const shown = state.filter === 'all' ? tasks : tasks.filter((t) => t.state === state.filter)
    const bar = el('div', { class: 'oc-row', 'data-act': 'ledger-filter' })
    for (const f of filters) {
      bar.append(
        button({
          label: `${f.label} ${f.n}`,
          variant: state.filter === f.id ? 'secondary' : 'ghost',
          size: 'sm',
          data: { 'data-act': 'filter', 'data-filter': f.id },
          onClick: () => {
            state.filter = f.id
            render(section, snapshot, read)
          },
        }).node,
      )
    }

    const items = shown.map((task) => {
      const flags = []
      if (task.timedOut) flags.push('timed out')
      if (task.statusUncertain) flags.push('uncertain')
      if (task.background) flags.push('background')
      // 子会话 ID 是实现细节，不进标题行（要查就在宿主的会话列表里
      const dur = task.endedAt ? fmtDur(task.startedAt, task.endedAt) : fmtDur(task.startedAt)
      return {
        id: task.taskID,
        title: task.description || agentLabel(task.agent) || task.taskID,
        subtitle: [agentLabel(task.agent) ?? '?', ...flags].filter(Boolean).join(' · '),
        // 有子会话的才是可打开的：给一个 › 暗示；没有的置灰（disabled，点了也不会假装能开
        meta: task.childSessionID ? `${dur} ›` : dur,
        disabled: !task.childSessionID,
        badge: { label: STATE_LABEL[task.state] ?? task.state ?? '?', tone: STATE_TONE[task.state] ?? 'neutral' },
      }
    })

    const card = el('div', { class: 'oc-col oc-ledger-list' })
    card.append(bar)
    card.append(
      list({
        items,
        onSelect: (id) => {
          const task = tasks.find((x) => x.taskID === id)
          if (task?.childSessionID) void host.openSession(task.childSessionID)
        },
        emptyText:
          tasks.length === 0
            ? 'No tasks yet — child tasks dispatched by the orchestrator will appear here.'
            : `No records in this filter (${tasks.length} total; try another filter).`,
        ariaLabel: 'REEVE tasks',
      }).node,
    )
    card.append(mutedText('Click a row with a child session to open it. Only tasks dispatched from this machine are recorded.'))
    section.append(card)
  }

  return {
    render,
    count: (snapshot) => snapshot?.tasks?.length ?? 0,
  }
}