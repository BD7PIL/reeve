// E1 引擎 script-runner 测试（M2.1 门；蓝图 .zcode/plans/next-phase-plan-m1-m5.md「M2.1 facade
// 契约表」+ 评审必修③④：facade 内 semaphore、callSeq 同步入口第一行）。
//
// 覆盖矩阵（蓝图 M2.1 验收行点名五例，其余为参数/fail-closed/纪律补面）：
//   正常流      phase→ask(schema)→run 门禁端到端：status completed、schema 校验后对象回脚本、
//               journal 事件序 [phase,ask,run,log] 与广播同序（先落盘再广播）、ask 缓存键 =
//               sha256(script)+callSeq、title 锚点 REEVE-E1 <runId> script-ask-1、
//               markEngineSession（级联守卫）、无 schema ask 回纯文本、静态扫描 commands。
//   schema 3修1催 mock 坏×2→好：create 恰 3 次、重派 prompt 附上一次校验错误（第 2 次重派含第 1 次
//               的错不含第 2 次）、ASK_NUDGE 恰 1 次恰在最后一次重派、value = 解析产出、
//               journal ask 事件 attempts=3。
//   hole 挂起答复恢复 hole 事件记账→通知→await 答复（answerFor 首轮未答、次轮答）→hole-answered
//               →脚本继续；hole 不产生子会话（零额外 create）；escalate 语义别名（escalate 事件
//               对）；无 answerFor 接线拒挂起；答复源抛错两轮后恢复 / 连续 3 抛 → answer-source-error。
//   脚本 throw 保全 journal throw 后 status failed reason script-threw、result.asks 仍带已完成项、
//               盘上重读 journal 完好且 ask 事件 payload.value 可打捞（M2.2 基座）；ask 耗尽变体
//               （reason ask-failed + askFailure outcome + journal ask-failed 事件）。
//   determinism 违例 Date.now → ReferenceError（蓝图点名）；Math.random → TypeError（fail-closed
//               同收敛）；process/setTimeout/fetch → ReferenceError；正例 now/Math.floor/JSON/
//               Promise 可用（now 走注入时钟）；语法错 → script-syntax（零 journal 事件、零 driver 调用）。
//   并发帽      cap=1 双并发 ask 峰值恰 1（facade 内 semaphore，Admission acquire/release 形状）；
//               缺省无限峰值 2；租户形状对象直通；Promise.all 内 callSeq = 数组求值序（必修④）。
//   fail-closed journal torn 预检 blocked 零 driver 调用零广播；failWrite before：phase 落盘失败
//               → 就地停、create 一次不发生（先落盘再动作）；真实写抛错 mid-run：ask 事件写败
//               → blocked（journal 化 driver 包装 halted 后拒宿主）。
//   F.run 纪律  非零退出码=值非异常、spawn error 必捕（exitCode null + spawnError）、timeout
//               kill(SIGTERM) 后仍等 close（timedOut true、kill 前输出不丢）、journal 预览截断
//               标记（脚本仍拿全文）、静态扫描单元面、facade 参数面严格未知键拒。
//   真实 spawn  缺省 spawnFn = node:child_process.spawn 的活线一次（node -e 回声）。
//   M2.2 resume kill/resume 脚本版：run A 完成 ask1 后被杀（ask2 create 挂死）→ resumeScript 从
//               盘上抽缓存 → run B 重跑：已完成 ask 零 driver 调用返还（cached:true、值恒等首跑、
//               分支决策逐位一致——不变量③）、未终态 ask 无缓存真跑；命中零 journal 写零广播；
//               throw 后 resume 同理零 driver；resumeScript 单元面（空盘/torn/runId 不符/read 抛错
//               → 空缓存全量重跑；末笔为准；ask-failed 不进缓存；证据形状坏/条件② → 该点截断；
//               参数面 TypeError）。
//   C1 v2 amend 蓝图 optimization-plan-v3.md「C1」行：作用点位置匹配（ask 事件 payload 增记
//               调用点位置 site + promptHash/prefixHash/optsHash 证据；导入三条件任一不过 → 该点
//               起全部弃用）——用例五条：改尾部→前缀零重跑；改头部→全重跑；前缀含 hole→该点之后
//               弃用（不拿旧缓存假完成，挂起重挂、答复取新）；前缀含 F.run→副作用重执行如实计数；
//               原位改 prompt 字节（行结构不变）→该点弃用。另钉：证据域（promptHash=sha256(prompt)、
//               site=脚本体坐标）+ v1「哈希变更→全量重跑」断言的有意推翻（中段变更→该点弃用、
//               前缀仍导入）。
//
// 夹具全合成（内存 storage + mock driver + 假 child 进程 + 注入时钟/即时 sleep/手控 promise 竞跑）；
// 唯一真实进程是 9 的 node -e 回声。无真实定时器忙等（timeout 例的竞跑 promise 由测试释放）。
//
// 运行：node plugin/test/engine-script.test.mjs（assert 失败即抛、非零退出；成功自然退出）
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { Admission } from '../src/concurrency.js'
import { retryPrompt, ASK_NUDGE } from '../src/engine/ask.js'
import { validateValue } from '../src/engine/declaration.js'
import { createDriver } from '../src/engine/driver.js'
import { createJournal } from '../src/engine/journal.js'
import { RESUME_SCRIPT_MISS_REASONS, resumeScript } from '../src/engine/resume-script.js'
import {
  SCRIPT_ASK_STEP_PREFIX,
  SCRIPT_DEFAULTS,
  SCRIPT_EVENT_TYPES,
  SCRIPT_FAILURE_REASONS,
  SCRIPT_JOURNAL_NOT_OK,
  askCacheKey,
  runScript,
  scanRunCommands,
  scriptFingerprint,
} from '../src/engine/script-runner.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- 夹具基座（全合成）----
/** 内存 storage：read 初值 null（「无记录」），write 捕获最新文本；torn 制造用 initial 参数。 */
const memStorage = (initial = null) => {
  let text = initial
  return { read: () => text, write: (t) => (text = t) }
}
/** 盘上事件（journal 的 record.events；storage.read() 是盘上真相）。 */
const diskEvents = (storage) => JSON.parse(storage.read()).events

/** 注入时钟（读数恒定；各用例自选读数）。 */
const fixedClock = (t = 1000) => () => t
/** 即时 sleep（禁真实定时器；hole 答复轮询节奏用）。 */
const instantSleep = async () => {}
/** 微任务排水至谓词成立（合成 kill 的确定性等待：引擎链全走微任务；禁真实定时器忙等）。 */
const drainUntil = async (predicate, maxTurns = 500) => {
  for (let i = 0; i < maxTurns && !predicate(); i += 1) {
    await new Promise((resolve) => queueMicrotask(resolve))
  }
  return predicate()
}

/** mock driver 场景速写：单条 done 应答（粘滞）。 */
const sc = (prompt, text, extra = {}) => ({ name: prompt, match: { prompt }, result: [{ status: 'done', text }], ...extra })

/** 假 child 进程（F.run 注入面）：流 + error/close + kill 记账；start 由 spawnFn 经微任务触发。 */
const fakeChild = ({ stdout = '', stderr = '', exitCode = 0, holdUntilKill = false, error = null } = {}) => {
  const buf = new Map()
  const ls = (name) => {
    if (!buf.has(name)) buf.set(name, [])
    return buf.get(name)
  }
  const streamOf = (name) => ({ on: (_e, fn) => ls(name).push(fn), fire: (chunk) => ls(name).forEach((fn) => { fn(chunk) }) })
  const child = {
    stdout: streamOf('stdout'),
    stderr: streamOf('stderr'),
    killCalls: [],
    on(ev, fn) {
      ls(`ev:${ev}`).push(fn)
    },
    emit(ev, ...args) {
      for (const fn of ls(`ev:${ev}`)) fn(...args)
    },
    kill(sig) {
      this.killCalls.push(sig)
      if (holdUntilKill) this.emit('close', null)
    },
  }
  child.start = () => {
    if (stdout.length > 0) child.stdout.fire(Buffer.from(stdout))
    if (stderr.length > 0) child.stderr.fire(Buffer.from(stderr))
    if (error !== null) child.emit('error', error)
    if (!holdUntilKill) child.emit('close', exitCode)
  }
  return child
}

/** 假 spawn 工厂：记录 (cmd,args,child)；child 经微任务 start（listener 已挂好）。 */
const fakeSpawnFactory = (spec) => {
  const spawned = []
  const spawnFn = (cmd, args) => {
    const child = fakeChild(spec)
    spawned.push({ cmd, args, child })
    queueMicrotask(() => child.start())
    return child
  }
  return { spawnFn, spawned }
}

/** 在飞计数 driver 包装：create 入口 +1、result 终态 -1（帽峰值断言用）；calls 透传。 */
const trackingDriver = (base) => {
  const tracking = { inFlight: 0, max: 0 }
  const wrapped = {
    calls: base.calls,
    create: async (args) => {
      tracking.inFlight += 1
      tracking.max = Math.max(tracking.max, tracking.inFlight)
      return base.create(args)
    },
    result: async (sessionId) => {
      try {
        return await base.result(sessionId)
      } finally {
        tracking.inFlight -= 1
      }
    },
    context: (sessionId) => base.context(sessionId),
  }
  return { wrapped, tracking }
}

const createCount = (driver) => driver.calls.filter((c) => c.op === 'create').length
const createArgs = (driver) => driver.calls.filter((c) => c.op === 'create').map((c) => c.args)

const SUM_SCHEMA = { type: 'object', required: ['a'], properties: { a: { type: 'integer' } } }

