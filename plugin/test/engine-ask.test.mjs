// E1 引擎 typed ask 测试（S5 门；施工规格 .zcode/plans/e1-construction-spec.md
// §4-S5 / §5-T3.3 / §3 重派口径写死 / §6 clock 注入）。
//
// 覆盖矩阵：
//   T3.3 主线  mock 坏 JSON×2→好（maxAttempts 缺省 3）：按写死口径断言精确数字——create 恰 3 次
//             （初派 1 + 重派 2）、每次重派 prompt 附上一次校验错误（第 2 次重派含第 1 次的错、
//             不含第 2 次的错）、nudge 恰 1 次且恰在第 2 次重派、成功 outcome 携带解析值、
//             零 escalate、零 context 调用。
//   耗尽      坏到底 → outcome ok:false / reason=invalid-output / attempts=3，无 value/text
//             （不冒泡假结果）、onEscalate 恰一次且收到同一 outcome 引用。
//   口径泛化  maxAttempts=1：无重派、无 nudge、一击耗尽；maxAttempts=2：nudge 落在第 1 次重派
//             （= 最后一次重派）且全程恰 1 次。
//   超时      注入时钟推进越过 timeoutMs → 立即步失败（attempts=1，不重派）、reason=timeout、
//             escalate 恰一次（§1「超时→步失败，不静默老化」）。
//   其他死法  subsession-failed（errorPart 附进重派 prompt；耗尽变体）、poll-error（result 抛错
//             重派）、dispatch-error（create 抛错/缺 sessionId 重派与耗尽）、未知 status 按失败收敛。
//   校验面    无校验要求（done 即产出、非 JSON 照收、无 value 键）；step.schema 路径（validateValue
//             错误附进重派 prompt）；validate+schema 叠加；validate 返回形状坏 → TypeError；
//             validate({ok:false}) 无明细 → 兜底错误文案。
//   参数面    step 不合法/缺驱动面/回调形状/pollMs 负数 → TypeError；model/agent/title 透传
//             （calls.args 深等于）；ASK_DEFAULT_* 与 DECLARATION_DEFAULTS 同源；escalate 抛错只吞掉。
//
// 夹具全合成（mock driver 脚本化 + 手搓 fake driver + 逐调用自推进时钟）；replay 录制件属 S7a，
// 本文件不引用 fixtures/engine/replay/（不创建、不读取）。mock 场景的 match.prompt 用实现导出的
// retryPrompt 计算（单一事实来源），再断言实际 create 的 prompt 逐字符相等。
//
// 运行：node plugin/test/engine-ask.test.mjs（assert 失败即抛、非零退出；成功自然退出）
import assert from 'node:assert/strict'

