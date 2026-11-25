// E1 引擎 script-runner（M2.1；蓝图 .zcode/plans/next-phase-plan-m1-m5.md「M2.1 facade 契约表」，
// 评审记录 Round 1 必修③「ask 并发帽接缝错层：facade 内 semaphore，不依赖 execute.before」与
// 必修④「callSeq 三不变量」）。
//
// 职责：脚本前端——把一段 ESM JavaScript **函数体**包成 `async function main(F){…}` 在 vm 沙箱
// 里跑（JS 直读；P4 起 .ts 函数体经 ts-front.js 剥类型喂 vm——TS 语法 only，坐标系唯一落在
// .ts 源文本，见 ts-front.js 头注），F = facade 六成员（ask/run/phase/hole/escalate/log），
// 底座全部复用既有件：
//   ask      走 typedAsk（ask.js，3 修 1 催口径/超时/重派口径不变；driver.create + result 的
//            wait+context 解析都在 driver/typedAsk 里，本文件不复制）；
//   journal  只记**事件**（脚本不是步——无步状态机迁移、无 declared 播种；facade 表的 journal
//            列逐一落 recordEvent）。与声明路径的 P4-E 偏差：脚本路径的 hole「blocked 记账」=
//            hole/hole-answered 事件对（无 stepId 可迁移——挂起的对象是脚本不是步；恢复不重派
//            而是 await 唤醒）。
//   并发帽   facade 内自建 semaphore：复用 src/concurrency.js 的 Admission（acquire(key)→release()
//            形状与缺省参数同 scheduler.createCapGate：数字 → Admission({limits:{default:n}})、
//            缺省 0=无限、带 acquire 的对象原样用），key=callSeq。脚本路径不经工具层，
//            execute.before 的现网帽管不住——所以帽必须在 facade 里。
//
// 确定性纪律（vm 层强制，蓝图 M2.1）：沙箱 globals 白名单——console（路由 onLog，不进 journal）
// /Promise/JSON/Math（**删 Math.random**）/注入的 now。**不注入** fetch/fs/process/Date/setTimeout：
// 前四者与定时器在裸 vm context 本就不存在，Date 是每 context 必有的 intrinsic 须显式 delete。
// 违例 = ReferenceError（缺席全局，如 Date.now/fetch/process）/TypeError（Math.random 被删后调用）
// = 脚本失败（fail-closed）。脚本无 import（函数体包装天然禁，facade 即全部依赖）；动态 import()
// 在经典 vm.Script 里无回调可用，同样炸（ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING）。
// **vm 非安全边界**（官方明示）：白名单防误用不防恶意；v1 威胁模型 = 自家脚本防误用，
// 防恶意 = 进程隔离（v2 后备）——蓝图风险表 + M2.3 偏差清单，写进 SKILL 边界段。
//
// callSeq 不变量（Round 1 必修④，M2.2 resume 的根基）：callSeq 在 F.ask **同步入口第一行**分配
// （async 函数体首个 await 前同步执行，调用序 = 分配序；Promise.all 内多 ask 的序号 = 数组求值序）；
// attempt 重派在 typedAsk 内部循环、缓存命中归 M2.2——均不额外消耗序号。ask 事件缓存键 =
// `${sha256(script)}:${callSeq}`（C1 v2 起仅作诊断链，不作匹配判据）；同一同步入口还抓调用点栈
// （captureVmSite——C1 v2 作用点证据的写端半边，首个 await 前栈上还站着脚本 caller）。
//
// 失败语义：脚本 throw（含语法错/ask 耗尽/答复源连续异常）= run failed，**journal 保留**——已完成
// 的 ask 结果在 journal 的 ask 事件 payload.value 里（报告打捞 + M2.2 按序返还），result.asks 是
// 内存镜像。journal 写失败/torn = fail-closed（同 scheduler T3.5）：脚本就地停（facade 每次动作先
// 查 halted，journal 化的 driver 包装拒绝后续 create）→ run blocked(reason=journal-not-ok)、零
// 后续 driver 调用。
//
// F.run（child_process spawn + terminal-gate 纪律）：**close 才结论**（stdio 排干——terminal-gate
// 「静默死亡」哲学：exit 时管道可能仍在流，'close' 后才落账）；spawn 'error' 必捕（不静默丢进程，
// ENOENT 一类如实进结果与 journal，非零退出码是**值不是异常**——蓝图 F.run 行）；可选
// opts.timeoutMs（注入 sleep 竞跑）→ kill(SIGTERM) 后仍等 close（不孤儿）。v1 opts 只收 timeoutMs
// （未知键拒——repo 严格风格）。命令字面量静态扫描（scanRunCommands，正则提取 F.run("…") /
// F.run('…')）进 result.commands 供评审（M2.4 review_gate 脚本接入的评审面；模板字符串/变量命令
// 不可静态捕获——v1 偏差，写进 M2.3 清单）。**F.run 结果不进任何缓存**（C1 口径）：副作用命令
// 在任何 resume 里都重执行并如实记账——「ask 零重跑 ≠ 副作用零重执行」；幂等命令缓存列为可选
// 增强，v2 不做。
//
// 注入面（§6 纪律；生产传缺省）：now（默认 Date.now；journal at/F.run 超时竞跑/沙箱 now 全走它）、
// sleep（默认 setTimeout；typedAsk 轮询间隔/hole 答复轮询/F.run 超时竞跑全走它——测试注入即时或
// 手控 promise，禁真实定时器忙等）、spawn（默认 node:child_process.spawn；测试注入假 child——
// 夹具全合成）、cap（ask 帽）、pollMs/holePollMs（轮询间隔毫秒）、onEvent（run 事件广播，先落盘
// 再广播；抛错只吞掉）、onLog（F.log/console 的报告流出口；缺省静默）、answerFor（hole/escalate
// 的非阻塞答复源，hole 必需）、onHole（挂起通知回调，恰一次，抛错只吞掉）、scriptName（vm filename，
// 栈可读）。hole 的答复源连续异常 ≥ answerErrorLimit 次 → 脚本失败（reason=answer-source-error，
// 防答复源坏死的热循环）。
//
// resume 脚本模式接线（M2.2 读端在 resume-script.js；C1 v2 作用点位置匹配，蓝图
// optimization-plan-v3.md「C1」行）：opts.askCache = resumeScript(script, storage, runId).cached
// （Map<callSeq, ask 事件条目>，条目带作用点证据 site/promptHash/prefixHash/optsHash）。命中要过
// **三条件**（任一不过 → 该点起全部弃用真跑；宁重跑，不假完成）：① 调用点在首个变更字节之前
// （prefixHash = 调用点前脚本体前缀哈希——本文件的 ask facade 用重跑脚本实算比对，读端拿不到
// 旧脚本字节）；② 前缀内 hole-answered/escalate-answered 事件集为空（读端按事件序裁决）；
// ③ promptHash 与本次重跑实算相等（optsHash 为伴生保守门——agent/model/schema 也是 ask 身份，
// 原位变更同样拦下）。命中 = 零 driver 调用、零 journal 写、零广播，返还首跑值并在 result.asks
// 带 cached:true——callSeq 照常同步入口第一行分配（不变量①）；值恒等首跑 → 分支决策相同 →
// 后续 ask 发起序与首跑逐位一致（不变量③）。v1 的「脚本哈希变更 → 全量重跑」被 C1 有意推翻为
// 「前缀有效 → 导入」；torn/runId 不符 → ok:false 空 Map。**F.run 不进任何缓存**：ask 零重跑 ≠
// 副作用零重执行——副作用命令在任何 resume 里都重执行并如实记账（幂等命令缓存列为可选增强）。
//
// C2 补段重跑（hole patch；spike .zcode/plans/evidence/c2-hole-patch-spike.md，Model A）：补段
// = 编辑后的完整脚本文本的一部分，重跑走同一 runScript 路径（无续栈——run failed/blocked 即
// 调用终结）。补段产物文件与 patch 事件由 script-patch.js applyPatch 机械落盘；本文件只新增
// 两个面：SCRIPT_EVENT_TYPES 收 'patch'（run 级事件，非 facade 成员）；失败归类 reason 扩
// 'patch-failed'——opts.patchFrom（applyPatch 返回的 changedFrom = base 与 patched 的首个变更
// 字节偏移，JS 字符串下标）给出时，script-threw（vm 栈 captureVmSite 换算脚本体坐标）或
// ask-failed（ask 作用点证据 bodyOffset）的失败点偏移 ≥ patchFrom → 'patch-failed'（失败在
// 补段内），否则维持原 reason（失败在未变更前缀 = 首跑语义；证据缺失不发明归类；
// answer-source-error 环境失败与 script-syntax 整文件级恒不归类）。补段内已完成的 ask/run
// 事件全数保留（打捞语义同首跑：journal 先落盘，throw 不回滚）；补段调用点必在变更点之后
// → C1 三条件天然弃用该点前缀的缓存（宁重跑不假完成，resume-script.js 哲学）——ask 缓存面
// 零改动，resumeScript 不收 patch 事件。
import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { format } from 'node:util'
import vm from 'node:vm'

