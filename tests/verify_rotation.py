#!/usr/bin/env python3
"""
scripts/rotation.py（次に回す単位の選び方）を検証する。ブラウザも通信も使わない。

守りたいこと:
  1. 足したばかりのジャンル（一度も回していない単位）が最優先で回る
  2. それ以外は、最後に回してから一番時間が経っている単位から回る
  3. 記録ファイルが無い・壊れていても止まらない
  4. 実際の設定で、1日の枠のまま全単位を数日で一周する
"""

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from rotation import current_last_run, load_last_run, mark, pick, seed_from_store  # noqa: E402
from schedule import RUNS_PER_DAY, load_groups, plan_runs  # noqa: E402

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


G = ["あ", "い", "う", "え", "お"]

print("--- 選び方 ---")
check("記録が空なら設定の順", pick(G, {}, 3) == ["あ", "い", "う"], pick(G, {}, 3))
last = {"あ": "2026-09-28T08:00:00+09:00", "い": "2026-09-27T08:00:00+09:00",
        "う": "2026-09-28T10:00:00+09:00"}
check("未実行が先、次に古い順", pick(G, last, 5) == ["え", "お", "い", "あ", "う"], pick(G, last, 5))
check("数を超えて選ばない", len(pick(G, last, 2)) == 2, pick(G, last, 2))
check("0なら空", pick(G, last, 0) == [], None)
check("単位より多く求めても重複しない", pick(G, {}, 99) == G, pick(G, {}, 99))
check("設定に無い記録は無視する", pick(G, {"消えた": "2026-01-01T00:00:00+09:00"}, 2) == ["あ", "い"], None)

print("--- 記録 ---")
with tempfile.TemporaryDirectory() as d:
    state = Path(d) / "last_run.json"
    missing_data = Path(d) / "no_reels.json"
    check("記録ファイルが無ければ空", load_last_run(state) == {}, None)
    state.write_text("{壊れている", encoding="utf-8")
    check("壊れていても止まらない", load_last_run(state) == {}, None)
    state.write_text("[1, 2]", encoding="utf-8")
    check("形が違っても止まらない", load_last_run(state) == {}, None)
    state.unlink()
    mark("い", state, now="2026-09-28T09:00:00+09:00")
    mark("あ", state, now="2026-09-28T10:00:00+09:00")
    saved = json.loads(state.read_text(encoding="utf-8"))
    check("回した単位を時刻付きで残す", saved.get("い") == "2026-09-28T09:00:00+09:00", saved)
    check("前の記録を消さない", set(saved) >= {"あ", "い"}, saved)
    check("記録どおりに次を選ぶ", pick(G, load_last_run(state), 3) == ["う", "え", "お"],
          pick(G, load_last_run(state), 3))
    check("一時ファイルを残さない", not (Path(d) / "last_run.json.tmp").exists(), None)
    check("記録があれば蓄積は見ない",
          current_last_run(state, missing_data) == load_last_run(state), None)

print("--- 初回は蓄積データから割り出す ---")
# 記録ファイルが無い初回に全部を「未実行」にすると、毎日回っている既存ジャンルが
# 足したばかりのジャンルより先に選ばれてしまう
store = {"reels": {
    "1": {"genres": ["あ"], "last_updated": "2026-09-27T08:00:00+09:00"},
    "2": {"genres": ["あ", "い"], "last_updated": "2026-09-28T08:00:00+09:00"},
    "3": {"genres": ["う"], "last_updated": None},
    "4": {},
}}
seed = seed_from_store(store)
check("ジャンルごとに一番新しい時刻を取る", seed.get("あ") == "2026-09-28T08:00:00+09:00", seed)
check("掛け持ちのリールも数える", seed.get("い") == "2026-09-28T08:00:00+09:00", seed)
check("時刻が無いリールは数えない", "う" not in seed, seed)
check("足したばかりのジャンルが先に選ばれる", pick(G, seed, 3) == ["う", "え", "お"], pick(G, seed, 3))
with tempfile.TemporaryDirectory() as d:
    data = Path(d) / "reels.json"
    data.write_text(json.dumps(store), encoding="utf-8")
    state = Path(d) / "last_run.json"
    check("記録が無ければ蓄積から割り出す", current_last_run(state, data) == seed, None)
    check("蓄積も無ければ空", current_last_run(state, Path(d) / "none.json") == {}, None)

print("--- 実際の設定 ---")
groups = load_groups()
runs, per_run = plan_runs(len(groups))
# 1日の枠のまま、何回で一周するか。見送りが無ければ全単位を回り切ること
last = {}
seen = set()
t = 0
rounds = -(-len(groups) // per_run)
for _ in range(rounds):
    for g in pick(groups, last, per_run):
        t += 1
        last[g] = f"2026-10-01T00:00:{t:05d}"
        seen.add(g)
check(f"{rounds}回（{rounds / RUNS_PER_DAY:.1f}日）で全{len(groups)}単位を回る",
      seen == set(groups), sorted(set(groups) - seen))
# 見送られた回があっても、次の回で一番古いものから拾い直す
last = {g: f"2026-10-01T00:00:{i:05d}" for i, g in enumerate(groups)}
first = pick(groups, last, per_run)
check("一番古い単位から選ぶ", first == groups[:per_run], first)

print(f"\n結果: {PASS} pass / {FAIL} fail")
sys.exit(0 if FAIL == 0 else 1)
