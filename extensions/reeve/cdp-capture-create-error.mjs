// 捕获 Create 的 HTTP 响应体 —— 拿到面板保存失败的确切原因。
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes('2610'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
let seq = 0
const pending = new Map()
const reqs = new Map()
const done = []
ws.addEventListener('message', async (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
    return
  }
  if (m.method === 'Network.requestWillBeSent' && m.params.request.url.includes('/api/config/agents')) {
    reqs.set(m.params.requestId, m.params.request)
  }
  if (m.method === 'Network.responseReceived' && reqs.has(m.params.requestId)) {
    done.push({ req: reqs.get(m.params.requestId), status: m.params.response.status, rid: m.params.requestId })
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

// 确保表单还在、名字还在
const state = await evaluate(`
  (() => {
    const name = document.querySelector('input[placeholder="agent-name"]')
    const btn = [...document.querySelectorAll('button')].find(e => (e.innerText||'').trim() === 'Create' && e.getBoundingClientRect().width > 0)
    return { name: name ? name.value : '(无表单)', hasCreate: !!btn }
  })()
`)
console.log('表单状态:', JSON.stringify(state))
if (state.hasCreate && !state.name) {
  await evaluate(`
    (() => {
      const el = document.querySelector('input[placeholder="agent-name"]')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'zc-zeroconf-probe')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return el.value
    })()
  `)
}

console.log(
  '点 Create:',
  await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('button')].find(e => (e.innerText||'').trim() === 'Create' && e.getBoundingClientRect().width > 0)
    if (!b) return 'not-found'; b.click(); return 'clicked'
  })()
`),
)
await sleep(3500)

for (const d of done) {
  console.log(`\n--- ${d.req.method} ${d.req.url.replace('http://127.0.0.1:2610', '')}  → HTTP ${d.status}`)
  console.log('    body:', (d.req.postData || '(无)').slice(0, 400))
  console.log('    目录头:', d.req.headers['x-opencode-directory'] || '(无)')
  try {
    const body = await send('Network.getResponseBody', { requestId: d.rid })
    console.log('    响应:', String(body.body).slice(0, 400))
  } catch (e) {
    console.log('    （取不到响应体）')
  }
}

// 界面上有没有报错提示
const toast = await evaluate(`
  (() => {
    const t = document.body.innerText
    const lines = t.split('\\n').filter(l => /error|fail|invalid|项目|directory/i.test(l))
    return lines.slice(-8)
  })()
`)
console.log('\n界面里像报错的行:', JSON.stringify(toast))
ws.close()