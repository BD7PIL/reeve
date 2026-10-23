#!/usr/bin/env node
// 真宿主验收：在 openchamber 里打开 REEVE 面板（OOPIF），断言它真的渲染、没有控制台错误、
// 没有横向溢出、宿主 token 在位、关键内容（免费车道 / @free / 预算 / 三个 tab）都在。
//
//   node scripts/host-audit.mjs --app=http://127.0.0.1:3001/ --cdp=http://127.0.0.1:9222
//   node scripts/host-audit.mjs --app=http://127.0.0.1:4610/ --cdp=http://127.0.0.1:9223 --login \
//     --host-ssh=demo@host --save
//
// `--save`：真宿主的安全保存测试 —— 备份 fallback.jsonc → 面板里加一条临时链 → 保存 →
// 断言 GATE /gate/version 的 chain_targets 真的变了 → finally 原样写回并校验 sha256（GATE 里临时链消失）。
// `--host-ssh`：配置与 GATE 在远端（经 ssh 读写/查询）；CDP 仍是本机能访问到的宿主页面。
//
// 前提：一个已登录 openchamber 的 Chrome/Edge 在 --cdp 上（headless 也行；没有 UI 密码时直接可开）。
// 面板在 OOPIF 里（sandbox 不给 allow-same-origin）：不能读顶层 DOM，必须 Target.attachToTarget。
// 本脚本不打印任何凭据；结果写 preview/host-audit/<host>.json。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
const LOGIN = process.argv.includes('--login')
const PASSWORD = process.env.PEER_UI_PASSWORD ?? ''
const SAVE_TEST = process.argv.includes('--save')
const HOST_SSH = arg('host-ssh', null)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const sshExec = (args, opts = {}) =>
  spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', HOST_SSH, ...args], { encoding: 'utf8', ...opts })
// `~` 在非交互 ssh 的 execFile 参数里别指望远端 shell 展开（实测 status 1/空输出）——先问远端 HOME。
const CONFIG_RAW = arg('config', HOST_SSH ? '~/.config/opencode/reeve/fallback.jsonc' : join(homedir(), '.config', 'opencode', 'reeve', 'fallback.jsonc'))
const CONFIG =
  HOST_SSH && CONFIG_RAW.startsWith('~')
    ? CONFIG_RAW.replace(/^~/, (sshExec(['printenv', 'HOME']).stdout ?? '').trim())
    : CONFIG_RAW
