// P4 C4 TS 前端测试（蓝图 .zcode/plans/next-round-plan-v4.md「P4」行；实证底座
// .zcode/plans/evidence/c4-esbuild-eval.md。实现 ts-front.js + script-wrap.js +
// script-runner.js TS 分支 + pgate.js classifyWorkflowScriptAsync + plan-gate.js .ts 路由 +
// script-patch.js .ts 补段同一管线）。
//
// 覆盖矩阵（P4 验收：.ts 示例 register→runScript mock 绿，含 TS×C1 坐标域两用例；JS 零回归）：
//   1. 纯函数面：isTsScriptName/TS_SCRIPT_EXTENSIONS 域；parseSourceMap/generatedToSource
//      （手搓 VLQ map 的增量解码 + 形状坏 → null——宁弃用证据不发明坐标）；
//      compileScriptBodyAsync 参数面（非 .ts 拒 / 空体拒 / 坏 TS → ok:false errors）。
//   2. esbuild 实装面：合法 TS 剥类型（interface/行内注解/types 清零；jsText 过 compileScriptBody
//      ——与 JS 路径同一 vm 编译，语法判定零分叉）；sourcemap 把生成域坐标映回 .ts 源文本
//      （esbuild 不保行数——本 run 探针实测，蓝图风险表「坐标域漂移」行的实现对策）。
//   3. 平台包缺失显式报错（原则 4 禁静默回退 JS）：(a) 真 ERR_MODULE_NOT_FOUND（ts-front 副本
//      落在无 esbuild 的临时树里动态 import——分辨率机制与生产同一条路径）；(b) 缺平台包的
//      esbuild 副本（无 @esbuild/*）→ transform 失败原文进 {ok:false, errors}。
//   4. runScript TS 端到端（mock driver）：.ts 脚本跑绿；ask 作用点证据落在 .ts 源文本坐标
//      （site.line === 源行 + prefixHash 独立复核 = sha(.ts 切片)——坐标系唯一写死）。
//   5. TS×C1 用例①（改尾部 → 前缀导入）：.ts 尾部补段 → 前缀 ask 全导入零重跑（patchFrom
//      不触发失准）；补段内容真执行。
//   6. TS×C1 用例②（失败点 ≥ patchFrom → patch-failed）：补段内 throw → patch-failed；
//      同一失败无 patchFrom → 维持 script-threw（不发明归类）。
//   7. register 面（P4 验收主链）：.ts register ok（commands 扫 .ts 源文本）；坏 TS register
//      拒绝零记录；.ts 补段 applyPatch 同一语法门（坏 TS 补段 → patch-syntax-invalid 零落盘）。
//   8. stopTsFront：只在 teardown 调的面（不抛、返回 undefined；从未加载 → 空操作）。
//
// 运行：node plugin/test/engine-ts-front.test.mjs（assert 失败即抛、非零退出）
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { createDriver } from '../src/engine/driver.js'
import { createJournal } from '../src/engine/journal.js'
import { resumeScript } from '../src/engine/resume-script.js'
import { applyPatch, firstChangedOffset } from '../src/engine/script-patch.js'
import { compileScriptBody, runScript } from '../src/engine/script-runner.js'
import { WRAPPER_BODY_LINE_BASE, compileScriptBodyAsync, generatedToSource, isTsScriptName, parseSourceMap, stopTsFront, TS_SCRIPT_EXTENSIONS } from '../src/engine/ts-front.js'
import { classifyWorkflowScriptAsync } from '../src/engine/pgate.js'
import { createPlanGate, storeStem } from '../src/plan-gate.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))
const tempHome = (label) => {
  const home = mkdtempSync(join(tmpdir(), `reeve-ts-front-${label}-`))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}
