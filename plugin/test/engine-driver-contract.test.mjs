// E1 引擎 driver 契约测试（S3；施工规格 .zcode/plans/e1-construction-spec.md §4-S3 / §5-T3.6 前半；
// replay 真件半边在 M1.3b/c 补全）。
//
// 范围：mock 侧全量 + replay 加载器半边（合成录制件）+ **replay 真件半边**（§12，M1.3b/c 补全）。
// T3.6 的「双实现对同一场景行为一致」分两步证：
//   §10a 合成场景集 × {mock, replay}（结构一致，形状刻意不似会话记录）；
//   §12 真机录制件（fixtures/engine/replay/<最新日期>/，只读）× {mock, replay}——真实 prompt/
//   sessionId/context 形状下同一操作序列行为与 calls 全等。真件只读：本文件不创建、不修改
//   fixtures/engine/replay/（录制件由 S7a/M1.3b/c 真机产生；真件缺席时 §12 如实跳过，两时序都绿）。
//
// 钉死的契约面：
//   接口   create/{result,context}/close/calls（assertDriverFace）；
//   calls  { seq, op, at, args, sessionId?|response?|error? }——T3.4「零 create 调用」取数口径；
//   chaos  fault.driverChaos 三态的确定性语义（超时=全拒不推进；半响应=剥字段；重复回调=新应答立即再投）；
//   model  {providerID, id, variant?} 直传（calls.args.model 深等于入参），约束从 declaration.schema.json 取；
//   replay 录制件格式 {version:1, recordedAt?, host?, note?, scenarios[]} + 空目录容错 + 坏件拒载。
//
// 期望逐行来自规格 §3/§6 与本文件钉死的契约；实现与契约冲突时改实现，不改期望。
// 运行：node plugin/test/engine-driver-contract.test.mjs（assert 失败即抛、非零退出；成功自然退出）
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_REPLAY_ROOT,
  DRIVER_ERROR_CODES,
  DRIVER_KINDS,
  DRIVER_RESULT_STATUS,
  RECORDING_FILE_FIELDS,
  SCENARIO_VERSION,
  assertDriverFace,
  createDriver,
  loadReplayScenarios,
  validateCreateArgs,
  validateScenarioSet,
} from '../src/engine/driver.js'
import { DECLARATION_SCHEMA } from '../src/engine/declaration.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- 时钟与异常捕获（确定性：不依赖真实时间，错误只认 code）----
const mkClock = (start = 1_700_000_000_000) => {
  let t = start
  return () => (t += 50)
}
const caught = async (p) => {
  try {
    return { value: await p }
  } catch (e) {
    return { code: e.code }
  }
}

// ---- 共享场景集（同一场景集 × {mock, replay} 的"场景集"；全合成，形状刻意不似会话记录——§2-2 不假设真实 context 形状）----
const SHARED_SCENARIOS = () => [
  {
    name: 'read',
    match: { prompt: '第一步：读材料' },
    sessionId: 'sess_rec_read_01',
    result: [{ status: 'running' }, { status: 'done', text: '材料读完：3 份' }],
    context: [{ note: '合成占位——真实形状待 S7a 录制', parts: ['a', 'b'] }],
  },
  {
    name: 'critic',
    match: { prompt: '第二步：出判词', agent: 'reeve-critic', model: { providerID: 'zhipuai', id: 'glm-5.3', variant: 'role-critic' } },
    sessionId: 'sess_rec_critic_01',
    result: [{ status: 'done', text: '{"verdict":"通过"}' }],
    context: [{ note: '合成占位', wrapped: { deep: [1, 2, { x: null }] } }],
  },
  {
    name: 'flaky',
    match: { prompt: '第三步：落笔' },
    sessionId: 'sess_rec_flaky_01',
    result: [{ status: 'failed', errorPart: 'LLM 超时' }, { status: 'done', text: '落笔完成' }],
    // 无 context：两侧 context() 都应拒（E1_DRIVER_NO_CONTEXT），行为一致
  },
]

/** 对 driver 施同一操作序列（含异常路径），收集 [{标签, {value|code}}]——双实现比对用。 */
async function driveShared(d) {
  const out = []
  out.push(['create.read', await caught(d.create({ title: 'REEVE-E1 run-t36 read', prompt: '第一步：读材料' }))])
  out.push(['create.critic', await caught(d.create({ title: 'REEVE-E1 run-t36 critic', prompt: '第二步：出判词', agent: 'reeve-critic', model: { providerID: 'zhipuai', id: 'glm-5.3', variant: 'role-critic' } }))])
  out.push(['create.write', await caught(d.create({ title: 'REEVE-E1 run-t36 write', prompt: '第三步：落笔' }))])
  out.push(['result.read#1', await caught(d.result('sess_rec_read_01'))])
  out.push(['result.read#2', await caught(d.result('sess_rec_read_01'))])
  out.push(['context.read', await caught(d.context('sess_rec_read_01'))])
  out.push(['result.critic', await caught(d.result('sess_rec_critic_01'))])
  out.push(['context.critic', await caught(d.context('sess_rec_critic_01'))])
  out.push(['result.flaky#1', await caught(d.result('sess_rec_flaky_01'))])
  out.push(['result.flaky#2', await caught(d.result('sess_rec_flaky_01'))])
  out.push(['result.unknown', await caught(d.result('sess_nope'))])
  out.push(['context.flaky', await caught(d.context('sess_rec_flaky_01'))])
  out.push(['create.nomatch', await caught(d.create({ title: 'T', prompt: '没有这场景' }))])
  return out
}

