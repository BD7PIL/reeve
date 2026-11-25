// E1 引擎声明校验器 T3.1（施工规格 .zcode/plans/e1-construction-spec.md §4-S1 / §5-T3.1）。
//
// 表驱动内联：矩阵行 = 缺依赖（缺 deps 字段 / deps 指向不存在的 stepId）/ 环 / 自指 /
// 重复 stepId / 未知字段（顶层·步级·model 三层）/ 超长 prompt / 数值边界
// （maxAttempts 整数 ≥1、timeoutMs 整数 ≥1000、prompt 非空 ≤8000）/ model 编码
// {providerID, id, variant?}。夹具全合成（无 fixtures 引用；replay 录制件属 S7a，前序不得引用）。
//
// 期望逐行来自规格矩阵；实现与规格冲突时改实现，不改这里的期望。
// 另有一节把规格数字（8000 / 1 / 1000 / 默认 3 / 默认 900000）钉在 schema 上，
// 并用动态长度行证明校验器确实从 schema 取约束（依赖方向 declaration.js ← schema）。
//
// 运行：node plugin/test/engine-declaration.test.mjs（assert 失败即抛、非零退出；成功自然退出）
import assert from 'node:assert/strict'

import { DECLARATION_DEFAULTS, DECLARATION_FIELDS, DECLARATION_SCHEMA, STEP_FIELDS, isEngineOutputsPath, nearestStepId, validateDeclaration, validateStep, validateValue } from '../src/engine/declaration.js'

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

// ---- 有效声明基座（全合成；按需变异）----
const PROMPT_MAX = DECLARATION_SCHEMA.properties.steps.items.properties.prompt.maxLength

const base = () => ({
  runId: 'run-t31',
  steps: [
    { stepId: 'read', prompt: '第一步：读材料', deps: [] },
    {
      stepId: 'critic',
      prompt: '第二步：出判词',
      deps: ['read'],
      agent: 'reeve-critic',
      model: { providerID: 'zhipuai', id: 'glm-5.3', variant: 'role-critic' },
      maxAttempts: 3,
      timeoutMs: 900_000,
    },
    { stepId: 'write', prompt: '第三步：落笔', deps: ['read', 'critic'], schema: { type: 'object' } },
  ],
})

const mutate = (fn) => () => {
  const d = base()
  fn(d)
  return d
}

