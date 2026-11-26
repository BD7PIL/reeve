// 台账快照：把内存里的账**投影**成一份 JSON 文件，给只读面板（openchamber 扩展）读。
//
// 为什么是"投影"而不是"第二份真相"：
//   权威仍然是 ctx.storage 里的记录；这个文件只是给人看的视图。
//   面板**只读**它，永远不会写回 —— 也就不会出现两处互相覆盖。
//
// 为什么用文件而不是让面板读 ctx.storage：
//   面板跑在 openchamber 的 iframe 里（浏览器环境、有 CSP、无网络），
//   拿不到引擎的 SQLite；而宿主给了它一个 `readFile` 能力。
//   → 文件是两边唯一都够得着的通道。
//
// 原子性：先写 `<path>.tmp` 再 rename。面板永远看不到半截 JSON。
// 失败只记日志：**记账的正确性绝不依赖这个文件**。

import { mkdir, rename, writeFile, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

export class SnapshotWriter {
  #path
  #logger
  #debounceMs
  #timer = null
  #building = null
  #dirty = false

  constructor({ path, logger = console, debounceMs = 250 } = {}) {
    if (!path) throw new Error('SnapshotWriter 需要 path')
    this.#path = path
    this.#logger = logger
    this.#debounceMs = debounceMs
  }

  get path() {
    return this.#path
  }

  /** 记账变了：合并成一次写（250ms 内的连续变化只落一次盘）。 */
  schedule(build) {
    this.#building = build
    this.#dirty = true
    if (this.#timer) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.flush()
    }, this.#debounceMs)
    // 定时器不该拖住进程退出（Node 独有；宿主里 also fine）
    this.#timer?.unref?.()
  }

  cancel() {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }

  /** 立刻写一次。返回是否真的写了（false = 没有变化）。 */
  async flush() {
    if (!this.#dirty || !this.#building) return false
    this.#dirty = false
    let doc
    try {
      doc = this.#building()
    } catch (err) {
      this.#logger?.debug?.(`[reeve] 快照构建失败（忽略）：${String(err)}`)
      return false
    }
    const tmp = `${this.#path}.tmp`
    try {
      await mkdir(dirname(this.#path), { recursive: true })
      await writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8')
      await rename(tmp, this.#path)
      return true
    } catch (err) {
      this.#logger?.debug?.(`[reeve] 快照写入失败（忽略）：${String(err)}`)
      try {
        await unlink(tmp)
      } catch {
        /* 清不掉就算了 */
      }
      return false
    }
  }
}

/**
 * 把台账投影成面板要的形状。
 * **注意**：这里刻意只放面板显示需要的字段 —— 不多不少，免得这份文件变成事实上的第二套接口。
 *
 * `agents`：启动时从引擎读到的 agent 表（谁在前台可见 / 谁被藏）。
 * 为什么放进快照：`opencode debug agents` 走的是 CLI 自己连的那个服务，
 * 未必是你以为的那个引擎（实测踩过 —— 它连到另一个 HOME 的服务，报出别人的表）。
 * 这一份是**引擎进程内部**读的，落盘可核对，也是"前台只出现编排者"这条设计的证据。
 */
export function buildSnapshot(
  records,
  { now = Date.now(), version = null, agents = null, roster = null, registered = null, endpoint = null, models = null, free = null, stats = null, gate = null, engine = null } = {},
) {
  const tasks = records
    .map((r) => ({
      taskID: r.taskID,
      parentSessionID: r.parentSessionID ?? null,
      childSessionID: r.childSessionID ?? null,
      agent: r.agent ?? null,
      description: r.description ?? null,
      background: r.background === true,
      state: r.state ?? null,
      reason: r.reason ?? null,
      terminalSource: r.terminalSource ?? null,
      timedOut: r.timedOut === true,
      statusUncertain: r.statusUncertain === true,
      startedAt: r.startedAt ?? null,
      endedAt: r.endedAt ?? null,
    }))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))

  const counts = { total: tasks.length, running: 0, completed: 0, error: 0, stopped: 0, reconciled: 0 }
  for (const t of tasks) {
    if (Object.prototype.hasOwnProperty.call(counts, t.state)) counts[t.state] += 1
  }

  return {
    generatedAt: now,
    plugin: 'reeve',
    version,
    agentTable: agents,
    roster,
    gate,
    models,
    free,
    registered,
    endpoint,
    stats,
    engine,
    counts,
    tasks,
  }
}

/**
 * E1 引擎运行的快照投影（M2.5② 面板步卡的数据源；visualization 的报告面在
 * src/engine/visualize.js——那是 markdown 报告用的 mermaid 渲染器，这份是面板要的最小形状）。
 *
 * @param {Array<{runId, kind?, status?, startedAt?, updatedAt?, steps?, phases?, summary?, commands?, forks?}>} runs 引擎运行台账
 *   （producer 侧接线；v1 还没有常驻 registry——接线点留给引擎 run 入口，形状现在定死：
 *   runId: string · kind: 'declaration'|'script' · status: 'running'|'completed'|'failed'|'blocked'
 *   · startedAt: number（可选，run 起点——面板算耗时；缺了不画，绝不拿 updatedAt 冒充）
 *   · updatedAt: number · steps: [{stepId, state(journal 七态), attempts, deps?, description?}]
 *   （deps = 声明路径的依赖名表，D 线 DAG 视图用；声明路径才有）· phases: string[]
 *   （脚本路径的 phase 名序表；声明路径没有）· summary: string（workflow-script 审批卡的脚本摘要，可选）
 *   · commands: string[]（静态扫描命令集 scanRunCommands 产物，可选）· forks: string[]（分叉说明，可选）。
 *   纯投影：逐字段挑拣 + 只读容错（垃圾条目按原样丢非对象字段，面板渲染侧再兜一层）。
 * @returns {{runs: *}|null} 没有运行返回 null（快照里没有这一节，不假装有——gate/stats 同款）。
 */
export function projectEngineRuns(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return null
  const projected = runs
    .filter((r) => r !== null && typeof r === 'object' && !Array.isArray(r) && typeof r.runId === 'string' && r.runId.length > 0)
    .map((r) => ({
      runId: r.runId,
      kind: r.kind === 'script' ? 'script' : 'declaration',
      status: typeof r.status === 'string' ? r.status : null,
      startedAt: typeof r.startedAt === 'number' && Number.isFinite(r.startedAt) ? r.startedAt : null,
      updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : null,
      steps: Array.isArray(r.steps)
        ? r.steps
            .filter((s) => s !== null && typeof s === 'object' && !Array.isArray(s) && typeof s.stepId === 'string' && s.stepId.length > 0)
            .map((s) => ({
              stepId: s.stepId,
              state: typeof s.state === 'string' ? s.state : null,
              attempts: Number.isInteger(s.attempts) && s.attempts > 0 ? s.attempts : 1,
              deps: Array.isArray(s.deps) ? s.deps.filter((d) => typeof d === 'string' && d.length > 0) : [],
              // Q5b：声明步的人话标签透传（Q5 加进 schema）；没有/非字符串 → null，面板回退 stepId
              description: typeof s.description === 'string' && s.description.length > 0 ? s.description : null,
            }))
        : [],
      phases: Array.isArray(r.phases) ? r.phases.filter((p) => typeof p === 'string' && p.length > 0) : [],
      summary: typeof r.summary === 'string' && r.summary.length > 0 ? r.summary : null,
      commands: Array.isArray(r.commands) ? r.commands.filter((c) => typeof c === 'string' && c.length > 0) : [],
      forks: Array.isArray(r.forks) ? r.forks.filter((f) => typeof f === 'string' && f.length > 0) : [],
    }))
  return { runs: projected }
}

/**
 * 从 `ctx.agent.list()` 的返回里抽出"谁可见"的最小形状。
 * 读不到就返回 null —— 快照里没有这一节，不假装知道。
 */
export function projectAgentTable(list) {
  if (!Array.isArray(list)) return null
  const one = (a) => ({ id: a?.id ?? null, mode: a?.mode ?? null, hidden: a?.hidden === true })
  return {
    total: list.length,
    visible: list.filter((a) => a?.mode !== 'subagent' && a?.hidden !== true).map(one),
    hidden: list.filter((a) => a?.hidden === true).map(one),
    subagent: list.filter((a) => a?.mode === 'subagent' && a?.hidden !== true).map(one),
  }
}