// plan-gate 测试：决策矩阵逐行（T2.1）+ stub ctx 适配层夹具（T2.2）。
//
// 权威语义落点 = plugin/test/fixtures/decision-matrix.json（SPEC 头部 pin 其 sha256）。
// **行文一律运行时读取，不复制任何行**（R2-1）：断言里的 decision / reason / storeEffect
// 全部来自 fixture 的 row.expected；测试代码只写"怎么把实现摆进行首声明的前提、怎么触发
// 输入"（场景），不写"该出什么结果"（期望）。
//
// 首测 = 本文件头部 pin 的 fixture sha256 对本机文件重算比对。改 fixture = 核心变更
// （SPEC §9）：重算 sha256、更新本文件与 SPEC 头部两侧 pin、同步两侧测试。
//
// 两层驱动：
//   T2.1  矩阵 26 行 → 核心函数（dispatchReview/observeVerdict/decide/decideIfApplicable/
//         humanOverride）+ 注入式 MemIo + 合成时钟 NOW：期望（含 ts: NOW 的精确 storeEffect）
//         逐条款对齐 fixture。行驱动器与 ZCode 适配器（OpenCodeConfig/plan-gate/tests/
//         core.test.mjs，T1.1）同构——同一个 fixture，两份实现各自复现。
//   T2.2  stub ctx（全合成数据：临时 storeDir / 临时方案文件 / 无网、重 IO 全关）→ 走
//         plugin.setup 的真实装配面：两个 execute.before + 两个 execute.after 钩子、
//         review_gate 工具、task_status 读 review_rounds；verdict 解析断言（fence 容错 +
//         双通道不一致按 reject）+ 负向（跳过 critic 直接 check → deny；exec 前偷改方案
//         文件 → deny）。
//
// 运行：node plugin/test/plan-gate.mjs（assert 失败即抛、非零退出；成功路径自然退出，绝不 process.exit）

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import plugin from '../src/index.js'
import * as gate from '../src/plan-gate.js'
import { DEFAULT_CAP, PENDING_TTL_MS, TRANSITIONS, VERDICT_DECISIONS } from '../src/plan-gate.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- 权威 fixture（运行时读；本文件不复制任何行）----
const MATRIX_URL = new URL('./fixtures/decision-matrix.json', import.meta.url)
/** R2-1：与 OpenCodeConfig 仓 plan-gate/SPEC.md（头部 pin 权威矩阵哈希）pin 的同一哈希。 */
const MATRIX_SHA256_PIN = '20f4ae0b93ae00ac75830fbdf80f99e7656f7c32565e10d3676a53f434b7522c'
const matrix = JSON.parse(readFileSync(MATRIX_URL, 'utf8'))
const rowById = (id) => {
  const row = matrix.rows.find((r) => r.id === id)
  assert.ok(row, `fixture 必须含行 ${id}`)
  return row
}

// ── 世界常量：fixture globals.symbols 的实例化 ──
const MIN = 60_000
const NOW = 1_735_000_000_000 // 各行 precondition.clock = NOW
const S = 'session-root-1' // a root session id
const C1 = 'call-1' // distinct call ids
const C2 = 'call-2'
const K1 = gate.pendingKey(S, C1) // 'S:C1'
const K2 = gate.pendingKey(S, C2) // 'S:C2'
const ARTIFACT_PATH_IN_STORE = 'plan.md'
const ARTIFACT_V1 = Buffer.from('plan bytes v1\n') // 派发时点字节
const ARTIFACT_V2 = Buffer.from('plan bytes v2 - changed on disk\n') // 盘上现值（H2 != H1）
const H1 = gate.canonicalPlanHash(ARTIFACT_V1)
const H2 = gate.canonicalPlanHash(ARTIFACT_V2)
const SYM = { S, C1, C2, K1, K2, H1, H2, NOW, TTL: matrix.globals.pendingTtlMinutes * MIN }
/** K1/K2 → 物理 pending 键（即 toolCallId 值）；全文件唯一映射，杜绝键名漂移。 */
const toolCallOfK = (k) => SYM[k.replace('K', 'C')]
const TORN_RAW = '{"planPath":"plan.md","pending":{' // 截断 JSON

// ═════════════════════════════════════════════════════════════════════════════
// T2.1 基础设施：把 fixture 行的字符串前提/输入/效果实例化为可执行世界
// （行驱动器与 ZCode 适配器 T1.1 同构；条款词表来自同一个权威 fixture）
// ═════════════════════════════════════════════════════════════════════════════

/** 注入式内存 io：files 即全部持久状态，reads/writes 计数供副作用断言。 */
class MemIo {
  constructor() {
    this.files = new Map()
    this.reads = 0
    this.writes = 0
  }
  read(sessionId) {
    this.reads += 1
    return this.files.has(sessionId) ? this.files.get(sessionId) : null
  }
  write(sessionId, content) {
    this.writes += 1
    this.files.set(sessionId, content)
  }
}

/** 按 precondition.store 子句实例化初始 store（子句文本来自 fixture，此处只做实例化）。 */
function applyPreconditionClause(rec, clause) {
  let m
  if (
    clause === 'parseable' ||
    clause === 'verdicts = []' ||
    /^pending = \{\}$/.test(clause) ||
    /^pending has no entry for K\d$/.test(clause)
  ) {
    return
  }
  if ((m = clause.match(/^pending\[(K\d)\] = \{hash: (H\d), ts: NOW-(\d+)min\}$/))) {
    rec.pending[toolCallOfK(m[1])] = { hash: SYM[m[2]], ts: NOW - Number(m[3]) * MIN }
    return
  }
  if (/^pending\[K1\] from the failed first attempt may still exist$/.test(clause)) {
    rec.pending[C1] = { hash: H1, ts: NOW - 5 * MIN }
    return
  }
  if (/^pending\[K1\] kept from the failed attempt$/.test(clause)) {
    rec.pending[C1] = { hash: H1, ts: NOW - 5 * MIN }
    return
  }
  if (/^pending holds the kept entries of the two failed attempts$/.test(clause)) {
    rec.pending[C1] = { hash: H1, ts: NOW - 9 * MIN }
    rec.pending[C2] = { hash: H1, ts: NOW - 2 * MIN }
    return
  }
  if ((m = clause.match(/^parseFailures = (\d+)$/))) {
    rec.parseFailures = Number(m[1])
    return
  }
  if ((m = clause.match(/^rounds = (\d+)$/))) {
    rec.rounds = Number(m[1])
    return
  }
  if ((m = clause.match(/^cap = (\d+)$/))) {
    rec.cap = Number(m[1])
    return
  }
  if ((m = clause.match(/^verdicts = \[\{hash: (H\d), round: (\d+), decision: (pass|reject), ts\}\]$/))) {
    rec.verdicts = [{ hash: SYM[m[1]], round: Number(m[2]), decision: m[3], ts: NOW - MIN }]
    return
  }
  throw new Error(`无法实例化 fixture 前提条款: ${JSON.stringify(clause)}`)
}

function makeWorld(row) {
  const io = new MemIo()
  const storeStr = row.precondition?.store ?? ''
  if (/exists but unparseable or shape-invalid/.test(storeStr)) {
    io.files.set(S, TORN_RAW)
  } else if (storeStr.length > 0) {
    const rec = gate.freshStoreRecord({ planPath: ARTIFACT_PATH_IN_STORE, now: NOW - MIN })
    for (const clause of storeStr.split(';').map((s) => s.trim()).filter(Boolean)) {
      applyPreconditionClause(rec, clause)
    }
    io.files.set(S, JSON.stringify(rec, null, 2))
  }
  const raw = io.files.get(S)
  let beforeRec = null
  if (raw) {
    try {
      beforeRec = JSON.parse(raw)
    } catch {
      beforeRec = null // torn 前态：无可用记录快照
    }
  }
  return { io, before: new Map(io.files), beforeRec }
}

