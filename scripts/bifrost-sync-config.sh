#!/usr/bin/env bash
# Bifrost 配置收敛：把 `config.json`（声明式期望态）同步到**运行中的** Bifrost。
#
#   bash bifrost-sync-config.sh --app-dir /home/demo/.reeve-staging/bifrost --port 18080 --apply
#   bash bifrost-sync-config.sh --app-dir ... --port 18080 --check     # 只报漂移，不改（漂移时退出码 2）
#   ... --apply --prune                                                # 额外删掉文件里没有的规则
#
# 为什么需要它（2026-10-19 在 EL7 上实测出的语义，四条都有实验证据）：
#   1. **运行时真相在 Bifrost 的 DB 里，不在文件里**。热改（管理 API）会持久化 —— 重启后仍在。
#   2. `config.json` 只在启动时做一次 **upsert**：它含有的条目按 `id` 覆盖/写入；**删不掉** DB 里多出来的行。
#      （实验：把整条 rule 从文件里删掉 → 重启 → 规则仍在运行时列表里。）
#   3. ⚠️ **`POST /api/routing/rules` 是"新建"不是"更新"**：拿一条已有规则的完整对象 POST，
#      会多出一条**同名**规则（服务端给它生成 UUID id），两条都 enabled。改要用 `PUT /<id>`。
#   4. 所以"改文件 + 重启"能加能改、**不能删**，而且会把 API 侧造的重复规则留下来。
#      → 本脚本是让文件重新成为唯一真相的那一步：**收敛**而不是"改完重启"。
#
# 失败模式一律吵：HTTP 非 2xx 就打印状态码与响应体并退出非零。
set -euo pipefail
export PYTHONIOENCODING=utf-8   # EL7 的 python3.6 stdout 默认 ascii

APP_DIR=${BIFROST_APP_DIR:-$HOME/.config/bifrost}
PORT=8080
MODE=apply
PRUNE=0
CONFIG=

while [ $# -gt 0 ]; do
  case "$1" in
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --config) CONFIG="$2"; shift 2 ;;
    --check) MODE=check; shift ;;
    --apply) MODE=apply; shift ;;
    --prune) PRUNE=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$1"; exit 1 ;;
  esac
done
[ -n "$CONFIG" ] || CONFIG="$APP_DIR/config.json"

# setup token：优先 env 文件（600），其次环境变量
if [ -f "$APP_DIR/env" ]; then set -a; . "$APP_DIR/env"; set +a; fi
[ -n "${BIFROST_SETUP_TOKEN:-}" ] || { echo "缺 BIFROST_SETUP_TOKEN（$APP_DIR/env 或环境变量）"; exit 1; }

BASE="http://127.0.0.1:${PORT}"
echo "app-dir   = $APP_DIR"
echo "config    = $CONFIG"
echo "api       = $BASE"
echo "mode      = $MODE$([ "$PRUNE" = 1 ] && echo ' + prune' || true)"

export BIF_BASE="$BASE" BIF_TOKEN="$BIFROST_SETUP_TOKEN" BIF_CONFIG="$CONFIG" BIF_MODE="$MODE" BIF_PRUNE="$PRUNE"

python3 - <<'PY'
import json, os, sys, urllib.error, urllib.request

BASE = os.environ["BIF_BASE"]; TOKEN = os.environ["BIF_TOKEN"]
CONFIG = os.environ["BIF_CONFIG"]; MODE = os.environ["BIF_MODE"]; PRUNE = os.environ["BIF_PRUNE"] == "1"
HDR = {"X-Bifrost-Setup-Token": TOKEN, "Content-Type": "application/json"}

