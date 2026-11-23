// S11.4 fixture：视觉门修复循环（render → judge → repair → 重判 → gate，cap N=1，fail-closed）
// 声明的端到端验证——首个流程 skill 转换（unified-run-plan §S11.4；声明与创作契约落在
// OpenCodeConfig .zcode/skills/declarative-workflows/examples/visual-gate-repair-loop/，
// 本文件是该 skill 的门：声明在引擎两条运行层上的行为断言）。
//
// 夹具：fixtures/engine/skill-visual-gate.json = 上例 declaration.json 逐字节拷贝
//（改任一侧须同步另一侧；纯声明体，喂引擎的文件不带头注）。
//
// 四 leg（协议语义 → 引擎落点的对照表见该 skill §3；此处逐条钉死）：
//   A 已清洁交付 —— judge-1=pass：repair-1 照跑但 no-op（冻结 DAG 无分支，no-op 是拓扑税），
//                   全链 completed、零重派。
//   B 一轮修复后交付 —— judge-1=fix：评审结论是合法产出值，**不触发重派**（judge-1 create 恰 1 次）；
//                   拓扑推进到 repair；run 广播序确定、journal 链合法、engine-owned 会话逐一记账。
//   C cap 耗尽拦下 —— judge-2 仍 fix：gate 产出问句形状（done + JSON 对象 + 非空 question）→
//                   escalation 挂起；notify-only 终局 run blocked(escalation-pending)、
//                   onEscalate 恰一次、盘上 escalated 审计恰 1 条、gate 留 blocked、无 deliver。
//   D schema 验收（typedAsk 层）—— judge-1 第 1 次产出缺 findingsPath → invalid-output 重派
//                   （retryPrompt 附上次错误、非末次无 nudge）→ 第 2 次合格；同一 schema 放行
//                   fix 与 pass 两种评审结论、拒缺 findingsPath——声明里的 schema 是可执行验收契约。
//
// 运行层分工（引擎事实，skill §3）：调度器 run 只按 driver 状态收敛（done 即产出，不逐步做
// schema 验收），问句识别只在 run 的 escalation 选项里——leg A/B/C 走 run；验收与重派在步级
// 核心 typedAsk——leg D 走 typedAsk。
//
// 合成纪律（e1-construction-spec §6）：mock 场景内联全合成，**不引用 fixtures/engine/replay/**
// 录制件（录制件只归 T3.6 replay 半边，前序不得引用）；clock 经构造参数注入（manualClock），
// fault 面（failWrite/driverChaos/abortAt）归引擎自有门，本夹具传 null；禁 monkey-patch、
// 不用随机数。assert 失败即抛、非零退出；成功自然退出。
// sessionId 全 leg 钉死不撞名（mock 合成 id 每 driver 递增，跨代撞名会让 engine-owned 集
// 并成一条——S6/S8 夹具同教训；本文件四 leg 各用独立 tmp storage，另加钉死双保险）。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ASK_NUDGE, retryPrompt, typedAsk } from '../src/engine/ask.js'
import { validateDeclaration, validateValue } from '../src/engine/declaration.js'
import { createDriver } from '../src/engine/driver.js'
import { createJournal, LEGAL_TRANSITIONS, makeJournalStorage } from '../src/engine/journal.js'
import { run } from '../src/engine/scheduler.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)

}

