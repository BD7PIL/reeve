#!/usr/bin/env bash
# REEVE 归因查询：这 196 次 quota 错误分别是哪个 provider 撞的？
#
# 为什么需要它：opencode 永远看不到"谁真的服务了这次请求"——
# 响应模型名不捕获、响应头也被丢弃（opencode#26091）。所以归因只能在代理侧做。
#
# 用法：
#   ./served-model.sh                          # 最近 7 天的归因汇总
#   ./served-model.sh --days 30                # 换时间窗
#   ./served-model.sh --errors                 # 只看失败的请求（含样本错误）
#   ./served-model.sh --tier reeve/pro         # 只看某个档位
#   ./served-model.sh --json                   # 给机器读
#
# 环境变量：
#   REEVE_BIFROST_APP_DIR     默认 ~/.reeve/bifrost（logs.db 在这里）
#   REEVE_BIFROST_URL         默认 http://127.0.0.1:8080（退路：/api/logs）
#   REEVE_BIFROST_SETUP_TOKEN 走 /api/logs 退路时必需
#   REEVE_NODE                指定 node 可执行文件（需支持 node:sqlite，即 Node >= 22.5）
#
# ⚠️ 为什么不用 sqlite3：Bifrost 的库有**部分索引**，需要 SQLite >= 3.8。
#    EL7 自带 3.7.17，`sqlite3 logs.db` 直接报 `malformed database schema`（实测）。
#    所以这里优先找能跑 node:sqlite 的 node，最后才退到 /api/logs。

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

APP_DIR="${REEVE_BIFROST_APP_DIR:-$HOME/.reeve/bifrost}"
BASE_URL="${REEVE_BIFROST_URL:-http://127.0.0.1:8080}"
DB="$APP_DIR/logs.db"

find_node() {
  # 1) 显式指定
  if [ -n "${REEVE_NODE:-}" ] && [ -x "${REEVE_NODE}" ]; then echo "$REEVE_NODE"; return; fi
  # 2) PATH 上的 node（要能 require node:sqlite）
  for c in node nodejs; do
    if command -v "$c" >/dev/null 2>&1; then
      if "$c" -e 'require("node:sqlite")' >/dev/null 2>&1; then echo "$c"; return; fi
    fi
  done
  # 3) 本机常见的新版 node（ocrc 的运行时就带 Node 24）
  for c in "$HOME"/.ocrc/remote/runtime/node-v*/bin/node \
           /usr/local/bin/node /opt/node/bin/node; do
    [ -x "$c" ] || continue
    if "$c" -e 'require("node:sqlite")' >/dev/null 2>&1; then echo "$c"; return; fi
  done
  echo ""
}

NODE_BIN="$(find_node)"

if [ -n "$NODE_BIN" ] && [ -f "$DB" ]; then
  exec "$NODE_BIN" "$HERE/served-model.mjs" --db "$DB" "$@"
fi

# ---- 退路：走 /api/logs ----
echo "[来源] $BASE_URL/api/logs"
if [ -n "$NODE_BIN" ]; then
  echo "  ⚠️ 找到了可用的 node（$NODE_BIN），但 $DB 不存在 —— 检查 REEVE_BIFROST_APP_DIR"
else
  echo "  ⚠️ 本机没有支持 node:sqlite 的 node（需要 Node >= 22.5）"
fi
echo

if [ -z "${REEVE_BIFROST_SETUP_TOKEN:-}" ]; then
  echo "  需要 REEVE_BIFROST_SETUP_TOKEN 才能读 /api/logs（否则 401）。" >&2
  echo "  精确聚合仍建议在被控端用 node:sqlite 直读 $DB。" >&2
  exit 1
fi

LIMIT=200
curl -sS --max-time 20 -H "X-Bifrost-Setup-Token: $REEVE_BIFROST_SETUP_TOKEN" \
  "$BASE_URL/api/logs?limit=$LIMIT" \
| "$NODE_BIN" -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
  let d; try { d=JSON.parse(s) } catch(e){ console.log("响应不是 JSON：", s.slice(0,300)); process.exit(1) }
  const rows = d.logs || d.data || [];
  const agg = new Map();
  for (const r of rows) {
    const tier = r.routing_rule_name || r.alias || r.model || "(未知)";
    const k = `${tier} | ${r.provider} | ${r.model} | status=${r.status} | hop=${r.fallback_index}`;
    agg.set(k, (agg.get(k)||0)+1);
  }
  console.log(`  最近 ${rows.length} 条：`);
  for (const [k,v] of [...agg.entries()].sort((a,b)=>b[1]-a[1])) console.log(`    ${v.toString().padStart(5)}  ${k}`);
  console.log();
  console.log("  提示：/api/logs 有分页上限，精确聚合请在被控端用 node:sqlite 直读 logs.db。");
})'