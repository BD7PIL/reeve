// GATE 的离线验收：单元（纯逻辑，假时钟）+ 集成（环回 stub 上游，零真实出网）。
//
// 覆盖（对应 docs/GATE 的计划 §4.1/4.2）：
//   路由解析 / 尝试计划（跳过 no-op·无 provider·无键、上限、冷却、多键）/ 错误分类（永不换·必换·白名单·文本兜底）/
//   会话状态机（单向、冷却、粘性、恢复、TTL 有界、去重）/ 请求构造（透传逐字保留 vs 原生最小集、模型映射、tools 不动）/
//   台账（字段、轮转、金丝雀密钥不出现）/ 配置（坏文件回落、问题如实报）/
//   集成（快乐路径、各种首字节前失败换候选、不换的情形、上限、冷却粘性、流式不缓冲、客户端断开、provider 重试、
//   多键轮转、目录聚合与 TTL、session 桥与 next、热更、dispose、端口冲突、零出网）
//   node plugin/test/gate.mjs

import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BUNDLED_FALLBACK_PATH, defaultFallbackConfigPath, loadGateConfig, normalizeGateConfig, stripLineComments, POLICY_DEFAULTS } from '../src/gate/config.js'
import { classifyFailure, statusOf } from '../src/gate/classify.js'
import { createSessionStore } from '../src/gate/state.js'
import { IMAGE_CHAINS, attemptRow, buildUpstreamRequest, forwardedHeaders, hasImage, modelsPathOf, parseTarget, planAttempts, resolveKeyFor, routeFor } from '../src/gate/lanes.js'
import { createLedger, probeGate, startGate } from '../src/gate/gate.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

const CANARY = 'canary-CANARY-abc123XYZdef456'
const SESSION = 'ses_abc123def456gh'
const silent = { debug: () => {} }

// ── 公共夹具 ────────────────────────────────────────────────────────────────
const cfg = (raw) => normalizeGateConfig(raw)
assert.ok(defaultFallbackConfigPath().replaceAll('\\', '/').endsWith('.config/opencode/reeve/fallback.jsonc'), '默认配置路径')

/** 可编程 stub 上游：handler(req, res, state) 完全自己写响应；请求头/体原样记下。 */
const makeStub = async (handler) => {
  const state = { requests: [], aborted: 0, calls: 0 }
  const srv = createServer((req, res) => {
    state.calls += 1
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('aborted', () => (state.aborted += 1))
    req.on('close', () => {
      if (!res.writableEnded) state.aborted += 1
    })
    req.on('end', () => {
      state.requests.push({ url: req.url, method: req.method, headers: req.headers, body })
      handler(req, res, state, body)
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return {
    port: srv.address().port,
    url: `http://127.0.0.1:${srv.address().port}`,
    state,
    close: () => new Promise((r) => srv.close(() => r())),
  }
}
const sse = (res, chunks) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const c of chunks) res.write(c)
  res.end()
}
const SSE_OK = (res) => sse(res, [`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`, 'data: [DONE]\n\n'])
const json = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

/** 零出网保证：包一层 fetch，目标 host 必须是环回（等价 ocrc 的 offline-proof）。 */
const loopbackGuard = (inner = fetch) => {
  const seen = []
  const wrapped = async (url, init) => {
    const u = new URL(String(url))
    seen.push(u.href)
    assert.equal(u.hostname, '127.0.0.1', `GATE 不该出网（除环回）：${u.href}`)
    return inner(url, init)
  }
  wrapped.seen = seen
  return wrapped
}

/** 起一套一次性栈：stub 上游 → 配置文件 → GATE（注入 fetch/时钟/sleep）。 */
const harness = async ({ stubs = {}, providers = {}, chains = {}, agents = {}, policy = {}, auth = {}, defaultChain = undefined, chainForModel = undefined, free = undefined, gateOptions = {} } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-'))
  const up = {}
  for (const [name, handler] of Object.entries(stubs)) up[name] = await makeStub(handler)
  const providerEntries = {}
  for (const [id, v] of Object.entries(providers)) providerEntries[id] = { ...v }
  for (const [name, s] of Object.entries(up)) {
    const given = providerEntries[name]
    if (!given) {
      providerEntries[name] = { base_url: s.url, key: 'none', models: ['*'] }
      continue
    }
    if (!given.base_url) given.base_url = s.url
    // stub 上游默认免键（除非测试显式给了 auth/key 来验证多键或 env 引用）
    if (given.key === undefined && given.auth === undefined) given.key = 'none'
  }
  const raw = { schema: 1, policy, providers: providerEntries, chains, agents, default_chain: defaultChain ?? Object.keys(chains)[0], chain_for_model: chainForModel ?? {}, ...(free ? { free } : {}) }
  const configPath = join(dir, 'reeve-fallback.jsonc')
  await writeFile(configPath, JSON.stringify(raw, null, 2))
  const authPath = join(dir, 'auth.json')
  await mkdir(join(dir), { recursive: true })
  await writeFile(authPath, JSON.stringify(auth))
  let t = 1_000_000
  const now = gateOptions.now ?? (() => t)
  const fetchImpl = loopbackGuard(gateOptions.fetchImpl ?? fetch)
  const gate = await startGate({
    port: 0,
    configPath,
    bundledPath: BUNDLED_FALLBACK_PATH,
    ledgerPath: join(dir, 'gate.jsonl'),
    authPath,
    logger: silent,
    now,
    fetchImpl,
    sleepImpl: () => Promise.resolve(),
    configWatchMs: gateOptions.configWatchMs ?? 1_000_000, // 默认关掉热更，热更测试自己开
    ...gateOptions,
  })
  return {
    gate,
    dir,
    configPath,
    up,
    fetchImpl,
    advance: (ms) => (t += ms),
    close: async () => {
      await gate.dispose()
      for (const s of Object.values(up)) await s.close()
      await gate.flushLedger?.()
      // Windows 上 rm 可能与迟到的写入抢文件（ENOTEMPTY）：退避重试，测试清理不该因此挂
      for (let i = 0; i < 4; i++) {
        try {
          await rm(dir, { recursive: true, force: true })
          break
        } catch {
          await new Promise((r) => setTimeout(r, 50))
        }
      }
    },
  }
}

/** 向 GATE 发一笔 chat（可带客户端形状的头），返回 { status, headers, text, chunks }。 */
const post = (gate, body, { headers = {}, _collectChunks = false } = {}) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest({ host: '127.0.0.1', port: gate.port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers } }, (res) => {
      const chunks = []
      let text = ''
      res.on('data', (c) => {
        chunks.push(c.toString('utf8'))
        text += c.toString('utf8')
      })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, chunks }))
    })
    req.on('error', reject)
    req.end(payload)
  })

const getJson = (gate, path) =>
  new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: gate.port, path, method: 'GET' }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
    req.end()
  })

const postJson = (gate, path, body) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {})
    const req = httpRequest({ host: '127.0.0.1', port: gate.port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
    req.end(payload)
  })

// ---- 1a. 集成：图片请求从 reasoning 改道 vision（会话模型不动） ----
{
  const h = await harness({
    stubs: { paid: (_req, res) => SSE_OK(res), vis: (_req, res) => SSE_OK(res) },
    chains: { reasoning: { targets: ['paid/m1'] }, vision: { targets: ['vis/m2'] } },
    defaultChain: 'reasoning',
  })
  try {
    const text = await post(h.gate, { model: 'reasoning', stream: true, messages: [{ role: 'user', content: '只回复 ok' }] })
    assert.equal(text.status, 200)
    assert.equal(JSON.parse(h.up.paid.state.requests[0].body).model, 'm1', '纯文本仍走 reasoning 首跳')
    assert.equal(h.up.vis.state.requests.length, 0, '纯文本不碰 vision')

    const img = await post(h.gate, {
      model: 'reasoning',
      stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] }],
    })
    assert.equal(img.status, 200)
    assert.equal(h.up.vis.state.requests.length, 1, '图片改道 vision')
    const wire = JSON.parse(h.up.vis.state.requests[0].body)
    assert.equal(wire.model, 'm2', '线上模型是 vision 首跳')
    assert.ok(JSON.stringify(wire.messages).includes('image_url'), '图片原样到达 vision 上游')
    assert.equal(img.headers['x-reeve-fallback'], '1/vis/m2', '响应头标出真实目标')
    ok('集成·图片改道：reasoning 纯文本不变、图片走 vision 且附件送达')
  } finally {
    await h.close()
  }
}

