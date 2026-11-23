// E1 引擎 P4-E escalation 测试（T4.1 门；蓝图 unified-run-plan-p0-p5.md §P4
// 「escalation 分支暂停/兄弟继续」「T4.1 断言兄弟照常完成、依赖步挂起、答复后恢复」，
// E1 规格 .zcode/plans/e1-construction-spec.md §3「escalation 走 onEscalate 回调，
// P4 接面板，E1 先落 journal blocked + 台账」/ §6 clock 注入）。
//
// 覆盖矩阵：
//   T4.1 主线  DAG q→d + 无依赖兄弟 s：问句产出 → 台账记 blocked（payload 带 question）+
//             journal 记 escalated + onEscalate 恰一次；挂起中兄弟 s 照常完成、依赖步 d
//             停在 declared（零 create）；答复（answerFor 非阻塞拉取）→ journal 记
//             escalation-answered → blocked→dispatching（恢复重入边）→ escalationPrompt
//             组装重派 → q done → d 才派发 → run completed；ledger history 链与 run 事件
//             序列逐项断言（先落盘再广播的全时间线）。
//   分支独立  双问句 q1→d1 / q2→d2 + s：只答复 q1 时 d1 照常跑完而 q2/d2 仍挂（只暂停
//             依赖分支的强证据）；再答复 q2 后各自恢复到 completed。
//   重复问句  恢复后的产出再问 → 再次挂起（escalated×2、attempt 递增）、再答复再恢复。
//   notify-only  escalation 只给 onEscalate（无 answerFor）：挂起即终局——run blocked
//             (reason=escalation-pending)、escalation 数组列出问句、依赖步零派发；
//             escalation:{} 空对象同口径且零回调。
//   E1 口径   escalation 缺省/null：问句形状的 done 产出照普通 done 收敛（text 原样保留、
//             依赖照派、零 escalated 事件）——P4 不改 E1 缺省语义。
//   超时窗口  blocked 步不吃超时兜底（时钟推进越过 timeoutMs 仍挂起、零 timeout 事件）；
//             恢复重派刷新 lastDispatchAt（窗口重开）。
//   恢复即败  答复后重派 create 抛错 → dispatching→failed、下游 declared→superseded、
//             run failed（熔断计数 +1 但未达上限）。
//   答复源    answerFor 抛错/空串/非字符串 → 本轮跳过不恢复、之后恢复恰一次；同一问句
//             不重复答复（挂起档答复即删）。
//   参数面    escalation 非对象 / onEscalate、answerFor 非函数 → TypeError fail-fast。
//   纯函数面  parseQuestion 八形态判定矩阵 + escalationPrompt 确定性模板。
//
// 夹具全合成（mock driver 脚本化 + 手搓 fake driver + 可控时钟 + 可喂事件总线）；
// replay 录制件属 S7a，本文件不引用 fixtures/engine/replay/（不创建、不读取）。
// mock 场景的 match.prompt 用实现导出的 escalationPrompt 计算（单一事实来源），再断言
// 实际 create 的 prompt 逐字符相等。
//
// 运行：node plugin/test/engine-p4-E.test.mjs（assert 失败即抛、非零退出；成功自然退出）
import assert from 'node:assert/strict'

import { createJournal } from '../src/engine/journal.js'
import { createDriver } from '../src/engine/driver.js'
import { escalationPrompt, parseQuestion } from '../src/engine/escalation.js'
import { run } from '../src/engine/scheduler.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- 夹具基座（全合成；与 engine-scheduler.test.mjs 同一套 idiom）----
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
/** 可喂事件的 AsyncIterable：feed 进队或直接唤醒挂起的 next()（调度循环「事件到达才查」的脸）。 */
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
/** 问句产出的 done 应答（done 且 text 是带 question 键的 JSON 对象 = P4-E 问句口径）。 */
const questionDone = (question, extra = {}) => ({ status: 'done', text: JSON.stringify({ question, ...extra }) })

/** 手搓 driver（面合法：create/result/context 全函数）：覆盖 mock 造不出的「恢复派发即败」臂。 */
const fakeDriver = ({ create, result } = {}) => ({
  calls: [],
  create: async (args) => (create ? create(args) : { sessionId: 'sess_fake' }),
  result: result ?? (async () => ({ status: 'running' })),
  context: async () => ({}),
})

