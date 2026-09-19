import { describe, it, expect } from 'vitest';
import {
  PREP, PREOPEN, OPEN, PHASES, TRIGGERS, NOT_FETCHED, DEFAULT_SEND_AT,
  jstYmd, jstHm, ymdLabel, ymdLabelFull, compareYmd, monthRange, monthOf,
  hmToMinutes, normalizeHm, timeReached, phaseOf,
  normalizeShopSetting, normalizeSettings, targetsFor, settingReady,
  yen, people, percent, rate, signed, sumStrict, footer,
  snapshotOf, dailyDelta, normalizeSpend, spendTotal, cpa,
  normalizeStaff, buildStaffTable, preOpenDayLabel,
  repeatStateOf, visitedOf, repeatByStaff, mergeRepeat,
  buildPrepReport, buildPreOpenReport, buildOpenReport, buildReport, reportReady,
  sendKey, contentHash, alreadySent, shouldSend, recordSent,
  detectAggregationRun, advanceObservation, planRun,
  normalizeSummary, normalizeChannels,
} from '../lib/daily-report.js';

// 合成データのみ。実店舗名・実売上は使わない。
const AT = Date.UTC(2026, 8, 19, 10, 0);      // 2026-09-19 19:00 JST

// 見本（オープン前 集客レポート）と同じ形の店舗設定
const PREP_SETTING = {
  shopId: '9001', shopName: 'テスト院', enabled: true, roomId: 'r1',
  preOpenDate: '2026-09-27', openDate: '2026-10-01',
  targetNew: 150, targetDeadline: '2026-09-30', targetMonth: '2026-10',
  sendAt: '19:00',
};

// 対象月ぶんの累計（remaining＝まだ来ていない有効な新規予約）
const CH = () => ([
  { name: 'Meta広告', booking: 56, cancel: 4, remaining: 52, visit: 0, join: 0 },
  { name: 'チラシ', booking: 26, cancel: 2, remaining: 24, visit: 0, join: 0 },
  { name: 'Google検索', booking: 12, cancel: 0, remaining: 12, visit: 0, join: 0 },
  { name: '紹介', booking: 6, cancel: 0, remaining: 6, visit: 0, join: 0 },
  { name: 'その他', booking: 2, cancel: 0, remaining: 2, visit: 0, join: 0 },
]);
// 前日の累計（本日 新規9・取消2 になるように作る）
const PREV = () => ({
  'Meta広告': { booking: 51, cancel: 3, remaining: 48 },
  'チラシ': { booking: 24, cancel: 1, remaining: 23 },
  'Google検索': { booking: 11, cancel: 0, remaining: 11 },
  '紹介': { booking: 5, cancel: 0, remaining: 5 },
  'その他': { booking: 2, cancel: 0, remaining: 2 },
});
const SPEND = () => ({ 'Meta広告': 104000, 'チラシ': 48000 });

const summary = (o = {}) => ({
  grossSales: 482000, newSales: 180000, repeatSales: 302000,
  newVisit: 6, repeatVisit: 18, cancel: 2, noShow: 0, ...o,
});

describe('JSTの時刻と日付', () => {
  it('UTCではなくJSTで日付が決まる', () => {
    expect(jstYmd(Date.UTC(2026, 8, 19, 14, 30))).toBe('2026-09-19');
    expect(jstYmd(Date.UTC(2026, 8, 19, 15, 30))).toBe('2026-09-20');   // JSTでは翌日
  });
  it('時刻もJST', () => {
    expect(jstHm(AT)).toBe('19:00');
  });
  it('曜日つきで出せる', () => {
    expect(ymdLabel('2026-09-19')).toBe('9/19(土)');
    expect(ymdLabelFull('2026-09-19')).toBe('2026/09/19（土）');
  });
  it('🔴 読めない日付で Invalid Date を出さない', () => {
    for (const bad of ['', '2026/09/19', null, '2026-13-01', '2026-02-30']) {
      expect(ymdLabel(bad)).toBe('');
      expect(ymdLabelFull(bad)).toBe('');
    }
  });
  it('🔴 日付を比べられないときは null（false と混同しない）', () => {
    expect(compareYmd('2026-09-19', '2026-09-20')).toBe(-1);
    expect(compareYmd('2026-09-20', '2026-09-20')).toBe(0);
    expect(compareYmd('2026-09-21', '2026-09-20')).toBe(1);
    expect(compareYmd('2026-09-21', '')).toBe(null);
  });
  it('対象月から月初・月末を出せる（うるう年も）', () => {
    expect(monthRange('2026-10')).toEqual({ from: '2026-10-01', to: '2026-10-31', label: '10月' });
    expect(monthRange('2028-02').to).toBe('2028-02-29');
    expect(monthRange('2026-13')).toBe(null);
    expect(monthRange('')).toBe(null);
    expect(monthOf('2026-10-01')).toBe('2026-10');
    expect(monthOf('')).toBe('');
  });
  it('HH:MM の解釈（未設定と 0:00 を混同しない）', () => {
    expect(hmToMinutes('19:00')).toBe(1140);
    expect(hmToMinutes('0:00')).toBe(0);
    expect(hmToMinutes('')).toBe(null);
    expect(hmToMinutes('25:00')).toBe(null);
    expect(normalizeHm('9:5', '19:00')).toBe('19:00');
  });
  it('指定時刻を過ぎたかを判定する', () => {
    expect(timeReached('19:00', AT)).toBe(true);
    expect(timeReached('20:00', AT)).toBe(false);
    expect(timeReached('', AT)).toBe(false);      // 不正は送らない側へ
  });
});

