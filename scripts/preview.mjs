#!/usr/bin/env node
// REEVE 面板的本地预览（开发工具，不参与发布）。
//
//   node extensions/reeve/scripts/preview.mjs            # 起服务并打印 URL
//   node extensions/reeve/scripts/preview.mjs --allow-write   # 保存按钮真的写盘（默认只记内存）
//
// URL 里可带参数：
//   ?theme=light|dark     宿主主题（真 host 也是这么发的）
//   ?tab=chain|stats|ledger  先切到哪个 tab（预览脚本注入一次点击）
//   ?scenario=…           错误/空/冷却/慢读/应用失败等状态的注入（见 preview/host-shim.js 头注释）
//   ?fixture=ci           正常态用仓库夹具（CI 没有真快照/真配置）
//   ?applyDelay=800       保存后多久把新配置"热更"进快照（模拟 GATE；apply-stall 永不）
//
// 读的是**你机器上的真状态**：~/.reeve/ledger.json（快照）与 ~/.config/opencode/reeve/fallback.jsonc
// （GATE 配置）。写默认只进内存 —— 预览不该动真配置。
//
// 为什么要有它：面板跑在宿主的 sandbox iframe 里，没有宿主就完全打不开；每改一次面板都
// 去装一遍 openchamber 太慢。这里只换 `connectHost`（见 preview/host-shim.js），
// kit、样式、面板代码全是真的。

import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const webRoot = 'http://127.0.0.1'
const allowWrite = process.argv.includes('--allow-write')
const PORT = Number(process.env.PREVIEW_PORT ?? 5399)

const esbuildPkg = join(root, 'node_modules/esbuild')
if (!readFileSync(join(root, 'node_modules/@openchamber/sdk/package.json'), 'utf8')) throw new Error('缺 @openchamber/sdk')
const esbuild = await import(`file://${join(esbuildPkg, 'lib/main.js').replace(/\\/g, '/')}`)
const sdkDir = join(root, 'node_modules/@openchamber/sdk/dist')
const bundle = await (esbuild.build ?? esbuild.default.build)({
  entryPoints: [join(root, 'preview/preview-entry.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  write: false,
  alias: {
    '@openchamber/sdk': join(root, 'preview/host-shim.js'),
    '@openchamber/sdk/dist/ui/icons.js': join(sdkDir, 'ui/icons.js'),
    '@openchamber/sdk/ui': join(sdkDir, 'ui/index.js'),
  },
})

/** 允许预览读/写的路径（其余一律拒绝 —— 预览不该看也不该动别的文件）。 */
const HOME = homedir()
const expand = (p) => (p.startsWith('~/') || p === '~' ? join(HOME, p.slice(1)) : p)
const ALLOWED = [
  '~/.reeve/ledger.json',
  '~/.local/share/opencode/reeve/ledger.json',
  '~/.reeve-staging/.reeve/ledger.json',
  '~/.reeve-staging/.local/share/opencode/reeve/ledger.json',
  '~/.config/opencode/reeve/fallback.jsonc',
  '~/.reeve-staging/.config/opencode/reeve/fallback.jsonc',
  '~/.reeve/gate.jsonl',
].map((p) => ({ pattern: p, abs: expand(p) }))

const allowed = (p) => ALLOWED.find((a) => a.abs === expand(p))
const overlay = new Map()

const server = createServer((req, res) => {
  const url = new URL(req.url, webRoot)
  const send = (code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    // 用**真面板的 index.html**（样式就在里面），只把它的 <script src="./main.js"> 换成预览入口
    const raw = readFileSync(join(root, 'panel/index.html'), 'utf8')
    const marker = '<script src="./main.js"></script>'
    const html = raw.includes(marker)
      ? raw.replace(marker, '<script type="module" src="/preview.js"></script>')
      : raw
    return send(200, html, 'text/html; charset=utf-8')
  }
  if (url.pathname === '/preview.js') {
    return send(200, bundle.outputFiles[0].text, 'text/javascript; charset=utf-8')
  }
  if (url.pathname === '/preview-fixture.json') {
    try {
      return send(200, readFileSync(join(root, 'preview/fixtures/ci.json'), 'utf8'))
    } catch (err) {
      return send(404, { error: `读不到 CI 夹具：${err.code ?? err.message}` })
    }
  }
  if (url.pathname === '/api/file') {
    const p = url.searchParams.get('path') ?? ''
    const hit = allowed(p)
    if (!hit) return send(403, { error: `预览只允许读快照与 GATE 配置：${p}`, code: 'NOT_GRANTED' })
    if (overlay.has(hit.abs)) return send(200, { content: overlay.get(hit.abs) })
    try {
      return send(200, { content: readFileSync(hit.abs, 'utf8') })
    } catch (err) {
      return send(404, { error: `读不到 ${hit.pattern}：${err.code ?? err.message}`, code: 'UNKNOWN' })
    }
  }
  if (url.pathname === '/api/write' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let doc
      try {
        doc = JSON.parse(body)
      } catch {
        return send(400, { error: 'bad json' })
      }
      const hit = allowed(doc.path)
      if (!hit) return send(403, { error: `预览只允许写 GATE 配置：${doc.path}` })
      overlay.set(hit.abs, String(doc.content))
      if (allowWrite) writeFileSync(hit.abs, String(doc.content))
      console.log(`[preview] 保存 ${doc.path}（${String(doc.content).length} 字节，${allowWrite ? '已落盘' : '只记内存'}）`)
      return send(200, { applied: allowWrite })
    })
    return
  }
  return send(404, { error: 'not found' })
})

await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
const base = `${webRoot}:${PORT}/`
console.log('REEVE 面板预览（读真快照 + 真 GATE 配置；写默认只记内存）：')
console.log(`  链    ${base}?tab=chain`)
console.log(`  统计  ${base}?tab=stats`)
console.log(`  台账  ${base}?tab=ledger`)
console.log(`  深色  ${base}?theme=dark`)
if (process.env.PREVIEW_SHOT) {
  console.log('（PREVIEW_SHOT 已设置：交给外部无头浏览器截图）')
}
if (process.argv.includes('--shot')) {
  // 本机没有无头浏览器依赖：用 Edge/Chrome 的 --headless=new --screenshot
  const browser = process.env.PREVIEW_BROWSER
  if (!browser) {
    console.error('--shot 需要 PREVIEW_BROWSER=<msedge|chrome 可执行文件路径>')
    process.exit(2)
  }
  for (const [name, q] of [
    ['chain', '?tab=chain'],
    ['stats', '?tab=stats'],
    ['ledger', '?tab=ledger'],
  ]) {
    const out = join(process.env.PREVIEW_OUT ?? '.', `preview-${name}.png`)
    spawnSync(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--screenshot=${out}`, '--window-size=1240,940', '--virtual-time-budget=5000', `${base}${q}`], { stdio: 'inherit' })
    console.log(`截图：${out}`)
  }
}