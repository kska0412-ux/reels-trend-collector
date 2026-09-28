#!/usr/bin/env python3
"""
自動実行で、次にどのジャンルを回すかを決める。run_collect.sh --next から呼ばれる。

ジャンルが増えて（2026-09-28 に46単位）、1日に全部は回せなくなった。
全部を毎日回すと Instagram へのアクセスが今の2.4倍になり、アカウントが
止められる危険が上がる。Mac を開けておく時間も1日の空き枠に収まらない。

そこで1日のアクセス量は据え置き（1日4回 × 1回5単位）にして、
「最後に回してから一番時間が経っている単位」から順に回す。
一度も回していない単位（足したばかりのジャンル）は最優先になるので、
設定に足せば次の自動実行から集まり始める。

  python3 scripts/rotation.py pick 5       次に回す5単位を1行1件で出す
  python3 scripts/rotation.py mark 育毛    回し終えた単位を記録する
  python3 scripts/rotation.py status       全単位の最終実行時刻を古い順に出す

記録は data/last_run.json（data/ は .gitignore なので公開されない）。
覚えるのは位置の番号ではなく単位ごとの時刻なので、設定の途中にジャンルを
足しても順番がずれない。壊れていたら全部「未実行」として読み、止まらない。
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import BASE_DIR, CONFIG_FILE, DATA_FILE, now_jst_iso  # noqa: E402
from schedule import load_groups  # noqa: E402

LAST_RUN_FILE = BASE_DIR / "data" / "last_run.json"


def load_last_run(path=LAST_RUN_FILE):
    """{単位: 最終実行のISO時刻}。無い・壊れているなら空を返す。"""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}


def seed_from_store(store):
    """
    記録ファイルがまだ無いとき、蓄積データから単位ごとの最終実行を割り出す。

    リールに残っている last_updated は、その単位を実際に回して取れた証拠になる。
    これをやらないと初回は全単位が「未実行」になり、足したばかりのジャンルより
    毎日回っている既存のジャンルが先に選ばれてしまう。
    """
    seen = {}
    for reel in (store.get("reels") or {}).values():
        at = reel.get("last_updated")
        if not isinstance(at, str):
            continue
        for g in reel.get("genres") or []:
            if at > seen.get(g, ""):
                seen[g] = at
    return seen


def current_last_run(state_path=LAST_RUN_FILE, data_path=None):
    """記録ファイルを読む。無ければ蓄積データから割り出す。"""
    if Path(state_path).exists():
        return load_last_run(state_path)
    try:
        store = json.loads(Path(data_path or DATA_FILE).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return seed_from_store(store)


def pick(groups, last_run, count):
    """
    次に回す単位を count 個選ぶ。

    一度も回していないものを先に、次に最終実行の古い順。同じなら設定に書いた順。
    ISO 時刻（同じタイムゾーン表記）は文字列の大小がそのまま時刻の前後になる。
    """
    if count <= 0:
        return []
    order = {g: i for i, g in enumerate(groups)}
    ranked = sorted(groups, key=lambda g: (g in last_run, last_run.get(g, ""), order[g]))
    return ranked[:count]


def mark(unit, path=LAST_RUN_FILE, now=None):
    """
    回し終えた単位を記録する。書き込み中の中断で壊さないよう一時ファイル経由。
    初回は蓄積データから割り出した記録を土台にする（他の単位の順番を崩さないため）。
    """
    data = current_last_run(path)
    data[unit] = now or now_jst_iso()
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=CONFIG_FILE)
    parser.add_argument("--state", type=Path, default=LAST_RUN_FILE)
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_pick = sub.add_parser("pick")
    p_pick.add_argument("count", type=int)
    p_mark = sub.add_parser("mark")
    p_mark.add_argument("unit")
    sub.add_parser("status")
    args = parser.parse_args()

    groups = load_groups(args.config)

    if args.cmd == "pick":
        for g in pick(groups, current_last_run(args.state), args.count):
            print(g)
        return 0

    if args.cmd == "mark":
        # 設定に無い名前を記録しても害は無いが、打ち間違いに気づけるようにする
        if args.unit not in groups:
            print(f"[注意] 設定に無い単位です: {args.unit}", file=sys.stderr)
        mark(args.unit, args.state)
        return 0

    last_run = current_last_run(args.state)
    for g in pick(groups, last_run, len(groups)):
        print(f"{last_run.get(g, '未実行')[:16].replace('T', ' ')}\t{g}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
