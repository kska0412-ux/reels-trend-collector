/**
 * 生成した HTML を jsdom で実際に動かし、タブと並び替えが機能するか検証する。
 * 通信もブラウザも使わない（jsdom はローカルの DOM 実装）。
 */
import fs from 'fs';
import { pathToFileURL } from 'url';

const { JSDOM } = await import(
  pathToFileURL(`${process.env.SCRATCH}/node_modules/jsdom/lib/api.js`).href
);

const html = fs.readFileSync(process.env.SCRATCH + '/preview.html', 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously' });
const doc = dom.window.document;

let pass = 0, fail = 0;
function check(label, cond, actual) {
  if (cond) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}  → 実際: ${JSON.stringify(actual)}`); }
}

const cards = () => [...doc.querySelectorAll('.card')];
const visible = () => cards().filter(c => c.style.display !== 'none');
const click = (el) => el.dispatchEvent(new dom.window.Event('click', { bubbles: true }));

console.log('--- 1. 外部リソースを参照していない ---');
{
  const srcs = [...doc.querySelectorAll('[src], link[href]')]
    .map(e => e.getAttribute('src') || e.getAttribute('href'))
    .filter(u => u && /^https?:/i.test(u));
  check('外部の src / link href が無い（単一ファイル完結）', srcs.length === 0, srcs);
  check('img タグが無い（サムネイルは出さない）',
        doc.querySelectorAll('img').length === 0,
        [...doc.querySelectorAll('img')].map(e => e.src));
  check('noindex が入っている',
        /noindex/.test(doc.querySelector('meta[name="robots"]')?.content || ''), null);
}

console.log('--- 2. カードが描画される ---');
{
  check('カードが1件以上ある', cards().length > 0, cards().length);
  const first = cards()[0];
  check('リンクが instagram.com/reel/ を指す',
        /^https:\/\/www\.instagram\.com\/reel\//.test(
          first.querySelector('a.link').getAttribute('href')), null);
  check('リンクは新しいタブで開く',
        first.querySelector('a.link').getAttribute('target') === '_blank', null);
  check('rel に noopener が入っている',
        /noopener/.test(first.querySelector('a.link').getAttribute('rel') || ''), null);
}

console.log('--- 3. ジャンルタブ ---');
{
  const tabs = [...doc.querySelectorAll('.tab')];
  check('タブが7個（全部 + 6ジャンル）', tabs.length === 7, tabs.map(t => t.textContent));
  check('先頭は「全部」', tabs[0].textContent.includes('全部'), tabs[0].textContent);

  const before = visible().length;
  const nail = tabs.find(t => t.textContent.trim() === 'ネイル');
  click(nail);
  const after = visible();
  check('ネイルタブで件数が減る', after.length > 0 && after.length < before,
        [before, after.length]);
  check('表示されたカードは全部ネイル',
        after.every(c => c.dataset.genres.split('|').includes('ネイル')),
        after.map(c => c.dataset.genres));
  check('押したタブに選択状態が付く', nail.classList.contains('on'), nail.className);

  click(tabs[0]);
  check('「全部」で元に戻る', visible().length === before, visible().length);
}

console.log('--- 4. 並び替え ---');
{
  const buttons = [...doc.querySelectorAll('.sort-btn')];
  check('並び替えは3種類', buttons.length === 3, buttons.map(b => b.textContent));

  const nums = (attr) => visible().map(c => {
    const v = c.dataset[attr];
    return v === '' ? null : Number(v);
  });
  const descOk = (arr) => {
    const known = arr.filter(v => v !== null);
    const idx = arr.findIndex(v => v === null);
    // null（取れていない値）は必ず末尾に固まる
    const nullsAtEnd = idx === -1 || arr.slice(idx).every(v => v === null);
    return nullsAtEnd && known.every((v, i) => i === 0 || known[i - 1] >= v);
  };

  click(buttons.find(b => b.textContent.includes('伸び率順')));
  check('伸び率の降順に並ぶ（取れていない分は末尾）', descOk(nums('ratio')), nums('ratio'));

  click(buttons.find(b => b.textContent.includes('再生数順')));
  check('再生数の降順に並ぶ', descOk(nums('plays')), nums('plays'));

  click(buttons.find(b => b.textContent.includes('新着順')));
  const posted = visible().map(c => c.dataset.posted);
  const dated = posted.filter(p => p !== '');
  check('新しい順に並ぶ',
        dated.every((p, i) => i === 0 || dated[i - 1] >= p), dated);
  check('投稿日時が無いカードは末尾', posted.filter(p => p === '').length === 0
        || posted.slice(posted.indexOf('')).every(p => p === ''), posted);
}

console.log('--- 5. 取れていない値の表示 ---');
{
  click([...doc.querySelectorAll('.tab')][0]);
  const noRatio = cards().find(c => c.dataset.ratio === '');
  check('伸び率が取れていないカードがある（フィクスチャ由来）', noRatio !== undefined, null);
  check('伸び率は「—」と出す（0 と出さない）',
        noRatio.querySelector('.ratio').textContent.includes('—'),
        noRatio.querySelector('.ratio').textContent);
  check('フォロワー数も「—」と出す',
        noRatio.querySelector('.followers').textContent.includes('—'),
        noRatio.querySelector('.followers').textContent);
}

console.log('--- 6. 絞り込みで0件になったとき ---');
{
  const q = doc.getElementById('q');
  q.value = 'ぜったいに存在しない語';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  check('カードが全部隠れる', visible().length === 0, visible().length);
  check('該当なしのメッセージが出る', doc.querySelector('.empty') !== null, null);
  q.value = '';
  q.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  check('空に戻すとカードが戻る', visible().length > 0, visible().length);
}

console.log('--- 7. 集計 ---');
{
  check('集計パネルがある', doc.querySelector('.summary') !== null, null);
  check('統計タイルが4枚', doc.querySelectorAll('.stat').length === 4,
        doc.querySelectorAll('.stat').length);
  check('ジャンル別の内訳がある', doc.querySelectorAll('.bar-row').length === 6,
        doc.querySelectorAll('.bar-row').length);
  check('最終更新は収集した時刻を出す（HTMLを組んだ時刻ではない）',
        doc.querySelector('.updated .stat-value').textContent.trim()
          === JSON.parse(doc.getElementById('summary-data').textContent).updatedAt,
        doc.querySelector('.updated .stat-value').textContent);
}

console.log('--- 8. 件数上限に当たった版 ---');
{
  const trimmed = fs.readFileSync(process.env.SCRATCH + '/preview_trimmed.html', 'utf8');
  const d2 = new JSDOM(trimmed, { runScripts: 'dangerously' });
  check('3件に絞られている', d2.window.document.querySelectorAll('.card').length === 3,
        d2.window.document.querySelectorAll('.card').length);
}

console.log('--- 9. 他人由来の値が HTML として解釈されないこと ---');
{
  const hostile = fs.readFileSync(process.env.SCRATCH + '/preview_hostile.html', 'utf8');
  const d3 = new JSDOM(hostile, { runScripts: 'dangerously' });
  const w3 = d3.window;
  check('埋め込まれたスクリプトが実行されていない', w3.__pwned === undefined, w3.__pwned);
  // データ埋め込み（type="application/json"）に文字列が入るのは正しい動作。
  // 見るべきは「実行されるスクリプトに紛れ込んでいないか」と
  // 「生のHTMLにエスケープされていない <script> が残っていないか」の2つ。
  const runnable = [...d3.window.document.querySelectorAll('script')]
    .filter((s) => !s.type || s.type === 'text/javascript');
  check('実行されるスクリプトが1つある（この検証が空回りしていないこと）',
        runnable.length >= 1, runnable.length);
  check('実行されるスクリプトに注入文字列が現れない',
        runnable.every((s) => !/__pwned/.test(s.textContent)), null);
  check('生のHTMLにエスケープされていない script タグが残っていない',
        !/<script>window\.__pwned/.test(hostile), null);
  const card = [...d3.window.document.querySelectorAll('.card')]
    .find(c => /evil/.test(c.textContent));
  check('意地悪なリールのカードが存在する（この検証が空回りしていないこと）',
        card !== undefined, null);
  check('ユーザー名は文字として表示される',
        /evil"><script>/.test(card.querySelector('.user').textContent),
        card.querySelector('.user').textContent);
  check('ユーザー名の中に要素が作られていない',
        card.querySelector('.user').children.length === 0,
        card.querySelector('.user').innerHTML);
  check('javascript: のリンクは href を持たない',
        card.querySelector('a.link') === null,
        card.querySelector('a.link') && card.querySelector('a.link').getAttribute('href'));
  check('キャプションも文字として表示される',
        card.querySelector('.caption').children.length === 0,
        card.querySelector('.caption').innerHTML);

  check('数値フィールドに文字列が入っても要素が作られない',
        d3.window.document.querySelectorAll('img').length === 0,
        [...d3.window.document.querySelectorAll('img')].map(e => e.outerHTML));
  const inj = [...d3.window.document.querySelectorAll('.card')]
    .find(c => /count_injection/.test(c.textContent));
  check('数値注入のカードが存在する（この検証が空回りしていないこと）',
        inj !== undefined, null);
  check('数値でない再生数は — と出る', /再生 —/.test(inj.textContent), inj.textContent);
  check('負のコメント数も — と出る', /コメント —/.test(inj.textContent), inj.textContent);
}

console.log(`\n結果: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
