import { describe, it, expect } from 'vitest';
import {
  CLOSING, PREOPEN, TRIGGERS, NOT_FETCHED, DEFAULT_PREOPEN_AT,
  jstYmd, jstHm, ymdLabel, hmToMinutes, normalizeHm,
  normalizeShopSetting, normalizeSettings, targetsFor, settingReady,
  yen, people, percent, rate, footer,
  buildClosingReport, buildPreOpenReport, buildReport, reportReady,
  sendKey, contentHash, alreadySent, shouldSend, recordSent,
  detectAggregationRun, advanceObservation, timeReached, planRun,
  normalizeSummary, normalizeChannels,
} from '../lib/daily-report.js';

// 合成データのみ。実店舗名・実売上は使わない。
const SHOP = { shopId: '9001', shopName: 'テスト院' };

const summary = (o = {}) => ({
  grossSales: 482000, newSales: 180000, repeatSales: 302000,
  newVisit: 6, repeatVisit: 18, cancel: 2, noShow: 0, ...o,
});
const channels = () => ([
  { name: 'ホットペッパー', booking: 4, visit: 3, join: 2, cancel: 1 },
  { name: 'Google', booking: 2, visit: 2, join: 1, cancel: 0 },
]);

// 2026-09-19 21:05 JST = 12:05 UTC
const AT = Date.UTC(2026, 8, 19, 12, 5);

describe('JSTの時刻', () => {
  it('UTCではなくJSTで日付が決まる', () => {
    // 2026-09-19 23:30 JST は UTC では 14:30（同日）
    expect(jstYmd(Date.UTC(2026, 8, 19, 14, 30))).toBe('2026-09-19');
    // 2026-09-19 15:30 UTC = 2026-09-20 00:30 JST → 翌日になる
    expect(jstYmd(Date.UTC(2026, 8, 19, 15, 30))).toBe('2026-09-20');
  });
  it('時刻もJST', () => {
    expect(jstHm(AT)).toBe('21:05');
  });
  it('曜日つきの表示', () => {
    expect(ymdLabel('2026-09-19')).toBe('9/19(土)');
  });
  it('🔴 読めない日付でも Invalid Date を出さない', () => {
    expect(ymdLabel('')).toBe('');
    expect(ymdLabel('2026/09/19')).toBe('');
    expect(ymdLabel(null)).toBe('');
  });
  it('HH:MM の解釈（未設定と 0:00 を混同しない）', () => {
    expect(hmToMinutes('10:00')).toBe(600);
    expect(hmToMinutes('0:00')).toBe(0);
    expect(hmToMinutes('')).toBe(null);
    expect(hmToMinutes('25:00')).toBe(null);
    expect(hmToMinutes('10:60')).toBe(null);
    expect(normalizeHm('9:5', '10:00')).toBe('10:00');
    expect(normalizeHm('9:05')).toBe('09:05');
  });
});

describe('店舗ごとの設定', () => {
  it('🔴 既定は自動送信OFF', () => {
    const s = normalizeShopSetting({}, '9001');
    expect(s.enabled).toBe(false);
    expect(s.closing).toBe(false);
    expect(s.preopen).toBe(false);
    expect(s.roomId).toBe('');
  });
  it('真偽値以外を true に格上げしない', () => {
    const s = normalizeShopSetting({ enabled: 'true', closing: 1 }, '9001');
    expect(s.enabled).toBe(false);
    expect(s.closing).toBe(false);
  });
  it('未知のきっかけは既定(aggregate)へ落とす', () => {
    expect(normalizeShopSetting({ trigger: 'webhook' }).trigger).toBe('aggregate');
    for (const t of TRIGGERS) expect(normalizeShopSetting({ trigger: t }).trigger).toBe(t);
  });
  it('目標人数: 未設定(null)と 0人 を区別する', () => {
    expect(normalizeShopSetting({ targetNew: null }).targetNew).toBe(null);
    expect(normalizeShopSetting({ targetNew: '' }).targetNew).toBe(null);
    expect(normalizeShopSetting({ targetNew: -3 }).targetNew).toBe(null);
    expect(normalizeShopSetting({ targetNew: 0 }).targetNew).toBe(0);
    expect(normalizeShopSetting({ targetNew: '8' }).targetNew).toBe(8);
  });
  it('既定の速報時刻', () => {
    expect(normalizeShopSetting({}).preopenAt).toBe(DEFAULT_PREOPEN_AT);
  });
  it('壊れた保存データでも落ちない', () => {
    expect(normalizeSettings(null).shops).toEqual({});
    expect(normalizeSettings({ shops: [] }).shops).toEqual({});
    expect(normalizeSettings('x').shops).toEqual({});
  });
});

