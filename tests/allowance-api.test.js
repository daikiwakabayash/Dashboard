import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../api/plan-store.js';
import { hashOwnerToken } from '../lib/settlement.js';

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
      store.set(decodeURIComponent(u.slice(`${KV}/set/`.length)), String(opts.body));
      return ok({ result: 'OK' });
    }
    if (u === KV) {
      const cmd = JSON.parse(opts.body);
      if (cmd[0] === 'EVAL' && String(cmd[1]).includes('arr[#arr+1]')) {
        const key = cmd[3], args = cmd.slice(4);
        let arr = [];
        try { arr = JSON.parse(store.get(key) || '[]') || []; } catch { arr = []; }
        arr.push(JSON.parse(args[0]));
        const cap = Number(args[1]);
        if (arr.length > cap) arr = arr.slice(-cap);
        store.set(key, JSON.stringify(arr));
        return ok({ result: arr.length });
      }
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
});
afterEach(() => {
  if (saved.u === undefined) delete process.env.KV_REST_API_URL; else process.env.KV_REST_API_URL = saved.u;
  if (saved.t === undefined) delete process.env.KV_REST_API_TOKEN; else process.env.KV_REST_API_TOKEN = saved.t;
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
// 社内限定データはログインが必須（誰でも取れる状態を塞いだため）。
// テストは「ログイン済みの正規ユーザー」を表すので、資格情報を付けて呼ぶ。
const AUTH_HDR = () => {
  process.env.DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'pw-for-test';
  process.env.AUTH_SALT = process.env.AUTH_SALT || 'salt-for-test';
  return { 'x-cc-owner': '__root__', 'x-cc-token': hashOwnerToken('__root__', process.env.DASHBOARD_PASSWORD, process.env.AUTH_SALT) };
};
const call = async (req) => {
  const res = mockRes();
  await handler({ headers: { ...AUTH_HDR(), ...(req.headers || {}) }, query: {}, body: {}, ...req, headers: { ...AUTH_HDR(), ...(req.headers || {}) } }, res);
  return res;
};
const get = () => call({ method: 'GET', query: { type: 'allowance' } });
const post = (body) => call({ method: 'POST', body: { type: 'allowance', ...body } });
const sub = (id, amount = 1000, over = {}) => ({ id, staffId: 's1', staffName: 'サンプル太郎', month: '2026-08', category: '健康手当', amount, ...over });

const rawLegacy = () => JSON.parse(store.get('naoru:allowance:v1') || 'null');
const rawLog = () => JSON.parse(store.get('naoru:allowance:log:v1') || 'null');
const rawProd = () => JSON.parse(store.get('naoru:allowance:prod:v1') || 'null');

describe('手当 - 生産性の記録が提出を消さない（今回の修正の核心）', () => {
  it('recordProductivity は提出データに一切触れない', async () => {
    await post({ action: 'submit', submission: sub('a1') });
    const logBefore = rawLog();
    const legacyBefore = rawLegacy();

    await post({ action: 'recordProductivity', staffId: 's9', month: '2026-08', gross: 1_200_000 });

    expect(rawLog()).toEqual(logBefore);           // 提出ログが変わっていない
    expect(rawLegacy()).toEqual(legacyBefore);     // 旧blobの写しも変わっていない
    expect(rawProd()).toEqual({ s9: { '2026-08': 1_200_000 } });
  });

  it('【回帰】提出の直後に返金明細書が開かれても提出が消えない', async () => {
    // 旧実装では recordProductivity が submissions ごと書き戻していたため、
    // その直前の提出が消えていた。その並びを再現する。
    await post({ action: 'submit', submission: sub('old') });
    await get();                                    // 本部が明細書を開いた時点の状態

    await post({ action: 'submit', submission: sub('新しい提出') });       // スタッフが締切前に提出
    await post({ action: 'recordProductivity', staffId: 's1', month: '2026-08', gross: 1_000_000 });

    const after = await get();
    expect(after.body.submissions.map(s => s.id).sort()).toEqual(['old', '新しい提出']);
  });

  it('生産性は1人・1ヶ月ずつ更新され、他に影響しない', async () => {
    await post({ action: 'recordProductivity', staffId: 's1', month: '2026-07', gross: 100 });
    await post({ action: 'recordProductivity', staffId: 's1', month: '2026-08', gross: 200 });
    await post({ action: 'recordProductivity', staffId: 's2', month: '2026-08', gross: 300 });
    expect(rawProd()).toEqual({ s1: { '2026-07': 100, '2026-08': 200 }, s2: { '2026-08': 300 } });
  });
});

describe('手当 - 同時提出', () => {
  it('締切前に複数人が同時に提出しても互いを消さない', async () => {
    const ids = ['a1', 'b1', 'c1', 'd1', 'e1'];
    await Promise.all(ids.map(id => post({ action: 'submit', submission: sub(id) })));
    const r = await get();
    expect(r.body.submissions.map(s => s.id).sort()).toEqual([...ids].sort());
  });

  it('提出は追記なので、古い状態を持っていても上書きにならない', async () => {
    await post({ action: 'submit', submission: sub('a1') });
    const stale = await get();                      // 誰かが古い一覧を持っている
    expect(stale.body.submissions).toHaveLength(1);
    await post({ action: 'submit', submission: sub('b1') });   // 別の人が提出
    await post({ action: 'submit', submission: sub('c1') });   // 古い状態を持っていた人が提出
    expect((await get()).body.submissions).toHaveLength(3);
  });
});

describe('手当 - 二重送信 / 再実行', () => {
  it('同じ内容の再送は1件のまま', async () => {
    await post({ action: 'submit', submission: sub('a1', 1000) });
    const second = await post({ action: 'submit', submission: sub('a1', 1000) });
    expect(second.body.duplicate).toBe(true);
    expect((await get()).body.submissions).toHaveLength(1);
  });
  it('金額を直した再提出は反映される（修正はできる）', async () => {
    await post({ action: 'submit', submission: sub('a1', 1000) });
    await post({ action: 'submit', submission: sub('a1', 2500) });
    const r = await get();
    expect(r.body.submissions).toHaveLength(1);
    expect(r.body.submissions[0].amount).toBe(2500);
  });
  it('取消のあと再提出できる', async () => {
    await post({ action: 'submit', submission: sub('a1') });
    await post({ action: 'delete', id: 'a1' });
    expect((await get()).body.submissions).toHaveLength(0);
    await post({ action: 'submit', submission: sub('a1', 3000) });
    expect((await get()).body.submissions[0].amount).toBe(3000);
  });
});

describe('手当 - 通信途中の失敗', () => {
  it('旧blobへの写しが失敗しても提出は残る（ログが正）', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, opts) => {
      if (String(url).includes('/set/naoru%3Aallowance%3Av1')) throw new Error('mirror failed');
      return orig(url, opts);
    });
    const r = await post({ action: 'submit', submission: sub('a1') });
    expect(r.body.ok).toBe(true);
    globalThis.fetch = orig;
    expect((await get()).body.submissions.map(s => s.id)).toEqual(['a1']);   // ログから読める
  });

  it('保存先が落ちたらエラーを返し、壊れたデータを書き残さない', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('store unreachable'); });
    const r = await post({ action: 'submit', submission: sub('a1') });
    expect(r.body.ok).toBe(false);
    expect(store.get('naoru:allowance:log:v1')).toBeUndefined();
  });

  it('壊れた提出はログに積まない', async () => {
    const r = await post({ action: 'submit', submission: { amount: 100 } });   // id が無い
    expect(r.statusCode).toBe(400);
    expect(rawLog()).toBeNull();
  });
});

