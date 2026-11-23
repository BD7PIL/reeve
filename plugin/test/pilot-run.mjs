// E1 试点运行器（S8；施工规格 .zcode/plans/e1-construction-spec.md §5-T3.7 / §3 / §6，
// 主计划 plan-gate-and-declarative-engine.md P3 决策点「试点三数」）。
//
// 职责：把合成 job（fixtures/engine/pilot-job.json，6 步菱形 DAG）在 mock driver 上跑完
// 整个生命周期——两处 abortAt 中途崩溃（pilot-job.fault.json）+ 两次 resume 恢复——并采集
// 决策点三数，报告落 .zcode/plans/evidence/pilot-report.md，journal 盘上记录落
// pilot-journal.json（取证片段进 .zcode/plans/evidence/，不进公开树）。
//
// 生命周期（四段 leg；恢复接线 = S6 engine-resume.test.mjs 的 redrive 夹具同一套，规格
// resume.js 头注「S8 试点沿用同一套接线」）：
//   A 初跑    scheduler run × fault.abortAt=[merge] → 崩（E1_ENGINE_ABORT）：
//             intake/plan-a/plan-b done，merge 停 dispatching（dispatching 落盘后、create 前崩）。
//   B 恢复一  resume → completed=崩前三步 / pending=[merge,verify,publish]；redrive(merge)：
//             quiesce（dispatching→failed）→ cooldown（注入时钟推过末次派发 +60s）→ 重入边
//             （failed→dispatching）→ typedAsk。mock 脚本：第 1 次子会话瞬态失败、第 2 次 done。
//   C 续跑    scheduler run（同 journal，verify/publish 仍 declared 可接）× abortAt=[publish] → 崩。
//   D 恢复二  resume → redrive(publish)：typedAsk 三次产出均缺 artifact 字段 → invalid-output
//             耗尽 → escalation 恰一次（onEscalate + journal escalate 台账）→ publish failed 终局。
//
// 三数口径（报告同文；全部从引擎产物取数，不手填）：
//   ① 需人工裁决的分支事件数 = 盘上 journal events type ∈ {escalate, run-blocked} 条数
//      + scheduler step-failed/step-timeout 广播条数（本生命周期 escalate=1，其余 0）。
//   ② 中断后 resume+journal 无损恢复比例 = 「无损」循环数 / 崩溃循环总数。单个循环无损判据：
//      (a) resume 的 completed 集与崩前 done 集一致且 payload 分毫未动；(b) 恢复代 driver 对
//      已完成步零 create（calls 取数）；(c) journal history 链全合法。
//   ③ hole 诉求出现次数 = 运行终局时「声明要求的步未达成 且 同声明自动机制已耗尽」的步数
//      （typedAsk maxAttempts 重派已证同一 prompt 无出路；failed 重入边只能重派同一 prompt
//      → 达成目标只剩「运行中交新声明」一条路，即 P4 hole 的诉求场景）。
//
// 合成纪律（规格 §6）：夹具全合成；不引用 fixtures/engine/replay/ 录制件（S7a 产物只归
// T3.6 replay 半边）；mock 场景的 match.prompt 用实现导出的 retryPrompt 计算（单一事实来源）。
// clock/fault 经构造参数注入（manualClock + fault.abortAt），禁 monkey-patch、不用随机数。
// assert 失败即抛、非零退出；成功自然退出并刷新证据文件。
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ASK_NUDGE, retryPrompt, typedAsk } from '../src/engine/ask.js'
import { validateDeclaration } from '../src/engine/declaration.js'
import { createDriver } from '../src/engine/driver.js'
import { LEGAL_TRANSITIONS, createJournal, makeJournalStorage } from '../src/engine/journal.js'
import { resume } from '../src/engine/resume.js'
import { ABORT_CODE, run } from '../src/engine/scheduler.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- 证据落点（.zcode/ 被 .gitignore 排除，不进公开树；主计划 T3.7「取证片段存 evidence」）----
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const EVIDENCE_DIR = join(REPO_ROOT, '.zcode', 'plans', 'evidence')
const REPORT_PATH = join(EVIDENCE_DIR, 'pilot-report.md')
const JOURNAL_COPY_PATH = join(EVIDENCE_DIR, 'pilot-journal.json')