describe('🔴 送信対象は「チェックを入れた店舗」だけ（全店一括にしない）', () => {
  const settings = {
    shops: {
      a: { shopId: 'a', enabled: true, closing: true, roomId: 'r1' },
      b: { shopId: 'b', enabled: false, closing: true, roomId: 'r2' },  // OFF
      c: { shopId: 'c', enabled: true, closing: true, roomId: '' },     // 送信先なし
      d: { shopId: 'd', enabled: true, closing: false, preopen: true, roomId: 'r4' },
    },
  };
  it('日報の対象は a だけ', () => {
    expect(targetsFor(settings, CLOSING).map(x => x.shopId)).toEqual(['a']);
  });
  it('速報の対象は d だけ', () => {
    expect(targetsFor(settings, PREOPEN).map(x => x.shopId)).toEqual(['d']);
  });
  it('未知の種別では 1 件も返らない', () => {
    expect(targetsFor(settings, 'all')).toEqual([]);
    expect(targetsFor(settings, '')).toEqual([]);
  });
  it('設定が空なら 1 件も返らない', () => {
    expect(targetsFor(null, CLOSING)).toEqual([]);
    expect(targetsFor({}, CLOSING)).toEqual([]);
  });
  it('送れない理由を人に説明できる', () => {
    expect(settingReady({ enabled: false }).reason).toBe('disabled');
    expect(settingReady({ enabled: true }).reason).toBe('no_kind');
    expect(settingReady({ enabled: true, closing: true }).reason).toBe('no_room');
    expect(settingReady({ enabled: true, closing: true, roomId: 'r' }).ok).toBe(true);
  });
});

describe('🔴 取れなかった数値を 0 で埋めない', () => {
  it('未取得は「未取得」と書く', () => {
    expect(yen(null)).toBe(NOT_FETCHED);
    expect(yen(undefined)).toBe(NOT_FETCHED);
    expect(yen(NaN)).toBe(NOT_FETCHED);
    expect(people(null)).toBe(NOT_FETCHED);
    expect(percent(null)).toBe(NOT_FETCHED);
  });
  it('本当の 0 は 0 と書く', () => {
    expect(yen(0)).toBe('¥0');
    expect(people(0)).toBe('0名');
  });
  it('分母が無い率は作らない（0% と書かない）', () => {
    expect(rate(3, 0)).toBe(null);
    expect(rate(3, null)).toBe(null);
    expect(rate(null, 6)).toBe(null);
    expect(rate(3, 6)).toBe(50);
  });
  it('売上が取れていない日報は「未取得」を出し missing に積む', () => {
    const r = buildClosingReport({ ...SHOP, ymd: '2026-09-19', summary: null, channels: channels(), fetchedAt: AT });
    expect(r.text).toContain(NOT_FETCHED);
    expect(r.text).not.toContain('¥0');
    expect(r.missing).toContain('売上');
  });
});

