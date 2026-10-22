#!/usr/bin/env node
// 抓**真宿主**里的 REEVE 面板图（OOPIF）：优先对 iframe 目标做 Page.startScreencast（面板本体），
// 拿不到帧就退回顶层页面的 screencast（面板在 app 上下文里）。
//
//   node scripts/host-shot.mjs --app=http://127.0.0.1:3001/ --cdp=http://127.0.0.1:9222 --out=preview/host-audit/dev-3001.png
//   PEER_UI_PASSWORD=… node scripts/host-shot.mjs --app=http://127.0.0.1:4610/ --cdp=http://127.0.0.1:9223 --login --out=…
//
// 为什么要 screencast：headless 下对 OOPIF 的 `Page.captureScreenshot` 返回不了数据；
// screencast 是合成器出帧，能把面板内容带出来。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const arg = (name, def = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : def
}
const APP = arg('app', 'http://127.0.0.1:3001/')
const CDP = arg('cdp', 'http://127.0.0.1:9222')
const OUT = arg('out', 'preview/host-audit/host.png')
const LOGIN = process.argv.includes('--login')
const password = process.env.PEER_UI_PASSWORD ?? ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch(`${CDP}/json/list`)).json()
const appHost = new URL(APP).host
let page = list.find((t) => t.type === 'page' && String(t.url).includes(appHost))
if (!page) {
  // 新开的浏览器只有 about:blank：自己开一个 app 页
  page = await (await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' })).json()
  await sleep(3500)
}
if (!page?.webSocketDebuggerUrl) throw new Error(`CDP 上没有 ${appHost} 的页面；先打开 ${APP}`)
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true })
  ws.addEventListener('error', j, { once: true })
})
let seq = 0
const pending = new Map()
const frames = new Map() // sessionId -> data url(s)
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
    return
  }
  if (m.method === 'Page.screencastFrame') {
    const sid = m.sessionId ?? 'root'
    frames.set(sid, m.params.data)
    void send('Page.screencastFrameAck', { sessionId: m.params.sessionId }, sid === 'root' ? null : sid)
  }
})
const send = (method, params = {}, sessionId = null) =>
  new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
await send('Page.enable')
await send('Runtime.enable')

if (LOGIN) {
  if (!password) throw new Error('PEER_UI_PASSWORD empty')
  await send('Page.navigate', { url: APP })
  await sleep(2500)
  await send(
    'Runtime.evaluate',
    {
      expression: `fetch('/auth/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ${JSON.stringify(password)}, trustDevice: true }) }).then((x) => x.status)`,
      awaitPromise: true,
      returnByValue: true,
    },
  )
  await send('Page.reload', { ignoreCache: true })
  await sleep(3500)
}

// 面板已经开着就别再点（入口是 toggle，会把它关掉）
const hasPanel = async () => {
  const t = await send('Target.getTargets')
  return Boolean(t.result?.targetInfos?.some((x) => x.type === 'iframe' && String(x.url).includes('/api/guests/reeve/')))
}
let clicked = await hasPanel()
if (!clicked) {
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
}
if (!clicked) throw new Error('找不到 REEVE 入口')
await sleep(1200)
await send('Page.bringToFront')
// 关掉宿主的提示条（"OpenCode 更新" 之类），别让它盖住面板右下角
const dismiss = () =>
  send('Runtime.evaluate', {
    expression: `(() => {
      const bs = [...document.querySelectorAll('button')].filter((b) => /^(忽略|Dismiss)$/.test((b.textContent || '').trim()) || /dismiss/i.test(b.getAttribute('aria-label') || ''))
      bs.forEach((b) => b.click())
      return bs.length
    })()`,
    returnByValue: true,
  })
await dismiss()
await sleep(400)
await dismiss()

// 找 OOPIF + 等它渲染
let frame = null
for (let i = 0; i < 20 && !frame; i++) {
  const t = await send('Target.getTargets')
  frame = t.result?.targetInfos?.find((x) => x.type === 'iframe' && String(x.url).includes('/api/guests/reeve/'))
  if (!frame) await sleep(500)
}
if (!frame) throw new Error('面板 iframe 没出现')
const att = await send('Target.attachToTarget', { targetId: frame.targetId, flatten: true })
const sid = att.result.sessionId
await send('Runtime.enable', {}, sid)
await send('Page.enable', {}, sid)
for (let i = 0; i < 24; i++) {
  const r = await send('Runtime.evaluate', { expression: 'document.body.innerText.length', returnByValue: true }, sid)
  if (Number(r.result?.result?.value ?? 0) > 200) break
  await sleep(500)
}

// 先试面板本体（OOPIF）的 screencast；拿不到帧退回顶层页面
await send('Page.startScreencast', { format: 'png', everyNthFrame: 1 }, sid)
for (let i = 0; i < 16 && !frames.has(sid); i++) await sleep(500)
await send('Page.stopScreencast', {}, sid)
let data = frames.get(sid)
let source = 'oopif'
if (!data) {
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 2, mobile: false })
  await send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
  for (let i = 0; i < 16 && !frames.has('root'); i++) await sleep(500)
  await send('Page.stopScreencast')
  data = frames.get('root')
  source = 'page'
}
if (!data) {
  // 最后兜底：普通页面截图（面板开着时合成器通常把它带上）
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) {
    data = `data:image/png;base64,${shot.result.data}`
    source = 'page-capture'
  }
}
if (!data) throw new Error('screencast 没有出帧')
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, Buffer.from(data.replace(/^data:image\/png;base64,/, ''), 'base64'))
console.log(`saved ${OUT}（${source} screencast）`)
ws.close()
