// E1 引擎 journal（S2；施工规格 .zcode/plans/e1-construction-spec.md §3/§5-T3.4/§5-T3.5/§6，
// 主计划 P3「journal 先落盘再广播」）。
//
// 职责：run 内步状态的持久化真相 + engine-owned 会话集（§1 级联守卫的锚点）+ 审计事件。
// 宿主无关：不 import 任何宿主面，落盘走注入的 storage（{read, write}）。
//
// 三条铁律：
//   1. **先落盘再动作**：状态迁移先把整份记录经 storage.write 落盘（makeJournalStorage =
//      plan-gate 同款「同目录 tmp + rename 原子替换」），盘上成功才提交内存、才广播（onEvent）。
//   2. **写失败 fail-closed**：落盘抛错（或 fault 注入）→ 该次调用返 {ok:false}——内存不推进、
//      不广播，实例就地劣化（degraded）：后续读写一律按 deny 收敛。磁盘真相用**新** createJournal
//      重读获得；绝不拿陈旧内存覆盖盘（这是 T3.5「写失败→不推进不广播」的 journal 侧）。
//   3. **torn = 无记录 = deny（plan-gate readStore 同款保守）**：读到的文件 JSON 解析不过 /
//      形状不过 / runId 不符 / 读盘抛错 → torn：只读作废、永不重建、撕裂字节原样保留
//      （自动化写入会销毁「可能已完成」的证据；与 plan-gate 矩阵 dispatch-review#4 同哲学）。
//
// 状态机（§3 + P4-E 增量）：declared → dispatching → running → done | failed | blocked | superseded；
// done/superseded 是终态（无出边）；failed→dispatching 是 attempt 循环的重入边（§1：失败计数
// 持久化、maxAttempts 含初派、cooldown 取上一条 dispatching 时间戳都靠它）；blocked→dispatching
// 是 P4-E 的恢复重入边（问句挂起的步在人工答复后重派，attempts/lastDispatchAt 同 dispatching
// 语义刷新——蓝图 §P4「答复后恢复」）。
// 「单向」= 进度不回退：running 及各终态永不回到早前态；且每条迁移都带 from 校验（stale-from
// 即拒）——同 step 的第二个 in-flight 无法成立（§1 in-flight 去重的 journal 保证）。
//
// fault 注入（§6，构造参数，禁 monkey-patch）：fault.failWrite = 'before'|'mid'|'after'，生产传 null。
//   - before：写盘之前即失败——盘上保持旧记录（完好）；
//   - mid：把**截断一半的序列化文本**经正常通道写盘后报失败——盘上是撕裂 JSON（T3.4 的
//     「mid 注入产生的截断 journal」从这条来；模拟 tmp+rename 所防的崩溃中间态）；
//   - after：完整落盘成功**之后**报失败——盘上已是新真相（恢复口径：以盘为准，重读即得，
//     不需要也不会重放这次迁移）；内存不推进、不广播照旧（「先落盘再广播」的顺序证据）。
//   三形态下调用方拿到的都是 {ok:false}——对调用方无差别，差别只在盘上。
//
// 时钟（§6）：now?: () => number（默认 Date.now）；at/updatedAt/lastDispatchAt 全走它。
//
// 与 §3 签名的偏差（都是加法，不改既定面）：附加 markEngineSession(sessionId)（engine-owned
// set 的写入口）、status()（torn/degraded 显式读数，S4 fail-closed 要用）、onEvent 可选构造参数
// （「广播」的出口）。规格依赖表列了 journal ← schema：record 的形状是 journal 本地事实，
// declaration.schema.json 无可消费之物，不为对表而 import。
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 状态机全集（§3）。 */
export const JOURNAL_STATES = Object.freeze(['declared', 'dispatching', 'running', 'done', 'failed', 'blocked', 'superseded'])

