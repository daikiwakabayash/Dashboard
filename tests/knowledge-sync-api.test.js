import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../api/plan-store.js';
import { _clearBearerCache } from '../lib/actor.js';
import { hashOwnerToken } from '../lib/settlement.js';
import { kvEvalFake } from './helpers/kv-fake.js';

// ナレッジ資料の自動更新（Googleシート/スライド/ドキュメント → 1日1回取り直し）。
// 取得は既存の Apps Script に任せる。Dashboard 側に新しい資格情報を持たない。
const KV = 'https://kv.test';
const GAS = 'https://script.google.com/macros/s/testonly/exec';
const KNOW = 'naoru:knowledge:v1';
const SHEET = 'https://docs.google.com/spreadsheets/d/1AAAAAAAAAAAAAAAAAAAAAAAA/edit';
const SLIDE = 'https://docs.google.com/presentation/d/1BBBBBBBBBBBBBBBBBBBBBBBB/edit';

let store, gasCalls, gasReply;

function installFetchMock() {
  store = new Map(); gasCalls = [];
  gasReply = () => ({ ok: true, title: '最新タイトル', body: '新しい中身です。\nここが変わりました。' });
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    const ok = (b) => ({ ok: true, status: 200, json: async () => b, headers: new Map() });
    if (u.startsWith(`${KV}/get/`)) {
      const k = decodeURIComponent(u.slice(`${KV}/get/`.length));
      return ok({ result: store.has(k) ? store.get(k) : null });
    }
    if (u.startsWith(`${KV}/set/`)) { store.set(decodeURIComponent(u.slice(`${KV}/set/`.length)), String(opts.body)); return ok({ result: 'OK' }); }
    if (u === KV) {
      const cmd = JSON.parse(opts.body);
      if (cmd[0] === 'MGET') return ok({ result: cmd.slice(1).map(k => (store.has(k) ? store.get(k) : null)) });
      const fake = kvEvalFake(store, cmd);
      if (fake) return ok(fake);
    }
    if (u.startsWith(GAS)) {
      const payload = opts.body ? JSON.parse(String(opts.body)) : {};
      gasCalls.push(payload);
      return ok(gasReply(payload));
    }
    return ok({});
  });
}

