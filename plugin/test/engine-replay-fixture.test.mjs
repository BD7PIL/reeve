// E1 引擎 replay 录制件在位测试（S7a 门；施工规格 .zcode/plans/e1-construction-spec.md
// §4-S7a / §5-T3.6）。
//
// 范围：S7a 真机产生的录制件（fixtures/engine/replay/<日期>/recording.json，取字典序最大
// 日期目录）必须能被 S3 的 replay driver 全链路消费——这是 T3.6 replay 半边的入场券：
//   1. 录制件在位且 loadReplayScenarios 装载非空（S7b/T3.6 的回放断言依赖它）；
//   2. 场景面齐备：sessionId 为真实引擎 id（ses_ 前缀）、result 应答脚本合法、context 为
//      原始形状（对象数组，条目带 info/parts——1.18.31 宿主 v1 message 面的实测形状）；
//   3. createReplayDriver 缺省根回放：match 命中 → create 返回录制 id、context 吐录制条目、
//      result 走完应答脚本、calls 记录齐全；
//   4. chaos 参数照契约生效（超时/重复回调不炸装载）。
//
// 本文件只读录制件、不做任何真机访问（离线）；真机取证由
// plugin/test/fixtures/engine/probe/s7a-http-probe.mjs 负责，六项实测结论见证据区
// .zcode/plans/evidence/s7a-probe-report.json。录制件换代（新日期目录）后本文件自动跟随字典序最大者。
//
// 夹具：唯一含真实形状的例外（规格 §6）；其余全合成。本文件不引用 probe 产物。
//
// 运行：node plugin/test/engine-replay-fixture.test.mjs（assert 失败即抛、非零退出；成功自然退出）
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { createDriver, loadReplayScenarios } from '../src/engine/driver.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// 与 driver.js latestDatedDir 同口径：取字典序最大的日期子目录（YYYY-MM-DD）
const replayRoot = fileURLToPath(new URL('./fixtures/engine/replay', import.meta.url))
const dateDirs = readdirSync(replayRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
const loaded = dateDirs.length > 0 ? loadReplayScenarios(join(replayRoot, dateDirs[dateDirs.length - 1])) : { scenarios: [], files: [] }
assert.ok(loaded.files.length > 0, `S7a 录制件在位（files=${loaded.files.join(',')}）——若被删除，T3.6 replay 半边无从运行`)
ok(`录制件在位：${loaded.files.join(',')}（${loaded.scenarios.length} 场景）`)

for (const [i, s] of loaded.scenarios.entries()) {
  assert.match(s.sessionId, /^ses_[A-Za-z0-9]+$/, `scenarios[${i}].sessionId 是真实引擎会话 id（ses_ 前缀）`)
  assert.ok(s.match.prompt.length > 0, `scenarios[${i}].match.prompt 非空`)
  assert.ok(s.result.length > 0, `scenarios[${i}].result 应答脚本非空`)
  const last = s.result[s.result.length - 1]
  assert.ok(['running', 'done', 'failed'].includes(last.status), `scenarios[${i}] 末应答是合法终态（${last.status}）`)
  assert.ok(Array.isArray(s.context) && s.context.length > 0, `scenarios[${i}].context 是非空数组（原始形状）`)
  for (const entry of s.context) {
    assert.equal(typeof entry, 'object', `scenarios[${i}].context 条目是对象`)
    // 两种实测宿主形状都收：v1 message 面 {info,parts}（S7a）；v2 扁平 face {type,text?/content?}+idle 尾条
    // （M1.3b/c probe-raw-entry 逐字节实测）。同一字段都不在 → 不是任何已知宿主形状，拒。
    assert.ok(
      'info' in entry || 'parts' in entry || 'role' in entry || 'type' in entry || 'text' in entry || 'content' in entry,
      `scenarios[${i}].context 条目带 info/parts/role（v1）或 type/text/content（v2 扁平）之一（实测形状）`,
    )
  }
}
ok(`场景面齐备：sessionId 真实、context 为原始形状（${loaded.scenarios[0].context.length} 条）`)

// ---- 缺省根回放全链路（driver 自己解析字典序最大日期目录）----
const driver = createDriver('replay', {})
assert.ok(driver.recordings.files.length > 0, '缺省根 driver 装载到录制件')
const s0 = loaded.scenarios[0]
const created = await driver.create({ title: s0.match.title, prompt: s0.match.prompt, model: s0.match.model })
assert.equal(created.sessionId, s0.sessionId, 'match 命中 → create 返回录制 sessionId')
const ctx = await driver.context(created.sessionId)
assert.ok(ctx !== undefined && ctx !== null, 'context(sessionId) 返回录制内容（不拒）')
const result = await driver.result(created.sessionId)
assert.equal(result.status, s0.result[s0.result.length - 1].status, 'result 走到应答脚本末态')
for (const op of ['create', 'context', 'result']) {
  assert.ok(driver.calls.some((c) => c.op === op), `calls 记录 ${op}`)
}
ok(`缺省根回放全链路：create→id 命中、context/result/calls 齐（末态 ${result.status}）`)

// ---- chaos 参数照契约接受（不炸构造；§6）----
for (const chaos of [{ timeoutMs: true }, { halfResponse: true }, { duplicateCallback: true }]) {
  const c = createDriver('replay', { chaos })
  assert.ok(typeof c.create === 'function', `chaos=${Object.keys(chaos).join(',')} 构造不炸`)
}
ok('chaos 三形态构造面（超时/半响应/重复回调）')

console.log(`引擎 replay 录制件在位测试（S7a 门）：${passed} 项全过`)