import { Admission } from '../concurrency.js'
import { assertDriverFace } from './driver.js'
import { typedAsk } from './ask.js'

/** 缺省参数（opts 可逐项覆盖）。pollMs/holePollMs 生产缺省 1000ms——真实定时器节奏由注入 sleep 承担。 */
export const SCRIPT_DEFAULTS = Object.freeze({
  pollMs: 1000,
  holePollMs: 1000,
  answerErrorLimit: 3,
  runPreviewCap: 512, // journal run 事件里 stdout/stderr 预览上限（字符）；全文只回给脚本不落盘
  runOutputCap: 10 * 1024 * 1024, // 收集侧硬帽（字符），防爆内存；超帽置 truncated 标记
})

/** facade → journal 事件类型（facade 表 journal 列的一一对应）；'patch' 例外——run 级补段事件，
 * 非 facade 成员，由 script-patch.js applyPatch 经同一 journal.recordEvent 写入（C2）。 */
export const SCRIPT_EVENT_TYPES = Object.freeze([
  'phase',
  'ask',
  'ask-failed',
  'run',
  'hole',
  'hole-answered',
  'escalate',
  'escalate-answered',
  'log',
  'patch',
])

/**
 * run 失败 reason 取值域（status='failed'）；blocked 的 reason 恒 'journal-not-ok'（scheduler 同字）。
 * 'patch-failed'（C2）：经补段的重跑中失败点位于首个变更字节之后（补段内）——判定机制见
 * opts.patchFrom 注释与文件头「变更边界与重跑失败归类」段。
 */
export const SCRIPT_FAILURE_REASONS = Object.freeze(['script-syntax', 'script-threw', 'ask-failed', 'answer-source-error', 'patch-failed'])

/** 脚本 ask 的 stepId 约定（journal 事件与 driver.create 的 title 锚点都用它）。 */
export const SCRIPT_ASK_STEP_PREFIX = 'script-ask'

/** 本文件的错误 code（facade 层失败在脚本 catch 看到的也是这些 Error）。 */
export const SCRIPT_ERROR_CODES = Object.freeze([
  'E1_SCRIPT_JOURNAL_HALTED',
  'E1_SCRIPT_ASK_FAILED',
  'E1_SCRIPT_NO_ANSWER_SOURCE',
  'E1_SCRIPT_ANSWER_SOURCE_BROKEN',
])

/** journal fail-closed 的 run 级 reason（scheduler.js 同字，面板按同一字面渲染）。 */
export const SCRIPT_JOURNAL_NOT_OK = 'journal-not-ok'

/** F.ask opts 允许字段（蓝图 facade 表签名行：opts={schema?, agent?, model?}；未知键拒）。 */
const ASK_OPT_FIELDS = Object.freeze(['schema', 'agent', 'model'])
/** F.run opts 允许字段（v1 只收 timeoutMs；未知键拒）。 */
const RUN_OPT_FIELDS = Object.freeze(['timeoutMs'])

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const brief = (v) => String(v?.message ?? v).slice(0, 160)

const codeError = (code, message) => {
  const e = new Error(message)
  e.code = code
  return e
}

const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/** 脚本函数体的字节指纹（sha256 hex）——ask 缓存键的一半（C1 v2 起缓存键仅作诊断链）。 */
export function scriptFingerprint(script) {
  return sha256Hex(script)
}

