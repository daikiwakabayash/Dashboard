// ── 日報・集客速報の設定画面の画面レベル検証 ──────────────────────────
// ⚠️ 本番には一切つながりません。ローカルのスタブAPIに対してだけ動かします。
// ⚠️ ここで確かめるのは「画面がどう見えるか」。送信そのものの判定は
//    tests/daily-report-api.test.js（サーバー側）で確かめています。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');

const ROOT = process.env.DASHBOARD_ROOT || process.cwd();
const CDN = process.env.CDN_DIR || '/tmp/cdn';
const PORT = 8981;
const TYPES = { '.html':'text/html;charset=utf-8', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml' };

// 合成データ（実在の店舗・実売上ではありません）
const SHOPS = [{ id: 1, name: 'テスト院A' }, { id: 2, name: 'テスト院B' }];
const ROOMS = [
  { id: 'room1', kind: 'store', name: 'テスト院A グループ' },
  { id: 'room2', kind: 'store', name: 'テスト院B グループ' },
  { id: 'dm1', kind: 'dm', name: '個人あて' },
];
let flagOn = false;
let settings = { version: 'daily-report-1', shops: {} };
let sent = [];

const DEFAULTS = { shopId: '', shopName: '', enabled: false, roomId: '',
  preOpenDate: '', openDate: '', targetNew: null, targetDeadline: '', targetMonth: '',
  trigger: 'aggregate', closingAt: '22:00', sendAt: '19:00' };

// 期間は店舗の日付から決まる（lib/daily-report.js の phaseOf と同じ規則の最小版）
const phaseOf = (s) => {
  const today = '2026-09-19';
  if (!s || (!s.preOpenDate && !s.openDate)) return 'open';
  if (s.openDate && today >= s.openDate) return 'open';
  if (s.preOpenDate && today < s.preOpenDate) return 'prep';
  if (s.preOpenDate) return 'preopen';
  return 'prep';
};

const PREVIEW = {
  open: [
    '【日報】テスト院A　9/19(土)', '', '■ 売上', '　売上合計　¥482,000', '　新規 未取得 ／ 既存 未取得', '',
    '■ 来店', '　来店 24名（新規 6名 ／ 既存 18名）', '', '────────',
    '出典: SalonOne sales/summary / marketing/by-channel', '対象期間: 2026-09-19（1日）',
    '取得時刻: 2026-09-19 21:05 JST', '※ 「集計実行」の前に取得した場合は確定前の値になることがあります。',
  ].join('\n'),
  prep: [
    '【オープン前 集客レポート】テスト院A', '2026/09/19（土） 19:00時点・日本時間', '',
    'プレオープン 9/27(日)　／　本オープン 10/1(木)', '',
    '■ 目標まで、あと54名', '　目標150名・集客目標の締切 9/30(水)',
    '　累計の有効予約人数 96名 ／ 目標 150名　達成率 64%',
    '　（10月の新規来店予約が対象・取消・重複を除く）', '',
    '■ 本日の動き', '　新規予約 9件 ／ キャンセル 2件 ／ 増減 +7件', '',
    '■ 媒体別の予約状況（本日 00:00〜19:00）',
    '　Meta広告　新規 5件 ／ 取消 1件 ／ 累計 52名',
    '　チラシ　新規 2件 ／ 取消 1件 ／ 累計 24名', '',
    '■ 累計広告費・獲得単価（2026-10-01〜2026-09-19・税別）',
    '　Meta広告　¥104,000', '　チラシ　¥48,000',
    '　合計広告費 ¥152,000　／　CPA（有効予約ベース） ¥1,583 / 名', '', '────────',
    '出典: SalonOne marketing/by-channel',
    '対象期間: 2026-10-01〜2026-10-31（10月来店予定ぶんの累計）',
    '取得時刻: 2026-09-19 19:00 JST',
    '※ 予約時点の数字です。来店・入会の結果はオープン後の日報で出します。',
  ].join('\n'),
  preopen: [
    '【プレオープン日報】テスト院A　プレオープン初日',
    '対象日：2026/09/27（日）　集計実行 18:42・当日時点',
    'プレオープン 9/27(日)　／　本オープン 10/1(木)', '',
    '■ 本日売上 ¥89,750', '　新規来店13名・入会4名・次回予約11名', '',
    '■ セラピスト別・店舗合計',
    '　　　　スタッフA ／ スタッフB　＝ 店舗合計',
    '　本日売上（税抜）　¥32,000 ／ ¥57,750　＝ ¥89,750',
    '　新規来店数　5名 ／ 8名　＝ 13名',
    '　入会率　20% ／ 37.5%　＝ 30.8%',
    '　リピート率　100% ／ 75%　＝ 84.6%', '',
    '※ 入会率＝入会人数 ÷ 新規来店数',
    '※ リピート率＝次回予約獲得人数 ÷ 新規来店数（再来店数とは別）',
    '※ 売上：SalonOneの当日計上額・税抜　／　前金あり・口コミは当日獲得人数', '', '────────',
    '出典: SalonOne sales/summary / marketing/by-staff',
    '対象期間: 2026-09-27（1日・当日時点）', '取得時刻: 2026-09-27 18:42 JST',
    '※ 「集計実行」の完了後に出しています。その後に会計が動くと数字が変わることがあります。',
  ].join('\n'),
};

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
      if (type === 'ccflags') {
        if (req.method !== 'GET' && body.action === 'set' && body.key === 'cc_daily_report') flagOn = body.value === true;
        return json(res, { flags: { cc_all: true, cc_authz: 'off', cc_daily_report: flagOn }, configured: true, env: 'preview' });
      }
      if (type === 'dailyreport') {
        const action = req.method === 'GET' ? (url.searchParams.get('action') || '') : String(body.action || '');
        if (req.method === 'GET' && action === 'preview') {
          const id = url.searchParams.get('shopId') || '';
          const phase = url.searchParams.get('phase') || phaseOf(settings.shops[id]);
          return json(res, { ok: true, phase, text: PREVIEW[phase] || PREVIEW.open,
            missing: phase === 'prep' ? [] : ['売上の内訳'], ready: { ok: true }, flagOn });
        }
        if (req.method === 'GET') {
          const phases = Object.fromEntries(Object.values(settings.shops).map(x => [x.shopId, phaseOf(x)]));
          return json(res, { ok: true, settings, recent: [], flagOn, phases, today: '2026-09-19',
            salonOneConfigured: true, cronConfigured: true, aggregateTriggerConfirmed: false });
        }
        if (action === 'settings_set') {
          const id = String(body.shopId || '');
          const prev = settings.shops[id] || { ...DEFAULTS, shopId: id };
          const next = { ...prev, ...(body.setting || {}), shopId: id };
          settings = { ...settings, shops: { ...settings.shops, [id]: next } };
          return json(res, { ok: true, setting: next, phase: phaseOf(next), flagOn });
        }
        if (action === 'send') {
          const phase = body.phase || phaseOf(settings.shops[String(body.shopId || '')]);
          if (!flagOn) return json(res, { ok: true, sent: false, reason: 'dry_run', flagOn, phase, text: PREVIEW[phase] });
          sent.push({ shopId: body.shopId, phase });
          return json(res, { ok: true, sent: true, reason: 'ok', flagOn, phase, text: PREVIEW[phase] });
        }
        return json(res, { ok: true });
      }
      if (type === 'chat') return json(res, { rooms: ROOMS, messages: {}, reads: {}, dir: { staff: [] }, notes: {}, configured: true });
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
const panel = () => page.locator('[data-dr-panel]');
const shopRow = (id) => page.locator(`[data-dr-shop="${id}"]`);

const openSettings = async () => {
  await page.getByRole('button', { name: /オーナー設定/ }).first().click().catch(() => {});
  await page.waitForTimeout(1500);
  await page.locator('[data-dr-panel]').first().scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(500);
};

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'commit', timeout: 60000 });
for (let i = 0; i < 40; i++) { if ((await txt()).trim().length > 40) break; await page.waitForTimeout(1000); }
const pw = page.locator('input[type="password"]');
if (await pw.count()) { await pw.first().fill(process.env.STUB_PW || 'pw'); await page.keyboard.press('Enter'); await page.waitForTimeout(3000); }
check('rootでログインできる', (await page.locator('input[type="password"]').count()) === 0);

