// 代理层的"自持"实现 —— 纯插件形态：**不需要任何外部脚本、不需要 ocrc**。
//
// 插件在引擎进程里做五件事（顺序即启动顺序）：
//   ① 取件：按 pin 的 URL + sha256 把 Bifrost 二进制放到自己的目录（首次一次；失败吵）
//   ② 派生 Bifrost 的 config.json：链来自 chainPath（默认 ~/.config/opencode/reeve.jsonc，
//      缺省用插件自带的 default-chain.json），**并在这里关掉回环鉴权**（见下"凭据"）
//   ③ 起进程：spawn + 日志落文件；已有健康实例则复用（reuse-if-healthy）
//   ④ 等就绪：轮询 /api/version（有上限，别把引擎启动拖死）
//   ⑤ 守护：一个 unref 的定时器，每 N 秒探活；死了就地拉起
//
// **凭据**：引擎的 `apiKey` 在引擎启动时就定了，插件改不了它的环境变量 —— 所以自持形态下
// 把 Bifrost 的 `enforce_auth_on_inference` 关掉、引擎侧用占位 apiKey（回环地址上的单用户机器，
// 这个取舍是划算的；要收紧就回到 virtual key 形态：由启动器注入 REEVE_VK）。
// provider 的真 key 只进 Bifrost 的进程环境，来源是 opencode 自己的 `auth.json`（单一真相）。
//
// 实测依据（EL7 staging，引擎 v2.0.27）：插件在引擎里 spawn 长命子进程、process.kill 判活、
// fetch 打 127.0.0.1 的 HTTP 全部可用（探针见 scripts/probe-runtime/）。

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件自带的默认链（与仓库 proxy/config.json 同源；单测里有一条断言盯着它俩不漂移）。 */
export const BUNDLED_CHAIN_PATH = fileURLToPath(new URL('../default-chain.json', import.meta.url))

/** pin 住的那一份（与 ocrc 的 pin 一致；实测版本化 URL 与已部署二进制的 sha256 逐字节相同）。 */
export const BIFROST_PIN = Object.freeze({
  version: '2.3.0',
  url: 'https://downloads.getmaxim.ai/bifrost/v2.3.0/linux/amd64/bifrost-http',
  sha256: 'e62a6425218d037e2aea10446f1f4ad1979291902623575a04b7e0ed46886f92',
  size: 134_264_480,
  binary: 'bifrost-http',
})

export const PROXY_DEFAULTS = Object.freeze({
  port: 8080,
  host: '127.0.0.1',
  healthPath: '/api/version',
  /** 起完等就绪的上限。别太大 —— 它挡在引擎启动路径上 */
  readyTimeoutMs: 20_000,
  /** 守护探活的间隔；0 = 不守护 */
  superviseMs: 20_000,
})

export function proxyPaths({ home = homedir(), dir = null } = {}) {
  const root = dir ?? join(home, '.reeve', 'proxy')
  return {
    root,
    binary: join(root, BIFROST_PIN.binary),
    config: join(root, 'config.json'),
    token: join(root, 'setup-token'),
    log: join(root, 'bifrost.log'),
  }
}

// ── 纯函数（可测的部分） ────────────────────────────────────────────────────

/**
 * provider id → 环境变量名。约定：`REEVE_KEY_<大写、非字母数字→下划线>`。
 * 链配置里 `keys[].value` 写 `env.<这个名字>`，插件**只把 auth.json 里真有的**注进去。
 */
