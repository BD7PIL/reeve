// M1.3b/c 录制 harness（目录包形态探针；挂载法 = M1.1(a) 已验证的「目录包 + 活配置 plugins 数组
// + 重启 OpenChamber + 还原」三定律：package 必须是目录、默认导出 {id, setup|effect}、装载在项目初始化）。
//
// 用法（人工步）：
//   1. 把本目录的绝对路径作为裸字符串条目插进活配置 opencode.jsonc 的 plugins 数组；
//   2. 重启 OpenChamber（引擎随桌面栈拉起，serve --stdio；项目初始化时逐引擎调 setup）；
//   3. 等录制日志完整：plugin/test/fixtures/engine/replay/<日期>/harness-run.jsonl 末行 phase=DONE（或 FATAL）；
//   4. 还原配置 → 再重启 OpenChamber（栈回到常规状态）。
//
// 与 M1.3a 探针（engine-face probe-pkg，OpenCodeConfig 仓）的差别：本 harness 不再
// 「探测宿主形状」——那批结论（setup 面实测 v2-setup-called、create 扁平 .id、context 空会话
// 返回 []、wait 全形态即时抛、env 无 OPENCODE_SERVER_PORT）已实测在案并落进 driver-session.js
// 头注。本文件**用**这些结论：
//   - 引擎代码 file URL 直引 reeve 工作树（宿主从 npm 缓存装载 reeve@0.3.0，不经工作树——
//     直引保证录制所用的 driver/scheduler 与 plugin/test 契约测试同一份源；引擎模块零 npm 依赖）；
//   - createSessionDriver(ctx) 挂上宿主 face，scheduler run() 把 fixtures/engine/pilot-3step.json
//     （三个无依赖合成步，各带 schema）跑到 run 级终态；
//   - driver 每次 create/result(内含 wait+context 读)/context 的真实交互全部落盘：
//     recording.json（replay driver 可装载的 scenario 形状——S7a 同一格式）+ harness-run.jsonl
//     （逐 phase 交互日志，含全量 driver.calls：create 参数、每次 result 的 wait 状态与 parse
//     形状、每次读到的 context 原始形状）。
//
// 一次性纪律：OpenChamber 会为多个项目各拉一个引擎（实测 2 个），setup 逐引擎各跑一次——
//   首个拿到 harness.lock（O_EXCL 独占创建）的引擎做录制，其余引擎记 skip-locked 后即返。
//   锁不自动删：卸载（还原配置）前不能允许迟到引擎二次跑；卸载完成后由录制流程手工清锁。
//
// 合成纪律：任务内容全合成（三步各自只要求一行 JSON），不读用户会话、不碰真实系统；
// 时钟/故障不注入（生产形态：真实 now/sleep、fault=null）——本 harness 的目的是采真机形状。
// 断言风格：自然退出（宿主进程内跑，绝不退出宿主进程；失败也只落 FATAL 行）。
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---- 定位（全部从本文件自身位置推导，不依赖 cwd）----
// 本文件位于 <reeve 工作树>/plugin/test/fixtures/engine/probe/m13-recorder-pkg/index.js，
// new URL 的 '../' 逐级回退：×1 probe/ ×2 engine/（fixtures/engine）×3 fixtures/ ×4 test/ ×5 plugin/ ×6 工作树根。
const here = (relative) => fileURLToPath(new URL(relative, import.meta.url))
const FIXTURES_ENGINE_DIR = here('../../') // plugin/test/fixtures/engine/（×2：probe ← engine）
const REPO_ROOT = here('../../../../../../') // reeve 工作树根（×6；下有 .zcode/、plugin/）
const engineModule = (name) => import(new URL(`../../../../../src/engine/${name}`, import.meta.url).href) // ×5 → plugin/src/engine/