const memStorage = () => {
  let t = null
  return { read: () => t, write: (x) => (t = x) }
}
const fixedClock = (t = 1000) => () => t
const instantSleep = async () => {}
const sc = (prompt, text) => ({ name: prompt, match: { prompt }, result: [{ status: 'done', text }] })
const createCount = (driver) => driver.calls.filter((c) => c.op === 'create').length
/** 手算 .ts 文本行起点表（script-runner bodyLineStarts 同式——prefixHash 独立复核用）。 */
const lineStartsOf = (text) => {
  const starts = [0]
  let idx = text.indexOf('\n')
  while (idx !== -1) {
    starts.push(idx + 1)
    idx = text.indexOf('\n', idx + 1)
  }
  return starts
}

// ---- 1. 纯函数面 ----
console.log('1. 纯函数面（isTsScriptName / sourcemap 解析 / 参数面）')
{
  assert.deepEqual([...TS_SCRIPT_EXTENSIONS], ['.ts'], 'TS 扩展名域写死（P4 最小子集只 .ts）')
  assert.equal(isTsScriptName('wf.ts'), true, '.ts → true')
  assert.equal(isTsScriptName(join('d', 'x', 'run.script.ts')), true, '路径形式照样认扩展名')
  assert.equal(isTsScriptName('wf.js'), false, '.js → false（JS 路径零分叉）')
  assert.equal(isTsScriptName('wf.mts'), false, '.mts 不收（最小子集写死）')
  assert.equal(isTsScriptName('wf.TS'), false, '大小写敏感（repo 严格风格）')
  assert.equal(isTsScriptName(undefined), false, '非字符串 → false')

  // 手搓 VLQ map：行内生成列增量 + 跨行源行列累积（'U' VLQ 解码 = 10：符号位在最低位）
  const hand = parseSourceMap(JSON.stringify({ version: 3, sources: ['a'], mappings: 'AAAA;UCAA;AACA' }))
  assert.deepEqual(hand[0], [{ genCol: 0, srcLine: 0, srcCol: 0 }], '行 1：全零段')
  assert.deepEqual(hand[1], [{ genCol: 10, srcLine: 0, srcCol: 0 }], '行 2：生成列行内增量（K=10）+ 源行列累积')
  assert.deepEqual(hand[2], [{ genCol: 0, srcLine: 1, srcCol: 0 }], '行 3：源行跨行累积（+1）')
  assert.deepEqual(generatedToSource(hand, 2, 12), { line: 1, col: 2 }, '生成位（行2,列12）→ 段 genCol10 → 源(1,2)')
  assert.deepEqual(generatedToSource(hand, 3, 1), { line: 2, col: 1 }, '生成位（行3,列1）→ 源(2,1)')
  assert.equal(generatedToSource(hand, 9, 1), null, '行越界 → null（无映射）')
  assert.equal(generatedToSource(null, 1, 1), null, 'map 缺失 → null')
  assert.equal(parseSourceMap('not-json'), null, '非 JSON → null')
  assert.equal(parseSourceMap('{"mappings":"A!!"}'), null, '非法 VLQ → null（宁弃用不发明）')
  assert.equal(parseSourceMap('{}'), null, '缺 mappings → null')

  // compileScriptBodyAsync 参数面
  await assert.rejects(compileScriptBodyAsync('const a = 1', 'wf.js'), TypeError, '非 .ts scriptName 拒（分流责任在调用方）')
  await assert.rejects(compileScriptBodyAsync('', 'wf.ts'), TypeError, '空体拒')
  const badTs = await compileScriptBodyAsync('interface X { a: : number }', 'wf.ts')
  assert.deepEqual([badTs.ok, Array.isArray(badTs.errors)], [false, true], '坏 TS → ok:false + errors 数组')
  assert.ok(badTs.errors.length > 0 && badTs.errors[0].includes('TS 前端'), '错误带 TS 前端点名')
  ok('扩展名域 + 手搓 VLQ 增量解码四断言 + 形状坏三形 null + 参数面三路')
}

