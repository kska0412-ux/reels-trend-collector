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
    BUSY_WINDOWS, DAY_END, DAY_START, GUARD_MINUTES,
    busy_with_guard, free_minutes, load_groups, spread,
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

print("--- 実際の設定での割り当て ---")
times = spread(len(groups))
check(f"{len(groups)}件ぶん割り当てる", len(times) == len(groups), len(times))
mins = minutes(times)
check("Threads の時間帯に1件も入らない",
      not any(a <= m < b for m in mins for a, b in guarded),
      [f"{h:02d}:{m:02d}" for (h, m), x in zip(times, mins)
       if any(a <= x < b for a, b in guarded)])
gaps = [mins[i + 1] - mins[i] for i in range(len(mins) - 1)]
# 間隔が詰まりすぎると、前の収集が終わる前に次が始まる
check("間隔が30分以上ある", min(gaps) >= 30, min(gaps))
print(f"       （最小 {min(gaps)} 分 / 最大 {max(gaps)} 分）")

print(f"\n結果: {PASS} pass / {FAIL} fail")
sys.exit(0 if FAIL == 0 else 1)
