#!/usr/bin/env python3
"""
build_html.py のデータ組み立てと絞り込みを検証する。

守りたいこと:
  1. 伸び率がフォロワー数から正しく計算される。取れなければ None
  2. 期間フィルタが投稿日時を基準にする。投稿日時が無いものは落とさない
  3. 件数を絞るとき、伸び率上位と新着上位を半分ずつ確保する
  4. 何件をどの理由で落としたかを返す（黙って捨てない）
"""
import json
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import JST  # noqa: E402
from build_html import build_rows, select_rows, build_summary  # noqa: E402
from make_fixture import build as build_fixture, GENRES  # noqa: E402

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
check("ジャンルが入る", r1["genres"] == [GENRES[1 % 19]], r1["genres"])
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
# 時刻が取れないリールも扱えること。フィクスチャを汚さずここで作る。
no_time_store = build_fixture(NOW)
no_time_store["reels"]["r27"]["timestamp"] = None
nt_rows = build_rows(no_time_store, now=NOW)
nt = next(r for r in nt_rows if r["id"] == "r27")
check("ageHours は None", nt["ageHours"] is None, nt["ageHours"])
check("postedAt は空文字", nt["postedAt"] == "", nt["postedAt"])

print("--- 5. 期間フィルタ ---")
selected, aged_out, over_cap = select_rows(rows, 180, 0)
ids = {r["id"] for r in selected}
check("1年前のリールは落ちる", "r28" not in ids, sorted(ids))
check("落ちたのは1件", aged_out == 1, aged_out)
nt_selected, _, _ = select_rows(nt_rows, 180, 0)
nt_ids = {r["id"] for r in nt_selected}
check("投稿時刻が無いリールは残る", "r27" in nt_ids, sorted(nt_ids))
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
check("ジャンルが19種", len(summary["genres"]) == 19, summary["genres"])
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

print("--- 10. 伸び率が取れていない行は並び順の最後 ---")
# build_rows は伸び率の降順で返す。取れなかった行（None）は必ず末尾に固まる。
# ここが崩れると、既定の「伸び率順」表示の先頭に「—」の行が並ぶ。
ratios = [r["ratio"] for r in rows]
first_none = next((i for i, v in enumerate(ratios) if v is None), len(ratios))
check("None より後ろに数値が現れない",
      all(v is None for v in ratios[first_none:]), ratios[first_none:])
check("None の行が実際に存在する（この検証が空回りしていないこと）",
      first_none < len(ratios), first_none)
known = [v for v in ratios if v is not None]
check("数値どうしは降順に並ぶ",
      all(known[i - 1] >= known[i] for i in range(1, len(known))), known[:5])

# select_rows を通しても末尾のままであること
selected_all, _, _ = select_rows(rows, 0, 0)
sel_ratios = [r["ratio"] for r in selected_all]
sel_first_none = next((i for i, v in enumerate(sel_ratios) if v is None), len(sel_ratios))
check("select_rows を通しても None は末尾のまま",
      all(v is None for v in sel_ratios[sel_first_none:]), sel_ratios[sel_first_none:])

print("--- 11. コマンドとして動かす（黙って捨てないことの確認） ---")
# main() は「何件をどの理由で載せなかったか」を人間に見せる唯一の場所。
# 通信もブラウザも使わず、フィクスチャを一時ファイルに書いて実際に起動する。
BUILD = Path(__file__).resolve().parent.parent / "scripts" / "build_html.py"

