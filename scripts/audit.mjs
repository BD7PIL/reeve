#!/usr/bin/env node
// REEVE 面板的**动线审计**：按固定清单驱动预览，每个状态一张截图（含"点了之后"的状态）。
//
//   node extensions/reeve/scripts/audit.mjs              # 起预览 + 出全套图到 preview/audit/
//   node extensions/reeve/scripts/audit.mjs --only 05     # 只跑序号含 05 的项
//   node extensions/reeve/scripts/audit.mjs --no-serve    # 复用已在跑的预览（PREVIEW_PORT）
//
// 为什么要有它：截图只拍首屏 = 只能证明"画出来了"；动线（选中→动作→保存→已生效）**必须驱动着拍**。
// 清单在 `preview/audit/README.md` 那张表里 —— 有了它，"我逐张看过"才不是一句声明。
//
// 实现：headless Edge/Chrome 的 CDP（Node 自带 WebSocket）打开预览页 → 点击 → 整页截图。
// 预览读的是真快照与真配置；**写只进内存**（save 那一步截图里的"已生效"是预览服务确认的），
// 所以这套审计不会改你的 `~/.config/opencode/reeve/fallback.jsonc`。

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** 一步动作。`click` 按可见文字找按钮/列表行；`scroll` 滚到某个选择器。 */
const click = (text, nth = 0) => ({ click: text, nth })
const clickSel = (selector, nth = 0) => ({ clickSel: selector, nth })

/**
 * 清单 = 组件状态 × 动线步骤。`page` 是预览的 tab（`?tab=`）。
 * 每项一张图，文件名前缀就是序号 —— 与 `preview/audit/README.md` 的表一一对应。
 */
const PLAN = [
  { id: '01-chain-default', tab: 'chain', note: '链 tab 首屏：5 张链卡（默认链徽标 / agent / 候选 / 更多菜单）' },
  { id: '02-chain-row-selected', tab: 'chain', note: '选中一个候选 → 动作条出现（上移/下移/换模型/删除）', steps: [clickSel('.oc-sdk-row', 1)] },
  { id: '03-chain-picker', tab: 'chain', note: '「换模型」→ 搜索框 + 候选列表 + 手填', steps: [clickSel('.oc-sdk-row', 1), click('换模型')] },
  { id: '04-chain-picker-search', tab: 'chain', note: '搜索结果（只留命中的候选）', steps: [clickSel('.oc-sdk-row', 1), click('换模型'), { type: '9router' }] },
  { id: '05-chain-added', tab: 'chain', note: '加进链尾 → 未保存徽标 + 底部保存条', steps: [click('＋ 添加候选'), { type: 'deepseek' }, clickSel('.oc-list-scroll .oc-sdk-row', 0)] },
  { id: '06-chain-saved', tab: 'chain', note: '保存并生效 → 生效中 → 已生效徽标（预览的写只进内存）', steps: [click('＋ 添加候选'), { type: 'deepseek' }, clickSel('.oc-list-scroll .oc-sdk-row', 0), click('保存并生效')], settle: 1600 },
  { id: '07-chain-menu', tab: 'chain', note: '链卡「更多」：设为默认链 / 删除这条链（destructive）', steps: [click('更多')] },
  { id: '08-chain-new', tab: 'chain', note: '＋ 新增链 → 链名输入 + 建链/取消', steps: [click('＋ 新增链'), { scrollSel: '[data-act="new-chain-row"]', block: 'end' }] },
  { id: '09-chain-agents', tab: 'chain', note: 'agent → 链 映射（每个 agent 一个下拉）+ 追加未映射的 agent', steps: [{ scrollText: 'agent → 链' }] },
  { id: '10-chain-policy', tab: 'chain', note: '策略卡：三个数字字段 + 一个开关（含说明）', steps: [{ scrollText: '策略' }] },
  { id: '11-chain-narrow', tab: 'chain', width: 380, note: '窄宽 380px：卡片/表单不溢出，单列落' },
  { id: '12-chain-dark', tab: 'chain', theme: 'dark', note: '链 tab · 深色' },
  { id: '13-stats-light', tab: 'stats', note: '统计 tab：摘要数字格 + 每条链的进度条 + provider 列表' },
  { id: '14-stats-dark', tab: 'stats', theme: 'dark', note: '统计 tab · 深色' },
  { id: '15-ledger-light', tab: 'ledger', note: '台账 tab：事实卡 + 子任务列表（点行开子会话）' },
  { id: '17-chain-keyboard', tab: 'chain', note: '键盘：选中后 Alt+↓ 换位（W3C APG 键位；链尾再按是空操作，有守卫）', steps: [clickSel('.oc-sdk-row', 1), { key: 'ArrowDown', alt: true }] },
  { id: '18-chain-selected-dark', tab: 'chain', theme: 'dark', note: '深色下的选中行 + 动作条（选中色来自宿主 token）', steps: [clickSel('.oc-sdk-row', 1)] },
  { id: '16-chain-dirty-discard', tab: 'chain', note: '改动后「丢弃改动」→ 回到未保存前的样子', steps: [clickSel('.oc-sdk-row', 1), click('删除'), click('丢弃改动')] },
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
  await wait(6000)
}

