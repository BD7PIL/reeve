// E1 引擎数据面测试（R.1 门；蓝图 .zcode/plans/next-round-plan-v4.md R 节 R.1①–⑦ + R.2 验收全列）。
//
// 覆盖矩阵（R.2 逐条对应，标签与蓝图验收项一致）：
//   词法五态（R.1②）——两条严格语法通过 / `{{ outputs.x }}` 无空白容差 / 深 key 编译错 /
//     字面 `{{` 编译错 / 未闭合编译错 / 含点号 stepId 编译错+Q1 候选。
//   引用三查三态（R.1③）——缺 stepId→Q1 候选 / 非传递闭包上游 / 无 schema；传递闭包链通过。
//   渲染（R.1④）——renderPrompt 纯函数导出（同参同果、不 mutate 入参）；整对象/一层 key；
//     附言后拼（retryPrompt/escalationPrompt 字面 `{{` 不二次替换——mock 全程断言）。
//   注入上限（R.1⑤）——重复引用重复累计 / 模板字面量不计入 / 渲染期 32KiB 超限 →
//     injection-over-limit failed 不可重试（零 create、下游作废）；渲染后豁免 8000 字符。
//   产出持久面（R.1①）——done payload 增 output（无 schema 步无此键）；写入超限 →
//     output-over-limit failed 不可重试；journal 是唯一持久面（step-done 广播不带 output）。
//   预扫回收与 resume 注入（R.1⑥）——三步中途崩溃（abortAt）→ resume completed 带 output →
//     同 journal 重跑下游 create prompt 含上游 journal output（S4 预扫回收的活体验收）。
//   matchAmend 第三维（R.1⑥）——模板同+闭包同+output 可得 → imported / 上游 changed →
//     沿引用闭包级联（多跳）/ 旧 journal done 无 output → 按变处理 / 上游 rerun → 下游按变 /
//     无占位符声明逐位不变（第三入参有/无同结果）/ 接线错误 TypeError / amend 端到端
//     （carried payload.output 落账 → 下游重跑注入有源）。
//   hole×R 陈旧防护（R.1⑦）——done 引用下游 × changed 意图上游 → TypeError 拒绝、零 journal 写；
//     pinned 同字节重投（hole 常态）恒放行；种子自身无引用入边不放行也构造不出拒绝。
//   journal 落盘字节数（R.2 验收记录）——三步 schema 声明 run 完成后实测 storage 字节数打印
//     （写放大观测基线；超 2× 再议 output 分文件——本次实测数进施工报告）。
//
// mock 端到端（R.2）经 driver.create 入参断言（harness ③ 的 mock 等价通道——harness ③ 在真机
// 窗捕获的正是同一入参），三步声明 step1(schema 产出)→step2 引用 step1 产出 → create args.prompt
// 含上游 JSON 段。
//
// 夹具全合成（内存 storage + 可控时钟 + mock driver），沿用 engine-scheduler.test.mjs 装具同款。
//
// 运行：node plugin/test/engine-dataplane.test.mjs（assert 失败即抛、非零退出；成功自然退出）
import assert from 'node:assert/strict'

import { retryPrompt } from '../src/engine/ask.js'
import { validateDeclaration, validateStep } from '../src/engine/declaration.js'
import { escalationPrompt } from '../src/engine/escalation.js'
import { createDriver } from '../src/engine/driver.js'
import { createJournal } from '../src/engine/journal.js'
import { STEP_OUTPUT_LIMIT_BYTES, renderPrompt } from '../src/engine/prompt-render.js'
import { amend, matchAmend, resume } from '../src/engine/resume.js'
import { run } from '../src/engine/scheduler.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- 夹具基座（与 engine-scheduler.test.mjs 同款）----
const memStorage = () => {
  let text = null
  return { read: () => text, write: (t) => (text = t) }
}
const manualClock = (start = 10_000) => {
  let t = start
  const now = () => t
  now.advance = (ms) => {
    t += ms
    return t
  }
  return now
}
const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = (p, ms = 8000) => {
  let timer = null
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('run() 未在时限内终局（调度循环悬挂）')), ms)
  })
  return Promise.race([p, watchdog]).finally(() => clearTimeout(timer))
}
/** 可喂事件的 AsyncIterable（engine-scheduler.test.mjs 同款）：feed 唤醒挂起的 next()。 */
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
/**
 * 事件驱动泵：持续喂 idle 事件唤醒主循环（§2-3「事件到达才查」），run 终局/拒绝即停；
 * 返回 settle(p)（终局结果或拒绝原样上抛）。调度循环不轮询静默事件源——喂事件是 mock
 * 驱动完成的标准姿势（engine-scheduler.test.mjs 同款）。
 */
const drive = async (bus, p, ms = 8000) => {
  let done = false
  p.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )
  const t0 = Date.now()
  while (!done && Date.now() - t0 < ms) {
    bus.feed(idleEv())
    await tick()
  }
  return settle(p, 1000)
}

/** 三步数据面声明：a(schema 产出) → b 引用 a → c 引用 b（R.2 mock 端到端 / resume 注入 / 字节实测共用）。 */
const threeSteps = () => [
  { stepId: 'a', prompt: 'produce A', deps: [], schema: { type: 'object' } },
  { stepId: 'b', prompt: 'merge {{outputs.a}} into report', deps: ['a'], schema: { type: 'object' } },
  { stepId: 'c', prompt: 'check {{outputs.b.note}}', deps: ['b'] },
]
const OUT_A = { sum: 'A1' }
const OUT_B = { note: 'B1' }
const A_DONE = JSON.stringify(OUT_A)
const B_DONE = JSON.stringify(OUT_B)
/** b/c 的 create prompt = 渲染后文本（调度器与测试共用 renderPrompt——断言「逐字符相等」）。 */
const RENDERED_B = renderPrompt('merge {{outputs.a}} into report', { a: OUT_A }).prompt
const RENDERED_C = renderPrompt('check {{outputs.b.note}}', { b: OUT_B }).prompt

