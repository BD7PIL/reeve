// E1 引擎生产 driver 测试（S7b 门；施工规格 .zcode/plans/e1-construction-spec.md §4-S7b / §5-T3.6 全量，
// 主计划 next-phase-plan-m1-m5.md M1.3，事实底座 findings-engine-face.md + wait 实测 + S7a probe）。
//
// 宿主差异收敛在 src/engine/driver-session.js；本文件用**全合成宿主 ctx**（shapes 照实测摆：
// create 扁平 .id / context 消息数组 {info,parts} / 事件 {type, location:{directory}}）+ 注入时钟/睡眠
// （§6 纪律：now/sleep/fault.driverChaos 全走构造参数，零真实定时器依赖、零真机访问、零回环 HTTP）。
//
// 钉死的关键行为（实测为准的 decisions，见 driver-session.js 文件头）：
//   wait 优先只试裸形、即时抛 "Expected object" → 降级继续 context 解析、不映射 failed、有界防挂死；
//   result = 单轮探针（done/failed/running 三值），重试节奏归调用方（driver 内零忙等）；
//   末条 assistant 判定（error 优先于 text）；空数组/末条非 assistant/形状认不出 = running；
//   回环 HTTP 兜底不存在（零 fetch）；events 规范化 + session.execution.* 出现即记形状 + 去抖 +
//   终末旁路 + trailing recheck + 心跳活性；chaos 三态与 mock/replay 同语义。
//
// 运行：node plugin/test/engine-driver-session.test.mjs（assert 失败即抛、非零退出；成功自然退出）
import assert from 'node:assert/strict'

import { run } from '../src/engine/scheduler.js'
import { createJournal } from '../src/engine/journal.js'
import {
  SESSION_DRIVER_DEFAULTS,
  SESSION_DRIVER_ERROR_CODES,
  createSessionDriver,
  isTerminalishEvent,
  judgeContext,
} from '../src/engine/driver-session.js'
import { DRIVER_ERROR_CODES } from '../src/engine/driver.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}
const caught = async (p) => {
  try {
    return { value: await p }
  } catch (e) {
    return { code: e.code, message: e.message }
  }
}
/** 排干微任务/即刻队列（泵收尾、hostIter.return 落地用；不引入真实等待）。 */
const drain = () => new Promise((resolve) => setImmediate(resolve))

// ---- 注入时钟/睡眠：tick 只动钟不 fire（去抖窗口），fire 只解 sleep 不动钟（trailing/心跳/有界赛跑）----
function mkTime({ start = 1_700_000_000_000 } = {}) {
  let t = start
  const pending = []
  return {
    now: () => t,
    tick: (ms) => {
      t += ms
    },
    sleep: (ms) =>
      new Promise((resolve) => {
        pending.push({ ms, resolve })
      }),
    fire: () => {
      const all = pending.splice(0)
      for (const p of all) p.resolve()
    },
    pendingCount: () => pending.length,
  }
}

// ---- 合成宿主 ctx（shapes 照实测摆；旋钮测试内改动）----
function mkHost() {
  const host = {
    createArgs: [],
    createResults: [], // 逐次弹出；空则合成 {id: ses_h_<n>}
    createError: null,
    promptArgs: [],
    promptError: null,
    contextArgs: [],
    contextQueue: [], // 逐次弹出；空则回 contextValue
    contextValue: [],
    contextError: null,
    contextHang: false,
    waitArgs: [],
    waitMode: 'throw', // 'throw'（实测 2.3.2 行为）| 'resolve' | 'hang'
    interruptArgs: [],
    interruptError: null,
  }
  let created = 0
  const ctx = {
    session: {
      async create(args) {
        host.createArgs.push(args)
        if (host.createError) throw host.createError
        created += 1
        return host.createResults.length > 0 ? host.createResults.shift() : { id: `ses_h_${created}` }
      },
      async prompt(args) {
        host.promptArgs.push(args)
        if (host.promptError) throw host.promptError
        return { id: 'prt_receipt', sessionID: args.sessionID, time: {}, type: 'prompt', payload: {}, delivery: 'direct' } // 实测回执形状
      },
      async context(args) {
        host.contextArgs.push(args)
        if (host.contextHang) return new Promise(() => {})
        if (host.contextError) throw host.contextError
        return host.contextQueue.length > 0 ? host.contextQueue.shift() : host.contextValue
      },
      async wait(sessionId) {
        host.waitArgs.push(sessionId)
        if (host.waitMode === 'throw') throw new Error('Expected object')
        if (host.waitMode === 'hang') return new Promise(() => {})
        return { idle: true }
      },
      async interrupt(args) {
        host.interruptArgs.push(args)
        if (host.interruptError) throw host.interruptError
      },
    },
  }
  return { ctx, host }
}

/** 手动事件总线（每次 subscribe = 一条独立活流，照 SSE/宿主 subscribe 语义；形状 {type, location:{directory}}）。 */
function mkEventSource() {
  const state = { returnCalled: 0, subscribeCount: 0 }
  const subs = new Set()
  const bus = {
    state,
    push(raw) {
      for (const sub of subs) sub.push(raw)
    },
    fail(error) {
      for (const sub of subs) sub.fail(error)
    },
    subscribe() {
      state.subscribeCount += 1
      const queue = []
      const waiters = new Set()
      let done = false
      const sub = {
        push(raw) {
          if (waiters.size > 0) {
            const w = [...waiters][0]
            waiters.delete(w)
            w.resolve({ value: raw, done: false })
          } else queue.push(raw)
        },
        fail(error) {
          done = true
          for (const w of waiters) w.reject(error)
          waiters.clear()
          subs.delete(sub)
        },
      }
      subs.add(sub)
      const iterator = {
        [Symbol.asyncIterator]() {
          return this
        },
        next: () => {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false })
          if (done) return Promise.resolve({ done: true })
          return new Promise((resolve, reject) => waiters.add({ resolve, reject }))
        },
        return: () => {
          state.returnCalled += 1
          done = true
          subs.delete(sub)
          for (const w of waiters) w.resolve({ done: true })
          return Promise.resolve({ done: true })
        },
      }
      return iterator
    },
  }
  return bus
}

