// E1 引擎调度器测试（S4 门；施工规格 .zcode/plans/e1-construction-spec.md
// §4-S4 / §5-T3.2 / §5-T3.2b / §5-T3.5 scheduler 侧 / §6 fault+clock 注入）。
//
// 覆盖矩阵：
//   T3.2  拓扑序正确（菱形 a→(b,c)→d：b/c 只在 a done 后派、d 只在 b,c done 后派；create 调用
//         次序即证据）+ cap 不超（数字帽与「concurrency 租户形状」计数帽两路；占槽并发峰值恰
//         = cap）+ 兄弟独立（a1 失败 → b1 未派先废 superseded，兄弟分支 a2→b2 照常完成）+
//         跨项目事件过滤（properties.locationDirectory ≠ directory 的事件不触碰 journal、
//         不触发轮询；无 location 的 v1 形状放行——deep-memory index.ts:180-186 同款）。
//   T3.2b 可控时钟推进越过 timeoutMs → 步 failed 进 journal（payload reason=timeout + journal
//         记 timeout 事件，§9）+ 零 idle 事件兜底仍触发（事件源静默 / 完全不给 events 两路）
//         + 未推进时钟不误杀 + 缺省 timeoutMs（DECLARATION_DEFAULTS）生效。
//   T3.5  scheduler 侧 fail-closed：journal 写失败（torn 预检 / failWrite before+after / 真实
//         写抛错 before+after create）→ run 不推进、零 driver 调用、零 run 广播。
//   附加缝：fault.abortAt（dispatching 落盘后、create 前抛 E1_ENGINE_ABORT——S6 resume 的
//         崩溃现场）；done 步续跑零 create 调用（S6 resume 的前置证据）；空声明平凡完成；
//         派发异常臂（create 抛错/缺 sessionId/帽拒/create 挂死 dispatching 超时/result 抛错/
//         未知 status/onEvent 抛错）与事件通道异常（events-end/events-error 后兜底照走）。
//   P1.2（蓝图 next-round-plan-v4.md 逐项写死）：schema 校验（合法/越界/耗尽）+ outputs 盘上
//         检查（缺→重派→done+下游 / 耗尽+下游作废 / ~/ 注入 homedir 展开 / 目录非文件 /
//         无字段无 schema 零影响）+ 窄域重试与熔断交互（pendingRetry 不计 consecutiveFailures /
//         耗尽计入触发熔断且步级 payload 仍 outputs-missing / 熔断打断冷却重试收口 blocked ∧
//         retry-pending 显示 / 结构性四臂与 timeout 不进重试环）+ cooldown 生效与跳过 +
//         叶子步 cooldown 期 run 不收口 + journal 旧 record 无版本字段可读 + retry/fs 参数面
//         + escalation×schema 判定序（问句先于校验）。
//
// 夹具全合成（内存 storage + 可控时钟 + 手工喂事件的总线）；replay 录制件属 S7a，本文件不得引用。
// 期望逐行来自规格；实现与规格冲突时改实现，不改这里的期望。
//
// 运行：node plugin/test/engine-scheduler.test.mjs（assert 失败即抛、非零退出；成功自然退出）
import assert from 'node:assert/strict'

import { Admission } from '../src/concurrency.js'
import { retryPrompt } from '../src/engine/ask.js'
import { DECLARATION_DEFAULTS, validateValue } from '../src/engine/declaration.js'
import { createDriver } from '../src/engine/driver.js'
import { createJournal } from '../src/engine/journal.js'
import { RETRYABLE_REASONS, RETRY_COOLDOWN_MS, RUN_FAILURE_LIMIT, SWEEP_TICK_MS, ABORT_CODE, NOT_FRESH_CODE, run } from '../src/engine/scheduler.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- 夹具基座（全合成：内存 storage、可控时钟、手工喂事件总线）----
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
/** 永不产出事件的 AsyncIterable（T3.2b「零 idle 事件到达」的脸）。 */
const silentEvents = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }

const P = (id) => `任务 ${id}`
const step = (id, deps = [], extra = {}) => ({ stepId: id, prompt: P(id), deps, ...extra })
const sc = (id, result, extra = {}) => ({ name: id, match: { prompt: P(id) }, result, ...extra })
const idleEv = (locationDirectory, sessionID) =>
  typeof locationDirectory === 'string' || typeof sessionID === 'string'
    ? { type: 'session.idle', properties: { ...(locationDirectory ? { locationDirectory } : {}), ...(sessionID ? { sessionID } : {}) } }
    : { type: 'session.idle' }

/** 手搓 driver（面合法：create/result/context 全函数）：覆盖 mock 造不出的派发异常臂。 */
const fakeDriver = ({ create, result } = {}) => ({
  create: create ?? (async () => ({ sessionId: 'sess_fake' })),
  result: result ?? (async () => ({ status: 'running' })),
  context: async () => ({}),
})

/** P1.2 假 fs 面：files/dirs 集合 + home + 调用记录（不碰真实盘；判「存在但非文件」用 dirs）。 */
const fakeFs = ({ files = [], dirs = [], home = '/home/u' } = {}) => {
  const fileSet = new Set(files)
  const dirSet = new Set(dirs)
  const calls = { existsSync: [], statSync: [], homedir: 0 }
  return {
    files: fileSet,
    dirs: dirSet,
    calls,
    existsSync: (p) => {
      calls.existsSync.push(p)
      return fileSet.has(p) || dirSet.has(p)
    },
    statSync: (p) => {
      calls.statSync.push(p)
      if (dirSet.has(p)) return { isFile: () => false }
      return { isFile: () => true }
    },
    homedir: () => {
      calls.homedir += 1
      return home
    },
  }
}

/** 一套测试装具：journal + mock driver + run() 同时起跑；计数两级广播（scheduler 的 run 事件 / journal 的盘上事件）。 */
const rig = ({ runId, steps, scenarios = [], now = manualClock(), fault = null, journalFault = null, storage = memStorage(), cap, directory, events, driver: customDriver, retry, fs }) => {
  const runEvents = []
  const journalEvents = []
  const journal = createJournal({ storage, runId, fault: journalFault, now, onEvent: (e) => journalEvents.push(e) })
  const driver = customDriver ?? createDriver('mock', { scenarios, now, fault })
  const p = run({ runId, steps }, { journal, driver, cap, fault, directory, events, now, onEvent: (e) => runEvents.push(e), retry, fs })
  return { p, journal, driver, storage, runEvents, journalEvents, now }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
/** 轮询等待直到 f() 为真（微任务都在 tick 间隙跑完；超时即断言失败）。 */
const until = async (f, label, tries = 2000) => {
  for (let i = 0; i < tries && !f(); i += 1) await tick()
  assert.ok(f(), `等待超时：${label}`)
}
/** run() 终局看门狗：永不终局就是 bug，断言炸出而非挂死进程；终局后清掉看门狗定时器（不拖住事件循环）。 */
const settle = (p, ms = 8000) => {
  let timer = null
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('run() 未在时限内终局（调度循环悬挂）')), ms)
  })
  return Promise.race([p, watchdog]).finally(() => clearTimeout(timer))
}
const createIds = (driver) => driver.calls.filter((c) => c.op === 'create').map((c) => c.args.prompt)
const resultCalls = (driver) => driver.calls.filter((c) => c.op === 'result').length
const journalEventTypes = (storage) => (storage.read() ? JSON.parse(storage.read()).events.map((e) => e.type) : [])
/** 由 journal history 重建「任一时刻在飞 running 步数」的峰值（cap 不超的时间线证据）。 */
const peakRunning = (journal, ids) => {
  const marks = []
  for (const id of ids) {
    const h = journal.getStepState(id).history
    const up = h.find((e) => e.to === 'running')
    const down = [...h].reverse().find((e) => e.from === 'running')
    if (up) marks.push([up.at, 1], [down ? down.at : Number.POSITIVE_INFINITY, -1])
  }
  marks.sort((x, y) => x[0] - y[0])
  let cur = 0
  let max = 0
  for (const [, d] of marks) {
    cur += d
    max = Math.max(max, cur)
  }
  return max
}