// <日期> 目录用**本机本地日历日**（YYYY-MM-DD；与工作流「今日」口径一致，字典序仍即时间序）。
// 首次挂载实测教训：引擎进程的 UTC 日期比本地晚 8 小时，UTC 口径会把录制写进前一天的目录。
const nowDate = new Date()
const DATE = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, '0')}-${String(nowDate.getDate()).padStart(2, '0')}`
// 演练缝（构造注入纪律的目录版）：REEVE_M13_REPLAY_DIR 设绝对路径 → 全部落盘改道该目录
// （journal 跟随落 <override>/journal）。真机录制不设它 → 生产路径。挂载探针不用 env 传参。
const OVERRIDE_DIR = typeof process !== 'undefined' && process.env?.REEVE_M13_REPLAY_DIR ? process.env.REEVE_M13_REPLAY_DIR : null
const REPLAY_DIR = OVERRIDE_DIR ?? join(FIXTURES_ENGINE_DIR, 'replay', DATE)
const LOG_FILE = join(REPLAY_DIR, 'harness-run.jsonl') // 非 .json 后缀：不被 replay 装载器误读
const LOCK_FILE = join(REPLAY_DIR, 'harness.lock') // 非 .json：同上；卸载后由录制流程手工清
const RECORDING_FILE = join(REPLAY_DIR, 'recording.json')
const JOURNAL_ROOT = OVERRIDE_DIR ? join(OVERRIDE_DIR, 'journal') : join(REPO_ROOT, '.zcode', 'plans', 'evidence', 'm13b') // journal 是 *.journal.json，绝不落 replay 目录
const DECLARATION_FILE = join(FIXTURES_ENGINE_DIR, 'pilot-3step.json')

const w = (phase, payload) => {
  try {
    appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), phase, ...payload }) + '\n')
  } catch {
    /* 落盘尽力而为 */
  }
}

// 模块加载即落一行（首次挂载的教训：setup 若未被调用或模块求值失败，「 loading plugin 」引擎日志
// 之外没有任何痕迹；这行让「模块到底有没有被求值」在录制日志里可见）。
try {
  mkdirSync(REPLAY_DIR, { recursive: true })
  w('module-load', { node: process.version, dir: REPLAY_DIR })
} catch {
  /* 落盘尽力而为 */
}

async function recordRun(ctx) {
  let driver = null
  let allConclusive = false // 主 run 是否抓到全结论场景（finally 里 probe 矩阵的开关；作用域必须在此）
  mkdirSync(REPLAY_DIR, { recursive: true })
  let lockFd
  try {
    lockFd = openSync(LOCK_FILE, 'wx') // O_EXCL：首引擎赢，其余引擎 skip
  } catch {
    w('skip-locked', { note: '另一引擎已在录制（锁在位）', lock: LOCK_FILE })
    return
  }
  closeSync(lockFd)
  w('locked', { lock: LOCK_FILE })

  try {
    // ---- 0. face 快照（对照 M1.1(a)/M1.3a 已实测结论；漂移当场可见）----
    w('v2-setup-called', {
      node: process.version,
      locationDirectory: ctx?.location?.directory ?? null,
      sessionMembers: ctx?.session ? Object.keys(ctx.session) : null,
      hasEventSubscribe: typeof ctx?.event?.subscribe === 'function',
      envPort: process.env.OPENCODE_SERVER_PORT ?? null,
      paths: { fixturesEngine: FIXTURES_ENGINE_DIR, repoRoot: REPO_ROOT, declaration: DECLARATION_FILE, recording: RECORDING_FILE },
    })
    try {
      const agents = typeof ctx?.agent?.list === 'function' ? await ctx.agent.list() : null
      const plain = JSON.parse(JSON.stringify(agents ?? null, (k, v) => (typeof v === 'function' ? '[fn]' : v)))
      const items = Array.isArray(plain) ? plain : Array.isArray(plain?.data) ? plain.data : Array.isArray(plain?.agents) ? plain.agents : null
      w('agent-table', {
        shape: Array.isArray(plain) ? 'array' : plain && typeof plain === 'object' ? Object.keys(plain) : typeof plain,
        names: items ? items.map((a) => a?.name ?? a?.id ?? '?') : null,
        defaultModelOfFirst: items?.[0]?.model ?? null,
      })
    } catch (e) {
      w('agent-table-failed', { error: String(e?.message ?? e).slice(0, 150) })
    }

    // ---- 1. 引擎模块（S1-S6：declaration/journal/driver/driver-session/scheduler + 校验面）----
    const declarationMod = await engineModule('declaration.js')
    const journalMod = await engineModule('journal.js')
    const driverMod = await engineModule('driver.js')
    const driverSessionMod = await engineModule('driver-session.js')
    const schedulerMod = await engineModule('scheduler.js')
    w('engine-imported', {
      source: 'reeve 工作树 file URL 直引（../../../../../src/engine/*）',
      declaration: Boolean(declarationMod.validateDeclaration),
      scheduler: Boolean(schedulerMod.run),
    })

    // ---- 2. 声明（三个无依赖合成步，各带 schema）----
    const declaration = JSON.parse(readFileSync(DECLARATION_FILE, 'utf8'))
    const verdict = declarationMod.validateDeclaration(declaration)
    if (!verdict.ok) throw new Error(`pilot-3step.json 不合法：${verdict.errors.join('；')}`)
    w('declaration', { runId: declaration.runId, steps: declaration.steps.map((s) => s.stepId) })

    // ---- 3. journal（盘上 *.journal.json 落 .zcode 证据区，绝不进 replay 目录）----
    // 每次挂载尝试必须**全新 journal**（首次挂载的实测教训：上次尝试把三步记成 failed 后，调度器
    // 拒接非全新 run——E1_ENGINE_NOT_FRESH 的 message 在 harness 日志里可见）。旧件改道保留作证据。
    const storage = journalMod.makeJournalStorage(JOURNAL_ROOT, declaration.runId)
    try {
      if (existsSync(storage.file)) {
        const kept = join(JOURNAL_ROOT, `.${storage.stem}.prev-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
        renameSync(storage.file, kept)
        w('journal-reset', { prev: kept })
      }
    } catch {
      /* 旧 journal 不存在/挪不动（目录刚建）：直接开跑，写冲突会由 journal fail-closed 暴露 */
    }
    const journal = journalMod.createJournal({
      storage,
      runId: declaration.runId,
      onEvent: (e) => w('journal-event', { kind: e.kind, type: e.type ?? null, stepId: e.stepId ?? null, to: e.to ?? null }),
    })

    // ---- 4. 生产 driver 挂宿主 face（directory 给调度器做跨项目过滤基准）----
    driver = driverSessionMod.createSessionDriver(ctx, { directory: ctx?.location?.directory })
    driverMod.assertDriverFace(driver, 'session', { requireCalls: true })

    // ---- 4.5 启动稳定窗（挂载实测教训：引擎启动 ~0.5s 内 provider/model/agent 注册表仍在
    // 落位（provider.updated/model.updated/agent.updated 事件晚于首派 0.4s），模型元数据
    // （models.dev）拉取还可能超时重试——先等 90s 再派发，排除「注册表未就绪」变量）----
    await new Promise((resolve) => setTimeout(resolve, 90_000))
    w('settle-wait-done', { waitedMs: 90_000 })

    // ---- 5. 完整 run（cap=3：三无依赖步并行；事件源 = driver.events() 心跳+宿主事件）----
    const result = await schedulerMod.run(declaration, {
      journal,
      driver,
      cap: 3,
      events: driver.events(),
      directory: ctx?.location?.directory,
      onEvent: (e) => w('run-event', { type: e.type, stepId: e.stepId ?? null, sessionId: e.sessionId ?? null }),
    })
    w('run-terminal', {
      status: result.status,
      reason: result.reason ?? null,
      completed: result.completed,
      failed: result.failed,
      pending: result.pending,
    })

    // ---- 5.5 交互证据先行落盘（诊断教训：守卫抛错会把 calls 带进坟墓——先 dump 再判）----
    w('driver-calls', { calls: driver.calls })
    for (const c of driver.calls.filter((x) => x.op === 'create' && typeof x.sessionId === 'string')) {
      try {
        const rec = await ctx.session.get({ sessionID: c.sessionId })
        const plain = JSON.parse(JSON.stringify(rec ?? null, (k, v) => (typeof v === 'function' ? '[fn]' : v)))
        w('session-record', { sessionId: c.sessionId, keys: plain && typeof plain === 'object' ? Object.keys(plain) : typeof plain, agent: plain?.agent ?? plain?.data?.agent ?? null, model: plain?.model ?? plain?.data?.model ?? null, title: plain?.title ?? null })
      } catch (e) {
        w('session-record-failed', { sessionId: c.sessionId, error: String(e?.message ?? e).slice(0, 150) })
      }
    }

    // ---- 6. 终局后逐会话补一次 driver.context（抓最终 transcript 原始形状）----
    const creates = driver.calls.filter((c) => c.op === 'create' && typeof c.sessionId === 'string')
    const scenarios = []
    for (const c of creates) {
      const sid = c.sessionId
      const stepId = typeof c.args?.title === 'string' && c.args.title.includes(' ') ? c.args.title.split(' ').at(-1) : `seq${c.seq}`
      const resultCalls = driver.calls.filter((r) => r.op === 'result' && r.args?.sessionId === sid && r.response)
      const terminal = resultCalls.at(-1)?.response ?? null
      let transcript = null
      try {
        transcript = await driver.context(sid)
      } catch (e) {
        w('context-after-run-failed', { sessionId: sid, stepId, error: String(e?.message ?? e).slice(0, 200) })
      }
      scenarios.push({
        name: `m13-step-${stepId}`,
        match: { prompt: c.args.prompt, ...(c.args.title !== undefined ? { title: c.args.title } : {}) },
        sessionId: sid,
        result: terminal ? [terminal] : [{ status: 'running' }],
        context:
          Array.isArray(transcript) && transcript.length > 0
            ? transcript
            : [{ note: 'm13: 终局 context 读取失败占位（真实形状见 harness-run.jsonl 的 context-after-run-failed）', role: 'assistant', parts: [] }],
      })
    }
    const scenarioCheck = driverMod.validateScenarioSet(scenarios)
    if (!scenarioCheck.ok) throw new Error(`录制场景集不合法：${scenarioCheck.errors.join('；')}`)

    // ---- 7. 录制件落盘 + 自校验（写完立即用 S3 装载器读回——replay 半边的入场券当场验证）----
    // 写入门（首次挂载的教训：三步全超时收场时 scenarios=[]，把同目录既有录制件盖成了空件）：
    // 只在「抓到场景且每个终局应答都有结论（done/failed，无 running）」时才写 recording.json；
    // 否则保留现场（不动既有录制件），只落 FATAL 行交人判断。
    const terminals = scenarios.map((s) => s.result[0].status)
    allConclusive = scenarios.length > 0 && terminals.every((t) => t === 'done' || t === 'failed')
    if (!allConclusive) {
      // 尽力清理半途会话（合成 prompt 的孤儿会话不留给用户栈；remove face 实测 17 方法之一）
      for (const s of scenarios) {
        try {
          await ctx.session.remove({ sessionID: s.sessionId })
          w('cleanup-removed', { sessionId: s.sessionId })
        } catch (e) {
          w('cleanup-failed', { sessionId: s.sessionId, error: String(e?.message ?? e).slice(0, 120) })
        }
      }
      throw new Error(`录制不完整，拒绝写 recording.json（scenarios=${scenarios.length}，terminals=${JSON.stringify(terminals)}，runStatus=${result.status}）；既有录制件未被触碰`)
    }
    const recording = {
      version: 1,
      recordedAt: new Date().toISOString(),
      host: 'OpenChamber 桌面栈拉起的 opencode 引擎（serve --stdio，win32；face 面实测见 M1.1(a)/M1.3a findings）',
      note: 'M1.3b/c 真机录制：pilot-3step.json 三无依赖步 × createSessionDriver × scheduler run；scenario.result 只记终局应答（逐次轮询全交互在 harness-run.jsonl 的 driver-calls 行），scenario.context = 终局后 driver.context 的原始 transcript',
      scenarios,
    }
    writeFileSync(RECORDING_FILE, `${JSON.stringify(recording, null, 2)}\n`, 'utf8')
    const reload = driverMod.loadReplayScenarios(REPLAY_DIR)
    if (reload.scenarios.length !== scenarios.length || !reload.files.includes('recording.json')) {
      throw new Error(`录制件自校验失败：写后读回 ${reload.scenarios.length}/${scenarios.length} 场景，files=${reload.files.join(',')}`)
    }

    // ---- 8. 全量交互落盘（create/result/wait/context 逐次；recording.json 只装 replay 消费面）----
    w('driver-calls', { calls: driver.calls })
    w('driver-event-stats', { eventStats: driver.eventStats, executionEvents: driver.executionEvents.length })
    w('recording-written', {
      file: RECORDING_FILE,
      scenarios: scenarios.map((s) => ({ name: s.name, sessionId: s.sessionId, terminal: s.result[0].status, contextEntries: s.context.length })),
    })
    w('DONE', { verdict: 'M1.3b/c 录制完成', replayDir: REPLAY_DIR, runStatus: result.status })
  } catch (error) {
    w('FATAL', { error: String(error?.message ?? error).slice(0, 400), stack: String(error?.stack ?? '').slice(0, 600) })
  } finally {
    // 主 run 未收敛 → 跑 agent×model 组合矩阵探测（判「桌面栈是否根本不跑插件自建会话的 turn」）
    try {
      if (!allConclusive) await faceProbeMatrix(ctx)
    } catch (e) {
      w('FATAL', { error: `probe 矩阵外层捕获：${String(e?.message ?? e).slice(0, 200)}` })
    }
    try {
      driver?.close?.()
    } catch {
      /* 尽力而为 */
    }
  }
}

