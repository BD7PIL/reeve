// 链文件（~/.reeve/chain.json）↔ governance.routing_rules 的映射验证。
// 最关键的一条在 §7：**真实链基座**反推成档位、再派生回规则，必须逐字等价
// （否则每次热更都会把人工写的描述/TTFT 冲掉，或者规则永远"有差异"、收敛停不下来）。
//   node plugin/test/chain.mjs

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  TIER_ORDER, TIER_PRIORITY, DEFAULT_TTFT_MS, CHAIN_VERSION,
  defaultChainPath, tierRuleId, stripLineComments, parseChainText, parseTierRef, formatTierRef,
  normalizeTiers, tierToRule, tiersToRoutingRules, applyTiers, tiersFromRules, tiersFromChainDoc,
  canonicalJson, rulesSame, rulesDrift, readChainFile, buildChainDoc, resolveChain,
} from '../src/chain.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- 1. 注释与解析 ----
{
  const text = ['// 顶部注释', '{', '  // 档位在这', '  "version": 1,', '  "tiers": {}', '}'].join('\n')
  const doc = parseChainText(text)
  assert.equal(doc.version, 1)
  assert.ok(!stripLineComments(text).includes('//'))
  assert.equal(defaultChainPath({ home: '/home/x' }), join('/home/x', '.reeve', 'chain.json'))
  assert.equal(tierRuleId('pro'), 'reeve-pro')
  assert.equal(CHAIN_VERSION, 1)
  assert.deepEqual([...TIER_ORDER], ['flash', 'pro', 'multimodal'], '展示顺序 = 档位顺序')
  assert.deepEqual(TIER_PRIORITY, { flash: 10, pro: 20, multimodal: 30 })
  ok('注释行可跳过 · 路径/档位常量')
}

// ---- 2. "provider/model" 这一层的解析 ----
{
  assert.deepEqual(parseTierRef('zhipuai-coding-plan/glm-5.3'), { provider: 'zhipuai-coding-plan', model: 'glm-5.3' })
  assert.deepEqual(parseTierRef('lmuai/'), { provider: 'lmuai', model: null }, '同模型换 provider')
  assert.deepEqual(parseTierRef({ provider: 'xiaomi', model: 'mimo' }), { provider: 'xiaomi', model: 'mimo' }, '对象也认')
  assert.deepEqual(parseTierRef('deepseek-api/deepseek-v4.1-flash'), { provider: 'deepseek-api', model: 'deepseek-v4.1-flash' }, 'provider 里的连字符')
  assert.equal(parseTierRef('noprovider'), null, '没有斜杠 → 认不出')
  assert.equal(parseTierRef(''), null)
  assert.equal(parseTierRef(null), null)
  assert.equal(parseTierRef({ model: 'x' }), null, '对象缺 provider → 认不出')
  assert.equal(formatTierRef({ provider: 'a', model: 'b' }), 'a/b')
  assert.equal(formatTierRef({ provider: 'a', model: null }), 'a/')
  ok('parseTierRef / formatTierRef')
}

// ---- 3. normalizeTiers：人手写的、面板写的都过这一关 ----
{
  const { tiers, problems } = normalizeTiers({
    flash: { targets: [{ provider: 'opencode', model: 'mimo-free' }], fallbacks: ['lmuai/'], unknownKey: 1 },
    pro: { targets: ['zhipuai-coding-plan/glm-5.3'], fallbacks: ['deepseek-api/deepseek-flash'] },
    multimodal: { fallbacks: ['lmuai/glm-5.3-flash'] },
    bogus: { targets: ['x/y'] },
  })
  assert.deepEqual(Object.keys(tiers), ['flash', 'pro', 'multimodal'], '只认三个档位（bogus 丢掉）')
  assert.deepEqual(tiers.flash.targets, [{ provider: 'opencode', model: 'mimo-free' }])
  assert.deepEqual(tiers.flash.fallbacks, ['lmuai/'])
  assert.ok(!('unknownKey' in tiers.flash), '不认识的键不带下去')
  assert.deepEqual(tiers.pro.targets, [{ provider: 'zhipuai-coding-plan', model: 'glm-5.3' }], '字符串 target 也认')
  assert.deepEqual(tiers.multimodal.targets, [{ provider: 'lmuai', model: 'glm-5.3-flash' }], '只有 fallbacks → 第一个提为首选')
  assert.ok(problems.some((p) => p.includes('multimodal')), '提为首选这件事要如实报')
  assert.deepEqual(normalizeTiers(undefined).tiers, {}, '没有 tiers → 空（回落基座）')
  const bad = normalizeTiers({ flash: { targets: ['没有斜杠'], fallbacks: [] } })
  assert.deepEqual(Object.keys(bad.tiers), [], '认不出的 target 不进结果')
  assert.ok(bad.problems.length >= 1, '认不出要报')
  ok('normalizeTiers：规范化 + 如实报问题')
}

