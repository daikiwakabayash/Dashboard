import { describe, it, expect } from 'vitest';
import {
  pctChange, analyzeStore, couponReminderItems, buildCouponMessage,
  buildStoreMessage, summarizeReports, PATROL_THRESHOLDS,
} from '../lib/patrol.js';

describe('月の進捗を考慮した按分（フロー指標）', () => {
  const store = { name: 'A', cur: { newCount: 5, gross: 153460, joinRate: 40, hasData: true }, prev: { newCount: 17, gross: 478800, hasData: true } };
  it('月初(12/30経過)は「前月ペース比」で判定＝単純な-71%では警告しない', () => {
    // 前月17名×(12/30)=6.8名が基準 → 今月5名は pace -26% だが、着地見込みは 12〜13名
    const r = analyzeStore(store, PATROL_THRESHOLDS, { progress: 12 / 30, elapsedDays: 12, totalDays: 30 });
    const nd = r.items.find(i => i.code === 'new_drop');
    // 着地見込みが前月17に近い/上回るケースは警告文言に「ペース比」「着地見込」が入る
    if (nd) expect(nd.title).toMatch(/ペース比|着地見込/);
    // 売上も同様にペース比で判定
    const sd = r.items.find(i => i.code === 'sales_drop');
    if (sd) expect(sd.title).toMatch(/ペース比|着地見込/);
  });
  it('確定月(progress=1)は従来どおり単純な前月比', () => {
    const r = analyzeStore(store, PATROL_THRESHOLDS, { progress: 1 });
    const nd = r.items.find(i => i.code === 'new_drop');
    expect(nd).toBeTruthy();
    expect(nd.title).toContain('前月比');
  });
  it('入会率は比率指標なので按分の影響を受けない', () => {
    const s2 = { name: 'B', cur: { newCount: 10, gross: 100, joinRate: 20, hasData: true }, prev: { newCount: 10, gross: 100, hasData: true } };
    const r = analyzeStore(s2, PATROL_THRESHOLDS, { progress: 0.4, elapsedDays: 12, totalDays: 30 });
    expect(r.items.find(i => i.code === 'join_low')).toBeTruthy();
  });
});

describe('MEO: 新規来店に対する口コミ獲得率', () => {
  it('新規が多いのに今月口コミが少ないと警告', () => {
    const store = { name: 'C', cur: { newCount: 20, gross: 100, joinRate: 40, hasData: true }, prev: { newCount: 20, gross: 100, hasData: true }, meo: { newReviewsThisMonth: 1, totalReviews: 80 } };
    const r = analyzeStore(store, PATROL_THRESHOLDS, { progress: 1 });
    expect(r.items.find(i => i.code === 'meo_capture_low')).toBeTruthy();
  });
  it('獲得率が高ければ good', () => {
    const store = { name: 'D', cur: { newCount: 20, gross: 100, joinRate: 40, hasData: true }, prev: { newCount: 20, gross: 100, hasData: true }, meo: { newReviewsThisMonth: 8, totalReviews: 80 } };
    const r = analyzeStore(store, PATROL_THRESHOLDS, { progress: 1 });
    expect(r.items.find(i => i.code === 'meo_capture_ok')).toBeTruthy();
  });
});

const codes = (r) => r.items.map(i => i.code);

describe('pctChange', () => {
  it('前月0は比較不能で null', () => {
    expect(pctChange(10, 0)).toBeNull();
  });
  it('増減率を四捨五入で返す', () => {
    expect(pctChange(80, 100)).toBe(-20);
    expect(pctChange(130, 100)).toBe(30);
  });
});

