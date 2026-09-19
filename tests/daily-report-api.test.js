// ── 日報・集客速報の自動送信（?type=dailyreport）のサーバー側検証 ──────────────
// 🔴 ここで守るのは「誰が設定を変えられるか」「勝手に送らないか」「二重に出ないか」。
//    文面そのものの検証は tests/daily-report.test.js（純粋関数）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../api/plan-store.js';
import { hashOwnerToken } from '../lib/settlement.js';
import { _clearBearerCache } from '../lib/actor.js';
import { kvEvalFake } from './helpers/kv-fake.js';

const KV = 'https://kv.test';
let store;
let soCalls;
// SalonOne の応答（テストごとに差し替える）。null = 取得失敗。
let soSummary, soChannels;

function installFetchMock() {
  store = new Map();
  soCalls = [];
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    const ok = (b) => ({ ok: true, status: 200, json: async () => b, headers: new Map() });
    if (u.startsWith(`${KV}/get/`)) { const k = decodeURIComponent(u.slice(`${KV}/get/`.length)); return ok({ result: store.has(k) ? store.get(k) : null }); }
    if (u.startsWith(`${KV}/set/`)) { store.set(decodeURIComponent(u.slice(`${KV}/set/`.length)), String(opts.body)); return ok({ result: 'OK' }); }
    if (u === KV) {
      // ⚠️ 擬似KV。実Redisではない（tests/helpers/kv-fake.js の注意書きのとおり）。
      const r = kvEvalFake(store, JSON.parse(opts.body));
      return ok(r || { result: null });
    }
    if (u.includes('salonone')) {
      soCalls.push(u);
      if (u.includes('sales/summary')) return soSummary === null ? { ok: false, status: 500, json: async () => ({}), headers: new Map() } : ok({ data: soSummary });
      if (u.includes('by-channel')) return soChannels === null ? { ok: false, status: 500, json: async () => ({}), headers: new Map() } : ok({ data: soChannels });
      return ok({ data: null });
    }
    return ok({});
  });
}

let saved;
const ENV_KEYS = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'DASHBOARD_PASSWORD', 'AUTH_SALT',
                  'CC_AGENT_TOKEN', 'CC_ENV', 'SETTLEMENT_OWNER_PASSWORDS', 'SALONONE_API_KEY', 'CRON_SECRET'];
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  process.env.KV_REST_API_URL = KV; process.env.KV_REST_API_TOKEN = 'test-token-not-a-secret';
  process.env.DASHBOARD_PASSWORD = 'pw-for-test'; process.env.AUTH_SALT = 'salt-for-test';
  process.env.CC_AGENT_TOKEN = 'agent-token-not-a-secret';
  process.env.CC_ENV = 'test';
  process.env.SETTLEMENT_OWNER_PASSWORDS = JSON.stringify({ '鶴見院オーナー': 'shop-pw' });
  process.env.SALONONE_API_KEY = 'so-key-not-a-secret';
  process.env.CRON_SECRET = 'cron-secret-not-a-secret';
  soSummary = { digest_sales: 480000, new_visit_count: 6, repeat_visit_count: 18, cancel_count: 1 };
  soChannels = [{ name: 'ホットペッパー', booking_count: 4, visit_count: 3, join_count: 2 }];
  installFetchMock(); _clearBearerCache();
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.restoreAllMocks();
});

function mockRes() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; }; r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; }; r.end = () => r; return r;
}
const ROOT = () => ({ 'x-cc-owner': '__root__', 'x-cc-token': hashOwnerToken('__root__', 'pw-for-test', 'salt-for-test') });
const AGENT = () => ({ 'x-cc-agent-token': 'agent-token-not-a-secret' });
const SHOP = () => ({ 'x-cc-owner': encodeURIComponent('鶴見院オーナー'), 'x-cc-token': hashOwnerToken('鶴見院オーナー', 'shop-pw', 'salt-for-test') });
const CRON = () => ({ authorization: 'Bearer cron-secret-not-a-secret' });

