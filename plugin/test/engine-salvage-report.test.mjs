// C3 失败打捞报告测试（优化方案 v3.1「C3」行验收；报告实现 plugin/src/engine/salvage-report.js）。
//
// 计划验收原文：复用 S6 fault 注入夹具 → 本文件断言 failed/interrupted run 的报告含 N 条
// ask 结果与失败点。时钟/故障全部经构造参数注入（manualClock + fault.abortAt /
// fault.failWrite + writeReport 假写），禁 monkey-patch；夹具全合成（内存 storage + mock
// driver + 手工喂事件总线），不触真实引擎、不引用录制件。
//
// 覆盖矩阵：
//   脚本路径 failed run   runScript 3 ask + throw（reason=script-threw）→ 报告含 3 条 ask
//                 结果（journal ask 事件 payload.value，含 schema 对象值）＋ run 级失败点
//                 （reason/error 进报告头）＋ mermaid failed 尾红（renderRunReport 复用）。
//   声明路径 interrupted S6 fault.abortAt=['c'] 崩（run 主体已死、rejection 无人消费其内容）
//                 → 报告只由盘上 journal 渲染：2 条 done ask 结果（done payload）＋在飞中断
//                 点（c 停 dispatching）＋推导终局 interrupted ＋真 fs 落盘（报告路径 =
//                 <主干>.report.md 与 journal 同目录同主干）＋journal 字节分毫未动。
//   声明路径 failed   driver 步失败 → b failed、c/d superseded、run status=failed → 1 条 ask
//                 结果 ＋ 失败点（failed 步 + 错误 payload 原文）＋ superseded 进清点行。
//   撕裂 journal     S6 fault.failWrite='mid' 撕盘 → salvageable:false 诚实降级（ask/失败点
//                 两节写「无可打捞」）＋ 图退「全部未完成」保守口径 ＋ 撕裂字节原样保留。
//   无记录/读盘错   盘上无 journal（崩在首次落盘前）/ storage.read 抛错 → 如实注明，报告仍产出。
//   报告写失败     writeReport 注入抛错（§6 故障缝）→ {ok:false, reason:'report-write-failed'}，
//                 不假装写成功。
//   纯函数面      renderSalvageReport：脚本 record 无 outcome → unknown（终局标记不落盘，
//                 推导不出就明说）；垃圾 record 软错误不抛；ask 事件缺 value 跳过；
//                 TypeError 只归程序错误（runId/now/journalRecord 形状）。
//   Q4 机器读数   runStatusCode 六码映射（0 completed / 1 failed / 2 blocked-escalation /
//                 3 interrupted / 4 journal-torn / 5 unknown）：六类夹具逐一断言 + 事件级
//                 blocked-escalation 判据（escalated 无 escalation-answered 配对——配对销账
//                 不误报、重复挂起再入账、跨步不误销）+ 混合现场（1 failed + 1 挂起 → 2 非 1）
//                 + --status CLI 真 spawn 断言退出码（六类 + 撕裂/形状坏/不存在 → 4 + 用法错 64）。
//
// 运行：node plugin/test/engine-salvage-report.test.mjs（assert 失败即抛、非零退出；成功自然退出）
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDriver } from '../src/engine/driver.js'
import { createJournal, makeJournalStorage, validateJournalRecord } from '../src/engine/journal.js'
import { ABORT_CODE, run } from '../src/engine/scheduler.js'
import { renderSalvageReport, runStatusCli, runStatusCode, RUN_STATUS_CODES, salvageReportPath, writeSalvageReport } from '../src/engine/salvage-report.js'
import { runScript } from '../src/engine/script-runner.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- 夹具基座（全合成，S6 engine-resume.test.mjs 同一套形状）----
/** 内存 storage：read 初值 null（「无记录」），write 捕获最新文本；file 字段给报告路径推导用
    （makeJournalStorage 产物同形——S6 夹具本无 file，打捞报告的落点推导需要它）。 */
