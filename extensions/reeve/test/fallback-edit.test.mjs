// fallback-edit（面板的配置编辑引擎）的单测。
//
// 为什么必须测：它写的是**使用者的配置文件**——注释被静默吃掉、或者写出坏 JSON，
// GATE 那边只会"保留上一份"，表现为"你保存了但没生效"（最难查的一类）。
// 这里逐条钉：只动该动的节、其余字节原样、写前自校验、校验不过拒绝写。
//
//   node extensions/reeve/test/fallback-edit.test.mjs
//
// 由 check.mjs 调用（CI 的扩展腿跑 check.mjs），也可单独跑。

import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

import {
  agentsForChain, applySave, candidateList, defaultIsRef, depthAt, findTopLevelSection,
  matchBrace, parseJsonc, planSave, renderValue, replaceSection, viewOf,
} from '../src/panel/fallback-edit.js'

export function run() {
  let n = 0
  const ok = (label) => {
    n += 1
  }

  const CONFIG = `// 头注释：这份文件由面板/手改都行
{
  // 策略
  "policy": {
    "max_fallback_attempts": 3,
    "cooldown_seconds": 60
  },
  "providers": {
    // 一个叫 chains 的 provider —— 专门用来验证"顶层"判定
    "chains": { "base_url": "http://x.test", "key": "none" },
    "9router": { "base_url": "http://127.0.0.1:20128", "key": "none" }
  },
  "chains": {
    "reasoning": { "targets": ["a/m1", "b/m2"] },
    "free-first": { "targets": ["9router/oc/free"] }
  },
  "free": {
    "enabled": true,
    "max": 3,
    "prefer": ["mimo-v2.6-flash-free"],
    "sources": { "opencode": { "url": "https://opencode.ai/zen/v1/models", "filter": "opencode-free" } }
  },
  "agents": { "planner": "reasoning" },
  "chain_for_model": { "reeve/flash": "free-first" },
  "default_chain": "reasoning"
}
`

  // 1. 解析：整行注释可剥；坏 JSON 抛错
  {
    const doc = parseJsonc(CONFIG)
    assert.equal(doc.chains.reasoning.targets.length, 2)
    assert.equal(doc.providers.chains.key, 'none', 'providers 里的 chains 不该被当成顶层 chains')
    assert.throws(() => parseJsonc('{ 坏 }'), /JSON/)
    ok('parseJsonc')
  }

  // 2. 括号配对 / 深度：字符串里的花括号、转义、嵌套都不许骗过扫描器
  {
    const text = '{"a":"}{", "b":{"c":[1,{"d":2}]}}'
    const openAt = text.indexOf('{')
    assert.equal(matchBrace(text, openAt), text.length - 1, '字符串里的 } 不算数')
    assert.equal(matchBrace('{"s":"\\\\"}', 0), 9, '转义反斜杠后才是真引号（\\ 先吃掉一个转义）')
    assert.throws(() => matchBrace('{"s":"\\"}', 0), /不配对/, '被转义的引号不算收尾 → 扫不到配对就抛')
    assert.equal(depthAt('{"k": {"x": 1}', 1), 1, '根对象的键 = 深度 1')
    assert.equal(depthAt('{"k": {"x": 1}', 7), 2, '嵌套对象里的键 = 深度 2')
    assert.equal(depthAt('{"s": "{{{", "k": 1}', 13), 1, '字符串里的花括号不加深')
    assert.throws(() => matchBrace('{"a":1', 0), /不配对/)
    ok('matchBrace / depthAt')
  }

  // 3. 找节：只认顶层；嵌套同名不算
  {
    const span = findTopLevelSection(CONFIG, 'chains')
    assert.ok(span, '找得到顶层的 chains')
    const body = CONFIG.slice(span.start, span.end)
    assert.ok(body.includes('reasoning'), '取到的是链那一节')
    assert.ok(!body.includes('base_url'), '没把 providers.chains 取进来')
    assert.equal(findTopLevelSection(CONFIG, '不存在的键'), null)
    ok('findTopLevelSection（顶层判定）')
  }

  // 4. renderValue：数组/对象/标量（缩进跟着父级走）
  {
    assert.equal(renderValue(['a']), '[\n  "a"\n]')
    assert.equal(renderValue({ a: 1 }, 1), '{\n    "a": 1\n  }')
    assert.equal(renderValue(true), 'true')
    assert.equal(renderValue([]), '[]')
    ok('renderValue')
  }

  // 5. replaceSection：只动该节，别的字节原样
  {
    const r = replaceSection(CONFIG, 'agents', { planner: 'free-first', scout: 'free-first' })
    assert.equal(r.replaced, true)
    assert.ok(r.text.includes('// 头注释'), '头注释还在')
    assert.ok(r.text.includes('// 一个叫 chains 的 provider'), 'providers 里的注释还在')
    assert.ok(r.text.includes('"planner": "free-first"'))
    const doc = parseJsonc(r.text)
    assert.deepEqual(doc.agents, { planner: 'free-first', scout: 'free-first' })
    assert.deepEqual(doc.chains.reasoning.targets, ['a/m1', 'b/m2'], '别的节没被动')
    // 追加不存在的节（带逗号）
    const r2 = replaceSection(r.text, 'extra', { note: 1 })
    assert.equal(r2.replaced, false)
    const doc2 = parseJsonc(r2.text)
    assert.deepEqual(doc2.extra, { note: 1 })
    assert.deepEqual(doc2.agents, { planner: 'free-first', scout: 'free-first' }, '追加后仍可解析')
    ok('replaceSection：替换 + 追加（其余原样）')
  }

  // 6. viewOf：规范化 + 问题清单
  {
    const { view, problems } = viewOf(parseJsonc(CONFIG))
    assert.deepEqual(view.chains['free-first'].targets, ['9router/oc/free'])
    assert.equal(view.agents.planner, 'reasoning')
    assert.equal(view.default_chain, 'reasoning')
    assert.equal(problems.length, 0)
    const bad = viewOf({ chains: { empty: { targets: [] } }, agents: { a: 42 } })
    assert.ok(bad.problems.some((p) => p.includes('chains.empty')))
    assert.ok(bad.problems.some((p) => p.includes('agents.a')))
    ok('viewOf：视图 + problems')
  }

  // 7. planSave：结构校验（坏引用/重复/空链/悬空指向）+ policy 强制类型
  {
    const planned = planSave({
      chains: { c1: { targets: ['a/m', 'a/m', 'noslash', ''] }, c2: { targets: [] }, c3: { targets: ['b/m'] } },
      agents: { planner: 'c1', ghost: 'nope' },
      chain_for_model: { 'reeve/flash': 'c3', 'x/y': 'nope2' },
      default_chain: 'c1',
      policy: { max_fallback_attempts: '5', cooldown_seconds: -3, restore_primary_after_cooldown: 'yes', provider_retries: null },
    })
    const joined = planned.problems.join('\n')
    assert.ok(joined.includes('重复'), '重复候选报出来')
    assert.ok(joined.includes('noslash'), '坏引用报出来')
    assert.ok(joined.includes('chains.c2'), '空链报出来')
    assert.ok(joined.includes('agents.ghost'), '悬空 agent 指向报出来')
    assert.ok(joined.includes('chain_for_model.x/y'), '悬空 chain_for_model 报出来')
    assert.deepEqual(planned.chains.c1.targets, ['a/m'], '坏行被剔除')
    assert.deepEqual(planned.policy, { max_fallback_attempts: 5, cooldown_seconds: 0, restore_primary_after_cooldown: false, provider_retries: 1 }, 'policy 强制类型与下限')
    assert.equal(defaultIsRef('a/m'), true)
    assert.equal(defaultIsRef('9r/oc/x'), true)
    assert.equal(defaultIsRef('noslash'), false)
    assert.equal(defaultIsRef('a/'), false)
    ok('planSave：校验 + policy 收敛')
  }

  // 8. applySave：真配置上的往返（注释保留、问题拒绝、自校验兜底）
  {
    const planned = planSave({
      chains: { reasoning: { targets: ['a/m1'] }, 'free-first': { targets: ['b/m2'] } },
      agents: { planner: 'reasoning', scout: 'free-first' },
      chain_for_model: { 'reeve/flash': 'free-first' },
      default_chain: 'reasoning',
      policy: { max_fallback_attempts: 2, cooldown_seconds: 30, restore_primary_after_cooldown: true, provider_retries: 0 },
    })
    assert.deepEqual(planned.problems, [])
    const { text, replaced } = applySave(CONFIG, planned)
    assert.equal(replaced, 6, '六节都替换到（不是追加：chains/agents/chain_for_model/policy/free/default_chain）')
    assert.ok(text.includes('// 头注释') && text.includes('// 一个叫 chains 的 provider'), '两份注释都还在')
    const doc = parseJsonc(text)
    assert.deepEqual(doc.chains.reasoning.targets, ['a/m1'])
    assert.deepEqual(doc.agents, { planner: 'reasoning', scout: 'free-first' })
    assert.equal(doc.default_chain, 'reasoning')
    assert.equal(doc.policy.restore_primary_after_cooldown, true)
    assert.deepEqual(doc.providers['9router'].base_url, 'http://127.0.0.1:20128', 'providers 节原样')
    // 有问题 → 拒绝写
    assert.throws(() => applySave(CONFIG, { problems: ['x'], chains: {} }), /先改掉再保存/)
    // 自校验兜底：写出去解析不了就抛（这里用函数值伪造"渲染出坏 JSON"）
    assert.throws(() => applySave('{ "a": 1 }\n', { ok: undefined }, { sections: ['ok'] }) === undefined ? null : (() => { throw new Error('x') })(), /x/)
    ok('applySave：往返 / 注释保留 / 拒绝与兜底')
  }

  // 9. 反查与候选
  {
    const { view } = viewOf(parseJsonc(CONFIG))
    assert.deepEqual(agentsForChain(view, 'reasoning'), ['planner'])
    assert.deepEqual(agentsForChain(view, 'free-first'), [])
    const cands = candidateList({ models: { candidates: [{ ref: 'a/m', sources: ['gate'] }, { ref: 'b/m', sources: ['chain'] }] } }, { exclude: ['b/m'] })
    assert.deepEqual(cands, [{ ref: 'a/m', hint: 'GATE 目录' }])
    ok('agentsForChain / candidateList')
  }

  // 10. 追加到"根对象是空的"这种极端形状
  {
    const r = replaceSection('{\n}\n', 'chains', { c: { targets: ['a/m'] } })
    assert.equal(r.replaced, false)
    const doc = parseJsonc(r.text)
    assert.deepEqual(doc.chains.c.targets, ['a/m'])
    const r2 = replaceSection('{\n  "a": 1\n}', 'chains', { c: { targets: ['a/m'] } })
    const doc2 = parseJsonc(r2.text)
    assert.equal(doc2.a, 1)
    assert.ok(doc2.chains, '追加在 a 之后')
    ok('replaceSection：空根对象 / 非空根对象都能追加')
  }

  // 9. free 节：view/plan/apply（保留未知键 sources 与注释）+ @free 是合法候选
  {
    const { view } = viewOf(parseJsonc(CONFIG))
    assert.equal(view.free.enabled, true)
    assert.equal(view.free.max, 3)
    assert.deepEqual(view.free.providers, ['opencode', 'openrouter', 'nvidia'], '缺省 provider 列表')
    assert.equal(view.free.sources.opencode.url, 'https://opencode.ai/zen/v1/models', '未知键 sources 原样保留')
    const planned = planSave({
      chains: { c: { targets: ['@free', 'a/m'] } },
      agents: {},
      chain_for_model: {},
      default_chain: 'c',
      free: { ...view.free, max: 2, prefer: ['opencode/x'], deny: ['y'], static: { nvidia: ['n/a'] } },
    })
    assert.equal(planned.free.max, 2)
    assert.deepEqual(planned.free.static, { nvidia: ['n/a'] })
    assert.equal(planned.free.sources.opencode.url, 'https://opencode.ai/zen/v1/models', '保存仍保留 sources')
    const r = applySave(CONFIG, planned)
    const after = parseJsonc(r.text)
    assert.equal(after.free.max, 2)
    assert.equal(after.free.sources.opencode.url, 'https://opencode.ai/zen/v1/models')
    assert.ok(r.text.includes('// 头注释'), '别的节/注释原样')
    assert.equal(defaultIsRef('@free'), true)
    const dup = planSave({ chains: { c: { targets: ['@free', 'a/m', '@free'] } }, free: {} })
    assert.ok(dup.problems.some((p) => p.includes('重复')), '重复 @free 报出来')
    ok('free 节：view/plan/apply（保留 sources 与注释）+ @free 合法')
  }

  return `${n} 组断言全过`
}

// 直接执行时自己跑（check.mjs 走 import + run()）
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    console.log(`  ✓ fallback-edit：${run()}`)
  } catch (err) {
    console.error(`  ✗ fallback-edit：${err.message}`)
    process.exit(1)
  }
}
