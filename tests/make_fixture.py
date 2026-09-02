#!/usr/bin/env python3
"""
テスト用の蓄積データを作る。実データを使わずに HTML 生成を検証するため。

  python3 tests/make_fixture.py --output /tmp/fixture_reels.json
"""
import argparse
import json
from datetime import datetime, timedelta
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from common import JST  # noqa: E402

GENRES = ["フェイシャル・小顔", "薄毛", "育毛・頭皮ケア", "脱毛", "くすみ・美白",
          "エステ・リラクゼーション", "毛穴・ニキビ", "ダイエット・痩身",
          "むくみ・冷え", "たるみ・シワ"]
TAGS = {
    "フェイシャル・小顔": "フェイシャルエステ",
    "薄毛": "薄毛",
    "育毛・頭皮ケア": "育毛",
    "脱毛": "医療脱毛",
    "くすみ・美白": "くすみ改善",
    "エステ・リラクゼーション": "エステサロン",
    "毛穴・ニキビ": "毛穴ケア",
    "ダイエット・痩身": "ダイエット方法",
    "むくみ・冷え": "むくみ解消",
    "たるみ・シワ": "たるみ改善",
}


def build(now):
    reels = {}
    accounts = {}

    # 1〜24: 普通のリール。ジャンルを4種に散らし、経過日数も散らす。
    for i in range(1, 25):
        genre = GENRES[i % len(GENRES)]
        username = f"creator_{i:02d}"
        days_ago = i * 3                      # 3〜72日前
        plays = 500_000 - i * 15_000
        followers = 1_000 + i * 900
        reels[f"r{i}"] = {
            "id": f"r{i}",
            "code": f"CODE{i:03d}",
            "username": username,
            "caption": f"{genre}の小ネタ その{i}。保存しておくと後で効きます。",
            "timestamp": (now - timedelta(days=days_ago)).astimezone(
                JST).strftime("%Y-%m-%dT%H:%M:%S%z"),
            "permalink": f"https://www.instagram.com/reel/CODE{i:03d}/",
            "play_count": plays,
            "like_count": plays // 25,
            "comment_count": plays // 400,
            "genres": [genre],
            "hashtags_hit": [TAGS[genre]],
            "first_seen": now.isoformat(),
            "last_updated": now.isoformat(),
        }
        accounts[username] = {"follower_count": followers,
                              "fetched_at": now.isoformat()}

    # 25: フォロワー数が取れていない。伸び率は None になるはず。
    reels["r25"] = {
        "id": "r25", "code": "CODE025", "username": "unknown_follower",
        "caption": "フォロワー数が取れていないリール",
        "timestamp": (now - timedelta(days=5)).astimezone(
            JST).strftime("%Y-%m-%dT%H:%M:%S%z"),
        "permalink": "https://www.instagram.com/reel/CODE025/",
        "play_count": 999_999, "like_count": 100, "comment_count": 1,
        "genres": ["フェイシャル・小顔"], "hashtags_hit": ["フェイシャルエステ"],
        "first_seen": now.isoformat(), "last_updated": now.isoformat(),
    }

    # 26: 極小アカウント。下限クランプが効いているか見るため。
    reels["r26"] = {
        "id": "r26", "code": "CODE026", "username": "tiny_account",
        "caption": "フォロワー20人のリール",
        "timestamp": (now - timedelta(days=2)).astimezone(
            JST).strftime("%Y-%m-%dT%H:%M:%S%z"),
        "permalink": "https://www.instagram.com/reel/CODE026/",
        "play_count": 10_000, "like_count": 500, "comment_count": 10,
        "genres": ["薄毛"], "hashtags_hit": ["薄毛"],
        "first_seen": now.isoformat(), "last_updated": now.isoformat(),
    }
    accounts["tiny_account"] = {"follower_count": 20, "fetched_at": now.isoformat()}

    # 27: 投稿時刻が取れていない。期間フィルタで落とさないこと。
    reels["r27"] = {
        "id": "r27", "code": "CODE027", "username": "no_timestamp",
        "caption": "投稿時刻が取れていないリール",
        "timestamp": None,
        "permalink": "https://www.instagram.com/reel/CODE027/",
        "play_count": 5_000, "like_count": 50, "comment_count": 2,
        "genres": ["育毛・頭皮ケア"], "hashtags_hit": ["育毛"],
        "first_seen": now.isoformat(), "last_updated": now.isoformat(),
    }
    accounts["no_timestamp"] = {"follower_count": 3_000, "fetched_at": now.isoformat()}

    # 28: 1年前の古いリール。180日フィルタで落ちるはず。
    reels["r28"] = {
        "id": "r28", "code": "CODE028", "username": "old_reel",
        "caption": "1年前のリール",
        "timestamp": (now - timedelta(days=365)).astimezone(
            JST).strftime("%Y-%m-%dT%H:%M:%S%z"),
        "permalink": "https://www.instagram.com/reel/CODE028/",
        "play_count": 800_000, "like_count": 30_000, "comment_count": 500,
        "genres": ["たるみ・シワ"], "hashtags_hit": ["たるみ改善"],
        "first_seen": now.isoformat(), "last_updated": now.isoformat(),
    }
    accounts["old_reel"] = {"follower_count": 2_000, "fetched_at": now.isoformat()}

    return {"updated_at": now.isoformat(), "reels": reels, "accounts": accounts}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--hostile", action="store_true",
                        help="HTMLとして解釈されると困る値を持つリールを足す（無害化の検証用）")
    args = parser.parse_args()
    # 固定時刻。実行するたびに結果が変わらないようにする。
    now = datetime(2026, 9, 2, 7, 0, tzinfo=JST)

    data = build(now)
    if args.hostile:
        # 通常のフィクスチャは28件のまま保つ（verify_select.py がその数を前提にしている）。
        # 無害化の検証だけ、この分を足した別ファイルで行う。
        data["reels"]["hostile1"] = {
            "id": "hostile1", "code": 'X"><script>window.__pwned=1</script>',
            "username": 'evil"><script>window.__pwned=1</script>',
            "caption": '<script>window.__pwned=1</script>キャプションも危ない',
            "timestamp": (now - timedelta(days=1)).astimezone(
                JST).strftime("%Y-%m-%dT%H:%M:%S%z"),
            "permalink": 'javascript:window.__pwned=1',
            "play_count": 1000, "like_count": 10, "comment_count": 1,
            "genres": ["フェイシャル・小顔"], "hashtags_hit": ['<script>window.__pwned=1</script>'],
            "first_seen": now.isoformat(), "last_updated": now.isoformat(),
        }
        data["accounts"]['evil"><script>window.__pwned=1</script>'] = {
            "follower_count": 100, "fetched_at": now.isoformat()}

        data["reels"]["hostile2"] = {
            "id": "hostile2", "code": "HOSTILE2", "username": "count_injection",
            "caption": "数値のはずの場所に文字列が入っている",
            "timestamp": (now - timedelta(days=1)).astimezone(
                JST).strftime("%Y-%m-%dT%H:%M:%S%z"),
            "permalink": "https://www.instagram.com/reel/HOSTILE2/",
            "play_count": '<img src=x onerror=window.__pwned=1>',
            "like_count": '<img src=y onerror=window.__pwned=1>',
            "comment_count": -5,
            "genres": ["フェイシャル・小顔"], "hashtags_hit": ["フェイシャルエステ"],
            "first_seen": now.isoformat(), "last_updated": now.isoformat(),
        }
        data["accounts"]["count_injection"] = {
            "follower_count": '<img src=z onerror=window.__pwned=1>',
            "fetched_at": now.isoformat()}

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"作成しました: {args.output}")


if __name__ == "__main__":
    main()
