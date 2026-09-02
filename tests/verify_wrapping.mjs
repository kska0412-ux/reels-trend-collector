/**
 * 改行の作法を検証する（CLAUDE.md の日本語コピー改行ルール）。
 *
 * 守りたいこと:
 *   1. 単語の途中で改行しない（「デザイン」を「デ」で割らない）
 *   2. 「を」「と」などの助詞が行頭に来ない
 *
 * 1 は CSS の word-break で決まる。break-word / break-all は途中で割るので使わない。
 * 2 は CSS では防げないため、自前の文言を文節ごとに nowrap で囲って担保する。
 *   （収集したキャプションは他人の文章なので、ここでは対象外）
 */
import fs from 'fs';
import { pathToFileURL } from 'url';

const { JSDOM } = await import(
  pathToFileURL(`${process.env.SCRATCH}/node_modules/jsdom/lib/api.js`).href
);

const html = fs.readFileSync(process.env.SCRATCH + '/preview.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously' });
const doc = dom.window.document;
const cssRaw = doc.querySelector('style').textContent;
// コメント内の説明文に反応しないよう、実際の指定だけを見る
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');

let pass = 0, fail = 0;
function check(label, cond, actual) {
  if (cond) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}  → 実際: ${JSON.stringify(actual)}`); }
}

console.log('--- 1. 単語の途中で改行しない ---');
const badBreaks = css.match(/word-break:\s*(break-word|break-all)/g);
check('word-break に break-word / break-all を使っていない', badBreaks === null, badBreaks);
check('word-break: normal を指定している', /word-break:\s*normal/.test(css), null);
check('あふれる時だけ折る overflow-wrap を使っている',
      /overflow-wrap:\s*break-word/.test(css), null);
check('日本語の禁則を強める line-break: strict がある',
      /line-break:\s*strict/.test(css), null);
check('キャプションにも適用されている',
      /\.text\s*\{[^}]*word-break:\s*normal/s.test(css), null);

console.log('--- 2. 文節をまとめる仕組み ---');
check('.nb が nowrap で定義されている', /\.nb\s*\{\s*white-space:\s*nowrap/.test(css), null);

console.log('--- 3. 短いラベルが途中で割れない ---');
for (const cls of ['stat-value', 'stat-label', 'count', 'tag', 'link',
                   'likes', 'vel', 'age', 'metric', 'bar-count',
                   'breakdown-title', 'chip-name', 'badge', 'filter-label']) {
  check(`.${cls} が nowrap`,
        new RegExp(`\\.${cls}\\s*\\{[^}]*white-space:\\s*nowrap`, 's').test(css), null);
}

console.log('--- 4. 助詞が行頭に来ないこと（自前の文言） ---');
// 該当なしのメッセージを出させる
const q = doc.getElementById('q');
q.value = 'ぜったいに存在しない語';
q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
const empty = doc.querySelector('.empty');
check('該当なしのメッセージが出る', empty !== null, null);
const emptyUnits = [...empty.querySelectorAll('.nb')].map(e => e.textContent);
check('文節ごとに分かれている', emptyUnits.length >= 4, emptyUnits);
check('「絞り込みを」が1かたまりになっている', emptyUnits.includes('絞り込みを'), emptyUnits);
check('全文が .nb の中に収まっている',
      emptyUnits.join('') === empty.textContent,
      { units: emptyUnits.join(''), all: empty.textContent });

// 助詞で始まるかたまりが無いこと
const PARTICLES = ['を', 'と', 'は', 'が', 'に', 'で', 'の', 'も', 'へ', 'や', 'から', 'まで'];
const allUnits = [...doc.querySelectorAll('.nb')].map(e => e.textContent.trim()).filter(Boolean);
const startsWithParticle = allUnits.filter(t => PARTICLES.some(p => t.startsWith(p)));
check('助詞で始まるかたまりが無い', startsWithParticle.length === 0, startsWithParticle);

console.log('--- 5. 注記も文節で括られている ---');
const note = doc.querySelector('.note');
const ratioUnits = [...note.querySelectorAll('.nb')].map(e => e.textContent);
check('伸び率の注記が文節ごとに分かれている', ratioUnits.length >= 8, ratioUnits);
check('「フォロワー数で」が1かたまり', ratioUnits.includes('フォロワー数で'), ratioUnits);
check('注記の全文が .nb に収まっている',
      ratioUnits.join('') === note.textContent, ratioUnits.join(''));

console.log('--- 5b. ジャンル別の横棒 ---');
// 名前の長さで列幅が動くと、棒の開始位置が行ごとにずれて長さを比べられない
check('名前の列が固定幅',
      /\.bar-row\s*\{[^}]*grid-template-columns:\s*[\d.]+em 1fr auto/s.test(css), null);
const barUnits = [...doc.querySelectorAll('.bar-name .nb')].map(e => e.textContent);
check('ジャンル名が文節ごとに分かれている', barUnits.length > 0, barUnits);
check('「・」が行頭に来ない', barUnits.every(u => !u.startsWith('・')), barUnits);

console.log('--- 6. ライトとダークで同じトークンが定義されている ---');
// jsdom は CSS を評価しないので、テキストとして3ブロックを抜き出して比べる。
// 片方だけ色を足す変更が入ると、その閲覧環境だけ色が抜ける。
function tokensIn(selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 's');
  const m = css.match(re);
  if (!m) return null;
  return [...m[1].matchAll(/(--[\w-]+)\s*:/g)].map((x) => x[1]).sort();
}
const light = tokensIn(':root');
const sysDark = tokensIn(':root:not([data-theme="light"])');
const optDark = tokensIn(':root[data-theme="dark"]');
check('明るい側のトークンが定義されている', light !== null && light.length > 0, light);
check('OSがダークのときのトークンが定義されている', sysDark !== null, sysDark);
check('閲覧者がダークを選んだときのトークンが定義されている', optDark !== null, optDark);
check('OSダーク側が明るい側と同じ顔ぶれ',
      JSON.stringify(sysDark) === JSON.stringify(light),
      { light, sysDark });
check('閲覧者ダーク側が明るい側と同じ顔ぶれ',
      JSON.stringify(optDark) === JSON.stringify(light),
      { light, optDark });
check('body に背景色を塗っている（透明にしない）',
      /body\s*\{[^}]*background:\s*var\(--bg\)/s.test(css), null);

console.log(`\n結果: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
