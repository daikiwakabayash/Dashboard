// ── ニュース記事のイベントリンク → グループチャット参加 の画面レベル検証 ──
// 「沖縄のイベント告知をニュースに出し、読んだ人が参加ボタンでグループへ入る」を
// **本物の index.html** を headless Chromium で操作して確認する。
// ⚠️ 本番には一切つながりません。ローカルのスタブAPIに対してだけ動かします。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');

const ROOT = process.env.DASHBOARD_ROOT || process.cwd();
const CDN = process.env.CDN_DIR || '/tmp/cdn';
const PORT = 8966;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES = { '.html':'text/html;charset=utf-8', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml' };

const rooms = [
  { id: 'announce_all', kind: 'announce', name: '全社ニュース', shop: '', members: [] },
  { id: 'room_okn', kind: 'group', name: '沖縄セミナー 10/5', icon: '📅', members: ['s1'] },   // __root__ は未参加
  { id: 'room_joined', kind: 'group', name: '参加済みイベント', icon: '📅', members: ['__root__', 's1'] },
];
const evSections = {
  '勉強会': [
    { id: 'row_okinawa', cells: { date: '2026-10-05', chatTitle: '沖縄セミナー 10/5', roomId: 'room_okn', ownerId: 's1' } },
    { id: 'row_nochat',  cells: { date: '2026-11-01', chatTitle: 'まだ部屋なし' } },
    { id: 'row_joined',  cells: { date: '2026-09-30', chatTitle: '参加済みイベント', roomId: 'room_joined' } },
  ],
};
const posts = [
  { id: 'p1', authorId: 's1', authorName: '本部', authorShop: '本部', title: '【沖縄】10/5セミナー開催のお知らせ',
    text: `沖縄でセミナーを開催します。\n詳細と参加はこちら ${ORIGIN}/?tab=events&ev=row_okinawa\n`
        + `こちらはまだ部屋なし ${ORIGIN}/?tab=events&ev=row_nochat\n`
        + `参加済みの例 ${ORIGIN}/?tab=events&ev=row_joined\n`
        + `消えたイベント ${ORIGIN}/?tab=events&ev=row_deleted\n`
        + `外部リンク https://evil.example/?tab=events&ev=row_okinawa`,
    comments: [], reactions: {}, imgIds: [], files: [], createdAt: '2026-09-18T01:00:00.000Z' },
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
        if (req.method === 'POST') return json(res, { ok: true, posts });
        return json(res, { posts, reads: {}, configured: true });
      }
      if (type === 'events') {
        if (req.method === 'POST') return json(res, { ok: true, sections: evSections });
        return json(res, { sections: evSections, configured: true });
      }
      if (type === 'chat') {
        if (req.method === 'POST' && body.action === 'join' && body.roomId) {
          const r = rooms.find(x => x.id === body.roomId);
          if (r && !r.members.includes(String(body.staffId))) r.members.push(String(body.staffId));
          return json(res, { ok: true, rooms });
        }
        if (req.method === 'POST') return json(res, { ok: true });
        return json(res, { rooms, messages: {}, reads: {}, dir: { staff: [] }, notes: {}, configured: true });
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
console.log('  stub self-check:', (await fetch(`${ORIGIN}/`)).status);

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-proxy-server', '--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({ serviceWorkers: 'block', permissions: [] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
const localJs = (f) => ({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(f) });
await page.route(/.*/, route => {
  const u = route.request().url();
  if (u.startsWith(ORIGIN)) return route.continue();
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

await page.goto(`${ORIGIN}/`, { waitUntil: 'commit', timeout: 60000 });
for (let i = 0; i < 40; i++) { if ((await txt()).trim().length > 40) break; await page.waitForTimeout(1000); }
const pw = page.locator('input[type="password"]');
if (await pw.count()) { await pw.first().fill(process.env.STUB_PW || 'pw'); await page.keyboard.press('Enter'); await page.waitForTimeout(3000); }
check('rootでログインできる', (await page.locator('input[type="password"]').count()) === 0);

// メニュー名が「ニュース」になっている
check('メニューが「ニュース」になっている', (await page.getByText('ニュース', { exact: false }).count()) > 0);
check('「掲示板」「お知らせ」が画面に残っていない', !(await txt()).includes('掲示板') && !(await txt()).includes('お知らせ'));

await page.getByRole('button', { name: /ニュース/ }).first().click().catch(() => {});
await page.waitForTimeout(3000);
check('ニュースの画面が開く', (await txt()).includes('10/5セミナー開催'));

// ⭐ イベントリンクが解決されている
const panel = page.locator('[data-news-events]').first();
check('記事にイベントの案内が出る', (await panel.count()) > 0);
const ptxt = await panel.innerText().catch(() => '');
check('イベント名と日付が出る', ptxt.includes('沖縄セミナー 10/5') && ptxt.includes('2026-10-05'), ptxt.split('\n').slice(0, 2).join(' / '));
check('未参加のイベントは「参加」', ptxt.includes('グループチャットへ参加'));
check('参加済みのイベントは「開く」', ptxt.includes('グループチャットを開く'));
check('グループ未作成は「まだありません」と出る（勝手に作らない）', ptxt.includes('まだグループチャットがありません'));
check('削除済みは「見つかりません」と出る', ptxt.includes('見つかりません'));
check('⚠️ 外部リンクは案内に出ない（外部を読みに行かない）', !ptxt.includes('evil.example'));

// ⭐ 参加ボタンを押す
const before = rooms.find(r => r.id === 'room_okn').members.slice();
check('押す前は未参加', !before.includes('__root__'), JSON.stringify(before));
await page.locator('[data-news-join="row_okinawa"]').first().click();
await page.waitForTimeout(3000);
const joined = calls.filter(c => c.body && c.body.type === 'chat' && c.body.action === 'join');
check('サーバーへ参加が送られた', joined.length === 1, String(joined.length));
check('送り先は沖縄イベントのルーム', joined.length === 1 && joined[0].body.roomId === 'room_okn',
  joined.length ? String(joined[0].body.roomId) : '');
check('⚠️ 参加したのは押した本人だけ',
  rooms.find(r => r.id === 'room_okn').members.join(',') === 's1,__root__',
  rooms.find(r => r.id === 'room_okn').members.join(','));
check('他のイベントのルームは変わっていない',
  rooms.find(r => r.id === 'room_joined').members.join(',') === '__root__,s1');
check('⚠️ 新しいルームは作られていない', !calls.some(c => c.body && c.body.action === 'createRoom'));
check('参加後はチャット画面へ移動する', (await txt()).includes('沖縄セミナー 10/5'));

check('JSエラーが出ていない', errors.length === 0, errors.slice(0, 2).join(' / '));
await page.screenshot({ path: (process.env.OUT_DIR || '/tmp') + '/news-event-screen.png', fullPage: false });
await browser.close(); server.close();
const ng = results.filter(r => !r.pass);
console.log(`\n${results.length - ng.length}/${results.length} OK`);
process.exit(ng.length ? 1 : 0);
