#!/usr/bin/env node
// REEVE 面板的**动线审计 + UI 断言门**：按清单驱动预览，每项一张截图 + 一组断言。
//
//   node extensions/reeve/scripts/audit.mjs                  # 真快照/真配置（本机）
//   node extensions/reeve/scripts/audit.mjs --fixture        # 用 preview/fixtures/ci.json（CI/可重复）
//   node extensions/reeve/scripts/audit.mjs --only 19        # 只跑序号含 19 的项
//   node extensions/reeve/scripts/audit.mjs --no-serve       # 复用已在跑的预览（PREVIEW_PORT）
//   node extensions/reeve/scripts/audit.mjs --strict-contrast # 3–4.5 的对比度也算失败
//   node extensions/reeve/scripts/audit.mjs --locale=zh-CN|en  # 语言矩阵（默认 zh-CN，与宿主当前设置一致）
//
// 断言（任一失败 → 退出码 1，report.json 里逐项记录）：
//   · 步骤必须点到（fail-fast，不再"拍了张错状态的图继续跑"）
//   · 控制台 error / 未捕获异常 = 0
//   · 关键态文本（expect/expectNot）
//   · 横向溢出（document / .oc-page / .oc-savebar / .oc-field-row）
//   · 宿主 token 必须存在（颜色/字阶来自宿主，不是自绘）
//   · 可见按钮必须有可访问名
//   · 文本对比度：<3 硬失败，3–4.5 警告（--strict-contrast 时失败）
//   · 保存类动线写入次数（globalThis.__previewWrites）
//
// 预览读真快照与真配置；**写只进内存**，不会改 ~/.config/opencode/reeve/fallback.jsonc。

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, 'preview', 'audit')
const port = Number(process.env.PREVIEW_PORT ?? 5399)
const debugPort = Number(process.env.REEVE_CDP_PORT ?? 9391)
const base = `http://127.0.0.1:${port}`

const argv = process.argv.slice(2)
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null
const localeArg = argv.find((a) => a.startsWith('--locale='))?.slice('--locale='.length)
const locale = localeArg === 'en' ? 'en' : 'zh-CN'
// 语言矩阵分开存图/报告（主套仍写 report.json；英文矩阵用 report-en.json）
const suffix = argv.find((a) => a.startsWith('--suffix='))?.slice('--suffix='.length) ?? ''
const L = (en, zh) => (locale === 'zh-CN' ? zh : en)
const full = argv.includes('--full')
const serve = !argv.includes('--no-serve')
const fixture = argv.includes('--fixture') || process.env.REEVE_AUDIT_FIXTURE === '1' || process.env.CI === 'true'
const strictContrast = argv.includes('--strict-contrast')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** 一步动作。`click` 按可见文字找按钮/列表行；`typeSel` 往指定输入框打字。 */
const click = (text, nth = 0) => ({ click: text, nth })
const clickSel = (selector, nth = 0) => ({ clickSel: selector, nth })
const typeSel = (selector, text) => ({ typeSel: selector, text })

/**
 * 清单 = 组件状态 × 动线步骤（每个状态一张图；序号与 preview/audit/README.md 一一对应）。
 * `scenario` 走 preview/host-shim.js 的注入（不动真实文件）；`expect` 是必须出现的文本。
 */
