import { describe, it, expect } from 'vitest';
import { parseAt, idOf, dedupeCustomers, nextCursor, sortCustomers, buildRows, rowKey } from '../lib/acq-list.js';

const c = (id, received, reserved) => ({ customer_id: id, received_at: received, reserved_at: reserved });

describe('🔴 受付日時を時間軸どおりに読む', () => {
  it('時間帯つきのISOをそのまま読む', () => {
    expect(new Date(parseAt('2026-09-10T17:45:00+09:00')).toISOString()).toBe('2026-09-10T08:45:00.000Z');
  });
  it('🔴 時間帯が無いものは日本時間として読む（UTCで読むと9時間ずれる）', () => {
    expect(parseAt('2026-09-10 17:45:00')).toBe(parseAt('2026-09-10T17:45:00+09:00'));
    expect(parseAt('2026-09-10T17:45')).toBe(parseAt('2026-09-10T17:45:00+09:00'));
  });
  it('日付だけでも読む（その日の0時・日本時間）', () => {
    expect(new Date(parseAt('2026-09-10')).toISOString()).toBe('2026-09-09T15:00:00.000Z');
  });
  it('🔴 読めないものは null（0にしない＝1970年として先頭に来ない）', () => {
    for (const v of ['', null, undefined, '未定', 'あとで']) expect(parseAt(v), String(v)).toBe(null);
  });
  it('日付をまたぐ比較が正しい', () => {
    expect(parseAt('2026-09-08 21:34:00') < parseAt('2026-09-10 04:28:00')).toBe(true);
    expect(parseAt('2026-09-10 04:28:00') < parseAt('2026-09-10 17:45:00')).toBe(true);
  });
});

describe('🔴 同じ人を何度も入れない', () => {
  it('同じIDは1件になる', () => {
    const rows = [c(1, '2026-09-10 17:45:00'), c(2, '2026-09-08 21:34:00'), c(1, '2026-09-10 17:45:00')];
    expect(dedupeCustomers(rows)).toHaveLength(2);
  });
  it('🔴 後から来たものを採用する（施策リンクがあとから付くため）', () => {
    const got = dedupeCustomers([{ customer_id: 1, link: '' }, { customer_id: 1, link: 'META新規限定' }]);
    expect(got[0].link).toBe('META新規限定');
  });
  it('customer_code しか無くても見分けられる', () => {
    expect(idOf({ customer_code: 'abc' })).toBe('abc');
    expect(dedupeCustomers([{ customer_code: 'a' }, { customer_code: 'a' }])).toHaveLength(1);
  });
  it('🔴 IDが無い行を捨てない（取りこぼしを作らない）', () => {
    const got = dedupeCustomers([{ customer_id: 1 }, { name: 'ID無し' }, { name: 'ID無し2' }]);
    expect(got).toHaveLength(3);
  });
  it('壊れた入力でも落ちない', () => {
    expect(dedupeCustomers(null)).toEqual([]);
    expect(dedupeCustomers([null, 'x', 1])).toEqual([]);
  });
});

describe('🔴 ページングが進まないときに止める', () => {
  it('次のカーソルが前と同じなら終わり（同じページを読み続けない）', () => {
    expect(nextCursor('abc', { has_more: true, next_cursor: 'abc' })).toBe('');
  });
  it('進んでいれば続ける', () => {
    expect(nextCursor('abc', { has_more: true, next_cursor: 'def' })).toBe('def');
  });
  it('has_more が無ければ終わり', () => {
    expect(nextCursor('abc', { next_cursor: 'def' })).toBe('');
    expect(nextCursor('abc', {})).toBe('');
    expect(nextCursor('abc', null)).toBe('');
  });
  it('次のカーソルが空なら終わり', () => {
    expect(nextCursor('abc', { has_more: true, next_cursor: '' })).toBe('');
  });
});

