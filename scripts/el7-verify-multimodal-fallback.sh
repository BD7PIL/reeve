#!/usr/bin/env bash
# 步 4 收尾两项验证：
#   ① 视觉档：发一次带图的调用，看是否只有它走 reeve/multimodal
#   ② 回退：把 reeve/flash 链头（xiaomi）的 key 换成坏的 → 第 2 跳应接手且成功
set -euo pipefail
STAGE=/home/demo/.reeve-staging
BIF=$STAGE/bifrost
export HOME=$STAGE
E=/home/demo/.ocrc/remote/engine/opencode

echo "############ ① 视觉档 reeve/multimodal ############"
# 现造一张**合法**的 8x8 RGB PNG（纯标准库，不依赖 PIL）
python3 - <<'PY'
import zlib, struct
W = H = 8
raw = b''.join(b'\x00' + b''.join(bytes((x*30 % 256, y*30 % 256, 128)) for x in range(W)) for y in range(H))
def chunk(t, d):
    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(raw, 9))
       + chunk(b'IEND', b''))
open('/home/demo/.reeve-staging/work/tiny.png', 'wb').write(png)
print('  tiny.png', len(png), 'bytes, 8x8 RGB')
PY
set -a; . $BIF/env; set +a
cd $STAGE/work
timeout 240 $E run --model reeve/multimodal --title ela-mm --file tiny.png \
  "这张图里有几个像素？只回答数字。" 2>&1 | tail -5

echo
echo "############ ② 回退：把链头 key 换坏 ############"
# 备份 env，然后把 xiaomi 的 key 改成明显无效的值
cp $BIF/env $BIF/env.bak
python3 - <<'PY'
p='/home/demo/.reeve-staging/bifrost/env'
ls=[]
for l in open(p, encoding='utf-8').read().splitlines():
    if l.startswith('export REEVE_XIAOMI_KEY='):
        ls.append("export REEVE_XIAOMI_KEY='sk-deliberately-broken-for-fallback-test'")
    else:
        ls.append(l)
open(p,'w',encoding='utf-8').write("\n".join(ls)+"\n")
import os; os.chmod(p, 0o600)
print("  REEVE_XIAOMI_KEY 已临时改为坏值（原值在 env.bak）")
PY
bash $STAGE/restart.sh
set -a; . $BIF/env; set +a

echo "  --- 引擎侧跑一次 flash 档 ---"
timeout 300 $E run --agent scout --title ela-fallback "reply with exactly: FALLBACK-OK" 2>&1 | tail -4

echo "  --- 代理侧看这一跳 ---"
"$HOME/.ocrc/remote/runtime/node-v24.22.0/bin/node" -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync("/home/demo/.reeve-staging/bifrost/logs.db",{readOnly:true});
const rows=db.prepare("select timestamp,provider,model,fallback_index,status,error_details from logs where routing_rule_name=? order by timestamp desc limit 4").all("reeve/flash");
for(const r of rows.reverse()){
  let e=""; if(r.status==="error"&&r.error_details){ try{ e=JSON.parse(r.error_details).error.message||""; }catch(_){ e=String(r.error_details); } e=" | "+String(e).slice(0,90); }
  console.log("   ", r.timestamp.slice(11,19), "hop="+r.fallback_index, r.provider+"/"+r.model, r.status, e);
}'

echo "  --- 还原 key ---"
mv $BIF/env.bak $BIF/env
bash $STAGE/restart.sh
set -a; . $BIF/env; set +a
echo "  已还原并重启"