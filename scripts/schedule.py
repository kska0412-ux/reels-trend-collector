#!/usr/bin/env python3
"""
自動実行の時刻を決める。install_launchd.sh から呼ばれる。

同じ Mac で Threads Research Tool も自動収集している。あちらは
7時・13時・21時に走り、最悪54分かかる（18語 × 1語あたり最悪3分）。
同じ帯で Instagram 側を動かすと Chrome が2つ立ち上がり、回線と CPU を
食い合って両方が遅くなる。その帯を避けて散らす。

  python3 scripts/schedule.py            時刻を1行1件で出す
  python3 scripts/schedule.py --explain  避けた帯と空き時間も出す

1回に複数ジャンルをまとめる。1ジャンルずつ散らすと、Mac を
日中ずっと開けておく必要がある。launchd は寝ている間の予定を
起きたときに1回だけ実行するので、回数が多いほど取りこぼしが増える。

どのジャンルを回すかは登録時には決めない。各回は `run_collect.sh --next 5` で
起動し、その時点で最後に回してから一番時間が経っている5単位を
scripts/rotation.py が選ぶ。ジャンルを足し引きしても launchd を
登録し直す必要が無く、見送られた回の単位も次の回で自然に拾われる。
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

# 1日に走らせる回数。1回あたりのジャンル数はこれで決まる。
# 増やすと1回は短くなるが、Mac を開けておく時間帯が増える。
# 減らすと1回が長くなり、Threads 側の帯にはみ出す危険が上がる。
# 4回にしているのは、1回あたり最悪2時間37分で空き枠に収まるため
# （1ジャンル最悪31分 × 5ジャンル）。3回だと最悪3時間39分になり、
# 空き枠（最大4時間40分）に対して余裕が無い。
RUNS_PER_DAY = 4

# 1ジャンルに要する時間（分）。置き場所を決めるのに使う。
#
# 最悪ケースは31分（3タグ ×（90秒タイムアウト2回＋やり直し5秒＋タグ間10秒）
# ＋ 10アカウント ×（遷移90秒＋描画待ち30秒＋間隔10秒））。
# ただし最悪を基準にすると、19ジャンルで9.8時間必要になり、
# Threads を避けた空き（280分＋400分の2枠）にどう並べても収まらない。
#
# 実測は1ジャンル約8分（ヘッドスパ）。その2倍を見込み値とする。
# 見込みを超えて長引いても、排他ロックで後発が見送られるだけで壊れない。
# 見送られたジャンルは翌日に回る。
MINUTES_PER_GENRE = 16

# 1回に回す単位の数。1日のアクセス量はこれ × RUNS_PER_DAY で決まる。
# 19単位を毎日回していた頃（2026-09-28 まで）と同じ量に据え置いている。
# 46単位に増えたので毎日全部は回さず、scripts/rotation.py が
# 最後に回してから一番時間が経っている単位を選ぶ（一周は約2.3日）。
# 増やすとアカウント停止の危険と Mac を開けておく時間が比例して増える。
UNITS_PER_RUN = 5


def busy_with_guard(windows=BUSY_WINDOWS, guard=GUARD_MINUTES):
    """避ける帯に、開始前の余白を足したもの。"""
    return [(start - guard, end) for start, end in windows]


def free_minutes(start=DAY_START, end=DAY_END, windows=None):
    """start〜end のうち、避ける帯に入らない分の一覧。"""
    windows = busy_with_guard() if windows is None else windows
    return [m for m in range(start, end)
            if not any(a <= m < b for a, b in windows)]


def free_blocks(free=None):
    """空いている分を、連続したかたまりに区切る。[(開始, 終了), ...]。"""
    free = free_minutes() if free is None else free
    blocks = []
    for m in free:
        if blocks and m == blocks[-1][1] + 1:
            blocks[-1][1] = m
        else:
            blocks.append([m, m])
    return [(a, b) for a, b in blocks]


def spread(count, free=None, need=0):
    """
    空いている時間に count 個の時刻を置く。返り値は [(時, 分), ...]。

    need は1回に要する分数。指定すると、そのぶん終わりまでに余裕がある
    位置にだけ置く。指定しないと最後の1回が枠の端に来て、実行が長引いた
    ときに Threads 側の帯へはみ出す。

    間隔を空けるのは、Instagram への連続アクセスを避けるため。
    まとめて回すとブロックされる危険が上がる。
    """
    free = free_minutes() if free is None else free
    if count <= 0 or not free:
        return []

    # 1回に need 分かかるとして、その時間内に次の「避ける帯」へ入らない位置だけ残す
    if need > 0:
        blocks = free_blocks(free)
        usable = []
        for start, end in blocks:
            limit = end - need + 1
            usable.extend(m for m in range(start, max(start, limit) + 1) if m <= end)
        # どのかたまりにも収まらないなら、諦めて元の空き全部から選ぶ。
        # 置かないより、遅れる危険を抱えてでも回すほうがまし
        if usable:
            free = usable

    if count == 1:
        return [divmod(free[0], 60)]
    if count >= len(free):
        # 空きより多いときは詰められるだけ詰める（重複させない）
        return [divmod(m, 60) for m in free[:count]]

    picked = []
    for i in range(count):
        step = (len(free) - 1) / (count - 1)
        want = free[round(i * step)]
        # 前の回が最悪ケースで終わるまでは始めない。重なると排他ロックで
        # 後発が丸ごと見送られ、そのジャンルは翌日まで収集されない。
        if picked and need > 0:
            floor = picked[-1] + need
            later = [m for m in free if m >= max(want, floor)]
            want = later[0] if later else free[-1]
        picked.append(want)
    return [divmod(m, 60) for m in picked]


def plan_runs(total, runs=RUNS_PER_DAY, per_run=UNITS_PER_RUN):
    """
    1日の実行回数と、1回あたりの単位数を返す。

    単位が少ないうちは、1日で全部回れる分だけに縮める（空回りさせない）。
    多いときは per_run で頭打ちにし、残りは翌日以降に回す。
    """
    if total <= 0 or runs <= 0:
        return 0, 0
    runs = min(runs, total)
    return runs, min(per_run, -(-total // runs))


def cycle_days(total, runs=RUNS_PER_DAY, per_run=UNITS_PER_RUN):
    """全単位を一周するのにかかる日数（見送りが無い場合）。"""
    r, p = plan_runs(total, runs, per_run)
    return total / (r * p) if r and p else 0.0


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
    runs, per_run = plan_runs(len(groups))
    need = per_run * MINUTES_PER_GENRE
    times = spread(runs, need=need)

    if args.explain:
        free = free_minutes()
        print(f"避ける帯（Threads 側 ＋ 手前{GUARD_MINUTES}分の余白）:")
        for a, b in busy_with_guard():
            print(f"  {a // 60:02d}:{a % 60:02d} 〜 {b // 60:02d}:{b % 60:02d}")
        print(f"空き時間: {len(free)} 分")
        print(f"巡回する単位: {len(groups)} 件 → 1日 {runs} 回 × {per_run} 単位"
              f"（一周 約 {cycle_days(len(groups)):.1f} 日）")
        if runs > 1:
            print(f"間隔: 約 {len(free) // (runs - 1)} 分")
        print()

    # 1行 = 1回ぶん。どの単位を回すかは実行時に rotation.py が決める。
    # run_collect.sh に渡す引数を空白区切りで出す
    for hour, minute in times:
        print(f"--next {per_run}\t{hour}\t{minute}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
