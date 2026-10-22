#!/usr/bin/env node
// REEVE 面板的**动线审计 + UI 断言门**：按清单驱动预览，每项一张截图 + 一组断言。
//
//   node extensions/reeve/scripts/audit.mjs                  # 真快照/真配置（本机）
//   node extensions/reeve/scripts/audit.mjs --fixture        # 用 preview/fixtures/ci.json（CI/可重复）
//   node extensions/reeve/scripts/audit.mjs --only 19        # 只跑序号含 19 的项
//   node extensions/reeve/scripts/audit.mjs --no-serve       # 复用已在跑的预览（PREVIEW_PORT）
//   node extensions/reeve/scripts/audit.mjs --strict-contrast # 3–4.5 的对比度也算失败
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
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
  { id: '01-chain-default', tab: 'chain', note: '链首屏：链卡（含 @free 自动行）+ agent/候选/更多', expect: ['免费车道（自动）', '总尝试 4 = 免费 3 + 付费 1'] },
  { id: '02-chain-row-selected', tab: 'chain', note: '选中候选 → 动作条（上移/下移/换模型/删除）', steps: [clickSel('.oc-sdk-row', 1)], expect: ['已选：'] },
  { id: '03-chain-picker', tab: 'chain', note: '「换模型」→ 搜索 + 候选列表 + 手填', steps: [clickSel('.oc-sdk-row', 1), click('换模型')], expect: ['换掉 '] },
  { id: '04-chain-picker-search', tab: 'chain', note: '搜索 deepseek → 只留命中的候选', steps: [clickSel('.oc-sdk-row', 1), click('换模型'), { type: 'deepseek' }] },
  { id: '05-chain-added', tab: 'chain', note: '加进链尾 → 未保存徽标 + 底部保存条', steps: [click('+ 添加候选'), { type: 'deepseek' }, clickSel('.oc-list-scroll .oc-sdk-row', 0)], expect: ['未保存', '保存并生效'] },
  { id: '06-chain-saved', tab: 'chain', note: '保存 → 生效中 → 已生效（预览只写内存，但会模拟 GATE 热更）', steps: [click('+ 添加候选'), { type: 'deepseek' }, clickSel('.oc-list-scroll .oc-sdk-row', 0), click('保存并生效')], settle: 3600, expect: ['已生效'], writes: 1 },
  { id: '07-chain-menu', tab: 'chain', note: '链卡「更多」：设为默认链 / 删除（destructive）', steps: [click('更多')], expect: ['删除这条链'] },
  { id: '08-chain-new', tab: 'chain', note: '＋ 新增链 → 链名输入 + 建链/取消', steps: [click('+ 新增链'), { scrollSel: '[data-act="new-chain-row"]', block: 'end' }], expect: ['建链'] },
  { id: '09-chain-agents', tab: 'chain', height: 820, note: 'agent → 链 映射（每 agent 一个下拉）', steps: [{ scrollSel: '[data-agent="planner"]', block: 'center' }], expect: ['agent → 链'] },
  { id: '10-chain-policy', tab: 'chain', height: 820, note: '策略卡：数字字段 + 开关（含说明）', steps: [{ scrollSel: '[data-policy="max_fallback_attempts"]', block: 'center' }], expect: ['最多尝试候选数', '冷却结束后回到首选'] },
  { id: '11-chain-narrow', tab: 'chain', width: 380, note: '窄宽 380px：不横向溢出，单列落' },
  { id: '12-chain-dark', tab: 'chain', theme: 'dark', note: '链 · 深色' },
  { id: '13-stats-light', tab: 'stats', note: '统计：摘要数字格 + 链进度条 + provider 列表', expect: ['GATE 归因', 'provider'] },
  { id: '14-stats-dark', tab: 'stats', theme: 'dark', note: '统计 · 深色' },
  { id: '15-ledger-light', tab: 'ledger', note: '台账：事实行 + 子任务列表', expect: ['台账', '任务'] },
  { id: '16-chain-dirty-discard', tab: 'chain', note: '删候选 →「丢弃改动」→ 回到改动前', steps: [clickSel('.oc-sdk-row', 1), clickSel('[data-act="remove"]', 0), click('丢弃改动')] },
  { id: '17-chain-keyboard', tab: 'chain', note: '键盘：选中后 Alt+↓ 换位（W3C APG）', steps: [clickSel('.oc-sdk-row', 1), { key: 'ArrowDown', alt: true }] },
  { id: '18-chain-selected-dark', tab: 'chain', theme: 'dark', note: '深色下的选中行 + 动作条', steps: [clickSel('.oc-sdk-row', 1)] },
  { id: '19-free-default', tab: 'chain', note: '免费车道卡：开关/次数/来源/偏好/当前展开', steps: [{ scrollText: '免费车道' }], expect: ['免费尝试次数', '当前展开', '10 个免费模型'] },
  { id: '20-free-cooling', tab: 'chain', scenario: 'free-cooling', note: '免费候选冷却中的徽标', steps: [click('刷新读数'), { scrollText: '当前展开' }], expect: ['冷却'] },
  { id: '21-free-empty', tab: 'chain', scenario: 'free-empty', note: '没有可展开的免费候选（空态）', steps: [{ scrollText: '免费车道' }], expect: ['当前没有可展开的免费候选'] },
  { id: '22-free-error', tab: 'chain', scenario: 'free-error', note: '免费车道运行态读取失败', steps: [{ scrollText: '免费车道' }], expect: ['运行态读取失败'] },
  { id: '23-free-max-dirty', tab: 'chain', note: '改免费次数 → 未保存徽标（轮询后出现）', steps: [typeSel('[data-free="max"] input', '1')], settle: 2800, expect: ['未保存'] },
  { id: '24-free-prefer-add', tab: 'chain', note: '固定一个免费模型进 prefer', steps: [typeSel('[data-free="prefer-add"] input', 'deepseek-v4.1-flash-free'), click('加入'), { scrollSel: '[data-free-prefer="deepseek-v4.1-flash-free"]', block: 'center' }], expect: ['deepseek-v4.1-flash-free'] },
  { id: '25-gate-down', tab: 'chain', scenario: 'gate-down', note: 'GATE 没起来：徽标 + 横幅 + 页签仍可用', expect: ['GATE 没起来', 'GATE 未就绪'] },
  { id: '26-gate-problems', tab: 'chain', scenario: 'gate-problems', note: '配置 problems 横幅', expect: ['配置加载有 2 个问题'] },
  { id: '27-config-parse-error', tab: 'chain', scenario: 'config-parse-error', note: '配置解析失败：横幅 + tried 列表', expect: ['配置解析失败'] },
  { id: '28-config-missing', tab: 'chain', scenario: 'config-missing', note: '配置读不到：NOT_FOUND + tried 列表', expect: ['读不到 GATE 配置', 'NOT_FOUND'] },
  { id: '29-ledger-missing', tab: 'chain', scenario: 'ledger-missing', note: '快照读不到：台账未就绪 + 试过的路径', expect: ['台账未就绪', '台账快照读不到', '跑一次模型调用'] },
  { id: '30-ledger-denied', tab: 'ledger', scenario: 'ledger-denied', note: '快照未授权：权限提示（不是"空台账"）', expect: ['还没读到台账快照', '权限'] },
  { id: '31-save-fail', tab: 'chain', scenario: 'save-fail', note: '写入失败：notice + 没生效', steps: [click('+ 添加候选'), { type: 'deepseek' }, clickSel('.oc-list-scroll .oc-sdk-row', 0), click('保存并生效')], settle: 2200, expect: ['写入失败', '没生效'] },
  { id: '32-apply-stall', tab: 'chain', scenario: 'apply-stall', note: '写了但 GATE 没热更：停在生效中', steps: [click('+ 添加候选'), { type: 'deepseek' }, clickSel('.oc-list-scroll .oc-sdk-row', 0), click('保存并生效')], settle: 2200, expect: ['生效中'] },
  { id: '33-policy-dirty', tab: 'chain', note: '改策略数字 → 未保存（轮询后出现）', steps: [{ scrollSel: '[data-section="policy"]', block: 'start' }, typeSel('[data-policy="max_fallback_attempts"] input', '5')], settle: 2800, expect: ['未保存'] },
  { id: '34-ledger-filter-empty', tab: 'ledger', note: '筛选在飞（0 条）≠ 台账空', steps: [click('在飞 0')], expect: ['这个筛选下没有记录'] },
  { id: '35-stats-empty', tab: 'stats', scenario: 'empty-stats', note: '没有归因数据的空态', expect: ['还没有归因数据'] },
  { id: '36-stats-stale', tab: 'stats', scenario: 'stale', note: '台账旧行的窗口放宽提示', expect: ['台账都是旧行'] },
  { id: '37-ledger-dark', tab: 'ledger', theme: 'dark', note: '台账 · 深色' },
  { id: '38-chain-loading', tab: 'chain', scenario: 'slow-config', skipReady: true, settle: 1200, note: '读取中的加载态', expect: ['正在读 GATE 配置'] },
  { id: '39-gate-running', tab: 'chain', scenario: 'gate-running', note: '主徽标：在飞 + 排队（primary 色）', expect: ['2 在飞'] },
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
const selected = PLAN.filter((p) => !only || p.id.includes(only))
for (const item of selected) rmSync(join(outDir, `${item.id}.png`), { force: true })
const profile = join(tmpdir(), 'reeve-audit-chrome')
try { rmSync(profile, { recursive: true, force: true }) } catch { /* Windows 句柄没放开：留着无妨 */ }

