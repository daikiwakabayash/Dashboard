import { describe, it, expect } from 'vitest';
import { normalizeReads, mergeReads, bumpRead, versionOf, isStale, upsertPost, upsertComment, BOARD_READS_KEY } from '../lib/board-store.js';

const T = 1_760_000_000_000;

describe('board-store - 既読の正規化', () => {
  it('壊れた値を通さない', () => {
    expect(normalizeReads({ a: 100, b: 'x', c: null, d: -5, e: 0 })).toEqual({ a: 100 });
    for (const bad of [null, undefined, [], 'x', 42]) expect(normalizeReads(bad)).toEqual({});
  });
  it('異常な件数で膨張しない', () => {
    const huge = {}; for (let i = 0; i < 6000; i++) huge['u' + i] = T;
    expect(Object.keys(normalizeReads(huge)).length).toBe(5000);
  });
});

describe('board-store - 新旧のマージ（移行期間）', () => {
  it('旧blobの既読と新キーの既読を両方読める', () => {
    expect(mergeReads({ a: 100, b: 200 }, { b: 300, c: 400 })).toEqual({ a: 100, b: 300, c: 400 });
  });
  it('新しい方（大きい方）を採用し、古い値で巻き戻さない', () => {
    expect(mergeReads({ a: 999 }, { a: 100 })).toEqual({ a: 999 });
  });
  it('片方が空でも動く', () => {
    expect(mergeReads({}, { a: 1 })).toEqual({ a: 1 });
    expect(mergeReads({ a: 1 }, {})).toEqual({ a: 1 });
    expect(mergeReads(null, null)).toEqual({});
  });
});

describe('board-store - 既読は巻き戻らない', () => {
  it('新しいタイムスタンプで進む', () => {
    expect(bumpRead({ a: 100 }, 'a', 200)).toEqual({ a: 200 });
  });
  it('古いタイムスタンプが遅れて届いても未読に戻さない', () => {
    expect(bumpRead({ a: 200 }, 'a', 100)).toEqual({ a: 200 });
  });
  it('staffId が無ければ何もしない', () => {
    expect(bumpRead({ a: 1 }, '', 500)).toEqual({ a: 1 });
  });
  it('他人の既読に触らない', () => {
    expect(bumpRead({ a: 1, b: 2 }, 'a', 9)).toEqual({ a: 9, b: 2 });
  });
});

describe('board-store - 版（古いデータによる上書きの検出）', () => {
  it('版が無ければ 0', () => {
    expect(versionOf(null)).toBe(0);
    expect(versionOf({})).toBe(0);
    expect(versionOf({ _v: 7 })).toBe(7);
  });
  it('期待版が未指定なら検査しない（古いクライアントは従来どおり動く）', () => {
    for (const v of [undefined, null, '']) expect(isStale(v, 5)).toBe(false);
  });
  it('期待版が一致すれば通し、違えば弾く', () => {
    expect(isStale(5, 5)).toBe(false);
    expect(isStale(4, 5)).toBe(true);   // 他の人が先に更新した
  });
  it('数値でない期待版は無視する（壊れた入力で書き込みを止めない）', () => {
    expect(isStale('abc', 5)).toBe(false);
  });
});

describe('board-store - 投稿の冪等性（二重送信・再送）', () => {
  const post = (id, clientId) => ({ id, clientId, text: 'x' });
  it('新しい投稿は先頭に入る', () => {
    const r = upsertPost([post('p1')], post('p2'), 10);
    expect(r.added).toBe(true);
    expect(r.posts.map(p => p.id)).toEqual(['p2', 'p1']);
  });
  it('同じ clientId の再送は追加しない', () => {
    const first = upsertPost([], post('p1', 'c1'), 10);
    const retry = upsertPost(first.posts, post('p2', 'c1'), 10);   // 再送でサーバー採番idが変わっても
    expect(retry.added).toBe(false);
    expect(retry.posts).toHaveLength(1);
    expect(retry.existing.id).toBe('p1');
  });
  it('同じ id の再送も追加しない', () => {
    const r = upsertPost([post('p1')], post('p1'), 10);
    expect(r.added).toBe(false);
    expect(r.posts).toHaveLength(1);
  });
  it('上限を超えたら古いものから落ちる', () => {
    const many = Array.from({ length: 5 }, (_, i) => post('p' + i));
    const r = upsertPost(many, post('new'), 3);
    expect(r.posts).toHaveLength(3);
    expect(r.posts[0].id).toBe('new');
  });
  it('壊れた配列でも落ちない', () => {
    expect(upsertPost(null, post('p1'), 10).posts).toHaveLength(1);
    expect(upsertPost([null, undefined, post('p1')], post('p2'), 10).posts).toHaveLength(2);
  });
});

describe('board-store - コメントの冪等性', () => {
  const base = [{ id: 'p1', comments: [] }, { id: 'p2', comments: [] }];
  it('対象の投稿にだけ入る', () => {
    const r = upsertComment(base, 'p1', { id: 'c1', clientId: 'x1', text: 'a' }, 100);
    expect(r.added).toBe(true);
    expect(r.posts[0].comments).toHaveLength(1);
    expect(r.posts[1].comments).toHaveLength(0);
  });
  it('同じ clientId の再送は追加しない', () => {
    const one = upsertComment(base, 'p1', { id: 'c1', clientId: 'x1' }, 100);
    const two = upsertComment(one.posts, 'p1', { id: 'c2', clientId: 'x1' }, 100);
    expect(two.added).toBe(false);
    expect(two.posts[0].comments).toHaveLength(1);
  });
  it('存在しない投稿には追加しない', () => {
    const r = upsertComment(base, 'nope', { id: 'c1' }, 100);
    expect(r.added).toBe(false);
    expect(r.target).toBeNull();
  });
});

describe('board-store - 定数', () => {
  it('既読の保存先が投稿と別キーになっている', () => {
    expect(BOARD_READS_KEY).toBe('naoru:board:reads:v1');
    expect(BOARD_READS_KEY).not.toBe('naoru:board:v1');
  });
});
