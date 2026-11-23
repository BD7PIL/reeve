// C2 hole patch（优化方案 v3.1「C2」行 + spike .zcode/plans/evidence/c2-hole-patch-spike.md，
// 六题方案已写死照做）：补段机械化入口 applyPatch——把「补段后的完整脚本文本」落成新文件、
// 经 journal 记 'patch' 事件，供调用方走既有 review_gate register（kind:'workflow-script'，
// 零新门面）→ resumeScript 重跑。
//
// 实现模型 A（spike 收敛）：补段 = 编辑后的完整脚本的一部分（文本追加/原位注入），不存在
// 续栈——重跑是**新一次 runScript 调用**，前缀返还完全寄生 C1 v2 三条件导入规则（作用点位置
// + hole/escalate 空判据 + prompt 哈希，resume-script.js 读端）。本文件不执行脚本、不碰
// driver：一次调用 = 读 base 字节 → 算指纹与变更边界 → 读盘上 journal（patchSeq/callSeq）→
// 写补段文件 → 记 patch 事件。
//
// 事件形状（spike 必答题①）：journal.recordEvent('patch', payload)——validateJournalRecord
// 对 events 只查 {type 非空串, at 有限数}（journal.js:137-139），payload 自由形 → 零 schema
// 迁移。payload 写死：{ patchSeq, baseFingerprint, patchedFingerprint, anchor: 'hole-site'|'tail',
// holeRef?: {kind:'hole'|'escalate', seq}, appliedAfterCallSeq, reason, source }。
//   - patchSeq 从 1 起，按盘上既有 patch 事件的 max(patchSeq)+1 递增（多 patch 自然成链，
//     不做额外结构）；补段文件名同序：`<stem>.patch-<patchSeq><ext>`（与 base 同目录）。
//   - appliedAfterCallSeq = 盘上事件 payload.callSeq 的最大值（ask/ask-failed 都带 callSeq；
//     无任何带 callSeq 的事件 → 0）——补段应用时点的执行序锚点。
//   - resumeScript 只收 type='ask'（resume-script.js:131）→ patch 事件零污染 ask 缓存；
//     C3 打捞按 events 渲染 → 补段边界进报告（salvage-report.js 补段边界节）。
//
// 补段身份与门禁（spike 必答题⑤）：产物 = 编辑后的**完整**脚本文件，走既有 review_gate
// register kind:'workflow-script'（语法门同一 compileScriptBody 包装、scanRunCommands 天然
// 覆盖补段新增命令字面量、哈希绑全字节、check 走同一决策矩阵零新行）。patch 身份
// （base→patched 指纹）由 journal 'patch' 事件承载，不进 gate。换字节 → 旧 verdict 哈希失配
// → 门禁关闭直到重评（plan-gate D1 fail-closed）→ **每补段必经一轮模型评审才有 allow**。
//
// 变更边界与重跑失败归类（spike 必答题④的判定机制，最简实现）：本文件有 base 与 patched
// 两份文本 → 直接算首个变更字节偏移 changedFrom（JS 字符串下标，与 prefixHash 的
// script.slice 切片域同一坐标系）；applyPatch 把它随结果返回，调用方经 runScript 新 opts
// `patchFrom` 传入。script-runner 失败归类：script-threw / ask-failed 的失败点脚本体偏移
// （throw 走 vm 栈 captureAskSite 同款换算；ask 用其作用点证据）≥ patchFrom → reason=
// 'patch-failed'（补段内失败）；< patchFrom 或证据缺失 → 维持原 reason（不发明归类）。
// answer-source-error（答复源坏死=环境失败）与 script-syntax（整文件级，且语法门在 register
// 已拦）不参与归类。
//
// 顺序与故障（§6 纪律：时钟/故障经构造参数注入，禁 monkey-patch）：先写补段文件后记事件——
// 事件只指向已落盘的产物；写文件失败 → ok:false 零事件（journal 分毫未动，重试覆盖同序号
// 文件无妨）；recordEvent 失败（torn/degraded）→ ok:false（补段文件已成孤儿但无事件——
// 重试时 patchSeq 不变、同路径覆盖，无悬空引用）。base 文件字节全程不动。
// journal 真相只经 storage.read 读（torn/runId 不符 → 拒绝补段，resume-script.js 同款保守：
// patchSeq/callSeq 锚点建立不起来就不补——宁不补，不记错账）。
//
// 语法预门：patchedScript 先过 compileScriptBody（与 runScript 执行、gate register 登记同一
// 包装——语法判定零分叉）。不过 → ok:false 零落盘零事件（gate 反正会拒，提前拦省一次
// journal 噪音）。
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