const memStorage = (initial = null, file = null) => {
  let text = initial
  return { read: () => text, write: (t) => (text = t), ...(file !== null ? { file } : {}) }
}
/** 可控时钟：now() 停在当前值，测试用 advance(ms) 显式推进（§6 注入，确定性）。 */
const manualClock = (start = 10_000) => {
  let t = start
  const now = () => t
  now.advance = (ms) => {
    t += ms
    return t
  }
  return now
}
const fixedClock = (t = 1000) => () => t
/** 即时 sleep（禁真实定时器；typedAsk 轮询节奏用）。 */
const instantSleep = async () => {}
/** 可喂事件的 AsyncIterable：feed 进队或直接唤醒挂起的 next()。 */
const makeEvents = () => {
  const queue = []
  const waiters = []
  return {
    feed: (ev) => {
      const wake = waiters.shift()
      if (wake) wake({ value: ev, done: false })
      else queue.push(ev)
    },
    events: {
      [Symbol.asyncIterator]: () => ({
        next: () => (queue.length > 0 ? Promise.resolve({ value: queue.shift(), done: false }) : new Promise((resolve) => waiters.push(resolve))),
      }),
    },
  }
}
const idleEv = () => ({ type: 'session.idle' })
const tick = () => new Promise((r) => setTimeout(r, 0))
/** 轮询等待直到 f() 为真（超时即断言失败）。 */
const until = async (f, label, tries = 4000) => {
  for (let i = 0; i < tries && !f(); i += 1) await tick()
  assert.ok(f(), `等待超时：${label}`)
}
/** run() 终局看门狗：永不终局就是 bug，断言炸出而非挂死进程。 */
const settle = (p, ms = 8000) => {
  let timer = null
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('run() 未在时限内终局（调度循环悬挂）')), ms)
  })
  return Promise.race([p, watchdog]).finally(() => clearTimeout(timer))
}
/** 假写捕获（writeReport 注入）：记下 (path, text)，不出真 fs。 */
const capture = () => {
  const seen = []
  const writeReport = (path, text) => seen.push({ path, text })
  return { writeReport, seen }
}

const P = (id) => `任务 ${id}`
const step = (id, deps = []) => ({ stepId: id, prompt: P(id), deps })
const CHAIN = ['a', 'b', 'c', 'd']
const chainDecl = (runId) => ({ runId, steps: CHAIN.map((id, i) => step(id, i === 0 ? [] : [CHAIN[i - 1]])) })
/** mock 场景速写：单条 done 应答（粘滞；sessionId 钉死防跨 run 撞名）。 */
const sc = (id, text) => ({ name: id, match: { prompt: P(id) }, sessionId: `sess_salvage_${id}`, result: [{ status: 'done', text }] })
const doneScenarios = (suffix) => CHAIN.map((id) => sc(id, `${id} ${suffix}`))

// ---- 0. 参数面（TypeError = 程序错误，fail-fast）+ 路径推导 ----
console.log('0. 参数面与路径推导')
{
  assert.throws(() => renderSalvageReport({}), TypeError, 'render 缺 runId 应抛')
  assert.throws(() => renderSalvageReport({ runId: 'r', now: 42 }), TypeError, 'render now 非函数应抛')
  assert.throws(() => renderSalvageReport({ runId: 'r', journalRecord: 42 }), TypeError, 'render journalRecord 非对象应抛')
  assert.throws(() => renderSalvageReport({ runId: 'r', outcome: 'failed' }), TypeError, 'render outcome 非对象应抛')
  assert.throws(() => renderSalvageReport({ runId: 'r', note: 42 }), TypeError, 'render note 非字符串应抛')
  assert.throws(() => writeSalvageReport({}), TypeError, 'write 缺 storage 应抛')
  assert.throws(() => writeSalvageReport({ storage: { read: () => null } }), TypeError, 'write 路径推导不出（storage 无 file）应抛')
  assert.throws(() => writeSalvageReport({ storage: { read: () => null }, reportPath: '' }), TypeError, 'write reportPath 空串应抛')
  assert.throws(() => writeSalvageReport({ storage: { read: () => null, file: '/m/r.journal.json' }, writeReport: 42 }), TypeError, 'write writeReport 非函数应抛')
  assert.throws(
    () => writeSalvageReport({ storage: memStorage(null, '/m/r.journal.json'), declaration: { runId: '' } }),
    TypeError,
    'write runId 推导不出应抛（空声明 runId + 盘上无记录）',
  )
  assert.equal(salvageReportPath({}), null, 'storage 无 file → null')
  assert.equal(salvageReportPath({ file: 'not-a-journal.txt' }), null, 'file 后缀不符 → null')
  assert.equal(
    salvageReportPath({ file: join('root', 'run-1.journal.json') }),
    join('root', 'run-1.report.md'),
    '路径推导：同目录同主干换后缀（沿用 journal 落点）',
  )
  ok('参数面 9 路 TypeError + salvageReportPath 推导/拒绝面')
}