// ---- 夹具装载与前置校验（T3.7：合成 job ≥5 步、2 个 abortAt 注入点）----
const declaration = JSON.parse(readFileSync(join(HERE, 'fixtures', 'engine', 'pilot-job.json'), 'utf8'))
const faultSpec = JSON.parse(readFileSync(join(HERE, 'fixtures', 'engine', 'pilot-job.fault.json'), 'utf8'))
const verdict = validateDeclaration(declaration)
assert.ok(verdict.ok, `试点声明不合法：${verdict.errors.join('；')}`)
assert.ok(declaration.steps.length >= 5, `试点声明 ≥5 步（得到 ${declaration.steps.length}）`)
assert.ok(Array.isArray(faultSpec.abortAt) && faultSpec.abortAt.length === 2, 'sidecar 恰 2 个 abortAt 注入点')
const stepIds = declaration.steps.map((s) => s.stepId)
for (const at of faultSpec.abortAt) {
  assert.ok(stepIds.includes(at), `abortAt 注入点 "${at}" 必须是声明内 stepId`)
}
const [ABORT1, ABORT2] = faultSpec.abortAt
const stepById = new Map(declaration.steps.map((s) => [s.stepId, s]))
const P = (id) => stepById.get(id).prompt // 场景 match.prompt 单一事实来源 = 夹具声明
const titleOf = (id) => `REEVE-E1 ${declaration.runId} ${id}` // scheduler createArgs 同款锚点（§2-1）
const COOLDOWN_MS = 60_000 // §1：同 step 两次 dispatch 间隔 cooldown（接线纪律；引擎内不强制）

// ---- 夹具基座（全合成，与 engine-resume.test.mjs 同一套形状）----
const manualClock = (start = 1_700_000_000_000) => {
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
/** 喂 idle 直到条件成立（事件驱动重轮询；每轮一次 poll）。 */
const driveIdle = async (bus, f, label) => {
  while (!f()) {
    bus.feed(idleEv())
    await tick()
    await tick()
  }
  await until(f, label)
}
/** mock 场景便捷构造（原 prompt → 单条 done 应答；sessionId 逐 leg 钉死——mock 合成 id 是
    每 driver 从 1 递增的，跨代撞名会让 engine-owned 集把不同会话并成一条，S6 夹具同教训）。 */
const sc = (id, text, sessionId) => ({ name: id, match: { prompt: P(id) }, sessionId, result: [{ status: 'done', text }] })
const createPrompts = (driver) => driver.calls.filter((c) => c.op === 'create').map((c) => c.args.prompt)
const opCount = (driver, op) => driver.calls.filter((c) => c.op === op).length

/** A3 口径机械化：逐步校验 history 链每条边合法、attempts = dispatching 条数、终态与尾条一致。 */
const assertJournalConsistent = (journal, decl, label) => {
  for (const stepOfDecl of decl.steps) {
    const id = stepOfDecl.stepId
    const known = journal.getStepState(id)
    assert.ok(known, `${label} ${id}: journal 有记账`)
    let prev = null
    let dispatches = 0
    for (const h of known.history) {
      assert.equal(h.from, prev, `${label} ${id}: history 链连续（记账 ${prev} → 条目 ${h.from}→${h.to}）`)
      if (prev === null) assert.equal(h.to, 'declared', `${label} ${id}: 首条必须是播种`)
      else assert.ok((LEGAL_TRANSITIONS[prev] ?? []).includes(h.to), `${label} ${id}: 非法边 ${prev}→${h.to}`)
      if (h.to === 'dispatching') dispatches += 1
      prev = h.to
    }
    assert.equal(known.state, prev, `${label} ${id}: journal 终态与 history 尾条一致`)
    assert.equal(known.attempts, dispatches, `${label} ${id}: attempts = dispatching 条数`)
  }
}

/**
 * 恢复接线（S6 redrive 夹具的 S8 同款 + escalation 台账）：
 * 未播种 → 播种；在飞 → quiesce 到 failed；failed → cooldown 后走重入边；declared → 初派。
 * 然后 typedAsk 跑到终态；成功回写 markEngineSession→running→done；失败落 escalate 台账事件
 * （规格 §3 ask：「escalation 走 onEscalate 回调（P4 接面板，E1 先落 journal blocked + 台账）」）
 * + dispatching→failed。每次写检查 ok——先落盘再动作，写被拒即停、零派发。
 */
async function redrive(declaration, journal, driver, pendingIds, now) {
  const byId = new Map(declaration.steps.map((s) => [s.stepId, s]))
  const outcomes = []
  const escalations = []
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
      if (Number.isFinite(last) && now() - last < COOLDOWN_MS && typeof now.advance === 'function') {
        now.advance(last + COOLDOWN_MS + 1 - now())
      }
      must(journal.appendStepState(stepId, 'failed', 'dispatching'), `重入边 ${stepId}（failed→dispatching）`)
    } else {
      must(journal.appendStepState(stepId, 'declared', 'dispatching'), `初派 ${stepId}（declared→dispatching）`)
    }
    const out = await typedAsk(driver, stepOfDecl, {
      title: titleOf(stepId),
      now,
      onEscalate: (outcome) => escalations.push(outcome), // 恰一次；引用同 outcome
    })
    if (!out.ok) {
      must(journal.recordEvent('escalate', { stepId, reason: out.reason, attempts: out.attempts }), `escalate 台账 ${stepId}`)
      must(journal.appendStepState(stepId, 'dispatching', 'failed', { error: { reason: out.reason } }), `失败记账 ${stepId}`)
      outcomes.push({ stepId, ok: false, outcome: out })
      continue
    }
    must(journal.markEngineSession(out.sessionId), `engine-owned 记账 ${stepId}`)
    must(journal.appendStepState(stepId, 'dispatching', 'running', { sessionId: out.sessionId }), `running 记账 ${stepId}`)
    must(journal.appendStepState(stepId, 'running', 'done', { result: { text: out.text }, sessionId: out.sessionId }), `done 记账 ${stepId}`)
    outcomes.push({ stepId, ok: true, text: out.text, sessionId: out.sessionId, attempts: out.attempts })
  }
  return { outcomes, escalations }
}

