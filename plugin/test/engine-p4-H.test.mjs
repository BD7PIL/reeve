// E1 引擎 P4-H hole 测试（T4.2 门；蓝图 unified-run-plan-p0-p5.md §P4「hole 在飞不动/差量正确」，
// T4.2 断言「在飞步 create 不打断、新步序正确」，E1 规格 §3/§6）。
//
// 覆盖矩阵：
//   T4.2 主线  运行中交新声明（hole.pull 拉取）：在飞步 b 的 create 不打断（恰 1 次 create、
//             原 sessionId、旧脚本产出）；未开始步差量替换——dropped（c→superseded
//             reason=hole-drop，零 create）、added（d 播种 declared，b done 后按拓扑派发）、
//             carried（已 done 的 a 不在新计划也照旧带在活跃计划，报表不丢账）；
//             journal 记 hole 审计（五类清单）、run 广播 hole、result.hole 回流摘要。
//   新步序    新声明把 x(deps y) 列在 y 前面：派发仍按拓扑序 y→x（声明序只做就绪平手裁决）。
//   changed   同 stepId 异 prompt+deps → 派发取新内容；journal 不重播种（declared 历史 1 条）。
//   pinned    running 步被新计划点名且内容不同 → 旧身冻结跑完、新内容零 create；新步可依赖
//             pinned 步（b done 后才派）。
//   叠加交接  两次交接（不同对象）先后应用：第二次差量建立在工作计划现状上（kept [d]）；
//             result.hole = 最近一次。
//   引用去重  pull 恒回同一对象 → 恰应用一次（防重复播种把 run 打成 halted 的回归锚）。
//   非法交接  未知 deps 引用 / runId 不同 run / 非声明垃圾 → TypeError fail-fast（run promise
//           拒绝），且零 journal 审计（校验先于一切写）。
//   拉取源    pull 抛错本轮吞掉，run 照常完成（零 hole 事件）。
//   纯函数面  classifyHole 五类 + carried + merged（pinned 含 claimed 与 superseded 不复活）。
//
// 夹具全合成（mock driver 脚本化 + 可控时钟 + 可喂事件总线）；replay 录制件属 S7a，本文件
// 不引用 fixtures/engine/replay/（不创建、不读取）。
//
// 运行：node plugin/test/engine-p4-H.test.mjs（assert 失败即抛、非零退出；成功自然退出）
import assert from 'node:assert/strict'

import { createJournal } from '../src/engine/journal.js'
import { createDriver } from '../src/engine/driver.js'
import { classifyHole } from '../src/engine/hole.js'
import { run } from '../src/engine/scheduler.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- 夹具基座（全合成；与 engine-scheduler/engine-p4-E 同一套 idiom）----
const memStorage = () => {
  let text = null
  return { read: () => text, write: (t) => (text = t) }
}
const manualClock = (start = 10_000) => {
  let t = start
  const now = () => t
  now.advance = (ms) => {
    t += ms
    return t
  }
  return now
}
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
const sc = (id, result, extra = {}) => {
  const byPrompt = typeof id !== 'string' // 传 {prompt} 对象 = 按 prompt 字面匹配（如修订稿）
  return { name: byPrompt ? `prompt:${id.prompt}` : id, match: { prompt: byPrompt ? id.prompt : P(id) }, result, ...extra }
}

/** 一套测试装具：journal + mock driver + run() 同时起跑；hole.pull 由 stage 变量驱动。 */
const rig = ({ runId, steps, scenarios = [], now = manualClock(), hole, events }) => {
  const runEvents = []
  const storage = memStorage()
  const journal = createJournal({ storage, runId, now })
  const driver = createDriver('mock', { scenarios, now })
  const p = run({ runId, steps }, { journal, driver, hole, events, now, onEvent: (e) => runEvents.push(e) })
  return { p, journal, driver, storage, runEvents, now }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const until = async (f, label, tries = 2000) => {
  for (let i = 0; i < tries && !f(); i += 1) await tick()
  assert.ok(f(), `等待超时：${label}`)
}
const settle = (p, ms = 8000) => {
  let timer = null
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('run() 未在时限内终局（调度循环悬挂）')), ms)
  })
  return Promise.race([p, watchdog]).finally(() => clearTimeout(timer))
}
const createIds = (driver) => driver.calls.filter((c) => c.op === 'create').map((c) => c.args.prompt)
const journalEventTypes = (storage) => (storage.read() ? JSON.parse(storage.read()).events.map((e) => e.type) : [])
const journalEventsOf = (storage, type) => (storage.read() ? JSON.parse(storage.read()).events.filter((e) => e.type === type) : [])

