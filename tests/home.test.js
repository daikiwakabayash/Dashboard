import { describe, it, expect } from 'vitest';
import {
  metric, tone, METRIC_DIR, DEFAULT_RULES, attentionShops, pendingApprovals,
  waitedLabel, sourceNote, buildHome,
} from '../lib/home.js';

const T = Date.parse('2026-09-18T10:00:00Z');

describe('🔴 未取得を 0 で埋めない', () => {
  it('値が無ければ null のまま、理由を添える', () => {
    const m = metric({ key: 'cpa', label: 'CPA', value: null, missing: 'Meta未接続' });
    expect(m.value).toBe(null);
    expect(m.missing).toBe('Meta未接続');
    expect(m.diff).toBe(null);
    expect(m.ratio).toBe(null);
  });
  it('理由が無くても「未取得」とだけは書く（空欄にしない）', () => {
    expect(metric({ key: 'x', label: 'X' }).missing).toBe('未取得');
  });
  it('🔴 0 は「取れている 0」として扱う（未取得と混ぜない）', () => {
    const m = metric({ key: 'newVisit', label: '新規', value: 0, prev: 10 });
    expect(m.value).toBe(0);
    expect(m.missing).toBe('');
    expect(m.diff).toBe(-10);
  });
  it('前月が無ければ増減を作らない', () => {
    expect(metric({ key: 'sales', label: '売上', value: 100 }).ratio).toBe(null);
  });
  it('前月が0なら割合を作らない（無限大を出さない）', () => {
    const m = metric({ key: 'sales', label: '売上', value: 100, prev: 0 });
    expect(m.diff).toBe(100);
    expect(m.ratio).toBe(null);
  });
  it('数字でないものは未取得にする', () => {
    expect(metric({ key: 'x', label: 'X', value: 'たくさん' }).value).toBe(null);
  });
});

describe('良し悪しの向き', () => {
  it('増えるほど良い指標と、減るほど良い指標を分ける', () => {
    expect(METRIC_DIR.sales).toBe('up');
    expect(METRIC_DIR.cpa).toBe('down');
    expect(tone(metric({ key: 'sales', label: '', value: 120, prev: 100 }))).toBe('good');
    expect(tone(metric({ key: 'cpa', label: '', value: 120, prev: 100 }))).toBe('bad');
    expect(tone(metric({ key: 'cpa', label: '', value: 80, prev: 100 }))).toBe('good');
  });
  it('わずかな差は「横ばい」にする（毎月どちらかに振れて見せない）', () => {
    expect(tone(metric({ key: 'sales', label: '', value: 101, prev: 100 }))).toBe('flat');
  });
  it('🔴 未取得・向きの決まっていない指標に良し悪しを付けない', () => {
    expect(tone(metric({ key: 'sales', label: '', value: null }))).toBe('none');
    expect(tone(metric({ key: 'adSpend', label: '', value: 120, prev: 100 }))).toBe('none');
    expect(tone(null)).toBe('none');
  });
});

