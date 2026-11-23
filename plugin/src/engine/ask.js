// E1 引擎 typed ask（S5；施工规格 .zcode/plans/e1-construction-spec.md §3 / §5-T3.3，
// 主计划 P3「重派口径写死」）。
//
// 职责：把一步声明跑成「通过校验的产出」——create 一个子会话、轮询 result 到终态、done 后
// 按 step.schema（validateValue）与调用方 validate 回调校验产出；未通过则重派：每次重派的
// prompt 附上一次（= 上一次尝试的）校验错误，最后一次重派再附 nudge 文案。
//
// 重派口径（写死，规格 F6）：maxAttempts = 含初派的总尝试上限（整数 ≥1，默认
// DECLARATION_DEFAULTS.maxAttempts = 3）。maxAttempts=3 时：初派 1 + 重派 2，nudge 恰出现
// 在第 2 次重派（= 最后一次重派）＝全程恰 1 次；maxAttempts=1 时无重派、无 nudge。
// 耗尽 → 步 failed（outcome ok:false），不冒泡假结果（失败 outcome 从不携带 value/text）；
// escalation 走 onEscalate 回调——P4 接面板，E1 调用方先落 journal blocked + 台账。本文件
// 不碰 journal（§3 依赖表：ask ← driver/schema 校验/now）：失败记账与 cooldown（§1「同 step
// 两次 dispatch 间隔 60s」）都归调用方接线（S6+/scheduler 重入边）。
//
// 尝试的五种死法与收敛：
//   invalid-output    done 但产出不过校验（缺 text / 非合法 JSON / schema 不过 / validate 不过）→ 可重派；
//   subsession-failed result status='failed'（或未知 status——与 scheduler pollAll 同哲学「宁可失败，不悬挂」）→ 可重派；
//   poll-error        result 抛错（驱动/宿主层错误）→ 可重派；
//   dispatch-error    create 抛错或缺非空 sessionId → 可重派（错误同样附进下一次 prompt）；
//   timeout           注入时钟推进越过 timeoutMs（默认 DECLARATION_DEFAULTS.timeoutMs，窗口每次
//                     尝试独立起算——scheduler 的 lastDispatchAt 同款）→ **立即** 步失败，不再重派
//                     （§1「超时→步失败进 journal，不静默老化」）。
// 任一 failed 收敛（含 timeout）都触发 onEscalate 恰一次；成功路径绝不触发。onEscalate 抛错
// 只吞掉（journal 广播同款：步失败已收敛，监听方自负责）。
//
// 等待循环（§1「事件到达才查、无定时器轮询」的事件形态归 driver-session S7b 的 result 实现；
// 本核心是 result 轮询：status='running' → 睡 pollMs 再查，查不出终态就继续等）。ask 无 events
// 参数（§3 签名写死）——事件驱动型调用方让 driver.result 自己挂起等待即可，ask 的轮询间隔
// pollMs 只决定「醒来再查」的节奏。
//
// 注入面（§6）：now（默认 Date.now）经构造参数传入，超时判定与 outcome.at 全走它；fault 不在
// ask 签名里——failWrite 归 journal、driverChaos 归 driver，ask 只消费 driver 抛出的错误。
//
// 与 §3 签名的偏差（加法，不改既定面，沿 journal.js/scheduler.js 先例）：
//   title?:  create 标题（driver 的 create 面 title 必填非空——S3 契约）。ask 无 runId，不发明
//            `REEVE-E1 <runId>` 锚点：缺省 title = step.stepId，调用方（scheduler/resume 接线）
//            用它传完整锚点 `REEVE-E1 <runId> <stepId>`；
//   pollMs?: 轮询间隔毫秒（≥0 整数，缺省 0）。
import { DECLARATION_DEFAULTS, validateStep, validateValue } from './declaration.js'
import { assertDriverFace } from './driver.js'

/** 重派口径缺省总尝试上限（与 declaration.schema.json 的 maxAttempts.default 同源）。 */
export const ASK_DEFAULT_MAX_ATTEMPTS = DECLARATION_DEFAULTS.maxAttempts
/** 步级超时缺省毫秒（与 declaration.schema.json 的 timeoutMs.default 同源）。 */
export const ASK_DEFAULT_TIMEOUT_MS = DECLARATION_DEFAULTS.timeoutMs
/** 最后一次重派附加的 nudge 文案（全程恰出现 1 次，恰在最后一次重派）。 */
export const ASK_NUDGE =
  '【最后一次重派】上一次产出仍未通过校验。请逐条对照上面列出的错误修正后重新给出完整产出；本次再未通过校验，本步将按失败收敛，不再有任何后续尝试。'
