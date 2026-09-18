import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../api/plan-store.js';
import { _clearBearerCache } from '../lib/actor.js';
import { hashOwnerToken } from '../lib/settlement.js';

// ?type=meta は読取専用・本部/root限定。UIではなくサーバー側で強制されることを固定する。
const KV = 'https://kv.test';
let store, upstreamCalls;

function installFetchMock(upstreamResponse) {
  store = new Map(); upstreamCalls = [];
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    const ok = (b) => ({ ok: true, status: 200, json: async () => b, headers: new Map() });
    if (u.startsWith(`${KV}/get/`)) {
      const key = decodeURIComponent(u.slice(`${KV}/get/`.length));
      return ok({ result: store.has(key) ? store.get(key) : null });
    }
    if (u.startsWith(`${KV}/set/`)) { store.set(decodeURIComponent(u.slice(`${KV}/set/`.length)), String(opts.body)); return ok({ result: 'OK' }); }
    if (u.includes('/v1/meta/overview')) { upstreamCalls.push({ url: u, opts }); return ok(upstreamResponse); }
    return ok({});
  });
}

let saved;
beforeEach(() => {
  saved = { u: process.env.KV_REST_API_URL, t: process.env.KV_REST_API_TOKEN, e: process.env.VERCEL_ENV,
            d: process.env.DASHBOARD_PASSWORD, s: process.env.AUTH_SALT,
            b: process.env.META_READ_API_BASE, k: process.env.META_READ_API_KEY };
  process.env.KV_REST_API_URL = KV;
  process.env.KV_REST_API_TOKEN = 'test-token-not-a-secret';
  process.env.VERCEL_ENV = 'preview';
  process.env.DASHBOARD_PASSWORD = 'pw-for-test';
  process.env.AUTH_SALT = 'salt-for-test';
  delete process.env.META_READ_API_BASE;
  delete process.env.META_READ_API_KEY;
  installFetchMock({});
  _clearBearerCache();
});
afterEach(() => {
  for (const [k, v] of [['KV_REST_API_URL', saved.u], ['KV_REST_API_TOKEN', saved.t], ['VERCEL_ENV', saved.e],
                        ['DASHBOARD_PASSWORD', saved.d], ['AUTH_SALT', saved.s],
                        ['META_READ_API_BASE', saved.b], ['META_READ_API_KEY', saved.k]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

function mockRes() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}
const call = async (req) => { const res = mockRes(); await handler({ headers: {}, query: {}, body: {}, ...req }, res); return res; };
const ROOT_TOKEN = () => hashOwnerToken('__root__', 'pw-for-test', 'salt-for-test');
// 認証はヘッダで渡す（URLにトークンを載せない）
const rootHeaders = () => ({ 'x-cc-owner': '__root__', 'x-cc-token': ROOT_TOKEN() });
const asRoot = (query = {}) => call({ method: 'GET', headers: rootHeaders(), query: { type: 'meta', ...query } });

describe('?type=meta - 本部/root 限定（サーバー側で強制）', () => {
  it('🔴 未認証は 403', async () => {
    const res = await call({ method: 'GET', query: { type: 'meta' } });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('admin_only');
  });
  it('🔴 role を名乗るだけでは通らない', async () => {
    const res = await call({ method: 'GET', query: { type: 'meta', role: 'root' }, body: { actor: { role: 'root' } } });
    expect(res.statusCode).toBe(403);
  });
  it('🔴 偽のトークンでは通らない', async () => {
    const res = await call({ method: 'GET', headers: { 'x-cc-owner': '__root__', 'x-cc-token': 'wrong' }, query: { type: 'meta' } });
    expect(res.statusCode).toBe(403);
  });
  it('🔴 トークンをクエリに載せても通らない（URLに秘密を置かせない）', async () => {
    const res = await call({ method: 'GET', query: { type: 'meta', owner: '__root__', token: ROOT_TOKEN() } });
    expect(res.statusCode).toBe(403);
  });
  it('本人確認済みの root は通る', async () => {
    const res = await asRoot();
    expect(res.statusCode).toBe(200);
  });
  it('🔴 秘密が未設定なら root も通らない（fail closed）', async () => {
    delete process.env.DASHBOARD_PASSWORD;
    const res = await call({ method: 'GET', headers: { 'x-cc-owner': '__root__', 'x-cc-token': '' }, query: { type: 'meta' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('?type=meta - 読取専用', () => {
  it('🔴 POST は 405（広告変更の経路を作らない）', async () => {
    const res = await call({ method: 'POST', headers: rootHeaders(), body: { type: 'meta', action: 'pause' } });
    expect(res.statusCode).toBe(405);
    expect(res.body.error).toBe('read_only');
  });
  it('POST は認可より先に拒否されない（権限が無ければ403のまま）', async () => {
    const res = await call({ method: 'POST', body: { type: 'meta', action: 'pause' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('?type=meta - 未接続のとき', () => {
  it('サンプルデータを返し、sample:true が立つ', async () => {
    const res = await asRoot();
    expect(res.body.sample).toBe(true);
    expect(res.body.data.isSample).toBe(true);
  });
  it('🔴 未接続の理由を返す（0円にしない）', async () => {
    const res = await asRoot();
    expect(res.body.connection.connected).toBe(false);
    expect(res.body.connection.reason).toContain('META_READ_API_BASE');
  });
  it('🔴 上流を呼ばない（未設定なのに接続しにいかない）', async () => {
    await asRoot();
    expect(upstreamCalls).toHaveLength(0);
  });
  it('接続先だけあって鍵が無い場合もサンプル', async () => {
    process.env.META_READ_API_BASE = 'https://platform.test';
    const res = await asRoot();
    expect(res.body.sample).toBe(true);
    expect(res.body.connection.reason).toContain('META_READ_API_KEY');
    expect(upstreamCalls).toHaveLength(0);
  });
});

describe('?type=meta - 接続できているとき', () => {
  const live = {
    api_version: 'meta-read-1', status: 'ok', tenant_id: 'naoru',
    account: { id: 'act_live', name: '本番アカウント', currency: 'JPY', timezone: 'Asia/Tokyo', store_mapping: [] },
    period: { from: '2026-09-10', to: '2026-09-16', complete_days_only: true, excluded_today: true },
    totals: { spend: { value: 1000, unit: 'JPY', display: '¥1,000', quality: 'VERIFIED', source: 'Meta' } },
    rows: [], freshness: { last_success_at: '2026-09-18T03:00:00+09:00' },
  };
  beforeEach(() => {
    process.env.META_READ_API_BASE = 'https://platform.test';
    process.env.META_READ_API_KEY = 'service-key-not-a-real-secret';
    installFetchMock(live);
  });

  it('実データを返し、sample:false になる', async () => {
    const res = await asRoot({ accountId: 'act_live' });
    expect(res.body.sample).toBe(false);
    expect(res.body.data.account.id).toBe('act_live');
    expect(res.body.data.totals.spend.value).toBe(1000);
  });
  it('🔴 Metaのトークンではなくサービスキーを上流へ送る（トークンはDashboardに無い）', async () => {
    await asRoot({ accountId: 'act_live' });
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0].opts.headers.Authorization).toBe('Bearer service-key-not-a-real-secret');
  });
  it('🔴 応答にサービスキーを含めない（ブラウザへ漏らさない）', async () => {
    const res = await asRoot({ accountId: 'act_live' });
    expect(JSON.stringify(res.body)).not.toContain('service-key-not-a-real-secret');
  });
  it('既定では直近の完了済み7日を要求する（当日を含めない）', async () => {
    await asRoot({ accountId: 'act_live' });
    const u = new URL(upstreamCalls[0].url);
    const from = u.searchParams.get('from'), to = u.searchParams.get('to');
    const today = new Date().toISOString().slice(0, 10);
    expect(to).not.toBe(today);
    expect(Math.round((Date.parse(to) - Date.parse(from)) / 86400000)).toBe(6);   // 7日分
  });
  it('期間を指定できる', async () => {
    await asRoot({ accountId: 'act_live', from: '2026-08-01', to: '2026-08-07' });
    const u = new URL(upstreamCalls[0].url);
    expect(u.searchParams.get('from')).toBe('2026-08-01');
  });
  it('🔴 上流が知らない版を返したら表示しない', async () => {
    installFetchMock({ ...live, api_version: 'meta-read-99' });
    const res = await asRoot({ accountId: 'act_live' });
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.error.code).toBe('UNSUPPORTED_VERSION');
  });
  it('🔴 上流が落ちても数字を作らない', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.startsWith(`${KV}/get/`)) return { ok: true, status: 200, json: async () => ({ result: null }) };
      if (u.includes('/v1/meta/overview')) throw new Error('network down');
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const res = await asRoot({ accountId: 'act_live' });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.error.code).toBe('UPSTREAM_ERROR');
    expect(res.body.data.totals).toBeUndefined();     // ← 金額を作らない
  });
  it('上流が未接続を返したら、その理由を出す', async () => {
    installFetchMock({ api_version: 'meta-read-1', status: 'error',
      error: { code: 'NOT_CONNECTED', message: 'まだ接続されていません', retryable: false } });
    const res = await asRoot({ accountId: 'act_live' });
    expect(res.body.data.connected).toBe(false);
    expect(res.body.connection.code).toBe('NOT_CONNECTED');
  });
});

describe('?type=meta - 既存機能を壊さない', () => {
  it('他の type= は従来どおり（metaブロックに吸い込まれない）', async () => {
    for (const t of ['board', 'allowance', 'chat', 'events']) {
      const res = await call({ method: 'GET', query: { type: t } });
      expect(res.statusCode, t).toBe(200);
    }
  });
  it('type 未指定も従来どおり', async () => {
    expect((await call({ method: 'GET', query: {} })).statusCode).toBe(200);
  });
});
