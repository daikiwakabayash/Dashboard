// ── 業務AIの回答の受け皿（?type=aianswer）のサーバー側検証 ──────────────
// 正本の契約は naoru-ai-platform/AGENTS.md §3。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../api/plan-store.js';
import { hashOwnerToken } from '../lib/settlement.js';
import { _clearBearerCache } from '../lib/actor.js';

const KV = 'https://kv.test';
let store;
function installFetchMock() {
  store = new Map();
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    const ok = (b) => ({ ok: true, status: 200, json: async () => b, headers: new Map() });
    if (u.startsWith(`${KV}/get/`)) { const k = decodeURIComponent(u.slice(`${KV}/get/`.length)); return ok({ result: store.has(k) ? store.get(k) : null }); }
    if (u.startsWith(`${KV}/set/`)) { store.set(decodeURIComponent(u.slice(`${KV}/set/`.length)), String(opts.body)); return ok({ result: 'OK' }); }
    if (u === KV) {
      const cmd = JSON.parse(opts.body);
      if (cmd[0] === 'MGET') return ok({ result: cmd.slice(1).map(k => (store.has(k) ? store.get(k) : null)) });
    }
    return ok({});
  });
}
let saved;
beforeEach(() => {
  saved = { u: process.env.KV_REST_API_URL, t: process.env.KV_REST_API_TOKEN, d: process.env.DASHBOARD_PASSWORD,
            s: process.env.AUTH_SALT, a: process.env.CC_AGENT_TOKEN, e: process.env.CC_ENV, o: process.env.SETTLEMENT_OWNER_PASSWORDS };
  process.env.KV_REST_API_URL = KV; process.env.KV_REST_API_TOKEN = 'test-token-not-a-secret';
  process.env.DASHBOARD_PASSWORD = 'pw-for-test'; process.env.AUTH_SALT = 'salt-for-test';
  process.env.CC_AGENT_TOKEN = 'agent-token-not-a-secret';
  process.env.CC_ENV = 'test';
  process.env.SETTLEMENT_OWNER_PASSWORDS = JSON.stringify({ '鶴見院オーナー': 'shop-pw' });
  installFetchMock(); _clearBearerCache();
});
afterEach(() => {
  for (const [k, v] of [['KV_REST_API_URL', saved.u], ['KV_REST_API_TOKEN', saved.t], ['DASHBOARD_PASSWORD', saved.d],
                        ['AUTH_SALT', saved.s], ['CC_AGENT_TOKEN', saved.a], ['CC_ENV', saved.e], ['SETTLEMENT_OWNER_PASSWORDS', saved.o]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  vi.restoreAllMocks();
});
function mockRes() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; }; r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; }; r.end = () => r; return r;
}
const ROOT = () => ({ 'x-cc-owner': '__root__', 'x-cc-token': hashOwnerToken('__root__', 'pw-for-test', 'salt-for-test') });
const AGENT = () => ({ 'x-cc-agent-token': 'agent-token-not-a-secret' });
const SHOP = () => ({ 'x-cc-owner': encodeURIComponent('鶴見院オーナー'), 'x-cc-token': hashOwnerToken('鶴見院オーナー', 'shop-pw', 'salt-for-test') });
const call = async (req) => { const res = mockRes(); await handler({ headers: ROOT(), query: {}, body: {}, ...req }, res); return res; };
const put = (answer, hdr) => call({ method: 'POST', headers: hdr || AGENT(), body: { type: 'aianswer', action: 'put', answer } });
const getFor = (q, hdr) => call({ method: 'GET', headers: hdr || ROOT(), query: { type: 'aianswer', ...q } });
const raw = () => JSON.parse(store.get('naoru:cc:aianswer:v1:test') || 'null');

const cite = { id: 'c1', label: 'SalonOne 売上', version: 'v3', current: true };
const fact = (o = {}) => ({ text: '新規が伸びた', value: 120, unit: '人', period: '2026-09',
  defVersion: 'agg-v2', citationIds: ['c1'], origin: 'source', ...o });

describe('誰が入れられるか', () => {
  it('サーバー間のトークンなら入れられる', async () => {
    const r = await put({ agent: 'marketing', status: 'completed', citations: [cite], facts: [fact()] });
    expect(r.body.ok).toBe(true);
    expect(raw().marketing.facts).toHaveLength(1);
    expect(raw().marketing.receivedFrom).toBe('agent');
  });
  it('root も入れられる', async () => {
    const r = await put({ agent: 'chief', status: 'completed', citations: [cite], facts: [fact()] }, ROOT());
    expect(r.body.ok).toBe(true);
    expect(raw().chief.receivedFrom).toBe('root');
  });
  it('🔴 画面から名乗るだけでは入れられない', async () => {
    const r = await put({ agent: 'marketing', status: 'completed', facts: [fact()] }, SHOP());
    expect(r.statusCode).toBe(403);
    expect(raw()).toBe(null);
  });
  it('🔴 未ログインは受け付けない', async () => {
    const r = await call({ method: 'POST', headers: {}, body: { type: 'aianswer', action: 'put', answer: { agent: 'chief' } } });
    expect(r.statusCode).toBe(403);
  });
  it('知らない担当は受け付けない（勝手に割り当てない）', async () => {
    const r = await put({ agent: 'よその人', status: 'completed' });
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('unknown_agent');
  });
});