// ---- 1. 常量面（契约钉住）----
{
  assert.deepEqual([...DRIVER_KINDS], ['mock', 'replay'], '本文件只管 mock/replay；生产 session 归 S7b')
  assert.deepEqual([...DRIVER_RESULT_STATUS], ['running', 'done', 'failed'], 'result.status 三值')
  assert.equal(SCENARIO_VERSION, 1, '录制件格式版本')
  assert.deepEqual([...RECORDING_FILE_FIELDS], ['version', 'recordedAt', 'host', 'note', 'scenarios'], '录制件顶层允许字段')
  for (const code of ['E1_DRIVER_CLOSED', 'E1_DRIVER_BAD_ARGS', 'E1_DRIVER_UNKNOWN_SESSION', 'E1_DRIVER_NO_CONTEXT', 'E1_DRIVER_NO_SCENARIO', 'E1_DRIVER_REPLAY_FORMAT', 'E1_DRIVER_SCENARIO_INVALID', 'E1_DRIVER_CHAOS_TIMEOUT']) {
    assert.ok(DRIVER_ERROR_CODES.includes(code), `错误码清单应含 ${code}`)
  }
  assert.equal(
    DEFAULT_REPLAY_ROOT.replaceAll('\\', '/').endsWith('plugin/test/fixtures/engine/replay'),
    true,
    `replay 缺省根指向 plugin/test/fixtures/engine/replay（实际 ${DEFAULT_REPLAY_ROOT}）`,
  )
  ok('常量面：kinds/status/版本/录制件字段/错误码/缺省根路径')
}

// ---- 2. 接口面（assertDriverFace）----
{
  const mock = createDriver('mock', { scenarios: SHARED_SCENARIOS(), now: mkClock() })
  assertDriverFace(mock, 'mock', { requireCalls: true })
  assert.equal(mock.kind, 'mock', 'mock driver 自报 kind')
  assert.equal(typeof mock.close, 'function', 'close 在面上（规格标 close?，两实现都给）')
  ok('mock 驱动面完整（create/result/context/close/calls）')

  assert.throws(() => assertDriverFace({}, '空对象'), (e) => e.code === 'E1_DRIVER_BAD_ARGS' && /缺驱动面 create, result, context/.test(e.message), '空对象缺三操作应拒')
  assert.throws(() => assertDriverFace({ create() {}, result() {}, close() {} }, '缺 context'), (e) => /缺驱动面 context/.test(e.message), '缺 context 应拒')
  assert.throws(() => assertDriverFace({ create() {}, result() {}, context() {}, close: 1 }, 'close 非函数'), (e) => /close\(非函数\)/.test(e.message), 'close 非函数应拒')
  assert.throws(() => assertDriverFace({ create() {}, result() {}, context() {} }, '缺 calls', { requireCalls: true }), (e) => /calls\(数组\)/.test(e.message), 'requireCalls 时缺 calls 应拒')
  assert.doesNotThrow(() => assertDriverFace({ create() {}, result() {}, context() {} }, '无 calls 也可'), '不要求 calls 时无 calls 合法（规格把 calls 钉在 mock，面本身不强制）')
  ok('assertDriverFace 负臂（空对象/缺 context/close 非函数/缺 calls）')
}

// ---- 3. mock 场景消费 ----
{
  const d = createDriver('mock', { scenarios: SHARED_SCENARIOS(), now: mkClock() })

  const c1 = await d.create({ title: 'REEVE-E1 run read', prompt: '第一步：读材料' })
  assert.deepEqual(c1, { sessionId: 'sess_rec_read_01' }, 'create 返回恰 {sessionId}（场景给的定值）')

  assert.deepEqual(await d.result('sess_rec_read_01'), { status: 'running' }, '脚本第 1 条：running（无多余键）')
  assert.deepEqual(await d.result('sess_rec_read_01'), { status: 'done', text: '材料读完：3 份' }, '脚本第 2 条：done+text')
  assert.deepEqual(await d.result('sess_rec_read_01'), { status: 'done', text: '材料读完：3 份' }, '末项粘滞：耗尽后重复最后一条')
  ok('result 脚本消费：逐项前进 + 末项粘滞')

  assert.deepEqual(await d.context('sess_rec_read_01'), { note: '合成占位——真实形状待 S7a 录制', parts: ['a', 'b'] }, 'context 原样返回脚本形状')
  const ctx = await d.context('sess_rec_read_01')
  ctx.parts.push('篡改')
  ctx.note = '篡改'
  const fresh = await d.context('sess_rec_read_01')
  assert.deepEqual(fresh, { note: '合成占位——真实形状待 S7a 录制', parts: ['a', 'b'] }, '返回深拷贝：调用方篡改不污染脚本')
  ok('context 原样返回 + 深拷贝隔离')

  const c2 = await d.create({ title: 'REEVE-E1 run critic', prompt: '第二步：出判词', agent: 'reeve-critic', model: { providerID: 'zhipuai', id: 'glm-5.3', variant: 'role-critic' } })
  assert.deepEqual(c2, { sessionId: 'sess_rec_critic_01' }, 'critic 场景匹配（match 含 agent/model 约束）')
  const rec = d.calls.find((r) => r.op === 'create' && r.args.prompt === '第二步：出判词')
  assert.deepEqual(rec.args.model, { providerID: 'zhipuai', id: 'glm-5.3', variant: 'role-critic' }, 'model 零转换直传：calls.args.model 深等于入参')
  assert.equal(rec.args.agent, 'reeve-critic', 'agent 直传')
  assert.deepEqual(await d.result('sess_rec_critic_01'), { status: 'done', text: '{"verdict":"通过"}' }, 'critic 应答')
  ok('agent/model 直传（calls 里可取证）')

  assert.deepEqual(await d.create({ title: 'REEVE-E1 run write', prompt: '第三步：落笔' }), { sessionId: 'sess_rec_flaky_01' }, 'flaky 场景（无 agent/model 约束的 match）')
  assert.deepEqual(await d.result('sess_rec_flaky_01'), { status: 'failed', errorPart: 'LLM 超时' }, 'failed 应答带 errorPart')
  assert.deepEqual(await d.result('sess_rec_flaky_01'), { status: 'done', text: '落笔完成' }, 'flaky 第二条：done')
  ok('failed→done 两态脚本')

  assert.deepEqual(await caught(d.context('sess_rec_flaky_01')), { code: 'E1_DRIVER_NO_CONTEXT' }, '场景未脚本化 context → 拒（§2-2 mock 不假设形状）')
  const e = await d.context('sess_rec_flaky_01').then(() => null, (err) => err)
  assert.match(e.message, /不假设/, '拒绝文案点名"不假设"')
  assert.deepEqual(await caught(d.result('sess_nope')), { code: 'E1_DRIVER_UNKNOWN_SESSION' }, '未知 sessionId → 拒')
  assert.deepEqual(await caught(d.create({ title: 'T', prompt: '没有这场景' })), { code: 'E1_DRIVER_NO_SCENARIO' }, '无匹配场景 → 严格拒（不做默认 done 掩护）')
  ok('负路径：未脚本化 context / 未知会话 / 无匹配场景')

  const again = await d.create({ title: 'REEVE-E1 run read', prompt: '第一步：读材料' })
  assert.deepEqual(again, { sessionId: 'sess_rec_read_01' }, '场景 sessionId 是定值：同参数 create 返回同一 id')
  assert.deepEqual(await d.result('sess_rec_read_01'), { status: 'running' }, '重复 create 重置消费进度：脚本从头再来')
  ok('同参数重复 create：同 sessionId + 进度重置')
}