// ---- 2. esbuild 实装面（剥类型 + sourcemap 映射回源）----
console.log('2. esbuild 实装面（TS 剥类型 + sourcemap 坐标域）')
{
  const BODY = [
    'interface Step { id: string }',
    'type Items = Array<{ id: string; note?: string }>;',
    'const items: Items = [{ id: "a" }]',
    'const n: number = await F.ask("TS问句")',
    'function pick(list: Items, i: number): string {',
    '  return list[i].id',
    '}',
    'const s: string = pick(items, 0)',
    'return { n, s }',
  ].join('\n')
  const lowered = await compileScriptBodyAsync(BODY, 'wf.ts')
  assert.equal(lowered.ok, true, '合法 TS 编译过')
  assert.equal(lowered.jsText.includes('interface'), false, 'interface 剥净')
  assert.equal(lowered.jsText.includes(': number'), false, '行内类型注解剥净')
  assert.equal(lowered.jsText.includes('await F.ask("TS问句")'), true, '运行时语义保留')
  assert.doesNotThrow(() => compileScriptBody(lowered.jsText, 'wf.ts'), 'jsText 过 JS 同一 vm 编译（语法判定零分叉）')
  // 探针实测：esbuild 不保行数（interface/type 行整行删除）——生成域第 7 行 = 源域第 4 行（F.ask）
  const genLines = lowered.jsText.split('\n')
  const genAskLine = genLines.findIndex((l) => l.includes('F.ask')) + 1
  assert.notEqual(genAskLine, 4, `夹具自检：生成域 ask 行（${genAskLine}）≠ 源域行 4——esbuild 不保行数成立，映射不可省`)
  // 生成域（源码第 ask 行, F 列）→ 包装域 → 体域 = 源行 4
  const genCol = genLines[genAskLine - 1].indexOf('F.ask') + 1
  const mapped = generatedToSource(lowered.sourceMap, genAskLine, genCol)
  assert.ok(mapped, '映射存在')
  const bodyLine = mapped.line - WRAPPER_BODY_LINE_BASE
  assert.equal(bodyLine, 4, `映射回 .ts 源文本：体行 ${bodyLine} === 源 ask 行 4（坐标系唯一）`)
  const srcLines = BODY.split('\n')
  assert.ok(srcLines[bodyLine - 1].includes('F.ask'), '体行指向源 ask 行原文')
  ok('剥类型 + JS 同一 vm 编译零分叉 + sourcemap 映射回 .ts 源文本（不保行数 → 映射必需）')
}

// ---- 3. 平台包缺失显式报错（原则 4：禁静默回退 JS）----
console.log('3. 平台包缺失显式报错')
{
  // (a) 真 ERR_MODULE_NOT_FOUND：ts-front + script-wrap 副本落进无 esbuild 的临时树（副本的
  //     import('esbuild') 与生产同一解析机制——bare specifier 就近 node_modules 上溯）
  const homeA = tempHome('missing')
  try {
    mkdirSync(join(homeA.home, 'src', 'engine'), { recursive: true })
    cpSync(join(PLUGIN_ROOT, 'src', 'engine', 'ts-front.js'), join(homeA.home, 'src', 'engine', 'ts-front.js'))
    cpSync(join(PLUGIN_ROOT, 'src', 'engine', 'script-wrap.js'), join(homeA.home, 'src', 'engine', 'script-wrap.js'))
    const copyUrl = pathToFileURL(join(homeA.home, 'src', 'engine', 'ts-front.js'))
    const copy = await import(copyUrl)
    await assert.rejects(
      copy.compileScriptBodyAsync('const a: number = 1', 'wf.ts'),
      (error) => error instanceof Error && error.message.includes('TS 前端不可用') && error.message.includes('禁静默回退 JS'),
      'esbuild 解析失败 → 显式报错点名 TS 前端不可用 + 禁静默回退（原则 4）',
    )
    ok('(a) 真 ERR_MODULE_NOT_FOUND 路径：显式报错带 TS 前端不可用 + 禁静默回退 JS 原文')
  } finally {
    homeA.cleanup()
  }

  // (b) 缺平台包的 esbuild 副本（无 @esbuild/*）→ transform 失败原文如实进 errors。
  //     chdir 进夹具：esbuild 二进制解析会看 process.cwd()（0.28.2 main.js 实装），测试进程的
  //     cwd（plugin/）带着真平台包会「救活」副本——cwd 换到夹具内才是真缺包现场。
  const homeB = tempHome('broken')
  const prevCwd = process.cwd()
  try {
    mkdirSync(join(homeB.home, 'node_modules'), { recursive: true })
    cpSync(join(PLUGIN_ROOT, 'node_modules', 'esbuild'), join(homeB.home, 'node_modules', 'esbuild'), { recursive: true })
    process.chdir(homeB.home)
    const brokenMod = await import(pathToFileURL(join(homeB.home, 'node_modules', 'esbuild', 'lib', 'main.js')))
    const broken = brokenMod.default ?? brokenMod
    const out = await compileScriptBodyAsync('const a: number = 1', 'wf.ts', { loadEsbuild: async () => broken })
    assert.deepEqual([out.ok, Array.isArray(out.errors)], [false, true], '平台包缺失 → ok:false + errors（不是 JS 回退、不是抛异常）')
    assert.ok(
      out.errors.some((e) => e.includes('@esbuild') || e.includes('could not be found') || e.includes('binary')),
      `错误原文点名平台包（实际：${out.errors[0].slice(0, 120)}）`,
    )
    ok('(b) 缺 @esbuild/* 平台包：transform 失败原文进 errors（esbuild 分发面显式失败）')
  } finally {
    process.chdir(prevCwd)
    homeB.cleanup()
  }
}

