/**
 * Instagram のセッション Cookie をファイルから読み、Playwright に渡せる形にする。
 *
 * Playwright が起動したブラウザは自動操作と判定され、ログイン画面の reCAPTCHA を
 * 通過できない。判定されると「ログイン情報が正しくありません」と出て堂々巡りになる。
 * そこで、普段使いのブラウザで既にログインしている状態から Cookie だけを受け取り、
 * ログイン画面にまったく触れずに済ませる。
 *
 * sessionid はパスワードと同じ重みの情報。値をログにもエラーにも出さないこと。
 */
import fs from "fs";

// Instagram のセッションを構成する Cookie。sessionid だけは必須。
const REQUIRED = "sessionid";
const OPTIONAL = ["csrftoken", "ds_user_id", "mid", "ig_did"];

/**
 * セッションファイルを読み、Playwright の addCookies に渡せる配列にする。
 * ファイルが無ければ null（＝この経路を使わない）。
 * 中身が不正なら例外。値は例外メッセージに含めない。
 */
export function loadSessionCookies(file) {
  if (!file || !fs.existsSync(file)) return null;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(
      `${file} が JSON として読めません。\n` +
      `  {"sessionid": "コピーした値"} の形で保存してください。`
    );
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${file} の中身が想定と違います。オブジェクトを1つ書いてください。`);
  }

  const value = data[REQUIRED];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `${file} に ${REQUIRED} がありません。\n` +
      `  普段使いのブラウザで instagram.com を開き、開発者ツール（Option+Command+I）→\n` +
      `  Application → Cookies → https://www.instagram.com から\n` +
      `  ${REQUIRED} の値をコピーしてください。`
    );
  }

  const cookies = [];
  for (const name of [REQUIRED, ...OPTIONAL]) {
    const v = data[name];
    if (typeof v !== "string" || v.trim() === "") continue;
    cookies.push({
      name,
      value: v.trim(),
      domain: ".instagram.com",
      path: "/",
      httpOnly: name === REQUIRED,
      secure: true,
      sameSite: "Lax",
    });
  }
  return cookies;
}

/** ログに出しても安全な要約。値そのものは絶対に含めない。 */
export function describeSession(cookies) {
  if (!cookies) return "セッションファイルなし";
  return `セッションを読み込みました（${cookies.map((c) => c.name).join(", ")}）`;
}
