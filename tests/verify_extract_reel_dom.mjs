/**
 * プロフィールのリールタブから読み取る処理を検証する。
 * ブラウザも通信も使わない（page.evaluate の戻り値を模した入力で試す）。
 *
 * 守りたいこと:
 *   1. 「4.2万」のような省略表記を数値に直せる
 *   2. 画面に出ている数字が再生数、出ていない数字がいいね・コメント
 *   3. 再生数が読めないものは入れない（伸び率が出せず順位も付かないため）
 *   4. 取れなかった値を 0 で埋めない
 */
import {
  REELS_TAB_CALL, REELS_TAB_SCRIPT, buildReels, codeFromHref, followerCountOf,
  looksLikeCount, parseCount, pickCounts, timestampFromCode,
} from "../scripts/extract_reel_dom.mjs";

let pass = 0, fail = 0;
function check(label, cond, actual) {
  if (cond) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}  → 実際: ${JSON.stringify(actual)}`); }
}

console.log("--- 1. 省略表記を数値にする ---");
for (const [text, want] of [
  ["4.2万", 42000], ["10.7万", 107000], ["1万", 10000], ["1.5億", 150000000],
  ["1022", 1022], ["1,022", 1022], ["8,915", 8915], ["0", 0],
  ["3.1K", 3100], ["2M", 2000000], ["1.2B", 1200000000], ["12k", 12000],
]) {
  check(`「${text}」→ ${want}`, parseCount(text) === want, parseCount(text));
}

console.log("--- 2. 数字でないものは読まない ---");
// 0 を返すと「0回再生だった」と読めてしまう。読めなければ null
for (const bad of ["", "   ", "フォロワー", "4.2万回", "1,0,2,2万万", null, undefined, 42, {}]) {
  check(`${JSON.stringify(bad)} は null`, parseCount(bad) === null, parseCount(bad));
}
check("looksLikeCount が数字を見分ける",
      looksLikeCount("4.2万") && !looksLikeCount("いいね"), null);

console.log("--- 3. リンクからコードを取る ---");
check("/user/reel/CODE/ から取れる",
      codeFromHref("/ginza.kogao.yuta/reel/Dcs6ZpRTfy5/") === "Dcs6ZpRTfy5", null);
check("/reel/CODE/ からも取れる",
      codeFromHref("/reel/DUb4hcgEv2C/") === "DUb4hcgEv2C", null);
check("/reels/CODE/ からも取れる",
      codeFromHref("https://www.instagram.com/reels/DUb4hcgEv2C/") === "DUb4hcgEv2C", null);
check("リールでないリンクは null", codeFromHref("/p/ABC123/") === null, codeFromHref("/p/ABC123/"));
check("文字列でなくても落ちない", codeFromHref(null) === null && codeFromHref(42) === null, null);

console.log("--- 4. 見えている数字が再生数 ---");
// 実データ: ginza.kogao.yuta のリール。4.2万が画面に出ており、1022と121は 0x0
{
  const got = pickCounts(["4.2万"], ["1022", "121"]);
  check("再生数を拾う", got.play_count === 42000, got);
  check("いいねを拾う", got.like_count === 1022, got);
  check("コメントを拾う", got.comment_count === 121, got);
}
// 実データ: style_156xs のリール。カーソル用の数字が無いアカウントもある
{
  const got = pickCounts(["2261"], []);
  check("いいねが無くても再生数は取れる", got.play_count === 2261, got);
  check("無いものは null（0で埋めない）",
        got.like_count === null && got.comment_count === null, got);
}
{
  const got = pickCounts([], ["1022"]);
  check("見えている数字が無ければ再生数は null", got.play_count === null, got);
}
check("引数が無くても落ちない", pickCounts().play_count === null, pickCounts());

console.log("--- 4b. コードから投稿時刻を復元する ---");
// リールタブに投稿日時は出ない。これが無いと全部「不明」になり、
// 新着順と期間の絞り込みが効かなくなる
{
  // 実ブラウザで taken_at と突き合わせた実データ。
  // DclRMswTDoi の実際の投稿は 1787917097（2026-08-28 20:38:17 JST）
  const REAL_TAKEN_AT = 1787917097;
  const got = timestampFromCode("DclRMswTDoi");
  check("実在のコードから復元できる", typeof got === "number", got);
  // 復元値には誤差がある。実測は2.4分だった。10分を超えたら作りが壊れている
  const diffMin = Math.abs(got - REAL_TAKEN_AT) / 60;
  check(`実際の投稿時刻との差が10分以内（実測 ${diffMin.toFixed(1)} 分）`,
        diffMin < 10, diffMin);

  // 新しいコードほど新しい時刻になること。順序が逆だと新着順が壊れる
  const older = timestampFromCode("DZzebCHRSjF");   // 2026-06-20 ごろ
  const newer = timestampFromCode("DclRMswTDoi");   // 2026-08-28 ごろ
  check("新しいコードほど後の時刻になる", newer > older, { older, newer });

  check("読めない文字が混ざれば null", timestampFromCode("###") === null, null);
  check("空文字は null", timestampFromCode("") === null, null);
  check("文字列でなければ null",
        timestampFromCode(null) === null && timestampFromCode(42) === null, null);
  // 桁数の違うコードから、ありえない日付を作らない
  check("短すぎるコードは null", timestampFromCode("A") === null, timestampFromCode("A"));
  check("長すぎるコードは null（未来になる）",
        timestampFromCode("zzzzzzzzzzzzzzzz") === null,
        timestampFromCode("zzzzzzzzzzzzzzzz"));
}

console.log("--- 5. 保存する形に組み立てる ---");
{
  // 実在のコードを使う。作り物の短い文字列だと時刻を復元できず、
  // 「復元できている」ことを確かめられない
  const A = "DclRMswTDoi";
  const B = "DZzebCHRSjF";
  const raw = {
    rows: [
      { code: A, shown: ["4.2万"], hidden: ["1022", "121"] },
      { code: B, shown: ["2261"], hidden: [] },
      // 再生数が読めないものは落とす。伸び率が出せず順位も付かない
      { code: "DbimAxQMSZL", shown: [], hidden: ["50"] },
      // 同じコードが2回出てきても1件にする
      { code: A, shown: ["9.9万"], hidden: [] },
      { code: null, shown: ["1"], hidden: [] },
    ],
    followerText: "19.2万",
  };
  const reels = buildReels(raw, "ginza.kogao.yuta");
  check("再生数が読めた2件だけ残る", reels.length === 2, reels.map((r) => r.code));
  check("重複したコードは1件", reels.filter((r) => r.code === A).length === 1, reels);
  check("先に出てきた方を採用", reels[0].play_count === 42000, reels[0]);
  check("id はコードと同じ", reels[0].id === reels[0].code, reels[0]);
  check("username が入る", reels.every((r) => r.username === "ginza.kogao.yuta"), reels);
  check("permalink を組み立てる",
        reels[0].permalink === `https://www.instagram.com/reel/${A}/`, reels[0].permalink);
  // 投稿時刻はこのページに出ないので、コードから復元する
  check("時刻を復元する", typeof reels[0].timestamp === "string", reels[0].timestamp);
  check("ISO8601 の形にする",
        !Number.isNaN(Date.parse(reels[0].timestamp)), reels[0].timestamp);
  // 復元値には数分の誤差がある。取れた時刻と同じ顔で見せない
  check("推定であることが分かる印を立てる",
        reels[0].timestamp_estimated === true, reels[0]);
  check("いいねが無い方は null", reels[1].like_count === null, reels[1]);

  // 時刻が読めないコードでも、再生数が取れていれば取り込む。
  // 時刻だけ null にして「不明」と出す
  const odd = buildReels({ rows: [{ code: "AAA", shown: ["100"], hidden: [] }] }, "x");
  check("時刻が読めなくても取り込む", odd.length === 1, odd);
  check("その場合の時刻は null", odd[0].timestamp === null, odd[0]);
  check("推定の印も立てない", odd[0].timestamp_estimated === false, odd[0]);

  check("フォロワー数を読む", followerCountOf(raw) === 192000, followerCountOf(raw));
}
check("空でも落ちない", buildReels(null, "x").length === 0, null);
check("rows が無くても落ちない", buildReels({}, "x").length === 0, null);
check("フォロワーが読めなければ null",
      followerCountOf({ followerText: null }) === null
      && followerCountOf(null) === null, null);

