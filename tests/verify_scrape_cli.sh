#!/usr/bin/env bash
# scrape.mjs のうち、ブラウザを開く前に止まる経路を検証する。
#
# 本体の収集は Instagram に繋がないと試せないが、引数の不備で止まる部分は
# ブラウザを起動する前に判定しているので、通信なしで確かめられる。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
W="${TMPDIR:-/tmp}/rtc-scrape-cli-$$"
PASS=0; FAIL=0
mkdir -p "$W"

check() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  OK   $1";
  else FAIL=$((FAIL+1)); echo "  FAIL $1  → 期待 $3 / 実際 $2"; fi
}

NODE="$(command -v node)"
if [ -z "$NODE" ]; then echo "  node が見つかりません"; exit 1; fi

echo "== 1. 引数が足りなければブラウザを開かずに止まる =="
OUT="$("$NODE" "$ROOT/scripts/scrape.mjs" 2>&1)"; CODE=$?
check "終了コード2" "$CODE" "2"
check "必須の引数を教える" "$(echo "$OUT" | grep -c -- '--genres と --out は必須です')" "1"

echo "== 2. --out が無ければ止まる =="
OUT="$("$NODE" "$ROOT/scripts/scrape.mjs" --genres "$ROOT/config/genres.json" 2>&1)"; CODE=$?
check "終了コード2" "$CODE" "2"

echo "== 3. 存在しないジャンルは黙って0件にせず止まる =="
OUT="$("$NODE" "$ROOT/scripts/scrape.mjs" --genres "$ROOT/config/genres.json" \
       --out "$W/out.json" --genre "存在しないジャンル" 2>&1)"; CODE=$?
check "終了コード2" "$CODE" "2"
check "どのジャンルが無いか言う" "$(echo "$OUT" | grep -c '存在しないジャンル')" "1"
check "出力ファイルを作らない" "$([ -e "$W/out.json" ] && echo あり || echo なし)" "なし"

echo "== 4. 設定ファイルが無ければ止まる =="
OUT="$("$NODE" "$ROOT/scripts/scrape.mjs" --genres "$W/no-such.json" \
       --out "$W/out2.json" 2>&1)"; CODE=$?
check "終了コード2" "$CODE" "2"
check "出力ファイルを作らない" "$([ -e "$W/out2.json" ] && echo あり || echo なし)" "なし"

rm -rf "$W"
echo
echo "結果: $PASS pass / $FAIL fail"
[ "$FAIL" -eq 0 ]
