#!/usr/bin/env bash
# 回帰テスト。ブラウザも通信も GitHub も使わないので、いつでも再現する。
#
#   bash tests/run.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/reels-trend-collector-test"
mkdir -p "$WORK"

if [ ! -d "$WORK/node_modules/jsdom" ]; then
  echo "jsdom を取得します（初回のみ）..."
  npm install --prefix "$WORK" --cache "$WORK/.npm-cache" jsdom --no-audit --no-fund
fi

echo "===== 1. 公開の安全性 ====="
bash "$ROOT/tests/verify_safety.sh"

echo
echo "全テスト通過"
