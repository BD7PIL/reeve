// REEVE 记账层的常量与状态机定义。
// 施工图：docs/research/opencode-v2-plugin-api.md

export const PLUGIN_ID = 'reeve'

/** 与 package.json 的 version 保持一致；快照文件里会带上，便于面板判断版本。 */
export const PLUGIN_VERSION = '0.1.3'

/** 工具注册的命名空间。注意：真正决定"模型能否看见"的是 codemode:false（施工图 §3.1）。 */
export const TOOL_NAMESPACE = 'reeve'

/**
 * 静默死亡的宽限期。
 * `session.idle` 只是候选信号；只有转录判定 absent **且**静默超过这个宽限，
 * 才允许落 stopped —— 否则会把每个正常完成的子任务都误报成死亡。
 */
export const STOP_CONFIRMATION_GRACE_MS = 5_000

/** 发出 abort 之后，等多久确认；到期仍未确认就标 statusUncertain。 */
export const DEFAULT_ABORT_GRACE_MS = 10_000

/** 无法证明为终态时，最多排几次重试。 */
export const DEFAULT_MAX_ATTEMPTS = 3

/** 台账落盘时的键前缀（宿主会自动再加 `plugin.<id>.`）。 */
export const STORAGE_PREFIX = 'ledger/'

/** 墓碑保留期。 */
export const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export const STATE = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  ERROR: 'error',
  STOPPED: 'stopped',
  CANCELLED: 'cancelled',
  RECONCILED: 'reconciled',
})

export const TERMINAL_STATES = new Set([
  STATE.COMPLETED,
  STATE.ERROR,
  STATE.STOPPED,
  STATE.CANCELLED,
  STATE.RECONCILED,
])

export const REASON = Object.freeze({
  /** 转录判定为"没有终态结果"而停止——静默死亡的落点。 */
  STOPPED_WITHOUT_TERMINAL_RESULT: 'stopped_without_terminal_result',
  /** 墙钟到期并已中断。 */
  WALL_CLOCK_TIMEOUT: 'wall_clock_timeout',
  /** 宿主报了 execution.interrupted。 */
  HOST_INTERRUPTED: 'host_interrupted',
  /** 跨重启对账时发现子会话已不存在。 */
  CHILD_SESSION_MISSING: 'child_session_missing',
  /** 跨重启对账未能确认终态。 */
  UNRECONCILED: 'unreconciled',
})

/** 台账记录里所有"可能不确定"的字段都显式列出，方便落盘与审计。 */
export function newRecord({
  taskID,
  parentSessionID,
  childSessionID = null,
  agent = null,
  description = null,
  background = false,
  model = null,
  now = Date.now(),
}) {
  return {
    taskID,
    parentSessionID,
    childSessionID,
    agent,
    description,
    background,
    model,
    state: STATE.RUNNING,
    /** 每次"重新武装"（例如重试）自增；墙钟只对新 generation 重新武装。 */
    generation: 0,
    /** 该任务第一次进入 running 的时间，用作静默判定的下界。 */
    attemptStartedAt: now,
    /** 最后一次观测到活动的时刻。 */
    lastActivityAt: now,
    startedAt: now,
    endedAt: null,
    /** 终态已发布且不可被迟到的完成覆盖。 */
    terminalPublished: false,
    terminalSource: null,
    reason: null,
    /** 无法证明为终态。 */
    statusUncertain: false,
    timedOut: false,
    terminalUnreconciled: false,
    /**
     * 已经发过中断，以及**为什么发**。
     * 用途：我们发的中断会让宿主回 `session.execution.interrupted`，
     * 事件处理器必须靠这个字段把它归因成"墙钟超时"，
     * 而不是误记成"宿主中断"（否则 timedOut 永远是 false）。
     */
    interruptSent: false,
    interruptReason: null,
    attempts: 0,
  }
}
