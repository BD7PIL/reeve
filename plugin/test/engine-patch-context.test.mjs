// P3 补段通路测试（蓝图 .zcode/plans/next-round-plan-v4.md「P3」行 + P3.3；实现
// plugin/src/engine/script-patch.js 的 buildPatchContext / renderPatchReviewContext、
// script-runner.js 的 ask-failed 作用点证据（site/bodyOffset 盘上落账）、
// plugin/src/plan-gate.js registerSession 的 baseExecution 面）。
//
// 覆盖矩阵（P3 验收 + P3.3 写死三件）：
//   1. buildPatchContext 参数面（TypeError fail-fast）+ 返回形状写死：恰七键
//      {ok, runId, failedPoint, completedAsks, appliedAfterCallSeq, baseScriptPath,
//      baseFingerprint}——**不含 changedFrom**（归 applyPatch，蓝图原文）。
//   2. 失败归因规则写死：journal 末笔 = 带 callSeq 的 ask-failed → 可归因（failedPoint 三键，
//      site/bodyOffset 来自盘上 payload——P3 起脚本 ask-failed 落作用点证据）；其余形状
//      （成功尾 / ask-failed 后有事件 / patch 尾 / 无事件）→ failure-not-attributable
//      （推导不出就明说，不发明归类）。completedAsks = ask 事件末笔为准 + callSeq 升序 +
//      恰四键 {callSeq, site, promptHash, value}，残缺条目跳过。
//   3. journal 真相保守判定（applyPatch 同族）：base 文件缺失 / 无记录 / torn / runId 不符 /
//      storage.read 抛错全拒；baseFingerprint 从盘上现字节实算（编排方传 scriptPath）。
//   4. renderPatchReviewContext：确定性文本块（runId/base/failedPoint/appliedAfterCallSeq/
//      completedAsks 逐行）；ok:false 输入拒（TypeError）。
//   5. P3.3：registerSession payload 增 baseExecution——传入原样回带、未传 null、非对象拒；
//      工具面同轨（review_gate register 的 baseExecution 参数，评审 prompt 注入素材）。
//   6. mock 级端到端（P3 验收链，全夹具合成）：脚本 run failed（ask-failed 终局）→
//      buildPatchContext → 夹具固定补段文本 → applyPatch → renderPatchReviewContext →
//      register(kind workflow-script, baseExecution) → resumeScript → runScript+patchFrom
//      重跑成功（前缀 ask 零重跑 + 修好的 ask 真跑）。
//
// 运行：node plugin/test/engine-patch-context.test.mjs（assert 失败即抛、非零退出）
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDriver } from '../src/engine/driver.js'
import { createJournal } from '../src/engine/journal.js'
import { validateValue } from '../src/engine/declaration.js'
import { retryPrompt } from '../src/engine/ask.js'
import { resumeScript } from '../src/engine/resume-script.js'
import { applyPatch, buildPatchContext, renderPatchReviewContext } from '../src/engine/script-patch.js'
import { runScript } from '../src/engine/script-runner.js'
import { createPlanGate } from '../src/plan-gate.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- 夹具基座（engine-script-patch.test.mjs 同款形状，全合成）----
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const memStorage = (initial = null) => {
  let text = initial
  return { read: () => text, write: (t) => (text = t) }
}
const diskEvents = (storage) => JSON.parse(storage.read()).events
const fixedClock = (t = 1000) => () => t
const instantSleep = async () => {}
/** mock driver 场景速写：单条 done 应答（粘滞）。 */
const sc = (prompt, text) => ({ name: prompt, match: { prompt }, result: [{ status: 'done', text }] })
const createCount = (driver) => driver.calls.filter((c) => c.op === 'create').length
const tempHome = (label) => {
  const home = mkdtempSync(join(tmpdir(), `reeve-patch-context-${label}-`))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}
/** ask-failed 现场夹具：ask1 合法 / ask2 三修耗尽（schema 校验不过 → retryPrompt 同款三轮）。 */
const BAD = '{"a": "no"}'
const COUNT_SCHEMA = { type: 'object', required: ['a'], properties: { a: { type: 'integer' } } }
const ERRS = validateValue(JSON.parse(BAD), COUNT_SCHEMA, '产出').errors
const exhaustScenarios = (badPrompt) => [
  sc(badPrompt, BAD),
  sc(retryPrompt(badPrompt, ERRS, { attempt: 2, maxAttempts: 3 }), BAD),
  sc(retryPrompt(badPrompt, ERRS, { attempt: 3, maxAttempts: 3 }), BAD),
]

