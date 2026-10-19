// REEVE 记账层 —— opencode v2 插件入口。
//
// 施工图（写代码前必读）：docs/research/opencode-v2-plugin-api.md
//
// 五处挂载点：
//   ① 拦 subagent（并发闸门，子会话创建之前）  ctx.tool.hook("execute.before")
//   ② 落台账                                   ctx.tool.hook("execute.after")
//   ③ 认终态                                   ctx.event.subscribe() → session.execution.*
//   ④ 墙钟                                     Supervisor（每任务一次性定时器）
//   ⑤ 落盘 + 对账                              ctx.storage + ctx.session.hook("prompt")
//
// 铁律：**本插件绝不写 `agents.*.model`** —— 那是与 openchamber 面板抢配置
// （openchamber#3881：面板保存 agent 会静默压掉预设）。插件只注册工具 + 挂 hook。

import {
  PLUGIN_ID,
  PLUGIN_VERSION,
  REASON,
  STATE,
  TOOL_NAMESPACE,
} from './constants.js'
import { Ledger } from './ledger.js'
import { acquireAdmissionRuntime } from './concurrency.js'
import { Supervisor } from './supervisor.js'
import { reconcileParent } from './reconcile.js'
import { SnapshotWriter, buildSnapshot } from './snapshot.js'

const SUBAGENT_TOOL = 'subagent'

