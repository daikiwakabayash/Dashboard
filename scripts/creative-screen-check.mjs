// ── クリエイティブ画面の「実表示・実再生」確認（実ブラウザ）────────────────
//
// ⚠️ tests/creative-screen.test.js は **HTMLの記述を見るだけ**で、表示の確認ではありません。
//    こちらが表示・再生の確認です。完了条件は次の2つ:
//      ・実際に**開ける画像**（<img> の naturalWidth > 0）
//      ・実際に**再生できる動画**（currentTime が進む）
//
// ⚠️ 本番には一切つながりません。ローカルのスタブAPIに対してだけ動かします。
//    保存先も本物の Vercel Blob ではなく、このプロセス内の入れものです。
//    それでも **暗号化・復号は本物のコード（lib/creative-crypto.js）**を通します。
//
// 実行:
//   DASHBOARD_ROOT=/home/user/dashboard/public CDN_DIR=/tmp/cdn \
//   CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
//   PLAYWRIGHT_PATH=/home/user/dashboard/node_modules/playwright/index.mjs \
//   OUT_DIR=/tmp node scripts/creative-screen-check.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildAsset, confirmRights, buildCreative, requestRevision, approve as approveCreative,
  deliverables, compareSet, publicAsset, publicCreative, CHANNELS, STATUS_LABEL,
} from '../lib/creative.js';
import {
  masterKeyFrom, wrapKey, unwrapKey, fromB64, decryptChunk,
  chunksForRange, chunkCipherRange, parseRange, CHUNK,
} from '../lib/creative-crypto.js';
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');