describe('要確認の店舗（事実と理由だけ）', () => {
  const SHOPS = [
    { id: '1', name: '鶴見院', sales: 80, prevSales: 100, newVisit: 8, prevNewVisit: 10, repeatRate: 0.5, cancelRate: 0.05 },
    { id: '2', name: '関内院', sales: 100, prevSales: 100, newVisit: 10, prevNewVisit: 10, repeatRate: 0.25, cancelRate: 0.3 },
    { id: '3', name: '仙台院', sales: 120, prevSales: 100, newVisit: 12, prevNewVisit: 10, repeatRate: 0.6, cancelRate: 0.05 },
    { id: '4', name: '未取得院' },
  ];
  const got = attentionShops(SHOPS);
  it('理由の数が同じなら、売上の落ち幅が大きい店舗が上に来る', () => {
    // 鶴見院（売上-20%・新規-20%）と関内院（キャンセル30%・2回目25%）はどちらも2件。
    // 落ち幅のある鶴見院が先。⚠️ 点数を付けて順位を断定しているのではなく、並べる順の約束。
    expect(got.shops.map(s => s.name)).toEqual(['鶴見院', '関内院']);
    expect(got.shops[0].reasons).toHaveLength(2);
    expect(got.shops[1].reasons).toHaveLength(2);
  });
  it('理由は人が読める言葉になっている', () => {
    expect(got.shops[0].reasons.map(r => r.text)).toEqual(['売上が前月より 20% 少ない', '新規が前月より 20% 少ない']);
    expect(got.shops[1].reasons.map(r => r.text)).toEqual(['キャンセル率が 30%', '2回目来店率が 25%']);
  });
  it('問題の無い店舗は出さない', () => {
    expect(got.shops.map(s => s.name)).not.toContain('仙台院');
  });
  it('🔴 数値が無い店舗を「悪い」にしない（未取得として分ける）', () => {
    expect(got.shops.map(s => s.name)).not.toContain('未取得院');
    expect(got.unknown).toEqual([{ id: '4', name: '未取得院', missing: '数値が未取得です' }]);
  });
  it('件数を絞っても、全体の数は分かる', () => {
    const one = attentionShops(SHOPS, DEFAULT_RULES, { limit: 1 });
    expect(one.shops).toHaveLength(1);
    expect(one.total).toBe(2);
  });
  it('しきい値を変えられる', () => {
    const strict = attentionShops(SHOPS, { salesDrop: 0.05 });
    expect(strict.total).toBe(2);
    const loose = attentionShops(SHOPS, { salesDrop: 0.9, newDrop: 0.9, cancelHigh: 0.9, repeatLow: 0.01 });
    expect(loose.total).toBe(0);
  });
  it('🔴 前月が0のとき、落ち込みを作らない（割り算しない）', () => {
    expect(attentionShops([{ id: 'x', name: 'X', sales: 0, prevSales: 0, repeatRate: 0.9, cancelRate: 0 }]).total).toBe(0);
  });
  it('壊れた入力でも落ちない', () => {
    expect(attentionShops(null).shops).toEqual([]);
    expect(attentionShops([null, {}]).shops).toEqual([]);
  });
});

describe('承認待ち', () => {
  const ITEMS = [
    { id: 'a', title: '広告の停止', requestedName: '本部', requestedAt: T - 3 * 86400000, status: 'pending' },
    { id: 'b', title: '予算の変更', requestedName: '鶴見', requestedAt: T - 3600000, status: 'pending' },
    { id: 'c', title: '済んだもの', requestedAt: T, status: 'approved' },
  ];
  it('待っているものだけを、古い順に出す', () => {
    const got = pendingApprovals(ITEMS, T);
    expect(got.items.map(x => x.id)).toEqual(['a', 'b']);
    expect(got.total).toBe(2);
  });
  it('🔴 期限切れを「承認済み」にしない（待ち時間を出すだけ）', () => {
    expect(pendingApprovals(ITEMS, T).items[0].waitedMs).toBe(3 * 86400000);
  });
  it('待ち時間を人の言葉にする', () => {
    expect(waitedLabel(3 * 86400000)).toBe('3日待ち');
    expect(waitedLabel(5 * 3600000)).toBe('5時間待ち');
    expect(waitedLabel(60000)).toBe('1時間以内');
    expect(waitedLabel(-1)).toBe('');
    expect(waitedLabel('x')).toBe('');
  });
  it('件数を絞っても全体の数は分かる', () => {
    expect(pendingApprovals(ITEMS, T, 1)).toMatchObject({ total: 2 });
  });
});

describe('🔴 出典・対象期間・更新時刻を必ず出す', () => {
  it('そろっていれば1行にまとめる', () => {
    expect(sourceNote({ source: 'SalonOne', period: '2026-09', updatedAt: '9/18 10:00' }))
      .toBe('SalonOne／2026-09／9/18 10:00');
  });
  it('🔴 分からないものは「不明」と書く（空欄で誤魔化さない）', () => {
    expect(sourceNote({})).toBe('出典不明／対象期間不明／更新時刻不明');
    expect(sourceNote(null)).toContain('出典不明');
  });
});

describe('経営ホームの組み立て', () => {
  it('取れていない指標があることを、画面の上に出す', () => {
    const h = buildHome({
      metrics: [{ key: 'sales', label: '売上', value: 100, prev: 90 }, { key: 'cpa', label: 'CPA', value: null, missing: 'Meta未接続' }],
      shops: [], approvals: [],
    });
    expect(h.notice).toBe('CPAは未取得です（0ではありません）');
    expect(h.metrics).toHaveLength(2);
  });
  it('すべて取れていれば注記は出ない', () => {
    expect(buildHome({ metrics: [{ key: 'sales', label: '売上', value: 100 }] }).notice).toBe('');
  });
  it('何も渡さなくても落ちない', () => {
    const h = buildHome();
    expect(h.metrics).toEqual([]);
    expect(h.attention.shops).toEqual([]);
    expect(h.approvals.items).toEqual([]);
  });
});
