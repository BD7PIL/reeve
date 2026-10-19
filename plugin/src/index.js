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
// 外加一处"补名册"：ctx.session.hook("context") 把 subagent 名册接进
// `subagent` 工具的描述 —— 7 个 subagent 都标了 hidden（前台不可见），
// 引擎自己的"可用 subagent"宣传段会把它们滤掉，这一钩子把名册补回去
// （人看不见，模型看得见）。见 src/roster.js。
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
import { homedir } from 'node:os'
import { join } from 'node:path'

import { Ledger } from './ledger.js'
import { acquireAdmissionRuntime } from './concurrency.js'
import { Supervisor } from './supervisor.js'
import { reconcileParent } from './reconcile.js'
import { SnapshotWriter, buildSnapshot, projectAgentTable } from './snapshot.js'
import { SUBAGENT_ROSTER, withRoster } from './roster.js'
import { startOwnedProxy } from './proxy.js'
import { REEVE_TIERS, BUILTINS_TO_HIDE, mergeTierModels, pickDefaultAgent, readEndpoint } from './models.js'
import { loadAgents, loadSkills } from './register.js'
import { ensureProviderBlock, reeveProviderBlock } from './config-write.js'

const SUBAGENT_TOOL = 'subagent'
/** 自持代理的默认端口（与写进配置的端点一致）。 */
const PROXY_DEFAULT_PORT = 8080

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

    // agent 表诊断（桌面面板可核对"前台只出现编排者"）。
    // 为什么值得常驻：`opencode debug agents` 走的是 CLI 自己连的那个服务，未必是你以为的
    // 那个引擎（实测踩过：它连到另一个 HOME 的服务，报出别人的 agent 表）。这一份是从
    // 引擎进程内部读的，没有歧义。
    //
    // ⚠️ **不能在 setup 里读**：那时其他插件的 `agent.transform`（配置里的 agents 块、
    // 内置 agent 的注册）还没应用，读到的是"transform 之前的表"——实测只看到 7 个内置。
    // 改成第一次 `context` 钩子时惰性读一次，那时表才是最终的。
    let agentTable = null
    let agentTableRead = false
    // 名册注入的证据：注入成功过一次就记下来（进快照）——"藏起来不削弱委派"这条设计
    // 靠它可核对，而不是靠"模型应该看得见"。
    let roster = null
    /** 代理层自持的状态（进快照：面板可显示、上机可核对）。必须在快照块之前声明。 */
    let proxyState = null
    /** 从插件包注册进去的 agent / skill 名单（进快照，便于上机核对"没往配置目录拷文件"）。 */
    let registeredAgents = []
    let registeredSkills = []
    /** 端点自举的结果（进快照）。 */
    let endpointState = null
    let snapshotFlush = () => {}

    const readAgentTable = async () => {
      try {
        const res = await ctx.agent.list()
        // 生成的客户端返回 `{ data: [...] }`（CLI 里也是这么取的）；也容错裸数组
        const list = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : null
        agentTable = projectAgentTable(list)
        if (agentTable) {
          const ids = (rows) => rows.map((a) => `${a.id}[${a.mode}]`).join(', ') || '（无）'
          logger.debug(
            `[reeve] 引擎 agent 表：${agentTable.total} 个；前台可见 [${ids(agentTable.visible)}]；` +
              `隐藏 [${ids(agentTable.hidden)}]；subagent [${ids(agentTable.subagent)}]`,
          )
          snapshotFlush()
        }
      } catch (err) {
        logger.debug(`[reeve] 读 agent 表失败（忽略）：${String(err)}`)
      }
    }
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
    // 快照默认落 `~/.reeve/ledger.json`（REEVE 自己的目录，和代理的 app-dir 一处）
    const snapshotPath = options.snapshotPath ?? join(homedir(), '.reeve', 'ledger.json')
    let snapshot = null
    if (snapshotPath) {
      snapshot = new SnapshotWriter({ path: snapshotPath, logger })
      const build = () =>
        buildSnapshot(ledger.all(), {
          version: PLUGIN_VERSION,
          agents: agentTable,
          roster,
          proxy: proxyState,
          registered: { agents: registeredAgents, skills: registeredSkills },
          endpoint: endpointState,
        })
      snapshotFlush = () => snapshot.schedule(build)
      ledger.onChange = () => snapshot.schedule(build)
      snapshot.schedule(build)
      void snapshot.flush().catch(() => {})
      logger.debug(`[reeve] 台账快照开启：${snapshotPath}`)
    }

    // ---- 端点自举：首次启动时把 providers.reeve 写进引擎配置（opt-out：options.ownEndpoint === false）----
    // 使用者裁决 2026-10-20：允许插件写自己的这一块。规则见 src/config-write.js 的头注释
    // （只加不改 / 备份 / 写完自校验 / 保留注释）。
    let endpointWrite = null
    if (options.ownEndpoint !== false) {
      const wantPort = Number(options.proxy?.port ?? PROXY_DEFAULT_PORT)
      endpointWrite = await ensureProviderBlock({
        configDir: options.engineConfigDir ?? null,
        block: reeveProviderBlock({ port: wantPort }),
        logger,
      })
      logger.debug(`[reeve] 端点自举：${endpointWrite.status}（${endpointWrite.detail ?? ''}）`)
      endpointState = { status: endpointWrite.status, path: endpointWrite.path, detail: endpointWrite.detail }
    }

    // ---- 代理层自持（opt-in：options.proxy.enabled）----
    // 纯插件形态：取件 → 派生链 → 拉起/复用 → 等就绪 → 收敛 → 守护。
    // 不需要任何外部脚本；失败只记日志（代理起不来时引擎照常跑，模型会吵地报错）。
    let proxyHandle = null
    // 两种写法都行：`proxy: true`（简写）或 `proxy: { enabled: true, ... }`
    // 默认开：这样配置里可以真的只写一行插件（`proxy: false` 关闭；`proxy: true` 或对象都行）
    if (options.proxy !== false && options.proxy?.enabled !== false) {
      // 端口不用用户重复写：从配置里的 `providers.reeve.settings.baseURL` 推（读不到就用 options/默认）
      let opts = options.proxy === true || options.proxy === undefined ? {} : options.proxy
      if (opts.port == null) {
        const endpoint = await readEndpoint({})
        if (endpoint) {
          opts = { ...opts, port: endpoint.port, host: endpoint.host }
          logger.debug(`[reeve] 代理端口取自配置：${endpoint.host}:${endpoint.port}（来自 ${endpoint.from}）`)
        }
      }
      // 状态一变就刷新快照 —— 尤其"后台取件完成、代理起来了"那一刻（否则面板会一直显示未就绪）
      const onState = (st) => {
        proxyState = { ready: st.ready, detail: st.detail, port: st.port, host: st.host }
        snapshotFlush()
      }
      proxyHandle = await startOwnedProxy({ opts, logger, onState })
      onState(proxyHandle)
      logger.debug(`[reeve] 代理层自持：${proxyHandle.ready ? '就绪' : '未就绪'} —— ${proxyHandle.detail ?? '?'}`)
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

    // ---- ⓪ 注册（让 opencode.jsonc 尽量短）----
    // 三件事都在插件里做，配置里就不用写 models / agents / default_agent：
    //   a) 三个档位模型（配置里已写的不动 —— 配置说话时以配置为准）
    //   b) 把内置 agent 藏起来（前台只出现编排者）
    //   c) 默认 agent = foreman（存在才设）
    // ⚠️ 端点（baseURL / key）**注册不了**：Provider.Info 没有 URL、Connection 只是凭据引用、
    //    Integration 只是"怎么拿凭据"。那两行必须留在配置里。
    try {
      await ctx.provider.transform((editor) => {
        const existing = editor.get('reeve')?.models
        const list = existing ? Array.from(existing.values()) : []
        const merged = mergeTierModels(list, REEVE_TIERS, 'reeve')
        if (merged.length !== list.length) editor.models.set('reeve', merged)
      })
      // agent 与 skill 从**插件自己的包**里注册（配置目录里不需要 agent/ 与 skill/ 两个目录）。
      // 配置优先：引擎里已经有的同名 agent（用户在配置目录里写的）一律不动。
      const bundledAgents = await loadAgents()
      const bundledSkills = await loadSkills()
      await ctx.agent.transform((editor) => {
        for (const id of BUILTINS_TO_HIDE) {
          if (editor.get(id)?.hidden === true) continue
          editor.update(id, (agent) => {
            agent.hidden = true
          })
        }
        for (const info of bundledAgents) {
          if (editor.get(info.id)) continue // 配置优先
          editor.update(info.id, (agent) => {
            Object.assign(agent, info)
          })
        }
        // 编排者必须存在才能当默认；不存在（被配置删了/改名了）就保持原样
        pickDefaultAgent(editor, 'foreman')
      })
      registeredAgents = bundledAgents.map((a) => a.id)
      await ctx.skill.transform((editor) => {
        for (const skill of bundledSkills) {
          if (editor.get(skill.id)) continue
          editor.add(skill)
        }
      })
      registeredSkills = bundledSkills.map((s) => s.id)
      logger.debug(`[reeve] 注册：agent ${registeredAgents.length} 个、skill ${registeredSkills.length} 个（配置里已有的不动）`)
    } catch (err) {
      logger.debug(`[reeve] 注册（模型/可见性）失败（忽略）：${String(err)}`)
    }

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

    // ---- ⑥ 补名册（构造模型调用时）----
    // 7 个 subagent 在前台不可见（hidden），引擎的"可用 subagent"宣传段因此为空；
    // 这里把名册接回 `subagent` 工具的描述。幂等（withRoster 认标记），
    // 失败只记日志 —— 描述补不上不该影响任何一次真实调用。
    let rosterLogged = false
    await ctx.session.hook('context', (event) => {
      // 到这里所有 agent.transform 都已应用 —— 顺手读一次最终的表（只读一次）
      if (!agentTableRead) {
        agentTableRead = true
        void readAgentTable()
      }
      try {
        const tool = event?.tools?.[SUBAGENT_TOOL]
        if (!tool) return
        const before = tool.description
        tool.description = withRoster(before)
        if (tool.description !== before) {
          const first = roster === null
          roster = { count: SUBAGENT_ROSTER.length, at: Date.now(), additions: (roster?.additions ?? 0) + 1 }
          snapshotFlush()
          if (!rosterLogged) {
            rosterLogged = true
            logger.debug(`[reeve] 名册已注入 ${SUBAGENT_TOOL} 工具描述（${SUBAGENT_ROSTER.length} 个 subagent）`)
          } else if (first) {
            logger.debug('[reeve] 名册注入过一次后又被清掉（工具描述被重建）——已重新注入')
          }
        }
      } catch (err) {
        logger.debug(`[reeve] 名册注入失败（忽略）：${String(err)}`)
      }
    })

    return () => {
      abort.abort()
      supervisor.stopAll()
      if (snapshot) {
        snapshot.cancel()
        void snapshot.flush().catch(() => {})
      }
      if (proxyHandle) void proxyHandle.dispose().catch(() => {})
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