// ---- 0. 缺省锚与参数校验（TypeError = 程序错误，fail-fast）----
console.log('0. 缺省锚与参数校验')
{
  assert.deepEqual(
    [...SCRIPT_FAILURE_REASONS],
    ['script-syntax', 'script-threw', 'ask-failed', 'answer-source-error', 'patch-failed'],
    'failed reason 取值域（C2 扩 patch-failed——失败点在补段内）',
  )
  assert.deepEqual(
    [...SCRIPT_EVENT_TYPES],
    ['phase', 'ask', 'ask-failed', 'run', 'hole', 'hole-answered', 'escalate', 'escalate-answered', 'log', 'patch'],
    'facade → journal 事件类型（蓝图 facade 表 journal 列；patch = C2 run 级补段事件，非 facade 成员）',
  )
  assert.equal(SCRIPT_DEFAULTS.pollMs, 1000, '缺省 ask 轮询间隔 1000ms')
  assert.equal(SCRIPT_DEFAULTS.holePollMs, 1000, '缺省 hole 答复轮询间隔 1000ms')
  assert.equal(SCRIPT_DEFAULTS.answerErrorLimit, 3, '答复源连续异常上限 3')
  assert.equal(SCRIPT_DEFAULTS.runPreviewCap, 512, 'journal run 预览上限 512')
  assert.equal(SCRIPT_JOURNAL_NOT_OK, 'journal-not-ok', 'blocked reason 与 scheduler 同字')
  assert.equal(SCRIPT_ASK_STEP_PREFIX, 'script-ask', 'ask stepId 前缀')
  const fp = scriptFingerprint('x')
  assert.equal(/^[0-9a-f]{64}$/.test(fp), true, 'scriptFingerprint = sha256 hex（64 位）')
  assert.equal(askCacheKey('x', 1), `${fp}:1`, '缓存键 = sha256(script)+":"+callSeq（蓝图 facade 表 journal 列）')
  assert.notEqual(scriptFingerprint('x'), scriptFingerprint('y'), '脚本一字之差指纹不同（cacheKey 诊断链仍可区分）')
  ok('缺省锚：SCRIPT_* 常量 + 指纹/缓存键格式')
}
{
  const dummyDriver = { create: async () => ({ sessionId: 's' }), result: async () => ({ status: 'done', text: 'x' }), context: async () => ({}) }
  const good = { script: 'return 1', runId: 'r', journal: createJournal({ storage: memStorage(), runId: 'r', now: fixedClock() }), driver: dummyDriver }
  const inputCases = [
    [{ ...good, script: undefined }, 'script 缺省'],
    [{ ...good, script: 42 }, 'script 非字符串'],
    [{ ...good, script: '' }, 'script 空串'],
    [{ ...good, runId: '' }, 'runId 空串'],
    [{ ...good, journal: {} }, 'journal 缺 face'],
  ]
  for (const [input, label] of inputCases) {
    await assert.rejects(runScript(input, {}), TypeError, `runScript 应拒：${label}`)
  }
  // driver face 缺失走 assertDriverFace（E1_DRIVER_BAD_ARGS，普通 Error）——按消息断言
  await assert.rejects(runScript({ ...good, driver: { create: 1 } }), /缺驱动面/, 'runScript 应拒：driver 缺 face')
  await assert.rejects(
    runScript({ ...good, driver: { create: async () => ({ sessionId: 's' }) } }),
    /缺驱动面/,
    'runScript 应拒：driver 缺 result/context',
  )
  const optCases = [
    [{ cap: -1 }, 'cap 负数'],
    [{ cap: 1.5 }, 'cap 非整数'],
    [{ cap: 'x' }, 'cap 非租户形状'],
    [{ now: 1 }, 'now 非函数'],
    [{ sleep: 1 }, 'sleep 非函数'],
    [{ pollMs: -1 }, 'pollMs 负数'],
    [{ holePollMs: 1.5 }, 'holePollMs 非整数'],
    [{ onEvent: 'x' }, 'onEvent 非函数'],
    [{ onLog: 1 }, 'onLog 非函数'],
    [{ answerFor: 7 }, 'answerFor 非函数'],
    [{ onHole: true }, 'onHole 非函数'],
    [{ spawn: 'x' }, 'spawn 非函数'],
    [{ scriptName: '' }, 'scriptName 空串'],
  ]
  for (const [opts, label] of optCases) {
    await assert.rejects(runScript(good, opts), TypeError, `runScript 应拒 opts：${label}`)
  }
  ok('参数面：input 六形 TypeError + driver 面按码 + opts 十三形 TypeError')
}

// ---- 1. 正常流（phase→ask(schema)→run 门禁）----
console.log('1. 正常流：phase → ask(schema) → run 门禁（端到端）')
{
  const P = '给出 {"a": 7} 形态的 JSON'
  const storage = memStorage()
  const journal = createJournal({ storage, runId: 's1-normal', now: fixedClock(100) })
  const driver = createDriver('mock', { scenarios: [sc(P, '{"a": 7, "op": "add"}', { sessionId: 'sess_script_a1' })] })
  const { spawnFn, spawned } = fakeSpawnFactory({ stdout: 'ok', stderr: '', exitCode: 0 })
  const script = [
    `const schema = ${JSON.stringify(SUM_SCHEMA)}`,
    `F.phase('侦察')`,
    `const facts = await F.ask(${JSON.stringify(P)}, { schema })`,
    `const r = await F.run('fake-cmd', ['--flag', 'x'])`,
    `F.log('exit=' + r.exitCode)`,
    `return { facts }`,
  ].join('\n')
  const broadcast = []
  const res = await runScript(
    { script, runId: 's1-normal', journal, driver },
    { now: fixedClock(200), sleep: instantSleep, spawn: spawnFn, onEvent: (e) => broadcast.push(e) },
  )

  assert.equal(res.status, 'completed', '脚本正常返回 → completed')
  // 脚本返回值产自 vm realm（原型是 context 的 Object.prototype）——结构断言走 JSON 往返剥 realm
  assert.deepEqual(JSON.parse(JSON.stringify(res.value)), { facts: { a: 7, op: 'add' } }, '脚本返回值回流 result.value')
  assert.deepEqual(res.phases, ['侦察'], 'phase 镜像')
  assert.deepEqual(res.logs, ['exit=0'], 'log 镜像')
  assert.deepEqual(res.commands, ['fake-cmd'], '静态扫描进 result.commands（评审面）')
  assert.equal(res.asks.length, 1, 'ask 镜像恰 1 条')
  const ask = res.asks[0]
  assert.equal(ask.callSeq, 1, '首个 ask callSeq=1（同步入口第一行分配）')
  assert.equal(ask.cacheKey, askCacheKey(script, 1), '缓存键 = sha256(script)+callSeq')
  assert.equal(ask.stepId, 'script-ask-1', 'stepId 约定')
  assert.deepEqual(ask.value, { a: 7, op: 'add' }, 'schema 校验后对象回脚本（不是 text）')
  assert.equal(ask.attempts, 1, '一次通过 attempts=1')
  assert.equal(ask.sessionId, 'sess_script_a1', 'sessionId 回流')
  assert.equal(journal.isEngineSession('sess_script_a1'), true, 'markEngineSession（§1 级联守卫锚点）')
  assert.deepEqual(createArgs(driver), [{ title: 'REEVE-E1 s1-normal script-ask-1', prompt: P }], 'create 恰两键：REEVE-E1 锚点 title + prompt（schema 不进 create）')

  assert.equal(res.runs.length, 1, 'run 镜像恰 1 条')
  assert.deepEqual(res.runs[0], { exitCode: 0, stdout: 'ok', stderr: '' }, 'F.run 回 {exitCode,stdout,stderr}')
  assert.equal(spawned.length, 1, 'spawn 恰一次')
  assert.deepEqual(JSON.parse(JSON.stringify(spawned[0].args)), ['--flag', 'x'], 'args 透传 spawn 原语（vm realm 数组剥原型比较）')

  const events = diskEvents(storage)
  assert.deepEqual(events.map((e) => e.type), ['phase', 'ask', 'run', 'log'], 'journal 事件序 = 脚本动作序')
  assert.deepEqual(events[0].payload, { name: '侦察' }, 'phase 事件 payload')
  assert.equal(events[1].payload.cacheKey, askCacheKey(script, 1), 'ask 事件盘上带缓存键（M2.2 打捞基座）')
  assert.deepEqual(events[1].payload.value, { a: 7, op: 'add' }, 'ask 事件盘上带产出值（打捞）')
  assert.deepEqual(
    events[2].payload,
    { cmd: 'fake-cmd', args: ['--flag', 'x'], exitCode: 0, stdout: 'ok', stdoutTruncated: false, stderr: '', stderrTruncated: false },
    'run 事件 payload（cmd/args/exitCode/预览+截断标记）',
  )
  assert.deepEqual(events[3].payload, { message: 'exit=0' }, 'log 事件 payload')

  assert.deepEqual(broadcast.map((e) => e.type), ['phase', 'ask', 'run', 'log', 'script-completed'], '广播与盘上事件同序 + 终局广播')
  for (const e of broadcast) {
    assert.equal(e.kind, 'script', '广播 kind=script')
    assert.equal(e.runId, 's1-normal', '广播挂 runId')
    assert.equal(e.at, 200, '广播 at 走注入时钟')
  }
  ok('正常流：completed + schema 值 + run 门禁 + journal/广播同序 + 缓存键 + 锚点 title + 级联守卫')
}
{
  // 无 schema ask：回纯文本（蓝图「schema 校验后对象 / 纯文本」）
  const P = '只回一句纯文本'
  const journal = createJournal({ storage: memStorage(), runId: 's1-plain', now: fixedClock() })
  const driver = createDriver('mock', { scenarios: [sc(P, 'plain-text-answer')] })
  const res = await runScript({ script: `return await F.ask(${JSON.stringify(P)})`, runId: 's1-plain', journal, driver }, { now: fixedClock() })
  assert.equal(res.status, 'completed')
  assert.equal(res.value, 'plain-text-answer', '无 schema → 纯文本（不是解析对象）')
  ok('正常流：无 schema ask 回纯文本')
}

// ---- 2. schema 3修1催（ask.js 校验循环口径不变，facade 只是接线）----
console.log('2. schema 3 修 1 催')
{
  const P = '给出 {"a": 整数} 形态的 JSON'
  const BAD1 = '{"a": 1.5}'
  const BAD2 = '{"a": "x"}'
  const GOOD = '{"a": 7}'
  const ERRS1 = validateValue(JSON.parse(BAD1), SUM_SCHEMA, '产出').errors
  const ERRS2 = validateValue(JSON.parse(BAD2), SUM_SCHEMA, '产出').errors
  assert.equal(ERRS1.length, 1, '夹具自检：bad1 恰 1 条 schema 错')
  assert.equal(ERRS2.length, 1, '夹具自检：bad2 恰 1 条 schema 错')
  const P2 = retryPrompt(P, ERRS1, { attempt: 2, maxAttempts: 3 })
  const P3 = retryPrompt(P, ERRS2, { attempt: 3, maxAttempts: 3 })
  const storage = memStorage()
  const journal = createJournal({ storage, runId: 's2-retry', now: fixedClock() })
  const driver = createDriver('mock', { scenarios: [sc(P, BAD1), sc(P2, BAD2), sc(P3, GOOD)] })
  const script = `const schema = ${JSON.stringify(SUM_SCHEMA)}\nreturn await F.ask(${JSON.stringify(P)}, { schema })`
  const res = await runScript({ script, runId: 's2-retry', journal, driver }, { now: fixedClock() })

  assert.equal(res.status, 'completed', '第三次通过 → completed')
  assert.deepEqual(res.value, { a: 7 }, 'value = 解析产出')
  assert.equal(res.asks[0].attempts, 3, 'attempts=3（含初派）')
  assert.equal(createCount(driver), 3, 'create 恰 3 次（初派 1 + 重派 2）')
  const prompts = createArgs(driver).map((a) => a.prompt)
  assert.equal(prompts[0], P, '初派 prompt = instructions 原文')
  assert.equal(prompts[1], P2, '第 1 次重派 prompt 与 ask.retryPrompt 逐字符相等（附第 1 次的错）')
  assert.equal(prompts[2], P3, '第 2 次重派 prompt 与 ask.retryPrompt 逐字符相等（附第 2 次的错）')
  assert.ok(prompts[1].includes(ERRS1[0]) && !prompts[1].includes(ERRS2[0]), '重派 1 附第 1 次错误、不含第 2 次错误')
  assert.ok(prompts[2].includes(ERRS2[0]) && !prompts[2].includes(ERRS1[0]), '重派 2 附第 2 次错误、不含第 1 次错误')
  assert.equal(prompts[2].split(ASK_NUDGE).length - 1, 1, 'nudge 全程恰 1 次')
  assert.ok(!prompts[1].includes(ASK_NUDGE), 'nudge 不在第 1 次重派（恰在第 2 次重派）')
  const events = diskEvents(storage)
  assert.deepEqual(events.map((e) => e.type), ['ask'], 'journal 恰 1 笔 ask 事件（重派过程不逐次记账）')
  assert.equal(events[0].payload.attempts, 3, 'ask 事件盘上 attempts=3')
  assert.deepEqual(events[0].payload.value, { a: 7 }, 'ask 事件盘上带最终产出')
  ok('schema 3修1催：create 恰 3 + 错误逐次附上一次 + nudge 恰 1 恰在最后 + journal 单笔终账')
}

