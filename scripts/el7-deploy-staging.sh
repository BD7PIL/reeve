#!/usr/bin/env bash
# REEVE —— EL7 staging 部署（隔离 HOME，全链验证；生产 :4096 全程不碰）
#
#   bash el7-deploy-staging.sh
#
# 做四件事（幂等）：
#   1. 从 EL7 已有的 ~/.local/share/opencode/auth.json 生成 Bifrost 的 env（600）——密钥不打印、不落仓库
#   2. 由 仓库的 proxy/config.json 派生 staging config（只做 EL7 必须的改动，见下）
#   3. 起 Bifrost（:18080，app-dir = staging）
#   4. 建 / 更新引擎用的 virtual key（VK 只写进 env，600）
#
# 派生的 EL7 改动（其余与仓库 config.json 逐字一致）：
#   a. 摘掉 provider `opencode`（EL7 的 auth.json 里没有 opencode zen 的 key）
#   b. reeve/flash 链头 opencode/mimo-v2.6-flash-free → xiaomi/mimo-v2.6-flash
#   c. 链上清掉 opencode/*（provider 已摘，留着只会污染回退测试）
set -euo pipefail
export PYTHONIOENCODING=utf-8   # EL7 的 python3.6 stdout 默认 ascii

STAGE=/home/demo/.reeve-staging
BIF=$STAGE/bifrost
NODE=${NODE:-$HOME/.ocrc/remote/runtime/node-v24.22.0/bin/node}

echo "=== 1. env（600）：从 EL7 的 auth.json 取 key ==="
python3 - <<'PY'
import json, os, secrets

auth = json.load(open('/home/demo/.local/share/opencode/auth.json'))
need = {
    'REEVE_ZHIPUAI_KEY':  'zhipuai-coding-plan',
    'REEVE_XXYAPI_KEY':   'xxyapi-deepseek',
    'REEVE_LMUAI_KEY':    'lmuai',
    'REEVE_DEEPSEEK_KEY': 'deepseek',
    'REEVE_XIAOMI_KEY':   'xiaomi',
    'REEVE_ALIBABA_KEY':  'alibaba-cn',
    'REEVE_OPENCODE_KEY': 'opencode',          # EL7 通常没有；缺就跳过
}
lines, missing = [], []
for var, prov in sorted(need.items()):
    key = (auth.get(prov) or {}).get('key')
    if not key:
        missing.append(prov); continue
    if [c for c in key if c in "'\"\\\n$` "]:
        raise SystemExit('unsafe char in key for %s' % prov)
    lines.append("export %s='%s'" % (var, key))
lines.append("export BIFROST_SETUP_TOKEN='%s'" % secrets.token_hex(24))

path = '/home/demo/.reeve-staging/bifrost/env'
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, ("\n".join(lines) + "\n").encode()); os.close(fd)
print("  写入 %d 个变量（含随机 setup_token）；mode=%o" % (len(lines), os.stat(path).st_mode & 0o777))
if missing: print("  auth.json 里没有的 provider（未注入）:", missing)
PY

echo "=== 2. 派生 staging config（源自 仓库 proxy/config.json）==="
python3 - <<'PY'
import json
p = '/home/demo/.reeve-staging/bifrost/config.json'
c = json.load(open(p, encoding='utf-8'))

c['providers'].pop('opencode', None)
for r in c['governance']['routing_rules']:
    r['fallbacks'] = [f for f in r.get('fallbacks', []) if not f.startswith('opencode/')]
    if r['id'] == 'reeve-flash':
        r['targets'] = [{'provider': 'xiaomi', 'model': 'mimo-v2.6-flash',
                         'weight': 1, 'ttft_timeout_ms': 30000}]
json.dump(c, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

print("  providers:", sorted(c['providers']))
for r in c['governance']['routing_rules']:
    print("   %-16s -> %s" % (r['name'], [t['provider'] + '/' + t['model'] for t in r['targets']]))
    print("      fallbacks: %s" % r.get('fallbacks'))
print("  client:", c.get('client'), "| setup_token:", c.get('governance', {}).get('setup_token'))
PY

echo "=== 3. 起 Bifrost :18080 ==="
bash "$STAGE/restart.sh"

echo "=== 4. virtual key（引擎 → 代理 的凭据）==="
cd "$BIF"; set -a; . ./env; set +a
AUTH_H="-H X-Bifrost-Setup-Token:$BIFROST_SETUP_TOKEN"
API=http://127.0.0.1:18080/api/governance/virtual-keys

# VK 的明文只在创建/轮换时返回一次；这里做成确定性：删掉旧的 reeve-engine，重建一个，写进 env。
for id in $(curl -s $AUTH_H $API | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('\n'.join(v['id'] for v in (d.get('virtual_keys') or []) if v.get('name')=='reeve-engine'))
"); do
  curl -s -o /dev/null -X DELETE $AUTH_H "$API/$id" && echo "  删除旧 VK $id"
done

curl -s -o /tmp/vknew.json -X POST $AUTH_H -H "Content-Type: application/json" \
  -d '{"name":"reeve-engine","description":"REEVE 引擎的接入凭据"}' "$API" >/dev/null
VK_ID=$(python3 -c "import json; print(json.load(open('/tmp/vknew.json',encoding='utf-8'))['virtual_key']['id'])")
VK=$(python3 -c "
import json
d=json.load(open('/tmp/vknew.json',encoding='utf-8'))
def f(o):
    if isinstance(o,dict):
        for k,v in o.items():
            if k in ('value','key','token','virtual_key') and isinstance(v,str) and v.startswith('sk-bf-'): return v
            r=f(v)
            if r: return r
    elif isinstance(o,list):
        for i in o:
            r=f(i)
            if r: return r
    return None
print(f(d) or '')")
[ -n "$VK" ] || { echo "  没拿到 VK 值"; exit 1; }
python3 - "$VK" <<'PY'
import os, sys
vk = sys.argv[1]
if [c for c in vk if c in "'\"\\\n$` "]:
    raise SystemExit('VK 含不安全字符，拒绝写入')
path = '/home/demo/.reeve-staging/bifrost/env'
ls = [l for l in open(path, encoding='utf-8').read().splitlines() if not l.startswith('export REEVE_VK=')]
ls.append("export REEVE_VK='%s'" % vk)
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, ("\n".join(ls) + "\n").encode()); os.close(fd)
print("  VK 已写入 env（600）；长度=%d 前缀=%s… 尾=…%s（中间不打印）" % (len(vk), vk[:8], vk[-4:]))
PY
export REEVE_VK="$VK"

echo "  —— 允许所有 provider（新建的 VK 默认一个都不允许，实测回 403）——"
curl -s -o /dev/null -w "  allow_all_providers=true -> HTTP %{http_code}\n" -X PUT \
  -H "X-Bifrost-Setup-Token: $BIFROST_SETUP_TOKEN" -H "Content-Type: application/json" \
  -d '{"allow_all_providers":true}' \
  "http://127.0.0.1:18080/api/governance/virtual-keys/$VK_ID"

echo "  —— 活着就报一下（不打印任何 key）——"
"$NODE" -e '
const {DatabaseSync} = require("node:sqlite");
const db = new DatabaseSync("/home/demo/.reeve-staging/bifrost/config.db", {readOnly: true});
const r = db.prepare("select log_retention_days, enforce_auth_on_inference from config_client").all();
console.log("  config.db/client:", JSON.stringify(r[0]));
'
echo "=== 完成 ==="