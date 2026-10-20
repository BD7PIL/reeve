// 链 tab：三个档位的回退链可视化编辑（↑↓ 排序 · 换模型 · 增删回退），显式「保存并生效」。
//
// 它写什么：**只写 `~/.reeve/chain.json`**（REEVE 自己的配置）。写的是宿主给的原子写
// （temp + rename），所以插件那边永远看不到半截 JSON —— 插件还专门把"读不动的链文件"
// 当作"未变更"（保留上一份好的），两道保险。
//
// 为什么路径取自快照：路径的真相在插件那边（它可以被 options.chainFilePath 改）。
// 快照的 `chain.tiersPath` 就是它正在读的那份；取不到才退回 `~/.reeve/chain.json`。
//
// 生效链路：保存 → 插件每 5 秒 stat 一次链文件 → 变了就重新派生 + 用
// `/api/routing/rules` 热更 + 复核 → 把 `appliedAt` 写进快照 → 本面板轮询快照看到它变。
// 界面上那句"已写入，等待收敛"就是这么等的（实测 EL7 上 ≤4 秒）。

import { mountButton, mountSelect, mountTextField } from '@openchamber/sdk/ui'

import { TIER_HINT, TIER_LABEL, TIER_ORDER, chainPathFor, el, fmtAgo, fmtClock, shortPath } from './util.js'

/** 解析 `provider/model`（也认 `provider/` = 同模型换 provider）。 */
function parseRef(ref) {
  const s = String(ref ?? '')
  const i = s.indexOf('/')
  if (i <= 0) return null
  const model = s.slice(i + 1)
  return { provider: s.slice(0, i), model: model || null }
}

/** 档位 → 行列表：先 targets（保持原顺序），再 fallbacks。**种类不混**（多 target 的权重语义不该被面板悄悄改掉）。 */
function rowsOf(tier, spec) {
  const rows = []
  for (const t of spec?.targets ?? []) if (t?.provider && t?.model) rows.push({ kind: 'target', provider: t.provider, model: t.model })
  for (const f of spec?.fallbacks ?? []) {
    const p = parseRef(f)
    if (p) rows.push({ kind: 'fallback', provider: p.provider, model: p.model })
  }
  return rows
}

/** 行列表 → 档位的规范形（面板保存时写回 chain.json 的就是它）。 */
function specOf(rows, prev) {
  const targets = rows.filter((r) => r.kind === 'target').map((r) => ({ provider: r.provider, model: r.model }))
  const fallbacks = rows.filter((r) => r.kind === 'fallback').map((r) => (r.model ? `${r.provider}/${r.model}` : `${r.provider}/`))
  return {
    targets,
    fallbacks,
    ...(prev?.description ? { description: prev.description } : {}),
    ...(Number.isFinite(prev?.ttftMs) ? { ttftMs: Number(prev.ttftMs) } : {}),
  }
}

const clone = (v) => JSON.parse(JSON.stringify(v ?? {}))