const call = async (req) => { const res = mockRes(); await handler({ headers: ROOT(), query: {}, body: {}, ...req }, res); return res; };
const get = (q, hdr) => call({ method: 'GET', headers: hdr || ROOT(), query: { type: 'dailyreport', ...q } });
const post = (body, hdr) => call({ method: 'POST', headers: hdr || ROOT(), body: { type: 'dailyreport', ...body } });

const setFlag = async (on) => post({ type: 'ccflags', action: 'set', key: 'cc_daily_report', value: on })
  .then(() => call({ method: 'POST', headers: ROOT(), body: { type: 'ccflags', action: 'set', key: 'cc_daily_report', value: on } }));
const flagOn = async () => { await call({ method: 'POST', headers: ROOT(), body: { type: 'ccflags', action: 'set', key: 'cc_daily_report', value: true } }); };

const configure = (over = {}) => post({ action: 'settings_set', shopId: '9001',
  setting: { shopName: 'テスト院', enabled: true, closing: true, preopen: true, roomId: 'room1', targetNew: 8, ...over } });

// オープン前（プレオープンより前）の店舗。本オープンは 10/1、対象月は 10月。
const configurePrep = (over = {}) => post({ action: 'settings_set', shopId: '9001',
  setting: { shopName: 'テスト院', enabled: true, roomId: 'room1', targetNew: 150,
    preOpenDate: '2026-09-27', openDate: '2026-10-01', targetDeadline: '2026-09-30',
    targetMonth: '2026-10', sendAt: '00:00', ...over } });

const roomMsgs = () => JSON.parse(store.get('naoru:chat:m:room1') || '[]');

describe('誰が設定を変えられるか', () => {
  it('本部/root は変えられる', async () => {
    const r = await configure();
    expect(r.statusCode).toBe(200);
    expect(r.body.setting.enabled).toBe(true);
  });
  it('🔴 店舗オーナーは変えられない（送信範囲を広げられない）', async () => {
    const r = await configure().then(() => post({ action: 'settings_set', shopId: '9001', setting: { enabled: true } }, SHOP()));
    expect(r.statusCode).toBe(403);
    expect(r.body.code).toBe('hq_only');
  });
  it('🔴 エージェント用トークンでも変えられない', async () => {
    const r = await post({ action: 'settings_set', shopId: '9001', setting: { enabled: true } }, AGENT());
    expect(r.statusCode).toBe(403);
  });
  it('🔴 未ログインは 403（名乗りだけでは通らない）', async () => {
    const r = await call({ method: 'POST', headers: {}, body: { type: 'dailyreport', action: 'settings_set', shopId: '9001', setting: { enabled: true }, root: true } });
    expect(r.statusCode).toBe(403);
  });
  it('店舗IDが無ければ保存しない', async () => {
    const r = await post({ action: 'settings_set', setting: { enabled: true } });
    expect(r.statusCode).toBe(400);
  });
  it('1店舗の変更が他店の設定を消さない', async () => {
    await configure();
    await post({ action: 'settings_set', shopId: '9002', setting: { shopName: '別院', enabled: true, closing: true, roomId: 'room2' } });
    const r = await get({});
    expect(Object.keys(r.body.settings.shops).sort()).toEqual(['9001', '9002']);
    expect(r.body.settings.shops['9001'].roomId).toBe('room1');
  });
});

describe('🔴 フラグがOFFの間は1通も送らない', () => {
  it('手動送信でも下書きしか返さない', async () => {
    await configure();
    const r = await post({ action: 'send', shopId: '9001', kind: 'closing' });
    expect(r.statusCode).toBe(200);
    expect(r.body.flagOn).toBe(false);
    expect(r.body.sent).toBe(false);
    expect(r.body.reason).toBe('dry_run');
    expect(roomMsgs()).toEqual([]);            // チャットには何も入っていない
  });
  it('自動実行でも送らず、予定だけ返す', async () => {
    await configure();
    const r = await get({ action: 'cronrun', kind: 'closing' }, CRON());
    expect(r.body.dry).toBe(true);
    expect(roomMsgs()).toEqual([]);
  });
  it('既定でOFFであることを画面へ伝える', async () => {
    const r = await get({});
    expect(r.body.flagOn).toBe(false);
  });
});

