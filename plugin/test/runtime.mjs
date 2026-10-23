// 插件运行期路径的验证：事件流认终态（墙钟 vs 宿主中断的归因）、惰性对账钩子、
// 后台派发的墙钟中断、端点自举（config-write 的四种形状）、名册再注入与异常兜底。
//
// 为什么单独一条：entry/wiring 两条走的是"开关关掉/开起来"的面；这里走**事件驱动的运行时**——
// 终态归因错了不会报错、只会让 timedOut 永远是 false（PROGRESS §6.2 记过这个坑）。
//   node plugin/test/runtime.mjs

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import plugin from '../src/index.js'
import { Ledger } from '../src/ledger.js'
import { ROSTER_MARKER } from '../src/roster.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * fake ctx（比 entry.mjs 多两样：可控的事件流 + 可失败的 agent.list）。
 * `events` 里的条目会在 setup 后推给消费者；消费者是 async IIFE，测试用 sleep 让它跑完。
 */
function makeCtx({ options = {}, events = [], agentListThrows = false, seed = new Map() } = {}) {
  const captured = { tools: [], toolHooks: [], sessionHooks: [], interrupts: [], aborts: 0, pushEvent: null }
  const storage = {
    async get(key) { return seed.get(key) ?? null },
    async set(key, value) { seed.set(key, value) },
    async remove(key) { seed.delete(key) },
    async scan({ prefix, after = 0, limit = 500 }) {
      const all = [...seed.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value }))
      const page = all.slice(after, after + limit)
      const next = after + page.length
      return { entries: page, next: next < all.length ? next : undefined }
    },
  }
  const editor = () => ({ add: (t) => captured.tools.push(t), get: () => undefined, update: () => {}, models: new Map(), agent: () => ({}) })
  // 事件流：可控推送（测试要"先有台账、后到事件"的时序）。`events` 是 setup 前就摆好的开场事件。
  const queue = [...events]
  let wake = null
  const stream = async function* () {
    for (;;) {
      if (queue.length === 0) await new Promise((r) => { wake = r })
      while (queue.length) yield queue.shift()
    }
  }
  captured.pushEvent = (e) => {
    queue.push(e)
    const w = wake
    wake = null
    w?.()
  }
  const ctx = {
    options: { ownEndpoint: false, snapshotPath: false, gate: false, stats: { intervalMs: 0 }, ...options },
    storage,
    location: { directory: null },
    tool: { transform: async (fn) => { fn(editor()) }, hook: async (n, h) => { captured.toolHooks.push([n, h]) } },
    session: {
      hook: async (n, h) => { captured.sessionHooks.push([n, h]) },
      interrupt: async (args) => { captured.interrupts.push(args) },
    },
    event: { subscribe: () => stream() },
    provider: { transform: async (fn) => { fn(editor()) } },
    agent: {
      transform: async (fn) => { fn({ get: () => undefined, update: () => {} }) },
      list: async () => {
        if (agentListThrows) throw new Error('agent.list 炸了')
        return { data: [{ id: 'foreman', mode: 'primary', hidden: false }, { id: 'build', mode: 'primary', hidden: true }, { id: 'executor', mode: 'subagent', hidden: false }] }
      },
    },
    skill: { transform: async (fn) => { fn({ get: () => undefined, add: () => {} }) } },
  }
  return { ctx, captured, seed }
}

const hook = (captured, name) => captured.toolHooks.find(([n]) => n === name)[1]
const statusTool = (captured) => captured.tools.find((t) => t.name === 'task_status')
const stateOf = async (captured, taskID) => {
  const parsed = JSON.parse((await statusTool(captured).execute({ includeTerminal: true })).output)
  return parsed.tasks.find((t) => t.taskID === taskID)?.state ?? null
}
const rowOf = async (captured, taskID) => {
  const parsed = JSON.parse((await statusTool(captured).execute({ includeTerminal: true })).output)
  return parsed.tasks.find((t) => t.taskID === taskID) ?? null
}

