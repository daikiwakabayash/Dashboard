import { describe, it, expect } from 'vitest';
import {
  parseOwnerPasswords, hashOwnerToken, verifyOwnerLogin, verifyOwnerToken,
  normalizeRecord, computeSettlement, SETTLEMENT_STATUS, SETTLEMENT_SCHEDULE, SETTLEMENT_NOTES,
} from '../lib/settlement.js';

const SALT = 'test-salt';

describe('parseOwnerPasswords', () => {
  it('parses valid JSON object', () => {
    expect(parseOwnerPasswords('{"野島オーナー":"abc","若林大樹オーナー":"xyz"}'))
      .toEqual({ '野島オーナー': 'abc', '若林大樹オーナー': 'xyz' });
  });
  it('returns {} for empty / invalid / array', () => {
    expect(parseOwnerPasswords('')).toEqual({});
    expect(parseOwnerPasswords('not json')).toEqual({});
    expect(parseOwnerPasswords('[1,2]')).toEqual({});
    expect(parseOwnerPasswords(undefined)).toEqual({});
  });
});

describe('owner auth token', () => {
  const pw = { '野島オーナー': 'abc', '若林大樹オーナー': 'xyz' };

  it('login by password only finds the owner (unique PASS)', () => {
    const r = verifyOwnerLogin(pw, { password: 'xyz' }, SALT);
    expect(r.owner).toBe('若林大樹オーナー');
    expect(r.token).toBe(hashOwnerToken('若林大樹オーナー', 'xyz', SALT));
  });
  it('login with explicit owner + password', () => {
    const r = verifyOwnerLogin(pw, { owner: '野島オーナー', password: 'abc' }, SALT);
    expect(r.owner).toBe('野島オーナー');
  });
  it('rejects wrong password', () => {
    expect(verifyOwnerLogin(pw, { owner: '野島オーナー', password: 'zzz' }, SALT)).toBeNull();
    expect(verifyOwnerLogin(pw, { password: 'nope' }, SALT)).toBeNull();
    expect(verifyOwnerLogin(pw, { password: '' }, SALT)).toBeNull();
  });
  it('verifyOwnerToken round-trips and rejects tampering', () => {
    const { owner, token } = verifyOwnerLogin(pw, { password: 'abc' }, SALT);
    expect(verifyOwnerToken(pw, owner, token, SALT)).toBe(true);
    expect(verifyOwnerToken(pw, owner, token + 'x', SALT)).toBe(false);
    expect(verifyOwnerToken(pw, '別人オーナー', token, SALT)).toBe(false);
    // 別オーナーのトークンで他人になりすませない
    expect(verifyOwnerToken(pw, '若林大樹オーナー', token, SALT)).toBe(false);
  });
});

describe('normalizeRecord', () => {
  it('requires shopId and YYYY-MM month', () => {
    expect(normalizeRecord({ shopId: '', month: '2026-07' })).toBeNull();
    expect(normalizeRecord({ shopId: '5', month: '2026-7' })).toBeNull();
    expect(normalizeRecord(null)).toBeNull();
  });
  it('parses string snapshot and defaults status to published', () => {
    const r = normalizeRecord({ shopId: 5, month: '2026-07', snapshot: '{"billTotal":1000}' });
    expect(r.shopId).toBe('5');
    expect(r.snapshot.billTotal).toBe(1000);
    expect(r.status).toBe(SETTLEMENT_STATUS.PUBLISHED);
  });
  it('keeps valid status and object snapshot', () => {
    const r = normalizeRecord({ shopId: '5', month: '2026-07', status: 'confirmed', snapshot: { a: 1 }, owner: '野島オーナー' });
    expect(r.status).toBe('confirmed');
    expect(r.snapshot.a).toBe(1);
    expect(r.owner).toBe('野島オーナー');
  });
});

describe('computeSettlement', () => {
  it('computes royalty, billTotal, refund and fee rate (千葉駅7月の実測値近似)', () => {
    const r = computeSettlement({ cash: 0, squareSales: 5367600, hpb: 0, royaltyRate: 15,
      taxRate: 10, squareFees: 144402, spotip: 10000, metaTotal: 0, adjTotal: 0 });
    expect(r.royaltyBase).toBe(5367600);
    expect(r.royalty).toBe(Math.round(5367600 * 0.15)); // 805140
    expect(r.billTotal).toBe(805140 + 144402 + 10000);   // 959542
    expect(r.refundAmount).toBe(5367600 - r.billTotal);
    expect(r.feeRate).toBeCloseTo(2.69, 1);
  });
  it('feeRate is null when squareSales is 0', () => {
    expect(computeSettlement({ squareSales: 0, squareFees: 100 }).feeRate).toBeNull();
  });
  it('coerces non-numeric input to 0', () => {
    const r = computeSettlement({ cash: 'x', squareSales: undefined, hpb: null });
    expect(r.royaltyBase).toBe(0);
    expect(r.billTotal).toBe(0);
  });
});

describe('schedule & notes are defined (single source)', () => {
  it('has the 4 期日 and 2 注意書き', () => {
    expect(SETTLEMENT_SCHEDULE.map(s => s.label)).toEqual(['売上確定', '返金明細書作成', 'オーナーチェック', '振り込み']);
    expect(SETTLEMENT_NOTES.length).toBe(2);
    expect(SETTLEMENT_NOTES[1]).toContain('修正対応はできません');
  });
});