describe('🔴 保存の時点で、出典の無い主張を事実から外す', () => {
  it('出典が無い主張は仮説へ落ち、経緯が残る', async () => {
    const r = await put({ agent: 'marketing', status: 'completed', citations: [cite],
      facts: [fact(), fact({ text: '根拠なし', citationIds: [] })] });
    expect(r.body.ok).toBe(true);
    expect(raw().marketing.facts).toHaveLength(1);
    expect(raw().marketing.hypotheses.map(h => h.text)).toContain('根拠なし');
    expect(r.body.demoted).toEqual([{ text: '根拠なし', reason: 'no_citation' }]);
  });
  it('AIが作った値は実績にならない', async () => {
    const r = await put({ agent: 'marketing', status: 'completed', citations: [cite], facts: [fact({ origin: 'model' })] });
    expect(raw().marketing.facts).toHaveLength(0);
    expect(r.body.demoted[0].reason).toBe('model_generated');
  });
  it('citations に無い出典IDを名乗っても事実にしない', async () => {
    await put({ agent: 'marketing', status: 'completed', citations: [cite], facts: [fact({ citationIds: ['にせもの'] })] });
    expect(raw().marketing.facts).toHaveLength(0);
  });
  it('対象期間・単位・集計定義版が欠けた数値は事実にしない', async () => {
    await put({ agent: 'marketing', status: 'completed', citations: [cite], facts: [fact({ period: '' })] });
    expect(raw().marketing.facts).toHaveLength(0);
  });
  it('未取得を 0 で埋めない', async () => {
    await put({ agent: 'marketing', status: 'completed', citations: [cite],
      facts: [fact({ value: null })], missing_data: ['広告費'] });
    expect(raw().marketing.facts[0].value).toBe(null);
    expect(raw().marketing.missingData).toEqual(['広告費']);
  });
  it('知らないキーを保存しない', async () => {
    await put({ agent: 'chief', status: 'completed', citations: [cite], facts: [fact()], こっそり: 'x' });
    expect(Object.keys(raw().chief)).not.toContain('こっそり');
  });
});

describe('読み出し', () => {
  it('画面ごとに引ける', async () => {
    await put({ agent: 'marketing', status: 'completed', citations: [cite], facts: [fact()] });
    await put({ agent: 'chief', status: 'completed', citations: [cite], facts: [fact()] });
    const r = await getFor({ screen: 'home' });
    expect(r.body.answers.map(a => a.agent)).toEqual(['chief']);
  });
  it('担当ごとに引ける', async () => {
    await put({ agent: 'marketing', status: 'completed', citations: [cite], facts: [fact()] });
    const r = await getFor({ agent: 'marketing' });
    expect(r.body.answers).toHaveLength(1);
  });
  it('まだ無ければ空（それらしい回答を作らない）', async () => {
    const r = await getFor({ screen: 'home' });
    expect(r.body.answers).toEqual([]);
  });
  it('🔴 未ログインには返さない', async () => {
    const r = await call({ method: 'GET', headers: {}, query: { type: 'aianswer', screen: 'home' } });
    expect(r.statusCode).toBe(403);
  });
  it('知らない担当は 400', async () => {
    const r = await getFor({ agent: 'よその人' });
    expect(r.statusCode).toBe(400);
  });
});

describe('消す', () => {
  it('root だけが消せる', async () => {
    await put({ agent: 'chief', status: 'completed', citations: [cite], facts: [fact()] });
    const ng = await call({ method: 'POST', headers: SHOP(), body: { type: 'aianswer', action: 'clear', agent: 'chief' } });
    expect(ng.statusCode).toBe(403);
    const ok = await call({ method: 'POST', headers: ROOT(), body: { type: 'aianswer', action: 'clear', agent: 'chief' } });
    expect(ok.body.ok).toBe(true);
    expect(raw().chief).toBe(undefined);
  });
});

describe('環境ごとに分ける', () => {
  it('本番と検証で保存先が混ざらない', async () => {
    await put({ agent: 'chief', status: 'completed', citations: [cite], facts: [fact()] });
    expect(store.has('naoru:cc:aianswer:v1:test')).toBe(true);
    expect(store.has('naoru:cc:aianswer:v1')).toBe(false);
  });
});
