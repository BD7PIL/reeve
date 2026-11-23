// E1 引擎 resume（S6；施工规格 .zcode/plans/e1-construction-spec.md §3 / §5-T3.4 / §6，
// 主计划 P3「崩溃后无损恢复」）。
//
// 职责：中断后的恢复计划——resume(declaration, journal) 把 journal 盘上记账分成「已完成」
// （journal 返还，零 driver 调用——resume 的依赖表里根本没有 driver，零 create 是结构性的；
// T3.4 用 mock 的 calls 数组取数，证的是重跑侧不给已完成步派发）与「未完成」（待重跑）。
// matchAmend(oldDecl, newDecl) 给修订过的声明判定哪些步可沿用旧 run 的 journal 进度。
//
// 分类口径（§5-T3.4 四断言的实现侧依据）：
//   completed: Map<stepId, result> —— journal 里 state='done' 的步。result = done 迁移的
//     payload 原样深拷贝（scheduler 惯例形 { result: { text }, sessionId }；resume 不解释
//     payload 内部字段——「journal 返还」就是字面意思）。无 payload 的 done 归一为 {}。
//   pending: stepId[] —— 声明序中一切非 done 的步：未播种 / declared / 在飞（dispatching、
//     running）/ failed / blocked / superseded 全算「未完成」。在飞步重跑、废步复活、
//     cooldown 与终态回写是调用方接线（§1 failed→dispatching 重入边；scheduler.js 只接
//     declared/done，mid-flight 恢复按规格归本步——接线形态见 engine-resume.test.mjs 的
//     redrive 夹具，S8 试点同一套）。
//
// 保守判定（journal 三铁律的读端镜像）：
//   torn（截断/形状坏/runId 不符/读盘错）与 degraded（写失败劣化实例）→ getStepState 全 null
//   → 一切步归「未完成」（T3.4 断言 4 的「识别为未完成」）。撕裂 journal 可能藏着已完成的步，
//   宁可整段重跑，不可假完成；盘上真相以**新** createJournal 重读为准（journal 铁律 2）。
//
// 与 §3 签名的偏差（加法，不改既定面，沿 journal.js/scheduler.js 先例）：
//   runId 守卫——journal 绑定的 runId ≠ declaration.runId 直接 TypeError（程序级接线错误）。
//   理由：journal record 不存 prompt，跨 run 复用 journal 时 stepId 撞名会把别家 run 的
//   done 误认成本家进度；这种错必须在接线期炸掉，而不是静默错分类。跨声明复用旧 journal
//   的正确性由 matchAmend 把关——调用方契约：resume 的 declaration 必须与写这份 journal 的
//   声明同源（同 stepId 同 prompt 字节；matchAmend 判 imported 之外的步一律不得沿用旧记账）。
//
// P4-A amend（本文件第二个入口）：新声明按 stepId+sha256(prompt) 匹配旧 journal 导入——
// matchAmend（S6）出五类清单，本入口补导入接线：把旧 journal 里「命中且已 done」的步按
// 调度器惯例的 done payload 写进**新 run 的新 journal**，S4 预扫接受 done → 零 driver 调用
// （结构性零重跑：amend 不收 driver）。字节级判据不变：prompt 任何一字之差即 changed，
// 不导入（T4.3）。失败分轨：接线错误（声明不合法/oldJournal 缺面/oldJournal 与 oldDecl
// runId 不符/storage 形状坏）→ TypeError；数据级不可用（旧 journal torn / 新 journal 写败
// 含 fault 注入）→ { ok:false, reason, stage?, status }——宁可整段重跑，不带病导入。
// carried 步在新 journal 按调度器同款四段链落账（declared→dispatching→running→done，attempts=1、
// at=注入时钟）——declared→done 不是合法边，导入不发明第三种记账形态；旧 payload（result.text
// +旧 sessionId）随 done 迁移原样深拷贝落盘。新 journal 另记 amend 审计事件（五类清单）；
// 旧 journal 只读不写（done 证据不动）。
import { createHash } from 'node:crypto'

import { validateDeclaration } from './declaration.js'
import { createJournal } from './journal.js'

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** prompt 的字节指纹（amend 匹配键的一半）：sha256，任何字节不等 → 指纹不等。 */
export function promptFingerprint(prompt) {
  return createHash('sha256').update(prompt, 'utf8').digest('hex')
}