// ---- 0. 纯函数面：classifyHole 五类 + carried + merged ----
console.log('0. classifyHole 差量分类')
{
  const current = [
    step('a'), // done（不在新计划）→ carried
    step('b', ['a']), // running + 新计划点名（同字节）→ pinned
    step('c', ['b']), // declared 同字节 → kept
    step('d', ['b']), // declared 异字节（新计划改 prompt+deps）→ changed
    step('e', ['b']), // declared 不在新计划 → dropped
    { ...step('f', ['c']), extra: true }, // claimed（未落盘但派发窗口）+ 不在新计划 → carried（视同已开始）
  ]
  const knownMap = { a: 'done', b: 'running', c: 'declared', d: 'declared', e: 'declared', f: 'declared', g: 'superseded' }
  const claimed = new Set(['f'])
  const next = [
    step('b', ['a']), // pinned（started，字节相同也冻结）
    { stepId: 'g', prompt: 'G2', deps: [] }, // pinned（journal superseded：hole 废过的不复活，异字节也一样）
    step('c', ['b']), // kept
    { stepId: 'd', prompt: 'D2', deps: [] }, // changed
    step('h', ['y']), // added
    step('y'), // added
  ]
  const diff = classifyHole({ currentSteps: current, knownOf: (id) => knownMap[id] ?? null, claimed, nextSteps: next })
  assert.deepEqual(diff.kept, ['c'], 'kept：未开始同字节')
  assert.deepEqual(diff.changed, ['d'], 'changed：未开始异字节（deps 变也算）')
  assert.deepEqual(diff.dropped, ['e'], 'dropped：未开始且新计划没有')
  assert.deepEqual(diff.pinned, ['b', 'g'], 'pinned：已开始按新声明序（running + superseded 不复活；claimed 不在此列）')
  assert.deepEqual(diff.added, ['h', 'y'], 'added：journal 未注册的新 id')
  assert.deepEqual(
    diff.merged.map((s) => s.stepId),
    ['b', 'g', 'c', 'd', 'h', 'y', 'a', 'f'],
    'merged = 新声明序在前 + carried（a done、f claimed）按旧序在后',
  )
  const mergedB = diff.merged.find((s) => s.stepId === 'b')
  assert.deepEqual(mergedB, step('b', ['a']), 'pinned 步在 merged 里保持旧身字节（在飞参数不因交接变）')
  const mergedD = diff.merged.find((s) => s.stepId === 'd')
  assert.deepEqual(mergedD, { stepId: 'd', prompt: 'D2', deps: [] }, 'changed 步在 merged 里是新内容')
  ok('classifyHole：五类清单 + carried + merged（旧身冻结/新内容替换/废弃不复活）')
}

