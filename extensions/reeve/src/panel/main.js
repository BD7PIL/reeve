// REEVE 面板 —— 三个 tab：链（**唯一会写**的地方：GATE 的 fallback 配置）/ 统计 / 台账。
//
// 分工：
//   ① 链：每条链的候选顺序编辑（↑↓ 排序 · 换 · 增删），显式「保存并生效」→ 写配置 →
//      GATE 5 秒内热更 → 快照的 gate 段变化 = 真生效。
//   ② 统计：GATE 归因（代理侧） + 编排台账（本机）—— 数字由**插件**聚合后写进快照，
//      面板不自己算（面板在 iframe 里，没有网络/文件能力，够不着台账原文）。
//   ③ 台账：子任务列表 + "前台只出现编排者"的落盘证据。
//
// 控制面不在这里 —— 派活 / 中断在模型侧（foreman）；面板既不 startSession 也不 prompt。
// 唯一能碰引擎配置的地方是插件的"端点自举"（写 providers.reeve 那两行），也不在这里。

import { connectHost } from '@openchamber/sdk'
import { applyHostReady } from '@openchamber/sdk/ui'

import { badge, button, tabs } from './kit.js'
import { el, fmtAgo, fmtClock, readSnapshot, shortPath } from './util.js'
import { createChainTab } from './chain-tab.js'
import { createStatsTab } from './stats-tab.js'
import { createLedgerTab } from './ledger-tab.js'

const TABS = [
  { id: 'chain', label: '链' },
  { id: 'stats', label: '统计' },
  { id: 'ledger', label: '台账' },
]