// ---- 实测形状的消息夹具（全合成；{info:{role}, parts:[...]} 照 S7a v1 message 面摆）----
const userMsg = (text) => ({ info: { id: 'msg_u', sessionID: 'ses_x', role: 'user', time: { created: 1 } }, parts: [{ id: 'prt_u', type: 'text', text }] })
const asstText = (text) => ({
  info: { id: 'msg_a', sessionID: 'ses_x', role: 'assistant', time: { created: 2, completed: 3 }, finish: 'stop' },
  parts: [
    { id: 'prt_s', type: 'step-start' },
    { id: 'prt_t', type: 'text', text },
    { id: 'prt_f', type: 'step-finish', reason: 'stop' },
  ],
})
const asstError = (message) => ({ info: { id: 'msg_e', role: 'assistant' }, parts: [{ id: 'prt_e', type: 'error', message }] })

// ================= 1. 常量与构造面 =================
{
  assert.deepEqual(Object.keys(SESSION_DRIVER_DEFAULTS), ['waitAttemptMs', 'contextReadMs', 'eventMinIntervalMs', 'trailingRecheckMs', 'heartbeatMs', 'executionEventCap'], '缺省间隔面钉死')
  for (const code of ['E1_DRIVER_CLOSED', 'E1_DRIVER_BAD_ARGS', 'E1_DRIVER_UNKNOWN_SESSION', 'E1_DRIVER_CHAOS_TIMEOUT', 'E1_DRIVER_CREATE_FAILED', 'E1_DRIVER_PROMPT_FAILED', 'E1_DRIVER_CONTEXT_FAILED', 'E1_DRIVER_INTERRUPT_FAILED']) {
    assert.ok(SESSION_DRIVER_ERROR_CODES.includes(code), `错误码清单应含 ${code}`)
  }
  // 前四个与 mock/replay（driver.js）共用，调度器/ask 的错误记账口径一致
  for (const code of ['E1_DRIVER_CLOSED', 'E1_DRIVER_BAD_ARGS', 'E1_DRIVER_UNKNOWN_SESSION', 'E1_DRIVER_CHAOS_TIMEOUT']) {
    assert.ok(DRIVER_ERROR_CODES.includes(code), `${code} 也在 driver.js 清单里（共用口径）`)
  }
  ok('常量面：缺省间隔 + 错误码清单（前四码与 driver.js 共用）')

  const { ctx } = mkHost()
  const d = createSessionDriver(ctx, { now: mkTime().now, sleep: mkTime().sleep })
  assert.equal(d.kind, 'session', "kind 自报 'session'")
  assert.deepEqual(d.calls, [], 'calls 空起步')
  assert.deepEqual(d.executionEvents, [], 'executionEvents 空起步')
  assert.deepEqual(d.eventStats, { seen: 0, forwarded: 0, dropped: 0, executionRecorded: 0, synthetic: 0, hostErrors: 0 }, 'eventStats 六计数器')
  ok('构造面：kind/calls/executionEvents/eventStats')
}

// ================= 2. 构造负臂（TypeError fail-fast，scheduler 同轨）=================
{
  const bad = (fn, re) => assert.throws(fn, (e) => e instanceof TypeError && re.test(e.message), `应 TypeError 且消息含 ${re}`)
  const { ctx } = mkHost()
  const T = mkTime()
  bad(() => createSessionDriver(null), /ctx 必须是宿主/)
  bad(() => createSessionDriver({}), /ctx\.session 缺必需 face create/)
  bad(() => createSessionDriver({ session: { create() {} } }), /缺必需 face prompt/)
  bad(() => createSessionDriver({ session: { create() {}, prompt() {} } }), /缺必需 face context/)
  bad(() => createSessionDriver(ctx, { now: 42 }), /now 必须是/)
  bad(() => createSessionDriver(ctx, { sleep: 'x' }), /sleep 必须是/)
  bad(() => createSessionDriver(ctx, { directory: '' }), /directory 必须是非空字符串/)
  bad(() => createSessionDriver(ctx, { parentID: 7 }), /parentID 必须是非空字符串/)
  bad(() => createSessionDriver(ctx, { heartbeatMs: -1 }), /heartbeatMs 必须是 ≥0 整数/)
  bad(() => createSessionDriver(ctx, { nope: 1 }), /未知选项 "nope"/)
  bad(() => createSessionDriver(ctx, { fault: 'x' }), /fault 必须是对象或 null/)
  ok('构造负臂：ctx face 三必需 + now/sleep/directory/parentID/ms/fault 形状全拒')
}

