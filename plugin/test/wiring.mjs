// 插件装配层的 **GATE 接线** 验证（src/index.js 的 gate 段 + 统计循环 + dispose）。
//
// 为什么单独一条：entry.mjs 用 `gate:false` 把重 IO 全关掉，只验"装了什么"；
// 而"GATE 真起来了、台账真被读、快照真带 gate 段、卸载后仍然服务（引擎级）、一次性进程能退出"
// 只有把它真起来才能验。这里用**临时端口 + 临时配置 + 临时台账**，不碰真机器状态。
//   node plugin/test/wiring.mjs

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import plugin from '../src/index.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 拿一个当下空闲的端口（起一个临时 server 取 port 再关掉）。 */
async function freePort() {
  const srv = createNetServer()
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const { port } = srv.address()
  await new Promise((r) => srv.close(r))
  return port
}

/** 捕获式 fake ctx（与 entry.mjs 同构：只记挂载点，不真连引擎）。 */
function makeCtx(options) {
  const storage = {
    async get() { return null },
    async set() {},
    async scan() { return { entries: [] } },
  }
  const editor = () => ({ add: () => {}, get: () => undefined, update: () => {}, models: new Map(), agent: () => ({}) })
  return {
    options,
    storage,
    location: { directory: null },
    tool: { transform: async (fn) => { fn(editor()) }, hook: async () => {} },
    session: { hook: async () => {}, interrupt: async () => {} },
    event: { subscribe: () => (async function* () {})() },
    provider: { transform: async (fn) => { fn(editor()) } },
    agent: { transform: async (fn) => { fn({ get: () => undefined, update: () => {} }) }, list: async () => ({ data: [] }) },
    skill: { transform: async (fn) => { fn({ get: () => undefined, add: () => {} }) } },
  }
}

const CONFIG = {
  policy: { max_fallback_attempts: 3, cooldown_seconds: 60, models_ttl_seconds: 300, session_ttl_seconds: 1800 },
  providers: { p1: { base_url: 'http://127.0.0.1:9', models: ['m1'], key: 'none' } },
  chains: { t1: { targets: ['p1/m1'] } },
  agents: { scout: 't1' },
  chain_for_model: { 'reeve/flash': 't1' },
  default_chain: 't1',
}