// ---- 1. buildPatchContext 参数面 + 返回形状写死 ----
console.log('1. buildPatchContext 参数面与返回形状')
{
  assert.throws(() => buildPatchContext({ storage: {}, runId: 'r', scriptPath: 'x' }), TypeError, 'storage 缺 read 拒')
  assert.throws(() => buildPatchContext({ storage: { read: () => null }, runId: '', scriptPath: 'x' }), TypeError, 'runId 空串拒')
  assert.throws(() => buildPatchContext({ storage: { read: () => null }, runId: 'r', scriptPath: '' }), TypeError, 'scriptPath 空串拒')
  assert.throws(() => buildPatchContext({ storage: { read: () => null }, runId: 'r', scriptPath: 'x' }, { readScript: 1 }), TypeError, 'readScript 非函数拒')

  // 返回形状写死：恰七键、无 changedFrom
  const { home, cleanup } = tempHome('shape')
  try {
    const BASE = `const a = await F.ask("给个数")\nreturn a`
    const basePath = join(home, 'wf.js')
    writeFileSync(basePath, BASE)
    const storage = memStorage()
    const journal = createJournal({ storage, runId: 'run-shape', now: fixedClock() })
    journal.recordEvent('ask', { callSeq: 3, cacheKey: 'k:3', stepId: 'script-ask-3', value: 'v', attempts: 1 })
    journal.recordEvent('ask-failed', { callSeq: 5, cacheKey: 'k:5', stepId: 'script-ask-5', reason: 'invalid-output', attempts: 3 })
    const ctx = buildPatchContext({ storage, runId: 'run-shape', scriptPath: basePath })
    assert.deepEqual(
      Object.keys(ctx),
      ['ok', 'runId', 'failedPoint', 'completedAsks', 'appliedAfterCallSeq', 'baseScriptPath', 'baseFingerprint'],
      '返回恰七键——不含 changedFrom（归 applyPatch，蓝图 P3 写死）',
    )
    assert.equal(ctx.ok, true)
    assert.equal(ctx.runId, 'run-shape')
    assert.deepEqual(ctx.failedPoint, { reason: 'ask-failed' }, 'legacy ask-failed payload 无作用点证据 → failedPoint 仅 reason（? 键省略）')
    assert.deepEqual(
      ctx.completedAsks,
      [{ callSeq: 3, site: null, promptHash: null, value: 'v' }],
      'completedAsks 恰四键（盘上无证据的键如实 null）',
    )
    assert.equal(ctx.appliedAfterCallSeq, 5, 'appliedAfterCallSeq = 盘上最大 callSeq（applyPatch 同口径）')
    assert.equal(ctx.baseScriptPath, basePath, 'baseScriptPath = 编排方传入路径')
    assert.equal(ctx.baseFingerprint, sha(BASE), 'baseFingerprint = base 文件现字节实算')
    ok('参数面 4 路 TypeError + 返回恰七键（不含 changedFrom）+ legacy 证据缺省如实 null')
  } finally {
    cleanup()
  }
}