/** 一套测试装具（engine-scheduler.test.mjs rig 的数据面窄化版）：bus 供 drive() 喂 idle 事件。 */
const rig = ({ runId, steps, scenarios = [], now = manualClock(), fault = null, storage = memStorage(), driver: customDriver, retry, escalation, hole, journal: reuseJournal }) => {
  const runEvents = []
  const bus = makeEvents()
  const journal = reuseJournal ?? createJournal({ storage, runId, now, onEvent: (e) => runEvents.push(e) }) // 事件计数复用 runEvents
  const driver = customDriver ?? createDriver('mock', { scenarios, now, fault })
  const p = run({ runId, steps }, { journal, driver, fault, events: bus.events, now, onEvent: (e) => runEvents.push(e), retry, escalation, hole })
  return { p, journal, driver, storage, runEvents, bus }
}
const createPrompts = (driver) => driver.calls.filter((c) => c.op === 'create').map((c) => c.args.prompt)
const sc = (id, prompt, result, extra = {}) => ({ name: id, match: { prompt }, result: Array.isArray(result) ? result : [result], ...extra })

// ---- 1. 词法五态（R.1②；R.2 验收第 1 条）----
console.log('1. 词法五态')
{
  const base = (steps) => ({ runId: 'run-lex', steps })
  const a = { stepId: 'a', prompt: 'produce', deps: [], schema: { type: 'object' } }
  const use = (prompt, deps = ['a'], schema = { type: 'object' }) => ({ stepId: 'b', prompt, deps, schema })

  // 两条严格语法（整对象 / 恰一层 key）通过
  const r0 = validateDeclaration(base([a, use('x {{outputs.a}} y {{outputs.a.key1}} z')]))
  assert.equal(r0.ok, true, `两条合法语法应通过：${r0.errors.join('; ')}`)
  ok('词法·两形通过：{{outputs.a}} 整对象 + {{outputs.a.key1}} 恰一层 key')

  // ① 无空白容差
  const r1 = validateDeclaration(base([a, use('{{ outputs.a }}')]))
  assert.equal(r1.ok, false)
  assert.ok(r1.errors.some((e) => e.includes('steps[1].prompt') && e.includes('无空白容差')), r1.errors.join('; '))
  ok('词法·无空白容差：{{ outputs.a }} 编译错')

  // ② 深 key（含点 key → 编译错，文案「深数据请整对象引用或走文件总线」）
  const r2 = validateDeclaration(base([a, use('{{outputs.a.b.c}}')]))
  assert.equal(r2.ok, false)
  assert.ok(r2.errors.some((e) => e.includes('深数据请整对象引用或走文件总线')), r2.errors.join('; '))
  // 数组下标同文案
  const r2b = validateDeclaration(base([a, use('{{outputs.a[0]}}')]))
  assert.equal(r2b.ok, false)
  assert.ok(r2b.errors.some((e) => e.includes('深数据请整对象引用或走文件总线')), r2b.errors.join('; '))
  ok('词法·深 key 与数组下标编译错（深数据请整对象引用或走文件总线）')

  // ③ 字面 {{（不匹配两形）
  const r3 = validateDeclaration(base([a, use('模板 {{literal}} 交付')]))
  assert.equal(r3.ok, false)
  assert.ok(r3.errors.some((e) => e.includes('不匹配占位语法')), r3.errors.join('; '))
  ok('词法·字面 {{…}} 编译错（改写文风或走文件总线）')

  // ④ 未闭合
  const r4 = validateDeclaration(base([a, use('{{outputs.a')]))
  assert.equal(r4.ok, false)
  assert.ok(r4.errors.some((e) => e.includes('未闭合')), r4.errors.join('; '))
  ok('词法·未闭合 {{ 编译错')

  // ⑤ 含点号 stepId：词法歧义源头编译错 + Q1 Did-you-mean 候选
  const r5 = validateDeclaration(base([{ stepId: 'a.b', prompt: 'p', deps: [], schema: {} }, { stepId: 'ab', prompt: 'p', deps: [], schema: {} }]))
  assert.equal(r5.ok, false)
  assert.ok(r5.errors.some((e) => e.includes('steps[0].stepId') && e.includes('"a.b"') && e.includes('最近候选 "ab"')), r5.errors.join('; '))
  // 无空白字符约束（stepId 带空格同拒）
  const r5b = validateDeclaration(base([{ stepId: 'a b', prompt: 'p', deps: [] }]))
  assert.equal(r5b.ok, false)
  assert.ok(r5b.errors.some((e) => e.includes('steps[0].stepId')), r5b.errors.join('; '))
  ok('词法·含点号/空白 stepId 编译错 + Q1 候选')

  // validateStep 单步面同一词法（无三查）
  const sv = validateStep({ stepId: 'a', prompt: '{{ outputs.a }}', deps: [] })
  assert.equal(sv.ok, false)
  assert.ok(sv.errors.some((e) => e.startsWith('step.prompt:') && e.includes('无空白容差')), sv.errors.join('; '))
  const svOk = validateStep({ stepId: 'a', prompt: 'plain', deps: [] })
  assert.equal(svOk.ok, true)
  ok('词法·validateStep 单步面同一词法（引用三查不查——声明级性质）')
}

// ---- 2. 引用三查三态（R.1③）----
console.log('2. 引用三查')
{
  const base = (steps) => ({ runId: 'run-ref', steps })
  // ① 缺 stepId → Q1 候选
  const r1 = validateDeclaration(base([
    { stepId: 'step1', prompt: 'p', deps: [], schema: {} },
    { stepId: 'b', prompt: '{{outputs.stepx}}', deps: [], schema: {} },
  ]))
  assert.equal(r1.ok, false)
  assert.ok(r1.errors.some((e) => e.includes('占位符引用未知 stepId "stepx"') && e.includes('最近候选 "step1"')), r1.errors.join('; '))
  ok('三查①·缺 stepId → 编译错 + Q1 最近候选')

  // ② 非传递闭包上游（直接与间接两形）
  const r2 = validateDeclaration(base([
    { stepId: 'a', prompt: 'p', deps: [], schema: {} },
    { stepId: 'b', prompt: 'p', deps: [], schema: {} },
    { stepId: 'c', prompt: '{{outputs.a}}', deps: ['b'], schema: {} },
  ]))
  assert.equal(r2.ok, false)
  assert.ok(r2.errors.some((e) => e.includes('不在本步 deps 传递闭包内')), r2.errors.join('; '))
  ok('三查②·非传递闭包上游编译错')

  // ③ 被引步无 schema
  const r3 = validateDeclaration(base([
    { stepId: 'a', prompt: 'p', deps: [] },
    { stepId: 'b', prompt: '{{outputs.a}}', deps: ['a'], schema: {} },
  ]))
  assert.equal(r3.ok, false)
  assert.ok(r3.errors.some((e) => e.includes('无 schema——该步无结构化产出可引用')), r3.errors.join('; '))
  ok('三查③·被引步无 schema 编译错')

  // 传递闭包链通过：c 经 deps [b] 传递可达 a
  const good = validateDeclaration(base([
    { stepId: 'a', prompt: 'p', deps: [], schema: {} },
    { stepId: 'b', prompt: 'use {{outputs.a}}', deps: ['a'], schema: {} },
    { stepId: 'c', prompt: 'use {{outputs.a}} {{outputs.b}}', deps: ['b'], schema: {} },
  ]))
  assert.equal(good.ok, true, good.errors.join('; '))
  ok('三查·传递闭包链通过（c 沿 b 传递可达 a）')
}

