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
    _as_count as _count_or_none,
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
        followers = _count_or_none(account.get("follower_count"))
        plays = _count_or_none(r.get("play_count"))

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
            "likes": _count_or_none(r.get("like_count")),
            "comments": _count_or_none(r.get("comment_count")),
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


# --- HTML テンプレート ---
# 生成が長くなるため、head（meta + style）/ body / script の3つに分けて組み立てる。
# 中身の互いの依存はなく、最後に単純に連結するだけ。

TEMPLATE_HEAD = r"""
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- 公開リポジトリで配信するため、検索結果には出さない -->
<meta name="robots" content="noindex, nofollow">
<title>Instagram リール Research Tool（美容ジャンル ver）</title>
<style>
  /* 明るい側を基準に全トークンを定義する。暗い側は下で上書きする。 */
  :root {
    --bg: #f6f4f5; --surface: #ffffff; --surface-2: #fbf9fa;
    --ink: #231c22; --muted: #6f636c; --border: #e4dee2;
    --accent: #8b2f5f; --accent-soft: #f7e9f0;
    --hot: #0f7b6c; --hot-soft: #e2f2ef;
    --chip: #efeaed; --focus: #8b2f5f;
  }
  /* OS が暗いとき。ただし閲覧者が明るいテーマを選んでいたらそちらを優先する。 */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #151114; --surface: #1f1a1e; --surface-2: #241e23;
      --ink: #f0eaee; --muted: #a3969e; --border: #332b31;
      --accent: #e086b0; --accent-soft: #3a2130;
      --hot: #4fc3ae; --hot-soft: #16332e;
      --chip: #2c2429; --focus: #e086b0;
    }
  }
  /* 閲覧者が暗いテーマを選んだとき。OS の設定に関係なく効かせる。 */
  :root[data-theme="dark"] {
    --bg: #151114; --surface: #1f1a1e; --surface-2: #241e23;
    --ink: #f0eaee; --muted: #a3969e; --border: #332b31;
    --accent: #e086b0; --accent-soft: #3a2130;
    --hot: #4fc3ae; --hot-soft: #16332e;
    --chip: #2c2429; --focus: #e086b0;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    /* 透明のままだと閲覧側の地の色を借りてしまうので必ず塗る */
    background: var(--bg);
    color: var(--ink);
    font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP",
                 -apple-system, BlinkMacSystemFont, "Yu Gothic Medium", sans-serif;
    line-height: 1.75;
    font-feature-settings: "palt" 1;
    /* 単語の途中では折らない。あふれた時だけ折る。日本語の禁則を強める。 */
    word-break: normal;
    overflow-wrap: break-word;
    line-break: strict;
  }

  /* 自前の文言を文節ごとに括るための箱。ここで改行させない。 */
  .nb { white-space: nowrap; }

  .wrap { max-width: 880px; margin: 0 auto; padding: 40px 20px 96px; }
  :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 4px; }

  h1 { font-size: clamp(1.3rem, 4vw, 1.8rem); line-height: 1.4; margin: 0; }
  .ver { display: block; font-size: .74rem; font-weight: 400; color: var(--muted); margin-top: 6px; }
  .updated { font-size: .76rem; color: var(--muted); margin: 10px 0 0; }

  .panel {
    border: 1px solid var(--border); border-radius: 10px; overflow: hidden;
    background: var(--surface); margin: 24px 0 8px;
  }
  .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--border); }
  @media (max-width: 620px) { .summary { grid-template-columns: repeat(2, 1fr); } }
  .stat { background: var(--surface); padding: 12px 14px; }
  .stat-label { display: block; font-size: .7rem; color: var(--muted); margin-bottom: 4px; }
  .stat-value { font-size: 1.15rem; font-weight: 700; font-variant-numeric: tabular-nums; }

  .breakdown { padding: 14px 16px 16px; border-top: 1px solid var(--border); }
  .breakdown-title { font-size: .7rem; color: var(--muted); margin: 0 0 10px; }
  .bar-row { display: grid; grid-template-columns: 7em 1fr auto; gap: 10px; align-items: center; }
  .bar-row + .bar-row { margin-top: 7px; }
  .bar-name { font-size: .76rem; }
  .bar-track { height: 6px; border-radius: 999px; background: var(--chip); overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 999px; background: var(--accent); }
  .bar-count { font-size: .74rem; color: var(--muted); font-variant-numeric: tabular-nums; }

  .note { font-size: .74rem; color: var(--muted); margin: 10px 0 0; }

  .controls {
    position: sticky; top: 0; z-index: 10; background: var(--bg);
    padding: 14px 0; border-bottom: 1px solid var(--border); margin: 18px 0;
  }
  .tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
  .tab {
    font: inherit; font-size: .8rem; padding: 5px 13px;
    border: 1px solid var(--border); border-radius: 999px;
    background: var(--surface); color: var(--muted); cursor: pointer;
  }
  .tab.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 700; }
  .sorts { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
  .sort-btn {
    font: inherit; font-size: .8rem; padding: 5px 13px;
    border: 1px solid var(--border); border-radius: 7px;
    background: var(--surface); color: var(--muted); cursor: pointer;
  }
  .sort-btn.on { background: var(--hot-soft); border-color: var(--hot); color: var(--hot); font-weight: 700; }
  #q {
    font: inherit; font-size: .82rem; padding: 7px 11px; width: 100%;
    border: 1px solid var(--border); border-radius: 7px;
    background: var(--surface); color: var(--ink); margin-bottom: 8px;
  }
  .count { display: block; font-size: .76rem; color: var(--muted); }

  #list { display: flex; flex-direction: column; gap: 10px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; margin-bottom: 8px; }
  .ratio { font-size: .9rem; font-weight: 700; color: var(--accent); }
  .user { font-weight: 700; font-size: .84rem; }
  .followers { margin-left: auto; font-size: .74rem; color: var(--muted); }
  .metrics { display: flex; flex-wrap: wrap; gap: 10px; font-size: .74rem; color: var(--muted); margin-bottom: 8px; }
  .metric { white-space: nowrap; }

  /* --- 収集したキャプション。他人の文章なので .nb で括らない --- */
  .caption {
    word-break: normal;
    overflow-wrap: break-word;
    line-break: strict;
    color: var(--muted);
    font-size: .88rem;
    white-space: pre-wrap;
    margin: 0 0 10px;
  }

  .tags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .tag { font-size: .7rem; padding: 3px 9px; border-radius: 4px; background: var(--chip); color: var(--muted); }
  .link { margin-left: auto; font-size: .76rem; color: var(--accent); text-decoration: none; font-weight: 700; }
  .link:hover { text-decoration: underline; }

  .empty { text-align: center; color: var(--muted); padding: 56px 20px; font-size: .88rem; }

  /* --- 短いラベルは丸ごと割れないようにする --- */
  .stat-value  { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .stat-label  { white-space: nowrap; }
  .count       { white-space: nowrap; }
  .tag         { white-space: nowrap; }
  .link        { white-space: nowrap; }
  .ratio       { white-space: nowrap; }
  .metric      { white-space: nowrap; }
  .followers   { white-space: nowrap; }
  .bar-name    { white-space: nowrap; }
  .bar-count   { white-space: nowrap; }
  .breakdown-title { white-space: nowrap; }
  .sort-btn    { white-space: nowrap; }
  .tab         { white-space: nowrap; }
</style>
"""

