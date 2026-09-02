# 美容リール コレクター 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instagram の美容ジャンルで伸びているリールをハッシュタグ経由で集め、伸び率（再生数÷フォロワー数）順に並べた HTML を GitHub Pages で自動更新する。

**Architecture:** Playwright で実ブラウザを起動し、DOM ではなくフロントエンドが受け取る JSON レスポンスを傍受してリールを抽出する（`threads-trend-collector` で実証済みの方式）。抽出ロジックは通信もブラウザも知らない純関数に切り出し、フィクスチャ JSON だけで回帰テストできるようにする。収集（Node）とマージ・HTML生成（Python）をファイル経由で分離する。

**Tech Stack:** Node.js + Playwright（収集）/ Python 3 標準ライブラリのみ（マージ・HTML生成）/ jsdom（テストのみ）/ launchd（自動実行）/ GitHub Pages（配信）

**Spec:** `spec/2026-09-02-reels-trend-collector-design.md`

**参照実装:** `~/Projects/threads-trend-collector/` — 同じ方式の先行プロジェクト。移植元として繰り返し参照する。

---

## Global Constraints

以下は全タスクの要件に暗黙的に含まれる。

- **LLM API を使わない。** 収集専用。分析も文章生成もしない。月額コストは最悪ケースでも 0 円
- **リポジトリは公開。** `docs/` 配下は GitHub Pages でそのまま配信される。設計書・計画書を `docs/` に置かない（この計画書が `spec/` にあるのはそのため）
- **`.browser-profile/` を絶対にコミットしない。** Instagram のログイン Cookie が入る。`.gitignore` と `tests/verify_safety.sh` の二重で守る
- **`data/` `logs/` `node_modules/` もコミットしない**
- **1件も取れなかった実行では蓄積データを保存しない。** 古い正しいデータを空データで上書きしない
- **取れなかった値を 0 や既定値で埋めない。** `null` のまま持ち、画面では `—` と出す
- **回帰テストはブラウザも通信も GitHub も使わない。** `bash tests/run.sh` はいつでも同じ結果を出す
- **`FOLLOWER_FLOOR = 500`** — 伸び率の分母の下限（`scripts/common.py`）
- **`ACCOUNT_TTL_DAYS = 7`** — フォロワー数キャッシュの有効期限（`scripts/common.py`）
- **`DEFAULT_MAX_AGE_DAYS = 180` / `DEFAULT_MAX_REELS = 1500`** — ページ掲載の上限（`scripts/build_html.py`）
- **日本語コピーの改行ルール（CLAUDE.md 由来・自前の文言すべてに適用）**
  - 単語の途中で改行しない。カタカナ語・英単語・数字と単位を割らない
  - 行頭に助詞（を と が は に へ で の も や から まで）を置かない
  - CSS は `word-break: normal` / `overflow-wrap: break-word` / `line-break: strict`。**`word-break: break-word` と `break-all` は禁止**
  - 自前の文言は文節ごとに `<span class="nb">` で括る（`.nb { white-space: nowrap }`）
  - 収集した他人のキャプションは対象外（自分で書いた文言だけが対象）
  - `tests/verify_wrapping.mjs` がこれを機械的に検証する
- **git について:** このサンドボックスは `.git/config` への書き込みを拒否する。Task 1 で `git init` の許可を取ってから進める。取れない場合は各タスクの commit ステップを飛ばし、Task 12 でまとめてコミットする

---

## File Structure

| ファイル | 責務 | 依存 |
|---|---|---|
| `config/genres.json` | ジャンル定義。ハッシュタグと必須語。**ユーザーが編集するのはここだけ** | なし |
| `config/launchd/com.kameda.reels-trend-collector.plist` | 自動実行の定義（1日4回・1回1ジャンル） | なし |
| `scripts/extract_reel.mjs` | JSON文字列 → リール配列。**純関数** | なし |
| `scripts/extract_profile.mjs` | JSON文字列 → フォロワー数。**純関数** | なし |
| `scripts/retry.mjs` | 取得失敗・件数不足のやり直し判定。**純関数** | なし |
| `scripts/scrape.mjs` | ブラウザを動かして生データを集める（2フェーズ） | playwright, 上記3つ |
| `scripts/common.py` | パス・日時・`reach_ratio`・定数 | なし |
| `scripts/collect.py` | scrape.mjs を呼び、結果を蓄積データにマージする | common.py。**ブラウザを知らない** |
| `scripts/build_html.py` | 蓄積データ → `docs/index.html` | common.py。**ブラウザを知らない** |
| `scripts/run_collect.sh` | 収集→HTML→公開を一息で | 上記 |
| `scripts/publish.sh` | GitHub Pages へ push | git |
| `scripts/setup_github.sh` | 初回のリポジトリ作成と Pages 有効化 | gh |
| `scripts/install_launchd.sh` / `uninstall_launchd.sh` | 自動実行の登録・解除 | launchctl |
| `docs/index.html` | **公開される唯一のファイル** | なし（単一ファイル完結） |
| `data/reels.json` | 蓄積データ（全履歴）。`.gitignore` | — |
| `tests/*` | 回帰テスト | jsdom（テスト時のみ） |

---

## Task 1: 取得可能性の検証（スパイク）

**このタスクの成果物はコードではなく「答え」。** 結果次第で以降の全タスクが変わるため、
必ず最初に実行し、結果を報告してから Task 2 に進む。

**Files:**
- Create: `scripts/probe.mjs`（**使い捨て。Task 3 完了時に削除する**）
- Create: `data/dump/`（`.gitignore` 対象）

**Interfaces:**
- Consumes: なし
- Produces: 検証結果の報告のみ。コードは残さない

- [ ] **Step 1: 作業ディレクトリと playwright を用意する**

```bash
mkdir -p ~/Projects/reels-trend-collector/{scripts,config,tests,data,docs,spec}
cd ~/Projects/reels-trend-collector
printf '{\n  "dependencies": {\n    "playwright": "^1.62.1"\n  }\n}\n' > package.json
npm install --prefix . playwright
```

`git init` の許可を取る。取れたら:

```bash
git init -q -b main
```

拒否された場合はここでは進めず、ユーザーに許可を求める。取れないまま進めるときは
以降の commit ステップを飛ばし、Task 12 でまとめる。

- [ ] **Step 2: 使い捨ての探り用スクリプトを書く**

`scripts/probe.mjs`:

```js
/**
 * 使い捨て。Instagram のレスポンスに何が入っているかを目視するためだけのもの。
 * Task 3 完了時に削除する。
 *
 *   node scripts/probe.mjs --login
 *   node scripts/probe.mjs --tag ネイルデザイン
 *   node scripts/probe.mjs --profile some_username
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PROFILE_DIR = path.join(ROOT, ".browser-profile");
const DUMP_DIR = path.join(ROOT, "data", "dump");

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--login") args.login = true;
  else if (a === "--tag") args.tag = process.argv[++i];
  else if (a === "--profile") args.profile = process.argv[++i];
}

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function open(headful) {
  const options = {
    headless: !headful,
    viewport: { width: 1280, height: 900 },
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  };
  if (fs.existsSync(CHROME)) options.executablePath = CHROME;
  return chromium.launchPersistentContext(PROFILE_DIR, options);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (args.login) {
  console.log("ブラウザを開きます。Instagram にログインしてから閉じてください。");
  const ctx = await open(true);
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("https://www.instagram.com/accounts/login/", { waitUntil: "domcontentloaded" });
  await new Promise((r) => { ctx.on("close", r); page.on("close", r); });
  console.log(`セッションを保存しました: ${PROFILE_DIR}`);
  process.exit(0);
}

const url = args.tag
  ? `https://www.instagram.com/explore/tags/${encodeURIComponent(args.tag)}/`
  : `https://www.instagram.com/${args.profile}/`;
const label = args.tag ? `tag_${args.tag}` : `profile_${args.profile}`;

const ctx = await open(true);
const page = ctx.pages()[0] || (await ctx.newPage());
const bodies = [];

page.on("response", async (res) => {
  const u = res.url();
  if (!u.includes("instagram.com")) return;
  const type = (res.headers()["content-type"] || "").toLowerCase();
  if (!type.includes("json") && !u.includes("/graphql")) return;
  try { bodies.push(`===== ${u}\n${await res.text()}`); } catch {}
});

console.log(`開きます: ${url}`);
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
await sleep(8000);
await page.mouse.wheel(0, 3000);
await sleep(6000);

fs.mkdirSync(DUMP_DIR, { recursive: true });
const out = path.join(DUMP_DIR, `${label.replace(/[^\p{L}\p{N}_]+/gu, "_")}.txt`);
fs.writeFileSync(out, bodies.join("\n\n"), "utf8");
console.log(`${bodies.length} 本のレスポンスを保存しました: ${out}`);
console.log(`現在のURL: ${page.url()}`);
await ctx.close();
```

- [ ] **Step 3: ログインする**

```bash
node scripts/probe.mjs --login
```

**設計書のとおり、亀田さんの既存サブアカウントでログインする。本家アカウントは使わない。**
ブラウザが開くので手でログインし、閉じる。

- [ ] **Step 4: ハッシュタグページを1つ開いてレスポンスを保存する**

```bash
node scripts/probe.mjs --tag ネイルデザイン
```

`現在のURL:` が `/accounts/login/` になっていたらログインが効いていない。Step 3 に戻る。

- [ ] **Step 5: 再生数がどのキーで入っているかを調べる**

```bash
cd ~/Projects/reels-trend-collector
grep -o '"[a-z_]*play_count"' data/dump/tag_*.txt | sort | uniq -c
grep -o '"view_count"' data/dump/tag_*.txt | sort | uniq -c
grep -o '"like_count"' data/dump/tag_*.txt | sort | uniq -c
grep -o '"product_type":"[a-z]*"' data/dump/tag_*.txt | sort | uniq -c
grep -o '"code":"[A-Za-z0-9_-]*"' data/dump/tag_*.txt | head -5
```

- [ ] **Step 6: 実際のリールオブジェクトを1つ目で見る**

```bash
python3 - <<'PY'
import json, re, pathlib
raw = pathlib.Path("data/dump").glob("tag_*.txt")
found = []
def walk(o):
    if isinstance(o, dict):
        keys = set(o)
        if keys & {"play_count", "ig_play_count", "view_count"} and ("code" in keys):
            found.append(o)
        for v in o.values(): walk(v)
    elif isinstance(o, list):
        for v in o: walk(v)
for f in raw:
    for line in f.read_text(encoding="utf-8", errors="replace").split("\n"):
        s = line.strip()
        if not s or s[0] not in "{[": continue
        try: walk(json.loads(s))
        except Exception: pass
print(f"リールらしきオブジェクト: {len(found)} 件")
if found:
    o = found[0]
    print(json.dumps({k: o[k] for k in list(o)[:40]}, ensure_ascii=False, indent=2)[:4000])
PY
```

- [ ] **Step 7: プロフィールからフォロワー数が取れるか確認する**

Step 6 で出た `user.username` を1つ使う。

```bash
node scripts/probe.mjs --profile <Step6で出たusername>
grep -o '"follower_count":[0-9]*' data/dump/profile_*.txt | head -3
grep -o '"edge_followed_by":{"count":[0-9]*}' data/dump/profile_*.txt | head -3
```

- [ ] **Step 8: 判定し、報告する**

| 確認項目 | 結果 |
|---|---|
| 再生数のキー名 | ← ここに実際のキー名を書く |
| `code`（パーマリンク用） | 有 / 無 |
| `caption` | 有 / 無 |
| `taken_at`（投稿時刻） | 有 / 無 |
| `like_count` / `comment_count` | 有 / 無 |
| フォロワー数のキー名 | ← ここに実際のキー名を書く |

判定:

- **再生数が取れる** → Task 2 へ進む。Step 5〜7 で判明した実キー名を Task 3・4 の
  候補リストの**先頭**に置く
- **再生数が取れない / ハッシュタグページが開けない** → **ここで止める。**
  設計書の第11章のとおり案C（アカウント巡回型）へ切り替える。設計書を書き直してから
  実装計画を作り直す。勝手に先へ進まない

---

## Task 2: プロジェクト骨格と公開安全性

**Files:**
- Create: `.gitignore`, `config/genres.json`, `tests/run.sh`, `tests/verify_safety.sh`
- Modify: `package.json`（Task 1 で作成済み）

**Interfaces:**
- Consumes: なし
- Produces: `config/genres.json` の構造 — `{"genres": {"<名前>": {"hashtags": [...], "required_any": [...]}}}`。Task 6・9 が読む

- [ ] **Step 1: `.gitignore` を書く**

```gitignore
# 収集データと生ログ（成果物のHTMLに埋め込まれるので追跡不要）
data/
logs/

# ブラウザのログインセッション。絶対にコミットしない
.browser-profile/

node_modules/
__pycache__/
out/

# 実装作業の台帳と中間成果物（SDD ワークスペース）
.superpowers/
```

- [ ] **Step 2: `config/genres.json` を書く**

```json
{
  "_comment": "ジャンルごとの巡回ハッシュタグと、関連度フィルタの必須語。ジャンルを増やすときはここに1ブロック足すだけでよい。",
  "_hashtags": "巡回するハッシュタグ。# は付けない。",
  "_required_any": "ハッシュタグは投稿者が自由に付けられるため、リーチ目当てで無関係な動画にタグが付くことがある。キャプションに required_any のどれか1語も含まないリールは捨てる。空配列ならフィルタしない。キャプション自体が空のリールは判定材料が無いので捨てない。",
  "genres": {
    "ネイル": {
      "hashtags": [
        "ネイルデザイン", "セルフネイル", "ニュアンスネイル",
        "シンプルネイル", "ネイルサロン", "大人ネイル", "フットネイル"
      ],
      "required_any": [
        "ネイル", "nail", "爪", "ジェル", "指先",
        "フィルイン", "スカルプ", "フット", "ハンド", "オフ"
      ]
    },
    "顔まわり": {
      "hashtags": [
        "フェイシャルエステ", "小顔", "小顔矯正", "たるみ改善", "毛穴ケア",
        "スキンケア", "ほうれい線", "リフトアップ", "美容液"
      ],
      "required_any": [
        "肌", "顔", "毛穴", "たるみ", "シワ", "しわ", "ほうれい線", "小顔",
        "エステ", "スキンケア", "リフト", "くすみ", "ハリ", "むくみ",
        "輪郭", "化粧水", "美容液", "クレンジング", "エラ"
      ]
    },
    "まつげ・眉・メイク": {
      "hashtags": [
        "まつげパーマ", "まつエク", "パリジェンヌラッシュリフト", "眉毛",
        "眉毛サロン", "アイブロウ", "メイク方法", "メイク動画", "一重メイク"
      ],
      "required_any": [
        "まつげ", "まつ毛", "マツエク", "まつエク", "ラッシュ", "眉",
        "アイブロウ", "メイク", "コスメ", "アイシャドウ", "アイライン",
        "マスカラ", "リップ", "ファンデ", "二重", "一重"
      ]
    },
    "髪・脱毛・痩身": {
      "hashtags": [
        "薄毛改善", "育毛", "頭皮ケア", "髪質改善", "ヘアアレンジ",
        "医療脱毛", "セルフ脱毛", "痩身エステ", "ダイエット方法"
      ],
      "required_any": [
        "髪", "毛", "頭皮", "育毛", "発毛", "抜け毛", "薄毛", "ヘア",
        "シャンプー", "脱毛", "ムダ毛", "VIO", "痩身", "ダイエット",
        "痩せ", "体重", "脂肪", "セルライト", "くびれ"
      ]
    }
  }
}
```

- [ ] **Step 3: 失敗するテストを書く（公開安全性）**

`tests/verify_safety.sh` — `threads-trend-collector/tests/verify_safety.sh` を移植する。
変更点は3つ:

1. `posts.json` → `reels.json`
2. `config/keywords.json` → `config/genres.json`
3. 期待するステージ済みファイル一覧を新しい構成に合わせる

```bash
#!/usr/bin/env bash
# 公開してはいけないファイルが GitHub に上がらないことを検証する。
#
# 守るもの:
#   .browser-profile/  Instagram のログインCookie。漏れるとアカウントを乗っ取られる
#   data/              収集データ（HTMLに埋め込まれるので別途上げる必要がない）
#   node_modules/      依存物
#
# 防御は2段:
#   1. .gitignore で除外する
#   2. setup_github.sh が push 前に検出して中止する（1が壊れたときの保険）
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
W="${TMPDIR:-/tmp}/rtc-safety-test-$$"
PASS=0; FAIL=0

check() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  OK   $1";
  else FAIL=$((FAIL+1)); echo "  FAIL $1  → 期待 $3 / 実際 $2"; fi
}

# setup_github.sh と同じ判定式
danger_check() {
  local d
  d="$(git status --porcelain | grep -iE "browser-profile|Cookies|Login Data|reels\.json|raw_latest|node_modules|\.env" || true)"
  [ -n "$d" ] && return 1 || return 0
}

mkdir -p "$W"; cd "$W"
export GIT_TEMPLATE_DIR="$W/tpl"; mkdir -p "$GIT_TEMPLATE_DIR"
git init -q -b main

# 本番と同じ構造を作る。ログインCookieに相当するファイルも実際に置く。
mkdir -p .browser-profile/Default data docs scripts config node_modules/playwright
echo "SESSION_COOKIE" > .browser-profile/Default/Cookies
echo "SECRET" > ".browser-profile/Default/Login Data"
echo '{"reels":{},"accounts":{}}' > data/reels.json
echo '{}' > data/raw_latest.json
echo "<h1>page</h1>" > docs/index.html
echo "code" > scripts/collect.py
echo "{}" > config/genres.json
echo "lib" > node_modules/playwright/index.js

