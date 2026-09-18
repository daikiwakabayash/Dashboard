import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../api/plan-store.js';
import { _clearBearerCache } from '../lib/actor.js';
import { hashOwnerToken } from '../lib/settlement.js';
import { kvEvalFake } from './helpers/kv-fake.js';
import { newDataKey, encryptBytes, toB64, cipherLength } from '../lib/creative-crypto.js';

const KV = 'https://kv.test';
const STORE_URL = 'https://abc123.public.blob.vercel-storage.com/creative/a.png';
const ASSET_KEY = 'creative-asset-master-key-for-tests-0123456789';
let store, genCalls, jobState, blobBytes, blobRanges;
const FLAGS = 'naoru:cc:flags:v1:preview';
const CREATIVE = 'naoru:creative:v1:preview';

// 保存先には**暗号文しか置かない**ので、試験でも本物の暗号文を置いて往復を確かめる。
const PLAIN = new Uint8Array(3000).map((_, i) => i % 251);
let dataKey;

function installFetchMock() {
  store = new Map(); genCalls = []; blobRanges = [];
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    const hdr = (opts.headers || {});
    const ok = (b) => ({ ok: true, status: 200, json: async () => b, headers: new Map() });
    if (u.startsWith(`${KV}/get/`)) { const k = decodeURIComponent(u.slice(`${KV}/get/`.length)); return ok({ result: store.has(k) ? store.get(k) : null }); }
    if (u.startsWith(`${KV}/set/`)) { store.set(decodeURIComponent(u.slice(`${KV}/set/`.length)), String(opts.body)); return ok({ result: 'OK' }); }
    if (u === KV) { const fake = kvEvalFake(store, JSON.parse(opts.body)); if (fake) return ok(fake); }
    // 保存先（Vercel Blob）。Range で一部だけ返す。
    if (u.startsWith('https://abc123.public.blob.vercel-storage.com/')) {
      if (!blobBytes) return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
      const m = /^bytes=(\d+)-(\d+)$/.exec(String(hdr.Range || ''));
      blobRanges.push(hdr.Range || '');
      const part = m ? blobBytes.subarray(Number(m[1]), Number(m[2]) + 1) : blobBytes;
      return { ok: true, status: m ? 206 : 200, headers: new Map(), json: async () => ({}),
               arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) };
    }
    if (u.includes('/v1/creative/generate')) {
      genCalls.push(JSON.parse(String(opts.body)));
      if (!jobState) return { ok: false, status: 500, json: async () => ({}) };
      if (jobState.accept === 422) return { ok: false, status: 422, json: async () => ({ error: { code: 'STRUCTURED_TEXT_CHANGE_REQUIRED' } }) };
      if (jobState.accept === 409) return { ok: false, status: 409, json: async () => ({ error: { code: 'CONFLICT' } }) };
      return { ok: true, status: 202, headers: new Map(), json: async () => ({ job_id: 'job_up_1', status: 'queued', poll_after_ms: 1000 }) };
    }
    if (/\/v1\/creative\/jobs\/[^/]+\/files\/\d+$/.test(u)) {
      const b = Buffer.from('third-party-bytes');
      return { ok: true, status: 200, headers: new Map(), json: async () => ({}), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    }
    if (u.includes('/v1/creative/jobs/')) return ok(jobState ? jobState.poll : {});
    return ok({});
  });
}
let saved;
beforeEach(async () => {
  saved = { u: process.env.KV_REST_API_URL, t: process.env.KV_REST_API_TOKEN, e: process.env.VERCEL_ENV,
            d: process.env.DASHBOARD_PASSWORD, s: process.env.AUTH_SALT,
            gb: process.env.CREATIVE_GEN_API_BASE, gk: process.env.CREATIVE_GEN_API_KEY,
            ak: process.env.CREATIVE_ASSET_KEY };
  process.env.KV_REST_API_URL = KV; process.env.KV_REST_API_TOKEN = 'test-token-not-a-secret';
  process.env.VERCEL_ENV = 'preview'; process.env.DASHBOARD_PASSWORD = 'pw-for-test'; process.env.AUTH_SALT = 'salt-for-test';
  process.env.CREATIVE_ASSET_KEY = ASSET_KEY;
  delete process.env.CREATIVE_GEN_API_BASE; delete process.env.CREATIVE_GEN_API_KEY;
  jobState = null;
  dataKey = newDataKey();
  blobBytes = Buffer.from(await encryptBytes(dataKey, 'f_test', PLAIN));
  installFetchMock(); _clearBearerCache();
  store.set(FLAGS, JSON.stringify({ cc_all: true, cc_creative_library: true, cc_authz: 'off' }));
});
afterEach(() => {
  for (const [k, v] of [['KV_REST_API_URL', saved.u], ['KV_REST_API_TOKEN', saved.t], ['VERCEL_ENV', saved.e],
                        ['DASHBOARD_PASSWORD', saved.d], ['AUTH_SALT', saved.s],
                        ['CREATIVE_GEN_API_BASE', saved.gb], ['CREATIVE_GEN_API_KEY', saved.gk],
                        ['CREATIVE_ASSET_KEY', saved.ak]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  vi.restoreAllMocks();
});
function mockRes() {
  const r = { statusCode: 0, body: null, sent: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; }; r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; }; r.send = (b) => { r.sent = b; return r; }; r.end = () => r; return r;
}
const call = async (req) => { const res = mockRes(); await handler({ headers: { host: 'test.local' }, query: {}, body: {}, ...req }, res); return res; };
const ROOT = () => ({ host: 'test.local', 'x-cc-owner': '__root__', 'x-cc-token': hashOwnerToken('__root__', 'pw-for-test', 'salt-for-test') });
const post = (b) => call({ method: 'POST', headers: ROOT(), body: { type: 'creative', ...b } });
const get = (q, extraHeaders = {}) => call({ method: 'GET', headers: { ...ROOT(), ...extraHeaders }, query: { type: 'creative', ...q } });

// 画面がやること: データ鍵で暗号化 → 保存先へ書き込み → 鍵と保存先URLをサーバーへ渡す。
const IMG = () => ({ storageUrl: STORE_URL, contentType: 'image/png', bytes: PLAIN.length,
  fileId: 'f_test', dataKey: toB64(dataKey), plainBytes: PLAIN.length });

const newAsset = async (over = {}) => (await post({ action: 'asset_create',
  asset: { title: '春の素材', files: [IMG()], channel: 'meta', companyId: 'c1', shopId: 's1', ...over } })).body.asset;

const connect = () => { process.env.CREATIVE_GEN_API_BASE = 'https://platform.test'; process.env.CREATIVE_GEN_API_KEY = 'k'; };

describe('Creative Library: 権限とフラグ', () => {
  it('🔴 未認証は 403（chat と同じ本部/root限定ゲート）', async () => {
    const res = await call({ method: 'POST', body: { type: 'creative', action: 'list' } });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('chat_admin_only');
  });
  it('🔴 role を名乗るだけでは通らない', async () => {
    const res = await call({ method: 'POST', headers: { host: 'x', 'x-chat-role': 'root' }, body: { type: 'creative', action: 'list' } });
    expect(res.statusCode).toBe(403);
  });
  it('🔴 未認証はファイルの中身も取れない', async () => {
    const a = await newAsset();
    const res = await call({ method: 'GET', query: { type: 'creative', action: 'file', owner: 'asset', ownerId: a.id, fileId: 'f_test' } });
    expect(res.statusCode).toBe(403);
    expect(res.sent).toBe(null);
  });
  it('🔴 フラグ OFF なら URL を直接叩いても動かない', async () => {
    store.set(FLAGS, JSON.stringify({ cc_all: true, cc_creative_library: false }));
    expect((await post({ action: 'list' })).body.error.code).toBe('rollout_disabled');
  });
  it('🔴 キルスイッチでも止まる', async () => {
    store.set(FLAGS, JSON.stringify({ cc_all: false, cc_creative_library: true }));
    expect((await post({ action: 'list' })).body.error.code).toBe('rollout_disabled');
  });
});

describe('🔴 素材は暗号文でしか保存しない', () => {
  it('保存鍵が無ければ登録させない（平文で置いて後回しにしない）', async () => {
    delete process.env.CREATIVE_ASSET_KEY;
    const r = await post({ action: 'asset_create', asset: { title: 'x', files: [IMG()] } });
    expect(r.body.error.code).toBe('key_missing');
    expect(r.body.error.message).toContain('CREATIVE_ASSET_KEY');
    expect((await post({ action: 'list' })).body.storage.ready).toBe(false);
  });
  it('弱い保存鍵（32文字未満）も受け付けない', async () => {
    process.env.CREATIVE_ASSET_KEY = 'short-key';
    expect((await post({ action: 'asset_create', asset: { title: 'x', files: [IMG()] } })).body.error.code).toBe('key_missing');
  });
  it('鍵を渡さないファイルは登録できない', async () => {
    const r = await post({ action: 'asset_create', asset: { title: 'x', files: [{ ...IMG(), dataKey: '' }] } });
    expect(r.body.error.code).toBe('key_required');
  });
  it('🔴 許可した保存先以外は登録できない', async () => {
    const bad = { ...IMG(), storageUrl: 'https://evil.example/a.png' };
    expect((await post({ action: 'asset_create', asset: { title: 'x', files: [bad] } })).body.error.code).toBe('file_required');
    const data = { ...IMG(), storageUrl: 'data:image/png;base64,AA' };
    expect((await post({ action: 'asset_create', asset: { title: 'x', files: [data] } })).body.error.code).toBe('file_required');
  });
  it('🔴 保存先URLも復号鍵も応答に出てこない', async () => {
    const a = await newAsset();
    const s = JSON.stringify(a);
    expect(s).not.toContain('blob.vercel-storage.com');
    expect(s).not.toContain(toB64(dataKey));
    expect(a.files[0].src).toContain('action=file');
    expect(JSON.stringify((await post({ action: 'list' })).body)).not.toContain('blob.vercel-storage.com');
  });
  it('🔴 保存した鍵は包まれている（平文の鍵を保存しない）', async () => {
    await newAsset();
    expect(store.get(CREATIVE)).not.toContain(toB64(dataKey));
    expect(store.get(CREATIVE)).toContain('A256GCM-CHUNK1M');
  });
});

describe('🔴 中身は認証付きの配信口からだけ出る', () => {
  it('ログイン済みなら復号したバイトが返る（画像が実際に開ける）', async () => {
    const a = await newAsset();
    const r = await get({ action: 'file', owner: 'asset', ownerId: a.id, fileId: 'f_test' });
    expect(r.statusCode).toBe(200);
    expect(Buffer.from(r.sent).equals(Buffer.from(PLAIN))).toBe(true);
    expect(r.headers['Content-Type']).toBe('image/png');
    expect(r.headers['Cache-Control']).toBe('private, no-store');   // 共有キャッシュに載せない
    expect(r.headers['Accept-Ranges']).toBe('bytes');
  });
  it('Range で一部だけ取れる（動画の再生・シーク）', async () => {
    const a = await newAsset();
    const r = await get({ action: 'file', owner: 'asset', ownerId: a.id, fileId: 'f_test' }, { range: 'bytes=100-199' });
    expect(r.statusCode).toBe(206);
    expect(r.headers['Content-Range']).toBe(`bytes 100-199/${PLAIN.length}`);
    expect(Buffer.from(r.sent).equals(Buffer.from(PLAIN.subarray(100, 200)))).toBe(true);
  });
  it('範囲外の指定は 416（黙って全部返さない）', async () => {
    const a = await newAsset();
    const r = await get({ action: 'file', owner: 'asset', ownerId: a.id, fileId: 'f_test' }, { range: 'bytes=99999-' });
    expect(r.statusCode).toBe(416);
    expect(r.headers['Content-Range']).toBe(`bytes */${PLAIN.length}`);
  });
  it('🔴 保存先から取るのは暗号文だけ（平文はどこにも置かれていない）', async () => {
    const a = await newAsset();
    await get({ action: 'file', owner: 'asset', ownerId: a.id, fileId: 'f_test' });
    expect(blobRanges.length).toBeGreaterThan(0);
    expect(blobBytes.length).toBe(cipherLength(PLAIN.length));
    expect(blobBytes.includes(Buffer.from(PLAIN))).toBe(false);
  });
  it('🔴 保存先の中身が差し替えられていたら返さない', async () => {
    const a = await newAsset();
    blobBytes = Buffer.from(blobBytes); blobBytes[50] ^= 0xff;
    const r = await get({ action: 'file', owner: 'asset', ownerId: a.id, fileId: 'f_test' });
    expect(r.statusCode).toBe(500);
    expect(r.body.error.code).toBe('decrypt_failed');
    expect(r.sent).toBe(null);
  });
  it('🔴 他テナントのファイルは取れない', async () => {
    const a = await newAsset();
    const raw = JSON.parse(store.get(CREATIVE));
    raw.assets[a.id].tenantId = 'other-company';
    store.set(CREATIVE, JSON.stringify(raw));
    expect((await get({ action: 'file', owner: 'asset', ownerId: a.id, fileId: 'f_test' })).statusCode).toBe(404);
  });
  it('知らないIDは 404', async () => {
    expect((await get({ action: 'file', owner: 'asset', ownerId: 'as_zzz', fileId: 'f' })).statusCode).toBe(404);
    const a = await newAsset();
    expect((await get({ action: 'file', owner: 'asset', ownerId: a.id, fileId: 'f_other' })).statusCode).toBe(404);
  });
  it('③の成果物は①が中継する（③のサービス鍵をブラウザへ渡さない）', async () => {
    connect();
    process.env.CREATIVE_GEN_API_KEY = 'super-secret-key';
    const a = await newAsset();
    const raw = JSON.parse(store.get(CREATIVE));
    raw.assets[a.id].files = [{ fileId: 'f_job', src: 'job', jobId: 'job_up_1', index: 0, kind: 'video', contentType: 'video/mp4', bytes: 17 }];
    store.set(CREATIVE, JSON.stringify(raw));
    const r = await get({ action: 'file', owner: 'asset', ownerId: a.id, fileId: 'f_job' });
    expect(r.statusCode).toBe(200);
    expect(Buffer.from(r.sent).toString()).toBe('third-party-bytes');
    expect(JSON.stringify(r.headers)).not.toContain('super-secret-key');
  });
});

describe('🔴 IDを指定して既存レコードを上書きできない', () => {
  it('素材: 他人のIDを送っても、そのレコードは書き換わらない', async () => {
    const victim = await newAsset({ title: '既にある素材' });
    const attacker = (await post({ action: 'asset_create',
      asset: { id: victim.id, title: '乗っ取り', files: [IMG()] } })).body.asset;
    expect(attacker.id).not.toBe(victim.id);
    const list = (await post({ action: 'list' })).body.assets;
    expect(list.find(x => x.id === victim.id).title).toBe('既にある素材');
    expect(list).toHaveLength(2);
  });
  it('素材: 他テナントのIDを送っても書き換わらない', async () => {
    const a = await newAsset({ title: '他社の素材' });
    const raw = JSON.parse(store.get(CREATIVE));
    raw.assets[a.id].tenantId = 'other-company';
    store.set(CREATIVE, JSON.stringify(raw));
    await post({ action: 'asset_create', asset: { id: a.id, title: '乗っ取り', files: [IMG()] } });
    expect(JSON.parse(store.get(CREATIVE)).assets[a.id]).toMatchObject({ title: '他社の素材', tenantId: 'other-company' });
  });
  it('案: 他人のIDを送っても書き換わらない', async () => {
    const a = await newAsset();
    const victim = (await post({ action: 'creative_create', asset_id: a.id, creative: { headline: '元の案' } })).body.creative;
    const got = (await post({ action: 'creative_create', asset_id: a.id, creative: { id: victim.id, headline: '乗っ取り' } })).body.creative;
    expect(got.id).not.toBe(victim.id);
    const list = (await post({ action: 'list' })).body.creatives;
    expect(list.find(x => x.id === victim.id).headline).toBe('元の案');
    expect(list).toHaveLength(2);
  });
});

describe('Creative Library: 素材と案', () => {
  it('素材を登録できる（企業・店舗・媒体を持つ）', async () => {
    const a = await newAsset();
    expect(a).toMatchObject({ title: '春の素材', channel: 'meta', companyId: 'c1', shopId: 's1' });
    expect(a.rights.status).toBe('unconfirmed');
  });
  it('権利を確認すると確認者が残る', async () => {
    const a = await newAsset();
    const r = await post({ action: 'asset_rights', asset_id: a.id, status: 'confirmed' });
    expect(r.body.asset.rights.status).toBe('confirmed');
    expect(r.body.asset.rights.confirmedBy).toBe('__root__');
  });
  it('案を作ると下書き・未接続から始まる', async () => {
    const a = await newAsset();
    const c = (await post({ action: 'creative_create', asset_id: a.id, creative: { appeal: '時短', headline: '見出し' } })).body.creative;
    expect(c).toMatchObject({ status: 'draft', dataMode: 'not_connected', version: 1, appeal: '時短' });
  });
});

describe('Creative Library: ③生成APIとの接続（非同期ジョブ）', () => {
  it('🔴 未接続なら「未接続」と出し、sample を作って成功に見せない', async () => {
    const a = await newAsset();
    const c = (await post({ action: 'creative_create', asset_id: a.id })).body.creative;
    const g = await post({ action: 'generate', creative_id: c.id });
    expect(g.body.status).toBe('failed');
    expect(g.body.creative.failureReason).toContain('未接続');
    expect(g.body.creative.dataMode).toBe('not_connected');
    expect(genCalls).toHaveLength(0);                      // 上流を呼びに行かない
    const list = (await post({ action: 'list' })).body;
    expect(list.generator.connected).toBe(false);
    expect(list.generator.reason).toContain('CREATIVE_GEN_API_BASE');
  });
  it('依頼は受け付けだけして即返す（長い動画を同期で待たない）', async () => {
    connect(); jobState = { poll: { status: 'queued' } };
    const a = await newAsset();
    const c = (await post({ action: 'creative_create', asset_id: a.id })).body.creative;
    const g = await post({ action: 'generate', creative_id: c.id });
    expect(g.body).toMatchObject({ ok: true, job_id: 'job_up_1', status: 'queued', creative_id: c.id, revision: false });
    expect(g.body.poll_after_ms).toBe(1000);
    expect(genCalls[0]).toMatchObject({ creative_id: c.id, tenant_id: 'naoru', channel: 'meta',
      store_id: 's1', target_version: 1, mode: 'sample' });
    expect(genCalls[0].source_asset_ids).toEqual([a.id]);
    expect(genCalls[0].formats.length).toBeGreaterThan(0);
  });
  it('生成中のあいだは終わったことにしない', async () => {
    connect(); jobState = { poll: { status: 'running', poll_after_ms: 2000 } };
    const a = await newAsset();
    const c = (await post({ action: 'creative_create', asset_id: a.id })).body.creative;
    await post({ action: 'generate', creative_id: c.id });
    const s = await post({ action: 'job_status', creative_id: c.id });
    expect(s.body).toMatchObject({ status: 'running', poll_after_ms: 2000 });
    expect(s.body.creative.status).toBe('generating');
  });
  it('完了すると確認待ちになり、③の申告をそのまま持つ', async () => {
    connect();
    jobState = { poll: { status: 'completed', mode: 'sample', headline: '③の見出し',
      files: [{ src: 'job', jobId: 'job_up_1', index: 0, contentType: 'image/png', bytes: 10 }] } };
    const a = await newAsset();
    const c = (await post({ action: 'creative_create', asset_id: a.id })).body.creative;
    await post({ action: 'generate', creative_id: c.id });
    const s = await post({ action: 'job_status', creative_id: c.id });
    expect(s.body.status).toBe('done');
    expect(s.body.creative.status).toBe('review');
    expect(s.body.creative.dataMode).toBe('sample');        // 勝手に live へ上げない
    expect(s.body.creative.headline).toBe('③の見出し');
    expect(s.body.creative.files[0].src).toContain('action=file');
  });
  it('🔴 中断は失敗として見せる（勝手に再実行しない）', async () => {
    connect(); jobState = { poll: { status: 'interrupted' } };
    const a = await newAsset();
    const c = (await post({ action: 'creative_create', asset_id: a.id })).body.creative;
    await post({ action: 'generate', creative_id: c.id });
    const s = await post({ action: 'job_status', creative_id: c.id });
    expect(s.body.creative.status).toBe('failed');
    expect(s.body.creative.failureReason).toContain('中断');
  });
  it('🔴 状態を取得できなかったときに失敗にしない（もう一度聞く）', async () => {
    connect(); jobState = { poll: null };
    const a = await newAsset();
    const c = (await post({ action: 'creative_create', asset_id: a.id })).body.creative;
    await post({ action: 'generate', creative_id: c.id });
    const s = await post({ action: 'job_status', creative_id: c.id });
    expect(s.body.status).toBe('running');
    expect((await post({ action: 'list' })).body.creatives[0].status).toBe('generating');
  });
  it('③が 422（修正内容を解釈できない）を返したら、理由を残して失敗にする', async () => {
    connect(); jobState = { accept: 422 };
    const a = await newAsset();
    const c = (await post({ action: 'creative_create', asset_id: a.id })).body.creative;
    const g = await post({ action: 'generate', creative_id: c.id });
    expect(g.body.status).toBe('failed');
    expect(g.body.creative.failureReason).toContain('STRUCTURED_TEXT_CHANGE_REQUIRED');
  });
  it('③が 409（版の競合）を返したら、上書きせず理由を残す', async () => {
    connect(); jobState = { accept: 409 };
    const a = await newAsset();
    const c = (await post({ action: 'creative_create', asset_id: a.id })).body.creative;
    const g = await post({ action: 'generate', creative_id: c.id });
    expect(g.body.creative.failureReason).toContain('競合');
  });
  it('🔴 生成APIのキーを応答に含めない', async () => {
    connect(); process.env.CREATIVE_GEN_API_KEY = 'super-secret-key';
    jobState = { poll: { status: 'completed', mode: 'sample', files: [{ src: 'job', jobId: 'job_up_1', index: 0, contentType: 'image/png' }] } };
    const a = await newAsset();
    const c = (await post({ action: 'creative_create', asset_id: a.id })).body.creative;
    const g = await post({ action: 'generate', creative_id: c.id });
    const s = await post({ action: 'job_status', creative_id: c.id });
    expect(JSON.stringify(g.body) + JSON.stringify(s.body)).not.toContain('super-secret-key');
  });
  it('🔴 ③へ保存先URLを送らない（参照はIDだけ）', async () => {
    connect(); jobState = { poll: { status: 'queued' } };
    const a = await newAsset();
    const c = (await post({ action: 'creative_create', asset_id: a.id })).body.creative;
    await post({ action: 'generate', creative_id: c.id });
    expect(JSON.stringify(genCalls[0])).not.toContain('blob.vercel-storage.com');
    expect(JSON.stringify(genCalls[0])).not.toContain(toB64(dataKey));
  });
});

describe('🔴 修正依頼は対象版・元素材とともに③へ渡る', () => {
  const reviewed = async (mode = 'live') => {
    connect();
    jobState = { poll: { status: 'completed', mode, headline: '実生成の見出し', body: '実生成の本文',
      files: [{ src: 'job', jobId: 'job_up_1', index: 0, contentType: 'image/png', bytes: 10 }] } };
    const a = await newAsset();
    await post({ action: 'asset_rights', asset_id: a.id, status: 'confirmed' });
    const c0 = (await post({ action: 'creative_create', asset_id: a.id })).body.creative;
    await post({ action: 'generate', creative_id: c0.id });
    return { a, c: (await post({ action: 'job_status', creative_id: c0.id })).body.creative };
  };
  it('修正依頼で版が上がり、履歴が残る', async () => {
    const { c } = await reviewed();
    const r = await post({ action: 'revise', creative_id: c.id, text: '文字を大きく' });
    expect(r.body.creative.status).toBe('draft');
    expect(r.body.creative.version).toBe(2);
    expect(r.body.creative.revisions[0].text).toBe('文字を大きく');
  });
  it('修正後の生成依頼に parent / 直前の版 / 原文 / 明示の文言が入る', async () => {
    const { c } = await reviewed();
    await post({ action: 'revise', creative_id: c.id, text: '価格は出さないで' });
    genCalls.length = 0;
    const g = await post({ action: 'generate', creative_id: c.id });
    expect(g.body.revision).toBe(true);
    expect(genCalls[0]).toMatchObject({
      parent_creative_id: c.id, source_creative_version: 1, target_version: 2,
      revision_instructions: '価格は出さないで',
    });
    expect(genCalls[0].text_changes).toMatchObject({ headline: '実生成の見出し', body: '実生成の本文' });
    expect(genCalls[0].source_asset_ids).toContain(c.assetId);
    expect(genCalls[0].source_file_ids.length).toBeGreaterThan(0);
  });
  it('見出しを書き換えて依頼すると、その値が text_changes に入る', async () => {
    const { c } = await reviewed();
    await post({ action: 'revise', creative_id: c.id, text: '見出しを変えて',
      text_changes: { headline: '新しい見出し', cta: '今すぐ予約' } });
    genCalls.length = 0;
    await post({ action: 'generate', creative_id: c.id });
    expect(genCalls[0].text_changes).toEqual({ headline: '新しい見出し', body: '実生成の本文', cta: '今すぐ予約' });
  });
});

describe('Creative Library: 承認と完成ファイル', () => {
  const finished = async (mode) => {
    connect();
    jobState = { poll: { status: 'completed', mode, files: [{ src: 'job', jobId: 'job_up_1', index: 0, contentType: 'image/png', bytes: 10 }] } };
    const a = await newAsset();
    const c0 = (await post({ action: 'creative_create', asset_id: a.id })).body.creative;
    await post({ action: 'generate', creative_id: c0.id });
    return { a, c: (await post({ action: 'job_status', creative_id: c0.id })).body.creative };
  };
  it('🔴 sample は承認できない', async () => {
    const { a, c } = await finished('sample');
    await post({ action: 'asset_rights', asset_id: a.id, status: 'confirmed' });
    const r = await post({ action: 'approve', creative_id: c.id });
    expect(r.body.error.code).toBe('sample_not_approvable');
    expect(r.body.error.message).toContain('サンプル');
  });
  it('🔴 権利未確認なら承認できない', async () => {
    const { c } = await finished('live');                    // 権利 unconfirmed のまま
    expect((await post({ action: 'approve', creative_id: c.id })).body.error.code).toBe('rights_unconfirmed');
  });
  it('権利確認済み＋実生成なら承認でき、完成ファイルを取得できる', async () => {
    const { a, c } = await finished('live');
    await post({ action: 'asset_rights', asset_id: a.id, status: 'confirmed' });
    const ap = await post({ action: 'approve', creative_id: c.id });
    expect(ap.body.creative.status).toBe('approved');
    expect(ap.body.creative.reviewer.id).toBe('__root__');
    const d = await post({ action: 'deliverables', creative_id: c.id });
    expect(d.body.ok).toBe(true);
    expect(d.body.files[0].src).toContain('action=file');
    expect(JSON.stringify(d.body)).not.toContain('blob.vercel-storage.com');
    expect(d.body.dataMode).toBe('live');
  });
  it('🔴 承認前は完成ファイルを取得できない', async () => {
    const { c } = await finished('live');
    expect((await post({ action: 'deliverables', creative_id: c.id })).body.error.code).toBe('not_approved');
  });
});

describe('Creative Library: 比較と他テナント', () => {
  it('同じ素材の案を並べられる', async () => {
    const a = await newAsset();
    await post({ action: 'creative_create', asset_id: a.id, creative: { origin: 'uploaded', files: [IMG()], headline: 'A案' } });
    await post({ action: 'creative_create', asset_id: a.id, creative: { origin: 'uploaded', files: [IMG()], headline: 'B案' } });
    const cmp = await post({ action: 'compare', asset_id: a.id });
    expect(cmp.body.creatives).toHaveLength(2);
    expect(cmp.body.creatives[0].statusLabel).toBe('確認待ち');
    expect(JSON.stringify(cmp.body)).not.toContain('blob.vercel-storage.com');
  });
  it('🔴 他テナントの素材は見えない', async () => {
    const a = await newAsset();
    const raw = JSON.parse(store.get(CREATIVE));
    raw.assets[a.id].tenantId = 'other-company';
    store.set(CREATIVE, JSON.stringify(raw));
    expect((await post({ action: 'list' })).body.assets).toHaveLength(0);
    expect((await post({ action: 'compare', asset_id: a.id })).body.error.code).toBe('not_found');
  });
});