describe('🔴 いまどの期間か（3つのテンプレートの振り分け）', () => {
  const on = (ymd) => Date.parse(`${ymd}T03:00:00Z`);   // 正午JST
  it('プレオープンより前は「オープン前」', () => {
    expect(phaseOf(PREP_SETTING, on('2026-09-19'))).toBe(PREP);
    expect(phaseOf(PREP_SETTING, on('2026-09-26'))).toBe(PREP);
  });
  it('プレオープン当日から「プレオープン期間」', () => {
    expect(phaseOf(PREP_SETTING, on('2026-09-27'))).toBe(PREOPEN);
    expect(phaseOf(PREP_SETTING, on('2026-09-30'))).toBe(PREOPEN);
  });
  it('本オープン当日から「オープン後」', () => {
    expect(phaseOf(PREP_SETTING, on('2026-10-01'))).toBe(OPEN);
    expect(phaseOf(PREP_SETTING, on('2027-01-01'))).toBe(OPEN);
  });
  it('🔴 日付が未設定の店舗（既存店）は常にオープン後', () => {
    expect(phaseOf({ shopId: 'x' }, on('2026-09-19'))).toBe(OPEN);
  });
  it('プレオープン日だけ無い店舗は、本オープンまで「オープン前」', () => {
    const s = { ...PREP_SETTING, preOpenDate: '' };
    expect(phaseOf(s, on('2026-09-29'))).toBe(PREP);
    expect(phaseOf(s, on('2026-10-01'))).toBe(OPEN);
  });
  it('期間は3つだけ', () => {
    expect(PHASES).toEqual([PREP, PREOPEN, OPEN]);
  });
});

describe('店舗ごとの設定', () => {
  it('🔴 既定は自動送信OFF', () => {
    const s = normalizeShopSetting({}, '9001');
    expect(s.enabled).toBe(false);
    expect(s.roomId).toBe('');
  });
  it('真偽値以外を true に格上げしない', () => {
    expect(normalizeShopSetting({ enabled: 'true' }).enabled).toBe(false);
    expect(normalizeShopSetting({ enabled: 1 }).enabled).toBe(false);
  });
  it('読めない日付は空にする（壊れた日付で期間を誤らせない）', () => {
    const s = normalizeShopSetting({ preOpenDate: '9/27', openDate: '2026-10-01' });
    expect(s.preOpenDate).toBe('');
    expect(s.openDate).toBe('2026-10-01');
  });
  it('対象月は未設定なら本オープンの月になる', () => {
    expect(normalizeShopSetting({ openDate: '2026-10-05' }).targetMonth).toBe('2026-10');
    expect(normalizeShopSetting({ openDate: '2026-10-05', targetMonth: '2026-11' }).targetMonth).toBe('2026-11');
  });
  it('目標人数: 未設定(null)と 0人 を区別する', () => {
    expect(normalizeShopSetting({ targetNew: null }).targetNew).toBe(null);
    expect(normalizeShopSetting({ targetNew: '' }).targetNew).toBe(null);
    expect(normalizeShopSetting({ targetNew: -3 }).targetNew).toBe(null);
    expect(normalizeShopSetting({ targetNew: 0 }).targetNew).toBe(0);
    expect(normalizeShopSetting({ targetNew: '150' }).targetNew).toBe(150);
  });
  it('未知のきっかけは既定(aggregate)へ落とす', () => {
    expect(normalizeShopSetting({ trigger: 'webhook' }).trigger).toBe('aggregate');
    for (const t of TRIGGERS) expect(normalizeShopSetting({ trigger: t }).trigger).toBe(t);
  });
  it('既定の配信時刻', () => {
    expect(normalizeShopSetting({}).sendAt).toBe(DEFAULT_SEND_AT);
  });
  it('壊れた保存データでも落ちない', () => {
    expect(normalizeSettings(null).shops).toEqual({});
    expect(normalizeSettings({ shops: [] }).shops).toEqual({});
    expect(normalizeSettings('x').shops).toEqual({});
  });
});

describe('🔴 送信対象は「チェックを入れた店舗」だけ（全店一括にしない）', () => {
  const settings = { shops: {
    a: { shopId: 'a', enabled: true, roomId: 'r1' },
    b: { shopId: 'b', enabled: false, roomId: 'r2' },   // OFF
    c: { shopId: 'c', enabled: true, roomId: '' },      // 送信先なし
  } };
  it('対象は a だけ', () => {
    expect(targetsFor(settings).map(x => x.shopId)).toEqual(['a']);
  });
  it('設定が空なら 1 件も返らない', () => {
    expect(targetsFor(null)).toEqual([]);
    expect(targetsFor({})).toEqual([]);
  });
  it('送れない理由を人に説明できる', () => {
    expect(settingReady({ enabled: false }).reason).toBe('disabled');
    expect(settingReady({ enabled: true }).reason).toBe('no_room');
    expect(settingReady({ enabled: true, roomId: 'r' }).ok).toBe(true);
  });
});

describe('🔴 取れなかった数値を 0 で埋めない', () => {
  it('未取得は「未取得」と書く', () => {
    for (const f of [yen, people, percent, signed]) {
      expect(f(null)).toBe(NOT_FETCHED);
      expect(f(undefined)).toBe(NOT_FETCHED);
      expect(f(NaN)).toBe(NOT_FETCHED);
    }
  });
  it('本当の 0 は 0 と書く', () => {
    expect(yen(0)).toBe('¥0');
    expect(people(0)).toBe('0名');
    expect(signed(0)).toBe('0件');
  });
  it('増減には符号を付ける', () => {
    expect(signed(7)).toBe('+7件');
    expect(signed(-2)).toBe('-2件');
  });
  it('分母が無い率は作らない（0% と書かない）', () => {
    expect(rate(3, 0)).toBe(null);
    expect(rate(3, null)).toBe(null);
    expect(rate(null, 6)).toBe(null);
    expect(rate(96, 150)).toBe(64);
  });
  it('🔴 1つでも欠けた合計は出さない（欠けたまま足さない）', () => {
    expect(sumStrict([1, 2, 3])).toBe(6);
    expect(sumStrict([1, null, 3])).toBe(null);
    expect(sumStrict([])).toBe(0);
    expect(sumStrict(null)).toBe(0);
  });
});

