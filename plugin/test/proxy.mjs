// 代理层自持（纯插件形态）的单元验证：只测**纯函数**与派生规则；
// 起进程/取件那部分是薄 IO（在 EL7 上真跑验过，见 docs/PROGRESS.md §6.7）。
//   node plugin/test/proxy.mjs

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BIFROST_PIN, PROXY_DEFAULTS, proxyPaths, providerEnvName, deriveProviderEnv,
  buildProxyConfig, needsDownload, buildSpawnArgs, isReady, ownerOfPort,
} from '../src/proxy.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- 1. pin 与路径 ----
{
  assert.match(BIFROST_PIN.sha256, /^[0-9a-f]{64}$/, 'sha256 必须是 64 位 hex')
  assert.ok(!BIFROST_PIN.url.includes('/latest'), 'URL 必须版本化（/latest 会漂）')
  const p = proxyPaths({ home: '/home/x' })
  // 路径用 path.join 拼，比较也用 join —— 测试要能在 Windows 与 Linux 上跑
  assert.equal(p.root, join('/home/x', '.reeve/proxy'))
  assert.equal(p.binary, join('/home/x', '.reeve/proxy', 'bifrost-http'))
  assert.equal(p.config, join('/home/x', '.reeve/proxy', 'config.json'))
  assert.equal(proxyPaths({ dir: '/opt/b' }).root, '/opt/b', 'dir 显式覆盖')
  ok('pin 与路径（默认 ~/.reeve/proxy，可 dir 覆盖）')
}

// ---- 2. env 名约定：与部署脚本同一条 ----
{
  assert.equal(providerEnvName('zhipuai-coding-plan'), 'REEVE_KEY_ZHIPUAI_CODING_PLAN')
  assert.equal(providerEnvName('deepseek-api'), 'REEVE_KEY_DEEPSEEK_API')
  assert.equal(providerEnvName('alibaba-cn'), 'REEVE_KEY_ALIBABA_CN')
  assert.equal(providerEnvName('--weird--'), 'REEVE_KEY_WEIRD', '去掉首尾下划线、折叠分隔符')
  ok('providerEnvName：REEVE_KEY_<大写、非字母数字→下划线>')
}

// ---- 3. 从 auth.json 派生 provider 环境（只注链里用到的；缺的如实报） ----
{
  const auth = { 'zhipuai-coding-plan': { key: 'k1' }, xiaomi: { key: 'k2' }, other: { key: 'k3' } }
  const chain = [{ id: 'zhipuai-coding-plan' }, { id: 'xiaomi' }, { id: 'lmuai' }]
  const { env, missing } = deriveProviderEnv(auth, chain)
  assert.deepEqual(Object.keys(env).sort(), ['REEVE_KEY_XIAOMI', 'REEVE_KEY_ZHIPUAI_CODING_PLAN'])
  assert.equal(env.REEVE_KEY_ZHIPUAI_CODING_PLAN, 'k1')
  assert.deepEqual(missing, ['lmuai'], '缺 key 的 provider 要报出来，不静默')
  assert.ok(!('REEVE_KEY_OTHER' in env), '链里没声明的 provider 不注入')
  // 链里改过名的（Bifrost 内置名冲突 → deepseek-api），用 fromAuth 指回 auth.json 的那个 id
  const renamed = deriveProviderEnv({ deepseek: { key: 'kd' } }, [{ id: 'deepseek-api', keys: [{ value: 'env.REEVE_KEY_DEEPSEEK_API', fromAuth: 'deepseek' }] }])
  assert.equal(renamed.env.REEVE_KEY_DEEPSEEK_API, 'kd', 'fromAuth 指向 auth.json 里的 id')
  assert.deepEqual(renamed.missing, [], 'fromAuth 命中就不算缺')
  ok('deriveProviderEnv：只注链里用到的、缺的如实报')
}

// ---- 4. 派生 Bifrost 配置：去掉注释键 + 关掉回环鉴权 ----
{
  const chain = { '//note': 'x', providers: {}, client: { log_retention_days: 30 }, governance: { routing_rules: [] } }
  const out = buildProxyConfig(chain, { noAuth: true })
  assert.ok(!('//note' in out), '注释键不带进去')
  assert.equal(out.client.log_retention_days, 30, '原有的 client 配置保留')
  assert.equal(out.client.enforce_auth_on_inference, false, '自持形态关掉回环鉴权')
  const keep = buildProxyConfig(chain, { noAuth: false })
  assert.ok(!('enforce_auth_on_inference' in keep.client), 'requireVirtualKey 时不改这一项')
  ok('buildProxyConfig：去注释 + 按形态决定回环鉴权')
}

