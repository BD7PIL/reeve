// 1) 项目选择器里选 "Chat"，看是否获得目录上下文
// 2) 打开 Settings → Agents → 新建 → 保存
// 全程走 UI；保存后由外部脚本比对文件 hash。
import { writeFileSync } from 'node:fs'
const NAME = process.argv.includes('--save') ? 'zc-zeroconf-probe' : null

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
    if (r.url.includes('/api/')) {
      const dir = r.headers?.['x-opencode-directory'] || r.headers?.['X-Opencode-Directory']
      net.push(`${r.method} ${r.url.replace('http://127.0.0.1:2610', '')}${dir ? '  [dir=' + decodeURIComponent(dir) + ']' : ''}`)
    }
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

const clickExactText = (text) =>
  evaluate(`
    (() => {
      const el = [...document.querySelectorAll('button,[role=button],[role=option],[role=menuitem],div,span')]
        .filter(e => (e.innerText||'').trim() === ${JSON.stringify(text)} && e.children.length === 0).pop()
      if (!el) return 'not-found'
      ;(el.closest('button,[role=button],[role=option],[role=menuitem]') || el).click()
      return 'clicked'
    })()
  `)

// --- 1) 选 Chat 作为项目 ---
console.log('点 Choose project:', await clickExactText('Choose project'))
await sleep(1500)
console.log('点 Chat:', await clickExactText('Chat'))
await sleep(2500)
const ctx = await evaluate(`
  (() => {
    const t = document.body.innerText
    const m = t.match(/Choose project[\\s\\S]{0,80}/)
    return { label: m ? m[0].replace(/\\n/g, ' | ') : '(找不到 Choose project 标签)' }
  })()
`)
console.log('项目标签区:', JSON.stringify(ctx))

// --- 2) Settings → Agents ---
await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('button')].find(e => (e.getAttribute('title')||'') === 'Settings' || (e.getAttribute('aria-label')||'') === 'Settings')
    if (b) { b.click(); return 'clicked' } return 'not-found'
  })()
`).then((r) => console.log('打开 Settings:', r))
await sleep(2500)
console.log('点 Agents:', await clickExactText('Agents'))
await sleep(2500)

const panel = await evaluate(`
  (() => {
    const d = document.querySelector('[role=dialog]') || document.body
    return d.innerText.slice(-500)
  })()
`)
console.log('\n=== Agents 页（尾部）===')
console.log(String(panel))

// --- 3) 新建 ---
const clickedPlus = await evaluate(`
  (() => {
    const anchor = [...document.querySelectorAll('*')].find(e => /^Total \\d+$/.test((e.innerText||'').trim()) && e.children.length === 0)
    if (!anchor) return 'no-total-anchor'
    const r = anchor.getBoundingClientRect()
    for (const b of document.querySelectorAll('button[data-slot="button"]')) {
      const br = b.getBoundingClientRect()
      if (br.width === 28 && Math.abs(br.top - r.top) < 24 && br.left > 400 && br.left < 1000) {
        b.click(); return 'clicked(' + Math.round(br.x) + ',' + Math.round(br.y) + ')'
      }
    }
    return 'no-plus'
  })()
`)
console.log('\n点 + :', clickedPlus)
await sleep(2500)

// --- 4) 填 + 保存 ---
if (NAME) {
  console.log(
    '\n填表:',
    await evaluate(`
    (() => {
      const set = (el, v) => {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }
      const name = document.querySelector('input[placeholder="agent-name"]')
      const desc = document.querySelector('textarea[placeholder="What does this agent do?"]')
      const prompt = document.querySelector('textarea[placeholder="You are an expert coding assistant..."]')
      if (!name || !desc || !prompt) return '缺字段'
      set(name, ${JSON.stringify(NAME)})
      set(desc, 'zeroconf probe')
      set(prompt, 'throwaway probe: reply with "probe".')
      return '已填 name=' + name.value
    })()
  `),
  )
  await sleep(700)
  console.log(
    '点 Create:',
    await evaluate(`
    (() => {
      const b = [...document.querySelectorAll('button')].find(e => (e.innerText||'').trim() === 'Create' && e.getBoundingClientRect().width > 0)
      if (!b) return 'not-found'
      b.click(); return 'clicked'
    })()
  `),
  )
  await sleep(4000)
  const res = await evaluate(`
    (() => {
      const d = document.querySelector('[role=dialog]') || document.body
      return { hasProbe: d.innerText.includes(${JSON.stringify(NAME)}), tail: d.innerText.slice(-400) }
    })()
  `)
  console.log('\n保存后：列表含 probe =', res.hasProbe)
  console.log(String(res.tail))
}

console.log('\n=== /api/ 调用（含目录头）===')
console.log([...new Set(net)].slice(-12).join('\n') || '(无)')

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync('/tmp/oc-final.png', Buffer.from(shot.data, 'base64'))
console.log('\n截图: /tmp/oc-final.png')
ws.close()