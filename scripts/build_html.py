#!/usr/bin/env python3
"""
data/reels.json を読んで、単一ファイル完結の HTML 一覧を docs/index.html に書き出す。

外部リソースを一切参照しないので、ブラウザで開くだけで動く（サーバー不要）。

並び替えは3種類（画面上で切り替える）:
  - 伸び率順   : 再生数 ÷ フォロワー数。フォロワーが少なくても跳ねた企画が上位に来る
  - 再生数順   : 絶対値。文句なしに強いネタが上位に来る
  - 新着順     : 投稿日時

サムネイル画像は出さない。Instagram の画像URLは署名付きで数時間〜数日で失効するため、
HTMLに焼き込むと開いた頃には壊れた画像だらけになる。

使い方:
  python3 scripts/build_html.py
  python3 scripts/build_html.py --output /path/to/out.html
"""

import argparse
import json
import sys
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import (  # noqa: E402
    BASE_DIR, DATA_FILE, JST, now_jst_iso, parse_timestamp, reach_ratio,
)

# GitHub Pages は main ブランチの /docs をそのまま配信できるので、ここに出す
OUTPUT_FILE = BASE_DIR / "docs" / "index.html"

# ページに載せる範囲。data/reels.json には全履歴が残り、ここで絞るのは表示分だけ。
# 無制限にするとHTMLが際限なく太り、GitHubの1ファイル上限に当たって更新が止まる。
DEFAULT_MAX_AGE_DAYS = 180
DEFAULT_MAX_REELS = 1500

# 「よく伸びた」と数える基準（伸び率）。集計パネルに出す。
OVER_RATIO = 100


def build_rows(store, now=None):
    """蓄積データを、HTML に埋め込む行のリストに変換する。"""
    now = now or datetime.now(JST)
    accounts = store.get("accounts") or {}
    rows = []

    for reel_id, r in (store.get("reels") or {}).items():
        username = r.get("username") or "unknown"
        account = accounts.get(username) or {}
        followers = account.get("follower_count")
        if not isinstance(followers, int) or isinstance(followers, bool):
            followers = None

        plays = r.get("play_count")
        if not isinstance(plays, int) or isinstance(plays, bool):
            plays = None

        ratio = reach_ratio(plays, followers)

        posted = parse_timestamp(r.get("timestamp"))
        if posted is None:
            age_hours = None
            posted_iso = ""
        else:
            age_hours = (now - posted).total_seconds() / 3600.0
            posted_iso = posted.astimezone(JST).isoformat()

        rows.append({
            "id": reel_id,
            "username": username,
            "caption": r.get("caption") or "",
            "permalink": r.get("permalink") or "",
            "plays": plays,
            "likes": r.get("like_count"),
            "comments": r.get("comment_count"),
            "followers": followers,
            "ratio": round(ratio, 1) if ratio is not None else None,
            "ageHours": round(age_hours, 1) if age_hours is not None else None,
            "postedAt": posted_iso,
            "genres": r.get("genres") or [],
            "hashtags": r.get("hashtags_hit") or [],
        })

    rows.sort(key=_ratio_key)
    return rows


def _ratio_key(r):
    """伸び率の降順。取れていない（None）ものは最後に回す。"""
    return (r["ratio"] is None, -(r["ratio"] or 0))


def _recency_key(r):
    """新しい順。投稿日時が取れていないものは最後に回す。"""
    return (r["ageHours"] is None, r["ageHours"] if r["ageHours"] is not None else 0)


def select_rows(rows, max_age_days, max_reels):
    """
    ページに載せるリールを選ぶ。返り値は (選んだ行, 期間外で外した数, 上限で外した数)。

    件数を絞るとき、伸び率順だけで切ると「まだ再生が回りきっていない新しいリール」が
    落ちてしまう。新着順だけで切ると当たった企画が落ちる。
    そこで両方の上位を半分ずつ確保してから、残りを伸び率順で埋める。
    """
    if max_age_days > 0:
        limit_hours = max_age_days * 24
        # 投稿日時が取れなかったものは判断できないので残す
        in_window = [r for r in rows
                     if r["ageHours"] is None or r["ageHours"] <= limit_hours]
    else:
        in_window = list(rows)
    aged_out = len(rows) - len(in_window)

    if max_reels <= 0 or len(in_window) <= max_reels:
        return in_window, aged_out, 0

    half = max_reels // 2
    by_ratio = sorted(in_window, key=_ratio_key)
    by_recency = sorted(in_window, key=_recency_key)

    chosen = {}
    for r in by_ratio[:half]:
        chosen[r["id"]] = r
    for r in by_recency[:half]:
        chosen[r["id"]] = r
    for r in by_ratio:
        if len(chosen) >= max_reels:
            break
        chosen.setdefault(r["id"], r)

    selected = list(chosen.values())
    return selected, aged_out, len(in_window) - len(selected)