let saved;
beforeEach(() => {
  saved = { u: process.env.KV_REST_API_URL, t: process.env.KV_REST_API_TOKEN, e: process.env.VERCEL_ENV,
            d: process.env.DASHBOARD_PASSWORD, s: process.env.AUTH_SALT, g: process.env.PLAN_GAS_URL,
            c: process.env.CRON_SECRET };
  process.env.KV_REST_API_URL = KV;
  process.env.KV_REST_API_TOKEN = 'test-token-not-a-secret';
  process.env.VERCEL_ENV = 'preview';
  process.env.DASHBOARD_PASSWORD = 'pw-for-test';
  process.env.AUTH_SALT = 'salt-for-test';
  process.env.PLAN_GAS_URL = GAS;
  delete process.env.CRON_SECRET;
  installFetchMock();
  _clearBearerCache();
  store.set(KNOW, JSON.stringify({ docs: [
    { id: 'd_sheet', title: '料金表', body: '前の中身', source: SHEET, autoSync: true },
    { id: 'd_slide', title: '研修資料', body: '前のスライド', source: SLIDE, autoSync: true },
    { id: 'd_off',   title: '手動だけ', body: '触らない', source: SHEET, autoSync: false },
    { id: 'd_free',  title: '議事録',   body: '文字起こし', source: '2026-09 定例MTG' },
  ] }));
});
afterEach(() => {
  for (const [k, v] of [['KV_REST_API_URL', saved.u], ['KV_REST_API_TOKEN', saved.t], ['VERCEL_ENV', saved.e],
                        ['DASHBOARD_PASSWORD', saved.d], ['AUTH_SALT', saved.s], ['PLAN_GAS_URL', saved.g],
                        ['CRON_SECRET', saved.c]]) {
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
const call = async (req) => { const res = mockRes(); await handler({ headers: { host: 'test.local' }, query: {}, body: {}, ...req }, res); return res; };
const ROOT = () => ({ host: 'test.local', 'x-cc-owner': '__root__', 'x-cc-token': hashOwnerToken('__root__', 'pw-for-test', 'salt-for-test') });
const docs = () => { try { return JSON.parse(store.get(KNOW) || '{}').docs || []; } catch { return []; } };
const byId = (id) => docs().find(d => d && d.id === id) || null;
const syncNow = (over = {}) => call({ method: 'POST', headers: ROOT(), body: { type: 'knowledge', action: 'sync', ...over } });

describe('手動「いま取り直す」（action=sync）', () => {
  it('ログインしていないと 403（社内資料なので誰でも動かせない）', async () => {
    const res = await call({ method: 'POST', body: { type: 'knowledge', action: 'sync' } });
    expect(res.statusCode).toBe(403);
    expect(gasCalls).toHaveLength(0);
  });

  it('自動更新ONかつGoogleのURLの資料だけを取り直す', async () => {
    const res = await syncNow();
    expect(res.body.ok).toBe(true);
    expect(res.body.checked).toBe(2);
    expect(gasCalls.map(c => c.action)).toEqual(['readKnowledgeDoc', 'readKnowledgeDoc']);
    const kinds = gasCalls.map(c => c.kind).sort();
    expect(kinds).toEqual(['presentation', 'spreadsheet']);
    // 自動更新OFF・Google以外のURLは触らない
    expect(byId('d_off').body).toBe('触らない');
    expect(byId('d_free').body).toBe('文字起こし');
  });

  it('中身が変わったら本文を差し替え、「更新あり（未確認）」を立てる', async () => {
    const res = await syncNow();
    expect(res.body.updated).toBe(2);
    const d = byId('d_sheet');
    expect(d.body).toBe('新しい中身です。\nここが変わりました。');
    expect(d.sync.needsReview).toBe(true);
    expect(Array.isArray(d.revisions)).toBe(true);
    expect(d.revisions[0].previousBody).toBe('前の中身');   // 直前の本文を履歴に残す
  });

  it('中身が同じなら本文も履歴も増やさない（毎日「更新あり」にならない）', async () => {
    await syncNow();
    const before = byId('d_sheet');
    const res = await syncNow();
    expect(res.body.updated).toBe(0);
    const after = byId('d_sheet');
    expect(after.body).toBe(before.body);
    expect((after.revisions || []).length).toBe((before.revisions || []).length);
  });

  it('取得に失敗しても前の本文は消さない（AIの回答材料が消えない）', async () => {
    gasReply = () => ({ ok: false, error: '権限がありません' });
    const res = await syncNow();
    expect(res.body.failed).toBe(2);
    expect(res.body.updated).toBe(0);
    const d = byId('d_sheet');
    expect(d.body).toBe('前の中身');
    expect(d.sync.lastError).toBeTruthy();
  });

  it('取得できても中身が空なら前の本文を残す', async () => {
    gasReply = () => ({ ok: true, body: '   \n  ' });
    const res = await syncNow();
    expect(res.body.updated).toBe(0);
    expect(res.body.failed).toBe(2);
    expect(byId('d_sheet').body).toBe('前の中身');
  });

  it('Apps Script が未設定なら、理由を返して資料は触らない', async () => {
    delete process.env.PLAN_GAS_URL; delete process.env.SETTLEMENT_GAS_URL;
    const res = await syncNow();
    expect(res.body.configured).toBe(false);
    expect(String(res.body.reason)).toContain('Apps Script');
    expect(byId('d_sheet').body).toBe('前の中身');
  });
});

describe('「確認しました」（action=reviewed）', () => {
  it('未確認の印だけを外し、本文と履歴は残す', async () => {
    await syncNow();
    expect(byId('d_sheet').sync.needsReview).toBe(true);
    const res = await call({ method: 'POST', headers: ROOT(), body: { type: 'knowledge', action: 'reviewed', id: 'd_sheet' } });
    expect(res.body.ok).toBe(true);
    const d = byId('d_sheet');
    expect(d.sync.needsReview).toBe(false);
    expect(d.body).toBe('新しい中身です。\nここが変わりました。');
    expect(d.revisions.length).toBe(1);
    // もう一方は未確認のまま（1件ずつ確認できる）
    expect(byId('d_slide').sync.needsReview).toBe(true);
  });

  it('ログインしていないと 403', async () => {
    const res = await call({ method: 'POST', body: { type: 'knowledge', action: 'reviewed', id: 'd_sheet' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('画面からの編集で自動更新の情報が消えない', () => {
  it('update で保存しても sync / revisions / autoSync が残る', async () => {
    await syncNow();
    const d = byId('d_sheet');
    await call({ method: 'POST', headers: ROOT(), body: { type: 'knowledge', action: 'update',
      doc: { id: 'd_sheet', title: '料金表（改）', body: d.body, source: SHEET, autoSync: true, sync: d.sync, revisions: d.revisions } } });
    const after = byId('d_sheet');
    expect(after.title).toBe('料金表（改）');
    expect(after.sync.needsReview).toBe(true);
    expect(after.revisions.length).toBe(1);
    expect(after.autoSync).toBe(true);
  });

  it('自動更新のチェックを外すと、次から取り直さない', async () => {
    const d = byId('d_sheet');
    await call({ method: 'POST', headers: ROOT(), body: { type: 'knowledge', action: 'update',
      doc: { id: 'd_sheet', title: d.title, body: d.body, source: SHEET, autoSync: false } } });
    const res = await syncNow();
    expect(res.body.checked).toBe(1);
    expect(byId('d_sheet').body).toBe('前の中身');
  });
});

describe('日次Cron（GET action=cronsync）', () => {
  // Vercel は CRON_SECRET を設定しておくと、Cron の呼び出しに Authorization: Bearer <秘密> を付ける。
  // これが「cron という実行者」として扱われる（lib/actor.js）。
  const CRON = { host: 'test.local', authorization: 'Bearer cron-secret-for-test' };

  it('CRON_SECRET が一致する GET は、人がログインしていなくても動く', async () => {
    process.env.CRON_SECRET = 'cron-secret-for-test';
    const res = await call({ method: 'GET', headers: CRON, query: { type: 'knowledge', action: 'cronsync' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.updated).toBe(2);
    expect(byId('d_sheet').sync.needsReview).toBe(true);   // 自動反映だが「更新あり」は残す
  });

  it('CRON_SECRET が合っていないと動かない（資料は書き換わらない・GASも叩かない）', async () => {
    process.env.CRON_SECRET = 'cron-secret-for-test';
    const res = await call({ method: 'GET', headers: { host: 'test.local', authorization: 'Bearer wrong' }, query: { type: 'knowledge', action: 'cronsync' } });
    expect([401, 403]).toContain(res.statusCode);
    expect(gasCalls).toHaveLength(0);
    expect(byId('d_sheet').body).toBe('前の中身');
  });

  it('CRON_SECRET が未設定なら、ログインしていない Cron は 403（環境変数の欠落で社内資料が開かない）', async () => {
    delete process.env.CRON_SECRET;
    const res = await call({ method: 'GET', headers: { host: 'test.local' }, query: { type: 'knowledge', action: 'cronsync' } });
    expect(res.statusCode).toBe(403);
    expect(gasCalls).toHaveLength(0);
  });

  it('ログイン済みの本部は、Cron を待たずに GET でも取り直せる', async () => {
    delete process.env.CRON_SECRET;
    const res = await call({ method: 'GET', headers: ROOT(), query: { type: 'knowledge', action: 'cronsync' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.updated).toBe(2);
  });

  it('CRON_SECRET が設定済みでも、ログイン済み本部の手動 sync はそのまま通る', async () => {
    process.env.CRON_SECRET = 'cron-secret-for-test';
    const res = await syncNow();
    expect(res.body.ok).toBe(true);
    expect(res.body.updated).toBe(2);
  });
});
