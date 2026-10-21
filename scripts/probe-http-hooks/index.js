// 探针 v4：可行性两测
//  A. http.request 里整体替换 Request（把 body.model 从 reeve/pro 改成 reeve/flash）
//     → 判据：GATE 台账里这条请求的 chain 变成 reeve/flash
//  B. retry 里把 decision 换成 {retry:false} → 判据：attempt 停在 2（不再往上）
export default {
  id: 'probe-http-hooks',
  async setup(ctx) {
    const fs = await import('node:fs')
    const log = (l) => { try { fs.appendFileSync('/tmp/reeve-http-hook-probe4.jsonl', JSON.stringify(l) + '\n') } catch {} }
    let rewrote = 0
    await ctx.session.hook('http.request', async (ev) => {
      try {
        log({ hook: 'http.request', kind: ev?.kind, model: ev?.model?.id, url: ev?.request?.url, method: ev?.request?.method })
        if (ev?.kind === 'primary' && rewrote < 1) {
          const text = await ev.request.clone().text()
          const body = JSON.parse(text)
          const before = body.model
          body.model = before === 'reeve/pro' ? 'reeve/flash' : before
          ev.request = new Request(ev.request.url, { method: ev.request.method, headers: new Headers(ev.request.headers), body: JSON.stringify(body) })
          rewrote += 1
          log({ hook: 'http.request', rewrote: true, before, after: body.model })
        }
      } catch (e) { log({ hook: 'http.request', err: String(e).slice(0, 160) }) }
    })
    await ctx.session.hook('retry', (ev) => {
      try {
        log({ hook: 'retry', attempt: ev?.attempt, decision: ev?.decision })
        if (typeof ev?.attempt === 'number' && ev.attempt >= 2) {
          ev.decision = { retry: false }
          log({ hook: 'retry', forced: 'stop', attempt: ev.attempt, after: ev.decision })
        }
      } catch (e) { log({ hook: 'retry', err: String(e).slice(0, 160) }) }
    })
    log({ plugin: 'probe-http-hooks', v: 4 })
    return () => {}
  },
}
