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
export function buildSnapshot(records, { now = Date.now(), version = null, agents = null, roster = null, proxy = null, registered = null } = {}) {
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
    proxy,
    registered,
    counts,
    tasks,
  }
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