import {
  ASK_DEFAULT_MAX_ATTEMPTS,
  ASK_DEFAULT_TIMEOUT_MS,
  ASK_FAILED_REASONS,
  ASK_NUDGE,
  retryPrompt,
  typedAsk,
} from '../src/engine/ask.js'
import { DECLARATION_DEFAULTS } from '../src/engine/declaration.js'
import { createDriver } from '../src/engine/driver.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- 夹具基座（全合成）----
const P = '输出一个 {"ok": true, "sum": 42} 形态的 JSON'
const step = (extra = {}) => ({ stepId: 'a', prompt: P, deps: [], ...extra })
const sc = (prompt, result) => ({ name: prompt, match: { prompt }, result })
const BAD1 = '这不是 JSON'
const BAD2 = '{"sum":'
const GOOD = '{"ok": true, "sum": 42}'
/** 与实现同源的 JSON.parse 错误消息（断言「重派附上次错误」的锚点）。 */
const parseErrorOf = (text) => {
  try {
    JSON.parse(text)
    return null
  } catch (error) {
    return String(error.message)
  }
}
const ERR1 = `产出不是合法 JSON：${parseErrorOf(BAD1)}`
const ERR2 = `产出不是合法 JSON：${parseErrorOf(BAD2)}`
const createCalls = (driver) => driver.calls.filter((c) => c.op === 'create')
const promptSeq = (driver) => createCalls(driver).map((c) => c.args.prompt)
const resultCalls = (driver) => driver.calls.filter((c) => c.op === 'result').length
const contextCalls = (driver) => driver.calls.filter((c) => c.op === 'context').length
const nudgeCount = (s) => s.split(ASK_NUDGE).length - 1
/** 逐次调用自推进的时钟（每 now() 前进 stepMs；ask 超时判定与 driver 记账共用同一实例）。 */
const steppingClock = (stepMs, start = 0) => {
  let t = start
  return () => (t += stepMs)
}
/** 手搓 driver（面合法；mock 造不出的错误臂用），create/result/context 逐次记 calls。 */
const fakeDriver = ({ create, result } = {}) => {
  const calls = []
  let seq = 0
  let created = 0
  const rec = (op, extra = {}) => {
    const r = { seq: ++seq, op, at: 0, ...extra }
    calls.push(r)
    return r
  }
  return {
    calls,
    create: async (args) => {
      const r = rec('create', { args })
      if (create) {
        const out = await create(args)
        if (typeof out?.sessionId === 'string') r.sessionId = out.sessionId
        return out
      }
      const sessionId = `sess_fake_${++created}`
      r.sessionId = sessionId
      return { sessionId }
    },
    result: async (sessionId) => {
      rec('result', { sessionId })
      return result ? result(sessionId) : { status: 'running' }
    },
    context: async (sessionId) => {
      rec('context', { sessionId })
      return {}
    },
  }
}

// ---- 0. 缺省锚与参数校验（TypeError = 程序错误，fail-fast）----
console.log('0. 缺省锚与参数校验')
{
  assert.equal(ASK_DEFAULT_MAX_ATTEMPTS, DECLARATION_DEFAULTS.maxAttempts, 'ask 缺省上限与 declaration schema 同源')
  assert.equal(ASK_DEFAULT_MAX_ATTEMPTS, 3, '重派口径写死：缺省 maxAttempts = 3（含初派）')
  assert.equal(ASK_DEFAULT_TIMEOUT_MS, DECLARATION_DEFAULTS.timeoutMs, 'ask 缺省超时与 declaration schema 同源')
  assert.equal(ASK_DEFAULT_TIMEOUT_MS, 900000, '缺省 timeoutMs = 900000')
  assert.deepEqual([...ASK_FAILED_REASONS], ['invalid-output', 'subsession-failed', 'poll-error', 'dispatch-error', 'timeout'], '失败 reason 取值域')
  ok('缺省锚：ASK_DEFAULT_* 与 schema 同源（3 / 900000）+ reason 枚举')
}
{
  const badSteps = [
    ['缺 deps', { stepId: 'a', prompt: P }],
    ['prompt 空', { stepId: 'a', prompt: '', deps: [] }],
    ['未知字段', { stepId: 'a', prompt: P, deps: [], retry: true }],
    ['maxAttempts=0', { stepId: 'a', prompt: P, deps: [], maxAttempts: 0 }],
    ['timeoutMs=999', { stepId: 'a', prompt: P, deps: [], timeoutMs: 999 }],
    ['schema 非对象', { stepId: 'a', prompt: P, deps: [], schema: 'nope' }],
    ['step 非对象', null],
  ]
  for (const [label, s] of badSteps) {
    await assert.rejects(() => typedAsk(createDriver('mock'), s), TypeError, `step 不合法须 TypeError：${label}`)
  }
  ok('step 不合法（7 形态）→ TypeError（validateStep 挡在派发前）')
}
{
  const driver = createDriver('mock')
  await assert.rejects(() => typedAsk({ create: driver.create }, step()), (e) => e.code === 'E1_DRIVER_BAD_ARGS' && /缺驱动面/.test(e.message), '缺 result/context 面 → E1_DRIVER_BAD_ARGS')
  await assert.rejects(() => typedAsk(driver, step(), { validate: 'x' }), TypeError, 'validate 非函数 → TypeError')
  await assert.rejects(() => typedAsk(driver, step(), { onEscalate: 42 }), TypeError, 'onEscalate 非函数 → TypeError')
  await assert.rejects(() => typedAsk(driver, step(), { now: 'x' }), TypeError, 'now 非函数 → TypeError')
  await assert.rejects(() => typedAsk(driver, step(), { pollMs: -1 }), TypeError, 'pollMs 负数 → TypeError')
  await assert.rejects(() => typedAsk(driver, step(), { pollMs: 1.5 }), TypeError, 'pollMs 非整数 → TypeError')
  ok('驱动面/回调/时钟/pollMs 形状不合法 → fail-fast')
}

