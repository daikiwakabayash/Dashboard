// ── 組織図（地図つきの地域ビュー）の画面レベル検証 ─────────────────
// 地域ごとの帯・飾りの地図・索引・開閉・検索・スマホ表示を実ブラウザで確認する。
// ⚠️ 本番には一切つながりません。ローカルのスタブAPIに対してだけ動かします。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');

const ROOT = process.env.DASHBOARD_ROOT || process.cwd();
const CDN = process.env.CDN_DIR || '/tmp/cdn';
const PORT = 8977;
const TYPES = { '.html':'text/html;charset=utf-8', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml' };

// 架空の店舗（本番データではありません）
const SHOPS = [
  { id: 1, name: 'NAORU 札幌院' }, { id: 2, name: 'NAORU 札幌白石院' },
  { id: 3, name: 'NAORU 仙台院' }, { id: 4, name: 'NAORU 山形院' },
  { id: 5, name: 'NAORU 渋谷院' }, { id: 6, name: 'NAORU 新宿院' }, { id: 7, name: 'NAORU 池袋院' },
  { id: 8, name: 'NAORU 名古屋院' }, { id: 9, name: 'NAORU 梅田院' },
  { id: 10, name: 'NAORU 広島院' }, { id: 11, name: 'NAORU 高松院' },
  { id: 12, name: 'NAORU 博多院' }, { id: 13, name: 'NAORU 那覇院' },
  { id: 14, name: 'NAORU Sydney' }, { id: 15, name: 'NAORU KLCC' },
  { id: 16, name: 'NAORU 新店' },
];
// ⚠️ 既存のプロフィール固定データ（101〜103）と重ならないIDにする
const STAFFS = SHOPS.flatMap((s, i) => [
  { id: `${500 + i * 2}`, name: `青木${i}`, shop_id: s.id },
  { id: `${501 + i * 2}`, name: `石田${i}`, shop_id: s.id },
]);
// 本部メンバー（accountmeta の role==='hq'）
const HQ = { '本部 花子': { role: 'hq', staffName: '本部 花子', staffId: '900' },
             '本部 太郎': { role: 'hq', staffName: '本部 太郎', staffId: '901' } };
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
      if (type === 'accountmeta') return json(res, { meta: HQ, configured: true });
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
const OUT = process.env.OUT_DIR || '/tmp';

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'commit', timeout: 60000 });
for (let i = 0; i < 40; i++) { if ((await txt()).trim().length > 40) break; await page.waitForTimeout(1000); }
const pw = page.locator('input[type="password"]');
if (await pw.count()) { await pw.first().fill(process.env.STUB_PW || 'pw'); await page.keyboard.press('Enter'); await page.waitForTimeout(3000); }
check('rootでログインできる', (await page.locator('input[type="password"]').count()) === 0);

await page.getByRole('button', { name: /組織図/ }).first().click().catch(() => {});
await page.waitForTimeout(3000);
let t = await txt();

check('組織図が開く', t.includes('組織図') && t.includes('全国のチームを、もっと身近に'));

// ── 地域の帯 ────────────────────────────────────────────
const bands = await page.locator('[data-org-band]').count();
check('地域ごとの帯が出る', bands >= 9, `${bands} 地域`);
for (const [key, ja] of [['hokkaido', '北海道'], ['tohoku', '東北'], ['kanto', '関東'], ['chubu', '中部'],
                         ['kansai', '関西'], ['chugoku', '中国'], ['shikoku', '四国'], ['kyushu', '九州'],
                         ['okinawa', '沖縄'], ['australia', 'オーストラリア'], ['malaysia', 'マレーシア'], ['hq', '本部']]) {
  const n = await page.locator(`[data-org-band="${key}"]`).count();
  if (!n) { check(`${ja} の帯が出る`, false, 'なし'); }
}
check('北海道から沖縄・海外・本部まで出る',
  (await page.locator('[data-org-band="hokkaido"]').count()) === 1 &&
  (await page.locator('[data-org-band="okinawa"]').count()) === 1 &&
  (await page.locator('[data-org-band="australia"]').count()) === 1 &&
  (await page.locator('[data-org-band="malaysia"]').count()) === 1 &&
  (await page.locator('[data-org-band="hq"]').count()) === 1);
check('「関西」という呼び名で出す（近畿ではなく）', t.includes('関西') && !t.includes('近畿'));
check('英字の地域名も出る', t.includes('HOKKAIDO') && t.includes('KANSAI') && t.includes('HEADQUARTERS'));