def build_summary(rows, store, archived):
    """一覧の上に出す集計。詳細より先に全体像が分かるようにする。"""
    genres = {}
    for r in rows:
        for g in r["genres"]:
            genres[g] = genres.get(g, 0) + 1
    week = [r for r in rows if r["ageHours"] is not None and r["ageHours"] <= 168]
    return {
        "total": len(rows),
        "archived": archived,
        "genres": sorted(genres.items(), key=lambda kv: -kv[1]),
        "over100": len([r for r in rows if r["ratio"] is not None and r["ratio"] >= OVER_RATIO]),
        "thisWeek": len(week),
        "authors": len({r["username"] for r in rows}),
        "updatedAt": (store.get("updated_at") or "")[:16].replace("T", " "),
    }


def embed_json(data):
    """<script> の中に安全に置ける JSON 文字列にする。"""
    return (
        json.dumps(data, ensure_ascii=False)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
    )


def render_html(rows, generated_at, store, archived):
    genres = sorted({g for r in rows for g in r["genres"]})
    hashtags = sorted({h for r in rows for h in r["hashtags"]})

    return (
        TEMPLATE.replace("__DATA__", embed_json(rows))
        .replace("__GENRES__", embed_json(genres))
        .replace("__HASHTAGS__", embed_json(hashtags))
        .replace("__SUMMARY__", embed_json(build_summary(rows, store, archived)))
        .replace("__GENERATED__", generated_at)
        .replace("__COUNT__", str(len(rows)))
    )


# Task 10 で本物のテンプレートに差し替える。今はロジックを検証するための最小版。
TEMPLATE = r"""<meta charset="utf-8">
<title>Instagram リール Research Tool</title>
<script id="data" type="application/json">__DATA__</script>
<script id="genres" type="application/json">__GENRES__</script>
<script id="hashtags" type="application/json">__HASHTAGS__</script>
<script id="summary" type="application/json">__SUMMARY__</script>
<p>生成: __GENERATED__ / __COUNT__ 件</p>
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=OUTPUT_FILE)
    parser.add_argument("--input", type=Path, default=DATA_FILE,
                        help="読み込む蓄積データ（検証用に差し替えられる）")
    parser.add_argument("--max-age-days", type=int, default=DEFAULT_MAX_AGE_DAYS,
                        help="この日数より古いリールはページに載せない（0で無制限）")
    parser.add_argument("--max-reels", type=int, default=DEFAULT_MAX_REELS,
                        help="ページに載せる最大件数（0で無制限）")
    args = parser.parse_args()

    if not args.input.exists():
        print(f"[NG] データがありません: {args.input}")
        print("     先に python3 scripts/collect.py を実行してください。")
        return 1

    store = json.loads(args.input.read_text(encoding="utf-8"))
    all_rows = build_rows(store)
    rows, aged_out, over_cap = select_rows(all_rows, args.max_age_days, args.max_reels)
    rows.sort(key=_ratio_key)

    html = render_html(rows, now_jst_iso()[:16].replace("T", " "), store, len(all_rows))

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(html, encoding="utf-8")

    size_kb = args.output.stat().st_size / 1024
    print(f"生成しました: {args.output}  （{len(rows)} 件 / {size_kb:.0f} KB）")
    # 黙って捨てない。何をどれだけ載せなかったかを必ず出す。
    if aged_out or over_cap:
        print(f"蓄積 {len(all_rows)} 件のうち、ページに載せなかった分:")
        if aged_out:
            print(f"  {args.max_age_days} 日より古い: {aged_out} 件")
        if over_cap:
            print(f"  上限 {args.max_reels} 件を超過: {over_cap} 件")
        print("  （data/reels.json には全件そのまま残っています）")
    print(f"開く: open {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