/** 步失败 reason 取值域（outcome.ok === false 时的 reason）。 */
export const ASK_FAILED_REASONS = Object.freeze(['invalid-output', 'subsession-failed', 'poll-error', 'dispatch-error', 'timeout'])

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const brief = (v) => String(v?.message ?? v).slice(0, 160)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 组装第 attempt 次尝试（重派）的 prompt：原 prompt + 上一次的校验错误（一次）；attempt ===
 * maxAttempts（最后一次重派）再附 nudge。ask 内部与 T3.3 夹具共用（测试按它写 mock 场景的
 * match.prompt，再断言实际 create 的 prompt 逐字符相等）。
 */
export function retryPrompt(prompt, errors, { attempt, maxAttempts }) {
  const notice = `[reeve ask] 第 ${attempt}/${maxAttempts} 次尝试（重派）：上一次产出未通过校验，错误如下：\n${errors.map((e) => `- ${e}`).join('\n')}`
  return attempt === maxAttempts ? `${prompt}\n\n${notice}\n\n${ASK_NUDGE}` : `${prompt}\n\n${notice}`
}

/**
 * 产出判定：缺 text / 非法 JSON / step.schema 不过（validateValue）/ validate 回调不过 →
 * { ok:false, errors }；全过 → { ok:true, value }。validate 返回形状不合法属程序错误 →
 * TypeError fail-fast（与参数校验同轨，不烧尝试次数）。
 */
function judgeOutput(text, step, validate) {
  if (typeof text !== 'string') return { ok: false, errors: ['子会话产出缺 text（done 但没有文本）'] }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, errors: [`产出不是合法 JSON：${brief(error)}`] }
  }
  const errors = []
  if (step.schema !== undefined) {
    const v = validateValue(parsed, step.schema, '产出')
    if (!v.ok) errors.push(...v.errors)
  }
  if (validate) {
    const v = validate(parsed)
    if (!isPlainObject(v) || typeof v.ok !== 'boolean') {
      throw new TypeError('typedAsk: validate 必须返回 { ok: boolean, errors?: string[] }')
    }
    if (!v.ok) {
      if (v.errors !== undefined && (!Array.isArray(v.errors) || !v.errors.every((e) => typeof e === 'string'))) {
        throw new TypeError('typedAsk: validate 返回的 errors 必须是字符串数组')
      }
      const list = v.errors ?? []
      errors.push(...(list.length > 0 ? list : ['validate 未通过（未附错误明细）']))
    }
  }
  return errors.length === 0 ? { ok: true, value: parsed } : { ok: false, errors }
}

/**
 * typed ask：把一步声明跑成通过校验的产出（重派口径见文件头）。
 * @param {*} driver createDriver 产物或同面注入件（create/result/context 函数面；ask 不调 close）
 * @param {*} step 声明步（先过 validateStep：stepId/prompt/deps 必填；schema/agent/model/maxAttempts/timeoutMs 可选）
 * @param {object} opts
 *   - validate:   (value) => { ok, errors? }——产出值校验回调（与 step.schema 叠加，两者都须过）
 *   - onEscalate: (outcome) => void——步失败收敛出口（恰一次；抛错只吞掉）
 *   - now:        () => number（默认 Date.now；超时判定与 outcome.at 全走它）
 *   - title:      create 标题（driver create 面 title 必填；缺省 = step.stepId，锚点由调用方拼）
 *   - pollMs:     轮询间隔毫秒（≥0 整数，缺省 0）
 * @returns {Promise<object>} 成功 { ok:true, stepId, sessionId, attempts, text, value?, at }
 *   （value = 解析后的产出，仅在有校验要求时携带）；失败 { ok:false, stepId, reason, attempts, at,
 *   errors? | error? | timeoutMs?+elapsedMs?, sessionId? }——失败从不携带 value/text（不冒泡假结果）。
 * @throws {TypeError} step/driver 面/validate/onEscalate/now/pollMs 形状不合法（程序错误，fail-fast）
 * @throws {TypeError} validate 回调返回形状不合法（运行中发现，同归程序错误）
 */