export default {
  id: PLUGIN_ID,

  async setup(ctx) {
    const logger = makeLogger()
    const options = ctx.options ?? {}
    const limits = options.limits ?? {}
    const wallClockMs = options.wallClockMs ?? 0
    const abortGraceMs = options.abortGraceMs

    const ledger = new Ledger({ storage: ctx.storage, logger })
    const restored = await ledger.hydrate()
    logger.debug(
      `[reeve] 已启动；从盘上恢复 ${restored.loaded} 条台账记录` +
        (restored.truncated ? '（⚠️ 可能不完整，见上一条告警）' : ''),
    )
    // 保留期修剪：只动已落终态的旧记录，在飞的一律不动。
    const retentionDays = Number(options.retentionDays ?? 30)
    if (retentionDays > 0) {
      try {
        const removed = await ledger.prune({ olderThanMs: retentionDays * 24 * 60 * 60 * 1000 })
        if (removed > 0) logger.debug(`[reeve] 修剪了 ${removed} 条超过 ${retentionDays} 天的终态记录`)
      } catch (err) {
        logger.debug(`[reeve] 修剪失败（忽略）：${String(err)}`)
      }
    }

    // 只读快照（给 openchamber 面板）：**opt-in** —— 只有部署时给了 snapshotPath 才写。
    // 它是投影，不是第二份真相：面板只读它，永不写回。
    // 失败只记日志：**记账的正确性绝不依赖这个文件**。
    const snapshotPath = options.snapshotPath ?? null
    let snapshot = null
    if (snapshotPath) {
      snapshot = new SnapshotWriter({ path: snapshotPath, logger })
      const build = () => buildSnapshot(ledger.all(), { version: PLUGIN_VERSION })
      ledger.onChange = () => snapshot.schedule(build)
      snapshot.schedule(build)
      void snapshot.flush().catch(() => {})
      logger.debug(`[reeve] 台账快照开启：${snapshotPath}`)
    }

    const admission = acquireAdmissionRuntime(ctx.location?.directory, { limits })
    const supervisor = new Supervisor({
      ledger,
      logger,
      abortGraceMs,
      interrupt: async (record) => {
        if (!record.childSessionID) return
        // v2 的中断：恰好一次，且 resume:false（不要它接着跑）
        await ctx.session.interrupt({ sessionID: record.childSessionID, resume: false })
      },
    })

    // 工具调用 id -> 槽位释放函数（execute.before 取，execute.after 放）
    const held = new Map()

    // ---- 工具：reeve_task_status（只读）----
    // ⚠️ options 里 **两个都要**：namespace 负责命名，codemode:false 才是"暴露给模型"的开关。
    await ctx.tool.transform((editor) => {
      editor.add({
        name: 'task_status',
        description:
          '查询本编排层的子任务台账：谁在跑、谁结束了、有没有静默死亡或超时。' +
          '只读，不会启动/中断/修改任何任务。',
        input: {
          type: 'object',
          properties: {
            parentSessionID: { type: 'string', description: '只看这个父会话派出去的子任务；省略则看全部' },
            includeTerminal: { type: 'boolean', description: '是否连已结束的也返回（默认 false）' },
          },
          additionalProperties: false,
        },
        output: { type: 'string' },
        options: { namespace: TOOL_NAMESPACE, codemode: false },
        execute: async (args) => {
          const includeTerminal = args?.includeTerminal === true
          const rows = ledger
            .all()
            .filter((r) => (args?.parentSessionID ? r.parentSessionID === args.parentSessionID : true))
            .filter((r) => (includeTerminal ? true : r.state === STATE.RUNNING))
            .map((r) => ({
              taskID: r.taskID,
              parent: r.parentSessionID,
              child: r.childSessionID,
              agent: r.agent,
              description: r.description,
              background: r.background,
              state: r.state,
              reason: r.reason,
              uncertain: r.statusUncertain,
              timedOut: r.timedOut,
              startedAt: new Date(r.startedAt).toISOString(),
              endedAt: r.endedAt ? new Date(r.endedAt).toISOString() : null,
            }))
          return {
            output: JSON.stringify({ count: rows.length, tasks: rows }, null, 2),
            metadata: { count: rows.length },
          }
        },
      })
    })

    // ---- ① 并发闸门（子会话创建之前）+ ② 落台账 ----
    await ctx.tool.hook('execute.before', async (event) => {
      if (event.tool !== SUBAGENT_TOOL) return
      const input = event.input ?? {}

      // (a) 嵌套的受管任务豁免：调用方自己就是被本插件管着的子会话 —— 它已持槽。
      const nested = ledger.forChildSession(event.sessionID) != null

      const key = `${event.sessionID}:${event.id}`
      const release = await admission.acquire(key, {
        model: input.model ?? null,
        provider: null,
        nested,
        signal: null,
      })
      held.set(key, release)
      logger.debug(
        `[reeve] 派发 ${input.agent ?? '?'}（父 ${event.sessionID}${nested ? '，嵌套豁免' : ''}）` +
          `；在飞 ${admission.activeCount}，排队 ${admission.waitingCount}`,
      )
    })

    await ctx.tool.hook('execute.after', async (event) => {
      if (event.tool !== SUBAGENT_TOOL) return

      const key = `${event.sessionID}:${event.id}`
      const release = held.get(key)
      if (release) {
        held.delete(key)
        release()
      }

      const input = event.input ?? {}
      const taskID = `${event.id}`
      const existing = ledger.get(taskID)

      if (!existing) {
        ledger.create({
          taskID,
          parentSessionID: event.sessionID,
          agent: input.agent ?? null,
          description: input.description ?? null,
          background: input.background === true,
          model: input.model ?? null,
        })
      }

      if (event.status === 'error') {
        // 工具自身失败（例如权限被拒）—— 这不是"子任务跑了然后死了"，直接落终态。
        ledger.commitTerminal(taskID, STATE.ERROR, {
          source: 'tool-result',
          reason: String(event.error ?? 'subagent tool error').slice(0, 200),
        })
        supervisor.disarm(taskID)
        return
      }

      const childSessionID = extractChildSessionID(event.result)
      if (childSessionID) ledger.attachChild(taskID, childSessionID)

      const backgrounded = input.background === true
      if (backgrounded) {
        supervisor.arm(taskID, wallClockMs)
      } else {
        // 前台调用：工具已经同步返回，直接落终态（宿主的 execution 事件也会到，
        // 但那条会被 commitTerminal 的单调性挡掉，不会重复写）。
        ledger.commitTerminal(taskID, STATE.COMPLETED, { source: 'tool-result' })
        supervisor.disarm(taskID)
      }
      logger.debug(`[reeve] 落账 ${taskID} → ${ledger.get(taskID)?.state}`)
    })

    // ---- ③ 认终态 ----
    const abort = new AbortController()
    ;(async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          const type = String(event?.type ?? '')
          if (!type.startsWith('session.execution.')) continue

          const sessionID = event?.sessionID ?? event?.data?.sessionID
          if (!sessionID) continue
          const record = ledger.forChildSession(sessionID)
          if (!record) continue

          if (type === 'session.execution.succeeded') {
            ledger.commitTerminal(record.taskID, STATE.COMPLETED, { source: 'event' })
          } else if (type === 'session.execution.failed') {
            ledger.commitTerminal(record.taskID, STATE.ERROR, {
              source: 'event',
              reason: String(event?.error ?? '').slice(0, 200),
            })
          } else if (type === 'session.execution.interrupted') {
            // ⚠️ 关键归因：如果我们自己发过中断（墙钟到期），这条事件是**我们造成的**，
            // 必须记成"墙钟超时"，不能记成"宿主中断" —— 否则 timedOut 永远是 false。
            if (record.interruptReason === 'wall_clock') {
              ledger.commitTerminal(record.taskID, STATE.ERROR, {
                source: 'wall-clock',
                reason: REASON.WALL_CLOCK_TIMEOUT,
                timedOut: true,
                statusUncertain: true,
                terminalUnreconciled: true,
              })
            } else {
              const reason = event?.reason ?? 'unknown'
              ledger.commitTerminal(record.taskID, STATE.STOPPED, {
                source: 'event',
                reason: `${REASON.HOST_INTERRUPTED}:${reason}`,
              })
            }
          } else {
            continue
          }
          supervisor.disarm(record.taskID)
        }
      } catch (err) {
        if (!abort.signal.aborted) logger.debug(`[reeve] 事件流结束：${String(err)}`)
      }
    })()

    // ---- ⑤ 惰性对账（父会话下一次活动时）----
    await ctx.session.hook('prompt', async (event) => {
      try {
        const result = await reconcileParent({
          ctx,
          ledger,
          logger,
          parentSessionID: event?.sessionID,
        })
        if (result.reconciled > 0) {
          logger.debug(`[reeve] 对账完成：${JSON.stringify(result)}`)
        }
      } catch (err) {
        logger.debug(`[reeve] 对账失败（忽略）：${String(err)}`)
      }
    })

    return () => {
      abort.abort()
      supervisor.stopAll()
      if (snapshot) {
        snapshot.cancel()
        void snapshot.flush().catch(() => {})
      }
      logger.debug('[reeve] 已卸载')
    }
  },
}

