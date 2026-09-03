#!/usr/bin/env python3
"""
自動実行の時刻を決める。install_launchd.sh から呼ばれる。

同じ Mac で Threads Research Tool も自動収集している。あちらは
7時・13時・21時に走り、最悪54分かかる（18語 × 1語あたり最悪3分）。
同じ帯で Instagram 側を動かすと Chrome が2つ立ち上がり、回線と CPU を
食い合って両方が遅くなる。その帯を避けて散らす。

  python3 scripts/schedule.py            時刻を1行1件で出す
  python3 scripts/schedule.py --explain  避けた帯と空き時間も出す

1回に複数ジャンルをまとめる。1ジャンルずつ19回に散らすと、Mac を
日中ずっと開けておく必要がある。launchd は寝ている間の予定を
起きたときに1回だけ実行するので、回数が多いほど取りこぼしが増える。
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


def make_batches(groups, runs=RUNS_PER_DAY):
    """
    巡回する単位を runs 個のまとまりに分ける。設定に書いた順は崩さない。

    余りが出るときは前のまとまりから1つずつ多く持たせる。
    後ろに寄せると最後の1回だけ長くなり、夜の枠からはみ出しやすい。
    """
    if runs <= 0 or not groups:
        return []
    runs = min(runs, len(groups))
    size, extra = divmod(len(groups), runs)
    out = []
    i = 0
    for n in range(runs):
        take = size + (1 if n < extra else 0)
        out.append(groups[i:i + take])
        i += take
    return out


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
    batches = make_batches(groups)
    # 一番大きいまとまりに合わせて余裕を見る
    need = max((len(b) for b in batches), default=0) * MINUTES_PER_GENRE
    times = spread(len(batches), need=need)

    if args.explain:
        free = free_minutes()
        print(f"避ける帯（Threads 側 ＋ 手前{GUARD_MINUTES}分の余白）:")
        for a, b in busy_with_guard():
            print(f"  {a // 60:02d}:{a % 60:02d} 〜 {b // 60:02d}:{b % 60:02d}")
        print(f"空き時間: {len(free)} 分")
        print(f"巡回する単位: {len(groups)} 件 → {len(batches)} 回にまとめる")
        if len(batches) > 1:
            print(f"間隔: 約 {len(free) // (len(batches) - 1)} 分")
        print()

    # 1行 = 1回ぶん。ジャンルはタブではなく空白で区切って並べる
    for batch, (hour, minute) in zip(batches, times):
        print(f"{' '.join(batch)}\t{hour}\t{minute}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
