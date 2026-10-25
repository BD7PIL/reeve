// REEVE 记账层的单元验证 —— 不依赖模型、不依赖 opencode，直接跑逻辑。
//   node plugin/test/unit.mjs
//
// 覆盖的是"最贵的 bug 是静默不一致"那几条：终态单调性、静默宽限、并发不自死锁、超时不可逆。

import assert from 'node:assert/strict'
import { Ledger } from '../src/ledger.js'
import { PLUGIN_VERSION } from '../src/constants.js'
import { Admission, _runtimes } from '../src/concurrency.js'
import { Supervisor } from '../src/supervisor.js'
import { decideStop, VERDICT } from '../src/terminal-gate.js'
import { STATE, REASON, STOP_CONFIRMATION_GRACE_MS } from '../src/constants.js'
import { SUBAGENT_ROSTER, ROSTER_MARKER, buildSubagentRoster, withRoster } from '../src/roster.js'
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REEVE_TIERS, TIER_LIMIT, TIER_VARIANTS, FREE_CONTEXT_FLOOR, STATIC_TIER_META, buildTierModel, resolveGateEndpoint } from '../src/models.js'
import { applyTierMeta, createTierMeta } from '../src/tier-meta.js'
import { configuredReeveModelIdsSync } from '../src/config-write.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`) }
  else { fail += 1; console.log(`  ❌ ${name} ${extra}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)
const silent = { debug: () => {} }

/** 轮询直到条件成立或超时 —— 比固定 sleep 可靠（定时器会迟到）。 */
async function waitFor(cond, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 5))
  }
  return cond()
}

// ---------------------------------------------------------------------------
section('台账：终态单调性（已发布的硬超时不可被迟到的完成替换）')
{
  const led = new Ledger({ logger: silent })
  led.create({ taskID: 't1', parentSessionID: 'p1', background: true })

  const first = led.commitTerminal('t1', STATE.ERROR, {
    source: 'wall-clock', reason: REASON.WALL_CLOCK_TIMEOUT, timedOut: true,
  })
  ok('首次落终态成功', first === true)
  ok('状态是 error', led.get('t1').state === STATE.ERROR)
  ok('标了 timedOut', led.get('t1').timedOut === true)

  const late = led.commitTerminal('t1', STATE.COMPLETED, { source: 'event' })
  ok('迟到的完成被拒绝', late === false)
  ok('状态仍是 error（没被覆盖）', led.get('t1').state === STATE.ERROR)
  ok('reason 仍是超时', led.get('t1').reason === REASON.WALL_CLOCK_TIMEOUT)
}

// ---------------------------------------------------------------------------
section('台账：墓碑不复活 + 在飞查询')
{
  const led = new Ledger({ logger: silent })
  led.create({ taskID: 't2', parentSessionID: 'p1', childSessionID: 'ses_child2', background: true })
  ok('在飞查询命中', led.running('p1').length === 1)

  led.tombstone('t2', REASON.CHILD_SESSION_MISSING)
  ok('墓碑后不再是 running', led.running('p1').length === 0)
  ok('状态是 reconciled', led.get('t2').state === STATE.RECONCILED)
  ok('标了 terminalUnreconciled', led.get('t2').terminalUnreconciled === true)
  ok('isTombstoned 为真', led.isTombstoned('t2') === true)
  ok('子会话索引已拆除', led.forChildSession('ses_child2') === null)
}

// ---------------------------------------------------------------------------
section('台账：落盘 + 重启恢复（如实标未知，不谎报）')
{
  const disk = new Map()
  const storage = {
    async set(k, v) { disk.set(k, v) },
    async get(k) { return disk.get(k) },
    async remove(k) { disk.delete(k) },
    async scan({ prefix, limit = 100 } = {}) {
      const entries = [...disk.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .slice(0, limit)
        .map(([key, value]) => ({ key, value }))
      return { entries }
    },
  }

  const a = new Ledger({ storage, logger: silent })
  a.create({ taskID: 't3', parentSessionID: 'p1', childSessionID: 'ses_child3', background: true })
  a.commitTerminal('t4', STATE.COMPLETED)
  a.create({ taskID: 't4', parentSessionID: 'p1', background: true })
  a.commitTerminal('t4', STATE.COMPLETED)
  await new Promise((r) => setTimeout(r, 10))

  const b = new Ledger({ storage, logger: silent })
  const res = await b.hydrate()
  ok(`从盘上恢复记录（${res.loaded} 条）`, res.loaded >= 2)
  ok('未误报截断（模拟存储按 prefix 全量返回）', res.truncated === false)
  ok('恢复后的 t3 状态仍是 running', b.get('t3')?.state === STATE.RUNNING)
  ok('恢复后的 t3 被标 statusUncertain（不谎报）', b.get('t3')?.statusUncertain === true)
  ok('恢复后的 t4 终态保持 completed', b.get('t4')?.state === STATE.COMPLETED)

  // 保留期修剪：只动已落终态的旧记录，在飞的不动
  const removed = await b.prune({ olderThanMs: 0, now: Date.now() + 1000 })
  ok('修剪删掉了终态记录', removed >= 1)
  ok('修剪没动在飞的记录', b.get('t3')?.state === STATE.RUNNING)
  ok('修剪后终态记录已移除', b.get('t4') == null) // 注意 get() 对不存在返回 null，不是 undefined
}

// ---------------------------------------------------------------------------
section('终态判定门：静默宽限（否则正常完成会被误报成死亡）')
{
  const now = 1_000_000
  ok('verdict=terminal → 不停止',
    decideStop({ verdict: VERDICT.TERMINAL, now }).stop === false)
  ok('verdict=unknown → 不停止（fail-open）',
    decideStop({ verdict: VERDICT.UNKNOWN, now }).stop === false)

  const fresh = decideStop({
    verdict: VERDICT.ABSENT, attemptStartedAt: now - 100, quiescentSince: now - 100, now,
  })
  ok('absent 但刚静默 100ms → 不停止（在宽限内）', fresh.stop === false)

  const settled = decideStop({
    verdict: VERDICT.ABSENT,
    attemptStartedAt: now - STOP_CONFIRMATION_GRACE_MS - 1,
    quiescentSince: now - STOP_CONFIRMATION_GRACE_MS - 1,
    now,
  })
  ok('absent 且静默超过宽限 → 停止', settled.stop === true)

  const justStarted = decideStop({
    verdict: VERDICT.ABSENT, attemptStartedAt: now, quiescentSince: null, now,
  })
  ok('absent 但任务刚开始（无静默证据）→ 不停止', justStarted.stop === false)
}

// ---------------------------------------------------------------------------
section('并发：档位解析 / 排队 / 嵌套豁免')
{
  _runtimes().clear()
  const adm = new Admission({ limits: { default: 2, providers: { acme: 1 }, models: { 'reeve/pro': 3 } } })

  ok('模型上限优先', adm.resolveLimit({ model: 'reeve/pro', provider: 'acme' }) === 3)
  ok('其次 provider 上限', adm.resolveLimit({ provider: 'acme' }) === 1)
  ok('最后默认上限', adm.resolveLimit({}) === 2)
  ok('0 = 无限', new Admission({ limits: { default: 0 } }).resolveLimit({}) === 0)

  const adm2 = new Admission({ limits: { default: 1 } })
  const r1 = await adm2.acquire('k1')
  ok('第一个拿到槽', adm2.activeCount === 1)

  let k2Granted = false
  const p2 = adm2.acquire('k2').then((rel) => { k2Granted = true; return rel })
  await new Promise((r) => setTimeout(r, 10))
  ok('第二个被排队（不是失败）', k2Granted === false && adm2.waitingCount === 1)

  r1()
  const r2 = await p2
  ok('释放后队首被放行', k2Granted === true)
  r2()

  // 嵌套豁免：已持槽的任务不再排队 —— 否则自死锁
  const adm3 = new Admission({ limits: { default: 1 } })
  const hold = await adm3.acquire('outer')
  const nestedRel = await adm3.acquire('inner', { nested: true })
  ok('嵌套任务被豁免（没有自死锁）', typeof nestedRel === 'function' && adm3.activeCount === 1)
  nestedRel()
  hold()
}

// ---------------------------------------------------------------------------
section('墙钟：到期中断 + 宽限后标不确定 + 不续期')
{
  const led = new Ledger({ logger: silent })
  const interrupted = []
  const sup = new Supervisor({
    ledger: led, logger: silent, abortGraceMs: 30,
    interrupt: async (r) => { interrupted.push(r.taskID) },
  })

  led.create({ taskID: 'w1', parentSessionID: 'p1', childSessionID: 'ses_w1', background: true })
  sup.arm('w1', 20)
  // 不要用固定 sleep 断言定时器 —— 事件循环会迟到。轮询到终态或超时。
  const settled = await waitFor(() => led.get('w1').terminalPublished, 1000)
  ok('到期后发了中断', interrupted.includes('w1'))
  ok('中断只发一次', interrupted.filter((x) => x === 'w1').length === 1)
  ok('宽限后落 error + timedOut', settled && led.get('w1').state === STATE.ERROR && led.get('w1').timedOut === true)
  ok('标了 statusUncertain', led.get('w1').statusUncertain === true)
  // 回归：发中断前必须打 wall_clock 标 —— 宿主会因这次中断回 execution.interrupted，
  // 事件处理器靠这个标把它归因成"墙钟超时"而不是"宿主中断"。
  // （没有它时实测会记成 host_interrupted:unknown 且 timedOut:false —— 踩过）
  ok('发中断前打了 interruptReason=wall_clock 标', led.get('w1').interruptReason === 'wall_clock')
  ok('interruptSent 已置位', led.get('w1').interruptSent === true)

  // 前台任务不该被武装
  led.create({ taskID: 'w2', parentSessionID: 'p1', background: false })
  ok('前台任务不武装墙钟', sup.arm('w2', 20) === false)

  // 同 generation 重复武装 = 不续期
  led.create({ taskID: 'w3', parentSessionID: 'p1', background: true })
  sup.arm('w3', 10_000)
  ok('同 generation 不重复武装（不续期）', sup.arm('w3', 10_000) === false)
  sup.stopAll()
}

// ---------------------------------------------------------------------------
section('名册：subagent 工具描述补名 + 与 agents/*.md 不漂移')
{
  const roster = buildSubagentRoster()
  ok('含标记（幂等靠它）', roster.includes(ROSTER_MARKER))
  for (const a of SUBAGENT_ROSTER) ok(`名册含 ${a.name}`, roster.includes(`- ${a.name}:`))

  // 幂等：钩子每回合都会触发，接第二次不能接出两段
  const once = withRoster('base')
  const twice = withRoster(once)
  ok('withRoster 幂等', once === twice)
  ok('空描述也能接（不会留一个前导空行）', !withRoster('').startsWith('\n'))
  ok('非字符串描述不炸', typeof withRoster(undefined) === 'string')

  // 名字漂移防护：名册必须与插件包里的 agents/*.md 一一对应（§6.8：agent 已搬进插件）。
  // （插件被单独安装时没有 ../agents，跳过而不是失败。）
  try {
    const dir = new URL('../agents/', import.meta.url)
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
    const expected = ['foreman', ...SUBAGENT_ROSTER.map((a) => a.name)].sort()
    ok(`agents/ 目录里正好这些角色（${files.length} 个）`,
      JSON.stringify(files.map((f) => f.replace(/\.md$/, '')).sort()) === JSON.stringify(expected))
    const foreman = readFileSync(new URL('foreman.md', dir), 'utf8')
    ok('foreman 的 prompt 里点名了全部 subagent',
      SUBAGENT_ROSTER.every((a) => foreman.includes(`\`${a.name}\``)))
    for (const a of SUBAGENT_ROSTER) {
      const md = readFileSync(new URL(`${a.name}.md`, dir), 'utf8')
      ok(`${a.name}.md 标了 hidden: true（前台不可见）`, /^hidden:\s*true$/m.test(md))
      ok(`${a.name}.md 是 subagent`, /^mode:\s*subagent$/m.test(md))
    }
  } catch (err) {
    console.log(`  ⏭ 跳过 agents/ 漂移检查（${String(err).slice(0, 60)}）`)
  }
}