describe('フラグONのあとの送信', () => {
  it('チェックを入れた店舗へ1通だけ出る', async () => {
    await configure();
    await flagOn();
    const r = await post({ action: 'send', shopId: '9001', kind: 'closing' });
    expect(r.body.sent).toBe(true);
    const msgs = roomMsgs();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].roomId).toBe('room1');
    expect(msgs[0].text).toContain('【日報】テスト院');
    expect(msgs[0].text).toContain('¥480,000');
  });
  it('🔴 自動投稿だと分かる差出人で出る（人の発言と混ざらない）', async () => {
    await configure(); await flagOn();
    await post({ action: 'send', shopId: '9001', kind: 'closing' });
    const m = roomMsgs()[0];
    expect(m.fromStaffId).toBe('__daily_report__');
    expect(m.fromName).toBe('日報（自動）');
    expect(m.auto.phase).toBe('open');      // 日付未設定＝既存店なので日報
  });
  it('🔴 出典・対象期間・取得時刻が本文に入る', async () => {
    await configure(); await flagOn();
    await post({ action: 'send', shopId: '9001', kind: 'closing' });
    const t = roomMsgs()[0].text;
    expect(t).toContain('出典: SalonOne');
    expect(t).toContain('対象期間:');
    expect(t).toContain('取得時刻:');
  });
  it('🔴 同じ日に2回押しても2通にならない', async () => {
    await configure(); await flagOn();
    await post({ action: 'send', shopId: '9001', kind: 'closing' });
    const second = await post({ action: 'send', shopId: '9001', kind: 'closing' });
    expect(second.body.sent).toBe(false);
    expect(second.body.reason).toBe('same_content');
    expect(roomMsgs()).toHaveLength(1);
  });
  it('🔴 自動実行を続けて走らせても増えない', async () => {
    await configure({ trigger: 'time', closingAt: '00:00' });
    await flagOn();
    await get({ action: 'cronrun', kind: 'closing' }, CRON());
    await get({ action: 'cronrun', kind: 'closing' }, CRON());
    expect(roomMsgs()).toHaveLength(1);
  });
  it('設定していない店舗へは送らない', async () => {
    await flagOn();
    const r = await post({ action: 'send', shopId: '9999', kind: 'closing' });
    expect(r.statusCode).toBe(400);
    expect(r.body.error).toBe('shop_not_configured');
  });
  it('🔴 チェックを外した店舗へは送らない', async () => {
    await configure({ enabled: false });
    await flagOn();
    const r = await post({ action: 'send', shopId: '9001', kind: 'closing' });
    expect(r.body.sent).toBe(false);
    expect(r.body.reason).toBe('disabled');
    expect(roomMsgs()).toEqual([]);
  });
  it('🔴 送信先ルームが無ければ送らない', async () => {
    await configure({ roomId: '' });
    await flagOn();
    const r = await post({ action: 'send', shopId: '9001', kind: 'closing' });
    expect(r.body.reason).toBe('no_room');
  });
});

describe('🔴 数字が取れないときの扱い', () => {
  it('全部取れなければ送らない（0 で埋めた定型文を流さない）', async () => {
    soSummary = null; soChannels = null;
    await configure(); await flagOn();
    const r = await post({ action: 'send', shopId: '9001', kind: 'closing' });
    expect(r.body.sent).toBe(false);
    expect(r.body.reason).toBe('no_data');
    expect(roomMsgs()).toEqual([]);
  });
  it('一部だけ取れたら「未取得」と書いて送る', async () => {
    soChannels = null;
    await configure(); await flagOn();
    const r = await post({ action: 'send', shopId: '9001', kind: 'closing' });
    expect(r.body.sent).toBe(true);
    expect(roomMsgs()[0].text).toContain('未取得');
    expect(r.body.missing).toContain('媒体別');
  });
  it('SalonOne のキーが無ければ送らない', async () => {
    delete process.env.SALONONE_API_KEY;
    await configure(); await flagOn();
    const r = await post({ action: 'send', shopId: '9001', kind: 'closing' });
    expect(r.body.sent).toBe(false);
    expect(roomMsgs()).toEqual([]);
  });
});

