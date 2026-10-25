// 首次启动时把 `providers.reeve` 写进引擎配置 —— **只加自己那一块**。
//
// 使用者裁决（2026-10-20）："要让插件首次启动时，自己把 providers.reeve 那两行写进 opencode.jsonc"。
// 于是这条从"插件绝不写引擎配置"改成"**只写自己那一块，且只在不写就没法工作时写**"。
//
// 四条纪律（都是为了"改别人的文件"这件事不出事）：
//   1. **只加不改**：`providers.reeve` 已存在（哪怕值是错的）→ 一个字节都不动，只记日志；
//   2. **备份**：动之前写 `<文件>.reeve-bak`（只备份一次，别覆盖更早的备份）；
//   3. **写完自校验**：剥离整行注释后必须能 JSON.parse，且 `providers.reeve.settings.baseURL` 在 ——
//      校验不过就把备份还原回去（绝不留一个坏掉的配置）；
//   4. **保留注释与格式**：只做文本插入，不重新序列化（用户的 jsonc 里有注释）。

import { readFileSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { t } from './locale.js'

/** 引擎配置里我们那一块（三行端点）。 */
export function reeveProviderBlock({ port = 8080, host = '127.0.0.1', packageId = '@ai-sdk/openai-compatible' } = {}) {
  return { package: packageId, settings: { baseURL: `http://${host}:${port}/v1` } }
}

/** 剥离整行注释后解析（与读端点、样板守门同一套规则）。 */
export function parseJsonc(text) {
  const stripped = String(text)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
  return JSON.parse(stripped)
}

/**
 * 计划插入：返回 { changed, text, reason }。纯函数，可测。
 * 处理三种形状：没有 providers 键 / providers 是空对象 / providers 非空（要带逗号）。
 */
export function planProviderInsertion(text, providerId = 'reeve', block = reeveProviderBlock()) {
  const src = String(text)
  let doc
  try {
    doc = parseJsonc(src)
  } catch (err) {
    return { changed: false, text: src, reason: t('endpoint.invalidJson', { error: String(err).slice(0, 80) }) }
  }
  if (doc?.providers?.[providerId] !== undefined) {
    return { changed: false, text: src, reason: t('endpoint.exists') }
  }

  const entry = `"${providerId}": ${JSON.stringify(block, null, 2).replace(/\n/g, '\n  ')}`
  const anchor = /"providers"\s*:\s*\{/.exec(src)
  let out
  let where
  if (anchor) {
    const open = anchor.index + anchor[0].length
    const after = src.slice(open)
    const isEmpty = /^\s*\}/.test(after)
    const indent = '    '
    const body = isEmpty
      ? `\n${indent}${entry.replace(/\n/g, `\n${indent}`)}\n  `
      : `\n${indent}${entry.replace(/\n/g, `\n${indent}`)},`
    out = src.slice(0, open) + body + after
    where = 'providers'
  } else {
    const open = src.indexOf('{')
    if (open < 0) return { changed: false, text: src, reason: t('endpoint.noRoot') }
    const after = src.slice(open + 1)
    const isEmpty = /^\s*\}/.test(after)
    const body = isEmpty
      ? `\n  "providers": { ${entry} }\n`
      : `\n  "providers": { ${entry} },`
    out = src.slice(0, open + 1) + body + after
    where = 'new-key'
  }

  // 自校验：插完之后必须是合法 JSON，且我们那块在
  try {
    const check = parseJsonc(out)
    if (check?.providers?.[providerId]?.settings?.baseURL === undefined) {
      return { changed: false, text: src, reason: t('endpoint.verifyFailed') }
    }
  } catch (err) {
    return { changed: false, text: src, reason: t('endpoint.insertedInvalid', { error: String(err).slice(0, 80) }) }
  }
  return { changed: true, text: out, reason: t(where === 'providers' ? 'endpoint.addedInProviders' : 'endpoint.addedNewKey', { id: providerId }) }
}

/**
 * 找到引擎配置文件并确保有我们那一块。返回 { status, path, detail }；
 * status: 'added' | 'present' | 'no-file' | 'skipped' | 'rolled-back'
 */
export async function ensureProviderBlock({
  configDir = null,
  providerId = 'reeve',
  block = reeveProviderBlock(),
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  renameImpl = rename,
  logger = console,
  createIfMissing = false,
} = {}) {
  const dir = configDir ?? join(homedir(), '.config', 'opencode')
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    const path = join(dir, name)
    let text
    try {
      text = await readFileImpl(path, 'utf8')
    } catch {
      continue
    }
    const plan = planProviderInsertion(text, providerId, block)
    if (!plan.changed) return { status: 'present', path, detail: plan.reason }
    try {
      await writeFileImpl(`${path}.reeve-bak`, text, 'utf8').catch(() => {})
      await writeFileImpl(path, plan.text, 'utf8')
      logger.debug(`[reeve] 已把 providers.${providerId} 写进 ${path}（原文件备份在 <同目录>.reeve-bak）`)
      return { status: 'added', path, detail: plan.reason }
    } catch (err) {
      // 写失败/校验不过：还原
      try {
        await renameImpl(`${path}.reeve-bak`, path)
      } catch {
        /* 还原不了也没别的办法，日志里说清楚 */
      }
      logger.debug(`[reeve] 写引擎配置失败，已还原：${String(err).slice(0, 160)}`)
      return { status: 'rolled-back', path, detail: String(err).slice(0, 160) }
    }
  }
  if (!createIfMissing) return { status: 'no-file', path: join(dir, 'opencode.jsonc'), detail: t('endpoint.noFile') }
  const path = join(dir, 'opencode.jsonc')
  const body = `{\n  "providers": { "${providerId}": ${JSON.stringify(block, null, 2).replace(/\n/g, '\n  ')} }\n}\n`
  try {
    await writeFileImpl(path, body, 'utf8')
    logger.debug(`[reeve] 新建了 ${path} 并写入 providers.${providerId}`)
    return { status: 'added', path, detail: t('endpoint.created') }
  } catch (err) {
    return { status: 'skipped', path, detail: String(err).slice(0, 160) }
  }
}
/**
 * 读引擎配置里 `providers.reeve.models` 手写过的模型 id 集合 —— 这些是**配置说话**的条目，
 * 插件的档位元数据（成本/limit/发布时间）不去动它们。读不到/解析失败 → 空集（全部当插件自有）。
 * **只读**。
 */
export async function configuredReeveModelIds({ configDir = null, readFileImpl = readFile, providerId = 'reeve' } = {}) {
  const dir = configDir ?? join(homedir(), '.config', 'opencode')
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    try {
      const text = await readFileImpl(join(dir, name), 'utf8')
      const models = parseJsonc(text)?.providers?.[providerId]?.models
      if (!models || typeof models !== 'object') continue
      return new Set(Object.keys(models))
    } catch {
      continue
    }
  }
  return new Set()
}

/** `configuredReeveModelIds` 的同步版：provider transform 回调是同步的，只能在这里用。 */
export function configuredReeveModelIdsSync({ configDir = null, readFileImpl = readFileSync, providerId = 'reeve' } = {}) {
  const dir = configDir ?? join(homedir(), '.config', 'opencode')
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    try {
      const text = readFileImpl(join(dir, name), 'utf8')
      const models = parseJsonc(text)?.providers?.[providerId]?.models
      if (!models || typeof models !== 'object') continue
      return new Set(Object.keys(models))
    } catch {
      continue
    }
  }
  return new Set()
}
