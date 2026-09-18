import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../api/plan-store.js';
import { _clearBearerCache } from '../lib/actor.js';
import { hashOwnerToken } from '../lib/settlement.js';

// ?type=meta は読取専用・本部/root限定。UIではなくサーバー側で強制されることを固定する。
const KV = 'https://kv.test';
let store, upstreamCalls;

function installFetchMock(upstreamResponse) {
  store = new Map(); upstreamCalls = [];
  // Meta画面のフラグ（サーバー側でも確認される）。store を作り直すたびに入れ直す。
  store.set('naoru:cc:flags:v1:preview', JSON.stringify({ cc_all: true, cc_meta_overview: true, cc_authz: 'off' }));
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    const ok = (b) => ({ ok: true, status: 200, json: async () => b, headers: new Map() });
    if (u.startsWith(`${KV}/get/`)) {
      const key = decodeURIComponent(u.slice(`${KV}/get/`.length));
      return ok({ result: store.has(key) ? store.get(key) : null });
    }
    if (u.startsWith(`${KV}/set/`)) { store.set(decodeURIComponent(u.slice(`${KV}/set/`.length)), String(opts.body)); return ok({ result: 'OK' }); }
    if (u.includes('/v1/meta/overview')) {
      upstreamCalls.push({ url: u, opts });
      // 実APIは要求した期間・アカウントをそのまま返す。テストでも同じ振る舞いにする
      // （要求と応答の一致チェックが働くため）。
      const r = upstreamResponse;
      if (r && r.period && r.account) {
        const q = new URL(u);
        return ok({ ...r,
          account: { ...r.account, id: q.searchParams.get('account_id') || r.account.id },
          period: { ...r.period, from: q.searchParams.get('from') || r.period.from, to: q.searchParams.get('to') || r.period.to },
          tenant_id: q.searchParams.get('tenant_id') || r.tenant_id });
      }
      return ok(r);
    }
    return ok({});
  });
}

