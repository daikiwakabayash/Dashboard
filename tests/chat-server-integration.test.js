// ── ローカル結合テスト: ①の実ハンドラ（api/plan-store.js）＋ 擬似KV ──────────
// ⚠️ 位置づけを混同しないこと。
//    これは **「①の実ハンドラ＋擬似KV」をこのリポジトリ内で動かすローカル結合テスト** であり、
//    **デプロイ済みAPI・実KV（本番/Preview）での確認ではない**。
//    デプロイ済み環境での確認は、①の環境と認証情報が要るため別途行う（未実施）。
//
// 確認する項目（画面で確かめたいことのサーバー側の裏付け）:
//   ・未認証／申告だけ／未公開ロールは拒否される
//   ・本部・管理者は利用でき、投稿が保存され、再取得しても残る
//   ・非参加のDMは root でも返らない
//   ・同じルームIDで作り直しても重複しない
//   ・①のエラー形（{ok:false,error,code,message}）が②のAdapterで正しく解釈される
//
// 重複防止の責任分界（①と合意）:
//   ・同じ送信の**再試行**は同じ request_id を維持する（②）
//   ・**新しい送信**には新しい request_id を採る（②）
//   ・同じ request_id の**重複実行防止**はサーバーが担当（①: replay / pending / conflict）
//   ・**回答カードの重複表示防止**は②が担当

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { normalizeError, errorMessageFor, createLiveAdapter } from '../lib/chat-ai-adapter.js';

// ── Upstash REST 互換の擬似KV（EVAL の Lua は等価な JS で再現）──────────────
function startFakeKv() {
  const store = new Map();
  // 擬似上流（①のハンドラが呼ぶ /api/chat）。**実AIではない**。
  // 生成に時間がかかる状況（pending の窓）を作るために遅延を差し込める。
  const upstream = { delayMs: 0, calls: 0, reply: '（擬似上流の回答・実AIではありません）', fail: false };
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
      // 擬似上流（/api/chat）。①のハンドラが host から自分自身を呼ぶ経路をここで受ける。
      if (url.pathname === '/api/chat') {
        upstream.calls += 1;
        const done = () => {
          if (upstream.fail) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'upstream' })); }
          res.end(JSON.stringify({ message: upstream.reply }));
        };
        return upstream.delayMs > 0 ? setTimeout(done, upstream.delayMs) : done();
      }
      // SalonOne の /me を模す（SSO 経路を①の実コードで通すため）
      if (url.pathname.endsWith('/salonone/me')) {
        const bearer = String(req.headers.authorization || '');
        const role = /shop-staff/.test(bearer) ? 'shop_staff' : 'brand_admin';
        return res.end(JSON.stringify({ data: { user_id: '7', staff_id: '9', login_id: 'sso_user', role,
          accessible_shops: [{ id: '100', name: 'A院' }] } }));
      }
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
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, store, upstream })));
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
  process.env.CC_ENV = 'test';          // ①は Command Center 系のキーを環境ごとに分ける（ccKey）
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
// Command Center 系のキーは環境サフィックスが付く（本番のみ素のキー）
const ccK = (base) => `${base}:test`;
const ownerHeaders = { 'x-cc-owner': encodeURIComponent('オーナーA'), 'x-cc-token': ownerToken('オーナーA', 'owner-pw') };

