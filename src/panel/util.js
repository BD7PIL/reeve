// 面板共用的小工具：DOM 构造、格式化、快照读取。
//
// 只放**纯**东西（无宿主依赖除 readFile 外—— 三个 tab 都从这里拿同一套格式化，
// 免得"延迟"在统计 tab 显示成 4.0s、在台账 tab 显示成 4000。

import { t } from './i18n.js'

export const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    // 带 `-` 的键（data-* / aria-*必须写成**属性**：`node['aria-live'] = x` 只是加了个 JS 属性，
    // DOM 上没有它 —— 读屏与 querySelector 都看不见（踩过：播报区"存在"却查不到。
    // `tabindex` 同理：属性名是小写，JS 属性叫 tabIndex —— 写 tabindex 只Fix setAttribute 会生效。
    else if (k.includes('-')) node.setAttribute(k, v)
    // `tabindex` 单说：属性名小写、JS 属性叫 tabIndex —— 直接写 k 只有当 k 正好是 'tabindex' 才对
    else if (k === 'tabIndex' || k === 'tabindex') node.setAttribute('tabindex', v)
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

/** 毫秒数 → `820ms` / `4.0s` / `1.2m`。null/undefined → `—`（"没有数据"与"0"是两件事。 */
export const fmtMs = (value) => {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  const ms = Number(value)
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

/** 相对时间：`3m ago` / `3 分钟前`。快照是文件，读它的人需要知道"这是多久以前的数"。 */
export const fmtAgo = (ms, now = Date.now()) => {
  if (!ms) return '—'
  const d = Math.max(0, now - ms)
  if (d < 60_000) return t('ago.seconds', { n: Math.round(d / 1000) })
  if (d < 3600_000) return t('ago.minutes', { n: Math.round(d / 60_000) })
  if (d < 86400_000) return t('ago.hours', { n: (d / 3600_000).toFixed(1) })
  return t('ago.days', { n: (d / 86400_000).toFixed(1) })
}

/** 台账快照的候选位置（与 package.json 的 contributes.filesystem 一一对应。 */
export const SNAPSHOT_PATHS = [
  '~/.reeve/ledger.json',
  '~/.local/share/opencode/reeve/ledger.json',
  '~/.reeve-staging/.reeve/ledger.json',
  '~/.reeve-staging/.local/share/opencode/reeve/ledger.json',
]

/**
 * 读快照：逐个候选路径试，并把**每一次error的原因**记下来。
 * 面板宁可说清楚"为什么读不到"，也不要假装台账是空的（空台账与读不到是两件事。
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

export const stateLabel = (state) => {
  const key = `state.${String(state ?? '')}`
  const text = t(key)
  return text === key ? String(state ?? '?') : text
}
export const STATE_TONE = {
  running: 'primary',
  completed: 'success',
  error: 'error',
  stopped: 'warning',
  reconciled: 'neutral',
}

/** 延迟条的宽度百分比（相对本组最大值；0 也算一条细线。 */
export const barWidth = (value, max) => {
  if (!Number.isFinite(Number(value)) || !Number.isFinite(Number(max)) || max <= 0) return '0%'
  return `${Math.max(4, Math.round((Number(value) / Number(max)) * 100))}%`
}

/** GATE 的配置候选位置（与 package.json 的 contributes.filesystem 一一对应。 */
export const GATE_CONFIG_PATHS = [
  '~/.config/opencode/reeve/fallback.jsonc',
  '~/.reeve-staging/.config/opencode/reeve/fallback.jsonc',
]

/**
 * 面板唯一会写的那个文件：GATE 的 fallback 配置（链 / agent 映射 / 策略。
 *
 * 路径**取自快照**（`gate.from` 就是 GATE 正在读的那份；可以被 options.gate.configPath 改——
 * 面板写错文件会表现成"保存了但Not applied"。快照里没有才退回候选里的第一份。
 * 守门（check.mjs就盯这一条：源码里每个 `writeFile(` 的第一个实参都必须是本次调用。
 */
export function fallbackConfigPathFor(snapshot) {
  const p = snapshot?.gate?.from
  if (typeof p === 'string' && (p.startsWith('/') || p.startsWith('~/'))) return p
  return GATE_CONFIG_PATHS[0]
}

/** 读 GATE 的Config file（返回文本；读不到就报出原因，让面板显示"为什么"。 */
export async function readGateConfig(host, snapshot) {
  const preferred = fallbackConfigPathFor(snapshot)
  const paths = [preferred, ...GATE_CONFIG_PATHS.filter((p) => p !== preferred)]
  const tried = []
  for (const path of paths) {
    try {
      const res = await host.readFile(path)
      return { ok: true, path, content: String(res?.content ?? ''), tried }
    } catch (err) {
      const code = err?.code ?? err?.name ?? 'UNKNOWN'
      tried.push({ path, code, message: err instanceof Error ? err.message : String(err) })
      if (code === 'NOT_GRANTED' || code === 'BAD_PATH') return { ok: false, code, path, tried }
    }
  }
  return { ok: false, code: tried.at(-1)?.code ?? 'UNKNOWN', path: preferred, tried }
}

/** 把 home 那一段缩成 `~`：面板里同时出现绝对路径与 `~/` 写法会让人以为是两个文件。 */
export const shortPath = (p) =>
  String(p ?? '')
    .replace(/^\/(?:home|Users)\/[^/]+/, '~')
    .replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~')