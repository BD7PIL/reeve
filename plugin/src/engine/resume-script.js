// E1 引擎 resume-script v2（M2.2 + C1 脚本 amend；蓝图 optimization-plan-v3.md「C1」行，
// 前身 M2.2 见 .zcode/plans/next-phase-plan-m1-m5.md「M2.2 resume 脚本模式」+「callSeq 不变量」。
// 独立文件——不动声明路径 resume.js：两条恢复路径并存，声明 = 步记账回放（done payload +
// matchAmend 字节匹配），脚本 = ask 事件缓存按执行序序号返还）。
//
// 职责：脚本模式恢复的**读端**——从 journal 盘上记录抽取可导入的已完成 ask，供 runScript 重跑时
// 零 driver 调用返还。写端在 script-runner.js 的 ask 事件：journal events 里 type='ask' 的
// payload = { callSeq, cacheKey, stepId, value, attempts, sessionId?,
//             site, promptHash, prefixHash, optsHash }——后四样是 C1 v2 的作用点证据，
// cacheKey（sha256(script):callSeq）v2 起仅作诊断链，**不再是匹配判据**。
//
// 导入规则三条件（C1 v2「作用点位置匹配」；任一不满足 → 该点之后全部弃用。宁重跑，不假完成
// ——本文件保守判定同哲学）：
//   ① 调用点在首个变更字节之前。读端看不见旧脚本字节（journal 不存脚本源码），判据由写端
//     落盘的 prefixHash = sha256(脚本体 [0, 调用点字节偏移)) 承载：script-runner 的 ask facade
//     在命中时用**重跑脚本**实算同位置前缀哈希比对——相等 = 调用点之前字节零变更（首个变更
//     字节必在调用点或之后）；site（调用点 line:col，脚本体坐标）为①的伴随结构检查。
//     因此①③的复核时点在 facade 命中分支，不在本文件——本文件只做证据的形状把关。
//   ② 该前缀内 hole-answered/escalate-answered 事件集为空。hole/escalate 答复不进 ask 缓存
//     （callSeq/holeSeq 独立），答复是人输入的非确定源：事件序前缀里有已答复挂起 → 其后执行流
//     依赖旧答复，位置与 prompt 都对不上「同一执行」——一律不可信。这条在本文件按事件序裁决。
//     涟漪口径：answered 事件一旦入账，其后一切 ask 在一切后续 resume 里都弃用（事件序前缀
//     永不复空）——含 resume 真跑新写的 ask。
//   ③ payload.promptHash（sha256(prompt)）与本次重跑实算哈希相等。原位改 prompt 字节（行结构
//     不变）时①②都过，③拦下（critic round 2 F1：防静默错值注入）。optsHash（agent/model/
//     schema）为③的伴生保守门：ask 身份不止 prompt，这几样原位变更同样拦下（宁重跑）。
//
// 「哈希变更 → 全量重跑」（v1 断言，resume-script v1 头注 lines 11-14）被 C1 有意推翻为
// 「前缀有效 → 导入」：脚本改尾部时前缀 ask 照常导入零重跑；改头部/原位改 prompt 时从失效点起
// 弃用。同哈希重跑 = 全前缀有效 → 全导入（行为与 v1 等价）。
//
// 「零重跑」口径（蓝图 C1，SKILL 同步）：ask 零重跑 ≠ 副作用零重执行——F.run 结果不进任何
// 缓存，副作用命令在任何 resume 里都重执行并如实记账；幂等命令缓存列为可选增强，v2 不做。
//
// callSeq 三不变量（蓝图 M2.2，本文件消费其结果）：
//   ① callSeq 在 F.ask 同步入口第一行分配——attempt 重派（typedAsk 内部循环）与缓存命中
//     （script-runner ask facade 的 hit 分支）均不额外消耗序号；
//   ② 脚本无非确定源——vm 白名单已保证（script-runner SANDBOX_PREAMBLE）；
//   ③ 缓存命中返回值恒等于首跑值 → 动态分支决策相同 → 后续 ask 发起序与首跑逐位一致
//     （Promise.all 内多 ask 的序号 = 数组求值序）。命中路径按 callSeq 返还首跑值，不做任何变换。
//
// 保守判定（journal 三铁律的读端镜像，resume.js「宁可整段重跑，不可假完成」同哲学）：
//   storage.read 抛错 / JSON 解析不过 / validateJournalRecord 形状不过 / runId 不符 →
//   ok:false + 空 Map（调用方拿空缓存照常重跑——最坏情形是多跑，绝不会拿假结果）。
// 只收 type='ask'（成功）事件；'ask-failed' 不进缓存（失败的 ask 重写真跑——重试语义在
// typedAsk 那里）。C2 的 'patch' 事件（script-patch.js applyPatch 落盘）同样不进——本文件
// 只认 ask/hole-answered/escalate-answered 三种 type，其余一律 fall-through（零污染 ask
// 缓存；有 patch 事件的 journal 与无 patch 时行为逐位一致，engine-script-patch.test.mjs 钉面）。
// 同 callSeq 多笔 ask 事件（无缓存重跑会对同一 callSeq 各写真一笔）→
// 末笔为准（盘上真相的最新值；命中路径不写盘，故不会制造新重复）。
// v2 的「该点之后全部弃用」闩：任何一条件不过（含 ask 事件证据形状坏——v1 账本没带证据、
// 手搓账本证据残缺、value 缺失、callSeq 出域）→ 从该 ask 起不再导入任何条目。证据形状坏在 v1
// 是跳过该笔，v2 升为截断：ask 缓存的可信性是**执行序对齐链**，链上一环存疑，其后序号映射
// 全部存疑——宁多跑，不假完成。
import { validateJournalRecord } from './journal.js'

