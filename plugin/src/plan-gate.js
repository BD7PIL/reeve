// plan-gate：方案评审门禁（reeve 适配层 + 宿主无关核心，一个文件两层）。
//
// 权威语义：OpenCodeConfig 仓 plan-gate/SPEC.md（核心层规格，头部 pin 权威矩阵的
// sha256）+ reeve 仓 plugin/test/fixtures/decision-matrix.json（权威决策矩阵，行级语义唯一落点；
// 2026-11-21 实测 sha256 = 20f4ae0b93ae00ac75830fbdf80f99e7656f7c32565e10d3676a53f434b7522c，
// 与 SPEC 头部一致）。本模块逐行复现矩阵含义，不复制任何行文本。
//
// 三层分工（SPEC §1/§8）：
//   核心层（下方第一段）——宿主无关纯函数，零 IO，store 读写经 io 注入；与 ZCode 适配器
//   （OpenCodeConfig/plan-gate/gate-core.mjs）保持同名同义，两侧测试可共享语义面。
//   薄壳层（下方第二段）——reeve 适配：store 落盘（tmp+rename 原子写）、评审输出取文、
//   四个 transition 到引擎挂点的映射、review_gate 工具。register 另接受两类引擎工件
//   （分类/校验在 src/engine/pgate.js）：kind:"engine-run" 的运行声明文件（S9，文件内容自带
//   kind 标记）与 kind:"workflow-script" 的脚本文件（M2.4，裸函数体无法在文件内自我描述，
//   register 的 kind 参数显式给；语法门与命令字面量扫描，payload 带供评审的 commands；P4 起
//   .ts 脚本走 TS 前端同一语法门，registerSession 为 async）——
//   均为仅登记时点校验，门禁判定（check）不分叉，照走同一权威决策矩阵。
//   P3.3：register 可带 baseExecution（补段评审上下文，script-patch.js buildPatchContext 结果）
//   ——payload 回带供评审 prompt 注入，不进 store（D1 不变）。
//   装配层（src/index.js）——插件 options opt-in 后挂 hook、注册工具、台账进快照。
//
// reeve 侧的 transition 映射（适配器裁决，SPEC §3 的四值闭集不变）：
//   dispatch-review  = execute.before 观测到向评审 agent（默认 critic）的 subagent 派发
//   verdict-observed = execute.after 观测到该派发的真实结果（双通道解析，SPEC §4）
//   gate-check       = execute.before 拦 exec 类工具（matcher 默认 ["shell","execute"]，
//                      options.planGate.matchers 可覆盖）；TOCTOU：此时刻重读方案文件盘上
//                      现字节重哈希，与判决绑定的哈希比对（D1）
//   human-override   = overrideSession()——只给人用的入口，**不经任何 agent 可达路径暴露**
//                      （评审执行方与被评审方都不得自报判决，SPEC §2 对抗面立场）
//
// 激活域（SPEC §7）：项目级显式 opt-in = options.planGate.enabled === true（默认 dormant，
// 一个字节都不记、一个调用都不拦）。其下再加一层会话级 scope：**store 文件存在 = 该根会话
// 已入域**（store 由 review_gate register 或评审派发首次写入）。没有 store 的根会话不适用
// 门禁（矩阵 gate-check 各行的 precondition 都以"store 存在"为前提；缺文件不在任何行内）。
// 这个二层 scope 是适配器裁决：exec 类工具在一切工作流里高频发生，项目 opt-in 后若对
// 从未做过方案评审的会话也拦，会把整个项目锁死。
//
// fail-closed（SPEC §7）：门禁未知错误 → 拦（execute.before 返回错误对象）；采集未知错误
// → 不落任何记录（往"无判决"方向收敛，吵日志）。方向恒为拦，宁可错拦。
//
// 铁律沿用：本插件绝不写 agents.*.model；本模块零运行时依赖（只用 node 内建）。

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { ENGINE_RUN_KIND, WORKFLOW_SCRIPT_KIND, classifyArtifact, classifyWorkflowScript, classifyWorkflowScriptAsync } from './engine/pgate.js'
import { isTsScriptName } from './engine/ts-front.js'
import { TOOL_NAMESPACE } from './constants.js'

// ─────────────────────────────────────────────────────────────────────────────
// 核心层（宿主无关；与 OpenCodeConfig/plan-gate/gate-core.mjs 同名同义）
// ─────────────────────────────────────────────────────────────────────────────

/** §3 门禁迁移四值闭集。扩展枚举 = 核心变更（走 SPEC §9 变更纪律）。 */
export const TRANSITIONS = Object.freeze([
  'dispatch-review',
  'verdict-observed',
  'gate-check',
  'human-override',
])

/** verdict 合法值（SPEC §2）。 */
export const VERDICT_DECISIONS = Object.freeze(['pass', 'reject'])

/** §9 可调参数默认值。调整任一默认 = 核心变更：同步改 fixture + 两侧测试。 */
export const DEFAULT_CAP = 3
export const PENDING_TTL_MS = 30 * 60 * 1000

/**
 * D1：规范哈希 = artifact 盘上现字节的 sha256（hex 小写）。
 * 只绑盘上字节，绝不哈希呈现给评审方的转述文本。
 */
export function canonicalPlanHash(bytes) {
  const hash = createHash('sha256')
  hash.update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
  return hash.digest('hex')
}

/**
 * D2：pending 逻辑键 = `<rootSessionId>:<toolCallId>`。
 * store 一根会话一文件，物理 pending 对象以 toolCallId 单独作键（会话 id 在文件名里）。
 */
export function pendingKey(sessionId, toolCallId) {
  return `${sessionId}:${toolCallId}`
}

/**
 * D2：pending TTL 判定。超过 TTL 即过期；恰好等于 TTL 未过期。
 * 条目缺失或 ts 非数 → 按过期（fail-closed）。
 */
export function isPendingExpired(entry, nowMs, ttlMs = PENDING_TTL_MS) {
  if (!entry || typeof entry !== 'object' || !Number.isFinite(entry.ts)) return true
  return nowMs - entry.ts > ttlMs
}

