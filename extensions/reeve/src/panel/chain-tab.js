// 链 tab：GATE 配置的编辑面 —— 平铺的分区 + 行（宿主的设置页写法：细线分隔，不用卡片）。
//   一条链 = 一组行（链名行 + 候选行 + 动作行），组间用 hairline 分隔；agent 映射与策略是"左标签 / 右控件"的设置行。
//
// 动线只有一条：**选一个候选 → 动作条出现（上移/下移/换/删）→ 改完保存 → 顶部变「已生效」**。
// 想加：链卡底部的「＋ 添加候选」→ 搜索/手填 → 落进链尾。
//
// 三条排版纪律（上一版就是在这儿翻车的：一排同权的小按钮 + 满屏等重文字 = 没有重点）：
//   ① 每张卡只有**一个主动作**（链卡=更多菜单，整体=保存）；其余动作要经过选择才出现。
//   ② 每条事实只出现一次：模型名不再同时进标题与"首选"标注（首选用徽标说一次）。
//   ③ 卡里最多一行灰字解释；细节交给 placeholder / helper / 菜单项文案。
//
// 它写什么：**只写 GATE 的 fallback 配置**（路径取自快照 `gate.from`）。写入是宿主的原子写
// （temp + rename），GATE 那边永远看不到半截 JSON；`fallback-edit.js` 保证只重写被改的几节。

import { applySave, parseJsonc, planSave, viewOf } from './fallback-edit.js'
import { agentLabel, chainLabel, modelRefParts, providerLabel, tierLabel } from './labels.js'
import { badge, banner, button, checkbox, field, fieldRow, list, menu, search, section as kitSection, select, separator, spinner } from './kit.js'
import { el, fallbackConfigPathFor, fmtClock, readGateConfig } from './util.js'

const clone = (v) => JSON.parse(JSON.stringify(v ?? {}))
const chainNames = (view) => Object.keys(view?.chains ?? {})

/** 引擎档位（chain_for_model 的编辑面只露这四个；未知映射原样保留、只读展示）。 */
const TIER_MODELS = ['reeve/flash', 'reeve/standard', 'reeve/pro', 'reeve/multimodal']