// ---- 1. T4.2 主线：在飞步 create 不打断 + 未开始差量替换 ----
console.log('1. T4.2 主线：在飞不动 / 差量替换 / carried 不丢账')
{
  const bus = makeEvents()
  let stage = 0 // 0=未交接；1=交 [b, d(deps b)]（c 废、d 增、a carried）
  // 交接稿自含（deps ⊆ 自身 steps）：b 已在飞 → pinned 冻结旧身，稿里 deps 写 [] 无妨
  const holeDecl = { runId: 'run-p4h-main', steps: [{ stepId: 'b', prompt: P('b'), deps: [] }, step('d', ['b'])] }
  const { p, journal, driver, storage, runEvents } = rig({
    runId: 'run-p4h-main',
    steps: [step('a'), step('b', ['a']), step('c', ['b'])],
    scenarios: [
      sc('a', [{ status: 'done', text: 'A 完' }]),
      sc('b', [{ status: 'running' }, { status: 'done', text: 'B 完（旧脚本）' }]),
      sc('c', [{ status: 'done', text: 'C 不该跑' }]),
      sc('d', [{ status: 'done', text: 'D 完' }]),
    ],
    events: bus.events,
    hole: { pull: () => (stage === 1 ? holeDecl : null) },
  })

  await until(() => createIds(driver).length >= 1, 'a 派发')
  bus.feed(idleEv()) // poll：a done → 同轮 loop-top 派 b（c 依赖 b 未就绪）
  await until(() => createIds(driver).length >= 2, 'a done 后 b 派发（c 仍 declared）')
  assert.deepEqual(createIds(driver), [P('a'), P('b')], 'c 未派（依赖 b 在飞）')
  stage = 1
  bus.feed(idleEv()) // poll：b running；本轮 loop-top applyHole 应用交接
  await until(() => runEvents.some((e) => e.type === 'hole'), '交接应用（hole 广播）')

  // —— 交接落地断言（T4.2 前半：在飞不动 + 差量落盘）——
  assert.equal(journal.getStepState('b').state, 'running', '在飞 b 纹丝不动（running）')
  assert.equal(journal.getStepState('c').state, 'superseded', '未开始且被移除的 c → superseded')
  assert.deepEqual(
    journal.getStepState('c').history.at(-1).payload,
    { reason: 'hole-drop' },
    'c 的废弃 payload 记 reason=hole-drop（台账可辨）',
  )
  assert.equal(journal.getStepState('d').state, 'declared', '新增 d 已播种 declared')
  assert.deepEqual(createIds(driver), [P('a'), P('b')], 'c/d 零 create（差的量还没派）')
  const diskEvents = journalEventsOf(storage, 'hole')
  assert.equal(diskEvents.length, 1, 'journal 恰一条 hole 审计')
  assert.deepEqual(diskEvents[0].payload, { added: ['d'], dropped: ['c'], changed: [], pinned: ['b'], kept: [] }, 'hole 审计五类清单')
  const holeEvent = runEvents.find((e) => e.type === 'hole')
  assert.deepEqual(holeEvent.added, ['d'], 'run 广播 hole 带 added')
  const bSession = driver.calls.find((c) => c.op === 'create' && c.args.prompt === P('b')).sessionId

  // —— 在飞 b 照旧跑完（create 不打断），d 按拓扑补位 ——
  bus.feed(idleEv())
  await until(() => runEvents.some((e) => e.type === 'step-done' && e.stepId === 'b'), '在飞 b 用原会话原脚本跑完')
  bus.feed(idleEv())
  await until(() => createIds(driver).length >= 3, 'b done 后 d 派发（新计划拓扑）')
  bus.feed(idleEv())
  const out = await settle(p)

  assert.equal(out.status, 'completed', '交接后 run completed')
  assert.deepEqual(out.completed, ['b', 'd', 'a'], 'completed = 合并计划序 [b, d] + carried [a]（报表不丢已完成的 a）')
  assert.deepEqual(out.pending, [], '无挂起残留')
  assert.deepEqual(createIds(driver), [P('a'), P('b'), P('d')], 'create 全序恰 3 次：c 零 create（差量废弃）、b 零重派（在飞不动）')
  assert.equal(driver.calls.filter((c) => c.op === 'create' && c.args.prompt === P('b')).length, 1, 'T4.2：在飞 b 的 create 不打断（恰 1 次）')
  assert.equal(out.steps.b.sessionId, bSession, 'b 沿用原 sessionId（会话不换）')
  assert.equal(out.steps.b.text, 'B 完（旧脚本）', 'b 产出来自原脚本（未被新计划干扰）')
  assert.equal(out.steps.d.text, 'D 完', '新增 d 正常产出')
  assert.ok(!('c' in out.steps), '被废弃的 c 不在合并计划快照里（差量后的活跃计划）')
  assert.deepEqual(out.hole, { added: ['d'], dropped: ['c'], changed: [], pinned: ['b'], kept: [], at: out.hole.at }, 'result.hole 回流交接摘要')
  assert.equal(typeof out.hole.at, 'number', 'hole.at 走注入时钟')
  assert.deepEqual(
    runEvents.map((e) => [e.type, e.stepId ?? null]),
    [
      ['dispatch', 'a'],
      ['step-done', 'a'],
      ['dispatch', 'b'],
      ['superseded', 'c'],
      ['hole', null],
      ['step-done', 'b'],
      ['dispatch', 'd'],
      ['step-done', 'd'],
      ['run-completed', null],
    ],
    'run 事件序列：superseded(c) 与 hole 相邻（同轮 loop-top 落盘后广播）、d 在 b done 后才派',
  )
  ok('T4.2：在飞 create 不打断 / c 废 d 增 / carried 不丢账 / hole 台账+广播+回流三线一致')
}

