#!/usr/bin/env node
// 真宿主验收：在 openchamber 里打开 REEVE 面板（OOPIF），断言它真的渲染、没有控制台错误、
// 没有横向溢出、宿主 token 在位、关键内容（免费车道 / @free / 预算 / 三个 tab）都在。
//
//   node scripts/host-audit.mjs --app=http://127.0.0.1:3001/ --cdp=http://127.0.0.1:9222
//
// 前提：一个已登录 openchamber 的 Chrome/Edge 在 --cdp 上（headless 也行；没有 UI 密码时直接可开）。
// 面板在 OOPIF 里（sandbox 不给 allow-same-origin）：不能读顶层 DOM，必须 Target.attachToTarget。
// 本脚本不打印任何凭据；结果写 preview/host-audit/<host>.json。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const arg = (name, def = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : def
}
const APP = arg('app', 'http://127.0.0.1:3001/')
const CDP = arg('cdp', 'http://127.0.0.1:9222')
const OUT = arg('out', join(root, 'preview', 'host-audit', `${new URL(APP).port || 'default'}.json`))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch(`${CDP}/json/list`)).json()
const appHost = new URL(APP).host
let page = list.find((t) => t.type === 'page' && String(t.url).includes(appHost))
if (!page) {
  console.error(`CDP 上没有打开的 app 页面（${appHost}）。先在那个浏览器里打开 ${APP}`)
  process.exit(2)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true })
  ws.addEventListener('error', j, { once: true })
})
let seq = 0
const pending = new Map()
const consoleErrors = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
    return
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') consoleErrors.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 160))
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(String(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? 'exception').slice(0, 160))
})
const send = (method, params = {}, sessionId = null) =>
  new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
await send('Page.enable')

// 点侧栏入口（最多 10 轮；入口是宿主自己的按钮，按 aria-label/title/文字找）
let clicked = false
for (let i = 0; i < 10 && !clicked; i++) {
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const el = [...document.querySelectorAll('button,[role=button],a')].find((e) => /REEVE|编排/.test((e.getAttribute('aria-label') || '') + (e.getAttribute('title') || '') + (e.textContent || '')))
      if (!el) return false
      el.click()
      return true
    })()`,
    returnByValue: true,
  })
  clicked = r.result?.result?.value === true
  if (!clicked) await sleep(800)
}
if (!clicked) {
  console.error('找不到侧栏的 REEVE 入口（扩展没装/没启用？）')
  process.exit(3)
}
await sleep(1200)

// 面板是 OOPIF：从 Target.getTargets 找到它，附上去断言
let frame = null
for (let i = 0; i < 20 && !frame; i++) {
  const t = await send('Target.getTargets')
  frame = t.result?.targetInfos?.find((x) => x.type === 'iframe' && String(x.url).includes('/api/guests/reeve/'))
  if (!frame) await sleep(500)
}
if (!frame) {
  console.error('面板 iframe 没出现（guest 没加载）')
  process.exit(4)
}
const att = await send('Target.attachToTarget', { targetId: frame.targetId, flatten: true })
const sid = att.result?.sessionId
await send('Runtime.enable', {}, sid)
await send('Page.enable', {}, sid)
await sleep(1500)

const checks = await send(
  'Runtime.evaluate',
  {
    expression: `(() => {
      const de = document.documentElement
      const rs = getComputedStyle(de)
      const tokens = ['--surface-background', '--surface-elevated', '--surface-subtle', '--interactive-border', '--status-error'].filter((n) => !rs.getPropertyValue(n).trim())
      const text = document.body.innerText
      const must = ['编排与代理层', '免费车道', '免费车道（自动）', '总尝试 4 = 免费 3 + 付费 1', '链', '统计', '台账']
      return {
        textLen: text.length,
        missing: must.filter((s) => !text.includes(s)),
        overflow: de.scrollWidth > de.clientWidth + 1,
        tokens,
      }
    })()`,
    returnByValue: true,
  },
  sid,
)
const doc = checks.result?.result?.value ?? {}
const failures = []
if (!doc.textLen || doc.textLen < 200) failures.push(`面板文本过短（${doc.textLen ?? 0}）`)
for (const s of doc.missing ?? []) failures.push(`缺内容：${s}`)
if (doc.overflow) failures.push('横向溢出')
for (const t of doc.tokens ?? []) failures.push(`缺宿主 token：${t}`)
if (consoleErrors.length) failures.push(`控制台错误 ${consoleErrors.length}：${consoleErrors.slice(0, 2).join(' | ')}`)

const report = { app: APP, host: appHost, at: new Date().toISOString(), guest: frame.url.split('?')[0], checks: doc, consoleErrors, failures }
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`)
console.log(`${failures.length ? 'FAIL' : 'PASS'} 真宿主面板 — ${appHost}（文本 ${doc.textLen} 字；console ${consoleErrors.length}；溢出 ${doc.overflow}）`)
for (const f of failures) console.error(`  · ${f}`)
console.log(`报告：${OUT}`)
ws.close()
process.exit(failures.length ? 1 : 0)
