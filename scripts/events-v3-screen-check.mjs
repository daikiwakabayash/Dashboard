// ── 勉強会・イベント画面（UI試作 events）の画面レベル検証 ────────────────
// 一覧・検索・分類・詳細・気になる・参加（同意つき）・満席のキャンセル待ち・取消・
// チャット導線・カレンダー・過去の開催 を実ブラウザで確認する。
// ⚠️ 本番には一切つながりません。ローカルのスタブAPIに対してだけ動かします。
// ⚠️ 本番には一切つながりません。ローカルのスタブAPIに対してだけ動かします。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');

const ROOT = process.env.DASHBOARD_ROOT || process.cwd();
const CDN = process.env.CDN_DIR || '/tmp/cdn';
const PORT = 8975;
const TYPES = { '.html':'text/html;charset=utf-8', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml' };

const SHOPS = [{ id: 1, name: 'NAORU 鶴見院' }];
const STAFF = Array.from({ length: 8 }, (_, i) => ({ staff_id: `s${i + 1}`, name: `スタッフ${i + 1}`, shop_name: 'NAORU 鶴見院' }));
// 架空の予定（本番データではありません）
const sections = {
  study: [
    { id: 'r1', cells: { date: '2026-10-08', time: '20:30-21:30', place: 'オンライン', owner: '青木 はるか',
                         ownerId: '__root__', teacher: '森', capacity: '2', content: 'ケースラボ：現場の悩みを持ち寄る', roomId: 'room_1' } },
    { id: 'r2', cells: { date: '毎週火曜', time: '未定', place: '本部', capacity: '各店1名', content: '定例の勉強会' } },
  ],
  event: [{ id: 'r3', cells: { date: '2026-09-25', time: '19:00', place: '横浜', content: '秋の歓迎会', owner: '本部', capacity: '' } }],
  bukatsu: [{ id: 'r4', cells: { date: '2026-08-01', time: '07:00-08:00', place: '皇居', club: 'ランニング部', content: '朝ラン', charge: '山本' } }],
};
const meta = { r1: { title: '明日の施術が変わる、60分のケースラボ。', summary: '現場の悩みを持ち寄って、一緒に考える会です。', featured: true,
                     target: '経験年数を問わず', fee: '無料', online: true, welcome: { firstTimer: true, listenOnly: true, partial: false },
                     gains: ['説明の型が身につく', '他店の工夫を知れる'], status: 'open' } };
const rsvp = {};   // { rowId: { staffId: state } }
const CAP = { r1: 2, r2: null, r3: null, r4: null };
const countsOf = (id) => {
  const v = rsvp[id] || {};
  const c = { going: 0, waitlist: 0, interested: 0, invited: 0, cancelled: 0 };
  for (const s of Object.values(v)) if (c[s] !== undefined) c[s]++;
  const cap = CAP[id];
  return { ...c, capacity: cap, capacityText: id === 'r2' ? '各店1名' : '',
           seatsLeft: cap === null ? null : Math.max(0, cap - c.going), full: cap === null ? false : c.going >= cap };
};
// 1x1 の透明PNG（架空の写真。実物は使いません）
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const uploads = {};   // 写真・配布資料の実体（架空）
let upN = 0;
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
      if (type === 'events') {
        if (req.method === 'GET' && url.searchParams.get('file')) {
          const f = uploads[url.searchParams.get('file')];
          if (!f) { res.statusCode = 404; return json(res, { ok: false, error: 'not_found' }); }
          return json(res, { ok: true, name: f.name, type: f.type, dataUrl: f.dataUrl });
        }
        if (req.method === 'GET') return json(res, { sections, meta, configured: true, me: '__root__' });
        const a = body.action;
        if (a === 'rsvp_counts') {
          const counts = {}, mineOut = {};
          for (const id of (body.ids || [])) { counts[id] = countsOf(id); mineOut[id] = (rsvp[id] || {})['__root__'] || 'none'; }
          return json(res, { ok: true, counts, mine: mineOut });
        }
        if (a === 'rsvp') {
          const id = body.id; rsvp[id] = rsvp[id] || {};
          const want = body.want;
          const c = countsOf(id);
          let result = 'unchanged';
          if (want === 'going') { result = c.full && rsvp[id]['__root__'] !== 'going' ? 'waitlist' : 'going'; rsvp[id]['__root__'] = result; }
          else if (want === 'interested') { if (!['going', 'waitlist'].includes(rsvp[id]['__root__'])) { rsvp[id]['__root__'] = 'interested'; result = 'interested'; } }
          else if (want === 'cancel') { if (rsvp[id]['__root__']) { rsvp[id]['__root__'] = 'cancelled'; result = 'cancelled'; } }
          return json(res, { ok: true, id, my: rsvp[id]['__root__'] || 'none', result, promoted: null, counts: countsOf(id) });
        }
        if (a === 'rsvp_list') {
          return json(res, { ok: true, id: body.id, counts: countsOf(body.id), detail: true,
            roster: { going: Object.entries(rsvp[body.id] || {}).filter(([, s]) => s === 'going').map(([k]) => ({ id: k, name: '管理者' })),
                      waitlist: [], interested: [], invited: [], cancelled: [] },
            chatOnly: ['s5'], chatOnlyLabel: 'チャット参加中・出欠未回答' });
        }
        if (a === 'meta_set') {
          // ⚠️ サーバーと同じく、ここからは recap を変えさせない
          const { recap: _ignored, ...m } = (body.meta || {});
          meta[body.id] = { ...(meta[body.id] || {}), ...m };
          return json(res, { ok: true, id: body.id, meta: meta[body.id] });
        }
        if (a === 'recap_set') {
          const r = body.recap || {};
          const photos = Array.isArray(r.photoIds) ? r.photoIds : [];
          const has = !!(String(r.note || '').trim() || photos.length || (r.files || []).length || r.videoUrl);
          // ⚠️ サーバーと同じく、写真があるのに掲載許可が未確認なら保存しない
          if (has && photos.length && r.consent !== true) {
            return json(res, { ok: false, error: 'consent_unconfirmed', message: '写真に写っている方の掲載許可を確かめてから保存してください。' });
          }
          meta[body.id] = { ...(meta[body.id] || {}), recap: r };
          return json(res, { ok: true, id: body.id, recap: r });
        }
        if (a === 'uploadImage') { const id = `img_${++upN}`; uploads[id] = { name: 'photo', type: 'image/png', dataUrl: body.dataUrl }; return json(res, { ok: true, id }); }
        if (a === 'uploadFile') { const id = `file_${++upN}`; uploads[id] = { name: body.name, type: body.fileType, dataUrl: body.dataUrl }; return json(res, { ok: true, id }); }
        if (a === 'upsertRow') {
          const sk = body.section; sections[sk] = sections[sk] || [];
          sections[sk].push({ id: body.row.id, cells: body.row.cells || {} });
          return json(res, { ok: true, row: body.row });
        }
        return json(res, { ok: true });
      }
      // ふりかえり写真の表示経路（ChatImage は raw の画像バイトを取りに来る）
      if (type === 'chat' && url.searchParams.get('img')) {
        const id = url.searchParams.get('img');
        const u = uploads[id];
        const b64 = u && /^data:image\/[^;]+;base64,/.test(String(u.dataUrl)) ? String(u.dataUrl).split(',')[1] : PNG_1PX;
        res.setHeader('Content-Type', 'image/png');
        return res.end(Buffer.from(b64, 'base64'));
      }
      if (type === 'board') return json(res, { posts: [], reads: {}, configured: true, ok: true, counts: {} });
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
const OUT = process.env.OUT_DIR || '/tmp';

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'commit', timeout: 60000 });
for (let i = 0; i < 40; i++) { if ((await txt()).trim().length > 40) break; await page.waitForTimeout(1000); }
const pw = page.locator('input[type="password"]');
if (await pw.count()) { await pw.first().fill(process.env.STUB_PW || 'pw'); await page.keyboard.press('Enter'); await page.waitForTimeout(3000); }
check('rootでログインできる', (await page.locator('input[type="password"]').count()) === 0);