function dispatchInput(row) {
  const callRef = row.input.callId.match(/(C\d)/)[1]
  const artifact = row.precondition?.artifact ?? ''
  const unreadable = /unreadable|missing|unresolvable/.test(artifact)
  const hashRef = artifact.match(/hash to (H\d)/)?.[1] ?? 'H1'
  return {
    toolCallId: SYM[callRef],
    artifactPath: ARTIFACT_PATH_IN_STORE,
    artifactHash: unreadable ? null : SYM[hashRef],
    now: NOW,
  }
}

// §4 评审输出契约的合成器：JSON 块（fence 容错的素材）与散文末行
const fenceJsonBlock = (d) =>
  '```json\n' +
  JSON.stringify({ decision: d, planPath: ARTIFACT_PATH_IN_STORE, round: 1, findings: ['sample finding'] }, null, 2) +
  '\n```'
const fenceRawBlock = (s) => '```json\n' + s + '\n```'
const proseVerdict = (d) => `Reviewer concludes: ${d}.`
const proseUnresolvable = () => 'Reviewer output was not machine readable.'

function verdictInput(row) {
  const keyRef = row.input.pendingKey.match(/(K\d)/)[1]
  const cj = row.input.channelJson
  const cp = row.input.channelProse
  const jm = cj.match(/decision = (pass|reject)/i)
  let jsonBlock = null
  if (jm) jsonBlock = fenceJsonBlock(jm[1].toLowerCase())
  else if (/missing, not valid JSON, or decision not in/.test(cj)) {
    jsonBlock = fenceRawBlock('{"decision":"maybe","planPath":"plan.md"}')
  }
  const pm = cp.match(/resolves to (pass|reject)/i)
  const prose = pm ? proseVerdict(pm[1].toLowerCase()) : proseUnresolvable()
  return {
    toolCallId: toolCallOfK(keyRef),
    output: jsonBlock ? `${prose}\n\n${jsonBlock}` : prose,
    now: NOW,
  }
}

function gateCheckPlanHash(row) {
  const artifact = row.precondition?.artifact ?? row.input?.artifact ?? ''
  const m = artifact.match(/(?:hash to|hashes) (H\d)/)
  return m ? SYM[m[1]] : H1
}

function assertEffectClause(row, clause, rec, beforeRec) {
  const id = row.id
  let m
  if (clause === 'store rebuilt if it was torn or missing') return // 由 writes===1 + 形状校验覆盖
  if (/the next gate check follows the reject rows/.test(clause)) return // 由 override-reject 端到端覆盖
  if (/^planPath = artifactPath$/.test(clause)) {
    assert.equal(rec.planPath, ARTIFACT_PATH_IN_STORE, `[${id}] planPath`)
    return
  }
  if ((m = clause.match(/^pending\[(K\d)\] = \{hash: (H\d), ts: NOW\}$/))) {
    assert.deepEqual(rec.pending[toolCallOfK(m[1])], { hash: SYM[m[2]], ts: NOW }, `[${id}] ${clause}`)
    return
  }
  if ((m = clause.match(/^pending\[(K\d)\] untouched$/))) {
    const key = toolCallOfK(m[1])
    assert.deepEqual(rec.pending[key], beforeRec?.pending?.[key] ?? undefined, `[${id}] ${clause}`)
    return
  }
  if ((m = clause.match(/^pending\[(K\d)\] kept( unchanged)?$/))) {
    const key = toolCallOfK(m[1])
    assert.ok(rec.pending[key], `[${id}] ${clause} -> 条目应存在`)
    assert.deepEqual(rec.pending[key], beforeRec?.pending?.[key], `[${id}] ${clause}`)
    return
  }
  if ((m = clause.match(/^delete pending\[(K\d)\]$/))) {
    assert.equal(rec.pending[toolCallOfK(m[1])], undefined, `[${id}] ${clause}`)
    return
  }
  if (/^pending = \{\}$/.test(clause)) {
    assert.deepEqual(rec.pending, {}, `[${id}] pending 清空`)
    return
  }
  if (/^no verdict appended$/.test(clause)) {
    assert.equal(rec.verdicts.length, (beforeRec?.verdicts ?? []).length, `[${id}] ${clause}`)
    return
  }
  if (
    (m = clause.match(
      /^verdicts \+= \{hash: (H\d), round: (\d+), decision: (pass|reject), ts: NOW(?:, reason: human-override)?\}$/,
    ))
  ) {
    assert.equal(rec.verdicts.length, (beforeRec?.verdicts ?? []).length + 1, `[${id}] verdicts +1`)
    const v = rec.verdicts[rec.verdicts.length - 1]
    assert.deepEqual(
      { hash: v.hash, round: v.round, decision: v.decision, ts: v.ts, reason: v.reason },
      {
        hash: SYM[m[1]],
        round: Number(m[2]),
        decision: m[3],
        ts: NOW,
        reason: clause.includes('reason: human-override') ? 'human-override' : undefined,
      },
      `[${id}] verdict item`,
    )
    return
  }
  if ((m = clause.match(/^rounds = (\d+)$/))) {
    assert.equal(rec.rounds, Number(m[1]), `[${id}] rounds`)
    return
  }
  if (/^rounds unchanged$/.test(clause)) {
    assert.equal(rec.rounds, beforeRec?.rounds ?? 0, `[${id}] rounds unchanged`)
    return
  }
  if ((m = clause.match(/^parseFailures = (\d+)$/))) {
    assert.equal(rec.parseFailures, Number(m[1]), `[${id}] parseFailures`)
    return
  }
  if (/^updatedAt = NOW$/.test(clause)) {
    assert.equal(rec.updatedAt, NOW, `[${id}] updatedAt`)
    return
  }
  throw new Error(`[${id}] 无法解析 storeEffect 条款: ${JSON.stringify(clause)}`)
}

function assertRowOutcome(row, result, world) {
  assert.equal(result.transition, row.transition, `[${row.id}] transition`)
  assert.equal(result.decision, row.expected.decision, `[${row.id}] decision`)
  assert.equal(result.reason, row.expected.reason, `[${row.id}] reason`)
  const effect = row.expected.storeEffect.trim()
  if (effect === 'none' || effect.startsWith('none;')) {
    assert.equal(world.io.writes, 0, `[${row.id}] storeEffect none -> 不得写 store`)
    assert.deepEqual(world.io.files, world.before, `[${row.id}] storeEffect none -> 文件逐字节不变`)
    return
  }
  assert.equal(world.io.writes, 1, `[${row.id}] 恰一次整文件重写`)
  const rec = JSON.parse(world.io.files.get(S))
  assert.ok(gate.validateStoreRecord(rec), `[${row.id}] 写出的 store 过形状校验`)
  for (const clause of effect.split(';').map((s) => s.trim()).filter(Boolean)) {
    assertEffectClause(row, clause, rec, world.beforeRec)
  }
}