describe('① 営業後の日報', () => {
  const r = buildClosingReport({ ...SHOP, ymd: '2026-09-19', summary: summary(), channels: channels(), target: 8, fetchedAt: AT });
  it('見出しに店舗と日付が入る', () => {
    expect(r.lines[0]).toBe('【日報】テスト院　9/19(土)');
  });
  it('売上・来店・入会が出る', () => {
    expect(r.text).toContain('¥482,000');
    expect(r.text).toContain('来店 24名（新規 6名 ／ 既存 18名）');
    expect(r.text).toContain('入会 3名（入会率 50%）');   // 2+1 入会 ÷ 新規来店 6
  });
  it('目標に対する不足を出す', () => {
    expect(r.text).toContain('あと 2名');
  });
  it('目標を達成していれば「達成」', () => {
    const t = buildClosingReport({ ...SHOP, ymd: '2026-09-19', summary: summary({ newVisit: 9 }), channels: channels(), target: 8, fetchedAt: AT });
    expect(t.text).toContain('達成');
    expect(t.text).not.toContain('あと');
  });
  it('🔴 目標が未設定なら目標行を出さない（0人が目標、と書かない）', () => {
    const t = buildClosingReport({ ...SHOP, ymd: '2026-09-19', summary: summary(), channels: channels(), fetchedAt: AT });
    expect(t.text).not.toContain('目標');
  });
  it('媒体別が並ぶ', () => {
    expect(r.text).toContain('ホットペッパー');
    expect(r.text).toContain('Google');
  });
  it('🔴 出典・対象期間・取得時刻が必ず付く', () => {
    expect(r.text).toContain('出典: SalonOne sales/summary / marketing/by-channel');
    expect(r.text).toContain('対象期間: 2026-09-19（1日）');
    expect(r.text).toContain('取得時刻: 2026-09-19 21:05 JST');
  });
  it('🔴 確定前の可能性を文面で断る（推測を実績として出さない）', () => {
    expect(r.text).toContain('確定前の値になることがあります');
  });
  it('入力が空でも落ちない', () => {
    const e = buildClosingReport({});
    expect(typeof e.text).toBe('string');
    expect(e.text).toContain('(店舗名未取得)');
  });
});

describe('② オープン前の集客速報', () => {
  const r = buildPreOpenReport({ ...SHOP, ymd: '2026-09-19', channels: channels(), target: 8, fetchedAt: Date.UTC(2026, 8, 19, 0, 30) });
  it('何時点かが分かる', () => {
    expect(r.lines[0]).toContain('9:30 時点');
  });
  it('媒体ごとの予約数と合計が出る', () => {
    expect(r.text).toContain('ホットペッパー　4件');
    expect(r.text).toContain('Google　2件');
    expect(r.text).toContain('本日の新規予約　5名');   // 予約6 − キャンセル1
  });
  it('目標まであと何人かを出す', () => {
    expect(r.text).toContain('あと 3名');
  });
  it('🔴 目標未設定なら「あと何人」を作らず、設定を促す', () => {
    const t = buildPreOpenReport({ ...SHOP, ymd: '2026-09-19', channels: channels(), fetchedAt: AT });
    expect(t.text).toContain('目標　未設定');
    expect(t.text).not.toContain('あと ');
  });
  it('🔴 予約が取れていなければ「未取得」（0名と書かない）', () => {
    const t = buildPreOpenReport({ ...SHOP, ymd: '2026-09-19', channels: null, target: 8, fetchedAt: AT });
    expect(t.text).toContain(`本日の新規予約　${NOT_FETCHED}`);
    expect(t.missing).toContain('媒体別の予約');
  });
  it('売上は出さない（まだ来ていないため）', () => {
    expect(r.text).not.toContain('売上');
  });
  it('出典が marketing/by-channel だけ', () => {
    expect(r.text).toContain('出典: SalonOne marketing/by-channel');
    expect(r.text).not.toContain('sales/summary');
  });
  it('buildReport で種別を選べる', () => {
    expect(buildReport(PREOPEN, { ...SHOP, ymd: '2026-09-19' }).kind).toBe(PREOPEN);
    expect(buildReport(CLOSING, { ...SHOP, ymd: '2026-09-19' }).kind).toBe(CLOSING);
    expect(buildReport('unknown', { ...SHOP, ymd: '2026-09-19' }).kind).toBe(CLOSING);
  });
});