/** §6 store 全字段记录的初始形态（文件缺失时的无记录基线）。 */
export function freshStoreRecord({ planPath = '', cap = DEFAULT_CAP, now = 0 } = {}) {
  return {
    planPath,
    pending: {},
    verdicts: [],
    rounds: 0,
    parseFailures: 0,
    cap: Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_CAP,
    updatedAt: now,
  }
}

/**
 * §6 顶层形状校验（顶层字段缺失或类型不符 = 无记录；深层字段不在此校验）。
 * 合法返回原值，否则返回 null。
 */
export function validateStoreRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.planPath !== 'string') return null
  if (!value.pending || typeof value.pending !== 'object' || Array.isArray(value.pending)) return null
  if (!Array.isArray(value.verdicts)) return null
  if (!Number.isFinite(value.rounds) || value.rounds < 0) return null
  if (!Number.isFinite(value.parseFailures) || value.parseFailures < 0) return null
  if (!Number.isFinite(value.cap) || value.cap <= 0) return null
  if (!Number.isFinite(value.updatedAt)) return null
  return value
}

/**
 * 注入读：io.read(sessionId) 返回文件全文或 null（缺失）。
 * - 缺失 → {ok:true, record:fresh, fresh:true}（「无记录」基线；调用方借 fresh 区分"域外"）
 * - JSON 解析失败 / 形状不过 → {ok:false, ...}（torn；自动化迁移绝不重建，
 *   唯一可重建者 = 人工 override，矩阵 dispatch-review#4 / verdict-observed#9）
 * - io.read 抛错 → {ok:false, reason:'read-error'}（§7 未知错误朝拦截方向收敛）
 */
export function readStore(io, sessionId, { cap } = {}) {
  let raw
  try {
    raw = io.read(sessionId)
  } catch (error) {
    return { ok: false, reason: 'read-error', error }
  }
  if (raw == null) return { ok: true, record: freshStoreRecord({ cap }), fresh: true }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'unparseable' }
  }
  const record = validateStoreRecord(parsed)
  if (!record) return { ok: false, reason: 'shape-invalid' }
  return { ok: true, record }
}

/**
 * 注入写：每次变更整文件重写（tmp+rename 原子替换语义由 io.write 薄壳承担），先刷新 updatedAt。
 * record 不过形状校验 → 抛 TypeError（程序错误，不是运行期容错对象）。
 */
export function writeStore(io, sessionId, record) {
  if (!validateStoreRecord(record)) {
    throw new TypeError('writeStore: record fails the store schema')
  }
  io.write(sessionId, JSON.stringify(record, null, 2))
}

// ── §4 verdict 双通道解析契约 ────────────────────────────────────────────────

function fenceBlocks(text) {
  const re = /```[ \t]*(?:json)?[ \t]*\n?([\s\S]*?)```/g
  return Array.from(text.matchAll(re), (m) => m[1])
}

/**
 * JSON 通道：尾部围栏代码块内的结构化 JSON；```json 与裸 ``` 均接受，块前后允许散文。
 * decision 非 pass|reject 合法值 → 解析失败。planPath/round/findings 仅审计，不参与门禁判定。
 */
export function parseJsonChannel(text) {
  if (typeof text !== 'string' || text.length === 0) return { ok: false, error: 'no-text' }
  const blocks = fenceBlocks(text)
  if (blocks.length === 0) return { ok: false, error: 'no-fenced-block' }
  let obj
  try {
    obj = JSON.parse(blocks[blocks.length - 1])
  } catch {
    return { ok: false, error: 'json-parse-failed' }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'not-an-object' }
  const { decision } = obj
  if (decision !== 'pass' && decision !== 'reject') return { ok: false, error: 'decision-not-legal' }
  return { ok: true, decision }
}

/**
 * 散文通道：最后一段散文的末行解析为 pass / reject（围栏块内不算散文）。
 * 判词双语言：英文 pass/reject + critic 契约的中文末行判词「通过 / 不通过」（agents/critic.md 三节）。
 * reject / 不通过 先判（「不通过」含「通过」子串）；末行同时含两判词按 reject（fail-closed）；
 * 解析不出 → 解析失败。
 */
export function parseProseChannel(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return { ok: false, error: 'no-text' }
  const stripped = text.replace(/```[ \t]*(?:json)?[ \t]*\n?[\s\S]*?```/g, '\n')
  const lines = stripped
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return { ok: false, error: 'no-prose-line' }
  const last = lines[lines.length - 1].toLowerCase()
  if (/(^|[^a-z])reject([^a-z]|$)/.test(last) || last.includes('不通过')) return { ok: true, decision: 'reject' }
  if (/(^|[^a-z])pass([^a-z]|$)/.test(last) || last.includes('通过')) return { ok: true, decision: 'pass' }
  return { ok: false, error: 'prose-line-unresolvable' }
}

/**
 * 双通道合议（§4 判定规则）：一致采之；不一致按 reject（T1.1）；任一通道解析失败
 * （含只有单通道可解析）→ 解析失败，走 D3 机制。
 */
export function resolveReviewOutput(text) {
  const json = parseJsonChannel(text)
  const prose = parseProseChannel(text)
  if (json.ok && prose.ok) {
    const disagree = json.decision !== prose.decision
    return {
      kind: 'verdict',
      decision: disagree ? 'reject' : json.decision,
      channels: { json: json.decision, prose: prose.decision },
      disagree,
    }
  }
  return {
    kind: 'parse-failure',
    channels: { json: json.ok ? json.decision : null, prose: prose.ok ? prose.decision : null },
    errors: [json.ok ? null : json.error, prose.ok ? null : prose.error].filter(Boolean),
  }
}

// ── 四个 transition ──────────────────────────────────────────────────────────

/**
 * dispatch-review：派发评审被观测到，记 pending。
 * input = { toolCallId, artifactPath, artifactHash, now }
 * artifactHash = 派发时点盘上字节的 canonicalPlanHash；路径不可解析/不可读时传 null
 * （D1 的读盘责任在薄壳）。
 */
