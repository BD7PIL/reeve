// E1 引擎可视化测试（M2.5① 门；蓝图 .zcode/plans/next-phase-plan-m1-m5.md「M2.5①」行：
// 声明路径 steps+deps 直渲、脚本路径 phase 事件时间线、节点按 journal 状态着色、进 markdown 报告）。
//
// 覆盖矩阵：
//   声明 DAG   菱形（a→b,a→c,b→d,c→d）：节点数/边数/边方向（dep --> step）、flowchart LR 头、
//              journal 状态逐桶着色（done/running/dispatching→running/declared/failed/blocked/
//              superseded）、journal 缺步 = pending、未知状态 = pending 且报软错误、
//              class 语句与 classDef 定义行齐。
//   标签卫生   双引号/#/反斜杠/换行转义后进引号；超长截断（截断不打劈转义实体）；
//              节点 ID 用 n 首见序（stepId 里 "/" 与空格不影响图）。
//   脏数据面   重复 stepId 只画首见（deps 不重复出边）；重复 dep 边去重；自引用边不画；
//              未知引用边不画并报软错误；缺 stepId 的步跳过；deps 非数组/含非字符串不炸；
//              垃圾 declaration（null/数字/steps 缺失）ok:false 不抛；空 steps 数组 empty:true。
//   脚本时间线 phase 事件按 at 升序连线（乱序输入、同 at 保首见序）、非 phase 事件不进节点、
//              缺 name 的 phase 跳过并报软错误；尾节点着色：completed 全 done、failed 尾红、
//              缺省/在飞尾 running；无 phase 事件 empty:true。
//   报告入口   声明优先于事件（两样都给走声明路径）；只有 journalRecord 走脚本路径；
//              runId 不匹配拒绝渲染（ok:false）；两样都没有 ok:false；
//              journalRecord.steps（盘上 record 形状，含 history）与 listSteps 形状同读 .state；
//              markdown 是 ```mermaid 围栏 + 图例行，mermaid 原文嵌在围栏里。
//
// 夹具全合成（纯函数渲染器，无时钟/无故障/无 IO——没有可注入面，这正是渲染面的纪律）。
//
// 运行：node plugin/test/engine-visualize.test.mjs（assert 失败即抛、非零退出；成功自然退出）
import assert from 'node:assert/strict'

import {
  BUCKET_CLASS,
  BUCKET_CLASSDEFS,
  STATE_BUCKETS,
  renderDeclarationDag,
  renderRunReport,
  renderScriptTimeline,
  stateBucket,
} from '../src/engine/visualize.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- 夹具：journal 步记账（listSteps() 形状：{stepId → {state, attempts}}）----
const journalSteps = (states) => Object.fromEntries(Object.entries(states).map(([id, state]) => [id, { state, attempts: 1 }]))
/** markdown 围栏检查：mermaid 原文嵌在 ```mermaid 与 ``` 之间。 */
const fenced = (markdown, mermaid) => markdown.includes('```mermaid\n') && markdown.includes(`\n${mermaid}\n\`\`\``)

// ---- 1. stateBucket：journal 七态 → 六桶，未知 → pending ----
{
  assert.equal(stateBucket('done'), 'done')
  assert.equal(stateBucket('running'), 'running')
  assert.equal(stateBucket('dispatching'), 'running') // 在飞并进 running 桶
  assert.equal(stateBucket('declared'), 'pending') // 已播种未派并进 pending 桶
  assert.equal(stateBucket('failed'), 'failed')
  assert.equal(stateBucket('blocked'), 'blocked')
  assert.equal(stateBucket('superseded'), 'superseded')
  assert.equal(stateBucket('weird'), 'pending')
  assert.equal(stateBucket(undefined), 'pending')
  assert.equal(stateBucket(null), 'pending')
  assert.ok(STATE_BUCKETS.includes('done') && STATE_BUCKETS.includes('failed'))
  ok('stateBucket：七态→六桶（dispatching→running、declared→pending），未知/缺省→pending')
}