// ================= 3. create（宿主调用序 + 两形状 id + 负路径）=================
{
  // 3a. v1 扁平 id（实测主形态）：create→id→prompt await 回执；参数零转换直传
  {
    const time = mkTime()
    const { ctx, host } = mkHost()
    const d = createSessionDriver(ctx, { now: time.now, sleep: time.sleep })
    const args = { title: 'REEVE-E1 r1 s1', prompt: '第一步', agent: 'build', model: { providerID: 'xiaomi', id: 'mimo', variant: 'default' } }
    const snapshot = JSON.parse(JSON.stringify(args))
    const created = await d.create(args)
    assert.deepEqual(created, { sessionId: 'ses_h_1' }, 'create 返回恰 {sessionId}')
    args.title = '调用方事后篡改'
    assert.deepEqual(host.createArgs[0], { title: 'REEVE-E1 r1 s1', agent: 'build', model: { providerID: 'xiaomi', id: 'mimo', variant: 'default' } }, '宿主 create 收到 title/agent/model（零转换；无 prompt 键）')
    assert.deepEqual(host.promptArgs[0], { sessionID: 'ses_h_1', text: '第一步', agent: 'build' }, 'prompt 收 {sessionID, text, agent}')
    assert.deepEqual(d.calls[0], { seq: 1, op: 'create', at: 1_700_000_000_000, args: snapshot, sessionId: 'ses_h_1' }, 'calls.create 记录形状（at 来自注入钟；args 是入参的克隆，篡改不回写）')
    assert.equal(JSON.stringify(d.calls[0].args), JSON.stringify(snapshot), 'calls.args 深度不受调用方篡改影响')
    ok('create：v1 扁平 id + 参数直传 + prompt 回执 + calls 克隆隔离')
  }
  // 3b. v2 信封 id（S7a 实测 data.id 分支）+ directory/parentID 注入
  {
    const { ctx, host } = mkHost()
    host.createResults.push({ data: { id: 'ses_v2_1' } })
    const d = createSessionDriver(ctx, { directory: 'D:/proj', parentID: 'ses_parent' })
    assert.deepEqual(await d.create({ title: 'T', prompt: 'P' }), { sessionId: 'ses_v2_1' }, 'v2 {data:{id}} 信封同样取到')
    assert.deepEqual(host.createArgs[0], { title: 'T', directory: 'D:/proj', parentID: 'ses_parent' }, 'directory/parentID 部署参数附在宿主 create 上（不进 driver create 面）')
    ok('create：v2 data.id 信封 + directory/parentID 注入')
  }
  // 3c. 负路径表驱动
  {
    const mk = () => {
      const h = mkHost()
      return { h, d: createSessionDriver(h.ctx, { now: mkTime().now, sleep: mkTime().sleep }) }
    }
    const CASES = [
      { name: '宿主 create 抛', setup: (h) => (h.createError = new Error('boom')), code: 'E1_DRIVER_CREATE_FAILED', msg: /宿主建会话失败：boom/ },
      { name: 'id 缺失（空对象）', setup: (h) => h.createResults.push({}), code: 'E1_DRIVER_CREATE_FAILED', msg: /缺非空 id（keys=）/ },
      { name: 'id 缺失（null 返回）', setup: (h) => h.createResults.push(null), code: 'E1_DRIVER_CREATE_FAILED', msg: /缺非空 id/ },
      { name: 'id 缺失（data 空信封）', setup: (h) => h.createResults.push({ data: {} }), code: 'E1_DRIVER_CREATE_FAILED', msg: /缺非空 id（keys=data）/ },
      { name: '宿主 prompt 抛', setup: (h) => (h.promptError = new Error('send fail')), code: 'E1_DRIVER_PROMPT_FAILED', msg: /宿主 prompt 失败/ },
      { name: 'BAD_ARGS：title 空串', args: { title: '', prompt: 'P' }, code: 'E1_DRIVER_BAD_ARGS', msg: /create\.title: 必须是非空字符串/ },
      { name: 'BAD_ARGS：未知字段', args: { title: 'T', prompt: 'P', temperature: 1 }, code: 'E1_DRIVER_BAD_ARGS', msg: /未知字段 "temperature"/ },
    ]
    for (const c of CASES) {
      const { h, d } = mk()
      if (c.setup) c.setup(h.host)
      const r = await caught(d.create(c.args ?? { title: 'T', prompt: 'P' }))
      assert.equal(r.code, c.code, `${c.name}：code`)
      assert.match(r.message, c.msg, `${c.name}：消息`)
      assert.equal(d.calls.at(-1).error, c.code, `${c.name}：calls 记 error 只记 code`)
    }
    ok(`create 负路径 ${CASES.length} 行（宿主抛/缺 id×3/prompt 抛/参数校验×2）`)
  }
  // 3d. chaos timeout：宿主零接触
  {
    const { ctx, host } = mkHost()
    const d = createSessionDriver(ctx, { fault: { driverChaos: { timeoutMs: true } } })
    assert.deepEqual((await caught(d.create({ title: 'T', prompt: 'P' }))).code, 'E1_DRIVER_CHAOS_TIMEOUT', 'chaos create 拒')
    assert.equal(host.createArgs.length, 0, 'chaos 下宿主 create 零接触')
    assert.equal(host.promptArgs.length, 0, 'chaos 下宿主 prompt 零接触')
    assert.equal(d.calls.at(-1).error, 'E1_DRIVER_CHAOS_TIMEOUT', 'chaos 入账')
    ok('create：chaos.timeoutMs 拒且宿主零接触')
  }
}

