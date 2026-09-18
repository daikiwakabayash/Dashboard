import { describe, it, expect } from 'vitest';
import { resolveTimes, toIcs, icsFilename, ICS_REASON } from '../lib/event-ics.js';
import { readEvent } from '../lib/event-fields.js';

const NOW = new Date('2026-09-18T12:00:00+09:00');
const ev = (cells, meta) => readEvent({ id: 'r1', cells }, 'study', meta, NOW);
const OK = ev({ date: '2026-10-08', time: '20:30-21:30', place: 'オンライン', content: 'ケースラボ' });

describe('🔴 読めない日時でカレンダーを作らない', () => {
  it('日付が無い・繰り返しなら作らない', () => {
    expect(toIcs(ev({ date: '毎週火曜', time: '20:00' }))).toMatchObject({ ok: false, reason: 'no_date' });
    expect(toIcs(ev({ date: '未定', time: '20:00' }))).toMatchObject({ ok: false, reason: 'no_date' });
    expect(toIcs(ev({ time: '20:00' }))).toMatchObject({ ok: false, reason: 'no_date' });
  });
  it('時間が読めなければ作らない（適当な時刻を作らない）', () => {
    expect(toIcs(ev({ date: '2026-10-08', time: '夜' }))).toMatchObject({ ok: false, reason: 'no_time' });
    expect(toIcs(ev({ date: '2026-10-08' }))).toMatchObject({ ok: false, reason: 'no_time' });
  });
  it('理由を利用者の言葉で出せる', () => {
    expect(ICS_REASON.no_date).toContain('開催日');
    expect(ICS_REASON.no_time).toContain('開始時間');
  });
  it('知らない時間帯では作らない', () => {
    expect(toIcs({ ...OK, tz: 'Mars/Olympus' })).toMatchObject({ ok: false, reason: 'bad_tz' });
  });
});

describe('日本時間を正しく UTC へ直す', () => {
  it('20:30 JST は 11:30 UTC', () => {
    const t = resolveTimes(OK);
    expect(t.ok).toBe(true);
    expect(t.startUtc.toISOString()).toBe('2026-10-08T11:30:00.000Z');
    expect(t.endUtc.toISOString()).toBe('2026-10-08T12:30:00.000Z');
  });
  it('終了が無ければ1時間', () => {
    const t = resolveTimes(ev({ date: '2026-10-08', time: '20:00' }));
    expect(t.endUtc.getTime() - t.startUtc.getTime()).toBe(3600000);
  });
  it('日をまたぐ会も正しく終わる', () => {
    const t = resolveTimes(ev({ date: '2026-10-08', time: '22:00-01:00' }));
    expect(t.endUtc.toISOString()).toBe('2026-10-08T16:00:00.000Z');   // 翌 01:00 JST
  });
});

describe('ICS の中身', () => {
  const out = toIcs(OK, { now: new Date('2026-09-18T03:00:00Z'), link: 'https://dash.example/?tab=events&ev=r1' });
  it('カレンダーに読み込める形になっている', () => {
    expect(out.ok).toBe(true);
    expect(out.text.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect(out.text).toContain('BEGIN:VEVENT');
    expect(out.text).toContain('DTSTART:20261008T113000Z');
    expect(out.text).toContain('DTEND:20261008T123000Z');
    expect(out.text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(out.text.split('\r\n').length).toBeGreaterThan(10);
  });
  it('題名・場所・詳細リンクが入る', () => {
    expect(out.text).toContain('SUMMARY:ケースラボ');
    expect(out.text).toContain('LOCATION:オンライン');
    expect(out.text).toContain('tab=events');
  });
  it('🔴 参加者や人数は入れない（他人の予定表に名前を出さない）', () => {
    expect(out.text).not.toMatch(/ATTENDEE|参加者|名$/m);
  });
  it('区切り文字を壊さない（題名にカンマや改行があっても）', () => {
    const o = toIcs({ ...OK, title: 'A,B;C\nD' });
    expect(o.text).toContain('SUMMARY:A\\,B\;C\\nD');
  });
  it('中止の会は CANCELLED になる', () => {
    expect(toIcs({ ...OK, status: 'cancelled' }).text).toContain('STATUS:CANCELLED');
    expect(out.text).toContain('STATUS:CONFIRMED');
  });
  it('ファイル名が安全になる', () => {
    expect(icsFilename({ title: '../../etc/passwd' })).not.toContain('/');
    expect(icsFilename({ title: 'ケースラボ' })).toBe('ケースラボ.ics');
    expect(icsFilename({})).toBe('event.ics');
  });
});