// ---- 2. 新步序正确：声明序 x 在 y 前，派发仍按拓扑 y→x ----
console.log('2. 新步序：拓扑序压过声明序')
{
  const bus = makeEvents()
  let stage = 0
  // x 列在前但依赖 y；y 依赖在飞的 b（b 条目必须入稿才自含——反正 pinned 冻结旧身）
  const holeDecl = { runId: 'run-p4h-order', steps: [step('x', ['y']), step('y', ['b']), { stepId: 'b', prompt: P('b'), deps: [] }] }
  const { p, journal, driver, storage, runEvents } = rig({
    runId: 'run-p4h-order',
    steps: [step('a'), step('b', ['a'])],
    scenarios: [
      sc('a', [{ status: 'done', text: 'A 完' }]),
      sc('b', [{ status: 'running' }, { status: 'done', text: 'B 完' }]),
      sc('x', [{ status: 'done', text: 'X 完' }]),
      sc('y', [{ status: 'done', text: 'Y 完' }]),
    ],
    events: bus.events,
    hole: { pull: () => (stage === 1 ? holeDecl : null) },
  })
  await until(() => createIds(driver).length >= 1, 'a 派发')
  bus.feed(idleEv())
  await until(() => createIds(driver).length >= 2, 'b 派发（在飞）')
  stage = 1
  bus.feed(idleEv())
  await until(() => runEvents.some((e) => e.type === 'hole'), '交接应用')
  assert.deepEqual(journalEventsOf(storage, 'hole').at(-1).payload.added, ['x', 'y'], 'added 按新声明序')
  bus.feed(idleEv()) // poll：b done（原脚本）
  await until(() => runEvents.some((e) => e.type === 'step-done' && e.stepId === 'b'), '在飞 b 跑完')
  bus.feed(idleEv()) // loop-top：dispatchReady——只有 y 就绪（x 依赖 y）
  await until(() => createIds(driver).includes(P('y')), 'y 先派（依赖 b 已 done）')
  assert.ok(!createIds(driver).includes(P('x')), 'x 未派（依赖 y 未 done）——拓扑压过声明序')
  bus.feed(idleEv()) // poll：y done
  await until(() => journal.getStepState('y').state === 'done', 'y 完成')
  bus.feed(idleEv()) // loop-top：x 派发
  await until(() => createIds(driver).includes(P('x')), 'y done 后 x 才派')
  assert.deepEqual(createIds(driver), [P('a'), P('b'), P('y'), P('x')], 'T4.2 新步序：create 全序 [a, b, y, x]（b 在飞不动、y→x 拓扑）')
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'completed', '新计划跑完')
  assert.deepEqual(out.completed, ['x', 'y', 'b', 'a'], 'completed = 合并计划 [x, y, b] + carried [a]')
  ok('新步序正确：y→x 拓扑派发、在飞 b create 不打断（恰 1 次）')
}