// ---- 1. 脚本路径 failed run（3 ask + throw）——N=3 条 ask 结果 + run 级失败点 + failed 尾红 ----
console.log('1. 脚本路径 failed run')
{
  const runId = 'run-salvage-script'
  const P1 = '脚本问句一：给出标题'
  const P2 = '脚本问句二：给出计数'
  const P3 = '脚本问句三：给出结论'
  const COUNT_SCHEMA = { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } }
  const script = [
    `F.phase('采集')`,
    `const t = await F.ask(${JSON.stringify(P1)})`,
    `const c = await F.ask(${JSON.stringify(P2)}, { schema: ${JSON.stringify(COUNT_SCHEMA)} })`,
    `F.phase('分析')`,
    `const q = await F.ask(${JSON.stringify(P3)})`,
    `throw new Error('分析阶段炸了：合成失败')`,
  ].join('\n')
  const driver = createDriver('mock', {
    scenarios: [
      { name: 'ask1', match: { prompt: P1 }, sessionId: 'sess_script_ask1', result: [{ status: 'done', text: '标题：合成打捞' }] },
      { name: 'ask2', match: { prompt: P2 }, sessionId: 'sess_script_ask2', result: [{ status: 'done', text: '{"n":13}' }] },
      { name: 'ask3', match: { prompt: P3 }, sessionId: 'sess_script_ask3', result: [{ status: 'done', text: '结论：无出路' }] },
    ],
  })
  const storage = memStorage(null, `/mem/${runId}.journal.json`)
  const journal = createJournal({ storage, runId, now: fixedClock(500) })
  const res = await runScript({ script, runId, journal, driver }, { now: fixedClock(500), sleep: instantSleep })
  assert.deepEqual([res.status, res.reason], ['failed', 'script-threw'], '脚本 throw → failed/script-threw')

  // 盘上真相：3 条 ask 事件（payload.value 在位）——报告的取数源
  const disk = JSON.parse(storage.read())
  assert.equal(disk.events.filter((e) => e.type === 'ask').length, 3, '盘上恰 3 条 ask 事件')

  const { writeReport, seen } = capture()
  const w = writeSalvageReport({ storage, outcome: res, now: fixedClock(1_700_000_000_000), writeReport })
  assert.equal(w.ok, true, '报告产出 ok')
  assert.equal(w.salvageable, true, 'journal 完好 → salvageable')
  assert.deepEqual([w.status, w.statusSource], ['failed', 'outcome'], '终局取调用方 outcome')
  assert.equal(w.askResults.length, 3, 'N=3：ask 结果恰 3 条（journal ask 事件 value）')
  assert.ok(w.askResults.every((r) => r.source === 'ask-event'), '全部来自 ask 事件')
  assert.deepEqual(w.askResults[1].value, { n: 13 }, 'schema ask 的 value 是对象（payload.value 原样）')
  assert.deepEqual(w.failurePoints, [], '脚本路径无步 → 步级失败点为空（失败点在 run 级头部）')
  assert.equal(seen.length, 1, '假写恰一次')
  assert.equal(seen[0].path, salvageReportPath(storage), '落点 = <主干>.report.md（与 journal 同目录同主干）')
  const md = seen[0].text
  assert.equal(md, w.markdown, '返回 markdown 与落盘一致')
  assert.ok(md.includes('# Run 打捞报告：run-salvage-script'), '标题带 runId')
  assert.ok(md.includes('- 生成：2023-11-14T22:13:20.000Z'), '生成时刻走注入时钟（1700000000000 的 ISO）')
  assert.ok(md.includes('reason=script-threw'), 'run 级失败点：reason 进报告头')
  assert.ok(md.includes('分析阶段炸了：合成失败'), 'run 级失败点：error 进报告头')
  assert.ok(md.includes('## ask 结果（共 3 条）'), 'ask 结果节计数 N=3')
  assert.ok(md.includes('标题：合成打捞') && md.includes('结论：无出路'), '文本 value 逐条进表')
  assert.ok(md.includes('"n":13'), '对象 value 以 compact JSON 进表')
  assert.ok(md.includes('## 失败点（共 0 条）'), '失败点节存在且如实计 0（失败在 run 级，不在步）')
  assert.ok(md.includes('```mermaid'), 'mermaid 围栏在')
  assert.ok(md.includes('p0["采集"]') && md.includes('p1["分析"]'), '脚本路径 phase 时间线节点')
  assert.ok(md.includes('class p1 st-failed'), 'failed 尾红（outcome.status=failed 透传）——计划点名「failed 尾红已支持」')
  assert.ok(md.includes('class p0 st-done'), '尾前 phase 本就完成（renderScriptTimeline 口径：过去=done）——红只打在尾')
  ok('脚本 failed run：3 条 ask 结果（value 原样）+ run 级失败点 + failed 尾红 + 落点推导')
}