describe('前日との差分（本日の新規・取消）', () => {
  it('累計のスナップショットを作れる', () => {
    expect(snapshotOf(CH())['Meta広告']).toEqual({ booking: 56, cancel: 4, remaining: 52 });
  });
  it('前日との差で本日ぶんが出る', () => {
    const d = dailyDelta(PREV(), snapshotOf(CH()));
    expect(d.hasPrev).toBe(true);
    expect(d.today.added).toBe(9);          // 5+2+1+1+0
    expect(d.today.cancelled).toBe(2);      // 1+1+0+0+0
    expect(d.rows[0]).toEqual({ name: 'Meta広告', added: 5, cancelled: 1, total: 52 });
  });
  it('累計の多い順に並ぶ', () => {
    const d = dailyDelta(PREV(), snapshotOf(CH()));
    expect(d.rows.map(r => r.name)).toEqual(['Meta広告', 'チラシ', 'Google検索', '紹介', 'その他']);
  });
  it('🔴 前日の記録が無い初日は増減を 0 にしない（未取得のまま）', () => {
    const d = dailyDelta(null, snapshotOf(CH()));
    expect(d.hasPrev).toBe(false);
    expect(d.today.added).toBe(null);
    expect(d.today.cancelled).toBe(null);
    expect(d.rows[0].total).toBe(52);        // 累計は出せる
  });
  it('前日に無かった媒体は、その日はじめて入った予約として数える', () => {
    const prev = PREV(); delete prev['紹介'];
    const d = dailyDelta(prev, snapshotOf(CH()));
    expect(d.rows.find(r => r.name === '紹介').added).toBe(6);   // 昨日は0件だった
    expect(d.today.added).toBe(14);                               // 9 + 紹介の5件ぶん
  });
});

describe('広告費と獲得単価', () => {
  it('入力のある媒体だけ、金額の多い順に並べる', () => {
    const items = normalizeSpend({ 'チラシ': 48000, 'Meta広告': 104000, 'まだ未入力': '' });
    expect(items).toEqual([{ name: 'Meta広告', yen: 104000 }, { name: 'チラシ', yen: 48000 }]);
  });
  it('🔴 未入力を 0 円として並べない', () => {
    expect(normalizeSpend({})).toBe(null);
    expect(normalizeSpend(null)).toBe(null);
    expect(normalizeSpend({ 'Meta広告': 'あとで' })).toBe(null);
  });
  it('合計とCPAを出す', () => {
    const items = normalizeSpend(SPEND());
    expect(spendTotal(items)).toBe(152000);
    expect(cpa(152000, 96)).toBe(1583);
  });
  it('🔴 人数が0や未取得なら CPA を作らない（¥0/名 と書かない）', () => {
    expect(cpa(152000, 0)).toBe(null);
    expect(cpa(152000, null)).toBe(null);
    expect(cpa(null, 96)).toBe(null);
  });
});

describe('① オープン前 集客レポート（prep）', () => {
  const r = buildPrepReport({
    setting: PREP_SETTING, shopName: 'テスト院', ymd: '2026-09-19',
    channels: CH(), prevSnap: PREV(), spend: SPEND(), fetchedAt: AT,
  });
  it('見本と同じ見出し・時点が出る', () => {
    expect(r.card.title).toBe('オープン前 集客レポート');
    expect(r.card.brand).toBe('NAORU × SalonOne');
    expect(r.card.atLabel).toBe('2026/09/19（土） 19:00時点・日本時間');
  });
  it('プレオープン日と本オープン日が出る', () => {
    expect(r.card.milestones).toEqual([
      { label: 'プレオープン', value: '9/27(日)' },
      { label: '本オープン', value: '10/1(木)' },
    ]);
  });
  it('🔴 累計の有効予約人数・目標・達成率が見本どおり', () => {
    expect(r.card.goal.current).toBe(96);
    expect(r.card.goal.target).toBe(150);
    expect(r.card.goal.rate).toBe(64);
    expect(r.card.goal.headline).toBe('目標まで、あと54名');
    expect(r.card.goal.note).toBe('目標150名・集客目標の締切 9/30(水)');
  });
  it('対象と除外の条件を書く', () => {
    expect(r.card.scope).toEqual({ left: '10月の新規来店予約が対象', right: '取消・重複を除く' });
  });
  it('本日の新規・キャンセル・増減が出る', () => {
    expect(r.card.today.map(x => x.value)).toEqual([9, 2, 7]);
    expect(r.text).toContain('新規予約 9件 ／ キャンセル 2件 ／ 増減 +7件');
  });
  it('媒体別が見本どおり並ぶ', () => {
    expect(r.card.channels.rows.map(x => [x.name, x.added, x.cancelled, x.total])).toEqual([
      ['Meta広告', 5, 1, 52], ['チラシ', 2, 1, 24], ['Google検索', 1, 0, 12],
      ['紹介', 1, 0, 6], ['その他', 0, 0, 2],
    ]);
    expect(r.card.channels.total).toEqual({ added: 9, cancelled: 2, total: 96 });
  });
  it('広告費とCPAが見本どおり', () => {
    expect(r.card.spend.totalYen).toBe(152000);
    expect(r.card.spend.cpa).toBe(1583);
    expect(r.text).toContain('合計広告費 ¥152,000');
    expect(r.text).toContain('¥1,583 / 名');
  });
  it('🔴 売上は出さない（まだ営業していない）', () => {
    expect(r.text).not.toContain('売上');
  });
  it('🔴 出典・対象期間・取得時刻が必ず付く', () => {
    expect(r.text).toContain('出典: SalonOne marketing/by-channel');
    expect(r.text).toContain('対象期間: 2026-10-01〜2026-10-31（10月来店予定ぶんの累計）');
    expect(r.text).toContain('取得時刻: 2026-09-19 19:00 JST');
  });
  it('次回に使う累計を持ち帰る', () => {
    expect(r.snapshot['Meta広告'].remaining).toBe(52);
  });

  it('🔴 前日の記録が無い初日は「まだ出せない」と書く（0件と書かない）', () => {
    const first = buildPrepReport({ setting: PREP_SETTING, ymd: '2026-09-19',
      channels: CH(), prevSnap: null, spend: SPEND(), fetchedAt: AT });
    expect(first.card.today[0].value).toBe(null);
    expect(first.card.todayNote).toContain('前日の記録がない');
    expect(first.text).toContain(`新規予約 ${NOT_FETCHED}`);
    expect(first.text).not.toContain('新規予約 0件');
    expect(first.card.goal.current).toBe(96);     // 累計は出せる
  });
  it('🔴 目標が未設定なら「あと何人」を作らず、設定を促す', () => {
    const t = buildPrepReport({ setting: { ...PREP_SETTING, targetNew: null }, ymd: '2026-09-19',
      channels: CH(), prevSnap: PREV(), fetchedAt: AT });
    expect(t.card.goal.headline).toBe('目標が未設定です');
    expect(t.text).toContain('設定画面で目標人数と締切を入れてください');
  });
  it('🔴 広告費が未入力なら CPA を作らない', () => {
    const t = buildPrepReport({ setting: PREP_SETTING, ymd: '2026-09-19',
      channels: CH(), prevSnap: PREV(), spend: null, fetchedAt: AT });
    expect(t.card.spend.cpa).toBe(null);
    expect(t.text).toContain('広告費が入力されていません');
    expect(t.missing).toContain('広告費');
  });
  it('🔴 予約が取れなければ「未取得」（0名と書かない）', () => {
    const t = buildPrepReport({ setting: PREP_SETTING, ymd: '2026-09-19',
      channels: null, prevSnap: PREV(), fetchedAt: AT });
    expect(t.card.goal.current).toBe(null);
    expect(t.text).toContain(`累計の有効予約人数 ${NOT_FETCHED}`);
    expect(t.missing).toContain('媒体別の予約');
  });
  it('入力が空でも落ちない', () => {
    const e = buildPrepReport({});
    expect(typeof e.text).toBe('string');
    expect(e.text).toContain('(店舗名未取得)');
  });
});

