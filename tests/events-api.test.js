import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../api/plan-store.js';
import { hashOwnerToken } from '../lib/settlement.js';
import { _clearBearerCache } from '../lib/actor.js';
import { kvEvalFake } from './helpers/kv-fake.js';

const KV = 'https://kv.test';
const EVENTS = 'naoru:events:v1';
let store;

function installFetchMock() {
  store = new Map();
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    const ok = (b) => ({ ok: true, status: 200, json: async () => b, headers: new Map() });
    if (u.startsWith(`${KV}/get/`)) { const k = decodeURIComponent(u.slice(`${KV}/get/`.length)); return ok({ result: store.has(k) ? store.get(k) : null }); }
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
  saved = { u: process.env.KV_REST_API_URL, t: process.env.KV_REST_API_TOKEN,
            d: process.env.DASHBOARD_PASSWORD, s: process.env.AUTH_SALT, o: process.env.SETTLEMENT_OWNER_PASSWORDS };
  process.env.KV_REST_API_URL = KV; process.env.KV_REST_API_TOKEN = 'test-token-not-a-secret';
  process.env.DASHBOARD_PASSWORD = 'pw-for-test'; process.env.AUTH_SALT = 'salt-for-test';
  process.env.SETTLEMENT_OWNER_PASSWORDS = JSON.stringify({ '鶴見院オーナー': 'shop-pw', '関内院オーナー': 'pw2' });
  installFetchMock(); _clearBearerCache();
  // 旧データ（cells だけの行）を置く。ここを壊さないことを確かめる。
  store.set(EVENTS, JSON.stringify({ sections: {
    study: [
      { id: 'r1', cells: { date: '2026-10-08', time: '20:30-21:30', place: 'オンライン', owner: '青木',
                           ownerId: 'hq9', capacity: '2', content: 'ケースラボ', roomId: 'room_1' } },
      { id: 'r2', cells: { date: '毎週火曜', time: '未定', place: '本部', capacity: '各店1名', content: '定例' } },
    ],
    event: [{ id: 'r3', cells: { date: '9/25', time: '19:00', place: '横浜', content: '歓迎会', capacity: '' } }],
    bukatsu: [],
  } }));
});
afterEach(() => {
  for (const [k, v] of [['KV_REST_API_URL', saved.u], ['KV_REST_API_TOKEN', saved.t],
                        ['DASHBOARD_PASSWORD', saved.d], ['AUTH_SALT', saved.s], ['SETTLEMENT_OWNER_PASSWORDS', saved.o]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  vi.restoreAllMocks();
});
function mockRes() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; }; r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; }; r.end = () => r; return r;
}
const ROOT = () => ({ host: 'test.local', 'x-cc-owner': '__root__', 'x-cc-token': hashOwnerToken('__root__', 'pw-for-test', 'salt-for-test') });
const SHOP = () => ({ host: 'test.local', 'x-cc-owner': '鶴見院オーナー', 'x-cc-token': hashOwnerToken('鶴見院オーナー', 'shop-pw', 'salt-for-test') });
const call = async (req) => { const res = mockRes(); await handler({ headers: ROOT(), query: {}, body: {}, ...req }, res); return res; };
const post = (b, hdr) => call({ method: 'POST', headers: hdr || ROOT(), body: { type: 'events', ...b } });
const getEvents = (hdr) => call({ method: 'GET', headers: hdr || ROOT(), query: { type: 'events' } });
const raw = () => JSON.parse(store.get(EVENTS) || 'null');
const rsvpRaw = (id) => JSON.parse(store.get(`naoru:events:rsvp:${id}`) || 'null');

describe('🔴 旧データを壊さない', () => {
  it('いままでどおり一覧が取れる', async () => {
    const r = await getEvents();
    expect(r.body.configured).toBe(true);
    expect(r.body.sections.study).toHaveLength(2);
    expect(r.body.sections.study[0].cells.content).toBe('ケースラボ');
    expect(r.body.sections.event).toHaveLength(1);
  });
  it('参加を記録しても、表の行は1バイトも変わらない', async () => {
    const before = JSON.stringify(raw());
    await post({ action: 'rsvp', id: 'r1', want: 'going' });
    expect(JSON.stringify(raw())).toBe(before);
    expect(rsvpRaw('r1')).toBeTruthy();                       // 別キーに入る
  });
  it('追加項目を足しても cells は変わらない', async () => {
    const before = JSON.stringify(raw());
    await post({ action: 'meta_set', id: 'r1', meta: { title: '明日の施術が変わる60分' } });
    expect(JSON.stringify(raw())).toBe(before);
    expect(JSON.parse(store.get('naoru:events:meta:r1')).title).toBe('明日の施術が変わる60分');
  });
  it('一覧は追加項目もまとめて返す（行ごとに取りに来ない）', async () => {
    await post({ action: 'meta_set', id: 'r1', meta: { title: '新しい題名' } });
    const r = await getEvents();
    expect(r.body.meta.r1.title).toBe('新しい題名');
  });
  it('行の追加・削除・並べ替えは従来どおり動く', async () => {
    const up = await post({ action: 'upsertRow', section: 'bukatsu', row: { id: 'b1', cells: { date: '10/1', content: 'ランニング部' } } });
    expect(up.body.ok).toBe(true);
    expect(raw().sections.bukatsu).toHaveLength(1);
    expect((await post({ action: 'deleteRow', section: 'bukatsu', id: 'b1' })).body.ok).toBe(true);
    expect(raw().sections.bukatsu).toHaveLength(0);
  });
});

