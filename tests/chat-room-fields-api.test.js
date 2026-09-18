import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../api/plan-store.js';

// 実際の API を通したときに、付加フィールドが消えないこと・クライアントから書けないこと。
const KV = 'https://kv.test';
let store;
const CHAT = 'naoru:chat:v1';

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
      if (cmd[0] === 'MGET') return ok({ result: cmd.slice(1).map(k => (store.has(k) ? store.get(k) : null)) });
    }
    return ok({});
  });
}
let saved;
beforeEach(() => {
  saved = { u: process.env.KV_REST_API_URL, t: process.env.KV_REST_API_TOKEN };
  process.env.KV_REST_API_URL = KV;
  process.env.KV_REST_API_TOKEN = 'test-token-not-a-secret';
  installFetchMock();
  store.set(CHAT, JSON.stringify({
    rooms: [
      { id: 'g1', kind: 'group', name: '部活', members: ['s1', 's2'], storeId: '11', status: 'active', autoMembers: ['s1'] },
      { id: 'store_A', kind: 'store', name: 'A院', shop: 'A院', members: ['s3'], storeId: '22', autoMembers: ['s3'] },
    ],
    dir: { staff: [] }, notes: {},
  }));
});
afterEach(() => {
  for (const [k, v] of [['KV_REST_API_URL', saved.u], ['KV_REST_API_TOKEN', saved.t]]) {
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
const post = (body) => call({ method: 'POST', body: { type: 'chat', ...body } });
const roomsNow = () => { try { return JSON.parse(store.get(CHAT)).rooms; } catch { return []; } };
const room = (id) => roomsNow().find(r => r.id === id);

describe('API経由: 付加フィールドが消えない（回帰）', () => {
  it('🔴 createRoom で同じIDを作り直しても storeId / autoMembers が残る', async () => {
    const res = await post({ action: 'createRoom', room: { id: 'g1', kind: 'group', name: '部活（改名）', members: ['s1', 's2'] } });
    expect(res.statusCode).toBe(200);
    const r = room('g1');
    expect(r.name).toBe('部活（改名）');
    expect(r.storeId).toBe('11');
    expect(r.status).toBe('active');
    expect(r.autoMembers).toEqual(['s1']);
  });

  it('🔴 setMembers でも残る', async () => {
    await post({ action: 'setMembers', roomId: 'g1', members: ['s1', 's2', 's9'], staffId: 's1' });
    const r = room('g1');
    expect(r.storeId).toBe('11');
    expect(r.members).toContain('s9');
  });

  it('🔴 setRoom（名前変更）でも残る', async () => {
    await post({ action: 'setRoom', roomId: 'g1', name: '新しい名前', staffId: 's1' });
    const r = room('g1');
    expect(r.name).toBe('新しい名前');
    expect(r.storeId).toBe('11');
    expect(r.autoMembers).toEqual(['s1']);
  });

  it('🔴 ensureRooms でも既存Roomの付加フィールドが残る', async () => {
    await post({ action: 'ensureRooms', shops: [{ name: 'A院' }, { name: 'B院' }] });
    expect(room('store_A').storeId).toBe('22');
    expect(room('store_A').autoMembers).toEqual(['s3']);
    expect(roomsNow().some(r => r.name === 'B院')).toBe(true);
  });
});

describe('API経由: クライアントから管理フィールドを書けない', () => {
  it('🔴 createRoom で autoMembers を偽装できない（新規Room）', async () => {
    await post({ action: 'createRoom', room: { id: 'gNEW', kind: 'group', name: 'x', members: ['me'], autoMembers: ['me'], storeId: '999' } });
    const r = room('gNEW');
    expect(r.autoMembers).toBeUndefined();
    expect(r.storeId).toBeUndefined();
  });

  it('🔴 createRoom で既存Roomの storeId を書き換えられない', async () => {
    await post({ action: 'createRoom', room: { id: 'g1', kind: 'group', name: 'x', members: ['s1'], storeId: '999', autoMembers: ['attacker'] } });
    const r = room('g1');
    expect(r.storeId).toBe('11');                 // 既存の値が勝つ
    expect(r.autoMembers).toEqual(['s1']);        // 偽装されない
  });

  it('🔴 setRoom で status を archived にできない（同期以外から畳ませない）', async () => {
    await post({ action: 'setRoom', roomId: 'g1', status: 'archived', name: 'y', staffId: 's1' });
    expect(room('g1').status).toBe('active');
  });
});

describe('API経由: 人が入れた人は自動所属にならない', () => {
  it('🔴 人が追加したメンバーは autoMembers に入らない＝同期に消されない', async () => {
    await post({ action: 'setMembers', roomId: 'g1', members: ['s1', 's2', 'newbie'], staffId: 's1' });
    expect(room('g1').autoMembers).toEqual(['s1']);
    expect(room('g1').members).toContain('newbie');
  });
  it('🔴 自動所属の人を人が入れ直したら手動へ昇格する', async () => {
    await post({ action: 'setMembers', roomId: 'g1', members: ['s2'], staffId: 's2' });          // s1 を外す
    expect(room('g1').autoMembers).toEqual([]);
    await post({ action: 'setMembers', roomId: 'g1', members: ['s2', 's1'], staffId: 's2' });    // 人が s1 を戻す
    expect(room('g1').autoMembers).toEqual([]);                                                  // 自動所属に戻らない
  });
  it('autoMembers が無い旧Roomでは、勝手に作らない', async () => {
    store.set(CHAT, JSON.stringify({ rooms: [{ id: 'old', kind: 'group', name: '旧', members: ['a'] }], dir: { staff: [] }, notes: {} }));
    await post({ action: 'setMembers', roomId: 'old', members: ['a', 'b'], staffId: 'a' });
    expect(room('old')).not.toHaveProperty('autoMembers');
  });
});

describe('既存のチャット機能を壊していない', () => {
  it('GET は従来どおりルームを返す', async () => {
    const res = await call({ method: 'GET', query: { type: 'chat' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.rooms).toHaveLength(2);
  });
  it('新規グループ作成は通る', async () => {
    const res = await post({ action: 'createRoom', room: { kind: 'group', name: '新グループ', members: ['a', 'b'] } });
    expect(res.statusCode).toBe(200);
    expect(res.body.room.name).toBe('新グループ');
  });
  it('メンバー変更は通る', async () => {
    const res = await post({ action: 'setMembers', roomId: 'g1', members: ['s1'], staffId: 's1' });
    expect(res.statusCode).toBe(200);
    expect(room('g1').members).toEqual(['s1']);
  });
});
