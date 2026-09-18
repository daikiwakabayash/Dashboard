import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../api/plan-store.js';
import { _clearBearerCache } from '../lib/actor.js';
import { hashOwnerToken } from '../lib/settlement.js';
import { kvEvalFake } from './helpers/kv-fake.js';

// ニュースの閲覧・リアクション状況。人数は対象者へ、氏名の一覧は本部の管理者と投稿者だけ。
const KV = 'https://kv.test';
const BOARD = 'naoru:board:v1';
const PR = 'naoru:board:pr:p1';
let store;

const AUD = [
  { id: 'a', name: '青木', shop: 'NAORU 鶴見院' },
  { id: 'b', name: '石田', shop: 'NAORU 関内院' },
  { id: 'c', name: '上野', shop: 'NAORU 仙台院' },
];

function installFetchMock() {
  store = new Map();
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
    return ok({});
  });
}

let saved;
beforeEach(() => {
  saved = { u: process.env.KV_REST_API_URL, t: process.env.KV_REST_API_TOKEN, e: process.env.VERCEL_ENV,
            d: process.env.DASHBOARD_PASSWORD, s: process.env.AUTH_SALT };
  process.env.KV_REST_API_URL = KV;
  process.env.KV_REST_API_TOKEN = 'test-token-not-a-secret';
  process.env.VERCEL_ENV = 'preview';
  process.env.DASHBOARD_PASSWORD = 'pw-for-test';
  process.env.AUTH_SALT = 'salt-for-test';
  installFetchMock();
  _clearBearerCache();
  store.set(BOARD, JSON.stringify({ posts: [
    { id: 'p1', authorId: 'hq1', authorName: '本部', title: '沖縄セミナー', text: '開催します',
      reactions: { '👍': ['a'] }, comments: [], createdAt: '2026-09-18T01:00:00.000Z' },
  ] }));
});
afterEach(() => {
  for (const [k, v] of [['KV_REST_API_URL', saved.u], ['KV_REST_API_TOKEN', saved.t], ['VERCEL_ENV', saved.e],
                        ['DASHBOARD_PASSWORD', saved.d], ['AUTH_SALT', saved.s]]) {
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
const pr = () => { try { return JSON.parse(store.get(PR) || '{}'); } catch { return {}; } };
const readPost = (staffId, over = {}) => call({ method: 'POST', headers: ROOT(), body: { type: 'board', action: 'readpost', id: 'p1', staffId, ...over } });
const status = (headers = ROOT()) => call({ method: 'POST', headers, body: { type: 'board', action: 'status', id: 'p1', audience: AUD } });

describe('記事を表示できたときだけ既読を記録する', () => {
  it('readpost で投稿ごとの既読が入る', async () => {
    expect((await readPost('a')).body.ok).toBe(true);
    expect(Object.keys(pr().r)).toEqual(['a']);
  });
  it('⚠️ 投稿本体を書き換えない（既読で記事を踏み潰さない）', async () => {
    const before = store.get(BOARD);
    await readPost('a');
    expect(store.get(BOARD)).toBe(before);
  });
  it('⚠️ 既存の未読バッジ（最後に見た時刻）とは別のキーに書く', async () => {
    await readPost('a');
    expect(store.has('naoru:board:reads:v1')).toBe(false);
    expect(store.has(PR)).toBe(true);
  });
  it('何人が同時に読んでも、お互いの記録を消さない', async () => {
    await Promise.all(['a', 'b', 'c'].map(id => readPost(id)));
    expect(Object.keys(pr().r).sort()).toEqual(['a', 'b', 'c']);
  });
  it('最初に読めた時刻を残す（あとから上書きしない）', async () => {
    await readPost('a', { ts: 1000 });
    await readPost('a', { ts: 9999 });
    expect(pr().r.a).toBe(1000);
  });
});

describe('「確認しました」', () => {
  it('ack は既読とは別に入る', async () => {
    await call({ method: 'POST', headers: ROOT(), body: { type: 'board', action: 'ack', id: 'p1', staffId: 'a', ts: 5000 } });
    expect(pr().a).toEqual({ a: 5000 });
    expect(pr().r.a).toBe(5000);
  });
  it('既読だけでは ack は付かない', async () => {
    await readPost('b');
    expect(pr().a).toEqual({});
  });
});

describe('状況一覧', () => {
  it('人数が合う（既読・未読・リアクション）', async () => {
    await readPost('a'); await readPost('b');
    const res = await status();
    expect(res.body.total).toBe(3);
    expect(res.body.counts).toMatchObject({ read: 2, unread: 1, reacted: 1, notReacted: 2, acked: 0 });
  });
  it('「未リアクションには未読も含む」の注記が返る', async () => {
    expect((await status()).body.note).toContain('まだ読んでいない人も含まれます');
  });
  it('本部の管理者には氏名の一覧が返る', async () => {
    await readPost('a');
    const res = await status();
    expect(res.body.detail).toBe(true);
    expect(res.body.people.unread.map(p => p.name).sort()).toEqual(['上野', '石田']);
  });
  it('⚠️ 権限のない人には氏名の一覧を返さない（人数だけ）', async () => {
    const res = await status({ host: 'test.local' });    // 未ログイン
    expect([200, 403]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      expect(res.body.detail).toBe(false);
      expect(res.body.people).toBeUndefined();
    }
  });
  it('存在しない投稿は 404', async () => {
    const res = await call({ method: 'POST', headers: ROOT(), body: { type: 'board', action: 'status', id: 'zzz', audience: AUD } });
    expect(res.statusCode).toBe(404);
  });
  it('対象外になった人の記録は分母に入れず、件数だけ返す', async () => {
    await readPost('退職者');
    const res = await status();
    expect(res.body.total).toBe(3);
    expect(res.body.counts.read).toBe(0);
    expect(res.body.outOfAudience).toBe(1);
  });
  it('⚠️ 取れていない時刻を作らない（未読の人は時刻なし）', async () => {
    await readPost('a');
    const res = await status();
    expect(res.body.people.unread.every(p => p.at === null)).toBe(true);
    expect(res.body.people.read[0].at).toBeGreaterThan(0);
  });
});

describe('ニュースの新しい項目（カテゴリー・公開対象・確認要否・期限・ピックアップ・表紙）', () => {
  const post = (over = {}) => call({ method: 'POST', headers: ROOT(), body: { type: 'board', action: 'post',
    post: { clientId: `c${Math.random()}`, authorId: 'hq1', authorName: '本部', title: 'T', text: '本文', ...over } } });
  const posts = () => { try { return JSON.parse(store.get(BOARD) || '{}').posts || []; } catch { return []; } };

  it('項目が保存される', async () => {
    const r = await post({ category: 'event', needsAck: true, dueDate: '2026-10-01', featured: true,
      imgIds: ['i1', 'i2'], coverImgId: 'i2', audience: { kind: 'shops', shops: ['NAORU 鶴見院'] } });
    expect(r.body.ok).toBe(true);
    const p = posts().find(x => x.title === 'T');
    expect(p).toMatchObject({ category: 'event', needsAck: true, dueDate: '2026-10-01', featured: true, coverImgId: 'i2' });
    expect(p.audience).toEqual({ kind: 'shops', shops: ['NAORU 鶴見院'] });
  });

  it('⚠️ 既存の投稿には既定値を書き込まない', async () => {
    const before = posts().find(x => x.id === 'p1');
    expect(before.category).toBeUndefined();
    await post({ category: 'rule' });
    expect(posts().find(x => x.id === 'p1').category).toBeUndefined();
  });

  it('知らないカテゴリー・不正な期限・添付に無い表紙は落とす', async () => {
    await post({ title: 'T2', category: 'zzz', dueDate: 'あした', imgIds: ['i1'], coverImgId: 'nope' });
    const p = posts().find(x => x.title === 'T2');
    expect(p).toMatchObject({ category: '', dueDate: '', coverImgId: '' });
  });

  it('⚠️ 状況一覧の分母は公開対象に合わせる', async () => {
    await post({ title: 'T3', audience: { kind: 'shops', shops: ['NAORU 鶴見院'] } });
    const id = posts().find(x => x.title === 'T3').id;
    const res = await call({ method: 'POST', headers: ROOT(), body: { type: 'board', action: 'status', id,
      audience: [{ id: 'a', name: '青木', shop: 'NAORU 鶴見院' }, { id: 'b', name: '石田', shop: 'NAORU 仙台院' }] } });
    expect(res.body.total).toBe(1);                       // 鶴見の1人だけ
    expect(res.body.people.unread.map(p => p.name)).toEqual(['青木']);
  });

  it('全員向けの記事は全員が分母', async () => {
    const res = await call({ method: 'POST', headers: ROOT(), body: { type: 'board', action: 'status', id: 'p1',
      audience: [{ id: 'a', name: '青木', shop: 'X' }, { id: 'b', name: '石田', shop: 'Y' }] } });
    expect(res.body.total).toBe(2);
  });

  it('ピックアップを後から切り替えられる（本部・投稿者のみ）', async () => {
    const ok = await call({ method: 'POST', headers: ROOT(), body: { type: 'board', action: 'feature', id: 'p1', featured: true } });
    expect(ok.body.ok).toBe(true);
    expect(posts().find(x => x.id === 'p1').featured).toBe(true);
  });

  it('⚠️ 権限がなければピックアップを変えられない', async () => {
    const res = await call({ method: 'POST', headers: { host: 'test.local' }, body: { type: 'board', action: 'feature', id: 'p1', featured: true } });
    expect([403]).toContain(res.statusCode);
  });
});
