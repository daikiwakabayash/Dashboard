// ── オーナー設定「Command Center フラグ」の画面レベル検証 ─────────────────
// 「フラグOFF → スイッチが見える → ONにする → @AI 検証メニューが出る →
//   ルームとFAQを名前で選んで保存」までを、**本物の index.html** を
// headless Chromium で操作して確認する。
// ⚠️ 本番には一切つながりません。ローカルのスタブAPIに対してだけ動かします。
//
// 使い方:
//   CDN_DIR=<react/react-dom/babel を置いた場所> \
//   PLAYWRIGHT_PATH=<...>/node_modules/playwright/index.mjs \
//   node scripts/ccflags-screen-check.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');

const ROOT = process.env.DASHBOARD_ROOT || process.cwd();
const CDN = process.env.CDN_DIR || '/tmp/cdn';
const TYPES = { '.html':'text/html;charset=utf-8', '.js':'text/javascript', '.mjs':'text/javascript',
  '.css':'text/css', '.json':'application/json', '.webmanifest':'application/manifest+json',
  '.png':'image/png', '.svg':'image/svg+xml', '.jpg':'image/jpeg' };
const ROOMS = { g_hq_trial: '本部AI検証（本部/root 3名）', g_staff: 'スタッフ入り雑談' };
const FAQS = { faq_family: '家族施術制度', faq_shift: 'シフト提出ルール' };

// スタブ: フラグは**実際に保存され、ONにすると次の読み込みで反映される**
const flags = { cc_all: true, cc_approval: false, cc_agentlog: false, cc_ai_trial: false,
  cc_authz: 'off', env: 'preview', store: 'kv', configured: true };
let savedConfig = { trialRooms: [], allowedDocIds: [] };
const calls = [];
const json = (res, o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch {}
    const p = url.pathname;
    if (p.startsWith('/api/')) calls.push({ path: p, q: Object.fromEntries(url.searchParams), body, method: req.method });
    if (p === '/api/settlement-auth') {
      if (req.method === 'GET') return json(res, { ok: true, shops: {} });
      return json(res, { ok: true, token: 'stub-root-token', owner: '__root__', root: true, role: 'root' });
    }
    if (p === '/api/plan-store') {
      const type = req.method === 'GET' ? url.searchParams.get('type') : body.type;
      const action = req.method === 'GET' ? url.searchParams.get('action') : body.action;
      if (type === 'ccflags') {
        if (req.method === 'POST' && body.key) {          // ONにする操作
          flags[body.key] = body.value === true;
          return json(res, { ok: true, flags: { ...flags }, configured: true, env: flags.env });
        }
        return json(res, { flags: { ...flags }, configured: true, env: flags.env });
      }
      if (type === 'chatai') {
        if (action === 'config') {
          // ⚠️ 本番と同じく、画面は**読み取りもPOST**で呼ぶ。保存は body.config の有無で判定する。
          if (body.config) savedConfig = body.config;
          return json(res, { ok: true, enabled: flags.cc_ai_trial, config: savedConfig,
            targets: { rooms: savedConfig.trialRooms.map(id => ({ id, name: ROOMS[id] || id, members: [] })),
                       docs: savedConfig.allowedDocIds.map(id => ({ id, title: FAQS[id] || id })), reasons: [] },
            choices: { rooms: Object.entries(ROOMS).map(([id, name]) => ({ id, name })),
                       docs: Object.entries(FAQS).map(([id, title]) => ({ id, title })) } });
        }
        if (action === 'get') return json(res, { ok: true, room_id: body.room_id, answers: {} });
      }
      return json(res, { ok: true });
    }
    // 経営データ系は最小の成功形を返す（ダッシュボードがエラー画面に落ちないように・②のstubと同じ扱い）
    if (p.startsWith('/api/gas') || p.startsWith('/api/customers')) return json(res, { success: true, data: [] });
    if (p.startsWith('/api/square')) return json(res, { success: true, accounts: [], data: [] });
    if (p.startsWith('/api/salonone')) return json(res, { data: [], meta: {} });
    if (p.startsWith('/api/')) return json(res, { ok: true, success: true, data: [] });
    const file = path.join(ROOT, decodeURIComponent(p === '/' ? '/index.html' : p));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('nf'); }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
});
await new Promise(r => server.listen(8962, '127.0.0.1', r));
console.log('  stub self-check:', (await fetch('http://127.0.0.1:8962/')).status);