const browser = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] })

let target
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })
    if (r.ok) { target = await r.json(); break }
  } catch { /* 还没起来 */ }
  await wait(250)
}
if (!target?.webSocketDebuggerUrl) {
  console.error('CDP 页面目标没起来')
  browser.kill(); server?.kill()
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
  const out = { overflow: [], buttons: [], tokens: [], contrast: [] };
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 1) out.overflow.push('document ' + de.scrollWidth + '>' + de.clientWidth);
  for (const sel of ['.oc-page', '.oc-savebar', '.oc-field-row']) {
    for (const el of document.querySelectorAll(sel)) {
      if (el.scrollWidth > el.clientWidth + 1) out.overflow.push(sel + ' ' + el.scrollWidth + '>' + el.clientWidth);
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
    const m = String(c).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
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
    const c = parse(getComputedStyle(document.documentElement).backgroundColor);
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
    if (r < 4.5) out.contrast.push({ r: Math.round(r * 100) / 100, text: text.slice(0, 40) });
  }
  return out;
})()`

async function waitReady(item) {
  if (item.skipReady) return
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const text = await evaluate(`(() => document.querySelector('#root')?.innerText || '')()`)
    if (text.length > 30 && !text.includes('正在读 GATE 配置') && !text.includes('面板未能启动')) return
    if (item.expect?.some((s) => text.includes(s))) return
    await wait(200)
  }
}

const results = []
for (const item of selected) {
  const width = item.width ?? 660
  await send('Emulation.setDeviceMetricsOverride', { width, height: item.height ?? 1080, deviceScaleFactor: 2, mobile: false })
  consoleErrors = []
  const q = [`tab=${item.tab}`, `theme=${item.theme ?? 'light'}`, ...(fixture ? ['fixture=ci'] : []), ...(item.scenario ? [`scenario=${item.scenario}`] : []), ...(item.applyDelay ? [`applyDelay=${item.applyDelay}`] : [])].join('&')
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
  if (consoleErrors.length) failures.push(`控制台错误 ${consoleErrors.length} 条：${consoleErrors.slice(0, 2).join(' | ')}`)
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

  const shot = await send('Page.captureScreenshot', { format: 'png', ...(full ? { captureBeyondViewport: true } : {}) })
  const file = join(outDir, `${item.id}.png`)
  writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
  results.push({ id: item.id, note: item.note, file: `${item.id}.png`, scenario: item.scenario ?? null, failures, warnings, consoleErrors: [...consoleErrors] })
  const mark = failures.length ? '✗' : stepFailed ? '✗' : '✓'
  console.log(`${mark} ${item.id} — ${item.note}${failures.length ? `（${failures.length} 项失败）` : ''}`)
}

const report = {
  generatedAt: new Date().toISOString(),
  fixture,
  strictContrast,
  total: results.length,
  failed: results.filter((r) => r.failures.length).length,
  warned: results.filter((r) => r.warnings.length).length,
  items: results,
}
writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

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
browser.kill()
server?.kill()
process.exit(failed.length ? 1 : 0)