await page.getByRole('button', { name: /勉強会・イベント/ }).first().click().catch(() => {});
await page.waitForTimeout(3000);
let t = await txt();

// ── 見出し・注目イベント ──────────────────────────────
check('大見出しが「集まる、広がる。」になっている', t.includes('集まる、') && t.includes('広がる。'));
check('注目イベントが1件だけ大きく出る', (await page.locator('[data-ev-hero]').count()) === 1);
check('注目イベントは主催者が指定したもの', (await page.locator('[data-ev-hero="r1"]').count()) === 1);
check('日時・場所が参加前に分かる', /10\.08 THU/.test(t) && t.includes('20:30–21:30'));
check('「イベントを企画する」がある', (await page.locator('[data-ev-create]').count()) > 0);

// ── 一覧 ──────────────────────────────────────────
const cards = await page.locator('[data-ev-card]').count();
check('これからの予定だけが一覧に出る（過去は出ない）', cards === 3 && (await page.locator('[data-ev-card="r4"]').count()) === 0, `${cards} 件`);
check('分類の呼び名が「交流イベント」になっている', t.includes('交流イベント'));
check('参加予定の人数が出る', /参加予定 \d+人/.test(t));
check('残席が出る', /残り 2席/.test(t), (t.match(/残り \d+席/) || [''])[0]);
check('🔴 自由文の定員では「残り」と言わない', t.includes('定員 各店1名') && !/各店1名[\s\S]{0,40}残り/.test(t));
check('初参加歓迎は設定したものだけに出る', (t.match(/初参加歓迎/g) || []).length >= 1);