describe('analyzeStore', () => {
  const base = { gross: 3000000, newCount: 30, joinCount: 18, joinRate: 60, bookingCount: 40, hasData: true };

  it('新規来店の大幅減を警告する', () => {
    const r = analyzeStore({ name: '恵比寿院', cur: { ...base, newCount: 20 }, prev: { ...base, newCount: 30 } });
    expect(codes(r)).toContain('new_drop');
  });
  it('新規来店の大幅増を好調として拾う', () => {
    const r = analyzeStore({ name: '恵比寿院', cur: { ...base, newCount: 40 }, prev: { ...base, newCount: 30 } });
    expect(codes(r)).toContain('new_grow');
  });
  it('売上の大幅減を警告する', () => {
    const r = analyzeStore({ name: '恵比寿院', cur: { ...base, gross: 2400000 }, prev: { ...base, gross: 3000000 } });
    expect(codes(r)).toContain('sales_drop');
  });
  it('入会率30%割れを警告する', () => {
    const r = analyzeStore({ name: 'A', cur: { ...base, joinRate: 25 }, prev: base });
    expect(codes(r)).toContain('join_low');
  });
  it('入会率55%以上を好調として拾う', () => {
    const r = analyzeStore({ name: 'A', cur: { ...base, joinRate: 60 }, prev: base });
    expect(codes(r)).toContain('join_high');
  });
  it('新規が少ない（10未満）と集客強化を促す', () => {
    const r = analyzeStore({ name: 'A', cur: { ...base, newCount: 6, joinRate: 40 }, prev: { ...base, newCount: 6 } });
    expect(codes(r)).toContain('new_few');
  });
  it('Googleクチコミ0件を警告する', () => {
    const r = analyzeStore({ name: 'A', cur: base, prev: base, places: { userRatingCount: 0, rating: null } });
    expect(codes(r)).toContain('gmb_no_review');
  });
  it('Google評価が4.0未満を警告する', () => {
    const r = analyzeStore({ name: 'A', cur: base, prev: base, places: { userRatingCount: 50, rating: 3.7 } });
    expect(codes(r)).toContain('gmb_low_rating');
  });
  it('Googleマップと登録住所の不一致を警告する', () => {
    const r = analyzeStore({ name: 'A', cur: base, prev: base,
      places: { userRatingCount: 50, rating: 4.5, address: '東京都渋谷区恵比寿1-2-3' },
      addresses: { hotpepper: '東京都渋谷区恵比寿9-9-9' } });
    expect(codes(r)).toContain('addr_mismatch_hotpepper');
  });
  it('住所が一致していれば警告しない', () => {
    const r = analyzeStore({ name: 'A', cur: base, prev: base,
      places: { userRatingCount: 50, rating: 4.5, address: '東京都渋谷区恵比寿1-2-3' },
      addresses: { hotpepper: '東京都渋谷区恵比寿1丁目2-3 NAORUビル2F' } });
    expect(codes(r)).not.toContain('addr_mismatch_hotpepper');
  });
  it('問題が無ければ good(ok) を1件返す', () => {
    const neutral = { ...base, joinRate: 40 };
    const r = analyzeStore({ name: 'A', cur: neutral, prev: neutral });
    expect(codes(r)).toEqual(['ok']);
  });
  it('データ無しなら項目は空', () => {
    const r = analyzeStore({ name: 'A', cur: { hasData: false }, prev: {} });
    expect(r.items.length).toBe(0);
    expect(r.hasData).toBe(false);
  });
});

describe('couponReminderItems', () => {
  it('月初（graceDays以内）はリマインドを返す', () => {
    const items = couponReminderItems(new Date('2026-09-02T00:00:00Z'), 7);
    expect(items.length).toBe(1);
    expect(items[0].code).toBe('coupon_refresh');
    expect(items[0].title).toContain('9月');
  });
  it('月の後半は返さない', () => {
    expect(couponReminderItems(new Date('2026-09-20T00:00:00Z'), 7).length).toBe(0);
  });
});

describe('buildCouponMessage', () => {
  it('当月と先月に言及する', () => {
    const msg = buildCouponMessage(new Date('2026-09-05T00:00:00Z'));
    expect(msg).toContain('9月');
    expect(msg).toContain('8月');
    expect(msg).toContain('ホットペッパー');
  });
});

describe('buildStoreMessage', () => {
  const items = [
    { level: 'warn', code: 'new_drop', title: '新規来店が前月比 -30%', detail: 'クーポン見直し' },
    { level: 'info', code: 'gmb_few_review', title: 'Googleクチコミ 5件', detail: '' },
    { level: 'good', code: 'join_high', title: '入会率60%', detail: '' },
  ];
  it('店舗名と警告を含む文面を作る', () => {
    const msg = buildStoreMessage('恵比寿院', items, { date: new Date('2026-09-09') });
    expect(msg).toContain('恵比寿院');
    expect(msg).toContain('新規来店が前月比 -30%');
    expect(msg).toContain('⚠️');
  });
  it('good のみ・postGood=false なら空文字', () => {
    expect(buildStoreMessage('A', [{ level: 'good', code: 'ok', title: 'OK' }], { postGood: false })).toBe('');
  });
});

describe('summarizeReports', () => {
  it('レベル別に件数を集計する', () => {
    const s = summarizeReports([
      { items: [{ level: 'warn' }, { level: 'info' }] },
      { items: [{ level: 'good' }, { level: 'warn' }] },
    ]);
    expect(s).toEqual({ stores: 2, warn: 2, info: 1, good: 1 });
  });
});

describe('PATROL_THRESHOLDS', () => {
  it('業界ベンチマークに沿った既定値', () => {
    expect(PATROL_THRESHOLDS.joinRateWarn).toBe(30);
    expect(PATROL_THRESHOLDS.joinRateGood).toBe(55);
  });
});