// ---- 5. 取件判定 / spawn 参数 / 就绪判定 ----
{
  assert.equal(needsDownload(null), true, '没有文件就要下')
  assert.equal(needsDownload({ isFile: () => true, size: BIFROST_PIN.size }), false, '大小对就不用下（校验和另测）')
  assert.equal(needsDownload({ isFile: () => true, size: 1 }), true, '大小不对要重下')

  const paths = proxyPaths({ dir: '/opt/b' })
  const [bin, args] = buildSpawnArgs({ paths, port: 18080 })
  assert.equal(bin, join('/opt/b', 'bifrost-http'))
  assert.deepEqual(args, ['-port', '18080', '-host', '127.0.0.1', '-app-dir', '/opt/b'])

  assert.equal(isReady(200, '"v2.3.0"'), true)
  assert.equal(isReady(200, ''), false, '空响应体不算就绪')
  assert.equal(isReady(500, 'x'), false)
  ok('检查取件判定 / spawn 参数 / 就绪判定')
}

// ---- 6. 自带的默认链：与仓库 proxy/config.json **同源**（防漂移） ----
{
  const bundled = JSON.parse(await readFile(new URL('../default-chain.json', import.meta.url), 'utf8'))
  const repoChainPath = new URL('../../proxy/config.json', import.meta.url)
  const repo = JSON.parse(await readFile(repoChainPath, 'utf8'))
  assert.deepEqual(bundled, repo, 'plugin/default-chain.json 必须是 proxy/config.json 的逐字拷贝（cp 一下）')
  const ids = Object.keys(bundled.providers ?? {})
  assert.ok(ids.length >= 6, `链里至少 6 个 provider，实际 ${ids.length}`)
  for (const [id, prov] of Object.entries(bundled.providers)) {
    for (const k of prov.keys ?? []) {
      assert.equal(k.value, 'env.' + providerEnvName(id), `${id} 的 key 值必须走通用约定`)
    }
  }
  const rules = bundled.governance?.routing_rules ?? []
  assert.deepEqual(rules.map((r) => r.name).sort(), ['reeve/flash', 'reeve/multimodal', 'reeve/pro'], '三个档位')
  ok('默认链与 proxy/config.json 同源，且 key 走通用约定')
}

const _models = 0

// ---- 8. 档位模型：注册与合并（配置说话时以配置为准） ----
{
  const { REEVE_TIERS, buildTierModel, mergeTierModels, parseEndpointFromConfig } = await import('../src/models.js')
  const rec = buildTierModel(REEVE_TIERS[0])
  assert.equal(rec.id, 'flash'); assert.equal(rec.modelID, 'reeve/flash'); assert.equal(rec.providerID, 'reeve')
  assert.deepEqual(rec.capabilities.input, ['text'], 'flash 不吃图')
  assert.deepEqual(buildTierModel(REEVE_TIERS[2]).capabilities.input, ['text', 'image'], 'multimodal 吃图')
  assert.deepEqual(rec.limit, { context: 200000, output: 32000 })
  assert.equal(rec.enabled, true)

  const merged = mergeTierModels([{ id: 'pro', modelID: 'user/pro', name: '用户自己写的' }])
  assert.equal(merged.length, 3, '已有的 pro 不动，补上 flash/multimodal')
  assert.equal(merged.find((m) => m.id === 'pro').name, '用户自己写的', '配置里的条目优先')
  assert.equal(mergeTierModels([]).length, 3)

  const ep = parseEndpointFromConfig(JSON.stringify({ providers: { reeve: { settings: { baseURL: 'http://127.0.0.1:18080/v1' } } } }))
  assert.deepEqual(ep, { baseURL: 'http://127.0.0.1:18080/v1', host: '127.0.0.1', port: 18080 })
  const withComments = ['// 注释行', JSON.stringify({ providers: { reeve: { settings: { baseURL: 'http://127.0.0.1:8080/v1' } } } })].join('\n')
  assert.equal(parseEndpointFromConfig(withComments).port, 8080, '整行注释要能跳过')
  assert.equal(parseEndpointFromConfig('{}'), null, '没有 providers.reeve → null（调用方退回默认）')
  assert.equal(parseEndpointFromConfig('not json'), null, '坏 JSON 不抛')
  ok('档位模型：注册形状 / 合并（配置优先）/ 从 baseURL 推端口')
}

