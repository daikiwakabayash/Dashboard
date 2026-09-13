import { describe, it, expect } from 'vitest';
import {
  ym, ymIndex, ymDiff, ymAdd, churnOf, churnFromBilling, buildCohort, buildCohortMatrix,
} from '../lib/cohort.js';

describe('年月ヘルパ', () => {
  it('ym / ymIndex / ymDiff / ymAdd', () => {
    expect(ym('2026-09-13 22:07:00')).toBe('2026-09');
    expect(ymDiff('2026-09', '2026-11')).toBe(2);
    expect(ymDiff('2026-11', '2027-01')).toBe(2);
    expect(ymAdd('2026-11', 2)).toBe('2027-01');
    expect(ymIndex('bad')).toBe(null);
    expect(ymDiff('2026-13', '2026-09')).toBe(null);
  });
});

describe('churnOf（来店ベース離反ルール）', () => {
  it('例1: 最終来店9月 → 10月ゼロ → 11月到達で9月離反', () => {
    // 現在=11月: (11-9)=2 → 離反確定・離反月=9月
    expect(churnOf(['2026-09'], '2026-11')).toEqual({ lastVisit: '2026-09', churnMonth: '2026-09', active: false });
    // 現在=10月: (10-9)=1 → まだ継続中
    expect(churnOf(['2026-09'], '2026-10')).toEqual({ lastVisit: '2026-09', churnMonth: null, active: true });
    // 現在=9月: 今月来店 → 継続中
    expect(churnOf(['2026-09'], '2026-09')).toEqual({ lastVisit: '2026-09', churnMonth: null, active: true });
  });
  it('例2: 来店9月・10月 → 11月ゼロ → 12月到達で10月離反', () => {
    expect(churnOf(['2026-09', '2026-10'], '2026-12')).toEqual({ lastVisit: '2026-10', churnMonth: '2026-10', active: false });
    expect(churnOf(['2026-09', '2026-10'], '2026-11')).toEqual({ lastVisit: '2026-10', churnMonth: null, active: true });
  });
  it('来店が1件も無ければ lastVisit=null・active=false（未来店）', () => {
    expect(churnOf([], '2026-11')).toEqual({ lastVisit: null, churnMonth: null, active: false });
  });
  it('順不同/重複でも最終来店月で判定', () => {
    expect(churnOf(['2026-10', '2026-09', '2026-10'], '2026-12').churnMonth).toBe('2026-10');
  });
});

describe('churnFromBilling（Square課金ベース離反）', () => {
  it('解約月があれば「最後の課金月と解約月の早い方」を離反月に', () => {
    expect(churnFromBilling(['2026-05', '2026-06', '2026-07'], '2026-07', '2026-09')).toBe('2026-07');
    // 解約後も名目請求が残った場合 → 解約月が優先（早い方）
    expect(churnFromBilling(['2026-05', '2026-06', '2026-07', '2026-08'], '2026-06', '2026-09')).toBe('2026-06');
  });
  it('解約日が無ければ課金の空白(既定2ヶ月)で離反確定＝最後の課金月', () => {
    expect(churnFromBilling(['2026-05', '2026-06'], null, '2026-09')).toBe('2026-06'); // 7・8月空き→離反=6月
    expect(churnFromBilling(['2026-05', '2026-06'], null, '2026-07')).toBe(null);        // まだ1ヶ月以内→継続
  });
  it('課金なしは null', () => {
    expect(churnFromBilling([], null, '2026-09')).toBe(null);
  });
});