/** 一套测试装具：journal + driver + run() 同时起跑；两级事件（run 广播 / journal 盘上审计）分账。 */
const rig = ({ runId, steps, scenarios = [], now = manualClock(), escalation, events, driver: customDriver }) => {
  const runEvents = []
  const storage = memStorage()
  const journal = createJournal({ storage, runId, now })
  const driver = customDriver ?? createDriver('mock', { scenarios, now })
  const p = run({ runId, steps }, { journal, driver, escalation, events, now, onEvent: (e) => runEvents.push(e) })
  return { p, journal, driver, storage, runEvents, now }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
/** 轮询等待直到 f() 为真（微任务都在 tick 间隙跑完；超时即断言失败）。 */
const until = async (f, label, tries = 2000) => {
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
const createIds = (driver) => driver.calls.filter((c) => c.op === 'create').map((c) => c.args.prompt)
const journalEventTypes = (storage) => (storage.read() ? JSON.parse(storage.read()).events.map((e) => e.type) : [])

// ---- 0. 纯函数面：parseQuestion 判定矩阵 + escalationPrompt 确定性 ----
console.log('0. parseQuestion / escalationPrompt')
{
  assert.deepEqual(parseQuestion('{"question":"装哪个版本？"}'), { question: '装哪个版本？', output: { question: '装哪个版本？' } }, '合法问句对象 → {question, output}')
  const withExtra = parseQuestion('{"question":"q","target":"prod","n":1}')
  assert.equal(withExtra.question, 'q', '问句键照提')
  assert.deepEqual(withExtra.output, { question: 'q', target: 'prod', n: 1 }, '其余键原样保留在 output（面板可读）')
  for (const [label, text] of [
    ['非 JSON', '这不是 JSON'],
    ['JSON 数组', '["question"]'],
    ['JSON 字符串', '"question"'],
    ['JSON 数字', '42'],
    ['JSON null', 'null'],
    ['对象无 question 键', '{"result":"ok"}'],
    ['question 空串', '{"question":""}'],
    ['question 非字符串', '{"question":42}'],
  ]) {
    assert.equal(parseQuestion(text), null, `不是问句 → null：${label}`)
  }
  assert.equal(parseQuestion(undefined), null, '非字符串入参 → null')
  ok('parseQuestion：八形态非问句全 null + 合法问句带 output 全键保留 + 永不抛错')
}
{
  const a = escalationPrompt(P('x'), '装哪个版本？', '装 2.x')
  assert.ok(a.startsWith(P('x')), '恢复 prompt 以原 prompt 开头')
  assert.ok(a.includes('[reeve escalation]'), '带 escalation 标头')
  assert.ok(a.includes('问句：装哪个版本？'), '带问句段')
  assert.ok(a.includes('答复：装 2.x'), '带答复段')
  assert.equal(a, escalationPrompt(P('x'), '装哪个版本？', '装 2.x'), '确定性：同入参逐字符相等（mock match.prompt 的单一事实来源）')
  assert.notEqual(a, escalationPrompt(P('x'), '装哪个版本？', '装 3.x'), '答复不同则 prompt 不同（答复进 prompt 的证据）')
  ok('escalationPrompt：原 prompt + 问句 + 答复、确定性模板')
}

// ---- 1. T4.1 主线：q→d + 兄弟 s（挂起中兄弟完成、依赖步挂起、答复后恢复）----
console.log('1. T4.1 主线：兄弟照常完成 / 依赖步挂起 / 答复后恢复')
{
  const QUESTION = '目标机装 2.x 还是 3.x？'
  const ANSWER = '装 2.x'
  const RESUME = escalationPrompt(P('q'), QUESTION, ANSWER)
  const bus = makeEvents()
  const escalated = []
  let armed = false
  const { p, journal, driver, storage, runEvents } = rig({
    runId: 'run-p4e-main',
    steps: [step('q'), step('s'), step('d', ['q'])],
    scenarios: [
      { name: 'q', match: { prompt: P('q') }, result: [{ status: 'running' }, questionDone(QUESTION, { candidates: ['2.x', '3.x'] })] },
      { name: 'q-resume', match: { prompt: RESUME }, result: [{ status: 'done', text: '{"ok":true,"choice":"2.x"}' }] },
      { name: 's', match: { prompt: P('s') }, result: [{ status: 'running' }, { status: 'done', text: 'S 完' }] },
      { name: 'd', match: { prompt: P('d') }, result: [{ status: 'done', text: 'D 完' }] },
    ],
    events: bus.events,
    escalation: {
      onEscalate: (rec) => escalated.push(rec),
      answerFor: () => (armed ? ANSWER : null), // 非阻塞答复源：未 armed 前恒「未答」
    },
  })

  await until(() => createIds(driver).length >= 2, 'q、s 首批派发（d 依赖未完成不派）')
  assert.deepEqual(createIds(driver), [P('q'), P('s')], '首轮就绪集 = q + 兄弟 s（d 不派）')
  bus.feed(idleEv())
  await until(() => driver.calls.some((c) => c.op === 'result'), '首轮轮询')
  bus.feed(idleEv())
  await until(() => runEvents.some((e) => e.type === 'escalated'), 'q 问句挂起')
  await until(() => runEvents.some((e) => e.type === 'step-done' && e.stepId === 's'), '兄弟 s 照常完成')

  // —— 挂起中态断言（T4.1 核心三句的前两句）——
  assert.equal(journal.getStepState('q').state, 'blocked', '台账记 blocked：q 挂起')
  assert.equal(journal.getStepState('s').state, 'done', '兄弟 s 照常完成（不受 q 挂起牵连）')
  assert.equal(journal.getStepState('d').state, 'declared', '依赖步 d 挂在 declared（未派、未废）')
  assert.deepEqual(createIds(driver), [P('q'), P('s')], '挂起期间 d 零 create（只暂停依赖分支）')
  assert.equal(escalated.length, 1, 'onEscalate 恰一次')
  assert.equal(escalated[0].kind, 'escalation', 'record.kind')
  assert.equal(escalated[0].runId, 'run-p4e-main', 'record.runId')
  assert.equal(escalated[0].stepId, 'q', 'record.stepId')
  assert.equal(escalated[0].question, QUESTION, 'record.question')
  assert.equal(escalated[0].attempt, 1, 'record.attempt = 挂起那轮的尝试数（含初派）')
  assert.equal(typeof escalated[0].at, 'number', 'record.at 走注入时钟')
  assert.equal(typeof escalated[0].sessionId, 'string', 'record.sessionId = 问句会话')
  assert.deepEqual(escalated[0].output, { question: QUESTION, candidates: ['2.x', '3.x'] }, 'record.output = 完整产出对象（面板可读）')
  const qSession = escalated[0].sessionId

  // —— 答复后恢复（T4.1 第三句）——
  armed = true
  bus.feed(idleEv()) // 空轮询一轮：本轮 loop-top 的 resume 拉到答复
  await until(() => createIds(driver).includes(RESUME), '答复后 q 按恢复 prompt 重派')
  assert.equal(journal.getStepState('q').attempts, 2, '恢复重派 attempts=2（含初派）')
  bus.feed(idleEv())
  await until(() => journal.getStepState('q').state === 'done', '恢复产出 done')
  await until(() => createIds(driver).includes(P('d')), 'q done 后依赖步 d 才派发')
  bus.feed(idleEv())
  const out = await settle(p)

  assert.equal(out.status, 'completed', '答复恢复后 run completed（全步终态）')
  assert.deepEqual(out.completed, ['q', 's', 'd'], 'completed 按声明序')
  assert.deepEqual(out.pending, [], '无挂起残留')
  assert.deepEqual(createIds(driver), [P('q'), P('s'), RESUME, P('d')], 'create 全序：q 初派、s、q 恢复重派、d（恰好 4 次）')
  const resumeCall = driver.calls.find((c) => c.op === 'create' && c.args.prompt === RESUME)
  assert.equal(resumeCall.args.title, 'REEVE-E1 run-p4e-main q', '恢复重派沿用同一 title 锚点（新会话同锚点）')
  // 台账（journal 盘上）：blocked 迁移 payload + escalated/escalation-answered 审计 + history 链。
  const disk = JSON.parse(storage.read())
  const blockedEntry = disk.steps.q.history.find((h) => h.to === 'blocked')
  assert.deepEqual(blockedEntry.payload, { question: QUESTION, sessionId: qSession }, 'blocked 迁移 payload 带 question + sessionId')
  assert.deepEqual(disk.events.find((e) => e.type === 'escalated').payload, { stepId: 'q', question: QUESTION, sessionId: qSession }, 'escalated 审计事件带问句')
  assert.deepEqual(disk.events.find((e) => e.type === 'escalation-answered').payload, { stepId: 'q', answer: ANSWER, question: QUESTION }, 'escalation-answered 审计事件带答复')
  assert.deepEqual(
    disk.steps.q.history.map((h) => h.to),
    ['declared', 'dispatching', 'running', 'blocked', 'dispatching', 'running', 'done'],
    'q 的 ledger history 链：blocked→dispatching 恢复重入边在案',
  )
  // run 事件序列（先落盘再广播的全时间线）。
  assert.deepEqual(
    runEvents.map((e) => [e.type, e.stepId ?? null]),
    [
      ['dispatch', 'q'],
      ['dispatch', 's'],
      ['escalated', 'q'],
      ['step-done', 's'],
      ['escalation-answered', 'q'],
      ['dispatch', 'q'],
      ['step-done', 'q'],
      ['dispatch', 'd'],
      ['step-done', 'd'],
      ['run-completed', null],
    ],
    'run 事件序列：escalated 早于兄弟 step-done（同轮 pollAll 声明序）、答复后先 answered 再恢复 dispatch',
  )
  assert.equal(runEvents.find((e) => e.type === 'escalated').question, QUESTION, 'escalated 广播带问句（面板可只听 onEvent）')
  ok('T4.1：兄弟照常完成 / 依赖步挂起零派发 / 答复后恢复到 completed + ledger/事件双时间线')
}

// ---- 2. 分支独立：双问句只答一个，另一支仍挂 ----
console.log('2. 分支独立：q1→d1 / q2→d2，只答复 q1 时 d2 分支仍挂')
{
  const Q1 = '库 A 选哪个版本？'
  const Q2 = '库 B 选哪个版本？'
  const A1 = 'A 用 1.x'
  const A2 = 'B 用 2.y'
  const R1 = escalationPrompt(P('q1'), Q1, A1)
  const R2 = escalationPrompt(P('q2'), Q2, A2)
  const bus = makeEvents()
  const arm = { q1: false, q2: false }
  const { p, journal, driver } = rig({
    runId: 'run-p4e-branches',
    steps: [step('q1'), step('q2'), step('s'), step('d1', ['q1']), step('d2', ['q2'])],
    scenarios: [
      { name: 'q1', match: { prompt: P('q1') }, result: [{ status: 'running' }, questionDone(Q1)] },
      { name: 'q2', match: { prompt: P('q2') }, result: [{ status: 'running' }, questionDone(Q2)] },
      { name: 'q1-resume', match: { prompt: R1 }, result: [{ status: 'done', text: 'q1 完' }] },
      { name: 'q2-resume', match: { prompt: R2 }, result: [{ status: 'done', text: 'q2 完' }] },
      { name: 's', match: { prompt: P('s') }, result: [{ status: 'done', text: 'S 完' }] },
      { name: 'd1', match: { prompt: P('d1') }, result: [{ status: 'done', text: 'D1 完' }] },
      { name: 'd2', match: { prompt: P('d2') }, result: [{ status: 'done', text: 'D2 完' }] },
    ],
    events: bus.events,
    escalation: { answerFor: (rec) => (arm[rec.stepId] ? { q1: A1, q2: A2 }[rec.stepId] : null) },
  })

  await until(() => createIds(driver).length >= 3, 'q1、q2、s 首批派发')
  bus.feed(idleEv())
  bus.feed(idleEv())
  await until(() => journal.getStepState('q1').state === 'blocked' && journal.getStepState('q2').state === 'blocked', '双问句双挂起')
  await until(() => journal.getStepState('s').state === 'done', '兄弟 s 照常完成')
  assert.deepEqual(createIds(driver), [P('q1'), P('q2'), P('s')], 'd1/d2 都未派（两支依赖闭包全挂起）')

  arm.q1 = true
  bus.feed(idleEv())
  await until(() => createIds(driver).includes(R1), '只答复 q1 → 仅 q1 恢复重派')
  assert.equal(journal.getStepState('q2').state, 'blocked', '未答复的 q2 仍挂起')
  bus.feed(idleEv())
  await until(() => journal.getStepState('q1').state === 'done', 'q1 恢复产出 done')
  await until(() => createIds(driver).includes(P('d1')), 'd1 派发')
  // 强断言：d1 已在飞时，q2 支路（q2 仍 blocked、d2 仍 declared）纹丝不动。
  assert.equal(journal.getStepState('q2').state, 'blocked', 'd1 在飞时 q2 仍挂起')
  assert.equal(journal.getStepState('d2').state, 'declared', 'd1 在飞时 d2 仍 declared')
  assert.ok(!createIds(driver).includes(P('d2')), 'd2 零 create（只暂停 q2 的依赖分支）')
  bus.feed(idleEv())
  await until(() => journal.getStepState('d1').state === 'done', 'd1 完成（q2 分支挂起期间兄弟支路照常跑完）')

  arm.q2 = true
  bus.feed(idleEv())
  await until(() => createIds(driver).includes(R2), '答复 q2 → q2 恢复重派')
  bus.feed(idleEv())
  await until(() => journal.getStepState('q2').state === 'done', 'q2 恢复产出 done')
  await until(() => createIds(driver).includes(P('d2')), 'd2 派发')
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'completed', '两支先后答复后 run completed')
  assert.deepEqual(createIds(driver), [P('q1'), P('q2'), P('s'), R1, P('d1'), R2, P('d2')], 'create 全序：恢复各一次、d1 先于 d2（答复序决定）')
  ok('分支独立：只答复 q1 时 d1 照常跑完而 q2/d2 纹丝不动；两支先后恢复到 completed')
}

// ---- 3. 重复问句：恢复后的产出再问 → 再挂起、再答复、再恢复 ----
console.log('3. 重复问句（恢复后再问）')
{
  const Q1 = '第一问：部署区选 A 还是 B？'
  const Q2 = '第二问：A 区里选哪个机房？'
  const ANSWER = 'A 区；机房 1'
  // 恢复 prompt 的契约：恒以原声明 prompt 为底 + 本轮问句/答复（全新会话无历史，面板 record 持有全程问答）。
  const R1 = escalationPrompt(P('q'), Q1, ANSWER)
  const R2 = escalationPrompt(P('q'), Q2, ANSWER)
  const bus = makeEvents()
  const escalates = []
  let armed = false
  const { p, journal, driver, runEvents } = rig({
    runId: 'run-p4e-repeat',
    steps: [step('q')],
    scenarios: [
      { name: 'q', match: { prompt: P('q') }, result: [{ status: 'running' }, questionDone(Q1)] },
      { name: 'q-r1', match: { prompt: R1 }, result: [{ status: 'running' }, questionDone(Q2)] },
      { name: 'q-r2', match: { prompt: R2 }, result: [{ status: 'done', text: 'q 完' }] },
    ],
    events: bus.events,
    escalation: {
      onEscalate: (rec) => {
        escalates.push(rec)
        armed = true // 首次问句即 armed；同一答复适用于两问（测试简化）
      },
      answerFor: () => (armed ? ANSWER : null),
    },
  })
  await until(() => createIds(driver).length >= 1, 'q 初派')
  bus.feed(idleEv())
  bus.feed(idleEv())
  await until(() => createIds(driver).includes(R1), '第一次答复 → 恢复重派 R1')
  assert.equal(escalates[0].attempt, 1, '第一次挂起 attempt=1')
  bus.feed(idleEv()) // poll：R1 会话脚本第 1 条（running）
  bus.feed(idleEv()) // poll：R1 会话脚本第 2 条（再问）→ 第二次挂起
  await until(() => escalates.length === 2, '恢复后的产出再问 → 第二次挂起')
  assert.equal(escalates[1].attempt, 2, '第二次挂起 attempt=2（恢复重派那一轮）')
  assert.equal(escalates[1].question, Q2, '第二次问句是新问句')
  await until(() => createIds(driver).includes(R2), '第二次答复 → 再恢复 R2（仍以原声明 prompt 为底、带本轮问答）')
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'completed', '两轮问句后 completed')
  assert.deepEqual(createIds(driver), [P('q'), R1, R2], 'create 恰 3 次（初派 + 两轮恢复）')
  assert.equal(journal.getStepState('q').attempts, 3, 'attempts=3（含初派）')
  assert.deepEqual(
    runEvents.filter((e) => ['escalated', 'escalation-answered'].includes(e.type)).map((e) => e.type),
    ['escalated', 'escalation-answered', 'escalated', 'escalation-answered'],
    'escalation 生命周期事件各恰两次、成对有序',
  )
  ok('重复问句：恢复后再问再挂再答再恢复，attempt 递增、事件成对')
}

