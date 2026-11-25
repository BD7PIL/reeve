// P4 C4 TS 前端（蓝图 next-round-plan-v4.md「P4 C4 TS 前端产品化」行；实证底座
// .zcode/plans/evidence/c4-esbuild-eval.md——宿主进程内 esbuild 0.28.2 async transform 判据步
// 全绿 + 五条部署注记）。JS 路径（script-runner compileScriptBody）零改动零回归：本文件只在
// 脚本名带 .ts 扩展名时被调用。
//
// 职责单一：TS **语法 only**——把 .ts 脚本函数体剥类型成 JS 文本喂 vm。JSDoc schema 合成延后
// （绑定语义未定义，登记下轮——蓝图显式偏离 C4 判据的最小子集收窄，此处不实现）。
//
// 依赖与分发纪律（蓝图写死 + C4 注记逐条落进实现）：
//   ① esbuild 是 plugin package.json dependencies（0.28.2 精确钉，与 extensions/reeve 构建件
//     同版）；平台二进制走 esbuild 自带 optionalDependencies（win32-x64 实测；**@esbuild/linux-x64
//     未测**——远端部署前按 C4 探针法复测，蓝图风险表在案）。
//   ② **平台包缺失显式报错，禁静默回退 JS**（原则 4）：import('esbuild') 失败 → lowering
//     返回 {ok:false, errors:[…平台包缺失…]}，调用方按各自失败面收敛（runScript → script-syntax
//     失败带原文；register/applyPatch 语法门 → ok:false errors）。绝不降级成 JS 编译。
//   ③ **只用 async API**（transform；禁 transformSync/buildSync——sync 会冻住宿主主循环，
//     C4 注记 ①）。esbuild 以**动态 import** 惰性加载：JS 路径永不加载 esbuild（进程内零新面），
//     首次 .ts 调用才 spawn `esbuild --service` 子进程（stdio 帧；native 崩溃被进程边界隔离，
//     C4 broken-binary 步正证）。
//   ④ `esbuild.stop()` 只在宿主 teardown 调（C4 注记 ④：stop 后下一调自动重拉 service；运行期
//     调 = 白扔一次冷启动）。本插件宿主面（src/index.js）无 teardown 挂点——stopTsFront 导出给
//     有 teardown 的宿主；宿主进程退出时 service 子进程随 stdio 断裂自然消亡，不调也安全。
//   ⑤ 冷启动 ~0.1s 一次性成本（C4 实测 105–122ms），warm ~2ms——无缓存层（每份拷贝一个
//     service 常驻，重复 transform 不重复 spawn）。
//
// 坐标系（蓝图写死：**.ts 源文本为唯一坐标域**）：esbuild transform **不保行数**（本 run 探针
// 实测：interface/type 声明行被整行删除，F.ask 行号漂移）——所以 vm 栈坐标（生成域）必须经
// sourcemap 映回 .ts 源文本（包装文本域 → 减 WRAPPER_BODY_LINE_BASE 得体域）。ask 作用点证据
// （site/prefixHash）、patchFrom 比对、failedPoint.bodyOffset 全部落在 .ts 源文本坐标——写端
// （首跑落账）与读端（resume 命中复核/补段归类）用同一映射函数，判定逐位一致；映射缺失
// （map 无该线段）→ 证据 null → 命中恒不过 / 归类不发明（script-runner 既有保守面原样兜底）。
//   sourcemap 的源 = **包装全文**（wrapScriptBody 产物，逐字节同 vm 编译输入）——映射出的行列
//   是包装文本域坐标，体域换算由 script-runner 统一减 WRAPPER_BODY_LINE_BASE（体域列不受头部
//   行影响，换算只动行）。
import vm from 'node:vm'

import { WRAPPER_BODY_LINE_BASE, wrapScriptBody } from './script-wrap.js'

/** TS 脚本的扩展名域（P4 最小子集：只 .ts；.mts/.cts 不收——蓝图收窄写死）。 */
export const TS_SCRIPT_EXTENSIONS = Object.freeze(['.ts'])

/** 脚本名/路径是否走 TS 前端（扩展名字符串判定；大小写敏感——repo 严格风格，不猜平台语义）。 */
export function isTsScriptName(scriptName) {
  return typeof scriptName === 'string' && TS_SCRIPT_EXTENSIONS.some((ext) => scriptName.endsWith(ext))
}

/** 平台包缺失（import('esbuild') 失败）的显式报错文案——禁静默回退 JS（原则 4），原文进各失败面。 */
export const TS_FRONT_UNAVAILABLE_PREFIX = 'TS 前端不可用'

let esbuildModule = null // 惰性加载缓存（JS 路径永不触碰；首次 .ts 调用才 import）