await openSettings();
check('オーナー設定に日報の設定が出る', (await panel().count()) === 1);
let t = await panel().first().innerText();

// ── 🔴 いまは送らない、と正直に出ているか ───────────────────────
check('🔴 送信OFFであることが一目で分かる', (await page.locator('[data-dr-flag]').first().innerText()).includes('送信OFF'));
check('🔴 「1通も送りません」と書いてある', t.includes('1通も送りません'));
check('🔴 「集計実行」の受け取りが未確認だと書いてある', t.includes('未確認') && t.includes('Webhook'));
check('🔴 推測であることを断っている', t.includes('推測'));
check('🔴 二重に送らないと書いてある', t.includes('1回だけ'));
check('🔴 取れない数字を0で埋めないと書いてある', t.includes('「未取得」'));
check('全店一括ではないと書いてある', t.includes('チェックを入れた店舗だけ'));

// ── 店舗ごとのチェック ────────────────────────────────────────
check('店舗が並ぶ', (await page.locator('[data-dr-shop]').count()) === SHOPS.length, `${await page.locator('[data-dr-shop]').count()} 店舗`);
check('🔴 はじめは全店OFF', t.includes('自動送信ON: 0店舗'));
check('OFFの店舗には送信先の欄を出さない（誤操作を減らす）', (await shopRow(1).locator('select').count()) === 0);