// ---- 2. 声明路径 interrupted run（S6 fault.abortAt=['c'] 崩）——报告不依赖 run 主体存活 ----
console.log('2. 声明路径 interrupted run（abortAt 崩）')
{
  const runId = 'run-salvage-int'
  const dir = mkdtempSync(join(tmpdir(), 'reeve-salvage-'))
  const storage = makeJournalStorage(dir, runId)
  const clock = manualClock(77_000)
  const decl = chainDecl(runId)
  const bus = makeEvents()
  const journal = createJournal({ storage, runId, now: clock })
  const driver1 = createDriver('mock', { scenarios: doneScenarios('初跑完'), now: clock })
  const p = run(decl, { journal, driver: driver1, fault: { abortAt: ['c'] }, now: clock, events: bus.events })
  const crashed = assert.rejects(settle(p), (e) => e.code === ABORT_CODE, 'abortAt 命中 c（崩溃现场：run 主体已死）')
  for (const id of ['a', 'b']) {
    await until(() => journal.getStepState(id)?.state === 'running', `${id} 入飞`)
    bus.feed(idleEv())
    await until(() => journal.getStepState(id)?.state === 'done', `${id} 完成`)
  }
  await crashed
  assert.equal(journal.getStepState('c')?.state, 'dispatching', '崩位 c 停 dispatching')

  // run 主体已经死了（rejection 已被消费、无人再传 outcome）——报告只认盘上 journal
  const journalBytesBefore = storage.read()
  const w = writeSalvageReport({ storage, declaration: decl, now: clock }) // 缺省 fs 落盘（真写）
  assert.equal(w.ok, true, '崩溃后报告照常产出')
  assert.equal(w.salvageable, true, 'journal 完好 → salvageable')
  assert.deepEqual([w.status, w.statusSource], ['interrupted', 'journal'], '无 outcome → journal 推导 interrupted')
  assert.equal(w.askResults.length, 2, 'N=2：崩前 done 步的 ask 结果恰 2 条（done payload）')
  assert.deepEqual(w.askResults.map((r) => [r.source, r.stepId]), [
    ['done-payload', 'a'],
    ['done-payload', 'b'],
  ], '来源 done payload、步序按 record.steps')
  assert.equal(w.askResults[0].value.result.text, 'a 初跑完', 'done payload 原样回流（result.text）')
  assert.deepEqual(
    w.failurePoints.map((f) => [f.stepId, f.state, f.kind]),
    [['c', 'dispatching', 'inflight']],
    '失败点 = 在飞中断点 c（dispatching）',
  )
  const reportPath = join(dir, 'run-salvage-int.report.md')
  assert.equal(w.path, reportPath, '落点与 journal 同目录同主干（真 fs）')
  assert.ok(existsSync(reportPath), '报告文件真落盘')
  const onDisk = readFileSync(reportPath, 'utf8')
  assert.equal(onDisk, w.markdown, '盘上字节 = 返回 markdown')
  assert.ok(onDisk.includes('## ask 结果（共 2 条）'), 'ask 结果节计数 N=2')
  assert.ok(onDisk.includes('a 初跑完') && onDisk.includes('b 初跑完'), '崩前结果逐条进表（打捞不丢已完成步）')
  assert.ok(onDisk.includes('## 失败点（共 1 条）'), '失败点节计数 1（在飞中断点）')
  assert.ok(onDisk.includes('dispatching（在飞中断）'), '中断点状态标注')
  assert.ok(onDisk.includes('- run 终局：interrupted'), '推导终局如实（不发明 completed/failed）')
  assert.ok(onDisk.includes(`- 生成：${new Date(clock()).toISOString()}`), '生成时刻走注入时钟')
  assert.ok(onDisk.includes('class n0,n1 st-done'), 'mermaid：崩前两步绿')
  assert.ok(onDisk.includes('class n2 st-running'), 'mermaid：崩位 c 蓝（dispatching → running 桶，如实）')
  assert.ok(onDisk.includes('class n3 st-pending'), 'mermaid：未播种 d 灰')
  assert.ok(onDisk.includes('未派: 无') || onDisk.includes('其余步清点'), '清点行在')
  assert.equal(storage.read(), journalBytesBefore, 'journal 字节分毫未动（报告纯读端）')
  ok('interrupted run：2 条 done ask 结果 + 在飞中断点 + interrupted 推导 + 真落盘 + journal 零触碰')
}