/**
 * journal record 形状版本（P1.2 第 8 条，lightflow passport_version 先例）：emptyRecord 写
 * version: 1，为 record 形状未来演进留迁移缝。读旧 record（无 version 字段——本版本之前的
 * 盘上真相）兼容放行 + console.warn 一条（createJournal 装载路径记，validateJournalRecord
 * 保持纯函数不吭声）；带 version 但 ≠ 本版本的一律 torn（shape-invalid）——未来形状不猜，
 * 宁可 fail-closed 让人来看，不静默误读。
 */
export const JOURNAL_RECORD_VERSION = 1

/**
 * 合法迁移表。键=当前态，值=允许的下一态；null（未注册）只允许到 declared（播种）。
 * failed→dispatching（attempt 循环）与 blocked→dispatching（P4-E 问句答复后恢复）是仅有的
 * 两条重入边；done/superseded 无出边。
 */
export const LEGAL_TRANSITIONS = Object.freeze({
  declared: Object.freeze(['dispatching', 'superseded']),
  dispatching: Object.freeze(['running', 'failed']),
  running: Object.freeze(['done', 'failed', 'blocked', 'superseded']),
  failed: Object.freeze(['dispatching']),
  blocked: Object.freeze(['dispatching']), // P4-E：escalation 答复后恢复（scheduler resumeEscalations 专用）
})

const FAILWRITE_FORMS = Object.freeze(['before', 'mid', 'after'])
const HISTORY_LIMIT = 200 // 单步历史上限（防长跑膨胀；裁最旧的迁移，终态与计数不受影响）

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v)

// ── storage 层：plan-gate makeStoreIo 同款（§3「复用 plan-gate 同款」）──────────

/** runId → 安全文件名主干（plan-gate storeStem 同款清洗，防路径穿越）。 */
export function journalStoreStem(runId) {
  const stem = String(runId ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '_')
  return stem.length > 0 ? stem.slice(0, 180) : ''
}

let tmpSeq = 0

/**
 * journal 的默认 storage：每 run 一个文件 `<主干>.journal.json`。
 * read：缺失（ENOENT）→ null（「无记录」基线）；其余错误向上传播（createJournal 收敛为 torn）。
 * write：同目录 tmp + renameSync 原子替换（Node 在 Windows 上也走替换语义；plan-gate 同款），
 * 失败尽力清理 tmp 后重抛。
 */
export function makeJournalStorage(root, runId) {
  const stem = journalStoreStem(runId)
  if (!stem) throw new TypeError('makeJournalStorage: runId 清洗后为空，拒建 storage')
  const file = join(root, `${stem}.journal.json`)
  return {
    root,
    file,
    stem,
    read() {
      try {
        return readFileSync(file, 'utf8')
      } catch (error) {
        if (error && error.code === 'ENOENT') return null
        throw error
      }
    },
    write(text) {
      mkdirSync(root, { recursive: true })
      const tmp = join(root, `.${stem}.journal.tmp-${process.pid}-${Date.now()}-${tmpSeq++}`)
      try {
        writeFileSync(tmp, text, 'utf8')
        renameSync(tmp, file)
      } catch (error) {
        try {
          unlinkSync(tmp)
        } catch {
          /* 尽力清理，清理失败不掩盖原错误 */
        }
        throw error
      }
    },
  }
}

// ── record 形状校验（torn 识别的「形状不过」半边）────────────────────────────

function stepShapeOk(step) {
  if (!isPlainObject(step)) return false
  if (!JOURNAL_STATES.includes(step.state)) return false
  if (!Number.isInteger(step.attempts) || step.attempts < 0) return false
  if (step.lastDispatchAt !== undefined && !isFiniteNum(step.lastDispatchAt)) return false
  if (!Array.isArray(step.history)) return false
  return step.history.every((h) => isPlainObject(h) && (h.from === null || JOURNAL_STATES.includes(h.from)) && JOURNAL_STATES.includes(h.to) && isFiniteNum(h.at))
}

