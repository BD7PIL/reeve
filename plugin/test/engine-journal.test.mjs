// E1 引擎 journal 测试（S2 自有门；施工规格 .zcode/plans/e1-construction-spec.md
// §4-S2 / §5-T3.4-torn 半边 / §5-T3.5 journal 侧 / §6 fault+clock 注入）。
//
// 覆盖矩阵：tmp+rename 原子写（无 tmp 残留、逐次落盘磁盘真相、跨实例持久化）/
// 状态机单向迁移（49 对全矩阵：9 条合法边放行、40 对拒绝 + 播种边 + stale-from 双派拒绝 +
// TypeError）/ engine-owned set（写读持久化幂等 + torn/degraded deny）/ 截断 store 识别
// （unparseable/shape-invalid/run-mismatch/read-error 四种 torn + ENOENT=「无记录」非 torn +
// 撕裂字节原样保留）/ fault.failWrite 三形态（before=盘上旧真相、mid=撕裂文件、after=盘上新真相；
// 调用方三形态同形 {ok:false}、内存不推进、不广播、实例劣化闩）+ 真实写抛错（无 fault）。
//
// T3.4 的 torn-journal 断言（mid 截断 → 新 journal 识别为该步未完成）在此文件起步（S2 期）；
// 「并重跑」的完整四断言属 S6，落 engine-resume.test.mjs。T3.5 的 journal 侧断言
// （写失败→不推进不广播）在此文件；scheduler 侧 S4 落 engine-scheduler.test.mjs。
//
// 夹具全合成（os.tmpdir() 临时目录 + 内存 storage）；replay 录制件属 S7a，本文件不得引用。
// 期望逐行来自规格；实现与规格冲突时改实现，不改这里的期望。
//
// 运行：node plugin/test/engine-journal.test.mjs（assert 失败即抛、非零退出；成功自然退出）
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import {
  JOURNAL_STATES,
  LEGAL_TRANSITIONS,
  createJournal,
  journalStoreStem,
  makeJournalStorage,
  validateJournalRecord,
} from '../src/engine/journal.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- 夹具基座（全合成）----
const ROOT = mkdtempSync(join(tmpdir(), 'reeve-engine-journal-'))
const newDir = () => mkdtempSync(join(ROOT, 'case-'))
/** 可控时钟：首次调用返回 start+step，此后每次 +step（确定性，规格 §6）。 */
const clock = (start = 1000, step = 100) => {
  let t = start
  return () => (t += step)
}
/** 内存 storage：read 初值 null（「无记录」），write 捕获最新文本——纯状态机用，不碰盘。 */
const memStorage = () => {
  let text = null
  return { read: () => text, write: (t) => (text = t) }
}
const readRaw = (storage) => storage.read()

// 合法边集合（从导出表取，测试不复制数字/边）
const LEGAL_PAIRS = new Set()
for (const [from, tos] of Object.entries(LEGAL_TRANSITIONS)) for (const to of tos) LEGAL_PAIRS.add(`${from}->${to}`)

