// ── 受入区分2: ①の画面 ＋ ①の実handler → HTTP③（実ブラウザ）────────────────
//
// ③の CREATIVE_JOB_CONTRACT.md「受入の分離」の区分2を通すための検査台です。
//
//   区分1 … ③ローカル単体・実HTTP                     … ③が実施済み
//   区分2 … ①現行candidateの画面＋**実handler**→HTTP③  … ここ
//   区分3 … 配備済み保護環境                            … 未実施
//
// ⚠️ **scripts/creative-screen-check.mjs とは別物です。**
//    あちらは③をスタブにした画面の確認。こちらは③を**本物**にして、
//    ①の `api/plan-store.js` をそのまま通します。
//    ③のURLが未設定なら、何も確認せずスキップします（緑にしません）。
//
// ⚠️ 本番のKV・保存先・SalonOneには一切つながりません。
//    KVはこのプロセス内の入れもの、保存先もプロセス内です。
//    暗号化・復号・認可・上限判定は**本物のコード**を通ります。
//    ③だけが本物のHTTPの向こうにいます。
//
// ⚠️ 「ここが緑」＝「配備できた」ではありません。区分3は別に確認が要ります。
//
// 実行:
//   CREATIVE_GEN_API_BASE=http://127.0.0.1:8768 \
//   CREATIVE_GEN_API_KEY=<③から受け取った鍵> \
//   GEN_TENANT_ID=naoru GEN_STORE_ID=s1 GEN_BRAND_VERSION=demo_brand_v1 \
//   DASHBOARD_ROOT=/home/user/dashboard/public CDN_DIR=/tmp/cdn \
//   CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
//   PLAYWRIGHT_PATH=/home/user/dashboard/node_modules/playwright/index.mjs \
//   OUT_DIR=/tmp node scripts/creative-gen-check.mjs
//
// ⚠️ 鍵をコマンド履歴に残したくない場合は、環境変数ファイルから読ませてください。
//    このスクリプトは鍵を出力にも画面写しにも出しません。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { hashOwnerToken } from '../lib/settlement.js';
import { kvEvalFake } from '../tests/helpers/kv-fake.js';

const GEN_BASE = String(process.env.CREATIVE_GEN_API_BASE || '').trim().replace(/\/+$/, '');
const GEN_KEY = String(process.env.CREATIVE_GEN_API_KEY || '').trim();

if (!GEN_BASE || !GEN_KEY) {
  console.log('\n  スキップ: ③の生成APIが未設定です。');
  console.log('  CREATIVE_GEN_API_BASE と CREATIVE_GEN_API_KEY を渡してください。');
  console.log('  ⚠️ これは「合格」ではありません。受入区分2は未実施のままです。\n');
  process.exit(2);           // 0（合格）とも 1（不合格）とも別の番号にする
}

// ③側の台帳に合わせる値。①の既定と違うなら、③の設定を①に合わせてください。
const TENANT = process.env.GEN_TENANT_ID || 'naoru';
const STORE = process.env.GEN_STORE_ID || 's1';
const BRAND = process.env.GEN_BRAND_VERSION || 'demo_brand_v1';

const ROOT = process.env.DASHBOARD_ROOT || path.join(process.cwd(), 'public');
const OUT = process.env.OUT_DIR || '/tmp';
const PORT = Number(process.env.PORT || 4412);
const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const PASSWORD = 'local-check-password-not-a-secret';
const SALT = 'local-check-salt-not-a-secret';

process.env.KV_REST_API_URL = 'https://kv.local-check';
process.env.KV_REST_API_TOKEN = 'local-check-token-not-a-secret';
process.env.VERCEL_ENV = 'preview';                 // 本番KVを触らない・上限もキャッシュしない
process.env.DASHBOARD_PASSWORD = PASSWORD;
process.env.AUTH_SALT = SALT;
process.env.CREATIVE_ASSET_KEY = 'local-check-creative-asset-master-key-0123456789';

const KV = process.env.KV_REST_API_URL;
// ⚠️ ①は保存先ホストを許可パターンで絞っている（任意URLを画面で開かせないため）。
//    検査台の入れものも、その形に合わせないと素材登録の時点で弾かれる。
//    **外へは一切出ません。**この文字列に届く通信は上の fetch 差し替えが受け止めます。
const BLOB_HOST = 'https://local-check.public.blob.vercel-storage.com/creative/';
const kvStore = new Map();
const FLAGS_KEY = 'naoru:cc:flags:v1:preview';
const FLAGS_VALUE = JSON.stringify({ cc_all: true, cc_authz: 'off', cc_creative_library: true });
const blobStore = new Map();
const upstream = [];               // ③へ実際に出て行った呼び出し（鍵は記録しない）

