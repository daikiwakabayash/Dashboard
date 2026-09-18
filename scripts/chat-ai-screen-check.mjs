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

// ── 観測1: ルーム選択肢は名前か、内部IDか ────────────────────────────
const opts = await page.$$eval('select option', els => els.map(e => ({ value: e.value, label: e.textContent.trim() })));
const roomOpts = opts.filter(o => o.value);
console.log('ルーム選択肢:', JSON.stringify(roomOpts));
console.log('→ 名前で選べるか:', roomOpts.length && roomOpts.every(o => o.label !== o.value) ? '✅ 名前' : '❌ 内部IDのまま');

const faqLine = await page.locator('text=許可FAQ').first().textContent().catch(() => '');
console.log('許可資料の表示:', (faqLine || '').trim());
console.log('→ タイトルで表示か:', /家族施術制度|シフト提出ルール/.test(faqLine || '') ? '✅ タイトル' : '❌ IDの羅列');

// ── 観測2: 同じ質問を2回「新しく送信」したときの request_id ──────────
await page.selectOption('select', roomOpts[0].value);
await page.waitForTimeout(400);
const ask = async (q) => {
  await page.fill('textarea', q);
  await page.locator('button', { hasText: 'AIに質問する' }).first().click();
  await page.waitForTimeout(1200);
};
await ask('家族施術のルールは？');
await ask('家族施術のルールは？');       // 人が意図的にもう一度送る（新しい送信）

const asks = calls.filter(c => c.body && c.body.type === 'chatai' && c.body.action === 'ask');
console.log('送信された ask:', asks.length, '件');
console.log('request_id:', asks.map(a => a.body.request_id).join(' , '));
const ids = new Set(asks.map(a => a.body.request_id));
console.log('→ 新しい送信ごとに新しいID:', asks.length >= 2 && ids.size === asks.length ? '✅' : '❌ 同じIDが再利用されている（新しい回答を作れない）');

// ── 観測3: 失敗 → 再試行のときに同じ request_id を使うか ──────────────
await ask('失敗テストの質問');                      // 1回目は必ず失敗する
const btns = await page.$$eval('button', els => els.map(e => (e.textContent || '').trim()).filter(Boolean));
const retryBtn = btns.filter(t => /再試行|もう一度|リトライ/.test(t));
console.log('失敗後に出るボタン:', retryBtn.length ? retryBtn.join(' / ') : '（再試行ボタンなし）');
const before = calls.filter(c => c.body && c.body.action === 'ask').length;
if (retryBtn.length) await page.locator('button', { hasText: retryBtn[0] }).first().click();
else await page.locator('button', { hasText: 'AIに質問する' }).first().click();   // 画面にある操作でやり直す
await page.waitForTimeout(1200);
const retried = calls.filter(c => c.body && c.body.action === 'ask').slice(before - 1);
console.log('失敗した送信 → やり直しの request_id:', retried.map(a => a.body.request_id).join(' , '));
console.log('→ 同じ送信の再試行で同じID:', retried.length >= 2 && retried[0].body.request_id === retried[1].body.request_id ? '✅' : '❌ 別IDになる（同じ送信のやり直しが新規送信になる）');

// 画面に回答カードが何枚できたか
const cards = await page.locator('article').count();
console.log('回答カード数:', cards, asks.length >= 2 && cards >= 2 ? '✅ 2件目も作られた' : '❌ 2件目が作られない');

await page.screenshot({ path: `${OUT}/prod-screen.png`, fullPage: true });
console.log(errors.length ? 'ERRORS:\n' + errors.slice(0, 5).join('\n') : 'NO PAGE ERRORS ✅');
await browser.close(); server.close();