// human-override 的 precondition.store = any state：对四类前态逐一复现同一行。
const OVERRIDE_STATES = {
  torn: () => {
    const io = new MemIo()
    io.files.set(S, TORN_RAW)
    return io
  },
  missing: () => new MemIo(),
  'cap-exhausted': () => {
    const io = new MemIo()
    const rec = gate.freshStoreRecord({ planPath: ARTIFACT_PATH_IN_STORE, now: NOW - MIN })
    rec.verdicts = [{ hash: H1, round: 3, decision: 'reject', ts: NOW - MIN }]
    rec.rounds = 3
    rec.pending[C1] = { hash: H1, ts: NOW - 2 * MIN }
    io.files.set(S, JSON.stringify(rec, null, 2))
    return io
  },
  'mid-loop': () => {
    const io = new MemIo()
    const rec = gate.freshStoreRecord({ planPath: ARTIFACT_PATH_IN_STORE, now: NOW - MIN })
    rec.pending[C1] = { hash: H1, ts: NOW - 5 * MIN }
    rec.rounds = 1
    rec.parseFailures = 1
    io.files.set(S, JSON.stringify(rec, null, 2))
    return io
  },
}

const covered = new Set()

function runMatrixRow(row) {
  covered.add(row.id)
  const t = row.transition
  if (t === 'dispatch-review') {
    const world = makeWorld(row)
    assertRowOutcome(row, gate.dispatchReview(world.io, S, dispatchInput(row)), world)
    return
  }
  if (t === 'verdict-observed') {
    const world = makeWorld(row)
    assertRowOutcome(row, gate.observeVerdict(world.io, S, verdictInput(row)), world)
    return
  }
  if (t === 'gate-check') {
    if (/NOT the root session/.test(row.precondition?.resolvedSession ?? '')) {
      // gate-check#0：根判别在适配器；核心以 decideIfApplicable 表达「不适用即放行、不碰 store」
      const io = new MemIo()
      io.files.set(S, TORN_RAW) // 即使 store 撕裂也不得被询问
      const before = new Map(io.files)
      const result = gate.decideIfApplicable({
        resolvedSessionId: 'review-worker-own-context',
        rootSessionId: S,
        store: null,
        planHash: H1,
        cap: 3,
      })
      assert.equal(result.decision, row.expected.decision, `[${row.id}] decision`)
      assert.equal(result.reason, row.expected.reason, `[${row.id}] reason`)
      assert.equal(result.applied, false, `[${row.id}] applied`)
      assert.equal(io.reads, 0, `[${row.id}] 非根上下文不询问 store`)
      assert.deepEqual(io.files, before, `[${row.id}] storeEffect none -> 文件逐字节不变`)
      return
    }
    const world = makeWorld(row)
    const read = gate.readStore(world.io, S)
    assertRowOutcome(row, gate.decide(read, gateCheckPlanHash(row), undefined), world)
    return
  }
  if (t === 'human-override') {
    const overrideDecision = row.input.overrideDecision.match(/(pass|reject)/)[1]
    const artifactHash = SYM[row.precondition.artifact.match(/hash to (H\d)/)?.[1] ?? 'H2']
    for (const [stateName, seed] of Object.entries(OVERRIDE_STATES)) {
      const io = seed()
      const rawBefore = io.files.get(S)
      let beforeRec = null
      if (rawBefore) {
        try {
          beforeRec = JSON.parse(rawBefore)
        } catch {
          beforeRec = null
        }
      }
      const result = gate.humanOverride(io, S, { decision: overrideDecision, artifactHash, now: NOW })
      assert.equal(result.decision, row.expected.decision, `[${row.id}/${stateName}] decision`)
      assert.equal(result.reason, row.expected.reason, `[${row.id}/${stateName}] reason`)
      assert.equal(io.writes, 1, `[${row.id}/${stateName}] 恰一次整文件重写`)
      const rec = JSON.parse(io.files.get(S))
      assert.ok(gate.validateStoreRecord(rec), `[${row.id}/${stateName}] 重建/更新后的 store 过形状校验`)
      for (const clause of row.expected.storeEffect.split(';').map((s) => s.trim()).filter(Boolean)) {
        assertEffectClause(row, clause, rec, beforeRec)
      }
    }
    return
  }
  throw new Error(`未知 transition: ${t}`)
}

