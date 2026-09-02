#!/usr/bin/env python3
"""
collect.py のマージ処理を検証する。ブラウザも通信も使わない。

守りたいこと:
  1. 同じリールを重複させない
  2. 再収集で再生数・いいね・コメントを最新に更新する
  3. 複数タグでヒットしたらジャンルとタグを積み上げる
  4. フォロワー数キャッシュが7日で切れる
  5. 取れなかった値で既存の値を上書きしない
"""
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from common import JST, ACCOUNT_TTL_DAYS  # noqa: E402
from collect import (  # noqa: E402
    merge_reels, merge_accounts, fresh_accounts, is_relevant,
)

PASS = FAIL = 0


def check(label, cond, actual=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  OK   {label}")
    else:
        FAIL += 1
        print(f"  FAIL {label}  → 実際: {actual!r}")


def empty_store():
    return {"reels": {}, "accounts": {}}


def reel(**over):
    base = {
        "id": "111", "code": "C1abc", "username": "example_nail",
        "caption": "セルフでこれできたら勝ち",
        "timestamp": "2026-08-30T12:00:00+0000",
        "permalink": "https://www.instagram.com/reel/C1abc/",
        "play_count": 298000, "like_count": 12400, "comment_count": 89,
    }
    base.update(over)
    return base


T0 = "2026-09-01T07:00:00+09:00"
T1 = "2026-09-02T07:00:00+09:00"

print("--- 1. 新規の取り込み ---")
store = empty_store()
new, updated = merge_reels(store, [reel()], "ネイル", "ネイルデザイン", T0)
check("新規1件", (new, updated) == (1, 0), (new, updated))
r = store["reels"]["111"]
check("ジャンルが入る", r["genres"] == ["ネイル"], r["genres"])
check("タグが入る", r["hashtags_hit"] == ["ネイルデザイン"], r["hashtags_hit"])
check("first_seen が入る", r["first_seen"] == T0, r["first_seen"])
check("last_updated が入る", r["last_updated"] == T0, r["last_updated"])
check("再生数が入る", r["play_count"] == 298000, r["play_count"])

print("--- 2. 重複排除と数値の更新 ---")
new, updated = merge_reels(store, [reel(play_count=350000, like_count=15000)],
                           "ネイル", "ネイルデザイン", T1)
check("新規0・更新1", (new, updated) == (0, 1), (new, updated))
check("蓄積は1件のまま", len(store["reels"]) == 1, len(store["reels"]))
r = store["reels"]["111"]
check("再生数が最新に更新される", r["play_count"] == 350000, r["play_count"])
check("いいねが最新に更新される", r["like_count"] == 15000, r["like_count"])
check("first_seen は変わらない", r["first_seen"] == T0, r["first_seen"])
check("last_updated は更新される", r["last_updated"] == T1, r["last_updated"])

print("--- 3. 複数タグ・複数ジャンルの積み上げ ---")
merge_reels(store, [reel()], "ネイル", "セルフネイル", T1)
check("同じジャンルは重複しない", store["reels"]["111"]["genres"] == ["ネイル"],
      store["reels"]["111"]["genres"])
check("タグは積み上がる",
      store["reels"]["111"]["hashtags_hit"] == ["ネイルデザイン", "セルフネイル"],
      store["reels"]["111"]["hashtags_hit"])
merge_reels(store, [reel()], "アイラッシュ", "まつげパーマ", T1)
check("ジャンルも積み上がる", store["reels"]["111"]["genres"] == ["ネイル", "アイラッシュ"],
      store["reels"]["111"]["genres"])

print("--- 4. 取れなかった値で既存を上書きしない ---")
# 見たいのは「None を渡したとき、直前の値が保たれるか」。
# 直前の値を決め打ちにすると、前の章が値を書き換えたときに壊れる。
# だからマージ前の値を控えておいて、それと比べる。
before_likes = store["reels"]["111"]["like_count"]
before_comments = store["reels"]["111"]["comment_count"]
check("比較の基準になる値が入っている（この検証が空回りしていないこと）",
      before_likes is not None and before_comments is not None,
      (before_likes, before_comments))
merge_reels(store, [reel(like_count=None, comment_count=None)], "ネイル", "ネイルデザイン", T1)
check("いいねが None で潰されない",
      store["reels"]["111"]["like_count"] == before_likes,
      (store["reels"]["111"]["like_count"], before_likes))
check("コメントが None で潰されない",
      store["reels"]["111"]["comment_count"] == before_comments,
      (store["reels"]["111"]["comment_count"], before_comments))

print("--- 5. id が無いものは捨てる ---")
store2 = empty_store()
new, updated = merge_reels(store2, [reel(id=None), reel(id="")], "ネイル", "x", T0)
check("1件も入らない", len(store2["reels"]) == 0, len(store2["reels"]))
check("件数も0", (new, updated) == (0, 0), (new, updated))

print("--- 6. フォロワー数のマージ ---")
store3 = empty_store()
new, updated = merge_accounts(store3, {"example_nail": 15677, "no_data": None}, T0)
check("取れた1件だけ入る", len(store3["accounts"]) == 1, store3["accounts"])
check("新規1件", new == 1, new)
check("値が入る", store3["accounts"]["example_nail"]["follower_count"] == 15677,
      store3["accounts"]["example_nail"])
check("取得時刻が入る", store3["accounts"]["example_nail"]["fetched_at"] == T0, None)
check("取れなかったアカウントは登録しない", "no_data" not in store3["accounts"],
      list(store3["accounts"]))
new, updated = merge_accounts(store3, {"example_nail": 16000}, T1)
check("再取得で更新される", store3["accounts"]["example_nail"]["follower_count"] == 16000,
      store3["accounts"]["example_nail"])
check("新規0・更新1", (new, updated) == (0, 1), (new, updated))

print("--- 7. フォロワー数キャッシュの期限 ---")
now = datetime(2026, 9, 2, 7, 0, tzinfo=JST)
store4 = {"reels": {}, "accounts": {
    "fresh_user": {"follower_count": 100,
                   "fetched_at": (now - timedelta(days=1)).isoformat()},
    "stale_user": {"follower_count": 200,
                   "fetched_at": (now - timedelta(days=ACCOUNT_TTL_DAYS + 1)).isoformat()},
    "edge_user": {"follower_count": 300,
                  "fetched_at": (now - timedelta(days=ACCOUNT_TTL_DAYS,
                                                 hours=-1)).isoformat()},
    "broken_user": {"follower_count": 400, "fetched_at": "こわれた日付"},
    "no_time_user": {"follower_count": 500},
}}
fresh = set(fresh_accounts(store4, now))
check("1日前は新しい", "fresh_user" in fresh, sorted(fresh))
check("8日前は古い（取り直す）", "stale_user" not in fresh, sorted(fresh))
check("7日ぎりぎり手前は新しい", "edge_user" in fresh, sorted(fresh))
check("日付が壊れていたら取り直す", "broken_user" not in fresh, sorted(fresh))
check("取得時刻が無ければ取り直す", "no_time_user" not in fresh, sorted(fresh))

print("--- 8. 関連度フィルタ ---")
words = ["ネイル", "爪", "ジェル"]
check("必須語を含めば通る", is_relevant("今日のネイルデザイン", words))
check("必須語が無ければ落とす", not is_relevant("今日のランチ", words))
check("キャプションが空なら通す（判定材料が無いため）", is_relevant("", words))
check("キャプションが None でも通す", is_relevant(None, words))
check("必須語が空ならフィルタしない", is_relevant("今日のランチ", []))

print(f"\n結果: {PASS} pass / {FAIL} fail")
sys.exit(0 if FAIL == 0 else 1)
