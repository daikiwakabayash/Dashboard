import { describe, it, expect } from 'vitest';
import { computePlanActuals, vn } from '../lib/plan-calc.js';

// ── テストデータ ──────────────────────────────────────────────────

const rawData = [
  // 恵比寿院 - 1月
  { branch: '恵比寿院', month: '25年1月', name: 'A', individualSales: 500000, newCount: 20, newEnroll: 12, churnCount: 2, prevMembers: 50 },
  { branch: '恵比寿院', month: '25年1月', name: 'B', individualSales: 300000, newCount: 10, newEnroll: 5, churnCount: 1, prevMembers: 30 },
  // 千葉駅院 - 1月
  { branch: '千葉駅院', month: '25年1月', name: 'C', individualSales: 400000, newCount: 15, newEnroll: 8, churnCount: 3, prevMembers: 40 },
  // 恵比寿院 - 12月（前月）
  { branch: '恵比寿院', month: '24年12月', name: 'A', individualSales: 450000, newCount: 18, newEnroll: 10, churnCount: 1, prevMembers: 48 },
  { branch: '恵比寿院', month: '24年12月', name: 'B', individualSales: 280000, newCount: 8, newEnroll: 4, churnCount: 2, prevMembers: 28 },
  // 千葉駅院 - 12月
  { branch: '千葉駅院', month: '24年12月', name: 'C', individualSales: 350000, newCount: 12, newEnroll: 6, churnCount: 2, prevMembers: 38 },
];

const mktData = [
  // 恵比寿院 - 1月
  { branch: '恵比寿院', month: '25年1月', media: 'HPB', adSpend: 100000, newCount: 15, enrollCount: 8, revenue: 400000 },
  { branch: '恵比寿院', month: '25年1月', media: 'Google', adSpend: 50000, newCount: 8, enrollCount: 4, revenue: 200000 },
  // 千葉駅院 - 1月
  { branch: '千葉駅院', month: '25年1月', media: 'HPB', adSpend: 80000, newCount: 10, enrollCount: 5, revenue: 300000 },
  // 恵比寿院 - 12月
  { branch: '恵比寿院', month: '24年12月', media: 'HPB', adSpend: 120000, newCount: 14, enrollCount: 7, revenue: 350000 },
  // 全媒体合計は除外されるべき
  { branch: '恵比寿院', month: '25年1月', media: '全媒体合計', adSpend: 150000, newCount: 23, enrollCount: 12, revenue: 600000 },
];

// ── vn（安全な数値変換） ──────────────────────────────────────────

describe('vn - 安全な数値変換', () => {
  it('通常の数値はそのまま丸める', () => {
    expect(vn(123.4)).toBe(123);
    expect(vn(123.6)).toBe(124);
  });

  it('nullは0を返す', () => {
    expect(vn(null)).toBe(0);
  });

  it('undefinedは0を返す', () => {
    expect(vn(undefined)).toBe(0);
  });

  it('NaNは0を返す', () => {
    expect(vn(NaN)).toBe(0);
  });

  it('Infinityは0を返す', () => {
    expect(vn(Infinity)).toBe(0);
    expect(vn(-Infinity)).toBe(0);
  });

  it('0は0を返す', () => {
    expect(vn(0)).toBe(0);
  });
});

// ── computePlanActuals ───────────────────────────────────────────

describe('computePlanActuals', () => {
  it('特定店舗の最新月実績を計算する', () => {
    const result = computePlanActuals(rawData, mktData, '恵比寿院');
    expect(result.branchName).toBe('恵比寿院');
    expect(result.latestMonth).toBe('25年1月');
    expect(result.totalSales).toBe(800000); // 500000 + 300000
    expect(result.totalNewCount).toBe(30);  // 20 + 10
    expect(result.totalNewEnroll).toBe(17); // 12 + 5
  });

  it('入会率を正しく計算する', () => {
    const result = computePlanActuals(rawData, mktData, '恵比寿院');
    // 17 / 30 * 100 = 56.67 → 57%
    expect(result.enrollRate).toBe(57);
  });

  it('退会率を正しく計算する', () => {
    const result = computePlanActuals(rawData, mktData, '恵比寿院');
    // churnCount: 2+1=3, prevMembers: 50+30=80
    // 3/80 * 100 = 3.75 → 4%
    expect(result.churnRate).toBe(4);
  });

  it('CPAを正しく計算する', () => {
    const result = computePlanActuals(rawData, mktData, '恵比寿院');
    // adSpend: 100000+50000=150000, newCount: 15+8=23
    // 150000/23 = 6521.7 → 6522
    expect(result.cpa).toBe(6522);
  });

  it('全媒体合計を除外する', () => {
    const result = computePlanActuals(rawData, mktData, '恵比寿院');
    // 全媒体合計を含めると adSpend=300000 になるはずだが、除外されて150000
    expect(result.totalAdSpend).toBe(150000);
  });

  it('前月の実績を計算する', () => {
    const result = computePlanActuals(rawData, mktData, '恵比寿院');
    expect(result.prevMonth).toBe('24年12月');
    expect(result.prevSales).toBe(730000); // 450000 + 280000
    expect(result.prevNewCount).toBe(26);  // 18 + 8
  });

  it('媒体別内訳を計算する', () => {
    const result = computePlanActuals(rawData, mktData, '恵比寿院');
    expect(result.mediaBreakdown).toHaveLength(2);
    const hpb = result.mediaBreakdown.find(m => m.media === 'HPB');
    expect(hpb).toBeDefined();
    expect(hpb.adSpend).toBe(100000);
    expect(hpb.newCount).toBe(15);
    expect(hpb.cpa).toBe(6667); // 100000/15
  });

  it('全店舗ランキングを生成する', () => {
    const result = computePlanActuals(rawData, mktData, '恵比寿院');
    expect(result.branchRanking).toHaveLength(2);
    // 恵比寿院(800000) > 千葉駅院(400000)
    expect(result.branchRanking[0].branch).toBe('恵比寿院');
    expect(result.branchRanking[1].branch).toBe('千葉駅院');
  });

  it('全店舗モード（空文字）で全データを集計する', () => {
    const result = computePlanActuals(rawData, mktData, '');
    expect(result.branchName).toBe('全店舗');
    expect(result.totalSales).toBe(1200000); // 500000+300000+400000
    expect(result.totalNewCount).toBe(45);   // 20+10+15
  });

  it('存在しない店舗名では空の結果を返す', () => {
    const result = computePlanActuals(rawData, mktData, '存在しない院');
    expect(result.totalSales).toBe(0);
    expect(result.totalNewCount).toBe(0);
    expect(result.cpa).toBe(0);
  });

  it('空のデータでもクラッシュしない', () => {
    const result = computePlanActuals([], [], '恵比寿院');
    expect(result.totalSales).toBe(0);
    expect(result.cpa).toBe(0);
    expect(result.mediaBreakdown).toEqual([]);
    expect(result.branchRanking).toEqual([]);
  });
});