// ---- 0. 参数校验（TypeError = 程序错误，fail-fast）+ 边界面 ----
console.log('0. 参数校验与边界面')
{
  const J = () => createJournal({ storage: memStorage(), runId: 'run-0', now: manualClock() })
  const D = (scenarios = []) => createDriver('mock', { scenarios, now: manualClock() })
  const good = { runId: 'run-0', steps: [step('a')] }
  await assert.rejects(run({ runId: 'run-0', steps: [{ stepId: 'a', prompt: '', deps: [] }] }, { journal: J(), driver: D() }), TypeError, 'declaration 不合法（空 prompt）应拒')
  await assert.rejects(run(good, { journal: { appendStepState: () => {} }, driver: D() }), TypeError, 'journal 缺 face 应拒')
  await assert.rejects(run(good, { journal: J(), driver: {} }), (e) => e.code === 'E1_DRIVER_BAD_ARGS', 'driver 缺面应拒')
  await assert.rejects(run(good, { journal: J(), driver: D(), cap: -1 }), TypeError, 'cap 负数应拒')
  await assert.rejects(run(good, { journal: J(), driver: D(), cap: 'x' }), TypeError, 'cap 非数字非租户应拒')
  await assert.rejects(run(good, { journal: J(), driver: D(), cap: {} }), TypeError, 'cap 对象缺 acquire 应拒')
  await assert.rejects(run(good, { journal: J(), driver: D(), now: 'x' }), TypeError, 'now 非函数应拒')
  await assert.rejects(run(good, { journal: J(), driver: D(), onEvent: 1 }), TypeError, 'onEvent 非函数应拒')
  await assert.rejects(run(good, { journal: J(), driver: D(), fault: 5 }), TypeError, 'fault 非对象应拒')
  await assert.rejects(run(good, { journal: J(), driver: D(), fault: { abortAt: 'a' } }), TypeError, 'abortAt 非数组应拒')
  await assert.rejects(run(good, { journal: J(), driver: D(), directory: '' }), TypeError, 'directory 空串应拒')
  await assert.rejects(run(good, { journal: J(), driver: D(), events: 42 }), TypeError, 'events 非 AsyncIterable 应拒')
  // journal 带 mid-flight 步 → NOT_FRESH 拒（S4 只接干净 run；恢复归 S6）。
  {
    const j = createJournal({ storage: memStorage(), runId: 'run-dirty', now: manualClock() })
    j.appendStepState('z', null, 'declared')
    j.appendStepState('z', 'declared', 'superseded')
    await assert.rejects(run({ runId: 'run-dirty', steps: [step('z')] }, { journal: j, driver: D() }), (e) => e.code === NOT_FRESH_CODE, 'mid-flight 步拒跑')
  }
  // done 步续跑：零 driver 调用（S6 resume 的前置证据），盘上 payload 回收 sessionId/text。
  {
    const j = createJournal({ storage: memStorage(), runId: 'run-done', now: manualClock() })
    j.appendStepState('w', null, 'declared')
    j.appendStepState('w', 'declared', 'dispatching')
    j.appendStepState('w', 'dispatching', 'running', { sessionId: 'sess_w' })
    j.appendStepState('w', 'running', 'done', { sessionId: 'sess_w', result: { text: '旧文' } })
    const out = await run({ runId: 'run-done', steps: [step('w')] }, { journal: j, driver: D(), now: manualClock(7_000) })
    assert.deepEqual([out.status, out.completed, out.pending], ['completed', ['w'], []], 'done 步续跑平凡完成')
    assert.deepEqual([out.steps.w.state, out.steps.w.attempts, out.steps.w.sessionId, out.steps.w.text], ['done', 1, 'sess_w', '旧文'], 'done 步读数来自盘上')
    assert.equal(out.at, 7000, '终态 at 跟注入时钟')
  }
  // 空声明平凡完成（schema：空数组合法）；cap=0 = 无限（concurrency.js 同款语义）。
  {
    const seen = []
    const out = await run({ runId: 'run-empty', steps: [] }, { journal: createJournal({ storage: memStorage(), runId: 'run-empty', now: manualClock() }), driver: D(), cap: 0, now: manualClock(), onEvent: (e) => seen.push(e.type) })
    assert.equal(out.status, 'completed', '空声明 completed')
    assert.deepEqual(seen, ['run-completed'], '空声明只广播 run-completed')
  }
  ok('参数校验 13 路 TypeError 分轨 + NOT_FRESH 拒 mid-flight + done 续跑零调用 + 空声明平凡完成')
}

// ---- 1. T3.2 拓扑序（菱形 a→(b,c)→d）----
console.log('1. T3.2 拓扑序')
{
  const bus = makeEvents()
  const clock = manualClock(20_000)
  const { p, journal, driver, runEvents } = rig({
    runId: 'run-diamond',
    steps: [step('a'), step('b', ['a'], { agent: 'reeve-critic', model: { providerID: 'zhipuai', id: 'glm-5.3', variant: 'role-critic' } }), step('c', ['a']), step('d', ['b', 'c'])],
    scenarios: [sc('a', [{ status: 'running' }, { status: 'done', text: 'A-ok' }]), sc('b', [{ status: 'done', text: 'B-ok' }]), sc('c', [{ status: 'done', text: 'C-ok' }]), sc('d', [{ status: 'done', text: 'D-ok' }])],
    now: clock,
    events: bus.events,
  })
  await until(() => createIds(driver).length >= 1, 'a 派发')
  assert.deepEqual(createIds(driver), [P('a')], '首轮就绪集只有 a（b/c/d 依赖未完成）')
  assert.equal(journal.getStepState('b').state, 'declared', 'b 仍在 declared')
  bus.feed(idleEv())
  await until(() => resultCalls(driver) >= 1, 'a 首轮轮询')
  assert.equal(driver.calls.at(-1).response.status, 'running', '首轮轮询吃到脚本第 1 条')
  clock.advance(100)
  bus.feed(idleEv())
  await until(() => createIds(driver).length >= 3, 'b、c 派发')
  assert.deepEqual(createIds(driver).slice(1), [P('b'), P('c')], 'a done 后 b、c 按声明序派发；d 仍不派')
  assert.equal(journal.getStepState('a').state, 'done', 'a 已 done')
  clock.advance(100)
  bus.feed(idleEv())
  await until(() => createIds(driver).length >= 4, 'd 派发')
  assert.deepEqual(createIds(driver), [P('a'), P('b'), P('c'), P('d')], 'b、c 双 done 后才派 d（调用次序即拓扑证据）')
  const seq = (op, prompt) => driver.calls.find((c) => c.op === op && (c.args?.prompt === prompt || c.args?.sessionId)).seq
  assert.ok(seq('create', P('d')) > seq('result'), 'd 的 create 晚于所有 result 调用（同轮先轮询后派发）')
  clock.advance(100)
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'completed', 'run completed')
  assert.deepEqual(out.completed, ['a', 'b', 'c', 'd'], 'completed 按声明序')
  assert.equal(out.steps.a.text, 'A-ok', 'done text 回流')
  assert.deepEqual(createIds(driver).length, 4, '恰好 4 次 create')
  assert.ok(driver.calls.every((c) => c.op !== 'context'), '调度器不读 context（result.text 足够）')
  // create 参数面：title 锚点前缀（§2-1）+ agent/model 零转换直传（F4）。
  const cb = driver.calls.find((c) => c.op === 'create' && c.args.prompt === P('b'))
  assert.deepEqual(
    { title: cb.args.title, agent: cb.args.agent, model: cb.args.model },
    { title: 'REEVE-E1 run-diamond b', agent: 'reeve-critic', model: { providerID: 'zhipuai', id: 'glm-5.3', variant: 'role-critic' } },
    'title=REEVE-E1 <runId> <stepId>；agent/model 原样直传',
  )
  // 时间戳证据：a 的 done 写入严格早于 d 的派发时钟值。
  assert.ok(journal.getStepState('a').history.at(-1).at < journal.getStepState('d').history.find((e) => e.to === 'dispatching').at, 'done(a) 的 at < dispatching(d) 的 at')
  // 广播序列：dispatch/step-done 严格交替，终局 run-completed（先落盘再广播）。
  assert.deepEqual(
    runEvents.map((e) => [e.type, e.stepId ?? null]),
    [['dispatch', 'a'], ['step-done', 'a'], ['dispatch', 'b'], ['dispatch', 'c'], ['step-done', 'b'], ['step-done', 'c'], ['dispatch', 'd'], ['step-done', 'd'], ['run-completed', null]],
    'run 事件序列与拓扑同构',
  )
  ok('T3.2 拓扑序：菱形四步派发次序/调用序/时间戳三重证据 + title 锚点 + model 直传 + 广播同构 + 不读 context')
}

// ---- 2. T3.2 cap 不超（数字帽 / 租户形状计数帽两路）----
console.log('2. T3.2 cap 不超')
const capCase = async ({ cap, counting }) => {
  const bus = makeEvents()
  const clock = manualClock(30_000)
  const ids = ['s1', 's2', 's3', 's4']
  const gate = counting
    ? (() => {
        const admission = new Admission({ limits: { default: 2 } })
        let cur = 0
        const stats = { cur, max: 0 }
        return {
          acquire: async (key) => {
            const release = await admission.acquire(key)
            stats.cur += 1
            stats.max = Math.max(stats.max, stats.cur)
            return () => {
              stats.cur -= 1
              release()
            }
          },
          stats: () => stats,
        }
      })()
    : undefined
  const { p, journal, driver } = rig({
    runId: 'run-cap',
    steps: ids.map((id) => step(id)),
    scenarios: ids.map((id) => sc(id, [{ status: 'running' }, { status: 'done', text: `${id} 完` }])),
    now: clock,
    cap: counting ? gate : cap,
    events: bus.events,
  })
  await until(() => createIds(driver).length >= 2, 'cap 内首批派发')
  assert.deepEqual(createIds(driver), [P('s1'), P('s2')], 'cap=2：只有前两步入飞，s3/s4 排队')
  assert.deepEqual(ids.filter((id) => journal.getStepState(id).state === 'running'), ['s1', 's2'], 'journal 在飞恰 2')
  bus.feed(idleEv())
  await until(() => resultCalls(driver) >= 2, '首轮轮询')
  assert.equal(createIds(driver).length, 2, '脚本 running，帽未释放，无人新派')
  clock.advance(100)
  bus.feed(idleEv())
  await until(() => createIds(driver).length >= 4, '释放后排队步补位')
  assert.deepEqual(createIds(driver), [P('s1'), P('s2'), P('s3'), P('s4')], 's1/s2 done 释放槽位后 s3/s4 才派')
  clock.advance(100)
  bus.feed(idleEv())
  await until(() => resultCalls(driver) >= 4, 's3/s4 首轮轮询')
  clock.advance(100)
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'completed', 'run completed')
  assert.equal(peakRunning(journal, ids), 2, 'journal 时间线重建：在飞峰值恰 = cap')
  if (counting) {
    assert.deepEqual(gate.stats(), { cur: 0, max: 2 }, '租户形状帽：峰值恰 2 且全部释放')
  }
  return out
}
{
  const outA = await capCase({ cap: 2 })
  assert.equal(outA.runId, 'run-cap', '数字帽跑通')
  ok('T3.2 cap：数字帽排队不失败 + 释放补位 + 时间线峰值恰 2')
}
{
  await capCase({ counting: true })
  ok('T3.2 cap：concurrency 租户形状（acquire(key)→release()）计数帽峰值恰 2、清仓归零')
}