// ---- 3. changed：同 id 异内容 → 派发取新内容，journal 不重播种 ----
console.log('3. changed：未开始步换成新内容')
{
  const bus = makeEvents()
  const C2 = '任务 c（修订稿）'
  let stage = 0
  const holeDecl = { runId: 'run-p4h-changed', steps: [{ stepId: 'b', prompt: P('b'), deps: [] }, { stepId: 'c', prompt: C2, deps: ['b'] }] }
  const { p, journal, driver, storage, runEvents } = rig({
    runId: 'run-p4h-changed',
    steps: [step('a'), step('b', ['a']), step('c', ['b'])],
    scenarios: [
      sc('a', [{ status: 'done', text: 'A 完' }]),
      sc('b', [{ status: 'running' }, { status: 'done', text: 'B 完' }]),
      sc('c', [{ status: 'done', text: 'C 旧稿不该跑' }]),
      sc({ prompt: C2 }, [{ status: 'done', text: 'C2 完' }]),
    ],
    events: bus.events,
    hole: { pull: () => (stage === 1 ? holeDecl : null) },
  })
  await until(() => createIds(driver).length >= 1, 'a 派发')
  bus.feed(idleEv())
  await until(() => createIds(driver).length >= 2, 'b 派发（c 仍 declared）')
  stage = 1
  bus.feed(idleEv())
  await until(() => runEvents.some((e) => e.type === 'hole'), '交接应用')
  assert.deepEqual(journalEventsOf(storage, 'hole').at(-1).payload.changed, ['c'], 'audit.changed = [c]')
  assert.equal(journal.getStepState('c').state, 'declared', 'changed 步 journal 态不变（不重播种）')
  assert.equal(journal.getStepState('c').history.length, 1, 'c 的 declared 播种历史恰 1 条（替换是内存换内容，不写台账）')
  bus.feed(idleEv())
  await until(() => runEvents.some((e) => e.type === 'step-done' && e.stepId === 'b'), '在飞 b 跑完')
  bus.feed(idleEv())
  await until(() => createIds(driver).includes(C2), 'c 按新内容派发')
  assert.ok(!createIds(driver).includes(P('c')), '旧 prompt 零 create（换的是内容不是复派）')
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'completed', 'run completed')
  assert.equal(out.steps.c.text, 'C2 完', 'c 产出 = 新内容的脚本')
  assert.deepEqual(
    journal.getStepState('c').history.map((h) => h.to),
    ['declared', 'dispatching', 'running', 'done'],
    'c 的 ledger 链无二次播种（declared 只此一条）',
  )
  ok('changed：派发取新 prompt、journal 无重播种、旧内容零 create')
}

// ---- 4. pinned：running 步被新计划点名且内容不同 → 旧身冻结 ----
console.log('4. pinned：在飞步内容不同也按旧身跑完')
{
  const bus = makeEvents()
  const B2 = '任务 b（新计划里的改稿）'
  let stage = 0
  const holeDecl = { runId: 'run-p4h-pinned', steps: [{ stepId: 'b', prompt: B2, deps: [] }, step('e', ['b'])] }
  const { p, journal, driver, storage, runEvents } = rig({
    runId: 'run-p4h-pinned',
    steps: [step('a'), step('b', ['a'])],
    scenarios: [
      sc('a', [{ status: 'done', text: 'A 完' }]),
      sc('b', [{ status: 'running' }, { status: 'done', text: 'B 旧身跑完' }]),
      sc('e', [{ status: 'done', text: 'E 完' }]),
    ],
    events: bus.events,
    hole: { pull: () => (stage === 1 ? holeDecl : null) },
  })
  await until(() => createIds(driver).length >= 1, 'a 派发')
  bus.feed(idleEv())
  await until(() => createIds(driver).length >= 2, 'b 派发（在飞）')
  stage = 1
  bus.feed(idleEv())
  await until(() => runEvents.some((e) => e.type === 'hole'), '交接应用')
  const audit = journalEventsOf(storage, 'hole').at(-1).payload
  assert.deepEqual(audit.pinned, ['b'], 'audit.pinned = [b]（内容不同也冻结）')
  assert.deepEqual(audit.added, ['e'], 'audit.added = [e]（可依赖 pinned 步）')
  bus.feed(idleEv())
  await until(() => runEvents.some((e) => e.type === 'step-done' && e.stepId === 'b'), '在飞 b 旧身跑完')
  bus.feed(idleEv())
  await until(() => createIds(driver).includes(P('e')), 'e 依赖 pinned b，b done 后才派')
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'completed', 'run completed')
  assert.ok(!createIds(driver).includes(B2), 'T4.2：新内容零 create（在飞步 create 不打断）')
  assert.equal(out.steps.b.text, 'B 旧身跑完', 'b 产出来自旧身脚本')
  assert.deepEqual(out.completed, ['b', 'e', 'a'], 'completed = [b(pinned), e(added)] + carried [a]')
  ok('pinned：异内容在飞步按旧身跑完、新内容零 create、新步依赖 pinned 步成立')
}

