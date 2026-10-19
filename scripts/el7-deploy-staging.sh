#!/usr/bin/env bash
# REEVE —— EL7 staging 部署（隔离 HOME，全链验证；生产 :4096 全程不碰）
#
#   # 先把仓库里的源真相推进 $STAGE/incoming/：
#   #   proxy/config.json            → $STAGE/incoming/bifrost.config.json
#   #   config/opencode.sample.jsonc → $STAGE/incoming/opencode.sample.jsonc
#   #   agents/*.md                  → $STAGE/.config/opencode/agent/（含 hidden: true）
#   bash el7-deploy-staging.sh
#
# 做五件事（幂等）：
#   1. 从 EL7 已有的 ~/.local/share/opencode/auth.json 生成 Bifrost 的 env（600）——密钥不打印、不落仓库
#   2. 由 incoming/ 的两份源真相**派生**运行时配置：
#      a. $STAGE/bifrost/config.json（改动见下）
#      b. $STAGE/.config/opencode/opencode.json（样板里的占位路径/端口换成 staging 的）
#   3. 起 Bifrost（:18080，app-dir = staging）
#   4. 建 / 更新引擎用的 virtual key（VK 只写进 env，600）
#   5. 打印 config.db 的关键行（不打印任何 key）
#
# 派生的 EL7 改动（其余与仓库逐字一致）：
#   a. 摘掉 provider `opencode`（EL7 的 auth.json 里没有 opencode zen 的 key）
#   b. reeve/flash 链头 opencode/mimo-v2.6-flash-free → xiaomi/mimo-v2.6-flash
#   c. 链上清掉 opencode/*（provider 已摘，留着只会污染回退测试）
#   d. 引擎配置：/opt/reeve/... → $STAGE/...；baseURL 8080 → 18080
set -euo pipefail
export PYTHONIOENCODING=utf-8   # EL7 的 python3.6 stdout 默认 ascii

STAGE=/home/demo/.reeve-staging
BIF=$STAGE/bifrost
NODE=${NODE:-$HOME/.ocrc/remote/runtime/node-v24.22.0/bin/node}

echo "=== 1. env（600）：从 EL7 的 auth.json 取 key（通用约定，不再手写映射表）==="
python3 - <<'PY'
import json, os, re, secrets

auth = json.load(open('/home/demo/.local/share/opencode/auth.json'))
chain = json.load(open('/home/demo/.reeve-staging/incoming/bifrost.config.json', encoding='utf-8'))

def env_name(provider_id):
    # 与插件 plugin/src/proxy.js 的 providerEnvName 同一条约定：REEVE_KEY_<大写、非字母数字→下划线>
    return 'REEVE_KEY_' + re.sub(r'^_+|_+$', '', re.sub(r'[^A-Z0-9]+', '_', provider_id.upper()))

lines, missing = [], []
for provider_id, prov in sorted((chain.get('providers') or {}).items()):
    for k in (prov.get('keys') or []):
        value = k.get('value') or ''
        if not value.startswith('env.'):
            continue
        auth_id = k.get('fromAuth') or provider_id   # 链里改过名的（deepseek → deepseek-api）走 fromAuth
        key = (auth.get(auth_id) or {}).get('key')
        if not key:
            missing.append(provider_id); continue
        if [c for c in key if c in "'\"\\\n$` "]:
            raise SystemExit('unsafe char in key for %s' % provider_id)
        var = value[len('env.'):]
        assert var == env_name(provider_id), 'env 名不符约定：%s vs %s' % (var, env_name(provider_id))
        lines.append("export %s='%s'" % (var, key))
lines.append("export BIFROST_SETUP_TOKEN='%s'" % secrets.token_hex(24))

path = '/home/demo/.reeve-staging/bifrost/env'
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, ("\n".join(lines) + "\n").encode()); os.close(fd)
print("  写入 %d 个 provider key 变量（+setup_token）；mode=%o" % (len(lines) - 1, os.stat(path).st_mode & 0o777))
if missing: print("  auth.json 里没有的 provider（未注入）:", sorted(set(missing)))
PY

echo "=== 2. 派生运行时配置（源自 incoming/ 里的两份源真相）==="
python3 - <<'PY'
import json
src = '/home/demo/.reeve-staging/incoming/bifrost.config.json'
dst = '/home/demo/.reeve-staging/bifrost/config.json'
c = json.load(open(src, encoding='utf-8'))

c['providers'].pop('opencode', None)
for r in c['governance']['routing_rules']:
    r['fallbacks'] = [f for f in r.get('fallbacks', []) if not f.startswith('opencode/')]
    if r['id'] == 'reeve-flash':
        r['targets'] = [{'provider': 'xiaomi', 'model': 'mimo-v2.6-flash',
                         'weight': 1, 'ttft_timeout_ms': 30000}]
