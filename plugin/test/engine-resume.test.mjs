// E1 引擎 resume 测试（S6 门；施工规格 .zcode/plans/e1-construction-spec.md
// §4-S6 / §5-T3.4 / §5-T3.5 / §6 fault+clock 注入）。
//
// 覆盖矩阵（T3.4 四断言，标签 A1–A4 与规格 §5-T3.4 一一对应）：
//   A1  已完成步零 create 调用——取数自 mock driver 的 calls 数组（createIds 过滤 op='create'）；
//       resume 本身依赖表里没有 driver（零 create 是结构性的），断言打在「重跑侧」。
//   A2  在飞步重跑——abortAt 崩在 dispatching（会话未建）与 running 超时崩（会话已建）两路，
//       重跑侧都给该步重新派发：dispatching 位以「quiesce→failed→cooldown→重入边」复活，
//       running 位以 create 总数跨两代 driver 计 2 为证据（孤儿会话不认、开新会话重跑）。
//   A3  journal 一致——resume 纯读端（字节不变）+ 终局逐步校验 history 链每条边都合法
//       （LEGAL_TRANSITIONS）、attempts = dispatching 条数、终态与尾条一致、payload 完整回流。
//   A4  mid 截断 journal 识别为未完成并重跑——fault.failWrite='mid' 把截断一半的文本写盘后
//       报失败：新 journal 识别 torn，resume 把（可能已完成的）一切步归 pending，撕裂字节
//       原样保留；重跑以全新 storage 落地（torn 对该 runId 永久 deny，整段重跑是保守语义）。
//   T3.5 journal 写失败→不推进不广播：S2（journal 侧）/ S4（scheduler 侧）已分头断言，
//       本文件补 resume 流程侧——崩在 failWrite 三形态的 run 零 driver 调用零广播；恢复接线
//       遇写失败（quiesce 被拒）即停、零派发；after 形态「盘上新真相，重读即得」零重放。
//
// fault 面（§6，全经构造参数，禁 monkey-patch）：fault.abortAt 全步位（线性链 a→b→c→d 逐位
// 注入）、journal fault.failWrite before/mid/after、flakyStorage 单发真实写抛错（T3.5 的
// 另一来源，沿 scheduler 测试先例）。clock 全部注入 manualClock（§6）。
//
// 恢复接线（redrive 夹具）：scheduler 只接 declared/done（NOT_FRESH），mid-flight 恢复按规格
// 归 S6——resume 出计划（completed/pending），重派动作是调用方接线：在飞步先 quiesce 到
// failed（合法边），按 §1 cooldown 推过 60s 窗口，走 failed→dispatching 重入边，再用 S5
// typedAsk 把一步跑到终态并回写 journal（markEngineSession→running→done，同 scheduler 惯例）。
// S8 试点沿用同一套接线。
//
// 夹具全合成（内存 storage + 可控时钟 + 手工喂事件总线）；replay 录制件属 S7a，本文件不得引用。
// 期望逐行来自规格；实现与规格冲突时改实现，不改这里的期望。
//
// 运行：node plugin/test/engine-resume.test.mjs（assert 失败即抛、非零退出；成功自然退出）
import assert from 'node:assert/strict'

import { typedAsk } from '../src/engine/ask.js'
import { createDriver } from '../src/engine/driver.js'
import { LEGAL_TRANSITIONS, createJournal } from '../src/engine/journal.js'
import { matchAmend, promptFingerprint, resume } from '../src/engine/resume.js'
import { ABORT_CODE, SWEEP_TICK_MS, run } from '../src/engine/scheduler.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- 夹具基座（全合成）----
/** 内存 storage：read 初值 null（「无记录」），write 捕获最新文本。 */
const memStorage = () => {
  let text = null
  return { read: () => text, write: (t) => (text = t) }
}
/** 第 failAt 次写抛错的真实 storage（无 fault 注入，走 journal 的 write-failed 收敛路）。 */
const flakyStorage = (failAt) => {
  let text = null
  let n = 0
  return {
    read: () => text,
    write: (t) => {
      n += 1
      if (n === failAt) throw new Error(`ENOSPC: injected at write #${failAt}`)
      text = t
    },
  }
}
/** 可控时钟：now() 停在当前值，测试用 advance(ms) 显式推进（§6 注入，确定性）。 */
const manualClock = (start = 10_000) => {
  let t = start
  const now = () => t
  now.advance = (ms) => {
    t += ms
    return t
  }
  return now
}
/** 可喂事件的 AsyncIterable：feed 进队或直接唤醒挂起的 next()。 */
const makeEvents = () => {
  const queue = []
  const waiters = []
  return {
    feed: (ev) => {
      const wake = waiters.shift()
      if (wake) wake({ value: ev, done: false })
      else queue.push(ev)
    },
    events: {
      [Symbol.asyncIterator]: () => ({
        next: () => (queue.length > 0 ? Promise.resolve({ value: queue.shift(), done: false }) : new Promise((resolve) => waiters.push(resolve))),
      }),
    },
  }
}
const idleEv = () => ({ type: 'session.idle' })

const P = (id) => `任务 ${id}`
const step = (id, deps = [], extra = {}) => ({ stepId: id, prompt: P(id), deps, ...extra })
const sc = (id, text) => ({ name: id, match: { prompt: P(id) }, result: [{ status: 'done', text }] })
/** 重跑代 driver 的场景：钉死 sessionId（sess_rerun_<id>）——跨代不与初跑代合成 id 撞名，
    engine-owned 集合与「新会话 ≠ 旧会话」断言才有意义。 */
const sc2 = (id, text) => ({ name: id, match: { prompt: P(id) }, sessionId: `sess_rerun_${id}`, result: [{ status: 'done', text }] })
const rerunScenarios = (suffix) => CHAIN.map((id) => sc2(id, `${id} ${suffix}`))
const CHAIN = ['a', 'b', 'c', 'd']
const chainDecl = (runId, extraOf = {}) => ({ runId, steps: CHAIN.map((id, i) => step(id, i === 0 ? [] : [CHAIN[i - 1]], extraOf[id] ?? {})) })
const doneScenarios = (suffix) => CHAIN.map((id) => sc(id, `${id} ${suffix}`))

