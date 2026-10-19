// 清理：用页面上下文里的同源 fetch 调面板自己的删除端点，然后确认文件消失。
const NAME = 'zc-zeroconf-probe'
const DIR = '/home/demo/.reeve-staging/work'
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes('2610'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
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
await send('Runtime.enable')

const res = await evaluate(`
  (async () => {
    const url = '/api/config/agents/' + encodeURIComponent(${JSON.stringify(NAME)}) + '?directory=' + encodeURIComponent(${JSON.stringify(DIR)})
    const r = await fetch(url, { method: 'DELETE', headers: { 'x-opencode-directory': ${JSON.stringify(DIR)} } })
    let body = ''
    try { body = JSON.stringify(await r.json()).slice(0, 300) } catch (e) { body = '(无 JSON)' }
    return { status: r.status, body }
  })()
`)
console.log('删除请求:', JSON.stringify(res, null, 1))

const check = await evaluate(`
  (async () => {
    const url = '/api/config/agents/' + encodeURIComponent(${JSON.stringify(NAME)}) + '?directory=' + encodeURIComponent(${JSON.stringify(DIR)})
    const r = await fetch(url, { headers: { 'x-opencode-directory': ${JSON.stringify(DIR)} } })
    const j = await r.json()
    return { status: r.status, mdExists: j?.sources?.md?.exists, isBuiltIn: j?.isBuiltIn }
  })()
`)
console.log('复查:', JSON.stringify(check))
ws.close()