// ---- 3. hole 挂起答复恢复 + escalate 语义别名 ----
console.log('3. hole 挂起答复恢复')
{
  const P = '先给个数'
  const ANSWER = '继续，用方案 A'
  const journal = createJournal({ storage: memStorage(), runId: 's3-hole', now: fixedClock(10) })
  const driver = createDriver('mock', { scenarios: [sc(P, '{"a": 1}')] })
  const script = [
    `await F.ask(${JSON.stringify(P)})`,
    `const a = await F.hole('审批', '继续吗?')`,
    `F.log('answer=' + a)`,
    `return a`,
  ].join('\n')
  let polls = 0
  const onHoleRecords = []
  const res = await runScript(
    { script, runId: 's3-hole', journal, driver },
    {
      now: fixedClock(10),
      sleep: instantSleep,
      onHole: (rec) => onHoleRecords.push(rec),
      answerFor: () => {
        polls += 1
        return polls === 1 ? null : ANSWER // 首轮未答、次轮答（非阻塞拉取 + 注入 sleep 节奏）
      },
    },
  )
  assert.equal(res.status, 'completed', '答复唤醒后脚本继续到 completed')
  assert.equal(res.value, ANSWER, 'F.hole 返回答复')
  assert.equal(polls, 2, 'answerFor 恰拉 2 次（未答跳轮、答则醒）')
  assert.deepEqual(res.holes, [{ name: '审批', question: '继续吗?', answer: ANSWER }], 'hole 镜像（挂起→答复）')
  assert.equal(createCount(driver), 1, 'hole 不产生子会话（只有 ask 的 1 次 create——挂起对象是脚本不是步）')
  assert.equal(onHoleRecords.length, 1, 'onHole 恰一次（面板/聊天问句出口）')
  assert.deepEqual(
    { kind: onHoleRecords[0].kind, name: onHoleRecords[0].name, question: onHoleRecords[0].question },
    { kind: 'hole', name: '审批', question: '继续吗?' },
    'onHole record 形状',
  )
  ok('hole 挂起答复恢复：await 唤醒 + 零额外子会话 + onHole 恰一次')
}
{
  // journal 事件序（独立实例）：ask → hole → hole-answered → log
  const P = '先给个数'
  const ANSWER = 'go'
  const storage = memStorage()
  const journal = createJournal({ storage, runId: 's3-hole2', now: fixedClock() })
  const driver = createDriver('mock', { scenarios: [sc(P, '{"a": 1}')] })
  const script = `await F.ask(${JSON.stringify(P)})\nawait F.hole('门', '过吗?')\nF.log('after')`
  let polls = 0
  const res = await runScript(
    { script, runId: 's3-hole2', journal, driver },
    {
      now: fixedClock(),
      sleep: instantSleep,
      answerFor: () => {
        polls += 1
        return polls === 1 ? null : ANSWER
      },
    },
  )
  assert.equal(res.status, 'completed')
  const events = diskEvents(storage)
  assert.deepEqual(events.map((e) => e.type), ['ask', 'hole', 'hole-answered', 'log'], '事件序：ask→hole→hole-answered→log（脚本路径的 blocked 记账 = 事件对，无步迁移）')
  assert.deepEqual(events[1].payload, { seq: 1, name: '门', question: '过吗?' }, 'hole 事件 payload（seq/name/question）')
  assert.deepEqual(events[2].payload, { seq: 1, name: '门', answer: ANSWER }, 'hole-answered 事件 payload')
  ok('hole 记账：journal hole/hole-answered 事件对（脚本不是步，恢复不重派而是唤醒）')
}
{
  // escalate：hole 的语义别名（escalate 事件对；无 name）
  const ANSWER = 'reeve/standard'
  const storage = memStorage()
  const journal = createJournal({ storage, runId: 's3-esc', now: fixedClock() })
  const driver = createDriver('mock', { scenarios: [] })
  const script = `return await F.escalate('用哪个模型?')`
  const res = await runScript({ script, runId: 's3-esc', journal, driver }, { now: fixedClock(), sleep: instantSleep, answerFor: () => ANSWER })
  assert.equal(res.status, 'completed')
  assert.equal(res.value, ANSWER, 'escalate 返回答复')
  assert.deepEqual(res.holes, [{ question: '用哪个模型?', answer: ANSWER }], 'escalate 共用 holes 镜像（question 无 name）')
  const events = diskEvents(storage)
  assert.deepEqual(events.map((e) => e.type), ['escalate', 'escalate-answered'], 'escalate 事件对（语义别名，独立类型）')
  assert.deepEqual(events[0].payload, { seq: 1, question: '用哪个模型?' }, 'escalate 事件 payload')
  assert.deepEqual(events[1].payload, { seq: 1, question: '用哪个模型?', answer: ANSWER }, 'escalate-answered 事件 payload')
  ok('escalate 语义别名：答复回流 + 事件对')
}
{
  // 无 answerFor 接线：拒挂起（先检查接线再挂账——journal 无 hole 事件）
  const storage = memStorage()
  const journal = createJournal({ storage, runId: 's3-noans', now: fixedClock() })
  const driver = createDriver('mock', { scenarios: [] })
  const res = await runScript({ script: `await F.hole('门', '过吗?')`, runId: 's3-noans', journal, driver }, { now: fixedClock(), sleep: instantSleep })
  assert.equal(res.status, 'failed')
  assert.equal(res.reason, 'script-threw')
  assert.match(res.error, /answerFor/, '错误指名 answerFor 接线缺失')
  assert.equal(createCount(driver), 0, '零子会话')
  assert.equal(storage.read(), null, 'journal 无挂账（接线检查先于挂起记账）')
  ok('hole 无 answerFor：拒挂起（接线错误=脚本失败，journal 无挂账）')
}
{
  // 答复源鲁棒性：抛错两轮后恢复；连续 3 抛 → answer-source-error（防坏死热循环）
  const ANSWER = 'ok'
  let calls = 0
  const journal = createJournal({ storage: memStorage(), runId: 's3-flaky', now: fixedClock() })
  const driver = createDriver('mock', { scenarios: [] })
  const res = await runScript(
    { script: `return await F.hole('门', '过吗?')`, runId: 's3-flaky', journal, driver },
    {
      now: fixedClock(),
      sleep: instantSleep,
      answerFor: () => {
        calls += 1
        if (calls <= 2) throw new Error('panel down')
        return ANSWER
      },
    },
  )
  assert.equal(res.status, 'completed', '抛错两轮（< 上限 3）后恢复')
  assert.equal(res.value, ANSWER)
  assert.equal(calls, 3, '恰拉 3 次（两次异常 + 一次成功）')

  const journal2 = createJournal({ storage: memStorage(), runId: 's3-dead', now: fixedClock() })
  const driver2 = createDriver('mock', { scenarios: [] })
  const res2 = await runScript(
    { script: `return await F.hole('门', '过吗?')`, runId: 's3-dead', journal: journal2, driver: driver2 },
    {
      now: fixedClock(),
      sleep: instantSleep,
      answerFor: () => {
        throw new Error('panel gone')
      },
    },
  )
  assert.equal(res2.status, 'failed', '连续 3 抛 → 脚本失败')
  assert.equal(res2.reason, 'answer-source-error', 'reason=answer-source-error（SCRIPT_FAILURE_REASONS 枚举内）')
  assert.ok([...SCRIPT_FAILURE_REASONS].includes('answer-source-error'), 'reason 在枚举域')
  ok('答复源：抛错逐轮跳过恢复 / 连续 3 抛 → answer-source-error')
}

// ---- 4. 脚本 throw 保全 journal（失败语义）----
console.log('4. 脚本 throw 保全 journal')
{
  const P = '给个数'
  const storage = memStorage()
  const journal = createJournal({ storage, runId: 's4-throw', now: fixedClock(300) })
  const driver = createDriver('mock', { scenarios: [sc(P, '{"a": 9}')] })
  const script = [
    `const v = await F.ask(${JSON.stringify(P)}, { schema: ${JSON.stringify(SUM_SCHEMA)} })`,
    `F.log('about to fail')`,
    `throw new Error('boom')`,
  ].join('\n')
  const broadcast = []
  const res = await runScript({ script, runId: 's4-throw', journal, driver }, { now: fixedClock(300), onEvent: (e) => broadcast.push(e) })

  assert.equal(res.status, 'failed', '脚本 throw = run failed')
  assert.equal(res.reason, 'script-threw', 'reason=script-threw')
  assert.equal(res.error, 'boom', 'error = brief(throw)')
  assert.equal(res.askFailure, undefined, '非 ask 失败不带 askFailure')
  assert.equal(res.value, undefined, 'failed 不带脚本返回值')
  assert.equal(res.asks.length, 1, 'result.asks 仍带已完成项（打捞镜像）')
  assert.deepEqual(res.asks[0].value, { a: 9 }, '已完成 ask 的产出在镜像里')
  assert.equal(createCount(driver), 1, 'throw 前恰 1 次子会话')

  const fresh = createJournal({ storage, runId: 's4-throw', now: fixedClock() })
  assert.equal(fresh.status().ok, true, '重读 journal 完好（未 torn/degraded）')
  const events = diskEvents(storage)
  assert.deepEqual(events.map((e) => e.type), ['ask', 'log'], 'throw 前的事件全保留')
  assert.deepEqual(events[0].payload.value, { a: 9 }, '已完成 ask 的 payload.value 在盘上（报告打捞 + M2.2 按序返还基座）')
  assert.equal(events[0].payload.cacheKey, askCacheKey(script, 1), '缓存键在盘上（M2.2 resume 输入）')
  assert.deepEqual(broadcast.map((e) => e.type), ['ask', 'log', 'script-failed'], '广播止于失败点 + 终局广播')
  ok('脚本 throw：failed + journal 保全 + 打捞镜像/盘上双证')
}
{
  // ask 耗尽变体：F.ask 失败 → 脚本收到 throw → run failed reason=ask-failed + askFailure
  // （mock 按 prompt 全等匹配——重派 prompt 要各自给场景，三次都过不了 schema）
  const P = '给个数'
  const BAD = '{"a": "no"}'
  const ERRS = validateValue(JSON.parse(BAD), SUM_SCHEMA, '产出').errors
  const storage = memStorage()
  const journal = createJournal({ storage, runId: 's4-askfail', now: fixedClock() })
  const driver = createDriver('mock', {
    scenarios: [
      sc(P, BAD),
      sc(retryPrompt(P, ERRS, { attempt: 2, maxAttempts: 3 }), BAD),
      sc(retryPrompt(P, ERRS, { attempt: 3, maxAttempts: 3 }), BAD),
    ],
  })
  const script = `return await F.ask(${JSON.stringify(P)}, { schema: ${JSON.stringify(SUM_SCHEMA)} })`
  const res = await runScript({ script, runId: 's4-askfail', journal, driver }, { now: fixedClock() })
  assert.equal(res.status, 'failed')
  assert.equal(res.reason, 'ask-failed', 'ask 耗尽 → reason=ask-failed')
  assert.ok(res.error.includes('invalid-output'), 'error 带失败 reason')
  assert.equal(res.askFailure.ok, false, 'askFailure = typedAsk 失败 outcome')
  assert.equal(res.askFailure.reason, 'invalid-output')
  assert.equal(res.askFailure.attempts, 3, '3 次尝试耗尽')
  assert.equal(res.askFailure.callSeq, 1, 'askFailure 带 callSeq（失败不进缓存——M2.2 只按 ask 事件返还）')
  assert.equal(res.askFailure.cacheKey, askCacheKey(script, 1))
  const events = diskEvents(storage)
  assert.deepEqual(events.map((e) => e.type), ['ask-failed'], 'journal 记 ask-failed 事件')
  assert.equal(events[0].payload.reason, 'invalid-output')
  assert.ok(Array.isArray(events[0].payload.errors) && events[0].payload.errors.length > 0, 'ask-failed payload 带校验错误明细')
  assert.ok(res.logs.length === 0, '失败点之后脚本不推进')
  ok('ask 耗尽：reason=ask-failed + askFailure outcome + journal ask-failed 落盘（带错误明细）')
}

