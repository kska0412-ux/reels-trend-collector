/**
 * scrape.mjs の引数解析とジャンル読み込み。
 *
 * ブラウザも通信も知らない純関数なので、ここに切り出してテストできるようにする。
 * scrape.mjs 本体は Instagram に繋がないと動かせないが、この部分だけは
 * フィクスチャで検証できる。
 */
import fs from "fs";

export function parseArgs(argv) {
  const args = { delay: 10, limit: 0, headful: false, login: false, minReels: 5,
                 maxProfiles: 10 };
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
    else if (a === "--max-profiles") args.maxProfiles = Number(argv[++i]);
    else if (a === "--skip-accounts") args.skipAccounts = argv[++i];
  }
  return args;
}

/** config/genres.json から {genre, hashtag} の組を作る。 */
export function loadTagPairs(file, onlyGenre) {
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

/** 既にフォロワー数が新しいアカウントの一覧を読む。無ければ空。 */
export function loadSkipAccounts(file) {
  if (!file || !fs.existsSync(file)) return new Set();
  try {
    const list = JSON.parse(fs.readFileSync(file, "utf8"));
    return new Set(Array.isArray(list) ? list.map((u) => String(u).toLowerCase()) : []);
  } catch {
    return new Set();   // 壊れていたら「誰も既知でない」として扱う。取り直すだけで害はない
  }
}
