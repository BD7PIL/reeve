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

const LIGHT = {
  mode: 'light',
  tokens: {
    background: '#ffffff', elevated: '#ffffff', foreground: '#1b1b1f', muted: '#6a6a74',
    subtle: '#ececef', border: '#e2e2e6', hover: '#f4f4f6', selection: '#fde8d5',
    focus: '#e2761f', primary: '#e2761f', mutedSurface: '#f4f4f6', elevatedForeground: '#1b1b1f',
    active: '#e8e8ec', selectionForeground: '#8a4a10', primaryForeground: '#ffffff',
    primaryText: '#b35c12', successText: '#1a7f4b', warningText: '#8a6100', errorText: '#c0392b',
    infoText: '#1f5fa8', success: '#1a7f4b', warning: '#b8860b', error: '#c0392b', info: '#2f6fb8',
    font: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    radius: '9px',
  },
}

const DARK = {
  mode: 'dark',
  tokens: {
    background: '#0e0e10', elevated: '#1c1c1f', foreground: '#e8e8e8', muted: '#9a9aa0',
    subtle: '#2a2a2e', border: '#33333a', hover: '#26262b', selection: '#3a2a1c',
    focus: '#fb8b3c', primary: '#fb8b3c', mutedSurface: '#16161a', elevatedForeground: '#e8e8e8',
    active: '#2f2f35', selectionForeground: '#fb8b3c', primaryForeground: '#211307',
    primaryText: '#fb8b3c', successText: '#6ee7a0', warningText: '#ffd479', errorText: '#f97066',
    infoText: '#8ab4ff', success: '#6ee7a0', warning: '#ffd479', error: '#f97066', info: '#8ab4ff',
    font: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    radius: '9px',
  },
}

const theme = params.get('theme') === 'dark' ? DARK : LIGHT
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