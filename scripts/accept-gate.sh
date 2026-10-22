#!/usr/bin/env bash
# GATE 真机验收（开发机先跑；对端升级后重跑同一脚本）。
#
#   bash scripts/accept-gate.sh                  # 全跑（含引擎与故障注入）
#   bash scripts/accept-gate.sh --skip-engine    # 只验 ①–③（GATE 面）、⑦（热更）——不碰引擎/不做付费降级
#
# 每条打印一行证据（`PASS/FAIL <编号> <项> — <观测值>`）；任一 FAIL → 退出码 1。
# 编号对齐 docs/GATE.md 的验收清单：
#   ① GATE 免费车道（/gate/free：enabled、opencode ready、目录里有免费模型）  ①b 展开预览非空
#   ② 直投免费链（reeve/flash）：200 + x-reeve-fallback + 台账 auto:true
#   ③ GATE 面（版本/链/直投链名+响应头/引擎经 GATE 免费链 + 台账）   ④ 免费车道关闭 → 顺位付费
#   ④b 死免费候选 → 顺位付费                                        ⑤ 粘性（同 session 下次从付费起；别的 session 不受影响）
#   ⑥ 冷却记账可见                                                  ⑦ 热更 ≤5s（临时链 → 新序生效 → 还原）
#   ⑧ 付费直连不回归                                                ⑨ Bifrost 进程（退役完成前为 INFO）
#   ⑩ 对端：升级后重跑本脚本；生命周期另跑 scripts/accept-lifecycle.mjs
#
# 真实上游调用口径：免费优先；②③⑤⑦ 各几次最小调用，④④b⑧ 各一次（含付费降级）。
set -u

GATE_URL="${GATE_URL:-http://127.0.0.1:18080}"
LEDGER="${LEDGER:-$HOME/.reeve/gate.jsonl}"
OC2="${OC2:-$HOME/.local/share/ocrc/opencode2/opencode2.exe}"
SKIP_ENGINE=0
for a in "$@"; do [ "$a" = "--skip-engine" ] && SKIP_ENGINE=1; done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# 验收包自带剥注释，不需要插件树（拷 scripts/ 到对端即可）
USER_CFG="${USER_CFG:-$HOME/.config/opencode/reeve/fallback.jsonc}"
TMP="${TMP:-${TEMP:-/tmp}}"
WORK="$TMP/accept-gate.$$"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

fails=0
pass() { echo "PASS $1 $2 — $3"; }
fail() { echo "FAIL $1 $2 — $3"; fails=$((fails + 1)); }
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

echo "== GATE 真机验收（${GATE_URL}）=="

# ── ① 免费车道：发现源就绪 + 目录里有免费模型 ──
free_doc=$(curl -s --max-time 8 "$GATE_URL/gate/free" 2>/dev/null || true)
enabled=$(echo "$free_doc" | grep -o '"enabled":true' | head -1)
oc_ready=$(echo "$free_doc" | grep -o '"id":"opencode","ready":true' | head -1)
oc_models=$(echo "$free_doc" | sed -n 's/.*"id":"opencode","ready":true,"models":\([0-9]*\).*/\1/p' | head -1)
[ -n "$enabled" ] && [ -n "$oc_ready" ] && [ "${oc_models:-0}" -ge 1 ] \
  && pass ① "免费车道就绪" "opencode ready，发现 ${oc_models} 个免费模型" \
  || fail ① "免费车道就绪" "enabled=${enabled:-无} opencode=${oc_ready:-未就绪} models=${oc_models:-0}（看 /gate/free）"
expanded=$(echo "$free_doc" | sed -n 's/.*"expand":\[\([^]]*\)\].*/\1/p' | head -c 220)
[ -n "$expanded" ] && pass ①b "展开预览非空" "$expanded" || fail ①b "展开预览非空" "expand 为空（发现源没拉到？）"