// ---- 2. 失败归因规则写死 + completedAsks 采集口径 ----
console.log('2. 失败归因（末笔 ask-failed）与 completedAsks 采集')
{
  const { home, cleanup } = tempHome('attrib')
  try {
    const basePath = join(home, 'wf.js')
    writeFileSync(basePath, 'const x = 1\n')

    // 可归因现场：末笔 = 带作用点证据的 ask-failed（P3 起 script-runner 落 site/bodyOffset）
    const storage = memStorage()
    const journal = createJournal({ storage, runId: 'run-ok', now: fixedClock() })
    journal.recordEvent('ask', { callSeq: 1, cacheKey: 'k:1', stepId: 'script-ask-1', value: 'V1', attempts: 2, site: { line: 2, col: 7 }, promptHash: sha('p1'), prefixHash: sha('prefix'), optsHash: sha('o') })
    journal.recordEvent('ask', { callSeq: 2, cacheKey: 'k:2', stepId: 'script-ask-2', value: 'V2-late', attempts: 1, site: { line: 3, col: 9 }, promptHash: sha('p2'), prefixHash: sha('prefix2'), optsHash: sha('o') })
    journal.recordEvent('ask', { callSeq: 2, cacheKey: 'k:2b', stepId: 'script-ask-2b', value: 'V2-latest', attempts: 1, site: { line: 4, col: 11 }, promptHash: sha('p2b'), prefixHash: sha('prefix3'), optsHash: sha('o') })
    journal.recordEvent('ask-failed', { callSeq: 3, cacheKey: 'k:3', stepId: 'script-ask-3', reason: 'invalid-output', attempts: 3, site: { line: 5, col: 13 }, bodyOffset: 88 })
    const ctx = buildPatchContext({ storage, runId: 'run-ok', scriptPath: basePath })
    assert.deepEqual(ctx.failedPoint, { reason: 'ask-failed', site: { line: 5, col: 13 }, bodyOffset: 88 }, 'failedPoint 三键：盘上作用点证据原样回带')
    assert.deepEqual(
      ctx.completedAsks,
      [{ callSeq: 1, site: { line: 2, col: 7 }, promptHash: sha('p1'), value: 'V1' }, { callSeq: 2, site: { line: 4, col: 11 }, promptHash: sha('p2b'), value: 'V2-latest' }],
      '同 callSeq 末笔为准 + callSeq 升序 + 恰四键',
    )
    assert.equal(ctx.appliedAfterCallSeq, 3, 'ask-failed 的 callSeq 也进锚点（失败点 = 补段须越过的执行序）')

    // 残缺 ask 条目（无 value）跳过——宁缺不假
    const storageHole = memStorage()
    const journalHole = createJournal({ storage: storageHole, runId: 'run-hole', now: fixedClock() })
    journalHole.recordEvent('ask', { callSeq: 1, attempts: 1 }) // 缺 value
    journalHole.recordEvent('ask-failed', { callSeq: 2, reason: 'x', attempts: 1 })
    const ctxHole = buildPatchContext({ storage: storageHole, runId: 'run-hole', scriptPath: basePath })
    assert.deepEqual(ctxHole.completedAsks, [], '残缺 ask（缺 value）跳过')

    // 归因拒绝面：末笔不是带 callSeq 的 ask-failed → failure-not-attributable（不发明归类）
    const cases = [
      ['成功尾（无失败）', (j) => j.recordEvent('ask', { callSeq: 1, value: 'v', attempts: 1 })],
      ['ask-failed 后有事件（被 catch 吞掉续跑）', (j) => {
        j.recordEvent('ask-failed', { callSeq: 2, reason: 'x', attempts: 1 })
        j.recordEvent('log', { message: 'after' })
      }],
      ['patch 尾（补段链的下一迭代锚点）', (j) => j.recordEvent('patch', { patchSeq: 1, appliedAfterCallSeq: 2 })],
      ['ask-failed payload 残缺（无 callSeq）', (j) => j.recordEvent('ask-failed', { reason: 'x' })],
    ]
    for (const [label, seed] of cases) {
      const s = memStorage()
      const j = createJournal({ storage: s, runId: 'run-x', now: fixedClock() })
      seed(j)
      const refused = buildPatchContext({ storage: s, runId: 'run-x', scriptPath: basePath })
      assert.deepEqual([refused.ok, refused.reason], [false, 'failure-not-attributable'], `归因拒绝：${label}`)
      assert.ok(refused.error.includes('不发明归类'), '拒绝理由点名不发明归类 + 宿主 result.reason 权威面')
    }
    ok('归因写死：末笔 ask-failed 三键回带 + 四路 failure-not-attributable + 残缺跳过 + 末笔为准')
  } finally {
    cleanup()
  }
}