// ---- 3. T3.2 兄弟独立 + 连续失败熔断 ----
console.log('3. T3.2 兄弟独立与熔断')
{
  const bus = makeEvents()
  const { p, journal, driver, runEvents } = rig({
    runId: 'run-sib',
    steps: [step('a1'), step('a2'), step('b1', ['a1']), step('b2', ['a2'])],
    scenarios: [sc('a1', [{ status: 'failed', errorPart: 'boom' }]), sc('a2', [{ status: 'done', text: 'a2 完' }]), sc('b2', [{ status: 'done', text: 'b2 完' }])],
    now: manualClock(40_000),
    events: bus.events,
  })
  await until(() => createIds(driver).length >= 2, 'a1/a2 派发')
  bus.feed(idleEv())
  await until(() => createIds(driver).length >= 3, 'b2 补位派发')
  assert.deepEqual(createIds(driver), [P('a1'), P('a2'), P('b2')], 'b1 因 a1 失败永不派发')
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'failed', '有失败步 → run failed')
  assert.deepEqual([out.completed, out.failed, out.superseded, out.pending], [['a2', 'b2'], ['a1'], ['b1'], []], '兄弟分支独立：a1 失败只废自己的下游 b1')
  const b1 = journal.getStepState('b1')
  assert.deepEqual([b1.state, b1.attempts], ['superseded', 0], 'b1 未派先废（attempts=0）')
  assert.deepEqual(b1.history.at(-1).payload, { reason: 'dep-failed', via: 'a1' }, 'superseded payload 记失败源')
  const a1 = journal.getStepState('a1')
  assert.deepEqual(a1.history.at(-1).payload, { error: { status: 'failed', errorPart: 'boom' } }, 'failed payload 收 errorPart')
  assert.deepEqual(runEvents.map((e) => [e.type, e.stepId ?? null]), [['dispatch', 'a1'], ['dispatch', 'a2'], ['step-failed', 'a1'], ['superseded', 'b1'], ['step-done', 'a2'], ['dispatch', 'b2'], ['step-done', 'b2'], ['run-failed', null]], '广播序列：失败→废下游→兄弟照常')
  ok('T3.2 兄弟独立：a1 失败不碰 a2/b2；b1 superseded（payload via a1）；failed 收敛不冒泡')
}
{
  // 连续失败熔断：3 连败（无成功间隔）→ run blocked，journal 记 run-blocked。
  const bus = makeEvents()
  const { p, journal, driver, storage, runEvents } = rig({
    runId: 'run-breaker',
    steps: [step('f1'), step('f2'), step('f3')],
    scenarios: [sc('f1', [{ status: 'failed', errorPart: 'x1' }]), sc('f2', [{ status: 'failed', errorPart: 'x2' }]), sc('f3', [{ status: 'failed', errorPart: 'x3' }])],
    now: manualClock(41_000),
    events: bus.events,
  })
  await until(() => createIds(driver).length >= 3, '三败步派发')
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'blocked', '3 连败 → blocked')
  assert.equal(out.reason, 'consecutive-failures', 'blocked 原因')
  assert.deepEqual(out.blocked, { trigger: 'consecutive-failures', failures: RUN_FAILURE_LIMIT, lastStep: 'f3' }, '熔断信息（上限取导出常量，不复制数字）')
  assert.ok(journalEventTypes(storage).includes('run-blocked'), 'journal 记 run-blocked 事件')
  assert.deepEqual(
    runEvents.map((e) => [e.type, e.stepId ?? null]),
    [['dispatch', 'f1'], ['dispatch', 'f2'], ['dispatch', 'f3'], ['step-failed', 'f1'], ['step-failed', 'f2'], ['step-failed', 'f3'], ['run-blocked', null]],
    '广播序列以 run-blocked 收尾',
  )
  ok(`连续失败熔断：${RUN_FAILURE_LIMIT} 连败 → blocked + journal run-blocked`)
}
{
  // 非连续失败（成功清零）：败→成→败 → 不熔断，run failed。
  const bus = makeEvents()
  const { p, driver, storage } = rig({
    runId: 'run-reset',
    steps: [step('x1'), step('ok1'), step('x2')],
    scenarios: [sc('x1', [{ status: 'failed', errorPart: 'y1' }]), sc('ok1', [{ status: 'done', text: '好' }]), sc('x2', [{ status: 'failed', errorPart: 'y2' }])],
    now: manualClock(42_000),
    events: bus.events,
  })
  await until(() => createIds(driver).length >= 3, '三步派发')
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'failed', '成功清零后非连续败 → failed 而非 blocked')
  assert.equal(out.reason, undefined, '无熔断原因')
  assert.ok(!journalEventTypes(storage).includes('run-blocked'), 'journal 无 run-blocked')
  ok('连续失败清零：败→成→败 不熔断，run failed')
}

// ---- 4. T3.2 跨项目事件过滤 ----
console.log('4. T3.2 跨项目事件过滤')
{
  const bus = makeEvents()
  const { p, journal, driver, storage } = rig({
    runId: 'run-filter',
    steps: [step('x', [], { timeoutMs: 60_000 })],
    scenarios: [sc('x', [{ status: 'running' }, { status: 'done', text: 'x 完' }])],
    now: manualClock(43_000),
    directory: '/proj/alpha',
    events: bus.events,
  })
  await until(() => journal.getStepState('x')?.state === 'running', 'x 入飞')
  const rawBefore = storage.read()
  bus.feed(idleEv('/proj/beta', 'sess_foreign')) // 他项目事件：丢弃
  await tick()
  await tick()
  await tick()
  assert.equal(resultCalls(driver), 0, '外来 idle 不触发轮询')
  assert.equal(storage.read(), rawBefore, '外来事件不触碰 journal（字节不变）')
  bus.feed(idleEv('/proj/alpha', 'sess_x')) // 本项目：放行
  await until(() => resultCalls(driver) >= 1, '本项目 idle 触发轮询')
  bus.feed(idleEv()) // 无 location（v1 宿主形状）：放行（deep-memory 同款）
  const out = await settle(p)
  assert.equal(out.status, 'completed', '本项 + 无 location 两路放行后完成')
  assert.equal(resultCalls(driver), 2, '轮询恰两次')
  ok('T3.2 跨项目过滤：他项目事件零触碰；本项/v1 无 location 放行')
}
{
  // 未配 directory → 不过滤（一切事件放行）。
  const bus = makeEvents()
  const { p, driver } = rig({
    runId: 'run-nofilter',
    steps: [step('y')],
    scenarios: [sc('y', [{ status: 'done', text: 'y 完' }])],
    now: manualClock(44_000),
    events: bus.events,
  })
  await until(() => resultCalls === undefined || createIds(driver).length >= 1, 'y 派发')
  bus.feed(idleEv('/somewhere/else', 'sess_y'))
  const out = await settle(p)
  assert.equal(out.status, 'completed', '无 directory 不过滤，外来 location 也放行')
  assert.equal(resultCalls(driver), 1, '外来事件触发了轮询')
  ok('跨项目过滤关：缺 directory 不过滤')
}

// ---- 5. T3.2b 超时兜底（可控时钟推进越过 timeoutMs；零 idle 事件仍触发）----
console.log('5. T3.2b 超时兜底')
{
  // 事件源静默（零 idle 事件到达）：推进时钟越过 timeoutMs → failed 进 journal。
  const clock = manualClock(50_000)
  const { p, journal, storage, runEvents } = rig({
    runId: 'run-timeout',
    steps: [step('t1', [], { timeoutMs: 1000 })],
    scenarios: [sc('t1', [{ status: 'running' }])],
    now: clock,
    events: silentEvents,
  })
  await until(() => journal.getStepState('t1')?.state === 'running', 't1 入飞（派发不需要事件）')
  await new Promise((r) => setTimeout(r, SWEEP_TICK_MS + 80)) // 兜底 sweep 心跳至少跑过一轮
  assert.equal(journal.getStepState('t1').state, 'running', '时钟未推进：sweep 不误杀')
  clock.advance(1000) // 可控时钟推进越过 timeoutMs
  await until(() => journal.getStepState('t1')?.state === 'failed', '零 idle 事件：超时兜底仍触发')
  const tail = journal.getStepState('t1').history.at(-1)
  assert.deepEqual(tail.payload, { reason: 'timeout', timeoutMs: 1000, elapsedMs: 1000 }, 'failed payload 记超时事实')
  assert.ok(journalEventTypes(storage).includes('timeout'), 'journal 记 timeout 事件（§9）')
  const out = await settle(p)
  assert.deepEqual([out.status, out.failed], ['failed', ['t1']], '超时步收敛为 run failed')
  assert.deepEqual(runEvents.map((e) => [e.type, e.stepId ?? null]), [['dispatch', 't1'], ['step-timeout', 't1'], ['run-failed', null]], '广播：step-timeout + run-failed')
  ok('T3.2b 超时兜底：静默事件源 + 时钟推进 → failed 进 journal + timeout 事件；未推进不误杀')
}
{
  // 完全不给 events 参数（零事件基建）：缺省 timeoutMs（900000）同样兜底。
  const clock = manualClock(60_000)
  const { p, journal } = rig({
    runId: 'run-timeout-default',
    steps: [step('t2')],
    scenarios: [sc('t2', [{ status: 'running' }])],
    now: clock,
  })
  await until(() => journal.getStepState('t2')?.state === 'running', 't2 入飞')
  clock.advance(DECLARATION_DEFAULTS.timeoutMs - 1)
  await new Promise((r) => setTimeout(r, SWEEP_TICK_MS + 80))
  assert.equal(journal.getStepState('t2').state, 'running', '缺省超时未到不误杀')
  clock.advance(1)
  await until(() => journal.getStepState('t2')?.state === 'failed', '缺省 timeoutMs 兜底触发')
  const tail = journal.getStepState('t2').history.at(-1)
  assert.equal(tail.payload.timeoutMs, DECLARATION_DEFAULTS.timeoutMs, 'timeoutMs 取声明缺省（单一事实来源）')
  const out = await settle(p)
  assert.equal(out.status, 'failed', 'run failed')
  ok('T3.2b 无 events 参数 + 缺省 timeoutMs：兜底独立于事件流成立')
}

