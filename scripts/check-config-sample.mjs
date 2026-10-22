// 本地守门：config/opencode.sample.jsonc 必须是"整行注释 + 合法 JSON"。
// 部署脚本（scripts/el7-deploy-staging.sh 的 2b 步）用的是同一套剥离规则——
// 那里错了会在 EL7 上才炸，这里先在本地炸。
//
//   node scripts/check-config-sample.mjs
//
// 规则：注释只能整行（行首可选空白 + //）；行内出现 // 只允许在字符串里。
// 为什么：派生器要把它当 JSON 解析后改几处路径/端口，行尾注释会让解析器与
// 定位都变脆（这一条是被真实的 trailing comma + 行尾注释坑出来的）。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const path = join(root, 'config', 'opencode.sample.jsonc')

const lines = readFileSync(path, 'utf8').split('\n')
const kept = []
for (const [i, line] of lines.entries()) {
  if (line.trim().startsWith('//')) continue
  const withoutStrings = line.replace(/"(?:\\.|[^"\\])*"/g, '""')
  if (withoutStrings.includes('//')) {
    console.error(`❌ 第 ${i + 1} 行有行尾注释（派生器只支持整行注释）：${line.trim().slice(0, 70)}`)
    process.exit(1)
  }
  kept.push(line)
}

let config
try {
  config = JSON.parse(kept.join('\n'))
} catch (err) {
  console.error(`❌ 剥离注释后不是合法 JSON：${err.message}`)
  process.exit(1)
}

const problems = []
// 前台只出现编排者 / 三个档位模型 / 默认 agent —— **现在是插件的职责**（插件注册，配置优先）。
// 这里只守住"插件代替不了的那两行"+ 覆盖路径的形状。
// 端点现在**可以不写** —— 插件首次启动会自己把 providers.reeve 写进配置（PROGRESS §6.9）。
// 写了就按下面的规则校验；不写就是"交给插件自举"。
const settings = config.providers?.reeve?.settings
if (settings !== undefined && (typeof settings?.baseURL !== 'string' || !settings.baseURL.startsWith('http'))) {
  problems.push('写了 providers.reeve 就必须有 settings.baseURL（不写则由插件自举）')
}
// apiKey 可以不写（引擎就不发 Authorization，而插件自持的代理关了回环鉴权）；写的话只允许两种形态
const apiKey = settings?.apiKey
if (apiKey !== undefined && apiKey !== 'reeve-local' && !String(apiKey).includes('{env:REEVE_VK}')) {
  problems.push('apiKey 要么不写、要么写占位值 reeve-local（插件自持）、要么 {env:REEVE_VK}（启动器持有）')
}
const models = config.providers?.reeve?.models
if (models !== undefined) {
  // 只有显式覆盖时才检查；不写 = 由插件注册四个档位
  for (const tier of ['flash', 'coding', 'pro', 'multimodal']) {
    if (!models[tier]?.modelID) problems.push(`覆盖了 models 就要写全：档位 ${tier} 缺 modelID`)
  }
  if (models.multimodal?.capabilities?.input?.includes('image') !== true) {
    problems.push('覆盖后 multimodal 必须声明能吃图（capabilities.input 含 image）')
  }
}
if (!Array.isArray(config.plugins) || config.plugins.length === 0) problems.push('必须挂上记账插件')
const proxy = config.plugins?.[0]?.options?.proxy
// 代理默认开：只有显式关掉才算"启动器形态"
if (proxy === false || proxy?.enabled === false) {
  problems.push('若关掉插件自持（gate: false）就该手写 providers.reeve 端点块')
}

if (proxy?.port !== undefined &&
    Number(proxy.port) !== Number(new URL(config.providers?.reeve?.settings?.baseURL ?? 'http://x').port)) {
  problems.push('写了 proxy.port 就必须与 baseURL 的端口一致（不写则由插件从 baseURL 推）')
}

if (problems.length > 0) {
  for (const p of problems) console.error(`❌ ${p}`)
  process.exit(1)
}
console.log('✅ config/opencode.sample.jsonc 通过（整行注释 + 合法 JSON + 关键键都在）')