const PLAN = [
  { id: '01-chain-default', tab: 'chain', note: '路由链首屏：链卡（含免费兜底行）+ 档位/模型/更多', expect: [L('Free pool', '免费模型池'), L('Total attempts 4 = free 3 + paid 1', '总尝试 4 次 = 免费 3 + 付费 1')] },
  { id: '02-chain-row-selected', tab: 'chain', note: '选中模型 → 动作条（上移/下移/更换模型/移除）', steps: [clickSel('.oc-sdk-row', 1)], expect: [L('Selected: ', '已选：')] },
  { id: '03-chain-picker', tab: 'chain', note: '「更换模型」→ 搜索 + 模型列表 + 手填', steps: [clickSel('.oc-sdk-row', 1), click(L('Replace', '替换'))], expect: [L('Replace ', '替换 ')] },
  { id: '04-chain-picker-search', tab: 'chain', note: '搜索 deepseek → 只留命中的模型', steps: [clickSel('.oc-sdk-row', 1), click(L('Replace', '替换')), { type: 'deepseek' }] },
  { id: '05-chain-added', tab: 'chain', note: '加进链尾 → 未保存徽标 + 页面级保存条', steps: [click(L('+ Add model', '+ 添加模型')), { type: 'deepseek' }, clickSel('.oc-list-scroll .oc-sdk-row', 0)], expect: [L('Unsaved', '未保存'), L('Save & apply', '保存并应用')] },
  { id: '06-chain-saved', tab: 'chain', note: '保存 → 生效中 → 已生效（预览只写内存，但会模拟热更）', steps: [click(L('+ Add model', '+ 添加模型')), { type: 'deepseek' }, clickSel('.oc-list-scroll .oc-sdk-row', 0), click(L('Save & apply', '保存并应用'))], settle: 3600, expect: [L('Applied', '已生效')], writes: 1 },
  { id: '07-chain-menu', tab: 'chain', note: '链卡「更多」：设为默认链 / 删除（档位在用时拒绝并说明）', steps: [click(L('More', '更多'))], expect: [L('Delete (', '删除（')] },
  { id: '08-chain-new', tab: 'chain', note: '＋ 新增链 → 链名输入 + 创建/取消', steps: [click(L('+ New chain', '+ 新建链')), { scrollSel: '[data-act="new-chain-row"]', block: 'end' }], expect: [L('Create', '创建')] },
  { id: '09-tier-mapping', tab: 'chain', height: 820, note: 'chain_for_model（真正生效的档位映射编辑面）', steps: [{ scrollSel: '[data-tier="reeve/pro"]', block: 'center' }], expect: ['chain_for_model', 'reeve/pro'] },
  { id: '10-chain-policy', tab: 'chain', height: 820, note: '重试策略：数字字段 + 开关 + 高级折叠', steps: [{ scrollSel: '[data-policy="max_fallback_attempts"]', block: 'center' }], expect: [L('Max attempts', '最大尝试次数'), L('Return to primary after cooldown', '冷却结束后回到首选')] },
  { id: '11-chain-narrow', tab: 'chain', width: 380, note: '窄宽 380px：不横向溢出，单列落' },
  { id: '12-chain-dark', tab: 'chain', theme: 'dark', note: '路由链 · 深色' },
  { id: '13-stats-light', tab: 'stats', note: '调用统计：摘要数字格 + 链进度条 + 服务商列表', expect: [L('Requests', '请求'), L('By provider', '按提供商')] },
  { id: '14-stats-dark', tab: 'stats', theme: 'dark', note: '调用统计 · 深色' },
  { id: '15-ledger-light', tab: 'ledger', note: '任务记录：摘要数字格 + 子任务列表', expect: [L('Tasks', '任务')] },
  { id: '16-chain-dirty-discard', tab: 'chain', note: '删模型 →「丢弃改动」→ 回到改动前', steps: [clickSel('.oc-sdk-row', 1), clickSel('[data-act="remove"]', 0), click(L('Discard', '放弃修改'))] },
  { id: '17-chain-keyboard', tab: 'chain', note: '键盘：选中后 Alt+↓ 换位（W3C APG）', steps: [clickSel('.oc-sdk-row', 1), { key: 'ArrowDown', alt: true }] },
  { id: '18-chain-selected-dark', tab: 'chain', theme: 'dark', note: '深色下的选中行 + 动作条', steps: [clickSel('.oc-sdk-row', 1)] },
  { id: '19-free-default', tab: 'chain', note: '免费模型池：开关/模型数/发现源 + 展开摘要', steps: [{ scrollSel: '[data-section="free"]', block: 'start' }], expect: [L('Free models', '免费模型数'), L('Expandable now', '当前可展开'), L('10 free models', '10 个免费模型')] },
  { id: '20-free-cooling', tab: 'chain', scenario: 'free-cooling', note: '免费模型冷却中（摘要行）', steps: [clickSel('[data-act="free-refresh"]'), { scrollSel: '[data-free="expand"]', block: 'center' }], expect: [L('cooling', '冷却')] },
  { id: '21-free-empty', tab: 'chain', scenario: 'free-empty', note: '没有可展开的免费模型（空态）', steps: [{ scrollSel: '[data-section="free"]', block: 'start' }], expect: [L('No free models to expand right now', '当前没有可展开的免费模型')] },
  { id: '22-free-error', tab: 'chain', scenario: 'free-error', note: '免费模型池运行态读取失败', steps: [{ scrollSel: '[data-section="free"]', block: 'start' }], expect: [L('Runtime read failed', '运行态读取失败')] },
  { id: '23-free-max-dirty', tab: 'chain', note: '改免费模型数 → 未保存徽标（即时出现，不重绘）', steps: [typeSel('[data-free="max"] input', '1')], settle: 600, expect: [L('Unsaved', '未保存')] },
  { id: '24-free-prefer-add', tab: 'chain', note: '固定一个免费模型进偏好（高级折叠内）', steps: [clickSel('[data-section="free"] details.oc-advanced > summary'), typeSel('[data-free="prefer-add"] input', 'deepseek-v4.1-flash-free'), clickSel('[data-act="free-add"]'), { scrollSel: '[data-free-prefer="deepseek-v4.1-flash-free"]', block: 'center' }], expect: ['deepseek-v4.1-flash-free'] },
  { id: '25-gate-down', tab: 'chain', scenario: 'gate-down', note: '路由引擎没起：徽标 + 横幅 + 页签仍可用', expect: [L('Router is not running', '路由未运行'), L('Router not ready', '路由未就绪')] },
  { id: '26-gate-problems', tab: 'chain', scenario: 'gate-problems', note: '配置 problems 横幅', expect: [L('Config has 2 problems', '配置有 2 个问题')] },
  { id: '27-config-parse-error', tab: 'chain', scenario: 'config-parse-error', note: '配置解析失败：横幅', expect: [L('Config parse error', '配置解析失败')] },
  { id: '28-config-missing', tab: 'chain', scenario: 'config-missing', note: '配置读不到：横幅 + 诊断里有 tried 列表', steps: [clickSel('[data-section="diag"] > summary')], expect: [L('Cannot read router config', '读不到路由配置'), 'NOT_FOUND'] },
  { id: '29-ledger-missing', tab: 'chain', scenario: 'ledger-missing', note: '快照读不到：数据未就绪 + 下一步提示', expect: [L('Data not ready', '数据未就绪'), L('Snapshot unavailable', '快照不可用'), L('Run a model call', '发起一次模型调用')] },
  { id: '30-ledger-denied', tab: 'ledger', scenario: 'ledger-denied', note: '快照未授权：权限提示（不是"空数据"）', expect: [L('No task data yet', '还没有任务数据'), L('permission', '权限')] },
  { id: '31-save-fail', tab: 'chain', scenario: 'save-fail', note: '写入失败：notice + 没生效', steps: [click(L('+ Add model', '+ 添加模型')), { type: 'deepseek' }, clickSel('.oc-list-scroll .oc-sdk-row', 0), click(L('Save & apply', '保存并应用'))], settle: 2200, expect: [L('Write failed', '写入失败'), L('Not applied', '未生效')] },
  { id: '32-apply-stall', tab: 'chain', scenario: 'apply-stall', note: '写了但没热更：停在生效中', steps: [click(L('+ Add model', '+ 添加模型')), { type: 'deepseek' }, clickSel('.oc-list-scroll .oc-sdk-row', 0), click(L('Save & apply', '保存并应用'))], settle: 2200, expect: [L('Applying', '应用中')] },
  { id: '33-policy-dirty', tab: 'chain', note: '改策略数字 → 未保存（即时出现，不重绘）', steps: [{ scrollSel: '[data-section="policy"]', block: 'start' }, typeSel('[data-policy="max_fallback_attempts"] input', '5')], settle: 600, expect: [L('Unsaved', '未保存')] },
  { id: '34-ledger-filter-empty', tab: 'ledger', note: '筛选运行中（0 条）≠ 没有任务', steps: [click(L('Running 0', '运行中 0'))], expect: [L('No records in this filter', '这个筛选下没有记录')] },
  { id: '35-stats-empty', tab: 'stats', scenario: 'empty-stats', note: '没有请求数据的空态', expect: [L('No request data yet', '还没有请求数据')] },
  { id: '36-stats-stale', tab: 'stats', scenario: 'stale', note: '台账旧行的窗口放宽提示', expect: [L('All rows are older than', '所有记录都早于')] },
  { id: '37-ledger-dark', tab: 'ledger', theme: 'dark', note: '任务记录 · 深色' },
  { id: '38-chain-loading', tab: 'chain', scenario: 'slow-config', skipReady: true, settle: 1200, note: '读取中的加载态', expect: [L('Reading router config', '正在读取路由配置')] },
  { id: '40-chain-narrow-306', tab: 'chain', width: 306, note: '宿主侧栏 306px：不溢出、徽标与更多可见、免费行仍可读', expect: [L('Free pool', '免费模型池')] },
  { id: '39-gate-running', tab: 'chain', scenario: 'gate-running', note: '主徽标：运行中 + 排队（primary 色）', expect: [L('2 running', '2 个运行中')] },
  { id: '41-chain-selected-306', tab: 'chain', width: 306, note: '306px：选中行 + 动作条（Selected 前缀收起，按钮仍在）', steps: [clickSel('.oc-sdk-row', 1)], expect: [L('Replace', '替换'), L('Remove', '移除')] },
  { id: '42-stats-306', tab: 'stats', width: 306, note: '306px：统计行拆两行，不溢出', expect: [L('By chain', '按链')] },
  { id: '43-free-advanced-306', tab: 'chain', width: 306, note: '306px：免费模型池高级折叠（偏好/禁用/白名单）', steps: [clickSel('[data-section="free"] details.oc-advanced > summary'), { scrollSel: '[data-free="prefer"]', block: 'center' }], expect: [L('Preference order', '偏好顺序')] },
  { id: '44-gate-down-306', tab: 'chain', width: 306, scenario: 'gate-down', note: '306px + 路由没起：徽标与横幅都不挤坏', expect: [L('Router is not running', '路由未运行'), L('Router not ready', '路由未就绪')] },
  { id: '45-free-only-chain', tab: 'chain', note: '免费池专用链 free-only（[@free]）：整卡只有免费模型池行，没有付费模型', steps: [{ scrollSel: '[data-chain="free-only"]', block: 'center' }], expect: [L('Free pool', '免费模型池'), L('up to 3', '最多 3 个'), L('auto', '自动')] },
  { id: '46-ledger-runs', tab: 'ledger', note: '引擎运行步卡：摘要数字格 + 声明/脚本/挂起三类运行 + 状态徽标', steps: [{ scrollSel: '[data-section="runs"]', block: 'start' }], expect: [L('Engine runs', '引擎运行'), 'run-ci-demo', 'fetch-source', 'report-writeup', L('2/5 done', '已完成 2/5'), L('Phases', '阶段：'), 'verify'] },
  { id: '47-ledger-runs-dark', tab: 'ledger', theme: 'dark', note: '引擎运行步卡 · 深色', steps: [{ scrollSel: '[data-section="runs"]', block: 'start' }], expect: [L('Engine runs', '引擎运行'), 'run-ci-demo', 'await-human'] },
  // ---- D 线（优化方案 v3「D」节；scenario 注入 engine.runs，夹具见 preview/host-shim.js）----
  { id: '48-runs-fourstate', tab: 'ledger', scenario: 'runs-fourstate', assert: 'FOURSTATE', note: 'D1 四态一眼可辨：run 左条/状态徽标两两可辨 + 失败步突出 + 耗时/重试可见（程序化断言：宿主 token getComputedStyle 对比度）', steps: [{ scrollSel: '[data-section="runs"]', block: 'start' }], expect: ['run-day-report', 'run-live-sweep', 'run-night-audit', 'run-gate-apply', L('attempts ×3', '尝试 ×3'), '8.0m'] },
  { id: '49-runs-dag', tab: 'ledger', scenario: 'runs-dag', assert: 'DAG', note: 'D2 DAG 视图：声明 steps+deps → 图（mermaid 源可展开）+ 脚本 phase 时间线，随状态着色', steps: [{ scrollSel: '[data-section="runs"]', block: 'start' }], expect: ['run-dag-weekly', 'run-script-pipeline', 'fetch-source', 'report-writeup', 'collect', 'publish', L('mermaid source', 'mermaid 源')] },
  { id: '50-runs-approval', tab: 'ledger', scenario: 'runs-approval', assert: 'APPROVAL', note: 'D3 workflow-script 审批卡：脚本摘要 + 静态扫描命令集 + phase 列表 + 分叉说明', steps: [{ scrollSel: '[data-section="runs"]', block: 'start' }], expect: [L('Awaiting approval', '待审批'), L('Script summary', '脚本摘要'), L('Static-scan commands (3)', '静态扫描命令集（3）'), L('Branch notes', '分叉说明'), 'node scripts/write-report.mjs'] },
  { id: '51-runs-fourstate-dark', tab: 'ledger', theme: 'dark', scenario: 'runs-fourstate', assert: 'FOURSTATE', note: 'D1 四态 · 深色：同一套程序化断言在宿主深色 token 下复跑', steps: [{ scrollSel: '[data-section="runs"]', block: 'start' }], expect: ['run-day-report', 'run-gate-apply', L('attempts ×3', '尝试 ×3')] },
]