def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, headers=HDR, method=method,
                                 data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode("utf-8", "replace")
            return r.status, (json.loads(raw) if raw.strip().startswith(("{", "[")) else raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        return e.code, raw
    except Exception as e:
        return 0, str(e)

desired_all = json.load(open(CONFIG, encoding="utf-8"))
desired = desired_all.get("governance", {}).get("routing_rules") or []
if not desired:
    print("  ⚠️ 文件里没有 routing_rules —— 什么都不做（这可能是配置写错了）")
    sys.exit(1)
DESIRED = {r["id"]: r for r in desired}

SERVER_FIELDS = ("config_hash", "created_at", "updated_at", "chain_rule")
def clean(rule):
    return {k: v for k, v in rule.items() if k not in SERVER_FIELDS}

status, rules_resp = call("GET", "/api/routing/rules")
if status != 200:
    print("  ❌ 读运行时规则失败：HTTP %s %s" % (status, rules_resp)); sys.exit(1)
RUNTIME = {r["id"]: r for r in rules_resp.get("rules", [])}

FIELDS = ("name", "cel_expression", "enabled", "targets", "fallbacks", "priority", "scope", "description")
def same(a, b):
    return all(json.dumps(a.get(k), sort_keys=True) == json.dumps(b.get(k), sort_keys=True) for k in FIELDS)

problems, actions = [], []

# ---- 缺失 → 建；有差异 → 改 ----
for rid, want in sorted(DESIRED.items()):
    have = RUNTIME.get(rid)
    if have is None:
        actions.append(("create", rid, None))
        continue
    if not same(have, want):
        diff = [k for k in FIELDS if json.dumps(have.get(k), sort_keys=True) != json.dumps(want.get(k), sort_keys=True)]
        actions.append(("update", rid, diff))

# ---- 多余 → 报（或 prune 掉）----
extra = sorted(set(RUNTIME) - set(DESIRED))
for rid in extra:
    r = RUNTIME[rid]
    actions.append(("prune" if PRUNE else "extra", rid, r.get("name")))

deviation = [a for a in actions if a[0] in ("create", "update")]
drift = [a for a in actions if a[0] in ("extra", "prune")]

# ---- 提供者漂移（只报不改：provider 含密钥与连接参数，改它们要重启，见 README）----
prov_status, prov_resp = call("GET", "/api/providers")
prov_note = ""
if prov_status == 200:
    ids = prov_resp.get("providers") if isinstance(prov_resp, dict) else None
    runtime_ids = sorted(p.get("name") or p.get("id") for p in ids) if isinstance(ids, list) else \
                  sorted((prov_resp.get("providers") or {}).keys()) if isinstance(prov_resp, dict) and isinstance(prov_resp.get("providers"), dict) else []
    file_ids = sorted(desired_all.get("providers", {}).keys())
    if runtime_ids:
        missing = [p for p in file_ids if p not in runtime_ids]
        present = [p for p in runtime_ids if p not in file_ids]
        if missing or present:
            prov_note = "  额外: %s | 文件有而运行时没有: %s" % (present or "无", missing or "无")
            problems.append("providers 漂移")

print("  声明规则 %d 条：%s" % (len(DESIRED), ", ".join(sorted(DESIRED))))
print("  运行时规则 %d 条" % len(RUNTIME))
if not actions:
    print("  ✅ 规则已收敛（无差异）")
if deviation:
    print("  需要同步：")
    for kind, rid, diff in deviation:
        print("   - %-6s %s %s" % (kind, rid, ("差异字段 " + ",".join(diff)) if diff else ""))
if drift:
    print("  ⚠️ 运行时多出的规则（文件里没有）：")
    for kind, rid, name in drift:
        print("   - %s %s（name=%s）" % (kind, rid, name))
if prov_note:
    print("  ⚠️ providers 漂移：" + prov_note)

if MODE == "check":
    if deviation or drift or problems:
        print("  → --check：有漂移（退出码 2）")
        sys.exit(2)
    sys.exit(0)

# ---- 施加 ----
failed = 0
for kind, rid, diff in deviation:
    want = clean(DESIRED[rid])
    if kind == "create":
        st, resp = call("POST", "/api/routing/rules", want)
    else:
        st, resp = call("PUT", "/api/routing/rules/" + rid, want)
    ok = isinstance(st, int) and 200 <= st < 300
    print("  %s %s -> HTTP %s%s" % ("建" if kind == "create" else "改", rid, st, "" if ok else " " + str(resp)[:160]))
    failed += 0 if ok else 1

if PRUNE:
    for kind, rid, name in drift:
        st, resp = call("DELETE", "/api/routing/rules/" + rid)
        ok = isinstance(st, int) and 200 <= st < 300
        print("  删 %s（%s）-> HTTP %s%s" % (rid, name, st, "" if ok else " " + str(resp)[:160]))
        failed += 0 if ok else 1

# ---- 复查 ----
status, rules_resp = call("GET", "/api/routing/rules")
if status == 200:
    after = {r["id"]: r for r in rules_resp.get("rules", [])}
    left = [rid for rid, want in DESIRED.items() if rid not in after or not same(after[rid], want)]
    extra_left = sorted(set(after) - set(DESIRED)) if PRUNE else []
    if left or extra_left:
        print("  ❌ 复查仍有差异：%s%s" % (left, (" 多余 " + str(extra_left)) if extra_left else ""))
        sys.exit(1)
    print("  ✅ 复查通过：运行时与文件一致（%d 条规则）" % len(after))
else:
    print("  ⚠️ 复查读不到：HTTP %s" % status); sys.exit(1)

if problems:
    print("  ⚠️ 注意：providers 的差异不在本脚本的收敛范围内（改它们要改文件 + 重启，见 proxy/README.md）")
PY