// ── fetch の差し替え。③へ行くものだけ本物を通す ──────────────────────
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (b) => ({ ok: true, status: 200, json: async () => b, headers: new Map() });
  if (u.startsWith(`${KV}/get/`)) {
    const k = decodeURIComponent(u.slice(`${KV}/get/`.length));
    // ⚠️ 機能フラグは、この検査台では常に開けておく（画面が書き換えても戻す）。
    //    ここで見たいのは①⇄③の受け渡しであって、①のロールアウト制御ではない。
    if (k === FLAGS_KEY) return ok({ result: FLAGS_VALUE });
    return ok({ result: kvStore.has(k) ? kvStore.get(k) : null });
  }
  if (u.startsWith(`${KV}/set/`)) {
    kvStore.set(decodeURIComponent(u.slice(`${KV}/set/`.length)), String(opts.body));
    return ok({ result: 'OK' });
  }
  if (u === KV) { const f = kvEvalFake(kvStore, JSON.parse(opts.body)); if (f) return ok(f); return ok({ result: null }); }
  if (u.startsWith(BLOB_HOST)) {
    const b = blobStore.get(u);
    if (!b) return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    const m = /^bytes=(\d+)-(\d+)$/.exec(String((opts.headers || {}).Range || ''));
    const part = m ? b.subarray(Number(m[1]), Number(m[2]) + 1) : b;
    return { ok: true, status: m ? 206 : 200, headers: new Map(), json: async () => ({}),
             arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) };
  }
  // ③（本物）。リダイレクトは受けない。
  if (u.startsWith(GEN_BASE)) {
    const started = Date.now();
    const r = await realFetch(url, { ...opts, redirect: 'error' }).catch((e) => ({ __err: String(e && e.message || e) }));
    upstream.push({ path: u.slice(GEN_BASE.length).split('?')[0], method: opts.method || 'GET',
                    status: r.__err ? 0 : r.status, ms: Date.now() - started, err: r.__err || '' });
    if (r.__err) throw new Error(r.__err);
    return r;
  }
  throw new Error(`想定外の宛先へ出ようとしました: ${u}`);
};

// ── ①の実handler を載せる ───────────────────────────────────────
const { default: handler } = await import('../api/plan-store.js');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json' };

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    // 保存先のかわり。ここへ来るのは**暗号文だけ**。
    if (p.startsWith('/__blob/')) {
      const u = BLOB_HOST + p.slice('/__blob/'.length);
      blobStore.set(u, raw);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ url: u }));
    }
    if (p === '/api/settlement-auth') {
      res.setHeader('Content-Type', 'application/json');
      // ⚠️ configured を返さないと、画面が「開発環境」と判断して認証を飛ばし、
      //    token='dev-mode' のまま①のhandlerを叩いて 403 になる。
      //    ここは**本物のログインを通したい**ので、設定済みだと答える。
      if (req.method === 'GET') return res.end(JSON.stringify({ ok: true, configured: true, rootConfigured: true, shops: {} }));
      return res.end(JSON.stringify({ ok: true, token: hashOwnerToken('__root__', PASSWORD, SALT),
        owner: '__root__', root: true, role: 'root' }));
    }
    if (p === '/api/plan-store') {
      let body = {}; try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch {}
      // ⚠️ **creative と ccflags だけ①の実handlerを通す。**
      //    他の画面（chat/board/…）は、この検査台の関心外なので既定値を返す。
      //    ここを実handlerにすると、KVが空なせいで画面全体が起動しない。
      const type = req.method === 'GET' ? url.searchParams.get('type') : body.type;
      if (type !== 'creative' && type !== 'ccflags') {
        res.setHeader('Content-Type', 'application/json');
        if (type === 'chat') return res.end(JSON.stringify({ rooms: [], messages: {}, reads: {}, dir: { staff: [] }, notes: {}, configured: true }));
        if (type === 'board') return res.end(JSON.stringify({ posts: [], reads: {}, configured: true }));
        return res.end(JSON.stringify({ ok: true, success: true, configured: true, data: [] }));
      }
      // ブラウザから来た認証ヘッダをそのまま①のhandlerへ渡す（認可は本物を通す）。
      const r = { statusCode: 0, headers: {}, _body: null, _buf: null };
      const fake = {
        setHeader: (k, v) => { r.headers[k] = v; },
        status: (c) => { r.statusCode = c; return fake; },
        json: (b) => { r._body = b; return fake; },
        send: (b) => { r._buf = b; return fake; },
        end: (b) => { if (b !== undefined) r._buf = b; return fake; },
      };
      await handler({ method: req.method, headers: req.headers,
        query: Object.fromEntries(url.searchParams), body }, fake).catch((e) => {
        r.statusCode = 500; r._body = { ok: false, error: { code: 'handler_threw', message: String(e && e.message || e) } };
      });
      if (process.env.RIG_DEBUG && type === 'creative') {
        console.log(`  [rig] creative ${body.action || url.searchParams.get('action') || ''} -> ${r.statusCode}`,
          JSON.stringify(r._body && r._body.error || r._body && r._body.code || '').slice(0, 120),
          'hdr:', JSON.stringify({ o: req.headers['x-cc-owner'], t: String(req.headers['x-cc-token'] || '').slice(0, 12) }));
      }
      res.statusCode = r.statusCode || 200;
      for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
      if (r._buf != null) return res.end(Buffer.isBuffer(r._buf) ? r._buf : Buffer.from(r._buf));
      if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(r._body == null ? {} : r._body));
    }
    if (p.startsWith('/api/salonone')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [], meta: {} })); }
    if (p.startsWith('/api/')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok: true, success: true, data: [] })); }

    const file = path.join(ROOT, decodeURIComponent(p === '/' ? '/index.html' : p));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('nf'); }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
});