// ================= 4. judgeContext（末条 assistant 判定；纯函数表驱动）=================
{
  const CASES = [
    { name: '数组直用：user+assistant(text) → done', input: [userMsg('问'), asstText('S7A-OK')], want: { status: 'done', text: 'S7A-OK', shape: 'assistant-text' } },
    { name: '空数组（实测空会话形状）→ running', input: [], want: { status: 'running', shape: 'empty' } },
    { name: '只有 user（末条非 assistant）→ running', input: [userMsg('问')], want: { status: 'running', shape: 'last-not-assistant' } },
    { name: 'assistant 无 text/error（流式中）→ running', input: [userMsg('问'), { info: { role: 'assistant' }, parts: [{ type: 'step-start' }] }], want: { status: 'running', shape: 'assistant-no-verdict' } },
    { name: 'assistant text 空串 → running', input: [userMsg('问'), asstText('')], want: { status: 'running', shape: 'assistant-no-verdict' } },
    { name: 'error part（对象）→ failed 且 stringify', input: [userMsg('问'), asstError('LLM 超时')], want: { status: 'failed', errorPart: JSON.stringify({ id: 'prt_e', type: 'error', message: 'LLM 超时' }), shape: 'assistant-error' } },
    { name: 'error part（text 字段形状）→ failed 且 stringify 整件', input: [{ info: { role: 'assistant' }, parts: [{ type: 'error', text: 'boom' }] }], want: { status: 'failed', shape: 'assistant-error' } },
    { name: 'error 优先于 text（deep-memory 同款）', input: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: '半截' }, { type: 'error', message: '中断' }] }], want: { status: 'failed', shape: 'assistant-error' } },
    { name: 'info.error 形状容错（terminal-gate 同款）', input: [{ info: { role: 'assistant', error: { code: 'x' } }, parts: [] }], want: { status: 'failed', errorPart: '{"code":"x"}', shape: 'assistant-error' } },
    { name: '多轮工具流：末条 assistant 带 text → done', input: [userMsg('问'), { info: { role: 'assistant' }, parts: [{ type: 'tool' }] }, asstText('最终')], want: { status: 'done', text: '最终', shape: 'assistant-text' } },
    { name: '顶层 role 形状容错（无 info）', input: [{ role: 'assistant', parts: [{ type: 'text', text: '裸形状' }] }], want: { status: 'done', text: '裸形状', shape: 'assistant-text' } },
    { name: '{data:[...]} 信封取数组', input: { data: [userMsg('问'), asstText('信封')] }, want: { status: 'done', text: '信封', shape: 'assistant-text' } },
    { name: '{messages:[...]} 形状容错', input: { messages: [asstText('经 messages')] }, want: { status: 'done', text: '经 messages', shape: 'assistant-text' } },
    { name: '{history:[...]} 形状容错', input: { history: [asstText('经 history')] }, want: { status: 'done', text: '经 history', shape: 'assistant-text' } },
    { name: '形状认不出（对象无数组键）→ running', input: { foo: 1 }, want: { status: 'running', shape: 'unknown' } },
    { name: '非对象非数组 → running', input: 42, want: { status: 'running', shape: 'unknown' } },
    { name: 'null → running', input: null, want: { status: 'running', shape: 'unknown' } },
    // ---- v2 扁平 face 形状（2026-11-23 M1.3b/c 挂载探针 probe-raw-entry 逐字节实测）----
    {
      name: 'v2 扁平全 transcript（user→assistant(content)→idle succeeded）→ done',
      input: [
        { id: 'msg_u', time: { created: 1 }, text: 'Reply with exactly: M13-PROBE', type: 'user' },
        {
          id: 'msg_a',
          time: { created: 2, completed: 3 },
          type: 'assistant',
          agent: 'general',
          model: { id: 'standard', providerID: 'reeve', variant: 'default' },
          content: [
            { type: 'reasoning', text: 'The user wants a probe reply.' },
            { type: 'text', text: 'M13-PROBE' },
          ],
          finish: 'stop',
          tokens: { input: 14228, output: 7 },
        },
        { id: 'msg_i', time: { created: 4 }, type: 'idle', outcome: 'succeeded' },
      ],
      want: { status: 'done', text: 'M13-PROBE', shape: 'assistant-text-v2-idle' },
    },
    { name: 'v2 末条 assistant（无 idle 尾条）→ done', input: [{ id: 'msg_u', type: 'user', text: '问' }, { id: 'msg_a', type: 'assistant', content: [{ type: 'text', text: 'v2 直达' }] }], want: { status: 'done', text: 'v2 直达', shape: 'assistant-text' } },
    { name: 'v2 assistant 扁平 text（无 content）→ done（-flat 形）', input: [{ id: 'msg_u', type: 'user', text: '问' }, { id: 'msg_a', type: 'assistant', text: '扁平回答' }], want: { status: 'done', text: '扁平回答', shape: 'assistant-text-flat' } },
    { name: 'v2 只有 user（assistant 未出）→ running', input: [{ id: 'msg_u', type: 'user', text: '问' }], want: { status: 'running', shape: 'last-not-assistant' } },
    { name: 'v2 末条 idle 但 outcome 非 succeeded → running（fail-open）', input: [{ id: 'msg_u', type: 'user', text: '问' }, { id: 'msg_a', type: 'assistant', content: [{ type: 'text', text: '答' }] }, { id: 'msg_i', type: 'idle', outcome: 'failed' }], want: { status: 'running', shape: 'idle-failed' } },
    { name: 'v2 末条 idle succeeded 但无 assistant → running（fail-open）', input: [{ id: 'msg_i', type: 'idle', outcome: 'succeeded' }], want: { status: 'running', shape: 'idle-no-assistant' } },
    { name: 'v2 末条 idle outcome 缺失 → running（fail-open）', input: [{ id: 'msg_u', type: 'user', text: '问' }, { id: 'msg_i', type: 'idle' }], want: { status: 'running', shape: 'idle-unknown' } },
    { name: 'v2 assistant 流式中（content 无 text）→ running', input: [{ id: 'msg_u', type: 'user', text: '问' }, { id: 'msg_a', type: 'assistant', content: [{ type: 'reasoning', text: '想' }] }], want: { status: 'running', shape: 'assistant-no-verdict' } },
    { name: 'v1 信封条目带 type 键不被误判为扁平（info.role 优先）', input: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: '信封' }], type: 'user' }], want: { status: 'done', text: '信封', shape: 'assistant-text' } },
  ]
  for (const c of CASES) {
    const got = judgeContext(c.input)
    assert.equal(got.status, c.want.status, `${c.name}：status`)
    assert.equal(got.shape, c.want.shape, `${c.name}：shape`)
    if (c.want.text !== undefined) assert.equal(got.text, c.want.text, `${c.name}：text`)
    if (c.name.includes('text 字段形状')) assert.match(got.errorPart, /boom/, `${c.name}：errorPart 是整件 JSON（deep-memory 同款 stringify）`)
    if (c.name.includes('error 优先')) assert.match(got.errorPart, /中断/, `${c.name}：errorPart 取 error 件`)
  }
  ok(`judgeContext ${CASES.length} 行表驱动全过（done/failed/running + 形状容错 + error 优先）`)
}