describe('🔴 中身の無い定型文を流さない', () => {
  it('数字が1つも取れていなければ送らない', () => {
    const r = buildClosingReport({ ...SHOP, ymd: '2026-09-19', summary: null, channels: null, fetchedAt: AT });
    expect(reportReady(r).ok).toBe(false);
    expect(reportReady(r).reason).toBe('no_data');
  });
  it('1つでも取れていれば送れる', () => {
    const r = buildClosingReport({ ...SHOP, ymd: '2026-09-19', summary: summary(), channels: null, fetchedAt: AT });
    expect(reportReady(r).ok).toBe(true);
  });
  it('壊れた入力でも false 側へ倒れる', () => {
    expect(reportReady(null).ok).toBe(false);
    expect(reportReady({}).ok).toBe(false);
  });
});

describe('🔴 二重送信の防止', () => {
  const key = sendKey('9001', '2026-09-19', CLOSING);
  const text = 'こんにちは';
  const hash = contentHash(text);

  it('キーは 店舗・日・種別 で決まる', () => {
    expect(key).toBe('9001|2026-09-19|closing');
    expect(sendKey('9001', '2026-09-20', CLOSING)).not.toBe(key);
    expect(sendKey('9002', '2026-09-19', CLOSING)).not.toBe(key);
    expect(sendKey('9001', '2026-09-19', PREOPEN)).not.toBe(key);
  });
  it('内容が違えば指紋も違う', () => {
    expect(contentHash('a')).not.toBe(contentHash('b'));
    expect(contentHash(text)).toBe(hash);
  });
  it('1回目は送る', () => {
    expect(shouldSend({ log: {}, key, hash }).send).toBe(true);
  });
  it('2回目（同じ内容）は送らない', () => {
    const log = recordSent({}, key, { at: AT, hash, messageId: 'm1', roomId: 'r1' });
    expect(shouldSend({ log, key, hash }).reason).toBe('same_content');
    // force でも同じ内容なら止める（押し間違いの連投を防ぐ）
    expect(shouldSend({ log, key, hash, force: true }).send).toBe(false);
  });
  it('内容が変わっても、人が明示しない限り送らない', () => {
    const log = recordSent({}, key, { at: AT, hash, messageId: 'm1', roomId: 'r1' });
    expect(shouldSend({ log, key, hash: contentHash('別の内容') }).reason).toBe('already');
    expect(shouldSend({ log, key, hash: contentHash('別の内容'), force: true }).send).toBe(true);
  });
  it('別の日・別の店舗は独立して送れる', () => {
    const log = recordSent({}, key, { at: AT, hash });
    expect(shouldSend({ log, key: sendKey('9001', '2026-09-20', CLOSING), hash }).send).toBe(true);
    expect(shouldSend({ log, key: sendKey('9002', '2026-09-19', CLOSING), hash }).send).toBe(true);
  });
  it('記録は元のオブジェクトを書き換えない', () => {
    const log = {};
    const next = recordSent(log, key, { at: AT, hash });
    expect(log).toEqual({});
    expect(alreadySent(next, key).hash).toBe(hash);
    expect(alreadySent({}, key)).toBe(null);
    expect(alreadySent(null, key)).toBe(null);
  });
});

