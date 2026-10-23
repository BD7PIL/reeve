// 统计 tab：路由引擎（代理侧）的请求归因。
//
// 为什么只有代理侧：引擎永远记 `reeve/pro` 这种别名，只有代理知道真模型是谁。
// Tasks 级的事（谁派给了谁、超时、对账）在「Tasks」tab，这里不重复。
//
// 排版：摘要数字 + 每条链一行（名称 / 次数 / 条 / 延迟）。列头/标签自己会说话，
// 不写长图例；窄栏（≤520）隐藏条形，把次数与延迟拆成两行。

import { empty, progress, section as kitSection, stat } from './kit.js'
import { t, tn } from './i18n.js'
import { chainLabel, providerLabel } from './labels.js'
import { el, fmtAgo, fmtMs } from './util.js'

const num = (v) => (v == null ? '—' : String(v))

export function createStatsTab() {
  function render(section, snapshot) {
    section.replaceChildren()
    const stats = snapshot?.stats ?? null
    const gate = stats?.gate ?? null
    if (!gate) {
      section.append(
        empty({
          title: t('stats.emptyTitle'),
          body: stats?.error ? t('stats.ledgerError', { error: stats.error }) : t('stats.ledgerHint'),
        }),
      )
      return
    }

    const w = gate.window ?? {}
    const windowHint = w.relaxed
      ? t('stats.windowRelaxed', { hours: Math.round((stats.windowMs ?? 0) / 3600000) })
      : t('stats.window', {
          hours: Math.round((w.ms ?? 0) / 3600000),
          used: gate.used,
          fetched: gate.fetched,
          ago: fmtAgo(stats.generatedAt),
        })

    const summary = el('div', { class: 'oc-col' })
    const cells = el('div', { class: 'oc-stats' })
    cells.append(
      stat(t('stats.requests'), num(gate.requests)),
      stat(t('stats.success'), num(gate.requestsOk), 'ok'),
      stat(t('stats.errors'), num(gate.requestsError), gate.requestsError ? 'err' : undefined),
      stat(t('stats.fallbacks'), num(gate.fallback?.requests)),
      stat(t('stats.p50'), fmtMs(gate.requestLatency?.p50)),
      stat(t('stats.p95'), fmtMs(gate.requestLatency?.p95)),
    )
    summary.append(cells)
    section.append(kitSection({ title: t('stats.requestsTitle'), hint: windowHint, body: [summary] }))

    const max = Math.max(gate.requestLatency?.max ?? 0, ...(gate.byChain ?? []).map((c) => c.latency?.max ?? 0), 1)
    // 条长 = 该链 P95 ÷ 全局最慢
    const chainCard = el('div', { class: 'oc-col' })
    for (const c of gate.byChain ?? []) {
      const row = el('div', { class: 'oc-stat-row', 'data-chain': c.chain })
      const name = el('span', { class: 'oc-stat-name oc-truncate', text: chainLabel(c.chain) })
      row.append(name)
      const calls = t('stats.calls', { n: num(c.n), ok: num(c.ok), error: num(c.error) }) + (c.hops ? ` · ${tn('stats.switches', c.hops)}` : '')
      row.append(el('span', { class: 'oc-micro oc-muted oc-num oc-nowrap oc-stat-calls', text: calls }))
      const barHost = el('span', { class: 'oc-stat-bar' })
      barHost.append(progress({ value: Math.round((Math.min(c.latency?.p95 ?? 0, max) / max) * 100), tone: c.error ? 'warning' : 'success', label: '' }).node)
      row.append(barHost)
      row.append(el('span', { class: 'oc-micro oc-muted oc-num oc-nowrap oc-stat-lat', text: t('stats.latency', { p50: fmtMs(c.latency?.p50), p95: fmtMs(c.latency?.p95) }) }))
      chainCard.append(row)
    }
    section.append(kitSection({ title: t('stats.byChainTitle'), hint: t('stats.byChainHint', { max: fmtMs(max) }), body: [chainCard] }))

    if (gate.byProvider?.length) {
      const card = el('div', { class: 'oc-col' })
      for (const p of gate.byProvider.slice(0, 8)) {
        const row = el('div', { class: 'oc-stat-row oc-stat-row-plain' })
        row.append(el('span', { class: 'oc-stat-name oc-truncate', text: providerLabel(p.provider) }))
        row.append(el('span', { class: 'oc-micro oc-muted oc-num oc-nowrap oc-stat-calls', text: t('stats.calls', { n: num(p.n), ok: num(p.ok), error: num(p.error) }) }))
        // 单次上游往返没有「相对最慢」的条可比 —— 不渲染空条列，延迟直接右对齐
        row.append(el('span', { class: 'oc-micro oc-muted oc-num oc-nowrap oc-stat-lat', text: t('stats.latency', { p50: fmtMs(p.latency?.p50), p95: fmtMs(p.latency?.p95) }) }))
        card.append(row)
      }
      section.append(kitSection({ title: t('stats.byProviderTitle'), hint: t('stats.byProviderHint'), body: [card] }))
    }
  }

  return { render }
}