const tick = () => new Promise((r) => setTimeout(r, 0))
/** 轮询等待直到 f() 为真（微任务都在 tick 间隙跑完；超时即断言失败）。 */
const until = async (f, label, tries = 4000) => {
  for (let i = 0; i < tries && !f(); i += 1) await tick()
  assert.ok(f(), `等待超时：${label}`)
}
/** run() 终局看门狗：永不终局就是 bug，断言炸出而非挂死进程；终局后清掉看门狗定时器。 */
const settle = (p, ms = 8000) => {
  let timer = null
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('run() 未在时限内终局（调度循环悬挂）')), ms)
  })
  return Promise.race([p, watchdog]).finally(() => clearTimeout(timer))
}
/** 健康收尾：盲喂 idle 直到全步 done（每轮 poll 一次；线性链收敛充裕），再等 run 终局。 */
const runToCompletion = async (bus, journal, ids, p) => {
  for (let i = 0; i < ids.length * 4 + 8 && !ids.every((id) => journal.getStepState(id)?.state === 'done'); i += 1) {
    bus.feed(idleEv())
    await tick()
    await tick()
  }
  assert.ok(ids.every((id) => journal.getStepState(id)?.state === 'done'), '喂 idle 后未达全 done')
  return settle(p)
}
/** mock calls 取数口径（T3.4-A1）：create 调用的 prompt 序列。 */
const createIds = (driver) => driver.calls.filter((c) => c.op === 'create').map((c) => c.args.prompt)
const createCount = (driver, id) => driver.calls.filter((c) => c.op === 'create' && c.args.prompt === P(id)).length

/**
 * A3 的机械化口径：逐步校验 history 链每条边都合法（首条播种、边在 LEGAL_TRANSITIONS、
 * 前条 to = 后条 from）、attempts = dispatching 条数、lastDispatchAt = 末次派发、
 * journal 终态与尾条一致。任何一步被「绕过状态机」写过，这里必炸。
 */
const assertJournalConsistent = (journal, declaration, label) => {
  for (const stepOfDecl of declaration.steps) {
    const id = stepOfDecl.stepId
    const known = journal.getStepState(id)
    assert.ok(known, `${label} ${id}: journal 有记账`)
    let prev = null
    let dispatches = 0
    let lastDispatchAt
    for (const h of known.history) {
      assert.equal(h.from, prev, `${label} ${id}: history 链连续（记账 ${prev} → 条目 ${h.from}→${h.to}）`)
      if (prev === null) assert.equal(h.to, 'declared', `${label} ${id}: 首条必须是播种`)
      else assert.ok((LEGAL_TRANSITIONS[prev] ?? []).includes(h.to), `${label} ${id}: 非法边 ${prev}→${h.to}`)
      if (h.to === 'dispatching') {
        dispatches += 1
        lastDispatchAt = h.at
      }
      prev = h.to
    }
    assert.equal(known.state, prev, `${label} ${id}: journal 终态与 history 尾条一致`)
    assert.equal(known.attempts, dispatches, `${label} ${id}: attempts = dispatching 条数`)
    if (lastDispatchAt !== undefined) assert.equal(known.lastDispatchAt, lastDispatchAt, `${label} ${id}: lastDispatchAt = 末次派发时刻`)
  }
}

const COOLDOWN_MS = 60_000 // §1：同 step 两次 dispatch 间隔 cooldown（接线纪律；引擎内不强制）

/**
 * 恢复接线（S6 调用方形态，S8 试点同一套）：对 plan.pending 逐步——
 *   未播种 → 播种 declared；在飞（dispatching/running）→ 先 quiesce 到 failed（payload 记
 *   resume 事实）；failed（含 quiesce 结果与超时崩的）→ 按 §1 cooldown 推过末次 dispatch +
 *   60s，走 failed→dispatching 重入边；declared → 直接初派。然后 typedAsk 把一步跑到终态，
 *   成功回写 markEngineSession → running → done（payload 同 scheduler 惯例）。
 * 每次写都检查 ok——「先落盘再动作」：写被拒即停，driver 一个调用都不许发生（T3.5 接线侧）。
 */
async function redrive(declaration, journal, driver, pendingIds, now) {
  const byId = new Map(declaration.steps.map((s) => [s.stepId, s]))
  const outcomes = []
  const must = (r, what) => {
    if (!r.ok) throw new Error(`redrive: ${what} 被拒（${JSON.stringify(r)}）——先落盘再动作，停止重派`)
    return r
  }
  for (const stepId of pendingIds) {
    const stepOfDecl = byId.get(stepId)
    const known = journal.getStepState(stepId)
    const st = known ? known.state : null
    if (st === 'dispatching' || st === 'running') {
      must(journal.appendStepState(stepId, st, 'failed', { reason: 'resume', detail: 'mid-flight at crash' }), `quiesce ${stepId}（${st}→failed）`)
    }
    if (st === null) must(journal.appendStepState(stepId, null, 'declared'), `播种 ${stepId}`)
    const cur = journal.getStepState(stepId)
    if (cur.state === 'failed') {
      const last = cur.lastDispatchAt
      // §1 cooldown：注入时钟推过「末次 dispatch + 60s」（测试用可控时钟；生产等真实时间）
      if (Number.isFinite(last) && now() - last < COOLDOWN_MS && typeof now.advance === 'function') {
        now.advance(last + COOLDOWN_MS + 1 - now())
      }
      must(journal.appendStepState(stepId, 'failed', 'dispatching'), `重入边 ${stepId}（failed→dispatching）`)
    } else {
      must(journal.appendStepState(stepId, 'declared', 'dispatching'), `初派 ${stepId}（declared→dispatching）`)
    }
    const out = await typedAsk(driver, stepOfDecl, { title: `REEVE-E1 ${declaration.runId} ${stepId}`, now })
    if (!out.ok) {
      must(journal.appendStepState(stepId, 'dispatching', 'failed', { error: { reason: out.reason } }), `失败记账 ${stepId}`)
      outcomes.push({ stepId, ok: false, outcome: out })
      continue
    }
    must(journal.markEngineSession(out.sessionId), `engine-owned 记账 ${stepId}`)
    must(journal.appendStepState(stepId, 'dispatching', 'running', { sessionId: out.sessionId }), `running 记账 ${stepId}`)
    must(journal.appendStepState(stepId, 'running', 'done', { result: { text: out.text }, sessionId: out.sessionId }), `done 记账 ${stepId}`)
    outcomes.push({ stepId, ok: true, text: out.text, sessionId: out.sessionId })
  }
  return outcomes
}