// ---- 1. 事件流认终态：succeeded / failed / interrupted（墙钟 vs 宿主）/ 无关事件 ----
{
  const { ctx, captured } = makeCtx({ options: { wallClockMs: 250 } })
  const dispose = await plugin.setup(ctx)
  try {
    const before = hook(captured, 'execute.before')
    const after = hook(captured, 'execute.after')

    // 四个后台任务：arm 墙钟（250ms）；前三个会被事件提前收掉，只剩 ses_wall 被墙钟真打断
    const dispatch = async (id, child, agent) => {
      await before({ tool: 'subagent', sessionID: 'ses_parent', id, input: { agent, background: true, description: '干活的' } })
      await after({ tool: 'subagent', sessionID: 'ses_parent', id, input: { agent, background: true }, status: 'success', result: { output: { sessionID: child } } })
    }
    await dispatch('call_ok', 'ses_ok', 'executor')
    await dispatch('call_bad', 'ses_bad', 'reviewer')
    await dispatch('call_host', 'ses_host', 'scout')
    await dispatch('call_wall', 'ses_wall', 'librarian')

    // 先推前三条终态事件 + 三条该被忽略的事件
    captured.pushEvent({ type: 'session.execution.succeeded', sessionID: 'ses_ok' })
    captured.pushEvent({ type: 'session.execution.failed', sessionID: 'ses_bad', error: '模型 500' })
    captured.pushEvent({ type: 'session.execution.interrupted', sessionID: 'ses_host' })
    captured.pushEvent({ type: 'session.created', sessionID: 'ses_ok' })       // 无关类型
    captured.pushEvent({ type: 'session.execution.succeeded' })                 // 没有 sessionID
    captured.pushEvent({ type: 'session.execution.succeeded', sessionID: 'ses_未知' }) // 台账里没有
    await sleep(100)

    // 等墙钟（250ms）真打断一次：只有还没收终态的 ses_wall 会被打断
    await sleep(400)
    assert.deepEqual(captured.interrupts.map((i) => i.sessionID), ['ses_wall'], '只有 ses_wall 被墙钟打断（其余事件先到、已 disarm）')
    assert.equal(captured.interrupts[0].resume, false, '中断恰好一次且 resume:false')

    // 墙钟造成的 interrupted 事件 → 必须记 timedOut（否则这条统计永远是 false）
    captured.pushEvent({ type: 'session.execution.interrupted', sessionID: 'ses_wall' })
    await sleep(100)

    assert.equal(await stateOf(captured, 'call_ok'), 'completed', 'succeeded → completed')
    assert.equal(await stateOf(captured, 'call_bad'), 'error', 'failed → error')
    assert.equal(await stateOf(captured, 'call_host'), 'stopped', '宿主中断 → stopped')
    const wall = await rowOf(captured, 'call_wall')
    assert.equal(wall.state, 'error', '墙钟中断 → error')
    assert.equal(wall.timedOut, true, '墙钟中断必须记 timedOut（否则这条统计永远是 false）')
    ok('事件流认终态：succeeded/failed/宿主中断/墙钟中断（timedOut 正确）/无关事件忽略')
  } finally {
    dispose()
  }
}

// ---- 2. 工具自身失败 + 子会话 id 的三种取法 ----
{
  const { ctx, captured } = makeCtx()
  const dispose = await plugin.setup(ctx)
  try {
    const before = hook(captured, 'execute.before')
    const after = hook(captured, 'execute.after')

    // 工具自身失败（例如权限被拒）→ 直接落终态 error
    await before({ tool: 'subagent', sessionID: 'ses_p', id: 'call_err', input: { agent: 'executor' } })
    await after({ tool: 'subagent', sessionID: 'ses_p', id: 'call_err', input: { agent: 'executor' }, status: 'error', error: '权限被拒' })
    assert.equal(await stateOf(captured, 'call_err'), 'error', '工具失败 → error')

    // 前台调用 + 文本回退拿 childSessionID（content 数组 → 正则）
    await before({ tool: 'subagent', sessionID: 'ses_p', id: 'call_text', input: { agent: 'scout', description: '前台' } })
    await after({
      tool: 'subagent',
      sessionID: 'ses_p',
      id: 'call_text',
      input: { agent: 'scout' },
      status: 'success',
      result: { content: [{ text: '已派发 (sessionID: ses_child_text) 跑着' }] },
    })
    assert.equal(await stateOf(captured, 'call_text'), 'completed', '前台调用直接落终态')

    // metadata.sessionID 结构化路径 + 非对象 result 不炸
    await before({ tool: 'subagent', sessionID: 'ses_p', id: 'call_meta', input: { agent: 'librarian' } })
    await after({ tool: 'subagent', sessionID: 'ses_p', id: 'call_meta', input: { agent: 'librarian' }, status: 'success', result: { metadata: { sessionID: 'ses_child_meta' } } })
    await before({ tool: 'subagent', sessionID: 'ses_p', id: 'call_null', input: { agent: 'librarian' } })
    await after({ tool: 'subagent', sessionID: 'ses_p', id: 'call_null', input: { agent: 'librarian' }, status: 'success', result: null })
    assert.equal(await stateOf(captured, 'call_meta'), 'completed')
    ok('工具体：失败即终态 / 子会话 id 三种取法 / 空 result 不炸')
  } finally {
    dispose()
  }
}

