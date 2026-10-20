// REEVE 归因查询 —— 核心实现（Node + node:sqlite）。
//
// 为什么不是 sqlite3 CLI：Bifrost 的库用了**部分索引**（`CREATE INDEX ... WHERE ...`），
// 需要 SQLite >= 3.8 才能解析。EL7 自带 3.7.17，打开就报
// `malformed database schema (idx_mcp_logs_session_id)` —— 实测踩到。
// Node 的 node:sqlite 走的是新引擎，没有这个问题。
//
// 用法（一般通过 scripts/served-model.sh 调）：
//   node served-model.mjs --db <logs.db> [--days 7] [--errors] [--tier reeve/pro] [--json]
//
// 列名依据：2026-10-19 在 EL7 上对 Bifrost v2.3.0 的 logs 表实测（pragma table_info(logs)）。
//   ⚠️ 没有 status_code / is_fallback / requested_model / served_model(恒 NULL)
//   ✅ 有 status('success'|'error') / fallback_index / routing_rule_name / selected_key_name / model

import { DatabaseSync } from 'node:sqlite'

function parseArgs(argv) {
  const out = { db: null, days: 7, errors: false, tier: null, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--db') out.db = argv[++i]
    else if (a === '--days') out.days = Number(argv[++i])
    else if (a === '--errors') out.errors = true
    else if (a === '--tier') out.tier = argv[++i]
    else if (a === '--json') out.json = true
    else if (a === '-h' || a === '--help') out.help = true
    else throw new Error(`未知参数：${a}`)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help || !args.db) {
  console.log(`用法: node served-model.mjs --db <logs.db> [--days N] [--errors] [--tier reeve/<档位>] [--json]`)
  process.exit(args.help ? 0 : 2)
}

const db = new DatabaseSync(args.db, { readOnly: true })

const cutoff = new Date(Date.now() - args.days * 86400_000).toISOString()
const where = [`timestamp >= ?`]
const params = [cutoff]
if (args.tier) {
  where.push(`routing_rule_name = ?`)
  params.push(args.tier)
}
const notImpl = `1=1` // 占位：保持 SQL 片段一致性
const W = where.join(' AND ')

const q = (sql, extra = []) => db.prepare(sql).all(...params, ...extra)

// ① 档位 → 谁真的服务了（按次数）
const byTier = q(`
  SELECT COALESCE(routing_rule_name, '(未走档位)') AS tier,
         provider                                   AS provider,
         model                                      AS served_model,
         selected_key_name                          AS key_name,
         status                                     AS status,
         COUNT(*)                                   AS n
  FROM logs
  WHERE ${W}
  GROUP BY 1,2,3,4,5
  ORDER BY n DESC
  LIMIT 60`)

// ② provider 汇总：谁在扛量、谁的失败全是它撞的
const byProvider = q(`
  SELECT provider                                                        AS provider,
         COUNT(*)                                                        AS total,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)               AS failed,
         SUM(CASE WHEN fallback_index > 0 THEN 1 ELSE 0 END)             AS fell_back,
         ROUND(AVG(latency), 0)                                          AS avg_ms
  FROM logs
  WHERE ${W}
  GROUP BY provider
  ORDER BY total DESC`)

// ③ 回退链：每个档位的第 N 跳打到谁（这是"回退有没有生效"的直接证据）
const chain = q(`
  SELECT COALESCE(routing_rule_name, '(未走档位)') AS tier,
         fallback_index                             AS hop,
         provider                                   AS provider,
         model                                      AS served_model,
         status                                     AS status,
         COUNT(*)                                   AS n
  FROM logs
  WHERE ${W}
  GROUP BY 1,2,3,4,5
  ORDER BY tier, hop, n DESC`)

const failures = args.errors
  ? q(`
      SELECT COALESCE(routing_rule_name, '(未走档位)') AS tier,
             provider                                   AS provider,
             model                                      AS served_model,
             fallback_index                             AS hop,
             COUNT(*)                                   AS n,
             MIN(substr(COALESCE(error_details,''), 1, 160)) AS sample_error
      FROM logs
      WHERE ${W} AND status = 'error'
      GROUP BY 1,2,3,4
      ORDER BY n DESC
      LIMIT 40`)
  : null

if (args.json) {
  // 给"定期快照 / 面板 / 告警"用的投影：带上 generatedAt 与来源，
  // 消费方才能判断这份数据是不是馊的（**唯一能知道"谁真的服务了"的地方就是这里** ——
  // 引擎侧永远只知道档位名，见 proxy/README「归因」一节）。
  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: args.db,
        days: args.days,
        tier: args.tier,
        byTier,
        byProvider,
        chain,
        failures,
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

const table = (title, rows, cols) => {
  console.log(`--- ${title} ---`)
  if (!rows.length) {
    console.log('  （无数据）\n')
    return
  }
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '-').length)))
  console.log('  ' + cols.map((c, i) => c.padEnd(w[i])).join('  '))
  for (const r of rows) console.log('  ' + cols.map((c, i) => String(r[c] ?? '-').padEnd(w[i])).join('  '))
  console.log()
}

console.log(`=== REEVE 代理归因（最近 ${args.days} 天${args.tier ? `，档位 ${args.tier}` : ''}）===`)
console.log(`[来源] ${args.db}\n`)
table('档位 → 谁真的服务了', byTier, ['tier', 'provider', 'served_model', 'key_name', 'status', 'n'])
table('provider 汇总（失败=配额/限流是谁撞的）', byProvider, ['provider', 'total', 'failed', 'fell_back', 'avg_ms'])
table('回退链（每一跳打到谁）', chain, ['tier', 'hop', 'provider', 'served_model', 'status', 'n'])
if (failures) table('失败明细', failures, ['tier', 'provider', 'served_model', 'hop', 'n', 'sample_error'])

console.log('说明：fallback_index=0 是链头；>0 表示链头失败后由第 N 个回退接手。')