// ---- 5. determinism 违例（vm 层强制；fail-closed）----
console.log('5. determinism 违例')
{
  const run = async (body) => {
    const storage = memStorage()
    const journal = createJournal({ storage, runId: 's5-det', now: fixedClock() })
    const driver = createDriver('mock', { scenarios: [] })
    const res = await runScript({ script: body, runId: 's5-det', journal, driver }, { now: fixedClock(1234), sleep: instantSleep })
    return { res, storage, driver }
  }
  const dateCase = await run(`return Date.now()`)
  assert.equal(dateCase.res.status, 'failed', 'Date 违例 = 脚本失败')
  assert.equal(dateCase.res.reason, 'script-threw')
  assert.match(dateCase.res.error, /Date is not defined/, 'Date 被删 → ReferenceError（蓝图点名）')
  assert.equal(dateCase.storage.read(), null, '违例零落盘')
  assert.equal(createCount(dateCase.driver), 0, '违例零派发')

  const randCase = await run(`return Math.random()`)
  assert.equal(randCase.res.status, 'failed', 'Math.random 违例 = 脚本失败（fail-closed）')
  assert.match(randCase.res.error, /Math\.random is not a function/, 'Math.random 被删 → TypeError（fail-closed 同收敛）')
  const procCase = await run(`return process.env.HOME`)
  assert.match(procCase.res.error, /process is not defined/, 'process 不注入 → ReferenceError')
  const toCase = await run(`setTimeout(() => {}, 0)\nreturn 1`)
  assert.match(toCase.res.error, /setTimeout is not defined/, 'setTimeout 不注入 → ReferenceError')
  const fetchCase = await run(`return await fetch('http://localhost:1')`)
  assert.match(fetchCase.res.error, /fetch is not defined/, 'fetch 不注入 → ReferenceError')

  // 正例：白名单成员可用且走注入时钟
  const storage = memStorage()
  const journal = createJournal({ storage, runId: 's5-ok', now: fixedClock(1234) })
  const driver = createDriver('mock', { scenarios: [] })
  const resOk = await runScript(
    {
      script: [
        `const t = now()`,
        `const s = JSON.stringify({ n: Math.floor(3.9) })`,
        `await Promise.all([F.log('a'), F.log('b')])`,
        `return { t, s }`,
      ].join('\n'),
      runId: 's5-ok',
      journal,
      driver,
    },
    { now: fixedClock(1234), sleep: instantSleep },
  )
  assert.equal(resOk.status, 'completed', '白名单成员（now/Math.floor/JSON/Promise）可用')
  assert.deepEqual(JSON.parse(JSON.stringify(resOk.value)), { t: 1234, s: '{"n":3}' }, 'now() 走注入时钟（确定性）')
  assert.deepEqual(diskEvents(storage).filter((e) => e.type === 'log').map((e) => e.payload.message), ['a', 'b'], 'Promise.all 双 log 落盘')
  ok('determinism：Date/random/process/setTimeout/fetch 违例全失败；白名单成员 + 注入 now 可用')
}
{
  // 语法错 = script-syntax：零 journal 事件、零 driver 调用
  const storage = memStorage()
  const journal = createJournal({ storage, runId: 's5-syntax', now: fixedClock() })
  const driver = createDriver('mock', { scenarios: [] })
  const res = await runScript({ script: `const const const`, runId: 's5-syntax', journal, driver }, { now: fixedClock() })
  assert.equal(res.status, 'failed')
  assert.equal(res.reason, 'script-syntax', '语法错 reason=script-syntax')
  assert.ok(res.error.length > 0, 'error 带语法错简报')
  assert.equal(storage.read(), null, '零 journal 事件（编译失败先于一切落盘）')
  assert.equal(createCount(driver), 0, '零 driver 调用')
  ok('语法错：script-syntax + 零落盘零派发')
}

// ---- 6. 并发帽（facade 内 semaphore；Admission acquire/release 形状，key=callSeq）----
console.log('6. 并发帽')
{
  const P1 = 'ask 甲'
  const P2 = 'ask 乙'
  const mk = () => {
    const journal = createJournal({ storage: memStorage(), runId: 's6-cap', now: fixedClock() })
    const driver = createDriver('mock', { scenarios: [sc(P1, '{"a":1}'), sc(P2, '{"a":2}')] })
    const { wrapped, tracking } = trackingDriver(driver)
    return { journal, wrapped, tracking }
  }
  const script = `const r = await Promise.all([F.ask(${JSON.stringify(P1)}), F.ask(${JSON.stringify(P2)})])\nreturn r`

  const capped = mk()
  const res1 = await runScript({ script, runId: 's6-cap', journal: capped.journal, driver: capped.wrapped }, { now: fixedClock(), cap: 1 })
  assert.equal(res1.status, 'completed')
  assert.equal(capped.tracking.max, 1, 'cap=1：在飞峰值恰 1（facade 内 semaphore 排队不失败）')
  assert.deepEqual(res1.asks.map((a) => a.callSeq), [1, 2], 'callSeq = 数组求值序（同步入口第一行，必修④）')
  assert.deepEqual(res1.asks.map((a) => a.cacheKey), [askCacheKey(script, 1), askCacheKey(script, 2)], '缓存键按 callSeq 区分')

  const uncapped = mk()
  const res2 = await runScript({ script, runId: 's6-cap', journal: uncapped.journal, driver: uncapped.wrapped }, { now: fixedClock() })
  assert.equal(res2.status, 'completed')
  assert.equal(uncapped.tracking.max, 2, '缺省无限：双 ask 在飞峰值 2（复用 Admission 缺省参数 0=无限）')

  const tenant = new Admission({ limits: { default: 1 } })
  const tenantCase = mk()
  const res3 = await runScript({ script, runId: 's6-cap', journal: tenantCase.journal, driver: tenantCase.wrapped }, { now: fixedClock(), cap: tenant })
  assert.equal(res3.status, 'completed')
  assert.equal(tenantCase.tracking.max, 1, '租户形状对象直通（acquire(key)→release）')
  ok('并发帽：cap=1 峰值恰 1 / 缺省无限峰值 2 / 租户形状直通 / callSeq 求值序')
}

// ---- 7. journal fail-closed（T3.5 脚本侧）----
console.log('7. journal fail-closed')
{
  // torn 预检：零 driver 调用、零广播、零事件
  const storage = memStorage('{broken-json')
  const journal = createJournal({ storage, runId: 's7-torn', now: fixedClock() })
  const driver = createDriver('mock', { scenarios: [sc('x', 'y')] })
  const broadcast = []
  const res = await runScript({ script: `F.phase('p')`, runId: 's7-torn', journal, driver }, { now: fixedClock(), onEvent: (e) => broadcast.push(e) })
  assert.equal(res.status, 'blocked')
  assert.equal(res.reason, SCRIPT_JOURNAL_NOT_OK)
  assert.equal(res.journal.torn, true, 'result.journal = journal.status()（torn 显式读数）')
  assert.equal(createCount(driver), 0, 'torn：零 driver 调用')
  assert.equal(broadcast.length, 0, 'torn：零广播')
  assert.equal(storage.read(), '{broken-json', 'torn：不写盘（撕裂字节原样保留）')
  ok('torn 预检：blocked + 零派发零广播零落盘')
}
{
  // failWrite before：phase 落盘失败 → 就地停，create 一次不发生（先落盘再动作）
  const storage = memStorage()
  const journal = createJournal({ storage, runId: 's7-fw', now: fixedClock(), fault: { failWrite: 'before' } })
  const driver = createDriver('mock', { scenarios: [sc('x', 'y')] })
  const broadcast = []
  const res = await runScript(
    { script: `F.phase('p')\nawait F.ask('x')\nF.log('l')`, runId: 's7-fw', journal, driver },
    { now: fixedClock(), sleep: instantSleep, onEvent: (e) => broadcast.push(e) },
  )
  assert.equal(res.status, 'blocked')
  assert.equal(res.reason, SCRIPT_JOURNAL_NOT_OK)
  assert.equal(res.journal.degraded, true, 'degraded 显式读数回流 result.journal')
  assert.equal(createCount(driver), 0, '先落盘再动作：phase 落盘失败 → create 零次')
  assert.equal(broadcast.length, 0, '零广播（halted 不广播，scheduler 同口径）')
  assert.equal(storage.read(), null, '盘上无记录（before 不写）')
  ok('failWrite before：脚本就地停 + create 零次（先落盘再动作）')
}
{
  // 真实写抛错 mid-run：第二个 ask 的 ask 事件写败（第 3 次 write）→ halted → blocked
  const P = '给个数'
  let failOn = -1
  let writes = 0
  const storage = memStorage()
  const flaky = {
    read: () => storage.read(),
    write: (t) => {
      writes += 1
      if (writes === failOn) throw new Error('disk gone mid-run')
      storage.write(t)
    },
  }
  const journal = createJournal({ storage: flaky, runId: 's7-halt', now: fixedClock() })
  const driver = createDriver('mock', { scenarios: [sc(P, '{"a":1}')] })
  const script = `await F.ask(${JSON.stringify(P)})\nawait F.ask(${JSON.stringify(P)})\nreturn 1`
  // write 序 = ses(ask1), ask(ask1), ask(ask2)（ask2 的 markEngineSession 幂等命中不写盘）→ failOn=3
  failOn = 3
  const res = await runScript({ script, runId: 's7-halt', journal, driver }, { now: fixedClock(), sleep: instantSleep })
  assert.equal(res.status, 'blocked', 'ask2 的 ask 事件写败 → halted → blocked')
  assert.equal(res.reason, SCRIPT_JOURNAL_NOT_OK)
  assert.equal(createCount(driver), 2, 'ask2 的 create 已发生（写败点在其后的 ask 事件落账）')
  assert.equal(res.journal.degraded, true, 'journal 显式读数 degraded')
  ok('journal 变坏 mid-run：blocked + halted 后不再记账（journal 化 driver 拒后续宿主动作）')
}

