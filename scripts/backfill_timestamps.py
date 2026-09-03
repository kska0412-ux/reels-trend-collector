#!/usr/bin/env python3
"""
投稿時刻が入っていないリールに、コードから復元した時刻を入れる。

プロフィールのリールタブには投稿日時が出ない。そのため、この方式に
切り替えてから集めたリールは時刻が空のままになっている。時刻が無いと
新着順で並ばず、期間の絞り込みも効かず、画面には「不明」と出る。

Instagram のコードには投稿時刻が埋まっているので、そこから復元する。
追加のアクセスは要らない。復元値には数分の誤差がある（実データで
検算したところ 2.4 分だった）ので、timestamp_estimated を立てて
画面に「およそ」と出す。

  python3 scripts/backfill_timestamps.py --dry-run   件数だけ見る
  python3 scripts/backfill_timestamps.py             書き込む（.bak に退避）
"""

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import DATA_FILE  # noqa: E402

# Instagram のコードは 64 進数。デコードすると投稿IDになり、
# 上位ビットに投稿時刻（ミリ秒）が入っている。
# scripts/extract_reel_dom.mjs の timestampFromCode と同じ規則。
CODE_ALPHABET = (
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
)
IG_EPOCH_MS = 1314220021721
# Instagram の開始（2010-01-01）。これより前の日付は復元の失敗とみなす。
MIN_SECONDS = 1262304000


def timestamp_from_code(code, now=None):
    """コードから投稿時刻（datetime）を復元する。読めなければ None。"""
    if not isinstance(code, str) or not code:
        return None
    pk = 0
    for ch in code:
        i = CODE_ALPHABET.find(ch)
        if i < 0:
            return None
        pk = pk * 64 + i
    if pk <= 0:
        return None

    seconds = ((pk >> 23) + IG_EPOCH_MS) // 1000
    # 桁数の違うコードから、ありえない日付を作らないための関門
    now = now or datetime.now(timezone.utc).timestamp()
    if seconds < MIN_SECONDS or seconds > now + 86400:
        return None
    return datetime.fromtimestamp(seconds, timezone.utc)


def backfill(store, now=None):
    """
    時刻が無いリールを埋める。副作用は store への書き込みのみ。
    返り値は (埋めた件数, 復元できなかった件数)。
    """
    filled = 0
    failed = 0
    for reel in store.get("reels", {}).values():
        if reel.get("timestamp"):
            continue
        dt = timestamp_from_code(reel.get("code"), now=now)
        if dt is None:
            failed += 1
            continue
        reel["timestamp"] = dt.isoformat().replace("+00:00", "+0000")
        # 復元値には誤差がある。取れた時刻と同じ顔で見せない
        reel["timestamp_estimated"] = True
        filled += 1
    return filled, failed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=DATA_FILE)
    parser.add_argument("--dry-run", action="store_true", help="保存せず件数だけ表示する")
    args = parser.parse_args()

    if not args.input.exists():
        raise SystemExit(f"データがありません: {args.input}")

    store = json.loads(args.input.read_text(encoding="utf-8"))
    before = sum(1 for r in store.get("reels", {}).values() if not r.get("timestamp"))
    filled, failed = backfill(store)

    print(f"時刻が無かったリール: {before} 件")
    print(f"  復元できた: {filled} 件")
    if failed:
        print(f"  復元できず: {failed} 件（コードが読めないもの。「不明」のまま残る）")

    if filled == 0:
        print("\n埋めるものがありませんでした。")
        return 0
    if args.dry_run:
        print("\n--dry-run のため保存しませんでした。")
        return 0

    backup = args.input.with_suffix(args.input.suffix + ".bak")
    shutil.copy2(args.input, backup)
    tmp = args.input.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(args.input)

    print(f"\n保存しました: {args.input}")
    print(f"元のデータ: {backup}")
    print("次: python3 scripts/build_html.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
