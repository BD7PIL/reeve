// S7a 真机探针（HTTP 面）——施工规格 .zcode/plans/e1-construction-spec.md §7 六项清单的
// 可自动化部分：对一台真实 opencode 宿主的 HTTP API（v1 `/session` 全参面 + v2 `/api/*` 面）
// 做实测取证，产出：
//   1. fixtures/engine/replay/<日期>/recording.json   —— driver.js loadReplayScenarios 可直接装载的录制件
//      （version=1；scenarios[].sessionId/context 用真机实测值）
//   2. .zcode/plans/evidence/s7a-probe-report.json    —— 六项实测结论（§7 映射见 report.probe7；
//      证据区纪律：探针结论是取证证据，落 .zcode（gitignore），不进公开树）
//
// 用法：node plugin/test/fixtures/engine/probe/s7a-http-probe.mjs [--keep-host]
//   --keep-host  保留拉起的宿主进程（调试用；默认探完即杀）
//
// 宿主解析：优先 REEVE_S7A_BASE 指向已运行的宿主；否则在临时项目目录里 spawn
// `opencode serve --port 0`（随机端口——这正是 §7-6 部署形态的实测点之一），从 stdout
// 抓 "opencode server listening on http://..." 的实际端口。
//
// 断言风格：自然退出——每项检查打 PASS/FAIL/BLOCKED 行，基础设施坏了（无宿主/无 create
// 面）退出码 1；单项语义不符（如 metadata 未持久化）是有效实测结论，不算基础设施失败。
// 时钟：本探针自身不用注入时钟——超时用真实 wall clock（真机测量，无可控时钟面）。
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = dirname(HERE) // .../fixtures/engine
// 仓库根的证据区（本文件在 plugin/test/fixtures/engine/probe/，×5 到根）；报告只落证据区，
// 不回 fixtures——带真机临时路径的报告不许进公开树（check-public-tree 门）。
const EVIDENCE_DIR = join(HERE, '..', '..', '..', '..', '..', '.zcode', 'plans', 'evidence')
const KEEP_HOST = process.argv.includes('--keep-host')
const PROMPT_TEXT = 'Reply with exactly: S7A-OK'
const TITLE_PREFIX = 'REEVE-S7A'
const WAIT_MS = 100_000
const POLL_MS = 2_000

const log = (...a) => console.log('[s7a]', ...a)
const basicAuth = () =>
  'Basic ' + Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD ?? ''}`).toString('base64')

// ---- 结果结构 ----
const findings = [] // { item, check, status: PASS|FAIL|BLOCKED, detail }
const record = (item, check, status, detail) => {
  findings.push({ item, check, status, detail })
  log(`${status} §${item} ${check}: ${detail}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const withTimeout = (p, ms, tag) =>
  Promise.race([p, sleep(ms).then(() => { throw new Error(`${tag} 超时 ${ms}ms`) })])

async function api(base, method, path, body, { timeoutMs = 15_000 } = {}) {
  const res = await withTimeout(
    fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: basicAuth() },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    timeoutMs,
    `${method} ${path}`,
  )
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 响应原样留 text */ }
  return { status: res.status, ok: res.ok, json, text }
}