// ---- T3.1 矩阵（表驱动内联：期望逐行来自规格）----
const CASES = [
  // —— 通过行 ——
  { name: '通过：全字段有效声明', accept: true, make: base },
  {
    name: '通过：最小声明（每步只有 stepId/prompt/deps）',
    accept: true,
    make: () => ({ runId: 'r', steps: [{ stepId: 'only', prompt: 'p', deps: [] }] }),
  },
  { name: '通过：model 无 variant（可选）', accept: true, make: mutate((d) => { delete d.steps[1].model.variant }) },
  { name: '通过：空 steps 数组（空 run 平凡完成）', accept: true, make: mutate((d) => { d.steps = [] }) },
  { name: '通过：prompt 恰 8000 字符（上限边界）', accept: true, make: mutate((d) => { d.steps[0].prompt = 'x'.repeat(PROMPT_MAX) }) },
  { name: '通过：maxAttempts=1（下界边界）', accept: true, make: mutate((d) => { d.steps[1].maxAttempts = 1 }) },
  { name: '通过：timeoutMs=1000（下界边界）', accept: true, make: mutate((d) => { d.steps[2].timeoutMs = 1000 }) },

  // —— 缺依赖 ——
  { name: '拒绝：缺 deps 字段', make: mutate((d) => { delete d.steps[0].deps }), match: [/steps\[0\]: 缺失必填字段 "deps"/] },
  { name: '拒绝：deps 指向不存在的 stepId', make: mutate((d) => { d.steps[2].deps.push('ghost') }), match: [/deps\[2\]: 未知引用 "ghost"/] },
  { name: '拒绝：deps 非数组', make: mutate((d) => { d.steps[0].deps = 'read' }), match: [/steps\[0\].deps: 必须是数组（得到 string）/] },
  { name: '拒绝：deps 元素非字符串', make: mutate((d) => { d.steps[0].deps = [42] }), match: [/steps\[0\].deps\[0\]: 必须是字符串（得到 number）/] },

  // —— 环 / 自指 ——
  { name: '拒绝：两步环 a→b→a', make: () => ({ runId: 'r', steps: [{ stepId: 'a', prompt: 'p', deps: ['b'] }, { stepId: 'b', prompt: 'p', deps: ['a'] }] }), match: [/deps 环 a → b → a/] },
  {
    name: '拒绝：三步环 a→b→c→a',
    make: () => ({
      runId: 'r',
      steps: [
        { stepId: 'a', prompt: 'p', deps: ['b'] },
        { stepId: 'b', prompt: 'p', deps: ['c'] },
        { stepId: 'c', prompt: 'p', deps: ['a'] },
      ],
    }),
    match: [/deps 环 a → b → c → a/],
  },
  { name: '拒绝：自指（deps 含自己）', make: mutate((d) => { d.steps[0].deps = ['read'] }), match: [/steps\[0\].deps\[0\]: 自引用 "read"/] },

  // —— 重复 stepId ——
  {
    name: '拒绝：重复 stepId（三处同名，逐处报）',
    make: () => ({ runId: 'r', steps: [{ stepId: 'dup', prompt: 'p', deps: [] }, { stepId: 'dup', prompt: 'p', deps: [] }, { stepId: 'dup', prompt: 'p', deps: [] }] }),
    match: [/steps\[1\].stepId: 重复 "dup"/, /steps\[2\].stepId: 重复 "dup"/],
  },

  // —— 未知字段（三层 additionalProperties:false）——
  { name: '拒绝：顶层未知字段', make: mutate((d) => { d.tier = 'pro' }), match: [/declaration: 未知字段 "tier"/, /允许：runId, steps/] },
  { name: '拒绝：步级未知字段', make: mutate((d) => { d.steps[1].when = 'now' }), match: [/steps\[1\]: 未知字段 "when"/] },
  { name: '拒绝：model 未知字段', make: mutate((d) => { d.steps[1].model.temperature = 0.7 }), match: [/steps\[1\].model: 未知字段 "temperature"/] },

  // —— 超长 prompt / 非空 ——
  { name: '拒绝：prompt 超 8000 字符', make: mutate((d) => { d.steps[0].prompt = 'x'.repeat(PROMPT_MAX + 1) }), match: [/长度 8001 超过上限 8000/] },
  { name: '拒绝：prompt 空串', make: mutate((d) => { d.steps[0].prompt = '' }), match: [/steps\[0\].prompt: 不能为空/] },
  { name: '拒绝：prompt 非字符串', make: mutate((d) => { d.steps[0].prompt = 123 }), match: [/steps\[0\].prompt: 必须是字符串（得到 number）/] },

  // —— 数值边界（maxAttempts 整数 ≥1；timeoutMs 整数 ≥1000）——
  { name: '拒绝：maxAttempts=0（低于下界）', make: mutate((d) => { d.steps[1].maxAttempts = 0 }), match: [/maxAttempts: 必须 ≥ 1（得到 0）/] },
  { name: '拒绝：maxAttempts=1.5（非整数）', make: mutate((d) => { d.steps[1].maxAttempts = 1.5 }), match: [/maxAttempts: 必须是整数（得到 1\.5）/] },
  { name: '拒绝：maxAttempts 字符串（类型不符）', make: mutate((d) => { d.steps[1].maxAttempts = '3' }), match: [/maxAttempts: 必须是整数（得到 string）/] },
  { name: '拒绝：timeoutMs=999（低于下界）', make: mutate((d) => { d.steps[2].timeoutMs = 999 }), match: [/timeoutMs: 必须 ≥ 1000（得到 999）/] },
  { name: '拒绝：timeoutMs=999.5（非整数）', make: mutate((d) => { d.steps[2].timeoutMs = 999.5 }), match: [/timeoutMs: 必须是整数（得到 999\.5）/] },

  // —— model 编码 {providerID, id, variant?} ——
  { name: '拒绝：model 缺 providerID', make: mutate((d) => { d.steps[1].model = { id: 'glm-5.3' } }), match: [/steps\[1\].model: 缺失必填字段 "providerID"/] },
  { name: '拒绝：model 缺 id', make: mutate((d) => { d.steps[1].model = { providerID: 'zhipuai' } }), match: [/steps\[1\].model: 缺失必填字段 "id"/] },
  { name: '拒绝：model 非对象', make: mutate((d) => { d.steps[1].model = 42 }), match: [/steps\[1\].model: 必须是对象（得到 number）/] },
  { name: '拒绝：model.providerID 非字符串', make: mutate((d) => { d.steps[1].model.providerID = 7 }), match: [/model\.providerID: 必须是字符串（得到 number）/] },
  { name: '拒绝：model.variant null（可选但出现必须合法）', make: mutate((d) => { d.steps[1].model.variant = null }), match: [/model\.variant: 必须是字符串（得到 null）/] },

  // —— Q5 三字段：description（顶层+步级）/ metadata（string→string）——
  {
    name: '通过：description/metadata 全挂（顶层+步级）',
    accept: true,
    make: () => ({
      runId: 'r',
      description: '三步导读计划',
      metadata: { owner: 'bd7pil', tier: 'pilot' },
      steps: [{ stepId: 'a', prompt: 'p', deps: [], description: '读材料', metadata: { lane: 'io' } }],
    }),
  },
  { name: '通过：metadata 空对象（可选键挂了但没内容）', accept: true, make: mutate((d) => { d.steps[0].metadata = {} }) },
  { name: '拒绝：顶层 description 非字符串', make: mutate((d) => { d.description = 42 }), match: [/^description: 必须是字符串（得到 number）$/] },
  { name: '拒绝：顶层 description 空串', make: mutate((d) => { d.description = '' }), match: [/^description: 不能为空$/] },
  {
    name: '拒绝：步级 description 越界（200+1）',
    make: mutate((d) => { d.steps[1].description = 'x'.repeat(201) }),
    match: [/steps\[1\]\.description: 长度 201 超过上限 200/],
  },
  { name: '拒绝：metadata 非对象（数组）', make: mutate((d) => { d.steps[0].metadata = ['x'] }), match: [/steps\[0\]\.metadata: 必须是对象（得到 array）/] },
  { name: '拒绝：metadata 值非字符串（数值）', make: mutate((d) => { d.metadata = { depth: 3 } }), match: [/^metadata\.depth: 必须是字符串（得到 number）$/] },
  { name: '拒绝：metadata 值非字符串（嵌套对象）', make: mutate((d) => { d.steps[0].metadata = { lane: { deep: true } } }), match: [/steps\[0\]\.metadata\.lane: 必须是字符串（得到 object）/] },

  // —— 结构垃圾（校验器不抛，返形状良好的结果）——
  { name: '拒绝：声明为 null', make: () => null, match: [/declaration: 必须是对象（得到 null）/] },
  { name: '拒绝：声明为 undefined', make: () => undefined, match: [/declaration: 必须是对象（得到 undefined）/] },
  { name: '拒绝：声明为字符串', make: () => 'nope', match: [/declaration: 必须是对象（得到 string）/] },
  { name: '拒绝：声明为数组', make: () => [], match: [/declaration: 必须是对象（得到 array）/] },
  { name: '拒绝：声明为数值', make: () => 42, match: [/declaration: 必须是对象（得到 number）/] },
  { name: '拒绝：steps 非数组', make: mutate((d) => { d.steps = {} }), match: [/steps: 必须是数组（得到 object）/] },
  { name: '拒绝：steps 元素非对象', make: mutate((d) => { d.steps[1] = 42 }), match: [/steps\[1\]: 必须是对象（得到 number）/] },
  { name: '拒绝：缺 runId', make: mutate((d) => { delete d.runId }), match: [/declaration: 缺失必填字段 "runId"/] },
  { name: '拒绝：缺 steps', make: mutate((d) => { delete d.steps }), match: [/declaration: 缺失必填字段 "steps"/] },
  { name: '拒绝：缺 stepId', make: mutate((d) => { delete d.steps[0].stepId }), match: [/steps\[0\]: 缺失必填字段 "stepId"/] },
  { name: '拒绝：缺 prompt', make: mutate((d) => { delete d.steps[0].prompt }), match: [/steps\[0\]: 缺失必填字段 "prompt"/] },

  // —— 累积（一次报全，不首错即停）——
  {
    name: '拒绝：五处错误一次报全（缺失/空串/未知字段/数值/未知引用）',
    make: () => ({
      steps: [
        { stepId: 's0', prompt: '', deps: [] },
        { stepId: 's1', prompt: 'p', deps: ['ghost'], when: 'now', maxAttempts: 0 },
      ],
    }),
    match: [
      /declaration: 缺失必填字段 "runId"/,
      /steps\[0\].prompt: 不能为空/,
      /steps\[1\]: 未知字段 "when"/,
      /steps\[1\].maxAttempts: 必须 ≥ 1（得到 0）/,
      /steps\[1\].deps\[0\]: 未知引用 "ghost"/,
    ],
  },
]