cp "$ROOT/.gitignore" .
git add -A

check "ログインCookieは追跡されない" "$(git check-ignore -q .browser-profile/Default/Cookies; echo $?)" "0"
check "収集データは追跡されない" "$(git check-ignore -q data/reels.json; echo $?)" "0"
check "node_modules は追跡されない" "$(git check-ignore -q node_modules/playwright/index.js; echo $?)" "0"
check "公開するHTMLは追跡される" "$(git check-ignore -q docs/index.html; echo $?)" "1"
check "スクリプトは追跡される" "$(git check-ignore -q scripts/collect.py; echo $?)" "1"

STAGED="$(git status --porcelain | awk '{print $NF}' | sort | tr '\n' ' ')"
check "コミット対象は安全なものだけ" "$STAGED" ".gitignore config/genres.json docs/index.html scripts/collect.py "

danger_check
check "正常時は公開前チェックを通過する" "$?" "0"

# .gitignore が失われた事故を想定する
git rm -r --cached . -q
rm .gitignore
git add -A
danger_check
check "gitignoreが壊れたら公開前チェックが止める" "$?" "1"

cd /
rm -rf "$W"
echo
echo "結果: $PASS pass / $FAIL fail"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 4: テストランナーの骨格を書く**

`tests/run.sh` — この時点では安全性テストだけ。以降のタスクで章を足していく。

```bash
#!/usr/bin/env bash
# 回帰テスト。ブラウザも通信も GitHub も使わないので、いつでも再現する。
#
#   bash tests/run.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/reels-trend-collector-test"
mkdir -p "$WORK"

if [ ! -d "$WORK/node_modules/jsdom" ]; then
  echo "jsdom を取得します（初回のみ）..."
  npm install --prefix "$WORK" --cache "$WORK/.npm-cache" jsdom --no-audit --no-fund
fi

echo "===== 1. 公開の安全性 ====="
bash "$ROOT/tests/verify_safety.sh"

echo
echo "全テスト通過"
```

- [ ] **Step 5: テストを走らせて通ることを確認する**

```bash
cd ~/Projects/reels-trend-collector && bash tests/run.sh
```

期待: `結果: 8 pass / 0 fail` と `全テスト通過`

`.gitignore` を作る前に走らせると `cp` が失敗する。Step 1 を先にやること。

- [ ] **Step 6: `config/genres.json` が正しい JSON か確認する**

```bash
python3 -c "
import json;d=json.load(open('config/genres.json'))
g=d['genres']
print(f'{len(g)} ジャンル / 合計 {sum(len(v[\"hashtags\"]) for v in g.values())} タグ')
for k,v in g.items(): print(f'  {k}: {len(v[\"hashtags\"])} タグ / 必須語 {len(v[\"required_any\"])}')
"
```

期待: `4 ジャンル / 合計 34 タグ`

- [ ] **Step 7: コミット**

```bash
git add .gitignore config/genres.json tests/run.sh tests/verify_safety.sh package.json
git commit -m "chore: プロジェクト骨格と公開安全性テスト"
```

---

## Task 3: リール抽出ロジック（`extract_reel.mjs`）

**Files:**
- Create: `scripts/extract_reel.mjs`
- Test: `tests/verify_extract_reel.mjs`
- Modify: `tests/run.sh`（章を追加）
- Delete: `scripts/probe.mjs`（Task 1 の使い捨て）

**Interfaces:**
- Consumes: Task 1 で判明した実際のキー名
- Produces:
  - `looksLikeReel(o) -> boolean`
  - `getPlayCount(o) -> number | null`
  - `normalizeReel(o) -> Reel`
  - `findReels(root, {maxDepth}) -> Reel[]`
  - `parsePayloads(body) -> object[]`
  - `extractFromBody(body) -> Reel[]`
  - `Reel = { id, code, username, caption, timestamp, permalink, play_count, like_count, comment_count }`
  - Task 6（scrape.mjs）が `extractFromBody` を使う

- [ ] **Step 1: 失敗するテストを書く**

`tests/verify_extract_reel.mjs`:

```js
/**
 * extract_reel.mjs の抽出ロジックを、合成した JSON で検証する。
 * ブラウザも通信も使わないので、単体で常に再現する。
 */
import {
  extractFromBody, findReels, looksLikeReel, getPlayCount, parsePayloads,
} from "../scripts/extract_reel.mjs";

let pass = 0, fail = 0;
function check(label, cond, actual) {
  if (cond) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}  → 実際: ${JSON.stringify(actual)}`); }
}

// Instagram の実際の形に寄せたリールオブジェクト
const reel = (over = {}) => ({
  pk: "3141592653",
  code: "C1abcDEF",
  media_type: 2,
  product_type: "clips",
  caption: { text: "セルフでこれできたら勝ち。#ネイルデザイン" },
  play_count: 298000,
  like_count: 12400,
  comment_count: 89,
  user: { pk: "999", username: "example_nail" },
  taken_at: 1756500000,
  ...over,
});

// 写真投稿。再生数が無いのでリールではない。
const photo = (over = {}) => ({
  pk: "777",
  code: "Cphoto01",
  media_type: 1,
  caption: { text: "写真です" },
  like_count: 300,
  user: { username: "someone" },
  taken_at: 1756500000,
  ...over,
});

console.log("--- 1. 基本の抽出 ---");
{
  const reels = findReels({ data: { items: [reel()] } });
  check("1件抽出できる", reels.length === 1, reels.length);
  const r = reels[0];
  check("id", r.id === "3141592653", r.id);
  check("code", r.code === "C1abcDEF", r.code);
  check("username", r.username === "example_nail", r.username);
  check("キャプション", r.caption.startsWith("セルフで"), r.caption);
  check("再生数", r.play_count === 298000, r.play_count);
  check("いいね数", r.like_count === 12400, r.like_count);
  check("コメント数", r.comment_count === 89, r.comment_count);
  check("permalinkをcodeから組める",
        r.permalink === "https://www.instagram.com/reel/C1abcDEF/", r.permalink);
  check("timestampがISO+0000形式",
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0000$/.test(r.timestamp), r.timestamp);
}

console.log("--- 2. 再生数のキーゆれに対応 ---");
{
  check("play_count", getPlayCount({ play_count: 100 }) === 100, null);
  check("ig_play_count", getPlayCount({ ig_play_count: 200 }) === 200, null);
  check("view_count", getPlayCount({ view_count: 300 }) === 300, null);
  check("play_count を優先する",
        getPlayCount({ play_count: 100, view_count: 300 }) === 100, null);
  check("文字列は認めない", getPlayCount({ play_count: "100" }) === null, null);
  check("負数は認めない", getPlayCount({ play_count: -1 }) === null, null);
  check("0は有効な値", getPlayCount({ play_count: 0 }) === 0, null);
  check("どれも無ければnull", getPlayCount({ like_count: 5 }) === null, null);
  const byView = findReels({ x: reel({ pk: "v1", play_count: undefined, view_count: 555 }) });
  check("view_countだけでも抽出できる",
        byView.length === 1 && byView[0].play_count === 555, byView);
}

console.log("--- 3. 写真投稿は拾わない ---");
{
  check("再生数が無ければリールではない", !looksLikeReel(photo()), null);
  const mixed = findReels({ items: [reel(), photo(), { play_count: 5, label: "集計値" }] });
  check("混在してもリールだけ1件", mixed.length === 1, mixed.map(r => r.id));
}

console.log("--- 4. リールとみなす条件 ---");
{
  check("codeが無ければ不可", !looksLikeReel(reel({ code: undefined })), null);
  check("codeが空文字なら不可", !looksLikeReel(reel({ code: "" })), null);
  check("usernameが無ければ不可", !looksLikeReel(reel({ user: {} })), null);
  check("idが無ければ不可", !looksLikeReel(reel({ pk: undefined })), null);
  check("captionが無くても可（タグ経由で見つけた証拠があるため）",
        looksLikeReel(reel({ caption: undefined })), null);
  check("captionがnullでも可", looksLikeReel(reel({ caption: null })), null);
  const noCap = findReels({ x: reel({ pk: "nc", caption: null }) });
  check("caption無しは空文字になる", noCap[0].caption === "", noCap[0].caption);
}

console.log("--- 5. 深いネストでも見つかる ---");
{
  const deep = { data: { xdt_api: { edges: [
    { node: { media: reel({ pk: "A" }) } },
    { node: { media: reel({ pk: "B", user: { username: "esthe_mika" } }) } },
  ] } } };
  const reels = findReels(deep);
  check("2件とも見つかる", reels.length === 2, reels.map(r => r.id));
}

console.log("--- 6. usernameの置き場所ゆれ ---");
{
  const flat = findReels({ x: reel({ pk: "f1", user: undefined, username: "flat_user" }) });
  check("o.username も拾える",
        flat.length === 1 && flat[0].username === "flat_user", flat);
}

console.log("--- 7. 時刻のゆれに対応 ---");
{
  const ms = findReels({ x: reel({ pk: "m1", taken_at: 1756500000000 }) })[0];
  const sec = findReels({ x: reel({ pk: "m2", taken_at: 1756500000 }) })[0];
  check("ミリ秒でも秒でも同じ時刻になる", ms.timestamp === sec.timestamp,
        [ms.timestamp, sec.timestamp]);
  const none = findReels({ x: reel({ pk: "m3", taken_at: undefined }) })[0];
  check("時刻が無くても落ちない（nullになる）", none.timestamp === null, none.timestamp);
}

console.log("--- 8. 欠けている数値はnullのまま持つ ---");
{
  const r = findReels({ x: reel({ pk: "n1", like_count: undefined, comment_count: undefined }) })[0];
  check("いいね数が無ければnull（0で埋めない）", r.like_count === null, r.like_count);
  check("コメント数が無ければnull（0で埋めない）", r.comment_count === null, r.comment_count);
}

console.log("--- 9. 重複の排除 ---");
{
  const reels = findReels({ a: [reel(), reel()], b: reel() });
  check("同じidは1件にまとまる", reels.length === 1, reels.length);
}

console.log("--- 10. 壊れた入力への耐性 ---");
{
  const circular = { name: "root" };
  circular.self = circular;
  circular.reel = reel({ pk: "c1" });
  let ok = true;
  try { findReels(circular); } catch { ok = false; }
  check("循環参照で無限ループしない", ok, null);
  check("空文字列は空配列", extractFromBody("").length === 0, null);
  check("JSONでない本文は空配列", extractFromBody("<html>not json</html>").length === 0, null);
  check("nullを渡しても落ちない", findReels(null).length === 0, null);
  check("undefinedを渡しても落ちない", findReels(undefined).length === 0, null);
}

console.log("--- 11. 改行区切りの複数JSON ---");
{
  const body = [
    JSON.stringify({ x: reel({ pk: "n1" }) }),
    JSON.stringify({ y: reel({ pk: "n2" }) }),
  ].join("\n");
  check("2つのJSONから2件", extractFromBody(body).length === 2,
        extractFromBody(body).map(r => r.id));
  check("parsePayloadsが2つ返す", parsePayloads(body).length === 2, parsePayloads(body).length);
  const withJunk = "for (;;);\n" + JSON.stringify({ x: reel({ pk: "n3" }) });
  check("先頭にゴミ行があっても拾う", extractFromBody(withJunk).length === 1,
        extractFromBody(withJunk));
}

console.log("--- 12. 深すぎるネストは打ち切る ---");
{
  let nested = reel({ pk: "deep" });
  for (let i = 0; i < 60; i++) nested = { level: nested };
  check("maxDepth超過では拾わない（暴走防止）", findReels(nested).length === 0,
        findReels(nested).length);
  check("浅ければ拾う", findReels(nested, { maxDepth: 200 }).length === 1, null);
}

console.log(`\n結果: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: テストを走らせて失敗することを確認する**

```bash
cd ~/Projects/reels-trend-collector && node tests/verify_extract_reel.mjs
```

期待: FAIL。`Cannot find module .../scripts/extract_reel.mjs`

- [ ] **Step 3: 実装を書く**

`scripts/extract_reel.mjs`:

```js
/**
 * Instagram が返す JSON からリールを抜き出す。
 *
 * DOM のクラス名は難読化されていて頻繁に変わるため、画面ではなく
 * フロントエンドが受け取っている JSON を見る。ただし JSON の構造も
 * 変わりうるので、決め打ちのパスは辿らず「リールらしい形をしたオブジェクト」を
 * 再帰的に探す。
 *
 * リールと写真投稿を分けるのは再生数の有無。写真には再生数が無い。
 */

// 再生数の候補キー。Task 1 の検証で判明した実キー名を先頭に置く。
const PLAY_COUNT_KEYS = ["play_count", "ig_play_count", "view_count"];

/** 再生数を取り出す。無ければ null。0 は有効な値として扱う。 */
export function getPlayCount(o) {
  if (!o || typeof o !== "object") return null;
  for (const k of PLAY_COUNT_KEYS) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  }
  return null;
}

function getId(o) {
  for (const k of ["pk", "id", "pk_id"]) {
    const v = o[k];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

function getUsername(o) {
  const u = o.user;
  if (u && typeof u === "object" && typeof u.username === "string" && u.username) {
    return u.username;
  }
  if (typeof o.username === "string" && o.username) return o.username;
  return null;
}

function getCode(o) {
  return typeof o.code === "string" && o.code ? o.code : null;
}

/**
 * キャプションを取り出す。無ければ空文字。
 *
 * リールにキャプションが無いことは普通にある。ハッシュタグ経由で
 * 見つけている以上、キャプションが取れなくても「関係ない投稿」ではない。
 * だからキャプションの有無はリール判定の条件にしない。
 */
function getCaption(o) {
  if (o.caption && typeof o.caption === "object" && typeof o.caption.text === "string") {
    return o.caption.text;
  }
  if (typeof o.caption === "string") return o.caption;
  if (typeof o.text === "string") return o.text;
  return "";
}

function getTimestamp(o) {
  // taken_at は UNIX 秒。ミリ秒で来る実装もあるので桁で判別する。
  for (const k of ["taken_at", "taken_at_timestamp", "device_timestamp", "publish_date"]) {
    const v = o[k];
    if (typeof v === "number" && v > 0) {
      const seconds = v > 1e12 ? Math.floor(v / 1000) : v;
      return new Date(seconds * 1000).toISOString().replace(".000Z", "+0000");
    }
  }
  if (typeof o.timestamp === "string" && o.timestamp) return o.timestamp;
  return null;
}

/** 数値ならそのまま、そうでなければ null。取れなかった値を 0 で埋めない。 */
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** リールとみなすのに必要な条件を満たすか。 */
export function looksLikeReel(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return false;
  if (getPlayCount(o) === null) return false;
  if (getUsername(o) === null) return false;
  if (getId(o) === null) return false;
  if (getCode(o) === null) return false;
  return true;
}

/** リールオブジェクトを、保存する形に整える。 */
export function normalizeReel(o) {
  const code = getCode(o);
  return {
    id: getId(o),
    code,
    username: getUsername(o),
    caption: getCaption(o),
    timestamp: getTimestamp(o),
    permalink: `https://www.instagram.com/reel/${code}/`,
    play_count: getPlayCount(o),
    like_count: num(o.like_count),
    comment_count: num(o.comment_count),
  };
}

/**
 * 任意の JSON を再帰的に walk して、リールらしいオブジェクトを全部集める。
 * 同一 id は最初に見つかったものを採用する。
 */
export function findReels(root, { maxDepth = 40 } = {}) {
  const found = new Map();
  const seen = new WeakSet();

  const walk = (node, depth) => {
    if (depth > maxDepth || node === null || typeof node !== "object") return;
    if (seen.has(node)) return;   // 循環参照よけ
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }

    if (looksLikeReel(node)) {
      const r = normalizeReel(node);
      if (!found.has(r.id)) found.set(r.id, r);
      // リールの中に別のメディアがぶら下がることがあるので、下も見る
    }

    for (const key of Object.keys(node)) walk(node[key], depth + 1);
  };

  walk(root, 0);
  return [...found.values()];
}

/**
 * レスポンスの生テキストを JSON として解釈する。
 * 1レスポンスに複数の JSON を改行区切りで詰めてくることがあるため、
 * まるごと parse に失敗したら行ごとに試す。
 */
export function parsePayloads(body) {
  const out = [];
  const trimmed = (body || "").trim();
  if (!trimmed) return out;

  try {
    out.push(JSON.parse(trimmed));
    return out;
  } catch {
    // 改行区切りの複数 JSON とみなして再挑戦する
  }

  for (const line of trimmed.split("\n")) {
    const s = line.trim();
    if (!s || (s[0] !== "{" && s[0] !== "[")) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // 壊れた行は捨てる
    }
  }
  return out;
}

