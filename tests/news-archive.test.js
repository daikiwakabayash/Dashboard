import { describe, it, expect } from 'vitest';
import {
  DRAFT, PUBLISHED, PAGE, normalizeStatus, isDraft, canSeeDraft, visibleFor, draftsFor,
  publishedOnly, parseAt, monthKeyOf, monthLabel, groupByMonth, monthOptions, pageOf,
} from '../lib/news-archive.js';

const post = (o) => ({ id: 'p1', authorId: '10', createdAt: '2026-09-18T01:00:00.000Z', ...o });

describe('公開状態', () => {
  it('未設定（古い投稿）は公開済みとして扱う', () => {
    expect(normalizeStatus(undefined)).toBe(PUBLISHED);
    expect(normalizeStatus('')).toBe(PUBLISHED);
    expect(isDraft(post({}))).toBe(false);
  });
  it('draft だけを下書きとみなす（他の値は公開済み）', () => {
    expect(normalizeStatus('draft')).toBe(DRAFT);
    expect(normalizeStatus('hidden')).toBe(PUBLISHED);
    expect(isDraft(post({ status: 'draft' }))).toBe(true);
  });
});

describe('下書きを見てよい人', () => {
  const d = post({ status: 'draft', authorId: '10' });
  it('本人は見える', () => expect(canSeeDraft(d, { ids: ['10'] })).toBe(true));
  it('同一人物の別IDでも見える', () => expect(canSeeDraft(d, { ids: ['u99', '10'] })).toBe(true));
  it('他人は見えない', () => expect(canSeeDraft(d, { ids: ['11'] })).toBe(false));
  it('本部は見える', () => expect(canSeeDraft(d, { ids: [], hq: true })).toBe(true));
  it('投稿者が空なら本人扱いしない', () => {
    expect(canSeeDraft(post({ status: 'draft', authorId: '' }), { ids: [''] })).toBe(false);
  });
  it('名乗りだけの viewer（不正な形）でも落ちない', () => {
    expect(canSeeDraft(d, null)).toBe(false);
    expect(canSeeDraft(d, { ids: 'not-an-array' })).toBe(false);
  });
});

describe('一覧に出す記事', () => {
  const rows = [
    post({ id: 'a' }),
    post({ id: 'b', status: 'draft', authorId: '10' }),
    post({ id: 'c', status: 'draft', authorId: '77' }),
  ];
  it('他人の下書きは落とす', () => {
    expect(visibleFor(rows, { ids: ['10'] }).map(p => p.id)).toEqual(['a', 'b']);
  });
  it('本部は全部見える', () => {
    expect(visibleFor(rows, { ids: [], hq: true }).map(p => p.id)).toEqual(['a', 'b', 'c']);
  });
  it('公開済みだけを取り出せる', () => {
    expect(publishedOnly(rows).map(p => p.id)).toEqual(['a']);
  });
  it('下書きだけを新しい順で取り出せる', () => {
    const list = draftsFor([
      post({ id: 'old', status: 'draft', createdAt: '2026-09-01T00:00:00.000Z' }),
      post({ id: 'new', status: 'draft', createdAt: '2026-09-10T00:00:00.000Z' }),
    ], { ids: ['10'] });
    expect(list.map(p => p.id)).toEqual(['new', 'old']);
  });
  it('直した時刻があればそちらを新しさに使う', () => {
    const list = draftsFor([
      post({ id: 'a', status: 'draft', createdAt: '2026-09-10T00:00:00.000Z' }),
      post({ id: 'b', status: 'draft', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z' }),
    ], { ids: ['10'] });
    expect(list.map(p => p.id)).toEqual(['b', 'a']);
  });
});

describe('年月（日本時間）', () => {
  it('日本の夜に書いた記事は当月のまま', () => {
    // 2026-09-30 23:30 JST = 2026-09-30T14:30Z → 9月であって10月ではない
    expect(monthKeyOf('2026-09-30T14:30:00.000Z')).toBe('2026-09');
  });
  it('月初の未明も取り違えない', () => {
    // 2026-10-01 00:30 JST = 2026-09-30T15:30Z → 10月
    expect(monthKeyOf('2026-09-30T15:30:00.000Z')).toBe('2026-10');
  });
  it('タイムゾーンの無い文字列は日本時間とみなす', () => {
    expect(monthKeyOf('2026-10-01 00:30')).toBe('2026-10');
  });
  it('読めない日付は空（1970年に寄せない）', () => {
    expect(monthKeyOf('あした')).toBe('');
    expect(monthKeyOf('')).toBe('');
    expect(parseAt('あした')).toBe(null);
  });
  it('見出しの文字', () => {
    expect(monthLabel('2026-09')).toBe('2026年9月');
    expect(monthLabel('')).toBe('日付なし');
  });
});

describe('年月ごとのまとまり', () => {
  const rows = [
    post({ id: 'a', createdAt: '2026-09-18T01:00:00.000Z' }),
    post({ id: 'b', createdAt: '2026-09-02T01:00:00.000Z' }),
    post({ id: 'c', createdAt: '2026-08-30T01:00:00.000Z' }),
    post({ id: 'x', createdAt: 'こわれた' }),
  ];
  it('並び順を変えずにまとめる', () => {
    const g = groupByMonth(rows);
    expect(g.map(x => x.key)).toEqual(['2026-09', '2026-08', '']);
    expect(g[0].posts.map(p => p.id)).toEqual(['a', 'b']);
    expect(g[0].label).toBe('2026年9月');
  });
  it('日付が読めない記事も捨てない', () => {
    const g = groupByMonth(rows);
    expect(g[2].label).toBe('日付なし');
    expect(g[2].posts.map(p => p.id)).toEqual(['x']);
  });
  it('年月の選択肢は新しい順・「日付なし」は最後', () => {
    expect(monthOptions(rows)).toEqual([
      { key: '2026-09', label: '2026年9月', count: 2 },
      { key: '2026-08', label: '2026年8月', count: 1 },
      { key: '', label: '日付なし', count: 1 },
    ]);
  });
});

describe('追加読込', () => {
  const rows = Array.from({ length: 30 }, (_, i) => post({ id: `p${i}` }));
  it('最初は PAGE 件', () => {
    const r = pageOf(rows, PAGE);
    expect(r.items.length).toBe(PAGE);
    expect(r.hasMore).toBe(true);
    expect(r.remaining).toBe(30 - PAGE);
    expect(r.next).toBe(PAGE * 2);
  });
  it('全部出たら「もっと読む」は出ない', () => {
    const r = pageOf(rows, 999);
    expect(r.items.length).toBe(30);
    expect(r.hasMore).toBe(false);
    expect(r.remaining).toBe(0);
  });
  it('件数が PAGE 未満でも落ちない', () => {
    const r = pageOf(rows.slice(0, 3), PAGE);
    expect(r.items.length).toBe(3);
    expect(r.hasMore).toBe(false);
  });
  it('0件でも落ちない', () => {
    const r = pageOf([], PAGE);
    expect(r.items).toEqual([]);
    expect(r.hasMore).toBe(false);
  });
});
