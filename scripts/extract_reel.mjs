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

// 再生数の候補キー。**まだ実データで確認していない。**
// Task 1（検証スパイク）が instagram.com へ通信できず未実行のため、この順序は推測。
// 実データで1件も取れないときは、まずここを疑う。どのキーにも入っていなければ
// 設計書 第11章のとおり案C（アカウント巡回型）へ切り替える判断が要る。
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

// Instagram の投稿ID（pk）は、上位ビットにミリ秒時刻を持つ。
// 2011-08-24 ごろを起点とする独自エポック。
const IG_EPOCH_MS = 1314220021721;

/**
 * 投稿ID から投稿時刻を復元する。取れなければ null。
 *
 * リール一覧の画面には taken_at が入っていないが pk はある。
 * 実データ12件で taken_at と突き合わせ、すべて誤差17分以内だった
 * （多くは誤差0秒）。分単位の精度は無いが、日付の精度は十分あるので
 * 「何日前か」の表示と期間フィルタには使える。
 */
export function timestampFromId(id) {
  if (typeof id !== "string" && typeof id !== "number") return null;
  const s = String(id);
  if (!/^\d+$/.test(s)) return null;          // 'POLARIS_123' のような形は対象外
  let pk;
  try {
    pk = BigInt(s);
  } catch {
    return null;
  }
  if (pk <= 0n) return null;

  const ms = (pk >> 23n) + BigInt(IG_EPOCH_MS);
  const seconds = Number(ms / 1000n);

  // 桁数が違うIDを渡された場合に、ありえない日付を作らないための関門。
  // Instagram の開始（2010年）より前、または1日以上先の未来は捨てる。
  const nowSec = Date.now() / 1000;
  if (seconds < 1262304000 || seconds > nowSec + 86400) return null;  // 2010-01-01
  return seconds;
}

function getTimestamp(o) {
  // taken_at は UNIX 秒。ミリ秒やマイクロ秒で来る実装もあるので桁で判別する。
  for (const k of ["taken_at", "taken_at_timestamp", "device_timestamp", "publish_date"]) {
    const v = o[k];
    if (typeof v === "number" && v > 0) {
      let seconds = v;
      if (v > 1e14) seconds = Math.floor(v / 1e6);        // マイクロ秒
      else if (v > 1e11) seconds = Math.floor(v / 1e3);   // ミリ秒
      // 未来の日付は取り違えの証拠。取れなかったことにする。
      // 混ぜると新着順の先頭に居座り、期間フィルタでも落ちなくなる。
      if (seconds > Date.now() / 1000 + 86400) continue;
      return new Date(seconds * 1000).toISOString().replace(".000Z", "+0000");
    }
  }
  if (typeof o.timestamp === "string" && o.timestamp) return o.timestamp;

  // taken_at がどこにも無い画面がある（リール一覧がそれ）。
  // 最後の手段として投稿IDから復元する。取れた値ではないので、
  // 呼び出し側で「復元したもの」と分かるように印を付ける。
  for (const k of ["pk", "id", "pk_id"]) {
    const seconds = timestampFromId(o[k]);
    if (seconds !== null) {
      return new Date(seconds * 1000).toISOString().replace(".000Z", "+0000");
    }
  }
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
  const timestamp = getTimestamp(o);
  // taken_at 系のキーが1つも無ければ、上の getTimestamp は ID から復元している。
  // 復元値は分単位の誤差があるので、そうと分かるようにしておく。
  const hasRealTime =
    ["taken_at", "taken_at_timestamp", "device_timestamp", "publish_date"]
      .some((k) => typeof o[k] === "number" && o[k] > 0)
    || (typeof o.timestamp === "string" && o.timestamp !== "");
  return {
    id: getId(o),
    code,
    username: getUsername(o),
    caption: getCaption(o),
    timestamp,
    timestamp_estimated: timestamp !== null && !hasRealTime,
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

  // Instagram は最初の1ページぶんを HTML の中の
  // <script type="application/json"> に埋め込んで返す。
  // 行の先頭が '<' なので上のループでは拾えない。ここで取り出す。
  // 実データで確認済み: この経路を通さないとリールが1件も取れない。
  for (const m of trimmed.matchAll(
    /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    const s = m[1].trim();
    if (!s || (s[0] !== "{" && s[0] !== "[")) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // 壊れたブロックは捨てる
    }
  }

  return out;
}

/**
 * ハッシュタグページのレスポンスから、投稿者のアカウント名を集める。
 *
 * 2026-09-02 に Instagram が再生数を JSON に載せるのをやめ、
 * looksLikeReel（再生数が要る）が1件も通らなくなった。
 * ただしアカウント名と投稿コードは今も返っている。そこでここでは
 * 「誰の投稿か」だけを拾い、再生数はプロフィールのリールタブから取る。
 */
export function findAccounts(root, { maxDepth = 40 } = {}) {
  const found = new Set();
  const seen = new WeakSet();

  const walk = (node, depth) => {
    if (depth > maxDepth || node === null || typeof node !== "object") return;
    if (seen.has(node)) return;   // 循環参照よけ
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }

    // 投稿らしいオブジェクト（コードを持つ）に紐づく投稿者だけを拾う。
    // 単に username を全部集めると、おすすめ欄や検索履歴まで混ざる。
    if (getCode(node) !== null) {
      const u = getUsername(node);
      if (u) found.add(u);
    }

    for (const key of Object.keys(node)) walk(node[key], depth + 1);
  };

  walk(root, 0);
  return [...found];
}

/** レスポンス本文からアカウント名を集めるところまでを一息でやる。 */
export function extractAccountsFromBody(body) {
  const names = new Set();
  for (const payload of parsePayloads(body)) {
    for (const u of findAccounts(payload)) names.add(u);
  }
  return [...names];
}

/** レスポンス本文からリールを抜き出すところまでを一息でやる。 */
export function extractFromBody(body) {
  const reels = [];
  for (const payload of parsePayloads(body)) reels.push(...findReels(payload));

  const unique = new Map();
  for (const r of reels) if (!unique.has(r.id)) unique.set(r.id, r);
  return [...unique.values()];
}
