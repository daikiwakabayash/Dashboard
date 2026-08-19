import { describe, it, expect } from 'vitest';
import {
  ALLOWANCE_THRESHOLD, ALLOWANCE_CATEGORIES, getAllowanceCategory, allowanceCategoryKeys,
  isOverThreshold, computeMonthlyCap, computeChargeLedger, computeAllowanceForMonth,
} from '../lib/allowances.js';

describe('allowance categories', () => {
  it('健康=毎月上限型 / 勉強・アクセス=通算チャージ型', () => {
    expect(getAllowanceCategory('health').type).toBe('monthly');
    expect(getAllowanceCategory('study').type).toBe('charge');
    expect(getAllowanceCategory('access').type).toBe('charge');
    expect(allowanceCategoryKeys()).toEqual(['health', 'study', 'access']);
    expect(getAllowanceCategory('nope')).toBeNull();
  });
  it('しきい値は100万円（超で対象）', () => {
    expect(ALLOWANCE_THRESHOLD).toBe(1000000);
    expect(isOverThreshold(1000001)).toBe(true);
    expect(isOverThreshold(1000000)).toBe(false);
    expect(isOverThreshold(999999)).toBe(false);
  });
});

describe('computeMonthlyCap（毎月上限型）', () => {
  it('生産性>100万: 上限1万で頭打ち（1.1万→1万）', () => {
    const r = computeMonthlyCap({ requested: 11000, cap: 10000, over: true });
    expect(r.used).toBe(10000);
    expect(r.capped).toBe(true);
    expect(r.rejected).toBe(1000);
  });
  it('生産性>100万: 上限内はそのまま', () => {
    expect(computeMonthlyCap({ requested: 7000, cap: 10000, over: true }).used).toBe(7000);
  });
  it('生産性≤100万: 0円（対象外）', () => {
    const r = computeMonthlyCap({ requested: 8000, cap: 10000, over: false });
    expect(r.eligible).toBe(false);
    expect(r.used).toBe(0);
    expect(r.rejected).toBe(8000);
  });
});

describe('computeChargeLedger（通算チャージ型）', () => {
  it('1・2月達成→3月にまとめて2万使用できる', () => {
    const months = [
      { month: '2026-01', over: true, requested: 0 },
      { month: '2026-02', over: true, requested: 0 },
      { month: '2026-03', over: false, requested: 20000 },
    ];
    const led = computeChargeLedger(months);
    const mar = led.rows.find((r) => r.month === '2026-03');
    expect(mar.used).toBe(20000);
    expect(led.balanceEnd).toBe(0);
  });
  it('残高を超える使用はNG（rejected）', () => {
    const months = [
      { month: '2026-01', over: true, requested: 0 },   // +1万
      { month: '2026-02', over: false, requested: 15000 }, // 残高1万→1万使用・5千却下
    ];
    const led = computeChargeLedger(months);
    const feb = led.rows.find((r) => r.month === '2026-02');
    expect(feb.used).toBe(10000);
    expect(feb.rejected).toBe(5000);
    expect(led.balanceEnd).toBe(0);
  });
  it('年末に残った枠は失効（forfeited）', () => {
    const months = [
      { month: '2026-11', over: true, requested: 0 },   // +1万
      { month: '2026-12', over: true, requested: 15000 }, // +1万→残高2万→1.5万使用
    ];
    const led = computeChargeLedger(months);
    expect(led.balanceEnd).toBe(5000);
    expect(led.forfeited).toBe(5000);
  });
  it('4回達成で年間4万枠', () => {
    const months = ['01', '02', '05', '06'].map((mm) => ({ month: `2026-${mm}`, over: true, requested: 0 }));
    expect(computeChargeLedger(months).balanceEnd).toBe(40000);
  });
});

describe('computeAllowanceForMonth（明細計上額）', () => {
  it('健康手当: 対象月の生産性で判定・上限1万', () => {
    const r = computeAllowanceForMonth(getAllowanceCategory('health'), '2026-06', [
      { month: '2026-06', over: true, requested: 12000 },
    ]);
    expect(r.used).toBe(10000);
    expect(r.note).toBe('健康手当');
  });
  it('勉強代手当: 過去チャージ分を対象月に使用', () => {
    const r = computeAllowanceForMonth(getAllowanceCategory('study'), '2026-03', [
      { month: '2026-01', over: true, requested: 0 },
      { month: '2026-02', over: true, requested: 0 },
      { month: '2026-03', over: false, requested: 18000 },
    ]);
    expect(r.used).toBe(18000);
    expect(r.balanceAfter).toBe(2000); // 2万チャージ−1.8万
  });
  it('対象月より後の履歴は無視する', () => {
    const r = computeAllowanceForMonth(getAllowanceCategory('study'), '2026-02', [
      { month: '2026-01', over: true, requested: 0 },
      { month: '2026-02', over: false, requested: 10000 },
      { month: '2026-03', over: true, requested: 0 }, // 未来分は使えない
    ]);
    expect(r.used).toBe(10000);
    expect(r.balanceAfter).toBe(0);
  });
});