// ---- 1. T3.3 主线：mock 坏 JSON×2 → 好（缺省 maxAttempts=3）----
console.log('1. T3.3 主线：坏 JSON×2→好（初派 1 + 重派 2，nudge 恰 1 次在第 2 次重派）')
{
  const r1 = retryPrompt(P, [ERR1], { attempt: 2, maxAttempts: 3 })
  const r2 = retryPrompt(P, [ERR2], { attempt: 3, maxAttempts: 3 })
  const driver = createDriver('mock', {
    scenarios: [sc(P, [{ status: 'done', text: BAD1 }]), sc(r1, [{ status: 'done', text: BAD2 }]), sc(r2, [{ status: 'done', text: GOOD }])],
  })
  const escalated = []
  const out = await typedAsk(driver, step(), { validate: () => ({ ok: true }), onEscalate: (o) => escalated.push(o) })
  assert.equal(out.ok, true, '第三次产出通过 → 成功')
  assert.equal(out.stepId, 'a')
  assert.equal(out.attempts, 3, '成功发生在第 3 次尝试')
  assert.equal(out.text, GOOD, 'outcome 携带原文')
  assert.deepEqual(out.value, { ok: true, sum: 42 }, 'outcome 携带解析后的 value')
  assert.equal(typeof out.sessionId, 'string', 'outcome 携带 sessionId')
  assert.equal(createCalls(driver).length, 3, '写死口径的精确数字：初派 1 + 重派 2 = create 恰 3 次')
  const prompts = promptSeq(driver)
  assert.equal(prompts[0], P, '初派 prompt = 原 prompt（无附言）')
  assert.equal(prompts[1], r1, '第 1 次重派 prompt 逐字符 = retryPrompt(attempt 2)')
  assert.equal(prompts[2], r2, '第 2 次重派 prompt 逐字符 = retryPrompt(attempt 3)')
  assert.ok(prompts[1].includes(ERR1) && !prompts[1].includes(ERR2), '每次重派附「上一次」校验错误（第 1 次重派含错 1 不含错 2）')
  assert.ok(prompts[2].includes(ERR2) && !prompts[2].includes(ERR1), '第 2 次重派含错 2 不含错 1')
  assert.equal(prompts.filter((p) => p.includes(ASK_NUDGE)).length, 1, 'nudge 恰出现 1 次')
  assert.ok(prompts[2].includes(ASK_NUDGE) && !prompts[0].includes(ASK_NUDGE) && !prompts[1].includes(ASK_NUDGE), 'nudge 恰在第 2 次重派（最后一次重派）')
  assert.equal(nudgeCount(prompts[2]), 1, 'nudge 在单个 prompt 内也不重复')
  assert.deepEqual(escalated, [], '成功路径零 escalate')
  assert.equal(resultCalls(driver), 3, '每尝试恰一次 result（三尝试都一查即终态）')
  assert.equal(contextCalls(driver), 0, 'ask 不读 context')
  ok('T3.3：初派 1 + 重派 2、错误逐次附、nudge 恰 1 次在第 2 次重派、成功带 value')
}