export function createChainTab({ host, onNeedPoll, readInfo = null }) {
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
    // 折叠块的展开状态要跨重绘保留 —— 否则「高级」里点一下按钮，重绘后块又合上了
    openBlocks: {},
  }

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
      state.loadError = `配置解析失败：${String(err?.message ?? err)}`
      state.loadTried = [{ path: res.path ?? fallbackConfigPathFor(snapshot), code: 'PARSE_ERROR' }]
      return
    }
    const sig = JSON.stringify(view)
    state.loadError = null
    state.path = res.path
    if (state.dirty && !force) {
      if (sig !== state.sourceSig) state.notice = '盘上的配置变了（你这里有未保存的改动，以你的为准）'
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

  /** 文本框类编辑的脏反馈：**不重绘**（重绘会打断输入焦点），只把保存条/徽标点亮。
   *  引用由 render() 挂在 state.ui 上。 */
  function markDirty() {
    state.dirty = true
    state.ui?.badge?.handle.update({ label: '未保存', tone: 'warning' })
    if (state.ui?.savebar) {
      state.ui.savebar.hidden = false
      state.ui.saveBtn?.handle.update({ disabled: false })
    }
    onNeedPoll?.()
  }

  // ---- 编辑动作（全部经过"选择"这一个入口，除了加/删链这种链级动作） ----

  const targetsOf = (chain) => [...(state.view.chains[chain]?.targets ?? [])]

  /** 这一节相对"上次读到的盘上内容"有没有改（用来把"未保存"钉到具体的节）。 */
  const sectionChanged = (a, b) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)
  const dirtyHead = (changed) => (state.dirty && changed ? badge({ label: '未保存', tone: 'warning' }).node : null)

  /** 播报给读屏（aria-live）：动作完成后确认一次，别让键盘用户猜。 */
  const announce = (text) => {
    state.live = text
  }

  /** 改一条链的 targets 时**保留 spec 里的未知键**（面板只管 targets，别的键不是它的）。 */
  const setTargets = (chain, targets) => {
    state.view.chains[chain] = { ...clone(state.view.chains[chain]), targets }
  }

  function moveSelected(chain, ref, delta, section, snapshot) {
    const targets = targetsOf(chain)
    const at = targets.indexOf(ref)
    const to = at + delta
    if (at < 0 || to < 0 || to >= targets.length) return
    ;[targets[at], targets[to]] = [targets[to], targets[at]]
    announce(`${ref} 移到第 ${to + 1} 位`)
    mutate(section, snapshot, () => setTargets(chain, targets))
    focusRow(chain, to)
  }

  /** 重画之后把焦点放回被移动的那一行（W3C APG：移动后焦点跟着条目走）。 */
  function focusRow(chain, index) {
    queueMicrotask(() => {
      const card = document.querySelector(`[data-chain="${CSS.escape(chain)}"]`)
      const row = card?.querySelectorAll('.oc-sdk-row')?.[index]
      row?.focus?.()
    })
  }

  /** 列表容器上的键盘处理（listbox 约定，键位对齐 W3C APG「可重排列表」）：
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
      announce(`已删除 ${sel}`)
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
      state.notice = `认不出的模型：${ref}（要写成 服务商/模型）`
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
      state.notice = !n || !/^[\w.-]+$/.test(n) ? '链名用字母/数字/. _ -' : `链 ${n} 已经存在`
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

  /** 删链前的引用计数：档位映射（chain_for_model）指向它时**拒绝删**——0.1.x 会静默
   *  把 reeve/pro → reasoning 这类映射一起删掉，用户模型面直接 404。 */
  function tierUsersOf(chain) {
    return Object.entries(state.view.chain_for_model ?? {})
      .filter(([, c]) => c === chain)
      .map(([m]) => m)
  }

  // ---- 保存：改 → 写 → 等快照里的 gate 段真的变（≤5s 热更） ----

  async function save(snapshot, section) {
    const planned = planSave(state.view)
    if (planned.problems.length) {
      state.save = { status: 'failed', at: Date.now(), error: planned.problems[0], planned: null }
      state.notice = `有 ${planned.problems.length} 个问题要先改：${planned.problems.join('；')}`
      render(section, snapshot)
      return
    }
    try {
      // 只重写**真的改了**的节：没改的节（连同里面的注释与排版）一个字节都不动。
      // 比较用编辑视图 vs 盘上视图（planned 是归一化产物，直接比会把"补了默认值"当成改动）。
      const ALL_SECTIONS = ['chains', 'agents', 'chain_for_model', 'policy', 'free', 'default_chain']
      const changed = ALL_SECTIONS.filter((k) => sectionChanged(state.view?.[k], state.baseView?.[k]))
      const { text } = applySave(state.text ?? '', planned, { sections: changed })
      const res = await host.writeFile(fallbackConfigPathFor(snapshot), text)
      if (res && res.written === false) throw new Error('宿主没有确认写入')
      state.dirty = false
      state.notice = null
      state.save = { status: 'waiting', at: Date.now(), error: null, planned }
      onNeedPoll?.()
      await load({ ...snapshot, gate: { ...(snapshot?.gate ?? {}), from: state.path } }, { force: true })
    } catch (err) {
      state.save = { status: 'failed', at: Date.now(), error: err instanceof Error ? err.message : String(err), planned: null }
      state.notice = state.save.error
    }
    render(section, snapshot)
  }

  /** 保存是否真的到了 GATE：比的是链的**目标全集**（chain_targets）与档位映射/策略/免费车道，
   *  不再只比链名 —— 只比名字会把"加了候选但 GATE 没变"误判成已生效（预览是内存写，以前就这样假绿）。
   *  策略只比面板暴露的四个键（快照的 gate.policy 只投影这四个；planned 里带着未知键，直接比永远不等）。 */
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

  /** 候选行的"用量"读数（有台账才画；没有就不占位）。 */
  function usageOf(snapshot, ref) {
    const model = (snapshot?.stats?.gate?.byModel ?? []).find((m) => m.ref === ref)
    if (!model) return null
    return `${model.n} 次`
  }

  function renderChainCard(chain, snapshot, section) {
    const targets = targetsOf(chain)
    const tierUsers = tierUsersOf(chain)
    const card = el('div', { class: 'oc-col', 'data-chain': chain, style: 'gap:6px;padding:10px 0' })

    // 标题行：链 ID 原样 + 徽标；右侧只有「更多」一个入口
    const head = el('div', { class: 'oc-bar oc-bar-between' })
    const left = el('div', { class: 'oc-bar' })
    left.append(el('span', { class: 'oc-label', text: chainLabel(chain) }))
    if (state.view.default_chain === chain) left.append(badge({ label: '默认', tone: 'primary' }).node)
    if (targets.includes('@free')) left.append(badge({ label: '@free', tone: 'info' }).node)
    const paidCount = targets.filter((t) => t !== '@free').length
    left.append(el('span', { class: 'oc-micro oc-muted', text: targets.includes('@free') ? `${paidCount} 个模型 + @free` : `${paidCount} 个模型` }))
    head.append(left)
    const right = el('div', { class: 'oc-bar' })
    right.append(
      menu({
        label: '更多',
        variant: 'ghost',
        size: 'xs',
        data: { 'data-act': 'chain-menu', 'data-chain': chain },
        items: [
          { id: 'default', label: '设为默认链', disabled: state.view.default_chain === chain },
          { separator: true },
          {
            id: 'delete',
            label: tierUsers.length > 0 ? `删除（${tierUsers.map(tierLabel).join('、')} 在用）` : '删除这条链',
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
    head.append(right)
    card.append(head)

    if (targets.length === 0) {
      card.append(el('span', { class: 'oc-micro oc-muted', text: '还没有模型 —— 加一个，路由引擎才有得试。' }))
    } else {
      const sel = state.selected?.chain === chain ? state.selected.ref : null
      // kit 的行是 role=option / tabindex=-1（roving tabindex）→ 容器按 listbox 做，
      // 焦点留在容器上，用 aria-activedescendant 指向当前行。
      const listWrap = el('div', {
        class: targets.length > 5 ? 'oc-list-scroll' : '',
        'data-chain-list': chain,
        role: 'listbox',
        tabindex: '0',
        'aria-label': `${chainLabel(chain)}的模型（↑/↓ 选 · Alt+↑/↓ 换位 · Enter 换模型 · Delete 删除）`,
      })
      listWrap.addEventListener('keydown', (event) => onListKeydown(event, chain, section, snapshot))
      queueMicrotask(() => {
        if (!sel) return
        const row = [...listWrap.querySelectorAll('.oc-sdk-row')].find((r) => (r.textContent || '').includes(sel))
        if (row?.id) listWrap.setAttribute('aria-activedescendant', row.id)
      })
      listWrap.append(
        list({
          ariaLabel: `${chainLabel(chain)}的模型`,
          selectedId: sel,
          items: targets.map((ref, i) => {
            if (ref === '@free') {
              const free = state.view.free ?? {}
              const maxAttempts = Math.max(1, Number(state.view.policy?.max_fallback_attempts ?? 3))
              const cap = Math.max(0, Math.min(Number(free.max ?? 0), maxAttempts - 1))
              return {
                id: ref,
                leading: String(i + 1),
                title: '免费车道',
                subtitle: '自动发现免费模型，失败回到付费',
                meta: free.enabled === false ? '已关闭' : `最多 ${cap} 个`,
                badge: { label: '自动', tone: 'info' },
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
        }).node,
      )
      card.append(listWrap)

      // 选中之后才出现的动作条（同权按钮不成群：这里最多四个，而且针对的是"这一个模型"）
      if (sel) {
        const at = targets.indexOf(sel)
        const bar = el('div', { class: 'oc-bar oc-bar-between', 'data-act': 'row-actions', 'data-ref': sel, role: 'group', 'aria-label': `已选 ${sel}` })
        bar.append(el('span', { class: 'oc-micro oc-muted oc-truncate', text: `已选：${sel}` }))
        const acts = el('div', { class: 'oc-bar' })
        acts.append(
          button({ label: '上移', variant: 'secondary', size: 'xs', disabled: at <= 0, data: { 'data-act': 'up', 'aria-keyshortcuts': 'Alt+ArrowUp' }, onClick: () => moveSelected(chain, sel, -1, section, snapshot) }).node,
          button({ label: '下移', variant: 'secondary', size: 'xs', disabled: at < 0 || at >= targets.length - 1, data: { 'data-act': 'down', 'aria-keyshortcuts': 'Alt+ArrowDown' }, onClick: () => moveSelected(chain, sel, +1, section, snapshot) }).node,
          button({
            label: '更换模型',
            variant: 'secondary',
            size: 'xs',
            data: { 'data-act': 'swap', 'aria-keyshortcuts': 'Enter' },
            onClick: () => {
              state.picker = { chain, replaceRef: sel, query: '', manual: '' }
              render(section, snapshot)
            },
          }).node,
          button({ label: '移除', variant: 'ghost', size: 'xs', data: { 'data-act': 'remove', 'aria-keyshortcuts': 'Delete' }, onClick: () => removeSelected(chain, sel, section, snapshot) }).node,
        )
        bar.append(acts)
        card.append(bar)
      }
    }

    // 加模型：动线 = 点一下 → 出现搜索 + 手填
    if (state.picker?.chain === chain) {
      card.append(separator({ label: state.picker.replaceRef ? `换掉 ${state.picker.replaceRef}` : '添加到链尾' }))
      card.append(renderPicker(chain, snapshot, section))
    } else {
      card.append(
        button({
          label: '+ 添加模型',
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
    wrap.append(search({ value: state.picker.query, placeholder: '搜索模型（服务商/模型）', onChange: (v) => { state.picker.query = v; render(section, snapshot) } }).node)
    if (matches.length === 0) {
      wrap.append(el('span', { class: 'oc-micro oc-muted', text: all.length ? '没有匹配的模型 —— 也可以在下面手填。' : '模型目录是空的（路由引擎还没列出来）—— 在下面手填。' }))
    } else {
      const scroll = el('div', { class: 'oc-list-scroll' })
      scroll.append(
        list({
          ariaLabel: '可选模型',
          selectedId: null,
          items: matches.map((c) => {
            const parts = modelRefParts(c.ref)
            return {
              id: c.ref,
              title: parts.title,
              subtitle: parts.sub,
              meta: c.sources?.includes('gate') ? '可用' : '已在使用',
            }
          }),
          onSelect: (ref) => placeTarget(chain, ref, state.picker.replaceRef, section, snapshot),
        }).node,
      )
      wrap.append(scroll)
    }
    const manual = el('div', { class: 'oc-bar' })
    const apply = (v) => placeTarget(chain, v, state.picker.replaceRef, section, snapshot)
    const f = field({ value: state.picker.manual, placeholder: '服务商/模型', mono: true, onChange: (v) => { state.picker.manual = v; addBtn.handle.update({ disabled: !v.includes('/') }) } })
    const addBtn = button({ label: '加入', variant: 'secondary', size: 'xs', disabled: !String(state.picker.manual ?? '').includes('/'), onClick: () => apply(state.picker.manual) })
    manual.append(el('span', { class: 'oc-grow' }, [f.node]), addBtn.node)
    manual.append(button({ label: '取消', variant: 'ghost', size: 'xs', onClick: () => { state.picker = null; render(section, snapshot) } }).node)
    wrap.append(manual)
    return wrap
  }

  /** 档位映射（chain_for_model）：这是**真正生效**的路由 —— 引擎里选 reeve/* 档位时走这里
   *  指向的链。0.1.x 的面板把没有生产调用方的 `agents` 段做成了显眼编辑面，真正的映射反而
   *  藏着；0.2.0 换过来。未知映射（非档位的键）原样保留，只读展示。 */
  function renderTierMapping(section, snapshot) {
    const rows = []
    for (const model of TIER_MODELS) {
      const cell = el('div', { class: 'oc-field-control', 'data-tier': model })
      cell.append(
        select({
          value: state.view.chain_for_model?.[model] ?? null,
          placeholder: '跟随默认链',
          options: [
            ...chainNames(state.view).map((c) => ({ id: c, label: chainLabel(c), hint: c })),
          ],
          onChange: (id) => mutate(section, snapshot, () => {
            if (!id) delete state.view.chain_for_model[model]
            else state.view.chain_for_model[model] = id
          }),
        }).node,
      )
      rows.push(fieldRow({ label: tierLabel(model), control: cell }))
    }
    // 未知映射（例如 provider/model → 链）：面板不编辑，但保存时原样保留 —— 这里只展示
    const others = Object.entries(state.view.chain_for_model ?? {}).filter(([m]) => !TIER_MODELS.includes(m))
    if (others.length > 0) {
      const block = el('div', { class: 'oc-col', 'data-tier-others': '', style: 'gap:2px;padding:8px 0' })
      block.append(el('span', { class: 'oc-micro oc-muted', text: '其他映射（面板不改；手改配置可增删）' }))
      for (const [model, chain] of others) {
        block.append(el('div', { class: 'oc-bar oc-bar-between', 'data-tier-other': model }, [
          el('span', { class: 'oc-micro oc-mono oc-truncate', text: model }),
          el('span', { class: 'oc-micro oc-muted', text: `→ ${chainLabel(chain)}（${chain}）` }),
        ]))
      }
      rows.push(block)
    }
    const tierSection = kitSection({
      title: 'chain_for_model',
      hint: '会话里选 reeve/* 时走哪条链（保存才生效）',
      body: rows,
      headRight: dirtyHead(sectionChanged(state.view.chain_for_model, state.baseView?.chain_for_model)),
    })
    tierSection.setAttribute('data-section', 'tier-mapping')
    return tierSection
  }

  /** kit 的 checkbox 是个 `button[role=checkbox]`；标签用行标题，所以按钮本身要补可访问名。 */
  const checkboxNamed = (props, name) => {
    const kit = checkbox(props)
    kit.node.querySelector('button')?.setAttribute('aria-label', name)
    return kit
  }

  function renderPolicy(section, snapshot) {
    const p = state.view.policy ?? {}
    const numRow = (label, key, value, description, placeholder) => {
      const cell = el('div', { class: 'oc-field-control', 'data-policy': key })
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
      return fieldRow({ label, description, control: cell })
    }
    const switchCell = el('div', { class: 'oc-field-control', 'data-policy': 'restore_primary_after_cooldown' })
    switchCell.append(
      checkboxNamed({
        label: '',
        checked: p.restore_primary_after_cooldown === true,
        onChange: (checked) => {
          state.view.policy = { ...state.view.policy, restore_primary_after_cooldown: checked }
          mutate(section, snapshot, () => {})
        },
      }, '冷却结束后回到首选').node,
    )
    // 低频调参收进「高级」：默认值够用，不跟常用项抢位置
    const advanced = detailsBlock('policy-advanced', '高级')
    const advancedBody = el('div', { class: 'oc-col' })
    advancedBody.append(numRow('同服务商重试', 'provider_retries', p.provider_retries, '同一家上游的瞬时错误先重试几次', '默认 1'))
    advanced.append(advancedBody)
    const policySection = kitSection({
      title: '重试策略',
      hint: '改完点保存才生效（几秒内热更）',
      headRight: dirtyHead(sectionChanged(state.view.policy, state.baseView?.policy)),
      body: [
        numRow('最多尝试次数', 'max_fallback_attempts', p.max_fallback_attempts, '换到第几个模型就放弃', '默认 3'),
        numRow('失败后冷却（秒）', 'cooldown_seconds', p.cooldown_seconds, '失败过的模型在这段时间里被跳过', '默认 60'),
        fieldRow({ label: '冷却结束后回到首选', description: '默认关：失败换人后就粘住新的模型', control: switchCell }),
        advanced,
      ],
    })
    policySection.setAttribute('data-section', 'policy')
    return policySection
  }

  /** 免费车道：链里的 `@free` 展开成什么、几个、谁优先、谁排除。写的是配置里的 `free` 节。
   *  常用项只有开关/预算/发现源；调参（偏好/排除/白名单/刷新/冷却）收进「高级」；
   *  当前展开只留一行摘要（逐个模型列表在「诊断信息」）。 */
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
    const switchCell = el('div', { class: 'oc-field-control', 'data-free': 'enabled' })
    switchCell.append(
      checkboxNamed({
        label: '',
        checked: f.enabled !== false,
        onChange: (checked) => update({ enabled: checked }),
      }, '启用免费车道').node,
    )
    rows.push(fieldRow({ label: '启用免费车道', description: '关闭后链里的免费兜底不展开，直接走付费', control: switchCell }))

    const maxCell = el('div', { class: 'oc-field-control', 'data-free': 'max' })
    maxCell.append(
      field({
        value: f.max == null ? '' : String(f.max),
        mono: true,
        placeholder: '默认 3',
        onChange: (v) => {
          state.view.free = { ...state.view.free, max: v === '' ? null : Number(v) }
          markDirty()
        },
      }).node,
    )
    const budgetHint =
      f.enabled === false
        ? '免费车道已关闭'
        : Number(f.max ?? 0) > maxAttempts - 1
          ? `总尝试 ${maxAttempts}：免费被压到 ${cap} 个`
          : `总尝试 ${maxAttempts} = 免费 ${cap} + 付费 ${maxAttempts - cap}`
    rows.push(fieldRow({ label: '免费模型数', description: budgetHint, control: maxCell }))

    const providerIds = [...new Set(['opencode', 'openrouter', 'nvidia', ...(f.providers ?? [])])]
    for (const id of providerIds) {
      const st = provStatus.get(id)
      const enabled = (f.providers ?? []).includes(id)
      const desc = runtime?.error
        ? '运行态未知（读取失败）'
        : st
          ? st.ready
            ? `${st.models} 个免费模型${st.error ? ` · 发现错误：${st.error}` : ''}`
            : st.error ?? '未就绪（密钥未配置 / 没有发现源）'
          : '运行态未就绪（路由引擎没起或还没刷新）'
      const cell = el('div', { class: 'oc-field-control', 'data-free-provider': id })
      cell.append(
        checkboxNamed({
          label: '',
          checked: enabled,
          onChange: (checked) => {
            const next = new Set(f.providers ?? [])
            if (checked) next.add(id)
            else next.delete(id)
            update({ providers: providerIds.filter((p) => next.has(p)) })
          },
        }, `${providerLabel(id)} 参与免费车道`).node,
      )
      rows.push(fieldRow({ label: providerLabel(id), description: desc, control: cell }))
    }

    // 当前展开（只读运行态）：一行摘要；逐个模型列表在「诊断信息」
    const expandLine = el('div', { class: 'oc-bar oc-bar-between', 'data-free': 'expand' })
    if (!runtime) expandLine.append(el('span', { class: 'oc-micro oc-muted', text: '运行态未就绪（路由引擎没起 / 插件还没刷）' }))
    else if (runtime.error) expandLine.append(el('span', { class: 'oc-micro oc-muted', text: `运行态读取失败：${runtime.error}` }))
    else {
      const coolingN = (runtime.cooling ?? []).filter((c) => (runtime.expand ?? []).includes(c.ref)).length
      expandLine.append(el('span', { class: 'oc-micro oc-muted', text: (runtime.expand ?? []).length === 0 ? '当前没有可展开的免费模型' : `当前可展开 ${runtime.expand.length} 个${coolingN ? `，${coolingN} 个冷却中` : ''}` }))
    }
    expandLine.append(button({ label: '刷新', variant: 'ghost', size: 'xs', data: { 'data-act': 'free-refresh' }, onClick: () => onNeedPoll?.() }).node)
    rows.push(expandLine)

    // ---- 高级：偏好/排除/白名单/调参 ----
    const advancedRows = []

    // 偏好顺序（prefer）：↑/↓ 调序、排除进 deny、直接移除
    const prefer = [...(f.prefer ?? [])]
    const preferBlock = el('div', { class: 'oc-col', 'data-free': 'prefer', style: 'gap:4px' })
    if (prefer.length === 0) preferBlock.append(el('span', { class: 'oc-micro oc-muted', text: '没有固定偏好：按发现顺序试' }))
    prefer.forEach((ref, i) => {
      const row = el('div', { class: 'oc-bar oc-bar-between', 'data-free-prefer': ref })
      row.append(el('span', { class: 'oc-micro oc-mono oc-truncate', text: `${i + 1}. ${ref}` }))
      const acts = el('div', { class: 'oc-bar' })
      acts.append(
        button({ label: '上移', variant: 'ghost', size: 'xs', disabled: i === 0, data: { 'data-act': 'free-up' }, onClick: () => {
          const next = [...prefer]
          ;[next[i - 1], next[i]] = [next[i], next[i - 1]]
          update({ prefer: next })
        } }).node,
        button({ label: '下移', variant: 'ghost', size: 'xs', disabled: i === prefer.length - 1, data: { 'data-act': 'free-down' }, onClick: () => {
          const next = [...prefer]
          ;[next[i + 1], next[i]] = [next[i], next[i + 1]]
          update({ prefer: next })
        } }).node,
        button({ label: '排除', variant: 'ghost', size: 'xs', data: { 'data-act': 'free-deny' }, onClick: () => {
          update({ prefer: prefer.filter((r) => r !== ref), deny: [...(f.deny ?? []), ref] })
        } }).node,
        button({ label: '移除', variant: 'ghost', size: 'xs', data: { 'data-act': 'free-remove' }, onClick: () => update({ prefer: prefer.filter((r) => r !== ref) }) }).node,
      )
      row.append(acts)
      preferBlock.append(row)
    })
    const addCell = el('div', { class: 'oc-bar', 'data-free': 'prefer-add' })
    let draft = ''
    const addBtn = button({ label: '加入', variant: 'secondary', size: 'xs', onClick: () => {
      const ref = draft.trim()
      if (!ref) return
      if ((f.prefer ?? []).includes(ref)) return
      update({ prefer: [...(f.prefer ?? []), ref] })
    } })
    addCell.append(
      el('span', { class: 'oc-grow' }, [
        field({ value: '', placeholder: '固定一个模型（服务商/模型 或 模型名）', mono: true, onChange: (v) => { draft = v; addBtn.handle.update({ disabled: !v.trim() }) } }).node,
      ]),
      addBtn.node,
    )
    preferBlock.append(addCell)
    advancedRows.push(blockRow('偏好顺序', '命中的排最前，其余按发现顺序；可以写裸模型名', preferBlock))

    const deny = [...(f.deny ?? [])]
    const denyBlock = el('div', { class: 'oc-col', 'data-free': 'deny', style: 'gap:4px' })
    if (deny.length === 0) denyBlock.append(el('span', { class: 'oc-micro oc-muted', text: '没有排除项' }))
    deny.forEach((ref) => {
      const row = el('div', { class: 'oc-bar oc-bar-between', 'data-free-deny': ref })
      row.append(el('span', { class: 'oc-micro oc-mono oc-truncate', text: ref }))
      row.append(button({ label: '恢复', variant: 'ghost', size: 'xs', data: { 'data-act': 'free-restore' }, onClick: () => update({ deny: deny.filter((r) => r !== ref) }) }).node)
      denyBlock.append(row)
    })
    advancedRows.push(blockRow('排除', '这些永不展开（比如已知一直限流的模型）', denyBlock))

    // NVIDIA 没有 `:free` 标记（免费是账号额度）→ 白名单
    const staticCell = el('div', { class: 'oc-field-control', 'data-free': 'static' })
    staticCell.append(
      field({
        value: (f.static?.nvidia ?? []).join(', '),
        placeholder: '逗号分隔的模型名',
        mono: true,
        onChange: (v) => {
          const list = String(v).split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
          state.view.free = { ...state.view.free, static: { ...(state.view.free.static ?? {}), nvidia: list } }
          markDirty()
        },
      }).node,
    )
    advancedRows.push(fieldRow({ label: 'NVIDIA 白名单', description: '它没有 :free 后缀；列在这里的才会被展开', control: staticCell }))

    const numFreeRow = (label, key, value, description, placeholder) => {
      const cell = el('div', { class: 'oc-field-control', 'data-free': key })
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
      return fieldRow({ label, description, control: cell })
    }
    advancedRows.push(numFreeRow('列表刷新间隔（秒）', 'refresh_seconds', f.refresh_seconds, '公开模型列表多久重拉一次', '默认 300'))
    advancedRows.push(numFreeRow('连续失败几次进冷却', 'failure_threshold', f.failure_threshold, '同一个免费模型的连续失败阈值', '默认 3'))
    advancedRows.push(numFreeRow('冷却秒数', 'failure_cooldown_seconds', f.failure_cooldown_seconds, '到阈值后多久不再展开', '默认 600'))

    const advanced = detailsBlock('free-advanced', '高级')
    const advancedBody = el('div', { class: 'oc-col' })
    for (const r of advancedRows) advancedBody.append(r)
    advanced.append(advancedBody)
    rows.push(advanced)

    if (runtime?.error) {
      rows.unshift(
        banner({
          tone: 'error',
          title: '免费车道运行态读取失败',
          body: `${runtime.error}。展开会退回配置里的偏好/付费模型；点「刷新」重试。`,
        }),
      )
    }
    const freeSection = kitSection({
      title: '免费车道',
      hint: '链里写 @free 时，这里决定展开谁、几个（保存才生效）',
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

  /** 折叠块（details）：展开状态记在 state.openBlocks，重绘后还原。 */
  function detailsBlock(key, summaryText) {
    const node = el('details', { class: 'oc-advanced' })
    if (state.openBlocks[key]) node.setAttribute('open', '')
    node.addEventListener('toggle', () => { state.openBlocks[key] = node.open })
    node.append(el('summary', { class: 'oc-micro oc-muted', text: summaryText }))
    return node
  }

  /** 诊断信息：路径、原始错误码、编排面事实、免费车道展开明细 —— 都是要"能查到"而非"常看"的东西。 */
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
    line('配置文件', `${path}${gate?.port ? `（路由引擎 :${gate.port}${gate.from ? ` · ${gate.from}` : ''}）` : '（未运行）'}`)
    if (info?.path) line('数据快照', info.path)
    for (const t of state.loadTried ?? []) line('配置读取尝试', `${t.path}（${t.code}）`)
    for (const t of info?.tried ?? []) line('快照读取尝试', `${t.path}（${t.code}）`)
    for (const p of gate?.problems ?? []) line('配置问题', p)
    const t = snapshot?.agentTable
    if (t) {
      const vis = (t.visible ?? []).map((a) => `${agentLabel(a.id)}(${a.id})`).join('、') || '（无）'
      const roster = snapshot.roster ? `名册 ${snapshot.roster.count} 个` : '名册未注入'
      const hiddenN = Array.isArray(t.hidden) ? t.hidden.length : Number(t.hidden ?? 0)
      line('智能体', `前台 ${vis} · 隐藏 ${hiddenN} 个 · ${roster}`)
    }
    if (snapshot?.registered) line('插件注册', `agent ${snapshot.registered.agents?.length ?? 0} 个 · skill ${snapshot.registered.skills?.length ?? 0} 个`)
    if (runtime?.expand?.length) {
      const cooling = new Map((runtime.cooling ?? []).map((c) => [c.ref, c]))
      for (const ref of runtime.expand) {
        const c = cooling.get(ref)
        line('免费展开', c ? `${ref}（冷却 ${Math.max(1, Math.round((c.until - Date.now()) / 1000))}s）` : `${ref}（就绪）`)
      }
    }
    const diag = detailsBlock('diag', '诊断信息')
    diag.setAttribute('data-section', 'diag')
    diag.append(facts)
    return diag
  }

  function render(section, snapshot) {
    if (!section) return
    section.__snapshot = snapshot
    if (state.view === null && !state.loadError) {
      const loadRow = el('div', { class: 'oc-bar', 'data-act': 'config-loading', style: 'padding:8px 0' })
      loadRow.append(spinner({}), el('span', { class: 'oc-micro oc-muted', text: '正在读路由配置…' }))
      section.replaceChildren(loadRow)
      void load(snapshot).then(() => render(section, snapshot))
      return
    }
    syncSave(snapshot)
    section.replaceChildren()

    const gate = snapshot?.gate ?? null
    const s = state.save

    // 头一行：保存状态徽标（markDirty 会原地更新它，所以把 kit 句柄存在 state.ui）
    const top = el('div', { class: 'oc-bar oc-bar-between' })
    top.append(el('div', { class: 'oc-bar' }))
    const right = el('div', { class: 'oc-bar' })
    const statusBadge = badge({ label: '…', tone: 'neutral' })
    const paintBadge = () => {
      if (s.status === 'failed' || s.status === 'timeout') statusBadge.handle.update({ label: '没生效', tone: 'error' })
      else if (s.status === 'waiting') statusBadge.handle.update({ label: '生效中…', tone: 'info' })
      else if (state.dirty) statusBadge.handle.update({ label: '未保存', tone: 'warning' })
      else if (s.status === 'applied') statusBadge.handle.update({ label: `已生效 ${fmtClock(s.at)}`, tone: 'success' })
      else statusBadge.handle.update({ label: '已保存', tone: 'neutral' })
    }
    paintBadge()
    right.append(statusBadge.node)
    top.append(right)
    section.append(top)

    if (state.loadError) {
      section.append(
        banner({
          tone: 'error',
          title: '读不到路由配置',
          body: `${state.loadError}（详情在下方「诊断信息」）`,
        }),
      )
      section.append(
        el('div', { class: 'oc-bar', style: 'padding:8px 0' }, [
          button({
            label: '重新读取',
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
          el('span', { class: 'oc-micro oc-muted', text: '修好文件后点这里；链/策略/免费车道在配置读不到时不可编辑。' }),
        ]),
      )
      section.append(renderDiagnostics(section, snapshot))
      return
    }
    // 快照读不到时也要给出原因 + 下一步（不能只靠页头一枚 chip；详情在「任务记录」tab）
    const info = typeof readInfo === 'function' ? readInfo() : null
    if (info && info.ok === false) {
      const codes = (info.tried ?? []).map((t) => t.code)
      const hint = codes.includes('NOT_GRANTED')
        ? '扩展的文件读取权限还没批准：去 设置 → 扩展 批准「文件系统」后点刷新。'
        : codes.length > 0 && codes.every((c) => c === 'NOT_FOUND')
          ? '插件还没写过快照：跑一次模型调用后会写。'
          : '点刷新重试。'
      section.append(
        banner({ tone: 'warning', title: '数据快照读不到', body: hint }),
      )
    }
    if (gate?.error) section.append(banner({ tone: 'warning', title: '路由引擎没有启动', body: String(gate.error) }))
    if (gate?.problems?.length) section.append(banner({ tone: 'warning', title: `配置加载有 ${gate.problems.length} 个问题`, body: gate.problems.slice(0, 3).join('；') }))
    if (state.notice) section.append(banner({ tone: s.status === 'failed' ? 'error' : 'info', title: state.notice }))

    const chainRows = chainNames(state.view).map((chain) => renderChainCard(chain, snapshot, section))
    // 新增链：入口一行（或展开成一行输入）
    if (state.addingChain) {
      const row = el('div', { class: 'oc-bar', 'data-act': 'new-chain-row', style: 'padding:8px 0' })
      const ok = button({ label: '创建', variant: 'secondary', size: 'xs', disabled: !state.newChainName.trim(), onClick: () => addChain(state.newChainName, section, snapshot) })
      row.append(
        el('span', { class: 'oc-grow' }, [
          field({
            value: state.newChainName,
            placeholder: '新链名，如 free-first',
            mono: true,
            onChange: (v) => { state.newChainName = v; ok.handle.update({ disabled: !v.trim() }) },
          }).node,
        ]),
        ok.node,
        button({ label: '取消', variant: 'ghost', size: 'xs', onClick: () => { state.addingChain = false; state.newChainName = ''; render(section, snapshot) } }).node,
      )
      chainRows.push(row)
    } else {
      chainRows.push(
        el('div', { style: 'padding:6px 0' }, [
          button({ label: '+ 新增链', variant: 'ghost', size: 'xs', data: { 'data-act': 'add-chain' }, onClick: () => { state.addingChain = true; render(section, snapshot) } }).node,
        ]),
      )
    }
    const chainsDirty =
      sectionChanged(state.view.chains, state.baseView?.chains) ||
      sectionChanged(state.view.agents, state.baseView?.agents) ||
      state.view.default_chain !== state.baseView?.default_chain
    section.append(kitSection({ title: '路由链', hint: '从上往下试，失败换下一个', body: chainRows, headRight: dirtyHead(chainsDirty) }))
    section.append(renderTierMapping(section, snapshot))
    section.append(renderPolicy(section, snapshot))
    section.append(renderFree(section, snapshot))
    section.append(renderDiagnostics(section, snapshot))

    const live = el('div', { class: 'oc-sr', 'aria-live': 'polite', text: state.live })
    section.append(live)

    // 保存条：只在有改动 / 在飞 / 刚失败时出现。句柄存在 state.ui，markDirty 原地点亮不重绘。
    const needsBar = state.dirty || s.status === 'waiting' || s.status === 'failed' || s.status === 'timeout'
    const bar = el('div', { class: 'oc-savebar' })
    bar.hidden = !needsBar
    const saveBtn = button({
      label: '保存并应用',
      variant: 'default',
      size: 'sm',
      disabled: !state.dirty,
      loading: s.status === 'waiting',
      data: { 'data-act': 'save' },
      onClick: () => void save(snapshot, section),
    })
    bar.append(saveBtn.node)
    bar.append(
      button({
        label: '丢弃改动',
        variant: 'ghost',
        size: 'sm',
        disabled: !state.dirty,
        onClick: () => {
          state.dirty = false
          state.sourceSig = null
          state.notice = null
          state.selected = null
          state.picker = null
          state.save = { status: 'idle', at: null, error: null, planned: null }
          state.view = null
          state.baseView = null
          render(section, snapshot)
        },
      }).node,
    )
    const text =
      s.status === 'waiting'
        ? '已写入，等路由引擎热更（最多 5 秒）…'
        : s.status === 'failed'
          ? `没写成：${s.error}`
          : s.status === 'timeout'
            ? '写入后 30 秒没看到路由引擎确认 —— 看上面那条问题'
            : '保存后几秒内自动生效；只重写改过的节，注释原样保留'
    bar.append(el('span', { class: 'oc-micro oc-muted', text }))
    section.append(bar)
    state.ui = { badge: statusBadge, savebar: bar, saveBtn }
  }

  return {
    render,
    needsPoll: () => state.save.status === 'waiting' || state.dirty,
    isDirty: () => state.dirty,
    count: () => chainNames(state.view).length,
  }
}