// ================= 5. result（wait 优先 + 容错读 + 三值探针；实测为准的 decisions 全落点）=================
{
  // 5a. 实测主形态：wait 即抛 "Expected object" → 降级 → context 末条 assistant → done
  {
    const time = mkTime()
    const { ctx, host } = mkHost()
    host.contextValue = [userMsg('Reply with exactly: S7A-OK'), asstText('S7A-OK')]
    const d = createSessionDriver(ctx, { now: time.now, sleep: time.sleep })
    const { sessionId } = await d.create({ title: 'T', prompt: 'P' })
    const res = await d.result(sessionId)
    assert.deepEqual(res, { status: 'done', text: 'S7A-OK' }, '实测降级路径仍判 done 取 text')
    assert.deepEqual(host.waitArgs, [sessionId], 'wait 优先：裸形 wait(sessionId) 被调用')
    assert.deepEqual(host.contextArgs, [{ sessionID: sessionId }], 'context 收 {sessionID}')
    const rec = d.calls.find((c) => c.op === 'result')
    assert.deepEqual(rec.wait, { status: 'threw', ms: 0, error: 'Expected object' }, 'wait 抛错降级：calls.wait 记 threw（注入钟下 ms=0，与实测 ms=0/1 同形）')
    assert.equal(rec.parse, 'assistant-text', 'calls.parse 记判定依据')
    assert.deepEqual(rec.response, { status: 'done', text: 'S7A-OK' }, 'calls.response 记送达值')
    assert.equal(rec.error, undefined, '成功无 error 键')
    ok('result：wait 即抛（实测）→ 降级 context → done；calls.wait/parse/response 齐')
  }
  // 5b. 三值：running（实测空会话 []）与 failed（error part）
  {
    const time = mkTime()
    const { ctx, host } = mkHost()
    const d = createSessionDriver(ctx, { now: time.now, sleep: time.sleep })
    const { sessionId } = await d.create({ title: 'T', prompt: 'P' })
    assert.deepEqual(await d.result(sessionId), { status: 'running' }, '空会话（实测 []）→ running 恰一值')
    host.contextValue = [userMsg('问'), asstError('provider 限流')]
    const res = await d.result(sessionId)
    assert.equal(res.status, 'failed', 'error part → failed')
    assert.match(res.errorPart, /provider 限流/, 'errorPart 携带宿主错误')
    assert.equal('text' in res, false, 'failed 无 text 键')
    ok('result：running（空数组）/ failed（errorPart）两值')
  }
  // 5c. wait 四形态的 calls.wait 记录（resolved / hang→有界 timeout / unsupported / 缺 face）
  {
    const mk = async (waitMode, mutate) => {
      const time = mkTime()
      const h = mkHost()
      h.host.waitMode = waitMode
      const d = createSessionDriver(h.ctx, { now: time.now, sleep: time.sleep })
      const { sessionId } = await d.create({ title: 'T', prompt: 'P' })
      h.host.contextValue = [asstText('好')]
      if (mutate) mutate(h.host, h.ctx)
      const pending = d.result(sessionId)
      if (waitMode === 'hang') time.fire() // 挂死形态才需要解开有界赛跑的 sleep
      const res = await pending
      time.fire() // 排掉残余 sleep promise（不影响断言）
      return { d, res, time }
    }
    {
      const { d, res } = await mk('resolve')
      assert.deepEqual(d.calls.at(-1).wait, { status: 'resolved', ms: 0 }, 'wait resolve 形态照记')
      assert.deepEqual(res, { status: 'done', text: '好' }, 'wait resolve 后仍按 context 判定（wait 不是结论来源）')
    }
    {
      const { d, res } = await mk('hang')
      assert.deepEqual(d.calls.at(-1).wait, { status: 'timeout', ms: SESSION_DRIVER_DEFAULTS.waitAttemptMs }, 'wait 挂死被有界赛跑截断（waitAttemptMs）')
      assert.deepEqual(res, { status: 'done', text: '好' }, '挂死截断后照常解析')
    }
    {
      const { d, res } = await mk('throw', (h, ctx2) => delete ctx2.session.wait)
      assert.deepEqual(d.calls.at(-1).wait, { status: 'unsupported' }, '缺 wait face → unsupported 降级')
      assert.deepEqual(res, { status: 'done', text: '好' }, '无 wait face 主路径不受阻')
    }
    ok('result：wait resolved / hang 有界 timeout / 缺 face unsupported 三形态')
  }
  // 5d. context 读容错：抛错与挂死都 → running（不结论不冒泡；decisions-4）
  {
    const time = mkTime()
    const { ctx, host } = mkHost()
    host.contextError = new Error('storage 500')
    const d = createSessionDriver(ctx, { now: time.now, sleep: time.sleep })
    const { sessionId } = await d.create({ title: 'T', prompt: 'P' })
    const res = await d.result(sessionId)
    assert.deepEqual(res, { status: 'running' }, 'context 抛错 → running（不结论）')
    let rec = d.calls.at(-1)
    assert.equal(rec.contextNote, 'threw', 'calls.contextNote 记 threw')
    assert.equal(rec.contextError, 'storage 500', 'calls.contextError 记宿主错误')
    assert.equal(rec.parse, 'unknown', '形状记 unknown')
    host.contextError = null
    host.contextHang = true
    const pending = d.result(sessionId)
    await drain() // 让 attemptWait（微任务链）走完、context 有界赛跑的 sleep 注册进队
    time.fire() // 解 context 有界赛跑
    assert.deepEqual(await pending, { status: 'running' }, 'context 挂死 → 有界截断 → running')
    rec = d.calls.at(-1)
    assert.equal(rec.contextNote, 'timeout', 'calls.contextNote 记 timeout')
    ok('result：context 抛错/挂死 → running 容错（不冒泡成 poll-error）')
  }
  // 5e. 负臂：UNKNOWN_SESSION / BAD_ARGS / CLOSED / chaos
  {
    const time = mkTime()
    const { ctx } = mkHost()
    const d = createSessionDriver(ctx, { now: time.now, sleep: time.sleep })
    assert.deepEqual((await caught(d.result('ses_never'))).code, 'E1_DRIVER_UNKNOWN_SESSION', '未知会话拒')
    assert.deepEqual((await caught(d.result(''))).code, 'E1_DRIVER_BAD_ARGS', '空串拒')
    assert.deepEqual((await caught(d.result(42))).code, 'E1_DRIVER_BAD_ARGS', '非字符串拒')
    const chaosD = createSessionDriver(mkHost().ctx, { fault: { driverChaos: { timeoutMs: true } } })
    // chaos 判定先于会话存在性检查（driver.js 同序）——无会话也报 CHAOS 而非 UNKNOWN_SESSION
    assert.deepEqual((await caught(chaosD.result('ses_h_1'))).code, 'E1_DRIVER_CHAOS_TIMEOUT', 'chaos result 拒')
    d.close()
    assert.deepEqual((await caught(d.result('ses_never'))).code, 'E1_DRIVER_CLOSED', 'closed 拒')
    ok('result 负臂：UNKNOWN_SESSION/BAD_ARGS×2/CHAOS/CLOSED')
  }
  // 5f. chaos halfResponse + duplicateCallback（mock/replay 同语义的状态派生对应物）
  {
    const time = mkTime()
    const { ctx, host } = mkHost()
    host.contextValue = [asstText('A')]
    const d = createSessionDriver(ctx, { now: time.now, sleep: time.sleep, fault: { driverChaos: { halfResponse: true } } })
    const { sessionId } = await d.create({ title: 'T', prompt: 'P' })
    const res = await d.result(sessionId)
    assert.deepEqual(res, { status: 'done' }, 'halfResponse 剥成 {status}')
    assert.equal('text' in res, false, 'text 键被剥掉（不是 undefined 值）')
    ok('chaos.halfResponse：result 剥 text')
    // duplicateCallback：状态派生应答变化 → 下一次调用先重投旧应答（A,A,B,B,B…）
    const time2 = mkTime()
    const h2 = mkHost()
    h2.host.contextQueue = [[asstText('A')], [asstText('B')]]
    h2.host.contextValue = [asstText('B')] // 队列耗尽后的粘滞末态（mock 末项粘滞同款）
    const d2 = createSessionDriver(h2.ctx, { now: time2.now, sleep: time2.sleep, fault: { driverChaos: { duplicateCallback: true } } })
    const { sessionId: sid2 } = await d2.create({ title: 'T', prompt: 'P' })
    const seq = []
    for (let i = 0; i < 5; i++) {
      const r = await d2.result(sid2)
      seq.push(`${r.status}:${r.text ?? ''}${r.errorPart ?? ''}`)
    }
    assert.deepEqual(seq, ['done:A', 'done:A', 'done:B', 'done:B', 'done:B'], '脚本 [A,B] 语义在状态派生世界变 A,A,B,B,B…（末态粘滞不变）')
    assert.equal(d2.calls.filter((c) => c.op === 'result' && c.dup === true).length, 2, '恰两次重投入账（r.dup=true）')
    assert.equal(h2.host.contextArgs.length, 3, '重投跳过宿主读（mock 同款：dup 不消耗新取数；读=初读 A / 新读 B / 粘滞 B）')
    ok('chaos.duplicateCallback：状态派生 A,A,B,B,B + dup 入账 + 重投零宿主读')
  }
}

