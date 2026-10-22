// GATE —— reeve 的代理层：引擎前面的唯一入口。
//
//   POST /v1/chat/completions   引擎的模型调用：路由 → 候选顺位 → 首字节前失败就换 → 流式转发
//   GET  /v1/models             模型目录：注册表声明 ∪ 运行时池（9router 等，TTL 缓存）∪ 链名
//   POST /gate/session          插件侧的 session→agent 桥（把"这个 session 是 scout"告诉 GATE）
//   POST /gate/session/:id/next 插件侧要"下一个候选"（流已开始/沉默这两类层内换不了的情形）
//   GET  /gate/version          探针/测试用
//
// 纪律：① 只记录、不泄漏——台账里没有密钥（只记键的"名字"）；② 时间与 IO 全可注入（测试零 sleep、零真实出网）；
// ③ 管理面只认环回；④ dispose 尽力而为、绝不因为清理炸掉（含"定时器已开"的情况）。
import { createServer } from 'node:http'
import { appendFile, mkdir, readFile as readFileFs, rename, stat as statFs } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'

import { classifyFailure } from './classify.js'
import { BUNDLED_FALLBACK_PATH, defaultFallbackConfigPath, loadGateConfig, normalizeGateConfig, watchGateConfig } from './config.js'
import { attemptKey, attemptRow, buildUpstreamRequest, modelsPathOf, planAttempts, resolveKeyFor, routeFor } from './lanes.js'
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

/**
 * 拉起 GATE。返回 handle：`{ port, dispose, snapshot, reload, sessions, ledgerPath, configPath }`。
 * 任何"起不来"的失败都**抛**（它是引擎启动路径上的东西，吵比静默好）；运行期失败只记日志。
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
    try {
      const parsed = JSON.parse(bodyText)
      if (typeof parsed?.model === 'string') model = parsed.model
    } catch {
      /* 非 JSON：下面按 400 处理 */
    }
    if (!model) return sendJson(res, 400, { error: { message: 'model 字段缺失，或 body 不是 JSON' } })

    const sessionID = typeof req.headers['x-opencode-session-id'] === 'string' ? req.headers['x-opencode-session-id'] : null
    const route = routeFor({ model, sessionID }, { config, sessions })
    if (!route) return sendJson(res, 404, { error: { message: `未知模型或链：${model}` } })
    const plan = planAttempts(route, { config, sessions, sessionID, keyPicker })

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
        continue
      }

      if (upstream.ok) {
        note(attemptRow({ ts: new Date(t0).toISOString(), chainName: plan.chainName, agent: plan.agent, attempt, status: 'ok', code: upstream.status, latencyMs: now() - t0, retries, req: reqId, n: i + 1 }))
        sessions.noteSuccess(sessionID ?? '(anon)', plan.chainName, attemptKey(attempt), plan.keys)
        res.writeHead(upstream.status, {
          'content-type': upstream.headers?.get?.('content-type') ?? 'application/json',
          'x-reeve-fallback': `${i + 1}/${attempt.provider.id}/${attempt.model}`,
        })
        if (upstream.body) Readable.fromWeb(upstream.body).pipe(res)
        else res.end(await upstream.text().catch(() => ''))
        return
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
          },
          agents: { ...config.agents },
          chain_for_model: { ...config.chain_for_model },
          default_chain: config.default_chain ?? null,
          problems,
          sessions: sessions.snapshot(),
          ledger: ledger.path,
        })
      }
      if (url.startsWith('/gate/')) {
        if (!LOOPBACK.has(remote)) return sendJson(res, 403, { error: { message: '管理面只认环回' } })
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
          const keys = config.chains[chainName].targets
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
      } else {
        logger?.debug?.(`[gate] 配置读不动，保留上一份：${next.error ?? '?'}`)
      }
    },
  })

  const disposeFns = [() => watch.stop(), () => ledger.flush(), () => new Promise((r) => server.close(() => r()))]
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
      },
      agents: { ...config.agents },
      chain_for_model: { ...config.chain_for_model },
      default_chain: config.default_chain ?? null,
      ledger: ledger.path,
      problems,
      sessions: sessions.snapshot(),
    }),
    async dispose() {
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