// ═════════════════════════════════════════════════════════════════════════════
// 第 1 节：R2-1 身份与 globals 对齐
// ═════════════════════════════════════════════════════════════════════════════
{
  const actual = createHash('sha256').update(readFileSync(MATRIX_URL)).digest('hex')
  assert.equal(actual, MATRIX_SHA256_PIN, '权威 fixture 的 sha256 必须 pin 住（变了 = 核心变更，两侧同步）')
  ok(`fixture sha256 pin 对齐（${MATRIX_SHA256_PIN.slice(0, 12)}…）`)

  assert.equal(matrix.kind, 'plan-gate-decision-matrix')
  assert.equal(matrix.schemaVersion, 1)
  assert.equal(DEFAULT_CAP, matrix.globals.defaultCap, 'DEFAULT_CAP 与 fixture globals.defaultCap 同源')
  assert.equal(PENDING_TTL_MS, matrix.globals.pendingTtlMinutes * MIN, 'PENDING_TTL_MS 与 globals.pendingTtlMinutes 同源')
  assert.deepEqual([...TRANSITIONS].sort(), ['dispatch-review', 'gate-check', 'human-override', 'verdict-observed'])
  assert.deepEqual([...VERDICT_DECISIONS], ['pass', 'reject'])
  for (const row of matrix.rows) {
    assert.match(row.id, /^(dispatch-review|verdict-observed|gate-check|human-override)#\d+$/, `行键规则: ${row.id}`)
  }

  // 词表守门（计划 L20）：决策矩阵 fixture 禁止宿主交互面词汇——宿主产品名 / 模式名 /
  // 方案呈现动作名 / 挂点事件名 / exec 类工具名。fixture 是宿主无关核心的唯一权威落点，
  // 宿主词混进行文 = 核心被宿主绑架；断言在 reeve 侧 CI（npm --prefix plugin test）常跑，
  // 未来的宿主词漂移直接红。
  const rawMatrix = readFileSync(MATRIX_URL, 'utf8')
  const BANNED_HOST_WORDS = [
    ['宿主产品名', /\b(?:zcode|opencode|openchamber|reeve|oh-my-openagent)\b/i],
    ['宿主模式名', /\bplan[\s-]mode\b/i],
    ['方案呈现动作名', /\bExitPlanMode\b/],
    ['挂点事件名', /\b(?:PreToolUse|PostToolUse|execute\.before|execute\.after)\b/],
    ['exec 类工具名', /\b(?:shell|execute|subagent|hook|hooks|task|agent)\b/],
  ]
  for (const [label, re] of BANNED_HOST_WORDS) {
    const hits = rawMatrix.match(new RegExp(re.source, re.flags + 'g')) ?? []
    assert.deepEqual(hits, [], `fixture 不得出现${label}（词表守门）：${hits.join(' | ')}`)
  }
  ok(`globals 同源（cap=${DEFAULT_CAP}、ttl=${matrix.globals.pendingTtlMinutes}min）+ ${matrix.rows.length} 行行键全合法 + 词表守门 0 命中`)
}

// ═════════════════════════════════════════════════════════════════════════════
// 第 2 节：T2.1 矩阵逐行（运行时驱动；期望全部来自 fixture）
// ═════════════════════════════════════════════════════════════════════════════
{
  const rowsByTransition = {}
  for (const row of matrix.rows) {
    ;(rowsByTransition[row.transition] ??= []).push(row)
  }
  let rowCount = 0
  for (const [transition, rows] of Object.entries(rowsByTransition)) {
    for (const row of rows) {
      runMatrixRow(row) // 断言失败即抛（消息带 [row.id] 前缀）
      rowCount += 1
    }
    ok(`矩阵逐行：${transition}（${rows.length} 行，期望逐条款对齐 fixture）`)
  }
  assert.equal(rowCount, matrix.rows.length, '驱动的行数 = fixture 行数')
  assert.equal(covered.size, matrix.rows.length, '行覆盖去重后 = 全部行数（零遗漏、零复制）')
  ok(`行覆盖完整性：${covered.size}/${matrix.rows.length} 行全驱动；human-override 两行另按四类前态（torn/missing/cap-exhausted/mid-loop）各复现一次`)
}

// ═════════════════════════════════════════════════════════════════════════════
// 第 3 节：verdict 解析契约（fence 容错 + 双通道不一致按 reject）——纯函数面
// ═════════════════════════════════════════════════════════════════════════════
{
  // fence 容错：```json 与裸 ``` 均接受；块前后允许散文；多块取尾部
  assert.deepEqual(gate.parseJsonChannel(`前言散文。\n\n${fenceJsonBlock('pass')}`), { ok: true, decision: 'pass' })
  assert.deepEqual(gate.parseJsonChannel(`前言。\n\n${fenceJsonBlock('reject')}\n\n后记散文。`), { ok: true, decision: 'reject' })
  assert.deepEqual(gate.parseJsonChannel('x\n\n```\n{"decision":"reject"}\n```'), { ok: true, decision: 'reject' }, '裸 fence')
  assert.deepEqual(gate.parseJsonChannel(`${fenceJsonBlock('reject')}\n\n${fenceJsonBlock('pass')}`), { ok: true, decision: 'pass' }, '尾部块胜出')
  // 坏 JSON：decision 非法值 / 非 JSON / 无围栏块
  assert.equal(gate.parseJsonChannel(fenceRawBlock('{"decision":"maybe"}')).ok, false)
  assert.equal(gate.parseJsonChannel(fenceRawBlock('not json at all {')).ok, false)
  assert.equal(gate.parseJsonChannel('no fence here, decision: pass').ok, false)
  ok('verdict JSON 通道：```json/裸 ```/块前后散文/尾部块胜出/坏 JSON 不解析')

  // 双通道合议：一致采之；不一致按 reject（两个极性都要测）；单通道可解析 = 解析失败（D3）
  const agree = gate.resolveReviewOutput(`${proseVerdict('pass')}\n\n${fenceJsonBlock('pass')}`)
  assert.deepEqual([agree.kind, agree.decision, agree.disagree], ['verdict', 'pass', false])
  const dis1 = gate.resolveReviewOutput(`${proseVerdict('reject')}\n\n${fenceJsonBlock('pass')}`) // JSON pass / 散文 reject
  assert.deepEqual([dis1.kind, dis1.decision, dis1.disagree], ['verdict', 'reject', true])
  const dis2 = gate.resolveReviewOutput(`${proseVerdict('pass')}\n\n${fenceJsonBlock('reject')}`) // JSON reject / 散文 pass
  assert.deepEqual([dis2.kind, dis2.decision, dis2.disagree], ['verdict', 'reject', true])
  assert.equal(gate.resolveReviewOutput(fenceJsonBlock('pass')).kind, 'parse-failure', '只有 JSON 通道 = 解析失败')
  assert.equal(gate.resolveReviewOutput(proseVerdict('pass')).kind, 'parse-failure', '只有散文通道 = 解析失败')
  assert.equal(
    gate.resolveReviewOutput(`${proseUnresolvable()}\n\n${fenceRawBlock('{"decision":"maybe"}')}`).kind,
    'parse-failure',
    '双通道都坏 = 解析失败',
  )
  // 散文通道：末行判词、两词并存按 reject、围栏内不算散文
  assert.deepEqual(gate.parseProseChannel(`a\nb\n${proseVerdict('pass')}`), { ok: true, decision: 'pass' })
  assert.deepEqual(gate.parseProseChannel(`${proseVerdict('pass')}\n${proseVerdict('reject')}`), { ok: true, decision: 'reject' })
  assert.equal(gate.parseProseChannel('```\n{"decision":"pass"}\n```').ok, false)
  // 散文通道中文契约（agents/critic.md 三节末行判词）：「通过/不通过」；不通过先判（含「通过」子串）
  assert.deepEqual(gate.parseProseChannel('最后一行给结论：**通过**'), { ok: true, decision: 'pass' })
  assert.deepEqual(gate.parseProseChannel('最后一行给结论：**不通过**'), { ok: true, decision: 'reject' })
  assert.deepEqual(gate.parseProseChannel('a\nb\n结论：不通过'), { ok: true, decision: 'reject' })
  assert.equal(gate.parseProseChannel('末行不含判词。').ok, false)
  // 与真实 critic 输出同构：中文散文末行 + 尾部 JSON 块（修复前该形态必为 parse-failure）
  const zhAgree = gate.resolveReviewOutput(`散文发现……\n\n最后一行给结论：**通过**\n\n${fenceJsonBlock('pass')}`)
  assert.deepEqual([zhAgree.kind, zhAgree.decision, zhAgree.disagree], ['verdict', 'pass', false])
  const zhReject = gate.resolveReviewOutput(`散文发现……\n\n最后一行给结论：**不通过**\n\n${fenceJsonBlock('reject')}`)
  assert.deepEqual([zhReject.kind, zhReject.decision, zhReject.disagree], ['verdict', 'reject', false])
  const zhDisagree = gate.resolveReviewOutput(`散文发现……\n\n最后一行给结论：**通过**\n\n${fenceJsonBlock('reject')}`)
  assert.deepEqual([zhDisagree.kind, zhDisagree.decision, zhDisagree.disagree], ['verdict', 'reject', true])
  ok('双通道合议：一致采之 / 不一致按 reject（两极性）/ 单通道可解析 = 解析失败 / 中文末行判词（通过/不通过）')
}

// ═════════════════════════════════════════════════════════════════════════════
// 第 4 节起：T2.2 stub ctx 夹具（全合成数据，走 plugin.setup 的真实装配面）
// ═════════════════════════════════════════════════════════════════════════════

/** stub ctx（entry.mjs 捕获式 fake 的 plan-gate 变体）：全合成，重 IO 全关，storeDir 进临时目录。 */
function makeCtx({ storageSeed = new Map(), options: optionOverrides = {} } = {}) {
  const captured = { tools: [], toolHooks: [], sessionHooks: [] }
  const storage = {
    async get(key) {
      return storageSeed.get(key) ?? null
    },
    async set(key, value) {
      storageSeed.set(key, value)
    },
    async scan({ prefix }) {
      const entries = [...storageSeed.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value }))
      return { entries }
    },
  }
  const editor = () => ({
    add: (tool) => captured.tools.push(tool),
    get: () => undefined,
    update: (id, fn) => {
      const a = {}
      fn(a)
      return a
    },
    models: new Map(),
    agent: (id) => ({ id, hidden: false }),
  })
  const ctx = {
    options: {
      gate: false,
      ownEndpoint: false,
      snapshotPath: false,
      stats: { intervalMs: 0 },
      ...optionOverrides,
    },
    storage,
    location: { directory: null },
    tool: {
      transform: async (fn) => fn(editor()),
      hook: async (name, handler) => captured.toolHooks.push([name, handler]),
    },
    session: { hook: async (name, handler) => captured.sessionHooks.push([name, handler]), interrupt: async () => {} },
    event: {
      subscribe: () => (async function* () {})(),
    },
    provider: { transform: async (fn) => fn(editor()) },
    agent: { transform: async (fn) => fn({ get: () => undefined, update: () => {} }), list: async () => ({ data: [] }) },
    skill: { transform: async (fn) => fn({ get: () => undefined, add: () => {} }) },
  }
  return { ctx, captured, storageSeed }
}