// フラグを開けておく（この検査台の中だけ）。読み出しは上の fetch で固定している。
kvStore.set(FLAGS_KEY, FLAGS_VALUE);

await new Promise(r => server.listen(PORT, '127.0.0.1', r));

// 施術素材は使わない。中身が DEMO と分かる小さなPNGをここで作る。
function demoPng() {
  const zlib = require('node:zlib');
  const w = 64, h = 64, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = 185; raw[o + 1] = 45; raw[o + 2] = 61;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass, detail });
  console.log(`  ${pass ? 'OK  ' : 'NG  '} ${name}${detail ? '  ' + detail : ''}`); };

console.log(`\n  ③: ${GEN_BASE}   tenant=${TENANT} store=${STORE} brand=${BRAND}`);
console.log('  ⚠️ ここが緑でも「配備できた」ことにはなりません（区分3は別）。\n');

// ── まず③そのものへ、①のhandler経由で上限を聞く ───────────────────
const api = async (payload) => {
  const r = await realFetch(`http://127.0.0.1:${PORT}/api/plan-store`, {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      'x-cc-owner': '__root__', 'x-cc-token': hashOwnerToken('__root__', PASSWORD, SALT) },
    body: JSON.stringify({ type: 'creative', ...payload }),
  });
  return await r.json().catch(() => ({}));
};

const lim = await api({ action: 'limits' });
check('③から文字数上限を取れる（①のhandler経由・実HTTP）',
  !!(lim.limits && lim.limits.loaded),
  lim.limits && lim.limits.loaded
    ? `見出し${lim.limits.text.headline} / 本文${lim.limits.text.body} / ボタン${lim.limits.text.cta}`
    : (lim.limits && lim.limits.reason) || '取得できず');

check('③の応答が2秒以内（契約の目標）',
  upstream.length > 0 && upstream[upstream.length - 1].ms < 2000,
  upstream.length ? `${upstream[upstream.length - 1].ms}ms` : '呼び出しなし');

check('🔴 ③へのリダイレクトを受け取っていない',
  upstream.every(x => !x.err || !/redirect/i.test(x.err)),
  upstream.filter(x => x.err).map(x => x.err).join(' | ') || 'なし');

if (!(lim.limits && lim.limits.loaded)) {
  console.log('\n  上限が取れないため、ここで止めます。');
  console.log('  ③の起動・鍵・X-Tenant-Id の一致を確認してください。');
  console.log(`  ①が名乗っている tenant は "${TENANT}" です（①側の既定は naoru）。\n`);
  server.close();
  const ng0 = results.filter(r => !r.pass);
  console.log(`  結果: ${results.length - ng0.length}/${results.length}（区分2は未完了）`);
  process.exit(1);
}