// ================= 6. context（raw 面：照搬/拒抛/chaos）=================
{
  const time = mkTime()
  const { ctx, host } = mkHost()
  host.contextValue = { custom: 'shape', entries: [1, 2] }
  const d = createSessionDriver(ctx, { now: time.now, sleep: time.sleep })
  const { sessionId } = await d.create({ title: 'T', prompt: 'P' })
  assert.deepEqual(await d.context(sessionId), { custom: 'shape', entries: [1, 2] }, 'raw 照搬（不解析）')
  assert.deepEqual((await caught(d.context('ses_never'))).code, 'E1_DRIVER_UNKNOWN_SESSION', '未知会话拒')
  host.contextError = new Error('host down')
  const e = await caught(d.context(sessionId))
  assert.equal(e.code, 'E1_DRIVER_CONTEXT_FAILED', 'raw 面 host 抛 → CONTEXT_FAILED（与 result 容错分轨）')
  assert.match(e.message, /宿主读取失败：host down/, '消息带宿主原因')
  ok('context：raw 照搬 + UNKNOWN + 宿主抛 CONTEXT_FAILED')

  // halfResponse 与 duplicateCallback（各自独立宿主，互不串队列）
  const h2 = mkHost()
  h2.host.contextValue = { n: 'A' }
  const d2 = createSessionDriver(h2.ctx, { fault: { driverChaos: { halfResponse: true } } })
  const { sessionId: sid2 } = await d2.create({ title: 'T', prompt: 'P' })
  assert.deepEqual(await d2.context(sid2), {}, 'halfResponse context 回 {}')
  const h3 = mkHost()
  h3.host.contextQueue = [{ n: 'A' }, { n: 'B' }]
  h3.host.contextValue = { n: 'B' }
  const d3 = createSessionDriver(h3.ctx, { fault: { driverChaos: { duplicateCallback: true } } })
  const { sessionId: sid3 } = await d3.create({ title: 'T', prompt: 'P' })
  assert.deepEqual(await d3.context(sid3), { n: 'A' }, 'dup 第 1 读：A')
  assert.deepEqual(await d3.context(sid3), { n: 'A' }, 'dup 第 2 读：旧应答重投（跳过宿主读）')
  assert.deepEqual(await d3.context(sid3), { n: 'B' }, 'dup 第 3 读：新应答 B')
  assert.equal(d3.calls.filter((c) => c.op === 'context' && c.dup === true).length, 1, 'context 重投入账 1 次')
  assert.equal(h3.host.contextArgs.length, 2, 'context 重投零宿主读（初读 A / 新读 B）')
  ok('context：halfResponse {} + duplicateCallback 重投')
}

// ================= 7. interrupt =================
{
  const time = mkTime()
  const { ctx, host } = mkHost()
  const d = createSessionDriver(ctx, { now: time.now, sleep: time.sleep })
  const { sessionId } = await d.create({ title: 'T', prompt: 'P' })
  assert.equal(await d.interrupt(sessionId), undefined, 'interrupt 返回 undefined')
  assert.deepEqual(host.interruptArgs, [{ sessionID: sessionId }], '宿主收 {sessionID}（reeve index.js:372 同款键名）')
  assert.equal(d.calls.at(-1).op, 'interrupt', 'calls 记 interrupt')
  assert.deepEqual((await caught(d.interrupt('ses_never'))).code, 'E1_DRIVER_UNKNOWN_SESSION', '未知会话拒')
  assert.deepEqual((await caught(d.interrupt(7))).code, 'E1_DRIVER_BAD_ARGS', '非字符串拒')
  host.interruptError = new Error('cannot interrupt')
  assert.deepEqual((await caught(d.interrupt(sessionId))).code, 'E1_DRIVER_INTERRUPT_FAILED', '宿主抛 → INTERRUPT_FAILED')
  host.interruptError = null
  delete ctx.session.interrupt
  assert.deepEqual((await caught(d.interrupt(sessionId))).code, 'E1_DRIVER_BAD_ARGS', '缺 face → BAD_ARGS（宿主差异记录）')
  d.close()
  assert.deepEqual((await caught(d.interrupt(sessionId))).code, 'E1_DRIVER_CLOSED', 'closed 拒')
  ok('interrupt：happy/UNKNOWN/BAD_ARGS/宿主抛/缺 face/CLOSED 六臂')
}

