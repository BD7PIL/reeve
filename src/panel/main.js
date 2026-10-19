// REEVE 编排面板 —— 只读。
//
// 它做两件事，都不写：
//   ① 会话树：宿主给的 listProjects → listSessions（用 parentId 成树）
//   ② 台账：读记账插件导出的**快照**文件（`~/.local/share/opencode/reeve/ledger.json`）
//
// 为什么台账要走文件：面板跑在沙箱 iframe 里（无网络、拿不到引擎的 SQLite），
// 而宿主给了 `readFile`（需 `contributes.filesystem` 声明 + 使用者批准）。
// 快照是**投影**：权威仍是插件的 ctx.storage，这里只读、绝不回写。
//
// 控制面不在这里 —— 派活 / 中断 / 改档位都在模型侧（foreman），面板只呈现。

import { connectHost } from '@openchamber/sdk'
import { applyHostReady, mountBadge, mountButton, mountList } from '@openchamber/sdk/ui'

/** 台账快照的候选位置（与 package.json 的 contributes.filesystem 一一对应）。 */
const SNAPSHOT_PATHS = [
  '~/.local/share/opencode/reeve/ledger.json',
  '~/.reeve-staging/.local/share/opencode/reeve/ledger.json',
]

const STATE_LABEL = {
  running: '运行中',
  completed: '已完成',
  error: '失败',
  stopped: '已停',
  reconciled: '已对账',
}
const STATE_TONE = {
  running: 'primary',
  completed: 'success',
  error: 'error',
  stopped: 'warning',
  reconciled: 'neutral',
}

const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else if (k.startsWith('data-')) node.setAttribute(k, v)
    else node[k] = v
  }
  for (const c of children) node.append(c)
  return node
}