// ---- 4. notify-only（无 answerFor）：挂起即终局 escalation-pending ----
console.log('4. notify-only：只挂起不恢复，run blocked(escalation-pending)')
{
  const QUESTION = '预算批到哪一档？'
  const bus = makeEvents()
  const escalated = []
  const { p, journal, driver, storage, runEvents } = rig({
    runId: 'run-p4e-notify',
    steps: [step('q'), step('d', ['q']), step('s')],
    scenarios: [
      { name: 'q', match: { prompt: P('q') }, result: [{ status: 'running' }, questionDone(QUESTION)] },
      { name: 's', match: { prompt: P('s') }, result: [{ status: 'done', text: 'S 完' }] },
    ],
    events: bus.events,
    escalation: { onEscalate: (rec) => escalated.push(rec) }, // 无 answerFor：无人能答复
  })
  await until(() => createIds(driver).length >= 2, 'q、s 首批派发（d 不派）')
  bus.feed(idleEv())
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'blocked', '无人可答 → run blocked')
  assert.equal(out.reason, 'escalation-pending', 'reason = escalation-pending')
  assert.deepEqual(out.escalation, [{ stepId: 'q', question: QUESTION }], 'escalation 数组列出挂起步与问句')
  assert.equal(out.steps.q.state, 'blocked', 'q 留在 blocked（跨调用恢复归 S6 接线，同 failed）')
  assert.deepEqual(out.completed, ['s'], '兄弟 s 已完成的进度保留')
  assert.deepEqual(out.pending, ['q', 'd'], 'pending = 挂起步 + 它的依赖闭包（d 仍 declared）')
  assert.deepEqual(createIds(driver), [P('q'), P('s')], 'd 零 create')
  assert.deepEqual(journalEventTypes(storage), ['escalated'], '台账恰一条 escalated 审计（无 answered）')
  assert.equal(escalated.length, 1, 'onEscalate 恰一次')
  assert.equal(runEvents.at(-1).type, 'run-blocked', '终局广播 run-blocked')
  ok('notify-only：escalation-pending 终局、兄弟进度保留、依赖闭包零派发')
}
{
  const bus = makeEvents()
  const { p, driver } = rig({
    runId: 'run-p4e-empty-esc',
    steps: [step('q')],
    scenarios: [{ name: 'q', match: { prompt: P('q') }, result: [questionDone('无人的问句')] }],
    events: bus.events,
    escalation: {}, // 空对象：识别问句但零回调零答复源
  })
  await until(() => createIds(driver).length >= 1, 'q 初派')
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'blocked', 'escalation:{} 同 notify-only 口径')
  assert.equal(out.reason, 'escalation-pending', 'reason = escalation-pending')
  ok('escalation:{}（空配置）：识别问句、零回调、同 escalation-pending 终局')
}

