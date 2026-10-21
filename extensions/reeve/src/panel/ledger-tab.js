// 台账 tab：本地记账的快照列表（谁派的、什么状态、跑了多久）+ 一行"编排面"证据。
//
// 会话树那一段**去掉了**：宿主自己就有会话列表（点日期/会话切换器），面板再抄一份只会
// 让人分不清哪个才是权威。这里只留宿主没有的东西 —— 子任务的台账。

import { mountEmpty, mountList } from '@openchamber/sdk/ui'

import { STATE_LABEL, STATE_TONE, el, fmtClock, fmtDur, shortPath } from './util.js'

export function createLedgerTab({ host }) {
  function render(section, snapshot, read) {
    section.replaceChildren()
    section.append(el('div', { class: 'rv-sub', text: '台账（记账插件导出的快照，只读）' }))

    if (!snapshot) {
      const denied = read?.tried?.some((t) => t.code === 'NOT_GRANTED' || t.code === 'BAD_PATH')
      const host2 = el('div')
      mountEmpty(host2, {
        title: '还没读到台账快照',
        body: denied
          ? '扩展的文件读取权限还没批准 —— 去 设置 → 扩展 批准「文件系统」后点刷新。'
          : '它由记账插件写在 options.snapshotPath 指向的位置（默认 ~/.reeve/ledger.json）。下面每条是试过的路径与失败原因。',
      })
      section.append(host2)
      const list = el('div', { class: 'rv-meta' })
      for (const t of read?.tried ?? []) list.append(el('div', { text: `${t.code} · ${t.path}` }))
      section.append(list)
      return
    }

    const doc = snapshot
    const counts = doc.counts ?? {}
    const running = (doc.tasks ?? []).filter((t) => t.state === 'running')
    section.append(
      el('div', {
        class: 'rv-meta',
        text: `${doc.tasks?.length ?? 0} 条记录 · ${running.length} 在飞 · 生成于 ${fmtClock(doc.generatedAt)}（${shortPath(read?.path ?? '')}）`,
      }),
    )

    // 编排面：由记账插件从**引擎进程内部**读出来的一行（"前台只出现编排者"这条设计的落盘证据）。
    // `opencode debug agents` 会连到 CLI 自己那个服务、未必是你以为的引擎 —— 这一行不会。
    const t = doc.agentTable
    if (t) {
      const vis = (t.visible ?? []).map((a) => a.id).join('、') || '（无）'
      const roster = doc.roster ? `名册 ${doc.roster.count} 个` : '名册未注入'
      section.append(el('div', { class: 'rv-meta', text: `前台可见 agent：${vis} · 隐藏 ${(t.hidden ?? []).length} 个 · ${roster}` }))
    }
    if (doc.registered) {
      section.append(
        el('div', { class: 'rv-meta', text: `插件包内注册：agent ${doc.registered.agents?.length ?? 0} 个 · skill ${doc.registered.skills?.length ?? 0} 个` }),
      )
    }

    const items = (doc.tasks ?? []).map((task) => {
      const flags = []
      if (task.timedOut) flags.push('超时')
      if (task.statusUncertain) flags.push('状态不确定')
      if (task.background) flags.push('后台')
      // 状态只在彩色胶囊里说一次 —— 之前左侧再写一遍灰字，等于每行读两遍同一个词
      const sid = task.childSessionID ? `ses_…${String(task.childSessionID).slice(-6)}` : '无子会话'
      return {
        id: task.taskID,
        title: task.description || task.agent || task.taskID,
        subtitle: [task.agent ?? '?', flags.join('/'), sid].filter(Boolean).join(' · '),
        meta: task.endedAt ? fmtDur(task.startedAt, task.endedAt) : fmtDur(task.startedAt),
        badge: { label: STATE_LABEL[task.state] ?? task.state ?? '?', tone: STATE_TONE[task.state] ?? 'neutral' },
      }
    })

    const listHost = el('div')
    mountList(listHost, {
      items,
      onSelect: (id) => {
        const task = (doc.tasks ?? []).find((x) => x.taskID === id)
        if (task?.childSessionID) void host.openSession(task.childSessionID)
      },
      emptyText: '台账是空的 —— 还没有派过子任务。',
      ariaLabel: 'REEVE 台账',
    })
    section.append(listHost)
  }

  return { render, count: (snapshot) => snapshot?.tasks?.length ?? 0 }
}