const chrome = [
  process.env.AGENT_BROWSER_EXECUTABLE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p))
if (!chrome) {
  console.error('找不到 Chrome/Edge：把 AGENT_BROWSER_EXECUTABLE_PATH 指向可执行文件')
  process.exit(2)
}

let server
if (serve) {
  server = spawn(process.execPath, [join(root, 'scripts', 'preview.mjs')], {
    env: { ...process.env, PREVIEW_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  // 就绪轮询（固定 6s 在慢机器上会误判）
  const deadline = Date.now() + 12_000
  for (;;) {
    try {
      const r = await fetch(`${base}/?tab=chain`)
      if (r.ok) break
    } catch { /* 还没起来 */ }
    if (Date.now() > deadline) {
      console.error('预览服务没起来')
      server.kill()
      process.exit(2)
    }
    await wait(250)
  }
}

mkdirSync(outDir, { recursive: true })
// 只清这次要重拍的截图（--only 不能把整套图删掉）
const onlyList = only ? only.split(',').map((s) => s.trim()).filter(Boolean) : null
const selected = PLAN.filter((p) => !onlyList || onlyList.some((o) => p.id.includes(o)))
for (const item of selected) rmSync(join(outDir, `${item.id}${suffix}.png`), { force: true })
// 每次运行用**独立临时 profile**：固定目录会被残留的浏览器实例锁住，
// 新实例会握手即退（对旧实例 hand-off），换端口也救不回来 —— CI 的 exit 3 就是这么来的。
const profile = mkdtempSync(join(tmpdir(), 'reeve-audit-chrome-'))

/** 收掉浏览器整棵进程树：Windows 上 child.kill() 只杀根进程，Edge/Chrome 的子进程会泄漏成僵尸。 */
function killBrowserTree(proc) {
  if (!proc || proc.exitCode !== null) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch { proc.kill() }
  } else {
    proc.kill()
  }
}

// 浏览器启动是 CI 上最大的 flake 源。两个坑都实测过：
//   · Edge headless 会**自重启**——spawn 的根进程秒退（exitCode 0），真浏览器是子进程继续握 CDP 端口；
//     所以不能把"根进程退出"当死亡，只认端口出不出得来。
//   · 根进程 kill 杀不掉 Edge 的子进程树 → 残留实例锁住固定 profile/端口，后续启动全废；
//     所以 profile 每次独立临时目录，收尾用 taskkill /T（Windows）。
let browser
let target
let cdpPort = debugPort
for (let launch = 1; launch <= 3 && !target; launch++) {
  const port = debugPort + launch - 1
  browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    // 容器/CI 里 Chrome 的沙箱起不来（CDP 目标不会出现）：CI 下关沙箱 + 共享内存目录
    ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
      if (r.ok) { target = await r.json(); cdpPort = port; break }
    } catch { /* 还没起来（或根进程已自重启、端口由子进程接管） */ }
    await wait(250)
  }
  if (!target?.webSocketDebuggerUrl) {
    killBrowserTree(browser)
    await wait(500)
  }
}
if (!target?.webSocketDebuggerUrl) {
  console.error('CDP 页面目标没起来（3 次启动尝试都失败）')
  server?.kill()
  process.exit(3)
}

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r, j) => { socket.addEventListener('open', r); socket.addEventListener('error', j) })
let nextId = 1
const pending = new Map()
let consoleErrors = []
socket.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
    consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 160))
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(String(msg.params?.exceptionDetails?.exception?.description ?? msg.params?.exceptionDetails?.text ?? 'exception').slice(0, 160))
  }
})
const send = (method, params = {}) => new Promise((res) => {
  const id = nextId++
  pending.set(id, res)
  socket.send(JSON.stringify({ id, method, params }))
})
await send('Page.enable')
await send('Runtime.enable')

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text ?? 'evaluate 失败')
  return r.result?.result?.value
}

