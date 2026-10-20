// 发布前断言 **npm 包的内容** —— 用 `npm pack --dry-run --json` 的文件清单判断，不真打包上传。
//
//   node scripts/check-plugin-pack.mjs
//
// 为什么需要它：`files` 与目录结构会漂移。许可文本漏出去是许可事故，
// `docs/` 混进来是内部信息外泄，密钥类字面混进来是安全事故。三条都在这里卡死：
//   ① 该在的都在：入口 / agents / skills / 链基座 / 许可文本（自写 MIT + 两份第三方原文）
//   ② 不该在的不在：docs/、.zcode/、test/、node_modules/、密钥类文件名
//   ③ 随包文件里不许出现密钥或内网地址的字面（逐文件扫）

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkgDir = join(root, 'plugin')

// 用 node 自带的 npm CLI（`npm-cli.js`）而不是 spawn `npm`：
//  · Windows 上 Node ≥ 18.20 不能直接 execFile 一个 .cmd（EINVAL，build.mjs 同一个坑）；
//  · 用 shell 转发又会踩 DEP0190。直接以 node 跑它的 CLI，两边都干净。
const nodeDir = dirname(process.execPath)
const npmCli = [
  join(nodeDir, 'node_modules/npm/bin/npm-cli.js'), // Windows
  join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Linux / macOS
].find((p) => existsSync(p))
if (!npmCli) {
  console.error(`找不到 npm CLI（试过 node 目录 ${nodeDir}）`)
  process.exit(2)
}

const raw = execFileSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: pkgDir,
  encoding: 'utf8',
})

const [info] = JSON.parse(raw)
const paths = info.files.map((f) => f.path)

const problems = []

// ① 该在的都在
const required = [
  'package.json',
  'index.js',
  'README.md',
  'LICENSE',
  'THIRD-PARTY.md',
  'default-chain.json',
  'licenses/oh-my-opencode-slim.LICENSE',
  'licenses/open-code-review.LICENSE',
  'agents/foreman.md',
  'skills/review/SKILL.md',
  'skills/review/default.md',
  'src/index.js',
  'src/proxy.js',
  'src/chain.js',
  'src/stats.js',
]
for (const rel of required) {
  if (!paths.includes(rel)) problems.push(`缺文件：${rel}`)
}

// ② 不该在的不在
const bannedPrefixes = ['docs/', '.zcode/', 'test/', 'node_modules/']
for (const rel of paths) {
  for (const prefix of bannedPrefixes) {
    if (rel.startsWith(prefix)) problems.push(`不该发布：${rel}`)
  }
  if (/(^|\/)\.env|\.pem$|(^|\/)\.key$|id_rsa|id_ed25519/.test(rel)) problems.push(`可疑文件：${rel}`)
}

// ③ 随包文件的内容扫描（密钥 / 内网地址）
const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥字面'],
  [/192\.168\.\d{1,3}\.\d{1,3}/, '内网地址'],
  [/\bsshpass\b/, 'sshpass'],
  [/REEVE_KEY_[A-Z0-9_]+\s*[=:]\s*['"]?[A-Za-z0-9_\-]{16,}/, '真实密钥赋值'],
]
for (const rel of paths) {
  if (!/\.(js|mjs|json|md|jsonc)$/.test(rel)) continue
  const text = readFileSync(join(pkgDir, rel), 'utf8')
  for (const [re, label] of PATTERNS) {
    if (re.test(text)) problems.push(`${rel}：命中「${label}」`)
  }
}

console.log(`包：${info.name}@${info.version}，${paths.length} 个文件，${(info.size / 1024).toFixed(0)} KB`)
console.log(`入口清单里的关键项：agents=${paths.filter((p) => p.startsWith('agents/')).length} 个、` +
  `skills=${paths.filter((p) => p.startsWith('skills/')).length} 个、src=${paths.filter((p) => p.startsWith('src/')).length} 个`)

if (problems.length) {
  console.error('\n❌ 不适合发布：')
  for (const p of problems) console.error(`  · ${p}`)
  process.exit(1)
}
console.log('✓ 包内容断言全部通过')