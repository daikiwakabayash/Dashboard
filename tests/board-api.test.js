import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../api/plan-store.js';

// ── KV を模したインメモリのストア ──
// 実際のハンドラをそのまま動かして、同時更新・二重送信・古い上書きの挙動を検証する。
const KV = 'https://kv.test';
let store;

function installFetchMock() {
  store = new Map();
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, headers: new Map() });

    if (u.startsWith(`${KV}/get/`)) {
      const key = decodeURIComponent(u.slice(`${KV}/get/`.length));
      return ok({ result: store.has(key) ? store.get(key) : null });
    }
    if (u.startsWith(`${KV}/set/`)) {
      const key = decodeURIComponent(u.slice(`${KV}/set/`.length));
      store.set(key, String(opts.body));
      return ok({ result: 'OK' });
    }
    if (u === KV) {                                   // EVAL / MGET
      const cmd = JSON.parse(opts.body);
      if (cmd[0] === 'EVAL') {
        const script = cmd[1], key = cmd[3], args = cmd.slice(4);
        if (script.includes("tonumber(m[k])")) {      // 既読の単調更新
          let m = {};
          try { m = JSON.parse(store.get(key) || '{}') || {}; } catch { m = {}; }
          const k = args[0], t = Number(args[1]);
          if (t > (Number(m[k]) || 0)) m[k] = t;
          store.set(key, JSON.stringify(m));
          return ok({ result: 1 });
        }
        if (script.includes('arr[#arr+1]')) {         // 配列への追記
          let arr = [];
          try { arr = JSON.parse(store.get(key) || '[]') || []; } catch { arr = []; }
          arr.push(JSON.parse(args[0]));
          const cap = Number(args[1]);
          if (arr.length > cap) arr = arr.slice(-cap);
          store.set(key, JSON.stringify(arr));
          return ok({ result: arr.length });
        }
      }
      if (cmd[0] === 'MGET') return ok({ result: cmd.slice(1).map(k => (store.has(k) ? store.get(k) : null)) });
    }
    return ok({});                                     // push など外部呼び出しは無視
  });
}