// PC3列 / スマホ1列
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(500);
const cols = await page.locator('.ev-cards').first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
check('PCでは3列に並ぶ', cols === 3, `${cols} 列`);
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
const cols1 = await page.locator('.ev-cards').first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check('スマホでは1列に並ぶ', cols1 === 1, `${cols1} 列`);
check('スマホで横スクロールが出ない', !overflow);
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(500);

// ── 検索・分類 ────────────────────────────────────
await page.locator('.nowl-search input').first().fill('横浜');
await page.waitForTimeout(800);
check('場所で検索できる', (await page.locator('[data-ev-card]').count()) === 1 && (await page.locator('[data-ev-card="r3"]').count()) === 1);
await page.locator('.nowl-search input').first().fill('存在しない語句zzz');
await page.waitForTimeout(800);
check('見つからないときは案内と解除ボタンが出る',
  (await txt()).includes('に一致するイベントがありません') && (await page.locator('[data-ev-clearfilter]').count()) > 0);
await page.locator('[data-ev-clearfilter]').first().click();
await page.waitForTimeout(800);
await page.locator('[data-ev-cat="bukatsu"]').first().click();
await page.waitForTimeout(800);
check('分類で絞れる（該当なしも正しく出る）', (await page.locator('[data-ev-card]').count()) === 0);
await page.locator('[data-ev-cat="all"]').first().click();
await page.waitForTimeout(800);

// ── 気になる（保存だけ）────────────────────────────
await page.locator('[data-ev-save="r3"]').first().click();
await page.waitForTimeout(900);
t = await txt();
check('🔴 「気になる」は参加ではないと画面に出る', t.includes('参加の登録ではありません'));
await page.locator('[data-ev-tab="interested"]').first().click();
await page.waitForTimeout(900);
check('気になるタブに出る', (await page.locator('[data-ev-card]').count()) === 1 && (await page.locator('[data-ev-card="r3"]').count()) === 1);
await page.locator('[data-ev-tab="find"]').first().click();
await page.waitForTimeout(800);

// ── 詳細 → 同意つきの参加 ──────────────────────────
await page.locator('[data-ev-action="r1"]').first().click();
await page.waitForTimeout(1200);
t = await txt();
check('詳細が開く', (await page.locator('[data-nowl-modal="event"]').count()) === 1);
check('日時・場所・主催・料金・対象・定員が出る',
  ['日時', '場所', '主催', '料金', '対象', '定員'].every(k => t.includes(k)));
check('得られることが出る', t.includes('説明の型が身につく'));
check('🔴 チャットに入るだけでは出欠にならないと書いてある', t.includes('出欠の回答になりません'));

await page.locator('[data-ev-join]').first().click();
await page.waitForTimeout(700);
t = await txt();
check('🔴 参加は確認画面をはさむ（押しただけで登録しない）',
  (await page.locator('[data-ev-confirm]').count()) === 1 && t.includes('この内容で参加を登録します'));
check('確認画面に日時・場所・料金・公開範囲・チャットが出る',
  t.includes('主催者と本部に見えます') && t.includes('グループチャット'));
await page.locator('[data-ev-confirm-yes]').first().click();
await page.waitForTimeout(1200);
t = await txt();
check('参加予定になる', t.includes('参加予定にしました'));
check('残席が減る', /参加予定 1名/.test(t) || /残り 1席/.test(t), (t.match(/残り \d+席/) || [''])[0]);