// ---- 2. 声明路径：菱形 DAG 直渲 + 着色 ----
{
  const declaration = {
    runId: 'run-diamond',
    steps: [
      { stepId: 'fetch', deps: [] },
      { stepId: 'clean', deps: ['fetch'] },
      { stepId: 'analyze', deps: ['fetch'] },
      { stepId: 'report', deps: ['clean', 'analyze'] },
    ],
  }
  const steps = journalSteps({ fetch: 'done', clean: 'done', analyze: 'running', report: 'failed' })
  const r = renderDeclarationDag({ declaration, journalSteps: steps })
  assert.equal(r.ok, true)
  assert.equal(r.empty, false)
  assert.equal(r.nodeCount, 4)
  assert.equal(r.edgeCount, 4)
  assert.ok(r.mermaid.startsWith('flowchart LR'))
  assert.ok(r.mermaid.includes('n0["fetch"]'))
  assert.ok(r.mermaid.includes('n1["clean"]'))
  assert.ok(r.mermaid.includes('n2["analyze"]'))
  assert.ok(r.mermaid.includes('n3["report"]'))
  // 边方向：dep --> step（依赖先跑）
  assert.ok(r.mermaid.includes('n0 --> n1'))
  assert.ok(r.mermaid.includes('n0 --> n2'))
  assert.ok(r.mermaid.includes('n1 --> n3'))
  assert.ok(r.mermaid.includes('n2 --> n3'))
  // 着色：class 语句按桶分组
  assert.ok(r.mermaid.includes(`class n0,n1 ${BUCKET_CLASS.done}`))
  assert.ok(r.mermaid.includes(`class n2 ${BUCKET_CLASS.running}`))
  assert.ok(r.mermaid.includes(`class n3 ${BUCKET_CLASS.failed}`))
  for (const def of BUCKET_CLASSDEFS) assert.ok(r.mermaid.includes(def))
  // markdown：围栏 + 图例
  assert.equal(fenced(r.markdown, r.mermaid), true)
  assert.ok(r.markdown.includes('图例'))
  assert.equal(r.errors.length, 0)
  ok('声明 DAG：菱形四步四边（dep-->step）、逐桶 class 着色、classDef 齐、markdown 围栏+图例')
}

// ---- 3. 声明路径：journal 缺步 / 未知状态 ----
{
  const declaration = { runId: 'run-gap', steps: [{ stepId: 'a', deps: [] }, { stepId: 'b', deps: ['a'] }] }
  const r = renderDeclarationDag({ declaration, journalSteps: journalSteps({ a: 'done' }) }) // b 无记账
  assert.equal(r.ok, true)
  assert.ok(r.mermaid.includes(`class n0 ${BUCKET_CLASS.done}`))
  assert.ok(r.mermaid.includes(`class n1 ${BUCKET_CLASS.pending}`)) // 缺记账 = pending
  assert.equal(r.errors.length, 0)

  const r2 = renderDeclarationDag({ declaration, journalSteps: { a: { state: 'mystery' }, b: { state: 'done' } } })
  assert.equal(r2.ok, true)
  assert.ok(r2.mermaid.includes(`class n0 ${BUCKET_CLASS.pending}`))
  assert.ok(r2.errors.some((e) => e.includes('mystery')))
  ok('声明 DAG：journal 缺步=pending；未知状态=pending 且留软错误')
}

// ---- 4. 声明路径：dispatching→running、declared→pending、blocked/superseded 各归各桶 ----
{
  const declaration = {
    steps: [
      { stepId: 's-dispatch', deps: [] },
      { stepId: 's-declared', deps: [] },
      { stepId: 's-blocked', deps: [] },
      { stepId: 's-super', deps: [] },
    ],
  }
  const r = renderDeclarationDag({
    declaration,
    journalSteps: journalSteps({ 's-dispatch': 'dispatching', 's-declared': 'declared', 's-blocked': 'blocked', 's-super': 'superseded' }),
  })
  assert.equal(r.ok, true)
  assert.ok(r.mermaid.includes(`class n0 ${BUCKET_CLASS.running}`))
  assert.ok(r.mermaid.includes(`class n1 ${BUCKET_CLASS.pending}`))
  assert.ok(r.mermaid.includes(`class n2 ${BUCKET_CLASS.blocked}`))
  assert.ok(r.mermaid.includes(`class n3 ${BUCKET_CLASS.superseded}`))
  ok('声明 DAG：dispatching→running、declared→pending、blocked/superseded 不混桶')
}

// ---- 5. 标签卫生：引号/#/反斜杠/换行/超长 ----
{
  const declaration = { steps: [{ stepId: 'a"b#c\\d', deps: [] }, { stepId: 'x'.repeat(120), deps: [] }, { stepId: 'multi\nline\ttab', deps: [] }, { stepId: `${'b'.repeat(79)}"z`, deps: [] }] }
  const r = renderDeclarationDag({ declaration })
  assert.equal(r.ok, true)
  assert.ok(r.mermaid.includes('n0["a#quot;b#35;c/d"]')) // " → #quot; · # → #35; · \ → /
  assert.ok(!r.mermaid.includes('"a"b')) // 裸引号不进标签
  assert.ok(r.mermaid.includes('n2["multi line tab"]')) // 换行压平
  const long = r.mermaid.split('\n').find((l) => l.trimStart().startsWith('n1['))
  assert.ok(long.includes('…')) // 超长截断
  const boundary = r.mermaid.split('\n').find((l) => l.trimStart().startsWith('n3['))
  assert.ok(boundary.endsWith('#quot;…"]')) // 截断点上的引号仍转义成完整实体（先截断后转义）
  ok('标签卫生：引号/#/反斜杠/换行转义、超长截断且不劈实体')
}

