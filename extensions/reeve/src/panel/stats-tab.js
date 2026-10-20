// 统计 tab：两张表 —— ① Bifrost 归因（哪一档、真打了谁、第几跳回退、多久）② 编排台账（谁派给了谁、跑多久）。
//
// 为什么两件事分两块：它们的**真相在不同的地方**。
//   · Bifrost 侧：只有代理知道真模型是谁（引擎侧永远记 `reeve/pro` 这种别名，见 PROGRESS §6.2）。
//   · 编排侧：只有本机的台账知道任务级的事（超时、对账、在飞、排队）。
// 合成一个"总分"只会让口径变糊涂，所以并排摆着，各自标清来源与窗口。
//
// 排版纪律（多模态评审改出来的）：
//   · **所有延迟条共用一个量程**，并在区块开头写明量程 —— 条长才能跨行比较（否则只是装饰）。
//   · 数字一律等宽 + 右对齐 + 固定列宽：跨行的数字落在同一列。
//   · 0 值变灰：一堆 0 不该跟 7/6/1 抢注意力。
//   · 文案先给结论、实现细节进括号：面板给人看，不给实现者看。

import { mountBadge, mountEmpty } from '@openchamber/sdk/ui'

import { TIER_LABEL, TIER_ORDER, TIER_TONE, barWidth, el, fmtAgo, fmtClock, fmtMs } from './util.js'

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
  function renderBifrost(section, snapshot) {
    const stats = snapshot?.stats ?? null
    const bifrost = stats?.bifrost ?? null
    section.append(el('div', { class: 'rv-sub', text: 'Bifrost 归因（代理侧：真模型 · 回退 · 延迟）' }))

    if (!bifrost) {
      const why = stats?.error ? `读不到代理的调用日志：${stats.error}` : '还没有统计数据（快照里 stats 为空）'
      const host = el('div')
      mountEmpty(host, {
        title: '拿不到归因数据',
        body: `${why}。原始日志可以直接看 scripts/served-model.sh --days 1；面板只读插件聚合好的快照。`,
      })
      section.append(host)
      return
    }

    const w = bifrost.window ?? {}
    const head = el('div', { class: 'rv-meta' })
    const windowText = w.relaxed
      ? `抓到的最近 ${bifrost.used} 行（都超过 ${Math.round((stats.windowMs ?? 0) / 3600000)}h 了，窗口放宽）`
      : `近 ${Math.round((w.ms ?? 0) / 3600000)} 小时 · 用到 ${bifrost.used}/${bifrost.fetched} 行`
    head.append(el('div', { text: `${windowText} · 生成于 ${fmtClock(stats.generatedAt)}（${fmtAgo(stats.generatedAt)}）` }))
    head.append(el('div', { text: '数字口径：次数 · 成功/失败' }))
    if (bifrost.probes > 0) head.append(el('div', { text: `已排除 ${bifrost.probes} 行探测（代理去探模型目录，不是调用）` }))
    section.append(head)

    const cards = el('div', { class: 'rv-stats' })
    cards.append(stat('调用', num(bifrost.total)))
    cards.append(stat('成功', num(bifrost.ok), 'success'))
    cards.append(stat('失败', num(bifrost.error), bifrost.error ? 'error' : undefined))
    cards.append(stat('已取消', num(bifrost.cancelled)))
    cards.append(stat('p50', fmtMs(bifrost.latency?.p50)))
    cards.append(stat('p95', fmtMs(bifrost.latency?.p95)))
    cards.append(stat('回退', `${num(bifrost.fallback?.requests)} 次`))
    cards.append(stat('最慢', fmtMs(bifrost.latency?.max)))
    section.append(cards)

    // 统一量程：所有条按同一个上限画（写在这里，条长才有意义）
    const max = Math.max(bifrost.latency?.max ?? 0, 1)
    section.append(el('div', { class: 'rv-meta', text: `延迟条统一量程 0 → ${fmtMs(max)}` }))

    for (const t of bifrost.byTier ?? []) {
      const block = el('div', { class: 'rv-tier-block' })
      const head2 = el('div', { class: 'rv-tier-head' })
      head2.append(el('span', { class: 'rv-tier-name', text: t.rule ?? '（非 REEVE 档位）' }))
      if (t.tier) {
        const bHost = el('span')
        mountBadge(bHost, { label: TIER_LABEL[t.tier] ?? t.tier, tone: TIER_TONE[t.tier] })
        head2.append(bHost)
      }
      head2.append(el('span', { class: 'rv-grow' }))
      head2.append(
        el('span', {
          class: 'rv-tier-count',
          text: `${num(t.n)} 次 · ${num(t.ok)}/${num(t.error)}${t.cancelled ? `/${t.cancelled} 取消` : ''}${t.fallbackRequests ? ` · 回退 ${t.fallbackRequests}` : ''}`,
        }),
      )
      block.append(head2)
      block.append(
        el('div', { class: 'rv-tier-lat' }, [
          bar(t.latency?.p95, max),
          barText(`p50 ${fmtMs(t.latency?.p50)} · p95 ${fmtMs(t.latency?.p95)}`),
        ]),
      )
      if (t.providers?.length) {
        const prov = el('div', { class: 'rv-prov' })
        for (const p of t.providers) prov.append(el('span', { class: 'rv-chip', text: `${p.ref} ×${p.n}` }))
        block.append(prov)
      }
      section.append(block)
    }

    if (bifrost.byProvider?.length) {
      section.append(el('div', { class: 'rv-sub', text: '按 provider' }))
      for (const p of bifrost.byProvider.slice(0, 8)) {
        section.append(
          line(p.provider, `${num(p.n)} 次 · ${num(p.ok)}/${num(p.error)}`, p.latency?.p95, max, `p50 ${fmtMs(p.latency?.p50)} · p95 ${fmtMs(p.latency?.p95)}`),
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
    renderBifrost(section, snapshot)
    section.append(el('div', { class: 'rv-divider' }))
    renderOrchestrate(section, snapshot)
  }

  return { render }
}