json.dump(c, open(dst, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

print("  providers:", sorted(c['providers']))
for r in c['governance']['routing_rules']:
    print("   %-16s -> %s" % (r['name'], [t['provider'] + '/' + t['model'] for t in r['targets']]))
    print("      fallbacks: %s" % r.get('fallbacks'))
print("  client:", c.get('client'), "| setup_token:", c.get('governance', {}).get('setup_token'))
PY

echo "=== 2b. 派生引擎配置（源自 incoming/opencode.sample.jsonc）==="
python3 - <<'PY'
import json, os, re

STAGE = '/home/demo/.reeve-staging'
src = STAGE + '/incoming/opencode.sample.jsonc'
dst = STAGE + '/.config/opencode/opencode.json'

out = []
for i, line in enumerate(open(src, encoding='utf-8').read().splitlines(), 1):
    s = line.strip()
    if s.startswith('//'):
        continue  # 整行注释（样板里只有这一种）
    # 行内出现 // 只允许在字符串里（$schema 的 https:// 就是）；否则本派生器无法安全解析
    if '//' in re.sub(r'"(?:\\.|[^"\\])*"', '""', line):
        raise SystemExit('样板第 %d 行有行尾注释 —— 派生器只支持整行注释，请改掉：%s' % (i, s[:60]))
    out.append(line)

c = json.loads('\n'.join(out))
c['providers']['reeve']['settings']['baseURL'] = 'http://127.0.0.1:18080/v1'
c['plugins'][0]['package'] = STAGE + '/plugin'
c['plugins'][0]['options']['snapshotPath'] = STAGE + '/.local/share/opencode/reeve/ledger.json'
# 代理层自持（纯插件形态）在 staging 的落点：自己的目录 + 18080 + 真 home 的 auth.json
# （staging HOME 里没有 auth.json —— key 一直在真 home 那份里）
proxy = c['plugins'][0]['options'].setdefault('proxy', {})
proxy.update({
    'enabled': True,
    'dir': STAGE + '/proxy',
    'port': 18080,
    'authPath': '/home/demo/.local/share/opencode/auth.json',
})

os.makedirs(os.path.dirname(dst), exist_ok=True)
json.dump(c, open(dst, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print("  写 %s：default_agent=%s | agents=%s | providers=%s | plugins=%d" % (
    dst, c.get('default_agent'), sorted((c.get('agents') or {}).keys()),
    sorted(c['providers'].keys()), len(c.get('plugins') or [])))
print("  proxy 自持:", json.dumps(c['plugins'][0]['options'].get('proxy'), ensure_ascii=False))
PY

# 两种模式**不能同时存在**（实测撞过一次：部署起的代理要 VK、引擎却拿占位 key → 401 "virtual key is required"）。
# 引擎配置里 proxy.enabled=true 表示"代理归插件"，此时部署脚本**不碰代理**。
PROXY_MODE=$(python3 -c "
import json
c=json.load(open('$STAGE/.config/opencode/opencode.json', encoding='utf-8'))
print('plugin' if (c['plugins'][0].get('options',{}).get('proxy',{}) or {}).get('enabled') else 'launcher')
")
echo "  代理归属模式：$PROXY_MODE"

if [ "$PROXY_MODE" = plugin ]; then
  # 纯插件形态：代理归插件（它自己取件/拉起/守护/收敛），引擎侧用占位 key。
  # 本脚本**什么都不碰** —— 两种形态同时在同一个端口上会撞（实测 401 "virtual key is required"）。
  echo "=== 3./3.5/4. 跳过（代理归插件自持）==="
  echo "  插件会在引擎启动时自己把代理拉起来；要改链就改 incoming/opencode.sample.jsonc 或插件的 default-chain.json"
else
  echo "=== 3. 起 Bifrost :18080 ==="
  bash "$STAGE/restart.sh"

  echo "=== 3.5 收敛：把文件（期望态）同步到运行中的 Bifrost ==="
  # 为什么必须有这一步：运行时真相在 Bifrost 的 DB 里（热改会持久化），
  # config.json 只在启动时做 upsert —— 「改文件 + 重启」能加能改、**删不掉** DB 里多出来的行。
  # 详见 scripts/bifrost-sync-config.sh 的头注释（四条都有实验证据）。
  if [ -f "$STAGE/bifrost-sync.sh" ]; then
    bash "$STAGE/bifrost-sync.sh" --app-dir "$BIF" --port 18080 --apply --prune || true
  else
    echo "  （没有 bifrost-sync.sh，跳过 —— 漂移不会被收敛）"
  fi

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
fi

echo "=== 完成 ==="