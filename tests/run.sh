#!/usr/bin/env bash
# 回帰テスト。ブラウザも通信も GitHub も使わないので、いつでも再現する。
#
#   bash tests/run.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/reels-trend-collector-test"
mkdir -p "$WORK"

# jsdom は HTML のテスト（Task 10 で追加）が来たときに、その章が自前で用意する。
# 今ぶら下がっているテストはどれも jsdom を使わないので、ここでは取得しない。

echo "===== 1. リール抽出ロジック ====="
node "$ROOT/tests/verify_extract_reel.mjs"

echo
echo "===== 2. フォロワー数の抽出 ====="
node "$ROOT/tests/verify_extract_profile.mjs"

echo
echo "===== 3. やり直し判定 ====="
node "$ROOT/tests/verify_retry.mjs"

echo
echo "===== 4. 伸び率の計算 ====="
python3 "$ROOT/tests/verify_ratio.py"

echo
echo "===== 5. 表示範囲の絞り込み ====="
python3 "$ROOT/tests/verify_select.py"

echo
echo "===== 6. 公開の安全性 ====="
bash "$ROOT/tests/verify_safety.sh"

echo
echo "全テスト通過"