// ---- 1. 路由解析 ----
{
  const sessions = createSessionStore({ now: () => 0, policy: {} })
  const config = cfg({
    providers: { a: { base_url: 'http://x.test', key: 'none' }, b: { base_url: 'http://y.test', key: 'none' } },
    chains: { reasoning: { targets: ['a/m1', 'b/m2'] }, shared: { targets: ['b/m9'] } },
    agents: { planner: 'reasoning' },
    chain_for_model: { 'b/m9': 'shared' },
    default_chain: 'reasoning',
  })
  config.env = {}
  config.auth = {}
  sessions.setAgent(SESSION, 'planner')
  // ① agent 的链（请求就是它的首选）
  assert.deepEqual(routeFor({ model: 'a/m1', sessionID: SESSION }, { config, sessions })?.chain, 'reasoning', 'agent 链优先（请求=首选）')
  // ② 用户显式换了别的模型 → 直投（尊重人的选择）
  const override = routeFor({ model: 'b/m2', sessionID: SESSION }, { config, sessions })
  assert.equal(override?.kind, 'direct', '显式换模型 → 直投')
  assert.deepEqual(override.targets, [{ provider: 'b', model: 'm2' }])
  // ③ 链名直接命中
  assert.equal(routeFor({ model: 'shared', sessionID: null }, { config, sessions })?.chain, 'shared', '链名命中')
  // ④ session/agent 不明 → chain_for_model 兜底
  assert.equal(routeFor({ model: 'b/m9', sessionID: null }, { config, sessions })?.chain, 'shared', 'chain_for_model 兜底')
  // ⑤ 裸模型名（无 `provider/` 前缀）→ default_chain；写了前缀却没人认识 → null（404，不拿兜底链顶替）
  assert.equal(routeFor({ model: 'bare-name', sessionID: null }, { config, sessions })?.chain, 'reasoning', '裸名 → default_chain')
  assert.equal(routeFor({ model: 'zz/whatever', sessionID: null }, { config, sessions }), null, '未知 provider → null（调用方 404）')
  // ⑥ 多斜杠模型名（9router 的 oc/xxx）
  assert.deepEqual(parseTarget('9router/oc/mimo-v2.6-flash-free'), { provider: '9router', model: 'oc/mimo-v2.6-flash-free' })
  assert.equal(parseTarget('nope'), null)
  assert.equal(parseTarget('/x'), null)
  // ⑦ 没有可用的链/直投 → null（调用方 404）
  const bare = cfg({ providers: { a: { base_url: 'http://x.test', key: 'none' } }, chains: {}, default_chain: null })
  bare.env = {}
  bare.auth = {}
  assert.equal(routeFor({ model: 'a/m1', sessionID: null }, { config: bare, sessions })?.kind, 'direct', '空链但可直投')
  assert.equal(routeFor({ model: 'nope/xx', sessionID: null }, { config: bare, sessions }), null, '都不认识 → null')
  ok('路由：agent 链 / 用户换模型直投 / 链名 / chain_for_model / default_chain / 多斜杠 / 404')
}

// ---- 1b. 图片检测与改道映射 ----
{
  const openai = { messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] }] }
  const anthropic = { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] }] }
  const gemini = { contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AAA' } }] }] }
  const textOnly = { messages: [{ role: 'user', content: '只回复 ok' }] }
  assert.equal(hasImage(openai), true, 'OpenAI image_url')
  assert.equal(hasImage(anthropic), true, 'Anthropic image')
  assert.equal(hasImage(gemini), true, 'Gemini inlineData')
  assert.equal(hasImage(textOnly), false, '纯文本不误判')
  assert.equal(hasImage(null), false, '空 body 不炸')
  assert.deepEqual(IMAGE_CHAINS, { reasoning: 'vision' }, '只有 reasoning 需要改道 vision')
  ok('图片检测：OpenAI/Anthropic/Gemini；reasoning→vision')
}

// ---- 1c. 单目标链：只计划一次，不借助 default_chain/免费 ----
{
  const sessions = createSessionStore({ now: () => 0, policy: {} })
  const config = cfg({
    providers: { p: { base_url: 'http://x.test', key: 'none' } },
    chains: { solo: { targets: ['p/m'] } },
    default_chain: 'solo',
    policy: { max_fallback_attempts: 6 },
  })
  config.env = {}
  config.auth = {}
  const route = routeFor({ model: 'solo', sessionID: null }, { config, sessions })
  const plan = planAttempts(route, { config, sessions, sessionID: null })
  assert.equal(plan.ordered.length, 1, '单目标链只有 1 个候选')
  assert.equal(plan.chainName, 'solo')
  ok('单目标链：只计划一次（无自动回退）')
}

// ---- 2. 尝试计划：静态过滤、上限、冷却、多键 ----
{
  const sessions = createSessionStore({ now: () => 0, policy: { cooldown_seconds: 60 } })
  const config = cfg({
    policy: { max_fallback_attempts: 3, cooldown_seconds: 60 },
    providers: {
      ok: { base_url: 'http://a.test', key: 'none' },
      nokey: { base_url: 'http://b.test', auth: ['missing-provider'] },
      noloc: { key: 'none' },
    },
    chains: { c: { targets: ['ok/m1', 'nokey/m2', 'noloc/m3', 'ok/m1', 'ok/m4', 'ok/m5'] } },
    default_chain: 'c',
  })
  config.env = {}
  config.auth = {}
  const plan = planAttempts(routeFor({ model: 'c', sessionID: null }, { config, sessions }), { config, sessions })
  assert.deepEqual(plan.ordered.map((t) => `${t.provider.id}/${t.model}`), ['ok/m1', 'ok/m4', 'ok/m5'], '顺序保持 + 跳过无 key/无 base_url + 去掉重复的 no-op')
  assert.deepEqual(plan.skipped.map((s) => s.why).sort(), ['no-key', 'no-op', 'no-provider'], '跳过原因如实报')
  assert.ok(plan.ordered.length <= 3, '上限截断（max_fallback_attempts=3）')

  // 冷却：m1 失败后，下一次请求从 m4 起（跳过冷却中的 m1）
  sessions.noteFailure('(anon)', 'c', 'ok/m1')
  const plan2 = planAttempts(routeFor({ model: 'c', sessionID: null }, { config, sessions }), { config, sessions })
  assert.equal(plan2.ordered[0].model, 'm4', '冷却中的候选被跳过（起点顺延）')
  assert.equal(plan2.ordered.length, 2, '剩下的候选照走（m4/m5）')

  // 全部冷却：仍然要有第一个尝试（请求总得有人接）
  const solo = cfg({ providers: { ok: { base_url: 'http://a.test', key: 'none' } }, chains: { c: { targets: ['ok/only'] } }, default_chain: 'c' })
  solo.env = {}
  solo.auth = {}
  const s2 = createSessionStore({ now: () => 0, policy: { cooldown_seconds: 60 } })
  s2.noteFailure('(anon)', 'c', 'ok/only')
  assert.equal(planAttempts(routeFor({ model: 'c', sessionID: null }, { config: solo, sessions: s2 }), { config: solo, sessions: s2 }).ordered.length, 1, '全在冷却也保留第一个尝试')

  // 多键：keyPicker 注入（服务侧会传轮转实现）
  const multi = cfg({ providers: { p: { base_url: 'http://p.test', auth: ['p1', 'p2'] } }, chains: { c: { targets: ['p/m'] } }, default_chain: 'c' })
  multi.env = {}
  multi.auth = { p1: { key: 'k1' }, p2: { key: 'k2' } }
  let cursor = 0
  const picker = (provider) => {
    const ids = provider.auth
    const at = cursor++ % ids.length
    return { key: multi.auth[ids[at]].key, name: `auth:${ids[at]}` }
  }
  const route = routeFor({ model: 'c', sessionID: null }, { config: multi, sessions })
  const a1 = planAttempts(route, { config: multi, sessions, keyPicker: picker })
  const a2 = planAttempts(route, { config: multi, sessions, keyPicker: picker })
  assert.equal(a1.ordered[0].key, 'auth:p1')
  assert.equal(a2.ordered[0].key, 'auth:p2', '多键轮转（游标在服务侧，纯逻辑只负责取）')
  assert.equal(resolveKeyFor(multi.providers.p, { env: {}, auth: { p2: { key: 'k2' } } }).name, 'auth:p2', '缺第一把键时顺延到下一把')
  assert.equal(resolveKeyFor(cfg({ providers: { q: { base_url: 'http://q.test', key: 'env.Q_KEY' } } }).providers.q, { env: {}, auth: {} }), null, 'env 引用缺值 → 不可达')
  assert.equal(resolveKeyFor(cfg({ providers: { q: { base_url: 'http://q.test', key: 'public' } } }).providers.q, { env: {}, auth: {} }).key, 'public', '公开字面量可用')
  ok('尝试计划：顺序/跳过三类原因/上限/冷却顺延/全冷保留首试/多键轮转与降级')
}