/** 顶层形状校验（plan-gate validateStoreRecord 同哲学：顶层从严、深层适度）。合法返回原值，否则 null。 */
export function validateJournalRecord(value) {
  if (!isPlainObject(value)) return null
  if (value.version !== undefined && value.version !== JOURNAL_RECORD_VERSION) return null // 旧 record 无 version 放行；未来版本不猜
  if (typeof value.runId !== 'string' || value.runId.length === 0) return null
  if (!isFiniteNum(value.updatedAt)) return null
  if (!isPlainObject(value.steps)) return null
  for (const step of Object.values(value.steps)) {
    if (!stepShapeOk(step)) return null
  }
  if (!Array.isArray(value.engineSessions) || !value.engineSessions.every((s) => typeof s === 'string' && s.length > 0)) return null
  if (!Array.isArray(value.events)) return null
  if (!value.events.every((e) => isPlainObject(e) && typeof e.type === 'string' && e.type.length > 0 && isFiniteNum(e.at))) return null
  return value
}

function emptyRecord(runId, nowMs) {
  return { version: JOURNAL_RECORD_VERSION, runId, updatedAt: nowMs, steps: {}, engineSessions: [], events: [] }
}

// ── journal 核心 ─────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {{read: () => string|null, write: (text: string) => void}} opts.storage 落盘通道（makeJournalStorage 产物或同形状注入件）
 * @param {string} opts.runId 本 journal 归属的 run（与 record.runId 不符 = torn）
 * @param {{failWrite?: 'before'|'mid'|'after'}|null} [opts.fault] 故障注入（§6；生产传 null）
 * @param {() => number} [opts.now] 时钟注入（默认 Date.now）
 * @param {(event: object) => void} [opts.onEvent] 广播出口：每次成功落盘后逐条回调（先落盘再广播；回调抛错只吞掉，不回滚）
 */
