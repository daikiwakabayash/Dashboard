import { describe, it, expect } from 'vitest';
import { mergeAppointment, mergeAppointments, mergeDismissed, flatten, linkMetaFromForced, buildLinkCohort } from '../lib/soflmap.js';

describe('mergeDismissed（予約取り消し＝dismissed の顧客を集める）', () => {
  it('dismissed_at がある予約の顧客IDだけ集める（キャンセルは対象外）', () => {
    const set = mergeDismissed({}, [
      { customer_id: 1, dismissed_at: '2026-09-10 01:40:29', cancelled_at: '2026-09-10 01:56' }, // 取り消し
      { customer_id: 2, dismissed_at: null, cancelled_at: '2026-09-09 00:01' },                   // 通常キャンセル
      { customer_id: 3, dismissed_at: '2026-09-11 10:00' },                                        // 取り消し
      { customer_id: null, dismissed_at: '2026-09-11 10:00' },                                     // 顧客なしは無視
    ]);
    expect(set).toEqual({ '1': 1, '3': 1 });
  });
});

describe('mergeAppointment（顧客→施策リンク帰属）', () => {
  it('customer_id か forced_link_id が無い行は無視', () => {
    let m = {};
    m = mergeAppointment(m, { customer_id: null, forced_link_id: 5, created_at: '2026-09-01' });
    m = mergeAppointment(m, { customer_id: 1, forced_link_id: null, created_at: '2026-09-01' });
    expect(Object.keys(m).length).toBe(0);
  });
  it('両方揃った行を取り込む', () => {
    const m = mergeAppointment({}, { customer_id: 42, forced_link_id: 1587, created_at: '2026-09-01 10:00:00' });
    expect(m['42']).toEqual({ fl: 1587, ca: '2026-09-01 10:00:00' });
  });
  it('より古い created_at の予約（獲得時）を優先して置換', () => {
    let m = {};
    m = mergeAppointment(m, { customer_id: 7, forced_link_id: 200, created_at: '2026-09-10 10:00:00' });
    m = mergeAppointment(m, { customer_id: 7, forced_link_id: 100, created_at: '2026-09-01 09:00:00' }); // 古い→採用
    expect(m['7'].fl).toBe(100);
    m = mergeAppointment(m, { customer_id: 7, forced_link_id: 999, created_at: '2026-09-20 10:00:00' }); // 新しい→無視
    expect(m['7'].fl).toBe(100);
  });
});

describe('mergeAppointments / flatten', () => {
  it('複数行をまとめて取り込み、flattenで id→fl になる', () => {
    const m = mergeAppointments({}, [
      { customer_id: 1, forced_link_id: 10, created_at: '2026-09-01' },
      { customer_id: 2, forced_link_id: 20, created_at: '2026-09-01' },
      { customer_id: 3, forced_link_id: null, created_at: '2026-09-01' }, // 対象外
    ]);
    expect(flatten(m)).toEqual({ '1': 10, '2': 20 });
  });
});

describe('linkMetaFromForced', () => {
  it('forced_link_id → {t,m,n}', () => {
    const meta = linkMetaFromForced([
      { forced_link_id: 1587, title: 'HP', visit_source_name: 'HP', menu_name: null },
      { forced_link_id: 5312, title: '【META新規限定】肩こり 1,000円', visit_source_name: 'META', menu_name: '肩こり60分' },
    ]);
    expect(meta['1587']).toEqual({ t: 'HP', m: 'HP', n: '' });
    expect(meta['5312'].t).toBe('【META新規限定】肩こり 1,000円');
    expect(meta['5312'].m).toBe('META');
  });
});

describe('buildLinkCohort（コホートを施策リンク別に集計）', () => {
  const linkMeta = {
    '100': { t: '【META】肩こり1,000円', m: 'META', n: '肩こり60分' },
    '200': { t: '【META】肩こり1,000円', m: 'META', n: '肩こり60分' }, // 同一文言＝合算
    '300': { t: '【META】腰痛3,000円', m: 'META', n: '腰痛60分' },
  };
  const custMap = { '1': 100, '2': 200, '3': 300, '4': 300 }; // 5,6 はリンクなし
  const custRows = [
    { customer_id: 1, visited_completed: true, joined: true, ltv: 20000, visit_source_name: 'META' },
    { customer_id: 2, visited_completed: false, joined: false, ltv: 0, visit_source_name: 'META' },     // キャンセル
    { customer_id: 3, visited_completed: true, joined: false, ltv: 8000, visit_source_name: 'META' },
    { customer_id: 4, visited_completed: true, joined: true, ltv: 30000, visit_source_name: 'META' },
    { customer_id: 5, visited_completed: true, joined: false, ltv: 5000, visit_source_name: 'ホットペッパー' },
    { customer_id: 6, visited_completed: false, joined: false, ltv: 0, visit_source_name: 'HP' },
  ];
  const rows = buildLinkCohort(custRows, custMap, linkMeta);

  it('同一タイトルは合算され、予約数降順に並ぶ', () => {
    const titles = rows.map(r => r.title);
    // 肩こり(cust1,2)=2件, 腰痛(cust3,4)=2件, リンクなし(cust5,6)=2件 → 全て2件
    expect(titles).toContain('【META】肩こり1,000円');
    expect(titles).toContain('【META】腰痛3,000円');
    expect(titles).toContain('リンクなし');
    const kata = rows.find(r => r.title === '【META】肩こり1,000円');
    expect(kata.booking).toBe(2);      // cust1 + cust2（fl 100と200が同一文言で合算）
    expect(kata.visit).toBe(1);        // cust1のみ来店
    expect(kata.cancel).toBe(1);       // cust2 未来店
    expect(kata.join).toBe(1);         // cust1入会
    expect(kata.joinRate).toBe(100);   // 入会1/来店1
    expect(kata.cancelRate).toBe(50);  // 1/2
    expect(kata.ltv).toBe(20000);
  });

  it('リンクなしバケットは媒体混在を「N媒体」で表現', () => {
    const none = rows.find(r => r.title === 'リンクなし');
    expect(none.booking).toBe(2);
    expect(none.media).toBe('2媒体'); // ホットペッパー + HP
  });

  it('腰痛グループの集計', () => {
    const yo = rows.find(r => r.title === '【META】腰痛3,000円');
    expect(yo.booking).toBe(2);
    expect(yo.visit).toBe(2);
    expect(yo.join).toBe(1);       // cust4のみ
    expect(yo.joinRate).toBe(50);  // 1/2来店
    expect(yo.avgLtv).toBe(19000); // (8000+30000)/2
  });
});