import { scriptFingerprint } from './script-runner.js'

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const brief = (v) => String(v?.message ?? v).slice(0, 160)
const HEX64 = /^[0-9a-f]{64}$/

/** 缓存不可用（ok:false）的 reason 取值域——一律收敛为「空缓存全量重跑」。 */
export const RESUME_SCRIPT_MISS_REASONS = Object.freeze(['read-error', 'unparseable', 'shape-invalid', 'run-mismatch'])

/** 作用点证据形状（C1 v2）：promptHash/optsHash 必为 sha256 hex；prefixHash/site 允许 null（写端抓点失败如实记 null，命中时 null 恒不过复核）。 */
const evidenceShapeOk = (payload) =>
  typeof payload.promptHash === 'string' &&
  HEX64.test(payload.promptHash) &&
  typeof payload.optsHash === 'string' &&
  HEX64.test(payload.optsHash) &&
  (payload.prefixHash === null || (typeof payload.prefixHash === 'string' && HEX64.test(payload.prefixHash))) &&
  (payload.site === null ||
    (isPlainObject(payload.site) && Number.isInteger(payload.site.line) && payload.site.line >= 1 && Number.isInteger(payload.site.col) && payload.site.col >= 1))

/**
 * 装载脚本 ask 缓存（v2 读端入口；纯读——不写 storage、不碰 driver、无时钟面）。
 * @param {string} script 要重跑的脚本函数体源码（fingerprint 从这里来；①③的实算比对在
 *        script-runner 的命中分支用同一参数做，本函数不比较新旧脚本字节）
 * @param {{read: () => string|null}} storage journal storage（makeJournalStorage 产物或同形状；
 *        只用 read——本函数纯读端）
 * @param {string} runId journal 归属 run（record.runId 不符 = run-mismatch，空缓存）
 * @returns {{ok: true, reason: null, fingerprint, cached: Map<number, object>, askEventCount, matchedCount}
 *          | {ok: false, reason: 'read-error'|'unparseable'|'shape-invalid'|'run-mismatch',
 *             error?: string, fingerprint, cached: Map<number, object>, askEventCount: 0, matchedCount: 0}}
 *   fingerprint = sha256(script)（两种形状都带，供诊断）；cached 键 = callSeq，值 = ask 事件
 *   payload 的规范化拷贝 { callSeq, cacheKey, stepId, value, attempts, site, promptHash,
 *   prefixHash, optsHash, sessionId? }（直接传 runScript opts.askCache）；askEventCount = 盘上
 *   type='ask' 事件总数（诊断面，弃用/截断的不剔除）；matchedCount = 导入数（= cached.size）。
 * @throws {TypeError} script/runId 非非空字符串、storage 缺 read（程序错误 fail-fast）
 */