/**
 * 决定性 face 探测（主 run 未完成时跑一次）：agent×model 组合矩阵，逐会话 prompt 后轮询
 * context 90s，记录「turn 到底动没动」。这是判「桌面栈能不能跑插件自建会话的 turn」的
 * 最后一个实验；每会话必删（不留孤儿）。natural-exit：只落盘不抛。
 */
async function faceProbeMatrix(ctx) {
  const combos = [
    { name: 'agent-general+model', create: { title: 'REEVE-M13 probe gen+model', agent: 'general', model: { providerID: 'reeve', id: 'standard' } } },
  ]
  for (const combo of combos) {
    let sid = null
    try {
      const raw = await ctx.session.create({ ...combo.create, ...(ctx?.location?.directory ? { directory: ctx.location.directory } : {}) })
      sid = raw?.id ?? raw?.data?.id ?? null
      if (!sid) {
        w('probe-no-id', { name: combo.name })
        continue
      }
      await ctx.session.prompt({ sessionID: sid, text: 'Reply with exactly: M13-PROBE', ...(combo.create.agent ? { agent: combo.create.agent } : {}) })
      let finalShape = 'empty'
      let rawDump = null
      for (let i = 0; i < 24; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5000))
        try {
          const t = await ctx.session.context({ sessionID: sid })
          const roles = Array.isArray(t) ? t.map((m) => m?.info?.role ?? m?.role ?? m?.type ?? '?') : typeof t
          finalShape = JSON.stringify(roles)
          if (Array.isArray(t) && t.length > 0) rawDump = t
          if (Array.isArray(t) && t.some((m) => (m?.info?.role ?? m?.role ?? m?.type) === 'assistant')) break
        } catch (e) {
          finalShape = `threw:${String(e?.message ?? e).slice(0, 80)}`
        }
      }
      // 原始形状逐条落盘（v2 face 的条目形状从未实测过——这次必须拿到字节级证据）
      if (Array.isArray(rawDump)) {
        for (const [i, entry] of rawDump.entries()) {
          w('probe-raw-entry', {
            name: combo.name,
            index: i,
            json: JSON.stringify(entry, (k, v) => (typeof v === 'function' ? '[fn]' : v)).slice(0, 1200),
          })
        }
      }
      w('probe-result', { name: combo.name, sessionId: sid, transcriptRoles: finalShape })
    } catch (e) {
      w('probe-error', { name: combo.name, error: String(e?.message ?? e).slice(0, 200) })
    } finally {
      try {
        if (sid) await ctx.session.remove({ sessionID: sid })
      } catch {
        /* 尽力而为 */
      }
    }
  }
}

export default {
  id: 'reeve-m13-recorder',
  async setup(ctx) {
    // **setup 必须立即返回**（首次挂载的实测教训：宿主在本项目全部插件 setup 完成前不开放
    // session API——M1.3a 探针条目排在 reeve 之后所以没撞上；本条目排第一，setup 内 await run
    // 的话自己发出的 create 会在队列里挂到 15 分钟声明超时，run 落 blocked）。改成后台跑
    // （recordRun 自身全捕获、绝不向宿主抛；宿主插件实例长驻，ctx face 不随 setup 返回失效
    // ——reeve 自己的 setup 也是返回后靠同一 ctx 继续服务的）。
    void recordRun(ctx).catch(() => {})
  },
}

// 演练缝：命名导出（宿主只读默认导出；插件面不受影响）——离线 rehearsal 用假 ctx 走完整
// recordRun 路径（引擎 import、run()、录制件构建与自校验），真机面已由 M1.3a 实测背书。
export { recordRun }
