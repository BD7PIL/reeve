// GATE —— reeve 的代理层：引擎前面的唯一入口。
//
//   POST /v1/chat/completions   引擎的模型调用：路由 → 候选顺位 → 首字节前失败就换 → 流式转发
//   GET  /v1/models             模型目录：注册表声明 ∪ 运行时池（9router 等，TTL 缓存）∪ 链名
//   POST /gate/session          插件侧的 session→agent 桥（把"这个 session 是 scout"告诉 GATE）
//   POST /gate/session/:id/next 插件侧要"下一个候选"（流已开始/沉默这两类层内换不了的情形）
//   GET  /gate/version          探针/测试用
//   GET  /gate/free             免费模型池运行态（发现源/展开预览/冷却）——面板只读它
//   GET  /gate/model-meta       档位元数据（成本/limit/发布时间，首跳语义）——插件填 Model.Info 用
//
// 纪律：① 只记录、不泄漏——台账里没有密钥（只记键的"名字"）；② 时间与 IO 全可注入（测试零 sleep、零真实出网）；
// ③ 管理面只认环回；④ dispose 尽力而为、绝不因为清理炸掉（含"定时器已开"的情况）。
import { createServer } from 'node:http'
import { appendFile, mkdir, readFile as readFileFs, rename, stat as statFs } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { classifyFailure } from './classify.js'
import { BUNDLED_FALLBACK_PATH, defaultFallbackConfigPath, loadGateConfig, normalizeGateConfig, watchGateConfig } from './config.js'
import { createFreeLane } from './free.js'
import { IMAGE_CHAINS, attemptKey, attemptRow, buildUpstreamRequest, hasImage, modelsPathOf, parseTarget, planAttempts, resolveKeyFor, routeFor } from './lanes.js'
import { computeModelMeta } from './model-meta.js'
import { createSessionStore } from './state.js'

