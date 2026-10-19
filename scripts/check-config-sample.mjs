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
if (config.default_agent !== 'foreman') problems.push('default_agent 必须是 foreman（前台只出现编排者）')
for (const name of ['build', 'plan', 'general', 'explore']) {
  if (config.agents?.[name]?.hidden !== true) problems.push(`内置 agent ${name} 必须 hidden: true`)
}
const models = config.providers?.reeve?.models ?? {}
for (const tier of ['flash', 'pro', 'multimodal']) {
  if (!models[tier]?.modelID) problems.push(`档位 ${tier} 缺 modelID`)
}
if (models.multimodal?.capabilities?.input?.includes('image') !== true) {
  problems.push('只有 multimodal 档必须声明能吃图（capabilities.input 含 image）')
}
if (models.flash?.capabilities?.input?.includes('image') === true ||
    models.pro?.capabilities?.input?.includes('image') === true) {
  problems.push('flash/pro 不该声明能吃图 —— 带图调用应该在引擎侧就被挡回 multimodal')
}
if (!Array.isArray(config.plugins) || config.plugins.length === 0) problems.push('必须挂上记账插件')
const proxy = config.plugins?.[0]?.options?.proxy
if (proxy?.enabled !== true) problems.push('纯插件形态要求 plugins[0].options.proxy.enabled = true')
if (config.providers?.reeve?.settings?.apiKey !== 'reeve-local') problems.push('纯插件形态的 apiKey 写占位值 reeve-local（VK 形态才用 {env:REEVE_VK}）')
if (Number(proxy?.port) !== Number(new URL(config.providers?.reeve?.settings?.baseURL ?? 'http://x').port)) problems.push('proxy.port 必须与 baseURL 的端口一致')

if (problems.length > 0) {
  for (const p of problems) console.error(`❌ ${p}`)
  process.exit(1)
}
console.log('✅ config/opencode.sample.jsonc 通过（整行注释 + 合法 JSON + 关键键都在）')