// ---- 3. journal 真相保守判定 + base 文件面 ----
console.log('3. 保守判定与 base 文件面')
{
  const { home, cleanup } = tempHome('conserv')
  try {
    const basePath = join(home, 'wf.js')
    writeFileSync(basePath, 'const x = 1\n')
    const noRecord = buildPatchContext({ storage: memStorage(), runId: 'r', scriptPath: basePath })
    assert.deepEqual([noRecord.ok, noRecord.reason], [false, 'shape-invalid'], '盘上无记录（run 从未落账）→ 拒')
    const torn = buildPatchContext({ storage: memStorage('{broken'), runId: 'r', scriptPath: basePath })
    assert.deepEqual([torn.ok, torn.reason], [false, 'unparseable'], 'journal 撕裂拒')
    const mismatch = buildPatchContext({ storage: memStorage(JSON.stringify({ runId: 'other', updatedAt: 1, steps: {}, engineSessions: [], events: [] })), runId: 'r', scriptPath: basePath })
    assert.deepEqual([mismatch.ok, mismatch.reason], [false, 'run-mismatch'], 'runId 不符拒')
    const readErr = buildPatchContext({ storage: { read: () => { throw new Error('disk yanked') } }, runId: 'r', scriptPath: basePath })
    assert.deepEqual([readErr.ok, readErr.reason], [false, 'read-error'], 'storage.read 抛错拒')
    const noFile = buildPatchContext({ storage: memStorage(JSON.stringify({ runId: 'r', updatedAt: 1, steps: {}, engineSessions: [], events: [{ type: 'ask-failed', at: 1, payload: { callSeq: 1 } }] })), runId: 'r', scriptPath: join(home, 'missing.js') })
    assert.deepEqual([noFile.ok, noFile.reason], [false, 'base-unreadable'], 'base 文件缺失拒（baseFingerprint 实算前提）')
    ok('保守判定四形 + base 文件缺失（applyPatch/resumeScript 同族口径）')
  } finally {
    cleanup()
  }
}

// ---- 4. renderPatchReviewContext 确定性渲染 ----
console.log('4. renderPatchReviewContext（评审 prompt 注入段）')
{
  assert.throws(() => renderPatchReviewContext({ ok: false, reason: 'x' }), TypeError, 'ok:false 输入拒')
  assert.throws(() => renderPatchReviewContext(null), TypeError, '非对象拒')
  assert.throws(() => renderPatchReviewContext({ ok: true, failedPoint: {}, completedAsks: [] }), TypeError, 'failedPoint.reason 缺失拒')
  const ctx = {
    ok: true,
    runId: 'run-r',
    failedPoint: { reason: 'ask-failed', site: { line: 3, col: 21 }, bodyOffset: 57 },
    completedAsks: [{ callSeq: 1, site: { line: 2, col: 21 }, promptHash: 'a'.repeat(64), value: { sum: 42 } }],
    appliedAfterCallSeq: 2,
    baseScriptPath: join('d', 'wf.ts'),
    baseFingerprint: 'b'.repeat(64),
  }
  const text = renderPatchReviewContext(ctx)
  const lines = text.split('\n')
  assert.equal(lines[0], '[base-execution] run=run-r（base 段已执行现场——补段评审上下文）', '首行点名 runId')
  assert.equal(lines[1], `base=${join('d', 'wf.ts')} sha256=${'b'.repeat(64)}`, 'base 路径 + 全字节指纹')
  assert.equal(lines[2], 'failedPoint=reason:ask-failed site:3:21 bodyOffset:57', '失败点三键同行')
  assert.equal(lines[3], 'appliedAfterCallSeq=2（补段须锚定在此执行序之后）', '执行序锚点')
  assert.equal(lines[4], 'completedAsks=1', 'completedAsks 计数行')
  assert.match(lines[5], /callSeq=1 promptHash=aaaaaaaa value=\{"sum":42\}/, 'ask 行：callSeq + promptHash 前 8 位 + value 紧凑 JSON')
  // 省略面：site/bodyOffset 缺省 → 键省略；超长 value 截断
  const minimal = renderPatchReviewContext({ ...ctx, failedPoint: { reason: 'ask-failed' }, completedAsks: [{ callSeq: 1, site: null, promptHash: null, value: 'x'.repeat(200) }] })
  assert.ok(minimal.includes('failedPoint=reason:ask-failed\n'), '无 site/bodyOffset → 省略不占位')
  assert.ok(minimal.includes(`value="${'x'.repeat(159)}…`), '超长 value 截 160 字符（含 JSON 引号）+ 省略号')
  assert.ok(minimal.includes('promptHash=null'), '无 promptHash → null 如实占位')
  ok('确定性文本块逐行 + 参数面 3 路 + 省略/截断面')
}