// ---- 组装：注入时钟 + 真实形状的 journal storage（tmp 落地，终局拷贝进 evidence）----
assert.ok(existsSync(join(REPO_ROOT, 'plugin', 'package.json')), 'REPO_ROOT 定位失败（应有 plugin/package.json）')
const workDir = mkdtempSync(join(tmpdir(), 'reeve-pilot-'))
const storage = makeJournalStorage(workDir, declaration.runId)
const clock = manualClock()
const journalBroadcasts = []
const journal = createJournal({ storage, runId: declaration.runId, now: clock, onEvent: (e) => journalBroadcasts.push(e) })

console.log(`E1 试点（S8/T3.7）：job=${declaration.runId}（${declaration.steps.length} 步），abortAt=[${ABORT1}, ${ABORT2}]，driver=mock（全合成）`)

// ==== leg A：初跑 → abortAt=[merge] 崩（dispatching 落盘后、create 前）====
console.log(`leg A：初跑（scheduler × fault.abortAt=[${ABORT1}]）`)
const eventsA = []
const busA = makeEvents()
const driverA = createDriver('mock', {
  scenarios: [
    sc('intake', '{"intakeId":"IN-2026-1122"}', 'sess_pilot_a_intake'),
    sc('plan-a', '{"planId":"PLAN-A"}', 'sess_pilot_a_plan-a'),
    sc('plan-b', '{"planId":"PLAN-B"}', 'sess_pilot_a_plan-b'),
  ],
  now: clock,
})
const pA = run(declaration, { journal, driver: driverA, cap: 2, fault: { abortAt: [ABORT1] }, now: clock, events: busA.events, onEvent: (e) => eventsA.push(e) })
const crashedA = assert.rejects(settle(pA), (e) => e.code === ABORT_CODE && e.message.includes(`"${ABORT1}"`), `abortAt 命中 ${ABORT1}（E1_ENGINE_ABORT）`)
await driveIdle(busA, () => journal.getStepState(ABORT1)?.state === 'dispatching', `${ABORT1} 入崩位`)
await crashedA
const stateOf = (id) => journal.getStepState(id)?.state ?? null
assert.deepEqual(
  [stateOf('intake'), stateOf('plan-a'), stateOf('plan-b'), stateOf(ABORT1), stateOf('verify'), stateOf('publish')],
  ['done', 'done', 'done', 'dispatching', 'declared', 'declared'],
  '崩前现场：三分支 done、崩位 dispatching、后缀 declared',
)
const byStep = {}
for (const e of eventsA) {
  const key = e.stepId ?? '(run)'
  if (byStep[key] === undefined) byStep[key] = []
  byStep[key].push(e.type)
}
assert.deepEqual(byStep.intake, ['dispatch', 'step-done'], 'intake：派发+完成各恰 1')
assert.deepEqual(byStep['plan-a'], ['dispatch', 'step-done'], 'plan-a：派发+完成各恰 1（兄弟分支 A）')
assert.deepEqual(byStep['plan-b'], ['dispatch', 'step-done'], 'plan-b：派发+完成各恰 1（兄弟分支 B）')
assert.equal(byStep[ABORT1], undefined, '崩位无事件（崩在 dispatching 落盘后、create 前）')
assert.equal(eventsA.length, 6, '崩溃后无终局广播（先落盘再广播的面一致）')
assert.deepEqual(createPrompts(driverA), [P('intake'), P('plan-a'), P('plan-b')], 'driverA 恰派三分支（cap=2 内并发）')
for (const c of driverA.calls.filter((c) => c.op === 'create')) {
  const id = stepIds.find((id) => P(id) === c.args.prompt)
  assert.equal(c.args.title, titleOf(id), `create.title 锚点 ${c.args.title}`)
}
assert.equal(opCount(driverA, 'context'), 0, '零 context 调用（§2-2：context 形状未验证，试点不假设）')
const crash1Resume = resume(declaration, journal)
const crash1Completed = [...crash1Resume.completed.entries()]
assert.deepEqual([...crash1Resume.completed.keys()], ['intake', 'plan-a', 'plan-b'], 'resume：completed = 崩前 done 集')
assert.deepEqual(crash1Resume.pending, [ABORT1, 'verify', 'publish'], 'resume：pending = 崩位 + 后缀（声明序）')
ok(`leg A：${ABORT1} 崩（E1_ENGINE_ABORT）+ 崩前三分支 done + resume 分类精确`)