// ---- 4. runScript TS 端到端 + 坐标域独立复核 ----
console.log('4. runScript TS 端到端（坐标系唯一 = .ts 源文本）')
{
  const RUN = 'run-ts-e2e'
  const P1 = 'TS甲: 给个数'
  const P2 = 'TS乙: 产出'
  const BASE = [
    'interface Step { id: string }',
    `const a: string = await F.ask(${JSON.stringify(P1)})`,
    `const b: string = await F.ask(${JSON.stringify(P2)})`,
  ].join('\n')
  const { cleanup } = tempHome('run')
  try {
    const storage = memStorage()
    const journal = createJournal({ storage, runId: RUN, now: fixedClock() })
    const driver = createDriver('mock', { scenarios: [sc(P1, 'A1'), sc(P2, 'B2')] })
    const res = await runScript({ script: BASE, runId: RUN, journal, driver }, { now: fixedClock(), sleep: instantSleep, scriptName: 'wf.ts' })
    assert.deepEqual(
      [res.status, res.asks.map((a) => a.value)],
      ['completed', ['A1', 'B2']],
      '.ts 脚本跑绿（transform 喂 vm）',
    )

    // 坐标域独立复核（不信任写端公式——用行起点表重算）
    const starts = lineStartsOf(BASE)
    for (const [i, ask] of res.asks.entries()) {
      assert.ok(ask.site && ask.site.line >= 1, `ask${i + 1} 作用点证据在（TS 路径非 null）`)
      assert.equal(ask.site.line, i + 2, `ask${i + 1} site.line = 源行 ${i + 2}（生成域在第 ${i + 5} 行——sourcemap 映射证据）`)
      const offset = starts[ask.site.line - 1] + ask.site.col - 1
      const lineEnd = ask.site.line < starts.length ? starts[ask.site.line] - 1 : BASE.length
      assert.ok(offset >= starts[ask.site.line - 1] && offset <= lineEnd, `ask${i + 1} 偏移落在本 ask 行内（列映射不走样）`)
      assert.equal(ask.prefixHash, sha(BASE.slice(0, offset)), `ask${i + 1} prefixHash = sha(.ts 源文本切片)——坐标域唯一`)
      assert.equal(ask.promptHash, sha([P1, P2][i]), `ask${i + 1} promptHash = sha(源文本 prompt)`)
    }
    // journal 盘上同域（resume 读端消费的就是这份）
    const events = JSON.parse(storage.read()).events.filter((e) => e.type === 'ask')
    assert.equal(events[0].payload.site.line, 2, '盘上 ask 事件 site 同 .ts 域')
    ok('.ts 跑绿 + site.line 源行 + prefixHash/promptHash 独立复核全对（坐标系唯一）')
  } finally {
    cleanup()
  }
}