// ---- 4. mock 合成 sessionId（场景缺 sessionId 时）----
{
  const d = createDriver('mock', {
    scenarios: [{ name: 'anon', match: { prompt: 'P' }, result: [{ status: 'done', text: 'ok' }] }],
    now: mkClock(),
  })
  const a = await d.create({ title: 'T1', prompt: 'P' })
  const b = await d.create({ title: 'T2', prompt: 'P' })
  assert.deepEqual(a, { sessionId: 'sess_mock_1' }, '合成 id 从 1 递增')
  assert.deepEqual(b, { sessionId: 'sess_mock_2' }, '第二次 create 得独立会话')
  assert.deepEqual(await d.result('sess_mock_1'), { status: 'done', text: 'ok' }, '会话 1 消费自己进度')
  assert.deepEqual(await d.result('sess_mock_2'), { status: 'done', text: 'ok' }, '会话 2 独立消费（不互串）')
  ok('合成 sessionId：sess_mock_<n> 独立会话互不串')
}

// ---- 5. calls 记录格式（钉死：T3.4 从这里取数）----
{
  let t = 1000
  const d = createDriver('mock', {
    scenarios: [{ name: 'one', match: { prompt: 'P' }, sessionId: 'sess_x', result: [{ status: 'running' }, { status: 'done', text: 'T' }], context: [{ note: 'n' }] }],
    now: () => (t += 10),
  })
  await d.create({ title: 'T', prompt: 'P', model: { providerID: 'zhipuai', id: 'glm' } })
  await d.result('sess_x')
  await d.context('sess_x')
  assert.deepEqual(d.calls, [
    { seq: 1, op: 'create', at: 1010, args: { title: 'T', prompt: 'P', model: { providerID: 'zhipuai', id: 'glm' } }, sessionId: 'sess_x' },
    { seq: 2, op: 'result', at: 1020, args: { sessionId: 'sess_x' }, response: { status: 'running' } },
    { seq: 3, op: 'context', at: 1030, args: { sessionId: 'sess_x' }, response: { note: 'n' } },
  ], 'calls 记录形状逐字段钉死（seq/op/at/args/sessionId|response）')
  assert.equal(d.calls.filter((r) => r.op === 'create').length, 1, 'T3.4 取数口径：calls.filter(op === "create") 可用')

  await caught(d.create({ title: 'T', prompt: '没这场景' }))
  assert.deepEqual(d.calls[3], { seq: 4, op: 'create', at: 1040, args: { title: 'T', prompt: '没这场景' }, error: 'E1_DRIVER_NO_SCENARIO' }, '失败调用也入账：error 只记 code（不记 message，双实现可深比对）')
  assert.equal('sessionId' in d.calls[3], false, '失败的 create 无 sessionId 键')
  ok('calls：成功/失败逐次记录，error 只记 code')
}

// ---- 6. create 参数校验（表驱动；model 约束从 schema 取）----
{
  const mk = () => createDriver('mock', { scenarios: [{ name: 's', match: { prompt: 'P' }, result: [{ status: 'done', text: 'ok' }] }], now: mkClock() })
  const bad = (args) => caught(mk().create(args))
  const CASES = [
    { name: '参数非对象', args: 42, match: [/create 参数: 必须是对象/] },
    { name: '缺 title', args: { prompt: 'P' }, match: [/create\.title: 必须是非空字符串/] },
    { name: '缺 prompt', args: { title: 'T' }, match: [/create\.prompt: 必须是非空字符串/] },
    { name: 'title 空串', args: { title: '', prompt: 'P' }, match: [/create\.title: 必须是非空字符串/] },
    { name: 'prompt 非字符串', args: { title: 'T', prompt: 1 }, match: [/create\.prompt: 必须是非空字符串/] },
    { name: '未知字段', args: { title: 'T', prompt: 'P', temperature: 0.7 }, match: [/create: 未知字段 "temperature"/] },
    { name: 'agent 空串', args: { title: 'T', prompt: 'P', agent: '' }, match: [/create\.agent: 必须是非空字符串/] },
    { name: 'agent 非字符串', args: { title: 'T', prompt: 'P', agent: 7 }, match: [/create\.agent: 必须是非空字符串/] },
    { name: 'model 非对象', args: { title: 'T', prompt: 'P', model: 'glm' }, match: [/create\.model: 必须是对象/] },
    { name: 'model 缺 providerID', args: { title: 'T', prompt: 'P', model: { id: 'glm' } }, match: [/create\.model: 缺失必填字段 "providerID"/] },
    { name: 'model 缺 id', args: { title: 'T', prompt: 'P', model: { providerID: 'zhipuai' } }, match: [/create\.model: 缺失必填字段 "id"/] },
    { name: 'model.variant null', args: { title: 'T', prompt: 'P', model: { providerID: 'z', id: 'g', variant: null } }, match: [/create\.model\.variant: 必须是字符串/] },
    { name: 'model.providerID 非字符串', args: { title: 'T', prompt: 'P', model: { providerID: 1, id: 'g' } }, match: [/create\.model\.providerID: 必须是字符串/] },
  ]
  for (const c of CASES) {
    const MODEL_NODE = DECLARATION_SCHEMA.properties.steps.items.properties.model
    const dynamic = c.name === '未知字段'
      ? { title: 'T', prompt: 'P', model: { providerID: 'z', id: 'g', __zzz__: 1 } }
      : c.args
    if (c.name === '未知字段') c.match = [/create\.model: 未知字段 "__zzz__"/, new RegExp(`允许：${Object.keys(MODEL_NODE.properties).join(', ')}`)]
    const r = await bad(dynamic)
    assert.deepEqual(r, { code: 'E1_DRIVER_BAD_ARGS' }, `${c.name}：应拒为 BAD_ARGS`)
    ok(`create 拒：${c.name}`)
  }

  // 允许面：model 无 variant；派生 prompt 不受声明 8000 上限管（上限是声明校验器的事）
  const long = 'x'.repeat(DECLARATION_SCHEMA.properties.steps.items.properties.prompt.maxLength + 1)
  const d = createDriver('mock', { scenarios: [{ name: 'long', match: { prompt: long }, result: [{ status: 'done', text: 'ok' }] }], now: mkClock() })
  assert.deepEqual(await d.create({ title: 'T', prompt: long }), { sessionId: 'sess_mock_1' }, '8001 字符派生 prompt 合法（driver 不复制声明上限）')
  const v = validateCreateArgs({ title: 'T', prompt: 'P', model: { providerID: 'z', id: 'g' } })
  assert.deepEqual(v, { ok: true, errors: [] }, 'validateCreateArgs 通过行')
  ok('create 允许面：model 无 variant / 派生 prompt 超 8000 不归 driver 管')

  // result/context 的参数校验
  assert.deepEqual(await caught(d.result(42)), { code: 'E1_DRIVER_BAD_ARGS' }, 'result(42) 拒')
  assert.deepEqual(await caught(d.result('')), { code: 'E1_DRIVER_BAD_ARGS' }, 'result("") 拒')
  assert.deepEqual(await caught(d.context(undefined)), { code: 'E1_DRIVER_BAD_ARGS' }, 'context(undefined) 拒')
  ok('result/context 参数校验')
}