const CLICK_JS = (text, nth) => `(() => {
  const want = ${JSON.stringify(text)};
  const isBtn = (el) => el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.closest('button') !== null;
  const all = [...document.querySelectorAll('button, [role="button"], li')].filter(isBtn);
  const hit = all.filter((x) => (x.textContent || '').trim().includes(want))[${nth}];
  if (!hit) return false;
  hit.click();
  return true;
})()`

const CLICK_SEL_JS = (selector, nth) => `(() => {
  const hit = [...document.querySelectorAll(${JSON.stringify(selector)})][${nth}];
  if (!hit) return false;
  hit.focus?.();
  hit.click();
  return true;
})()`

const TYPE_JS = (text) => `(() => {
  const input = [...document.querySelectorAll('input')].find((i) => i.offsetParent !== null);
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(text)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`

const TYPE_SEL_JS = (selector, text) => `(() => {
  const input = document.querySelector(${JSON.stringify(selector)});
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(text)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`

const KEY_JS = (key, alt) => `(() => {
  const ref = document.querySelector('[data-act="row-actions"]')?.getAttribute('data-ref') ?? '';
  const rows = [...document.querySelectorAll('.oc-sdk-row')];
  const target = rows.find((r) => (r.textContent || '').includes(ref)) || document.activeElement || document.body;
  target.focus?.();
  target.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, altKey: ${alt ? 'true' : 'false'}, bubbles: true, cancelable: true }));
  return true;
})()`

