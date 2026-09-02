#!/usr/bin/env python3
"""
伸び率の計算を検証する。

守りたいこと:
  1. 取れなかった値を 0 で埋めない。None のまま返す
  2. フォロワーが極端に少ないアカウントで伸び率が跳ね上がらない（下限クランプ）
  3. 0 で割らない
"""
import sys
from pathlib import Path
from datetime import datetime, timezone, timedelta

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from common import reach_ratio, parse_timestamp, now_jst_iso, FOLLOWER_FLOOR, ACCOUNT_TTL_DAYS  # noqa: E402

PASS = FAIL = 0


def check(label, cond, actual=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  OK   {label}")
    else:
        FAIL += 1
        print(f"  FAIL {label}  → 実際: {actual!r}")


print("--- 1. 定数 ---")
check("FOLLOWER_FLOOR は 500", FOLLOWER_FLOOR == 500, FOLLOWER_FLOOR)
check("ACCOUNT_TTL_DAYS は 7", ACCOUNT_TTL_DAYS == 7, ACCOUNT_TTL_DAYS)

print("--- 2. 通常の計算 ---")
r = reach_ratio(300000, 2100)
check("30万再生 ÷ 2100フォロワー ≒ 142.9", r is not None and abs(r - 142.857) < 0.01, r)
r = reach_ratio(300000, 500000)
check("30万再生 ÷ 50万フォロワー = 0.6", r is not None and abs(r - 0.6) < 1e-9, r)

print("--- 3. 下限クランプ ---")
r = reach_ratio(10000, 20)
check("フォロワー20人は500人として計算する（×20）",
      r is not None and abs(r - 20.0) < 1e-9, r)
r = reach_ratio(10000, 499)
check("499人も500人として計算する", r is not None and abs(r - 20.0) < 1e-9, r)
r = reach_ratio(10000, 501)
check("501人はそのまま使う", r is not None and abs(r - 10000 / 501) < 1e-9, r)
check("クランプの境界で伸び率が下がる", reach_ratio(10000, 20) >= reach_ratio(10000, 501), None)

print("--- 4. 取れなかった値は None（0 で埋めない） ---")
check("フォロワー数が None なら None", reach_ratio(10000, None) is None, reach_ratio(10000, None))
check("フォロワー数が 0 なら None（0で割らない）",
      reach_ratio(10000, 0) is None, reach_ratio(10000, 0))
check("フォロワー数が負なら None", reach_ratio(10000, -5) is None, reach_ratio(10000, -5))
check("再生数が None なら None", reach_ratio(None, 5000) is None, reach_ratio(None, 5000))
check("再生数が負なら None", reach_ratio(-1, 5000) is None, reach_ratio(-1, 5000))
check("両方 None なら None", reach_ratio(None, None) is None, None)

print("--- 5. 型の厳密さ ---")
check("再生数が文字列なら None", reach_ratio("10000", 5000) is None, reach_ratio("10000", 5000))
check("フォロワー数が文字列なら None", reach_ratio(10000, "5000") is None,
      reach_ratio(10000, "5000"))
check("bool は数値として扱わない", reach_ratio(True, 5000) is None, reach_ratio(True, 5000))

print("--- 6. 再生数 0 は有効な値 ---")
check("0再生は伸び率 0.0（None ではない）",
      reach_ratio(0, 5000) == 0.0, reach_ratio(0, 5000))

print("--- 7. 時刻のパース ---")
# Task 8 は取得時刻（コロン付きオフセット）、Task 9 は投稿時刻（コロン無し）を渡す。
# 両方が通らないと片方のタスクが壊れる。
posted = parse_timestamp("2026-08-30T12:00:00+0000")
check("投稿時刻（コロン無しオフセット）が通る", posted is not None, posted)
check("投稿時刻の中身が正しい",
      posted is not None and posted.year == 2026 and posted.month == 8
      and posted.day == 30 and posted.hour == 12, posted)
check("投稿時刻のオフセットは UTC",
      posted is not None and posted.utcoffset() == timedelta(0), posted)

fetched = parse_timestamp("2026-09-02T07:00:00+09:00")
check("取得時刻（コロン付きオフセット）が通る", fetched is not None, fetched)
check("取得時刻のオフセットは +09:00",
      fetched is not None and fetched.utcoffset() == timedelta(hours=9), fetched)

print("--- 8. パースできないものは None（例外を投げない） ---")
check("壊れた文字列は None", parse_timestamp("こわれた日付") is None, None)
check("空文字は None", parse_timestamp("") is None, None)
check("None は None", parse_timestamp(None) is None, None)
# data/reels.json は人が手で編集しうる。数値が紛れ込んでも実行ごと落とさない。
for bad in (12345, True, 3.14, {"a": 1}, ["x"]):
    try:
        got = parse_timestamp(bad)
        check(f"{bad!r} は None（例外を投げない）", got is None, got)
    except Exception as e:
        check(f"{bad!r} は None（例外を投げない）", False, f"{type(e).__name__}: {e}")

check("タイムゾーンの無い時刻は None（引き算で落ちないため）",
      parse_timestamp("2026-08-30T12:00:00") is None,
      parse_timestamp("2026-08-30T12:00:00"))
check("日付だけの文字列も None", parse_timestamp("2026-08-30") is None,
      parse_timestamp("2026-08-30"))

print("--- 9. 現在時刻の書式 ---")
now_str = now_jst_iso()
check("ISO8601 の文字列を返す", isinstance(now_str, str) and "T" in now_str, now_str)
check("JST のオフセットが付く", now_str.endswith("+09:00"), now_str)
parsed_back = parse_timestamp(now_str)
check("自分が出した文字列を自分で読み戻せる",
      parsed_back is not None and parsed_back.utcoffset() == timedelta(hours=9), parsed_back)

print(f"\n結果: {PASS} pass / {FAIL} fail")
sys.exit(0 if FAIL == 0 else 1)
