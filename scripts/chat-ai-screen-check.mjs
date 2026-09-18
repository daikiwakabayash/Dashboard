// ── 本番画面（index.html「@AI 検証」）の画面レベル検証 ───────────────────
// ライブラリ単体ではなく、**実際の画面が何を送るか**をネットワーク越しに観測する。
// ⚠️ 本番には一切つながりません。ローカルのスタブAPI（chat-ai-screen-stub.mjs）に対して
//    本物の index.html を headless Chromium で動かすだけです。
//
// 使い方:
//   1) react / react-dom / babel を CDN_DIR に置く（ネットワークに依存させないため）
//        curl -sSo $CDN_DIR/react.js     https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js
//        curl -sSo $CDN_DIR/react-dom.js https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js
//        curl -sSo $CDN_DIR/babel.js     https://unpkg.com/@babel/standalone@7.26.10/babel.min.js
//   2) CDN_DIR=<dir> OUT_DIR=<dir> PLAYWRIGHT_PATH=<...>/node_modules/playwright/index.mjs \
//        node scripts/chat-ai-screen-check.mjs
//      （playwright はリポジトリの依存に入れていません＝npm test には影響しません）
//
// 見るところ:
//   ・検証ルーム／許可資料が **名前** で選べるか（内部IDの手入力になっていないか）
//   ・同じ質問を**別々に新規送信**したとき、**新しい request_id** が送られるか
//     （同じIDが再利用されると、2件目の回答が作られない）
// playwright はリポジトリの依存に入れていないので、置き場所を PLAYWRIGHT_PATH で渡す
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');
import fs from 'node:fs';
import { start, calls, reset } from './chat-ai-screen-stub.mjs';

// 外部CDNのローカル控え（react / react-dom / babel）。CDN_DIR で場所を指定する。
const OUT = process.env.OUT_DIR || process.env.SD || '/tmp';
const CDN = process.env.CDN_DIR || `${process.env.SD || '/tmp'}/cdn`;
const server = await start(8961);
reset();

const browser = await chromium.launch();
const ctx = await browser.newContext({ serviceWorkers: 'block' });   // SWのバッジAPIでレンダラが落ちるため
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 200)); });

