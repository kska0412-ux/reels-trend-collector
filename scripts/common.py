#!/usr/bin/env python3
"""パス・日時・伸び率の共通処理。collect.py と build_html.py が共有する。"""

from pathlib import Path
from datetime import datetime, timezone, timedelta

JST = timezone(timedelta(hours=9))
BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_FILE = BASE_DIR / "config" / "genres.json"
DATA_FILE = BASE_DIR / "data" / "reels.json"
RAW_FILE = BASE_DIR / "data" / "raw_latest.json"
# collect.py が「フォロワー数が新しいので取り直さなくてよい」アカウントを
# scrape.mjs に伝えるための受け渡しファイル。
FRESH_FILE = BASE_DIR / "data" / "_fresh_accounts.json"

# 伸び率の分母の下限。フォロワー20人で1万再生（×500）のような極小アカウントが
# 上位を埋め尽くすのを防ぐ。
FOLLOWER_FLOOR = 500

# フォロワー数キャッシュの有効期限（日）。同じアカウントに何度もアクセスしない。
ACCOUNT_TTL_DAYS = 7


def now_jst_iso():
    """現在時刻を JST の ISO8601 文字列で返す。"""
    return datetime.now(JST).isoformat()


def parse_timestamp(ts):
    """
    時刻文字列を datetime に。パースできなければ None。

    受け付ける形:
      - 投稿時刻   '2026-08-30T12:00:00+0000'（コロン無しのオフセット）
      - 取得時刻   '2026-09-02T07:00:00+09:00'（コロン付きのオフセット）

    文字列以外を渡されたら None を返す。data/reels.json は人が手で
    編集しうるファイルで、壊れた値が1つあるだけで収集が丸ごと止まるのを避ける。
    """
    if not isinstance(ts, str) or not ts:
        return None
    try:
        return datetime.fromisoformat(ts)
    except ValueError:
        pass
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S.%f%z"):
        try:
            return datetime.strptime(ts, fmt)
        except ValueError:
            continue
    return None


def _as_count(v):
    """0以上の整数なら返す。そうでなければ None。bool は数値と認めない。"""
    if isinstance(v, bool) or not isinstance(v, int):
        return None
    return v if v >= 0 else None


def reach_ratio(play_count, follower_count):
    """
    伸び率 = 再生数 ÷ フォロワー数。

    フォロワー数が取れていない、または 0 のときは None を返す。
    0 で埋めて計算すると伸び率が無限大になり、ページの上位が壊れるため。

    分母は FOLLOWER_FLOOR で下から押さえる。フォロワー20人で1万再生（×500）が
    フォロワー3千人で30万再生（×100）より上に来るのを防ぐ。
    """
    plays = _as_count(play_count)
    followers = _as_count(follower_count)
    if plays is None or followers is None or followers == 0:
        return None
    return plays / max(followers, FOLLOWER_FLOOR)