// ---- 2b. lanes 的边角：解析/取键/路径/路由/转发头/构造（纯函数逐条钉） ----
{
  // parseTarget：空、无斜杠、半引用（provider/）、多斜杠模型名
  assert.equal(parseTarget(null), null, 'null 不炸')
  assert.equal(parseTarget(undefined), null, 'undefined 不炸')
  assert.equal(parseTarget(''), null, '空串 → null')
  assert.equal(parseTarget('noslash'), null, '没有斜杠 → null')
  assert.equal(parseTarget('p/'), null, 'provider/ 不算合法候选（GATE 不做"同模型换 provider"的 wildcard；写进配置会被归到 problems）')
  assert.deepEqual(parseTarget(' 9r/oc/x '), { provider: '9r', model: 'oc/x' }, '两侧空白剥掉、只在第一个斜杠切')
  assert.equal(modelsPathOf({ path: '/api/coding/paas/v4/chat/completions' }), '/api/coding/paas/v4/models', 'chat/completions → models')
  assert.equal(modelsPathOf({}), '/v1/models', '没写 path → 默认 /v1/models')
  assert.equal(modelsPathOf({ path: '/x/v1' }), '/x/v1', '不该动的路径原样（只有 chat/completions 才换）')

  // resolveKeyFor：env 有值/空串、auth 里非字符串、字面量、none
  assert.deepEqual(resolveKeyFor({ key: 'none', id: 'p' }), { key: null, name: null }, 'none = 明确不需要键')
  assert.deepEqual(resolveKeyFor({ id: 'p', key: 'env.K' }, { env: { K: 'kv' } }), { key: 'kv', name: 'env.K' })
  assert.equal(resolveKeyFor({ id: 'p', key: 'env.K' }, { env: { K: '' } }), null, 'env 是空串 = 没有')
  assert.equal(resolveKeyFor({ id: 'p', auth: [123, 'a'] }, { auth: { a: { key: 42 } } }), null, 'auth 里的非字符串键值不认')
  assert.equal(resolveKeyFor({ id: 'p', auth: ['a'] }, { auth: { a: { key: 'k' } } }).name, 'auth:a')

  // routeFor：空 model / 空链 / 未知 provider-model
  const config = cfg({
    providers: { p: { base_url: 'http://p.test', key: 'none' } },
    chains: { c: { targets: ['p/m1'] }, empty: { targets: [] } },
    default_chain: 'c',
  })
  config.env = {}
  config.auth = {}
  const sessions = createSessionStore({ now: () => 0, policy: { cooldown_seconds: 60 } })
  assert.equal(routeFor({ model: '' }, { config, sessions }), null, '空 model → 没有路由')
  assert.equal(routeFor({ model: 42 }, { config, sessions }), null, '非字符串 model → 没有路由')
  assert.ok(config.problems.some((p) => p.includes('chains.empty')), '空链在配置加载期就被丢掉并进 problems（如实报）')
  assert.equal(routeFor({ model: 'empty' }, { config, sessions }).chain, 'c', '裸名兜底走 default_chain（不会静默停在空链上）')
  assert.equal(routeFor({ model: 'p/m1' }, { config, sessions }).kind, 'direct', '直投 provider/model')
  assert.equal(routeFor({ model: 'c' }, { config, sessions }).kind, 'chain', '链名命中')

  // planAttempts：直投（非链）不读 session 指针；forwardedHeaders 跳过 undefined；构造非 JSON 体
  const directPlan = planAttempts(routeFor({ model: 'p/m1' }, { config, sessions }), { config, sessions, sessionID: 'ses_x' })
  assert.equal(directPlan.chainName, 'direct:p/m1', '直投的 chainName = direct:<ref>')
  assert.equal(directPlan.ordered[0].key, null, 'key:none → 没有 authorization')

  const fh = forwardedHeaders({ a: undefined, b: 'x', Host: 'h', 'content-length': '1', 'x-opencode-session-id': 'ses_1' }, { authorization: 'Bearer k' })
  assert.deepEqual(fh, { b: 'x', 'x-opencode-session-id': 'ses_1', authorization: 'Bearer k' }, '剥逐跳/长度头、跳过 undefined、authorization 由通道替换')

  const attempt = { provider: config.providers.p, model: 'm1', key: null, authorization: null }
  const raw = buildUpstreamRequest({ attempt, inHeaders: { 'content-type': 'text/plain' }, bodyText: 'not json', version: '0.1.0' })
  assert.equal(raw.body, 'not json', '非 JSON 体原样透传（不去猜）')
  assert.equal(raw.headers['content-type'], 'text/plain', 'native 通道保留调用方的 content-type')
  assert.equal(raw.headers.accept, '*/*', 'accept 缺省 */*')
  assert.equal(raw.headers['user-agent'], 'reeve-gate/0.1.0')
  const row = attemptRow({ ts: 'T', chainName: 'c', agent: null, attempt, status: 'error', code: 500, latencyMs: Number.NaN })
  assert.equal(row.latency_ms, null, '非有限延迟 → null（不写 NaN）')
  ok('lanes 边角：解析/取键/路径/路由/转发头/构造（逐条）')
}

// ---- 3. 错误分类 ----
{
  const policy = { retry_on_errors: [401, 402, 403, 429, 500, 503, 529] }
  const c = (o) => classifyFailure({ ...o, policy })
  assert.equal(c({ status: 429 }).retryable, true, '白名单 429')
  assert.equal(c({ status: 400 }).retryable, false, '400 不换')
  assert.equal(c({ status: 401 }).retryable, true, '401（额度/凭据类，迁移自你的取值）')
  assert.equal(c({ status: 404, text: 'The model xxx was not found' }).retryable, true, 'model_not_found 语义必换')
  assert.equal(c({ status: 404, text: 'no such route' }).retryable, false, '普通 404 不换')
  assert.equal(c({ status: 500, error: { message: 'quota exceeded for this key' } }).retryable, true, '额度语义必换')
  assert.equal(c({ status: 500, text: '额度不足，请充值' }).retryable, true, '中文额度文案')
  assert.equal(c({ status: 500, text: '今日使用上限已达' }).reason, 'always:quota', '中文使用上限')
  assert.equal(c({ error: { name: 'MessageAbortedError', message: 'aborted' } }).retryable, false, 'abort 永不换')
  assert.equal(c({ error: { name: 'ContextOverflowError', message: 'context length exceeded' } }).retryable, false, '上下文超限永不换')
  assert.equal(c({ error: { data: { statusCode: 503 } } }).retryable, true, '嵌套状态码提取（data.statusCode）')
  assert.equal(c({ text: 'upstream said 429, try again' }).retryable, true, '文本里的裸数字')
  assert.equal(c({ status: 502, text: 'rate limit exceeded' }).retryable, true, '文本兜底 rate limit')
  assert.equal(c({ status: 503, headers: { 'retry-after': '30' } }).retryable, true, '9router 冷却期 503+retry-after')
  assert.equal(c({ status: 502, error: { isRetryable: true } }).reason, 'explicit', '显式 isRetryable（5xx 安全）')
  assert.equal(c({ status: 500, error: { isRetryable: true } }).reason, 'status:500', '白名单先于显式信号（码已在名单里）')
  assert.equal(c({ status: 400, error: { isRetryable: true } }).retryable, false, '显式 isRetryable 但状态码不安全 → 拒绝')
  assert.equal(c({ status: 200, text: 'ok' }).retryable, false, '正常响应不换')
  assert.equal(statusOf({ text: 'HTTP 503 from upstream', policy }), 503, 'statusOf 从文本提取白名单数字')
  ok('错误分类：永不换/必换/白名单/嵌套码/文本兜底/安全阀/retry-after')
}

// ---- 3b. 错误分类的边角（嵌套形状 / 各语义臂 / statusOf 的兜底） ----
{
  const policy = { retry_on_errors: [401, 402, 403, 429, 500, 503, 529] }
  const c = (o) => classifyFailure({ ...o, policy })
  // statusOf：嵌套五处 + 文本兜底 + 一个都不是 → null
  assert.equal(statusOf({ error: { status: 502 } }), 502, 'error.status')
  assert.equal(statusOf({ error: { data: { status: 500 } } }), 500, 'error.data.status')
  assert.equal(statusOf({ error: { error: { statusCode: 529 } } }), 529, 'error.error.statusCode')
  assert.equal(statusOf({ error: { error: { status: 429 } } }), 429, 'error.error.status')
  assert.equal(statusOf({ error: { cause: { statusCode: 503 } } }), 503, 'error.cause.statusCode')
  assert.equal(statusOf({ error: { cause: { status: 500 } } }), 500, 'error.cause.status')
  assert.equal(statusOf({ error: { message: 'boom 503 now' }, policy }), 503, 'error.message 里的白名单数字')
  assert.equal(statusOf({ policy }), null, '一处都没有 → null')
  assert.equal(statusOf({ status: 42 }), null, '两位状态码不算（<100）')
  // NEVER：上下文超限的其它写法
  assert.equal(c({ text: 'too many tokens for this model' }).reason, 'never:context', 'too many tokens 永不换')
  assert.equal(c({ text: '上下文长度超出限制' }).reason, 'never:context', '中文上下文超限')
  // ALWAYS：quota 家族 / 模型不存在 / 缺键
  assert.equal(c({ text: 'resource exhausted' }).reason, 'always:quota')
  assert.equal(c({ text: 'out of credits' }).reason, 'always:quota')
  assert.equal(c({ text: 'Payment Required' }).reason, 'always:quota')
  assert.equal(c({ text: '模型不存在' }).reason, 'always:model', '中文模型不存在')
  assert.equal(c({ text: 'model not supported here' }).reason, 'always:model')
  // zen 对未知模型返回 400 + "Upstream request failed: Model is unavailable." —— 必须当模型错误换候选
  assert.equal(c({ status: 400, text: '{"error":{"type":"server_error","message":"Upstream request failed: Model is unavailable."}}' }).reason, 'always:model', 'Model is unavailable → 必换')
  assert.equal(c({ text: 'The model `x` does not exist' }).reason, 'always:model')
  assert.equal(c({ text: 'missing api key' }).reason, 'always:key')
  assert.equal(c({ text: 'api key not set' }).reason, 'always:key')
  // 显式信号：data.isRetryable + 安全阀（408/425 也算安全）
  assert.equal(c({ status: 408, error: { data: { isRetryable: true } } }).reason, 'explicit', 'data.isRetryable + 408')
  assert.equal(c({ status: 400, error: { data: { isRetryable: true } } }).reason, 'explicit-unsafe-status', 'data.isRetryable + 400 → 拒绝')
  // 文本兜底：中英文各一 + 白名单数字（文本里）
  assert.equal(c({ status: 502, text: '请求过于频繁' }).retryable, true, '中文限流文案')
  assert.equal(c({ status: 502, text: 'service unavailable' }).retryable, true, 'service unavailable')
  assert.equal(c({ status: 502, text: 'HTTP 529 overloaded' }).reason.startsWith('text'), true, '裸数字 / 文案都算文本兜底')
  ok('错误分类边角：statusOf 八处形状 / NEVER 与 ALWAYS 各臂 / 显式信号安全阀 / 文本兜底')
}

