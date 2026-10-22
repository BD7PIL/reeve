// 静态守门：**Bifrost 不许回流**。
//
// 为什么要有这条测试：Bifrost（v2 时代的代理层）已经整体退役 —— 现在是 GATE（`src/gate/`）。
// 退役是靠一次大删除完成的，而"删干净"这件事最容易在后续小改里被慢慢破坏
// （有人从旧分支抄一段代码、从历史文档抄一段引用、或把 pin 名字又写回来）。
// 这条测试把"回流"变成红灯，而不是让它在某次发布后才被发现。
//
//   node plugin/test/guard.mjs
//
// 扫描面（**源码与产物**，不含 docs/历史）：plugin/src/**、plugin/index.js、
// extensions/reeve/src/**（面板源码 —— 面板产物在 panel/ 下，由构建步骤保证与 src 一致）。

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = dirname(here) // .../plugin
const repoRoot = dirname(pluginRoot) // .../reeve

let passed = 0
const ok = (label) => {
  passed += 1
  console.log(`  ✓ ${label}`)
}

/** 递归列出目录下所有 .js/.mjs/.json/.jsonc 文件（跳过 node_modules / coverage）。 */
function listFiles(dir) {
  const out = []
  const walk = (d) => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'coverage') continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(js|mjs|cjs|json|jsonc)$/.test(e.name)) out.push(p)
    }
  }
  walk(dir)
  return out
}

/** 禁止回流的模式 → 为什么。 */
const FORBIDDEN = [
  [/bifrost/i, 'Bifrost（已退役的代理层）'],
  [/default-chain\.json/, 'Bifrost 时代的链基座文件（已删）'],
  [/proxy\/config\.json/, 'Bifrost 时代的链基座配置（已删）'],
  [/getmaxim\.ai/, 'Bifrost 下载站（已退役）'],
  [/\bBIFROST_SETUP_TOKEN\b/, 'Bifrost 的 setup token 环境变量'],
]

const SCAN = [
  join(pluginRoot, 'index.js'),
  ...listFiles(join(pluginRoot, 'src')),
  ...listFiles(join(repoRoot, 'extensions', 'reeve', 'src')),
  ...listFiles(join(repoRoot, 'scripts')).filter(
    // accept-gate.sh 的 ⑨ 就是"查 bifrost 进程"这条断言本身，必须提这个名字；
    // coverage-baseline.json 的 `_history` 是**史书**（记录退役这件事），不是代码引用。
    (p) => !p.endsWith('accept-gate.sh') && !p.endsWith('coverage-baseline.json'),
  ),
]

{
  const hits = []
  for (const file of SCAN) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const [re, why] of FORBIDDEN) {
      const m = re.exec(text)
      if (m) hits.push(`${file.replace(repoRoot, '…')}: 「${m[0]}」—— ${why}`)
    }
  }
  assert.deepEqual(hits, [], `Bifrost 回流（共 ${hits.length} 处）：\n  ${hits.join('\n  ')}`)
  ok(`静态守门：${SCAN.length} 个文件里没有 Bifrost 回流（${FORBIDDEN.length} 条模式）`)
}

// 反向确认扫描真的覆盖到了东西（防止路径写错导致"空扫全过"）
{
  assert.ok(SCAN.length >= 15, `扫描面至少 15 个文件（实际 ${SCAN.length}）`)
  const gateFiles = SCAN.filter((p) => p.includes(`${join('src', 'gate')}`))
  assert.ok(gateFiles.length >= 5, `GATE 模块在扫描面里（实际 ${gateFiles.length}）`)
  ok('守门自身：扫描面非空且包含 GATE 模块')
}

console.log(`\n守门测试：${passed} 项全过`)