function main() {
  const root = document.getElementById('root')
  const host = connectHost()
  host.onReady((ctx) => applyHostReady(ctx, document.documentElement))

  // ---- 骨架：页（头 / tab / 段落 / 脚）----
  const page = el('div', { class: 'oc-page' })
  const header = el('div', { class: 'oc-bar oc-bar-between' })
  const headLeft = el('div', { class: 'oc-bar' })
  const badgeKit = badge({ label: '读取中…', tone: 'neutral' })
  headLeft.append(el('span', { class: 'oc-micro oc-muted', text: '编排与代理层' }), badgeKit.node)
  const refreshBtnKit = button({ label: '刷新', variant: 'ghost', size: 'sm', data: { 'data-act': 'refresh' }, onClick: () => void refresh() })
  header.append(headLeft, refreshBtnKit.node)
  const tabsHost = el('div')
  const body = el('div', { class: 'oc-col oc-grow' })
  const foot = el('div', { class: 'oc-micro oc-muted' })
  page.append(header, tabsHost, body, foot)
  root.append(page)

  const refreshBtn = refreshBtnKit

  // 三个 tab 各有自己的 section（切换只切显隐，不重建 DOM —— 免得每次切回来都掉滚动位置）
  const sections = {
    chain: el('div', { class: 'oc-col' }),
    stats: el('div', { class: 'oc-col' }),
    ledger: el('div', { class: 'oc-col' }),
  }
  for (const s of Object.values(sections)) body.append(s)

  let active = 'chain'
  let snapshot = null
  let read = null
  let busy = false
  let settleTimer = null

  const chainTab = createChainTab({ host, onNeedPoll: () => scheduleSettlePoll(), readInfo: () => read })
  const statsTab = createStatsTab()
  const ledgerTab = createLedgerTab({ host })

  const tabsKit = tabs({
    items: TABS,
    activeId: active,
    onChange: (id) => {
      active = id
      paint(true)
    },
  })
  tabsHost.append(tabsKit.node)

  /** 只渲染当前 tab；`force` 用于切换 tab（复用 DOM 时要重画一次）。 */
  function paint(force = false) {
    for (const [id, section] of Object.entries(sections)) section.hidden = id !== active
    if (active === 'chain') chainTab.render(sections.chain, snapshot)
    else if (active === 'stats') statsTab.render(sections.stats, snapshot)
    else ledgerTab.render(sections.ledger, snapshot, read)
    if (force) return
    tabsKit.handle.update({
      items: [
        { id: 'chain', label: '链', count: (snapshot?.gate?.chains?.length ?? 0) || undefined },
        { id: 'stats', label: '统计', count: snapshot?.stats?.gate?.requests ?? undefined },
        { id: 'ledger', label: '台账', count: ledgerTab.count(snapshot) || undefined },
      ],
      activeId: active,
    })
  }

  function paintBadge() {
    if (!read?.ok) {
      badgeKit.handle.update({ label: '台账未就绪', tone: 'warning' })
      return
    }
    const counts = snapshot?.counts ?? {}
    const gate = snapshot?.gate
    const waiting = snapshot?.stats?.orchestrate?.queue?.waiting ?? 0
    // GATE 起不来/起一半都要吵：模型面会整层失败，而面板别处看不出来
    if (gate && (gate.error || !gate.port)) {
      badgeKit.handle.update({ label: `GATE 未就绪 · ${counts.running ?? 0} 在飞`, tone: 'error' })
      return
    }
    badgeKit.handle.update({
      label: `${counts.running ?? 0} 在飞${waiting ? ` / ${waiting} 排队` : ''} / ${counts.total ?? 0} 总`,
      tone: (counts.running ?? 0) > 0 || waiting > 0 ? 'primary' : 'neutral',
    })
  }

  async function refresh() {
    if (busy) return
    busy = true
    refreshBtn.handle.update({ label: '读取中…', loading: true })
    try {
      read = await readSnapshot(host)
      snapshot = read.ok ? read.doc : null
      paint()
      paintBadge()
      const gen = snapshot?.generatedAt
      if (snapshot) {
        foot.textContent = `快照 ${fmtClock(gen)}（${fmtAgo(gen)}） · ${shortPath(read.path)}`
      } else {
        // 读不到快照时给出**原因对应的下一步**，别只报"试过 N 个路径"
        const codes = (read?.tried ?? []).map((t) => t.code)
        const hint = codes.includes('NOT_GRANTED')
          ? '去 设置 → 扩展 批准「文件系统」后点刷新'
          : codes.length > 0 && codes.every((c) => c === 'NOT_FOUND')
            ? '跑一次模型调用，插件会写快照'
            : '点刷新重试'
        foot.textContent = `读不到快照（试过 ${read?.tried?.length ?? 0} 个路径）· ${hint}`
      }
    } catch (err) {
      foot.textContent = `刷新失败：${err instanceof Error ? err.message : String(err)}`
    } finally {
      busy = false
      refreshBtn.handle.update({ label: '刷新', loading: false })
    }
  }

  /**
   * 保存后的收敛等待：每 2 秒看一次快照的 `appliedAt` 有没有变（变了 = 运行时真跟上了），
   * 或者草稿还是脏的（用户还在改）。最多等 30 秒（状态机在链 tab 里）。
   */
  function scheduleSettlePoll() {
    if (settleTimer) return
    settleTimer = setInterval(() => {
      void refresh()
      if (!chainTab.needsPoll()) {
        clearInterval(settleTimer)
        settleTimer = null
      }
    }, 2000)
  }

  host.onDirectory(() => void refresh())
  host.onSession(() => void refresh())

  // 快照由插件按自己的节奏写（统计默认 60 秒一轮）—— 面板开着时低频跟一下就够了。
  const idle = setInterval(() => {
    if (!settleTimer) void refresh()
  }, 15_000)
  window.addEventListener('unload', () => clearInterval(idle))

  void refresh()
}

try {
  main()
} catch (err) {
  const root = document.getElementById('root')
  if (root) {
    root.replaceChildren(el('div', { class: 'oc-micro', style: 'color:var(--status-error)', text: `面板未能启动：${err instanceof Error ? err.message : String(err)}` }))
  }
}