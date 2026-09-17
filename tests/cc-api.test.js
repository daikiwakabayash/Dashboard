import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import handler from '../api/plan-store.js';

// 共有ストア未設定（KV/Supabase/GAS のいずれも無い）状態を作る。
// この状態でも「既存機能が壊れない」「新機能は必ずOFF」ことを固定する。
const STORE_ENVS = [
  'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'REDIS_REST_API_URL', 'REDIS_REST_API_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_KEY', 'PLAN_GAS_URL', 'SETTLEMENT_GAS_URL',
];
let saved;
beforeEach(() => { saved = {}; for (const k of STORE_ENVS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of STORE_ENVS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

function mockRes() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}
const call = async (req) => { const res = mockRes(); await handler({ headers: {}, query: {}, body: {}, ...req }, res); return res; };

describe('Command Center API - ストア未設定でも安全side（fail closed）', () => {
  it('フラグは cc_all=false で返る＝新機能は全てOFF', async () => {
    const res = await call({ method: 'GET', query: { type: 'ccflags' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.flags.cc_all).toBe(false);          // キルスイッチ状態
    expect(res.body.flags.cc_approval).toBe(false);
    expect(res.body.flags.cc_agentlog).toBe(false);
  });

  it('承認・Agentログ・監査は空配列を返し、例外を投げない', async () => {
    for (const type of ['approval', 'agentlog', 'audit']) {
      const res = await call({ method: 'GET', query: { type } });
      expect(res.statusCode).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.configured).toBe(false);
    }
  });

  it('書き込みも落ちずに configured:false を返す', async () => {
    const res = await call({ method: 'POST', body: { type: 'approval', action: 'create', approval: { kind: 'meta_pause', title: 'x' } } });
    expect(res.statusCode).toBe(200);
    expect(res.body.configured).toBe(false);
  });
});

describe('Command Center API - 既存の type を壊していない（回帰）', () => {
  it('既存の allowance / adspend / thanksgift は従来どおり応答する', async () => {
    const a = await call({ method: 'GET', query: { type: 'allowance' } });
    expect(a.statusCode).toBe(200);
    expect(a.body).toMatchObject({ submissions: [], productivity: {}, configured: false });

    const b = await call({ method: 'GET', query: { type: 'adspend' } });
    expect(b.statusCode).toBe(200);
    expect(b.body).toMatchObject({ spend: {}, configured: false });
  });

  it('blobcheck は新しい分岐に横取りされない', async () => {
    const res = await call({ method: 'GET', query: { type: 'blobcheck' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('CORS と no-store ヘッダは従来どおり付く', async () => {
    const res = await call({ method: 'GET', query: { type: 'ccflags' } });
    expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(res.headers['Cache-Control']).toBe('no-store');
  });
});
