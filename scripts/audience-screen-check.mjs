// ── 送信先の絞り込み（エリア／未読）の画面レベル検証 ─────────────────────
// 「チャットを開く → 新しいルーム → 神奈川県を選ぶ → 対象者の氏名が出る →
//   メンバーに入る → 『大阪以外』に切り替わる」までを、**本物の index.html** を
// headless Chromium で実際にクリックして確認する。
// ⚠️ 本番には一切つながりません。ローカルのスタブAPIに対してだけ動かします。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');

const ROOT = process.env.DASHBOARD_ROOT || process.cwd();
const CDN = process.env.CDN_DIR || '/tmp/cdn';
const PORT = 8964;
const TYPES = { '.html':'text/html;charset=utf-8', '.js':'text/javascript', '.mjs':'text/javascript',
  '.css':'text/css', '.json':'application/json', '.webmanifest':'application/manifest+json',
  '.png':'image/png', '.svg':'image/svg+xml', '.jpg':'image/jpeg' };

// 架空のスタッフ。所属店舗は実在の店名に寄せる（地名からエリアを推定するため）。
const STAFF = [
  { id: 's1', name: '青木ひかる', shop: 'NAORU 関内院' },       // 神奈川
  { id: 's2', name: '石田なつ',   shop: 'NAORU 武蔵小杉院' },   // 神奈川
  { id: 's3', name: '上野かい',   shop: 'NAORU 溝の口院' },     // 神奈川
  { id: 's4', name: '江川りん',   shop: 'NAORU 渋谷院' },       // 東京
  { id: 's5', name: '大西そら',   shop: 'NAORU 大阪京橋院' },   // 大阪
  { id: 's6', name: '加藤みお',   shop: 'NAORU 江坂院' },       // 大阪
  { id: 's7', name: '木下ゆう',   shop: 'NAORU 博多院' },       // 福岡
];
const MSG_AT = '2026-09-18T09:00:00.000Z';
const MSG_MS = Date.parse(MSG_AT);
const rooms = [
  { id: 'announce_all', kind: 'announce', name: '全社アナウンス', shop: '', members: [] },
  { id: 'g_kanagawa', kind: 'group', name: '神奈川県（3名）', shop: '', members: ['__root__', 's1', 's2', 's3'], createdBy: '__root__' },
];
// 本部が神奈川ルームへ送った1件。青木だけが既読、石田・上野は未読。
const messages = { g_kanagawa: [{ id: 'm1', roomId: 'g_kanagawa', fromStaffId: '__root__', fromName: '管理者', fromShop: '本部',
  text: '来週の研修は木曜10時からです。必ず確認してください。', imgIds: [], media: [], mentions: [], reactions: {}, createdAt: MSG_AT }] };
const reads = { s1: { g_kanagawa: MSG_MS + 60000 }, s2: { g_kanagawa: MSG_MS - 60000 } };   // s3 は reads 自体なし
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
      if (type === 'ccflags') return json(res, { flags: { cc_all: true, cc_authz: 'off' }, configured: true, env: 'preview' });
      if (type === 'chat') {
        if (req.method === 'POST' && body.action === 'createRoom' && body.room) {
          rooms.push({ ...body.room, id: body.room.id || ('room_' + rooms.length) });
          return json(res, { ok: true, rooms });
        }
        if (req.method === 'POST' && body.action === 'send' && body.roomId) {
          const rec = { id: 'm' + (Date.now() % 100000), roomId: body.roomId, reactions: {}, createdAt: new Date().toISOString(), ...body.msg };
          (messages[body.roomId] = messages[body.roomId] || []).push(rec);
          return json(res, { ok: true, message: rec });
        }
        if (req.method === 'POST') return json(res, { ok: true });
        return json(res, { rooms, messages, reads, dir: { staff: STAFF }, notes: {}, configured: true });
      }
      return json(res, { ok: true, configured: true });
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
    body: 'export const upload=async()=>{throw new Error("stub");};' });
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

// チャットを開く
await page.getByRole('button', { name: /チャット/ }).first().click().catch(async () => {
  await page.getByText('チャット', { exact: true }).first().click().catch(() => {});
});
await page.waitForTimeout(2500);
check('チャットの画面が開く', (await page.getByText('全社アナウンス').count()) > 0);

// 新しいルーム
await page.getByRole('button', { name: /新しいルーム|新規|＋/ }).first().click().catch(() => {});
await page.waitForTimeout(1200);
if (!(await page.getByText('新しいルーム').count())) {
  await page.locator('button[title*="ルーム"], button[aria-label*="ルーム"]').first().click().catch(() => {});
  await page.waitForTimeout(1200);
}
check('「新しいルーム」が開く', (await page.getByText('新しいルーム').count()) > 0);
check('「エリアでまとめて選ぶ」が出る', (await page.getByText('エリアでまとめて選ぶ').count()) > 0);

// 都道府県ボタンが人数つきで出る
const kanagawa = page.locator('[data-aud-pref="神奈川県"]');
check('「神奈川県」が人数つきで出る', (await kanagawa.count()) > 0, (await kanagawa.first().innerText().catch(() => '')));
check('人数が実際の在籍数と合う（神奈川3名）', /神奈川県\s*3名/.test(await kanagawa.first().innerText().catch(() => '')));
check('「大阪府」も出る（2名）', /大阪府\s*2名/.test(await page.locator('[data-aud-pref="大阪府"]').first().innerText().catch(() => '')));

// ⭐ 神奈川を選ぶ → 対象者の氏名が出る
await kanagawa.first().click();
await page.waitForTimeout(600);
const preview = await page.locator('[data-aud-preview]').first().innerText().catch(() => '');
check('選ぶと「神奈川県 の 3名」と出る', /神奈川県 の 3名/.test(preview), preview.slice(0, 80));
check('対象者の氏名が出る（黙って外れる人を作らない）',
  preview.includes('青木ひかる') && preview.includes('石田なつ') && preview.includes('上野かい'));
