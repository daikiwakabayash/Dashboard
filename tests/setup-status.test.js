import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../api/plan-store.js';
import { hashOwnerToken } from '../lib/settlement.js';
import { _clearBearerCache } from '../lib/actor.js';
import fs from 'node:fs';
import path from 'node:path';

const KEYS = ['KNOWLEDGE_GAS_SECRET', 'CRON_SECRET', 'SETTLEMENT_GAS_URL', 'CREATIVE_ASSET_KEY',
  'CREATIVE_GEN_API_BASE', 'CREATIVE_GEN_API_KEY', 'META_READ_API_BASE', 'BLOB_READ_WRITE_TOKEN',
  'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'DASHBOARD_PASSWORD', 'AUTH_SALT', 'KV_REST_API_URL'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.DASHBOARD_PASSWORD = 'pw-for-test';
  process.env.AUTH_SALT = 'salt-for-test';
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), headers: new Map() }));
  _clearBearerCache();
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.restoreAllMocks();
});
function mockRes() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; }; r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; }; r.end = () => r; return r;
}
const ROOT = () => ({ host: 'test.local', 'x-cc-owner': '__root__', 'x-cc-token': hashOwnerToken('__root__', 'pw-for-test', 'salt-for-test') });
const call = async (headers) => { const res = mockRes(); await handler({ method: 'GET', headers, query: { type: 'setupstatus' } }, res); return res; };
const itemOf = (body, key) => (body.items || []).find(x => x.key === key);

describe('設定状況', () => {
  it('🔴 未ログインには返さない', async () => {
    const r = await call({ host: 'x' });
    expect(r.statusCode).toBe(403);
    expect(r.body.items).toBeUndefined();
  });
  it('ログイン済みなら、どの設定が済んでいるかが分かる', async () => {
    const r = await call(ROOT());
    expect(r.body.ok).toBe(true);
    expect((r.body.items || []).length).toBeGreaterThanOrEqual(8);
    expect(itemOf(r.body, 'CREATIVE_ASSET_KEY')).toMatchObject({ set: false, ok: false });
  });
  it('🔴 値そのものを返さない（秘密を画面へ出さない）', async () => {
    process.env.CREATIVE_ASSET_KEY = 'super-secret-master-key-0123456789abcd';
    process.env.CRON_SECRET = 'cron-secret-value-123';
    process.env.SETTLEMENT_GAS_URL = 'https://script.google.com/macros/s/AKfycbSECRET/exec';
    const r = await call(ROOT());
    const s = JSON.stringify(r.body);
    expect(s).not.toContain('super-secret-master-key');
    expect(s).not.toContain('cron-secret-value');
    expect(s).not.toContain('AKfycbSECRET');
  });
  it('🔴 短すぎる鍵は「済み」にしない', async () => {
    process.env.CREATIVE_ASSET_KEY = 'short';
    const r = await call(ROOT());
    expect(itemOf(r.body, 'CREATIVE_ASSET_KEY')).toMatchObject({ set: true, ok: false });
    expect(itemOf(r.body, 'CREATIVE_ASSET_KEY').note).toContain('32文字以上');
  });
  it('十分な長さなら「済み」になる', async () => {
    process.env.CREATIVE_ASSET_KEY = 'x'.repeat(40);
    expect(itemOf((await call(ROOT())).body, 'CREATIVE_ASSET_KEY').ok).toBe(true);
  });
  it('🔴 GASのURLは形が正しいときだけ「済み」にする', async () => {
    process.env.SETTLEMENT_GAS_URL = 'https://example.com/not-gas';
    expect(itemOf((await call(ROOT())).body, 'SETTLEMENT_GAS_URL')).toMatchObject({ set: true, ok: false });
    process.env.SETTLEMENT_GAS_URL = 'https://script.google.com/macros/s/AAA/exec';
    expect(itemOf((await call(ROOT())).body, 'SETTLEMENT_GAS_URL').ok).toBe(true);
  });
  it('通知は公開鍵と秘密鍵の両方がそろって「済み」', async () => {
    process.env.VAPID_PUBLIC_KEY = 'pub';
    expect(itemOf((await call(ROOT())).body, 'VAPID_PUBLIC_KEY').ok).toBe(false);
    process.env.VAPID_PRIVATE_KEY = 'priv';
    expect(itemOf((await call(ROOT())).body, 'VAPID_PUBLIC_KEY').ok).toBe(true);
  });
  it('何のために必要かが書いてある', async () => {
    const r = await call(ROOT());
    for (const it of r.body.items) expect(it.enables, it.key).toBeTruthy();
    expect(itemOf(r.body, 'CREATIVE_ASSET_KEY').warn).toContain('開けなくなります');
  });
});

describe('🔴 画面があるフラグは、必ずオーナー設定に出す', () => {
  // 一覧から漏れると、メニューがフラグOFFで隠れているのに ON にする手段が無くなる
  const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  const list = html.slice(html.indexOf("['cc_approval', '承認センター'"), html.indexOf("].map(([k, label, note])"));
  it('画面つきのフラグが全部そろっている', () => {
    for (const k of ['cc_approval', 'cc_agentlog', 'cc_ai_trial', 'cc_creative_library', 'cc_home']) {
      expect(list, k).toContain(`'${k}'`);
    }
  });
  it('メニューに出す条件とフラグ名が一致している', () => {
    // メニュー項目は flag: を持ち、canShow がそれを見て出し分ける
    for (const k of ['cc_creative_library', 'cc_home', 'cc_approval', 'cc_agentlog', 'cc_ai_trial']) {
      expect(html, k).toContain(`flag: '${k}'`);
    }
    expect(html).toContain("(!it.flag || ccFlagOn(it.flag))");
  });
  it('設定が要るフラグには、その注意が書いてある', () => {
    expect(list).toContain('CREATIVE_ASSET_KEY');
  });
});