// ---- 3. renderPrompt 纯函数导出（R.1④⑤ 单元面）----
console.log('3. renderPrompt')
{
  assert.equal(typeof renderPrompt, 'function', 'renderPrompt 必须是导出函数')
  const outputs = { a: { k: 'v1', n: 2 } }
  const snapshot = JSON.stringify(outputs)
  const r1 = renderPrompt('A={{outputs.a}} B={{outputs.a.k}}', outputs)
  assert.equal(r1.ok, true)
  assert.equal(r1.prompt, `A=${JSON.stringify(outputs.a)} B="v1"`)
  assert.ok(r1.injectedBytes > 0)
  assert.deepEqual(r1.refs, ['a'])
  // 纯函数：同参同果逐字节等 + 入参未被 mutate
  const r2 = renderPrompt('A={{outputs.a}} B={{outputs.a.k}}', outputs)
  assert.deepEqual(r1, r2)
  assert.equal(JSON.stringify(outputs), snapshot)
  const bytes1 = Buffer.byteLength(JSON.stringify(outputs.a), 'utf8') + Buffer.byteLength('"v1"', 'utf8')
  assert.equal(r1.injectedBytes, bytes1)
  ok(`renderPrompt 纯函数导出：整对象/一层 key/同参同果/入参不变；签名 (template, outputs) → { ok, prompt, injectedBytes, refs }`)

  // 重复引用重复累计；模板字面量不计入
  const unit = JSON.stringify(outputs.a)
  const r3 = renderPrompt('lit {{outputs.a}} mid {{outputs.a}} lit2', outputs)
  assert.equal(r3.injectedBytes, Buffer.byteLength(unit, 'utf8') * 2, '两次引用两次累计')
  assert.ok(r3.prompt.startsWith('lit '), '模板字面量原样保留')
  ok('注入字节：重复引用重复累计 / 模板字面量不计入')

  // 渲染期 32KiB 超限 → ok:false injection-over-limit（bytes/limit 在场）
  const big = { blob: 'x'.repeat(20000) }
  const r4 = renderPrompt('{{outputs.big}}{{outputs.big}}', { big })
  assert.equal(r4.ok, false)
  assert.equal(r4.reason, 'injection-over-limit')
  assert.equal(r4.limit, STEP_OUTPUT_LIMIT_BYTES)
  assert.ok(r4.bytes > STEP_OUTPUT_LIMIT_BYTES)
  const r4single = renderPrompt('{{outputs.big}}', { big })
  assert.equal(r4single.ok, true, '单引用未超限应通过（写入面同值对齐的镜像）')
  ok('渲染期注入上限：重复引用累计超 32KiB → injection-over-limit（bytes/limit 在场）')

  // 缺产出 / 缺 key
  assert.equal(renderPrompt('{{outputs.ghost}}', {}).reason, 'missing-output')
  assert.equal(renderPrompt('{{outputs.a.nope}}', { a: { k: 1 } }).reason, 'missing-key')
  ok('渲染失败面：missing-output / missing-key（宁失败不猜）')

  // 先渲染后组装附言：附言中的字面 {{ 不参与解析
  const base2 = 'go {{outputs.a.k}}'
  const rendered = renderPrompt(base2, { a: { k: 'use {{outputs.ghost}} here' } }).prompt
  assert.ok(rendered.includes('"use {{outputs.ghost}} here"'), '注入值里的字面 {{ 原样进 prompt')
  const withRetry = retryPrompt(rendered, ['产出.k: 必须是字符串（得到 number）'], { attempt: 2, maxAttempts: 3 })
  assert.ok(withRetry.startsWith(rendered), '附言拼在渲染结果之后')
  assert.ok(withRetry.includes('{{outputs.ghost}}'), '附言整段未被二次解析')
  const withEsc = escalationPrompt(rendered, '继续吗', '{{outputs.a}} 是注入尝试')
  assert.ok(withEsc.includes('{{outputs.a}} 是注入尝试'), '答复文本字面 {{ 原样保留')
  ok('先渲染后组装附言：retryPrompt/escalationPrompt 字面 {{ 不二次替换')
}