// ---- 3. 声明路径 failed run（driver 步失败 → b failed + c/d superseded）----
console.log('3. 声明路径 failed run')
{
  const runId = 'run-salvage-failed'
  const storage = memStorage(null, `/mem/${runId}.journal.json`)
  const clock = manualClock(88_000)
  const decl = chainDecl(runId)
  const journal = createJournal({ storage, runId, now: clock })
  const EP = '合成失败：b 的子会话报错'
  const driver = createDriver('mock', {
    scenarios: [sc('a', 'a 初跑完'), { name: 'b', match: { prompt: P('b') }, sessionId: 'sess_salvage_bfail', result: [{ status: 'failed', errorPart: EP }] }],
    now: clock,
  })
  const bus = makeEvents()
  const p = run(decl, { journal, driver, now: clock, events: bus.events })
  for (let i = 0; i < 32 && !CHAIN.every((id) => ['done', 'failed', 'superseded'].includes(journal.getStepState(id)?.state)); i += 1) {
    bus.feed(idleEv())
    await tick()
    await tick()
  }
  const out = await settle(p)
  assert.equal(out.status, 'failed', 'run 以 failed 终局（b 死在半途）')
  assert.deepEqual([journal.getStepState('b')?.state, journal.getStepState('c')?.state, journal.getStepState('d')?.state], ['failed', 'superseded', 'superseded'], 'b failed + c/d 连带作废')

  const { writeReport, seen } = capture()
  const w = writeSalvageReport({ storage, declaration: decl, outcome: out, now: clock, writeReport })
  assert.equal(w.ok, true)
  assert.deepEqual([w.status, w.statusSource], ['failed', 'outcome'], '终局取 outcome（run 主体活着）')
  assert.equal(w.askResults.length, 1, 'N=1：done 步 a 的 ask 结果恰 1 条')
  assert.deepEqual(
    w.failurePoints.map((f) => [f.stepId, f.state, f.kind]),
    [['b', 'failed', 'failure']],
    '失败点 = failed 步 b',
  )
  assert.equal(w.failurePoints[0].payload.error.errorPart, EP, '错误 payload 原文（journal failed 迁移的 payload）')
  const md = seen[0].text
  assert.ok(md.includes('## ask 结果（共 1 条）'), 'ask 结果节计数 N=1')
  assert.ok(md.includes('a 初跑完'), 'a 的结果进表')
  assert.ok(md.includes('## 失败点（共 1 条）'), '失败点节计数 1')
  assert.ok(md.includes(EP), '错误 payload 原文进表（诊断面）')
  assert.ok(md.includes('| b | failed | 1 |'), 'b 的状态/attempts 进表')
  assert.ok(md.includes('——来源：调用方 outcome'), '终局来源标注')
  assert.ok(md.includes('class n1 st-failed'), 'mermaid：b 红')
  assert.ok(md.includes('class n2,n3 st-superseded'), 'mermaid：c/d 虚灰（连带作废不混桶）')
  assert.ok(md.includes('superseded(连带作废): c, d'), '清点行列连带作废步')
  ok('failed run：1 条 ask 结果 + b 失败点（payload 原文）+ superseded 清点 + failed 尾红')
}

// ---- 4. 撕裂 journal（S6 fault.failWrite='mid'）——salvageable:false 诚实降级 ----
console.log('4. 撕裂 journal（failWrite=mid）')
{
  const runId = 'run-salvage-torn'
  const storage = memStorage(null, `/mem/${runId}.journal.json`)
  const clock = manualClock(99_000)
  const decl = chainDecl(runId)
  const journal = createJournal({ storage, runId, fault: { failWrite: 'mid' }, now: clock })
  const bad = journal.appendStepState('a', null, 'declared')
  assert.equal(bad.ok, false, 'mid 故障实例调用 not-ok')
  const tornRaw = storage.read()
  assert.throws(() => JSON.parse(tornRaw), SyntaxError, '盘上是撕裂 JSON')

  const { writeReport, seen } = capture()
  const w = writeSalvageReport({ storage, declaration: decl, now: clock, writeReport })
  assert.equal(w.ok, true, '撕裂也产报告（C3 承诺：failed/interrupted 时也产）')
  assert.equal(w.salvageable, false, '无可打捞 → salvageable:false（不假装有货）')
  assert.deepEqual([w.status, w.statusSource], ['unknown', 'journal'], '撕裂 → 终局 unknown（deny，不猜）')
  assert.equal(w.askResults.length, 0, '零 ask 结果（撕裂不认账）')
  assert.equal(w.failurePoints.length, 0, '零失败点（撕裂不认账）')
  const md = seen[0].text
  assert.ok(md.includes('journal 撕裂（unparseable）'), '撕裂事实如实注明')
  assert.ok(md.includes('撕裂字节原样保留'), '不修复承诺进报告')
  assert.ok(md.includes('宁可重跑，不可假完成'), '保守口径警示行')
  assert.ok(md.includes('## ask 结果（共 0 条）') && md.includes('（无可打捞的 ask 结果）'), 'ask 节如实写无')
  assert.ok(md.includes('## 失败点（共 0 条）'), '失败点节如实写无')
  assert.ok(md.includes('class n0,n1,n2,n3 st-pending'), '图退「全部未完成」保守口径（全灰）')
  assert.deepEqual(
    md.split('\n').filter((l) => l.trimStart().startsWith('class n')),
    ['    class n0,n1,n2,n3 st-pending'],
    '撕裂状态唯一的着色行 = 全灰（不假绿不假红）',
  )
  assert.equal(storage.read(), tornRaw, '撕裂字节原样保留（报告纯读端）')
  ok('撕裂 journal：salvageable:false 诚实降级 + 保守口径图 + 撕裂字节零触碰')
}

