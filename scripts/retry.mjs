/**
 * 1ハッシュタグぶんの取得を、必要ならやり直す。
 *
 * やり直す条件は2つ:
 *   - 例外で落ちた（タイムアウトなど）
 *   - 取れた件数が少なすぎる（読み込み途中で打ち切った可能性が高い）
 *
 * 取れたリールは、途中で例外が起きても捨てない。件数が多かった試行の結果を採用する。
 */

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 続行不能で、やり直しても無駄なエラーか。 */
export function isFatal(message) {
  return typeof message === "string" && message.includes("ログインしていません");
}

export async function collectWithRetry(run, options = {}) {
  const {
    minReels = 5,
    attempts = 2,
    retryWaitMs = 5000,
    onRetry = () => {},
    sleep = defaultSleep,
  } = options;

  let best = null;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const got = await run(attempt);
      lastError = null;
      if (!best || got.length > best.length) best = got;

      if (best.length >= minReels || attempt === attempts) break;
      onRetry(`${got.length} 件しか取れず`);
      await sleep(retryWaitMs);
    } catch (e) {
      lastError = String((e && e.message) || e).split("\n")[0];
      if (isFatal(lastError)) break;
      if (attempt === attempts) break;
      onRetry(`失敗 — ${lastError}`);
      await sleep(retryWaitMs);
    }
  }

  const reels = best || [];
  return {
    reels,
    // 1件でも取れていれば成功扱いにする。取れた分を握りつぶさないため。
    error: reels.length > 0 ? null : lastError,
    lastError,
  };
}