// ---- 0. 构造校验（TypeError = 程序错误，fail-fast）----
console.log('0. 构造与参数校验')
{
  assert.throws(() => createJournal({}), TypeError, '缺 storage 应抛 TypeError')
  assert.throws(() => createJournal({ storage: {} }), TypeError, 'storage 缺 write 应抛')
  assert.throws(() => createJournal({ storage: { read: () => null } }), TypeError, 'storage 缺 read 应抛')
  assert.throws(() => createJournal({ storage: memStorage(), runId: '' }), TypeError, '空 runId 应抛')
  assert.throws(() => createJournal({ storage: memStorage(), runId: 42 }), TypeError, '非字符串 runId 应抛')
  assert.throws(() => createJournal({ storage: memStorage(), runId: 'r', now: 'x' }), TypeError, 'now 非函数应抛')
  assert.throws(() => createJournal({ storage: memStorage(), runId: 'r', onEvent: 'x' }), TypeError, 'onEvent 非函数应抛')
  assert.throws(() => createJournal({ storage: memStorage(), runId: 'r', fault: 'before' }), TypeError, 'fault 非对象应抛')
  assert.throws(() => createJournal({ storage: memStorage(), runId: 'r', fault: { failWrite: 'whenever' } }), TypeError, 'failWrite 非法值应抛')
  // §6 分工：abortAt（scheduler 的）/driverChaos（driver 的）不是 journal 的消费项，静默忽略不炸。
  const j = createJournal({ storage: memStorage(), runId: 'r', fault: { abortAt: ['a'], driverChaos: { timeoutMs: true } } })
  assert.equal(j.status().ok, true, 'fault 带他模块注入键应被忽略')
  // 生产姿态：fault 显式 null 或整个缺省，都正常工作。
  for (const fault of [null, undefined]) {
    const jf = createJournal({ storage: memStorage(), runId: `r-${fault === null ? 'null' : 'absent'}`, fault, now: clock() })
    assert.equal(jf.appendStepState('s', null, 'declared').ok, true, `fault=${String(fault)} 生产姿态可写`)
  }
  // stem 清洗（plan-gate storeStem 同款）与 record 校验器直测。
  assert.equal(journalStoreStem('run/a:b'), 'run_a_b', '路径字符清洗')
  assert.equal(journalStoreStem(`x`.repeat(300)).length, 180, '主干截到 180')
  assert.equal(journalStoreStem('   '), '', '空白 runId → 空主干')
  assert.throws(() => makeJournalStorage(newDir(), '   '), TypeError, '空白 runId 清洗后空主干，拒建 storage')
  const good = { runId: 'r', updatedAt: 1, steps: { s: { state: 'declared', attempts: 0, history: [{ from: null, to: 'declared', at: 1 }] } }, engineSessions: [], events: [] }
  assert.deepEqual(validateJournalRecord(good), good, '合法 record 原样通过')
  assert.equal(validateJournalRecord({ runId: 'r' }), null, '缺字段 → 形状不过')
  assert.equal(validateJournalRecord('x'), null, '非对象 → 形状不过')
  ok('构造校验 12+ 行（storage/runId/now/onEvent/fault 形状 + 他模块注入键忽略 + 生产姿态 + stem + record 校验器）')
}

// ---- 1. 原子写（makeJournalStorage：tmp+rename 落盘，磁盘真相 = 内存真相）----
console.log('1. 原子写（tmp+rename）')
{
  const dir = newDir()
  const storage = makeJournalStorage(dir, 'run-atomic')
  assert.equal(storage.read(), null, 'ENOENT → null（「无记录」基线）')
  const j = createJournal({ storage, runId: 'run-atomic', now: clock() })
  assert.equal(j.appendStepState('read', null, 'declared').ok, true, '播种落盘成功')
  assert.equal(basename(storage.file), 'run-atomic.journal.json', '文件名 = <主干>.journal.json')
  const filesAfter = () => readdirSync(dir)
  assert.deepEqual(filesAfter(), ['run-atomic.journal.json'], '恰好一个文件（无 tmp 残留）')
  for (const [from, to] of [['declared', 'dispatching'], ['dispatching', 'running'], ['running', 'done']]) {
    const r = j.appendStepState('read', from, to, to === 'done' ? { result: { text: 'ok' } } : undefined)
    assert.equal(r.ok, true, `迁移 ${from}→${to} 落盘成功`)
    const onDisk = JSON.parse(readRaw(storage))
    assert.equal(onDisk.steps.read.state, to, `盘上状态随迁移推进（${to}）`)
    assert.deepEqual(filesAfter(), ['run-atomic.journal.json'], `每次迁移后仍恰好一个文件（${to}）`)
    assert.deepEqual(onDisk, JSON.parse(JSON.stringify(onDisk)), '盘上始终是完整可解析 JSON')
  }
  const disk = JSON.parse(readRaw(storage))
  assert.equal(disk.steps.read.attempts, 1, '盘上 attempts=1（含初派）')
  assert.deepEqual(disk.steps.read.history.at(-1).payload, { result: { text: 'ok' } }, 'payload 随迁移持久化')
  // 跨实例持久化：新 journal 从盘上读到同一真相。
  const j2 = createJournal({ storage, runId: 'run-atomic', now: clock() })
  assert.equal(j2.getStepState('read').state, 'done', '新实例读到 done')
  assert.equal(j2.getStepState('read').attempts, 1, '新实例读到 attempts')
  assert.equal(j2.status().fresh, false, '非 fresh（盘上有记录）')
  // 嵌套不存在目录：mkdirSync recursive。
  const deep = makeJournalStorage(join(dir, 'nested', 'deep'), 'run-nested')
  const jd = createJournal({ storage: deep, runId: 'run-nested', now: clock() })
  assert.equal(jd.appendStepState('a', null, 'declared').ok, true, '深目录自动创建并落盘')
  assert.equal(readFileSync(deep.file, 'utf8').includes('"run-nested"'), true, '深目录文件落位')
  ok('原子写：ENOENT 基线 / 恰一文件无 tmp 残留 / 盘上真相比随迁移 / 跨实例持久化 / 深目录自建')
}

