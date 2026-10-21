// 代理层自持（纯插件形态）的单元验证：纯函数、派生规则、平台 pin，ensureBinary
// 的判读分支（注入 fetchImpl + 临时目录，不打网络），以及 startOwnedProxy 的冒烟
// （注入 spawnImpl/fetchImpl：spawn 形态 / 复用 / 不支持平台降级不抛）。
// 真机起进程另各跑过一次（EL7 staging 与 Windows 原生，见 CHANGELOG 0.1.4）。
//   node plugin/test/proxy.mjs

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BIFROST_PIN, BIFROST_PINS, pinFor, PROXY_DEFAULTS, proxyPaths, providerEnvName, deriveProviderEnv,
  buildProxyConfig, needsDownload, buildSpawnArgs, isReady, ownerOfPort,
  ensureBinary, startOwnedProxy,
} from '../src/proxy.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// —— startOwnedProxy 冒烟用的公共夹具（全部注入了 IO，不打真网络） ——
const silentLogger = { debug: () => {} }
/** 等一个同步谓词成真（轮询；上限到了再判一次，答案仍是它的返回值）。 */
const until = async (fn, ms = 3000, step = 20) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, step))
  }
  return fn()
}
const stubBytes = Buffer.from('bifrost-stub-bin', 'utf8')
const stubPin = {
  version: 'test', url: 'https://invalid.test/bifrost-stub',
  sha256: createHash('sha256').update(stubBytes).digest('hex'), size: stubBytes.byteLength, binary: 'bifrost-stub-bin',
}
/** 预置正件 → ensureBinary 短路（取件不打网络）；目录与二进制都按 pin。 */
const seedProxyDir = async (prefix) => {
  const root = await mkdtemp(join(tmpdir(), prefix))
  await writeFile(join(root, stubPin.binary), stubBytes)
  return root
}
/** 冒烟默认选项：端口/目录/pin 显式，其余注入或给稳定值（跨腿一致）。 */
const smokeOpts = (root, port, extra = {}) => ({
  dir: root, port, pin: stubPin,
  authPath: join(root, 'no-auth.json'), chainPath: join(root, 'no-chain.jsonc'), chainFilePath: join(root, 'no-tiers.json'),
  readdirImpl: async () => { throw new Error('no /proc') }, // ownerOfPort → 'unknown'（跨腿稳定）
  readyTimeoutMs: 3000, superviseMs: 0, chainWatchMs: 0, ...extra,
})
const healthyFetch = async () => ({ status: 200, text: async () => '"v2.3.0"' })
/** 本地 stub 充当 Bifrost 的 /api/routing/rules（只打回环，无人真流量）。 */
const makeRulesStub = async (handler) => {
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const out = handler({ method: req.method, url: req.url, body }) ?? { status: 404 }
      res.writeHead(out.status, { 'content-type': 'application/json' })
      res.end(out.json === undefined ? '' : JSON.stringify(out.json))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(() => r())) }
}