// ---- 4. tierToRule：id/CEL/priority/TTFT 的固定写法 ----
{
  const rule = tierToRule('flash', { targets: [{ provider: 'opencode', model: 'mimo-free' }], fallbacks: ['lmuai/glm'] })
  assert.equal(rule.id, 'reeve-flash')
  assert.equal(rule.name, 'reeve/flash')
  assert.equal(rule.cel_expression, 'model == "reeve/flash"')
  assert.equal(rule.priority, 10)
  assert.equal(rule.scope, 'global')
  assert.equal(rule.targets[0].weight, 1, '单 target weight=1')
  assert.equal(rule.targets[0].ttft_timeout_ms, DEFAULT_TTFT_MS, 'TTFT 挂在 target 上（实测如此）')
  assert.deepEqual(rule.fallbacks, ['lmuai/glm'])

  const multi = tierToRule('pro', {
    targets: [
      { provider: 'a', model: 'x' },
      { provider: 'b', model: 'y' },
      { provider: 'c', model: 'z' },
    ],
  })
  const sum = multi.targets.reduce((s, t) => s + t.weight, 0)
  assert.ok(Math.abs(sum - 1) < 1e-9, `多 target 的 weight 必须合计 1，实际 ${sum}`)

  // 基座里有同 id 的规则时：描述与 TTFT 从它继承（热更不冲掉人工写的说明）
  const base = { description: '人工写的说明', scope: 'global', targets: [{ ttft_timeout_ms: 12_000 }] }
  const inh = tierToRule('pro', { targets: [{ provider: 'a', model: 'x' }] }, { base })
  assert.equal(inh.description, '人工写的说明')
  assert.equal(inh.targets[0].ttft_timeout_ms, 12_000)
  ok('tierToRule：固定写法 + 多 target 均分 + 从基座继承描述/TTFT')
}

// ---- 5. applyTiers：只换 reeve-* 三条，别的照旧 ----
{
  const base = {
    '//note': 'x',
    providers: { a: { network_config: { base_url: 'https://a' } } },
    governance: { setup_token: 'env.X', routing_rules: [{ id: 'reeve-flash', priority: 10, name: 'reeve/flash' }, { id: 'custom-1', priority: 99 }] },
  }
  const out = applyTiers(base, { flash: { targets: [{ provider: 'a', model: 'm' }] } })
  assert.equal(out.providers, base.providers, 'providers 原样（对象同一引用）')
  assert.equal(out['//note'], 'x', '注释键还在（后面 buildProxyConfig 才去掉）')
  assert.equal(out.governance.setup_token, 'env.X')
  const ids = out.governance.routing_rules.map((r) => r.id).sort()
  assert.deepEqual(ids, ['custom-1', 'reeve-flash'], '非 reeve-* 的规则保留')
  const flash = out.governance.routing_rules.find((r) => r.id === 'reeve-flash')
  assert.equal(flash.targets[0].provider, 'a')
  assert.equal(flash.targets[0].ttft_timeout_ms, DEFAULT_TTFT_MS)
  assert.equal(base.governance.routing_rules[0].targets, undefined, '不改原对象（纯函数）')

  assert.equal(applyTiers(base, {}), base, '没有档位 → 原样返回（回落）')
  assert.deepEqual(applyTiers(null, {}), {}, '链为空也不炸')
  ok('applyTiers：只替换 reeve-* + 保留 providers/别的规则（纯函数）')
}

// ---- 6. 差异判定：键序无关，但真变了要看见 ----
{
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { y: 1, x: 2 }] } }), canonicalJson({ a: { c: [3, { x: 2, y: 1 }], d: 2 }, b: 1 }))
  const a = { name: 'reeve/pro', targets: [{ provider: 'a', model: 'x', weight: 1 }], fallbacks: ['b/y'] }
  const b = { fallbacks: ['b/y'], targets: [{ weight: 1, model: 'x', provider: 'a' }], name: 'reeve/pro' }
  assert.equal(rulesSame(a, b), true, '键序不同不算差异')
  assert.equal(rulesSame(a, { ...b, fallbacks: ['c/z'] }), false, '内容变了要看见')
  assert.equal(rulesSame(a, { ...b, config_hash: 'deadbeef' }), true, '服务端字段（config_hash）不算差异')

  const desired = [{ id: 'reeve-flash', name: 'reeve/flash' }, { id: 'reeve-pro', name: 'reeve/pro' }]
  const runtime = [{ id: 'reeve-flash', name: 'reeve/flash' }, { id: 'reeve-pro', name: '旧的' }, { id: 'leftover', name: 'x' }]
  const drift = rulesDrift(desired, runtime)
  assert.deepEqual(drift, { drifted: true, missing: [], changed: ['reeve-pro'], extra: ['leftover'] })
  assert.equal(rulesDrift(desired, desired).drifted, false, '一致 = 没有差异')
  assert.deepEqual(rulesDrift(desired, []).missing, ['reeve-flash', 'reeve-pro'])
  ok('canonicalJson / rulesSame / rulesDrift')
}

