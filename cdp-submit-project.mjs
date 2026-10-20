// 在 Projects 页输入路径并提交，把一个 staging 目录注册成项目（REEVE_PROJECT_DIR 可覆盖）。
import { homedir } from 'node:os'
const DIR = process.env.REEVE_PROJECT_DIR || `${homedir()}/.reeve-staging/work`
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes('2610'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
let seq = 0
const pending = new Map()
const net = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
    return
  }
  if (m.method === 'Network.requestWillBeSent') {
    const r = m.params.request
    if (r.method !== 'GET' && r.url.includes('/api/')) net.push(`${r.method} ${r.url.replace('http://127.0.0.1:2610', '')} :: ${(r.postData || '').slice(0, 200)}`)
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
  if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text }
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await send('Runtime.enable')
await send('Network.enable')

console.log(
  '填路径:',
  await evaluate(`
  (() => {
    const el = [...document.querySelectorAll('input')].find(e => (e.getAttribute('placeholder')||'').startsWith('Enter path'))
    if (!el) return 'no-field'
    el.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(DIR)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'filled: ' + el.value
  })()
`),
)
await sleep(1200)

console.log('\n回车提交:', await evaluate(`
  (() => {
    const el = [...document.querySelectorAll('input')].find(e => (e.getAttribute('placeholder')||'').startsWith('Enter path'))
    if (!el) return 'no-field'
    for (const type of ['keydown','keypress','keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
    }
    return 'sent-enter'
  })()
`))
await sleep(1000)

// 如果回车没提交，找找有没有 Add / Open 按钮
const btn = await evaluate(`
  (() => {
    const names = ['add', 'add project', 'open', 'open project', 'save', 'create', '添加', '打开']
    const b = [...document.querySelectorAll('button')].filter(e => e.getBoundingClientRect().width > 0)
      .find(e => names.includes((e.innerText||'').trim().toLowerCase()))
    if (!b) return 'no-submit-button'
    b.click(); return 'clicked: ' + b.innerText.trim()
  })()
`)
console.log('提交按钮:', btn)
await sleep(4000)

const state = await evaluate(`
  (() => {
    const d = document.querySelector('[role=dialog]') || document.body
    const t = d.innerText
    const m = t.match(/Total \\d+/)
    return { total: m ? m[0] : '(找不到 Total)', tail: t.slice(-400) }
  })()
`)
console.log('\n=== 提交后 ===')
console.log('项目数标签:', state.total)
console.log(String(state.tail))
console.log('\n=== 写请求 ===')
console.log(net.slice(-8).join('\n') || '(无)')
ws.close()