#!/usr/bin/env bash
# GATE 真机验收（开发机先跑；对端升级后重跑同一脚本）。
#
#   bash scripts/accept-gate.sh                  # 全跑（含引擎与故障注入）
#   bash scripts/accept-gate.sh --skip-engine    # 只验 ①–③（GATE 面）、⑦（热更）——不碰引擎/不杀 9router
#
# 每条打印一行证据（`PASS/FAIL <编号> <项> — <观测值>`）；任一 FAIL → 退出码 1。
# 编号对齐 docs/GATE.md 的验收清单：
#   ① 9router 健康 + 免费池可见     ② 直连 9router 免费档 200（轮换稳健：多候选任一即可）
#   ③ GATE 面（版本/链/直投链名+响应头/引擎经 GATE 免费链 + 台账）   ④ 故障注入：停 9router → 顺位切付费
#   ⑤ 粘性（同 session 下次从付费起；别的 session 不受影响）        ⑥ 冷却记账可见
#   ⑦ 热更 ≤5s（临时链 → 新序生效 → 还原）                        ⑧ 付费直连不回归
#   ⑨ Bifrost 进程（退役完成前为 INFO）                            ⑩ 对端：升级后重跑本脚本
#
# 真实上游调用口径：免费优先；②③⑤⑦ 各几次最小调用，④⑧ 各一次（④ 含一次付费降级）。
set -u

GATE_URL="${GATE_URL:-http://127.0.0.1:18080}"
NINE_URL="${NINE_URL:-http://127.0.0.1:20128}"
LEDGER="${LEDGER:-$HOME/.reeve/gate.jsonl}"
OC2="${OC2:-$HOME/.local/share/ocrc/opencode2/opencode2.exe}"
SKIP_ENGINE=0
for a in "$@"; do [ "$a" = "--skip-engine" ] && SKIP_ENGINE=1; done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/../plugin" && pwd)"
PLUGIN_DIR_WIN="$(cygpath -w "$PLUGIN_DIR" 2>/dev/null | tr -d '' || echo "$PLUGIN_DIR")"
USER_CFG="${USER_CFG:-$HOME/.config/opencode/reeve/fallback.jsonc}"
TMP="${TMP:-${TEMP:-/tmp}}"
WORK="$TMP/accept-gate.$$"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

fails=0
pass() { echo "PASS $1 $2 — $3"; }
fail() { echo "FAIL $1 $2 — $3"; fails=$((fails + 1)); }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time "$2" "$1" 2>/dev/null || echo 000; }
ledger_lines() { [ -f "$LEDGER" ] && wc -l < "$LEDGER" | tr -d ' ' || echo 0; }

# 直投 GATE：$1=model  $2=session 头(可空)  $3=输出前缀（响应体/头写 $3.body $3.head）；回显 HTTP 码
gate_call() {
  local model="$1" sid="${2:-}" out="$3"
  if [ -n "$sid" ]; then
    curl -sN --max-time 120 -D "$out.head" -o "$out.body" -X POST "$GATE_URL/v1/chat/completions" \
      -H 'content-type: application/json' -H "x-opencode-session-id: $sid" \
      -d "{\"model\":\"$model\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"只回复 ok\"}]}" \
      -w '%{http_code}' 2>/dev/null || echo 000
  else
    curl -sN --max-time 120 -D "$out.head" -o "$out.body" -X POST "$GATE_URL/v1/chat/completions" \
      -H 'content-type: application/json' \
      -d "{\"model\":\"$model\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"只回复 ok\"}]}" \
      -w '%{http_code}' 2>/dev/null || echo 000
  fi
}
fallback_header() { sed -n 's/.*[Xx]-[Rr]eeve-[Ff]allback: *\(.*\)\r*$/\1/p' "$1" | head -1; }

# 9router 停/起（故障注入与还原）——走服务脚本，**全程无窗口**（见 setup-9router.mjs 头注释）
nine_stop() { node "$SCRIPT_DIR/setup-9router.mjs" stop >/dev/null; }
nine_start() { node "$SCRIPT_DIR/setup-9router.mjs" ensure >/dev/null 2>&1 && health_ok; }
health_ok() { [ "$(code "$NINE_URL/api/health" 3)" = 200 ]; }

echo "== GATE 真机验收（${GATE_URL} / 9router ${NINE_URL}）=="

