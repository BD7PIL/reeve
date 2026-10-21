// 链 tab：GATE 配置的可视化编辑 —— 每条链的候选顺序（↑↓ · 换 · 增删）、agent → 链 的映射、策略。
//
// 它写什么：**只写 GATE 的 fallback 配置**（`~/.config/opencode/reeve/fallback.jsonc`，
// 路径取自快照的 `gate.from`）。写的是宿主给的原子写（temp + rename），所以 GATE 那边
// 永远看不到半截 JSON —— GATE 还专门把"读不动的配置"当作"未变更"（保留上一份好的），两道保险。
//
// 为什么保存要"只改该改的节"：这份文件是**共享配置**，里面有使用者手写的注释与排版。
// 整份重新序列化会把它们冲掉；`fallback-edit.js` 做的是小节的文本级替换（有单测钉着）。
//
// 生效链路：保存 → GATE 每 1 秒 stat 一次配置（≤5s 内热更）→ 快照的 `gate.chains/agents/...` 变化
// → 本面板轮询快照看到它变 → 显示"已生效"。界面上那句"等待生效"就是这么等的。

import { mountButton, mountCheckbox, mountSelect, mountTextField } from '@openchamber/sdk/ui'

import { agentsForChain, applySave, parseJsonc, planSave, viewOf } from './fallback-edit.js'
import { el, fallbackConfigPathFor, fmtAgo, fmtClock, readGateConfig, shortPath } from './util.js'

const clone = (v) => JSON.parse(JSON.stringify(v ?? {}))
const sortedChains = (view) => Object.keys(view?.chains ?? {})

