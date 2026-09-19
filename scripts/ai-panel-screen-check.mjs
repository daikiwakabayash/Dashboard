// ── 業務AIの提案パネルの画面レベル検証 ──────────────────────────────
// 正本の契約は naoru-ai-platform/AGENTS.md §3。
// ⚠️ 本番には一切つながりません。ローカルのスタブAPIに対してだけ動かします。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');

const ROOT = process.env.DASHBOARD_ROOT || process.cwd();
const CDN = process.env.CDN_DIR || '/tmp/cdn';
const PORT = 8980;
const TYPES = { '.html':'text/html;charset=utf-8', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml' };

const SHOPS = [{ id: 1, name: 'NAORU 鶴見院' }];
const STAFF = [{ staff_id: 's1', name: 'スタッフ1', shop_name: 'NAORU 鶴見院' }];

// 架空の回答（本番データではありません）。③が入れる形を真似ています。
const CITE = { id: 'c1', label: 'SalonOne 月次実績', version: 'v3', current: true };
let answers = {};   // 最初は空＝何も出ないこと自体を確かめる
const HOME_ANSWER = {
  agent: 'chief', status: 'completed',
  citations: [CITE],
  facts: [
    { text: '当月の新規来店', value: 132, unit: '人', period: '2026-09-01〜2026-09-18', defVersion: 'agg-v2', citationIds: ['c1'], origin: 'source' },
  ],
  hypotheses: [{ text: '前月の広告停止が効いている可能性があります', origin: 'model' }],
  missingData: ['当月の広告費（Meta 未接続）'],
  proposedActions: [
    { id: 'a1', kind: 'meta_budget_change', title: '鶴見院の予算を 20% 戻す', why: '新規が前月比で落ちているため', citationIds: ['c1'] },
    { id: 'a2', kind: 'read_report', title: '店舗別の内訳を出す' },
  ],
  freshness: { at: Date.now() - 5 * 60 * 1000 },
};
// 🔴 出典の無い主張・AIが作った値を混ぜた回答（落ちることを確かめる）
const DIRTY_ANSWER = {
  agent: 'chief', status: 'completed',
  citations: [CITE],
  facts: [
    { text: '出典のない主張', value: 99, unit: '人', period: '2026-09', defVersion: 'agg-v2', citationIds: [], origin: 'source' },
    { text: 'AIが作った値', value: 50, unit: '人', period: '2026-09', defVersion: 'agg-v2', citationIds: ['c1'], origin: 'model' },
  ],
  freshness: { at: Date.now() - 40 * 3600 * 1000 },   // 古い
};
const EMPTY_ANSWER = { agent: 'chief', status: 'completed', citations: [], freshness: {} };

const json = (res, o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
// スタブでも、サーバーと同じ「出典の無い主張は事実から外す」を通す
const demote = (a) => {
  const known = new Set((a.citations || []).map(c => c.id));
  const facts = [], hyp = [...(a.hypotheses || [])];
  for (const f of (a.facts || [])) {
    const cited = (f.citationIds || []).some(id => known.has(id));
    if (f.origin === 'source' && cited) facts.push(f); else hyp.push(f);
  }
  return { ...a, facts, hypotheses: hyp };
};

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
      if (type === 'ccflags') return json(res, { flags: { cc_all: true, cc_authz: 'off', cc_home: true, cc_ai_agents: true, cc_creative_library: true }, configured: true, env: 'preview' });
      if (type === 'aianswer') {
        if (req.method === 'GET') {
          const screen = url.searchParams.get('screen') || '';
          // 担当 → 置いた画面（lib/ai-answer.js の AGENTS と同じ）
          const SCREEN = { chief: 'home', marketing: 'mktg', finance: 'planning', storerisk: 'zenkanri',
                           sns: 'creative', content: 'creative', product: 'settings', knowledge: 'knowledge' };
          const out = Object.values(answers).filter(a => SCREEN[a.agent] === screen).map(demote);
          return json(res, { ok: true, answers: out, configured: true });
        }
        if (body.action === '__put') { answers[body.answer.agent] = body.answer; return json(res, { ok: true }); }
        if (body.action === '__clear') { answers = {}; return json(res, { ok: true }); }
        return json(res, { ok: true });
      }
      if (type === 'chat') return json(res, { rooms: [], messages: {}, reads: {},
        dir: { staff: STAFF.map(x => ({ id: x.staff_id, name: x.name, shop: x.shop_name })) }, notes: {}, configured: true });
      if (type === 'board') return json(res, { posts: [], reads: {}, configured: true, hero: null });
      if (type === 'events') return json(res, { sections: {}, configured: true });
      if (type === 'approval') return json(res, { ok: true, items: [], configured: true });
      return json(res, { ok: true, configured: true });
    }
    if (p.startsWith('/api/salonone')) {
      if (/shop|store/i.test(req.url)) return json(res, { data: SHOPS, meta: {} });
      if (/staff/i.test(req.url)) return json(res, { data: STAFF, meta: {} });
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
const gotoHome = async () => {
  await page.getByRole('button', { name: /経営ホーム|ホーム/ }).first().click().catch(() => {});
  await page.waitForTimeout(2000);
};
const put = (a) => page.evaluate(async (ans) => {
  await fetch('/api/plan-store', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'aianswer', action: '__put', answer: ans }) });
}, a);

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'commit', timeout: 60000 });
for (let i = 0; i < 40; i++) { if ((await txt()).trim().length > 40) break; await page.waitForTimeout(1000); }
const pw = page.locator('input[type="password"]');
if (await pw.count()) { await pw.first().fill(process.env.STUB_PW || 'pw'); await page.keyboard.press('Enter'); await page.waitForTimeout(3000); }
check('rootでログインできる', (await page.locator('input[type="password"]').count()) === 0);

