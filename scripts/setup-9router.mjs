#!/usr/bin/env node
// 9router 常驻服务（免费车道网关）—— 安装 / 起停 / 健康 / 登录自启。
//
// 为什么是脚本而不是命令行直接 `9router &`：**正式运行时必须后台不可见**（用户要求）。
// Windows 上 console 程序从 shell 拉起会带一个黑窗口；这里一律：
//   · 直接用 node 跑 `9router/cli.js`（绕开 npm 的 .cmd 垫片）
//   · spawn 一律 `detached + windowsHide + stdio 重定向到日志文件`
//   · 登录自启用一个 VBS 垫片（wscript 以 window style 0 拉起）注册成计划任务 —— 全程无窗口
// EL7（cron/systemd）没有窗口问题：`--unit-print` 打一份 systemd unit 出来即可。
//
// 用法（幂等）：
//   node scripts/setup-9router.mjs ensure      # 健康就什么都不做；不健康就起（默认命令）
//   node scripts/setup-9router.mjs install     # npm i -g 9router@<PIN>（只在缺/版本不符时）
//   node scripts/setup-9router.mjs start|stop|restart|status
//   node scripts/setup-9router.mjs task-install|task-remove   # Windows 登录自启（隐藏）
//   node scripts/setup-9router.mjs --unit-print                # Linux：systemd unit 到 stdout
//
// 端口/主机：默认 127.0.0.1:20128（与 GATE 的 `9router` provider 一致）。
// 状态目录：`~/.9router/ocrc/`（pid / 日志 / 隐藏启动垫片）——**不进 sync**（机器自理）。

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const NINE_PIN = '0.5.104'
const HOST = process.env.NINE_HOST ?? '127.0.0.1'
const PORT = Number(process.env.NINE_PORT ?? 20128)
const HOME = homedir()
const STATE_DIR = join(HOME, '.9router', 'ocrc')
const PID_FILE = join(STATE_DIR, '9router.pid')
const LOG_FILE = join(STATE_DIR, '9router.log')
const VBS_FILE = join(STATE_DIR, 'launch-hidden.vbs')
const TASK_NAME = 'ocrc-9router'
const IS_WIN = process.platform === 'win32'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function health({ timeoutMs = 3000 } = {}) {
  try {
    const res = await fetch(`http://${HOST}:${PORT}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

/** 全局 9router 的 cli.js 路径（null = 没装）。先猜标准前缀，猜不到再问 npm（.cmd 需要 shell）。 */
export function cliPath() {
  const guesses = [
    process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules', '9router', 'cli.js') : null,
    '/usr/lib/node_modules/9router/cli.js',
    '/usr/local/lib/node_modules/9router/cli.js',
  ].filter(Boolean)
  for (const g of guesses) if (existsSync(g)) return g
  const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', windowsHide: true, shell: IS_WIN })
  if (npmRoot.status !== 0) return null
  const p = join(String(npmRoot.stdout).trim(), '9router', 'cli.js')
  return existsSync(p) ? p : null
}

export function installedVersion() {
  const cli = cliPath()
  if (!cli) return null
  try {
    return JSON.parse(readFileSync(join(dirname(cli), 'package.json'), 'utf8')).version
  } catch {
    return null
  }
}

function readPid() {
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 谁在听 PORT（pid 文件缺失时的兜底：别人手动起的实例也能收掉）。 */
function pidByPort() {
  const r = spawnSync(IS_WIN ? 'netstat' : 'ss', IS_WIN ? ['-ano'] : ['-ltnp'], { encoding: 'utf8', windowsHide: true })
  const lines = String(r.stdout ?? '').split('\n')
  for (const line of lines) {
    if (!line.includes(`:${PORT}`) || !line.includes('LISTEN')) continue
    const cols = line.trim().split(/\s+/)
    const pid = Number(cols[cols.length - 1])
    if (Number.isInteger(pid) && pid > 0) return pid
  }
  return null
}

export async function stop() {
  const pid = readPid() ?? pidByPort()
  if (IS_WIN) {
    // /T 连进程树一起收（cli.js 会拉起 custom-server.js）；也收掉 .cmd 垫片那条链上残留的 node
    if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else if (pid) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* 已经没了 */
    }
  }
  for (let i = 0; i < 20 && (await health({ timeoutMs: 800 })); i++) await sleep(250)
  try {
    writeFileSync(PID_FILE, '')
  } catch {
    /* 无所谓 */
  }
  return !(await health({ timeoutMs: 800 }))
}

export async function start({ pin = NINE_PIN, skipInstall = false } = {}) {
  if (await health()) return { started: false, reason: 'already-healthy' }
  let cli = cliPath()
  if (!cli && !skipInstall) {
    install(pin)
    cli = cliPath()
  }
  if (!cli) throw new Error('9router 没装（先 `node scripts/setup-9router.mjs install`）')
  mkdirSync(STATE_DIR, { recursive: true })
  const logFd = openSync(LOG_FILE, 'a')
  const child = spawn(
    process.execPath,
    [cli, '-H', HOST, '--port', String(PORT), '--no-browser', '--skip-update'],
    { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true },
  )
  child.unref()
  closeSync(logFd)
  writeFileSync(PID_FILE, String(child.pid))
  for (let i = 0; i < 60; i++) {
    if (await health()) return { started: true, pid: child.pid, version: installedVersion() }
    await sleep(500)
  }
  throw new Error(`起了但 60s 内没健康（日志：${LOG_FILE}）`)
}

export function install(pin = NINE_PIN) {
  const have = installedVersion()
  if (have === pin) return { installed: false, version: have }
  const r = spawnSync('npm', ['i', '-g', `9router@${pin}`], { stdio: 'inherit', windowsHide: true, shell: IS_WIN })
  if (r.status !== 0) throw new Error(`npm i -g 9router@${pin} 失败（退出码 ${r.status}）`)
  return { installed: true, version: pin }
}

/** Windows：写隐藏启动垫片 + 注册登录自启（wscript 以 style 0 拉起，无窗口）。
 *  首选计划任务；schtasks 要管理员时落回「启动文件夹放 VBS」——两者都是登录即起、无窗口。 */
export function taskInstall() {
  if (!IS_WIN) throw new Error('task-install 只用于 Windows；Linux 用 --unit-print')
  mkdirSync(STATE_DIR, { recursive: true })
  const self = fileURLToPath(import.meta.url)
  const vbs = [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """${process.execPath}"" ""${self}"" ensure", 0, False`,
    '',
  ].join('\r\n')
  writeFileSync(VBS_FILE, vbs)
  const task = spawnSync(
    'schtasks',
    ['/Create', '/TN', TASK_NAME, '/SC', 'ONLOGON', '/TR', `wscript.exe "${VBS_FILE}"`, '/F'],
    { encoding: 'utf8', windowsHide: true },
  )
  if (task.status === 0) return { mechanism: 'schtasks', task: TASK_NAME, vbs: VBS_FILE }
  const startup = join(process.env.APPDATA ?? HOME, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'ocrc-9router.vbs')
  writeFileSync(startup, vbs)
  return { mechanism: 'startup-folder', path: startup, vbs: VBS_FILE, schtasksError: (task.stderr || task.stdout || '').trim().slice(0, 120) }
}

export function taskRemove() {
  if (!IS_WIN) throw new Error('task-remove 只用于 Windows')
  const r = spawnSync('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { encoding: 'utf8', windowsHide: true })
  const startup = join(process.env.APPDATA ?? HOME, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'ocrc-9router.vbs')
  const removedStartup = existsSync(startup)
  if (removedStartup) writeFileSync(startup, '')
  return { removed: r.status === 0, removedStartup, detail: (r.stdout || r.stderr || '').trim() }
}

function unitPrint() {
  const cli = cliPath() ?? '/usr/local/lib/node_modules/9router/cli.js'
  process.stdout.write(
    [
      '[Unit]',
      'Description=9router free-lane gateway (reeve)',
      'After=network-online.target',
      '',
      '[Service]',
      `ExecStart=${process.execPath} ${cli} -H ${HOST} --port ${PORT} --no-browser --skip-update`,
      'Restart=on-failure',
      'RestartSec=3',
      'StandardOutput=append:%h/.9router/ocrc/9router.log',
      'StandardError=append:%h/.9router/ocrc/9router.log',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'),
  )
}

const cmd = process.argv[2] ?? 'ensure'
try {
  if (process.argv.includes('--unit-print')) {
    unitPrint()
  } else if (cmd === 'ensure') {
    const ok = await health()
    const out = ok ? { healthy: true, version: installedVersion() } : { healthy: false, ...(await start()) }
    console.log(JSON.stringify(out))
  } else if (cmd === 'install') {
    console.log(JSON.stringify(install()))
  } else if (cmd === 'start') {
    console.log(JSON.stringify(await start()))
  } else if (cmd === 'stop') {
    console.log(JSON.stringify({ stopped: await stop() }))
  } else if (cmd === 'restart') {
    await stop()
    console.log(JSON.stringify(await start()))
  } else if (cmd === 'status') {
    const pid = readPid()
    console.log(JSON.stringify({ healthy: await health(), pid: alive(pid) ? pid : null, installed: installedVersion(), pin: NINE_PIN, log: LOG_FILE }))
  } else if (cmd === 'task-install') {
    console.log(JSON.stringify(taskInstall()))
  } else if (cmd === 'task-remove') {
    console.log(JSON.stringify(taskRemove()))
  } else {
    console.error(`未知命令：${cmd}`)
    process.exit(2)
  }
} catch (err) {
  console.error(String(err?.message ?? err))
  process.exit(1)
}