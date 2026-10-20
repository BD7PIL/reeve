#!/usr/bin/env bash
# 重启 staging Bifrost（改 config.json 后必须重启：它只在启动时读文件）
# 用法： bash restart-bifrost.sh
set -euo pipefail
B=/home/demo/.reeve-staging/bifrost
cd "$B"

pkill -f "bifrost-http -port 18080" 2>/dev/null || true
for i in $(seq 1 20); do pgrep -f "bifrost-http -port 18080" >/dev/null || break; sleep 0.5; done

set -a; . ./env; set +a
nohup ./bifrost-http -port 18080 -host 127.0.0.1 -app-dir "$B" >> bifrost.log 2>&1 &
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" 127.0.0.1:18080/api/version 2>/dev/null || true)
  [ "$code" = "200" ] && { echo "bifrost up (pid $(pgrep -f 'bifrost-http -port 18080' | head -1))"; exit 0; }
  sleep 1
done
echo "bifrost 未在 60s 内起来；日志尾部："; tail -20 bifrost.log; exit 1