// ---- 1. 表驱动逐行 ----
console.log('T3.1 矩阵（表驱动内联）')
let multiErrorRow = null
for (const c of CASES) {
  const r = validateDeclaration(c.make())
  const joined = r.errors.join('\n')
  assert.ok(r.errors.every((e) => typeof e === 'string'), `${c.name}：errors 应全为字符串`)
  assert.equal(r.ok, r.errors.length === 0, `${c.name}：ok 必须等于 (errors.length === 0)`)
  if (c.accept) {
    assert.equal(r.ok, true, `${c.name}：应通过，却拒绝：\n${joined}`)
    assert.deepEqual(r.errors, [], `${c.name}：通过时 errors 应为空`)
  } else {
    assert.equal(r.ok, false, `${c.name}：应拒绝，却通过`)
    assert.ok(r.errors.length > 0, `${c.name}：拒绝时 errors 不应为空`)
    for (const re of c.match) assert.ok(r.errors.some((e) => re.test(e)), `${c.name}：错误里找不到 ${re}\n实际：\n${joined}`)
  }
  if (c.name.includes('五处错误')) {
    assert.equal(r.errors.length, 5, `${c.name}：应恰好 5 条（累积且无多余），实际 ${r.errors.length}：\n${joined}`)
    multiErrorRow = r
  }
  ok(c.name)
}
ok(`矩阵 ${CASES.length} 行全过${multiErrorRow ? '（含 5 错累积行）' : ''}`)

