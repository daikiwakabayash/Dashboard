import { describe, it, expect } from 'vitest';
import {
  MAX_PHOTOS, MAX_FILES, NOTE_MAX, RECAP_REASON, normalizeRecap, normalizeVideoUrl, emptyRecap,
  recapCounts, hasRecap, recapReady, canEditRecap, recapVisible, recapSummary,
} from '../lib/event-recap.js';

describe('録画のURL', () => {
  it('https だけ受ける', () => {
    expect(normalizeVideoUrl('https://example.com/v')).toBe('https://example.com/v');
    expect(normalizeVideoUrl('http://example.com/v')).toBe('');
    expect(normalizeVideoUrl('javascript:alert(1)')).toBe('');
    expect(normalizeVideoUrl('')).toBe('');
    expect(normalizeVideoUrl(null)).toBe('');
  });
});

describe('ふりかえりの形', () => {
  it('知らないキーを生やさない', () => {
    const r = normalizeRecap({ note: 'a', こっそり: 'x' });
    expect(Object.keys(r).sort()).toEqual(['consent', 'files', 'note', 'photoIds', 'updatedAt', 'updatedBy', 'videoUrl']);
  });
  it('空でも落ちない', () => {
    expect(emptyRecap()).toEqual({ note: '', photoIds: [], files: [], videoUrl: '', consent: false, updatedAt: 0, updatedBy: '' });
    expect(normalizeRecap(null).note).toBe('');
    expect(normalizeRecap('文字列').photoIds).toEqual([]);
  });
  it('写真は重複を除き、上限で切る', () => {
    const many = Array.from({ length: 30 }, (_, i) => `i${i}`);
    expect(normalizeRecap({ photoIds: ['a', 'a', 'b'] }).photoIds).toEqual(['a', 'b']);
    expect(normalizeRecap({ photoIds: many }).photoIds.length).toBe(MAX_PHOTOS);
  });
  it('資料はIDが無いものを捨てる', () => {
    const f = normalizeRecap({ files: [{ id: 'f1', name: '資料.pdf' }, { name: 'IDなし' }] }).files;
    expect(f).toEqual([{ id: 'f1', name: '資料.pdf', type: '', size: 0 }]);
  });
  it('資料も上限で切る', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `f${i}` }));
    expect(normalizeRecap({ files: many }).files.length).toBe(MAX_FILES);
  });
  it('レポートは長さで切る', () => {
    expect(normalizeRecap({ note: 'あ'.repeat(5000) }).note.length).toBe(NOTE_MAX);
  });
  it('掲載許可は自動で立てない', () => {
    expect(normalizeRecap({ consent: 'yes' }).consent).toBe(false);
    expect(normalizeRecap({ consent: 1 }).consent).toBe(false);
    expect(normalizeRecap({ consent: true }).consent).toBe(true);
  });
});

describe('中身の有無', () => {
  it('何も無ければ空', () => {
    expect(hasRecap(null)).toBe(false);
    expect(hasRecap({ note: '   ' })).toBe(false);
  });
  it('どれか1つでもあれば中身あり', () => {
    expect(hasRecap({ note: 'よい会でした' })).toBe(true);
    expect(hasRecap({ photoIds: ['p1'] })).toBe(true);
    expect(hasRecap({ files: [{ id: 'f1' }] })).toBe(true);
    expect(hasRecap({ videoUrl: 'https://example.com/v' })).toBe(true);
  });
  it('数を数えられる', () => {
    expect(recapCounts({ note: 'x', photoIds: ['a', 'b'], files: [{ id: 'f' }], videoUrl: 'https://e.com/v' }))
      .toEqual({ photos: 2, files: 1, hasVideo: true, hasNote: true });
  });
  it('一覧の一言。中身が無ければ空（0件と書かない）', () => {
    expect(recapSummary(null)).toBe('');
    expect(recapSummary({ note: 'x', photoIds: ['a', 'b'] })).toBe('レポート・写真2枚');
    expect(recapSummary({ videoUrl: 'https://e.com/v' })).toBe('録画');
  });
});

describe('保存してよいか', () => {
  it('空は保存しない', () => {
    expect(recapReady(null)).toEqual({ ok: false, reason: 'empty' });
  });
  it('🔴 写真があるのに掲載許可が未確認なら止める', () => {
    const r = recapReady({ photoIds: ['p1'], consent: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('consent_unconfirmed');
    expect(RECAP_REASON[r.reason]).toContain('掲載許可');
  });
  it('許可を確かめれば保存できる', () => {
    expect(recapReady({ photoIds: ['p1'], consent: true })).toEqual({ ok: true });
  });
  it('写真が無ければ許可の確認は要らない', () => {
    expect(recapReady({ note: '当日の様子です' })).toEqual({ ok: true });
  });
});

describe('書ける人', () => {
  const ev = { ownerId: 'u1' };
  it('主催者は書ける', () => expect(canEditRecap({ isHq: false, meId: 'u1' }, ev)).toBe(true));
  it('本部は書ける', () => expect(canEditRecap({ isHq: true, meId: 'zz' }, ev)).toBe(true));
  it('他の人は書けない', () => expect(canEditRecap({ isHq: false, meId: 'u2' }, ev)).toBe(false));
  it('主催者が分からない会は、本部以外は書けない', () => {
    expect(canEditRecap({ isHq: false, meId: 'u1' }, { ownerId: '' })).toBe(false);
    expect(canEditRecap({ isHq: true, meId: '' }, { ownerId: '' })).toBe(true);
  });
  it('名乗りが空なら本人扱いしない', () => expect(canEditRecap({ isHq: false, meId: '' }, ev)).toBe(false));
});

describe('出す場面', () => {
  it('終わった会にだけ出す', () => {
    expect(recapVisible({ status: 'open' }, true)).toBe(true);
    expect(recapVisible({ status: 'open' }, false)).toBe(false);
  });
  it('下書きには出さない', () => {
    expect(recapVisible({ status: 'draft' }, true)).toBe(false);
  });
  it('中止になった会にも残せる（何があったかを書けるように）', () => {
    expect(recapVisible({ status: 'cancelled' }, true)).toBe(true);
  });
});