// ================= 8. events（规范化 + 记 session.execution.* + 去抖 + 终末旁路 + trailing + 心跳）=================
{
  // 8a. isTerminalishEvent 表驱动
  {
    const CASES = [
      [{ type: 'session.execution.succeeded', data: {} }, true, 'session.execution.*（蓝图点名）'],
      [{ type: 'session.idle' }, true, 'v1 idle 名'],
      [{ type: 'message.part.updated', data: { part: { type: 'step-finish' } } }, true, 'step-finish part'],
      [{ type: 'message.part.updated', data: { part: { type: 'error' } } }, true, 'error part'],
      [{ type: 'message.updated', data: { info: { role: 'assistant', time: { completed: 1 } } } }, true, 'assistant completed'],
      [{ type: 'message.part.updated', data: { part: { type: 'text' } } }, false, '流式 text part 不是终末'],
      [{ type: 'message.updated', data: { info: { role: 'user' } } }, false, 'user message 不是终末'],
      [{ type: 'message.updated', data: { info: { role: 'assistant' } } }, false, 'assistant 无 completed 不是终末'],
      [{ type: 'session.created' }, false, 'session.created 不是终末'],
      [{}, false, '无 type 不是终末'],
      [null, false, 'null 不是终末'],
    ]
    for (const [input, want, name] of CASES) assert.equal(isTerminalishEvent(input), want, `isTerminalish：${name}`)
    ok(`isTerminalishEvent ${CASES.length} 行表驱动`)
  }
  // 8b. 规范化转发 + location.directory 取样 + session.execution.* 记形状
  {
    const time = mkTime()
    const { ctx } = mkHost()
    const ev = mkEventSource()
    ctx.event = { subscribe: ev.subscribe }
    const d = createSessionDriver(ctx, { now: time.now, sleep: time.sleep })
    const it = d.events()[Symbol.asyncIterator]()
    const first = it.next() // 消费者先挂
    ev.push({ type: 'message.part.updated', location: { directory: 'D:\\proj' }, data: { part: { type: 'text', text: '流' } } })
    const got = (await first).value
    assert.deepEqual(got, { type: 'message.part.updated', properties: { locationDirectory: 'D:\\proj' }, at: time.now(), synthetic: false }, '规范化：properties.locationDirectory 取自实测 location.directory')
    ev.push({ type: 'session.updated', properties: { locationDirectory: 'D:\\proj2' } })
    ev.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses_x' }, location: { directory: 'D:\\proj2' } })
    const second = (await it.next()).value
    assert.equal(second.type, 'session.execution.succeeded', 'session.execution.* 旁路去抖必投（完成信号不能丢）')
    assert.equal(second.properties.locationDirectory, 'D:\\proj2', 'properties.locationDirectory 优先')
    assert.deepEqual(d.executionEvents, [{ at: time.now(), event: { type: 'session.execution.succeeded', data: { sessionID: 'ses_x' }, location: { directory: 'D:\\proj2' } } }], 'session.execution.* 出现即记原始形状')
    assert.deepEqual(d.eventStats, { seen: 3, forwarded: 2, dropped: 1, executionRecorded: 1, synthetic: 0, hostErrors: 0 }, '计数器：seen3/forwarded2/dropped1（session.updated 落在窗口被丢）')
    d.close()
    ok('events：规范化转发 + execution 记形状 + 去抖计数')
  }
  // 8c. 终末旁路 + trailing recheck（恰一次；去抖窗口内 progress 被丢但 step-finish 必达）
  {
    const time = mkTime()
    const h = mkHost()
    const ev = mkEventSource()
    h.ctx.event = { subscribe: ev.subscribe }
    const d = createSessionDriver(h.ctx, { now: time.now, sleep: time.sleep, heartbeatMs: 0, trailingRecheckMs: 1_500 })
    const it = d.events()[Symbol.asyncIterator]()
    ev.push({ type: 'session.updated' }) // 首条：窗口外必投
    await it.next()
    for (let i = 0; i < 5; i++) ev.push({ type: 'message.part.updated', data: { part: { type: 'text', text: `${i}` } } }) // 窗口内 5 条全丢
    ev.push({ type: 'message.part.updated', data: { part: { type: 'step-finish', reason: 'stop' } } }) // 终末：旁路必投
    const got = (await it.next()).value
    assert.equal(got.type, 'message.part.updated', '终末旁路必达')
    ev.push({ type: 'message.updated', data: { info: { role: 'assistant', time: { completed: 9 } } } }) // 第二个终末：trailing 已挂，不叠加
    await it.next()
    time.fire() // trailing 到点
    const recheck = (await it.next()).value
    assert.deepEqual(recheck, { type: 'reeve.recheck', properties: { locationDirectory: undefined }, at: time.now(), synthetic: true }, 'trailing recheck 合成件送达')
    assert.equal(d.eventStats.dropped, 5, '5 条流式 part 被去抖丢弃')
    assert.equal(d.eventStats.synthetic, 1, 'trailing 恰一次（不叠加）')
    d.close()
    ok('events：终末旁路 + 去抖丢流式 + trailing 恰一次')
  }
  // 8d. 心跳活性（宿主零事件也有 recheck；heartbeatMs=0 关闭；队列 cap）
  {
    const time = mkTime()
    const h = mkHost()
    const d = createSessionDriver(h.ctx, { now: time.now, sleep: time.sleep, heartbeatMs: 5_000 })
    const it = d.events()[Symbol.asyncIterator]()
    const first = it.next()
    time.fire() // 心跳到点
    assert.deepEqual((await first).value, { type: 'reeve.recheck', properties: { locationDirectory: undefined }, at: time.now(), synthetic: true }, '无宿主事件也有心跳 recheck（活性上界）')
    d.close()
    assert.deepEqual((await it.next()), { done: true }, 'close 后流 done')

    const dOff = createSessionDriver(mkHost().ctx, { now: time.now, sleep: time.sleep, heartbeatMs: 0 })
    const itOff = dOff.events()[Symbol.asyncIterator]()
    time.fire()
    const raced = await Promise.race([itOff.next().then((v) => ({ got: v })), Promise.resolve('none')])
    assert.equal(raced, 'none', 'heartbeatMs=0：零合成事件（主路径全靠宿主事件与调度器 sweep）')
    dOff.close()

    const dCap = createSessionDriver(mkHost().ctx, { now: time.now, sleep: time.sleep, heartbeatMs: 1 })
    const itCap = dCap.events()[Symbol.asyncIterator]() // 消费者故意不拉（消费者停摆）
    for (let i = 0; i < 40; i++) {
      time.fire()
      await drain() // 让心跳循环的续体跑掉（push + 重新挂 sleep）
    }
    assert.equal(dCap.eventStats.synthetic, 32, '队列 cap 32：合成件有界')
    assert.equal(dCap.eventStats.dropped, 8, '溢出 8 条丢合成计数')
    dCap.close()
    ok('events：心跳活性 / heartbeatMs=0 关 / 队列 cap')
  }
  // 8e. 宿主流抛错/结束不炸流（合成通道保活）；subscribe 缺失/subscribe 抛错降级
  {
    const time = mkTime()
    const h = mkHost()
    const ev = mkEventSource()
    h.ctx.event = { subscribe: ev.subscribe }
    const d = createSessionDriver(h.ctx, { now: time.now, sleep: time.sleep, heartbeatMs: 1_000 })
    const it = d.events()[Symbol.asyncIterator]()
    ev.fail(new Error('sse 断了'))
    await drain()
    assert.equal(d.eventStats.hostErrors, 1, '宿主流抛错入账')
    const first = it.next()
    time.fire()
    assert.equal((await first).value.synthetic, true, '宿主流死后心跳保活')
    d.close()

    const hNoEv = mkHost()
    const dNoEv = createSessionDriver(hNoEv.ctx, { now: time.now, sleep: time.sleep, heartbeatMs: 1_000 })
    const itNoEv = dNoEv.events()[Symbol.asyncIterator]()
    const p = itNoEv.next()
    time.fire()
    assert.equal((await p).value.synthetic, true, '无 event face：纯心跳流照常')
    dNoEv.close()

    const hBad = mkHost()
    hBad.ctx.event = { subscribe: () => { throw new Error('subscribe 拒') } }
    const dBad = createSessionDriver(hBad.ctx, { now: time.now, sleep: time.sleep, heartbeatMs: 1_000 })
    const itBad = dBad.events()[Symbol.asyncIterator]()
    const pBad = itBad.next()
    time.fire()
    assert.equal((await pBad).value.synthetic, true, 'subscribe 抛错 → 降级纯心跳（hostErrors 入账）')
    assert.equal(dBad.eventStats.hostErrors, 1, 'subscribe 抛错入账')
    dBad.close()
    ok('events：宿主流抛错/缺 face/subscribe 抛错 三降级（合成通道保活）')
  }
  // 8f. 消费者 return / driver.close 的收尾语义
  {
    const time = mkTime()
    const h = mkHost()
    const ev = mkEventSource()
    h.ctx.event = { subscribe: ev.subscribe }
    const d = createSessionDriver(h.ctx, { now: time.now, sleep: time.sleep, heartbeatMs: 0 })
    const it = d.events()[Symbol.asyncIterator]()
    await it.return() // 调度器 finally 同款：消费者停
    await drain()
    assert.equal(ev.state.returnCalled, 1, '消费者 return → 宿主迭代器 return')
    assert.deepEqual(await it.next(), { done: true }, 'return 后流 done')
    // driver 仍开：可再开新流（独立订阅）
    const it2 = d.events()[Symbol.asyncIterator]()
    const p2 = it2.next()
    ev.push({ type: 'session.updated' })
    assert.equal((await p2).value.type, 'session.updated', 'driver 仍开时可再订阅（每次 events() 独立流）')
    // driver.close：挂着的 waiter 收 done、宿主迭代器收 return、后续 events() 拒
    const p3 = it2.next()
    d.close()
    assert.deepEqual(await p3, { done: true }, 'close 解挂 waiter → done')
    await drain()
    assert.equal(ev.state.returnCalled, 2, 'close → 宿主迭代器第二次 return')
    assert.deepEqual((await caught(Promise.resolve().then(() => d.events()))).code, 'E1_DRIVER_CLOSED', 'close 后 events() 拒（同步抛也被接住）')
    assert.equal(typeof d.close(), 'undefined', 'close 幂等返回 undefined')
    d.close()
    ok('events：消费者 return / driver.close 收尾 / 再订阅 / close 后拒')
  }
}

