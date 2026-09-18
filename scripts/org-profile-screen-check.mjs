// ── 組織図・自己紹介の項目 の画面レベル検証 ──────────────────────────
// 「ひとこと・得意なこと・学びたいこと・趣味」を編集・表示し、検索で当てられるか。
// ⚠️ 本番には一切つながりません。ローカルのスタブAPIに対してだけ動かします。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');

const ROOT = process.env.DASHBOARD_ROOT || process.cwd();
const CDN = process.env.CDN_DIR || '/tmp/cdn';
const PORT = 8967;
const TYPES = { '.html':'text/html;charset=utf-8', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml' };

const SHOPS = [{ id: 1, name: 'NAORU 鶴見院' }, { id: 2, name: 'NAORU 関内院' }];
const STAFFS = [
  { id: '101', name: '青木ひかる', shop_id: 1 },
  { id: '102', name: '石田なつ', shop_id: 1 },
  { id: '103', name: '上野かい', shop_id: 2 },
];
let profiles = {
  '101': { pid: '101', kind: 'therapist', nameKanji: '青木ひかる', bio: '', oneLine: '産後ケアが得意です',
           goodAt: ['骨盤矯正', '産後ケア'], learning: ['栄養'], hobbies: ['サウナ'], shops: ['NAORU 鶴見院'] },
  '103': { pid: '103', kind: 'therapist', nameKanji: '上野かい', bio: '', goodAt: ['肩こり'], hobbies: ['ゴルフ'], shops: ['NAORU 関内院'] },
};
const calls = [];
const json = (res, o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch {}
    const p = url.pathname;
    if (p.startsWith('/api/')) calls.push({ path: p, q: Object.fromEntries(url.searchParams), body, method: req.method, headers: req.headers });
    if (p === '/api/settlement-auth') {
      if (req.method === 'GET') return json(res, { ok: true, shops: {} });
      return json(res, { ok: true, token: 'stub', owner: '__root__', root: true, role: 'root' });
    }
    if (p === '/api/plan-store') {
      const type = req.method === 'GET' ? url.searchParams.get('type') : body.type;
      if (type === 'ccflags') return json(res, { flags: { cc_all: true, cc_authz: 'off' }, configured: true, env: 'preview' });
      if (type === 'profile') {
        if (req.method === 'POST' && body.action === 'save') {
          profiles = { ...profiles, [body.pid]: { ...(profiles[body.pid] || {}), pid: body.pid, ...body.profile } };
          return json(res, { ok: true, profile: profiles[body.pid] });
        }
        if (req.method === 'POST') return json(res, { ok: true });
        return json(res, { profiles, hidden: [], configured: true });
      }
      if (type === 'chat') return json(res, { rooms: [], messages: {}, reads: {}, dir: { staff: [] }, notes: {}, configured: true });
      return json(res, { ok: true, configured: true });
    }
    if (p.startsWith('/api/salonone')) {
      if (/staff/i.test(req.url)) return json(res, { data: STAFFS, meta: {} });
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

await page.getByRole('button', { name: /組織図/ }).first().click().catch(() => {});
await page.waitForTimeout(3000);
check('組織図が開く', (await txt()).includes('青木ひかる') || (await txt()).includes('鶴見'));

// ⭐ 検索: 得意分野・趣味で当たる
const search = page.locator('input[placeholder*="検索"]').first();
check('検索欄の説明が新しくなっている', /得意分野|趣味/.test(await search.getAttribute('placeholder') || ''),
  await search.getAttribute('placeholder'));
await search.fill('骨盤');
await page.waitForTimeout(1200);
let t = await txt();
check('得意分野「骨盤」で青木が出る', t.includes('青木ひかる'), '');
if (process.env.DUMP) { console.log('--- 骨盤で検索したときの画面 ---'); console.log(t.slice(0, 700)); }
check('関係ない人は出ない', !t.includes('石田なつ'));
await search.fill('ゴルフ');
await page.waitForTimeout(1200);
t = await txt();
check('趣味「ゴルフ」で上野が出る', t.includes('上野かい'));
await search.fill('さうな');
await page.waitForTimeout(1200);
check('ひらがな「さうな」でも当たる（カナの違いを吸収）', (await txt()).includes('青木ひかる'));
await search.fill('');
await page.waitForTimeout(1200);

// ⭐ プロフィールカードに項目が出る
await page.getByText('青木ひかる', { exact: false }).first().click().catch(() => {});
await page.waitForTimeout(1500);
const oneline = page.locator('[data-prof-oneline-view]');
check('カードに「ひとこと」が出る', (await oneline.count()) > 0, await oneline.first().innerText().catch(() => ''));
check('「得意なこと・相談できること」が出る', (await page.locator('[data-prof-tags="goodAt"]').count()) > 0);
check('「趣味・好きなこと」が出る', (await page.locator('[data-prof-tags="hobbies"]').count()) > 0);
check('タグの中身が出る', (await txt()).includes('骨盤矯正') && (await txt()).includes('サウナ'));

// ⭐ 編集で追加できる
await page.getByRole('button', { name: /^編集$|本部編集/ }).first().click().catch(() => {});
await page.waitForTimeout(1500);
check('編集画面に「ひとこと」欄がある', (await page.locator('[data-prof-oneline]').count()) > 0);
check('3つのタグ欄がある', (await page.locator('[data-prof-tagfield]').count()) === 3);
await page.locator('[data-prof-oneline]').first().fill('よろしくお願いします');
// 候補ボタンで趣味を足す
await page.locator('[data-prof-tagfield="hobbies"] button', { hasText: '＋キャンプ' }).first().click().catch(() => {});
await page.waitForTimeout(600);
check('候補を押すとタグが入る', (await page.locator('[data-prof-tagfield="hobbies"]').first().innerText().catch(() => '')).includes('キャンプ'));
// 自由入力でも足す
await page.locator('[data-prof-taginput="learning"]').first().fill('簿記');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
check('自由入力でもタグが入る', (await page.locator('[data-prof-tagfield="learning"]').first().innerText().catch(() => '')).includes('簿記'));

await page.getByRole('button', { name: /保存/ }).first().click().catch(() => {});
await page.waitForTimeout(2500);
const saved = calls.filter(c => c.body && c.body.type === 'profile' && c.body.action === 'save').pop();
check('サーバーへ保存された', !!saved);
check('ひとこと・趣味・学びたいことが送られた',
  !!saved && saved.body.profile.oneLine === 'よろしくお願いします'
  && (saved.body.profile.hobbies || []).includes('キャンプ')
  && (saved.body.profile.learning || []).includes('簿記'),
  saved ? JSON.stringify({ o: saved.body.profile.oneLine, h: saved.body.profile.hobbies, l: saved.body.profile.learning }) : '');
check('⚠️ 認証ヘッダが付いている（サーバーが本人を確かめられる）',
  !!saved && !!(saved.headers['x-cc-owner'] || saved.headers['authorization']),
  saved ? Object.keys(saved.headers).filter(k => k.startsWith('x-cc')).join(',') : '');
check('⚠️ 役割や社員IDを送っていない', !!saved && saved.body.profile.role === undefined && saved.body.root === undefined);

// ── デザイン（UI試作V3）──────────────────────────────────────────
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(1200);
check('組織図に V3 の見た目が当たっている', (await page.locator('[data-nowl="org"]').count()) > 0);
const tokens = await page.evaluate(() => {
  const el = document.querySelector('[data-nowl="org"]');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { red: cs.getPropertyValue('--nowl-red').trim(), ink: cs.getPropertyValue('--nowl-ink').trim() };
});
check('試作の赤と墨黒が使われている', !!tokens && tokens.red === '#b92d3d' && tokens.ink === '#18191c', JSON.stringify(tokens));

// スタッフのカードが列で並ぶ（PC4列・中間3列・スマホ2列）
const cols = async (w) => {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(700);
  return page.evaluate(() => {
    const g = document.querySelector('.nowl-people');
    if (!g) return 0;
    return getComputedStyle(g).gridTemplateColumns.split(' ').filter(Boolean).length;
  });
};
const c390 = await cols(390), c768 = await cols(768), c1440 = await cols(1440);
check('スマホ(390px)は2列', c390 === 2, String(c390));
check('中間(768px)は3列', c768 === 3, String(c768));
check('PC(1440px)は4列', c1440 === 4, String(c1440));
check('横に溢れていない（390px）', await (async () => {
  await page.setViewportSize({ width: 390, height: 900 }); await page.waitForTimeout(700);
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
})());
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(700);

// ポップアップ: Escape で閉じ、フォーカスが戻る
await page.getByText('青木ひかる', { exact: false }).first().click().catch(() => {});
await page.waitForTimeout(1200);
await page.getByRole('button', { name: /^編集$|本部編集/ }).first().click().catch(() => {});
await page.waitForTimeout(1200);
check('プロフィール編集がぼかし付きで開く', (await page.locator('[data-nowl-modal="profile"]').count()) > 0);
await page.keyboard.press('Escape');
await page.waitForTimeout(1000);
check('Escape で閉じられる', (await page.locator('[data-nowl-modal="profile"]').count()) === 0);
check('閉じたあとフォーカスが本文に戻っている',
  await page.evaluate(() => document.activeElement && document.activeElement !== document.body));

check('JSエラーが出ていない', errors.length === 0, errors.slice(0, 2).join(' / '));
await page.screenshot({ path: (process.env.OUT_DIR || '/tmp') + '/org-profile-screen.png', fullPage: false });
await browser.close(); server.close();
const ng = results.filter(r => !r.pass);
console.log(`\n${results.length - ng.length}/${results.length} OK`);
process.exit(ng.length ? 1 : 0);
