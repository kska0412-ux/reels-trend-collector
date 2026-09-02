/**
 * extract_profile.mjs のフォロワー数抽出を、合成した JSON で検証する。
 *
 * 取れなかったときに 0 を返さないことが最重要。0 を返すと
 * 伸び率が無限大になり、ページの上位を汚染する。
 */
import { findFollowerCount, extractFollowerCount } from "../scripts/extract_profile.mjs";

let pass = 0, fail = 0;
function check(label, cond, actual) {
  if (cond) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}  → 実際: ${JSON.stringify(actual)}`); }
}

console.log("--- 1. follower_count 形式 ---");
{
  const json = { data: { user: { username: "example_nail", follower_count: 15677 } } };
  check("取れる", findFollowerCount(json, "example_nail") === 15677,
        findFollowerCount(json, "example_nail"));
}

console.log("--- 2. edge_followed_by.count 形式 ---");
{
  const json = { graphql: { user: { username: "example_nail",
                                    edge_followed_by: { count: 8421 } } } };
  check("取れる", findFollowerCount(json, "example_nail") === 8421,
        findFollowerCount(json, "example_nail"));
}

console.log("--- 3. 別ユーザーのオブジェクトは拾わない ---");
{
  const json = { items: [
    { username: "someone_else", follower_count: 999999 },
    { username: "example_nail", follower_count: 15677 },
  ] };
  check("指定したユーザーの値だけを返す",
        findFollowerCount(json, "example_nail") === 15677,
        findFollowerCount(json, "example_nail"));
  check("該当ユーザーが居なければnull",
        findFollowerCount(json, "nobody_here") === null,
        findFollowerCount(json, "nobody_here"));
}

console.log("--- 4. 大文字小文字を無視する ---");
{
  const json = { user: { username: "Example_Nail", follower_count: 100 } };
  check("小文字で照会しても取れる", findFollowerCount(json, "example_nail") === 100,
        findFollowerCount(json, "example_nail"));
}

console.log("--- 5. 取れないときは null（0で埋めない） ---");
{
  check("フォロワー数キーが無ければnull",
        findFollowerCount({ user: { username: "example_nail" } }, "example_nail") === null, null);
  check("文字列は認めない",
        findFollowerCount({ user: { username: "u", follower_count: "100" } }, "u") === null, null);
  check("負数は認めない",
        findFollowerCount({ user: { username: "u", follower_count: -5 } }, "u") === null, null);
  check("0フォロワーは有効な値として返す",
        findFollowerCount({ user: { username: "u", follower_count: 0 } }, "u") === 0, null);
  check("nullを渡しても落ちない", findFollowerCount(null, "u") === null, null);
  check("usernameが空なら常にnull",
        findFollowerCount({ user: { username: "u", follower_count: 5 } }, "") === null, null);
}

console.log("--- 6. 深いネストでも見つかる ---");
{
  let nested = { username: "deep_user", follower_count: 42 };
  for (let i = 0; i < 20; i++) nested = { level: nested };
  check("20段でも見つかる", findFollowerCount(nested, "deep_user") === 42, null);
  let tooDeep = { username: "far_user", follower_count: 42 };
  for (let i = 0; i < 60; i++) tooDeep = { level: tooDeep };
  check("60段は打ち切る（暴走防止）", findFollowerCount(tooDeep, "far_user") === null, null);
}

console.log("--- 7. 壊れた入力への耐性 ---");
{
  const circular = { username: "loop_user", follower_count: 7 };
  circular.self = circular;
  let ok = true;
  try { findFollowerCount(circular, "loop_user"); } catch { ok = false; }
  check("循環参照で無限ループしない", ok, null);
  check("空文字列の本文はnull", extractFollowerCount("", "u") === null, null);
  check("JSONでない本文はnull", extractFollowerCount("<html>", "u") === null, null);
}

console.log("--- 8. 改行区切りの複数JSON ---");
{
  const body = [
    JSON.stringify({ noise: 1 }),
    JSON.stringify({ user: { username: "example_nail", follower_count: 333 } }),
  ].join("\n");
  check("2本目から取れる", extractFollowerCount(body, "example_nail") === 333,
        extractFollowerCount(body, "example_nail"));
}

console.log("--- 9. 複数見つかったら最大値を採る ---");
{
  // 検索候補の簡易オブジェクトと本体が両方入っていることがある。
  // 簡易側は値が欠けたり丸められたりするので、大きい方を信じる。
  const json = { a: { username: "u", follower_count: 1200 },
                 b: { username: "u", follower_count: 1234 } };
  check("大きい方を返す", findFollowerCount(json, "u") === 1234, findFollowerCount(json, "u"));
}

console.log(`\n結果: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
