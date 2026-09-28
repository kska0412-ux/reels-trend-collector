#!/usr/bin/env bash
# install_launchd.sh --dry-run が生成する plist を検証する。
# launchctl は一切呼ばない。$HOME/Library/LaunchAgents にも書き込まない
# （--dry-run 自体がそう作られていることも、ここで確かめる）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0

check() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  OK   $1";
  else FAIL=$((FAIL+1)); echo "  FAIL $1  → 期待 $3 / 実際 $2"; fi
}

AGENTS_REAL="$HOME/Library/LaunchAgents"
BEFORE="$(ls -la "$AGENTS_REAL" 2>&1 | shasum)"

OUT="$(bash "$ROOT/scripts/install_launchd.sh" --dry-run)"
EC=$?

AFTER="$(ls -la "$AGENTS_REAL" 2>&1 | shasum)"

echo "$OUT"
echo

check "終了コード0" "$EC" "0"
check "\$HOME/Library/LaunchAgents は変化しない" "$AFTER" "$BEFORE"

# --dry-run が出力した書き出し先ディレクトリを拾う
DRY_DIR="$(echo "$OUT" | sed -n 's/.*plist は \(.*\) に書き出し.*/\1/p')"
check "書き出し先が \$HOME/Library/LaunchAgents ではない" \
  "$(echo "$DRY_DIR" | grep -c "^$AGENTS_REAL$")" "0"
check "書き出し先が存在する" "$([ -d "$DRY_DIR" ] && echo yes)" "yes"

