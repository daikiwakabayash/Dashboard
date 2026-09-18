import { describe, it, expect } from 'vitest';
import { CATEGORIES, CATEGORY_KEYS, categoryLabel, normalizeAudience, normalizeDue, normalizeMeta,
         canPublish, isForMe, audienceFor, dueState, coverOf, filterPosts, groupByMonth, coverStyle, COVER_TONES,
} from '../lib/news-post.js';

const NOW = new Date('2026-09-18T10:00:00+09:00');

describe('カテゴリー', () => {
  it('一覧と表示名が引ける', () => {
    expect(CATEGORY_KEYS).toContain('event');
    expect(categoryLabel('event')).toBe('イベント');
  });
  it('未設定（古い投稿）は空', () => {
    expect(categoryLabel('')).toBe('');
    expect(categoryLabel('zzz')).toBe('');
  });
  it('色が決まっている（画面で色分けするため）', () => {
    expect(CATEGORIES.every(c => c.key && c.label && c.color)).toBe(true);
  });
});

describe('公開対象', () => {
  it('既定は全員', () => {
    expect(normalizeAudience(null)).toEqual({ kind: 'all', shops: [] });
    expect(normalizeAudience({ kind: 'zzz' })).toEqual({ kind: 'all', shops: [] });
  });
  it('店舗を指定できる（重複は落とす）', () => {
    expect(normalizeAudience({ kind: 'shops', shops: ['A', 'A', 'B'] })).toEqual({ kind: 'shops', shops: ['A', 'B'] });
  });
  it('⚠️ 店舗指定なのに空でも、勝手に「全員」にしない', () => {
    expect(normalizeAudience({ kind: 'shops', shops: [] })).toEqual({ kind: 'shops', shops: [] });
    expect(canPublish({ text: 'x', audience: { kind: 'shops', shops: [] } })).toEqual({ ok: false, reason: 'no_shops' });
  });
});

describe('記事の新しい項目', () => {
  it('必要な項目だけを取り出す', () => {
    const got = normalizeMeta({ category: 'event', needsAck: true, dueDate: '2026-10-01', featured: true,
      imgIds: ['i1', 'i2'], coverImgId: 'i2', audience: { kind: 'shops', shops: ['鶴見'] } });
    expect(got).toEqual({ category: 'event', needsAck: true, dueDate: '2026-10-01', featured: true,
      coverImgId: 'i2', audience: { kind: 'shops', shops: ['鶴見'] } });
  });
  it('知らないカテゴリーは未設定にする', () => {
    expect(normalizeMeta({ category: 'zzz' }).category).toBe('');
  });
  it('期限の形式が違えば空', () => {
    expect(normalizeDue('2026/10/01')).toBe('');
    expect(normalizeDue('2026-10-01')).toBe('2026-10-01');
    expect(normalizeMeta({ dueDate: 'あした' }).dueDate).toBe('');
  });
  it('⚠️ 添付に無い画像を表紙にしない', () => {
    expect(normalizeMeta({ imgIds: ['i1'], coverImgId: 'zzz' }).coverImgId).toBe('');
  });
  it('項目が無い古い投稿でも落ちない', () => {
    expect(normalizeMeta(null)).toEqual({ category: '', audience: { kind: 'all', shops: [] },
      needsAck: false, dueDate: '', featured: false, coverImgId: '' });
  });
});

describe('投稿してよいか', () => {
  it('中身が何も無ければ出せない', () => {
    expect(canPublish({})).toEqual({ ok: false, reason: 'empty' });
    expect(canPublish({ text: '  ' })).toEqual({ ok: false, reason: 'empty' });
  });
  it('本文が無くても写真だけなら出せる', () => {
    expect(canPublish({ imgIds: ['i1'] })).toEqual({ ok: true });
  });
  it('⚠️ 確認を求めるのに期限が無ければ出せない', () => {
    expect(canPublish({ text: 'x', needsAck: true })).toEqual({ ok: false, reason: 'no_due' });
    expect(canPublish({ text: 'x', needsAck: true, dueDate: '2026-10-01' })).toEqual({ ok: true });
  });
});