// ---- 2. 状态机单向迁移（49 对全矩阵 + 播种边 + stale-from + TypeError）----
console.log('2. 状态机单向迁移')
{
  // 合法链：seed → dispatching → running → 四终态各达一次；dispatching→failed；failed→dispatching（重入）；declared→superseded（未派先废）。
  for (const to of ['done', 'failed', 'blocked', 'superseded']) {
    const j = createJournal({ storage: memStorage(), runId: 'r', now: clock() })
    assert.equal(j.appendStepState('s', null, 'declared').ok, true)
    assert.equal(j.appendStepState('s', 'declared', 'dispatching').ok, true)
    assert.equal(j.appendStepState('s', 'dispatching', 'running').ok, true)
    assert.equal(j.appendStepState('s', 'running', to).ok, true, `running→${to} 放行`)
    assert.equal(j.getStepState('s').state, to, `终态 ${to} 记账`)
  }
  {
    const j = createJournal({ storage: memStorage(), runId: 'r', now: clock() })
    assert.equal(j.appendStepState('a', null, 'declared').ok, true)
    assert.equal(j.appendStepState('a', 'declared', 'superseded').ok, true, 'declared→superseded 放行（未派先废）')
    assert.equal(j.appendStepState('b', null, 'declared').ok, true)
    assert.equal(j.appendStepState('b', 'declared', 'dispatching').ok, true, 'declared→dispatching 放行（初派）')
    assert.equal(j.appendStepState('b', 'dispatching', 'failed').ok, true, 'dispatching→failed 放行（派发即败）')
    assert.equal(j.getStepState('b').attempts, 1, '失败后 attempts 仍 1')
    assert.equal(j.appendStepState('b', 'failed', 'dispatching').ok, true, 'failed→dispatching 放行（attempt 重入边）')
    assert.equal(j.getStepState('b').attempts, 2, '重派 attempts=2（含初派的总次数）')
    assert.ok(j.getStepState('b').lastDispatchAt > 0, '重派刷新 lastDispatchAt（cooldown 取数点）')
  }
  // attempts/lastDispatchAt 只在 →dispatching 时变化。
  {
    const j = createJournal({ storage: memStorage(), runId: 'r', now: clock() })
    j.appendStepState('s', null, 'declared')
    assert.equal(j.getStepState('s').attempts, 0, '播种 attempts=0')
    j.appendStepState('s', 'declared', 'dispatching')
    const ld1 = j.getStepState('s').lastDispatchAt
    j.appendStepState('s', 'dispatching', 'running')
    assert.equal(j.getStepState('s').attempts, 1, '→running 不加 attempts')
    assert.equal(j.getStepState('s').lastDispatchAt, ld1, '→running 保留 lastDispatchAt')
    assert.equal(j.getStepState('s').history.length, 3, 'history 逐迁移累积（播种算一条）')
  }
  // 49 对全矩阵：10 条合法边放行（上面已验 9 条；P4-E 增补 blocked→dispatching 恢复边在本矩阵后单独验），
  // 其余 39 对一律拒（illegal-transition，状态不动，不广播）。
  const WALK = {
    declared: [],
    dispatching: [['declared', 'dispatching']],
    running: [['declared', 'dispatching'], ['dispatching', 'running']],
    failed: [['declared', 'dispatching'], ['dispatching', 'failed']],
    done: [['declared', 'dispatching'], ['dispatching', 'running'], ['running', 'done']],
    blocked: [['declared', 'dispatching'], ['dispatching', 'running'], ['running', 'blocked']],
    superseded: [['declared', 'dispatching'], ['dispatching', 'running'], ['running', 'superseded']],
  }
  let illegalRows = 0
  let broadcastSeen = 0
  for (const current of JOURNAL_STATES) {
    for (const to of JOURNAL_STATES) {
      if (LEGAL_PAIRS.has(`${current}->${to}`)) continue
      const j = createJournal({ storage: memStorage(), runId: 'r', now: clock(), onEvent: () => (broadcastSeen += 1) })
      assert.equal(j.appendStepState('s', null, 'declared').ok, true, `walk ${current} 播种`)
      for (const [f, t] of WALK[current]) assert.equal(j.appendStepState('s', f, t).ok, true, `walk ${current} 经 ${f}→${t}`)
      const seenBefore = broadcastSeen
      const r = j.appendStepState('s', current, to)
      assert.equal(r.ok, false, `拒绝：${current} → ${to}（单向迁移）`)
      assert.equal(r.reason, 'illegal-transition', `拒绝原因：${current} → ${to}`)
      assert.equal(j.getStepState('s').state, current, `拒绝后状态停在 ${current}`)
      assert.equal(broadcastSeen, seenBefore, `拒绝：${current} → ${to} 不广播`)
      illegalRows += 1
    }
  }
  assert.equal(illegalRows, 39, '非法对恰 39（49 − 10 合法：原 9 条 + P4-E 的 blocked→dispatching；每行已各自断言拒绝不广播）')
  // P4-E 恢复边正向：blocked→dispatching 放行（问句答复后重派），attempts/lastDispatchAt 同 failed→dispatching 语义刷新；
  // blocked 的其余去向（done/failed/superseded/…）仍无出边（上面 39 对矩阵已覆盖拒绝面）。
  {
    const j = createJournal({ storage: memStorage(), runId: 'r', now: clock() })
    assert.equal(j.appendStepState('s', null, 'declared').ok, true, '播种 declared')
    for (const [f, t] of [['declared', 'dispatching'], ['dispatching', 'running'], ['running', 'blocked']]) {
      assert.equal(j.appendStepState('s', f, t).ok, true, `走到 blocked 经 ${f}→${t}`)
    }
    assert.equal(j.getStepState('s').attempts, 1, '挂起时 attempts=1（问句那轮的初派）')
    const ld1 = j.getStepState('s').lastDispatchAt
    assert.equal(j.appendStepState('s', 'blocked', 'dispatching').ok, true, 'blocked→dispatching 放行（P4-E 恢复重入边）')
    assert.equal(j.getStepState('s').attempts, 2, '恢复重派 attempts=2（含初派的总次数）')
    assert.ok(j.getStepState('s').lastDispatchAt > ld1, '恢复重派刷新 lastDispatchAt（超时窗口重开）')
    assert.equal(j.appendStepState('s', 'blocked', 'done').ok, false, 'blocked→done 仍拒（恢复只能走重派）')
  }
  // 播种边：null→declared 唯一；null→其余 6 态拒；重复播种拒。
  for (const to of JOURNAL_STATES.filter((s) => s !== 'declared')) {
    const j = createJournal({ storage: memStorage(), runId: 'r', now: clock() })
    const r = j.appendStepState('s', null, to)
    assert.equal(r.ok, false, `拒绝：null → ${to}（未注册步只能播种到 declared）`)
    assert.equal(r.reason, 'illegal-transition', `播种拒绝原因：null → ${to}`)
  }
  {
    const j = createJournal({ storage: memStorage(), runId: 'r', now: clock() })
    j.appendStepState('s', null, 'declared')
    const r = j.appendStepState('s', null, 'declared')
    assert.equal(r.ok, false, '拒绝：重复播种')
    assert.equal(j.getStepState('s').history.length, 1, '重复播种不追加 history')
  }
  // stale-from：from 与记账当前态不符即拒——同 step 第二个 in-flight 无法成立（§1 in-flight 去重）。
  {
    const j = createJournal({ storage: memStorage(), runId: 'r', now: clock() })
    j.appendStepState('s', null, 'declared')
    assert.equal(j.appendStepState('s', 'declared', 'dispatching').ok, true)
    const r1 = j.appendStepState('s', 'declared', 'dispatching')
    assert.equal(r1.ok, false, '双派同边被 stale-from 拒（第二 in-flight 不成立）')
    assert.equal(r1.reason, 'stale-from', '拒绝原因 stale-from')
    const r2 = j.appendStepState('s', 'declared', 'running')
    assert.equal(r2.ok, false, '陈旧 from 的跳步也拒')
    assert.equal(r2.reason, 'stale-from', '跳步拒绝原因 stale-from')
    assert.equal(j.getStepState('s').state, 'dispatching', '状态未被动过')
  }
  // TypeError = 程序错误（形状垃圾），与语义拒绝分轨。
  {
    const j = createJournal({ storage: memStorage(), runId: 'r', now: clock() })
    assert.throws(() => j.appendStepState('', 'declared', 'dispatching'), TypeError, '空 stepId 抛')
    assert.throws(() => j.appendStepState(42, 'declared', 'dispatching'), TypeError, '非字符串 stepId 抛')
    assert.throws(() => j.appendStepState('s', 'declared', 'finished'), TypeError, '未知终态 to 抛')
    assert.throws(() => j.appendStepState('s', 'pending', 'declared'), TypeError, '未知 from 抛')
    assert.throws(() => j.recordEvent(''), TypeError, '空事件 type 抛')
    assert.throws(() => j.recordEvent(42), TypeError, '非字符串事件 type 抛')
    assert.throws(() => j.markEngineSession(''), TypeError, '空 sessionId 抛')
    assert.throws(() => j.getStepState(''), TypeError, '空 stepId 查询抛')
    ok('状态机：4 终态 + 重入边 + 40 对非法全拒 + 播种边唯一 + stale-from 双派拒 + TypeError 分轨')
  }
}