TEMPLATE_BODY = r"""
<div class="wrap">
  <h1>Instagram リール Research Tool<span class="ver"><span class="nb">ネイル、</span><span class="nb">顔まわり、</span><span class="nb">まつげ・眉・メイク、</span><span class="nb">髪・脱毛・痩身 ver</span></span></h1>

  <p class="updated"><span class="nb">最終更新</span> <span class="stat-value">__GENERATED__</span> <span class="nb">/ 全 __COUNT__ 件</span></p>

  <div class="panel">
    <div class="summary" id="summary"></div>
    <div class="breakdown">
      <p class="breakdown-title">ジャンル別の内訳</p>
      <div id="breakdown"></div>
    </div>
  </div>

  <p class="note note-ratio"><span class="nb">伸び率は</span><span class="nb">再生数を</span><span class="nb">フォロワー数で</span><span class="nb">割った</span><span class="nb">値です。</span><span class="nb">フォロワーが</span><span class="nb">500人未満の</span><span class="nb">アカウントは</span><span class="nb">500人として</span><span class="nb">計算しています。</span></p>
  <p class="note note-thumb"><span class="nb">サムネイル画像は</span><span class="nb">数時間で</span><span class="nb">失効するため</span><span class="nb">表示していません。</span></p>

  <div class="controls">
    <div class="tabs" id="tabs"></div>
    <div class="sorts">
      <button type="button" class="sort-btn on" data-sort="ratio">伸び率順</button>
      <button type="button" class="sort-btn" data-sort="plays">再生数順</button>
      <button type="button" class="sort-btn" data-sort="posted">新着順</button>
    </div>
    <input type="search" id="q" placeholder="キャプション・アカウント名で絞り込む">
    <span class="count" id="count"></span>
  </div>

  <div id="list"></div>
</div>
"""

