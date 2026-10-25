// 免费模型池（src/gate/free.js）的离线验收：
//   · 发现解析/过滤（opencode 的 -free/big-pickle、openrouter 的 :free、nvidia 静态）
//   · TTL 缓存 / 拉取失败保留上一份
//   · @free 展开：prefer → 发现序、deny、预算（maxAttempts - 1）、无键跳过
//   · 全局冷却：连续失败到阈值 → 跳过；全部冷却 → 链只剩付费
//   · 台账 auto 标记 / /gate/free 运行态 / 热更 / 并发一致
//   · reeve/free 免费池专用链（free-only = [@free]）：成功只打免费 / 全败 502 不碰付费 / 池关空 plan
//
// 纪律：不出网（发现源全部 stub；任何非环回、非发现源的 URL 直接判红）、假时钟（不 sleep 等冷却）。
//   node plugin/test/free.mjs

import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startGate } from '../src/gate/gate.js'
import { BUNDLED_FALLBACK_PATH } from '../src/gate/config.js'
import { t } from '../src/locale.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}
const silent = { debug: () => {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SSE_OK = (model) => ({
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
  body: `data: {"choices":[{"delta":{"content":"${model}"}}]}\n\ndata: [DONE]\n\n`,
})

/** 上游 stub：按 model 决定 200/429，记录调用。 */
async function makeUpstream() {
  const calls = []
  const server = createHttpServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let model = ''
      try {
        model = JSON.parse(body)?.model ?? ''
      } catch {}
      calls.push({ url: req.url, model })
      if (String(model).includes('fail')) {
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'rate limited' } }))
        return
      }
      const sse = SSE_OK(model)
      res.writeHead(sse.status, sse.headers)
      res.end(sse.body)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, calls, close: () => new Promise((r) => server.close(r)) }
}

const discoveryResponse = (ids) => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200, headers: { 'content-type': 'application/json' } })

