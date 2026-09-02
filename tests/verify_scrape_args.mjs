/**
 * scrape.mjs の引数解析とジャンル読み込みを検証する。
 *
 * scrape.mjs 本体は Instagram に繋がないと動かせないが、この部分は純関数なので
 * ここだけは確かめられる。実データが取れるかとは別の話。
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { parseArgs, loadTagPairs, loadSkipAccounts } from "../scripts/scrape_args.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = path.join(ROOT, "config", "genres.json");

let pass = 0, fail = 0;
function check(label, cond, actual) {
  if (cond) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}  → 実際: ${JSON.stringify(actual)}`); }
}

console.log("--- 1. 既定値 ---");
{
  const a = parseArgs([]);
  check("待機は10秒", a.delay === 10, a.delay);
  check("プロフィール取得の上限は15件", a.maxProfiles === 15, a.maxProfiles);
  check("最低件数は5", a.minReels === 5, a.minReels);
  check("limit は0（無制限）", a.limit === 0, a.limit);
  check("既定ではブラウザを表示しない", a.headful === false, a.headful);
  check("既定ではログインモードでない", a.login === false, a.login);
}

console.log("--- 2. 引数の読み取り ---");
{
  const a = parseArgs(["--genres", "c.json", "--out", "o.json", "--genre", "ネイル",
                       "--delay", "7", "--limit", "3", "--max-profiles", "2",
                       "--min-reels", "9", "--skip-accounts", "s.json",
                       "--dump-dir", "d", "--headful"]);
  check("genres", a.genres === "c.json", a.genres);
  check("out", a.out === "o.json", a.out);
  check("genre", a.genre === "ネイル", a.genre);
  check("delay は数値になる", a.delay === 7, a.delay);
  check("limit は数値になる", a.limit === 3, a.limit);
  check("max-profiles は数値になる", a.maxProfiles === 2, a.maxProfiles);
  check("min-reels は数値になる", a.minReels === 9, a.minReels);
  check("skip-accounts", a.skipAccounts === "s.json", a.skipAccounts);
  check("dump-dir", a.dumpDir === "d", a.dumpDir);
  check("headful", a.headful === true, a.headful);
  check("--login を付けなければ false", a.login === false, a.login);
}

console.log("--- 3. 実際の設定ファイルを読む ---");
{
  const pairs = loadTagPairs(CONFIG);
  check("40組を作る", pairs.length === 40, pairs.length);
  const genres = [...new Set(pairs.map((p) => p.genre))];
  check("10ジャンル", genres.length === 10, genres);
  check("設定ファイルの順序を保つ",
        JSON.stringify(genres) ===
          JSON.stringify(Object.keys(JSON.parse(fs.readFileSync(CONFIG, "utf8")).genres)),
        genres);
  check("組はジャンルとハッシュタグを持つ",
        pairs.every((p) => typeof p.genre === "string" && typeof p.hashtag === "string"
                           && p.genre && p.hashtag), pairs[0]);
  check("ハッシュタグに # を含めない",
        pairs.every((p) => !p.hashtag.includes("#")),
        pairs.filter((p) => p.hashtag.includes("#")));
}

console.log("--- 4. ジャンルを絞る ---");
{
  const nail = loadTagPairs(CONFIG, "脱毛");
  check("脱毛だけ4組", nail.length === 4, nail.length);
  check("全部脱毛", nail.every((p) => p.genre === "脱毛"), nail.map((p) => p.genre));
  let threw = null;
  try { loadTagPairs(CONFIG, "存在しないジャンル"); } catch (e) { threw = e.message; }
  check("存在しないジャンルは例外にする（黙って0件にしない）",
        threw !== null && threw.includes("存在しないジャンル"), threw);
}

console.log("--- 5. 取り直し不要のアカウント一覧 ---");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scrape-args-"));
  const f = path.join(tmp, "fresh.json");

  check("ファイルが無ければ空", loadSkipAccounts(f).size === 0, null);
  check("パスが空でも落ちない", loadSkipAccounts("").size === 0, null);
  check("undefined でも落ちない", loadSkipAccounts(undefined).size === 0, null);

  fs.writeFileSync(f, JSON.stringify(["Alice", "bob"]), "utf8");
  const s = loadSkipAccounts(f);
  check("2件読める", s.size === 2, s.size);
  check("小文字に揃える", s.has("alice") && s.has("bob"), [...s]);

  fs.writeFileSync(f, "これはJSONではない", "utf8");
  check("壊れていたら空として扱う（取り直すだけで害はない）",
        loadSkipAccounts(f).size === 0, null);

  fs.writeFileSync(f, JSON.stringify({ not: "an array" }), "utf8");
  check("配列でなければ空", loadSkipAccounts(f).size === 0, null);

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n結果: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
