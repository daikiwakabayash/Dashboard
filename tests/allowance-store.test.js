import { describe, it, expect } from 'vitest';
import {
  makeEntry, foldLog, mergeSubmissions, isDuplicateSubmit,
  normalizeProductivity, mergeProductivity, bumpProductivity,
  ALLOWANCE_LOG_KEY, ALLOWANCE_PROD_KEY,
} from '../lib/allowance-store.js';

const T = 1_760_000_000_000;
const sub = (id, amount = 1000, over = {}) => ({ id, staffId: 's1', staffName: 'サンプル太郎', month: '2026-08', category: '健康手当', amount, ...over });

describe('allowance-store - ログ1件の生成', () => {
  it('提出は submission を保持する', () => {
    const e = makeEntry('submit', sub('a1'), T);
    expect(e).toMatchObject({ op: 'submit', id: 'a1', at: T });
    expect(e.submission.amount).toBe(1000);
  });
  it('取消は id だけでよい', () => {
    expect(makeEntry('delete', { id: 'a1' }, T)).toEqual({ op: 'delete', id: 'a1', at: T });
    expect(makeEntry('delete', 'a1', T)).toEqual({ op: 'delete', id: 'a1', at: T });
  });
  it('id が無ければ作らない（壊れた行をログに積まない）', () => {
    expect(makeEntry('submit', { amount: 100 }, T)).toBeNull();
    expect(makeEntry('delete', {}, T)).toBeNull();
    expect(makeEntry('delete', { notId: 'x' }, T)).toBeNull();   // "[object Object]" を id にしない
    expect(makeEntry('delete', null, T)).toBeNull();
  });
});

describe('allowance-store - ログを畳む', () => {
  it('同じ id は後の方が勝つ（修正提出）', () => {
    const log = [makeEntry('submit', sub('a1', 1000), T), makeEntry('submit', sub('a1', 2000), T + 1)];
    expect(foldLog(log).byId.get('a1').amount).toBe(2000);
  });
  it('取消は消える', () => {
    const log = [makeEntry('submit', sub('a1'), T), makeEntry('delete', { id: 'a1' }, T + 1)];
    const { byId, deleted } = foldLog(log);
    expect(byId.has('a1')).toBe(false);
    expect(deleted.has('a1')).toBe(true);
  });
  it('取消のあとに再提出できる', () => {
    const log = [makeEntry('submit', sub('a1'), T), makeEntry('delete', { id: 'a1' }, T + 1), makeEntry('submit', sub('a1', 3000), T + 2)];
    const { byId, deleted } = foldLog(log);
    expect(byId.get('a1').amount).toBe(3000);
    expect(deleted.has('a1')).toBe(false);
  });
  it('壊れた行を無視する', () => {
    expect(foldLog([null, {}, { op: 'submit' }, makeEntry('submit', sub('a1'), T)]).byId.size).toBe(1);
    expect(foldLog(null).byId.size).toBe(0);
  });
});

describe('allowance-store - 旧データとの合成（移行）', () => {
  it('旧blobだけでも読める', () => {
    expect(mergeSubmissions([sub('old1')], []).map(s => s.id)).toEqual(['old1']);
  });
  it('ログだけでも読める', () => {
    expect(mergeSubmissions([], [makeEntry('submit', sub('new1'), T)]).map(s => s.id)).toEqual(['new1']);
  });
  it('両方あれば両方出る', () => {
    const r = mergeSubmissions([sub('old1')], [makeEntry('submit', sub('new1'), T)]);
    expect(r.map(s => s.id).sort()).toEqual(['new1', 'old1']);
  });
  it('同じ id はログが勝つ（新しいため）', () => {
    const r = mergeSubmissions([sub('a1', 1000)], [makeEntry('submit', sub('a1', 9999), T)]);
    expect(r).toHaveLength(1);
    expect(r[0].amount).toBe(9999);
  });
  it('ログの取消は旧blobの提出も取り消す', () => {
    const r = mergeSubmissions([sub('a1')], [makeEntry('delete', { id: 'a1' }, T)]);
    expect(r).toHaveLength(0);
  });
  it('旧blobの順序を保つ（画面の並びが変わらない）', () => {
    const r = mergeSubmissions([sub('a'), sub('b'), sub('c')], []);
    expect(r.map(s => s.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('allowance-store - 二重送信', () => {
  const log = [makeEntry('submit', sub('a1', 1000), T)];
  it('同じ内容の再送は重複として検出する', () => {
    expect(isDuplicateSubmit(log, sub('a1', 1000))).toBe(true);
  });
  it('金額が変わっていれば別物（修正提出は通す）', () => {
    expect(isDuplicateSubmit(log, sub('a1', 2000))).toBe(false);
  });
  it('キーの並び順が違っても同じ内容なら重複と判定する', () => {
    const reordered = { amount: 1000, category: '健康手当', month: '2026-08', staffName: 'サンプル太郎', staffId: 's1', id: 'a1' };
    expect(isDuplicateSubmit(log, reordered)).toBe(true);
  });
  it('未知の id は重複ではない', () => {
    expect(isDuplicateSubmit(log, sub('zzz'))).toBe(false);
  });
});

describe('allowance-store - 生産性（別キー）', () => {
  it('壊れた値を通さない', () => {
    expect(normalizeProductivity({ s1: { '2026-08': 1000, 'bad': 5, '2026-13x': 1 } })).toEqual({ s1: { '2026-08': 1000 } });
    expect(normalizeProductivity({ s1: 'x' })).toEqual({});
    for (const bad of [null, [], 'x']) expect(normalizeProductivity(bad)).toEqual({});
  });
  it('1人・1ヶ月だけ更新し、他に触れない', () => {
    const before = { s1: { '2026-07': 100, '2026-08': 200 }, s2: { '2026-08': 300 } };
    const after = bumpProductivity(before, 's1', '2026-08', 999);
    expect(after).toEqual({ s1: { '2026-07': 100, '2026-08': 999 }, s2: { '2026-08': 300 } });
  });
  it('不正な月は無視する', () => {
    expect(bumpProductivity({}, 's1', '2026-8', 100)).toEqual({});
    expect(bumpProductivity({}, '', '2026-08', 100)).toEqual({});
  });
  it('新旧をマージし、新キーが勝つ', () => {
    expect(mergeProductivity({ s1: { '2026-07': 1, '2026-08': 2 } }, { s1: { '2026-08': 99 }, s2: { '2026-08': 5 } }))
      .toEqual({ s1: { '2026-07': 1, '2026-08': 99 }, s2: { '2026-08': 5 } });
  });
});

describe('allowance-store - 保存先が分かれている', () => {
  it('提出ログ・生産性・旧blobが別キーになっている', () => {
    expect(ALLOWANCE_LOG_KEY).toBe('naoru:allowance:log:v1');
    expect(ALLOWANCE_PROD_KEY).toBe('naoru:allowance:prod:v1');
    expect(ALLOWANCE_LOG_KEY).not.toBe('naoru:allowance:v1');
    expect(ALLOWANCE_PROD_KEY).not.toBe('naoru:allowance:v1');
  });
});