const SCROLL_SEL_JS = (selector, block) => `(() => {
  const hit = document.querySelector(${JSON.stringify(selector)});
  if (!hit) return false;
  hit.scrollIntoView({ block: ${JSON.stringify(block)} });
  return true;
})()`

const SCROLL_TEXT_JS = (text) => `(() => {
  const hit = [...document.querySelectorAll('strong, .oc-label, .oc-section, h2, span')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(text)} || (x.textContent || '').includes(${JSON.stringify(text)}));
  if (!hit) return false;
  hit.scrollIntoView({ block: 'start' });
  return true;
})()`

/** 页面级不变量 + 对比度（<3 硬失败；3–4.5 警告）。 */
const CHECKS_JS = `(() => {
  const out = { overflow: [], buttons: [], tokens: [], contrast: [], kitContrast: [] };
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 1) out.overflow.push('document ' + de.scrollWidth + '>' + de.clientWidth);
  for (const sel of ['.oc-page', '.oc-savebar', '.oc-field-row']) {
    for (const el of document.querySelectorAll(sel)) {
      if (el.scrollWidth > el.clientWidth + 1) {
        let detail = '';
        if (sel === '.oc-page') {
          const pr = el.getBoundingClientRect();
          detail = [...el.querySelectorAll('*')]
            .filter((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.right > pr.right + 0.5; })
            .slice(0, 3)
            .map((x) => (x.tagName.toLowerCase() + '.' + String(x.className).split(' ').slice(0, 2).join('.') + '+' + Math.round(x.getBoundingClientRect().right - pr.right) + 'px'))
            .join(',');
        }
        out.overflow.push(sel + ' ' + el.scrollWidth + '>' + el.clientWidth + (detail ? ' [' + detail + ']' : ''));
      }
    }
  }
  const rs = getComputedStyle(de);
  for (const name of ['--surface-background', '--surface-elevated', '--surface-subtle', '--interactive-border', '--status-error']) {
    if (!rs.getPropertyValue(name).trim()) out.tokens.push(name);
  }
  for (const b of document.querySelectorAll('button')) {
    if (b.offsetParent === null) continue;
    const name = (b.textContent || '').trim() || b.getAttribute('aria-label') || b.getAttribute('title');
    if (!name) out.buttons.push((b.outerHTML || '').slice(0, 120));
  }
  const parse = (c) => {
    const s = String(c).trim();
    let m = s.match(/rgba?\\(([^)]+)\\)/);
    if (m) {
      const p = m[1].split(',').map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
    }
    // CSS Color 4：宿主 token 走 color-mix/oklch 时 computed 出 color(srgb …)（0–1 浮点，/ 透明度）
    m = s.match(/color\\(srgb\\s+([^)]+)\\)/);
    if (m) {
      const parts = m[1].trim().split(/\\s*\\/\\s*/);
      const p = parts[0].split(/\\s+/).map(Number);
      return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: parts[1] !== undefined ? Number(parts[1]) : 1 };
    }
    // 宿主 token 原值是十六进制（shim 逐字抄的 HostThemeTokens，含 #rrggbbaa）
    m = s.match(/^#([0-9a-f]{3,8})$/i);
    if (m) {
      let h = m[1];
      if (h.length <= 4) h = [...h].map((x) => x + x).join('');
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
    return null;
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const s = getComputedStyle(n);
      if (s.backgroundImage !== 'none') return null;
      const c = parse(s.backgroundColor);
      if (c && c.a > 0.9) return c;
      n = n.parentElement;
    }
    const s = getComputedStyle(document.documentElement);
    let c = parse(s.backgroundColor);
    if (c && c.a > 0.9) return c;
    // 面板 html/body 是 transparent（底色由宿主画布/iframe 提供）——退回宿主声明的 surface background
    c = parse(String(s.getPropertyValue('--surface-background') ?? '').trim());
    return c && c.a > 0.9 ? c : null;
  };
  const els = [...document.querySelectorAll('span,strong,label,p,button,li,h2,h3')];
  for (const el of els) {
    if (el.offsetParent === null || el.closest('.oc-sr')) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const text = (el.textContent || '').trim();
    if (text.length < 2) continue;
    const fg = parse(getComputedStyle(el).color);
    const bg = bgOf(el);
    if (!fg || !bg) continue;
    const r = ratio(fg, bg);
    // 宿主 kit 控件的派生文字色（tab 激活态 / 按钮的 primaryText 等）= 宿主自己的 token 配对，
    // 且预览 shim 的派生色是 color-mix 近似——真宿主用 OKLab 对比度算过（shim 头注自认）。
    // 不达 4.5 记 warning 不硬判（面板自己画的字不在此列，照旧硬判）。
    const bucket = el.closest('.oc-sdk-tab, .oc-sdk-btn') ? out.kitContrast : out.contrast;
    if (r < 4.5) bucket.push({ r: Math.round(r * 100) / 100, text: text.slice(0, 40) });
  }
  return out;
})()`

