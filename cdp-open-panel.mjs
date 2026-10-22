// 打开 openchamber 里的 REEVE 面板，并像用户那样驱动它（读文本 / 点按 / 截图）。
// 走 CDP，不装依赖（Node 24 自带 WebSocket）。
//
//   node cdp-open-panel.mjs                          # 打开面板，打印面板里的文本
//   node cdp-open-panel.mjs --shot=/tmp/p.png        # 只截面板 iframe 那块（浅色）
//   node cdp-open-panel.mjs --shot-dark=/tmp/p2.png  # 先切深色再截一张
//   node cdp-open-panel.mjs --tab=统计               # 先切到那个 tab
//   node cdp-open-panel.mjs --click='.rv-savebar button'   # 在面板里点（真鼠标事件，按坐标）
//   node cdp-open-panel.mjs --click-text=保存并生效    # 按按钮文字点（先列出按钮再点）
//   node cdp-open-panel.mjs --guest-eval=document.title    # 在面板的上下文里求值
//
// **为什么不能直接摸面板的 DOM**：宿主把面板放在 **sandbox 且不给 allow-same-origin** 的
// iframe 里（实测 `contentDocument === null`）—— 这是有意的安全边界，不该绕过。
// 所以这里用两条正规通道：
//   · 读/求值：`Page.createIsolatedWorld(frameId)` → 在那个 frame 的上下文里跑 JS（读文本、量矩形）
//   · 点按：`DOM.getDocument({pierce:true})` 进到 iframe 的文档 → `DOM.getBoxModel` 拿矩形
//           → `Input.dispatchMouseEvent` 发**真鼠标按下/抬起**（面板收到的和用户点的一样）
//
// 前提：EL7 上有一个 headless Chrome 在 :9222，且那个浏览器已登录过 openchamber
// （会话 cookie 在浏览器 profile 里 —— 本脚本不碰密码，也不打印任何凭据）。

import { readFileSync, writeFileSync } from 'node:fs'

const arg = (name, def = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : def
}
const APP = arg('app', 'http://127.0.0.1:2610/')
const CDP = arg('cdp', 'http://127.0.0.1:9222')
/** 宿主的设置文件（用来在收尾时把主题恢复原样）。给了才恢复，不给就不碰。 */
const SETTINGS = arg('settings')
const readTheme = () => {
  if (!SETTINGS) return null
  try {
    return JSON.parse(readFileSync(SETTINGS, 'utf8')).themeVariant ?? null
  } catch {
    return null
  }
}
/** 进来时的主题（收尾要恢复成它）—— 以**页面实际状态**为准，不信文件。 */
let initialTheme = null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 连一个页面 ----
const list = await (await fetch(`${CDP}/json/list`)).json()
const appHost = new URL(APP).host
let page = list.find((t) => t.type === 'page' && String(t.url).includes(appHost))
if (!page) page = list.find((t) => t.type === 'page')
if (!page) page = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
if (!page?.webSocketDebuggerUrl) throw new Error('拿不到页面：' + JSON.stringify(list.map((t) => t.url)))

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text }
  return r.result.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('DOM.enable')
// 视口放宽到 1920：宿主的侧栏宽度会随状态变（实测面板 x 在 864 与 1080 之间跳），
// 1440 宽时面板有时会被切掉右边 —— 截图不能靠运气。
// deviceScaleFactor 保持 1：放大交给截图时的 clip.scale（两个都设会变成 4 倍图）。
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })

// ---- 打开应用 + 面板 ----
// 一律**导航到干净的应用根地址**（不用 reload）：设置窗是从 URL 状态恢复的，
// reload 会把上一轮留下的「设置 → 扩展」一起带回来（实测踩到：截图里是设置浮层）。
await send('Page.navigate', { url: APP })
await sleep(7000)