# ── ① 9router 健康 + 免费池可见 ──
h=$(code "$NINE_URL/api/health" 5)
[ "$h" = 200 ] && pass ① "9router 健康" "HTTP $h" || fail ① "9router 健康" "HTTP $h（期望 200；装/起了吗）"
pool=$(curl -s --max-time 6 "$NINE_URL/v1/models" 2>/dev/null | tr ',' '\n' | grep -c 'oc/' || true)
[ "${pool:-0}" -ge 1 ] && pass ①b "免费池可见" "$pool 个 oc/* 模型（池会轮换；②按活体逐个试）" || fail ①b "免费池可见" "没有 oc/* 模型（上游池漂了？）"

# ── ② 直连 9router 免费档：对候选集逐个试，任一 200 且有非空输出即过 ──
# 候选 = /v1/models 里的 oc/* ∪ 已知活体（池轮换：静态表可能只有 region-block 的那几个）。
cands=$( { curl -s --max-time 6 "$NINE_URL/v1/models" 2>/dev/null | tr ',' '\n' | grep -o '"oc/[^"]*"*' | tr -d '"' ; \
           printf 'oc/mimo-v2.6-flash-free\noc/glm-5.3-flash-free\noc/deepseek-v4.1-flash-free\noc/longcat-2.5-preview-free\n'; } | sort -u )
free_ok=""; free_why=""
for m in $cands; do
  c=$(curl -s -o "$WORK/free.body" -w '%{http_code}' --max-time 90 -X POST "$NINE_URL/v1/chat/completions" \
        -H 'content-type: application/json' \
        -d "{\"model\":\"$m\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"只回复 ok\"}]}" 2>/dev/null || echo 000)
  if [ "$c" = 200 ] && grep -q '"content":"[^"]' "$WORK/free.body"; then free_ok="$m"; break; fi
  free_why="$m HTTP $c（$(head -c 100 "$WORK/free.body" | tr -d '\n')）"
done
[ -n "$free_ok" ] && pass ② "直连 9router 免费档" "$free_ok → 200 且有输出" || fail ② "直连 9router 免费档" "所有候选都不通；最后：$free_why"

# ── ③ GATE 面 ──
v=$(curl -s --max-time 5 "$GATE_URL/gate/version" 2>/dev/null | head -c 2000)
echo "$v" | grep -q '"reeve-gate"' && pass ③ "GATE 版本面" "$(echo "$v" | head -c 160)" || fail ③ "GATE 版本面" "读到：$(echo "$v" | head -c 120)"
echo "$v" | grep -q '"chains"' && pass ③b "GATE 有链" "$(echo "$v" | sed -n 's/.*"chains":\[\([^]]*\)\].*/\1/p' | head -c 200)" || fail ③b "GATE 有链" "无 chains 字段"
echo "$v" | grep -q '"problems":\[\]' && pass ③c "配置无 problems" "problems 空" || fail ③c "配置无 problems" "$(echo "$v" | sed -n 's/.*"problems":\(\[[^]]*\]\).*/\1/p' | head -c 160)"
[ -f "$LEDGER" ] && pass ③d "台账存在" "$LEDGER（$(ledger_lines) 行）" || fail ③d "台账存在" "还没有 $LEDGER（跑过一笔请求才有）"

# ③e 直投链名 `reeve/flash`（== 引擎档位模型）：免费档打头
c=$(gate_call "reeve/flash" "" "$WORK/chain")
fb=$(fallback_header "$WORK/chain.head")
if [ "$c" = 200 ] && [ -n "$fb" ]; then pass ③e "直投 GATE 链（reeve/flash）" "HTTP $c，x-reeve-fallback: $fb"; else fail ③e "直投 GATE 链（reeve/flash）" "HTTP $c，头：$(head -c 120 "$WORK/chain.head" | tr -d '\r\n')"; fi

if [ "$SKIP_ENGINE" = 1 ]; then
  echo "（--skip-engine：跳过 ③f / ④ / ⑤ / ⑥ / ⑧ 的引擎与故障注入步骤）"