// ── 画面を開いて、素材→案→文言→生成→表示→修正→v2→download まで ────────
const { chromium } = await import(PW);
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-proxy-server', '--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({ serviceWorkers: 'block' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e && e.message || e)));

// 外へは出ない。React/Babel/Tailwind は手元の写しを使う。
const CDN = process.env.CDN_DIR || '/tmp/cdn';
const localJs = (f) => ({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(f) });
await page.route(/.*/, route => {
  const u = route.request().url();
  if (u.startsWith(`http://127.0.0.1:${PORT}`)) return route.continue();
  if (u.includes('/react-dom')) return route.fulfill(localJs(`${CDN}/react-dom.js`));
  if (u.includes('/react')) return route.fulfill(localJs(`${CDN}/react.js`));
  if (u.includes('babel')) return route.fulfill(localJs(`${CDN}/babel.js`));
  if (u.includes('tailwindcss.com')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.tailwind={config:{}};' });
  // @vercel/blob の代わり。渡ってきたバイト（暗号文）をそのまま保存先へ送る。
  if (u.includes('@vercel/blob')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    export const upload = async (name, body) => {
      const r = await fetch('/__blob/' + encodeURIComponent(name), { method: 'POST', body });
      return await r.json();
    };` });
  return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
});

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'commit', timeout: 60000 });
  const txt = async () => await page.locator('body').innerText().catch(() => '');
  for (let i = 0; i < 40; i++) { if ((await txt()).trim().length > 40) break; await page.waitForTimeout(1000); }

  const pw = page.locator('input[type="password"]');
  if (await pw.count()) { await pw.first().fill(PASSWORD); await page.keyboard.press('Enter'); await page.waitForTimeout(3000); }
  const authToken = await page.evaluate(() => {
    try { return String((JSON.parse(localStorage.getItem('naoru_auth') || '{}') || {}).token || ''); } catch { return ''; }
  }).catch(() => '');
  check('①の共通ログインを通る（認可は本物のコード）',
    (await page.locator('input[type="password"]').count()) === 0,
    authToken === 'dev-mode' ? '⚠️ dev-mode（認証を飛ばしている）' : '');
  check('🔴 認証を飛ばしていない（dev-mode で通していない）', authToken !== 'dev-mode', authToken ? `token=${authToken.slice(0, 8)}…` : 'token不明');

  await page.getByRole('button', { name: /クリエイティブ/ }).first().click().catch(() => {});
  await page.waitForTimeout(3000);
  if (process.env.RIG_DEBUG) {
    console.log('--- body ---\n' + (await txt()).slice(0, 1200) + '\n--- /body ---');
    console.log('--- buttons ---');
    console.log((await page.locator('button').allInnerTexts()).slice(0, 40).join(' | '));
  }
  check('クリエイティブ画面が開く', (await txt()).includes('素材を登録する'));
  // 接続状態と上限は、画面が開いてから読み込まれる（2回のPOST）。出るまで待つ。
  for (let i = 0; i < 30; i++) {
    if ((await page.locator('[data-cv-limits="loaded"]').count()) > 0) break;
    await page.waitForTimeout(500);
  }
  if (process.env.RIG_DEBUG) console.log('--- creative screen ---\n' + (await txt()).slice(0, 900) + '\n---');
  check('③が接続済みと出る', (await txt()).includes('生成API 接続済み'));
  check('🔴 ③のテンプレ上限が画面に出る（①の既定値ではない）',
    (await page.locator('[data-cv-limits="loaded"]').count()) > 0
    && (await txt()).includes(`見出し ${lim.limits.text.headline}文字`));

  // ── 素材を登録する ──────────────────────────────────────────
  fs.writeFileSync(path.join(OUT, 'gen-demo.png'), demoPng());
  await page.locator('input[placeholder*="春キャンペーン"]').first().fill('デモ素材（施術素材ではありません）');
  await page.locator('#cv-files').setInputFiles([path.join(OUT, 'gen-demo.png')]);
  await page.getByRole('button', { name: /^素材を登録$/ }).first().click();
  for (let i = 0; i < 30; i++) { if ((await txt()).includes('素材を登録しました')) break; await page.waitForTimeout(500); }
  check('素材を登録できた', (await txt()).includes('素材を登録しました'));
  check('🔴 保存先には暗号文しか無い',
    [...blobStore.values()].length > 0 && [...blobStore.values()].every(b => b[0] !== 0x89));

  // ── 案を作って、③の上限に合わせて文言を書く ─────────────────────
  await page.locator('[data-cv-add-draft]').first().click().catch(() => {});
  await page.waitForTimeout(2000);
  await page.locator('[data-cv-text-open]').first().click().catch(() => {});
  await page.waitForTimeout(500);
  const hasFields = (await page.locator('[data-cv-text-field="headline"]').count()) > 0;
  if (hasFields) {
    await page.locator('[data-cv-text-field="headline"]').first().fill('まずは、気になることを相談。');
    await page.locator('[data-cv-text-field="body"]').first().fill('相談を始める入口を伝えるデモの本文です。');
    await page.locator('[data-cv-text-field="cta"]').first().fill('相談内容を確認');
    await page.locator('[data-cv-text-save]').first().click();
    await page.waitForTimeout(2000);
  }
  check('③の上限に収まる文言を保存できる', hasFields && (await txt()).includes('文言を保存しました'));

  // 上限を1文字超えたら保存させない（③へ送る前に止まる）
  await page.locator('[data-cv-text-open]').first().click().catch(() => {});
  await page.waitForTimeout(400);
  let blocked = false;
  if ((await page.locator('[data-cv-text-field="headline"]').count()) > 0) {
    await page.locator('[data-cv-text-field="headline"]').first().fill('あ'.repeat(lim.limits.text.headline + 1));
    await page.waitForTimeout(300);
    blocked = await page.locator('[data-cv-text-save]').first().isDisabled().catch(() => false);
    await page.locator('[data-cv-text-field="headline"]').first().fill('まずは、気になることを相談。');
    await page.waitForTimeout(200);
    await page.locator('[data-cv-text-save]').first().click().catch(() => {});
    await page.waitForTimeout(1500);
  }
  check('🔴 上限を1文字超えたら保存できない（③へ送らない）', blocked);

  // ── ③へ生成を依頼する（実HTTP）──────────────────────────────
  const before = upstream.length;
  await page.getByRole('button', { name: /③へ生成を依頼/ }).first().click().catch(() => {});
  await page.waitForTimeout(4000);
  const sent = upstream.slice(before).filter(x => x.path === '/v1/creative/generate');
  check('③の /v1/creative/generate を実際に呼んだ', sent.length > 0,
    sent.map(x => `${x.status}`).join(',') || '呼んでいない');
  const accepted = sent.some(x => x.status === 202 || x.status === 200);
  // ①の画面に出た失敗理由（③が何を言ったのか）を拾う。
  const reason = ((await txt()).match(/生成APIが[^\n]*|③[^\n]*(?:できません|返しました)[^\n]*/) || [''])[0];
  check('③が依頼を受け付けた（202）', accepted,
    accepted ? '' : `③の応答: ${sent.map(x => x.status).join(',')}${reason ? ' / 画面: ' + reason : ''}`);
  check('🔴 受け付けられなかったときは「失敗」と出し、サンプルを作らない',
    accepted || ((await txt()).includes('失敗') && !(await txt()).includes('完成')), reason);

  await page.screenshot({ path: path.join(OUT, 'creative-gen-check.png'), fullPage: true });
  check('画面の写しを保存した', fs.existsSync(path.join(OUT, 'creative-gen-check.png')),
    path.join(OUT, 'creative-gen-check.png'));
  check('画面のエラーが出ていない', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close().catch(() => {});
  server.close();
}

console.log('\n  ③へ出た呼び出し:');
for (const u of upstream) console.log(`   ${u.method} ${u.path} → ${u.status || 'ERR'} (${u.ms}ms)${u.err ? ' ' + u.err : ''}`);

const ng = results.filter(r => !r.pass);
console.log(`\n  結果: ${results.length - ng.length}/${results.length}`);
if (ng.length) { console.log('  NG:'); for (const r of ng) console.log('   -', r.name, r.detail); }
console.log('\n  ⚠️ ここから先が未実施（③側の設定が決まらないと流せない）:');
console.log('     画像表示・動画再生・修正依頼・version2表示・download・失効拒否');
console.log('     ①の素材IDはサーバー発番（as_…）なので、③の起動時設定へ事前に書けません。');
console.log('     ③が①の素材IDをどう受け取るかが決まれば、この検査台に続きを足せます。\n');
process.exitCode = ng.length ? 1 : 0;