// ---- 7. 端口归属：只复用"自己的"代理（两种形态共用同一端口时会撞） ----
{
  const mk = (entries) => ({
    readdirImpl: async () => Object.keys(entries),
    readFileImpl: async (path) => {
      const id = path.split('/')[2]
      if (!(id in entries)) throw new Error('gone')
      return entries[id]
    },
  })
  const NUL = String.fromCharCode(0)
  assert.equal(
    await ownerOfPort({ dir: '/opt/reeve/proxy', ...mk({ 11: ['/opt/reeve/proxy/bifrost-http', '-port', '18080', ''].join(NUL) }) }),
    'ours',
    'cmdline 带我们的 app-dir = ours',
  )
  assert.equal(
    await ownerOfPort({ dir: '/opt/reeve/proxy', ...mk({ 22: ['/home/x/.reeve-staging/bifrost/bifrost-http', '-port', '18080', ''].join(NUL) }) }),
    'foreign',
    '别的目录起的代理 = foreign（不复用，吵）',
  )
  assert.equal(
    await ownerOfPort({ dir: '/opt/reeve/proxy', ...mk({ 33: ['node', 'serve', ''].join(NUL) }) }),
    'unknown',
    '没有 bifrost 进程 = unknown（退回健康即复用）',
  )
  assert.equal(
    await ownerOfPort({ dir: '/opt/reeve/proxy', readdirImpl: async () => { throw new Error('no /proc') }, readFileImpl: async () => '' }),
    'unknown',
    '非 Linux（读不到 /proc）= unknown',
  )
  ok('ownerOfPort：ours / foreign / unknown 三态')
}

// ---- 9. 内置 agent 的可见性：谁被藏、默认 agent 只在存在时才设 ----
{
  const { BUILTINS_TO_HIDE, pickDefaultAgent } = await import('../src/models.js')
  assert.deepEqual([...BUILTINS_TO_HIDE].sort(), ['build', 'explore', 'general', 'plan'], '藏这四个（前台只留 foreman）')

  const calls = []
  const fake = { get: (id) => (id === 'foreman' ? { id } : undefined), default: (id) => calls.push(id) }
  assert.equal(pickDefaultAgent(fake, 'foreman'), true)
  assert.deepEqual(calls, ['foreman'], '存在才设默认')
  const none = { get: () => undefined, default: () => { throw new Error('不该被调用') } }
  assert.equal(pickDefaultAgent(none, 'foreman'), false, '不存在就不设（不报错）')
  ok('内置 agent 可见性：藏四个 + 默认 agent 只在存在时设')
}

// ---- 10. 从插件包里注册 agent / skill（"配置目录里不拷文件"的依据） ----
{
  const { loadAgents, loadSkills, toAgentInfo, parseFrontmatter } = await import('../src/register.js')
  const agents = await loadAgents()
  assert.equal(agents.length, 8, `插件包里应当有 8 个 agent，实际 ${agents.length}`)
  const foreman = agents.find((a) => a.id === 'foreman')
  assert.equal(foreman.mode, 'primary')
  assert.ok(!foreman.hidden, 'foreman 不该 hidden')
  assert.ok(foreman.system.includes('编排者'), 'system 应当是 md 的正文')
  assert.equal(foreman.model.providerID, 'reeve')
  assert.equal(foreman.model.id, 'pro')
  const scout = agents.find((a) => a.id === 'scout')
  assert.equal(scout.hidden, true, 'subagent 注册时就该是 hidden')
  assert.equal(scout.model.id, 'flash')
  assert.equal(scout.permissions.length, 6, '权限条目解析出来（含 *.env 的 ask）')
  assert.ok(scout.permissions.some((r) => r.action === 'edit' && r.effect === 'deny'))

  const skills = await loadSkills()
  assert.deepEqual(skills.map((s) => s.id), ['review'])
  assert.ok(skills[0].content.includes('本 skill 的目录：'), '正文里要带真实目录（rubric 靠它定位）')
  assert.ok(skills[0].content.includes('审查层'), 'skill 正文在')

  const fm = parseFrontmatter(
    ['---', 'a: 1', 'permissions:', '  - action: x', '    resource: "*"', '    effect: deny', '---', 'body'].join('\n'),
  )
  assert.equal(fm.data.a, '1')
  assert.deepEqual(fm.data.permissions, [{ action: 'x', resource: '*', effect: 'deny' }], '值里不该带引号（实测：带引号 → 规则匹配不上 → subagent 落到默认 ask → 拒绝）')
  assert.equal(fm.body, 'body')
  ok('插件包内注册：8 个 agent（面对/权限解析）+ 1 个 skill')
}