// ---- 4. scheduler 注入上限（R.1⑤：渲染期超限 → failed 不可重试）----
console.log('4. 注入超限 failed')
{
  const storage = memStorage()
  const UP_OUT = { blob: 'x'.repeat(20000) } // 单次产出 ~20030B ≤ 32768（写入面过）
  const decl = {
    runId: 'run-inject-limit',
    steps: [
      { stepId: 'up', prompt: 'produce', deps: [], schema: { type: 'object' } },
      { stepId: 'down', prompt: 'A{{outputs.up}}B{{outputs.up}}', deps: ['up'] }, // 2×20030 > 32768
      { stepId: 'tail', prompt: 'after', deps: ['down'] },
    ],
  }
  const scenarios = [
    sc('up', 'produce', { status: 'done', text: JSON.stringify(UP_OUT) }),
    sc('down', `A${JSON.stringify(UP_OUT)}B${JSON.stringify(UP_OUT)}`, { status: 'done', text: 'unreachable' }),
  ]
  const { p, journal, driver, bus } = rig({ runId: decl.runId, steps: decl.steps, scenarios, storage })
  const result = await drive(bus, p)
  assert.equal(result.status, 'failed')
  const down = journal.getStepState('down')
  assert.equal(down.state, 'failed')
  const failEntry = [...down.history].reverse().find((h) => h.to === 'failed')
  assert.equal(failEntry.payload.reason, 'injection-over-limit', JSON.stringify(failEntry.payload))
  assert.equal(failEntry.payload.limit, STEP_OUTPUT_LIMIT_BYTES)
  assert.ok(failEntry.payload.bytes > STEP_OUTPUT_LIMIT_BYTES)
  assert.equal(failEntry.payload.bytes, 2 * Buffer.byteLength(JSON.stringify(UP_OUT), 'utf8'), '重复引用重复累计进 bytes')
  assert.equal(driver.calls.filter((c) => c.op === 'create' && c.args.title.includes('down')).length, 0, '渲染失败在 create 之前——零派发')
  assert.equal(journal.getStepState('tail').state, 'superseded', '下游作废')
  assert.deepEqual(down.history.map((h) => [h.from, h.to]), [[null, 'declared'], ['declared', 'dispatching'], ['dispatching', 'failed']], '不可重试：无 failed→dispatching 重入边')
  assert.equal(journal.getStepState('up').state, 'done')
  ok('注入超限 → down failed（payload bytes/limit、重复累计、零 create、下游作废、不可重试）')
}

// ---- 5. 产出持久面（R.1①：done payload.output + 写入超限）----
console.log('5. 产出持久面')
{
  // 5a. done payload 形状：schema 步有 output、无 schema 步无 output 键；广播不带 output
  const storage = memStorage()
  const decl = { runId: 'run-out-shape', steps: threeSteps() }
  const scenarios = [
    sc('a', 'produce A', { status: 'done', text: A_DONE }),
    sc('b', RENDERED_B, { status: 'done', text: B_DONE }),
    sc('c', RENDERED_C, { status: 'done', text: '{"final":true}' }),
  ]
  const { p, runEvents, driver, bus } = rig({ runId: decl.runId, steps: decl.steps, scenarios, storage })
  const result = await drive(bus, p)
  assert.equal(result.status, 'completed')
  const record = JSON.parse(storage.read())
  const payloadOf = (id) => [...record.steps[id].history].reverse().find((h) => h.to === 'done').payload
  assert.deepEqual(payloadOf('a').output, OUT_A, 'schema 步 done payload 增 output')
  assert.deepEqual(payloadOf('b').output, OUT_B, 'schema 步 b 同')
  assert.equal(payloadOf('c').output, undefined, '无 schema 步无 output 键')
  assert.deepEqual(payloadOf('c').result, { text: '{"final":true}' })
  const stepDoneEvents = runEvents.filter((e) => e.type === 'step-done')
  assert.equal(stepDoneEvents.length, 3)
  assert.ok(stepDoneEvents.every((e) => e.output === undefined && e.payload === undefined), '广播面 step-done 不重复存储 output')
  // mock 端到端（R.2，harness ③ 通道的 mock 等价物）：b 的 create args.prompt 含上游 JSON 段
  const prompts = createPrompts(driver)
  assert.ok(prompts[1].includes('"sum":"A1"'), `b 的 create prompt 应含上游 JSON 段：${prompts[1]}`)
  assert.ok(prompts[2].includes('"B1"'), `c 的 create prompt 含 b 的 output 段（key 路径只注值）：${prompts[2]}`)
  assert.equal(prompts[1], RENDERED_B, 'create prompt 与 renderPrompt 产物逐字符相等')
  ok('done payload.output 形状（无 schema 无此键）+ 广播不带 output + create prompt 含上游 JSON 段')

  // 5b. journal 写入超限 → output-over-limit failed 不可重试
  const storage2 = memStorage()
  const BIG = { blob: 'x'.repeat(33000) }
  const decl2 = {
    runId: 'run-out-limit',
    steps: [
      { stepId: 'big', prompt: 'produce', deps: [], schema: { type: 'object' } },
      { stepId: 'after', prompt: 'next', deps: ['big'] },
    ],
  }
  const scenarios2 = [sc('big', 'produce', { status: 'done', text: JSON.stringify(BIG) })]
  const { p: p2, journal: j2, driver: d2, bus: bus2 } = rig({ runId: decl2.runId, steps: decl2.steps, scenarios: scenarios2, storage: storage2 })
  const result2 = await drive(bus2, p2)
  assert.equal(result2.status, 'failed')
  const bigState = j2.getStepState('big')
  assert.equal(bigState.state, 'failed')
  const bigFail = [...bigState.history].reverse().find((h) => h.to === 'failed')
  assert.equal(bigFail.payload.reason, 'output-over-limit')
  assert.equal(bigFail.payload.limit, STEP_OUTPUT_LIMIT_BYTES)
  assert.ok(bigFail.payload.bytes > STEP_OUTPUT_LIMIT_BYTES)
  assert.equal(bigFail.payload.attempt, 1)
  assert.equal(d2.calls.filter((c) => c.op === 'create' && c.args.title.includes('big')).length, 1, '恰 1 次派发（不可重试）')
  assert.deepEqual(bigState.history.map((h) => [h.from, h.to]), [[null, 'declared'], ['declared', 'dispatching'], ['dispatching', 'running'], ['running', 'failed']], 'running→failed 直接终态，无重试环')
  assert.equal(j2.getStepState('after').state, 'superseded')
  ok('journal 写入超限 → output-over-limit failed（bytes/limit、恰 1 派发、下游作废、不可重试）')

  // 5c. 渲染后 prompt 豁免 8000 字符 schema 上限（模板本体 ≤8000，渲染后 ~40KB 照常派发）
  const storage3 = memStorage()
  const BIGISH = { blob: 'y'.repeat(9000) } // 单产出 ~9KB > 8000；单引用 ~9KB ≤ 32768
  const decl3 = {
    runId: 'run-exempt-8000',
    steps: [
      { stepId: 'big', prompt: 'produce', deps: [], schema: { type: 'object' } },
      { stepId: 'use', prompt: 'E{{outputs.big}}F', deps: ['big'], schema: { type: 'object' } },
    ],
  }
  const rendered3 = renderPrompt('E{{outputs.big}}F', { big: BIGISH }).prompt
  assert.ok(rendered3.length > 8000, '渲染后 prompt 应超 8000 字符')
  const scenarios3 = [
    sc('big', 'produce', { status: 'done', text: JSON.stringify(BIGISH) }),
    sc('use', rendered3, { status: 'done', text: '{"ok":1}' }),
  ]
  const { p: p3, bus: bus3 } = rig({ runId: decl3.runId, steps: decl3.steps, scenarios: scenarios3, storage: storage3 })
  const result3 = await drive(bus3, p3)
  assert.equal(result3.status, 'completed', `渲染后 >8000 字符应照常派发完成：${JSON.stringify(result3.steps)}`)
  ok('渲染后 prompt 豁免 8000 字符 schema 上限（模板本体仍受 8000 约束）')
}