// ---- 0. 参数校验（TypeError 轨）+ 分类口径边角 ----
console.log('0. 参数校验与分类口径')
{
  const J = () => createJournal({ storage: memStorage(), runId: 'run-0', now: manualClock() })
  const good = { runId: 'run-0', steps: [step('a')] }
  assert.throws(() => resume({ runId: 'run-0', steps: [{ stepId: 'a', prompt: '', deps: [] }] }, J()), TypeError, 'declaration 不合法（空 prompt）应抛 TypeError')
  assert.throws(() => resume({ runId: 'run-0', steps: [step('a', ['b']), step('b', ['a'])] }, J()), TypeError, 'declaration 环应抛')
  assert.throws(() => resume({ runId: 'run-0', steps: [step('x'), step('x')] }, J()), TypeError, 'declaration 重复 stepId 应抛')
  assert.throws(() => resume(good, null), TypeError, 'journal null 应抛')
  assert.throws(() => resume(good, {}), TypeError, 'journal 缺 face 应抛')
  assert.throws(() => resume(good, { getStepState: () => null }), TypeError, 'journal 缺 status face 应抛')
  assert.throws(() => resume(good, { status: () => ({ ok: true, runId: 'run-0' }) }), TypeError, 'journal 缺 getStepState face 应抛')
  {
    const other = createJournal({ storage: memStorage(), runId: 'run-other', now: manualClock() })
    assert.throws(() => resume({ runId: 'run-mine', steps: [step('a')] }, other), /不符.*matchAmend/, 'runId 不符应抛（跨 run 撞名守卫）')
  }
  // 分类口径：空声明；未播种全 pending；journal 多余步不入 completed（声明域限定）。
  {
    const plan = resume({ runId: 'run-empty', steps: [] }, createJournal({ storage: memStorage(), runId: 'run-empty', now: manualClock() }))
    assert.ok(plan.completed instanceof Map, 'completed 是 Map')
    assert.deepEqual([plan.completed.size, plan.pending], [0, []], '空声明：completed 空、pending 空')
  }
  {
    const j = createJournal({ storage: memStorage(), runId: 'run-fresh', now: manualClock() })
    j.appendStepState('zz', null, 'declared') // 不在声明里的步
    const plan = resume({ runId: 'run-fresh', steps: [step('a')] }, j)
    assert.deepEqual([[...plan.completed.keys()], plan.pending], [[], ['a']], '未播种 → pending；journal 多余步不进 completed')
  }
  // 全部非 done 态都归「未完成」（六态逐一构造，全走合法边）。
  const WALKS = {
    declared: [['s', null, 'declared']],
    dispatching: [['s', null, 'declared'], ['s', 'declared', 'dispatching']],
    running: [['s', null, 'declared'], ['s', 'declared', 'dispatching'], ['s', 'dispatching', 'running', { sessionId: 'sess_x' }]],
    failed: [['s', null, 'declared'], ['s', 'declared', 'dispatching'], ['s', 'dispatching', 'failed']],
    blocked: [['s', null, 'declared'], ['s', 'declared', 'dispatching'], ['s', 'dispatching', 'running'], ['s', 'running', 'blocked']],
    superseded: [['s', null, 'declared'], ['s', 'declared', 'superseded']],
  }
  for (const [state, walk] of Object.entries(WALKS)) {
    const j = createJournal({ storage: memStorage(), runId: `run-${state}`, now: manualClock() })
    for (const [id, from, to, payload] of walk) j.appendStepState(id, from, to, payload)
    const plan = resume({ runId: `run-${state}`, steps: [step('s')] }, j)
    assert.deepEqual([[...plan.completed.keys()], plan.pending], [[], ['s']], `${state} → 未完成（pending）`)
  }
  // done 的 result：payload 原样返还；无 payload 归一 {}；深拷贝隔离（改返还值不伤 journal/再取）。
  {
    const j = createJournal({ storage: memStorage(), runId: 'run-done', now: manualClock() })
    j.appendStepState('s', null, 'declared')
    j.appendStepState('s', 'declared', 'dispatching')
    j.appendStepState('s', 'dispatching', 'running', { sessionId: 'sess_k' })
    j.appendStepState('s', 'running', 'done', { result: { text: '原文' }, sessionId: 'sess_k', extra: { nested: [1] } })
    const plan = resume({ runId: 'run-done', steps: [step('s')] }, j)
    assert.deepEqual(plan.completed.get('s'), { result: { text: '原文' }, sessionId: 'sess_k', extra: { nested: [1] } }, 'result = done payload 原样（journal 返还）')
    plan.completed.get('s').extra.nested.push(99)
    plan.completed.get('s').result.text = '篡改'
    assert.deepEqual(j.getStepState('s').history.at(-1).payload.extra.nested, [1], '深拷贝：改返还值不伤 journal')
    assert.deepEqual(resume({ runId: 'run-done', steps: [step('s')] }, j).completed.get('s').extra.nested, [1], '再取依旧原样')
  }
  {
    const j = createJournal({ storage: memStorage(), runId: 'run-bare', now: manualClock() })
    j.appendStepState('s', null, 'declared')
    j.appendStepState('s', 'declared', 'dispatching')
    j.appendStepState('s', 'dispatching', 'running')
    j.appendStepState('s', 'running', 'done')
    assert.deepEqual(resume({ runId: 'run-bare', steps: [step('s')] }, j).completed.get('s'), {}, '无 payload 的 done 归一 {}')
  }
  ok('参数校验 8 路 TypeError（声明/face/runId 守卫）+ 六个非 done 态全归 pending + payload 返还/归一/深拷贝隔离')
}

