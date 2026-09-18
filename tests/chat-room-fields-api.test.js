import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../api/plan-store.js';
import { hashOwnerToken } from '../lib/settlement.js';

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
  saved = { u: process.env.KV_REST_API_URL, t: process.env.KV_REST_API_TOKEN, d: process.env.DASHBOARD_PASSWORD, s: process.env.AUTH_SALT };
  process.env.KV_REST_API_URL = KV;
  process.env.KV_REST_API_TOKEN = 'test-token-not-a-secret';
  process.env.DASHBOARD_PASSWORD = 'pw-for-test';
  process.env.AUTH_SALT = 'salt-for-test';
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
  for (const [k, v] of [['KV_REST_API_URL', saved.u], ['KV_REST_API_TOKEN', saved.t], ['DASHBOARD_PASSWORD', saved.d], ['AUTH_SALT', saved.s]]) {
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
// チャットは本人確認が必須（#390）。root の資格情報をヘッダで送る。
const ROOT_HDR = () => ({ 'x-cc-owner': '__root__', 'x-cc-token': hashOwnerToken('__root__', 'pw-for-test', 'salt-for-test') });
const post = (body) => call({ method: 'POST', headers: ROOT_HDR(), body: { type: 'chat', ...body } });
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
    const res = await call({ method: 'GET', headers: ROOT_HDR(), query: { type: 'chat' } });
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

// ── ①への追加確認（本人確認の代わりに申告値を使わない）──────────────
describe('申告値を本人確認の代わりにしない', () => {
  it('🔴 body.root では通らない', async () => {
    const res = await call({ method: 'POST', body: { type: 'chat', action: 'setMembers', roomId: 'g1', members: ['x'], root: true, staffId: '__root__' } });
    expect(res.statusCode).toBe(403);
  });
  it('🔴 body.staffId でメンバーを名乗っても通らない', async () => {
    const res = await call({ method: 'POST', body: { type: 'chat', action: 'setMembers', roomId: 'g1', members: ['x'], staffId: 's1' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('🔴 body.bySync で「システム同期」を名乗れない', () => {
  it('一般のリクエストが bySync を送っても human 扱い＝手動へ昇格する', async () => {
    // g1 は autoMembers:['s1']。bySync を名乗って s1 を外し、再び入れる。
    await post({ action: 'setMembers', roomId: 'g1', members: ['s2'], bySync: true });
    await post({ action: 'setMembers', roomId: 'g1', members: ['s2', 's1'], bySync: true });
    // sync 扱いなら s1 は autoMembers に戻り得るが、human 扱いなので戻らない
    expect(room('g1').autoMembers).toEqual([]);
  });
  it('bySync を名乗っても自動削除の対象を増やせない', async () => {
    await post({ action: 'setMembers', roomId: 'g1', members: ['s1', 's2', 'newbie'], bySync: true });
    expect(room('g1').autoMembers).toEqual(['s1']);   // newbie は自動所属にならない
  });
});

describe('🔴 既存Room IDを指定した createRoom で、権限のないRoomを作り直せない', () => {
  beforeEach(() => {
    const cur = JSON.parse(store.get(CHAT));
    cur.rooms.push({ id: 'dm_others', kind: 'dm', members: ['s1', 's2'], storeId: 'x' });
    store.set(CHAT, JSON.stringify(cur));
  });
  it('他人のDMのIDを指定しても書き換えられない', async () => {
    const res = await post({ action: 'createRoom', room: { id: 'dm_others', kind: 'group', name: '乗っ取り', members: ['attacker'] } });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('room_not_visible');
    const r = room('dm_others');
    expect(r.kind).toBe('dm');
    expect(r.members).toEqual(['s1', 's2']);   // 元のまま
  });
  it('見えるRoomなら従来どおり更新できる', async () => {
    const res = await post({ action: 'createRoom', room: { id: 'g1', kind: 'group', name: '改名OK', members: ['s1'] } });
    expect(res.statusCode).toBe(200);
    expect(room('g1').name).toBe('改名OK');
  });
});

describe('🔴 members 変更も認可する', () => {
  beforeEach(() => {
    const cur = JSON.parse(store.get(CHAT));
    cur.rooms.push({ id: 'g_secret', kind: 'group', name: '非公開', members: ['s1'] });
    store.set(CHAT, JSON.stringify(cur));
  });
  it('root は運営上グループを見られるので変更できる', async () => {
    const res = await post({ action: 'setMembers', roomId: 'g_secret', members: ['s1', 's2'] });
    expect(res.statusCode).toBe(200);
  });
  it('DMのメンバーは変更経路自体が無い（group 限定）', async () => {
    const cur = JSON.parse(store.get(CHAT));
    cur.rooms.push({ id: 'dm_x', kind: 'dm', members: ['a', 'b'] });
    store.set(CHAT, JSON.stringify(cur));
    const res = await post({ action: 'setMembers', roomId: 'dm_x', members: ['a', 'b', 'c'] });
    expect(res.statusCode).toBe(400);
  });
});