// ---- 1. pin（按平台）与路径 ----
{
  for (const [key, pin] of Object.entries(BIFROST_PINS)) {
    assert.match(pin.sha256, /^[0-9a-f]{64}$/, `${key} 的 sha256 必须是 64 位 hex`)
    assert.ok(!pin.url.includes('/latest'), `${key} 的 URL 必须版本化（/latest 会漂）`)
    assert.ok(pin.size > 0, `${key} 要有 size`)
    assert.ok(pin.url.endsWith(`/${pin.binary}`), `${key} 的 URL 尾段要与 binary 名一致`)
  }
  assert.equal(pinFor('linux', 'x64'), BIFROST_PIN, 'linux-x64 → 兼容别名那一份')
  assert.match(pinFor('win32', 'x64').url, /\/windows\/amd64\/bifrost-http\.exe$/, 'windows 走 .exe')
  assert.equal(pinFor('win32', 'x64').binary, 'bifrost-http.exe')
  assert.equal(pinFor().binary, BIFROST_PINS[`${process.platform}-${process.arch}`].binary, '默认取当前平台')
  assert.throws(() => pinFor('darwin', 'arm64'), /没有 darwin-arm64 平台的 Bifrost pin/, '未知平台显式抛（宁可不装）')

  // 路径用 path.join 拼，比较也用 join —— 测试要能在 Windows 与 Linux 上跑
  const p = proxyPaths({ home: '/home/x', pin: BIFROST_PIN })
  assert.equal(p.root, join('/home/x', '.reeve/proxy'))
  assert.equal(p.binary, join('/home/x', '.reeve/proxy', 'bifrost-http'))
  assert.equal(p.config, join('/home/x', '.reeve/proxy', 'config.json'))
  assert.equal(proxyPaths({ dir: '/opt/b', pin: BIFROST_PIN }).root, '/opt/b', 'dir 显式覆盖')
  assert.equal(proxyPaths({ dir: '/opt/b', pin: BIFROST_PINS['win32-x64'] }).binary, join('/opt/b', 'bifrost-http.exe'), 'pin 决定二进制名')
  ok('pin：平台表 / pinFor 选择（未知平台显式抛）/ 路径（可 dir+pin 覆盖）')
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

// ---- 4b. ensureBinary：短路 / 重下 / 拒坏件（注入 fetchImpl，不打网络） ----
{
  const silent = { debug: () => {} }
  const good = Buffer.from('#!/bin/sh\necho bifrost-stub\n', 'utf8')
  const sha = (buf) => createHash('sha256').update(buf).digest('hex')
  const pin = { version: 'test', url: 'https://invalid.test/bifrost', sha256: sha(good), size: good.byteLength }

  const root = await mkdtemp(join(tmpdir(), 'reeve-bin-'))
  const paths = { root, binary: join(root, 'bifrost-http') }
  const noFetch = () => { throw new Error('这笔不该取件（短路失效）') }

  // (a) 已就位且校验和相符 → 'ok'，一次网络都不打
  await writeFile(paths.binary, good)
  assert.equal(await ensureBinary({ paths, pin, fetchImpl: noFetch, logger: silent }), 'ok', '命中短路')

  // (b) 内容被换掉（大小一致）→ 重下：fetch 返回正确字节，落 .part 后原子换名
  await writeFile(paths.binary, Buffer.alloc(good.byteLength, 0x20))
  let fetched = 0
  const fetchOk = async () => {
    fetched += 1
    return { ok: true, arrayBuffer: async () => good.buffer.slice(good.byteOffset, good.byteOffset + good.byteLength) }
  }
  assert.equal(await ensureBinary({ paths, pin, fetchImpl: fetchOk, logger: silent }), 'installed', '校验和不符重下')
  assert.equal(fetched, 1)
  assert.deepEqual(await readFile(paths.binary), good, '坏件被换成正件')
  assert.ok(!existsSync(`${paths.binary}.part`), '.part 不残留')

  // (c) 取件回来校验和不符 → 抛错且不落盘（宁可不装也不装错的）
  await rm(paths.binary, { force: true })
  const bad = Buffer.from('not-the-binary')
  const fetchBad = async () => ({ ok: true, arrayBuffer: async () => bad.buffer.slice(bad.byteOffset, bad.byteOffset + bad.byteLength) })
  await assert.rejects(() => ensureBinary({ paths, pin, fetchImpl: fetchBad, logger: silent }), /sha256 不符/)
  assert.ok(!existsSync(paths.binary), '坏件不落盘')

  // (d) HTTP 非 2xx → 明确报取件失败
  const fetch502 = async () => ({ ok: false, status: 502 })
  await assert.rejects(() => ensureBinary({ paths, pin, fetchImpl: fetch502, logger: silent }), /HTTP 502/)
  await rm(root, { recursive: true, force: true })

  // (e) pin 决定落点文件名：windows 形态的 pin → bifrost-http.exe（取件/短路两分支同样走通）
  const winPin = { version: 'test-win', url: 'https://invalid.test/bifrost-http.exe', sha256: sha(good), size: good.byteLength, binary: 'bifrost-http.exe' }
  const rootW = await mkdtemp(join(tmpdir(), 'reeve-bin-win-'))
  const pathsW = proxyPaths({ dir: rootW, pin: winPin })
  assert.equal(pathsW.binary, join(rootW, 'bifrost-http.exe'), 'pin.binary 决定文件名')
  assert.equal(await ensureBinary({ paths: pathsW, pin: winPin, fetchImpl: fetchOk, logger: silent }), 'installed', 'win 形态首次取件')
  assert.equal(await ensureBinary({ paths: pathsW, pin: winPin, fetchImpl: noFetch, logger: silent }), 'ok', 'win 形态命中短路（一次网络都不打）')
  await rm(rootW, { recursive: true, force: true })
  ok('ensureBinary：命中短路 / 校验和不符重下（.part 原子换名）/ 坏件与 HTTP 错误都拒 / pin 决定文件名')
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
  assert.equal(needsDownload(null, BIFROST_PIN), true, '没有文件就要下')
  assert.equal(needsDownload({ isFile: () => true, size: BIFROST_PIN.size }, BIFROST_PIN), false, '大小对就不用下（校验和另测）')
  assert.equal(needsDownload({ isFile: () => true, size: 1 }, BIFROST_PIN), true, '大小不对要重下')
  assert.equal(needsDownload({ isFile: () => true, size: pinFor().size }), false, '默认 pin = 当前平台（CI 两条腿各自自洽）')

  const paths = proxyPaths({ dir: '/opt/b', pin: BIFROST_PIN })
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



// ---- 12. 防漂移：provision.json 的 bifrost 工件 == linux pin（装配器读的就是它） ----
{
  const prov = JSON.parse(await readFile(new URL('../provision.json', import.meta.url), 'utf8'))
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const art = (prov.artifacts ?? []).find((a) => a.id === 'bifrost')
  assert.ok(art, 'provision.json 里要有 bifrost 工件')
  assert.equal(art.version, BIFROST_PIN.version)
  assert.equal(art.url, BIFROST_PIN.url)
  assert.equal(art.sha256, BIFROST_PIN.sha256)
  assert.equal(art.size, BIFROST_PIN.size)
  assert.equal(art.dest, `~/.reeve/proxy/${BIFROST_PIN.binary}`)
  assert.equal(art.mode, '0755')
  // ocrc 的取件/推送对 artifacts **无平台过滤** —— provision.json 加 windows 条目会把 123MB exe
  // 推给 linux 对端，所以这里保持 linux-only（windows 由插件自持按平台 pin 取件）。
  assert.deepEqual(prov.host.os, ['linux'])
  assert.deepEqual(prov.host.arch, ['x64'])
  // 版本双写：改了 package.json 忘改 provision.json 会让装配器装到旧 spec
  assert.equal(prov.version, pkg.version, 'provision.json version 与 package.json 同步')
  assert.equal(prov.enginePlugin.spec, `@bd7pil/reeve@${pkg.version}`, 'enginePlugin.spec 与 package.json 同步')
  const { PLUGIN_VERSION } = await import('../src/constants.js')
  assert.equal(PLUGIN_VERSION, pkg.version, 'constants.js 的 PLUGIN_VERSION 与 package.json 同步（快照带版本，面板据此判读）')
  ok('防漂移：provision.json 的 bifrost 工件 == linux pin + 版本三处同步')
}

// ---- 13. startOwnedProxy 冒烟：spawn 形态（pin 线程化）/ 复用 / 不支持平台降级 ----
{
  const silent = { debug: () => {} }
  const good = Buffer.from('bifrost-stub-bin', 'utf8')
  const pin = {
    version: 'test', url: 'https://invalid.test/bifrost-stub',
    sha256: createHash('sha256').update(good).digest('hex'), size: good.byteLength, binary: 'bifrost-stub-bin',
  }
  const root = await mkdtemp(join(tmpdir(), 'reeve-start-'))
  await writeFile(join(root, pin.binary), good) // 预置正件 → ensureBinary 短路，取件不打网络
  const opts = {
    dir: root, port: 18999, pin,
    chainPath: join(root, 'no-such-chain.jsonc'), chainFilePath: join(root, 'no-such-tiers.json'), authPath: join(root, 'no-auth.json'),
    readdirImpl: async () => { throw new Error('no /proc') }, // ownerOfPort → 'unknown'（跨腿稳定）
    readyTimeoutMs: 3000, superviseMs: 0, chainWatchMs: 0,
  }

  // (a) 拉起路径：首次探活失败（逼它 spawn）→ 之后健康 → ready（+ 派生配置/令牌都落盘）
  const spawned = []
  const spawnImpl = (bin, args, spawnOpts) => { spawned.push({ bin, args, cwd: spawnOpts?.cwd }); return { pid: 4242, unref: () => {} } }
  let calls = 0
  const fetchImpl = async () => { calls += 1; if (calls === 1) throw new Error('ECONNREFUSED'); return { status: 200, text: async () => '"v2.3.0"' } }
  const r = await startOwnedProxy({ opts, logger: silent, fetchImpl, spawnImpl })
  assert.equal(r.ready, true, `应当就绪（detail=${r.detail}）`)
  assert.equal(spawned.length, 1, '恰好拉起一次')
  assert.equal(spawned[0].bin, join(root, 'bifrost-stub-bin'), 'pin 线程化到 spawn（二进制名按 pin）')
  assert.deepEqual(spawned[0].args, ['-port', '18999', '-host', '127.0.0.1', '-app-dir', root])
  assert.equal(spawned[0].cwd, root)
  assert.ok(existsSync(join(root, 'setup-token')), 'setup token 已生成')
  const written = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
  assert.equal(written.client.enforce_auth_on_inference, false, '自持形态关掉回环鉴权（派生配置落盘）')
  assert.match(r.detail, /代理已拉起/)
  await r.dispose()

  // (b) 复用路径：已经健康 → 不再拉起
  const spawned2 = []
  const r2 = await startOwnedProxy({
    opts, logger: silent,
    fetchImpl: async () => ({ status: 200, text: async () => '"v2.3.0"' }),
    spawnImpl: (bin) => { spawned2.push(bin); return { pid: 1, unref: () => {} } },
  })
  assert.equal(r2.ready, true)
  assert.equal(spawned2.length, 0, '已有健康代理 → 不重复拉起')
  assert.match(r2.detail, /复用已在跑的代理/)
  await r2.dispose()

  // (c) 不支持的平台：降级返回（不抛 —— 代理层不可用不该把插件加载一起搞崩）
  const desc = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'sunos' })
  try {
    const r3 = await startOwnedProxy({ opts: { dir: root }, logger: silent, fetchImpl, spawnImpl })
    assert.equal(r3.ready, false)
    assert.equal(r3.paths, null)
    assert.match(r3.detail, /代理自持不可用/)
  } finally {
    Object.defineProperty(process, 'platform', desc)
  }

  await rm(root, { recursive: true, force: true })
  ok('startOwnedProxy 冒烟：spawn 形态（pin → 二进制名/参数/派生配置）/ 复用不重启 / 不支持平台降级不抛')
}

