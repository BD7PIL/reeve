// 插件入口装配层（src/index.js）的单元验证：**唯一没有测试的模块**。
//
// 为什么值得钉：这里的每一条都是"引擎里到底装上了什么"的契约 ——
// 工具注册进哪个命名空间、哪些 hook 挂上了、编排者是不是默认 agent。
// setup() 全是 IO 编排（起代理、写快照、读配置目录），测试用 disable 开关
// 把这些关掉（proxy:false / ownEndpoint:false / snapshotPath:null），
// 只留装配面。ctx 是捕获式 fake —— 注册了什么、hook 挂在哪，实测不符就红。
//   node plugin/test/entry.mjs

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import plugin from '../src/index.js'
import { ROSTER_MARKER } from '../src/roster.js'
import { TOOL_NAMESPACE } from '../src/constants.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

/** 捕获式 fake ctx：每个挂载点都记下"装了什么"。 */
function makeCtx({ storageSeed = new Map() } = {}) {
  const captured = {
    tools: [],           // ctx.tool.transform 里 editor.add 的工具
    toolHooks: [],       // ['execute.before', handler] 等
    sessionHooks: [],    // ['prompt'|'context', handler]
    eventsSubscribed: 0,
    agentEditorOps: [],  // ['hide:<id>' | 'add:<id>' | 'default:<id>']
    skillsAdded: [],
    providersTransformed: 0,
    interrupts: [],
  }
  const storage = {
    async get(key) { return storageSeed.get(key) ?? null },
    async set(key, value) { storageSeed.set(key, value) },
    async scan({ prefix }) {
      const entries = [...storageSeed.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value }))
      return { entries }
    },
  }
  const editor = () => ({
    add: (tool) => captured.tools.push(tool),
    get: () => undefined,
    update: (id, fn) => { captured.agentEditorOps.push(`update:${id}`); const a = {}; fn(a); return a },
    models: new Map(),
    agent: (id) => ({ id, hidden: false }),
  })
  const ctx = {
    options: {
      // 装配测试必须把重 IO 全关掉：代理取件、写引擎配置、写快照文件。
      // snapshotPath 要 false（''）而不是 null —— null 会被 `?? 默认路径` 接住。
      proxy: false,
      ownEndpoint: false,
      snapshotPath: false,
      stats: { intervalMs: 0 },
    },
    storage,
    location: { directory: null },
    tool: {
      transform: async (fn) => { fn(editor()) },
      hook: async (name, handler) => { captured.toolHooks.push([name, handler]) },
    },
    session: {
      hook: async (name, handler) => { captured.sessionHooks.push([name, handler]) },
      interrupt: async (args) => { captured.interrupts.push(args) },
    },
    event: {
      subscribe: () => {
        captured.eventsSubscribed += 1
        // 立刻结束的事件流（不产生任何事件）——setup 里的 async 消费器随即退出
        return (async function* () {})()
      },
    },
    provider: {
      transform: async (fn) => { captured.providersTransformed += 1; fn(editor()) },
    },
    agent: {
      transform: async (fn) => { fn({ get: () => undefined, update: (id, fn2) => { captured.agentEditorOps.push(`update:${id}`); fn2({}) } }) },
      list: async () => ({ data: [] }),
    },
    skill: {
      transform: async (fn) => { fn({ get: () => undefined, add: (s) => captured.skillsAdded.push(s.id) }) },
    },
  }
  return { ctx, captured }
}

// ---- 1. 默认导出的形状 ----
{
  assert.equal(typeof plugin.setup, 'function', 'setup 必须是函数')
  assert.equal(typeof plugin.id, 'string')
  assert.ok(plugin.id.length > 0, 'id 非空')
  ok(`默认导出 {id, setup} 形状（id=${plugin.id}）`)
}

