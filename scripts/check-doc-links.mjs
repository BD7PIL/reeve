#!/usr/bin/env node
// Public-doc link gate: relative links must resolve inside the public tree, and
// public docs must not point at development records (docs/ .zcode/).
//
//   node scripts/check-doc-links.mjs --root .
//   node scripts/check-doc-links.mjs --root /tmp/exported-public-tree
//
// External http(s) links are reported but not fetched by default (CI stability);
// pass --external to probe them with a short timeout.

import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
let root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))
let probeExternal = false
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--root') root = resolve(args[++i])
  else if (args[i] === '--external') probeExternal = true
  else throw new Error(`unknown argument: ${args[i]}`)
}

const FILES = [
  'README.md',
  'README.zh-CN.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'NOTICE.md',
  'plugin/README.md',
  'extensions/reeve/README.md',
]

const FORBIDDEN = [/(^|\/)docs\//, /(^|\/)\.zcode\//]
const failures = []
const warnings = []

function linksOf(text) {
  const out = []
  // [label](target) — skip images and inline code fences; anchors are ignored.
  const re = /(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  for (;;) {
    const m = re.exec(text)
    if (!m) break
    if (m[1] === '!') continue
    const target = m[2].trim()
    if (!target || target.startsWith('#') || target.startsWith('mailto:')) continue
    out.push(target)
  }
  return out
}

for (const rel of FILES) {
  const file = join(root, rel)
  if (!existsSync(file)) { warnings.push(`missing optional doc: ${rel}`); continue }
  const text = readFileSync(file, 'utf8')
  for (const target of linksOf(text)) {
    if (FORBIDDEN.some((re) => re.test(target))) {
      failures.push(`${rel}: points at a non-public development path: ${target}`)
      continue
    }
    if (/^https?:\/\//i.test(target)) {
      if (/github\.com\/BD7PIL\/reeve\/(blob|tree)\//i.test(target)) {
        const path = target.replace(/^.*github\.com\/BD7PIL\/reeve\/(?:blob|tree)\/[^/]+\//i, '')
        if (FORBIDDEN.some((re) => re.test(path)) || !existsSync(join(root, decodeURIComponent(path)))) {
          failures.push(`${rel}: broken same-repo link: ${target}`)
        }
      }
      continue
    }
    if (/^[a-z]+:/i.test(target)) continue // other schemes
    const local = decodeURIComponent(target.split('#')[0])
    const abs = isAbsolute(local) ? local : resolve(dirname(file), local)
    if (!existsSync(abs)) failures.push(`${rel}: missing relative link target: ${target}`)
    else if (statSync(abs).isDirectory() && !existsSync(join(abs, 'README.md'))) {
      warnings.push(`${rel}: directory link has no README: ${target}`)
    }
  }
}

if (probeExternal) {
  for (const rel of FILES) {
    const file = join(root, rel)
    if (!existsSync(file)) continue
    for (const target of linksOf(readFileSync(file, 'utf8'))) {
      if (!/^https?:\/\//i.test(target)) continue
      if (/github\.com\/BD7PIL\/reeve\//i.test(target)) continue
      try {
        const res = await fetch(target, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15_000) })
        if (res.status >= 400) warnings.push(`${rel}: external link HTTP ${res.status}: ${target}`)
      } catch (err) {
        warnings.push(`${rel}: external link unavailable (${err?.name ?? 'error'}): ${target}`)
      }
    }
  }
}

if (warnings.length) for (const w of warnings) console.warn(`warning: ${w}`)
if (failures.length) {
  console.error('public doc links failed:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`public doc links: OK (${relative(process.cwd(), root) || '.'})`)