/** ask 缓存键：`${sha256(script)}:${callSeq}`（蓝图 M2.1 facade 表 journal 列；v2 诊断链）。 */
export function askCacheKey(script, callSeq) {
  return `${scriptFingerprint(script)}:${callSeq}`
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 命令字面量静态扫描：正则提取 F.run("…") / F.run('…') 的第一个字符串字面量参数，供评审
 * （M2.1「命令字面量静态扫描进评审」）。模板字符串与变量命令不可静态捕获（v1 偏差，M2.3 清单）；
 * 重复命令去重（首见序）；纯函数不抛（任何垃圾输入都返形状良好的数组）。
 */
export function scanRunCommands(script) {
  const found = []
  const seen = new Set()
  // (?<![\w$.]) = F 前不得有标识符字符或点（F.run 才是 facade 访问；myF.run/X.F.run 不算）
  const re = /(?<![\w$.])F\.run\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)')/g
  let m = re.exec(script)
  while (m !== null) {
    const raw = m[1] !== undefined ? m[1] : m[2]
    const cmd = m[1] !== undefined ? unescapeDouble(raw) : unescapeSingle(raw)
    if (!seen.has(cmd)) {
      seen.add(cmd)
      found.push(cmd)
    }
    m = re.exec(script)
  }
  return found
}

/** 双引号字面量解码：内容是 JSON 字符串子集（正则已排除裸换行），JSON.parse 失败才走兜底解转义。 */
function unescapeDouble(inner) {
  try {
    return JSON.parse(`"${inner}"`)
  } catch {
    return unescapeSingle(inner)
  }
}

/** 单引号/兜底解转义：常见转义序列 + \uXXXX；未知转义原样保留字符（不发明语义）。 */
function unescapeSingle(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|[nrtbfv0'"\\])/g, (_, esc) => {
    if (esc.startsWith('u')) return String.fromCharCode(parseInt(esc.slice(1), 16))
    const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }
    return esc in map ? map[esc] : esc
  })
}

/**
 * ask 并发帽（scheduler.js createCapGate 同款口径：数字 → Admission({limits:{default:n}})；
 * 缺省/null → Admission() 0=无限；带 acquire 的对象 → 原样用）。facade 内自建——蓝图必修③。
 */
function createAskGate(cap) {
  if (cap === undefined || cap === null) return new Admission()
  if (typeof cap === 'number') {
    if (!Number.isInteger(cap) || cap < 0) throw new TypeError(`runScript: cap 数字形式必须是 ≥0 整数（0=无限；得到 ${cap}）`)
    return cap === 0 ? new Admission() : new Admission({ limits: { default: cap } })
  }
  if (isPlainObject(cap) && typeof cap.acquire === 'function' && (cap.release === undefined || typeof cap.release === 'function')) return cap
  throw new TypeError('runScript: cap 必须是 ≥0 整数（0=无限）或带 acquire(key)→release() 的租户形状对象（concurrency.js Admission 同款）')
}

/** 沙箱 preamble 与包装（P4 起经 script-wrap.js 单源——ts-front 的 TS transform 输入必须与
 * vm 编译输入逐字节相同，包装出现两份 = 语法/坐标判定分叉）。 */
import { WRAPPER_BODY_LINE_BASE, wrapScriptBody } from './script-wrap.js'
import { compileScriptBodyAsync, generatedToSource, isTsScriptName } from './ts-front.js'

// ---- C1 v2 作用点证据（蓝图 optimization-plan-v3.md「C1」行的写端半边）--------------------
//
// 包装头部占用的行数（SANDBOX_PREAMBLE 的 3 行 + `(async function main(F) {` 1 行）：vm 栈
// 行号 → 脚本体行号的换算基数；compileScriptBody/wrapScriptBody 是包装的唯一事实来源，基数
// 从它推导（script-wrap.js 单源）。

/**
 * 从栈文本抓 F.ask/throw 点：第一个 vm 脚本帧的 filename:line:col，**原始 vm 坐标**（1 基；
 * 未减包装头部行——换算归调用方：JS 路径减 WRAPPER_BODY_LINE_BASE，TS 路径先经 sourcemap
 * 映回 .ts 源文本再减）。抓不到/形状怪 → null（调用点证据缺失——命中复核时 null 恒不过，
 * 宁弃用不假完成）。纯函数。
 */
function captureVmSite(stackText, vmFilename) {
  if (typeof stackText !== 'string' || stackText.length === 0) return null
  const m = new RegExp(`${escapeRegExp(vmFilename)}:(\\d+):(\\d+)`).exec(stackText)
  if (!m) return null
  const line = Number(m[1])
  const col = Number(m[2])
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(col) || col < 1) return null
  return { line, col }
}

/**
 * 原始 vm 坐标 → 脚本体坐标（P4 坐标系写死：**.ts 源文本为唯一坐标域**）。
 * JS 路径：行减 WRAPPER_BODY_LINE_BASE（列不受前导行影响）；头部行 → null。
 * TS 路径：先经 sourcemap 把生成域（esbuild 不保行数——探针实测 interface/type 行被删除）
 * 映回包装文本域，再减基数。映射缺失（map 无该线段）→ null → 证据 null 走既有保守面
 * （命中恒不过 / patch-failed 不发明归类）。
 */
function vmSiteToBodySite(vmSite, sourceMap) {
  if (!vmSite) return null
  if (sourceMap) {
    const mapped = generatedToSource(sourceMap, vmSite.line, vmSite.col)
    if (!mapped) return null
    const line = mapped.line - WRAPPER_BODY_LINE_BASE
    return line >= 1 ? { line, col: mapped.col } : null
  }
  const line = vmSite.line - WRAPPER_BODY_LINE_BASE
  return line >= 1 ? { line, col: vmSite.col } : null
}

/** 脚本体 (line,col) → 字节偏移（行起点表预建）；出界 → null。 */
function bodyOffsetAt(scriptText, lineStarts, site) {
  if (!site || site.line > lineStarts.length) return null
  const offset = lineStarts[site.line - 1] + site.col - 1
  return Number.isInteger(offset) && offset >= 0 && offset <= scriptText.length ? offset : null
}

/**
 * 函数体编译（JS 路径）：蓝图 M2.1「引擎包装为 async function main(F){…}」；表达式语句的
 * 完成值 = main 函数。导出给 M2.4 review_gate 的登记语法门（engine/pgate.js
 * classifyWorkflowScript）——登记时点与执行时点用同一包装，语法判定零分叉（单一事实来源）。
 * TS 脚本（.ts）走 ts-front.js compileScriptBodyAsync（transform 后同一 vm.Script 构造——
 * 语法判定仍零分叉，P4）。
 */