// ---- 5. 盘上无记录 / 读盘失败——报告仍产出 ----
console.log('5. 无记录与读盘失败')
{
  const { writeReport, seen } = capture()
  const w1 = writeSalvageReport({
    storage: memStorage(null, '/mem/run-none.journal.json'),
    declaration: chainDecl('run-none'),
    now: fixedClock(),
    writeReport,
  })
  assert.equal(w1.ok, true)
  assert.equal(w1.salvageable, false, '无记录 → 不可打捞')
  assert.ok(seen.at(-1).text.includes('盘上无 journal 记录（崩在首次落盘之前）'), '无记录事实如实注明')

  const broken = { read: () => { throw new Error('EIO: 读盘炸了') }, file: '/mem/run-eio.journal.json' }
  const w2 = writeSalvageReport({ storage: broken, declaration: chainDecl('run-eio'), now: fixedClock(), writeReport })
  assert.equal(w2.ok, true, '读盘失败也产报告')
  assert.equal(w2.salvageable, false)
  assert.ok(seen.at(-1).text.includes('journal 读盘失败（EIO: 读盘炸了）'), '读盘错误原文进报告')
  ok('无记录/读盘失败：报告照常产出且如实注明（salvageable:false）')
}

// ---- 6. 报告写失败（writeReport 注入抛错，§6 故障缝）----
console.log('6. 报告写失败')
{
  const w = writeSalvageReport({
    storage: memStorage(null, '/mem/run-wf.journal.json'),
    declaration: chainDecl('run-wf'),
    now: fixedClock(),
    writeReport: () => {
      throw new Error('ENOSPC: 注入的报告写失败')
    },
  })
  assert.deepEqual([w.ok, w.reason], [false, 'report-write-failed'], '写失败如实报 not-ok（不假装写成功）')
  assert.equal(w.path, '/mem/run-wf.report.md', '失败也带回落点')
  assert.ok(w.error.includes('ENOSPC'), '错误原文带回')
  ok('报告写失败：ok:false + 原因/落点/错误原文（盘上 journal 不受影响）')
}

// ---- 7. renderSalvageReport 纯函数面（脚本 record 无 outcome → unknown；垃圾形状软错误）----
console.log('7. 纯函数面')
{
  // 脚本 record（只有事件、无步记账）无 outcome：终局标记不落盘 → unknown，不发明终局。
  const scriptRecord = {
    runId: 'run-s7',
    updatedAt: 1000,
    steps: {},
    engineSessions: [],
    events: [
      { type: 'phase', at: 1, payload: { name: '采集' } },
      { type: 'ask', at: 2, payload: { callSeq: 1, cacheKey: 'k:1', stepId: 'script-ask-1', value: 'V1', attempts: 1 } },
    ],
  }
  const r1 = renderSalvageReport({ runId: 'run-s7', journalRecord: scriptRecord, now: fixedClock(1234) })
  assert.equal(r1.ok, true)
  assert.deepEqual([r1.status, r1.statusSource], ['unknown', 'journal'], '脚本 record 无 outcome → unknown')
  assert.ok(r1.markdown.includes('无法推导'), 'unknown 口径解释进报告')
  assert.ok(r1.markdown.includes('终局标记只在 run 主体广播'), '「脚本终局不落盘」如实注明')
  assert.equal(r1.askResults.length, 1, 'ask 事件 value 照打捞')
  assert.ok(r1.markdown.includes('p0["采集"]') && r1.markdown.includes('class p0 st-running'), '脚本时间线尾 running（停在这里的如实读法）')
  assert.ok(r1.markdown.includes('## ask 结果（共 1 条）'), 'ask 节计数')

  // ask 事件缺 payload.value → 跳过 + 软错误（打捞面只认成功 ask）。
  const badAsk = { ...scriptRecord, events: [{ type: 'ask', at: 1, payload: { callSeq: 1 } }] }
  const r2 = renderSalvageReport({ runId: 'run-s7', journalRecord: badAsk, now: fixedClock() })
  assert.equal(r2.askResults.length, 0, '缺 value 的 ask 不进结果')
  assert.ok(r2.errors.some((e) => e.includes('缺 payload.value')), '软错误逐条列')

  // 垃圾 record：ok 不抛，mermaid 渲染不可用如实列出。
  const r3 = renderSalvageReport({ runId: 'r', journalRecord: { steps: 'no', events: 42 }, now: fixedClock() })
  assert.equal(r3.ok, true)
  assert.ok(r3.markdown.includes('mermaid 渲染不可用'), '无数据源 → 渲染不可用如实进报告')

  // outcome 与 journal 并存：outcome 优先（run 主体活着）。
  const doneRecord = {
    runId: 'run-s7d',
    updatedAt: 1000,
    steps: { a: { state: 'done', attempts: 1, history: [{ from: null, to: 'declared', at: 1 }] } },
    engineSessions: [],
    events: [],
  }
  const r4 = renderSalvageReport({ runId: 'run-s7d', journalRecord: doneRecord, outcome: { status: 'completed' }, now: fixedClock() })
  assert.deepEqual([r4.status, r4.statusSource], ['completed', 'outcome'], 'outcome 优先')
  ok('纯函数面：unknown 不发明终局 + 缺 value 软错误 + 垃圾形状不抛 + outcome 优先')
}

