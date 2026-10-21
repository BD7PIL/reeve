// 统计 tab：两张表 —— ① GATE 归因（哪条链、真打了谁、第几次尝试、多久）② 编排台账（谁派给了谁、跑多久）。
//
// 为什么两件事分两块：它们的**真相在不同的地方**。
//   · GATE 侧：只有代理知道真模型是谁（引擎侧永远记 `reeve/pro` 这种别名，见 PROGRESS §6.2）。
//   · 编排侧：只有本机的台账知道任务级的事（超时、对账、在飞、排队）。
// 合成一个"总分"只会让口径变糊涂，所以并排摆着，各自标清来源与窗口。
//
// 排版纪律（多模态评审改出来的）：
//   · **所有延迟条共用一个量程**，并在区块开头写明量程 —— 条长才能跨行比较（否则只是装饰）。
//   · 数字一律等宽 + 右对齐 + 固定列宽：跨行的数字落在同一列。
//   · 0 值变灰：一堆 0 不该跟 7/6/1 抢注意力。
//   · 文案先给结论、实现细节进括号：面板给人看，不给实现者看。

import { mountEmpty } from '@openchamber/sdk/ui'

import { barWidth, el, fmtAgo, fmtClock, fmtMs } from './util.js'

const num = (v) => (v == null ? '—' : String(v))

const stat = (label, value, tone) => {
  const box = el('div', { class: 'rv-stat' })
  box.append(el('div', { class: 'rv-stat-label', text: label }))
  const zero = value === '0'
  box.append(el('div', { class: 'rv-stat-value', text: value, 'data-zero': zero ? 'true' : 'false', ...(tone ? { 'data-tone': tone } : {}) }))
  return box
}

const bar = (value, max) =>
  el('div', { class: 'rv-bar' }, [el('div', { class: 'rv-bar-fill', style: `width:${barWidth(value, max)}` })])
const barText = (text) => el('span', { class: 'rv-bar-text', text })

/** 带延迟条的一行：名字 | 次数 | 条 | 数字（四列与 .rv-line 一一对应）。 */
const line = (name, count, value, max, text) =>
  el('div', { class: 'rv-line' }, [
    el('span', { class: 'rv-line-name', text: name, title: name }),
    el('span', { class: 'rv-line-count', text: count }),
    bar(value, max),
    barText(text),
  ])

