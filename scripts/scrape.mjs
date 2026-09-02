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
import { extractFromBody, extractAccountsFromBody } from "./extract_reel.mjs";
import { extractFollowerCount } from "./extract_profile.mjs";
import { collectWithRetry, isFatal } from "./retry.mjs";
import { parseArgs, loadTagPairs, loadSkipAccounts } from "./scrape_args.mjs";
import { REELS_TAB_SCRIPT, buildReels, followerCountOf } from "./extract_reel_dom.mjs";
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

// プロフィールのリールタブのURL。
// 2026-09-02 に Instagram が再生数を JSON に載せるのをやめた。
// ハッシュタグページもリール個別ページも "view_count": null になり、
// "play_count" というキー自体が消えた（ログインの有無を問わず）。
// このタブだけは再生数がサムネイル上に描かれているので、そこから読む。
// フォロワー数も同じページに出るので、1回のアクセスで両方取れる。
const REELS_TAB_URL = (username) =>
  `https://www.instagram.com/${encodeURIComponent(username)}/reels/`;

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

/**
 * ハッシュタグ1つぶんの「候補アカウント」を集める。
 *
 * 再生数が JSON から消えたため、ここではリール本体を作らない。
 * 誰が投稿しているかだけを拾い、再生数はその人のリールタブから取る。
 * 再生数が JSON に戻ってきたときのために、リールの抽出も併せて試す。
 */
async function collectHashtag(page, tag, { dumpDir }) {
  const found = await harvest(page, TAG_URL(tag), {
    dumpDir,
    dumpLabel: `tag_${tag}`,
    extract: (body) => {
      const items = [];
      // 再生数つきで取れたものはそのまま使う（Instagram 側が戻した場合）
      for (const reel of extractFromBody(body)) {
        items.push({ kind: "reel", key: `reel:${reel.id}`, reel });
      }
      for (const username of extractAccountsFromBody(body)) {
        items.push({ kind: "account", key: `acct:${username}`, username });
      }
      return items;
    },
    keyOf: (item) => item.key,
  });

  return {
    reels: found.filter((x) => x.kind === "reel").map((x) => x.reel),
    accounts: found.filter((x) => x.kind === "account").map((x) => x.username),
  };
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

/**
 * 1アカウントのリールタブを開いて、リールとフォロワー数を取る。
 *
 * JSON の傍受ではなく、描かれた数字を読む。再生数が JSON から消えたため。
 * 返り値は { reels, followers }。取れなければ空配列と null。
 */
async function collectReelsTab(page, username, { dumpDir, scrolls = 2 }) {
  await page.goto(REELS_TAB_URL(username), {
    waitUntil: "domcontentloaded", timeout: 90000,
  });
  assertLoggedIn(page);

  // リールが1枚でも描かれるまで待つ。固定待機だと読み込み前に先へ進む。
  await waitUntil(
    async () => (await page.$$('a[href*="/reel/"]')).length > 0, 30000);

  let raw = await page.evaluate(REELS_TAB_SCRIPT);
  // 増えなくなるまでスクロールして追加ぶんを読む
  for (let i = 0; i < scrolls; i++) {
    const before = raw.rows.length;
    await page.mouse.wheel(0, 2500);
    await sleep(2000);
    raw = await page.evaluate(REELS_TAB_SCRIPT);
    if (raw.rows.length === before) break;
  }

  if (dumpDir) {
    fs.mkdirSync(dumpDir, { recursive: true });
    const safe = username.replace(/[^\p{L}\p{N}]+/gu, "_");
    fs.writeFileSync(path.join(dumpDir, `reelstab_${safe}.json`),
                     JSON.stringify(raw, null, 2), "utf8");
  }

  return { reels: buildReels(raw, username), followers: followerCountOf(raw) };
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
        // collectWithRetry は配列を数えてやり直しを決める。
        // ここで数えたいのは「候補アカウントが何人見つかったか」なので、
        // アカウントの配列を返し、リールは添えて持ち回る。
        async () => {
          const { reels, accounts } = await collectHashtag(page, hashtag,
                                                           { dumpDir: args.dumpDir });
          const list = accounts.slice();
          list.reels = reels;
          return list;
        },
        {
          minReels: args.minReels,
          onRetry: (reason) => console.log(`${label}: ${reason} / やり直します`),
        }
      );

      if (outcome.error) {
        console.log(`${label}: 失敗 — ${outcome.error}`);
        results.push({ genre, hashtag, reels: [], accounts: [], error: outcome.error });
      } else {
        const accounts = outcome.reels;   // collectWithRetry の返り値の名前は reels 固定
        const reels = accounts.reels || [];
        console.log(`${label}: アカウント ${accounts.length} 件` +
                    (reels.length ? ` / 再生数つきのリール ${reels.length} 件` : ""));
        results.push({ genre, hashtag, reels, accounts: [...accounts], error: null });
      }

      if (isFatal(outcome.lastError)) break;

      // 連続アクセスを避けるため、ハッシュタグごとに間を空ける
      if (i < pairs.length - 1) {
        const jitter = args.delay * (0.8 + Math.random() * 0.4);
        await sleep(jitter * 1000);
      }
    }

    // --- フェーズ2: リールタブからの取得 ---
    // ハッシュタグページで見つけたアカウントのリールタブを開き、
    // 再生数・いいね・コメント・フォロワー数をまとめて取る。
    // ハッシュタグページ側は再生数を返さなくなったので、リールの本体はここで集まる。
    const skip = loadSkipAccounts(args.skipAccounts);
    const seen = [];
    // どのジャンルで見つけたアカウントかを覚えておく。
    // リールタブから取ったリールに、そのジャンルを引き継ぐため。
    const genreOf = new Map();
    for (const r of results) {
      // ハッシュタグページで見つけた投稿者と、（もし取れていれば）リールの投稿者
      const names = [...(r.accounts || []), ...r.reels.map((x) => x.username)];
      for (const u of names) {
        if (!u) continue;
        if (!genreOf.has(u)) genreOf.set(u, []);
        if (!genreOf.get(u).includes(r.genre)) genreOf.get(u).push(r.genre);
        if (skip.has(u.toLowerCase()) || seen.includes(u)) continue;
        seen.push(u);
      }
    }
    const targets = seen.slice(0, args.maxProfiles);
    if (seen.length > targets.length) {
      // 黙って捨てない。何を今回取らなかったかを必ず出す。
      console.log(`\n候補アカウント ${seen.length} 件のうち ` +
                  `${targets.length} 件のリールタブを開きます（--max-profiles ${args.maxProfiles}）。` +
                  `残りは次回に回ります。`);
    } else if (targets.length) {
      console.log(`\n${targets.length} 件のリールタブを開きます。`);
    }

    for (let i = 0; i < targets.length; i++) {
      const username = targets[i];
      const label = `[${i + 1}/${targets.length}] @${username}`;
      try {
        const { reels, followers } = await collectReelsTab(page, username,
                                                           { dumpDir: args.dumpDir });
        accounts[username] = followers;
        // どのジャンルからこのアカウントに辿り着いたかを引き継ぐ。
        // 引き継がないとジャンル無しのリールになり、絞り込みから漏れる。
        const genres = genreOf.get(username) || [];
        for (const g of genres) {
          const slot = results.find((r) => r.genre === g && r.hashtag === `@${username}`);
          if (slot) slot.reels.push(...reels);
          else results.push({ genre: g, hashtag: `@${username}`, reels: [...reels], error: null });
        }
        console.log(`${label}: リール ${reels.length} 件 / ` +
                    `フォロワー ${followers === null ? "取得できず" : followers.toLocaleString()}`);
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