// ---- 2. 耗尽 → failed 不冒泡 + escalate 恰一次 ----
console.log('2. 耗尽：failed 不冒泡假结果 + onEscalate 恰一次')
{
  const r1 = retryPrompt(P, [ERR1], { attempt: 2, maxAttempts: 3 })
  const r2 = retryPrompt(P, [ERR2], { attempt: 3, maxAttempts: 3 })
  const driver = createDriver('mock', {
    scenarios: [sc(P, [{ status: 'done', text: BAD1 }]), sc(r1, [{ status: 'done', text: BAD2 }]), sc(r2, [{ status: 'done', text: BAD1 }])],
  })
  const escalated = []
  const out = await typedAsk(driver, step(), { validate: () => ({ ok: true }), onEscalate: (o) => escalated.push(o) })
  assert.equal(out.ok, false, '耗尽 → 步 failed')
  assert.equal(out.reason, 'invalid-output', 'reason = 最后一次尝试的死法')
  assert.equal(out.attempts, 3, '恰用满 3 次（含初派）')
  assert.equal(createCalls(driver).length, 3, '耗尽前重派照常发生')
  assert.ok(!('value' in out) && !('text' in out), '失败 outcome 不携带 value/text（不冒泡假结果）')
  assert.deepEqual(out.errors, [ERR1], 'outcome.errors = 最后一次（第 3 次）的校验错误')
  assert.equal(escalated.length, 1, 'onEscalate 恰一次')
  assert.equal(escalated[0], out, 'escalate 收到同一 outcome 引用（调用方拿它落 journal blocked）')
  assert.equal(escalated[0].stepId, 'a', 'escalate 载荷带 stepId')
  ok('耗尽：ok:false / attempts=3 / 无 value / escalate 恰一次（同引用）')
}

// ---- 3. 口径泛化：maxAttempts=1（无重派无 nudge）与 maxAttempts=2（nudge 在第 1 次重派）----
console.log('3. 口径泛化：maxAttempts=1 与 2')
{
  const driver = createDriver('mock', { scenarios: [sc(P, [{ status: 'done', text: BAD1 }])] })
  const escalated = []
  const out = await typedAsk(driver, step({ maxAttempts: 1 }), { validate: () => ({ ok: true }), onEscalate: (o) => escalated.push(o) })
  assert.equal(out.ok, false, 'maxAttempts=1 一击耗尽')
  assert.equal(out.attempts, 1, 'attempts=1')
  assert.equal(createCalls(driver).length, 1, '无重派：create 恰 1 次')
  assert.equal(promptSeq(driver)[0], P, '无重派：prompt 无附言')
  assert.equal(promptSeq(driver).join('').includes(ASK_NUDGE), false, 'maxAttempts=1 无 nudge')
  assert.equal(escalated.length, 1, '耗尽照常 escalate')
  ok('maxAttempts=1：无重派、无 nudge、一击耗尽 + escalate')
}
{
  const r1 = retryPrompt(P, [ERR1], { attempt: 2, maxAttempts: 2 })
  const driver = createDriver('mock', { scenarios: [sc(P, [{ status: 'done', text: BAD1 }]), sc(r1, [{ status: 'done', text: BAD2 }])] })
  const out = await typedAsk(driver, step({ maxAttempts: 2 }), { validate: () => ({ ok: true }) })
  const prompts = promptSeq(driver)
  assert.equal(out.ok, false, '两次都坏 → 耗尽')
  assert.equal(createCalls(driver).length, 2, '初派 1 + 重派 1')
  assert.equal(prompts.length, 2, '两条 prompt')
  assert.ok(prompts[1].includes(ASK_NUDGE), 'maxAttempts=2：nudge 落在第 1 次重派（= 最后一次重派）')
  assert.equal(prompts.join('').split(ASK_NUDGE).length - 1, 1, '全程 nudge 恰 1 次')
  ok('maxAttempts=2：nudge 恰在第 1 次重派且全程恰 1 次')
}