check('大阪の人は入っていない', !preview.includes('大西そら') && !preview.includes('加藤みお'));

// ⭐ メンバーに入れる
await page.locator('[data-aud-apply]').first().click();
await page.waitForTimeout(800);
check('「3名」がメンバーに入る', (await page.getByText('3名', { exact: false }).count()) > 0);
const nameInput = page.locator('input[placeholder*="グループ名"]').first();
check('グループ名が条件から自動で入る', /神奈川県（3名）/.test(await nameInput.inputValue().catch(() => '')),
  await nameInput.inputValue().catch(() => ''));

// ⭐ 「選んだエリア以外に送る」＝大阪以外
await kanagawa.first().click();                       // 神奈川の選択を外す
await page.locator('[data-aud-pref="大阪府"]').first().click();
await page.locator('[data-aud-exclude]').first().check();
await page.waitForTimeout(600);
const excl = await page.locator('[data-aud-preview]').first().innerText().catch(() => '');
check('「大阪府 以外」の5名になる', /大阪府 以外 の 5名/.test(excl), excl.slice(0, 80));
check('大阪の2名が外れている', !excl.includes('大西そら') && !excl.includes('加藤みお'));
check('神奈川・東京・福岡の人は残る',
  excl.includes('青木ひかる') && excl.includes('江川りん') && excl.includes('木下ゆう'));

// ── ここから: まだ既読がついていない人にもう一度送る ──────────────────
// モーダルを閉じてからルームを開く（モーダル内の同名テキストを踏まないように）
await page.locator('div.fixed.inset-0.z-\\[90\\]').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
await page.waitForTimeout(900);
if (await page.getByText('新しいルーム').count()) { await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(600); }
check('「新しいルーム」を閉じられる', (await page.getByText('新しいルーム').count()) === 0);
await page.getByText('来週の研修は木曜10時から', { exact: false }).first().click().catch(() => {});
await page.waitForTimeout(2500);
check('作った神奈川ルームが開く', (await txt()).includes('来週の研修は木曜10時から'));
check('既読の人数が出る（3名中1名が既読）', (await page.getByText(/既読1\/3/).count()) > 0);
if (process.env.DUMP) {
  console.log('--- 画面テキスト(抜粋) ---');
  console.log((await txt()).slice(0, 800));
  console.log('--- 既読らしき要素 ---', await page.getByText(/既読/).count());
  console.log('--- html ---');
  const h = await page.content();
  const i = h.indexOf('来週の研修');
  console.log(h.slice(Math.max(0, i - 1500), i + 300).replace(/</g, '\n<'));
}

// 自分の投稿を右クリック＝メニュー
// ⚠️ 左のルーム一覧にも同じ本文のプレビューが出るので、吹き出し本体を指名する
const bubble = page.locator('#chatbubble-m1');
check('自分の投稿の吹き出しがある', (await bubble.count()) > 0);
await bubble.first().click({ button: 'right' }).catch(() => {});
await page.waitForTimeout(900);
if (!(await page.locator('[data-remind-unread]').count()) && process.env.DUMP) {
  console.log('--- メニュー項目 ---');
  for (const b of (await page.locator('button').all()).slice(-25)) console.log('   ', (await b.innerText().catch(() => '')).slice(0, 40));
}
const remind = page.locator('[data-remind-unread]');
check('メニューに「未読の2名にもう一度送る」が出る', (await remind.count()) > 0,
  (await remind.first().innerText().catch(() => '')));
check('既読の人は数に入っていない（3名ではなく2名）',
  /未読の2名にもう一度送る/.test(await remind.first().innerText().catch(() => '')));

// 確認ダイアログを承認して送る
page.once('dialog', d => { check('送る前に人数と氏名を確認する', /まだ読めていない 2名/.test(d.message()) && d.message().includes('石田なつ'), d.message().slice(0, 70)); d.accept(); });
await remind.first().click();
await page.waitForTimeout(2500);
const sent = calls.filter(c => c.body && c.body.type === 'chat' && c.body.action === 'send').pop();
check('サーバーへ送信された', !!sent);
check('同じルームに送る（新しいルームを作らない）', !!sent && sent.body.roomId === 'g_kanagawa',
  sent ? String(sent.body.roomId) : '');
check('未読の2名だけを@メンションする（通知が届く）',
  !!sent && (sent.body.msg.mentions || []).map(x => x.id).sort().join(',') === 's2,s3',
  sent ? JSON.stringify((sent.body.msg.mentions || []).map(x => x.id)) : '');
check('既読の人（青木）はメンションしない',
  !!sent && !(sent.body.msg.mentions || []).some(x => String(x.id) === 's1'));
check('元の本文がそのまま添えられる',
  !!sent && String(sent.body.msg.text).includes('来週の研修は木曜10時からです'));
check('再送だと分かる見出しがつく', !!sent && String(sent.body.msg.text).startsWith('🔁 まだ読めていない方へ再送します'));
check('新しいルームは作られていない', !calls.some(c => c.body && c.body.action === 'createRoom' && c.body.room && c.body.room.id !== 'g_kanagawa' && String(c.body.room.name || '').includes('未読')));

check('JSエラーが出ていない', errors.length === 0, errors.slice(0, 2).join(' / '));
await page.screenshot({ path: (process.env.OUT_DIR || '/tmp') + '/audience-screen.png', fullPage: false });
await browser.close(); server.close();
const ng = results.filter(r => !r.pass);
console.log(`\n${results.length - ng.length}/${results.length} OK`);
process.exit(ng.length ? 1 : 0);
