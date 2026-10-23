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
// 语言：默认与宿主当前设置一致（zh-CN）；`?locale=en` 用英文矩阵跑审计
const locale = params.get('locale') === 'en' ? 'en' : 'zh-CN'
const L = (zh, en) => (locale === 'zh-CN' ? zh : en)
const readyListeners = new Set()
const directoryListeners = new Set()
const sessionListeners = new Set()
const writes = []

const readyCtx = {
  theme,
  locale,
  directory: null,
  session: null,
  surface: 'panel',
  connection: { state: 'ready' },
  settings: {},
  item: null,
}

const err = (message, code) => Object.assign(new Error(message), { code })

// ---- 场景注入（审计/CI 用；逐页隔离，不碰真实文件）----
// ?scenario=gate-down|gate-problems|config-missing|config-parse-error|ledger-missing|ledger-denied|
//           save-fail|apply-stall|stale|slow-read|empty-stats|empty-tasks|free-empty|free-cooling|free-error|gate-running
// ?fixture=ci      正常态用仓库里的夹具（CI 没有真快照/真配置）
// ?applyDelay=800  写入后多久把新配置"热更"进快照（模拟 GATE ≤5s；apply-stall 时永不）
const scenario = params.get('scenario') ?? ''
const fixtureMode = params.get('fixture') === 'ci'
const applyDelay = Number(params.get('applyDelay') ?? 800)
let writtenText = null
let writtenConfig = null
let writtenAt = 0
let fixtureDoc = null

const isConfigPath = (p) => /fallback\.jsonc$/.test(String(p))
const isSnapshotPath = (p) => /ledger\.json$/.test(String(p))
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const stripComments = (t) => String(t).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
const parseLoose = (t) => JSON.parse(stripComments(t))

async function loadFixture() {
  if (!fixtureDoc) {
    const res = await fetch('/preview-fixture.json')
    if (!res.ok) throw err(`读不到 CI fixture（HTTP ${res.status}）`, 'NOT_FOUND')
    fixtureDoc = await res.json()
  }
  return fixtureDoc
}

/** 写入 → 模拟 GATE 热更：快照的 gate 段按新配置重算（含 free 节）。 */
function patchApplied(snapshot) {
  if (!writtenConfig || Date.now() - writtenAt < applyDelay || scenario === 'apply-stall') return snapshot
  const cfg = writtenConfig
  const gate = { ...(snapshot.gate ?? {}) }
  const policy = cfg.policy ?? {}
  gate.chains = Object.keys(cfg.chains ?? {})
  gate.chain_targets = Object.fromEntries(Object.entries(cfg.chains ?? {}).map(([n, s]) => [n, [...(s?.targets ?? [])]]))
  gate.agents = { ...(cfg.agents ?? {}) }
  gate.default_chain = cfg.default_chain ?? null
  gate.policy = {
    max_fallback_attempts: Number(policy.max_fallback_attempts ?? 3),
    cooldown_seconds: Number(policy.cooldown_seconds ?? 60),
    restore_primary_after_cooldown: policy.restore_primary_after_cooldown === true,
    provider_retries: Number(policy.provider_retries ?? 1),
  }
  const f = cfg.free ?? {}
  gate.free = {
    enabled: f.enabled !== false,
    max: Number(f.max ?? 3),
    providers: Array.isArray(f.providers) ? f.providers.map(String) : ['opencode', 'openrouter', 'nvidia'],
    refresh_seconds: Number(f.refresh_seconds ?? 300),
    failure_threshold: Number(f.failure_threshold ?? 3),
    failure_cooldown_seconds: Number(f.failure_cooldown_seconds ?? 600),
    prefer: Array.isArray(f.prefer) ? f.prefer.map(String) : [],
    deny: Array.isArray(f.deny) ? f.deny.map(String) : [],
    static: Object.fromEntries(Object.entries(f.static ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : []])),
  }
  return { ...snapshot, gate }
}

