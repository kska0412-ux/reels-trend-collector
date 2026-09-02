#!/usr/bin/env bash
# 自動収集の登録をすべて解除する。
set -uo pipefail

PREFIX="com.kameda.reels-trend-collector"
AGENTS="$HOME/Library/LaunchAgents"

found=0
for f in "$AGENTS/$PREFIX".*.plist; do
  [ -e "$f" ] || continue
  launchctl unload "$f" 2>/dev/null || true
  rm -f "$f"
  echo "解除しました: $(basename "$f")"
  found=1
done

[ "$found" -eq 0 ] && echo "登録はありませんでした。"
exit 0