// ---- 4. 步级超时：注入时钟推进 → 立即失败、不重派（§1：超时→步失败，不静默老化）----
console.log('4. 步级超时（注入时钟）')
{
  const clock = steppingClock(300) // ask 超时判定与 driver 记账共用同一实例
  const driver = createDriver('mock', { scenarios: [sc(P, [{ status: 'running' }])], now: clock })
  const escalated = []
  const out = await typedAsk(driver, step({ timeoutMs: 1000, maxAttempts: 3 }), { now: clock, onEscalate: (o) => escalated.push(o) })
  assert.equal(out.ok, false, '超时 → 步失败')
  assert.equal(out.reason, 'timeout', 'reason = timeout')
  assert.equal(out.attempts, 1, '超时不重派：尽管 maxAttempts=3，恰 1 次尝试')
  assert.equal(createCalls(driver).length, 1, 'create 恰 1 次')
  assert.ok(resultCalls(driver) >= 2, '超时前至少两轮 result（首查不在窗口判定前夭折）')
  assert.equal(out.timeoutMs, 1000, 'outcome 携带 timeoutMs')
  assert.ok(out.elapsedMs >= 1000, `elapsedMs 越过窗口（实际 ${out.elapsedMs}）`)
  assert.ok(!('value' in out), '超时 outcome 无产出')
  assert.equal(escalated.length, 1, '超时也 escalate 恰一次')
  ok('超时：立即 failed / attempts=1 不重派 / escalate 恰一次')
}

// ---- 5. subsession-failed：errorPart 附进重派 prompt + 耗尽变体 ----
console.log('5. subsession-failed')
{
  const errA = '子会话失败：boom-1'
  const r1 = retryPrompt(P, [errA], { attempt: 2, maxAttempts: 2 })
  const driver = createDriver('mock', { scenarios: [sc(P, [{ status: 'failed', errorPart: 'boom-1' }]), sc(r1, [{ status: 'done', text: GOOD }])] })
  const out = await typedAsk(driver, step({ maxAttempts: 2 }), { validate: () => ({ ok: true }) })
  assert.equal(out.ok, true, 'failed 后重派成功')
  assert.equal(out.attempts, 2, '两次尝试')
  assert.equal(promptSeq(driver)[1], r1, '重派 prompt 逐字符 = retryPrompt（附 errorPart 渲染）')
  assert.ok(promptSeq(driver)[1].includes('boom-1'), '重派附上一次 errorPart')
  ok('subsession-failed：errorPart 附进重派 prompt、重派可成功')
}
{
  const r1 = retryPrompt(P, ['子会话失败：boom-1'], { attempt: 2, maxAttempts: 2 })
  const driver = createDriver('mock', {
    scenarios: [sc(P, [{ status: 'failed', errorPart: 'boom-1' }]), sc(r1, [{ status: 'failed', errorPart: 'boom-2' }])],
  })
  const escalated = []
  const out = await typedAsk(driver, step({ maxAttempts: 2 }), { onEscalate: (o) => escalated.push(o) })
  assert.equal(out.ok, false, '重派再失败 → 耗尽')
  assert.equal(out.reason, 'subsession-failed', 'reason = subsession-failed')
  assert.deepEqual(out.errors, ['子会话失败：boom-2'], 'outcome.errors = 最后一次 errorPart 渲染')
  assert.ok(!('value' in out), '无产出冒泡')
  assert.equal(escalated.length, 1, 'escalate 恰一次')
  ok('subsession-failed 耗尽：reason/errors/escalate')
}

