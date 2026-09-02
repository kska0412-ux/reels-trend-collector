/**
 * retry.mjs のやり直し判定を検証する。待機は差し替えて即座に進める。
 */
import { collectWithRetry, isFatal } from "../scripts/retry.mjs";

let pass = 0, fail = 0;
function check(label, cond, actual) {
  if (cond) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}  → 実際: ${JSON.stringify(actual)}`); }
}

const nosleep = async () => {};
const reels = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i) }));

console.log("--- 1. 十分に取れたらやり直さない ---");
{
  let calls = 0;
  const out = await collectWithRetry(async () => { calls++; return reels(10); },
                                     { minReels: 5, sleep: nosleep });
  check("1回で終わる", calls === 1, calls);
  check("10件返る", out.reels.length === 10, out.reels.length);
  check("errorはnull", out.error === null, out.error);
}

console.log("--- 2. 件数不足ならやり直す ---");
{
  let calls = 0;
  const out = await collectWithRetry(async () => { calls++; return reels(calls === 1 ? 2 : 8); },
                                     { minReels: 5, sleep: nosleep });
  check("2回呼ばれる", calls === 2, calls);
  check("多い方を採る", out.reels.length === 8, out.reels.length);
}

console.log("--- 3. やり直しても足りなければ、多い方を返す ---");
{
  let calls = 0;
  const out = await collectWithRetry(async () => { calls++; return reels(calls === 1 ? 3 : 1); },
                                     { minReels: 5, sleep: nosleep });
  check("試行は2回で打ち切る", calls === 2, calls);
  check("1回目の3件を捨てない", out.reels.length === 3, out.reels.length);
  check("1件でも取れていれば成功扱い", out.error === null, out.error);
}

console.log("--- 4. 例外が起きても取れた分は捨てない ---");
{
  let calls = 0;
  const out = await collectWithRetry(async () => {
    calls++;
    if (calls === 1) return reels(3);
    throw new Error("タイムアウト");
  }, { minReels: 5, sleep: nosleep });
  check("1回目の3件が残る", out.reels.length === 3, out.reels.length);
  check("errorはnull（取れているので）", out.error === null, out.error);
  check("lastErrorには理由が残る", out.lastError === "タイムアウト", out.lastError);
}

console.log("--- 5. 全部失敗したらerrorを返す ---");
{
  const out = await collectWithRetry(async () => { throw new Error("接続できません"); },
                                     { sleep: nosleep });
  check("0件", out.reels.length === 0, out.reels.length);
  check("errorに理由が入る", out.error === "接続できません", out.error);
}

console.log("--- 6. 致命的エラーはやり直さない ---");
{
  check("ログイン切れは致命的", isFatal("ログインしていません。--login を先に実行してください。"), null);
  check("タイムアウトは致命的でない", !isFatal("タイムアウト"), null);
  check("非文字列は致命的でない", !isFatal(null), null);
  let calls = 0;
  const out = await collectWithRetry(async () => {
    calls++; throw new Error("ログインしていません");
  }, { sleep: nosleep });
  check("1回で打ち切る", calls === 1, calls);
  check("errorが返る", out.error === "ログインしていません", out.error);
}

console.log(`\n結果: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