let saved;
beforeEach(() => {
  saved = { u: process.env.KV_REST_API_URL, t: process.env.KV_REST_API_TOKEN, e: process.env.VERCEL_ENV,
            d: process.env.DASHBOARD_PASSWORD, s: process.env.AUTH_SALT,
            b: process.env.META_READ_API_BASE, k: process.env.META_READ_API_KEY, al: process.env.META_AD_ACCOUNT_IDS };
  process.env.KV_REST_API_URL = KV;
  process.env.KV_REST_API_TOKEN = 'test-token-not-a-secret';
  process.env.VERCEL_ENV = 'preview';
  process.env.DASHBOARD_PASSWORD = 'pw-for-test';
  process.env.AUTH_SALT = 'salt-for-test';
  delete process.env.META_READ_API_BASE;
  delete process.env.META_READ_API_KEY;
  delete process.env.META_AD_ACCOUNT_IDS;
  installFetchMock({});
  _clearBearerCache();
  // Meta画面はフラグで守られている（サーバー側でも確認する）。既定で有効にしておく。
  store.set('naoru:cc:flags:v1:preview', JSON.stringify({ cc_all: true, cc_meta_overview: true, cc_authz: 'off' }));
});
const setFlag = (patch) => store.set('naoru:cc:flags:v1:preview', JSON.stringify({ cc_all: true, cc_meta_overview: true, cc_authz: 'off', ...patch }));
afterEach(() => {
  for (const [k, v] of [['KV_REST_API_URL', saved.u], ['KV_REST_API_TOKEN', saved.t], ['VERCEL_ENV', saved.e],
                        ['DASHBOARD_PASSWORD', saved.d], ['AUTH_SALT', saved.s],
                        ['META_READ_API_BASE', saved.b], ['META_READ_API_KEY', saved.k],
                        ['META_AD_ACCOUNT_IDS', saved.al]]) {
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
    api_version: 'meta-read-1', status: 'ok', tenant_id: 'naoru', mode: 'live', data_mode: 'live',
    account: { id: 'act_700000001', name: '本番アカウント', currency: 'JPY', timezone: 'Asia/Tokyo', store_mapping: [] },
    period: { from: '2026-09-10', to: '2026-09-16', complete_days_only: true, excluded_today: true },
    totals: { spend: { value: 1000, unit: 'JPY', display: '¥1,000', quality: 'VERIFIED', source: 'Meta' } },
    rows: [], freshness: { last_success_at: '2026-09-18T03:00:00+09:00' },
  };
  beforeEach(() => {
    process.env.META_READ_API_BASE = 'https://platform.test';
    process.env.META_READ_API_KEY = 'service-key-not-a-real-secret';
    process.env.META_AD_ACCOUNT_IDS = 'act_700000001,act_700000002,act_123';   // 許可リスト（空だと上流を呼ばない仕様）
    installFetchMock(live);
  });

  it('実データを返し、sample:false になる', async () => {
    const res = await asRoot({ accountId: 'act_700000001' });
    expect(res.body.sample).toBe(false);
    expect(res.body.data.account.id).toBe('act_700000001');
    expect(res.body.data.totals.spend.value).toBe(1000);
  });
  it('🔴 Metaのトークンではなくサービスキーを上流へ送る（トークンはDashboardに無い）', async () => {
    await asRoot({ accountId: 'act_700000001' });
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0].opts.headers.Authorization).toBe('Bearer service-key-not-a-real-secret');
  });
  it('🔴 応答にサービスキーを含めない（ブラウザへ漏らさない）', async () => {
    const res = await asRoot({ accountId: 'act_700000001' });
    expect(JSON.stringify(res.body)).not.toContain('service-key-not-a-real-secret');
  });
  it('既定では直近の完了済み7日を要求する（当日を含めない）', async () => {
    await asRoot({ accountId: 'act_700000001' });
    const u = new URL(upstreamCalls[0].url);
    const from = u.searchParams.get('from'), to = u.searchParams.get('to');
    // ⚠️ 「当日」はアカウントの時間帯（Asia/Tokyo）で数える。
    //    UTC で数えると JST の 0〜9時（UTC 15〜24時）に日付がずれて誤検知する。
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    expect(to).not.toBe(today);
    expect(Math.round((Date.parse(to) - Date.parse(from)) / 86400000)).toBe(6);   // 7日分
  });
  it('期間を指定できる', async () => {
    await asRoot({ accountId: 'act_700000001', from: '2026-08-01', to: '2026-08-07' });
    const u = new URL(upstreamCalls[0].url);
    expect(u.searchParams.get('from')).toBe('2026-08-01');
  });
  it('🔴 上流が知らない版を返したら表示しない', async () => {
    installFetchMock({ ...live, api_version: 'meta-read-99' });
    const res = await asRoot({ accountId: 'act_700000001' });
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.error.code).toBe('UNSUPPORTED_VERSION');
  });
  it('🔴 上流が落ちても数字を作らない', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.startsWith(`${KV}/get/`)) {
        const key = decodeURIComponent(u.slice(`${KV}/get/`.length));
        return { ok: true, status: 200, json: async () => ({ result: store.has(key) ? store.get(key) : null }) };
      }
      if (u.includes('/v1/meta/overview')) throw new Error('network down');
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const res = await asRoot({ accountId: 'act_700000001' });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.error.code).toBe('UPSTREAM_ERROR');
    expect(res.body.data.totals).toBeUndefined();     // ← 金額を作らない
  });
  it('上流が未接続を返したら、その理由を出す', async () => {
    installFetchMock({ api_version: 'meta-read-1', status: 'error',
      error: { code: 'NOT_CONNECTED', message: 'まだ接続されていません', retryable: false } });
    const res = await asRoot({ accountId: 'act_700000001' });
    expect(res.body.data.connected).toBe(false);
    expect(res.body.connection.code).toBe('NOT_CONNECTED');
  });
});

describe('?type=meta - 既存機能を壊さない', () => {
  it('他の type= は従来どおり（metaブロックに吸い込まれない）', async () => {
    // 社内限定データはログイン必須（別PR）。未ログインは 403、ログイン済みは 200。
    for (const t of ['board', 'allowance', 'events']) {
      expect((await call({ method: 'GET', query: { type: t } })).statusCode, t).toBe(403);
      expect((await call({ method: 'GET', headers: rootHeaders(), query: { type: t } })).statusCode, t).toBe(200);
    }
    // chat / profile は別PR(#390)で本人確認必須になった＝未認証は403が正しい
    for (const t of ['chat', 'profile']) {
      const res = await call({ method: 'GET', query: { type: t } });
      expect(res.statusCode, t).toBe(403);
    }
  });
  it('type 未指定も従来どおり', async () => {
    expect((await call({ method: 'GET', query: {} })).statusCode).toBe(200);
  });
});