await shopRow(1).locator('input[type="checkbox"]').first().check();
await page.waitForTimeout(800);
t = await panel().first().innerText();
check('チェックを入れると対象が1店舗になる', t.includes('自動送信ON: 1店舗'));
check('チェックを入れると送信先を選べるようになる', (await shopRow(1).locator('select').count()) === 1);
check('もう一方の店舗は変わらない', (await shopRow(2).locator('select').count()) === 0);

// ── 🔴 送信先が決まるまで送れない ───────────────────────────────
check('🔴 送信先が未設定だと注意が出る', (await shopRow(1).innerText()).includes('送信先が未設定なので送りません'));
const sendBtn = shopRow(1).getByRole('button', { name: /いま送る/ });
check('🔴 送信先が未設定なら「いま送る」を押せない', await sendBtn.first().isDisabled());
check('🔴 ボタンに「下書きのみ」と書いてある（送れると誤解させない）',
  (await sendBtn.first().innerText()).includes('下書きのみ'));

// 個人あてのDMは送信先に出さない（誤って個人へ流さない）
const opts = await shopRow(1).locator('select option').allInnerTexts();
check('🔴 個人あて（DM）は送信先に出さない', !opts.some(o => o.includes('個人あて')), opts.join(' / '));

await shopRow(1).locator('select').first().selectOption('room1');
await page.waitForTimeout(800);
check('送信先を選ぶと「いま送る」が押せる', !(await shopRow(1).getByRole('button', { name: /いま送る/ }).first().isDisabled()));

// ── 期間ごとに出るレポートが変わる ──────────────────────────────
// 日付を入れていない店舗＝既存店なので「オープン後」
check('日付未設定の店舗は「オープン後」と出る',
  (await page.locator('[data-dr-phase="1"]').first().innerText()) === 'オープン後');

await shopRow(1).getByRole('button', { name: 'いまの期間の下書き' }).first().click();
await page.waitForTimeout(1200);
check('下書きが出る', (await page.locator('[data-dr-preview]').count()) === 1);
let pv = await page.locator('[data-dr-preview]').first().innerText();
check('オープン後は日報が出る', pv.includes('【日報】テスト院A'));
check('🔴 出典・対象期間・取得時刻が本文に入っている',
  pv.includes('出典: SalonOne') && pv.includes('対象期間:') && pv.includes('取得時刻:'));
check('🔴 取れなかった項目は「未取得」と書かれている（0ではない）', pv.includes('未取得'));
check('🔴 取れていない項目を画面でも知らせる', pv.includes('取れていない項目'));
check('🔴 確定前の可能性を断っている', pv.includes('確定前の値になることがあります'));

// ── 日付を入れると期間が切り替わる ─────────────────────────────
await shopRow(1).locator('[data-dr-preopendate]').first().fill('2026-09-27');
await page.waitForTimeout(900);
await shopRow(1).locator('[data-dr-opendate]').first().fill('2026-10-01');
await page.waitForTimeout(1200);
check('🔴 プレオープン日より前なら「オープン前」に変わる',
  (await page.locator('[data-dr-phase="1"]').first().innerText()) === 'オープン前',
  await page.locator('[data-dr-phase="1"]').first().innerText());

await shopRow(1).getByRole('button', { name: 'いまの期間の下書き' }).first().click();
await page.waitForTimeout(1500);
pv = await page.locator('[data-dr-preview]').first().innerText();
check('🔴 目標が未設定なら「あと何人」を出せないと知らせる',
  (await shopRow(1).innerText()).includes('目標が未設定なので'));
check('オープン前は集客レポートが出る', pv.includes('オープン前 集客レポート'));
check('🔴 プレオープン日と本オープン日が出る', pv.includes('プレオープン 9/27(日)') && pv.includes('本オープン 10/1(木)'));
check('🔴 目標までの残りが出る', pv.includes('目標まで、あと54名'));
check('🔴 累計の有効予約人数と達成率が出る', pv.includes('累計の有効予約人数 96名') && pv.includes('達成率 64%'));
check('🔴 対象と除外の条件が書いてある', pv.includes('10月の新規来店予約が対象') && pv.includes('取消・重複を除く'));
check('🔴 本日の新規・キャンセル・増減が出る', pv.includes('新規予約 9件 ／ キャンセル 2件 ／ 増減 +7件'));
check('🔴 媒体別が累計つきで出る', pv.includes('Meta広告　新規 5件 ／ 取消 1件 ／ 累計 52名'));
check('🔴 広告費とCPAが出る', pv.includes('合計広告費 ¥152,000') && pv.includes('¥1,583 / 名'));
check('🔴 オープン前に売上を出さない（まだ営業していない）', !pv.includes('売上'));
check('🔴 対象期間は本オープン月の範囲', pv.includes('対象期間: 2026-10-01〜2026-10-31'));

