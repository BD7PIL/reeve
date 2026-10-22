// 墙钟监督器：卡死的子任务要被掐掉。
//
// 规则（抄 omo-slim，MIT）：
//   - **只监督 `background === true` 的任务**（前台的调用方自己在等，不需要第三方掐）
//   - **每任务一次性定时器**；**只对新 generation 重新武装**
//   - **忙碌 / 工具活动 / 存活信号都不续期**（卡死判定不能被"它还在动"这种信号骗过）
//   - 到期后：先武装宽限定时器 → 再发**恰好一次** interrupt
//   - 宽限到期仍未确认 → 标 statusUncertain 并落 error, timedOut
//   - **已发布的硬超时不可被迟到的完成/忙碌替换**（由 Ledger.commitTerminal 的单调性保证）

import {
  DEFAULT_ABORT_GRACE_MS,
  DEFAULT_MAX_ATTEMPTS,
  REASON,
  STATE,
} from './constants.js'

export class Supervisor {
  #timers = new Map() // taskID -> { generation, timer, phase: 'wall' | 'grace' }

  constructor({
    ledger,
    interrupt,
    logger = console,
    abortGraceMs = DEFAULT_ABORT_GRACE_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
  }) {
    this.ledger = ledger
    this.interrupt = interrupt
    this.logger = logger
    this.abortGraceMs = abortGraceMs
    this.maxAttempts = maxAttempts
  }

  /** 为一条记录武装墙钟。只有 background 任务、且未发布终态时才武装。 */
  arm(taskID, wallClockMs) {
    const record = this.ledger.get(taskID)
    if (!record) return false
    if (!record.background) return false
    if (record.terminalPublished) return false

    const existing = this.#timers.get(taskID)
    if (existing && existing.generation === record.generation) {
      // 同一个 generation 已经有定时器 —— 不重复武装，也**不续期**
      return false
    }
    if (existing) clearTimeout(existing.timer)

    const limit = Number(wallClockMs)
    if (!Number.isFinite(limit) || limit <= 0) return false

    const timer = setTimeout(() => this.#onExpiry(taskID, record.generation), limit)
    timer.unref?.()
    this.#timers.set(taskID, { generation: record.generation, timer, phase: 'wall' })
    return true
  }

  /** 终态发布后拆除计时器。 */
  disarm(taskID) {
    const entry = this.#timers.get(taskID)
    if (!entry) return
    clearTimeout(entry.timer)
    this.#timers.delete(taskID)
  }

  /**
   * 生成新 generation 时重新武装（例如重试）。
   * **注意**：activity / busy 信号**不**走这里 —— 它们不该续期。
   */
  rearmIfNewGeneration(taskID, wallClockMs) {
    const record = this.ledger.get(taskID)
    if (!record) return false
    const entry = this.#timers.get(taskID)
    if (entry && entry.generation === record.generation) return false
    return this.arm(taskID, wallClockMs)
  }

  async #onExpiry(taskID, generation) {
    const record = this.ledger.get(taskID)
    if (!record) return
    // 迟到的定时器：generation 变了或已终态 —— 丢弃，不要覆盖
    if (record.generation !== generation) return
    if (record.terminalPublished) return

    this.logger?.debug?.(`[reeve] 墙钟到期：${taskID}（子会话 ${record.childSessionID}）`)

    // 先武装宽限定时器，再发中断 —— 顺序不能反
    const graceTimer = setTimeout(() => this.#onGraceExpiry(taskID, generation), this.abortGraceMs)
    graceTimer.unref?.()
    this.#timers.set(taskID, { generation, timer: graceTimer, phase: 'grace' })

    // 恰好一次。**发之前先打标**：宿主会因这次中断回 `execution.interrupted`，
    // 事件处理器要靠 interruptReason 把它归因成"墙钟超时"而不是"宿主中断"。
    if (record.interruptSent) return
    this.ledger.update(taskID, { interruptSent: true, interruptReason: 'wall_clock' })
    try {
      await this.interrupt(record)
    } catch (err) {
      this.logger?.debug?.(`[reeve] 中断失败（${taskID}）：${String(err)}`)
    }
  }

  async #onGraceExpiry(taskID, generation) {
    const record = this.ledger.get(taskID)
    if (!record) return
    if (record.generation !== generation) return
    if (record.terminalPublished) return

    // 宽限到期仍未确认 —— 如实标"不确定"，并落超时终态。
    this.ledger.commitTerminal(taskID, STATE.ERROR, {
      source: 'wall-clock',
      reason: REASON.WALL_CLOCK_TIMEOUT,
      timedOut: true,
      statusUncertain: true,
      terminalUnreconciled: true,
    })
    this.#timers.delete(taskID)
  }

  stopAll() {
    for (const entry of this.#timers.values()) clearTimeout(entry.timer)
    this.#timers.clear()
  }
}