// ---- 4. 会话状态机（假时钟） ----
{
  let t = 0
  const store = createSessionStore({ now: () => t, policy: { cooldown_seconds: 60, session_ttl_seconds: 600, restore_primary_after_cooldown: false } })
  const keys = ['p/a', 'p/b', 'p/c']
  store.noteFailure('s1', 'chain', 'p/a')
  t += 61_000 // 冷却过期
  store.noteFailure('s1', 'chain', 'p/b')
  const adv1 = store.advance('s1', 'chain', keys, { dedupeKey: 'err1' })
  assert.equal(adv1.model, 'p/c', '单向推进：跳过冷却中的 a、走到 c')
  const adv2 = store.advance('s1', 'chain', keys, { dedupeKey: 'err1' })
  assert.equal(adv2.model, 'p/c', '同一失败的两条事件只推进一次（去重键）')
  const adv3 = store.advance('s1', 'chain', keys, { dedupeKey: 'err2' })
  assert.equal(adv3.model, null, '到链尾 → null（不再回头）')
  assert.equal(store.startIndex('s1', 'chain', keys), 2, '粘性：起点停在切到的候选')
  // 恢复：冷却全过期 + restore=true → 指针归零
  const restore = createSessionStore({ now: () => t, policy: { cooldown_seconds: 60, restore_primary_after_cooldown: true } })
  restore.noteFailure('s2', 'chain', 'p/a')
  restore.noteSuccess('s2', 'chain', 'p/b', keys)
  assert.equal(restore.startIndex('s2', 'chain', keys), 1, '冷却未过期：粘在 b')
  t += 61_000
  assert.equal(restore.startIndex('s2', 'chain', keys), 0, '冷却过期 + restore=true：回到主候选')
  // TTL 驱逐 + 条数上限
  let t2 = 0
  const bounded = createSessionStore({ now: () => t2, policy: { session_ttl_seconds: 10 }, maxSessions: 5 })
  for (let i = 0; i < 20; i++) bounded.setAgent(`s${i}`, 'x')
  assert.ok(bounded.size() <= 5, `条数上限生效（实际 ${bounded.size()}）`)
  t2 += 11_000
  for (let i = 0; i < 20; i++) bounded.setAgent(`s${i}`, 'x') // touchedAt 更新发生在 setAgent
  assert.ok(bounded.size() <= 5, 'TTL + 上限下有界')
  ok('会话状态机：单向/冷却过期/去重推进/粘性/恢复开关/TTL 有界')
}

// ---- 5. 请求构造：透传 vs 原生、模型映射、tools 不动 ----
{
  const attemptOf = (lane, authorization) => ({ provider: cfg({ providers: { p: { base_url: 'http://p.test', lane } } }).providers.p, model: 'oc/mimo', key: 'auth:x', authorization })
  const inHeaders = {
    'content-type': 'application/json',
    authorization: 'Bearer engine-placeholder',
    'user-agent': 'opencode/latest/2.0.32/cli',
    'x-opencode-session-id': SESSION,
    'x-opencode-session': SESSION,
    'x-session-affinity': SESSION,
    'x-session-id': SESSION,
    'x-opencode-client': 'cli',
    'x-opencode-project': 'proj-1',
    connection: 'keep-alive',
    'content-length': '123',
    'accept-encoding': 'gzip, deflate',
  }
  const body = JSON.stringify({ model: 'reasoning', stream: true, reasoning_effort: 'xhigh', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'read', description: 'd', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }] })
  const passthrough = buildUpstreamRequest({ attempt: attemptOf('passthrough', 'Bearer public'), inHeaders, bodyText: body })
  assert.equal(passthrough.headers['user-agent'], 'opencode/latest/2.0.32/cli', '透传：UA 逐字保留（客户端身份就是它的意义）')
  for (const k of ['x-opencode-session-id', 'x-opencode-session', 'x-session-affinity', 'x-session-id', 'x-opencode-client', 'x-opencode-project'])
    assert.equal(passthrough.headers[k], inHeaders[k], `透传保留 ${k}`)
  assert.equal(passthrough.headers.authorization, 'Bearer public', 'Authorization 换成通道的键')
  for (const k of ['connection', 'content-length', 'accept-encoding', 'host']) assert.equal(passthrough.headers[k], undefined, `剥掉 ${k}`)
  assert.equal(JSON.parse(passthrough.body).model, 'oc/mimo', '模型名映射成候选的模型')
  assert.equal(JSON.parse(passthrough.body).reasoning_effort, 'xhigh', '推理强度原样透传（GATE 只换 model）')
  assert.deepEqual(JSON.parse(passthrough.body).tools, JSON.parse(body).tools, 'tools 原样（深比）')
  assert.equal(passthrough.url, 'http://p.test/v1/chat/completions', '默认 path')
  const native = buildUpstreamRequest({ attempt: attemptOf('native', 'Bearer sk-x'), inHeaders, bodyText: body })
  assert.equal(native.headers['x-opencode-session-id'], undefined, '原生通道不漏会话头给第三方上游')
  assert.equal(native.headers['user-agent'].startsWith('reeve-gate/'), true, '原生通道用自己的 UA')
  assert.equal(native.headers.authorization, 'Bearer sk-x')
  assert.equal(forwardedHeaders({ 'X-Weird': 'v' })['X-Weird'], 'v', 'forwardedHeaders 保留未知头（大小写照原样）')
  ok('请求构造：透传逐字（UA+四个 session 头）/ 剥逐跳头与编码 / 模型映射+effort 透传 / tools 深比 / 原生最小集')
}