describe('② プレオープン日報（preopen）', () => {
  // 見本（03 / 比較テーブル型）と同じ数字
  const STAFF = () => ([
    { id: 'a', name: 'スタッフA', sales: 32000, booking: 7, visit: 5, cancel: 2, join: 1, repeat: 5, prepaid: 4, review: 2 },
    { id: 'b', name: 'スタッフB', sales: 57750, booking: 8, visit: 8, cancel: 0, join: 3, repeat: 6, prepaid: 5, review: 3 },
  ]);
  const r = buildPreOpenReport({
    setting: PREP_SETTING, shopName: 'テスト院', ymd: '2026-09-27',
    summary: { grossSales: 89750 }, staff: STAFF(),
    fetchedAt: Date.UTC(2026, 8, 27, 9, 42),        // 18:42 JST
  });

  it('見本と同じ見出し・対象日・集計時刻', () => {
    expect(r.card.title).toBe('プレオープン日報');
    expect(r.card.atLabel).toBe('対象日：2026/09/27（日）');
    expect(r.card.atRight).toBe('集計実行 18:42・当日時点');
  });
  it('🔴 プレオープン何日目かが出る', () => {
    expect(r.card.badge).toBe('プレオープン初日');
    expect(preOpenDayLabel('2026-09-27', '2026-09-28')).toBe('プレオープン2日目');
    expect(preOpenDayLabel('', '2026-09-28')).toBe('プレオープン');
    expect(preOpenDayLabel('2026-09-27', '2026-09-26')).toBe('プレオープン');   // 前日は数えない
  });
  it('本日売上と内訳が帯に出る', () => {
    expect(r.card.highlight.value).toBe(89750);
    expect(r.card.highlight.note).toBe('新規来店13名・入会4名・次回予約11名');
  });
  it('セラピストが列に並ぶ', () => {
    // 並び順は取り込み側（normalizeStaff）の責任。ここは渡した順のまま列になる。
    expect(r.card.table.staff.map(x => x.name)).toEqual(['スタッフA', 'スタッフB']);
  });
  it('🔴 見本の10行がそろっている', () => {
    expect(r.card.table.rows.map(x => x.label)).toEqual([
      '本日売上（税抜）', '当日予約数（取消を含む）', '新規来店数', 'キャンセル数', '入会人数',
      '入会率', 'リピート数（次回予約）', 'リピート率', '前金あり', 'Google口コミ',
    ]);
  });
  it('🔴 店舗合計は見本と一致する', () => {
    const t = Object.fromEntries(r.card.table.rows.map(x => [x.label, x.total]));
    expect(t['本日売上（税抜）']).toBe(89750);
    expect(t['当日予約数（取消を含む）']).toBe(15);
    expect(t['新規来店数']).toBe(13);
    expect(t['キャンセル数']).toBe(2);
    expect(t['入会人数']).toBe(4);
    expect(t['リピート数（次回予約）']).toBe(11);
    expect(t['前金あり']).toBe(9);
    expect(t['Google口コミ']).toBe(5);
  });
  it('🔴 率は合計から計算し直す（平均しない）', () => {
    const t = Object.fromEntries(r.card.table.rows.map(x => [x.label, x.total]));
    expect(Math.round(t['入会率'] * 10) / 10).toBe(30.8);      // 4 ÷ 13
    expect(Math.round(t['リピート率'] * 10) / 10).toBe(84.6);  // 11 ÷ 13
    const join = r.card.table.rows.find(x => x.label === '入会率');
    expect(join.values.map(v => Math.round(v * 10) / 10)).toEqual([20, 37.5]);   // A, B の順
  });
  it('🔴 計算の定義を必ず添える', () => {
    expect(r.card.notes).toEqual([
      '入会率＝入会人数 ÷ 新規来店数',
      'リピート率＝次回予約獲得人数 ÷ 新規来店数（再来店数とは別）',
      '売上：SalonOneの当日計上額・税抜　／　前金あり・口コミは当日獲得人数',
    ]);
  });
  it('🔴 「集計実行」の後に出していると断る', () => {
    expect(r.card.footer.schedule).toContain('「集計実行」の完了後');
    expect(r.text).toContain('その後に会計が動くと数字が変わることがあります');
  });
  it('文字だけでも読める形になっている', () => {
    expect(r.text).toContain('【プレオープン日報】テスト院　プレオープン初日');
    expect(r.text).toContain('本日売上 ¥89,750');
    expect(r.text).toContain('入会率　20% ／ 37.5%　＝ 30.8%');
  });

  it('🔴 次回予約・前金が取れなければ「未取得」（0名と書かない）', () => {
    const noRepeat = STAFF().map(x => ({ ...x, repeat: null, prepaid: null }));
    const t = buildPreOpenReport({ setting: PREP_SETTING, ymd: '2026-09-27',
      summary: { grossSales: 89750 }, staff: noRepeat, fetchedAt: AT });
    const rows = Object.fromEntries(t.card.table.rows.map(x => [x.label, x.total]));
    expect(rows['リピート数（次回予約）']).toBe(null);
    expect(rows['リピート率']).toBe(null);
    expect(t.card.highlight.note).toContain(`次回予約${NOT_FETCHED}`);
    expect(t.missing).toContain('次回予約数（取得元が未確認）');
    expect(t.missing).toContain('前金あり（取得元が未確認）');
    expect(t.text).not.toContain('次回予約0名');
  });
  it('🔴 1人でも欠けていれば合計を出さない', () => {
    const half = STAFF(); half[0].visit = null;
    const t = buildPreOpenReport({ setting: PREP_SETTING, ymd: '2026-09-27', staff: half, fetchedAt: AT });
    const rows = Object.fromEntries(t.card.table.rows.map(x => [x.label, x.total]));
    expect(rows['新規来店数']).toBe(null);
    expect(rows['入会率']).toBe(null);
  });
  it('セラピスト別が取れなければ missing に積む', () => {
    const t = buildPreOpenReport({ setting: PREP_SETTING, ymd: '2026-09-27', staff: null, fetchedAt: AT });
    expect(t.missing).toContain('セラピスト別の実績');
    expect(t.text).toContain(NOT_FETCHED);
  });
  it('入力が空でも落ちない', () => {
    expect(typeof buildPreOpenReport({}).text).toBe('string');
  });
});

