// ── 文章で宛先を指定して送る の画面レベル検証 ─────────────────────────
// オーナーから提示された4つの言い方を、**本物の index.html** に打ち込んで確認する。
// ⚠️ 本番には一切つながりません。ローカルのスタブAPIに対してだけ動かします。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');

const ROOT = process.env.DASHBOARD_ROOT || process.cwd();
const CDN = process.env.CDN_DIR || '/tmp/cdn';
const PORT = 8965;
const TYPES = { '.html':'text/html;charset=utf-8', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml' };

const SHOPS = [
  { id: 1, name: 'NAORU 鶴見院' }, { id: 2, name: 'NAORU 関内院' },
  { id: 3, name: 'NAORU 仙台院' }, { id: 4, name: 'NAORU 新宿院' }, { id: 5, name: 'NAORU 大阪京橋院' },
];
const STAFFS = [
  { id: 'y1', name: '八代ゆかり', shop_id: 1 }, { id: 't1', name: '小林透子', shop_id: 1 },
  { id: 'r1', name: '中村怜', shop_id: 2 },
  { id: 'z1', name: '山田孝之', shop_id: 3 }, { id: 'z2', name: '藤川球児', shop_id: 3 },
  { id: 'z3', name: '宮崎育美', shop_id: 4 },
  { id: 'q1', name: '佐藤健一', shop_id: 4 }, { id: 'q2', name: '佐藤美咲', shop_id: 5 },
];
const rooms = [
  { id: 'announce_all', kind: 'announce', name: '全社アナウンス', shop: '', members: [] },
  ...SHOPS.map(s => ({ id: `store_${s.name}`, kind: 'store', name: s.name, shop: s.name, members: [] })),
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
      if (type === 'chat') {
        if (req.method === 'POST' && body.action === 'createRoom' && body.room) {
          const r = { ...body.room, id: body.room.id || ('room_' + (rooms.length + 1)) };
          rooms.push(r); return json(res, { ok: true, room: r, rooms });
        }
        if (req.method === 'POST') return json(res, { ok: true });
        return json(res, { rooms, messages: {}, reads: {}, dir: { staff: [] }, notes: {}, configured: true });
      }
      return json(res, { ok: true, configured: true });
    }
    // SalonOne のスタッフ/店舗（宛先の名寄せ元）
    if (p.startsWith('/api/salonone')) {
      const t = url.searchParams.get('type') || url.searchParams.get('resource') || '';
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
const preview = () => page.locator('[data-rcp-preview]').first().innerText().catch(() => '');
const typeTo = async (t) => {
  await page.locator('[data-rcp-to]').first().fill(t);
  await page.waitForTimeout(700);
};

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'commit', timeout: 60000 });
for (let i = 0; i < 40; i++) { if ((await txt()).trim().length > 40) break; await page.waitForTimeout(1000); }
const pw = page.locator('input[type="password"]');
if (await pw.count()) { await pw.first().fill(process.env.STUB_PW || 'pw'); await page.keyboard.press('Enter'); await page.waitForTimeout(3000); }
check('rootでログインできる', (await page.locator('input[type="password"]').count()) === 0);

await page.getByRole('button', { name: /チャット/ }).first().click().catch(() => {});
await page.waitForTimeout(2500);
await page.locator('[data-rcp-open]').first().click().catch(() => {});
await page.waitForTimeout(1200);
check('「✍️ 文章で送る」が開く', (await page.getByText('文章で宛先を書いて送る').count()) > 0);
check('宛先と本文の欄が分かれている',
  (await page.locator('[data-rcp-to]').count()) > 0 && (await page.locator('[data-rcp-body]').count()) > 0);

// ① 神奈川の店舗すべてのグループに
await typeTo('神奈川の店舗すべてのグループに以下の文章を送ってください');
let pv = await preview();
check('①「神奈川の店舗すべてのグループに」→ 店舗グループ2件', /既存の店舗グループ 2件/.test(pv), pv.split('\n')[0]);
check('①  鶴見院・関内院が出る', pv.includes('NAORU 鶴見院') && pv.includes('NAORU 関内院'));
check('①  仙台院は入らない', !pv.includes('仙台'));

// ② 3つのグループ名を並べる
await typeTo('鶴見院と関内院と仙台院の、この3つのグループにこれを送ってください');
pv = await preview();
check('②「この3つのグループに」→ 店舗グループ3件', /既存の店舗グループ 3件/.test(pv), pv.split('\n')[0]);
check('②「この3つの」「これ」を宛先にしない', !pv.includes('見つかりませんでした'));