/** 内部缺省装载面（动态 import；失败 → 显式报错，禁静默回退 JS）。 */
async function loadEsbuildDefault() {
  if (esbuildModule !== null) return esbuildModule
  try {
    esbuildModule = await import('esbuild')
  } catch (error) {
    // 显式报错不缓存失败（装好平台包后下一调重试）；错误原文带回（ERR_MODULE_NOT_FOUND 等）
    esbuildModule = null
    throw new Error(
      `${TS_FRONT_UNAVAILABLE_PREFIX}：import('esbuild') 失败（${String(error?.message ?? error).slice(0, 200)}）` +
        '——esbuild 在 plugin dependencies（0.28.2 钉版），平台二进制走其 optionalDependencies' +
        '（win32-x64 实测；@esbuild/linux-x64 未测，远端部署前按 C4 探针法复测）。禁静默回退 JS。',
    )
  }
  return esbuildModule
}

// ---- sourcemap 解析（生成域坐标 → .ts 源文本坐标；VLQ 解码，纯函数无依赖）-------------------
//
// esbuild transform({sourcemap:'external'}) 返回标准 v3 map：mappings 按 `;` 分行、`,` 分段，
// 每段 VLQ 字段 [生成列, 源索引, 源行, 源列]（0 基，源行列相对上一段增量）。本仓只用
// 生成 → 源的行列映射（源索引/源文件名不消费——单文件包装文本，sources 恒一路）。

const B64_LOOKUP = new Map('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').map((c, i) => [c, i]))

/** 单段 VLQ 解码 → 数值数组（RFC 4648 base64-VLQ；符号在最低位）。 */
function decodeVlq(chunk) {
  const values = []
  let value = 0
  let shift = 0
  for (const ch of chunk) {
    const digit = B64_LOOKUP.get(ch)
    if (digit === undefined) throw new Error(`sourcemap: 非法 VLQ 字符 ${JSON.stringify(ch)}`)
    value += (digit & 31) * 2 ** shift
    if ((digit & 32) !== 0) {
      shift += 5
    } else {
      const negate = (value & 1) === 1
      value = Math.floor(value / 2)
      values.push(negate ? -value : value)
      value = 0
      shift = 0
    }
  }
  return values
}

/**
 * 解析 esbuild 的 v3 sourcemap JSON → 按生成行（0 基）分桶的段表。
 * 形状坏的 map → null（调用方按「无映射」收敛——证据 null 走既有保守面，不发明坐标）。
 * @returns {Array<Array<{genCol: number, srcLine: number, srcCol: number}>> | null} 0 基行列
 */
export function parseSourceMap(mapJson) {
  let map
  try {
    map = typeof mapJson === 'string' ? JSON.parse(mapJson) : mapJson
  } catch {
    return null
  }
  if (!map || typeof map !== 'object' || typeof map.mappings !== 'string') return null
  const lines = []
  let srcLine = 0
  let srcCol = 0
  for (const lineChunk of map.mappings.split(';')) {
    const segments = []
    let genCol = 0 // 生成列增量**每行清零**（v3 spec：源行列跨行跨段累积，生成列行内累积）
    if (lineChunk.length > 0) {
      for (const segChunk of lineChunk.split(',')) {
        if (segChunk.length === 0) continue
        let fields
        try {
          fields = decodeVlq(segChunk)
        } catch {
          return null // 映射面坏 = 无映射（宁弃用证据，不发明坐标）
        }
        if (fields.length < 4) continue // 1 字段段（仅生成列，无源映射）不承载映射
        const [genColDelta, , srcLineDelta, srcColDelta] = fields
        genCol += genColDelta
        srcLine += srcLineDelta
        srcCol += srcColDelta
        segments.push({ genCol, srcLine, srcCol })
      }
    }
    lines.push(segments)
  }
  return lines
}

/**
 * 生成域位置 → .ts 源文本（包装域）位置。取该生成行上 ≤ 生成列的最后一个段（esbuild 逐 token
 * 出段，栈帧列通常落在段首）；行首之前无段则夹取首段。映射不到（行越界/无段）→ null。
 * @param {Array<Array<{genCol: number, srcLine: number, srcCol: number}>>} sourceMap parseSourceMap 产物
 * @param {number} genLine 生成域行号（1 基，vm 栈口径）
 * @param {number} genCol 生成域列号（1 基，vm 栈口径）
 * @returns {{line: number, col: number} | null} 包装文本域行列（1 基）
 */
export function generatedToSource(sourceMap, genLine, genCol) {
  if (!Array.isArray(sourceMap)) return null
  if (!Number.isInteger(genLine) || genLine < 1 || !Number.isInteger(genCol) || genCol < 1) return null
  const segments = sourceMap[genLine - 1]
  if (!Array.isArray(segments) || segments.length === 0) return null
  let chosen = segments[0]
  for (const segment of segments) {
    if (segment.genCol <= genCol - 1) chosen = segment
    else break
  }
  return { line: chosen.srcLine + 1, col: chosen.srcCol + (genCol - 1 - chosen.genCol) + 1 }
}

