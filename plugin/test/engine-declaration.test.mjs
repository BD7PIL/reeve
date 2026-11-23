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

import { DECLARATION_DEFAULTS, DECLARATION_FIELDS, DECLARATION_SCHEMA, STEP_FIELDS, validateDeclaration } from '../src/engine/declaration.js'

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
  assert.deepEqual([...DECLARATION_FIELDS], ['runId', 'steps'], '顶层允许字段')
  assert.deepEqual([...STEP_FIELDS], ['stepId', 'prompt', 'deps', 'schema', 'agent', 'model', 'maxAttempts', 'timeoutMs'], '步级允许字段')
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

console.log(`\n引擎声明校验测试（T3.1）：${passed} 项全过`)