// ---- 2. 重复 stepId 报告计数（首见不报、其后逐处报）----
{
  const decl = { runId: 'r', steps: [{ stepId: 'dup', prompt: 'p', deps: [] }, { stepId: 'dup', prompt: 'p', deps: ['dup'] }, { stepId: 'dup', prompt: 'p', deps: [] }] }
  const r = validateDeclaration(decl)
  assert.equal(r.ok, false, '重复 stepId 必须拒')
  const dupErrors = r.errors.filter((e) => e.includes('重复 "dup"'))
  assert.equal(dupErrors.length, 2, `首见 steps[0] 不报，其后各报一条；实际：\n${r.errors.join('\n')}`)
  assert.ok(r.errors.some((e) => e.includes('steps[1].stepId')), `报错应指向重复出现的下标：\n${r.errors.join('\n')}`)
  ok('重复 stepId：首见不报、其后逐处报（2 条）')
}

// ---- 3. 规格数字钉在 schema 上（依赖方向 declaration.js ← schema 的证据）----
{
  const stepProps = DECLARATION_SCHEMA.properties.steps.items.properties
  assert.equal(stepProps.prompt.maxLength, 8000, '规格 §3：prompt ≤ 8000 字符')
  assert.equal(stepProps.prompt.minLength, 1, '规格 §3：prompt 非空')
  assert.equal(stepProps.maxAttempts.type, 'integer', 'maxAttempts 必须整数')
  assert.equal(stepProps.maxAttempts.minimum, 1, '规格 §3：maxAttempts ≥ 1')
  assert.equal(stepProps.maxAttempts.default, 3, 'maxAttempts 默认 3（含初派的总尝试上限）')
  assert.equal(stepProps.timeoutMs.type, 'integer', 'timeoutMs 必须整数')
  assert.equal(stepProps.timeoutMs.minimum, 1000, '规格 §3：timeoutMs ≥ 1000')
  assert.equal(stepProps.timeoutMs.default, 900000, 'timeoutMs 默认 900000')
  assert.deepEqual(DECLARATION_DEFAULTS, { maxAttempts: 3, timeoutMs: 900000 }, 'DECLARATION_DEFAULTS 从 schema 取默认值')
  assert.deepEqual([...DECLARATION_FIELDS], ['runId', 'steps', 'description', 'metadata'], '顶层允许字段（Q5 增 description/metadata）')
  assert.deepEqual([...STEP_FIELDS], ['stepId', 'prompt', 'deps', 'schema', 'outputs', 'agent', 'model', 'maxAttempts', 'timeoutMs', 'description', 'metadata'], '步级允许字段（P1.2 增 outputs；Q5 增 description/metadata）')
  // 动态长度行：约束真从 schema 读——改 schema 上限，校验器跟着走。
  const long = { runId: 'r', steps: [{ stepId: 'a', prompt: 'x'.repeat(stepProps.prompt.maxLength), deps: [] }] }
  assert.equal(validateDeclaration(long).ok, true, `长度恰为 schema 上限（${stepProps.prompt.maxLength}）应通过`)
  const tooLong = { runId: 'r', steps: [{ stepId: 'a', prompt: 'x'.repeat(stepProps.prompt.maxLength + 1), deps: [] }] }
  const r = validateDeclaration(tooLong)
  assert.equal(r.ok, false, `超过 schema 上限（${stepProps.prompt.maxLength + 1}）应拒绝`)
  assert.ok(r.errors.some((e) => e.includes(`超过上限 ${stepProps.prompt.maxLength}`)), `报错应引用 schema 上限：\n${r.errors.join('\n')}`)
  // 未知字段的"允许"清单与导出常量一致。
  const stray = validateDeclaration({ runId: 'r', steps: [{ stepId: 'a', prompt: 'p', deps: [], oops: 1 }] })
  assert.ok(stray.errors.some((e) => e.includes(`允许：${[...STEP_FIELDS].join(', ')}`)), `未知字段报错应列出步级允许字段：\n${stray.errors.join('\n')}`)
  ok('规格数字钉在 schema；校验器约束动态取自 schema（8000/1/1000/默认 3/900000）')
}