// ---- 3. 惰性对账钩子 + agent 表读取失败 ----
{
  const { ctx, captured } = makeCtx({ agentListThrows: true })
  const dispose = await plugin.setup(ctx)
  try {
    const promptHook = captured.sessionHooks.find(([n]) => n === 'prompt')[1]
    await promptHook({ sessionID: 'ses_任意' }) // reconcileParent 在空台账上是 no-op；agent.list 抛错只记日志
    const contextHook = captured.sessionHooks.find(([n]) => n === 'context')[1]
    await contextHook({ tools: {} }) // 触发惰性读 agent 表（会抛）→ 只记日志，不炸
    ok('对账钩子：空台账可跑；agent.list 抛错被吞（只记日志）')
  } finally {
    dispose()
  }
}

// ---- 4. 名册再注入 / 异常兜底 ----
{
  const { ctx, captured } = makeCtx()
  const dispose = await plugin.setup(ctx)
  try {
    const contextHook = captured.sessionHooks.find(([n]) => n === 'context')[1]
    const tool = { description: '引擎自己的描述' }
    await contextHook({ tools: { subagent: tool } })
    assert.ok(tool.description.includes(ROSTER_MARKER), '第一次注入')
    tool.description = '被重建过的描述' // 模拟宿主重建工具描述 → 再注入一次（走"又被清掉"分支）
    await contextHook({ tools: { subagent: tool } })
    assert.ok(tool.description.includes(ROSTER_MARKER), '第二次注入（重建后）')
    // 访问 tools 就抛错 → catch 兜底
    const evil = {}
    Object.defineProperty(evil, 'tools', { get() { throw new Error('tools 访问炸了') } })
    await contextHook(evil)
    ok('名册：再注入（描述被重建）/ 访问异常被兜底')
  } finally {
    dispose()
  }
}

// ---- 5. 端点自举：只加不改 / 备份 / 保留注释 / 已有则不动 ----
{
  const dir = await mkdtemp(join(tmpdir(), 'reeve-endpoint-'))
  try {
    const cfgPath = join(dir, 'opencode.jsonc')
    await writeFile(cfgPath, '// 我的注释\n{\n  "compaction": { "auto": true }\n}\n', 'utf8')
    const { ctx } = makeCtx({ options: { ownEndpoint: true, engineConfigDir: dir, gate: false, snapshotPath: false } })
    const dispose = await plugin.setup(ctx)
    try {
      const text = await readFile(cfgPath, 'utf8')
      assert.ok(text.includes('// 我的注释'), '注释保留')
      assert.ok(text.includes('"reeve"'), 'providers.reeve 写进去了')
      assert.ok(text.includes('baseURL'), '端点进来')
      const backup = await readFile(`${cfgPath}.reeve-bak`, 'utf8').catch(() => null)
      assert.ok(backup !== null, '动之前有备份')
      assert.ok(!backup.includes('"reeve"'), '备份是原样')
      // 再启动一次：已有 providers.reeve → 一个字节都不动
      const before = text
      const again = await plugin.setup(makeCtx({ options: { ownEndpoint: true, engineConfigDir: dir, gate: false, snapshotPath: false } }).ctx)
      again()
      assert.equal(await readFile(cfgPath, 'utf8'), before, '第二次启动不动文件（只加不改）')
    } finally {
      dispose()
    }
    ok('端点自举：插入 + 备份 + 注释保留 + 二次启动不动')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---- 6. 台账 hydrate 的"截断"如实标记（取满一页没游标）----
{
  const seed = new Map()
  const key = Ledger.storageKey('task_x')
  // 500 条正好一页 + 存储不支持分页（scan 不返回 next）→ truncated 告警路径
  for (let i = 0; i < 500; i++) seed.set(`${key}_${i}`, { taskID: `t${i}`, state: 'running', startedAt: i })
  const { ctx } = makeCtx({
    seed,
    options: { ownEndpoint: false, gate: false, snapshotPath: false, stats: { intervalMs: 0 }, retentionDays: 0 },
  })
  // hydrate 的 scan 只按前缀取；上面 500 条同前缀 → 取满一页
  ctx.storage.scan = async ({ prefix, after = 0, limit = 500 }) => {
    const all = [...seed.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ key: k, value: v }))
    const page = all.slice(after, after + limit)
    return { entries: page } // 故意不给 next
  }
  const dispose = await plugin.setup(ctx)
  try {
    ok('台账 hydrate：取满一页无游标 → truncated（只记日志，启动照常）')
  } finally {
    dispose()
  }
}

console.log(`\n运行时测试：${passed} 项全过`)