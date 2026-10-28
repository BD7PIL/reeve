// reeve 0.2.11 真实 E2E：原生 agent 可选（hideBuiltins）+ foreman 快速通道。
//
//   node scripts/e2e-agents.mjs
//
// 前提：本机 OpenChamber（后台服务引擎）在跑，reeve ≥0.2.11 已加载，
// 全局配置里 reeve options.agents.hideBuiltins = false（本机声明已带）。
// 断言通道：opencode CLI（连接后台服务）+ 引擎 DB session_v2 表
// （parent_id = 子代理派发；session.directory 的归属与 CLI cwd 不一致，故按
//  title + agent + 时间窗定位会话，不按 directory）。
// exit 0 = 全部通过；非 0 = 有断言失败（每个失败打印 E2E-FAIL 行）。

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const HOME = process.env.USERPROFILE
const BIN = process.env.OPENCODE_BIN ?? join(HOME, 'AppData', 'Local', 'Programs', '@openchamberelectron', 'resources', 'opencode-cli', 'opencode.exe')
const DB = join(HOME, '.local', 'share', 'opencode', 'opencode.db')
const require_ = createRequire(import.meta.url)

let failures = 0
const pass = (label) => console.log(`  ✓ ${label}`)
const fail = (label, detail) => { failures += 1; console.log(`  ✗ E2E-FAIL ${label}${detail ? '：' + detail : ''}`) }
const note = (label) => console.log(`  · ${label}`)
const section = (label) => console.log(`\n== ${label} ==`)

function dbQuery(sql, ...params) {
  const { DatabaseSync } = require_('node:sqlite')
  const db = new DatabaseSync(DB, { readOnly: true })
  try { return db.prepare(sql).all(...params) } finally { db.close() }
}
/** 时间窗 + 标题 + agent 形状定位主会话（CLI run 的会话）。 */
function findSession({ since, titleLike, agentIn }) {
  const rows = dbQuery(
    'SELECT id, agent, title, time_created FROM session_v2 WHERE time_created > ? AND title LIKE ? ORDER BY time_created DESC LIMIT 20',
    since, `%${titleLike}%`,
  )
  return rows.find((r) => agentIn.includes(r.agent) && !r.parent_id) ?? null
}
function childDispatches(sessionId) {
  return dbQuery('SELECT agent, title FROM session_v2 WHERE parent_id = ? ORDER BY time_created', sessionId)
}
function runCli(args, cwd, timeoutMs = 420_000) {
  const r = spawnSync(BIN, args, { cwd, encoding: 'utf8', timeout: timeoutMs, shell: false })
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- E2E-1 可见性（registry ground truth：options-probe 的 roster 行） ----------
section('E2E-1 原生 agent 可见性')
{
  const probe = join(HOME, '.reeve', 'options-probe.log')
  if (!existsSync(probe)) fail('E2E-1', 'options-probe.log 不存在（需要带 roster 探针的引擎重启）')
  else {
    const lines = readFileSync(probe, 'utf8').trim().split('\n').filter((l) => l.includes('roster'))
    const last = lines.at(-1) ?? ''
    if (/build=false plan=false general=false explore=false/.test(last)) pass(`registry 名册：${last.split('roster ')[1]}（composer 数据源 hidden=false ⇒ 可见）`)
    else fail('E2E-1', `registry 名册不对：${last}`)
  }
}

// ---------- E2E-2 原生 build 直改 ----------
section('E2E-2 原生 build：单文件直改，零派发')
{
  const dir = join(tmpdir(), 'e2e-agents-build')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'README.txt'), 'line1 TODO-1\nline2\n')
  await sleep(1200)
  const t0 = Date.now()
  const r = runCli(['run', '--agent', 'build', '--auto', '把 README.txt 里的 TODO-1 替换为 DONE-1。只做这一个替换，不要问任何问题。'], dir)
  const changed = existsSync(join(dir, 'README.txt')) && readFileSync(join(dir, 'README.txt'), 'utf8').includes('DONE-1')
  if (!changed) fail('E2E-2 文件未变更', r.out.slice(-300))
  else pass('文件真实变更（TODO-1 → DONE-1）')
  const sess = findSession({ since: t0 - 60_000, titleLike: 'TODO-1', agentIn: ['build'] })
  if (!sess) fail('E2E-2 找不到 agent=build 的主会话')
  else {
    const kids = childDispatches(sess.id)
    if (kids.length === 0) pass('派发数 = 0（单代理，零编排开销）')
    else fail('E2E-2 派发数不为 0', JSON.stringify(kids.map((k) => k.agent)))
  }
}

