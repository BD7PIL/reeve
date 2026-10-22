// 资源审计：模拟使用者实测的峰值场景（一个父会话 88 个并发子任务），
// 量一下插件的开销与写放大。
//   node plugin/test/_bench.mjs

import { Ledger } from '../src/ledger.js'
import { Admission } from '../src/concurrency.js'
import { Supervisor } from '../src/supervisor.js'
import { STATE } from '../src/constants.js'

const N = 88 // 使用者实测的峰值并发
const silent = { debug: () => {} }

// 计量：storage 写入次数与字节数
let writes = 0
let bytes = 0
const disk = new Map()
const storage = {
  async set(k, v) { writes += 1; bytes += JSON.stringify(v).length; disk.set(k, v) },
  async get(k) { return disk.get(k) },
  async remove(k) { disk.delete(k) },
  async scan({ prefix, limit = 100 } = {}) {
    const entries = [...disk.entries()].filter(([k]) => k.startsWith(prefix)).slice(0, limit)
      .map(([key, value]) => ({ key, value }))
    return { entries }
  },
}

const mem = () => Math.round(process.memoryUsage().heapUsed / 1024 / 1024)

console.log(`=== 场景：1 个父会话，${N} 个并发子任务（使用者实测峰值）===`)
console.log(`起点堆内存: ${mem()} MB`)

// --- 1. 台账 + 并发闸门 + 墙钟 全走一遍 ---
const led = new Ledger({ storage, logger: silent })
const adm = new Admission({ limits: { default: 0 } }) // 默认无限（照当前实现）
const sup = new Supervisor({ ledger: led, logger: silent, interrupt: async () => {} })

const t0 = process.hrtime.bigint()
const releases = []
for (let i = 0; i < N; i += 1) {
  const taskID = `call_${i}`
  // ① 闸门
  releases.push(await adm.acquire(`${taskID}`, { nested: false }))
  // ② 落台账
  led.create({ taskID, parentSessionID: 'p1', agent: 'scout', description: 'x', background: true })
  led.attachChild(taskID, `ses_${i}`)
  // ④ 墙钟
  sup.arm(taskID, 30 * 60 * 1000)
}
const tArm = process.hrtime.bigint()

// ③ 认终态（模拟事件流逐个到达）
for (let i = 0; i < N; i += 1) {
  const rec = led.forChildSession(`ses_${i}`)
  led.commitTerminal(rec.taskID, STATE.COMPLETED, { source: 'event' })
  sup.disarm(rec.taskID)
  releases[i]()
}
const tDone = process.hrtime.bigint()
await new Promise((r) => setTimeout(r, 50)) // 让 persist 的 promise 落地

const ms = (a, b) => Number(b - a) / 1e6
console.log(`\n--- 耗时 ---`)
console.log(`  建 ${N} 个任务（闸门+台账+墙钟）: ${ms(t0, tArm).toFixed(1)} ms`)
console.log(`  ${N} 个任务落终态:              ${ms(tArm, tDone).toFixed(1)} ms`)
console.log(`  合计:                          ${ms(t0, tDone).toFixed(1)} ms`)
console.log(`\n--- 写放大（这是最该看的）---`)
console.log(`  storage.set 调用次数: ${writes}`)
console.log(`  平均每个任务:         ${(writes / N).toFixed(1)} 次写`)
console.log(`  累计写入字节:         ${(bytes / 1024).toFixed(1)} KB`)
console.log(`  平均每个任务:         ${(bytes / N).toFixed(0)} B`)
console.log(`  盘上键数:             ${disk.size}`)
console.log(`\n--- 内存 ---`)
console.log(`  当前堆: ${mem()} MB（起点已记录）`)
console.log(`  台账记录数: ${led.all().length}`)

// --- 2. 关键路径的复杂度 ---
console.log(`\n--- 热点路径 ---`)
const tR = process.hrtime.bigint()
for (let i = 0; i < 1000; i += 1) led.running('p1') // 工具查询走的路径
const tR2 = process.hrtime.bigint()
console.log(`  ledger.running() 在 ${led.all().length} 条记录上跑 1000 次: ${ms(tR, tR2).toFixed(1)} ms`)
console.log(`  → 每次 ${(ms(tR, tR2) / 1000).toFixed(3)} ms（O(n)，n=台账总记录数）`)

const tF = process.hrtime.bigint()
for (let i = 0; i < 10000; i += 1) led.forChildSession(`ses_${i % N}`)
const tF2 = process.hrtime.bigint()
console.log(`  forChildSession() 跑 10000 次: ${ms(tF, tF2).toFixed(1)} ms（O(1) Map 查找，事件流每次命中它）`)

sup.stopAll()
console.log('\n完成。')