describe('セラピスト別の取り込み（2つの応答を突き合わせる）', () => {
  const SUM_BY_STAFF = [
    { staff_id: 1, staff_name: 'スタッフA', digest_sales: 32000, google_review_count: 2 },
    { staff_id: 2, staff_name: 'スタッフB', digest_sales: 57750, google_review_count: 3 },
  ];
  const MK_BY_STAFF = [
    { staff_id: 0, is_total: true, new_booking_count: 15, new_visit_count: 13 },
    { staff_id: 1, staff_name: 'スタッフA', new_booking_count: 7, new_visit_count: 5, cancel_count: 2, purchase_count: 1 },
    { staff_id: 2, staff_name: 'スタッフB', new_booking_count: 8, new_visit_count: 8, cancel_count: 0, purchase_count: 3 },
  ];
  it('staff_id で2つの応答が1人にまとまる', () => {
    const rows = normalizeStaff(SUM_BY_STAFF, MK_BY_STAFF);
    const a = rows.find(x => x.id === '1');
    expect(a).toMatchObject({ name: 'スタッフA', sales: 32000, review: 2, booking: 7, visit: 5, cancel: 2, join: 1 });
  });
  it('🔴 合計行（is_total）は列にしない（二重に数えない）', () => {
    expect(normalizeStaff(SUM_BY_STAFF, MK_BY_STAFF).map(x => x.id)).toEqual(['2', '1']);
  });
  it('🔴 確認できていない項目は null のまま（推測で埋めない）', () => {
    const rows = normalizeStaff(SUM_BY_STAFF, MK_BY_STAFF);
    expect(rows[0].repeat).toBe(null);
    expect(rows[0].prepaid).toBe(null);
  });
  it('将来その項目が返ってくれば拾える', () => {
    const rows = normalizeStaff(SUM_BY_STAFF, [{ staff_id: 1, next_booking_count: 5, prepaid_count: 4 }]);
    const a = rows.find(x => x.id === '1');
    expect(a.repeat).toBe(5);
    expect(a.prepaid).toBe(4);
  });
  it('片方しか無くても落ちない', () => {
    expect(normalizeStaff(SUM_BY_STAFF, null).length).toBe(2);
    expect(normalizeStaff(null, MK_BY_STAFF).length).toBe(2);
    expect(normalizeStaff(null, null)).toBe(null);
    expect(normalizeStaff([], [])).toBe(null);
  });
  it('名前が無い人は「(不明)」にする（空欄にしない）', () => {
    expect(normalizeStaff([{ staff_id: 9, digest_sales: 1 }], null)[0].name).toBe('(不明)');
  });
});

describe('③ オープン後の日報（open）', () => {
  const r = buildOpenReport({
    setting: { ...PREP_SETTING, targetNew: 8 }, shopName: 'テスト院', ymd: '2026-10-05',
    summary: summary(), channels: [{ name: 'ホットペッパー', booking: 4, visit: 3, join: 2 }], fetchedAt: AT,
  });
  it('日報の見出し', () => {
    expect(r.lines[0]).toBe('【日報】テスト院　10/5(月)');
    expect(r.kind).toBe(OPEN);
  });
  it('売上・来店・入会が出る', () => {
    expect(r.text).toContain('¥482,000');
    expect(r.text).toContain('来店 24名（新規 6名 ／ 既存 18名）');
    expect(r.text).toContain('入会 2名（入会率 33.3%）');
  });
  it('目標に対する不足を出す', () => {
    expect(r.text).toContain('あと 2名');
  });
  it('🔴 目標が未設定なら目標行を出さない', () => {
    const t = buildOpenReport({ setting: { ...PREP_SETTING, targetNew: null }, ymd: '2026-10-05',
      summary: summary(), channels: null, fetchedAt: AT });
    expect(t.text).not.toContain('目標');
  });
  it('🔴 売上が取れていなければ「未取得」', () => {
    const t = buildOpenReport({ setting: PREP_SETTING, ymd: '2026-10-05', summary: null,
      channels: [{ name: 'A', booking: 1 }], fetchedAt: AT });
    expect(t.text).toContain(NOT_FETCHED);
    expect(t.text).not.toContain('¥0');
    expect(t.missing).toContain('売上');
  });
});

