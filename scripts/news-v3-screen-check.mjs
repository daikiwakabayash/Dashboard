// ── ニュース画面（UI試作V3 の見た目）の画面レベル検証 ─────────────────
// ヒーロー／確認バー／ピックアップ／タブ・検索・カテゴリー／カードの並び を実ブラウザで確認する。
// ⚠️ tests/*-screen.test.js は記述の確認。こちらが**実表示の確認**。
// ⚠️ 本番には一切つながりません。ローカルのスタブAPIに対してだけ動かします。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');

const ROOT = process.env.DASHBOARD_ROOT || process.cwd();
const CDN = process.env.CDN_DIR || '/tmp/cdn';
const PORT = 8973;
const TYPES = { '.html':'text/html;charset=utf-8', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml' };

const SHOPS = [{ id: 1, name: 'NAORU 鶴見院' }, { id: 2, name: 'NAORU 関内院' }];
const STAFF = Array.from({ length: 8 }, (_, i) => ({ staff_id: `s${i + 1}`, name: `スタッフ${i + 1}`, shop_name: 'NAORU 鶴見院' }));
const posts = [
  { id: 'p1', authorId: 'hq1', authorName: '青木 はるか', authorRoot: true, title: '伝わる説明が、チームの新しい力になる。',
    text: '明日の現場で試したくなる、カウンセリングの3つのヒント。', category: 'study', featured: true,
    reactions: { '👍': ['s1', 's2', 's3'] }, comments: [{ id: 'c1', text: 'やってみます' }], imgIds: [], files: [], createdAt: '2026-09-18T01:00:00.000Z' },
  { id: 'p2', authorId: 'hq1', authorName: '青木 はるか', authorRoot: true, title: '秋の研修・参加エントリーを受け付けています。',
    text: '9月25日までにご確認ください。', category: 'event', important: true, needsAck: true, dueDate: '2026-09-25',
    reactions: { '🎉': ['s1', 's2'] }, comments: [], imgIds: [], files: [], createdAt: '2026-09-16T01:00:00.000Z' },
  { id: 'p3', authorId: 'hq1', authorName: '本部 運営チーム', authorRoot: true, title: '今月の共有事項を、ひとつにまとめました。',
    text: '手順の変更と資料の保存先を確認しましょう。', category: 'notice',
    reactions: { '👍': ['s1'] }, comments: [], imgIds: [], files: [], createdAt: '2026-09-11T01:00:00.000Z' },
  { id: 'p4', authorId: 'hq1', authorName: '本部 広報チーム', authorRoot: true, title: '新しい仲間の「好き」を、見つけてみよう。',
    text: 'プロフィールから始まる、新しいコミュニケーション。', category: 'praise',
    reactions: {}, comments: [], imgIds: [], files: [], createdAt: '2026-08-28T01:00:00.000Z' },
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
        if (req.method === 'POST' && body.action === 'status_counts') {
          const counts = {};
          for (const id of (body.ids || [])) counts[id] = { read: { p1: 5, p2: 5, p3: 3, p4: 8 }[id] || 0, acked: 0, total: 8 };
          return json(res, { ok: true, counts });
        }
        if (req.method === 'POST' && body.action === 'post') { posts.unshift({ ...body.post, id: 'new1', reactions: {}, comments: [], createdAt: new Date().toISOString() }); return json(res, { ok: true, post: posts[0] }); }
        if (req.method === 'POST') return json(res, { ok: true, posts });
        return json(res, { posts, reads: {}, configured: true });
      }
      if (type === 'chat') return json(res, { rooms: [], messages: {}, reads: {},
        dir: { staff: STAFF.map(x => ({ id: x.staff_id, name: x.name, shop: x.shop_name })) }, notes: {}, configured: true });
      if (type === 'events') return json(res, { sections: {}, configured: true });
      return json(res, { ok: true, configured: true });
    }
    if (p.startsWith('/api/salonone')) {
      if (/shop|store/i.test(req.url)) return json(res, { data: SHOPS, meta: {} });
      if (/staff/i.test(req.url)) return json(res, { data: STAFF, meta: {} });
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
let t = await txt();

// ── 見出し ──────────────────────────────────────────────
check('大見出しが試作V3の言葉になっている', t.includes('チームの今を、') && t.includes('もっと近くに'));
check('INSIDE NOWL の小見出しが出る', t.includes('INSIDE NOWL'));
check('「＋ お知らせを投稿」ボタンが出る', (await page.getByRole('button', { name: /お知らせを投稿/ }).count()) > 0);

// ── 確認が必要なお知らせ ────────────────────────────────
check('確認が必要なお知らせのバーが出る', (await page.locator('[data-news-ackbar]').count()) > 0);
check('締切の日付が出る', /9\/25 締切/.test(t), (t.match(/9\/25[^\n]*/) || [''])[0]);

// ── ピックアップ ────────────────────────────────────────
check('ピックアップが1件だけ大きく出る', (await page.locator('[data-news-hero]').count()) === 1);
check('ピックアップは featured の記事', (await page.locator('[data-news-hero="p1"]').count()) === 1);
check('写真が無いピックアップは文字の表紙になる', (await page.locator('[data-news-hero] .nowl-graphic').count()) === 1);
check('EDITOR\'S PICK の印が出る', t.includes("EDITOR'S PICK"));
check('PICKUP / UPDATES の見出しが出る', t.includes('PICKUP') && t.includes('UPDATES'));

// ── カード ──────────────────────────────────────────────
const cards = await page.locator('[data-news-card]').count();
check('カードが記事の数だけ出る', cards === 4, `${cards} 件`);
const cover = await page.locator('[data-news-card="p2"] .nowl-cover strong').first().innerText().catch(() => '');
check('写真が無いカードはカテゴリー別の文字表紙になる', cover.includes('LEARN') && cover.includes('TOGETHER'), cover.replace(/\n/g, ' '));
check('要確認のバッジが出る', t.includes('要確認'));
check('既読件数がサーバーの値で出る', /既読 5\/8/.test(t), (t.match(/既読 \d+\/\d+/g) || []).join(' '));
check('リアクション数・コメント数が出る', /♡ 3/.test(t) && /コメント 1/.test(t));

// 3列に並ぶ（PC幅）
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(600);
const cols = await page.locator('.nowl-postgrid').first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
check('PCでは3列に並ぶ', cols === 3, `${cols} 列`);
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(600);
const cols1 = await page.locator('.nowl-postgrid').first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check('スマホでは1列に並ぶ', cols1 === 1, `${cols1} 列`);
check('スマホで横スクロールが出ない', !overflow);
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(600);

// ── タブ ────────────────────────────────────────────────
await page.locator('[data-news-filter="saved"]').first().click();
await page.waitForTimeout(900);
check('保存済みタブは空のとき案内を出す', (await txt()).includes('保存したお知らせはまだありません'));
check('空のときに絞り込みを解除できる', (await page.locator('[data-news-clearfilter]').count()) > 0);
await page.locator('[data-news-clearfilter]').first().click();
await page.waitForTimeout(900);
check('解除するとすべて表示に戻る', (await page.locator('[data-news-card]').count()) === 4);

// 保存する → 保存済みに出る
await page.locator('[data-news-save="p3"]').first().click();
await page.waitForTimeout(700);
await page.locator('[data-news-filter="saved"]').first().click();
await page.waitForTimeout(900);
check('★で保存した記事が保存済みに出る', (await page.locator('[data-news-card]').count()) === 1
  && (await page.locator('[data-news-card="p3"]').count()) === 1);
await page.locator('[data-news-filter="all"]').first().click();
await page.waitForTimeout(800);

// ── カテゴリー ──────────────────────────────────────────
await page.locator('[data-news-catfilter-btn="event"]').first().click();
await page.waitForTimeout(900);
check('カテゴリーで絞れる', (await page.locator('[data-news-card]').count()) === 1
  && (await page.locator('[data-news-card="p2"]').count()) === 1);
await page.locator('[data-news-catfilter-btn="all"]').first().click();
await page.waitForTimeout(800);

// ── 検索 ────────────────────────────────────────────────
await page.locator('.nowl-search input').first().fill('研修');
await page.waitForTimeout(900);
check('キーワードで絞れる', (await page.locator('[data-news-card]').count()) === 1);
await page.locator('.nowl-search input').first().fill('存在しない語句zzz');
await page.waitForTimeout(900);
check('見つからないときは案内と解除ボタンが出る',
  (await txt()).includes('に一致するお知らせがありません') && (await page.locator('[data-news-clearfilter]').count()) > 0);
await page.locator('[data-news-clearfilter]').first().click();
await page.waitForTimeout(800);

// ── 記事を開く ──────────────────────────────────────────
await page.locator('[data-news-card="p1"] button').first().click();
await page.waitForTimeout(1500);
check('カードから記事を開ける', (await txt()).includes('カウンセリングの3つのヒント'));

await page.keyboard.press('Escape');
await page.waitForTimeout(800);

await page.screenshot({ path: path.join(process.env.OUT_DIR || '/tmp', 'news-v3.png'), fullPage: true });
check('画面の写しを保存した', true, path.join(process.env.OUT_DIR || '/tmp', 'news-v3.png'));
check('画面のエラーが出ていない', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close(); server.close();
const ng = results.filter(r => !r.pass);
console.log(`\n  結果: ${results.length - ng.length}/${results.length}`);
if (ng.length) { console.log('  NG:'); for (const r of ng) console.log('   -', r.name, r.detail); }
process.exit(ng.length ? 1 : 0);
