#!/usr/bin/env bash
# 回帰テスト。ブラウザも通信も GitHub も使わないので、いつでも再現する。
#
#   bash tests/run.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/reels-trend-collector-test"
mkdir -p "$WORK"

# HTML のテストは jsdom（ローカルのDOM実装）で動かす。初回だけ取得する。
if [ ! -d "$WORK/node_modules/jsdom" ]; then
  echo "jsdom を取得します（初回のみ）..."
  npm install --prefix "$WORK" --cache "$WORK/.npm-cache" jsdom --no-audit --no-fund
fi

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
echo "===== 6. HTML生成 ====="
python3 "$ROOT/tests/make_fixture.py" --output "$WORK/fixture_reels.json"
python3 "$ROOT/scripts/build_html.py" --input "$WORK/fixture_reels.json" \
  --output "$WORK/preview.html"
# 件数上限に当たったときの表示も確かめるため、絞り込みが起きる版も作る
python3 "$ROOT/scripts/build_html.py" --input "$WORK/fixture_reels.json" \
  --output "$WORK/preview_trimmed.html" --max-reels 3 > /dev/null
SCRATCH="$WORK" node "$ROOT/tests/verify_html.mjs"

echo
echo "===== 7. 改行の作法 ====="
SCRATCH="$WORK" node "$ROOT/tests/verify_wrapping.mjs"

echo
echo "===== 8. 公開の安全性 ====="
bash "$ROOT/tests/verify_safety.sh"

echo
echo "全テスト通過"