// ---- 5. P3.3：registerSession payload.baseExecution（评审 prompt 注入素材）----
console.log('5. P3.3 registerSession baseExecution')
{
  const { home, cleanup } = tempHome('baseexec')
  try {
    const storeDir = join(home, 'store')
    writeFileSync(join(home, 'plan.md'), 'seed\n')
    const scriptPath = join(home, 'wf.js')
    writeFileSync(scriptPath, 'const a = await F.ask("q")\nreturn a\n')
    const gate = createPlanGate({ options: { enabled: true, storeDir, planPath: join(home, 'plan.md') }, ledger: null, logger: { debug: () => {} }, directory: home })
    const call = async (args, sessionID) => JSON.parse((await gate.tool.execute(args, { sessionID })).output)
    const S = 'session-baseexec'

    const ctx = { ok: true, runId: 'run-be', failedPoint: { reason: 'ask-failed', bodyOffset: 12 }, completedAsks: [], appliedAfterCallSeq: 1, baseScriptPath: scriptPath, baseFingerprint: sha('x') }

    // 工具面：baseExecution 原样回带进 payload（评审派发 prompt 注入素材）
    const reg = await call({ op: 'register', planPath: scriptPath, kind: 'workflow-script', baseExecution: ctx }, S)
    assert.equal(reg.ok, true)
    assert.deepEqual(reg.baseExecution, ctx, 'payload.baseExecution 原样回带（工具面）')
    assert.equal(Object.hasOwn(reg, 'baseExecution'), true, 'payload 恒带 baseExecution 键（P3.3 写死）')

    // 未传 → null（payload 形状稳定）；registerSession 直调同轨
    const regNoCtx = await call({ op: 'register', planPath: scriptPath, kind: 'workflow-script' }, S)
    assert.equal(regNoCtx.baseExecution, null, '未传 → null')

    // 非对象拒（registerSession 直调；工具面 schema additionalProperties 挡不住类型错，运行面兜）
    const bad = await gate.registerSession(S, scriptPath, 'plan', 'not-an-object')
    assert.deepEqual([bad.ok, bad.reason ?? bad.error.includes('baseExecution')], [false, true], 'baseExecution 非对象 → ok:false 点名 baseExecution')
    const badArray = await gate.registerSession(S, scriptPath, 'plan', [])
    assert.equal(badArray.ok, false, '数组也拒（plain object 域）')
    ok('P3.3：baseExecution 回带/未传 null/非对象拒（工具面 + registerSession 直调）')
  } finally {
    cleanup()
  }
}

