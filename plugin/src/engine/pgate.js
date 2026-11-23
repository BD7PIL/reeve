// E1 引擎 × plan-gate 集成（S9；施工规格 .zcode/plans/e1-construction-spec.md §3 / §8-S9）。
//
// 职责单一：识别「自称 engine-run 的 artifact 文件」并校验其声明体（M2.4 起，再加 workflow-script
// 脚本文件的登记判别）。classifyArtifact(bytes) 把文件字节分类为 plain artifact 或 engine-run
// 声明文档；classifyWorkflowScript(bytes) 对 register 显式声明为 workflow-script 的文件做语法门
// 与命令字面量扫描。
//
// 决策零分叉：登记后的门禁判定完全走 review_gate 既有通路（plan-gate.js 的
// checkRoot → decide，权威决策矩阵 plugin/test/fixtures/decision-matrix.json，26 条判定行）。
// 本文件不含任何 allow/deny/escalate 判定，也不复制矩阵行文。
//
// kind 约定：文件顶层 JSON 对象带 "kind": "engine-run"（精确字符串匹配，大小写敏感）→
// 声明体 = 剥掉 kind 后的其余字段，交 declaration.js 的 validateDeclaration（S1 产物）校验；
// schema 的 additionalProperties:false 不认识 kind，故先剥再校验。kind 以外的任何文件
// （普通方案 markdown、无 kind 的 JSON、kind 别值、二进制）一律 plain——哈希语义不受影响
// （D1：哈希永远绑文件全字节，kind 字段也在内），gate-check 照走同一矩阵行。
//
// M2.4 增量：workflow-script（脚本文件）的登记判别。脚本文件是**裸函数体**（script-runner
// 原样包装为 async function main(F){…}，没有 JSON 信封可带 kind 标记），故 kind 不在文件里、
// 由 register 的 kind 参数显式给（plan-gate.js registerSession(sessionId, planPath, kind)）。
// 登记校验两件事（与 runScript 同一包装 compileScriptBody——登记时点与执行时点语法判定零分叉）：
//   ① 语法门：编译不过（含空文件）→ ok:false，register 拒绝且零记录（engine-run 不合法同轨）；
//   ② 命令字面量静态扫描：scanRunCommands（M2.1）→ ok:true 时带 script.commands 供评审
//     （M2.1「命令字面量进评审」；模板字符串/变量命令不可静态捕获——v1 偏差已在 M2.3 清单）。
// 哈希绑定与声明同轨（D1 文件全字节，plan-gate 侧照旧）；check 侧零分叉，照走同一矩阵。
import { validateDeclaration } from './declaration.js'
import { compileScriptBody, scanRunCommands } from './script-runner.js'

/** 声明文件的 kind 标记（精确字符串匹配）。 */
export const ENGINE_RUN_KIND = 'engine-run'

/** 脚本文件的 register kind（review_gate register 的显式参数；裸函数体无法在文件内自我描述）。 */
export const WORKFLOW_SCRIPT_KIND = 'workflow-script'

/** JSON 解析前的容错：Buffer/Uint8Array/string 都收（register/check 传入的是 readFileSync 的 Buffer）。 */
function decodeText(bytes) {
  if (typeof bytes === 'string') return bytes
  return Buffer.from(bytes).toString('utf8')
}

/**
 * 文件字节 → artifact 分类。纯函数，不抛、不读盘、不触碰时钟。
 * 返回三种形状之一：
 *   { kind: 'plain' }                                          —— 非 engine-run 文件（含 JSON 解析失败）
 *   { kind: 'engine-run', ok: true,  declaration }              —— 合法声明；declaration = { runId, stepCount }
 *   { kind: 'engine-run', ok: false, errors: string[] }         —— 自称 engine-run 但声明体不过 validateDeclaration
 */
export function classifyArtifact(bytes) {
  let doc
  try {
    doc = JSON.parse(decodeText(bytes))
  } catch {
    return { kind: 'plain' }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.kind !== ENGINE_RUN_KIND) {
    return { kind: 'plain' }
  }
  const { kind, ...declarationBody } = doc
  const verdict = validateDeclaration(declarationBody)
  if (!verdict.ok) {
    return { kind: ENGINE_RUN_KIND, ok: false, errors: verdict.errors }
  }
  return {
    kind: ENGINE_RUN_KIND,
    ok: true,
    declaration: {
      runId: declarationBody.runId,
      stepCount: Array.isArray(declarationBody.steps) ? declarationBody.steps.length : 0,
    },
  }
}

/**
 * 文件字节 → workflow-script 分类（M2.4；register 的 kind 参数指明 workflow-script 时才走这里——
 * 裸函数体不进 classifyArtifact 的 JSON 判别）。纯函数，不抛、不读盘、不触碰时钟。
 * 返回两种形状之一：
 *   { kind: 'workflow-script', ok: true,  script: { commands } }  —— 语法门过；commands = F.run
 *     字面量命令集（scanRunCommands，去重首见序）供评审；模板字符串/变量命令不可静态捕获。
 *   { kind: 'workflow-script', ok: false, errors: string[] }      —— 空文件 / 语法编译不过
 *     （compileScriptBody 与 runScript 同一包装，语法判定零分叉）。
 */
export function classifyWorkflowScript(bytes) {
  const text = decodeText(bytes)
  if (text.trim().length === 0) {
    return { kind: WORKFLOW_SCRIPT_KIND, ok: false, errors: ['workflow-script: 函数体为空（脚本文件不能是空文件）'] }
  }
  try {
    compileScriptBody(text, 'workflow-script.register.js')
  } catch (error) {
    const brief = String(error?.message ?? error).slice(0, 200)
    return { kind: WORKFLOW_SCRIPT_KIND, ok: false, errors: [`workflow-script: 语法不过（${brief}）`] }
  }
  return { kind: WORKFLOW_SCRIPT_KIND, ok: true, script: { commands: scanRunCommands(text) } }
}
