// E1 引擎 P4-A amend 测试（T4.3 门；蓝图 unified-run-plan-p0-p5.md §P4「amend 哈希命中导入/
// 不导入」，T4.3 断言「命中零重跑 / prompt 变了不导入（字节级）」，E1 规格 §3「matchAmend 按
// stepId + sha256(prompt) 相等导入，任何字节不等不导入」/ §6 clock-fault 构造参数注入）。
//
// 覆盖矩阵：
//   T4.3 主线  真 run 驱动旧 journal（a/b/c done、d failed、f done）→ amend 五类：imported
//             [a,b,d]（字节级命中）、carried [a,b]（写入新 journal）、rerun [d]（命中但旧 run
//             没跑完）、changed [c]（prompt 差一字不导入）、added [e]、dropped [f]（旧进度随旧
//             run 弃置）；新 run 对 carried 步零重跑——mock 场景根本不含 a/b（任何重派都会
//             E1_DRIVER_NO_SCENARIO 炸出），a/b 的 text/sessionId 经 journal payload 原样回流；
//             changed/added/rerun 按合并计划拓扑派发；amend 审计事件 + resume 结构性证据 +
//             carried 步 attempts=0（不伪造派发史）。
//   字节级    promptFingerprint 矩阵：尾随空格 / 全角空格 / 大小写 / Unicode 组合分解 → 指纹
//             全不等；同串确定性相等。尾随空格变体走 amend → changed、carried 空、新 run 重跑。
//   失败分轨  旧 journal torn → ok:false old-journal-not-ok；fault.failWrite 三形态 → ok:false
//             journal-not-ok(stage=seed)，盘上三态如实（before 无记录 / mid 撕裂 / after 播种
//             已落盘——重读即得，恢复归调用方）；新 journal 带现成记录 → new-journal-not-ok。
//   参数面    oldDecl/newDecl 不合法、oldJournal 缺 face、oldJournal 与 oldDecl runId 不符、
//             storage 形状坏 → TypeError fail-fast；同 runId 修订稿合法（新 journal 用它的 runId）。
//   结构性质  amend 不收 driver（结构性零重跑）；旧 journal 只读不写。
//
// 夹具全合成（真 run 驱动旧 journal + mock driver + 可控时钟 + 可喂事件总线）；replay 录制件
// 属 S7a，本文件不引用 fixtures/engine/replay/（不创建、不读取）。
//
// 运行：node plugin/test/engine-p4-A.test.mjs（assert 失败即抛、非零退出；成功自然退出）
import assert from 'node:assert/strict'

import { createJournal } from '../src/engine/journal.js'
import { createDriver } from '../src/engine/driver.js'
import { amend, promptFingerprint, resume } from '../src/engine/resume.js'
import { run } from '../src/engine/scheduler.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- 夹具基座（全合成；与前序 engine 测试同一套 idiom）----
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
const journalEventsOf = (storage, type) => (storage.read() ? JSON.parse(storage.read()).events.filter((e) => e.type === type) : [])

/** 驱动一个真旧 run 到终局（旧 journal 由调度器自己写——不手搓记账）。 */
const driveOldRun = async ({ runId, steps, scenarios, clock = manualClock(5_000), pump = 8 }) => {
  const bus = makeEvents()
  const storage = memStorage()
  const journal = createJournal({ storage, runId, now: clock })
  const driver = createDriver('mock', { scenarios, now: clock })
  const p = run({ runId, steps }, { journal, driver, events: bus.events, now: clock })
  await until(() => createIds(driver).length >= 1, '旧 run 起派')
  for (let i = 0; i < pump; i += 1) {
    bus.feed(idleEv())
    await tick()
  }
  const out = await settle(p)
  return { journal, storage, driver, out }
}

