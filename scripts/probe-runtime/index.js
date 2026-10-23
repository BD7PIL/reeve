// 运行时探针：一个"纯插件"要自己拉起代理，必须先确认引擎里这三件事可用：
//   ① spawn 长命子进程并判活/收掉   ② fetch（下载二进制、调代理 API）   ③ 读引擎环境（若要注 VK）
export default {
  id: 'probe-runtime',
  async setup(ctx) {
    const fs = await import('node:fs')
    const facts = []
    const log = (o) => facts.push(o)
    try {
      const { spawn } = await import('node:child_process')
      const child = spawn('sleep', ['300'], { stdio: 'ignore' })
      log({ spawn: 'ok', pid: child.pid, hasUnref: typeof child.unref === 'function' })
      await new Promise((r) => setTimeout(r, 600))
      let alive = false
      try { process.kill(child.pid, 0); alive = true } catch (e) { alive = 'ERR:' + String(e).slice(0, 40) }
      log({ aliveAfter600ms: alive })
      try { child.kill('SIGTERM'); log({ killed: true }) } catch (e) { log({ killErr: String(e).slice(0, 80) }) }
    } catch (e) { log({ spawnErr: String(e).slice(0, 200) }) }

    try {
      const res = await fetch('http://127.0.0.1:18080/api/version')
      log({ fetch: res.status, body: (await res.text()).slice(0, 60) })
    } catch (e) { log({ fetchErr: String(e).slice(0, 140) }) }

    log({
      env: { hasREEVE_VK: typeof process.env.REEVE_VK === 'string' && process.env.REEVE_VK.length > 0, HOME: process.env.HOME ? 'set' : 'unset' },
      runtime: { bun: typeof Bun !== 'undefined', node: process.version, hasCreateHash: (() => { try { return typeof require === 'function' } catch { return 'no-require' } })() },
      cwd: process.cwd(),
    })
    try { fs.appendFileSync('/tmp/reeve-runtime-probe.jsonl', facts.map((o) => JSON.stringify(o)).join('\n') + '\n') } catch {}
    return () => {}
  },
}