// ---- 14. 纯函数补角：空链 / 缺 id / 非 env.* 值 / 坏 pid 目录项 ----
{
  assert.deepEqual(deriveProviderEnv({ a: { key: 'k' } }, null), { env: {}, missing: [] }, '链为 null 不炸')
  assert.deepEqual(
    deriveProviderEnv({}, [{}, { id: 'xiaomi', keys: [{ value: 'literal-not-env' }] }]).missing,
    ['xiaomi'],
    '缺 id 的条目跳过；key 值不是 env.* 时回落约定名',
  )
  assert.equal(buildProxyConfig(null).client.enforce_auth_on_inference, false, '链为 null → 空对象 + 照常关鉴权')
  assert.equal(buildProxyConfig({}).client.enforce_auth_on_inference, false, '没有 client 段 → 新建')
  assert.equal(
    await ownerOfPort({ dir: '/opt/x', readdirImpl: async () => ['self', 'not-a-pid'], readFileImpl: async () => { throw new Error('非数字项不该被读') } }),
    'unknown',
    '/proc 里的非数字项要跳过',
  )
  assert.equal(
    await ownerOfPort({ dir: '/opt/x', readdirImpl: async () => ['7'], readFileImpl: async () => { throw new Error('gone') } }),
    'unknown',
    '读 /proc/7 的这一刻它就没了 → 跳过（不炸）',
  )
  ok('纯函数补角：空链 / 缺 id / 非 env.* / 坏 pid 目录项')
}

