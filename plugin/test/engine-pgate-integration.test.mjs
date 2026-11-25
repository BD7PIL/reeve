// E1 × plan-gate 集成（S9；施工规格 .zcode/plans/e1-construction-spec.md §3 / §8-S9；
// M2.4 增量：workflow-script 脚本文件的登记判别与同矩阵回路）。
//
// 门（规格 §8-S9）：node plugin/test/engine-pgate-integration.test.mjs
// 断言三件事：
//   1) register 接受 kind:"engine-run" 的声明文件路径——合法声明 → ok、钉文件全字节 sha256
//      （含 kind 字段，D1）、payload 带 artifactKind/declaration；自称 engine-run 但声明体
//      不过 validateDeclaration → 拒绝且零记录（store 文件都不建）；kind 以外的文件
//      （普通方案 markdown、无 kind JSON、kind 别值）→ 与旧行为一致按普通 artifact 接受。
//   2) check 复用同一决策矩阵——engine-run 登记后的门禁回路（register → 派发 critic →
//      判决 → check / 偷改文件 → check / 字节恢复 → check）与普通方案文件场景逐行同矩阵：
//      期望（decision/reason）全部运行时取自 plugin/test/fixtures/decision-matrix.json
//      （R2-1 纪律：行文不复制），且两个场景的 decision/reason 三元组逐一相等（无并行决策面）。
//   3) M2.4：register 接受 kind:"workflow-script"（脚本文件路径——裸函数体无文件内 kind 标记，
//      由 register 的 kind 参数显式给）——合法脚本（语法门 = runScript 同一包装）→ ok、全字节
//      哈希绑定、payload 带 script.commands（命令字面量扫描供评审）；语法不过/空文件 → 拒绝且
//      零记录；脚本场景与 engine-run/plain 场景的门禁轨迹三方逐点相等（同一决策矩阵，TOCTOU
//      偷改脚本字节照走 #5 行）。
//
// 夹具全合成（临时目录 + 合成声明/方案/脚本文件；createPlanGate 直连，ledger=null → 一切会话皆根）。
// 不引用 replay 录制件（fixtures/engine/replay/ 属 S7a 后序，本测试零触碰）。
// 时钟/fault：本步不新增注入面——register/check 复用 plan-gate 既有内部通路（pending TTL
// 30min 远大于测试时长），不 monkey-patch（规格 §6）。
//
// 运行：node plugin/test/engine-pgate-integration.test.mjs（assert 失败即抛、非零退出；成功自然退出）
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { classifyArtifact, classifyWorkflowScript, ENGINE_RUN_KIND, WORKFLOW_SCRIPT_KIND } from '../src/engine/pgate.js'
import { canonicalPlanHash, createPlanGate, storeStem } from '../src/plan-gate.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- 权威决策矩阵（运行时读，行文不复制；与 test/plan-gate.mjs 同一文件同一 pin）----
const MATRIX_URL = new URL('./fixtures/decision-matrix.json', import.meta.url)
const MATRIX_SHA256_PIN = '20f4ae0b93ae00ac75830fbdf80f99e7656f7c32565e10d3676a53f434b7522c'
const matrix = JSON.parse(readFileSync(MATRIX_URL, 'utf8'))
const rowById = (id) => {
  const row = matrix.rows.find((r) => r.id === id)
  assert.ok(row, `fixture 必须含行 ${id}`)
  return row
}

assert.equal(
  createHash('sha256').update(readFileSync(MATRIX_URL)).digest('hex'),
  MATRIX_SHA256_PIN,
  '同一决策矩阵 fixture 的 sha256 pin 对齐',
)
ok(`同一矩阵 fixture 身份对齐（sha256 ${MATRIX_SHA256_PIN.slice(0, 12)}…，${matrix.rows.length} 行）`)

// ---- 合成世界 ----
const home = mkdtempSync(join(tmpdir(), 'reeve-engine-pgate-'))
const storeDir = join(home, 'store')
const declPath = join(home, 'engine-run.json')
const planPath = join(home, 'plan.md')

