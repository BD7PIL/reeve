// 会话状态机（GATE 里唯一的一份回退状态）。
//
// 语义（复刻自 v1 时代那套 fallback 的行为规格）：
//   · **单向推进**：候选指针只增不减（attemptCount/fallbackIndex 语义）；
//   · **粘性**：切换成功后，同一 session 的后续请求从切换到的那个候选起（不回头）；
//   · **冷却**：失败的候选取记时间戳，冷却期（默认 60s）内不再被选；
//   · **可选恢复**：`restore_primary_after_cooldown` 为真且所有失败记录的冷却都过期 → 指针归零；
//   · **并发安全**：同一 session 的两次失败只推进一次（`advance` 带去重键）；
//   · **有界内存**：按 TTL 驱逐 + 条数上限。
//
// 时间是注入的（测试用假时钟，不 sleep）。
export function createSessionStore({ now = Date.now, policy = {}, maxSessions = 10_000 } = {}) {
  // policy 允许传函数（配置热更后策略即时生效，状态不必重建）
  const readPolicy = () => (typeof policy === 'function' ? policy() ?? {} : policy)
  const ttlMs = () => Math.max(1, Number(readPolicy().session_ttl_seconds ?? 1800)) * 1000
  const cooldownMs = () => Math.max(0, Number(readPolicy().cooldown_seconds ?? 60)) * 1000
  /** @type {Map<string, {agent: string|null, touchedAt: number, chains: Map<string, {index: number, failed: Map<string, number>, lastNext: {key: string, model: string|null}|null}>}>} */
  const sessions = new Map()

  const record = (sessionID) => {
    let rec = sessions.get(sessionID)
    if (!rec) {
      rec = { agent: null, touchedAt: now(), chains: new Map() }
      sessions.set(sessionID, rec)
    }
    rec.touchedAt = now()
    return rec
  }
  const chainRec = (sessionID, chainName) => {
    const rec = record(sessionID)
    let c = rec.chains.get(chainName)
    if (!c) {
      c = { index: 0, failed: new Map(), lastNext: null }
      rec.chains.set(chainName, c)
    }
    return c
  }
  const sweep = () => {
    const cutoff = now() - ttlMs()
    for (const [id, rec] of sessions) if (rec.touchedAt < cutoff) sessions.delete(id)
    if (sessions.size <= maxSessions) return
    // 超上限：按 touchedAt 从旧到新驱逐
    const ordered = [...sessions.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)
    for (let i = 0; i < ordered.length - maxSessions; i++) sessions.delete(ordered[i][0])
  }

  const cooling = (rec, key) => {
    const failedAt = rec.failed.get(key)
    if (failedAt === undefined) return false
    if (cooldownMs() === 0) return false
    const alive = now() - failedAt < cooldownMs()
    if (!alive) rec.failed.delete(key) // 过期即清（顺带把恢复判断简化）
    return alive
  }

  return {
    now,
    cooldownMs,
    setAgent(sessionID, agent) {
      if (typeof sessionID !== 'string' || sessionID.length === 0) return
      record(sessionID).agent = typeof agent === 'string' && agent.length > 0 ? agent : null
      sweep()
    },
    agentOf(sessionID) {
      const rec = sessions.get(sessionID)
      if (!rec) return null
      if (now() - rec.touchedAt >= ttlMs()) {
        sessions.delete(sessionID)
        return null
      }
      return rec.agent
    },
    /** 该 session 在这条链上的起点索引（粘性 + 冷却后恢复）。 */
    startIndex(sessionID, chainName, keys) {
      const rec = chainRec(sessionID, chainName)
      if (rec.index > 0 && readPolicy().restore_primary_after_cooldown === true) {
        const anyCooling = keys.some((k) => cooling(rec, k))
        if (!anyCooling) rec.index = 0
      }
      return Math.min(rec.index, Math.max(0, keys.length - 1))
    },
    /** 某个候选此刻是不是在冷却里。 */
    isCooling(sessionID, chainName, key) {
      return cooling(chainRec(sessionID, chainName), key)
    },
    /** 失败：记时间戳（冷却起点）。**不**推进指针（推进由 noteSuccess/advance 决定）。 */
    noteFailure(sessionID, chainName, key) {
      const rec = chainRec(sessionID, chainName)
      rec.failed.set(key, now())
      sweep()
    },
    /** 成功：把指针钉在这个候选上（粘性）。 */
    noteSuccess(sessionID, chainName, key, keys) {
      const rec = chainRec(sessionID, chainName)
      const at = keys.indexOf(key)
      if (at >= 0) rec.index = at
      rec.failed.delete(key)
      sweep()
    },
    /**
     * 插件侧要"下一个候选"时用（流已开始/沉默这两类层内换不了的情形）。
     * `dedupeKey` 保证同一次失败被两条事件各触发一次时**只推进一次**。
     * @returns {{ model: string|null, index: number }} model 为 null = 没有下一个了
     */
    advance(sessionID, chainName, keys, { dedupeKey = null } = {}) {
      const rec = chainRec(sessionID, chainName)
      if (dedupeKey !== null && rec.lastNext?.key === dedupeKey) return { model: rec.lastNext.model, index: rec.index }
      const from = Math.max(rec.index, 0)
      let nextIndex = -1
      for (let i = from + 1; i < keys.length; i++) {
        if (cooling(rec, keys[i])) continue
        nextIndex = i
        break
      }
      const model = nextIndex >= 0 ? keys[nextIndex] : null
      if (nextIndex >= 0) rec.index = nextIndex
      rec.lastNext = { key: dedupeKey, model }
      sweep()
      return { model, index: rec.index }
    },
    snapshot() {
      return {
        sessions: sessions.size,
        cooling: [...sessions.values()].reduce((n, r) => n + [...r.chains.values()].reduce((m, c) => m + [...c.failed.keys()].filter((k) => cooling(c, k)).length, 0), 0),
      }
    },
    size: () => sessions.size,
  }
}