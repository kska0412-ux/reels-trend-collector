#!/usr/bin/env bash
# ジャンルと掛け合わせ語ごとに、1日1回の自動収集を登録する。
# 1日の中に分散させて、Instagram への連続アクセスを避ける。
#
# 時刻の決定は scripts/schedule.py が持つ。同じ Mac で動いている
# Threads Research Tool（7時・13時・21時）の帯を避けて散らす。
#
#   bash scripts/install_launchd.sh
#
# 解除は scripts/uninstall_launchd.sh
#
# --dry-run を付けると、plist を一時ディレクトリに書き出すだけで
# launchctl は一切呼ばない（$HOME/Library/LaunchAgents にも触らない）。
# 生成内容の確認や tests/verify_launchd.sh から使う。
set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="com.kameda.reels-trend-collector"
TEMPLATE="$ROOT/config/launchd/template.plist"

if [ "$DRY_RUN" -eq 1 ]; then
  AGENTS="$(mktemp -d "${TMPDIR:-/tmp}/rtc-launchd-dry-run-XXXXXX")"
  echo "（--dry-run）plist は $AGENTS に書き出し、launchctl は呼びません。"
else
  AGENTS="$HOME/Library/LaunchAgents"
  mkdir -p "$AGENTS"
  # 既存の登録を一度すべて外す。ジャンルが減ったときに取り残しを作らないため。
  bash "$ROOT/scripts/uninstall_launchd.sh" >/dev/null 2>&1 || true
fi

# 1回ぶんと時刻を schedule.py から読む。1行 "ジャンル名を空白区切り<TAB>時<TAB>分"。
# 1回に複数ジャンルをまとめるのは、Mac を開けておく時間帯を減らすため。
# 掛け合わせ語（経営・メニューなど）も含む。落とすと #サロン経営 などが
# 永久に自動収集されない。
# macOS 標準の bash (3.2) には mapfile が無いため while read で読む。
GENRES=()
HOURS=()
MINUTES=()
while IFS=$'\t' read -r name hour minute; do
  [ -z "$name" ] && continue
  # name は「ヘッドスパ アートメイク …」のように空白区切り。
  # plist には1ジャンル1要素で並べるので、ここでは1行のまま持つ。
  GENRES+=("$name")
  HOURS+=("$hour")
  MINUTES+=("$minute")
done < <(python3 "$ROOT/scripts/schedule.py")

COUNT=${#GENRES[@]}
if [ "$COUNT" -eq 0 ]; then
  echo "config/genres.json に巡回する単位がありません。"
  exit 1
fi

echo "登録します（$COUNT 件）:"
for i in "${!GENRES[@]}"; do
  GENRE="${GENRES[$i]}"
  HOUR="${HOURS[$i]}"
  MINUTE="${MINUTES[$i]}"
  # ラベルに日本語は使えないので連番にする
  LABEL="$PREFIX.$i"
  DEST="$AGENTS/$LABEL.plist"

  # ジャンル名は1つずつ <string> にする。1要素にまとめて渡すと
  # 「ヘッドスパ アートメイク」という名前のジャンルを探しに行ってしまう。
  # 差し込みが複数行になるので sed ではなく python3 で組み立てる
  # （awk は改行を含む変数を受け取れない）。
  ROOT="$ROOT" LABEL="$LABEL" GENRE="$GENRE" HOUR="$HOUR" MINUTE="$MINUTE" \
  python3 -c '
import os, sys, html
tpl = open(sys.argv[1], encoding="utf-8").read()
args = "".join(
    "    <string>%s</string>\n" % html.escape(g)
    for g in os.environ["GENRE"].split()
)
out = (tpl.replace("__GENRE_ARGS__\n", args)
          .replace("__ROOT__", os.environ["ROOT"])
          .replace("__LABEL__", os.environ["LABEL"])
          .replace("__HOUR__", os.environ["HOUR"])
          .replace("__MINUTE__", os.environ["MINUTE"]))
open(sys.argv[2], "w", encoding="utf-8").write(out)
' "$TEMPLATE" "$DEST"

  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  %2d:%02d  %s  → %s\n' "$HOUR" "$MINUTE" "$GENRE" "$DEST"
    continue
  fi

  launchctl unload "$DEST" 2>/dev/null || true
  launchctl load "$DEST"
  printf '  %2d:%02d  %s\n' "$HOUR" "$MINUTE" "$GENRE"
done

if [ "$DRY_RUN" -eq 1 ]; then
  exit 0
fi

echo
echo "確認:       launchctl list | grep $PREFIX"
echo "今すぐ実行: launchctl start $PREFIX.0"
echo "ログ:       tail -f $ROOT/logs/collect.log"
echo
echo "Mac の電源が入っていれば、蓋を閉じていても次に起きたときに実行されます。"
echo "電源が切れていると実行されず、遡っても動きません。"