// ---- 15. startOwnedProxy：后台首次取件 → 装好后拉起（不挡引擎启动） ----
{
  const root = await mkdtemp(join(tmpdir(), 'reeve-start-dl-')) // 故意不预置二进制
  const spawned = []
  let downloads = 0
  const fetchImpl = async (url) => {
    if (String(url).includes('bifrost-stub')) {
      downloads += 1
      return { ok: true, status: 200, arrayBuffer: async () => stubBytes.buffer.slice(stubBytes.byteOffset, stubBytes.byteOffset + stubBytes.byteLength) }
    }
    if (spawned.length === 0) throw new Error('ECONNREFUSED') // 还没拉起 → 不健康，逼它 spawn
    return healthyFetch()
  }
  // 不给 pid 的 child：顺带覆盖 `child.pid ?? '?'` 的兜底；也不给 onState（覆盖可选回调的空值臂）
  const r = await startOwnedProxy({ opts: smokeOpts(root, 19001), logger: silentLogger, fetchImpl, spawnImpl: (bin) => { spawned.push(bin); return { unref: () => {} } } })
  assert.match(r.detail, /首次取件中/, '取件在后台，不挡引擎启动')
  assert.ok(await until(() => r.ready === true, 5000), `后台取件后应就绪（detail=${r.detail}）`)
  assert.equal(downloads, 1, '取件只发生一次（幂等）')
  assert.equal(spawned.length, 1, '装好后拉起一次')
  assert.match(r.detail, /二进制是本次装好的/)
  await r.dispose()
  await rm(root, { recursive: true, force: true })
  ok('startOwnedProxy：后台取件（不挡启动）→ 装好即拉起 / 取件幂等 / pid 缺省不炸')
}