// カレンダー
const dlWait = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
await page.locator('[data-ev-ics]').first().click();
const dl = await dlWait;
let icsName = '', icsOk = false;
if (dl) { icsName = dl.suggestedFilename(); const p2 = await dl.path().catch(() => null);
  if (p2) { const body = fs.readFileSync(p2, 'utf8'); icsOk = body.includes('BEGIN:VCALENDAR') && body.includes('DTSTART:20261008T113000Z'); } }
check('🔴 カレンダー（ICS）を正しい日時で作れる', icsOk, icsName || '作れず');

// 参加者一覧（本部）
await page.locator('[data-ev-roster]').first().click();
await page.waitForTimeout(1000);
t = await txt();
check('主催者・本部は参加者の一覧を見られる', t.includes('参加予定 1人'));
check('🔴 チャット参加中・出欠未回答を分けて出す', t.includes('チャット参加中・出欠未回答'));

// 取消
await page.locator('[data-ev-cancel]').first().click();
await page.waitForTimeout(1200);
check('参加を取り消せる', (await txt()).includes('取り消しました'));
await page.keyboard.press('Escape');
await page.waitForTimeout(600);

// ── 満席 → キャンセル待ち ────────────────────────────
// r1 は定員2。2人埋めてから3人目として申し込む
await page.evaluate(async () => {
  for (const id of ['x1', 'x2']) {
    await fetch('/api/plan-store', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'events', action: 'rsvp', id: 'r1', want: 'going', _as: id }) });
  }
});
await page.waitForTimeout(600);

// ── 日付が読めない予定 ──────────────────────────────
await page.locator('[data-ev-card="r2"] button').first().click();
await page.waitForTimeout(1200);
const icsWait2 = page.waitForEvent('download', { timeout: 3000 }).catch(() => null);
await page.locator('[data-ev-ics]').first().click();
await page.waitForTimeout(1200);
const dl2 = await icsWait2;
check('🔴 日付が読めない予定ではカレンダーを作らない（理由を出す）',
  !dl2 && (await txt()).includes('開催日が決まっていない'));
await page.keyboard.press('Escape');
await page.waitForTimeout(600);

// ── 過去の開催とふりかえり ──────────────────────────────
await page.locator('[data-ev-tab="past"]').first().click();
await page.waitForTimeout(900);
check('過去の開催を見られる', (await page.locator('[data-ev-card="r4"]').count()) === 1);
check('ふりかえりが無いうちは「0件」と書かない', (await page.locator('[data-ev-recap-sum]').count()) === 0);

await page.locator('[data-ev-action="r4"]').first().click();
await page.waitForTimeout(1000);
check('過去の会の詳細が開く', (await page.locator('[data-nowl-modal="event"]').count()) === 1);
check('ふりかえりの枠が出る', (await page.locator('[data-ev-recap="r4"]').count()) === 1);
check('まだ無いときは「まだありません」と出す', (await page.locator('[data-ev-recap-empty]').count()) === 1);
check('主催者・本部には「ふりかえりを書く」が出る', (await page.locator('[data-ev-recap-edit="r4"]').count()) === 1);

await page.locator('[data-ev-recap-edit="r4"]').first().click();
await page.waitForTimeout(600);
check('ふりかえりの入力が開く', (await page.locator('[data-ev-recap-editor]').count()) === 1);
check('写真が無いうちは掲載許可の確認を出さない', (await page.locator('[data-ev-recap-consent]').count()) === 0);

// 写真を1枚入れる → 掲載許可を確かめるまで保存できない
await page.locator('[data-ev-recap-add] input[type="file"]').first().setInputFiles({
  name: 'asa.png', mimeType: 'image/png', buffer: Buffer.from(PNG_1PX, 'base64'),
});
await page.waitForTimeout(1200);
check('写真を入れられる', (await page.locator('[data-ev-recap-editor] .ev-recap-photo').count()) === 1);
check('🔴 写真を入れると掲載許可の確認が出る', (await page.locator('[data-ev-recap-consent]').count()) === 1);
const saveDisabled = await page.locator('[data-ev-recap-save]').first().isDisabled();
check('🔴 許可を確かめるまで保存できない', saveDisabled === true);
check('🔴 なぜ保存できないかを画面に書く', (await page.locator('[data-ev-recap-why]').count()) === 1,
  (await page.locator('[data-ev-recap-why]').first().innerText().catch(() => '')).slice(0, 40));