/**
 * 从 `subagent` 工具的返回里取子会话 id。
 * 优先结构化字段（施工图 §8）：`{ sessionID, status, output }`；
 * 退化到文本正则（后台提示里的 `(sessionID: <id>)`、完成通知的 `<subagent sessionID="<id>"`）。
 */
function extractChildSessionID(result) {
  if (!result || typeof result !== 'object') return null
  const direct = result?.output?.sessionID ?? result?.metadata?.sessionID
  if (typeof direct === 'string' && direct) return direct

  const text =
    typeof result?.content === 'string'
      ? result.content
      : Array.isArray(result?.content)
        ? result.content.map((c) => c?.text ?? '').join('')
        : typeof result?.output?.output === 'string'
          ? result.output.output
          : ''
  const m =
    text.match(/\(sessionID:\s*(ses_[A-Za-z0-9_-]+)\)/) ??
    text.match(/<subagent\s+sessionID="(ses_[A-Za-z0-9_-]+)"/) ??
    text.match(/sessionID:\s*(ses_[A-Za-z0-9_-]+)/)
  return m ? m[1] : null
}

function makeLogger() {
  const prefix = (msg) => `${msg}`
  return {
    debug: (msg) => {
      // 走 stderr；`opencode run --print-logs` 能看到
      console.error(prefix(String(msg)))
    },
  }
}