// ---- 6. T3.5 scheduler 侧 fail-closed：journal 写失败 → 不推进、零 create、零 run 广播 ----
console.log('6. T3.5 scheduler 侧 fail-closed')
{
  // 6a. torn 预检：盘上坏件 → 启动即 blocked，零调用零广播，字节不动。
  const storage = memStorage()
  storage.write('{"runId": "run-t5", "ste')
  const { p, driver, runEvents } = rig({
    runId: 'run-t5',
    steps: [step('a')],
    scenarios: [sc('a', [{ status: 'done', text: 'x' }])],
    storage,
    now: manualClock(70_000),
  })
  const out = await settle(p)
  assert.deepEqual([out.status, out.reason], ['blocked', 'journal-not-ok'], 'torn → blocked')
  assert.equal(out.journal.torn, true, 'journal 读数 torn')
  assert.deepEqual(out.pending, ['a'], '一切步归未完成')
  assert.equal(driver.calls.length, 0, '零 driver 调用')
  assert.equal(runEvents.length, 0, '零 run 广播')
  assert.equal(storage.read(), '{"runId": "run-t5", "ste', '撕裂字节原样保留')
  ok('T3.5 torn 预检：blocked + 零调用零广播 + 字节保留')
}
{
  // 6b. failWrite=before：首个播种写即败 → 劣化，盘上空。
  const { p, driver, storage, runEvents } = rig({
    runId: 'run-t6',
    steps: [step('a')],
    scenarios: [sc('a', [{ status: 'done', text: 'x' }])],
    journalFault: { failWrite: 'before' },
    now: manualClock(71_000),
  })
  const out = await settle(p)
  assert.deepEqual([out.status, out.reason], ['blocked', 'journal-not-ok'], 'failWrite before → blocked')
  assert.equal(out.journal.degraded, true, 'journal 劣化')
  assert.equal(driver.calls.length, 0, '零 driver 调用')
  assert.equal(runEvents.length, 0, '零 run 广播')
  assert.equal(storage.read(), null, '盘上未落一字')
  ok('T3.5 failWrite=before：劣化即停 + 盘上不动')
}
{
  // 6c. failWrite=after：播种「盘上成功」但调用方 not-ok → 就地停机（不推进不广播）。
  const { p, driver, storage, runEvents, journalEvents } = rig({
    runId: 'run-t7',
    steps: [step('a'), step('b')],
    scenarios: [sc('a', [{ status: 'done' }]), sc('b', [{ status: 'done' }])],
    journalFault: { failWrite: 'after' },
    now: manualClock(72_000),
  })
  const out = await settle(p)
  assert.deepEqual([out.status, out.reason], ['blocked', 'journal-not-ok'], 'failWrite after → blocked')
  assert.equal(driver.calls.length, 0, '零 create（先落盘再动作守恒）')
  assert.equal(runEvents.length, 0, '零 run 广播')
  const disk = JSON.parse(storage.read())
  assert.deepEqual(Object.keys(disk.steps), ['a'], '盘上只有第一个种子（写盘成功后才报失败）')
  assert.equal(disk.steps.a.state, 'declared', '种子已在盘上（恢复以盘为准）')
  assert.equal(journalEvents.length, 0, 'journal 不为失败操作广播')
  ok('T3.5 failWrite=after：调用方 not-ok 即停，盘上种子以新 createJournal 重读即得')
}
{
  // 6d. mid-run 真实写抛错（第 3 次写 = 首个 dispatching）：create 一次都不发生。
  const bus = makeEvents()
  const { p, driver, storage, runEvents, journalEvents } = rig({
    runId: 'run-t8',
    steps: [step('a'), step('b')],
    scenarios: [sc('a', [{ status: 'done' }]), sc('b', [{ status: 'done' }])],
    storage: flakyStorage(3),
    now: manualClock(73_000),
    events: bus.events,
  })
  const out = await settle(p)
  assert.deepEqual([out.status, out.reason], ['blocked', 'journal-not-ok'], '真实写抛错 → blocked')
  assert.ok(out.journal.degraded, 'journal 劣化')
  assert.equal(driver.calls.length, 0, 'dispatching 落盘失败 → driver.create 零调用（先落盘再动作）')
  assert.equal(runEvents.length, 0, '零 run 广播')
  assert.deepEqual(journalEvents.length, 2, 'journal 只为两个成功种子广播（失败后停）')
  const disk = JSON.parse(storage.read())
  assert.deepEqual(Object.keys(disk.steps).sort(), ['a', 'b'], '两个种子在盘上')
  assert.ok(Object.values(disk.steps).every((s) => s.state === 'declared'), '盘上无 dispatching（推进未发生）')
  ok('T3.5 mid-run 写抛错（create 前）：零 create、不推进、两级广播都收敛')
}
{
  // 6e. mid-run 真实写抛错（第 3 次写 = markEngineSession）：会话已建但 journal 停在 dispatching，不轮询不广播。
  const bus = makeEvents()
  const { p, driver, storage, runEvents } = rig({
    runId: 'run-t9',
    steps: [step('a')],
    scenarios: [sc('a', [{ status: 'done', text: 'x' }])],
    storage: flakyStorage(3),
    now: manualClock(74_000),
    events: bus.events,
  })
  const out = await settle(p)
  assert.deepEqual([out.status, out.reason], ['blocked', 'journal-not-ok'], 'mark 写失败 → blocked')
  assert.deepEqual(driver.calls.filter((c) => c.op === 'create').length, 1, 'create 已发生（先落盘 dispatching 后）')
  assert.equal(resultCalls(driver), 0, '不轮询（journal 无 running 真相可依）')
  assert.equal(runEvents.length, 0, '零 run 广播')
  const disk = JSON.parse(storage.read())
  assert.equal(disk.steps.a.state, 'dispatching', 'journal 停在 dispatching（孤儿会话归 S6）')
  assert.deepEqual(disk.engineSessions, [], 'engine-owned 未记账（写失败）')
  assert.deepEqual(out.pending, ['a'], '该步归未完成')
  ok('T3.5 mid-run 写抛错（create 后）：不轮询不广播，journal 真相停在 dispatching')
}

// ---- 7. fault.abortAt 崩溃注入缝（S6 resume 的现场）----
console.log('7. abortAt 崩溃缝')
{
  const bus = makeEvents()
  const { p, journal, driver, runEvents } = rig({
    runId: 'run-abort',
    steps: [step('a'), step('b', ['a'])],
    scenarios: [sc('a', [{ status: 'running' }, { status: 'done', text: 'A 完' }])],
    fault: { abortAt: ['b'] },
    now: manualClock(80_000),
    events: bus.events,
  })
  await until(() => journal.getStepState('a')?.state === 'running', 'a 入飞')
  bus.feed(idleEv())
  await until(() => resultCalls(driver) >= 1, 'a 首轮轮询')
  bus.feed(idleEv()) // a done → b 就绪 → abortAt 命中
  await assert.rejects(settle(p), (e) => e.code === ABORT_CODE && e.message.includes('"b"'), 'abortAt 命中抛 E1_ENGINE_ABORT')
  assert.deepEqual([journal.getStepState('a').state, journal.getStepState('b').state], ['done', 'dispatching'], '崩溃现场：a done、b 停在 dispatching')
  assert.equal(journal.getStepState('b').history.at(-1).to, 'dispatching', 'b 的 history 尾条是 dispatching（先记账后崩）')
  assert.deepEqual(createIds(driver), [P('a')], 'b 无 create（崩在 create 前）')
  assert.deepEqual(runEvents.map((e) => e.type), ['dispatch', 'step-done'], '崩溃后无终局广播')
  ok('abortAt：dispatching 落盘后 create 前抛 ABORT_CODE，现场与广播面一致')
}