with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    fixture = tmp / "fixture_reels.json"
    fixture.write_text(json.dumps(store, ensure_ascii=False), encoding="utf-8")

    def run_build(*args):
        return subprocess.run(
            [sys.executable, str(BUILD), "--input", str(fixture),
             "--output", str(tmp / "out.html"), *args],
            capture_output=True, text=True,
        )

    # 何も落ちないとき: 「載せなかった分」を出さない
    r = run_build("--max-age-days", "0", "--max-reels", "0")
    check("終了コード0", r.returncode == 0, (r.returncode, r.stderr[:200]))
    check("生成した旨を出す", "生成しました" in r.stdout, r.stdout[:200])
    check("何も落ちなければ内訳を出さない",
          "載せなかった分" not in r.stdout, r.stdout[:300])
    check("HTMLが実際に書き出される", (tmp / "out.html").exists(), None)

    # 期間と件数の両方で落ちるとき: 両方の内訳を数字つきで出す
    # フィクスチャ28件のうち1年前の1件が期間で落ち、残り27件が上限4件で23件落ちる
    r = run_build("--max-age-days", "180", "--max-reels", "4")
    check("終了コード0", r.returncode == 0, (r.returncode, r.stderr[:200]))
    check("載せなかった分の見出しを出す", "載せなかった分" in r.stdout, r.stdout[:400])
    check("期間で落ちた件数を出す", "180 日より古い: 1 件" in r.stdout, r.stdout[:400])
    check("上限で落ちた件数を出す", "上限 4 件を超過: 23 件" in r.stdout, r.stdout[:400])
    check("元データは残っている旨を出す",
          "全件そのまま残っています" in r.stdout, r.stdout[:400])

    # 入力が無いとき: 黙って成功しない
    r = subprocess.run(
        [sys.executable, str(BUILD), "--input", str(tmp / "nope.json"),
         "--output", str(tmp / "out2.html")],
        capture_output=True, text=True,
    )
    check("入力が無ければ終了コード1", r.returncode == 1, r.returncode)
    check("入力が無ければ [NG] を出す", "[NG]" in r.stdout, r.stdout[:200])
    check("入力が無ければHTMLを書かない", not (tmp / "out2.html").exists(), None)

    # 0件のデータで、既にある正しいページを上書きしない
    empty = tmp / "empty.json"
    empty.write_text(json.dumps({"reels": {}, "accounts": {}}), encoding="utf-8")
    good = (tmp / "out.html").read_text(encoding="utf-8")
    r = subprocess.run(
        [sys.executable, str(BUILD), "--input", str(empty),
         "--output", str(tmp / "out.html")], capture_output=True, text=True)
    check("0件なら終了コード1", r.returncode == 1, (r.returncode, r.stdout[:200]))
    check("0件なら上書きしないと言う", "上書きしません" in r.stdout, r.stdout[:300])
    check("既存のページが残っている",
          (tmp / "out.html").read_text(encoding="utf-8") == good, None)
    r = subprocess.run(
        [sys.executable, str(BUILD), "--input", str(empty),
         "--output", str(tmp / "out.html"), "--allow-empty"], capture_output=True, text=True)
    check("--allow-empty なら上書きする", r.returncode == 0, (r.returncode, r.stdout[:200]))

print("--- 12. タイムゾーンの無い時刻が混ざっても落ちない ---")
# 実データに1件でも混ざると、以後すべての build_html.py が例外で死ぬ経路だった。
poisoned = build_fixture(NOW)
poisoned["reels"]["naive1"] = dict(poisoned["reels"]["r1"])
poisoned["reels"]["naive1"]["id"] = "naive1"
poisoned["reels"]["naive1"]["timestamp"] = "2026-08-30T12:00:00"
try:
    prows = build_rows(poisoned, now=NOW)
    check("build_rows が例外を投げない", True)
    naive = next(r for r in prows if r["id"] == "naive1")
    check("投稿日時は取れなかった扱い", naive["ageHours"] is None, naive["ageHours"])
    check("それでも行としては残る（期間フィルタで落とさない）",
          naive["id"] in {r["id"] for r in select_rows(prows, 180, 0)[0]}, None)
except Exception as e:
    check("build_rows が例外を投げない", False, f"{type(e).__name__}: {e}")

print(f"\n結果: {PASS} pass / {FAIL} fail")
sys.exit(0 if FAIL == 0 else 1)