export function providerEnvName(providerId) {
  return 'REEVE_KEY_' + String(providerId).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

/**
 * 从 opencode 的 auth.json + 链里声明的 provider 派生 Bifrost 的进程环境。
 * 只包含链里用到的；缺 key 的如实报出来（不静默）。
 *
 * 查 auth.json 用哪个 id：默认与链里的 provider id 相同；链里为避开 Bifrost 内置名改过名的
 * （例如 `deepseek` → `deepseek-api`），在 key 条目上写 `"fromAuth": "deepseek"`。
 *
 * @param {Record<string, {key?: string}>} auth  auth.json 的内容
 * @param {Array<{id: string, keys?: Array<{value?: string, fromAuth?: string}>}>} chainProviders
 * @returns {{ env: Record<string,string>, missing: string[] }}
 */
export function deriveProviderEnv(auth, chainProviders) {
  const env = {}
  const missing = []
  for (const p of chainProviders ?? []) {
    const id = p?.id
    if (!id) continue
    const envEntries = (p.keys ?? [])
      .filter((k) => typeof k?.value === 'string' && k.value.startsWith('env.'))
      .map((k) => ({ name: k.value.slice('env.'.length), fromAuth: k.fromAuth ?? id }))
    // 链里没写 keys[].value 的（少见）退回约定名 —— 但 provider 名字本身要知道
    const entries = envEntries.length > 0 ? envEntries : [{ name: providerEnvName(id), fromAuth: id }]
    let found = false
    for (const e of entries) {
      const key = auth?.[e.fromAuth]?.key
      if (typeof key === 'string' && key.length > 0) {
        env[e.name] = key
        found = true
      }
    }
    if (!found) missing.push(id)
  }
  return { env, missing }
}

/**
 * 派生要写给 Bifrost 的 config.json。
 * - 原样带上链（providers / governance.routing_rules / client 等）
 * - `noAuth`：关掉回环鉴权（自持形态的凭据取舍，见文件头）
 * - 去掉 `"//"` 前缀的注释键（Bifrost 不认，虽然实测它能容忍未知键，但没必要留）
 */
export function buildProxyConfig(chain, { noAuth = true } = {}) {
  const clean = {}
  for (const [k, v] of Object.entries(chain ?? {})) {
    if (k.startsWith('//')) continue
    clean[k] = v
  }
  const client = { ...(clean.client ?? {}) }
  if (noAuth) client.enforce_auth_on_inference = false
  clean.client = client
  return clean
}

/** 二进制要不要重下：不存在 / 大小不符 / 校验和不对（后者只有读了才算，交给 verifyBinary）。 */
export function needsDownload(fileStat, pin = BIFROST_PIN) {
  if (!fileStat || !fileStat.isFile?.()) return true
  return Number(fileStat.size) !== pin.size
}

/** spawn 的参数。单独拿出来是为了让测试能逐字断言。 */
export function buildSpawnArgs({ paths, port = PROXY_DEFAULTS.port, host = PROXY_DEFAULTS.host }) {
  return [paths.binary, ['-port', String(port), '-host', host, '-app-dir', paths.root]]
}

/**
 * 端口上那个健康的代理**是不是我们自己的**（cmdline 里带我们的 app-dir）。
 *
 * 为什么必须有这一步：两种形态可能共用同一个端口 —— 由启动器起的代理（要 VK）
 * 与插件自持的代理（关回环鉴权）。插件若盲目"复用"，会拿占位 key 去打一个要 VK 的代理，
 * 报 401 "virtual key is required"（实测踩到过）。所以：**只在确认是自己的时候复用**；
 * 是别人的就明确报出来（吵），也不去抢端口。
 *
 * Linux 上读 /proc；其它平台读不到就返回 'unknown'（退回"健康即复用"的旧行为）。
 * @returns {'ours' | 'foreign' | 'unknown'}
 */
export async function ownerOfPort({ dir, readdirImpl = readdir, readFileImpl = readFile }) {
  let pids
  try {
    pids = await readdirImpl('/proc')
  } catch {
    return 'unknown'
  }
  const mine = String(dir)
  let sawBifrost = false
  for (const name of pids) {
    if (!/^\d+$/.test(name)) continue
    try {
      const cmdline = (await readFileImpl(`/proc/${name}/cmdline`, 'utf8')).split('\0').join(' ')
      if (!cmdline.includes('bifrost-http')) continue
      sawBifrost = true
      if (cmdline.includes(mine)) return 'ours'
    } catch {
      /* 进程没了 */
    }
  }
  return sawBifrost ? 'foreign' : 'unknown'
}

/** 从 `/api/version` 的响应体里判就绪（实测形如 `"v2.3.0"`）。 */
export function isReady(status, body) {
  return status === 200 && typeof body === 'string' && body.length > 0
}

// ── IO 部分（薄） ──────────────────────────────────────────────────────────

async function sha256File(path) {
  const buf = await readFile(path)
  return createHash('sha256').update(buf).digest('hex')
}

/** 幂等取件。返回 'ok' | 'installed'；失败抛（**吵**，不静默）。 */
export async function ensureBinary({ paths, pin = BIFROST_PIN, fetchImpl = fetch, logger }) {
  await mkdir(paths.root, { recursive: true })
  try {
    const st = await stat(paths.binary)
    if (!needsDownload(st, pin) && (await sha256File(paths.binary)) === pin.sha256) return 'ok'
    logger?.debug?.('[reeve] 代理二进制校验和不符，重下')
  } catch {
    /* 不存在 → 往下走 */
  }
  logger?.debug?.(`[reeve] 代理二进制取件中（${pin.size} B，${pin.version}）…`)
  const res = await fetchImpl(pin.url)
  if (!res.ok) throw new Error(`取件失败：HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const got = createHash('sha256').update(buf).digest('hex')
  if (got !== pin.sha256) throw new Error(`取件失败：sha256 不符（得到 ${got.slice(0, 12)}…）`)
  const part = `${paths.binary}.part`
  await writeFile(part, buf)
  await chmod(part, 0o755)
  await rename(part, paths.binary)
  logger?.debug?.('[reeve] 代理二进制已就位（sha256 校验通过）')
  return 'installed'
}

async function readAuth(authPath) {
  try {
    return JSON.parse(await readFile(authPath, 'utf8'))
  } catch {
    return {}
  }
}

async function readChain(chainPath, bundledPath) {
  for (const p of [chainPath, bundledPath]) {
    if (!p) continue
    try {
      const text = await readFile(p, 'utf8')
      // 链文件允许整行注释（与仓库里的 proxy/config.json 同风格：注释只可能是整行）
      const stripped = text
        .split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .join('\n')
      return { chain: JSON.parse(stripped), from: p }
    } catch {
      /* 换下一个 */
    }
  }
  throw new Error('找不到链配置（chainPath 与插件自带的 default-chain.json 都读不到）')
}

async function readOrCreateToken(path) {
  try {
    const t = (await readFile(path, 'utf8')).trim()
    if (t.length > 0) return t
  } catch {
    /* 生成 */
  }
  const token = randomBytes(24).toString('hex')
  const fd = await open(path, 'w', 0o600)
  await fd.writeFile(token + '\n')
  await fd.close()
  return token
}

async function healthy({ port, host = PROXY_DEFAULTS.host, timeoutMs = 1500, fetchImpl = fetch }) {
  try {
    const ctl = AbortSignal.timeout(timeoutMs)
    const res = await fetchImpl(`http://${host}:${port}${PROXY_DEFAULTS.healthPath}`, { signal: ctl })
    return isReady(res.status, await res.text())
  } catch {
    return false
  }
}

/** 把运行时的 routing_rules 收敛到文件（缺失→建、有差异→改、多余→删）。失败只记日志。 */
async function convergeRules({ port, host, token, desired, logger }) {
  const base = `http://${host}:${port}/api/routing/rules`
  const hdr = { 'X-Bifrost-Setup-Token': token, 'Content-Type': 'application/json' }
  const SERVER = ['config_hash', 'created_at', 'updated_at', 'chain_rule']
  const clean = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !SERVER.includes(k)))
  const FIELDS = ['name', 'cel_expression', 'enabled', 'targets', 'fallbacks', 'priority', 'scope', 'description']
  const same = (a, b) => FIELDS.every((k) => JSON.stringify(a?.[k]) === JSON.stringify(b?.[k]))
  try {
    const res = await fetch(base, { headers: hdr })
    if (res.status !== 200) return logger?.debug?.(`[reeve] 收敛：读不到运行时规则 HTTP ${res.status}`)
    const runtime = new Map(((await res.json()).rules ?? []).map((r) => [r.id, r]))
    const want = new Map((desired ?? []).map((r) => [r.id, r]))
    let changed = 0
    for (const [id, rule] of want) {
      const have = runtime.get(id)
      if (!have) {
        await fetch(base, { method: 'POST', headers: hdr, body: JSON.stringify(clean(rule)) })
        changed++
      } else if (!same(have, rule)) {
        await fetch(`${base}/${id}`, { method: 'PUT', headers: hdr, body: JSON.stringify(clean(rule)) })
        changed++
      }
    }
    for (const id of runtime.keys()) {
      if (!want.has(id)) {
        await fetch(`${base}/${id}`, { method: 'DELETE', headers: hdr })
        changed++
      }
    }
    if (changed > 0) logger?.debug?.(`[reeve] 收敛：把运行时规则对齐到文件（改/建/删 ${changed} 条）`)
  } catch (err) {
    logger?.debug?.(`[reeve] 收敛失败（忽略）：${String(err).slice(0, 120)}`)
  }
}