// ---- 6. resume 续跑注入（R.1⑥：S4 预扫回收 → 下游注入 = journal 上游 output）----
console.log('6. resume 续跑注入')
{
  const storage = memStorage()
  const decl = { runId: 'run-resume-inject', steps: threeSteps() }
  // 崩溃现场播种（journal 公共写面，与 engine-resume.test.mjs 夹具同款）：进程在 b done 之后、
  // c 派发之前死掉——盘上 a/b done（done 迁移 payload 带 output）、c 尚未注册。abortAt 注入
  // 的崩溃位在 dispatching（engine-resume A2 已断言其机制），S4 续跑只接 declared/done，
  // 所以这里取「c 派发前」的真实崩溃点，续跑面正是 S4。
  const crashJournal = createJournal({ storage, runId: decl.runId, now: manualClock() })
  const chain = [
    ['a', A_DONE],
    ['b', B_DONE],
  ]
  for (const [id, text] of chain) {
    for (const [from, to] of [[null, 'declared'], ['declared', 'dispatching'], ['dispatching', 'running'], ['running', 'done']]) {
      const payload = to === 'running' ? { sessionId: `sess-${id}` } : to === 'done' ? { result: { text }, sessionId: `sess-${id}`, output: JSON.parse(text) } : undefined
      assert.equal(crashJournal.appendStepState(id, from, to, payload).ok, true)
    }
  }
  const jOld = createJournal({ storage, runId: decl.runId, now: manualClock() })
  assert.equal(jOld.getStepState('a').state, 'done')
  assert.equal(jOld.getStepState('b').state, 'done')
  assert.equal(jOld.getStepState('c'), null, 'c 尚未注册（崩溃前未派发）')
  // resume：completed payload 深拷贝天然携带 output
  const plan = resume(decl, jOld)
  assert.deepEqual([...plan.pending], ['c'])
  assert.deepEqual(plan.completed.get('a').output, OUT_A)
  assert.deepEqual(plan.completed.get('b').output, OUT_B)
  ok('崩溃后 resume：completed 带 output、pending 仅 c')

  // 模拟进程重启：同 storage 新 journal（S4 预扫从盘上 done 尾条回收 output）→ c 注入 b 的 output
  const cExpected = RENDERED_C // 'check "B1"'
  const second = rig({
    runId: decl.runId,
    steps: decl.steps,
    scenarios: [sc('c', cExpected, { status: 'done', text: '{"final":1}' })],
    storage,
    journal: createJournal({ storage, runId: decl.runId, now: manualClock() }),
  })
  const result = await drive(second.bus, second.p)
  assert.equal(result.status, 'completed')
  const prompts = createPrompts(second.driver)
  assert.deepEqual(prompts, [cExpected], '续跑只派 c，且 prompt = 预扫 output 渲染产物')
  assert.ok(prompts[0].includes('"B1"'), `下游注入 = journal 上游 output：${prompts[0]}`)
  assert.equal(second.journal.getStepState('c').state, 'done')
  ok('S4 预扫回收 output → resume 续跑 c 注入 b 的 journal output（活体断言）')
}

// ---- 7. 二次替换防护（R.1④ mock 全程：注入值含字面 {{ 的步走窄域重试）----
console.log('7. 二次替换防护')
{
  const storage = memStorage()
  const UP_OUT = { txt: 'use {{outputs.ghost}} here' } // 注入值含字面 {{（ghost 不存在也不该被解析）
  const STRICT = { type: 'object', properties: { k: { type: 'string' } }, required: ['k'], additionalProperties: false }
  const decl = {
    runId: 'run-double-render',
    steps: [
      { stepId: 'up', prompt: 'produce', deps: [], schema: { type: 'object' } },
      { stepId: 'dep', prompt: 'go {{outputs.up.txt}} then', deps: ['up'], schema: STRICT },
    ],
  }
  const rendered = renderPrompt('go {{outputs.up.txt}} then', { up: UP_OUT }).prompt
  const RETRY_ERRORS = ['产出.k: 必须是字符串（得到 number）'] // validateValue 确定性文案
  const retryExpected = retryPrompt(rendered, RETRY_ERRORS, { attempt: 2, maxAttempts: 3 })
  const scenarios = [
    sc('up', 'produce', { status: 'done', text: JSON.stringify(UP_OUT) }),
    sc('dep', rendered, { status: 'done', text: '{"k":1}' }), // 第 1 次 schema-invalid → cooldown 重派
    sc('dep-retry', retryExpected, { status: 'done', text: '{"k":"ok"}' }), // 重派 prompt 逐字符命中
  ]
  const { p, journal, driver, bus } = rig({ runId: decl.runId, steps: decl.steps, scenarios, storage, retry: { cooldownMs: 0 } })
  const result = await drive(bus, p)
  assert.equal(result.status, 'completed', `重试后应完成：${JSON.stringify(result.steps)}`)
  const prompts = createPrompts(driver)
  assert.equal(prompts.length, 3, '恰三次派发（up + dep 初派 + dep 重派）')
  assert.equal(prompts[1], rendered, '初派 prompt = 渲染后模板本体')
  assert.ok(prompts[2].startsWith(rendered), '重派 prompt = 渲染后模板 + 错误附言（附言后拼）')
  assert.ok(prompts[2].includes('{{outputs.ghost}}'), '注入值里的字面 {{ 未被二次解析')
  assert.equal(prompts[2], retryExpected, '重派 prompt 逐字符 = retryPrompt(渲染后, 错误, …)')
  assert.equal(journal.getStepState('dep').state, 'done')
  ok('窄域重试全程：先渲染后附言，注入值字面 {{ 不二次替换（prompt 逐字符断言）')
}