const DECL_V1 = {
  kind: ENGINE_RUN_KIND,
  runId: 'run-s9',
  steps: [
    { stepId: 'read', prompt: '第一步：读材料', deps: [] },
    { stepId: 'act', prompt: '第二步：落笔', deps: ['read'] },
  ],
}
const writeDecl = (doc) => writeFileSync(declPath, JSON.stringify(doc, null, 2))
writeDecl(DECL_V1)
const DECL_V1_BYTES = readFileSync(declPath)
const DECL_V1_HASH = createHash('sha256').update(DECL_V1_BYTES).digest('hex')
const DECL_V2 = { ...DECL_V1, runId: 'run-s9-v2' } // 合法但字节不同（TOCTOU 素材）
writeFileSync(planPath, 'plain plan bytes v1\n')

/** createPlanGate 直连（ledger=null → 一切会话皆根；logger 静音）。 */
const makeGate = () =>
  createPlanGate({
    options: { enabled: true, storeDir, planPath },
    ledger: null,
    logger: { debug: () => {} },
    directory: home,
  })

const storeFile = (sessionId) => join(storeDir, `${storeStem(sessionId)}.json`)
const readStoreRaw = (sessionId) => JSON.parse(readFileSync(storeFile(sessionId), 'utf8'))
const step = (id, deps = []) => ({ stepId: id, prompt: `步 ${id}`, deps })