export const GATE_VERSION = '0.1.0'
export const GATE_DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  maxBodyBytes: 64 * 1024 * 1024,
  ledgerMaxBytes: 5 * 1024 * 1024,
  configWatchMs: 5000,
  errorTextBytes: 64 * 1024,
})

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** 追加式台账；超过上限就轮转到 `.1`（只留一代，够用）。**写入失败只记日志，绝不打断请求**。 */
export function createLedger({ path, maxBytes = GATE_DEFAULTS.ledgerMaxBytes, logger = console } = {}) {
  let size = null
  let pending = Promise.resolve()
  const line = (row) => `${JSON.stringify(row)}\n`
  const append = async (row) => {
    try {
      await mkdir(dirname(path), { recursive: true })
      if (size === null) size = (await statFs(path).catch(() => ({ size: 0 }))).size
      const text = line(row)
      if (size > 0 && size + Buffer.byteLength(text) > maxBytes) {
        await rename(path, `${path}.1`).catch(() => {})
        size = 0
      }
      await appendFile(path, text)
      size += Buffer.byteLength(text)
    } catch (err) {
      logger?.debug?.(`[gate] 台账写入失败（忽略）：${String(err).slice(0, 140)}`)
    }
  }
  return {
    path,
    write: (row) => {
      pending = pending.then(() => append(row))
      return pending
    },
    flush: () => pending,
  }
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', (c) => {
      if (tooLarge) return // 已判过大：排空但不再累积（不 destroy —— 那样响应发不出去，客户端只看到连接被重置）
      size += c.length
      if (size > maxBytes) {
        tooLarge = true
        chunks.length = 0
        reject(Object.assign(new Error('请求体过大'), { code: 'E_TOO_LARGE' }))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

const sendJson = (res, status, obj) => {
  const text = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(text)
}

// ---- 0.2.8 空响应守卫 ----
// 非流式响应的"真内容"证据：tool_calls、非空字符串 content/reasoning、数组形 content。
// `"content":""`（空串）、`[DONE]` 行、空 delta 都不算。流式走首块探测（见请求循环内注释）。
const REAL_RESPONSE_RE = new RegExp(
  [
    /"tool_calls"\s*:/.source,
    /"(?:content|reasoning_content|reasoning|text|output_text)"\s*:\s*"(?:[^"\\]|\\.)+/.source,
    /"content"\s*:\s*\[/.source,
  ].join('|'),
)


/**
 * 拉起 GATE。返回 handle：`{ port, detach, dispose, snapshot, reload, sessions, ledgerPath, configPath }`。
 * 生命周期：`detach()` = 插件实例卸载但 GATE 继续服务（引擎级，活到进程退出）；`dispose()` = 真关
 * （测试与显式停止用）。任何"起不来"的失败都**抛**（它是引擎启动路径上的东西，吵比静默好）；运行期失败只记日志。
 */
export async function startGate({
  port,
  host = GATE_DEFAULTS.host,
  configPath = defaultFallbackConfigPath(),
  bundledPath = BUNDLED_FALLBACK_PATH,
  ledgerPath = join(homedir(), '.reeve', 'gate.jsonl'),
  authPath = join(homedir(), '.local', 'share', 'opencode', 'auth.json'),
  logger = console,
  now = Date.now,
  fetchImpl = fetch,
  readFileImpl = readFileFs,
  statImpl = statFs,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
  emptyProbeGraceMs = 400,
  configWatchMs = GATE_DEFAULTS.configWatchMs,
  maxBodyBytes = GATE_DEFAULTS.maxBodyBytes,
  ledgerMaxBytes = GATE_DEFAULTS.ledgerMaxBytes,
  errorTextBytes = GATE_DEFAULTS.errorTextBytes,
} = {}) {
  let auth = {}
  const loadAuth = async () => {
    try {
      auth = JSON.parse(await readFileImpl(authPath, 'utf8'))
    } catch {
      auth = {}
    }
  }
  await loadAuth()

  const attach = (cfg) => (cfg ? { ...cfg, env: process.env, auth } : null)
  const loaded = await loadGateConfig({ path: configPath, bundledPath, readFileImpl })
  let config = attach(loaded.config) ?? attach(normalizeGateConfig({}))
  let configFrom = loaded.from
  let problems = [...(loaded.problems ?? []), ...(loaded.error ? [loaded.error] : [])]

  const sessions = createSessionStore({ now, policy: () => config?.policy ?? {} })
  const ledger = createLedger({ path: ledgerPath, maxBytes: ledgerMaxBytes, logger })
  const modelsCache = { at: 0, data: null }
  /** 多键轮转：同 provider 多把键时按序轮转（游标在服务侧；纯逻辑只负责"用哪把"）。 */
  const keyCursors = new Map()
  const keyPicker = (provider) => {
    if (provider.key !== null && provider.key !== undefined) return resolveKeyFor(provider, { env: process.env, auth })
    const available = (provider.auth ?? []).filter((id) => typeof auth?.[id]?.key === 'string' && auth[id].key.length > 0)
    if (available.length === 0) return null
    const at = keyCursors.get(provider.id) ?? 0
    keyCursors.set(provider.id, at + 1)
    const id = available[at % available.length]
    return { key: auth[id].key, name: `auth:${id}` }
  }

  // 免费模型池：发现（公开模型列表/静态白名单）+ `@free` 展开 + 按 ref 的全局冷却。
  // 读的是**当前** config（热更即时生效）；时间/IO 注入，测试零出网。
  const freeLane = createFreeLane({ getConfig: () => config, getAuth: () => auth, now, fetchImpl, logger })

  const note = (row) => ledger.write(row)

  /** 模型目录：声明 ∪ 运行时池（TTL）∪ 链名。池拉不到就降级（只回声明），不报错。 */
  const listModels = async () => {
    const ttlMs = Math.max(1, Number(config.policy.models_ttl_seconds ?? 300)) * 1000
    if (modelsCache.data && now() - modelsCache.at < ttlMs) return modelsCache.data
    const data = []
    const seen = new Set()
    const push = (id, ownedBy) => {
      if (seen.has(id)) return
      seen.add(id)
      data.push({ id, object: 'model', owned_by: ownedBy })
    }
    await loadAuth()
    for (const provider of Object.values(config.providers)) {
      for (const m of provider.models ?? []) if (m !== '*') push(`${provider.id}/${m}`, provider.id)
      if (!provider.models_fetch || !provider.base_url) continue
      const resolved = resolveKeyFor(provider, { env: process.env, auth })
      if (resolved === null) continue
      try {
        const res = await fetchImpl(`${provider.base_url}${modelsPathOf(provider)}`, {
          headers: resolved.key === null ? {} : { authorization: `Bearer ${resolved.key}` },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = await res.json()
        for (const m of body?.data ?? []) if (m?.id) push(`${provider.id}/${m.id}`, provider.id)
      } catch (err) {
        logger?.debug?.(`[gate] 拉 ${provider.id} 的模型池失败（降级）：${String(err).slice(0, 120)}`)
      }
    }
    // 免费模型池发现到的模型也进目录（面板的选择器才能看到并固定它们；`@free` 本身不需要进）
    try {
      for (const c of await freeLane.discovered()) push(c.ref, c.provider)
    } catch {
      /* 发现失败只影响目录的完整性，不影响请求 */
    }
    for (const name of Object.keys(config.chains)) push(name, 'reeve')
    modelsCache.data = data
    modelsCache.at = now()
    return data
  }

  let reqSeq = 0
  const doChat = async (req, res) => {
    const reqId = ++reqSeq
    let bodyText
    try {
      bodyText = await readBody(req, maxBodyBytes)
    } catch (err) {
      return sendJson(res, err?.code === 'E_TOO_LARGE' ? 413 : 400, { error: { message: String(err?.message ?? err).slice(0, 120) } })
    }
    let model = null
    let parsedBody = null
    try {
      parsedBody = JSON.parse(bodyText)
      if (typeof parsedBody?.model === 'string') model = parsedBody.model
    } catch {
      /* 非 JSON：下面按 400 处理 */
    }
    if (!model) return sendJson(res, 400, { error: { message: 'model 字段缺失，或 body 不是 JSON' } })

    const sessionID = typeof req.headers['x-opencode-session-id'] === 'string' ? req.headers['x-opencode-session-id'] : null
    let route = routeFor({ model, sessionID }, { config, sessions })
    if (!route) return sendJson(res, 404, { error: { message: `未知模型或链：${model}` } })
    // 文本档位收到图片：只把**这一次请求**改走视觉链。会话模型/composer 不动。
    if (hasImage(parsedBody)) {
      const imageChain = IMAGE_CHAINS[route.chain]
      if (imageChain && config.chains?.[imageChain]) {
        const imageRoute = routeFor({ model: imageChain, sessionID }, { config, sessions })
        if (imageRoute) route = { ...imageRoute, agent: route.agent, requestedModel: route.requestedModel }
      }
    }
    // `@free` → 当前可发现、未冷却、有键的真实候选（动态链不复用按索引的粘性指针）
    const expanded = await freeLane.expand(route.targets, { maxAttempts: config.policy.max_fallback_attempts })
    const plan = planAttempts({ ...route, targets: expanded.targets, dynamicFree: expanded.dynamic }, { config, sessions, sessionID, keyPicker })

    if (plan.ordered.length === 0) {
      return sendJson(res, 502, {
        error: {
          message: '没有可用候选（provider 未配置或键取不到）',
          chain: plan.chainName,
          skipped: plan.skipped.map((s) => `${s.target}（${s.why}）`),
        },
      })
    }

    const attemptsSeen = []
    for (let i = 0; i < plan.ordered.length; i++) {
      const attempt = plan.ordered[i]
      const spec = buildUpstreamRequest({ attempt, inHeaders: req.headers, bodyText, version: GATE_VERSION })
      const t0 = now()
      let upstream = null
      let netError = null
      let retries = 0
      const controller = new AbortController()
      const onClose = () => controller.abort()
      // 监听**不摘**：流式阶段客户端断开也要中止上游（分别对应"客户端中途取消"这类真实行为）
      res.on('close', onClose)
      try {
        for (let r = 0; ; r++) {
          try {
            upstream = await fetchImpl(spec.url, { method: 'POST', headers: spec.headers, body: spec.body, signal: controller.signal })
            if (upstream.ok || upstream.status < 500 || r >= (attempt.provider.retries ?? 0)) break
            retries = r + 1
            await sleepImpl(200)
          } catch (err) {
            netError = err
            if (r >= (attempt.provider.retries ?? 0) || controller.signal.aborted) break
            retries = r + 1
            await sleepImpl(200)
          }
        }
      } catch (err) {
        netError = err
      }

      if (netError) {
        const detail = String(netError?.message ?? netError).slice(0, 160)
        note(attemptRow({ ts: new Date(t0).toISOString(), chainName: plan.chainName, agent: plan.agent, attempt, status: 'error', code: null, latencyMs: now() - t0, retries, detail, req: reqId, n: i + 1 }))
        attemptsSeen.push({ provider: attempt.provider.id, model: attempt.model, code: null, reason: 'network' })
        sessions.noteFailure(sessionID ?? '(anon)', plan.chainName, attemptKey(attempt))
        freeLane.noteAttempt(attempt, false)
        continue
      }

      if (upstream.ok) {
        // ---- 空响应守卫 ----
        // 某些免费模型会回 200 但零内容（2026-10-26 EL7：nemotron 空 200 → 引擎记一条空
        // assistant 消息并闲置，轮次就地死亡）。分两档：
        //   · 非流式（无 body）：text() 全文判空 → 立即换下一个候选（可完全止损）；
        //   · 流式：0.2.9 起由"首字节 failover 泵"接管（见下）——首字节前停滞/断流
        //     直接换候选，首块后停滞截断并记账，finish 判空语义保持 0.2.8。
        const contentType = upstream.headers?.get?.('content-type') ?? 'application/json'
        const isStream = /text\/event-stream/i.test(contentType)
        if (!isStream) {
          const text = await upstream.text().catch(() => '')
          if (!REAL_RESPONSE_RE.test(text)) {
            note(attemptRow({ ts: new Date(t0).toISOString(), chainName: plan.chainName, agent: plan.agent, attempt, status: 'error', code: upstream.status, latencyMs: now() - t0, retries, detail: 'empty response', req: reqId, n: i + 1 }))
            attemptsSeen.push({ provider: attempt.provider.id, model: attempt.model, code: upstream.status, reason: 'empty' })
            sessions.noteFailure(sessionID ?? '(anon)', plan.chainName, attemptKey(attempt))
            freeLane.noteAttempt(attempt, false)
            continue
          }
          note(attemptRow({ ts: new Date(t0).toISOString(), chainName: plan.chainName, agent: plan.agent, attempt, status: 'ok', code: upstream.status, latencyMs: now() - t0, retries, req: reqId, n: i + 1 }))
          sessions.noteSuccess(sessionID ?? '(anon)', plan.chainName, attemptKey(attempt), plan.keys)
          freeLane.noteAttempt(attempt, true)
          res.writeHead(upstream.status, {
            'content-type': contentType,
            'x-reeve-fallback': `${i + 1}/${attempt.provider.id}/${attempt.model}`,
          })
          res.end(text)
          return
        }
        // ---- 0.2.9 首字节 failover（流式）----
        // 真实事故（2026-10-26 zhipuai）：上游 200 之后 ~45s 零字节、流挂死 —— 引擎整轮
        // 等死，并发 subagent 全灭。0.2.8 的流式守卫只能在 finish 后记账：头已提交，当轮无救。
        // 结构（上两版教训都在这：① pipe 与手读并存 = 双消费者死锁；② 指望
        // `controller.abort()` 惊动挂着的 read —— 实测（Node 24/undici）abort **不会**
        // 唤醒已 resolve 响应的 body 流上的 pending read，计时器到点泵照样睡着）：
        //   · 首字节到达前**不提交响应头** —— 换候选的自由还在；
        //   · **真计时器 + 竞赛唤醒**：停滞计时器独立于数据事件流动（静默期照走），
        //     到点 resolve 一个 stall 信号，`Promise.race` 里赢过挂着的 read —— 泵的
        //     唯一暂停点是这场竞赛，永不依赖流自身醒过来。abort/cancel 只做善后清理；
        //   · 窗口：首字节 `stream_first_byte_ms`（默认 45s），首块后放宽为
        //     `stream_idle_ms`（默认 120s）。总时长永不设限 —— 推理模型合法地慢，
        //     只对"静默"设限；
        //   · **单消费者泵**：upstream.body 只挂一个 reader，任意时刻至多一个 pending
        //     read；竞赛输掉的 read 预挂 catch（abort 后它会被拒绝，不能没人接）；
        //   · 记账先到先得（settled 旗）：finish 的 0.2.8 判空与停滞/截断记账互斥。
        const firstByteMs = Math.max(1, Number(config.policy.stream_first_byte_ms ?? 45_000))
        const idleMs = Math.max(1, Number(config.policy.stream_idle_ms ?? 120_000))
        const decoder = new TextDecoder()
        const probe = { head: '' }
        let committed = false // 响应头已提交：此后只能截断，不能换候选
        let settled = false // 失败账已记（finish 判空与停滞/截断记账互斥，绝不双记）
        let stalled = false // 本次中断是否来自停滞计时器
        let wakeStall = null
        const stallSignal = new Promise((resolve) => {
          wakeStall = () => {
            wakeStall = null
            stalled = true
            resolve()
          }
        })
        let stallTimer = null
        const armStall = (ms) => {
          if (stallTimer) clearTimeout(stallTimer)
          stallTimer = setTimeout(() => {
            stallTimer = null
            wakeStall?.()
          }, ms)
          stallTimer.unref?.()
        }
        const disarmStall = () => {
          if (stallTimer) {
            clearTimeout(stallTimer)
            stallTimer = null
          }
        }
        const settleFailure = () => {
          if (settled) return
          settled = true
          freeLane.noteAttempt(attempt, false)
          sessions.noteFailure(sessionID ?? '(anon)', plan.chainName, attemptKey(attempt))
          logger?.debug?.(`[gate] 流式${stalled ? '停滞' : '中断'}：${attempt.provider.id}/${attempt.model} → 冷却`)
        }
        res.on('finish', () => {
          // 0.2.8 语义不变：正常收尾才判空。ok 行是 HTTP 层面的事实，守卫的效力落在冷却上。
          // 换候选后本监听仍挂在 res 上：靠 `!committed` 自哑（上一轮从未提交过响应头）。
          if (settled || !committed) return
          settled = true
          const empty = !REAL_RESPONSE_RE.test(probe.head)
          freeLane.noteAttempt(attempt, !empty)
          if (empty) {
            sessions.noteFailure(sessionID ?? '(anon)', plan.chainName, attemptKey(attempt))
            logger?.debug?.(`[gate] 空响应（流式，事后判空）：${attempt.provider.id}/${attempt.model} → 冷却`)
          }
        })
        try {
          armStall(firstByteMs)
          const reader = upstream.body.getReader()
          while (true) {
            const read = reader.read()
            read.catch(() => {}) // 竞赛输家也要有人接 rejection（abort 后它必被拒绝）
            const won = await Promise.race([
              read,
              stallSignal.then(() => ({ stalled: true })),
            ])
            if (won?.stalled) {
              try {
                controller.abort() // 善后：连接不留给挂死的上游（abort 本身不惊动泵 —— 靠竞赛醒）
              } catch { /* 已中止/实现差异：忽略 */ }
              reader.cancel().catch(() => {})
              throw new Error(`stalled after ${committed ? idleMs : firstByteMs}ms of silence`)
            }
            disarmStall()
            if (won.done) break
            if (!committed) {
              committed = true
              note(attemptRow({ ts: new Date(t0).toISOString(), chainName: plan.chainName, agent: plan.agent, attempt, status: 'ok', code: upstream.status, latencyMs: now() - t0, retries, req: reqId, n: i + 1 }))
              sessions.noteSuccess(sessionID ?? '(anon)', plan.chainName, attemptKey(attempt), plan.keys)
              res.writeHead(upstream.status, {
                'content-type': contentType,
                'x-reeve-fallback': `${i + 1}/${attempt.provider.id}/${attempt.model}`,
              })
            }
            armStall(idleMs)
            if (probe.head.length < 1024 * 1024) probe.head += decoder.decode(won.value, { stream: true })
            // 不等 drain：SSE 是令牌级小流量、消费端是环回上的引擎；等 drain 会给泵加第二个
            // 暂停点 —— 客户端停走时竞赛唤醒不了它（又是死锁形状）。
            res.write(won.value)
          }
          disarmStall()
          if (!committed) {
            // 200 + event-stream 但零字节就干净收尾（0.2.8 的"空流"）：当轮可救，直接换。
            note(attemptRow({ ts: new Date(t0).toISOString(), chainName: plan.chainName, agent: plan.agent, attempt, status: 'error', code: upstream.status, latencyMs: now() - t0, retries, detail: 'empty stream', req: reqId, n: i + 1 }))
            attemptsSeen.push({ provider: attempt.provider.id, model: attempt.model, code: upstream.status, reason: 'empty' })
            freeLane.noteAttempt(attempt, false)
            sessions.noteFailure(sessionID ?? '(anon)', plan.chainName, attemptKey(attempt))
            continue
          }
          res.end()
          return
        } catch (err) {
          disarmStall()
          // 到这里的中止源：停滞竞赛（stalled）、res 'close'（客户端走人，经 onClose abort）、
          // 上游自身断流。三者都按"这个候选失败了"对账 —— 只有客户端走人不记账。
          const clientGone = controller.signal.aborted && !stalled
          if (!committed) {
            if (clientGone) return // 客户端先走：没什么可服务的，静默收场，不算上游的账
            note(attemptRow({ ts: new Date(t0).toISOString(), chainName: plan.chainName, agent: plan.agent, attempt, status: 'error', code: upstream.status, latencyMs: now() - t0, retries, detail: stalled ? `stalled: no first byte in ${firstByteMs}ms` : `stream error: ${String(err?.message ?? err).slice(0, 120)}`, req: reqId, n: i + 1 }))
            attemptsSeen.push({ provider: attempt.provider.id, model: attempt.model, code: upstream.status, reason: stalled ? 'stalled' : 'stream_error' })
            freeLane.noteAttempt(attempt, false)
            sessions.noteFailure(sessionID ?? '(anon)', plan.chainName, attemptKey(attempt))
            continue // 首字节前失败当轮可救：换下一个候选
          }
          // 头已提交：只能截断。客户端走人不是 provider 的错，不记账。
          if (!clientGone) settleFailure()
          if (!res.writableEnded) res.end()
          return
        }
      }

      const text = (await upstream.text().catch(() => '')).slice(0, errorTextBytes)
      const cls = classifyFailure({ status: upstream.status, text, headers: upstream.headers, policy: config.policy })
      note(attemptRow({ ts: new Date(t0).toISOString(), chainName: plan.chainName, agent: plan.agent, attempt, status: 'error', code: upstream.status, latencyMs: now() - t0, retries, detail: cls.reason, req: reqId, n: i + 1 }))
      attemptsSeen.push({ provider: attempt.provider.id, model: attempt.model, code: upstream.status, reason: cls.reason })
      if (!cls.retryable) {
        // 不换：把上游的应答原样交给调用方（这是它的错，不是链的错）
        res.writeHead(upstream.status, {
          'content-type': upstream.headers?.get?.('content-type') ?? 'application/json',
          'x-reeve-fallback': `${i + 1}/${attempt.provider.id}/${attempt.model}`,
        })
        res.end(text)
        return
      }
      sessions.noteFailure(sessionID ?? '(anon)', plan.chainName, attemptKey(attempt))
      freeLane.noteAttempt(attempt, false)
    }

    sendJson(res, 502, { error: { message: '所有候选都失败', chain: plan.chainName, req: reqId, attempts: attemptsSeen } })
  }

  const server = createServer((req, res) => {
    const url = String(req.url ?? '')
    const remote = req.socket?.remoteAddress ?? ''
    const run = async () => {
      if (req.method === 'GET' && url.startsWith('/v1/models')) {
        return sendJson(res, 200, { object: 'list', data: await listModels() })
      }
      if (req.method === 'GET' && url.startsWith('/gate/version')) {
        return sendJson(res, 200, {
          name: 'reeve-gate',
          version: GATE_VERSION,
          port: server.address()?.port ?? port,
          from: configFrom,
          chains: Object.keys(config.chains),
          chain_targets: Object.fromEntries(Object.entries(config.chains).map(([name, spec]) => [name, [...(spec?.targets ?? [])]])),
          providers: Object.keys(config.providers),
          policy: {
            max_fallback_attempts: config.policy.max_fallback_attempts,
            cooldown_seconds: config.policy.cooldown_seconds,
            restore_primary_after_cooldown: config.policy.restore_primary_after_cooldown,
            provider_retries: config.policy.provider_retries,
            stream_first_byte_ms: config.policy.stream_first_byte_ms,
            stream_idle_ms: config.policy.stream_idle_ms,
          },
          agents: { ...config.agents },
          chain_for_model: { ...config.chain_for_model },
          default_chain: config.default_chain ?? null,
          // 免费模型池的**配置**（运行态在 /gate/free；面板的"已生效"比对用这一份）
          free: {
            enabled: config.free.enabled,
            max: config.free.max,
            providers: [...config.free.providers],
            refresh_seconds: config.free.refresh_seconds,
            failure_threshold: config.free.failure_threshold,
            failure_cooldown_seconds: config.free.failure_cooldown_seconds,
            prefer: [...config.free.prefer],
            deny: [...config.free.deny],
            static: { ...config.free.static },
            sources: { ...config.free.sources },
          },
          problems,
          sessions: sessions.snapshot(),
          ledger: ledger.path,
        })
      }
      if (url.startsWith('/gate/')) {
        if (!LOOPBACK.has(remote)) return sendJson(res, 403, { error: { message: '管理面只认环回' } })
        if (req.method === 'GET' && url === '/gate/free') {
          return sendJson(res, 200, await freeLane.snapshot())
        }
        if (req.method === 'GET' && url === '/gate/model-meta') {
          // 档位元数据：models.dev（已拉的那份；按需首拉，require_image=false 的机器不周期出网）
          // + 当前链的首跳语义。查无条目的字段整个省略——诚实优于编数。
          const st = await freeLane.ensureModality()
          const pool = await freeLane.discovered().catch(() => [])
          return sendJson(res, 200, computeModelMeta({ config, raw: st.raw, pool }))
        }
        if (req.method === 'POST' && url === '/gate/session') {
          const bodyText = await readBody(req, 1024 * 1024).catch(() => '{}')
          const { sessionID, agent } = JSON.parse(bodyText || '{}')
          if (typeof sessionID !== 'string' || sessionID.length === 0) return sendJson(res, 400, { error: { message: 'sessionID 必填' } })
          sessions.setAgent(sessionID, agent)
          return sendJson(res, 200, { ok: true })
        }
        const nextMatch = url.match(/^\/gate\/session\/([^/]+)\/next$/)
        if (req.method === 'POST' && nextMatch) {
          const sessionID = decodeURIComponent(nextMatch[1])
          const bodyText = await readBody(req, 1024 * 1024).catch(() => '{}')
          const { dedupeKey = null } = JSON.parse(bodyText || '{}')
          const agent = sessions.agentOf(sessionID)
          const chainName = agent && config.agents[agent] ? config.agents[agent] : config.default_chain
          if (!chainName || !config.chains[chainName]) return sendJson(res, 200, { model: null, chain: null })
          // 动态链（含 `@free`）在调用时展开，插件侧拿到的才是真实候选而不是占位符
          const parsed = config.chains[chainName].targets.map(parseTarget).filter(Boolean)
          const expanded = await freeLane.expand(parsed, { maxAttempts: config.policy.max_fallback_attempts })
          const keys = expanded.targets.filter((t) => !t.free).map((t) => `${t.provider}/${t.model}`)
          const out = sessions.advance(sessionID, chainName, keys, { dedupeKey })
          return sendJson(res, 200, { model: out.model, chain: chainName, index: out.index })
        }
        return sendJson(res, 404, { error: { message: '未知的 gate 路由' } })
      }
      if (req.method === 'POST' && url.startsWith('/v1/chat/completions')) return doChat(req, res)
      return sendJson(res, 404, { error: { message: `未知路由：${req.method} ${url}` } })
    }
    void run().catch((err) => {
      logger?.debug?.(`[gate] 处理请求失败：${String(err).slice(0, 160)}`)
      if (!res.headersSent) sendJson(res, 500, { error: { message: String(err?.message ?? err).slice(0, 160) } })
      else res.end()
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  // 引擎级服务：监听口**不**替引擎续命。引擎是长活进程，自己有事吊着；而 CLI 那种一次性
  // 进程卸载插件后必须能立刻退出 —— 少了这一行，卸载后还挂着一个 ref 着的监听 handle。
  server.unref?.()

  const watch = watchGateConfig({
    path: configPath,
    bundledPath,
    intervalMs: configWatchMs,
    readFileImpl,
    statImpl,
    onChange: (next) => {
      if (next.config) {
        config = attach(next.config)
        configFrom = next.from
        problems = [...(next.problems ?? [])]
        modelsCache.data = null
        logger?.debug?.(`[gate] 配置热更：${next.from}`)
        freeLane.warm()
      } else {
        logger?.debug?.(`[gate] 配置读不动，保留上一份：${next.error ?? '?'}`)
      }
    },
  })
  // 免费模型池后台预热（不阻塞启动；失败只影响免费候选，请求照常降级到付费）
  freeLane.warm()

  const disposeFns = [() => watch.stop(), () => ledger.flush(), () => new Promise((r) => server.close(() => r()))]
  let sweep = null
  return {
    port: server.address()?.port ?? port,
    host,
    sessions,
    ledgerPath: ledger.path,
    configPath,
    flushLedger: () => ledger.flush(),
    snapshot: () => ({
      port: server.address()?.port ?? port,
      version: GATE_VERSION,
      from: configFrom,
      chains: Object.keys(config.chains),
      chain_targets: Object.fromEntries(Object.entries(config.chains).map(([name, spec]) => [name, [...(spec?.targets ?? [])]])),
      providers: Object.keys(config.providers),
      policy: {
        max_fallback_attempts: config.policy.max_fallback_attempts,
        cooldown_seconds: config.policy.cooldown_seconds,
        restore_primary_after_cooldown: config.policy.restore_primary_after_cooldown,
        provider_retries: config.policy.provider_retries,
        stream_first_byte_ms: config.policy.stream_first_byte_ms,
        stream_idle_ms: config.policy.stream_idle_ms,
      },
      agents: { ...config.agents },
      chain_for_model: { ...config.chain_for_model },
      default_chain: config.default_chain ?? null,
      free: {
        enabled: config.free.enabled,
        max: config.free.max,
        providers: [...config.free.providers],
        refresh_seconds: config.free.refresh_seconds,
        failure_threshold: config.free.failure_threshold,
        failure_cooldown_seconds: config.free.failure_cooldown_seconds,
        prefer: [...config.free.prefer],
        deny: [...config.free.deny],
        static: { ...config.free.static },
      },
      ledger: ledger.path,
      problems,
      sessions: sessions.snapshot(),
    }),
    /**
     * 插件实例卸载时调用（引擎按工作区加载插件：工作区被闲置驱逐 = 这个实例卸载，
     * **不是**引擎退出）。监听口与配置热更留着 —— 否则"起 GATE 的那个工作区"一被驱逐，
     * 其它还活跃的工作区就永久拿不到代理（拆 0.1.7 前的实测）。这里只做两件事：
     * ① 把已经空闲的 keep-alive 连接清掉；② 起一个 unref 的低频清扫，兜住"卸载后才变空闲"的那些
     * （每条连接的生命周期里只有很短一段是 busy，第一条命令常赶不上）；
     * 定时器全是 unref 的，且 2s 后自停 —— 既不拖进程退出，也不长期干扰连接复用。
     */
    detach() {
      const closeIdle = () => {
        try {
          server.closeIdleConnections?.()
        } catch {
          /* 尽力而为 */
        }
      }
      closeIdle()
      if (sweep) return
      sweep = setInterval(closeIdle, 250)
      sweep.unref?.()
      const stop = setTimeout(() => {
        if (sweep) clearInterval(sweep)
        sweep = null
      }, 2000)
      stop.unref?.()
    },
    async dispose() {
      if (sweep) {
        clearInterval(sweep)
        sweep = null
      }
      for (const f of disposeFns.reverse()) {
        try {
          await f()
        } catch {
          /* 清理尽力而为：一项失败不挡其余（这条纪律有前科） */
        }
      }
    },
  }
}
/**
 * 探一台**已经在跑的** GATE（引擎按工作区加载插件 → 同一台机器上会有多个插件实例，
 * 只有第一个该去占端口；后面的实例用这个探针接上，而不是抢口失败后误报）。
 *
 * 判据严格：只有 `name === 'reeve-gate'` 才算（端口上可能是别人的东西 —— 不许瞎认）。
 * @returns {{ok: boolean, reason?: string, snapshot?: object}}
 */
export async function probeGate({ port, host = '127.0.0.1', fetchImpl = fetch, timeoutMs = 800 } = {}) {
  try {
    const res = await fetchImpl(`http://${host}:${port}/gate/version`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
    const doc = await res.json()
    if (doc?.name !== 'reeve-gate') return { ok: false, reason: '端口上有一个服务，但它不是 GATE' }
    return {
      ok: true,
      snapshot: {
        port: Number(doc.port ?? port),
        version: doc.version ?? null,
        from: doc.from ?? null,
        chains: Array.isArray(doc.chains) ? doc.chains : [],
        chain_targets: doc.chain_targets ?? {},
        providers: Array.isArray(doc.providers) ? doc.providers : [],
        policy: doc.policy ?? {},
        agents: doc.agents ?? {},
        chain_for_model: doc.chain_for_model ?? {},
        default_chain: doc.default_chain ?? null,
        ledger: doc.ledger ?? null,
        problems: Array.isArray(doc.problems) ? doc.problems : [],
        sessions: doc.sessions ?? null,
      },
    }
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err).slice(0, 120) }
  }
}