/** レスポンス本文からリールを抜き出すところまでを一息でやる。 */
export function extractFromBody(body) {
  const reels = [];
  for (const payload of parsePayloads(body)) reels.push(...findReels(payload));

  const unique = new Map();
  for (const r of reels) if (!unique.has(r.id)) unique.set(r.id, r);
  return [...unique.values()];
}
```

- [ ] **Step 4: テストを走らせて通ることを確認する**

```bash
cd ~/Projects/reels-trend-collector && node tests/verify_extract_reel.mjs
```

期待: fail が 0

- [ ] **Step 5: Task 1 で保存した実データで動くことを確認する**

合成データだけで通っても意味がない。実際のレスポンスで動くか確かめる。

```bash
cd ~/Projects/reels-trend-collector
node -e "
import('./scripts/extract_reel.mjs').then(async (m) => {
  const fs = await import('fs');
  const files = fs.readdirSync('data/dump').filter(f => f.startsWith('tag_'));
  let total = 0;
  for (const f of files) {
    const body = fs.readFileSync('data/dump/' + f, 'utf8');
    const reels = body.split('===== ').flatMap(chunk => {
      const nl = chunk.indexOf('\n');
      return nl < 0 ? [] : m.extractFromBody(chunk.slice(nl + 1));
    });
    console.log(f + ': ' + reels.length + ' 件');
    if (reels.length) console.log(JSON.stringify(reels[0], null, 2));
    total += reels.length;
  }
  console.log('合計 ' + total + ' 件');
});
"
```

期待: 1件以上抽出でき、`play_count` / `username` / `permalink` が埋まっている。

**0件だった場合はここで止める。** `PLAY_COUNT_KEYS` を Task 1 Step 5 の結果に
合わせ直す。それでも 0 なら設計の前提が崩れているので報告する。

- [ ] **Step 6: 使い捨てスクリプトを削除する**

```bash
rm scripts/probe.mjs
```

- [ ] **Step 7: `tests/run.sh` に章を足す**

`===== 1. 公開の安全性 =====` の**前**に挿入する（純関数のテストを先に走らせる）:

```bash
echo "===== 1. リール抽出ロジック ====="
node "$ROOT/tests/verify_extract_reel.mjs"

echo
echo "===== 2. 公開の安全性 ====="
bash "$ROOT/tests/verify_safety.sh"
```

- [ ] **Step 8: 全テストを走らせる**

```bash
cd ~/Projects/reels-trend-collector && bash tests/run.sh
```

期待: `全テスト通過`

- [ ] **Step 9: コミット**

```bash
git add scripts/extract_reel.mjs tests/verify_extract_reel.mjs tests/run.sh
git commit -m "feat: JSONからリールを抽出するロジック"
```

---

## Task 4: フォロワー数抽出ロジック（`extract_profile.mjs`）

**Files:**
- Create: `scripts/extract_profile.mjs`
- Test: `tests/verify_extract_profile.mjs`
- Modify: `tests/run.sh`

**Interfaces:**
- Consumes: Task 1 で判明したフォロワー数のキー名
- Produces:
  - `findFollowerCount(root, username, {maxDepth}) -> number | null`
  - `extractFollowerCount(body, username) -> number | null`
  - Task 7（scrape.mjs フェーズ2）が `extractFollowerCount` を使う

- [ ] **Step 1: 失敗するテストを書く**

`tests/verify_extract_profile.mjs`:

```js
/**
 * extract_profile.mjs のフォロワー数抽出を、合成した JSON で検証する。
 *
 * 取れなかったときに 0 を返さないことが最重要。0 を返すと
 * 伸び率が無限大になり、ページの上位を汚染する。
 */
import { findFollowerCount, extractFollowerCount } from "../scripts/extract_profile.mjs";

let pass = 0, fail = 0;
function check(label, cond, actual) {
  if (cond) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}  → 実際: ${JSON.stringify(actual)}`); }
}

console.log("--- 1. follower_count 形式 ---");
{
  const json = { data: { user: { username: "example_nail", follower_count: 15677 } } };
  check("取れる", findFollowerCount(json, "example_nail") === 15677,
        findFollowerCount(json, "example_nail"));
}

console.log("--- 2. edge_followed_by.count 形式 ---");
{
  const json = { graphql: { user: { username: "example_nail",
                                    edge_followed_by: { count: 8421 } } } };
  check("取れる", findFollowerCount(json, "example_nail") === 8421,
        findFollowerCount(json, "example_nail"));
}

console.log("--- 3. 別ユーザーのオブジェクトは拾わない ---");
{
  const json = { items: [
    { username: "someone_else", follower_count: 999999 },
    { username: "example_nail", follower_count: 15677 },
  ] };
  check("指定したユーザーの値だけを返す",
        findFollowerCount(json, "example_nail") === 15677,
        findFollowerCount(json, "example_nail"));
  check("該当ユーザーが居なければnull",
        findFollowerCount(json, "nobody_here") === null,
        findFollowerCount(json, "nobody_here"));
}

console.log("--- 4. 大文字小文字を無視する ---");
{
  const json = { user: { username: "Example_Nail", follower_count: 100 } };
  check("小文字で照会しても取れる", findFollowerCount(json, "example_nail") === 100,
        findFollowerCount(json, "example_nail"));
}

console.log("--- 5. 取れないときは null（0で埋めない） ---");
{
  check("フォロワー数キーが無ければnull",
        findFollowerCount({ user: { username: "example_nail" } }, "example_nail") === null, null);
  check("文字列は認めない",
        findFollowerCount({ user: { username: "u", follower_count: "100" } }, "u") === null, null);
  check("負数は認めない",
        findFollowerCount({ user: { username: "u", follower_count: -5 } }, "u") === null, null);
  check("0フォロワーは有効な値として返す",
        findFollowerCount({ user: { username: "u", follower_count: 0 } }, "u") === 0, null);
  check("nullを渡しても落ちない", findFollowerCount(null, "u") === null, null);
  check("usernameが空なら常にnull",
        findFollowerCount({ user: { username: "u", follower_count: 5 } }, "") === null, null);
}

console.log("--- 6. 深いネストでも見つかる ---");
{
  let nested = { username: "deep_user", follower_count: 42 };
  for (let i = 0; i < 20; i++) nested = { level: nested };
  check("20段でも見つかる", findFollowerCount(nested, "deep_user") === 42, null);
  let tooDeep = { username: "far_user", follower_count: 42 };
  for (let i = 0; i < 60; i++) tooDeep = { level: tooDeep };
  check("60段は打ち切る（暴走防止）", findFollowerCount(tooDeep, "far_user") === null, null);
}

console.log("--- 7. 壊れた入力への耐性 ---");
{
  const circular = { username: "loop_user", follower_count: 7 };
  circular.self = circular;
  let ok = true;
  try { findFollowerCount(circular, "loop_user"); } catch { ok = false; }
  check("循環参照で無限ループしない", ok, null);
  check("空文字列の本文はnull", extractFollowerCount("", "u") === null, null);
  check("JSONでない本文はnull", extractFollowerCount("<html>", "u") === null, null);
}

console.log("--- 8. 改行区切りの複数JSON ---");
{
  const body = [
    JSON.stringify({ noise: 1 }),
    JSON.stringify({ user: { username: "example_nail", follower_count: 333 } }),
  ].join("\n");
  check("2本目から取れる", extractFollowerCount(body, "example_nail") === 333,
        extractFollowerCount(body, "example_nail"));
}

console.log("--- 9. 複数見つかったら最大値を採る ---");
{
  // 検索候補の簡易オブジェクトと本体が両方入っていることがある。
  // 簡易側は値が欠けたり丸められたりするので、大きい方を信じる。
  const json = { a: { username: "u", follower_count: 1200 },
                 b: { username: "u", follower_count: 1234 } };
  check("大きい方を返す", findFollowerCount(json, "u") === 1234, findFollowerCount(json, "u"));
}

console.log(`\n結果: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: テストを走らせて失敗することを確認する**

```bash
cd ~/Projects/reels-trend-collector && node tests/verify_extract_profile.mjs
```

期待: FAIL。`Cannot find module .../scripts/extract_profile.mjs`

- [ ] **Step 3: 実装を書く**

`scripts/extract_profile.mjs`:

```js
/**
 * Instagram のプロフィールページのレスポンスからフォロワー数を抜き出す。
 *
 * 伸び率（再生数 ÷ フォロワー数）の分母になる。
 * 取れなかったときに 0 を返してはいけない。0 で割ると伸び率が無限大になり、
 * ページの上位が壊れる。取れなければ null を返し、呼び出し側で「—」と出す。
 */

import { parsePayloads } from "./extract_reel.mjs";

/** フォロワー数らしき値を取り出す。無ければ null。0 は有効な値。 */
function readCount(o) {
  const direct = o.follower_count;
  if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) return direct;

  const edge = o.edge_followed_by;
  if (edge && typeof edge === "object") {
    const c = edge.count;
    if (typeof c === "number" && Number.isFinite(c) && c >= 0) return c;
  }
  return null;
}

/**
 * username に一致するオブジェクトを再帰的に探し、フォロワー数を返す。
 *
 * 複数見つかることがある（検索候補用の簡易オブジェクトと本体など）。
 * 簡易側は値が欠けたり丸められたりするので、大きい方を信じる。
 */
export function findFollowerCount(root, username, { maxDepth = 40 } = {}) {
  if (!username || typeof username !== "string") return null;
  const target = username.toLowerCase();

  let best = null;
  const seen = new WeakSet();

  const walk = (node, depth) => {
    if (depth > maxDepth || node === null || typeof node !== "object") return;
    if (seen.has(node)) return;   // 循環参照よけ
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }

    if (typeof node.username === "string" && node.username.toLowerCase() === target) {
      const count = readCount(node);
      if (count !== null && (best === null || count > best)) best = count;
    }

    for (const key of Object.keys(node)) walk(node[key], depth + 1);
  };

  walk(root, 0);
  return best;
}

/** レスポンス本文からフォロワー数を抜き出すところまでを一息でやる。 */
export function extractFollowerCount(body, username) {
  let best = null;
  for (const payload of parsePayloads(body)) {
    const count = findFollowerCount(payload, username);
    if (count !== null && (best === null || count > best)) best = count;
  }
  return best;
}
```

- [ ] **Step 4: テストを走らせて通ることを確認する**

```bash
cd ~/Projects/reels-trend-collector && node tests/verify_extract_profile.mjs
```

期待: fail が 0

- [ ] **Step 5: Task 1 で保存した実データで動くことを確認する**

```bash
cd ~/Projects/reels-trend-collector
node -e "
import('./scripts/extract_profile.mjs').then(async (m) => {
  const fs = await import('fs');
  const f = fs.readdirSync('data/dump').find(x => x.startsWith('profile_'));
  const username = f.replace(/^profile_/, '').replace(/\.txt$/, '');
  const body = fs.readFileSync('data/dump/' + f, 'utf8');
  let best = null;
  for (const chunk of body.split('===== ')) {
    const nl = chunk.indexOf('\n');
    if (nl < 0) continue;
    const c = m.extractFollowerCount(chunk.slice(nl + 1), username);
    if (c !== null && (best === null || c > best)) best = c;
  }
  console.log(username + ' のフォロワー数: ' + best);
});
"
```

期待: 実際のフォロワー数が出る。ブラウザで同じアカウントを開いて**目視で突き合わせる**。

**null だった場合はここで止める。** `readCount` のキー候補を Task 1 Step 7 の結果に
合わせ直す。

- [ ] **Step 6: `tests/run.sh` に章を足す**

`===== 1. リール抽出ロジック =====` の直後に挿入し、以降の章番号を繰り下げる:

```bash
echo
echo "===== 2. フォロワー数の抽出 ====="
node "$ROOT/tests/verify_extract_profile.mjs"
```

- [ ] **Step 7: 全テストを走らせてコミットする**

```bash
cd ~/Projects/reels-trend-collector && bash tests/run.sh
git add scripts/extract_profile.mjs tests/verify_extract_profile.mjs tests/run.sh
git commit -m "feat: プロフィールからフォロワー数を抽出するロジック"
```

---

## Task 5: 共通ロジック（`common.py` と `retry.mjs`）

**Files:**
- Create: `scripts/common.py`, `scripts/retry.mjs`
- Test: `tests/verify_ratio.py`, `tests/verify_retry.mjs`
- Modify: `tests/run.sh`

**Interfaces:**
- Consumes: なし
- Produces:
  - Python: `JST`, `BASE_DIR`, `CONFIG_FILE`, `DATA_FILE`, `RAW_FILE`, `FRESH_FILE`,
    `FOLLOWER_FLOOR=500`, `ACCOUNT_TTL_DAYS=7`,
    `now_jst_iso() -> str`, `parse_timestamp(ts) -> datetime|None`,
    `reach_ratio(play_count, follower_count) -> float|None`
    — Task 8（collect.py）と Task 9（build_html.py）が使う
  - JS: `collectWithRetry(run, opts) -> {reels, error, lastError}`, `isFatal(msg) -> boolean`
    — Task 6（scrape.mjs）が使う

- [ ] **Step 1: 失敗するテストを書く（伸び率）**

`tests/verify_ratio.py`:

```python
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
```

- [ ] **Step 2: テストを走らせて失敗することを確認する**

```bash
cd ~/Projects/reels-trend-collector && python3 tests/verify_ratio.py
```

期待: FAIL。`ModuleNotFoundError: No module named 'common'`

- [ ] **Step 3: `common.py` を書く**

```python
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
```

- [ ] **Step 4: テストを走らせて通ることを確認する**

```bash
cd ~/Projects/reels-trend-collector && python3 tests/verify_ratio.py
```

期待: fail が 0

- [ ] **Step 5: `retry.mjs` を移植する**

`~/Projects/threads-trend-collector/scripts/retry.mjs` をほぼそのまま持ってくる。
変更点は「投稿」を「リール」に言い換え、返り値のキーを `posts` → `reels` にすること。

```js
/**
 * 1ハッシュタグぶんの取得を、必要ならやり直す。
 *
 * やり直す条件は2つ:
 *   - 例外で落ちた（タイムアウトなど）
 *   - 取れた件数が少なすぎる（読み込み途中で打ち切った可能性が高い）
 *
 * 取れたリールは、途中で例外が起きても捨てない。件数が多かった試行の結果を採用する。
 */

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 続行不能で、やり直しても無駄なエラーか。 */
export function isFatal(message) {
  return typeof message === "string" && message.includes("ログインしていません");
}

export async function collectWithRetry(run, options = {}) {
  const {
    minReels = 5,
    attempts = 2,
    retryWaitMs = 5000,
    onRetry = () => {},
    sleep = defaultSleep,
  } = options;

  let best = null;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const got = await run(attempt);
      lastError = null;
      if (!best || got.length > best.length) best = got;

      if (best.length >= minReels || attempt === attempts) break;
      onRetry(`${got.length} 件しか取れず`);
      await sleep(retryWaitMs);
    } catch (e) {
      lastError = String((e && e.message) || e).split("\n")[0];
      if (isFatal(lastError)) break;
      if (attempt === attempts) break;
      onRetry(`失敗 — ${lastError}`);
      await sleep(retryWaitMs);
    }
  }

  const reels = best || [];
  return {
    reels,
    // 1件でも取れていれば成功扱いにする。取れた分を握りつぶさないため。
    error: reels.length > 0 ? null : lastError,
    lastError,
  };
}
```

- [ ] **Step 6: `retry.mjs` のテストを書く**

`tests/verify_retry.mjs`:

```js
/**
 * retry.mjs のやり直し判定を検証する。待機は差し替えて即座に進める。
 */
import { collectWithRetry, isFatal } from "../scripts/retry.mjs";

let pass = 0, fail = 0;
function check(label, cond, actual) {
  if (cond) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}  → 実際: ${JSON.stringify(actual)}`); }
}

const nosleep = async () => {};
const reels = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i) }));

console.log("--- 1. 十分に取れたらやり直さない ---");
{
  let calls = 0;
  const out = await collectWithRetry(async () => { calls++; return reels(10); },
                                     { minReels: 5, sleep: nosleep });
  check("1回で終わる", calls === 1, calls);
  check("10件返る", out.reels.length === 10, out.reels.length);
  check("errorはnull", out.error === null, out.error);
}

console.log("--- 2. 件数不足ならやり直す ---");
{
  let calls = 0;
  const out = await collectWithRetry(async () => { calls++; return reels(calls === 1 ? 2 : 8); },
                                     { minReels: 5, sleep: nosleep });
  check("2回呼ばれる", calls === 2, calls);
  check("多い方を採る", out.reels.length === 8, out.reels.length);
}

console.log("--- 3. やり直しても足りなければ、多い方を返す ---");
{
  let calls = 0;
  const out = await collectWithRetry(async () => { calls++; return reels(calls === 1 ? 3 : 1); },
                                     { minReels: 5, sleep: nosleep });
  check("試行は2回で打ち切る", calls === 2, calls);
  check("1回目の3件を捨てない", out.reels.length === 3, out.reels.length);
  check("1件でも取れていれば成功扱い", out.error === null, out.error);
}

console.log("--- 4. 例外が起きても取れた分は捨てない ---");
{
  let calls = 0;
  const out = await collectWithRetry(async () => {
    calls++;
    if (calls === 1) return reels(3);
    throw new Error("タイムアウト");
  }, { minReels: 5, sleep: nosleep });
  check("1回目の3件が残る", out.reels.length === 3, out.reels.length);
  check("errorはnull（取れているので）", out.error === null, out.error);
  check("lastErrorには理由が残る", out.lastError === "タイムアウト", out.lastError);
}

console.log("--- 5. 全部失敗したらerrorを返す ---");
{
  const out = await collectWithRetry(async () => { throw new Error("接続できません"); },
                                     { sleep: nosleep });
  check("0件", out.reels.length === 0, out.reels.length);
  check("errorに理由が入る", out.error === "接続できません", out.error);
}

console.log("--- 6. 致命的エラーはやり直さない ---");
{
  check("ログイン切れは致命的", isFatal("ログインしていません。--login を先に実行してください。"), null);
  check("タイムアウトは致命的でない", !isFatal("タイムアウト"), null);
  check("非文字列は致命的でない", !isFatal(null), null);
  let calls = 0;
  const out = await collectWithRetry(async () => {
    calls++; throw new Error("ログインしていません");
  }, { sleep: nosleep });
  check("1回で打ち切る", calls === 1, calls);
  check("errorが返る", out.error === "ログインしていません", out.error);
}

