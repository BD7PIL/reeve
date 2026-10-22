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
import { probeGate, startGate } from './gate/gate.js'
import { defaultFallbackConfigPath } from './gate/config.js'
import { REEVE_TIERS, BUILTINS_TO_HIDE, mergeTierModels, pickDefaultAgent, readEndpoint, resolveGateEndpoint } from './models.js'
import { STATS_DEFAULTS, aggregateGateRows, aggregateLedger, buildStats, fetchGateFree, fetchGateModels, fetchGateVersion, mergeModelCandidates, readLedgerTail } from './stats.js'
import { loadAgents, loadSkills } from './register.js'
import { ensureProviderBlock, reeveProviderBlock } from './config-write.js'

const SUBAGENT_TOOL = 'subagent'
/** GATE（唯一代理层）的默认端口（与写进配置的端点一致）。 */
const GATE_DEFAULT_PORT = 8080

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
    /** GATE 的运行态（进快照：面板可显示、上机可核对）。必须在快照块之前声明。 */
    let gateState = null
    /** 性能统计（进快照）。必须在快照块之前声明。 */
    let statsState = null
    /** 模型候选（面板的链编辑选择器用）。必须在快照块之前声明。 */
    let modelsState = null
    // 免费车道运行态（/gate/free）：面板的"当前展开 / 冷却 / 发现源"读它
    let freeState = null
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
          models: modelsState,
          free: freeState,
          registered: { agents: registeredAgents, skills: registeredSkills },
          endpoint: endpointState,
          stats: statsState,
          gate: gateState,
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
      const wantPort = resolveGateEndpoint({ gate: options.gate === true ? null : options.gate, proxy: options.proxy === true ? null : options.proxy, fallbackPort: GATE_DEFAULT_PORT }).port
      endpointWrite = await ensureProviderBlock({
        configDir: options.engineConfigDir ?? null,
        block: reeveProviderBlock({ port: wantPort }),
        logger,
      })
      logger.debug(`[reeve] 端点自举：${endpointWrite.status}（${endpointWrite.detail ?? ''}）`)
      endpointState = { status: endpointWrite.status, path: endpointWrite.path, detail: endpointWrite.detail }
    }

    // ---- GATE（代理层 —— 唯一入口；opt-out：`gate: false`）----
    // 引擎认的是 `providers.reeve` 那个 baseURL，GATE 就占那个端口；路由/回退/执行/台账都在
    // 它里面（唯一代理层，见 docs/GATE.md）。失败只记日志：引擎照常跑，模型会吵地报错。
    //
    // **复用优先**：引擎是**按工作区**加载插件的 —— 同一个引擎里可能有多个插件实例（每个工作区一个）。
    // 第一个实例把 GATE 拉到端点口上，后面的实例**用健康检查接上**（`external: true`），
    // 而不是去抢同一个口（抢必失败 → 快照里会出现假的"GATE 未就绪"，面板跟着误报）。
    // 卸载语义：**都不在卸载时关端口** —— GATE 是引擎级服务，插件实例（工作区）被闲置驱逐
    // 并不意味着引擎退出。以前"自己起的自己关"会让起服务的工作区被驱逐后，其它活跃工作区的
    // 请求永久拿不到代理（2026-10-22 两台机器实测）。`detach()` 只清空闲连接，不阻塞进程退出。
    let gateHandle = null
    if (options.gate !== false && options.gate?.enabled !== false) {
      const endpoint = await readEndpoint({})
      const { port: gatePort, host: gateHost } = resolveGateEndpoint({
        gate: options.gate === true ? null : options.gate,
        proxy: options.proxy === true ? null : options.proxy,
        endpoint,
        fallbackPort: GATE_DEFAULT_PORT,
      })
      const configPath = options.gate?.configPath ?? options.fallbackConfigPath ?? defaultFallbackConfigPath()
      const probe = await probeGate({ port: gatePort, host: gateHost })
      if (probe.ok) {
        gateState = { ...probe.snapshot, reused: true }
        logger.debug(`[reeve] GATE 已在 :${gatePort} 上跑着（复用；链 ${(probe.snapshot?.chains ?? []).join('/')}）`)
      } else {
        try {
          gateHandle = await startGate({
            port: gatePort,
            host: gateHost,
            configPath,
            ledgerPath: options.gate?.ledgerPath ?? undefined,
            logger,
          })
          gateState = gateHandle.snapshot()
          logger.debug(`[reeve] GATE：:${gateHandle.port}（链 ${gateState.chains.join('/')}）`)
        } catch (err) {
          gateState = { error: String(err).slice(0, 200) }
          logger.debug(`[reeve] GATE 起不来（忽略，引擎照常）：${gateState.error}`)
        }
      }
      // 状态一变就刷快照 —— 尤其"起来了"或"起不来（如实报错）"这一刻。
      // 少了这一次，消费方只能等下一次台账变化才看到 gate 段（起不来时会一直显示 null）。
      snapshotFlush()
    }

    const admission = acquireAdmissionRuntime(ctx.location?.directory, { limits })

    // ---- ⑦ 性能统计（GATE 台账聚合 + 编排台账聚合 → 快照）----
    // 为什么在插件里做而不是面板里做：面板跑在 openchamber 的 iframe 里，**没有网络/文件能力**，
    // 只有宿主给的 readFile 与 writeFile。台账是引擎进程能读到的本地文件；模型目录是本机回环
    // 的 HTTP（GATE 的 `/v1/models`）—— 只有插件够得着。所以插件取数 + 聚合，面板只读快照。
    const statsOpts = typeof options.stats === 'object' && options.stats !== null ? options.stats : {}
    const statsIntervalMs = Number(statsOpts.intervalMs ?? STATS_DEFAULTS.intervalMs)
    const statsLimit = Number(statsOpts.limit ?? STATS_DEFAULTS.limit)
    const statsWindowMs = Number(statsOpts.windowMs ?? STATS_DEFAULTS.windowMs)
    // 模型目录多久刷一次。**别跟统计同频**：`/v1/models` 会真去上游探测池（9router 那条），
    // 一分钟一次没必要。模型目录本身变化很慢，半小时足够。
    const modelsIntervalMs = Number(statsOpts.modelsIntervalMs ?? STATS_DEFAULTS.modelsIntervalMs)
    let statsTimer = null
    let statsInFlight = false
    let lastModelsAt = 0

    /** 链上已经在用的模型（面板选择器的候选之一：发现不全时至少这些能选）。 */
    const chainedRefs = () => {
      const out = []
      for (const targets of Object.values(gateState?.chain_targets ?? {})) {
        for (const ref of targets ?? []) {
          const s = String(ref ?? '')
          if (s && !s.endsWith('/') && s.includes('/')) out.push(s)
        }
      }
      return out
    }
    const engineModels = () => REEVE_TIERS.map((t) => `reeve/${t.id}`)

    const refreshStats = async () => {
      if (!gateHandle || statsInFlight) return
      statsInFlight = true
      const now = Date.now()
      const nowMs = now
      try {
        const tail = await readLedgerTail({ path: gateHandle.ledgerPath, limit: statsLimit })
        const gateAgg = tail.error ? null : aggregateGateRows(tail.rows, { now: nowMs, windowMs: statsWindowMs })
        const ledgerAgg = aggregateLedger(ledger.all(), { now: nowMs })
        statsState = buildStats({
          now: nowMs,
          checkedAt: nowMs,
          windowMs: statsWindowMs,
          source: gateAgg ? 'gate.ledger' : 'unavailable',
          error: tail.error ? `读台账失败：${tail.error}` : null,
          gate: gateAgg,
          orchestrate: {
            ...ledgerAgg,
            queue: { active: admission.activeCount, waiting: admission.waitingCount },
          },
        })
        gateState = gateHandle.snapshot()
        freeState = await fetchGateFree({ port: gateHandle.port, host: gateHandle.host })
        // 顺手把模型候选也刷一遍（半小时一次；链编辑器的选择器用它）
        if (nowMs - lastModelsAt >= modelsIntervalMs) {
          const discovered = await fetchGateModels({ port: gateHandle.port, host: gateHandle.host })
          lastModelsAt = nowMs
          const candidates = mergeModelCandidates({ discovered: discovered.models, chained: chainedRefs(), engine: engineModels() })
          modelsState = {
            generatedAt: nowMs,
            source: discovered.error ? 'chain+engine' : 'gate',
            error: discovered.error,
            discovered: discovered.models.length,
            candidates,
          }
        }
        snapshotFlush()
      } catch (err) {
        logger.debug(`[reeve] 统计刷新失败（忽略）：${String(err).slice(0, 140)}`)
      } finally {
        statsInFlight = false
      }
    }

    if (statsIntervalMs > 0 && gateHandle) {
      void refreshStats()
      statsTimer = setInterval(() => void refreshStats(), statsIntervalMs)
      statsTimer.unref?.()
      logger.debug(`[reeve] 性能统计：每 ${Math.round(statsIntervalMs / 1000)}s 刷一次（台账尾 ${statsLimit} 行 / ${Math.round(statsWindowMs / 3600000)}h 窗口）`)
    }

    // GATE 运行态独立刷新（2s）：面板的"已生效"要看到 chain_targets/policy/free 真的变了。
    // 统计是 60s 一轮（含台账聚合），拿它当"热更已完成"的信号会让面板在 30s 超时后误报"没生效"
    // ——真宿主保存测试抓到的：GATE 已经换链，快照还停在 60s 前。这里只读进程内 snapshot / 环回
    // /gate/version（都很便宜），且**只在签名变化时**刷快照，稳定时不写盘。
    let gateStateTimer = null
    const gateSignature = () =>
      JSON.stringify({
        port: gateState?.port ?? null,
        error: gateState?.error ?? null,
        chains: gateState?.chains ?? null,
        ct: gateState?.chain_targets ?? null,
        policy: gateState?.policy ?? null,
        free: gateState?.free ?? null,
      })
    let lastGateSig = gateSignature()
    const refreshGateState = async () => {
      let next = null
      if (gateHandle) next = gateHandle.snapshot()
      else if (gateState?.port) {
        const { doc } = await fetchGateVersion({ port: gateState.port, host: gateState.host ?? '127.0.0.1' })
        if (doc?.name === 'reeve-gate') next = { ...doc, reused: true }
      }
      if (!next) return
      gateState = next
      const sig = gateSignature()
      if (sig !== lastGateSig) {
        lastGateSig = sig
        snapshotFlush()
      }
    }

    if (gateHandle || gateState?.port) {
      gateStateTimer = setInterval(() => void refreshGateState(), 2000)
      gateStateTimer.unref?.()
    }
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
    //   a) 四个档位模型（配置里已写的不动 —— 配置说话时以配置为准）
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
      if (statsTimer) clearInterval(statsTimer)
      if (gateStateTimer) clearInterval(gateStateTimer)
      if (snapshot) {
        snapshot.cancel()
        void snapshot.flush().catch(() => {})
      }
      // GATE 是引擎级服务：卸载只"松手"（清空闲连接、不关监听口）。真正关端口只在进程退出
      // 或测试里显式 dispose；`detach` 的定时器都是 unref 的，CLI 一次性进程照样能立刻退出。
      if (gateHandle) gateHandle.detach?.()
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