describe('buildCohort（コホート集計・churnMonth駆動）', () => {
  // 2026-06 加入コホート・現在=2026-09（到達月齢3）
  const custs = [
    // 継続中・毎月1万課金（6,7,8,9月）
    { shopId: 1, cohortMonth: '2026-06', joined: true, started: true, churnMonth: null,
      revByMonth: { '2026-06': 10000, '2026-07': 10000, '2026-08': 10000, '2026-09': 10000 } },
    // 7月で離反（6,7月課金→8月空き→9月で確定）・離反月齢=1
    { shopId: 1, cohortMonth: '2026-06', joined: true, started: true, churnMonth: '2026-07',
      revByMonth: { '2026-06': 10000, '2026-07': 8000 } },
    // 開始したが加入せず・6月のみ課金→離反月齢0
    { shopId: 1, cohortMonth: '2026-06', joined: false, started: true, churnMonth: '2026-06',
      revByMonth: { '2026-06': 3000 } },
    // 未開始（started=false・売上なし）＝獲得のみ
    { shopId: 1, cohortMonth: '2026-06', joined: false, started: false, churnMonth: null, revByMonth: {} },
  ];
  const c = buildCohort(custs, { asOf: '2026-09', horizon: 12 });

  it('サイズ・入会・開始・到達月齢', () => {
    expect(c.size).toBe(4);
    expect(c.joined).toBe(2);
    expect(c.started).toBe(3);
    expect(c.maxAge).toBe(3); // 6月→9月
  });
  it('離反月齢ヒストグラム（何ヶ月目に離反が多いか）', () => {
    // 月齢0で1人(3人目)、月齢1で1人(2人目)、継続中1人
    expect(c.churnByAge[0]).toBe(1);
    expect(c.churnByAge[1]).toBe(1);
    expect(c.churnByAge[2]).toBe(0);
    expect(c.churnedTotal).toBe(2);
    expect(c.avgLifetimeMonths).toBe(0.5); // (0+1)/2
  });
  it('継続者数と継続率（分母=開始者3人）', () => {
    // age0: 全員継続(3) / age1: 3人目離反済→2 / age2: 2人目も離反→1 / age3: 1
    expect(c.activeByAge[0]).toBe(3);
    expect(c.activeByAge[1]).toBe(2);
    expect(c.activeByAge[2]).toBe(1);
    expect(c.retentionByAge[0]).toBe(100);
    expect(c.retentionByAge[2]).toBe(33.3);
  });
  it('LTV/ARPU（累計売上）', () => {
    // 月齢別売上: age0=10000+10000+3000=23000, age1=10000+8000=18000, age2=10000, age3=10000
    expect(c.revByAgeTotal[0]).toBe(23000);
    expect(c.revByAgeTotal[1]).toBe(18000);
    // 累計/契約(joined=2): age0=11500, age1=(23000+18000)/2=20500
    expect(c.ltvByAgeJoin[0]).toBe(11500);
    expect(c.ltvByAgeJoin[1]).toBe(20500);
    // 獲得あたり(size=4): age3累計=(23000+18000+10000+10000)=61000 /4 = 15250
    expect(c.ltvByAgeBooking[3]).toBe(15250);
    // ARPU age2 = 10000 / activeByAge[2]=1 = 10000
    expect(c.arpuByAge[2]).toBe(10000);
  });
});

describe('buildCohortMatrix（店舗×加入月・全店合算）', () => {
  const custs = [
    { shopId: 1, cohortMonth: '2026-06', joined: true, started: true, churnMonth: null, revByMonth: { '2026-06': 10000 } },
    { shopId: 2, cohortMonth: '2026-06', joined: true, started: true, churnMonth: null, revByMonth: { '2026-06': 20000 } },
    { shopId: 1, cohortMonth: '2026-07', joined: false, started: true, churnMonth: '2026-07', revByMonth: { '2026-07': 5000 } },
  ];
  const m = buildCohortMatrix(custs, { asOf: '2026-09', horizon: 12 });
  it('店舗×月キーで分割される', () => {
    expect(m.byCohort['1||2026-06'].size).toBe(1);
    expect(m.byCohort['2||2026-06'].size).toBe(1);
    expect(m.byCohort['1||2026-07'].size).toBe(1);
  });
  it('全店合算は加入月単位（店舗をまたいで合算）', () => {
    expect(m.allByMonth['2026-06'].size).toBe(2);       // 店1+店2
    expect(m.allByMonth['2026-06'].revByAgeTotal[0]).toBe(30000);
  });
});