import { compileScriptBody } from './script-runner.js'
import { validateJournalRecord } from './journal.js'

/** patch 事件 type（须在 script-runner.js SCRIPT_EVENT_TYPES 域内）。 */
export const PATCH_EVENT_TYPE = 'patch'

/** anchor 取值域（spike 写死：hole 调用点原位替换 | 尾部追加）。 */
export const PATCH_ANCHORS = Object.freeze(['hole-site', 'tail'])

/** holeRef 取值域（anchor:'hole-site' 必带；kind 对齐 script-runner 的两种挂起）。 */
const HOLE_REF_KINDS = Object.freeze(['hole', 'escalate'])

/** 补段被拒（ok:false）的 reason 取值域。 */
export const PATCH_REFUSED_REASONS = Object.freeze([
  'base-unreadable',
  'read-error',
  'unparseable',
  'shape-invalid',
  'run-mismatch',
  'patch-syntax-invalid',
  'patch-write-failed',
  'journal-not-ok',
])

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const brief = (v) => String(v?.message ?? v).slice(0, 160)

const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * base 与 patched 的首个变更字节偏移（JS 字符串下标；两串前缀全等 → 较短者长度 = 变更区起点，
 * 完全相等 → 等于两串长度）。runScript opts.patchFrom 的分类边界来源（见文件头）。
 */
export function firstChangedOffset(base, patched) {
  const n = Math.min(base.length, patched.length)
  let i = 0
  while (i < n && base[i] === patched[i]) i += 1
  return i
}

/** 补段文件名：`<stem>.patch-<patchSeq><ext>`（与 base 同目录；点开头文件名视为无扩展名）。 */
export function patchedScriptPath(scriptPath, patchSeq) {
  const name = basename(scriptPath)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  return join(dirname(scriptPath), `${stem}.patch-${patchSeq}${ext}`)
}

/**
 * 补段机械化入口（C2；一次调用 = 落盘一份补段完整脚本 + 记一笔 patch 事件，零执行零派发）。
 * @param {object} input
 *   - scriptPath: base 脚本文件盘上路径（非空字符串；只读，字节不动）
 *   - patchedScript: 补段后的完整脚本文本（非空字符串；须过 compileScriptBody 语法门）
 *   - runId: journal 归属 run（非空字符串；storage 里 record.runId 不符 = run-mismatch 拒绝）
 *   - storage: {read}——盘上 journal 真相源（makeJournalStorage 产物或同形状；patchSeq 与
 *     appliedAfterCallSeq 从这里读，不用 journal 实例的内存态）
 *   - journal: createJournal 产物（用 recordEvent face 记 patch 事件——走三铁律写路径）
 *   - patch: { anchor: 'hole-site'|'tail', holeRef?: {kind, seq}, reason, source }
 *     anchor='hole-site' 必带 holeRef（kind ∈ hole|escalate，seq ≥1 整数）；anchor='tail'
 *     带了 holeRef 拒（严格未知面，repo 风格）；reason/source 非空字符串。
 * @param {object} [opts]
 *   - writeScript: (path, text) => void（缺省 writeFileSync；测试注入假写做故障缝）
 *   - readScript: (path) => string（缺省 readFileSync utf8；测试注入假读）
 *   事件 at 的时钟经 createJournal({now}) 注入（本文件自己不持时钟——journal 三铁律的 clock
 *   就是唯一时钟面）。
 * @returns {{ok:true, patchSeq, baseFingerprint, patchedFingerprint, changedFrom, basePath,
 *            patchedPath, appliedAfterCallSeq, payload, at} |
 *           {ok:false, reason, error?, errors?, detail?}}
 *   changedFrom = 首个变更字节偏移（喂 runScript opts.patchFrom）；payload = 落进 journal 的
 *   事件 payload 原样；at = 事件落账时刻（journal.recordEvent 返回值，走 journal 的注入时钟）。
 * @throws {TypeError} input/opts/patch 形状不合法（程序错误 fail-fast）
 */