mkdirSync(outDir, { recursive: true })
const profile = join(tmpdir(), 'reeve-audit-chrome')
try { rmSync(profile, { recursive: true, force: true }) } catch { /* Windows 句柄没放开：留着无妨（gitignored） */ }

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
socket.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
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

/** 按可见文字点（kit 的按钮/列表行都在 button 或 role=button 上）。 */
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

/** 往当前可见输入框里打字（React 之外也要用原生 setter，否则框架不认）。 */
const TYPE_JS = (text) => `(() => {
  const input = [...document.querySelectorAll('input')].find((i) => i.offsetParent !== null);
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(text)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`

/** 键盘：事件要**从容器内部**冒泡（真用户是点了行、焦点在行上）。
 *  这里按 `data-ref` 找到那一行再派发 —— 比 activeElement 可靠（脚本 .click() 不一定会聚焦）。 */
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
  const hit = [...document.querySelectorAll('strong, .oc-card')].find((x) => (x.textContent || '').includes(${JSON.stringify(text)}));
  if (!hit) return false;
  hit.scrollIntoView({ block: 'start' });
  return true;
})()`

const results = []
for (const item of PLAN.filter((p) => !only || p.id.includes(only))) {
  const width = item.width ?? 660
  await send('Emulation.setDeviceMetricsOverride', { width, height: item.height ?? 1080, deviceScaleFactor: 2, mobile: false })
  await send('Page.navigate', { url: `${base}/?tab=${item.tab}&theme=${item.theme ?? 'light'}` })
  await wait(item.settle ?? 2000)
  for (const step of item.steps ?? []) {
    let ok = true
    if (step.click) ok = await evaluate(CLICK_JS(step.click, step.nth ?? 0))
    else if (step.clickSel) ok = await evaluate(CLICK_SEL_JS(step.clickSel, step.nth ?? 0))
    else if (step.type) ok = await evaluate(TYPE_JS(step.type))
    else if (step.scrollText) ok = await evaluate(SCROLL_TEXT_JS(step.scrollText))
    else if (step.scrollSel) ok = await evaluate(SCROLL_SEL_JS(step.scrollSel, step.block ?? 'start'))
    else if (step.key) ok = await evaluate(KEY_JS(step.key, step.alt === true))
    if (!ok) results.push({ id: item.id, note: item.note, warn: `步骤没点/打进去：${JSON.stringify(step)}` })
    await wait(700)
  }
  // 视口截图：弹层是 fixed 的，整页截图会把它们挪位置 —— 审计要拍用户实际看到的那一屏（--full 才拍整页）
  const shot = await send('Page.captureScreenshot', { format: 'png', ...(full ? { captureBeyondViewport: true } : {}) })
  const file = join(outDir, `${item.id}.png`)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
  results.push({ id: item.id, note: item.note, file: `${item.id}.png` })
  console.log(`  ✓ ${item.id} — ${item.note}`)
}

const warns = results.filter((r) => r.warn)
console.log(`\n截图 ${results.length} 张 → ${outDir}`)
if (warns.length) {
  console.error('动线警告：')
  for (const w of warns) console.error(`  · ${w.id} ${w.warn}`)
}
socket.close()
browser.kill()
server?.kill()
process.exit(warns.length ? 1 : 0)