// ---- 7. chaos 三态（确定性语义）----
{
  // 7a. timeoutMs：每次调用 reject，不推进、不建会话
  {
    const d = createDriver('mock', { scenarios: SHARED_SCENARIOS(), now: mkClock(), fault: { driverChaos: { timeoutMs: true } } })
    assert.deepEqual(await caught(d.create({ title: 'T', prompt: '第一步：读材料' })), { code: 'E1_DRIVER_CHAOS_TIMEOUT' }, 'create 超时 chaos')
    assert.deepEqual(await caught(d.result('sess_rec_read_01')), { code: 'E1_DRIVER_CHAOS_TIMEOUT' }, 'result 超时 chaos')
    assert.deepEqual(await caught(d.context('sess_rec_read_01')), { code: 'E1_DRIVER_CHAOS_TIMEOUT' }, 'context 超时 chaos')
    const rec = d.calls.find((r) => r.op === 'create')
    assert.equal(rec.error, 'E1_DRIVER_CHAOS_TIMEOUT', 'chaos 拒绝入账 error code')
    assert.equal('sessionId' in rec, false, 'chaos 下的 create 不产生 sessionId')
    ok('chaos.timeoutMs：三操作全拒 + 调用入账')
  }
  // 7b. halfResponse：result 剥成 {status}，context 回 {}，游标照常推进
  {
    const d = createDriver('mock', { scenarios: SHARED_SCENARIOS(), now: mkClock(), fault: { driverChaos: { halfResponse: true } } })
    await d.create({ title: 'T', prompt: '第一步：读材料' })
    assert.deepEqual(await d.result('sess_rec_read_01'), { status: 'running' }, '半响应第 1 条：只留 status')
    const r2 = await d.result('sess_rec_read_01')
    assert.deepEqual(r2, { status: 'done' }, '半响应第 2 条：text 被剥')
    assert.equal('text' in r2, false, 'done 应答无 text 键（不是 undefined 值）')
    assert.deepEqual(await d.context('sess_rec_read_01'), {}, '半响应 context：空对象（不发明字段名）')
    ok('chaos.halfResponse：剥字段 + 游标推进')
  }
  // 7c. duplicateCallback：每个新应答首次送达后立即原样再投一次
  {
    const d = createDriver('mock', {
      scenarios: [{ name: 'dup', match: { prompt: 'P' }, sessionId: 's1', result: [{ status: 'done', text: 'A' }, { status: 'failed', errorPart: 'B' }] }],
      now: mkClock(),
      fault: { driverChaos: { duplicateCallback: true } },
    })
    await d.create({ title: 'T', prompt: 'P' })
    const seq = []
    for (let i = 0; i < 5; i++) {
      const r = await d.result('s1')
      seq.push(r.status === 'done' ? `done:${r.text}` : `failed:${r.errorPart}`)
    }
    assert.deepEqual(seq, ['done:A', 'done:A', 'failed:B', 'failed:B', 'failed:B'], '脚本 [A,B] 在重复回调下变 A,A,B,B,B（末项粘滞不变）')
    ok('chaos.duplicateCallback：新应答立即二次投递')
  }
  // 7d. 无 chaos 时同场景行为不受影响（fault: null 即生产形态）
  {
    const d = createDriver('mock', { scenarios: SHARED_SCENARIOS(), now: mkClock(), fault: null })
    await d.create({ title: 'T', prompt: '第一步：读材料' })
    assert.deepEqual(await d.result('sess_rec_read_01'), { status: 'running' }, 'fault:null → 原样应答')
    ok('fault:null（生产形态）无 chaos')
  }
}

// ---- 8. close ----
{
  const d = createDriver('mock', { scenarios: SHARED_SCENARIOS(), now: mkClock() })
  await d.create({ title: 'T', prompt: '第一步：读材料' })
  assert.equal(d.close(), undefined, 'close 返回 undefined')
  d.close()
  assert.deepEqual(await caught(d.create({ title: 'T', prompt: '第一步：读材料' })), { code: 'E1_DRIVER_CLOSED' }, 'close 后 create 拒')
  assert.deepEqual(await caught(d.result('sess_rec_read_01')), { code: 'E1_DRIVER_CLOSED' }, 'close 后 result 拒')
  assert.deepEqual(await caught(d.context('sess_rec_read_01')), { code: 'E1_DRIVER_CLOSED' }, 'close 后 context 拒')
  assert.equal(d.calls.at(-1).error, 'E1_DRIVER_CLOSED', '关闭后的调用也入账')
  ok('close：幂等 + 关闭后三操作全拒')
}

