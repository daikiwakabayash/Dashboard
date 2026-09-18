import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../api/plan-store.js';
import { _clearBearerCache } from '../lib/actor.js';
import { hashOwnerToken } from '../lib/settlement.js';

// 社内限定データは「ログインしていること」を要求する（役割は問わない）。
// ⚠️ チャットの「本部/root限定」をここへ広げない＝スタッフ／オーナーの利用を維持する。
const KV = 'https://kv.test';
let store;
function installFetchMock() {
  store = new Map();
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    const ok = (b) => ({ ok: true, status: 200, json: async () => b, headers: new Map() });
    if (u.startsWith(`${KV}/get/`)) { const k = decodeURIComponent(u.slice(`${KV}/get/`.length)); return ok({ result: store.has(k) ? store.get(k) : null }); }
    if (u.startsWith(`${KV}/set/`)) { store.set(decodeURIComponent(u.slice(`${KV}/set/`.length)), String(opts.body)); return ok({ result: 'OK' }); }
    if (u === KV) { const c = JSON.parse(opts.body); if (c[0] === 'MGET') return ok({ result: c.slice(1).map(k => (store.has(k) ? store.get(k) : null)) }); return ok({ result: 1 }); }
    return ok({});
  });
}
let saved;
beforeEach(() => {
  saved = { u: process.env.KV_REST_API_URL, t: process.env.KV_REST_API_TOKEN, d: process.env.DASHBOARD_PASSWORD,
            s: process.env.AUTH_SALT, p: process.env.SETTLEMENT_OWNER_PASSWORDS, o: process.env.SETTLEMENT_OWNER_SHOPS };
  process.env.KV_REST_API_URL = KV;
  process.env.KV_REST_API_TOKEN = 'test-token-not-a-secret';
  process.env.DASHBOARD_PASSWORD = 'pw-for-test';
  process.env.AUTH_SALT = 'salt-for-test';
  process.env.SETTLEMENT_OWNER_PASSWORDS = JSON.stringify({ 'セラピスト花子': 'staff-pw', 'オーナー太郎': 'owner-pw' });
  process.env.SETTLEMENT_OWNER_SHOPS = JSON.stringify({ 'セラピスト花子': ['A院'], 'オーナー太郎': ['A院', 'B院'] });
  installFetchMock();
  _clearBearerCache();
  store.set('naoru:acctmeta:v1', JSON.stringify({ 'セラピスト花子': { role: 'staff' }, 'オーナー太郎': { role: 'owner' } }));
});
afterEach(() => {
  for (const [k, v] of [['KV_REST_API_URL', saved.u], ['KV_REST_API_TOKEN', saved.t], ['DASHBOARD_PASSWORD', saved.d],
                        ['AUTH_SALT', saved.s], ['SETTLEMENT_OWNER_PASSWORDS', saved.p], ['SETTLEMENT_OWNER_SHOPS', saved.o]]) {
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
const rootHdr = () => ({ 'x-cc-owner': '__root__', 'x-cc-token': hashOwnerToken('__root__', 'pw-for-test', 'salt-for-test') });
const ownerHdr = (name, pw) => ({ 'x-cc-owner': encodeURIComponent(name), 'x-cc-token': hashOwnerToken(name, pw, 'salt-for-test') });

const INTERNAL = ['board', 'events', 'thanksgift', 'presence', 'allowance', 'adspend', 'faq', 'knowledge', 'meo', 'patrol'];

describe('未ログインでは社内限定データを取れない', () => {
  for (const t of INTERNAL) {
    it(`GET ?type=${t} → 403`, async () => {
      const res = await call({ method: 'GET', query: { type: t } });
      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe('login_required');
    });
  }
  it('🔴 未ログインの書き込みも拒否する', async () => {
    const res = await call({ method: 'POST', body: { type: 'board', action: 'post', post: { text: '不正投稿' } } });
    expect(res.statusCode).toBe(403);
  });
  it('🔴 応答に中身が含まれない', async () => {
    store.set('naoru:thanksgift:v1', JSON.stringify({ votes: [{ fromStaffName: '個人名', comment: '本文' }] }));
    const res = await call({ method: 'GET', query: { type: 'thanksgift' } });
    expect(JSON.stringify(res.body)).not.toContain('個人名');
  });
  it('🔴 role の自己申告では通らない', async () => {
    const res = await call({ method: 'GET', headers: { 'x-chat-role': 'root' }, query: { type: 'board' } });
    expect(res.statusCode).toBe(403);
  });
  it('🔴 秘密が未設定でも素通ししない', async () => {
    delete process.env.DASHBOARD_PASSWORD;
    const res = await call({ method: 'GET', headers: { 'x-cc-owner': '__root__', 'x-cc-token': '' }, query: { type: 'board' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('🔴 スタッフ・オーナーの既存利用を維持する（root限定にしない）', () => {
  for (const t of ['board', 'events', 'thanksgift', 'allowance', 'faq', 'knowledge', 'adspend', 'presence']) {
    it(`スタッフのログインで ?type=${t} が使える`, async () => {
      const res = await call({ method: 'GET', headers: ownerHdr('セラピスト花子', 'staff-pw'), query: { type: t } });
      expect(res.statusCode).toBe(200);
    });
  }
  it('オーナーのログインでも使える', async () => {
    const res = await call({ method: 'GET', headers: ownerHdr('オーナー太郎', 'owner-pw'), query: { type: 'board' } });
    expect(res.statusCode).toBe(200);
  });
  it('スタッフが掲示板へ投稿できる（書き込みも維持）', async () => {
    const res = await call({ method: 'POST', headers: ownerHdr('セラピスト花子', 'staff-pw'),
      body: { type: 'board', action: 'post', post: { authorId: 's1', authorName: '花子', text: 'テスト投稿' } } });
    expect(res.statusCode).toBe(200);
  });
  it('rootも従来どおり使える', async () => {
    expect((await call({ method: 'GET', headers: rootHdr(), query: { type: 'board' } })).statusCode).toBe(200);
  });
});

describe('チャットの公開条件は広げない', () => {
  it('🔴 スタッフはチャットを使えない（本部/root限定のまま）', async () => {
    const res = await call({ method: 'GET', headers: ownerHdr('セラピスト花子', 'staff-pw'), query: { type: 'chat' } });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('chat_admin_only');
  });
  it('🔴 オーナーもチャットは使えない', async () => {
    const res = await call({ method: 'GET', headers: ownerHdr('オーナー太郎', 'owner-pw'), query: { type: 'chat' } });
    expect(res.body.code).toBe('chat_admin_only');
  });
  it('社内限定データとチャットで理由コードが違う（切り分けできる）', async () => {
    const a = await call({ method: 'GET', query: { type: 'board' } });
    const b = await call({ method: 'GET', query: { type: 'chat' } });
    expect(a.body.code).toBe('login_required');
    expect(b.body.code).toBe('chat_admin_only');
  });
});

describe('#390 のプロフィール制限の影響', () => {
  it('🔴 プロフィールは現在も本部/root限定のまま（変更していない）', async () => {
    const res = await call({ method: 'GET', headers: ownerHdr('セラピスト花子', 'staff-pw'), query: { type: 'profile' } });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('chat_admin_only');
  });
  it('rootは従来どおり使える', async () => {
    expect((await call({ method: 'GET', headers: rootHdr(), query: { type: 'profile' } })).statusCode).toBe(200);
  });
});

describe('未知の type / action', () => {
  it('未知の type はゲートの対象外で、既存の既定応答のまま（データを壊さない）', async () => {
    const res = await call({ method: 'GET', query: { type: 'nonexistent_xyz' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('goals');      // 既定のplan応答
  });
  it('🔴 未知の action は別の保存処理へ流れない', async () => {
    const before = store.get('naoru:board:v1');
    const res = await call({ method: 'POST', headers: rootHdr(), body: { type: 'board', action: 'totally_unknown', post: { text: 'x' } } });
    expect(store.get('naoru:board:v1')).toBe(before);   // 何も書き換わらない
    expect(res.statusCode).toBeLessThan(500);
  });
  it('🔴 chatai の未知 action は invalid_request', async () => {
    store.set('naoru:cc:flags:v1:development', JSON.stringify({ cc_all: true, cc_ai_trial: true }));
    const res = await call({ method: 'POST', headers: rootHdr(), body: { type: 'chatai', action: 'unknown_action' } });
    expect(res.body.ok).toBe(false);
    expect(['invalid_request', 'rollout_disabled']).toContain(res.body.error.code);
  });
});