// ---- 8. 派发异常臂与事件通道异常（手搓 driver / 邪恶事件源）----
console.log('8. 派发异常臂与事件通道异常')
{
  // 8a. driver.create 抛错（场景缺位）→「派发即败」：dispatching→failed，不冒泡假结果。
  const { p, journal, driver, runEvents } = rig({ runId: 'run-dispatch-fail', steps: [step('a')], scenarios: [], now: manualClock(90_000) })
  const out = await settle(p)
  assert.equal(out.status, 'failed', 'create 抛错 → run failed')
  const a = journal.getStepState('a')
  assert.deepEqual([a.state, a.history.at(-1).payload.error.code], ['failed', 'E1_DRIVER_NO_SCENARIO'], '失败 payload 记 driver 错误 code')
  assert.deepEqual(createIds(driver), [P('a')], 'create 被尝试过（calls 记账含抛错）')
  assert.equal(resultCalls(driver), 0, '无会话即无轮询')
  assert.deepEqual(runEvents.map((e) => e.type), ['step-failed', 'run-failed'], '无 dispatch 广播（未到 running）')
  ok('派发即败：create 抛错 → dispatching→failed + payload 记 code')
}
{
  // 8b. create 返回缺 sessionId → E1_ENGINE_BAD_SESSION 收敛。
  const { p, journal } = rig({
    runId: 'run-bad-session',
    steps: [step('a')],
    driver: fakeDriver({ create: async () => ({}) }),
    now: manualClock(91_000),
  })
  const out = await settle(p)
  assert.equal(out.status, 'failed', '缺 sessionId → failed')
  assert.equal(journal.getStepState('a').history.at(-1).payload.error.code, 'E1_ENGINE_BAD_SESSION', 'payload 记 BAD_SESSION')
  ok('坏会话面：create 缺 sessionId → E1_ENGINE_BAD_SESSION 收敛失败')
}
{
  // 8c. cap.acquire 拒绝 →「派发即败」，create 一次不发生。
  const cap = {
    acquire: async () => {
      const e = new Error('限流闸门拒绝')
      e.code = 'E_CAP_REJECTED'
      throw e
    },
  }
  const { p, journal, driver } = rig({ runId: 'run-cap-reject', steps: [step('a')], scenarios: [sc('a', [{ status: 'done' }])], cap, now: manualClock(92_000) })
  const out = await settle(p)
  assert.equal(out.status, 'failed', '帽拒 → failed')
  assert.equal(journal.getStepState('a').history.at(-1).payload.error.code, 'E_CAP_REJECTED', 'payload 记帽错')
  assert.equal(driver.calls.length, 0, 'create 一次不发生（先落盘再动作守恒）')
  ok('帽拒：acquire 抛错 → 派发即败，零 create')
}
{
  // 8d. create 挂死 → dispatching 态也吃超时兜底（不悬挂）。
  const clock = manualClock(93_000)
  const { p, journal } = rig({
    runId: 'run-hang-create',
    steps: [step('a', [], { timeoutMs: 1000 })],
    driver: fakeDriver({ create: () => new Promise(() => {}) }),
    now: clock,
  })
  await until(() => journal.getStepState('a')?.state === 'dispatching', 'a 卡在 dispatching')
  clock.advance(1000)
  await until(() => journal.getStepState('a')?.state === 'failed', 'dispatching 超时兜底触发')
  assert.equal(journal.getStepState('a').history.at(-1).payload.reason, 'timeout', 'payload reason=timeout')
  const out = await settle(p)
  assert.equal(out.status, 'failed', '挂死 create 不拖死 run')
  ok('create 挂死：dispatching 态超时兜底，run 照常终局')
}
{
  // 8e. result 抛错 → running→failed，payload 记错误 code。
  const bus = makeEvents()
  const { p, journal } = rig({
    runId: 'run-result-throw',
    steps: [step('a')],
    driver: fakeDriver({
      result: async () => {
        const e = new Error('引擎掉线')
        e.code = 'E_RESULT_BOOM'
        throw e
      },
    }),
    now: manualClock(94_000),
    events: bus.events,
  })
  await until(() => journal.getStepState('a')?.state === 'running', 'a 入飞')
  bus.feed(idleEv())
  await until(() => journal.getStepState('a')?.state === 'failed', 'result 抛错收敛为 failed')
  assert.equal(journal.getStepState('a').history.at(-1).payload.error.code, 'E_RESULT_BOOM', 'payload 记 code')
  const out = await settle(p)
  assert.equal(out.status, 'failed', 'run failed')
  ok('result 抛错：running→failed，不冒泡假结果')
}
{
  // 8f. result 未知 status → 按失败收敛（宁可失败，不悬挂）。
  const bus = makeEvents()
  const { p, journal } = rig({
    runId: 'run-status-weird',
    steps: [step('a')],
    driver: fakeDriver({ result: async () => ({ status: 'weird' }) }),
    now: manualClock(95_000),
    events: bus.events,
  })
  await until(() => journal.getStepState('a')?.state === 'running', 'a 入飞')
  bus.feed(idleEv())
  await until(() => journal.getStepState('a')?.state === 'failed', '未知 status 收敛失败')
  assert.deepEqual(journal.getStepState('a').history.at(-1).payload.error, { status: 'weird', errorPart: undefined }, 'payload 保留未知 status 原样')
  const out = await settle(p)
  assert.equal(out.status, 'failed', 'run failed')
  ok('未知 status：按失败收敛，原样进 payload')
}
{
  // 8g. onEvent 回调抛错 → 不回滚、不改变调用结果（journal 先落盘再广播同款）。
  const bus = makeEvents()
  const clock = manualClock(96_000)
  const journal = createJournal({ storage: memStorage(), runId: 'run-emit-boom', now: clock })
  const driver = createDriver('mock', { scenarios: [sc('a', [{ status: 'done', text: '好' }])], now: clock })
  const p = run({ runId: 'run-emit-boom', steps: [step('a')] }, {
    journal, driver, now: clock, events: bus.events,
    onEvent: () => {
      throw new Error('面板炸了')
    },
  })
  await until(() => driver.calls.length >= 1, 'a 派发')
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'completed', '广播抛错不影响 run 结果')
  assert.equal(journal.getStepState('a').state, 'done', 'journal 真相照常推进')
  ok('onEvent 抛错：只吞掉，不回滚')
}
{
  // 8h. 事件源正常耗尽（AsyncGenerator yield 完）→ events-end 关通道，已到终态即收尾。
  const gen = async function* () {
    yield idleEv()
    yield idleEv()
  }
  const { p, journal, driver } = rig({
    runId: 'run-events-end',
    steps: [step('a')],
    scenarios: [sc('a', [{ status: 'running' }, { status: 'done', text: '好' }])],
    now: manualClock(97_000),
    events: gen(),
  })
  const out = await settle(p)
  assert.equal(out.status, 'completed', '事件源耗尽后正常终局')
  assert.equal(journal.getStepState('a').state, 'done', '两轮轮询完成（yield 两条后 done）')
  assert.equal(resultCalls(driver), 2, '轮询恰两次')
  ok('events-end：AsyncGenerator 耗尽 → 干净收尾')
}
{
  // 8i. 事件源抛错 → 只丢事件通道，超时兜底照走（§9：事件丢了超时也要触发）。
  const clock = manualClock(98_000)
  const evil = { [Symbol.asyncIterator]: () => ({ next: async () => { throw new Error('流炸了') } }) }
  const { p, journal } = rig({
    runId: 'run-events-err',
    steps: [step('a', [], { timeoutMs: 1000 })],
    scenarios: [sc('a', [{ status: 'running' }])],
    now: clock,
    events: evil,
  })
  await until(() => journal.getStepState('a')?.state === 'running', 'a 入飞')
  clock.advance(1000)
  await until(() => journal.getStepState('a')?.state === 'failed', '事件源炸后超时兜底仍触发')
  assert.equal(journal.getStepState('a').history.at(-1).payload.reason, 'timeout', '兜底判定用注入时钟')
  const out = await settle(p)
  assert.equal(out.status, 'failed', 'run failed')
  ok('events-error：事件通道异常不致命，兜底独立推进')
}

// ---- 9. P1.2 schema 校验（done 分支 move 前接线；合法/越界/类型错/第 2 次成功）----
console.log('9. P1.2 schema 校验')
{
  // 9a. 合法产出：一次 done，零重派，零 retryPending。
  const schemaA = { type: 'object', required: ['verdict'], properties: { verdict: { type: 'integer' } }, additionalProperties: false }
  const bus = makeEvents()
  const clock = manualClock(110_000)
  const { p, journal, driver } = rig({
    runId: 'run-schema-ok',
    steps: [step('a', [], { schema: schemaA })],
    scenarios: [sc('a', [{ status: 'done', text: '{"verdict":1}' }])],
    now: clock,
    events: bus.events,
  })
  await until(() => createIds(driver).length >= 1, 'a 派发')
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'completed', 'schema 合法 → completed')
  assert.equal(createIds(driver).length, 1, '恰 1 次 create（零重派）')
  assert.deepEqual([out.steps.a.state, out.steps.a.attempts, out.steps.a.retryPending], ['done', 1, undefined], 'done 且无重试挂起痕迹')
  assert.equal(journal.getStepState('a').history.filter((e) => e.to === 'failed').length, 0, '无 failed 迁移')
  ok('P1.2 schema 合法：done 一次过，零重派零挂起')
}
{
  // 9b. 越界 → 可重试失败（payload=ask errors 形状）→ retryPrompt 附言重派 → 第 2 次成功 → done 且下游正常派发。
  const schemaB = { type: 'object', required: ['verdict'], properties: { verdict: { type: 'integer' } }, additionalProperties: false }
  const badText = '{"verdict":"no"}'
  const errors = validateValue(JSON.parse(badText), schemaB, '产出').errors
  const retryPrompt2 = retryPrompt(P('a'), errors, { attempt: 2, maxAttempts: 3 })
  const bus = makeEvents()
  const clock = manualClock(111_000)
  const { p, journal, driver, runEvents } = rig({
    runId: 'run-schema-retry',
    steps: [step('a', [], { schema: schemaB }), step('b', ['a'])],
    scenarios: [sc('a', [{ status: 'done', text: badText }]), { name: 'a-retry', match: { prompt: retryPrompt2 }, result: [{ status: 'done', text: '{"verdict":7}' }] }, sc('b', [{ status: 'done', text: 'B 完' }])],
    now: clock,
    retry: { cooldownMs: 100 },
    events: bus.events,
  })
  await until(() => createIds(driver).length >= 1, 'a 派发')
  bus.feed(idleEv()) // 首轮 poll：schema 不过 → running→failed + pendingRetry（cooldown 挂起）
  await until(() => journal.getStepState('a')?.history.some((e) => e.to === 'failed'), 'a 校验失败进 failed')
  const failedMove = journal.getStepState('a').history.find((e) => e.from === 'running' && e.to === 'failed')
  assert.deepEqual(
    failedMove.payload,
    { reason: 'schema-invalid', errors, attempt: 1, retryNote: 'cooldown 挂起：第 2/3 次尝试将在固定 cooldown 100ms 后重派' },
    'schema 失败 payload = ask errors 形状 + attempt + retryNote',
  )
  clock.advance(100) // cooldown 到期
  bus.feed(idleEv())
  await until(() => createIds(driver).length >= 2, 'cooldown 到期重派')
  assert.equal(createIds(driver)[1], retryPrompt2, '重派 prompt = 原 prompt + retryPrompt 错误附言（F6 同款）')
  bus.feed(idleEv()) // 重派轮询：schema 过 → done
  await until(() => journal.getStepState('a')?.state === 'done', '第 2 次尝试 done')
  assert.equal(journal.getStepState('a').attempts, 2, 'attempts=2（含重派，journal 既有计数）')
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'completed', '重试成功 → run completed')
  assert.deepEqual([out.completed, out.failed], [['a', 'b'], []], '第 2 次成功 → done 且下游 b 正常派发')
  assert.deepEqual(createIds(driver).slice(2), [P('b')], '下游在 a done 后派发')
  assert.ok(runEvents.some((e) => e.type === 'step-failed' && e.stepId === 'a'), '挂起失败也广播 step-failed（先落盘再广播）')
  ok('P1.2 schema 越界：payload=ask errors 形状 → cooldown 后 retryPrompt 重派 → 第 2 次成功 done + 下游派发 + attempts=2')
}
{
  // 9c. 耗尽：maxAttempts=2 两次越界 → 第 2 次（末次重派带 nudge）failed 记「尝试已耗尽」→ run failed。
  const schemaC = { type: 'object', required: ['verdict'], properties: { verdict: { type: 'integer' } } }
  const badText = '{"verdict":"x"}'
  const errors = validateValue(JSON.parse(badText), schemaC, '产出').errors
  const retryPrompt2 = retryPrompt(P('a'), errors, { attempt: 2, maxAttempts: 2 }) // 末次重派 → 带 nudge
  const bus = makeEvents()
  const clock = manualClock(112_000)
  const { p, journal, driver } = rig({
    runId: 'run-schema-exhaust',
    steps: [step('a', [], { schema: schemaC, maxAttempts: 2 })],
    scenarios: [sc('a', [{ status: 'done', text: badText }]), { name: 'a-retry', match: { prompt: retryPrompt2 }, result: [{ status: 'done', text: badText }] }],
    now: clock,
    retry: { cooldownMs: 100 },
    events: bus.events,
  })
  await until(() => createIds(driver).length >= 1, 'a 派发')
  bus.feed(idleEv())
  await until(() => journal.getStepState('a')?.state === 'failed', '首次校验失败')
  clock.advance(100)
  bus.feed(idleEv())
  await until(() => createIds(driver).length >= 2, '重派（末次，prompt 带 nudge）')
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'failed', '耗尽 → run failed（未触熔断：仅 1 计）')
  const exhaustedMove = journal.getStepState('a').history.filter((e) => e.to === 'failed').at(-1)
  assert.deepEqual(
    exhaustedMove.payload,
    { reason: 'schema-invalid', errors, attempt: 2, retryNote: '尝试已耗尽（2/2），不再重派' },
    '耗尽 stamp 记「为何不重试」',
  )
  assert.equal(createIds(driver).length, 2, '恰初派 + 1 重派')
  assert.equal(out.steps.a.retryPending, undefined, '耗尽后无 retryPending')
  ok('P1.2 schema 耗尽：末次重派带 nudge → failed 记「尝试已耗尽」→ run failed（未触熔断）')
}