/** 面板 iframe 的 frameId（宿主的 URL 里带 /api/guests/<id>/）。 */
const panelFrameId = async () => {
  const tree = await send('Page.getFrameTree')
  const walk = (f) => [f, ...(f.childFrames ?? []).flatMap(walk)]
  const frames = walk(tree.frameTree)
  const hit = frames.find((f) => /\/api\/guests\//.test(f.frame.url)) ?? frames.find((f) => /panel/i.test(f.frame.url))
  return hit?.frame?.id ?? null
}

/**
 * iframe 在页面里的矩形（截图裁剪与坐标换算都要它）。顺便带上"是不是真的看得见"。
 * ⚠️ 没被选中的 section **也挂着 iframe**，尺寸还正常（实测 526×983 但看不见）——
 * 所以只量尺寸会误判，必须用 checkVisibility 问一句。
 */
const frameBox = async () =>
  evaluate(`(() => {
    const f = [...document.querySelectorAll('iframe')].find((x) => /REEVE|编排/.test(x.getAttribute('title') || '')) || document.querySelector('iframe');
    if (!f) return null;
    const r = f.getBoundingClientRect();
    const visible = f.checkVisibility ? f.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : r.width > 0;
    return { x: r.x, y: r.y, width: r.width, height: r.height, visible };
  })()`)

const openPanel = async () => {
  for (let i = 0; i < 20; i++) {
    // 这里只要能拿到 frame（隔离世界要 frameId）；"在不在前台"交给 focusPanel 判 ——
    // 在没被选中的 section 上反复点栏位图标会把面板来回切换（实测点了 17 次才稳）
    const fid = await panelFrameId()
    if (fid) return fid
    if (i % 3 === 0) {
      const hit = await evaluate(`(() => {
        const el = [...document.querySelectorAll('button,[role=button],a')]
          .filter((e) => !e.closest('[role=dialog]'))
          .find((e) => /REEVE|编排/.test((e.getAttribute('title') || '') + (e.getAttribute('aria-label') || '')));
        if (!el) return { clicked: false };
        el.click();
        return { clicked: true, label: (el.getAttribute('aria-label') || '').slice(0, 40) };
      })()`)
      if (hit?.clicked) console.log(`点面板入口（第 ${i + 1} 轮）：`, JSON.stringify(hit))
    }
    await sleep(1500)
  }
  return null
}
/**
 * 当前是浅色还是深色 —— 以**渲染出来的背景亮度**为准。
 * 别读 document.documentElement.style.colorScheme：实测宿主切主题时根本不改它（一直是 ok 的旧值），
 * 用它会得出"切了但没生效"的错误结论。
 */
const pageThemeRaw = async () =>
  evaluate(`(() => {
    const body = document.body;
    if (!body) return '';
    const bg = getComputedStyle(body).backgroundColor || '';
    const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(bg);
    if (!m) return '';
    const lum = (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255;
    return lum > 0.5 ? 'light' : 'dark';
  })()`)
/** 只返回 'light' / 'dark' / ''（页面还在加载时 evaluate 会返回异常对象，这里吞掉并重试）。 */
const pageTheme = async () => {
  for (let i = 0; i < 5; i++) {
    const v = await pageThemeRaw()
    if (v === 'light' || v === 'dark') return v
    await sleep(800)
  }
  return ''
}


initialTheme = (await pageTheme()) || null
const frameId = await openPanel()
console.log('面板 frameId：', frameId)
if (!frameId) throw new Error('没找到面板 iframe —— 扩展可能没启用（设置 → 扩展 → REEVE 编排）')
await sleep(1500)

// 宿主的右侧栏一次只显示一个 section（默认可能是 Git / Usage）—— iframe 在没被选中的时候
// **照样存在、照样有尺寸**（实测：526×983 但看不见），所以光量尺寸会误判。必须问"看得见吗"。
const focusPanel = async () => {
  for (let i = 0; i < 6; i++) {
    const box = await frameBox()
    if (box?.visible && box.width >= 120) return box
    const hit = await evaluate(`(() => {
      const el = [...document.querySelectorAll('button,[role=button]')]
        .filter((e) => !e.closest('[role=dialog]'))
        .find((e) => /REEVE|编排/.test((e.getAttribute('aria-label') || '') + (e.getAttribute('title') || '')));
      if (!el) return { clicked: false };
      el.click();
      return { clicked: true, label: (el.getAttribute('aria-label') || '').slice(0, 30) };
    })()`)
    console.log(`切到 REEVE 栏位（第 ${i + 1} 次）：`, JSON.stringify(hit))
    await sleep(1800)
  }
  return await frameBox()
}
console.log('面板矩形：', JSON.stringify(await focusPanel()))

// ---- 在面板的上下文里跑 JS（隔离世界；跨源 iframe 的正规读法）----
// ⚠️ **页面一旦重新加载，隔离世界的 executionContextId 就作废了**（实测：切主题要重载，
// 之后第一句 guest() 就抛 "Cannot find context with specified id"）。所以缓存要能作废重建。
let guestCache = { frameId: null, ctx: null }
const invalidateGuest = () => {
  guestCache = { frameId: null, ctx: null }
}
const guest = async (expr) => {
  if (!guestCache.ctx || !guestCache.frameId) guestCache.frameId = await panelFrameId()
  if (!guestCache.frameId) return { error: 'no frame' }
  if (!guestCache.ctx) {
    const w = await send('Page.createIsolatedWorld', { frameId: guestCache.frameId, worldName: 'reeve-probe', grantUniveralAccess: false })
    guestCache.ctx = w.executionContextId
  }
  let r
  try {
    r = await send('Runtime.evaluate', { expression: expr, contextId: guestCache.ctx, awaitPromise: true, returnByValue: true })
  } catch (err) {
    // 上下文过期（页面重载/iframe 重建）→ 重建一次再试
    invalidateGuest()
    return await guest(expr)
  }
  if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text }
  return r.result.value
}

