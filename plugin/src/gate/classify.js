// 错误分类：决定"这一笔该不该换候选"。
//
// 语义顺序（复刻自我们 v1 时代那套 fallback 的行为规格，不引入其代码）：
//   ① 硬拒绝：abort / context_overflow → **永不换**（换了也是同样结局，还会跟用户的中断打架）
//   ② 语义必换：quota_exceeded / model_not_found / missing_api_key → 不看状态码，直接换
//   ③ 状态码白名单（policy.retry_on_errors）→ 换
//   ④ 显式 isRetryable === true → 需要"状态码安全阀"（白名单 ∪ 5xx ∪ 408/425/429）才接受
//   ⑤ 文本兜底（中英，含 9router 冷却期那种 503+retry-after 的说法）
//
// 只做判断，不做 IO——纯函数，测试逐条钉。

const NEVER = [/abort/i, /context[\s_-]{0,12}overflow/i, /context\s+length/i, /too\s+many\s+tokens/i, /上下文.{0,6}超/i, /超出.{0,8}上[下]文/i]
// `[正则, reason]` 成对：以前用"下标 → reason"的平行数组，插入一条就整段错位（中文模型不存在被判成 always:key）。
const ALWAYS = [
  [/quota[\s_-]*exceeded/i, 'always:quota'],
  [/resource[\s_-]*exhausted/i, 'always:quota'],
  [/out\s+of\s+credits/i, 'always:quota'],
  [/payment\s+required/i, 'always:quota'],
  [/insufficient[\s_-]*(quota|credits?|balance)/i, 'always:quota'],
  [/使用上限|额度不足|余额不足|已耗尽|达到.{0,6}限制/i, 'always:quota'],
  [/model[^\n]{0,24}not[^\n]{0,12}(found|supported)/i, 'always:model'],
  // zen 对未知模型返回 400 + "Upstream request failed: Model is unavailable." / "does not exist"
  [/model[^\n]{0,24}unavailable/i, 'always:model'],
  [/model[^\n]{0,40}(does\s+not\s+exist|not\s+exist|unknown|invalid)/i, 'always:model'],
  [/模型.{0,6}(不存在|不支持)/i, 'always:model'],
  [/missing[\s_-]*api[\s_-]*key/i, 'always:key'],
  [/api[\s_-]*key[^\n]{0,16}(missing|not\s+set|required)/i, 'always:key'],
]
const TEXT_HINTS = [
  /rate[\s_-]*limit/i,
  /too[\s_-]*many[\s_-]*requests/i,
  /quota\s+will\s+reset\s+after/i,
  /all\s+credentials\s+for\s+model/i,
  /service[\s_-]*unavailable/i,
  /overloaded/i,
  /try[\s_-]*again/i,
  /频率限制|请求过于频繁|暂时不可用|服务不可用|请稍后重试|限流/i,
]
const SAFE_EXTRA = Object.freeze([408, 425, 429])

const asString = (v) => (typeof v === 'string' ? v : '')

/** 状态码提取：`statusCode` → `status` → 嵌套（data/error/cause）→ 从文本里按白名单数字找。 */
export function statusOf({ status, text, error, policy } = {}) {
  const candidates = [status, error?.statusCode, error?.status, error?.data?.statusCode, error?.data?.status, error?.error?.statusCode, error?.error?.status, error?.cause?.statusCode, error?.cause?.status]
  for (const c of candidates) if (Number.isFinite(Number(c)) && Number(c) >= 100) return Number(c)
  const hay = `${asString(text)} ${asString(error?.message)} ${asString(error?.error?.message)}`
  for (const n of policy?.retry_on_errors ?? []) {
    if (new RegExp(`\\b${n}\\b`).test(hay)) return n
  }
  return null
}

/**
 * @returns {{ retryable: boolean, reason: string, status: number|null }}
 * reason ∈ never:abort|never:context | always:quota|always:model|always:key | status:<n> | explicit | text:<hint> | not-retryable
 */
export function classifyFailure({ status, text, error, headers, policy } = {}) {
  const hay = `${asString(text)} ${asString(error?.message)} ${asString(error?.name)} ${asString(error?.error?.message)}`
  for (const re of NEVER) if (re.test(hay)) return { retryable: false, reason: re === NEVER[0] ? 'never:abort' : 'never:context', status: statusOf({ status, text, error, policy }) }
  for (const [re, reason] of ALWAYS) if (re.test(hay)) return { retryable: true, reason, status: statusOf({ status, text, error, policy }) }

  const code = statusOf({ status, text, error, policy })
  const list = policy?.retry_on_errors ?? []
  if (code !== null && list.includes(code)) return { retryable: true, reason: `status:${code}`, status: code }

  if (error?.isRetryable === true || error?.data?.isRetryable === true) {
    const safe = code !== null && (list.includes(code) || (code >= 500 && code < 600) || SAFE_EXTRA.includes(code))
    return { retryable: safe, reason: safe ? 'explicit' : 'explicit-unsafe-status', status: code }
  }

  for (const re of TEXT_HINTS) if (re.test(hay)) return { retryable: true, reason: 'text', status: code }
  // 裸数字：429/503/… 出现在文本里（上游把码写进了消息）
  for (const n of list) if (new RegExp(`\\b${n}\\b`).test(hay)) return { retryable: true, reason: `text:${n}`, status: code }

  // 9router 形状：冷却期内的 503 + retry-after（有 retry-after 就是"过一会儿再来"，值得换）
  const retryAfter = headers?.get?.('retry-after') ?? headers?.['retry-after']
  if (code === 503 && retryAfter) return { retryable: true, reason: 'status:503', status: code }

  return { retryable: false, reason: 'not-retryable', status: code }
}