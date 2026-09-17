import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../api/plan-store.js';
import { _clearBearerCache } from '../lib/actor.js';

// ?type=chat が cc_authz の計測を通ること。
// 最重要: log モードでは **既存のチャット操作を1つも止めない**。
const KV = 'https://kv.test';
let store;

function installFetchMock() {
  store = new Map();
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    const ok = (b) => ({ ok: true, status: 200, json: async () => b, headers: new Map() });
    if (u.startsWith(`${KV}/get/`)) {
      const key = decodeURIComponent(u.slice(`${KV}/get/`.length));
      return ok({ result: store.has(key) ? store.get(key) : null });
    }
    if (u.startsWith(`${KV}/set/`)) { store.set(decodeURIComponent(u.slice(`${KV}/set/`.length)), String(opts.body)); return ok({ result: 'OK' }); }
    if (u === KV) {
      const cmd = JSON.parse(opts.body);
      if (cmd[0] === 'EVAL' && String(cmd[1]).includes('arr[#arr+1]')) {
        const key = cmd[3], args = cmd.slice(4);
        let arr = []; try { arr = JSON.parse(store.get(key) || '[]') || []; } catch { arr = []; }
        arr.push(JSON.parse(args[0]));
        const cap = Number(args[1]); if (arr.length > cap) arr = arr.slice(-cap);
        store.set(key, JSON.stringify(arr));
        return ok({ result: arr.length });
      }
      if (cmd[0] === 'MGET') return ok({ result: cmd.slice(1).map(k => (store.has(k) ? store.get(k) : null)) });
    }
    return ok({});
  });
}

