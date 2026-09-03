#!/usr/bin/env python3
"""
投稿時刻の復元を検証する。通信もブラウザも使わない。

守りたいこと:
  1. 実在のコードから、実際の投稿時刻に近い値が出る
  2. 読めないコードから、ありえない日付を作らない
  3. 既に時刻があるリールを上書きしない
  4. 復元値だと分かる印を立てる（取れた時刻と同じ顔で見せない）
"""

import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from backfill_timestamps import backfill, timestamp_from_code  # noqa: E402

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


print("--- 1. 実在のコードから復元する ---")
# 実ブラウザでリール個別ページを開き、taken_at と突き合わせた実データ。
# DclRMswTDoi の実際の投稿は 1787917097（2026-08-28 20:38:17 JST）
REAL_CODE = "DclRMswTDoi"
REAL_TAKEN_AT = 1787917097

got = timestamp_from_code(REAL_CODE)
check("復元できる", got is not None, got)
diff_min = abs(got.timestamp() - REAL_TAKEN_AT) / 60
# 復元値には誤差がある。実測は2.4分だった。10分を超えたら作りが壊れている
check(f"実際の投稿時刻との差が10分以内（実測 {diff_min:.1f} 分）", diff_min < 10, diff_min)
check("タイムゾーンを持つ", got.tzinfo is not None, got)

older = timestamp_from_code("DZzebCHRSjF")   # 2026-06-20 ごろ
newer = timestamp_from_code("DclRMswTDoi")   # 2026-08-28 ごろ
# 順序が逆だと新着順が壊れる
check("新しいコードほど後の時刻になる", newer > older, (older, newer))

print("--- 2. 読めないコードから日付を作らない ---")
for bad in ["", "###", "あいうえお", None, 42, "A", "zzzzzzzzzzzzzzzz"]:
    check(f"{bad!r} は None", timestamp_from_code(bad) is None, timestamp_from_code(bad))
# 未来の日付を作らない関門が効いていること
check("未来になるコードは弾く",
      timestamp_from_code("zzzzzzzzzzzz", now=1000000000) is None, None)

print("--- 3. JS 側の復元と一致する ---")
# 画面用（JS）と埋め戻し用（Python）で式がずれると、
# 新しく入るリールと古いリールで時刻の基準が変わってしまう
js = subprocess.run(
    ["node", "-e",
     "import('./scripts/extract_reel_dom.mjs').then(m =>"
     " console.log(m.timestampFromCode('DclRMswTDoi')))"],
    capture_output=True, text=True,
    cwd=str(Path(__file__).resolve().parent.parent),
)
js_seconds = float(js.stdout.strip() or 0)
check("JS 側も同じ値を返す",
      abs(js_seconds - got.timestamp()) < 1, (js_seconds, got.timestamp()))

print("--- 4. 埋め戻し ---")
store = {
    "reels": {
        # 時刻が無い。埋める対象
        "a": {"code": REAL_CODE, "timestamp": None},
        # 既に時刻がある。上書きしない
        "b": {"code": REAL_CODE, "timestamp": "2020-01-01T00:00:00+0000",
              "timestamp_estimated": False},
        # コードが読めない。「不明」のまま残す
        "c": {"code": "###", "timestamp": None},
        # コードが無い
        "d": {"timestamp": None},
    }
}
filled, failed = backfill(store)
check("埋めたのは1件", filled == 1, filled)
check("復元できなかったのは2件", failed == 2, failed)
check("時刻が入る", store["reels"]["a"]["timestamp"] is not None, store["reels"]["a"])
check("推定の印が立つ", store["reels"]["a"]["timestamp_estimated"] is True,
      store["reels"]["a"])
# 取れた時刻を復元値で塗り替えると、精度の高い値を失う
check("既にある時刻は上書きしない",
      store["reels"]["b"]["timestamp"] == "2020-01-01T00:00:00+0000",
      store["reels"]["b"])
check("その印も変えない", store["reels"]["b"]["timestamp_estimated"] is False,
      store["reels"]["b"])
check("読めないものは None のまま", store["reels"]["c"]["timestamp"] is None,
      store["reels"]["c"])

# 保存する形が collect.py と揃っていること。ずれると読み込みで落ちる
from common import parse_timestamp  # noqa: E402
parsed = parse_timestamp(store["reels"]["a"]["timestamp"])
check("collect.py が読める形で保存する", parsed is not None,
      store["reels"]["a"]["timestamp"])

print("--- 5. 2回流しても変わらない ---")
filled2, _ = backfill(store)
check("2回目は何も埋めない", filled2 == 0, filled2)
check("空のデータでも落ちない", backfill({}) == (0, 0), backfill({}))

print(f"\n結果: {PASS} pass / {FAIL} fail")
sys.exit(0 if FAIL == 0 else 1)
