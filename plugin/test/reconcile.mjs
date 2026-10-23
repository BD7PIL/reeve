// 跨重启对账 + 转录分类的验证。
//   node plugin/test/reconcile.mjs
//
// reconcile.js 是本仓库**唯一没有参照实现可抄**的一块（omo-slim 的台账不落盘、
// 不跨重启），所以它必须有测试。

import { Ledger } from '../src/ledger.js'
import { reconcileParent, _resetReconcileGate } from '../src/reconcile.js'
import { classifyTranscript, VERDICT } from '../src/terminal-gate.js'
import { STATE, REASON } from '../src/constants.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`) }
  else { fail += 1; console.log(`  ❌ ${name} ${extra}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)
const silent = { debug: () => {} }

/** 造一个"重启后"的台账：记录在飞、且标了 statusUncertain。 */
function seed(ledger, { taskID, childSessionID }) {
  ledger.create({ taskID, parentSessionID: 'p1', childSessionID, background: true })
  const rec = ledger.get(taskID)
  rec.statusUncertain = true
  rec.reason = 'host_restarted'
  return rec
}

function makeCtx({ get, context }) {
  return { session: { get, context } }
}

// ---------------------------------------------------------------------------
section('转录分类（认不出形状必须 fail-open，绝不下结论）')
{
  ok('null → unknown', classifyTranscript(null) === VERDICT.UNKNOWN)
  ok('认不出的对象 → unknown', classifyTranscript({ weird: true }) === VERDICT.UNKNOWN)
  ok('空消息列表 → absent', classifyTranscript({ messages: [] }) === VERDICT.ABSENT)
  ok('assistant 有正文 → terminal',
    classifyTranscript({ messages: [{ role: 'assistant', parts: [{ type: 'text', text: 'done' }] }] }) === VERDICT.TERMINAL)
  ok('只有 user 消息 → absent',
    classifyTranscript({ messages: [{ role: 'user', content: 'hi' }] }) === VERDICT.ABSENT)
  ok('带 error → terminal',
    classifyTranscript({ messages: [{ role: 'assistant', error: { message: 'boom' } }] }) === VERDICT.TERMINAL)
  ok('裸数组也认', classifyTranscript([]) === VERDICT.ABSENT)
}

// ---------------------------------------------------------------------------
section('对账：子会话不存在 → 墓碑 + 拆除（不留幽灵）')
{
  _resetReconcileGate()
  const led = new Ledger({ logger: silent })
  seed(led, { taskID: 'r1', childSessionID: 'ses_gone' })
  const ctx = makeCtx({
    get: async () => { throw new Error('NotFoundError: session ses_gone not found') },
    context: async () => ({}),
  })
  const out = await reconcileParent({ ctx, ledger: led, logger: silent, parentSessionID: 'p1' })
  ok('落定 1 条', out.reconciled === 1)
  ok('状态 reconciled', led.get('r1').state === STATE.RECONCILED)
  ok('原因 child_session_missing', led.get('r1').reason === REASON.CHILD_SESSION_MISSING)
  ok('已墓碑', led.isTombstoned('r1') === true)
  ok('子会话索引已拆', led.forChildSession('ses_gone') === null)
}

// ---------------------------------------------------------------------------
section('对账：有终态 outcome → 落真实终态')
{
  for (const [outcome, expected] of [
    ['succeeded', STATE.COMPLETED],
    ['failed', STATE.ERROR],
    ['interrupted', STATE.STOPPED],
  ]) {
    _resetReconcileGate()
    const led = new Ledger({ logger: silent })
    seed(led, { taskID: `r_${outcome}`, childSessionID: `ses_${outcome}` })
    const ctx = makeCtx({
      get: async () => ({ session: { outcome } }),
      context: async () => ({}),
    })
    await reconcileParent({ ctx, ledger: led, logger: silent, parentSessionID: 'p1' })
    ok(`${outcome} → ${expected}`, led.get(`r_${outcome}`).state === expected)
    ok(`${outcome} 标了 terminalUnreconciled`, led.get(`r_${outcome}`).terminalUnreconciled === true)
  }
}

// ---------------------------------------------------------------------------
section('对账：存在但无输出 → stopped, unreconciled')
{
  _resetReconcileGate()
  const led = new Ledger({ logger: silent })
  seed(led, { taskID: 'r_idle', childSessionID: 'ses_idle' })
  const ctx = makeCtx({
    get: async () => ({ session: { id: 'ses_idle' } }),   // 没有 outcome
    context: async () => ({ messages: [] }),               // 转录为空 → absent
  })
  await reconcileParent({ ctx, ledger: led, logger: silent, parentSessionID: 'p1' })
  ok('状态 stopped', led.get('r_idle').state === STATE.STOPPED)
  ok('标了 terminalUnreconciled', led.get('r_idle').terminalUnreconciled === true)
  ok('标了 statusUncertain', led.get('r_idle').statusUncertain === true)
}

// ---------------------------------------------------------------------------
section('对账：其他错误 → fail-open，保持登记')
{
  _resetReconcileGate()
  const led = new Ledger({ logger: silent })
  seed(led, { taskID: 'r_err', childSessionID: 'ses_err' })
  const ctx = makeCtx({
    get: async () => { throw new Error('network unreachable') },
    context: async () => ({}),
  })
  const out = await reconcileParent({ ctx, ledger: led, logger: silent, parentSessionID: 'p1' })
  ok('没有落定', out.reconciled === 0)
  ok('仍是 running（fail-open）', led.get('r_err').state === STATE.RUNNING)
  ok('仍在台账里', led.get('r_err') !== null)
}

// ---------------------------------------------------------------------------
section('对账：没有子会话 id → 保持登记')
{
  _resetReconcileGate()
  const led = new Ledger({ logger: silent })
  led.create({ taskID: 'r_noid', parentSessionID: 'p1', background: true })
  led.get('r_noid').statusUncertain = true
  const ctx = makeCtx({ get: async () => ({}), context: async () => ({}) })
  const out = await reconcileParent({ ctx, ledger: led, logger: silent, parentSessionID: 'p1' })
  ok('没有落定', out.reconciled === 0)
  ok('仍是 running', led.get('r_noid').state === STATE.RUNNING)
  ok('给出了说明', out.notes.length === 1)
}

// ---------------------------------------------------------------------------
section('对账：每个父会话只跑一次（惰性触发的幂等）')
{
  _resetReconcileGate()
  const led = new Ledger({ logger: silent })
  seed(led, { taskID: 'r_once', childSessionID: 'ses_once' })
  let calls = 0
  const ctx = makeCtx({
    get: async () => { calls += 1; return { session: { outcome: 'succeeded' } } },
    context: async () => ({}),
  })
  await reconcileParent({ ctx, ledger: led, logger: silent, parentSessionID: 'p1' })
  await reconcileParent({ ctx, ledger: led, logger: silent, parentSessionID: 'p1' })
  await reconcileParent({ ctx, ledger: led, logger: silent, parentSessionID: 'p1' })
  ok('探活只发生一次', calls === 1, `实际 ${calls}`)
}

// ---------------------------------------------------------------------------
section('对账：已墓碑的不再复活')
{
  _resetReconcileGate()
  const led = new Ledger({ logger: silent })
  seed(led, { taskID: 'r_tomb', childSessionID: 'ses_tomb' })
  led.tombstone('r_tomb', REASON.CHILD_SESSION_MISSING)
  let calls = 0
  const ctx = makeCtx({
    get: async () => { calls += 1; return { session: { outcome: 'succeeded' } } },
    context: async () => ({}),
  })
  await reconcileParent({ ctx, ledger: led, logger: silent, parentSessionID: 'p1' })
  ok('没有探活已墓碑的任务', calls === 0)
  ok('状态仍是 reconciled', led.get('r_tomb').state === STATE.RECONCILED)
}

// ---------------------------------------------------------------------------
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