// ---- 点按：坐标在**面板里**量（隔离世界的 getBoundingClientRect）+ iframe 偏移 → 真鼠标事件 ----
const clickAt = async (label, rect) => {
  if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.width)) return { error: `量不到矩形（${label}）：${JSON.stringify(rect)}` }
  const box = await frameBox()
  if (!box || !Number.isFinite(box.x)) return { error: '量不到 iframe 矩形' }
  const x = box.x + rect.x + rect.width / 2
  const y = box.y + rect.y + rect.height / 2
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: `坐标不是数字：${x},${y}` }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  return { clicked: label, x: Math.round(x), y: Math.round(y) }
}

const guestClick = async (sel) => {
  const rect = await guest(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, text: (el.innerText || '').trim().slice(0, 24) };
  })()`)
  if (!rect || rect.error) {
    const have = await guest(`[...document.querySelectorAll('[data-act]')].map((e) => e.dataset.act)`)
    return { error: `选择器没命中：${sel}`, detail: rect ?? null, acts: have }
  }
  return { ...(await clickAt(sel, rect)), text: rect.text }
}

const guestClickText = async (text) => {
  const rect = await guest(`(() => {
    const els = [...document.querySelectorAll('button,[role=button]')].filter((b) => (b.innerText || '').trim() === ${JSON.stringify(text)});
    if (!els.length) return { missing: true, buttons: [...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter(Boolean) };
    const el = els[0];
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`)
  if (rect?.missing) return { error: `没找到「${text}」`, buttons: rect.buttons }
  return await clickAt(text, rect)
}

// ---- 动作按**命令行顺序**执行（这样"点开选择器 → 输入 → 点加入"这种序列才写得出来）----
// 注意：切主题要重新加载页面（见 themeViaSettings），所以**每张图之前都会重放一遍动作**。
// 幂等的动作（切 tab、点按按钮）没问题；会改状态的序列请只配一张图。
const actions = process.argv.slice(2).filter((a) => /^--(click|click-text|type|tab|wait)=/.test(a))
const runActions = async () => {
  for (const a of actions) {
    if (a.startsWith('--wait=')) {
      const ms = Number(a.slice('--wait='.length))
      console.log(`等 ${ms}ms…`)
      await sleep(ms)
    } else if (a.startsWith('--click-text=')) {
      const t = a.slice('--click-text='.length)
      console.log(`点「${t}」：`, JSON.stringify(await guestClickText(t)))
      await sleep(2000)
    } else if (a.startsWith('--tab=')) {
      // 用 tab 的 data-id（宿主 mountTabs 会给）—— 按钮上的文字带着计数（"统计100"），按文字点不准
      const id = a.slice('--tab='.length)
      console.log(`切 tab ${id}：`, JSON.stringify(await guestClick(`[role=tab][data-id="${id}"]`)))
      await sleep(1200)
    } else if (a.startsWith('--click=')) {
      const sel = a.slice('--click='.length)
      console.log(`点 ${sel}：`, JSON.stringify(await guestClick(sel)))
      await sleep(1200)
    } else if (a.startsWith('--type=')) {
      // --type='<选择器>|<文字>'：先点一下让它获得焦点，再 insertText 打进去
      // （真输入，不是直接设 value —— 面板的 input 事件监听才会跑）
      const spec = a.slice('--type='.length)
      const i = spec.indexOf('|')
      const sel = spec.slice(0, i)
      const text = spec.slice(i + 1)
      console.log(`在 ${sel} 输入「${text}」：`, JSON.stringify(await guestClick(sel)))
      await sleep(400)
      await send('Input.insertText', { text })
      await sleep(600)
    }
  }
}
await runActions()

const ge = arg('guest-eval')
if (ge) console.log('--guest-eval：', JSON.stringify(await guest(`(${ge})`)).slice(0, 2000))

const text = await guest('document.body.innerText')
console.log('面板文本：')
console.log(typeof text === 'string' ? text.split('\n').slice(0, 60).map((l) => '  ' + l).join('\n') : JSON.stringify(text))

// 宿主的提示条（如 "OpenCode update"）会浮在右下角，压住保存条 —— 截图前先关掉
const dismissToasts = async () => {
  const hit = await evaluate(`(() => {
    const el = [...document.querySelectorAll('button,[role=button]')].find((e) => /^(Dismiss|关闭|忽略)$/.test((e.innerText || '').trim()));
    if (!el) return false;
    el.click();
    return true;
  })()`)
  if (hit) {
    console.log('关掉宿主提示条')
    await sleep(600)
  }
  return hit
}

/**
 * 等页面"干净"：没有 "Saving…" 之类的遮罩、没有 aria-busy、没有开着对话框。
 *
 * 为什么必须有这一步：切主题要走 设置→外观，宿主保存设置时会弹一个带背景模糊的
 * "Saving…" 抽屉，把**整个面板**盖住（实测：四张图全废，评审直接判"证据作废"）。
 * 截图这类"抓屏幕"的动作必须有干净度断言，不能靠人眼事后发现。
 */
const waitClean = async (maxMs = 20000) => {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < maxMs) {
    last = await evaluate(`(() => {
      const txt = document.body.innerText || '';
      return {
        saving: /Saving|保存中|正在保存/.test(txt),
        busy: document.querySelector('[aria-busy="true"]') != null,
        dialogs: document.querySelectorAll('[role=dialog]').length,
      };
    })()`)
    if (last && !last.saving && !last.busy && last.dialogs === 0) {
      // 面板自己也可能正在忙（读快照 → 刷新按钮转圈）—— 截"读取中"没有意义
      const g = await guest(`document.querySelector('.rv-savebar button[data-loading="true"], .rv-head button[data-loading="true"]') ? 'busy' : 'idle'`)
      if (g === 'idle') return true
      last = { ...last, guest: g }
    }
    await sleep(700)
  }
  console.log('⚠️ 页面没等到干净状态（继续截，但图可能被遮住）：', JSON.stringify(last))
  return false
}

/**
 * 切宿主的主题模式：**直接改宿主的设置文件再重新加载页面**。
 *
 * 为什么不用设置窗里的「颜色模式」：那条路要走 设置→外观，宿主保存设置时会弹一个
 * 带背景模糊、且实测**不消失**的 "Saving…" 浮层，把面板整个盖住（上一轮四张图全废），
 * 再叠加上宿主把 guest 请求排在它后面，面板会一直"读取中"。改文件 + 重载是干净且确定的。
 * （收尾时会把 themeVariant 恢复原值。）
 */
/** 等宿主的栏位图标出现（扩展是异步加载的，重载后要几秒才画出来）。 */
const waitRailIcon = async (maxMs = 25000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    const has = await evaluate(`(() => [...document.querySelectorAll('button,[role=button]')].some((e) => !e.closest('[role=dialog]') && /REEVE|编排/.test((e.getAttribute('aria-label') || '') + (e.getAttribute('title') || ''))))()`)
    if (has) return true
    await sleep(1000)
  }
  console.log('⚠️ 栏位图标一直没出现')
  return false
}


/**
 * 切宿主的主题模式：走 设置 → 外观 → 颜色模式（Light / Dark），然后**关掉设置窗**。
 *
 * 两条弯路（都实测踩过，别重走）：
 *  ① 改文件：settings.json.themeVariant 改了不管用 —— 宿主起来还是旧主题（那不是运行时的真相）。
 *  ② 不关设置窗：浮层带背景模糊把面板整个盖住，而且它的 "Saving…" 指示不消失（四张图全废）。
 * 所以：点按钮 + 点 aria-label="Close settings" 关闭 + 等页面干净（无 Saving / busy / 对话框）。
 */
const setHostTheme = async (mode) => {
  if ((await pageTheme()) === mode) return true
  const clickText = (t) =>
    evaluate(`(() => { const el = [...document.querySelectorAll('button,[role=button],a')].find((e) => (e.innerText || '').trim() === ${JSON.stringify(t)}); if (!el) return false; el.click(); return true; })()`)
  const clickLabel = (t) =>
    evaluate(`(() => { const el = [...document.querySelectorAll('button,[role=button]')].find((e) => (e.getAttribute('aria-label') || '') === ${JSON.stringify(t)}); if (!el) return false; el.click(); return true; })()`)
  await clickLabel('Settings')
  await sleep(2200)
  await clickText('Appearance')
  await sleep(2000)
  const clicked = await clickText(mode === 'dark' ? 'Dark' : 'Light')
  await sleep(1200)
  const closed = await evaluate(`(() => {
    const b = [...document.querySelectorAll('[role=dialog] button')].find((x) => /close settings/i.test((x.getAttribute('aria-label') || '') + (x.getAttribute('title') || '')));
    if (b) { b.click(); return 'button'; }
    return 'none';
  })()`)
  if (closed === 'none') {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  }
  await sleep(1000)
  await waitClean()
  console.log(`宿主主题 → ${mode}：点击=${clicked} 关设置窗=${closed} 现在=${await pageTheme()}`)
  return (await pageTheme()) === mode
}

// ---- 截图：优先只截面板那块 ----
/**
 * 等"可以按下快门"：面板自己不在读盘（刷新/保存中的按钮不转）。
 *
 * 为什么放在快门**之前**而不是切 tab 之后：切 tab 会让面板重新读一次快照（链 tab 尤其），
 * 上一轮就抓到了"读取中…"的残影。所以每次截图前都要再等一次。
 */
const waitGuestIdle = async (maxMs = 12000) => {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < maxMs) {
    // 三件事都要成立：面板**画出来了**（刚重载完的 iframe 会是空白）、没在转圈、没有"读取中"
    const txt = await guest(`(document.body.innerText || '')`)
    const busy = await guest(`!!document.querySelector('button[data-loading="true"]')`)
    last = { len: typeof txt === 'string' ? txt.length : -1, busy }
    if (typeof txt === 'string' && txt.includes('REEVE') && busy !== true && !txt.includes('读取中')) return true
    await sleep(400)
  }
  console.log('⚠️ 面板没进入"有内容且空闲"（继续截）', JSON.stringify(last))
  return false
}

/** 拍一张（带一次重试）：重载之后 iframe 偶尔会迟迟不出现（实测约 1/5 的概率），再加载一次就好。 */
const shootOnce = async (path, { dark = false } = {}) => {
  await setHostTheme(dark ? 'dark' : 'light')
  await dismissToasts()
  const box = await focusPanel()
  await runActions()
  await waitGuestIdle()
  console.log('面板矩形（拍前）：', JSON.stringify(box))
  if (!box?.visible || !(box.width > 50)) return false
  const clip = { x: Math.max(0, box.x), y: Math.max(0, box.y), width: box.width, height: box.height, scale: 2 }
  const shot = await send('Page.captureScreenshot', { format: 'png', clip })
  writeFileSync(path, Buffer.from(shot.data, 'base64'))
  console.log(`截图：${path}（面板 ${Math.round(clip.width)}×${Math.round(clip.height)}）`)
  return true
}

const shoot = async (path, opts = {}) => {
  if (!path) return
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (await shootOnce(path, opts)) return
    console.log(`第 ${attempt} 次没拍到（面板不在前台），重新加载再试`)
    await send('Page.navigate', { url: APP })
    invalidateGuest()
    await sleep(6000)
    await waitRailIcon()
  }
  // 宁可不产图，也不产一张"看起来像面板其实是别的东西"的图（上一轮就是这么废掉四张的）
  throw new Error(`拍不到面板：${path}`)
}

await shoot(arg('shot'))
await shoot(arg('shot-dark'), { dark: true })

// 收尾：把宿主主题恢复成我们进来时的样子（别把用户的应用留在另一个主题上）
if (initialTheme && initialTheme !== (await pageTheme())) {
  await setHostTheme(initialTheme)
  console.log(`主题已恢复：${initialTheme}`)
}

ws.close()