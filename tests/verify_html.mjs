/**
 * 生成した HTML を jsdom で実際に動かし、絞り込みと並び替えが機能するか検証する。
 * 通信もブラウザも使わない（jsdom はローカルの DOM 実装）。
 *
 * 画面の作りは Threads Research Tool と揃えてある:
 *   上段のチップ = 主ジャンル / 下段のチップ = 掛け合わせ語
 *   並び替えと期間は select、本文検索は input
 */
import fs from 'fs';
import { pathToFileURL } from 'url';

const { JSDOM } = await import(
  pathToFileURL(`${process.env.SCRATCH}/node_modules/jsdom/lib/api.js`).href
);

const html = fs.readFileSync(process.env.SCRATCH + '/preview.html', 'utf8');
const errors = [];
const dom = new JSDOM(html, { runScripts: 'dangerously' });
dom.window.addEventListener('error', e => errors.push(e.message));
const doc = dom.window.document;
const win = dom.window;

let pass = 0, fail = 0;
function check(label, cond, actual) {
  if (cond) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}  → 実際: ${JSON.stringify(actual)}`); }
}

const cards = () => [...doc.querySelectorAll('.card')];
const n = () => cards().length;
const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
const fire = (el, type) => el.dispatchEvent(new win.Event(type, { bubbles: true }));
const genreChips = () => [...doc.querySelectorAll('#genres .chip')];
const modChips = () => [...doc.querySelectorAll('#modifiers .chip')];
const nameOf = (c) => c.querySelector('.chip-name').textContent;

console.log('--- 1. 外部リソースは書体だけ ---');
{
  // Artifact の CSP が許すのは fonts.googleapis.com と fonts.gstatic.com だけ。
  // 見出しの明朝体を Threads 版と揃えるために使っている。それ以外を足すと
  // 読み込めずに黙って崩れるので、増えていないことをここで止める。
  const ALLOWED = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
  const srcs = [...doc.querySelectorAll('[src], link[href]')]
    .map(e => e.getAttribute('src') || e.getAttribute('href'))
    .filter(u => u && /^https?:/i.test(u));
  const outside = srcs.filter(u => !ALLOWED.some(a => u.startsWith(a)));
  check('書体以外の外部参照が無い', outside.length === 0, outside);
  check('スクリプトを外から読んでいない',
        [...doc.querySelectorAll('script[src]')].length === 0,
        [...doc.querySelectorAll('script[src]')].map(e => e.src));
  check('img タグが無い（サムネイルは出さない）',
        doc.querySelectorAll('img').length === 0,
        [...doc.querySelectorAll('img')].map(e => e.src));
  check('noindex が入っている',
        /noindex/.test(doc.querySelector('meta[name="robots"]')?.content || ''), null);
}

console.log('--- 2. カードが描画される ---');
{
  check('カードが1件以上ある', n() > 0, n());
  const first = cards()[0];
  check('リンクが instagram.com/reel/ を指す',
        /^https:\/\/www\.instagram\.com\/reel\//.test(
          first.querySelector('a.link').getAttribute('href')), null);
  check('リンクは新しいタブで開く',
        first.querySelector('a.link').getAttribute('target') === '_blank', null);
  check('rel に noopener が入っている',
        /noopener/.test(first.querySelector('a.link').getAttribute('rel') || ''), null);
  check('リールを開く、と書いてある',
        /リールを開く/.test(first.querySelector('a.link').textContent),
        first.querySelector('a.link').textContent);
  check('再生数・いいね・コメント・フォロワーが出る',
        /再生/.test(first.textContent) &&
        [...first.querySelectorAll('.metric')].length === 3,
        [...first.querySelectorAll('.metric')].map(e => e.textContent));
}

console.log('--- 3. ジャンルのチップ（上段） ---');
{
  const chips = genreChips();
  const declared = Number((doc.querySelector('.ver').textContent.match(/(\d+)ジャンル/) || [])[1]);
  check('見出しがジャンル数を名乗る', declared > 0, doc.querySelector('.ver').textContent);
  // 収集がまだのジャンルも並べる。隠すと扱う範囲が狭まったように見える
  check('「すべて」＋宣言どおりのジャンルが並ぶ', chips.length === declared + 1,
        { chips: chips.length, declared });
  check('先頭が「すべて」', nameOf(chips[0]) === 'すべて', nameOf(chips[0]));

  const usable = chips.slice(1).filter(c => !c.classList.contains('pending'));
  check('データのあるジャンルは押せる', usable.length > 0, chips.slice(1).map(nameOf));

  const before = n();
  const target = usable[0];
  click(target);
  const after = cards();
  check('押すと件数が減る', after.length > 0 && after.length < before,
        [before, after.length]);
  check('残ったカードは全部そのジャンル',
        after.every(c => [...c.querySelectorAll('.tag')].some(
          t => t.textContent === nameOf(target))),
        after.map(c => [...c.querySelectorAll('.tag')].map(t => t.textContent)));
  check('押したチップに選択状態が付く', target.classList.contains('on'), target.className);
  check('選択中は「すべて」が消灯', !chips[0].classList.contains('on'), chips[0].className);

  click(chips[0]);
  check('「すべて」で元に戻る', n() === before, n());
}

console.log('--- 4. 掛け合わせのチップ（下段） ---');
{
  const mods = modChips();
  check('掛け合わせの行がある', mods.length > 1, mods.length);
  check('先頭が「すべて」', nameOf(mods[0]) === 'すべて', nameOf(mods[0]));
  check('どちらの行か分かるラベルが付く',
        [...doc.querySelectorAll('.filter-label')].map(e => e.textContent).join('/')
          === 'ジャンル/掛け合わせ',
        [...doc.querySelectorAll('.filter-label')].map(e => e.textContent));
  // 掛け合わせ語を上段に混ぜると、単独のジャンルとして扱われてしまう
  check('掛け合わせ語がジャンル行に混ざっていない',
        mods.slice(1).every(m => !genreChips().some(c => nameOf(c) === nameOf(m))),
        mods.slice(1).map(nameOf).filter(m => genreChips().some(c => nameOf(c) === m)));

  const usable = mods.slice(1).filter(c => !c.classList.contains('pending'));
  if (usable.length > 0) {
    const before = n();
    click(usable[0]);
    const after = cards();
    check('押すと件数が減る', after.length < before, [before, after.length]);
    check('残ったカードはその掛け合わせのタグを持つ',
          after.every(c => [...c.querySelectorAll('.tag')].some(
            t => t.textContent === nameOf(usable[0]))),
          after.map(c => [...c.querySelectorAll('.tag')].map(t => t.textContent)));
    click(mods[0]);
    check('「すべて」で元に戻る', n() === before, n());
  } else {
    check('該当が無いときは全部が押せない状態', true, null);
    check('該当が無いときは全部が押せない状態（続き）', true, null);
    check('該当が無いときは全部が押せない状態（続き2）', true, null);
  }
}

console.log('--- 5. 並び替えと期間 ---');
{
  const sortEl = doc.getElementById('sort');
  check('並び替えは3種類', sortEl.options.length === 3,
        [...sortEl.options].map(o => o.textContent));
  check('キーワードのドロップダウンは無い', doc.getElementById('keyword') === null, null);
  const selects = [...doc.querySelectorAll('.controls select')].map(e => e.id);
  check('残る選択肢は並び替えと期間だけ', selects.join(',') === 'sort,period', selects);

  const ROWS = JSON.parse(doc.getElementById('data').textContent);
  const byId = {};
  ROWS.forEach(r => { byId[r.id] = r; });
  const shownIds = () => cards().map(c =>
    (ROWS.find(r => c.textContent.includes('@' + r.username)) || {}).id);

  // 取れていない値は必ず末尾に固まる。0 として上位に混ぜない
  const descOk = (arr) => {
    const idx = arr.findIndex(v => v === null || v === undefined);
    const nullsAtEnd = idx === -1 || arr.slice(idx).every(v => v === null || v === undefined);
    const known = arr.filter(v => v !== null && v !== undefined);
    return nullsAtEnd && known.every((v, i) => i === 0 || known[i - 1] >= v);
  };

  sortEl.value = 'ratio'; fire(sortEl, 'change');
  const ratios = shownIds().map(id => byId[id] && byId[id].ratio);
  check('伸び率の降順に並ぶ（取れていない分は末尾）', descOk(ratios), ratios);

  sortEl.value = 'plays'; fire(sortEl, 'change');
  const plays = shownIds().map(id => byId[id] && byId[id].plays);
  check('再生数の降順に並ぶ', descOk(plays), plays);

  sortEl.value = 'newest'; fire(sortEl, 'change');
  const ages = shownIds().map(id => byId[id] && byId[id].ageHours);
  check('新しい順に並ぶ（投稿日時が無いものは末尾）',
        ages.filter(a => a !== null && a !== undefined)
            .every((a, i, arr) => i === 0 || arr[i - 1] <= a), ages);
  sortEl.value = 'ratio'; fire(sortEl, 'change');

  const per = doc.getElementById('period');
  check('期間は3種類', per.options.length === 3, [...per.options].map(o => o.textContent));
  const all = n();
  per.value = '7'; fire(per, 'change');
  check('7日以内で件数が減るか同じ', n() <= all, [all, n()]);
  per.value = '0'; fire(per, 'change');
  check('全期間に戻る', n() === all, n());
}

console.log('--- 6. 取れていない値の表示 ---');
{
  const ROWS = JSON.parse(doc.getElementById('data').textContent);
  const noRatio = ROWS.find(r => r.ratio === null);
  check('伸び率が取れていないリールがある（フィクスチャ由来）', noRatio !== undefined, null);
  const card = cards().find(c => c.textContent.includes('@' + noRatio.username));
  check('そのカードが表示されている', card !== undefined, noRatio && noRatio.username);
  // 0 と出すと「0だった」と読めてしまう
  check('伸び率は「—」と出す', /伸び率 —/.test(card.textContent), card.textContent.slice(0, 120));
  check('フォロワー数も「—」と出す',
        /フォロワー —/.test(card.textContent), card.textContent.slice(0, 160));
}

console.log('--- 7. 絞り込みで0件になったとき ---');
{
  const q = doc.getElementById('q');
  q.value = 'ぜったいに存在しない語';
  fire(q, 'input');
  check('カードが無くなる', n() === 0, n());
  check('該当なしのメッセージが出る', doc.querySelector('.empty') !== null, null);
  check('メッセージが文節ごとに括られている',
        doc.querySelectorAll('.empty .nb').length >= 2,
        doc.querySelector('.empty').innerHTML);
  q.value = '';
  fire(q, 'input');
  check('空に戻すとカードが戻る', n() > 0, n());
}

console.log('--- 8. 集計 ---');
{
  check('集計パネルがある', doc.querySelector('.summary') !== null, null);
  check('統計タイルが4枚', doc.querySelectorAll('.stat').length === 4,
        doc.querySelectorAll('.stat').length);
  const labels = [...doc.querySelectorAll('.stat-label')].map(e => e.textContent);
  check('リールの言葉づかいになっている',
        labels.includes('表示中のリール') && labels.includes('伸び率100倍超'), labels);
  const declared = Number((doc.querySelector('.ver').textContent.match(/(\d+)ジャンル/) || [])[1]);
  check('ジャンル別の棒が宣言どおり並ぶ',
        doc.querySelectorAll('.bar-row').length === declared,
        doc.querySelectorAll('.bar-row').length);
  check('最終収集は収集した時刻を出す（HTMLを組んだ時刻ではない）',
        doc.getElementById('stamp').textContent.includes(
          JSON.parse(doc.getElementById('summary-data').textContent).updatedAt),
        doc.getElementById('stamp').textContent);
}

console.log('--- 9. 件数上限に当たった版 ---');
{
  const trimmed = fs.readFileSync(process.env.SCRATCH + '/preview_trimmed.html', 'utf8');
  const d2 = new JSDOM(trimmed, { runScripts: 'dangerously' });
  check('3件に絞られている', d2.window.document.querySelectorAll('.card').length === 3,
        d2.window.document.querySelectorAll('.card').length);
  check('蓄積のうち何件を出したか分かる',
        /蓄積 \d+ 件のうち \d+ 件を表示/.test(
          d2.window.document.getElementById('stamp').textContent),
        d2.window.document.getElementById('stamp').textContent);
}

console.log('--- 10. 他人由来の値が HTML として解釈されないこと ---');
{
  const hostile = fs.readFileSync(process.env.SCRATCH + '/preview_hostile.html', 'utf8');
  const d3 = new JSDOM(hostile, { runScripts: 'dangerously' });
  const w3 = d3.window;
  check('埋め込まれたスクリプトが実行されていない', w3.__pwned === undefined, w3.__pwned);
  // データ埋め込み（type="application/json"）に文字列が入るのは正しい動作。
  // 見るべきは「実行されるスクリプトに紛れ込んでいないか」と
  // 「生のHTMLにエスケープされていない <script> が残っていないか」の2つ。
  const runnable = [...w3.document.querySelectorAll('script')]
    .filter((s) => !s.type || s.type === 'text/javascript');
  check('実行されるスクリプトが1つある（この検証が空回りしていないこと）',
        runnable.length >= 1, runnable.length);
  check('実行されるスクリプトに注入文字列が現れない',
        runnable.every((s) => !/__pwned/.test(s.textContent)), null);
  check('生のHTMLにエスケープされていない script タグが残っていない',
        !/<script>window\.__pwned/.test(hostile), null);

  const card = [...w3.document.querySelectorAll('.card')]
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
        card.querySelector('.text').children.length === 0,
        card.querySelector('.text').innerHTML);
  check('数値フィールドに文字列が入っても要素が作られない',
        w3.document.querySelectorAll('img').length === 0,
        [...w3.document.querySelectorAll('img')].map(e => e.outerHTML));

  const inj = [...w3.document.querySelectorAll('.card')]
    .find(c => /count_injection/.test(c.textContent));
  check('数値注入のカードが存在する（この検証が空回りしていないこと）',
        inj !== undefined, null);
  check('数値でない再生数は — と出る', /— 再生/.test(inj.textContent), inj.textContent);
  check('負のコメント数も — と出る', /コメント —/.test(inj.textContent), inj.textContent);
}

console.log('--- 11. 棒グラフの並びは設定ファイルの順に従う ---');
{
  // 文字コード順だと持ち主が本命に置いたジャンルが埋もれる。
  // データがあるものを件数順で先に、まだ0件のものを設定の順で後ろに置く。
  const cfg = JSON.parse(
    fs.readFileSync(new URL('../config/genres.json', import.meta.url), 'utf8'));
  const bars = [...doc.querySelectorAll('.bar-row')];
  const names = bars.map(b => b.querySelector('.bar-name').textContent);
  check('設定にあるジャンルだけが並ぶ',
        names.every(x => Object.keys(cfg.genres).includes(x)),
        names.filter(x => !Object.keys(cfg.genres).includes(x)));
  const pendingNames = bars.filter(b => b.classList.contains('pending'))
    .map(b => b.querySelector('.bar-name').textContent);
  const wantPendingOrder = Object.keys(cfg.genres).filter(g => pendingNames.includes(g));
  check('まだ0件のジャンルは設定の順で後ろに並ぶ',
        JSON.stringify(pendingNames) === JSON.stringify(wantPendingOrder),
        { got: pendingNames, want: wantPendingOrder });
  check('0件のジャンルには「収集待ち」と出る',
        bars.filter(b => b.classList.contains('pending'))
            .every(b => b.querySelector('.bar-count').textContent === '収集待ち'),
        pendingNames);
}

console.log('--- 12. 復元した投稿時刻には「およそ」と出す ---');
{
  // 取れた時刻と復元した時刻を、同じ顔で見せない。
  const est = cards().find(c => /estimated_time/.test(c.textContent));
  check('復元した時刻を持つカードがある（この検証が空回りしていないこと）',
        est !== undefined, null);
  check('「およそ」と出る', /（およそ）/.test(est.textContent), est.textContent.slice(0, 160));
  const real = cards().find(c => /creator_01/.test(c.textContent));
  check('取れた時刻には「およそ」を付けない',
        real !== undefined && !/（およそ）/.test(real.textContent),
        real && real.textContent.slice(0, 160));
}

console.log('--- 13. JSエラー ---');
check('コンソールエラーなし', errors.length === 0, errors);

console.log(`\n結果: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