const ROOT = process.env.DASHBOARD_ROOT || process.cwd();
const CDN = process.env.CDN_DIR || '/tmp/cdn';
const OUT = process.env.OUT_DIR || '/tmp';
const PORT = 8971;
const TYPES = { '.html':'text/html;charset=utf-8', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml' };

// 本物の親鍵と同じ扱い（32文字以上）
const MASTER = await masterKeyFrom('creative-asset-master-key-for-local-check-0123456789');
const STORE_HOST = 'https://abc123.public.blob.vercel-storage.com/';

// ── 保存先のかわり（このプロセス内）。**暗号文しか入らないことを後で確かめる。** ──
const blobStore = new Map();
const state = { assets: {}, creatives: {} };
const CTX = { tenantId: 'naoru', actorId: '__root__', actorName: '本部' };
const calls = [];
const json = (res, o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
const cerr = (code, message) => ({ ok: false, error: { code, message: message || code } });
const genId = (p) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

// 実サーバーと同じ手順でファイルを封じる（鍵を親鍵で包む）
async function sealFiles(raw, ownerId) {
  const out = [];
  for (const f of (raw || []).slice(0, 10)) {
    const fileId = String(f.fileId || genId('f'));
    if (!f.dataKey) return null;
    out.push({ ...f, dataKey: undefined, fileId,
      enc: { alg: 'A256GCM-CHUNK1M', key: await wrapKey(MASTER, fromB64(f.dataKey), `${ownerId}:${fileId}`),
             plainBytes: Number(f.plainBytes) || Number(f.bytes) || 0 } });
  }
  return out;
}

// 実サーバーと同じ手順で配信する（必要な区切りだけ復号する）
async function serveFile(res, rangeHeader, rec, fileId) {
  const f = (rec.files || []).find(x => x.fileId === fileId);
  if (!f) { res.statusCode = 404; return json(res, cerr('not_found')); }
  const keyOwner = String(f.fromAssetId || rec.id);
  const dataKey = await unwrapKey(MASTER, f.enc.key, `${keyOwner}:${f.fileId}`);
  if (!dataKey) { res.statusCode = 500; return json(res, cerr('key_invalid')); }
  const plainLen = Number(f.enc.plainBytes) || 0;
  const cipher = blobStore.get(f.storageUrl);
  if (!cipher) { res.statusCode = 502; return json(res, cerr('storage_error')); }
  const range = parseRange(rangeHeader, plainLen);
  if (range === 'invalid') { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${plainLen}`); return res.end(); }
  const want = range || { start: 0, end: Math.max(0, plainLen - 1) };
  const idx = chunksForRange(want.start, want.end, plainLen);
  const parts = [];
  for (const i of idx) {
    const cr = chunkCipherRange(i, plainLen);
    const dec = await decryptChunk(dataKey, f.fileId, i, new Uint8Array(cipher.subarray(cr.start, cr.end)));
    if (!dec) { res.statusCode = 500; return json(res, cerr('decrypt_failed')); }
    parts.push(Buffer.from(dec));
  }
  const joined = Buffer.concat(parts);
  const off = want.start - (idx.length ? idx[0] * CHUNK : 0);
  const out = joined.subarray(off, off + (want.end - want.start + 1));
  res.setHeader('Content-Type', f.contentType || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Accept-Ranges', 'bytes');
  if (range) { res.statusCode = 206; res.setHeader('Content-Range', `bytes ${want.start}-${want.end}/${plainLen}`); }
  res.end(out);
}

async function creativeApi(req, res, url, body) {
  const action = String(body.action || url.searchParams.get('action') || '');
  if (action === 'file') {
    const owner = url.searchParams.get('owner'), ownerId = url.searchParams.get('ownerId');
    const rec = owner === 'asset' ? state.assets[ownerId] : state.creatives[ownerId];
    if (!rec) { res.statusCode = 404; return json(res, cerr('not_found')); }
    return await serveFile(res, req.headers.range, rec, url.searchParams.get('fileId'));
  }
  if (action === 'list' || !action) {
    return json(res, { ok: true,
      assets: Object.values(state.assets).map(publicAsset),
      creatives: Object.values(state.creatives).map(publicCreative),
      channels: CHANNELS, statusLabels: STATUS_LABEL,
      storage: { ready: true, reason: '' },
      generator: { connected: false, reason: '③生成APIの接続先（CREATIVE_GEN_API_BASE）が未設定です' } });
  }
  if (action === 'asset_create') {
    const id = genId('as');
    const files = await sealFiles(body.asset && body.asset.files, id);
    if (!files) return json(res, cerr('key_required'));
    const built = buildAsset({ ...(body.asset || {}), files }, CTX);
    if (!built.ok) return json(res, cerr(built.error));
    built.asset.id = id; state.assets[id] = built.asset;
    return json(res, { ok: true, asset: publicAsset(built.asset) });
  }
  if (action === 'asset_rights') {
    const a = state.assets[body.asset_id];
    if (!a) return json(res, cerr('not_found'));
    const r = confirmRights(a, body.status, { ...CTX, consentPhoto: body.consent_photo, consentVoice: body.consent_voice });
    if (!r.ok) return json(res, cerr(r.error));
    state.assets[a.id] = r.asset;
    return json(res, { ok: true, asset: publicAsset(r.asset) });
  }
  if (action === 'creative_create') {
    const a = state.assets[body.asset_id];
    if (!a) return json(res, cerr('asset_not_found'));
    const id = genId('cr');
    const use = !!(body.creative && body.creative.use_asset_files);
    const files = use ? (a.files || []).map(f => ({ ...f, fromAssetId: a.id }))
                      : (await sealFiles(body.creative && body.creative.files, id)) || [];
    const r = buildCreative(a, { ...(body.creative || {}), files }, CTX);
    if (!r.ok) return json(res, cerr(r.error));
    r.creative.id = id; state.creatives[id] = r.creative;
    return json(res, { ok: true, creative: publicCreative(r.creative) });
  }
  if (action === 'generate') {
    // ③未接続。**サンプルを作らない**（本番と同じ挙動）。
    const c = state.creatives[body.creative_id];
    if (!c) return json(res, cerr('not_found'));
    state.creatives[c.id] = { ...c, status: 'failed', failureReason: '③の生成APIが未接続です（接続先・認証キーが未設定）' };
    return json(res, { ok: true, job_id: 'job_local', status: 'failed', reason: '③の生成APIが未接続です' });
  }
  if (action === 'revise') {
    const c = state.creatives[body.creative_id];
    const r = requestRevision(c, { text: body.text, textChanges: body.text_changes }, CTX);
    if (!r.ok) return json(res, cerr(r.error));
    state.creatives[c.id] = r.creative;
    return json(res, { ok: true, creative: publicCreative(r.creative) });
  }
  if (action === 'approve') {
    const c = state.creatives[body.creative_id];
    const r = approveCreative(c, state.assets[c.assetId], { ...CTX, claims: body.claims });
    if (!r.ok) return json(res, cerr(r.error, { rights_unconfirmed: '素材の権利が未確認です。先に権利を確認してください',
      sample_not_approvable: 'サンプル・未接続の案は承認できません',
      consent_unconfirmed: '実際の施術素材です。写真の利用許可を確認してください',
      claims_unchecked: '内容の確認（架空の体験談・効果保証・偽のBefore/After・正本の使用）がすべて必要です' }[r.error]));
    state.creatives[c.id] = r.creative;
    return json(res, { ok: true, creative: publicCreative(r.creative) });
  }
  if (action === 'deliverables') {
    const d = deliverables(state.creatives[body.creative_id]);
    if (!d.ok) return json(res, cerr('not_approved', '承認済みの案だけ取得できます'));
    return json(res, { ok: true, ...d });
  }
  if (action === 'compare') {
    const a = state.assets[body.asset_id];
    if (!a) return json(res, cerr('not_found'));
    return json(res, { ok: true, asset: publicAsset(a), creatives: compareSet(Object.values(state.creatives), a.id) });
  }
  return json(res, cerr('invalid_request'));
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    // 保存先のかわり: ここへ来るのは**暗号文だけ**
    if (p.startsWith('/__blob/')) {
      const name = p.slice('/__blob/'.length);
      blobStore.set(STORE_HOST + name, raw);
      return json(res, { url: STORE_HOST + name });
    }
    let body = {}; try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch {}
    if (p.startsWith('/api/')) calls.push({ path: p, q: Object.fromEntries(url.searchParams), body, method: req.method });
    if (p === '/api/settlement-auth') {
      if (req.method === 'GET') return json(res, { ok: true, shops: {} });
      return json(res, { ok: true, token: 'stub', owner: '__root__', root: true, role: 'root' });
    }
    if (p === '/api/plan-store') {
      const type = req.method === 'GET' ? url.searchParams.get('type') : body.type;
      if (type === 'ccflags') return json(res, { flags: { cc_all: true, cc_authz: 'off', cc_creative_library: true }, configured: true, env: 'preview' });
      if (type === 'creative') return await creativeApi(req, res, url, body);
      if (type === 'chat') return json(res, { rooms: [], messages: {}, reads: {}, dir: { staff: [] }, notes: {}, configured: true });
      if (type === 'board') return json(res, { posts: [], reads: {}, configured: true });
      return json(res, { ok: true, configured: true });
    }
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

// ── 確認に使う素材をブラウザ自身で作る（本物の画像・本物の動画）────────────
//    施術素材は使わない。デモ素材だと分かる中身にする。
const gen = await ctx.newPage();
await gen.goto('about:blank');
const made = await gen.evaluate(async () => {
  const b64 = async (blob) => { const b = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  const c = document.createElement('canvas'); c.width = 320; c.height = 320;
  const g = c.getContext('2d');
  g.fillStyle = '#b92d3d'; g.fillRect(0, 0, 320, 320);
  g.fillStyle = '#fff'; g.font = 'bold 26px sans-serif'; g.fillText('DEMO 画像', 60, 170);
  const png = await b64(await new Promise(r => c.toBlob(r, 'image/png')));
  // 動画（VP8/WebM）。ブラウザ自身で録画する。
  const v = document.createElement('canvas'); v.width = 240; v.height = 180;
  const vg = v.getContext('2d');
  const rec = new MediaRecorder(v.captureStream(15), { mimeType: 'video/webm;codecs=vp8' });
  const parts = []; rec.ondataavailable = e => parts.push(e.data); rec.start();
  for (let i = 0; i < 30; i++) {
    vg.fillStyle = `hsl(${i * 12},60%,45%)`; vg.fillRect(0, 0, 240, 180);
    vg.fillStyle = '#fff'; vg.font = 'bold 18px sans-serif'; vg.fillText('DEMO 動画 ' + i, 20, 100);
    await new Promise(r => setTimeout(r, 66));
  }
  await new Promise(r => { rec.onstop = r; rec.stop(); });
  return { png, webm: await b64(new Blob(parts, { type: 'video/webm' })) };
});
await gen.close();
fs.writeFileSync(path.join(OUT, 'cv-demo.png'), Buffer.from(made.png, 'base64'));
fs.writeFileSync(path.join(OUT, 'cv-demo.webm'), Buffer.from(made.webm, 'base64'));
console.log('  demo素材:', fs.statSync(path.join(OUT, 'cv-demo.png')).size, 'byte (png) /',
            fs.statSync(path.join(OUT, 'cv-demo.webm')).size, 'byte (webm)');

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
  // @vercel/blob の代わり。**渡ってきたバイトをそのまま保存先へ送る**（暗号文のはず）。
  if (u.includes('@vercel/blob')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: `
    export const upload = async (name, body) => {
      const r = await fetch('/__blob/' + encodeURIComponent(name), { method: 'POST', body });
      return await r.json();
    };` });
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

await page.getByRole('button', { name: /クリエイティブ/ }).first().click().catch(() => {});
await page.waitForTimeout(2500);
check('クリエイティブ画面が開く', (await txt()).includes('素材を登録する'));
check('③未接続だと「サンプルを作らない」と出る', (await txt()).includes('サンプルを作りません'));

// ── 素材を登録する（画像＋動画）────────────────────────────────
await page.locator('input[placeholder*="春キャンペーン"]').first().fill('デモ素材（施術素材ではありません）');
await page.locator('#cv-files').setInputFiles([path.join(OUT, 'cv-demo.png'), path.join(OUT, 'cv-demo.webm')]);
await page.getByRole('button', { name: /^素材を登録$/ }).first().click();
for (let i = 0; i < 30; i++) { if ((await txt()).includes('素材を登録しました')) break; await page.waitForTimeout(500); }
check('素材を登録できた', (await txt()).includes('素材を登録しました'));

// 保存先に置かれたのが暗号文だけか（平文の PNG/WebM の先頭が無いこと）
const stored = [...blobStore.values()];
const plainPng = fs.readFileSync(path.join(OUT, 'cv-demo.png'));
check('🔴 保存先には暗号文しか無い（平文をアップロードしていない）',
  stored.length === 2 && stored.every(b => !b.includes(plainPng.subarray(0, 32)))
  && stored.every(b => b[0] !== 0x89),                       // PNG シグネチャが先頭に無い
  `保存 ${stored.length} 件 / ${stored.map(b => b.length).join(',')} byte`);
check('🔴 保存先URLも復号鍵も画面に出てこない',
  !(await page.content()).includes('blob.vercel-storage.com'));

// ── 実際に開ける画像 ────────────────────────────────────────────
await page.waitForTimeout(2500);
const img = page.locator('img[data-cv-media="image"]').first();
await img.waitFor({ timeout: 20000 }).catch(() => {});
const imgOk = await img.evaluate(el => ({ w: el.naturalWidth, h: el.naturalHeight, src: el.src.slice(0, 5) })).catch(() => null);
check('🔴 画像が実際に開ける（naturalWidth > 0）',
  !!imgOk && imgOk.w > 0 && imgOk.h > 0, imgOk ? `${imgOk.w}x${imgOk.h} src=${imgOk.src}` : '要素なし');
check('画像は object URL で渡している（保存先URLを直接開いていない）', !!imgOk && imgOk.src === 'blob:');

// ── 実際に再生できる動画 ────────────────────────────────────────
const vid = page.locator('video[data-cv-media="video"]').first();
await vid.waitFor({ timeout: 20000 }).catch(() => {});
const played = await vid.evaluate(async (el) => {
  el.muted = true;
  await el.play().catch(() => {});
  const t0 = el.currentTime;
  await new Promise(r => setTimeout(r, 1500));
  return { readyState: el.readyState, duration: el.duration, t0, t1: el.currentTime, err: el.error ? el.error.code : 0 };
}).catch(() => null);
check('🔴 動画が実際に再生できる（再生位置が進む）',
  !!played && played.readyState >= 2 && played.t1 > played.t0 && !played.err,
  played ? `readyState=${played.readyState} ${played.t0.toFixed(2)}→${played.t1.toFixed(2)}s / 長さ ${String(played.duration).slice(0, 5)}s` : '要素なし');

// ── 素材をそのまま案にする → 表示・承認・取得 ─────────────────────
await page.locator('[data-cv-use-asset]').first().click();
await page.waitForTimeout(2500);
check('この素材を案にできる（③未接続でも確認まで進める）', (await txt()).includes('確認待ち'));

// 権利未確認のあいだは承認できない
await page.getByRole('button', { name: /^承認する$/ }).first().click().catch(() => {});
await page.waitForTimeout(900);
for (const k of ['noFakeTestimonial', 'noGuarantee', 'noFakeBeforeAfter', 'brandFromSource']) {
  await page.locator(`[data-cv-claim="${k}"]`).first().check().catch(() => {});
}
await page.locator('[data-cv-approve-yes]').first().click().catch(() => {});
await page.waitForTimeout(1500);
check('🔴 権利未確認では承認できない', (await txt()).includes('権利が未確認'));

await page.getByRole('button', { name: /権利を確認済みにする/ }).first().click();
await page.waitForTimeout(2000);
check('権利を確認済みにできる', (await txt()).includes('確認済み'));

await page.getByRole('button', { name: /^承認する$/ }).first().click();
await page.waitForTimeout(1200);
check('🔴 承認は確認のチェックをはさむ', (await page.locator('[data-cv-claims]').count()) === 1);
const yes = page.locator('[data-cv-approve-yes]').first();
check('🔴 確認前は承認ボタンを押せない', await yes.isDisabled());
for (const k of ['noFakeTestimonial', 'noGuarantee', 'noFakeBeforeAfter', 'brandFromSource']) {
  await page.locator(`[data-cv-claim="${k}"]`).first().check();
  await page.waitForTimeout(150);
}
check('4つ確認すると押せるようになる', !(await yes.isDisabled()));
await yes.click();
await page.waitForTimeout(2500);
check('承認できる', (await txt()).includes('承認済み'));
check('内容の確認済みが残る', (await txt()).includes('内容の確認済み'));
check('制作費は未記録と出る（0にしない）', (await txt()).includes('制作費: 未記録'));

await page.getByRole('button', { name: /完成ファイルを取得/ }).first().click();
await page.waitForTimeout(2000);
check('完成ファイルの一覧が出る', (await page.locator('[data-cv-download]').count()) > 0);
// ⚠️ 待ち受けを先に張ってから押す（押した直後に起きる出来事を取りこぼさないため）
const dlWait = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
await page.locator('[data-cv-download]').first().click().catch(() => {});
const dl = await dlWait;
let dlBytes = 0, dlName = '';
if (dl) { dlName = dl.suggestedFilename(); const p2 = await dl.path().catch(() => null); if (p2) dlBytes = fs.statSync(p2).size; }
check('🔴 完成ファイルを実際に保存できる', dlBytes > 0, dlBytes ? `${dlName} / ${dlBytes} byte` : '保存できず');

// ── 修正依頼（前の版を残す）────────────────────────────────────
await page.locator('[data-cv-add-draft]').first().click();
await page.waitForTimeout(2000);
await page.getByRole('button', { name: /③へ生成を依頼/ }).first().click().catch(() => {});
await page.waitForTimeout(2500);
check('🔴 ③未接続では「失敗」と出て、サンプルを作らない',
  (await txt()).includes('失敗') && (await txt()).includes('未接続'));

// ── 画面の写し ──────────────────────────────────────────────
await page.screenshot({ path: path.join(OUT, 'creative-screen.png'), fullPage: true });
check('画面の写しを保存した', fs.existsSync(path.join(OUT, 'creative-screen.png')),
  path.join(OUT, 'creative-screen.png'));
check('画面のエラーが出ていない', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close(); server.close();
const ng = results.filter(r => !r.pass);
console.log(`\n  結果: ${results.length - ng.length}/${results.length}`);
if (ng.length) { console.log('  NG:'); for (const r of ng) console.log('   -', r.name, r.detail); }
process.exit(ng.length ? 1 : 0);