else
  # ── ③f 引擎真身经 GATE 拿免费链（-m reeve/flash → free-first → 9router 免费档）──
  b=$(ledger_lines)
  out=$(cd "$SCRIPT_DIR/.." && timeout 180 "$OC2" run --title accept-gate-free -m reeve/flash "只回复两个字：ok" 2>&1 | tail -3 | tr -d '\r')
  tail -n "+$((b + 1))" "$LEDGER" >"$WORK/rows.jsonl" 2>/dev/null || true
  if echo "$out" | grep -q 'ok' && grep -q '"chain":"free-first"' "$WORK/rows.jsonl" && grep -q '"status":"ok"' "$WORK/rows.jsonl"; then
    pass ③f "引擎经 GATE 免费链" "$(echo "$out" | tail -1) ｜ 台账：$(grep -o '"provider":"[^"]*","model":"[^"]*","lane":"[^"]*","key":[^,]*,"status":"[^"]*"' "$WORK/rows.jsonl" | head -1)"
  else
    fail ③f "引擎经 GATE 免费链" "输出：$(echo "$out" | tail -1 | head -c 120) ｜ 新台账：$(head -c 200 "$WORK/rows.jsonl")"
  fi

  # ── ④ 故障注入：停 9router → 同一条链顺位切付费候选 ──
  nine_stop
  b=$(ledger_lines)
  out=$(cd "$SCRIPT_DIR/.." && timeout 240 "$OC2" run --title accept-gate-downgrade -m reeve/flash "只回复两个字：ok" 2>&1 | tail -3 | tr -d '\r')
  tail -n "+$((b + 1))" "$LEDGER" >"$WORK/rows4.jsonl" 2>/dev/null || true
  err9=$(grep -c '"provider":"9router".*"status":"error"' "$WORK/rows4.jsonl" || true)
  okpaid=$(grep -c '"status":"ok"' "$WORK/rows4.jsonl" || true)
  if echo "$out" | grep -q 'ok' && [ "${err9:-0}" -ge 1 ] && [ "${okpaid:-0}" -ge 1 ]; then
    pass ④ "故障注入顺位切付费" "$(echo "$out" | tail -1) ｜ 台账 9router 失败 ${err9} 行 → 付费成功 ${okpaid} 行：$(grep -o '"provider":"[^"]*","model":"[^"]*","lane":"[^"]*","key":[^,]*,"status":"[^"]*","code":[^,]*' "$WORK/rows4.jsonl" | tr '\n' ' ' | head -c 220)"
  else
    fail ④ "故障注入顺位切付费" "输出：$(echo "$out" | tail -1 | head -c 120) ｜ 新台账：$(head -c 240 "$WORK/rows4.jsonl" | tr -d '\n')"
  fi
  nine_start && echo "（④ 已还原 9router：健康 200）" || fail ④b "9router 还原" "40s 没起来；看 ~/.9router/ocrc/9router.log"

  # ── ⑤ 粘性：session A 首访失败后钉在付费候选；session B（新）不受 A 影响 ──
  A="ses_accept_sticky_$$_a"; B="ses_accept_sticky_$$_b"
  # 构造确定的"首访必失败"：临时配置里加一个必然连不上的 provider（127.0.0.1:1 → 立刻 refuse）
  # 与临时链 [accept-dead/x, zhipuai-paid]；A 跑两次、B 跑一次，之后还原配置。
  cp -f "$USER_CFG" "$WORK/cfg.bak"
  node --input-type=module -e "
    import { readFileSync, writeFileSync } from 'node:fs'
    import { join } from 'node:path'
    import { pathToFileURL } from 'node:url'
    const { stripLineComments } = await import(pathToFileURL(join(process.argv[2], 'src', 'gate', 'config.js')).href)
    const p = process.argv[1]
    const j = JSON.parse(stripLineComments(readFileSync(p, 'utf8')))
    j.providers['accept-dead'] = { base_url: 'http://127.0.0.1:1', key: 'none', models: ['*'] }
    j.chains['accept-sticky'] = { targets: ['accept-dead/x', 'zhipuai-coding-plan/glm-5.3-flash'] }
    writeFileSync(p, JSON.stringify(j, null, 2))
  " "$USER_CFG" "$PLUGIN_DIR_WIN"
  sleep 6   # 热更窗口（≤5s）+ 余量
  gate_call "accept-sticky" "$A" "$WORK/sticky1" >/dev/null
  b=$(ledger_lines)
  gate_call "accept-sticky" "$A" "$WORK/sticky2" >/dev/null
  tail -n "+$((b + 1))" "$LEDGER" >"$WORK/rows5a.jsonl" 2>/dev/null || true
  b=$(ledger_lines)
  gate_call "accept-sticky" "$B" "$WORK/sticky3" >/dev/null
  tail -n "+$((b + 1))" "$LEDGER" >"$WORK/rows5b.jsonl" 2>/dev/null || true
  cp -f "$WORK/cfg.bak" "$USER_CFG"
  sleep 6
  a_second=$(fallback_header "$WORK/sticky2.head")
  b_err=$(grep -c '"provider":"accept-dead".*"status":"error"' "$WORK/rows5b.jsonl" || true)
  if echo "$a_second" | grep -q '^1/zhipuai-coding-plan' && [ "${b_err:-0}" -ge 1 ]; then
    pass ⑤ "粘性（按 session）" "同 session 第二次：x-reeve-fallback: $a_second（跳过失败候选）；新 session：仍试了候选1（台账 accept-dead 失败 ${b_err} 行）"
  else
    fail ⑤ "粘性（按 session）" "同 session 第二次头：${a_second:-无}（期望 1/zhipuai…）；新 session 候选1失败行：${b_err:-0}"
  fi

  # ── ⑥ 冷却记账可见（策略：cooldown_seconds=60；restore_primary_after_cooldown=false）──
  cool=$(curl -s --max-time 5 "$GATE_URL/gate/version" 2>/dev/null | sed -n 's/.*"cooling":\([0-9]*\).*/\1/p')
  [ "${cool:-0}" -ge 1 ] && pass ⑥ "冷却记账可见" "cooling=${cool}（失败候选在 60s 冷却窗口内）" || fail ⑥ "冷却记账可见" "cooling=${cool:-?}（期望 ≥1；⑤ 的失败候选应在冷却里）"

  # ── ⑧ 付费直连不回归（引擎 → 原生 provider，不过 GATE）──
  out2=$(cd "$SCRIPT_DIR/.." && timeout 180 "$OC2" run --title accept-gate-paid -m zhipuai-coding-plan/glm-5.3-flash "只回复两个字：ok" 2>&1 | tail -3 | tr -d '\r')
  echo "$out2" | grep -q 'ok' && pass ⑧ "直连付费档" "$(echo "$out2" | tail -1)" || fail ⑧ "直连付费档" "$(echo "$out2" | tail -1 | head -c 160)"