// ---- 5. TS×C1 用例①：改尾部 → 前缀导入零重跑 ----
console.log('5. TS×C1 用例①：.ts 改尾部 → 前缀导入')
{
  const RUN = 'run-ts-tail'
  const P1 = 'TS尾甲: 给个数'
  const P2 = 'TS尾乙: 产出'
  const BASE = [
    'interface Step { id: string }',
    `const a: string = await F.ask(${JSON.stringify(P1)})`,
    `const b: string = await F.ask(${JSON.stringify(P2)})`,
  ].join('\n')
  const PATCHED = `${BASE}\nF.log('ts-tail')\nreturn { a, b, patched: true }`
  const { home, cleanup } = tempHome('tail')
  try {
    const basePath = join(home, 'wf.ts')
    writeFileSync(basePath, BASE)
    const storage = memStorage()
    const journalA = createJournal({ storage, runId: RUN, now: fixedClock() })
    const driverA = createDriver('mock', { scenarios: [sc(P1, 'A1'), sc(P2, 'B2')] })
    const resA = await runScript({ script: BASE, runId: RUN, journal: journalA, driver: driverA }, { now: fixedClock(), sleep: instantSleep, scriptName: 'wf.ts' })
    assert.deepEqual([resA.status, resA.asks.map((a) => a.value)], ['completed', ['A1', 'B2']], '首跑绿')

    // .ts 补段同一管线（applyPatch 语法门走 TS 前端）+ 尾部追加
    const patch = await applyPatch({ scriptPath: basePath, patchedScript: PATCHED, runId: RUN, storage, journal: journalA, patch: { anchor: 'tail', reason: '尾部补段', source: 'model' } })
    assert.equal(patch.ok, true, '.ts 补段 applyPatch ok（TS 语法门过）')
    assert.equal(patch.patchedPath, join(home, 'wf.patch-1.ts'), '补段文件沿用 .ts 扩展名（<stem>.patch-<seq><ext>）')
    assert.equal(patch.changedFrom, firstChangedOffset(BASE, PATCHED), 'changedFrom = .ts 源文本首个变更字节（尾部追加 = base 长度）')

    // 读端：两笔前缀 ask 全导入（前缀字节零变更 → sourcemap 映射逐位一致）
    const resume = resumeScript(PATCHED, storage, RUN)
    assert.deepEqual([resume.ok, resume.matchedCount, resume.askEventCount], [true, 2, 2], '前缀两 ask 全进缓存')
    const patchEvent = JSON.parse(storage.read()).events.some((e) => e.type === 'patch')
    assert.equal(patchEvent, true, 'patch 事件在盘（不影响 ask 缓存——resume-script fall-through）')

    const journalB = createJournal({ storage, runId: RUN, now: fixedClock() })
    const driverB = createDriver('mock', { scenarios: [sc(P1, 'A1'), sc(P2, 'B2')] })
    const resB = await runScript(
      { script: PATCHED, runId: RUN, journal: journalB, driver: driverB },
      { now: fixedClock(), sleep: instantSleep, scriptName: 'wf.ts', askCache: resume.cached, patchFrom: patch.changedFrom },
    )
    assert.equal(resB.status, 'completed', '重跑绿')
    assert.equal(resB.value.a, 'A1', '前缀 ask 导入值恒等首跑')
    assert.equal(resB.value.patched, true, '补段 return 生效（vm 跨 realm 对象按字段断言）')
    assert.equal(createCount(driverB), 0, '两 ask 全命中：零 driver 调用（改尾部未触发坐标域失准）')
    assert.equal(resB.asks.filter((a) => a.cached === true).length, 2, 'cached:true ×2（值恒等首跑）')
    assert.deepEqual(resB.logs, ['ts-tail'], '补段内容真执行')
    ok('TS×C1①：.ts 改尾部 → 前缀导入零重跑 + 补段真执行（applyPatch .ts 同一管线）')
  } finally {
    cleanup()
  }
}