// ---- 16. startOwnedProxy：平台默认值全走一遍（只给 dir/port/pin，其余默认） ----
{
  const root = await seedProxyDir('reeve-start-dflt-')
  const got = []
  const stub = await makeRulesStub(({ method }) => {
    got.push(method)
    return method === 'GET' ? { status: 200, json: { count: 0, rules: [] } } : { status: 200, json: {} }
  })
  const r = await startOwnedProxy({
    opts: { dir: root, port: stub.port, pin: stubPin }, // 其余全默认：readdirImpl/readyTimeoutMs/superviseMs/chainWatchMs/authPath/chainPath/chainFilePath
    logger: silentLogger,
    fetchImpl: healthyFetch,
    spawnImpl: () => { throw new Error('已健康，不该拉起') },
    onState: () => { throw new Error('视图炸了不该影响记账') }, // 覆盖 publish 的 catch
  })
  assert.equal(r.ready, true, `默认值下应当就绪（detail=${r.detail}）`)
  assert.ok(r.chain.appliedAt, '收敛过运行时（appliedAt 是复核之后才写的）')
  assert.equal(r.chain.drift?.drifted, true, 'stub 没接住 → drift 如实报（面板据此显示"还差几条"）')
  assert.deepEqual([...new Set(got)].sort(), ['GET', 'POST'], '收敛动作：先读运行时、再 POST 缺失的规则')
  await r.dispose() // 默认 timer 由 dispose 清掉（不许挂住进程）
  await stub.close()
  await rm(root, { recursive: true, force: true })
  ok('startOwnedProxy 默认值：就绪 / 收敛（POST + 复核 drift）/ 视图回调炸了不影响记账 / dispose 收尾')
}