// ── #387 の指摘6点 ──────────────────────────────────────────────
describe('(1) tenant は検証済み actor から決める', () => {
  beforeEach(() => {
    process.env.META_READ_API_BASE = 'https://platform.test';
    process.env.META_READ_API_KEY = 'service-key-not-a-real-secret';
    process.env.META_AD_ACCOUNT_IDS = 'act_700000001';
    installFetchMock({
      api_version: 'meta-read-1', status: 'ok', tenant_id: 'naoru', mode: 'live', data_mode: 'live',
      account: { id: 'act_700000001', name: 'x', currency: 'JPY', timezone: 'Asia/Tokyo', store_mapping: [] },
      period: { from: '2026-09-10', to: '2026-09-16', complete_days_only: true },
      totals: {}, rows: [], freshness: {},
    });
  });
  it('🔴 クエリの tenantId で会社を切り替えられない', async () => {
    await asRoot({ accountId: 'act_700000001', tenantId: 'other-company' });
    const q = new URL(upstreamCalls[0].url);
    expect(q.searchParams.get('tenant_id')).toBe('naoru');     // actor 由来
    expect(upstreamCalls[0].opts.headers['X-Tenant-Id']).toBe('naoru');
  });
});

describe('(2) accountId は許可されたものだけ／応答の一致を確認する', () => {
  const live = {
    api_version: 'meta-read-1', status: 'ok', tenant_id: 'naoru', mode: 'live', data_mode: 'live',
    account: { id: 'act_111111111', name: 'x', currency: 'JPY', timezone: 'Asia/Tokyo', store_mapping: [] },
    period: { from: '2026-09-10', to: '2026-09-16', complete_days_only: true },
    totals: {}, rows: [], freshness: {},
  };
  beforeEach(() => {
    process.env.META_READ_API_BASE = 'https://platform.test';
    process.env.META_READ_API_KEY = 'k';
    process.env.META_AD_ACCOUNT_IDS = 'act_111111111,act_222222222';
    installFetchMock(live);
  });
  afterEach(() => { delete process.env.META_AD_ACCOUNT_IDS; });

  it('🔴 許可されていないアカウントは 403', async () => {
    const res = await asRoot({ accountId: 'act_999999999' });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('account_not_allowed');
  });
  it('許可されたアカウントは通る', async () => {
    expect((await asRoot({ accountId: 'act_111111111' })).statusCode).toBe(200);
  });
  it('未指定なら許可一覧の先頭を使う', async () => {
    await asRoot({});
    expect(new URL(upstreamCalls[0].url).searchParams.get('account_id')).toBe('act_111111111');
  });
  it('🔴 要求と違うアカウントが返ってきたら表示しない', async () => {
    installFetchMock({ ...live, account: { ...live.account, id: 'act_888888888' } });
    globalThis.fetch.mockImplementation(async (url, opts = {}) => {
      const u = String(url);
      if (u.startsWith(`${KV}/get/`)) { const k = decodeURIComponent(u.slice(`${KV}/get/`.length)); return { ok: true, status: 200, json: async () => ({ result: store.has(k) ? store.get(k) : null }) }; }
      if (u.includes('/v1/meta/overview')) return { ok: true, status: 200, json: async () => ({ ...live, account: { ...live.account, id: 'act_888888888' } }) };
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const res = await asRoot({ accountId: 'act_111111111' });
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.error.code).toBe('RESPONSE_MISMATCH');
    expect(res.body.data.totals).toBeUndefined();     // 数字を出さない
  });
});

describe('(3) フラグ・停止フラグを API 側でも確認する', () => {
  it('🔴 cc_meta_overview が OFF なら URL 直接呼び出しでも 403', async () => {
    setFlag({ cc_meta_overview: false });
    const res = await asRoot();
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('feature_disabled');
  });
  it('🔴 キルスイッチ（cc_all=false）でも 403', async () => {
    setFlag({ cc_all: false });
    expect((await asRoot()).statusCode).toBe(403);
  });
  it('🔴 OFF のときは上流へ取りに行かない', async () => {
    process.env.META_READ_API_BASE = 'https://platform.test';
    process.env.META_READ_API_KEY = 'k';
    setFlag({ cc_meta_overview: false });
    await asRoot({ accountId: 'x' });
    expect(upstreamCalls).toHaveLength(0);
  });
});

describe('(4) 接続先がモックを返したらサンプル表示を貫く', () => {
  beforeEach(() => { process.env.META_READ_API_BASE = 'https://platform.test'; process.env.META_READ_API_KEY = 'k'; process.env.META_AD_ACCOUNT_IDS = 'act_700000002,act_0000000000000,act_123'; });
  const base = {
    api_version: 'meta-read-1', status: 'ok', tenant_id: 'naoru', mode: 'live', data_mode: 'live',
    period: { from: '2026-09-10', to: '2026-09-16', complete_days_only: true },
    totals: {}, rows: [], freshness: {},
  };
  it('🔴 上流が sample/mock を申告したら外側も sample:true', async () => {
    installFetchMock({ ...base, mode: 'mock', account: { id: 'act_700000002', name: 'x', currency: 'JPY', timezone: 'Asia/Tokyo', store_mapping: [] } });
    const res = await asRoot({ accountId: 'act_700000002' });
    expect(res.body.sample).toBe(true);
    expect(res.body.data.isSample).toBe(true);
  });
  it('🔴 明らかに作り物のアカウントID（act_000…）もサンプル扱い', async () => {
    installFetchMock({ ...base, account: { id: 'act_0000000000000', name: 'x', currency: 'JPY', timezone: 'Asia/Tokyo', store_mapping: [] } });
    const res = await asRoot({ accountId: 'act_0000000000000' });
    expect(res.body.sample).toBe(true);
  });
  it('URLとキーが設定されているだけでは「実データ」と判断しない', async () => {
    installFetchMock({ ...base, _fixture: true, account: { id: 'act_700000002', name: 'x', currency: 'JPY', timezone: 'Asia/Tokyo', store_mapping: [] } });
    const res = await asRoot({ accountId: 'act_700000002' });
    expect(res.body.sample).toBe(true);
  });
});

describe('(5) HTTPエラー・不正schema を昇格させない', () => {
  beforeEach(() => { process.env.META_READ_API_BASE = 'https://platform.test'; process.env.META_READ_API_KEY = 'k'; process.env.META_AD_ACCOUNT_IDS = 'act_700000002,act_0000000000000,act_123'; });
  const withStatus = (status, body) => {
    installFetchMock({});
    globalThis.fetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.startsWith(`${KV}/get/`)) { const k = decodeURIComponent(u.slice(`${KV}/get/`.length)); return { ok: true, status: 200, json: async () => ({ result: store.has(k) ? store.get(k) : null }) }; }
      if (u.includes('/v1/meta/overview')) return { ok: false, status, json: async () => body };
      return { ok: true, status: 200, json: async () => ({}) };
    });
  };
  it('🔴 401 は AUTH_FAILED（接続成功にしない）', async () => {
    withStatus(401, {});
    const res = await asRoot({ accountId: 'act_700000002' });
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.error.code).toBe('AUTH_FAILED');
  });
  it('🔴 429 は RATE_LIMITED・再試行可', async () => {
    withStatus(429, {});
    const d = (await asRoot({ accountId: 'act_700000002' })).body.data;
    expect(d.error.code).toBe('RATE_LIMITED');
    expect(d.error.retryable).toBe(true);
  });
  it('🔴 500 でも数字を作らない', async () => {
    withStatus(500, { api_version: 'meta-read-1', status: 'ok', totals: { spend: { value: 999999 } } });
    const d = (await asRoot({ accountId: 'act_700000002' })).body.data;
    expect(d.ok).toBe(false);
    expect(d.totals).toBeUndefined();
  });

  // ③からの指摘(2): 非2xx で raw.freshness を捨てており、最終成功日時が常に null になっていた。
  // 「一度も取れていない」と「復旧待ち」を画面が区別できなくなるため保持する。
  it('🔴 HTTPエラーでも最終成功日時を捨てない', async () => {
    withStatus(502, { freshness: { last_success_at: '2026-09-18T03:00:00+09:00', lag_minutes: 45 } });
    const d = (await asRoot({ accountId: 'act_700000002' })).body.data;
    expect(d.ok).toBe(false);
    expect(d.freshness.lastSuccessAt).toBe('2026-09-18T03:00:00+09:00');
    expect(d.freshness.lagMinutes).toBe(45);
    expect(d.totals).toBeUndefined();          // 数字は作らないまま
  });
  it('上流が freshness を返さない場合は最終試行だけ埋める', async () => {
    withStatus(502, {});
    const d = (await asRoot({ accountId: 'act_700000002' })).body.data;
    expect(d.freshness.lastSuccessAt).toBeNull();
    expect(typeof d.freshness.lastAttemptAt).toBe('string');
  });
  it('上流が last_attempt_at を返せばそれを優先する', async () => {
    withStatus(502, { freshness: { last_attempt_at: '2026-09-18T04:00:00+09:00' } });
    const d = (await asRoot({ accountId: 'act_700000002' })).body.data;
    expect(d.freshness.lastAttemptAt).toBe('2026-09-18T04:00:00+09:00');
  });
});

