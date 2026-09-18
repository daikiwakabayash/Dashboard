import { describe, it, expect } from 'vitest';
import { normalizeTags, normalizeIntro, hasIntro, initialOf, searchNorm, searchHay,
         filterPeople, mergeByStaffId, canEditProfile, TAG_SUGGESTIONS, TAG_MAX, ONELINE_LEN } from '../lib/profile-fields.js';

describe('タグの整え方', () => {
  it('空・重複・前後の空白を落とす', () => {
    expect(normalizeTags([' 骨盤矯正 ', '骨盤矯正', '', null, '猫背'])).toEqual(['骨盤矯正', '猫背']);
  });
  it('大文字小文字の違いは同じタグとして扱う', () => {
    expect(normalizeTags(['Golf', 'golf'])).toEqual(['Golf']);
  });
  it('長すぎるタグは切る', () => {
    expect(normalizeTags(['あ'.repeat(50)])[0]).toHaveLength(24);
  });
  it('多すぎるタグは上限まで', () => {
    expect(normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`))).toHaveLength(TAG_MAX);
  });
  it('配列でなければ空', () => {
    expect(normalizeTags('骨盤矯正')).toEqual([]);
    expect(normalizeTags(null)).toEqual([]);
  });
});

describe('自己紹介の項目', () => {
  it('4つの項目だけを取り出す', () => {
    const got = normalizeIntro({ oneLine: 'よろしくお願いします', goodAt: ['骨盤矯正'], learning: ['栄養'], hobbies: ['サウナ'] });
    expect(got).toEqual({ oneLine: 'よろしくお願いします', goodAt: ['骨盤矯正'], learning: ['栄養'], hobbies: ['サウナ'] });
  });
  it('⚠️ 氏名・所属・役割・社員IDは受け取らない（正本を書き換えさせない）', () => {
    const got = normalizeIntro({ name: '別人', shop: '別店舗', role: 'root', staffId: '999', oneLine: 'ひとこと' });
    expect(got).toEqual({ oneLine: 'ひとこと', goodAt: [], learning: [], hobbies: [] });
    expect(Object.keys(got).sort()).toEqual(['goodAt', 'hobbies', 'learning', 'oneLine']);
  });
  it('ひとことは1行にして長さを切る', () => {
    expect(normalizeIntro({ oneLine: 'あ\nい\nう' }).oneLine).toBe('あ い う');
    expect(normalizeIntro({ oneLine: 'あ'.repeat(200) }).oneLine).toHaveLength(ONELINE_LEN);
  });
  it('空でも成立する（写真も自己紹介も任意）', () => {
    expect(normalizeIntro(null)).toEqual({ oneLine: '', goodAt: [], learning: [], hobbies: [] });
    expect(hasIntro(null)).toBe(false);
    expect(hasIntro({ hobbies: ['サウナ'] })).toBe(true);
  });
  it('入力例が用意されている（気軽に書けるように）', () => {
    expect(TAG_SUGGESTIONS.goodAt).toContain('骨盤矯正');
    expect(TAG_SUGGESTIONS.hobbies).toContain('サウナ');
    expect(TAG_SUGGESTIONS.learning.length).toBeGreaterThan(3);
  });
});

describe('写真が無い人', () => {
  it('イニシャルで統一する（生成顔を使わない）', () => {
    expect(initialOf('青木ひかる')).toBe('青');
    expect(initialOf(' 山田 ')).toBe('山');
    expect(initialOf('')).toBe('?');
    expect(initialOf(null)).toBe('?');
  });
});

describe('検索', () => {
  const PEOPLE = [
    { id: 'a', name: '青木ひかる', shop: 'NAORU 鶴見院' },
    { id: 'b', name: '石田なつ', shop: 'NAORU 関内院' },
    { id: 'c', name: '上野かい', shop: 'NAORU 仙台院' },
  ];
  const PROF = {
    a: { oneLine: '産後ケアが得意です', goodAt: ['骨盤矯正', '産後ケア'], hobbies: ['サウナ'] },
    b: { goodAt: ['肩こり'], hobbies: ['ゴルフ', 'キャンプ'] },
  };
  const of = (p) => PROF[p.id];

  it('名前で当たる', () => {
    expect(filterPeople(PEOPLE, '青木', of).map(p => p.id)).toEqual(['a']);
  });
  it('店舗で当たる', () => {
    expect(filterPeople(PEOPLE, '鶴見', of).map(p => p.id)).toEqual(['a']);
  });
  it('得意分野で当たる', () => {
    expect(filterPeople(PEOPLE, '骨盤', of).map(p => p.id)).toEqual(['a']);
    expect(filterPeople(PEOPLE, '肩こり', of).map(p => p.id)).toEqual(['b']);
  });
  it('趣味で当たる', () => {
    expect(filterPeople(PEOPLE, 'ゴルフ', of).map(p => p.id)).toEqual(['b']);
  });
  it('ひとことでも当たる', () => {
    expect(filterPeople(PEOPLE, '産後', of).map(p => p.id)).toEqual(['a']);
  });
  it('全角半角・カナひらがな・大小文字の違いを吸収する', () => {
    expect(searchNorm('ＮＡＯＲＵ　ツルミ')).toBe(searchNorm('naoru つるみ'));
    expect(filterPeople(PEOPLE, 'サウナ', of).map(p => p.id)).toEqual(['a']);
    expect(filterPeople(PEOPLE, 'さうな', of).map(p => p.id)).toEqual(['a']);
  });
  it('空なら全員', () => {
    expect(filterPeople(PEOPLE, '', of)).toHaveLength(3);
    expect(filterPeople(PEOPLE, '   ', of)).toHaveLength(3);
  });
  it('自己紹介が無い人も名前では当たる', () => {
    expect(filterPeople(PEOPLE, '上野', of).map(p => p.id)).toEqual(['c']);
  });
  it('検索対象の文字列が作れる', () => {
    expect(searchHay(PEOPLE[0], PROF.a)).toContain('骨盤矯正');
  });
});

describe('複数店舗の人を1人にまとめる', () => {
  it('staff_id で集約し、店舗を全部持つ', () => {
    const got = mergeByStaffId([
      { id: 'a', name: '青木', shop: 'NAORU 鶴見院' },
      { id: 'a', name: '青木', shop: 'NAORU 関内院' },
      { id: 'b', name: '石田', shop: 'NAORU 仙台院' },
    ]);
    expect(got).toHaveLength(2);
    expect(got[0].shops).toEqual(['NAORU 鶴見院', 'NAORU 関内院']);
    expect(got[0].shop).toBe('NAORU 鶴見院');
  });
  it('同じ店舗が2回出ても増やさない', () => {
    const got = mergeByStaffId([{ id: 'a', name: '青木', shop: 'X' }, { id: 'a', name: '青木', shop: 'X' }]);
    expect(got[0].shops).toEqual(['X']);
  });
  it('idの無い行は落とす', () => {
    expect(mergeByStaffId([{ name: 'id無し' }, null])).toEqual([]);
  });
  it('店舗が空でも在籍として残す（売上の有無を在籍の条件にしない）', () => {
    expect(mergeByStaffId([{ id: 'a', name: '青木', shop: '' }])).toHaveLength(1);
  });
});

describe('自己紹介を編集できる人', () => {
  it('本人は編集できる', () => {
    expect(canEditProfile({ id: 'a', role: 'staff', verified: true }, 'a')).toBe(true);
  });
  it('本部の管理者は編集できる', () => {
    expect(canEditProfile({ id: 'x', role: 'root', verified: true }, 'a')).toBe(true);
    expect(canEditProfile({ id: 'x', role: 'admin', verified: true }, 'a')).toBe(true);
  });
  it('⚠️ 他人は編集できない', () => {
    expect(canEditProfile({ id: 'b', role: 'staff', verified: true }, 'a')).toBe(false);
    expect(canEditProfile({ id: 'b', role: 'owner', verified: true }, 'a')).toBe(false);
  });
  it('⚠️ 本人確認できていないセッションは、役割を名乗っても編集できない', () => {
    expect(canEditProfile({ id: 'x', role: 'root', verified: false }, 'a')).toBe(false);
    expect(canEditProfile({ id: 'a', role: 'root' }, 'a')).toBe(false);
    expect(canEditProfile(null, 'a')).toBe(false);
  });
});
