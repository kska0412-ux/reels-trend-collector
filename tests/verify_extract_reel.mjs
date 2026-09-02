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

  const us = findReels({ x: reel({ pk: "u1", taken_at: undefined,
                                   device_timestamp: 1756500000000000 }) })[0];
  check("マイクロ秒も秒に直る", us.timestamp === sec.timestamp,
        [us.timestamp, sec.timestamp]);
  const future = findReels({ x: reel({ pk: "f1", taken_at: 99999999999 }) })[0];
  check("遠い未来の時刻は取れなかった扱い", future.timestamp === null, future.timestamp);
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

console.log("--- 13. 代替キーへのフォールバック ---");
{
  // id: pk が無い場合の代替キー。実データがどのキーで来るか未確定のため、
  // 優先順と型変換の両方を押さえておく。
  const byId = findReels({ x: reel({ pk: undefined, id: "id_string" }) });
  check("pkが無ければ id を使う", byId.length === 1 && byId[0].id === "id_string", byId);
  const byPkId = findReels({ x: reel({ pk: undefined, id: undefined, pk_id: "pkid_string" }) });
  check("pk も id も無ければ pk_id を使う",
        byPkId.length === 1 && byPkId[0].id === "pkid_string", byPkId);
  const numericPk = findReels({ x: reel({ pk: 12345 }) });
  check("数値の pk は文字列になる",
        numericPk.length === 1 && numericPk[0].id === "12345", numericPk);
  const priority = findReels({ x: reel({ pk: "from_pk", id: "from_id" }) });
  check("pk が id より優先される", priority[0].id === "from_pk", priority[0].id);

  // caption: 置き場所のゆれ
  const strCap = findReels({ x: reel({ pk: "c1", caption: "文字列のcaption" }) });
  check("captionが文字列でも拾える", strCap[0].caption === "文字列のcaption", strCap[0].caption);
  const textKey = findReels({ x: reel({ pk: "c2", caption: undefined, text: "textキーの本文" }) });
  check("o.text からも拾える", textKey[0].caption === "textキーの本文", textKey[0].caption);

  // timestamp: taken_at 以外のキー
  const tsAlt = findReels({ x: reel({ pk: "t1", taken_at: undefined, taken_at_timestamp: 1756500000 }) });
  const tsBase = findReels({ x: reel({ pk: "t2", taken_at: 1756500000 }) });
  check("taken_at_timestamp でも同じ時刻になる",
        tsAlt[0].timestamp === tsBase[0].timestamp, [tsAlt[0].timestamp, tsBase[0].timestamp]);
  const tsDev = findReels({ x: reel({ pk: "t3", taken_at: undefined, device_timestamp: 1756500000 }) });
  check("device_timestamp でも拾える",
        tsDev[0].timestamp === tsBase[0].timestamp, tsDev[0].timestamp);
  const tsStr = findReels({ x: reel({ pk: "t4", taken_at: undefined, timestamp: "2026-08-30T12:00:00+0000" }) });
  check("文字列の timestamp はそのまま通す",
        tsStr[0].timestamp === "2026-08-30T12:00:00+0000", tsStr[0].timestamp);

  // num(): 数値でない値は null にする（0 で埋めない）
  const strLike = findReels({ x: reel({ pk: "n1", like_count: "12400" }) });
  check("文字列の like_count は null（0で埋めない）",
        strLike[0].like_count === null, strLike[0].like_count);
  const strComment = findReels({ x: reel({ pk: "n2", comment_count: "89" }) });
  check("文字列の comment_count は null",
        strComment[0].comment_count === null, strComment[0].comment_count);
}

console.log(`\n結果: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