// ---- 6. 脏数据面：重复/自引用/未知引用/缺 stepId/垃圾形状 ----
{
  const declaration = {
    steps: [
      { stepId: 'dup', deps: ['base'] },
      { stepId: 'dup', deps: ['base'] }, // 重复：不重复出边
      { stepId: 'self', deps: ['self'] }, // 自引用：不画
      { stepId: 'ghost', deps: ['no-such'] }, // 未知引用：不画 + 软错误
      { deps: ['dup'] }, // 缺 stepId：跳过
      { stepId: 'ok', deps: 'bad-shape' }, // deps 非数组：不炸
      { stepId: 'str-dep', deps: [42, null, 'dup'] }, // 非字符串 dep 跳过；dup 的重复边去重
      { stepId: 'base', deps: [] },
    ],
  }
  const r = renderDeclarationDag({ declaration })
  assert.equal(r.ok, true)
  // 节点序（缺 stepId 的步跳过）：n0=dup · n1=self · n2=ghost · n3=ok · n4=str-dep · n5=base
  // 存活的边只有两条（方向恒为 dep --> step）：base→dup（n5-->n0）与 dup→str-dep（n0-->n4）
  const edgeLines = r.mermaid.split('\n').filter((l) => l.includes('-->'))
  assert.deepEqual(edgeLines.sort(), ['    n5 --> n0', '    n0 --> n4'].sort())
  assert.ok(r.errors.some((e) => e.includes('重复 stepId')))
  assert.ok(r.errors.some((e) => e.includes('自引用')))
  assert.ok(r.errors.some((e) => e.includes('不在步表里')))
  assert.ok(r.errors.some((e) => e.includes('缺 stepId')))
  assert.ok(r.errors.some((e) => e.includes('非字符串')))
  ok('脏数据面：重复步/自引用/未知引用/缺 stepId/坏 deps 各有软错误且不炸不误画')

  for (const garbage of [null, undefined, 42, 'x', {}, { runId: 'r' }, { steps: 'no' }]) {
    const r = renderDeclarationDag({ declaration: garbage })
    assert.equal(r.ok, false, `垃圾 declaration ${JSON.stringify(garbage)} 应回 ok:false`)
    assert.equal(r.mermaid, '')
    assert.ok(r.errors.length > 0)
  }
  const emptyRun = renderDeclarationDag({ declaration: { runId: 'r', steps: [] } })
  assert.equal(emptyRun.ok, true)
  assert.equal(emptyRun.empty, true)
  assert.equal(emptyRun.mermaid, '')
  ok('垃圾 declaration → ok:false 不抛；空 steps 数组 → ok+empty（空 run 平凡完成）')
}

// ---- 7. 脚本时间线：phase 事件按 at 排序连线 + 尾节点按 outcome 着色 ----
{
  const events = [
    { type: 'phase', at: 300, payload: { name: 'analyze' } },
    { type: 'ask', at: 310, payload: { value: { n: 1 } } }, // 非 phase：不进节点
    { type: 'phase', at: 100, payload: { name: 'collect' } },
    { type: 'run', at: 105, payload: { exitCode: 0 } },
    { type: 'phase', at: 200, payload: { name: 'collect#2 "复查"' } }, // 同 at 100？不——200 居中；标签带特殊字符
    { type: 'log', at: 250, payload: { message: 'halfway' } },
  ]
  const base = { events }
  const t1 = renderScriptTimeline({ ...base, outcome: { status: 'completed' } })
  assert.equal(t1.ok, true)
  assert.equal(t1.phaseCount, 3)
  const lines = t1.mermaid.split('\n')
  assert.ok(lines.includes('    p0["collect"]'))
  assert.ok(lines.includes('    p1["collect#35;2 #quot;复查#quot;"]'))
  assert.ok(lines.includes('    p2["analyze"]'))
  const edgeIdx = lines.findIndex((l) => l === '    p0 --> p1')
  assert.ok(edgeIdx > 0 && lines.includes('    p1 --> p2')) // 链
  assert.ok(t1.mermaid.includes(`class p0,p1,p2 ${BUCKET_CLASS.done}`)) // completed：全部 done

  const t2 = renderScriptTimeline({ ...base, outcome: { status: 'failed' } })
  assert.ok(t2.mermaid.includes(`class p0,p1 ${BUCKET_CLASS.done}`))
  assert.ok(t2.mermaid.includes(`class p2 ${BUCKET_CLASS.failed}`))

  const t3 = renderScriptTimeline({ ...base }) // 无 outcome（在飞）
  assert.ok(t3.mermaid.includes(`class p2 ${BUCKET_CLASS.running}`))
  assert.ok(t3.mermaid.includes(`class p0,p1 ${BUCKET_CLASS.done}`))

  const t4 = renderScriptTimeline({ events: [{ type: 'phase', at: 5, payload: { name: 'only' } }, { type: 'phase', at: 5, payload: { name: 'twin' } }] })
  assert.equal(t4.phaseCount, 2)
  const l4 = t4.mermaid.split('\n')
  assert.ok(l4.includes('    p0["only"]') && l4.includes('    p1["twin"]')) // 同 at 保首见序
  ok('脚本时间线：at 升序链（同 at 保首见序）、非 phase 不进节点、尾节点按 outcome 着色')
}