// ---- 5. 叠加交接：两次不同对象先后应用 ----
console.log('5. 叠加交接：第二次差量建立在工作计划现状上')
{
  const bus = makeEvents()
  let stage = 0
  const decl1 = { runId: 'run-p4h-twice', steps: [{ stepId: 'b', prompt: P('b'), deps: [] }, step('d', ['b'])] }
  const decl2 = { runId: 'run-p4h-twice', steps: [{ stepId: 'b', prompt: P('b'), deps: [] }, step('d', ['b']), step('e', ['b'])] }
  const { p, journal, driver, storage, runEvents } = rig({
    runId: 'run-p4h-twice',
    steps: [step('a'), step('b', ['a']), step('c', ['b'])],
    scenarios: [
      sc('a', [{ status: 'done', text: 'A 完' }]),
      sc('b', [{ status: 'running' }, { status: 'done', text: 'B 完' }]),
      sc('d', [{ status: 'done', text: 'D 完' }]),
      sc('e', [{ status: 'done', text: 'E 完' }]),
    ],
    events: bus.events,
    hole: { pull: () => (stage === 1 ? decl1 : stage === 2 ? decl2 : null) },
  })
  await until(() => createIds(driver).length >= 1, 'a 派发')
  bus.feed(idleEv())
  await until(() => createIds(driver).length >= 2, 'b 派发')
  stage = 1
  bus.feed(idleEv())
  await until(() => journalEventsOf(storage, 'hole').length === 1, '第一次交接应用')
  const audit1 = journalEventsOf(storage, 'hole')[0].payload
  assert.deepEqual({ ...audit1 }, { added: ['d'], dropped: ['c'], changed: [], pinned: ['b'], kept: [] }, '第一次：加 d 废 c')
  stage = 2
  bus.feed(idleEv())
  await until(() => journalEventsOf(storage, 'hole').length === 2, '第二次交接应用')
  const audit2 = journalEventsOf(storage, 'hole')[1].payload
  assert.deepEqual({ ...audit2 }, { added: ['e'], dropped: [], changed: [], pinned: ['b'], kept: ['d'] }, '第二次：d 同字节 kept、加 e（差量叠加在现状上）')
  bus.feed(idleEv())
  await until(() => runEvents.some((e) => e.type === 'step-done' && e.stepId === 'b'), '在飞 b 跑完')
  bus.feed(idleEv())
  await until(() => createIds(driver).length >= 4, 'd、e 派发（合并计划 [b, d, e] 声明序平手裁决）')
  assert.deepEqual(createIds(driver).slice(-2), [P('d'), P('e')], 'd 先 e 后（同就绪按声明序）')
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'completed', '两次交接后 completed')
  assert.deepEqual(out.completed, ['b', 'd', 'e', 'a'], 'completed = [b, d, e] + carried [a]')
  assert.deepEqual(out.hole, { added: ['e'], dropped: [], changed: [], pinned: ['b'], kept: ['d'], at: out.hole.at }, 'result.hole = 最近一次交接')
  assert.deepEqual(journalEventTypes(storage), ['hole', 'hole'], 'journal 恰两条 hole 审计')
  ok('叠加交接：第二次差量 kept [d]、新增 e、result.hole 取最近一次')
}

