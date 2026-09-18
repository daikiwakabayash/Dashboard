// ── 結合テスト: ①の実サーバー実装（api/plan-store.js）に対して実行する ──────
// ⚠️ 参照実装（tests/chat-ai-contract.test.js）とは別物。ここで動かすのは **①のハンドラそのもの**。
//    保存層だけ Upstash REST 互換の擬似KVをローカルに立て、認証・認可・保存は本物のコードを通す。
//    ②は本番サーバーへ書き込まないため、この方式で「サーバー仕様に合っているか」を確かめる。
//
// 確認する項目（画面で確かめたいことのサーバー側の裏付け）:
//   ・未認証／申告だけ／未公開ロールは拒否される
//   ・本部・管理者は利用でき、投稿が保存され、再取得しても残る
//   ・非参加のDMは root でも返らない
//   ・同じルームIDで作り直しても重複しない
//   ・①のエラー形（{ok:false,error,code,message}）が②のAdapterで正しく解釈される

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { normalizeError, errorMessageFor, createLiveAdapter } from '../lib/chat-ai-adapter.js';

// ── Upstash REST 互換の擬似KV（EVAL の Lua は等価な JS で再現）──────────────
function startFakeKv() {
  const store = new Map();
  const evalLua = (script, keys, args) => {
    const key = keys[0];
    const read = () => { const raw = store.get(key); if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } };
    if (script.includes('arr[#arr+1]=cjson.decode(ARGV[1])')) {        // 追記＋cap
      const arr = Array.isArray(read()) ? read() : [];
      arr.push(JSON.parse(args[0]));
      const cap = Number(args[1]);
      const next = arr.length > cap ? arr.slice(arr.length - cap) : arr;
      store.set(key, JSON.stringify(next));
      return next.length;
    }
    if (script.includes("d._v")) {                                      // compare-and-set
      const cur = read();
      const curv = (cur && typeof cur === 'object' && cur._v) ? Number(cur._v) : 0;
      if (curv !== Number(args[0])) return -1;
      store.set(key, args[1]);
      return 1;
    }
    if (script.includes('if t>cur then m[k]=t end')) {                  // 既読の最大値更新
      const m = read() || {};
      const k = args[0], t = Number(args[1]);
      if (t > (Number(m[k]) || 0)) m[k] = t;
      store.set(key, JSON.stringify(m));
      return 1;
    }
    return null;
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const url = new URL(req.url, 'http://x');
      const m = /^\/get\/(.+)$/.exec(url.pathname);
      if (m) return res.end(JSON.stringify({ result: store.get(decodeURIComponent(m[1])) ?? null }));
      const s = /^\/set\/(.+)$/.exec(url.pathname);
      if (s) { store.set(decodeURIComponent(s[1]), body); return res.end(JSON.stringify({ result: 'OK' })); }
      let cmd = []; try { cmd = JSON.parse(body); } catch {}
      const op = String(cmd[0] || '').toUpperCase();
      if (op === 'MGET') return res.end(JSON.stringify({ result: cmd.slice(1).map(k => store.get(k) ?? null) }));
      if (op === 'EVAL') {
        const script = cmd[1]; const n = Number(cmd[2]);
        return res.end(JSON.stringify({ result: evalLua(script, cmd.slice(3, 3 + n), cmd.slice(3 + n)) }));
      }
      res.end(JSON.stringify({ result: null }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, store })));
}

const SALT = 'naoru-settlement-2026';
const ROOT_PW = 'root-pw-for-test';
const rootToken = () => createHash('sha256').update(`__root__:${ROOT_PW}:${SALT}`).digest('hex');
const ownerToken = (owner, pw) => createHash('sha256').update(`${owner}:${pw}:${SALT}`).digest('hex');

let kv, handler;
beforeAll(async () => {
  kv = await startFakeKv();
  process.env.KV_REST_API_URL = `http://127.0.0.1:${kv.port}`;
  process.env.KV_REST_API_TOKEN = 'test-token';
  process.env.DASHBOARD_PASSWORD = ROOT_PW;
  process.env.AUTH_SALT = SALT;
  process.env.SETTLEMENT_OWNER_PASSWORDS = JSON.stringify({ 'オーナーA': 'owner-pw' });
  process.env.SETTLEMENT_OWNER_SHOPS = JSON.stringify({ 'オーナーA': ['A院'] });
  delete process.env.SUPABASE_URL; delete process.env.PLAN_GAS_URL; delete process.env.SETTLEMENT_GAS_URL;
  handler = (await import('../api/plan-store.js')).default;    // ①の実ハンドラ
});
afterAll(() => { kv && kv.server.close(); });

// ①のハンドラを直接呼ぶ（Vercel の req/res を模す）
async function call({ method = 'GET', query = {}, body = null, headers = {} }) {
  let statusCode = 200, payload = null;
  const res = {
    setHeader() {}, status(c) { statusCode = c; return this; },
    json(o) { payload = o; return this; }, send(o) { payload = o; return this; }, end() { return this; },
  };
  await handler({ method, query, body, headers }, res);
  return { status: statusCode, body: payload };
}
const rootHeaders = { 'x-cc-owner': encodeURIComponent('__root__'), 'x-cc-token': rootToken() };
const ownerHeaders = { 'x-cc-owner': encodeURIComponent('オーナーA'), 'x-cc-token': ownerToken('オーナーA', 'owner-pw') };