describe('権限', () => {
  it('🔴 未ログインでは何も取れない・書けない', async () => {
    const r = await call({ method: 'GET', headers: { host: 'x' }, query: { type: 'events' } });
    expect(r.statusCode).toBe(403);
    expect((await call({ method: 'POST', headers: { host: 'x' }, body: { type: 'events', action: 'rsvp', id: 'r1', want: 'going' } })).statusCode).toBe(403);
  });
  it('スタッフ（本部以外）でも参加はできる', async () => {
    const r = await post({ action: 'rsvp', id: 'r1', want: 'going' }, SHOP());
    expect(r.body.ok).toBe(true);
    expect(r.body.my).toBe('going');
  });
  it('🔴 他人の代理で参加を登録できない（本人IDはサーバーが決める）', async () => {
    await post({ action: 'rsvp', id: 'r1', want: 'going', staffId: '他人のID' }, SHOP());
    const st = rsvpRaw('r1');
    expect(Object.keys(st.v)).not.toContain('他人のID');
    expect(Object.keys(st.v)).toContain('鶴見院オーナー');
  });
  it('🔴 招待は主催者と本部だけ', async () => {
    const r = await post({ action: 'rsvp', id: 'r1', want: 'invite', staffId: 'x1' }, SHOP());
    expect(r.statusCode).toBe(403);
    expect((await post({ action: 'rsvp', id: 'r1', want: 'invite', staffId: 'x1' })).body.ok).toBe(true);
  });
  it('🔴 追加項目の編集は主催者と本部だけ', async () => {
    const r = await post({ action: 'meta_set', id: 'r1', meta: { title: '乗っ取り' } }, SHOP());
    expect(r.statusCode).toBe(403);
    expect(store.get('naoru:events:meta:r1')).toBeUndefined();
  });
  it('🔴 氏名の一覧は本部と主催者だけ（人数までは見せる）', async () => {
    await post({ action: 'rsvp', id: 'r1', want: 'going' }, SHOP());
    const staff = await post({ action: 'rsvp_list', id: 'r1', people: [{ id: '鶴見院オーナー', name: '鶴見オーナー' }] }, SHOP());
    expect(staff.body.detail).toBe(false);
    expect(staff.body.roster).toBeUndefined();
    expect(staff.body.counts.going).toBe(1);
    const hq = await post({ action: 'rsvp_list', id: 'r1', people: [{ id: '鶴見院オーナー', name: '鶴見オーナー' }] });
    expect(hq.body.detail).toBe(true);
    expect(hq.body.roster.going[0].name).toBe('鶴見オーナー');
  });
});

describe('🔴 定員はサーバーで守る', () => {
  it('定員まで参加でき、超えるとキャンセル待ちになる', async () => {
    const a = await post({ action: 'rsvp', id: 'r1', want: 'going' });                 // __root__
    expect(a.body.result).toBe('going');
    const b = await post({ action: 'rsvp', id: 'r1', want: 'going' }, SHOP());         // 鶴見院オーナー
    expect(b.body.result).toBe('going');
    expect(b.body.counts).toMatchObject({ going: 2, seatsLeft: 0, full: true });
  });
  it('🔴 連打しても席は1つしか取らない', async () => {
    for (let i = 0; i < 5; i++) await post({ action: 'rsvp', id: 'r1', want: 'going' });
    const st = rsvpRaw('r1');
    expect(Object.values(st.v).filter(x => x.s === 'going')).toHaveLength(1);
  });
  it('🔴 同時に申し込んでも定員を超えない', async () => {
    await post({ action: 'rsvp', id: 'r1', want: 'going' });
    await post({ action: 'rsvp', id: 'r1', want: 'going' }, SHOP());
    // 3人目は満席 → キャンセル待ち
    const third = await post({ action: 'rsvp', id: 'r1', want: 'going' },
      { host: 'test.local', 'x-cc-owner': '関内院オーナー', 'x-cc-token': hashOwnerToken('関内院オーナー', 'pw2', 'salt-for-test') });
    expect(third.body.result).toBe('waitlist');
    expect(third.body.counts.going).toBe(2);
  });
  it('🔴 自由文の定員では席の管理をしない（残り0と言わない）', async () => {
    const r = await post({ action: 'rsvp', id: 'r2', want: 'going' });
    expect(r.body.result).toBe('going');
    expect(r.body.counts.seatsLeft).toBe(null);
    expect(r.body.counts.capacityText).toBe('各店1名');
  });
  it('取消すとキャンセル待ちが繰り上がる', async () => {
    const THIRD = { host: 'test.local', 'x-cc-owner': '関内院オーナー', 'x-cc-token': hashOwnerToken('関内院オーナー', 'pw2', 'salt-for-test') };
    await post({ action: 'rsvp', id: 'r1', want: 'going' });
    await post({ action: 'rsvp', id: 'r1', want: 'going' }, SHOP());
    await post({ action: 'rsvp', id: 'r1', want: 'going' }, THIRD);
    const c = await post({ action: 'rsvp', id: 'r1', want: 'cancel' });
    expect(c.body.promoted).toBe('関内院オーナー');
    expect(c.body.counts).toMatchObject({ going: 2, waitlist: 0, cancelled: 1 });
  });
});

