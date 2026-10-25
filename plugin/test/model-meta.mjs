// 档位元数据（/gate/model-meta）的离线验收：
//   · 三级别名解析（精确 provider 键 / canonical_model_id / 全局唯一 model id）
//   · 查无 / 歧义 → 字段整体省略（null），绝不编数
//   · `@free` 聚合：cost 恒 0 / 池内已知条目取 min / 全无数据走 context_floor
//   · tiers = chain_for_model → 链首跳；models.dev 缺字段时 meta 缺字段
//   · 集成：起真 GATE 打端点（零出网，models.dev / 发现源全 stub）
//
//   node plugin/test/model-meta.mjs
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startGate } from '../src/gate/gate.js'
import { computeModelMeta } from '../src/gate/model-meta.js'
import { BUNDLED_FALLBACK_PATH } from '../src/gate/config.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}
const silent = { debug: () => {} }

const RAW = {
  zhipuai: {
    models: {
      'glm-5.3': { limit: { context: 1_000_000, output: 131_072 }, cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 }, release_date: '2026-08-14' },
      'glm-5.3-flash': { canonical_model_id: 'zhipuai/glm-5.3-flash', limit: { context: 1_000_000, output: 131_072 }, cost: { input: 0.15, output: 0.5, cache_read: 0.03 }, release_date: '2026-08-26' },
    },
  },
  deepseek: {
    models: { 'deepseek-flash': { limit: { context: 1_000_000, output: 393_216 }, knowledge: '2025-05' } },
  },
  'vendor-x': { models: { 'shared-model': { limit: { context: 8_192, output: 1_024 } } } },
  'vendor-y': { models: { 'shared-model': { limit: { context: 4_096, output: 2_048 } } } },
}

// ---- 1. 纯计算：三级别名 / 查无省略 / 部分字段 ----
{
  const cfg = {
    chains: {
      a: { targets: ['zhipuai/glm-5.3'] }, // ① 精确键
      b: { targets: ['zhipuai-coding-plan/glm-5.3-flash'] }, // ② canonical
      c: { targets: ['deepseek/deepseek-flash'] }, // ③ 精确键（缺 cost → cost 省略）
      d: { targets: ['no-such/nobody'] }, // 查无 → null
      e: { targets: ['nosuch/shared-model'] }, // 歧义（链 provider 查无 + 两个上游同名）→ null
    },
    chain_for_model: { 'reeve/pro': 'a', 'reeve/standard': 'b', 'reeve/other': 'c', 'reeve/none': 'd', 'reeve/amb': 'e' },
    free: { context_floor: 131_072 },
  }
  const out = computeModelMeta({ config: cfg, raw: RAW, pool: [] })
  assert.deepEqual(out.models['zhipuai/glm-5.3'], { limit: { context: 1_000_000, output: 131_072 }, cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 }, released: '2026-08-14' }, '① 精确键全字段')
  assert.equal(out.models['zhipuai-coding-plan/glm-5.3-flash'].released, '2026-08-26', '② canonical 命中')
  assert.deepEqual(out.models['deepseek/deepseek-flash'].cost, undefined, 'models.dev 缺 cost → cost 整个省略')
  assert.deepEqual(out.models['deepseek/deepseek-flash'].knowledge, undefined, '不认识的字段不透传')
  assert.equal(out.models['no-such/nobody'], null, '查无 → null（诚实省略）')
  assert.equal(out.models['nosuch/shared-model'], null, '歧义（同名多 provider）→ null')
  assert.equal(out.tiers['reeve/pro'].cost.input, 1.4, 'tiers = chain_for_model → 链首跳')
  assert.equal(out.tiers['reeve/none'], null, '查无链路的档位 → null')
  assert.equal(out.tiers['reeve/amb'], null, '歧义链路的档位 → null')
  assert.ok(!JSON.stringify(out).includes('knowledge'), 'knowledge 不在应答里（Model.Info 没这个字段）')
  ok('纯计算：三级别名 / 查无与歧义省略 / 部分字段 / tiers 映射')
}

