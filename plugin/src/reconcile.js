// 跨重启对账 —— **本仓库唯一没有参照实现可抄的一块**。
//
// 语义（使用者裁决 = (b) 档）：**从父转录重建**。
// 宿主不给会话列表 → **父会话的持久化转录是唯一事实源**。
//
// **惰性触发**：父会话**下一次活动时**才扫（挂 ctx.session.hook("prompt")），不是启动时扫。
// 实测：`prompt` 钩子在回合一开始就触发，早于 `session.execution.started`（施工图 §14.7）。
//
// **明确不做**：不主动重新派发（会重复副作用）。
// **如实标注**：恢复是 best-effort，别名与终态结果**不恢复**。

import { REASON, STATE } from './constants.js'
import { VERDICT, classifyTranscript as classify } from './terminal-gate.js'

const RECONCILED_ONCE = new Set()

/**
 * 对账一个父会话。同一次进程生命周期内，每个父会话只跑一次。
 * @returns {Promise<{ scanned: number, reconciled: number, notes: string[] }>}
 */
export async function reconcileParent({ ctx, ledger, logger, parentSessionID }) {
  if (!parentSessionID) return { scanned: 0, reconciled: 0, notes: [] }
  if (RECONCILED_ONCE.has(parentSessionID)) return { scanned: 0, reconciled: 0, notes: [] }
  RECONCILED_ONCE.add(parentSessionID)

  const notes = []
  let scanned = 0
  let reconciled = 0

  // 只处理"重启前在飞"的记录：进程内本次新建的不需要探活。
  const candidates = ledger
    .all()
    .filter((r) => r.parentSessionID === parentSessionID && r.state === STATE.RUNNING && r.statusUncertain)

  if (candidates.length === 0) return { scanned: 0, reconciled: 0, notes: [] }

  for (const record of candidates) {
    if (ledger.isTombstoned(record.taskID)) continue
    scanned += 1

    if (!record.childSessionID) {
      // 连子会话 id 都没留下 —— 无法探活，如实标未知，保持登记（fail-open）。
      notes.push(`${record.taskID}: 无子会话 id，无法探活`)
      continue
    }

    let probe
    try {
      probe = await ctx.session.get({ sessionID: record.childSessionID })
    } catch (err) {
      const msg = String(err)
      if (isNotFound(msg)) {
        // 子会话不存在 → 墓碑 + 拆除。**不要复活成永远在跑的幽灵。**
        ledger.tombstone(record.taskID, REASON.CHILD_SESSION_MISSING)
        notes.push(`${record.taskID}: 子会话已不存在 → 墓碑 + 拆除`)
        reconciled += 1
        continue
      }
      // 其他错误 → fail-open，保持登记。
      notes.push(`${record.taskID}: 探活失败，保持登记（${msg.slice(0, 80)}）`)
      continue
    }

    const outcome = extractOutcome(probe)
    if (outcome) {
      // 有终态 outcome → 落真实终态。
      const mapped =
        outcome === 'interrupted' ? STATE.STOPPED : outcome === 'failed' ? STATE.ERROR : STATE.COMPLETED
      ledger.commitTerminal(record.taskID, mapped, {
        source: 'reconcile',
        reason: REASON.UNRECONCILED,
        terminalUnreconciled: true,
      })
      notes.push(`${record.taskID}: 探到终态 ${outcome} → ${mapped}`)
      reconciled += 1
      continue
    }

    // 存在但空闲/无输出 → 停止候选（这里不宽限等待：对账发生在重启之后，
    // 已经过了远超宽限的时间）。
    let verdict = VERDICT.UNKNOWN
    try {
      const transcript = await ctx.session.context({ sessionID: record.childSessionID })
      verdict = classify(transcript)
    } catch (err) {
      notes.push(`${record.taskID}: 读转录失败（${String(err).slice(0, 80)}）`)
    }

    if (verdict === VERDICT.TERMINAL) {
      ledger.commitTerminal(record.taskID, STATE.COMPLETED, {
        source: 'reconcile',
        reason: REASON.UNRECONCILED,
        terminalUnreconciled: true,
      })
      notes.push(`${record.taskID}: 转录显示有终态结果 → completed（unreconciled）`)
      reconciled += 1
    } else if (verdict === VERDICT.ABSENT) {
      ledger.commitTerminal(record.taskID, STATE.STOPPED, {
        source: 'reconcile',
        reason: REASON.UNRECONCILED,
        terminalUnreconciled: true,
        statusUncertain: true,
      })
      notes.push(`${record.taskID}: 存在但无终态结果 → stopped（unreconciled）`)
      reconciled += 1
    } else {
      notes.push(`${record.taskID}: 证据不足，保持登记（fail-open）`)
    }
  }

  logger?.debug?.(`[reeve] 对账 ${parentSessionID}：扫 ${scanned}，落定 ${reconciled}`)
  return { scanned, reconciled, notes }
}

/** 仅供测试：重置"每个父会话只对账一次"的门。 */
export function _resetReconcileGate() {
  RECONCILED_ONCE.clear()
}

function isNotFound(message) {
  return /not\s*found|NotFound|no such session|unknown session/i.test(message)
}

/**
 * 从 `ctx.session.get()` 的返回里提取终态 outcome。
 * ⚠️ 返回结构未完全实测，做形状容错；认不出就返回 null（fail-open）。
 */
function extractOutcome(probe) {
  if (!probe || typeof probe !== 'object') return null
  const candidates = [
    probe.outcome,
    probe.session?.outcome,
    probe.info?.outcome,
    probe.session?.info?.outcome,
    probe.execution?.outcome,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && ['succeeded', 'failed', 'interrupted'].includes(c)) return c
  }
  return null
}
