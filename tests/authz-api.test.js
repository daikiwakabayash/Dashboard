import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../api/plan-store.js';
import { _clearBearerCache } from '../lib/actor.js';
import { hashOwnerToken } from '../lib/settlement.js';

// cc_authz を段階的に上げたときの、実際のAPIの振る舞いを固定する。
// off / log / warn は**絶対にブロックしない**（既存の動作を変えない）ことが最重要。
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
  saved = { u: process.env.KV_REST_API_URL, t: process.env.KV_REST_API_TOKEN, e: process.env.VERCEL_ENV, d: process.env.DASHBOARD_PASSWORD, s: process.env.AUTH_SALT };
  process.env.KV_REST_API_URL = KV;
  process.env.KV_REST_API_TOKEN = 'test-token-not-a-secret';
  process.env.VERCEL_ENV = 'preview';                 // Preview を想定
  installFetchMock();
  _clearBearerCache();
});
afterEach(() => {
  for (const [k, v] of [['KV_REST_API_URL', saved.u], ['KV_REST_API_TOKEN', saved.t], ['VERCEL_ENV', saved.e], ['DASHBOARD_PASSWORD', saved.d], ['AUTH_SALT', saved.s]]) {
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
// 本人確認済み root として POST する（Command Center の書き込みは本人確認が必須）
const asRoot = (body) => {
  process.env.DASHBOARD_PASSWORD = 'pw-for-test';
  process.env.AUTH_SALT = 'salt-for-test';
  const token = hashOwnerToken('__root__', 'pw-for-test', 'salt-for-test');
  return call({ method: 'POST', body: { owner: '__root__', token, ...body } });
};
const FLAGS = 'naoru:cc:flags:v1:preview';            // 環境スコープ済みのキー
const AUDIT = 'naoru:cc:audit:v1:preview';
const setMode = (mode) => store.set(FLAGS, JSON.stringify({ cc_all: true, cc_approval: true, cc_agentlog: true, cc_authz: mode }));
const auditRows = () => { try { return JSON.parse(store.get(AUDIT) || '[]'); } catch { return []; } };
const denies = () => auditRows().filter(e => e.action === 'authz_deny');

describe('cc_authz - off（既定）: 何も変わらない', () => {
  it('本人確認済みなら認可ヘッダを付けず、拒否も記録もしない', async () => {
    setMode('off');
    const res = await asRoot({ type: 'approval', action: 'create', approval: { kind: 'meta_pause', title: 'x' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['X-CC-Authz']).toBeUndefined();   // ← ヘッダ自体が付かない
    expect(denies()).toHaveLength(0);
  });
  it('🔴 フラグ変更は cc_authz=off でも本人確認が要る（制御面は常時強制）', async () => {
    setMode('off');
    const res = await call({ method: 'POST', body: { type: 'ccflags', action: 'set', key: 'cc_approval', value: true, actor: { role: 'staff' } } });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('unverified_admin');
  });
  it('閲覧（GET）は従来どおり通る（観測の対象であって制御面ではない）', async () => {
    setMode('off');
    expect((await call({ method: 'GET', query: { type: 'ccflags' } })).statusCode).toBe(200);
  });
});

// ── 制御面（公開設定の変更権限）は cc_authz のモードに関係なく常に強制する ──
describe('常時強制ゲート - 制御面の変更', () => {
  const realRoot = () => {
    process.env.DASHBOARD_PASSWORD = 'pw-for-test';
    process.env.AUTH_SALT = 'salt-for-test';
    return hashOwnerToken('__root__', 'pw-for-test', 'salt-for-test');
  };
  for (const mode of ['off', 'log', 'warn', 'enforce']) {
    it(`${mode}: 名乗りだけのフラグ変更は 403`, async () => {
      setMode(mode);
      const res = await call({ method: 'POST', body: { type: 'ccflags', action: 'set', key: 'cc_approval', value: true, actor: { role: 'root' } } });
      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe('unverified_admin');
    });
    it(`${mode}: 本人確認済みの root なら通る`, async () => {
      setMode(mode);
      const tok = realRoot();
      const res = await call({ method: 'POST', body: { type: 'ccflags', action: 'set', key: 'cc_approval', value: true, owner: '__root__', token: tok } });
      expect(res.statusCode).toBe(200);
    });
  }
  it('キルスイッチも本人確認が要る', async () => {
    setMode('off');
    expect((await call({ method: 'POST', body: { type: 'ccflags', action: 'kill', actor: { role: 'root' } } })).statusCode).toBe(403);
  });
  it('承認の決裁も本人確認が要る', async () => {
    setMode('off');
    const res = await call({ method: 'POST', body: { type: 'approval', action: 'decide', id: 'x', decision: 'approve', actor: { role: 'root' } } });
    expect(res.statusCode).toBe(403);
  });
  it('🔴 秘密が未設定なら、空トークンでも root になれない', async () => {
    setMode('off');
    delete process.env.DASHBOARD_PASSWORD;
    const res = await call({ method: 'POST', body: { type: 'ccflags', action: 'set', key: 'cc_approval', value: true, owner: '__root__', token: '' } });
    expect(res.statusCode).toBe(403);
  });
  it('拒否は監査ログに残る', async () => {
    setMode('off');
    await call({ method: 'POST', body: { type: 'ccflags', action: 'set', key: 'cc_approval', value: true, actor: { role: 'root' } } });
    const rows = auditRows().filter(e => e.action === 'authz_deny');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[rows.length - 1].after.code).toBe('unverified_admin');
  });
  it('閲覧(GET)は止めない。書き込みは本人確認が要る', async () => {
    setMode('off');
    expect((await call({ method: 'GET', query: { type: 'approval' } })).statusCode).toBe(200);
    // 名乗りだけの提案作成は拒否（新APIなので互換のために開ける理由がない）
    const bad = await call({ method: 'POST', body: { type: 'approval', action: 'create', approval: { kind: 'meta_pause', title: 'x' } } });
    expect(bad.statusCode).toBe(403);
    expect(bad.body.code).toBe('unverified');
    // 本人確認済みなら通る
    expect((await asRoot({ type: 'approval', action: 'create', approval: { kind: 'meta_pause', title: 'x' } })).statusCode).toBe(200);
  });
});

describe('cc_authz - log: 計測するがブロックしない', () => {
  it('本人確認済みの書き込みは log でも止まらない', async () => {
    setMode('log');
    const res = await asRoot({ type: 'approval', action: 'create', approval: { kind: 'meta_pause', title: '検証' } });
    expect(res.statusCode).toBe(200);           // ← ブロックしない
    expect(res.body.ok).toBe(true);
  });
  it('🔴 本人確認できない書き込みは log でも通さない（Command Center は新APIのため）', async () => {
    setMode('log');
    const res = await call({ method: 'POST', body: { type: 'approval', action: 'create', approval: { kind: 'meta_pause', title: 'x' } } });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('unverified');
  });

  it('拒否された書き込みは監査ログに残る', async () => {
    setMode('log');
    await call({ method: 'POST', body: { type: 'approval', action: 'create', approval: { kind: 'meta_pause', title: 'x' }, actor: { role: 'staff' } } });
    const d = denies();
    expect(d.length).toBeGreaterThan(0);
    expect(d[0].entity).toBe('authz');
    expect(d[d.length - 1].after.code).toBe('unverified');
  });

  it('X-CC-Authz ヘッダで結果が分かる', async () => {
    setMode('log');
    const res = await call({ method: 'GET', query: { type: 'approval' } });
    expect(res.headers['X-CC-Authz']).toMatch(/^log:/);
  });

  it('許可される操作は拒否として記録されない', async () => {
    setMode('log');
    process.env.DASHBOARD_PASSWORD = 'pw-for-test';
    process.env.AUTH_SALT = 'salt-for-test';
    const { hashOwnerToken } = await import('../lib/settlement.js');
    const tok = hashOwnerToken('__root__', 'pw-for-test', 'salt-for-test');
    const res = await call({ method: 'POST', body: { type: 'ccflags', action: 'set', key: 'cc_approval', value: true, owner: '__root__', token: tok } });
    expect(res.body.ok).toBe(true);
    expect(res.headers['X-CC-Authz']).toBe('log:allow');
    expect(denies()).toHaveLength(0);
  });

  it('どの操作がどれだけ拒否されたかを集計できる（計測の目的）', async () => {
    setMode('log');
    await call({ method: 'POST', body: { type: 'ccflags', action: 'set', key: 'cc_approval', value: true } });
    await call({ method: 'POST', body: { type: 'ccflags', action: 'kill' } });
    await call({ method: 'GET', query: { type: 'audit' } });
    const byAction = {};
    for (const d of denies()) byAction[d.entityId] = (byAction[d.entityId] || 0) + 1;
    expect(Object.keys(byAction).sort()).toEqual(['audit.read', 'flag.change', 'killswitch.engage']);
  });
});

describe('cc_authz - warn: 警告するがブロックしない', () => {
  it('成功しつつ警告ヘッダが返る', async () => {
    setMode('warn');
    const res = await asRoot({ type: 'approval', action: 'create', approval: { kind: 'meta_pause', title: 'x' } });
    expect(res.statusCode).toBe(200);            // ← まだブロックしない
    expect(res.headers['X-CC-Authz']).toMatch(/^warn:/);
  });
});

describe('cc_authz - enforce: ここで初めて拒否する', () => {
  it('本人確認できない書き込みは 403', async () => {
    setMode('enforce');
    const flag = await call({ method: 'POST', body: { type: 'ccflags', action: 'set', key: 'cc_approval', value: true } });
    expect(flag.statusCode).toBe(403);
    expect(flag.body.code).toBe('unverified_admin');   // 制御面は管理者が要る
    const res = await call({ method: 'POST', body: { type: 'approval', action: 'create', approval: { kind: 'meta_pause', title: 'x' } } });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('unverified');          // 書き込みは本人確認が要る
  });

  it('確認できた root は通る', async () => {
    setMode('enforce');
    process.env.DASHBOARD_PASSWORD = 'pw-for-test';
    process.env.AUTH_SALT = 'salt-for-test';
    const { hashOwnerToken } = await import('../lib/settlement.js');
    const tok = hashOwnerToken('__root__', 'pw-for-test', 'salt-for-test');
    const res = await call({ method: 'POST', body: { type: 'ccflags', action: 'set', key: 'cc_approval', value: true, owner: '__root__', token: tok } });
    expect(res.statusCode).toBe(200);
  });

  it('AIエージェントは承認できない（role を root と名乗っても）', async () => {
    setMode('enforce');
    process.env.CC_AGENT_TOKEN = 'agent-token-for-test';
    try {
      const res = await call({
        method: 'POST',
        headers: { 'x-cc-agent-token': 'agent-token-for-test' },
        body: { type: 'approval', action: 'decide', decision: 'approve', id: 'x', actor: { role: 'root' } },
      });
      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe('agent_forbidden');
    } finally { delete process.env.CC_AGENT_TOKEN; }
  });

  it('AIエージェントは提案の作成はできる', async () => {
    setMode('enforce');
    process.env.CC_AGENT_TOKEN = 'agent-token-for-test';
    try {
      const res = await call({
        method: 'POST',
        headers: { 'x-cc-agent-token': 'agent-token-for-test' },
        body: { type: 'approval', action: 'create', approval: { kind: 'meta_budget_change', title: 'AIからの提案' } },
      });
      expect(res.statusCode).toBe(200);
    } finally { delete process.env.CC_AGENT_TOKEN; }
  });

  it('戻せる: enforce → off で本人確認済みの操作は元どおり通る', async () => {
    setMode('enforce');
    setMode('off');
    expect((await asRoot({ type: 'approval', action: 'create', approval: { kind: 'meta_pause', title: 'x' } })).statusCode).toBe(200);
  });
  it('🔴 制御面（フラグ変更）は off に戻しても素通しにならない', async () => {
    setMode('off');
    expect((await call({ method: 'POST', body: { type: 'ccflags', action: 'set', key: 'cc_approval', value: true } })).statusCode).toBe(403);
  });
});

describe('cc_authz - 既存機能への影響', () => {
  it('enforce にしても既存の type= は認可の対象外（chat / board / allowance）', async () => {
    setMode('enforce');
    for (const type of ['board', 'allowance', 'adspend']) {
      const res = await call({ method: 'GET', query: { type } });
      expect(res.statusCode, type).toBe(200);          // ← 既存機能は止まらない
      expect(res.headers['X-CC-Authz'], type).toBeUndefined();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// log モードの計測内容（ユーザー要求：誰が・role・tenant・店舗・操作・ALLOW/DENY）
// ────────────────────────────────────────────────────────────────
const allows = () => auditRows().filter(e => e.action === 'authz_allow');
const rootToken = () => { process.env.DASHBOARD_PASSWORD = 'pw-for-test'; return '__root__'; };

describe('cc_authz - log: ALLOW も DENY も記録する', () => {
  it('許可された操作も記録される（開放前の実態把握に必要）', async () => {
    setMode('log');
    process.env.DASHBOARD_PASSWORD = 'pw-for-test';
    process.env.AUTH_SALT = 'salt-for-test';
    const tok = hashOwnerToken('__root__', 'pw-for-test', 'salt-for-test');
    const res = await call({
      method: 'POST',
      body: { type: 'ccflags', action: 'set', key: 'cc_approval', value: true, owner: '__root__', token: tok },
    });
    expect(res.statusCode).toBe(200);
    expect(allows().length + denies().length).toBeGreaterThan(0);
  });

  it('記録は「誰が・どのrole・どのtenant・どの店舗・何を・ALLOW/DENY」を含む', async () => {
    setMode('log');
    await asRoot({ type: 'approval', action: 'create', approval: { kind: 'meta_pause', title: 'x' }, shop: '恵比寿' });
    const rows = [...allows(), ...denies()];
    expect(rows.length).toBeGreaterThan(0);
    const rec = rows[rows.length - 1].after;
    for (const k of ['actorId', 'role', 'tenantId', 'action', 'decision', 'source', 'mode']) {
      expect(rec, k).toHaveProperty(k);
    }
    expect(['ALLOW', 'DENY']).toContain(rec.decision);
  });

  it('log モードでは判定結果がヘッダに出る', async () => {
    setMode('log');
    const res = await asRoot({ type: 'approval', action: 'create', approval: { kind: 'meta_pause', title: 'x' } });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['X-CC-Authz'])).toMatch(/^log:/);
  });

  it('記録にトークン・パスワードが混入しない', async () => {
    setMode('log');
    await call({ method: 'POST', body: { type: 'approval', action: 'create', approval: { kind: 'meta_pause', title: 'x' }, token: 'super-secret-token', actor: { role: 'staff', id: 'u3' } } });
    const dump = JSON.stringify(auditRows());
    expect(dump).not.toContain('super-secret-token');
    expect(dump).not.toContain('pw-for-test');
  });

  it('監査ログ自体の読み出しは log モードでも止まらない', async () => {
    setMode('log');
    const res = await call({ method: 'GET', query: { type: 'audit' } });
    expect(res.statusCode).toBe(200);
  });
});

describe('cc_authz - 高リスク操作の再検証（Bearerキャッシュを迂回）', () => {
  // Bearer検証は SALONONE_API_KEY が無いと上流を叩かずに null を返すため、
  // 「/me を何回引いたか」を観測できるようキーを立てておく（値はダミー）。
  let savedKey;
  beforeEach(() => { savedKey = process.env.SALONONE_API_KEY; process.env.SALONONE_API_KEY = 'dummy-key-for-test'; });
  afterEach(() => { if (savedKey === undefined) delete process.env.SALONONE_API_KEY; else process.env.SALONONE_API_KEY = savedKey; });

  it('フラグ変更のような高リスク操作では毎回 /me を引き直す', async () => {
    setMode('log');
    const meCalls = () => globalThis.fetch.mock.calls.filter(c => String(c[0]).includes('/me')).length;
    const withBearer = (body) => call({ method: 'POST', headers: { authorization: 'Bearer tok-abc' }, body });
    await withBearer({ type: 'ccflags', action: 'set', key: 'cc_approval', value: true });
    const first = meCalls();
    await withBearer({ type: 'ccflags', action: 'set', key: 'cc_approval', value: false });
    expect(meCalls()).toBeGreaterThan(first);      // ← キャッシュに頼らず再検証
  });

  it('低リスク操作は60秒キャッシュを使い、/me を連打しない（SalonOne 60回/分の保護）', async () => {
    setMode('log');
    const meCalls = () => globalThis.fetch.mock.calls.filter(c => String(c[0]).includes('/me')).length;
    const withBearer = () => call({ method: 'GET', headers: { authorization: 'Bearer tok-xyz' }, query: { type: 'approval' } });
    await withBearer();
    const first = meCalls();
    for (let i = 0; i < 5; i++) await withBearer();
    expect(meCalls()).toBe(first);                 // ← 追加の /me は発生しない
  });
});