/** 引擎行为合成：一次事件喂给全部已注册钩子（引擎对每个钩子都会调），返回各钩子的返回值。 */
const fireBefore = async (captured, event) => {
  const results = []
  for (const [, h] of captured.toolHooks.filter(([n]) => n === 'execute.before')) {
    results.push(await h(event))
  }
  return results
}
const fireAfter = async (captured, event) => {
  const results = []
  for (const [, h] of captured.toolHooks.filter(([n]) => n === 'execute.after')) {
    results.push(await h(event))
  }
  return results
}
/** 未被拦截 = 所有钩子都返回 undefined。 */
const assertUnblocked = (results, label) => assert.deepEqual(results.filter((r) => r !== undefined), [], label)
const toolByName = (captured, name) => {
  const tool = captured.tools.find((t) => t.name === name)
  assert.ok(tool, `${name} 工具必须已注册`)
  return tool
}
const storeFile = (storeDir, sessionId) => join(storeDir, `${gate.storeStem(sessionId)}.json`)
const readStoreRaw = (storeDir, sessionId) => JSON.parse(readFileSync(storeFile(storeDir, sessionId), 'utf8'))

// ---- 4a. 装配面 + happy 回路：register → 派发 critic → 判决 pass → check allow；review_rounds 进台账 ----
{
  const home = mkdtempSync(join(tmpdir(), 'reeve-plan-gate-'))
  const storeDir = join(home, 'store')
  const planPath = join(home, 'plan.md')
  mkdirSync(storeDir, { recursive: true })
  writeFileSync(planPath, ARTIFACT_V1)
  const { ctx, captured } = makeCtx({ options: { planGate: { enabled: true, storeDir, planPath } } })
  let dispose = null
  try {
    dispose = await plugin.setup(ctx)

    // 装配面：enabled 时 plan-gate 钩子成对出现 + review_gate 注册进 reeve 命名空间
    assert.equal(captured.toolHooks.filter(([n]) => n === 'execute.before').length, 2, 'execute.before ×2')
    assert.equal(captured.toolHooks.filter(([n]) => n === 'execute.after').length, 2, 'execute.after ×2')
    const reviewGate = toolByName(captured, 'review_gate')
    assert.deepEqual(reviewGate.input.properties.op.enum, ['register', 'check'], '只有 register/check 两操作')
    assert.equal(reviewGate.options.namespace, 'reeve')
    assert.equal(reviewGate.options.codemode, false, 'codemode:false 才暴露给模型')
    assert.equal(JSON.stringify(reviewGate).includes('submit'), false, '无 submit 操作')

    // happy 回路（引擎行为合成：事件喂全部钩子）
    const reg = JSON.parse((await reviewGate.execute({ op: 'register', planPath }, { sessionID: S })).output)
    assert.equal(reg.ok, true, 'register 成功')
    assert.equal(reg.hash, H1, 'register 绑盘上现字节')

    await fireBefore(captured, { tool: 'subagent', sessionID: S, id: C1, input: { agent: 'critic' } })
    const stored1 = readStoreRaw(storeDir, S)
    assert.deepEqual(stored1.pending[C1], { hash: H1, ts: stored1.pending[C1].ts }, 'pending 绑派发时点字节（哈希）')
    assert.equal(stored1.planPath, planPath)

    await fireAfter(captured, {
      tool: 'subagent',
      sessionID: S,
      id: C1,
      input: { agent: 'critic' },
      status: 'success',
      result: { output: `${proseVerdict('pass')}\n\n${fenceJsonBlock('pass')}` },
    })
    const stored2 = readStoreRaw(storeDir, S)
    assert.equal(stored2.verdicts.length, 1, '判决落 store')
    assert.equal(stored2.verdicts[0].hash, H1, '判决绑派发时点哈希（D1）')
    assert.deepEqual([stored2.rounds, stored2.parseFailures, Object.keys(stored2.pending).length], [1, 0, 0])

    const chk = JSON.parse((await reviewGate.execute({ op: 'check' }, { sessionID: S })).output)
    assert.equal(chk.decision, rowById('gate-check#10').expected.decision, '收敛放行（gate-check#10）')
    assert.equal(chk.reason, rowById('gate-check#10').expected.reason)
    const blockedNothing = await fireBefore(captured, { tool: 'shell', sessionID: S, id: 'x1', input: { command: 'ls' } })
    assertUnblocked(blockedNothing, 'gate 开着：shell 放行（钩子都不拦）')

    // review_rounds 记进台账（task_status 读回）
    const status = toolByName(captured, 'task_status')
    const tasks = JSON.parse((await status.execute({ includeTerminal: true })).output).tasks
    const row = tasks.find((t) => t.taskID === C1)
    assert.ok(row, 'critic 调用进台账')
    assert.equal(row.review.decision, 'record', 'review_rounds：decision=record')
    assert.equal(row.review.round, 1, 'review_rounds：round=1')
    assert.equal(row.review.hash, H1, 'review_rounds：绑哈希')
    assert.equal(row.review.verdictDecision, 'pass')
    assert.equal(row.review.planPath, planPath)

    dispose()
    ok('装配面 + happy 回路：register → 派发 → pass → check#10 放行；review_rounds 进台账')
  } finally {
    dispose?.()
    rmSync(home, { recursive: true, force: true })
  }
}

// ---- 4b. 负向①：跳过 critic 直接 check → deny（期望 = fixture gate-check#4 原文）----
{
  const home = mkdtempSync(join(tmpdir(), 'reeve-plan-gate-'))
  const storeDir = join(home, 'store')
  const planPath = join(home, 'plan.md')
  mkdirSync(storeDir, { recursive: true })
  writeFileSync(planPath, ARTIFACT_V1)
  const { ctx, captured } = makeCtx({ options: { planGate: { enabled: true, storeDir, planPath } } })
  let dispose = null
  try {
    dispose = await plugin.setup(ctx)
    const reviewGate = toolByName(captured, 'review_gate')

    // 登记了方案但从不派发 critic、也不落任何判决
    const reg = JSON.parse((await reviewGate.execute({ op: 'register', planPath }, { sessionID: S })).output)
    assert.equal(reg.ok, true)

    const chk = JSON.parse((await reviewGate.execute({ op: 'check' }, { sessionID: S })).output)
    assert.equal(chk.decision, rowById('gate-check#4').expected.decision, '跳过 critic → deny（gate-check#4）')
    assert.equal(chk.reason, rowById('gate-check#4').expected.reason)

    // 同一局面下的 exec 调用同样被拦，文案带矩阵原文
    const results = []
    for (const [, h] of captured.toolHooks.filter(([n]) => n === 'execute.before')) {
      results.push(await h({ tool: 'shell', sessionID: S, id: 'x1', input: { command: 'ls' } }))
    }
    const blockError = results.find((r) => r !== undefined)
    assert.ok(blockError instanceof Error, 'shell 被 execute.before 拦下')
    assert.ok(blockError.message.includes('PLAN-GATE DENY'), `拦截文案带方向: ${blockError.message}`)
    assert.ok(blockError.message.includes(rowById('gate-check#4').expected.reason), '拦截文案带矩阵 gate-check#4 原文')

    // matcher 之外的工具不拦
    const passthrough = await fireBefore(captured, { tool: 'read', sessionID: S, id: 'x2', input: {} })
    assertUnblocked(passthrough, 'matcher 外（read）不拦')

    // review_gate 无 submit：未知 op 报错（agent 不得自报判决）
    const submit = JSON.parse((await reviewGate.execute({ op: 'submit', decision: 'pass' }, { sessionID: S })).output)
    assert.equal(submit.ok, false, 'submit 不存在')

    dispose()
    ok('负向①：跳过 critic 直接 check/exec → deny（gate-check#4 原文）；submit 不存在')
  } finally {
    dispose?.()
    rmSync(home, { recursive: true, force: true })
  }
}