// ---- 7. 真实链基座：反推 → 再派生 = 逐字等价（防"热更把人工说明冲掉 / 永远有差异"） ----
{
  const bundled = JSON.parse(await readFile(new URL('../default-chain.json', import.meta.url), 'utf8'))
  const tiers = tiersFromChainDoc(bundled)
  assert.deepEqual(Object.keys(tiers), ['flash', 'pro', 'multimodal'], '三条规则都能反推成档位')
  assert.equal(tiers.flash.targets[0].provider, 'opencode')
  assert.equal(tiers.flash.fallbacks.length, 4, '回退链整条带上')
  assert.equal(tiers.pro.ttftMs, 30_000, 'TTFT 从基座继承')
  assert.ok(tiers.pro.description.includes('强推理'), '描述从基座继承')

  const rebuilt = applyTiers(bundled, tiers).governance.routing_rules
  const original = bundled.governance.routing_rules
  assert.equal(rebuilt.length, original.length)
  for (const rule of original) {
    const back = rebuilt.find((r) => r.id === rule.id)
    assert.ok(rulesSame(back, rule), `${rule.id} 派生结果必须与基座逐字等价：\n得到 ${JSON.stringify(back)}\n基座 ${JSON.stringify(rule)}`)
  }
  // panels 的起点：链文件缺失时，档位就取基座反推的这一份
  assert.deepEqual(Object.keys(tiersFromRules(original)), ['flash', 'pro', 'multimodal'])
  ok('真实链基座 round-trip：反推→派生逐字等价（描述/TTFT/回退都保住）')
}

// ---- 8. readChainFile：三种结果可区分；变更记号先 stat ----
{
  const missing = await readChainFile({ path: '/nope/chain.json', statImpl: async () => { throw new Error('ENOENT') } })
  assert.deepEqual({ exists: missing.exists, doc: missing.doc, tiers: missing.tiers, marker: missing.marker }, { exists: false, doc: null, tiers: null, marker: null })

  const bad = await readChainFile({
    path: '/x/chain.json',
    statImpl: async () => ({ mtimeMs: 111, size: 9 }),
    readFileImpl: async () => '{ 这不是 json',
  })
  assert.equal(bad.exists, true)
  assert.equal(bad.doc, null, '坏 JSON → doc 为 null（视为未变更，不炸）')
  assert.equal(bad.marker, '111:9')
  assert.ok(bad.error, '要如实报错')
  assert.equal(bad.tiers, null)

  const doc = { version: 1, updatedAt: 1, tiers: { pro: { targets: [{ provider: 'a', model: 'm' }], fallbacks: ['b/n'] } } }
  const good = await readChainFile({
    path: '/x/chain.json',
    statImpl: async () => ({ mtimeMs: 222, size: 100 }),
    readFileImpl: async () => JSON.stringify(doc),
  })
  assert.equal(good.exists, true)
  assert.equal(good.error, null)
  assert.deepEqual(Object.keys(good.tiers), ['pro'])
  assert.equal(good.marker, '222:100')
  assert.deepEqual(good.problems, [])

  // stat 与 read 之间被换掉（面板是 temp+rename 写）：记号取 stat 那次 → 偏旧 → 下个 tick 再收敛（幂等）
  let t = 1000
  const statImpl = async () => ({ mtimeMs: t, size: 10 })
  const first = await readChainFile({ path: '/x/chain.json', statImpl, readFileImpl: async () => JSON.stringify(doc) })
  t = 2000
  const second = await readChainFile({ path: '/x/chain.json', statImpl, readFileImpl: async () => JSON.stringify(doc) })
  assert.notEqual(first.marker, second.marker, 'mtime 变了 → 记号要变（守护据此触发收敛）')
  ok('readChainFile：不存在/坏/好三态 + mtime·size 记号')
}