// ③ それぞれにDM
await typeTo('山田孝之、藤川球児、宮崎育美のそれぞれに以下の文を送ってほしい');
pv = await preview();
check('③「それぞれに」→ 一人ずつ送る 3名', /一人ずつ送る 3名/.test(pv), pv.split('\n')[0]);
check('③  3人の氏名が出る', pv.includes('山田孝之') && pv.includes('藤川球児') && pv.includes('宮崎育美'));
check('③  見つからない言葉が無い', !pv.includes('見つかりませんでした'));

// ④ 同姓は選ばせる
await typeTo('佐藤に送って');
pv = await preview();
check('④ 同じ名字が2人いると候補を出す', (await page.locator('[data-rcp-ambiguous]').count()) > 0, pv.split('\n')[0]);
check('④ 選ぶまで送信ボタンが押せない', await page.locator('[data-rcp-send]').first().isDisabled());
await page.locator('[data-rcp-ambiguous] button').first().click();
await page.waitForTimeout(600);
check('④ 候補を選ぶと宛先に入る', /一人ずつ送る 1名/.test(await preview()), (await preview()).split('\n')[0]);

// ⑤ 見つからない宛先は止める
await typeTo('存在しない人');
check('⑤ 見つからない宛先は赤字で出る', (await page.locator('[data-rcp-unknown]').count()) > 0);
check('⑤ そのままでは送れない', await page.locator('[data-rcp-send]').first().isDisabled());

// ⑥ 実際に送る（店舗グループ3件）
await typeTo('鶴見院と関内院と仙台院のグループに送って');
await page.locator('[data-rcp-body]').first().fill('来週の研修は木曜10時からです。');
await page.waitForTimeout(500);
check('⑥ 送信ボタンに件数が出る', /店舗グループ 3件に送る/.test(await page.locator('[data-rcp-send]').first().innerText().catch(() => '')));
page.once('dialog', d => { check('⑥ 送る前に宛先を確認する', d.message().includes('鶴見') && d.message().includes('仙台'), d.message().split('\n')[0]); d.accept(); });
await page.locator('[data-rcp-send]').first().click();
await page.waitForTimeout(3000);
const sent = calls.filter(c => c.body && c.body.type === 'chat' && c.body.action === 'send');
check('⑥ 3つの店舗ルームへ送られた', sent.length === 3, String(sent.length));
check('⑥ 送り先は既存の店舗ルーム（新しく作らない）',
  sent.map(c => c.body.roomId).sort().join('|') === ['store_NAORU 仙台院', 'store_NAORU 関内院', 'store_NAORU 鶴見院'].sort().join('|'),
  sent.map(c => c.body.roomId).join(' / '));
check('⑥ 新しいルームは作られていない', !calls.some(c => c.body && c.body.action === 'createRoom'));
check('⑥ 本文がそのまま送られる', sent.every(c => c.body.msg.text === '来週の研修は木曜10時からです。'));
check('⑥ 結果が画面に出る', /3件に送りました/.test(await txt()));

// ⑦ 新しくグループを作る
await typeTo('山田孝之と藤川球児でグループを作って');
await page.locator('[data-rcp-body]').first().fill('新しい部屋です。');
await page.waitForTimeout(600);
check('⑦「グループを作って」で新規作成モードになる',
  /名でグループを作って送る/.test(await page.locator('[data-rcp-send]').first().innerText().catch(() => '')));
page.once('dialog', d => d.accept());
await page.locator('[data-rcp-send]').first().click();
await page.waitForTimeout(3000);
const made = calls.filter(c => c.body && c.body.action === 'createRoom');
check('⑦ グループが1つ作られた', made.length === 1, String(made.length));
check('⑦ その2人が入っている',
  made.length === 1 && ['z1', 'z2'].every(id => (made[0].body.room.members || []).map(String).includes(id)),
  made.length ? JSON.stringify(made[0].body.room.members) : '');

check('JSエラーが出ていない', errors.length === 0, errors.slice(0, 2).join(' / '));
await page.screenshot({ path: (process.env.OUT_DIR || '/tmp') + '/recipients-screen.png', fullPage: false });
await browser.close(); server.close();
const ng = results.filter(r => !r.pass);
console.log(`\n${results.length - ng.length}/${results.length} OK`);
process.exit(ng.length ? 1 : 0);