describe('手当 - 移行とRollback', () => {
  it('旧形式（提出も生産性も旧blob）のデータをそのまま読める', async () => {
    store.set('naoru:allowance:v1', JSON.stringify({
      submissions: [sub('old1'), sub('old2')],
      productivity: { s1: { '2026-07': 900_000 } },
    }));
    const r = await get();
    expect(r.body.submissions.map(s => s.id)).toEqual(['old1', 'old2']);
    expect(r.body.productivity).toEqual({ s1: { '2026-07': 900_000 } });
  });

  it('移行期間は旧blobとログの両方が見える', async () => {
    store.set('naoru:allowance:v1', JSON.stringify({ submissions: [sub('old1')], productivity: {} }));
    await post({ action: 'submit', submission: sub('new1') });
    const r = await get();
    expect(r.body.submissions.map(s => s.id).sort()).toEqual(['new1', 'old1']);
  });

  it('新コードの提出は旧blobにも写され、Rollback しても残る', async () => {
    await post({ action: 'submit', submission: sub('a1') });
    await post({ action: 'submit', submission: sub('b1') });
    // 旧コードが見るのは旧blobだけ → そこに両方ある
    expect(rawLegacy().submissions.map(s => s.id).sort()).toEqual(['a1', 'b1']);
  });

  it('新コードは旧blobの生産性を壊さない（Rollback後も残る）', async () => {
    store.set('naoru:allowance:v1', JSON.stringify({ submissions: [], productivity: { s1: { '2026-07': 777 } } }));
    await post({ action: 'submit', submission: sub('a1') });
    await post({ action: 'recordProductivity', staffId: 's1', month: '2026-08', gross: 888 });
    expect(rawLegacy().productivity).toEqual({ s1: { '2026-07': 777 } });   // 旧の値は保持
    expect((await get()).body.productivity).toEqual({ s1: { '2026-07': 777, '2026-08': 888 } });  // 表示は合成
  });

  it('旧blobの取消もログ経由で反映される', async () => {
    store.set('naoru:allowance:v1', JSON.stringify({ submissions: [sub('old1')], productivity: {} }));
    await post({ action: 'delete', id: 'old1' });
    expect((await get()).body.submissions).toHaveLength(0);
    expect(rawLegacy().submissions).toHaveLength(0);   // 写しからも消える
  });
});