// ---- 3. engine-owned set（持久化、幂等、deny）----
console.log('3. engine-owned set')
{
  const dir = newDir()
  const storage = makeJournalStorage(dir, 'run-own')
  const events = []
  const j = createJournal({ storage, runId: 'run-own', now: clock(), onEvent: (e) => events.push(e) })
  const r = j.markEngineSession('sess_engine_1')
  assert.deepEqual([r.ok, r.added], [true, true], '首次记账 added=true')
  assert.equal(j.isEngineSession('sess_engine_1'), true, '记账后 isEngineSession=true')
  assert.equal(j.isEngineSession('sess_other'), false, '陌生会话 false')
  assert.equal(events.length, 1, '记账广播一次')
  const rawBefore = readRaw(storage)
  const r2 = j.markEngineSession('sess_engine_1')
  assert.deepEqual([r2.ok, r2.added], [true, false], '重复记账幂等 added=false')
  assert.equal(events.length, 1, '幂等不广播')
  assert.equal(readRaw(storage), rawBefore, '幂等不落盘（字节不变）')
  j.markEngineSession('sess_engine_2')
  assert.deepEqual(JSON.parse(readRaw(storage)).engineSessions, ['sess_engine_1', 'sess_engine_2'], '集合持久化在 journal record')
  const j2 = createJournal({ storage, runId: 'run-own', now: clock() })
  assert.equal(j2.isEngineSession('sess_engine_1'), true, '新实例读到 engine-owned set（持久化）')
  // torn → deny（宁可不认自家会话，不可错认）；degraded → deny。
  writeFileSync(storage.file, '{"runId": "run-own", "ste', 'utf8')
  const jt = createJournal({ storage, runId: 'run-own', now: clock() })
  assert.equal(jt.isEngineSession('sess_engine_1'), false, 'torn → isEngineSession=false')
  assert.equal(jt.markEngineSession('sess_x').ok, false, 'torn → 记账拒绝')
  const jd = createJournal({ storage: makeJournalStorage(newDir(), 'run-dg'), runId: 'run-dg', fault: { failWrite: 'before' }, now: clock() })
  jd.appendStepState('s', null, 'declared') // 失败 → 劣化
  assert.equal(jd.isEngineSession('sess_y'), false, 'degraded → isEngineSession=false')
  ok('engine-owned set：记账/幂等不重写不重播/跨实例持久化/torn 与 degraded 一律 deny')
}