// ---- 1. T3.4-A：fault.abortAt 全步位（线性链逐位崩溃 → resume → 接线重跑）----
console.log('1. T3.4-A abortAt 全步位')
for (const at of CHAIN) {
  const runId = `run-abort-${at}`
  const bus = makeEvents()
  const clock = manualClock(10_000)
  const decl = chainDecl(runId)
  const storage = memStorage()
  const runEvents = []
  const journal = createJournal({ storage, runId, now: clock })
  const driver1 = createDriver('mock', { scenarios: doneScenarios('初跑完'), now: clock })
  const p = run(decl, { journal, driver: driver1, fault: { abortAt: [at] }, now: clock, events: bus.events, onEvent: (e) => runEvents.push(e) })
  const prefix = CHAIN.slice(0, CHAIN.indexOf(at))
  const suffix = CHAIN.slice(CHAIN.indexOf(at) + 1)
  // 先挂上崩溃断言再驱动（run 的 rejection 不能悬空——无人接住即 unhandledRejection 崩进程）
  const crashed = assert.rejects(settle(p), (e) => e.code === ABORT_CODE && e.message.includes(`"${at}"`), `abortAt 命中 ${at}（dispatching 落盘后、create 前崩）`)
  for (const id of prefix) {
    await until(() => journal.getStepState(id)?.state === 'running', `${id} 入飞`)
    bus.feed(idleEv())
    await until(() => journal.getStepState(id)?.state === 'done', `${id} 完成`)
  }
  await crashed
  assert.equal(journal.getStepState(at)?.state, 'dispatching', `崩溃现场：${at} 停在 dispatching`)
  assert.deepEqual(
    runEvents.map((e) => [e.type, e.stepId]),
    prefix.flatMap((id) => [['dispatch', id], ['step-done', id]]),
    '崩溃后无终局广播（先落盘再广播的面一致）',
  )

  // resume：纯读端分类（T3.4 的计划侧）
  const rawBefore = storage.read()
  const plan = resume(decl, journal)
  assert.equal(storage.read(), rawBefore, 'A3：resume 纯读端——journal 字节不变')
  assert.deepEqual([...plan.completed.keys()], prefix, `completed = 崩溃前已 done 的前缀 ${JSON.stringify(prefix)}`)
  assert.deepEqual(plan.pending, [at, ...suffix], 'pending = 崩位 + 未播种后缀（声明序）')
  for (const id of prefix) {
    const createCall = driver1.calls.find((c) => c.op === 'create' && c.args.prompt === P(id))
    assert.deepEqual(
      plan.completed.get(id),
      { result: { text: `${id} 初跑完` }, sessionId: createCall.sessionId },
      `completed[${id}] = journal 返还的 done payload（与 mock calls 互证）`,
    )
  }

  // 接线重跑：quiesce 崩位 + cooldown + 重入边 + typedAsk（新一代 driver）
  const bus2 = makeEvents()
  const driver2 = createDriver('mock', { scenarios: rerunScenarios('重跑完'), now: clock })
  const outcomes = await redrive(decl, journal, driver2, plan.pending, clock)
  assert.deepEqual(
    outcomes.map((o) => [o.stepId, o.ok]),
    [at, ...suffix].map((id) => [id, true]),
    '重派全部成功',
  )

  // A1：已完成步零 create 调用（取数自 mock calls——两代 driver 合计前缀各恰 1 次，全在崩前）
  assert.deepEqual(createIds(driver2), [at, ...suffix].map(P), `A1：重跑侧只给 ${JSON.stringify([at, ...suffix])} 派发，已完成步零 create`)
  for (const id of prefix) {
    assert.equal(createCount(driver1, id), 1, `A1：${id} 初跑恰 1 次 create`)
    assert.equal(createCount(driver2, id), 0, `A1：${id} 重跑侧零 create`)
  }

  // A2：在飞步重跑——崩位重获新会话，attempts 恰 2（初派 + 重入）
  assert.equal(journal.getStepState(at).attempts, 2, `A2：${at} attempts=2（初派 + 重入）`)
  assert.notEqual(outcomes[0].sessionId, null, 'A2：在飞步重跑拿到新会话')

  // A3：journal 一致——全 done、链合法、attempts/payload 对账、resume 复读全 completed
  assertJournalConsistent(journal, decl, 'A3')
  for (const id of prefix) {
    assert.deepEqual(
      [journal.getStepState(id).attempts, journal.getStepState(id).history.length],
      [1, 4],
      `A3：${id} 未受崩溃影响（attempts=1、history=播种/派发/入飞/完成）`,
    )
    assert.deepEqual(journal.getStepState(id).history.at(-1).payload, { result: { text: `${id} 初跑完` }, sessionId: driver1.calls.find((c) => c.op === 'create' && c.args.prompt === P(id)).sessionId }, 'A3：前缀 done payload 分毫未动')
  }
  assert.deepEqual(
    [journal.getStepState(at).attempts, journal.getStepState(at).history.length],
    [2, 6],
    'A3：崩位 history = 播种/初派/quiesce/重入/入飞/完成（恰 6 条，全合法）',
  )
  assert.deepEqual(journal.getStepState(at).history.at(-4).payload, { reason: 'resume', detail: 'mid-flight at crash' }, 'A3：quiesce payload 记 resume 事实（播种/初派/quiesce/重入/入飞/完成的第 3 条）')
  const after = resume(decl, journal)
  assert.deepEqual([[...after.completed.keys()], after.pending], [CHAIN, []], 'A3：终局 resume 全 completed、零 pending')
  ok(`abortAt@${at}：分类精确 + A1 零 create（calls 取数）+ A2 在飞重跑 attempts=2 + A3 全链合法终局全 done`)
}

