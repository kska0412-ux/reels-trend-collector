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
echo "===== 5. 収集の引数解析 ====="
node "$ROOT/tests/verify_scrape_args.mjs"

echo
echo "===== 6. 収集のCLI ====="
bash "$ROOT/tests/verify_scrape_cli.sh"

echo
echo "===== 7. マージ処理 ====="
python3 "$ROOT/tests/verify_merge.py"

echo
echo "===== 8. 表示範囲の絞り込み ====="
python3 "$ROOT/tests/verify_select.py"

echo
echo "===== 9. HTML生成 ====="
python3 "$ROOT/tests/make_fixture.py" --output "$WORK/fixture_reels.json"
python3 "$ROOT/scripts/build_html.py" --input "$WORK/fixture_reels.json" \
  --output "$WORK/preview.html"
# 件数上限に当たったときの表示も確かめるため、絞り込みが起きる版も作る
python3 "$ROOT/scripts/build_html.py" --input "$WORK/fixture_reels.json" \
  --output "$WORK/preview_trimmed.html" --max-reels 3 > /dev/null
# 他人由来の値が HTML として解釈されないことを確かめるための版
python3 "$ROOT/tests/make_fixture.py" --hostile --output "$WORK/fixture_hostile.json" > /dev/null
python3 "$ROOT/scripts/build_html.py" --input "$WORK/fixture_hostile.json" \
  --output "$WORK/preview_hostile.html" --max-age-days 0 --max-reels 0 > /dev/null
SCRATCH="$WORK" node "$ROOT/tests/verify_html.mjs"

echo
echo "===== 10. 改行の作法 ====="
SCRATCH="$WORK" node "$ROOT/tests/verify_wrapping.mjs"

echo
echo "===== 11. 公開判定 ====="
bash "$ROOT/tests/verify_publish.sh"

echo
echo "===== 12. 自動実行の設定 ====="
bash "$ROOT/tests/verify_launchd.sh"

echo
echo "===== 13. 自動実行の時刻 ====="
python3 "$ROOT/tests/verify_schedule.py"

echo
echo "===== 14. 自動実行の排他と再試行 ====="
bash "$ROOT/tests/verify_lock.sh"

echo
echo "===== 13. 公開の安全性 ====="
bash "$ROOT/tests/verify_safety.sh"

echo
echo "全テスト通過"