// ---- 6. 引用去重：pull 恒回同一对象 → 恰应用一次（防重复播种回归锚）----
console.log('6. 同对象去重')
{
  const bus = makeEvents()
  let armed = false
  const decl = { runId: 'run-p4h-dedupe', steps: [{ stepId: 'b', prompt: P('b'), deps: [] }, step('d', ['b'])] }
  const { p, journal, driver, storage, runEvents } = rig({
    runId: 'run-p4h-dedupe',
    steps: [step('a'), step('b', ['a'])],
    scenarios: [
      sc('a', [{ status: 'done', text: 'A 完' }]),
      sc('b', [{ status: 'running' }, { status: 'done', text: 'B 完' }]),
      sc('d', [{ status: 'done', text: 'D 完' }]),
    ],
    events: bus.events,
    hole: { pull: () => (armed ? decl : null) }, // armed 后每轮 loop-top 都拉到同一引用
  })
  await until(() => createIds(driver).length >= 1, 'a 派发')
  bus.feed(idleEv())
  await until(() => createIds(driver).length >= 2, 'b 派发（在飞）')
  armed = true
  bus.feed(idleEv()) // 第一次拉到 decl → 应用
  await until(() => journalEventsOf(storage, 'hole').length === 1, '交接恰应用一次')
  assert.deepEqual(journalEventsOf(storage, 'hole')[0].payload.pinned, ['b'], '应用时 b 在飞 → pinned')
  bus.feed(idleEv()) // 后续每轮 loop-top 拉到同一引用 → 去重跳过
  bus.feed(idleEv())
  bus.feed(idleEv())
  assert.equal(journalEventsOf(storage, 'hole').length, 1, '同一对象重复拉取不重复应用（恰 1 条审计）')
  await until(() => runEvents.some((e) => e.type === 'step-done' && e.stepId === 'b'), '在飞 b 跑完')
  bus.feed(idleEv())
  await until(() => createIds(driver).length >= 3, 'd 派发恰一次（重复应用会重播种 → halted）')
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'completed', 'run 正常 completed（未被重复播种打成 halted）')
  assert.deepEqual(createIds(driver), [P('a'), P('b'), P('d')], 'create 恰 3 次（d 只播种派发一次）')
  ok('同对象去重：恰应用一次、零重复播种、run 不 halted')
}

// ---- 7. 非法交接：校验 fail-fast，零 journal 写 ----
console.log('7. 非法交接 → TypeError fail-fast')
{
  const cases = [
    ['未知 deps 引用', { runId: 'run-p4h-bad1', steps: [step('x', ['ghost'])] }, /未知引用/],
    ['runId 不同 run', { runId: 'run-other', steps: [] }, /runId/],
    ['非声明垃圾', 42, /必须是对象|declaration 不合法/],
  ]
  for (const [label, bad, pattern] of cases) {
    const bus = makeEvents()
    let stage = 0
    const { p, driver, storage } = rig({
      runId: 'run-p4h-bad',
      steps: [step('a'), step('b', ['a'])],
      scenarios: [sc('a', [{ status: 'done', text: 'A 完' }]), sc('b', [{ status: 'running' }, { status: 'done', text: 'B 完' }])],
      events: bus.events,
      hole: { pull: () => (stage === 1 ? bad : null) },
    })
    await until(() => createIds(driver).length >= 1, 'a 派发')
    bus.feed(idleEv())
    await until(() => createIds(driver).length >= 2, 'b 派发（运行中交接）')
    stage = 1
    bus.feed(idleEv())
    await assert.rejects(settle(p), (e) => e instanceof TypeError && pattern.test(e.message), `${label} → TypeError（信息含 ${pattern}）`)
    assert.deepEqual(journalEventTypes(storage), [], `${label}：零 hole 审计（校验先于一切 journal 写）`)
    ok(`非法交接（${label}）→ TypeError、零审计`)
  }
}

// ---- 8. 拉取源抛错：吞掉不炸 run ----
console.log('8. pull 抛错吞掉')
{
  const bus = makeEvents()
  const { p, storage } = rig({
    runId: 'run-p4h-pull-throw',
    steps: [step('a')],
    scenarios: [sc('a', [{ status: 'done', text: 'A 完' }])],
    events: bus.events,
    hole: {
      pull: () => {
        throw new Error('拉取源抖了一下')
      },
    },
  })
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'completed', 'pull 抛错只吞掉，run 照常完成')
  assert.deepEqual(journalEventTypes(storage), [], '零 hole 审计')
  assert.equal(out.hole, undefined, '无交接摘要（从未应用过）')
  ok('pull 抛错：本轮吞掉、run 照常完成、零 hole 审计')
}

console.log(`\n引擎 P4-H hole 测试（T4.2 门：在飞不动/差量正确 + 新步序/叠加/去重/非法面）：${passed} 项全过`)