// ---- 8. F.run 纪律（terminal-gate：close 才结论；error 必捕；timeout kill 后等 close；预览截断）----
console.log('8. F.run 纪律')
{
  // 非零退出码 = 值不是异常：脚本继续拿 exitCode 分支
  const journal = createJournal({ storage: memStorage(), runId: 's8-nz', now: fixedClock() })
  const driver = createDriver('mock', { scenarios: [] })
  const { spawnFn } = fakeSpawnFactory({ stdout: 'partial', stderr: 'E: bad', exitCode: 3 })
  const script = [`const r = await F.run('probe', ['a'])`, `F.log('code=' + r.exitCode)`, `return { code: r.exitCode, err: r.stderr }`].join('\n')
  const res = await runScript({ script, runId: 's8-nz', journal, driver }, { now: fixedClock(), spawn: spawnFn })
  assert.equal(res.status, 'completed', '非零退出码不炸脚本（值非异常）')
  assert.deepEqual(JSON.parse(JSON.stringify(res.value)), { code: 3, err: 'E: bad' })
  ok('非零退出码：值不是异常，脚本照常推进')
}
{
  // spawn error（ENOENT 形状）：error 必捕（不静默丢进程）→ exitCode null + spawnError，脚本照常
  const journal = createJournal({ storage: memStorage(), runId: 's8-err', now: fixedClock() })
  const driver = createDriver('mock', { scenarios: [] })
  const { spawnFn } = fakeSpawnFactory({ error: Object.assign(new Error('spawn fake ENOENT'), { code: 'ENOENT' }), exitCode: null })
  const script = `const r = await F.run('nope', [])\nreturn r.spawnError.code`
  const res = await runScript({ script, runId: 's8-err', journal, driver }, { now: fixedClock(), spawn: spawnFn })
  assert.equal(res.status, 'completed', 'spawn 失败也是值（不异常）')
  assert.equal(res.value, 'ENOENT', 'spawnError 回流脚本')
  assert.equal(res.runs[0].exitCode, null, 'spawn 失败 exitCode=null')
  assert.deepEqual(res.runs[0].spawnError, { code: 'ENOENT', message: 'spawn fake ENOENT' })
  ok('spawn error 必捕：exitCode null + spawnError（terminal-gate 不静默）')
}
{
  // timeout：注入 sleep 手控竞跑 → kill(SIGTERM) → 仍等 close（不孤儿）→ timedOut true
  const storage = memStorage()
  const journal = createJournal({ storage, runId: 's8-to', now: fixedClock() })
  const driver = createDriver('mock', { scenarios: [] })
  const { spawnFn, spawned } = fakeSpawnFactory({ holdUntilKill: true, stdout: 'partial-before-kill' })
  let release
  const runP = runScript(
    { script: `const r = await F.run('hang', [], { timeoutMs: 500 })\nreturn r.timedOut`, runId: 's8-to', journal, driver },
    { now: fixedClock(), spawn: spawnFn, sleep: () => new Promise((r) => (release = r)) },
  )
  assert.ok(release !== undefined, '竞跑 promise 已挂上（execRun 同步段注册——main 的首个 await 前全部同步执行）')
  release() // 手控竞跑：超时臂赢 → kill → close
  const res = await runP
  assert.equal(res.status, 'completed')
  assert.equal(res.value, true, 'timedOut=true 回流')
  assert.deepEqual(spawned[0].child.killCalls, ['SIGTERM'], 'kill(SIGTERM) 恰一次')
  assert.equal(res.runs[0].timedOut, true)
  assert.equal(res.runs[0].exitCode, null, 'kill 后 close(null)')
  assert.equal(res.runs[0].stdout, 'partial-before-kill', 'kill 前的输出不丢（等 close 而非 exit——terminal-gate）')
  const events = diskEvents(storage)
  assert.equal(events.at(-1).payload.timedOut, true, 'journal run 事件带 timedOut')
  ok('F.run timeout：kill 后等 close + timedOut 记账（注入 sleep 竞跑，无真实定时器）')
}
{
  // journal 预览截断：stdout 超 512 → 盘上只落 512 + truncated 标记；脚本仍拿全文
  const storage = memStorage()
  const journal = createJournal({ storage, runId: 's8-cap', now: fixedClock() })
  const driver = createDriver('mock', { scenarios: [] })
  const { spawnFn } = fakeSpawnFactory({ stdout: 'x'.repeat(600), exitCode: 0 })
  const script = `const r = await F.run('big', [])\nreturn r.stdout.length`
  const res = await runScript({ script, runId: 's8-cap', journal, driver }, { now: fixedClock(), spawn: spawnFn })
  assert.equal(res.value, 600, '脚本拿全文（收集帽 10MiB 内）')
  const runEvent = diskEvents(storage).at(-1).payload
  assert.equal(runEvent.stdout, 'x'.repeat(SCRIPT_DEFAULTS.runPreviewCap), '盘上预览恰 512 字符')
  assert.equal(runEvent.stdoutTruncated, true, 'truncated 标记（面板可见只展示了一部分）')
  ok('journal 预览截断：盘上 512 + truncated 标记；脚本拿全文')
}
{
  // 静态扫描单元面 + facade 参数面（TypeError → 脚本失败）
  assert.deepEqual(scanRunCommands(`F.run("echo", ["x"])`), ['echo'])
  assert.deepEqual(scanRunCommands(`F.run( 'ls' ,[])`), ['ls'])
  assert.deepEqual(scanRunCommands(`F.run(\n  'multi'\n)`), ['multi'], '跨行空白')
  assert.deepEqual(scanRunCommands('F.run(`tpl`)'), [], '模板字符串不可静态捕获（v1 偏差）')
  assert.deepEqual(scanRunCommands(`const c = 'var-cmd'\nF.run(c)`), [], '变量命令不可静态捕获（v1 偏差）')
  assert.deepEqual(scanRunCommands(`F.run("a")\nF.run("a")\nF.run("b")\nF.run('a')`), ['a', 'b'], '去重（首见序）+ 双单引号等值合并')
  assert.deepEqual(scanRunCommands(`F.run("esc \\"q\\"\\n next", [])`), ['esc "q"\n next'], '双引号转义解码（JSON 语义）')
  assert.deepEqual(scanRunCommands('G.run("x")\nF.runn("y")\nmyF.run("z")'), [], '只认 F.run(（不误捕 G.run/F.runn/myF.run）')
  assert.deepEqual(scanRunCommands(''), [], '空脚本空集')

  const run = async (body) => {
    const journal = createJournal({ storage: memStorage(), runId: 's8-args', now: fixedClock() })
    const driver = createDriver('mock', { scenarios: [] })
    return runScript({ script: body, runId: 's8-args', journal, driver }, { now: fixedClock(), sleep: instantSleep })
  }
  const bad = async (body, re, label) => {
    const res = await run(body)
    assert.equal(res.status, 'failed', `${label} → 脚本失败`)
    assert.match(res.error, re, label)
  }
  await bad(`F.phase(123)`, /非空字符串/, 'F.phase 非字符串')
  await bad(`F.phase('')`, /非空字符串/, 'F.phase 空串')
  await bad(`F.log(42)`, /非空字符串/, 'F.log 非字符串')
  await bad(`F.run('', [])`, /非空字符串/, 'F.run 空 cmd')
  await bad(`F.run('x', [1])`, /字符串数组/, 'F.run args 非字符串数组')
  await bad(`F.run('x', [], { timeoutMs: 0 })`, /≥1 整数/, 'F.run timeoutMs=0')
  await bad(`F.run('x', [], { cwd: '.' })`, /未知 opts 字段/, 'F.run opts 未知键拒')
  // F.ask 是 async——校验失败走 rejected promise，脚本必须 await 才能收到（SKILL 纪律：facade 全 await）
  await bad(`await F.ask('x', { foo: 1 })`, /未知 opts 字段/, 'F.ask opts 未知键拒')
  await bad(`await F.ask('', {})`, /非空字符串/, 'F.ask 空 instructions')
  await bad(`await F.ask('x', { schema: 5 })`, /JSON Schema 对象/, 'F.ask schema 非对象')
  await bad(`F.escalate('')`, /非空字符串/, 'F.escalate 空问句')
  await bad(`F.hole('', 'q')`, /非空字符串/, 'F.hole 空 name')
  ok('静态扫描单元面 + facade 参数面（严格未知键拒）')
}

// ---- 9. 真实 spawn（缺省 spawnFn = node:child_process.spawn 的活线）----
console.log('9. 真实 spawn（node -e 回声）')
{
  const storage = memStorage()
  const journal = createJournal({ storage, runId: 's9-real', now: fixedClock() })
  const driver = createDriver('mock', { scenarios: [] })
  // process 不注入 vm——执行路径从 host 拼进脚本源码
  const body = `const r = await F.run(${JSON.stringify(process.execPath)}, ['-e', 'console.log("real-spawn-ok")'])\nreturn { code: r.exitCode, out: r.stdout }`
  const res = await runScript({ script: body, runId: 's9-real', journal, driver }, { now: fixedClock() })
  assert.equal(res.status, 'completed', '真实子进程端到端 completed')
  const returned = JSON.parse(JSON.stringify(res.value)) // vm realm 对象剥原型
  assert.equal(returned.code, 0, 'node -e 退出码 0')
  assert.ok(returned.out.includes('real-spawn-ok'), 'stdout 回收（close 后结论，stdio 排干）')
  const runEvent = diskEvents(storage).at(-1)
  assert.equal(runEvent.type, 'run', 'run 事件落盘')
  assert.equal(runEvent.payload.exitCode, 0)
  ok('真实 spawn：node -e 回声 → exitCode 0 + stdout 回收')
}