// ---- 夹具装载与形状断言（声明形状即协议形状：判修交替、gate 收尾、问句形状留出口）----
const HERE = dirname(fileURLToPath(import.meta.url))
const declaration = JSON.parse(readFileSync(join(HERE, 'fixtures', 'engine', 'skill-visual-gate.json'), 'utf8'))
const verdict0 = validateDeclaration(declaration)
assert.ok(verdict0.ok, `视觉门声明不合法：${verdict0.errors.join('；')}`)
const stepIds = declaration.steps.map((s) => s.stepId)
assert.deepEqual(stepIds, ['render', 'judge-1', 'repair-1', 'judge-2', 'gate'], 'cap N=1 展开式：render + 判修交替 + gate 收尾（5 步）')
assert.deepEqual(
  declaration.steps.map((s) => s.deps),
  [[], ['render'], ['judge-1'], ['repair-1'], ['judge-2']],
  'deps 链 = 协议循环的展开：判的上游是渲染/修复，gate 的上游是判（不是修）',
)
const stepById = new Map(declaration.steps.map((s) => [s.stepId, s]))
const P = (id) => stepById.get(id).prompt // 场景 match.prompt 单一事实来源 = 夹具声明
const titleOf = (id) => `REEVE-E1 ${declaration.runId} ${id}` // scheduler createArgs 同款锚点
const schemaOf = (id) => stepById.get(id).schema

// schema 验收契约级断言：评审结论是合法产出值（fix 与 pass 同放行），坏格式才拒。
assert.deepEqual(
  validateValue({ verdict: 'fix', findingsPath: '.review/findings-r1.json', hardHits: 2 }, schemaOf('judge-1')),
  { ok: true, errors: [] },
  'judge schema 放行 verdict=fix（评审结论不编码成校验错误）',
)
assert.deepEqual(
  validateValue({ verdict: 'pass', findingsPath: '.review/findings-r1.json', hardHits: 0 }, schemaOf('judge-1')),
  { ok: true, errors: [] },
  'judge schema 放行 verdict=pass',
)
assert.ok(!validateValue({ verdict: 'fix', hardHits: 2 }, schemaOf('judge-1')).ok, 'judge schema 拒缺 findingsPath（坏格式走重派）')
assert.ok(
  validateValue({ verdict: 'blocked', rounds: 2, hardHits: 1, question: '放行带伤交付、追加修复轮还是放弃？' }, schemaOf('gate')).ok,
  'gate schema 留问句形状（fail-closed 的诚实升级出口）',
)
assert.ok(validateValue({ verdict: 'deliver', rounds: 2, hardHits: 0 }, schemaOf('gate')).ok, 'gate schema 放行 deliver 形状')
assert.ok(!validateValue({ verdict: 'deliver', rounds: 2 }, schemaOf('gate')).ok, 'gate schema 拒缺 hardHits（required 收紧）')
assert.ok(!validateValue({ verdict: 'deliver', rounds: 2, hardHits: 0, bogus: 1 }, schemaOf('gate')).ok, 'gate schema 拒未知字段（additionalProperties:false 收紧）')
assert.ok(stepIds.every((id) => stepById.get(id).prompt.length <= 8000), '每拍 prompt ≤ 8000 字符')
assert.ok(stepById.get('render').timeoutMs === 600000, 'render 显式放宽 timeoutMs（渲染慢）')
assert.ok(stepIds.every((id) => stepById.get(id).maxAttempts === undefined), 'maxAttempts 全缺省（=3 含初派）：重派预算不借给评审结论')
ok('夹具形状：5 步判修交替链 + judge/gate schema 的验收契约级性质')