// ---- 5. E1 口径不变：escalation 缺省/null 时问句产出照普通 done ----
console.log('5. escalation 缺省 = E1「done 即产出」口径不变')
{
  for (const escalation of [undefined, null]) {
    const bus = makeEvents()
    const { p, journal, driver, storage } = rig({
      runId: `run-p4e-off-${escalation === undefined ? 'absent' : 'null'}`,
      steps: [step('q'), step('d', ['q'])],
      scenarios: [
        { name: 'q', match: { prompt: P('q') }, result: [questionDone('没人看的问句')] },
        { name: 'd', match: { prompt: P('d') }, result: [{ status: 'done', text: 'D 完' }] },
      ],
      events: bus.events,
      escalation,
    })
    await until(() => createIds(driver).length >= 1, 'q 初派')
    bus.feed(idleEv())
    await until(() => journal.getStepState('q').state === 'done', '问句产出照 done 收敛')
    await until(() => createIds(driver).length >= 2, '依赖步照常派发')
    bus.feed(idleEv())
    const out = await settle(p)
    assert.equal(out.status, 'completed', `escalation=${String(escalation)} → run completed`)
    assert.equal(out.steps.q.text, JSON.stringify({ question: '没人看的问句' }), 'text 原样保留（不解释）')
    assert.deepEqual(journalEventTypes(storage), [], '零 escalated 审计（识别器根本不启动）')
    ok(`escalation=${escalation === undefined ? '缺省' : 'null'}：done 口径不变、依赖照派、零 escalated`)
  }
}