// ---- 17. 链文件热更：好文件派生 → 坏文件"当作未变更" → 再变好即收敛 ----
{
  const root = await seedProxyDir('reeve-hotchain-')
  const chainFile = join(root, 'chain.json')
  await writeFile(
    chainFile,
    JSON.stringify({ version: 1, updatedAt: 1, tiers: { pro: { targets: [{ provider: 'xiaomi', model: 'mimo-7b' }] }, flash: { targets: ['nonsense-no-slash'] } } }),
    'utf8',
  )
  const stub = await makeRulesStub(({ method }) => (method === 'GET' ? { status: 200, json: { count: 0, rules: [] } } : { status: 200, json: {} }))
  const r = await startOwnedProxy({
    // chainFilePath 显式 undefined → 走 `opts.chainFilePath ?? opts.tiersPath` 的右臂（按 tiersPath 找链文件）
    opts: smokeOpts(root, stub.port, { chainWatchMs: 40, chainFilePath: undefined, tiersPath: chainFile }),
    logger: silentLogger, fetchImpl: healthyFetch, spawnImpl: () => { throw new Error('不应拉起') },
  })
  assert.equal(r.chain.derived, true, '链文件派生（只换 reeve-* 三条）')
  assert.equal(r.chain.source, chainFile)
  assert.ok(r.chain.problems.length > 0, '认不出的 target 如实报，不静默')
  const good = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))

  await writeFile(chainFile, `{ 这不是 json ${' '.repeat(40)}`, 'utf8') // 坏文件（大小/记号不同）
  assert.ok(await until(() => r.chain.error != null), '坏文件要能看见 error')
  assert.ok(r.chain.changedAt, '坏文件也算一次变更（面板要知道刚刚发生了什么）')
  assert.deepEqual(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')), good, '坏文件不覆盖上一份好的（当作未变更）')

  await writeFile(chainFile, JSON.stringify({ version: 1, updatedAt: 2, tiers: { multimodal: { targets: [{ provider: 'xiaomi', model: 'mimo-mm' }] } } }), 'utf8')
  assert.ok(await until(() => r.chain.derived === true && r.chain.error === null && r.chain.appliedAt != null), '改好即热更并对齐运行时')
  const after = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
  assert.ok(after.governance.routing_rules.some((x) => x.id === 'reeve-multimodal' && x.targets[0].model === 'mimo-mm'), '新档位已写回自持 config')
  await r.dispose()
  await stub.close()
  await rm(root, { recursive: true, force: true })
  ok('链热更：派生（含 problems 如实报）/ 坏文件当作未变更 / 再变好即写回+对齐')
}

