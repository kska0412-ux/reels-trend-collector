#!/usr/bin/env python3
"""
自動実行の時刻を決める。install_launchd.sh から呼ばれる。

同じ Mac で Threads Research Tool も自動収集している。あちらは
7時・13時・21時に走り、最悪54分かかる（18語 × 1語あたり最悪3分）。
同じ帯で Instagram 側を動かすと Chrome が2つ立ち上がり、回線と CPU を
食い合って両方が遅くなる。その帯を避けて散らす。

  python3 scripts/schedule.py            時刻を1行1件で出す
  python3 scripts/schedule.py --explain  避けた帯と空き時間も出す
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import CONFIG_FILE  # noqa: E402

# Threads 側が動く帯（分単位、その日の0時から数えた分）。
# 開始時刻の手前にも余白を取る。ちょうど手前に置くと、こちらの収集が
# 終わる前に向こうが始まってしまう。
GUARD_MINUTES = 20
BUSY_WINDOWS = [
    (7 * 60, 8 * 60),    # Threads 朝
    (13 * 60, 14 * 60),  # Threads 昼
    (21 * 60, 22 * 60),  # Threads 夜
]

# こちらを動かす帯。深夜は Mac が寝ている可能性が高いので避ける。
DAY_START = 8 * 60    # 08:00
DAY_END = 21 * 60     # 21:00


def busy_with_guard(windows=BUSY_WINDOWS, guard=GUARD_MINUTES):
    """避ける帯に、開始前の余白を足したもの。"""
    return [(start - guard, end) for start, end in windows]


def free_minutes(start=DAY_START, end=DAY_END, windows=None):
    """start〜end のうち、避ける帯に入らない分の一覧。"""
    windows = busy_with_guard() if windows is None else windows
    return [m for m in range(start, end)
            if not any(a <= m < b for a, b in windows)]


def spread(count, free=None):
    """
    空いている時間に count 個の時刻を等間隔で置く。返り値は [(時, 分), ...]。

    等間隔にするのは、Instagram への連続アクセスを避けるため。
    まとめて回すとブロックされる危険が上がる。
    """
    free = free_minutes() if free is None else free
    if count <= 0 or not free:
        return []
    if count == 1:
        return [divmod(free[0], 60)]
    if count >= len(free):
        # 空きより多いときは詰められるだけ詰める（重複させない）
        return [divmod(m, 60) for m in free[:count]]
    step = (len(free) - 1) / (count - 1)
    return [divmod(free[round(i * step)], 60) for i in range(count)]


def load_groups(path=CONFIG_FILE):
    """
    巡回する単位を設定の順に返す。主ジャンルと掛け合わせ語の両方。

    掛け合わせ語を落とすと #サロン経営 などが永久に自動収集されない。
    """
    config = json.loads(Path(path).read_text(encoding="utf-8"))
    return list(config.get("genres", {})) + list(config.get("modifiers") or {})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=CONFIG_FILE)
    parser.add_argument("--explain", action="store_true",
                        help="避けた帯と空き時間も表示する")
    args = parser.parse_args()

    groups = load_groups(args.config)
    times = spread(len(groups))

    if args.explain:
        free = free_minutes()
        print(f"避ける帯（Threads 側 ＋ 手前{GUARD_MINUTES}分の余白）:")
        for a, b in busy_with_guard():
            print(f"  {a // 60:02d}:{a % 60:02d} 〜 {b // 60:02d}:{b % 60:02d}")
        print(f"空き時間: {len(free)} 分 / 登録するもの: {len(groups)} 件")
        if len(groups) > 1:
            print(f"間隔: 約 {len(free) // (len(groups) - 1)} 分")
        print()

    for group, (hour, minute) in zip(groups, times):
        print(f"{group}\t{hour}\t{minute}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