describe('① のきっかけ（代理シグナル・仮案）', () => {
  it('初回の観測では送らない（比べる相手がいない）', () => {
    expect(detectAggregationRun(null, { digest: 100, at: AT }).reason).toBe('first_observation');
    expect(detectAggregationRun({ digest: null }, { digest: 100, at: AT }).reason).toBe('first_observation');
  });
  it('値が取れていなければ送らない', () => {
    expect(detectAggregationRun({ digest: 100 }, { digest: null, at: AT }).reason).toBe('no_data');
    expect(detectAggregationRun({ digest: 100 }, null).settled).toBe(false);
  });
  it('動いた直後は「まだ集計中かもしれない」ので送らない', () => {
    const r = detectAggregationRun({ digest: 100, at: AT - 60000, lastMovedAt: AT - 60000 }, { digest: 480000, at: AT });
    expect(r.changed).toBe(true);
    expect(r.settled).toBe(false);
  });
  it('動いた後しばらく動かなければ「集計が終わった」とみなす', () => {
    const prev = { digest: 480000, at: AT - 40 * 60000, lastMovedAt: AT - 40 * 60000 };
    expect(detectAggregationRun(prev, { digest: 480000, at: AT }).settled).toBe(true);
    // 落ち着き待ち時間を長くすれば、まだ送らない
    expect(detectAggregationRun(prev, { digest: 480000, at: AT }, 60).settled).toBe(false);
  });
  it('一度も動いていない日は送らない（休業日に空の日報を出さない）', () => {
    const prev = { digest: 0, at: AT - 60 * 60000, lastMovedAt: null };
    expect(detectAggregationRun(prev, { digest: 0, at: AT }).settled).toBe(false);
  });
  it('観測の更新で「最後に動いた時刻」を持ち越す', () => {
    const a = advanceObservation(null, { digest: 100, at: 1000 });
    expect(a.lastMovedAt).toBe(1000);
    const b = advanceObservation(a, { digest: 100, at: 2000 });
    expect(b.lastMovedAt).toBe(1000);     // 動いていないので据え置き
    const c = advanceObservation(b, { digest: 200, at: 3000 });
    expect(c.lastMovedAt).toBe(3000);     // 動いたので更新
  });
});

describe('指定時刻の判定', () => {
  const t0930 = Date.UTC(2026, 8, 19, 0, 30);   // 09:30 JST
  it('時刻を過ぎていれば true', () => {
    expect(timeReached('09:00', t0930)).toBe(true);
    expect(timeReached('09:30', t0930)).toBe(true);
    expect(timeReached('10:00', t0930)).toBe(false);
  });
  it('不正な時刻は false（=送らない側へ倒す）', () => {
    expect(timeReached('', t0930)).toBe(false);
    expect(timeReached('9時', t0930)).toBe(false);
  });
});

describe('実行計画（送る前に、何が送られるか分かる）', () => {
  const settings = {
    shops: {
      a: { shopId: 'a', enabled: true, preopen: true, roomId: 'r1', preopenAt: '09:00' },
      b: { shopId: 'b', enabled: true, preopen: true, roomId: 'r2', preopenAt: '11:00' },
      c: { shopId: 'c', enabled: true, closing: true, roomId: 'r3', trigger: 'time', closingAt: '22:00' },
      d: { shopId: 'd', enabled: true, closing: true, roomId: 'r4', trigger: 'manual' },
      e: { shopId: 'e', enabled: true, closing: true, roomId: 'r5', trigger: 'aggregate' },
    },
  };
  const t0930 = Date.UTC(2026, 8, 19, 0, 30);
  it('速報は時刻を過ぎた店舗だけ due', () => {
    const p = planRun({ settings, kind: PREOPEN, log: {}, nowMs: t0930 });
    expect(p.find(x => x.setting.shopId === 'a').due).toBe(true);
    expect(p.find(x => x.setting.shopId === 'b').due).toBe(false);
  });
  it('送信済みは due にならない', () => {
    const log = recordSent({}, sendKey('a', '2026-09-19', PREOPEN), { at: t0930, hash: 'x' });
    const p = planRun({ settings, kind: PREOPEN, log, nowMs: t0930 });
    expect(p.find(x => x.setting.shopId === 'a').reason).toBe('already');
  });
  it('日報のきっかけ別に理由が分かれる', () => {
    const p = planRun({ settings, kind: CLOSING, log: {}, nowMs: Date.UTC(2026, 8, 19, 14, 0) }); // 23:00 JST
    expect(p.find(x => x.setting.shopId === 'c').due).toBe(true);
    expect(p.find(x => x.setting.shopId === 'd').reason).toBe('manual_only');
    expect(p.find(x => x.setting.shopId === 'e').reason).toBe('needs_aggregate_check');
  });
});