TEMPLATE_SCRIPT = r"""
<script id="data" type="application/json">__DATA__</script>
<script id="genres" type="application/json">__GENRES__</script>
<script id="hashtags" type="application/json">__HASHTAGS__</script>
<script id="summary-data" type="application/json">__SUMMARY__</script>

<script>
(function () {
  var ROWS = JSON.parse(document.getElementById('data').textContent);
  var GENRES = JSON.parse(document.getElementById('genres').textContent);
  var SUMMARY = JSON.parse(document.getElementById('summary-data').textContent);

  var state = { genre: null, sort: 'ratio', q: '' };

  /* 数値以外は「取れなかった」として扱う。文字列をそのまま流すと
     innerHTML に HTML が入り込む。 */
  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v.toLocaleString() : '—';
  }

  /* 他人由来の値を innerHTML に入れる前に無害化する。
     キャプションは textContent で守っているが、ユーザー名とリンクも同じく他人由来。
     Instagram 側の制限に安全性を預けない。 */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* リンク先は自前で組み立てた instagram.com のURLのはず。
     そうでないものは href を付けない（javascript: などを踏ませない）。 */
  function safeReelUrl(u) {
    return typeof u === 'string' && u.indexOf('https://www.instagram.com/') === 0 ? u : '';
  }

  function ago(hours) {
    if (hours === null || hours === undefined) return '—';
    if (hours < 24) return Math.round(hours) + '時間前';
    return Math.round(hours / 24) + '日前';
  }

  /* --- 集計パネル --- */
  var STATS = [
    ['総リール数', SUMMARY.total],
    ['伸び率100倍超', SUMMARY.over100],
    ['今週の投稿', SUMMARY.thisWeek],
    ['アカウント数', SUMMARY.authors]
  ];
  document.getElementById('summary').innerHTML = STATS.map(function (s) {
    return '<div class="stat"><div class="stat-value">' + s[1].toLocaleString() +
           '</div><div class="stat-label">' + s[0] + '</div></div>';
  }).join('');

  var maxGenre = SUMMARY.genres.length ? SUMMARY.genres[0][1] : 1;
  document.getElementById('breakdown').innerHTML = SUMMARY.genres.map(function (g) {
    var pct = Math.round(g[1] / maxGenre * 100);
    return '<div class="bar-row"><span class="bar-name">' + esc(g[0]) +
           '</span><span class="bar-track"><span class="bar-fill" style="width:' + pct +
           '%"></span></span><span class="bar-count">' + g[1] + '</span></div>';
  }).join('');

  /* --- ジャンルタブ --- */
  var tabs = document.getElementById('tabs');
  tabs.innerHTML = ['全部'].concat(GENRES).map(function (g, i) {
    return '<button type="button" class="tab' + (i === 0 ? ' on' : '') +
           '" data-genre="' + (i === 0 ? '' : esc(g)) + '">' + esc(g) + '</button>';
  }).join('');
  tabs.addEventListener('click', function (e) {
    var b = e.target.closest('.tab');
    if (!b) return;
    state.genre = b.dataset.genre || null;
    [].forEach.call(tabs.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('on', t === b);
    });
    render();
  });

  /* --- 並び替え --- */
  var sorts = document.querySelector('.sorts');
  sorts.addEventListener('click', function (e) {
    var b = e.target.closest('.sort-btn');
    if (!b) return;
    state.sort = b.dataset.sort;
    [].forEach.call(sorts.querySelectorAll('.sort-btn'), function (t) {
      t.classList.toggle('on', t === b);
    });
    render();
  });

  document.getElementById('q').addEventListener('input', function (e) {
    state.q = e.target.value.trim().toLowerCase();
    render();
  });

  /* --- カードを一度だけ組み立てて、以後は表示・非表示と並べ替えだけする --- */
  var list = document.getElementById('list');
  var cards = ROWS.map(function (r) {
    var el = document.createElement('article');
    el.className = 'card';
    el.dataset.genres = r.genres.join('|');
    /* 取れていない値は空文字にする。0 と書くと「0だった」と読めてしまう。 */
    el.dataset.ratio = r.ratio === null ? '' : String(r.ratio);
    el.dataset.plays = r.plays === null ? '' : String(r.plays);
    el.dataset.posted = r.postedAt || '';
    el.innerHTML =
      '<div class="head">' +
        '<span class="ratio">' + (r.ratio === null ? '—' : '×' + r.ratio) + '</span>' +
        '<span class="user">@' + esc(r.username) + '</span>' +
        '<span class="followers">フォロワー ' + num(r.followers) + '</span>' +
      '</div>' +
      '<div class="metrics">' +
        '<span class="metric">再生 ' + num(r.plays) + '</span>' +
        '<span class="metric">いいね ' + num(r.likes) + '</span>' +
        '<span class="metric">コメント ' + num(r.comments) + '</span>' +
        '<span class="metric">' + ago(r.ageHours) + '</span>' +
      '</div>' +
      '<p class="caption"></p>' +
      '<div class="tags">' + r.hashtags.map(function (h) {
        return '<span class="tag">#' + esc(h) + '</span>';
      }).join('') + '</div>' +
      (function () {
        var href = safeReelUrl(r.permalink);
        return href
          ? '<a class="link" target="_blank" rel="noopener noreferrer" href="' +
            esc(href) + '">リールを開く</a>'
          : '<span class="link">リンクなし</span>';
      })();
    /* キャプションは他人の文章。HTMLとして解釈させない。 */
    el.querySelector('.caption').textContent = r.caption;
    el.__row = r;
    return el;
  });
  cards.forEach(function (c) { list.appendChild(c); });

  function keyOf(r) {
    if (state.sort === 'plays') return r.plays;
    if (state.sort === 'posted') return r.postedAt || null;
    return r.ratio;
  }

  function render() {
    var shown = cards.filter(function (c) {
      var r = c.__row;
      if (state.genre && r.genres.indexOf(state.genre) < 0) return false;
      if (state.q) {
        var hay = (r.caption + ' ' + r.username).toLowerCase();
        if (hay.indexOf(state.q) < 0) return false;
      }
      return true;
    });

    /* 取れていない値は必ず末尾に回す。0 として上位に混ぜない。 */
    shown.sort(function (a, b) {
      var x = keyOf(a.__row), y = keyOf(b.__row);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return x > y ? -1 : x < y ? 1 : 0;
    });

    cards.forEach(function (c) { c.style.display = 'none'; });
    shown.forEach(function (c) { c.style.display = ''; list.appendChild(c); });

    var old = list.querySelector('.empty');
    if (old) old.remove();
    if (shown.length === 0) {
      var p = document.createElement('p');
      p.className = 'empty';
      p.innerHTML = ['条件に', '合う', 'リールが', 'ありません。',
                     '絞り込みを', '外して', 'みてください。']
        .map(function (u) { return '<span class="nb">' + u + '</span>'; }).join('');
      list.appendChild(p);
    }

    document.getElementById('count').textContent = shown.length + ' 件';
  }

  render();
})();
</script>
"""

