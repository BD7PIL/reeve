// 预览专用的 SDK 替身：真包里除 `connectHost` 之外**全部原样转发**。
//
// 面板靠 `connectHost()` 拿宿主，而真宿主走 iframe 的 postMessage 握手 —— 本地预览没有宿主，
// 所以只换掉这一个函数，其余（`applyHostReady`、kit 的 mount*、GUEST_UI_LOOK_CSS）都是真的：
// **预览里看到的就是线上那一套渲染**。
//
// 文件读写走本地预览服务（`scripts/preview.mjs`）：读 = 真的读你机器上的
// 快照与 GATE 配置；写 = 默认只记在内存里（预览不该改你的配置），加 `--allow-write` 才真写。

export * from '../node_modules/@openchamber/sdk/dist/index.js'

const params = new URLSearchParams(location.search)

// 宿主主题：**逐字抄自 app 自己的主题定义**（`@openchamber/web` 里 `openchamber-light` / `openchamber-dark`）。
// 为什么必须抄：预览要是"另一个调色板"，看到的深浅就都不是宿主里的样子（上一版的深色就是这么错的）。
// 字段名是宿主发给 guest 的那一套（HostThemeTokens）；映射关系照抄宿主自己的组装处：
//   background=surface.background · elevated=surface.elevated · muted=surface.mutedForeground（注意是前景）
//   subtle=surface.subtle · mutedSurface=surface.muted · border/hover/selection/active=interactive.*
//   primary=primary.base · focus=interactive.focusRing · status.*=status.*
// 派生文字色（primaryText / *Text）宿主用 OKLab 对比度算过；预览用 color-mix 近似（只影响文字淡色，不影响底色与控件）。
const mix = (color, pct, bg) => `color-mix(in srgb, ${color} ${pct}%, ${bg})`

const OPENCHAMBER_LIGHT = {
  mode: 'light',
  tokens: {
    background: '#fdfcfa', elevated: '#f3f2f0', foreground: '#44443d', muted: '#696960', subtle: '#f0efec',
    border: '#e5e1debf', hover: '#0000000a', selection: '#a9998f2b', focus: '#b3501755', active: '#00000014',
    primary: '#b35017', mutedSurface: '#f7f6f4', elevatedForeground: '#44443d',
    selectionForeground: mix('#a9998f', 90, '#fdfcfa'), primaryForeground: '#ffffff',
    primaryText: mix('#b35017', 78, '#fdfcfa'),
    successText: mix('#517734', 85, '#fdfcfa'), warningText: mix('#886914', 85, '#fdfcfa'),
    errorText: mix('#b7493f', 84, '#fdfcfa'), infoText: mix('#2c6ebd', 85, '#fdfcfa'),
    success: '#517734', warning: '#886914', error: '#b7493f', info: '#2c6ebd',
    font: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    radius: '9px',
  },
}

const OPENCHAMBER_DARK = {
  mode: 'dark',
  tokens: {
    background: '#120f0e', elevated: '#1b1918', foreground: '#dbd7cc', muted: '#949187', subtle: '#171616',
    border: '#242323bf', hover: '#ffffff0f', selection: '#c8c6c52b', focus: '#da7c4755', active: '#ffffff1a',
    primary: '#da7c47', mutedSurface: '#0e0c0b', elevatedForeground: '#dbd7cc',
    selectionForeground: mix('#c8c6c5', 70, '#120f0e'), primaryForeground: '#ffffff',
    primaryText: mix('#da7c47', 70, '#120f0e'),
    successText: mix('#76ad4f', 80, '#120f0e'), warningText: mix('#c67f13', 80, '#120f0e'),
    errorText: mix('#da5b4a', 80, '#120f0e'), infoText: mix('#479fe6', 80, '#120f0e'),
    success: '#76ad4f', warning: '#c67f13', error: '#da5b4a', info: '#479fe6',
    font: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    radius: '9px',
  },
}

const theme = params.get('theme') === 'dark' ? OPENCHAMBER_DARK : OPENCHAMBER_LIGHT
const readyListeners = new Set()
const directoryListeners = new Set()
const sessionListeners = new Set()
const writes = []

const readyCtx = {
  theme,
  locale: 'zh-CN',
  directory: null,
  session: null,
  surface: 'panel',
  connection: { state: 'ready' },
  settings: {},
  item: null,
}

const err = (message, code) => Object.assign(new Error(message), { code })

const client = {
  onReady: (listener) => {
    readyListeners.add(listener)
    // 与真宿主一样：注册后**回放**一次 ready（面板靠它拿主题）
    queueMicrotask(() => listener(readyCtx))
    return () => readyListeners.delete(listener)
  },
  onDirectory: (listener) => {
    directoryListeners.add(listener)
    queueMicrotask(() => listener(null))
    return () => directoryListeners.delete(listener)
  },
  onSession: (listener) => {
    sessionListeners.add(listener)
    queueMicrotask(() => listener(null))
    return () => sessionListeners.delete(listener)
  },
  onConnection: () => () => {},
  onSettings: () => () => {},
  onItem: () => () => {},
  onProjects: async () => () => {},
  onWorktrees: async () => () => {},
  onSessions: async () => () => {},
  onRunningShells: async () => () => {},
  onSessionLifecycle: () => () => {},
  onStatusControl: () => () => {},
  onPopoverClosed: () => () => {},
  openSession: async (id) => {
    // 预览里没有会话可开：记一笔，页面上能证明按钮真的被点了
    console.log('[preview] openSession', id)
  },
  openUrl: async () => {},
  storage: {
    get: async () => undefined,
    set: async () => {},
    delete: async () => {},
    keys: async () => [],
  },
  readFile: async (path) => {
    const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw err(body.error ?? `读取失败（HTTP ${res.status}）`, body.code ?? (res.status === 403 ? 'NOT_GRANTED' : 'UNKNOWN'))
    }
    return res.json()
  },
  writeFile: async (path, content) => {
    const res = await fetch('/api/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, content }),
    })
    if (!res.ok) throw err(`写入失败（HTTP ${res.status}）`, 'UNKNOWN')
    const out = await res.json()
    writes.push({ path, bytes: content.length, applied: out.applied })
    return { written: true }
  },
}

export function connectHost() {
  return client
}

globalThis.__previewWrites = writes