# どのジャンルを回すかは登録時に決めない。各回は run_collect.sh --next N で
# 起動し、実行時に scripts/rotation.py が「最後に回してから一番古い N 単位」を選ぶ。
# 46単位を毎日全部回すと Instagram へのアクセスが2.4倍になるため
read -r EXPECTED_RUNS EXPECTED_PER_RUN < <(python3 -c "
import sys; sys.path.insert(0, '$ROOT/scripts')
from schedule import load_groups, plan_runs
print(*plan_runs(len(load_groups())))
")

PLISTS=("$DRY_DIR"/*.plist)
ACTUAL_COUNT="${#PLISTS[@]}"
# plist の数は「1日の実行回数」。Mac を開けておく時間帯を減らすため、
# 1ジャンル1回では登録しない
check "1日の実行回数ぶんのplistが作られる" "$ACTUAL_COUNT" "$EXPECTED_RUNS"

echo
echo "-- 各plistの検証 --"

HAVE_PLUTIL=0
command -v plutil >/dev/null 2>&1 && HAVE_PLUTIL=1

ALL_HOURS=""; ALL_TIMES=""
BAD_ARGS=0
PLACEHOLDER_LEFTOVER=0
XML_BROKEN=0
NO_ROOT_LOG=0
NO_RUN_COLLECT=0
BAD_PATH=0
BAD_HOUR=0

for f in "${PLISTS[@]}"; do
  [ -e "$f" ] || continue
  content="$(cat "$f")"

  # プレースホルダが残っていない
  if echo "$content" | grep -qE '__ROOT__|__LABEL__|__GENRE__|__HOUR__'; then
    PLACEHOLDER_LEFTOVER=1
    echo "  FAIL プレースホルダが残っている: $f"
  fi

  # 正しいXMLであること
  if [ "$HAVE_PLUTIL" -eq 1 ]; then
    if ! plutil -lint -s "$f" >/dev/null 2>&1; then
      XML_BROKEN=1
      echo "  FAIL plutil -lint に失敗: $f"
    fi
  else
    head1="$(head -1 "$f")"
    tail1="$(tail -1 "$f")"
    case "$head1" in \<\?xml*) ;; *) XML_BROKEN=1; echo "  FAIL <?xml で始まらない: $f";; esac
    case "$tail1" in *\</plist\>) ;; *) XML_BROKEN=1; echo "  FAIL </plist> で終わらない: $f";; esac
  fi

  # 時刻を集める。分まで見る。時だけだとジャンル数が多いとき
  # 「同じ時の別の分」を重複と誤判定する。実際に同時起動するのは
  # 時と分の両方が一致したときだけ。
  hour="$(echo "$content" | sed -n 's/.*<key>Hour<\/key><integer>\([0-9]*\)<\/integer>.*/\1/p' | head -1)"
  minute="$(echo "$content" | sed -n 's/.*<key>Minute<\/key><integer>\([0-9]*\)<\/integer>.*/\1/p' | head -1)"
  ALL_HOURS="$ALL_HOURS $hour"
  ALL_TIMES="$ALL_TIMES $(printf '%02d:%02d' "$hour" "${minute:-0}")"
  if [ -z "$hour" ] || [ "$hour" -lt 8 ] || [ "$hour" -gt 20 ]; then
    BAD_HOUR=1
    echo "  FAIL 時刻が8〜20の範囲外: $f ($hour)"
  fi

  # ProgramArguments は run_collect.sh --next N。ジャンル名を焼き込まない
  args="$(echo "$content" | python3 -c "
import sys, plistlib
data = plistlib.loads(sys.stdin.buffer.read())
print(' '.join(data['ProgramArguments'][2:]))
" 2>/dev/null)"
  if [ "$args" != "--next $EXPECTED_PER_RUN" ]; then
    BAD_ARGS=1
    echo "  FAIL 引数が --next $EXPECTED_PER_RUN ではない: $f ($args)"
  fi
  if ! echo "$content" | grep -q "run_collect.sh"; then
    NO_RUN_COLLECT=1
    echo "  FAIL run_collect.sh を渡していない: $f"
  fi

  # PATH
  if ! echo "$content" | grep -q "/opt/homebrew/bin"; then
    BAD_PATH=1
    echo "  FAIL PATHに /opt/homebrew/bin が無い: $f"
  fi
  if ! echo "$content" | grep -q "/usr/local/bin"; then
    BAD_PATH=1
    echo "  FAIL PATHに /usr/local/bin が無い: $f"
  fi

  # 標準出力・標準エラーがリポジトリ内 logs/ を指す
  if ! echo "$content" | grep -q "$ROOT/logs/"; then
    NO_ROOT_LOG=1
    echo "  FAIL 標準出力/標準エラーがリポジトリのlogs/を指していない: $f"
  fi
done

check "プレースホルダの残りが無い" "$PLACEHOLDER_LEFTOVER" "0"
check "全plistが正しいXML" "$XML_BROKEN" "0"
check "時刻が8〜20の範囲に収まる" "$BAD_HOUR" "0"
check "ProgramArgumentsにrun_collect.shがある" "$NO_RUN_COLLECT" "0"
check "全plistが --next $EXPECTED_PER_RUN で起動する（ジャンル名を焼き込まない）" "$BAD_ARGS" "0"
check "PATHにhomebrew/localのbinが入っている" "$BAD_PATH" "0"
check "標準出力/標準エラーがリポジトリのlogs/を指す" "$NO_ROOT_LOG" "0"

# 時刻の重複が無い（同じ時刻に2つ起動するとブラウザが同時に2つ立ち上がる）
TIMES_SORTED="$(echo "$ALL_TIMES" | tr ' ' '\n' | grep -v '^$' | sort)"
TIMES_UNIQ="$(echo "$TIMES_SORTED" | uniq)"
check "時刻が重複していない" "$(echo "$TIMES_SORTED" | wc -l | tr -d ' ')" \
  "$(echo "$TIMES_UNIQ" | wc -l | tr -d ' ')"


# 同じ Mac で Threads Research Tool が 7時・13時・21時に走り、最悪54分かかる。
# その帯に重ねると Chrome が2つ立ち上がって回線とCPUを食い合う
IN_BUSY="$(python3 -c "
import sys
busy = [(6*60+40, 8*60), (12*60+40, 14*60), (20*60+40, 22*60)]
bad = []
for t in '''$ALL_TIMES'''.split():
    h, m = t.split(':')
    x = int(h) * 60 + int(m)
    if any(a <= x < b for a, b in busy):
        bad.append(t)
print(' '.join(bad))
")"
check "Threads側の時間帯に重ねていない" "${IN_BUSY:-none}" "none"

echo
echo "結果: $PASS pass / $FAIL fail"
[ "$FAIL" -eq 0 ]