describe('期間で振り分ける', () => {
  const base = { setting: PREP_SETTING, ymd: '2026-09-19', channels: CH(), summary: summary(), fetchedAt: AT };
  it('期間ごとに別のテンプレートが出る', () => {
    expect(buildReport(PREP, base).card.title).toBe('オープン前 集客レポート');
    expect(buildReport(PREOPEN, base).card.title).toBe('プレオープン日報');
    expect(buildReport(OPEN, base).card.title).toBe('日報');
  });
  it('未知の期間は日報にする（勝手な集客レポートを出さない）', () => {
    expect(buildReport('unknown', base).kind).toBe(OPEN);
  });
});

describe('🔴 中身の無い定型文を流さない', () => {
  it('数字が1つも取れていなければ送らない', () => {
    const r = buildPrepReport({ setting: PREP_SETTING, ymd: '2026-09-19', channels: null, prevSnap: null, fetchedAt: AT });
    expect(reportReady(r).reason).toBe('no_data');
  });
  it('🔴 目標を入れただけでは「数字が取れた」ことにしない', () => {
    const r = buildOpenReport({ setting: { ...PREP_SETTING, targetNew: 8 }, ymd: '2026-10-05',
      summary: null, channels: null, fetchedAt: AT });
    expect(r.facts.target).toBe(8);
    expect(reportReady(r).reason).toBe('no_data');
  });
  it('1つでも取れていれば送れる', () => {
    const r = buildPrepReport({ setting: PREP_SETTING, ymd: '2026-09-19', channels: CH(), prevSnap: PREV(), fetchedAt: AT });
    expect(reportReady(r).ok).toBe(true);
  });
  it('壊れた入力でも false 側へ倒れる', () => {
    expect(reportReady(null).ok).toBe(false);
    expect(reportReady({}).ok).toBe(false);
  });
});

