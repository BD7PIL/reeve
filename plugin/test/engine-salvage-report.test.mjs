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
//
// 运行：node plugin/test/engine-salvage-report.test.mjs（assert 失败即抛、非零退出；成功自然退出）
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDriver } from '../src/engine/driver.js'
import { createJournal, makeJournalStorage } from '../src/engine/journal.js'
import { ABORT_CODE, run } from '../src/engine/scheduler.js'
import { renderSalvageReport, salvageReportPath, writeSalvageReport } from '../src/engine/salvage-report.js'
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

console.log(`\nC3 打捞报告测试：${passed} 项全过`)