// ---- 2. T3.4-A2 强证据：running 位真崩（超时）→ 重跑开新会话，create 总数 2 ----
console.log('2. 在飞 running 崩（超时）重跑')
{
  const runId = 'run-inflight-timeout'
  const bus = makeEvents()
  const clock = manualClock(40_000)
  const decl = { runId, steps: [step('a'), step('c', ['a'], { timeoutMs: 1000 })] }
  const storage = memStorage()
  const journal = createJournal({ storage, runId, now: clock })
  const driver1 = createDriver('mock', { scenarios: [sc('a', 'a 初跑完'), { name: 'c', match: { prompt: P('c') }, result: [{ status: 'running' }] }], now: clock })
  const p = run(decl, { journal, driver: driver1, now: clock, events: bus.events })
  await until(() => journal.getStepState('a')?.state === 'running', 'a 入飞')
  bus.feed(idleEv())
  await until(() => journal.getStepState('a')?.state === 'done', 'a 完成')
  await until(() => journal.getStepState('c')?.state === 'running', 'c 入飞（脚本粘滞 running）')
  clock.advance(1000) // §6 可控时钟推进越过 timeoutMs → 兜底（独立于事件流）
  await new Promise((r) => setTimeout(r, SWEEP_TICK_MS + 80))
  await until(() => journal.getStepState('c')?.state === 'failed', '在飞步超时崩（running→failed）')
  const out = await settle(p)
  assert.equal(out.status, 'failed', 'run 以 failed 终局（c 死在在飞）')
  assert.equal(journal.getStepState('c').history.at(-1).payload.reason, 'timeout', '崩因 timeout 记账')

  const rawBefore = storage.read()
  const plan = resume(decl, journal)
  assert.deepEqual([[...plan.completed.keys()], plan.pending], [['a'], ['c']], 'resume：a 已完成、在飞死的 c 归未完成')
  assert.equal(storage.read(), rawBefore, 'A3：resume 字节不变')
  const driver2 = createDriver('mock', { scenarios: [sc2('c', 'c 重跑完')], now: clock })
  const outcomes = await redrive(decl, journal, driver2, plan.pending, clock)
  assert.deepEqual(outcomes.map((o) => [o.stepId, o.ok]), [['c', true]], 'c 重跑成功')
  assert.equal(createCount(driver1, 'c'), 1, 'A2：初跑 create 1 次')
  assert.equal(createCount(driver2, 'c'), 1, 'A2：重跑 create 1 次（合计 2——在飞步真重跑，孤儿会话不认）')
  assert.notEqual(outcomes[0].sessionId, driver1.calls.find((c) => c.op === 'create' && c.args.prompt === P('c')).sessionId, 'A2：新会话 ≠ 旧会话')
  assert.deepEqual(journal.getStepState('c').attempts, 2, 'A2：attempts=2')
  assert.deepEqual(journal.getStepState('c').history.at(-1).payload, { result: { text: 'c 重跑完' }, sessionId: outcomes[0].sessionId }, 'A3：done payload 回流新会话')
  assert.deepEqual(resume(decl, journal).pending, [], 'A3：终局零 pending')
  ok('在飞 running 崩：resume 归未完成 + 重跑 create 总数 2 + 新会话记账 + 全链一致')
}

