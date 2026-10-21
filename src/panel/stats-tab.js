// 统计 tab：GATE 归因（代理侧） + 编排台账（本机）。
//
// 为什么两件事分两块：它们的**真相在不同的地方**。
//   · GATE 侧：只有代理知道真模型是谁（引擎侧永远记 `reeve/pro` 这种别名，见 PROGRESS §6.2）。
//   · 编排侧：只有本机的台账知道任务级的事（超时、对账、在飞、排队）。
// 合成一个"总分"只会让口径变糊涂，所以并排摆着，各自标清来源与窗口。
//
// 排版：一张摘要卡（数字格）+ 每条链一张卡（一次尝试一行：进度条 + 供应商构成）+ 一张 provider 列表卡。
// 口径解释压成卡头的一行灰字 —— 上一版把它们摊成了三行正文，视觉上跟数据抢位置。

import { badge, empty, mutedLine, progress, stat } from './kit.js'
import { el, fmtAgo, fmtClock, fmtMs } from './util.js'

const num = (v) => (v == null ? '—' : String(v))

export function createStatsTab() {
  function renderGate(section, snapshot) {
    const stats = snapshot?.stats ?? null
    const gate = stats?.gate ?? null
    if (!gate) {
      section.append(
        empty({
          title: '还没有归因数据',
          body: stats?.error
            ? `读不到 GATE 台账：${stats.error}`
            : '台账是 ~/.reeve/gate.jsonl（JSONL，一行 = 一次尝试）；跑几次模型调用它就有了。',
        }),
      )
      return
    }

    const w = gate.window ?? {}
    const head = el('div', { class: 'oc-row oc-row-between' })
    head.append(el('strong', { text: 'GATE 归因' }))
    head.append(
      el('span', {
        class: 'oc-xs oc-off',
        text: w.relaxed
          ? `台账都是旧行（超过 ${Math.round((stats.windowMs ?? 0) / 3600000)}h），窗口已放宽`
          : `近 ${Math.round((w.ms ?? 0) / 3600000)} 小时 · ${gate.used}/${gate.fetched} 行 · ${fmtAgo(stats.generatedAt)}`,
      }),
    )
    section.append(head)

    const summary = el('div', { class: 'oc-card' })
    const cells = el('div', { class: 'oc-stats' })
    cells.append(
      stat('调用', num(gate.requests)),
      stat('成功', num(gate.requestsOk), 'ok'),
      stat('失败', num(gate.requestsError), gate.requestsError ? 'err' : undefined),
      stat('尝试', num(gate.attempts)),
      stat('回退', `${num(gate.fallback?.requests)} 次`),
      stat('p50', fmtMs(gate.requestLatency?.p50)),
      stat('p95', fmtMs(gate.requestLatency?.p95)),
      stat('最慢', fmtMs(gate.requestLatency?.max)),
    )
    summary.append(cells)
    summary.append(
      mutedLine(
        `调用 = 一次请求；尝试 = 换候选/重试各算一次；回退 ${num(gate.fallback?.hops)} 跳。` +
          '条长按统一量程（0 → 最慢的一次调用），可以跨行比。',
      ),
    )
    section.append(summary)

    const max = Math.max(gate.requestLatency?.max ?? 0, ...(gate.byChain ?? []).map((c) => c.latency?.max ?? 0), 1)
    const chainCard = el('div', { class: 'oc-card' })
    const head2 = el('div', { class: 'oc-row oc-row-between' })
    head2.append(el('strong', { text: '按链' }))
    head2.append(el('span', { class: 'oc-xs oc-off', text: `条长按统一量程 0 → ${fmtMs(max)}（一次调用的总耗时）` }))
    chainCard.append(head2)
    for (const c of gate.byChain ?? []) {
      const row = el('div', { class: 'oc-stat-row', 'data-chain': c.chain })
      const name = el('span', { class: 'oc-stat-name oc-truncate' })
      name.append(el('span', { text: c.chain }))
      if (c.agent) name.append(el('span', { class: 'oc-xs oc-off', text: ` · ${c.agent}` }))
      row.append(name)
      row.append(el('span', { class: 'oc-xs oc-off oc-num oc-nowrap', text: `${num(c.n)} 次 · ${num(c.ok)}/${num(c.error)}${c.hops ? ` · 换 ${c.hops}` : ''}` }))
      const barHost = el('span', { class: 'oc-stat-bar' })
      barHost.append(progress({ value: Math.round((Math.min(c.latency?.p95 ?? 0, max) / max) * 100), tone: c.error ? 'warning' : 'success', label: '' }).node)
      row.append(barHost)
      row.append(el('span', { class: 'oc-xs oc-off oc-num oc-nowrap oc-stat-lat', text: `p50 ${fmtMs(c.latency?.p50)} · p95 ${fmtMs(c.latency?.p95)}` }))
      chainCard.append(row)
    }
    section.append(chainCard)

    if (gate.byProvider?.length) {
      const card = el('div', { class: 'oc-card' })
      const top = el('div', { class: 'oc-row oc-row-between' })
      top.append(el('strong', { text: '按 provider' }))
      top.append(el('span', { class: 'oc-xs oc-off', text: '单次上游往返' }))
      card.append(top)
      for (const p of gate.byProvider.slice(0, 8)) {
        const row = el('div', { class: 'oc-stat-row' })
        row.append(el('span', { class: 'oc-stat-name oc-truncate', text: p.provider }))
        row.append(el('span', { class: 'oc-xs oc-off oc-num oc-nowrap', text: `${num(p.n)} 次 · ${num(p.ok)}/${num(p.error)}` }))
        row.append(el('span', { class: 'oc-stat-bar' }))
        row.append(el('span', { class: 'oc-xs oc-off oc-num oc-nowrap oc-stat-lat', text: `p50 ${fmtMs(p.latency?.p50)} · p95 ${fmtMs(p.latency?.p95)}` }))
        card.append(row)
      }
      section.append(card)
    }
  }

  function renderOrchestrate(section, snapshot) {
    const o = snapshot?.stats?.orchestrate ?? null
    const head = el('div', { class: 'oc-row oc-row-between' })
    head.append(el('strong', { text: '编排台账' }))
    head.append(el('span', { class: 'oc-xs oc-off', text: '本机记账：任务级（谁派给了谁、跑多久）' }))
    section.append(head)

    if (!o) {
      section.append(empty({ title: '还没有派过子任务', body: '台账为空不是错误 —— foreman 派活之后这里就有数了。' }))
      return
    }
    const t = o.totals ?? {}
    const card = el('div', { class: 'oc-card' })
    const cells = el('div', { class: 'oc-stats' })
    cells.append(
      stat('任务', num(t.n)),
      stat('成功', num(t.ok), 'ok'),
      stat('失败', num(t.error), t.error ? 'err' : undefined),
      stat('在飞', num(t.running)),
      stat('排队', num(o.queue?.waiting ?? 0)),
      stat('超时', num(t.timedOut), t.timedOut ? 'warn' : undefined),
    )
    card.append(cells)
    section.append(card)

    if (o.byAgent?.length) {
      const agents = el('div', { class: 'oc-card' })
      agents.append(
        list({
          ariaLabel: '按 agent',
          selectedId: null,
          items: o.byAgent.map((a) => ({
            id: a.agent,
            leading: String(a.n),
            title: a.agent,
            meta: `p50 ${fmtMs(a.latency?.p50)} · p95 ${fmtMs(a.latency?.p95)}`,
            ...(a.error ? { badge: { label: `${a.error} 失败`, tone: 'warning' } } : {}),
          })),
          onSelect: () => {},
        }).node,
      )
      agents.append(mutedLine('时长 = 终态时间 − 派发时间；在飞的只计数不算时长。'))
      section.append(agents)
    }
  }

  function render(section, snapshot) {
    section.replaceChildren()
    const col = el('div', { class: 'oc-col' })
    renderGate(col, snapshot)
    col.append(el('div', { style: 'height:4px' }))
    renderOrchestrate(col, snapshot)
    if (snapshot?.stats?.generatedAt) {
      col.append(mutedLine(`生成于 ${fmtClock(snapshot.stats.generatedAt)}（${fmtAgo(snapshot.stats.generatedAt)}）`))
    }
    section.append(col)
  }

  return { render }
}