// ---------------------------------------------------------------------------
// ---- resolveGateEndpoint：四级回落（纯函数；来源优先级不该靠碰真配置来验） ----
{
  const e = (o) => resolveGateEndpoint(o)
  ok('显式 gate.port 最优先', JSON.stringify(e({ gate: { port: 1234 } })) === JSON.stringify({ port: 1234, host: '127.0.0.1' }))
  ok('旧 proxy.port 作回落（迁移期配置还写着它）', e({ proxy: { port: 18081 } }).port === 18081)
  ok('再落到配置里的 providers.reeve 端点', JSON.stringify(e({ endpoint: { port: 18080, host: '203.0.113.5' } })) === JSON.stringify({ port: 18080, host: '203.0.113.5' }))
  ok('什么都没有 → 默认 8080', e({}).port === 8080 && e({}).host === '127.0.0.1')
  ok('gate 同时给 port 与 host', JSON.stringify(e({ gate: { port: 1, host: '0.0.0.0' }, proxy: { port: 2 }, endpoint: { port: 3 } })) === JSON.stringify({ port: 1, host: '0.0.0.0' }))
}


// ---- 档位与 GATE 兜底配置的自洽（0.2.5 起五档位；改名/删链在这里先红，别等真引擎 404）----
{
  const ids = REEVE_TIERS.map((t) => t.id)
  section('档位 × 兜底配置 自洽')
  ok('五个档位：flash/standard/pro/multimodal/free', JSON.stringify(ids) === JSON.stringify(['flash', 'standard', 'pro', 'multimodal', 'free']), `实际：${ids.join(',')}`)
  ok('不再注册 manual 档位', !ids.includes('manual'))
  for (const t of REEVE_TIERS) {
    ok(`档位 ${t.id} 的 limit = 1M/131072（付费候选最小值）`, t && TIER_LIMIT.context === 1_000_000 && TIER_LIMIT.output === 131_072)
    ok(`档位 ${t.id} 声明能吃图`, t.images === true)
  }
  ok('推理强度变体五档', JSON.stringify(TIER_VARIANTS) === JSON.stringify(['low', 'medium', 'high', 'xhigh', 'max']))
  {
    const freeLimit = buildTierModel(REEVE_TIERS.find((t) => t.id === 'free')).limit
    const paidLimit = buildTierModel(REEVE_TIERS.find((t) => t.id === 'standard')).limit
    ok('free 档 context = FREE_CONTEXT_FLOOR（不虚标 1M）', freeLimit.context === FREE_CONTEXT_FLOOR && FREE_CONTEXT_FLOOR === 131_072 && freeLimit.output === TIER_LIMIT.output)
    ok('付费四档 context 仍是 1M（链上付费候选最小值）', paidLimit.context === 1_000_000)
  }
  {
    // STATIC_TIER_META = 动态元数据拿不到时的兜底（2026-10-25 从 models.dev 钉死；改链不归它管）。
    ok('兜底：flash/free 首跳 @free → $0', STATIC_TIER_META.flash.cost.input === 0 && STATIC_TIER_META.free.cost.input === 0)
    ok('兜底：standard = zhipu glm-5.3-flash（$0.15/$0.5/cache 0.03）', STATIC_TIER_META.standard.cost.input === 0.15 && STATIC_TIER_META.standard.cost.output === 0.5 && STATIC_TIER_META.standard.cost.cache_read === 0.03)
    ok('兜底：pro = zhipu glm-5.3（$1.4/$4.4/cache 0.26）', STATIC_TIER_META.pro.cost.input === 1.4 && STATIC_TIER_META.pro.cost.output === 4.4 && STATIC_TIER_META.pro.cost.cache_read === 0.26)
    ok('兜底：released 钉在发布日期', STATIC_TIER_META.pro.released === '2026-08-14' && STATIC_TIER_META.standard.released === '2026-08-26')
    const model = buildTierModel(REEVE_TIERS.find((t) => t.id === 'pro'))
    ok('applyTierMeta：cost/limit/released 合进 Model.Info 且 idempotent', applyTierMeta(model, { cost: STATIC_TIER_META.pro.cost, released: STATIC_TIER_META.pro.released }) === true && model.cost[0].cache.read === 0.26 && model.time.released === Date.parse('2026-08-14') && applyTierMeta(model, { cost: STATIC_TIER_META.pro.cost, released: STATIC_TIER_META.pro.released }) === false)
    ok('applyTierMeta：limit 部分合并（缺 output 不动旧值）', applyTierMeta(model, { limit: { context: 262_144 } }) === true && model.limit.context === 262_144 && model.limit.output === 131_072)
    ok('applyTierMeta：空 meta 不动、返回 false', applyTierMeta(model, null) === false && applyTierMeta(model, {}) === false)
  }
  {
    // tier-meta 缓存：动态优先 / TTL / 失败保留上一份 / 签名不含 computedAt。
    let base = 'http://127.0.0.1:18080'
    let payload = { computedAt: 't1', tiers: { 'reeve/pro': { cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 }, released: '2026-08-14' } } }
    let t = 1_000_000
    let fetches = 0
    const meta = createTierMeta({
      getGateBase: () => base,
      now: () => t,
      fetchImpl: async () => {
        fetches += 1
        return { ok: true, json: async () => payload }
      },
    })
    await meta.refresh({})
    ok('tier-meta：拉到后 tierMeta 命中、签名非空', meta.tierMeta('reeve/pro')?.cost?.input === 1.4 && meta.signature !== '')
    const sigBefore = meta.signature
    payload = { ...payload, computedAt: 't2' }
    await meta.refresh({ force: true })
    ok('tier-meta：只有 computedAt 变 → 签名不变（不触发无谓 reload）', meta.signature === sigBefore)
    payload = { computedAt: 't3', tiers: { 'reeve/pro': { cost: { input: 9, output: 9, cache_read: 0, cache_write: 0 } } } }
    await meta.refresh({ force: true })
    ok('tier-meta：数据变 → 签名变 + 新值命中', meta.signature !== sigBefore && meta.tierMeta('reeve/pro').cost.input === 9)
    t += 60_000
    const f0 = fetches
    await meta.refresh({})
    ok('tier-meta：TTL 内 refresh 不拉取', fetches === f0)
    t += 6 * 60_000
    await meta.refresh({})
    ok('tier-meta：TTL 过期才重拉（值不变）', fetches === f0 + 1 && meta.tierMeta('reeve/pro').cost.input === 9)
    base = null
    await meta.refresh({ force: true })
    ok('tier-meta：GATE 没起（base=null）→ 保留上一份', meta.tierMeta('reeve/pro') !== null)
    const failing = createTierMeta({ getGateBase: () => 'http://127.0.0.1:1', now: () => t, fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
    await failing.refresh({})
    ok('tier-meta：首刷失败 → tierMeta 为 null（调用方走静态兜底）且不抛', failing.tierMeta('reeve/pro') === null && failing.signature === '')
  }
  {
    // 配置说话：opencode.jsonc 手写的 providers.reeve.models.* 不被元数据覆盖。
    const dir = mkdtempSync(join(tmpdir(), 'reeve-unit-'))
    const path = join(dir, 'opencode.jsonc')
    writeFileSync(path, '{\n // 注释\n "providers": { "reeve": { "models": { "standard": { "name": "my standard" }, "pro": {} } } }\n}\n', 'utf8')
    const ids = configuredReeveModelIdsSync({ configDir: dir })
    ok('configuredReeveModelIdsSync：配置手写的档位 id 集合', ids.has('standard') && ids.has('pro') && !ids.has('flash'))
    const none = configuredReeveModelIdsSync({ configDir: join(tmpdir(), 'reeve-unit-nope-' + Date.now()) })
    ok('configuredReeveModelIdsSync：读不到 → 空集', none.size === 0)
  }
  {
    const a = buildTierModel(REEVE_TIERS[0])
    const b = buildTierModel(REEVE_TIERS[1])
    ok('档位模型注册 5 个变体且 id = reasoningEffort',
      JSON.stringify(a.variants.map((v) => [v.id, v.settings?.reasoningEffort])) === JSON.stringify([['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max']]))
    ok('各档 variants 逐次新建、不共享引用', a.variants !== b.variants && a.variants[0] !== b.variants[0])
  }
  const bundled = JSON.parse(readFileSync(new URL('../default-fallback.json', import.meta.url), 'utf8'))
  const chainNames = Object.keys(bundled.chains ?? {})
  ok('打包默认 chain_for_model 恰为五个档位键（zhipu 直投别名 0.2.4 退役；reeve/free 0.2.5 加入）',
    JSON.stringify(Object.keys(bundled.chain_for_model ?? {}).sort()) === JSON.stringify(['reeve/flash', 'reeve/free', 'reeve/multimodal', 'reeve/pro', 'reeve/standard']))
  for (const [model, chain] of Object.entries(bundled.chain_for_model ?? {})) {
    if (model.startsWith('reeve/')) {
      ok(`chain_for_model.${model} 是注册过的档位`, ids.includes(model.slice('reeve/'.length)))
    }
    ok(`chain_for_model.${model} 指向存在的链`, chainNames.includes(chain), `链 ${chain} 不在 chains`)
  }
  for (const [agent, chain] of Object.entries(bundled.agents ?? {})) {
    ok(`agents.${agent} 指向存在的链`, chainNames.includes(chain), `链 ${chain} 不在 chains`)
  }
  ok(`default_chain（${bundled.default_chain}）存在`, chainNames.includes(bundled.default_chain))
  const foreman = readFileSync(new URL('../agents/foreman.md', import.meta.url), 'utf8')
  ok('foreman.md 不再钉 reeve/manual', !/^\s*model:\s*reeve\/manual\s*$/m.test(foreman))
  const pinned = /^\s*model:\s*(\S+)\s*$/m.exec(foreman)
  ok('foreman.md 的 model 钉死行已删（跟随会话选择）', pinned === null, pinned ? `仍有 ${pinned[1]}` : '')
  const structural = JSON.stringify({ chains: bundled.chains, agents: bundled.agents, chain_for_model: bundled.chain_for_model, default_chain: bundled.default_chain })
  ok('兜底配置结构里没有 manual 链或映射', !structural.includes('manual'))
}

// ---- 版本常量不许漂：PLUGIN_VERSION / provision.json 必须等于 package.json 的 version ----
{
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const provision = JSON.parse(readFileSync(new URL('../provision.json', import.meta.url), 'utf8'))
  ok(`PLUGIN_VERSION 与 package.json 一致（${PLUGIN_VERSION}）`, PLUGIN_VERSION === pkg.version, `常量 ${PLUGIN_VERSION} ≠ package ${pkg.version}`)
  ok('provision.json 的 version 与 package.json 一致', provision.version === pkg.version, `provision ${provision.version} ≠ package ${pkg.version}`)
  ok('provision.json 的 enginePlugin.spec 指向当前版本', provision.enginePlugin?.spec === `${pkg.name}@${pkg.version}`, `spec ${provision.enginePlugin?.spec} ≠ ${pkg.name}@${pkg.version}`)
}

// ---- agent / skill 描述：跟随 locale，且不能是 YAML 折叠符占位（'>'）----
{
  const { loadAgents, loadSkills } = await import('../src/register.js')
  const { setLocale, getLocale } = await import('../src/locale.js')
  const prev = getLocale()
  setLocale('en')
  const agentsEn = await loadAgents()
  const skillsEn = await loadSkills()
  ok('英文 agent 描述不是占位符', agentsEn.every((a) => typeof a.description === 'string' && a.description !== '>' && a.description.length > 10))
  ok('英文 skill 描述不是占位符', skillsEn.every((x) => typeof x.description === 'string' && x.description !== '>' && x.description.length > 10))
  ok('英文宿主拿到 description_en', /Orchestrator/.test(agentsEn.find((a) => a.id === 'foreman')?.description ?? ''))
  setLocale('zh-CN')
  const agentsZh = await loadAgents()
  ok('中文宿主拿到中文描述', /编排者/.test(agentsZh.find((a) => a.id === 'foreman')?.description ?? ''))
  setLocale(prev)
}

console.log(`
结果：${pass} 通过 / ${fail} 失败`)