// ---- 4. P1.2 outputs 字段（类型/项数 schema 层；路径形式判据在 declaration.js 代码——单一事实来源）----
{
  // 通过行：四类形式全收（盘符正斜杠/盘符反斜杠/UNC/POSIX 根/home 相对）+ 恰 8 项边界。
  const allForms = ['C:/out/a.json', 'C:\\out\\b.json', '//srv/share/c.json', '/abs/posix/d.json', '~/home/e.json']
  const passDecl = { runId: 'r', steps: [{ stepId: 'a', prompt: 'p', deps: [], outputs: allForms }] }
  assert.equal(validateDeclaration(passDecl).ok, true, `四类路径形式全收：\n${JSON.stringify(passDecl)}`)
  const eight = Array.from({ length: 8 }, (_, i) => `/out/f${i}.json`)
  assert.equal(validateDeclaration({ runId: 'r', steps: [{ stepId: 'a', prompt: 'p', deps: [], outputs: eight }] }).ok, true, '恰 8 项（上限边界）')
  assert.equal(validateDeclaration({ runId: 'r', steps: [{ stepId: 'a', prompt: 'p', deps: [], outputs: ['/one.json'] }] }).ok, true, '恰 1 项（下界边界）')
  // 单步面（validateStep 同一判据；报错前缀 step）。
  const stepVerdict = validateStep({ stepId: 'a', prompt: 'p', deps: [], outputs: ['/abs/x.json'] })
  assert.equal(stepVerdict.ok, true, 'validateStep：绝对路径通过')
  const stepBad = validateStep({ stepId: 'a', prompt: 'p', deps: [], outputs: ['rel.json'] })
  assert.equal(stepBad.ok, false, 'validateStep：相对路径拒')
  assert.ok(stepBad.errors.some((e) => e.startsWith('step.outputs[0]:')), `单步报错前缀 step：\n${stepBad.errors.join('\n')}`)
  // 越界：0 项 / 9 项（walkSchema 无 minItems/maxItems，项数由代码报）。
  const zero = validateDeclaration({ runId: 'r', steps: [{ stepId: 'a', prompt: 'p', deps: [], outputs: [] }] })
  assert.ok(zero.errors.some((e) => e.includes('steps[0].outputs: 项数必须 1-8（得到 0）')), `0 项报错：\n${zero.errors.join('\n')}`)
  const nine = validateDeclaration({ runId: 'r', steps: [{ stepId: 'a', prompt: 'p', deps: [], outputs: Array.from({ length: 9 }, (_, i) => `/f${i}.json`) }] })
  assert.ok(nine.errors.some((e) => e.includes('steps[0].outputs: 项数必须 1-8（得到 9）')), `9 项报错：\n${nine.errors.join('\n')}`)
  // 类型错：非数组 / 元素非字符串 / 空串（schema 层 minLength）。
  const notArr = validateDeclaration({ runId: 'r', steps: [{ stepId: 'a', prompt: 'p', deps: [], outputs: '/one.json' }] })
  assert.ok(notArr.errors.some((e) => e.includes('steps[0].outputs: 必须是数组（得到 string）')), `非数组报错：\n${notArr.errors.join('\n')}`)
  const notStr = validateDeclaration({ runId: 'r', steps: [{ stepId: 'a', prompt: 'p', deps: [], outputs: [42] }] })
  assert.ok(notStr.errors.some((e) => e.includes('steps[0].outputs[0]: 必须是字符串（得到 number）')), `元素非字符串：\n${notStr.errors.join('\n')}`)
  const empty = validateDeclaration({ runId: 'r', steps: [{ stepId: 'a', prompt: 'p', deps: [], outputs: [''] }] })
  assert.ok(empty.errors.some((e) => e.includes('steps[0].outputs[0]: 不能为空')), `空串报 schema minLength：\n${empty.errors.join('\n')}`)
  // 形式拒：相对路径与其余一切形式（~user、file://、盘符无分隔等）——逐形式断言判据函数与报错。
  const rejects = ['rel.json', './rel.json', '../up.json', '~user/x.json', 'file:///x.json', 'C: noslash.json', ' out/x.json']
  for (const p of rejects) {
    assert.equal(isEngineOutputsPath(p), false, `判据拒形式：${JSON.stringify(p)}`)
    const v = validateDeclaration({ runId: 'r', steps: [{ stepId: 'a', prompt: 'p', deps: [], outputs: ['/ok.json', p] }] })
    assert.equal(v.ok, false, `声明含形式 ${JSON.stringify(p)} 必须拒`)
    assert.ok(
      v.errors.some((e) => e.includes(`steps[0].outputs[1]: 必须是绝对路径或 ~/ 前缀`)),
      `形式 ${JSON.stringify(p)} 报错指到逐项下标：\n${v.errors.join('\n')}`,
    )
  }
  // 逐形式接受面（判据函数直测）。
  for (const p of allForms) assert.equal(isEngineOutputsPath(p), true, `判据收形式：${JSON.stringify(p)}`)
  // schema 文件带 outputs 约束（1-8 项、元素字符串）——声明面与 schema 注释互指的落点核对。
  const node = DECLARATION_SCHEMA.properties.steps.items.properties.outputs
  assert.deepEqual([node.type, node.minItems, node.maxItems], ['array', 1, 8], 'schema outputs 1-8 项')
  assert.equal(node.items.type, 'string', 'schema outputs 元素字符串')
  ok('P1.2 outputs：四类形式收（盘符/UNC/POSIX 根/~/）+ 1-8 项边界 + 类型/空串 schema 层报 + 相对路径与其余形式逐项拒 + validateStep 同判据')
}