TEMPLATE = TEMPLATE_HEAD + TEMPLATE_BODY + TEMPLATE_SCRIPT


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=OUTPUT_FILE)
    parser.add_argument("--input", type=Path, default=DATA_FILE,
                        help="読み込む蓄積データ（検証用に差し替えられる）")
    parser.add_argument("--max-age-days", type=int, default=DEFAULT_MAX_AGE_DAYS,
                        help="この日数より古いリールはページに載せない（0で無制限）")
    parser.add_argument("--max-reels", type=int, default=DEFAULT_MAX_REELS,
                        help="ページに載せる最大件数（0で無制限）")
    parser.add_argument("--allow-empty", action="store_true",
                        help="0件でも既存のページを上書きする")
    args = parser.parse_args()

    if not args.input.exists():
        print(f"[NG] データがありません: {args.input}")
        print("     先に python3 scripts/collect.py を実行してください。")
        return 1

    store = json.loads(args.input.read_text(encoding="utf-8"))
    all_rows = build_rows(store)
    rows, aged_out, over_cap = select_rows(all_rows, args.max_age_days, args.max_reels)
    rows.sort(key=_ratio_key)

    # 0件のページで、今ある正しいページを上書きしない。
    # 蓄積データは .gitignore なのでバックアップが無く、消えたら戻せない。
    if not rows and not args.allow_empty and args.output.exists() and args.output.stat().st_size > 1024:
        print(f"[NG] 0 件になりました。既存のページを上書きしません: {args.output}")
        print(f"     蓄積データを確認してください: {args.input}")
        print("     意図的に空のページを出すなら --allow-empty を付けてください。")
        return 1

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