// ---- 宿主拉起 / 复用 ----
async function resolveBase() {
  if (process.env.REEVE_S7A_BASE) {
    const base = process.env.REEVE_S7A_BASE.replace(/\/$/, '')
    const probe = await api(base, 'GET', '/api/agent', undefined, { timeoutMs: 5_000 }).catch(() => null)
    if (probe?.ok) return { base, owned: null, projectDir: process.env.REEVE_S7A_PROJECT ?? '(external)' }
    throw new Error(`REEVE_S7A_BASE=${base} 不可达（/api/agent 无响应）`)
  }
  const proj = mkdtempSync(join(tmpdir(), 'reeve-s7a-'))
  const serveLog = join(proj, 'serve.log')
  // 显式随机端口 = openchamber 部署形态同款（lifecycle.js spawn 'serve --hostname H --port P'，
  // P 每次分配；本探针仿此形态以实测「缺省回环 4096 在部署形态下是否存活」）。
  const explicitPort = 10_000 + Math.floor(Math.random() * 20_000)
  const args = ['serve', '--hostname', '127.0.0.1', '--port', String(explicitPort), '--log-level', 'INFO']
  const child = spawn('opencode', args, { cwd: proj, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise((resolve, reject) => {
    const buf = []
    const timer = setTimeout(() => reject(new Error('宿主 40s 内未报监听端口')), 40_000)
    const onData = (d) => {
      buf.push(d)
      const m = buf.join('').match(/opencode server listening on http:\/\/127\.0\.0\.1:(\d+)/)
      if (m) { clearTimeout(timer); resolve(Number(m[1])) }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`宿主提前退出 code=${code}（日志 ${serveLog}）`)) })
  })
  const portMode = { requested: explicitPort, bound: port } // 相等 → --port 按请求绑定
  // stdout/stderr 已消费用于抓端口；后续输出丢弃（挂 ignore 防管道背压）
  child.stdout.removeAllListeners('data'); child.stderr.removeAllListeners('data')
  child.stdout.resume(); child.stderr.resume()
  return { base: `http://127.0.0.1:${port}`, owned: { child, proj, serveLog }, projectDir: proj, portMode }
}

function stopOwned(owned) {
  if (!owned) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(owned.child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    owned.child.kill('SIGTERM')
  }
}

// ---- SSE 事件收集（/api/event）----
async function collectEvents(base, stopSignal) {
  const events = []
  try {
    const res = await fetch(base + '/api/event', {
      headers: { accept: 'text/event-stream', authorization: basicAuth() },
      signal: stopSignal.signal,
    })
    if (!res.ok || !res.body) { record(4, 'SSE /api/event', 'BLOCKED', `status=${res.status}`); return events }
    const decoder = new TextDecoder()
    let buf = ''
    const pump = async () => {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '')
          buf = buf.slice(idx + 1)
          // 兼容两种流格式：SSE（"data: {...}"）与裸 JSON 行
          const payload = line.startsWith('data:') ? line.slice(5).trim() : line.trim()
          if (!payload.startsWith('{')) continue
          if (!payload || payload === '[DONE]') continue
          try { events.push({ t: Date.now(), ...(JSON.parse(payload)) }) } catch { /* 半行忽略 */ }
        }
      }
    }
    await pump().catch(() => { /* abort 正常退出 */ })
  } catch (e) {
    if (!stopSignal.aborted) record(4, 'SSE /api/event', 'BLOCKED', String(e))
  }
  return events
}

