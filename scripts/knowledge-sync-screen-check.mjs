// ── ナレッジ資料の自動更新（Googleシート/スライド）の画面レベル検証 ─────────
// 「FAQ管理（AI）を開く → 出典にGoogleのURLを入れると自動更新の設定が出る →
//   いま取り直す → 更新あり（未確認）が出る → 確認しました で消える」までを、
// **本物の index.html** を headless Chromium で操作して確認する。
// ⚠️ 本番には一切つながりません。ローカルのスタブAPIに対してだけ動かします。
//    Apps Script も呼びません（スタブが「新しい中身」を返すだけ）。
//
// 使い方:
//   CDN_DIR=<react/react-dom/babel を置いた場所> \
//   CHROMIUM_PATH=<既存のchromium> node scripts/knowledge-sync-screen-check.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');

const ROOT = process.env.DASHBOARD_ROOT || process.cwd();
const CDN = process.env.CDN_DIR || '/tmp/cdn';
const PORT = 8963;
const TYPES = { '.html':'text/html;charset=utf-8', '.js':'text/javascript', '.mjs':'text/javascript',
  '.css':'text/css', '.json':'application/json', '.webmanifest':'application/manifest+json',
  '.png':'image/png', '.svg':'image/svg+xml', '.jpg':'image/jpeg' };