/** 错误/空/陈旧态（只改这一页读到的数据，不碰盘）。 */
function applyScenario(snapshot) {
  const out = { ...snapshot }
  if (scenario === 'stale') {
    out.generatedAt = Date.now() - 2 * 86_400_000
    if (out.stats) {
      out.stats = { ...out.stats, generatedAt: out.generatedAt }
      if (out.stats.gate) out.stats.gate = { ...out.stats.gate, window: { ...(out.stats.gate.window ?? {}), relaxed: true } }
    }
  }
  if (scenario === 'gate-down') out.gate = { error: L('GATE 起不来（模拟：端口被占）', 'GATE failed to start (simulated: port in use)') }
  if (scenario === 'gate-problems' && out.gate) {
    out.gate = {
      ...out.gate,
      problems: L(
        ['chains.demo 没有 targets（模拟）', 'agents.scout 指向的链不存在（模拟）'],
        ['chains.demo has no targets (simulated)', 'agents.scout points at a missing chain (simulated)'],
      ),
    }
  }
  if (scenario === 'empty-stats') out.stats = null
  if (scenario === 'empty-tasks') out.tasks = []
  if (scenario === 'gate-running') {
    out.counts = { ...(out.counts ?? {}), running: 2, total: Math.max(3, out.counts?.total ?? 3) }
    if (out.stats?.orchestrate) out.stats = { ...out.stats, orchestrate: { ...out.stats.orchestrate, queue: { active: 2, waiting: 1 } } }
  }
  if (scenario === 'free-empty') out.free = { enabled: true, max: 3, cap: 3, providers: [], expand: [], cooling: [], prefer: [], deny: [] }
  if (scenario === 'free-cooling') {
    const base = out.free ?? { enabled: true, max: 3, cap: 3, providers: [], prefer: [], deny: [] }
    out.free = {
      ...base,
      expand: ['opencode/mimo-v2.6-flash-free', 'opencode/deepseek-v4.1-flash-free'],
      cooling: [{ ref: 'opencode/mimo-v2.6-flash-free', fails: 3, until: Date.now() + 240_000 }],
    }
  }
  if (scenario === 'free-error') out.free = { error: L('读不到免费模型池运行态（模拟）', 'Cannot read free pool runtime (simulated)') }
  return out
}

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
    if (scenario === 'slow-read') await delay(2600)
    // 只慢读配置：快照先到 → 面板先画骨架 → 链 tab 停在"正在读 GATE 配置…"（确定性加载态）
    if (scenario === 'slow-config' && isConfigPath(path)) await delay(3000)
    // 错误态优先于夹具/真盘：否则 fixture 模式会绕过注入
    if (isConfigPath(path)) {
      if (scenario === 'config-missing') throw err('没有这个文件（模拟）', 'NOT_FOUND')
      if (scenario === 'config-parse-error') return { content: '{ 坏 json' }
    }
    if (isSnapshotPath(path)) {
      if (scenario === 'ledger-missing') throw err('读不到台账快照（模拟）', 'NOT_FOUND')
      if (scenario === 'ledger-denied') throw err('没有文件权限（模拟：未授权 filesystem）', 'NOT_GRANTED')
    }
    if (fixtureMode) {
      const doc = await loadFixture()
      if (isConfigPath(path)) return { content: writtenText ?? JSON.stringify(doc.config, null, 2) }
      if (isSnapshotPath(path)) return { content: JSON.stringify(patchApplied(applyScenario(doc.snapshot))) }
      return { content: JSON.stringify(doc.snapshot) }
    }
    const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw err(body.error ?? `读取失败（HTTP ${res.status}）`, body.code ?? (res.status === 403 ? 'NOT_GRANTED' : 'UNKNOWN'))
    }
    const body = await res.json()
    if (isSnapshotPath(path)) {
      try {
        return { content: JSON.stringify(patchApplied(applyScenario(JSON.parse(body.content)))) }
      } catch {
        return body
      }
    }
    return body
  },
  writeFile: async (path, content) => {
    if (scenario === 'save-fail') {
      await delay(500)
      throw err(L('配置文件只读（模拟）', 'config file is read-only (simulated)'), 'UNKNOWN')
    }
    const res = await fetch('/api/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, content }),
    })
    if (!res.ok) throw err(`写入失败（HTTP ${res.status}）`, 'UNKNOWN')
    const out = await res.json()
    writes.push({ path, bytes: content.length, applied: out.applied })
    if (isConfigPath(path)) {
      try {
        writtenConfig = parseLoose(content)
        writtenText = content
        writtenAt = Date.now()
      } catch {
        /* 写进坏配置不是面板该走的路（applySave 自校验会先拦），这里不处理 */
      }
    }
    return { written: true }
  },
}

export function connectHost() {
  return client
}

globalThis.__previewWrites = writes