// ---- 10. P1.2 outputs 盘上检查（missing→重派→文件出现→done+下游；耗尽；~/ 展开；非文件；零影响）----
console.log('10. P1.2 outputs 盘上检查')
{
  // 10a. 缺 → cooldown 重派 → 文件落盘 → done + 下游正常派发；payload 带 missing 展开路径。
  const bus = makeEvents()
  const clock = manualClock(120_000)
  const ffs = fakeFs()
  const retryPrompt2 = retryPrompt(P('a'), ['产出文件缺失：/data/out.json'], { attempt: 2, maxAttempts: 3 })
  const { p, journal, driver } = rig({
    runId: 'run-outputs-retry',
    steps: [step('a', [], { outputs: ['/data/out.json'] }), step('b', ['a'])],
    scenarios: [sc('a', [{ status: 'done', text: 'ok' }]), { name: 'a-retry', match: { prompt: retryPrompt2 }, result: [{ status: 'done', text: 'ok-2' }] }, sc('b', [{ status: 'done', text: 'B 完' }])],
    now: clock,
    retry: { cooldownMs: 100 },
    fs: ffs,
    events: bus.events,
  })
  await until(() => createIds(driver).length >= 1, 'a 派发')
  bus.feed(idleEv())
  await until(() => journal.getStepState('a')?.state === 'failed', 'outputs 缺 → failed')
  const failedMove = journal.getStepState('a').history.find((e) => e.from === 'running' && e.to === 'failed')
  assert.deepEqual(
    failedMove.payload,
    { reason: 'outputs-missing', missing: ['/data/out.json'], attempt: 1, retryNote: 'cooldown 挂起：第 2/3 次尝试将在固定 cooldown 100ms 后重派' },
    'outputs 失败 payload = {reason, missing[], attempt, retryNote}',
  )
  clock.advance(100)
  bus.feed(idleEv())
  await until(() => createIds(driver).length >= 2, 'cooldown 到期重派')
  assert.equal(createIds(driver)[1], retryPrompt2, '重派 prompt 附「产出文件缺失」错误清单（F6 同款）')
  ffs.files.add('/data/out.json') // 文件在第 2 次尝试判定前落盘
  bus.feed(idleEv())
  await until(() => journal.getStepState('a')?.state === 'done', '文件在 → 第 2 次 done')
  assert.equal(journal.getStepState('a').attempts, 2, 'attempts=2')
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'completed', 'run completed')
  assert.deepEqual(createIds(driver).slice(2), [P('b')], '下游 b 在 a done 后正常派发')
  assert.equal(out.steps.b.text, 'B 完', '下游照常完成')
  ok('P1.2 outputs：缺→重派（missing 清单附言）→ 文件落盘 → done + 下游派发（m4 report 步场景）')
}
{
  // 10b. 耗尽：maxAttempts=2 一直缺 → failed 记「尝试已耗尽」+ 下游未派先废 superseded。
  const bus = makeEvents()
  const clock = manualClock(121_000)
  const ffs = fakeFs()
  const retryPrompt2 = retryPrompt(P('a'), ['产出文件缺失：/data/out.json'], { attempt: 2, maxAttempts: 2 })
  const { p, journal, driver, storage } = rig({
    runId: 'run-outputs-exhaust',
    steps: [step('a', [], { outputs: ['/data/out.json'], maxAttempts: 2 }), step('b', ['a'])],
    scenarios: [sc('a', [{ status: 'done', text: 'ok' }]), { name: 'a-retry', match: { prompt: retryPrompt2 }, result: [{ status: 'done', text: 'ok' }] }, sc('b', [{ status: 'done', text: 'B 完' }])],
    now: clock,
    retry: { cooldownMs: 100 },
    fs: ffs,
    events: bus.events,
  })
  await until(() => createIds(driver).length >= 1, 'a 派发')
  bus.feed(idleEv())
  await until(() => journal.getStepState('a')?.state === 'failed', '首次缺')
  clock.advance(100)
  bus.feed(idleEv())
  await until(() => createIds(driver).length >= 2, '重派')
  bus.feed(idleEv())
  await until(() => journal.getStepState('b')?.state === 'superseded', '耗尽 → 下游未派先废')
  const out = await settle(p)
  assert.equal(out.status, 'failed', '耗尽 → run failed')
  const exhaustedMove = journal.getStepState('a').history.filter((e) => e.to === 'failed').at(-1)
  assert.deepEqual(
    exhaustedMove.payload,
    { reason: 'outputs-missing', missing: ['/data/out.json'], attempt: 2, retryNote: '尝试已耗尽（2/2），不再重派' },
    '耗尽 stamp 记「为何不重试」+ missing 路径保留',
  )
  assert.deepEqual([out.failed, out.superseded], [['a'], ['b']], 'b superseded（payload via a）')
  assert.equal(journal.getStepState('b').history.at(-1).payload.via, 'a', '废源 = a')
  assert.ok(!journalEventTypes(storage).includes('run-blocked'), '单步耗尽未触熔断')
  ok('P1.2 outputs 耗尽：failed 带 missing + 「尝试已耗尽」→ 下游未派先废')
}
{
  // 10c. ~/ 展开：引擎以注入 homedir 展开（其余字面），missing 记展开后路径。
  const bus = makeEvents()
  const clock = manualClock(122_000)
  const ffs = fakeFs({ home: '/home/user' })
  const { p, journal, driver } = rig({
    runId: 'run-outputs-home',
    steps: [step('h', [], { outputs: ['~/reports/x.json'], maxAttempts: 1 })],
    scenarios: [sc('h', [{ status: 'done', text: 'ok' }])],
    now: clock,
    fs: ffs,
    events: bus.events,
  })
  await until(() => createIds(driver).length >= 1, 'h 派发')
  bus.feed(idleEv())
  await until(() => journal.getStepState('h')?.state === 'failed', '~/ 缺 → failed')
  const payload = journal.getStepState('h').history.find((e) => e.to === 'failed').payload
  assert.deepEqual(payload.missing, ['/home/user/reports/x.json'], 'missing 记 ~/ 展开后的绝对路径')
  assert.deepEqual(ffs.calls.existsSync, ['/home/user/reports/x.json'], 'fs 检查用展开路径')
  const out = await settle(p)
  assert.equal(out.status, 'failed', 'maxAttempts=1：耗尽即 failed（零重派）')
  assert.equal(createIds(driver).length, 1, '恰 1 次 create')
  ok('P1.2 outputs ~/：注入 homedir 展开（/home/user/reports/x.json）+ maxAttempts=1 零重派')
}
{
  // 10d. 存在但非文件（目录）→ 同判缺（必须 isFile）。
  const bus = makeEvents()
  const clock = manualClock(123_000)
  const ffs = fakeFs({ dirs: ['/data'] })
  const { p, journal, driver } = rig({
    runId: 'run-outputs-dir',
    steps: [step('d', [], { outputs: ['/data'], maxAttempts: 1 })],
    scenarios: [sc('d', [{ status: 'done', text: 'ok' }])],
    now: clock,
    fs: ffs,
    events: bus.events,
  })
  await until(() => createIds(driver).length >= 1, 'd 派发')
  bus.feed(idleEv())
  await until(() => journal.getStepState('d')?.state === 'failed', '目录 → failed')
  assert.deepEqual(journal.getStepState('d').history.find((e) => e.to === 'failed').payload.missing, ['/data'], '目录记入 missing')
  await settle(p)
  ok('P1.2 outputs 非文件：existsSync 真 + isFile 假 → 同判缺')
}
{
  // 10e. 无字段无 schema → 零影响：fs 面零调用，普通完成；schema-only 步同样零 fs 调用。
  const bus = makeEvents()
  const clock = manualClock(124_000)
  const ffs = fakeFs()
  const { p, driver } = rig({
    runId: 'run-zero-impact',
    steps: [step('plain'), step('schemaonly', ['plain'], { schema: { type: 'object' } })],
    scenarios: [sc('plain', [{ status: 'done', text: '纯文本，不是 JSON' }]), sc('schemaonly', [{ status: 'done', text: '{"a":1}' }])],
    now: clock,
    fs: ffs,
    events: bus.events,
  })
  await until(() => createIds(driver).length >= 1, 'plain 派发')
  bus.feed(idleEv()) // plain done → schemaonly 就绪派发
  await until(() => createIds(driver).length >= 2, 'schemaonly 补位派发')
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'completed', '无 outputs 无 schema → 零影响完成')
  assert.deepEqual(ffs.calls.existsSync, [], 'fs 面零调用（校验路径零接触）')
  assert.equal(ffs.calls.homedir, 0, 'homedir 零调用')
  assert.deepEqual(createIds(driver), [P('plain'), P('schemaonly')], '普通拓扑照旧')
  ok('P1.2 零影响：无字段无 schema → fs 面零调用、普通完成；schema-only 亦零 fs 调用')
}

