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

// `npm pack --json` 的形状跨大版本变过：npm 11 给数组，npm 12 给对象（按包名索引）。
// CI 上装的是 `npm@11`（钉住了），这里两种都吃，免得工具链一漂就红。
const parsed = JSON.parse(raw)
const info = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
if (!info?.files) {
  console.error(`读不懂 npm pack 的输出形状（顶层是 ${Array.isArray(parsed) ? 'array' : typeof parsed}）`)
  process.exit(2)
}
const paths = info.files.map((f) => f.path)

const problems = []

// ① 该在的都在
const required = [
  'package.json',
  'index.js',
  'README.md',
  'LICENSE',
  'THIRD-PARTY.md',
  'default-fallback.json',
  'licenses/oh-my-opencode-slim.LICENSE',
  'licenses/open-code-review.LICENSE',
  'agents/foreman.md',
  'skills/review/SKILL.md',
  'skills/review/default.md',
  'src/index.js',
  'src/gate/gate.js',
  'src/gate/config.js',
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

// ②b 安装契约与 npm 版本必须一致。
// provision.json 是 ocrc 的安装契约（它据此报「组件：安装 reeve <ver>」并给缓存命名）。
// 真实事故（0.2.9 首发）：契约忘了跟着 bump，ocrc 推的是 0.2.9、日志却说 0.2.8 ——
// 运维据此反复重装。发布前把两份版本钉在一起。
if (!paths.includes('provision.json')) {
  problems.push('缺文件：provision.json（ocrc 的安装契约）')
} else {
  const contract = JSON.parse(readFileSync(join(pkgDir, 'provision.json'), 'utf8'))
  if (contract.version !== info.version) {
    problems.push(`provision.json 的 version（${contract.version}）与 package.json（${info.version}）不一致 —— 一起 bump`)
  }
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