/**
 * TS 脚本函数体的编译门 + 降低（P4 唯一 TS 编译入口；register/applyPatch/runScript 三处同一
 * 函数——语法判定零分叉，与 JS 路径共用 compileScriptBody 的纪律同款）。
 *
 * 流程：wrapScriptBody（与 vm 编译逐字节同一包装）→ esbuild transform（loader:'ts'，
 * charset:'utf8'——非 ASCII prompt 不转义成 \uXXXX；sourcemap:'external'——坐标系唯一性的映射
 * 源；async API，C4 注记 ①）→ vm.Script（transformed，filename 同 JS 路径——栈帧名一致，
 * captureAskSite 的正则不加分支）。
 *
 * @param {string} body TS 脚本函数体（非空字符串）
 * @param {string} scriptName vm filename（须 .ts 结尾；调用方先用 isTsScriptName 分流）
 * @param {object} [opts]
 *   - loadEsbuild: () => Promise<esbuild 模块形状>（缺省内部动态 import('esbuild')；测试注入
 *     「缺平台包的 esbuild 副本」做故障缝——§6 纪律：故障经构造参数注入，禁 monkey-patch）
 * @returns {Promise<{ok:true, script: vm.Script, jsText: string, sourceMap: Array}|{ok:false, errors: string[]}>}
 *   script = vm 编译产物（runScript 直接 runInContext；register/applyPatch 只用 ok/errors 面——
 *   编译成功本身即语法门通过）。sourceMap = parseSourceMap 产物（可能 null——映射面坏时编译仍
 *   可用，坐标证据走 null 保守面）。
 * @throws {Error} 平台包缺失（显式文案，见 TS_FRONT_UNAVAILABLE_PREFIX）——调用方不捕获降级。
 */
export async function compileScriptBodyAsync(body, scriptName, opts = {}) {
  if (typeof body !== 'string' || body.length === 0) throw new TypeError('compileScriptBodyAsync: body 必须是非空字符串（脚本函数体）')
  if (!isTsScriptName(scriptName)) {
    throw new TypeError(`compileScriptBodyAsync: scriptName 必须以 ${TS_SCRIPT_EXTENSIONS.join('|')} 结尾（得到 ${String(scriptName)}）——JS 脚本走 compileScriptBody`)
  }
  const { loadEsbuild } = opts ?? {}
  if (loadEsbuild !== undefined && typeof loadEsbuild !== 'function') {
    throw new TypeError('compileScriptBodyAsync: opts.loadEsbuild 必须是 () => Promise<esbuild 模块形状>（测试注入面）')
  }
  const esbuild = await (loadEsbuild ?? loadEsbuildDefault)()
  const wrapped = wrapScriptBody(body)
  let lowered
  try {
    lowered = await esbuild.transform(wrapped, { loader: 'ts', charset: 'utf8', sourcemap: 'external', sourcefile: scriptName })
  } catch (error) {
    // esbuild 语法/解析错：error.errors 数组（{text, location?}）；兜底 message
    const messages = Array.isArray(error?.errors) && error.errors.length > 0
      ? error.errors.map((e) => {
          const at = e.location ? `（${e.location.line}:${e.location.column}）` : ''
          return `${String(e.text ?? e)}${at}`.slice(0, 200)
        })
      : [String(error?.message ?? error).slice(0, 200)]
    return { ok: false, errors: messages.map((m) => `TS 前端：${m}`) }
  }
  const sourceMap = parseSourceMap(lowered.map)
  let script
  try {
    script = new vm.Script(lowered.code, { filename: scriptName })
  } catch (error) {
    // transform 过而 vm 编译不过 = 引擎包装面意外（transform 产物语义漂移）——如实报语法错，
    // 不发明第二个编译面；三处调用方（register/applyPatch/runScript）拿同一 ok:false。
    return { ok: false, errors: [`TS 前端：transform 后 vm 编译不过（${String(error?.message ?? error).slice(0, 160)}）`] }
  }
  return { ok: true, script, jsText: lowered.code, sourceMap }
}

/**
 * 停掉 esbuild service 子进程（C4 注记 ④：**只在宿主 teardown 调**；运行期调了下一调会重拉
 * service——白扔一次 ~0.1s 冷启动）。本仓宿主面无 teardown 挂点（src/index.js setup-only），
 * 导出给有 teardown 的宿主；宿主进程退出时 service 随 stdio 断裂自然消亡，不调也安全。
 * 从未加载过 esbuild（纯 JS 会话）→ 空操作。
 */
export async function stopTsFront() {
  if (esbuildModule === null) return
  try {
    esbuildModule.stop?.()
  } catch {
    /* stop 失败不掩盖任何脚本事实（service 进程生命周期归 esbuild） */
  }
  esbuildModule = null
}

/** 头部行基数（体域换算用——script-runner 与本文件共享同一常量，经 script-wrap 单源）。 */
export { WRAPPER_BODY_LINE_BASE }
