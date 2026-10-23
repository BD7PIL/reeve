// 统计 tab：路由引擎（代理侧）的请求归因。
//
// 为什么只有代理侧：引擎永远记 `reeve/pro` 这种别名，只有代理知道真模型是谁。
// 任务级的事（谁派给了谁、超时、对账）在「任务记录」tab，这里不重复。
//
// 排版：一张摘要卡（数字格）+ 每条链一行（进度条 + 延迟）+ 一张服务商列表。
// 口径解释不再写成一段长图例 —— 列名/列头自己会说话； Providers 行没有条形（数据是单次往返），
// 那一列不渲染，避免一个视觉空洞。

import { empty, progress, section as kitSection, stat } from './kit.js'
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
          title: '还没有请求数据',
          body: stats?.error
            ? `读不到请求台账：${stats.error}`
            : '台账在 ~/.reeve/gate.jsonl（一行 = 一次尝试）；跑几次模型调用它就有了。',
        }),
      )
      return
    }

    const w = gate.window ?? {}
    const windowHint = w.relaxed
      ? `台账都是旧行（超过 ${Math.round((stats.windowMs ?? 0) / 3600000)}h），窗口已放宽`
      : `近 ${Math.round((w.ms ?? 0) / 3600000)} 小时 · ${gate.used}/${gate.fetched} 行 · ${fmtAgo(stats.generatedAt)}`

    const summary = el('div', { class: 'oc-col' })
    const cells = el('div', { class: 'oc-stats' })
    cells.append(
      stat('请求', num(gate.requests)),
      stat('成功', num(gate.requestsOk), 'ok'),
      stat('失败', num(gate.requestsError), gate.requestsError ? 'err' : undefined),
      stat('回退', `${num(gate.fallback?.requests)} 次`),
      stat('中位延迟', fmtMs(gate.requestLatency?.p50)),
      stat('P95', fmtMs(gate.requestLatency?.p95)),
    )
    summary.append(cells)
    section.append(kitSection({ title: '请求统计', hint: windowHint, body: [summary] }))

    const max = Math.max(gate.requestLatency?.max ?? 0, ...(gate.byChain ?? []).map((c) => c.latency?.max ?? 0), 1)
    // 列头代替长图例：条长 = 该链 P95 ÷ 全局最慢
    const chainCard = el('div', { class: 'oc-col' })
    for (const c of gate.byChain ?? []) {
      const row = el('div', { class: 'oc-stat-row', 'data-chain': c.chain })
      const name = el('span', { class: 'oc-stat-name oc-truncate' })
      name.append(el('span', { text: chainLabel(c.chain) }))
      if (c.chain !== chainLabel(c.chain)) name.append(el('span', { class: 'oc-micro oc-muted oc-mono', text: ` · ${c.chain}` }))
      row.append(name)
      row.append(el('span', { class: 'oc-micro oc-muted oc-num oc-nowrap', text: `${num(c.n)} 次 · ${num(c.ok)}/${num(c.error)}${c.hops ? ` · 换 ${c.hops}` : ''}` }))
      const barHost = el('span', { class: 'oc-stat-bar' })
      barHost.append(progress({ value: Math.round((Math.min(c.latency?.p95 ?? 0, max) / max) * 100), tone: c.error ? 'warning' : 'success', label: '' }).node)
      row.append(barHost)
      row.append(el('span', { class: 'oc-micro oc-muted oc-num oc-nowrap oc-stat-lat', text: `P50 ${fmtMs(c.latency?.p50)} · P95 ${fmtMs(c.latency?.p95)}` }))
      chainCard.append(row)
    }
    section.append(kitSection({ title: '按链', hint: `一次请求的总耗时（量程 0 → ${fmtMs(max)}）`, body: [chainCard] }))

    if (gate.byProvider?.length) {
      const card = el('div', { class: 'oc-col' })
      for (const p of gate.byProvider.slice(0, 8)) {
        const row = el('div', { class: 'oc-stat-row' })
        row.append(el('span', { class: 'oc-stat-name oc-truncate', text: providerLabel(p.provider) }))
        row.append(el('span', { class: 'oc-micro oc-muted oc-num oc-nowrap', text: `${num(p.n)} 次 · ${num(p.ok)}/${num(p.error)}` }))
        // 单次上游往返没有"相对最慢"的条可比 —— 不渲染空条列，延迟直接右对齐
        row.append(el('span', { class: 'oc-micro oc-muted oc-num oc-nowrap oc-stat-lat', text: `P50 ${fmtMs(p.latency?.p50)} · P95 ${fmtMs(p.latency?.p95)}` }))
        card.append(row)
      }
      section.append(kitSection({ title: '按服务商', hint: '单次上游往返', body: [card] }))
    }
  }

  return { render }
}