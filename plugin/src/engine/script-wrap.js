// 脚本包装单一事实源（P4 拆出；此前 SANDBOX_PREAMBLE/wrapper 内联在 script-runner.js）。
//
// 为什么独立成文件：TS 前端（ts-front.js）必须用**逐字节相同**的包装文本做 esbuild transform
// 输入，runScript 的语法门与栈坐标换算（WRAPPER_BODY_LINE_BASE）也都建立在它之上——包装出现
// 两份实现 = 语法判定/坐标域分叉。单一来源在此，script-runner 与 ts-front 各自 import，零环。
//
// 包装形状（M2.1 写死）：`<preamble>(async function main(F) {\n<body>\n})`——表达式语句的
// 完成值 = main 函数；preamble 占 3 行 + 包装开行 1 行 = 函数体之前的头部行数
// （WRAPPER_BODY_LINE_BASE），vm 栈行号 → 脚本体行号的换算基数。

/** 沙箱 preamble：删 Date 绑定（intrinsic，缺席即 ReferenceError）与 Math.random（删后调用 = TypeError）。 */
export const SANDBOX_PREAMBLE = '"use strict";\ndelete globalThis.Date;\ndelete globalThis.Math.random;\n'

/** 包装头部占用的行数（preamble 3 行 + `(async function main(F) {` 1 行）。 */
export const WRAPPER_BODY_LINE_BASE = (SANDBOX_PREAMBLE.match(/\n/g) ?? []).length + 1

/**
 * 函数体 → 包装全文（vm 编译与 TS transform 的共同输入）。正文 = 脚本体逐字节原样（JS 路径）；
 * TS 路径由 ts-front.js 对包装全文 transform，坐标系仍以 .ts 源文本为唯一坐标域（ts-front 的
 * sourcemap 把生成域坐标映回本包装文本，再减本基数得体坐标）。
 */
export function wrapScriptBody(body) {
  return `${SANDBOX_PREAMBLE}(async function main(F) {\n${body}\n})`
}
