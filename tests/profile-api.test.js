import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../api/plan-store.js';
import { _clearBearerCache } from '../lib/actor.js';
import { hashOwnerToken } from '../lib/settlement.js';
import { kvEvalFake } from './helpers/kv-fake.js';

// プロフィール: 自己紹介の項目と、編集してよい人の判定。
const KV = 'https://kv.test';
const PK = 'naoru:profile:v1';
let store;

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
  store.set(PK, JSON.stringify({ profiles: { s9: { pid: 's9', nameKanji: '他人', bio: 'もとの文' } }, hidden: [] }));
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
const profiles = () => { try { return JSON.parse(store.get(PK) || '{}').profiles || {}; } catch { return {}; } };
const save = (pid, profile, headers = ROOT(), extra = {}) =>
  call({ method: 'POST', headers, body: { type: 'profile', action: 'save', pid, profile, ...extra } });

describe('自己紹介の項目を保存できる', () => {
  it('ひとこと・得意・学びたい・趣味が保存される', async () => {
    const res = await save('s1', { nameKanji: '青木', oneLine: '産後ケアが得意です',
      goodAt: ['骨盤矯正', '産後ケア'], learning: ['栄養'], hobbies: ['サウナ', 'キャンプ'] });
    expect(res.body.ok).toBe(true);
    expect(profiles().s1).toMatchObject({
      oneLine: '産後ケアが得意です', goodAt: ['骨盤矯正', '産後ケア'], learning: ['栄養'], hobbies: ['サウナ', 'キャンプ'],
    });
  });
  it('既存の項目（写真・自己紹介文・店舗）は残る', async () => {
    await save('s1', { nameKanji: '青木', bio: '長い自己紹介', mainImg: 'img1', shops: ['NAORU 鶴見院'], oneLine: 'ひとこと' });
    expect(profiles().s1).toMatchObject({ nameKanji: '青木', bio: '長い自己紹介', mainImg: 'img1', shops: ['NAORU 鶴見院'] });
  });
  it('空でも保存できる（写真も自己紹介も任意）', async () => {
    await save('s1', { nameKanji: '青木' });
    expect(profiles().s1).toMatchObject({ oneLine: '', goodAt: [], learning: [], hobbies: [] });
  });
  it('タグの重複・多すぎは整えられる', async () => {
    await save('s1', { goodAt: ['骨盤矯正', '骨盤矯正', ...Array.from({ length: 20 }, (_, i) => `t${i}`)] });
    expect(profiles().s1.goodAt.length).toBeLessThanOrEqual(8);
    expect(new Set(profiles().s1.goodAt).size).toBe(profiles().s1.goodAt.length);
  });
  it('⚠️ 役割や社員IDを混ぜて送っても保存されない（正本を書き換えさせない）', async () => {
    await save('s1', { nameKanji: '青木', role: 'root', staffId: '999', pid: 'zzz', oneLine: 'ひとこと' });
    expect(profiles().s1.role).toBeUndefined();
    expect(profiles().s1.staffId).toBeUndefined();
    expect(profiles().s1.pid).toBe('s1');
  });
});

describe('編集してよい人（サーバー側で確かめる）', () => {
  it('本部の管理者は他人のプロフィールも編集できる', async () => {
    expect((await save('s9', { nameKanji: '他人', oneLine: '本部が直しました' })).body.ok).toBe(true);
  });
  it('⚠️ ログインしていなければ編集できない', async () => {
    const res = await save('s9', { oneLine: '乗っ取り' }, { host: 'test.local' });
    expect(res.statusCode).toBe(403);
    expect(profiles().s9.bio).toBe('もとの文');
  });
  it('⚠️ body.root を名乗っても通らない（クライアントの申告を信じない）', async () => {
    const res = await save('s9', { oneLine: '乗っ取り' }, { host: 'test.local' }, { root: true, staffId: 's9' });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('chat_admin_only');
    expect(profiles().s9.bio).toBe('もとの文');
  });
  it('⚠️ 削除も同じ判定', async () => {
    const res = await call({ method: 'POST', headers: { host: 'test.local' }, body: { type: 'profile', action: 'delete', pid: 's9', root: true } });
    expect(res.statusCode).toBe(403);
    expect(profiles().s9).toBeTruthy();
  });
});