describe('ローカル結合（実ハンドラ+擬似KV）: チャットの入口（①の認可）', () => {
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

describe('ローカル結合（実ハンドラ+擬似KV）: 投稿と履歴', () => {
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

  it('別々の送信（送信IDなしの2リクエスト）は2件になるのが正しい', async () => {
    // ⚠️ これは「重複」ではない。人が同じ本文を意図的に2回送ることは正常な操作であり、
    //    サーバーが勝手にまとめてはいけない。
    //    再試行の重複実行防止は request_id を持つ @AI の経路（?type=chatai）で①が担当する。
    const before = (await call({ query: { type: 'chat' }, headers: rootHeaders })).body.messages[room.id].length;
    const msg = { fromStaffId: '__root__', fromName: '管理者', text: '同じ本文を意図的に2回' };
    await call({ method: 'POST', body: { type: 'chat', action: 'send', roomId: room.id, msg }, headers: rootHeaders });
    await call({ method: 'POST', body: { type: 'chat', action: 'send', roomId: room.id, msg }, headers: rootHeaders });
    const after = (await call({ query: { type: 'chat' }, headers: rootHeaders })).body.messages[room.id].length;
    expect(after - before).toBe(2);
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



// ── 公開対象となる認証経路（rootトークンの成功だけで代用しない）─────────────
describe('ローカル結合（実ハンドラ+擬似KV）: 実際に公開する認証経路', () => {
  it('本部アカウント（オーナートークン＋accountmeta の role=hq → admin）で利用できる', async () => {
    // ①の resolveActor はオーナートークンの meta.role を見る。'hq' は authz で 'admin'（本部）に写像される。
    process.env.SETTLEMENT_OWNER_PASSWORDS = JSON.stringify({ 'オーナーA': 'owner-pw', '本部 花子': 'hq-pw' });
    kv.store.set('naoru:accountmeta:v1', JSON.stringify({ '本部 花子': { role: 'hq', staffName: '本部 花子' } }));
    const hqHeaders = { 'x-cc-owner': encodeURIComponent('本部 花子'), 'x-cc-token': ownerToken('本部 花子', 'hq-pw') };
    const r = await call({ query: { type: 'chat' }, headers: hqHeaders });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.rooms)).toBe(true);
  });

  it('SalonOne SSO（brand_admin）で利用できる', async () => {
    // 上流 /me を擬似サーバーに向ける（①の verifySalonOneBearer をそのまま通す）
    process.env.SALONONE_API_KEY = 'test-key';
    process.env.SALONONE_API_BASE = `http://127.0.0.1:${kv.port}/salonone`;
    const r = await call({ query: { type: 'chat' }, headers: { authorization: 'Bearer sso-brand-admin' } });
    expect(r.status).toBe(200);
    delete process.env.SALONONE_API_BASE; delete process.env.SALONONE_API_KEY;
  });

  it('SalonOne SSO でも shop_staff（未公開ロール）は拒否される', async () => {
    process.env.SALONONE_API_KEY = 'test-key';
    process.env.SALONONE_API_BASE = `http://127.0.0.1:${kv.port}/salonone`;
    const r = await call({ query: { type: 'chat' }, headers: { authorization: 'Bearer sso-shop-staff' } });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('chat_admin_only');
    delete process.env.SALONONE_API_BASE; delete process.env.SALONONE_API_KEY;
  });
});

// ── @AI 実接続（①の ?type=chatai）──────────────────────────────────────
describe('ローカル結合（実ハンドラ+擬似KV）: @AI 実接続', () => {
  const ROOM = 'room_ai_trial';
  const ask = (over = {}) => call({
    method: 'POST', headers: rootHeaders,
    body: { type: 'chatai', action: 'ask', question: '家族施術のルールは？', room_id: ROOM, request_id: 'req_ai_1', client_id: 'tab_1', ...over },
  });

  beforeAll(async () => {
    // 検証用Roomを用意し、フラグと許可リストを本部操作で有効化する（既定はどちらもOFF）
    await call({ method: 'POST', headers: rootHeaders, body: { type: 'chat', action: 'createRoom',
      room: { id: ROOM, kind: 'group', name: '本部/root 検証用ルーム', members: ['__root__'], createdBy: '__root__' } } });
    kv.store.set(ccK('naoru:cc:flags:v1'), JSON.stringify({ cc_all: true, cc_ai_trial: true }));
    await call({ method: 'POST', headers: rootHeaders, body: { type: 'chatai', action: 'config', config: { trialRooms: [ROOM] } } });
  });

  it('フラグ OFF・未許可Roomでは動かない（既定は閉じている）', async () => {
    kv.store.set(ccK('naoru:cc:flags:v1'), JSON.stringify({ cc_all: true, cc_ai_trial: false }));
    expect((await ask({ request_id: 'req_off' })).body.error.code).toBe('rollout_disabled');
    kv.store.set(ccK('naoru:cc:flags:v1'), JSON.stringify({ cc_all: true, cc_ai_trial: true }));
    const other = await ask({ room_id: 'room_it_1', request_id: 'req_other_room' });
    expect(other.body.error).toMatchObject({ code: 'forbidden_room', retryable: false });
  });

  it('質問 → 同じRoomに回答が入り、再読み込みでも残る', async () => {
    const r = await ask();
    expect(r.body.ok).toBe(true);
    expect(r.body.room_id).toBe(ROOM);
    expect(r.body.question_message_id).toBeTruthy();
    expect(r.body.answer_message_id).toBeTruthy();
    expect(r.body.mode).toBe('sample');                       // ANTHROPIC_API_KEY 未設定＝サンプル
    expect(r.body.sources.verification).not.toBe('server_verified');
    const g = await call({ query: { type: 'chat' }, headers: rootHeaders });   // 再読み込み相当
    const texts = (g.body.messages[ROOM] || []).map(m => m.text);
    expect(texts).toContain('家族施術のルールは？');
    expect((g.body.messages[ROOM] || []).some(m => m.id === r.body.answer_message_id)).toBe(true);
  });

  it('同じ request_id の再送は replay で、回答が増えない', async () => {
    const before = (await call({ query: { type: 'chat' }, headers: rootHeaders })).body.messages[ROOM].length;
    const again = await ask();                                 // 同じ送信の再試行
    expect(again.body.ok).toBe(true);
    expect(again.body.replay).toBe(true);
    const after = (await call({ query: { type: 'chat' }, headers: rootHeaders })).body.messages[ROOM].length;
    expect(after).toBe(before);
  });

  // ⚠️ 既知の不具合（①へ報告済み）:
  //    同じ request_id を**同時に**送ると、pending の記録（loadAi → saveAi）が
  //    read-modify-write のため取り合いになり、回答が複数作られる。
  //    逐次の再送（replay）は正しく1件に収まる。KV の CAS / SETNX などで
  //    「pending を先に立てた1つだけが生成する」形にすれば解決する。
  //    直ったらこのテストが失敗して気づけるよう it.fails で置いている。
  it.fails('【既知の不具合】同じ request_id の同時送信でも回答は1つだけであるべき', async () => {
    const [a, b, c] = await Promise.all([
      ask({ request_id: 'req_parallel', question: '同時送信の確認' }),
      ask({ request_id: 'req_parallel', question: '同時送信の確認' }),
      ask({ request_id: 'req_parallel', question: '同時送信の確認' }),
    ]);
    const uniq = [...new Set([a, b, c].map(x => x.body.answer_message_id).filter(Boolean))];
    expect(uniq.length).toBe(1);
  });

  it('同時送信で作られた回答も、以後の再送は1つに収束する（replay）', async () => {
    const again = await ask({ request_id: 'req_parallel', question: '同時送信の確認' });
    expect(again.body.ok).toBe(true);
    expect(again.body.replay).toBe(true);
    const once = await ask({ request_id: 'req_parallel', question: '同時送信の確認' });
    expect(once.body.answer_message_id).toBe(again.body.answer_message_id);
  });

  it('応答が消えた後の再送（同じ request_id）は同じ回答を返す', async () => {
    const first = await ask({ request_id: 'req_lost', question: '応答消失の確認' });
    expect(first.body.ok).toBe(true);
    const resend = await ask({ request_id: 'req_lost', question: '応答消失の確認' });   // 応答を受け取れなかった想定
    expect(resend.body.answer_message_id).toBe(first.body.answer_message_id);
    expect(resend.body.replay).toBe(true);
  });

  it('別の本文で同じ request_id を使い回すと競合として拒否される', async () => {
    const r = await ask({ request_id: 'req_lost', question: '別の質問に差し替えた' });
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatchObject({ code: 'request_conflict', retryable: false });
  });

  it('新しい送信には新しい request_id ＝ 新しい回答が作られる', async () => {
    const a = await ask({ request_id: 'req_new_1', question: '1件目の質問' });
    const b = await ask({ request_id: 'req_new_2', question: '2件目の質問' });
    expect(a.body.answer_message_id).not.toBe(b.body.answer_message_id);
  });

  it('AI の投稿を質問として指定すると拒否される（無限返信の防止）', async () => {
    const g = await call({ query: { type: 'chat' }, headers: rootHeaders });
    const aiMsg = (g.body.messages[ROOM] || []).find(m => m.fromStaffId === '__ai__');
    const r = await ask({ request_id: 'req_ai_src', question: 'AIの投稿を質問にする', question_message_id: aiMsg.id });
    expect(r.body.error).toMatchObject({ code: 'ai_message_source', retryable: false });
  });

  it('本部確認は何度依頼しても1件（created は初回だけ true）', async () => {
    const a = await ask({ request_id: 'req_hq', question: '本部確認の確認' });
    // 根拠不足の回答は、サーバーが ask の時点で本部確認を自動作成する（hq_review.status='pending'）
    expect(a.body.hq_review.status).toBe('pending');
    const first = await call({ method: 'POST', headers: rootHeaders, body: { type: 'chatai', action: 'hq_review',
      question_message_id: a.body.question_message_id, answer_message_id: a.body.answer_message_id, room_id: ROOM } });
    const second = await call({ method: 'POST', headers: rootHeaders, body: { type: 'chatai', action: 'hq_review',
      question_message_id: a.body.question_message_id, answer_message_id: a.body.answer_message_id, room_id: ROOM } });
    // 連打しても増えない（既にあるので created は false のまま・同じ依頼IDが返る）
    expect(first.body.created).toBe(false);
    expect(second.body.created).toBe(false);
    expect(first.body.hq_review.request_id).toBe(second.body.hq_review.request_id);
    expect(second.body.hq_review).toMatchObject({ status: 'pending', notified: false, channel: 'not_connected' });
  });

  it('本部の訂正は元回答を残して追記される', async () => {
    const a = await ask({ request_id: 'req_fix', question: '訂正の確認' });
    const before = (await call({ query: { type: 'chat' }, headers: rootHeaders })).body.messages[ROOM]
      .find(m => m.id === a.body.answer_message_id).text;
    const c = await call({ method: 'POST', headers: rootHeaders, body: { type: 'chatai', action: 'correct',
      answer_message_id: a.body.answer_message_id, text: '正しくは2親等以内＋配偶者です。' } });
    expect(c.body.ok).toBe(true);
    const after = (await call({ query: { type: 'chat' }, headers: rootHeaders })).body.messages[ROOM]
      .find(m => m.id === a.body.answer_message_id).text;
    expect(after).toBe(before);                                // 元回答は書き換わらない
  });

  it('権限を失った後の再取得は拒否される（保存済みでも見せない）', async () => {
    const a = await ask({ request_id: 'req_revoke', question: '権限剥奪の確認' });
    expect(a.body.ok).toBe(true);
    // 検証用Roomの許可を外す → 同じ request_id の再送も拒否される
    await call({ method: 'POST', headers: rootHeaders, body: { type: 'chatai', action: 'config', config: { trialRooms: [] } } });
    const replay = await ask({ request_id: 'req_revoke', question: '権限剥奪の確認' });
    expect(replay.body.error).toMatchObject({ code: 'forbidden_room', retryable: false });
    // チャット本体も、権限が無くなれば取得できない
    const noAuth = await call({ query: { type: 'chat' } });
    expect(noAuth.status).toBe(403);
    await call({ method: 'POST', headers: rootHeaders, body: { type: 'chatai', action: 'config', config: { trialRooms: [ROOM] } } });
  });

  it('②の createLiveAdapter が①の実ハンドラと往復できる（ask → hqReview → correct）', async () => {
    const { createLiveAdapter } = await import('../lib/chat-ai-adapter.js');
    const adapter = createLiveAdapter({
      endpoint: '/api/plan-store',
      headers: () => rootHeaders,
      fetch: async (url, init) => {
        const r = init.method === 'GET'
          ? await call({ query: { type: 'chatai', action: 'config' }, headers: rootHeaders })
          : await call({ method: 'POST', body: JSON.parse(init.body), headers: init.headers });
        return { status: r.status, json: async () => r.body };
      },
    });
    const out = await adapter.ask({ question: 'Adapter からの質問', roomId: ROOM, requestId: 'req_adapter', clientId: 'tab_x' });
    expect(out.ok).toBe(true);
    expect(out.roomId).toBe(ROOM);
    expect(out.answerMessageId).toBeTruthy();
    expect(out.mode).toBe('sample');

    const replay = await adapter.ask({ question: 'Adapter からの質問', roomId: ROOM, requestId: 'req_adapter' });
    expect(replay.answerMessageId).toBe(out.answerMessageId);   // 再試行で増えない
    expect(replay.replay).toBe(true);

    const hq = await adapter.hqReview({ questionMessageId: out.questionMessageId, answerMessageId: out.answerMessageId, roomId: ROOM });
    expect(hq.ok).toBe(true);
    expect(hq.hq_review).toMatchObject({ notified: false, channel: 'not_connected' });

    const fix = await adapter.correct({ answerMessageId: out.answerMessageId, text: 'Adapter からの訂正' });
    expect(fix.ok).toBe(true);

    const cfg = await adapter.getConfig();
    expect(cfg.ok).toBe(true);
    expect(cfg.config.trialRooms).toContain(ROOM);
  });
});

// ── 回答生成中（pending の窓）の挙動 ──────────────────────────────────────
// ⚠️ 位置づけ: 実ハンドラ＋擬似KV＋**擬似上流**。`/api/chat` は遅延を差し込める
//    スタブで、**実AI（Anthropic）は呼んでいない**。確認しているのは
//    「生成に時間がかかる間に別の操作が起きたとき、①のサーバーが何を守るか」。
describe('ローカル結合（実ハンドラ+擬似KV+擬似上流）: 回答生成中の同時操作', () => {
  const ROOM = 'room_ai_pending';
  // host を擬似上流に向けると、①のハンドラは `${proto}://${host}/api/chat` を呼ぶ
  const slowHeaders = () => ({ ...rootHeaders, host: `127.0.0.1:${kv.port}`, 'x-forwarded-proto': 'http' });
  const ask = (over = {}) => call({
    method: 'POST', headers: slowHeaders(),
    body: { type: 'chatai', action: 'ask', question: '生成中の確認', room_id: ROOM, request_id: 'req_p_1', client_id: 'tab_1', ...over },
  });
  const msgs = async () => ((await call({ query: { type: 'chat' }, headers: rootHeaders })).body.messages[ROOM] || []);
  const answersOf = async (rid = ROOM) => (await call({ method: 'POST', headers: rootHeaders,
    body: { type: 'chatai', action: 'get', room_id: rid } })).body.answers || {};
  const tick = (ms) => new Promise(r => setTimeout(r, ms));

  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-not-real';   // 擬似上流を通す分岐に入れるため
    await call({ method: 'POST', headers: rootHeaders, body: { type: 'chat', action: 'createRoom',
      room: { id: ROOM, kind: 'group', name: '本部/root 生成中テスト', members: ['__root__'], createdBy: '__root__' } } });
    kv.store.set(ccK('naoru:cc:flags:v1'), JSON.stringify({ cc_all: true, cc_ai_trial: true }));
    const cfg = (await call({ query: { type: 'chatai', action: 'config' }, headers: rootHeaders })).body.config || {};
    await call({ method: 'POST', headers: rootHeaders, body: { type: 'chatai', action: 'config',
      config: { trialRooms: [...(cfg.trialRooms || []), ROOM] } } });
  });
  afterAll(() => { delete process.env.ANTHROPIC_API_KEY; kv.upstream.delayMs = 0; });

  it('生成中に同じ request_id を再送すると pending が返り、回答は増えない', async () => {
    kv.upstream.delayMs = 250;
    const inflight = ask({ request_id: 'req_p_inflight' });
    await tick(60);
    const resend = await ask({ request_id: 'req_p_inflight' });     // 同じ送信の再試行
    expect(resend.body).toMatchObject({ ok: true, status: 'pending' });
    expect(resend.body.answer_message_id).toBe('');
    const first = await inflight;
    expect(first.body.ok).toBe(true);
    const ai = (await msgs()).filter(m => m.fromStaffId === '__ai__' && m.ai?.requestId === 'req_p_inflight');
    expect(ai.length).toBe(1);
    kv.upstream.delayMs = 0;
  });

  it('生成が終わった後の再送は replay（同じ回答・増えない）', async () => {
    const again = await ask({ request_id: 'req_p_inflight' });
    expect(again.body.replay).toBe(true);
    const ai = (await msgs()).filter(m => m.ai?.requestId === 'req_p_inflight');
    expect(ai.length).toBe(1);
  });

  it('生成中の通常投稿が失われない（質問・通常投稿・回答がすべて残る）', async () => {
    kv.upstream.delayMs = 250;
    const inflight = ask({ request_id: 'req_p_post', question: '生成中に通常投稿する' });
    await tick(60);
    const posted = await call({ method: 'POST', headers: rootHeaders, body: { type: 'chat', action: 'send',
      roomId: ROOM, msg: { text: '生成中に入れた通常投稿', fromStaffId: '__root__', fromName: '本部' } } });
    expect(posted.status).toBe(200);
    const done = await inflight;
    const texts = (await msgs()).map(m => m.text);
    expect(texts).toContain('生成中に通常投稿する');
    expect(texts).toContain('生成中に入れた通常投稿');
    expect((await msgs()).some(m => m.id === done.body.answer_message_id)).toBe(true);
    kv.upstream.delayMs = 0;
  });

  // ⚠️ 既知の不具合①-a（①へ報告）: 生成中に入れた訂正が、回答保存時に消える。
  //    ask は生成の**前**に loadAi した `st` を、生成の**後**にそのまま saveAi する。
  //    その間に correct が書いた corrections は上書きで失われる（lost update）。
  //    対策案: 保存直前に読み直してマージする / 訂正は別キーに追記する / CAS。
  //    直ったら失敗して気づけるよう it.fails で置いている。
  it.fails('【既知の不具合】生成中に行った本部の訂正が、生成完了時の保存で消えない', async () => {
    const base = await ask({ request_id: 'req_p_fixbase', question: '訂正の土台' });
    expect(base.body.ok).toBe(true);
    kv.upstream.delayMs = 250;
    const inflight = ask({ request_id: 'req_p_fixwin', question: '生成中に訂正する' });
    await tick(60);
    const fix = await call({ method: 'POST', headers: rootHeaders, body: { type: 'chatai', action: 'correct',
      answer_message_id: base.body.answer_message_id, text: '生成中に入れた訂正' } });
    expect(fix.body.ok).toBe(true);
    await inflight;
    kv.upstream.delayMs = 0;
    const answers = await answersOf();
    const corrections = (answers[base.body.answer_message_id] || {}).corrections || [];
    expect(corrections.map(c => c.text)).toContain('生成中に入れた訂正');
  });

  it('同じ質問文でも新しい送信（別 request_id）は別の回答になる', async () => {
    const a = await ask({ request_id: 'req_p_same_1', question: 'まったく同じ本文の質問' });
    const b = await ask({ request_id: 'req_p_same_2', question: 'まったく同じ本文の質問' });
    expect(a.body.ok && b.body.ok).toBe(true);
    expect(b.body.answer_message_id).not.toBe(a.body.answer_message_id);
    expect(b.body.replay).not.toBe(true);
    const q = (await msgs()).filter(m => m.text === 'まったく同じ本文の質問');
    expect(q.length).toBe(2);                                  // 別々の依頼として2件
  });

  // ⚠️ 既知の不具合①-b（①へ報告）: **別々の** request_id を同時に送ると、片方の
  //    回答がルームから消える。ルームのメッセージ配列も chatai ストアも
  //    「読む→足す→書く」なので、同時実行だと後勝ちで一方が失われる。
  //    （同じ request_id の同時送信＝重複生成とは別の不具合。こちらは**消失**。）
  //    対策案: KV の CAS / SETNX、または追記専用（Lua append）での保存。
  it.fails('【既知の不具合】別々の送信を同時に出しても、どちらの回答も失われない', async () => {
    kv.upstream.delayMs = 120;
    const [a, b] = await Promise.all([
      ask({ request_id: 'req_p_par_a', question: '同時送信A' }),
      ask({ request_id: 'req_p_par_b', question: '同時送信B' }),
    ]);
    kv.upstream.delayMs = 0;
    expect(a.body.ok && b.body.ok).toBe(true);
    const ids = (await msgs()).map(m => m.id);
    expect(ids).toContain(a.body.answer_message_id);
    expect(ids).toContain(b.body.answer_message_id);
    // 保存済み回答の再取得でも両方見える（st の read-modify-write で消えない）
    const answers = await answersOf();
    expect(Object.keys(answers)).toEqual(expect.arrayContaining([a.body.answer_message_id, b.body.answer_message_id]));
  });

  // ⚠️ 既知の不具合①-c（①へ報告）: 生成中に cc_ai_trial を OFF にしても、
  //    その回答はルームへ投稿される。配信直前の再確認（roomOf / isTrialRoom）に
  //    **フラグの読み直しが含まれていない**ため。
  //    → 「画面で隠すだけにしない・OFF で止まる」という前提が、生成中の窓では崩れる。
  //    対策案: 保存直前に normalizeFlags を読み直し、OFF なら投稿せず rollout_disabled。
  it.fails('【既知の不具合】生成中にフラグを OFF にしたら、その回答は投稿されない', async () => {
    kv.upstream.delayMs = 250;
    const inflight = ask({ request_id: 'req_p_flagoff', question: '生成中にフラグOFF' });
    await tick(60);
    kv.store.set(ccK('naoru:cc:flags:v1'), JSON.stringify({ cc_all: true, cc_ai_trial: false }));   // 途中でOFF
    const out = await inflight;
    kv.upstream.delayMs = 0;
    const ai = (await msgs()).filter(m => m.ai?.requestId === 'req_p_flagoff');
    kv.store.set(ccK('naoru:cc:flags:v1'), JSON.stringify({ cc_all: true, cc_ai_trial: true }));    // 後片付け
    expect(out.body.ok).toBe(false);
    expect(ai.length).toBe(0);
  });

  it('OFF にした後の新しい送信は rollout_disabled で始まらない', async () => {
    kv.store.set(ccK('naoru:cc:flags:v1'), JSON.stringify({ cc_all: true, cc_ai_trial: false }));
    const r = await ask({ request_id: 'req_p_afteroff', question: 'OFF後の送信' });
    expect(r.body.error).toMatchObject({ code: 'rollout_disabled' });
    kv.store.set(ccK('naoru:cc:flags:v1'), JSON.stringify({ cc_all: true, cc_ai_trial: true }));
  });
});