console.log(`\n結果: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 7: テストを走らせて通ることを確認する**

```bash
cd ~/Projects/reels-trend-collector && node tests/verify_retry.mjs
```

期待: fail が 0

- [ ] **Step 8: `tests/run.sh` に章を足してコミットする**

`===== 2. フォロワー数の抽出 =====` の直後に挿入し、以降を繰り下げる:

```bash
echo
echo "===== 3. やり直し判定 ====="
node "$ROOT/tests/verify_retry.mjs"

echo
echo "===== 4. 伸び率の計算 ====="
python3 "$ROOT/tests/verify_ratio.py"
```

```bash
cd ~/Projects/reels-trend-collector && bash tests/run.sh
git add scripts/common.py scripts/retry.mjs tests/verify_ratio.py tests/verify_retry.mjs tests/run.sh
git commit -m "feat: 伸び率の計算とやり直し判定"
```

---

## Task 6: 収集フェーズ1 — ハッシュタグ巡回（`scrape.mjs`）

**このタスクだけは自動テストで検証できない。** ブラウザと実際の Instagram が要るため。
検証は「実際に動かして目で見る」で行う。だから Task 3・4 で抽出ロジックを
純関数として切り出し、テストできる部分を最大化してある。

**Files:**
- Create: `scripts/scrape.mjs`

**Interfaces:**
- Consumes: `extract_reel.mjs` の `extractFromBody`、`retry.mjs` の `collectWithRetry` / `isFatal`、`config/genres.json`
- Produces: `data/raw_latest.json` の構造 — Task 8（collect.py）が読む

```json
{
  "collected_at": "2026-09-02T07:05:00.000Z",
  "results": [
    { "genre": "ネイル", "hashtag": "ネイルデザイン", "reels": [ /* Reel */ ], "error": null }
  ],
  "accounts": {}
}
```

- [ ] **Step 1: `scrape.mjs` を書く**

```js
/**
 * Instagram のハッシュタグページをブラウザで開き、リールを集めて JSON で吐く。
 *
 * 画面の DOM ではなく、Instagram のフロントエンド自身が受け取っている JSON
 * レスポンスを傍受して、そこからリールを拾う（extract_reel.mjs 参照）。
 * クラス名の変更で壊れないようにするため。
 *
 * 初回はログインが必要:
 *   node scripts/scrape.mjs --login
 *
 * 収集:
 *   node scripts/scrape.mjs --genres config/genres.json --out data/raw_latest.json
 *
 * 主なオプション:
 *   --genre ネイル   このジャンルのハッシュタグだけ巡回する
 *   --headful        ブラウザを表示して動きを見る
 *   --delay 10       ハッシュタグ間の待機秒数（既定10秒）
 *   --dump-dir DIR   生レスポンスを保存する（抽出が空だったときの原因調査用）
 *   --limit N        先頭N個のハッシュタグだけ処理する（試運転用）
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { extractFromBody } from "./extract_reel.mjs";
import { collectWithRetry, isFatal } from "./retry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PROFILE_DIR = path.join(ROOT, ".browser-profile");

// ハッシュタグページのURL。Instagram側の仕様が変わったらここを直す。
const TAG_URL = (tag) =>
  `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`;

// インストール済みの Google Chrome を使う。実ブラウザの方が表示が安定する。
const CHROME_CANDIDATES = [
  process.env.IG_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

function parseArgs(argv) {
  const args = { delay: 10, limit: 0, headful: false, login: false, minReels: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--login") args.login = true;
    else if (a === "--headful") args.headful = true;
    else if (a === "--genres") args.genres = argv[++i];
    else if (a === "--genre") args.genre = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--dump-dir") args.dumpDir = argv[++i];
    else if (a === "--delay") args.delay = Number(argv[++i]);
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--min-reels") args.minReels = Number(argv[++i]);
  }
  return args;
}

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (p && fs.existsSync(p)) return p;
  return null;   // Playwright 同梱の Chromium にまかせる
}

/** config/genres.json から {genre, hashtag} の組を作る。 */
function loadTagPairs(file, onlyGenre) {
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const pairs = [];
  for (const [genre, entry] of Object.entries(config.genres || {})) {
    if (onlyGenre && genre !== onlyGenre) continue;
    for (const tag of entry.hashtags || []) pairs.push({ genre, hashtag: tag });
  }
  if (onlyGenre && pairs.length === 0) {
    throw new Error(`ジャンル '${onlyGenre}' が ${file} にありません。`);
  }
  return pairs;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * cond() が true になるまで待つ。固定時間の待機だと読み込みが終わる前に
 * 先へ進んでしまい、結果を取りこぼすため。
 */
async function waitUntil(cond, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(intervalMs);
  }
  return cond();
}

async function openContext({ headful }) {
  const executablePath = findChrome();
  const options = {
    headless: !headful,
    viewport: { width: 1280, height: 900 },
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  };
  if (executablePath) options.executablePath = executablePath;

  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, options);
  } catch (e) {
    const msg = e.message.split("\n")[0];
    throw new Error(
      `ブラウザを起動できませんでした: ${msg}\n` +
      `  Chrome を閉じてから再実行してください。それでも駄目なら\n` +
      `  IG_CHROME_PATH に Chrome の実行ファイルを指定してください。`
    );
  }
}

/** 手動ログイン用。ブラウザを開いて、閉じられるまで待つ。 */
async function runLogin() {
  console.log("ブラウザを開きます。Instagram にログインしてください。");
  console.log("収集専用のサブアカウントを使ってください。本家アカウントは使わないこと。");
  console.log("ログインが終わったらブラウザを閉じてください。セッションは保存されます。");
  const context = await openContext({ headful: true });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto("https://www.instagram.com/accounts/login/", { waitUntil: "domcontentloaded" });

  await new Promise((resolve) => {
    context.on("close", resolve);
    page.on("close", resolve);
  });
  console.log(`セッションを保存しました: ${PROFILE_DIR}`);
}

/** ログイン画面に飛ばされていないか確かめる。飛ばされていたら続行不能。 */
function assertLoggedIn(page) {
  const url = page.url();
  if (url.includes("/accounts/login") || url.includes("/challenge")) {
    throw new Error(
      "ログインしていません。node scripts/scrape.mjs --login を先に実行してください。"
    );
  }
}

/**
 * ページを開いて、傍受した JSON から抽出する共通処理。
 * extract は (body) => 何か配列 を受け取り、集まったものを返す。
 */
async function harvest(page, url, { dumpDir, dumpLabel, extract, keyOf, waitMs = 30000,
                                    scrolls = 3 }) {
  const bodies = [];
  const found = new Map();   // レスポンスが届くたびに随時抽出していく

  const onResponse = async (response) => {
    const u = response.url();
    if (!u.includes("instagram.com")) return;
    const type = (response.headers()["content-type"] || "").toLowerCase();
    // 結果は GraphQL の JSON で来るのが基本だが、最初の1ページが
    // HTML に埋め込まれて来ることもあるので HTML も読む。
    if (!type.includes("json") && !type.includes("html") && !u.includes("/graphql")) return;
    try {
      const body = await response.text();
      bodies.push(body);
      for (const item of extract(body)) {
        const k = keyOf(item);
        if (!found.has(k)) found.set(k, item);
      }
    } catch {
      // ナビゲーションで破棄されたレスポンスは読めないことがある。無視して続ける
    }
  };

  page.on("response", onResponse);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    assertLoggedIn(page);

    // 1件でも入ってくるまで待つ。固定待機だと読み込み前に先へ進んでしまう。
    await waitUntil(() => found.size > 0, waitMs);

    // 増えなくなるまでスクロールして追加ページを読む
    for (let i = 0; i < scrolls; i++) {
      const before = found.size;
      await page.mouse.wheel(0, 2500);
      await waitUntil(() => found.size > before, 10000);
      if (found.size === before) break;   // もう増えないので打ち切る
    }
  } finally {
    // 飛んでいる最中のレスポンスを取りこぼさないよう、少しだけ待ってから外す
    await sleep(2000);
    page.off("response", onResponse);
  }

  if (dumpDir) {
    fs.mkdirSync(dumpDir, { recursive: true });
    const safe = dumpLabel.replace(/[^\p{L}\p{N}]+/gu, "_");
    fs.writeFileSync(path.join(dumpDir, `${safe}.txt`),
                     bodies.join("\n===RESPONSE===\n"), "utf8");
  }

  return [...found.values()];
}

/** ハッシュタグ1つぶんのリールを集める。 */
async function collectHashtag(page, tag, { dumpDir }) {
  return harvest(page, TAG_URL(tag), {
    dumpDir,
    dumpLabel: `tag_${tag}`,
    extract: extractFromBody,
    keyOf: (r) => r.id,
  });
}