export function dispatchReview(io, sessionId, input) {
  const base = { transition: 'dispatch-review' }
  const read = readStore(io, sessionId)
  if (!read.ok) {
    // torn store：不记 pending，绝不重建，撕裂文件原样保留（矩阵 dispatch-review#4）
    return {
      ...base,
      decision: 'ignore',
      reason: 'store unreadable; pending not recorded; only a human override may rebuild the store',
      wrote: false,
    }
  }
  const { toolCallId, artifactPath, artifactHash, now } = input
  const artifactUsable =
    typeof artifactPath === 'string' &&
    artifactPath.length > 0 &&
    typeof artifactHash === 'string' &&
    artifactHash.length > 0
  if (!artifactUsable) {
    // artifact 在派发时点不可解析：什么都不记（下一次 gate-check 将按无判决 deny，#3）
    return {
      ...base,
      decision: 'ignore',
      reason: 'artifact unreadable at dispatch; nothing recorded; the next gate check denies as no-verdict-on-file',
      wrote: false,
    }
  }
  const record = read.record
  const hadOtherPending = Object.keys(record.pending).length > 0
  record.planPath = artifactPath
  record.pending[toolCallId] = { hash: artifactHash, ts: now }
  record.updatedAt = now
  writeStore(io, sessionId, record)
  return {
    ...base,
    decision: 'record',
    reason: hadOtherPending
      ? 'parallel dispatches are isolated by pending key'
      : 'pending recorded against current artifact bytes',
    wrote: true,
    record,
  }
}

/**
 * verdict-observed：评审真实结果被观测到，解析并落 store。
 * input = { toolCallId, output, now, ttlMs? }；output = 评审输出全文（双通道解析是核心语义）。
 * ttlMs 只在调用方显式给出且为正数时覆盖默认（默认不动 = 矩阵原样复现）。
 * 检查顺序：torn → 无 pending → TTL 过期 → 双通道解析。判决只绑对应 pending 的 hash（派发时点字节）。
 */