// ═════════════════════════════════════════════════════════════════════════════
// 1. classifyArtifact 纯函数面（kind 判别器 + 声明体校验）
// ═════════════════════════════════════════════════════════════════════════════
{
  const doc = (body) => Buffer.from(JSON.stringify({ kind: ENGINE_RUN_KIND, ...body }))

  assert.deepEqual(classifyArtifact(DECL_V1_BYTES), {
    kind: 'engine-run',
    ok: true,
    declaration: { runId: 'run-s9', stepCount: 2 },
  }, '合法声明 → ok + runId/stepCount')
  assert.deepEqual(classifyArtifact(doc({ runId: 'r', steps: [] })), {
    kind: 'engine-run',
    ok: true,
    declaration: { runId: 'r', stepCount: 0 },
  }, '空 steps 合法（S1：空 run 平凡完成）')
  assert.deepEqual(classifyArtifact(doc({ runId: 'r' })), {
    kind: 'engine-run',
    ok: false,
    errors: ['declaration: 缺失必填字段 "steps"'],
  }, '缺 steps → 报 schema 层原文')
  const cycle = classifyArtifact(doc({ runId: 'r', steps: [step('a', ['b']), step('b', ['a'])] }))
  assert.equal(cycle.kind, 'engine-run')
  assert.equal(cycle.ok, false)
  assert.ok(cycle.errors.some((e) => e.includes('deps 环')), '图性质（环）由 declaration.js 报')

  // kind 是唯一判别器：kind 缺席/别值/大小写不同 → plain（照旧按普通 artifact 接受，不校验）
  assert.deepEqual(classifyArtifact(Buffer.from('plain plan bytes')), { kind: 'plain' }, '非 JSON → plain')
  assert.deepEqual(classifyArtifact(Buffer.from([0xde, 0xad, 0xbe, 0xef])), { kind: 'plain' }, '二进制 → plain')
  assert.deepEqual(classifyArtifact(Buffer.from(JSON.stringify({ runId: 'r', steps: [] }))), { kind: 'plain' }, '无 kind → plain')
  assert.deepEqual(classifyArtifact(Buffer.from(JSON.stringify({ kind: 'engine-run ', runId: 'r', steps: [] }))), { kind: 'plain' }, 'kind 带尾空格 → plain')
  assert.deepEqual(classifyArtifact(Buffer.from(JSON.stringify({ kind: 'ENGINE-RUN', runId: 'r', steps: [] }))), { kind: 'plain' }, 'kind 大小写不同 → plain')
  assert.deepEqual(classifyArtifact(Buffer.from('[1,2]')), { kind: 'plain' }, 'JSON 数组 → plain')
  assert.deepEqual(classifyArtifact(Buffer.from('null')), { kind: 'plain' }, 'JSON null → plain')
  ok('classifyArtifact：kind 判别器（精确匹配）+ 声明体校验 + 一切非 engine-run 字节 → plain')
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. register 接受 kind:"engine-run" 声明文件（review_gate 工具面 + registerSession 直连面）
// ═════════════════════════════════════════════════════════════════════════════
{
  const gate = makeGate()
  const call = async (args, sessionID) => JSON.parse((await gate.tool.execute(args, { sessionID })).output)

  // 合法声明 → 接受：payload 带 artifactKind/declaration，hash 绑文件全字节（含 kind 字段，D1）
  const S_DECL = 'session-s9-decl'
  const reg = await call({ op: 'register', planPath: declPath }, S_DECL)
  assert.equal(reg.ok, true, 'engine-run 声明文件 register 接受')
  assert.equal(reg.op, 'register')
  assert.equal(reg.artifactKind, 'engine-run', 'payload 报 artifactKind=engine-run')
  assert.deepEqual(reg.declaration, { runId: 'run-s9', stepCount: 2 }, 'payload 带 runId/stepCount')
  assert.equal(reg.hash, DECL_V1_HASH, 'hash = 声明文件全字节 sha256（kind 字段在内）')
  assert.equal(reg.hash, canonicalPlanHash(DECL_V1_BYTES), '与 plan-gate 规范哈希同一函数')
  const stored = readStoreRaw(S_DECL)
  assert.deepEqual(
    Object.keys(stored).sort(),
    ['cap', 'parseFailures', 'pending', 'planPath', 'rounds', 'updatedAt', 'verdicts'],
    'store 仍是矩阵 7 字段形状（kind 不落 store，只进 payload）',
  )
  assert.equal(stored.planPath, declPath, 'store 只钉 planPath')

  // 普通方案文件 / 无 kind JSON / kind 别值 → 与旧行为一致：按普通 artifact 接受、零校验
  const noKindPath = join(home, 'no-kind.json')
  writeFileSync(noKindPath, JSON.stringify({ runId: 'r-no-kind', steps: [] }))
  const otherKindPath = join(home, 'other-kind.json')
  writeFileSync(otherKindPath, JSON.stringify({ kind: 'lookalike', runId: 'r', steps: [] }))
  const regPlain = await call({ op: 'register', planPath }, 'session-s9-plain')
  assert.deepEqual(
    [regPlain.ok, regPlain.artifactKind, regPlain.declaration],
    [true, 'artifact', null],
    '普通方案文件 → artifactKind=artifact、declaration=null',
  )
  const regNoKind = await call({ op: 'register', planPath: noKindPath }, 'session-s9-nokind')
  assert.deepEqual([regNoKind.ok, regNoKind.artifactKind], [true, 'artifact'], '无 kind JSON → 普通 artifact')
  const regOther = await call({ op: 'register', planPath: otherKindPath }, 'session-s9-other')
  assert.deepEqual([regOther.ok, regOther.artifactKind], [true, 'artifact'], 'kind 别值 → 普通 artifact')

  // 自称 engine-run 但声明不合法 → 拒绝且零记录（store 文件都不建）
  const invalidCases = [
    { name: 'deps 环', body: { runId: 'r', steps: [step('a', ['b']), step('b', ['a'])] }, match: /deps 环/ },
    { name: '顶层未知字段', body: { runId: 'r', foo: 1, steps: [step('a')] }, match: /未知字段 "foo"/ },
    { name: '缺 steps', body: { runId: 'r' }, match: /缺失必填字段 "steps"/ },
    { name: 'prompt 超长', body: { runId: 'r', steps: [{ stepId: 'a', prompt: 'x'.repeat(8001), deps: [] }] }, match: /超过上限 8000/ },
    { name: '裸 kind（无声明体）', body: {}, match: /缺失必填字段 "runId"/ },
  ]
  for (const [i, c] of invalidCases.entries()) {
    const p = join(home, `invalid-${i}.json`)
    writeFileSync(p, JSON.stringify({ kind: ENGINE_RUN_KIND, ...c.body }))
    const sessionId = `session-s9-bad-${i}`
    const refused = await gate.registerSession(sessionId, p)
    assert.equal(refused.ok, false, `[${c.name}] register 拒绝`)
    assert.match(refused.error, /engine-run declaration invalid/, `[${c.name}] 报错点名声明不合法`)
    assert.match(refused.error, c.match, `[${c.name}] 报错带校验器原文`)
    assert.equal(existsSync(storeFile(sessionId)), false, `[${c.name}] 零记录：store 文件不建`)
  }
  // 工具面同一拒绝（registerSession 的薄包装，语义一致）
  const toolRefused = await call({ op: 'register', planPath: join(home, 'invalid-0.json') }, 'session-s9-bad-tool')
  assert.equal(toolRefused.ok, false, '工具面对不合法声明同样拒绝')
  assert.match(toolRefused.error, /engine-run declaration invalid/)

  // 撕裂 store 优先于声明校验：store 进不去时无论 artifact 是什么都报 torn（矩阵：自动化不重建）
  const S_TORN = 'session-s9-torn'
  writeFileSync(storeFile(S_TORN), '{"planPath":"engine-run.json","pending":{')
  const tornFirst = await gate.registerSession(S_TORN, join(home, 'invalid-0.json'))
  assert.deepEqual([tornFirst.ok, tornFirst.error], [false, 'gate store unreadable; only a human override may rebuild the store'], 'torn 判定先于声明校验')

  ok('register：engine-run 声明接受（全字节哈希 + payload）非法拒绝零记录；kind 外文件照旧普通 artifact；torn 优先')
}

/**
 * 同一门禁回路驱动各场景（模块级——S9 两场景与 M2.4 脚本场景共用）：register → check（无判决）
 * → exec 拦 → 派发 critic → pass 判决 → check → 偷改盘上字节 → check + exec 拦 → 字节恢复 →
 * check。tamper/restore 回调由场景给（各自改各自的 artifact 文件）；registerArgs 供 M2.4 的
 * workflow-script 场景传 { kind: 'workflow-script' }（缺省 = 不带 kind，旧行为）。
 */
const drive = async (sessionId, artifact, { tamper, restore, registerArgs = {} }) => {
  const gate = makeGate()
  const exec = async (args) => JSON.parse((await gate.tool.execute(args, { sessionID: sessionId })).output)
  const out = {}
  out.register = await exec({ op: 'register', planPath: artifact, ...registerArgs })
  out.checkFresh = await exec({ op: 'check' })
  const early = await gate.before({ tool: 'shell', sessionID: sessionId, id: 'x0', input: { command: 'ls' } })
  out.earlyExecMessage = early instanceof Error ? early.message : null

  await gate.before({ tool: 'subagent', sessionID: sessionId, id: 'call-s9', input: { agent: 'critic' } })
  await gate.after({
    tool: 'subagent',
    sessionID: sessionId,
    id: 'call-s9',
    input: { agent: 'critic' },
    status: 'success',
    result: { output: 'Reviewer concludes: pass.\n\n```json\n{"decision":"pass"}\n```' },
  })
  out.storedVerdict = readStoreRaw(sessionId)
  out.checkPass = await exec({ op: 'check' })

  tamper()
  out.checkTampered = await exec({ op: 'check' })
  const blocked = await gate.before({ tool: 'shell', sessionID: sessionId, id: 'x1', input: { command: 'ls' } })
  out.tamperedExecMessage = blocked instanceof Error ? blocked.message : null

  restore()
  out.checkRestored = await exec({ op: 'check' })
  return out
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. check 复用同一决策矩阵：engine-run 与普通方案文件两条场景逐行同矩阵
// ═════════════════════════════════════════════════════════════════════════════
{
  writeDecl(DECL_V1)
  const engineRun = await drive('session-s9-loop-decl', declPath, {
    tamper: () => writeDecl(DECL_V2),
    restore: () => writeDecl(DECL_V1),
  })
  writeFileSync(planPath, 'plain plan bytes v1\n')
  const plain = await drive('session-s9-loop-plain', planPath, {
    tamper: () => writeFileSync(planPath, 'plain plan bytes v2\n'),
    restore: () => writeFileSync(planPath, 'plain plan bytes v1\n'),
  })

  // 登记面差异只在 payload：engine-run 场景的 register 报声明，普通场景报 artifact
  assert.deepEqual([engineRun.register.ok, engineRun.register.artifactKind], [true, 'engine-run'])
  assert.deepEqual([plain.register.ok, plain.register.artifactKind], [true, 'artifact'])

  // 判决绑各自 artifact 的派发时点全字节（D1）
  const PLAN_V1_HASH = canonicalPlanHash(Buffer.from('plain plan bytes v1\n'))
  assert.equal(engineRun.storedVerdict.verdicts[0].hash, DECL_V1_HASH, 'engine-run：判决绑声明文件全字节哈希')
  assert.equal(plain.storedVerdict.verdicts[0].hash, PLAN_V1_HASH, 'plain：判决绑方案文件全字节哈希')
  assert.deepEqual([engineRun.storedVerdict.rounds, Object.keys(engineRun.storedVerdict.pending).length], [1, 0], 'engine-run：rounds=1、pending 消费')

  // 四个 check 时点 × 两场景：期望全部运行时取自同一 fixture（行文不复制）
  const CHECK_ROWS = [
    ['checkFresh', 'gate-check#4'],
    ['checkPass', 'gate-check#10'],
    ['checkTampered', 'gate-check#5'],
    ['checkRestored', 'gate-check#10'],
  ]
  for (const [key, rowId] of CHECK_ROWS) {
    const row = rowById(rowId)
    assert.deepEqual(
      [engineRun[key].decision, engineRun[key].reason],
      [row.expected.decision, row.expected.reason],
      `engine-run 场景 ${rowId} 逐字对齐矩阵`,
    )
    assert.deepEqual(
      [plain[key].decision, plain[key].reason],
      [row.expected.decision, row.expected.reason],
      `plain 场景 ${rowId} 逐字对齐矩阵`,
    )
  }

  // 两场景 decision/reason 全程逐点相等 → 决策面对 artifact 种类无分叉（复用同一矩阵）
  const traceOf = (out) =>
    CHECK_ROWS.map(([key]) => [out[key].transition, out[key].decision, out[key].reason])
  assert.deepEqual(traceOf(engineRun), traceOf(plain), 'engine-run 与 plain 的门禁轨迹逐点相等')

  // exec 拦截文案走同一矩阵行原文（#4 / #5），两场景一致
  assert.ok(engineRun.earlyExecMessage.includes('PLAN-GATE DENY'), '无判决时 exec 被 DENY 拦')
  assert.ok(engineRun.earlyExecMessage.includes(rowById('gate-check#4').expected.reason), '拦截文案带 gate-check#4 原文')
  assert.ok(engineRun.tamperedExecMessage.includes(rowById('gate-check#5').expected.reason), '偷改后拦截文案带 gate-check#5 原文')
  assert.equal(engineRun.tamperedExecMessage, plain.tamperedExecMessage, '两场景拦截文案逐字节相等')

  ok('check 复用同一决策矩阵：#4/#10/#5/#10 四时点 × 两场景逐字对齐 fixture，轨迹与拦截文案逐点相等（零分叉）')
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. M2.4：classifyWorkflowScript 纯函数面（语法门 + 命令字面量扫描）
// ═════════════════════════════════════════════════════════════════════════════
{
  const body = (text) => Buffer.from(text)

  // 合法脚本：语法门过（与 runScript 同一包装 compileScriptBody）+ 命令字面量扫描（去重首见序；
  // 模板字符串/变量命令不可静态捕获——v1 偏差，M2.3 清单）
  const good = classifyWorkflowScript(
    body([
      "F.phase('侦察')",
      'const facts = await F.ask("给个数")',
      "await F.run('node', ['-e', 'console.log(1)'])",
      'await F.run(  "npm" , ["test"])',
      "await F.run('node', ['--version'])",
      "const cmd = 'hidden'",
      'await F.run(cmd)',
      'await F.run(`tpl`)',
      'G.run("not-facade")',
      "return facts",
    ].join('\n')),
  )
  assert.deepEqual(
    [good.kind, good.ok],
    [WORKFLOW_SCRIPT_KIND, true],
    '合法脚本 → ok',
  )
  assert.deepEqual(good.script.commands, ['node', 'npm'], 'commands = F.run 字面量去重首见序（变量/模板/非 facade 不捕获）')

  // 语法门：编译不过 → ok:false（与 runScript 同一包装，语法判定零分叉）
  const badSyntax = classifyWorkflowScript(body('const const const'))
  assert.equal(badSyntax.ok, false, '语法错 → 拒')
  assert.ok(badSyntax.errors[0].includes('workflow-script: 语法不过'), '报错点名 workflow-script 语法门')
  const emptyFile = classifyWorkflowScript(body('  \n\t  '))
  assert.equal(emptyFile.ok, false, '空文件 → 拒')
  assert.ok(emptyFile.errors[0].includes('函数体为空'), '空文件报函数体为空')

  // 跨种类不污染：JSON 声明文本作为脚本 → 语法不过（kind 参数决定判别器，互不串台）
  const jsonAsScript = classifyWorkflowScript(body(JSON.stringify({ kind: ENGINE_RUN_KIND, runId: 'r', steps: [] })))
  assert.equal(jsonAsScript.ok, false, 'JSON 声明文本过不了脚本语法门（kind 由参数显式给，零串台）')

  ok('classifyWorkflowScript：语法门（runScript 同包装）+ commands 扫描（去重首见序、变量/模板/非 facade 不捕获）+ 空文件拒')
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. M2.4：register 接受 kind:"workflow-script"（工具面 + 零记录拒绝 + 旧行为不回归）
// ═════════════════════════════════════════════════════════════════════════════
{
  const gate = makeGate()
  const call = async (args, sessionID) => JSON.parse((await gate.tool.execute(args, { sessionID })).output)

  const SCRIPT_V1 = [
    "F.phase('侦察')",
    'const a = await F.ask("给个数")',
    "await F.run('node', ['-e', 'console.log(1)'])",
    "await F.run('npm', ['test'])",
    "F.log('done')",
    'return a',
  ].join('\n')
  const scriptPath = join(home, 'workflow-script.mjs')
  writeFileSync(scriptPath, SCRIPT_V1)
  const SCRIPT_V1_HASH = canonicalPlanHash(Buffer.from(SCRIPT_V1))

  // 合法脚本 + kind 参数 → 接受：artifactKind/script.commands/declaration=null，哈希绑全字节
  const S_SCRIPT = 'session-m24-script'
  const reg = await call({ op: 'register', planPath: scriptPath, kind: 'workflow-script' }, S_SCRIPT)
  assert.equal(reg.ok, true, 'workflow-script register 接受')
  assert.equal(reg.artifactKind, 'workflow-script', 'payload 报 artifactKind=workflow-script')
  assert.deepEqual(reg.script, { commands: ['node', 'npm'] }, 'payload 带命令字面量扫描（评审面）')
  assert.equal(reg.declaration, null, '脚本不是声明（declaration=null）')
  assert.equal(reg.hash, SCRIPT_V1_HASH, 'hash = 脚本文件全字节 sha256（哈希绑定同声明，D1）')
  const stored = readStoreRaw(S_SCRIPT)
  assert.deepEqual(
    Object.keys(stored).sort(),
    ['cap', 'parseFailures', 'pending', 'planPath', 'rounds', 'updatedAt', 'verdicts'],
    'store 仍是矩阵 7 字段形状（kind 不落 store）',
  )
  assert.equal(stored.planPath, scriptPath, 'store 只钉脚本路径')

  // 不合法脚本 → 拒绝且零记录（store 文件都不建）
  const syntaxErrPath = join(home, 'script-syntax-err.mjs')
  writeFileSync(syntaxErrPath, 'const const const')
  const S_BAD = 'session-m24-bad-syntax'
  const refusedSyntax = await gate.registerSession(S_BAD, syntaxErrPath, 'workflow-script')
  assert.equal(refusedSyntax.ok, false, '语法不过 register 拒绝')
  assert.match(refusedSyntax.error, /workflow-script invalid/, '报错点名 workflow-script invalid')
  assert.match(refusedSyntax.error, /语法不过/, '报错带语法门原文')
  assert.equal(existsSync(storeFile(S_BAD)), false, '零记录：store 文件不建')

  const emptyPath = join(home, 'script-empty.mjs')
  writeFileSync(emptyPath, '')
  const S_EMPTY = 'session-m24-empty'
  const refusedEmpty = await gate.registerSession(S_EMPTY, emptyPath, 'workflow-script')
  assert.equal(refusedEmpty.ok, false, '空脚本文件拒绝')
  assert.match(refusedEmpty.error, /函数体为空/)
  assert.equal(existsSync(storeFile(S_EMPTY)), false, '零记录：store 文件不建')

  // 工具面同一拒绝
  const toolRefused = await call({ op: 'register', planPath: syntaxErrPath, kind: 'workflow-script' }, 'session-m24-bad-tool')
  assert.equal(toolRefused.ok, false, '工具面对不合法脚本同样拒绝')
  assert.match(toolRefused.error, /workflow-script invalid/)

  // kind 参数别值（含把 engine-run 当参数给）→ 拒绝（engine-run 是文件内容判别，不是参数）
  const badKind = await call({ op: 'register', planPath: scriptPath, kind: 'engine-run' }, 'session-m24-bad-kind')
  assert.equal(badKind.ok, false, 'kind="engine-run" 作为参数拒绝（它是文件内容判别器）')
  assert.match(badKind.error, /kind "plan" or "workflow-script"/)
  const badKind2 = await gate.registerSession('session-m24-bad-kind2', scriptPath, 'lookalike')
  assert.equal(badKind2.ok, false, 'kind 别值拒绝')
  assert.equal(existsSync(storeFile('session-m24-bad-kind2')), false, '零记录')

  // 旧行为不回归：不带 kind 登记脚本文件 → 普通 artifact（零校验，S9 前行为）
  const regPlainScript = await call({ op: 'register', planPath: syntaxErrPath }, 'session-m24-plain-script')
  assert.deepEqual([regPlainScript.ok, regPlainScript.artifactKind, regPlainScript.script], [true, 'artifact', null], '缺 kind → 脚本文件照旧按普通 artifact 接受')

  // torn store 优先于脚本校验（矩阵：自动化迁移不重建）
  const S_TORN = 'session-m24-torn'
  writeFileSync(storeFile(S_TORN), '{"planPath":"workflow-script.mjs","pending":{')
  const tornFirst = await gate.registerSession(S_TORN, syntaxErrPath, 'workflow-script')
  assert.deepEqual([tornFirst.ok, tornFirst.error], [false, 'gate store unreadable; only a human override may rebuild the store'], 'torn 判定先于脚本校验')

  ok('register workflow-script：接受（全字节哈希 + commands payload）语法/空文件拒绝零记录；kind 参数别值拒；缺 kind 旧行为；torn 优先')
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. M2.4：workflow-script 场景复用同一决策矩阵（与 engine-run/plain 三方轨迹逐点相等）
// ═════════════════════════════════════════════════════════════════════════════
{
  const SCRIPT_V1 = [
    "F.phase('侦察')",
    'const a = await F.ask("给个数")',
    "await F.run('node', ['-e', 'console.log(1)'])",
    "F.log('done')",
    'return a',
  ].join('\n')
  const SCRIPT_V2 = SCRIPT_V1.replace("'done'", "'done-v2'") // 合法脚本、字节不同（TOCTOU 素材）
  const scriptPath = join(home, 'workflow-script-loop.mjs')
  const writeScript = (text) => writeFileSync(scriptPath, text)

  writeScript(SCRIPT_V1)
  writeDecl(DECL_V1)
  // 三场景全部用本块专属的新 sessionId——block 3 已给 s9-loop-* 留下带 pass 判决的 store，
  // 复用会话会让 checkFresh 读到旧判决（gate-check#10 而非 #4），破坏「fresh 起点」的对齐。
  const engineRun = await drive('session-m24-loop-decl', declPath, {
    tamper: () => writeDecl(DECL_V2),
    restore: () => writeDecl(DECL_V1),
  })
  writeFileSync(planPath, 'plain plan bytes v1\n')
  const plain = await drive('session-m24-loop-plain', planPath, {
    tamper: () => writeFileSync(planPath, 'plain plan bytes v2\n'),
    restore: () => writeFileSync(planPath, 'plain plan bytes v1\n'),
  })
  const scriptScene = await drive('session-m24-loop-script', scriptPath, {
    registerArgs: { kind: 'workflow-script' },
    tamper: () => writeScript(SCRIPT_V2),
    restore: () => writeScript(SCRIPT_V1),
  })

  // 登记面差异只在 payload；判决绑各自 artifact 的派发时点全字节（D1——脚本同轨）
  assert.deepEqual([scriptScene.register.ok, scriptScene.register.artifactKind], [true, 'workflow-script'])
  assert.deepEqual(scriptScene.register.script.commands, ['node'], '脚本场景 commands 进评审面')
  assert.equal(scriptScene.storedVerdict.verdicts[0].hash, canonicalPlanHash(Buffer.from(SCRIPT_V1)), '判决绑脚本文件全字节哈希')
  assert.deepEqual([scriptScene.storedVerdict.rounds, Object.keys(scriptScene.storedVerdict.pending).length], [1, 0], '脚本场景 rounds=1、pending 消费')

  // 四个 check 时点 × 三场景：期望全部运行时取自同一 fixture（行文不复制）
  const CHECK_ROWS = [
    ['checkFresh', 'gate-check#4'],
    ['checkPass', 'gate-check#10'],
    ['checkTampered', 'gate-check#5'],
    ['checkRestored', 'gate-check#10'],
  ]
  for (const [key, rowId] of CHECK_ROWS) {
    const row = rowById(rowId)
    for (const [label, scene] of [['engine-run', engineRun], ['plain', plain], ['workflow-script', scriptScene]]) {
      assert.deepEqual(
        [scene[key].decision, scene[key].reason],
        [row.expected.decision, row.expected.reason],
        `${label} 场景 ${rowId} 逐字对齐矩阵`,
      )
    }
  }

  // 三场景 decision/reason 全程逐点相等 → 决策面对 artifact 种类无分叉（复用同一矩阵）
  const traceOf = (out) => CHECK_ROWS.map(([key]) => [out[key].transition, out[key].decision, out[key].reason])
  assert.deepEqual(traceOf(engineRun), traceOf(plain), 'engine-run 与 plain 的门禁轨迹逐点相等')
  assert.deepEqual(traceOf(engineRun), traceOf(scriptScene), 'engine-run 与 workflow-script 的门禁轨迹逐点相等（M2.4 零分叉）')

  // exec 拦截文案走同一矩阵行原文（#4 / #5），三场景一致
  assert.ok(scriptScene.earlyExecMessage.includes('PLAN-GATE DENY'), '脚本场景无判决时 exec 被 DENY 拦')
  assert.ok(scriptScene.earlyExecMessage.includes(rowById('gate-check#4').expected.reason), '拦截文案带 gate-check#4 原文')
  assert.ok(scriptScene.tamperedExecMessage.includes(rowById('gate-check#5').expected.reason), '偷改脚本后拦截文案带 gate-check#5 原文')
  assert.equal(scriptScene.tamperedExecMessage, plain.tamperedExecMessage, '脚本与 plain 拦截文案逐字节相等')

  ok('M2.4 同矩阵回路：workflow-script 场景 #4/#10/#5/#10 四时点三方逐字对齐 fixture，判决绑脚本全字节、偷改走 #5（TOCTOU 同轨）')
}

rmSync(home, { recursive: true, force: true })
console.log(`\n结果：${passed} 通过 / 0 失败`)