export function createChainTab({ host, onNeedPoll }) {
  const state = {
    draft: null,
    dirty: false,
    addingTier: null,
    replaceAt: null,
    manual: '',
    pick: null,
    sourceSig: null,
    save: { status: 'idle', at: null, prevAppliedAt: null, appliedAt: null, error: null },
    notice: null,
  }

  const rowsFor = (tier) => rowsOf(tier, state.draft?.[tier])

  /** 从快照初始化草稿：**有未保存改动时绝不覆盖**（用户的编辑优先）。 */
  function syncFrom(snapshot) {
    const tiers = snapshot?.chain?.tiers ?? null
    const sig = tiers ? JSON.stringify(tiers) : null
    if (state.dirty) {
      if (sig && sig !== state.sourceSig) state.notice = '插件那边的链变了（你这里有未保存的改动，以你的为准）'
      state.sourceSig = sig
      return
    }
    if (sig && sig !== state.sourceSig) {
      state.draft = clone(tiers)
      state.sourceSig = sig
      state.notice = null
    }
    if (!state.draft) state.draft = clone(tiers ?? {})
  }

  /** 保存状态机：等 `appliedAt` 变化 = 运行时真跟上了（不是"我们发过请求了"）。 */
  function syncSave(snapshot) {
    const s = state.save
    if (s.status !== 'waiting') return
    const applied = snapshot?.chain?.appliedAt ?? null
    if (applied && applied !== s.prevAppliedAt) {
      s.status = 'applied'
      s.appliedAt = applied
      s.error = snapshot?.chain?.lastError ?? null
      return
    }
    if (Date.now() - (s.at ?? 0) > 30_000) s.status = 'timeout'
  }

  /** 改草稿：立刻重画（别等轮询 —— 点完 ↑ 要马上看到顺序变了），并让外层知道该盯着收敛。 */
  function mutate(fn, section, snapshot) {
    fn()
    state.dirty = true
    if (section) render(section, snapshot)
    onNeedPoll?.()
  }

  function move(tier, index, delta, section, snapshot) {
    const rows = rowsFor(tier)
    const row = rows[index]
    // 只在**同种类**里移动：target 与 fallback 的语义不同（一个是首选、一个只在失败后试）
    const sameKind = rows.map((r, i) => (r.kind === row.kind ? i : -1)).filter((i) => i >= 0)
    const at = sameKind.indexOf(index)
    const to = sameKind[at + delta]
    if (to == null) return
    const next = [...rows]
    ;[next[index], next[to]] = [next[to], next[index]]
    mutate(() => {
      state.draft[tier] = specOf(next, state.draft[tier])
    }, section, snapshot)
  }

  function removeRow(tier, index, section, snapshot) {
    const next = [...rowsFor(tier)]
    next.splice(index, 1)
    mutate(() => {
      state.draft[tier] = specOf(next, state.draft[tier])
    }, section, snapshot)
  }

  /** 加行 / 换行（`replaceIndex != null` 就是换）。换行保持原来的种类。 */
  function place(tier, ref, replaceIndex, section, snapshot) {
    const parsed = parseRef(ref)
    if (!parsed?.model) {
      state.notice = `认不出的模型引用：${ref}（要写成 provider/model）`
      if (section) render(section, snapshot)
      return
    }
    const rows = [...rowsFor(tier)]
    const kind = replaceIndex != null ? rows[replaceIndex]?.kind ?? 'fallback' : 'fallback'
    if (replaceIndex != null) rows[replaceIndex] = { kind, provider: parsed.provider, model: parsed.model }
    else rows.push({ kind, provider: parsed.provider, model: parsed.model })
    mutate(() => {
      state.draft[tier] = specOf(rows, state.draft[tier])
      state.addingTier = null
      state.replaceAt = null
      state.manual = ''
      state.pick = null
      state.notice = null
    }, section, snapshot)
  }

  async function save(snapshot) {
    const doc = { version: 1, updatedAt: Date.now(), tiers: clone(state.draft ?? {}) }
    try {
      // 面板**唯一**会写的文件。守门（check.mjs）就盯着这个调用形态：实参必须是 chainPathFor(…)。
      const res = await host.writeFile(chainPathFor(snapshot), JSON.stringify(doc, null, 2) + '\n')
      if (res && res.written === false) throw new Error('宿主没有确认写入')
      state.dirty = false
      state.save = {
        status: 'waiting',
        at: Date.now(),
        prevAppliedAt: snapshot?.chain?.appliedAt ?? null,
        appliedAt: null,
        error: null,
      }
      state.notice = null
      onNeedPoll?.()
    } catch (err) {
      state.save.error = err instanceof Error ? err.message : String(err)
      state.save.status = 'failed'
      state.notice = `写入失败：${state.save.error}`
    }
  }

  // ---- 渲染 ----

  function renderRow(tier, row, index, section) {
    const rows = rowsFor(tier)
    // 按**方向**禁用：同类组的首行不能上移、末行不能下移。
    // 之前只判"同类只有一行"才会全禁 —— 于是首回退的 ↑、末回退的 ↓ 是"亮着但点了没反应"的死按钮（评审抓出来的）。
    const sameKind = rows.map((r, i) => (r.kind === row.kind ? i : -1)).filter((i) => i >= 0)
    const pos = sameKind.indexOf(index)
    const upDisabled = pos <= 0
    const downDisabled = pos >= sameKind.length - 1
    // data-* 是给"像用户那样点"的自动化用的（CDP 只按坐标点，认不得文字）——
    // 面板跨源，脚本摸不到 DOM，只能靠选择器定位到矩形再发真鼠标事件。
    const line = el('div', {
      class: 'rv-row',
      'data-tier': tier,
      'data-kind': row.kind,
      'data-index': String(index),
      'data-ref': row.model ? `${row.provider}/${row.model}` : `${row.provider}/`,
    })
    line.append(el('span', { class: row.kind === 'target' ? 'rv-row-idx rv-row-idx-first' : 'rv-row-idx', text: row.kind === 'target' ? '首选' : String(index + 1) }))
    const ref = el('code', { class: 'rv-ref', text: row.model ? `${row.provider}/${row.model}` : `${row.provider}/（同模型换 provider）` })
    line.append(ref)
    if (!row.model) line.append(el('span', { class: 'rv-row-note', text: '同模型换 provider' }))
    line.append(el('span', { class: 'rv-grow' }))

    const btnHost = el('span', { class: 'rv-row-btns' })
    const mk = (act, label, title, disabled, onClick) => {
      const h = el('span', { 'data-act': act })
      mountButton(h, { label, variant: 'ghost', size: 'xs', disabled, onClick })
      // mountButton 只认自己的几个 prop，tooltip / 测试钩子得自己挂到按钮上
      const btn = h.querySelector('button')
      if (btn) {
        btn.setAttribute('title', title)
        btn.setAttribute('data-act', act)
      }
      btnHost.append(h)
    }
    mk('up', '↑', '上去一位（同种类内）', upDisabled, () => move(tier, index, -1, section, section.__snapshot))
    mk('down', '↓', '下去一位（同种类内）', downDisabled, () => move(tier, index, +1, section, section.__snapshot))
    mk('swap', '换', '换这个模型', false, () => {
      state.addingTier = tier
      state.replaceAt = index
      state.pick = null
      state.manual = ''
      state.notice = null
      render(section, section.__snapshot)
    })
    mk('remove', '×', '删掉这一行', false, () => removeRow(tier, index, section, section.__snapshot))
    line.append(btnHost)
    return line
  }

  function renderPicker(tier, snapshot, section) {
    const wrap = el('div', { class: 'rv-picker' })
    const used = new Set(rowsFor(tier).map((r) => `${r.provider}/${r.model}`))
    const candidates = (snapshot?.models?.candidates ?? []).filter((c) => !used.has(c.ref))
    const otherTier = new Set(
      TIER_ORDER.filter((t) => t !== tier).flatMap((t) => rowsFor(t).map((r) => `${r.provider}/${r.model}`)),
    )
    const selectHost = el('span', { class: 'rv-picker-select', 'data-act': 'pick' })
    mountSelect(selectHost, {
      value: state.pick,
      options: candidates.map((c) => ({
        id: c.ref,
        label: c.ref,
        hint: otherTier.has(c.ref) ? '别的档位在用' : c.context ? `${Math.round(c.context / 1000)}k 上下文` : undefined,
      })),
      searchable: true,
      placeholder: candidates.length ? '从可用模型里选…' : '（发现列表为空，用右边手填）',
      onChange: (id) => {
        state.pick = id
        place(tier, id, state.replaceAt ?? null, section, snapshot)
      },
    })
    wrap.append(selectHost)
    const fieldHost = el('span', { class: 'rv-picker-field', 'data-act': 'manual' })
    const addHost = el('span', { 'data-act': 'add-manual' })
    // 输入框与「加入」联动：不然打完字按钮还是灰的，而且不重画就一直灰（实测踩到）
    const addBtn = mountButton(addHost, {
      label: '加入',
      variant: 'secondary',
      size: 'sm',
      disabled: !state.manual.includes('/'),
      onClick: () => {
        place(tier, state.manual.trim(), state.replaceAt ?? null, section, snapshot)
      },
    })
    mountTextField(fieldHost, {
      value: state.manual,
      placeholder: 'provider/model',
      mono: true,
      onChange: (v) => {
        state.manual = v
        addBtn.update({ disabled: !v.includes('/') })
      },
    })
    wrap.append(fieldHost, addHost)
    const cancelHost = el('span', { 'data-act': 'cancel' })
    mountButton(cancelHost, {
      label: '取消',
      variant: 'ghost',
      size: 'sm',
      onClick: () => {
        state.addingTier = null
        state.replaceAt = null
        state.manual = ''
        state.pick = null
        render(section, snapshot)
      },
    })
    wrap.append(cancelHost)
    wrap.append(el('div', { class: 'rv-picker-hint', text: `候选来自代理的 /v1/models + 链上在用的 + 引擎注册的（共 ${(snapshot?.models?.candidates ?? []).length} 个）` }))
    return wrap
  }

  function renderTier(tier, snapshot, section) {
    const spec = state.draft?.[tier] ?? {}
    const rows = rowsFor(tier)
    const block = el('div', { class: 'rv-tier', 'data-tier': tier })
    const head = el('div', { class: 'rv-tier-head' })
    head.append(el('span', { class: 'rv-tier-name', text: `reeve/${tier}` }))
    // 档位标签不做彩色胶囊：强调色在同一个面板里已经表示"首选"和主按钮，这里用灰字就够
    head.append(el('span', { class: 'rv-tier-hint', text: `${TIER_LABEL[tier]} · ${TIER_HINT[tier]}` }))
    head.append(el('span', { class: 'rv-grow' }))
    head.append(el('span', { class: 'rv-tier-count', text: `${rows.length} 行` }))
    block.append(head)

    if (rows.length === 0) {
      block.append(el('div', { class: 'rv-empty-sm', text: '这一档还是空的 —— 加一行回退它就有链可走了。' }))
    }
    rows.forEach((row, i) => block.append(renderRow(tier, row, i, section)))

    if (state.addingTier === tier) {
      block.append(renderPicker(tier, snapshot, section))
    } else {
      const addHost = el('span', { 'data-act': 'add' })
      mountButton(addHost, {
        label: '＋ 加回退',
        variant: 'ghost',
        size: 'sm',
        onClick: () => {
          state.addingTier = tier
          state.replaceAt = null
          state.manual = ''
          state.pick = null
          render(section, snapshot)
        },
      })
      block.append(el('div', { class: 'rv-row-add', 'data-tier': tier }, [addHost]))
    }
    return block
  }

  function render(section, snapshot) {
    if (!section) return
    section.__snapshot = snapshot
    syncFrom(snapshot)
    syncSave(snapshot)
    section.replaceChildren()

    const chain = snapshot?.chain ?? null
    const meta = el('div', { class: 'rv-meta' })
    const path = chainPathFor(snapshot)
    // 路径与来源并成一行：两行说的是同一件事（"这份链是从哪个文件来的"）
    const derived = chain ? (chain.derived ? '派生' : chain.source ? `回落 ${shortPath(chain.source)}` : '未知来源') : null
    meta.append(el('div', { text: `链文件：${shortPath(path)}${derived ? `（${derived}）` : ''}` }))
    if (chain) {
      if (chain.error) meta.append(el('div', { text: `⚠️ ${chain.error}` }))
      if (chain.appliedAt) meta.append(el('div', { text: `运行时已生效：${fmtClock(chain.appliedAt)}（${fmtAgo(chain.appliedAt)}）` }))
      else meta.append(el('div', { text: '运行时尚未确认生效（代理可能没起来）' }))
      const d = chain.drift
      if (d?.drifted) {
        meta.append(el('div', { text: `⚠️ 与运行时还有差异：缺 ${d.missing?.length ?? 0} · 变 ${d.changed?.length ?? 0} · 多 ${d.extra?.length ?? 0}` }))
      }
      if (chain.problems?.length) meta.append(el('div', { text: `⚠️ ${chain.problems.join('；')}` }))
    } else {
      meta.append(el('div', { text: '快照里还没有链的信息（插件可能没起来，或还没写第一份快照）' }))
    }
    section.append(meta)

    if (state.notice) section.append(el('div', { class: 'rv-warn', text: state.notice }))

    for (const tier of TIER_ORDER) section.append(renderTier(tier, snapshot, section))

    // 保存条
    const bar = el('div', { class: 'rv-savebar' })
    const saveHost = el('span', { 'data-act': 'save' })
    mountButton(saveHost, {
      label: '保存并生效',
      variant: 'default',
      size: 'sm',
      disabled: !state.dirty,
      loading: state.save.status === 'waiting',
      onClick: () => void save(snapshot).then(() => render(section, snapshot)),
    })
    bar.append(saveHost)
    const resetHost = el('span', { 'data-act': 'reset' })
    mountButton(resetHost, {
      label: '丢弃改动',
      variant: 'ghost',
      size: 'sm',
      disabled: !state.dirty,
      onClick: () => {
        state.dirty = false
        state.sourceSig = null
        state.notice = null
        state.save = { status: 'idle', at: null, prevAppliedAt: null, appliedAt: null, error: null }
        render(section, snapshot)
      },
    })
    bar.append(resetHost)
    const s = state.save
    const status = state.dirty
      ? '有未保存的改动（改了才会写链文件）'
      : s.status === 'waiting'
        ? `已写入，等待收敛（插件最多 5 秒一轮；实际通常几秒）…`
        : s.status === 'applied'
          ? `已生效 ${fmtClock(s.appliedAt)}${s.error ? ` · ⚠️ ${s.error}` : ''}`
          : s.status === 'timeout'
            ? '写入后 30 秒还没看到运行时确认 —— 看插件的代理状态与代理日志'
            : s.status === 'failed'
              ? `写入失败：${s.error}`
              : '已是最新，无需保存'
    bar.append(el('span', { class: 'rv-save-status', text: status }))
    section.append(bar)
  }

  return {
    render,
    needsPoll: () => state.save.status === 'waiting' || state.dirty,
    isDirty: () => state.dirty,
  }
}