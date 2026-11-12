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
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// `--pkg-dir` lets the negative tests run against a throwaway copy instead of
// mutating the real plugin/ tree.
const argv = process.argv.slice(2)
let pkgDir = join(root, 'plugin')
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--pkg-dir') {
    const value = argv[++i]
    if (!value) {
      console.error('--pkg-dir needs a path')
      process.exit(2)
    }
    pkgDir = resolve(value)
  } else {
    console.error(`unknown argument: ${argv[i]}`)
    process.exit(2)
  }
}

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
let contract = null
if (!paths.includes('provision.json')) {
  problems.push('缺文件：provision.json（ocrc 的安装契约）')
} else {
  contract = JSON.parse(readFileSync(join(pkgDir, 'provision.json'), 'utf8'))
  if (contract.version !== info.version) {
    problems.push(`provision.json 的 version（${contract.version}）与 package.json（${info.version}）不一致 —— 一起 bump`)
  }
}

// ②c 安装契约里的插件 spec 必须等于「包名@版本」。
// 真实事故：0.2.12 发布时 provision.json 的 spec 还停在 0.2.8，ocrc 按契约推旧版。
const expectedSpec = `${info.name}@${info.version}`
if (contract?.enginePlugin?.spec !== expectedSpec) {
  problems.push(
    `provision.json 的 enginePlugin.spec（${contract?.enginePlugin?.spec ?? '缺失'}）应为 ${expectedSpec} —— 与包名+版本一起改`,
  )
}

// ②d review rubric 必须与 UPSTREAM.sha256 逐份对上。
// 64 份是上游 tag 的原样副本；sha256 同时钉住「文件没被改」和「行尾没被重写」。
const REVIEW_PREFIX = 'skills/review/'
const reviewFiles = paths.filter((p) => p.startsWith(REVIEW_PREFIX))
for (const rel of reviewFiles) {
  if (rel.slice(REVIEW_PREFIX.length).includes('/')) problems.push(`skills/review 下不许有子目录：${rel}`)
}
const manifestRel = `${REVIEW_PREFIX}UPSTREAM.sha256`
if (!reviewFiles.includes(manifestRel)) {
  problems.push(`缺文件：${manifestRel} —— review 规则没有来源校验清单`)
} else {
  const expected = new Map()
  for (const line of readFileSync(join(pkgDir, manifestRel), 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line)
    if (!m) {
      problems.push(`${manifestRel} 格式不对（应为「sha256␣␣文件名」）：${line.slice(0, 80)}`)
      continue
    }
    expected.set(m[2], m[1])
  }
  const actualMd = new Set(
    reviewFiles
      .filter((p) => p.endsWith('.md') && p !== `${REVIEW_PREFIX}SKILL.md`)
      .map((p) => p.slice(REVIEW_PREFIX.length)),
  )
  for (const [file, sha] of expected) {
    if (!actualMd.has(file)) {
      problems.push(`${manifestRel} 列了 ${file}，但包里没有`)
      continue
    }
    const digest = createHash('sha256').update(readFileSync(join(pkgDir, REVIEW_PREFIX, file))).digest('hex')
    if (digest !== sha) problems.push(`${file} 的 sha256 与 ${manifestRel} 不符（内容被改或行尾被重写）`)
  }
  for (const file of actualMd) {
    if (!expected.has(file)) problems.push(`包里多出未登记的 rubric：${file}（同步更新 ${manifestRel}）`)
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