describe('下書きの確認（送らずに見る）', () => {
  it('本部は文面を先に確かめられる', async () => {
    await configure();
    const r = await get({ action: 'preview', shopId: '9001', kind: 'closing', date: '2026-09-19' });
    expect(r.statusCode).toBe(200);
    expect(r.body.text).toContain('【日報】テスト院　9/19(土)');
    expect(roomMsgs()).toEqual([]);
  });
  it('🔴 オープン前は売上を取りに行かない（まだ営業していない）', async () => {
    await configurePrep();
    await get({ action: 'preview', shopId: '9001', phase: 'prep', date: '2026-09-19' });
    expect(soCalls.some(u => u.includes('sales/summary'))).toBe(false);
    expect(soCalls.some(u => u.includes('by-channel'))).toBe(true);
  });
  it('🔴 オープン前は対象月（本オープン月）の範囲で予約を取る', async () => {
    await configurePrep();
    await get({ action: 'preview', shopId: '9001', phase: 'prep', date: '2026-09-19' });
    const u = soCalls.find(x => x.includes('by-channel'));
    expect(u).toContain('from=2026-10-01');
    expect(u).toContain('to=2026-10-31');
  });
  it('オープン前の下書きに目標までの残りが出る', async () => {
    await configurePrep();
    const r = await get({ action: 'preview', shopId: '9001', phase: 'prep', date: '2026-09-19' });
    expect(r.body.phase).toBe('prep');
    expect(r.body.text).toContain('オープン前 集客レポート');
    expect(r.body.text).toContain('目標まで、あと');
  });
  it('期間を指定しなければ、その店舗の今日の期間になる', async () => {
    await configure();                      // 日付未設定＝既存店
    const r = await get({ action: 'preview', shopId: '9001', date: '2026-09-19' });
    expect(r.body.phase).toBe('open');
  });
  it('🔴 店舗オーナーは下書きも見られない（他店の売上が見えないように）', async () => {
    await configure();
    const r = await get({ action: 'preview', shopId: '9001' }, SHOP());
    expect(r.statusCode).toBe(403);
  });
});

describe('自動実行の入口', () => {
  it('🔴 合言葉が違えば動かない（ログインもしていないので入口で止まる）', async () => {
    await configure(); await flagOn();
    const r = await get({ action: 'cronrun', kind: 'preopen' }, { authorization: 'Bearer wrong' });
    expect(r.statusCode).not.toBe(200);
    expect(roomMsgs()).toEqual([]);
  });
  it('🔴 店舗オーナーは自動実行の入口を叩けない', async () => {
    await configure(); await flagOn();
    const r = await get({ action: 'cronrun', kind: 'preopen' }, SHOP());
    // 合言葉の照合で先に落ちる（仮に通っても、その先の cron_only でもう一度落ちる）
    expect(r.statusCode).toBe(401);
    expect(roomMsgs()).toEqual([]);
  });
  it('合言葉が合えば cron として通る（Vercel Cron が送るヘッダ）', async () => {
    await configure();
    const r = await get({ action: 'cronrun', kind: 'preopen' }, CRON());
    expect(r.statusCode).toBe(200);
  });
  it('🔴 自動実行は種類を指定できない（店舗ごとの期間で決まる）', async () => {
    await configurePrep();
    const r = await get({ action: 'cronrun', kind: 'everything' }, CRON());
    expect(r.body.kind).toBeUndefined();
    expect(r.body.results[0].phase).toBe('prep');
  });
  it('🔴 「集計実行」を観測できたとは主張しない', async () => {
    const r = await get({});
    expect(r.body.aggregateTriggerConfirmed).toBe(false);
  });
  it('集計の動きを待っている間は送らない', async () => {
    await configure({ trigger: 'aggregate' });
    await flagOn();
    const r1 = await get({ action: 'cronrun', kind: 'closing' }, CRON());
    expect(r1.body.results[0].reason).toContain('aggregate_');
    expect(roomMsgs()).toEqual([]);
  });
  it('返す結果に本文を含めない（ログに売上が残らない）', async () => {
    await configure({ trigger: 'time', closingAt: '00:00' });
    await flagOn();
    const r = await get({ action: 'cronrun', kind: 'closing' }, CRON());
    expect(r.body.results[0].text).toBeUndefined();
  });
});