// ---- 7b. escalation 答复含字面 {{ 不二次替换（Q：答复文本参与渲染吗——不参与）----
console.log('7b. escalation 答复二次替换防护')
{
  const storage = memStorage()
  const decl = { runId: 'run-esc-literal', steps: [{ stepId: 'q', prompt: 'ask humans', deps: [] }] }
  const ANSWER = '{{outputs.q}} 是注入尝试'
  const escExpected = escalationPrompt('ask humans', '继续吗', ANSWER)
  const scenarios = [
    sc('q', 'ask humans', { status: 'done', text: '{"question":"继续吗","n":1}' }), // 挂起
    sc('q-recovery', escExpected, { status: 'done', text: '{"done":2}' }), // 答复后重派（新会话新 prompt）
  ]
  const { p, journal, driver, bus } = rig({
    runId: decl.runId,
    steps: decl.steps,
    scenarios,
    storage,
    escalation: { answerFor: () => ANSWER },
  })
  const result = await drive(bus, p)
  assert.equal(result.status, 'completed')
  const prompts = createPrompts(driver)
  assert.equal(prompts.length, 2)
  assert.equal(prompts[1], escExpected, '恢复派发 prompt = escalationPrompt(渲染后模板, 问句, 答复)')
  assert.ok(prompts[1].includes(ANSWER), '答复中的字面 {{ 逐字保留')
  assert.equal(journal.getStepState('q').state, 'done')
  ok('escalation 答复含字面 {{ → 恢复派发逐字保留、零二次替换')
}

// ---- 8. matchAmend 第三维（R.1⑥）----
console.log('8. matchAmend 第三维')
{
  const runId = 'run-amend-3d'
  // 先跑一份旧 run 到完成（up done 带 output、down done 带 output）
  const oldDecl = {
    runId,
    steps: [
      { stepId: 'up', prompt: 'produce up', deps: [], schema: { type: 'object' } },
      { stepId: 'down', prompt: 'use {{outputs.up}}', deps: ['up'], schema: { type: 'object' } },
    ],
  }
  const storage = memStorage()
  const upOut = { k: 'V1' }
  const scenarios = [
    sc('up', 'produce up', { status: 'done', text: JSON.stringify(upOut) }),
    sc('down', renderPrompt('use {{outputs.up}}', { up: upOut }).prompt, { status: 'done', text: '{"d":1}' }),
  ]
  const first = rig({ runId, steps: oldDecl.steps, scenarios, storage })
  const oldResult = await drive(first.bus, first.p)
  assert.equal(oldResult.status, 'completed')
  const oldJournal = createJournal({ storage, runId, now: manualClock() })

  const newDecl = (downPrompt) => ({
    runId: 'run-amend-new',
    steps: [
      { stepId: 'up', prompt: 'produce up', deps: [], schema: { type: 'object' } },
      { stepId: 'down', prompt: downPrompt ?? 'use {{outputs.up}}', deps: ['up'], schema: { type: 'object' } },
    ],
  })

  // 8a. 模板同 + 引用闭包上游同 + output 可得 → imported
  const v = matchAmend(oldDecl, newDecl(), oldJournal)
  assert.deepEqual(v, { imported: ['up', 'down'], changed: [], added: [], dropped: [] })
  ok('三查·模板同+闭包上游 imported+旧 output 可得 → imported')

  // 8b. 上游 changed → 沿引用闭包级联（下游模板同也按变）
  const v2 = matchAmend(oldDecl, newDecl('use {{outputs.up}} v2'), oldJournal) // down 改了模板
  assert.deepEqual(v2, { imported: ['up'], changed: ['down'], added: [], dropped: [] })
  const upChanged = {
    runId: 'run-amend-new',
    steps: [
      { stepId: 'up', prompt: 'produce up - bumped 42', deps: [], schema: { type: 'object' } },
      { stepId: 'down', prompt: 'use {{outputs.up}}', deps: ['up'], schema: { type: 'object' } },
    ],
  }
  const v3 = matchAmend(oldDecl, upChanged, oldJournal) // up 模板变、down 模板同 → down 级联
  assert.deepEqual(v3, { imported: [], changed: ['up', 'down'], added: [], dropped: [] })
  ok('级联·上游 changed → 引用下游按「output 变」级联（含多跳见 8e）')

  // 8c. 旧 journal done 无 output（迁移现场）→ 按变处理
  const legacyStorage = memStorage()
  const legacyJournal = createJournal({ storage: legacyStorage, runId, now: manualClock() })
  for (const id of ['up', 'down']) {
    for (const [from, to] of [[null, 'declared'], ['declared', 'dispatching'], ['dispatching', 'running'], ['running', 'done']]) {
      assert.equal(legacyJournal.appendStepState(id, from, to, to === 'done' ? { result: { text: 'legacy' }, sessionId: `s-${id}` } : undefined).ok, true)
    }
  }
  const v4 = matchAmend(oldDecl, newDecl(), legacyJournal)
  assert.deepEqual(v4, { imported: ['up'], changed: ['down'], added: [], dropped: [] }, '旧 done payload 缺 output → 下游按变')
  ok('迁移现场·旧 journal done 无 output → 引用下游按变处理')

  // 8d. 上游 rerun（imported 但旧 run 未 done）→ 下游按变
  const rerunStorage = memStorage()
  const rerunJournal = createJournal({ storage: rerunStorage, runId, now: manualClock() })
  for (const [from, to] of [[null, 'declared'], ['declared', 'dispatching'], ['dispatching', 'running'], ['running', 'failed']]) {
    assert.equal(rerunJournal.appendStepState('up', from, to, to === 'failed' ? { reason: 'timeout' } : undefined).ok, true)
  }
  assert.equal(rerunJournal.appendStepState('down', null, 'declared').ok, true)
  const v5 = matchAmend(oldDecl, newDecl(), rerunJournal)
  assert.deepEqual(v5, { imported: ['up'], changed: ['down'], added: [], dropped: [] }, '上游 rerun → 下游级联')
  ok('rerun 现场·上游 imported 但未 done → 引用下游按变处理')

  // 8e. 多跳级联：a→b(refs a)→c(refs b)，a 变 → b、c 全级联
  const chainOld = {
    runId: 'run-chain',
    steps: [
      { stepId: 'a', prompt: 'pa', deps: [], schema: {} },
      { stepId: 'b', prompt: 'pb {{outputs.a}}', deps: ['a'], schema: {} },
      { stepId: 'c', prompt: 'pc {{outputs.b}}', deps: ['b'], schema: {} },
    ],
  }
  const chainStorage = memStorage()
  const chainScenarios = [
    sc('a', 'pa', { status: 'done', text: '{"x":1}' }),
    sc('b', renderPrompt('pb {{outputs.a}}', { a: { x: 1 } }).prompt, { status: 'done', text: '{"y":2}' }),
    sc('c', renderPrompt('pc {{outputs.b}}', { b: { y: 2 } }).prompt, { status: 'done', text: '{"z":3}' }),
  ]
  const chainRun = rig({ runId: 'run-chain', steps: chainOld.steps, scenarios: chainScenarios, storage: chainStorage })
  assert.equal((await drive(chainRun.bus, chainRun.p)).status, 'completed')
  const chainJournal = createJournal({ storage: chainStorage, runId: 'run-chain', now: manualClock() })
  const chainNew = {
    runId: 'run-chain-new',
    steps: [
      { stepId: 'a', prompt: 'pa v2', deps: [], schema: {} },
      { stepId: 'b', prompt: 'pb {{outputs.a}}', deps: ['a'], schema: {} },
      { stepId: 'c', prompt: 'pc {{outputs.b}}', deps: ['b'], schema: {} },
    ],
  }
  const v6 = matchAmend(chainOld, chainNew, chainJournal)
  assert.deepEqual(v6, { imported: [], changed: ['a', 'b', 'c'], added: [], dropped: [] }, '引用闭包级联传递：a 变 → b、c 全变')
  ok('级联·多跳引用闭包传递（上游的上游变 → 全链重跑）')

  // 8f. 无占位符声明：第三入参有/无同结果（旧判据逐位不变）
  const plainOld = { runId: 'run-plain', steps: [{ stepId: 's1', prompt: 'p1', deps: [] }, { stepId: 's2', prompt: 'p2', deps: ['s1'] }] }
  const plainNew = { runId: 'run-plain-new', steps: [{ stepId: 's1', prompt: 'p1', deps: [] }, { stepId: 's2', prompt: 'p2 CHANGED', deps: ['s1'] }] }
  assert.deepEqual(matchAmend(plainOld, plainNew), matchAmend(plainOld, plainNew, oldJournal))
  assert.deepEqual(matchAmend(plainOld, plainNew), { imported: ['s1'], changed: ['s2'], added: [], dropped: [] })
  ok('无占位符声明导入行为逐位不变（第三入参有/无同结果）')

  // 8g. 接线错误：含引用缺 oldJournal → TypeError；runId 不符 → TypeError
  assert.throws(() => matchAmend(oldDecl, newDecl()), TypeError, '含引用缺第三入参应 TypeError')
  assert.throws(() => matchAmend(oldDecl, newDecl(), createJournal({ storage: memStorage(), runId: 'other-run', now: manualClock() })), TypeError, 'oldJournal 归属 run 不符应 TypeError')
  ok('接线错误：缺 oldJournal / runId 不符 → TypeError fail-fast')

  // 8h. amend 端到端：carried payload.output 落账 → 下游重跑注入有源
  const freshStorage = memStorage()
  const amended = amend(oldDecl, newDecl('use {{outputs.up}} v2'), oldJournal, { storage: freshStorage, now: manualClock() })
  assert.equal(amended.ok, true, JSON.stringify(amended))
  assert.deepEqual(amended.carried, ['up'])
  assert.deepEqual(amended.changed, ['down'])
  const newRecord = JSON.parse(freshStorage.read())
  const carriedPayload = [...newRecord.steps.up.history].reverse().find((h) => h.to === 'done').payload
  assert.deepEqual(carriedPayload.output, upOut, 'carried 步旧 payload.output 随深拷贝落账')
  // 新 run 跑 down：create prompt 含 carried output（S4 预扫回收）
  const downExpected = renderPrompt('use {{outputs.up}} v2', { up: upOut }).prompt
  const after = rig({
    runId: 'run-amend-new',
    steps: newDecl('use {{outputs.up}} v2').steps,
    scenarios: [sc('down', downExpected, { status: 'done', text: '{"d":2}' })],
    storage: freshStorage,
    journal: createJournal({ storage: freshStorage, runId: 'run-amend-new', now: manualClock() }),
  })
  const afterResult = await drive(after.bus, after.p)
  assert.equal(afterResult.status, 'completed')
  assert.deepEqual(createPrompts(after.driver), [downExpected], 'amend 后下游重跑注入 carried output')
  ok('amend 端到端：carried output 落账 → 新 run 下游注入有源（零假完成）')
}