await gotoHome();
// ── ③が入れていないときは何も出さない ─────────────────────────
check('🔴 ③が回答を入れていなければ、空の枠すら出さない', (await page.locator('[data-ai-panel]').count()) === 0);

// ── 回答が入ったら出る ──────────────────────────────────────
await put(HOME_ANSWER);
await page.reload({ waitUntil: 'commit' });
for (let i = 0; i < 40; i++) { if ((await txt()).trim().length > 40) break; await page.waitForTimeout(700); }
await gotoHome();
check('回答が入ると提案が出る', (await page.locator('[data-ai-answer="chief"]').count()) === 1);
let t = await txt();
check('担当の名前が出る', t.includes('経営の相談役') && t.includes('Chief of Staff'));

// 事実・見立て・未取得の区別
check('🔴 事実と見立てを分けて出す',
  (await page.locator('[data-ai-facts]').count()) === 1 && (await page.locator('[data-ai-hypotheses]').count()) === 1);
const factsTxt = await page.locator('[data-ai-facts]').first().innerText();
check('事実には「出典のある事実」と書いてある', factsTxt.includes('出典のある事実'));
check('数値が出る', factsTxt.includes('132人'));
check('🔴 数値のそばに対象期間・出典・集計定義を必ず出す',
  factsTxt.includes('対象期間: 2026-09-01〜2026-09-18') && factsTxt.includes('出典: SalonOne 月次実績') && factsTxt.includes('集計定義: agg-v2'));
const hypTxt = await page.locator('[data-ai-hypotheses]').first().innerText();
check('見立てには「まだ裏が取れていません」と書いてある', hypTxt.includes('まだ裏が取れていません'));
check('🔴 取れていないものは「未取得」と出す（0 で埋めない）',
  (await page.locator('[data-ai-missing]').count()) === 1
  && (await page.locator('[data-ai-missing]').first().innerText()).includes('未取得'));
check('未取得の節に「0 では埋めていません」と書いてある',
  (await page.locator('[data-ai-missing]').first().innerText()).includes('0 では埋めていません'));

// 提案と承認
check('提案が出る', (await page.locator('[data-ai-actions]').count()) === 1);
const actTxt = await page.locator('[data-ai-actions]').first().innerText();
check('🔴 外向きの操作には「人の承認が要ります」と出す', actTxt.includes('人の承認が要ります'));
check('読み取りだけの提案は承認不要と分かる', actTxt.includes('読み取りのみ'));
check('🔴 この画面からは実行できないと書いてある', actTxt.includes('ここから実行はできません'));
check('🔴 実行ボタンを置いていない',
  (await page.locator('[data-ai-actions] button').count()) === 0, `${await page.locator('[data-ai-actions] button').count()} 個`);

// 鮮度
check('いつ時点の情報かを出す', (await page.locator('[data-ai-fresh]').first().innerText()).includes('分前の情報'));
check('出典を画面の下にも出す', (await page.locator('[data-ai-citations]').count()) === 1);

// ── 🔴 出典の無い主張は事実として出さない ────────────────────────
await put(DIRTY_ANSWER);
await page.reload({ waitUntil: 'commit' });
for (let i = 0; i < 40; i++) { if ((await txt()).trim().length > 40) break; await page.waitForTimeout(700); }
await gotoHome();
const dirtyFacts = await page.locator('[data-ai-facts]').count();
check('🔴 出典の無い主張・AIが作った値は「事実」に出さない', dirtyFacts === 0, `事実の節 ${dirtyFacts} 個`);
const dirtyHyp = await page.locator('[data-ai-hypotheses]').first().innerText().catch(() => '');
check('🔴 落とした主張は捨てずに「見立て」へ回す',
  dirtyHyp.includes('出典のない主張') && dirtyHyp.includes('AIが作った値'));
