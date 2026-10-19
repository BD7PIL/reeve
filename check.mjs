// 用宿主自己的解析器校验 manifest + 打包完整性 —— 装之前先在这里挂掉，别到机器上才发现。
//   node check.mjs [--sdk=<@openchamber/sdk 包目录>]
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sdkArg = process.argv.find((a) => a.startsWith('--sdk='))?.slice('--sdk='.length)

const sdkPkg =
  (sdkArg && resolve(sdkArg)) ||
  [
    join(here, 'node_modules/@openchamber/sdk'),
    join(here, '../../../ocrc/extensions/ocrc-omo-view/node_modules/@openchamber/sdk'),
  ].find((p) => existsSync(p))

if (!sdkPkg) {
  console.error('找不到 @openchamber/sdk；用 --sdk=<路径> 指定。')
  process.exit(2)
}

const sdk = await import(pathToFileURL(join(sdkPkg, 'dist/index.js')).href)
// 解析器在 `dist/parse.js`（根 index 没有再导出它）—— 这是宿主 install 时用的同一个解析器。
const parse = await import(pathToFileURL(join(sdkPkg, 'dist/parse.js')).href)

let failed = 0
const check = (label, fn) => {
  try {
    const detail = fn()
    console.log(`  ✓ ${label}${detail ? ` —— ${detail}` : ''}`)
  } catch (err) {
    failed += 1
    console.error(`  ✗ ${label} —— ${err.message}`)
  }
}

const pkgPath = join(here, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

console.log(`SDK: ${sdkPkg}`)
console.log('=== manifest ===')

check('parseManifestJson 接受这份 package.json', () => {
  const r = parse.parseManifestJson(readFileSync(pkgPath, 'utf8'))
  if (!r.ok) throw new Error(`${r.code}：${r.message ?? ''}`)
  return `panel.id=${r.manifest.contributes.panel.id}`
})

check('声明的能力集合符合预期', () => {
  const r = parse.parseManifestJson(readFileSync(pkgPath, 'utf8'))
  const caps = r.ok ? sdk.requestedGuestCapabilities(r.manifest.contributes) : []
  const want = ['sessions', 'filesystem']
  const missing = want.filter((c) => !caps.includes(c))
  if (missing.length) throw new Error(`少了：${missing.join(',')}（实际：${caps.join(',') || '空'}）`)
  return caps.join(',')
})

check('filesystem 模式合法', () => {
  for (const p of pkg.openchamber.contributes.filesystem) {
    if (!sdk.isGuestFilesystemPattern(p)) throw new Error(`不合法：${p}`)
  }
  return pkg.openchamber.contributes.filesystem.length + ' 条'
})

console.log('=== 打包完整性（宿主 install 时会查的项）===')

check('panel.entry 指向的 HTML 存在', () => {
  const entry = pkg.openchamber.contributes.panel.entry
  const p = join(here, entry)
  if (!existsSync(p)) throw new Error(`缺 ${entry}`)
  return entry
})

check('HTML 里引的每个本地 .js 都在包里', () => {
  const html = readFileSync(join(here, pkg.openchamber.contributes.panel.entry), 'utf8')
  const srcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1])
  if (!srcs.length) throw new Error('HTML 里没有 <script src>')
  for (const s of srcs) {
    if (/^https?:/.test(s)) throw new Error(`不允许外链脚本：${s}`)
    const p = join(here, dirname(pkg.openchamber.contributes.panel.entry), s)
    if (!existsSync(p)) throw new Error(`缺 ${s}（先跑 node build.mjs）`)
  }
  return srcs.join(' ')
})

check('打出来的是 classic IIFE（不是 ESM）', () => {
  const p = join(here, 'panel/main.js')
  const src = readFileSync(p, 'utf8')
  if (/^\s*(import|export)\s/m.test(src)) throw new Error('产物里有顶层 import/export —— 宿主 iframe 不能加载 ESM')
  if (!/\(function\s*\(\)|\(\(\)\s*=>/.test(src)) throw new Error('看不到 IIFE 包装')
  return `${(src.length / 1024).toFixed(0)} KB`
})

check('守门：只允许写链文件（writeFile 必须走 chainPathFor），控制调用继续禁', () => {
  const srcDir = join(here, 'src/panel')
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.js'))
  if (!files.includes('chain-tab.js') || !files.includes('util.js')) {
    throw new Error(`面板源文件变了（${files.join(',')}）—— 这条守门要跟着改`)
  }
  // 粗剥注释：先去掉 `/* … */` 块，再逐行去掉 `//` 之后的部分
  // （约定：面板源码里不放含 `//` 或 `/*` 的字符串字面量，比如 URL）。
  // 为什么必须剥：注释里讨论 `writeFile(` 这种形态是正常的，不该把守门自己绊倒。
  const stripComments = (src) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => (l.includes('//') ? l.slice(0, l.indexOf('//')) : l))
      .join('\n')
  const banned = ['startSession(', 'prompt(', 'compose(', 'attach(']
  let writes = 0
  for (const f of files) {
    const src = stripComments(readFileSync(join(srcDir, f), 'utf8'))
    const hits = banned.filter((b) => src.includes(b))
    if (hits.length) throw new Error(`${f} 里出现控制调用：${hits.join(', ')}`)
    for (const m of src.matchAll(/writeFile\(/g)) {
      const call = src.slice(m.index, m.index + 40)
      // 唯一的合法形态：host.writeFile(chainPathFor(snapshot), …) —— 路径取自快照（插件正在读的那份）
      if (!call.startsWith('writeFile(chainPathFor(')) throw new Error(`${f} 里的 writeFile 不是写链文件：${call.split('\n')[0]}`)
      writes += 1
    }
  }
  if (writes === 0) throw new Error('找不到链文件的写调用 —— 面板不能保存了？')
  const util = readFileSync(join(srcDir, 'util.js'), 'utf8')
  if (!util.includes("return '~/.reeve/chain.json'")) throw new Error('chainPathFor 的兜底路径不是 ~/.reeve/chain.json')
  return `${files.length} 个源文件，写调用 ${writes} 处（都写链文件）`
})

check('包内没有 node_modules / TS 源码', () => {
  const bad = readdirSync(here).filter((n) => n === 'node_modules' || n.endsWith('.ts') || n.endsWith('.tsx'))
  if (bad.length) throw new Error(`不该在包里的：${bad.join(', ')}`)
  return '干净'
})

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)