export function createChainTab({ host, onNeedPoll }) {
  const state = {
    view: null,
    text: null,
    path: null,
    sourceSig: null,
    loadError: null,
    loadTried: [],
    dirty: false,
    notice: null,
    picker: null, // { chain, replaceIndex|null }
    manual: '',
    pick: null,
    newChainName: '',
    addingChain: false,
    save: { status: 'idle', at: null, error: null, planned: null },
  }

  const chainNames = () => sortedChains(state.view)

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
      const parsed = parseJsonc(res.content)
      view = viewOf(parsed).view
    } catch (err) {
      state.loadError = `配置解析失败：${String(err?.message ?? err)}`
      state.loadTried = res.tried
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
      state.text = res.content
      state.sourceSig = sig
      if (force) state.dirty = false
    }
  }

  function mutate(fn, section, snapshot) {
    fn()
    state.dirty = true
    render(section, snapshot)
    onNeedPoll?.()
  }

  // ---- 编辑动作 ----

  function moveTarget(chain, index, delta, section, snapshot) {
    const targets = [...(state.view.chains[chain]?.targets ?? [])]
    const to = index + delta
    if (to < 0 || to >= targets.length) return
    ;[targets[index], targets[to]] = [targets[to], targets[index]]
    mutate(() => {
      state.view.chains[chain] = { targets }
    }, section, snapshot)
  }

  function removeTarget(chain, index, section, snapshot) {
    const targets = [...(state.view.chains[chain]?.targets ?? [])]
    targets.splice(index, 1)
    mutate(() => {
      state.view.chains[chain] = { targets }
    }, section, snapshot)
  }

  function placeTarget(chain, ref, replaceIndex, section, snapshot) {
    const r = String(ref ?? '').trim()
    if (!r.includes('/')) {
      state.notice = `认不出的候选：${ref}（要写成 provider/model）`
      render(section, snapshot)
      return
    }
    const targets = [...(state.view.chains[chain]?.targets ?? [])]
    if (replaceIndex != null) targets[replaceIndex] = r
    else targets.push(r)
    mutate(() => {
      state.view.chains[chain] = { targets }
      state.picker = null
      state.manual = ''
      state.pick = null
      state.notice = null
    }, section, snapshot)
  }

  function addChain(name, section, snapshot) {
    const n = String(name ?? '').trim()
    if (!n || !/^[\w.-]+$/.test(n)) {
      state.notice = '链名用字母/数字/. _ -（要能出现在配置的键里）'
      render(section, snapshot)
      return
    }
    if (state.view.chains[n]) {
      state.notice = `链 ${n} 已经存在`
      render(section, snapshot)
      return
    }
    mutate(() => {
      state.view.chains[n] = { targets: [] }
      state.addingChain = false
      state.newChainName = ''
      state.notice = null
    }, section, snapshot)
  }

  function removeChain(chain, section, snapshot) {
    const users = agentsForChain(state.view, chain)
    if (users.length > 0) {
      state.notice = `链 ${chain} 还有 agent 在用（${users.join(', ')}）—— 先把它们挪走`
      render(section, snapshot)
      return
    }
    mutate(() => {
      delete state.view.chains[chain]
      if (state.view.default_chain === chain) state.view.default_chain = null
      for (const [m, c] of Object.entries(state.view.chain_for_model)) if (c === chain) delete state.view.chain_for_model[m]
    }, section, snapshot)
  }

  function setAgentChain(agent, chain, section, snapshot) {
    mutate(() => {
      if (chain) state.view.agents[agent] = chain
      else delete state.view.agents[agent]
    }, section, snapshot)
  }

  function setPolicy(key, value, section, snapshot) {
    mutate(() => {
      state.view.policy = { ...state.view.policy, [key]: value }
    }, section, snapshot)
  }

  // ---- 保存 ----

  async function save(snapshot, section) {
    const planned = planSave(state.view)
    if (planned.problems.length) {
      state.notice = `有 ${planned.problems.length} 个问题要先改：${planned.problems[0]}${planned.problems.length > 1 ? ' …' : ''}`
      state.save = { status: 'failed', at: Date.now(), error: state.notice, planned: null }
      render(section, snapshot)
      return
    }
    try {
      const base = state.text ?? ''
      const { text } = applySave(base, planned)
      const res = await host.writeFile(fallbackConfigPathFor(snapshot), text)
      if (res && res.written === false) throw new Error('宿主没有确认写入')
      state.dirty = false
      state.notice = null
      state.save = { status: 'waiting', at: Date.now(), error: null, planned }
      onNeedPoll?.()
      // 读回：源文本换了（注释仍是用户的那份）
      await load({ ...snapshot, gate: { ...(snapshot?.gate ?? {}), from: state.path } }, { force: true })
    } catch (err) {
      state.save = { status: 'failed', at: Date.now(), error: err instanceof Error ? err.message : String(err), planned: null }
      state.notice = `写入失败：${state.save.error}`
    }
    render(section, snapshot)
  }

  /** 保存状态机：快照里的 gate 段真的变成我们写的那份 → 已生效。 */
  function syncSave(snapshot) {
    const s = state.save
    if (s.status !== 'waiting' || !s.planned) return
    const g = snapshot?.gate
    if (!g || g.error) {
      if (Date.now() - s.at > 30_000) s.status = 'timeout'
      return
    }
    const same =
      JSON.stringify([...g.chains].sort()) === JSON.stringify(Object.keys(s.planned.chains).sort()) &&
      JSON.stringify(g.agents ?? {}) === JSON.stringify(s.planned.agents) &&
      JSON.stringify(g.default_chain ?? null) === JSON.stringify(s.planned.default_chain ?? null)
    if (same) {
      s.status = 'applied'
      return
    }
    if (Date.now() - s.at > 30_000) s.status = 'timeout'
  }

  // ---- 渲染 ----

  function renderTargetRow(chain, ref, index, total, section) {
    const parts = String(ref).split('/')
    const provider = parts[0]
    const model = parts.slice(1).join('/')
    const line = el('div', {
      class: 'rv-row',
      'data-chain': chain,
      'data-index': String(index),
      'data-ref': ref,
    })
    line.append(el('span', { class: index === 0 ? 'rv-row-idx rv-row-idx-first' : 'rv-row-idx', text: index === 0 ? '首选' : String(index + 1) }))
    line.append(el('code', { class: 'rv-ref', text: model }))
    line.append(el('span', { class: 'rv-row-note', text: provider }))
    line.append(el('span', { class: 'rv-grow' }))
    const btns = el('span', { class: 'rv-row-btns' })
    const mk = (act, label, title, disabled, onClick) => {
      const h = el('span', { 'data-act': act })
      mountButton(h, { label, variant: 'ghost', size: 'xs', disabled, onClick })
      const btn = h.querySelector('button')
      if (btn) {
        btn.setAttribute('title', title)
        btn.setAttribute('data-act', act)
      }
      btns.append(h)
    }
    mk('up', '↑', '上去一位', index === 0, () => moveTarget(chain, index, -1, section, section.__snapshot))
    mk('down', '↓', '下去一位', index === total - 1, () => moveTarget(chain, index, +1, section, section.__snapshot))
    mk('swap', '换', '换这个模型', false, () => {
      state.picker = { chain, replaceIndex: index }
      state.manual = ''
      state.pick = null
      state.notice = null
      render(section, section.__snapshot)
    })
    mk('remove', '×', '删掉这一行', false, () => removeTarget(chain, index, section, section.__snapshot))
    line.append(btns)
    return line
  }

  function renderPicker(chain, snapshot, section) {
    const used = new Set(state.view.chains[chain]?.targets ?? [])
    const wrap = el('div', { class: 'rv-picker' })
    const selectHost = el('span', { class: 'rv-picker-select', 'data-act': 'pick' })
    const options = (snapshot?.models?.candidates ?? [])
      .filter((c) => !used.has(c.ref))
      .map((c) => ({ id: c.ref, label: c.ref, hint: c.sources?.includes('gate') ? 'GATE 目录' : '链上/引擎' }))
    mountSelect(selectHost, {
      value: state.pick,
      options,
      searchable: true,
      placeholder: options.length ? '从候选里选…' : '（候选列表为空，用右边手填）',
      onChange: (id) => {
        state.pick = id
        placeTarget(chain, id, state.picker?.replaceIndex ?? null, section, snapshot)
      },
    })
    wrap.append(selectHost)
    const fieldHost = el('span', { class: 'rv-picker-field', 'data-act': 'manual' })
    const addHost = el('span', { 'data-act': 'add-manual' })
    const addBtn = mountButton(addHost, {
      label: '加入',
      variant: 'secondary',
      size: 'sm',
      disabled: !state.manual.includes('/'),
      onClick: () => placeTarget(chain, state.manual.trim(), state.picker?.replaceIndex ?? null, section, snapshot),
    })
    mountTextField(fieldHost, {
      value: state.manual,
      placeholder: 'provider/model（模型名可带 /）',
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
        state.picker = null
        state.manual = ''
        state.pick = null
        render(section, section.__snapshot)
      },
    })
    wrap.append(cancelHost)
    wrap.append(el('div', { class: 'rv-picker-hint', text: `候选来自 GATE 的 /v1/models（声明 ∪ 免费池 ∪ 链上在用 ∪ 引擎档位，共 ${(snapshot?.models?.candidates ?? []).length} 个）` }))
    return wrap
  }

  function renderChain(chain, snapshot, section) {
    const targets = state.view.chains[chain]?.targets ?? []
    const block = el('div', { class: 'rv-tier', 'data-chain': chain })
    const head = el('div', { class: 'rv-tier-head' })
    head.append(el('span', { class: 'rv-tier-name', text: chain }))
    const users = agentsForChain(state.view, chain)
    if (users.length) head.append(el('span', { class: 'rv-tier-hint', text: `agent：${users.join(' / ')}` }))
    if (state.view.default_chain === chain) head.append(el('span', { class: 'rv-chip', text: '默认链' }))
    head.append(el('span', { class: 'rv-grow' }))
    head.append(el('span', { class: 'rv-tier-count', text: `${targets.length} 个候选` }))
    const setDefaultHost = el('span', { 'data-act': 'set-default' })
    mountButton(setDefaultHost, {
      label: '设为默认',
      variant: 'ghost',
      size: 'xs',
      disabled: state.view.default_chain === chain,
      onClick: () => mutate(() => { state.view.default_chain = chain }, section, section.__snapshot),
    })
    head.append(setDefaultHost)
    const delHost = el('span', { 'data-act': 'delete-chain' })
    mountButton(delHost, {
      label: '删链',
      variant: 'ghost',
      size: 'xs',
      disabled: users.length > 0 || chainNames().length <= 1,
      onClick: () => removeChain(chain, section, section.__snapshot),
    })
    head.append(delHost)
    block.append(head)

    if (targets.length === 0) block.append(el('div', { class: 'rv-empty-sm', text: '这条链还没有候选 —— 加一个；空链在保存时会被拦下。' }))
    targets.forEach((ref, i) => block.append(renderTargetRow(chain, ref, i, targets.length, section)))

    if (state.picker?.chain === chain) {
      block.append(renderPicker(chain, snapshot, section))
    } else {
      const addHost = el('span', { 'data-act': 'add' })
      mountButton(addHost, {
        label: state.picker?.replaceIndex != null ? '＋ 加候选' : '＋ 加候选',
        variant: 'ghost',
        size: 'sm',
        onClick: () => {
          state.picker = { chain, replaceIndex: null }
          state.manual = ''
          state.pick = null
          render(section, snapshot)
        },
      })
      block.append(el('div', { class: 'rv-row-add', 'data-chain': chain }, [addHost]))
    }
    return block
  }

  function renderAgents(section, snapshot) {
    section.append(el('div', { class: 'rv-sub', text: 'agent → 链（谁走哪条链）' }))
    const agents = Object.keys(state.view.agents).sort()
    if (agents.length === 0) {
      section.append(el('div', { class: 'rv-empty-sm', text: '还没有 agent 映射 —— 没映射的 agent 按主模型找链（chain_for_model）或走默认链。' }))
    }
    for (const agent of agents) {
      const row = el('div', { class: 'rv-line rv-agent-row', 'data-agent': agent })
      row.append(el('span', { class: 'rv-line-name', text: agent, title: agent }))
      const host = el('span', { class: 'rv-picker-select', 'data-act': 'agent-chain' })
      mountSelect(host, {
        value: state.view.agents[agent] ?? null,
        options: [{ id: '__none__', label: '（不映射）' }, ...chainNames().map((c) => ({ id: c, label: c }))],
        onChange: (id) => setAgentChain(agent, id === '__none__' ? null : id, section, section.__snapshot),
      })
      row.append(host)
      const delHost = el('span', { 'data-act': 'remove-agent' })
      mountButton(delHost, {
        label: '×',
        variant: 'ghost',
        size: 'xs',
        title: '不映射（按主模型找链）',
        onClick: () => setAgentChain(agent, null, section, section.__snapshot),
      })
      row.append(delHost)
      section.append(row)
    }
    // 新映射：从快照的 agent 表里挑还没映射的
    const known = (snapshot?.agentTable?.visible ?? []).map((a) => a.id)
    const missing = [...new Set([...known, 'scout', 'librarian', 'planner', 'advisor', 'critic', 'foreman', 'executor', 'reviewer'])].filter((a) => !state.view.agents[a])
    if (missing.length) {
      const row = el('div', { class: 'rv-row-add' })
      const host = el('span', { class: 'rv-picker-select', 'data-act': 'add-agent' })
      mountSelect(host, {
        value: null,
        options: missing.map((a) => ({ id: a, label: a })),
        searchable: true,
        placeholder: '＋ 给某个 agent 指定链…',
        onChange: (id) => setAgentChain(id, chainNames()[0] ?? null, section, section.__snapshot),
      })
      row.append(host)
      section.append(row)
    }
  }

  function renderPolicy(section) {
    section.append(el('div', { class: 'rv-sub', text: '策略' }))
    const p = state.view.policy ?? {}
    const grid = el('div', { class: 'rv-stats' })
    const numField = (label, key, value, hint) => {
      const box = el('div', { class: 'rv-stat' })
      box.append(el('div', { class: 'rv-stat-label', text: label }))
      const host = el('span', { 'data-policy': key })
      mountTextField(host, {
        value: value == null ? '' : String(value),
        placeholder: hint,
        mono: true,
        onChange: (v) => {
          state.view.policy = { ...state.view.policy, [key]: v === '' ? null : Number(v) }
          state.dirty = true
          onNeedPoll?.()
        },
      })
      box.append(host)
      return box
    }
    grid.append(numField('最多尝试候选数', 'max_fallback_attempts', p.max_fallback_attempts, '3'))
    grid.append(numField('冷却秒数', 'cooldown_seconds', p.cooldown_seconds, '60'))
    grid.append(numField('provider 内重试', 'provider_retries', p.provider_retries, '1'))
    const swBox = el('div', { class: 'rv-stat' })
    swBox.append(el('div', { class: 'rv-stat-label', text: '冷却后恢复首选' }))
    const swHost = el('span', { 'data-policy': 'restore_primary_after_cooldown' })
    mountCheckbox(swHost, {
      label: '',
      checked: p.restore_primary_after_cooldown === true,
      description: '默认关：失败换人后粘住，不自动回到首选',
      onChange: (checked) => {
        state.view.policy = { ...state.view.policy, restore_primary_after_cooldown: checked }
        state.dirty = true
        onNeedPoll?.()
      },
    })
    swBox.append(swHost)
    grid.append(swBox)
    section.append(grid)
  }

  function render(section, snapshot) {
    if (!section) return
    section.__snapshot = snapshot
    if (state.view === null && !state.loadError) {
      void load(snapshot).then(() => render(section, snapshot))
      section.replaceChildren(el('div', { class: 'rv-meta', text: '正在读 GATE 配置…' }))
      return
    }
    syncSave(snapshot)
    section.replaceChildren()

    const path = state.path ?? fallbackConfigPathFor(snapshot)
    const gate = snapshot?.gate ?? null
    const meta = el('div', { class: 'rv-meta' })
    meta.append(el('div', { text: `GATE 配置：${shortPath(path)}${gate?.port ? ` · 运行中 :${gate.port}` : ''}` }))
    if (gate?.error) meta.append(el('div', { text: `⚠️ GATE 没起来：${gate.error}` }))
    if (gate?.problems?.length) meta.append(el('div', { text: `⚠️ 配置加载有 ${gate.problems.length} 个问题：${gate.problems.slice(0, 2).join('；')}${gate.problems.length > 2 ? ' …' : ''}` }))
    if (gate?.sessions) meta.append(el('div', { text: `会话状态：${gate.sessions.sessions} 条（冷却中 ${gate.sessions.cooling}）` }))
    section.append(meta)

    if (state.loadError) {
      section.append(el('div', { class: 'rv-warn', text: `读不到 GATE 配置（${state.loadError}）：${state.loadTried.map((t) => `${t.path} → ${t.code}`).join('；')}` }))
      return
    }
    if (state.notice) section.append(el('div', { class: 'rv-warn', text: state.notice }))

    section.append(el('div', { class: 'rv-sub', text: '链（顺序 = 先试谁、失败顺位往下）' }))
    for (const chain of chainNames()) section.append(renderChain(chain, snapshot, section))
    if (state.addingChain) {
      const row = el('div', { class: 'rv-row-add' })
      const host = el('span', { class: 'rv-picker-field', 'data-act': 'new-chain' })
      const okHost = el('span', { 'data-act': 'create-chain' })
      const okBtn = mountButton(okHost, {
        label: '建链',
        variant: 'secondary',
        size: 'sm',
        disabled: !state.newChainName.trim(),
        onClick: () => addChain(state.newChainName, section, section.__snapshot),
      })
      mountTextField(host, {
        value: state.newChainName,
        placeholder: '链名（如 free-first）',
        mono: true,
        onChange: (v) => {
          state.newChainName = v
          okBtn.update({ disabled: !v.trim() })
        },
      })
      const cancelHost = el('span', { 'data-act': 'cancel-new-chain' })
      mountButton(cancelHost, {
        label: '取消',
        variant: 'ghost',
        size: 'sm',
        onClick: () => {
          state.addingChain = false
          state.newChainName = ''
          render(section, section.__snapshot)
        },
      })
      row.append(host, okHost, cancelHost)
      section.append(row)
    } else {
      const addHost = el('span', { 'data-act': 'add-chain' })
      mountButton(addHost, {
        label: '＋ 新增链',
        variant: 'ghost',
        size: 'sm',
        onClick: () => {
          state.addingChain = true
          render(section, snapshot)
        },
      })
      section.append(el('div', { class: 'rv-row-add' }, [addHost]))
    }

    section.append(el('div', { class: 'rv-divider' }))
    renderAgents(section, snapshot)
    section.append(el('div', { class: 'rv-divider' }))
    renderPolicy(section)

    // 保存条
    const bar = el('div', { class: 'rv-savebar' })
    const saveHost = el('span', { 'data-act': 'save' })
    mountButton(saveHost, {
      label: '保存并生效',
      variant: 'default',
      size: 'sm',
      disabled: !state.dirty,
      loading: state.save.status === 'waiting',
      onClick: () => void save(snapshot, section),
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
        state.save = { status: 'idle', at: null, error: null, planned: null }
        state.view = null
        render(section, snapshot)
      },
    })
    bar.append(resetHost)
    const s = state.save
    const status = state.dirty
      ? '有未保存的改动（保存只重写被改的几节，其它注释与排版原样保留）'
      : s.status === 'waiting'
        ? '已写入，等待 GATE 热更（最多 5 秒一轮）…'
        : s.status === 'applied'
          ? `已生效 ${fmtClock(s.at)}（${fmtAgo(s.at)}）`
          : s.status === 'timeout'
            ? '写入后 30 秒还没看到 GATE 的运行时确认 —— 看上面那行的 problems'
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
    /** 给 main.js 的 tab 计数用（链数）。 */
    count: () => chainNames().length,
  }
}