// ==== leg B：恢复一 → redrive(merge)，mock 瞬态失败 1 次 → 重派成功 ====
console.log(`leg B：恢复一（resume + redrive(${ABORT1})：瞬态失败 → 重派成功）`)
const EP_MERGE = '合成瞬态故障：merge 工具暂不可用'
const ERR_MERGE = `子会话失败：${EP_MERGE}`
const RP_MERGE2 = retryPrompt(P(ABORT1), [ERR_MERGE], { attempt: 2, maxAttempts: 3 }) // 第 2 次 ≠ 末次 → 无 nudge
const driverB = createDriver('mock', {
  scenarios: [
    { name: 'merge#1', match: { prompt: P(ABORT1) }, sessionId: 'sess_pilot_b_merge_try1', result: [{ status: 'failed', errorPart: EP_MERGE }] },
    { name: 'merge#2', match: { prompt: RP_MERGE2 }, sessionId: 'sess_pilot_b_merge_try2', result: [{ status: 'done', text: '{"merged":true}' }] },
  ],
  now: clock,
})
const legB = await redrive(declaration, journal, driverB, [ABORT1], clock)
assert.deepEqual(legB.outcomes, [{ stepId: ABORT1, ok: true, text: '{"merged":true}', sessionId: 'sess_pilot_b_merge_try2', attempts: 2 }], `${ABORT1} 重派成功（attempts=2：瞬态失败 + 成功，新会话）`)
assert.deepEqual(legB.escalations, [], '恢复成功 → 零 escalation')
assert.deepEqual(createPrompts(driverB), [P(ABORT1), RP_MERGE2], '重派 prompt 逐字符 = retryPrompt（单一事实来源）')
assert.ok(!RP_MERGE2.includes(ASK_NUDGE), '第 2 次重派（非末次）无 nudge')
assert.equal(opCount(driverB, 'context'), 0, '零 context 调用')
for (const id of ['intake', 'plan-a', 'plan-b']) {
  assert.equal(createPrompts(driverB).filter((p) => p === P(id)).length, 0, `A1：已完成步 ${id} 重跑侧零 create`)
}
assert.equal(stateOf(ABORT1), 'done', `${ABORT1} done`)
assert.deepEqual([journal.getStepState(ABORT1).attempts, journal.getStepState(ABORT1).history.length], [2, 6], `${ABORT1} 记账：播种/初派/quiesce/重入/入飞/完成`)
assert.deepEqual(journal.getStepState(ABORT1).history[2].payload, { reason: 'resume', detail: 'mid-flight at crash' }, 'quiesce payload 记 resume 事实')
assert.equal(stateOf('verify'), 'declared', '后缀保持 declared（可被下一 leg 的 scheduler 接走）')
ok(`leg B：${ABORT1} 无损恢复（瞬态失败重派成功 + 已完成步零 create + 后缀 declared 可续）`)