// ---- 4c. 负向②：exec 前偷改方案文件 → deny（TOCTOU，期望 = fixture gate-check#5 原文）；改回 → 放行 ----
{
  const home = mkdtempSync(join(tmpdir(), 'reeve-plan-gate-'))
  const storeDir = join(home, 'store')
  const planPath = join(home, 'plan.md')
  mkdirSync(storeDir, { recursive: true })
  writeFileSync(planPath, ARTIFACT_V1)
  const { ctx, captured } = makeCtx({ options: { planGate: { enabled: true, storeDir, planPath } } })
  let dispose = null
  try {
    dispose = await plugin.setup(ctx)
    const reviewGate = toolByName(captured, 'review_gate')

    assert.equal(JSON.parse((await reviewGate.execute({ op: 'register', planPath }, { sessionID: S })).output).ok, true)
    await fireBefore(captured, { tool: 'subagent', sessionID: S, id: C1, input: { agent: 'critic' } })
    await fireAfter(captured, {
      tool: 'subagent',
      sessionID: S,
      id: C1,
      input: { agent: 'critic' },
      status: 'success',
      result: { output: `${proseVerdict('pass')}\n\n${fenceJsonBlock('pass')}` },
    })

    // TOCTOU：判决落定之后、exec 触发之前，偷改盘上字节
    writeFileSync(planPath, ARTIFACT_V2)
    const err = await fireBefore(captured, { tool: 'shell', sessionID: S, id: 'x1', input: { command: 'ls' } })
    const blockError = err.find((r) => r !== undefined)
    assert.ok(blockError instanceof Error, '偷改后的 shell 被拦（哈希比对 fail-closed）')
    assert.ok(blockError.message.includes(rowById('gate-check#5').expected.reason), '拦截文案带矩阵 gate-check#5 原文')

    // 改回原字节 → 哈希重新对上 → 放行（收敛句仍成立）
    writeFileSync(planPath, ARTIFACT_V1)
    const restored = await fireBefore(captured, { tool: 'shell', sessionID: S, id: 'x2', input: { command: 'ls' } })
    assertUnblocked(restored, '字节恢复 → 放行')
    const chk = JSON.parse((await reviewGate.execute({ op: 'check' }, { sessionID: S })).output)
    assert.equal(chk.decision, rowById('gate-check#10').expected.decision)
    assert.equal(chk.reason, rowById('gate-check#10').expected.reason)

    dispose()
    ok('负向②：exec 前偷改方案文件 → deny（gate-check#5 原文，TOCTOU）；字节恢复 → 放行')
  } finally {
    dispose?.()
    rmSync(home, { recursive: true, force: true })
  }
}

// ---- 4d. 采集面：双通道不一致按 reject；单通道可解析 = 解析失败（D3：rounds+1、pending 保留、重派恰一次）----
{
  const home = mkdtempSync(join(tmpdir(), 'reeve-plan-gate-'))
  const storeDir = join(home, 'store')
  const planPath = join(home, 'plan.md')
  mkdirSync(storeDir, { recursive: true })
  writeFileSync(planPath, ARTIFACT_V1)
  const { ctx, captured, storageSeed } = makeCtx({ options: { planGate: { enabled: true, storeDir, planPath } } })
  let dispose = null
  try {
    dispose = await plugin.setup(ctx)
    const reviewGate = toolByName(captured, 'review_gate')
    const status = toolByName(captured, 'task_status')

    assert.equal(JSON.parse((await reviewGate.execute({ op: 'register', planPath }, { sessionID: S })).output).ok, true)

    // 双通道不一致（JSON pass / 散文 reject）→ 落 reject（verdict-observed#3 原文进台账）
    await fireBefore(captured, { tool: 'subagent', sessionID: S, id: C1, input: { agent: 'critic' } })
    await fireAfter(captured, {
      tool: 'subagent',
      sessionID: S,
      id: C1,
      input: { agent: 'critic' },
      status: 'success',
      result: { output: `${proseVerdict('reject')}\n\n${fenceJsonBlock('pass')}` },
    })
    let stored = readStoreRaw(storeDir, S)
    assert.equal(stored.verdicts[0].decision, 'reject', '双通道不一致 → reject')
    assert.deepEqual([stored.rounds, stored.parseFailures, Object.keys(stored.pending).length], [1, 0, 0], 'rounds=1、清零、pending 消费')
    const ledgerRow1 = JSON.parse((await status.execute({ includeTerminal: true })).output).tasks.find((t) => t.taskID === C1)
    assert.equal(ledgerRow1.review.reason, rowById('verdict-observed#3').expected.reason, '台账带矩阵 verdict-observed#3 原文')

    // 单通道可解析（只有 JSON 块）= 解析失败 → 不落判决、rounds+1、pending 保留（#5）
    await fireBefore(captured, { tool: 'subagent', sessionID: S, id: 'call-3', input: { agent: 'critic' } })
    await fireAfter(captured, {
      tool: 'subagent',
      sessionID: S,
      id: 'call-3',
      input: { agent: 'critic' },
      status: 'success',
      result: { output: fenceJsonBlock('pass') },
    })
    stored = readStoreRaw(storeDir, S)
    assert.equal(stored.verdicts.length, 1, '不落新判决')
    assert.deepEqual([stored.rounds, stored.parseFailures], [2, 1], 'rounds+1、parseFailures=1')
    assert.ok(stored.pending['call-3'], 'pending 保留（重派恰一次）')
    const ledgerRow2 = JSON.parse((await status.execute({ includeTerminal: true })).output).tasks.find((t) => t.taskID === 'call-3')
    assert.equal(ledgerRow2.review.decision, 'no-verdict')
    assert.equal(ledgerRow2.review.reason, rowById('verdict-observed#5').expected.reason, '台账带矩阵 verdict-observed#5 原文')

    // 连续第二次解析失败 → escalate（gate-check#2 原文经 check 读出）
    await fireBefore(captured, { tool: 'subagent', sessionID: S, id: C2, input: { agent: 'critic' } })
    await fireAfter(captured, {
      tool: 'subagent',
      sessionID: S,
      id: C2,
      input: { agent: 'critic' },
      status: 'success',
      result: { output: proseUnresolvable() },
    })
    stored = readStoreRaw(storeDir, S)
    assert.deepEqual([stored.rounds, stored.parseFailures], [3, 2])
    const chk = JSON.parse((await reviewGate.execute({ op: 'check' }, { sessionID: S })).output)
    assert.equal(chk.decision, rowById('gate-check#2').expected.decision, '连续两次解析失败 → escalate')
    assert.equal(chk.reason, rowById('gate-check#2').expected.reason)
    const err = await fireBefore(captured, { tool: 'shell', sessionID: S, id: 'x3', input: { command: 'ls' } })
    const blockError = err.find((r) => r !== undefined)
    assert.ok(blockError instanceof Error && blockError.message.includes('PLAN-GATE ESCALATE'), 'escalate 同样拦 exec')
    assert.ok(storageSeed.size > 0, '台账确实写进 storage')

    dispose()
    ok('采集面：不一致按 reject / 单通道=解析失败（rounds+1、pending 保留）/ 连续两次 → escalate 拦 exec')
  } finally {
    dispose?.()
    rmSync(home, { recursive: true, force: true })
  }
}

