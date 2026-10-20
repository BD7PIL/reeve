// 运行时注册：把 agent 与 skill **从插件自己的包里**注册进引擎。
//
// 为什么这么做（使用者："像 omo 一样"）：omo 的 agent 与 prompt 都在插件里，配置只有一行。
// 搬进来之后，**配置目录里不再需要 agent/ 与 skill/ 两个目录**，也不用往那儿拷文件。
//
// 提示词仍是 markdown（`plugin/agents/*.md`、`plugin/skills/<name>/*.md`）——
// 它们是插件包的一部分，改提示词就改这些文件；代价是**面板改不了**（那是刻意的，见 §6.1）。
//
// 三条纪律：
//   1. **配置优先**：引擎里已经有的（配置目录里的 md、用户的覆盖）一律不动，只补缺的；
//   2. 建出来的 agent 该 hidden 的就 hidden（前台只留编排者）；
//   3. skill 的 content 里会把真实的绝对路径填进去 —— 因为配套的 rubric 文件也在插件包里，
//      模型要靠那个路径去读它们。

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const AGENTS_DIR = join(PLUGIN_ROOT, 'agents')
export const SKILLS_DIR = join(PLUGIN_ROOT, 'skills')

/** 极小的 frontmatter 解析：只认我们的 md 用的那几个键（够用，不引依赖）。 */
/** 去掉一层引号（我们的 md 里 `resource: "*"` 是带引号的 YAML 写法）。 */
function unquote(v) {
  const t = String(v).trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text))
  if (!m) return { data: {}, body: String(text).trim() }
  const data = {}
  const lines = m[1].split(/\r?\n/)
  let current = null
  for (const line of lines) {
    if (/^\s*$/.test(line)) continue
    const top = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (top) {
      const [, key, raw] = top
      if (raw === '') {
        current = key
        data[key] = key === 'permissions' ? [] : null
      } else {
        current = null
        data[key] = unquote(raw)
      }
      continue
    }
    const item = /^\s*-\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (item && current === 'permissions' && Array.isArray(data[current])) {
      data[current].push({ [item[1]]: unquote(item[2]) })
      continue
    }
    const cont = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (cont && current === 'permissions' && Array.isArray(data[current]) && data[current].length > 0) {
      Object.assign(data[current][data[current].length - 1], { [cont[1]]: unquote(cont[2]) })
    }
  }
  return { data, body: m[2].trim() }
}

/** md → 引擎要的 agent 形状（`ctx.agent.transform` 里 `editor.update(id, a => Object.assign(a, ...))`）。 */
export function toAgentInfo(id, text) {
  const { data, body } = parseFrontmatter(text)
  const info = {
    id,
    name: id,
    description: typeof data.description === 'string' ? data.description : undefined,
    system: body.length > 0 ? body : undefined,
    mode: ['primary', 'subagent', 'all'].includes(data.mode) ? data.mode : 'subagent',
  }
  if (data.hidden === 'true') info.hidden = true
  if (typeof data.model === 'string' && data.model.includes('/')) {
    const [providerID, ...rest] = data.model.split('/')
    info.model = { providerID, id: rest.join('/') }
  }
  if (Array.isArray(data.permissions)) {
    info.permissions = data.permissions
      .filter((p) => p && p.action && p.resource && p.effect)
      .map((p) => ({ action: p.action, resource: p.resource, effect: p.effect }))
  }
  return info
}

/** 读插件包里的 agents/*.md。 */
export async function loadAgents({ dir = AGENTS_DIR, readdirImpl = readdir, readFileImpl = readFile } = {}) {
  const out = []
  let files = []
  try {
    files = (await readdirImpl(dir)).filter((f) => f.endsWith('.md')).sort()
  } catch {
    return out
  }
  for (const f of files) {
    try {
      const text = await readFileImpl(join(dir, f), 'utf8')
      out.push(toAgentInfo(f.replace(/\.md$/, ''), text))
    } catch {
      /* 读不到就跳过 —— 宁可少注册，也不要把插件加载搞崩 */
    }
  }
  return out
}

/** 读插件包里的 skills/<name>/SKILL.md；content 里把真实路径填进去（配套 rubric 靠它定位）。 */
export async function loadSkills({ dir = SKILLS_DIR, readdirImpl = readdir, readFileImpl = readFile } = {}) {
  const out = []
  let entries = []
  try {
    entries = await readdirImpl(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (!e.isDirectory?.()) continue
    const file = join(dir, e.name, 'SKILL.md')
    try {
      const text = await readFileImpl(file, 'utf8')
      const { data, body } = parseFrontmatter(text)
      out.push({
        id: e.name,
        name: typeof data.name === 'string' ? data.name : e.name,
        description: typeof data.description === 'string' ? data.description.replace(/\s+/g, ' ').trim() : undefined,
        path: file,
        // 把 skill 自己的目录塞进正文 —— rubric 文件住在插件包里，模型得知道绝对路径
        content: `（本 skill 的目录：${join(dir, e.name)}）\n\n${body}`,
      })
    } catch {
      /* 同一个 skill 有问题不影响其它 */
    }
  }
  return out
}