// ==== leg C：续跑（同 journal）→ abortAt=[publish] 崩 ====
console.log(`leg C：续跑（scheduler × fault.abortAt=[${ABORT2}]）`)
const eventsC = []
const busC = makeEvents()
const driverC = createDriver('mock', { scenarios: [sc('verify', '{"verdict":"pass"}', 'sess_pilot_c_verify')], now: clock })
const pC = run(declaration, { journal, driver: driverC, cap: 2, fault: { abortAt: [ABORT2] }, now: clock, events: busC.events, onEvent: (e) => eventsC.push(e) })
const crashedC = assert.rejects(settle(pC), (e) => e.code === ABORT_CODE && e.message.includes(`"${ABORT2}"`), `abortAt 命中 ${ABORT2}`)
await driveIdle(busC, () => journal.getStepState(ABORT2)?.state === 'dispatching', `${ABORT2} 入崩位`)
await crashedC
assert.deepEqual([stateOf('verify'), stateOf(ABORT2)], ['done', 'dispatching'], 'verify 完成、崩位 dispatching')
assert.deepEqual(
  eventsC.map((e) => [e.type, e.stepId]),
  [['dispatch', 'verify'], ['step-done', 'verify']],
  '本 leg 恰 verify 的派发+完成（declared/done 续跑不重播历史步）',
)
assert.deepEqual(createPrompts(driverC), [P('verify')], 'driverC 恰派 verify')
const crash2Resume = resume(declaration, journal)
const crash2Completed = [...crash2Resume.completed.entries()]
assert.deepEqual([...crash2Resume.completed.keys()], ['intake', 'plan-a', 'plan-b', ABORT1, 'verify'], 'resume：completed = 崩前 done 五步')
assert.deepEqual(crash2Resume.pending, [ABORT2], 'resume：pending = 崩位')
ok(`leg C：${ABORT2} 崩 + verify 经 scheduler 续跑完成 + resume 分类精确`)

// ==== leg D：恢复二 → redrive(publish)，三次产出均缺字段 → 耗尽 → escalation ====
console.log(`leg D：恢复二（resume + redrive(${ABORT2})：3 次产出不过 schema → 耗尽 → escalation）`)
const BAD_PUBLISH = '{"decision":"ship"}' // 缺 artifact → validateValue 恒报同一缺失（跨 Node 版本确定）
const ERR_PUBLISH = '产出: 缺失必填字段 "artifact"' // declaration.js walkSchema 的 required 报错原文
const RP_PUBLISH2 = retryPrompt(P(ABORT2), [ERR_PUBLISH], { attempt: 2, maxAttempts: 3 })
const RP_PUBLISH3 = retryPrompt(P(ABORT2), [ERR_PUBLISH], { attempt: 3, maxAttempts: 3 }) // 末次重派 → 带 nudge
const driverD = createDriver('mock', {
  scenarios: [
    { name: 'publish#1', match: { prompt: P(ABORT2) }, sessionId: 'sess_pilot_d_publish_try1', result: [{ status: 'done', text: BAD_PUBLISH }] },
    { name: 'publish#2', match: { prompt: RP_PUBLISH2 }, sessionId: 'sess_pilot_d_publish_try2', result: [{ status: 'done', text: BAD_PUBLISH }] },
    { name: 'publish#3', match: { prompt: RP_PUBLISH3 }, sessionId: 'sess_pilot_d_publish_try3', result: [{ status: 'done', text: BAD_PUBLISH }] },
  ],
  now: clock,
})
const legD = await redrive(declaration, journal, driverD, [ABORT2], clock)
assert.equal(legD.outcomes.length, 1, '恰一步收敛')
const outcome = legD.outcomes[0].outcome
assert.deepEqual([legD.outcomes[0].stepId, legD.outcomes[0].ok], [ABORT2, false], `${ABORT2} 收敛失败`)
assert.deepEqual([outcome.reason, outcome.attempts], ['invalid-output', 3], '耗尽口径：reason=invalid-output、attempts=3（含初派）')
assert.deepEqual(outcome.errors, [ERR_PUBLISH], 'outcome.errors 附最后一次校验错误')
assert.ok(!('value' in outcome) && !('text' in outcome), '失败 outcome 不冒泡假结果（无 value/text）')
assert.deepEqual(legD.escalations, [outcome], 'onEscalate 恰一次且收到同一 outcome 引用')
assert.deepEqual(createPrompts(driverD), [P(ABORT2), RP_PUBLISH2, RP_PUBLISH3], 'create 恰 3 次：初派 1 + 重派 2（prompt 逐字符 = retryPrompt）')
assert.equal(RP_PUBLISH2.split(ASK_NUDGE).length - 1, 0, '第 2 次重派无 nudge')
assert.equal(RP_PUBLISH3.split(ASK_NUDGE).length - 1, 1, 'nudge 恰 1 次且在第 2 次重派（末次）')
assert.ok(RP_PUBLISH2.includes(ERR_PUBLISH) && RP_PUBLISH3.includes(ERR_PUBLISH), '每次重派附上一次校验错误')
assert.equal(stateOf(ABORT2), 'failed', `${ABORT2} failed 终局`)
assert.deepEqual([journal.getStepState(ABORT2).attempts, journal.getStepState(ABORT2).history.length], [2, 5], `${ABORT2} 记账：播种/初派/quiesce/重入/失败（5 条全合法）`)
ok(`leg D：${ABORT2} 三修耗尽 → escalation 恰 1 次 → failed 终局（不冒泡假结果）`)

