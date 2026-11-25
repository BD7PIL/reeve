// C2 hole patch 测试（优化方案 v3.1「C2」行 + spike .zcode/plans/evidence/c2-hole-patch-spike.md
// 六题写死方案；实现 plugin/src/engine/script-patch.js + script-runner.js 的 patch 面）。
//
// 覆盖矩阵（施工范围五条验收逐一钉面）：
//   1. applyPatch 记 patch 事件：payload 七字段形状（patchSeq/baseFingerprint/patchedFingerprint/
//                  anchor/holeRef/appliedAfterCallSeq/reason/source）、base 文件字节不动、补段
//                  文件落盘（<stem>.patch-<seq><ext>）、patchSeq 递增成链、appliedAfterCallSeq
//                  = 盘上最大 callSeq（ask/ask-failed 都算）、语法预门拒、写败/readScript 注入
//                  故障缝、journal 真相保守判定（无记录/torn/runId 不符全拒）、参数面 TypeError。
//   2. patch 事件不污染 ask 缓存：有 patch 事件的 journal 走 resumeScript，缓存 Map 与无 patch
//                  时逐位相等；带缓存重跑命中行为一致（零 driver 调用、cached:true）。
//   3. 尾部补段（anchor:'tail'）重跑：变更点前 ask 按 C1 规则导入零重跑，补段内容真执行。
//   4. 补段内 throw → run failed reason='patch-failed'，补段内已完成 ask/run 事件全数保留，
//                  打捞报告含补段边界（base→patched 指纹 + anchor）；负向：无 patchFrom 不发明
//                  归类（script-threw 维持）、失败点在变更点前维持原 reason（ask-failed）。
//   5. gate 通路：applyPatch 产物文件走 review_gate register/check 与既有 workflow-script 完全
//                  一致——同一决策矩阵（运行时取 fixture，行文不复制）、全字节哈希、补段新增
//                  命令字面量进 commands 供评审、偷改字节走 #5（TOCTOU fail-closed）、语法坏
//                  补段拒绝零记录。
//
// 夹具全合成（内存 storage + mock driver + 假 child 进程 + 注入时钟/即时 sleep + 临时目录真 fs），
// 不读真机、不引用录制件；故障经构造参数注入（readScript/writeScript 注入 + memStorage 保守
// 真相），禁 monkey-patch（§6；S6 fault 注入夹具同哲学）。
//
// 运行：node plugin/test/engine-script-patch.test.mjs（assert 失败即抛、非零退出；成功自然退出）
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { retryPrompt } from '../src/engine/ask.js'
import { validateValue } from '../src/engine/declaration.js'
import { createDriver } from '../src/engine/driver.js'
import { createJournal } from '../src/engine/journal.js'
import { resumeScript } from '../src/engine/resume-script.js'
import { renderSalvageReport, salvageReportPath, writeSalvageReport } from '../src/engine/salvage-report.js'
import {
  PATCH_ANCHORS,
  PATCH_EVENT_TYPE,
  PATCH_REFUSED_REASONS,
  applyPatch,
  firstChangedOffset,
  patchedScriptPath,
} from '../src/engine/script-patch.js'
import { SCRIPT_EVENT_TYPES, SCRIPT_FAILURE_REASONS, runScript } from '../src/engine/script-runner.js'
import { canonicalPlanHash, createPlanGate, storeStem } from '../src/plan-gate.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- 夹具基座（全合成；engine-script.test.mjs 同款形状）----
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
/** 内存 storage：read 初值 null（「无记录」），write 捕获最新文本；file 字段给报告路径推导。 */
const memStorage = (initial = null, file = null) => {
  let text = initial
  return { read: () => text, write: (t) => (text = t), ...(file !== null ? { file } : {}) }
}
/** 盘上事件（journal 的 record.events；storage.read() 是盘上真相）。 */
const diskEvents = (storage) => JSON.parse(storage.read()).events
const fixedClock = (t = 1000) => () => t
const instantSleep = async () => {}
/** mock driver 场景速写：单条 done 应答（粘滞）。 */
const sc = (prompt, text, extra = {}) => ({ name: prompt, match: { prompt }, result: [{ status: 'done', text }], ...extra })
/** 假 child 进程 + 假 spawn 工厂（F.run 注入面；engine-script.test.mjs 同款）。 */
const fakeSpawnFactory = (spec) => {
  const buf = new Map()
  const ls = (name) => {
    if (!buf.has(name)) buf.set(name, [])
    return buf.get(name)
  }
  const streamOf = (name) => ({ on: (_e, fn) => ls(name).push(fn), fire: (chunk) => ls(name).forEach((fn) => { fn(chunk) }) })
  const spawned = []
  const spawnFn = (cmd, args) => {
    const child = {
      stdout: streamOf('stdout'),
      stderr: streamOf('stderr'),
      on(ev, fn) {
        ls(`ev:${ev}`).push(fn)
      },
      emit(ev, ...args2) {
        for (const fn of ls(`ev:${ev}`)) fn(...args2)
      },
      kill() {},
    }
    spawned.push({ cmd, args, child })
    queueMicrotask(() => {
      if (spec.stdout.length > 0) child.stdout.fire(Buffer.from(spec.stdout))
      if (spec.stderr.length > 0) child.stderr.fire(Buffer.from(spec.stderr))
      child.emit('close', spec.exitCode ?? 0)
    })
    return child
  }
  return { spawnFn, spawned }
}
const createCount = (driver) => driver.calls.filter((c) => c.op === 'create').length
const createArgs = (driver) => driver.calls.filter((c) => c.op === 'create').map((c) => c.args)
/** 临时目录（applyPatch 的 base/补段真文件）。 */
const tempHome = (label) => {
  const home = mkdtempSync(join(tmpdir(), `reeve-script-patch-${label}-`))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

// ---- 0. 域枚举 + 纯函数面 + 参数面（TypeError = 程序错误，fail-fast）----
console.log('0. 域枚举与参数面')
{
  assert.ok(SCRIPT_EVENT_TYPES.includes(PATCH_EVENT_TYPE), "SCRIPT_EVENT_TYPES 收 'patch'（run 级事件，非 facade 成员）")
  assert.ok(SCRIPT_FAILURE_REASONS.includes('patch-failed'), "SCRIPT_FAILURE_REASONS 收 'patch-failed'")
  assert.deepEqual([...PATCH_ANCHORS], ['hole-site', 'tail'], 'anchor 取值域（spike 写死两值）')
  assert.deepEqual(
    [...PATCH_REFUSED_REASONS],
    ['base-unreadable', 'read-error', 'unparseable', 'shape-invalid', 'run-mismatch', 'patch-syntax-invalid', 'patch-write-failed', 'journal-not-ok'],
    '补段拒绝 reason 取值域',
  )

  // firstChangedOffset：中段变更 / 纯追加 / 原样 / 删除——runScript opts.patchFrom 的边界来源
  assert.equal(firstChangedOffset('abc', 'abc'), 3, '完全相等 → 两串长度（变更区为空）')
  assert.equal(firstChangedOffset('abc', 'abcx'), 3, '纯追加 → base 长度（尾部补段的常态）')
  assert.equal(firstChangedOffset('abcx', 'abc'), 3, '删尾 → patched 长度（变更区在 patched 坐标系末端之外）')
  assert.equal(firstChangedOffset('abc', 'axc'), 1, '中段变更 → 首个差异字节')
  assert.equal(firstChangedOffset('', 'x'), 0, '空 base → 0')

  // patchedScriptPath：<stem>.patch-<seq><ext>（点开头文件名视为无扩展名）
  assert.equal(patchedScriptPath(join('d', 'workflow.js'), 1), join('d', 'workflow.patch-1.js'), '带扩展名')
  assert.equal(patchedScriptPath(join('d', 'workflow'), 2), join('d', 'workflow.patch-2'), '无扩展名')
  assert.equal(patchedScriptPath(join('d', '.hidden'), 3), join('d', '.hidden.patch-3'), '点开头 → 无扩展名处理')

  // 参数面（TypeError）
  const goodInput = (over = {}) => ({
    scriptPath: join('d', 'w.js'),
    patchedScript: 'return 1',
    runId: 'r',
    storage: { read: () => null },
    journal: { recordEvent: () => ({ ok: true }) },
    patch: { anchor: 'tail', reason: 'r', source: 's' },
    ...over,
  })
  await assert.rejects(applyPatch(goodInput({ scriptPath: '' })), TypeError, 'scriptPath 空串拒')
  await assert.rejects(applyPatch(goodInput({ scriptPath: 42 })), TypeError, 'scriptPath 非字符串拒')
  await assert.rejects(applyPatch(goodInput({ patchedScript: '' })), TypeError, 'patchedScript 空串拒')
  await assert.rejects(applyPatch(goodInput({ runId: '' })), TypeError, 'runId 空串拒')
  await assert.rejects(applyPatch(goodInput({ storage: {} })), TypeError, 'storage 缺 read 拒')
  await assert.rejects(applyPatch(goodInput({ journal: {} })), TypeError, 'journal 缺 recordEvent 拒')
  await assert.rejects(applyPatch(goodInput({ patch: null }), {}), TypeError, 'patch 非对象拒')
  await assert.rejects(applyPatch(goodInput({ patch: { anchor: 'mid', reason: 'r', source: 's' } })), TypeError, 'anchor 别值拒')
  await assert.rejects(applyPatch(goodInput({ patch: { anchor: 'tail', reason: '', source: 's' } })), TypeError, 'reason 空串拒')
  await assert.rejects(applyPatch(goodInput({ patch: { anchor: 'tail', reason: 'r', source: '' } })), TypeError, 'source 空串拒')
  await assert.rejects(
    applyPatch(goodInput({ patch: { anchor: 'hole-site', reason: 'r', source: 's' } })),
    TypeError,
    "anchor='hole-site' 缺 holeRef 拒",
  )
  await assert.rejects(
    applyPatch(goodInput({ patch: { anchor: 'hole-site', holeRef: { kind: 'step', seq: 1 }, reason: 'r', source: 's' } })),
    TypeError,
    'holeRef.kind 别值拒',
  )
  await assert.rejects(
    applyPatch(goodInput({ patch: { anchor: 'hole-site', holeRef: { kind: 'hole', seq: 0 }, reason: 'r', source: 's' } })),
    TypeError,
    'holeRef.seq < 1 拒',
  )
  await assert.rejects(
    applyPatch(goodInput({ patch: { anchor: 'tail', holeRef: { kind: 'hole', seq: 1 }, reason: 'r', source: 's' } })),
    TypeError,
    "anchor='tail' 带 holeRef 拒（严格未知面）",
  )
  await assert.rejects(applyPatch(goodInput(), { writeScript: 1 }), TypeError, 'writeScript 非函数拒')
  await assert.rejects(applyPatch(goodInput(), { readScript: 1 }), TypeError, 'readScript 非函数拒')
  ok('域枚举 + firstChangedOffset/patchedScriptPath 纯函数面 + 参数面 15 路 TypeError')
}

// ---- 1. applyPatch 记 patch 事件（验收①：payload 形状 + base 不动 + 补段文件落盘）----
console.log('1. applyPatch 记 patch 事件')
{
  const { home, cleanup } = tempHome('event')
  try {
    const basePath = join(home, 'workflow.js')
    const BASE = `const a = await F.ask("给个数")\nF.log('step1')\nreturn a`
    writeFileSync(basePath, BASE)
    const baseBytesBefore = readFileSync(basePath)
    const PATCHED = `${BASE}\nF.log('patched')\nreturn { a, patched: 1 }`
    const storage = memStorage()
    const journal = createJournal({ storage, runId: 'run-patch-1', now: fixedClock(100) })
    // 种盘上执行序锚点：ask callSeq=3 + ask-failed callSeq=5 → appliedAfterCallSeq 应取最大 5
    journal.recordEvent('ask', { callSeq: 3, cacheKey: 'k:3', stepId: 'script-ask-3', value: 'v', attempts: 1 })
    journal.recordEvent('ask-failed', { callSeq: 5, cacheKey: 'k:5', stepId: 'script-ask-5', reason: 'invalid-output', attempts: 3 })

    const out = await applyPatch(
      {
        scriptPath: basePath,
        patchedScript: PATCHED,
        runId: 'run-patch-1',
        storage,
        journal,
        patch: { anchor: 'hole-site', holeRef: { kind: 'hole', seq: 1 }, reason: 'hole 处缺出口', source: 'model' },
      },
      { now: fixedClock(200) },
    )

    assert.equal(out.ok, true, 'applyPatch ok')
    assert.equal(out.patchSeq, 1, '首笔 patchSeq=1（盘上无 patch 事件 → max+1）')
    assert.equal(out.baseFingerprint, sha(BASE), 'baseFingerprint = base 文件字节 sha256')
    assert.equal(out.patchedFingerprint, sha(PATCHED), 'patchedFingerprint = 补段全文 sha256')
    assert.equal(out.changedFrom, BASE.length, '尾部追加 → changedFrom = base 长度')
    assert.equal(out.patchedPath, join(home, 'workflow.patch-1.js'), '补段文件 = <stem>.patch-<seq><ext> 同目录')
    assert.equal(out.appliedAfterCallSeq, 5, 'appliedAfterCallSeq = 盘上最大 callSeq（ask/ask-failed 都算）')
    assert.deepEqual(
      out.payload,
      {
        patchSeq: 1,
        baseFingerprint: sha(BASE),
        patchedFingerprint: sha(PATCHED),
        anchor: 'hole-site',
        holeRef: { kind: 'hole', seq: 1 },
        appliedAfterCallSeq: 5,
        reason: 'hole 处缺出口',
        source: 'model',
      },
      'payload 字段形状写死（七字段 + holeRef）',
    )
    assert.equal(out.at, 100, 'at 走 journal 注入时钟')

    // base 文件字节不动；补段文件落盘且字节 = patchedScript
    assert.ok(readFileSync(basePath).equals(baseBytesBefore), 'base 文件字节分毫未动')
    assert.ok(existsSync(out.patchedPath), '补段文件落盘')
    assert.equal(readFileSync(out.patchedPath, 'utf8'), PATCHED, '补段文件字节 = patchedScript 原文')

    // 盘上 journal：patch 事件 payload 原样落账
    const events = diskEvents(storage)
    const patchEvent = events.find((e) => e.type === 'patch')
    assert.ok(patchEvent, "盘上有 type='patch' 事件")
    assert.deepEqual(patchEvent.payload, out.payload, '盘上 payload 与返回一致')

    // 第二笔：patchSeq 递增成链；anchor='tail' 无 holeRef 键
    const out2 = await applyPatch({
      scriptPath: basePath,
      patchedScript: `${PATCHED}\nF.log('patched-2')`,
      runId: 'run-patch-1',
      storage,
      journal,
      patch: { anchor: 'tail', reason: '再补一段', source: 'model' },
    })
    assert.equal(out2.ok, true)
    assert.equal(out2.patchSeq, 2, 'patchSeq 按 max+1 递增（多 patch 成链）')
    assert.equal(out2.appliedAfterCallSeq, 5, 'callSeq 锚点不被 patch 事件自己抬高（patch payload 无 callSeq）')
    assert.equal(Object.hasOwn(out2.payload, 'holeRef'), false, "anchor='tail' 的 payload 无 holeRef 键")
    assert.equal(readFileSync(join(home, 'workflow.patch-2.js'), 'utf8'), `${PATCHED}\nF.log('patched-2')`, '第二笔补段文件落盘')

    // 中段编辑的 changedFrom：首个差异字节（不是 base 长度）
    const midPatched = BASE.replace("F.log('step1')", "F.log('step1b')")
    const out3 = await applyPatch({
      scriptPath: basePath,
      patchedScript: midPatched,
      runId: 'run-patch-1',
      storage,
      journal,
      patch: { anchor: 'hole-site', holeRef: { kind: 'escalate', seq: 2 }, reason: 'r3', source: 's3' },
    })
    assert.equal(out3.ok, true)
    assert.equal(out3.changedFrom, firstChangedOffset(BASE, midPatched), '中段原位注入 → changedFrom = 首个差异字节偏移')
    assert.ok(
      out3.changedFrom > BASE.indexOf("F.log('step1')") && out3.changedFrom < BASE.indexOf('\nreturn'),
      `夹具自检：差异字节落在被替换的 F.log 字面量内（changedFrom=${out3.changedFrom}）`,
    )
    assert.deepEqual(out3.payload.holeRef, { kind: 'escalate', seq: 2 }, 'holeRef 双 kind 域（hole|escalate）')

    // ---- 语义拒绝面（ok:false；零事件零落盘）----
    // 语法坏补段：register 反正会拒——提前拦，零落盘零事件
    const eventsBefore = diskEvents(storage).length
    const badSyntax = await applyPatch({
      scriptPath: basePath,
      patchedScript: 'const const const',
      runId: 'run-patch-1',
      storage,
      journal,
      patch: { anchor: 'tail', reason: 'r', source: 's' },
    })
    assert.deepEqual([badSyntax.ok, badSyntax.reason], [false, 'patch-syntax-invalid'], '语法预门拒（与 register/执行同一包装）')
    assert.equal(diskEvents(storage).length, eventsBefore, '语法拒零事件')

    // writeScript 注入故障缝：写败 → patch-write-failed，零事件（journal 分毫未动）
    const writeFail = await applyPatch(
      { scriptPath: basePath, patchedScript: PATCHED, runId: 'run-patch-1', storage, journal, patch: { anchor: 'tail', reason: 'r', source: 's' } },
      { writeScript: () => { throw new Error('ENOSPC: 注入写败') } },
    )
    assert.deepEqual([writeFail.ok, writeFail.reason], [false, 'patch-write-failed'], '写败如实报 not-ok')
    assert.ok(writeFail.error.includes('ENOSPC'), '错误原文带回')
    assert.equal(diskEvents(storage).length, eventsBefore, '写败零事件')

    // readScript 注入故障缝：base 读不到 → base-unreadable，零事件
    const readFail = await applyPatch(
      { scriptPath: basePath, patchedScript: PATCHED, runId: 'run-patch-1', storage, journal, patch: { anchor: 'tail', reason: 'r', source: 's' } },
      { readScript: () => { throw Object.assign(new Error('no such file'), { code: 'ENOENT' }) } },
    )
    assert.deepEqual([readFail.ok, readFail.reason], [false, 'base-unreadable'], 'base 读不到拒')
    assert.equal(diskEvents(storage).length, eventsBefore, '读败零事件')

    // journal 真相保守判定（resume-script.js 同款四形 + 无记录）：锚点建立不起来就不补
    const noRecord = await applyPatch({ scriptPath: basePath, patchedScript: PATCHED, runId: 'r-none', storage: memStorage(), journal: createJournal({ storage: memStorage(), runId: 'r-none', now: fixedClock() }), patch: { anchor: 'tail', reason: 'r', source: 's' } })
    assert.deepEqual([noRecord.ok, noRecord.reason], [false, 'shape-invalid'], '盘上无 journal 记录（run 从未落账）→ 拒')
    const tornStorage = memStorage('{broken-json')
    const torn = await applyPatch({ scriptPath: basePath, patchedScript: PATCHED, runId: 'r-torn', storage: tornStorage, journal: createJournal({ storage: tornStorage, runId: 'r-torn', now: fixedClock() }), patch: { anchor: 'tail', reason: 'r', source: 's' } })
    assert.deepEqual([torn.ok, torn.reason], [false, 'unparseable'], 'journal 撕裂拒')
    const mismatchStorage = memStorage()
    const mismatchJournal = createJournal({ storage: mismatchStorage, runId: 'other-run', now: fixedClock() })
    mismatchJournal.recordEvent('log', { message: 'x' })
    const mismatch = await applyPatch({ scriptPath: basePath, patchedScript: PATCHED, runId: 'r-mm', storage: mismatchStorage, journal: mismatchJournal, patch: { anchor: 'tail', reason: 'r', source: 's' } })
    assert.deepEqual([mismatch.ok, mismatch.reason], [false, 'run-mismatch'], 'runId 不符拒')
    const readErrStorage = { read: () => { throw new Error('disk yanked') } }
    const readErr = await applyPatch({ scriptPath: basePath, patchedScript: PATCHED, runId: 'r-re', storage: readErrStorage, journal: { recordEvent: () => ({ ok: true }) }, patch: { anchor: 'tail', reason: 'r', source: 's' } })
    assert.deepEqual([readErr.ok, readErr.reason], [false, 'read-error'], 'storage.read 抛错拒')

    // recordEvent 失败（torn/degraded）→ journal-not-ok（孤儿文件无事件，重试同序号覆盖无害）
    const denyJournal = { recordEvent: () => ({ ok: false, degraded: true, reason: 'degraded' }) }
    const notOk = await applyPatch(
      { scriptPath: basePath, patchedScript: PATCHED, runId: 'r', storage: memStorage('{"runId":"r","updatedAt":1,"steps":{},"engineSessions":[],"events":[]}'), journal: denyJournal, patch: { anchor: 'tail', reason: 'r', source: 's' } },
      { writeScript: () => {} }, // 写面注入假成功——本笔只验 recordEvent not-ok 的上抛
    )
    assert.deepEqual([notOk.ok, notOk.reason], [false, 'journal-not-ok'], 'recordEvent not-ok 如实上抛')
    ok('applyPatch：payload 形状 + base 零触碰 + 补段落盘 + patchSeq 成链 + changedFrom 双态 + 语义拒绝六形零事件')
  } finally {
    cleanup()
  }
}

// ---- 2. patch 事件不污染 ask 缓存（验收②：resumeScript 行为与无 patch 时逐位一致）----
console.log('2. patch 事件不污染 ask 缓存')
{
  const RUN = 'run-patch-cache'
  const P1 = '缓存甲: 给个数'
  const P2 = '缓存乙: 产出'
  const BASE = `const a = await F.ask(${JSON.stringify(P1)})\nconst b = await F.ask(${JSON.stringify(P2)})\nF.log('done')`
  const PATCHED = `${BASE}\nF.log('tail')` // 尾部追加（base 末行不是 return——追加的补段可执行）
  const { home, cleanup } = tempHome('cache')
  try {
    const basePath = join(home, 'wf.js')
    writeFileSync(basePath, BASE)
    const storage = memStorage()
    const driverA = createDriver('mock', { scenarios: [sc(P1, '1'), sc(P2, '2')] })
    const journalA = createJournal({ storage, runId: RUN, now: fixedClock() })
    const resA = await runScript({ script: BASE, runId: RUN, journal: journalA, driver: driverA }, { now: fixedClock(), sleep: instantSleep })
    assert.equal(resA.status, 'completed')
    assert.equal(createCount(driverA), 2, '首跑两 ask 都真跑（对照）')

    // 打补段前先取读端基线（同一份 patched 文本）
    const resumeBefore = resumeScript(PATCHED, storage, RUN)
    assert.equal(resumeBefore.ok, true)
    assert.equal(resumeBefore.cached.size, 2, '基线：两笔 ask 进缓存')
    const askEventCountBefore = resumeBefore.askEventCount

    // 打补段（journal 里多一笔 patch 事件）
    const patchOut = await applyPatch({ scriptPath: basePath, patchedScript: PATCHED, runId: RUN, storage, journal: journalA, patch: { anchor: 'tail', reason: '尾部补段', source: 'model' } })
    assert.equal(patchOut.ok, true)
    assert.equal(patchOut.appliedAfterCallSeq, 2, '补段锚点 = 首跑最大 callSeq 2')
    assert.equal(diskEvents(storage).filter((e) => e.type === 'patch').length, 1, '盘上恰一笔 patch 事件')

    // 打补段后再取读端：与基线逐位一致（patch 事件被 resumeScript fall-through 忽略）
    const resumeAfter = resumeScript(PATCHED, storage, RUN)
    assert.equal(resumeAfter.ok, true)
    assert.equal(resumeAfter.reason, null)
    assert.equal(resumeAfter.askEventCount, askEventCountBefore, 'askEventCount 不含 patch 事件（只数 ask）')
    assert.equal(resumeAfter.matchedCount, resumeBefore.matchedCount, '导入数一致')
    assert.deepEqual(resumeAfter.cached, resumeBefore.cached, '缓存 Map 逐位相等（patch 事件零污染 ask 缓存）')

    // 带缓存重跑：命中行为与无 patch 时一致（零 driver 调用、cached:true、值恒等首跑）
    const journalB = createJournal({ storage, runId: RUN, now: fixedClock() })
    const driverB = createDriver('mock', { scenarios: [sc(P1, '1'), sc(P2, '2')] }) // 场景在而不用——证零 create
    const broadcastB = []
    const resB = await runScript(
      { script: PATCHED, runId: RUN, journal: journalB, driver: driverB },
      { now: fixedClock(), sleep: instantSleep, askCache: resumeAfter.cached, onEvent: (e) => broadcastB.push(e.type) },
    )
    assert.equal(resB.status, 'completed')
    assert.equal(createCount(driverB), 0, '两 ask 全部命中：零 driver 调用')
    assert.equal(resB.asks.filter((a) => a.cached === true).length, 2, 'cached:true ×2')
    assert.equal(resB.asks[0].value, '1', '导入值恒等首跑')
    assert.deepEqual(resB.logs, ['done', 'tail'], '前缀 log 照常重执行 + 补段 log 真执行')
    assert.deepEqual(broadcastB, ['log', 'log', 'script-completed'], '命中零 journal 写零广播；两 log 照常落盘广播')
    ok('patch 事件不污染 ask 缓存：读端逐位一致 + 命中行为一致（零 driver 零写零广播）')
  } finally {
    cleanup()
  }
}

// ---- 3. 尾部补段（anchor:'tail'）重跑（验收③：变更点前 ask 按 C1 导入零重跑，补段真执行）----
console.log('3. 尾部补段重跑')
{
  const RUN = 'run-patch-tail'
  const P1 = '尾补甲: 给个数'
  const P2 = '尾补乙: 产出'
  const BASE = `const a = await F.ask(${JSON.stringify(P1)})\nconst b = await F.ask(${JSON.stringify(P2)})\nthrow new Error('tail-boom')`
  const PATCHED = `${BASE.slice(0, BASE.lastIndexOf("throw new Error('tail-boom')"))}F.log('patched-tail')\nreturn { a, b, fixed: true }`
  const { home, cleanup } = tempHome('tail')
  try {
    const basePath = join(home, 'wf.js')
    writeFileSync(basePath, BASE)
    const storage = memStorage()
    const journalA = createJournal({ storage, runId: RUN, now: fixedClock() })
    const driverA = createDriver('mock', { scenarios: [sc(P1, '1'), sc(P2, '2')] })
    const resA = await runScript({ script: BASE, runId: RUN, journal: journalA, driver: driverA }, { now: fixedClock(), sleep: instantSleep })
    assert.deepEqual([resA.status, resA.reason], ['failed', 'script-threw'], '首跑尾部 throw → failed（补段动机现场）')

    const patchOut = await applyPatch({ scriptPath: basePath, patchedScript: PATCHED, runId: RUN, storage, journal: journalA, patch: { anchor: 'tail', reason: '尾部出口换成补段', source: 'model' } })
    assert.equal(patchOut.ok, true)
    assert.equal(patchOut.changedFrom, BASE.lastIndexOf("throw new Error('tail-boom')"), 'changedFrom = 被换掉的 throw 行首（首个变更字节）')

    const resume = resumeScript(PATCHED, storage, RUN)
    assert.equal(resume.ok, true)
    assert.equal(resume.matchedCount, 2, '两 ask 都在变更点前 → 全部可导入')

    const journalB = createJournal({ storage, runId: RUN, now: fixedClock() })
    const driverB = createDriver('mock', { scenarios: [sc(P1, '1'), sc(P2, '2')] }) // 场景在而不用
    const resB = await runScript(
      { script: PATCHED, runId: RUN, journal: journalB, driver: driverB },
      { now: fixedClock(), sleep: instantSleep, askCache: resume.cached, patchFrom: patchOut.changedFrom },
    )
    assert.equal(resB.status, 'completed', '补段重跑到 completed')
    assert.equal(createCount(driverB), 0, '变更点前 ask 按 C1 规则导入：零重跑（零 driver 调用）')
    assert.equal(resB.asks.filter((a) => a.cached === true).length, 2, 'cached:true ×2（值恒等首跑）')
    assert.deepEqual(resB.logs, ['patched-tail'], '补段内容真执行（log 镜像）')
    assert.deepEqual(JSON.parse(JSON.stringify(resB.value)), { a: '1', b: '2', fixed: true }, '补段的新返回值回流')
    const events = diskEvents(storage)
    assert.equal(events.filter((e) => e.type === 'patch').length, 1, '盘上 patch 事件在')
    assert.ok(events.some((e) => e.type === 'log' && e.payload.message === 'patched-tail'), '补段 log 事件落盘')
    ok('尾部补段重跑：前缀零重跑 + 补段真执行 + patch/log 事件落盘')
  } finally {
    cleanup()
  }
}

// ---- 4. 补段内 throw → patch-failed（验收④：终态/保留/打捞边界 + 归类负向两路）----
console.log('4. 补段内失败归类与打捞')
{
  const RUN = 'run-patch-fail'
  const P1 = '败补甲: 给个数'
  const P2 = '败补乙: 补段内产出'
  const BASE = `const a = await F.ask(${JSON.stringify(P1)})\nF.log('first')`
  const PATCHED = `${BASE}\nconst r = await F.run('probe', ['x'])\nconst b = await F.ask(${JSON.stringify(P2)})\nthrow new Error('boom-in-patch')`
  const { home, cleanup } = tempHome('fail')
  try {
    const basePath = join(home, 'wf.js')
    writeFileSync(basePath, BASE)
    const storage = memStorage(null, `/mem/${RUN}.journal.json`)
    const journalA = createJournal({ storage, runId: RUN, now: fixedClock() })
    const driverA = createDriver('mock', { scenarios: [sc(P1, '1')] })
    const resA = await runScript({ script: BASE, runId: RUN, journal: journalA, driver: driverA }, { now: fixedClock(), sleep: instantSleep })
    assert.equal(resA.status, 'completed', '首跑在补段之前就结束了（completed，补段动机=事后追加）')

    const patchOut = await applyPatch({ scriptPath: basePath, patchedScript: PATCHED, runId: RUN, storage, journal: journalA, patch: { anchor: 'tail', reason: '追加分析段', source: 'model' } })
    assert.equal(patchOut.ok, true)
    assert.equal(patchOut.changedFrom, BASE.length, '尾部追加 → 边界 = base 长度')

    const resume = resumeScript(PATCHED, storage, RUN)
    assert.equal(resume.matchedCount, 1, 'callSeq 1 在变更点前可导入')

    // 重跑：补段内 F.run 成 → 补段内 ask 成 → 补段内 throw → patch-failed
    const journalB = createJournal({ storage, runId: RUN, now: fixedClock() })
    const driverB = createDriver('mock', { scenarios: [sc(P1, '1'), sc(P2, '2')] })
    const { spawnFn } = fakeSpawnFactory({ stdout: 'ok', stderr: '', exitCode: 0 })
    const resB = await runScript(
      { script: PATCHED, runId: RUN, journal: journalB, driver: driverB },
      { now: fixedClock(), sleep: instantSleep, askCache: resume.cached, patchFrom: patchOut.changedFrom, spawn: spawnFn },
    )
    assert.deepEqual([resB.status, resB.reason], ['failed', 'patch-failed'], '失败点在补段内（throw 位置 ≥ changedFrom）→ reason=patch-failed')
    assert.equal(resB.error, 'boom-in-patch', 'error 原文保留')
    assert.equal(resB.asks.length, 2, '补段内已完成 ask 保留在镜像（1 cached + 1 fresh）')
    assert.equal(resB.asks[0].cached, true, '前缀 ask 照常导入')
    assert.equal(resB.asks[1].value, '2', '补段内 ask 的产出在镜像里（打捞语义同首跑）')
    assert.equal(resB.runs.length, 1, '补段内 F.run 结果在镜像里')
    assert.deepEqual(diskEvents(storage).map((e) => e.type), ['ask', 'log', 'patch', 'log', 'run', 'ask'], '盘上事件全保留：首跑两笔 + patch + 重跑 log/run/ask（throw 不回滚）')

    // 打捞报告：补段边界（base→patched 指纹 + anchor）进报告
    const { writeReport, seen } = (() => {
      const seen2 = []
      return { writeReport: (path, text) => seen2.push({ path, text }), seen: seen2 }
    })()
    const w = writeSalvageReport({ storage, outcome: resB, now: fixedClock(1_700_000_000_000), writeReport })
    assert.equal(w.ok, true)
    assert.deepEqual([w.status, w.statusSource], ['failed', 'outcome'], '终局取调用方 outcome（failed）')
    assert.equal(w.patches.length, 1, '结构化 patches 恰 1 笔')
    assert.deepEqual(
      [w.patches[0].patchSeq, w.patches[0].anchor, w.patches[0].baseFingerprint, w.patches[0].patchedFingerprint],
      [1, 'tail', sha(BASE), sha(PATCHED)],
      '结构化补段边界：patchSeq/anchor/base→patched 指纹',
    )
    const md = seen[0].text
    assert.ok(md.includes('## 补段边界（共 1 次）'), '补段边界节在')
    assert.ok(md.includes(`| 1 | tail | \`${sha(BASE)}\` | \`${sha(PATCHED)}\``), '表格行含 patchSeq/anchor/base→patched 指纹全字节')
    assert.ok(md.includes('追加分析段'), '补段 reason 进报告')
    assert.ok(md.includes('reason=patch-failed'), 'run 级失败点 reason=patch-failed 进报告头')
    assert.ok(md.includes('boom-in-patch'), 'throw 原文进报告头')
    assert.ok(md.includes('## ask 结果（共 2 条）'), '补段内已完成 ask 进打捞表（首跑 1 条 + 补段内 1 条）')
    assert.equal(salvageReportPath(storage), seen[0].path, '落点 = <主干>.report.md')

    // 负向①：同一失败但未传 patchFrom（边界未接线）→ 维持 script-threw（不发明归类）
    const storageN = memStorage()
    const journalAN = createJournal({ storage: storageN, runId: 'run-patch-nofrom', now: fixedClock() })
    const driverAN = createDriver('mock', { scenarios: [sc(P1, '1')] })
    await runScript({ script: BASE, runId: 'run-patch-nofrom', journal: journalAN, driver: driverAN }, { now: fixedClock(), sleep: instantSleep })
    const basePathN = join(home, 'wf-nofrom.js')
    writeFileSync(basePathN, BASE)
    const patchN = await applyPatch({ scriptPath: basePathN, patchedScript: PATCHED, runId: 'run-patch-nofrom', storage: storageN, journal: journalAN, patch: { anchor: 'tail', reason: 'r', source: 's' } })
    const journalBN = createJournal({ storage: storageN, runId: 'run-patch-nofrom', now: fixedClock() })
    const driverBN = createDriver('mock', { scenarios: [sc(P1, '1'), sc(P2, '2')] })
    const resN = await runScript(
      { script: PATCHED, runId: 'run-patch-nofrom', journal: journalBN, driver: driverBN },
      { now: fixedClock(), sleep: instantSleep, spawn: spawnFn },
    )
    assert.deepEqual([resN.status, resN.reason], ['failed', 'script-threw'], '无 patchFrom → 不参与归类（维持 script-threw）')
    assert.equal(patchN.ok, true, '负向①夹具自检：补段本身成立')

    // 负向②：失败点在变更点之前（ask-failed 在前缀）→ 维持 ask-failed（不是 patch-failed）
    const BAD = '{"a": "no"}'
    const COUNT_SCHEMA = { type: 'object', required: ['a'], properties: { a: { type: 'integer' } } }
    const PF = '败前甲: 给个数'
    const PBAD = '败前乙: 会耗尽的问句'
    const ERRS = validateValue(JSON.parse(BAD), COUNT_SCHEMA, '产出').errors
    const BASEF = `const a = await F.ask(${JSON.stringify(PF)}, { schema: ${JSON.stringify(COUNT_SCHEMA)} })\nconst b = await F.ask(${JSON.stringify(PBAD)}, { schema: ${JSON.stringify(COUNT_SCHEMA)} })\nreturn b`
    const PATCHEDF = `${BASEF}\nF.log('tail')`
    const RUNF = 'run-patch-before'
    const basePathF = join(home, 'wf-before.js')
    writeFileSync(basePathF, BASEF)
    const storageF = memStorage()
    const scenarios = [sc(PBAD, BAD), sc(retryPrompt(PBAD, ERRS, { attempt: 2, maxAttempts: 3 }), BAD), sc(retryPrompt(PBAD, ERRS, { attempt: 3, maxAttempts: 3 }), BAD)]
    const journalAF = createJournal({ storage: storageF, runId: RUNF, now: fixedClock() })
    const driverAF = createDriver('mock', { scenarios: [sc(PF, '{"a": 1}'), ...scenarios] })
    const resAF = await runScript({ script: BASEF, runId: RUNF, journal: journalAF, driver: driverAF }, { now: fixedClock(), sleep: instantSleep })
    assert.deepEqual([resAF.status, resAF.reason], ['failed', 'ask-failed'], '首跑：callSeq 2 ask 耗尽 → ask-failed（对照）')
    const patchF = await applyPatch({ scriptPath: basePathF, patchedScript: PATCHEDF, runId: RUNF, storage: storageF, journal: journalAF, patch: { anchor: 'tail', reason: 'r', source: 's' } })
    assert.equal(patchF.ok, true)
    const resumeF = resumeScript(PATCHEDF, storageF, RUNF)
    assert.equal(resumeF.matchedCount, 1, '只有 callSeq 1 进缓存（ask-failed 不进）')
    const journalBF = createJournal({ storage: storageF, runId: RUNF, now: fixedClock() })
    const driverBF = createDriver('mock', { scenarios: [sc(PF, '{"a": 1}'), ...scenarios] })
    const resBF = await runScript(
      { script: PATCHEDF, runId: RUNF, journal: journalBF, driver: driverBF },
      { now: fixedClock(), sleep: instantSleep, askCache: resumeF.cached, patchFrom: patchF.changedFrom },
    )
    assert.deepEqual([resBF.status, resBF.reason], ['failed', 'ask-failed'], '失败点（callSeq 2 调用点 < changedFrom）在变更点前 → 维持 ask-failed')
    assert.equal(createArgs(driverBF).filter((a) => a.prompt === PF).length, 0, '前缀 ask 零重跑（对照命中面）')
    ok('补段内失败：patch-failed 终态 + 事件全保留 + 打捞边界进报告 + 无边界/边界前两路负向维持原 reason')
  } finally {
    cleanup()
  }
}

// ---- 5. gate 通路（验收⑤：补段文件走 register/check 与既有 workflow-script 完全一致）----
console.log('5. gate 通路（workflow-script 同矩阵）')
{
  // 权威决策矩阵（运行时读，行文不复制；engine-pgate-integration.test.mjs 同一文件同一 pin）
  const MATRIX_URL = new URL('./fixtures/decision-matrix.json', import.meta.url)
  const MATRIX_SHA256_PIN = '20f4ae0b93ae00ac75830fbdf80f99e7656f7c32565e10d3676a53f434b7522c'
  const matrix = JSON.parse(readFileSync(MATRIX_URL, 'utf8'))
  const rowById = (id) => {
    const row = matrix.rows.find((r) => r.id === id)
    assert.ok(row, `fixture 必须含行 ${id}`)
    return row
  }
  assert.equal(createHash('sha256').update(readFileSync(MATRIX_URL)).digest('hex'), MATRIX_SHA256_PIN, '矩阵 fixture sha256 pin 对齐')

  const { home, cleanup } = tempHome('gate')
  try {
    const storeDir = join(home, 'store')
    writeFileSync(join(home, 'plan.md'), 'seed plan bytes\n') // createPlanGate 的缺省 planPath（register 走显式路径，不读它）
    const basePath = join(home, 'wf-gate.js')
    const BASE = `const a = await F.ask("给个数")\nreturn a`
    writeFileSync(basePath, BASE)
    const PATCHED = `${BASE}\nawait F.run('curl', ['-fsSL', 'https://example.invalid/fix'])\nreturn { a, healed: true }`
    const storage = memStorage()
    const journal = createJournal({ storage, runId: 'run-patch-gate', now: fixedClock() })
    journal.recordEvent('log', { message: 'seed' }) // 让盘上 record 存在（补段锚点前提）

    // 补段产物直接走 gate（applyPatch 真 fs 落盘的文件路径）
    const patchOut = await applyPatch({ scriptPath: basePath, patchedScript: PATCHED, runId: 'run-patch-gate', storage, journal, patch: { anchor: 'tail', reason: '补出口', source: 'model' } })
    assert.equal(patchOut.ok, true)
    const patchedBytes = readFileSync(patchOut.patchedPath)
    assert.equal(Buffer.from(PATCHED, 'utf8').equals(patchedBytes), true, '夹具自检：补段文件字节 = patchedScript')

    const gate = createPlanGate({ options: { enabled: true, storeDir, planPath: join(home, 'plan.md') }, ledger: null, logger: { debug: () => {} }, directory: home })
    const call = async (args, sessionID) => JSON.parse((await gate.tool.execute(args, { sessionID })).output)
    const S = 'session-patch-gate'

    // register：与既有 workflow-script 同判别（语法门 + commands 扫描 + 全字节哈希）
    const reg = await call({ op: 'register', planPath: patchOut.patchedPath, kind: 'workflow-script' }, S)
    assert.equal(reg.ok, true, '补段文件 register 接受')
    assert.equal(reg.artifactKind, 'workflow-script')
    assert.equal(reg.hash, canonicalPlanHash(patchedBytes), 'hash 绑补段文件全字节')
    assert.deepEqual(reg.script.commands, ['curl'], 'commands 扫描覆盖补段新增命令字面量（供评审）')

    // check 四时点：#4（无判决 deny）→ 评审 pass → #10（allow）→ 偷改 → #5（deny）→ 恢复 → #10
    const checkFresh = await call({ op: 'check' }, S)
    assert.deepEqual([checkFresh.decision, checkFresh.reason], [rowById('gate-check#4').expected.decision, rowById('gate-check#4').expected.reason], '无判决 → deny（gate-check#4 原文）')

    await gate.before({ tool: 'subagent', sessionID: S, id: 'call-patch-gate', input: { agent: 'critic' } })
    await gate.after({
      tool: 'subagent',
      sessionID: S,
      id: 'call-patch-gate',
      input: { agent: 'critic' },
      status: 'success',
      result: { output: 'Reviewer concludes: pass.\n\n```json\n{"decision":"pass"}\n```' },
    })
    const checkPass = await call({ op: 'check' }, S)
    assert.deepEqual([checkPass.decision, checkPass.reason], [rowById('gate-check#10').expected.decision, rowById('gate-check#10').expected.reason], 'round 1 pass → allow（gate-check#10 原文）')
    const unblocked = await gate.before({ tool: 'shell', sessionID: S, id: 'x0', input: { command: 'ls' } })
    assert.equal(unblocked, undefined, '门开着：exec 放行')

    writeFileSync(patchOut.patchedPath, `${PATCHED}\n`) // 偷改补段文件字节（TOCTOU）
    const checkTampered = await call({ op: 'check' }, S)
    assert.deepEqual([checkTampered.decision, checkTampered.reason], [rowById('gate-check#5').expected.decision, rowById('gate-check#5').expected.reason], '换字节 → 旧 verdict 失配 → deny（gate-check#5 原文）')
    const blocked = await gate.before({ tool: 'shell', sessionID: S, id: 'x1', input: { command: 'ls' } })
    assert.ok(blocked instanceof Error && blocked.message.includes('PLAN-GATE DENY'), '门禁关闭：exec 被 DENY 拦（fail-closed 直到重评）')

    writeFileSync(patchOut.patchedPath, PATCHED) // 字节恢复
    const checkRestored = await call({ op: 'check' }, S)
    assert.deepEqual([checkRestored.decision, checkRestored.reason], [rowById('gate-check#10').expected.decision, rowById('gate-check#10').expected.reason], '字节恢复 → #10 allow')

    // 语法坏补段：register 拒绝且零记录（与既有 workflow-script 同轨）
    const badPath = join(home, 'wf-gate.patch-9.js')
    writeFileSync(badPath, 'const const const')
    const S_BAD = 'session-patch-gate-bad'
    const refused = await gate.registerSession(S_BAD, badPath, 'workflow-script')
    assert.equal(refused.ok, false, '语法坏补段 register 拒绝')
    assert.match(refused.error, /workflow-script invalid/, '报错点名 workflow-script invalid')
    assert.equal(existsSync(join(storeDir, `${storeStem(S_BAD)}.json`)), false, '零记录：store 文件不建')
    ok('gate 通路：补段文件 register/check 与既有 workflow-script 逐点同轨（#4/#10/#5/#10 矩阵原文 + commands 扫描 + fail-closed）')
  } finally {
    cleanup()
  }
}

// ---- 6. renderSalvageReport 纯函数面（垃圾 patch payload 软错误不抛）----
console.log('6. 打捞纯函数面（patch 采集软错误）')
{
  const record = {
    runId: 'run-s6',
    updatedAt: 1000,
    steps: {},
    engineSessions: [],
    events: [
      { type: 'patch', at: 1, payload: { patchSeq: 1, baseFingerprint: 'a'.repeat(64), patchedFingerprint: 'b'.repeat(64), anchor: 'tail', appliedAfterCallSeq: 0, reason: 'r', source: 's' } },
      { type: 'patch', at: 2 }, // 缺 payload → 软错误跳过
      { type: 'ask', at: 3, payload: { callSeq: 1, cacheKey: 'k:1', stepId: 'script-ask-1', value: 'V1', attempts: 1 } },
    ],
  }
  const r = renderSalvageReport({ runId: 'run-s6', journalRecord: record, now: fixedClock() })
  assert.equal(r.ok, true)
  assert.equal(r.patches.length, 1, '缺 payload 的 patch 软错误跳过（不抛）')
  assert.ok(r.errors.some((e) => e.includes('patch 事件缺 payload')), '软错误逐条列')
  assert.ok(r.markdown.includes('## 补段边界（共 1 次）'), '补段边界节计数')
  assert.ok(r.markdown.includes(`${'a'.repeat(64)}`) && r.markdown.includes(`${'b'.repeat(64)}`), 'base/patched 指纹全字节进表')
  assert.ok(r.markdown.includes('| — |'), '无 holeRef → 表格 — 占位')

  // 非 patch run：报告无补段节（与既往报告字节零差异）
  const plain = renderSalvageReport({ runId: 'run-s6-plain', journalRecord: { runId: 'run-s6-plain', updatedAt: 1, steps: {}, engineSessions: [], events: [] }, now: fixedClock() })
  assert.equal(plain.patches.length, 0)
  assert.ok(!plain.markdown.includes('补段边界'), '无 patch 事件不出节（既有报告零差异）')
  ok('打捞纯函数面：垃圾 patch payload 软错误 + 非 patch run 零差异')
}

console.log(`\n全部 ${passed} 项通过`)
