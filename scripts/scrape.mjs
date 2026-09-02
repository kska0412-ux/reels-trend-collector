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
 *   --genre 育毛     このジャンルのハッシュタグだけ巡回する
 *   --headful        ブラウザを表示して動きを見る
 *   --delay 10       ハッシュタグ間の待機秒数（既定10秒）
 *   --dump-dir DIR   生レスポンスを保存する（抽出が空だったときの原因調査用）
 *   --limit N        先頭N個のハッシュタグだけ処理する（試運転用）
 *   --max-profiles N フォロワー数を取りに行くアカウント数の上限（既定10）
 *   --skip-accounts F 既にフォロワー数が新しいアカウントの一覧（collect.py が渡す）
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { extractFromBody } from "./extract_reel.mjs";
import { extractFollowerCount } from "./extract_profile.mjs";
import { collectWithRetry, isFatal } from "./retry.mjs";
import { parseArgs, loadTagPairs, loadSkipAccounts } from "./scrape_args.mjs";
import { loadSessionCookies, describeSession } from "./session.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PROFILE_DIR = path.join(ROOT, ".browser-profile");

// 普段使いのブラウザから受け取ったセッション。ログイン画面を通らずに済ませるため。
// data/ は .gitignore 済みなので、ここに置けば公開リポジトリには出ない。
const SESSION_FILE = process.env.IG_SESSION_FILE
  || path.join(ROOT, "data", "ig_session.json");

// ハッシュタグページのURL。Instagram側の仕様が変わったらここを直す。
//
// /popular/<タグ>/ を使う理由（実データで確認済み）:
// /explore/tags/<タグ>/ は2種類の画面を返す。リールが多いタグだけ
// /popular/<タグ>/ へ転送され、そこには再生数がある。転送されないタグは
// 検索結果の画面になり、再生数が null で伸び率を出せない。
// 最初から /popular/ を開けば、転送を待たずにリール一覧を狙える。
const TAG_URL = (tag) =>
  `https://www.instagram.com/popular/${encodeURIComponent(tag)}/`;

// プロフィールページのURL。フォロワー数を取るために開く。
const PROFILE_URL = (username) =>
  `https://www.instagram.com/${encodeURIComponent(username)}/`;

// インストール済みの Google Chrome を使う。実ブラウザの方が表示が安定する。
const CHROME_CANDIDATES = [
  process.env.IG_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (p && fs.existsSync(p)) return p;
  return null;   // Playwright 同梱の Chromium にまかせる
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

  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, options);
  } catch (e) {
    const msg = e.message.split("\n")[0];
    throw new Error(
      `ブラウザを起動できませんでした: ${msg}\n` +
      `  Chrome を閉じてから再実行してください。それでも駄目なら\n` +
      `  IG_CHROME_PATH に Chrome の実行ファイルを指定してください。`
    );
  }

  // 普段使いのブラウザから受け取ったセッションがあれば注入する。
  // これがあるとログイン画面に一度も触れずに済む。
  const cookies = loadSessionCookies(SESSION_FILE);
  if (cookies) {
    await context.addCookies(cookies);
    console.log(describeSession(cookies));
  }
  return context;
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

  // チャレンジとログアウトは原因も対処も違う。同じ文言でまとめると誤診する。
  // isFatal は「ログインしていません」を含むかで判定するので、その語は必ず残す。
  if (url.includes("/challenge")) {
    throw new Error(
      "ログインしていません（本人確認を求められています）。\n" +
      `  飛ばされた先: ${url}\n` +
      "  Instagram がこの端末からのアクセスを自動操作とみなしています。\n" +
      "  対処: 普段使いのブラウザで instagram.com を開き、本人確認を済ませてください。\n" +
      "        そのうえで数時間から1日ほど間を空けてから再実行してください。\n" +
      "        続けて叩くと判定が強まります。"
    );
  }

  if (url.includes("/accounts/login")) {
    throw new Error(
      "ログインしていません（セッションが切れています）。\n" +
      `  飛ばされた先: ${url}\n` +
      "  対処: 普段使いのブラウザで instagram.com を開き、開発者ツール →\n" +
      "        Application → Cookies → https://www.instagram.com から\n" +
      "        sessionid の値をコピーして data/ig_session.json に保存してください:\n" +
      '          {"sessionid": "コピーした値"}\n' +
      "        これならログイン画面を通らずに済みます。"
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

async function runCollect(args) {
  if (!args.genres || !args.out) {
    throw new Error("--genres と --out は必須です。");
  }

  let pairs = loadTagPairs(args.genres, args.genre);
  if (args.limit > 0) pairs = pairs.slice(0, args.limit);

  const context = await openContext({ headful: args.headful });
  const page = context.pages()[0] || (await context.newPage());
  const results = [];
  const accounts = {};   // username -> フォロワー数 | null

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
  } finally {
    await context.close();
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(
    args.out,
    JSON.stringify({ collected_at: new Date().toISOString(), results, accounts },
                   null, 2),
    "utf8"
  );

  const total = results.reduce((n, r) => n + r.reels.length, 0);
  const failed = results.filter((r) => r.error).length;
  const gotFollowers = Object.values(accounts).filter((v) => v !== null).length;
  console.log(`\n合計 ${total} 件を ${args.out} に書き出しました` +
              `（失敗 ${failed}/${results.length} タグ / ` +
              `フォロワー数 ${gotFollowers}/${Object.keys(accounts).length} 件）`);
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