// ---- 18. 链配置的三种退化：坏文件启动 / 全读不到 / 最小链（无 governance） ----
{
  // (a) 坏链文件启动 → 回落链基座（不拿 null 当基座）
  const rootA = await seedProxyDir('reeve-chain-broken-')
  const badFile = join(rootA, 'chain.json')
  await writeFile(badFile, '{ 坏 json', 'utf8')
  const stubA = await makeRulesStub(({ method }) => (method === 'GET' ? { status: 200, json: { count: 0, rules: [] } } : { status: 200, json: {} }))
  const rA = await startOwnedProxy({ opts: smokeOpts(rootA, stubA.port, { chainFilePath: badFile }), logger: silentLogger, fetchImpl: healthyFetch, spawnImpl: () => { throw new Error('不应拉起') } })
  assert.equal(rA.ready, true)
  assert.ok(rA.chain.error, '坏文件启动：如实报 error')
  const writtenA = JSON.parse(await readFile(join(rootA, 'config.json'), 'utf8'))
  assert.equal(writtenA.governance.routing_rules.length, 3, '回落到链基座的三条档位')
  await rA.dispose()
  await stubA.close()
  await rm(rootA, { recursive: true, force: true })

  // (b) 链基座与链文件都读不到 → 失败吵（不静默半启动）
  const rootB = await seedProxyDir('reeve-chain-none-')
  const rB = await startOwnedProxy({
    opts: smokeOpts(rootB, 19004, { chainPath: join(rootB, 'nope.jsonc') }),
    bundledChainPath: null,
    logger: silentLogger, fetchImpl: healthyFetch, spawnImpl: () => { throw new Error('不该到拉起') },
  })
  assert.equal(rB.ready, false)
  assert.match(rB.detail, /找不到链配置/)
  await rm(rootB, { recursive: true, force: true })

  // (c) 最小链（`{}`）：没有 providers/governance 也不编造
  const rootC = await seedProxyDir('reeve-chain-min-')
  const minChain = join(rootC, 'min-chain.json')
  await writeFile(minChain, '{}', 'utf8')
  const stubC = await makeRulesStub(({ method }) => (method === 'GET' ? { status: 200, json: { count: 0, rules: [] } } : { status: 200, json: {} }))
  const rC = await startOwnedProxy({ opts: smokeOpts(rootC, stubC.port, { chainPath: minChain }), logger: silentLogger, fetchImpl: healthyFetch, spawnImpl: () => { throw new Error('不应拉起') } })
  assert.equal(rC.ready, true)
  const writtenC = JSON.parse(await readFile(join(rootC, 'config.json'), 'utf8'))
  assert.ok(!('governance' in writtenC), '没有 governance → 不编造规则')
  assert.equal(writtenC.client.enforce_auth_on_inference, false)
  await rC.dispose()
  await stubC.close()
  await rm(rootC, { recursive: true, force: true })
  ok('链配置退化：坏文件启动回落基座 / 全读不到则吵 / 最小链不编造规则')
}

// ---- 19. 收敛的三条非平凡路径：已有规则的改（PUT）/ 多余的删（DELETE）/ 复核读不到 ----
{
  const seen = []
  const root = await seedProxyDir('reeve-converge-')
  const craft = (id, name) => ({ id, name, enabled: true, cel_expression: `model == "reeve/${id.slice(6)}"`, targets: [{ provider: 'a', model: 'b' }], fallbacks: [], priority: 10, scope: 'global' })
  const stub = await makeRulesStub(({ method, url }) => {
    seen.push(`${method} ${url}`)
    if (method === 'GET') return { status: 200, json: { count: 2, rules: [craft('reeve-flash', '名字对不上'), craft('ghost-rule', '多余的')] } }
    return { status: 200, json: {} }
  })
  const r = await startOwnedProxy({ opts: smokeOpts(root, stub.port), logger: silentLogger, fetchImpl: healthyFetch, spawnImpl: () => { throw new Error('不应拉起') } })
  assert.ok(r.ready)
  assert.ok(seen.some((s) => s.includes('PUT') && s.includes('reeve-flash')), '同 id 但内容不同 → PUT')
  assert.ok(seen.some((s) => s.includes('DELETE') && s.includes('ghost-rule')), '运行时多出来的 → DELETE')
  assert.equal(seen.filter((s) => s.startsWith('POST')).length, 2, '缺的两条（pro/multimodal）→ POST')
  await r.dispose()
  await stub.close()
  await rm(root, { recursive: true, force: true })

  // 复核读不到（GET 第二次 500）→ drift 为 null（不是"无差异"，是"不知道"）
  let gets = 0
  const root2 = await seedProxyDir('reeve-converge-500-')
  const stub2 = await makeRulesStub(({ method }) => {
    if (method !== 'GET') return { status: 200, json: {} }
    gets += 1
    return gets === 1 ? { status: 200, json: { count: 0, rules: [] } } : { status: 500 }
  })
  const r2 = await startOwnedProxy({ opts: smokeOpts(root2, stub2.port), logger: silentLogger, fetchImpl: healthyFetch, spawnImpl: () => { throw new Error('不应拉起') } })
  assert.ok(r2.ready)
  assert.equal(r2.chain.drift, null, '复核读不到 → null（不是"已收敛"）')
  await r2.dispose()
  await stub2.close()
  await rm(root2, { recursive: true, force: true })

  // 一开始就读不到（GET 404）→ 明确报"读不到运行时规则"，不假装收敛
  const root3 = await seedProxyDir('reeve-converge-404-')
  const stub3 = await makeRulesStub(() => ({ status: 404 }))
  const r3 = await startOwnedProxy({ opts: smokeOpts(root3, stub3.port), logger: silentLogger, fetchImpl: healthyFetch, spawnImpl: () => { throw new Error('不应拉起') } })
  assert.ok(r3.ready)
  assert.match(String(r3.chain.lastError), /读不到运行时规则/)
  await r3.dispose()
  await stub3.close()
  await rm(root3, { recursive: true, force: true })
  ok('收敛：PUT 改 / DELETE 删 / 复核读不到报 null / 起手读不到则如实报')
}