// ---- 0. 字节级指纹矩阵（T4.3「prompt 变了不导入」的判据面）----
console.log('0. promptFingerprint 字节级')
{
  const same = '任务 c：汇总三个结论'
  assert.equal(promptFingerprint(same), promptFingerprint(same), '同串确定性：指纹相等')
  const diffs = [
    ['尾随空格', `${same} `],
    ['前导换行', `\n${same}`],
    ['全角空格', '任务　c：汇总三个结论'],
    ['大小写', '任务 C：汇总三个结论'],
    ['组合/分解（café é 组合 vs e+组合附标）', 'caf\u00e9 vs cafe\u0301'],
    ['句末多一个句号', `${same}。`],
  ]
  for (const [label, variant] of diffs) {
    assert.notEqual(promptFingerprint(same), promptFingerprint(variant), `任何字节不等 → 指纹不等：${label}`)
  }
  ok('promptFingerprint：同串相等确定 + 六种一字之差全不等（sha256 字节级）')
}

// ---- 1. 参数校验（TypeError = 程序错误，fail-fast）----
console.log('1. amend 参数面')
{
  const oldDecl = { runId: 'R1', steps: [step('a')] }
  const newDecl = { runId: 'R2', steps: [step('a')] }
  const oldJournal = createJournal({ storage: memStorage(), runId: 'R1', now: manualClock() })
  assert.throws(() => amend({ runId: 'R1', steps: [{ stepId: 'x', prompt: 'x', deps: ['ghost'] }] }, newDecl, oldJournal, { storage: memStorage() }), TypeError, 'oldDecl 不合法（未知引用）→ TypeError')
  assert.throws(() => amend(oldDecl, { runId: 'R2', steps: 'no' }, oldJournal, { storage: memStorage() }), TypeError, 'newDecl 不合法 → TypeError')
  assert.throws(() => amend(oldDecl, newDecl, { status: () => ({}) }, { storage: memStorage() }), TypeError, 'oldJournal 缺 face → TypeError')
  const otherRun = createJournal({ storage: memStorage(), runId: 'RX', now: manualClock() })
  assert.throws(() => amend(oldDecl, newDecl, otherRun, { storage: memStorage() }), (e) => e instanceof TypeError && /runId/.test(e.message), 'oldJournal 与 oldDecl runId 不符 → TypeError')
  assert.throws(() => amend(oldDecl, newDecl, oldJournal, { storage: {} }), TypeError, 'storage 缺 read/write → TypeError（createJournal 深校验）')
  // 同 runId 修订稿合法：新 journal 用 newDecl 的 runId 建（fresh storage 无冲突）
  const sameRun = { runId: 'R1', steps: [step('a'), step('b', ['a'])] }
  const verdict = amend(oldDecl, sameRun, oldJournal, { storage: memStorage(), now: manualClock() })
  assert.equal(verdict.ok, true, '同 runId 修订稿 → ok:true')
  assert.equal(verdict.journal.status().runId, 'R1', '新 journal 归属修订稿 runId')
  ok('参数面：4 路 TypeError 分轨 + 同 runId 修订稿合法')
}

// ---- 2. 旧 journal torn → ok:false（宁可整段重跑，不带病导入）----
console.log('2. 旧 journal torn')
{
  const tornStorage = memStorage()
  tornStorage.write('{"runId":"R1","upd') // 撕裂 JSON
  const oldJournal = createJournal({ storage: tornStorage, runId: 'R1', now: manualClock() })
  const oldDecl = { runId: 'R1', steps: [step('a')] }
  const newDecl = { runId: 'R2', steps: [step('a')] }
  const verdict = amend(oldDecl, newDecl, oldJournal, { storage: memStorage(), now: manualClock() })
  assert.equal(verdict.ok, false, 'torn → ok:false')
  assert.equal(verdict.reason, 'old-journal-not-ok', 'reason = old-journal-not-ok')
  assert.equal(verdict.status.torn, true, 'status 报 torn')
  assert.equal(verdict.status.reason, 'unparseable', '撕裂原因 unparseable')
  ok('旧 journal torn：ok:false 拒导入（不带病）')
}