// ---- 6. poll-error：result 抛错 → 重派成功 ----
console.log('6. poll-error（result 抛错）')
{
  const errText = `读取产出失败（E1_HOST_JITTER）：宿主抖了一下`
  const r1 = retryPrompt(P, [errText], { attempt: 2, maxAttempts: 2 })
  let resultCallsSeen = 0
  const driver = fakeDriver({
    result: async () => {
      resultCallsSeen += 1
      if (resultCallsSeen === 1) {
        const e = new Error('宿主抖了一下')
        e.code = 'E1_HOST_JITTER'
        throw e
      }
      return { status: 'done', text: GOOD }
    },
  })
  const out = await typedAsk(driver, step({ maxAttempts: 2 }), { validate: () => ({ ok: true }) })
  assert.equal(out.ok, true, 'result 抛错后重派成功')
  assert.equal(out.attempts, 2, '两次尝试')
  assert.equal(createCalls(driver).length, 2, 'create 两次（第二次是新会话）')
  assert.ok(createCalls(driver)[1].args.prompt.includes(errText), '重派 prompt 附上一次 poll 错误（code + message）')
  ok('poll-error：重派附 code+message、第二次成功')
}

// ---- 7. dispatch-error：create 抛错/缺 sessionId → 重派与耗尽 ----
console.log('7. dispatch-error')
{
  const driver = fakeDriver({
    create: async () => {
      const e = new Error('没有场景匹配本次 create')
      e.code = 'E1_DRIVER_NO_SCENARIO'
      throw e
    },
  })
  const escalated = []
  const out = await typedAsk(driver, step({ maxAttempts: 2 }), { onEscalate: (o) => escalated.push(o) })
  assert.equal(out.ok, false, '两次派发都抛 → 耗尽')
  assert.equal(out.reason, 'dispatch-error', 'reason = dispatch-error')
  assert.equal(out.attempts, 2, 'dispatch-error 也烧尝试次数')
  assert.equal(createCalls(driver).length, 2, 'create 恰 2 次')
  assert.deepEqual(out.error, { code: 'E1_DRIVER_NO_SCENARIO', message: '没有场景匹配本次 create' }, 'outcome.error 带 code（message 不截断于此长度）')
  assert.ok(!('sessionId' in out), '从未建起会话 → outcome 无 sessionId')
  assert.equal(escalated.length, 1, 'escalate 恰一次')
  ok('dispatch-error 耗尽：attempts 烧满 / error 带 code / 无 sessionId')
}
{
  const errText = 'driver.create 返回缺非空 sessionId'
  const r1 = retryPrompt(P, [errText], { attempt: 2, maxAttempts: 2 })
  assert.ok(r1.includes(ASK_NUDGE), '缺 sessionId 的重派（末次）也附 nudge（同口径）')
  let n = 0
  const driver = fakeDriver({
    create: async () => {
      n += 1
      return n === 1 ? {} : { sessionId: 'sess_ok' }
    },
    result: async () => ({ status: 'done', text: GOOD }),
  })
  const out = await typedAsk(driver, step({ maxAttempts: 2 }), { validate: () => ({ ok: true }) })
  assert.equal(out.ok, true, '缺 sessionId 重派后成功')
  assert.equal(createCalls(driver)[1].args.prompt, r1, '重派 prompt 附「缺非空 sessionId」错误')
  assert.equal(out.sessionId, 'sess_ok', '成功 outcome 带第二次的 sessionId')
  ok('缺 sessionId：按 dispatch-error 重派（附错误）')
}

// ---- 8. 未知 status 按失败收敛（scheduler 同哲学：宁可失败，不悬挂）----
console.log('8. 未知 status')
{
  const driver = fakeDriver({ result: async () => ({ status: 'weird' }) })
  const out = await typedAsk(driver, step({ maxAttempts: 1 }))
  assert.equal(out.ok, false, '未知 status → 失败')
  assert.equal(out.reason, 'subsession-failed', '归入 subsession-failed')
  assert.deepEqual(out.errors, ['子会话失败（status="weird"）'], '错误文案带原 status')
  ok('未知 status → subsession-failed 收敛')
}