// ==== 终局对账：journal 一致 + resume 终读 + 三数采集 ====
console.log('终局对账与三数采集')
assertJournalConsistent(journal, declaration, '终局')
assert.equal(opCount(driverD, 'context') + opCount(driverB, 'context') + opCount(driverA, 'context') + opCount(driverC, 'context'), 0, '全程零 context 调用')
// A1 终读：resume 的 completed 与两次崩时快照 payload 分毫未动（journal 返还的字节级无损）。
const finalResume = resume(declaration, journal)
for (const [id, payload] of crash1Completed) assert.deepEqual(finalResume.completed.get(id), payload, `无损①：${id} 的 done payload 自崩前分毫未动`)
for (const [id, payload] of crash2Completed) assert.deepEqual(finalResume.completed.get(id), payload, `无损②：${id} 的 done payload 自崩前分毫未动`)
assert.deepEqual([...finalResume.completed.keys()].sort(), ['intake', 'merge', 'plan-a', 'plan-b', 'verify'].sort(), '终局 completed = 五步')
assert.deepEqual(finalResume.pending, [ABORT2], `终局 pending = ${ABORT2}（escalation 终局）`)
// 三数①：人工裁决分支事件数 = 盘上 journal 事件（escalate/run-blocked）+ scheduler 步失败广播。
const diskRecord = JSON.parse(readFileSync(storage.file, 'utf8'))
const diskEvents = diskRecord.events
const adjudicationFromJournal = diskEvents.filter((e) => ['escalate', 'run-blocked'].includes(e.type)).length
const schedulerFailBroadcasts = [...eventsA, ...eventsC].filter((e) => ['step-failed', 'step-timeout'].includes(e.type)).length
const adjudicationBranchEvents = adjudicationFromJournal + schedulerFailBroadcasts
assert.deepEqual(diskEvents.map((e) => e.type), ['escalate'], '盘上事件恰 1 条 escalate 台账')
assert.deepEqual(diskEvents[0].payload, { stepId: ABORT2, reason: 'invalid-output', attempts: 3 }, 'escalate 台账 payload 完整')
// engine-owned 集：恰 5 个成功派发会话（legA 三分支 + legB 重派 + legC verify；失败尝试不记账），
// 且全装载域无撞名（mock 合成 id 每 driver 递增，跨代必须钉死 sessionId——S6 夹具同教训）。
assert.deepEqual(
  diskRecord.engineSessions,
  ['sess_pilot_a_intake', 'sess_pilot_a_plan-a', 'sess_pilot_a_plan-b', 'sess_pilot_b_merge_try2', 'sess_pilot_c_verify'],
  'engine-owned 会话逐一对账（5 个成功派发会话）',
)
assert.equal(new Set(diskRecord.engineSessions).size, diskRecord.engineSessions.length, 'engine-owned 集无跨代撞名')
assert.equal(adjudicationBranchEvents, 1, '① 人工裁决分支事件数 = 1（publish 的 escalation）')
// 三数②：resume 无损恢复比例（判据见头注；两个循环逐条核）。
const resumeCycles = 2
let losslessCycles = 0
for (const [cycleId, snap, driver, doneBefore] of [
  [`循环1(abort@${ABORT1})`, crash1Completed, driverB, ['intake', 'plan-a', 'plan-b']],
  [`循环2(abort@${ABORT2})`, crash2Completed, driverD, ['intake', 'plan-a', 'plan-b', ABORT1, 'verify']],
]) {
  const recovered = snap.every(([id, payload]) => assert.deepEqual(finalResume.completed.get(id), payload, `${cycleId}：${id} payload 无损`) === undefined)
  const zeroCreate = doneBefore.every((id) => !createPrompts(driver).includes(P(id)))
  const chainLegal = doneBefore.every((id) => journal.getStepState(id).state === 'done')
  if (recovered && zeroCreate && chainLegal) losslessCycles += 1
}
assert.equal(losslessCycles, resumeCycles, '② 两个崩溃循环均无损（payload 字节级 + 零 create + 链合法）')
// 三数③：hole 诉求 = 终局未达成 且 同声明自动机制已耗尽的步。
const maxAttemptsOf = (id) => stepById.get(id).maxAttempts ?? 3
const exhaustedNonDone = finalResume.pending.filter((id) => {
  const outcomeOfStep = legD.outcomes.find((o) => o.stepId === id && !o.ok)
  return outcomeOfStep !== undefined && outcomeOfStep.outcome.attempts >= maxAttemptsOf(id)
})
assert.deepEqual(exhaustedNonDone, [ABORT2], `③ hole 诉求 = ${ABORT2}（终局未达成 + typedAsk ${maxAttemptsOf(ABORT2)}/${maxAttemptsOf(ABORT2)} 耗尽）`)
// 三数齐了。P4 缺省映射（主计划 P3 决策点原文）：①≥1→escalation 第一；②<100%→resume 强化先于 hole；③≥1→hole 第二、amend 末位。
const p4Order =
  adjudicationBranchEvents >= 1 && losslessCycles / resumeCycles < 1 ? 'escalation → resume 强化 → hole → amend'
  : adjudicationBranchEvents >= 1 ? 'escalation → hole → amend'
  : '（①=0 → escalation 不前置；按主计划缺省序裁决）'