describe('誰に向けた記事か', () => {
  const me = { shop: 'NAORU 鶴見院', shops: ['NAORU 鶴見院'] };
  it('全員向けは誰にでも出る', () => {
    expect(isForMe({ audience: { kind: 'all' } }, me)).toBe(true);
    expect(isForMe({}, me)).toBe(true);                       // 項目が無い古い投稿
  });
  it('店舗指定は所属が合う人にだけ出る', () => {
    expect(isForMe({ audience: { kind: 'shops', shops: ['鶴見'] } }, me)).toBe(true);
    expect(isForMe({ audience: { kind: 'shops', shops: ['仙台'] } }, me)).toBe(false);
  });
  it('所属が分からない人には店舗指定の記事を出さない', () => {
    expect(isForMe({ audience: { kind: 'shops', shops: ['鶴見'] } }, {})).toBe(false);
  });
  it('状況一覧の分母も公開対象に合わせる', () => {
    const people = [
      { id: 'a', name: '青木', shop: 'NAORU 鶴見院' },
      { id: 'b', name: '石田', shop: 'NAORU 仙台院' },
    ];
    expect(audienceFor({ audience: { kind: 'shops', shops: ['鶴見'] } }, people).map(p => p.id)).toEqual(['a']);
    expect(audienceFor({ audience: { kind: 'all' } }, people)).toHaveLength(2);
    expect(audienceFor({}, people)).toHaveLength(2);
  });
});

describe('期限', () => {
  it('期限なしは none', () => {
    expect(dueState({}, NOW)).toBe('none');
  });
  it('先の期限は ok、3日以内は soon', () => {
    expect(dueState({ dueDate: '2026-10-01' }, NOW)).toBe('ok');
    expect(dueState({ dueDate: '2026-09-20' }, NOW)).toBe('soon');
  });
  it('当日はまだ over にしない（その日の終わりまで）', () => {
    expect(dueState({ dueDate: '2026-09-18' }, NOW)).toBe('soon');
  });
  it('過ぎたら over（記事は消さない）', () => {
    expect(dueState({ dueDate: '2026-09-17' }, NOW)).toBe('over');
  });
});

describe('表紙の写真', () => {
  it('指定があればそれ', () => {
    expect(coverOf({ imgIds: ['i1', 'i2'], coverImgId: 'i2' })).toBe('i2');
  });
  it('未指定なら1枚目', () => {
    expect(coverOf({ imgIds: ['i1', 'i2'] })).toBe('i1');
  });
  it('画像が無ければ空（代替表紙は画面側）', () => {
    expect(coverOf({ imgIds: [] })).toBe('');
    expect(coverOf(null)).toBe('');
  });
  it('添付から消えた表紙は使わない', () => {
    expect(coverOf({ imgIds: ['i1'], coverImgId: 'deleted' })).toBe('i1');
  });
});

describe('一覧の絞り込み', () => {
  const POSTS = [
    { id: '1', title: '沖縄セミナー', text: '開催します', category: 'event', featured: true, authorName: '本部', createdAt: '2026-09-18T01:00:00Z' },
    { id: '2', title: '手順の変更', text: '返金の手順', category: 'rule', authorName: '本部', createdAt: '2026-08-10T01:00:00Z' },
    { id: '3', title: '古い投稿', text: '項目なし', authorName: '管理者', createdAt: '2026-08-01T01:00:00Z' },
  ];
  it('カテゴリーで絞れる', () => {
    expect(filterPosts(POSTS, { category: 'event' }).map(p => p.id)).toEqual(['1']);
  });
  it('ピックアップだけ出せる', () => {
    expect(filterPosts(POSTS, { featuredOnly: true }).map(p => p.id)).toEqual(['1']);
  });
  it('キーワードはタイトル・本文・投稿者・カテゴリー名に当たる', () => {
    expect(filterPosts(POSTS, { q: '返金' }).map(p => p.id)).toEqual(['2']);
    expect(filterPosts(POSTS, { q: 'イベント' }).map(p => p.id)).toEqual(['1']);
    expect(filterPosts(POSTS, { q: '管理者' }).map(p => p.id)).toEqual(['3']);
  });
  it('未読だけ出せる', () => {
    expect(filterPosts(POSTS, { unreadOnly: true }, p => p.id === '2').map(p => p.id)).toEqual(['2']);
  });
  it('条件なしなら全部（古い投稿も消えない）', () => {
    expect(filterPosts(POSTS, {})).toHaveLength(3);
    expect(filterPosts(POSTS, null)).toHaveLength(3);
  });
});