// ---- 4. 截断 store 识别（torn = 无记录 = deny；撕裂字节原样保留）----
console.log('4. 截断 store 识别（torn）')
{
  const dir = newDir()
  const storage = makeJournalStorage(dir, 'run-torn')
  const j0 = createJournal({ storage, runId: 'run-torn', now: clock() })
  j0.appendStepState('s', null, 'declared')
  j0.appendStepState('s', 'declared', 'dispatching')
  j0.appendStepState('s', 'dispatching', 'running', { sessionId: 'sess_a' })
  const goodText = readRaw(storage)
  // 4a. unparseable：把完好 record 截一半（与 fault mid 同款撕法）。
  writeFileSync(storage.file, goodText.slice(0, Math.floor(goodText.length / 2)), 'utf8')
  const tornRaw = readRaw(storage)
  const jt = createJournal({ storage, runId: 'run-torn', now: clock() })
  assert.deepEqual([jt.status().ok, jt.status().torn, jt.status().reason], [false, true, 'unparseable'], '截断 → torn/unparseable')
  assert.equal(jt.getStepState('s'), null, 'T3.4-torn：截断 journal 里进行中的步识别为未完成（null）')
  assert.equal(jt.listSteps(), null, 'torn → listSteps=null（不是空对象）')
  assert.equal(jt.isEngineSession('sess_a'), false, 'torn → engine-owned 全不认')
  const rm = jt.appendStepState('s', 'running', 'done')
  assert.deepEqual([rm.ok, rm.torn], [false, true], 'torn → 迁移拒绝')
  assert.equal(jt.recordEvent('x').ok, false, 'torn → 事件拒绝')
  assert.equal(jt.markEngineSession('sess_b').ok, false, 'torn → 记账拒绝')
  assert.equal(readRaw(storage), tornRaw, 'torn 后一切写入被拒：撕裂字节原样保留')
  // 4b. shape-invalid：可解析但形状不过。
  writeFileSync(storage.file, JSON.stringify({ runId: 'run-torn', steps: 'nope' }), 'utf8')
  const js = createJournal({ storage, runId: 'run-torn', now: clock() })
  assert.equal(js.status().reason, 'shape-invalid', '形状不过 → shape-invalid')
  // 4c. runId 不符：盘上是合法 record，但 runId 与打开者不符（同 storage 换 runId 打开）。
  writeFileSync(storage.file, JSON.stringify({ runId: 'run-torn', updatedAt: 1, steps: {}, engineSessions: [], events: [] }), 'utf8')
  const jm = createJournal({ storage, runId: 'run-other', now: clock() })
  assert.equal(jm.status().reason, 'run-mismatch', 'runId 不符 → run-mismatch')
  // 4d. 读盘抛错（非 ENOENT）→ read-error（plan-gate §7 同款拦截方向收敛）。
  const je = createJournal({ storage: { read: () => { throw new Error('EACCES: fake') }, write: () => {} }, runId: 'r', now: clock() })
  assert.equal(je.status().reason, 'read-error', '读盘抛错 → read-error')
  assert.equal(je.appendStepState('s', null, 'declared').ok, false, 'read-error → 写拒')
  // 4e. ENOENT = 「无记录」基线，不是 torn：fresh 起步、可写。
  const jf = createJournal({ storage: makeJournalStorage(newDir(), 'run-fresh'), runId: 'run-fresh', now: clock() })
  assert.deepEqual([jf.status().ok, jf.status().fresh, jf.status().torn], [true, true, false], '无记录 = fresh 非 torn')
  assert.deepEqual(jf.listSteps(), {}, 'fresh listSteps 是空对象（torn 才是 null）')
  assert.equal(jf.appendStepState('s', null, 'declared').ok, true, 'fresh 可播种')
  // 原型链键不误报（constructor 等继承键不当成步）。
  assert.equal(jf.getStepState('constructor'), null, '继承键查询 → null')
  // record payload 完整回流（resume 的取数口径）。
  const jp = createJournal({ storage: memStorage(), runId: 'r', now: clock() })
  jp.appendStepState('s', null, 'declared')
  jp.appendStepState('s', 'declared', 'dispatching')
  jp.appendStepState('s', 'dispatching', 'running')
  jp.appendStepState('s', 'running', 'done', { result: { text: '完稿' }, sessionId: 'sess_z' })
  const last = jp.getStepState('s').history.at(-1)
  assert.deepEqual(last.payload, { result: { text: '完稿' }, sessionId: 'sess_z' }, 'done payload 存于 history 尾条')
  assert.deepEqual(jp.getStepState('s').history.at(-1).payload, jp.getStepState('s').history.at(-1).payload, 'getStepState 返回可用的 history 副本')
  assert.deepEqual(
    jp.listSteps(),
    { s: { state: 'done', attempts: 1, lastDispatchAt: jp.getStepState('s').lastDispatchAt } },
    'listSteps 全步快照（state/attempts/lastDispatchAt）',
  )
  ok('torn 识别：unparseable/shape-invalid/run-mismatch/read-error 四路 + ENOENT=非 torn + 字节保留 + payload 回流')
}