const SHEET = 'https://docs.google.com/spreadsheets/d/1AAAAAAAAAAAAAAAAAAAAAAAA/edit';
// スタブの保存。sync で「中身が変わった」状態になる（Apps Script は呼ばない）。
let failMode = false;
let docs = [
  { id: 'd_sheet', title: '料金表（スプレッドシート）', body: '前の中身です。'.repeat(8), source: SHEET, autoSync: true },
  { id: 'd_free',  title: '定例MTG 文字起こし', body: '出典が自由文なので自動更新の対象外です。'.repeat(3), source: '2026-09 定例MTG' },
];
const calls = [];
const json = (res, o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
const summary = () => ({ total: docs.length, syncable: docs.filter(d => d.autoSync !== false && /docs\.google\.com/.test(d.source || '')).length,
  needsReview: docs.filter(d => d.sync && d.sync.needsReview).length, failed: docs.filter(d => d.sync && d.sync.lastError).length });

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
      if (type === 'ccflags') return json(res, { flags: { cc_all: true, cc_ai_trial: false, cc_authz: 'off' }, configured: true, env: 'preview' });
      if (type === 'faq') return json(res, { faqs: [], configured: true, ok: true });
      if (type === 'knowcand') return json(res, { cands: [], configured: true, ok: true });
      if (type === 'knowledge') {
        if (action === 'sync' && failMode) {   // 取得できなかったときの見え方を確認する
          docs = docs.map(d => (d.autoSync === false || !/docs\.google\.com/.test(d.source || '')) ? d
            : { ...d, sync: { ...(d.sync || {}), lastError: 'unauthorized', lastCheckedAt: Date.now() } });
          return json(res, { ok: true, configured: true, checked: 1, updated: 0, failed: 1,
            summary: { ...summary(), failedReasons: ['unauthorized'] } });
        }
        if (action === 'sync') {   // 「いま取り直す」: 中身が変わった体で返す
          let updated = 0;
          docs = docs.map(d => {
            if (d.autoSync === false || !/docs\.google\.com/.test(d.source || '')) return d;
            updated++;
            return { ...d, body: '取り直した新しい中身です。料金が改定されました。'.repeat(3),
              sync: { needsReview: true, lastCheckedAt: Date.now(), lastChangedAt: Date.now() },
              revisions: [{ at: new Date().toISOString(), by: '自動更新', previousBody: d.body }] };
          });
          return json(res, { ok: true, configured: true, checked: updated, updated, failed: 0, summary: summary() });
        }
        if (action === 'reviewed') {
          docs = docs.map(d => d.id === body.id ? { ...d, sync: { ...(d.sync || {}), needsReview: false } } : d);
          return json(res, { ok: true, doc: docs.find(d => d.id === body.id), summary: summary() });
        }
        if (action === 'add' || action === 'update') {
          const rec = { ...body.doc, id: body.doc.id || ('d_' + Date.now().toString(36)) };
          docs = docs.some(d => d.id === rec.id) ? docs.map(d => d.id === rec.id ? rec : d) : docs.concat(rec);
          return json(res, { ok: true, doc: rec });
        }
        return json(res, { docs, configured: true, summary: summary() });
      }
      return json(res, { ok: true });
    }
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
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
console.log('  stub self-check:', (await fetch(`http://127.0.0.1:${PORT}/`)).status);

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-proxy-server', '--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({ serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
const localJs = (f) => ({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(f) });
await page.route(/.*/, route => {
  const u = route.request().url();
  if (u.startsWith(`http://127.0.0.1:${PORT}`)) return route.continue();
  if (u.includes('/react-dom')) return route.fulfill(localJs(`${CDN}/react-dom.js`));
  if (u.includes('/react')) return route.fulfill(localJs(`${CDN}/react.js`));
  if (u.includes('babel')) return route.fulfill(localJs(`${CDN}/babel.js`));
  if (u.includes('tailwindcss.com')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.tailwind={config:{}};' });
  if (u.includes('@vercel/blob')) return route.fulfill({ status: 200, contentType: 'text/javascript',
    body: 'export const upload=async()=>{throw new Error("stub: no upload in screen check");};' });
  return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
});

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? '  OK  ' : '  NG  '} ${name}${detail ? '  ' + detail : ''}`); };
const txt = () => page.locator('body').innerText().catch(() => '');

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'commit', timeout: 60000 });
for (let i = 0; i < 40; i++) { if ((await txt()).trim().length > 40) break; await page.waitForTimeout(1000); }
const pw = page.locator('input[type="password"]');
if (await pw.count()) { await pw.first().fill(process.env.STUB_PW || 'pw'); await page.keyboard.press('Enter'); await page.waitForTimeout(3000); }
check('rootでログインできる', (await page.locator('input[type="password"]').count()) === 0);

// FAQ管理（AI）を開く
await page.getByRole('button', { name: /FAQ管理/ }).first().click().catch(async () => {
  await page.getByText('FAQ管理（AI）', { exact: false }).first().click().catch(() => {});
});
await page.waitForTimeout(2500);
check('FAQ管理（AIアシスタント）の画面が開く', (await page.getByText('FAQ管理（AIアシスタント）').count()) > 0);
check('「ナレッジ資料（長文）」の枠がある', (await page.getByText('ナレッジ資料（長文）').count()) > 0);
check('登録済みの資料が名前で並ぶ', (await page.getByText('料金表（スプレッドシート）').count()) > 0);

// 自動更新の対象は「🔄 自動更新」、自由文の出典は対象外
check('GoogleのURLの資料に「自動更新」が出る', (await page.getByText('🔄 自動更新').count()) > 0);
const beforeBadge = await page.getByText('🔔 更新あり（未確認）').count();
check('取り直す前は「更新あり（未確認）」が出ていない', beforeBadge === 0);

// ⭐ 本題1: 「いま取り直す」
const syncBtn = page.getByRole('button', { name: /いま取り直す/ });
check('「🔄 いま取り直す」ボタンがある', (await syncBtn.count()) > 0);
check('自動更新が一度も動いていないことが画面で分かる', (await page.getByText('まだ自動更新が動いていません').count()) > 0);
await syncBtn.first().click().catch(() => {});
await page.waitForTimeout(2500);
check('サーバーへ action=sync が送られた',
  calls.some(c => c.body && c.body.type === 'knowledge' && c.body.action === 'sync'));
check('取り直した件数が画面に出る', /件を確認し、\d+件が新しくなりました/.test(await txt()), (await txt()).slice(0, 0));

// ⭐ 本題2: 自動反映されたうえで「更新あり（未確認）」が残る
const body = await txt();
check('本文が新しい中身に置き換わっている（自動反映）', body.includes('取り直した新しい中身です'));
check('「🔔 更新あり（未確認）」が出る（本部の確認を求める）', (await page.getByText('🔔 更新あり（未確認）').count()) > 0);
check('対象外の資料は書き換わっていない', body.includes('出典が自由文なので自動更新の対象外です'));

// ⭐ 本題3: 「確認しました」で未確認の印が消える
const seenBtn = page.getByRole('button', { name: '確認しました' });
check('取り直したあとは最終更新確認の時刻が出る', /最終更新確認 \d+\/\d+/.test(await txt()));
check('「確認しました」ボタンが出る', (await seenBtn.count()) > 0);
await seenBtn.first().click().catch(() => {});
await page.waitForTimeout(2000);
check('サーバーへ action=reviewed が送られた',
  calls.some(c => c.body && c.body.type === 'knowledge' && c.body.action === 'reviewed'));
check('「更新あり（未確認）」が消える', (await page.getByText('🔔 更新あり（未確認）').count()) === 0);
check('確認しても本文は残る', (await txt()).includes('取り直した新しい中身です'));

// ⭐ 本題4: 出典にGoogleのURLを入れたときだけ自動更新の設定が出る
await page.getByRole('button', { name: /資料を追加/ }).first().click().catch(() => {});
await page.waitForTimeout(800);
const src = page.locator('input[placeholder*="出典"]').first();
check('「出典」の入力欄がある', (await src.count()) > 0);
await src.fill('社内の紙資料');
await page.waitForTimeout(600);
check('Google以外のURLなら「自動更新の対象外」と出る', (await page.getByText('自動更新はGoogleのスプレッドシート', { exact: false }).count()) > 0);
await src.fill(SHEET);
await page.waitForTimeout(600);
check('GoogleのURLなら自動更新のチェックが出る',
  (await page.getByText('1日1回このURLから自動で最新にする', { exact: false }).count()) > 0);

// ⭐ 本題5: 取得できなかったとき、理由がマウスを乗せずに読める
failMode = true;
await page.getByRole('button', { name: /いま取り直す/ }).first().click().catch(() => {});
await page.waitForTimeout(2500);
const failText = await txt();
check('失敗の件数と理由が一緒に出る', /1件は取得できず：unauthorized/.test(failText),
  (failText.match(/\d件を確認し[^\n]*/) || [''])[0]);
const inline = page.locator('[data-know-error]');
check('資料の行にも理由がそのまま出る（マウスを乗せなくて良い）', (await inline.count()) > 0,
  (await inline.first().innerText().catch(() => '')));
check('理由の文言が読める', /取得できなかった理由: unauthorized/.test(await inline.first().innerText().catch(() => '')));

check('JSエラーが出ていない', errors.length === 0, errors.slice(0, 2).join(' / '));
await page.screenshot({ path: (process.env.OUT_DIR || '/tmp') + '/knowledge-sync-screen.png', fullPage: false });
await browser.close(); server.close();
const ng = results.filter(r => !r.pass);
console.log(`\n${results.length - ng.length}/${results.length} OK`);
process.exit(ng.length ? 1 : 0);