// ---- 6. mock 级端到端（P3 验收链：failed → context → patch → register → resume → 成功）----
console.log('6. mock 端到端：failed → buildPatchContext → applyPatch → register → resume 重跑成功')
{
  const PF = '端到端甲: 给个数'
  const PBAD = '端到端乙: 会耗尽的问句'
  const PFIX = '端到端乙: 修好后的问句'
  const GOOD = '{"a": 7}'
  const BASE = [
    `const a = await F.ask(${JSON.stringify(PF)}, { schema: ${JSON.stringify(COUNT_SCHEMA)} })`,
    `const b = await F.ask(${JSON.stringify(PBAD)}, { schema: ${JSON.stringify(COUNT_SCHEMA)} })`,
    'return { a, b }',
  ].join('\n')
  // 夹具固定补段文本：换掉耗尽的 ask2（原位注入——changedFrom 落在 prompt 字面量首字节）
  const PATCHED = BASE.replace(PBAD, PFIX)
  const RUN = 'run-patch-e2e'

  const { home, cleanup } = tempHome('e2e')
  try {
    const basePath = join(home, 'wf-e2e.js')
    writeFileSync(basePath, BASE)
    const storage = memStorage()
    const journalA = createJournal({ storage, runId: RUN, now: fixedClock() })
    const driverA = createDriver('mock', { scenarios: [sc(PF, GOOD), ...exhaustScenarios(PBAD)] })
    const resA = await runScript({ script: BASE, runId: RUN, journal: journalA, driver: driverA }, { now: fixedClock(), sleep: instantSleep })
    assert.deepEqual([resA.status, resA.reason], ['failed', 'ask-failed'], '首跑：ask2 三修耗尽 → failed')

    // P3 起 ask-failed 落作用点证据（buildPatchContext failedPoint 的盘上数据源）
    const tail = diskEvents(storage)[diskEvents(storage).length - 1]
    assert.equal(tail.type, 'ask-failed', '盘上末笔 = ask-failed（可归因形状）')
    assert.ok(tail.payload.site && tail.payload.site.line === 2, 'ask-failed payload 带 site（作用点证据落账）')
    assert.equal(typeof tail.payload.bodyOffset, 'number', 'ask-failed payload 带 bodyOffset')

    // buildPatchContext：失败点 + 已完成 ask + 执行序锚点
    const ctx = buildPatchContext({ storage, runId: RUN, scriptPath: basePath })
    assert.equal(ctx.ok, true, 'context ok')
    assert.deepEqual([ctx.failedPoint.reason, ctx.failedPoint.site.line], ['ask-failed', 2], 'failedPoint 来自盘上 ask-failed 证据')
    assert.equal(ctx.completedAsks.length, 1, 'completedAsks 只有 ask1（失败的 ask2 不在）')
    assert.equal(ctx.appliedAfterCallSeq, 2, '锚点 = 2（失败 ask 的 callSeq 也算）')
    assert.equal(ctx.baseFingerprint, sha(BASE), 'base 指纹实算')

    // applyPatch：固定补段文本（原位注入）
    const patch = await applyPatch({ scriptPath: basePath, patchedScript: PATCHED, runId: RUN, storage, journal: journalA, patch: { anchor: 'hole-site', holeRef: { kind: 'hole', seq: 1 }, reason: 'ask2 耗尽，换修好后的问句', source: 'model' } })
    assert.equal(patch.ok, true, 'applyPatch ok')
    assert.equal(patch.changedFrom, BASE.indexOf('会耗尽的问句'), '原位注入 → changedFrom = 首个差异字节（被换段起点）')

    // 评审 prompt 注入段（P3.3 消费形态）
    const promptText = renderPatchReviewContext(ctx)
    assert.ok(promptText.includes(`run=${RUN}`), '注入段带 runId')
    assert.ok(promptText.includes(`base=${basePath}`) && promptText.includes(ctx.baseFingerprint), '注入段带 base 全字节指纹')
    assert.ok(promptText.includes('failedPoint=reason:ask-failed'), '注入段带失败点')
    assert.ok(promptText.includes(`callSeq=1 promptHash=${ctx.completedAsks[0].promptHash.slice(0, 8)}`), '注入段带已完成 ask 摘要')

    // 库面 register（baseExecution 注入）+ 读端缓存
    const storeDir = join(home, 'store')
    const gate = createPlanGate({ options: { enabled: true, storeDir, planPath: join(home, 'plan.md') }, ledger: null, logger: { debug: () => {} }, directory: home })
    const reg = await gate.registerSession('session-e2e', patch.patchedPath, 'workflow-script', ctx)
    assert.equal(reg.ok, true, '补段文件 register 接受')
    assert.deepEqual(reg.baseExecution, ctx, 'register payload 回带 baseExecution（评审可见）')
    const resume = resumeScript(PATCHED, storage, RUN)
    assert.deepEqual([resume.ok, resume.matchedCount], [true, 1], 'ask1 进缓存（前缀零变更）')

    // runScript + patchFrom 重跑成功：ask1 零重跑，修好的 ask2 真跑
    const journalB = createJournal({ storage, runId: RUN, now: fixedClock() })
    const driverB = createDriver('mock', { scenarios: [sc(PF, GOOD), sc(PFIX, GOOD)] })
    const resB = await runScript(
      { script: PATCHED, runId: RUN, journal: journalB, driver: driverB },
      { now: fixedClock(), sleep: instantSleep, askCache: resume.cached, patchFrom: patch.changedFrom },
    )
    assert.deepEqual([resB.status, resB.value.b.a], ['completed', 7], '重跑成功（修好的 ask2 真跑出值）')
    assert.equal(createCount(driverB), 1, 'ask1 缓存命中零 driver 调用（仅 ask2 真跑）')
    assert.equal(resB.asks[0].cached, true, 'ask1 cached:true（值恒等首跑）')
    assert.equal(resB.asks[0].value.a, 7, '导入值恒等首跑')
    ok('P3 验收链全通：failed → context → 固定补段 → applyPatch → register(baseExecution) → resume → runScript+patchFrom 成功')
  } finally {
    cleanup()
  }
}

console.log(`\n全部 ${passed} 项通过`)
if (passed === 0) process.exit(1)
