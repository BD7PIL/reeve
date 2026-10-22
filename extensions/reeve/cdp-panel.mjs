// 用 EL7 上那个 headless Chrome（:9222）真的打开 openchamber，点开 REEVE 面板。
// 走 CDP，不装任何依赖（Node 24 自带全局 WebSocket）。
//
//   node cdp-panel.mjs --cookie-file=/tmp/oc.cookies [--shot=/tmp/reeve-panel.png]
//
// 只做读取与点击：不提交表单、不改任何设置。

import { readFileSync, writeFileSync } from 'node:fs'

const arg = (name, def = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : def
}

const COOKIE_FILE = arg('cookie-file', '/tmp/oc.cookies')
const SHOT = arg('shot', '/tmp/reeve-panel.png')
const APP = arg('app', 'http://127.0.0.1:2610/')

// ---- 从 curl 的 cookie jar 里取会话 cookie ----
const jar = readFileSync(COOKIE_FILE, 'utf8')
const line = jar.split('\n').find((l) => l.includes('oc_ui_session'))
if (!line) throw new Error('cookie jar 里没有 oc_ui_session')
const parts = line.split('\t')
const cookieName = parts[5]
const cookieValue = parts[6]
console.log(`cookie: ${cookieName} (${cookieValue.length} 字符)`)

// ---- 起一个页面 ----
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
let target = targets.find((t) => t.type === 'page')
if (!target) {
  const created = await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })
  target = await created.json()
  if (!target?.webSocketDebuggerUrl) throw new Error('建页面失败：' + JSON.stringify(target))
}
console.log(`target: ${target.id}`)

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})

let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败')
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false })
await send('Network.setCookie', {
  name: cookieName,
  value: cookieValue,
  domain: '127.0.0.1',
  path: '/',
  httpOnly: true,
  sameSite: 'Lax',
})

console.log('导航到 app…')
await send('Page.navigate', { url: APP })
await sleep(6000)

const title = await evaluate('document.title')
console.log(`title: ${title}`)
console.log('页面文本片段:', (await evaluate('document.body.innerText')).slice(0, 300).replace(/\n+/g, ' | '))

// ---- 找 REEVE 的入口 ----
const found = await evaluate(`
  (() => {
    const out = []
    for (const el of document.querySelectorAll('*')) {
      const t = (el.getAttribute && (el.getAttribute('title') || el.getAttribute('aria-label') || '')) || ''
      if (t.includes('REEVE') || t.includes('编排')) {
        out.push({ tag: el.tagName, title: t, cls: (el.className || '').toString().slice(0, 60) })
      }
    }
    return out.slice(0, 10)
  })()
`)
console.log('找到 REEVE 相关元素:', JSON.stringify(found, null, 1))

const clicked = await evaluate(`
  (() => {
    const hit = [...document.querySelectorAll('*')].find((el) => {
      const t = (el.getAttribute && (el.getAttribute('title') || el.getAttribute('aria-label') || '')) || ''
      return t.includes('REEVE') || t.includes('编排')
    })
    if (!hit) return false
    const clickable = hit.closest('button, a, [role=button], [role=tab]') || hit
    clickable.click()
    return { tag: clickable.tagName, title: clickable.getAttribute('title') || clickable.getAttribute('aria-label') || '' }
  })()
`)
console.log('点击结果:', JSON.stringify(clicked))

await sleep(5000)

// ---- 面板可能在 iframe 里：把它的 DOM 也读出来 ----
const iframes = await evaluate(`
  [...document.querySelectorAll('iframe')].map(f => ({ src: (f.getAttribute('src')||'').slice(0,120), id: f.id, title: f.title }))
`)
console.log('iframe:', JSON.stringify(iframes, null, 1))

const bodyText = await evaluate('document.body.innerText')
console.log('点击后的页面文本片段:', bodyText.slice(0, 600).replace(/\n+/g, ' | '))

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
console.log(`截图: ${SHOT}`)

ws.close()