// ---- 5. fault.failWrite 三形态（T3.4 torn 半边 + T3.5 journal 侧）----
console.log('5. fault.failWrite 三形态')
for (const form of ['before', 'mid', 'after']) {
  const dir = newDir()
  const storage = makeJournalStorage(dir, `run-fault-${form}`)
  // 前史（无 fault）：跑到一个进行中步 + 记账一个 engine 会话——崩溃发生在有状态之后才有意义。
  const j1 = createJournal({ storage, runId: `run-fault-${form}`, now: clock() })
  j1.appendStepState('critic', null, 'declared')
  j1.appendStepState('critic', 'declared', 'dispatching')
  j1.appendStepState('critic', 'dispatching', 'running', { sessionId: 'sess_e1' })
  j1.markEngineSession('sess_e1')
  const preRaw = readRaw(storage)
  // 故障实例：试图 running→done，调用方拿到的 {ok:false} 三形态同形。
  const seen = []
  const j2 = createJournal({ storage, runId: `run-fault-${form}`, fault: { failWrite: form }, now: clock(), onEvent: (e) => seen.push(e) })
  const r = j2.appendStepState('critic', 'running', 'done', { result: { text: 'x' } })
  assert.equal(r.ok, false, `[${form}] 调用返回 not-ok`)
  assert.equal(r.reason, 'fault-failWrite', `[${form}] 原因 fault-failWrite`)
  assert.equal(r.form, form, `[${form}] 回带形态`)
  assert.equal(seen.length, 0, `[${form}] 不广播（T3.5 journal 侧）`)
  assert.equal(j2.getStepState('critic'), null, `[${form}] 劣化实例读数作废（内存不推进）`)
  assert.deepEqual([j2.status().ok, j2.status().degraded, j2.status().reason], [false, true, 'degraded'], `[${form}] status 报 degraded`)
  // 劣化闩：后续一切写都被拒（陈旧内存绝不允许覆盖盘）。
  assert.equal(j2.recordEvent('retry').reason, 'degraded', `[${form}] 劣化后事件拒`)
  assert.equal(j2.appendStepState('critic', 'running', 'done').reason, 'degraded', `[${form}] 劣化后迁移拒`)
  // 盘上真相三态分叉。
  const j3 = createJournal({ storage, runId: `run-fault-${form}`, now: clock() })
  if (form === 'before') {
    assert.equal(readRaw(storage), preRaw, '[before] 盘上字节未动')
    assert.equal(j3.getStepState('critic').state, 'running', '[before] 新实例读到旧真相（完好）')
    assert.equal(j3.isEngineSession('sess_e1'), true, '[before] 前史完整可读')
  } else if (form === 'mid') {
    const tornRaw = readRaw(storage)
    assert.ok(tornRaw.length > 0 && tornRaw.length < preRaw.length, '[mid] 盘上是截断的一半')
    assert.throws(() => JSON.parse(tornRaw), SyntaxError, '[mid] 盘上是撕裂 JSON')
    assert.deepEqual([j3.status().torn, j3.status().reason], [true, 'unparseable'], '[mid] 新实例识别 torn')
    assert.equal(j3.getStepState('critic'), null, '[mid] T3.4：截断 journal 识别为该步未完成（完整「并重跑」断言 S6 落 resume）')
    assert.equal(j3.listSteps(), null, '[mid] torn → listSteps=null')
    const rr = j3.appendStepState('critic', 'running', 'done')
    assert.deepEqual([rr.ok, rr.torn], [false, true], '[mid] torn 实例写入拒绝')
    assert.equal(readRaw(storage), tornRaw, '[mid] 撕裂字节保留')
  } else {
    const step = j3.getStepState('critic')
    assert.equal(step.state, 'done', '[after] 盘上已是新真相（重读即得，无需重放）')
    assert.deepEqual(step.history.at(-1).payload, { result: { text: 'x' } }, '[after] 新真相含 payload')
    assert.equal(j3.status().ok, true, '[after] 新实例健康（盘上记录完好）')
  }
  ok(`failWrite=${form}：{ok:false} 同形 / 不广播 / 内存不推进 / 劣化闩 / 盘上${
    form === 'before' ? '旧真相完好' : form === 'mid' ? '撕裂（T3.4-torn 识别）' : '新真相（重读即得）'
  }`)
}
{
  // 非迁移类操作同样吃 fault（before 最简形态抽查），且盘上不动。
  const dir = newDir()
  const storage = makeJournalStorage(dir, 'run-fault-misc')
  const j1 = createJournal({ storage, runId: 'run-fault-misc', now: clock() })
  j1.appendStepState('s', null, 'declared')
  const preRaw = readRaw(storage)
  const j2 = createJournal({ storage, runId: 'run-fault-misc', fault: { failWrite: 'before' }, now: clock() })
  assert.equal(j2.recordEvent('probe-skip', { agent: 'x' }).ok, false, 'recordEvent 吃 fault')
  assert.equal(j2.markEngineSession('sess_q').ok, false, 'markEngineSession 吃 fault')
  assert.equal(readRaw(storage), preRaw, '[before] recordEvent/mark 也不动盘')
  // 真实写抛错（无 fault 注入）：T3.5 的另一来源——storage.write 抛错同样不推进不广播。
  const throwing = { read: () => null, write: () => { throw new Error('ENOSPC: no space left on device') } }
  const seen = []
  const j3 = createJournal({ storage: throwing, runId: 'run-throw', now: clock(), onEvent: (e) => seen.push(e) })
  const r = j3.appendStepState('s', null, 'declared')
  assert.equal(r.ok, false, '写抛错 → not-ok')
  assert.ok(r.error.includes('ENOSPC'), `错误原样回带（${r.error}）`)
  assert.equal(seen.length, 0, '写抛错不广播')
  assert.equal(j3.status().reason, 'degraded', '写抛错 → 劣化')
  assert.equal(j3.recordEvent('x').reason, 'degraded', '劣化闩对真实写抛错同样生效')
  ok('fault 对 record/mark 同样生效 + 真实写抛错（ENOSPC）同收敛')
}