// ---- 主流程 ----
const host = await resolveBase()
const base = host.base
log('宿主 =', base, '项目 =', host.projectDir)
let exitCode = 0
const raw = { create: {}, context: {}, events: [], readback: {}, misc: {} }
try {
  // ---- §7-6 前置事实：本进程 env + 部署形态下的缺省回环端口死活 ----
  raw.misc.envOpencodeServerPort = process.env.OPENCODE_SERVER_PORT ?? null
  raw.misc.portMode = host.portMode
  const fallbackProbe = await api('http://127.0.0.1:4096', 'GET', '/api/agent', undefined, { timeoutMs: 4_000 }).catch((e) => ({ err: String(e) }))
  const actualProbe = await api(base, 'GET', '/api/agent', undefined, { timeoutMs: 5_000 })
  record(6, 'OPENCODE_SERVER_PORT 环境值', 'PASS', `process.env=${JSON.stringify(raw.misc.envOpencodeServerPort)}（探针进程内未设置）`)
  record(6, '部署形态下缺省回环 127.0.0.1:4096', fallbackProbe.err ? 'PASS' : 'FAIL',
    fallbackProbe.err
      ? `不可达（${fallbackProbe.err.slice(0, 80)}）——显式随机端口形态下 deep-memory 缺省兜底指向死端口（S7b driver 必须改从宿主 face/env 取实际端口）`
      : `意外可达：${fallbackProbe.status}（若非本探针宿主占用则另有实例在 4096）`)
  record(6, '实际宿主端口可达', actualProbe.ok ? 'PASS' : 'FAIL', `${base} /api/agent status=${actualProbe.status}；请求端口=${host.portMode?.requested} 绑定端口=${host.portMode?.bound}`)
  raw.misc.fallbackProbe = fallbackProbe.err ?? { status: fallbackProbe.status }
  raw.misc.actualAgentEnvelope = actualProbe.json

  // ---- 选模型：优先 xiaomi（免费层），否则取 providers 表第一个有模型的 ----
  const prov = await api(base, 'GET', '/config/providers')
  let model = null
  const providers = prov.json?.data ?? prov.json?.providers ?? []
  for (const p of providers) {
    const first = p.models && Object.values(p.models)[0]
    if (first) { model = { providerID: p.id, id: first.id ?? first.name }; if (p.id === 'xiaomi') break }
  }
  record(1, 'providers 表可得', model ? 'PASS' : 'BLOCKED', model ? `选用 ${model.providerID}/${model.id}` : `providers 列表空（status=${prov.status}）`)
  if (!model) throw new Error('无可用模型，后续 prompt 类实测无从进行')

  // ---- §7-4：先开事件订阅，再动会话 ----
  const stopSignal = new AbortController()
  const eventPromise = collectEvents(base, stopSignal)

  // ---- §7-1：create 面可用性 + 返回形状（v1 全参路由 + v2 路由各一发）----
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const meta = { reeveRunId: 's7a-probe-run', stepId: 'probe-step-1', nested: { deep: true } }
  const c1 = await api(base, 'POST', '/session', { title: `${TITLE_PREFIX} parent ${ts}` })
  raw.create.v1Parent = { status: c1.status, body: c1.json ?? c1.text?.slice(0, 300) }
  const parent = c1.json?.data?.id ?? c1.json?.id ?? c1.json?.info?.id
  record(1, 'POST /session（v1 全参路由）', c1.ok && parent ? 'PASS' : 'FAIL', `status=${c1.status} id=${parent ?? '未取得'} 返回顶层键=${c1.json ? Object.keys(c1.json).join(',') : '非JSON'}`)
  if (!parent) throw new Error('create 面完全不可用——基础设施失败')

  const c2 = await api(base, 'POST', '/api/session', { model: { providerID: model.providerID, id: model.id } })
  raw.create.v2Route = { status: c2.status, body: c2.json ?? c2.text?.slice(0, 300) }
  record(1, 'POST /api/session（v2 路由）', c2.ok ? 'PASS' : 'FAIL', `status=${c2.status} 返回形状=${c2.json ? (c2.json.data?.id ? '{data:{id,…}}（信封状）' : '扁平') : '非JSON'}——deep-memory 兼容读取 result?.id ?? result?.data?.id 的两条分支都在 HTTP 面出现`)
  const v2SessionId = c2.json?.data?.id ?? c2.json?.id
  // v2 路由塞 metadata：schema additionalProperties:false → 应被拒（§7-2 的路由面结论）
  const c2m = await api(base, 'POST', '/api/session', { metadata: meta, model: { providerID: model.providerID, id: model.id } })
  raw.create.v2RouteMeta = { status: c2m.status, body: (c2m.json ?? c2m.text)?.toString?.().slice(0, 200) }
  record(2, 'v2 路由对 metadata 键的宽容度', c2.ok ? 'PASS' : 'BLOCKED',
    `POST /api/session +metadata → status=${c2m.status}（${c2m.ok ? '被接受：engine 层对额外键宽松，HTTP schema 的 additionalProperties:false 与服务端实际行为不符' : '被拒：metadata 只能走 v1 全参路由/插件 face'}）`)
  if (v2SessionId) await api(base, 'DELETE', `/api/session/${v2SessionId}`).catch(() => {})

  const idPattern = /^[a-z0-9]+_[a-z0-9]+$/.test(parent) ? String(parent).split('_')[0] + '_…' : String(parent).slice(0, 8)
  record(1, '会话 id 形状', 'PASS', `前缀=${idPattern}（完整 id 已入录制件，不在此展开）`)

  // ---- §7-2：metadata 持久化（v1 全参路由）----
  const c3 = await api(base, 'POST', '/session', {
    title: `${TITLE_PREFIX} meta ${ts}`,
    metadata: meta,
    model: { providerID: model.providerID, id: model.id },
  })
  raw.create.withMeta = { status: c3.status, requestHadMetadata: true }
  const metaSession = c3.json?.data?.id ?? c3.json?.id
  const rb1 = metaSession ? await api(base, 'GET', `/session/${metaSession}`) : null
  const rb2 = metaSession ? await api(base, 'GET', `/api/session/${metaSession}`) : null
  const readMeta = (j) => j?.data?.metadata ?? j?.metadata ?? null
  const gotMeta1 = rb1 ? readMeta(rb1.json) : null
  const gotMeta2 = rb2 ? readMeta(rb2.json) : null
  const persisted = canonicalEq(gotMeta1, meta) || canonicalEq(gotMeta2, meta)
  record(2, 'create 带 metadata → 读回', c3.ok ? (persisted ? 'PASS' : 'FAIL') : 'BLOCKED',
    persisted
      ? `metadata 原样持久化（读回 ${canonicalEq(gotMeta1, meta) ? 'v1 路由' : 'v2 路由'}）`
      : `create status=${c3.status}；v1 读回=${JSON.stringify(gotMeta1)?.slice(0, 120)}；v2 读回=${JSON.stringify(gotMeta2)?.slice(0, 120)} → HTTP 面不保 metadata，锚点维持 parentID+title 前缀方案`)
  raw.readback.metaV1 = rb1?.json ?? null
  raw.readback.metaV2 = rb2?.json ?? null

  // ---- §7-5：parentID 子会话 ----
  const c4 = await api(base, 'POST', '/session', {
    title: `${TITLE_PREFIX} child ${ts}`,
    parentID: parent,
    model: { providerID: model.providerID, id: model.id },
  })
  raw.create.withParent = { status: c4.status }
  const child = c4.json?.data?.id ?? c4.json?.id
  record(5, 'parentID 建子会话', c4.ok && child ? 'PASS' : 'FAIL', `status=${c4.status} child=${child ?? '未取得'}`)

  // ---- §7-3 + §7-4：真发 prompt，读 context 形状，抓事件时序 ----
  const p1 = await api(base, 'POST', `/api/session/${child}/prompt`, { prompt: { text: PROMPT_TEXT } })
  raw.create.promptRoute = { route: '/api/session/{id}/prompt', status: p1.status, sentBody: 'prompt:{text}' }
  if (!p1.ok) {
    const p2 = await api(base, 'POST', `/session/${child}/message`, { parts: [{ type: 'text', text: PROMPT_TEXT }] })
    raw.create.promptRoute.v1Fallback = { route: '/session/{id}/message', status: p2.status }
    record(3, 'prompt 路由', p2.ok ? 'PASS' : 'FAIL', `v2(body=prompt:{text})=${p1.status}${p1.json ? ' ' + JSON.stringify(p1.json).slice(0, 120) : ''} → v1=${p2.status}`)
  } else {
    record(3, 'prompt 路由', 'PASS', '/api/session/{id}/prompt 可用（body=prompt:{text}）')
  }

  let ctxShape = null
  let lastCtxRaw = null
  const deadline = Date.now() + WAIT_MS
  while (Date.now() < deadline) {
    await sleep(POLL_MS)
    const w = await api(base, 'GET', `/api/session/${child}/context`)
    lastCtxRaw = { status: w.status, body: w.json ?? w.text?.slice(0, 400) }
    const entries = w.json?.data ?? w.json
    const assistant = Array.isArray(entries) ? entries.find((m) => m?.role === 'assistant' || m?.info?.role === 'assistant') : null
    if (assistant) { ctxShape = w.json; break }
    const st = await api(base, 'GET', `/session/${child}/status`).catch(() => null)
    if (st?.json && JSON.stringify(st.json).match(/"(error|errored)"/i)) { ctxShape = w.json; break }
  }
  const ctxEntries = ctxShape?.data ?? ctxShape
  record(3, 'context 返回形状（子会话，回环兜底路由）', Array.isArray(ctxEntries) && ctxEntries.length > 0 ? 'PASS' : 'FAIL',
    Array.isArray(ctxEntries) && ctxEntries.length > 0
      ? `GET /api/session/{id}/context → ${ctxEntries.length} 条；首条顶层键=${Object.keys(ctxEntries[0]).join(',')}${okText ? '；含期望应答 S7A-OK' : ''}`
      : `最终响应 status=${lastCtxRaw?.status} body=${JSON.stringify(lastCtxRaw?.body)?.slice(0, 200)}——回环兜底路由在该宿主上不可用/为空`)
  // v1 message 列表（ctx 面的姊妹形状，driver 读结果的另一条实测路径）
  const msgList = await api(base, 'GET', `/session/${child}/message`)
  const msgs = msgList.json?.data ?? msgList.json
  raw.context.childMessages = msgList.json ?? msgList.text?.slice(0, 400)
  record(3, 'v1 message 列表形状', Array.isArray(msgs) && msgs.length > 0 ? 'PASS' : 'FAIL',
    `GET /session/{id}/message → ${Array.isArray(msgs) ? `${msgs.length} 条` : JSON.stringify(msgs)?.slice(0, 120)}${Array.isArray(msgs) && msgs.length > 0 ? `；条目顶层键=${Object.keys(msgs[0]).slice(0, 8).join(',')}` : ''}`)
  raw.context.childLastCtxRaw = lastCtxRaw
  const okText = JSON.stringify(ctxEntries ?? '').includes('S7A-OK') || JSON.stringify(msgs ?? '').includes('S7A-OK')

  const ctxParent = await api(base, 'GET', `/api/session/${parent}/context`)
  const parentEntries = ctxParent.json?.data ?? ctxParent.json
  record(5, '父会话 context 隔离',
    ctxParent.ok ? (Array.isArray(parentEntries) && parentEntries.length === 0 ? 'PASS' : 'FAIL') : 'BLOCKED',
    ctxParent.ok
      ? `父会话 context ${JSON.stringify(parentEntries)?.slice(0, 100)}（应为空——driver 按 child id 读结果互不串线）`
      : `回环 context 路由对该宿主报 ${ctxParent.status}（ref=${ctxParent.json?.data?.ref ?? 'n/a'}）——隔离性在该宿主上无从经此路由测量，改由 v1 message 列表佐证：父会话 ${JSON.stringify((await api(base, 'GET', `/session/${parent}/message`)).json?.data ?? []).length} 条`)

  // §7-5 关键甄别：子会话的消息落在哪个 id 下（hook 侧考据发现「resumed 转发用根会话 id」形态）。
  // 三方对照：child 列表 / parent 列表 / 无关会话（meta）列表，逐条看 info.sessionID。
  const parentMsgList = await api(base, 'GET', `/session/${parent}/message`)
  const parentMsgs = parentMsgList.json?.data ?? parentMsgList.json
  const metaMsgList = await api(base, 'GET', `/session/${metaSession}/message`)
  const metaMsgs = metaMsgList.json?.data ?? metaMsgList.json
  raw.context.parentMessages = parentMsgList.ok ? parentMsgList.json : { status: parentMsgList.status }
  raw.context.metaMessages = metaMsgList.ok ? metaMsgList.json : { status: metaMsgList.status }
  const sessIdOf = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map((m) => m?.info?.sessionID ?? m?.sessionID ?? '∅'))]
  const childCount = Array.isArray(msgs) ? msgs.length : -1
  const parentCount = Array.isArray(parentMsgs) ? parentMsgs.length : -1
  const metaCount = Array.isArray(metaMsgs) ? metaMsgs.length : -1
  record(5, '子会话消息归属（root 转发形态甄别）', childCount >= 0 && parentCount >= 0 && metaCount >= 0 ? 'PASS' : 'BLOCKED',
    `prompt 发给 child 后：child 列表 ${childCount} 条 sessionID={${sessIdOf(msgs).join(',')}}；parent 列表 ${parentCount} 条 sessionID={${sessIdOf(parentMsgs).join(',')}}；无关会话（meta）列表 ${metaCount} 条——${parentCount === 0 ? '消息只落在 child id（driver 按 child id 读结果成立）' : parentCount > 0 && metaCount === 0 ? '消息镜像到 parent 列表（家族共享）；driver 读结果须甄别 info.sessionID' : '列表疑似按项目聚合而非按会话（meta 会话也可见）——按 id 读结果前必须先验证 info.sessionID'}`)

  const kids = await api(base, 'GET', `/session/${parent}/children`)
  const kidList = kids.json?.data ?? kids.json
  const childListed = JSON.stringify(kidList ?? '').includes(String(child))
  record(5, 'children 列表归属', kids.ok && childListed ? 'PASS' : 'FAIL',
    `GET /session/{id}/children status=${kids.status} 含 child=${childListed}`)
  const childRecord = await api(base, 'GET', `/session/${child}`)
  const recParent = childRecord.json?.data?.parentID ?? childRecord.json?.parentID
  record(5, '子会话记录 parentID 回读', canonicalEq(recParent, parent) ? 'PASS' : 'FAIL', `record.parentID=${JSON.stringify(recParent)}（锚点可查）`)
  raw.context.parent = ctxParent.json
  raw.readback.childRecord = childRecord.json

  // ---- 事件面收尾：给 SSE 一点余量再断流 ----
  await sleep(1_500)
  stopSignal.abort()
  raw.events = await eventPromise
  const types = [...new Set(raw.events.map((e) => e.type))]
  const execEvts = raw.events.filter((e) => String(e.type).startsWith('session.execution.'))
  const childEvts = raw.events.filter((e) => String(JSON.stringify(e)).includes(String(child)))
  const withLocation = raw.events.filter((e) => e.location?.directory !== undefined)
  record(4, '事件流可见性', raw.events.length > 0 ? 'PASS' : 'FAIL', `共 ${raw.events.length} 条，types=${types.join(',') || '无'}`)
  record(4, 'execution 生命周期事件', execEvts.length > 0 ? 'PASS' : 'FAIL',
    `session.execution.* 计 ${execEvts.length} 条：${execEvts.map((e) => e.type).join(',') || '无'}`)
  record(4, '事件带 location.directory', withLocation.length > 0 ? 'PASS' : 'FAIL',
    withLocation.length > 0 ? `样例 directory=${JSON.stringify(withLocation[0].location.directory)}` : '事件无 location 字段——跨项目过滤面不可用')
  record(4, '子会话事件归属', childEvts.length > 0 ? 'PASS' : 'FAIL', `含 child id 的事件 ${childEvts.length} 条（idle 驱动重轮询按此对齐）`)
  raw.misc.eventTypes = types

  // ---- 清理（best effort）+ 写录制件 ----
  for (const sid of [child, metaSession, parent].filter(Boolean)) {
    await api(base, 'DELETE', `/session/${sid}`, undefined, { timeoutMs: 8_000 }).catch(() => {})
  }

  const recDate = new Date().toISOString().slice(0, 10)
  const recDir = join(FIXTURES, 'replay', recDate)
  // context 录制源：优先回环兜底路由（/api/.../context），空则用 v1 message 列表条目
  const v1MsgEntries = Array.isArray(msgs)
    ? msgs.map((m) => (m?.info && m?.parts ? m : { role: m?.info?.role ?? m?.role, parts: m?.parts ?? m?.info?.parts ?? [m] }))
    : []
  const childCtx = Array.isArray(ctxEntries) && ctxEntries.length > 0 ? ctxEntries : v1MsgEntries
  const ctxSource = Array.isArray(ctxEntries) && ctxEntries.length > 0 ? 'GET /api/session/{id}/context' : (v1MsgEntries.length > 0 ? 'GET /session/{id}/message（v1 面，context 兜底路由为空时的替代形状）' : '')
  if (childCtx.length === 0) record(3, '录制件 context', 'BLOCKED', '子会话 context 为空——录制件不含 context 实测（S7b 需补录）')
  else record(3, '录制件 context', 'PASS', `来源=${ctxSource}，${childCtx.length} 条`)
  const recording = {
    version: 1,
    recordedAt: new Date().toISOString(),
    host: `opencode serve --hostname 127.0.0.1 --port ${host.portMode?.requested}（显式随机端口=openchamber 部署形态同款）@ ${base}；探针 ${process.platform}`,
    note: `S7a HTTP 面录制（context 来源：${ctxSource || '无'}）：POST /session 建子会话 + /api/session/{id}/prompt 真发 + context 实测形状`,
    scenarios: [{
      name: 's7a-http-child',
      match: { prompt: PROMPT_TEXT, title: `${TITLE_PREFIX} child ${ts}`, model },
      sessionId: child,
      result: [{ status: okText ? 'done' : 'failed', ...(okText ? { text: 'S7A-OK' } : {}) }],
      ...(childCtx.length > 0 ? { context: childCtx } : {}),
    }],
  }
  mkdirSync(recDir, { recursive: true })
  const recPath = join(recDir, 'recording.json')
  writeFileSync(recPath, JSON.stringify(recording, null, 2) + '\n')
  log('录制件 →', recPath)

  const report = {
    probe: 's7a-http-probe',
    ranAt: new Date().toISOString(),
    host: { base, projectDir: host.projectDir, spawned: Boolean(host.owned), portMode: host.portMode },
    prompt: PROMPT_TEXT,
    model,
    probe7: findings,
    raw,
  }
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, 's7a-probe-report.json'), JSON.stringify(report, null, 2) + '\n')
  log('报告 →', join(EVIDENCE_DIR, 's7a-probe-report.json'))

  if (findings.some((f) => f.status === 'FAIL' && ['create 面完全不可用'].includes(f.check))) exitCode = 1
  const fails = findings.filter((f) => f.status === 'FAIL').length
  const blocked = findings.filter((f) => f.status === 'BLOCKED').length
  log(`总结：PASS=${findings.length - fails - blocked} FAIL=${fails} BLOCKED=${blocked}`)
} catch (e) {
  exitCode = 1
  log('FATAL', e?.stack ?? String(e))
} finally {
  if (host.owned && !KEEP_HOST) {
    stopOwned(host.owned)
    try { rmSync(host.owned.proj, { recursive: true, force: true, maxRetries: 2 }) } catch { /* 临时目录尽力而为 */ }
  }
}
process.exit(exitCode)

// ---- 工具 ----
function canonicalEq(a, b) {
  const cj = (v) => {
    if (Array.isArray(v)) return `[${v.map(cj).join(',')}]`
    if (v !== null && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${cj(v[k])}`).join(',')}}`
    return JSON.stringify(v) ?? 'undefined'
  }
  return cj(a) === cj(b)
}