export function compileScriptBody(body, scriptName = 'script.js') {
  return new vm.Script(wrapScriptBody(body), { filename: scriptName })
}

/**
 * 跑一个脚本到终态（脚本前端的 run 级入口；与声明路径 scheduler.run 并列，底座共享）。
 * @param {object} input
 *   - script: 脚本函数体源码（非空字符串；引擎包成 async function main(F){…}，顶层 await 可用）
 *   - runId:  run 标识（非空字符串；journal 绑定 + driver.create 的 REEVE-E1 锚点）
 *   - journal: createJournal 产物（六 face 校验；torn/degraded → blocked 零 driver 调用）
 *   - driver:  createDriver/createSessionDriver 产物（assertDriverFace 校验；close 归调用方）
 * @param {object} opts
 *   - cap:        ask 并发帽（数字 / Admission 形状对象 / 缺省无限）——facade 内 semaphore
 *   - now:        () => number（默认 Date.now；journal at / 超时竞跑 / 沙箱 now 全走它）
 *   - sleep:      (ms) => Promise（默认 setTimeout；typedAsk 轮询 / hole 答复轮询 / F.run 超时全走它）
 *   - pollMs:     typedAsk 轮询间隔毫秒（≥0 整数，缺省 SCRIPT_DEFAULTS.pollMs）
 *   - holePollMs: hole/escalate 答复轮询间隔毫秒（≥0 整数，缺省 SCRIPT_DEFAULTS.holePollMs）
 *   - onEvent:    (event) => void——run 事件广播（先落盘再广播；抛错只吞掉）
 *   - onLog:      (line) => void——F.log 与脚本 console 的报告流出口（F.log 另进 journal；缺省静默）
 *   - answerFor:  (record) => 非空字符串 | null|undefined|Promise——hole/escalate 答复源（脚本用
 *                 hole/escalate 时必配；抛错连续 ≥ answerErrorLimit 次 → answer-source-error）
 *   - onHole:     (record) => void——挂起通知回调（恰一次；抛错只吞掉；面板/聊天接线点）
 *   - spawn:      (cmd, args, opts) => child——F.run 的进程原语（默认 node:child_process.spawn；
 *                 child 须有 stdout/stderr 流与 on('close')/on('error')/kill()）
 *   - scriptName: vm filename（栈可读；缺省 `<runId>.script.js`）
 *   - askCache:   Map<callSeq, ask 事件条目>——resume 脚本模式的缓存（resumeScript(script,
 *                 storage, runId).cached；条目须带 C1 v2 作用点证据 site/promptHash/prefixHash/
 *                 optsHash）。命中在三条件复核通过后返还首跑值并带 cached:true 进 result.asks
 *                 （零 driver 调用/零 journal 写/零广播）；任一证据不符 → 该 callSeq 起缓存
 *                 全弃用、就地真跑（宁重跑，不假完成）。缺省 = 不做缓存返还，全量真跑。
 *   - patchFrom:  ≥0 整数——补段首个变更字节的脚本体偏移（C2；applyPatch 返回的 changedFrom，
 *                 script-patch.js）。给出时失败归类：script-threw（vm 栈换算脚本体坐标）或
 *                 ask-failed（ask 作用点证据）的失败点偏移 ≥ patchFrom → reason='patch-failed'
 *                 （失败在补段内）；< patchFrom → 维持原 reason（失败在未变更前缀，首跑语义）。
 *                 失败点证据缺失（栈抓不到/作用点 null）→ 同样维持原 reason——不发明归类。
 *                 缺省 = 无补段边界，不参与归类（answer-source-error 环境失败与 script-syntax
 *                 整文件级，恒不归类为 patch-failed）。
 * @returns {Promise<{status:'completed'|'failed'|'blocked', runId, at, reason?, error?, askFailure?,
 *                     value?, commands, asks, askFailures, runs, phases, holes, logs, journal?}>}
 *   commands = scanRunCommands(script)（评审面）；asks/askFailures/runs/phases/holes/logs = 各
 *   journal 事件的内存镜像（脚本 throw 后 result.asks 仍带已完成项——打捞）；value = 脚本返回值
 *   （仅 completed；undefined 省略键）。
 * @throws {TypeError} input/opts 形状不合法（程序错误 fail-fast，scheduler 同轨）
 */