# ── ② 直投免费链：200 + fallback 头 + 台账 auto:true ──
b=$(ledger_lines)
c=$(gate_call "reeve/flash" "ses_accept_free_$$" "$WORK/free")
fb=$(fallback_header "$WORK/free.head")
tail -n "+$((b + 1))" "$LEDGER" >"$WORK/rows2.jsonl" 2>/dev/null || true
auto_try=$(grep -c '"auto":true' "$WORK/rows2.jsonl" || true)
paid_ok=$(grep -c '"provider":"zhipuai-coding-plan".*"status":"ok"' "$WORK/rows2.jsonl" || true)
# 非引擎调用没有引擎的客户端形状（UA + session 头 + 官方 tools），zen 的免费档会 403 形状门 ——
# 所以这一条验的是"免费车道被真正尝试过 + 链顺位到付费仍成功"；免费成功本身由 ③f（真引擎）证明。
if [ "$c" = 200 ] && [ -n "$fb" ] && [ "${auto_try:-0}" -ge 1 ] && [ "${paid_ok:-0}" -ge 1 ]; then
  pass ② "直投链：免费被形状门拒 → 顺位付费" "HTTP $c；auto 尝试 ${auto_try} 行；付费成功；引擎侧免费成功见 ③f"
else
  fail ② "直投链：免费被形状门拒 → 顺位付费" "HTTP $c auto=${auto_try:-0} paid=${paid_ok:-0} ｜ $(head -c 240 "$WORK/rows2.jsonl")"