describe('出典フッター', () => {
  it('出典・対象期間・取得時刻が欠けても「未取得」と書き、空欄にしない', () => {
    const f = footer({ sources: [], ymd: '', fetchedAt: null }).join('\n');
    expect(f).toContain(`出典: SalonOne ${NOT_FETCHED}`);
    expect(f).toContain(`対象期間: ${NOT_FETCHED}`);
    expect(f).toContain(`取得時刻: ${NOT_FETCHED}`);
  });
});

describe('🔴 SalonOne の応答を 0 で埋めずに取り込む', () => {
  it('欠けた項目は null（0 にしない）', () => {
    const s = normalizeSummary({ digest_sales: 100 });
    expect(s.grossSales).toBe(100);
    expect(s.newVisit).toBe(null);
    expect(s.cancel).toBe(null);
  });
  it('本当の 0 は 0 のまま', () => {
    expect(normalizeSummary({ digest_sales: 0, cancel_count: 0 }).cancel).toBe(0);
  });
  it('digest が無ければ gross_sales へ落ちる（画面と同じ優先順位）', () => {
    expect(normalizeSummary({ gross_sales: 50 }).grossSales).toBe(50);
    expect(normalizeSummary({ digest_sales: 10, gross_sales: 50 }).grossSales).toBe(10);
  });
  it('配列で返ってきても先頭を使う', () => {
    expect(normalizeSummary([{ digest_sales: 7 }]).grossSales).toBe(7);
  });
  it('取得できなければ null（空オブジェクトを作らない）', () => {
    expect(normalizeSummary(null)).toBe(null);
    expect(normalizeSummary([])).toBe(null);
    expect(normalizeSummary('x')).toBe(null);
  });
  it('媒体別: 配列でなければ null（＝未取得。空配列＝0件 とは区別する）', () => {
    expect(normalizeChannels(null)).toBe(null);
    expect(normalizeChannels({})).toBe(null);
    expect(normalizeChannels([])).toEqual([]);
  });
  it('媒体別: 予約も来店も無い行は落とし、予約数の多い順に並べる', () => {
    const c = normalizeChannels([
      { name: 'A', booking_count: 1 },
      { name: 'B', booking_count: 5, visit_count: 4, join_count: 2, cancel_count: 1 },
      { name: 'C', booking_count: 0, visit_count: 0 },
      { booking_count: 2 },
    ]);
    expect(c.map(x => x.name)).toEqual(['B', '未設定', 'A']);   // 予約数の多い順
    expect(c[0]).toEqual({ name: 'B', booking: 5, visit: 4, cancel: 1, join: 2 });
    expect(c[1].visit).toBe(null);     // 未取得のまま（0 にしない）
  });
  it('取り込んだ結果をそのまま文面に渡せる', () => {
    const r = buildClosingReport({
      ...SHOP, ymd: '2026-09-19', fetchedAt: AT,
      summary: normalizeSummary({ digest_sales: 100000, new_visit_count: 4 }),
      channels: normalizeChannels([{ name: 'A', booking_count: 4, join_count: 2 }]),
    });
    expect(r.text).toContain('¥100,000');
    expect(r.text).toContain('入会 2名（入会率 50%）');
    expect(r.text).toContain(`既存 ${NOT_FETCHED}`);   // repeat_customer_sales が無い
  });
});

describe('🔴 目標を入れただけでは「数字が取れた」ことにしない', () => {
  it('設定値(目標)しか無ければ送らない', () => {
    const r = buildClosingReport({ ...SHOP, ymd: '2026-09-19', summary: null, channels: null, target: 8, fetchedAt: AT });
    expect(r.facts.target).toBe(8);
    expect(reportReady(r).reason).toBe('no_data');
  });
  it('集客速報でも同じ', () => {
    const r = buildPreOpenReport({ ...SHOP, ymd: '2026-09-19', channels: null, target: 8, fetchedAt: AT });
    expect(reportReady(r).reason).toBe('no_data');
  });
});