// ---- 6. TS×C1 用例②：失败点 ≥ patchFrom → patch-failed ----
console.log('6. TS×C1 用例②：补段内失败归类')
{
  const RUN = 'run-ts-patchfail'
  const P1 = 'TS败: 给个数'
  const BASE = [
    'interface Step { id: string }',
    `const a: string = await F.ask(${JSON.stringify(P1)})`,
    "throw new Error('ts-boom')",
  ].join('\n')
  const PATCHED = [
    'interface Step { id: string }',
    `const a: string = await F.ask(${JSON.stringify(P1)})`,
    "F.log('patched-ts')",
    "throw new Error('boom-in-patch')",
  ].join('\n')
  const { home, cleanup } = tempHome('patchfail')
  try {
    const basePath = join(home, 'wf.ts')
    writeFileSync(basePath, BASE)
    const storage = memStorage()
    const journalA = createJournal({ storage, runId: RUN, now: fixedClock() })
    const driverA = createDriver('mock', { scenarios: [sc(P1, 'A1')] })
    const resA = await runScript({ script: BASE, runId: RUN, journal: journalA, driver: driverA }, { now: fixedClock(), sleep: instantSleep, scriptName: 'wf.ts' })
    assert.deepEqual([resA.status, resA.reason], ['failed', 'script-threw'], '首跑尾部 throw → failed（补段动机现场）')

    const patch = await applyPatch({ scriptPath: basePath, patchedScript: PATCHED, runId: RUN, storage, journal: journalA, patch: { anchor: 'tail', reason: '换出口', source: 'model' } })
    assert.equal(patch.ok, true)

    // 带边界：补段内 throw → patch-failed（throw 点 .ts 域偏移 ≥ changedFrom）
    const journalB = createJournal({ storage, runId: RUN, now: fixedClock() })
    const driverB = createDriver('mock', { scenarios: [sc(P1, 'A1')] })
    const resB = await runScript(
      { script: PATCHED, runId: RUN, journal: journalB, driver: driverB },
      { now: fixedClock(), sleep: instantSleep, scriptName: 'wf.ts', patchFrom: patch.changedFrom },
    )
    assert.deepEqual([resB.status, resB.reason], ['failed', 'patch-failed'], '失败点 ≥ patchFrom（.ts 域）→ patch-failed')

    // 无边界：同一失败维持 script-threw（不发明归类）
    const journalC = createJournal({ storage, runId: RUN, now: fixedClock() })
    const driverC = createDriver('mock', { scenarios: [sc(P1, 'A1')] })
    const resC = await runScript(
      { script: PATCHED, runId: RUN, journal: journalC, driver: driverC },
      { now: fixedClock(), sleep: instantSleep, scriptName: 'wf.ts' },
    )
    assert.deepEqual([resC.status, resC.reason], ['failed', 'script-threw'], '无 patchFrom → 不参与归类')
    ok('TS×C1②：补段内 throw → patch-failed；无 patchFrom 维持 script-threw（.ts 域一致性）')
  } finally {
    cleanup()
  }
}

