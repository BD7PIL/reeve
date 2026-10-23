// REEVE 面板 —— 三个 tab：Chains（**唯一会写**的地方：GATE 的 fallback 配置）/ Stats / Tasks。
//
// 分工：
//   ① Chains：链的模型顺序编辑（↑↓ 排序 · switches · 增删）、档位映射、重试策略、免费车道；
//      显式「保存并应用」→ 写配置 → GATE 5 秒内热更 → 快照的 gate 段变化 = 真生效。
//   ② Stats：代理侧归因 —— 数字由**插件**聚合后写进快照，面板不自己算。
//   ③ Tasks：子任务列表（谁派的、什么状态、跑了多久）。
//
// 语言跟随宿主：`ctx.locale` → 面板词表（en / zh-CN），ID 永不翻译。
// 保存条在**页面级**（不在链 tab 里）：切到 Stats/Tasks 也不会丢掉未保存状态。
//
// 控制面不在这里 —— 派活 / 中断在模型侧（foreman）；面板既不 startSession 也不 prompt。
// 唯一能碰引擎配置的地方是插件的"端点自举"（写 providers.reeve 那两行），也不在这里。

import { connectHost } from '@openchamber/sdk'
import { applyHostReady } from '@openchamber/sdk/ui'

import { badge, button, tabs } from './kit.js'
import { getLocale, setLocale, t } from './i18n.js'
import { el, fmtAgo, fmtClock, readSnapshot } from './util.js'
import { createChainTab } from './chain-tab.js'
import { createStatsTab } from './stats-tab.js'
import { createLedgerTab } from './ledger-tab.js'

const tabDefs = () => [
  { id: 'chain', label: t('tab.chains') },
  { id: 'stats', label: t('tab.stats') },
  { id: 'ledger', label: t('tab.tasks') },
]