// ---- 11. P1.2 重试语义与熔断交互（第 3 条：耗尽先于熔断；pendingRetry 不计；结构性/timeout 不进环）----
console.log('11. P1.2 重试语义与熔断交互')
{
  // 11a. pendingRetry 不计入 consecutiveFailures：两步 driver 级失败（计 2）+ 一次校验失败（挂起不计）
  //      → 重试成功清零 → run failed（非 blocked）且无 run-blocked 事件。
  const bus = makeEvents()
  const clock = manualClock(130_000)
  const ffs = fakeFs()
  const retryPrompt2 = retryPrompt(P('r'), ['产出文件缺失：/r/out.json'], { attempt: 2, maxAttempts: 3 })
  const { p, journal, driver, storage } = rig({
    runId: 'run-retry-count',
    steps: [step('f1'), step('f2'), step('r', [], { outputs: ['/r/out.json'] })],
    scenarios: [sc('f1', [{ status: 'failed', errorPart: 'x1' }]), sc('f2', [{ status: 'failed', errorPart: 'x2' }]), sc('r', [{ status: 'done', text: 'ok' }]), { name: 'r-retry', match: { prompt: retryPrompt2 }, result: [{ status: 'done', text: 'ok' }] }],
    now: clock,
    retry: { cooldownMs: 100 },
    fs: ffs,
    events: bus.events,
  })
  await until(() => createIds(driver).length >= 3, '三步派发')
  bus.feed(idleEv()) // f1/f2 driver 失败（计 2）；r 校验失败（挂起，不计 → 未触熔断）
  await until(() => journal.getStepState('r')?.state === 'failed', 'r 校验失败挂起')
  clock.advance(100)
  ffs.files.add('/r/out.json')
  bus.feed(idleEv())
  await until(() => createIds(driver).length >= 4, 'r cooldown 到期重派')
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'failed', 'f1/f2 失败 → run failed（若挂起计入则 = 3 连败 → blocked）')
  assert.ok(!journalEventTypes(storage).includes('run-blocked'), '无 run-blocked（pendingRetry 未计入）')
  assert.deepEqual([out.completed, out.failed], [['r'], ['f1', 'f2']], 'r 重试成功 completed；f1/f2 独立 failed')
  assert.equal(journal.getStepState('r').attempts, 2, 'r attempts=2')
  ok('P1.2 计数窄域：pendingRetry 不计入 consecutiveFailures（2 实败 + 1 挂起未触熔断，成功清零）')
}
{
  // 11b. 耗尽触发熔断：f1/f2 实败（计 2）+ r 耗尽那次 failed 计入（第 3）→ run blocked
  //      reason=consecutive-failures，步级 payload 仍为 outputs-missing。
  const bus = makeEvents()
  const clock = manualClock(131_000)
  const ffs = fakeFs()
  const { p, journal, driver, storage } = rig({
    runId: 'run-exhaust-breaker',
    steps: [step('f1'), step('f2'), step('r', [], { outputs: ['/r/out.json'], maxAttempts: 1 })],
    scenarios: [sc('f1', [{ status: 'failed', errorPart: 'x1' }]), sc('f2', [{ status: 'failed', errorPart: 'x2' }]), sc('r', [{ status: 'done', text: 'ok' }])],
    now: clock,
    fs: ffs,
    events: bus.events,
  })
  await until(() => createIds(driver).length >= 3, '三步派发')
  bus.feed(idleEv())
  const out = await settle(p)
  assert.deepEqual([out.status, out.reason], ['blocked', 'consecutive-failures'], '耗尽那次计入 → 3 连败熔断')
  assert.deepEqual(out.blocked, { trigger: 'consecutive-failures', failures: RUN_FAILURE_LIMIT, lastStep: 'r' }, '熔断信息')
  assert.ok(journalEventTypes(storage).includes('run-blocked'), 'journal 记 run-blocked')
  const payload = journal.getStepState('r').history.find((e) => e.to === 'failed').payload
  assert.deepEqual(payload, { reason: 'outputs-missing', missing: ['/r/out.json'], attempt: 1, retryNote: '尝试已耗尽（1/1），不再重派' }, '熔断收口时步级 payload 仍为 outputs-missing')
  assert.equal(out.steps.r.retryPending, undefined, '耗尽无 retryPending')
  ok('P1.2 耗尽先于熔断：耗尽 failed 计入 → blocked(consecutive-failures)，步级 payload 仍 outputs-missing')
}
{
  // 11c. pendingRetry 非空时熔断收口：兄弟三连败触发熔断打断冷却重试 → run blocked(reason) ∧ 挂起步显示 retry-pending。
  const bus = makeEvents()
  const clock = manualClock(132_000)
  const ffs = fakeFs()
  const { p, journal, driver, storage } = rig({
    runId: 'run-breaker-pending',
    steps: [step('r', [], { outputs: ['/r/out.json'] }), step('s1'), step('s2'), step('s3')],
    scenarios: [sc('r', [{ status: 'done', text: 'ok' }]), sc('s1', [{ status: 'failed', errorPart: 'y1' }]), sc('s2', [{ status: 'failed', errorPart: 'y2' }]), sc('s3', [{ status: 'failed', errorPart: 'y3' }])],
    now: clock,
    fs: ffs,
    events: bus.events, // cooldown 缺省 RETRY_COOLDOWN_MS=30s；时钟冻结 → cooldown 永不到期，挂起保持
  })
  await until(() => createIds(driver).length >= 4, '四步派发')
  bus.feed(idleEv()) // 一轮 pollAll：r 挂起（不计）+ s1/s2/s3 三连败 → 熔断
  const out = await settle(p)
  assert.deepEqual([out.status, out.reason], ['blocked', 'consecutive-failures'], '熔断收口（打断冷却重试）')
  assert.equal(createIds(driver).filter((x) => x === P('r')).length, 1, 'r 恰 1 次 create（cooldown 重派被熔断打断）')
  assert.equal(out.steps.r.attempts, 1, 'r 无第二次尝试')
  assert.equal(out.steps.r.retryPending, `failed(retry-pending, attempt 1/3, cooldown 剩 ${RETRY_COOLDOWN_MS / 1000}s)`, '挂起步显示 failed(retry-pending, attempt N/M, cooldown 剩 Xs)（默认 cooldown 取导出常量，不复制数字）')
  const tailPayload = journal.getStepState('r').history.find((e) => e.to === 'failed').payload
  assert.ok(tailPayload.retryNote.includes('cooldown 挂起'), 'journal 侧 stamp 记 cooldown 挂起')
  assert.equal(journal.getStepState('r').state, 'failed', 'journal 态仍 failed（挂起是调度器视角的非终态）')
  assert.ok(journalEventTypes(storage).includes('run-blocked'), 'journal 记 run-blocked')
  assert.ok(RETRYABLE_REASONS.includes('outputs-missing') && RETRYABLE_REASONS.includes('schema-invalid'), '可重试分类表恰两类（导出常量核对）')
  ok('P1.2 熔断打断冷却重试：blocked(consecutive-failures) ∧ 挂起步显示 retry-pending（attempt 1/3, 剩 30s）')
}
{
  // 11d. 结构性错误不进重试环（四臂，全部带 outputs 声明——若误入重试环会有第二次 create）：
  //      create 抛错 / create 缺 sessionId / result 抛错 / result status='failed'。
  const arm = async ({ label, driver: d }) => {
    const bus = makeEvents()
    const clock = manualClock(133_000)
    const ffs = fakeFs()
    const { p, journal } = rig({
      runId: `run-structural-${label}`,
      steps: [step('a', [], { outputs: ['/a/out.json'] })],
      driver: d,
      fs: ffs,
      now: clock,
      events: bus.events,
    })
    await until(() => journal.getStepState('a')?.state !== null && journal.getStepState('a')?.state !== 'declared', `${label} 已记账`)
    bus.feed(idleEv()) // 触发首轮 poll（create 抛错臂早在派发期收敛，轮询对它无害）
    const out = await settle(p)
    assert.equal(out.status, 'failed', `${label} → run failed`)
    assert.equal(out.steps.a.attempts, 1, `${label} attempts=1（零重派）`)
    assert.equal(out.steps.a.retryPending, undefined, `${label} 无 retryPending`)
    return out
  }
  // 臂 1：create 抛错（无场景 → E1_DRIVER_NO_SCENARIO）。
  await arm({ label: 'create-throw', driver: createDriver('mock', { scenarios: [], now: manualClock() }) })
  // 臂 2：create 缺非空 sessionId（E1_ENGINE_BAD_SESSION）。
  await arm({ label: 'bad-session', driver: fakeDriver({ create: async () => ({}) }) })
  // 臂 3：result 抛错（running→failed 既有终态路径）。
  await arm({
    label: 'result-throw',
    driver: fakeDriver({
      result: async () => {
        throw new Error('引擎掉线')
      },
    }),
  })
  // 臂 4：result status='failed'（宁可失败，不悬挂——保持既有终态语义）。
  await arm({ label: 'status-failed', driver: fakeDriver({ create: async () => ({ sessionId: 'sess_x' }), result: async () => ({ status: 'failed', errorPart: 'boom' }) }) })
  ok('P1.2 结构性四臂（create 抛/缺 sessionId/result 抛/status failed）：带 outputs 声明也不进重试环（attempts 恒 1）')
}
{
  // 11e. timeout 不进重试环（sweepTimeouts 终态；ask.js F6 同口径）——带 outputs 声明也零重派。
  const clock = manualClock(134_000)
  const ffs = fakeFs()
  const { p, journal, driver } = rig({
    runId: 'run-timeout-no-retry',
    steps: [step('t', [], { outputs: ['/t/out.json'], timeoutMs: 1000 })],
    scenarios: [sc('t', [{ status: 'running' }])],
    now: clock,
    fs: ffs,
    events: silentEvents,
  })
  await until(() => journal.getStepState('t')?.state === 'running', 't 入飞')
  clock.advance(1000)
  await until(() => journal.getStepState('t')?.state === 'failed', '超时兜底触发')
  assert.deepEqual(journal.getStepState('t').history.find((e) => e.to === 'failed').payload, { reason: 'timeout', timeoutMs: 1000, elapsedMs: 1000 }, 'timeout payload 原样（分类表：timeout 不进重试环）')
  const out = await settle(p)
  assert.equal(out.status, 'failed', 'run failed')
  assert.equal(createIds(driver).length, 1, '恰 1 次 create（timeout 后零重派）')
  assert.equal(out.steps.t.attempts, 1, 'attempts=1')
  ok('P1.2 timeout 不进重试环：sweepTimeouts 终态 + 零重派 + payload 原样')
}

