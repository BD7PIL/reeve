// 台账 tab：本地记账的快照列表（谁派的、什么状态、跑了多久）+ 一行"编排面"证据。
//
// 会话树那一段**去掉了**：宿主自己就有会话列表（点日期/会话切换器），面板再抄一份只会
// 让人分不清哪个才是权威。这里只留宿主没有的东西 —— 子任务的台账。
//
// 排版：一张事实卡（数 + 编排面证据）+ 一张列表卡（每行一条子任务，点行跳子会话）。

import { button, empty, list, mutedLine, stat } from './kit.js'
import { STATE_LABEL, STATE_TONE, el, fmtClock, fmtDur } from './util.js'

export function createLedgerTab({ host }) {
  /** 列表过滤：全部 / 在飞 / 失败。默认全部。 */
  const state = { filter: 'all' }
  function render(section, snapshot, read) {
    section.replaceChildren()

    if (!snapshot) {
      const denied = read?.tried?.some((t) => t.code === 'NOT_GRANTED' || t.code === 'BAD_PATH')
      section.append(
        empty({
          title: '还没读到台账快照',
          body: denied
            ? '扩展的文件读取权限还没批准 —— 到 设置 → 扩展 批准「文件系统」后点刷新。'
            : '它由插件写在 options.snapshotPath 指向的位置（默认 ~/.reeve/ledger.json）。',
        }),
      )
      if (!denied && read?.tried?.length) {
        section.append(mutedLine(read.tried.map((t) => `${t.code} · ${t.path}`).join('；')))
      }
      return
    }

    const doc = snapshot
    const tasks = doc.tasks ?? []
    const running = tasks.filter((t) => t.state === 'running')
    const deadline = tasks.filter((t) => t.timedOut).length

    const facts = el('div', { class: 'oc-card' })
    const cells = el('div', { class: 'oc-stats' })
    cells.append(
      stat('记录', String(tasks.length)),
      stat('在飞', String(running.length)),
      stat('超时', String(deadline), deadline ? 'warn' : undefined),
      stat('快照', fmtClock(doc.generatedAt)),
    )
    facts.append(cells)

    // 编排面证据：由插件从**引擎进程内部**读出来（`opencode debug agents` 连的未必是这个引擎）
    const t = doc.agentTable
    if (t) {
      const vis = (t.visible ?? []).map((a) => a.id).join('、') || '（无）'
      const roster = doc.roster ? `名册 ${doc.roster.count} 个` : '名册未注入'
      facts.append(mutedLine(`前台可见 agent：${vis} · 隐藏 ${(t.hidden ?? []).length} 个 · ${roster}`))
    }
    if (doc.registered) {
      facts.append(mutedLine(`插件包内注册：agent ${doc.registered.agents?.length ?? 0} 个 · skill ${doc.registered.skills?.length ?? 0} 个`))
    }
    section.append(facts)

    const filters = [
      { id: 'all', label: '全部', n: tasks.length },
      { id: 'running', label: '在飞', n: running.length },
      { id: 'error', label: '失败', n: tasks.filter((t) => t.state === 'error').length },
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
      if (task.timedOut) flags.push('超时')
      if (task.statusUncertain) flags.push('状态不确定')
      if (task.background) flags.push('后台')
      // 状态只在彩色胶囊里说一次 —— 左侧再写一遍灰字等于每行读两遍同一个词
      const sid = task.childSessionID ? `ses_…${String(task.childSessionID).slice(-6)}` : '无子会话'
      return {
        id: task.taskID,
        title: task.description || task.agent || task.taskID,
        subtitle: [task.agent ?? '?', flags.join('/'), sid].filter(Boolean).join(' · '),
        meta: task.endedAt ? fmtDur(task.startedAt, task.endedAt) : fmtDur(task.startedAt),
        badge: { label: STATE_LABEL[task.state] ?? task.state ?? '?', tone: STATE_TONE[task.state] ?? 'neutral' },
      }
    })

    const card = el('div', { class: 'oc-card' })
    card.append(bar)
    card.append(
      list({
        items,
        onSelect: (id) => {
          const task = tasks.find((x) => x.taskID === id)
          if (task?.childSessionID) void host.openSession(task.childSessionID)
        },
        emptyText: '台账是空的 —— 还没有派过子任务。',
        ariaLabel: 'REEVE 台账',
      }).node,
    )
    card.append(mutedLine('点一行打开子会话（宿主自己的会话视图）。台账只记本机派过的任务。'))
    section.append(card)
  }

  return {
    render,
    count: (snapshot) => snapshot?.tasks?.length ?? 0,
  }
}