fi

# ── ⑦ 热更 ≤5s：临时链 → 新序生效 → 还原（不碰引擎的 GATE 直投）──
cp -f "$USER_CFG" "$WORK/cfg7.bak"
node --input-type=module -e "
  import { readFileSync, writeFileSync } from 'node:fs'
  import { join } from 'node:path'
  import { pathToFileURL } from 'node:url'
  const { stripLineComments } = await import(pathToFileURL(join(process.argv[2], 'src', 'gate', 'config.js')).href)
  const p = process.argv[1]
  const j = JSON.parse(stripLineComments(readFileSync(p, 'utf8')))
  j.chains['accept-order'] = { targets: ['zhipuai-coding-plan/glm-5.3-flash', '9router/oc/mimo-v2.6-flash-free'] }
  writeFileSync(p, JSON.stringify(j, null, 2))
" "$USER_CFG" "$PLUGIN_DIR_WIN"
t0=$(date +%s)
seen=0
for i in $(seq 1 10); do
  if curl -s --max-time 3 "$GATE_URL/gate/version" 2>/dev/null | grep -q 'accept-order'; then seen=1; break; fi
  sleep 1
done
t1=$(date +%s)
c=$(gate_call "accept-order" "" "$WORK/reload")
fb7=$(fallback_header "$WORK/reload.head")
cp -f "$WORK/cfg7.bak" "$USER_CFG"
if [ "$seen" = 1 ] && [ "$c" = 200 ] && echo "$fb7" | grep -q '^1/zhipuai-coding-plan'; then
  pass ⑦ "热更 ≤5s（文件改 → 新序生效）" "$((t1 - t0))s 后新链可见；x-reeve-fallback: $fb7（付费打头=新序）"
else
  fail ⑦ "热更 ≤5s（文件改 → 新序生效）" "seen=$seen $((t1 - t0))s；HTTP $c；头：${fb7:-无}"
fi

# ── ⑨ Bifrost 已退役：进程必须是 0（拆完之后这条是硬断言，不再是 INFO）──
if command -v tasklist >/dev/null 2>&1; then
  bf=$(tasklist //FI "IMAGENAME eq bifrost-http.exe" //FO CSV 2>/dev/null | grep -c bifrost || true)
else
  bf=$(pgrep -fc 'bifrost-http' 2>/dev/null || true)   # Linux 对端：按进程名数
fi
[ "${bf:-0}" -eq 0 ] && pass ⑨ "Bifrost 进程 = 0" "进程表里没有 bifrost-http（代理层只剩 GATE）" || fail ⑨ "Bifrost 进程 = 0" "还有 ${bf} 个 bifrost-http 在跑（旧层没清干净）"
if [ -d "$HOME/.reeve/proxy" ]; then echo "INFO ⑨b ~/.reeve/proxy 还在（$(ls "$HOME/.reeve/proxy" | tr '\n' ' ' | head -c 80)）—— 机器上的旧工件，删掉不影响运行"; fi

echo
if [ "$fails" -eq 0 ]; then echo "accept-gate: 全过"; else echo "accept-gate: $fails 项失败"; fi
exit "$fails"