// ---- 9. validateScenarioSet（表驱动；make 统一返回"输入"，多数是 [scenario]）----
{
  const valid = () => ({
    name: 's',
    match: { prompt: 'P' },
    sessionId: 'sess_1',
    result: [{ status: 'done', text: 'ok' }],
    context: [{ note: 'n' }],
  })
  const one = (fn) => () => [fn()]
  const CASES = [
    { name: '通过：全字段场景', make: one(valid), accept: true },
    { name: '通过：最小场景（无 sessionId/context）', make: one(() => ({ name: 'm', match: { prompt: 'P' }, result: [{ status: 'running' }] })), accept: true },
    { name: '拒绝：非数组', make: () => 'nope', match: [/scenarios: 必须是数组/] },
    { name: '拒绝：元素非对象', make: () => [42], match: [/scenarios\[0\]: 必须是对象/] },
    { name: '拒绝：缺 name', make: one(() => ({ match: { prompt: 'P' }, result: [{ status: 'done' }] })), match: [/scenarios\[0\]\.name: 必须是非空字符串/] },
    { name: '拒绝：缺 match', make: one(() => ({ name: 's', result: [{ status: 'done' }] })), match: [/scenarios\[0\]\.match: 必须是对象/] },
    { name: '拒绝：match.prompt 空串', make: one(() => ({ name: 's', match: { prompt: '' }, result: [{ status: 'done' }] })), match: [/match\.prompt: 必须是非空字符串/] },
    { name: '拒绝：match 未知字段', make: one(() => ({ name: 's', match: { prompt: 'P', when: 'now' }, result: [{ status: 'done' }] })), match: [/scenarios\[0\]\.match: 未知字段 "when"/] },
    { name: '拒绝：match.model 缺 id', make: one(() => ({ name: 's', match: { prompt: 'P', model: { providerID: 'z' } }, result: [{ status: 'done' }] })), match: [/match\.model: 缺失必填字段 "id"/] },
    { name: '拒绝：scenario 未知字段', make: one(() => ({ ...valid(), extra: 1 })), match: [/scenarios\[0\]: 未知字段 "extra"/] },
    { name: '拒绝：result 缺省', make: one(() => ({ name: 's', match: { prompt: 'P' } })), match: [/scenarios\[0\]\.result: 必须是非空数组/] },
    { name: '拒绝：result 空数组', make: one(() => ({ name: 's', match: { prompt: 'P' }, result: [] })), match: [/scenarios\[0\]\.result: 必须是非空数组/] },
    { name: '拒绝：result[0] 缺 status', make: one(() => ({ name: 's', match: { prompt: 'P' }, result: [{ text: 't' }] })), match: [/result\[0\]\.status: 必须是 running\|done\|failed/] },
    { name: '拒绝：result[0].status 非法值', make: one(() => ({ name: 's', match: { prompt: 'P' }, result: [{ status: 'ok' }] })), match: [/result\[0\]\.status: 必须是 running\|done\|failed/] },
    { name: '拒绝：result[0] 未知字段', make: one(() => ({ name: 's', match: { prompt: 'P' }, result: [{ status: 'done', why: 'x' }] })), match: [/result\[0\]: 未知字段 "why"/] },
    { name: '拒绝：result[0].text 非字符串', make: one(() => ({ name: 's', match: { prompt: 'P' }, result: [{ status: 'done', text: 1 }] })), match: [/result\[0\]\.text: 必须是字符串/] },
    { name: '拒绝：context 空数组', make: one(() => ({ ...valid(), context: [] })), match: [/scenarios\[0\]\.context: 必须是非空数组/] },
    { name: '拒绝：context[0] 非对象', make: one(() => ({ ...valid(), context: [42] })), match: [/scenarios\[0\]\.context\[0\]: 必须是对象/] },
    { name: '拒绝：sessionId 空串', make: one(() => ({ ...valid(), sessionId: '' })), match: [/scenarios\[0\]\.sessionId: 必须是非空字符串/] },
    { name: '拒绝：sessionId 非字符串', make: one(() => ({ ...valid(), sessionId: 7 })), match: [/scenarios\[0\]\.sessionId: 必须是非空字符串/] },
    {
      name: '拒绝：set 级 sessionId 重复（首见不报、其后报）',
      make: () => [valid(), valid()],
      match: [/scenarios\[1\]\.sessionId: 与 scenarios\[0\] 重复 "sess_1"/],
    },
    {
      name: '拒绝：set 级 match 重复',
      make: () => [{ ...valid(), sessionId: 'a' }, { ...valid(), sessionId: 'b' }],
      match: [/scenarios\[1\]: match 与 scenarios\[0\] 重复/],
    },
  ]
  let accepts = 0
  for (const c of CASES) {
    const r = validateScenarioSet(c.make())
    assert.equal(r.ok, r.errors.length === 0, `${c.name}：ok 必须等于 (errors.length === 0)`)
    if (c.accept) {
      assert.equal(r.ok, true, `${c.name}：应通过，却拒绝：\n${r.errors.join('\n')}`)
      accepts += 1
    } else {
      assert.equal(r.ok, false, `${c.name}：应拒绝，却通过`)
      for (const re of c.match) assert.ok(r.errors.some((e) => re.test(e)), `${c.name}：错误里找不到 ${re}\n实际：\n${r.errors.join('\n')}`)
    }
    ok(c.name)
  }
  ok(`场景集校验 ${CASES.length} 行全过（通过 ${accepts} 行）`)

  assert.throws(() => createDriver('mock', { scenarios: [{ name: 's', match: {} }] }), (e) => e.code === 'E1_DRIVER_SCENARIO_INVALID' && /scenarios\[0\]\.match\.prompt/.test(e.message), 'mock 构造期拒非法场景集（fail fast，附校验错误）')
  ok('mock 构造期校验非法场景集')
}