/**
 * D 线专项断言（对宿主 token 的 getComputedStyle 检查；`--strict-contrast` 先例的延续）。
 * key 挂在 PLAN 项的 `assert` 上；返回 { failures: [] }。
 */
const COMPOSITE_JS = `
  const parse = (c) => {
    const s = String(c).trim();
    let m = s.match(/rgba?\\(([^)]+)\\)/);
    if (m) { const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; }
    m = s.match(/color\\(srgb\\s+([^)]+)\\)/);
    if (m) { const parts = m[1].trim().split(/\\s*\\/\\s*/); const p = parts[0].split(/\\s+/).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: parts[1] !== undefined ? Number(parts[1]) : 1 }; }
    m = s.match(/^#([0-9a-f]{3,8})$/i);
    if (m) {
      let h = m[1];
      if (h.length <= 4) h = [...h].map((x) => x + x).join('');
      const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
      return { r, g, b, a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
    }
    return null;
  };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };
  const bgOf = (el) => { let n = el; while (n && n !== document.documentElement) { const s = getComputedStyle(n); if (s.backgroundImage !== 'none') return null; const c = parse(s.backgroundColor); if (c && c.a > 0.9) return c; n = n.parentElement; } const rs = getComputedStyle(document.documentElement); let c = parse(rs.backgroundColor); if (c && c.a > 0.9) return c; c = parse(String(rs.getPropertyValue('--surface-background') ?? '').trim()); return c && c.a > 0.9 ? c : null; };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });`