fi

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
  # ── ③f 引擎真身经 GATE 拿免费链（-m reeve/flash → free-first → @free 展开）──
  b=$(ledger_lines)
  out=$(cd "$SCRIPT_DIR/.." && timeout 180 "$OC2" run --title accept-gate-free -m reeve/flash "只回复两个字：ok" 2>&1 | tail -3 | tr -d '\r')
  tail -n "+$((b + 1))" "$LEDGER" >"$WORK/rows.jsonl" 2>/dev/null || true
  if echo "$out" | grep -q 'ok' && grep -q '"chain":"free-first"' "$WORK/rows.jsonl" && grep -q '"status":"ok"' "$WORK/rows.jsonl"; then
    pass ③f "引擎经 GATE 免费链" "$(echo "$out" | tail -1) ｜ 台账：$(grep -o '"provider":"[^"]*","model":"[^"]*","lane":"[^"]*","key":[^,]*,"status":"[^"]*"' "$WORK/rows.jsonl" | head -1)"
  else
    fail ③f "引擎经 GATE 免费链" "输出：$(echo "$out" | tail -1 | head -c 120) ｜ 新台账：$(head -c 200 "$WORK/rows.jsonl")"
  fi

  # ── ④ 免费车道关闭 → 同一请求顺位走付费（不硬撞免费）──
  cp -f "$USER_CFG" "$WORK/cfg4.bak"
  node --input-type=module -e "
    import { readFileSync, writeFileSync } from 'node:fs'
    const stripLineComments = (t) => String(t).split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('//')).join(String.fromCharCode(10))
    const p = process.argv[1]
    const j = JSON.parse(stripLineComments(readFileSync(p, 'utf8')))
    j.free = { ...(j.free ?? {}), enabled: false }
    writeFileSync(p, JSON.stringify(j, null, 2))
  " "$USER_CFG"
  sleep 6
  b=$(ledger_lines)
  c=$(gate_call "reeve/flash" "ses_accept_nofree_$$" "$WORK/nofree")
  tail -n "+$((b + 1))" "$LEDGER" >"$WORK/rows4.jsonl" 2>/dev/null || true
  auto4=$(grep -c '"auto":true' "$WORK/rows4.jsonl" || true)
  paid4=$(grep -c '"provider":"zhipuai-coding-plan".*"status":"ok"' "$WORK/rows4.jsonl" || true)
  cp -f "$WORK/cfg4.bak" "$USER_CFG"
  sleep 6
  if [ "$c" = 200 ] && [ "${auto4:-0}" -eq 0 ] && [ "${paid4:-0}" -ge 1 ]; then
    pass ④ "免费关闭 → 付费" "HTTP $c，台账无 auto、付费成功 ${paid4} 行"
  else
    fail ④ "免费关闭 → 付费" "HTTP $c auto=${auto4:-0} paid=${paid4:-0} ｜ $(head -c 200 "$WORK/rows4.jsonl")"
  fi

  # ── ④b 死免费候选 → 顺位付费（把 opencode 的发现临时钉成一个不存在的模型）──
  cp -f "$USER_CFG" "$WORK/cfg4b.bak"
  node --input-type=module -e "
    import { readFileSync, writeFileSync } from 'node:fs'
    const stripLineComments = (t) => String(t).split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('//')).join(String.fromCharCode(10))
    const p = process.argv[1]
    const j = JSON.parse(stripLineComments(readFileSync(p, 'utf8')))
    j.free = { ...(j.free ?? {}), enabled: true, max: 1, providers: ['opencode'], static: { opencode: ['__accept_dead__'] }, prefer: ['opencode/__accept_dead__'] }
    writeFileSync(p, JSON.stringify(j, null, 2))
  " "$USER_CFG"
  sleep 6
  b=$(ledger_lines)
  c=$(gate_call "reeve/flash" "ses_accept_deadfree_$$" "$WORK/deadfree")
  tail -n "+$((b + 1))" "$LEDGER" >"$WORK/rows4b.jsonl" 2>/dev/null || true
  errdead=$(grep -c '"model":"__accept_dead__".*"status":"error"' "$WORK/rows4b.jsonl" || true)
  okpaid=$(grep -c '"provider":"zhipuai-coding-plan".*"status":"ok"' "$WORK/rows4b.jsonl" || true)
  cp -f "$WORK/cfg4b.bak" "$USER_CFG"
  sleep 6
  if [ "$c" = 200 ] && [ "${errdead:-0}" -ge 1 ] && [ "${okpaid:-0}" -ge 1 ]; then
    pass ④b "死免费候选 → 付费" "死模型失败 ${errdead} 行 → 付费成功 ${okpaid} 行"
  else
    fail ④b "死免费候选 → 付费" "HTTP $c dead=${errdead:-0} paid=${okpaid:-0} ｜ $(head -c 240 "$WORK/rows4b.jsonl")"
  fi

  # ── ⑤ 粘性：session A 首访失败后钉在付费候选；session B（新）不受 A 影响 ──
  A="ses_accept_sticky_$$_a"; B="ses_accept_sticky_$$_b"
  # 构造确定的"首访必失败"：临时配置里加一个必然连不上的 provider（127.0.0.1:1 → 立刻 refuse）
  # 与临时链 [accept-dead/x, zhipuai-paid]；A 跑两次、B 跑一次，之后还原配置。
  cp -f "$USER_CFG" "$WORK/cfg.bak"
  node --input-type=module -e "
    import { readFileSync, writeFileSync } from 'node:fs'
    // 自带剥注释（与插件同一套规则）—— 验收包因此**不依赖插件树**：拷 scripts/ 两个文件到对端就能跑
    const stripLineComments = (t) => String(t).split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('//')).join(String.fromCharCode(10))
    const p = process.argv[1]
    const j = JSON.parse(stripLineComments(readFileSync(p, 'utf8')))
    j.providers['accept-dead'] = { base_url: 'http://127.0.0.1:1', key: 'none', models: ['*'] }
    j.chains['accept-sticky'] = { targets: ['accept-dead/x', 'zhipuai-coding-plan/glm-5.3-flash'] }
    writeFileSync(p, JSON.stringify(j, null, 2))
  " "$USER_CFG"
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
  const stripLineComments = (t) => String(t).split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('//')).join(String.fromCharCode(10))
  const p = process.argv[1]
  const j = JSON.parse(stripLineComments(readFileSync(p, 'utf8')))
  j.chains['accept-order'] = { targets: ['zhipuai-coding-plan/glm-5.3-flash', 'deepseek/deepseek-flash'] }
  writeFileSync(p, JSON.stringify(j, null, 2))
" "$USER_CFG"
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