// ---- 10. replay 加载器（合成录制件进临时目录；fixtures/engine/replay 不碰）----
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'e1-driver-contract-'))
try {
  // 10a. 同一场景集 × {mock, replay}：行为 + calls 全等（T3.6 结构半边；真实形状半边归 S7b）
  {
    const dir = join(TMP_ROOT, 'shared')
    mkdirSync(dir)
    writeFileSync(
      join(dir, 'recording.json'),
      JSON.stringify({ version: SCENARIO_VERSION, recordedAt: '2026-11-22T00:00:00Z', host: '合成夹具（S3 契约测试，非真机录制）', scenarios: SHARED_SCENARIOS() }, null, 2),
    )
    const mock = createDriver('mock', { scenarios: SHARED_SCENARIOS(), now: mkClock() })
    const replay = createDriver('replay', { dir, now: mkClock() })
    assertDriverFace(replay, 'replay', { requireCalls: true })
    assert.equal(replay.kind, 'replay', 'replay driver 自报 kind')
    assert.deepEqual(replay.recordings, { dir, files: ['recording.json'] }, 'replay 暴露装载位置与文件清单')

    const mockOut = await driveShared(mock)
    const replayOut = await driveShared(replay)
    assert.deepEqual(replayOut, mockOut, '同一场景集：13 步操作序列（含 3 条异常路径）双实现结果全等')
    assert.deepEqual(replay.calls, mock.calls, '同一场景集：calls 记录全等（同一时钟注入）')
    const codes = mockOut.filter(([, r]) => r.code !== undefined).map(([, r]) => r.code)
    assert.deepEqual(codes, ['E1_DRIVER_UNKNOWN_SESSION', 'E1_DRIVER_NO_CONTEXT', 'E1_DRIVER_NO_SCENARIO'], '异常路径恰 3 条且 code 一致')
    ok('同一场景集 × {mock, replay}：行为与 calls 全等（T3.6 结构半边）')
  }

  // 10b. 空目录容错（ask 点名）：空目录 / 不存在目录 / 缺省根（fixtures/engine/replay 此刻不该存在）
  {
    const empty = join(TMP_ROOT, 'empty')
    mkdirSync(empty)
    const d1 = createDriver('replay', { dir: empty, now: mkClock() })
    assertDriverFace(d1, 'replay-empty', { requireCalls: true })
    assert.deepEqual(d1.recordings, { dir: empty, files: [] }, '空目录：构造成功、零录制')
    const r1 = await caught(d1.create({ title: 'T', prompt: 'P' }))
    assert.equal(r1.code, 'E1_DRIVER_NO_SCENARIO', '空目录：使用时报 NO_SCENARIO（不炸构造）')

    const missing = join(TMP_ROOT, 'no-such-dir')
    const d2 = createDriver('replay', { dir: missing, now: mkClock() })
    assert.deepEqual(d2.recordings, { dir: missing, files: [] }, '不存在目录：同样容错')
    assert.equal((await caught(d2.create({ title: 'T', prompt: 'P' }))).code, 'E1_DRIVER_NO_SCENARIO', '不存在目录：使用时报 NO_SCENARIO')

    // 缺省根（S7a 时序容忍）：录制件由 S7a 真机产生（施工规格 §5-T3.6）。本测试不创建、
    // 不修改缺省根——S7a 之前它不存在（装载零录制），S7a 之后在位且按日期目录可装载（非空），
    // 两种时序下本文件都只读不写，存在性与进入时保持一致。
    const rootExisted = existsSync(DEFAULT_REPLAY_ROOT)
    const d3 = createDriver('replay', { now: mkClock() })
    if (!rootExisted) {
      assert.equal(existsSync(DEFAULT_REPLAY_ROOT), false, '缺省根此刻不存在（S7a 未跑；本测试不创建它）')
      assert.deepEqual(d3.recordings.files, [], '缺省根：容错装载零录制')
    } else {
      assert.ok(d3.recordings.files.length > 0, `缺省根已有 S7a 录制件且可装载（files=${d3.recordings.files.join(',')}）`)
    }
    const r3 = await caught(d3.create({ title: 'T', prompt: 'P' }))
    assert.equal(r3.code, 'E1_DRIVER_NO_SCENARIO', '缺省根：合成 prompt 不匹配任何录制场景 → NO_SCENARIO')
    assert.equal(existsSync(DEFAULT_REPLAY_ROOT), rootExisted, '测试全程没碰默认根（存在性与进入时一致）')
    ok('空目录/不存在目录/缺省根 三态容错（构造不炸、使用报 NO_SCENARIO、默认根未被触碰）')
  }

  // 10c. 日期子目录选择（缺省取字典序最大 = 最新日期）+ 显式 date
  {
    const root = join(TMP_ROOT, 'dated')
    for (const [date, sessionId] of [['2026-01-01', 'sess_old'], ['2026-02-02', 'sess_new']]) {
      mkdirSync(join(root, date), { recursive: true })
      writeFileSync(
        join(root, date, 'rec.json'),
        JSON.stringify({ version: SCENARIO_VERSION, scenarios: [{ name: 'p', match: { prompt: 'P' }, sessionId, result: [{ status: 'done', text: sessionId }] }] }),
      )
    }
    writeFileSync(join(root, 'notes.txt'), '非 json 文件应被忽略')

    const d = createDriver('replay', { root, now: mkClock() })
    assert.deepEqual(await d.create({ title: 'T', prompt: 'P' }), { sessionId: 'sess_new' }, '缺省取字典序最大日期子目录（2026-02-02）')
    assert.ok(d.recordings.dir.endsWith('2026-02-02'), `recordings.dir 指向最新日期（实际 ${d.recordings.dir}）`)

    const dOld = createDriver('replay', { root, date: '2026-01-01', now: mkClock() })
    assert.deepEqual(await dOld.create({ title: 'T', prompt: 'P' }), { sessionId: 'sess_old' }, '显式 date 指向指定日期子目录')

    const dNone = createDriver('replay', { root, date: '2025-12-31', now: mkClock() })
    assert.deepEqual(dNone.recordings.files, [], '显式 date 无此目录 → 容错零录制')
    ok('日期子目录：缺省最新 / 显式 date / 不存在日期容错')
  }

  // 10d. 多文件按文件名序合并
  {
    const dir = join(TMP_ROOT, 'multi')
    mkdirSync(dir)
    const mk = (name, prompt, sessionId) =>
      writeFileSync(join(dir, name), JSON.stringify({ version: SCENARIO_VERSION, scenarios: [{ name: 's', match: { prompt }, sessionId, result: [{ status: 'done', text: sessionId }] }] }))
    mk('b.json', 'PB', 'sess_b')
    mk('a.json', 'PA', 'sess_a')
    const d = createDriver('replay', { dir, now: mkClock() })
    assert.deepEqual(d.recordings.files, ['a.json', 'b.json'], '文件按名排序装载')
    assert.deepEqual(await d.create({ title: 'T', prompt: 'PA' }), { sessionId: 'sess_a' }, 'a 场景可用')
    assert.deepEqual(await d.create({ title: 'T', prompt: 'PB' }), { sessionId: 'sess_b' }, 'b 场景可用')
    ok('多文件合并（文件名序）')
  }

  // 10e. 坏件拒载（表驱动：每个坏件独立目录，构造期 E1_DRIVER_REPLAY_FORMAT）
  {
    const write = (dir, name, content) => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, name), content)
    }
    const goodScenario = { name: 's', match: { prompt: 'P' }, sessionId: 'sess_1', result: [{ status: 'done', text: 'ok' }] }
    const CASES = [
      { name: '非 JSON', content: '{oops', match: [/bad\.json: 不是合法 JSON/] },
      { name: '顶层非对象', content: '[]', match: [/bad\.json: 顶层必须是对象/] },
      { name: 'version 错值', content: JSON.stringify({ version: 2, scenarios: [] }), match: [/bad\.json: version 必须是 1（得到 2）/] },
      { name: 'version 缺失', content: JSON.stringify({ scenarios: [] }), match: [/bad\.json: version 必须是 1/] },
      { name: '顶层未知字段', content: JSON.stringify({ version: 1, scenarios: [], source: 'x' }), match: [/bad\.json: 顶层未知字段 "source"/] },
      { name: 'recordedAt 非字符串', content: JSON.stringify({ version: 1, recordedAt: 42, scenarios: [] }), match: [/bad\.json\.recordedAt: 必须是字符串/] },
      { name: 'scenarios 缺失', content: JSON.stringify({ version: 1 }), match: [/bad\.json\.scenarios: 必须是数组/] },
      { name: '场景缺 sessionId（mock 合法、replay 必填）', content: JSON.stringify({ version: 1, scenarios: [{ name: 's', match: { prompt: 'P' }, result: [{ status: 'done' }] }] }), match: [/scenarios\[0\]\.sessionId: 录制件必填/] },
      { name: '场景 result status 非法（校验错误带文件+下标）', content: JSON.stringify({ version: 1, scenarios: [{ ...goodScenario, result: [{ status: 'nope' }] }] }), match: [/bad\.json\.scenarios\[0\]\.result\[0\]\.status/] },
      { name: '场景 match 重复（同文件）', content: JSON.stringify({ version: 1, scenarios: [goodScenario, { ...goodScenario, sessionId: 'sess_2' }] }), match: [/scenarios\[1\]: match 与 scenarios\[0\] 重复/] },
      { name: 'sessionId 重复（同文件）', content: JSON.stringify({ version: 1, scenarios: [goodScenario, { ...goodScenario, match: { prompt: 'Q' } }] }), match: [/scenarios\[1\]\.sessionId: 与 scenarios\[0\] 重复 "sess_1"/] },
    ]
    for (const c of CASES) {
      const dir = join(TMP_ROOT, 'bad', c.name.replaceAll(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_'))
      write(dir, 'bad.json', c.content)
      assert.throws(() => createDriver('replay', { dir, now: mkClock() }), (e) => e.code === 'E1_DRIVER_REPLAY_FORMAT' && c.match.every((re) => re.test(e.message)), `${c.name}：构造期拒载，报错含文件名与定位\n  实际消息：${(() => { try { createDriver('replay', { dir }); return '未抛' } catch (e2) { return e2.message } })()}`)
      ok(`坏件拒载：${c.name}`)
    }
    // 跨文件 match 重复
    {
      const dir = join(TMP_ROOT, 'bad', '跨文件重复')
      write(dir, 'a.json', JSON.stringify({ version: SCENARIO_VERSION, scenarios: [goodScenario] }))
      write(dir, 'b.json', JSON.stringify({ version: SCENARIO_VERSION, scenarios: [{ ...goodScenario, sessionId: 'sess_9' }] }))
      assert.throws(() => createDriver('replay', { dir }), (e) => e.code === 'E1_DRIVER_REPLAY_FORMAT' && /b\.json\.scenarios\[0\]: match 与 a\.json\.scenarios\[0\] 重复/.test(e.message), '跨文件 match 重复应拒载（报错带两个定位）')
      ok('坏件拒载：跨文件 match 重复')
    }
    // loadReplayScenarios 直读（给 S7a 校验录制件用）
    {
      const dir = join(TMP_ROOT, 'shared')
      const loaded = loadReplayScenarios(dir)
      assert.deepEqual(loaded.files, ['recording.json'], 'loadReplayScenarios 返回文件清单')
      assert.deepEqual(loaded.sources, ['recording.json#0', 'recording.json#1', 'recording.json#2'], 'sources 带文件+下标定位')
      assert.deepEqual(loadReplayScenarios(join(TMP_ROOT, 'no-such-dir')), { scenarios: [], files: [], sources: [] }, 'loadReplayScenarios 对不存在目录同样容错')
      ok('loadReplayScenarios 直读（S7a 校验录制件的入口）')
    }
  }

  // 10f. chaos 对 replay 同样生效（chaos 在共核，kind 无关）
  {
    const dir = join(TMP_ROOT, 'shared')
    const d = createDriver('replay', { dir, now: mkClock(), fault: { driverChaos: { halfResponse: true } } })
    await d.create({ title: 'T', prompt: '第一步：读材料' })
    assert.deepEqual(await d.result('sess_rec_read_01'), { status: 'running' }, 'replay 半响应：只留 status')
    assert.deepEqual(await d.context('sess_rec_read_01'), {}, 'replay 半响应 context：{}')
    ok('chaos 对 replay 同样生效（共核语义）')
  }
} finally {
  rmSync(TMP_ROOT, { recursive: true, force: true })
}

