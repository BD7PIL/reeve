// 把 src/panel/main.js 打成面板要的 **classic IIFE**（宿主的 iframe 不能加载 ESM）。
//
//   node build.mjs                      # 用本目录/相邻检出里找到的 SDK + esbuild
//   node build.mjs --sdk=<路径>          # 显式指定 @openchamber/sdk 包目录
//   node build.mjs --esbuild=<路径>      # 显式指定 esbuild 包目录（不是 .cmd）
//
// 为什么要显式路径：本仓库**不 vendor** openchamber 的 SDK 与 esbuild
//（SDK 是宿主的产物，版本跟着宿主走）。本地开发时指到你手上那份即可；
// 发布包里只需要打好的 `panel/main.js`。
//
// 走 esbuild 的 **JS API** 而不是 spawn CLI：Windows 上 Node ≥ 18.20 不能直接
// execFile 一个 `.cmd`（EINVAL）—— 实测踩到，所以这里 import 包本身。

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = ''] = a.replace(/^--/, '').split('=')
    return [k, v]
  }),
)

function firstExisting(paths, kind) {
  for (const p of paths) if (p && existsSync(p)) return p
  throw new Error(`找不到 ${kind}。用 --${kind} 指定路径。\n试过：\n  ${paths.filter(Boolean).join('\n  ')}`)
}

const sdkPkg = args.get('sdk')
  ? resolve(args.get('sdk'))
  : firstExisting(
      [
        join(here, 'node_modules/@openchamber/sdk'),
        // 与 reeve 并列的 ocrc 检出里带了宿主 SDK（2.3.2，对应 openchamber 2.3.3）
        join(here, '../../../ocrc/extensions/ocrc-omo-view/node_modules/@openchamber/sdk'),
        join(here, '../../node_modules/@openchamber/sdk'),
      ],
      'sdk',
    )

const esbuildPkg = args.get('esbuild')
  ? resolve(args.get('esbuild'))
  : firstExisting(
      [
        join(here, 'node_modules/esbuild'),
        join(here, '../../../ocrc/extensions/ocrc-omo-view/node_modules/esbuild'),
      ],
      'esbuild',
    )

const sdkEntry = join(sdkPkg, 'dist/index.js')
const sdkUiEntry = join(sdkPkg, 'dist/ui/index.js')
const out = join(here, 'panel/main.js')

console.log(`SDK:      ${sdkPkg}`)
console.log(`esbuild:  ${esbuildPkg}`)
console.log(`输出:     ${out}`)

const esbuild = await import(pathToFileURL(join(esbuildPkg, 'lib/main.js')).href)
await (esbuild.build ?? esbuild.default.build)({
  entryPoints: [join(here, 'src/panel/main.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  outfile: out,
  alias: {
    '@openchamber/sdk/ui': sdkUiEntry,
    '@openchamber/sdk': sdkEntry,
  },
})
console.log('完成。')