describe('手当 - 既存の応答が変わっていない', () => {
  it('GET の形（submissions / productivity / configured）が従来どおり', async () => {
    const r = await get();
    expect(r.statusCode).toBe(200);
    expect(Array.isArray(r.body.submissions)).toBe(true);
    expect(typeof r.body.productivity).toBe('object');
    expect(r.body.configured).toBe(true);
  });
  it('submit は id を返す', async () => {
    const r = await post({ action: 'submit', submission: sub('a1') });
    expect(r.body).toMatchObject({ ok: true, id: 'a1' });
  });
  it('不正なアクションは 400', async () => {
    expect((await post({ action: 'nope' })).statusCode).toBe(400);
  });
});

// ── Supabase / GAS へフォールバックしたときの安全性 ──
// 本番の保存経路は KV だが、KV が外れた場合に何が起きるかを確認しておく。
describe('手当 - 非KV経路（Supabase/GAS フォールバック）', () => {
  // KV を外して GAS 経路にする
  const useGas = () => {
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    process.env.SETTLEMENT_GAS_URL = 'https://gas.test/exec';
  };
  const gasStore = () => {
    const mem = new Map();
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
      const u = String(url);
      const ok = (b) => ({ ok: true, status: 200, json: async () => b, headers: new Map() });
      if (u.startsWith('https://gas.test/exec?type=kv&key=')) {
        const key = decodeURIComponent(u.split('key=')[1]);
        return ok({ value: mem.has(key) ? JSON.parse(mem.get(key)) : null });
      }
      if (u === 'https://gas.test/exec' && opts.method === 'POST') {
        const b = JSON.parse(opts.body);
        if (b.action === 'saveKv') { mem.set(b.key, JSON.stringify(b.value)); return ok({ ok: true }); }
      }
      return ok({});
    });
    return mem;
  };
  afterEach(() => { delete process.env.SETTLEMENT_GAS_URL; });

  it('非KVでも提出は保存され、読み出せる', async () => {
    useGas(); gasStore();
    const r = await post({ action: 'submit', submission: sub('g1') });
    expect(r.body.ok).toBe(true);
    expect(r.body.atomic).toBe(false);          // 原子的でないことを応答で区別できる
    expect((await get()).body.submissions.map(s => s.id)).toEqual(['g1']);
  });

  it('書き込みが反映されない場合は 503 を返す（黙って成功にしない）', async () => {
    useGas();
    // 書いても保存されないGAS（＝他の書き込みに踏まれ続ける状況）を模擬
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
      const u = String(url);
      const ok = (b) => ({ ok: true, status: 200, json: async () => b, headers: new Map() });
      if (u.includes('type=kv')) return ok({ value: null });      // 常に空が返る
      return ok({ ok: true });                                    // 書き込みは成功したふり
    });
    const r = await post({ action: 'submit', submission: sub('lost') });
    expect(r.statusCode).toBe(503);
    expect(r.body.error).toBe('not_durable');
    expect(r.body.message).toContain('保存できませんでした');
  });

  it('やり直しの途中で既に入っていたら重複させない', async () => {
    useGas();
    const mem = gasStore();
    const r1 = await post({ action: 'submit', submission: sub('dup1') });
    expect(r1.body.ok).toBe(true);
    const logAfterFirst = JSON.parse(mem.get('naoru:allowance:log:v1'));
    expect(logAfterFirst).toHaveLength(1);
    // 同じ内容をもう一度（二重送信）
    const r2 = await post({ action: 'submit', submission: sub('dup1') });
    expect(r2.body.duplicate).toBe(true);
    expect(JSON.parse(mem.get('naoru:allowance:log:v1'))).toHaveLength(1);
  });

  it('非KVでも生産性は提出に触れない', async () => {
    useGas(); const mem = gasStore();
    await post({ action: 'submit', submission: sub('p1') });
    const logBefore = mem.get('naoru:allowance:log:v1');
    await post({ action: 'recordProductivity', staffId: 's1', month: '2026-08', gross: 500 });
    expect(mem.get('naoru:allowance:log:v1')).toBe(logBefore);
  });
});