// 地図が実際に描かれている
const maps = await page.locator('.org-map path').count();
check('飾りの地図が描かれている', maps >= 9, `${maps} 枚`);
const box = await page.locator('[data-org-band="hokkaido"] .org-map').first().boundingBox();
check('地図に大きさがある（潰れていない）', !!box && box.width > 40 && box.height > 40, box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'なし');
check('🔴 組織図に「当月売上で絞る」を出さない', !(await txt()).includes('当月売上で絞る'));
check('🔴 「正確な地図ではない」と画面に書いてある', t.includes('位置や距離を正確に示すものではありません'));

// ── 索引 ────────────────────────────────────────────────
check('REGION INDEX が出る', (await page.locator('[data-org-index]').count()) === 1 && t.includes('REGION INDEX'));
const idx = await page.locator('[data-org-index-item]').count();
check('索引に地域が並ぶ', idx >= 9, `${idx} 件`);

// ── 店舗とスタッフ ──────────────────────────────────────
check('店舗カードが出る', (await page.locator('[data-org-shop]').count()) >= 10);
check('スタッフ名が出る', t.includes('青木0') && t.includes('石田0'));
check('店舗ごとのスタッフ数が出る', /スタッフ \d+名/.test(t));

// ── 開閉（店舗が多い地域）────────────────────────────────
await page.evaluate(() => { const b = document.querySelector('[data-org-band="kanto"]'); if (b) b.scrollIntoView(); });
await page.waitForTimeout(500);
check('店舗が少ない地域は最初から開いている', (await page.locator('[data-org-band="hokkaido"] [data-org-shop]').count()) === 2);

// ── 検索 ────────────────────────────────────────────────
await page.locator('input[placeholder*="名前・店舗"]').first().fill('那覇');
await page.waitForTimeout(900);
check('店舗名で絞れる', (await page.locator('[data-org-band]').count()) === 1
  && (await page.locator('[data-org-band="okinawa"]').count()) === 1);
await page.locator('input[placeholder*="名前・店舗"]').first().fill('');
await page.waitForTimeout(900);
check('検索を消すと元に戻る', (await page.locator('[data-org-band]').count()) >= 9);

// ── スマホ ──────────────────────────────────────────────
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(800);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check('スマホで横スクロールが出ない', !overflow);
const wide = await page.evaluate(() => {
  const out = [];
  const root = document.querySelector('[data-nowl="org"]');
  if (!root) return ['組織図の枠が無い'];
  // 横スクロールできる帯（地域インデックス）の中身は、はみ出していて正しい
  const inScroller = (el) => {
    for (let p = el.parentElement; p && p !== root.parentElement; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
    return false;
  };
  for (const el of root.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width < 1) continue;
    if (inScroller(el)) continue;
    if (r.right > window.innerWidth + 1 || r.left < -1) out.push(`${el.className || el.tagName} ${Math.round(r.left)}..${Math.round(r.right)}`);
  }
  return [...new Set(out)].slice(0, 6);
});
check('スマホで組織図の部品が画面からはみ出さない', wide.length === 0, wide.join(' / '));
const cols = await page.locator('.org-band-body').first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
check('スマホでは店舗が1列に並ぶ', cols === 1, `${cols} 列`);
const small = await page.evaluate(() => {
  const bad = [];
  for (const el of document.querySelectorAll('button, a[href], input, select')) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const b = el.tagName === 'INPUT' && el.closest('label') ? el.closest('label').getBoundingClientRect() : r;
    if (b.height < 32) bad.push((el.innerText || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 18));
  }
  return [...new Set(bad)];
});
check('スマホで押しにくい小さなボタンが無い', small.length === 0, small.slice(0, 4).join(' / '));
await page.screenshot({ path: path.join(OUT, 'org-map-mobile.png'), fullPage: true });

await page.setViewportSize({ width: 1440, height: 1000 });
await page.waitForTimeout(700);
await page.screenshot({ path: path.join(OUT, 'org-map.png'), fullPage: true });
check('画面の写しを保存した', true, path.join(OUT, 'org-map.png'));
check('画面のエラーが出ていない', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close(); server.close();
const ng = results.filter(r => !r.pass);
console.log(`\n  結果: ${results.length - ng.length}/${results.length}`);
if (ng.length) { console.log('  NG:'); for (const r of ng) console.log('   -', r.name, r.detail); }
process.exit(ng.length ? 1 : 0);
