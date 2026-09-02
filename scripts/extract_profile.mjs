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