// ---- 11. kind 面与工厂负臂 ----
{
  assert.throws(() => createDriver('session'), (e) => e.code === 'E1_DRIVER_BAD_ARGS' && /driver-session\.js 提供，S7b/.test(e.message), "kind 'session' 拒并指路 driver-session.js（S7b）")
  assert.throws(() => createDriver('bogus'), (e) => /允许：mock, replay/.test(e.message), '未知 kind 拒并列出允许值')
  ok("kind 负臂：'session' 指路 S7b / 未知 kind 列允许值")
}

// ---- 12. replay 真件半边（M1.3b/c 补全；只读 fixtures/engine/replay/<最新日期>/）----
// T3.6 的真实形状半边：真机录制件（真实 prompt/sessionId/宿主 context 形状）× {mock, replay}，
// 同一操作序列（create → result 灌满脚本+粘滞一位 → context → 未知会话负臂）行为与 calls 全等。
// 真件缺席（目录不存在/无日期子目录）→ 如实跳过（S7a 之前它不存在；两时序都绿）。
{
  const rootEntries = existsSync(DEFAULT_REPLAY_ROOT) ? readdirSync(DEFAULT_REPLAY_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []
  if (rootEntries.length === 0) {
    console.log('  —— §12 跳过：fixtures/engine/replay/ 无日期子目录（真机录制件尚未产生；本测试不创建它）')
  } else {
    const realDir = join(DEFAULT_REPLAY_ROOT, rootEntries[rootEntries.length - 1])
    const loaded = loadReplayScenarios(realDir)
    assert.ok(loaded.files.length > 0 && loaded.scenarios.length > 0, `真件在位且可装载（${realDir}：${loaded.files.join(',')}，${loaded.scenarios.length} 场景）`)

    // 12a. 真形状面（宿主形状钉在录制件上，装载器已严校；这里钉「真实」本身）
    for (const [i, s] of loaded.scenarios.entries()) {
      assert.match(s.sessionId, /^ses_[A-Za-z0-9]+$/, `真件 scenarios[${i}].sessionId 是真实引擎 id（ses_ 前缀）`)
      const terminal = s.result.at(-1)
      assert.ok(terminal.status === 'done' || terminal.status === 'failed', `真件 scenarios[${i}] 末应答是收敛终态（${terminal.status}）`)
      assert.ok(Array.isArray(s.context) && s.context.length > 0, `真件 scenarios[${i}].context 非空（宿主原始形状）`)
      for (const entry of s.context) {
        const v1 = 'info' in entry || 'parts' in entry || 'role' in entry
        const v2 = 'type' in entry || 'text' in entry || 'content' in entry
        assert.ok(v1 || v2, `真件 scenarios[${i}].context 条目带 v1（info/parts/role）或 v2 扁平（type/text/content）实测形状之一`)
      }
    }
    ok(`真件形状面：${loaded.scenarios.length} 场景 sessionId 真实、终态收敛、context 为实测宿主形状（目录 ${rootEntries[rootEntries.length - 1]}）`)

    // 12b. 同一真件场景集 × {mock, replay}：行为 + calls 全等（T3.6 真实形状半边）
    const driveReal = async (d) => {
      const out = []
      for (const s of loaded.scenarios) {
        const createArgs = {
          title: s.match.title,
          prompt: s.match.prompt,
          ...(s.match.agent !== undefined ? { agent: s.match.agent } : {}),
          ...(s.match.model !== undefined ? { model: s.match.model } : {}),
        }
        out.push([`create.${s.name}`, await caught(d.create(createArgs))])
        const sid = s.sessionId
        for (let i = 0; i < s.result.length + 1; i++) {
          out.push([`result.${s.name}#${i + 1}`, await caught(d.result(sid))])
        }
        out.push([`context.${s.name}`, await caught(d.context(sid))])
      }
      out.push(['result.unknown', await caught(d.result('sess_contract_missing'))])
      return out
    }
    const clockA = mkClock()
    const mockReal = createDriver('mock', { scenarios: loaded.scenarios, now: clockA })
    const clockB = mkClock()
    const replayReal = createDriver('replay', { dir: realDir, now: clockB })
    assert.equal(replayReal.kind, 'replay', 'replay driver 自报 kind')
    assert.ok(replayReal.recordings.files.length > 0, 'replay driver 装载到真件')
    const mockOutReal = await driveReal(mockReal)
    const replayOutReal = await driveReal(replayReal)
    assert.deepEqual(replayOutReal, mockOutReal, '真件场景集：同一操作序列双实现结果全等')
    assert.deepEqual(replayReal.calls, mockReal.calls, '真件场景集：calls 记录全等（同一时钟注入）')
    const codesReal = mockOutReal.filter(([, r]) => r.code !== undefined).map(([, r]) => r.code)
    assert.deepEqual(codesReal, ['E1_DRIVER_UNKNOWN_SESSION'], '负臂恰 1 条：未知会话 UNKNOWN_SESSION（真件全场景可消费，无其他异常路径）')
    const resultLabels = loaded.scenarios.flatMap((s) => [`result.${s.name}#1`, `result.${s.name}#${s.result.length + 1}`])
    const byLabel = new Map(mockOutReal)
    const firstAndSticky = resultLabels.map((label) => byLabel.get(label)?.value?.status)
    assert.deepEqual(
      firstAndSticky,
      loaded.scenarios.flatMap((s) => [s.result.at(-1).status, s.result.at(-1).status]),
      '每个场景首条 result 即末态（真件 result 只记终局应答），灌满后粘滞同值',
    )
    const contextValues = loaded.scenarios.map((s) => byLabel.get(`context.${s.name}`)?.value)
    assert.deepEqual(contextValues, loaded.scenarios.map((s) => s.context[0]), 'context 返回录制 context 首条（原样深拷贝）')
    ok(`真件 × {mock, replay}：${loaded.scenarios.length} 场景全操作全等（首条即末态 + 粘滞 + 负臂 + context 原样）——T3.6 真实形状半边补全`)
  }
}

console.log(`\n引擎 driver 契约测试（mock 侧 + replay 加载器 + replay 真件半边）：${passed} 项全过`)
console.log('  —— §12 真件只读（由 S7a/M1.3b/c 真机产生）；合成半边与真件半边双绿即 T3.6 补全')
