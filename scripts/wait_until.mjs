/**
 * 条件が満たされるまで待つ。満たされたら true、時間切れなら最後の判定を返す。
 *
 * 条件は「同期」で書くこと。async を渡すと、返る Promise が常に truthy に
 * なって1回も待たずに抜ける。実際にこれを踏み、リールタブが描画される前に
 * 読みに行って毎回0件になった。気づきにくいので、渡された時点で止める。
 *
 * ページの描画を待つ用途には Playwright の waitForSelector を使う。
 * こちらは「傍受したレスポンスが増えたか」のような、こちら側の状態を待つ用。
 */

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function assertSyncCondition(cond) {
  if (typeof cond !== "function") {
    throw new Error("waitUntil には関数を渡してください。");
  }
  if (cond.constructor && cond.constructor.name === "AsyncFunction") {
    throw new Error(
      "waitUntil には同期の条件を渡してください。" +
      "async を渡すと Promise が truthy になり、待機が効きません。"
    );
  }
}

export async function waitUntil(cond, timeoutMs, intervalMs = 500,
                                { sleep = defaultSleep, now = Date.now } = {}) {
  assertSyncCondition(cond);
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (cond()) return true;
    await sleep(intervalMs);
  }
  return Boolean(cond());
}