// ---- 8. 脚本时间线：缺 name / 无 phase / 垃圾 events ----
{
  const t = renderScriptTimeline({ events: [{ type: 'phase', at: 1, payload: {} }, { type: 'phase' }, { type: 'ask', at: 2, payload: {} }] })
  assert.equal(t.ok, true)
  assert.equal(t.empty, true)
  assert.ok(t.errors.some((e) => e.includes('缺 name')))
  assert.equal(renderScriptTimeline({ events: [] }).empty, true)
  for (const garbage of [null, undefined, 'x', 42, {}]) {
    const r = renderScriptTimeline({ events: garbage })
    assert.equal(r.ok, false, `垃圾 events ${JSON.stringify(garbage)} 应回 ok:false`)
    assert.ok(r.errors.length > 0)
  }
  ok('脚本时间线：缺 name 跳过、无 phase → empty、垃圾 events → ok:false 不抛')
}

// ---- 9. 报告入口：自动分轨 + runId 匹配守卫 ----
{
  const declaration = { runId: 'run-1', steps: [{ stepId: 'a', deps: [] }, { stepId: 'b', deps: ['a'] }] }
  const record = {
    runId: 'run-1',
    steps: { a: { state: 'done', attempts: 1, history: [{ from: null, to: 'declared', at: 1 }] }, b: { state: 'running', attempts: 1, history: [] } },
    events: [{ type: 'phase', at: 1, payload: { name: 'main' } }],
  }
  const r1 = renderRunReport({ declaration, journalRecord: record })
  assert.equal(r1.ok, true)
  assert.equal(r1.mode, 'declaration') // 声明优先
  assert.ok(r1.mermaid.includes(`class n0 ${BUCKET_CLASS.done}`))
  assert.ok(r1.mermaid.includes(`class n1 ${BUCKET_CLASS.running}`))

  const r2 = renderRunReport({ journalRecord: record, outcome: { status: 'completed' } })
  assert.equal(r2.ok, true)
  assert.equal(r2.mode, 'script') // 无声明 → 脚本时间线
  assert.ok(r2.mermaid.includes('p0["main"]'))

  const r3 = renderRunReport({ declaration: { ...declaration, runId: 'other' }, journalRecord: record })
  assert.equal(r3.ok, false)
  assert.ok(r3.errors.some((e) => e.includes('runId 不匹配')))

  const r4 = renderRunReport({})
  assert.equal(r4.ok, false)
  assert.ok(r4.errors.some((e) => e.includes('没有可渲染的数据源')))

  const r5 = renderRunReport({ journalRecord: { runId: 'run-2', steps: {} } }) // record 无 events、又无声明
  assert.equal(r5.ok, false)
  assert.ok(r5.errors.some((e) => e.includes('无可渲染数据')))

  const r6 = renderRunReport({ declaration, journalRecord: record, outcome: { status: 'failed' } })
  assert.equal(r6.mode, 'declaration') // outcome 不影响声明路径着色（状态以 journal 为准）
  assert.ok(r6.mermaid.includes(`class n1 ${BUCKET_CLASS.running}`))
  ok('报告入口：声明优先/脚本回退自动分轨、runId 不匹配拒渲染、无数据 ok:false')
}

console.log(`\n可视化测试：${passed} 项全过`)
