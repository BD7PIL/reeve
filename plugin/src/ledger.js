// REEVE 台账：子任务登记表。
//
// 为什么必须自持：opencode v2 **不把 session.list / session.children / session.status 交给插件**
// （施工图 §6）。所以"谁在跑、谁死了"这份账只能插件自己记。
//
// 两条正确性性质（本项目最贵的 bug 是"静默不一致"，不是崩溃）：
//   1. 终态一旦发布就**不可被迟到的完成/忙碌覆盖**（commitTerminal 的单调性）
//   2. 墓碑一旦立下就**不可复活**（跨重启对账不要造出永远在跑的幽灵）

import { STORAGE_PREFIX, STATE, TERMINAL_STATES, newRecord } from './constants.js'

export class Ledger {
  /** @type {Map<string, object>} taskID -> record */
  #records = new Map()
  /** @type {Map<string, string>} childSessionID -> taskID */
  #byChild = new Map()
  /** @type {Set<string>} 已墓碑的 taskID —— 永不复活 */
  #tombstones = new Set()

  constructor({ storage = null, logger = console } = {}) {
    this.storage = storage
    this.logger = logger
    // 变更通知：给只读快照用。**同步、绝不 await** —— 记账不能被视图拖慢。
    this.onChange = null
  }

  #changed() {
    try {
      this.onChange?.()
    } catch {
      /* 视图的问题不是记账的问题 */
    }
  }

  static storageKey(taskID) {
    return STORAGE_PREFIX + taskID
  }

  create(rec) {
    const record = newRecord(rec)
    this.#records.set(record.taskID, record)
    if (record.childSessionID) this.#byChild.set(record.childSessionID, record.taskID)
    void this.persist(record.taskID)
    this.#changed()
    return record
  }

  get(taskID) {
    return this.#records.get(taskID) ?? null
  }

  /** 子会话 id 是 `subagent` 工具的输出解析出来的，可能晚于创建。 */
  attachChild(taskID, childSessionID) {
    const record = this.#records.get(taskID)
    if (!record || !childSessionID) return record ?? null
    record.childSessionID = childSessionID
    this.#byChild.set(childSessionID, taskID)
    void this.persist(taskID)
    this.#changed()
    return record
  }

  forChildSession(childSessionID) {
    const taskID = this.#byChild.get(childSessionID)
    return taskID ? (this.#records.get(taskID) ?? null) : null
  }

  update(taskID, patch) {
    const record = this.#records.get(taskID)
    if (!record) return null
    Object.assign(record, patch)
    record.lastActivityAt = Date.now()
    void this.persist(taskID)
    this.#changed()
    return record
  }

  /**
   * 落终态。**单调**：已发布的终态不会被再次写入覆盖。
   * @returns {boolean} 是否真的写入了（false = 已有终态，被拒绝）
   */
  commitTerminal(taskID, state, { source = null, reason = null, ...extra } = {}) {
    const record = this.#records.get(taskID)
    if (!record) return false
    if (record.terminalPublished) {
      this.logger?.debug?.(
        `[reeve] 拒绝覆盖已发布的终态：${taskID} 已是 ${record.state}，忽略迟到的 ${state}`,
      )
      return false
    }
    if (!TERMINAL_STATES.has(state)) return false
    Object.assign(record, extra, {
      state,
      reason,
      terminalSource: source,
      terminalPublished: true,
      endedAt: Date.now(),
      statusUncertain: extra.statusUncertain ?? false,
    })
    void this.persist(taskID)
    this.#changed()
    return true
  }

  /** 在飞的（父会话维度）。parentSessionID 省略则返回全部在飞的。 */
  running(parentSessionID = null) {
    const out = []
    for (const r of this.#records.values()) {
      if (r.state !== STATE.RUNNING) continue
      if (parentSessionID && r.parentSessionID !== parentSessionID) continue
      out.push(r)
    }
    return out
  }

  all() {
    return [...this.#records.values()]
  }

  tombstone(taskID, reason) {
    this.#tombstones.add(taskID)
    const record = this.#records.get(taskID)
    if (record) {
      // 拆除：不留幽灵。终态为 reconciled，明确标"不是正常结束"。
      this.commitTerminal(taskID, STATE.RECONCILED, {
        source: 'reconcile',
        reason,
        terminalUnreconciled: true,
      })
      if (record.childSessionID) this.#byChild.delete(record.childSessionID)
    }
    void this.persist(taskID)
    this.#changed()
  }

  isTombstoned(taskID) {
    return this.#tombstones.has(taskID)
  }

  // ---- 持久化（best-effort，绝不因为落盘失败而打断记账）----

  async persist(taskID) {
    if (!this.storage) return
    const record = this.#records.get(taskID)
    if (!record) return
    try {
      await this.storage.set(Ledger.storageKey(taskID), toJson(record))
      if (this.#tombstones.has(taskID)) {
        await this.storage.set(Ledger.storageKey(taskID) + '.tombstone', true)
      }
    } catch (err) {
      this.logger?.debug?.(`[reeve] 台账落盘失败（忽略）：${String(err)}`)
    }
  }

  /**
   * 启动时把盘上的账读回来。
   * **注意**：恢复是 best-effort，别名与终态结果**不恢复**；
   * 重启时仍在 running 的记录一律标 statusUncertain —— **如实标未知，不谎报**。
   *
   * @returns {Promise<{loaded:number, truncated:boolean, pages:number}>}
   *   `truncated: true` = 存储没有返回游标但取满了一页，**可能还有没读到的记录**。
   *   这是"静默不一致"的一个入口，所以**不吞掉**，交给调用方决定怎么报。
   */
  async hydrate() {
    if (!this.storage?.scan) return { loaded: 0, truncated: false, pages: 0 }
    let loaded = 0
    let pages = 0
    let truncated = false
    const PAGE = 500
    try {
      let after
      for (;;) {
        const page = await this.storage.scan({ prefix: STORAGE_PREFIX, after, limit: PAGE })
        const entries = page?.entries ?? []
        pages += 1
        for (const entry of entries) {
          if (entry.key.endsWith('.tombstone')) {
            this.#tombstones.add(entry.key.slice(0, -'.tombstone'.length).replace(STORAGE_PREFIX, ''))
            continue
          }
          const record = fromJson(entry.value)
          if (!record?.taskID) continue
          this.#records.set(record.taskID, record)
          if (record.childSessionID) this.#byChild.set(record.childSessionID, record.taskID)
          loaded += 1
        }
        if (!page?.next) {
          // 取满一页却没有游标 —— 存储可能不支持分页。如实标记，别假装读全了。
          if (entries.length >= PAGE) truncated = true
          break
        }
        after = page.next
      }
    } catch (err) {
      this.logger?.debug?.(`[reeve] 台账恢复失败（忽略）：${String(err)}`)
      return { loaded, truncated, pages }
    }

    if (truncated) {
      this.logger?.debug?.(
        `[reeve] ⚠️ 台账恢复可能不完整：scan 取满 ${PAGE} 条但没有返回游标（已恢复 ${loaded} 条）。` +
          `未读到的记录不会出现在台账里 —— 这是静默不一致，请检查 ctx.storage.scan 的分页。`,
      )
    }

    // 重启后仍在 running 的一律标未知 —— 不要谎报 running，也不要谎报 completed。
    for (const record of this.#records.values()) {
      if (record.state === STATE.RUNNING) {
        record.statusUncertain = true
        record.reason = 'host_restarted'
      }
    }
    if (loaded > 0) this.#changed()
    return { loaded, truncated, pages }
  }

  /**
   * 保留期修剪：删掉**已落终态**且超过保留期的记录，以及过期的墓碑。
   * **只动终态**——在飞记录永不修剪（哪怕很老，那也是"账还没结"）。
   * 为什么需要：台账只增不减，跑一年会攒到几万条 → 启动扫描变慢、内存与盘都涨。
   * @returns {Promise<number>} 删掉的条数
   */
  async prune({ olderThanMs = 30 * 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
    const cutoff = now - olderThanMs
    let removed = 0
    for (const [taskID, record] of [...this.#records.entries()]) {
      if (record.state === STATE.RUNNING) continue // 在飞的一律不动
      if (!record.endedAt || record.endedAt > cutoff) continue
      this.#records.delete(taskID)
      if (record.childSessionID) this.#byChild.delete(record.childSessionID)
      this.#tombstones.delete(taskID)
      try {
        await this.storage?.remove?.(Ledger.storageKey(taskID))
        await this.storage?.remove?.(Ledger.storageKey(taskID) + '.tombstone')
      } catch (err) {
        this.logger?.debug?.(`[reeve] 修剪落盘失败（忽略）：${String(err)}`)
      }
      removed += 1
    }
    if (removed > 0) this.#changed()
    return removed
  }
}

function toJson(record) {
  return JSON.parse(JSON.stringify(record))
}

function fromJson(value) {
  if (!value || typeof value !== 'object') return null
  return { ...value }
}
