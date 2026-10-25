// 链 tab：GATE 配置的编辑面 —— 平铺的分区 + 行（宿主的设置页写法：细线分隔，不用卡片。
//   一条链 = 一组行（链名行 + 候选行 + 动作行，组间用 hairline 分隔；agent 映射与策略是"左标签 / 右控件"的设置行。
//
// 动线只有一条：**选一个候选 → 动作条出现（Up/Down/换/删→ 改完保存 → 顶部变「Applied」**。
// 想加：链卡底部的「＋ 添加候选」→ 搜索/手填 → 落进链尾。
//
// 三条排版纪律（上一版就是在这儿翻车的：一排同权的小按钮 + 满屏等重文字 = 没有重点：
//   ① 每张卡只有**一个主动作**（链卡=More菜单，整体=保存；其余动作要经过选择才出现。
//   ② 每条事实只出现一次：模型名不再同时进标题与"首选"标注（首选用徽标说一次。
//   ③ 卡里up to一行灰字解释；细节交给 placeholder / helper / 菜单项文案。
//
// 它写什么：**只写 GATE 的 fallback 配置**（路径取自快照 `gate.from`。写入是宿主的原子写
// （temp + rename，GATE 那边永远看不到半截 JSON；`fallback-edit.js` 保证只重写被改的几节。

import { applySave, parseJsonc, planSave, viewOf } from './fallback-edit.js'
import { problemText, t, tn } from './i18n.js'
import { agentLabel, chainLabel, modelRefParts, providerLabel, tierLabel } from './labels.js'
import { badge, banner, button, checkbox, field, fieldRow, kitIcon, list, menu, search, section as kitSection, select, separator, spinner } from './kit.js'
import { el, fallbackConfigPathFor, readGateConfig } from './util.js'

const clone = (v) => JSON.parse(JSON.stringify(v ?? {}))
const chainNames = (view) => Object.keys(view?.chains ?? {})

/** 引擎档位（chain_for_model 的编辑面只露这五个；未知映射原样保留、只读展示。 */
const TIER_MODELS = ['reeve/flash', 'reeve/standard', 'reeve/pro', 'reeve/multimodal', 'reeve/free']

/** 写入/校验错误 → 本地化文案（fallback-edit 抛的是带 code 的错误）。 */
const errText = (err) => {
  if (err?.code === 'problem.save.refused') {
    return t('problem.save.refused', {
      n: err.problems?.length ?? 0,
      list: (err.problems ?? []).map(problemText).join('; '),
    })
  }
  if (err?.code === 'problem.save.selfCheck') return t('problem.save.selfCheck', { error: err.detail ?? '' })
  return err instanceof Error ? err.message : String(err)
}

