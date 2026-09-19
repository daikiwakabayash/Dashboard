// ── ニュース: 下書き→下見→投稿 と、過去記事の年月・追加読込 の画面レベル検証 ──
// ⚠️ tests/*-screen.test.js は記述の確認。こちらが**実表示・実操作の確認**。
// ⚠️ 本番には一切つながりません。ローカルのスタブAPIに対してだけ動かします。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');

const ROOT = process.env.DASHBOARD_ROOT || process.cwd();
const CDN = process.env.CDN_DIR || '/tmp/cdn';
const PORT = 8978;
const TYPES = { '.html':'text/html;charset=utf-8', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml' };

const SHOPS = [{ id: 1, name: 'NAORU 鶴見院' }, { id: 2, name: 'NAORU 関内院' }];
const STAFF = Array.from({ length: 8 }, (_, i) => ({ staff_id: `s${i + 1}`, name: `スタッフ${i + 1}`, shop_name: 'NAORU 鶴見院' }));

// 架空の記事（本番データではありません）。4か月ぶん・28件＝追加読込と年月見出しの両方を確かめられる数。
const MONTHS = ['2026-09', '2026-08', '2026-07', '2026-06'];
let posts = [];
MONTHS.forEach((ym, mi) => {
  for (let i = 0; i < 7; i++) {
    const day = String(20 - i).padStart(2, '0');
    posts.push({
      id: `p${mi}_${i}`, authorId: 'hq1', authorName: '本部 運営チーム', authorRoot: true,
      title: `${ym} のお知らせ ${i + 1}`, text: 'これは検証用の架空の記事です。', category: 'notice',
      reactions: {}, comments: [], imgIds: [], files: [], createdAt: `${ym}-${day}T01:00:00.000Z`,
    });
  }
});
let nextId = 1;
let hero = null;                       // ファーストビュー（未設定＝既定の文言）
const heroImgs = {};                   // 架空の写真
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const calls = [];
const json = (res, o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
// ⚠️ サーバーと同じく、他人の下書きは返さない。ここでは root で見ているので全部見える。
const visible = () => posts;

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
        if (req.method === 'POST' && body.action === 'status_counts') return json(res, { ok: true, counts: {} });
        if (req.method === 'POST' && body.action === 'uploadImage') { const id = `himg_${nextId++}`; heroImgs[id] = body.dataUrl; return json(res, { ok: true, id }); }
        if (req.method === 'POST' && body.action === 'hero_set') {
          const h = body.hero || {};
          // ⚠️ サーバーと同じく、写真があるのに掲載許可が未確認なら保存しない
          if (h.imgId && h.consent !== true) return json(res, { ok: false, error: 'consent_unconfirmed', message: '写真に写っている方の掲載許可を確かめてから保存してください。' });
          hero = h; return json(res, { ok: true, hero });
        }
        if (req.method === 'POST' && body.action === 'post') {
          const rec = { ...body.post, id: `new${nextId++}`, reactions: {}, comments: [],
            status: body.post.status === 'draft' ? 'draft' : 'published',
            createdAt: new Date().toISOString(), ...(body.post.status === 'draft' ? { updatedAt: new Date().toISOString() } : {}) };
          posts.unshift(rec);
          return json(res, { ok: true, post: rec });
        }
        if (req.method === 'POST' && body.action === 'editDraft') {
          const i = posts.findIndex(x => x.id === body.id);
          if (i < 0) return json(res, { ok: false, error: 'not_found' });
          if (posts[i].status !== 'draft') { res.statusCode = 409; return json(res, { ok: false, error: 'not_draft' }); }
          posts[i] = { ...posts[i], ...body.post, status: 'draft', updatedAt: new Date().toISOString() };
          return json(res, { ok: true });
        }
        if (req.method === 'POST' && body.action === 'publish') {
          const i = posts.findIndex(x => x.id === body.id);
          if (i < 0) return json(res, { ok: false, error: 'not_found' });
          posts[i] = { ...posts[i], status: 'published', createdAt: new Date().toISOString() };
          return json(res, { ok: true });
        }
        if (req.method === 'POST' && body.action === 'delete') { posts = posts.filter(x => x.id !== body.id); return json(res, { ok: true }); }
        if (req.method === 'POST') return json(res, { ok: true, posts: visible() });
        return json(res, { posts: visible(), reads: {}, configured: true, hero });
      }
      if (type === 'chat' && url.searchParams.get('img')) {
        const d = heroImgs[url.searchParams.get('img')] || '';
        const b64 = /^data:image\/[^;]+;base64,/.test(d) ? d.split(',')[1] : PNG_1PX;
        res.setHeader('Content-Type', 'image/png');
        return res.end(Buffer.from(b64, 'base64'));
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

// ── 過去記事の年月 ────────────────────────────────────────
const monthBands = await page.locator('[data-news-month]').count();
check('年月ごとの見出しが出る', monthBands >= 1, `${monthBands} 区切り`);
let t = await txt();
check('「2026年9月」のように年月で書かれている', /2026年9月/.test(t));
const firstMonth = await page.locator('[data-news-month]').first().getAttribute('data-news-month');
check('いちばん上は新しい月', firstMonth === '2026-09', String(firstMonth));

// ── 追加読込 ─────────────────────────────────────────────
const cards0 = await page.locator('[data-news-card]').count();
check('最初は12件まで（全部出さない）', cards0 === 12, `${cards0} 件`);
check('「もっと読む」が出る', (await page.locator('[data-news-more]').count()) === 1);
const moreLabel = await page.locator('[data-news-more]').first().innerText().catch(() => '');
check('残りの件数が書いてある', /あと\s*\d+件/.test(moreLabel), moreLabel.replace(/\n/g, ' '));
await page.locator('[data-news-more]').first().click();
await page.waitForTimeout(900);
const cards1 = await page.locator('[data-news-card]').count();
check('「もっと読む」で12件ずつ増える', cards1 === 24, `${cards0} → ${cards1} 件`);
await page.locator('[data-news-more]').first().click();
await page.waitForTimeout(900);
check('最後まで出すと「もっと読む」は消える', (await page.locator('[data-news-more]').count()) === 0);
check('全部で28件出ている', (await page.locator('[data-news-card]').count()) === 28);
const bandCount = await page.locator('[data-news-month]').count();
check('4か月ぶんの見出しに分かれる', bandCount === 4, `${bandCount} 区切り`);

// ── 年月で絞る ───────────────────────────────────────────
check('年月で絞る帯が出る', (await page.locator('[data-news-months]').count()) === 1);
await page.locator('[data-news-month-btn="2026-07"]').first().click();
await page.waitForTimeout(900);
check('その月だけになる', (await page.locator('[data-news-card]').count()) === 7, `${await page.locator('[data-news-card]').count()} 件`);
check('見出しもその月だけ', (await page.locator('[data-news-month]').count()) === 1);
check('絞ると出す件数が最初に戻る', (await page.locator('[data-news-more]').count()) === 0);   // 7件なので「もっと読む」は無い
await page.locator('[data-news-month-btn="all"]').first().click();
await page.waitForTimeout(900);
check('「すべての期間」で戻る', (await page.locator('[data-news-card]').count()) === 12, `${await page.locator('[data-news-card]').count()} 件`);

// ── ファーストビュー ───────────────────────────────────────
await page.evaluate(() => { window.scrollTo(0, 0); for (const el of document.querySelectorAll('*')) { if (el.scrollTop > 0) el.scrollTop = 0; } });
await page.waitForTimeout(500);
check('ファーストビューが出る', (await page.locator('[data-news-fv]').count()) === 1);
const fvTxt = await page.locator('[data-news-fv]').first().innerText().catch(() => '');
check('見出しが出る', fvTxt.includes('この仲間と、') && fvTxt.includes('次のNAORUへ。'));
check('理念の言葉が出る', fvTxt.includes('元気な社会を創造する。'));
check('肩書きが出る', fvTxt.includes('NAORU NEWS / ONE TEAM'));
check('しめの言葉が出る', fvTxt.includes('ともにつくる。'));
check('写真が未設定でも成り立つ（空の面にしない）', (await page.locator('[data-news-fv-noimg]').count()) === 1);
check('🔴 「お知らせを投稿」が押せる形で出ている', (await page.locator('[data-news-fv-post]').count()) === 1);
await page.locator('[data-news-fv-post]').first().click();
await page.waitForTimeout(900);
check('🔴 「お知らせを投稿」から投稿の画面が開く', (await page.locator('[data-nowl-modal="compose"]').count()) === 1);
await page.keyboard.press('Escape');
await page.waitForTimeout(700);

// 写真の差し替え（本部だけ）
check('本部には「写真と言葉を変える」が出る', (await page.locator('[data-news-fv-edit]').count()) === 1);
await page.locator('[data-news-fv-edit]').first().click();
await page.waitForTimeout(700);
check('差し替えの画面が開く', (await page.locator('[data-nowl-modal="hero"]').count()) === 1);
check('写真が無いうちは掲載許可の確認を出さない', (await page.locator('[data-news-hero-consent]').count()) === 0);
await page.locator('[data-news-hero-pick] input[type="file"]').first().setInputFiles({
  name: 'team.png', mimeType: 'image/png', buffer: Buffer.from(PNG_1PX, 'base64'),
});
await page.waitForTimeout(1500);
check('🔴 写真を入れると掲載許可の確認が出る', (await page.locator('[data-news-hero-consent]').count()) === 1);
check('🔴 許可を確かめるまで保存できない', (await page.locator('[data-news-hero-save]').first().isDisabled()) === true);
await page.locator('[data-news-hero-title]').first().fill('この仲間と、\n次のNAORUへ。');
await page.locator('[data-news-hero-consent] input[type="checkbox"]').first().check();
await page.waitForTimeout(500);
check('許可を確かめると保存できるようになる', (await page.locator('[data-news-hero-save]').first().isDisabled()) === false);
await page.locator('[data-news-hero-save]').first().click();
await page.waitForTimeout(1800);
check('保存すると差し替えの画面が閉じる', (await page.locator('[data-nowl-modal="hero"]').count()) === 0);
check('サーバーに写真と掲載許可が届いている', !!(hero && hero.imgId) && hero.consent === true);
await page.evaluate(() => { window.scrollTo(0, 0); for (const el of document.querySelectorAll('*')) { if (el.scrollTop > 0) el.scrollTop = 0; } });
await page.waitForTimeout(700);
check('写真が出るようになる（「まだ設定されていません」が消える）', (await page.locator('[data-news-fv-noimg]').count()) === 0);

// ── 下書き → 下見 → 投稿 ──────────────────────────────────
await page.getByRole('button', { name: /お知らせを投稿/ }).first().click();
await page.waitForTimeout(800);
check('投稿の画面が開く', (await page.locator('[data-nowl-modal="compose"]').count()) === 1);
check('「入力／下見」の切り替えが出る', (await page.locator('[data-news-composer-tabs]').count()) === 1);
await page.locator('input[placeholder*="9月の運営連絡"]').first().fill('下書きの見出しです');
await page.locator('textarea[placeholder*="ニュースの内容"]').first().fill('これは下書きの本文です。');
await page.waitForTimeout(400);

// 下見
await page.locator('[data-news-composer-tab="preview"]').first().click();
await page.waitForTimeout(700);
check('下見に切り替わる', (await page.locator('[data-news-preview]').count()) === 1);
const pvText = await page.locator('[data-news-preview]').first().innerText().catch(() => '');
check('下見に、いま書いた見出しが出る', pvText.includes('下書きの見出しです'), '');
check('下見に、いま書いた本文が出る', pvText.includes('これは下書きの本文です。'));
check('下見は「まだ公開されていない」と書いてある', pvText.includes('まだ誰にも公開されていません'));
const pvClickable = await page.locator('[data-news-preview] [data-news-card]').first()
  .evaluate(el => getComputedStyle(el.closest('div[style]') || el).pointerEvents).catch(() => '');
check('下見は押しても動かない（見るだけ）', pvClickable === 'none', pvClickable);

// 下書きに保存
await page.locator('[data-news-composer-tab="edit"]').first().click();
await page.waitForTimeout(400);
await page.locator('[data-news-save-draft]').first().click();
await page.waitForTimeout(1500);
check('保存すると投稿の画面が閉じる', (await page.locator('[data-nowl-modal="compose"]').count()) === 0);
check('下書きの帯が出る', (await page.locator('[data-news-drafts]').count()) === 1);
const draftTxt = await page.locator('[data-news-drafts]').first().innerText().catch(() => '');
check('下書きの見出しが帯に出る', draftTxt.includes('下書きの見出しです'));
check('「あなたと本部にだけ見えています」と書いてある', draftTxt.includes('あなたと本部にだけ見えています'));
check('下書きは一覧に混ざらない', (await page.locator('[data-news-card]').count()) === 12, `${await page.locator('[data-news-card]').count()} 件`);
const savedDraft = posts.find(x => x.status === 'draft');
check('サーバーには下書きとして届いている', !!savedDraft && savedDraft.title === '下書きの見出しです');
check('下書きの保存で通知を送っていない', !calls.some(c => c.body && c.body.action === 'post' && c.body.post && c.body.post.status !== 'draft'));

// 書き直す
await page.locator('[data-news-draft-edit]').first().click();
await page.waitForTimeout(900);
const reopened = await page.locator('input[placeholder*="9月の運営連絡"]').first().inputValue().catch(() => '');
check('「書き直す」で、書いた内容が戻ってくる', reopened === '下書きの見出しです', reopened);
await page.locator('input[placeholder*="9月の運営連絡"]').first().fill('書き直した見出しです');
await page.waitForTimeout(300);
await page.locator('[data-news-publish]').first().click();
await page.waitForTimeout(1800);
check('下書きから投稿できる', (await page.locator('[data-news-drafts]').count()) === 0);
const published = posts.find(x => x.title === '書き直した見出しです');
check('書き直した内容で公開されている', !!published && published.status === 'published');
check('公開の前に書き直しを保存している', calls.some(c => c.body && c.body.action === 'editDraft'));
t = await txt();
check('投稿した記事が一覧に出る', t.includes('書き直した見出しです'));

// ── スマホ ──────────────────────────────────────────────
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(900);
const overflow = await page.evaluate(() => {
  const out = [];
  const root = document.querySelector('[data-nowl="news"]');
  if (!root) return ['ニュースの枠が無い'];
  const inScroller = (el) => {
    for (let p = el.parentElement; p && p !== root.parentElement; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
    return false;
  };
  for (const el of root.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || inScroller(el)) continue;
    if (r.right > window.innerWidth + 1 || r.left < -1) out.push(`${el.className || el.tagName} ${Math.round(r.left)}..${Math.round(r.right)}`);
  }
  return [...new Set(out)].slice(0, 6);
});
check('スマホで画面からはみ出さない', overflow.length === 0, overflow.join(' / '));
const small = await page.evaluate(() => {
  const bad = [];
  for (const el of document.querySelectorAll('[data-nowl="news"] button, [data-nowl="news"] a[href]')) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.height < 32) bad.push((el.innerText || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 18));
  }
  return [...new Set(bad)];
});
check('スマホで押しにくい小さなボタンが無い', small.length === 0, small.join(' / '));
const out = process.env.OUT_DIR || '/tmp';
await page.screenshot({ path: `${out}/news-draft-mobile.png`, fullPage: false });
await page.setViewportSize({ width: 1600, height: 1000 });
await page.waitForTimeout(700);
await page.screenshot({ path: `${out}/news-draft.png`, fullPage: false });
check('画面の写しを保存した', fs.existsSync(`${out}/news-draft.png`), `${out}/news-draft.png`);
check('画面のエラーが出ていない', errors.length === 0, errors.slice(0, 2).join(' | '));

const ok = results.filter(r => r.pass).length;
console.log(`\n  結果: ${ok}/${results.length}`);
if (ok !== results.length) { console.log('  NG:'); results.filter(r => !r.pass).forEach(r => console.log(`   - ${r.name} ${r.detail}`)); }
await browser.close(); server.close();
process.exit(ok === results.length ? 0 : 1);