// 外部CDNはローカルへ差し替え（ネットワークに依存させない）
// ⚠️ Playwright は後から登録した route を先に評価する → catch-all を最初に登録する
const local = (f) => ({ status:200, contentType:'text/javascript', body: fs.readFileSync(f) });
await page.route(/.*/, route => {
  const u = route.request().url();
  if (u.startsWith('http://127.0.0.1:8961')) return route.continue();
  return route.fulfill({ status:200, contentType:'text/javascript', body:'' });
});
await page.route(/cdn\.tailwindcss\.com/, r => r.fulfill({ status:200, contentType:'text/javascript', body:'window.tailwind={config:{}};' }));
await page.route(/@vercel\/blob/,          r => r.fulfill({ status:200, contentType:'text/javascript', body:'export const upload = async () => ({ url: "" }); export default { upload };' }));
await page.route(/react-dom/,               r => r.fulfill(local(`${CDN}/react-dom.js`)));
await page.route(/libs\/react\//,          r => r.fulfill(local(`${CDN}/react.js`)));
await page.route(/babel(\.min)?\.js/,      r => r.fulfill(local(`${CDN}/babel.js`)));

await page.goto('http://127.0.0.1:8961/?tab=aitrial', { waitUntil: 'commit', timeout: 60000 });
await page.waitForTimeout(3500);          // Babel でのコンパイルを待つ

// ログイン（スタブは root として認証する）
// ログイン画面が出たら入力し、ダッシュボードが描画されるまで待つ
//（開発モード＝パスワード未設定なら自動で入るので、その場合は待つだけ）
try {
  await page.waitForFunction(() => /オーナー設定/.test(document.body.innerText), { timeout: 20000 });
} catch {
  const pw = page.locator('input[type="password"]').first();
  if (await pw.count()) {
    await page.locator('input[type="text"]').first().fill('root').catch(() => {});
    await pw.fill('stub-password').catch(() => {});
    await page.locator('button', { hasText: 'ログイン' }).first().click().catch(() => {});
  }
  await page.waitForFunction(() => /オーナー設定/.test(document.body.innerText), { timeout: 30000 });
}
await page.waitForTimeout(2000);
console.log('画面の見出し:', (await page.$$eval('h1', e => e.map(x => x.textContent.trim()).slice(0,5))).join(' / '));
console.log('ログイン後の画面:', (await page.title()) || '(no title)');

// 「@AI 検証」タブへ
console.log('認証状態:', await page.evaluate(() => ({ root: localStorage.getItem('naoru_auth_root'), token: !!localStorage.getItem('naoru_auth_token') })));
const labels = await page.$$eval('button, a', els => els.map(e => (e.textContent || '').trim()).filter(t => t && t.length < 24));
console.log('ナビ候補:', [...new Set(labels)].slice(0, 40).join(' | '));
const nav = page.locator('button', { hasText: '@AI 検証' }).first();
console.log('@AI 検証 ボタン:', await nav.count());
if (await nav.count()) { await nav.click({ force: true }); await page.waitForTimeout(1500); }
const onScreen = await page.locator('h1', { hasText: '@AI 検証' }).count();
console.log('@AI 検証 画面:', onScreen ? '表示 ✅' : '出せず ❌');
if (!onScreen) {
  console.log('errors:', errors.slice(0, 5).join(' | '));
  await page.screenshot({ path: `${OUT}/prod-screen-fail.png`, fullPage: true });
  await browser.close(); server.close(); process.exit(1);
}

// ── 必須確認 7項目 ────────────────────────────────────────────────────
const R = [];            // [{ n, label, ok, note }]
const rec = (n, label, ok, note) => { R.push({ n, label, ok, note }); console.log(`${ok ? '✅' : '❌'} ${n}. ${label}${note ? ` — ${note}` : ''}`); };
const asks = () => calls.filter(c => c.body && c.body.type === 'chatai' && c.body.action === 'ask');
const cards = () => page.locator('article').count();
const askBtn = () => page.locator('button', { hasText: 'AIに質問する' }).first();
const retryBtn = () => page.locator('button', { hasText: /再試行|もう一度|やり直/ }).first();
const send = async (q) => { await page.fill('textarea', q); await askBtn().click(); await page.waitForTimeout(1200); };

// 選択（観測A: ルーム名・資料タイトル）
const opts = await page.$$eval('select option', els => els.map(e => ({ value: e.value, label: e.textContent.trim() })));
const roomOpts = opts.filter(o => o.value);
console.log('ルーム選択肢:', JSON.stringify(roomOpts));
const faqLine = ((await page.locator('text=許可FAQ').first().textContent().catch(() => '')) || '').trim();
console.log('許可資料:', faqLine);
rec('A', 'ルームを名前で選べる', roomOpts.length > 0 && roomOpts.every(o => o.label !== o.value));
rec('B', '資料をタイトルで表示', /家族施術制度|シフト提出ルール/.test(faqLine));
await page.selectOption('select', roomOpts[0].value);
await page.waitForTimeout(400);

// 5. 新規送信では新しいIDになる（同じ本文でも別の依頼）
let n0 = asks().length;
await send('家族施術のルールは？');
await send('家族施術のルールは？');
const two = asks().slice(n0);
rec(5, '新規送信では新しいIDになる',
  two.length === 2 && two[0].body.request_id !== two[1].body.request_id,
  two.map(a => a.body.request_id).join(' , '));
rec('C', '同じ質問でも2件目の回答が作られる', (await cards()) >= 2, `回答カード ${await cards()} 件`);

// 1〜3. 失敗 → 再試行（表示・ID・質問/Room の維持）
n0 = asks().length;
await send('失敗テストの質問');
const hasRetry = (await retryBtn().count()) > 0;
rec(1, '失敗後に「同じ送信を再試行」が表示される', hasRetry,
  hasRetry ? (await retryBtn().textContent()).trim() : '再試行ボタンなし');
if (hasRetry) await retryBtn().click(); else await askBtn().click();   // 画面にある操作でやり直す
await page.waitForTimeout(1400);
const pair = asks().slice(n0);
const same = pair.length >= 2 && pair[0].body.request_id === pair[1].body.request_id;
rec(2, 'クリックしても request_id が変わらない', same, pair.map(a => a.body.request_id).join(' , '));
rec(3, '元の質問と Room が維持される',
  pair.length >= 2 && pair[0].body.question === pair[1].body.question && pair[0].body.room_id === pair[1].body.room_id,
  pair.length >= 2 ? `${pair[1].body.question} / ${pair[1].body.room_id}` : '—');

// 4. サーバー保存後の応答消失でも回答が増えない
const before4 = await cards();
n0 = asks().length;
await send('応答消失テストの質問');            // サーバーは保存済み・応答だけ届かない
if ((await retryBtn().count()) > 0) await retryBtn().click(); else await askBtn().click();
await page.waitForTimeout(1400);
const after4 = await cards();
rec(4, 'サーバー保存後の応答消失でも回答が増えない', after4 - before4 === 1,
  `回答カード ${before4} → ${after4}（+${after4 - before4}）`);

// 6. 権限エラー等を再試行し続けない
n0 = asks().length;
await send('権限テストの質問');
const retryShown = (await retryBtn().count()) > 0;
await page.waitForTimeout(2500);               // 自動で再送していないか見る
const autoRetries = asks().length - n0 - 1;
rec(6, '権限エラー等を再試行し続けない', autoRetries === 0 && !retryShown,
  `自動再送 ${autoRetries} 回 / 再試行ボタン ${retryShown ? '出ている（再試行できない失敗なので出さない）' : '出ていない'}`);

// 7. 二重クリックで送信が増えない
n0 = asks().length;
await page.fill('textarea', '二重クリックの確認');
await Promise.all([askBtn().click(), askBtn().click().catch(() => {})]);
await page.waitForTimeout(1500);
rec(7, '二重クリックで送信が増えない', asks().length - n0 === 1, `送信 ${asks().length - n0} 回`);

console.log('\n──── 判定 ────');
console.log(R.map(r => `${r.ok ? '合格' : '不合格'} ${r.n}. ${r.label}`).join('\n'));
console.log(`合格 ${R.filter(r => r.ok).length} / ${R.length}`);

await page.screenshot({ path: `${OUT}/prod-screen.png`, fullPage: true });
console.log(errors.length ? 'ERRORS:\n' + errors.slice(0, 5).join('\n') : 'NO PAGE ERRORS ✅');
await browser.close(); server.close();