export function createJournal({ storage, runId, fault = null, now, onEvent } = {}) {
  if (!isPlainObject(storage) || typeof storage.read !== 'function' || typeof storage.write !== 'function') {
    throw new TypeError('createJournal: storage 必须是 {read, write}（makeJournalStorage 产物或同形状注入件）')
  }
  if (typeof runId !== 'string' || runId.length === 0) throw new TypeError('createJournal: runId 必须是非空字符串')
  if (now !== undefined && typeof now !== 'function') throw new TypeError('createJournal: now 必须是 () => number')
  if (onEvent !== undefined && typeof onEvent !== 'function') throw new TypeError('createJournal: onEvent 必须是回调函数')
  if (fault !== null && fault !== undefined && !isPlainObject(fault)) throw new TypeError('createJournal: fault 必须是对象或 null')
  const failWrite = fault?.failWrite
  if (failWrite !== undefined && failWrite !== null && !FAILWRITE_FORMS.includes(failWrite)) {
    throw new TypeError(`createJournal: fault.failWrite 必须是 ${FAILWRITE_FORMS.join('|')}（得到 ${String(failWrite)}）`)
  }
  const nowFn = now ?? Date.now
  // abortAt（scheduler 的注入点）/driverChaos（driver 的）不是 journal 的消费项，按 §6 分工静默忽略。

  let record = null // 内存真相；仅在落盘成功后整体替换（先落盘再动作）
  let torn = null // null | { reason: 'unparseable'|'shape-invalid'|'run-mismatch'|'read-error', error? }
  let fresh = false
  let degraded = false // 写失败/故障后就地劣化：读写一律 deny，磁盘真相须新开 journal 重读

  const raw = (() => {
    try {
      return storage.read()
    } catch (error) {
      torn = { reason: 'read-error', error: String(error?.message ?? error).slice(0, 160) }
      return null
    }
  })()
  if (!torn) {
    if (raw == null) {
      fresh = true
      record = emptyRecord(runId, nowFn())
    } else {
      let parsed = null
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = null
      }
      if (parsed === null) torn = { reason: 'unparseable' }
      else {
        const rec = validateJournalRecord(parsed)
        if (!rec) torn = { reason: 'shape-invalid' }
        else if (rec.runId !== runId) torn = { reason: 'run-mismatch' }
        else {
          // 旧版本 record（无 version 字段）兼容放行：按 v1 解释并就地补版本戳（下次落盘即带上）；
          // 显式记 warn（P1.2 第 8 条迁移缝）。
          const legacy = rec.version === undefined
          if (legacy) {
            console.warn(`[reeve journal] run "${runId}"：盘上 record 缺 version 字段（旧版本形状），按 v${JOURNAL_RECORD_VERSION} 兼容读取；下次落盘将补写 version`)
          }
          record = legacy ? { ...rec, version: JOURNAL_RECORD_VERSION } : rec
        }
      }
    }
  }

  const denied = () => (degraded ? { ok: false, degraded: true, reason: 'degraded' } : { ok: false, torn: true, reason: torn.reason })
  const blocked = () => Boolean(torn || degraded)
  const broadcast = (event) => {
    if (!onEvent) return
    try {
      onEvent(event)
    } catch {
      /* 广播失败不回滚盘/内存：持久化已成功，监听方自负责 */
    }
  }
  const trimHistory = (history) => (history.length > HISTORY_LIMIT ? history.slice(history.length - HISTORY_LIMIT) : history)

  /**
   * 落盘三段式：先按 fault 变形（before 不写 / mid 写半截 / after 写全量），再按结果决定
   * 提交内存+广播（成功路径）或就地劣化（失败路径）。对调用方三形态同形：{ok:false}。
   */
  function persist(next) {
    const text = JSON.stringify(next, null, 2)
    if (failWrite === 'before') {
      degraded = true
      return { ok: false, reason: 'fault-failWrite', form: 'before', degraded: true }
    }
    try {
      storage.write(failWrite === 'mid' ? text.slice(0, Math.max(1, Math.floor(text.length / 2))) : text)
    } catch (error) {
      degraded = true
      return { ok: false, reason: 'write-failed', error: String(error?.message ?? error).slice(0, 160), degraded: true }
    }
    if (failWrite === 'mid' || failWrite === 'after') {
      degraded = true
      return { ok: false, reason: 'fault-failWrite', form: failWrite, degraded: true }
    }
    record = next
    return { ok: true }
  }

  return {
    /** 注册/迁移步状态。from=null 只允许播种到 declared；from 必须与 journal 记账的当前态一致。 */
    appendStepState(stepId, from, to, payload) {
      if (blocked()) return denied()
      if (typeof stepId !== 'string' || stepId.length === 0) throw new TypeError('appendStepState: stepId 必须是非空字符串')
      if (!JOURNAL_STATES.includes(to)) throw new TypeError(`appendStepState: to 必须是状态（${JOURNAL_STATES.join('|')}；得到 ${String(to)}）`)
      const known = Object.hasOwn(record.steps, stepId) ? record.steps[stepId] : null
      const current = known ? known.state : null
      if (from === null || from === undefined) {
        if (to !== 'declared') {
          return { ok: false, reason: 'illegal-transition', from: null, to, detail: '未注册步只能播种到 declared' }
        }
        if (known) return { ok: false, reason: 'illegal-transition', from: current, to, detail: '步已注册，重复播种' }
      } else {
        if (!JOURNAL_STATES.includes(from)) throw new TypeError(`appendStepState: from 必须是状态或 null（得到 ${String(from)}）`)
        if (current !== from) return { ok: false, reason: 'stale-from', from, to, current }
        if (!(LEGAL_TRANSITIONS[current] ?? []).includes(to)) {
          return { ok: false, reason: 'illegal-transition', from: current, to, detail: `终态/进度不回退：${current} 无出边到 ${to}` }
        }
      }
      const at = nowFn()
      const attempts = to === 'dispatching' ? (known?.attempts ?? 0) + 1 : (known?.attempts ?? 0)
      const entry = { from: current, to, at }
      if (payload !== undefined) entry.payload = payload
      const history = trimHistory([...(known?.history ?? []), entry])
      const step = { state: to, attempts, history }
      if (to === 'dispatching') step.lastDispatchAt = at
      else if (known?.lastDispatchAt !== undefined) step.lastDispatchAt = known.lastDispatchAt
      const next = { ...record, updatedAt: at, steps: { ...record.steps, [stepId]: step } }
      const result = persist(next)
      if (!result.ok) return result
      const event = { kind: 'step-state', runId, stepId, from: current, to, at, attempts }
      if (payload !== undefined) event.payload = payload
      broadcast(event)
      return { ok: true, stepId, from: current, to, at, attempts }
    },

    /** 非迁移类审计事件（超时/probe 放行/escalate…）；迁移类走 appendStepState，别双记。 */
    recordEvent(type, payload) {
      if (blocked()) return denied()
      if (typeof type !== 'string' || type.length === 0) throw new TypeError('recordEvent: type 必须是非空字符串')
      const at = nowFn()
      const entry = { type, at }
      if (payload !== undefined) entry.payload = payload
      const next = { ...record, updatedAt: at, events: [...record.events, entry] }
      const result = persist(next)
      if (!result.ok) return result
      const event = { kind: 'record', runId, type, at }
      if (payload !== undefined) event.payload = payload
      broadcast(event)
      return { ok: true, type, at, events: next.events.length }
    },

    /** engine-owned set 写入口（§1 级联守卫：引擎自建子会话记账，防把自家 idle 当新触发源）。幂等。 */
    markEngineSession(sessionId) {
      if (blocked()) return denied()
      if (typeof sessionId !== 'string' || sessionId.length === 0) throw new TypeError('markEngineSession: sessionId 必须是非空字符串')
      if (record.engineSessions.includes(sessionId)) return { ok: true, added: false, sessionId }
      const at = nowFn()
      const next = { ...record, updatedAt: at, engineSessions: [...record.engineSessions, sessionId] }
      const result = persist(next)
      if (!result.ok) return result
      broadcast({ kind: 'engine-session', runId, sessionId, at })
      return { ok: true, added: true, sessionId }
    },

    /** 步的当前记账（含 attempts/lastDispatchAt/history）；未知步或 torn/degraded → null。 */
    getStepState(stepId) {
      if (blocked()) return null
      if (typeof stepId !== 'string' || stepId.length === 0) throw new TypeError('getStepState: stepId 必须是非空字符串')
      const known = Object.hasOwn(record.steps, stepId) ? record.steps[stepId] : null
      if (!known) return null
      return { stepId, state: known.state, attempts: known.attempts, lastDispatchAt: known.lastDispatchAt, history: [...known.history] }
    },

    /** 全步快照 {stepId → {state, attempts, lastDispatchAt?}}；torn/degraded → null（deny，不是空对象）。 */
    listSteps() {
      if (blocked()) return null
      const out = {}
      for (const [id, step] of Object.entries(record.steps)) {
        out[id] = { state: step.state, attempts: step.attempts, lastDispatchAt: step.lastDispatchAt }
      }
      return out
    },

    /** engine-owned set 读数；torn/degraded → false（deny：宁可不认自家会话，不可错认）。 */
    isEngineSession(sessionId) {
      if (blocked()) return false
      return record.engineSessions.includes(sessionId)
    },

    /** 显式读数：torn/degraded/fresh 与原因（S4 调度器 fail-closed 的判定入口）。 */
    status() {
      if (torn) return { ok: false, torn: true, degraded: false, fresh: false, runId, reason: torn.reason }
      if (degraded) return { ok: false, torn: false, degraded: true, fresh: false, runId, reason: 'degraded' }
      return { ok: true, torn: false, degraded: false, fresh, runId, reason: null, updatedAt: record.updatedAt, stepCount: Object.keys(record.steps).length }
    },
  }
}
