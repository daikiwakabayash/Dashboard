// ── 日報・集客レポートのカードが、チャットの中で見本どおりに出るかの検証 ──────
// ⚠️ 本番には一切つながりません。ローカルのスタブAPIに対してだけ動かします。
// ⚠️ ここで確かめるのは「見た目と、取れていない値の出し方」。
//    数字の作り方は tests/daily-report.test.js（純粋関数）で確かめています。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');

const ROOT = process.env.DASHBOARD_ROOT || process.cwd();
const CDN = process.env.CDN_DIR || '/tmp/cdn';
const PORT = 8982;
const TYPES = { '.html':'text/html;charset=utf-8', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml' };

const SHOPS = [{ id: 1, name: 'テスト院' }];
const ROOMS = [{ id: 'room1', kind: 'store', name: 'テスト院 グループ', shop: 'テスト院', members: ['__root__'] }];

// サーバー（lib/daily-report.js）が作る card と同じ形。合成データ。
const PREP_CARD = {
  kind: 'prep', brand: 'NAORU × SalonOne', title: 'オープン前 集客レポート', badge: '速報',
  atLabel: '2026/09/19（土） 19:00時点・日本時間',
  milestones: [{ label: 'プレオープン', value: '9/27(日)' }, { label: '本オープン', value: '10/1(木)' }],
  goal: { headline: '目標まで、あと54名', note: '目標150名・集客目標の締切 9/30(水)', current: 96, target: 150, rate: 64 },
  scope: { left: '10月の新規来店予約が対象', right: '取消・重複を除く' },
  today: [
    { label: '本日の新規予約', value: 9, unit: '件' },
    { label: '本日のキャンセル', value: 2, unit: '件' },
    { label: '本日の予約増減', value: 7, unit: '件', signed: true },
  ],
  todayNote: '',
  channels: { header: '媒体別の予約状況', note: '本日 00:00〜19:00',
    cols: [{ key: 'added', label: '新規 / 件' }, { key: 'cancelled', label: '取消 / 件' },
           { key: 'total', label: '累計 / 名', strong: true }],
    rows: [
      { name: 'Meta広告', added: 5, cancelled: 1, total: 52 },
      { name: 'チラシ', added: 2, cancelled: 1, total: 24 },
      { name: 'Google検索', added: 1, cancelled: 0, total: 12 },
    ],
    total: { added: 9, cancelled: 2, total: 96 } },
  spend: { header: '累計広告費・獲得単価', note: '2026-10-01〜2026-09-19・税別',
    items: [{ name: 'Meta広告', yen: 104000 }, { name: 'チラシ', yen: 48000 }],
    totalYen: 152000, cpa: 1583 },
  footer: { source: 'SalonOne・更新 9/19(土) 19:00', schedule: '毎日19:00配信' },
};

const PREOPEN_CARD = {
  kind: 'preopen', brand: 'NAORU × SalonOne', title: 'プレオープン日報', badge: 'プレオープン初日',
  atLabel: '対象日：2026/09/27（日）', atRight: '集計実行 18:42・当日時点',
  milestones: [{ label: 'プレオープン', value: '9/27(日)' }, { label: '本オープン', value: '10/1(木)' }],
  highlight: { label: '本日売上', value: 89750, money: true, note: '新規来店13名・入会4名・次回予約11名' },
  table: {
    header: 'セラピスト別・店舗合計', note: '同じ指標を横並びで確認',
    staff: [{ id: 'a', name: 'スタッフA' }, { id: 'b', name: 'スタッフB' }],
    rows: [
      { label: '本日売上（税抜）', values: [32000, 57750], total: 89750, money: true },
      { label: '当日予約数（取消を含む）', values: [7, 8], total: 15, unit: '件' },
      { label: '新規来店数', values: [5, 8], total: 13, unit: '名' },
      { label: 'キャンセル数', values: [2, 0], total: 2, unit: '件' },
      { label: '入会人数', values: [1, 3], total: 4, unit: '名' },
      { label: '入会率', values: [20, 37.5], total: 30.76923, percent: true },
      // 🔴 取得元が未確認の2項目は null で来る（0 ではない）
      { label: 'リピート数（次回予約）', values: [null, null], total: null, unit: '名' },
      { label: 'リピート率', values: [null, null], total: null, percent: true },
      { label: '前金あり', values: [null, null], total: null, unit: '名' },
      { label: 'Google口コミ', values: [2, 3], total: 5, unit: '名' },
    ],
  },
  notes: [
    '入会率＝入会人数 ÷ 新規来店数',
    'リピート率＝次回予約獲得人数 ÷ 新規来店数（再来店数とは別）',
    '売上：SalonOneの当日計上額・税抜　／　前金あり・口コミは当日獲得人数',
  ],
  footer: { source: 'SalonOne・更新 18:42', schedule: '「集計実行」の完了後に、店舗グループへ自動投稿' },
};

const msg = (id, card) => ({
  id, roomId: 'room1', fromStaffId: '__daily_report__', fromName: '日報（自動）', fromShop: 'テスト院',
  text: `【${card.title}】テスト院`, imgIds: [], links: [], mentions: [],
  createdAt: new Date('2026-09-27T09:42:00Z').toISOString(),
  auto: { phase: card.kind, ymd: '2026-09-27', shopId: '1', version: 'daily-report-2', card },
});
// オープン後の日報。🔴 媒体別の列がオープン前と違う（予約/来店/入会）。
// 描く側が項目名を当てていると、ここが全部「未取得」になる。
const OPEN_CARD = {
  kind: 'open', brand: 'NAORU × SalonOne', title: '日報', badge: '日報',
  atLabel: '2026/10/05（月）・日本時間',
  today: [
    { label: '売上合計', value: 482000, unit: '円', money: true },
    { label: '来店', value: 24, unit: '名' },
    { label: '入会', value: 3, unit: '名' },
  ],
  channels: { header: '媒体別（新規予約）', note: '10/5(月)',
    cols: [{ key: 'booking', label: '予約 / 件' }, { key: 'visit', label: '来店 / 名' },
           { key: 'join', label: '入会 / 名', strong: true }],
    rows: [{ name: 'ホットペッパー', booking: 4, visit: 3, join: 2 },
           { name: 'Google', booking: 2, visit: 2, join: 1 }],
    total: { booking: 6, visit: 5, join: 3 } },
  footer: { source: 'SalonOne・更新 10/5(月) 22:00', schedule: '毎日22:00配信' },
};
const MESSAGES = { room1: [msg('m1', PREP_CARD), msg('m2', PREOPEN_CARD), msg('m3', OPEN_CARD)] };

const json = (res, o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch {}
    const p = url.pathname;
    if (p === '/api/settlement-auth') {
      if (req.method === 'GET') return json(res, { ok: true, shops: {} });
      return json(res, { ok: true, token: 'stub', owner: '__root__', root: true, role: 'root' });
    }
    if (p === '/api/plan-store') {
      const type = req.method === 'GET' ? url.searchParams.get('type') : body.type;
      if (type === 'ccflags') return json(res, { flags: { cc_all: true, cc_authz: 'off' }, configured: true, env: 'preview' });
      if (type === 'chat') return json(res, { rooms: ROOMS, messages: MESSAGES, reads: {},
        dir: { staff: [{ id: '__root__', name: '本部', shop: '本部' }] }, notes: {}, configured: true });
      if (type === 'board') return json(res, { posts: [], reads: {}, configured: true, hero: null });
      if (type === 'events') return json(res, { sections: {}, configured: true });
      return json(res, { ok: true, configured: true });
    }
    if (p.startsWith('/api/salonone')) {
      if (/shop|store/i.test(req.url)) return json(res, { data: SHOPS, meta: {} });
      return json(res, { data: [], meta: {} });
    }
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

// チャット画面 → 店舗ルームを開く
await page.getByRole('button', { name: /チャット|コミュニケーション/ }).first().click().catch(() => {});
await page.waitForTimeout(2000);
for (const sel of ['テスト院 グループ', 'テスト院']) {
  const hit = page.getByText(sel, { exact: false }).first();
  if (await hit.count()) { await hit.click().catch(() => {}); await page.waitForTimeout(2500); }
  if (await page.locator('[data-rep-card]').count()) break;
}
if (!(await page.locator('[data-rep-card]').count())) {
  console.log('  [debug] 画面の文字:', (await txt()).replace(/\s+/g, ' ').slice(0, 400));
}

const prep = page.locator('[data-rep-card="prep"]');
const pre = page.locator('[data-rep-card="preopen"]');
check('レポートが2件ともカードで出る', (await prep.count()) === 1 && (await pre.count()) === 1,
  `prep ${await prep.count()} / preopen ${await pre.count()}`);
check('🔴 吹き出しの本文は出さない（カードと二重に出さない）',
  (await page.locator('[data-msgtext]').count()) === 0, `${await page.locator('[data-msgtext]').count()} 件`);

// ── オープン前のカード ─────────────────────────────────────────
let t = await prep.first().innerText();
check('見出しと速報バッジ', t.includes('NAORU × SalonOne') && t.includes('オープン前 集客レポート') && t.includes('速報'));
check('いつ時点かが出る', t.includes('2026/09/19（土） 19:00時点・日本時間'));
check('プレオープン日と本オープン日', t.includes('9/27(日)') && t.includes('10/1(木)'));
check('🔴 目標までの残りと締切', t.includes('目標まで、あと54名') && t.includes('集客目標の締切 9/30(水)'));
check('🔴 累計と達成率が大きく出る', t.includes('96') && t.includes('64%') && t.includes('/ 目標150名'));
check('達成率の帯が出る', (await prep.locator('.rep-bar i').count()) === 1);
check('🔴 帯は100%を超えない',
  await prep.locator('.rep-bar i').first().evaluate(el => parseFloat(el.style.width) <= 100));
check('対象と除外の条件', t.includes('10月の新規来店予約が対象') && t.includes('取消・重複を除く'));
check('🔴 本日の新規・キャンセル・増減', t.includes('9件') && t.includes('2件') && t.includes('+7件'));
check('媒体別が表で出る', (await prep.locator('[data-rep-channels] tbody tr').count()) === 3);
check('媒体別に合計行がある', (await prep.locator('[data-rep-channels] tfoot').count()) === 1);
check('媒体別の中身', t.includes('Meta広告') && t.includes('52') && t.includes('合計'));
check('🔴 広告費とCPA', t.includes('¥152,000') && t.includes('¥1,583 / 名'));
check('配信の予定を下に出す', t.includes('毎日19:00配信'));
check('🔴 オープン前に売上の欄を出さない', !t.includes('本日売上'));

// ── プレオープンのカード ───────────────────────────────────────
t = await pre.first().innerText();
check('プレオープン専用の見出しと何日目か', t.includes('プレオープン日報') && t.includes('プレオープン初日'));
check('対象日と集計実行の時刻', t.includes('対象日：2026/09/27（日）') && t.includes('集計実行 18:42・当日時点'));
check('🔴 本日売上の帯と内訳', t.includes('本日売上 ¥89,750') && t.includes('新規来店13名・入会4名・次回予約11名'));
check('セラピストが列に並ぶ', (await pre.locator('[data-rep-staff] thead th').count()) === 4, `${await pre.locator('[data-rep-staff] thead th').count()} 列`);
check('🔴 見本の10行がそろう', (await pre.locator('[data-rep-staff] tbody tr').count()) === 10);
check('🔴 店舗合計まで並ぶ', t.includes('¥32,000') && t.includes('¥57,750') && t.includes('¥89,750'));
check('🔴 率は合計から出し直した値', t.includes('30.8%'));
check('🔴 計算の定義を必ず添える',
  t.includes('入会率＝入会人数 ÷ 新規来店数') && t.includes('再来店数とは別') && t.includes('当日計上額・税抜'));
check('「集計実行」の後に出すと断る', t.includes('「集計実行」の完了後'));

// 🔴 取れていない値の出し方
const naCells = await pre.locator('[data-rep-staff] .na').count();
check('🔴 取得元が未確認の項目は「未取得」と出す（0名にしない）', naCells >= 6, `${naCells} か所`);
check('🔴 0名・0% と書いていない', !/リピート数（次回予約）[^\n]*0名/.test(t) && !/リピート率[^\n]*0%/.test(t));

// ── スマホでも崩れない ─────────────────────────────────────────
await page.setViewportSize({ width: 390, height: 900 });
await page.waitForTimeout(900);
check('🔴 スマホ幅で画面が横に溢れない',
  await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  await page.evaluate(() => `${document.documentElement.scrollWidth} / ${window.innerWidth}`));
check('🔴 スマホでもカードは読める幅を保つ',
  await prep.first().evaluate(el => el.getBoundingClientRect().width >= 280),
  await prep.first().evaluate(el => Math.round(el.getBoundingClientRect().width) + 'px'));
check('表は指で横に送れる（切り落とさない）',
  await pre.locator('.rep-tw').first().evaluate(el => getComputedStyle(el).overflowX === 'auto'));
check('🔴 数字は選んでコピーできる（画像ではない）',
  await pre.locator('[data-rep-staff]').first().evaluate(el => getComputedStyle(el).userSelect !== 'none'));

// ── オープン後の日報（媒体別の列がオープン前と違う）─────────────────
const opn = page.locator('[data-rep-card="open"]');
check('オープン後の日報もカードで出る', (await opn.count()) === 1);
t = await opn.first().innerText();
check('売上・来店・入会が出る', t.includes('¥482,000') && t.includes('24') && t.includes('3'));
check('🔴 媒体別の見出しがオープン後のもの（予約/来店/入会）',
  t.includes('予約 / 件') && t.includes('来店 / 名') && t.includes('入会 / 名'));
check('🔴 媒体別の中身が実際に出る（全部「未取得」にならない）',
  t.includes('ホットペッパー') && t.includes('4') && !/ホットペッパー[^\n]*未取得/.test(t),
  (t.split('\n').find(x => x.includes('ホットペッパー')) || ''));
check('合計行が出る', (await opn.locator('[data-rep-channels] tfoot').count()) === 1);

check('画面のエラーが出ていない', errors.length === 0, errors.join(' | '));

if (process.env.OUT_DIR) {
  await page.setViewportSize({ width: 900, height: 1400 });
  await page.waitForTimeout(700);
  await prep.first().screenshot({ path: `${process.env.OUT_DIR}/report-prep.png` }).catch(() => {});
  await pre.first().screenshot({ path: `${process.env.OUT_DIR}/report-preopen.png` }).catch(() => {});
  console.log(`  （見た目の写し: ${process.env.OUT_DIR}/report-prep.png / report-preopen.png）`);
}

await browser.close();
server.close();
const ng = results.filter(r => !r.pass);
console.log(`\n  ${results.length - ng.length}/${results.length} OK`);
if (ng.length) { console.log('  NG:'); ng.forEach(r => console.log(`   - ${r.name} ${r.detail}`)); process.exit(1); }