// ---- 夹具基座（全合成，与 pilot-run.mjs 同一套形状）----
const manualClock = (start = 1_700_000_000_000) => {
  let t = start
  const now = () => t
  now.advance = (ms) => {
    t += ms
    return t
  }
  return now
}
const clock = manualClock()
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
const tick = () => new Promise((r) => setTimeout(r, 0))
const until = async (f, label, tries = 4000) => {
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
/** 喂 idle 事件直到 run 终局（事件到达才查；每轮一次 poll）。 */
const driveRun = async (bus, p, label) => {
  let out = null
  const watched = p.then((r) => {
    out = r
    return r
  })
  while (out === null) {
    bus.feed(idleEv())
    await tick()
    await tick()
  }
  await until(() => out !== null, label)
  return await settle(watched)
}
/** mock 场景便捷构造（原 prompt → 单条 done 应答；sessionId 按 leg 钉死）。 */
const sc = (id, text, sessionId) => ({ name: id, match: { prompt: P(id) }, sessionId, result: [{ status: 'done', text }] })
const createPrompts = (driver) => driver.calls.filter((c) => c.op === 'create').map((c) => c.args.prompt)
const opCount = (driver, op) => driver.calls.filter((c) => c.op === op).length
const journalStateOf = (journal, id) => journal.getStepState(id)?.state ?? null
const diskOf = (storage) => JSON.parse(readFileSync(storage.file, 'utf8'))
/** A3 口径机械化：history 链每条边合法、attempts = dispatching 条数、终态与尾条一致。 */
const assertJournalConsistent = (journal, label) => {
  for (const id of stepIds) {
    const known = journal.getStepState(id)
    assert.ok(known, `${label} ${id}: journal 有记账`)
    let prev = null
    let dispatches = 0
    for (const h of known.history) {
      assert.equal(h.from, prev, `${label} ${id}: history 链连续`)
      if (prev === null) assert.equal(h.to, 'declared', `${label} ${id}: 首条必须是播种`)
      else assert.ok((LEGAL_TRANSITIONS[prev] ?? []).includes(h.to), `${label} ${id}: 非法边 ${prev}→${h.to}`)
      if (h.to === 'dispatching') dispatches += 1
      prev = h.to
    }
    assert.equal(known.state, prev, `${label} ${id}: journal 终态与 history 尾条一致`)
    assert.equal(known.attempts, dispatches, `${label} ${id}: attempts = dispatching 条数`)
  }
}
/** 每 leg 通用：恰 5 次按拓扑序派发、prompt 逐字符 = 夹具（无重派变体）、零 context。 */
const assertChainDispatch = (driver, label) => {
  assert.deepEqual(createPrompts(driver), stepIds.map(P), `${label}：create 恰 5 次且按拓扑序、prompt 逐字符 = 夹具（无重派变体）`)
  for (const c of driver.calls.filter((c) => c.op === 'create')) {
    const id = stepIds.find((sid) => P(sid) === c.args.prompt)
    assert.equal(c.args.title, titleOf(id), `${label}：create.title 锚点 ${c.args.title}`)
  }
  assert.ok(createPrompts(driver).every((p) => !p.includes('[reeve ask]')), `${label}：全程零 retryPrompt 前缀（评审结论不触发重派）`)
  assert.equal(opCount(driver, 'context'), 0, `${label}：零 context 调用（夹具不假设 context 形状）`)
}
/** 每 leg 独立 tmp storage + journal（runId 同源；互不污染）。 */
const freshJournal = () => {
  const storage = makeJournalStorage(mkdtempSync(join(tmpdir(), 'reeve-vg-')), declaration.runId)
  return { storage, journal: createJournal({ storage, runId: declaration.runId, now: clock }) }
}

console.log(`S11.4 视觉门修复循环 fixture：runId=${declaration.runId}（${stepIds.length} 步链），driver=mock（全合成，不引用 replay）`)

// ==== leg A：已清洁交付 —— judge-1=pass，repair-1 照跑但 no-op ====
console.log('leg A：已清洁交付（judge-1=pass → repair-1 noop → judge-2=pass → gate=deliver）')
const legA = freshJournal()
const busA = makeEvents()
const driverA = createDriver('mock', {
  scenarios: [
    sc('render', '{"manifestPath":".preview/render-manifest.json","rendered":12,"renderFailed":0}', 'sess_vg_a_render'),
    sc('judge-1', '{"verdict":"pass","findingsPath":".review/findings-r1.json","hardHits":0}', 'sess_vg_a_judge-1'),
    sc('repair-1', '{"action":"noop","editsApplied":0,"findingsPath":".review/findings-r1.json"}', 'sess_vg_a_repair-1'),
    sc('judge-2', '{"verdict":"pass","findingsPath":".review/findings-r2.json","hardHits":0}', 'sess_vg_a_judge-2'),
    sc('gate', '{"verdict":"deliver","rounds":2,"hardHits":0}', 'sess_vg_a_gate'),
  ],
  now: clock,
})
const resultA = await driveRun(
  busA,
  run(declaration, { journal: legA.journal, driver: driverA, cap: 2, now: clock, events: busA.events }),
  'leg A 终局',
)
assert.equal(resultA.status, 'completed', 'leg A：run completed')
assert.deepEqual([resultA.failed, resultA.superseded, resultA.pending], [[], [], []], 'leg A：零失败零作废零悬挂')
assert.deepEqual(resultA.completed, stepIds, 'leg A：五步全 done')
assert.ok(resultA.steps['repair-1'].text.includes('"action":"noop"'), 'leg A：repair-1 照跑（拓扑税）且产出 no-op——声明式没分支，用便宜地跑过替代不跑')
assert.equal(createPrompts(driverA).filter((p) => p === P('repair-1')).length, 1, 'leg A：repair-1 create 恰 1 次（pass 也照跑，靠 no-op 契约省代价）')
assert.deepEqual(
  diskOf(legA.storage).engineSessions,
  ['sess_vg_a_render', 'sess_vg_a_judge-1', 'sess_vg_a_repair-1', 'sess_vg_a_judge-2', 'sess_vg_a_gate'],
  'leg A：engine-owned 会话逐一记账（5 个）',
)
assertJournalConsistent(legA.journal, 'leg A')
assertChainDispatch(driverA, 'leg A')
ok('leg A：已清洁交付（repair-1 拓扑税 + no-op 契约，全链零重派）')

// ==== leg B：一轮修复后交付 —— judge-1=fix 不触发重派，拓扑推进 ====
console.log('leg B：一轮修复后交付（judge-1=fix(2) → repair-1=fixed(2) → judge-2=pass → gate=deliver）')
const legB = freshJournal()
const busB = makeEvents()
const eventsB = []
const driverB = createDriver('mock', {
  scenarios: [
    sc('render', '{"manifestPath":".preview/render-manifest.json","rendered":12,"renderFailed":0}', 'sess_vg_b_render'),
    sc('judge-1', '{"verdict":"fix","findingsPath":".review/findings-r1.json","hardHits":2}', 'sess_vg_b_judge-1'),
    sc('repair-1', '{"action":"fixed","editsApplied":2,"findingsPath":".review/findings-r1.json"}', 'sess_vg_b_repair-1'),
    sc('judge-2', '{"verdict":"pass","findingsPath":".review/findings-r2.json","hardHits":0}', 'sess_vg_b_judge-2'),
    sc('gate', '{"verdict":"deliver","rounds":2,"hardHits":0}', 'sess_vg_b_gate'),
  ],
  now: clock,
})
const resultB = await driveRun(
  busB,
  run(declaration, { journal: legB.journal, driver: driverB, cap: 2, now: clock, events: busB.events, onEvent: (e) => eventsB.push(e) }),
  'leg B 终局',
)
assert.equal(resultB.status, 'completed', 'leg B：run completed')
assert.equal(resultB.steps['judge-1'].state, 'done', 'leg B：judge-1 的 verdict=fix 是合法 done 产出（步不失败）')
assert.ok(resultB.steps['judge-1'].text.includes('"verdict":"fix"'), 'leg B：fix 结论原样进 journal（不冒泡丢失）')
assert.equal(createPrompts(driverB).filter((p) => p === P('judge-1')).length, 1, 'leg B：judge-1 create 恰 1 次——评审结论 fix 未触发重派（重派只由 schema 校验失败触发）')
assert.deepEqual(eventsB.map((e) => `${e.type}${e.stepId ? `:${e.stepId}` : ''}`), [
  'dispatch:render', 'step-done:render',
  'dispatch:judge-1', 'step-done:judge-1',
  'dispatch:repair-1', 'step-done:repair-1',
  'dispatch:judge-2', 'step-done:judge-2',
  'dispatch:gate', 'step-done:gate',
  'run-completed',
], 'leg B：run 广播序确定（逐拍 dispatch/step-done + 终局一次）')
assert.deepEqual(diskOf(legB.storage).engineSessions, ['sess_vg_b_render', 'sess_vg_b_judge-1', 'sess_vg_b_repair-1', 'sess_vg_b_judge-2', 'sess_vg_b_gate'], 'leg B：engine-owned 会话逐一记账')
assertJournalConsistent(legB.journal, 'leg B')
assertChainDispatch(driverB, 'leg B')
ok('leg B：一轮修复后交付（fix 结论零重派 + 广播序 + journal 链合法）')

// ==== leg C：cap 耗尽拦下 —— gate 产问句 → escalation 挂起 → notify-only 终局 blocked ====
console.log('leg C：cap 耗尽拦下（judge-2 仍 fix → gate=blocked+question → escalation-pending）')
const QUESTION_C = '第 2 轮重判仍有 1 条硬伤（p07 H3 文本重叠，修复与既有布局约束冲突）。请裁决：A 放行带伤交付并记录取舍；B 追加一轮修复（需以运行中交接 hole 交入新声明）；C 放弃本次交付。'
const legC = freshJournal()
const busC = makeEvents()
const escalationsC = []
const driverC = createDriver('mock', {
  scenarios: [
    sc('render', '{"manifestPath":".preview/render-manifest.json","rendered":12,"renderFailed":0}', 'sess_vg_c_render'),
    sc('judge-1', '{"verdict":"fix","findingsPath":".review/findings-r1.json","hardHits":2}', 'sess_vg_c_judge-1'),
    sc('repair-1', '{"action":"fixed","editsApplied":2,"findingsPath":".review/findings-r1.json"}', 'sess_vg_c_repair-1'),
    sc('judge-2', '{"verdict":"fix","findingsPath":".review/findings-r2.json","hardHits":1}', 'sess_vg_c_judge-2'),
    { name: 'gate', match: { prompt: P('gate') }, sessionId: 'sess_vg_c_gate', result: [{ status: 'done', text: `{"verdict":"blocked","rounds":2,"hardHits":1,"question":${JSON.stringify(QUESTION_C)}}` }] },
  ],
  now: clock,
})
const resultC = await driveRun(
  busC,
  run(declaration, {
    journal: legC.journal,
    driver: driverC,
    cap: 2,
    now: clock,
    events: busC.events,
    escalation: { onEscalate: (record) => escalationsC.push(record) }, // notify-only：不配 answerFor
  }),
  'leg C 终局',
)
assert.equal(resultC.status, 'blocked', 'leg C：fail-closed——run blocked，不 completed')
assert.equal(resultC.reason, 'escalation-pending', 'leg C：终局 reason = escalation-pending')
assert.deepEqual(resultC.escalation, [{ stepId: 'gate', question: QUESTION_C }], 'leg C：挂起步与问句逐字回流')
assert.equal(escalationsC.length, 1, 'leg C：onEscalate 恰一次')
assert.equal(escalationsC[0].kind, 'escalation', 'leg C：record.kind = escalation')
assert.equal(escalationsC[0].runId, declaration.runId, 'leg C：record.runId 同 run')
assert.equal(escalationsC[0].sessionId, 'sess_vg_c_gate', 'leg C：record.sessionId 挂问句会话')
assert.equal(journalStateOf(legC.journal, 'gate'), 'blocked', 'leg C：gate 留 blocked（等人；blocked 不吃超时兜底）')
assert.deepEqual(['render', 'judge-1', 'repair-1', 'judge-2'].map((id) => journalStateOf(legC.journal, id)), ['done', 'done', 'done', 'done'], 'leg C：前四拍 done')
assert.deepEqual(legC.journal.getStepState('gate').history.at(-1).payload, { question: QUESTION_C, sessionId: 'sess_vg_c_gate' }, 'leg C：blocked 记账 payload 带问句与会话（无 deliver 冒泡——挂起步不进 steps.text）')
const escalatedC = diskOf(legC.storage).events.filter((e) => e.type === 'escalated')
assert.equal(escalatedC.length, 1, 'leg C：盘上 escalated 审计恰 1 条')
assert.deepEqual(escalatedC[0].payload, { stepId: 'gate', question: QUESTION_C, sessionId: 'sess_vg_c_gate' }, 'leg C：escalated payload 完整（stepId/question/sessionId）')
assert.deepEqual(
  diskOf(legC.storage).engineSessions,
  ['sess_vg_c_render', 'sess_vg_c_judge-1', 'sess_vg_c_repair-1', 'sess_vg_c_judge-2', 'sess_vg_c_gate'],
  'leg C：engine-owned 会话逐一记账',
)
assertChainDispatch(driverC, 'leg C')
assertJournalConsistent(legC.journal, 'leg C')
ok('leg C：cap 耗尽拦下（问句挂起 + escalation-pending 终局 + 零 deliver）')

// ==== leg D：schema 验收（typedAsk 层）——坏格式重派、retryPrompt 逐字符、nudge 口径 ====
console.log('leg D：schema 验收（typedAsk：judge-1 缺 findingsPath → 重派附错 → 第 2 次合格）')
const BAD_JUDGE = '{"verdict":"fix","hardHits":2}' // 缺 findingsPath → validateValue 恒报同一缺失
const ERR_JUDGE = '产出: 缺失必填字段 "findingsPath"' // declaration.js walkSchema 的 required 报错原文（rootLabel=产出）
const RP_JUDGE2 = retryPrompt(P('judge-1'), [ERR_JUDGE], { attempt: 2, maxAttempts: 3 }) // 非末次 → 无 nudge
const GOOD_JUDGE = '{"verdict":"fix","findingsPath":".review/findings-r1.json","hardHits":2}'
const driverD = createDriver('mock', {
  scenarios: [
    { name: 'judge-1#1', match: { prompt: P('judge-1') }, sessionId: 'sess_vg_d_judge1_try1', result: [{ status: 'done', text: BAD_JUDGE }] },
    { name: 'judge-1#2', match: { prompt: RP_JUDGE2 }, sessionId: 'sess_vg_d_judge1_try2', result: [{ status: 'done', text: GOOD_JUDGE }] },
  ],
  now: clock,
})
const outD = await typedAsk(driverD, stepById.get('judge-1'), { title: titleOf('judge-1'), now: clock })
assert.equal(outD.ok, true, 'leg D：第 2 次尝试合格收敛')
assert.deepEqual([outD.attempts, outD.value], [2, { verdict: 'fix', findingsPath: '.review/findings-r1.json', hardHits: 2 }], 'leg D：attempts=2、value = 解析后产出（verdict=fix 合法放行）')
assert.deepEqual(createPrompts(driverD), [P('judge-1'), RP_JUDGE2], 'leg D：重派 prompt 逐字符 = retryPrompt 导出件（单一事实来源）')
assert.ok(RP_JUDGE2.includes(ERR_JUDGE), 'leg D：重派附上一次校验错误')
assert.equal(RP_JUDGE2.split(ASK_NUDGE).length - 1, 0, 'leg D：第 2 次重派（非末次）无 nudge')
ok('leg D：schema 验收（坏格式走重派机器循环，与评审结论的人裁决通道分轨）')

// ==== 终局收口 ====
console.log('终局收口')
assert.equal(stepIds.length, 5, 'cap N=1 展开式共 5 步（声明未变，四 leg 跑的是同一张声明）')
console.log(`\nS11.4 视觉门修复循环 fixture（四 leg）：${passed} 项全过`)