// ---- 10. M2.2 resume 脚本模式（kill/resume 脚本版；callSeq 不变量）----
console.log('10. M2.2 resume 脚本模式')
{
  // kill 场景：run A 完成 ask1（=42）后被杀——ask2 的 create 挂死永不返回（合成等价）。
  // 脚本用 ask1 的值做分支：缓存值恒等首跑 → run B 必然走同一分支（不变量③的可观察证据）。
  const P1 = '甲: 给个数'
  const PBIG = '乙: 大数分支的产出'
  const PSMALL = '乙: 小数分支的产出'
  const script = [
    `const a = await F.ask(${JSON.stringify(P1)})`,
    `const b = a >= 10 ? await F.ask(${JSON.stringify(PBIG)}) : await F.ask(${JSON.stringify(PSMALL)})`,
    `return { a, b }`,
  ].join('\n')
  const RUN = 's10-kill'

  // ---- run A：被杀现场（不 await；late rejection 吞掉）----
  const storage = memStorage()
  const journalA = createJournal({ storage, runId: RUN, now: fixedClock() })
  const baseA = createDriver('mock', { scenarios: [sc(P1, '42')] })
  const hangDriver = {
    calls: baseA.calls,
    create: async (args) => (args.prompt === PBIG ? new Promise(() => {}) : baseA.create(args)),
    result: (sessionId) => baseA.result(sessionId),
    context: (sessionId) => baseA.context(sessionId),
  }
  const killed = runScript({ script, runId: RUN, journal: journalA, driver: hangDriver }, { now: fixedClock(), sleep: instantSleep })
  killed.catch(() => {}) // 被杀现场：promise 永不结算；防 late rejection
  // ask2 挂死前，ask1 的链（全微任务）必先落账——排水至盘上出现 ask 事件再读缓存
  const ask1Recorded = await drainUntil(() => {
    const raw = storage.read()
    return raw !== null && JSON.parse(raw).events.some((e) => e.type === 'ask')
  })
  assert.equal(ask1Recorded, true, '被杀前 ask1 已落账（等待确定性的微任务排水）')
  const resume1 = resumeScript(script, storage, RUN)
  assert.equal(resume1.ok, true, 'kill 后盘上可读')
  assert.equal(resume1.fingerprint, scriptFingerprint(script), 'fingerprint = sha256(当前脚本)')
  assert.equal(resume1.reason, null)
  assert.equal(resume1.cached.size, 1, '已完成 ask 恰 1 笔进缓存')
  assert.equal(resume1.cached.get(1).value, '42', '缓存值 = run A 首跑值（无 schema → 纯文本）')
  assert.equal(resume1.cached.get(1).cacheKey, askCacheKey(script, 1), '缓存条目带缓存键')
  assert.equal(resume1.cached.has(2), false, '未终态 ask（create 挂死，零产出）无缓存')
  assert.equal(resume1.matchedCount, 1)

  // ---- run B（resume 重跑，同一 journal）：ask1 零 driver 调用返还；ask2 无缓存真跑 ----
  const journalB = createJournal({ storage, runId: RUN, now: fixedClock() })
  const driverB = createDriver('mock', { scenarios: [sc(P1, '42'), sc(PBIG, '7')] }) // P1 场景在而不用——证零 create
  const broadcastB = []
  const resB = await runScript(
    { script, runId: RUN, journal: journalB, driver: driverB },
    { now: fixedClock(), sleep: instantSleep, askCache: resume1.cached, onEvent: (e) => broadcastB.push(e.type) },
  )
  assert.equal(resB.status, 'completed', 'resume 重跑到 completed')
  assert.equal(createCount(driverB), 1, '已完成 ask 零 driver 调用（只有 ask2 的 create）')
  assert.deepEqual(
    createArgs(driverB).map((a) => a.prompt),
    [PBIG],
    '分支连续性（不变量③）：缓存值 42 → 大数分支，与 run A 的分支逐位一致',
  )
  assert.equal(resB.asks[0].cached, true, 'ask1 镜像带 cached:true')
  assert.equal(resB.asks[0].value, '42', '缓存命中恒等首跑值（不变量③）')
  assert.equal(resB.asks[0].callSeq, 1, 'callSeq 照常分配（命中不额外消耗序号——不变量①）')
  assert.equal(resB.asks[0].cacheKey, askCacheKey(script, 1))
  assert.equal(resB.asks[1].cached, undefined, 'ask2 真跑无 cached 标记')
  assert.equal(resB.asks[1].value, '7', '未终态 ask 重跑无缓存真跑')
  assert.deepEqual(broadcastB, ['ask', 'script-completed'], '命中零 journal 写零广播；ask2 照常落盘广播')
  const eventsB = diskEvents(storage)
  assert.deepEqual(
    eventsB.map((e) => e.type),
    ['ask', 'ask'],
    '盘上恰两笔 ask 事件：ask1（run A 的原笔）+ ask2（run B 真跑）——命中不重复记账',
  )
  assert.equal(eventsB[0].payload.callSeq, 1)
  assert.equal(eventsB[1].payload.callSeq, 2)
  assert.equal(eventsB[1].payload.value, '7')
  assert.equal(journalB.isEngineSession(resB.asks[1].sessionId), true, '真跑 ask2 照常 markEngineSession')
  ok('kill/resume：已完成 ask 零 driver 调用返还 + 未终态 ask 真跑 + 分支逐位一致（不变量③）')
}
{
  // C1 v2（有意推翻 v1「脚本哈希变更 → 全量重跑」断言）：中段变更 → 该点（含）之后弃用、
  // 前缀仍导入。`>= 10` → `> 10` 在 ask2 的调用点之前 → ask2 的 prefixHash/site 实算都不符 →
  // 命中复核否决 callSeq 2 起缓存；ask1（变更点之前）照常导入零 driver 调用。
  const P1 = '甲: 给个数'
  const PBIG = '乙: 大数分支的产出'
  const script = `const a = await F.ask(${JSON.stringify(P1)})\nconst b = a >= 10 ? await F.ask(${JSON.stringify(PBIG)}) : await F.ask(${JSON.stringify(PBIG)})\nreturn { a, b }`
  const RUN = 's10-hash'
  const storage = memStorage()
  const journalA = createJournal({ storage, runId: RUN, now: fixedClock() })
  const driverA = createDriver('mock', { scenarios: [sc(P1, '42'), sc(PBIG, '7')] })
  await runScript({ script, runId: RUN, journal: journalA, driver: driverA }, { now: fixedClock(), sleep: instantSleep })
  assert.equal(createCount(driverA), 2, '首跑两 ask 都真跑（对照）')

  const script2 = script.replace('>= 10', '> 10') // 一字之差，语义同
  const resume2 = resumeScript(script2, storage, RUN)
  assert.equal(resume2.ok, true, '盘上记录本身完好')
  assert.notEqual(resume2.fingerprint, scriptFingerprint(script), '指纹随脚本变（诊断链如实反映）')
  assert.equal(resume2.askEventCount, 2, '盘上两笔 ask 事件仍在（诊断面如实计数）')
  assert.equal(resume2.cached.size, 2, '读端只做形状/条件②把关——字节比对在命中复核（两笔都在缓存里待验）')
  assert.equal(resume2.matchedCount, 2)

  const journalC = createJournal({ storage: memStorage(), runId: RUN, now: fixedClock() })
  const driverC = createDriver('mock', { scenarios: [sc(P1, '42'), sc(PBIG, '7')] })
  const resC = await runScript({ script: script2, runId: RUN, journal: journalC, driver: driverC }, { now: fixedClock(), sleep: instantSleep, askCache: resume2.cached })
  assert.equal(resC.status, 'completed')
  assert.equal(createCount(driverC), 1, '该点（callSeq 2）弃用真跑：只有 ask2 一次 create')
  assert.equal(resC.asks[0].cached, true, '前缀有效 → 导入（ask1 零重跑）')
  assert.equal(resC.asks[0].value, '42', '导入值恒等首跑')
  assert.equal(resC.asks[1].cached, undefined, 'ask2 命中复核否决 → 真跑')
  assert.equal(resC.asks[1].value, '7')
  ok('中段变更（v1 全量重跑断言的有意推翻）：该点弃用、前缀仍导入——「前缀有效 → 导入」')
}
{
  // throw 后 resume（M2.1 打捞的续跑半边）：已完成 ask 零 driver 调用——即使重跑仍失败
  const P = '给个数'
  const scriptT = [`const a = await F.ask(${JSON.stringify(P)})`, `F.log('half')`, `throw new Error('killed-2')`].join('\n')
  const RUN = 's10-throw'
  const storageT = memStorage()
  const journalT1 = createJournal({ storage: storageT, runId: RUN, now: fixedClock() })
  const driverT1 = createDriver('mock', { scenarios: [sc(P, '{"a": 9}')] })
  const resT1 = await runScript(
    { script: scriptT, runId: RUN, journal: journalT1, driver: driverT1 },
    { now: fixedClock(), sleep: instantSleep },
  )
  assert.equal(resT1.status, 'failed', '首跑 throw（M2.1 失败语义）')
  const resumeT = resumeScript(scriptT, storageT, RUN)
  assert.equal(resumeT.ok, true)
  assert.equal(resumeT.cached.size, 1, 'throw 前的已完成 ask 在缓存里')

  const journalT2 = createJournal({ storage: memStorage(), runId: RUN, now: fixedClock() })
  const driverT2 = createDriver('mock', { scenarios: [sc(P, '{"a": 9}')] }) // 场景在而不用
  const resT2 = await runScript(
    { script: scriptT, runId: RUN, journal: journalT2, driver: driverT2 },
    { now: fixedClock(), sleep: instantSleep, askCache: resumeT.cached },
  )
  assert.equal(createCount(driverT2), 0, '已完成 ask 零 driver 调用——与 run 终局无关')
  assert.equal(resT2.asks[0].cached, true)
  assert.equal(resT2.status, 'failed', '同脚本重跑仍在 throw 处失败（脚本不变，结局不变——确定性）')
  assert.equal(resT2.asks.length, 1, '缓存条目在镜像里（打捞）')
  ok('throw 后 resume：已完成 ask 零 driver 调用，重跑结局仍由脚本决定')
}
{
  // resumeScript 单元面：保守判定 + 过滤规则 + 参数面
  const P = '给个数'
  const script = `await F.ask(${JSON.stringify(P)})`

  // 空盘 = 全新 run（ok:true 零缓存——正确答案，不是失败）
  const fresh = resumeScript(script, memStorage(), 'r-fresh')
  assert.equal(fresh.ok, true)
  assert.equal(fresh.cached.size, 0)
  assert.equal(fresh.askEventCount, 0)

  // torn / 形状坏 / runId 不符 / read 抛错 → ok:false 空 Map（宁可整段重跑，不可假完成）
  assert.deepEqual([...RESUME_SCRIPT_MISS_REASONS], ['read-error', 'unparseable', 'shape-invalid', 'run-mismatch'], 'miss reason 枚举')
  const torn = resumeScript(script, memStorage('{broken'), 'r-torn')
  assert.equal(torn.ok, false)
  assert.equal(torn.reason, 'unparseable')
  assert.equal(torn.cached.size, 0, 'torn：空缓存（可能藏着完成 ask 也不假完成）')
  const shapeBad = resumeScript(script, memStorage('{"foo": 1}'), 'r-shape')
  assert.equal(shapeBad.ok, false)
  assert.equal(shapeBad.reason, 'shape-invalid')
  const storageMismatch = memStorage()
  const journalOther = createJournal({ storage: storageMismatch, runId: 'other-run', now: fixedClock() })
  journalOther.recordEvent('log', { message: 'x' })
  const mismatch = resumeScript(script, storageMismatch, 'r-mm')
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.reason, 'run-mismatch')
  const readThrows = { read: () => { throw new Error('disk yanked') } }
  const readErr = resumeScript(script, readThrows, 'r-re')
  assert.equal(readErr.ok, false)
  assert.equal(readErr.reason, 'read-error')
  assert.equal(readErr.error, 'disk yanked')

  // last-wins / ask-failed 不进缓存 / 证据形状把关（C1 v2：形状坏 = 该点截断，不再只是跳过该笔）
  const HEX_A = 'a'.repeat(64)
  const HEX_B = 'b'.repeat(64)
  const HEX_C = 'c'.repeat(64)
  const EV = { site: { line: 1, col: 5 }, promptHash: HEX_A, prefixHash: HEX_B, optsHash: HEX_C } // 读端只做形状把关，哈希内容可任意
  const storageDup = memStorage()
  const journalDup = createJournal({ storage: storageDup, runId: 'r-dup', now: fixedClock() })
  journalDup.recordEvent('ask', { callSeq: 1, cacheKey: askCacheKey(script, 1), stepId: 'script-ask-1', value: 'first', attempts: 1, ...EV })
  journalDup.recordEvent('ask', { callSeq: 1, cacheKey: askCacheKey(script, 1), stepId: 'script-ask-1', value: 'second', attempts: 3, sessionId: 'sess_x', ...EV })
  journalDup.recordEvent('ask-failed', { callSeq: 2, cacheKey: askCacheKey(script, 2), stepId: 'script-ask-2', reason: 'invalid-output', attempts: 3 })
  journalDup.recordEvent('ask', { callSeq: 3, cacheKey: 'k3', stepId: 'script-ask-3', value: 'no-evidence' }) // 无作用点证据（v1 形账本）→ 该点截断
  journalDup.recordEvent('ask', { callSeq: 4, cacheKey: 'k4', stepId: 'script-ask-4', value: 'junk-after-cut', ...EV }) // 截断之后 → 不导入
  journalDup.recordEvent('hole-answered', { seq: 1, name: '门', answer: 'x' }) // 条件②判据事件（截断已发生，如实翻旗）
  journalDup.recordEvent('ask', { callSeq: 5, cacheKey: 'k5', stepId: 'script-ask-5', ...EV }) // 缺 value → 形状坏（已在截断后，照计不导入）
  const dup = resumeScript(script, storageDup, 'r-dup')
  assert.equal(dup.ok, true)
  assert.equal(dup.askEventCount, 5, 'type=ask 事件恰 5 笔（ask-failed 的 1 笔不计入；弃用/截断的不剔除）')
  assert.equal(dup.cached.size, 1, '只有 callSeq 1 进缓存（3 形状截断、4 截断后、5 截断后）')
  assert.equal(dup.cached.get(1).value, 'second', '同 callSeq 末笔为准（盘上真相的最新值）')
  assert.equal(dup.cached.get(1).sessionId, 'sess_x')
  assert.deepEqual(dup.cached.get(1).site, { line: 1, col: 5 }, '作用点证据随条目透传（script-runner 命中复核的输入）')
  assert.equal(dup.cached.get(1).promptHash, HEX_A)
  assert.equal(dup.cached.has(2), false, 'ask-failed 不进缓存（失败重跑真跑——重试语义在 typedAsk）')
  assert.equal(dup.cached.has(3), false, '证据形状坏 → 该点截断（v1 是跳过该笔——v2 升为截断，对齐链存疑宁多跑）')
  assert.equal(dup.cached.has(4), false, '截断之后的合规事件也不导入（该点之后全部弃用）')
  assert.equal(dup.cached.has(5), false)

  // v1 账本（无作用点证据）→ 第一个 ask 即截断 → 空缓存全量重跑（ok:true 不是失败——宁多跑不假完成）
  const storageV1 = memStorage()
  const journalV1 = createJournal({ storage: storageV1, runId: 'r-v1', now: fixedClock() })
  journalV1.recordEvent('ask', { callSeq: 1, cacheKey: askCacheKey(script, 1), stepId: 'script-ask-1', value: '42', attempts: 1 })
  const legacy = resumeScript(script, storageV1, 'r-v1')
  assert.equal(legacy.ok, true)
  assert.equal(legacy.cached.size, 0, 'v1 账本无证据 → 全量重跑')
  assert.equal(legacy.matchedCount, 0)

  // 条件②独立面（读端按事件序前缀裁决）：未答复挂起不翻旗；hole-answered 起「该点之后全部弃用」
  const storageHole = memStorage()
  const journalHole = createJournal({ storage: storageHole, runId: 'r-hole', now: fixedClock() })
  journalHole.recordEvent('ask', { callSeq: 1, cacheKey: 'k1', stepId: 's1', value: 'v1', attempts: 1, ...EV })
  journalHole.recordEvent('hole', { seq: 1, name: '门', question: '过吗?' }) // 挂起中（未答复）——②只数 answered 事件
  journalHole.recordEvent('ask', { callSeq: 2, cacheKey: 'k2', stepId: 's2', value: 'v2', attempts: 1, ...EV }) // 前缀仍无 answered → 导入（合成序；自然执行不会出现）
  journalHole.recordEvent('hole-answered', { seq: 1, name: '门', answer: 'x' }) // 答复入账 → 其后一切 ask 不可信
  journalHole.recordEvent('ask', { callSeq: 3, cacheKey: 'k3', stepId: 's3', value: 'v3', attempts: 1, ...EV }) // 该点弃用
  const holeCase = resumeScript(script, storageHole, 'r-hole')
  assert.equal(holeCase.ok, true)
  assert.deepEqual([...holeCase.cached.keys()], [1, 2], '未答复挂起不翻旗（1、2 导入）；answered 事件起截断（3 弃用）')
  assert.equal(holeCase.askEventCount, 3, '诊断面如实计数（弃用的 ask 也计）')

  // 参数面
  assert.throws(() => resumeScript('', memStorage(), 'r'), TypeError, 'script 空串拒')
  assert.throws(() => resumeScript(script, memStorage(), ''), TypeError, 'runId 空串拒')
  assert.throws(() => resumeScript(script, {}, 'r'), TypeError, 'storage 缺 read 拒')
  assert.throws(() => resumeScript(script, null, 'r'), TypeError, 'storage null 拒')
  ok('resumeScript 单元面：torn 四形空缓存 + last-wins + ask-failed 不进缓存 + 证据形状坏/条件② 该点截断 + v1 账本全量重跑 + 参数面')
}
{
  // askCache 接线参数面 + Promise.all 内混合（命中/真跑）序号
  const journal = createJournal({ storage: memStorage(), runId: 's10-wire', now: fixedClock() })
  const driver = createDriver('mock', { scenarios: [] })
  await assert.rejects(
    runScript({ script: 'return 1', runId: 's10-wire', journal, driver }, { now: fixedClock(), askCache: { 1: { value: 'x' } } }),
    TypeError,
    'askCache 非 Map 应拒',
  )
  // Promise.all 混合：ask1 命中、ask2 真跑——序号 = 数组求值序，命中不额外消耗
  const P1 = '甲'
  const P2 = '乙'
  const script = `const r = await Promise.all([F.ask(${JSON.stringify(P1)}), F.ask(${JSON.stringify(P2)})])\nreturn r`
  const storageMix = memStorage()
  const journalMix1 = createJournal({ storage: storageMix, runId: 's10-mix', now: fixedClock() })
  const baseMix1 = createDriver('mock', { scenarios: [sc(P1, '{"n": 1}'), sc(P2, '{"n": 2}')] })
  const driverMix1 = {
    calls: baseMix1.calls,
    create: async (args) => (args.prompt === P2 ? new Promise(() => {}) : baseMix1.create(args)), // ask2 挂死（合成 kill）
    result: (sessionId) => baseMix1.result(sessionId),
    context: (sessionId) => baseMix1.context(sessionId),
  }
  const runMix1 = runScript({ script, runId: 's10-mix', journal: journalMix1, driver: driverMix1 }, { now: fixedClock(), sleep: instantSleep })
  // 中途放弃：排水至 ask1 落账后弃掉（合成 kill）——ask2 未完成
  const mixRecorded = await drainUntil(() => {
    const raw = storageMix.read()
    return raw !== null && JSON.parse(raw).events.some((e) => e.type === 'ask')
  })
  assert.equal(mixRecorded, true, '放弃前 ask1 已落账')
  runMix1.catch(() => {})
  const mixCache = resumeScript(script, storageMix, 's10-mix')
  assert.ok(mixCache.ok)
  assert.equal(mixCache.cached.size, 1, 'ask1 命中、ask2（挂死）无缓存')
  assert.equal(mixCache.cached.has(2), false)
  const journalMix2 = createJournal({ storage: memStorage(), runId: 's10-mix', now: fixedClock() })
  const driverMix2 = createDriver('mock', { scenarios: [sc(P1, '{"n": 1}'), sc(P2, '{"n": 2}')] })
  const resMix2 = await runScript(
    { script, runId: 's10-mix', journal: journalMix2, driver: driverMix2 },
    { now: fixedClock(), sleep: instantSleep, askCache: mixCache.cached },
  )
  assert.equal(resMix2.status, 'completed')
  assert.deepEqual(resMix2.asks.map((a) => a.callSeq), [1, 2], 'Promise.all 序号 = 数组求值序（混合命中/真跑不乱序）')
  assert.equal(createCount(driverMix2), 1, '只有未完成的 ask2 真跑')
  ok('askCache 接线：非 Map 拒 + Promise.all 混合命中/真跑序号稳定')
}

