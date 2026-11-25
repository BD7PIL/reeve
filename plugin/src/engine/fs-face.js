// E1 引擎 fs 面（P1.2 第 7 条：fs 注入缝）。
//
// scheduler.js 保持自身零内建依赖的既有纪律（时钟/journal/driver 全注入同款）——outputs 的
// 盘上检查（existsSync + statSync().isFile()）与 ~/ 展开（os.homedir()）经构造参数注入：
//   run(decl, { fs }) —— 测试/fault 注假 fs（计数桩），生产缺省用本文件的 DEFAULT_FS_FACE。
// 包装成普通函数再导出（不暴露 node:fs 原函数引用），注假面时调用形状与真实面逐位同。
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'

/** 默认 fs 面：生产用。三个函数名即 face 契约（scheduler 的校验器按 faces 清单核对）。 */
export const FS_FACE_FNS = Object.freeze(['existsSync', 'statSync', 'homedir'])

export const DEFAULT_FS_FACE = Object.freeze({
  existsSync: (p) => existsSync(p),
  statSync: (p) => statSync(p),
  homedir: () => homedir(),
})