describe('🔴 「気になる」は参加ではない', () => {
  it('気になるを押しても参加人数は増えない', async () => {
    const r = await post({ action: 'rsvp', id: 'r1', want: 'interested' });
    expect(r.body.my).toBe('interested');
    expect(r.body.counts).toMatchObject({ going: 0, interested: 1 });
  });
  it('一覧の人数にも参加として出ない', async () => {
    await post({ action: 'rsvp', id: 'r1', want: 'interested' });
    const c = await post({ action: 'rsvp_counts', ids: ['r1', 'r2', 'r3'] });
    expect(c.body.counts.r1).toMatchObject({ going: 0, interested: 1 });
    expect(c.body.mine.r1).toBe('interested');
    expect(c.body.mine.r3).toBe('none');
  });
});

describe('🔴 チャットに入っているだけの人を参加予定にしない', () => {
  it('回答していないルーム参加者は「出欠未回答」として分けて返す', async () => {
    await post({ action: 'rsvp', id: 'r1', want: 'going' });
    const r = await post({ action: 'rsvp_list', id: 'r1', people: [], members: ['__root__', 'm2', 'm3'] });
    expect(r.body.counts.going).toBe(1);
    expect(r.body.chatOnly).toEqual(['m2', 'm3']);
    expect(r.body.chatOnlyLabel).toContain('未回答');
  });
});

describe('🔴 空の予定を公開させない・中止の会に申し込ませない', () => {
  it('題名の無いまま公開にできない', async () => {
    await post({ action: 'upsertRow', section: 'bukatsu', row: { id: 'empty1', cells: {} } });
    const r = await post({ action: 'meta_set', id: 'empty1', meta: { status: 'open' } });
    expect(r.body.ok).toBe(false);
    expect(r.body.message).toContain('題名');
  });
  it('題名はあっても開催日が無ければ公開できない', async () => {
    await post({ action: 'upsertRow', section: 'bukatsu', row: { id: 'empty2', cells: {} } });
    const r = await post({ action: 'meta_set', id: 'empty2', meta: { status: 'open', title: 'ランニング部' } });
    expect(r.body.ok).toBe(false);
    expect(r.body.message).toContain('開催日');
  });
  it('下書きなら題名が無くても保存できる（入力の途中を失わない）', async () => {
    await post({ action: 'upsertRow', section: 'bukatsu', row: { id: 'empty3', cells: {} } });
    expect((await post({ action: 'meta_set', id: 'empty3', meta: { status: 'draft', summary: '書きかけ' } })).body.ok).toBe(true);
    expect(JSON.parse(store.get('naoru:events:meta:empty3')).summary).toBe('書きかけ');
  });
  it('中止にした会には申し込めない', async () => {
    await post({ action: 'meta_set', id: 'r1', meta: { title: 'ケースラボ', status: 'cancelled', cancelReason: '講師都合' } });
    const r = await post({ action: 'rsvp', id: 'r1', want: 'going' });
    expect(r.body.ok).toBe(false);
    expect(r.body.message).toContain('中止');
  });
  it('知らないイベントには申し込めない', async () => {
    expect((await post({ action: 'rsvp', id: 'zzz', want: 'going' })).statusCode).toBe(404);
  });
});

describe('同時更新で行が消えない', () => {
  it('行の追加は版を1つ進める（compare-and-set）', async () => {
    await post({ action: 'upsertRow', section: 'bukatsu', row: { id: 'b1', cells: { date: '10/1' } } });
    const v1 = raw()._v;
    await post({ action: 'upsertRow', section: 'bukatsu', row: { id: 'b2', cells: { date: '10/2' } } });
    expect(raw()._v).toBe(v1 + 1);
    expect(raw().sections.bukatsu).toHaveLength(2);
    expect(raw().sections.study).toHaveLength(2);        // 他の分類を巻き込まない
  });
});
