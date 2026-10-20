#!/usr/bin/env bash
# 把当前提交的**可公开树**推成 GitHub 上的 `main`。
#
#   bash scripts/publish-repo.sh              # 用 HEAD
#   bash scripts/publish-repo.sh <ref>        # 用指定 ref（默认 HEAD）
#   REMOTE=<name> bash scripts/publish-repo.sh
#
# 公开树**不带开发历史**（每次重建、单提交、force-push）：
#   · `docs/`  —— 内部记录（含内网地址与迁移叙事），**从不发布**，也不许进历史
#   · `.zcode/` —— 施工草稿（plan / probe / shots）
# 所以不能用"推 master"这种办法：git 的历史一样会被上传。开发历史留在本地仓库。
#
# 推完 GitHub 上就是：README（公开面）+ plugin/ + extensions/ + config/ + proxy/ + scripts/ + licenses/
# + .github/workflows（CI 与发布）。CI 会对这次推送重跑一遍。
set -euo pipefail

EXCLUDE=(docs .zcode)
REF="${1:-HEAD}"
REMOTE="${REMOTE:-origin}"

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

URL="$(git remote get-url "$REMOTE")"
SHA="$(git rev-parse --short "$REF")"
SUBJECT="$(git log -1 --format=%s "$REF")"

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

echo "=== 1. 导出 $REF（$SHA）==="
git archive "$REF" | tar -x -C "$OUT"

echo "=== 2. 剪掉不发布的：${EXCLUDE[*]} ==="
for p in "${EXCLUDE[@]}"; do
  if [ -e "$OUT/$p" ]; then rm -rf "$OUT/$p"; echo "  已剪：$p/"; fi
done

# 硬闸门：剪完必须还剩下这几样，否则宁可不推。
for need in README.md LICENSE NOTICE.md plugin/package.json extensions/reeve/package.json .github/workflows/ci.yml; do
  [ -e "$OUT/$need" ] || { echo "✗ 公开树缺 $need —— 中止"; exit 1; }
done
# 反向闸门：内网地址不许出现在任何被推的文件里。
if grep -rIl --exclude-dir=.git -E '192\.168\.[0-9]+\.[0-9]+' "$OUT" 2>/dev/null | head -5 | grep -q .; then
  echo "✗ 公开树里有内网地址 —— 中止："
  grep -rIl -E '192\.168\.[0-9]+\.[0-9]+' "$OUT" | sed "s|$OUT/|  |"
  exit 1
fi

echo "=== 3. 建公开提交（单提交，无历史）==="
cd "$OUT"
git init -q -b main
git add -A
git -c user.name='bd7pil' -c user.email='bd7pil@users.noreply.github.com' \
  commit -q -m "reeve 公开树 · 由 $SHA 导出（$SUBJECT）" \
                -m "不含 docs/ 与 .zcode/：开发记录只留在开发仓库，不进公开历史。"
echo "  文件数：$(git ls-files | wc -l | tr -d ' ')"
echo "  顶层：$(git ls-files | cut -d/ -f1 | sort -u | tr '\n' ' ')"

echo "=== 4. 推 $URL 的 main ==="
git push --force "$URL" main
echo
echo "完成。GitHub 上的 CI 会因这次推送重跑一遍。"
echo "下一步（首次发布插件）见 README「发布」一节。"