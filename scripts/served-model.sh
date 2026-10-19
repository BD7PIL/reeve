#!/usr/bin/env bash
# 归因查询：这 196 次 quota 错误分别是哪个 provider 撞的？
#
# 为什么需要它：opencode 永远看不到"谁真的服务了这次请求"——
# 响应模型名不捕获、响应头也被丢弃（opencode#26091）。所以归因只能在代理侧做。
# Bifrost 把实际服务的模型落成 logs 表的 served_model 列。
#
# 用法：
#   ./served-model.sh                      # 最近 7 天的归因汇总
#   ./served-model.sh --days 30            # 换时间窗
#   ./served-model.sh --errors             # 只看失败/回退的请求
#   ./served-model.sh --model reeve/pro    # 只看某个档位
#
# 环境变量：
#   REEVE_BIFROST_APP_DIR   默认 ~/.reeve/bifrost（logs.db 在这里）
#   REEVE_BIFROST_URL       默认 http://127.0.0.1:8080（sqlite3 不可用时走 /api/logs）

set -euo pipefail

APP_DIR="${REEVE_BIFROST_APP_DIR:-$HOME/.reeve/bifrost}"
BASE_URL="${REEVE_BIFROST_URL:-http://127.0.0.1:8080}"
DB="$APP_DIR/logs.db"

DAYS=7
ONLY_ERRORS=0
MODEL_FILTER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --days)   DAYS="$2"; shift 2 ;;
    --errors) ONLY_ERRORS=1; shift ;;
    --model)  MODEL_FILTER="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

WHERE="created_at >= datetime('now', '-${DAYS} days')"
[ -n "$MODEL_FILTER" ] && WHERE="$WHERE AND (requested_model = '${MODEL_FILTER}' OR model = '${MODEL_FILTER}')"

echo "=== REEVE 代理归因（最近 ${DAYS} 天）==="
echo

if command -v sqlite3 >/dev/null 2>&1 && [ -f "$DB" ]; then
  # ---- 首选：直接读 SQLite ----
  echo "[来源] $DB"
  echo

  echo "--- 档位 → 实际服务的模型 / provider（按次数）---"
  sqlite3 -header -column "$DB" "
    SELECT
      COALESCE(requested_model, model)      AS 档位,
      COALESCE(served_model, model)         AS 实际服务,
      provider                              AS provider,
      COUNT(*)                              AS 次数
    FROM logs
    WHERE $WHERE
    GROUP BY 1,2,3
    ORDER BY 次数 DESC
    LIMIT 50;"
  echo

  if [ "$ONLY_ERRORS" = "1" ]; then
    echo "--- 失败请求（含回退）---"
    sqlite3 -header -column "$DB" "
      SELECT
        COALESCE(requested_model, model) AS 档位,
        COALESCE(served_model, model)    AS 实际服务,
        provider,
        COALESCE(status_code, 0)         AS 状态码,
        COUNT(*)                         AS 次数
      FROM logs
      WHERE $WHERE
        AND (COALESCE(status_code,0) >= 400 OR COALESCE(is_fallback,0) = 1)
      GROUP BY 1,2,3,4
      ORDER BY 次数 DESC
      LIMIT 50;"
    echo
  fi

  echo "--- 按 provider 汇总（谁在扛量、谁在撞墙）---"
  sqlite3 -header -column "$DB" "
    SELECT
      provider,
      COUNT(*)                                              AS 总请求,
      SUM(CASE WHEN COALESCE(status_code,0) >= 400 THEN 1 ELSE 0 END) AS 失败,
      SUM(CASE WHEN COALESCE(is_fallback,0) = 1 THEN 1 ELSE 0 END)    AS 回退
    FROM logs
    WHERE $WHERE
    GROUP BY provider
    ORDER BY 总请求 DESC;"
  echo
  echo "提示：'失败' 那一列就是「配额耗尽/限流到底是谁撞的」的答案。"

else
  # ---- 退路：走 /api/logs（EL7 上可能没有 sqlite3）----
  echo "[来源] $BASE_URL/api/logs （本机没有 sqlite3 或 logs.db 不存在）"
  echo
  if command -v curl >/dev/null 2>&1; then
    curl -sS --max-time 20 "$BASE_URL/api/logs?limit=500" | head -c 4000
    echo
    echo
    echo "提示：这个端点的完整字段与分页参数请以 Bifrost 文档为准；"
    echo "      要精确聚合，建议在被控端装一个 sqlite3 直接读 $DB。"
  else
    echo "本机既没有 sqlite3 也没有 curl —— 无法查询。" >&2
    exit 1
  fi
fi