// ---- 9. 无校验要求：done 即产出（非 JSON 照收、无 value 键）----
console.log('9. 无校验要求')
{
  const PROSE = '已完成，结论是三条：甲、乙、丙。'
  const driver = createDriver('mock', { scenarios: [sc(P, [{ status: 'done', text: PROSE }])] })
  const out = await typedAsk(driver, step())
  assert.equal(out.ok, true, '无 schema 无 validate → done 即产出')
  assert.equal(out.text, PROSE, '原文照收')
  assert.equal(out.attempts, 1, '一次尝试')
  assert.ok(!('value' in out), '不假设 text 是 JSON：无 value 键')
  assert.equal(createCalls(driver).length, 1, '不重派')
  ok('无校验要求：done 即产出、非 JSON 不解析')
}

// ---- 10. step.schema 校验路径（validateValue 错误附进重派 prompt）----
console.log('10. step.schema 路径')
{
  const schema = { type: 'object', required: ['sum'], properties: { sum: { type: 'integer' } } }
  const BAD_TYPED = '{"sum": "x"}'
  const schemaErr = '产出.sum: 必须是整数（得到 string）'
  const r1 = retryPrompt(P, [schemaErr], { attempt: 2, maxAttempts: 2 })
  const driver = createDriver('mock', { scenarios: [sc(P, [{ status: 'done', text: BAD_TYPED }]), sc(r1, [{ status: 'done', text: GOOD }])] })
  const out = await typedAsk(driver, step({ schema, maxAttempts: 2 }))
  assert.equal(out.ok, true, 'schema 校验失败重派后通过')
  assert.equal(out.attempts, 2, '两次尝试')
  assert.equal(promptSeq(driver)[1], r1, '重派 prompt 逐字符 = retryPrompt（附 validateValue 错误）')
  assert.ok(promptSeq(driver)[1].includes(schemaErr), '重派附 schema 错误（产出.sum: 必须是整数）')
  assert.deepEqual(out.value, { ok: true, sum: 42 }, '通过后 value = 解析值')
  ok('step.schema：validateValue 错误附进重派 prompt、通过后带 value')
}

// ---- 11. validate + schema 叠加；validate 返回形状 ----
console.log('11. validate 回调面')
{
  const schema = { type: 'object', required: ['sum'], properties: { sum: { type: 'integer' } } }
  const r1 = retryPrompt(P, ['validate 说不行'], { attempt: 2, maxAttempts: 2 })
  const driver = createDriver('mock', { scenarios: [sc(P, [{ status: 'done', text: GOOD }]), sc(r1, [{ status: 'done', text: GOOD }])] })
  let seen = 0
  const out = await typedAsk(driver, step({ schema, maxAttempts: 2 }), {
    validate: (v) => {
      seen += 1
      assert.deepEqual(v, { ok: true, sum: 42 }, 'validate 收到解析后的产出值')
      return seen === 1 ? { ok: false, errors: ['validate 说不行'] } : { ok: true }
    },
  })
  assert.equal(out.ok, true, 'schema 过 + validate 第二次过 → 成功')
  assert.equal(promptSeq(driver)[1], r1, 'schema 过但 validate 不过 → 仍重派且附 validate 错误')
  ok('validate+schema 叠加：schema 过、validate 不过 → 重派附 validate 错误')
}
{
  // validate 只在产出解析成功后才被调——夹具须给合法 JSON，形状错误才能撞上 validate 本身。
  const driver = createDriver('mock', { scenarios: [sc(P, [{ status: 'done', text: GOOD }])] })
  await assert.rejects(
    () => typedAsk(driver, step({ maxAttempts: 2 }), { validate: () => '是的' }),
    TypeError,
    'validate 返回非 {ok} 形状 → TypeError（程序错误，不烧次数）',
  )
  const driver2 = createDriver('mock', { scenarios: [sc(P, [{ status: 'done', text: GOOD }])] })
  await assert.rejects(() => typedAsk(driver2, step({ maxAttempts: 2 }), { validate: () => ({ ok: false, errors: [7] }) }), TypeError, 'errors 非字符串数组 → TypeError')
  ok('validate 返回形状坏 → TypeError fail-fast')
}
{
  const r1 = retryPrompt(P, ['validate 未通过（未附错误明细）'], { attempt: 2, maxAttempts: 2 })
  const driver = createDriver('mock', { scenarios: [sc(P, [{ status: 'done', text: GOOD }]), sc(r1, [{ status: 'done', text: GOOD }])] })
  let seen = 0
  const out = await typedAsk(driver, step({ maxAttempts: 2 }), { validate: () => (++seen === 1 ? { ok: false } : { ok: true }) })
  assert.equal(out.ok, true, '无明细的不过 → 兜底文案后重派成功')
  assert.equal(createCalls(driver)[1].args.prompt, r1, '重派附兜底错误文案')
  ok('validate({ok:false}) 无明细 → 兜底文案进重派 prompt')
}

