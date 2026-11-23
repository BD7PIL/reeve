// E1 引擎 hole（P4-H；蓝图 unified-run-plan-p0-p5.md §P4「hole 在飞不动/差量正确」，
// T4.2 门断言「在飞步 create 不打断、新步序正确」）。
//
// 职责：运行中交接（hole）的差量分类——把新声明对当前活跃计划的改动分成五类，纯函数
// 无副作用（journal 迁移与计划重建归 scheduler.js 的 applyHole 闭合面）。无时钟、无 IO、
// 无随机（§6；交接入口 hole.pull 经 scheduler 构造参数注入）。
//
// 口径（T4.2）：
//   已开始（pinned）＝ journal 态非 declared 的步（dispatching/running/done/failed/blocked/
//     superseded）或已 claimed（派发微任务窗口）——一律不动：不重派、不换内容、不废。新计划
//     点名了它们 → 按旧身冻结进新计划并记入 pinned；没点名 → 照旧带在活跃计划里（carried，
//     不进差量清单，保证 result 快照对已 done/failed/superseded 步不丢账）。hole 废弃过的步
//     （superseded）同属已开始——再次点名也不复活（superseded 终态无出边），要跑请换新 stepId。
//   未开始（declared 且未 claimed）按新声明差量替换：
//     kept    同 stepId 同字节 → 原样保留（journal declared 态原封不动）；
//     changed 同 stepId 异字节 → 换成新内容（journal 不重播种——declared 无内容，派发时取新步）；
//     dropped 未开始且新计划没有 → superseded（scheduler 写，payload reason='hole-drop'）；
//     added   新计划独有（journal 未注册）→ 播种 declared（scheduler 写）。
//   合并计划 merged ＝ 新声明全部步 + carried 旧步（新声明序在前，carried 按旧声明序在后）。
//   新声明自含（validateDeclaration 强制 deps ⊆ 自身 steps）⇒ kept/changed/added 步的 deps
//   不可能指向 dropped 步，依赖闭环由声明校验保证——差量替换不需要级联废弃。
//
// 内容相等 ＝ 整步规范化 JSON 逐字节相等（键排序递归；deps 变化也算 changed——图变了就是变了）。
/** 差量分类输入输出（详见文件头）。 */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 规范化 JSON 字符串（键排序递归）——步内容相等的比较基（与 driver.js 同款，本地副本保持依赖单向）。 */
function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (isPlainObject(v)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'undefined'
}

/**
 * 差量分类：当前活跃计划 × 新声明 → 五类清单 + 合并计划。
 * @param {object} args
 *   - currentSteps: 当前活跃计划的步对象数组（可能已含此前交接的合并结果）
 *   - knownOf:      (stepId) => journal 镜像态 | null——覆盖**所有**注册过的 id（含已被此前
 *                   交接废弃的；mirror 与 journal 成功写同步）
 *   - claimed:      Set——dispatchTask 在飞（含 cap 排队）的步，视同已开始
 *   - nextSteps:    新声明步对象数组（调用方已过 validateDeclaration + runId 同 run 校验）
 * @returns {{kept: string[], changed: string[], dropped: string[], pinned: string[],
 *            added: string[], merged: object[]}}
 *   kept/changed/pinned/added 按新声明序，dropped 按当前计划序；merged 见文件头。
 */
export function classifyHole({ currentSteps, knownOf, claimed, nextSteps }) {
  const nextById = new Map(nextSteps.map((s) => [s.stepId, s]))
  const started = (id) => {
    const st = knownOf(id)
    return (st !== null && st !== undefined && st !== 'declared') || claimed.has(id)
  }
  const kept = []
  const changed = []
  const dropped = []
  const pinned = []
  const added = []
  for (const step of nextSteps) {
    const id = step.stepId
    if (started(id)) {
      pinned.push(id) // 已开始：新计划点名也只按旧身冻结（不换内容、不重派）
      continue
    }
    const current = currentSteps.find((s) => s.stepId === id)
    if (current === undefined) added.push(id)
    else if (canonicalJson(current) === canonicalJson(step)) kept.push(id)
    else changed.push(id)
  }
  const carried = []
  for (const step of currentSteps) {
    const id = step.stepId
    if (!started(id)) {
      if (!nextById.has(id)) dropped.push(id) // 未开始且新计划没有 → 废
      continue // 未开始且在新计划 → 已在上面 kept/changed 记过
    }
    if (!nextById.has(id)) carried.push(step) // 已开始且新计划没点名 → 照旧带在活跃计划
  }
  // merged：新声明序在前；pinned 步替换回**旧步对象**（旧身冻结——在飞参数如 timeoutMs 不因
  // 交接而变；老对象已不在当前计划里的，如此前交接废弃过的步，只能沿用新对象且反正不派发）；
  // carried 按旧声明序殿后。
  const merged = []
  for (const step of nextSteps) {
    if (pinned.includes(step.stepId)) {
      const old = currentSteps.find((s) => s.stepId === step.stepId)
      merged.push(old ?? step)
    } else {
      merged.push(step)
    }
  }
  merged.push(...carried)
  return { kept, changed, dropped, pinned, added, merged }
}