// ---- 6. blocked 不吃超时；恢复重派重开窗口 ----
console.log('6. 挂起不吃超时（注入时钟）')
{
  const QUESTION = '这个可以等人慢慢答'
  const ANSWER = '答案'
  const RESUME = escalationPrompt(P('q'), QUESTION, ANSWER)
  const bus = makeEvents()
  const clock = manualClock(30_000)
  let armed = false
  const { p, journal, driver, storage, runEvents } = rig({
    runId: 'run-p4e-timeout',
    steps: [step('q', [], { timeoutMs: 1000 })],
    scenarios: [
      { name: 'q', match: { prompt: P('q') }, result: [{ status: 'running' }, questionDone(QUESTION)] },
      { name: 'q-resume', match: { prompt: RESUME }, result: [{ status: 'done', text: 'q 完' }] },
    ],
    now: clock,
    events: bus.events,
    escalation: { answerFor: () => (armed ? ANSWER : null) },
  })
  await until(() => createIds(driver).length >= 1, 'q 初派')
  const ld1 = journal.getStepState('q').lastDispatchAt
  bus.feed(idleEv())
  bus.feed(idleEv())
  await until(() => journal.getStepState('q').state === 'blocked', 'q 挂起')
  clock.advance(5000) // 越过 timeoutMs=1000 五倍
  bus.feed(idleEv())
  bus.feed(idleEv())
  assert.equal(journal.getStepState('q').state, 'blocked', '时钟越过超时窗仍挂起（问句可以等人，不吃兜底）')
  assert.deepEqual(journalEventTypes(storage), ['escalated'], '零 timeout 审计事件')
  assert.ok(!runEvents.some((e) => e.type === 'step-timeout'), '零 step-timeout 广播')
  armed = true
  bus.feed(idleEv()) // 答复在下一轮 loop-top 被拉走 → 恢复重派（排队的旧事件可能让恢复+done 同 tick 完成，故直接等终局）
  const out = await settle(p)
  assert.equal(out.status, 'completed', '恢复后照常完成（窗口重开未被旧时钟误杀）')
  const ld2 = journal.getStepState('q').lastDispatchAt
  assert.ok(ld2 > ld1, `恢复重派刷新 lastDispatchAt（${ld2} > ${ld1}，超时窗口重开）`)
  assert.equal(journal.getStepState('q').attempts, 2, '恢复重派 attempts=2（含初派）')
  assert.deepEqual(createIds(driver), [P('q'), RESUME], '恢复重派恰一次')
  assert.ok(!runEvents.some((e) => e.type === 'step-timeout'), '全程零 step-timeout（挂起+恢复都不吃兜底）')
  ok('blocked 不吃超时兜底；恢复重派重开超时窗口（lastDispatchAt 刷新）')
}