let savedEnv;
beforeEach(() => {
  savedEnv = { u: process.env.KV_REST_API_URL, t: process.env.KV_REST_API_TOKEN };
  process.env.KV_REST_API_URL = KV;
  process.env.KV_REST_API_TOKEN = 'test-token-not-a-secret';
  installFetchMock();
});
afterEach(() => {
  if (savedEnv.u === undefined) delete process.env.KV_REST_API_URL; else process.env.KV_REST_API_URL = savedEnv.u;
  if (savedEnv.t === undefined) delete process.env.KV_REST_API_TOKEN; else process.env.KV_REST_API_TOKEN = savedEnv.t;
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
const get = () => call({ method: 'GET', query: { type: 'board' } });
const post = (body) => call({ method: 'POST', body: { type: 'board', ...body } });
const mkPost = (clientId, text, extra = {}) => ({ action: 'post', post: { clientId, authorId: 'u1', authorName: 'A', text }, ...extra });

const rawBoard = () => JSON.parse(store.get('naoru:board:v1') || 'null');
const rawReads = () => JSON.parse(store.get('naoru:board:reads:v1') || 'null');

describe('掲示板 - 既読が投稿を消さない（今回の修正の核心）', () => {
  it('既読の書き込みは投稿データに一切触れない', async () => {
    await post(mkPost('c1', '最初の投稿'));
    const before = rawBoard();

    const r = await post({ action: 'read', staffId: 'u2', ts: 1_760_000_000_000 });
    expect(r.body.ok).toBe(true);

    expect(rawBoard()).toEqual(before);            // ← 核心。投稿blobが1バイトも変わっていない
    expect(rawReads().u2).toBe(1_760_000_000_000); // 既読は別キーへ
    expect(rawReads().u1).toBeGreaterThan(0);      // 投稿者(u1)の既読も別キーで進む（投稿blobには書かない）
  });

  it('【回帰】既読の直前に入った投稿が踏み潰されない', async () => {
    // 旧実装では「Bが掲示板を開く → 投稿配列ごと書き戻す」ため、
    // その間にAが投稿すると消えていた。その並びを再現する。
    await post(mkPost('c1', '古い投稿'));
    const staleView = await get();                  // Bさんが画面を開いた時点の状態
    expect(staleView.body.posts).toHaveLength(1);

    await post(mkPost('c2', 'Bが見た後に入った投稿'));   // Aさんが投稿
    await post({ action: 'read', staffId: 'uB', ts: Date.now() }); // Bさんが既読化

    const after = await get();
    expect(after.body.posts).toHaveLength(2);       // ← 旧実装ならここが 1 になっていた
    expect(after.body.posts.map(p => p.text)).toContain('Bが見た後に入った投稿');
  });

  it('既読は巻き戻らない（古いタイムスタンプが遅れて届いても）', async () => {
    await post({ action: 'read', staffId: 'u1', ts: 2000 });
    await post({ action: 'read', staffId: 'u1', ts: 1000 });
    expect(rawReads().u1).toBe(2000);
  });

  it('他人の既読を消さない', async () => {
    await post({ action: 'read', staffId: 'u1', ts: 1000 });
    await post({ action: 'read', staffId: 'u2', ts: 2000 });
    expect(rawReads()).toEqual({ u1: 1000, u2: 2000 });
  });
});

describe('掲示板 - 同時更新 / 古いデータによる上書き', () => {
  it('古い版で更新しようとしたら 409 で弾き、先の更新を守る', async () => {
    await post(mkPost('c1', '最初'));
    const view = await get();
    const staleVersion = view.body.version;

    await post(mkPost('c2', '先に入った投稿'));          // 他の人が先に更新

    const late = await post({ ...mkPost('c3', '古い版からの投稿'), expectedVersion: staleVersion });
    expect(late.statusCode).toBe(409);
    expect(late.body.error).toBe('stale');

    const after = await get();
    expect(after.body.posts.map(p => p.text)).toContain('先に入った投稿');  // 守られている
    expect(after.body.posts.map(p => p.text)).not.toContain('古い版からの投稿');
  });

  it('409 のあと最新版で再送すれば通る（画面のリトライ相当）', async () => {
    await post(mkPost('c1', '最初'));
    const stale = (await get()).body.version;
    await post(mkPost('c2', '割り込み'));

    const first = await post({ ...mkPost('c3', 'あとから'), expectedVersion: stale });
    expect(first.statusCode).toBe(409);

    const fresh = (await get()).body.version;
    const retry = await post({ ...mkPost('c3', 'あとから'), expectedVersion: fresh });
    expect(retry.statusCode).toBe(200);
    expect((await get()).body.posts).toHaveLength(3);
  });

  it('版を送らない古いクライアントは従来どおり書ける', async () => {
    await post(mkPost('c1', '最初'));
    const r = await post(mkPost('c2', '版なし'));       // expectedVersion 未指定
    expect(r.statusCode).toBe(200);
    expect((await get()).body.posts).toHaveLength(2);
  });

  it('更新のたびに版が1つ進む', async () => {
    expect((await get()).body.version).toBe(0);
    await post(mkPost('c1', 'a'));
    expect((await get()).body.version).toBe(1);
    await post(mkPost('c2', 'b'));
    expect((await get()).body.version).toBe(2);
  });

  it('既読では版が進まない（投稿側に影響しない）', async () => {
    await post(mkPost('c1', 'a'));
    const v = (await get()).body.version;
    await post({ action: 'read', staffId: 'u9', ts: Date.now() });
    expect((await get()).body.version).toBe(v);
  });
});

describe('掲示板 - 二重送信 / 再実行', () => {
  it('同じ clientId の投稿は1件しか入らない', async () => {
    await post(mkPost('same', '二重送信'));
    const second = await post(mkPost('same', '二重送信'));
    expect(second.body.duplicate).toBe(true);
    expect((await get()).body.posts).toHaveLength(1);
  });

  it('再送でサーバー採番IDが変わっても重複しない', async () => {
    const a = await post(mkPost('same', 'x'));
    const b = await post(mkPost('same', 'x'));
    expect(b.body.post.id).toBe(a.body.post.id);     // 既存のものを返す
  });

  it('同じ clientId のコメントは1件しか入らない', async () => {
    const p = await post(mkPost('c1', '投稿'));
    const id = p.body.post.id;
    await post({ action: 'comment', id, comment: { clientId: 'cm1', fromStaffId: 'u2', fromName: 'B', text: 'コメント' } });
    const dup = await post({ action: 'comment', id, comment: { clientId: 'cm1', fromStaffId: 'u2', fromName: 'B', text: 'コメント' } });
    expect(dup.body.duplicate).toBe(true);
    expect((await get()).body.posts[0].comments).toHaveLength(1);
  });

  it('clientId が違えば別の投稿として入る', async () => {
    await post(mkPost('c1', 'x'));
    await post(mkPost('c2', 'x'));
    expect((await get()).body.posts).toHaveLength(2);
  });
});

describe('掲示板 - 通信途中の失敗', () => {
  it('既読キーへの書き込みが失敗しても投稿は保存される', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, opts) => {
      if (String(url).includes('board:reads')) throw new Error('network down');
      if (String(url) === KV) {
        const cmd = JSON.parse(opts.body);
        if (cmd[0] === 'EVAL' && String(cmd[3]).includes('board:reads')) throw new Error('network down');
      }
      return orig(url, opts);
    });
    const r = await post(mkPost('c1', '既読の保存が落ちても残る投稿'));
    expect(r.statusCode).toBe(200);
    globalThis.fetch = orig;
    expect((await get()).body.posts).toHaveLength(1);
  });

  it('保存先が落ちたらエラーを返し、壊れたデータを書き残さない', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('store unreachable'); });
    const r = await post(mkPost('c1', 'x'));
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toContain('store unreachable');
    expect(store.get('naoru:board:v1')).toBeUndefined();   // 中途半端な状態を残さない
  });
});