describe('実サーバー結合: チャットの入口（①の認可）', () => {
  it('未認証の取得は 403 chat_admin_only', async () => {
    const r = await call({ query: { type: 'chat' } });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ ok: false, error: 'forbidden', code: 'chat_admin_only' });
  });

  it('body.root / staffId の申告だけでは通らない', async () => {
    const r = await call({ method: 'POST', body: { type: 'chat', action: 'send', root: true, staffId: '__root__', roomId: 'x', msg: { text: 'a' } } });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('chat_admin_only');
  });

  it('オーナー（未公開ロール）は 403', async () => {
    const r = await call({ query: { type: 'chat' }, headers: ownerHeaders });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('chat_admin_only');
  });

  it('本部・管理者（rootトークン）は 200 で取得できる', async () => {
    const r = await call({ query: { type: 'chat' }, headers: rootHeaders });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.rooms)).toBe(true);
  });

  it('②の Adapter が①のエラー形をそのまま解釈できる（自動再試行しない）', async () => {
    const r = await call({ query: { type: 'chat' } });
    const err = normalizeError(r.body, r.status);
    expect(err).toMatchObject({ code: 'chat_admin_only', retryable: false });
    expect(errorMessageFor(err)).toMatch(/本部・管理者のみ/);
  });

  it('createLiveAdapter を①のハンドラへ向けても、権限拒否として扱われる', async () => {
    const adapter = createLiveAdapter({
      endpoint: '/api/plan-store',
      type: 'chat', action: 'ask',            // ①の振り分け規約（body.type）に合わせる
      auth: {},                               // 認証情報なし
      fetch: async (url, init) => {
        const r = await call({ method: 'POST', body: JSON.parse(init.body), headers: init.headers });
        return { status: r.status, json: async () => r.body };
      },
    });
    const out = await adapter.ask({ question: 'q', roomId: 'store_A', requestId: 'req_1' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatchObject({ code: 'chat_admin_only', retryable: false });
  });
});

describe('実サーバー結合: 投稿と履歴', () => {
  const room = { id: 'room_it_1', kind: 'group', name: '検証用ルーム', members: ['__root__'], createdBy: '__root__' };

  it('ルームを作成し、同じIDで作り直しても重複しない', async () => {
    const a = await call({ method: 'POST', body: { type: 'chat', action: 'createRoom', room }, headers: rootHeaders });
    expect(a.status).toBe(200);
    await call({ method: 'POST', body: { type: 'chat', action: 'createRoom', room }, headers: rootHeaders });
    const g = await call({ query: { type: 'chat' }, headers: rootHeaders });
    expect(g.body.rooms.filter(r => r.id === room.id).length).toBe(1);
  });

  it('送信した本文が保存され、再取得（再読み込み相当）でも残る', async () => {
    const s = await call({ method: 'POST', body: { type: 'chat', action: 'send', roomId: room.id, msg: { fromStaffId: '__root__', fromName: '管理者', text: '結合テストの投稿' } }, headers: rootHeaders });
    expect(s.status).toBe(200);
    expect(s.body.ok).toBe(true);
    const g1 = await call({ query: { type: 'chat' }, headers: rootHeaders });
    const g2 = await call({ query: { type: 'chat' }, headers: rootHeaders });   // 再読み込み
    expect((g2.body.messages[room.id] || []).map(m => m.text)).toContain('結合テストの投稿');
    expect((g1.body.messages[room.id] || []).length).toBe((g2.body.messages[room.id] || []).length);
  });

  it('同じ本文を2回送るとサーバー側は2件になる（＝重複防止はクライアント側の責任）', async () => {
    const before = (await call({ query: { type: 'chat' }, headers: rootHeaders })).body.messages[room.id].length;
    const msg = { fromStaffId: '__root__', fromName: '管理者', text: '二重送信の確認' };
    await call({ method: 'POST', body: { type: 'chat', action: 'send', roomId: room.id, msg }, headers: rootHeaders });
    await call({ method: 'POST', body: { type: 'chat', action: 'send', roomId: room.id, msg }, headers: rootHeaders });
    const after = (await call({ query: { type: 'chat' }, headers: rootHeaders })).body.messages[room.id].length;
    expect(after - before).toBe(2);
    // → ②の画面は clientId と answer_message_id で重複を防いでいる（tests/chat-ai-contract.test.js）
  });

  it('非参加のDMは root でも返らない', async () => {
    await call({ method: 'POST', body: { type: 'chat', action: 'createRoom', room: { id: 'dm_it_1', kind: 'dm', members: ['s1', 's2'], createdBy: 's1' } }, headers: rootHeaders });
    const g = await call({ query: { type: 'chat' }, headers: rootHeaders });
    expect(g.body.rooms.find(r => r.id === 'dm_it_1')).toBeUndefined();
    expect(g.body.messages['dm_it_1']).toBeUndefined();
  });

  it('既読の更新が保存される', async () => {
    const r = await call({ method: 'POST', body: { type: 'chat', action: 'read', roomId: room.id, staffId: '__root__', ts: 1700000000000 }, headers: rootHeaders });
    expect(r.status).toBe(200);
    const g = await call({ query: { type: 'chat' }, headers: rootHeaders });
    expect((g.body.reads['__root__'] || {})[room.id]).toBeGreaterThanOrEqual(1700000000000);
  });
});

describe('実サーバー結合: @AI エンドポイントの有無', () => {
  it('現時点では AI 用のエンドポイントが無い（①の実装待ち）', async () => {
    const r = await call({ method: 'POST', query: { type: 'chatai', action: 'ask' }, body: { type: 'chatai', action: 'ask', question: 'q', room_id: 'room_it_1', request_id: 'req_1' }, headers: rootHeaders });
    // チャット用の認可ゲート（type==='chat'）にも掛からず、AI の応答も返らないことを記録しておく。
    expect(r.body && r.body.answer_message_id).toBeUndefined();
  });
});
