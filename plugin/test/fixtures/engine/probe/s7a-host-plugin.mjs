// S7a 真机探针（宿主内 face）——§7 六项清单里只有 opencode 2.x 宿主插件 face 才能测的部分。
//
// 用法（人工步，需一台插件可装载的 2.x 宿主——即 OpenChamber 桌面栈拉起的那种）：
//   1. 把本文件放进某项目 .opencode/plugins/s7a-host-plugin.mjs（或 index.js 目录形态）；
//   2. 设环境变量 REEVE_S7A_OUT=<绝对路径 .jsonl>（缺省 ./s7a-host-probe.jsonl）；
//   3. 启动宿主（TUI/serve 均可），等 ~2 分钟探针自跑完（子会话真发一条 prompt）；
//   4. 收 JSONL：face 探测 / env / loopback / create 返回形状 / metadata 持久化 /
//      事件时序 / context 原始形状——六项结论逐行落盘，末行 phase=DONE。
//
// 双 face 兼容：v2 宿主读 export default {id, setup}（ctx 带 session/event face）；
// v1 宿主把默认导出当函数调（无 v2 face，只记 env 后即DONE——不算失败，是实测结论）。
// 断言风格：自然退出（本文件在宿主进程内跑，不退出进程——只写 DONE）。
import { appendFileSync } from 'node:fs'

const OUT = process.env.REEVE_S7A_OUT || 's7a-host-probe.jsonl'
const line = (phase, payload) => {
  try {
    appendFileSync(OUT, JSON.stringify({ t: Date.now(), phase, ...payload }) + '\n')
  } catch { /* 落盘尽力而为 */ }
}
const ts = () => new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function probeV2(ctx) {
  line('face', {
    generation: 'v2-setup',
    sessionCreate: typeof ctx.session?.create,
    sessionPrompt: typeof ctx.session?.prompt,
    sessionContext: typeof ctx.session?.context,
    eventSubscribe: typeof ctx.event?.subscribe,
    agentList: typeof ctx.agent?.list,
    locationDirectory: ctx.location?.directory ?? null,
  })

  // §7-6：宿主进程内 env + 缺省回环端口死活
  line('env', {
    OPENCODE_SERVER_PORT: process.env.OPENCODE_SERVER_PORT ?? null,
    hasServerPassword: 'OPENCODE_SERVER_PASSWORD' in process.env,
    opencodeEnvKeys: Object.keys(process.env).filter((k) => k.includes('OPENCODE')),
  })
  const port = process.env.OPENCODE_SERVER_PORT ?? 4096
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent`)
    line('loopback', { port, status: res.status, ok: res.ok })
  } catch (e) {
    line('loopback', { port, error: String(e).slice(0, 120) })
  }

  // §7-4：先订阅，再动会话（AsyncIterable 逐事件落盘）
  const controller = new AbortController()
  let childId = null
  if (typeof ctx.event?.subscribe === 'function') {
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
          line('event', {
            type: ev?.type,
            dataKeys: ev?.data ? Object.keys(ev.data) : null,
            sessionID: ev?.data?.sessionID ?? null,
            locationDirectory: ev?.location?.directory ?? null,
            isChild: childId !== null && JSON.stringify(ev).includes(childId),
          })
        }
      } catch (e) {
        line('event-iter-end', { error: String(e).slice(0, 120) })
      }
    })()
    line('subscribed', {})
  }

  // §7-1：create 返回形状（原样整录——.id 与 .data.id 两条兼容分支实测）
  let parent = null
  try {
    const raw = await ctx.session.create({ title: `REEVE-S7A parent ${ts()}` })
    parent = raw?.id ?? raw?.data?.id ?? null
    line('create-parent', { raw: raw ?? null, extractedId: parent, idBranch: raw?.id ? 'result.id' : raw?.data?.id ? 'result.data.id' : 'none' })
  } catch (e) {
    line('create-parent', { error: String(e).slice(0, 200) })
    line('DONE', { verdict: 'ctx.session.create 不可用（§7-1 实测失败——S7b 应走回环 HTTP POST /api/session 兜底）' })
    return
  }

  // §7-2：metadata 持久化（塞额外键 → context/记录读回）
  const meta = { reeveRunId: 's7a-probe-run', stepId: 'probe-step-1', nested: { deep: true } }
  try {
    const raw = await ctx.session.create({ title: `REEVE-S7A meta ${ts()}`, metadata: meta })
    const metaId = raw?.id ?? raw?.data?.id
    line('create-meta', { raw: raw ?? null, extractedId: metaId })
    if (metaId && typeof ctx.session.context === 'function') {
      // context 面读的是消息不是会话记录——metadata 读回走宿主自己的会话存储面；
      // 这里只录 create 是否收下该键（引擎侧是否持久化由回读面/HTTP GET /session/{id} 旁证）。
      line('meta-accepted', { metadata: meta })
    }
  } catch (e) {
    line('create-meta', { error: String(e).slice(0, 200) })
  }

  // §7-5 + §7-3：parentID 子会话 + 真发 prompt + context 原始形状
  try {
    const raw = await ctx.session.create({ title: `REEVE-S7A child ${ts()}`, parentID: parent })
    childId = raw?.id ?? raw?.data?.id
    line('create-child', { raw: raw ?? null, extractedId: childId, parentID: parent })
  } catch (e) {
    line('create-child', { error: String(e).slice(0, 200) })
  }
  if (childId && typeof ctx.session.prompt === 'function') {
    try {
      const r = await ctx.session.prompt({ sessionID: childId, text: 'Reply with exactly: S7A-OK' })
      line('prompt', { settled: 'resolved', raw: r ?? null })
    } catch (e) {
      line('prompt', { settled: 'rejected', error: String(e).slice(0, 200) })
    }
    // 等 execution 事件驱动的完成（idle 驱动重轮询的真实节奏），90s 兜底
    await sleep(90_000)
  }
  if (childId && typeof ctx.session.context === 'function') {
    try {
      const raw = await ctx.session.context({ sessionID: childId })
      line('context-child', { raw: raw ?? null })
    } catch (e) {
      line('context-child', { error: String(e).slice(0, 200) })
    }
    try {
      const raw = await ctx.session.context({ sessionID: parent })
      line('context-parent', { raw: raw ?? null })
    } catch (e) {
      line('context-parent', { error: String(e).slice(0, 200) })
    }
  }
  controller.abort()
  line('DONE', { verdict: 'v2 face 探测完成' })
}

export default {
  id: 'reeve-s7a-probe',
  async setup(ctx) {
    if (ctx?.session || ctx?.event) {
      line('setup', { face: 'v2' })
      void probeV2(ctx).catch((e) => line('fatal', { error: String(e).slice(0, 300) }))
      return
    }
    // v1 宿主（或 reduced host）：没有 v2 face——只记 env，即 DONE
    line('setup', { face: 'v1-or-reduced' })
    line('env', {
      OPENCODE_SERVER_PORT: process.env.OPENCODE_SERVER_PORT ?? null,
      hasServerPassword: 'OPENCODE_SERVER_PASSWORD' in process.env,
    })
    line('DONE', { verdict: '宿主无 v2 ctx face（§7-1…§7-5 在该宿主上无从插件 face 测量）' })
  },
}