// ---- 8. Q4 机器读数契约：runStatusCode 六码映射 + --status CLI 退出码 ----
// 计划 Q4 行验收：六类夹具逐一断言退出码 + 混合现场（1 failed + 1 挂起 → 2 非 1）；
// blocked-escalation 推导 = 事件级判据（escalated 无 escalation-answered 配对）非纯状态扫描。
console.log('8. Q4 机器读数契约（六码映射 + --status CLI）')
{
  // 夹具基座：validateJournalRecord 合法的最小 record（步账 + 事件流水；计划写死 CLI 先过形状校验）。
  const stepEntry = (state) => ({ state, attempts: 1, history: [{ from: null, to: state, at: 1 }] })
  const rec = (steps, events = []) => ({ version: 1, runId: 'run-q4', updatedAt: 1000, steps, engineSessions: [], events })
  const esc = (stepId) => ({ type: 'escalated', at: 2, payload: { stepId, question: '卡住了，怎么走？' } })
  const ans = (stepId) => ({ type: 'escalation-answered', at: 3, payload: { stepId, answer: '走北线', operator: null, source: 'unknown' } })

  // 六类夹具：一类一码（record 或 null；null = torn，CLI 认不出合法 record 时传入的形状）。
  const fixtures = [
    ['completed', rec({ a: stepEntry('done'), b: stepEntry('done') }), 0],
    ['failed', rec({ a: stepEntry('done'), b: stepEntry('failed'), c: stepEntry('superseded') }), 1],
    ['blocked-escalation', rec({ a: stepEntry('done'), b: stepEntry('blocked') }, [esc('b')]), 2],
    ['interrupted', rec({ a: stepEntry('done'), b: stepEntry('running'), c: stepEntry('declared') }), 3],
    ['journal-torn', null, 4],
    ['unknown', rec({}, [{ type: 'phase', at: 1, payload: { name: '采集' } }, { type: 'ask', at: 2, payload: { stepId: 'script-ask-1', value: 'V' } }]), 5],
  ]
  for (const [name, record, code] of fixtures) {
    if (record !== null) assert.notEqual(validateJournalRecord(record), null, `夹具 ${name} 本身过形状校验（CLI 的准入形状）`)
    assert.equal(runStatusCode(record), code, `六码映射：${name} → ${code}`)
  }
  assert.equal(RUN_STATUS_CODES['blocked-escalation'], 2, '六码字典：blocked-escalation=2（消费方按名引用）')
  assert.throws(() => runStatusCode(42), TypeError, 'record 既非对象也非 null → TypeError（程序错误分轨）')
  ok('六类夹具逐一断言 runStatusCode（0/1/2/3/4/5）+ TypeError 分轨')

  // blocked-escalation 事件级判据（非纯状态扫描）：配对与否只有事件流水能证明。
  assert.equal(
    runStatusCode(rec({ a: stepEntry('done'), b: stepEntry('blocked') }, [esc('b'), ans('b')])),
    RUN_STATUS_CODES.interrupted,
    'escalated 有 escalation-answered 配对 → 不判挂起（blocked 步态退为半途 interrupted）',
  )
  assert.equal(
    runStatusCode(rec({ a: stepEntry('done'), b: stepEntry('blocked') }, [esc('b'), ans('b'), esc('b')])),
    RUN_STATUS_CODES['blocked-escalation'],
    '同步再挂起（答复后又 escalated）→ 仍未配对 → 判挂起',
  )
  assert.equal(
    runStatusCode(rec({ b: stepEntry('blocked') }, [esc('b'), ans('b'), ans('b')])),
    RUN_STATUS_CODES.interrupted,
    '重复答复只销一次账（不跨对误配）→ 挂起已清 → 非挂起',
  )
  assert.equal(
    runStatusCode(rec({ a: stepEntry('blocked'), b: stepEntry('blocked') }, [esc('a'), esc('b'), ans('a')])),
    RUN_STATUS_CODES['blocked-escalation'],
    '跨步不误销（a 答复不消 b 的挂起）→ 判挂起',
  )
  ok('事件级判据：配对销账不误报 + 再挂起再入账 + 重复答复不跨对 + 跨步不误销')

  // 混合现场（计划点名）：1 failed + 1 挂起 → 2 非 1（优先级对齐 scheduler.finish：挂起先判）。
  const mixed = rec({ a: stepEntry('done'), b: stepEntry('failed'), c: stepEntry('blocked') }, [esc('c')])
  assert.equal(runStatusCode(mixed), RUN_STATUS_CODES['blocked-escalation'], '混合现场：1 failed + 1 挂起 → 2 非 1')
  ok('混合现场：failed 步与挂起问句并存 → blocked-escalation(2) 优先于 failed(1)')

  // --status CLI：真 spawn 断言退出码（验收原文「以状态码退出」），夹具落 tmpdir 真 fs。
  const cliPath = fileURLToPath(new URL('../src/engine/salvage-report.js', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'reeve-q4-status-'))
  const spawnStatus = (journalPath) => spawnSync(process.execPath, [cliPath, '--status', journalPath], { encoding: 'utf8' })
  const tornPath = join(dir, 'torn.journal.json')
  writeFileSync(tornPath, '{"runId":"run-q4","updatedAt":1,"steps":{"a":{"stat', 'utf8') // 撕裂 JSON
  const badShapePath = join(dir, 'bad-shape.journal.json')
  writeFileSync(badShapePath, JSON.stringify({ runId: 'run-q4' }), 'utf8') // 形状坏（缺 steps/events/engineSessions/updatedAt）
  const missingPath = join(dir, 'absent.journal.json') // 不存在（崩在首次落盘之前）
  const cliCases = [
    ...fixtures.map(([name, record, code]) => [name, record === null ? tornPath : join(dir, `${name}.journal.json`), record === null ? null : JSON.stringify(record), code]),
    ['shape-invalid', badShapePath, null, 4],
    ['file-missing', missingPath, null, 4],
  ]
  for (const [name, path, content, code] of cliCases) {
    if (content !== null) writeFileSync(path, content, 'utf8')
    const spawned = spawnStatus(path)
    assert.equal(spawned.status, code, `CLI --status ${name} 以状态码 ${code} 退出（实得 ${spawned.status}）`)
  }
  const mixedPath = join(dir, 'mixed.journal.json')
  writeFileSync(mixedPath, JSON.stringify(mixed), 'utf8')
  const mixedSpawn = spawnStatus(mixedPath)
  assert.equal(mixedSpawn.status, 2, 'CLI 混合现场退出码 2 非 1')
  assert.equal(mixedSpawn.stdout.trim(), '2 blocked-escalation', 'CLI stdout 一行「<码> <名>」（机器吃退出码，人看 stdout）')
  ok('CLI --status：六类夹具 + 形状坏 + 不存在 全部真 spawn 断言退出码（撕裂族 → 4）')

  // 用法错：无参 → 用法行进 stderr + 退出码 64（EX_USAGE，六码域外不混音）。
  const usageSpawn = spawnSync(process.execPath, [cliPath], { encoding: 'utf8' })
  assert.equal(usageSpawn.status, 64, 'CLI 无参 → 用法错 64（不与六码混音）')
  assert.ok(usageSpawn.stderr.includes('用法'), '用法行进 stderr')
  assert.ok(usageSpawn.stderr.includes('2 blocked-escalation'), '六码语义随用法行写死')
  assert.equal(runStatusCli(['--status']), 64, 'runStatusCli 可注入 argv 直测（缺路径 → 64）')
  ok('用法错：退出码 64 + 用法行（含六码语义）进 stderr + runStatusCli 注入式可测')
}

console.log(`\nC3 打捞报告测试：${passed} 项全过`)