export function resumeScript(script, storage, runId) {
  if (typeof script !== 'string' || script.length === 0) {
    throw new TypeError(`resumeScript: script 必须是非空字符串（得到 ${script === undefined ? '缺省' : typeof script}）`)
  }
  if (typeof runId !== 'string' || runId.length === 0) throw new TypeError('resumeScript: runId 必须是非空字符串')
  if (!isPlainObject(storage) || typeof storage.read !== 'function') {
    throw new TypeError('resumeScript: storage 必须是 {read}（makeJournalStorage 产物或同形状）')
  }

  const fingerprint = scriptFingerprint(script)
  const cached = new Map()
  const miss = (reason, extra = {}) => ({ ok: false, reason, fingerprint, cached, askEventCount: 0, matchedCount: 0, ...extra })

  let raw = null
  try {
    raw = storage.read()
  } catch (error) {
    return miss('read-error', { error: brief(error) })
  }
  if (raw == null) {
    // 无记录 = 全新 run：零缓存是**正确**答案（不是失败）——首跑没有可返还的东西
    return { ok: true, reason: null, fingerprint, cached, askEventCount: 0, matchedCount: 0 }
  }
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    return miss('unparseable')
  }
  const record = validateJournalRecord(parsed)
  if (!record) return miss('shape-invalid')
  if (record.runId !== runId) return miss('run-mismatch')

  let askEventCount = 0
  let answeredSuspendSeen = false // 条件②：事件序前缀内已出现 hole-answered/escalate-answered
  let cut = false // 「该点之后全部弃用」闩：第一处不可信 ask 起不再导入（宁重跑，不假完成）
  for (const event of record.events) {
    if (!isPlainObject(event.payload)) continue
    if (event.type === 'hole-answered' || event.type === 'escalate-answered') {
      answeredSuspendSeen = true // 条件②的判据事件（答复是人输入的非确定源——其后一律不可信）
      continue
    }
    if (event.type !== 'ask') continue
    askEventCount += 1
    if (cut) continue
    const payload = event.payload
    // 条件②在该 ask 上失败：其前缀内已有已答复挂起 → 该点起全部弃用（不重挂起的假完成——
    // 挂起本体没有缓存面，重跑自然重新挂起等新答复；弃用的是挂起之后的 ask 导入）。
    if (answeredSuspendSeen) {
      cut = true
      continue
    }
    // 证据形状把关（①③的数据前提）：callSeq / promptHash / optsHash / prefixHash / site /
    // value 任一缺失出形 → 对齐链存疑 → 该点起截断（v1 是跳过该笔；v2 升为截断，见头注）。
    if (!Number.isInteger(payload.callSeq) || payload.callSeq < 1 || !evidenceShapeOk(payload) || !Object.hasOwn(payload, 'value')) {
      cut = true
      continue
    }
    // 同 callSeq 多笔 → 末笔为准（盘上真相的最新值；命中路径不写盘，不制造新重复）
    cached.set(payload.callSeq, {
      callSeq: payload.callSeq,
      cacheKey: typeof payload.cacheKey === 'string' ? payload.cacheKey : null,
      stepId: typeof payload.stepId === 'string' ? payload.stepId : null,
      value: payload.value,
      attempts: Number.isInteger(payload.attempts) ? payload.attempts : null,
      site: payload.site,
      promptHash: payload.promptHash,
      prefixHash: payload.prefixHash,
      optsHash: payload.optsHash,
      ...(typeof payload.sessionId === 'string' ? { sessionId: payload.sessionId } : {}),
    })
  }
  return { ok: true, reason: null, fingerprint, cached, askEventCount, matchedCount: cached.size }
}