describe('過去記事の年月', () => {
  it('年月ごとにまとめて新しい順', () => {
    const got = groupByMonth([
      { id: '1', createdAt: '2026-09-18T01:00:00Z' },
      { id: '2', createdAt: '2026-08-10T01:00:00Z' },
      { id: '3', createdAt: '2026-08-01T01:00:00Z' },
    ]);
    expect(got.map(g => g.month)).toEqual(['2026-09', '2026-08']);
    expect(got[1].count).toBe(2);
    expect(got[0].label).toBe('2026年9月');
  });
  it('日時が壊れている投稿は落とす（存在しない月を作らない）', () => {
    expect(groupByMonth([{ id: '1', createdAt: 'zzz' }, null])).toEqual([]);
  });
  it('日本時間で判定する（月初・月末がずれない）', () => {
    // 2026-09-01T00:30 JST = 2026-08-31T15:30Z → 9月として扱う
    expect(groupByMonth([{ id: '1', createdAt: '2026-08-31T15:30:00Z' }])[0].month).toBe('2026-09');
  });
});

describe('一覧カードの表紙', () => {
  it('添付写真があればそれを使う（文字の表紙を作らない）', () => {
    const c = coverStyle({ imgIds: ['i1'], category: 'event' });
    expect(c.imgId).toBe('i1');
    expect(c.line1).toBe('');
  });
  it('写真が無ければカテゴリーごとの文字の表紙になる', () => {
    expect(coverStyle({ category: 'event' })).toMatchObject({ imgId: '', line1: 'LEARN', line2: 'TOGETHER.', tone: 'red' });
    expect(coverStyle({ category: 'study' })).toMatchObject({ kicker: 'NOWL / STORIES', tone: 'dark' });
  });
  it('ピックアップ（大きい1件）は肩書きと短い言葉を持ち、濃い色になる', () => {
    const h = coverStyle({ category: 'study' }, { hero: true });
    expect(h.journal).toBe('NOWL / KNOWLEDGE JOURNAL');
    expect(h.caption).toBe('学びは、つながるほど強くなる。');
    expect(coverStyle({ category: 'notice' }, { hero: true }).tone).toBe('dark');
  });
  it('🔴 短い言葉はカテゴリーごとに固定（記事の中身を要約しない）', () => {
    const a = coverStyle({ category: 'case', title: '症例A', text: '長い本文' }, { hero: true });
    const b = coverStyle({ category: 'case', title: '症例B', text: 'まったく違う本文' }, { hero: true });
    expect(a.caption).toBe(b.caption);
    expect(a.caption).not.toContain('症例A');
  });
  it('写真がある記事では文字の表紙を作らない（ピックアップでも）', () => {
    expect(coverStyle({ imgIds: ['i1'], category: 'study' }, { hero: true })).toMatchObject({ imgId: 'i1', caption: '', journal: '' });
  });
  it('カテゴリー未設定の古い記事にも表紙が出る', () => {
    const c = coverStyle({});
    expect(c.line1).toBe('TEAM');
    expect(COVER_TONES).toContain(c.tone);
  });
  it('🔴 生成画像や実在しない写真を使わない（文字だけ）', () => {
    const c = coverStyle({ category: 'praise' });
    expect(c.imgId).toBe('');
    expect(JSON.stringify(c)).not.toMatch(/https?:|\.png|\.jpg/);
  });
  it('ピックアップは濃い色にして沈ませない', () => {
    expect(coverStyle({ category: 'notice', featured: true }).tone).toBe('dark');
  });
  it('同じカテゴリーなら同じ見た目（記事ごとに変えない）', () => {
    expect(coverStyle({ category: 'rule', title: 'A' })).toEqual(coverStyle({ category: 'rule', title: 'B' }));
  });
  it('決めた色以外を返さない', () => {
    for (const k of ['notice', 'event', 'rule', 'study', 'case', 'praise', '', 'unknown']) {
      expect(COVER_TONES, k).toContain(coverStyle({ category: k }).tone);
    }
  });
});