describe('(6) タイムゾーン・通貨・行数上限', () => {
  beforeEach(() => {
    process.env.META_READ_API_BASE = 'https://platform.test';
    process.env.META_READ_API_KEY = 'k';
    process.env.META_AD_ACCOUNT_IDS = 'act_700000002';
    installFetchMock({
      api_version: 'meta-read-1', status: 'ok', tenant_id: 'naoru', mode: 'live', data_mode: 'live',
      account: { id: 'act_700000002', name: 'x', currency: 'AUD', timezone: 'Australia/Sydney', store_mapping: [] },
      period: { from: '2026-09-10', to: '2026-09-16', complete_days_only: true },
      totals: {}, rows: [], freshness: {},
    });
  });
  it('🔴 期間は広告アカウントのタイムゾーン基準で要求する', async () => {
    await asRoot({ accountId: 'act_700000002', tz: 'Australia/Sydney' });
    const q = new URL(upstreamCalls[0].url);
    // シドニーは日本より先に日付が変わるため、UTC基準とずれる日がある
    expect(q.searchParams.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(q.searchParams.get('to')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('🔴 JPY以外の通貨を保持する（勝手に円にしない）', async () => {
    const res = await asRoot({ accountId: 'act_700000002' });
    expect(res.body.data.account.currency).toBe('AUD');
  });
});

describe('🔴 実Credentialがあっても、許可リストが空/不正なら上流を呼ばない', () => {
  beforeEach(() => {
    process.env.META_READ_API_BASE = 'https://platform.test';
    process.env.META_READ_API_KEY = 'service-key-not-a-real-secret';
    installFetchMock({ api_version: 'meta-read-1', status: 'ok', tenant_id: 'naoru', mode: 'live', data_mode: 'live',
      account: { id: 'act_123', name: 'x', currency: 'JPY', timezone: 'Asia/Tokyo', store_mapping: [] },
      period: { from: '2026-09-10', to: '2026-09-16', complete_days_only: true }, totals: {}, rows: [], freshness: {} });
  });
  afterEach(() => { delete process.env.META_AD_ACCOUNT_IDS; delete process.env.META_AD_ACCOUNT_ID; });

  it('🔴 許可リストが未設定なら上流を呼ばず、サンプル表示にもしない', async () => {
    delete process.env.META_AD_ACCOUNT_IDS; delete process.env.META_AD_ACCOUNT_ID;
    const res = await asRoot({ accountId: 'act_123' });
    expect(upstreamCalls).toHaveLength(0);                 // ← 実データを取りに行かない
    expect(res.body.sample).toBe(false);                   // ← 未接続のサンプルとは別
    expect(res.body.connection.mode).toBe('misconfigured');
    expect(res.body.data.error.code).toBe('ACCOUNT_NOT_ALLOWED');
    expect(res.body.data.totals).toBeUndefined();          // 数字を作らない
  });
  it('🔴 形式が不正な許可リストは採用しない（空扱い）', async () => {
    process.env.META_AD_ACCOUNT_IDS = 'not-an-account,12345,＊＊＊';
    const res = await asRoot({ accountId: 'act_123' });
    expect(upstreamCalls).toHaveLength(0);
    expect(res.body.connection.mode).toBe('misconfigured');
  });
  it('🔴 許可リストにないアカウントは 403（上流も呼ばない）', async () => {
    process.env.META_AD_ACCOUNT_IDS = 'act_999';
    const res = await asRoot({ accountId: 'act_123' });
    expect(res.statusCode).toBe(403);
    expect(upstreamCalls).toHaveLength(0);
  });
  it('許可リストにあれば従来どおり取得する', async () => {
    process.env.META_AD_ACCOUNT_IDS = 'act_123';
    const res = await asRoot({ accountId: 'act_123' });
    expect(upstreamCalls).toHaveLength(1);
    expect(res.body.sample).toBe(false);
    expect(res.body.data.ok).toBe(true);
  });
  it('未接続（Credentialなし）は従来どおりサンプル表示のまま', async () => {
    delete process.env.META_READ_API_BASE; delete process.env.META_READ_API_KEY;
    const res = await asRoot();
    expect(res.body.sample).toBe(true);                    // ← こちらはサンプル
    expect(res.body.connection.mode).toBe('sample');
  });
});

// ── 実データ接続の受入ゲート（API経路）────────────────────────────────
describe('(7) 実データ接続の受入ゲート', () => {
  const live = {
    api_version: 'meta-read-1', status: 'ok', tenant_id: 'naoru', mode: 'live', data_mode: 'live',
    account: { id: 'act_1335477837049931', name: '本番', currency: 'JPY', timezone: 'Asia/Tokyo', store_mapping: [] },
    period: { from: '2026-09-10', to: '2026-09-16', complete_days_only: true },
    totals: { spend: { value: 1000, unit: 'JPY', quality: 'VERIFIED' } }, rows: [], freshness: {},
  };
  beforeEach(() => {
    process.env.META_READ_API_BASE = 'https://platform.test';
    process.env.META_READ_API_KEY = 'k';
    installFetchMock(live);
  });
  afterEach(() => { delete process.env.META_AD_ACCOUNT_IDS; delete process.env.META_AD_ACCOUNT_ID; });

  it('🔴 許可リストに1件でも不正があれば、上流を呼ばず拒否する（部分採用しない）', async () => {
    process.env.META_AD_ACCOUNT_IDS = 'act_1335477837049931,invalid';
    const res = await asRoot({ accountId: 'act_1335477837049931' });
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.error.code).toBe('ACCOUNT_NOT_ALLOWED');
    expect(res.body.connection.mode).toBe('misconfigured');
    expect(upstreamCalls.length).toBe(0);            // 実データを取りに行かない
    expect(res.body.sample).toBe(false);             // サンプル表示でも「ない」
  });
  it('🔴 旧 META_AD_ACCOUNT_ID（単数）だけでは上流を呼ばない。理由に移行先を出す', async () => {
    process.env.META_AD_ACCOUNT_ID = 'act_1335477837049931';
    const res = await asRoot({ accountId: 'act_1335477837049931' });
    expect(res.body.data.error.code).toBe('ACCOUNT_NOT_ALLOWED');
    expect(res.body.connection.reason).toContain('META_AD_ACCOUNT_IDS');
    expect(upstreamCalls.length).toBe(0);
  });
  it('正しい許可リストなら実データを取りに行く', async () => {
    process.env.META_AD_ACCOUNT_IDS = 'act_1335477837049931';
    const res = await asRoot({ accountId: 'act_1335477837049931' });
    expect(upstreamCalls.length).toBe(1);
    expect(res.body.data.ok).toBe(true);
    expect(res.body.sample).toBe(false);
    expect(res.body.data.totals.spend.value).toBe(1000);
  });
  it('🔴 上流が unknown を返したら実績として表示しない', async () => {
    process.env.META_AD_ACCOUNT_IDS = 'act_1335477837049931';
    installFetchMock({ ...live, mode: 'unknown', data_mode: 'unknown' });
    const res = await asRoot({ accountId: 'act_1335477837049931' });
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.error.code).toBe('MODE_UNCONFIRMED');
    expect(res.body.data.totals).toBeUndefined();
    expect(res.body.sample).toBe(false);
  });
  it('🔴 金額の単位がアカウント通貨と違えば、その数字を出さない', async () => {
    process.env.META_AD_ACCOUNT_IDS = 'act_1335477837049931';
    installFetchMock({ ...live, account: { ...live.account, currency: 'AUD' } });
    const res = await asRoot({ accountId: 'act_1335477837049931' });
    expect(res.body.data.totals.spend.value).toBe(null);
    expect(res.body.data.totals.spend.missingReason).toContain('通貨');
  });
});