console.log("--- 6. ページ内で動かす関数 ---");
// 文字列で渡すので、構文が壊れていても実行するまで気づけない。ここで確かめる
{
  let ok = true, err = null;
  try { new Function(`return (${REELS_TAB_SCRIPT})`); } catch (e) { ok = false; err = e.message; }
  check("構文が通る", ok, err);
  check("リールのリンクを探している", /a\[href\*="\/reel\/"\]/.test(REELS_TAB_SCRIPT), null);
  // クラス名は難読化されていて変わる。大きさで見分ける方式から外れていないこと
  check("大きさで見分けている", /getBoundingClientRect/.test(REELS_TAB_SCRIPT), null);
  check("フォロワー数も同じページから取る", /フォロワー/.test(REELS_TAB_SCRIPT), null);
}

console.log("--- 7. Playwright に渡す形 ---");
// page.evaluate は文字列を「式」として評価する。関数のソースをそのまま渡すと
// 関数オブジェクトが返り、シリアライズできず undefined になる（実際に踏んだ）。
// ここで「呼び出しまで含んでいるか」を、Playwright と同じ評価のしかたで確かめる。
{
  // 偽の DOM。リール2件ぶんのリンクを持たせる。
  const makeEl = (text, w, h, children = []) => ({
    textContent: text, children,
    getBoundingClientRect: () => ({ width: w, height: h }),
    querySelectorAll: () => children,
  });
  const makeLink = (code, shownText, hiddenTexts) => {
    const kids = [makeEl(shownText, 41, 19),
                  ...hiddenTexts.map((t) => makeEl(t, 0, 0))];
    return {
      getAttribute: (n) => (n === "href" ? `/u/reel/${code}/` : null),
      querySelectorAll: () => kids,
    };
  };
  const fakeDoc = {
    querySelectorAll: () => [makeLink("AAA", "4.2万", ["1022", "121"]),
                             makeLink("BBB", "2261", [])],
    body: { innerText: "投稿368件 フォロワー 19.2万 人 フォロー中115人" },
  };

  const prevDoc = globalThis.document;
  globalThis.document = fakeDoc;
  let result;
  try {
    // Playwright が文字列に対してするのと同じこと（式として評価する）
    result = (0, eval)(REELS_TAB_CALL);
  } finally {
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
  }

  check("式として評価すると値が返る（関数のままにしない）",
        result !== undefined && typeof result === "object", result);
  check("rows を持つ", Array.isArray(result && result.rows), result);
  check("リール2件を読む", result.rows.length === 2, result.rows);
  check("表示されている数字を shown に入れる",
        result.rows[0].shown[0] === "4.2万", result.rows[0]);
  check("隠れている数字を hidden に入れる",
        result.rows[0].hidden.join(",") === "1022,121", result.rows[0]);
  check("フォロワーの表記を拾う", result.followerText === "19.2万", result.followerText);

  // 組み立てまで通す
  const reels = buildReels(result, "tester");
  check("そのまま buildReels に通せる", reels.length === 2, reels);
  check("再生数が入る", reels[0].play_count === 42000, reels[0]);
  check("フォロワーが読める", followerCountOf(result) === 192000, followerCountOf(result));

  // 関数のソースをそのまま渡すと undefined になることを、ここで示しておく
  const wrong = (0, eval)(REELS_TAB_SCRIPT);
  check("関数のソースだけでは値にならない（これが原因だった）",
        typeof wrong === "function", typeof wrong);
}

console.log(`\n結果: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
