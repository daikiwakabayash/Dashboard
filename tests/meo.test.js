import { describe, it, expect } from 'vitest';
import { jstYmd, recordSnapshot, computeDeltas, meoFlags, meoScore, alertWeight, reviewsInMonth, MEO_THRESHOLDS } from '../lib/meo.js';

const jst = (y, m, d, hh = 0) => new Date(Date.UTC(y, m - 1, d, hh - 9));

describe('jstYmd', () => {
  it('JSTの日付に変換', () => {
    expect(jstYmd(jst(2026, 9, 12, 10))).toBe('2026-09-12');
    expect(jstYmd(new Date(Date.UTC(2026, 8, 11, 16)))).toBe('2026-09-12'); // UTC16:00=JST翌1:00
  });
});

describe('recordSnapshot', () => {
  it('同日は上書き・昇順・件数保持', () => {
    let h = [];
    h = recordSnapshot(h, { date: '2026-08-01', count: 30, rating: 4.2 });
    h = recordSnapshot(h, { date: '2026-09-01', count: 35, rating: 4.3 });
    h = recordSnapshot(h, { date: '2026-09-01', count: 36, rating: 4.3 }); // 上書き
    expect(h.length).toBe(2);
    expect(h[1]).toEqual({ date: '2026-09-01', count: 36, rating: 4.3 });
  });
});

describe('computeDeltas', () => {
  const hist = [
    { date: '2026-08-05', count: 30, rating: 4.1 },
    { date: '2026-09-01', count: 34, rating: 4.2 },
    { date: '2026-09-12', count: 38, rating: 4.3 },
  ];
  it('前回比・今月新規・30日比', () => {
    const d = computeDeltas(hist, jst(2026, 9, 12, 12));
    expect(d.count).toBe(38);
    expect(d.deltaPrev).toBe(4);          // 34→38
    expect(d.newThisMonth).toBe(4);       // 今月頭(9/1=34)→38
    expect(d.delta30).toBe(8);            // 約30日前(8/5=30)→38
    expect(d.hasHistory).toBe(true);
  });
  it('履歴1件なら比較なし・今月新規は計測不能(null)', () => {
    const d = computeDeltas([{ date: '2026-09-12', count: 10, rating: 4.0 }], jst(2026, 9, 12));
    expect(d.deltaPrev).toBe(null);
    expect(d.newThisMonth).toBe(null);   // 基準が1点だけ＝±0ではなく「—」
    expect(d.hasHistory).toBe(false);
  });
  it('先月末の基準があれば今月新規を算出', () => {
    const d = computeDeltas([{ date: '2026-08-31', count: 30, rating: 4.2 }, { date: '2026-09-12', count: 35, rating: 4.3 }], jst(2026, 9, 12));
    expect(d.newThisMonth).toBe(5); // 8/31基準(30)→35
  });
});

describe('reviewsInMonth（直近レビューから当月分の下限推定）', () => {
  const now = jst(2026, 9, 12, 12);
  it('publishTimeが当月のレビューを数える', () => {
    const reviews = [
      { publishTime: '2026-09-10T02:00:00Z' }, // JST 9/10
      { publishTime: '2026-09-01T00:30:00Z' }, // JST 9/1 09:30
      { publishTime: '2026-08-30T12:00:00Z' }, // 先月
    ];
    const r = reviewsInMonth(reviews, now);
    expect(r.count).toBe(2);
    expect(r.capped).toBe(false);
  });
  it('直近5件すべてが当月なら capped=true（＝5件以上の可能性）', () => {
    const reviews = Array.from({ length: 5 }, (_, i) => ({ publishTime: `2026-09-0${i + 1}T05:00:00Z` }));
    const r = reviewsInMonth(reviews, now);
    expect(r.count).toBe(5);
    expect(r.capped).toBe(true);
  });
  it('when フィールドや空でも落ちない', () => {
    expect(reviewsInMonth(null, now)).toEqual({ count: 0, capped: false });
    expect(reviewsInMonth([{ when: '2026-09-05T05:00:00Z' }], now).count).toBe(1);
  });
});

describe('meoFlags', () => {
  it('口コミ不足・低評価・今月新規0・低星・整備不足を検知', () => {
    const latest = { userRatingCount: 12, rating: 3.8, websiteUri: '', phone: '', hasHours: false, photoCount: 3, reviews: [{ rating: 1, text: '最悪' }] };
    const deltas = { hasHistory: true, newThisMonth: 0 };
    const codes = meoFlags(latest, deltas).map(f => f.code);
    expect(codes).toContain('reviews_low');
    expect(codes).toContain('rating_low');
    expect(codes).toContain('no_new_reviews');
    expect(codes).toContain('low_star_recent');
    expect(codes).toContain('no_website');
    expect(codes).toContain('no_phone');
    expect(codes).toContain('no_hours');
    expect(codes).toContain('photos_low');
  });
  it('好調店は good（今月+）', () => {
    const codes = meoFlags({ userRatingCount: 80, rating: 4.6 }, { hasHistory: true, newThisMonth: 5 }).map(f => f.code);
    expect(codes).toContain('reviews_up');
    expect(codes).not.toContain('reviews_low');
  });
});

describe('meoScore / alertWeight', () => {
  it('整備・評価・口コミが揃うと高スコア', () => {
    const hi = meoScore({ userRatingCount: 60, rating: 4.7, websiteUri: 'x', phone: '1', hasHours: true, photoCount: 20 });
    const lo = meoScore({ userRatingCount: 5, rating: 3.5, websiteUri: '', phone: '', hasHours: false, photoCount: 1 });
    expect(hi).toBeGreaterThan(lo);
    expect(hi).toBeLessThanOrEqual(100);
  });
  it('alertWeight は warn=2/info=1', () => {
    expect(alertWeight([{ level: 'warn' }, { level: 'info' }, { level: 'good' }])).toBe(3);
  });
});