// ---- 9. hole×R 陈旧防护（R.1⑦）----
console.log('9. hole 陈旧防护')
{
  const runId = 'run-hole-stale'
  const decl = {
    runId,
    steps: [
      { stepId: 'a', prompt: 'produce a', deps: [], schema: { type: 'object' } },
      { stepId: 'b', prompt: 'use {{outputs.a}}', deps: ['a'], schema: { type: 'object' } },
      { stepId: 'keepalive', prompt: 'long task', deps: ['b'] }, // 让 run 保持在飞，loop-top 有机会跑 applyHole
    ],
  }
  const storage = memStorage()
  let armed = false
  const baseDriver = createDriver('mock', {
    now: manualClock(),
    scenarios: [
      sc('a', 'produce a', { status: 'done', text: '{"z":1}' }),
      sc('b', renderPrompt('use {{outputs.a}}', { a: { z: 1 } }).prompt, { status: 'done', text: '{"q":2}' }),
      sc('keepalive', 'long task', { status: 'running' }), // 粘滞 running
    ],
  })
  const driver = {
    create: baseDriver.create.bind(baseDriver),
    context: baseDriver.context.bind(baseDriver),
    calls: baseDriver.calls,
    result: async (sid) => {
      const r = await baseDriver.result(sid)
      if (r.status === 'done' && r.text === '{"q":2}') armed = true // b done → 下一轮 loop-top 武装 pull
      return r
    },
  }
  // pinned-异内容：a 点名换内容（a done → pinned；b done 引用 a → 陈旧下游）
  const next = {
    runId,
    steps: [
      { stepId: 'a', prompt: 'produce a v2', deps: [], schema: { type: 'object' } },
      { stepId: 'b', prompt: 'use {{outputs.a}}', deps: ['a'], schema: { type: 'object' } },
      { stepId: 'keepalive', prompt: 'long task', deps: ['b'] },
    ],
  }
  const pulls = []
  const { p, journal, runEvents, bus } = rig({
    runId,
    steps: decl.steps,
    storage,
    driver,
    hole: {
      pull: () => {
        if (!armed) return null
        pulls.push(1)
        return next
      },
    },
  })
  const pGuarded = drive(bus, p)
  await assert.rejects(pGuarded, (e) => e instanceof TypeError && e.message.includes('陈旧防护') && e.message.includes('先 drop 下游'), '交接应被陈旧防护拒绝')
  assert.ok(pulls.length > 0, 'pull 被武装并实际返回了 next（拒绝不是 vacuous）')
  // 零 journal 写：无 hole 审计事件
  const events = journal.listSteps() ? JSON.parse(storage.read()).events : []
  assert.equal(events.some((e) => e.type === 'hole'), false, '拒绝交接零 journal 写')
  assert.equal(runEvents.some((e) => e.type === 'hole'), false)
  ok('hole 交接：done 引用下游 × changed 意图上游 → TypeError 拒绝、零 journal 写')

  // pinned-同字节重投（hole 常态）恒放行：整份计划原样重投（全 done + keepalive running）
  const runId2 = 'run-hole-resend'
  const decl2 = {
    runId: runId2,
    steps: [
      { stepId: 'a', prompt: 'produce a', deps: [], schema: { type: 'object' } },
      { stepId: 'b', prompt: 'use {{outputs.a}}', deps: ['a'], schema: { type: 'object' } },
      { stepId: 'keepalive', prompt: 'long task', deps: ['b'] },
    ],
  }
  const storage2 = memStorage()
  let armed2 = false
  const baseDriver2 = createDriver('mock', {
    now: manualClock(),
    scenarios: [
      sc('a', 'produce a', { status: 'done', text: '{"z":1}' }),
      sc('b', renderPrompt('use {{outputs.a}}', { a: { z: 1 } }).prompt, { status: 'done', text: '{"q":2}' }),
      // keepalive 三段：前两轮 running 保持 run 在飞（重投有窗口），第三轮 done 让 run 收口
      sc('keepalive', 'long task', [{ status: 'running' }, { status: 'running' }, { status: 'done', text: 'ka-done' }]),
    ],
  })
  const driver2 = {
    create: baseDriver2.create.bind(baseDriver2),
    context: baseDriver2.context.bind(baseDriver2),
    calls: baseDriver2.calls,
    result: async (sid) => {
      const r = await baseDriver2.result(sid)
      if (r.status === 'done' && r.text === '{"q":2}') armed2 = true
      return r
    },
  }
  const identicalNext = JSON.parse(JSON.stringify(decl2))
  const pulls2 = []
  const second = rig({
    runId: runId2,
    steps: decl2.steps,
    storage: storage2,
    driver: driver2,
    hole: {
      pull: () => {
        if (!armed2) return null
        pulls2.push(1)
        return identicalNext
      },
    },
  })
  // 重投窗口：keepalive 未收口期间 loop-top 反复 applyHole——hole 审计出现即证放行；随后 keepalive
  // 走完三段收口（drive 续喂 idle）。
  for (let i = 0; i < 4000 && !second.runEvents.some((e) => e.type === 'hole'); i += 1) {
    second.bus.feed(idleEv())
    await tick()
  }
  assert.ok(second.runEvents.some((e) => e.type === 'hole'), 'pinned 同字节重投应放行并落审计')
  assert.ok(pulls2.length > 0, '重投 pull 被武装并实际返回 next')
  // hole 应用发生在 keepalive 派发之前（loop-top applyHole 先于 dispatchReady）——keepalive 尚
  // declared 且同字节 → kept；pinned = 已开始的 a、b。
  assert.deepEqual(second.runEvents.find((e) => e.kind === 'run' && e.type === 'hole').pinned.sort(), ['a', 'b'])
  const resendResult = await drive(second.bus, second.p)
  assert.equal(resendResult.status, 'completed', '重投后 run 照常收口')
  ok('pinned 同字节重投（hole 常态）恒放行')
}