/**
 * 恢复计划：declaration × journal → { completed, pending }。纯读端——不写 journal、不碰
 * driver、无广播面（「journal 写失败→不推进不广播」在 resume 这一层天然成立，T3.5 的
 * resume 侧断言因此落在「恢复接线遇写失败即停、零派发」，见测试）。
 * @param {*} declaration 引擎运行声明（先过 validateDeclaration，不合法 = TypeError）
 * @param {*} journal createJournal 产物（或同面注入件：getStepState + status）
 * @returns {{ completed: Map<string, object>, pending: string[] }}
 *   completed 值 = done 迁移 payload 深拷贝（无 payload 归一 {}）；pending 为声明序 stepId。
 * @throws {TypeError} declaration 不合法 / journal 缺 face / journal 归属 run 与声明 runId 不符
 */
export function resume(declaration, journal) {
  const verdict = validateDeclaration(declaration)
  if (!verdict.ok) throw new TypeError(`resume: declaration 不合法：\n  ${verdict.errors.join('\n  ')}`)
  for (const face of ['getStepState', 'status']) {
    if (typeof journal?.[face] !== 'function') throw new TypeError(`resume: journal 缺 face ${face}（createJournal 产物）`)
  }
  const status = journal.status()
  if (isPlainObject(status) && typeof status.runId === 'string' && status.runId !== declaration.runId) {
    throw new TypeError(
      `resume: journal 归属 run "${status.runId}" 与声明 runId "${declaration.runId}" 不符——journal 不存 prompt，跨 run 复用须经 matchAmend 把关`,
    )
  }
  const completed = new Map()
  const pending = []
  for (const step of declaration.steps) {
    // torn/degraded/未知步 → null → 保守归「未完成」（宁可重跑，不可假完成）
    const known = journal.getStepState(step.stepId)
    if (known && known.state === 'done') {
      // done 是终态（无出边），尾条即 done 迁移；倒序找是防御手搓 record 的形状漂移
      const tail = [...(Array.isArray(known.history) ? known.history : [])].reverse().find((h) => isPlainObject(h) && h.to === 'done')
      completed.set(step.stepId, tail && tail.payload !== undefined ? structuredClone(tail.payload) : {})
    } else {
      pending.push(step.stepId)
    }
  }
  return { completed, pending }
}

/**
 * amend 匹配：oldDecl（写出旧 journal 的声明）× newDecl（修订稿）→ 每步可否沿用旧进度。
 * 判据（规格 §3 钉死）：stepId 相等 **且** sha256(prompt) 字节相等 → imported；任何字节不等
 * 不导入（changed = 同 stepId 不同 prompt；added = newDecl 独有；dropped = oldDecl 独有）。
 * 判据只钉 stepId + prompt 两个字节面：agent/model/deps 等变更不阻塞导入（规格原文口径）；
 * deps 变了是否仍可沿用旧结果，由调用方按依赖语义自行裁决——本函数只报匹配事实。
 * journal 不存 prompt，imported 之外的步不得沿用旧 journal（调用方契约，见 resume 头注）。
 * @returns {{ imported: string[], changed: string[], added: string[], dropped: string[] }}
 *   前三者按 newDecl 声明序，dropped 按 oldDecl 声明序。
 * @throws {TypeError} 任一声明不合法（validateDeclaration）
 */
export function matchAmend(oldDecl, newDecl) {
  for (const [label, decl] of [['oldDecl', oldDecl], ['newDecl', newDecl]]) {
    const verdict = validateDeclaration(decl)
    if (!verdict.ok) throw new TypeError(`matchAmend: ${label} 不合法：\n  ${verdict.errors.join('\n  ')}`)
  }
  const oldFingerprints = new Map(oldDecl.steps.map((s) => [s.stepId, promptFingerprint(s.prompt)]))
  const imported = []
  const changed = []
  const added = []
  const newIds = new Set()
  for (const step of newDecl.steps) {
    newIds.add(step.stepId)
    const old = oldFingerprints.get(step.stepId)
    if (old === undefined) added.push(step.stepId)
    else if (old === promptFingerprint(step.prompt)) imported.push(step.stepId)
    else changed.push(step.stepId)
  }
  const dropped = oldDecl.steps.map((s) => s.stepId).filter((id) => !newIds.has(id))
  return { imported, changed, added, dropped }
}