// ---- 4e. 域控制（stub ctx 上复现 gate-check#0 与适配器 dormant 边界）----
{
  const home = mkdtempSync(join(tmpdir(), 'reeve-plan-gate-'))
  const storeDir = join(home, 'store')
  const planPath = join(home, 'plan.md')
  mkdirSync(storeDir, { recursive: true })
  writeFileSync(planPath, ARTIFACT_V1)
  const { ctx, captured } = makeCtx({ options: { planGate: { enabled: true, storeDir, planPath } } })
  let dispose = null
  try {
    dispose = await plugin.setup(ctx)
    const CHILD = 'ses_child_1'

    // 子会话登记：经由台账正常建账（executor 前台委派 → childSessionID 进账）
    await fireBefore(captured, { tool: 'subagent', sessionID: S, id: 'call-exec', input: { agent: 'executor' } })
    await fireAfter(captured, {
      tool: 'subagent',
      sessionID: S,
      id: 'call-exec',
      input: { agent: 'executor' },
      status: 'success',
      result: { output: { sessionID: CHILD } },
    })

    // dormant：从未 register/派发评审的根会话 → exec 不拦（域外，无 store 询问）
    const dormant = await fireBefore(captured, { tool: 'shell', sessionID: 'ses_从不入域', id: 'y1', input: {} })
    assertUnblocked(dormant, '域外根会话不拦')
    assert.throws(() => readFileSync(storeFile(storeDir, 'ses_从不入域'), 'utf8'), '域外不落 store 文件')

    // gate-check#0：子会话 exec 放行——即便其名下 store 撕裂也不得被询问
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(storeFile(storeDir, CHILD), TORN_RAW)
    const childExec = await fireBefore(captured, { tool: 'shell', sessionID: CHILD, id: 'y2', input: {} })
    assertUnblocked(childExec, '子会话 exec 放行（#0）')

    // 非根上下文的 critic 派发不记 pending（D2：sessionId 恒为根会话）——撕裂文件原样保留
    await fireBefore(captured, { tool: 'subagent', sessionID: CHILD, id: C1, input: { agent: 'critic' } })
    assert.equal(readFileSync(storeFile(storeDir, CHILD), 'utf8'), TORN_RAW, '子会话派发不触碰其 store')

    // 非 critic 的 subagent 派发不采集（reviewers 默认 ['critic']）：不记 pending、不落判决
    await fireBefore(captured, { tool: 'subagent', sessionID: S, id: 'call-scout', input: { agent: 'scout' } })
    await fireAfter(captured, {
      tool: 'subagent',
      sessionID: S,
      id: 'call-scout',
      input: { agent: 'scout' },
      status: 'success',
      result: { output: `${proseVerdict('pass')}\n\n${fenceJsonBlock('pass')}` },
    })
    assert.throws(() => readFileSync(storeFile(storeDir, S), 'utf8'), '非 critic 派发/观测不建 store（S 未入域）')

    dispose()
    ok('域控制：dormant 不记录不拦 / 子会话 exec 放行（撕裂 store 也不问）/ 非根派发与非 critic 均不采集')
  } finally {
    dispose?.()
    rmSync(home, { recursive: true, force: true })
  }
}

// ---- 4f. 人工 override（stub ctx 上的适配器入口；torn store 唯一合法重建者）----
{
  const home = mkdtempSync(join(tmpdir(), 'reeve-plan-gate-'))
  const storeDir = join(home, 'store')
  const planPath = join(home, 'plan.md')
  mkdirSync(storeDir, { recursive: true })
  writeFileSync(planPath, ARTIFACT_V2) // 盘上现值 = V2（对应 precondition 的 H2）
  const { ctx, captured } = makeCtx({ options: { planGate: { enabled: true, storeDir, planPath } } })
  let dispose = null
  try {
    dispose = await plugin.setup(ctx)

    // 撕裂 store：register 拒绝（自动化迁移不重建），override 重建（human-override#1）
    writeFileSync(storeFile(storeDir, S), TORN_RAW)
    const reviewGate = toolByName(captured, 'review_gate')
    const regRefused = JSON.parse((await reviewGate.execute({ op: 'register', planPath }, { sessionID: S })).output)
    assert.equal(regRefused.ok, false, 'torn store 上 register 拒绝（不重建）')
    assert.ok(readFileSync(storeFile(storeDir, S), 'utf8').startsWith('{"planPath":"plan.md","pending":{'), '撕裂文件原样保留')

    // 人工入口：override pass → 重建 + rounds 归零 + 下一次 check 放行（#1 尾注）
    const override = gate.createPlanGate({
      options: { enabled: true, storeDir, planPath },
      ledger: null,
      logger: { debug: () => {} },
      directory: home,
    })
    const ov = override.overrideSession(S, 'pass', planPath)
    assert.equal(ov.ok, true, 'override 落地')
    const stored = readStoreRaw(storeDir, S)
    assert.equal(stored.rounds, 0, 'rounds 归零')
    assert.deepEqual(stored.verdicts.at(-1), { hash: H2, round: 0, decision: 'pass', ts: stored.verdicts.at(-1).ts, reason: 'human-override' })
    assert.equal(stored.planPath, planPath, 'override 重钉 artifact（reeve 侧 gate-check 以 store.planPath 为准）')
    const chk = JSON.parse((await reviewGate.execute({ op: 'check' }, { sessionID: S })).output)
    assert.equal(chk.decision, rowById('gate-check#10').expected.decision, 'override 后下一查放行')
    assert.equal(chk.reason, rowById('gate-check#10').expected.reason)

    // override reject → 下一查走 reject 行（human-override#2 尾注）
    const override2 = gate.createPlanGate({
      options: { enabled: true, storeDir, planPath },
      ledger: null,
      logger: { debug: () => {} },
      directory: home,
    })
    const ov2 = override2.overrideSession(S, 'reject', planPath)
    assert.equal(ov2.ok, true)
    const chk2 = JSON.parse((await reviewGate.execute({ op: 'check' }, { sessionID: S })).output)
    assert.equal(chk2.decision, rowById('gate-check#7').expected.decision)
    assert.equal(chk2.reason, rowById('gate-check#7').expected.reason)

    dispose()
    ok('人工 override：torn 重建 + rounds 归零 → 放行；override reject → 下一查走 reject 行；register 拒重建')
  } finally {
    dispose?.()
    rmSync(home, { recursive: true, force: true })
  }
}