const fmtClock = (ms) => {
  if (!ms) return '—'
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}
const fmtDur = (a, b) => {
  if (!a) return ''
  const ms = (b ?? Date.now()) - a
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** 会话树：宿主给的是扁平列表，靠 parentId 成树。 */
function buildTree(sessions) {
  const byId = new Map(sessions.map((s) => [s.id, { node: s, children: [] }]))
  const roots = []
  for (const entry of byId.values()) {
    const parentId = entry.node.parentId ?? null
    const parent = parentId ? byId.get(parentId) : null
    if (parent) parent.children.push(entry)
    else roots.push(entry)
  }
  return roots
}

function flatten(entries, depth = 0, out = []) {
  for (const e of entries) {
    out.push({ node: e.node, depth })
    flatten(e.children, depth + 1, out)
  }
  return out
}

function main() {
  const root = document.getElementById('root')
  const host = connectHost()
  let snapshotRead = false // 是否成功读到过快照

  host.onReady((ctx) => applyHostReady(ctx, document.documentElement))

  // ---- 骨架 ----
  const header = el('div', { class: 'rv-head' })
  const title = el('strong', { text: 'REEVE 编排' })
  const badgeHost = el('span')
  const push = el('span', { class: 'rv-push' })
  const refreshHost = el('span')
  const ledgerSection = el('div', { class: 'rv-section' })
  const treeSection = el('div', { class: 'rv-section' })
  header.append(title, badgeHost, push, refreshHost)
  root.append(header, ledgerSection, treeSection)

  const badge = mountBadge(badgeHost, { label: '读取中…', tone: 'neutral' })
  let busy = false
  const refreshBtn = mountButton(refreshHost, {
    label: '刷新',
    variant: 'ghost',
    size: 'sm',
    onClick: () => void refresh(),
  })

  // ---- 台账（只读文件）----
  // 逐个候选路径试，并把**每一次失败的原因**记下来 —— 面板宁可说清楚"为什么读不到"，
  // 也不要假装台账是空的（空台账与读不到是两件事）。
  async function readLedger() {
    const tried = []
    for (const path of SNAPSHOT_PATHS) {
      try {
        const res = await host.readFile(path)
        return { ok: true, doc: JSON.parse(res.content), path, tried }
      } catch (err) {
        const code = err?.code ?? err?.name ?? 'UNKNOWN'
        tried.push({ path, code, message: err instanceof Error ? err.message : String(err) })
        if (code === 'NOT_GRANTED' || code === 'BAD_PATH') return { ok: false, code, tried }
      }
    }
    return { ok: false, code: tried.at(-1)?.code ?? 'UNKNOWN', tried }
  }

  function renderLedger(result) {
    ledgerSection.replaceChildren()
    ledgerSection.append(el('div', { class: 'rv-sub', text: '台账（记账插件导出的快照）' }))

    if (!result.ok) {
      const denied = result.tried?.some((t) => t.code === 'NOT_GRANTED' || t.code === 'BAD_PATH')
      const why = denied
        ? '扩展的文件读取权限还没批准 —— 在 设置 → 扩展 里批准「文件系统」后点刷新。'
        : '还没读到台账快照。它由记账插件在 options.snapshotPath 指向的位置生成。请核对下面每一条的失败原因。'
      ledgerSection.append(el('div', { class: 'rv-empty', text: why }))
      const list = el('div', { class: 'rv-meta' })
      for (const t of result.tried ?? []) {
        list.append(el('div', { text: `${t.code} · ${t.path}` }))
      }
      ledgerSection.append(list)
      treeSection.dataset.ledger = 'absent'
      return
    }

    const doc = result.doc
    const c = doc.counts ?? {}
    const running = doc.tasks.filter((t) => t.state === 'running')
    ledgerSection.append(
      el('div', { class: 'rv-meta', text: `${doc.tasks.length} 条记录 · ${running.length} 在飞 · 生成于 ${fmtClock(doc.generatedAt)}（${result.path}）` }),
    )

    const items = doc.tasks.map((t) => {
      const flags = []
      if (t.timedOut) flags.push('超时')
      if (t.statusUncertain) flags.push('状态不确定')
      if (t.background) flags.push('后台')
      return {
        id: t.taskID,
        title: t.description || t.agent || t.taskID,
        subtitle: [t.agent ?? '?', flags.join('/'), t.childSessionID ?? ''].filter(Boolean).join(' · '),
        leading: STATE_LABEL[t.state] ?? t.state ?? '?',
        meta: t.endedAt ? fmtDur(t.startedAt, t.endedAt) : fmtDur(t.startedAt),
        badge: { label: STATE_LABEL[t.state] ?? t.state ?? '?', tone: STATE_TONE[t.state] ?? 'neutral' },
      }
    })

    const listHost = el('div')
    mountList(listHost, {
      items,
      onSelect: (id) => {
        const task = doc.tasks.find((t) => t.taskID === id)
        if (task?.childSessionID) void host.openSession(task.childSessionID)
      },
      emptyText: '台账是空的 —— 还没有派过子任务。',
      ariaLabel: 'REEVE 台账',
    })
    ledgerSection.append(listHost)
    treeSection.dataset.ledger = 'present'
  }

  // ---- 会话树（宿主给的）----
  async function renderTree(directory) {
    treeSection.replaceChildren()
    treeSection.append(el('div', { class: 'rv-sub', text: '会话树（openchamber）' }))
    let projects
    try {
      projects = await host.listProjects()
    } catch (err) {
      treeSection.append(el('div', { class: 'rv-empty', text: `读不到项目：${err instanceof Error ? err.message : String(err)}` }))
      return
    }
    const all = projects.projects ?? []
    // 优先用宿主报告"当前正打开"的那个项目；否则退回第一个。
    const project = all.find((p) => p.directory === directory) ?? all[0]
    if (!project) {
      treeSection.append(
        el('div', {
          class: 'rv-empty',
          text: `先在 openchamber 里打开一个项目（宿主当前注册的项目数：${all.length}）。`,
        }),
      )
      return
    }
    let snap
    try {
      snap = await host.listSessions(project.id)
    } catch (err) {
      treeSection.append(el('div', { class: 'rv-empty', text: `读不到会话：${err instanceof Error ? err.message : String(err)}` }))
      return
    }
    const rows = flatten(buildTree(snap.sessions ?? []))
    const subs = rows.length - buildTree(snap.sessions ?? []).length
    const listHost = el('div')
    mountList(listHost, {
      items: rows.map(({ node, depth }) => ({
        id: node.id,
        leading: ' '.repeat(depth * 2) + (depth > 0 ? '└ ' : ''),
        title: node.title || node.id,
        subtitle: node.parentId ? `子会话（parentId ${node.parentId}）` : '',
        meta: node.activity ?? '',
        badge: node.outcome === 'failed'
          ? { label: '失败', tone: 'error' }
          : node.outcome === 'completed'
            ? { label: '已完成', tone: 'success' }
            : node.activity === 'running'
              ? { label: '运行中', tone: 'primary' }
              : undefined,
      })),
      onSelect: (id) => void host.openSession(id),
      emptyText: '本项目暂无会话。',
      ariaLabel: 'REEVE 会话树',
    })
    treeSection.append(listHost)
    if (subs > 0) {
      const h = treeSection.querySelector('.rv-sub')
      if (h) h.textContent = `会话树（openchamber）· ${subs} 个子会话`
    }
  }

  async function refresh() {
    if (busy) return
    busy = true
    refreshBtn.update({ label: '读取中…', loading: true })
    try {
      const ledger = await readLedger()
      snapshotRead = ledger.ok
      renderLedger(ledger)
      const dir =
        currentDir ??
        (await host
          .listProjects()
          .then((p) => p.projects?.[0]?.directory ?? null)
          .catch(() => null))
      await renderTree(dir)
      badge.update(
        ledger.ok
          ? { label: `${ledger.doc.counts.running} 在飞 / ${ledger.doc.counts.total} 总`, tone: 'primary' }
          : { label: '台账未就绪', tone: 'warning' },
      )
    } finally {
      busy = false
      refreshBtn.update({ label: '刷新', loading: false })
    }
  }

  // 宿主报告"当前目录"时用它 —— 比猜第一个项目准。
  let currentDir = null
  host.onReady((ctx) => {
    currentDir = ctx.directory ?? null
  })

  // 项目切换会换一套会话 —— 跟着走，不要在旧项目上冻住。
  host.onDirectory((directory) => {
    currentDir = directory ?? null
    void refresh()
  })
  host.onSession(() => void refresh())

  void refresh()
  // 台账由插件在变更时重写；面板按需刷新（读文件很便宜，但没必要轮询）。
  // 会话事件到达时顺带刷一次，足够跟上一次编排。
  if (!snapshotRead) setTimeout(() => void refresh(), 3000)
}

try {
  main()
} catch (err) {
  const root = document.getElementById('root')
  if (root) {
    root.replaceChildren(
      el('div', { class: 'rv-empty', text: `面板未能启动：${err instanceof Error ? err.message : String(err)}` }),
    )
  }
}