export function applyPatch(input, opts = {}) {
  const { scriptPath, patchedScript, runId, storage, journal, patch } = input ?? {}
  const { writeScript, readScript } = opts ?? {}

  // ---- 参数校验（程序错误 = TypeError，fail-fast；runScript/resumeScript 同轨）----
  if (typeof scriptPath !== 'string' || scriptPath.length === 0) {
    throw new TypeError(`applyPatch: scriptPath 必须是非空字符串（base 脚本文件路径；得到 ${scriptPath === undefined ? '缺省' : typeof scriptPath}）`)
  }
  if (typeof patchedScript !== 'string' || patchedScript.length === 0) {
    throw new TypeError(`applyPatch: patchedScript 必须是非空字符串（补段后的完整脚本文本；得到 ${patchedScript === undefined ? '缺省' : typeof patchedScript}）`)
  }
  if (typeof runId !== 'string' || runId.length === 0) throw new TypeError('applyPatch: runId 必须是非空字符串')
  if (!isPlainObject(storage) || typeof storage.read !== 'function') {
    throw new TypeError('applyPatch: storage 必须是 {read}（makeJournalStorage 产物或同形状）——patchSeq/callSeq 锚点的盘上真相源')
  }
  if (!isPlainObject(journal) || typeof journal.recordEvent !== 'function') {
    throw new TypeError('applyPatch: journal 缺 face recordEvent（createJournal 产物）')
  }
  if (!isPlainObject(patch)) throw new TypeError('applyPatch: patch 必须是 {anchor, holeRef?, reason, source}')
  const { anchor, holeRef, reason, source } = patch
  if (!PATCH_ANCHORS.includes(anchor)) {
    throw new TypeError(`applyPatch: patch.anchor 必须是 ${PATCH_ANCHORS.join('|')}（得到 ${String(anchor)}）`)
  }
  if (typeof reason !== 'string' || reason.length === 0) throw new TypeError('applyPatch: patch.reason 必须是非空字符串')
  if (typeof source !== 'string' || source.length === 0) throw new TypeError('applyPatch: patch.source 必须是非空字符串')
  if (anchor === 'hole-site') {
    if (!isPlainObject(holeRef)) throw new TypeError("applyPatch: anchor='hole-site' 必带 patch.holeRef {kind, seq}（挂起身份）")
    if (!HOLE_REF_KINDS.includes(holeRef.kind)) {
      throw new TypeError(`applyPatch: holeRef.kind 必须是 ${HOLE_REF_KINDS.join('|')}（得到 ${String(holeRef?.kind)}）`)
    }
    if (!Number.isInteger(holeRef.seq) || holeRef.seq < 1) {
      throw new TypeError(`applyPatch: holeRef.seq 必须是 ≥1 整数（得到 ${String(holeRef?.seq)}）`)
    }
  } else if (holeRef !== undefined) {
    throw new TypeError("applyPatch: anchor='tail' 不收 patch.holeRef（尾部追加不挂挂起身份）")
  }
  if (writeScript !== undefined && typeof writeScript !== 'function') throw new TypeError('applyPatch: writeScript 必须是 (path, text) => void')
  if (readScript !== undefined && typeof readScript !== 'function') throw new TypeError('applyPatch: readScript 必须是 (path) => string')

  const doRead = readScript ?? ((p) => readFileSync(p, 'utf8'))
  const doWrite = writeScript ?? ((p, t) => writeFileSync(p, t, 'utf8'))

  // ---- ① 语法预门（register/执行同一包装，语法判定零分叉）：不过 → 零落盘零事件 ----
  try {
    compileScriptBody(patchedScript, basename(scriptPath))
  } catch (error) {
    return { ok: false, reason: 'patch-syntax-invalid', errors: [brief(error)] }
  }

  // ---- ② base 字节（只读）：baseFingerprint + 变更边界 ----
  let baseText
  try {
    baseText = doRead(scriptPath)
  } catch (error) {
    return { ok: false, reason: 'base-unreadable', error: brief(error) }
  }
  if (typeof baseText !== 'string' || baseText.length === 0) {
    return { ok: false, reason: 'base-unreadable', error: 'base 脚本文件为空或非文本' }
  }
  const baseFingerprint = sha256Hex(baseText)
  const patchedFingerprint = sha256Hex(patchedScript)
  const changedFrom = firstChangedOffset(baseText, patchedScript)

  // ---- ③ 盘上 journal 真相：patchSeq 递增 + appliedAfterCallSeq 锚点（torn/runId 不符拒绝）----
  let raw = null
  try {
    raw = storage.read()
  } catch (error) {
    return { ok: false, reason: 'read-error', error: brief(error) }
  }
  if (raw == null) {
    // 无记录 = 该 run 尚无 journal 事实（首跑从未发生）——补段锚点建立不起来，拒绝
    return { ok: false, reason: 'shape-invalid', error: '盘上无 journal 记录（run 从未落账）——补段锚点建立不起来' }
  }
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'unparseable' }
  }
  const record = validateJournalRecord(parsed)
  if (!record) return { ok: false, reason: 'shape-invalid' }
  if (record.runId !== runId) return { ok: false, reason: 'run-mismatch' }

  let patchSeq = 0
  let appliedAfterCallSeq = 0
  for (const event of record.events) {
    if (!isPlainObject(event.payload)) continue
    if (event.type === PATCH_EVENT_TYPE && Number.isInteger(event.payload.patchSeq) && event.payload.patchSeq > patchSeq) {
      patchSeq = event.payload.patchSeq // 多 patch 成链：取盘上最大序号，+1 即本笔
    }
    if (Number.isInteger(event.payload.callSeq) && event.payload.callSeq > appliedAfterCallSeq) {
      appliedAfterCallSeq = event.payload.callSeq // ask/ask-failed 都带 callSeq——执行序锚点取最大
    }
  }
  patchSeq += 1
  const payload = {
    patchSeq,
    baseFingerprint,
    patchedFingerprint,
    anchor,
    ...(anchor === 'hole-site' ? { holeRef: { kind: holeRef.kind, seq: holeRef.seq } } : {}),
    appliedAfterCallSeq,
    reason,
    source,
  }

  // ---- ④ 先落盘补段文件，后记事件（事件只指向已存在产物；写败零事件，journal 分毫未动）----
  const patchedPath = patchedScriptPath(scriptPath, patchSeq)
  try {
    doWrite(patchedPath, patchedScript)
  } catch (error) {
    return { ok: false, reason: 'patch-write-failed', error: brief(error), patchedPath }
  }

  // ---- ⑤ patch 事件（journal 三铁律写路径；torn/degraded → ok:false，孤儿文件无事件可重试）----
  const recorded = journal.recordEvent(PATCH_EVENT_TYPE, payload)
  if (!recorded.ok) {
    return { ok: false, reason: 'journal-not-ok', detail: recorded, patchedPath }
  }
  return {
    ok: true,
    patchSeq,
    baseFingerprint,
    patchedFingerprint,
    changedFrom,
    basePath: scriptPath,
    patchedPath,
    appliedAfterCallSeq,
    payload,
    at: recorded.at,
  }
}