async function runCollect(args) {
  if (!args.genres || !args.out) {
    throw new Error("--genres と --out は必須です。");
  }

  let pairs = loadTagPairs(args.genres, args.genre);
  if (args.limit > 0) pairs = pairs.slice(0, args.limit);

  const context = await openContext({ headful: args.headful });
  const page = context.pages()[0] || (await context.newPage());
  const results = [];

  try {
    for (let i = 0; i < pairs.length; i++) {
      const { genre, hashtag } = pairs[i];
      const label = `[${i + 1}/${pairs.length}] ${genre} / #${hashtag}`;
      const outcome = await collectWithRetry(
        () => collectHashtag(page, hashtag, { dumpDir: args.dumpDir }),
        {
          minReels: args.minReels,
          onRetry: (reason) => console.log(`${label}: ${reason} / やり直します`),
        }
      );

      if (outcome.error) {
        console.log(`${label}: 失敗 — ${outcome.error}`);
        results.push({ genre, hashtag, reels: [], error: outcome.error });
      } else {
        console.log(`${label}: ${outcome.reels.length} 件`);
        results.push({ genre, hashtag, reels: outcome.reels, error: null });
      }

      if (isFatal(outcome.lastError)) break;

      // 連続アクセスを避けるため、ハッシュタグごとに間を空ける
      if (i < pairs.length - 1) {
        const jitter = args.delay * (0.8 + Math.random() * 0.4);
        await sleep(jitter * 1000);
      }
    }
  } finally {
    await context.close();
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(
    args.out,
    JSON.stringify({ collected_at: new Date().toISOString(), results, accounts: {} },
                   null, 2),
    "utf8"
  );

  const total = results.reduce((n, r) => n + r.reels.length, 0);
  const failed = results.filter((r) => r.error).length;
  console.log(`\n合計 ${total} 件を ${args.out} に書き出しました` +
              `（失敗 ${failed}/${results.length} タグ）`);
  return failed === results.length && results.length > 0 ? 1 : 0;
}

const args = parseArgs(process.argv.slice(2));
try {
  if (args.login) {
    await runLogin();
    process.exit(0);
  }
  process.exit(await runCollect(args));
} catch (e) {
  console.error(`[NG] ${e.message}`);
  process.exit(2);
}
```

- [ ] **Step 2: ログインが生きているか確認する**

Task 1 で `.browser-profile/` にセッションが保存されているはず。切れていたら:

```bash
cd ~/Projects/reels-trend-collector && node scripts/scrape.mjs --login
```

- [ ] **Step 3: 1タグだけ、ブラウザを表示して試運転する**

```bash
cd ~/Projects/reels-trend-collector
node scripts/scrape.mjs --genres config/genres.json --out data/raw_latest.json \
  --limit 1 --headful --dump-dir data/dump
```

**目で見て確認すること:**
- ブラウザが開き、ハッシュタグページが表示される（ログイン画面に飛ばない）
- スクロールが起きる
- `[1/1] ネイル / #ネイルデザイン: NN 件` と出て、NN が 1 以上

- [ ] **Step 4: 出力の中身を確認する**

```bash
python3 -c "
import json
d = json.load(open('data/reels_raw_check.json' if False else 'data/raw_latest.json'))
r = d['results'][0]
print(f\"{r['genre']} / #{r['hashtag']}: {len(r['reels'])} 件 / error={r['error']}\")
if r['reels']:
    print(json.dumps(r['reels'][0], ensure_ascii=False, indent=2))
    missing = [k for k in ('id','code','username','permalink','play_count') if not r['reels'][0].get(k)]
    print('欠けているキー:', missing or 'なし')
"
```

期待: `play_count` が入っており、`permalink` が `https://www.instagram.com/reel/...` の形。

**0件だった場合:** `data/dump/tag_*.txt` を開いて中身を見る。ログイン画面の HTML しか
入っていなければセッション切れ。JSON は来ているのにリールが取れないなら、
Task 3 の `PLAY_COUNT_KEYS` を実データに合わせ直す。

- [ ] **Step 5: permalink を1つブラウザで開いて、実在するリールか確かめる**

```bash
python3 -c "
import json; d=json.load(open('data/raw_latest.json'))
print(d['results'][0]['reels'][0]['permalink'])
"
```

出た URL をブラウザで開く。**リールが再生されれば成功。** 404 なら `code` の
組み立て方が違うので Task 3 の `normalizeReel` を直す。

- [ ] **Step 6: 3タグで通しの試運転をする**

```bash
node scripts/scrape.mjs --genres config/genres.json --out data/raw_latest.json --limit 3
```

期待: 3タグとも1件以上。タグ間に10秒前後の間が空く（体感で分かる）。

- [ ] **Step 7: コミット**

```bash
git add scripts/scrape.mjs
git commit -m "feat: ハッシュタグ巡回でリールを収集する"
```

---

## Task 7: 収集フェーズ2 — フォロワー数の補完（`scrape.mjs`）

**Files:**
- Modify: `scripts/scrape.mjs`

**Interfaces:**
- Consumes: `extract_profile.mjs` の `extractFollowerCount`、Task 8 が書き出す
  `data/_fresh_accounts.json`（`["username", ...]`）
- Produces: `data/raw_latest.json` の `accounts` を埋める — `{"username": 15677 | null}`。
  Task 8（collect.py）が読む

- [ ] **Step 1: import と URL を足す**

`scrape.mjs` の冒頭の import に追加:

```js
import { extractFollowerCount } from "./extract_profile.mjs";
```

`TAG_URL` の定義の直後に追加:

```js
// プロフィールページのURL。フォロワー数を取るために開く。
const PROFILE_URL = (username) =>
  `https://www.instagram.com/${encodeURIComponent(username)}/`;
```

- [ ] **Step 2: 引数を足す**

`parseArgs` の既定値に追加:

```js
  const args = { delay: 10, limit: 0, headful: false, login: false, minReels: 5,
                 maxProfiles: 20 };
```

`parseArgs` のループに追加:

```js
    else if (a === "--max-profiles") args.maxProfiles = Number(argv[++i]);
    else if (a === "--skip-accounts") args.skipAccounts = argv[++i];
```

- [ ] **Step 3: フォロワー数を取る関数を足す**

`collectHashtag` の直後に追加:

```js
/**
 * 1アカウントぶんのフォロワー数を取る。取れなければ null。
 *
 * 取れなかったことを 0 で埋めない。0 で割ると伸び率が無限大になり、
 * ページの上位が壊れるため。
 */
async function fetchFollowerCount(page, username, { dumpDir }) {
  const found = await harvest(page, PROFILE_URL(username), {
    dumpDir,
    dumpLabel: `profile_${username}`,
    extract: (body) => {
      const count = extractFollowerCount(body, username);
      return count === null ? [] : [{ username, count }];
    },
    // 値ごとに別のキーにして全部集める。harvest は同じキーだと最初の1件しか
    // 残さないので、キーを username にすると先に届いた小さい値（検索候補用に
    // 丸めた値など）が勝ってしまう。
    keyOf: (item) => `${username}:${item.count}`,
    waitMs: 20000,
    // プロフィールは1画面目に出る。スクロールは要らない。
    scrolls: 0,
  });
  if (!found.length) return null;
  // 丸められた値より本体の値の方が大きい。大きい方を信じる。
  return found.reduce((max, item) => (item.count > max ? item.count : max), found[0].count);
}

/** 既にフォロワー数が新しいアカウントの一覧を読む。無ければ空。 */
function loadSkipAccounts(file) {
  if (!file || !fs.existsSync(file)) return new Set();
  try {
    const list = JSON.parse(fs.readFileSync(file, "utf8"));
    return new Set(Array.isArray(list) ? list.map((u) => String(u).toLowerCase()) : []);
  } catch {
    return new Set();   // 壊れていたら「誰も既知でない」として扱う。取り直すだけで害はない
  }
}
```

- [ ] **Step 4: `runCollect` の最後にフェーズ2を差し込む**

`runCollect` の `try { ... }` ブロックの中、ハッシュタグのループの**後ろ**、
`} finally {` の**前**に挿入する:

```js
    // --- フェーズ2: フォロワー数の補完 ---
    // 伸び率の分母。1アカウント1回だけ取り、7日はキャッシュを使い回す（collect.py が管理）。
    const skip = loadSkipAccounts(args.skipAccounts);
    const seen = [];
    for (const r of results) {
      for (const reel of r.reels) {
        const u = reel.username;
        if (!u || skip.has(u.toLowerCase()) || seen.includes(u)) continue;
        seen.push(u);
      }
    }
    const targets = seen.slice(0, args.maxProfiles);
    if (seen.length > targets.length) {
      // 黙って捨てない。何を今回取らなかったかを必ず出す。
      console.log(`\nフォロワー数の取得対象 ${seen.length} 件のうち ` +
                  `${targets.length} 件だけ取ります（--max-profiles ${args.maxProfiles}）。` +
                  `残りは次回に回ります。`);
    } else if (targets.length) {
      console.log(`\nフォロワー数を ${targets.length} 件取ります。`);
    }

    for (let i = 0; i < targets.length; i++) {
      const username = targets[i];
      const label = `[${i + 1}/${targets.length}] @${username}`;
      try {
        const count = await fetchFollowerCount(page, username, { dumpDir: args.dumpDir });
        accounts[username] = count;
        console.log(`${label}: ${count === null ? "取得できず" : count.toLocaleString()}`);
      } catch (e) {
        const msg = String((e && e.message) || e).split("\n")[0];
        console.log(`${label}: 失敗 — ${msg}`);
        if (isFatal(msg)) break;
      }

      if (i < targets.length - 1) {
        const jitter = args.delay * (0.8 + Math.random() * 0.4);
        await sleep(jitter * 1000);
      }
    }
```

`const results = [];` の直後に `accounts` を宣言する:

```js
  const results = [];
  const accounts = {};   // username -> フォロワー数 | null
```

書き出し部分を差し替える:

```js
  fs.writeFileSync(
    args.out,
    JSON.stringify({ collected_at: new Date().toISOString(), results, accounts },
                   null, 2),
    "utf8"
  );
```

集計の表示も1行足す:

```js
  const total = results.reduce((n, r) => n + r.reels.length, 0);
  const failed = results.filter((r) => r.error).length;
  const gotFollowers = Object.values(accounts).filter((v) => v !== null).length;
  console.log(`\n合計 ${total} 件を ${args.out} に書き出しました` +
              `（失敗 ${failed}/${results.length} タグ / ` +
              `フォロワー数 ${gotFollowers}/${Object.keys(accounts).length} 件）`);
```

- [ ] **Step 5: ヘルプコメントを更新する**

ファイル冒頭のコメントの「主なオプション」に追加:

```
 *   --max-profiles N フォロワー数を取りに行くアカウント数の上限（既定20）
 *   --skip-accounts F 既にフォロワー数が新しいアカウントの一覧（collect.py が渡す）
```

- [ ] **Step 6: 1タグ + 3プロフィールで試運転する**

```bash
cd ~/Projects/reels-trend-collector
node scripts/scrape.mjs --genres config/genres.json --out data/raw_latest.json \
  --limit 1 --max-profiles 3 --headful
```

**目で見て確認すること:**
- ハッシュタグページの後にプロフィールページが3つ順に開く
- `[1/3] @xxxx: 15,677` のようにフォロワー数が出る
- プロフィール間に10秒前後の間が空く

- [ ] **Step 7: 出力を確認し、フォロワー数を目視で突き合わせる**

```bash
python3 -c "
import json; d=json.load(open('data/raw_latest.json'))
for u, c in d['accounts'].items():
    print(f'{u}: {c}')
"
```

出た `username` の1つを `https://www.instagram.com/<username>/` でブラウザで開き、
**画面のフォロワー数と一致するか目視で確かめる。** 一致しなければ Task 4 の
`readCount` が別の数値（フォロー中の数など）を拾っている。

- [ ] **Step 8: 上限が効くことを確認する**

```bash
node scripts/scrape.mjs --genres config/genres.json --out data/raw_latest.json \
  --limit 1 --max-profiles 2
```

期待: `フォロワー数の取得対象 NN 件のうち 2 件だけ取ります` と出て、
`data/raw_latest.json` の `accounts` が2件だけになる。

- [ ] **Step 9: 全テストを走らせてコミットする**

```bash
cd ~/Projects/reels-trend-collector && bash tests/run.sh
git add scripts/scrape.mjs
git commit -m "feat: プロフィールからフォロワー数を補完する"
```

---

## Task 8: 蓄積とマージ（`collect.py`）

**Files:**
- Create: `scripts/collect.py`
- Test: `tests/verify_merge.py`
- Modify: `tests/run.sh`

**Interfaces:**
- Consumes: `common.py` の定数一式、`scrape.mjs` が書く `data/raw_latest.json`
- Produces:
  - `data/reels.json` の構造 — Task 9（build_html.py）が読む
  - `data/_fresh_accounts.json` — Task 7（scrape.mjs `--skip-accounts`）が読む
  - 関数: `load_store()`, `save_store(store)`, `fresh_accounts(store, now)`,
    `merge_reels(store, reels, genre, hashtag, collected_at)`,
    `merge_accounts(store, accounts, collected_at)`,
    `is_relevant(caption, required_any)`, `load_required_any()`

```json
{
  "updated_at": "2026-09-02T07:12:00+09:00",
  "reels": {
    "<id>": {
      "id": "...", "code": "...", "username": "...", "caption": "...",
      "timestamp": "2026-08-30T12:00:00+0000",
      "permalink": "https://www.instagram.com/reel/.../",
      "play_count": 298000, "like_count": 12400, "comment_count": 89,
      "genres": ["ネイル"], "hashtags_hit": ["ネイルデザイン"],
      "first_seen": "...", "last_updated": "..."
    }
  },
  "accounts": { "<username>": { "follower_count": 15677, "fetched_at": "..." } }
}
```

- [ ] **Step 1: 失敗するテストを書く**

`tests/verify_merge.py`:

```python
#!/usr/bin/env python3
"""
collect.py のマージ処理を検証する。ブラウザも通信も使わない。

守りたいこと:
  1. 同じリールを重複させない
  2. 再収集で再生数・いいね・コメントを最新に更新する
  3. 複数タグでヒットしたらジャンルとタグを積み上げる
  4. フォロワー数キャッシュが7日で切れる
  5. 取れなかった値で既存の値を上書きしない
"""
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from common import JST, ACCOUNT_TTL_DAYS  # noqa: E402
from collect import (  # noqa: E402
    merge_reels, merge_accounts, fresh_accounts, is_relevant,
)

PASS = FAIL = 0


def check(label, cond, actual=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  OK   {label}")
    else:
        FAIL += 1
        print(f"  FAIL {label}  → 実際: {actual!r}")


def empty_store():
    return {"reels": {}, "accounts": {}}


def reel(**over):
    base = {
        "id": "111", "code": "C1abc", "username": "example_nail",
        "caption": "セルフでこれできたら勝ち",
        "timestamp": "2026-08-30T12:00:00+0000",
        "permalink": "https://www.instagram.com/reel/C1abc/",
        "play_count": 298000, "like_count": 12400, "comment_count": 89,
    }
    base.update(over)
    return base


T0 = "2026-09-01T07:00:00+09:00"
T1 = "2026-09-02T07:00:00+09:00"

print("--- 1. 新規の取り込み ---")
store = empty_store()
new, updated = merge_reels(store, [reel()], "ネイル", "ネイルデザイン", T0)
check("新規1件", (new, updated) == (1, 0), (new, updated))
r = store["reels"]["111"]
check("ジャンルが入る", r["genres"] == ["ネイル"], r["genres"])
check("タグが入る", r["hashtags_hit"] == ["ネイルデザイン"], r["hashtags_hit"])
check("first_seen が入る", r["first_seen"] == T0, r["first_seen"])
check("last_updated が入る", r["last_updated"] == T0, r["last_updated"])
check("再生数が入る", r["play_count"] == 298000, r["play_count"])

print("--- 2. 重複排除と数値の更新 ---")
new, updated = merge_reels(store, [reel(play_count=350000, like_count=15000)],
                           "ネイル", "ネイルデザイン", T1)
check("新規0・更新1", (new, updated) == (0, 1), (new, updated))
check("蓄積は1件のまま", len(store["reels"]) == 1, len(store["reels"]))
r = store["reels"]["111"]
check("再生数が最新に更新される", r["play_count"] == 350000, r["play_count"])
check("いいねが最新に更新される", r["like_count"] == 15000, r["like_count"])
check("first_seen は変わらない", r["first_seen"] == T0, r["first_seen"])
check("last_updated は更新される", r["last_updated"] == T1, r["last_updated"])

print("--- 3. 複数タグ・複数ジャンルの積み上げ ---")
merge_reels(store, [reel()], "ネイル", "セルフネイル", T1)
check("同じジャンルは重複しない", store["reels"]["111"]["genres"] == ["ネイル"],
      store["reels"]["111"]["genres"])
check("タグは積み上がる",
      store["reels"]["111"]["hashtags_hit"] == ["ネイルデザイン", "セルフネイル"],
      store["reels"]["111"]["hashtags_hit"])
merge_reels(store, [reel()], "アイラッシュ", "まつげパーマ", T1)
check("ジャンルも積み上がる", store["reels"]["111"]["genres"] == ["ネイル", "アイラッシュ"],
      store["reels"]["111"]["genres"])

print("--- 4. 取れなかった値で既存を上書きしない ---")
# 見たいのは「None を渡したとき、直前の値が保たれるか」。
# 直前の値を決め打ちにすると、前の章が値を書き換えたときに壊れる。
# だからマージ前の値を控えておいて、それと比べる。
before_likes = store["reels"]["111"]["like_count"]
before_comments = store["reels"]["111"]["comment_count"]
check("比較の基準になる値が入っている（この検証が空回りしていないこと）",
      before_likes is not None and before_comments is not None,
      (before_likes, before_comments))
merge_reels(store, [reel(like_count=None, comment_count=None)], "ネイル", "ネイルデザイン", T1)
check("いいねが None で潰されない",
      store["reels"]["111"]["like_count"] == before_likes,
      (store["reels"]["111"]["like_count"], before_likes))
check("コメントが None で潰されない",
      store["reels"]["111"]["comment_count"] == before_comments,
      (store["reels"]["111"]["comment_count"], before_comments))

print("--- 5. id が無いものは捨てる ---")
store2 = empty_store()
new, updated = merge_reels(store2, [reel(id=None), reel(id="")], "ネイル", "x", T0)
check("1件も入らない", len(store2["reels"]) == 0, len(store2["reels"]))
check("件数も0", (new, updated) == (0, 0), (new, updated))

print("--- 6. フォロワー数のマージ ---")
store3 = empty_store()
new, updated = merge_accounts(store3, {"example_nail": 15677, "no_data": None}, T0)
check("取れた1件だけ入る", len(store3["accounts"]) == 1, store3["accounts"])
check("新規1件", new == 1, new)
check("値が入る", store3["accounts"]["example_nail"]["follower_count"] == 15677,
      store3["accounts"]["example_nail"])
check("取得時刻が入る", store3["accounts"]["example_nail"]["fetched_at"] == T0, None)
check("取れなかったアカウントは登録しない", "no_data" not in store3["accounts"],
      list(store3["accounts"]))
new, updated = merge_accounts(store3, {"example_nail": 16000}, T1)
check("再取得で更新される", store3["accounts"]["example_nail"]["follower_count"] == 16000,
      store3["accounts"]["example_nail"])
check("新規0・更新1", (new, updated) == (0, 1), (new, updated))

print("--- 7. フォロワー数キャッシュの期限 ---")
now = datetime(2026, 9, 2, 7, 0, tzinfo=JST)
store4 = {"reels": {}, "accounts": {
    "fresh_user": {"follower_count": 100,
                   "fetched_at": (now - timedelta(days=1)).isoformat()},
    "stale_user": {"follower_count": 200,
                   "fetched_at": (now - timedelta(days=ACCOUNT_TTL_DAYS + 1)).isoformat()},
    "edge_user": {"follower_count": 300,
                  "fetched_at": (now - timedelta(days=ACCOUNT_TTL_DAYS,
                                                 hours=-1)).isoformat()},
    "broken_user": {"follower_count": 400, "fetched_at": "こわれた日付"},
    "no_time_user": {"follower_count": 500},
}}
fresh = set(fresh_accounts(store4, now))
check("1日前は新しい", "fresh_user" in fresh, sorted(fresh))
check("8日前は古い（取り直す）", "stale_user" not in fresh, sorted(fresh))
check("7日ぎりぎり手前は新しい", "edge_user" in fresh, sorted(fresh))
check("日付が壊れていたら取り直す", "broken_user" not in fresh, sorted(fresh))
check("取得時刻が無ければ取り直す", "no_time_user" not in fresh, sorted(fresh))

print("--- 8. 関連度フィルタ ---")
words = ["ネイル", "爪", "ジェル"]
check("必須語を含めば通る", is_relevant("今日のネイルデザイン", words))
check("必須語が無ければ落とす", not is_relevant("今日のランチ", words))
check("キャプションが空なら通す（判定材料が無いため）", is_relevant("", words))
check("キャプションが None でも通す", is_relevant(None, words))
check("必須語が空ならフィルタしない", is_relevant("今日のランチ", []))

print(f"\n結果: {PASS} pass / {FAIL} fail")
sys.exit(0 if FAIL == 0 else 1)
```

- [ ] **Step 2: テストを走らせて失敗することを確認する**

```bash
cd ~/Projects/reels-trend-collector && python3 tests/verify_merge.py
```

期待: FAIL。`ModuleNotFoundError: No module named 'collect'`

- [ ] **Step 3: `collect.py` を書く**

```python
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
  python3 scripts/collect.py --genre ネイル              # 1ジャンルだけ（自動実行はこの形）
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
REEL_FIELDS = ("id", "code", "username", "caption", "timestamp", "permalink",
               "play_count", "like_count", "comment_count")


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
    parser.add_argument("--max-profiles", type=int, default=20,
                        help="フォロワー数を取りに行くアカウント数の上限（既定20）")
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
```

- [ ] **Step 4: テストを走らせて通ることを確認する**

```bash
cd ~/Projects/reels-trend-collector && python3 tests/verify_merge.py
```

期待: fail が 0

- [ ] **Step 5: Task 7 の実データでマージを通す**

```bash
cd ~/Projects/reels-trend-collector
python3 scripts/collect.py --from-raw data/raw_latest.json
```

期待の出力:
- `新規: NN 件 / 更新: 0 件`
- `フォロワー数: 新規 N 件`
- `保存しました: .../data/reels.json`

- [ ] **Step 6: もう一度同じ raw でマージし、重複しないことを確認する**

```bash
python3 scripts/collect.py --from-raw data/raw_latest.json
python3 -c "
import json; d=json.load(open('data/reels.json'))
print(f\"リール {len(d['reels'])} 件 / アカウント {len(d['accounts'])} 件\")
"
```

期待: 2回目は `新規: 0 件 / 更新: NN 件`。リール件数が1回目と同じ。

- [ ] **Step 7: 関連度フィルタが効きすぎていないか確認する**

```bash
python3 scripts/collect.py --from-raw data/raw_latest.json --dry-run
```

`関連度フィルタで除外: NN 件` の NN と、除外されたサンプルを**目で見る**。
本来残すべきリールが落ちていたら `config/genres.json` の `required_any` に語を足す。
除外が全体の半分を超えるようなら、必須語が厳しすぎる。

- [ ] **Step 8: `tests/run.sh` に章を足してコミットする**

`===== 4. 伸び率の計算 =====` の直後に挿入し、以降を繰り下げる:

```bash
echo
echo "===== 5. マージ処理 ====="
python3 "$ROOT/tests/verify_merge.py"
```

```bash
cd ~/Projects/reels-trend-collector && bash tests/run.sh
git add scripts/collect.py tests/verify_merge.py tests/run.sh
git commit -m "feat: 収集結果を蓄積データにマージする"
```

---

## Task 9: 表示データの組み立て（`build_html.py` のロジック部）

HTML テンプレートは Task 10 で書く。このタスクでは**データを組み立てる部分だけ**を作り、
テンプレートは仮の最小 HTML にしておく。並び替えと絞り込みのロジックを先に固めるため。

**Files:**
- Create: `scripts/build_html.py`（ロジック部 + 仮テンプレート）
- Test: `tests/verify_select.py`, `tests/make_fixture.py`
- Modify: `tests/run.sh`

**Interfaces:**
- Consumes: `common.py` の `reach_ratio` / `parse_timestamp` / `JST`、`data/reels.json`
- Produces:
  - `build_rows(store, now=None) -> list[Row]`
  - `select_rows(rows, max_age_days, max_reels) -> (list[Row], int, int)`
  - `build_summary(rows, store, archived) -> dict`
  - `render_html(rows, generated_at, store, archived) -> str`
  - `Row = {id, username, caption, permalink, plays, likes, comments, followers,
            ratio, ageHours, postedAt, genres, hashtags}`
  - Task 10 がテンプレートを差し替え、`__DATA__` などのプレースホルダを使う

- [ ] **Step 1: フィクスチャ生成スクリプトを書く**

`tests/make_fixture.py`:

```python
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

GENRES = ["ネイル", "顔まわり", "まつげ・眉・メイク", "髪・脱毛・痩身"]
TAGS = {
    "ネイル": "ネイルデザイン",
    "顔まわり": "小顔",
    "まつげ・眉・メイク": "まつげパーマ",
    "髪・脱毛・痩身": "医療脱毛",
}


def build(now):
    reels = {}
    accounts = {}

    # 1〜24: 普通のリール。ジャンルを4種に散らし、経過日数も散らす。
    for i in range(1, 25):
        genre = GENRES[i % 4]
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
        "genres": ["ネイル"], "hashtags_hit": ["セルフネイル"],
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
        "genres": ["顔まわり"], "hashtags_hit": ["小顔"],
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
        "genres": ["ネイル"], "hashtags_hit": ["ネイルサロン"],
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
        "genres": ["髪・脱毛・痩身"], "hashtags_hit": ["育毛"],
        "first_seen": now.isoformat(), "last_updated": now.isoformat(),
    }
    accounts["old_reel"] = {"follower_count": 2_000, "fetched_at": now.isoformat()}

    return {"updated_at": now.isoformat(), "reels": reels, "accounts": accounts}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    # 固定時刻。実行するたびに結果が変わらないようにする。
    now = datetime(2026, 9, 2, 7, 0, tzinfo=JST)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(build(now), ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"作成しました: {args.output}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 失敗するテストを書く**

`tests/verify_select.py`:

```python
#!/usr/bin/env python3
"""
build_html.py のデータ組み立てと絞り込みを検証する。

守りたいこと:
  1. 伸び率がフォロワー数から正しく計算される。取れなければ None
  2. 期間フィルタが投稿日時を基準にする。投稿日時が無いものは落とさない
  3. 件数を絞るとき、伸び率上位と新着上位を半分ずつ確保する
  4. 何件をどの理由で落としたかを返す（黙って捨てない）
"""
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import JST  # noqa: E402
from build_html import build_rows, select_rows, build_summary  # noqa: E402
from make_fixture import build as build_fixture  # noqa: E402

PASS = FAIL = 0


def check(label, cond, actual=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  OK   {label}")
    else:
        FAIL += 1
        print(f"  FAIL {label}  → 実際: {actual!r}")


NOW = datetime(2026, 9, 2, 7, 0, tzinfo=JST)
store = build_fixture(NOW)
rows = build_rows(store, now=NOW)
by_id = {r["id"]: r for r in rows}

print("--- 1. 行の組み立て ---")
check("28件すべて行になる", len(rows) == 28, len(rows))
r1 = by_id["r1"]
check("再生数が入る", r1["plays"] == 485_000, r1["plays"])
check("フォロワー数が入る", r1["followers"] == 1_900, r1["followers"])
check("伸び率が計算される", r1["ratio"] is not None and abs(r1["ratio"] - 485_000 / 1_900) < 0.1,
      r1["ratio"])
check("ジャンルが入る", r1["genres"] == ["顔まわり"], r1["genres"])
check("permalink が入る", r1["permalink"].startswith("https://www.instagram.com/reel/"),
      r1["permalink"])

print("--- 2. フォロワー数が取れていない場合 ---")
r25 = by_id["r25"]
check("伸び率は None", r25["ratio"] is None, r25["ratio"])
check("フォロワー数も None", r25["followers"] is None, r25["followers"])
check("再生数はそのまま持つ", r25["plays"] == 999_999, r25["plays"])

print("--- 3. 下限クランプ ---")
r26 = by_id["r26"]
check("フォロワー20人は500人扱い（×20）", abs(r26["ratio"] - 20.0) < 0.01, r26["ratio"])

print("--- 4. 投稿時刻が取れていない場合 ---")
r27 = by_id["r27"]
check("ageHours は None", r27["ageHours"] is None, r27["ageHours"])
check("postedAt は空文字", r27["postedAt"] == "", r27["postedAt"])

print("--- 5. 期間フィルタ ---")
selected, aged_out, over_cap = select_rows(rows, 180, 0)
ids = {r["id"] for r in selected}
check("1年前のリールは落ちる", "r28" not in ids, sorted(ids))
check("落ちたのは1件", aged_out == 1, aged_out)
check("投稿時刻が無いリールは残る", "r27" in ids, sorted(ids))
check("上限で落ちたのは0件", over_cap == 0, over_cap)
selected_all, aged_all, _ = select_rows(rows, 0, 0)
check("max_age_days=0 なら期間で落とさない", aged_all == 0 and len(selected_all) == 28,
      (aged_all, len(selected_all)))

print("--- 6. 件数の上限と、伸び率上位・新着上位の半々確保 ---")
selected, aged_out, over_cap = select_rows(rows, 0, 6)
check("6件に絞られる", len(selected) == 6, len(selected))
check("落とした件数を返す", over_cap == 28 - 6, over_cap)
ids = {r["id"] for r in selected}

ranked = [r for r in rows if r["ratio"] is not None]
top_ratio = sorted(ranked, key=lambda r: -r["ratio"])[:3]
check("伸び率上位3件が全部入っている",
      all(r["id"] in ids for r in top_ratio), [r["id"] for r in top_ratio])

dated = [r for r in rows if r["ageHours"] is not None]
newest = sorted(dated, key=lambda r: r["ageHours"])[:3]
check("新着上位3件が全部入っている",
      all(r["id"] in ids for r in newest), [r["id"] for r in newest])

print("--- 7. 上限に届かないときは絞らない ---")
selected, _, over_cap = select_rows(rows, 0, 1000)
check("全件そのまま", len(selected) == 28, len(selected))
check("落とした件数は0", over_cap == 0, over_cap)

print("--- 8. 重複を二重に数えない ---")
# 伸び率上位と新着上位が重なっても、合計が上限を超えないこと
selected, _, _ = select_rows(rows, 0, 4)
check("4件ちょうど", len(selected) == 4, len(selected))
check("id が重複しない", len({r["id"] for r in selected}) == 4,
      [r["id"] for r in selected])

print("--- 9. 集計 ---")
summary = build_summary(rows, store, archived=28)
check("総数", summary["total"] == 28, summary["total"])
check("ジャンルが4種", len(summary["genres"]) == 4, summary["genres"])
check("ジャンルは件数の多い順", 
      all(summary["genres"][i][1] >= summary["genres"][i + 1][1]
          for i in range(len(summary["genres"]) - 1)), summary["genres"])
check("アカウント数", summary["authors"] == len({r["username"] for r in rows}),
      summary["authors"])
check("伸び率100倍超の件数が数えられている",
      summary["over100"] == len([r for r in rows if r["ratio"] is not None
                                 and r["ratio"] >= 100]), summary["over100"])
check("今週の件数", summary["thisWeek"] == len([r for r in rows
                                            if r["ageHours"] is not None
                                            and r["ageHours"] <= 168]),
      summary["thisWeek"])

print(f"\n結果: {PASS} pass / {FAIL} fail")
sys.exit(0 if FAIL == 0 else 1)
```

- [ ] **Step 3: テストを走らせて失敗することを確認する**

```bash
cd ~/Projects/reels-trend-collector && python3 tests/verify_select.py
```

期待: FAIL。`ModuleNotFoundError: No module named 'build_html'`

- [ ] **Step 4: `build_html.py` のロジック部を書く**

```python
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
```

- [ ] **Step 5: テストを走らせて通ることを確認する**

```bash
cd ~/Projects/reels-trend-collector && python3 tests/verify_select.py
```

期待: fail が 0

- [ ] **Step 6: 実データで生成して、伸び率を手計算と突き合わせる**

```bash
cd ~/Projects/reels-trend-collector
python3 scripts/build_html.py
python3 -c "
import json, sys
sys.path.insert(0, 'scripts')
from build_html import build_rows
store = json.load(open('data/reels.json'))
rows = build_rows(store)
print(f'{len(rows)} 件')
for r in rows[:5]:
    f = r['followers']
    print(f\"×{r['ratio']}  @{r['username']}  再生{r['plays']}  フォロワー{f}\")
    if f: print(f'   検算: {r[\"plays\"]} / max({f},500) = {r[\"plays\"]/max(f,500):.1f}')
"
```

期待: 表示された伸び率と検算値が一致する。

- [ ] **Step 7: `tests/run.sh` に章を足してコミットする**

`===== 5. マージ処理 =====` の直後に挿入し、以降を繰り下げる:

```bash
echo
echo "===== 6. 表示範囲の絞り込み ====="
python3 "$ROOT/tests/verify_select.py"
```

```bash
cd ~/Projects/reels-trend-collector && bash tests/run.sh
git add scripts/build_html.py tests/verify_select.py tests/make_fixture.py tests/run.sh
git commit -m "feat: 表示データの組み立てと絞り込み"
```

---

## Task 10: 画面（HTMLテンプレート・ジャンルタブ・並び替え・改行ルール）

**Files:**
- Modify: `scripts/build_html.py`（`TEMPLATE` を本物に差し替え）
- Test: `tests/verify_html.mjs`, `tests/verify_wrapping.mjs`
- Modify: `tests/run.sh`

**Interfaces:**
- Consumes: Task 9 の `render_html` が埋めるプレースホルダ
  `__DATA__` / `__GENRES__` / `__HASHTAGS__` / `__SUMMARY__` / `__GENERATED__` / `__COUNT__`
- Produces: `docs/index.html`（単一ファイル完結・外部リソース参照なし）

### 画面に出す自前の文言と、その文節分割

**改行ルール（Global Constraints 参照）に従い、以下はすべて `<span class="nb">` で
文節ごとに括る。** 括りの先頭が助詞にならないよう、この分割をそのまま使うこと。

| 場所 | 文言 | 文節分割 |
|---|---|---|
| 見出し副題 `.ver` | ネイル、顔まわり、まつげ・眉・メイク、髪・脱毛・痩身 ver | `ネイル、` / `顔まわり、` / `まつげ・眉・メイク、` / `髪・脱毛・痩身 ver` |
| 該当なし `.empty` | 条件に合うリールがありません。絞り込みを外してみてください。 | `条件に` / `合う` / `リールが` / `ありません。` / `絞り込みを` / `外して` / `みてください。` |
| 伸び率の注記 `.note-ratio` | 伸び率は再生数をフォロワー数で割った値です。フォロワーが500人未満のアカウントは500人として計算しています。 | `伸び率は` / `再生数を` / `フォロワー数で` / `割った` / `値です。` / `フォロワーが` / `500人未満の` / `アカウントは` / `500人として` / `計算しています。` |
| サムネ注記 `.note-thumb` | サムネイル画像は数時間で失効するため表示していません。 | `サムネイル画像は` / `数時間で` / `失効するため` / `表示していません。` |

短いラベル（`総リール数` `伸び率100倍超` `今週の投稿` `アカウント数` `ジャンル別の内訳`
`伸び率順` `再生数順` `新着順` `再生` `いいね` `コメント` `フォロワー` `リールを開く`）は
分割せず、CSS の `white-space: nowrap` で丸ごと割れないようにする。

**収集したキャプション（他人の文章）はこのルールの対象外。** `.nb` で括らない。

- [ ] **Step 1: 失敗するテストを書く（表示ロジック）**

`tests/verify_html.mjs`:

```js
/**
 * 生成した HTML を jsdom で実際に動かし、タブと並び替えが機能するか検証する。
 * 通信もブラウザも使わない（jsdom はローカルの DOM 実装）。
 */
import fs from 'fs';
import { pathToFileURL } from 'url';

const { JSDOM } = await import(
  pathToFileURL(`${process.env.SCRATCH}/node_modules/jsdom/lib/api.js`).href
);

const html = fs.readFileSync(process.env.SCRATCH + '/preview.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously' });
const doc = dom.window.document;

let pass = 0, fail = 0;
function check(label, cond, actual) {
  if (cond) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}  → 実際: ${JSON.stringify(actual)}`); }
}

const cards = () => [...doc.querySelectorAll('.card')];
const visible = () => cards().filter(c => c.style.display !== 'none');
const click = (el) => el.dispatchEvent(new dom.window.Event('click', { bubbles: true }));

console.log('--- 1. 外部リソースを参照していない ---');
{
  const srcs = [...doc.querySelectorAll('[src], link[href]')]
    .map(e => e.getAttribute('src') || e.getAttribute('href'))
    .filter(u => u && /^https?:/i.test(u));
  check('外部の src / link href が無い（単一ファイル完結）', srcs.length === 0, srcs);
  check('img タグが無い（サムネイルは出さない）',
        doc.querySelectorAll('img').length === 0,
        [...doc.querySelectorAll('img')].map(e => e.src));
  check('noindex が入っている',
        /noindex/.test(doc.querySelector('meta[name="robots"]')?.content || ''), null);
}

console.log('--- 2. カードが描画される ---');
{
  check('カードが1件以上ある', cards().length > 0, cards().length);
  const first = cards()[0];
  check('リンクが instagram.com/reel/ を指す',
        /^https:\/\/www\.instagram\.com\/reel\//.test(
          first.querySelector('a.link').getAttribute('href')), null);
  check('リンクは新しいタブで開く',
        first.querySelector('a.link').getAttribute('target') === '_blank', null);
  check('rel に noopener が入っている',
        /noopener/.test(first.querySelector('a.link').getAttribute('rel') || ''), null);
}

console.log('--- 3. ジャンルタブ ---');
{
  const tabs = [...doc.querySelectorAll('.tab')];
  check('タブが5個（全部 + 4ジャンル）', tabs.length === 5, tabs.map(t => t.textContent));
  check('先頭は「全部」', tabs[0].textContent.includes('全部'), tabs[0].textContent);

  const before = visible().length;
  const nail = tabs.find(t => t.textContent.includes('ネイル')
                              && !t.textContent.includes('まつげ'));
  click(nail);
  const after = visible();
  check('ネイルタブで件数が減る', after.length > 0 && after.length < before,
        [before, after.length]);
  check('表示されたカードは全部ネイル',
        after.every(c => c.dataset.genres.split('|').includes('ネイル')),
        after.map(c => c.dataset.genres));
  check('押したタブに選択状態が付く', nail.classList.contains('on'), nail.className);

  click(tabs[0]);
  check('「全部」で元に戻る', visible().length === before, visible().length);
}

console.log('--- 4. 並び替え ---');
{
  const buttons = [...doc.querySelectorAll('.sort-btn')];
  check('並び替えは3種類', buttons.length === 3, buttons.map(b => b.textContent));

  const nums = (attr) => visible().map(c => {
    const v = c.dataset[attr];
    return v === '' ? null : Number(v);
  });
  const descOk = (arr) => {
    const known = arr.filter(v => v !== null);
    const idx = arr.findIndex(v => v === null);
    // null（取れていない値）は必ず末尾に固まる
    const nullsAtEnd = idx === -1 || arr.slice(idx).every(v => v === null);
    return nullsAtEnd && known.every((v, i) => i === 0 || known[i - 1] >= v);
  };

  click(buttons.find(b => b.textContent.includes('伸び率順')));
  check('伸び率の降順に並ぶ（取れていない分は末尾）', descOk(nums('ratio')), nums('ratio'));

  click(buttons.find(b => b.textContent.includes('再生数順')));
  check('再生数の降順に並ぶ', descOk(nums('plays')), nums('plays'));

  click(buttons.find(b => b.textContent.includes('新着順')));
  const posted = visible().map(c => c.dataset.posted);
  const dated = posted.filter(p => p !== '');
  check('新しい順に並ぶ',
        dated.every((p, i) => i === 0 || dated[i - 1] >= p), dated);
  check('投稿日時が無いカードは末尾', posted.filter(p => p === '').length === 0
        || posted.slice(posted.indexOf('')).every(p => p === ''), posted);
}

console.log('--- 5. 取れていない値の表示 ---');
{
  click([...doc.querySelectorAll('.tab')][0]);
  const noRatio = cards().find(c => c.dataset.ratio === '');
  check('伸び率が取れていないカードがある（フィクスチャ由来）', noRatio !== undefined, null);
  check('伸び率は「—」と出す（0 と出さない）',
        noRatio.querySelector('.ratio').textContent.includes('—'),
        noRatio.querySelector('.ratio').textContent);
  check('フォロワー数も「—」と出す',
        noRatio.querySelector('.followers').textContent.includes('—'),
        noRatio.querySelector('.followers').textContent);
}

console.log('--- 6. 絞り込みで0件になったとき ---');
{
  const q = doc.getElementById('q');
  q.value = 'ぜったいに存在しない語';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  check('カードが全部隠れる', visible().length === 0, visible().length);
  check('該当なしのメッセージが出る', doc.querySelector('.empty') !== null, null);
  q.value = '';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  check('空に戻すとカードが戻る', visible().length > 0, visible().length);
}

console.log('--- 7. 集計 ---');
{
  check('集計パネルがある', doc.querySelector('.summary') !== null, null);
  check('統計タイルが4枚', doc.querySelectorAll('.stat').length === 4,
        doc.querySelectorAll('.stat').length);
  check('ジャンル別の内訳がある', doc.querySelectorAll('.bar-row').length === 4,
        doc.querySelectorAll('.bar-row').length);
}

console.log('--- 8. 件数上限に当たった版 ---');
{
  const trimmed = fs.readFileSync(process.env.SCRATCH + '/preview_trimmed.html', 'utf8');
  const d2 = new JSDOM(trimmed, { runScripts: 'dangerously' });
  check('3件に絞られている', d2.window.document.querySelectorAll('.card').length === 3,
        d2.window.document.querySelectorAll('.card').length);
}

console.log(`\n結果: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: 失敗するテストを書く（改行の作法）**

`tests/verify_wrapping.mjs`:

```js
/**
 * 改行の作法を検証する（CLAUDE.md の日本語コピー改行ルール）。
 *
 * 守りたいこと:
 *   1. 単語の途中で改行しない（「デザイン」を「デ」で割らない）
 *   2. 「を」「と」などの助詞が行頭に来ない
 *
 * 1 は CSS の word-break で決まる。break-word / break-all は途中で割るので使わない。
 * 2 は CSS では防げないため、自前の文言を文節ごとに nowrap で囲って担保する。
 *   （収集したキャプションは他人の文章なので、ここでは対象外）
 */
import fs from 'fs';
import { pathToFileURL } from 'url';

const { JSDOM } = await import(
  pathToFileURL(`${process.env.SCRATCH}/node_modules/jsdom/lib/api.js`).href
);

const html = fs.readFileSync(process.env.SCRATCH + '/preview.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously' });
const doc = dom.window.document;
const cssRaw = doc.querySelector('style').textContent;
// コメント内の説明文に反応しないよう、実際の指定だけを見る
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');

let pass = 0, fail = 0;
function check(label, cond, actual) {
  if (cond) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}  → 実際: ${JSON.stringify(actual)}`); }
}

