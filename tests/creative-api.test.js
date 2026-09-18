import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../api/plan-store.js';
import { _clearBearerCache } from '../lib/actor.js';
import { hashOwnerToken } from '../lib/settlement.js';
import { kvEvalFake } from './helpers/kv-fake.js';

const KV = 'https://kv.test';
let store, genCalls;
const FLAGS = 'naoru:cc:flags:v1:preview';
const CREATIVE = 'naoru:creative:v1:preview';

function installFetchMock(gen = null) {
  store = new Map(); genCalls = [];
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    const ok = (b) => ({ ok: true, status: 200, json: async () => b, headers: new Map() });
    if (u.startsWith(`${KV}/get/`)) { const k = decodeURIComponent(u.slice(`${KV}/get/`.length)); return ok({ result: store.has(k) ? store.get(k) : null }); }
    if (u.startsWith(`${KV}/set/`)) { store.set(decodeURIComponent(u.slice(`${KV}/set/`.length)), String(opts.body)); return ok({ result: 'OK' }); }
    if (u === KV) { const fake = kvEvalFake(store, JSON.parse(opts.body)); if (fake) return ok(fake); }
    if (u.includes('/v1/creative/generate')) {
      genCalls.push(JSON.parse(String(opts.body)));
      if (!gen) return { ok: false, status: 500, json: async () => ({}) };
      return ok(gen);
    }
    return ok({});
  });
}
let saved;
beforeEach(() => {
  saved = { u: process.env.KV_REST_API_URL, t: process.env.KV_REST_API_TOKEN, e: process.env.VERCEL_ENV,
            d: process.env.DASHBOARD_PASSWORD, s: process.env.AUTH_SALT,
            gb: process.env.CREATIVE_GEN_API_BASE, gk: process.env.CREATIVE_GEN_API_KEY };
  process.env.KV_REST_API_URL = KV; process.env.KV_REST_API_TOKEN = 'test-token-not-a-secret';
  process.env.VERCEL_ENV = 'preview'; process.env.DASHBOARD_PASSWORD = 'pw-for-test'; process.env.AUTH_SALT = 'salt-for-test';
  delete process.env.CREATIVE_GEN_API_BASE; delete process.env.CREATIVE_GEN_API_KEY;
  installFetchMock(); _clearBearerCache();
  store.set(FLAGS, JSON.stringify({ cc_all: true, cc_creative_library: true, cc_authz: 'off' }));
});
afterEach(() => {
  for (const [k, v] of [['KV_REST_API_URL', saved.u], ['KV_REST_API_TOKEN', saved.t], ['VERCEL_ENV', saved.e],
                        ['DASHBOARD_PASSWORD', saved.d], ['AUTH_SALT', saved.s],
                        ['CREATIVE_GEN_API_BASE', saved.gb], ['CREATIVE_GEN_API_KEY', saved.gk]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  vi.restoreAllMocks();
});
function mockRes() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; }; r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; }; r.end = () => r; return r;
}
const call = async (req) => { const res = mockRes(); await handler({ headers: { host: 'test.local' }, query: {}, body: {}, ...req }, res); return res; };
const ROOT = () => ({ host: 'test.local', 'x-cc-owner': '__root__', 'x-cc-token': hashOwnerToken('__root__', 'pw-for-test', 'salt-for-test') });
const post = (b) => call({ method: 'POST', headers: ROOT(), body: { type: 'creative', ...b } });
const IMG = { url: 'https://blob.test/a.png', contentType: 'image/png', bytes: 10 };

const newAsset = async (over = {}) => (await post({ action: 'asset_create',
  asset: { title: '春の素材', files: [IMG], channel: 'meta', companyId: 'c1', shopId: 's1', ...over } })).body.asset;

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
  it('🔴 フラグ OFF なら URL を直接叩いても動かない', async () => {
    store.set(FLAGS, JSON.stringify({ cc_all: true, cc_creative_library: false }));
    expect((await post({ action: 'list' })).body.error.code).toBe('rollout_disabled');
  });
  it('🔴 キルスイッチでも止まる', async () => {
    store.set(FLAGS, JSON.stringify({ cc_all: false, cc_creative_library: true }));
    expect((await post({ action: 'list' })).body.error.code).toBe('rollout_disabled');
  });
});