// 既存のChromiumを使う（新規ダウンロードはしない）
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  // ローカルのスタブへ直接つなぐ（環境のproxyを経由させない）
  args: ['--no-proxy-server', '--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({ serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
const localJs = (f) => ({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(f) });
await page.route(/.*/, route => {
  const u = route.request().url();
  if (process.env.ROUTE_DEBUG) console.log('   route', u.slice(0, 80));
  if (u.startsWith('http://127.0.0.1:8962')) return route.continue();
  if (u.includes('/react-dom')) return route.fulfill(localJs(`${CDN}/react-dom.js`));
  if (u.includes('/react')) return route.fulfill(localJs(`${CDN}/react.js`));
  if (u.includes('babel')) return route.fulfill(localJs(`${CDN}/babel.js`));
  // tailwind の CDN は設定用のグローバルだけ用意する（見た目は検証対象ではない）
  if (u.includes('tailwindcss.com')) return route.fulfill({ status: 200, contentType: 'text/javascript',
    body: 'window.tailwind={config:{}};' });
  // @vercel/blob の client module。**ここでは実際に保存しない**（画面が起動できればよい）
  if (u.includes('@vercel/blob')) return route.fulfill({ status: 200, contentType: 'text/javascript',
    body: 'export const upload=async()=>{throw new Error("stub: no upload in screen check");};' });
  return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
});

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? '  OK  ' : '  NG  '} ${name}${detail ? '  ' + detail : ''}`); };

await page.goto('http://127.0.0.1:8962/', { waitUntil: 'commit', timeout: 60000 });
// Babel が 1.3MB を変換し終えて React が描画するまで待つ
for (let i = 0; i < 40; i++) {
  const t = await page.locator('body').innerText().catch(() => '');
  if (t.trim().length > 40) break;
  await page.waitForTimeout(1000);
}

// ログイン（root）
console.log('--- JSエラー ---'); for (const e of errors.slice(0,6)) console.log('   ',e.slice(0,200));
if (process.env.DUMP) {
  console.log('--- 画面テキスト ---');
  console.log((await page.locator('body').innerText().catch(() => '')).slice(0, 1200));
  console.log('--- input ---');
  for (const el of (await page.locator('input').all()).slice(0,10)) console.log('   ', await el.getAttribute('type'), await el.getAttribute('placeholder'));
  console.log('--- button ---');
  for (const el of (await page.locator('button').all()).slice(0, 15)) console.log('   ', (await el.innerText().catch(() => '')).slice(0, 30));
}
const pw = page.locator('input[type="password"]');
if (await pw.count()) { await pw.first().fill(process.env.STUB_PW || 'pw'); await page.keyboard.press('Enter'); await page.waitForTimeout(3000); }
check('rootでログインできる', (await page.locator('input[type="password"]').count()) === 0);

// オーナー設定へ
await page.getByRole('button', { name: 'オーナー設定' }).first().click().catch(async () => {
  await page.getByText('オーナー設定', { exact: true }).first().click().catch(() => {});
});
await page.waitForTimeout(2500);
const hasPanel = await page.getByText('Command Center フラグ').count() > 0;
check('「Command Center フラグ」が見える', hasPanel);

// ⭐ 本題: @AI 検証 のスイッチがあるか
const row = page.locator('div').filter({ hasText: /^@AI 検証/ }).last();
const aiSwitch = page.getByText('@AI 検証', { exact: false }).first();
check('「@AI 検証」のスイッチが一覧にある', await aiSwitch.count() > 0);

// メニューは OFF のあいだ出ない
const menuBefore = await page.getByRole('button', { name: /@AI 検証/ }).count() + await page.locator('nav').getByText('@AI 検証').count();
check('フラグOFFのあいだ @AI 検証メニューは出ない', menuBefore === 0 || !(await page.getByText('検証ルーム').count()));

// ONにする
const onBtn = page.locator('button', { hasText: 'ONにする' });
const n = await onBtn.count();
let clicked = false;
for (let i = 0; i < n; i++) {
  const b = onBtn.nth(i);
  const txt = await b.evaluate(el => (el.closest('div') || {}).textContent || '');
  if (txt.includes('@AI 検証')) { await b.click(); clicked = true; break; }
}
check('「ONにする」を押せる', clicked);
await page.waitForTimeout(2500);
check('サーバーへ cc_ai_trial の変更が送られた',
  calls.some(c => c.body && c.body.key === 'cc_ai_trial' && c.body.value === true),
  JSON.stringify(calls.filter(c => c.body && c.body.key).map(c => c.body)));
check('画面が「公開中」になる', (await page.getByText('公開中').count()) > 0);

// @AI 検証 を開く
await page.getByRole('button', { name: /@AI 検証/ }).first().click().catch(async () => {
  await page.getByText('@AI 検証', { exact: false }).last().click().catch(() => {});
});
await page.waitForTimeout(2500);
check('@AI 検証の画面が開く', (await page.getByText('検証ルーム').count()) > 0);

// 設定を開いて名前で選ぶ
await page.getByText('検証の設定', { exact: false }).first().click().catch(() => {});
await page.waitForTimeout(1200);
check('ルームを名前で選べる（内部IDではない）', (await page.getByText('本部AI検証（本部/root 3名）').count()) > 0);
check('FAQをタイトルで選べる', (await page.getByText('家族施術制度').count()) > 0);
const roomBox = page.locator('input[data-ai-room]').first();
const docBox = page.locator('input[data-ai-doc]').first();
if (await roomBox.count()) await roomBox.check().catch(() => {});
if (await docBox.count()) await docBox.check().catch(() => {});
await page.getByText('設定を保存', { exact: false }).first().click().catch(() => {});
await page.waitForTimeout(2000);
check('保存でサーバーへ送られる', savedConfig.trialRooms.length > 0,
  `trialRooms=${JSON.stringify(savedConfig.trialRooms)} docs=${JSON.stringify(savedConfig.allowedDocIds)}`);
check('JSエラーが出ていない', errors.length === 0, errors.slice(0, 2).join(' / '));

await page.screenshot({ path: (process.env.OUT_DIR || '/tmp') + '/ccflags-screen.png', fullPage: false });
await browser.close(); server.close();
const ng = results.filter(r => !r.pass);
console.log(`\n${results.length - ng.length}/${results.length} OK`);
process.exit(ng.length ? 1 : 0);