check('🔴 古い情報は色を変えて知らせる',
  (await page.locator('[data-ai-fresh].old').count()) === 1,
  await page.locator('[data-ai-fresh]').first().innerText());

// ── 根拠が無ければ「判断不能」 ───────────────────────────────
await put(EMPTY_ANSWER);
await page.reload({ waitUntil: 'commit' });
for (let i = 0; i < 40; i++) { if ((await txt()).trim().length > 40) break; await page.waitForTimeout(700); }
await gotoHome();
check('🔴 根拠が無ければ「判断できませんでした」と出す',
  (await page.locator('[data-ai-verdict]').count()) === 1
  && (await page.locator('[data-ai-verdict]').first().innerText()).includes('根拠が足りません'));
check('判断不能のときは事実も提案も出さない',
  (await page.locator('[data-ai-facts]').count()) === 0 && (await page.locator('[data-ai-actions]').count()) === 0);

// ── スマホ ──────────────────────────────────────────────
await put(HOME_ANSWER);
await page.reload({ waitUntil: 'commit' });
for (let i = 0; i < 40; i++) { if ((await txt()).trim().length > 40) break; await page.waitForTimeout(700); }
await gotoHome();
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(900);
const overflow = await page.evaluate(() => {
  const root = document.querySelector('[data-ai-panel]');
  if (!root) return ['パネルが無い'];
  const out = [];
  for (const el of root.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width < 1) continue;
    if (r.right > window.innerWidth + 1 || r.left < -1) out.push(`${el.className || el.tagName}`);
  }
  return [...new Set(out)].slice(0, 5);
});
check('スマホで画面からはみ出さない', overflow.length === 0, overflow.join(' / '));
const out = process.env.OUT_DIR || '/tmp';
await page.screenshot({ path: `${out}/ai-panel-mobile.png` });
await page.setViewportSize({ width: 1500, height: 1000 });
await page.waitForTimeout(700);
await page.screenshot({ path: `${out}/ai-panel.png` });
check('画面の写しを保存した', fs.existsSync(`${out}/ai-panel.png`), `${out}/ai-panel.png`);

// ── 🔴 8人ぶんの置き場所が全部あるか ─────────────────────────────
// ⚠️ ナレッジは独立ページが無く FAQ管理 の中にある（③との screen キーは変えない）。
const PLACES = [
  ['chief', 'home', /経営ホーム|ホーム/],
  ['marketing', 'mktg', /マーケティング/],
  ['finance', 'planning', /事業計画/],
  ['storerisk', 'zenkanri', /全体管理/],
  ['sns', 'creative', /クリエイティブ/],
  ['product', 'settings', /設定/],
  ['knowledge', 'knowledge', /FAQ管理/],
];
await page.evaluate(async () => {
  await fetch('/api/plan-store', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'aianswer', action: '__clear' }) });
});
for (const [agent] of PLACES) {
  await put({ agent, status: 'completed', citations: [CITE],
    facts: [{ text: `${agent} の事実`, value: 1, unit: '件', period: '2026-09',
              defVersion: 'agg-v2', citationIds: ['c1'], origin: 'source' }],
    freshness: { at: Date.now() - 60000 } });
}
await page.setViewportSize({ width: 1500, height: 1000 });
await page.reload({ waitUntil: 'commit' });
for (let i = 0; i < 40; i++) { if ((await txt()).trim().length > 40) break; await page.waitForTimeout(700); }
for (const [, screen, menu] of PLACES) {
  await page.getByRole('button', { name: menu }).first().click().catch(() => {});
  await page.waitForTimeout(1800);
  const n = await page.locator(`[data-ai-panel="${screen}"]`).count();
  check(`${screen} の画面に提案の置き場所がある`, n >= 1, `${n} 個`);
}
check('画面のエラーが出ていない', errors.length === 0, errors.slice(0, 2).join(' | '));

const ok = results.filter(r => r.pass).length;
console.log(`\n  結果: ${ok}/${results.length}`);
if (ok !== results.length) { console.log('  NG:'); results.filter(r => !r.pass).forEach(r => console.log(`   - ${r.name} ${r.detail}`)); }
await browser.close(); server.close();
process.exit(ok === results.length ? 0 : 1);