await page.locator('[data-ev-recap-note-input]').first().fill('朝ランの記録です。次回は皇居3周にしましょう。');
await page.locator('[data-ev-recap-video-input]').first().fill('https://example.com/rec');
await page.locator('[data-ev-recap-consent] input[type="checkbox"]').first().check();
await page.waitForTimeout(500);
check('許可を確かめると保存できるようになる', (await page.locator('[data-ev-recap-save]').first().isDisabled()) === false);
await page.locator('[data-ev-recap-save]').first().click();
await page.waitForTimeout(1800);
check('保存すると入力が閉じる', (await page.locator('[data-ev-recap-editor]').count()) === 0);
const savedRecap = (meta.r4 || {}).recap || {};
check('サーバーにレポート・写真・録画が届いている',
  String(savedRecap.note || '').includes('朝ラン') && (savedRecap.photoIds || []).length === 1 && savedRecap.videoUrl === 'https://example.com/rec');
check('掲載許可の確認も一緒に記録している', savedRecap.consent === true);
check('保存したレポートが画面に出る', (await page.locator('[data-ev-recap-note]').count()) === 1);
check('写真が画面に出る', (await page.locator('[data-ev-recap-photos] .ev-recap-photo').count()) === 1);
check('録画のリンクが出る', (await page.locator('[data-ev-recap-video]').count()) === 1);
check('写真は許可を確認したうえで載せていると書いてある', (await txt()).includes('掲載許可を確認したうえで載せています'));

// 写真の拡大
await page.locator('[data-ev-recap-photos] .ev-recap-photo').first().click();
await page.waitForTimeout(700);
check('写真を大きく見られる', (await page.locator('[data-ev-photo]').count()) === 1);
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
check('Escape で写真を閉じられる', (await page.locator('[data-ev-photo]').count()) === 0);

await page.keyboard.press('Escape');
await page.waitForTimeout(800);
check('一覧のカードにふりかえりの中身が出る', (await page.locator('[data-ev-recap-sum="r4"]').count()) === 1,
  (await page.locator('[data-ev-recap-sum="r4"]').first().innerText().catch(() => '')));

await page.locator('[data-ev-tab="find"]').first().click();
await page.waitForTimeout(700);
check('これから開く会に「ふりかえり」は出さない', (await page.locator('[data-ev-recap]').count()) === 0);

// ── 企画する（空の公開行を作らない）───────────────────
const before = await page.locator('[data-ev-card]').count();
await page.locator('[data-ev-create]').first().click();
await page.waitForTimeout(800);
check('企画の入口が開く', (await page.locator('[data-nowl-modal="event-plan"]').count()) === 1);
check('🔴 空の公開行を即座に作らないと書いてある', (await txt()).includes('一覧には出ません'));
await page.locator('[data-ev-plan="study"]').first().click();
await page.waitForTimeout(2000);
await page.keyboard.press('Escape');
await page.waitForTimeout(900);
const after = await page.locator('[data-ev-card]').count();
check('🔴 企画しても一覧に空の行が増えない（下書きのまま）', after === before, `${before} → ${after} 件`);
check('下書きは本人と本部にだけ、一覧とは別に出る',
  (await page.locator('[data-ev-drafts]').count()) === 1 && (await page.locator('[data-ev-draft]').count()) === 1,
  (await txt()).includes('あなたと本部にだけ見えています') ? '注記あり' : '注記なし');

// ── ポップアップの作法 ──────────────────────────────
await page.locator('[data-ev-action="r3"]').first().click();
await page.waitForTimeout(1000);
check('詳細が開く（2回目）', (await page.locator('[data-nowl-modal="event"]').count()) === 1);
await page.keyboard.press('Escape');
await page.waitForTimeout(700);
check('Escape で閉じる', (await page.locator('[data-nowl-modal="event"]').count()) === 0);

await page.screenshot({ path: path.join(OUT, 'events-v3.png'), fullPage: true });
check('画面の写しを保存した', true, path.join(OUT, 'events-v3.png'));
check('画面のエラーが出ていない', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close(); server.close();
const ng = results.filter(r => !r.pass);
console.log(`\n  結果: ${results.length - ng.length}/${results.length}`);
if (ng.length) { console.log('  NG:'); for (const r of ng) console.log('   -', r.name, r.detail); }
process.exit(ng.length ? 1 : 0);