// ---- 9. 面板要写的形状 ----
{
  const { tiers } = normalizeTiers({ pro: { targets: [{ provider: 'a', model: 'm' }], fallbacks: ['b/n'], ttftMs: 9000, description: 'd' } })
  const docOut = buildChainDoc(tiers, { now: 123 })
  assert.equal(docOut.version, CHAIN_VERSION)
  assert.equal(docOut.updatedAt, 123)
  assert.deepEqual(docOut.tiers.pro, { targets: [{ provider: 'a', model: 'm' }], fallbacks: ['b/n'], description: 'd', ttftMs: 9000 })
  assert.deepEqual(Object.keys(docOut.tiers), ['pro'], '只写有的档位')
  assert.deepEqual(buildChainDoc({}, {}).tiers, {})
  ok('buildChainDoc：面板写的形状（版本 + updatedAt + 三档）')
}

// ---- 10. resolveChain：链文件 + 基座 → 实际该用哪份（含"坏文件当作未变更"） ----
{
  const bundled = JSON.parse(await readFile(new URL('../default-chain.json', import.meta.url), 'utf8'))
  const from = '/repo/default-chain.json'
  const goodTiers = normalizeTiers({ pro: { targets: [{ provider: 'a', model: 'm' }], fallbacks: ['b/n'] } }).tiers
  const previous = { tiers: { flash: { targets: [{ provider: 'xiaomi', model: 'mimo' }], fallbacks: [] } }, source: '/home/x/.reeve/chain.json', derived: true }

  const noFile = resolveChain({ base: bundled, from, file: { exists: false, doc: null, tiers: null, problems: [] } })
  assert.equal(noFile.effective, bundled, '① 没有链文件 → 用基座')
  assert.equal(noFile.derived, false)
  assert.equal(noFile.stale, false)
  assert.equal(noFile.source, from)
  assert.deepEqual(Object.keys(noFile.tiers), ['flash', 'pro', 'multimodal'], '档位从基座反推（给面板一个起点）')

  const good = resolveChain({
    base: bundled, from, previous,
    file: { exists: true, path: '/home/x/.reeve/chain.json', doc: { tiers: goodTiers }, tiers: goodTiers, problems: [], error: null },
  })
  assert.equal(good.derived, true)
  assert.equal(good.stale, false)
  assert.equal(good.source, '/home/x/.reeve/chain.json')
  const ids = good.effective.governance.routing_rules.map((r) => r.id)
  assert.ok(ids.includes('reeve-pro') && ids.includes('reeve-flash'), '② 好文件 → 只替换 reeve-*（其余档位仍在）')
  assert.equal(good.effective.providers, bundled.providers, 'providers 来自基座')

  const broken = resolveChain({
    base: bundled, from, previous,
    file: { exists: true, path: '/home/x/.reeve/chain.json', doc: null, tiers: null, problems: [], error: 'Unexpected token {', marker: '1:2' },
  })
  assert.equal(broken.stale, true, '③ 坏 JSON → 当作未变更')
  assert.equal(broken.effective, null, 'effective=null 是"什么都别改"的信号（不是"用基座"）')
  assert.equal(broken.tiers, previous.tiers, '档位保持上一份好的')
  assert.equal(broken.source, previous.source)
  assert.equal(broken.error, 'Unexpected token {')

  const halfBad = resolveChain({
    base: bundled, from, previous,
    file: { exists: true, path: '/home/x/.reeve/chain.json', doc: { tiers: { pro: { targets: ['没有斜杠'] } } }, tiers: {}, problems: ['pro: 认不出的 target'], error: null },
  })
  assert.equal(halfBad.stale, true, '③ 声明了档位却一条都没活下来 → 也算坏')
  assert.deepEqual(halfBad.problems, ['pro: 认不出的 target'], '问题如实带上')

  const empty = resolveChain({ base: bundled, from, previous, file: { exists: true, path: '/p', doc: { tiers: {} }, tiers: {}, problems: [], error: null } })
  assert.equal(empty.effective, bundled, '④ 合法但没档位 → 回落基座（"恢复默认"的写法）')
  assert.equal(empty.stale, false)

  const staleNoPrev = resolveChain({ base: bundled, from, previous: null, file: { exists: true, path: '/p', doc: null, tiers: null, problems: [], error: 'bad' } })
  assert.equal(staleNoPrev.stale, true)
  assert.equal(staleNoPrev.source, from, '首次就是坏文件 → 没有上一份好的，来源退回基座')
  assert.deepEqual(Object.keys(staleNoPrev.tiers), ['flash', 'pro', 'multimodal'])
  ok('resolveChain：无文件/好文件/坏文件（留上一份）/空档位四种情形')
}

console.log(`\n链文件测试：${passed} 项全过`)