// ---- 5b. probeGate：复用探针（引擎按工作区加载插件 → 后面的实例要能认出"已经在跑的 GATE"） ----
{
  const okProbe = await probeGate({ port: 18080, fetchImpl: async (url) => {
    assert.ok(String(url).endsWith('/gate/version'), '探的是 /gate/version')
    return { ok: true, json: async () => ({ name: 'reeve-gate', version: '0.1.0', port: 18080, chains: ['c'], chain_targets: { c: ['p/m'] }, problems: [], sessions: { sessions: 1 } }) }
  } })
  assert.equal(okProbe.ok, true)
  assert.equal(okProbe.snapshot.port, 18080)
  assert.deepEqual(okProbe.snapshot.chain_targets, { c: ['p/m'] })
  assert.deepEqual(okProbe.snapshot.chains, ['c'])
  assert.deepEqual(okProbe.snapshot.problems, [])

  const other = await probeGate({ port: 18080, fetchImpl: async () => ({ ok: true, json: async () => ({ name: '别的东西' }) }) })
  assert.equal(other.ok, false, '端口上不是 GATE → 不许瞎认')
  assert.ok(other.reason.includes('不是 GATE'))

  const bad = await probeGate({ port: 18080, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'HTTP 503')

  const boom = await probeGate({ port: 18080, fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal(boom.ok, false)
  assert.ok(boom.reason.includes('ECONNREFUSED'), '连不上 → 如实报原因（调用方据此去"自己起"）')

  const half = await probeGate({ port: 18080, fetchImpl: async () => ({ ok: true, json: async () => ({ name: 'reeve-gate' }) }) })
  assert.equal(half.ok, true)
  assert.deepEqual(half.snapshot.chains, [], '缺字段的半截应答：给空壳而不是越界读')
  assert.equal(half.snapshot.default_chain, null)
  assert.equal(half.snapshot.problems.length, 0)
  ok('probeGate：认出 GATE / 不是 GATE / 坏状态码 / 连不上 / 半截应答')
}

// ---- 6. 台账：字段、轮转、金丝雀 ----
{
  const dir = await mkdtemp(join(tmpdir(), 'gate-ledger-'))
  const path = join(dir, 'gate.jsonl')
  const ledger = createLedger({ path, maxBytes: 300, logger: silent })
  const attempt = { provider: { id: 'p', lane: 'native' }, model: 'm', key: 'auth:primary' }
  await ledger.write(attemptRow({ ts: new Date(0).toISOString(), chainName: 'c', agent: 'a', attempt, status: 'ok', code: 200, latencyMs: 12 }))
  await ledger.write(attemptRow({ ts: new Date(0).toISOString(), chainName: 'c', agent: 'a', attempt, status: 'error', code: 429, latencyMs: 3, detail: 'status:429' }))
  await ledger.write(attemptRow({ ts: new Date(0).toISOString(), chainName: 'c', agent: 'a', attempt, status: 'ok', code: 200, latencyMs: 9 }))
  await ledger.flush()
  const rotated = await readFile(`${path}.1`, 'utf8')
  const current = await readFile(path, 'utf8')
  const row = JSON.parse(current.trim().split('\n')[0])
  assert.deepEqual(Object.keys(row).sort(), ['agent', 'chain', 'code', 'detail', 'key', 'lane', 'latency_ms', 'model', 'n', 'provider', 'req', 'retries', 'status', 'ts'].sort(), '台账字段齐全')
  assert.ok(rotated.length > 0, '超上限轮转到 .1')
  assert.ok(!`${rotated}${current}`.includes(CANARY), '台账里没有密钥材料')
  const bad = createLedger({ path: join(dir, 'nope', '\u0000bad'), logger: silent })
  await bad.write({ x: 1 }).catch(() => {})
  ok('台账：字段/轮转/无密钥/写失败不炸')
}

// ---- 7. 配置：归一化与回落 ----
{
  assert.equal(stripLineComments('// c\n{"a":1}').trim(), '{"a":1}', '整行注释剥掉')
  const norm = cfg({ policy: { retry_on_errors: [429, 'x'], max_fallback_attempts: 'nope' }, providers: { p: { base_url: 'http://p.test' } }, chains: { c: { targets: ['p/m'] }, bad: {} }, agents: { a: 'missing' }, default_chain: 'c' })
  assert.deepEqual(norm.policy.retry_on_errors, [429], 'policy 里的非数字被剔')
  assert.equal(norm.policy.max_fallback_attempts, POLICY_DEFAULTS.max_fallback_attempts, '类型不对 → 用默认并如实报')
  assert.ok(norm.problems.some((p) => p.includes('max_fallback_attempts')), '问题如实收集')
  assert.equal(norm.chains.bad, undefined, '没有 targets 的链被丢')
  assert.equal(norm.agents.a, undefined, '指向不存在链的 agent 被丢')
  assert.equal(norm.providers.p.path, '/v1/chat/completions', '默认 path')
  assert.deepEqual(norm.providers.p.auth, ['p'], 'auth 缺省 = provider id')
  assert.equal(modelsPathOf(norm.providers.p), '/v1/models', '目录端点由 path 推导')
  const dir = await mkdtemp(join(tmpdir(), 'gate-cfg-'))
  const badPath = join(dir, 'reeve-fallback.jsonc')
  await writeFile(badPath, '{ 坏 json')
  const fell = await loadGateConfig({ path: badPath, bundledPath: BUNDLED_FALLBACK_PATH })
  assert.ok(fell.config && fell.from === BUNDLED_FALLBACK_PATH, '用户配置坏 → 回落打包默认（不炸）')
  const none = await loadGateConfig({ path: join(dir, 'nope.jsonc'), bundledPath: BUNDLED_FALLBACK_PATH })
  assert.equal(none.from, BUNDLED_FALLBACK_PATH, '缺文件 → 打包默认')
  const bundled = JSON.parse(await readFile(BUNDLED_FALLBACK_PATH, 'utf8'))
  assert.ok(Object.keys(bundled.chains).length >= 2, '打包默认自带可用的链')
  assert.ok(!JSON.stringify(bundled.chains).includes('-free'), '打包默认不含免费模型池（每台机器自己加）')
  ok('配置：注释/归一化问题如实报/默认值/目录端点/坏文件回落/打包默认')
}

// ---- 8. 集成：快乐路径（含台账与响应头） ----
{
  const h = await harness({
    stubs: { free: (_req, res) => SSE_OK(res), paid: (_req, res) => SSE_OK(res) },
    providers: { free: { lane: 'passthrough' } },
    chains: { reasoning: { targets: ['free/oc/mimo-v2.6-flash-free', 'paid/m1'] } },
    agents: { scout: 'reasoning' },
    auth: { paid: { key: CANARY } },
  })
  const session = SESSION
  await postJson(h.gate, '/gate/session', { sessionID: session, agent: 'scout' })
  const out = await post(h.gate, { model: 'zhipuai/m1', stream: true, messages: [{ role: 'user', content: 'hi' }] }, { headers: { 'x-opencode-session-id': session, 'user-agent': 'opencode/latest/2.0.32/cli', 'x-opencode-session': session, 'x-session-affinity': session, 'x-session-id': session } })
  assert.equal(out.status, 200)
  assert.equal(out.headers['x-reeve-fallback'], '1/free/oc/mimo-v2.6-flash-free', '响应头标出真实服务的候选')
  assert.ok(out.text.includes('[DONE]'), 'SSE 逐字转发')
  await h.gate.flushLedger()
  const rows = (await readFile(join(h.dir, 'gate.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(rows.length, 1, '一笔请求一行台账')
  assert.equal(rows[0].chain, 'reasoning', '台账带链名（agent 桥生效）')
  assert.equal(rows[0].agent, 'scout')
  assert.equal(rows[0].status, 'ok')
  assert.ok(!(await readFile(join(h.dir, 'gate.jsonl'), 'utf8')).includes(CANARY), '台账无密钥')
  assert.equal(h.up.free.state.requests[0].headers['user-agent'], 'opencode/latest/2.0.32/cli', '透传通道：UA 到了上游')
  assert.equal(h.up.free.state.requests[0].headers['x-opencode-session-id'], session, '透传通道：session 头到了上游')
  assert.equal(h.up.free.state.requests[0].headers.authorization, undefined, 'key=none 的 provider 不发 Authorization')
  assert.ok(h.fetchImpl.seen.every((u) => new URL(u).hostname === '127.0.0.1'), '零出网：所有目标都是环回')
  await h.close()
  ok('集成·快乐路径：agent 桥路由 / 响应头 / SSE 转发 / 透传头到上游 / 台账一行 / 零出网')
}

// ---- 9. 集成：首字节前失败换候选（429/500/额度文案/连不上/retry-after） ----
{
  const cases = [
    ['429', (_req, res) => json(res, 429, { error: { message: 'rate limited' } })],
    ['500', (_req, res) => json(res, 500, { error: { message: 'boom' } })],
    ['quota-text', (_req, res) => json(res, 400, { error: { message: '额度不足，请充值' } })],
    ['retry-after', (_req, res) => { res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '20' }); res.end('{"error":{"message":"cooling down"}}') }],
  ]
  let caseIndex = 0
  for (const [name, fail] of cases) {
    caseIndex += 1
    const h = await harness({
      stubs: { bad: fail, good: (_req, res) => SSE_OK(res) },
      chains: { c: { targets: ['bad/m1', 'good/m2'] } },
      defaultChain: 'c',
    })
    const out = await post(h.gate, { model: 'c', stream: true, messages: [] }, { headers: { 'x-opencode-session-id': `ses_fb_${caseIndex}` } })
    assert.equal(out.status, 200, `${name} → 换到第二个候选后 200`)
    assert.equal(out.headers['x-reeve-fallback'], '2/good/m2', `${name} → 响应头指向第二个候选`)
    await h.gate.flushLedger()
    const rows = (await readFile(join(h.dir, 'gate.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(rows.length, 2, `${name} → 台账两行`)
    assert.equal(rows[0].status, 'error')
    assert.ok(rows[0].code !== null || rows[0].detail, `${name} → 第一行有码或原因`)
    await h.close()
  }
  // 连不上（端口没人听）：先把 stub 建起来拿到地址再关掉
  const dead = await makeStub(() => {})
  await dead.close()
  const h = await harness({
    stubs: { good: (_req, res) => SSE_OK(res) },
    providers: { dead: { base_url: dead.url, key: 'none' } },
    chains: { c: { targets: ['dead/m1', 'good/m2'] } },
    defaultChain: 'c',
  })
  const out = await post(h.gate, { model: 'c', stream: true, messages: [] }, { headers: { 'x-opencode-session-id': 'ses_net' } })
  assert.equal(out.status, 200, '连不上 → 换下一个')
  assert.equal(out.headers['x-reeve-fallback'], '2/good/m2')
  await h.close()
  ok('集成·首字节前换候选：429/500/额度文案/503+retry-after/连不上')
}

// ---- 10. 集成：不换的情形（流已开始 / 不可重试） ----
{
  const h = await harness({
    stubs: {
      midstream: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`)
        setTimeout(() => res.end('data: {"error":{"message":"upstream died"}}\n\n'), 10)
      },
      other: (_req, res) => SSE_OK(res),
    },
    chains: { c: { targets: ['midstream/m1', 'other/m2'] } },
    defaultChain: 'c',
  })
  const out = await post(h.gate, { model: 'c', stream: true, messages: [] }, { headers: { 'x-opencode-session-id': 'ses_mid' } })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(h.up.other.state.calls, 0, '流已开始：不再换候选')
  assert.equal(out.status, 200, '已经出流的错误原样透给调用方')
  assert.ok(out.text.includes('partial'))
  const h2 = await harness({ stubs: { bad400: (_req, res) => json(res, 400, { error: { message: 'invalid request shape' } }), other: (_req, res) => SSE_OK(res) }, chains: { c: { targets: ['bad400/m1', 'other/m2'] } }, defaultChain: 'c' })
  const out2 = await post(h2.gate, { model: 'c', stream: true, messages: [] }, { headers: { 'x-opencode-session-id': 'ses_400' } })
  assert.equal(out2.status, 400, '不可重试的错误：原样透传（不换）')
  assert.ok(out2.text.includes('invalid request shape'), '错误体原样')
  assert.equal(h2.up.other.state.calls, 0, '不可重试 → 第二个候选没被打扰')
  await h.close()
  await h2.close()
  ok('集成·不换：流已开始不换（错误透传）/ 不可重试错误原样透传')
}

// ---- 11. 集成：次数上限 + 全失败 502 体 ----
{
  const h = await harness({
    stubs: { a: (_req, res) => json(res, 429, { error: { message: 'limit' } }), b: (_req, res) => json(res, 429, { error: { message: 'limit' } }), c: (_req, res) => json(res, 429, { error: { message: 'limit' } }) },
    chains: { c: { targets: ['a/m1', 'b/m2', 'c/m3'] } },
    policy: { max_fallback_attempts: 2, cooldown_seconds: 60 },
    defaultChain: 'c',
  })
  const out = await post(h.gate, { model: 'c', stream: true, messages: [] }, { headers: { 'x-opencode-session-id': 'ses_cap' } })
  assert.equal(out.status, 502, '全失败 → 502')
  const body = JSON.parse(out.text)
  assert.equal(body.error.attempts.length, 2, '恰好 max_fallback_attempts 次尝试（2）')
  assert.ok(!out.text.includes(CANARY), '502 体里没有密钥材料')
  await h.gate.flushLedger()
  const rows = (await readFile(join(h.dir, 'gate.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(rows.length, 2, '台账两行')
  await h.close()
  ok('集成·上限与全失败：502 体列出每次尝试（无密钥）/ 台账行数=尝试数')
}

// ---- 11b. 0.2.9 首字节 failover：停滞可救 / 截断记账 / 正常流回归 ----
{
  // a) 首字节前挂死（zhipuai 事故形状）：200 + 流头后零字节 → 换下一个候选
  const h = await harness({
    stubs: {
      hang: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' }) // 200 + 流头（真实上游会 flush），然后装死
        res.flushHeaders()
      },
      good: (_req, res) => SSE_OK(res),
    },
    chains: { c: { targets: ['hang/m1', 'good/m2'] } },
    policy: { stream_first_byte_ms: 60, stream_idle_ms: 120_000 },
    defaultChain: 'c',
  })
  const out = await post(h.gate, { model: 'c', stream: true, messages: [] }, { headers: { 'x-opencode-session-id': 'ses_ttfb' } })
  assert.equal(out.status, 200, '客户端拿到的是第二候选的 200')
  assert.equal(out.headers['x-reeve-fallback'], '2/good/m2', '响应头标出真实目标（第二候选）')
  assert.ok(out.text.includes('ok'), '第二候选内容完整透传')
  assert.ok(h.up.hang.state.aborted >= 1, '停滞上游被中止（不留挂死连接）')
  assert.equal(h.gate.snapshot().sessions.cooling, 1, '停滞候选进会话冷却')
  await h.gate.flushLedger()
  const rows = (await readFile(join(h.dir, 'gate.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(rows.length, 2, '台账两行：停滞 error + 第二候选 ok')
  assert.equal(rows[0].status, 'error')
  assert.ok(String(rows[0].detail).includes('stalled'), '停滞原因进台账')
  assert.equal(rows[0].provider, 'hang')
  assert.equal(rows[1].provider, 'good')
  await h.close()
  ok('首字节 failover：首字节前停滞换候选 / 停滞上游被中止 / 台账 error+ok 两行')
}
{
  // b) 首块之后静默超时：截断 + 记账一次（绝不双记）
  const h = await harness({
    stubs: {
      stall: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`)
        // 之后装死：既不 end 也不报错
      },
    },
    chains: { c: { targets: ['stall/m1'] } },
    policy: { stream_first_byte_ms: 120_000, stream_idle_ms: 60 },
    defaultChain: 'c',
  })
  const out = await post(h.gate, { model: 'c', stream: true, messages: [] }, { headers: { 'x-opencode-session-id': 'ses_idle' } })
  assert.ok(out.text.includes('partial'), '首块已透给客户端')
  assert.ok(h.up.stall.state.aborted >= 1, '静默超时中止上游')
  assert.equal(h.gate.snapshot().sessions.cooling, 1, '流中停滞记一次失败账')
  await h.gate.flushLedger()
  const rows = (await readFile(join(h.dir, 'gate.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(rows.length, 1, '台账仍是一行（ok = HTTP 层面事实；失败落在冷却）')
  assert.equal(rows[0].status, 'ok')
  await h.close()
  ok('流中停滞：截断给客户端 / 上游被中止 / 失败账恰好一次（finish 判空让位）')
}
{
  // c) 上游首字节前断流（写完流头就 destroy）：与停滞同样可救 —— 顺带钉死 0.2.8 pipe 不转发错误
  const h = await harness({
    stubs: {
      reset: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.flushHeaders()
        setTimeout(() => res.destroy(), 20)
      },
      good: (_req, res) => SSE_OK(res),
    },
    chains: { c: { targets: ['reset/m1', 'good/m2'] } },
    policy: { stream_first_byte_ms: 120_000, stream_idle_ms: 120_000 },
    defaultChain: 'c',
  })
  const out = await post(h.gate, { model: 'c', stream: true, messages: [] }, { headers: { 'x-opencode-session-id': 'ses_reset' } })
  assert.equal(out.status, 200)
  assert.equal(out.headers['x-reeve-fallback'], '2/good/m2', '断流换到第二候选（pipe 时代客户端会挂死）')
  assert.ok(out.text.includes('ok'))
  await h.gate.flushLedger()
  const rows = (await readFile(join(h.dir, 'gate.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(rows.length, 2)
  assert.ok(String(rows[0].detail).includes('stream error'), '断流原因进台账')
  await h.close()
  ok('首字节前断流：换候选 / 台账 stream error')
}
{
  // d) 正常流回归：SSE 完整透传，零误伤
  const h = await harness({
    stubs: { good: (_req, res) => SSE_OK(res) },
    chains: { c: { targets: ['good/m1'] } },
    defaultChain: 'c',
  })
  const out = await post(h.gate, { model: 'c', stream: true, messages: [] }, { headers: { 'x-opencode-session-id': 'ses_ok' } })
  assert.equal(out.status, 200)
  assert.equal(out.headers['x-reeve-fallback'], '1/good/m1')
  assert.ok(out.text.includes('ok') && out.text.includes('[DONE]'), '完整透传（含 [DONE]）')
  assert.equal(h.gate.snapshot().sessions.cooling, 0, '正常流零冷却')
  await h.gate.flushLedger()
  const rows = (await readFile(join(h.dir, 'gate.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'ok')
  await h.close()
  ok('正常流回归：完整透传 / 零误伤冷却 / 台账一行 ok')
}
{
  // e) 客户端首字节前走人：静默收场（不算上游的账），GATE 存活
  const h = await harness({
    stubs: {
      hang: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.flushHeaders()
      },
    },
    chains: { c: { targets: ['hang/m1'] } },
    policy: { stream_first_byte_ms: 120_000, stream_idle_ms: 120_000 },
    defaultChain: 'c',
  })
  const payload = JSON.stringify({ model: 'c', stream: true, messages: [] })
  const req = httpRequest({ host: '127.0.0.1', port: h.gate.port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, () => {})
  req.on('error', () => {}) // 客户端自己 destroy：随后的 ECONNRESET 是预期噪音
  req.end(payload)
  await new Promise((r) => setTimeout(r, 80)) // 让泵挂到首字节等待上
  req.destroy()
  await new Promise((r) => setTimeout(r, 150)) // 让断开传播到上游
  assert.ok(h.up.hang.state.aborted >= 1, '客户端断开传播到上游')
  assert.equal(h.gate.snapshot().sessions.cooling, 0, '客户端走人不算上游的账')
  const alive = await getJson(h.gate, '/gate/version')
  assert.equal(alive.status, 200, 'GATE 存活')
  await h.close()
  ok('客户端首字节前断开：静默收场 / 不记账 / GATE 存活')
}
{
  // f) 0.2.10 裸模型名直投：引擎裸名命中免费池 → 显式直投，绝不掉默认链走付费
  const h = await harness({
    stubs: { oc: (_req, res) => SSE_OK(res), paid: (_req, res) => SSE_OK(res) },
    chains: { c: { targets: ['paid/m1'] } },
    free: { enabled: true, max: 3, require_image: false, prefer: [], deny: [], providers: ['oc'], static: { oc: ['glm-5.3-flash-free'] } },
    defaultChain: 'c',
  })
  const out = await post(h.gate, { model: 'glm-5.3-flash-free', stream: true, messages: [] }, { headers: { 'x-opencode-session-id': 'ses_bare1' } })
  assert.equal(out.status, 200)
  assert.equal(out.headers['x-reeve-fallback'], '1/oc/glm-5.3-flash-free', '裸名命中免费池 → 显式直投（不掉默认链）')
  assert.equal(h.up.paid.state.calls, 0, '默认链（付费）没被打扰')
  const out2 = await post(h.gate, { model: 'no-such-model', stream: true, messages: [] }, { headers: { 'x-opencode-session-id': 'ses_bare2' } })
  assert.equal(out2.status, 200)
  assert.equal(out2.headers['x-reeve-fallback'], '1/paid/m1', '未知裸名 → 默认链（行为不变）')
  const out3 = await post(h.gate, { model: 'c', stream: true, messages: [] }, { headers: { 'x-opencode-session-id': 'ses_bare3' } })
  assert.equal(out3.headers['x-reeve-fallback'], '1/paid/m1', '链名直呼（优先级最高）行为不变')
  await h.close()
  ok('裸名直投：免费池裸名不掉默认链 / 未知裸名走默认链 / 链名优先级不变')
}

// ---- 12. 集成：冷却与粘性（按 session 记账） ----
{
  let t = 5_000_000
  const h = await harness({
    stubs: { bad: (_req, res) => json(res, 429, { error: { message: 'limit' } }), good: (_req, res) => SSE_OK(res) },
    chains: { c: { targets: ['bad/m1', 'good/m2'] } },
    defaultChain: 'c',
    gateOptions: { now: () => t },
  })
  const s1 = 'ses_sticky_1'
  const s2 = 'ses_sticky_2'
  const first = await post(h.gate, { model: 'c', stream: true, messages: [] }, { headers: { 'x-opencode-session-id': s1 } })
  assert.equal(first.headers['x-reeve-fallback'], '2/good/m2', '第一次：bad 失败 → good 顶上')
  const badCallsAfter1 = h.up.bad.state.calls
  // 同 session 第二次：起点粘在 good（bad 在冷却里，不会被再打）
  const second = await post(h.gate, { model: 'c', stream: true, messages: [] }, { headers: { 'x-opencode-session-id': s1 } })
  assert.equal(h.up.bad.state.calls, badCallsAfter1, '同 session：冷却中的 bad 不再被打')
  assert.equal(second.headers['x-reeve-fallback'], '1/good/m2', '粘性：起点就在 good')
  // 另一个 session 不受影响（冷却按 session）
  const other = await post(h.gate, { model: 'c', stream: true, messages: [] }, { headers: { 'x-opencode-session-id': s2 } })
  assert.ok(h.up.bad.state.calls > badCallsAfter1, '别的 session 仍会去试 bad（冷却不跨 session）')
  assert.equal(other.headers['x-reeve-fallback'], '2/good/m2')
  // 冷却过期（+61s）：restore=false（默认）→ 粘性优先，不回主候选
  t += 61_000
  const third = await post(h.gate, { model: 'c', stream: true, messages: [] }, { headers: { 'x-opencode-session-id': s1 } })
  assert.equal(third.headers['x-reeve-fallback'], '1/good/m2', 'restore=false：冷却过期也不回主候选（粘性）')
  await h.close()
  // restore=true：冷却全过期 → 回主候选（bad 又被试一次、失败、再顶 good）
  let t2 = 9_000_000
  const h2 = await harness({
    stubs: { bad: (_req, res) => json(res, 429, { error: { message: 'limit' } }), good: (_req, res) => SSE_OK(res) },
    chains: { c: { targets: ['bad/m1', 'good/m2'] } },
    policy: { restore_primary_after_cooldown: true, cooldown_seconds: 60 },
    defaultChain: 'c',
    gateOptions: { now: () => t2 },
  })
  await post(h2.gate, { model: 'c', stream: true, messages: [] }, { headers: { 'x-opencode-session-id': 'ses_restore' } })
  const before = h2.up.bad.state.calls
  t2 += 61_000
  const back = await post(h2.gate, { model: 'c', stream: true, messages: [] }, { headers: { 'x-opencode-session-id': 'ses_restore' } })
  assert.ok(h2.up.bad.state.calls > before, 'restore=true：冷却过期后回主候选（又试了一次 bad）')
  assert.equal(back.headers['x-reeve-fallback'], '2/good/m2')
  await h2.close()
  ok('集成·冷却与粘性：同 session 跳过冷却候选 / 不跨 session / restore 开关两种行为')
}

// ---- 13. 集成：流式不缓冲（握手式断言） ----
{
  const h = await harness({
    stubs: {
      slow: async (_req, res, state) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"n":1}\n\n')
        await state.gate // 等测试收到第一块
        res.write('data: {"n":2}\n\n')
        res.end('data: [DONE]\n\n')
      },
    },
    chains: { c: { targets: ['slow/m1'] } },
    defaultChain: 'c',
  })
  let release
  h.up.slow.state.gate = new Promise((r) => (release = r))
  const seen = []
  const done = new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model: 'c', stream: true, messages: [] })
    const req = httpRequest({ host: '127.0.0.1', port: h.gate.port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-opencode-session-id': 'ses_stream' } }, (res) => {
      res.on('data', (c) => {
        seen.push(c.toString('utf8'))
        if (c.toString('utf8').includes('"n":1')) release()
      })
      res.on('end', resolve)
    })
    req.on('error', reject)
    req.end(payload)
  })
  await done
  assert.ok(seen.length >= 2, '两块各自到达（没有整包缓冲）')
  assert.ok(seen[0].includes('"n":1') && seen.join('').includes('"n":2'), '第一块在上游写第二块之前就到了客户端（握手式断言）')
  await h.close()
  ok('集成·流式：逐块转发不缓冲（上游等客户端收到第一块再写第二块）')
}

// ---- 14. 集成：客户端断开 → 上游被中止 ----
{
  const h = await harness({ stubs: { hang: () => {} }, chains: { c: { targets: ['hang/m1'] } }, defaultChain: 'c' })
  const payload = JSON.stringify({ model: 'c', stream: true, messages: [] })
  const req = httpRequest({ host: '127.0.0.1', port: h.gate.port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-opencode-session-id': 'ses_abort' } })
  req.on('error', () => {}) // 主动 destroy 必然带 ECONNRESET：预期之内
  req.end(payload)
  await new Promise((r) => setTimeout(r, 60))
  req.destroy()
  const deadline = Date.now() + 1500
  while (h.up.hang.state.aborted === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
  assert.ok(h.up.hang.state.aborted >= 1, '客户端断开 → 上游请求被中止（不泄漏）')
  await h.close()
  ok('集成·断开传播：客户端 abort → 上游被中止')
}

// ---- 15. 集成：provider 重试（不算候选切换） ----
{
  const h = await harness({
    stubs: {
      flaky: (_req, res, state) => (state.calls === 1 ? json(res, 500, { error: { message: 'transient' } }) : SSE_OK(res)),
    },
    providers: { flaky: { retries: 1 } },
    chains: { c: { targets: ['flaky/m1'] } },
    defaultChain: 'c',
  })
  const out = await post(h.gate, { model: 'c', stream: true, messages: [] }, { headers: { 'x-opencode-session-id': 'ses_retry' } })
  assert.equal(out.status, 200, 'provider 内重试后成功')
  assert.equal(h.up.flaky.state.calls, 2, '恰好重试一次（stub 被调用两次）')
  await h.gate.flushLedger()
  const rows = (await readFile(join(h.dir, 'gate.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(rows.length, 1, '重试不算候选切换（台账一行）')
  assert.equal(rows[0].retries, 1, '台账记下重试次数')
  await h.close()
  ok('集成·provider 重试：500→200 一次重试，不算候选切换（台账 retries=1）')
}

// ---- 16. 集成：多键轮转（键值不上台账） ----
{
  const K1 = 'canary-KEY1-aaaaaaaaaaaaaaaaaaaa'
  const K2 = 'canary-KEY2-bbbbbbbbbbbbbbbbbbbb'
  const h = await harness({
    stubs: { paid: (_req, res) => SSE_OK(res) },
    providers: { paid: { auth: ['paid1', 'paid2'] } },
    chains: { c: { targets: ['paid/m1'] } },
    auth: { paid1: { key: K1 }, paid2: { key: K2 } },
    defaultChain: 'c',
  })
  await post(h.gate, { model: 'c', stream: true, messages: [] }, { headers: { 'x-opencode-session-id': 'ses_k1' } })
  await post(h.gate, { model: 'c', stream: true, messages: [] }, { headers: { 'x-opencode-session-id': 'ses_k2' } })
  const auths = h.up.paid.state.requests.map((r) => r.headers.authorization)
  assert.deepEqual(auths, [`Bearer ${K1}`, `Bearer ${K2}`], '多键按序轮转（确定性）')
  await h.gate.flushLedger()
  const ledgerText = await readFile(join(h.dir, 'gate.jsonl'), 'utf8')
  assert.ok(!ledgerText.includes(K1) && !ledgerText.includes(K2), '台账只记键的名字（auth:paid1），不记值')
  assert.ok(ledgerText.includes('auth:paid1'), '键的名字在台账里（可归因）')
  const models = await getJson(h.gate, '/v1/models')
  assert.ok(!JSON.stringify(models.body).includes(K1), '/v1/models 里没有密钥')
  await h.close()
  ok('集成·多键轮转：按序轮转（确定性）/ 台账与目录只有键名没有键值')
}

// ---- 17. 集成：模型目录聚合 + TTL + 降级 ----
{
  const h = await harness({
    stubs: {
      pool: (req, res, _state) => {
        if (req.url.startsWith('/v1/models')) return json(res, 200, { object: 'list', data: [{ id: 'oc/mimo-v2.6-flash-free' }, { id: 'oc/muse-spark-free' }] })
        return SSE_OK(res)
      },
      paid: () => {}, // 声明模型用，不会被调用
    },
    providers: { pool: { models_fetch: true, models: ['*'] }, paid: { models: ['glm-5.3-flash'] } },
    chains: { reasoning: { targets: ['pool/oc/mimo-v2.6-flash-free'] } },
    defaultChain: 'reasoning',
  })
  let t = 100
  const gate2 = await startGate({ port: 0, configPath: h.configPath, bundledPath: BUNDLED_FALLBACK_PATH, ledgerPath: join(h.dir, 'gate.jsonl'), authPath: join(h.dir, 'auth.json'), logger: silent, fetchImpl: h.fetchImpl, now: () => t, sleepImpl: () => Promise.resolve(), configWatchMs: 1_000_000 })
  const m1 = await getJson(gate2, '/v1/models')
  const ids = m1.body.data.map((d) => d.id)
  assert.ok(ids.includes('pool/oc/mimo-v2.6-flash-free'), '目录含运行时池')
  assert.ok(ids.includes('paid/glm-5.3-flash'), '目录含注册表声明')
  assert.ok(ids.includes('reasoning'), '目录含链名（UI 里可直接选链）')
  const callsAfterFirst = h.up.pool.state.calls
  await getJson(gate2, '/v1/models')
  assert.equal(h.up.pool.state.calls, callsAfterFirst, 'TTL 内不重拉池')
  t += 301_000
  await getJson(gate2, '/v1/models')
  assert.ok(h.up.pool.state.calls > callsAfterFirst, 'TTL 过后重拉')
  // 池挂了 → 降级（仍有声明与链名，不报错）
  await h.up.pool.close()
  t += 301_000
  const degraded = await getJson(gate2, '/v1/models')
  assert.equal(degraded.status, 200, '池挂掉仍 200（降级不报错）')
  assert.ok(degraded.body.data.map((d) => d.id).includes('paid/glm-5.3-flash'), '降级后声明仍在')
  await gate2.dispose()
  await h.close()
  ok('集成·目录：声明 ∪ 池 ∪ 链名 / TTL 缓存 / 池挂掉降级')
}

// ---- 18. 集成：session 桥与 next（去重推进） ----
{
  const h = await harness({
    stubs: { a: (_req, res) => json(res, 429, { error: { message: 'quota exceeded' } }), b: (_req, res) => SSE_OK(res) },
    chains: { t: { targets: ['a/m1', 'b/m2'] } },
    agents: { scout: 't' },
    defaultChain: 't',
  })
  await postJson(h.gate, '/gate/session', { sessionID: 'ses_bridge', agent: 'scout' })
  const v = await getJson(h.gate, '/gate/version')
  assert.ok(v.body.chains.includes('t'), '/gate/version 报出链')
  const n1 = await postJson(h.gate, '/gate/session/ses_bridge/next', { dedupeKey: 'E1' })
  assert.equal(n1.body.model, 'b/m2', 'next 给出下一个候选')
  const n2 = await postJson(h.gate, '/gate/session/ses_bridge/next', { dedupeKey: 'E1' })
  assert.equal(n2.body.model, 'b/m2', '同一失败键 → 不重复推进（去重）')
  const n3 = await postJson(h.gate, '/gate/session/ses_bridge/next', { dedupeKey: 'E2' })
  assert.equal(n3.body.model, null, '链尾 → null')
  const bad = await postJson(h.gate, '/gate/session', { agent: 'x' })
  assert.equal(bad.status, 400, 'sessionID 必填')
  await h.close()
  ok('集成·会话桥：/gate/session 与 /next（去重推进/链尾 null/参数校验）')
}

// ---- 19. 集成：配置热更（好文件生效 / 坏文件保留旧份） ----
{
  const h = await harness({
    stubs: { a: (_req, res) => SSE_OK(res), b: (_req, res) => SSE_OK(res) },
    chains: { c: { targets: ['a/m1'] } },
    defaultChain: 'c',
    gateOptions: { configWatchMs: 30 },
  })
  const first = await post(h.gate, { model: 'c', stream: true, messages: [] })
  assert.equal(first.headers['x-reeve-fallback'], '1/a/m1')
  const raw = JSON.parse(await readFile(h.configPath, 'utf8'))
  raw.chains.c.targets = ['b/m2']
  await writeFile(h.configPath, JSON.stringify(raw))
  const deadline = Date.now() + 3000
  let hitB = false
  while (Date.now() < deadline && !hitB) {
    await new Promise((r) => setTimeout(r, 40))
    const out = await post(h.gate, { model: 'c', stream: true, messages: [] })
    hitB = out.headers['x-reeve-fallback'] === '1/b/m2'
  }
  assert.ok(hitB, '热更：改配置后新请求走新链（只 stat 一次的开销）')
  await writeFile(h.configPath, '{ 坏 json')
  await new Promise((r) => setTimeout(r, 120))
  const after = await post(h.gate, { model: 'c', stream: true, messages: [] })
  assert.equal(after.headers['x-reeve-fallback'], '1/b/m2', '坏文件：保留上一份好配置（不崩、不回落）')
  await h.close()
  ok('集成·热更：好文件即时生效 / 坏文件保留上一份好配置')
}

// ---- 20. dispose 与端口冲突 ----
{
  const h = await harness({ stubs: { a: (_req, res) => SSE_OK(res) }, chains: { c: { targets: ['a/m1'] } }, defaultChain: 'c', gateOptions: { configWatchMs: 20 } })
  await h.gate.dispose()
  await h.gate.dispose() // 二次 dispose 不炸（清理尽力而为）
  const again = await startGate({ port: 0, configPath: h.configPath, bundledPath: BUNDLED_FALLBACK_PATH, ledgerPath: join(h.dir, 'gate.jsonl'), authPath: join(h.dir, 'auth.json'), logger: silent, fetchImpl: h.fetchImpl, sleepImpl: () => Promise.resolve(), configWatchMs: 1_000_000 })
  await assert.rejects(() => startGate({ port: again.port, configPath: h.configPath, bundledPath: BUNDLED_FALLBACK_PATH, ledgerPath: join(h.dir, 'gate.jsonl'), authPath: join(h.dir, 'auth.json'), logger: silent }), /EADDRINUSE|address already in use/i, '端口冲突：吵（不静默）')
  await again.dispose()
  await h.close()
  ok('服务生命周期：dispose 幂等（含定时器已开）/ 端口冲突吵')
}

// ---- 20b. detach：插件实例卸载 ≠ 关端口（GATE 是引擎级服务）----
{
  const h = await harness({ stubs: { a: (_req, res) => SSE_OK(res) }, chains: { c: { targets: ['a/m1'] } }, defaultChain: 'c' })
  try {
    h.gate.detach()
    const ver = await getJson(h.gate, '/gate/version')
    assert.equal(ver.status, 200, 'detach 后版本面照常')
    assert.equal(ver.body.name, 'reeve-gate')
    const res = await post(h.gate, { model: 'c', stream: true, messages: [] })
    assert.equal(res.status, 200, 'detach 后真请求照常走链')
    assert.equal(res.headers['x-reeve-fallback'], '1/a/m1')
    ok('detach：卸载只松手（端口/热更/台账都在），dispose 才真关')
  } finally {
    await h.close()
  }
}

// ---- 21. 边界与错误面（400/413/404/未知路由/空列） ----
{
  const h = await harness({
    stubs: { a: (req, res) => SSE_OK(res) },
    chains: { c: { targets: ['a/m1'] } },
    defaultChain: 'c',
    gateOptions: { maxBodyBytes: 4096 },
  })
  const nonJson = await new Promise((resolve, reject) => {
    const payload = 'not json at all'
    const req = httpRequest({ host: '127.0.0.1', port: h.gate.port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      let t = ''
      res.on('data', (c) => (t += c))
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(t) }))
    })
    req.on('error', reject)
    req.end(payload)
  })
  assert.equal(nonJson.status, 400, '非 JSON body → 400（不猜）')
  const noModel = await post(h.gate, { messages: [] })
  assert.equal(noModel.status, 400, '缺 model → 400')
  const unknown = await post(h.gate, { model: 'nope/xx', stream: true, messages: [] })
  assert.equal(unknown.status, 404, '未知 provider 的 model → 404（不拿兜底链顶替用户的选择）')
  const bare = await post(h.gate, { model: 'bare-name', stream: true, messages: [] })
  assert.equal(bare.status, 200, '裸模型名 → 兜底链')
  assert.equal(bare.headers['x-reeve-fallback'], '1/a/m1')
  const big = await post(h.gate, { model: 'c', stream: true, messages: [{ role: 'user', content: 'x'.repeat(8192) }] })
  assert.equal(big.status, 413, '超过 maxBodyBytes → 413')
  const badRoute = await getJson(h.gate, '/nope')
  assert.equal(badRoute.status, 404, '未知路由 → 404')
  const badGate = await postJson(h.gate, '/gate/nope', {})
  assert.equal(badGate.status, 404, '未知的 gate 路由 → 404')
  // 快照与 /gate/version 的运行态面（面板 / 探针要用）
  const snap = h.gate.snapshot()
  assert.equal(typeof snap.port, 'number', 'snapshot 有端口')
  assert.ok(Array.isArray(snap.chains) && snap.chains.includes('c'), 'snapshot 有链名')
  assert.ok(snap.sessions && typeof snap.sessions.sessions === 'number', 'snapshot 有会话计数')
  const version = await getJson(h.gate, '/gate/version')
  assert.equal(version.body.name, 'reeve-gate')
  assert.ok(Array.isArray(version.body.problems), '/gate/version 报 problems（如实）')
  assert.equal(version.body.ledger, join(h.dir, 'gate.jsonl'), '/gate/version 报台账路径')
  // 管理面坏 body：JSON.parse 抛 → 外层兜住回 500（不炸进程）
  const brokenAdmin = await new Promise((resolve, reject) => {
    const payload = '{坏'
    const req = httpRequest({ host: '127.0.0.1', port: h.gate.port, path: '/gate/session', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      let t = ''
      res.on('data', (c) => (t += c))
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end(payload)
  })
  assert.equal(brokenAdmin, 500, '管理面坏 body → 500（外层兜住，进程不炸）')
  // 候选全不可达（provider 缺 base_url）
  const h2 = await harness({
    stubs: {},
    providers: { ghost: { key: 'none' } }, // 没有 base_url → 不可达
    chains: { c: { targets: ['ghost/m1'] } },
    defaultChain: 'c',
  })
  const empty = await post(h2.gate, { model: 'c', stream: true, messages: [] })
  assert.equal(empty.status, 502, '没有可用候选 → 502（如实报跳过原因）')
  assert.ok(JSON.parse(empty.text).error.skipped.some((s) => s.includes('no-provider')), '502 体列出跳过原因')
  await h.close()
  await h2.close()
  ok('边界：400（非 JSON/缺 model）/ 413（过大）/ 404（未知模型与路由）/ 502（无可用候选，列出原因）')
}

// ---- 22. 并发：40 路互不串扰 / 同 session 去重推进 / 断开只影响自己 ----
{
  const h = await harness({
    stubs: {
      fastp: (_req, res) => SSE_OK(res),
      slowp: () => {}, // 永不响应：等客户端断开
    },
    chains: { fast: { targets: ['fastp/m'] }, slow: { targets: ['slowp/m'] }, mul: { targets: ['fastp/m1', 'fastp/m2', 'fastp/m3'] } },
    defaultChain: 'mul',
  })
  try {
    const many = await Promise.all(
      Array.from({ length: 40 }, (_, i) => post(h.gate, { model: 'fast', stream: true, messages: [] }, { 'x-opencode-session-id': `conc-${i}` })),
    )
    assert.ok(many.every((r) => r.status === 200), '40 路并发全部 200')
    await h.gate.flushLedger?.()
    const rows = (await import('node:fs/promises')).readFile(join(h.dir, 'gate.jsonl'), 'utf8')
    const n = (await rows).trim().split('\n').filter(Boolean).length
    assert.ok(n >= 40, `台账行数 ≥ 40（实际 ${n}）`)

    // 同一个失败被两条事件触发 → 只推进一次（dedupeKey）
    const id = 'ses-conc-next'
    const [a, b] = await Promise.all([
      postJson(h.gate, `/gate/session/${id}/next`, { dedupeKey: 'same' }),
      postJson(h.gate, `/gate/session/${id}/next`, { dedupeKey: 'same' }),
    ])
    assert.equal(a.body.model, b.body.model, '同 dedupeKey 并发只推进一次')
    assert.equal(a.body.model, 'fastp/m2', '指针从 0 起，第一次推进到第 2 个候选')
    const c = await postJson(h.gate, `/gate/session/${id}/next`, { dedupeKey: 'next' })
    assert.equal(c.body.model, 'fastp/m3', '新事件继续顺位')

    // 一路断开不影响另一路
    const slow = new Promise((resolve) => {
      const payload = JSON.stringify({ model: 'slow', stream: true, messages: [] })
      const req = httpRequest(
        { host: '127.0.0.1', port: h.gate.port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
        (res) => {
          res.resume()
          resolve('response')
        },
      )
      req.on('error', () => resolve('aborted'))
      req.end(payload)
      setTimeout(() => req.destroy(), 150)
    })
    const fast = post(h.gate, { model: 'fast', stream: true, messages: [] })
    const [slowRes, fastRes] = await Promise.all([slow, fast])
    assert.equal(fastRes.status, 200, '并行的正常请求不受影响')
    assert.equal(slowRes, 'aborted')
    await new Promise((r) => setTimeout(r, 400))
    assert.ok(h.up.slowp.state.aborted >= 1, '断开传播到上游（stub 观察到 close）')
    ok('并发：40 路互不串扰 / 同 session 去重只推进一次 / 断开只影响自己')
  } finally {
    await h.close()
  }
}

console.log(`\nGATE 测试：${passed} 项全过`)