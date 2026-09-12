import { describe, it, expect } from 'vitest';
import {
  toJst, ymOf, prevYM, monthLabel, getVotingState,
  voteId, validateVote, upsertVote, removeVote, receivedFor, tallyRanking, listPeriods,
  autoPublishAtMs, isAutoPublished, isPeriodPublished, autoPublishLabel,
} from '../lib/thanksgift.js';

// JSTの壁時計の指定日時をUTC epochで作る（JST = UTC+9）
const jst = (y, m, d, hh = 0, mm = 0) => new Date(Date.UTC(y, m - 1, d, hh - 9, mm));

describe('自動公開（翌月の第2火曜13:00 JST）', () => {
  it('8月分は9月の第2火曜(9/8)13:00に公開', () => {
    expect(autoPublishLabel('2026-08')).toBe('2026年9月8日(火) 13:00');
    expect(isAutoPublished('2026-08', jst(2026, 9, 8, 12, 59))).toBe(false); // 直前は未公開
    expect(isAutoPublished('2026-08', jst(2026, 9, 8, 13, 0))).toBe(true);   // 13:00ちょうどで公開
    expect(isAutoPublished('2026-08', jst(2026, 9, 12))).toBe(true);
  });
  it('9月分は10月の第2火曜(10/13)13:00に公開', () => {
    expect(autoPublishLabel('2026-09')).toBe('2026年10月13日(火) 13:00');
    expect(isAutoPublished('2026-09', jst(2026, 10, 13, 12, 59))).toBe(false);
    expect(isAutoPublished('2026-09', jst(2026, 10, 13, 13, 0))).toBe(true);
  });
  it('年跨ぎ: 12月分は翌年1月の第2火曜に公開', () => {
    // 2027-01-01 は金曜 → 第1火曜1/5・第2火曜1/12
    expect(autoPublishLabel('2026-12')).toBe('2027年1月12日(火) 13:00');
  });
  it('実効公開: 手動非公開が最優先・手動公開は前倒し', () => {
    const now = jst(2026, 9, 12); // 8月分は自動公開済みのタイミング
    expect(isPeriodPublished('2026-08', [], [], now)).toBe(true);            // 自動公開
    expect(isPeriodPublished('2026-08', [], ['2026-08'], now)).toBe(false);  // 本部が緊急で非公開
    expect(isPeriodPublished('2026-09', [], [], now)).toBe(false);           // まだ自動公開前
    expect(isPeriodPublished('2026-09', ['2026-09'], [], now)).toBe(true);   // 本部が前倒し公開
  });
});

describe('prevYM / monthLabel', () => {
  it('前月（年跨ぎ）', () => {
    expect(prevYM('2026-09')).toBe('2026-08');
    expect(prevYM('2026-01')).toBe('2025-12');
  });
  it('表示ラベル', () => {
    expect(monthLabel('2026-08')).toBe('2026年8月');
  });
});

describe('getVotingState（投票期間: 毎月1日00:01〜2日23:59 JST・対象=前月）', () => {
  it('9/1 00:01は開いていて対象は8月', () => {
    const s = getVotingState(jst(2026, 9, 1, 0, 1));
    expect(s.open).toBe(true);
    expect(s.targetMonth).toBe('2026-08');
  });
  it('9/1 00:00はまだ閉じている', () => {
    expect(getVotingState(jst(2026, 9, 1, 0, 0)).open).toBe(false);
  });
  it('9/2 23:59は開いている（対象8月）', () => {
    const s = getVotingState(jst(2026, 9, 2, 23, 59));
    expect(s.open).toBe(true);
    expect(s.targetMonth).toBe('2026-08');
  });
  it('9/3 00:00は閉じている', () => {
    expect(getVotingState(jst(2026, 9, 3, 0, 0)).open).toBe(false);
  });
  it('月中（9/15）は閉じている', () => {
    expect(getVotingState(jst(2026, 9, 15, 12, 0)).open).toBe(false);
  });
  it('年跨ぎ: 1/1に投票→対象は前年12月', () => {
    const s = getVotingState(jst(2027, 1, 1, 9, 0));
    expect(s.open).toBe(true);
    expect(s.targetMonth).toBe('2026-12');
  });
  it('JST変換の境界（UTC前日15:00=JST翌0:00）', () => {
    // 2026-08-31 15:01 UTC = 2026-09-01 00:01 JST → open
    const s = getVotingState(new Date(Date.UTC(2026, 7, 31, 15, 1)));
    expect(s.open).toBe(true);
    expect(s.targetMonth).toBe('2026-08');
  });
});