/**
 * 自持代理：取件 → 派生配置 → 复用或拉起 → 等就绪 → 收敛 → 起守护。
 * 返回 { dispose, ready, detail, port }；任何失败都**只记日志不抛** ——
 * 代理起不来时该让引擎照常跑（模型会报错，那是吵的），而不是把插件加载搞崩。
 *
 * ⚠️ **首次取件不挡引擎启动**：128 MB 的下载放在后台，`ready=false` 先返回；
 * 守护每 `superviseMs` 重试一次 bootstrap（取件是幂等的），装好就自动往下走。
 * 为什么必须这样：引擎启动被拖住超过 openchamber 的健康等待（45 s）会被判不健康。
 */
export async function startOwnedProxy({
  opts = {},
  logger = console,
  bundledChainPath = BUNDLED_CHAIN_PATH,
  authPath = null,
  fetchImpl = fetch,
  spawnImpl = spawn,
} = {}) {
  const port = Number(opts.port ?? PROXY_DEFAULTS.port)
  const host = opts.host ?? PROXY_DEFAULTS.host
  const paths = proxyPaths({ dir: opts.dir ?? null })
  const readyTimeoutMs = Number(opts.readyTimeoutMs ?? PROXY_DEFAULTS.readyTimeoutMs)
  const superviseMs = Number(opts.superviseMs ?? PROXY_DEFAULTS.superviseMs)
  const readdirImpl = opts.readdirImpl ?? readdir
  const auth = authPath ?? opts.authPath ?? join(homedir(), '.local', 'share', 'opencode', 'auth.json')
  const chainPath = opts.chainPath ?? join(homedir(), '.config', 'opencode', 'reeve.jsonc')

  const disposeFns = []
  const result = { port, host, paths, ready: false, detail: null, dispose: async () => { for (const f of disposeFns.reverse()) await f().catch(() => {}) } }
  let env = null
  let rules = []
  let bootstrapping = null

  /** 取件 → 派生配置 → 拉起/复用 → 等就绪 → 收敛。可重复调用（幂等）。 */
  const bootstrap = async () => {
    const binaryState = await ensureBinary({ paths, fetchImpl, logger })
    const { chain, from } = await readChain(chainPath, bundledChainPath)
    const providers = Object.entries(chain.providers ?? {}).map(([id, v]) => ({ id, ...v }))
    const derived = deriveProviderEnv(await readAuth(auth), providers)
    if (derived.missing.length > 0) logger.debug(`[reeve] auth.json 里没有这些 provider 的 key：${derived.missing.join(', ')}`)
    const proxyConfig = buildProxyConfig(chain, { noAuth: opts.requireVirtualKey !== true })
    await mkdir(paths.root, { recursive: true })
    await writeFile(paths.config, JSON.stringify(proxyConfig, null, 2), 'utf8')
    const token = await readOrCreateToken(paths.token)
    rules = proxyConfig.governance?.routing_rules ?? []
    env = { ...process.env, ...derived.env, BIFROST_SETUP_TOKEN: token }
    logger.debug(`[reeve] 代理链来自 ${from}（${providers.length} 个 provider，${rules.length} 条档位规则）`)

    const owner = await ownerOfPort({ dir: paths.root, readdirImpl: readdirImpl ?? readdir, readFileImpl: readFile })
    if (await healthy({ port, host, fetchImpl })) {
      if (owner === 'foreign') {
        // 端口被别人占着（多半是启动器形态起的那个，要 VK）—— 不去抢、也不复用，吵。
        result.detail = `:${port} 上有一个**不属于本目录**的代理在跑（模式冲突：它要 virtual key，本插件形态用占位 key）——先停掉它，或把 options.proxy.enabled 关掉`
        result.ready = false
        logger.debug(`[reeve] ${result.detail}`)
        return false
      }
      result.detail = `复用已在跑的代理（:${port}）`
    } else {
      launch()
      result.detail = `代理已拉起（:${port}）${binaryState === 'installed' ? '，二进制是本次装好的' : ''}`
    }
    const deadline = Date.now() + readyTimeoutMs
    while (Date.now() < deadline) {
      if (await healthy({ port, host, fetchImpl })) {
        result.ready = true
        await convergeRules({ port, host, token: env.BIFROST_SETUP_TOKEN, desired: rules, logger })
        logger.debug(`[reeve] ${result.detail}，已就绪`)
        return true
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    result.detail = `${result.detail}，但 /api/version 在 ${readyTimeoutMs} ms 内未就绪（看 ${paths.log}）`
    logger.debug(`[reeve] ${result.detail}`)
    return false
  }

  const launch = () => {
    const [bin, args] = buildSpawnArgs({ paths, port, host })
    const child = spawnImpl(bin, args, { cwd: paths.root, env: env ?? process.env, stdio: 'ignore', detached: false })
    child.unref?.()
    logger.debug(`[reeve] 代理已拉起（pid ${child.pid ?? '?'}，:${port}）`)
    return child
  }

  try {
    // 快路径：二进制若已在，bootstrap 很快（起/复用 + 等就绪），可以在 setup 里等
    // 慢路径：二进制不在 → 后台 bootstrap（不挡引擎启动）
    let present = false
    try {
      present = !needsDownload(await stat(paths.binary))
    } catch {
      present = false
    }
    if (present) {
      await bootstrap().catch((err) => {
        result.detail = `代理自持失败：${String(err).slice(0, 200)}`
        logger.debug(`[reeve] ${result.detail}`)
      })
    } else {
      result.detail = `代理二进制首次取件中（${BIFROST_PIN.size} B）—— 后台下载，不挡引擎启动`
      logger.debug(`[reeve] ${result.detail}`)
      bootstrapping = bootstrap().catch((err) => {
        result.detail = `取件失败：${String(err).slice(0, 160)}`
        logger.debug(`[reeve] ${result.detail}`)
        return false
      })
      bootstrapping.finally(() => {
        bootstrapping = null
      })
    }

    // 守护：没就绪就把 bootstrap 再走一遍（取件幂等）；已就绪只探活并按需重启
    if (superviseMs > 0) {
      const timer = setInterval(async () => {
        try {
          if (!result.ready) {
            if (bootstrapping) return // 后台那次还没跑完
            await bootstrap()
            return
          }
          if (await healthy({ port, host, fetchImpl })) return
          logger.debug(`[reeve] 代理失联，重新拉起（:${port}）`)
          launch()
        } catch (err) {
          logger.debug(`[reeve] 守护巡检失败（忽略）：${String(err).slice(0, 140)}`)
        }
      }, superviseMs)
      timer.unref?.()
      disposeFns.push(() => clearInterval(timer))
    }
    // dispose 不杀代理：它可以在引擎重启之间活着（下次启动会"复用"）
  } catch (err) {
    result.detail = `代理自持失败：${String(err).slice(0, 200)}`
    logger.debug(`[reeve] ${result.detail}`)
  }
  return result
}