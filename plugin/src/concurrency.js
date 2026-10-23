// 并发准入闸门。
//
// 挂在 `ctx.tool.hook("execute.before")` —— **子会话创建之前**。
// 超限时**排队，不失败**。
//
// 两条正确性性质（抄 omo-slim，MIT）：
//   (a) **嵌套的受管任务必须豁免** —— 它已经持有槽位（它的父任务占着），
//       再让它排队会**自死锁**。
//   (b) **调度器按目录进程级共享** —— 插件重载后仍保留运行中的槽位与排队票。

/** 进程级共享：directory -> Admission。插件重载不清空。 */
const RUNTIMES = new Map()

export function acquireAdmissionRuntime(directory, options) {
  const key = directory || '<default>'
  let runtime = RUNTIMES.get(key)
  if (!runtime) {
    runtime = new Admission(options)
    RUNTIMES.set(key, runtime)
  } else if (options) {
    runtime.configure(options)
  }
  return runtime
}

/** 供测试与诊断用。 */
export function _runtimes() {
  return RUNTIMES
}

export class Admission {
  /** @type {Map<string, {resolve: Function, reject: Function}>} key -> 排队票 */
  #waiting = new Map()
  /** @type {Set<string>} 正在占槽的任务键 */
  #active = new Set()
  #limits = { default: 0, providers: {}, models: {} }

  constructor(options = {}) {
    this.configure(options)
  }

  configure({ limits } = {}) {
    if (!limits) return
    this.#limits = {
      default: normalizeLimit(limits.default),
      providers: limits.providers ?? {},
      models: limits.models ?? {},
    }
  }

  get activeCount() {
    return this.#active.size
  }

  get waitingCount() {
    return this.#waiting.size
  }

  /**
   * 档位解析：**模型上限 > provider 上限 > 默认上限**；`0`/缺省 = 无限。
   */
  resolveLimit({ model, provider } = {}) {
    if (model && this.#limits.models?.[model] != null) return normalizeLimit(this.#limits.models[model])
    if (provider && this.#limits.providers?.[provider] != null) {
      return normalizeLimit(this.#limits.providers[provider])
    }
    return normalizeLimit(this.#limits.default)
  }

  /**
   * 取一个槽位。超限则排队等（不是失败）。
   * @returns {Promise<() => void>} 释放函数
   */
  async acquire(key, { model, provider, nested = false, signal = null } = {}) {
    // (a) 嵌套的受管任务豁免：它已持槽，排队会自死锁。
    if (nested) return () => {}

    const limit = this.resolveLimit({ model, provider })
    if (limit === 0 || this.#active.size < limit) {
      this.#active.add(key)
      return () => this.release(key)
    }

    // 排队。被 abort 时撤票。
    await new Promise((resolve, reject) => {
      const ticket = { resolve, reject }
      this.#waiting.set(key, ticket)
      signal?.addEventListener?.(
        'abort',
        () => {
          if (this.#waiting.get(key) === ticket) {
            this.#waiting.delete(key)
            reject(new Error('reeve: 排队时被取消'))
          }
        },
        { once: true },
      )
    })

    this.#active.add(key)
    return () => this.release(key)
  }

  release(key) {
    this.#active.delete(key)
    this.#drain()
  }

  /** 释放一个槽位后，把队首放行。 */
  #drain() {
    const limit = this.resolveLimit({})
    if (limit !== 0 && this.#active.size >= limit) return
    const next = this.#waiting.keys().next()
    if (next.done) return
    const [key, ticket] = [next.value, this.#waiting.get(next.value)]
    this.#waiting.delete(key)
    ticket.resolve()
  }
}

function normalizeLimit(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0 // 0 / 缺省 / 非法 = 无限
  return Math.floor(n)
}