// ---- 5. Q1 Did-you-mean：deps 未知引用报错附最近候选（纯函数 nearestStepId）----
{
  // 错拼 → 候选正确（deps 消费场景；消息形如「未知引用 "betaa"（……——最近候选 "beta"？）」）。
  const typo = validateDeclaration({
    runId: 'r',
    steps: [
      { stepId: 'alpha', prompt: 'p', deps: [] },
      { stepId: 'beta', prompt: 'p', deps: ['betaa'] },
    ],
  })
  assert.equal(typo.ok, false, '错拼声明必须拒')
  assert.ok(
    typo.errors.some((e) => e.includes(`steps[1].deps[0]: 未知引用 "betaa"（不在任何 stepId 里——最近候选 "beta"？）`)),
    `错拼→候选正确：\n${typo.errors.join('\n')}`,
  )
  // 无近邻 → 不附（报错保持旧形状——防无关建议噪声）。
  const far = validateDeclaration({
    runId: 'r',
    steps: [
      { stepId: 'alpha', prompt: 'p', deps: ['zzzzzzzz'] },
    ],
  })
  assert.equal(far.ok, false, '无近邻声明必须拒')
  assert.ok(
    far.errors.some((e) => e === 'steps[0].deps[0]: 未知引用 "zzzzzzzz"（不在任何 stepId 里）'),
    `无近邻→不附（逐字符旧形状）：\n${far.errors.join('\n')}`,
  )
  // 正确声明零影响：全对声明零报错（矩阵通过行的同口径重复断言，钉住「建议逻辑不误伤」）。
  assert.deepEqual(validateDeclaration(base()).errors, [], '正确声明零影响（errors 逐项为空）')
  // 纯函数面：算法三要素（最小距离 / 并列字典序首 / max(2, ⌈len/2⌉) 阈值）。
  assert.equal(nearestStepId('betaa', ['alpha', 'beta']), 'beta', '最小距离候选')
  assert.equal(nearestStepId('aab', ['aad', 'aac', 'caa', 'zzz']), 'aac', '并列距离取字典序首（aac/aad 均 d=1 → aac）')
  assert.equal(nearestStepId('abcd', ['abxy']), 'abxy', '距离恰等于阈值（len 4 → 阈值 2，d=2）仍附')
  assert.equal(nearestStepId('abcd', ['axyz']), null, '距离超阈值 1（d=3 > 2）不附')
  assert.equal(nearestStepId('a', ['x']), 'x', '短串阈值下限 2（len 1 → max(2, 1)），d=2 仍附')
  assert.equal(nearestStepId('ghost', ['read', 'critic', 'write']), null, '阈值外整簇不附（矩阵 ghost 行同口径）')
  assert.equal(nearestStepId('step.1', ['step1', 'step2']), 'step1', '含点号 stepId 同获候选（R.1 词法/引用三查消费面就绪）')
  assert.equal(nearestStepId('betaa', []), null, '候选空 → null')
  assert.equal(nearestStepId('betaa', [42, null, 'beta']), 'beta', '候选非字符串逐项跳过')
  assert.equal(nearestStepId('', ['beta']), null, '未知串空 → null')
  assert.equal(nearestStepId(42, ['beta']), null, '未知串非字符串 → null（纯函数不抛）')
  ok('Q1 Did-you-mean：错拼→候选正确 / 无近邻→不附 / 字典序并列 / 阈值 max(2,⌈len/2⌉) 边界 / 含点号候选面就绪 / 正确声明零影响')
}