// ---- 12. model/agent/title 透传 + outcome.at 走注入时钟 ----
console.log('12. 透传面与时钟')
{
  const MODEL = { providerID: 'opencode', id: 'glm', variant: 'think' }
  const clock = steppingClock(7, 1000) // ask 与 driver 共用同一实例
  const driver = createDriver('mock', { scenarios: [sc(P, [{ status: 'done', text: GOOD }])], now: clock })
  const out = await typedAsk(driver, step({ agent: 'worker', model: MODEL }), { title: 'REEVE-E1 run-1 a', now: clock })
  const args = createCalls(driver)[0].args
  assert.deepEqual(args.model, MODEL, 'model {providerID, id, variant?} 零转换直传（F4）')
  assert.equal(args.agent, 'worker', 'agent 直传')
  assert.equal(args.title, 'REEVE-E1 run-1 a', 'title 透传（锚点由调用方拼）')
  assert.ok(!('schema' in args) && !('deps' in args) && !('stepId' in args) && !('maxAttempts' in args), 'create 参数面只有 {title, prompt, agent?, model?}')
  assert.equal(out.at, 1028, 'outcome.at 走注入时钟（startedAt/create/result/outcome 共 4 次读数：1000+7×4）')
}
{
  const driver = createDriver('mock', { scenarios: [sc(P, [{ status: 'done', text: GOOD }])] })
  await typedAsk(driver, step())
  const args = createCalls(driver)[0].args
  assert.equal(args.title, 'a', '缺省 title = step.stepId（driver create 面 title 必填；ask 无 runId 不发明锚点）')
  assert.ok(!('agent' in args) && !('model' in args), '缺省不带 agent/model 键')
  await assert.rejects(() => typedAsk(createDriver('mock'), step(), { title: '' }), TypeError, 'title 空串 → TypeError')
  ok('model/agent/title 零转换直传；缺省 title=stepId；at 走注入时钟')
}

// ---- 13. escalate 抛错只吞掉（journal 广播同款）----
console.log('13. escalate 抛错不冒泡')
{
  const r1 = retryPrompt(P, [ERR1], { attempt: 2, maxAttempts: 2 })
  const driver = createDriver('mock', { scenarios: [sc(P, [{ status: 'done', text: BAD1 }]), sc(r1, [{ status: 'done', text: BAD2 }])] })
  const out = await typedAsk(driver, step({ maxAttempts: 2 }), {
    validate: () => ({ ok: true }),
    onEscalate: () => {
      throw new Error('面板挂了')
    },
  })
  assert.equal(out.ok, false, 'escalate 抛错不影响收敛结果')
  assert.equal(out.reason, 'invalid-output', 'outcome 完整返回')
  ok('onEscalate 抛错只吞掉，outcome 照常返回')
}

console.log(`\n引擎 typed ask 测试（S5 门：T3.3 + 重派口径 + 超时/死法矩阵）：${passed} 项全过`)