console.log('--- 1. 単語の途中で改行しない ---');
const badBreaks = css.match(/word-break:\s*(break-word|break-all)/g);
check('word-break に break-word / break-all を使っていない', badBreaks === null, badBreaks);
check('word-break: normal を指定している', /word-break:\s*normal/.test(css), null);
check('あふれる時だけ折る overflow-wrap を使っている',
      /overflow-wrap:\s*break-word/.test(css), null);
check('日本語の禁則を強める line-break: strict がある',
      /line-break:\s*strict/.test(css), null);
check('キャプションにも適用されている',
      /\.caption\s*\{[^}]*word-break:\s*normal/s.test(css), null);

console.log('--- 2. 文節をまとめる仕組み ---');
check('.nb が nowrap で定義されている', /\.nb\s*\{\s*white-space:\s*nowrap/.test(css), null);

console.log('--- 3. 短いラベルが途中で割れない ---');
for (const cls of ['stat-value', 'stat-label', 'count', 'tag', 'link',
                   'ratio', 'metric', 'bar-name', 'bar-count',
                   'breakdown-title', 'sort-btn', 'tab', 'followers']) {
  check(`.${cls} が nowrap`,
        new RegExp(`\\.${cls}\\s*\\{[^}]*white-space:\\s*nowrap`, 's').test(css), null);
}

console.log('--- 4. 助詞が行頭に来ないこと（自前の文言） ---');
// 該当なしのメッセージを出させる
const q = doc.getElementById('q');
q.value = 'ぜったいに存在しない語';
q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
const empty = doc.querySelector('.empty');
check('該当なしのメッセージが出る', empty !== null, null);
const emptyUnits = [...empty.querySelectorAll('.nb')].map(e => e.textContent);
check('文節ごとに分かれている', emptyUnits.length >= 5, emptyUnits);
check('「絞り込みを」が1かたまりになっている', emptyUnits.includes('絞り込みを'), emptyUnits);
check('全文が .nb の中に収まっている',
      emptyUnits.join('') === empty.textContent,
      { units: emptyUnits.join(''), all: empty.textContent });

// 助詞で始まるかたまりが無いこと
const PARTICLES = ['を', 'と', 'は', 'が', 'に', 'で', 'の', 'も', 'へ', 'や', 'から', 'まで'];
const allUnits = [...doc.querySelectorAll('.nb')].map(e => e.textContent.trim()).filter(Boolean);
const startsWithParticle = allUnits.filter(t => PARTICLES.some(p => t.startsWith(p)));
check('助詞で始まるかたまりが無い', startsWithParticle.length === 0, startsWithParticle);

console.log('--- 5. 見出しのジャンル表記 ---');
const verUnits = [...doc.querySelectorAll('.ver .nb')].map(e => e.textContent);
check('読点の位置でだけ改行できる（4かたまり）', verUnits.length === 4, verUnits);
check('ジャンル名が途中で割れない', verUnits.every(u => !/^[、\s]/.test(u)), verUnits);

console.log('--- 6. 注記も文節で括られている ---');
const ratioUnits = [...doc.querySelectorAll('.note-ratio .nb')].map(e => e.textContent);
check('伸び率の注記が文節ごとに分かれている', ratioUnits.length >= 8, ratioUnits);
check('「フォロワー数で」が1かたまり', ratioUnits.includes('フォロワー数で'), ratioUnits);
check('注記の全文が .nb に収まっている',
      ratioUnits.join('') === doc.querySelector('.note-ratio').textContent,
      ratioUnits.join(''));

const thumbUnits = [...doc.querySelectorAll('.note-thumb .nb')].map(e => e.textContent);
check('サムネ注記が文節ごとに分かれている', thumbUnits.length === 4, thumbUnits);
check('「サムネイル画像は」が1かたまり', thumbUnits.includes('サムネイル画像は'), thumbUnits);

console.log(`\n結果: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 3: テストを走らせて失敗することを確認する**

```bash
cd ~/Projects/reels-trend-collector
WORK="${TMPDIR:-/tmp}/reels-trend-collector-test"
mkdir -p "$WORK"
[ -d "$WORK/node_modules/jsdom" ] || npm install --prefix "$WORK" --cache "$WORK/.npm-cache" jsdom --no-audit --no-fund
python3 tests/make_fixture.py --output "$WORK/fixture_reels.json"
python3 scripts/build_html.py --input "$WORK/fixture_reels.json" --output "$WORK/preview.html"
SCRATCH="$WORK" node tests/verify_html.mjs
```

期待: FAIL。仮テンプレートには `.card` も `.tab` も無い。

- [ ] **Step 4: `TEMPLATE` を本物に差し替える**

`scripts/build_html.py` の `TEMPLATE` を丸ごと差し替える。**必ず満たすこと:**

- 外部リソースを一切参照しない（`<link href="https://...">` も `<img>` も禁止）。
  **Webフォントも使わない。** `threads-trend-collector` は Google Fonts を読んでいるが、
  ここでは端末のフォントだけで組む（`tests/verify_html.mjs` が外部 href を弾く）
- `<meta name="robots" content="noindex, nofollow">` を入れる
- `<style>` は1つだけ（テストが `doc.querySelector('style')` で取る）
- 上の表の文言をすべて `<span class="nb">` で文節ごとに括る
- カードの `dataset` に `genres`（`|` 区切り）、`ratio`、`plays`、`posted` を持たせる。
  取れていない値は**空文字**にする（`0` にしない）

骨格:

```python
TEMPLATE = r"""
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

  /* --- 収集したキャプション。他人の文章なので .nb で括らない --- */
  .caption {
    word-break: normal;
    overflow-wrap: break-word;
    line-break: strict;
    color: var(--muted);
    font-size: .88rem;
  }

  /* 以下、レイアウトの装飾を書く。
     ここから先は threads-trend-collector/scripts/build_html.py の TEMPLATE を
     参考にしてよい。ただし上の必須指定を消さないこと。 */
</style>

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

  function num(v) { return v === null || v === undefined ? '—' : v.toLocaleString(); }

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
    return '<div class="bar-row"><span class="bar-name">' + g[0] +
           '</span><span class="bar-track"><span class="bar-fill" style="width:' + pct +
           '%"></span></span><span class="bar-count">' + g[1] + '</span></div>';
  }).join('');

  /* --- ジャンルタブ --- */
  var tabs = document.getElementById('tabs');
  tabs.innerHTML = ['全部'].concat(GENRES).map(function (g, i) {
    return '<button type="button" class="tab' + (i === 0 ? ' on' : '') +
           '" data-genre="' + (i === 0 ? '' : g) + '">' + g + '</button>';
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
        '<span class="user">@' + r.username + '</span>' +
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
        return '<span class="tag">#' + h + '</span>';
      }).join('') + '</div>' +
      '<a class="link" target="_blank" rel="noopener noreferrer" href="' +
        r.permalink + '">リールを開く</a>';
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
```

装飾（余白・角丸・色の当て方）は `threads-trend-collector/scripts/build_html.py` の
`TEMPLATE` を参考にしてよい。**ただし上に書いた必須の CSS 指定と `.nb` の構造は消さないこと。**

- [ ] **Step 5: プレビューを生成してテストを走らせる**

```bash
cd ~/Projects/reels-trend-collector
WORK="${TMPDIR:-/tmp}/reels-trend-collector-test"
python3 tests/make_fixture.py --output "$WORK/fixture_reels.json"
python3 scripts/build_html.py --input "$WORK/fixture_reels.json" --output "$WORK/preview.html"
python3 scripts/build_html.py --input "$WORK/fixture_reels.json" \
  --output "$WORK/preview_trimmed.html" --max-reels 3 > /dev/null
SCRATCH="$WORK" node tests/verify_html.mjs
SCRATCH="$WORK" node tests/verify_wrapping.mjs
```

期待: 両方とも fail が 0

- [ ] **Step 6: 実際にブラウザで開いて目視する**

```bash
open "$WORK/preview.html"
```

**目で見て確認すること（CLAUDE.md の「実際のレンダリング結果で改行位置を目視確認する」）:**
- ジャンルタブを押すと件数が変わる
- 並び替え3つがそれぞれ効く
- 伸び率が取れていないカードに `—` が出る（`0` や `×0` ではない）
- **ウィンドウ幅を狭めても、自前の文言が単語の途中で割れない**
- **助詞（を・が・は…）で始まる行が無い**
- OSのダークモードを切り替えても文字が読める

- [ ] **Step 7: 実データでも生成して目視する**

```bash
python3 scripts/build_html.py
open docs/index.html
```

- [ ] **Step 8: `tests/run.sh` に章を足してコミットする**

`===== 6. 表示範囲の絞り込み =====` の直後に挿入し、以降を繰り下げる:

```bash
echo
echo "===== 7. HTML生成 ====="
python3 "$ROOT/tests/make_fixture.py" --output "$WORK/fixture_reels.json"
python3 "$ROOT/scripts/build_html.py" --input "$WORK/fixture_reels.json" \
  --output "$WORK/preview.html"
# 件数上限に当たったときの表示も確かめるため、絞り込みが起きる版も作る
python3 "$ROOT/scripts/build_html.py" --input "$WORK/fixture_reels.json" \
  --output "$WORK/preview_trimmed.html" --max-reels 3 > /dev/null
SCRATCH="$WORK" node "$ROOT/tests/verify_html.mjs"

echo
echo "===== 8. 改行の作法 ====="
SCRATCH="$WORK" node "$ROOT/tests/verify_wrapping.mjs"
```

```bash
cd ~/Projects/reels-trend-collector && bash tests/run.sh
git add scripts/build_html.py tests/verify_html.mjs tests/verify_wrapping.mjs tests/run.sh
git commit -m "feat: ジャンルタブと3種の並び替えを持つ一覧ページ"
```

---

## Task 11: GitHub Pages への公開

**Files:**
- Create: `scripts/publish.sh`, `scripts/setup_github.sh`
- Test: `tests/verify_publish.sh`
- Modify: `tests/run.sh`

**Interfaces:**
- Consumes: `docs/index.html`（Task 10 が生成）
- Produces: `bash scripts/publish.sh [ログファイル]` — Task 12（run_collect.sh）が呼ぶ

- [ ] **Step 1: 失敗するテストを書く**

`tests/verify_publish.sh`:

```bash
#!/usr/bin/env bash
# publish.sh の公開判定を、ローカルのベアリポジトリだけで検証する。
# GitHub にも通信にも触らない。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
W="${TMPDIR:-/tmp}/rtc-publish-test-$$"
PASS=0; FAIL=0

check() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  OK   $1";
  else FAIL=$((FAIL+1)); echo "  FAIL $1  → 期待 $3 / 実際 $2"; fi
}

mkdir -p "$W"
export GIT_TEMPLATE_DIR="$W/tpl"; mkdir -p "$GIT_TEMPLATE_DIR"

# 遠隔リポジトリの代わりになるベアリポジトリ
git init -q --bare "$W/remote.git"

# 作業リポジトリを本番と同じ形で用意する
WORK="$W/work"
mkdir -p "$WORK/scripts" "$WORK/docs"
cp "$ROOT/scripts/publish.sh" "$WORK/scripts/"
cd "$WORK"
git init -q -b main
git config user.email t@example.com
git config user.name test

echo "== 1. git リポジトリでないときは何もせず成功する =="
NOGIT="$W/nogit"; mkdir -p "$NOGIT/scripts" "$NOGIT/docs"
cp "$ROOT/scripts/publish.sh" "$NOGIT/scripts/"
echo "<h1>a</h1>" > "$NOGIT/docs/index.html"
( cd "$NOGIT" && bash scripts/publish.sh > "$W/out1.txt" 2>&1 )
check "終了コード0" "$?" "0"
check "スキップと言う" "$(grep -c 'スキップ' "$W/out1.txt")" "1"

echo "== 2. origin 未設定なら何もせず成功する =="
echo "<h1>a</h1>" > docs/index.html
bash scripts/publish.sh > "$W/out2.txt" 2>&1
check "終了コード0" "$?" "0"
check "originが未設定と言う" "$(grep -c 'origin' "$W/out2.txt")" "1"

echo "== 3. docs/index.html が無ければ失敗する =="
git remote add origin "$W/remote.git"
mv docs/index.html "$W/saved.html"
bash scripts/publish.sh > "$W/out3.txt" 2>&1
check "終了コード1" "$?" "1"
mv "$W/saved.html" docs/index.html

echo "== 4. 正常に公開できる =="
bash scripts/publish.sh > "$W/out4.txt" 2>&1
check "終了コード0" "$?" "0"
check "公開したと言う" "$(grep -c '公開しました' "$W/out4.txt")" "1"
check "リモートに届いている" \
  "$(git --git-dir="$W/remote.git" show HEAD:docs/index.html 2>/dev/null)" "<h1>a</h1>"

echo "== 5. 内容が同じなら何もしない =="
bash scripts/publish.sh > "$W/out5.txt" 2>&1
check "終了コード0" "$?" "0"
check "変化なしと言う" "$(grep -c '変化がない' "$W/out5.txt")" "1"
check "コミットは増えていない" "$(git rev-list --count HEAD)" "1"

echo "== 6. 内容が変われば公開する =="
echo "<h1>b</h1>" > docs/index.html
bash scripts/publish.sh > "$W/out6.txt" 2>&1
check "終了コード0" "$?" "0"
check "コミットが増える" "$(git rev-list --count HEAD)" "2"
check "リモートも更新される" \
  "$(git --git-dir="$W/remote.git" show HEAD:docs/index.html 2>/dev/null)" "<h1>b</h1>"

echo "== 7. ログが書けなくても git は失敗しない =="
# ログ出力とコマンド実行を分離していないと、ここで git ごと失敗して
# 「変化なし」と誤判定し、成功を装ってしまう。
# 存在しないディレクトリ配下を指定して、ログの追記を必ず失敗させる。
echo "<h1>c</h1>" > docs/index.html
bash scripts/publish.sh "$W/no/such/dir/collect.log" > "$W/out7.txt" 2>&1
check "コミットは行われる" "$(git rev-list --count HEAD)" "3"

cd /
rm -rf "$W"
echo
echo "結果: $PASS pass / $FAIL fail"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: テストを走らせて失敗することを確認する**

```bash
cd ~/Projects/reels-trend-collector && bash tests/verify_publish.sh
```

期待: FAIL（`scripts/publish.sh` が無い）

- [ ] **Step 3: `publish.sh` を書く**

`threads-trend-collector/scripts/publish.sh` をそのまま持ってくる。変更は
コミットメッセージの文言だけ。

```bash
#!/usr/bin/env bash
# 生成済みの docs/index.html を GitHub Pages へ反映する。
# リモート未設定なら何もせず正常終了する（ローカル運用でも壊れないように）。
#
#   bash scripts/publish.sh [ログファイル]
#
# ログファイルを省略すると標準出力に出す。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG="${1:-}"

log() {
  local msg
  msg="$(date '+%Y-%m-%d %H:%M:%S') $*"
  if [ -n "$LOG" ]; then
    echo "$msg" >> "$LOG"
  else
    echo "$msg"
  fi
}

# git コマンドを実行し、出力をログに残す。
# 出力をログへ直接リダイレクトすると、ログが書けないときに
# git 自体が失敗して「変化なし」と誤判定されるため、こう分けている。
run() {
  local out status
  out="$("$@" 2>&1)"
  status=$?
  [ -n "$out" ] && log "$out"
  return $status
}

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  log "gitリポジトリではないため、公開はスキップしました。"
  exit 0
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  log "originが未設定のため、公開はスキップしました。"
  exit 0
fi

if [ ! -f docs/index.html ]; then
  log "docs/index.html がありません。先に build_html.py を実行してください。"
  exit 1
fi

if ! run git add docs/index.html; then
  log "git add に失敗しました。"
  exit 1
fi

if git diff --cached --quiet; then
  log "内容に変化がないため、公開はスキップしました。"
  exit 0
fi

if ! run git commit -m "収集結果を更新 $(date '+%Y-%m-%d %H:%M')"; then
  log "コミットに失敗しました。"
  exit 1
fi

if ! run git push origin HEAD; then
  log "pushに失敗しました。認証が切れている可能性があります: gh auth login"
  exit 1
fi

log "公開しました。"
exit 0
```

- [ ] **Step 4: テストを走らせて通ることを確認する**

```bash
cd ~/Projects/reels-trend-collector && bash tests/verify_publish.sh
```

期待: fail が 0

- [ ] **Step 5: `setup_github.sh` を書く**

`threads-trend-collector/scripts/setup_github.sh` を移植する。変更点:
リポジトリ名、説明文、危険ファイルの検出パターン（`posts.json` → `reels.json`）、
最後の案内。

```bash
#!/usr/bin/env bash
# GitHub Pages（無料・公開リポジトリ）で配信するための初期設定。最初に1回だけ実行する。
#
#   bash scripts/setup_github.sh [リポジトリ名]
#
# 既定のリポジトリ名は reels-trend-collector。
# 何度実行しても壊れないように作ってある（途中で失敗したら直して再実行してよい）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REPO_NAME="${1:-reels-trend-collector}"

echo "== 1. 前提の確認 =="
command -v gh >/dev/null || { echo "  gh コマンドがありません: brew install gh"; exit 1; }
command -v git >/dev/null || { echo "  git コマンドがありません"; exit 1; }

if ! gh auth status >/dev/null 2>&1; then
  echo "  GitHub の認証が切れています。先に次を実行してください:"
  echo "    gh auth login"
  exit 1
fi

if [ ! -f docs/index.html ]; then
  echo "  docs/index.html がありません。先に次を実行してください:"
  echo "    python3 scripts/build_html.py"
  exit 1
fi

OWNER="$(gh api user --jq .login)"
echo "  OK: gh 認証済み（$OWNER）"

echo "== 2. git リポジトリを用意 =="
if [ -d .git ]; then
  echo "  既にあります。そのまま使います。"
else
  git init -q -b main
  echo "  作成しました。"
fi

git add -A

echo "== 3. 公開してはいけないファイルが混ざっていないか確認 =="
# ここが最後の砦。.browser-profile には Instagram のログインCookieが入る。
DANGER="$(git status --porcelain | grep -iE "browser-profile|Cookies|Login Data|reels\.json|raw_latest|node_modules|\.env" || true)"
if [ -n "$DANGER" ]; then
  echo "  中止します。次のファイルは公開してはいけません:"
  echo "$DANGER"
  echo "  .gitignore を確認してください。"
  exit 1
fi
echo "  OK: ログインセッション・収集データは除外されています"

if git rev-parse HEAD >/dev/null 2>&1 && git diff --cached --quiet; then
  echo "  変更なし。コミットは省略します。"
else
  git commit -q -m "Instagram リール Research Tool"
  echo "  コミットしました。"
fi

echo "== 4. GitHub にリポジトリを用意 =="
if git remote get-url origin >/dev/null 2>&1; then
  echo "  origin は設定済み: $(git remote get-url origin)"
elif gh repo view "$OWNER/$REPO_NAME" >/dev/null 2>&1; then
  echo "  GitHub 側に既にあります。origin として紐づけます。"
  git remote add origin "https://github.com/$OWNER/$REPO_NAME.git"
else
  # GitHub Pages の無料枠は公開リポジトリのみ。
  gh repo create "$REPO_NAME" --public \
    --description "Instagram リール Research Tool（美容ジャンル ver）"
  git remote add origin "https://github.com/$OWNER/$REPO_NAME.git"
  echo "  作成しました。"
fi

echo "== 5. push =="
git push -u origin HEAD
echo "  完了。"

echo "== 6. GitHub Pages を有効化 =="
# ネストした JSON を送るため、-f ではなく --input で明示的に渡す。
PAGES_BODY='{"source":{"branch":"main","path":"/docs"}}'
if gh api "repos/$OWNER/$REPO_NAME/pages" >/dev/null 2>&1; then
  echo "$PAGES_BODY" | gh api -X PUT "repos/$OWNER/$REPO_NAME/pages" --input - >/dev/null \
    && echo "  設定を更新しました。" \
    || echo "  更新に失敗しました。リポジトリの Settings → Pages で /docs を指定してください。"
else
  echo "$PAGES_BODY" | gh api -X POST "repos/$OWNER/$REPO_NAME/pages" --input - >/dev/null \
    && echo "  有効にしました。" \
    || echo "  有効化に失敗しました。リポジトリの Settings → Pages で main / docs を指定してください。"
fi

URL="$(gh api "repos/$OWNER/$REPO_NAME/pages" --jq .html_url 2>/dev/null || true)"
[ -z "$URL" ] && URL="https://$OWNER.github.io/$REPO_NAME/"

echo
echo "==================================================="
echo "公開URL: $URL"
echo "==================================================="
echo "初回は反映まで数分かかります。"
echo "noindex を入れてあるので検索結果には出ませんが、"
echo "URL を知っていれば誰でも見られます。"
echo
echo "次: bash scripts/install_launchd.sh"
```

- [ ] **Step 6: `tests/run.sh` に章を足してコミットする**

`===== 8. 改行の作法 =====` の直後、`===== 公開の安全性 =====` の**前**に挿入する:

```bash
echo
echo "===== 9. 公開判定 ====="
bash "$ROOT/tests/verify_publish.sh"
```

そして安全性の章を `===== 10. 公開の安全性 =====` に繰り下げる。

```bash
cd ~/Projects/reels-trend-collector && bash tests/run.sh
git add scripts/publish.sh scripts/setup_github.sh tests/verify_publish.sh tests/run.sh
git commit -m "feat: GitHub Pages への公開"
```

---

## Task 12: 自動実行（1日4回・1回1ジャンル）

**Files:**
- Create: `scripts/run_collect.sh`, `scripts/install_launchd.sh`,
  `scripts/uninstall_launchd.sh`, `config/launchd/template.plist`

**Interfaces:**
- Consumes: `collect.py --genre`, `build_html.py`, `publish.sh`, `config/genres.json`
- Produces: `bash scripts/run_collect.sh <ジャンル名>` — launchd が呼ぶ

- [ ] **Step 1: `run_collect.sh` を書く**

```bash
#!/usr/bin/env bash
# 1ジャンルぶんの収集 → HTML生成 → GitHub Pages へ公開 まで一息で実行する。
# launchd から1日4回（ジャンルごとに1回）呼ばれる。手動で実行しても同じことが起きる。
#
#   bash scripts/run_collect.sh ネイル
#
# ジャンル名を省略すると全ジャンルを収集する（アクセス量が増えるので普段は使わない）。
set -uo pipefail

# 収集は10分前後かかる。途中でスリープに入ると中断されるため、
# 実行中だけ起きたままにする（終了すれば元の設定に戻る）。
if [ -z "${RTC_AWAKE:-}" ] && [ -x /usr/bin/caffeinate ]; then
  export RTC_AWAKE=1
  # bash 経由で呼ぶ。ファイルに実行権限が無くても動くようにするため。
  exec /usr/bin/caffeinate -i -s /bin/bash "${BASH_SOURCE[0]}" "$@"
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p logs

GENRE="${1:-}"
LOG="logs/collect.log"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

log "===== 開始 ${GENRE:-全ジャンル} ====="

COLLECT_ARGS=()
[ -n "$GENRE" ] && COLLECT_ARGS+=(--genre "$GENRE")

# -u を付けて出力のバッファリングを切る。付けないと数キロバイト溜まるまで
# ログに書き出されず、動いているのに止まって見える。
if ! /usr/bin/env python3 -u scripts/collect.py "${COLLECT_ARGS[@]}" >> "$LOG" 2>&1; then
  log "収集に失敗。ページは更新しません。"
  exit 1
fi

if ! /usr/bin/env python3 -u scripts/build_html.py >> "$LOG" 2>&1; then
  log "HTML生成に失敗。"
  exit 1
fi

# --- GitHub Pages へ公開 ---
if ! bash scripts/publish.sh "$LOG"; then
  log "公開に失敗しました。"
  exit 1
fi

log "===== 完了 ${GENRE:-全ジャンル} ====="
```

- [ ] **Step 2: plist のテンプレートを書く**

`config/launchd/template.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>__LABEL__</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>__ROOT__/scripts/run_collect.sh</string>
    <string>__GENRE__</string>
  </array>

  <key>WorkingDirectory</key>
  <string>__ROOT__</string>

  <!-- launchd の既定 PATH は /usr/bin:/bin:/usr/sbin:/sbin だけで、
       /usr/local/bin にある node や gh を見つけられない。 -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>__HOUR__</integer><key>Minute</key><integer>0</integer></dict>
  </array>

  <key>StandardOutPath</key>
  <string>__ROOT__/logs/launchd.log</string>
  <key>StandardErrorPath</key>
  <string>__ROOT__/logs/launchd.log</string>

  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
```

- [ ] **Step 3: `install_launchd.sh` を書く**

ジャンルごとに別々の plist を作る。1つの plist では時刻ごとに違う引数を渡せないため。
ジャンル名は `config/genres.json` から読むので、ジャンルを増やしたら再実行すればよい。

```bash
#!/usr/bin/env bash
# ジャンルごとに1日1回の自動収集を登録する。
# 1日の中に分散させて、Instagram への連続アクセスを避ける。
#
#   bash scripts/install_launchd.sh
#
# 解除は scripts/uninstall_launchd.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="com.kameda.reels-trend-collector"
AGENTS="$HOME/Library/LaunchAgents"
TEMPLATE="$ROOT/config/launchd/template.plist"

mkdir -p "$AGENTS"

# 既存の登録を一度すべて外す。ジャンルが減ったときに取り残しを作らないため。
bash "$ROOT/scripts/uninstall_launchd.sh" >/dev/null 2>&1 || true

# ジャンル名を config から読む。1行1ジャンル。
mapfile -t GENRES < <(python3 -c "
import json
for g in json.load(open('$ROOT/config/genres.json'))['genres']:
    print(g)
")

COUNT=${#GENRES[@]}
if [ "$COUNT" -eq 0 ]; then
  echo "config/genres.json にジャンルがありません。"
  exit 1
fi

echo "登録します（$COUNT ジャンル）:"
for i in "${!GENRES[@]}"; do
  GENRE="${GENRES[$i]}"
  # 7時から22時のあいだに均等に散らす
  if [ "$COUNT" -eq 1 ]; then
    HOUR=7
  else
    HOUR=$(( 7 + i * 15 / (COUNT - 1) ))
  fi
  # ラベルに日本語は使えないので連番にする
  LABEL="$PREFIX.$i"
  DEST="$AGENTS/$LABEL.plist"

  sed -e "s|__ROOT__|$ROOT|g" \
      -e "s|__LABEL__|$LABEL|g" \
      -e "s|__GENRE__|$GENRE|g" \
      -e "s|__HOUR__|$HOUR|g" \
      "$TEMPLATE" > "$DEST"

  launchctl unload "$DEST" 2>/dev/null || true
  launchctl load "$DEST"
  printf '  %2d:00  %s\n' "$HOUR" "$GENRE"
done

echo
echo "確認:       launchctl list | grep $PREFIX"
echo "今すぐ実行: launchctl start $PREFIX.0"
echo "ログ:       tail -f $ROOT/logs/collect.log"
echo
echo "Mac の電源が入っていれば、蓋を閉じていても次に起きたときに実行されます。"
echo "電源が切れていると実行されず、遡っても動きません。"
```

- [ ] **Step 4: `uninstall_launchd.sh` を書く**

```bash
#!/usr/bin/env bash
# 自動収集の登録をすべて解除する。
set -uo pipefail

PREFIX="com.kameda.reels-trend-collector"
AGENTS="$HOME/Library/LaunchAgents"

found=0
for f in "$AGENTS/$PREFIX".*.plist; do
  [ -e "$f" ] || continue
  launchctl unload "$f" 2>/dev/null || true
  rm -f "$f"
  echo "解除しました: $(basename "$f")"
  found=1
done

[ "$found" -eq 0 ] && echo "登録はありませんでした。"
exit 0
```

- [ ] **Step 5: plist が正しく生成されるか、登録せずに確認する**

`mapfile` は bash 4 以降。macOS 標準の bash は 3.2 なので、`/bin/bash` で動かないことがある。
まず確認する:

```bash
cd ~/Projects/reels-trend-collector
/bin/bash -c 'mapfile -t X < <(printf "a\nb\n"); echo "${#X[@]}"' 2>&1
```

`2` と出なければ `mapfile` が使えない。その場合は `install_launchd.sh` の該当箇所を
次に置き換える:

```bash
GENRES=()
while IFS= read -r line; do GENRES+=("$line"); done < <(python3 -c "
import json
for g in json.load(open('$ROOT/config/genres.json'))['genres']:
    print(g)
")
```

- [ ] **Step 6: 実際に登録して、生成された plist を目で確認する**

```bash
cd ~/Projects/reels-trend-collector
bash scripts/install_launchd.sh
```

期待の出力:

```
登録します（4 ジャンル）:
   7:00  ネイル
  12:00  顔まわり
  17:00  まつげ・眉・メイク
  22:00  髪・脱毛・痩身
```

```bash
cat ~/Library/LaunchAgents/com.kameda.reels-trend-collector.0.plist
launchctl list | grep reels-trend-collector
```

期待: `__ROOT__` などのプレースホルダが全部置き換わっている。4件が一覧に出る。

- [ ] **Step 7: 実際に1回走らせて、通しで動くことを確認する**

```bash
cd ~/Projects/reels-trend-collector
launchctl start com.kameda.reels-trend-collector.0
sleep 30
tail -30 logs/collect.log
```

**10分前後かかる。** ログに `===== 開始 ネイル =====` が出て、
最終的に `===== 完了 ネイル =====` まで進めば成功。

途中で止まっていたら `logs/launchd.log` も見る。`node が見つかりません` なら
plist の `PATH` に node の場所を足す（`which node` で確認）。

- [ ] **Step 8: 解除できることを確認して、登録し直す**

```bash
bash scripts/uninstall_launchd.sh
launchctl list | grep reels-trend-collector || echo "解除できています"
bash scripts/install_launchd.sh
```

- [ ] **Step 9: 全テストを走らせてコミットする**

```bash
cd ~/Projects/reels-trend-collector && bash tests/run.sh
git add scripts/run_collect.sh scripts/install_launchd.sh scripts/uninstall_launchd.sh \
  config/launchd/template.plist
git commit -m "feat: ジャンルごとに1日1回の自動収集"
```

---

## Task 13: README と初回の本番実行

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: これまでの全部
- Produces: 公開URL

- [ ] **Step 1: `README.md` を書く**

`threads-trend-collector/README.md` と同じ構成にする。**必ず書く内容:**

1. **何をするツールか** — 美容ジャンルで伸びているリールを集めて一覧にする。収集専用、
   LLM 不使用、API 課金ゼロ
2. **仕組み** — Instagram Graph API は他人の公開リールをジャンル横断で探せないため、
   Playwright でブラウザから開き、DOM ではなく JSON レスポンスを傍受している
3. **伸び率の定義** — 再生数 ÷ フォロワー数。フォロワー500人未満は500人として計算
4. **準備（初回のみ）** — `npm install --prefix . playwright` → `python3 scripts/collect.py --login`
   （**収集専用のサブアカウントを使う。本家アカウントは使わない**）
5. **使い方** — 試運転 / 本番収集 / HTML生成 / よく使うオプションの表
6. **公開して自動更新する** — `gh auth login` → `setup_github.sh` → `install_launchd.sh`
7. **Mac の電源について** — スリープ中は次に起きたときに実行される。電源オフでは実行されない。
   ログイン前（ログイン画面）でも実行されない。`sudo pmset repeat wakeorpoweron MTWRFSU 06:55:00`
8. **アカウントリスクの明記** — 頻度を抑えてもゼロにできない。制限がかかったら
   `.browser-profile/` を捨てて別アカウントで `--login` し直す。蓄積データは無傷
9. **サムネイルを出さない理由** — Instagram の画像URLは署名付きで数時間〜数日で失効する
10. **ジャンルの増やし方** — `config/genres.json` に1ブロック足して
    `bash scripts/install_launchd.sh` を再実行する
11. **テスト** — `bash tests/run.sh`。ブラウザも通信も使わない
12. **困ったとき** — 0件のとき / ログイン切れ / node が見つからない

コマンドは1行ずつコピーできる形で書く。zsh は対話シェルで `#` をコメント扱いしないので、
`#` で始まる説明文をコマンドと同じブロックに混ぜない。

- [ ] **Step 2: 全ジャンルを1回ずつ収集する（本番の初回）**

**1ジャンルずつ、間を空けて実行する。** まとめて回すとアクセスが集中する。

```bash
cd ~/Projects/reels-trend-collector
python3 scripts/collect.py --genre ネイル
```

10分ほど待ってから次:

```bash
python3 scripts/collect.py --genre 顔まわり
```

```bash
python3 scripts/collect.py --genre まつげ・眉・メイク
```

```bash
python3 scripts/collect.py --genre 髪・脱毛・痩身
```

各回で確認すること:
- `新規: NN 件` の NN が 0 でない
- `関連度フィルタで除外: NN 件` が全体の半分を超えていない（超えていたら `required_any` が厳しい）
- `フォロワー数: 新規 NN 件`

**途中でログイン画面に飛ばされたら中止する。** アカウントに制限がかかった可能性がある。
数日空けてから再開する。

- [ ] **Step 3: HTML を生成して目視する**

```bash
python3 scripts/build_html.py
open docs/index.html
```

**目で見て確認すること:**
- 4ジャンルすべてにカードがある
- 伸び率順の上位が「フォロワーが少ないのに再生が多いリール」になっている
- 上位カードのリンクを3つ開いて、**実在するリールで、再生数が画面の数字と近い**
- ウィンドウ幅を狭めても自前の文言が単語の途中で割れない

- [ ] **Step 4: 上位のリールを手で検算する**

```bash
python3 -c "
import json, sys
sys.path.insert(0, 'scripts')
from build_html import build_rows
rows = build_rows(json.load(open('data/reels.json')))
for r in rows[:5]:
    print(f\"×{r['ratio']}  @{r['username']}  再生 {r['plays']:,}  フォロワー {r['followers']:,}\")
"
```

上位1件について、ブラウザで実際のアカウントを開き、**フォロワー数が一致するか**確認する。
一致しなければ Task 4 の抽出が別の数値を拾っている。

- [ ] **Step 5: 公開する**

```bash
gh auth login
```

```bash
bash scripts/setup_github.sh
```

表示された URL を開いて、ページが見えることを確認する（初回は数分かかる）。

- [ ] **Step 6: 自動実行を登録する**

```bash
bash scripts/install_launchd.sh
```

```bash
sudo pmset repeat wakeorpoweron MTWRFSU 06:55:00
```

- [ ] **Step 7: 全テストを走らせてコミットする**

```bash
cd ~/Projects/reels-trend-collector && bash tests/run.sh
git add README.md
git commit -m "docs: READMEを追加"
git push origin HEAD
```

- [ ] **Step 8: 翌日、自動実行が動いたか確認する**

```bash
tail -50 ~/Projects/reels-trend-collector/logs/collect.log
```

4ジャンルぶんの `===== 開始 =====` と `===== 完了 =====` が並んでいれば成功。

---

## 完了の条件

- [ ] `bash tests/run.sh` が全項目 pass する
- [ ] 公開URLを開くと、4ジャンルのタブと3種の並び替えが動く
- [ ] 伸び率の上位10件のうち、少なくとも8件がリンク先で実在するリール
- [ ] 上位1件のフォロワー数がInstagramの画面と一致する
- [ ] `git status` に `.browser-profile/` も `data/` も出てこない
- [ ] 翌日、launchd による自動更新がログに残っている
