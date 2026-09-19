import { describe, it, expect } from 'vitest';
import { HERO_DEFAULT, HERO_KEY, HERO_REASON, TITLE_MAX, LEAD_MAX,
         normalizeHero, canEditHero, heroReady, heroLines } from '../lib/news-hero.js';

describe('ファーストビューの中身', () => {
  it('未設定でも既定の文言で成り立つ', () => {
    const h = normalizeHero(null);
    expect(h.title).toBe(HERO_DEFAULT.title);
    expect(h.lead).toBe(HERO_DEFAULT.lead);
    expect(h.imgId).toBe('');
    expect(h.consent).toBe(false);
  });
  it('空欄は既定に戻す（空の面を出さない）', () => {
    expect(normalizeHero({ title: '   ' }).title).toBe(HERO_DEFAULT.title);
  });
  it('知らないキーを生やさない', () => {
    expect(Object.keys(normalizeHero({ こっそり: 1 })).sort())
      .toEqual(['consent', 'imgId', 'lead', 'overline', 'sign', 'signLatin', 'title', 'updatedAt', 'updatedBy']);
  });
  it('長さで切る', () => {
    expect(normalizeHero({ title: 'あ'.repeat(200) }).title.length).toBe(TITLE_MAX);
    expect(normalizeHero({ lead: 'い'.repeat(400) }).lead.length).toBe(LEAD_MAX);
  });
  it('掲載許可は自動で立てない', () => {
    expect(normalizeHero({ consent: 'yes' }).consent).toBe(false);
    expect(normalizeHero({ consent: true }).consent).toBe(true);
  });
  it('保存先のキーは1つ', () => expect(HERO_KEY).toBe('naoru:news:hero:v1'));
});

describe('差し替えてよい人', () => {
  it('本部・管理者だけ', () => {
    expect(canEditHero({ verified: true, role: 'root' })).toBe(true);
    expect(canEditHero({ verified: true, role: 'admin' })).toBe(true);
    expect(canEditHero({ verified: true, role: 'owner' })).toBe(false);
    expect(canEditHero({ verified: true, role: 'staff' })).toBe(false);
  });
  it('確認が取れていない名乗りは通さない', () => {
    expect(canEditHero({ verified: false, role: 'root' })).toBe(false);
    expect(canEditHero(null)).toBe(false);
  });
});

describe('保存してよいか', () => {
  it('写真が無ければそのまま保存できる', () => {
    expect(heroReady({ title: 'x' })).toEqual({ ok: true });
  });
  it('🔴 写真があるのに掲載許可が未確認なら止める', () => {
    const r = heroReady({ imgId: 'p1', consent: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('consent_unconfirmed');
    expect(HERO_REASON[r.reason]).toContain('掲載許可');
  });
  it('許可を確かめれば保存できる', () => {
    expect(heroReady({ imgId: 'p1', consent: true })).toEqual({ ok: true });
  });
});

describe('行への割り方', () => {
  it('改行をそのまま行にする', () => {
    expect(heroLines('この仲間と、\n次のNAORUへ。')).toEqual(['この仲間と、', '次のNAORUへ。']);
  });
  it('空行は落とす', () => {
    expect(heroLines('a\n\n\nb')).toEqual(['a', 'b']);
  });
  it('行数の上限を超えない', () => {
    expect(heroLines('a\nb\nc\nd\ne\nf', 3)).toEqual(['a', 'b', 'c']);
  });
  it('空でも落ちない', () => {
    expect(heroLines(null)).toEqual([]);
  });
});