// ---- 2. setup 装配面：工具 / hook / transform ----
{
  const home = await mkdtemp(join(tmpdir(), 'reeve-entry-'))
  const { ctx, captured } = makeCtx()
  try {
    const dispose = await plugin.setup(ctx)

    // 工具：task_status 注册进 reeve 命名空间 + codemode:false（暴露给模型）
    const status = captured.tools.find((t) => t.name === 'task_status')
    assert.ok(status, 'task_status 必须注册')
    assert.equal(status.options.namespace, TOOL_NAMESPACE)
    assert.equal(status.options.codemode, false, 'codemode:false 才是暴露给模型的开关')

    // 工具 hook：before（并发闸门）与 after（落地台账）都挂上
    const toolHookNames = captured.toolHooks.map(([n]) => n)
    assert.deepEqual(toolHookNames.sort(), ['execute.after', 'execute.before'])

    // session hook：prompt（惰性对账）与 context（补名册）
    const sessionHookNames = captured.sessionHooks.map(([n]) => n)
    assert.ok(sessionHookNames.includes('prompt'), 'prompt 钩子（对账）')
    assert.ok(sessionHookNames.includes('context'), 'context 钩子（补名册）')

    assert.equal(captured.eventsSubscribed, 1, '事件流订阅了一次')
    assert.equal(captured.providersTransformed, 1, 'provider.transform 注册档位模型')

    assert.equal(typeof dispose, 'function', 'setup 返回卸载函数')
    dispose()
    ok('装配面：task_status（namespace+codemode:false）/ 两个 tool hook / prompt+context / 事件流 / dispose')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

// ---- 3. context 钩子补名册：注入、幂等、非字符串描述不炸 ----
{
  const { ctx, captured } = makeCtx()
  const dispose = await plugin.setup(ctx)
  try {
    const contextHook = captured.sessionHooks.find(([n]) => n === 'context')[1]
    const tool = { description: '引擎自己的描述' }
    const event = { tools: { subagent: tool } }
    await contextHook(event)
    assert.ok(tool.description.includes(ROSTER_MARKER), '名册标记必须进 subagent 描述')
    const once = tool.description
    await contextHook(event)
    assert.equal(tool.description, once, '幂等：第二次不改动')

    // 没有 subagent 工具 / 描述不是字符串 —— 都不炸
    await contextHook({ tools: {} })
    const weird = { description: null }
    await contextHook({ tools: { subagent: weird } })
    assert.ok(weird.description.includes(ROSTER_MARKER), 'null 描述也能接（withRoster 容错）')
    ok('context 钩子：补名册 + 幂等 + 缺工具/异形描述不炸')
  } finally {
    dispose()
  }
}

// ---- 4. execute.after 落台账：前台 subagent 调用直接落终态 ----
{
  const seed = new Map()
  const { ctx, captured } = makeCtx({ storageSeed: seed })
  const dispose = await plugin.setup(ctx)
  try {
    const before = captured.toolHooks.find(([n]) => n === 'execute.before')[1]
    const after = captured.toolHooks.find(([n]) => n === 'execute.after')[1]

    // 非 subagent 工具：两个 hook 都应直接返回（不进台账）
    await before({ tool: 'read', sessionID: 'ses_parent', id: 'call_0', input: {} })
    await after({ tool: 'read', sessionID: 'ses_parent', id: 'call_0', input: {} })

    // subagent 前台调用：after 落一条 completed
    await before({ tool: 'subagent', sessionID: 'ses_parent', id: 'call_1', input: { agent: 'executor' } })
    await after({
      tool: 'subagent',
      sessionID: 'ses_parent',
      id: 'call_1',
      input: { agent: 'executor', description: '实现 A' },
      status: 'success',
      result: { output: { sessionID: 'ses_child_1' } },
    })

    // 台账写进 storage（storage.set 被调用即证）
    const keys = [...seed.keys()].filter((k) => k.includes('call_1'))
    assert.ok(keys.length > 0, '台账必须落 storage')
    const raw = seed.get(keys[0])
    const saved = typeof raw === 'string' ? JSON.parse(raw) : raw
    assert.equal(saved.state, 'completed', '前台调用直接落终态')
    assert.equal(saved.childSessionID, 'ses_child_1', '子会话 id 从结构化输出取出')
    assert.equal(saved.agent, 'executor')

    // task_status 工具能读回这条记录
    const status = captured.tools.find((t) => t.name === 'task_status')
    const reply = await status.execute({ includeTerminal: true })
    const parsed = JSON.parse(reply.output)
    assert.equal(parsed.count, 1)
    assert.equal(parsed.tasks[0].taskID, 'call_1')
    assert.equal(parsed.tasks[0].state, 'completed')
    ok('execute.before/after：非 subagent 不进账；前台 subagent 落终态；task_status 读回')
  } finally {
    dispose()
  }
}

console.log(`\n结果：${passed} 通过 / 0 失败`)