describe('🔴 並べ替えが時間軸どおりになる（今回の不具合の核心）', () => {
  // 画面で起きていた並び: 9/10 → 9/10 → 9/8 → 9/8 → 9/10 …（重複＋順不同）
  const MESSY = [
    c(1, '2026-09-10 17:45:00'), c(2, '2026-09-10 04:28:00'), c(3, '2026-09-08 21:34:00'),
    c(3, '2026-09-08 21:34:00'), c(1, '2026-09-10 17:45:00'), c(2, '2026-09-10 04:28:00'),
  ];
  it('古い順にすると、古いものから並ぶ', () => {
    expect(buildRows(MESSY, { dir: 'asc' }).map(x => x.received_at))
      .toEqual(['2026-09-08 21:34:00', '2026-09-10 04:28:00', '2026-09-10 17:45:00']);
  });
  it('新しい順にすると、新しいものから並ぶ', () => {
    expect(buildRows(MESSY, { dir: 'desc' }).map(x => x.received_at))
      .toEqual(['2026-09-10 17:45:00', '2026-09-10 04:28:00', '2026-09-08 21:34:00']);
  });
  it('🔴 同じ日の中でも時刻どおりに並ぶ', () => {
    const same = [c(1, '2026-09-10 17:45:00'), c(2, '2026-09-10 04:28:00'), c(3, '2026-09-10 09:00:00')];
    expect(sortCustomers(same, 'received', 'asc').map(x => x.customer_id)).toEqual([2, 3, 1]);
  });
  it('🔴 読めない日時は常に末尾（先頭にも中間にも来ない）', () => {
    const rows = [c(1, '2026-09-10 17:45:00'), c(2, '未定'), c(3, '2026-09-08 21:34:00')];
    expect(sortCustomers(rows, 'received', 'asc').map(x => x.customer_id)).toEqual([3, 1, 2]);
    expect(sortCustomers(rows, 'received', 'desc').map(x => x.customer_id)).toEqual([1, 3, 2]);
  });
  it('初回来店予定でも並べ替えられる（未設定は末尾）', () => {
    const rows = [c(1, '2026-09-10 17:45:00', '2026-10-12 14:00:00'), c(2, '2026-09-08 21:34:00', '2026-09-11 18:00:00'), c(3, '2026-09-10 04:28:00', '')];
    expect(sortCustomers(rows, 'reserved', 'asc').map(x => x.customer_id)).toEqual([2, 1, 3]);
  });
  it('施策リンク名でも並べ替えられる（リンクなしは末尾）', () => {
    const rows = [c(1, '2026-09-10 17:45:00'), c(2, '2026-09-08 21:34:00'), c(3, '2026-09-09 10:00:00')];
    const link = (x) => ({ 1: 'B案', 2: 'A案', 3: '' })[x.customer_id];
    expect(sortCustomers(rows, 'link', 'asc', link).map(x => x.customer_id)).toEqual([2, 1, 3]);
    expect(sortCustomers(rows, 'link', 'desc', link).map(x => x.customer_id)).toEqual([1, 2, 3]);
  });
  it('同じ時刻は順番が入れ替わらない（描き直しても安定）', () => {
    const rows = [c('b', '2026-09-10 10:00:00'), c('a', '2026-09-10 10:00:00')];
    expect(sortCustomers(rows, 'received', 'asc').map(x => x.customer_id)).toEqual(['a', 'b']);
    expect(sortCustomers(rows, 'received', 'desc').map(x => x.customer_id)).toEqual(['a', 'b']);
  });
  it('元の配列を書き換えない', () => {
    const rows = [c(1, '2026-09-10 17:45:00'), c(2, '2026-09-08 21:34:00')];
    sortCustomers(rows, 'received', 'asc');
    expect(rows.map(x => x.customer_id)).toEqual([1, 2]);
  });
});

describe('🔴 行のキーが重ならない（重なると表示が入れ替わる）', () => {
  it('IDがあればID、無ければ位置を使う', () => {
    expect(rowKey({ customer_id: 7 }, 3)).toBe('7');
    expect(rowKey({}, 3)).toBe('row_3');
  });
  it('重複を畳んだあとは、キーが全部ちがう', () => {
    const rows = buildRows([c(1, '2026-09-10 17:45:00'), c(1, '2026-09-10 17:45:00'), c(2, '2026-09-08 21:34:00')]);
    const keys = rows.map(rowKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