describe('validateVote（1人1票・自分不可）', () => {
  const base = { period: '2026-08', fromStaffId: '10', toStaffId: '20', toStaffName: 'B' };
  it('正常', () => expect(validateVote(base).ok).toBe(true));
  it('自分への投票は不可', () => expect(validateVote({ ...base, toStaffId: '10' }).error).toBe('self_vote'));
  it('対象月が不正', () => expect(validateVote({ ...base, period: 'x' }).error).toBe('invalid_period'));
  it('宛先なし', () => expect(validateVote({ ...base, toStaffId: '' }).error).toBe('missing_to'));
});

describe('upsertVote（1人1票を保証）', () => {
  it('同じ人・同じ対象月の投票は置き換わる（票は増えない）', () => {
    let v = [];
    v = upsertVote(v, { period: '2026-08', fromStaffId: '10', fromStaffName: '若林', toStaffId: '20', toStaffName: 'A', comment: '最初' });
    v = upsertVote(v, { period: '2026-08', fromStaffId: '10', fromStaffName: '若林', toStaffId: '30', toStaffName: 'B', comment: '変更' });
    expect(v.length).toBe(1);
    expect(v[0].toStaffId).toBe('30');
    expect(v[0].comment).toBe('変更');
  });
  it('別の対象月は別票として蓄積', () => {
    let v = [];
    v = upsertVote(v, { period: '2026-08', fromStaffId: '10', toStaffId: '20' });
    v = upsertVote(v, { period: '2026-09', fromStaffId: '10', toStaffId: '20' });
    expect(v.length).toBe(2);
  });
  it('取り消し', () => {
    let v = upsertVote([], { period: '2026-08', fromStaffId: '10', toStaffId: '20' });
    v = removeVote(v, '2026-08', '10');
    expect(v.length).toBe(0);
  });
});

describe('receivedFor / tallyRanking（1票=1ポイント）', () => {
  const votes = [
    { id: '2026-08__1', period: '2026-08', fromStaffId: '1', fromStaffName: '若林', toStaffId: '99', toStaffName: '田中', toShop: '大森院', comment: 'ありがとう', createdAt: '2026-09-01T00:05:00Z' },
    { id: '2026-08__2', period: '2026-08', fromStaffId: '2', fromStaffName: '佐藤', toStaffId: '99', toStaffName: '田中', toShop: '大森院', comment: '助かった', createdAt: '2026-09-01T01:00:00Z' },
    { id: '2026-08__3', period: '2026-08', fromStaffId: '3', fromStaffName: '鈴木', toStaffId: '77', toStaffName: '山本', toShop: '銀座院', comment: '感謝', createdAt: '2026-09-02T00:00:00Z' },
    { id: '2026-07__1', period: '2026-07', fromStaffId: '1', fromStaffName: '若林', toStaffId: '99', toStaffName: '田中', toShop: '大森院', comment: '先月も', createdAt: '2026-08-01T00:00:00Z' },
  ];
  it('受け取った票（田中）は3件・対象月降順', () => {
    const r = receivedFor(votes, '99');
    expect(r.length).toBe(3);
    expect(r[0].period).toBe('2026-08');
  });
  it('書かれていない人は空', () => {
    expect(receivedFor(votes, '12345').length).toBe(0);
  });
  it('8月ランキング: 田中2票 > 山本1票', () => {
    const r = tallyRanking(votes, '2026-08');
    expect(r[0].toStaffName).toBe('田中');
    expect(r[0].points).toBe(2);
    expect(r[0].voters.length).toBe(2);
    expect(r[1].toStaffName).toBe('山本');
    expect(r[1].points).toBe(1);
  });
  it('全期間ランキング: 田中は3票', () => {
    const r = tallyRanking(votes);
    expect(r[0].toStaffName).toBe('田中');
    expect(r[0].points).toBe(3);
  });
  it('期間一覧は降順', () => {
    expect(listPeriods(votes)).toEqual(['2026-08', '2026-07']);
  });
});