// ---- 3. fault.failWrite 三形态 → ok:false + 盘上三态如实 ----
console.log('3. 新 journal 写败（fault 注入）')
{
  for (const form of ['before', 'mid', 'after']) {
    const { journal: oldJournal } = await driveOldRun({ runId: 'R1', steps: [step('a')], scenarios: [sc('a', [{ status: 'done', text: 'A' }])], pump: 4 })
    const amendStorage = memStorage()
    const verdict = amend({ runId: 'R1', steps: [step('a')] }, { runId: 'R2', steps: [step('a')] }, oldJournal, {
      storage: amendStorage,
      fault: { failWrite: form },
      now: manualClock(40_000),
    })
    assert.equal(verdict.ok, false, `${form}：ok:false`)
    assert.equal(verdict.reason, 'journal-not-ok', `${form}：reason journal-not-ok`)
    assert.equal(verdict.stage, 'declared', `${form}：导入链首条迁移即失败（stage=declared）`)
    assert.equal(verdict.stepId, 'a', `${form}：失败步定位`)
    assert.equal(verdict.status.degraded, true, `${form}：journal 就地劣化`)
    // 盘上三态（重读即得）：before 无记录 / mid 撕裂 / after 播种已落盘（恢复归调用方）。
    const fresh = createJournal({ storage: amendStorage, runId: 'R2', now: manualClock() })
    if (form === 'before') {
      assert.equal(fresh.status().fresh, true, 'after=before：盘上无记录（fresh）')
    } else if (form === 'mid') {
      assert.equal(fresh.status().torn, true, 'after=mid：盘上撕裂（torn）')
    } else {
      assert.equal(fresh.getStepState('a')?.state, 'declared', 'after=after：播种已落盘（declared，重读即得）')
    }
    ok(`failWrite=${form}：ok:false stage=declared + 盘上三态如实`)
  }
}