export async function runScript(input, opts = {}) {
  const { script, runId, journal, driver } = input ?? {}
  const {
    cap,
    now,
    sleep,
    pollMs,
    holePollMs,
    onEvent,
    onLog,
    answerFor,
    onHole,
    spawn: spawnFn,
    scriptName,
    askCache,
    patchFrom,
  } = opts ?? {}

  // ---- 参数校验（程序错误 = TypeError，fail-fast；语义性失败走返回值，与 scheduler 分轨同哲学）----
  if (typeof script !== 'string' || script.length === 0) {
    throw new TypeError(`runScript: script 必须是非空字符串（脚本函数体；得到 ${script === undefined ? '缺省' : typeof script}）`)
  }
  if (typeof runId !== 'string' || runId.length === 0) throw new TypeError('runScript: runId 必须是非空字符串')
  for (const face of ['appendStepState', 'recordEvent', 'markEngineSession', 'getStepState', 'listSteps', 'status']) {
    if (typeof journal?.[face] !== 'function') throw new TypeError(`runScript: journal 缺 face ${face}（createJournal 产物）`)
  }
  assertDriverFace(driver, 'runScript: driver')
  const askGate = createAskGate(cap)
  if (now !== undefined && typeof now !== 'function') throw new TypeError('runScript: now 必须是 () => number')
  if (sleep !== undefined && typeof sleep !== 'function') throw new TypeError('runScript: sleep 必须是 (ms) => Promise')
  if (pollMs !== undefined && (!Number.isInteger(pollMs) || pollMs < 0)) throw new TypeError('runScript: pollMs 必须是 ≥0 整数（毫秒）')
  if (holePollMs !== undefined && (!Number.isInteger(holePollMs) || holePollMs < 0)) {
    throw new TypeError('runScript: holePollMs 必须是 ≥0 整数（毫秒）')
  }
  if (onEvent !== undefined && typeof onEvent !== 'function') throw new TypeError('runScript: onEvent 必须是 (event) => void 回调')
  if (onLog !== undefined && typeof onLog !== 'function') throw new TypeError('runScript: onLog 必须是 (line) => void 回调')
  if (answerFor !== undefined && typeof answerFor !== 'function') {
    throw new TypeError('runScript: answerFor 必须是 (record) => 非空字符串|null 的答复源回调（脚本用 hole/escalate 时必配）')
  }
  if (onHole !== undefined && typeof onHole !== 'function') throw new TypeError('runScript: onHole 必须是 (record) => void 回调')
  if (spawnFn !== undefined && typeof spawnFn !== 'function') throw new TypeError('runScript: spawn 必须是 (cmd, args, opts) => child')
  if (scriptName !== undefined && (typeof scriptName !== 'string' || scriptName.length === 0)) {
    throw new TypeError('runScript: scriptName 必须是非空字符串（vm filename）')
  }
  if (askCache !== undefined && !(askCache instanceof Map)) {
    throw new TypeError('runScript: askCache 必须是 Map<callSeq, ask 事件条目>（resumeScript(script, storage, runId).cached；缺省 = 不做缓存返还）')
  }
  if (patchFrom !== undefined && (!Number.isInteger(patchFrom) || patchFrom < 0)) {
    throw new TypeError('runScript: patchFrom 必须是 ≥0 整数（补段首个变更字节的脚本体偏移；script-patch.js applyPatch 的 changedFrom）')
  }

  const nowFn = now ?? Date.now
  const sleepFn = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const doSpawn = spawnFn ?? nodeSpawn
  const filename = scriptName ?? `${runId}.script.js`
  const pollDelay = pollMs ?? SCRIPT_DEFAULTS.pollMs
  const holeDelay = holePollMs ?? SCRIPT_DEFAULTS.holePollMs
  const answerLimit = SCRIPT_DEFAULTS.answerErrorLimit

  // C1 v2 作用点证据的实算面：脚本体行起点表（偏移换算）+ 本 run 已否决的缓存下界。
  const bodyLineStarts = (() => {
    const starts = [0]
    let idx = script.indexOf('\n')
    while (idx !== -1) {
      starts.push(idx + 1)
      idx = script.indexOf('\n', idx + 1)
    }
    return starts
  })()
  let cacheVoidFrom = Number.POSITIVE_INFINITY // 命中证据不符的弃用下界：该 callSeq 起（含）全弃用
  let tsSourceMap = null // TS 路径的 sourcemap 段表（compileScriptBodyAsync 产物；JS 路径恒 null）

  /**
   * 栈文本 → 脚本体坐标（写端与 throw 归类共用；P4 坐标系唯一 = .ts 源文本）。JS 路径减包装
   * 头部行；TS 路径先经 tsSourceMap 映回源文本再减——esbuild 不保行数（探针实测），直接减
   * 生成域行号 = 坐标域漂移，C1 导入/patch-failed 静默失准（蓝图风险表行）。
   */
  const siteFromStack = (stackText) => vmSiteToBodySite(captureVmSite(stackText, filename), tsSourceMap)

  /** ask 调用身份证据（写端与命中复核共用同一实算）：调用点 + prompt/前缀/opts 三个哈希。 */
  const askEvidence = (instructions, askOpts, stackText) => {
    const site = siteFromStack(stackText)
    const offset = bodyOffsetAt(script, bodyLineStarts, site)
    return {
      site,
      promptHash: sha256Hex(instructions),
      prefixHash: offset === null ? null : sha256Hex(script.slice(0, offset)),
      optsHash: sha256Hex(JSON.stringify({ schema: askOpts.schema ?? null, agent: askOpts.agent ?? null, model: askOpts.model ?? null })),
    }
  }

  const emit = (type, extra = {}) => {
    if (!onEvent) return
    try {
      onEvent({ kind: 'script', runId, type, at: nowFn(), ...extra })
    } catch {
      /* 监听方异常不回滚（journal/scheduler 广播同款：持久化已成功） */
    }
  }

  const result = {
    status: null,
    runId,
    commands: scanRunCommands(script),
    asks: [],
    askFailures: [],
    runs: [],
    phases: [],
    holes: [],
    logs: [],
  }

  // ---- journal 预检：torn/degraded 一律 fail-closed（T3.5 同款：零 driver 调用、零事件、零广播）----
  const status0 = journal.status()
  if (status0?.ok !== true) {
    return finishBlocked(status0 ?? null)
  }

  // ---- 沙箱：白名单 globals（console 路由 onLog；now 注入）+ preamble 删 Date/Math.random ----
  const routedConsole = {
    log: (...a) => sinkLog(format(...a)),
    info: (...a) => sinkLog(format(...a)),
    debug: (...a) => sinkLog(format(...a)),
    warn: (...a) => sinkLog(format(...a)),
    error: (...a) => sinkLog(format(...a)),
  }
  function sinkLog(line) {
    if (onLog) {
      try {
        onLog(line)
      } catch {
        /* 日志出口异常不回滚脚本 */
      }
    }
  }

  let halted = null // null | { reason:'journal-not-ok' }——fail-closed 闩（scheduler halted 同款）
  const haltError = (where) => codeError('E1_SCRIPT_JOURNAL_HALTED', `runScript: journal 写失败，脚本就地停（${where}）`)

  /** 事件落账：先落盘（写败 → halted + 停脚本），成功才广播（先落盘再广播，scheduler 同序）。 */
  const recordScriptEvent = (type, payload, where) => {
    const r = journal.recordEvent(type, payload)
    if (!r.ok) {
      halted = { reason: SCRIPT_JOURNAL_NOT_OK }
      throw haltError(where)
    }
    emit(type, payload)
    return r
  }

  // journal 化 driver 包装：create 后先 markEngineSession（§1 级联守卫锚点，scheduler 同序）再回；
  // halted 后一律拒（零宿主调用）——typedAsk 的重派循环会以 dispatch-error/poll-error 烧完尝试，
  // 但每次都停在包装层，宿主不再被触碰；ask 收敛后由 halted 分支接管为 blocked。
  const journalingDriver = {
    create: async (args) => {
      if (halted) throw haltError('create')
      const out = await driver.create(args)
      const sessionId = out?.sessionId
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        const marked = journal.markEngineSession(sessionId)
        if (!marked.ok) {
          halted = { reason: SCRIPT_JOURNAL_NOT_OK }
          throw haltError('markEngineSession')
        }
      }
      return out
    },
    result: async (sessionId) => {
      if (halted) throw haltError('result')
      return driver.result(sessionId)
    },
    context: async (sessionId) => {
      if (halted) throw haltError('context')
      return driver.context(sessionId)
    },
  }

  // ---- facade（脚本可见的全部；蓝图 facade 契约表逐行）----
  let askSeq = 0 // callSeq：F.ask 同步入口第一行分配（调用序 = 分配序；重派/缓存命中不额外消耗）
  let holeSeq = 0

  const ask = async (instructions, askOpts = {}) => {
    const callSeq = ++askSeq // 不变量：同步入口第一行（async 体首个 await 前同步执行）
    const stackText = new Error().stack // C1 v2：同一同步入口抓调用点栈（首个 await 前栈上还有 caller）
    if (typeof instructions !== 'string' || instructions.length === 0) {
      throw new TypeError(`F.ask: instructions 必须是非空字符串（第 ${callSeq} 次调用；得到 ${typeof instructions}）`)
    }
    if (!isPlainObject(askOpts)) throw new TypeError(`F.ask: opts 必须是对象（第 ${callSeq} 次调用）`)
    for (const key of Object.keys(askOpts)) {
      if (!ASK_OPT_FIELDS.includes(key)) throw new TypeError(`F.ask: 未知 opts 字段 "${key}"（允许：${ASK_OPT_FIELDS.join(', ')}）`)
    }
    const { schema, agent, model } = askOpts
    if (schema !== undefined && !isPlainObject(schema)) throw new TypeError(`F.ask: opts.schema 必须是 JSON Schema 对象（第 ${callSeq} 次调用）`)
    const live = askEvidence(instructions, askOpts, stackText)
    const stepId = `${SCRIPT_ASK_STEP_PREFIX}-${callSeq}`
    const cacheKey = askCacheKey(script, callSeq)
    // C1 v2 缓存命中复核（不变量③ + 三条件；蓝图 optimization-plan-v3.md「C1」行）：
    //   ① prefixHash 相等 = 调用点之前脚本体字节零变更（首个变更字节必在调用点或之后）；
    //   site 相等是①的伴随结构检查（前缀字节相同 + 偏移相同则行列必同）；
    //   ③ promptHash/optsHash 相等 = ask 身份（问什么、谁答、怎么验）未变——原位改 prompt 字节、
    //   换 agent/model/schema 都在这里拦下。条件②（前缀 hole-answered/escalate-answered 空判据）
    //   在读端 resumeScript 按事件序裁决，不会出现在 askCache 里。
    //   任一不过 → cacheVoidFrom = callSeq：该点起（含）缓存全弃用，就地真跑（宁重跑，不假完成）；
    //   下界之前的条目不受牵连（前缀有效的部分照常导入——「前缀有效 → 导入」取代 v1 全量重跑）。
    // 命中 = 零 driver 调用、零 journal 写、零广播（先落盘再广播的对称面：没有写就没有广播）；
    // callSeq 已在第一行分配（不变量①：命中不额外消耗序号）。
    const hit = callSeq < cacheVoidFrom ? askCache?.get(callSeq) : undefined
    if (hit !== undefined && hit !== null) {
      if (!isPlainObject(hit) || !Object.hasOwn(hit, 'value')) {
        throw new TypeError(`F.ask: askCache[${callSeq}] 形状不合规（须为 ask 事件条目含 value；resumeScript(script, storage, runId).cached）`)
      }
      if (
        typeof hit.promptHash === 'string' &&
        hit.promptHash === live.promptHash &&
        typeof hit.prefixHash === 'string' &&
        hit.prefixHash === live.prefixHash &&
        typeof hit.optsHash === 'string' &&
        hit.optsHash === live.optsHash &&
        live.site !== null &&
        isPlainObject(hit.site) &&
        hit.site.line === live.site.line &&
        hit.site.col === live.site.col
      ) {
        result.asks.push({ ...hit, cached: true })
        return hit.value
      }
      cacheVoidFrom = callSeq
    }
    const release = await askGate.acquire(callSeq) // concurrency 租户形状：超限排队，不失败
    try {
      const outcome = await typedAsk(journalingDriver, {
        stepId,
        prompt: instructions,
        deps: [],
        ...(schema !== undefined ? { schema } : {}),
        ...(agent !== undefined ? { agent } : {}),
        ...(model !== undefined ? { model } : {}),
      }, {
        now: nowFn,
        pollMs: pollDelay,
        title: `REEVE-E1 ${runId} ${stepId}`, // §2-1 锚点：REEVE-E1 <runId> 前缀（scheduler 同款）
      })
      if (!outcome.ok) {
        const payload = {
          callSeq,
          cacheKey,
          stepId,
          reason: outcome.reason,
          attempts: outcome.attempts,
          // C1 v2/P3：失败 ask 的作用点证据（buildPatchContext failedPoint 的盘上数据源；ask
          // 成功事件同款字段）。坐标域 = 脚本体/.ts 源文本（P4 唯一坐标域，TS 同域）；site 为
          // null（栈抓不到）时 bodyOffset 同为 null——context 面按「证据缺失」如实带 null。
          site: live.site,
          bodyOffset: bodyOffsetAt(script, bodyLineStarts, live.site),
          ...(Array.isArray(outcome.errors) ? { errors: outcome.errors } : {}),
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          ...(outcome.timeoutMs !== undefined ? { timeoutMs: outcome.timeoutMs } : {}),
        }
        result.askFailures.push(payload)
        recordScriptEvent('ask-failed', payload, `ask-failed(${stepId})`)
        throw Object.assign(
          codeError(
            'E1_SCRIPT_ASK_FAILED',
            `F.ask 第 ${callSeq} 次调用失败（${outcome.reason}）：${(outcome.errors ?? []).join('；') || brief(outcome.error) || outcome.reason}`,
          ),
          {
            outcome,
            callSeq,
            cacheKey,
            stepId,
            // C2 补段失败归类的定位证据：ask 作用点的脚本体字节偏移（patchFrom 比对域；
            // site null → offset null → 不参与归类）。诊断面附加键，不影响既有消费方。
            bodyOffset: bodyOffsetAt(script, bodyLineStarts, live.site),
          },
        )
      }
      const value = schema !== undefined ? outcome.value : outcome.text // schema 校验后对象 / 纯文本
      const entry = {
        callSeq,
        cacheKey,
        stepId,
        value,
        attempts: outcome.attempts,
        site: live.site, // C1 v2 作用点证据四件：resume 导入规则的命中复核输入（resume-script.js 读端）
        promptHash: live.promptHash,
        prefixHash: live.prefixHash,
        optsHash: live.optsHash,
        ...(typeof outcome.sessionId === 'string' ? { sessionId: outcome.sessionId } : {}),
      }
      result.asks.push(entry)
      recordScriptEvent('ask', entry, `ask(${stepId})`)
      return value
    } finally {
      try {
        release?.() // acquire 返回的释放闭包（自定义租户形状可能没有 .release 方法）
      } catch {
        /* 帽实现异常不回滚 ask 结果 */
      }
    }
  }

  /**
   * F.run：child_process spawn（引擎进程内）+ terminal-gate 纪律（'close' 才结论——stdio 排干；
   * 'error' 必捕不静默；timeout kill 后仍等 close 不孤儿）。非零退出码是值不是异常。
   */
  const run = (cmd, args, runOpts = {}) => {
    if (typeof cmd !== 'string' || cmd.length === 0) throw new TypeError(`F.run: cmd 必须是非空字符串（得到 ${typeof cmd}）`)
    if (args !== undefined && (!Array.isArray(args) || !args.every((a) => typeof a === 'string'))) {
      throw new TypeError('F.run: args 必须是字符串数组')
    }
    if (!isPlainObject(runOpts)) throw new TypeError('F.run: opts 必须是对象')
    for (const key of Object.keys(runOpts)) {
      if (!RUN_OPT_FIELDS.includes(key)) throw new TypeError(`F.run: 未知 opts 字段 "${key}"（允许：${RUN_OPT_FIELDS.join(', ')}）`)
    }
    const argList = args ?? []
    const { timeoutMs } = runOpts
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1)) {
      throw new TypeError(`F.run: opts.timeoutMs 必须是 ≥1 整数（毫秒；得到 ${timeoutMs}）`)
    }
    return execRun({ cmd, argList, timeoutMs })
  }

  function execRun({ cmd, argList, timeoutMs }) {
    return new Promise((resolve) => {
      const collected = { stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false }
      const collect = (slot, capFlag) => (chunk) => {
        if (collected[capFlag]) return
        const piece = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
        if (collected[slot].length + piece.length > SCRIPT_DEFAULTS.runOutputCap) {
          collected[slot] += piece.slice(0, Math.max(0, SCRIPT_DEFAULTS.runOutputCap - collected[slot].length))
          collected[capFlag] = true
        } else {
          collected[slot] += piece
        }
      }
      let child = null
      let spawnError = null
      let timedOut = false
      let settled = false
      const finish = (exitCode) => {
        if (settled) return
        settled = true
        const shape = {
          exitCode,
          stdout: collected.stdout,
          stderr: collected.stderr,
          ...(timedOut ? { timedOut: true } : {}),
          ...(spawnError !== null ? { spawnError: { code: spawnError?.code ?? null, message: brief(spawnError) } } : {}),
        }
        const stdoutPreview = shape.stdout.slice(0, SCRIPT_DEFAULTS.runPreviewCap)
        const stderrPreview = shape.stderr.slice(0, SCRIPT_DEFAULTS.runPreviewCap)
        // truncated 统一口径：收集侧截断或预览截断都算（面板可见「只展示了一部分」；全文只回给脚本）
        const payload = {
          cmd,
          args: [...argList],
          exitCode,
          ...(timedOut ? { timedOut: true } : {}),
          ...(spawnError !== null ? { spawnError: shape.spawnError } : {}),
          stdout: stdoutPreview,
          stdoutTruncated: collected.stdoutTruncated || collected.stdout.length > stdoutPreview.length,
          stderr: stderrPreview,
          stderrTruncated: collected.stderrTruncated || collected.stderr.length > stderrPreview.length,
        }
        result.runs.push(shape)
        recordScriptEvent('run', payload, `run(${cmd})`)
        resolve(shape)
      }
      try {
        child = doSpawn(cmd, argList, { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        spawnError = error
        finish(null)
        return
      }
      child.stdout?.on?.('data', collect('stdout', 'stdoutTruncated'))
      child.stderr?.on?.('data', collect('stderr', 'stderrTruncated'))
      child.on?.('error', (error) => {
        spawnError = error // terminal-gate：spawn 失败必捕；'close' 仍会来（Node 保证 error 后 close）
      })
      child.on?.('close', (code) => finish(code))
      if (timeoutMs !== undefined) {
        void sleepFn(timeoutMs).then(() => {
          if (settled) return
          timedOut = true
          try {
            child.kill?.('SIGTERM')
          } catch {
            /* kill 失败不掩盖超时事实；close 竞跑继续 */
          }
        })
      }
    })
  }

  const phase = (name) => {
    if (typeof name !== 'string' || name.length === 0) throw new TypeError(`F.phase: name 必须是非空字符串（得到 ${typeof name}）`)
    result.phases.push(name)
    recordScriptEvent('phase', { name }, `phase(${name})`)
  }

  /** hole/escalate 共核：journal 挂起记账 → 通知 → 轮询答复源（先落盘再动作；答复也先落账）。 */
  const suspendForAnswer = async (kind, seq, name, question) => {
    if (typeof answerFor !== 'function') {
      throw codeError('E1_SCRIPT_NO_ANSWER_SOURCE', `F.${kind}: 引擎未接 answerFor 答复源（opts.answerFor）——问句无人可答，拒绝挂起`)
    }
    const record = { kind, runId, seq, ...(name !== undefined ? { name } : {}), question, at: nowFn() }
    result.holes.push({ ...(name !== undefined ? { name } : {}), question, answer: null })
    recordScriptEvent(kind, { seq, ...(name !== undefined ? { name } : {}), question }, `${kind}(${name ?? ''})`)
    if (onHole) {
      try {
        onHole(record)
      } catch {
        /* 面板异常不回滚挂起（escalation.onEscalate 同款） */
      }
    }
    let errorStreak = 0
    while (true) {
      if (halted) throw haltError(`${kind}-answer`)
      let answer = null
      try {
        answer = await answerFor(record)
        errorStreak = 0
      } catch {
        errorStreak += 1 // 答复源异常本轮跳过（P4-E answerFor 同款）；连续超限 → 坏死，防热循环
        if (errorStreak >= answerLimit) {
          throw codeError('E1_SCRIPT_ANSWER_SOURCE_BROKEN', `F.${kind}: answerFor 连续 ${answerLimit} 次抛错——答复源坏死，按脚本失败收敛`)
        }
        await sleepFn(holeDelay)
        continue
      }
      if (typeof answer === 'string' && answer.length > 0) {
        const answered = { seq, ...(name !== undefined ? { name } : {}), ...(kind === 'hole' ? {} : { question }), answer }
        recordScriptEvent(kind === 'hole' ? 'hole-answered' : 'escalate-answered', answered, `${kind}-answered`)
        result.holes[result.holes.length - 1].answer = answer
        return answer
      }
      await sleepFn(holeDelay) // 未答：睡 holePollMs 再拉（禁忙等；节奏由注入 sleep 承担）
    }
  }

  const hole = (name, prompt) => {
    if (typeof name !== 'string' || name.length === 0) throw new TypeError(`F.hole: name 必须是非空字符串（得到 ${typeof name}）`)
    if (typeof prompt !== 'string' || prompt.length === 0) throw new TypeError(`F.hole: prompt（问句）必须是非空字符串（得到 ${typeof prompt}）`)
    const seq = ++holeSeq
    return suspendForAnswer('hole', seq, name, prompt)
  }

  const escalate = (question) => {
    if (typeof question !== 'string' || question.length === 0) {
      throw new TypeError(`F.escalate: question 必须是非空字符串（得到 ${typeof question}）`)
    }
    const seq = ++holeSeq
    return suspendForAnswer('escalate', seq, undefined, question)
  }

  const log = (message) => {
    if (typeof message !== 'string' || message.length === 0) throw new TypeError(`F.log: message 必须是非空字符串（得到 ${typeof message}）`)
    result.logs.push(message)
    sinkLog(message)
    recordScriptEvent('log', { message }, 'log')
  }

  const facade = Object.freeze({ ask, run, phase, hole, escalate, log })

  // ---- 编译（语法错 = 脚本失败，零 journal 写、零 driver 调用）----
  // P4：.ts 脚本先经 compileScriptBodyAsync 剥类型（esbuild async transform——部署注记 ①只async；
  // 坐标系唯一 = .ts 源文本，tsSourceMap 供栈坐标映射），vm 编译 transform 产物——语法判定与
  // JS 路径同一 vm.Script 构造，零分叉。平台包缺失 → compileScriptBodyAsync 抛显式 Error（原则
  // 4 禁静默回退 JS）→ 按脚本失败收敛为 script-syntax，原文进 result.error/salvage。
  let main = null
  try {
    let compiled = null
    if (isTsScriptName(filename)) {
      const lowered = await compileScriptBodyAsync(script, filename)
      if (!lowered.ok) return finishFailed('script-syntax', lowered.errors.join('；'))
      tsSourceMap = lowered.sourceMap
      compiled = lowered.script
    } else {
      compiled = compileScriptBody(script, filename)
    }
    main = compiled.runInContext(vm.createContext({ console: routedConsole, now: nowFn }), {
      filename,
      displayErrors: true,
    })
  } catch (error) {
    return finishFailed('script-syntax', brief(error))
  }
  if (typeof main !== 'function') {
    return finishFailed('script-syntax', '包装产物不是函数（vm 完成值异常）')
  }

  // ---- 执行：main throw / facade 失败分类收敛（ask-failed / journal halted / 其余 = 脚本 throw）----
  // C2 补段失败归类（patchFrom 给出时）：失败点脚本体偏移 ≥ patchFrom（补段首个变更字节）→
  // reason='patch-failed'。ask-failed 用抛出点附带的 bodyOffset（ask 作用点证据）；script-threw
  // 现抓 vm 栈（siteFromStack 换算——栈上第一个本脚本帧即 throw 点；TS 先经 sourcemap 映射）。证据缺失（offset
  // null）或 < patchFrom → 维持原 reason；answer-source-error（环境失败）与 script-syntax
  // （整文件级，register 语法门已拦补段）不参与归类。
  const inPatchSegment = (offset) => patchFrom !== undefined && typeof offset === 'number' && offset >= patchFrom
  try {
    const value = await main(facade)
    if (halted) return finishBlocked(journal.status())
    return finishCompleted(value)
  } catch (error) {
    if (halted) return finishBlocked(journal.status())
    if (error?.code === 'E1_SCRIPT_ASK_FAILED') {
      // askFailure = typedAsk 失败 outcome + facade 键（callSeq/cacheKey/stepId）——诊断面；
      // 盘上台账在 ask-failed 事件（M2.2 只按 ask 事件返还，失败不进缓存）
      return finishFailed(inPatchSegment(error.bodyOffset) ? 'patch-failed' : 'ask-failed', brief(error), {
        askFailure:
          error.outcome === undefined
            ? null
            : { ...error.outcome, ...(error.callSeq !== undefined ? { callSeq: error.callSeq, cacheKey: error.cacheKey, stepId: error.stepId } : {}) },
      })
    }
    if (error?.code === 'E1_SCRIPT_ANSWER_SOURCE_BROKEN') {
      return finishFailed('answer-source-error', brief(error))
    }
    const throwOffset = bodyOffsetAt(script, bodyLineStarts, siteFromStack(error?.stack))
    return finishFailed(inPatchSegment(throwOffset) ? 'patch-failed' : 'script-threw', brief(error))
  }

  function finishCompleted(value) {
    result.status = 'completed'
    result.at = nowFn()
    if (value !== undefined) result.value = value
    emit('script-completed', { status: 'completed' })
    return result
  }

  function finishFailed(reason, error, extra = {}) {
    result.status = 'failed'
    result.reason = reason
    result.error = error
    result.at = nowFn()
    if (extra.askFailure !== undefined) result.askFailure = extra.askFailure
    emit('script-failed', { status: 'failed', reason, error })
    return result
  }

  function finishBlocked(status) {
    result.status = 'blocked'
    result.reason = SCRIPT_JOURNAL_NOT_OK
    result.journal = status
    result.at = nowFn()
    return result // halted：不再广播（scheduler 同口径）
  }
}