const ASSERT_JS = {
  // D1：四态徽标 + run 左条——各自存在、文字对比度 ≥4.5、颜色两两可辨（同色系不算可辨）。
  FOURSTATE: `(() => {
  const out = { failures: [], warnings: [] };
  ${COMPOSITE_JS}
  const key = (c) => (c ? Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) : 'null');
  const badges = [...document.querySelectorAll('[data-run-status]')];
  const want = ['completed', 'running', 'failed', 'blocked'];
  const seen = new Map();
  for (const status of want) {
    const hit = badges.find((b) => b.getAttribute('data-run-status') === status);
    if (!hit) { out.failures.push('缺状态徽标：' + status); continue; }
    const el = hit.querySelector('.oc-sdk-badge') || hit;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg) { out.failures.push(status + ': color 解析失败 ' + cs.color); continue; }
    const bgBase = bgOf(el);
    if (!bgBase) { out.failures.push(status + ': 背景不可解析（渐变？）'); continue; }
    const bg = parse(cs.backgroundColor);
    const flat = bg && bg.a < 1 ? over(bg, bgBase) : bgBase;
    const r = ratio(fg, flat);
    if (r < 3) out.failures.push(status + ' 徽标文字对比度 ' + (Math.round(r * 100) / 100) + ' < 3');
    else if (r < 4.5) out.warnings.push(status + ' 徽标文字对比度 ' + (Math.round(r * 100) / 100) + '（3–4.5，shim 近似色）');
    const run = hit.closest('[data-run]');
    const barRaw = run ? getComputedStyle(run).borderLeftColor : null;
    const bar = parse(barRaw);
    if (!bar || bar.a < 0.5) out.failures.push(status + ': run 左条缺失');
    // 可辨性在徽标底色上（实底化设计：文字色 = 页面底色，四态同一文字色是设计不是缺陷）
    seen.set(status, { bgKey: key(flat), barKey: bar ? key(bar) : 'null' });
  }
  if (new Set([...seen.values()].map((v) => v.bgKey)).size !== want.length) out.failures.push('四态徽标底色不两两可辨');
  if (seen.size === want.length && new Set([...seen.values()].map((v) => v.barKey)).size !== want.length) out.failures.push('run 左条色不两两可辨');
  return out;
})()`,
  // D2：DAG 节点/边/状态桶 + mermaid 源；脚本 phase 时间线的尾段随 run 状态着色。
  DAG: `(() => {
  const out = { failures: [], warnings: [] };
  const dag = document.querySelector('[data-run-dag]');
  if (!dag) { out.failures.push('DAG 容器缺失'); return out; }
  const nodes = dag.querySelectorAll('.oc-dag-node');
  if (nodes.length !== 5) out.failures.push('DAG 节点数 ' + nodes.length + ' ≠ 5');
  const edges = document.querySelectorAll('svg[data-dag-edges] path');
  if (edges.length !== 5) {
    const svgs = [...document.querySelectorAll('svg[data-dag-edges]')];
    out.failures.push('DAG 边数 ' + edges.length + ' ≠ 5（图没画出来）[svg=' + svgs.length + ' connected=' + svgs.map((s) => s.isConnected + '/' + s.childElementCount + '/' + (s.getAttribute('width') ?? '-')).join(',') + ']');
  }
  const buckets = [...new Set([...nodes].map((n) => n.getAttribute('data-bucket')))];
  if (buckets.length < 3) out.failures.push('节点状态桶少于 3 种（着色没生效）：' + buckets.join(','));
  const src = document.querySelector('[data-dag-source]');
  if (!src || !src.textContent.includes('flowchart LR') || !src.textContent.includes('-->')) out.failures.push('mermaid 源缺失或不完整');
  const chips = document.querySelectorAll('[data-run-phases]:not([data-approval]) .oc-phase');
  if (chips.length !== 4) out.failures.push('phase 时间线段数 ' + chips.length + ' ≠ 4');
  const tail = chips[chips.length - 1];
  if (!tail || tail.getAttribute('data-bucket') !== 'failed') out.failures.push('时间线尾段未随 run 状态着色（failed）');
  return out;
})()`,
  // D3：审批卡四要素齐全（摘要 / 命令集 / phase / 分叉说明 + 静态扫描边界说明）。
  APPROVAL: `(() => {
  const out = { failures: [] };
  const card = document.querySelector('[data-run-approval]');
  if (!card) { out.failures.push('审批卡缺失'); return out; }
  if (!card.querySelector('[data-approval-summary]')) out.failures.push('审批卡缺脚本摘要');
  const cmds = card.querySelectorAll('.oc-approval-cmd');
  if (cmds.length !== 3) out.failures.push('命令集条数 ' + cmds.length + ' ≠ 3');
  const forks = card.querySelectorAll('.oc-approval-fork');
  if (forks.length !== 2) out.failures.push('分叉说明条数 ' + forks.length + ' ≠ 2');
  const phases = card.querySelectorAll('[data-run-phases] .oc-phase');
  if (phases.length !== 3) out.failures.push('审批卡 phase 列表段数 ' + phases.length + ' ≠ 3');
  if (!card.querySelector('[data-approval-caveat]')) out.failures.push('缺静态扫描边界说明');
  return out;
})()`,
}

async function waitReady(item) {
  if (item.skipReady) return
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const text = await evaluate(`(() => document.querySelector('#root')?.innerText || '')()`)
    if (text.length > 30 && !text.includes('Reading router config') && !text.includes('正在读取路由配置') && !text.includes('Panel failed to start') && !text.includes('面板启动失败')) return
    if (item.expect?.some((s) => text.includes(s))) return
    await wait(200)
  }
}