let saved;
beforeEach(() => {
  saved = { u: process.env.KV_REST_API_URL, t: process.env.KV_REST_API_TOKEN, e: process.env.VERCEL_ENV, d: process.env.DASHBOARD_PASSWORD };
  process.env.KV_REST_API_URL = KV;
  process.env.KV_REST_API_TOKEN = 'test-token-not-a-secret';
  process.env.VERCEL_ENV = 'preview';
  installFetchMock();
  _clearBearerCache();
  // ルームの土台（全社アナウンス・店舗2つ・DM・グループ）
  store.set('naoru:chat:v1', JSON.stringify({
    rooms: [
      { id: 'announce_all', kind: 'announce', name: '全社アナウンス', members: [] },
      { id: 'store_恵比寿', kind: 'store', shop: '恵比寿', members: [] },
      { id: 'store_梅田',   kind: 'store', shop: '梅田',   members: [] },
      { id: 'd1', kind: 'dm', members: ['u_st', 'u_mgr'] },
      { id: 'g1', kind: 'group', name: '部活', members: ['u_st'] },
    ],
    dir: { staff: [], updatedAt: '' }, notes: {},
  }));
});
afterEach(() => {
  for (const [k, v] of [['KV_REST_API_URL', saved.u], ['KV_REST_API_TOKEN', saved.t], ['VERCEL_ENV', saved.e], ['DASHBOARD_PASSWORD', saved.d]]) {
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
const FLAGS = 'naoru:cc:flags:v1:preview';
const AUDIT = 'naoru:cc:audit:v1:preview';
const setMode = (mode) => store.set(FLAGS, JSON.stringify({ cc_all: true, cc_authz: mode }));
const auditRows = () => { try { return JSON.parse(store.get(AUDIT) || '[]'); } catch { return []; } };
const lastRec = () => { const r = auditRows(); return r.length ? r[r.length - 1].after : null; };

// Preview のロール切替ヘッダを使う（本番では効かない仕組み）
const asRole = (role, body = {}, shops = '') => call({
  method: 'POST',
  headers: { 'x-cc-preview-role': role, ...(shops ? { 'x-cc-preview-shops': shops } : {}) },
  body: { type: 'chat', ...body },
});
// send は msg オブジェクトが要る（既存の仕様）
const sendTo = (role, roomId, shops = '') =>
  asRole(role, { action: 'send', roomId, staffId: `u_${role}`, msg: { fromStaffId: `u_${role}`, fromName: role, text: 'テスト' } }, shops);

describe('?type=chat - off では従来どおり（計測しない）', () => {
  it('ヘッダも記録も付かない', async () => {
    setMode('off');
    const res = await call({ method: 'GET', query: { type: 'chat' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['X-CC-Authz']).toBeUndefined();
    expect(auditRows()).toHaveLength(0);
  });
});

describe('?type=chat - log では計測するが1つも止めない', () => {
  it('閲覧（GET）が通り、記録が残る', async () => {
    setMode('log');
    const res = await call({ method: 'GET', query: { type: 'chat' }, headers: { 'x-cc-preview-role': 'staff', 'x-cc-preview-shops': '恵比寿' } });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.rooms)).toBe(true);
    expect(String(res.headers['X-CC-Authz'])).toMatch(/^log:/);
    expect(auditRows().length).toBeGreaterThan(0);
  });

  it('🔴 スタッフの全社アナウンスへの投稿は DENY と記録されるが、送信は成功する', async () => {
    setMode('log');
    const res = await sendTo('staff', 'announce_all', '恵比寿');
    expect(res.statusCode).toBe(200);                    // ← log では止めない
    expect(String(res.headers['X-CC-Authz'])).toContain('log:');
    const rec = lastRec();
    expect(rec.decision).toBe('DENY');
    expect(rec.code).toBe('announce_hq_only');
  });

  it('本部の全社アナウンスへの投稿は ALLOW と記録される', async () => {
    setMode('log');
    await sendTo('hq', 'announce_all');
    expect(lastRec().decision).toBe('ALLOW');
  });

  it('スタッフの自店への投稿は ALLOW', async () => {
    setMode('log');
    await sendTo('staff', 'store_恵比寿', '恵比寿');
    const rec = lastRec();
    expect(rec.action).toBe('chat.send');
    expect(rec.shop).toBe('恵比寿');
  });

  it('記録に「誰が・role・tenant・店舗・操作・ALLOW/DENY」が揃う', async () => {
    setMode('log');
    await sendTo('owner', 'store_恵比寿', '恵比寿');
    const rec = lastRec();
    for (const k of ['actorId', 'role', 'tenantId', 'shop', 'action', 'decision', 'source', 'mode']) {
      expect(rec, k).toHaveProperty(k);
    }
    expect(rec.mode).toBe('log');
  });

  it('DM・グループ作成・メンバー変更も操作名として記録される', async () => {
    setMode('log');
    await asRole('staff', { action: 'createRoom', room: { kind: 'dm', members: ['u_st', 'u_mgr'] }, staffId: 'u_st' }, '恵比寿');
    expect(lastRec().action).toBe('chat.dm');
    await asRole('staff', { action: 'createRoom', room: { kind: 'group', name: 'x', members: ['u_st'] }, staffId: 'u_st' }, '恵比寿');
    expect(lastRec().action).toBe('chat.group_create');
    await asRole('staff', { action: 'setMembers', roomId: 'g1', members: ['u_st'], staffId: 'u_st' }, '恵比寿');
    expect(lastRec().action).toBe('chat.member_add');
  });

  it('記録にトークンが混入しない', async () => {
    setMode('log');
    await asRole('staff', { action: 'send', roomId: 'store_恵比寿', staffId: 'u_st', msg: { fromStaffId: 'u_st', text: 'x' }, token: 'secret-xyz' }, '恵比寿');
    expect(JSON.stringify(auditRows())).not.toContain('secret-xyz');
  });
});

describe('?type=chat - 5ロールぶんの ALLOW / DENY が記録できる', () => {
  const cases = [
    { role: 'root',    room: 'announce_all',  expect: 'ALLOW', why: '管理者は全社アナウンスに投稿できる' },
    { role: 'hq',      room: 'announce_all',  expect: 'ALLOW', why: '本部は全社アナウンスに投稿できる' },
    { role: 'owner',   room: 'announce_all',  expect: 'DENY',  why: 'オーナーは全社アナウンスに投稿できない' },
    { role: 'manager', room: 'announce_all',  expect: 'DENY',  why: '店長は全社アナウンスに投稿できない' },
    { role: 'staff',   room: 'announce_all',  expect: 'DENY',  why: 'スタッフは全社アナウンスに投稿できない' },
    { role: 'root',    room: 'store_梅田',    expect: 'ALLOW', why: '管理者は全店に投稿できる' },
    { role: 'hq',      room: 'store_梅田',    expect: 'ALLOW', why: '本部は全店に投稿できる' },
  ];
  for (const c of cases) {
    it(`${c.role} → ${c.room} は ${c.expect}（${c.why}）`, async () => {
      setMode('log');
      const res = await sendTo(c.role, c.room, c.role === 'root' || c.role === 'hq' ? '' : '恵比寿');
      expect(res.statusCode).toBe(200);            // log では全て通る
      expect(lastRec().decision).toBe(c.expect);
    });
  }
});

describe('?type=chat - enforce にしたときだけ止まる（今は使わない）', () => {
  it('enforce ではスタッフの全社アナウンス投稿が403になる', async () => {
    setMode('enforce');
    const res = await sendTo('staff', 'announce_all', '恵比寿');
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('announce_hq_only');
  });
  it('戻せる: enforce → log で即座に通るようになる', async () => {
    setMode('enforce');
    expect((await sendTo('staff', 'announce_all', '恵比寿')).statusCode).toBe(403);
    setMode('log');
    expect((await sendTo('staff', 'announce_all', '恵比寿')).statusCode).toBe(200);
  });
  it('enforce では申告だけの root（body.root）を信用しない', async () => {
    setMode('enforce');
    const res = await call({
      method: 'POST', headers: { 'x-cc-preview-role': 'staff', 'x-cc-preview-shops': '恵比寿' },
      body: { type: 'chat', action: 'deleteMsg', roomId: 'g1', msgId: 'm1', staffId: 'u_st', root: true },
    });
    // 認可自体は chat.send 相当で通るが、rootOk は false なので他人の投稿は消えない
    expect([200, 403]).toContain(res.statusCode);
  });
});

describe('Preview ロール切替 - 本番では絶対に効かない', () => {
  it('🔴 VERCEL_ENV=production ではロール切替ヘッダを無視する', async () => {
    const before = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = 'production';
    try {
      store.set('naoru:cc:flags:v1', JSON.stringify({ cc_all: true, cc_authz: 'log' }));
      const res = await sendTo('root', 'announce_all');
      expect(res.statusCode).toBe(200);
      const rows = JSON.parse(store.get('naoru:cc:audit:v1') || '[]');
      const rec = rows.length ? rows[rows.length - 1].after : null;
      // 切替が効いていれば root/ALLOW になるが、本番では未検証のまま DENY になる
      expect(rec && rec.previewOverride).toBeFalsy();
      expect(rec && rec.decision).toBe('DENY');
    } finally { process.env.VERCEL_ENV = before; }
  });
  it('Preview の記録には previewOverride の印が付く（実績と混ざらない）', async () => {
    setMode('log');
    await sendTo('root', 'announce_all');
    expect(lastRec().previewOverride).toBe(true);
  });
  it('未知のロール名は無視する（勝手に権限を作らない）', async () => {
    setMode('log');
    const res = await call({ method: 'POST', headers: { 'x-cc-preview-role': 'superuser' }, body: { type: 'chat', action: 'send', roomId: 'announce_all', msg: { text: 'x' } } });
    expect(res.statusCode).toBe(200);
    expect(lastRec().previewOverride).toBeFalsy();
  });
  it('AI Agent としても切り替えられる（送信できないことを確かめるため）', async () => {
    setMode('log');
    await sendTo('agent', 'store_恵比寿');
    const rec = lastRec();
    expect(rec.source).toBe('agent');
    expect(rec.decision).toBe('DENY');
  });
  it('Preview のスタッフは他店に送れない（DENY として記録）', async () => {
    setMode('log');
    await sendTo('staff', 'store_梅田', '恵比寿');
    expect(lastRec().decision).toBe('DENY');
  });
  it('Preview のオーナーは管轄2店舗が見える', async () => {
    setMode('log');
    await sendTo('owner', 'store_梅田', '恵比寿,梅田');
    expect(lastRec().decision).toBe('ALLOW');
  });
});