// ---- 6. 先落盘再广播（顺序证据；广播异常不回滚）----
console.log('6. 先落盘再广播')
{
  const order = []
  const storage = {
    read: () => null,
    write: () => order.push('write'),
  }
  const j = createJournal({
    storage,
    runId: 'run-order',
    now: clock(),
    onEvent: (e) => order.push(`broadcast:${e.kind}`),
  })
  j.appendStepState('s', null, 'declared')
  j.appendStepState('s', 'declared', 'dispatching')
  j.recordEvent('probe-pass')
  j.markEngineSession('sess_1')
  assert.deepEqual(order, ['write', 'broadcast:step-state', 'write', 'broadcast:step-state', 'write', 'broadcast:record', 'write', 'broadcast:engine-session'], '每次成功操作严格 先write后broadcast')
  // 广播监听方抛错：持久化已成功，不回滚、调用仍 ok。
  const j2 = createJournal({
    storage: memStorage(),
    runId: 'run-boom',
    now: clock(),
    onEvent: () => {
      throw new Error('panel down')
    },
  })
  const r = j2.appendStepState('s', null, 'declared')
  assert.equal(r.ok, true, '广播抛错不改变调用结果')
  assert.equal(j2.getStepState('s').state, 'declared', '广播抛错不回滚内存')
  ok('先落盘再广播（四类操作顺序全对）+ 广播异常不回滚')
}