// ---- 20. 守护自愈：首次取件失败 → 巡检重试 → 就绪 ----
{
  const root = await mkdtemp(join(tmpdir(), 'reeve-selfheal-'))
  const logs = []
  const logger = { debug: (m) => logs.push(String(m)) }
  let downloads = 0
  let healthCalls = 0
  const spawned = []
  const fetchImpl = async (url) => {
    if (String(url).includes('bifrost-stub')) {
      downloads += 1
      if (downloads === 1) return { ok: false, status: 502 } // 第一次取件就坏
      return { ok: true, status: 200, arrayBuffer: async () => stubBytes.buffer.slice(stubBytes.byteOffset, stubBytes.byteOffset + stubBytes.byteLength) }
    }
    healthCalls += 1
    if (healthCalls === 1 || healthCalls === 2) throw new Error('ECONNREFUSED') // 一次逼它拉起、一次走轮询重试
    return healthyFetch()
  }
  const r = await startOwnedProxy({
    opts: smokeOpts(root, 19005, { superviseMs: 40 }),
    logger, fetchImpl, spawnImpl: (bin) => { spawned.push(bin); return { pid: 7, unref: () => {} } },
  })
  let sawFetchFail = false
  const healed = await until(() => {
    if (/取件失败/.test(String(r.detail))) sawFetchFail = true
    return r.ready === true
  }, 6000)
  assert.ok(sawFetchFail, '首次取件失败要如实出现在 detail 上')
  assert.ok(healed, `巡检重试后应当就绪（detail=${r.detail}）`)
  assert.equal(downloads, 2, '重试发生一次（幂等取件）')
  assert.equal(spawned.length, 1, '就绪前恰好拉起一次')
  assert.ok(!logs.some((m) => m.includes('[object')), '日志不该出现对象泄漏')
  await r.dispose()
  await rm(root, { recursive: true, force: true })
  ok('守护自愈：取件失败如实报 → 巡检重试 → 就绪（含 /api/version 轮询重试一次）')
}

// ---- 21. 守护：代理失联 → 就地重新拉起（引擎不用重启） ----
{
  const root = await seedProxyDir('reeve-relaunch-')
  const logs = []
  const logger = { debug: (m) => logs.push(String(m)) }
  let alive = true
  const spawned = []
  const fetchImpl = async (url) => {
    if (String(url).includes('/api/version') && !alive) throw new Error('ECONNREFUSED')
    return healthyFetch()
  }
  const r = await startOwnedProxy({
    opts: smokeOpts(root, 19006, { superviseMs: 40 }),
    logger, fetchImpl, spawnImpl: (bin) => { spawned.push(bin); return { pid: 8, unref: () => {} } },
  })
  assert.equal(r.ready, true)
  assert.equal(spawned.length, 0, '起手就是健康的（复用）')
  alive = false
  assert.ok(await until(() => spawned.length === 1, 3000), '失联后巡检要重新拉起')
  assert.ok(logs.some((m) => m.includes('失联，重新拉起')), '日志里要能看见这次自愈')
  await r.dispose()
  await rm(root, { recursive: true, force: true })
  ok('守护：代理失联 → 就地重新拉起（无需重启引擎）')
}

console.log(`\n代理层测试：${passed} 项全过`)