// ---- 2. 纯计算：`@free` 聚合（池内取 min / 全无数据走 floor）----
{
  const cfg = { chains: { f: { targets: ['@free'] } }, chain_for_model: { 'reeve/free': 'f' }, free: { context_floor: 131_072 } }
  const withData = computeModelMeta({ config: cfg, raw: RAW, pool: [{ provider: 'opencode', model: 'glm-5.3-flash-free', ref: 'opencode/glm-5.3-flash-free' }, { provider: 'zhipuai', model: 'glm-5.3', ref: 'zhipuai/glm-5.3' }] })
  assert.deepEqual(withData.models['@free'].cost, { input: 0, output: 0, cache_read: 0, cache_write: 0 }, '@free cost 恒 0（语义，不需要数据）')
  assert.equal(withData.models['@free'].limit.context, 1_000_000, '池内已知条目取 min(context)')
  assert.equal(withData.models['@free'].limit.output, 131_072, 'min(output)')
  assert.equal(withData.tiers['reeve/free'].cost.input, 0, 'reeve/free → @free 聚合')
  const noData = computeModelMeta({ config: cfg, raw: null, pool: [{ provider: 'opencode', model: 'mimo-v2.6-flash-free', ref: 'opencode/mimo-v2.6-flash-free' }] })
  assert.equal(noData.models['@free'].limit.context, 131_072, '全无数据 → context_floor（不虚标）')
  assert.equal(noData.models['@free'].limit.output, undefined, 'output 未知就省略')
  assert.equal(noData.models['@free'].released, undefined, 'released 未知就省略')
  ok('纯计算：@free 聚合（min / floor / cost 恒 0）')
}

// ---- 3. 集成：起真 GATE 打 /gate/model-meta ----
{
  const dir = await mkdtemp(join(tmpdir(), 'gate-meta-'))
  const upstream = await new Promise((r) => {
    const s = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    s.listen(0, '127.0.0.1', () => r({ s, base: `http://127.0.0.1:${s.address().port}` }))
  })
  const configPath = join(dir, 'fallback.jsonc')
  await writeFile(configPath, JSON.stringify({
    schema: 1,
    policy: { max_fallback_attempts: 4, cooldown_seconds: 60 },
    providers: {
      opencode: { base_url: upstream.base, key: 'public', lane: 'passthrough', models: ['*'] },
      zhipuai: { base_url: upstream.base, key: 'none' },
    },
    free: { enabled: true, max: 3, context_floor: 131_072, providers: ['opencode'], sources: { opencode: { url: 'https://opencode.ai/zen/v1/models', filter: 'opencode-free' } } },
    chains: {
      'free-only': { targets: ['@free'] },
      pro: { targets: ['zhipuai/glm-5.3'] },
    },
    agents: {},
    chain_for_model: { 'reeve/free': 'free-only', 'reeve/pro': 'pro' },
    default_chain: 'pro',
  }), 'utf8')
  const authPath = join(dir, 'auth.json')
  await writeFile(authPath, JSON.stringify({}), 'utf8')
  let t = 3_000_000
  let modalityHits = 0
  const fetchImpl = (url, opts) => {
    const u = String(url)
    if (u.startsWith('https://models.dev/api.json')) {
      modalityHits += 1
      return Promise.resolve(new Response(JSON.stringify(RAW), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    if (u.startsWith('https://opencode.ai/zen/v1/models')) {
      return Promise.resolve(new Response(JSON.stringify({ data: [{ id: 'glm-5.3-flash-free' }, { id: 'mimo-v2.6-flash-free' }] }), { status: 200 }))
    }
    if (/^http:\/\/127\.0\.0\.1:/.test(u)) return fetch(u, opts)
    return Promise.reject(new Error(`测试里禁止出网：${u}`))
  }
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
    configWatchMs: 1_000_000,
  })
  try {
    const res = await fetch(`http://127.0.0.1:${gate.port}/gate/model-meta`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.tiers['reeve/free'].cost.input, 0, '端点：reeve/free = @free 聚合（$0）')
    assert.equal(body.tiers['reeve/free'].limit.context, 131_072, '端点：池内模型不在 models.dev → floor')
    assert.equal(body.tiers['reeve/pro'].cost.input, 1.4, '端点：具名首跳命中 models.dev')
    assert.equal(body.chains['free-only'], '@free', 'chains 表登记 @free 首跳')
    assert.ok(body.computedAt, '带 computedAt')
    assert.ok(!JSON.stringify(body).includes('sk-') && !JSON.stringify(body).includes('CANARY'), '应答里没有密钥材料')
    const again = await fetch(`http://127.0.0.1:${gate.port}/gate/model-meta`)
    assert.equal((await again.json()).tiers['reeve/pro'].cost.input, 1.4, '端点可重复取')
    assert.ok(modalityHits <= 2, `models.dev 走 TTL 缓存（实际拉取 ${modalityHits} 次）`)
    ok('集成：/gate/model-meta 端到端（tiers/chains/无密钥/TTL）')
  } finally {
    await gate.dispose()
    await new Promise((r) => upstream.s.close(r))
    await rm(dir, { recursive: true, force: true })
  }
}

console.log(`\n档位元数据测试：${passed} 项全过`)