export function createChainTab({ host, onNeedPoll, readInfo = null, onStateChange = null }) {
  const state = {
    live: '',
    view: null,
    baseView: null, // 最近一次"从盘上读到的"视图：用来标出哪些节真的改了
    text: null,
    path: null,
    sourceSig: null,
    loadError: null,
    loadTried: [],
    dirty: false,
    notice: null,
    selected: null, // { chain, ref }
    picker: null, // { chain, replaceRef|null, query, manual }
    addingChain: false,
    newChainName: '',
    save: { status: 'idle', at: null, error: null, planned: null },
    // 折叠块的展开状态要跨重绘保留 —— 否则「Advanced」里点一下按钮，重绘后块又合上了
    openBlocks: {},
    // 最近一次渲染的落点：页面级保存条（在 main.js）要用它触发保存/放弃
    section: null,
    snapshot: null,
  }

  /** 把保存态交给页面（页头徽标 + 页面级保存条都在 main.js；切 tab 不丢）。 */
  const publish = () => onStateChange?.({ dirty: state.dirty, save: state.save, snapshot: state.snapshot })

  /** 从盘上读一次配置。**有未保存改动时不覆盖**（用户的编辑优先）。 */
  async function load(snapshot, { force = false } = {}) {
    const res = await readGateConfig(host, snapshot)
    if (!res.ok) {
      state.loadError = res.code
      state.loadTried = res.tried
      return
    }
    let view
    try {
      view = viewOf(parseJsonc(res.content)).view
    } catch (err) {
      state.loadError = t('config.parseError', { error: String(err?.message ?? err) })
      state.loadTried = [{ path: res.path ?? fallbackConfigPathFor(snapshot), code: 'PARSE_ERROR' }]
      return
    }
    const sig = JSON.stringify(view)
    state.loadError = null
    state.path = res.path
    if (state.dirty && !force) {
      if (sig !== state.sourceSig) state.notice = t('config.changedOnDisk')
      state.sourceSig = sig
      return
    }
    if (force || !state.view || sig !== state.sourceSig) {
      state.view = view
      state.baseView = clone(view)
      state.text = res.content
      state.sourceSig = sig
      if (force) state.dirty = false
    }
  }

  function mutate(section, snapshot, fn) {
    fn()
    state.dirty = true
    render(section, snapshot)
    onNeedPoll?.()
  }

  /** 文本框类编辑的脏反馈：**不重绘**（重绘会打断输入焦点），只点亮页头徽标与保存条。 */
  function markDirty() {
    state.dirty = true
    publish()
    onNeedPoll?.()
  }

  // ---- 编辑动作（All经过"选择"这一个入口，除了加/删链这种链级动作 ----

  const targetsOf = (chain) => [...(state.view.chains[chain]?.targets ?? [])]

  /** 这一节相对"上次读到的盘上内容"有没有改（用来把"Unsaved"钉到具体的节。 */
  const sectionChanged = (a, b) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)
  const dirtyHead = (changed) => (state.dirty && changed ? badge({ label: t('save.unsaved'), tone: 'warning' }).node : null)

  /** 播报给读屏（aria-live：动作完成后确认一次，别让键盘用户猜。 */
  const announce = (text) => {
    state.live = text
  }

  /** 改一条链的 targets 时**保留 spec 里的未知键**（面板只管 targets，别的键不是它的。 */
  const setTargets = (chain, targets) => {
    state.view.chains[chain] = { ...clone(state.view.chains[chain]), targets }
  }

  function moveSelected(chain, ref, delta, section, snapshot) {
    const targets = targetsOf(chain)
    const at = targets.indexOf(ref)
    const to = at + delta
    if (at < 0 || to < 0 || to >= targets.length) return
    ;[targets[at], targets[to]] = [targets[to], targets[at]]
    announce(t('chain.moved', { ref, position: to + 1 }))
    mutate(section, snapshot, () => setTargets(chain, targets))
    focusRow(chain, to)
  }

  /** 重画之后把焦点放回被移动的那一行（W3C APG：移动后焦点跟着条目走。 */
  function focusRow(chain, index) {
    queueMicrotask(() => {
      const card = document.querySelector(`[data-chain="${CSS.escape(chain)}"]`)
      const row = card?.querySelectorAll('.oc-sdk-row')?.[index]
      row?.focus?.()
    })
  }

  /** 列表容器上的键盘处理（listbox 约定，键位对齐 W3C APG「可重排列表」：
   *  ↑/↓ 选 · Alt+↑/↓ 换位 · Enter 换模型 · Delete 删。 */
  function onListKeydown(event, chain, section, snapshot) {
    const sel = state.selected?.chain === chain ? state.selected.ref : null
    const targets = targetsOf(chain)
    if (event.key === 'ArrowUp' && !event.altKey) {
      event.preventDefault()
      const at = sel ? targets.indexOf(sel) : targets.length
      const next = targets[Math.max(0, at - 1)]
      if (next) {
        state.selected = { chain, ref: next }
        render(section, snapshot)
        focusRow(chain, Math.max(0, at - 1))
      }
      return
    }
    if (event.key === 'ArrowDown' && !event.altKey) {
      event.preventDefault()
      const at = sel ? targets.indexOf(sel) : -1
      const next = targets[Math.min(targets.length - 1, at + 1)]
      if (next) {
        state.selected = { chain, ref: next }
        render(section, snapshot)
        focusRow(chain, Math.min(targets.length - 1, at + 1))
      }
      return
    }
    if (!sel) return
    if (event.altKey && event.key === 'ArrowUp') {
      event.preventDefault()
      moveSelected(chain, sel, -1, section, snapshot)
    } else if (event.altKey && event.key === 'ArrowDown') {
      event.preventDefault()
      moveSelected(chain, sel, +1, section, snapshot)
    } else if (event.key === 'Delete') {
      event.preventDefault()
      announce(t('chain.removed', { ref: sel }))
      removeSelected(chain, sel, section, snapshot)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      state.picker = { chain, replaceRef: sel, query: '', manual: '' }
      render(section, snapshot)
    }
  }

  function removeSelected(chain, ref, section, snapshot) {
    mutate(section, snapshot, () => {
      setTargets(chain, targetsOf(chain).filter((t) => t !== ref))
      state.selected = null
    })
  }

  function placeTarget(chain, ref, replaceRef, section, snapshot) {
    const r = String(ref ?? '').trim()
    if (!r.includes('/')) {
      state.notice = t('chain.unknownModel', { ref })
      render(section, snapshot)
      return
    }
    const targets = targetsOf(chain)
    if (replaceRef != null && targets.includes(replaceRef)) targets[targets.indexOf(replaceRef)] = r
    else targets.push(r)
    mutate(section, snapshot, () => {
      setTargets(chain, targets)
      state.picker = null
      state.notice = null
      state.selected = { chain, ref: r }
    })
  }

  function addChain(name, section, snapshot) {
    const n = String(name ?? '').trim()
    if (!n || !/^[\w.-]+$/.test(n) || state.view.chains[n]) {
      state.notice = !n || !/^[\w.-]+$/.test(n) ? t('chain.nameRule') : t('chain.exists', { name: n })
      render(section, snapshot)
      return
    }
    mutate(section, snapshot, () => {
      state.view.chains[n] = { targets: [] }
      state.addingChain = false
      state.newChainName = ''
      state.notice = null
    })
  }

  function removeChain(chain, section, snapshot) {
    mutate(section, snapshot, () => {
      delete state.view.chains[chain]
      if (state.view.default_chain === chain) state.view.default_chain = chainNames(state.view)[0] ?? null
      for (const [m, c] of Object.entries(state.view.chain_for_model)) if (c === chain) delete state.view.chain_for_model[m]
      if (state.selected?.chain === chain) state.selected = null
    })
  }

  /** 删链前的引用计数：档位映射（chain_for_model指向它时**拒绝删**——0.1.x 会静默
   *  把 reeve/pro → reasoning 这类映射一起删掉，用户模型面直接 404。 */
  function tierUsersOf(chain) {
    return Object.entries(state.view.chain_for_model ?? {})
      .filter(([, c]) => c === chain)
      .map(([m]) => m)
  }

  // ---- 保存：改 → 写 → 等快照里的 gate 段真的变（≤5s 热更 ----

  async function save(snapshot, section) {
    const planned = planSave(state.view)
    if (planned.problems.length) {
      const list = planned.problems.map(problemText)
      state.save = { status: 'failed', at: Date.now(), error: list.join('; '), planned: null }
      state.notice = t('save.fixProblems', { n: planned.problems.length, list: list.join('; ') })
      render(section, snapshot)
      return
    }
    try {
      // 只重写**真的改了**的节：没改的节（连同里面的注释与排版一个字节都不动。
      // 比较用编辑视图 vs 盘上视图（planned 是归一化产物，直接比会把"补了default值"当成改动。
      const ALL_SECTIONS = ['chains', 'agents', 'chain_for_model', 'policy', 'free', 'default_chain']
      const changed = ALL_SECTIONS.filter((k) => sectionChanged(state.view?.[k], state.baseView?.[k]))
      const { text } = applySave(state.text ?? '', planned, { sections: changed })
      const res = await host.writeFile(fallbackConfigPathFor(snapshot), text)
      if (res && res.written === false) throw new Error(t('save.hostNoConfirm'))
      state.dirty = false
      state.notice = null
      state.save = { status: 'waiting', at: Date.now(), error: null, planned }
      onNeedPoll?.()
      await load({ ...snapshot, gate: { ...(snapshot?.gate ?? {}), from: state.path } }, { force: true })
    } catch (err) {
      state.save = { status: 'failed', at: Date.now(), error: errText(err), planned: null }
      state.notice = state.save.error
    }
    render(section, snapshot)
  }

  /** 保存是否真的到了 GATE：比的是链的**目标全集**（chain_targets与档位映射/策略/Free pool，
   *  不再只比链名 —— 只比名字会把"加了候选但 GATE 没变"误判成Applied（预览是内存写，以前就这样假绿。
   *  策略只比面板暴露的四个键（快照的 gate.policy 只投影这四个；planned 里带着未知键，直接比永远不等。 */
  function syncSave(snapshot) {
    const s = state.save
    if (s.status !== 'waiting' || !s.planned) return
    const g = snapshot?.gate
    if (!g || g.error) {
      if (Date.now() - s.at > 30_000) s.status = 'timeout'
      return
    }
    const plannedTargets = Object.fromEntries(Object.entries(s.planned.chains).map(([name, spec]) => [name, spec.targets]))
    const sortedStatic = (o) => Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b)))
    const FREE_KEYS = ['enabled', 'max', 'providers', 'refresh_seconds', 'failure_threshold', 'failure_cooldown_seconds', 'prefer', 'deny', 'static']
    const pickFree = (f) => {
      const out = {}
      for (const k of FREE_KEYS) out[k] = k === 'static' ? sortedStatic(f?.[k]) : f?.[k]
      return out
    }
    const POLICY_KEYS = ['max_fallback_attempts', 'cooldown_seconds', 'restore_primary_after_cooldown', 'provider_retries']
    const pickPolicy = (p) => Object.fromEntries(POLICY_KEYS.map((k) => [k, p?.[k]]))
    const same =
      JSON.stringify(g.chain_targets ?? {}) === JSON.stringify(plannedTargets) &&
      JSON.stringify(g.agents ?? {}) === JSON.stringify(s.planned.agents) &&
      JSON.stringify(g.chain_for_model ?? {}) === JSON.stringify(s.planned.chain_for_model) &&
      JSON.stringify(g.default_chain ?? null) === JSON.stringify(s.planned.default_chain ?? null) &&
      JSON.stringify(pickPolicy(g.policy)) === JSON.stringify(pickPolicy(s.planned.policy)) &&
      JSON.stringify(pickFree(g.free)) === JSON.stringify(pickFree(s.planned.free))
    if (same) s.status = 'applied'
    else if (Date.now() - s.at > 30_000) s.status = 'timeout'
  }

  // ---- 渲染 ----

  /** 候选行的"用量"读数（有台账才画；没有就不占位。 */
  function usageOf(snapshot, ref) {
    const model = (snapshot?.stats?.gate?.byModel ?? []).find((m) => m.ref === ref)
    if (!model) return null
    return `${model.n}`
  }

  function renderChainCard(chain, snapshot, section) {
    const targets = targetsOf(chain)
    const tierUsers = tierUsersOf(chain)
    const card = el('div', { class: 'oc-col oc-chain-card', 'data-chain': chain })

    // Title row: chain ID + badges + More; counts on their own line (More stays on top at 306px)
    const head = el('div', { class: 'oc-chain-head' })
    const titleRow = el('div', { class: 'oc-chain-title' })
    const left = el('div', { class: 'oc-chain-title-main' })
    left.append(el('span', { class: 'oc-chain-name', text: chainLabel(chain) }))
    if (state.view.default_chain === chain) left.append(badge({ label: t('chain.defaultBadge'), tone: 'primary' }).node)
    if (targets.includes('@free')) left.append(badge({ label: '@free', tone: 'info' }).node)
    const right = el('div', { class: 'oc-bar' })
    right.append(
      menu({
        label: t('action.more'),
        iconName: 'chevron',
        variant: 'ghost',
        size: 'xs',
        data: { 'data-act': 'chain-menu', 'data-chain': chain },
        items: [
          { id: 'default', label: t('action.setDefault'), disabled: state.view.default_chain === chain },
          { separator: true },
          {
            id: 'delete',
            label: tierUsers.length > 0 ? t('chain.deleteInUse', { tiers: tierUsers.map(tierLabel).join(', ') }) : t('chain.delete'),
            destructive: true,
            disabled: tierUsers.length > 0 || chainNames(state.view).length <= 1,
          },
        ],
        onSelect: (id) => {
          if (id === 'default') mutate(section, snapshot, () => { state.view.default_chain = chain })
          if (id === 'delete') removeChain(chain, section, snapshot)
        },
      }).node,
    )
    titleRow.append(left, right)
    const paidCount = targets.filter((t) => t !== '@free').length
    head.append(titleRow)
    head.append(el('span', { class: 'oc-micro oc-muted', text: tn(targets.includes('@free') ? 'chain.countFree' : 'chain.count', paidCount) }))
    card.append(head)

    if (targets.length === 0) {
      card.append(el('span', { class: 'oc-micro oc-muted', text: t('chain.empty') }))
    } else {
      const sel = state.selected?.chain === chain ? state.selected.ref : null
      // kit 的行是 role=option / tabindex=-1（roving tabindex→ 容器按 listbox 做，
      // 焦点留在容器上，用 aria-activedescendant 指向当前行。
      const listWrap = el('div', {
        class: targets.length > 5 ? 'oc-list-scroll' : '',
        'data-chain-list': chain,
        role: 'listbox',
        tabindex: '0',
        'aria-label': t('chain.modelsAria', { chain: chainLabel(chain) }),
      })
      listWrap.addEventListener('keydown', (event) => onListKeydown(event, chain, section, snapshot))
      queueMicrotask(() => {
        if (!sel) return
        const row = [...listWrap.querySelectorAll('.oc-sdk-row')].find((r) => (r.textContent || '').includes(sel))
        if (row?.id) listWrap.setAttribute('aria-activedescendant', row.id)
      })
      const listKit = list({
        ariaLabel: t('chain.modelsListAria', { chain: chainLabel(chain) }),
        selectedId: sel,
        items: targets.map((ref, i) => {
          if (ref === '@free') {
            const free = state.view.free ?? {}
            const maxAttempts = Math.max(1, Number(state.view.policy?.max_fallback_attempts ?? 3))
            const cap = Math.max(0, Math.min(Number(free.max ?? 0), maxAttempts - 1))
            return {
              id: ref,
              leading: String(i + 1),
              title: t('chain.freeTitle'),
              meta: free.enabled === false ? t('chain.freeDisabled') : t('chain.freeUpTo', { n: cap }),
              badge: { label: t('chain.autoBadge'), tone: 'info' },
            }
          }
          const usage = usageOf(snapshot, ref)
          const parts = modelRefParts(ref)
          return {
            id: ref,
            leading: String(i + 1),
            title: parts.title,
            subtitle: parts.sub,
            meta: usage ?? undefined,
          }
        }),
        onSelect: (ref) => {
          state.selected = state.selected?.ref === ref ? null : { chain, ref }
          state.picker = null
          render(section, snapshot)
        },
      })
      // 窄栏（≤360）隐藏 provider 副标，靠 title 保留完整 ref
      const rows = listKit.node.querySelectorAll('.oc-sdk-row')
      rows.forEach((row, i) => { if (targets[i]) row.setAttribute('title', targets[i]) })
      listWrap.append(listKit.node)
      card.append(listWrap)

      // 选中之后才出现的动作条（同权按钮不成群：这里up to四个，而且针对的是"这一models"
      if (sel) {
        const at = targets.indexOf(sel)
        const bar = el('div', { class: 'oc-bar oc-bar-between', 'data-act': 'row-actions', 'data-ref': sel, role: 'group', 'aria-label': t('chain.selected', { ref: sel }) })
        bar.append(el('span', { class: 'oc-micro oc-muted oc-truncate oc-selected-label', text: t('chain.selected', { ref: sel }) }))
        const acts = el('div', { class: 'oc-bar' })
        acts.append(
          button({ label: t('action.up'), variant: 'secondary', size: 'xs', disabled: at <= 0, data: { 'data-act': 'up', 'aria-keyshortcuts': 'Alt+ArrowUp' }, onClick: () => moveSelected(chain, sel, -1, section, snapshot) }).node,
          button({ label: t('action.down'), variant: 'secondary', size: 'xs', disabled: at < 0 || at >= targets.length - 1, data: { 'data-act': 'down', 'aria-keyshortcuts': 'Alt+ArrowDown' }, onClick: () => moveSelected(chain, sel, +1, section, snapshot) }).node,
          button({
            label: t('action.replace'),
            variant: 'secondary',
            size: 'xs',
            data: { 'data-act': 'swap', 'aria-keyshortcuts': 'Enter' },
            onClick: () => {
              state.picker = { chain, replaceRef: sel, query: '', manual: '' }
              render(section, snapshot)
            },
          }).node,
          button({ label: t('action.remove'), variant: 'destructive', size: 'xs', data: { 'data-act': 'remove', 'aria-keyshortcuts': 'Delete' }, onClick: () => removeSelected(chain, sel, section, snapshot) }).node,
        )
        bar.append(acts)
        card.append(bar)
      }
    }

    // 加模型：动线 = 点一下 → 出现搜索 + 手填
    if (state.picker?.chain === chain) {
      card.append(separator({ label: state.picker.replaceRef ? t('chain.replaceSeparator', { ref: state.picker.replaceRef }) : t('chain.addToEnd') }))
      card.append(renderPicker(chain, snapshot, section))
    } else {
      card.append(
        button({
          label: t('action.addModel'),
          variant: 'ghost',
          size: 'xs',
          data: { 'data-act': 'add' },
          onClick: () => {
            state.picker = { chain, replaceRef: null, query: '', manual: '' }
            render(section, snapshot)
          },
        }).node,
      )
    }
    return card
  }

  function renderPicker(chain, snapshot, section) {
    const used = new Set(targetsOf(chain))
    const all = (snapshot?.models?.candidates ?? []).filter((c) => !used.has(c.ref) || c.ref === state.picker.replaceRef)
    const q = String(state.picker.query ?? '').toLowerCase()
    const matches = all.filter((c) => !q || c.ref.toLowerCase().includes(q)).slice(0, 30)
    const wrap = el('div', { class: 'oc-inset' })
    wrap.append(search({ value: state.picker.query, placeholder: t('chain.searchPlaceholder'), onChange: (v) => { state.picker.query = v; render(section, snapshot) } }).node)
    if (matches.length === 0) {
      wrap.append(el('span', { class: 'oc-micro oc-muted', text: all.length ? t('chain.noMatches') : t('chain.catalogEmpty') }))
    } else {
      const scroll = el('div', { class: 'oc-list-scroll' })
      scroll.append(
        list({
          ariaLabel: t('chain.availableModels'),
          selectedId: null,
          items: matches.map((c) => {
            const parts = modelRefParts(c.ref)
            return {
              id: c.ref,
              title: parts.title,
              subtitle: parts.sub,
              meta: c.sources?.includes('gate') ? t('chain.available') : t('chain.inUse'),
            }
          }),
          onSelect: (ref) => placeTarget(chain, ref, state.picker.replaceRef, section, snapshot),
        }).node,
      )
      wrap.append(scroll)
    }
    const manual = el('div', { class: 'oc-bar' })
    const apply = (v) => placeTarget(chain, v, state.picker.replaceRef, section, snapshot)
    const f = field({ value: state.picker.manual, placeholder: t('chain.manualPlaceholder'), mono: true, onChange: (v) => { state.picker.manual = v; addBtn.handle.update({ disabled: !v.includes('/') }) } })
    const addBtn = button({ label: t('action.add'), variant: 'secondary', size: 'xs', disabled: !String(state.picker.manual ?? '').includes('/'), onClick: () => apply(state.picker.manual) })
    manual.append(el('span', { class: 'oc-grow' }, [f.node]), addBtn.node)
    manual.append(button({ label: t('action.cancel'), variant: 'ghost', size: 'xs', onClick: () => { state.picker = null; render(section, snapshot) } }).node)
    wrap.append(manual)
    return wrap
  }

  /** 档位映射（chain_for_model：这是**真正生效**的路由 —— 引擎里选 reeve/* 档位时走这里
   *  指向的链。0.1.x 的面板把没有生产调用方的 `agents` 段做成了显眼编辑面，真正的映射反而
   *  藏着；0.2.0 换过来。未知映射（非档位的键原样保留，只读展示。 */
  function renderTierMapping(section, snapshot) {
    const rows = []
    for (const model of TIER_MODELS) {
      const cell = el('div', { class: 'oc-field-control oc-select-field', 'data-tier': model })
      cell.append(
        select({
          value: state.view.chain_for_model?.[model] ?? null,
          placeholder: t('tier.followDefault'),
          options: [
            ...chainNames(state.view).map((c) => ({ id: c, label: chainLabel(c), hint: c })),
          ],
          onChange: (id) => mutate(section, snapshot, () => {
            if (!id) delete state.view.chain_for_model[model]
            else state.view.chain_for_model[model] = id
          }),
        }).node,
      )
      rows.push(fieldRow({ label: tierLabel(model), control: cell, controlClass: 'oc-select-field' }))
    }
    // 未知映射（例如 provider/model → 链：面板不编辑，但保存时原样保留 —— 这里只展示
    const others = Object.entries(state.view.chain_for_model ?? {}).filter(([m]) => !TIER_MODELS.includes(m))
    if (others.length > 0) {
      const block = el('div', { class: 'oc-col', 'data-tier-others': '', style: 'gap:2px;padding:8px 0' })
      block.append(el('span', { class: 'oc-micro oc-muted', text: t('tier.others') }))
      for (const [model, chain] of others) {
        block.append(el('div', { class: 'oc-bar oc-bar-between', 'data-tier-other': model }, [
          el('span', { class: 'oc-micro oc-mono oc-truncate', text: model }),
          el('span', { class: 'oc-micro oc-muted', text: t('tier.otherLine', { model, chain: chainLabel(chain) }) }),
        ]))
      }
      rows.push(block)
    }
    const tierSection = kitSection({
      title: 'chain_for_model',
      hint: t('tier.sectionHint'),
      body: rows,
      headRight: dirtyHead(sectionChanged(state.view.chain_for_model, state.baseView?.chain_for_model)),
    })
    tierSection.setAttribute('data-section', 'tier-mapping')
    return tierSection
  }

  /** 布尔项：方框在左、标签/说明在右（宿主的 checkbox row），不用「左标签 + 右开关」那套。 */
  const checkRow = (props, data = {}) => el('div', { class: 'oc-check-row', ...data }, [checkbox(props).node])

  function renderPolicy(section, snapshot) {
    const p = state.view.policy ?? {}
    const numRow = (label, key, value, description, placeholder) => {
      const cell = el('div', { class: 'oc-field-control oc-num-field', 'data-policy': key })
      cell.append(
        field({
          value: value == null ? '' : String(value),
          mono: true,
          placeholder,
          onChange: (v) => {
            state.view.policy = { ...state.view.policy, [key]: v === '' ? null : Number(v) }
            markDirty()
          },
        }).node,
      )
      return fieldRow({ label, description, control: cell, controlClass: 'oc-num-field' })
    }
    const restoreRow = checkRow({
      label: t('policy.restore'),
      description: t('policy.restoreDesc'),
      checked: p.restore_primary_after_cooldown === true,
      onChange: (checked) => {
        state.view.policy = { ...state.view.policy, restore_primary_after_cooldown: checked }
        mutate(section, snapshot, () => {})
      },
    }, { 'data-policy': 'restore_primary_after_cooldown' })
    // 低频调参收进「Advanced」：默认值够用，不跟常用项抢位置
    const advanced = detailsBlock('policy-advanced', t('common.advanced'))
    const advancedBody = el('div', { class: 'oc-col' })
    advancedBody.append(numRow(t('policy.providerRetries'), 'provider_retries', p.provider_retries, t('policy.providerRetriesDesc'), t('policy.providerRetriesPlaceholder')))
    advanced.append(advancedBody)
    const policySection = kitSection({
      title: t('policy.title'),
      hint: t('policy.hint'),
      headRight: dirtyHead(sectionChanged(state.view.policy, state.baseView?.policy)),
      body: [
        numRow(t('policy.maxAttempts'), 'max_fallback_attempts', p.max_fallback_attempts, t('policy.maxAttemptsDesc'), t('policy.maxAttemptsPlaceholder')),
        numRow(t('policy.cooldown'), 'cooldown_seconds', p.cooldown_seconds, t('policy.cooldownDesc'), t('policy.cooldownPlaceholder')),
        restoreRow,
        advanced,
      ],
    })
    policySection.setAttribute('data-section', 'policy')
    return policySection
  }

  /** Free pool：链里的 `@free` 展开成什么、几个、谁优先、谁Deny。写的是配置里的 `free` 节。
   *  常用项只有开关/预算/发现源；调参（偏好/Deny/白名单/Refresh/cooling收进「Advanced」；
   *  Current expansion只留一行摘要（逐models列表在「Diagnostics」。 */
  function renderFree(section, snapshot) {
    const f = state.view.free ?? {}
    const runtime = snapshot?.free ?? null
    const provStatus = new Map((runtime?.providers ?? []).map((p) => [p.id, p]))
    const maxAttempts = Math.max(1, Number(state.view.policy?.max_fallback_attempts ?? 3))
    const cap = Math.max(0, Math.min(Number(f.max ?? 0), maxAttempts - 1))
    const update = (next) => mutate(section, snapshot, () => {
      state.view.free = { ...state.view.free, ...next }
    })

    const rows = []
    rows.push(
      checkRow({
        label: t('free.enable'),
        description: t('free.enableDesc'),
        checked: f.enabled !== false,
        onChange: (checked) => update({ enabled: checked }),
      }, { 'data-free': 'enabled' }),
    )

    const maxCell = el('div', { class: 'oc-field-control oc-num-field', 'data-free': 'max' })
    maxCell.append(
      field({
        value: f.max == null ? '' : String(f.max),
        mono: true,
        placeholder: t('free.maxPlaceholder'),
        onChange: (v) => {
          state.view.free = { ...state.view.free, max: v === '' ? null : Number(v) }
          markDirty()
        },
      }).node,
    )
    const budgetHint =
      f.enabled === false
        ? t('free.off')
        : Number(f.max ?? 0) > maxAttempts - 1
          ? t('free.capped', { total: maxAttempts, cap })
          : t('free.split', { total: maxAttempts, cap, paid: maxAttempts - cap })
    rows.push(fieldRow({ label: t('free.models'), description: budgetHint, control: maxCell, controlClass: 'oc-num-field' }))

    const providerIds = [...new Set(['opencode', 'openrouter', 'nvidia', ...(f.providers ?? [])])]
    for (const id of providerIds) {
      const st = provStatus.get(id)
      const enabled = (f.providers ?? []).includes(id)
      const ready = Boolean(st?.ready) && !runtime?.error
      const desc = runtime?.error
        ? t('free.runtimeReadFailed')
        : st
          ? st.ready
            ? st.error
              ? t('free.discoveryError', { count: tn('free.modelsFound', st.models), error: st.error })
              : tn('free.modelsFound', st.models)
            : st.error ?? t('free.notReadyNoKey')
          : t('free.runtimeNotReady')
      const row = el('div', { class: 'oc-check-row oc-check-with-state', 'data-free-provider': id }, [
        checkbox({
          label: providerLabel(id),
          checked: enabled,
          onChange: (checked) => {
            const next = new Set(f.providers ?? [])
            if (checked) next.add(id)
            else next.delete(id)
            update({ providers: providerIds.filter((p) => next.has(p)) })
          },
        }).node,
        el('div', { class: 'oc-provider-state' }, [
          el('span', { class: `oc-dot${ready ? ' oc-dot-ok' : ' oc-dot-warn'}` }),
          el('span', { class: 'oc-micro oc-muted', text: desc }),
        ]),
      ])
      rows.push(row)
    }

    // Current expansion（只读运行态：一行摘要；逐models列表在「Diagnostics」
    const expandLine = el('div', { class: 'oc-bar oc-bar-between', 'data-free': 'expand' })
    const expandCount = runtime?.expand?.length ?? 0
    if (!runtime) expandLine.append(el('span', { class: 'oc-micro oc-muted', text: t('free.runtimeNotReady') }))
    else if (runtime.error) expandLine.append(el('span', { class: 'oc-micro oc-muted', text: t('free.runtimeReadFailedDetail', { error: runtime.error }) }))
    else {
      const coolingN = (runtime.cooling ?? []).filter((c) => (runtime.expand ?? []).includes(c.ref)).length
      expandLine.append(el('span', { class: 'oc-micro oc-muted', text: expandCount === 0 ? t('free.expandNone') : coolingN ? t('free.expandCooling', { n: expandCount, cooling: coolingN }) : tn('free.expandNow', expandCount) }))
    }
    expandLine.append(button({ label: t('action.refresh'), variant: 'ghost', size: 'xs', data: { 'data-act': 'free-refresh' }, onClick: () => onNeedPoll?.() }).node)
    rows.push(expandLine)

    // ---- Advanced：偏好/Deny/白名单/调参 ----
    const advancedRows = []

    // Preference order（prefer：↑/↓ 调序、Deny进 deny、直接Remove
    const prefer = [...(f.prefer ?? [])]
    const preferBlock = el('div', { class: 'oc-col', 'data-free': 'prefer', style: 'gap:4px' })
    if (prefer.length === 0) preferBlock.append(el('span', { class: 'oc-micro oc-muted', text: t('free.preferEmpty') }))
    prefer.forEach((ref, i) => {
      const row = el('div', { class: 'oc-bar oc-bar-between', 'data-free-prefer': ref })
      row.append(el('span', { class: 'oc-micro oc-mono oc-truncate', text: `${i + 1}. ${ref}` }))
      const acts = el('div', { class: 'oc-bar' })
      acts.append(
        button({ label: t('action.up'), variant: 'ghost', size: 'xs', disabled: i === 0, data: { 'data-act': 'free-up' }, onClick: () => {
          const next = [...prefer]
          ;[next[i - 1], next[i]] = [next[i], next[i - 1]]
          update({ prefer: next })
        } }).node,
        button({ label: t('action.down'), variant: 'ghost', size: 'xs', disabled: i === prefer.length - 1, data: { 'data-act': 'free-down' }, onClick: () => {
          const next = [...prefer]
          ;[next[i + 1], next[i]] = [next[i], next[i + 1]]
          update({ prefer: next })
        } }).node,
        button({ label: t('action.deny'), variant: 'ghost', size: 'xs', data: { 'data-act': 'free-deny' }, onClick: () => {
          update({ prefer: prefer.filter((r) => r !== ref), deny: [...(f.deny ?? []), ref] })
        } }).node,
        button({ label: t('action.remove'), variant: 'ghost', size: 'xs', data: { 'data-act': 'free-remove' }, onClick: () => update({ prefer: prefer.filter((r) => r !== ref) }) }).node,
      )
      row.append(acts)
      preferBlock.append(row)
    })
    const addCell = el('div', { class: 'oc-bar', 'data-free': 'prefer-add' })
    let draft = ''
    const addBtn = button({ label: t('action.add'), variant: 'secondary', size: 'xs', data: { 'data-act': 'free-add' }, onClick: () => {
      const ref = draft.trim()
      if (!ref) return
      if ((f.prefer ?? []).includes(ref)) return
      update({ prefer: [...(f.prefer ?? []), ref] })
    } })
    addCell.append(
      el('span', { class: 'oc-grow' }, [
        field({ value: '', placeholder: t('free.pinPlaceholder'), mono: true, onChange: (v) => { draft = v; addBtn.handle.update({ disabled: !v.trim() }) } }).node,
      ]),
      addBtn.node,
    )
    preferBlock.append(addCell)
    advancedRows.push(blockRow(t('free.preferTitle'), t('free.preferDesc'), preferBlock))

    const deny = [...(f.deny ?? [])]
    const denyBlock = el('div', { class: 'oc-col', 'data-free': 'deny', style: 'gap:4px' })
    if (deny.length === 0) denyBlock.append(el('span', { class: 'oc-micro oc-muted', text: t('free.denyEmpty') }))
    deny.forEach((ref) => {
      const row = el('div', { class: 'oc-bar oc-bar-between', 'data-free-deny': ref })
      row.append(el('span', { class: 'oc-micro oc-mono oc-truncate', text: ref }))
      row.append(button({ label: t('action.restore'), variant: 'ghost', size: 'xs', data: { 'data-act': 'free-restore' }, onClick: () => update({ deny: deny.filter((r) => r !== ref) }) }).node)
      denyBlock.append(row)
    })
    advancedRows.push(blockRow(t('free.denyTitle'), t('free.denyDesc'), denyBlock))

    // NVIDIA 没Fix `:free` 标记（免费是账号额度→ 白名单
    const staticCell = el('div', { class: 'oc-field-control oc-text-field', 'data-free': 'static' })
    staticCell.append(
      field({
        value: (f.static?.nvidia ?? []).join(', '),
        placeholder: t('free.nvidiaPlaceholder'),
        mono: true,
        onChange: (v) => {
          const list = String(v).split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
          state.view.free = { ...state.view.free, static: { ...(state.view.free.static ?? {}), nvidia: list } }
          markDirty()
        },
      }).node,
    )
    advancedRows.push(fieldRow({ label: t('free.nvidiaTitle'), description: t('free.nvidiaDesc'), control: staticCell, controlClass: 'oc-text-field' }))

    const numFreeRow = (label, key, value, description, placeholder) => {
      const cell = el('div', { class: 'oc-field-control oc-num-field', 'data-free': key })
      cell.append(
        field({
          value: value == null ? '' : String(value),
          mono: true,
          placeholder,
          onChange: (v) => {
            state.view.free = { ...state.view.free, [key]: v === '' ? null : Number(v) }
            markDirty()
          },
        }).node,
      )
      return fieldRow({ label, description, control: cell, controlClass: 'oc-num-field' })
    }
    advancedRows.push(numFreeRow(t('free.refreshInterval'), 'refresh_seconds', f.refresh_seconds, t('free.refreshIntervalDesc'), t('free.refreshIntervalPlaceholder')))
    advancedRows.push(numFreeRow(t('free.failures'), 'failure_threshold', f.failure_threshold, t('free.failuresDesc'), t('free.failuresPlaceholder')))
    advancedRows.push(numFreeRow(t('free.cooldown'), 'failure_cooldown_seconds', f.failure_cooldown_seconds, t('free.cooldownDesc'), t('free.cooldownPlaceholder')))

    const advanced = detailsBlock('free-advanced', t('common.advanced'))
    const advancedBody = el('div', { class: 'oc-col' })
    for (const r of advancedRows) advancedBody.append(r)
    advanced.append(advancedBody)
    rows.push(advanced)

    if (runtime?.error) {
      rows.unshift(
        banner({
          tone: 'error',
          title: t('gate.notReadyTitle'),
          body: t('gate.notReadyBody', { error: runtime.error }),
        }),
      )
    }
    const freeSection = kitSection({
      title: t('free.title'),
      hint: t('free.hint'),
      body: rows,
      headRight: dirtyHead(sectionChanged(state.view.free, state.baseView?.free)),
    })
    freeSection.setAttribute('data-section', 'free')
    return freeSection
  }

  const blockRow = (label, description, node) =>
    el('div', { class: 'oc-col', 'data-free-block': label, style: 'gap:4px;padding:8px 0' }, [
      el('span', { class: 'oc-label', text: label }),
      el('span', { class: 'oc-micro oc-muted', text: description }),
      node,
    ])

  /** 折叠块（details：展开状态记在 state.openBlocks，重绘后还原。 */
  function detailsBlock(key, summaryText) {
    const node = el('details', { class: 'oc-advanced' })
    if (state.openBlocks[key]) node.setAttribute('open', '')
    node.addEventListener('toggle', () => { state.openBlocks[key] = node.open })
    const summary = el('summary', { class: 'oc-micro oc-muted' })
    summary.append(kitIcon(el('span', { class: 'oc-chev' }), 'chevron', 12), el('span', { text: summaryText }))
    node.append(summary)
    return node
  }

  /** Diagnostics：路径、原始错误码、编排面事实、Free pool 展开明细 —— 都是要"能查到"而非"常看"的东西。 */
  function renderDiagnostics(section, snapshot) {
    const gate = snapshot?.gate ?? null
    const path = state.path ?? fallbackConfigPathFor(snapshot)
    const info = typeof readInfo === 'function' ? readInfo() : null
    const runtime = snapshot?.free ?? null
    const facts = el('div', { class: 'oc-col', style: 'gap:2px' })
    const line = (label, value) => {
      const row = el('div', { class: 'oc-bar oc-bar-between', 'data-diag': label })
      row.append(el('span', { class: 'oc-micro oc-muted', text: label }))
      row.append(el('span', { class: 'oc-micro oc-mono oc-truncate', text: value }))
      facts.append(row)
    }
    const fromOther = gate?.from && gate.from !== path ? ` · ${gate.from}` : ''
    line(t('diag.configFile'), `${path}${gate?.port ? ` (router :${gate.port}${fromOther})` : ` (${t('diag.notRunning')})`}`)
    if (info?.path) line(t('diag.snapshot'), info.path)
    for (const a of state.loadTried ?? []) line(t('diag.configAttempts'), `${a.path} (${a.code})`)
    for (const a of info?.tried ?? []) line(t('diag.snapshotAttempts'), `${a.path} (${a.code})`)
    for (const p of gate?.problems ?? []) line(t('diag.problems'), p)
    const table = snapshot?.agentTable
    if (table) {
      const vis = (table.visible ?? []).map((a) => agentLabel(a.id)).join(', ') || t('diag.none')
      const roster = snapshot.roster ? t('diag.rosterInjected', { n: snapshot.roster.count }) : t('diag.rosterMissing')
      const hiddenN = Array.isArray(table.hidden) ? table.hidden.length : Number(table.hidden ?? 0)
      line(t('diag.agents'), t('diag.agentsValue', { visible: vis, hidden: hiddenN, roster }))
    }
    if (snapshot?.registered) line(t('diag.registered'), t('diag.registeredValue', { agents: snapshot.registered.agents?.length ?? 0, skills: snapshot.registered.skills?.length ?? 0 }))
    if (runtime?.expand?.length) {
      const cooling = new Map((runtime.cooling ?? []).map((c) => [c.ref, c]))
      for (const ref of runtime.expand) {
        const c = cooling.get(ref)
        line(t('diag.freeExpansion'), c ? t('diag.expansionCooling', { ref, seconds: Math.max(1, Math.round((c.until - Date.now()) / 1000)) }) : t('diag.expansionReady', { ref }))
      }
    }
    const diag = detailsBlock('diag', t('diag.diagnostics'))
    diag.setAttribute('data-section', 'diag')
    diag.append(facts)
    return diag
  }

  function render(section, snapshot) {
    if (!section) return
    state.section = section
    state.snapshot = snapshot
    section.__snapshot = snapshot
    if (state.view === null && !state.loadError) {
      const loadRow = el('div', { class: 'oc-bar', 'data-act': 'config-loading', style: 'padding:8px 0' })
      loadRow.append(spinner({}), el('span', { class: 'oc-micro oc-muted', text: t('config.reading') }))
      section.replaceChildren(loadRow)
      // 读取期间 main 可能已经拿到了更新的快照：用最新的那份重画，别让旧闭包把运行态画丢
      void load(snapshot).then(() => render(section, state.snapshot ?? snapshot))
      return
    }
    syncSave(snapshot)
    section.replaceChildren()

    const gate = snapshot?.gate ?? null
    const s = state.save

    if (state.loadError) {
      const reason =
        state.loadError === 'NOT_FOUND'
          ? t('config.error.notFound')
          : state.loadError === 'NOT_GRANTED'
            ? t('config.error.notGranted')
            : state.loadError === 'BAD_PATH'
              ? t('config.error.badPath')
              : state.loadError
      section.append(
        banner({
          tone: 'error',
          title: t('config.cannotReadTitle'),
          body: t('config.cannotReadBody', { error: reason }),
        }),
      )
      section.append(
        el('div', { class: 'oc-bar', style: 'padding:8px 0' }, [
          button({
            label: t('action.retry'),
            variant: 'secondary',
            size: 'xs',
            data: { 'data-act': 'config-retry' },
            onClick: () => {
              state.loadError = null
              state.view = null
              state.baseView = null
              render(section, snapshot)
            },
          }).node,
          el('span', { class: 'oc-micro oc-muted', text: t('config.retryHint') }),
        ]),
      )
      section.append(renderDiagnostics(section, snapshot))
      publish()
      return
    }
    // 快照读不到时也要给出原因 + 下一步；详情在「Tasks」tab
    const info = typeof readInfo === 'function' ? readInfo() : null
    if (info && info.ok === false) {
      const codes = (info.tried ?? []).map((x) => x.code)
      const hint = codes.includes('NOT_GRANTED')
        ? t('snapshot.hint.fs')
        : codes.length > 0 && codes.every((c) => c === 'NOT_FOUND')
          ? t('snapshot.hint.notFound')
          : t('snapshot.hint.retry')
      section.append(
        banner({ tone: 'warning', title: t('snapshot.unavailableTitle'), body: hint }),
      )
    }
    if (gate?.error) section.append(banner({ tone: 'warning', title: t('gate.notRunningTitle'), body: String(gate.error) }))
    if (gate?.problems?.length) section.append(banner({ tone: 'warning', title: tn('config.problemsTitle', gate.problems.length), body: gate.problems.slice(0, 3).join('; ') }))
    if (state.notice) section.append(banner({ tone: s.status === 'failed' ? 'error' : 'info', title: state.notice }))

    const chainRows = chainNames(state.view).map((chain) => renderChainCard(chain, snapshot, section))
    // 新增链：入口一行（或展开成一行输入）
    if (state.addingChain) {
      const row = el('div', { class: 'oc-bar', 'data-act': 'new-chain-row', style: 'padding:6px 0' })
      const ok = button({ label: t('action.create'), variant: 'secondary', size: 'xs', disabled: !state.newChainName.trim(), onClick: () => addChain(state.newChainName, section, snapshot) })
      row.append(
        el('span', { class: 'oc-grow' }, [
          field({
            value: state.newChainName,
            placeholder: t('chain.createPlaceholder'),
            mono: true,
            onChange: (v) => { state.newChainName = v; ok.handle.update({ disabled: !v.trim() }) },
          }).node,
        ]),
        ok.node,
        button({ label: t('action.cancel'), variant: 'ghost', size: 'xs', onClick: () => { state.addingChain = false; state.newChainName = ''; render(section, snapshot) } }).node,
      )
      chainRows.push(row)
    } else {
      chainRows.push(
        el('div', { style: 'padding:2px 0' }, [
          button({ label: t('action.newChain'), variant: 'ghost', size: 'xs', data: { 'data-act': 'add-chain' }, onClick: () => { state.addingChain = true; render(section, snapshot) } }).node,
        ]),
      )
    }
    const chainsDirty =
      sectionChanged(state.view.chains, state.baseView?.chains) ||
      sectionChanged(state.view.agents, state.baseView?.agents) ||
      state.view.default_chain !== state.baseView?.default_chain
    section.append(kitSection({ title: t('tab.chains'), hint: t('chains.sectionHint'), body: chainRows, headRight: dirtyHead(chainsDirty), divided: false }))
    section.append(renderTierMapping(section, snapshot))
    section.append(renderPolicy(section, snapshot))
    section.append(renderFree(section, snapshot))
    section.append(renderDiagnostics(section, snapshot))

    const live = el('div', { class: 'oc-sr', 'aria-live': 'polite', text: state.live })
    section.append(live)

    publish()
  }

  return {
    render,
    /** 当前停在别的 tab 时，refresh 也要把保存态对账一次。 */
    sync: (snapshot) => {
      if (!state.view) return
      syncSave(snapshot)
      publish()
    },
    needsPoll: () => state.save.status === 'waiting' || state.dirty,
    isDirty: () => state.dirty,
    count: () => chainNames(state.view).length,
    requestSave: () => {
      if (state.section && state.snapshot) void save(state.snapshot, state.section)
    },
    requestDiscard: () => {
      state.dirty = false
      state.sourceSig = null
      state.notice = null
      state.selected = null
      state.picker = null
      state.save = { status: 'idle', at: null, error: null, planned: null }
      state.view = null
      state.baseView = null
      if (state.section) render(state.section, state.snapshot)
      else publish()
    },
  }
}