describe('掲示板 - 移行とRollback', () => {
  it('旧形式（reads が投稿blobの中）のデータをそのまま読める', async () => {
    store.set('naoru:board:v1', JSON.stringify({
      posts: [{ id: 'old1', text: '移行前の投稿', createdAt: '2026-08-01T00:00:00Z' }],
      reads: { legacyUser: 1_700_000_000_000 },
    }));
    const r = await get();
    expect(r.body.posts).toHaveLength(1);
    expect(r.body.reads.legacyUser).toBe(1_700_000_000_000);   // 旧既読が効く
    expect(r.body.version).toBe(0);
  });

  it('移行期間は新旧どちらの既読も読める（新しい方を採用）', async () => {
    store.set('naoru:board:v1', JSON.stringify({ posts: [], reads: { u1: 1000, u2: 5000 } }));
    store.set('naoru:board:reads:v1', JSON.stringify({ u1: 9000, u3: 7000 }));
    const r = await get();
    expect(r.body.reads).toEqual({ u1: 9000, u2: 5000, u3: 7000 });
  });

  it('新コードで投稿しても旧形式の既読を保持する（旧コードへ戻しても既読が消えない）', async () => {
    store.set('naoru:board:v1', JSON.stringify({ posts: [], reads: { legacyUser: 1234 } }));
    await post(mkPost('c1', '新コードでの投稿'));
    expect(rawBoard().reads).toEqual({ legacyUser: 1234 });   // ← Rollback の安全性の根拠
    expect(rawBoard().posts).toHaveLength(1);
  });

  it('Rollback しても投稿は失われない（新キーの既読が無視されるだけ）', async () => {
    await post(mkPost('c1', '投稿1'));
    await post({ action: 'read', staffId: 'reader', ts: 8888 });   // 投稿者とは別の閲覧者
    await post(mkPost('c2', '投稿2'));
    // 旧コードが見るのは blob だけ → 投稿は両方そこにある
    expect(rawBoard().posts).toHaveLength(2);
    expect(rawBoard().posts.map(p => p.text)).toEqual(['投稿2', '投稿1']);
    // 新キーの既読は旧コードからは見えない（未読バッジが一度出るだけで、データ損失ではない）
    expect(rawReads().reader).toBe(8888);
  });
});

describe('掲示板 - 既存の操作が壊れていない', () => {
  it('ピン留め・リアクション・コメント・削除が従来どおり動く', async () => {
    const p = await post(mkPost('c1', '本文'));
    const id = p.body.post.id;

    expect((await post({ action: 'pin', id, pinned: true })).body.ok).toBe(true);
    expect((await get()).body.posts[0].pinned).toBe(true);

    await post({ action: 'react', id, emoji: '👍', staffId: 'u2' });
    expect((await get()).body.posts[0].reactions).toBeTruthy();

    await post({ action: 'comment', id, comment: { clientId: 'x', fromStaffId: 'u2', fromName: 'B', text: 'コメント' } });
    expect((await get()).body.posts[0].comments).toHaveLength(1);

    await post({ action: 'delete', id, staffId: 'u1' });
    expect((await get()).body.posts).toHaveLength(0);
  });

  it('リアクションした人の既読も進む（別キーへ）', async () => {
    const p = await post(mkPost('c1', 'x'));
    await post({ action: 'react', id: p.body.post.id, emoji: '👍', staffId: 'u2' });
    expect(rawReads().u2).toBeGreaterThan(0);
  });

  it('存在しない投稿へのコメントは 404', async () => {
    const r = await post({ action: 'comment', id: 'nope', comment: { fromStaffId: 'u1', fromName: 'A', text: 'x' } });
    expect(r.statusCode).toBe(404);
  });

  it('不正なアクションは 400', async () => {
    expect((await post({ action: 'drop_everything' })).statusCode).toBe(400);
  });
});