// ---- 4. T4.3 主线：命中零重跑 / prompt 变了不导入 / rerun / added / dropped ----
console.log('4. T4.3 主线：五类导入 + 新 run 零重跑')
{
  // 旧 run：a/b/c done、d failed（命中但没跑完）、f done（将 dropped）。
  const oldDecl = { runId: 'R1', steps: [step('a'), step('b', ['a']), step('c', ['b']), step('d', ['c']), step('f')] }
  const { journal: oldJournal, storage: oldStorage, driver: oldDriver } = await driveOldRun({
    runId: 'R1',
    steps: oldDecl.steps,
    scenarios: [
      sc('a', [{ status: 'done', text: 'A' }]),
      sc('b', [{ status: 'done', text: 'B' }]),
      sc('c', [{ status: 'done', text: 'C' }]),
      sc('d', [{ status: 'failed', errorPart: 'boom' }]),
      sc('f', [{ status: 'done', text: 'F' }]),
    ],
  })
  assert.equal(oldJournal.getStepState('a')?.state, 'done', '夹具自检：旧 a done')
  assert.equal(oldJournal.getStepState('d')?.state, 'failed', '夹具自检：旧 d failed')
  assert.equal(oldJournal.getStepState('f')?.state, 'done', '夹具自检：旧 f done')

  // 修订稿：a/b/d 同字节（命中）、c prompt 尾加一字（changed）、e 新增；f 不再出现（dropped）。
  const C2 = `${P('c')}!`
  const newDecl = { runId: 'R2', steps: [step('a'), step('b', ['a']), { stepId: 'c', prompt: C2, deps: ['b'] }, step('d', ['c']), step('e')] }

  const amendStorage = memStorage()
  const amendClock = manualClock(40_000)
  const verdict = amend(oldDecl, newDecl, oldJournal, { storage: amendStorage, now: amendClock })

  // —— 五类清单（T4.3 判据）——
  assert.equal(verdict.ok, true, 'amend ok')
  assert.deepEqual(verdict.imported, ['a', 'b', 'd'], 'imported = 字节级命中（c 因 prompt 差一字被排除）')
  assert.deepEqual(verdict.carried, ['a', 'b'], 'carried = 命中且旧 run done（d failed → 不导入）')
  assert.deepEqual(verdict.rerun, ['d'], 'rerun = 命中但旧 run 没跑完')
  assert.deepEqual(verdict.changed, ['c'], 'changed = prompt 变了不导入（字节级）')
  assert.deepEqual(verdict.added, ['e'], 'added = 修订稿新增')
  assert.deepEqual(verdict.dropped, ['f'], 'dropped = 旧独有（旧进度随旧 run 弃置）')
  assert.equal(typeof verdict.at, 'number', 'at 走注入时钟')

  // —— 新 journal 导入面 ——
  const newJournal = verdict.journal
  assert.equal(newJournal.status().runId, 'R2', '新 journal 归属 R2')
  const oldA = oldDriver.calls.find((c) => c.op === 'create' && c.args.prompt === P('a'))
  const payloadA = newJournal.getStepState('a')
  assert.equal(payloadA.state, 'done', 'carried a 已写 done')
  assert.equal(payloadA.attempts, 1, 'carried attempts=1（导入落账走调度器同款四段链，不发明第三种记账形态）')
  assert.deepEqual(
    payloadA.history.map((h) => h.to),
    ['declared', 'dispatching', 'running', 'done'],
    'carried 步史 = 调度器同款四段链',
  )
  assert.deepEqual(payloadA.history.at(-1).payload, { result: { text: 'A' }, sessionId: oldA.sessionId }, 'done payload = 旧 run 原样（text + 旧 sessionId）')
  assert.equal(newJournal.getStepState('c'), null, 'changed 步不导入（新 run 自行播种）')
  assert.equal(newJournal.getStepState('f'), null, 'dropped 步不导入')
  assert.deepEqual(journalEventsOf(amendStorage, 'amend')[0].payload, {
    imported: ['a', 'b', 'd'],
    carried: ['a', 'b'],
    rerun: ['d'],
    changed: ['c'],
    added: ['e'],
    dropped: ['f'],
  }, '新 journal 记 amend 审计（五类清单）')
  const struct = resume(newDecl, newJournal)
  assert.deepEqual([...struct.completed.keys()].sort(), ['a', 'b'], 'resume 结构性证据：新 journal 对修订稿只认 carried 两步')
  assert.deepEqual(struct.pending, ['c', 'd', 'e'], 'pending = changed/added/rerun 三步')
  // 旧 journal 只读不写：amend 后盘上事件数不变（无 amend 痕迹写进旧账）。
  assert.deepEqual(journalEventsOf(oldStorage, 'amend'), [], '旧 journal 零 amend 痕迹（只读不写）')

  // —— 新 run：carried 零重跑（a/b 场景根本不给——重派即炸），其余按拓扑跑 ——
  // journal 在 amendStorage 上新开实例：盘上真相（carried a/b done）重读即得（journal 铁律 2）。
  const bus = makeEvents()
  const clock = manualClock(50_000)
  const journal = createJournal({ storage: amendStorage, runId: 'R2', now: clock })
  assert.equal(journal.getStepState('a')?.state, 'done', '新实例从盘上读到 carried a done（跨实例持久化）')
  const driver = createDriver('mock', {
    scenarios: [sc({ prompt: C2 }, [{ status: 'done', text: 'C2 新' }]), sc('d', [{ status: 'done', text: 'D 新' }]), sc('e', [{ status: 'done', text: 'E 完' }])],
    now: clock,
  })
  const runEvents = []
  const p = run(newDecl, { journal, driver, events: bus.events, now: clock, onEvent: (e) => runEvents.push(e) })
  await until(() => createIds(driver).length >= 2, 'c（changed）与 e（added）首批派发（a/b done 零调用）')
  assert.deepEqual(createIds(driver), [C2, P('e')], '首批就绪集 = c2 + e（声明序平手），a/b 零 create（T4.3 命中零重跑）')
  bus.feed(idleEv())
  await until(() => journal.getStepState('c')?.state === 'done' && journal.getStepState('e')?.state === 'done', 'c、e 完成')
  bus.feed(idleEv()) // loop-top：d（deps c）就绪派发
  await until(() => createIds(driver).length >= 3, 'd 补位派发（rerun）')
  bus.feed(idleEv())
  const out = await settle(p)

  assert.equal(out.status, 'completed', '修订稿 run completed（旧 d 失败不牵连新 run）')
  assert.deepEqual(out.completed, ['a', 'b', 'c', 'd', 'e'], 'completed = carried[a,b] + 新跑[c,d,e] 按声明序')
  assert.deepEqual(out.pending, [], '无残留')
  assert.deepEqual(createIds(driver), [C2, P('e'), P('d')], 'create 全序恰 3 次：a/b 零 create（结构性零重跑）')
  assert.equal(out.steps.a.text, 'A', 'a 的产出来自旧 run（payload 回流）')
  assert.equal(out.steps.b.text, 'B', 'b 的产出来自旧 run')
  assert.equal(out.steps.a.sessionId, oldA.sessionId, 'a 沿用旧 run 的 sessionId（溯源可查）')
  assert.equal(out.steps.c.text, 'C2 新', 'changed c 用新 prompt 重跑')
  assert.equal(out.steps.d.text, 'D 新', 'rerun d 新 run 补跑成功（旧失败不携带）')
  assert.equal(newJournal.getStepState('a').attempts, 1, 'run 终局后 carried a 仍 attempts=1（全程零派发，导入落账的诚实形式）')
  assert.ok(
    runEvents.every((e) => e.stepId !== 'a' && e.stepId !== 'b'),
    'run 事件里 a/b 零痕迹（只导入不重演）',
  )
  ok('T4.3：命中零重跑（a/b 场景缺席也 completed）/ prompt 差一字不导入 / rerun-added-dropped 三类各就位')
}

