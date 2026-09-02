#!/usr/bin/env python3
"""
build_html.py のデータ組み立てと絞り込みを検証する。

守りたいこと:
  1. 伸び率がフォロワー数から正しく計算される。取れなければ None
  2. 期間フィルタが投稿日時を基準にする。投稿日時が無いものは落とさない
  3. 件数を絞るとき、伸び率上位と新着上位を半分ずつ確保する
  4. 何件をどの理由で落としたかを返す（黙って捨てない）
"""
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import JST  # noqa: E402
from build_html import build_rows, select_rows, build_summary  # noqa: E402
from make_fixture import build as build_fixture  # noqa: E402

PASS = FAIL = 0


def check(label, cond, actual=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  OK   {label}")
    else:
        FAIL += 1
        print(f"  FAIL {label}  → 実際: {actual!r}")


NOW = datetime(2026, 9, 2, 7, 0, tzinfo=JST)
store = build_fixture(NOW)
rows = build_rows(store, now=NOW)
by_id = {r["id"]: r for r in rows}

print("--- 1. 行の組み立て ---")
check("28件すべて行になる", len(rows) == 28, len(rows))
r1 = by_id["r1"]
check("再生数が入る", r1["plays"] == 485_000, r1["plays"])
check("フォロワー数が入る", r1["followers"] == 1_900, r1["followers"])
check("伸び率が計算される", r1["ratio"] is not None and abs(r1["ratio"] - 485_000 / 1_900) < 0.1,
      r1["ratio"])
check("ジャンルが入る", r1["genres"] == ["顔まわり"], r1["genres"])
check("permalink が入る", r1["permalink"].startswith("https://www.instagram.com/reel/"),
      r1["permalink"])

print("--- 2. フォロワー数が取れていない場合 ---")
r25 = by_id["r25"]
check("伸び率は None", r25["ratio"] is None, r25["ratio"])
check("フォロワー数も None", r25["followers"] is None, r25["followers"])
check("再生数はそのまま持つ", r25["plays"] == 999_999, r25["plays"])

print("--- 3. 下限クランプ ---")
r26 = by_id["r26"]
check("フォロワー20人は500人扱い（×20）", abs(r26["ratio"] - 20.0) < 0.01, r26["ratio"])

print("--- 4. 投稿時刻が取れていない場合 ---")
r27 = by_id["r27"]
check("ageHours は None", r27["ageHours"] is None, r27["ageHours"])
check("postedAt は空文字", r27["postedAt"] == "", r27["postedAt"])

print("--- 5. 期間フィルタ ---")
selected, aged_out, over_cap = select_rows(rows, 180, 0)
ids = {r["id"] for r in selected}
check("1年前のリールは落ちる", "r28" not in ids, sorted(ids))
check("落ちたのは1件", aged_out == 1, aged_out)
check("投稿時刻が無いリールは残る", "r27" in ids, sorted(ids))
check("上限で落ちたのは0件", over_cap == 0, over_cap)
selected_all, aged_all, _ = select_rows(rows, 0, 0)
check("max_age_days=0 なら期間で落とさない", aged_all == 0 and len(selected_all) == 28,
      (aged_all, len(selected_all)))

print("--- 6. 件数の上限と、伸び率上位・新着上位の半々確保 ---")
selected, aged_out, over_cap = select_rows(rows, 0, 6)
check("6件に絞られる", len(selected) == 6, len(selected))
check("落とした件数を返す", over_cap == 28 - 6, over_cap)
ids = {r["id"] for r in selected}

ranked = [r for r in rows if r["ratio"] is not None]
top_ratio = sorted(ranked, key=lambda r: -r["ratio"])[:3]
check("伸び率上位3件が全部入っている",
      all(r["id"] in ids for r in top_ratio), [r["id"] for r in top_ratio])

dated = [r for r in rows if r["ageHours"] is not None]
newest = sorted(dated, key=lambda r: r["ageHours"])[:3]
check("新着上位3件が全部入っている",
      all(r["id"] in ids for r in newest), [r["id"] for r in newest])

print("--- 7. 上限に届かないときは絞らない ---")
selected, _, over_cap = select_rows(rows, 0, 1000)
check("全件そのまま", len(selected) == 28, len(selected))
check("落とした件数は0", over_cap == 0, over_cap)

print("--- 8. 重複を二重に数えない ---")
# 伸び率上位と新着上位が重なっても、合計が上限を超えないこと
selected, _, _ = select_rows(rows, 0, 4)
check("4件ちょうど", len(selected) == 4, len(selected))
check("id が重複しない", len({r["id"] for r in selected}) == 4,
      [r["id"] for r in selected])

print("--- 9. 集計 ---")
summary = build_summary(rows, store, archived=28)
check("総数", summary["total"] == 28, summary["total"])
check("ジャンルが4種", len(summary["genres"]) == 4, summary["genres"])
check("ジャンルは件数の多い順", 
      all(summary["genres"][i][1] >= summary["genres"][i + 1][1]
          for i in range(len(summary["genres"]) - 1)), summary["genres"])
check("アカウント数", summary["authors"] == len({r["username"] for r in rows}),
      summary["authors"])
check("伸び率100倍超の件数が数えられている",
      summary["over100"] == len([r for r in rows if r["ratio"] is not None
                                 and r["ratio"] >= 100]), summary["over100"])
check("今週の件数", summary["thisWeek"] == len([r for r in rows
                                            if r["ageHours"] is not None
                                            and r["ageHours"] <= 168]),
      summary["thisWeek"])

print(f"\n結果: {PASS} pass / {FAIL} fail")
sys.exit(0 if FAIL == 0 else 1)
