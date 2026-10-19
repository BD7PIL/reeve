// 台账快照：投影正确性 + 原子性 + opt-in。
// 跑法：node test/snapshot.mjs
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Ledger } from '../src/ledger.js'
import { SnapshotWriter, buildSnapshot, projectAgentTable } from '../src/snapshot.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}
const silent = { debug: () => {} }

const dir = await mkdtemp(join(tmpdir(), 'reeve-snap-'))

// ---- 1. buildSnapshot 的形状与计数 ----
{
  const records = [
    { taskID: 't1', parentSessionID: 'p', childSessionID: 'c1', agent: 'scout', state: 'running', startedAt: 10 },
    { taskID: 't2', parentSessionID: 'p', state: 'completed', startedAt: 20, endedAt: 30, terminalSource: 'tool-result' },
    { taskID: 't3', parentSessionID: 'p', state: 'error', startedAt: 5, timedOut: true },
    { taskID: 't4', parentSessionID: 'p', state: 'stopped', startedAt: 1, statusUncertain: true },
    { taskID: 't5', parentSessionID: 'p', state: 'reconciled', startedAt: 2 },
  ]
  const snap = buildSnapshot(records, { now: 999, version: '0.0.1' })
  assert.equal(snap.generatedAt, 999)
  assert.equal(snap.plugin, 'reeve')
  assert.equal(snap.version, '0.0.1')
  assert.deepEqual(snap.counts, { total: 5, running: 1, completed: 1, error: 1, stopped: 1, reconciled: 1 })
  // 按 startedAt 倒序 —— 面板默认看最近的
  assert.deepEqual(
    snap.tasks.map((t) => t.taskID),
    ['t2', 't1', 't3', 't5', 't4'],
  )
  assert.equal(snap.tasks.find((t) => t.taskID === 't3').timedOut, true)
  assert.equal(snap.tasks.find((t) => t.taskID === 't4').statusUncertain, true)
  ok('buildSnapshot：计数、排序、字段投影')
}

// ---- 2. 写盘是原子的：目标文件永远是完整 JSON，不留 .tmp ----
{
  const path = join(dir, 'ledger.json')
  const w = new SnapshotWriter({ path, logger: silent, debounceMs: 1 })
  w.schedule(() => buildSnapshot([{ taskID: 'a', state: 'running' }], { now: 1 }))
  assert.equal(await w.flush(), true)

  const parsed = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(parsed.tasks.length, 1)
  assert.equal(parsed.tasks[0].taskID, 'a')

  const files = await readdir(dir)
  assert.deepEqual(files.filter((f) => f.endsWith('.tmp')), [])
  ok('写盘原子：内容完整、无残留 .tmp')
}

// ---- 3. flush 幂等：没有变化就不写（免得面板轮询把盘写爆）----
{
  const path = join(dir, 'idempotent.json')
  const w = new SnapshotWriter({ path, logger: silent })
  w.schedule(() => buildSnapshot([]))
  assert.equal(await w.flush(), true)
  assert.equal(await w.flush(), false)
  ok('flush 幂等：无变化不重复写')
}

// ---- 4. 父目录不存在会自动建（部署时不会因为目录缺失而静默不写）----
{
  const path = join(dir, 'deep', 'nested', 'ledger.json')
  const w = new SnapshotWriter({ path, logger: silent })
  w.schedule(() => buildSnapshot([{ taskID: 'deep', state: 'running' }]))
  assert.equal(await w.flush(), true)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).tasks[0].taskID, 'deep')
  ok('自动建父目录')
}

// ---- 5. 写失败不抛（记账的正确性不依赖视图）----
{
  // 用一个"父路径是文件"的路径，制造 EEXIST/ENOTDIR
  const blocker = join(dir, 'blocker')
  await writeFile(blocker, 'x', 'utf8')
  const w = new SnapshotWriter({ path: join(blocker, 'sub', 'ledger.json'), logger: silent })
  w.schedule(() => buildSnapshot([]))
  assert.equal(await w.flush(), false) // 不抛，只是 false
  ok('写失败只返回 false，不抛异常')
}

// ---- 6. 台账变更会触发 onChange（快照是"变更驱动"，不是轮询）----
{
  const triggers = []
  const ledger = new Ledger({ storage: null, logger: silent })
  ledger.onChange = () => triggers.push(ledger.all().length)

  ledger.create({ taskID: 'x1', parentSessionID: 'p', agent: 'scout' })
  assert.equal(triggers.length, 1)
  ledger.attachChild('x1', 'ses_child')
  assert.equal(triggers.length, 2)
  ledger.commitTerminal('x1', 'completed', { source: 'tool-result' })
  assert.equal(triggers.length, 3)
  // 单调性：第二次落终态被拒。**被拒 = 什么都没变** → 不发通知（视图没有可刷新的东西）。
  ledger.commitTerminal('x1', 'error', { source: 'event' })
  assert.equal(triggers.length, 3)
  assert.equal(ledger.get('x1').state, 'completed')
  ok('台账变更 → onChange；被拒的迟到终态不发通知（没变就不写盘）')
}

// ---- 7. 快照只投影显示字段：不把内部字段漏出去 ----
{
  const snap = buildSnapshot([
    { taskID: 'a', state: 'running', generation: 3, attempts: 2, interruptSent: true, lastActivityAt: 1 },
  ])
  const keys = Object.keys(snap.tasks[0]).sort()
  assert.ok(!keys.includes('generation'), 'generation 不该进快照')
  assert.ok(!keys.includes('attempts'), 'attempts 不该进快照')
  assert.ok(!keys.includes('interruptSent'), 'interruptSent 不该进快照')
  assert.ok(keys.includes('statusUncertain'), 'statusUncertain 要在（面板要显示"不确定"）')
  ok('快照字段是白名单投影')
}

// ---- 8. agent 表投影：前台可见 / 隐藏 / subagent 三分类 ----
{
  const table = projectAgentTable([
    { id: 'foreman', mode: 'primary', hidden: false },
    { id: 'scout', mode: 'subagent', hidden: true },
    { id: 'build', mode: 'primary', hidden: true },
    { id: 'explore', mode: 'subagent', hidden: false },
  ])
  assert.deepEqual(table.visible.map((a) => a.id), ['foreman'], '前台可见只有 foreman')
  assert.deepEqual(table.hidden.map((a) => a.id).sort(), ['build', 'scout'], '隐藏的两人')
  assert.deepEqual(table.subagent.map((a) => a.id), ['explore'], '未被藏起来的 subagent')
  assert.equal(projectAgentTable(null), null, '读不到就 null，不假装知道')

  const snap = buildSnapshot([], { agents: table })
  assert.ok(snap.agentTable && snap.agentTable.visible[0].id === 'foreman', 'agent 表进快照')
  ok('agent 表投影进快照（前台可见 / 隐藏 / subagent）')
}

console.log(`\n快照测试：${passed} 项全过`)