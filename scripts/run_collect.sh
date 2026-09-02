#!/usr/bin/env bash
# 1ジャンルぶんの収集 → HTML生成 → GitHub Pages へ公開 まで一息で実行する。
# launchd からジャンルごとに1日1回呼ばれる。手動で実行しても同じことが起きる。
#
#   bash scripts/run_collect.sh 育毛
#
# ジャンル名を省略すると全ジャンルを収集する（アクセス量が増えるので普段は使わない）。
set -uo pipefail

# 収集は10分前後かかる。途中でスリープに入ると中断されるため、
# 実行中だけ起きたままにする（終了すれば元の設定に戻る）。
if [ -z "${RTC_AWAKE:-}" ] && [ -x /usr/bin/caffeinate ]; then
  export RTC_AWAKE=1
  # bash 経由で呼ぶ。ファイルに実行権限が無くても動くようにするため。
  exec /usr/bin/caffeinate -i -s /bin/bash "${BASH_SOURCE[0]}" "$@"
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p logs

GENRE="${1:-}"
LOG="logs/collect.log"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

log "===== 開始 ${GENRE:-全ジャンル} ====="

COLLECT_ARGS=()
[ -n "$GENRE" ] && COLLECT_ARGS+=(--genre "$GENRE")

# -u を付けて出力のバッファリングを切る。付けないと数キロバイト溜まるまで
# ログに書き出されず、動いているのに止まって見える。
if ! /usr/bin/env python3 -u scripts/collect.py "${COLLECT_ARGS[@]}" >> "$LOG" 2>&1; then
  log "収集に失敗。ページは更新しません。"
  exit 1
fi

if ! /usr/bin/env python3 -u scripts/build_html.py >> "$LOG" 2>&1; then
  log "HTML生成に失敗。"
  exit 1
fi

# --- GitHub Pages へ公開 ---
if ! bash scripts/publish.sh "$LOG"; then
  log "公開に失敗しました。"
  exit 1
fi

log "===== 完了 ${GENRE:-全ジャンル} ====="