// ── プレオープン期間のレポート（見本 03 / 比較テーブル型）──────────────
await shopRow(1).locator('[data-dr-preopendate]').first().fill('2026-09-01');
await page.waitForTimeout(1200);
check('🔴 プレオープン日を過ぎると「プレオープン」に変わる',
  (await page.locator('[data-dr-phase="1"]').first().innerText()) === 'プレオープン',
  await page.locator('[data-dr-phase="1"]').first().innerText());
await shopRow(1).getByRole('button', { name: 'いまの期間の下書き' }).first().click();
await page.waitForTimeout(1500);
pv = await page.locator('[data-dr-preview]').first().innerText();
check('プレオープンは日報が出る', pv.includes('プレオープン日報'));
check('🔴 何日目かが出る', pv.includes('プレオープン初日'));
check('🔴 本日売上と内訳が出る', pv.includes('本日売上 ¥89,750') && pv.includes('新規来店13名・入会4名・次回予約11名'));
check('🔴 セラピスト別の横並びが出る', pv.includes('セラピスト別・店舗合計') && pv.includes('スタッフA ／ スタッフB'));
check('🔴 店舗合計まで並ぶ', pv.includes('¥32,000 ／ ¥57,750　＝ ¥89,750'));
check('🔴 率は合計から出し直した値', pv.includes('入会率　20% ／ 37.5%　＝ 30.8%'));
check('🔴 計算の定義を必ず添える', pv.includes('入会率＝入会人数 ÷ 新規来店数') && pv.includes('再来店数とは別'));
check('🔴 「集計実行」の後に出していると断る', pv.includes('「集計実行」の完了後'));

// ── 🔴 フラグOFFの間は押しても送らない ────────────────────────
sent = [];
await shopRow(1).getByRole('button', { name: /いま送る/ }).first().click();
await page.waitForTimeout(1200);
check('🔴 フラグOFFのまま押しても送られない', sent.length === 0, `${sent.length} 通`);
check('🔴 送っていないことを画面で伝える', (await panel().first().innerText()).includes('フラグがOFFなので送っていません'));

// ── 🔴 フラグを画面から切り替えたら、読み込み直さなくても表示が揃うか ──────
//    ここがずれると「送らない」と出しながら実際は送る（またはその逆）になる。
await page.getByRole('button', { name: 'ONにする' }).last().click().catch(() => {});
await page.waitForTimeout(1800);
check('🔴 フラグをONにすると、読み込み直さなくてもパネルの表示が変わる',
  (await page.locator('[data-dr-flag]').first().innerText()).includes('送信ON'),
  await page.locator('[data-dr-flag]').first().innerText());
check('🔴 ONになったら「1通も送りません」を出し続けない',
  !(await panel().first().innerText()).includes('1通も送りません'));

// ── 読み込み直しても同じ ───────────────────────────────────────
await page.evaluate(async () => {
  await fetch('/api/plan-store', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'ccflags', action: 'set', key: 'cc_daily_report', value: true }) });
});
await page.reload({ waitUntil: 'commit' });
for (let i = 0; i < 40; i++) { if ((await txt()).trim().length > 40) break; await page.waitForTimeout(700); }
await openSettings();
check('ONにすると表示が変わる', (await page.locator('[data-dr-flag]').first().innerText()).includes('送信ON'));
check('ONのときは「1通も送りません」を出さない', !(await panel().first().innerText()).includes('1通も送りません'));
check('🔴 ONでも「Webhook未確認」の断りは消さない', (await panel().first().innerText()).includes('未確認'));
check('保存した設定が残っている', (await shopRow(1).locator('select').count()) === 1);

await shopRow(1).getByRole('button', { name: /いま送る/ }).first().click();
await page.waitForTimeout(1500);
check('ONにすると送られる', sent.length === 1 && sent[0].shopId === '1', JSON.stringify(sent));
check('送ったことを画面で伝える', (await page.locator('[data-dr-preview]').first().innerText()).includes('送信しました'));

check('画面のエラーが出ていない', errors.length === 0, errors.join(' | '));

await browser.close();
server.close();
const ng = results.filter(r => !r.pass);
console.log(`\n  ${results.length - ng.length}/${results.length} OK`);
if (ng.length) { console.log('  NG:'); ng.forEach(r => console.log(`   - ${r.name} ${r.detail}`)); process.exit(1); }
