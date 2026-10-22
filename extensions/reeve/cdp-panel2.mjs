// 读面板 iframe 里的真实 DOM（包含 console 报错），确认它渲染成什么样。
//   node cdp-panel2.mjs
import { writeFileSync } from 'node:fs'

const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes('2610'))
if (!page) throw new Error('没找到 openchamber 页面；先跑 cdp-panel.mjs')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})

let seq = 0
const pending = new Map()
const contexts = []
const consoleMsgs = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
    return
  }
  if (m.method === 'Runtime.executionContextCreated') contexts.push(m.params.context)
  if (m.method === 'Runtime.consoleAPICalled') {
    consoleMsgs.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`)
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleMsgs.push(`EXCEPTION: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression, contextId) => {
  const r = await send('Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text }
  return { value: r.result.value }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Runtime.enable')
await send('Page.enable')
await sleep(1500)

const tree = await send('Page.getFrameTree')
const walk = (f, out = []) => {
  out.push({ id: f.frame.id, url: f.frame.url, name: f.frame.name })
  for (const c of f.childFrames ?? []) walk(c, out)
  return out
}
const frames = walk(tree.frameTree)
console.log('frames:')
for (const f of frames) console.log(`  ${f.url.slice(0, 90)}`)

const guestFrame = frames.find((f) => f.url.includes('/api/guests/'))
if (!guestFrame) throw new Error('页面里没有 guest iframe')

const ctx = contexts.find((c) => c.auxData?.frameId === guestFrame.id)
console.log(`guest 上下文: ${ctx ? '有 (id=' + ctx.id + ')' : '没有'}`)
if (!ctx) {
  console.log('已知上下文:', contexts.map((c) => `${c.id}@${c.origin}`).join(', '))
  throw new Error('拿不到 guest frame 的执行上下文')
}

const bodyText = await evaluate('document.body ? document.body.innerText : "(no body)"', ctx.id)
console.log('\n=== 面板内文本 ===')
console.log(typeof bodyText.value === 'string' ? bodyText.value || '(空)' : JSON.stringify(bodyText))

const header = await evaluate('document.getElementById("root") ? document.getElementById("root").innerText : "(no #root)"', ctx.id)
console.log('\n=== #root 文本 ===')
console.log(typeof header.value === 'string' ? header.value || '(空)' : JSON.stringify(header))

const html = await evaluate('document.getElementById("root") ? document.getElementById("root").innerHTML.slice(0, 1200) : ""', ctx.id)
console.log('\n=== #root HTML（前 1200）===')
console.log(typeof html.value === 'string' ? html.value : JSON.stringify(html))

console.log('\n=== console 消息 ===')
console.log(consoleMsgs.slice(-15).join('\n') || '(无)')

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('/tmp/reeve-panel2.png', Buffer.from(shot.data, 'base64'))
console.log('\n截图: /tmp/reeve-panel2.png')
ws.close()