/** 发现源 stub + 零出网闸门（只允许回环 stub、两个发现源与 models.dev）。 */
function makeFetch({ opencode = [], openrouter = [], fail = null, modalities = null } = {}) {
  const counts = { opencode: 0, openrouter: 0, modalities: 0 }
  const fn = (url, opts) => {
    const u = String(url)
    if (u.startsWith('https://opencode.ai/zen/v1/models')) {
      counts.opencode += 1
      if (fail === 'opencode') return Promise.reject(new Error('discovery down'))
      return Promise.resolve(discoveryResponse(opencode))
    }
    if (u.startsWith('https://openrouter.ai/api/v1/models')) {
      counts.openrouter += 1
      if (fail === 'openrouter') return Promise.reject(new Error('discovery down'))
      return Promise.resolve(discoveryResponse(openrouter))
    }
    if (u.startsWith('https://models.dev/api.json')) {
      counts.modalities += 1
      if (fail === 'modalities') return Promise.reject(new Error('modalities down'))
      return Promise.resolve(new Response(JSON.stringify(modalities ?? {}), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    if (/^http:\/\/127\.0\.0\.1:/.test(u)) return fetch(u, opts)
    throw new Error(`测试里禁止出网：${u}`)
  }
  return { fn, counts }
}

const BASE_CONFIG = (upstream, overrides = {}) => ({
  schema: 1,
  policy: { max_fallback_attempts: 4, cooldown_seconds: 60, models_ttl_seconds: 300, session_ttl_seconds: 1800 },
  providers: {
    opencode: { base_url: upstream.base, key: 'public', lane: 'passthrough', models: ['*'] },
    openrouter: { base_url: upstream.base, auth: ['openrouter'] },
    nvidia: { base_url: upstream.base, auth: ['nvidia'] },
    paid: { base_url: upstream.base, key: 'none', models: ['paid-ok'] },
  },
  free: {
    enabled: true,
    max: 3,
    providers: ['opencode', 'openrouter', 'nvidia'],
    refresh_seconds: 30,
    failure_threshold: 3,
    failure_cooldown_seconds: 600,
    prefer: [],
    deny: [],
    static: { nvidia: ['z-ai/glm-5.2'] },
    ...overrides,
  },
  chains: { 'free-first': { targets: ['@free', 'paid/paid-ok'] } },
  agents: {},
  chain_for_model: { 'reeve/flash': 'free-first' },
  default_chain: 'free-first',
})

async function harness({ discovery = {}, free = {}, config = {}, providers: extraProviders = {}, auth = { openrouter: { key: 'sk-or-CANARY' }, nvidia: { key: 'nvapi-CANARY' } }, watchMs = 1_000_000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gate-free-'))
  const upstream = await makeUpstream()
  const cfg = { ...BASE_CONFIG(upstream), ...config }
  cfg.providers = { ...BASE_CONFIG(upstream).providers, ...extraProviders }
  cfg.free = { ...BASE_CONFIG(upstream).free, ...free }
  const configPath = join(dir, 'fallback.jsonc')
  await writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8')
  const authPath = join(dir, 'auth.json')
  await writeFile(authPath, JSON.stringify(auth), 'utf8')
  let t = 2_000_000
  const { fn: fetchImpl, counts } = makeFetch(discovery)
  const gate = await startGate({
    port: 0,
    configPath,
    bundledPath: BUNDLED_FALLBACK_PATH,
    ledgerPath: join(dir, 'gate.jsonl'),
    authPath,
    logger: silent,
    now: () => t,
    fetchImpl,
    sleepImpl: () => Promise.resolve(),
    configWatchMs: watchMs,
  })
  const rows = async () => {
    await gate.flushLedger?.()
    const { readFile } = await import('node:fs/promises')
    try {
      return (await readFile(join(dir, 'gate.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch {
      return []
    }
  }
  return {
    gate,
    dir,
    counts,
    upstream,
    rows,
    advance: (ms) => (t += ms),
    configPath,
    close: async () => {
      await gate.dispose()
      await upstream.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const post = (gate, body, headers = {}) =>
  fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, text: await r.text(), fallback: r.headers.get('x-reeve-fallback') }))

const getJson = (gate, path) =>
  fetch(`http://127.0.0.1:${gate.port}${path}`).then(async (r) => {
    const text = await r.text()
    if (!r.ok) throw new Error(`${path} → HTTP ${r.status}：${text.slice(0, 300)}`)
    return JSON.parse(text)
  })

const OPCODE_FREE = ['mimo-v2.6-flash-free', 'deepseek-v4.1-flash-free', 'paid-model', 'deepseek-v4-flash-free', 'big-pickle']
const OPENROUTER_FREE = ['vendor/a:free', 'vendor/b', 'vendor/c:free']

// ---- 1. 发现解析/过滤 + 展开顺序 + 预算 ----
{
  const h = await harness({ discovery: { opencode: OPCODE_FREE, openrouter: OPENROUTER_FREE } })
  try {
    const snap = await getJson(h.gate, '/gate/free')
    assert.equal(snap.enabled, true)
    assert.equal(snap.cap, 3, 'maxAttempts 4 → 免费最多 3')
    assert.deepEqual(
      snap.expand,
      ['opencode/mimo-v2.6-flash-free', 'opencode/deepseek-v4.1-flash-free', 'opencode/big-pickle'],
      '只展开真正免费的（排除 paid-model 与 deepseek-v4-flash-free），按发现序',
    )
    assert.equal(snap.providers.find((p) => p.id === 'opencode').ready, true)
    assert.equal(snap.providers.find((p) => p.id === 'openrouter').models, 2, 'openrouter 只留 :free')
    assert.equal(snap.providers.find((p) => p.id === 'nvidia').models, 1, 'nvidia 走静态白名单')
    assert.ok(!JSON.stringify(snap).includes('CANARY'), '/gate/free 不带任何键值')
    ok('发现：opencode 过滤 / openrouter :free / nvidia 静态；展开序与预算是 3')
  } finally {
    await h.close()
  }
}

// ---- 1b. 免费池只留 image-capable（模态来自 models.dev，动态过滤） ----
{
  const h = await harness({
    discovery: {
      opencode: ['mimo-v2.6-flash-free', 'big-pickle', 'deepseek-v4.1-flash-free'],
      modalities: {
        opencode: {
          models: {
            'mimo-v2.6-flash-free': { modalities: { input: ['text', 'image'] }, attachment: true },
            'big-pickle': { modalities: { input: ['text'] }, attachment: false },
            'deepseek-v4.1-flash-free': { modalities: { input: ['text', 'image'] }, attachment: true },
          },
        },
      },
    },
    free: { require_image: true },
  })
  try {
    const snap = await getJson(h.gate, '/gate/free')
    assert.deepEqual(
      snap.expand,
      ['opencode/mimo-v2.6-flash-free', 'opencode/deepseek-v4.1-flash-free'],
      '纯文本 big-pickle 被 models.dev modalities 过滤掉',
    )
    assert.equal(snap.modality_ready, true)
    assert.equal(h.counts.modalities, 1, '模态元数据只拉一次（TTL 内复用）')
    ok('免费过滤：require_image 按 models.dev modalities 动态排除纯文本模型')
  } finally {
    await h.close()
  }
}

// ---- 1c. 元数据里没有 image 模型 → 没有免费候选，直接付费 ----
{
  const h = await harness({
    discovery: {
      opencode: ['big-pickle', 'mimo-v2.6-flash-free'],
      modalities: {
        opencode: {
          models: {
            'big-pickle': { modalities: { input: ['text'] }, attachment: false },
            'mimo-v2.6-flash-free': { modalities: { input: ['text'] }, attachment: false },
          },
        },
      },
    },
    free: { require_image: true },
  })
  try {
    const snap = await getJson(h.gate, '/gate/free')
    assert.deepEqual(snap.expand, [], '没有 image 模型 → 一个免费都不展开')
    const r = await post(h.gate, { model: 'reeve/flash', stream: false, messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(r.status, 200)
    assert.equal(r.fallback, '1/paid/paid-ok', '没有可用免费候选 → 顺位付费')
    ok('免费过滤：没有 image 免费模型时直接付费，不退回纯文本')
  } finally {
    await h.close()
  }
}

// ---- 1d. models.dev 拉不到 → 不用没有证据的免费模型，直接付费 ----
{
  const h = await harness({
    discovery: { opencode: ['mimo-v2.6-flash-free'], fail: 'modalities' },
    free: { require_image: true },
  })
  try {
    const snap = await getJson(h.gate, '/gate/free')
    assert.deepEqual(snap.expand, [], '模态元数据不可用 → 不展开免费')
    assert.equal(snap.modality_error !== null, true)
    const r = await post(h.gate, { model: 'reeve/flash', stream: false, messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(r.fallback, '1/paid/paid-ok')
    ok('免费过滤：模态元数据不可用时降级付费，不猜纯文本')
  } finally {
    await h.close()
  }
}

// ---- 2. TTL 缓存 + 发现失败保留上一份 ----
{
  const h = await harness({ discovery: { opencode: OPCODE_FREE, openrouter: OPENROUTER_FREE }, watchMs: 20 })
  try {
    await getJson(h.gate, '/gate/free')
    assert.equal(h.counts.opencode, 1)
    await getJson(h.gate, '/gate/free')
    assert.equal(h.counts.opencode, 1, 'TTL 内不重复拉取')
    h.advance(31_000)
    await getJson(h.gate, '/gate/free')
    assert.equal(h.counts.opencode, 2, 'TTL 过期重新拉取')
    const before = (await getJson(h.gate, '/gate/free')).expand
    // 把发现源换成一个必然失败的地址：拉取失败时保留上一份好列表，并如实记错误
    const next = { ...BASE_CONFIG(h.upstream) }
    next.free = { ...next.free, sources: { opencode: { url: 'https://discovery.invalid/models', filter: 'opencode-free' } } }
    await writeFile(h.configPath, JSON.stringify(next), 'utf8')
    // 热更 watcher 的最小周期是 200ms（见 watchGateConfig）
    await sleep(450)
    h.advance(31_000)
    const after = await getJson(h.gate, '/gate/free')
    const oc = after.providers.find((p) => p.id === 'opencode')
    assert.equal(oc.error !== null, true, `发现失败如实记错误（实际：${JSON.stringify(oc)} counts=${JSON.stringify(h.counts)}）`)
    assert.deepEqual(after.expand, before, '发现失败保留上一份好列表')
    ok('TTL：缓存命中 / 过期重拉 / 发现失败保留上一份并记错误')
  } finally {
    await h.close()
  }
}

// ---- 3. prefer 置顶 + deny 排除 ----
{
  const h = await harness({
    discovery: { opencode: OPCODE_FREE, openrouter: OPENROUTER_FREE },
    free: { prefer: ['opencode/big-pickle', 'vendor/a:free'], deny: ['mimo-v2.6-flash-free'] },
  })
  try {
    const snap = await getJson(h.gate, '/gate/free')
    assert.deepEqual(snap.expand, ['opencode/big-pickle', 'openrouter/vendor/a:free', 'opencode/deepseek-v4.1-flash-free'])
    ok('prefer 置顶（full ref + 裸模型名都行）/ deny 排除')
  } finally {
    await h.close()
  }
}

// ---- 4. 预算：maxAttempts=2 → 免费最多 1 ----
{
  const h = await harness({ discovery: { opencode: OPCODE_FREE }, free: { max: 3 }, config: { policy: { max_fallback_attempts: 2, cooldown_seconds: 60 } } })
  try {
    const snap = await getJson(h.gate, '/gate/free')
    assert.equal(snap.cap, 1, '永远给付费留一跳')
    assert.equal(snap.expand.length, 1)
    ok('预算：maxAttempts - 1 是硬上限（2 → 1 free）')
  } finally {
    await h.close()
  }
}

// ---- 5. 无键的 provider 不参与 ----
{
  const h = await harness({ discovery: { opencode: OPCODE_FREE, openrouter: OPENROUTER_FREE }, auth: { nvidia: { key: 'nvapi-CANARY' } } })
  try {
    const snap = await getJson(h.gate, '/gate/free')
    assert.equal(snap.providers.find((p) => p.id === 'openrouter').ready, false)
    assert.ok(!snap.expand.some((r) => r.startsWith('openrouter/')), '没有 openrouter key 就不展开它')
    ok('无键：provider 不参与展开（面板显示 key 未就绪）')
  } finally {
    await h.close()
  }
}

// ---- 6. 全局冷却：连续失败到阈值 → 跳过；全冷却 → 付费 ----
{
  // 只有一个免费模型，且它 429：3 次后冷却；maxAttempts=2 → 1 free + 1 paid
  const h = await harness({
    discovery: { opencode: ['always-fail-free'] },
    free: { max: 1, providers: ['opencode'], failure_threshold: 3, failure_cooldown_seconds: 600 },
    config: { policy: { max_fallback_attempts: 2, cooldown_seconds: 0 } },
  })
  try {
    for (let i = 0; i < 3; i++) {
      const res = await post(h.gate, { model: 'reeve/flash', stream: true, messages: [] }, { 'x-opencode-session-id': `s${i}` })
      assert.equal(res.status, 200, '免费失败 → 付费兜底成功')
    }
    let snap = await getJson(h.gate, '/gate/free')
    assert.equal(
      snap.cooling.length,
      1,
      `连续 3 次失败后进入全局冷却（实际 cooling=${JSON.stringify(snap.cooling)} expand=${JSON.stringify(snap.expand)} rows=${JSON.stringify((await h.rows()).map((r) => [r.provider, r.status, r.code, r.auto]))}）`,
    )
    const before = (await h.rows()).length
    const res = await post(h.gate, { model: 'reeve/flash', stream: true, messages: [] }, { 'x-opencode-session-id': 's-late' })
    assert.equal(res.status, 200)
    const fresh = (await h.rows()).slice(before)
    assert.equal(fresh.length, 1, '冷却后不再尝试免费，直接付费')
    assert.equal(fresh[0].provider, 'paid')
    ok('全局冷却：3 次失败 → 跳过；全冷却 → 直接付费（不再撞限流）')
    snap = null
  } finally {
    await h.close()
  }
}

// ---- 7. 台账 auto 标记 ----
{
  const h = await harness({ discovery: { opencode: OPCODE_FREE } })
  try {
    const res = await post(h.gate, { model: 'reeve/flash', stream: true, messages: [] })
    assert.equal(res.status, 200)
    const rows = await h.rows()
    assert.equal(rows.at(-1).auto, true, '展开出来的候选在台账里标 auto')
    assert.equal(rows.at(-1).provider, 'opencode')
    ok('台账：自动免费候选带 auto 标记（可统计/可解释）')
  } finally {
    await h.close()
  }
}

// ---- 8. 热更：free.max 改了，展开跟着变 ----
{
  const h = await harness({ discovery: { opencode: OPCODE_FREE }, watchMs: 20 })
  try {
    const before = (await getJson(h.gate, '/gate/free')).expand.length
    assert.equal(before, 3)
    const next = { ...BASE_CONFIG(h.upstream) }
    next.free = { ...next.free, max: 1 }
    await writeFile(h.configPath, JSON.stringify(next), 'utf8')
    // 热更 ≤5s 是宣传口径；测试里 watcher 20ms，等一拍即可
    let after = before
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      await sleep(50)
      after = (await getJson(h.gate, '/gate/free')).expand.length
      if (after === 1) break
    }
    assert.equal(after, 1, '热更后 free.max=1 → 展开 1 个')
    ok('热更：free.max 改了，展开跟着变（无需重启）')
  } finally {
    await h.close()
  }
}

// ---- 9. 并发：同一批请求的展开一致、不串扰 ----
{
  const h = await harness({ discovery: { opencode: OPCODE_FREE } })
  try {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => post(h.gate, { model: 'reeve/flash', stream: true, messages: [] }, { 'x-opencode-session-id': `c${i}` })),
    )
    assert.ok(results.every((r) => r.status === 200))
    const rows = await h.rows()
    assert.equal(rows.filter((r) => r.status === 'ok').length, 12)
    assert.ok(rows.filter((r) => r.auto).length >= 12, '全部走自动免费候选（首个即成功）')
    ok('并发：12 路同链请求展开一致、全部命中免费候选')
  } finally {
    await h.close()
  }
}

// ---- 10. 发现源缺失 / provider 未配置：如实进运行态，不参与展开 ----
{
  const h = await harness({
    discovery: { opencode: OPCODE_FREE },
    providers: { custom: { base_url: 'http://127.0.0.1:1', key: 'none' } },
    free: { providers: ['opencode', 'custom', 'ghost'] },
  })
  try {
    const snap = await getJson(h.gate, '/gate/free')
    const custom = snap.providers.find((p) => p.id === 'custom')
    const ghost = snap.providers.find((p) => p.id === 'ghost')
    assert.equal(custom.ready, true)
    assert.equal(custom.error, t('free.error.noSource'), '有 provider 但没 static/sources 时如实报')
    assert.equal(ghost.ready, false, '未配置的 provider 标记为未就绪')
    assert.ok(!snap.expand.some((r) => r.startsWith('custom/') || r.startsWith('ghost/')), '它们不参与展开')
    ok('发现源缺失 / provider 未配置：进运行态但不参与展开')
  } finally {
    await h.close()
  }
}

// ---- 11. 冷却到期后恢复展开 ----
{
  const h = await harness({
    discovery: { opencode: ['always-fail-free'] },
    free: { max: 1, providers: ['opencode'], failure_threshold: 3, failure_cooldown_seconds: 600 },
    config: { policy: { max_fallback_attempts: 2, cooldown_seconds: 0 } },
  })
  try {
    for (let i = 0; i < 3; i++) await post(h.gate, { model: 'reeve/flash', stream: true, messages: [] }, { 'x-opencode-session-id': `x${i}` })
    assert.equal((await getJson(h.gate, '/gate/free')).cooling.length, 1)
    h.advance(601_000)
    const after = await getJson(h.gate, '/gate/free')
    assert.equal(after.cooling.length, 0, '到期后不再显示冷却')
    assert.deepEqual(after.expand, ['opencode/always-fail-free'], '到期后重新参与展开')
    const res = await post(h.gate, { model: 'reeve/flash', stream: true, messages: [] }, { 'x-opencode-session-id': 'x-after' })
    assert.equal(res.status, 200)
    const rows = await h.rows()
    assert.equal(rows.at(-2).auto, true, '到期后确实又试了免费候选')
    ok('冷却：到期自动恢复展开（无需重启）')
  } finally {
    await h.close()
  }
}

// ---- 12. 预算为 0（maxAttempts=1）→ 不展开免费 ----
{
  const h = await harness({ discovery: { opencode: OPCODE_FREE }, config: { policy: { max_fallback_attempts: 1, cooldown_seconds: 0 } } })
  try {
    const snap = await getJson(h.gate, '/gate/free')
    assert.equal(snap.cap, 0, '总尝试 1 → 免费 0（给付费留唯一一跳）')
    assert.deepEqual(snap.expand, [])
    const res = await post(h.gate, { model: 'reeve/flash', stream: true, messages: [] })
    assert.equal(res.status, 200)
    const rows = await h.rows()
    assert.equal(rows.at(-1).provider, 'paid', '没有免费槽位时直接付费')
    assert.equal(rows.at(-1).auto, undefined)
    ok('预算 0：不展开免费，链直接走付费')
  } finally {
    await h.close()
  }
}

// ---- 13. enabled=false → 不展开 ----
{
  const h = await harness({ discovery: { opencode: OPCODE_FREE }, free: { enabled: false } })
  try {
    const snap = await getJson(h.gate, '/gate/free')
    assert.equal(snap.enabled, false)
    assert.deepEqual(snap.expand, [])
    const res = await post(h.gate, { model: 'reeve/flash', stream: true, messages: [] })
    assert.equal(res.status, 200)
    const rows = await h.rows()
    assert.equal(rows.at(-1).provider, 'paid')
    ok('enabled=false：免费模型池整体关闭，链照常走付费')
  } finally {
    await h.close()
  }
}

// ---- 14. 并发刷新去重：同一 provider 的发现只发一次 ----
{
  const h = await harness({ discovery: { opencode: OPCODE_FREE } })
  try {
    await getJson(h.gate, '/gate/free')
    const first = h.counts.opencode
    h.advance(31_000)
    await Promise.all([getJson(h.gate, '/gate/free'), getJson(h.gate, '/gate/free'), getJson(h.gate, '/gate/free')])
    assert.equal(h.counts.opencode, first + 1, '并发的过期刷新只发一次发现请求')
    ok('并发刷新：inflight 去重（同一 provider 只拉一次）')
  } finally {
    await h.close()
  }
}

// ---- 15. 过滤规则：all / 未知 filter 回落；默认 getAuth 不炸 ----
{
  const h = await harness({
    discovery: { opencode: OPCODE_FREE },
    free: { sources: { opencode: { url: 'https://opencode.ai/zen/v1/models', filter: 'all' } } },
  })
  try {
    const snap = await getJson(h.gate, '/gate/free')
    assert.ok(snap.providers.find((p) => p.id === 'opencode').models >= 5, "filter='all' 不过滤（含 paid-model）")
  } finally {
    await h.close()
  }
  const h2 = await harness({
    discovery: { opencode: OPCODE_FREE },
    free: { sources: { opencode: { url: 'https://opencode.ai/zen/v1/models', filter: 'no-such-filter' } } },
  })
  try {
    const snap = await getJson(h2.gate, '/gate/free')
    assert.equal(snap.providers.find((p) => p.id === 'opencode').models, 3, '未知 filter 回落到 opencode-free')
  } finally {
    await h2.close()
  }
  // 默认 getAuth（不传）也要能跑：provider 没 source → 不参与展开，但发现流程不炸
  const { createFreeLane } = await import('../src/gate/free.js')
  const lane = createFreeLane({
    getConfig: () => ({
      providers: { x: { id: 'x', base_url: 'http://127.0.0.1:1', key: 'none', auth: ['x'] } },
      free: { enabled: true, max: 1, providers: ['x'], prefer: [], deny: [], static: {}, sources: {} },
      policy: { max_fallback_attempts: 2 },
    }),
    now: () => 1,
  })
  const out = await lane.expand([{ free: true }, { provider: 'p', model: 'm' }])
  assert.deepEqual(out.targets, [{ provider: 'p', model: 'm' }])
  ok("过滤：all 全收 / 未知 filter 回落 / 默认 getAuth 安全")
}

// ---- 16. reeve/free 免费池专用链（free-only = [@free]，0.2.5）----
{
  // 成功路径：只打免费候选，付费模型零调用
  const h = await harness({
    discovery: { opencode: OPCODE_FREE },
    config: { chains: { 'free-only': { targets: ['@free'] } }, chain_for_model: { 'reeve/free': 'free-only' }, default_chain: 'free-only' },
  })
  try {
    const res = await post(h.gate, { model: 'reeve/free', stream: true, messages: [] })
    assert.equal(res.status, 200)
    assert.equal(res.fallback, '1/opencode/mimo-v2.6-flash-free', '专用链首跳就是免费候选')
    const rows = await h.rows()
    assert.ok(rows.length >= 1 && rows.every((r) => r.chain === 'free-only'), `台账链名 free-only（实际 ${JSON.stringify(rows.map((r) => r.chain))}）`)
    assert.ok(rows.every((r) => r.provider === 'opencode' && r.auto === true), '台账全是免费自动候选')
    assert.equal(h.upstream.calls.filter((c) => c.model === 'paid-ok').length, 0, '付费模型零调用（专用链语义）')
    ok('free-only：成功路径只打免费候选，付费零调用')
  } finally {
    await h.close()
  }
}
{
  // 全败：502 收场，同样不碰付费
  const h = await harness({
    discovery: { opencode: ['fail-free', 'also-fail-free'] },
    free: { max: 2 },
    config: { chains: { 'free-only': { targets: ['@free'] } }, chain_for_model: { 'reeve/free': 'free-only' }, default_chain: 'free-only' },
  })
  try {
    const res = await post(h.gate, { model: 'reeve/free', stream: true, messages: [] })
    assert.equal(res.status, 502, '免费候选全败 → 502（不落到付费）')
    const body = JSON.parse(res.text)
    assert.equal(body.error.attempts.length, 2, '两个免费候选都试过')
    assert.equal(h.upstream.calls.filter((c) => c.model === 'paid-ok').length, 0, '付费模型零调用')
    const rows = await h.rows()
    assert.ok(rows.length >= 1 && rows.every((r) => r.status === 'error' && r.auto === true), '台账全是免费失败行')
    ok('free-only：免费全败 502，永不碰付费')
  } finally {
    await h.close()
  }
}
{
  // 池关：空 plan 直接 502，连上游都不碰
  const h = await harness({
    discovery: { opencode: OPCODE_FREE },
    free: { enabled: false },
    config: { chains: { 'free-only': { targets: ['@free'] } }, chain_for_model: { 'reeve/free': 'free-only' }, default_chain: 'free-only' },
  })
  try {
    const res = await post(h.gate, { model: 'reeve/free', stream: true, messages: [] })
    assert.equal(res.status, 502)
    const body = JSON.parse(res.text)
    assert.ok(body.error.message.includes('没有可用候选'), `502 体说没有可用候选（实际：${body.error.message}）`)
    assert.deepEqual(body.error.skipped, [], '池关闭时 @free 被 expand 整个摘掉，不留在 plan 里')
    assert.equal(h.upstream.calls.length, 0, '空 plan：一个上游请求都没有')
    assert.equal((await h.rows()).length, 0, '空 plan：没有台账行')
    ok('free-only：免费池关闭 → 空 plan 502，零上游请求')
  } finally {
    await h.close()
  }
}

console.log(`\n免费模型池测试：${passed} 项全过`)