// ---- 7. clock 注入（§6：now 经构造参数，默认 Date.now）----
console.log('7. clock 注入')
{
  let t = 5000
  const now = () => (t += 100)
  const j = createJournal({ storage: memStorage(), runId: 'run-clock', now })
  const at1 = j.appendStepState('s', null, 'declared').at
  const r2 = j.appendStepState('s', 'declared', 'dispatching')
  const at2 = r2.at
  // 构造即取一次时钟（fresh record 的 updatedAt=5100），播种 5200、初派 5300。
  assert.deepEqual([at1, at2], [5200, 5300], 'at 严格跟注入时钟')
  assert.equal(j.getStepState('s').lastDispatchAt, 5300, 'lastDispatchAt 跟注入时钟')
  assert.equal(j.status().updatedAt, 5300, `updatedAt 跟注入时钟（${j.status().updatedAt}）`)
  const evAt = j.recordEvent('tick').at
  assert.equal(evAt, 5400, 'recordEvent at 跟注入时钟')
  // 默认时钟：Date.now。
  const jd = createJournal({ storage: memStorage(), runId: 'run-now' })
  const before = Date.now()
  const at = jd.appendStepState('s', null, 'declared').at
  assert.ok(Number.isInteger(at) && at >= before && at <= Date.now(), `缺省 now = Date.now（${at} ∈ [${before}, ${Date.now()}]）`)
  ok('clock 注入：at/lastDispatchAt/updatedAt/事件 at 全走注入时钟；缺省回 Date.now')
}

console.log(`\n引擎 journal 测试（S2 门：T3.4-torn 半边 + T3.5 journal 侧）：${passed} 项全过`)