describe('Creative Library: 素材と案', () => {
  it('素材を登録できる（企業・店舗・媒体を持つ）', async () => {
    const a = await newAsset();
    expect(a).toMatchObject({ title: '春の素材', channel: 'meta', companyId: 'c1', shopId: 's1' });
    expect(a.rights.status).toBe('unconfirmed');
  });
  it('🔴 https 以外のファイルは登録できない', async () => {
    expect((await post({ action: 'asset_create', asset: { title: 'x', files: [{ url: 'data:image/png;base64,AA', contentType: 'image/png' }] } })).body.error.code).toBe('file_required');
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

describe('Creative Library: ③生成APIとの接続', () => {
  it('🔴 未接続なら「未接続」と出し、sample を作って成功に見せない', async () => {
    const a = await newAsset();
    const c = (await post({ action: 'creative_create', asset_id: a.id })).body.creative;
    const g = await post({ action: 'generate', creative_id: c.id });
    expect(g.body.creative.status).toBe('failed');
    expect(g.body.creative.failureReason).toContain('未接続');
    expect(g.body.creative.dataMode).toBe('not_connected');
    expect(genCalls).toHaveLength(0);                      // 上流を呼びに行かない
    const list = (await post({ action: 'list' })).body;
    expect(list.generator.connected).toBe(false);
    expect(list.generator.reason).toContain('CREATIVE_GEN_API_BASE');
  });
  it('接続済みなら③へ依頼し、返ってきた申告をそのまま持つ', async () => {
    process.env.CREATIVE_GEN_API_BASE = 'https://platform.test';
    process.env.CREATIVE_GEN_API_KEY = 'k';
    installFetchMock({ ok: true, files: [IMG], mode: 'sample', headline: '③の見出し' });
    store.set(FLAGS, JSON.stringify({ cc_all: true, cc_creative_library: true }));
    const a = await newAsset();
    const c = (await post({ action: 'creative_create', asset_id: a.id })).body.creative;
    const g = await post({ action: 'generate', creative_id: c.id });
    expect(genCalls).toHaveLength(1);
    expect(genCalls[0]).toMatchObject({ creative_id: c.id, tenant_id: 'naoru', channel: 'meta' });
    expect(g.body.creative.status).toBe('review');
    expect(g.body.creative.dataMode).toBe('sample');        // 勝手に live へ上げない
    expect(g.body.creative.headline).toBe('③の見出し');
  });
  it('🔴 生成APIのキーを応答に含めない', async () => {
    process.env.CREATIVE_GEN_API_BASE = 'https://platform.test';
    process.env.CREATIVE_GEN_API_KEY = 'super-secret-key';
    installFetchMock({ ok: true, files: [IMG], mode: 'live' });
    store.set(FLAGS, JSON.stringify({ cc_all: true, cc_creative_library: true }));
    const a = await newAsset();
    const c = (await post({ action: 'creative_create', asset_id: a.id })).body.creative;
    const g = await post({ action: 'generate', creative_id: c.id });
    expect(JSON.stringify(g.body)).not.toContain('super-secret-key');
  });
});

describe('Creative Library: 修正依頼と承認', () => {
  const live = async () => {
    process.env.CREATIVE_GEN_API_BASE = 'https://platform.test';
    process.env.CREATIVE_GEN_API_KEY = 'k';
    installFetchMock({ ok: true, files: [IMG], mode: 'live', headline: '実生成' });
    store.set(FLAGS, JSON.stringify({ cc_all: true, cc_creative_library: true }));
    const a = await newAsset();
    await post({ action: 'asset_rights', asset_id: a.id, status: 'confirmed' });
    const c = (await post({ action: 'creative_create', asset_id: a.id })).body.creative;
    return { a, c: (await post({ action: 'generate', creative_id: c.id })).body.creative };
  };
  it('修正依頼で版が上がり、履歴が残る', async () => {
    const { c } = await live();
    const r = await post({ action: 'revise', creative_id: c.id, text: '文字を大きく' });
    expect(r.body.creative.status).toBe('draft');
    expect(r.body.creative.version).toBe(2);
    expect(r.body.creative.revisions[0].text).toBe('文字を大きく');
  });
  it('🔴 sample は承認できない', async () => {
    process.env.CREATIVE_GEN_API_BASE = 'https://platform.test';
    process.env.CREATIVE_GEN_API_KEY = 'k';
    installFetchMock({ ok: true, files: [IMG], mode: 'sample' });
    store.set(FLAGS, JSON.stringify({ cc_all: true, cc_creative_library: true }));
    const a = await newAsset();
    await post({ action: 'asset_rights', asset_id: a.id, status: 'confirmed' });
    const c = (await post({ action: 'creative_create', asset_id: a.id })).body.creative;
    const g = (await post({ action: 'generate', creative_id: c.id })).body.creative;
    const r = await post({ action: 'approve', creative_id: g.id });
    expect(r.body.error.code).toBe('sample_not_approvable');
    expect(r.body.error.message).toContain('サンプル');
  });
  it('🔴 権利未確認なら承認できない', async () => {
    process.env.CREATIVE_GEN_API_BASE = 'https://platform.test';
    process.env.CREATIVE_GEN_API_KEY = 'k';
    installFetchMock({ ok: true, files: [IMG], mode: 'live' });
    store.set(FLAGS, JSON.stringify({ cc_all: true, cc_creative_library: true }));
    const a = await newAsset();                              // 権利 unconfirmed のまま
    const c = (await post({ action: 'creative_create', asset_id: a.id })).body.creative;
    const g = (await post({ action: 'generate', creative_id: c.id })).body.creative;
    expect((await post({ action: 'approve', creative_id: g.id })).body.error.code).toBe('rights_unconfirmed');
  });
  it('権利確認済み＋実生成なら承認でき、完成ファイルを取得できる', async () => {
    const { c } = await live();
    const ap = await post({ action: 'approve', creative_id: c.id });
    expect(ap.body.creative.status).toBe('approved');
    expect(ap.body.creative.reviewer.id).toBe('__root__');
    const d = await post({ action: 'deliverables', creative_id: c.id });
    expect(d.body.ok).toBe(true);
    expect(d.body.files[0].url).toBe(IMG.url);
    expect(d.body.dataMode).toBe('live');
  });
  it('🔴 承認前は完成ファイルを取得できない', async () => {
    const { c } = await live();
    expect((await post({ action: 'deliverables', creative_id: c.id })).body.error.code).toBe('not_approved');
  });
});

describe('Creative Library: 比較と他テナント', () => {
  it('同じ素材の案を並べられる', async () => {
    const a = await newAsset();
    await post({ action: 'creative_create', asset_id: a.id, creative: { origin: 'uploaded', files: [IMG], headline: 'A案' } });
    await post({ action: 'creative_create', asset_id: a.id, creative: { origin: 'uploaded', files: [IMG], headline: 'B案' } });
    const cmp = await post({ action: 'compare', asset_id: a.id });
    expect(cmp.body.creatives).toHaveLength(2);
    expect(cmp.body.creatives[0].statusLabel).toBe('確認待ち');
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