function main() {
  const root = document.getElementById('root')
  const host = connectHost()

  // ---- 骨架：页（头 / tab / 段落 / 保存条 / 脚）----
  const page = el('div', { class: 'oc-page' })
  const header = el('div', { class: 'oc-bar oc-bar-between' })
  const headLeft = el('div', { class: 'oc-bar' })
  const badgeKit = badge({ label: t('badge.loading'), tone: 'neutral' })
  const saveBadge = badge({ label: t('save.saved'), tone: 'neutral' })
  saveBadge.node.hidden = true
  headLeft.append(badgeKit.node, saveBadge.node)
  const refreshBtnKit = button({ label: t('action.refresh'), variant: 'ghost', size: 'sm', data: { 'data-act': 'refresh' }, onClick: () => void refresh() })
  header.append(headLeft, refreshBtnKit.node)
  const tabsHost = el('div')
  const body = el('div', { class: 'oc-col oc-grow' })
  const foot = el('div', { class: 'oc-micro oc-muted' })

  // 页面级保存条：只在 有改动 / 在飞 / 失败 时出现（切 tab 不丢）
  const savebar = el('div', { class: 'oc-savebar' })
  savebar.hidden = true
  const saveBtn = button({
    label: t('action.saveApply'),
    variant: 'default',
    size: 'sm',
    disabled: true,
    data: { 'data-act': 'save' },
    onClick: () => chainTab.requestSave(),
  })
  const discardBtn = button({
    label: t('action.discard'),
    variant: 'ghost',
    size: 'sm',
    disabled: true,
    data: { 'data-act': 'discard' },
    onClick: () => chainTab.requestDiscard(),
  })
  const saveHint = el('span', { class: 'oc-micro oc-muted oc-save-hint' })
  savebar.append(saveBtn.node, discardBtn.node, saveHint)

  page.append(header, tabsHost, body, savebar, foot)
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
  let lastSave = { dirty: false, save: { status: 'idle', at: null, error: null } }

  const chainTab = createChainTab({
    host,
    onNeedPoll: () => scheduleSettlePoll(),
    readInfo: () => read,
    onStateChange: (state) => applySaveState(state),
  })
  const statsTab = createStatsTab()
  const ledgerTab = createLedgerTab({ host })

  function tabItems() {
    return tabDefs().map((item) => ({
      ...item,
      count:
        item.id === 'chain'
          ? (snapshot?.gate?.chains?.length ?? 0) || undefined
          : item.id === 'ledger'
            ? ledgerTab.count(snapshot) || undefined
            : undefined,
    }))
  }

  const tabsKit = tabs({
    items: tabItems(),
    activeId: active,
    onChange: (id) => {
      active = id
      paint(true)
    },
  })
  tabsHost.append(tabsKit.node)

  /** 只渲染当前 tab；`force` 用于切换 tab / 语言变化（复用 DOM 时要重画一次）。 */
  function paint(force = false) {
    for (const [id, section] of Object.entries(sections)) section.hidden = id !== active
    if (active === 'chain') chainTab.render(sections.chain, snapshot)
    else if (active === 'stats') statsTab.render(sections.stats, snapshot)
    else ledgerTab.render(sections.ledger, snapshot, read)
    if (force) return
    tabsKit.handle.update({ items: tabItems(), activeId: active })
  }

  function paintBadge() {
    if (!read?.ok) {
      badgeKit.handle.update({ label: t('badge.dataNotReady'), tone: 'warning' })
      return
    }
    const counts = snapshot?.counts ?? {}
    const gate = snapshot?.gate
    const waiting = snapshot?.stats?.orchestrate?.queue?.waiting ?? 0
    // 路由引擎起不来/起一半都要吵：模型面会整层报错，而面板别处看不出来
    if (gate && (gate.error || !gate.port)) {
      badgeKit.handle.update({ label: t('badge.routerNotReady', { running: counts.running ?? 0 }), tone: 'error' })
      return
    }
    const running = counts.running ?? 0
    badgeKit.handle.update({
      label:
        running > 0 || waiting > 0
          ? waiting
            ? t('badge.runningQueued', { running, waiting })
            : t('badge.running', { running })
          : t('badge.idle', { total: counts.total ?? 0 }),
      tone: running > 0 || waiting > 0 ? 'primary' : 'neutral',
    })
  }

  function paintFoot() {
    if (!read?.ok) {
      if (!read) return
      const codes = (read.tried ?? []).map((x) => x.code)
      const hint = codes.includes('NOT_GRANTED')
        ? t('footer.hint.fs')
        : codes.length > 0 && codes.every((c) => c === 'NOT_FOUND')
          ? t('footer.hint.notFound')
          : t('footer.hint.retry')
      foot.textContent = t('footer.snapshotMissing', { hint })
      return
    }
    const gen = snapshot?.generatedAt
    foot.textContent = t('footer.updated', { time: fmtClock(gen), ago: fmtAgo(gen) })
  }

  /** 保存态 → 页头徽标 + 页面级保存条。 */
  function applySaveState(state) {
    if (!state) return
    lastSave = state
    const s = state.save ?? { status: 'idle' }
    const dirty = Boolean(state.dirty)
    const waiting = s.status === 'waiting'
    const failed = s.status === 'failed' || s.status === 'timeout'

    savebar.hidden = !(dirty || waiting || failed)
    saveBtn.handle.update({ label: t('action.saveApply'), disabled: !dirty, loading: waiting })
    discardBtn.handle.update({ label: t('action.discard'), disabled: !dirty })
    saveHint.textContent = waiting
      ? t('save.hint.waiting')
      : s.status === 'failed'
        ? t('save.hint.failed', { error: s.error })
        : s.status === 'timeout'
          ? t('save.hint.timeout')
          : t('save.hint.idle')

    // 页头保存徽标：idle 且不脏时收起（"已保存"不该常驻抢运行态的位置）
    if (failed) saveBadge.handle.update({ label: t('save.notApplied'), tone: 'error' })
    else if (waiting) saveBadge.handle.update({ label: t('save.applying'), tone: 'info' })
    else if (dirty) saveBadge.handle.update({ label: t('save.unsaved'), tone: 'warning' })
    else if (s.status === 'applied') saveBadge.handle.update({ label: t('save.appliedAt', { time: fmtClock(s.at) }), tone: 'success' })
    else saveBadge.handle.update({ label: t('save.saved'), tone: 'neutral' })
    saveBadge.node.hidden = !(failed || waiting || dirty || s.status === 'applied')
  }

  async function refresh() {
    if (busy) return
    busy = true
    refreshBtn.handle.update({ label: t('badge.loading'), loading: true })
    try {
      read = await readSnapshot(host)
      snapshot = read.ok ? read.doc : null
      // 快照更新后让链 tab 重新对账保存状态（即使当前停在 Stats/Tasks）
      chainTab.sync?.(snapshot)
      paint()
      paintBadge()
      paintFoot()
    } catch (err) {
      foot.textContent = t('refresh.error', { error: err instanceof Error ? err.message : String(err) })
    } finally {
      busy = false
      refreshBtn.handle.update({ label: t('action.refresh'), loading: false })
    }
  }

  /**
   * 保存后的收敛等待：每 2 秒看一次快照的 `appliedAt` 有没有变（变了 = 运行时真跟上了，
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

  // 语言来自宿主：onReady 可能在 refresh 之前或之后到，两条路径都要能重画
  host.onReady((ctx) => {
    applyHostReady(ctx, document.documentElement)
    setLocale(ctx.locale)
    document.documentElement.lang = getLocale()
    refreshBtn.handle.update({ label: t('action.refresh') })
    tabsKit.handle.update({ items: tabItems(), activeId: active })
    paint(true)
    paintBadge()
    paintFoot()
    applySaveState(lastSave)
  })

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
    root.replaceChildren(el('div', { class: 'oc-micro', style: 'color:var(--status-error)', text: t('panel.startFailed', { error: err instanceof Error ? err.message : String(err) }) }))
  }
}