assert.equal(adjudicationBranchEvents >= 1, true, '①≥1 → escalation 第一')
assert.equal(losslessCycles / resumeCycles < 1, false, '②=100% → 不触发「resume 强化先于 hole」')
assert.equal(exhaustedNonDone.length >= 1, true, '③≥1 → hole 第二、amend 末位')
ok(`三数齐：①=${adjudicationBranchEvents} ②=${losslessCycles}/${resumeCycles}（100%）③=${exhaustedNonDone.length} → P4 缺省序 ${p4Order}`)

// ==== 证据落盘：journal sidecar + 试点报告 ====
mkdirSync(EVIDENCE_DIR, { recursive: true })
cpSync(storage.file, JOURNAL_COPY_PATH)

const legRows = [
  ['A 初跑', `scheduler run × fault.abortAt=[${ABORT1}]`, `崩（E1_ENGINE_ABORT）；intake/plan-a/plan-b done，${ABORT1} 停 dispatching`, 'driverA create=3；6 条广播、无终局广播'],
  ['B 恢复一', `resume + redrive(${ABORT1})（quiesce→cooldown→重入→typedAsk）`, `${ABORT1} done（瞬态失败 1 次 + 重派成功）`, 'driverB create=2；已完成步零 create；verify 保持 declared'],
  ['C 续跑', `scheduler run × fault.abortAt=[${ABORT2}]`, `崩；verify done，${ABORT2} 停 dispatching`, 'driverC create=1'],
  ['D 恢复二', `resume + redrive(${ABORT2})（typedAsk 3 次耗尽）`, `${ABORT2} failed（escalation 恰 1 次）`, 'driverD create=3；nudge 恰 1 次在第 2 次重派'],
]
const stepRows = stepIds.map((id) => {
  const st = journal.getStepState(id)
  const note = id === ABORT1 || id === ABORT2 ? 'abortAt 注入点' : stepById.get(id).agent ? `agent=${stepById.get(id).agent}（透传）` : ''
  return `| ${id} | ${st.state} | ${st.attempts} | ${st.history.length} | ${note} |`
})
const report = `# E1 试点报告（S8 / T3.7）

- 生成：${new Date().toISOString()}（由 plugin/test/pilot-run.mjs 产出；重跑该命令即刷新本文件）
- 依据：.zcode/plans/e1-construction-spec.md §5-T3.7 / §3 / §6；主计划 plan-gate-and-declarative-engine.md P3 决策点
- 合成 job：plugin/test/fixtures/engine/pilot-job.json（${declaration.steps.length} 步菱形 DAG：intake → {plan-a, plan-b} → merge → verify → publish）
- 崩溃注入：plugin/test/fixtures/engine/pilot-job.fault.json（2 个 abortAt 注入点：${ABORT1}、${ABORT2}）
- driver：mock（全合成场景；**未引用 fixtures/engine/replay/ 录制件**——规格 §6：录制件只归 T3.6 replay 半边，前序不得引用）
- 宿主：无（不触真实引擎；T3.7 优先分支「7 天内真实长程 job」未触发，**决策点照开**）
- 恢复接线：S6 redrive 夹具同款（resume 分类 → quiesce → cooldown(注入时钟 +60s) → failed→dispatching 重入 → typedAsk 回写）

## 运行生命周期（四段 leg）

| leg | 机制 | 结果 | 关键证据 |
| --- | --- | --- | --- |
${legRows.map((r) => `| ${r.join(' | ')} |`).join('\n')}

## 三数（决策点，主计划 P3「试点报告必须列三个数」）

### ① 需人工裁决的分支事件数 = ${adjudicationBranchEvents}

口径：盘上 journal events type ∈ {escalate, run-blocked} 条数 + scheduler step-failed/step-timeout 广播条数。
每条都是「自动机制已收敛、继续运行需人裁决（重派 / 改声明 / 放弃）」的分支点。

- escalate：${ABORT2}（typedAsk 第 3 次尝试仍缺 artifact 字段 → invalid-output 耗尽）→ 1 条（journal 台账 payload：{stepId, reason, attempts:3}）
- run-blocked：0；scheduler 步失败广播：0

### ② 中断后 resume+journal 无损恢复比例 = ${losslessCycles}/${resumeCycles}（${Math.round((losslessCycles / resumeCycles) * 100)}%）

口径：每个 abortAt 崩溃→resume→重跑循环，若 (a) resume 的 completed 集与崩前 done 集一致且 done
payload 分毫未动（字节级 deep-equal）、(b) 恢复代 driver 对已完成步零 create（mock calls 取数）、
(c) journal history 链全合法，则该循环「无损」。

- 循环 1（abort@${ABORT1}）：无损 ✓ —— resume completed=[intake, plan-a, plan-b]；driverB 零 create 于三步；重派 prompt = retryPrompt 逐字符
- 循环 2（abort@${ABORT2}）：无损 ✓ —— resume completed=五步；driverD 零 create 于五步；${ABORT1} 的 leg-B 记账未受影响

### ③ hole 诉求出现次数 = ${exhaustedNonDone.length}

口径：运行终局时「声明要求的步未达成 且 同声明自动机制已耗尽」的步数。typedAsk 的 maxAttempts
重派已证同一 prompt 无出路（3/3 全败），failed 重入边只能重派同一 prompt——达成目标只剩
「运行中交新声明」（改 prompt / 补步），即 P4 hole 的诉求场景。

- ${ABORT2}：终局 failed，typedAsk attempts=3/3，escalation 已触发 → 诉求 +1

## P4 顺序裁决（缺省映射，主计划 P3）

- ①=${adjudicationBranchEvents} ≥ 1 → **escalation 第一**
- ②=${Math.round((losslessCycles / resumeCycles) * 100)}%（不触发「resume 强化先于 hole」）
- ③=${exhaustedNonDone.length} ≥ 1 → **hole 第二、amend 末位**
- **采用序：${p4Order}**（三数只裁 P4 顺序，不自动降级任何一件；降级需用户拍板）

限制声明：本试点为合成 job + mock driver，数字证明的是**采集机制与合成场景下的路径覆盖**
（崩溃恢复、瞬态重派、schema 校验重派、escalation 耗尽），不是真实负载的统计；T3.7 优先分支
（真实长程 job）落地后可翻案重裁。

## 终局 journal 对账（6 步；盘上记录：.zcode/plans/evidence/pilot-journal.json）

| step | 终态 | attempts | history 条数 | 备注 |
| --- | --- | --- | --- | --- |
${stepRows.join('\n')}

- journal events（盘上）：恰 1 条 escalate（${ABORT2}，invalid-output，attempts=3）
- 全程零 context 调用（§2-2：context 真实形状归 S7a 实测，试点不假设）
- engine-owned 会话：${diskRecord.engineSessions.length} 个（全部经 markEngineSession 记账）
- resume 终读：completed=5、pending=[${ABORT2}]（escalation 终局：同声明无出路 → hole 诉求①的出处）

## 复现

    node plugin/test/pilot-run.mjs

（亦在 plugin/package.json scripts.test 枚举链内；每次运行刷新本文件与 pilot-journal.json。）
`
writeFileSync(REPORT_PATH, report, 'utf8')
console.log(`证据落盘：${REPORT_PATH}`)
console.log(`证据落盘：${JOURNAL_COPY_PATH}`)
console.log(`\n引擎试点（S8 门：T3.7 三数采集）：${passed} 项全过`)