// ---- 6. Q5 三字段细节：metadata 经 schema additionalProperties 逐键校验（walkSchema 扩展面）----
{
  const stepProps = DECLARATION_SCHEMA.properties.steps.items.properties
  // schema 是约束的单一事实来源：description 上限从 schema 读，校验器跟着走。
  assert.equal(stepProps.description.maxLength, 200, '步级 description 上限 200')
  assert.equal(DECLARATION_SCHEMA.properties.description.maxLength, 200, '顶层 description 上限 200')
  assert.equal(stepProps.metadata.additionalProperties.type, 'string', 'metadata 值域 string→string（schema 层）')
  // additionalProperties-as-schema 真的在校验（不是静默放行）：非字符串值逐键报、键名进报错 path。
  const badValue = validateDeclaration({ runId: 'r', steps: [{ stepId: 'a', prompt: 'p', deps: [], metadata: { k1: 'ok', k2: 9 } }] })
  assert.equal(badValue.ok, false, 'metadata 混合值域必须拒')
  assert.ok(
    badValue.errors.some((e) => e === 'steps[0].metadata.k2: 必须是字符串（得到 number）'),
    `逐键校验且只报坏键：\n${badValue.errors.join('\n')}`,
  )
  assert.equal(badValue.errors.length, 1, `好键 k1 零报错（只报坏键一条）：\n${badValue.errors.join('\n')}`)
  // validateStep / validateValue 同一 walkSchema 子集：单步面同判据；用户 schema 的 additionalProperties 同样生效。
  const stepVerdict = validateStep({ stepId: 'a', prompt: 'p', deps: [], metadata: { x: 1 } })
  assert.ok(stepVerdict.errors.some((e) => e === 'step.metadata.x: 必须是字符串（得到 number）'), `validateStep 同判据：\n${stepVerdict.errors.join('\n')}`)
  const userSchema = { type: 'object', additionalProperties: { type: 'integer' } }
  const valueOk = validateValue({ n: 3 }, userSchema)
  const valueBad = validateValue({ n: 'x' }, userSchema)
  assert.equal(valueOk.ok, true, 'validateValue：additionalProperties-as-schema 合法值放行')
  assert.ok(valueBad.errors.some((e) => e.includes('n: 必须是整数（得到 string）')), `validateValue：additionalProperties-as-schema 坏值报（用户 schema 面）：\n${valueBad.errors.join('\n')}`)
  // additionalProperties: true / 缺省仍放行（walkSchema 扩展不收紧旧面）。
  assert.equal(validateValue({ anything: [1, 2] }, { type: 'object', additionalProperties: true }).ok, true, 'additionalProperties: true 放行')
  assert.equal(validateValue({ anything: 1 }, { type: 'object' }).ok, true, '无 additionalProperties 声明放行')
  ok('Q5：description/metadata 三态（合法/类型错/越界）+ metadata 逐键校验只报坏键 + validateStep/validateValue 同子集')
}

console.log(`\n引擎声明校验测试（T3.1）：${passed} 项全过`)