// ================= 9. close 与 calls 台账总账 =================
{
  const time = mkTime()
  const { ctx } = mkHost()
  ctx.session.context = async () => {
    throw new Error('x')
  }
  const d = createSessionDriver(ctx, { now: time.now, sleep: time.sleep })
  const { sessionId } = await d.create({ title: 'T', prompt: 'P' })
  await caught(d.result(sessionId))
  await caught(d.context(sessionId))
  await caught(d.interrupt(sessionId))
  d.close()
  d.close()
  for (const [op, p] of [
    ['create', d.create({ title: 'T', prompt: 'P' })],
    ['result', d.result(sessionId)],
    ['context', d.context(sessionId)],
    ['interrupt', d.interrupt(sessionId)],
  ]) {
    assert.equal((await caught(p)).code, 'E1_DRIVER_CLOSED', `close 后 ${op} 拒`)
  }
  assert.equal(d.calls.at(-1).error, 'E1_DRIVER_CLOSED', '关闭后的调用也入账 error code')
  const seqs = d.calls.map((c) => c.seq)
  assert.deepEqual(seqs, [...new Set(seqs)].sort((a, b) => a - b), 'seq 严格递增无重复')
  for (const rec of d.calls) {
    assert.equal(typeof rec.at, 'number', 'calls.at 全部来自注入钟')
    assert.ok(['create', 'result', 'context', 'interrupt'].includes(rec.op), `op 合法（${rec.op}）`)
  }
  const ats = [...new Set(d.calls.map((c) => c.at))]
  assert.equal(ats.length, 1, '注入钟恒定：全部调用共享同一 at（先后由 seq 区分）')
  ok(`close 幂等 + 四操作全拒 + calls 台账（${d.calls.length} 条，seq/at/op 口径）`)
}

// ================= 10. 与调度器的端到端（合成宿主；driver-session 插进 run() 通路）=================
{
  const time = mkTime()
  const h = mkHost()
  const ev = mkEventSource()
  h.ctx.event = { subscribe: ev.subscribe }
  const driver = createSessionDriver(h.ctx, { now: time.now, sleep: time.sleep, heartbeatMs: 0, eventMinIntervalMs: 0 })
  const mem = { value: null }
  const journal = createJournal({ storage: { read: () => mem.value, write: (t) => (mem.value = t) }, runId: 'it-1', now: time.now })
  const declaration = { runId: 'it-1', steps: [{ stepId: 's1', prompt: '读后判', deps: [] }] }
  h.host.contextValue = [userMsg('读后判'), asstText('{"verdict":"ok"}')] // 宿主侧「已完成」
  const eventsIterable = driver.events()
  const runPromise = run(declaration, { journal, driver, now: time.now, events: eventsIterable })
  await drain() // 让 dispatchStep 落地（create+prompt）
  assert.equal(h.host.createArgs.length, 1, '调度器经 driver.create 派发一次')
  assert.match(h.host.createArgs[0].title, /^REEVE-E1 it-1 s1$/, '锚点标题由调度器给（REEVE-E1 <runId> <stepId>）')
  ev.push({ type: 'message.part.updated', location: { directory: 'D:\\x' }, data: { part: { type: 'step-finish' } } }) // 终末事件 → pollAll → result → done
  let watchdogTimer = null
  const watchdog = new Promise((_, reject) => {
    watchdogTimer = setTimeout(() => reject(new Error('run 2s 未收敛（事件通路断了？）')), 2_000)
  })
  const result = await Promise.race([runPromise, watchdog])
  clearTimeout(watchdogTimer)
  assert.equal(result.status, 'completed', '端到端：终末事件驱动 pollAll → done → run completed')
  assert.equal(result.completed[0], 's1', '步 s1 完成')
  assert.equal(result.steps.s1.text, '{"verdict":"ok"}', '产出 = 末条 assistant text')
  assert.equal(result.steps.s1.sessionId, 'ses_h_1', 'journal/engine-owned set 挂真实 sessionId')
  ok('端到端：driver-session × scheduler × journal（终末事件→done→completed）')
}

console.log(`\n引擎生产 driver 测试（S7b）：${passed} 项全过`)