const results = []
for (const item of selected) {
  const width = item.width ?? 660
  await send('Emulation.setDeviceMetricsOverride', { width, height: item.height ?? 1080, deviceScaleFactor: 2, mobile: false })
  consoleErrors = []
  const q = [`tab=${item.tab}`, `theme=${item.theme ?? 'light'}`, `locale=${locale}`, ...(fixture ? ['fixture=ci'] : []), ...(item.scenario ? [`scenario=${item.scenario}`] : []), ...(item.applyDelay ? [`applyDelay=${item.applyDelay}`] : [])].join('&')
  await send('Page.navigate', { url: `${base}/?${q}` })
  await waitReady(item)
  await wait(item.settle ?? 900)

  const failures = []
  const warnings = []
  let stepFailed = false
  for (const step of item.steps ?? []) {
    let ok = true
    if (step.click) ok = await evaluate(CLICK_JS(step.click, step.nth ?? 0))
    else if (step.clickSel) ok = await evaluate(CLICK_SEL_JS(step.clickSel, step.nth ?? 0))
    else if (step.type) ok = await evaluate(TYPE_JS(step.type))
    else if (step.typeSel) ok = await evaluate(TYPE_SEL_JS(step.typeSel, step.text))
    else if (step.scrollText) ok = await evaluate(SCROLL_TEXT_JS(step.scrollText))
    else if (step.scrollSel) ok = await evaluate(SCROLL_SEL_JS(step.scrollSel, step.block ?? 'start'))
    else if (step.key) ok = await evaluate(KEY_JS(step.key, step.alt === true))
    if (!ok) {
      const attrs = step.typeSel ? await evaluate(`(() => [...document.querySelectorAll('[data-free],[data-policy]')].map((e) => e.getAttribute('data-free') ?? e.getAttribute('data-policy')).join(','))()`) : null
      failures.push(`步骤没点到：${JSON.stringify(step)}${attrs ? `（现场：${attrs}）` : ''}`)
      stepFailed = true
      break
    }
    await wait(step.wait ?? 650)
  }
  if (item.settle && item.steps?.length) await wait(item.settle)

  const text = await evaluate('document.body.innerText')
  for (const s of item.expect ?? []) if (!text.includes(s)) failures.push(`缺少文本：${s}`)
  for (const s of item.expectNot ?? []) if (text.includes(s)) failures.push(`不该出现：${s}`)
  if (item.assert) {
    const ar = await evaluate(ASSERT_JS[item.assert])
    for (const f of ar?.failures ?? []) failures.push(`断言[${item.assert}]：${f}`)
    // 3–4.5 的对比度是警告级（shim 派生色是近似值；--strict-contrast 时升级为失败）
    for (const w of ar?.warnings ?? []) {
      const msg = `断言[${item.assert}]：${w}`
      if (strictContrast) failures.push(msg)
      else warnings.push(msg)
    }
  }
  // 跨页导航时宿主的旧消息端口会晚一步关闭，Chrome 报 "Could not establish connection"
  // —— 这是页面切换噪声，不是面板错误；面板自己的启动失败已由 waitReady 的文本断言覆盖。
  const appConsoleErrors = consoleErrors.filter((e) => !e.includes('Could not establish connection'))
  if (appConsoleErrors.length) failures.push(`控制台错误 ${appConsoleErrors.length} 条：${appConsoleErrors.slice(0, 2).join(' | ')}`)
  if (item.writes != null) {
    const n = await evaluate('globalThis.__previewWrites?.length ?? 0')
    if (n !== item.writes) failures.push(`写入次数 ${n} ≠ ${item.writes}`)
  }
  const checks = await evaluate(CHECKS_JS)
  if (checks.overflow.length) failures.push(`横向溢出：${checks.overflow.slice(0, 3).join('；')}`)
  if (checks.tokens.length) failures.push(`缺宿主 token：${checks.tokens.join(',')}`)
  if (checks.buttons.length) failures.push(`无名称按钮 ${checks.buttons.length} 个`)
  const hard = checks.contrast.filter((c) => c.r < 3)
  const soft = checks.contrast.filter((c) => c.r >= 3 && c.r < 4.5)
  if (hard.length) failures.push(`对比度 <3：${hard.slice(0, 3).map((c) => `${c.text}(${c.r})`).join('；')}`)
  if (soft.length) {
    const msg = `对比度 3–4.5：${soft.slice(0, 4).map((c) => `${c.text}(${c.r})`).join('；')}`
    if (strictContrast) failures.push(msg)
    else warnings.push(msg)
  }
  // 宿主 kit 自身的 token 配对（tab 激活态等）：不是面板能改的东西，记警告不拦门
  if (checks.kitContrast?.length) {
    warnings.push(`宿主 kit 对比度（token 配对 · shim 近似色）：${checks.kitContrast.slice(0, 3).map((c) => `${c.text}(${c.r})`).join('；')}`)
  }

  const shot = await send('Page.captureScreenshot', { format: 'png', ...(full ? { captureBeyondViewport: true } : {}) })
  const file = join(outDir, `${item.id}${suffix}.png`)
  writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
  results.push({ id: item.id, note: item.note, file: `${item.id}${suffix}.png`, scenario: item.scenario ?? null, failures, warnings, consoleErrors: [...appConsoleErrors] })
  const mark = failures.length ? '✗' : stepFailed ? '✗' : '✓'
  console.log(`${mark} ${item.id} — ${item.note}${failures.length ? `（${failures.length} 项失败）` : ''}`)
}

const report = {
  generatedAt: new Date().toISOString(),
  locale,
  fixture,
  strictContrast,
  total: results.length,
  failed: results.filter((r) => r.failures.length).length,
  warned: results.filter((r) => r.warnings.length).length,
  items: results,
}
writeFileSync(join(outDir, `report${suffix}.json`), `${JSON.stringify(report, null, 2)}\n`)

const failed = results.filter((r) => r.failures.length)
const warned = results.filter((r) => r.warnings.length)
console.log(`\n截图 ${results.length} 张 → ${outDir}`)
if (warned.length) {
  console.log('警告：')
  for (const w of warned) console.log(`  · ${w.id} ${w.warnings.join('；')}`)
}
if (failed.length) {
  console.error('失败：')
  for (const f of failed) for (const reason of f.failures) console.error(`  · ${f.id} ${reason}`)
}
socket.close()
// 先走 CDP 的 Browser.close（能关掉 Edge 自重启后**脱离进程树**的子进程），再兜底杀树。
// Browser.close 只在**浏览器级** WS 上有效（/json/version 的那个），页面级 WS 会静默忽略。
try {
  const ver = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()
  const bws = new WebSocket(ver.webSocketDebuggerUrl)
  await Promise.race([
    new Promise((res, rej) => { bws.addEventListener('open', res, { once: true }); bws.addEventListener('error', rej, { once: true }) }),
    wait(1500),
  ])
  bws.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
  await wait(800)
  try { bws.close() } catch { /* 已随浏览器断开 */ }
} catch { /* 浏览器已不在：兜底会处理 */ }
killBrowserTree(browser)
server?.kill()
process.exit(failed.length ? 1 : 0)
