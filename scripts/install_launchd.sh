#!/usr/bin/env bash
# ジャンルごとに1日1回の自動収集を登録する。
# 1日の中に分散させて、Instagram への連続アクセスを避ける。
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

# ジャンル名を config から読む。1行1ジャンル。
# macOS 標準の bash (3.2) には mapfile が無いため while read で読む。
GENRES=()
while IFS= read -r line; do
  GENRES+=("$line")
done < <(python3 -c "
import json
for g in json.load(open('$ROOT/config/genres.json'))['genres']:
    print(g)
")

COUNT=${#GENRES[@]}
if [ "$COUNT" -eq 0 ]; then
  echo "config/genres.json にジャンルがありません。"
  exit 1
fi

echo "登録します（$COUNT ジャンル）:"
for i in "${!GENRES[@]}"; do
  GENRE="${GENRES[$i]}"
  # 7時から22時のあいだに均等に散らす
  if [ "$COUNT" -eq 1 ]; then
    HOUR=7
  else
    HOUR=$(( 7 + i * 15 / (COUNT - 1) ))
  fi
  # ラベルに日本語は使えないので連番にする
  LABEL="$PREFIX.$i"
  DEST="$AGENTS/$LABEL.plist"

  sed -e "s|__ROOT__|$ROOT|g" \
      -e "s|__LABEL__|$LABEL|g" \
      -e "s|__GENRE__|$GENRE|g" \
      -e "s|__HOUR__|$HOUR|g" \
      "$TEMPLATE" > "$DEST"

  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  %2d:00  %s  → %s\n' "$HOUR" "$GENRE" "$DEST"
    continue
  fi

  launchctl unload "$DEST" 2>/dev/null || true
  launchctl load "$DEST"
  printf '  %2d:00  %s\n' "$HOUR" "$GENRE"
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
