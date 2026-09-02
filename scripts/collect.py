#!/usr/bin/env python3
"""
Instagram からリールを集めて data/reels.json に蓄積する。

実際にブラウザを動かすのは scripts/scrape.mjs（Playwright）。
このスクリプトはそれを呼び出して、結果を蓄積データにマージする役目を持つ。

蓄積の方針:
  - リールID をキーに重複排除する
  - 再収集時は再生数・いいね・コメントを最新値で上書きする（伸びるため）
  - 同じリールが複数タグでヒットしたら、ジャンルとタグを積み上げる
  - フォロワー数はリールとは別に持ち、7日キャッシュする

初回だけログインが要る:
  python3 scripts/collect.py --login

収集:
  python3 scripts/collect.py
  python3 scripts/collect.py --genre 育毛                # 1ジャンルだけ（自動実行はこの形）
  python3 scripts/collect.py --limit 3 --headful         # 試運転
  python3 scripts/collect.py --dry-run                   # 保存せず件数だけ確認
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import (  # noqa: E402
    ACCOUNT_TTL_DAYS, BASE_DIR, CONFIG_FILE, DATA_FILE, FRESH_FILE, JST,
    RAW_FILE, now_jst_iso, parse_timestamp,
)

SCRAPER = BASE_DIR / "scripts" / "scrape.mjs"

# 保存するリールのフィールド。スクレイパが返すキーと一致させてある。
REEL_FIELDS = ("id", "code", "username", "caption", "timestamp", "timestamp_estimated",
               "permalink", "play_count", "like_count", "comment_count")


def load_store():
    """既存の蓄積データを読む。無ければ空の構造を返す。"""
    if not DATA_FILE.exists():
        return {"reels": {}, "accounts": {}}
    try:
        store = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise SystemExit(
            f"data/reels.json が壊れています ({e})。\n"
            f"手動で確認するか、退避してから再実行してください: {DATA_FILE}"
        )
    store.setdefault("reels", {})
    store.setdefault("accounts", {})
    return store


def save_store(store):
    """蓄積データを書き出す。書き込み中の中断で壊さないよう一時ファイル経由。"""
    store["updated_at"] = now_jst_iso()
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = DATA_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(DATA_FILE)


def merge_reels(store, raw_reels, genre, hashtag, collected_at):
    """
    取得したリールを store にマージする。副作用は store への書き込みのみ。
    返り値は (新規件数, 更新件数)。
    """
    new_count = 0
    updated_count = 0

    for raw in raw_reels:
        reel_id = raw.get("id")
        if not reel_id:
            continue

        existing = store["reels"].get(reel_id)
        if existing is None:
            record = {f: raw.get(f) for f in REEL_FIELDS}
            record["genres"] = [genre]
            record["hashtags_hit"] = [hashtag]
            record["first_seen"] = collected_at
            record["last_updated"] = collected_at
            store["reels"][reel_id] = record
            new_count += 1
            continue

        # 既存リール: 再生数など変わりうる値を最新で上書きする。
        # ただし取れなかった値（None）で既存の値を潰さない。
        for f in REEL_FIELDS:
            if raw.get(f) is not None:
                existing[f] = raw[f]
        if genre not in existing["genres"]:
            existing["genres"].append(genre)
        if hashtag not in existing["hashtags_hit"]:
            existing["hashtags_hit"].append(hashtag)
        existing["last_updated"] = collected_at
        updated_count += 1

    return new_count, updated_count


def merge_accounts(store, raw_accounts, collected_at):
    """
    フォロワー数を store にマージする。返り値は (新規件数, 更新件数)。

    取れなかった（None）アカウントは登録しない。0 で埋めると伸び率が壊れるため。
    """
    new_count = 0
    updated_count = 0

    for username, count in (raw_accounts or {}).items():
        if count is None:
            continue
        if username in store["accounts"]:
            updated_count += 1
        else:
            new_count += 1
        store["accounts"][username] = {
            "follower_count": count,
            "fetched_at": collected_at,
        }

    return new_count, updated_count


def fresh_accounts(store, now=None):
    """
    フォロワー数が新しく、取り直さなくてよいアカウント名の一覧。

    取得時刻が無い・壊れている場合は「古い」として扱う。取り直すだけで害はないが、
    間違った値を使い続けるのは害があるため。
    """
    now = now or datetime.now(JST)
    cutoff = now - timedelta(days=ACCOUNT_TTL_DAYS)
    out = []
    for username, entry in (store.get("accounts") or {}).items():
        fetched = parse_timestamp((entry or {}).get("fetched_at"))
        if fetched is not None and fetched > cutoff:
            out.append(username)
    return out


def load_required_any():
    """ジャンルごとの必須語を読む。{ジャンル名: [語, ...]} を返す。"""
    config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    return {genre: entry.get("required_any", [])
            for genre, entry in config.get("genres", {}).items()}


def is_relevant(caption, required_any):
    """
    キャプションが必須語のどれかを含むか。必須語が空ならフィルタしない。

    ハッシュタグは投稿者が自由に付けられるので、リーチ目当てで無関係な動画に
    タグが付くことがある。それを落とすための関門。

    キャプションが空のリールは通す。ハッシュタグ経由で見つけている以上、
    キャプションが取れなかったことを「無関係」の証拠にはできない。
    """
    if not required_any:
        return True
    if not caption:
        return True
    return any(word in caption for word in required_any)


# launchd から起動されると PATH が /usr/bin:/bin:/usr/sbin:/sbin だけになり、
# /usr/local/bin にある node が見つからない。よくある場所を直接探す。
NODE_CANDIDATES = (
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/bin/node",
)


def find_node():
    """node の実行ファイルを探す。PATH に無くても既知の場所を当たる。"""
    node = shutil.which("node")
    if node:
        return node
    for path in NODE_CANDIDATES:
        if os.access(path, os.X_OK):
            return path
    # nvm で入れている場合はバージョンごとのディレクトリに入る
    nvm = Path.home() / ".nvm" / "versions" / "node"
    if nvm.is_dir():
        for version in sorted(nvm.iterdir(), reverse=True):
            candidate = version / "bin" / "node"
            if os.access(candidate, os.X_OK):
                return str(candidate)
    return None


def require_node():
    """node が使えるか確かめる。無ければ分かる形で止める。"""
    node = find_node()
    if not node:
        raise SystemExit(
            "node が見つかりません。Playwright の実行に必要です。\n"
            f"  探した場所: PATH, {', '.join(NODE_CANDIDATES)}, "
            "~/.nvm/versions/node/*/bin/node\n"
            "  Node.js を入れてから再実行してください: https://nodejs.org/"
        )
    if not (BASE_DIR / "node_modules" / "playwright").exists():
        raise SystemExit(
            "playwright が入っていません。プロジェクト直下で次を実行してください:\n"
            f"  npm install --prefix {BASE_DIR} playwright"
        )
    return node


def run_scraper(node, extra_args):
    """scrape.mjs を実行する。出力はそのまま画面に流す。"""
    cmd = [node, str(SCRAPER)] + extra_args
    print(f"$ {' '.join(cmd)}\n")
    return subprocess.run(cmd, cwd=str(BASE_DIR)).returncode


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--login", action="store_true",
                        help="ブラウザを開いてInstagramにログインする（初回のみ）")
    parser.add_argument("--genre", help="このジャンルのみ収集する")
    parser.add_argument("--limit", type=int, default=0,
                        help="先頭N個のハッシュタグだけ処理する（試運転用）")
    parser.add_argument("--delay", type=float, default=10.0,
                        help="ハッシュタグ間・プロフィール間の待機秒数（既定10秒）")
    parser.add_argument("--max-profiles", type=int, default=10,
                        help="フォロワー数を取りに行くアカウント数の上限（既定10）")
    parser.add_argument("--headful", action="store_true", help="ブラウザを表示する")
    parser.add_argument("--dump-dir", help="生レスポンスを保存する（原因調査用）")
    parser.add_argument("--dry-run", action="store_true", help="保存せず件数だけ表示する")
    parser.add_argument("--no-filter", action="store_true",
                        help="関連度フィルタをかけずに全部保存する")
    parser.add_argument("--from-raw", type=Path,
                        help="スクレイピングせず、既存のraw JSONからマージし直す")
    args = parser.parse_args()

    if args.login:
        node = require_node()
        return run_scraper(node, ["--login"])

    store = load_store()

    # --- リールを用意する（スクレイピング or 既存rawの読み直し） ---
    if args.from_raw:
        raw_path = args.from_raw
        if not raw_path.exists():
            raise SystemExit(f"指定されたファイルがありません: {raw_path}")
    else:
        node = require_node()

        # フォロワー数が新しいアカウントを scrape.mjs に伝え、無駄なアクセスを避ける
        FRESH_FILE.parent.mkdir(parents=True, exist_ok=True)
        FRESH_FILE.write_text(
            json.dumps(fresh_accounts(store), ensure_ascii=False), encoding="utf-8")

        scraper_args = [
            "--genres", str(CONFIG_FILE),
            "--out", str(RAW_FILE),
            "--delay", str(args.delay),
            "--max-profiles", str(args.max_profiles),
            "--skip-accounts", str(FRESH_FILE),
        ]
        if args.genre:
            scraper_args += ["--genre", args.genre]
        if args.limit:
            scraper_args += ["--limit", str(args.limit)]
        if args.headful:
            scraper_args.append("--headful")
        if args.dump_dir:
            scraper_args += ["--dump-dir", args.dump_dir]

        code = run_scraper(node, scraper_args)
        if code != 0 or not RAW_FILE.exists():
            print("\n[NG] 収集に失敗しました。蓄積データは変更していません。")
            return 1
        raw_path = RAW_FILE

    # --- マージ ---
    raw = json.loads(raw_path.read_text(encoding="utf-8"))
    before = len(store["reels"])
    collected_at = now_jst_iso()

    required_table = {} if args.no_filter else load_required_any()

    total_new = 0
    total_updated = 0
    total_dropped = 0
    dropped_samples = []
    failures = []

    for entry in raw.get("results", []):
        if entry.get("error"):
            failures.append((entry.get("hashtag"), entry["error"]))
            continue

        genre = entry.get("genre", "不明")
        required_any = required_table.get(genre, [])
        kept = []
        for reel in entry.get("reels", []):
            if is_relevant(reel.get("caption"), required_any):
                kept.append(reel)
            else:
                total_dropped += 1
                if len(dropped_samples) < 5:
                    text = (reel.get("caption") or "").replace("\n", " ")[:50]
                    dropped_samples.append(f"@{reel.get('username')}: {text}")

        new_count, updated_count = merge_reels(
            store, kept, genre, entry.get("hashtag", "不明"), collected_at,
        )
        total_new += new_count
        total_updated += updated_count

    acc_new, acc_updated = merge_accounts(store, raw.get("accounts"), collected_at)

    print("\n" + "-" * 50)
    print(f"新規: {total_new} 件 / 更新: {total_updated} 件")
    if total_dropped:
        print(f"関連度フィルタで除外: {total_dropped} 件")
        for sample in dropped_samples:
            print(f"  - {sample}")
        if total_dropped > len(dropped_samples):
            print(f"  ... ほか {total_dropped - len(dropped_samples)} 件")
    print(f"蓄積合計: {before} → {len(store['reels'])} 件")
    print(f"フォロワー数: 新規 {acc_new} 件 / 更新 {acc_updated} 件 "
          f"（保持 {len(store['accounts'])} アカウント）")

    if failures:
        print(f"\n失敗したハッシュタグ: {len(failures)}")
        for tag, msg in failures:
            print(f"  - #{tag}: {msg}")

    if args.dry_run:
        print("\n--dry-run のため保存しませんでした。")
        return 0

    if len(store["reels"]) == before and total_updated == 0:
        print("\n[NG] 1件も取れなかったため保存しません。")
        print("     --dump-dir data/dump を付けて再実行すると、生レスポンスを確認できます。")
        return 1

    save_store(store)
    print(f"\n保存しました: {DATA_FILE}")
    print("次: python3 scripts/build_html.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