/**
 * P4-A amend：新声明按 stepId+sha256(prompt) 匹配旧 journal 导入（蓝图 §P4/T4.3「命中零重跑 /
 * prompt 变了不导入（字节级）」）。matchAmend（S6）出五类清单，本函数补导入接线：把旧 journal
 * 里「命中且已 done」的步按调度器惯例的 done payload 写进新 run 的新 journal——S4 预扫接受
 * done、回收 payload 的 text，且对这些步零 driver 调用（结构性零重跑：本函数不收 driver）。
 *
 * 分类（返回值字段）：imported = matchAmend.imported（字节级命中）；carried = imported ∩
 * 旧 journal done（已写入新 journal，零重跑集）；rerun = imported − carried（命中但旧 run
 * 没跑完 → 新 run 重跑）；changed/added/dropped = matchAmend 原样（changed 不导入——字节级；
 * dropped 的旧进度随旧 run 弃置）。carried 步的失败阶段 stage ∈ declared|dispatching|running|done
 * （导入落账链的第一条失败迁移）。
 *
 * 失败分轨：程序级接线错误（声明不合法 / oldJournal 缺 face / oldJournal 与 oldDecl runId
 * 不符 / storage 形状坏）→ TypeError fail-fast；数据级不可用（旧 journal torn / 新 journal
 * 现成记录 / 写败含 fault 注入）→ { ok:false, reason, stage?, stepId?, status }——宁可整段
 * 重跑，不带病导入。
 *
 * @param {*} oldDecl 写出旧 journal 的声明（validateDeclaration）
 * @param {*} newDecl 修订稿声明（validateDeclaration；runId 可与旧不同——新 journal 用它建）
 * @param {*} oldJournal createJournal 产物（须与 oldDecl 同 runId；torn → ok:false）
 * @param {object} opts
 *   - storage: 新 run 的 {read, write}（makeJournalStorage 产物或同形状；必须是**新**存储——
 *     传旧存储会被 createJournal 采纳为现成记录 → ok:false new-journal-not-ok）
 *   - fault:   { failWrite?: 'before'|'mid'|'after' }（§6；生产传 null）
 *   - now:     () => number（默认 Date.now；新 journal 的 at 全走它）
 * @returns {{ok:true, journal, imported, carried, rerun, changed, added, dropped, at}} |
 *          {{ok:false, reason:'old-journal-not-ok'|'new-journal-not-ok'|'journal-not-ok',
 *            stage?:string, stepId?:string, status:object}}
 * @throws {TypeError} 声明不合法 / oldJournal 缺 face / oldJournal 与 oldDecl runId 不符 / storage 形状坏
 */
export function amend(oldDecl, newDecl, oldJournal, opts = {}) {
  const { storage, fault = null, now } = opts ?? {}
  for (const [label, decl] of [['oldDecl', oldDecl], ['newDecl', newDecl]]) {
    const verdict = validateDeclaration(decl)
    if (!verdict.ok) throw new TypeError(`amend: ${label} 不合法：\n  ${verdict.errors.join('\n  ')}`)
  }
  for (const face of ['getStepState', 'status']) {
    if (typeof oldJournal?.[face] !== 'function') throw new TypeError(`amend: oldJournal 缺 face ${face}（createJournal 产物）`)
  }
  const oldStatus = oldJournal.status()
  if (!isPlainObject(oldStatus) || !oldStatus.ok) {
    return { ok: false, reason: 'old-journal-not-ok', status: isPlainObject(oldStatus) ? oldStatus : null }
  }
  if (oldStatus.runId !== oldDecl.runId) {
    throw new TypeError(`amend: oldJournal 归属 run "${oldStatus.runId}" 与 oldDecl.runId "${oldDecl.runId}" 不符——匹配判据是旧声明自己的进度，别拿别家 journal 来配`)
  }
  const nowFn = now ?? Date.now
  const journal = createJournal({ storage, runId: newDecl.runId, fault, now })
  const newStatus = journal.status()
  if (!newStatus.ok) return { ok: false, reason: 'new-journal-not-ok', status: newStatus }
  const verdict = matchAmend(oldDecl, newDecl)
  const completed = resume(oldDecl, oldJournal).completed
  const carried = verdict.imported.filter((id) => completed.has(id))
  const rerun = verdict.imported.filter((id) => !completed.has(id))
  for (const id of carried) {
    // 导入落账走调度器同款四段链（declared→dispatching→running→done）——declared→done 不是
    // 合法边；attempts 随链落到 1（新账本如实记录「导入落账」形式，不发明第三种记账形态）。
    for (const [from, to] of [
      [null, 'declared'],
      ['declared', 'dispatching'],
      ['dispatching', 'running'],
      ['running', 'done'],
    ]) {
      const payload = to === 'done' ? completed.get(id) : undefined
      if (!journal.appendStepState(id, from, to, payload).ok) {
        return { ok: false, reason: 'journal-not-ok', stage: to, stepId: id, status: journal.status() }
      }
    }
  }
  const audit = { imported: verdict.imported, carried, rerun, changed: verdict.changed, added: verdict.added, dropped: verdict.dropped }
  if (!journal.recordEvent('amend', audit).ok) {
    return { ok: false, reason: 'journal-not-ok', stage: 'audit', status: journal.status() }
  }
  return { ok: true, journal, ...audit, at: nowFn() }
}