// ---- 11. C1 resume-script v2 作用点位置匹配（蓝图 optimization-plan-v3.md「C1」行验收五条）----
console.log('11. C1 v2 作用点位置匹配（amend）')
{
  // 证据域钉面（写端四件套的形状与换算）：site = 脚本体坐标（vm 包装头部 4 行已换算扣除）；
  // promptHash = sha256(instructions 原文，不含重派附错文本)；prefixHash = sha256(脚本体
  // [0, 调用点偏移))；optsHash = sha256({schema,agent,model}) 形状 64-hex；cacheKey 照旧落盘（诊断链）。
  const P1 = '域: 给个数'
  const script = `F.phase('p')\nconst a = await F.ask(${JSON.stringify(P1)}, { agent: 'scout' })\nreturn a`
  const storage = memStorage()
  const journal = createJournal({ storage, runId: 's11-domain', now: fixedClock() })
  const driver = createDriver('mock', { scenarios: [sc(P1, '42')] })
  const res = await runScript({ script, runId: 's11-domain', journal, driver }, { now: fixedClock(), sleep: instantSleep })
  assert.equal(res.status, 'completed')
  const payload = diskEvents(storage).find((e) => e.type === 'ask').payload
  assert.equal(payload.site.line, 2, 'site 是脚本体坐标：ask 在体第 2 行（vm 栈行号 - 包装头部 4 行）')
  assert.ok(Number.isInteger(payload.site.col) && payload.site.col >= 1, 'col 为 1-based 正整数（V8 调用点列）')
  assert.equal(payload.promptHash, createHash('sha256').update(P1, 'utf8').digest('hex'), 'promptHash = sha256(prompt 原文)')
  const lineStart = script.indexOf('\n') + 1
  const offset = lineStart + payload.site.col - 1
  assert.equal(
    payload.prefixHash,
    createHash('sha256').update(script.slice(0, offset), 'utf8').digest('hex'),
    'prefixHash = sha256(脚本体调用点前前缀)——条件①的字节证据',
  )
  assert.equal(/^[0-9a-f]{64}$/.test(payload.optsHash), true, 'optsHash 64-hex（schema/agent/model 身份门）')
  assert.equal(payload.cacheKey, askCacheKey(script, 1), 'cacheKey 照旧落盘（v2 起仅作诊断链）')
  ok('C1-0 证据域：site 脚本体坐标 + promptHash/prefixHash 精确域 + optsHash 形状 + cacheKey 诊断链')
}
{
  // C1 验收①：改尾部 → 前缀零重跑。return 行在一切调用点之后 → 两 ask 的前缀哈希/位置/prompt 全不变。
  const P1 = '尾改 甲: 给个数'
  const P2 = '尾改 乙: 产出'
  const mk = (tail) => `const a = await F.ask(${JSON.stringify(P1)})\nconst b = await F.ask(${JSON.stringify(P2)})\n${tail}`
  const script = mk('return { a, b }')
  const RUN = 's11-tail'
  const storage = memStorage()
  const journalA = createJournal({ storage, runId: RUN, now: fixedClock() })
  const driverA = createDriver('mock', { scenarios: [sc(P1, '1'), sc(P2, '2')] })
  const resA = await runScript({ script, runId: RUN, journal: journalA, driver: driverA }, { now: fixedClock(), sleep: instantSleep })
  assert.equal(resA.status, 'completed')
  assert.equal(createCount(driverA), 2, '首跑两 ask 都真跑（对照）')

  const script2 = mk(`return { a, b, tail: 'amended' }`) // 只改 return 行（一切调用点之后）
  const resume1 = resumeScript(script2, storage, RUN)
  assert.equal(resume1.ok, true)
  assert.equal(resume1.cached.size, 2, '改尾部：两 ask 都进缓存（读端形状/条件②全过）')

  const journalB = createJournal({ storage: memStorage(), runId: RUN, now: fixedClock() })
  const driverB = createDriver('mock', { scenarios: [sc(P1, '1'), sc(P2, '2')] }) // 场景在而不用——证零 create
  const broadcastB = []
  const resB = await runScript(
    { script: script2, runId: RUN, journal: journalB, driver: driverB },
    { now: fixedClock(), sleep: instantSleep, askCache: resume1.cached, onEvent: (e) => broadcastB.push(e.type) },
  )
  assert.equal(resB.status, 'completed')
  assert.equal(createCount(driverB), 0, '前缀零重跑：ask 零 driver 调用')
  assert.equal(resB.asks.filter((a) => a.cached === true).length, 2, '两 ask 全部命中')
  assert.deepEqual(JSON.parse(JSON.stringify(resB.value)), { a: '1', b: '2', tail: 'amended' }, '值恒等首跑 + 新尾部真执行')
  assert.deepEqual(broadcastB, ['script-completed'], '命中零 journal 写零广播')
  ok('C1-1 改尾部 → 前缀零重跑（ask 全导入，新尾部真执行）')
}
{
  // C1 验收②：改头部 → 全重跑。头部加一行 → 一切调用点之前字节位移 → 前缀哈希/位置全不符
  // → 命中复核在 callSeq 1 否决 → cacheVoidFrom 起全弃用（读端仍照形状装缓存——字节比对在命中时点）。
  const P1 = '头改 甲: 给个数'
  const P2 = '头改 乙: 产出'
  const mk = (head) => `${head}const a = await F.ask(${JSON.stringify(P1)})\nconst b = await F.ask(${JSON.stringify(P2)})\nreturn { a, b }`
  const script = mk('')
  const RUN = 's11-head'
  const storage = memStorage()
  const journalA = createJournal({ storage, runId: RUN, now: fixedClock() })
  const driverA = createDriver('mock', { scenarios: [sc(P1, '1'), sc(P2, '2')] })
  const resA = await runScript({ script, runId: RUN, journal: journalA, driver: driverA }, { now: fixedClock(), sleep: instantSleep })
  assert.equal(resA.status, 'completed')
  assert.equal(createCount(driverA), 2, '首跑对照')

  const script2 = mk('const limit = 1000\n') // 头部加一行
  const resume2 = resumeScript(script2, storage, RUN)
  assert.equal(resume2.ok, true)
  assert.equal(resume2.cached.size, 2, '读端不比字节——两笔待验')

  const journalB = createJournal({ storage: memStorage(), runId: RUN, now: fixedClock() })
  const driverB = createDriver('mock', { scenarios: [sc(P1, '1'), sc(P2, '2')] })
  const resB = await runScript(
    { script: script2, runId: RUN, journal: journalB, driver: driverB },
    { now: fixedClock(), sleep: instantSleep, askCache: resume2.cached },
  )
  assert.equal(resB.status, 'completed')
  assert.equal(createCount(driverB), 2, '改头部：全重跑（两 ask 都真派发）')
  assert.equal(resB.asks.every((a) => a.cached === undefined), true, '无任何 cached 标记')
  ok('C1-2 改头部 → 全重跑（调用点之前字节位移，弃用下界 = callSeq 1）')
}
{
  // C1 验收③：前缀含 hole → 该点之后弃用。hole 答复是人输入的非确定源（答复无缓存面）——
  // 重跑在 hole 处重新挂起并取**新**答复（不拿旧答复假完成）；hole 之后的 ask 弃用真跑；
  // hole 之前的 ask 照常导入。run 不悬挂：答复源接住重挂起后照常 completed。
  const P1 = 'hole 甲: 给个数'
  const P2 = 'hole 乙: 产出'
  const mk = (tail) => `const a = await F.ask(${JSON.stringify(P1)})\nconst h = await F.hole('门', '过吗?')\nconst b = await F.ask(${JSON.stringify(P2)})\n${tail}`
  const script = mk('return { a, h, b }')
  const RUN = 's11-hole'
  const storage = memStorage()
  const journalA = createJournal({ storage, runId: RUN, now: fixedClock() })
  const driverA = createDriver('mock', { scenarios: [sc(P1, '1'), sc(P2, '2')] })
  let pollsA = 0
  const resA = await runScript(
    { script, runId: RUN, journal: journalA, driver: driverA },
    {
      now: fixedClock(),
      sleep: instantSleep,
      answerFor: () => {
        pollsA += 1
        return pollsA === 1 ? null : 'yes-首跑'
      },
    },
  )
  assert.equal(resA.status, 'completed')
  assert.deepEqual(diskEvents(storage).map((e) => e.type), ['ask', 'hole', 'hole-answered', 'ask'], '首跑事件序（ask2 在答复之后）')

  const script2 = mk(`return { a, h, b, tail: 'amended' }`)
  const resume3 = resumeScript(script2, storage, RUN)
  assert.equal(resume3.ok, true)
  assert.deepEqual([...resume3.cached.keys()], [1], '条件②：hole-answered 之后（含该点之后一切 ask）弃用——只导入 callSeq 1')

  const journalB = createJournal({ storage: memStorage(), runId: RUN, now: fixedClock() })
  const driverB = createDriver('mock', { scenarios: [sc(P1, '1'), sc(P2, '2-fresh')] }) // P2 场景给新值——证弃用真跑
  let pollsB = 0
  const resB = await runScript(
    { script: script2, runId: RUN, journal: journalB, driver: driverB },
    {
      now: fixedClock(),
      sleep: instantSleep,
      answerFor: () => {
        pollsB += 1
        return pollsB === 1 ? null : 'no-重跑'
      },
      askCache: resume3.cached,
    },
  )
  assert.equal(resB.status, 'completed', '重挂起由答复源接住——不悬挂')
  assert.equal(resB.value.h, 'no-重跑', 'hole 重新挂起取新答复（不拿旧答复假完成）')
  assert.equal(resB.value.b, '2-fresh', 'hole 之后的 ask 弃用真跑（旧缓存值 2 不回魂）')
  assert.deepEqual(createArgs(driverB).map((a) => a.prompt), [P2], 'ask1 零 driver 调用、ask2 真派发')
  assert.equal(resB.asks[0].cached, true)
  assert.equal(resB.asks[1].cached, undefined)
  ok('C1-3 前缀含 hole → 该点之后弃用（挂起重挂取新答复，弃用 ask 真跑，run 照常 completed）')
}
{
  // C1 验收④：前缀含 F.run → 副作用重执行如实计数。「零重跑」口径：ask 零重跑 ≠ 副作用零重
  // 执行——F.run 结果不进任何缓存，resume 照跑并逐次落 run 事件。
  const P1 = 'run 甲: 给个数'
  const P2 = 'run 乙: 产出'
  const mk = (tail) => `const a = await F.ask(${JSON.stringify(P1)})\nconst r = await F.run('probe', ['x'])\nconst b = await F.ask(${JSON.stringify(P2)})\n${tail}`
  const script = mk('return { a, b, code: r.exitCode }')
  const RUN = 's11-run'
  const storage = memStorage()
  const journalA = createJournal({ storage, runId: RUN, now: fixedClock() })
  const driverA = createDriver('mock', { scenarios: [sc(P1, '1'), sc(P2, '2')] })
  const { spawnFn, spawned } = fakeSpawnFactory({ stdout: 'ok', stderr: '', exitCode: 0 })
  const resA = await runScript({ script, runId: RUN, journal: journalA, driver: driverA }, { now: fixedClock(), sleep: instantSleep, spawn: spawnFn })
  assert.equal(resA.status, 'completed')
  assert.equal(spawned.length, 1, '首跑副作用恰一次')

  const script2 = mk('return { a, b, code: r.exitCode, tail: 1 }')
  const resume4 = resumeScript(script2, storage, RUN)
  assert.equal(resume4.cached.size, 2, 'run 事件不是弃用判据——两 ask 都可导入')

  const storageB = memStorage()
  const journalB = createJournal({ storage: storageB, runId: RUN, now: fixedClock() })
  const driverB = createDriver('mock', { scenarios: [sc(P1, '1'), sc(P2, '2')] }) // 场景在而不用
  const resB = await runScript(
    { script: script2, runId: RUN, journal: journalB, driver: driverB },
    { now: fixedClock(), sleep: instantSleep, spawn: spawnFn, askCache: resume4.cached },
  )
  assert.equal(resB.status, 'completed')
  assert.equal(createCount(driverB), 0, 'ask 零重跑')
  assert.equal(spawned.length, 2, '副作用零缓存：F.run 在任何 resume 都重执行（两 run 累计 1+1）')
  assert.equal(resB.runs.length, 1, '重跑侧 result.runs 如实记本次执行')
  assert.equal(diskEvents(storageB).filter((e) => e.type === 'run').length, 1, '重跑 journal 的 run 事件 = 1：副作用每次执行各落一笔，如实计数')
  ok('C1-4 前缀含 F.run → 副作用重执行如实计数（ask 零重跑 ≠ 副作用零重执行）')
}
{
  // C1 验收⑤：原位改 prompt 字节（行结构不变）→ 该点弃用。位置/前缀全不变，条件③
  // （promptHash 与重跑实算比对）拦下——critic round 2 F1 的静默错值注入面。
  const P1 = '原位 甲: 给个数'
  const PBIG = '原位 乙: 大数分支的产出'
  const PBIG2 = '原位 乙: 大数分支的产物' // 出→物 同字节数——行结构不变
  assert.equal(Buffer.byteLength(PBIG, 'utf8'), Buffer.byteLength(PBIG2, 'utf8'), '夹具自检：原位改字节等长')
  const mk = (big) => `const a = await F.ask(${JSON.stringify(P1)})\nconst b = a >= 10 ? await F.ask(${JSON.stringify(big)}) : await F.ask(${JSON.stringify(big)})\nreturn { a, b }`
  const script = mk(PBIG)
  const RUN = 's11-inplace'
  const storage = memStorage()
  const journalA = createJournal({ storage, runId: RUN, now: fixedClock() })
  const driverA = createDriver('mock', { scenarios: [sc(P1, '42'), sc(PBIG, '7')] })
  const resA = await runScript({ script, runId: RUN, journal: journalA, driver: driverA }, { now: fixedClock(), sleep: instantSleep })
  assert.equal(resA.status, 'completed')

  const script2 = mk(PBIG2)
  assert.equal(script2.length, script.length, '行结构不变（等长原位替换）')
  const resume5 = resumeScript(script2, storage, RUN)
  assert.equal(resume5.ok, true)
  assert.equal(resume5.cached.size, 2, '读端不比 prompt 字节——两笔待验')

  const journalB = createJournal({ storage: memStorage(), runId: RUN, now: fixedClock() })
  const driverB = createDriver('mock', { scenarios: [sc(P1, '42'), sc(PBIG2, '8')] }) // 新 prompt 的场景给新值
  const resB = await runScript(
    { script: script2, runId: RUN, journal: journalB, driver: driverB },
    { now: fixedClock(), sleep: instantSleep, askCache: resume5.cached },
  )
  assert.equal(resB.status, 'completed')
  assert.deepEqual(createArgs(driverB).map((a) => a.prompt), [PBIG2], '条件③：ask2 真跑拿的是新 prompt（旧值不回魂）')
  assert.equal(resB.asks[0].cached, true, 'ask1（prompt 未变、前缀未变）照常导入')
  assert.equal(resB.asks[1].cached, undefined, 'ask2 该点弃用')
  assert.equal(resB.value.b, '8')
  ok('C1-5 原位改 prompt 字节（行结构不变）→ 该点弃用（条件③拦下静默错值）')
}

console.log(`\n全部 ${passed} 项通过`)