// ---- 3. T3.4-C + T3.5：fault.failWrite 三形态（before/mid/after）----
console.log('3. failWrite 三形态')
{
  // 3a. before：盘上未落一字 → resume 全归未完成 → 同一 storage 新实例重跑（fresh 可写）。
  const runId = 'run-fw-before'
  const storage = memStorage()
  const clock = manualClock(20_000)
  const decl = chainDecl(runId)
  const runEvents = []
  const journal = createJournal({ storage, runId, fault: { failWrite: 'before' }, now: clock })
  const driver1 = createDriver('mock', { scenarios: doneScenarios('x'), now: clock })
  const out1 = await settle(run(decl, { journal, driver: driver1, now: clock, onEvent: (e) => runEvents.push(e) }))
  assert.deepEqual([out1.status, out1.reason], ['blocked', 'journal-not-ok'], '[before] 崩在首写')
  assert.equal(driver1.calls.length, 0, 'T3.5：写失败 → 零 driver 调用')
  assert.equal(runEvents.length, 0, 'T3.5：零 run 广播')
  assert.equal(storage.read(), null, '[before] 盘上未落一字')
  const j2 = createJournal({ storage, runId, now: clock })
  assert.equal(j2.status().fresh, true, '[before] 新实例 fresh（盘上无记录）')
  const plan = resume(decl, j2)
  assert.deepEqual([[...plan.completed.keys()], plan.pending], [[], CHAIN], '识别为未完成：一切步归 pending')
  const bus = makeEvents()
  const driver2 = createDriver('mock', { scenarios: rerunScenarios('重跑完'), now: clock })
  const out2 = await runToCompletion(bus, j2, CHAIN, run(decl, { journal: j2, driver: driver2, now: clock, events: bus.events }))
  assert.equal(out2.status, 'completed', '[before] 重跑 completed')
  assert.deepEqual(createIds(driver2), CHAIN.map(P), '[before] 全量重派（无可沿用进度）')
  assertJournalConsistent(j2, decl, '[before] 重跑后')
  ok('failWrite=before：resume 全 pending + 重跑零 create 可省（无进度可沿用）+ 全链一致')
}
{
  // 3b. mid（scheduler 级）：首写撕盘 → run blocked → torn 永久 → resume 全 pending → 全新 storage 重跑。
  const runId = 'run-fw-mid'
  const storage = memStorage()
  const clock = manualClock(21_000)
  const decl = chainDecl(runId)
  const runEvents = []
  const journal = createJournal({ storage, runId, fault: { failWrite: 'mid' }, now: clock })
  const driver1 = createDriver('mock', { scenarios: doneScenarios('x'), now: clock })
  const out1 = await settle(run(decl, { journal, driver: driver1, now: clock, onEvent: (e) => runEvents.push(e) }))
  assert.deepEqual([out1.status, out1.reason], ['blocked', 'journal-not-ok'], '[mid] 崩在首写')
  assert.equal(driver1.calls.length, 0, 'T3.5：零 driver 调用')
  assert.equal(runEvents.length, 0, 'T3.5：零 run 广播')
  const tornRaw = storage.read()
  assert.ok(tornRaw.length > 0, '[mid] 盘上是截断文本')
  assert.throws(() => JSON.parse(tornRaw), SyntaxError, '[mid] 盘上是撕裂 JSON')
  const j2 = createJournal({ storage, runId, now: clock })
  assert.deepEqual([j2.status().torn, j2.status().reason], [true, 'unparseable'], '[mid] 新实例识别 torn')
  const rawBefore = storage.read()
  const plan = resume(decl, j2)
  assert.deepEqual([[...plan.completed.keys()], plan.pending], [[], CHAIN], 'A4 识别半：torn → 一切步（含可能已完成的）归未完成')
  assert.equal(storage.read(), rawBefore, 'A4：resume 纯读端，撕裂字节原样保留')
  // 重跑：torn 对同 runId+storage 永久 deny → 全新 storage 落地（保守语义：整段重跑）。
  const storage2 = memStorage()
  const j3 = createJournal({ storage: storage2, runId, now: clock })
  const bus = makeEvents()
  const driver2 = createDriver('mock', { scenarios: rerunScenarios('重跑完'), now: clock })
  const out2 = await runToCompletion(bus, j3, CHAIN, run(decl, { journal: j3, driver: driver2, now: clock, events: bus.events }))
  assert.equal(out2.status, 'completed', 'A4 重跑半：全新 storage 全量重跑 completed')
  assert.deepEqual(createIds(driver2), CHAIN.map(P), 'A4 重跑半：全量重派')
  assert.equal(storage.read(), tornRaw, 'A4：旧 torn journal 字节自始至终未被触碰')
  assertJournalConsistent(j3, decl, '[mid] 重跑后')
  ok('failWrite=mid（scheduler 级）：torn 识别 + A4 全 pending + 重跑落新 storage + 旧撕裂字节保留')
}
{
  // 3c. after（scheduler 级）：首写已落盘（种子）但调用方 not-ok → 新实例重读即得 → declared 可续。
  const runId = 'run-fw-after'
  const storage = memStorage()
  const clock = manualClock(22_000)
  const decl = chainDecl(runId)
  const runEvents = []
  const journal = createJournal({ storage, runId, fault: { failWrite: 'after' }, now: clock })
  const driver1 = createDriver('mock', { scenarios: doneScenarios('x'), now: clock })
  const out1 = await settle(run(decl, { journal, driver: driver1, now: clock, onEvent: (e) => runEvents.push(e) }))
  assert.deepEqual([out1.status, out1.reason], ['blocked', 'journal-not-ok'], '[after] 首写后崩')
  assert.equal(driver1.calls.length, 0, 'T3.5：零 driver 调用（先落盘再动作守恒）')
  assert.equal(runEvents.length, 0, 'T3.5：零 run 广播')
  const disk = JSON.parse(storage.read())
  assert.deepEqual(Object.keys(disk.steps), ['a'], '[after] 盘上已有种子（新真相）')
  const j2 = createJournal({ storage, runId, now: clock })
  const plan = resume(decl, j2)
  assert.deepEqual([[...plan.completed.keys()], plan.pending], [[], CHAIN], '[after] declared 种子 ≠ 完成：仍归 pending')
  const bus = makeEvents()
  const driver2 = createDriver('mock', { scenarios: rerunScenarios('重跑完'), now: clock })
  const out2 = await runToCompletion(bus, j2, CHAIN, run(decl, { journal: j2, driver: driver2, now: clock, events: bus.events }))
  assert.equal(out2.status, 'completed', '[after] 同一 journal 直接续跑 completed（declared 家族可接）')
  assert.deepEqual(createIds(driver2), CHAIN.map(P), '[after] a 也重派（种子从未 create 过）')
  assertJournalConsistent(j2, decl, '[after] 重跑后')
  ok('failWrite=after（scheduler 级）：盘上新真相重读即得 + declared 续跑 + 零重放')
}
{
  // 3d. after（定点）：running→done 经故障实例写盘——调用方 not-ok + 零广播（T3.5），
  //     但盘上已是新真相：resume 以盘为准返还 completed（零 driver 调用），重跑零 create（A1 最纯形态）。
  const runId = 'run-fw-after2'
  const storage = memStorage()
  const clock = manualClock(23_000)
  const decl = chainDecl(runId)
  const journalEvents = []
  const j1 = createJournal({ storage, runId, now: clock, onEvent: (e) => journalEvents.push(e) })
  j1.appendStepState('a', null, 'declared')
  j1.appendStepState('a', 'declared', 'dispatching')
  j1.appendStepState('a', 'dispatching', 'running', { sessionId: 'sess_orig_a' })
  const seen = []
  const jf = createJournal({ storage, runId, fault: { failWrite: 'after' }, now: clock, onEvent: (e) => seen.push(e) })
  const bad = jf.appendStepState('a', 'running', 'done', { result: { text: 'a 初跑完' }, sessionId: 'sess_orig_a' })
  assert.equal(bad.ok, false, 'T3.5：故障实例调用 not-ok')
  assert.deepEqual([bad.reason, bad.form], ['fault-failWrite', 'after'], 'T3.5：原因/形态回带')
  assert.equal(seen.length, 0, 'T3.5：零广播（写失败不广播）')
  const j2 = createJournal({ storage, runId, now: clock })
  assert.deepEqual([j2.status().ok, j2.getStepState('a')?.state], [true, 'done'], '[after 定点] 新实例从盘上读到 done（重读即得，零重放）')
  const plan = resume(decl, j2)
  assert.deepEqual([...plan.completed.keys()], ['a'], 'resume：a 已完成')
  assert.deepEqual(plan.completed.get('a'), { result: { text: 'a 初跑完' }, sessionId: 'sess_orig_a' }, 'completed = 盘上 payload 原样')
  assert.deepEqual(plan.pending, ['b', 'c', 'd'], 'pending = 其余')
  const bus = makeEvents()
  const driver2 = createDriver('mock', { scenarios: rerunScenarios('重跑完'), now: clock })
  const out2 = await runToCompletion(bus, j2, CHAIN, run(decl, { journal: j2, driver: driver2, now: clock, events: bus.events }))
  assert.equal(out2.status, 'completed', '重跑 completed')
  assert.equal(createCount(driver2, 'a'), 0, 'A1：已完成步零 create（calls 取数）')
  assert.deepEqual(createIds(driver2), ['b', 'c', 'd'].map(P), 'A1：重跑侧只派 b/c/d')
  assert.equal(j2.getStepState('a').history.length, 4, 'A3：a 的记账分毫未动（播种/派发/入飞/完成）')
  assert.deepEqual(j2.getStepState('a').history.at(-1).payload, { result: { text: 'a 初跑完' }, sessionId: 'sess_orig_a' }, 'A3：a 的 done payload 原样')
  assert.deepEqual(resume(decl, j2).pending, [], 'A3：终局零 pending')
  ok('failWrite=after（定点）：T3.5 not-ok+零广播 与 盘上真相并存 → resume 以盘为准返还 + 重跑零 create')
}
{
  // 3e. mid（定点）：在飞 a 的 done 写被 mid 撕盘——盘上藏着可能已完成的步，resume 必须全归未完成。
  const runId = 'run-fw-mid2'
  const storage = memStorage()
  const clock = manualClock(24_000)
  const decl = chainDecl(runId)
  const j1 = createJournal({ storage, runId, now: clock })
  j1.appendStepState('a', null, 'declared')
  j1.appendStepState('a', 'declared', 'dispatching')
  j1.appendStepState('a', 'dispatching', 'running', { sessionId: 'sess_live_a' })
  const seen = []
  const jf = createJournal({ storage, runId, fault: { failWrite: 'mid' }, now: clock, onEvent: (e) => seen.push(e) })
  const bad = jf.appendStepState('a', 'running', 'done', { result: { text: 'a 完' }, sessionId: 'sess_live_a' })
  assert.deepEqual([bad.ok, bad.form], [false, 'mid'], 'T3.5：mid 形态调用 not-ok')
  assert.equal(seen.length, 0, 'T3.5：零广播')
  const tornRaw = storage.read()
  assert.throws(() => JSON.parse(tornRaw), SyntaxError, '[mid 定点] 盘上撕裂（半截 done 记录）')
  const j2 = createJournal({ storage, runId, now: clock })
  assert.deepEqual([j2.status().torn, j2.status().reason], [true, 'unparseable'], '[mid 定点] 识别 torn')
  const plan = resume(decl, j2)
  assert.deepEqual([[...plan.completed.keys()], plan.pending], [[], CHAIN], 'A4 识别半：撕裂藏着 a 的 done 也必须归未完成（宁可重跑，不可假完成）')
  assert.equal(storage.read(), tornRaw, 'A4：resume 后撕裂字节原样保留')
  const storage2 = memStorage()
  const j3 = createJournal({ storage: storage2, runId, now: clock })
  const bus = makeEvents()
  const driver2 = createDriver('mock', { scenarios: rerunScenarios('重跑完'), now: clock })
  const out2 = await runToCompletion(bus, j3, CHAIN, run(decl, { journal: j3, driver: driver2, now: clock, events: bus.events }))
  assert.equal(out2.status, 'completed', 'A4 重跑半：全新 storage 全量重跑')
  assert.deepEqual(createIds(driver2), CHAIN.map(P), 'A4 重跑半：a 也重派（进度不可信）')
  assert.equal(storage.read(), tornRaw, 'A4：旧 torn 全程未被触碰')
  ok('failWrite=mid（定点）：藏 done 的撕裂 journal → A4 全 pending + 整段重跑 + 字节保留')
}
{
  // 3f. T3.5 接线侧：恢复写被拒（failWrite before）→ 即停、零派发（先落盘再动作守恒）。
  const runId = 'run-fw-wiring'
  const storage = memStorage()
  const clock = manualClock(25_000)
  const decl = chainDecl(runId)
  const journalEvents = []
  const j1 = createJournal({ storage, runId, now: clock, onEvent: (e) => journalEvents.push(e) })
  j1.appendStepState('a', null, 'declared')
  j1.appendStepState('a', 'declared', 'dispatching')
  j1.appendStepState('a', 'dispatching', 'running', { sessionId: 'sess_w' })
  const jf = createJournal({ storage, runId, fault: { failWrite: 'before' }, now: clock })
  const rawBefore = storage.read()
  let stopped = null
  try {
    await redrive(decl, jf, createDriver('mock', { scenarios: doneScenarios('x'), now: clock }), ['a'], clock)
  } catch (e) {
    stopped = e
  }
  assert.ok(stopped && /quiesce/.test(stopped.message), `恢复写被拒即停（${stopped?.message?.slice(0, 60)}…）`)
  assert.equal(storage.read(), rawBefore, 'T3.5：盘上分毫未动')
  assert.equal(journalEvents.length, 3, 'T3.5：无新增广播（健康期 3 次后归零）')
  assert.equal(jf.status().degraded, true, '劣化实例保持 deny')
  ok('T3.5 接线侧：quiesce 写失败 → redrive 即停、零派发、盘/广播零动静')
}