// ---- 7. 恢复派发即败：blocked→dispatching→failed、下游作废、run failed ----
console.log('7. 恢复派发失败（create 抛错）')
{
  const QUESTION = '要人裁决的问句'
  const ANSWER = '答复'
  const bus = makeEvents()
  let createN = 0
  let armed = false
  const driver = fakeDriver({
    create: async () => {
      createN += 1
      if (createN === 1) return { sessionId: 'sess_q1' }
      const e = new Error('恢复重派无场景')
      e.code = 'E1_DRIVER_NO_SCENARIO'
      throw e
    },
    result: async (sessionId) => (sessionId === 'sess_q1' ? questionDone(QUESTION) : { status: 'failed', errorPart: 'unreachable' }),
  })
  const { p, journal, storage, runEvents } = rig({
    runId: 'run-p4e-resume-fail',
    steps: [step('q'), step('d', ['q'])],
    driver,
    events: bus.events,
    escalation: { answerFor: () => (armed ? ANSWER : null) },
  })
  await until(() => createN >= 1, 'q 初派（fake create 第 1 次成功）')
  bus.feed(idleEv())
  await until(() => journal.getStepState('q').state === 'blocked', 'q 挂起')
  armed = true
  bus.feed(idleEv())
  await until(() => journal.getStepState('q').state === 'failed', '恢复重派 create 抛错 → dispatching→failed')
  const out = await settle(p)
  assert.equal(out.status, 'failed', 'run failed（非 blocked：挂起已答复、失败按失败收敛）')
  assert.deepEqual(out.failed, ['q'], 'q failed')
  assert.deepEqual(out.superseded, ['d'], 'q 失败后依赖步 d 未派先废（supersede 闭包语义不变）')
  assert.deepEqual(out.pending, [], '无挂起残留')
  assert.equal(createN, 2, 'create 恰 2 次（初派 + 失败的恢复派发）')
  assert.deepEqual(journalEventTypes(storage), ['escalated', 'escalation-answered'], '台账：escalated + answered 两笔审计在案（失败是派发层的）')
  assert.ok(!runEvents.some((e) => e.type === 'run-blocked'), '连续失败 1 次 < 上限 3，未触熔断')
  ok('恢复派发即败：dispatching→failed、下游 superseded、run failed、熔断未触')
}

