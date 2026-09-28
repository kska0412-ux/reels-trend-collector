#!/usr/bin/env python3
"""
自動実行の時刻の決め方を検証する。launchctl も通信も使わない。

守りたいこと:
  1. 同じ Mac で動く Threads Research Tool の時間帯に重ねない
  2. 掛け合わせ語も登録される（落とすと #サロン経営 などが永久に回らない）
  3. 時刻が重ならない（重なると Chrome が2つ立ち上がる）
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from common import CONFIG_FILE  # noqa: E402
from schedule import (  # noqa: E402
    BUSY_WINDOWS, DAY_END, DAY_START, GUARD_MINUTES, MINUTES_PER_GENRE,
    RUNS_PER_DAY, UNITS_PER_RUN, busy_with_guard, cycle_days, free_blocks,
    free_minutes, load_groups, plan_runs, spread,
)

PASS = 0
FAIL = 0


def check(label, cond, actual=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  OK   {label}")
    else:
        FAIL += 1
        print(f"  FAIL {label}  → 実際: {actual!r}")


def minutes(times):
    return [h * 60 + m for h, m in times]


print("--- 避ける帯 ---")
guarded = busy_with_guard()
check("Threads の3回ぶんある", len(guarded) == 3, guarded)
# 帯の直前に置くと、こちらが終わる前に向こうが始まる
check("開始前に余白を取る",
      all(g[0] == b[0] - GUARD_MINUTES for g, b in zip(guarded, BUSY_WINDOWS)), guarded)
check("終了時刻は動かさない",
      all(g[1] == b[1] for g, b in zip(guarded, BUSY_WINDOWS)), guarded)

print("--- 空き時間 ---")
free = free_minutes()
check("空きがある", len(free) > 0, len(free))
check("避ける帯が1分も混ざらない",
      not any(a <= m < b for m in free for a, b in guarded),
      [m for m in free if any(a <= m < b for a, b in guarded)][:5])
check("日中の範囲に収まる",
      all(DAY_START <= m < DAY_END for m in free),
      [m for m in free if not (DAY_START <= m < DAY_END)][:5])

print("--- 時刻の割り当て ---")
check("0件なら空", spread(0) == [], spread(0))
check("1件でも置ける", len(spread(1)) == 1, spread(1))

for count in (1, 2, 5, 12, 18, 30):
    times = spread(count)
    mins = minutes(times)
    label = f"{count}件"
    if not times:
        check(f"{label}: 置ける", False, times)
        continue
    ok_busy = not any(a <= m < b for m in mins for a, b in guarded)
    ok_dup = len(set(mins)) == len(mins)
    ok_order = all(mins[i] <= mins[i + 1] for i in range(len(mins) - 1))
    ok_range = all(DAY_START <= m < DAY_END for m in mins)
    check(f"{label}: 避ける帯に入らない", ok_busy,
          [t for t, m in zip(times, mins) if any(a <= m < b for a, b in guarded)])
    check(f"{label}: 時刻が重ならない", ok_dup, mins)
    check(f"{label}: 早い順に並ぶ", ok_order, mins)
    check(f"{label}: 日中に収まる", ok_range, mins)

# 詰め込みすぎたときに、黙って重ねない
huge = spread(len(free) + 50)
check("空きより多く求めても重ねない",
      len(set(minutes(huge))) == len(huge), len(huge))

print("--- 巡回する単位 ---")
config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
groups = load_groups()
check("主ジャンルを全部含む",
      all(g in groups for g in config["genres"]),
      [g for g in config["genres"] if g not in groups])
# ここを落とすと #サロン経営 などが永久に自動収集されない
check("掛け合わせ語も全部含む",
      all(m in groups for m in (config.get("modifiers") or {})),
      [m for m in (config.get("modifiers") or {}) if m not in groups])
check("重複しない", len(set(groups)) == len(groups), groups)
check("設定に書いた順を保つ",
      groups == list(config["genres"]) + list(config.get("modifiers") or {}), groups)

print("--- 6. 1日の回数と1回の単位数 ---")
# 46単位を毎日全部回すと Instagram へのアクセスが増え、Mac の空き枠にも
# 収まらない。1日のアクセス量は据え置き、残りは翌日以降に回す
groups = load_groups()
runs, per_run = plan_runs(len(groups))
check(f"1日 {RUNS_PER_DAY} 回", runs == RUNS_PER_DAY, runs)
check(f"1回 {UNITS_PER_RUN} 単位で頭打ち", per_run == UNITS_PER_RUN, per_run)
# 19単位を毎日回していた頃と同じ量。増やすとアカウント停止の危険が上がる
check("1日のアクセス量を増やしていない（20単位/日以下）", runs * per_run <= 20, runs * per_run)
days = cycle_days(len(groups))
check(f"一周が3日以内（{days:.1f}日）", days <= 3, days)
check("単位が少なければ1日で回りきる分に縮める", plan_runs(6) == (4, 2), plan_runs(6))
check("単位が回数より少なければ回数も縮める", plan_runs(2) == (2, 1), plan_runs(2))
check("0件なら回さない", plan_runs(0) == (0, 0), plan_runs(0))

print("--- 7. 実行が重ならない ---")
need = per_run * MINUTES_PER_GENRE
times = spread(runs, need=need)
starts = [h * 60 + m for h, m in times]
guarded = busy_with_guard()
check(f"{runs}回ぶん時刻を割り当てる", len(times) == runs, times)

# Threads と重なると Chrome が2つ立ち上がり、回線と CPU を食い合う
overlap_threads = []
for start in starts:
    end = start + need
    if any(start < b and end > a for a, b in guarded):
        overlap_threads.append(f"{start // 60:02d}:{start % 60:02d}")
check("Threads の帯に重ならない（見込み時間で）", overlap_threads == [], overlap_threads)

# 自分同士が重なると、排他ロックで後発が丸ごと見送られる
overlap_self = [(starts[i], starts[i + 1]) for i in range(len(starts) - 1)
                if starts[i + 1] < starts[i] + need]
check("自分同士も重ならない", overlap_self == [], overlap_self)

print("--- 8. 空き枠に収まる見積もりか ---")
blocks = free_blocks()
check("空き枠がある", len(blocks) > 0, blocks)
longest = max(b - a + 1 for a, b in blocks)
check(f"1回（{need}分）が一番長い枠（{longest}分）に収まる", need <= longest, (need, longest))
# 見込みを最悪ケースに置くとどう並べても収まらない。実測の2倍という置き方から外れていないこと
check("1ジャンルの見込みが実測（8分）以上", MINUTES_PER_GENRE >= 8, MINUTES_PER_GENRE)
check("最悪値（31分）そのままにしていない", MINUTES_PER_GENRE < 31, MINUTES_PER_GENRE)

print(f"\n結果: {PASS} pass / {FAIL} fail")
sys.exit(0 if FAIL == 0 else 1)