// ---- 7. register 面（P4 验收主链：.ts register → mock 绿；坏 TS 拒绝零记录）----
console.log('7. register 面：.ts 登记 → runScript mock 绿')
{
  const { home, cleanup } = tempHome('register')
  try {
    const storeDir = join(home, 'store')
    writeFileSync(join(home, 'plan.md'), 'seed\n')
    const gate = createPlanGate({ options: { enabled: true, storeDir, planPath: join(home, 'plan.md') }, ledger: null, logger: { debug: () => {} }, directory: home })
    const S = 'session-ts-register'

    // 合法 .ts：register ok，commands 扫 .ts 源文本（F.run 字面量）
    const SCRIPT = [
      'interface Cfg { host: string }',
      'const cfg: Cfg = { host: "example.invalid" }',
      "await F.run('node', ['--version'])",
      "const v: string = await F.ask('TS登: 给个数')",
      'F.log(v)',
    ].join('\n')
    const scriptPath = join(home, 'wf-register.ts')
    writeFileSync(scriptPath, SCRIPT)
    const reg = await gate.registerSession(S, scriptPath, 'workflow-script')
    assert.deepEqual([reg.ok, reg.artifactKind], [true, 'workflow-script'], '.ts register 接受')
    assert.equal(reg.hash, sha(SCRIPT), 'hash 绑 .ts 文件全字节（D1 不变，TS 只在登记时点校验）')
    assert.deepEqual(reg.script.commands, ['node'], 'commands 扫 .ts 源文本字面量（供评审）')

    // pgate 分类面直测（registerSession 内部同一函数——形状/分流/命令扫描逐一钉面）
    const classified = await classifyWorkflowScriptAsync(Buffer.from(SCRIPT, 'utf8'), 'wf-register.ts')
    assert.deepEqual(
      [classified.ok, classified.script.commands],
      [true, ['node']],
      'classifyWorkflowScriptAsync：.ts 字节 → ok + 源文本命令扫描',
    )
    await assert.rejects(classifyWorkflowScriptAsync(Buffer.from('const a = 1'), 'wf.js'), TypeError, '非 .ts scriptName 拒（分流责任在调用方）')

    // 登记后 mock 跑同一文本 → 绿（register 与执行同一语法判定）
    const storage = memStorage()
    const journal = createJournal({ storage, runId: 'run-ts-reg', now: fixedClock() })
    const driver = createDriver('mock', { scenarios: [sc('TS登: 给个数', 'ok1')] })
    const res = await runScript({ script: SCRIPT, runId: 'run-ts-reg', journal, driver }, { now: fixedClock(), sleep: instantSleep, scriptName: 'wf-register.ts' })
    assert.equal(res.status, 'completed', 'register 过的 .ts runScript mock 绿')

    // 坏 TS：register 拒绝且零记录
    const S_BAD = 'session-ts-register-bad'
    const badPath = join(home, 'wf-bad.ts')
    writeFileSync(badPath, 'interface X { a: : number }')
    const refused = await gate.registerSession(S_BAD, badPath, 'workflow-script')
    assert.deepEqual([refused.ok, refused.error.includes('workflow-script invalid')], [false, true], '坏 TS register 拒绝')
    assert.ok(refused.error.includes('TS 前端'), '报错带 TS 前端点名')
    assert.equal(existsSync(join(storeDir, `${storeStem(S_BAD)}.json`)), false, '零记录：store 文件不建')

    // 坏 TS 补段：applyPatch 同一语法门（.ts 同一管线），零落盘零事件
    const okPath = join(home, 'wf-ok.ts')
    writeFileSync(okPath, SCRIPT)
    const journalP = createJournal({ storage, runId: 'run-ts-reg', now: fixedClock() })
    const badPatch = await applyPatch({ scriptPath: okPath, patchedScript: 'const const const', runId: 'run-ts-reg', storage, journal: journalP, patch: { anchor: 'tail', reason: 'r', source: 's' } })
    assert.deepEqual([badPatch.ok, badPatch.reason], [false, 'patch-syntax-invalid'], '坏 TS 补段 → patch-syntax-invalid（同一 TS 前端门）')
    assert.equal(existsSync(join(home, 'wf-ok.patch-1.ts')), false, '零落盘')
    assert.equal(JSON.parse(storage.read()).events.filter((e) => e.type === 'patch').length, 0, '零事件')
    ok('.ts register→runScript mock 绿（commands 扫源文本）+ 坏 TS register 拒绝零记录 + 补段同一语法门')
  } finally {
    cleanup()
  }
}

// ---- 8. stopTsFront（只在 teardown 调的面）----
console.log('8. stopTsFront')
{
  const out = await stopTsFront()
  assert.equal(out, undefined, '返回 undefined；从未加载（纯 JS 会话）→ 空操作不抛')
  ok('stopTsFront 面存在：teardown 专用（ts-front.js 头注 C4 注记④；宿主面无 teardown 挂点——不调也安全）')
}

console.log(`\n全部 ${passed} 项通过`)
if (passed === 0) process.exit(1)