// ---- 8. 答复源鲁棒性：抛错/空串/非字符串都本轮跳过，之后恢复恰一次 ----
console.log('8. answerFor 鲁棒性')
{
  const QUESTION = '问句'
  const ANSWER = '最终答复'
  const RESUME = escalationPrompt(P('q'), QUESTION, ANSWER)
  const bus = makeEvents()
  let pulls = 0
  const { p, journal, driver, storage } = rig({
    runId: 'run-p4e-answer-source',
    steps: [step('q')],
    scenarios: [
      { name: 'q', match: { prompt: P('q') }, result: [{ status: 'running' }, questionDone(QUESTION)] },
      { name: 'q-resume', match: { prompt: RESUME }, result: [{ status: 'done', text: 'q 完' }] },
    ],
    events: bus.events,
    escalation: {
      answerFor: () => {
        pulls += 1
        if (pulls === 1) throw new Error('答复源抖了一下')
        if (pulls === 2) return ''
        if (pulls === 3) return 42
        return ANSWER
      },
    },
  })
  await until(() => createIds(driver).length >= 1, 'q 初派')
  bus.feed(idleEv())
  bus.feed(idleEv())
  await until(() => journal.getStepState('q').state === 'blocked', 'q 挂起（第 1 次拉取已抛错跳过）')
  assert.equal(pulls, 1, '挂起当轮已拉过第 1 次（抛错）')
  for (const [n, why] of [
    [2, '空串'],
    [3, '非字符串'],
  ]) {
    bus.feed(idleEv())
    await until(() => pulls >= n, `第 ${n} 次拉取已发生`)
    assert.equal(createIds(driver).length, 1, `第 ${n} 次拉取（${why}）不恢复：零新 create`)
    assert.equal(journal.getStepState('q').state, 'blocked', `第 ${n} 次拉取（${why}）后仍挂起`)
  }
  bus.feed(idleEv())
  await until(() => createIds(driver).length === 2, '第 4 次拉到答复 → 恢复重派恰一次')
  assert.equal(pulls, 4, '答复源恰被拉 4 次')
  assert.deepEqual(createIds(driver), [P('q'), RESUME], '恢复 prompt 恰为 escalationPrompt 组装件')
  bus.feed(idleEv())
  const out = await settle(p)
  assert.equal(out.status, 'completed', '最终答复后 completed')
  assert.deepEqual(journalEventTypes(storage).filter((t) => t === 'escalation-answered').length, 1, 'escalation-answered 恰一笔（答复档答复即删，不重复记账）')
  ok('answerFor：抛错/空串/非字符串逐轮跳过、答复后恢复恰一次、answered 恰一笔')
}

// ---- 9. 参数校验（TypeError = 程序错误，fail-fast）----
console.log('9. escalation 参数校验')
{
  const J = () => createJournal({ storage: memStorage(), runId: 'r', now: manualClock() })
  const D = () => createDriver('mock', { scenarios: [] })
  const good = { runId: 'r', steps: [step('a')] }
  await assert.rejects(run(good, { journal: J(), driver: D(), escalation: 42 }), TypeError, 'escalation 非对象应拒')
  await assert.rejects(run(good, { journal: J(), driver: D(), escalation: 'on' }), TypeError, 'escalation 字符串应拒')
  await assert.rejects(run(good, { journal: J(), driver: D(), escalation: { onEscalate: 'x' } }), TypeError, 'onEscalate 非函数应拒')
  await assert.rejects(run(good, { journal: J(), driver: D(), escalation: { answerFor: 7 } }), TypeError, 'answerFor 非函数应拒')
  ok('escalation 面形状不合法（4 形态）→ TypeError fail-fast')
}

console.log(`\n引擎 P4-E escalation 测试（T4.1 门：挂起/兄弟/恢复 + 分支独立/超时/答复源/参数面）：${passed} 项全过`)