// ---- 5. 字节级变体：尾随空格也是「变了」 ----
console.log('5. 尾随空格变体（字节级不导入的行为级证据）')
{
  const { journal: oldJournal } = await driveOldRun({ runId: 'R1', steps: [step('c')], scenarios: [sc('c', [{ status: 'done', text: 'C' }])], pump: 4 })
  const C2 = `${P('c')} ` // 尾随一个空格——任何字节不等即 changed
  const newDecl = { runId: 'R2', steps: [{ stepId: 'c', prompt: C2, deps: [] }] }
  const verdict = amend({ runId: 'R1', steps: [step('c')] }, newDecl, oldJournal, { storage: memStorage(), now: manualClock(40_000) })
  assert.equal(verdict.ok, true, 'amend ok')
  assert.deepEqual(verdict.imported, [], '尾随空格 → imported 空（字节级）')
  assert.deepEqual(verdict.changed, ['c'], 'changed = [c]')
  assert.deepEqual(verdict.carried, [], 'carried 空（不导入）')
  // 新 run 行为级：c 重跑且用带空格的新 prompt。
  const bus = makeEvents()
  const clock = manualClock(50_000)
  const journal = createJournal({ storage: memStorage(), runId: 'R2', now: clock })
  const driver = createDriver('mock', { scenarios: [sc({ prompt: C2 }, [{ status: 'done', text: 'C 重跑' }])], now: clock })
  const p = run(newDecl, { journal, driver, events: bus.events, now: clock })
  await until(() => createIds(driver).length >= 1, 'c 重跑派发（空格版 prompt）')
  assert.deepEqual(createIds(driver), [C2], 'create prompt = 带空格的修订稿（旧进度零复用）')
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'completed', '重跑完成')
  assert.equal(out.steps.c.text, 'C 重跑', '产出来自新 run（非旧 C）')
  ok('尾随空格：指纹不等 → changed 不导入 → 新 run 以空格版 prompt 重跑')
}

console.log(`\n引擎 P4-A amend 测试（T4.3 门：命中零重跑/字节级不导入 + 失败分轨/参数面）：${passed} 项全过`)
