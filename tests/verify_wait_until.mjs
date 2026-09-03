/**
 * 待機の処理を検証する。時間は偽物を渡すので、実際には待たない。
 *
 * 守りたいこと:
 *   1. async な条件を渡したら止める
 *      （Promise が常に truthy になり、1回も待たずに抜ける。実際に踏んだ）
 *   2. 条件が満たされるまで待つ
 *   3. 時間切れでも例外にせず、最後の判定を返す
 */
import { assertSyncCondition, waitUntil } from "../scripts/wait_until.mjs";

let pass = 0, fail = 0;
function check(label, cond, actual) {
  if (cond) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}  → 実際: ${JSON.stringify(actual)}`); }
}

/** 時間を進めない偽の時計と、呼ばれた回数を数える sleep。 */
function fakeClock() {
  let t = 0;
  const calls = [];
  return {
    now: () => t,
    sleep: async (ms) => { calls.push(ms); t += ms; },
    calls,
  };
}

console.log("--- 1. async な条件は受け付けない ---");
// これを許すと、待機が丸ごと効かなくなる。リールタブが描画される前に
// 読みに行って毎回0件になった原因がこれ
{
  let threw = null;
  try { assertSyncCondition(async () => true); } catch (e) { threw = e.message; }
  check("async を渡すと止まる", threw !== null, threw);
  check("理由が読めるメッセージ", /async/.test(threw || ""), threw);

  let threw2 = null;
  try { await waitUntil(async () => true, 1000); } catch (e) { threw2 = e.message; }
  check("waitUntil 経由でも止まる", threw2 !== null, threw2);
}
{
  let threw = null;
  try { assertSyncCondition("関数ではない"); } catch (e) { threw = e.message; }
  check("関数でなければ止まる", threw !== null, threw);
  check("同期の関数は通る",
        (() => { try { assertSyncCondition(() => true); return true; } catch { return false; } })(),
        null);
}

console.log("--- 2. 条件が満たされるまで待つ ---");
{
  const clock = fakeClock();
  let n = 0;
  const got = await waitUntil(() => ++n >= 3, 10000, 500, clock);
  check("満たされたら true", got === true, got);
  check("満たされるまで待つ（2回眠る）", clock.calls.length === 2, clock.calls);
}
{
  const clock = fakeClock();
  let n = 0;
  const got = await waitUntil(() => { n++; return true; }, 10000, 500, clock);
  check("最初から満たされていれば待たない", clock.calls.length === 0, clock.calls);
  check("その場合も true", got === true, got);
  check("条件は1回だけ呼ぶ", n === 1, n);
}

console.log("--- 3. 時間切れ ---");
{
  const clock = fakeClock();
  const got = await waitUntil(() => false, 1000, 500, clock);
  check("時間切れなら false（例外にしない）", got === false, got);
  check("上限を超えて待ち続けない", clock.calls.length <= 2, clock.calls);
}
{
  // 時間切れの直後に満たされた場合も拾う
  const clock = fakeClock();
  let n = 0;
  const got = await waitUntil(() => ++n > 2, 1000, 500, clock);
  check("最後にもう一度だけ判定する", got === true, got);
}
{
  const clock = fakeClock();
  const got = await waitUntil(() => 0, 1000, 500, clock);
  check("返り値は必ず真偽値", got === false && typeof got === "boolean", got);
}

console.log("--- 4. ページの描画待ちには使わない ---");
// リールタブの待機は Playwright の waitForSelector に任せている。
// waitUntil で待とうとすると async が要るため、必ず壊れる
{
  const fs = await import("fs");
  const src = fs.readFileSync(new URL("../scripts/scrape.mjs", import.meta.url), "utf8");
  check("リールタブは waitForSelector で待っている",
        /waitForSelector\('a\[href\*="\/reel\/"\]'/.test(src), null);
  check("リールタブの待機に waitUntil を使っていない",
        !/waitUntil\(\s*async/.test(src), null);
  // 見つからなくても例外にしない。リールを1本も投稿していない人がいる
  check("見つからなくても止めない", /\.catch\(\(\) => false\)/.test(src), null);
}

console.log(`\n結果: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
