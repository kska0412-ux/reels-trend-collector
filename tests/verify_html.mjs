/**
 * 生成した HTML を jsdom で実際に動かし、絞り込みと並び替えが機能するか検証する。
 * 通信もブラウザも使わない（jsdom はローカルの DOM 実装）。
 *
 * 画面の作りは Threads Research Tool と揃えてある:
 *   ジャンルのタブは置かず、検索窓に語を打って探す（2026-09-28 から）
 *   検索窓をタップすると収集ジャンルの候補が出る。並び替えと期間は select
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
const ROWS0 = JSON.parse(doc.getElementById('data').textContent);
const CFG = JSON.parse(
  fs.readFileSync(new URL('../config/genres.json', import.meta.url), 'utf8'));
const q0 = doc.getElementById('q');
const search = (v) => { q0.value = v; fire(q0, 'input'); };
const users = () => cards().map(c => c.querySelector('.user').textContent.replace('@', ''));

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

console.log('--- 3. ジャンルのタブは出さない ---');
{
  check('ジャンルのチップ列が無い', doc.getElementById('genres') === null, null);
  check('掛け合わせのチップ列が無い', doc.getElementById('modifiers') === null, null);
  check('チップが1つも無い', doc.querySelectorAll('.chip').length === 0, null);
  check('ジャンル別の棒が無い', doc.querySelectorAll('.bar-row').length === 0, null);
  const declared = Number((doc.querySelector('.ver').textContent.match(/(\d+)ジャンル/) || [])[1]);
  check('見出しが設定のジャンル数を名乗る', declared === Object.keys(CFG.genres).length,
        { declared, config: Object.keys(CFG.genres).length });
  check('見出しの次が検索窓', doc.querySelector('header').nextElementSibling.classList.contains('controls'),
        doc.querySelector('header').nextElementSibling.className);
}

console.log('--- 4. 語で検索する ---');
{
  const all = n();
  // ジャンル名で探すと、そのジャンルで集めたリール＋キャプションにその語を含むリール
  const g = ROWS0.find(r => r.genres.length)?.genres[0];
  const want = ROWS0.filter(r => r.genres.includes(g) || (r.text + ' ' + r.username).includes(g)).length;
  search(g);
  check(`ジャンル名「${g}」でジャンル＋キャプション一致`, n() === want && n() > 0 && n() < all,
        { got: n(), want, all });
  check('残ったカードは全部そのジャンルか、キャプションにその語を持つ',
        cards().every(c => [...c.querySelectorAll('.tag')].some(t => t.textContent === g) ||
                           c.querySelector('.text').textContent.includes(g)), null);
  // ひらがなでもジャンルに当たる（カタカナのジャンル名をひらがなにして打つ）
  const kataGenre = Object.keys(CFG.genres).find(x => /^[ァ-ヶー]+$/.test(x) &&
                                                    ROWS0.some(r => r.genres.includes(x)));
  const hira = kataGenre.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  search(kataGenre); const kataN = n();
  search(hira);
  check(`ひらがな「${hira}」でもジャンル「${kataGenre}」に当たる`, n() === kataN && n() > 0, [n(), kataN]);
  check('ヒントにジャンル名が出る', doc.getElementById('hint').textContent.includes('「' + kataGenre + '」'),
        doc.getElementById('hint').textContent);
  // 空白区切りはAND。キャプション固有の語と組み合わせる
  const one = ROWS0.find(r => /その1。/.test(r.text));
  search(one.genres[0] + ' その1。');
  check('空白区切りはAND', n() === 1 && users()[0] === one.username, users());
  search(one.genres[0] + '　その1。');
  check('全角空白でも区切れる', n() === 1, users());
  // 掛け合わせ語（経営など）も検索語として効く。候補には出さない
  const mod = Object.keys(CFG.modifiers).find(m => ROWS0.some(r => (r.mods || []).includes(m)));
  if (mod) {
    const wantMod = ROWS0.filter(r => (r.mods || []).includes(mod) ||
                                     (r.text + ' ' + r.username).includes(mod)).length;
    search(mod);
    check(`掛け合わせ語「${mod}」でも絞れる`, n() === wantMod && n() > 0, { got: n(), wantMod });
  } else {
    check('掛け合わせ語のデータがフィクスチャにある', false, null);
  }
  search('');
  check('空欄に戻すと全件', n() === all, n());
  check('空欄のヒントは全ジャンルの案内', doc.getElementById('hint').textContent.includes('全ジャンル'),
        doc.getElementById('hint').textContent);

  // 「検索」ボタン/Enter でページが再読み込みされない
  const form = doc.getElementById('search');
  q0.value = g;
  const ev = new win.Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(ev);
  check('送信してもページ遷移しない', ev.defaultPrevented, null);
  check('送信で検索が効く', n() === want, n());
  search('');

  // ?q= 付きで開くと、その語で検索した状態から始まる
  const urlDom = new JSDOM(html, { runScripts: 'dangerously',
    url: 'https://example.com/reels-trend-collector/?q=' + encodeURIComponent(g) });
  const ud = urlDom.window.document;
  check('?q= の語で検索した状態で開く',
        ud.getElementById('q').value === g && ud.querySelectorAll('.card').length === want,
        { q: ud.getElementById('q').value, n: ud.querySelectorAll('.card').length, want });
  const uq = ud.getElementById('q');
  uq.value = 'その1。'; uq.dispatchEvent(new urlDom.window.Event('input', { bubbles: true }));
  check('入力するとURLの ?q= も変わる',
        new urlDom.window.URL(urlDom.window.location.href).searchParams.get('q') === 'その1。',
        urlDom.window.location.href);
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

console.log('--- 8. 集計タイルと最終収集の行は出さない ---');
{
  check('集計パネルが無い', doc.querySelector('.summary') === null && doc.querySelectorAll('.stat').length === 0, null);
  check('最終収集の行が無い', doc.getElementById('stamp') === null && !doc.body.textContent.includes('最終収集'), null);
  // doctype が無いと互換モードで描かれ、アプリ内ブラウザで崩れる原因になる
  check('標準モードで描かれる（doctype あり）', doc.compatMode === 'CSS1Compat', doc.compatMode);
  check('言語が日本語', doc.documentElement.getAttribute('lang') === 'ja', null);
  // LINE のアプリ内ブラウザが古い版を出し続けないよう、取り直しを求める
  check('キャッシュしない指定がある',
        !!doc.querySelector('meta[http-equiv="Cache-Control"][content*="no-cache"]'), null);
}

console.log('--- 9. 件数上限に当たった版 ---');
{
  const trimmed = fs.readFileSync(process.env.SCRATCH + '/preview_trimmed.html', 'utf8');
  const d2 = new JSDOM(trimmed, { runScripts: 'dangerously' });
  check('3件に絞られている', d2.window.document.querySelectorAll('.card').length === 3,
        d2.window.document.querySelectorAll('.card').length);
  check('蓄積件数の行は出さない', !d2.window.document.body.textContent.includes('蓄積'), null);
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

console.log('--- 11. 入力候補（スマホでも出る自前の一覧） ---');
{
  const box = doc.getElementById('genre-suggest');
  const items = [...box.querySelectorAll('.suggest-item')];
  const names = items.map(li => li.textContent);
  const shown = () => items.filter(li => !li.hidden).map(li => li.textContent);
  // <datalist> は iPhone の Safari などで一覧が出ないので使わない
  check('datalist を使っていない', doc.querySelector('datalist') === null && !q0.hasAttribute('list'), null);
  check('設定のジャンルが設定の順で全部並ぶ',
        JSON.stringify(names) === JSON.stringify(Object.keys(CFG.genres)), names);
  check('掛け合わせ語は候補に出さない', !names.some(x => x in CFG.modifiers), null);
  check('依頼の新ジャンルが候補に入る',
        ['リラク', 'まつ毛パーマ', '腸もみ', 'シミ', 'ハーブピーリング', '姿勢'].every(x => names.includes(x)), names);
  // 前の節で検索語を打っているので、いったんフォーカスを外して閉じた状態から始める
  q0.dispatchEvent(new win.FocusEvent('blur'));
  check('フォーカスが無ければ閉じている', box.hidden === true, box.hidden);
  q0.dispatchEvent(new win.FocusEvent('focus'));
  check('タップ（フォーカス）で開く', box.hidden === false && q0.getAttribute('aria-expanded') === 'true', null);
  check('空欄なら全ジャンルが出る', shown().length === names.length, shown().length);
  q0.value = 'ねいる'; fire(q0, 'input');
  check('打ちかけの語で絞る（ひらがなでも当たる）',
        shown().join('/') === 'ネイル/ジェルネイル/マグネットネイル', shown());
  q0.value = 'ざざざ'; fire(q0, 'input');
  check('当たる候補が無ければ閉じる', box.hidden === true, shown());
  const one = ROWS0.find(r => /その1。/.test(r.text));
  q0.value = 'その1。 ' + one.genres[0].slice(0, 2); fire(q0, 'input');
  const item = items.find(li => li.textContent === one.genres[0]);
  const md = new win.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  item.dispatchEvent(md);
  check('押した瞬間はフォーカスを動かさない', md.defaultPrevented, null);
  item.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  check('選ぶと最後の語が置き換わる', q0.value === 'その1。 ' + one.genres[0], q0.value);
  check('選ぶと閉じる', box.hidden === true, box.hidden);
  check('選ぶと検索が効く', n() === 1 && users()[0] === one.username, users());
  q0.dispatchEvent(new win.FocusEvent('blur'));
  check('外をタップすると閉じる', box.hidden === true, box.hidden);
  // アプリ内ブラウザでは focus が来ないことがあるので、タップ（click）でも開く
  click(q0);
  check('タップだけでも開く', box.hidden === false, box.hidden);
  q0.dispatchEvent(new win.FocusEvent('blur'));
  // キーボード操作（PC）
  q0.value = ''; fire(q0, 'input');
  q0.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  const ent = new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  q0.dispatchEvent(ent);
  check('↓とEnterで先頭の候補に決まる', q0.value === names[0] && ent.defaultPrevented, q0.value);
  q0.dispatchEvent(new win.FocusEvent('focus'));
  q0.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escで閉じる', box.hidden === true, box.hidden);
  // 変換中の Enter では候補を決めない
  q0.value = ''; fire(q0, 'input');
  q0.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  q0.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }));
  check('変換確定のEnterでは決めない', q0.value === '', q0.value);
  q0.dispatchEvent(new win.FocusEvent('blur'));
  check('候補を閉じて全件に戻る', box.hidden === true && n() === ROWS0.length, [box.hidden, n()]);
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