// ---- 1. gate 开：真起服务 / 快照带 gate 段 / 统计读台账 / 模型候选 ----
{
  const dir = await mkdtemp(join(tmpdir(), 'reeve-wiring-'))
  const port = await freePort()
  const configPath = join(dir, 'fallback.jsonc')
  const ledgerPath = join(dir, 'gate.jsonl')
  const snapPath = join(dir, 'ledger.json')
  await writeFile(configPath, JSON.stringify(CONFIG), 'utf8')
  // 预写台账：一次调用两跳（失败 → 成功）+ 一次直接成功
  const nowIso = new Date().toISOString()
  const rows = [
    { ts: nowIso, req: 1, n: 1, chain: 't1', agent: null, provider: 'p1', model: 'm1', lane: 'native', key: null, status: 'error', code: 429, latency_ms: 30, retries: 0, detail: 'status:429' },
    { ts: nowIso, req: 1, n: 2, chain: 't1', agent: null, provider: 'p2', model: 'm2', lane: 'native', key: 'auth:p2', status: 'ok', code: 200, latency_ms: 40, retries: 0, detail: null },
    { ts: nowIso, req: 2, n: 1, chain: 't1', agent: 'scout', provider: 'p1', model: 'm1', lane: 'native', key: null, status: 'ok', code: 200, latency_ms: 10, retries: 0, detail: null },
  ]
  await writeFile(ledgerPath, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')

  const dispose = await plugin.setup(
    makeCtx({
      gate: { enabled: true, port, configPath, ledgerPath },
      ownEndpoint: false,
      snapshotPath: snapPath,
      retentionDays: 0,
      stats: { intervalMs: 40, modelsIntervalMs: 1, limit: 100, windowMs: 3600_000 },
    }),
  )
  try {
    // GATE 真起来了：版本面可访问
    const ver = await fetch(`http://127.0.0.1:${port}/gate/version`).then((r) => r.json())
    assert.equal(ver.name, 'reeve-gate')
    assert.deepEqual(ver.chains, ['t1'])

    // 等第一轮统计（40ms 间隔 + 余量）
    await sleep(400)
    const snap = JSON.parse(await readFile(snapPath, 'utf8'))
    assert.equal(snap.gate.port, port, '快照 gate 段带端口')
    assert.deepEqual(snap.gate.chains, ['t1'])
    assert.deepEqual(snap.gate.chain_targets, { t1: ['p1/m1'] }, '链候选进快照（面板选择器要用）')
    assert.equal(snap.gate.version, '0.1.0')
    assert.ok(snap.gate.ledger.endsWith('gate.jsonl'))

    assert.equal(snap.stats.source, 'gate.ledger', '统计来源是 GATE 台账')
    assert.equal(snap.stats.gate.requests, 2, '两次调用（预写的台账）')
    assert.equal(snap.stats.gate.fallback.hops, 1)
    assert.equal(snap.stats.gate.byChain[0].chain, 't1')
    assert.deepEqual(snap.stats.orchestrate.queue, { active: 0, waiting: 0 }, '编排台账带着并发闸门数')

    // 模型候选：GATE 目录（声明里 p1/m1 + 链名）∪ 引擎档位
    const refs = (snap.models?.candidates ?? []).map((c) => c.ref)
    assert.ok(refs.includes('p1/m1'), `候选含声明模型（实际：${refs.join(', ')}）`)
    assert.ok(refs.includes('reeve/flash'), '候选含引擎档位模型')
    assert.ok(refs.includes('reeve/pro'), '候选含引擎档位模型（pro）')
    ok('gate 开：真起服务 / 快照 gate 段 / 统计读台账（两跳）/ 模型候选（含链候选）')
  } finally {
    dispose()
    await sleep(150)
    // 卸载 ≠ 关端口：GATE 是**引擎级**服务 —— 起它的工作区被闲置驱逐，不能让其它工作区断代理。
    // 进程退出由"监听口 unref + 空闲连接清扫"保证（下一条用例用子进程钉住）。
    const after = await fetch(`http://127.0.0.1:${port}/gate/version`).then((r) => r.ok, () => false)
    assert.equal(after, true, '插件实例卸载后 GATE 仍在服务')
    await rm(dir, { recursive: true, force: true })
    ok('卸载：GATE 端口留着（引擎级服务，工作区驱逐不带走代理）')
  }
}

// ---- 3. 复用：第二个插件实例（同一台机器、同一个口）接上已在跑的 GATE，不抢口也不误报 ----
{
  const dir = await mkdtemp(join(tmpdir(), 'reeve-wiring-reuse-'))
  const port = await freePort()
  const configPath = join(dir, 'fallback.jsonc')
  await writeFile(configPath, JSON.stringify(CONFIG), 'utf8')
  const firstSnap = join(dir, 'first.json')
  const secondSnap = join(dir, 'second.json')
  const first = await plugin.setup(
    makeCtx({
      gate: { enabled: true, port, configPath, ledgerPath: join(dir, 'gate.jsonl') },
      ownEndpoint: false,
      snapshotPath: firstSnap,
      retentionDays: 0,
      stats: { intervalMs: 0 },
    }),
  )
  const second = await plugin.setup(
    makeCtx({
      gate: { enabled: true, port, configPath, ledgerPath: join(dir, 'gate.jsonl') },
      ownEndpoint: false,
      snapshotPath: secondSnap,
      retentionDays: 0,
      stats: { intervalMs: 0 },
    }),
  )
  try {
    await sleep(400)
    const snap2 = JSON.parse(await readFile(secondSnap, 'utf8'))
    assert.equal(snap2.gate?.error ?? null, null, `第二个实例不该报错（实际：${JSON.stringify(snap2.gate?.error)}）`)
    assert.equal(snap2.gate.reused, true, '标记为复用（不是自己起的）')
    assert.deepEqual(snap2.gate.chains, ['t1'], '复用者也拿到运行态（链列表）')
    assert.deepEqual(snap2.gate.chain_targets, { t1: ['p1/m1'] })
    // 复用者没有 gateHandle：运行态靠 2s 轮询 /gate/version（这里跑过一轮，覆盖该路径）
    await sleep(2400)
    const snap2b = JSON.parse(await readFile(secondSnap, 'utf8'))
    assert.equal(snap2b.gate?.port, port, '复用者的 gate 段仍带端口（轮询路径）')
    // 第二个实例卸载：**不动**别人的 GATE（自己起的才自己关）
    second()
    await sleep(150)
    const still = await fetch(`http://127.0.0.1:${port}/gate/version`).then((r) => r.ok, () => false)
    assert.equal(still, true, '复用者卸载后，原本那台 GATE 照常活着')
    // 轮询失败兜底：owner 关掉后，另一个复用者的下一轮 fetch 会失败（catch），快照保留上一份
    const third = await plugin.setup(
      makeCtx({
        gate: { enabled: true, port, configPath, ledgerPath: join(dir, 'gate.jsonl') },
        ownEndpoint: false,
        snapshotPath: join(dir, 'third.json'),
        retentionDays: 0,
        stats: { intervalMs: 0 },
      }),
    )
    try {
      await sleep(400)
      first()
      await sleep(2600)
      const snap3 = JSON.parse(await readFile(join(dir, 'third.json'), 'utf8'))
      assert.equal(snap3.gate?.port, port, 'GATE 消失后轮询失败，快照保留上一份运行态')
    } finally {
      third()
      await sleep(100)
    }
  } finally {
    first()
    await sleep(150)
    await rm(dir, { recursive: true, force: true })
    ok('复用：第二个实例接上（不抢口/不误报/卸载不动别人的 GATE/轮询失败兜底）')
  }
}

// ---- 2. 端口被占：setup 不抛，gate 段如实报错 ----
{
  const dir = await mkdtemp(join(tmpdir(), 'reeve-wiring-busy-'))
  const busy = createNetServer((s) => s.destroy())
  // 只占口、不回话（连接的来客立刻断 —— 免得探针的 socket 把 close() 拖住）
  busy.on('connection', (s) => s.destroy())
  await new Promise((r) => busy.listen(0, '127.0.0.1', r))
  const port = busy.address().port
  const snapPath = join(dir, 'ledger.json')
  const dispose = await plugin.setup(
    makeCtx({
      gate: { enabled: true, port, configPath: join(dir, 'nope.json'), ledgerPath: join(dir, 'gate.jsonl') },
      ownEndpoint: false,
      snapshotPath: snapPath,
      retentionDays: 0,
      stats: { intervalMs: 0 },
    }),
  )
  try {
    // 快照写入是 250ms 去抖的（第一次 flush 在 gate 段就位之前）——等一拍再读
    await sleep(400)
    const snap = JSON.parse(await readFile(snapPath, 'utf8'))
    assert.ok(snap.gate && typeof snap.gate.error === 'string' && snap.gate.error.length > 0, `gate 段报错（实际：${JSON.stringify(snap.gate)}）`)
    ok('端口被占且不是 GATE：setup 不抛、引擎照常、快照如实报错')
  } finally {
    dispose()
    await new Promise((r) => busy.close(r))
    await rm(dir, { recursive: true, force: true })
  }
}

// ---- 3. 配置热更：改文件 → 快照里的链列表跟着变（≤5s 的宣传口径） ----
{
  const dir = await mkdtemp(join(tmpdir(), 'reeve-wiring-reload-'))
  const port = await freePort()
  const configPath = join(dir, 'fallback.jsonc')
  const snapPath = join(dir, 'ledger.json')
  await writeFile(configPath, JSON.stringify(CONFIG), 'utf8')
  const dispose = await plugin.setup(
    makeCtx({
      gate: { enabled: true, port, configPath, ledgerPath: join(dir, 'gate.jsonl') },
      ownEndpoint: false,
      snapshotPath: snapPath,
      retentionDays: 0,
      stats: { intervalMs: 0 },
    }),
  )
  try {
    const next = { ...CONFIG, chains: { ...CONFIG.chains, t2: { targets: ['p1/m9'] } } }
    await writeFile(configPath, JSON.stringify(next), 'utf8')
    const deadline = Date.now() + 6000
    let chains = []
    while (Date.now() < deadline) {
      chains = await fetch(`http://127.0.0.1:${port}/gate/version`).then((r) => r.json()).then((j) => j.chains)
      if (chains.includes('t2')) break
      await sleep(200)
    }
    assert.deepEqual(chains.sort(), ['t1', 't2'], '改文件后新链生效')
    // 快照的 gate 段也要跟上（面板的"已生效"读快照；统计 60s 一轮，独立 gate 刷新 2s）
    let snapChains = []
    const snapDeadline = Date.now() + 6000
    while (Date.now() < snapDeadline) {
      await sleep(300)
      const s = JSON.parse(await readFile(snapPath, 'utf8'))
      snapChains = s.gate?.chains ?? []
      if (snapChains.includes('t2')) break
    }
    assert.ok(snapChains.includes('t2'), `快照 gate 段 ≤5s 跟上（实际：${snapChains.join('/')}）`)
    ok('配置热更：改 fallback.jsonc → 新链生效（≤5s），快照 gate 段同步跟上')
  } finally {
    dispose()
    await sleep(100)
    await rm(dir, { recursive: true, force: true })
  }
}

// ---- 5. 卸载后一次性进程能退出：监听口必须 unref，否则 `opencode run` 跑完会挂住 ----
{
  const dir = await mkdtemp(join(tmpdir(), 'reeve-wiring-exit-'))
  const port = await freePort()
  const configPath = join(dir, 'fallback.jsonc')
  const snapPath = join(dir, 'ledger.json')
  await writeFile(configPath, JSON.stringify(CONFIG), 'utf8')
  const probe = join(dir, 'exit-probe.mjs')
  await writeFile(
    probe,
    `import { request } from 'node:http'
import plugin from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)}

const [port, configPath, ledgerPath, snapPath] = process.argv.slice(2)
const storage = { async get() { return null }, async set() {}, async scan() { return { entries: [] } } }
const editor = () => ({ add() {}, get() {}, update() {}, models: new Map(), agent: () => ({}) })
const ctx = {
  options: {
    gate: { enabled: true, port: Number(port), configPath, ledgerPath },
    ownEndpoint: false,
    snapshotPath: snapPath,
    retentionDays: 0,
    stats: { intervalMs: 0 },
  },
  storage,
  location: { directory: null },
  tool: { transform: async (fn) => { fn(editor()) }, hook: async () => {} },
  session: { hook: async () => {}, interrupt: async () => {} },
  event: { subscribe: () => (async function* () {})() },
  provider: { transform: async (fn) => { fn(editor()) } },
  agent: { transform: async (fn) => { fn({ get: () => undefined, update: () => {} }) }, list: async () => ({ data: [] }) },
  skill: { transform: async (fn) => { fn({ get: () => undefined, add: () => {} }) } },
}
const dispose = await plugin.setup(ctx)
await new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port: Number(port), path: '/gate/version', agent: false }, (res) => {
    res.resume()
    res.on('end', resolve)
  })
  req.on('error', reject)
  req.end()
})
dispose()
// 刻意不 process.exit：能自然结束，才说明 GATE 没把事件循环吊住
`,
    'utf8',
  )
  const t0 = Date.now()
  const child = spawn(process.execPath, [probe, String(port), configPath, join(dir, 'gate.jsonl'), snapPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''
  child.stderr.on('data', (c) => {
    err += c
  })
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill()
      resolve('timeout')
    }, 8000)
    child.on('exit', (c) => {
      clearTimeout(timer)
      resolve(c)
    })
  })
  const ms = Date.now() - t0
  assert.equal(code, 0, `卸载后子进程应自然退出（实际：${code}；stderr：${err.slice(0, 400)}）`)
  assert.ok(ms < 6000, `退出要快（实际 ${ms}ms）`)
  await rm(dir, { recursive: true, force: true })
  ok(`卸载后一次性进程能退出（${ms}ms —— 监听口 unref，不拖进程）`)
}

console.log(`\n接线测试：${passed} 项全过`)