// ---- 4. 附加缝：flakyStorage 单发写抛错 → 孤儿会话现场（T3.5-6e 的 resume 侧）----
console.log('4. 孤儿会话现场（单发写抛错）')
{
  const runId = 'run-orphan'
  const bus = makeEvents()
  const clock = manualClock(30_000)
  const decl = chainDecl(runId)
  const storage = flakyStorage(10) // 第 10 次写 = b 的 markEngineSession（b 的 create 已发生）
  const journal = createJournal({ storage, runId, now: clock })
  const driver1 = createDriver('mock', { scenarios: doneScenarios('初跑完'), now: clock })
  const p = run(decl, { journal, driver: driver1, now: clock, events: bus.events })
  await until(() => journal.getStepState('a')?.state === 'running', 'a 入飞')
  bus.feed(idleEv())
  // 崩溃实例就地劣化（写失败后读写一律 deny）——此后盘上真相必须新开 journal 读（journal 铁律 2），
  // 所以这里不等 getStepState，直接等 run 终局再换实例。
  const out = await settle(p)
  assert.deepEqual([out.status, out.reason], ['blocked', 'journal-not-ok'], 'mark 写抛错 → blocked')
  assert.equal(journal.status().degraded, true, '崩溃实例已劣化（getStepState 全 deny）')
  const j2 = createJournal({ storage, runId, now: clock })
  assert.deepEqual([j2.getStepState('a')?.state, j2.getStepState('b')?.state], ['done', 'dispatching'], '盘上真相：a 完成、b 停在 dispatching（孤儿现场）')
  assert.equal(createCount(driver1, 'b'), 1, 'b 的 create 已发生（孤儿会话）')
  assert.deepEqual(JSON.parse(storage.read()).engineSessions, [driver1.calls.find((c) => c.op === 'create' && c.args.prompt === P('a')).sessionId], '孤儿会话未入 engine-owned（写失败）')
  const plan = resume(decl, j2)
  assert.deepEqual([[...plan.completed.keys()], plan.pending], [['a'], ['b', 'c', 'd']], 'S6 处理：孤儿会话的步归未完成（不认旧会话）')
  const driver2 = createDriver('mock', { scenarios: rerunScenarios('重跑完'), now: clock })
  const outcomes = await redrive(decl, j2, driver2, plan.pending, clock)
  assert.equal(createCount(driver2, 'a'), 0, 'A1：已完成步零 create')
  assert.deepEqual(createIds(driver2), ['b', 'c', 'd'].map(P), '重跑侧派 b/c/d（b 开新会话）')
  assert.notEqual(outcomes[0].sessionId, driver1.calls.find((c) => c.op === 'create' && c.args.prompt === P('b')).sessionId, 'A2：b 重跑 ≠ 孤儿会话')
  assert.equal(j2.getStepState('b').attempts, 2, 'A2：b attempts=2（quiesce + 重入）')
  assert.deepEqual(JSON.parse(storage.read()).engineSessions.length, 4, 'engine-owned 终局 4 个（a 旧 + b/c/d 新）')
  assertJournalConsistent(j2, decl, '孤儿')
  assert.deepEqual(resume(decl, j2).pending, [], '终局零 pending')
  ok('孤儿会话：resume 归未完成 → 新会话重跑（不轮询孤儿）+ engine-owned 补记 + 全链一致')
}

