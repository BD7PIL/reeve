#!/usr/bin/env node
// 引擎生命周期验收：证明"插件实例卸载（工作区被驱逐）≠ GATE 关端口"。
//
//   node scripts/accept-lifecycle.mjs                 # 开发机（默认引擎路径）
//   OC2=/path/to/opencode PLUGIN_DIR=/path/to/plugin node scripts/accept-lifecycle.mjs   # 对端/其他引擎
//   node scripts/accept-lifecycle.mjs --keep          # 失败时留下临时目录（取证）
//
// 做法：起一台**隔离引擎**（serve --stdio --port 0 + 临时 XDG/配置/DB + 随机密码），
// 用插件路径加载本地 reeve，然后：
//   ① GET  /api/location            拉起一个工作区 → 插件起 GATE（专用端口）
//   ② DELETE /api/debug/location    驱逐这个工作区（与闲置驱逐走同一条 invalidate→plugin cleanup 路径）
//   ③ 断言 GATE 仍在服务（0.1.6 之前这里会 502/connection refused）
//   ④ 再拉起同一个工作区 → 新插件实例复用同一台 GATE（probeGate）
//   ⑤ 杀引擎 → 端口释放
//
// 不使用生产引擎、不碰用户配置；所有状态在 os.tmpdir() 下，结束即删。
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const keep = process.argv.includes('--keep')
const pluginDir = process.env.PLUGIN_DIR ?? join(repo, 'plugin')
const engine = process.env.OC2 ?? (process.platform === 'win32' ? join(homedir(), '.local', 'share', 'ocrc', 'opencode2', 'opencode2.exe') : join(homedir(), '.ocrc', 'remote', 'engine', 'opencode'))

let passed = 0
const ok = (label, detail = '') => {
  passed += 1
  console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`)
}
const fail = (label, detail = '') => {
  console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () =>
  new Promise((r) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => r(p))
    })
  })

if (!existsSync(engine)) {
  console.error(`引擎不在：${engine}（用 OC2=... 指定）`)
  process.exit(2)
}

const dir = mkdtempSync(join(tmpdir(), 'reeve-lifecycle-'))
const workspace = join(dir, 'workspace')
mkdirSync(workspace, { recursive: true })
const configDir = join(dir, 'config')
mkdirSync(configDir, { recursive: true })
const gatePort = await freePort()
const password = randomBytes(12).toString('hex')
const fallbackPath = join(dir, 'fallback.jsonc')
writeFileSync(
  fallbackPath,
  JSON.stringify({
    schema: 1,
    policy: { max_fallback_attempts: 2, cooldown_seconds: 60 },
    providers: { unpaid: { base_url: 'http://127.0.0.1:1', key: 'none', models: ['x'] } },
    chains: { only: { targets: ['unpaid/x'] } },
    default_chain: 'only',
  }),
)
const engineConfig = join(configDir, 'opencode.json')
writeFileSync(
  engineConfig,
  JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    plugins: [
      {
        package: pluginDir,
        options: { ownEndpoint: false, snapshotPath: join(dir, 'snapshot.json'), retentionDays: 0, stats: { intervalMs: 0 }, gate: { enabled: true, port: gatePort, configPath: fallbackPath, ledgerPath: join(dir, 'gate.jsonl') } },
      },
    ],
  }),
)

const env = {
  ...process.env,
  XDG_DATA_HOME: join(dir, 'data'),
  XDG_CACHE_HOME: join(dir, 'cache'),
  XDG_CONFIG_HOME: configDir,
  XDG_STATE_HOME: join(dir, 'state'),
  OPENCODE_CONFIG_DIR: configDir,
  OPENCODE_CONFIG: engineConfig,
  OPENCODE_DB: join(dir, 'db.sqlite'),
  OPENCODE_PASSWORD: password,
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_MODELS_FETCH: '1',
}
delete env.OPENCODE_SERVER_PASSWORD

const child = spawn(engine, ['serve', '--stdio', '--port', '0'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
let stderr = ''
child.stderr.on('data', (c) => (stderr += c))
const url = await new Promise((resolveUrl, reject) => {
  let buf = ''
  const timer = setTimeout(() => reject(new Error(`引擎 20s 没就绪：${stderr.slice(-300)}`)), 20_000)
  child.stdout.on('data', (chunk) => {
    buf += chunk
    const line = buf.split('\n').find((l) => l.trim().startsWith('{'))
    if (!line) return
    try {
      const doc = JSON.parse(line)
      if (doc?.url) {
        clearTimeout(timer)
        resolveUrl(doc.url)
      }
    } catch {
      /* 还没拼完整 */
    }
  })
  child.on('exit', (code) => reject(new Error(`引擎提前退出 ${code}：${stderr.slice(-300)}`)))
})
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
const api = (path, init = {}) => fetch(`${url}${path}`, { ...init, headers: { authorization: auth, 'x-opencode-directory': workspace, ...(init.headers ?? {}) } })
const gateUp = async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${gatePort}/gate/version`, { signal: AbortSignal.timeout(1500) })
    if (!r.ok) return false
    return (await r.json())?.name === 'reeve-gate'
  } catch {
    return false
  }
}

try {
  ok('隔离引擎已起', url)
  // ① 拉起工作区（位置服务 + 插件加载）
  const boot = await api('/api/location')
  if (!boot.ok) throw new Error(`location boot HTTP ${boot.status}`)
  let up = false
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(250)
    up = await gateUp()
  }
  if (up) ok('插件加载后 GATE 起来', `127.0.0.1:${gatePort}`)
  else fail('插件加载后 GATE 起来', '20s 内 /gate/version 不可用')

  // ② 驱逐工作区（与 idle eviction 同一条 invalidate→shutdown→plugin cleanup 路径）
  const del = await api(`/api/debug/location?location[directory]=${encodeURIComponent(workspace)}`, { method: 'DELETE' })
  if (del.ok) ok('驱逐请求已接受', `HTTP ${del.status}`)
  else fail('驱逐请求已接受', `HTTP ${del.status} ${(await del.text().catch(() => '')).slice(0, 160)}`)
  await sleep(1200)

  // ③ 插件实例已卸载，但 GATE 仍在
  const stillUp = await gateUp()
  if (stillUp) ok('卸载后 GATE 仍在服务', '（0.1.6 之前这里是 connection refused）')
  else fail('卸载后 GATE 仍在服务', '驱逐后 /gate/version 不可用 —— detach 没生效')

  // ④ 重新拉起：新实例复用同一台 GATE
  const again = await api('/api/location')
  if (!again.ok) throw new Error(`re-boot HTTP ${again.status}`)
  await sleep(800)
  const ver = await fetch(`http://127.0.0.1:${gatePort}/gate/version`).then((r) => r.json())
  if (ver?.name === 'reeve-gate' && (await gateUp())) ok('再次拉起后复用同一台 GATE', `chains=${(ver.chains ?? []).join('/')}`)
  else fail('再次拉起后复用同一台 GATE', JSON.stringify(ver).slice(0, 160))
} catch (err) {
  fail('生命周期流程', String(err?.message ?? err).slice(0, 300))
} finally {
  child.stdin.end()
  await sleep(300)
  child.kill('SIGTERM')
  await sleep(1200)
  const released = !(await gateUp())
  if (released) ok('引擎退出后端口释放', `:${gatePort}`)
  else fail('引擎退出后端口释放', '引擎退出 1.5s 后 GATE 仍在')
  if (!keep) rmSync(dir, { recursive: true, force: true })
}

console.log(`\naccept-lifecycle: ${process.exitCode ? '有失败' : '全过'}（${passed} 项）`)