// ---------- E2E-3 foreman 快速通道 ----------
section('E2E-3 foreman 快速通道：小任务只派 executor')
{
  const dir = join(tmpdir(), 'e2e-agents-fast')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'README.txt'), 'line1 TODO-1\nline2\n')
  await sleep(1200)
  const t0 = Date.now()
  const r = runCli(['run', '--auto', '把 README.txt 里的 TODO-1 替换为 DONE-1。这是一个单文件小改动，不要问任何问题，直接完成。'], dir)
  const changed = existsSync(join(dir, 'README.txt')) && readFileSync(join(dir, 'README.txt'), 'utf8').includes('DONE-1')
  if (!changed) fail('E2E-3 文件未变更', r.out.slice(-300))
  else pass('文件真实变更')
  const sess = findSession({ since: t0 - 60_000, titleLike: 'TODO-1', agentIn: [null, 'foreman'] })
  if (!sess) fail('E2E-3 找不到 foreman 主会话')
  else {
    const kids = childDispatches(sess.id)
    const agents = kids.map((k) => k.agent)
    const nExec = agents.filter((a) => a === 'executor').length
    const ceremony = agents.filter((a) => ['planner', 'critic', 'reviewer'].includes(a))
    if (nExec === 1 && ceremony.length === 0) pass(`快速通道：派发 = [${agents.join(',')}]（恰一次 executor，零仪式）`)
    else fail('E2E-3 派发形状不对', `agents=${JSON.stringify(agents)}（期望恰一次 executor，零 planner/critic/reviewer）`)
  }
}

// ---------- E2E-4 foreman 完整管线（对照：编排没被阉割） ----------
section('E2E-4 foreman 完整管线：跨模块任务仍走 plan+评审')
{
  const dir = join(tmpdir(), 'e2e-agents-full')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'a.js'), "const VERSION = '1'\nconsole.log('a', VERSION)\n")
  writeFileSync(join(dir, 'b.js'), "const VERSION = '1'\nconsole.log('b', VERSION)\n")
  await sleep(1200)
  const t0 = Date.now()
  const r = runCli(['run', '--auto', '把 a.js 和 b.js 里各自内联的 VERSION 常量抽到一个新建的 src/version.js 模块（export const VERSION = "2"），两个文件改成从它 import。这是跨模块契约改动，请走完整流程。'], dir, 600_000)
  const okFiles = ['src/version.js', 'a.js', 'b.js'].map((f) => join(dir, f)).every((f) => existsSync(f))
  if (okFiles) pass('跨模块产物落地（新模块 + 两处 import）')
  else note(`产物未在本轮全部落地（grill 被单发 CLI 中断/管线较长）——断言以派发形状为准；输出尾：${r.out.slice(-120).replace(/\s+/g, ' ')}`)
  const sess = findSession({ since: t0 - 60_000, titleLike: 'VERSION', agentIn: [null, 'foreman'] })
  if (!sess) fail('E2E-4 找不到 foreman 主会话')
  else {
    const kids = childDispatches(sess.id)
    const agents = kids.map((k) => k.agent)
    if (agents.includes('planner') && agents.includes('critic')) pass(`完整管线仍在：派发 = [${agents.join(',')}]`)
    else fail('E2E-4 跨模块任务没有走 plan/评审', `agents=${JSON.stringify(agents)}`)
  }
}

// ---------- 汇总 ----------
console.log(`\nE2E 结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`)
process.exit(failures === 0 ? 0 : 1)