export function createStatsTab() {
  function renderGate(section, snapshot) {
    const stats = snapshot?.stats ?? null
    const gate = stats?.gate ?? null
    section.append(el('div', { class: 'rv-sub', text: 'GATE 归因（代理侧：真模型 · 回退 · 延迟）' }))

    if (!gate) {
      const why = stats?.error ? `读不到 GATE 台账：${stats.error}` : '还没有统计数据（快照里 stats 为空）'
      const host = el('div')
      mountEmpty(host, {
        title: '拿不到归因数据',
        body: `${why}。原始台账是 ~/.reeve/gate.jsonl（JSONL，一行 = 一次尝试）；面板只读插件聚合好的快照。`,
      })
      section.append(host)
      return
    }

    const w = gate.window ?? {}
    const head = el('div', { class: 'rv-meta' })
    const windowText = w.relaxed
      ? `读到的台账都是旧行（都超过 ${Math.round((stats.windowMs ?? 0) / 3600000)}h 了，窗口放宽）`
      : `近 ${Math.round((w.ms ?? 0) / 3600000)} 小时 · 用到 ${gate.used}/${gate.fetched} 行`
    head.append(el('div', { text: `${windowText} · 生成于 ${fmtClock(stats.generatedAt)}（${fmtAgo(stats.generatedAt)}）` }))
    head.append(el('div', { text: '数字口径：调用（请求）· 尝试（换候选/重试都算）' }))
    if (gate.fallback?.requests > 0) {
      head.append(el('div', { text: `回退：${num(gate.fallback.requests)} 次调用换过候选（共 ${num(gate.fallback.hops)} 跳）` }))
    }
    section.append(head)

    const cards = el('div', { class: 'rv-stats' })
    cards.append(stat('调用', num(gate.requests)))
    cards.append(stat('成功', num(gate.requestsOk), 'success'))
    cards.append(stat('失败', num(gate.requestsError), gate.requestsError ? 'error' : undefined))
    cards.append(stat('尝试', num(gate.attempts)))
    cards.append(stat('回退', `${num(gate.fallback?.requests)} 次`))
    cards.append(stat('p50', fmtMs(gate.requestLatency?.p50)))
    cards.append(stat('p95', fmtMs(gate.requestLatency?.p95)))
    cards.append(stat('最慢', fmtMs(gate.requestLatency?.max)))
    section.append(cards)

    // 统一量程：所有条按同一个上限画（写在这里，条长才有意义）
    const max = Math.max(gate.requestLatency?.max ?? 0, ...(gate.byChain ?? []).map((c) => c.latency?.max ?? 0), 1)
    section.append(el('div', { class: 'rv-meta', text: `延迟条统一量程 0 → ${fmtMs(max)}（调用总耗时；单次上游往返见「按 provider」）` }))

    for (const c of gate.byChain ?? []) {
      const block = el('div', { class: 'rv-tier-block' })
      const head2 = el('div', { class: 'rv-tier-head' })
      head2.append(el('span', { class: 'rv-tier-name', text: c.chain }))
      if (c.agent) head2.append(el('span', { class: 'rv-chip', text: `agent: ${c.agent}` }))
      head2.append(el('span', { class: 'rv-grow' }))
      head2.append(
        el('span', {
          class: 'rv-tier-count',
          text: `${num(c.n)} 次尝试 · ${num(c.ok)}/${num(c.error)}${c.hops ? ` · 换了 ${c.hops} 次` : ''}`,
        }),
      )
      block.append(head2)
      block.append(
        el('div', { class: 'rv-tier-lat' }, [
          bar(c.latency?.p95, max),
          barText(`尝试 p50 ${fmtMs(c.latency?.p50)} · p95 ${fmtMs(c.latency?.p95)}`),
        ]),
      )
      if (c.providers?.length) {
        const prov = el('div', { class: 'rv-prov' })
        for (const p of c.providers) prov.append(el('span', { class: 'rv-chip', text: `${p.ref} ×${p.n}` }))
        block.append(prov)
      }
      section.append(block)
    }

    if (gate.byProvider?.length) {
      section.append(el('div', { class: 'rv-sub', text: '按 provider（单次上游往返）' }))
      const pmax = Math.max(gate.attemptLatency?.max ?? 0, 1)
      for (const p of gate.byProvider.slice(0, 8)) {
        section.append(
          line(p.provider, `${num(p.n)} 次 · ${num(p.ok)}/${num(p.error)}`, p.latency?.p95, pmax, `p50 ${fmtMs(p.latency?.p50)} · p95 ${fmtMs(p.latency?.p95)}`),
        )
      }
    }
  }

  function renderOrchestrate(section, snapshot) {
    const stats = snapshot?.stats ?? null
    const o = stats?.orchestrate ?? null
    section.append(el('div', { class: 'rv-sub', text: '编排台账（本机记账：任务级）' }))
    if (!o) {
      const host = el('div')
      mountEmpty(host, { title: '还没有台账', body: '还没有派过子任务 —— 台账为空不是错误。' })
      section.append(host)
      return
    }
    const t = o.totals ?? {}
    const cards = el('div', { class: 'rv-stats' })
    cards.append(stat('任务', num(t.n)))
    cards.append(stat('成功', num(t.ok), 'success'))
    cards.append(stat('失败', num(t.error), t.error ? 'error' : undefined))
    cards.append(stat('已停', num(t.stopped)))
    cards.append(stat('在飞', num(t.running), t.running ? 'primary' : undefined))
    cards.append(stat('排队', num(o.queue?.waiting ?? 0), (o.queue?.waiting ?? 0) > 0 ? 'warning' : undefined))
    cards.append(stat('超时', num(t.timedOut), t.timedOut ? 'warning' : undefined))
    cards.append(stat('不确定', num(t.uncertain), t.uncertain ? 'warning' : undefined))
    section.append(cards)

    if (o.byAgent?.length) {
      const max = Math.max(o.latency?.max ?? 0, ...o.byAgent.map((a) => a.latency?.max ?? 0), 1)
      section.append(el('div', { class: 'rv-meta', text: `时长条统一量程 0 → ${fmtMs(max)}` }))
      for (const a of o.byAgent) {
        section.append(
          line(
            a.agent,
            `${num(a.n)} 次 · ${num(a.ok)}/${num(a.error)}${a.stopped ? ` · 停 ${a.stopped}` : ''}${a.running ? ` · 在飞 ${a.running}` : ''}`,
            a.latency?.p95,
            max,
            `p50 ${fmtMs(a.latency?.p50)} · p95 ${fmtMs(a.latency?.p95)}`,
          ),
        )
      }
    }
    section.append(el('div', { class: 'rv-meta', text: '排队数看引擎的并发闸门；在飞 = 正在跑的子任务。台账只记本机派过的任务。' }))
  }

  function render(section, snapshot) {
    section.replaceChildren()
    renderGate(section, snapshot)
    section.append(el('div', { class: 'rv-divider' }))
    renderOrchestrate(section, snapshot)
  }

  return { render }
}