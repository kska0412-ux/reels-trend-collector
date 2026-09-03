/**
 * プロフィールのリールタブの DOM からリールを抜き出す。
 *
 * 2026-09-02 に Instagram が再生数を JSON に載せるのをやめた。
 * ハッシュタグページもリール個別ページも "view_count": null で返り、
 * "play_count" というキー自体が消えた（ログインの有無を問わず）。
 * 一方で、プロフィールのリールタブでは再生数がサムネイル上に描画されている。
 * そこで JSON の傍受ではなく、描かれた数字を読む。
 *
 * 数字の見分け方（実データで確認）:
 *   1つのリールのリンクの中には、数字だけを持つ要素が最大3つある。
 *     - 画面に出ている数字   … 再生数（サムネイル上のオーバーレイ）
 *     - 出ていない数字の1つ目 … いいね数（カーソルを乗せたときに出る）
 *     - 出ていない数字の2つ目 … コメント数（同上）
 *   出ていない2つはアカウントによって無いことがある。再生数は必ずある。
 *
 * 「出ている / 出ていない」は要素の大きさで判断する。Instagram は
 * カーソル用の数字を 0x0 のまま置いており、クラス名は難読化されていて
 * 当てにできないため。
 */

/** 「4.2万」「1,022」「3.1K」などを数値にする。読めなければ null。 */
export function parseCount(text) {
  if (typeof text !== "string") return null;
  const m = text.trim().match(/^([\d.,]+)\s*(万|億|K|M|B)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = m[2] || "";
  const mult =
    unit === "万" ? 1e4 :
    unit === "億" ? 1e8 :
    /^k$/i.test(unit) ? 1e3 :
    /^m$/i.test(unit) ? 1e6 :
    /^b$/i.test(unit) ? 1e9 : 1;
  return Math.round(n * mult);
}

/** 数字だけの文字列か。要素の中身がこれなら件数の類とみなす。 */
export function looksLikeCount(text) {
  return parseCount(text) !== null;
}

/** リンクの href からリールのコードを取り出す。無ければ null。 */
export function codeFromHref(href) {
  if (typeof href !== "string") return null;
  const m = href.match(/\/reel[s]?\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/**
 * 1リールぶんの数字の並びから、再生数・いいね・コメントを決める。
 *
 * shown / hidden は、画面に出ている数字と出ていない数字の文字列の配列。
 * どちらの順序も DOM に並んでいる順のまま渡す。
 */
export function pickCounts(shown, hidden) {
  const s = (shown || []).map(parseCount).filter((v) => v !== null);
  const h = (hidden || []).map(parseCount).filter((v) => v !== null);
  return {
    play_count: s.length ? s[0] : null,
    like_count: h.length > 0 ? h[0] : null,
    comment_count: h.length > 1 ? h[1] : null,
  };
}

/**
 * ページ内で実行する関数のソース。Playwright の page.evaluate に渡す。
 *
 * evaluate の中はブラウザ側で動くので、このファイルの他の関数は見えない。
 * 必要な処理は中に閉じて書く。返す形はここのテストと揃えてある。
 *
 * 渡すときは必ず REELS_TAB_CALL を使うこと。page.evaluate に文字列を渡すと
 * 「式」として評価されるので、関数のソースをそのまま渡すと関数オブジェクトが
 * 返る。関数はシリアライズできないので結果は undefined になり、
 * 「Cannot read properties of undefined」で落ちる（実際に踏んだ）。
 */
export const REELS_TAB_SCRIPT = `() => {
  const parseText = (el) => (el.textContent || "").trim();
  const isCount = (el) =>
    el.children.length === 0 && /^[\\d.,]+\\s*(万|億|K|M|B)?$/i.test(parseText(el));

  const rows = [];
  for (const a of document.querySelectorAll('a[href*="/reel/"]')) {
    const href = a.getAttribute("href") || "";
    const m = href.match(/\\/reel[s]?\\/([A-Za-z0-9_-]+)/);
    if (!m) continue;
    const shown = [];
    const hidden = [];
    for (const el of a.querySelectorAll("*")) {
      if (!isCount(el)) continue;
      const r = el.getBoundingClientRect();
      (r.width > 0 && r.height > 0 ? shown : hidden).push(parseText(el));
    }
    rows.push({ code: m[1], shown, hidden });
  }

  // フォロワー数は同じページの本文に出ている。別ページを開かずに済ませる。
  const body = document.body ? document.body.innerText || "" : "";
  const fm = body.match(/フォロワー\\s*([\\d.,]+\\s*(?:万|億)?)\\s*人/)
          || body.match(/([\\d.,]+\\s*[KMB]?)\\s+followers/i);
  return { rows, followerText: fm ? fm[1] : null };
}`;

/**
 * page.evaluate にそのまま渡せる式。呼び出しまで含んでいる。
 * これを使わないと関数オブジェクトが返って undefined になる。
 */
export const REELS_TAB_CALL = `(${REELS_TAB_SCRIPT})()`;

/**
 * page.evaluate の戻り値を、保存する形のリールの配列にする。
 * username は呼び出し側が知っているので引数で受ける。
 */
export function buildReels(raw, username) {
  if (!raw || !Array.isArray(raw.rows)) return [];
  const out = [];
  const seen = new Set();
  for (const row of raw.rows) {
    const code = typeof row.code === "string" ? row.code : null;
    if (!code || seen.has(code)) continue;
    const counts = pickCounts(row.shown, row.hidden);
    // 再生数が読めないものは入れない。伸び率が出せず、順位も付けられない。
    if (counts.play_count === null) continue;
    seen.add(code);
    out.push({
      // リールのコードは投稿ごとに一意。ID の代わりに使う。
      id: code,
      code,
      username,
      caption: "",
      timestamp: null,
      timestamp_estimated: false,
      permalink: `https://www.instagram.com/reel/${code}/`,
      ...counts,
    });
  }
  return out;
}

/** page.evaluate の戻り値からフォロワー数を取る。読めなければ null。 */
export function followerCountOf(raw) {
  if (!raw || typeof raw.followerText !== "string") return null;
  return parseCount(raw.followerText);
}