describe('🔴 二重送信の防止', () => {
  const key = sendKey('9001', '2026-09-19', PREP);
  const hash = contentHash('こんにちは');
  it('キーは 店舗・日・期間 で決まる', () => {
    expect(key).toBe('9001|2026-09-19|prep');
    expect(sendKey('9001', '2026-09-20', PREP)).not.toBe(key);
    expect(sendKey('9001', '2026-09-19', PREOPEN)).not.toBe(key);
  });
  it('内容が違えば指紋も違う', () => {
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
  it('1回目は送る／2回目（同じ内容）は送らない', () => {
    expect(shouldSend({ log: {}, key, hash }).send).toBe(true);
    const log = recordSent({}, key, { at: AT, hash, messageId: 'm1', roomId: 'r1' });
    expect(shouldSend({ log, key, hash }).reason).toBe('same_content');
    expect(shouldSend({ log, key, hash, force: true }).send).toBe(false);   // force でも連投しない
  });
  it('内容が変わっても、人が明示しない限り送らない', () => {
    const log = recordSent({}, key, { at: AT, hash });
    expect(shouldSend({ log, key, hash: contentHash('別') }).reason).toBe('already');
    expect(shouldSend({ log, key, hash: contentHash('別'), force: true }).send).toBe(true);
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

describe('オープン後のきっかけ（代理シグナル・仮案）', () => {
  it('初回の観測では送らない', () => {
    expect(detectAggregationRun(null, { digest: 100, at: AT }).reason).toBe('first_observation');
  });
  it('値が取れていなければ送らない', () => {
    expect(detectAggregationRun({ digest: 100 }, { digest: null, at: AT }).reason).toBe('no_data');
  });
  it('動いた直後は送らない／落ち着いたら送る', () => {
    const moved = detectAggregationRun({ digest: 100, at: AT - 60000, lastMovedAt: AT - 60000 }, { digest: 480000, at: AT });
    expect(moved.changed).toBe(true);
    expect(moved.settled).toBe(false);
    const prev = { digest: 480000, at: AT - 40 * 60000, lastMovedAt: AT - 40 * 60000 };
    expect(detectAggregationRun(prev, { digest: 480000, at: AT }).settled).toBe(true);
    expect(detectAggregationRun(prev, { digest: 480000, at: AT }, 60).settled).toBe(false);
  });
  it('一度も動いていない日は送らない（休業日に空の日報を出さない）', () => {
    expect(detectAggregationRun({ digest: 0, at: AT - 3600000, lastMovedAt: null }, { digest: 0, at: AT }).settled).toBe(false);
  });
  it('「最後に動いた時刻」を持ち越す', () => {
    const a = advanceObservation(null, { digest: 100, at: 1000 });
    expect(a.lastMovedAt).toBe(1000);
    expect(advanceObservation(a, { digest: 100, at: 2000 }).lastMovedAt).toBe(1000);
    expect(advanceObservation(a, { digest: 200, at: 3000 }).lastMovedAt).toBe(3000);
  });
});

describe('実行計画（送る前に、何が送られるか分かる）', () => {
  const settings = { shops: {
    a: { shopId: 'a', enabled: true, roomId: 'r1', preOpenDate: '2026-09-27', openDate: '2026-10-01', sendAt: '19:00' },
    b: { shopId: 'b', enabled: true, roomId: 'r2', preOpenDate: '2026-09-27', openDate: '2026-10-01', sendAt: '21:00' },
    c: { shopId: 'c', enabled: true, roomId: 'r3', trigger: 'time', closingAt: '22:00' },   // 既存店
    d: { shopId: 'd', enabled: true, roomId: 'r4', trigger: 'manual' },
    e: { shopId: 'e', enabled: true, roomId: 'r5', trigger: 'aggregate' },
  } };
  it('店舗ごとに期間が決まる', () => {
    const p = planRun({ settings, log: {}, nowMs: AT });
    expect(p.find(x => x.setting.shopId === 'a').phase).toBe(PREP);
    expect(p.find(x => x.setting.shopId === 'c').phase).toBe(OPEN);
  });
  it('集客レポートは配信時刻を過ぎた店舗だけ', () => {
    const p = planRun({ settings, log: {}, nowMs: AT });     // 19:00 JST
    expect(p.find(x => x.setting.shopId === 'a').due).toBe(true);
    expect(p.find(x => x.setting.shopId === 'b').due).toBe(false);
  });
  it('オープン後はきっかけ別に理由が分かれる', () => {
    const late = Date.UTC(2026, 8, 19, 14, 0);               // 23:00 JST
    const p = planRun({ settings, log: {}, nowMs: late });
    expect(p.find(x => x.setting.shopId === 'c').due).toBe(true);
    expect(p.find(x => x.setting.shopId === 'd').reason).toBe('manual_only');
    expect(p.find(x => x.setting.shopId === 'e').reason).toBe('needs_aggregate_check');
  });
  it('送信済みは due にならない', () => {
    const log = recordSent({}, sendKey('a', '2026-09-19', PREP), { at: AT, hash: 'x' });
    const p = planRun({ settings, log, nowMs: AT });
    expect(p.find(x => x.setting.shopId === 'a').reason).toBe('already');
  });
});

describe('🔴 SalonOne の応答を 0 で埋めずに取り込む', () => {
  it('欠けた項目は null（0 にしない）', () => {
    const s = normalizeSummary({ digest_sales: 100 });
    expect(s.grossSales).toBe(100);
    expect(s.newVisit).toBe(null);
  });
  it('本当の 0 は 0 のまま', () => {
    expect(normalizeSummary({ digest_sales: 0, cancel_count: 0 }).cancel).toBe(0);
  });
  it('digest が無ければ gross_sales へ落ちる（画面と同じ優先順位）', () => {
    expect(normalizeSummary({ gross_sales: 50 }).grossSales).toBe(50);
    expect(normalizeSummary({ digest_sales: 10, gross_sales: 50 }).grossSales).toBe(10);
  });
  it('取得できなければ null（空オブジェクトを作らない）', () => {
    expect(normalizeSummary(null)).toBe(null);
    expect(normalizeSummary([])).toBe(null);
  });
  it('媒体別: 配列でなければ null（未取得と 0件 を区別する）', () => {
    expect(normalizeChannels(null)).toBe(null);
    expect(normalizeChannels({})).toBe(null);
    expect(normalizeChannels([])).toEqual([]);
  });
  it('🔴 残新規（remaining_count）を取り込む＝まだ来ていない有効な新規予約', () => {
    const c = normalizeChannels([{ name: 'Meta広告', booking_count: 56, cancel_count: 4, remaining_count: 52 }]);
    expect(c[0]).toEqual({ name: 'Meta広告', booking: 56, visit: null, cancel: 4, join: null, remaining: 52 });
  });
  it('予約も来店も残もない行は落とす', () => {
    const c = normalizeChannels([
      { name: 'A', booking_count: 0, visit_count: 0, remaining_count: 0 },
      { name: 'B', remaining_count: 3 },
    ]);
    expect(c.map(x => x.name)).toEqual(['B']);
  });
});

describe('出典フッター', () => {
  it('欠けても「未取得」と書き、空欄にしない', () => {
    const f = footer({ sources: [], period: '', fetchedAt: null }).join('\n');
    expect(f).toContain(`出典: SalonOne ${NOT_FETCHED}`);
    expect(f).toContain(`対象期間: ${NOT_FETCHED}`);
    expect(f).toContain(`取得時刻: ${NOT_FETCHED}`);
  });
});

describe('リピート（次回予約）を新規客台帳から読む', () => {
  // オーナーの説明: 2回目の欄に「次回予約」が入っていればリピート、空なら離反。
  it('はっきり「次回予約あり/なし」で来る形', () => {
    expect(repeatStateOf({ has_next_reservation: true })).toBe(true);
    expect(repeatStateOf({ has_next_reservation: false })).toBe(false);
  });
  it('次回予約の日時で来る形', () => {
    expect(repeatStateOf({ next_reservation_at: '2026-10-08 10:00' })).toBe(true);
    expect(repeatStateOf({ next_reservation_at: '' })).toBe(false);
    expect(repeatStateOf({ next_reservation_at: null })).toBe(false);
  });
  it('「継続／離反」で来る形（画面の表示と同じ）', () => {
    expect(repeatStateOf({ continuation_status: '継続' })).toBe(true);
    expect(repeatStateOf({ continuation_status: '離反' })).toBe(false);
    expect(repeatStateOf({ is_churn: true })).toBe(false);
    expect(repeatStateOf({ is_churn: false })).toBe(true);
  });
  it('1回目・2回目…が並びで来る形（2件目があればリピート）', () => {
    expect(repeatStateOf({ visits: [{ at: '09-03' }, { at: '09-17' }] })).toBe(true);
    expect(repeatStateOf({ visits: [{ at: '09-03' }] })).toBe(false);
    expect(repeatStateOf({ visits: [] })).toBe(false);
  });
  it('🔴 どの形にも当たらなければ「分からない」（0 にしない）', () => {
    expect(repeatStateOf({ customer_id: 1, ltv: 3500 })).toBe(null);
    expect(repeatStateOf(null)).toBe(null);
    expect(repeatStateOf('x')).toBe(null);
  });
  it('初回に来たかを読む', () => {
    expect(visitedOf({ visited_completed: true })).toBe(true);
    expect(visitedOf({ visited_completed: false })).toBe(false);
    expect(visitedOf({ first_appointment_status: 'completed' })).toBe(true);
    expect(visitedOf({ first_appointment_status: 'cancelled' })).toBe(false);
    expect(visitedOf({ customer_id: 1 })).toBe(null);
  });

  const LEDGER = () => ([
    // 担当A: 来店2・うち次回予約1
    { customer_id: 1, staff_id: '1', staff_name: '植松', visited_completed: true, has_next_reservation: true },
    { customer_id: 2, staff_id: '1', staff_name: '植松', visited_completed: true, has_next_reservation: false },
    // 担当B: 来店1・次回予約1／未来店1（母数に入れない）
    { customer_id: 3, staff_id: '2', staff_name: '亀井', visited_completed: true, has_next_reservation: true },
    { customer_id: 4, staff_id: '2', staff_name: '亀井', visited_completed: false, has_next_reservation: false },
  ]);

  it('担当ごとに来店数とリピート数を数える', () => {
    const by = repeatByStaff(LEDGER());
    expect(by['1']).toEqual({ staffId: '1', staffName: '植松', visited: 2, repeat: 1 });
    expect(by['2']).toEqual({ staffId: '2', staffName: '亀井', visited: 1, repeat: 1 });
  });
  it('🔴 来ていない人はリピートの母数に入れない', () => {
    expect(repeatByStaff(LEDGER())['2'].visited).toBe(1);   // 4番は未来店なので数えない
  });
  it('🔴 1人でも分からなければ、その担当は「未取得」にする（少なく見せない）', () => {
    const rows = LEDGER();
    delete rows[1].has_next_reservation;                     // 2番だけ分からない
    const by = repeatByStaff(rows);
    expect(by['1'].repeat).toBe(null);
    expect(by['1'].visited).toBe(null);
    expect(by['2'].repeat).toBe(1);                          // 他の担当は影響を受けない
  });
  it('担当が分からない行は捨てる（誰の実績か決められない）', () => {
    expect(repeatByStaff([{ customer_id: 9, visited_completed: true }])).toBe(null);
  });
  it('台帳が空なら null（0人ではない）', () => {
    expect(repeatByStaff([])).toBe(null);
    expect(repeatByStaff(null)).toBe(null);
  });

  it('セラピスト別の行へ差し込める（IDで合わせる）', () => {
    const staff = [{ id: '1', name: '植松', repeat: null }, { id: '2', name: '亀井', repeat: null }];
    const out = mergeRepeat(staff, repeatByStaff(LEDGER()));
    expect(out.map(x => x.repeat)).toEqual([1, 1]);
  });
  it('IDが違っても名前で合わせられる', () => {
    const staff = [{ id: 'x', name: '植松', repeat: null }];
    expect(mergeRepeat(staff, repeatByStaff(LEDGER()))[0].repeat).toBe(1);
  });
  it('台帳が取れなければ元のまま（未取得のまま）', () => {
    const staff = [{ id: '1', name: '植松', repeat: null }];
    expect(mergeRepeat(staff, null)[0].repeat).toBe(null);
  });

  it('🔴 差し込んだあと、リピート率が出せるようになる', () => {
    const staff = [
      { id: '1', name: '植松', sales: 32000, visit: 2, join: 1, repeat: null },
      { id: '2', name: '亀井', sales: 57750, visit: 1, join: 1, repeat: null },
    ];
    const merged = mergeRepeat(staff, repeatByStaff(LEDGER()));
    const t = buildStaffTable(merged);
    const row = (l) => t.rows.find(x => x.label === l);
    expect(row('リピート数（次回予約）').total).toBe(2);
    expect(Math.round(row('リピート率').total * 10) / 10).toBe(66.7);   // 2 ÷ 3
  });
});

describe('🔴 媒体別の表は、列の定義をカード側が持つ', () => {
  // 期間ごとに列が違う。描く側に項目名を当てさせると、別の期間で全部「未取得」になる。
  it('オープン前は 新規／取消／累計', () => {
    const r = buildPrepReport({ setting: PREP_SETTING, ymd: '2026-09-19',
      channels: CH(), prevSnap: PREV(), fetchedAt: AT });
    expect(r.card.channels.cols.map(c => c.key)).toEqual(['added', 'cancelled', 'total']);
    expect(r.card.channels.cols.map(c => c.label)).toEqual(['新規 / 件', '取消 / 件', '累計 / 名']);
  });
  it('オープン後は 予約／来店／入会', () => {
    const r = buildOpenReport({ setting: PREP_SETTING, ymd: '2026-10-05', summary: summary(),
      channels: [{ name: 'ホットペッパー', booking: 4, visit: 3, join: 2 }], fetchedAt: AT });
    expect(r.card.channels.cols.map(c => c.key)).toEqual(['booking', 'visit', 'join']);
    expect(r.card.channels.cols.map(c => c.label)).toEqual(['予約 / 件', '来店 / 名', '入会 / 名']);
  });
  it('🔴 どの列もカードの行から実際に読める（全部「未取得」にならない）', () => {
    for (const r of [
      buildPrepReport({ setting: PREP_SETTING, ymd: '2026-09-19', channels: CH(), prevSnap: PREV(), fetchedAt: AT }),
      buildOpenReport({ setting: PREP_SETTING, ymd: '2026-10-05', summary: summary(),
        channels: [{ name: 'ホットペッパー', booking: 4, visit: 3, join: 2 }], fetchedAt: AT }),
    ]) {
      const { cols, rows } = r.card.channels;
      expect(rows.length).toBeGreaterThan(0);
      for (const c of cols) {
        expect(rows.some(x => typeof x[c.key] === 'number')).toBe(true);
      }
    }
  });
  it('オープン後にも合計行が出る', () => {
    const r = buildOpenReport({ setting: PREP_SETTING, ymd: '2026-10-05', summary: summary(),
      channels: [{ name: 'A', booking: 4, visit: 3, join: 2 }, { name: 'B', booking: 2, visit: 2, join: 1 }],
      fetchedAt: AT });
    expect(r.card.channels.total).toEqual({ booking: 6, visit: 5, join: 3 });
  });
  it('🔴 1つでも欠けた列の合計は出さない', () => {
    const r = buildOpenReport({ setting: PREP_SETTING, ymd: '2026-10-05', summary: summary(),
      channels: [{ name: 'A', booking: 4, visit: 3, join: 2 }, { name: 'B', booking: 2 }], fetchedAt: AT });
    expect(r.card.channels.total.booking).toBe(6);
    expect(r.card.channels.total.visit).toBe(null);
  });
  it('媒体が1件も無ければ合計行を作らない', () => {
    const r = buildOpenReport({ setting: PREP_SETTING, ymd: '2026-10-05', summary: summary(), channels: [], fetchedAt: AT });
    expect(r.card.channels.total).toBe(null);
  });
});