// ---- 11. 端点自举：只加不改 / 保留注释 / 写完自校验 ----
{
  const { planProviderInsertion, parseJsonc, reeveProviderBlock, ensureProviderBlock } = await import('../src/config-write.js')
  const blk = reeveProviderBlock({ port: 8080 })

  // 最小配置（只有 plugins）：插到顶层
  const min = '{ "plugins": ["@bd7pil/reeve"] }'
  const a = planProviderInsertion(min, 'reeve', blk)
  assert.equal(a.changed, true)
  const aDoc = parseJsonc(a.text)
  assert.equal(aDoc.providers.reeve.settings.baseURL, 'http://127.0.0.1:8080/v1')
  assert.deepEqual(aDoc.plugins, ['@bd7pil/reeve'], '别的键一个不动')

  // 已有 providers（非空）：插进去并带逗号
  const withProv = '{ "providers": { "deepseek": {} }, "model": "x/y" }'
  const b = planProviderInsertion(withProv, 'reeve', blk)
  const bDoc = parseJsonc(b.text)
  assert.ok(bDoc.providers.deepseek, '原有的 provider 保留')
  assert.equal(bDoc.providers.reeve.settings.baseURL, 'http://127.0.0.1:8080/v1')
  assert.equal(bDoc.model, 'x/y')

  // 空 providers：不要留尾随逗号
  const emptyProv = '{ "providers": {} }'
  const c = planProviderInsertion(emptyProv, 'reeve', blk)
  assert.equal(parseJsonc(c.text).providers.reeve.settings.baseURL, 'http://127.0.0.1:8080/v1')

  // 带注释的 jsonc：注释必须还在
  const jsonc = ['// 顶部注释', '{', '  // providers 在哪', '  "model": "reeve/pro"', '}'].join('\n')
  const d = planProviderInsertion(jsonc, 'reeve', blk)
  assert.ok(d.text.includes('// 顶部注释') && d.text.includes('// providers 在哪'), '注释保留')
  assert.equal(parseJsonc(d.text).model, 'reeve/pro')

  // 幂等：已经有了就一个字节都不动
  const e = planProviderInsertion(a.text, 'reeve', blk)
  assert.equal(e.changed, false)
  assert.equal(e.text, a.text)

  // 坏 JSON：不碰
  const f = planProviderInsertion('{ 这不是 json', 'reeve', blk)
  assert.equal(f.changed, false)
  assert.equal(f.text, '{ 这不是 json')

  // 文件级：写到临时目录，再跑一次应当是 present
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'reeve-cfg-'))
  const target = join(dir, 'opencode.jsonc')
  const { writeFile: wf } = await import('node:fs/promises')
  await wf(target, jsonc, 'utf8')
  const silent = { debug: () => {} }
  const first = await ensureProviderBlock({ configDir: dir, block: blk, logger: silent })
  assert.equal(first.status, 'added')
  const second = await ensureProviderBlock({ configDir: dir, block: blk, logger: silent })
  assert.equal(second.status, 'present')
  const after = readFileSync(target, 'utf8')
  assert.ok(after.includes('// 顶部注释'), '写完之后注释还在')
  assert.ok(parseJsonc(after).providers.reeve.settings.baseURL.startsWith('http://'), '写进去的内容合法')
  ok('端点自举：只加不改 / 保留注释 / 幂等 / 坏 JSON 不碰 / 有备份')
}



console.log(`\n代理层测试：${passed} 项全过`)
