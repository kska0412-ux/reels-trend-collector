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

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from common import reach_ratio, FOLLOWER_FLOOR, ACCOUNT_TTL_DAYS  # noqa: E402

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

print(f"\n結果: {PASS} pass / {FAIL} fail")
sys.exit(0 if FAIL == 0 else 1)