// ---- 12. P1.2 cooldown 生效与跳过（判定全走注入时钟）----
console.log('12. P1.2 cooldown 生效与跳过')
{
  const bus = makeEvents()
  const clock = manualClock(140_000)
  const ffs = fakeFs()
  const { p, journal, driver } = rig({
    runId: 'run-cooldown-gate',
    steps: [step('c', [], { outputs: ['/c/out.json'] })],
    scenarios: [sc('c', [{ status: 'done', text: 'ok' }]), { name: 'c-retry', match: { prompt: retryPrompt(P('c'), ['产出文件缺失：/c/out.json'], { attempt: 2, maxAttempts: 3 }) }, result: [{ status: 'done', text: 'ok' }] }],
    now: clock,
    retry: { cooldownMs: 200 },
    fs: ffs,
    events: bus.events,
  })
  await until(() => createIds(driver).length >= 1, 'c 派发')
  bus.feed(idleEv())
  await until(() => journal.getStepState('c')?.state === 'failed', '首次缺（failedAt 记账）')
  clock.advance(199) // cooldown 未到
  bus.feed(idleEv())
  await tick()
  await tick()
  await tick()
  assert.equal(createIds(driver).length, 1, 'cooldown 未到 → 跳过本轮（注入时钟判定）')
  clock.advance(1) // 恰满 200ms
  bus.feed(idleEv())
  await until(() => createIds(driver).length >= 2, 'cooldown 到期 → 重派')
  const dispatches = journal.getStepState('c').history.filter((e) => e.to === 'dispatching')
  assert.equal(dispatches.length, 2, '初派 + cooldown 重派（failed→dispatching 唯一重入边）')
  assert.equal(journal.getStepState('c').lastDispatchAt, dispatches[1].at, '重派窗口随 lastDispatchAt 重开（P1.2 第 4 条，P4-E 恢复派发同款记账）')
  ffs.files.add('/c/out.json')
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'completed', '重试成功完成')
  ok('P1.2 cooldown 生效与跳过：199ms 跳过 / 200ms 重派（固定间隔、注入时钟判定、零新定时器）')
}

// ---- 13. P1.2 叶子步 cooldown 期 run 不收口（其余全终态也不收）----
console.log('13. P1.2 叶子步 cooldown 期不收口')
{
  const bus = makeEvents()
  const clock = manualClock(150_000)
  const ffs = fakeFs()
  const retryPrompt2 = retryPrompt(P('leaf'), ['产出文件缺失：/leaf/r.json'], { attempt: 2, maxAttempts: 3 })
  const { p, journal, driver } = rig({
    runId: 'run-leaf-hold',
    steps: [step('u'), step('leaf', ['u'], { outputs: ['/leaf/r.json'] })],
    scenarios: [sc('u', [{ status: 'running' }, { status: 'done', text: 'U 完' }]), sc('leaf', [{ status: 'done', text: 'L1' }]), { name: 'leaf-retry', match: { prompt: retryPrompt2 }, result: [{ status: 'done', text: 'L2' }] } ],
    now: clock,
    retry: { cooldownMs: 200 },
    fs: ffs,
    events: bus.events,
  })
  let resolved = false
  void p.then(() => {
    resolved = true
  })
  await until(() => createIds(driver).length >= 1, 'u 派发')
  bus.feed(idleEv()) // u 首轮 poll（running）
  bus.feed(idleEv()) // u 二轮 poll done → leaf 就绪派发（同一唤醒内 dispatchReady）
  await until(() => createIds(driver).length >= 2, 'leaf 补位派发')
  bus.feed(idleEv()) // leaf done 产出但文件缺 → 挂起（pendingRetry）
  await until(() => journal.getStepState('leaf')?.state === 'failed', 'leaf 校验失败挂起')
  clock.advance(50) // cooldown 未到：其余全终态（u done）也不许收口
  bus.feed(idleEv())
  for (let i = 0; i < 30; i += 1) await tick()
  assert.equal(resolved, false, '叶子步 cooldown 期：其余全终态 ∧ pendingRetry 非空 → run 不收口')
  ffs.files.add('/leaf/r.json')
  clock.advance(150) // 恰满 cooldown
  bus.feed(idleEv())
  await until(() => createIds(driver).length >= 3, 'cooldown 到期重派 leaf')
  bus.feed(idleEv())
  await until(() => journal.getStepState('leaf')?.state === 'done', '重试成功 done')
  const out = await settle(p)
  assert.equal(out.status, 'completed', '重试耗尽前不收口、成功后正确收口')
  assert.deepEqual([out.completed, out.failed], [['u', 'leaf'], []], '全步 done')
  assert.deepEqual([out.steps.leaf.attempts, out.steps.leaf.text, out.steps.leaf.retryPending], [2, 'L2', undefined], 'leaf attempts=2、text 取第 2 次、挂起痕迹清除')
  ok('P1.2 叶子步 cooldown 期不收口：挂起期 resolved=false → 重试成功后 completed（m4 report 步场景防回归）')
}

// ---- 14. P1.2 旧 journal record（无 version 字段）可读（调度器续跑面）----
console.log('14. 旧 journal record 兼容')
{
  const storage = memStorage()
  const legacyClock = manualClock(160_000)
  const j0 = createJournal({ storage, runId: 'run-legacy', now: legacyClock })
  for (const [from, to, payload] of [[null, 'declared'], ['declared', 'dispatching'], ['dispatching', 'running', { sessionId: 'sess_w' }], ['running', 'done', { sessionId: 'sess_w', result: { text: '旧文' } }]]) {
    assert.equal(j0.appendStepState('w', from, to, payload).ok, true, `播种 ${from}→${to}`)
  }
  const rec = JSON.parse(storage.read())
  assert.equal(rec.version, 1, '新写 record 带版本')
  delete rec.version // 退化成旧形状
  storage.write(JSON.stringify(rec))
  const warns = []
  const origWarn = console.warn
  console.warn = (m) => warns.push(String(m))
  let out
  try {
    out = await run({ runId: 'run-legacy', steps: [step('w')] }, {
      journal: createJournal({ storage, runId: 'run-legacy', now: manualClock(7_000) }),
      driver: createDriver('mock', { scenarios: [], now: manualClock() }),
      now: manualClock(7_000),
    })
  } finally {
    console.warn = origWarn
  }
  assert.equal(out.status, 'completed', '旧 record（无版本字段）→ done 步续跑平凡完成')
  assert.deepEqual([out.steps.w.state, out.steps.w.attempts, out.steps.w.sessionId, out.steps.w.text], ['done', 1, 'sess_w', '旧文'], '盘上 payload 回收不受版本字段影响')
  assert.ok(warns.some((m) => m.includes('version')), '装载记了兼容 warn（warn 只发不阻塞）')
  ok('P1.2 旧 record 无版本字段：调度器续跑可读（done 零 driver 调用）+ 兼容 warn')
}

// ---- 15. P1.2 参数面（retry/fs TypeError 分轨）+ escalation×schema 判定序 ----
console.log('15. P1.2 参数面与判定序')
{
  const J = () => createJournal({ storage: memStorage(), runId: 'run-p', now: manualClock() })
  const D = (scenarios = []) => createDriver('mock', { scenarios, now: manualClock() })
  const good = { runId: 'run-p', steps: [step('a')] }
  await assert.rejects(run(good, { journal: J(), driver: D(), retry: 'x' }), TypeError, 'retry 非对象应拒')
  await assert.rejects(run(good, { journal: J(), driver: D(), retry: { cooldownMs: -1 } }), TypeError, 'cooldownMs 负数应拒')
  await assert.rejects(run(good, { journal: J(), driver: D(), retry: { cooldownMs: 1.5 } }), TypeError, 'cooldownMs 非整数应拒')
  await assert.rejects(run(good, { journal: J(), driver: D(), fs: {} }), TypeError, 'fs 缺面应拒')
  await assert.rejects(run(good, { journal: J(), driver: D(), fs: { existsSync: 1, statSync: () => {}, homedir: () => '' } }), TypeError, 'fs 面非函数应拒')
  // 合法边：retry null / cooldownMs 0 / fs null（缺省面）都收。
  const bus = makeEvents()
  bus.feed(idleEv()) // 预入队：run 派发 a 后首次 park 即消费（无事件则永不 poll，run 不终局）
  const out0 = await run(good, { journal: J(), driver: D([sc('a', [{ status: 'done', text: '好' }])]), retry: { cooldownMs: 0 }, fs: null, now: manualClock(), events: bus.events })
  assert.equal(out0.status, 'completed', 'cooldownMs=0 + fs=null（缺省面）合法')
  // escalation×schema 判定序：问句产出是挂起不是坏产出——escalation 在前，不过 schema、不进重试环。
  bus.feed(idleEv())
  const escalateSeen = []
  const outE = await run(
    { runId: 'run-esc-schema', steps: [step('q', [], { schema: { type: 'object', required: ['answer'] } })] },
    {
      journal: J(),
      driver: D([sc('q', [{ status: 'done', text: '{"question":"继续吗?"}' }])]),
      escalation: { onEscalate: (r) => escalateSeen.push(r.stepId) },
      now: manualClock(),
      events: bus.events,
    },
  )
  assert.equal(outE.reason, 'escalation-pending', '问句产出 → escalation 挂起（notify-only 终局）')
  assert.deepEqual(escalateSeen, ['q'], 'onEscalate 恰一次')
  assert.equal(outE.steps.q.state, 'blocked', '步 blocked（非 schema-invalid 重试环）')
  assert.equal(outE.steps.q.retryPending, undefined, '无重试挂起痕迹')
  ok('P1.2 参数面：retry/fs 五路 TypeError + cooldownMs=0/fs=null 合法边 + escalation 在 schema 前不过校验')
}

console.log(`\n引擎调度器测试（S4 门：T3.2 + T3.2b + T3.5 scheduler 侧）：${passed} 项全过`)