export function observeVerdict(io, sessionId, input) {
  const base = { transition: 'verdict-observed' }
  const read = readStore(io, sessionId)
  if (!read.ok) {
    return {
      ...base,
      decision: 'ignore',
      reason: 'store unreadable; verdict ignored; only a human override may rebuild the store',
      wrote: false,
    }
  }
  const record = read.record
  const { toolCallId, output, now } = input
  const entry = record.pending ? record.pending[toolCallId] : undefined
  if (!entry || typeof entry !== 'object') {
    // 无 pending 的观测：忽略，绝不绑定判决（矩阵 verdict-observed#7）
    return {
      ...base,
      decision: 'ignore',
      reason: 'no pending entry for this call; the verdict is ignored',
      wrote: false,
    }
  }
  const ttlMs = Number.isFinite(input.ttlMs) && input.ttlMs > 0 ? input.ttlMs : PENDING_TTL_MS
  if (isPendingExpired(entry, now, ttlMs)) {
    // TTL 过期：孤儿清理（删条目），判决不得绑定（#8）
    delete record.pending[toolCallId]
    record.updatedAt = now
    writeStore(io, sessionId, record)
    return {
      ...base,
      decision: 'ignore',
      reason: 'pending entry is older than the TTL; the verdict is ignored',
      wrote: true,
      record,
    }
  }
  const parsed = resolveReviewOutput(output)
  if (parsed.kind === 'parse-failure') {
    // D3 解析失败机制：rounds+1、pending 保留、重派恰一次；会话级连续第二次 → escalate
    record.rounds += 1
    record.parseFailures += 1
    record.updatedAt = now
    writeStore(io, sessionId, record)
    return {
      ...base,
      decision: 'no-verdict',
      reason:
        record.parseFailures >= 2
          ? 'verdict unreadable on retry; escalate to a human'
          : 'verdict unreadable; exactly one re-dispatch of the review is allowed',
      wrote: true,
      record,
    }
  }
  // 落判决：verdict 绑 pending 的 hash；rounds+1；parseFailures 清零；删 pending
  const round = record.rounds + 1
  record.verdicts.push({ hash: entry.hash, round, decision: parsed.decision, ts: now })
  record.rounds = round
  record.parseFailures = 0
  delete record.pending[toolCallId]
  record.updatedAt = now
  writeStore(io, sessionId, record)
  return {
    ...base,
    decision: 'record',
    reason: parsed.disagree
      ? 'verdict channels disagree; recorded as reject'
      : `verdict recorded: ${parsed.decision}`,
    wrote: true,
    record,
  }
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    if (Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

/**
 * gate-check 决策纯函数：被看护迁移将要发生，按矩阵产出 allow/deny/escalate。
 * store = readStore 的返回（{ok:true,record}|{ok:false,...}），或直接传 record 对象（便捷形态）。
 * planHash = gate-check 时点盘上现字节的 canonicalPlanHash（D1：此刻重读，比对判决绑定哈希；
 * 读不到传 null → 走"哈希不等"行，fail-closed）。
 * cap：入参只在 record 未带 cap 时生效——会话生效上限以 store 为准。
 * 行序按矩阵 gate-check 节数组序、首中即胜；收敛越过 cap（pass+哈希相同 → 即使 rounds≥cap 也 allow，
 * gateCheckPrecedence）。
 */
export function decide(store, planHash, cap) {
  const base = { transition: 'gate-check' }
  let record = null
  if (store && typeof store === 'object') {
    if (typeof store.ok === 'boolean') record = store.ok ? store.record ?? null : null
    else record = store
  }
  if (!record || typeof record !== 'object') {
    // torn store = 无记录 = deny（gate-check#1）
    return {
      ...base,
      decision: 'deny',
      reason: 'gate store unreadable; treated as no verdict on file; run the review first',
    }
  }
  const parseFailures = Number.isFinite(record.parseFailures) ? record.parseFailures : 0
  const rounds = Number.isFinite(record.rounds) ? record.rounds : 0
  const verdicts = Array.isArray(record.verdicts) ? record.verdicts : []
  const effCap = firstPositiveNumber(record.cap, cap) ?? DEFAULT_CAP
  if (parseFailures >= 2) {
    return { ...base, decision: 'escalate', reason: 'verdict was unreadable twice; human decision required' }
  }
  if (parseFailures === 1) {
    return { ...base, decision: 'deny', reason: 'verdict unreadable; re-dispatch the review exactly once' }
  }
  if (verdicts.length === 0) {
    return { ...base, decision: 'deny', reason: 'no verdict on file; run the review first' }
  }
  const latest = verdicts[verdicts.length - 1]
  if (!latest || typeof latest !== 'object') {
    // store 深层损坏成不可判定 → 拦截方向
    return { ...base, decision: 'deny', reason: 'no verdict on file; run the review first' }
  }
  const matchesDisk = latest.hash === planHash
  const atCap = rounds >= effCap
  if (!matchesDisk) {
    return atCap
      ? { ...base, decision: 'escalate', reason: 'artifact changed and the review round cap is reached; human decision required' }
      : { ...base, decision: 'deny', reason: 'artifact changed since the verdict was recorded; re-run the review' }
  }
  if (latest.decision === 'reject') {
    return atCap
      ? { ...base, decision: 'escalate', reason: 'latest verdict is reject and the review round cap is reached; human decision required' }
      : { ...base, decision: 'deny', reason: 'latest verdict is reject; revise the artifact and re-run the review' }
  }
  if (latest.decision === 'pass') {
    return {
      ...base,
      decision: 'allow',
      reason: atCap
        ? 'verdict pass matches the current artifact; gate open; convergence outranks the round cap'
        : 'verdict pass matches the current artifact; gate open',
    }
  }
  // 判决值非法 → 不可判定 → 拦截方向
  return { ...base, decision: 'deny', reason: 'no verdict on file; run the review first' }
}

/**
 * gate-check#0：非根上下文不适用门禁（无 store 询问）；根判别责任在适配器（F2）。
 * 核心以本包装表达「不适用即放行、且根本不碰 store」；根上下文 → 原样进 decide。
 */
export function decideIfApplicable({ resolvedSessionId, rootSessionId, store, planHash, cap } = {}) {
  if (resolvedSessionId !== rootSessionId) {
    return {
      transition: 'gate-check',
      decision: 'allow',
      reason: 'non-root context is out of gate scope; no store consult',
      applied: false,
    }
  }
  return { ...decide(store, planHash, cap), applied: true }
}

/**
 * human-override：人为写入判决并重置轮次。唯一可重建 torn/缺失 store 的写者（#1/#2）。
 * input = { decision: 'pass'|'reject', artifactHash, now, planPath? }；artifactHash = override
 * 时点盘上现字节哈希（薄壳读盘）。planPath 可选：给出时随 override 重钉 artifact（重建的
 * store 不带它就永远对不上哈希，#1 的"opens on the next check"落不了地；reeve 适配器的
 * gate-check 以 store.planPath 为准，ZCode 适配器每次从 env/args 解析路径，故那边不需要）。
 */
export function humanOverride(io, sessionId, input) {
  const base = { transition: 'human-override' }
  const { decision, artifactHash, now } = input
  if (
    (decision !== 'pass' && decision !== 'reject') ||
    typeof artifactHash !== 'string' ||
    artifactHash.length === 0
  ) {
    return {
      ...base,
      decision: 'ignore',
      reason: 'override requires decision pass|reject and the current artifact hash; nothing recorded',
      wrote: false,
    }
  }
  const read = readStore(io, sessionId)
  // 任何前态（torn / 缺失 / cap 耗尽）都可落：torn 或缺失时以全新记录重建（带上 planPath）
  const record = read.ok
    ? read.record
    : freshStoreRecord({ planPath: typeof input.planPath === 'string' ? input.planPath : '', now })
  if (typeof input.planPath === 'string' && input.planPath.length > 0) record.planPath = input.planPath
  record.verdicts.push({ hash: artifactHash, round: 0, decision, ts: now, reason: 'human-override' })
  record.rounds = 0
  record.parseFailures = 0
  record.pending = {}
  record.updatedAt = now
  writeStore(io, sessionId, record)
  return {
    ...base,
    decision: 'record',
    reason: 'human override recorded; rounds reset',
    wrote: true,
    record,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 薄壳层（reeve 适配：store 落盘 + 四 transition 到引擎挂点的映射 + review_gate 工具）
// ─────────────────────────────────────────────────────────────────────────────

/** 默认 matcher：exec 类工具（引擎 v2.0.32 实测工具表里的 shell 与 execute）。 */
const DEFAULT_MATCHERS = Object.freeze(['shell', 'execute'])
/** 默认评审 agent（SPEC 词汇：critic；options.planGate.reviewers 可扩）。 */
const DEFAULT_REVIEWERS = Object.freeze(['critic'])
const SUBAGENT_TOOL = 'subagent'

/** 会话 id → 安全文件名主干（store 文件名 = <rootSessionId>.json，SPEC §6）。防路径穿越。 */
export function storeStem(sessionId) {
  const stem = String(sessionId ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '_')
  return stem.length > 0 ? stem.slice(0, 180) : ''
}

let tmpSeq = 0

/**
 * gate-core io 注入实现（薄壳的唯一落盘通道）。
 * read：缺失（ENOENT）→ null（「无记录」基线）；其余错误向上传播（readStore 收敛为 torn → 拦截方向）。
 * write：同目录 tmp + renameSync 原子替换（SPEC §6；Node 在 Windows 上也走替换语义），
 * 失败尽力清理 tmp 后重抛（薄壳按 §7 收敛）。
 */
export function makeStoreIo(root) {
  return {
    root,
    read(sessionId) {
      const stem = storeStem(sessionId)
      if (!stem) return null
      try {
        return readFileSync(join(root, `${stem}.json`), 'utf8')
      } catch (error) {
        if (error && error.code === 'ENOENT') return null
        throw error
      }
    },
    write(sessionId, content) {
      const stem = storeStem(sessionId)
      if (!stem) throw new Error('store write refused: unusable session id')
      mkdirSync(root, { recursive: true })
      const tmp = join(root, `.${stem}.tmp-${process.pid}-${Date.now()}-${tmpSeq++}`)
      try {
        writeFileSync(tmp, content, 'utf8')
        renameSync(tmp, join(root, `${stem}.json`))
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

/**
 * 评审结果 → 纯文本（SPEC §4 双通道的输入）。认引擎 Tool.Result 的形态：
 * 结构化 output（字符串或 {output}）→ content（字符串或数组）→ 兜底 JSON 序列化
 * （保证双通道总有输入；解析不出来自然走 D3，不在这里替通道做决定）。
 */
export function extractResultText(result) {
  if (typeof result === 'string') return result
  if (result == null) return ''
  if (Array.isArray(result)) return result.map(extractResultText).filter(Boolean).join('\n')
  if (typeof result === 'object') {
    for (const key of ['output', 'content', 'text', 'result', 'message']) {
      const value = result[key]
      if (value == null) continue
      const text = extractResultText(value)
      if (text.length > 0) return text
    }
    try {
      return JSON.stringify(result)
    } catch {
      return ''
    }
  }
  return String(result)
}

/**
 * 装配 plan-gate。options = options.planGate（插件层的该子树）：
 *   enabled            true 才生效（默认 false = dormant，一个字节不记、一个调用不拦）
 *   matchers           exec 类工具名数组，默认 ['shell','execute']
 *   reviewers          评审 agent 名单，默认 ['critic']
 *   planPath           默认 artifact 路径（register 可按会话覆盖；缺省 = 项目根 PLAN.md）
 *   cap                会话轮次上限（写入新建 store；已有 store 以 store 为准），默认 3
 *   pendingTtlMinutes  pending TTL（默认 30）
 *   storeDir           store 目录（默认 ~/.reeve/plan-gate；测试隔离用）
 * 依赖注入：ledger = src/ledger.js 实例（根会话判别 + review_rounds 记账），logger，directory = 项目根。
 */
export function createPlanGate({ options = null, ledger = null, logger = console, directory = null } = {}) {
  const enabled = options === true || (typeof options === 'object' && options !== null && options.enabled === true)
  if (!enabled) {
    // dormant：返回一个显式的"未启用"句柄，装配层据此一个 hook 都不挂。
    return { enabled: false }
  }

  const cfg = typeof options === 'object' && options !== null ? options : {}
  const matchers = Array.isArray(cfg.matchers) && cfg.matchers.every((m) => typeof m === 'string' && m.length > 0)
    ? [...cfg.matchers]
    : [...DEFAULT_MATCHERS]
  const reviewers = Array.isArray(cfg.reviewers) && cfg.reviewers.every((m) => typeof m === 'string' && m.length > 0)
    ? [...cfg.reviewers]
    : [...DEFAULT_REVIEWERS]
  const cap = Number.isFinite(cfg.cap) && cfg.cap > 0 ? Math.floor(cfg.cap) : DEFAULT_CAP
  const ttlMs = Number.isFinite(cfg.pendingTtlMinutes) && cfg.pendingTtlMinutes > 0
    ? cfg.pendingTtlMinutes * 60 * 1000
    : PENDING_TTL_MS
  const storeDir = typeof cfg.storeDir === 'string' && cfg.storeDir.trim().length > 0
    ? resolve(cfg.storeDir.trim())
    : join(homedir(), '.reeve', 'plan-gate')
  const defaultPlanPath = typeof cfg.planPath === 'string' && cfg.planPath.trim().length > 0
    ? resolve(cfg.planPath.trim())
    : join(directory || process.cwd(), 'PLAN.md')

  const io = makeStoreIo(storeDir)

  const noisy = (message) => logger?.debug?.(`[reeve][plan-gate] ${message}`)

  /**
   * D1：artifact 盘上现字节（Buffer）与哈希；读不到 → null（fail-closed：比对必走"哈希不等"行）。
   * 单次读盘同时供哈希与 kind 分类用（hashArtifact/readArtifactBytes 各自读会有 TOCTOU 缝）。
   */
  const readArtifactBytes = (planPath) => {
    if (typeof planPath !== 'string' || planPath.length === 0) return null
    try {
      return readFileSync(planPath)
    } catch {
      return null
    }
  }
  const hashArtifact = (planPath) => {
    const bytes = readArtifactBytes(planPath)
    return bytes == null ? null : canonicalPlanHash(bytes)
  }

  /** D2/F2：根会话判别（适配器责任）。台账知道本插件自己派出去的每个子会话（跨重启恢复）。 */
  const isRootSession = (sessionId) =>
    typeof sessionId === 'string' && sessionId.length > 0 && (ledger?.forChildSession(sessionId) ?? null) == null

  /**
   * gate-check 的一次完整询问（根会话专用；非根由调用方按 #0 放行，不进这里）。
   * 只读，不写 store（矩阵 gate-check 各行 storeEffect 全为 none）。
   * store 文件缺失 = 该会话从未入域 → allow（见文件头"激活域"）。
   */
  const checkRoot = (sessionId) => {
    const read = readStore(io, sessionId, { cap })
    if (!read.ok) {
      noisy(`store unreadable (${read.reason}); gate-check denies as no verdict on file`)
      return {
        transition: 'gate-check',
        decision: 'deny',
        reason: 'gate store unreadable; treated as no verdict on file; run the review first',
        applied: true,
      }
    }
    if (read.fresh) {
      return {
        transition: 'gate-check',
        decision: 'allow',
        reason: 'no plan-gate record for this session; gate dormant',
        applied: false,
      }
    }
    // TOCTOU：此刻重读盘上现字节重哈希，与判决绑定哈希比对（D1）
    const planHash = hashArtifact(read.record.planPath)
    if (planHash == null) noisy(`artifact unreadable at gate-check: ${read.record.planPath}`)
    return { ...decide(read, planHash, cap), applied: true }
  }

  /** exec 拦截的出口。失败通道 = execute.before 的返回错误对象（施工图 §4.1：返回 Tool.Error 在工具跑之前拒绝）。文案全 ASCII（矩阵 reasonText 纪律）。 */
  const block = (decision, reason) => {
    const error = new Error(`PLAN-GATE ${String(decision).toUpperCase()}: ${reason}`)
    error.planGate = { decision, reason }
    return error
  }

  // ---- execute.before：dispatch-review（评审派发）+ gate-check（exec 类被看护迁移）----
  const before = async (event) => {
    try {
      const toolName = String(event?.tool ?? '')
      const input = event?.input && typeof event.input === 'object' ? event.input : {}
      const agent = typeof input.agent === 'string' && input.agent ? input.agent : null

      // (1) dispatch-review：向评审 agent 的 subagent 派发被观测到 → 记当时盘上字节（D1）。
      //     非根会话的派发不记（D2：sessionId 恒为根会话）。
      if (toolName === SUBAGENT_TOOL && agent != null && reviewers.includes(agent)) {
        const sessionId = event?.sessionID
        if (!isRootSession(sessionId)) return undefined
        const toolCallId = String(event?.id ?? '')
        if (!toolCallId) {
          noisy('dispatch skipped: no tool call id; pending would be keyed by an empty string')
          return undefined
        }
        const read = readStore(io, sessionId, { cap })
        if (!read.ok) {
          noisy(`dispatch skipped: store unreadable (${read.reason}); only a human override may rebuild`)
          return undefined
        }
        const artifactPath = read.record.planPath || defaultPlanPath
        const artifactHash = hashArtifact(artifactPath)
        if (artifactHash == null) noisy(`artifact unreadable at dispatch: ${artifactPath}`)
        const result = dispatchReview(io, sessionId, {
          toolCallId,
          artifactPath,
          artifactHash,
          now: Date.now(),
        })
        if (result.decision !== 'record') noisy(`dispatch-review ${result.decision}: ${result.reason}`)
        return undefined
      }

      // (2) gate-check：exec 类被看护迁移将要发生。
      if (!matchers.includes(toolName)) return undefined
      const sessionId = event?.sessionID
      if (!isRootSession(sessionId)) {
        // 缺会话 id 无法定位 store：未知形态 → fail-closed（§7）；非根上下文 → #0 放行
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          noisy(`gate-check on unresolved session (tool=${toolName}); fail-closed`)
          return block('deny', 'plan-gate could not resolve the calling session; blocked (fail-closed)')
        }
        return undefined
      }
      const verdict = checkRoot(sessionId)
      if (verdict.decision === 'allow') return undefined
      return block(verdict.decision, verdict.reason)
    } catch (err) {
      // 门禁未知错误 → 拦 + 吵日志（§7：失败出口形态属适配器，方向恒为拦）
      noisy(`gate-check unknown error; fail-closed: ${String(err).slice(0, 200)}`)
      return block('deny', 'plan-gate internal error; the guarded action is blocked (fail-closed)')
    }
  }

  // ---- execute.after：verdict-observed（评审真实结果被观测到，采集方向不拦）----
  const after = async (event) => {
    try {
      if (String(event?.tool ?? '') !== SUBAGENT_TOOL) return
      const input = event?.input && typeof event.input === 'object' ? event.input : {}
      const agent = typeof input.agent === 'string' && input.agent ? input.agent : null
      if (agent == null || !reviewers.includes(agent)) return
      const sessionId = event?.sessionID
      if (!isRootSession(sessionId)) return // 非根观测不落（D2）
      // 评审工具自身失败（管线崩溃）= 没有可用输出 → 空文本进双通道必然解析失败 →
      // 走 D3（rounds+1、pending 保留、重派恰一次；再失败 escalate）。F1：宿主照常继续。
      const output = event?.status === 'error' ? '' : extractResultText(event?.result)
      const result = observeVerdict(io, sessionId, {
        toolCallId: String(event?.id ?? ''),
        output,
        now: Date.now(),
        ttlMs,
      })
      if (result.decision !== 'record') noisy(`verdict-observed ${result.decision}: ${result.reason}`)
      recordRound(event, input, result)
    } catch (err) {
      // 采集未知错误 → 不落任何记录（往"无判决"方向收敛）+ 吵日志；绝不抛（after 永不失败）
      noisy(`verdict capture unknown error; nothing recorded: ${String(err).slice(0, 200)}`)
    }
  }

  /**
   * review_rounds 记进台账（ask 钉的三件事之一）：每个被处理的评审观测都在台账里留一行——
   * 轮值（处理后的会话累计 rounds）、判决/解析失败/忽略、原因、绑定的 artifact 路径与哈希。
   * 台账记录本体是 index.js 的 execute.after 建的（taskID = 工具调用 id）；这里 get-or-create
   * （注册顺序谁先谁后都不丢），再补 review 字段。
   */
  const recordRound = (event, input, result) => {
    const taskID = String(event?.id ?? '')
    if (!taskID || !ledger) return
    try {
      if (!ledger.get(taskID)) {
        ledger.create({
          taskID,
          parentSessionID: event?.sessionID ?? null,
          agent: (typeof input.agent === 'string' && input.agent) || reviewers[0],
          description: 'plan-gate review observation',
          background: input.background === true,
          model: input.model ?? null,
        })
      }
      const record = result.record ?? null
      const latest = Array.isArray(record?.verdicts) && record.verdicts.length > 0
        ? record.verdicts[record.verdicts.length - 1]
        : null
      ledger.update(taskID, {
        review: {
          transition: result.transition,
          decision: result.decision,
          reason: result.reason,
          round: record && Number.isFinite(record.rounds) ? record.rounds : null,
          verdictDecision: latest && typeof latest.decision === 'string' ? latest.decision : null,
          hash: latest && typeof latest.hash === 'string' ? latest.hash : null,
          planPath: record && typeof record.planPath === 'string' ? record.planPath : null,
          parseFailures: record && Number.isFinite(record.parseFailures) ? record.parseFailures : null,
          at: Date.now(),
        },
      })
    } catch (err) {
      noisy(`review round ledger write failed (ignored): ${String(err).slice(0, 200)}`)
    }
  }

  // ---- review_gate 工具：只有 register / check 两个操作 ----
  // 没有 submit，也没有：判决只能来自评审工具真实结果的观测（SPEC §2 对抗面立场），
  // agent 自报判决 = 绕过门禁。人工解锁走 overrideSession()（只给人用）。
  // register 的 kind 参数（M2.4）：'plan'（缺省，文件内容自动判别 engine-run）|
  // 'workflow-script'（脚本文件显式登记——裸函数体无文件内 kind 标记）。未知 kind 拒绝。
  // P4（register 面与 P3.3 串行落地）：workflow-script 按 basename(planPath) 扩展名分流——
  // .ts 走 classifyWorkflowScriptAsync（TS 语法 only：transform 喂 vm，坐标系唯一 = .ts 源
  // 文本；哈希仍绑 .ts 文件全字节，D1 不变），其余走 classifyWorkflowScript 原样（JS 零回归）。
  // .ts ⇒ registerSession 为 async（transform 是 async API，C4 注记 ①）——JS 行为除 await 外
  // 逐位不变。
  // P3.3：baseExecution 入参——补段评审上下文（script-patch.js buildPatchContext 的 ok:true
  // 结果，编排方在登记补段文件时传入）；payload 原样回带，供编排方注入 review 派发 prompt
  // （renderPatchReviewContext 的消费面）。只随 register payload 回带，**不进 store**（D1 哈希
  // 绑定面不变；评审上下文是派发时点的现场快照，不是门禁判定输入）。
  const registerSession = async (sessionId, planPath, kind = 'plan', baseExecution = undefined) => {
    if (!isRootSession(sessionId)) {
      return { ok: false, error: 'register is root-session-only; the calling session is a managed child' }
    }
    if (typeof planPath !== 'string' || planPath.trim().length === 0) {
      return { ok: false, error: 'register requires planPath (the artifact file under review)' }
    }
    if (kind !== 'plan' && kind !== WORKFLOW_SCRIPT_KIND) {
      return { ok: false, error: `register requires kind "plan" or "workflow-script" (got ${String(kind)})` }
    }
    if (baseExecution !== undefined && (typeof baseExecution !== 'object' || baseExecution === null || Array.isArray(baseExecution))) {
      return { ok: false, error: 'register: baseExecution must be an object (buildPatchContext result) or omitted' }
    }
    const artifactPath = resolve(planPath.trim())
    const artifactBytes = readArtifactBytes(artifactPath)
    if (artifactBytes == null) {
      noisy(`register refused: artifact unreadable at register: ${artifactPath}`)
      return { ok: false, error: `artifact unreadable at register: ${artifactPath}; nothing recorded` }
    }
    const artifactHash = canonicalPlanHash(artifactBytes)
    // S9（E1 集成）：kind:"engine-run" 的声明文件登记前过声明校验；M2.4：kind:"workflow-script"
    // 的脚本文件登记前过语法门 + 命令字面量扫描（供评审）。P4：.ts 走 TS 前端（transform 后
    // 同一 vm.Script 构造，语法判定零分叉；平台包缺失 → classifyWorkflowScriptAsync 抛显式
    // Error——禁静默回退 JS，原则 4）。不合法拒绝且零记录。
    // 普通方案文件（kind='plan'）不经任何内容校验（文件内 kind 是唯一判别器）。校验拒绝在
    // torn 判定之后：store 撕裂时 register 无论 artifact 是什么都进不去（矩阵：自动化迁移不重建）。
    const scriptName = basename(artifactPath)
    const artifact =
      kind === WORKFLOW_SCRIPT_KIND
        ? isTsScriptName(scriptName)
          ? await classifyWorkflowScriptAsync(artifactBytes, scriptName)
          : classifyWorkflowScript(artifactBytes)
        : classifyArtifact(artifactBytes)
    const read = readStore(io, sessionId, { cap })
    if (!read.ok) {
      noisy(`register refused: store unreadable (${read.reason}); only a human override may rebuild`)
      return { ok: false, error: 'gate store unreadable; only a human override may rebuild the store' }
    }
    if (artifact.kind === ENGINE_RUN_KIND && !artifact.ok) {
      noisy(`register refused: engine-run declaration invalid (${artifact.errors.length} errors)`)
      return { ok: false, error: `engine-run declaration invalid: ${artifact.errors.join('; ')}; nothing recorded` }
    }
    if (artifact.kind === WORKFLOW_SCRIPT_KIND && !artifact.ok) {
      noisy(`register refused: workflow-script invalid (${artifact.errors.length} errors)`)
      return { ok: false, error: `workflow-script invalid: ${artifact.errors.join('; ')}; nothing recorded` }
    }
    const now = Date.now()
    const record = read.record
    record.planPath = artifactPath
    record.updatedAt = now
    // 注意：register 只钉 artifact（planPath），不碰 verdicts/rounds/parseFailures/pending ——
    // 改路径后旧判决哈希必然对不上 → 门禁保持关闭直到重新评审（D1，fail-closed）。
    // 脚本文件同轨：哈希绑文件全字节（.ts 绑 .ts 原字节），gate-check TOCTOU 重读重哈希
    // （门禁判定零分叉）。
    writeStore(io, sessionId, record)
    const latest = record.verdicts.length > 0 ? record.verdicts[record.verdicts.length - 1] : null
    return {
      ok: true,
      op: 'register',
      planPath: artifactPath,
      hash: artifactHash,
      artifactKind:
        artifact.kind === ENGINE_RUN_KIND ? ENGINE_RUN_KIND : artifact.kind === WORKFLOW_SCRIPT_KIND ? WORKFLOW_SCRIPT_KIND : 'artifact',
      declaration: artifact.kind === ENGINE_RUN_KIND && artifact.ok ? artifact.declaration : null,
      script: artifact.kind === WORKFLOW_SCRIPT_KIND && artifact.ok ? artifact.script : null,
      // P3.3：补段评审上下文回带（评审 prompt 注入素材；未传 = null）
      baseExecution: baseExecution ?? null,
      rounds: record.rounds,
      parseFailures: record.parseFailures,
      cap: record.cap,
      fresh: read.fresh === true,
      latestVerdict: latest ? { decision: latest.decision, round: latest.round, hash: latest.hash } : null,
    }
  }

  const tool = {
    name: 'review_gate',
    description:
      'plan-gate 方案评审门禁。register：登记本会话的方案文件（评审与哈希绑定的盘上 artifact；' +
      '也接受 kind:"engine-run" 的引擎运行声明文件——文件内容自带 kind 标记——和 kind:"workflow-script" ' +
      '的编排脚本文件（裸函数体，须以 kind 参数显式声明；.js/.ts 均收，.ts 由插件自带 esbuild 剥类型后按同一语法门登记；' +
      '登记前过语法门并返回命令字面量扫描供评审），不合法拒绝）。' +
      '登记补段文件时传 baseExecution（buildPatchContext 结果）——payload 回带该现场，供拼进评审派发 prompt。' +
      'check：查询当前门禁判定（allow/deny/escalate、原因、轮值 rounds/cap）。' +
      '没有提交判决的操作——判决只能来自 critic 评审的真实结果观测，agent 不得自报。',
    input: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['register', 'check'], description: 'register=登记方案文件；check=查询门禁判定' },
        planPath: {
          type: 'string',
          description:
            'register 必填：方案文件的盘上路径（hash 绑定它的现字节）。也接受 engine-run 声明文件（顶层 "kind":"engine-run"）与 workflow-script 脚本文件（kind 参数给 "workflow-script"；.js/.ts）',
        },
        kind: {
          type: 'string',
          enum: ['plan', 'workflow-script'],
          description:
            'register 可选（缺省 plan）：workflow-script = planPath 指向编排脚本文件（裸函数体，引擎包装为 async function main(F){…} 执行；.ts 脚本自动走 TS 前端剥类型，语法门与 JS 同一 vm 编译）；engine-run 声明文件无需此参数（文件内容自动判别）',
        },
        baseExecution: {
          type: 'object',
          description:
            'register 可选（补段登记用）：补段评审上下文（buildPatchContext 的 ok:true 结果）——payload 原样回带，把 renderPatchReviewContext(baseExecution) 的文本拼进评审派发 prompt，critic 才知道 base 段已执行到哪',
        },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: { type: 'string' },
    options: { namespace: TOOL_NAMESPACE, codemode: false },
    execute: async (args, context) => {
      const op = args?.op
      const sessionId = context?.sessionID
      let payload
      if (op === 'register') {
        payload = await registerSession(sessionId, args?.planPath, args?.kind ?? 'plan', args?.baseExecution)
      } else if (op === 'check') {
        // 会话不可用先判：isRootSession 为真蕴含"非空字符串"，这条臂若排在它之后就是死代码
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          payload = { ok: false, op: 'check', error: 'session unavailable; gate cannot apply' }
        } else if (!isRootSession(sessionId)) {
          payload = {
            ok: true,
            op: 'check',
            transition: 'gate-check',
            decision: 'allow',
            reason: 'non-root context is out of gate scope; no store consult',
            applied: false,
          }
        } else {
          const read = readStore(io, sessionId, { cap })
          if (!read.ok) {
            noisy(`check refused: store unreadable (${read.reason})`)
            payload = {
              ok: true,
              op: 'check',
              transition: 'gate-check',
              decision: 'deny',
              reason: 'gate store unreadable; treated as no verdict on file; run the review first',
              applied: true,
            }
          } else if (read.fresh) {
            payload = {
              ok: true,
              op: 'check',
              transition: 'gate-check',
              decision: 'allow',
              reason: 'no plan-gate record for this session; gate dormant (register a plan first)',
              applied: false,
            }
          } else {
            const verdict = checkRoot(sessionId)
            payload = {
              ok: true,
              op: 'check',
              ...verdict,
              planPath: read.record.planPath,
              rounds: read.record.rounds,
              parseFailures: read.record.parseFailures,
              cap: read.record.cap,
              pending: Object.keys(read.record.pending ?? {}),
            }
          }
        }
      } else {
        payload = { ok: false, error: `unknown op: ${String(op)}; only register and check exist` }
      }
      return {
        output: JSON.stringify(payload, null, 2),
        metadata: { op: String(op ?? ''), ok: payload.ok !== false, decision: payload.decision ?? null },
      }
    },
  }

  /**
   * 人工解锁（human-override）：只给人用的入口（CLI/运维），不经任何 agent 可达路径暴露。
   * 决策 pass|reject；哈希 = override 时点 planPath 盘上现字节（D1）。
   * 唯一可重建 torn/缺失 store 的写者（矩阵 human-override#1/#2）。
   */
  const overrideSession = (sessionId, decision, planPath) => {
    const read = readStore(io, sessionId, { cap })
    const artifactPath =
      typeof planPath === 'string' && planPath.trim().length > 0
        ? resolve(planPath.trim())
        : read.ok && !read.fresh && read.record.planPath
          ? read.record.planPath
          : defaultPlanPath
    const artifactHash = hashArtifact(artifactPath)
    if (artifactHash == null) {
      return { ok: false, error: `artifact unreadable at override: ${artifactPath}; nothing recorded` }
    }
    const result = humanOverride(io, sessionId, { decision, artifactHash, planPath: artifactPath, now: Date.now() })
    if (result.decision !== 'record') return { ok: false, error: result.reason }
    return { ok: true, op: 'override', planPath: artifactPath, hash: artifactHash, record: result.record }
  }

  return {
    enabled: true,
    matchers,
    reviewers,
    storeDir,
    defaultPlanPath,
    io,
    before,
    after,
    tool,
    /** 只读询问：门禁判定（check 工具与测试用；非根按 #0 放行，不碰 store）。 */
    checkSession: (sessionId) => {
      if (!isRootSession(sessionId)) {
        return {
          transition: 'gate-check',
          decision: 'allow',
          reason: 'non-root context is out of gate scope; no store consult',
          applied: false,
        }
      }
      return checkRoot(sessionId)
    },
    registerSession,
    overrideSession,
    /** 根会话判别（测试与诊断用）。 */
    isRootSession,
  }
}
