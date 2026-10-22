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
import { readdirSync, readFileSync } from 'node:fs'
import { resolveGateEndpoint } from '../src/models.js'

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


// ---- 版本常量不许漂：PLUGIN_VERSION / provision.json 必须等于 package.json 的 version ----
{
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const provision = JSON.parse(readFileSync(new URL('../provision.json', import.meta.url), 'utf8'))
  ok(`PLUGIN_VERSION 与 package.json 一致（${PLUGIN_VERSION}）`, PLUGIN_VERSION === pkg.version, `常量 ${PLUGIN_VERSION} ≠ package ${pkg.version}`)
  ok('provision.json 的 version 与 package.json 一致', provision.version === pkg.version, `provision ${provision.version} ≠ package ${pkg.version}`)
  ok('provision.json 的 enginePlugin.spec 指向当前版本', provision.enginePlugin?.spec === `${pkg.name}@${pkg.version}`, `spec ${provision.enginePlugin?.spec} ≠ ${pkg.name}@${pkg.version}`)
}

console.log(`
结果：${pass} 通过 / ${fail} 失败`)