const GATE = arg('gate', 'http://127.0.0.1:18080')
const readConfig = () => (HOST_SSH ? sshExec(['cat', CONFIG]).stdout ?? '' : readFileSync(CONFIG, 'utf8'))
const writeConfig = (text) => {
  if (!HOST_SSH) {
    writeFileSync(CONFIG, text)
    return
  }
  const tmp = join(tmpdir(), `host-audit-${Date.now()}.jsonc`)
  writeFileSync(tmp, text)
  const r = spawnSync('scp', ['-q', '-o', 'BatchMode=yes', tmp, `${HOST_SSH}:${CONFIG}`], { encoding: 'utf8' })
  rmSync(tmp, { force: true })
  if (r.status !== 0) throw new Error(`scp 回写失败：${(r.stderr ?? '').slice(0, 200)}`)
}
const gateVersion = async () => {
  if (!HOST_SSH) return fetch(`${GATE}/gate/version`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json())
  const r = sshExec(['curl', '-s', '--max-time', '4', 'http://127.0.0.1:18080/gate/version'])
  try {
    return JSON.parse(r.stdout || 'null')
  } catch {
    return null
  }
}
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const list = await (await fetch(`${CDP}/json/list`)).json()
const appHost = new URL(APP).host
let page = list.find((t) => t.type === 'page' && String(t.url).includes(appHost))
if (!page && LOGIN) {
  page = await (await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' })).json()
  await sleep(3000)
}
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

if (LOGIN) {
  if (!PASSWORD) {
    console.error('--login 需要 PEER_UI_PASSWORD')
    process.exit(2)
  }
  await send('Page.navigate', { url: APP })
  await sleep(2500)
  await send('Runtime.evaluate', {
    expression: `fetch('/auth/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ${JSON.stringify(PASSWORD)}, trustDevice: true }) }).then((x) => x.status)`,
    awaitPromise: true,
    returnByValue: true,
  })
  await send('Page.reload', { ignoreCache: true })
  await sleep(3500)
}

// 点侧栏入口（最多 10 轮；入口是宿主自己的按钮，按 aria-label/title/文字找）。
// 面板已经开着（比如刚抓过图）就别再点：入口是 toggle，会把它关掉。
const hasPanel = async () => {
  const t = await send('Target.getTargets')
  return Boolean(t.result?.targetInfos?.some((x) => x.type === 'iframe' && String(x.url).includes('/api/guests/reeve/') && String(x.url).includes(appHost)))
}
let clicked = await hasPanel()
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
  frame = t.result?.targetInfos?.find((x) => x.type === 'iframe' && String(x.url).includes('/api/guests/reeve/') && String(x.url).includes(appHost))
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
// 面板是 OOPIF：attach 之后它可能还在挂载（首屏文本从几十字长到整页）；等文本长起来再断言
let ready = 0
for (let i = 0; i < 24 && ready < 200; i++) {
  await sleep(500)
  const probe = await send("Runtime.evaluate", { expression: "document.body.innerText.length", returnByValue: true }, sid)
  ready = Number(probe.result?.result?.value ?? 0)
}

const checks = await send(
  'Runtime.evaluate',
  {
    expression: `(() => {
      const de = document.documentElement
      const rs = getComputedStyle(de)
      const tokens = ['--surface-background', '--surface-elevated', '--surface-subtle', '--interactive-border', '--status-error'].filter((n) => !rs.getPropertyValue(n).trim())
      const text = document.body.innerText
      const must = ['免费车道', '免费车道', '总尝试', '路由链', '调用统计', '任务记录']
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

// ---- 真宿主的安全保存测试（--save）----
// 用面板真的写一次盘：备份 → 加临时链 → 保存 → GATE chain_targets 真变 → finally 原样恢复 + sha256。
let saveReport = null
if (SAVE_TEST) {
  const panelEval = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid)).result?.result?.value
  const chainName = `host-audit-${Date.now().toString(36)}`
  const backup = readConfig()
  const backupHash = sha256(backup)
  let applied = false
  let targets = null
  let error = null
  const step = async (label, expression) => {
    const ok = await panelEval(expression)
    if (ok !== true) throw new Error(`面板步骤失败（${label}）`)
    await sleep(500)
  }
  const clickBtn = (text, scope = 'document') =>
    `(() => { const b = [...${scope}.querySelectorAll('button,[role=button]')].find((b) => ((b.textContent || '').trim()).includes(${JSON.stringify(text)})); if (!b) return false; b.click(); return true })()`
  try {
    if (!backup) throw new Error(`读不到配置：${CONFIG}`)
    await step('新增链', clickBtn('+ 新增链'))
    await step(
      '填链名',
      `(() => { const i = document.querySelector('[data-act="new-chain-row"] input'); if (!i) return false; const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(i, ${JSON.stringify(chainName)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`,
    )
    await step(
      '创建',
      `(() => { const b = [...document.querySelectorAll('[data-act="new-chain-row"] button')].find((b) => (b.textContent || '').trim() === '创建'); if (!b) return false; b.click(); return true })()`,
    )
    await step(
      '添加模型',
      `(() => { const card = document.querySelector('[data-chain="${chainName}"]'); if (!card) return false; const b = [...card.querySelectorAll('button')].find((b) => (b.textContent || '').includes('添加模型')); if (!b) return false; b.click(); return true })()`,
    )
    await step(
      '选一个模型',
      `(() => { const rows = [...document.querySelectorAll('[data-chain="${chainName}"] .oc-sdk-row')]; const r = rows[0]; if (!r) return false; r.click(); return true })()`,
    )
    await step('保存并应用', clickBtn('保存并应用'))
    for (let i = 0; i < 20 && !applied; i++) {
      await sleep(1000)
      applied = String(await panelEval('document.body.innerText')).includes('已生效')
    }
    for (let i = 0; i < 10 && !targets; i++) {
      await sleep(1000)
      const g = await gateVersion()
      const v = g?.chain_targets?.[chainName]
      if (Array.isArray(v) && v.length > 0) targets = v
    }
  } catch (err) {
    error = String(err?.message ?? err)
  } finally {
    // 无论成败都要原样写回（备份在内存里；配置路径与宿主 gate.from 一致）
    let after = ''
    try {
      if (backup) writeConfig(backup)
      after = backup ? readConfig() : ''
    } catch (err) {
      error = `${error ? `${error} / ` : ''}恢复失败：${String(err?.message ?? err)}`
    }
    const restored = Boolean(backup) && after === backup && sha256(after) === backupHash
    // 恢复后 GATE 应把临时链热更掉
    let dropped = false
    for (let i = 0; i < 15 && !dropped; i++) {
      await sleep(1000)
      const g = await gateVersion()
      dropped = !(g?.chain_targets?.[chainName])
    }
    // 面板重载一次（若保存测试中途失败，面板可能还留着草稿）
    await send('Runtime.evaluate', { expression: 'location.reload()' }, sid)
    await sleep(1000)
    saveReport = {
      enabled: true,
      chain: chainName,
      applied,
      targets,
      restored,
      sha256Before: backupHash,
      sha256After: sha256(after),
      gateDropped: dropped,
      error,
    }
    if (error) failures.push(`保存测试：${error}`)
    if (!applied) failures.push('保存测试：面板没有出现「已生效」')
    if (!targets) failures.push('保存测试：GATE chain_targets 里没有临时链')
    if (!restored) failures.push('保存测试：配置没有原样恢复（sha256 不一致）')
    if (!dropped) failures.push('保存测试：恢复后 GATE 仍带着临时链')
  }
}

const report = { app: APP, host: appHost, at: new Date().toISOString(), guest: frame.url.split('?')[0], checks: doc, save: saveReport, consoleErrors, failures }
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`)
console.log(`${failures.length ? 'FAIL' : 'PASS'} 真宿主面板 — ${appHost}（文本 ${doc.textLen} 字；console ${consoleErrors.length}；溢出 ${doc.overflow}）`)
for (const f of failures) console.error(`  · ${f}`)
console.log(`报告：${OUT}`)
ws.close()
process.exit(failures.length ? 1 : 0)
