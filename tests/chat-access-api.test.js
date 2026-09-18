import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../api/plan-store.js';
import { _clearBearerCache } from '../lib/actor.js';
import { hashOwnerToken } from '../lib/settlement.js';

// 既存チャットのアクセス制御。未認証GETで中身が読めない状態を固定する。
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
  _clearBearerCache();
  store.set(CHAT, JSON.stringify({
    rooms: [
      { id: 'announce_all', kind: 'announce', name: '全社', members: [] },
      { id: 'store_A', kind: 'store', name: 'A院', shop: 'A院', members: [] },
      { id: 'dm_others', kind: 'dm', members: ['s1', 's2'] },
      { id: 'dm_mine', kind: 'dm', members: ['__root__', 's9'] },
      { id: 'g1', kind: 'group', name: '部活', members: ['s1'] },
    ],
    dir: { staff: [{ id: 's1', name: 'スタッフ1' }] },
    notes: { dm_others: [{ id: 'n1', text: 'DMのノート' }], store_A: [{ id: 'n2', text: '店舗のノート' }] },
  }));
  store.set('naoru:chat:m:dm_others', JSON.stringify([{ id: 'm1', text: '他人のDM本文' }]));
  store.set('naoru:chat:m:store_A', JSON.stringify([{ id: 'm2', text: '店舗の本文' }]));
  store.set('naoru:chat:img:img1', JSON.stringify('data:image/png;base64,AAAA'));
});
afterEach(() => {
  for (const [k, v] of [['KV_REST_API_URL', saved.u], ['KV_REST_API_TOKEN', saved.t], ['DASHBOARD_PASSWORD', saved.d], ['AUTH_SALT', saved.s]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  vi.restoreAllMocks();
});
function mockRes() {
  const r = { statusCode: 0, body: null, headers: {}, sent: null };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.sent = b; return r; };
  r.end = () => r;
  return r;
}
const call = async (req) => { const res = mockRes(); await handler({ headers: {}, query: {}, body: {}, ...req }, res); return res; };
const ROOT = () => ({ 'x-cc-owner': '__root__', 'x-cc-token': hashOwnerToken('__root__', 'pw-for-test', 'salt-for-test') });

describe('未認証はチャットの何も取れない', () => {
  const cases = [
    ['ルーム一覧・本文', { method: 'GET', query: { type: 'chat' } }],
    ['画像', { method: 'GET', query: { type: 'chat', img: 'img1' } }],
    ['画像（生バイナリ）', { method: 'GET', query: { type: 'chat', img: 'img1', raw: '1' } }],
    ['🔴 画像の迂回経路（profile）', { method: 'GET', query: { type: 'profile', img: 'img1' } }],
    ['🔴 名簿（profile）', { method: 'GET', query: { type: 'profile' } }],
    ['書き込み（送信）', { method: 'POST', body: { type: 'chat', action: 'send', roomId: 'store_A', msg: { text: 'x' } } }],
    ['書き込み（ルーム作成）', { method: 'POST', body: { type: 'chat', action: 'createRoom', room: { kind: 'group', name: 'x' } } }],
    ['ノートの書き込み', { method: 'POST', body: { type: 'chat', action: 'noteAdd', roomId: 'store_A', note: { text: 'x' } } }],
  ];
  for (const [label, req] of cases) {
    it(`${label} → 403`, async () => {
      const res = await call(req);
      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe('chat_admin_only');
    });
  }
  it('🔴 応答に本文・名簿が含まれない', async () => {
    const res = await call({ method: 'GET', query: { type: 'chat' } });
    const dump = JSON.stringify(res.body);
    expect(dump).not.toContain('他人のDM本文');
    expect(dump).not.toContain('店舗の本文');
    expect(dump).not.toContain('スタッフ1');
  });
});

describe('なりすましを拒否する', () => {
  it('🔴 role の自己申告では通らない', async () => {
    const res = await call({ method: 'POST', body: { type: 'chat', action: 'send', roomId: 'store_A', role: 'root', root: true, staffId: '__root__', msg: { text: 'x' } } });
    expect(res.statusCode).toBe(403);
  });
  it('🔴 偽のトークンでは通らない', async () => {
    const res = await call({ method: 'GET', headers: { 'x-cc-owner': '__root__', 'x-cc-token': 'wrong' }, query: { type: 'chat' } });
    expect(res.statusCode).toBe(403);
  });
  it('🔴 body.root は本人確認の代わりにならない', async () => {
    const res = await call({ method: 'POST', body: { type: 'chat', action: 'deleteRoom', roomId: 'g1', root: true } });
    expect(res.statusCode).toBe(403);
  });
  it('🔴 秘密が未設定でも素通ししない（fail closed）', async () => {
    delete process.env.DASHBOARD_PASSWORD;
    const res = await call({ method: 'GET', headers: { 'x-cc-owner': '__root__', 'x-cc-token': '' }, query: { type: 'chat' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('本人確認した root/本部は従来どおり使える', () => {
  it('ルーム一覧が取れる', async () => {
    const res = await call({ method: 'GET', headers: ROOT(), query: { type: 'chat' } });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.rooms)).toBe(true);
  });
  it('日本語のアカウント名でも通る（percent-encode）', async () => {
    // 本部アカウントは個人名。ヘッダは ISO-8859-1 しか運べないためエンコードして送る。
    const res = await call({ method: 'GET', headers: { 'x-cc-owner': encodeURIComponent('__root__'), 'x-cc-token': hashOwnerToken('__root__', 'pw-for-test', 'salt-for-test') }, query: { type: 'chat' } });
    expect(res.statusCode).toBe(200);
  });
  it('画像が取れる', async () => {
    const res = await call({ method: 'GET', headers: ROOT(), query: { type: 'chat', img: 'img1' } });
    expect(res.statusCode).toBe(200);
  });
  it('送信できる', async () => {
    const res = await call({ method: 'POST', headers: ROOT(), body: { type: 'chat', action: 'send', roomId: 'store_A', msg: { fromStaffId: '__root__', text: 'テスト' } } });
    expect(res.statusCode).toBe(200);
  });
});

describe('🔴 root/本部でも参加していないDMは見えない', () => {
  it('他人のDMがルーム一覧に出ない', async () => {
    const res = await call({ method: 'GET', headers: ROOT(), query: { type: 'chat' } });
    const ids = res.body.rooms.map(r => r.id);
    expect(ids).not.toContain('dm_others');
    expect(ids).toContain('dm_mine');          // 自分が当事者のDMは見える
  });
  it('他人のDMの本文が返らない', async () => {
    const res = await call({ method: 'GET', headers: ROOT(), query: { type: 'chat' } });
    expect(Object.keys(res.body.messages)).not.toContain('dm_others');
    expect(JSON.stringify(res.body)).not.toContain('他人のDM本文');
  });
  it('他人のDMのノートも返らない', async () => {
    const res = await call({ method: 'GET', headers: ROOT(), query: { type: 'chat' } });
    expect(JSON.stringify(res.body)).not.toContain('DMのノート');
    expect(JSON.stringify(res.body)).toContain('店舗のノート');   // 見えるルームのノートは残る
  });
  it('絞り込みが起きたことが分かる', async () => {
    const res = await call({ method: 'GET', headers: ROOT(), query: { type: 'chat' } });
    expect(res.body.filtered).toBe(true);
  });
});

describe('画像を共有キャッシュに載せない', () => {
  it('🔴 Cache-Control が public ではない', async () => {
    const res = await call({ method: 'GET', headers: ROOT(), query: { type: 'chat', img: 'img1', raw: '1' } });
    const cc = String(res.headers['Cache-Control'] || '');
    expect(cc).not.toContain('public');
    expect(cc).toContain('private');
  });
});

describe('他の機能を巻き込んでいない', () => {
  it('掲示板・手当・イベントは従来どおり（このPRの対象外）', async () => {
    for (const t of ['board', 'allowance', 'events', 'thanksgift']) {
      const res = await call({ method: 'GET', query: { type: t } });
      expect(res.statusCode, t).toBe(200);
    }
  });
});
