#!/usr/bin/env node
// GATE 浸泡测试（手动/nightly；不进 CI）：
//   两轮各 N 笔请求压过真 GATE（上游是本地 stub，不出网），第二轮再涨才算泄漏；同时看句柄/台账轮转/会话上界。
//
//   node --expose-gc scripts/soak-gate.mjs     # 2000 请求，并发 20（--expose-gc 让内存数字稳住后再量）
//   N=500 C=10 node scripts/soak-gate.mjs      # 小跑
//
// 阈值（超出即退出码 1）：RSS 增量 < 120MB、句柄增量 < 80、错误 0、台账有轮转、会话数 ≤ 10000。
import { createServer } from 'node:http'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startGate } from '../plugin/src/gate/gate.js'
import { BUNDLED_FALLBACK_PATH } from '../plugin/src/gate/config.js'

const N = Number(process.env.N ?? 2000)
const C = Math.max(1, Number(process.env.C ?? 20))
const silent = { debug: () => {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const upstream = createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')
    res.end('data: [DONE]\n\n')
  })
})
await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${upstream.address().port}`

const dir = await mkdtemp(join(tmpdir(), 'gate-soak-'))
const configPath = join(dir, 'fallback.jsonc')
const authPath = join(dir, 'auth.json')
const ledgerPath = join(dir, 'gate.jsonl')
await (await import('node:fs/promises')).writeFile(
  configPath,
  JSON.stringify({
    schema: 1,
    policy: { max_fallback_attempts: 2, cooldown_seconds: 60, models_ttl_seconds: 300, session_ttl_seconds: 1800 },
    providers: { soak: { base_url: base, key: 'none', models: ['m'] } },
    chains: { soak: { targets: ['soak/m'] } },
    default_chain: 'soak',
  }),
  'utf8',
)
await (await import('node:fs/promises')).writeFile(authPath, '{}', 'utf8')

const gate = await startGate({
  port: 0,
  configPath,
  bundledPath: BUNDLED_FALLBACK_PATH,
  ledgerPath,
  authPath,
  logger: silent,
  // 按行数估一个上限，保证这轮一定触发轮转（每行实际 ~200B，60B/行足够早转）
  ledgerMaxBytes: Math.max(16 * 1024, N * 60),
})
const MB = 1024 * 1024
const rss = () => process.memoryUsage().rss
const heap = () => process.memoryUsage().heapUsed
const handles = () => process._getActiveHandles().length
const m0 = { rss: rss(), heap: heap(), handles: handles() }

const one = async (round, i) => {
  const res = await fetch(`http://127.0.0.1:${gate.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-opencode-session-id': `soak-${round}-${i % 500}` },
    body: JSON.stringify({ model: 'soak', stream: true, messages: [{ role: 'user', content: 'ok' }] }),
  })
  await res.text()
  return res.status
}

// 跑两轮：第一轮是冷启动（堆扩容、连接池建立）；**第二轮再涨**才是泄漏。
// 每轮结束后 flush 台账 + 强制 GC（需要 --expose-gc），量"稳住后"的 heap/RSS。
const rounds = []
for (let round = 1; round <= 2; round++) {
  let ok = 0
  let bad = 0
  const t0 = Date.now()
  await Promise.all(
    Array.from({ length: C }, async (_, w) => {
      for (let i = w; i < N; i += C) {
        const status = await one(round, i)
        if (status === 200) ok += 1
        else bad += 1
      }
    }),
  )
  await gate.flushLedger?.()
  await sleep(800)
  global.gc?.()
  global.gc?.()
  await sleep(200)
  rounds.push({ round, ms: Date.now() - t0, ok, bad, heap: heap(), rss: rss(), handles: handles() })
}

const [first, second] = rounds
const totalOk = first.ok + second.ok
const totalBad = first.bad + second.bad
const totalMs = first.ms + second.ms
const heapDelta = Math.round((second.heap - first.heap) / MB)
const rssDelta = Math.round((second.rss - m0.rss) / MB)
const handleDelta = second.handles - m0.handles
const rps = Math.round(((N * 2) / totalMs) * 1000)
const size = (await stat(ledgerPath)).size
const rotated = await stat(`${ledgerPath}.1`).then(() => true, () => false)
const sessions = gate.sessions.size()

console.log(`GATE 浸泡：2 × ${N} 请求 / 并发 ${C} / ${totalMs}ms（${rps} req/s）`)
console.log(`  成功 ${totalOk} · 失败 ${totalBad}`)
console.log(`  第二轮 heap 增量 ${heapDelta} MB（泄漏门槛 <40）`)
console.log(`  RSS 增量 ${rssDelta} MB（门槛 <300；建议 --expose-gc）`)
console.log(`  句柄增量 ${handleDelta}（门槛 <80）`)
console.log(`  台账 ${size} bytes · 轮转 ${rotated ? '有' : '无'}`)
console.log(`  会话 ${sessions}（门槛 ≤10000）`)

const failures = []
if (totalBad > 0) failures.push(`失败 ${totalBad} 笔`)
if (heapDelta >= 40) failures.push(`第二轮 heap 增量 ${heapDelta}MB ≥40（疑似泄漏）`)
if (rssDelta >= 300) failures.push(`RSS 增量 ${rssDelta}MB ≥300`)
if (handleDelta >= 80) failures.push(`句柄增量 ${handleDelta} ≥80`)
if (!rotated) failures.push('台账没有轮转（ledgerMaxBytes 太小/写入没发生？）')
if (sessions > 10_000) failures.push(`会话 ${sessions} >10000`)

await gate.dispose()
upstream.close()
await rm(dir, { recursive: true, force: true })
if (failures.length) {
  console.error(`浸泡失败：${failures.join('；')}`)
  process.exit(1)
}
console.log('浸泡通过')
