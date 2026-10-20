#!/usr/bin/env bash
# 回退验证（修正版）：
#   ⚠️ 上一版踩到：`opencode run --agent scout` 的**顶层会话**用的是 config 的默认 model（reeve/pro），
#      不是 agent 自己的档位 —— 所以那次根本没打到 reeve/flash 链上。
#      （子 agent 的档位只在**被委派**时生效，10:27 那次委派跑出 8 次 reeve/flash 就是证据。）
#   所以这里做两种：
#     A. 显式点名 reeve/flash（精确定位链）
#     B. 真委派（foreman → scout），走真实路径
set -euo pipefail
STAGE=/home/demo/.reeve-staging
BIF=$STAGE/bifrost
export HOME=$STAGE
E=/home/demo/.ocrc/remote/engine/opencode
NODE=/home/demo/.ocrc/remote/runtime/node-v24.22.0/bin/node

show() {
  "$NODE" -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync("/home/demo/.reeve-staging/bifrost/logs.db",{readOnly:true});
const rows=db.prepare("select timestamp,provider,model,fallback_index,status,error_details from logs where routing_rule_name=? order by timestamp desc limit 6").all("reeve/flash");
for(const r of rows.reverse()){
  let e=""; if(r.status==="error"&&r.error_details){ try{ e=JSON.parse(r.error_details).error.message||""; }catch(_){ e=String(r.error_details); } e="  | "+String(e).slice(0,70); }
  console.log("    ", r.timestamp.slice(11,19), "hop="+r.fallback_index, r.provider+"/"+r.model, r.status, e);
}'
}

cp $BIF/env $BIF/env.bak
python3 - <<'PY'
p='/home/demo/.reeve-staging/bifrost/env'
ls=["export REEVE_XIAOMI_KEY='sk-deliberately-broken-for-fallback-test'" if l.startswith('export REEVE_XIAOMI_KEY=') else l
    for l in open(p, encoding='utf-8').read().splitlines()]
open(p,'w',encoding='utf-8').write("\n".join(ls)+"\n")
import os; os.chmod(p, 0o600)
print("  链头 xiaomi 的 key 已临时改坏")
PY
bash $STAGE/restart.sh
set -a; . $BIF/env; set +a

echo
echo "  --- A. 显式点名 reeve/flash ---"
cd $STAGE/work
timeout 200 $E run --model reeve/flash --title ela-fb-a "reply with exactly: FB-A" 2>&1 | tail -3
echo "  代理侧："
show

echo
echo "  --- B. 真委派（foreman → scout，scout 的档位是 flash）---"
timeout 400 $E run --agent foreman --title ela-fb-b "派 scout 数一下 /home/demo/.reeve-staging/work 下有几个文件，你亲自复核后回答数字。" 2>&1 | tail -6
echo "  代理侧："
show

echo
mv $BIF/env.bak $BIF/env
bash $STAGE/restart.sh
echo "  已还原 key 并重启"