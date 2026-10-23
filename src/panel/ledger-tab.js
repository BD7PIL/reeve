// Tasks tab：本地记账的子任务列表（谁派的、什么状态、跑了多久）。
//
// 会话树那一段**去掉了**：宿主自己就有会话列表，面板再抄一份只会让人分不清
// 哪个才是权威。这里只留宿主没有的东西 —— 子任务台账。
// roster/注册数这类编排面证据是调试信息，收在「Chains」tab 的 Diagnostics 里。

import { button, empty, list, stat } from './kit.js'
import { t } from './i18n.js'
import { agentLabel } from './labels.js'
import { STATE_TONE, el, fmtDur, stateLabel } from './util.js'

const mutedText = (text) => el('div', { class: 'oc-micro oc-muted', text })

export function createLedgerTab({ host }) {
  /** 列表过滤：All / running / error。默认 All。 */
  const state = { filter: 'all' }
  function render(section, snapshot, read) {
    section.replaceChildren()

    if (!snapshot) {
      const denied = read?.tried?.some((x) => x.code === 'NOT_GRANTED' || x.code === 'BAD_PATH')
      section.append(
        empty({
          title: t('tasks.emptyTitle'),
          body: denied ? t('tasks.emptyBodyDenied') : t('tasks.emptyBodyDefault'),
        }),
      )
      if (!denied && read?.tried?.length) {
        section.append(mutedText(t('tasks.readFailed', { list: read.tried.map((x) => `${x.code} · ${x.path}`).join('; ') })))
      }
      return
    }

    const doc = snapshot
    const tasks = doc.tasks ?? []
    const running = tasks.filter((x) => x.state === 'running')
    const deadline = tasks.filter((x) => x.timedOut).length
    const errored = tasks.filter((x) => x.state === 'error')

    const facts = el('div', { class: 'oc-col' })
    const cells = el('div', { class: 'oc-stats' })
    cells.append(
      stat(t('tasks.tasks'), String(tasks.length)),
      stat(t('tasks.running'), String(running.length)),
      stat(t('tasks.errors'), String(errored.length), errored.length ? 'err' : undefined),
      stat(t('tasks.timedOut'), String(deadline), deadline ? 'warn' : undefined),
    )
    facts.append(cells)
    section.append(facts)

    const filters = [
      { id: 'all', label: t('tasks.all'), n: tasks.length },
      { id: 'running', label: t('tasks.filterRunning'), n: running.length },
      { id: 'error', label: t('tasks.filterErrors'), n: errored.length },
    ]
    const shown = state.filter === 'all' ? tasks : tasks.filter((x) => x.state === state.filter)
    const bar = el('div', { class: 'oc-filter-bar', 'data-act': 'ledger-filter' })
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
      if (task.timedOut) flags.push(t('tasks.flagTimedOut'))
      if (task.statusUncertain) flags.push(t('tasks.flagUncertain'))
      if (task.background) flags.push(t('tasks.flagBackground'))
      // 子会话 ID 是实现细节，不进标题行（要查就在宿主的会话列表里）
      const dur = task.endedAt ? fmtDur(task.startedAt, task.endedAt) : fmtDur(task.startedAt)
      return {
        id: task.taskID,
        title: task.description || agentLabel(task.agent) || task.taskID,
        subtitle: [agentLabel(task.agent) ?? '?', ...flags].filter(Boolean).join(' · '),
        // 有子会话的才是可打开的：给一个 › 暗示；没有的置灰（点了也不会假装能开）
        meta: task.childSessionID ? `${dur} ›` : dur,
        disabled: !task.childSessionID,
        badge: { label: stateLabel(task.state) ?? '?', tone: STATE_TONE[task.state] ?? 'neutral' },
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
            ? t('tasks.emptyAll')
            : t('tasks.emptyFilter', { total: tasks.length }),
        ariaLabel: t('tasks.ariaLabel'),
      }).node,
    )
    card.append(mutedText(t('tasks.clickHint')))
    section.append(card)
  }

  return {
    render,
    count: (snapshot) => snapshot?.tasks?.length ?? 0,
  }
}
