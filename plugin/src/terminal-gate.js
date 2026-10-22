// 终态判定门 —— "静默死亡"的边界。
//
// 没有"子任务死了"这个事件，全靠推断。三处证据：
//   ① 宿主事件（session.execution.*）—— 有就是有，可靠
//   ② 子会话转录的分类（classifyTranscript）—— 判定终态 / 无终态 / 未知
//   ③ 宿主 live-status 轮询（本实现不用轮询，靠 ①②）
//
// **关键设计（抄 omo-slim，MIT）**：`session.idle` 只是**候选**，不立即判定终止；
// 只有当转录判定为 absent **且**静默已持续超过宽限期，才落 stopped。
// 否则会把每个正常完成的子任务都误报成死亡。

import { STOP_CONFIRMATION_GRACE_MS } from './constants.js'

export const VERDICT = Object.freeze({
  /** 转录里有明确的终态结果。 */
  TERMINAL: 'terminal',
  /** 转录里没有终态结果，且看起来已经不动了 —— 停止候选。 */
  ABSENT: 'absent',
  /** 看不出来（读不到、形状不认识等）—— 一律 fail-open，保持 running。 */
  UNKNOWN: 'unknown',
})

/**
 * 判定"静默是否已经稳定到可以下结论"。
 *
 * 用 max(最后一次观测到静默的时刻, 本次尝试的开始时刻) 作为基准 ——
 * 前者防止把"刚开始跑"误判成"停了很久"，后者防止把"正常完成的最后一刻"误判成死亡。
 */
export function isStopStable({ quiescentSince, attemptStartedAt, graceMs, now = Date.now() }) {
  const base = Math.max(quiescentSince ?? now, attemptStartedAt ?? 0)
  return now - base >= graceMs
}

/**
 * 决定是否落 stopped。
 * @returns {{ stop: boolean, reason: string }}
 */
export function decideStop({
  verdict,
  quiescentSince = null,
  attemptStartedAt = 0,
  graceMs = STOP_CONFIRMATION_GRACE_MS,
  now = Date.now(),
}) {
  if (verdict !== VERDICT.ABSENT) {
    return { stop: false, reason: `verdict=${verdict}` }
  }
  const stable = isStopStable({ quiescentSince, attemptStartedAt, graceMs, now })
  return stable
    ? { stop: true, reason: 'transcript_absent_and_quiescent' }
    : { stop: false, reason: 'still_within_grace' }
}

/**
 * 从子会话转录里分类出终态证据。
 *
 * ⚠️ **输入形状未完全验证**：转录由 `ctx.session.context({ sessionID })` 取（施工图 §6），
 * 其返回结构尚未实测。这里只做**形状容错**的保守判定：
 *   - 认不出形状 → UNKNOWN（fail-open，保持 running，绝不下结论）
 *   - 看到明确的失败/中断标记 → TERMINAL
 *   - 看到 assistant 产出了内容 → TERMINAL（宿主会另行发 execution.succeeded）
 *   - 什么都没有且消息列表为空 → ABSENT（停止候选）
 */
export function classifyTranscript(transcript) {
  if (transcript == null) return VERDICT.UNKNOWN

  const messages = pickMessages(transcript)
  if (!messages) return VERDICT.UNKNOWN
  if (messages.length === 0) return VERDICT.ABSENT

  let sawAssistantContent = false
  for (const m of messages) {
    const role = m?.role ?? m?.info?.role
    const text = extractText(m)
    if (role === 'assistant' && text && text.length > 0) sawAssistantContent = true
    const err = m?.error ?? m?.info?.error
    if (err) return VERDICT.TERMINAL
  }
  return sawAssistantContent ? VERDICT.TERMINAL : VERDICT.ABSENT
}

function pickMessages(transcript) {
  if (Array.isArray(transcript)) return transcript
  if (Array.isArray(transcript.messages)) return transcript.messages
  if (Array.isArray(transcript.history)) return transcript.history
  if (Array.isArray(transcript.context?.messages)) return transcript.context.messages
  return null
}

function extractText(m) {
  const parts = m?.parts ?? m?.content ?? null
  if (typeof parts === 'string') return parts
  if (!Array.isArray(parts)) return null
  return parts
    .filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
    .map((p) => p.text ?? '')
    .join('')
}