export async function typedAsk(driver, step, opts = {}) {
  const { validate, onEscalate, now, title, pollMs } = opts ?? {}

  // ---- 参数校验（程序错误 = TypeError，fail-fast；语义性失败走返回值，与 journal/scheduler 分轨同哲学）----
  const verdict = validateStep(step)
  if (!verdict.ok) throw new TypeError(`typedAsk: step 不合法：\n  ${verdict.errors.join('\n  ')}`)
  assertDriverFace(driver, 'typedAsk: driver')
  if (validate !== undefined && typeof validate !== 'function') throw new TypeError('typedAsk: validate 必须是 (value) => { ok, errors? } 回调')
  if (onEscalate !== undefined && typeof onEscalate !== 'function') throw new TypeError('typedAsk: onEscalate 必须是 (outcome) => void 回调')
  if (now !== undefined && typeof now !== 'function') throw new TypeError('typedAsk: now 必须是 () => number')
  if (pollMs !== undefined && (!Number.isInteger(pollMs) || pollMs < 0)) throw new TypeError('typedAsk: pollMs 必须是 ≥0 整数（毫秒）')
  if (title !== undefined && (typeof title !== 'string' || title === '')) throw new TypeError('typedAsk: title 必须是非空字符串（缺省 = step.stepId）')

  const nowFn = now ?? Date.now
  const maxAttempts = step.maxAttempts ?? ASK_DEFAULT_MAX_ATTEMPTS
  const timeoutMs = step.timeoutMs ?? ASK_DEFAULT_TIMEOUT_MS
  const pollDelay = pollMs ?? 0
  const wantsValidation = step.schema !== undefined || validate !== undefined
  const createBase = {
    title: title ?? step.stepId, // driver create 面 title 必填（S3 契约）；ask 缺省只给 stepId，不发明 runId 锚点
    ...(step.agent !== undefined ? { agent: step.agent } : {}),
    ...(step.model !== undefined ? { model: step.model } : {}),
  }

  let attempts = 0
  let sessionId = null
  let lastReason = null
  let lastErrors = null
  let lastError = null

  const failedOutcome = (reason, extra = {}) => ({
    ok: false,
    stepId: step.stepId,
    reason,
    attempts,
    at: nowFn(),
    ...(sessionId !== null ? { sessionId } : {}),
    ...extra,
  })
  const converge = (outcome) => {
    if (onEscalate) {
      try {
        onEscalate(outcome)
      } catch {
        /* 监听方异常不回滚：步失败已收敛，面板/journal 接线自负责 */
      }
    }
    return outcome
  }

  for (let n = 1; n <= maxAttempts; n += 1) {
    attempts = n
    const prompt = n === 1 ? step.prompt : retryPrompt(step.prompt, lastErrors ?? [], { attempt: n, maxAttempts })
    const startedAt = nowFn() // 超时窗口每次尝试独立起算（dispatch 时刻起，含 create 耗时）

    // ---- 派发（dispatch-error 可重派：错误同样附进下一次 prompt）----
    let created = null
    try {
      created = await driver.create({ ...createBase, prompt })
    } catch (error) {
      lastReason = 'dispatch-error'
      lastErrors = [`派发失败（${error?.code ?? 'E1_DRIVER_ERROR'}）：${brief(error)}`]
      lastError = { code: error?.code ?? null, message: brief(error) }
      continue
    }
    if (typeof created?.sessionId !== 'string' || created.sessionId.length === 0) {
      lastReason = 'dispatch-error'
      lastErrors = ['driver.create 返回缺非空 sessionId']
      continue
    }
    sessionId = created.sessionId

    // ---- 等待循环：running → 判超时 → 睡 pollMs 再查；查不出终态就继续等 ----
    while (true) {
      let res = null
      try {
        res = await driver.result(sessionId)
      } catch (error) {
        lastReason = 'poll-error'
        lastErrors = [`读取产出失败（${error?.code ?? 'E1_DRIVER_ERROR'}）：${brief(error)}`]
        lastError = { code: error?.code ?? null, message: brief(error) }
        break
      }
      if (res?.status === 'running') {
        const t = nowFn()
        if (t - startedAt >= timeoutMs) {
          // 超时 → 步失败，不再重派（§1：超时进 journal 不静默老化；恢复/重派是调用方的事）
          return converge(failedOutcome('timeout', { timeoutMs, elapsedMs: t - startedAt }))
        }
        await sleep(pollDelay)
        continue
      }
      if (res?.status === 'done') {
        if (!wantsValidation) {
          // 无校验要求：done 即产出（不假设 text 是 JSON，不解析、无 value 键）
          return { ok: true, stepId: step.stepId, sessionId, attempts, text: res.text, at: nowFn() }
        }
        const judged = judgeOutput(res.text, step, validate)
        if (judged.ok) {
          return { ok: true, stepId: step.stepId, sessionId, attempts, text: res.text, value: judged.value, at: nowFn() }
        }
        lastReason = 'invalid-output'
        lastErrors = judged.errors
        break
      }
      // 'failed' 或未知 status 都按失败收敛（scheduler pollAll 同哲学：宁可失败，不悬挂）
      lastReason = 'subsession-failed'
      lastErrors = [typeof res?.errorPart === 'string' ? `子会话失败：${res.errorPart}` : `子会话失败（status=${JSON.stringify(res?.status ?? null)}）`]
      break
    }
  }

  // ---- 耗尽：步 failed，不冒泡假结果（无 value/text）+ escalation 恰一次 ----
  const outcome = failedOutcome(lastReason ?? 'invalid-output')
  if (lastErrors !== null) outcome.errors = lastErrors
  if (lastError !== null) outcome.error = lastError
  return converge(outcome)
}
