// 面板共用的小工具：DOM 构造、格式化、快照读取。
//
// 只放**纯**东西（无宿主依赖除 readFile 外）—— 三个 tab 都从这里拿同一套格式化，
// 免得"延迟"在统计 tab 显示成 4.0s、在台账 tab 显示成 4000。

export const el = (tag, props = {}, children = []) => {
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

export const fmtClock = (ms) => {
  if (!ms) return '—'
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

export const fmtDur = (a, b) => {
  if (!a) return ''
  const ms = (b ?? Date.now()) - a
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** 毫秒数 → `820ms` / `4.0s` / `1.2m`。null/undefined → `—`（"没有数据"与"0"是两件事）。 */
export const fmtMs = (value) => {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  const ms = Number(value)
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

/** 相对时间：`3 分钟前`。快照是文件，读它的人需要知道"这是多久以前的数"。 */
export const fmtAgo = (ms, now = Date.now()) => {
  if (!ms) return '—'
  const d = Math.max(0, now - ms)
  if (d < 60_000) return `${Math.round(d / 1000)} 秒前`
  if (d < 3600_000) return `${Math.round(d / 60_000)} 分钟前`
  if (d < 86400_000) return `${(d / 3600_000).toFixed(1)} 小时前`
  return `${(d / 86400_000).toFixed(1)} 天前`
}

/** 台账快照的候选位置（与 package.json 的 contributes.filesystem 一一对应）。 */
export const SNAPSHOT_PATHS = [
  '~/.reeve/ledger.json',
  '~/.local/share/opencode/reeve/ledger.json',
  '~/.reeve-staging/.reeve/ledger.json',
  '~/.reeve-staging/.local/share/opencode/reeve/ledger.json',
]

/**
 * 读快照：逐个候选路径试，并把**每一次失败的原因**记下来。
 * 面板宁可说清楚"为什么读不到"，也不要假装台账是空的（空台账与读不到是两件事）。
 */
export async function readSnapshot(host) {
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

export const STATE_LABEL = {
  running: '运行中',
  completed: '已完成',
  error: '失败',
  stopped: '已停',
  reconciled: '已对账',
}
export const STATE_TONE = {
  running: 'primary',
  completed: 'success',
  error: 'error',
  stopped: 'warning',
  reconciled: 'neutral',
}

export const TIER_ORDER = ['flash', 'pro', 'multimodal']
export const TIER_LABEL = { flash: '便宜档', pro: '强推理档', multimodal: '多模态档' }
export const TIER_HINT = {
  flash: '探索 / 检索 / 照文档干活',
  pro: '编排 / 规划 / 评审 / 审查',
  multimodal: '需要读图 / 读 PDF 的调用',
}

/** 每档一行的颜色：与宿主 token 对齐（不引新色）。 */
export const TIER_TONE = { flash: 'info', pro: 'primary', multimodal: 'success' }

/** 延迟条的宽度百分比（相对本组最大值；0 也算一条细线）。 */
export const barWidth = (value, max) => {
  if (!Number.isFinite(Number(value)) || !Number.isFinite(Number(max)) || max <= 0) return '0%'
  return `${Math.max(4, Math.round((Number(value) / Number(max)) * 100))}%`
}

/**
 * 面板唯一会写的那一个文件：REEVE 自己的链配置。
 *
 * 路径**取自快照**（插件正在读的那份，可以被 options.chainFilePath 改；EL7 staging 上
 * 引擎的 HOME 与 openchamber 的 HOME 不同，两边必须指同一个文件）。快照里没有才退回默认。
 * 守门（check.mjs）就盯这一条：源码里每个 `writeFile(` 的第一个实参都必须是本次调用。
 */
export function chainPathFor(snapshot) {
  const p = snapshot?.chain?.tiersPath
  if (typeof p === 'string' && (p.startsWith('/') || p.startsWith('~/'))) return p
  return '~/.reeve/chain.json'
}

/** 把 home 那一段缩成 `~`：面板里同时出现绝对路径与 `~/` 写法会让人以为是两个文件。 */
export const shortPath = (p) =>
  String(p ?? '')
    .replace(/^\/(?:home|Users)\/[^/]+/, '~')
    .replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~')