// ---- 10. journal 落盘字节数实测（R.2 验收记录：写放大观测）----
console.log('10. journal 落盘字节实测')
{
  const storage = memStorage()
  const decl = { runId: 'run-journal-bytes', steps: threeSteps() }
  const scenarios = [
    sc('a', 'produce A', { status: 'done', text: A_DONE }),
    sc('b', RENDERED_B, { status: 'done', text: B_DONE }),
    sc('c', RENDERED_C, { status: 'done', text: '{"final":true}' }),
  ]
  const { p, bus } = rig({ runId: decl.runId, steps: decl.steps, scenarios, storage })
  const result = await drive(bus, p)
  assert.equal(result.status, 'completed')
  const text = storage.read()
  const bytes = Buffer.byteLength(text, 'utf8')
  // 结构检查：output 只在各自 done payload 落账；events 审计数组无 payload/output 拷贝
  // （journal.recordEvent 不带 output——写放大受控的结构证据面）。
  const record = JSON.parse(text)
  const donePayloads = Object.values(record.steps).map((s) => [...s.history].reverse().find((h) => h.to === 'done').payload)
  assert.deepEqual(donePayloads.map((p) => p.output ?? null), [OUT_A, OUT_B, null], 'output 恰在各步 done payload 各一份')
  assert.ok(record.events.every((e) => e.payload === undefined), 'events 数组无 output 拷贝')
  ok(`journal 落盘字节数实测：三步 schema 声明 run 完成 = ${bytes} 字节（record 2 空格缩进序列化；output 不进 events）`)
  console.log(`    [验收记录] runId=${decl.runId} steps=3（schema×2）journalBytes=${bytes} bytesPerStep≈${Math.round(bytes / 3)}`)
}

console.log(`\n引擎数据面测试（R.1 门：词法五态/引用三查/渲染与上限/持久面/resume 注入/matchAmend 第三维/hole 陈旧防护/字节实测）：${passed} 项全过`)
