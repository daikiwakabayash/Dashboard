// ── 通常チャット入力欄からの @AI を、実際の画面で確かめる ──────────────────
// ⚠️ 本番には接続しません。ローカルのスタブAPI（chat-ai-screen-stub.mjs）に対して
//    本物の index.html を headless Chromium で動かします。
// 使い方は scripts/chat-ai-screen-check.mjs と同じ（CDN_DIR / OUT_DIR / PLAYWRIGHT_PATH）。
//
// 見るところ:
//   ・検証Roomで「🤖 AIに質問」を押すと ?type=chatai へ行く（従来の /api/chat ではない）
//   ・新しい送信ごとに新しい request_id
//   ・検証Room以外では従来の経路のまま（勝手に新経路へ変えない）
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');
import fs from 'node:fs';
import { start, calls, reset } from './chat-ai-screen-stub.mjs';

const OUT = process.env.OUT_DIR || '/tmp';
const CDN = process.env.CDN_DIR || '/tmp/cdn';
const server = await start(8961);
reset();

const browser = await chromium.launch();
const ctx = await browser.newContext({ serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text().slice(0, 160)); });

const local = (f) => ({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(f) });
await page.route(/.*/, r => (r.request().url().startsWith('http://127.0.0.1:8961')
  ? r.continue() : r.fulfill({ status: 200, contentType: 'text/javascript', body: '' })));
await page.route(/cdn\.tailwindcss\.com/, r => r.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.tailwind={config:{}};' }));
await page.route(/@vercel\/blob/, r => r.fulfill({ status: 200, contentType: 'text/javascript', body: 'export const upload = async () => ({ url: "" }); export default { upload };' }));
await page.route(/react-dom/, r => r.fulfill(local(`${CDN}/react-dom.js`)));
await page.route(/libs\/react\//, r => r.fulfill(local(`${CDN}/react.js`)));
await page.route(/babel(\.min)?\.js/, r => r.fulfill(local(`${CDN}/babel.js`)));

page.setDefaultTimeout(60000);
await page.goto('http://127.0.0.1:8961/', { waitUntil: 'commit', timeout: 60000 });
// 開発モードなら自動で入る。ログイン画面が出たら入力する。
try {
  await page.waitForFunction(() => /オーナー設定/.test(document.body.innerText), { timeout: 25000 });
} catch {
  const pw = page.locator('input[type="password"]').first();
  if (await pw.count()) {
    await page.locator('input[type="text"]').first().fill('root').catch(() => {});
    await pw.fill('stub-password').catch(() => {});
    await page.locator('button', { hasText: 'ログイン' }).first().click().catch(() => {});
  }
  await page.waitForFunction(() => /オーナー設定/.test(document.body.innerText), { timeout: 45000 });
}
await page.waitForTimeout(2500);

const R = [];
const rec = (n, label, ok, note) => { R.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}. ${label}${note ? ` — ${note}` : ''}`); };
const aiCalls = () => calls.filter(c => c.body && c.body.type === 'chatai' && c.body.action === 'ask');
const legacyCalls = () => calls.filter(c => c.path === '/api/chat');

// チャットタブ → 検証Room
await page.locator('button', { hasText: 'チャット' }).first().click();
await page.waitForTimeout(1500);
const room = page.locator('text=本部/root 検証ルーム（試用）').first();
rec('A', 'チャットに検証Roomが出る', (await room.count()) > 0);
await room.click();
await page.waitForTimeout(1200);

console.log('チャット画面の呼び出し:', JSON.stringify(calls.filter(c => c.path === '/api/plan-store').map(c => `${c.method}:${(c.body && c.body.type) || c.query.type || ''}:${(c.body && c.body.action) || c.query.action || ''}`).slice(-8)));
console.log('textarea 数:', await page.locator('textarea').count(), '／ 入力欄のAIボタン:', await page.locator('button[title^="この内容をAIに質問"]').count());
const ta = page.locator('textarea').first();
// ⚠️ サイドバーにも「🤖AIに質問」タブがあるので、入力欄のボタンを title で特定する
const aiBtn = page.locator('button[title^="この内容をAIに質問"]').first();
const ask = async (q) => {
  await ta.click();
  await ta.fill(q);
  await page.waitForTimeout(600);                       // state 反映（ボタンの活性化）を待つ
  const disabled = await aiBtn.isDisabled().catch(() => null);
  if (disabled) console.log('   （AIに質問ボタンが無効のままです）');
  await aiBtn.click({ force: true }).catch(e => console.log('   click err:', String(e).split('\n')[0]));
  await page.waitForTimeout(1800);
};
console.log('検証Roomの一覧:', await page.evaluate(() => {
  try { return document.body.innerText.includes('本部/root 検証ルーム') ? 'あり' : 'なし'; } catch { return '?'; }
}));

let n0 = aiCalls().length;
await ask('家族施術のルールは？');
const first = aiCalls().slice(n0);
rec(1, '検証Roomの @AI は ?type=chatai へ行く', first.length === 1,
  first.length ? `room_id=${first[0].body.room_id} request_id=${first[0].body.request_id}` : '呼ばれていない');
rec(2, '従来の /api/chat は使わない', legacyCalls().length === 0, `/api/chat 呼び出し ${legacyCalls().length} 回`);

n0 = aiCalls().length;
await ask('家族施術のルールは？');
const second = aiCalls().slice(n0);
rec(3, '新しい送信には新しい request_id',
  second.length === 1 && first.length === 1 && second[0].body.request_id !== first[0].body.request_id,
  second.length ? `${first[0].body.request_id} → ${second[0].body.request_id}` : '呼ばれていない');

const txt = await page.locator('body').innerText();
rec(4, '回答が同じRoomに表示される', (txt.match(/サンプル回答/g) || []).length >= 2,
  `「サンプル回答」${(txt.match(/サンプル回答/g) || []).length} 件`);

// 検証対象ではないRoomでは従来の経路のまま
const other = page.locator('text=検証対象ではないルーム').first();
if (await other.count()) await other.click({ timeout: 15000 }).catch(() => {});
else console.log('   （検証対象ではないルームが一覧に出ていません）');
await page.waitForTimeout(1200);
n0 = aiCalls().length;
const n1 = legacyCalls().length;
await ask('ここでは従来どおり');
rec(5, '検証Room以外は新経路に変えない', aiCalls().length - n0 === 0 && legacyCalls().length - n1 >= 0,
  `chatai ${aiCalls().length - n0} 回 / 従来 ${legacyCalls().length - n1} 回`);

console.log('全呼び出し:', JSON.stringify(calls.map(c => `${c.method}:${c.path}:${(c.body && c.body.type) || c.query.type || ''}:${(c.body && c.body.action) || c.query.action || ''}`).slice(-14), null, 0));
await page.screenshot({ path: `${OUT}/chat-composer.png`, fullPage: true });
console.log(`\n合格 ${R.filter(r => r.ok).length} / ${R.length}`);
console.log(errors.length ? 'ERRORS:\n' + errors.slice(0, 4).join('\n') : 'NO PAGE ERRORS ✅');
await browser.close(); server.close();
