// ── ニュースの投稿フォーム拡張・一覧の絞り込み の画面レベル検証 ──────────
// カテゴリー／公開対象／確認要否・期限／ピックアップ／表紙 を実際に操作して確認する。
// ⚠️ 本番には一切つながりません。ローカルのスタブAPIに対してだけ動かします。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');

const ROOT = process.env.DASHBOARD_ROOT || process.cwd();
const CDN = process.env.CDN_DIR || '/tmp/cdn';
const PORT = 8968;
const TYPES = { '.html':'text/html;charset=utf-8', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml' };

const SHOPS = [{ id: 1, name: 'NAORU 鶴見院' }, { id: 2, name: 'NAORU 関内院' }];
const posts = [
  { id: 'p1', authorId: 'hq1', authorName: '本部', authorRoot: true, title: '沖縄セミナー', text: '開催します',
    category: 'event', featured: true, dueDate: '2026-09-20', needsAck: true,
    reactions: {}, comments: [], imgIds: [], files: [], createdAt: '2026-09-18T01:00:00.000Z' },
  { id: 'p2', authorId: 'hq1', authorName: '本部', authorRoot: true, title: '返金手順の変更', text: '手順が変わります',
    category: 'rule', reactions: {}, comments: [], imgIds: [], files: [], createdAt: '2026-08-10T01:00:00.000Z' },
  { id: 'p3', authorId: 'hq1', authorName: '管理者', authorRoot: true, title: '古い投稿', text: '項目のない投稿',
    reactions: {}, comments: [], imgIds: [], files: [], createdAt: '2026-08-01T01:00:00.000Z' },
];
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
      return json(res, { ok: true, token: 'stub', owner: '__root__', root: true, role: 'root' });
    }
    if (p === '/api/plan-store') {
      const type = req.method === 'GET' ? url.searchParams.get('type') : body.type;
      if (type === 'ccflags') return json(res, { flags: { cc_all: true, cc_authz: 'off' }, configured: true, env: 'preview' });
      if (type === 'board') {
        if (req.method === 'POST' && body.action === 'post') { posts.unshift({ ...body.post, id: 'new1', reactions: {}, comments: [], createdAt: new Date().toISOString() }); return json(res, { ok: true, post: posts[0] }); }
        if (req.method === 'POST') return json(res, { ok: true, posts });
        return json(res, { posts, reads: {}, configured: true });
      }
      if (type === 'chat') return json(res, { rooms: [], messages: {}, reads: {}, dir: { staff: [] }, notes: {}, configured: true });
      if (type === 'events') return json(res, { sections: {}, configured: true });
      return json(res, { ok: true, configured: true });
    }
    if (p.startsWith('/api/salonone')) {
      if (/shop|store/i.test(req.url)) return json(res, { data: SHOPS, meta: {} });
      return json(res, { data: [], meta: {} });
    }
    if (p.startsWith('/api/gas') || p.startsWith('/api/customers')) return json(res, { success: true, data: [] });
    if (p.startsWith('/api/square')) return json(res, { success: true, accounts: [], data: [] });
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
  if (u.includes('@vercel/blob')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export const upload=async()=>{throw new Error("stub");};' });
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

await page.getByRole('button', { name: /ニュース/ }).first().click().catch(() => {});
await page.waitForTimeout(3000);
check('ニュースが開く', (await txt()).includes('沖縄セミナー'));

// ── 一覧のバッジ ──
let t = await txt();
check('カテゴリーのバッジが出る', t.includes('イベント') && t.includes('ルール・手順'));
check('ピックアップのバッジが出る', t.includes('ピックアップ'));
check('期限が出る', /2026-09-20 まで|期限切れ/.test(t), (t.match(/2026-09-20[^\n]*/) || [''])[0]);
check('項目の無い古い投稿もそのまま出る', t.includes('古い投稿'));

// ── カテゴリーで絞る ──
await page.locator('[data-news-catfilter-btn="rule"]').first().click();
await page.waitForTimeout(1200);
t = await txt();
check('カテゴリーで絞れる', t.includes('返金手順の変更') && !t.includes('沖縄セミナー'));
check('項目の無い投稿は絞り込みで消える（カテゴリー未設定のため）', !t.includes('古い投稿'));
await page.locator('[data-news-catfilter-btn="rule"]').first().click();
await page.waitForTimeout(1000);

// ── ピックアップだけ ──
await page.locator('[data-news-filter="featured"]').first().click();
await page.waitForTimeout(1200);
t = await txt();
check('ピックアップだけ出せる', t.includes('沖縄セミナー') && !t.includes('返金手順の変更'));
await page.locator('[data-news-filter="all"]').first().click();
await page.waitForTimeout(1000);

// ── 投稿フォーム ──
await page.getByRole('button', { name: /投稿する/ }).first().click().catch(() => {});
await page.waitForTimeout(1500);
check('投稿フォームが開く', (await page.locator('[data-news-cat]').count()) > 0);
check('カテゴリーが選べる', (await page.locator('[data-news-cat-btn]').count()) === 6);
check('公開対象が選べる', (await page.locator('[data-news-aud]').count()) === 2);
check('確認要否と期限がある', (await page.locator('[data-news-needsack]').count()) > 0 && (await page.locator('[data-news-due]').count()) > 0);
check('ピックアップ指定がある', (await page.locator('[data-news-featured]').count()) > 0);

// 店舗指定にすると店舗が出る／選ぶまで投稿できない
await page.locator('[data-news-aud="shops"]').first().click();
await page.waitForTimeout(900);
check('店舗を指定できる', (await page.locator('[data-news-aud-shop]').count()) >= 2);
check('⚠️ 店舗未選択のあいだは注意が出る', (await txt()).includes('送る店舗を選んでください'));

// 確認を求めると期限が必要
await page.locator('[data-news-needsack]').first().check();
await page.waitForTimeout(700);
check('⚠️ 確認を求めるのに期限が無いと注意が出る', (await txt()).includes('期限を入れてください'));

// 入力して投稿
await page.locator('[data-news-aud-shop]').first().click();
await page.locator('[data-news-due]').first().fill('2026-10-01');
await page.locator('[data-news-cat-btn="study"]').first().click();
await page.locator('[data-news-featured]').first().check();
await page.locator('input[placeholder*="9月の運営連絡"]').first().fill('研修のお知らせ');
await page.locator('textarea[placeholder*="ニュースの内容"]').first().fill('10月に研修を行います。');
await page.waitForTimeout(700);
await page.getByRole('button', { name: /ニュースを投稿/ }).first().click().catch(() => {});
await page.waitForTimeout(3000);
const sent = calls.filter(c => c.body && c.body.type === 'board' && c.body.action === 'post').pop();
check('投稿がサーバーへ送られた', !!sent);
check('カテゴリー・ピックアップ・期限・確認要否が送られた',
  !!sent && sent.body.post.category === 'study' && sent.body.post.featured === true
  && sent.body.post.dueDate === '2026-10-01' && sent.body.post.needsAck === true,
  sent ? JSON.stringify({ c: sent.body.post.category, f: sent.body.post.featured, d: sent.body.post.dueDate, n: sent.body.post.needsAck }) : '');
check('公開対象（店舗指定）が送られた',
  !!sent && sent.body.post.audience && sent.body.post.audience.kind === 'shops' && (sent.body.post.audience.shops || []).length === 1,
  sent ? JSON.stringify(sent.body.post.audience) : '');

check('JSエラーが出ていない', errors.length === 0, errors.slice(0, 2).join(' / '));
await page.screenshot({ path: (process.env.OUT_DIR || '/tmp') + '/news-compose-screen.png', fullPage: false });
await browser.close(); server.close();
const ng = results.filter(r => !r.pass);
console.log(`\n${results.length - ng.length}/${results.length} OK`);
process.exit(ng.length ? 1 : 0);