// ---- 4g. 工具面与适配器入口的负分支（T2.0：plan-gate.js 进 c8 分母后，补测把全局语句顶回基线）----
{
  const home = mkdtempSync(join(tmpdir(), 'reeve-plan-gate-'))
  const storeDir = join(home, 'store')
  const planPath = join(home, 'plan.md')
  mkdirSync(storeDir, { recursive: true })
  writeFileSync(planPath, ARTIFACT_V1)

  // extractResultText 全形态（SPEC §4 双通道的输入面：钻取序 output→content→text→result→message）
  assert.equal(gate.extractResultText('raw'), 'raw')
  assert.equal(gate.extractResultText(null), '')
  assert.equal(gate.extractResultText(undefined), '')
  assert.equal(gate.extractResultText([{ output: 'a' }, { content: 'b' }]), 'a\nb')
  assert.equal(gate.extractResultText({ content: [{ text: 'deep' }] }), 'deep')
  assert.equal(gate.extractResultText({ text: 't' }), 't')
  assert.equal(gate.extractResultText({ result: 'r' }), 'r')
  assert.equal(gate.extractResultText({ message: 'm' }), 'm')
  assert.equal(gate.extractResultText({ unrelated: true }), '{"unrelated":true}')
  assert.equal(gate.extractResultText(42), '42')

  const g = gate.createPlanGate({ options: { enabled: true, storeDir, planPath }, ledger: null, logger: { debug: () => {} }, directory: home })
  const childGate = gate.createPlanGate({
    options: { enabled: true, storeDir },
    ledger: { forChildSession: (id) => (id === 'ses_child' ? { taskID: 't' } : null) },
    logger: { debug: () => {} },
    directory: home,
  })

  // registerSession 负分支：非根拒绝 / 空 planPath / artifact 不可读
  const regChild = await childGate.registerSession('ses_child', planPath)
  assert.equal(regChild.ok, false, 'register 非根拒绝')
  assert.ok(regChild.error.includes('root-session-only'))
  assert.deepEqual(await g.registerSession(S, '   '), { ok: false, error: 'register requires planPath (the artifact file under review)' })
  const regUnreadable = await g.registerSession(S, join(home, 'no-such-plan.md'))
  assert.equal(regUnreadable.ok, false, 'register 对不可读 artifact 拒绝')
  assert.ok(regUnreadable.error.includes('artifact unreadable at register'))

  // register S 后依次覆盖 override 三条 artifact 解析臂 + check 两态
  assert.equal(JSON.parse((await g.tool.execute({ op: 'register', planPath }, { sessionID: S })).output).ok, true)
  const ovUnreadable = g.overrideSession(S, 'pass', join(home, 'no-such-plan.md'))
  assert.equal(ovUnreadable.ok, false, 'override 显式路径不可读 → 拒绝且不落')
  assert.ok(ovUnreadable.error.includes('artifact unreadable at override'))
  const checkS1 = JSON.parse((await g.tool.execute({ op: 'check' }, { sessionID: S })).output)
  assert.deepEqual([checkS1.decision, checkS1.reason], [rowById('gate-check#4').expected.decision, rowById('gate-check#4').expected.reason])
  assert.deepEqual([checkS1.rounds, checkS1.parseFailures, checkS1.cap, checkS1.pending], [0, 0, 3, []], 'check 载荷带轮值/上限/pending')
  const ovReuse = g.overrideSession(S, 'pass') // 无显式路径 → 复用 store.planPath
  assert.equal(ovReuse.ok, true, 'override 复用 store.planPath')
  assert.equal(ovReuse.planPath, planPath)
  const checkS2 = JSON.parse((await g.tool.execute({ op: 'check' }, { sessionID: S })).output)
  assert.equal(checkS2.decision, 'allow', 'override pass 后下一查放行')

  // checkSession 三形态：非根 applied:false / 域外 dormant / 撕裂 deny
  const childCheck = childGate.checkSession('ses_child')
  assert.deepEqual([childCheck.decision, childCheck.applied], ['allow', false], '非根 checkSession 按 #0 放行')
  const dormant = g.checkSession('ses_never')
  assert.deepEqual([dormant.decision, dormant.applied], ['allow', false], '域外根会话 dormant')
  writeFileSync(storeFile(storeDir, 'ses_torn'), TORN_RAW)
  const torn = g.checkSession('ses_torn')
  assert.deepEqual([torn.decision, torn.reason], ['deny', 'gate store unreadable; treated as no verdict on file; run the review first'])

  // review_gate 工具 check 的负分支：非根 / 会话 id 不可用 / fresh dormant
  const checkChild = JSON.parse((await childGate.tool.execute({ op: 'check' }, { sessionID: 'ses_child' })).output)
  assert.equal(checkChild.applied, false, '工具面非根 check 放行且不碰 store')
  const checkNoSession = JSON.parse((await childGate.tool.execute({ op: 'check' }, { sessionID: '' })).output)
  assert.equal(checkNoSession.ok, false, '会话 id 不可用 → gate 无法适用')
  const checkFresh = JSON.parse((await g.tool.execute({ op: 'check' }, { sessionID: 'ses_fresh' })).output)
  assert.equal(checkFresh.decision, 'allow')
  assert.ok(checkFresh.reason.includes('dormant'), 'fresh 会话 dormant 放行')

  // 门禁未知错误 → fail-closed 拦（§7）：台账判别炸了也必须拦
  const boomGate = gate.createPlanGate({
    options: { enabled: true, storeDir },
    ledger: {
      forChildSession() {
        throw new Error('ledger exploded')
      },
    },
    logger: { debug: () => {} },
    directory: home,
  })
  const boomBlock = await boomGate.before({ tool: 'shell', sessionID: S, id: 'z1', input: {} })
  assert.ok(boomBlock instanceof Error && boomBlock.message.includes('fail-closed'), '未知错误朝拦截方向收敛')

  // 派发缺 toolCallId：不记 pending（键不能是空串）
  const g2 = gate.createPlanGate({ options: { enabled: true, storeDir, planPath }, ledger: null, logger: { debug: () => {} }, directory: home })
  await g2.before({ tool: 'subagent', sessionID: 'ses_noid', id: '', input: { agent: 'critic' } })
  assert.throws(() => readFileSync(storeFile(storeDir, 'ses_noid'), 'utf8'), '缺调用 id 不落任何记录')

  // 派发时 store 撕裂：不记、不重建、原样保留
  await g2.before({ tool: 'subagent', sessionID: 'ses_torn', id: 'z2', input: { agent: 'critic' } })
  assert.equal(readFileSync(storeFile(storeDir, 'ses_torn'), 'utf8'), TORN_RAW, '撕裂 store 上派发不触碰')

  // 采集未知错误（result 钻取抛错）→ 不落任何记录、after 永不抛
  const evil = { get output() { throw new Error('result access exploded') } }
  await g2.after({ tool: 'subagent', sessionID: 'ses_evil', id: 'call-evil', input: { agent: 'critic' }, status: 'success', result: evil })
  assert.throws(() => readFileSync(storeFile(storeDir, 'ses_evil'), 'utf8'), '采集未知错误不落记录')

  // review_rounds 台账写失败被兜住：判决照常落 store（台账仅记账，不承担门禁语义）
  const badLedger = {
    forChildSession: () => null,
    get: () => null,
    create: () => {},
    update: () => {
      throw new Error('ledger write exploded')
    },
  }
  const g3 = gate.createPlanGate({ options: { enabled: true, storeDir, planPath }, ledger: badLedger, logger: { debug: () => {} }, directory: home })
  await g3.before({ tool: 'subagent', sessionID: 'ses_led', id: 'call-led', input: { agent: 'critic' } })
  await g3.after({
    tool: 'subagent',
    sessionID: 'ses_led',
    id: 'call-led',
    input: { agent: 'critic' },
    status: 'success',
    result: { output: `${proseVerdict('pass')}\n\n${fenceJsonBlock('pass')}` },
  })
  const ledStore = readStoreRaw(storeDir, 'ses_led')
  assert.equal(ledStore.verdicts.length, 1, '台账写失败不掩盖判决落地')

  ok('工具面/入口负分支：extractResultText 全形态 / register·override·check 负臂 / fail-closed / 采集与台账异常兜底')
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n结果：${passed} 通过 / 0 失败`)