// ---- 5. matchAmend（stepId + sha256(prompt) 字节判据）----
console.log('5. matchAmend')
{
  const oldDecl = {
    runId: 'run-amend',
    steps: [step('a'), step('b', ['a']), step('c', ['a'], { agent: 'reeve-critic' }), step('d', ['b', 'c'])],
  }
  // 全同 → 全 imported。
  assert.deepEqual(matchAmend(oldDecl, JSON.parse(JSON.stringify(oldDecl))), { imported: ['a', 'b', 'c', 'd'], changed: [], added: [], dropped: [] }, '全同声明 → 全 imported')
  // prompt 一字节之差 → changed（其余 imported）。
  const tweaked = JSON.parse(JSON.stringify(oldDecl))
  tweaked.steps[1].prompt = `${P('b')}。` // 恰加一个全角句号（字节变了）
  assert.deepEqual(matchAmend(oldDecl, tweaked), { imported: ['a', 'c', 'd'], changed: ['b'], added: [], dropped: [] }, 'prompt 一字节之差 → 不导入')
  // agent/model/deps 变更不阻塞导入（判据只钉 stepId + prompt，规格原文口径）。
  const meta = JSON.parse(JSON.stringify(oldDecl))
  meta.steps[0].deps = []
  meta.steps[2].agent = 'reeve-reviewer'
  meta.steps[3].model = { providerID: 'zhipuai', id: 'glm-5.3' }
  assert.deepEqual(matchAmend(oldDecl, meta).changed, [], 'agent/model/deps 变更不阻塞导入')
  // 声明序变化不阻塞（按 stepId 匹配，不按位置）。
  const reordered = { runId: 'run-amend', steps: [oldDecl.steps[3], oldDecl.steps[1], oldDecl.steps[0], oldDecl.steps[2]] }
  assert.deepEqual(matchAmend(oldDecl, reordered).imported, ['d', 'b', 'a', 'c'], '声明序变化按 stepId 匹配（returned 按 newDecl 序）')
  // 增删步。
  const grown = { runId: 'run-amend', steps: [step('a'), step('e', ['a'])] }
  assert.deepEqual(matchAmend(oldDecl, grown), { imported: ['a'], changed: [], added: ['e'], dropped: ['b', 'c', 'd'] }, '增删步分类（added/dropped）')
  // 同 prompt 异 stepId 不导入。
  const renamed = { runId: 'run-amend', steps: [step('a2')] }
  assert.deepEqual(matchAmend({ runId: 'run-amend', steps: [step('a')] }, renamed), { imported: [], changed: [], added: ['a2'], dropped: ['a'] }, '同 prompt 异 stepId 不导入')
  // 空声明两端。
  assert.deepEqual(matchAmend({ runId: 'r', steps: [] }, { runId: 'r', steps: [] }), { imported: [], changed: [], added: [], dropped: [] }, '空声明平凡')
  // 指纹面：64 位十六进制；字节敏感（中文多字节、首尾空白都算字节差）。
  assert.match(promptFingerprint('任务'), /^[0-9a-f]{64}$/, '指纹 = sha256 hex')
  assert.notEqual(promptFingerprint('任务'), promptFingerprint('任務'), '中文一字之差 → 指纹不等')
  assert.notEqual(promptFingerprint('任务'), promptFingerprint('任务 '), '尾随空白 → 指纹不等')
  // TypeError 轨：任一声明不合法即抛。
  assert.throws(() => matchAmend({ runId: 'r', steps: 'nope' }, { runId: 'r', steps: [] }), TypeError, 'oldDecl 不合法应抛')
  assert.throws(() => matchAmend({ runId: 'r', steps: [] }, { runId: 'r', steps: [step('x', ['ghost'])] }), TypeError, 'newDecl 未知引用应抛')
  // amend 集成：oldDecl 的 run（a done）× 修订稿——imported 步可沿用（resume 照常返还），
  // changed 步不得沿用（调用方契约：journal 不存 prompt，resume 无法自证，把关在 matchAmend）。
  {
    const j = createJournal({ storage: memStorage(), runId: 'run-amend', now: manualClock() })
    j.appendStepState('a', null, 'declared')
    j.appendStepState('a', 'declared', 'dispatching')
    j.appendStepState('a', 'dispatching', 'running', { sessionId: 'sess_am' })
    j.appendStepState('a', 'running', 'done', { result: { text: 'a 初跑完' }, sessionId: 'sess_am' })
    j.appendStepState('b', null, 'declared')
    const amended = JSON.parse(JSON.stringify(oldDecl))
    amended.steps[1].prompt = `${P('b')}（修订）`
    const verdict = matchAmend(oldDecl, amended)
    assert.deepEqual([verdict.imported, verdict.changed], [['a', 'c', 'd'], ['b']], 'amend 判定：b 改了 prompt → 不得沿用旧 b 的记账')
    const plan = resume(oldDecl, j)
    assert.deepEqual([[...plan.completed.keys()], plan.pending], [['a'], ['b', 'c', 'd']], '同源声明 resume：a 完成、b/c/d 未完成')
    ok('matchAmend：判据矩阵 + 指纹字节敏感 + TypeError 分轨 + amend 集成契约')
  }
}

console.log(`\n引擎 resume 测试（S6 门：T3.4 四断言 A1–A4 + T3.5 + matchAmend）：${passed} 项全过`)
