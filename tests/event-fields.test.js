import { describe, it, expect } from 'vitest';
import {
  META_PREFIX, SECTION_KEYS, SECTION_LABEL, WELCOME_FLAGS, metaKey, normalizeMeta,
  parseTimeRange, readEvent, isPast, matches, byDate, canPublish,
} from '../lib/event-fields.js';

const NOW = new Date('2026-09-18T12:00:00+09:00');
const row = (cells, id = 'r1') => ({ id, cells, updatedBy: 'hq1', updatedAt: '2026-09-10T00:00:00.000Z' });
const OLD = row({ date: '10/8', time: '20:30-21:30', place: 'オンライン', owner: '青木',
                  teacher: '森', capacity: '12名', content: 'ケースラボ：現場の悩みを持ち寄る', contact: 'チャットで' });

describe('🔴 旧データを壊さない', () => {
  it('追加項目が無い行も、そのまま読める', () => {
    const ev = readEvent(OLD, 'study', null, NOW);
    expect(ev).toMatchObject({
      id: 'r1', section: 'study', sectionLabel: '勉強会',
      place: 'オンライン', owner: '青木', teacher: '森', capacityRaw: '12名',
    });
    expect(ev.title).toBe('ケースラボ：現場の悩みを持ち寄る');
    expect(ev.summary).toContain('ケースラボ');
    expect(ev.hasMeta).toBe(false);
  });
  it('追加項目は別のキーに持つ（cells に詰め込まない）', () => {
    expect(metaKey('r1')).toBe(`${META_PREFIX}r1`);
  });
  it('分類のキーは変えない（表示名だけ変える）', () => {
    expect(SECTION_KEYS).toEqual(['study', 'event', 'bukatsu']);
    expect(SECTION_LABEL.event).toBe('交流イベント');      // 呼び名だけ
    expect(SECTION_LABEL.study).toBe('勉強会');
    expect(SECTION_LABEL.bukatsu).toBe('部活');
  });
  it('旧 chatTitle があれば題名に使う', () => {
    expect(readEvent(row({ chatTitle: '沖縄セミナー 10/5', content: 'x' }), 'study', null, NOW).title).toBe('沖縄セミナー 10/5');
  });
  it('何も入っていない行でも落ちない', () => {
    const ev = readEvent({ id: 'r0' }, 'bukatsu', null, NOW);
    expect(ev.title).toBe('部活');
    expect(ev.date).toBe(null);
  });
  it('旧 roomId / ownerId を保つ（チャットの結びつきを失わない）', () => {
    const ev = readEvent(row({ roomId: 'room_1', ownerId: 's9' }), 'event', null, NOW);
    expect(ev.roomId).toBe('room_1');
    expect(ev.ownerId).toBe('s9');
  });
});

describe('追加項目', () => {
  it('新しい題名・要約があればそちらを使う', () => {
    const ev = readEvent(OLD, 'study', { title: '明日の施術が変わる60分', summary: '一緒に考える会' }, NOW);
    expect(ev.title).toBe('明日の施術が変わる60分');
    expect(ev.summary).toBe('一緒に考える会');
    expect(ev.hasMeta).toBe(true);
  });
  it('🔴 知らないキーを生やさない', () => {
    expect(Object.keys(normalizeMeta({ evil: 1 }))).not.toContain('evil');
  });
  it('🔴 「初参加歓迎」は主催者が設定したときだけ true', () => {
    expect(normalizeMeta({}).welcome).toEqual({ firstTimer: false, listenOnly: false, partial: false });
    expect(normalizeMeta({ welcome: { firstTimer: true } }).welcome.firstTimer).toBe(true);
    expect(WELCOME_FLAGS.map(f => f.key)).toEqual(['firstTimer', 'listenOnly', 'partial']);
  });
  it('🔴 URLは https だけ受け取る', () => {
    expect(normalizeMeta({ url: 'http://x' }).url).toBe('');
    expect(normalizeMeta({ url: 'javascript:alert(1)' }).url).toBe('');
    expect(normalizeMeta({ url: 'https://meet.example/abc' }).url).toBe('https://meet.example/abc');
  });
  it('🔴 料金は自由文のまま（勝手に0円にしない）', () => {
    expect(normalizeMeta({ fee: '' }).fee).toBe('');
    expect(normalizeMeta({ fee: '3,000円（当日払い）' }).fee).toBe('3,000円（当日払い）');
  });
  it('状態は下書き・公開・中止だけ', () => {
    expect(normalizeMeta({}).status).toBe('open');
    expect(normalizeMeta({ status: 'draft' }).status).toBe('draft');
    expect(normalizeMeta({ status: 'なんでも' }).status).toBe('open');
  });
});

describe('時間の読み取り', () => {
  it('開始と終了を読む', () => {
    expect(parseTimeRange('20:30-21:30')).toEqual({ start: '20:30', end: '21:30' });
    expect(parseTimeRange('9:00〜10:30')).toEqual({ start: '09:00', end: '10:30' });
    expect(parseTimeRange('１９：００−２０：００')).toMatchObject({ start: '19:00' });
  });
  it('開始だけでも読む', () => {
    expect(parseTimeRange('20:00から')).toEqual({ start: '20:00', end: '' });
  });
  it('🔴 読めない時間からそれらしい値を作らない', () => {
    for (const s of ['未定', '夜', '', null, '夕方ごろ']) expect(parseTimeRange(s), String(s)).toEqual({ start: '', end: '' });
  });
});

describe('🔴 日付が読めないものに日付を作らない', () => {
  it('繰り返し・未定は日付なしとして扱う', () => {
    expect(readEvent(row({ date: '毎週火曜' }), 'bukatsu', null, NOW).recurring).toBe(true);
    expect(readEvent(row({ date: '毎週火曜' }), 'bukatsu', null, NOW).date).toBe(null);
    expect(readEvent(row({ date: '未定' }), 'study', null, NOW).date).toBe(null);
  });
  it('過ぎた会だけを「終わった」にする', () => {
    expect(isPast(readEvent(row({ date: '8/1' }), 'study', null, NOW), NOW)).toBe(true);
    expect(isPast(readEvent(row({ date: '10/8' }), 'study', null, NOW), NOW)).toBe(false);
    expect(isPast(readEvent(row({ date: '9/18' }), 'study', null, NOW), NOW)).toBe(false);  // 当日は終わっていない
    expect(isPast(readEvent(row({ date: '毎週火曜' }), 'bukatsu', null, NOW), NOW)).toBe(false);
  });
});

describe('検索と並び', () => {
  const evs = [
    readEvent(row({ date: '10/8', content: 'ケースラボ', place: 'オンライン', teacher: '森' }, 'a'), 'study', null, NOW),
    readEvent(row({ date: '9/25', content: '歓迎会', place: '横浜' }, 'b'), 'event', null, NOW),
    readEvent(row({ date: '毎週火曜', content: 'ランニング部', place: '皇居' }, 'c'), 'bukatsu', null, NOW),
  ];
  it('題名・内容・場所・講師・分類名で当たる', () => {
    expect(evs.filter(e => matches(e, '横浜')).map(e => e.id)).toEqual(['b']);
    expect(evs.filter(e => matches(e, '森')).map(e => e.id)).toEqual(['a']);
    expect(evs.filter(e => matches(e, '部活')).map(e => e.id)).toEqual(['c']);
    expect(evs.filter(e => matches(e, 'オンライン')).map(e => e.id)).toEqual(['a']);
  });
  it('空の検索語ではすべて残る', () => {
    expect(evs.filter(e => matches(e, '')).length).toBe(3);
  });
  it('開催日順（日付なし・繰り返しは後ろ）', () => {
    expect([...evs].sort(byDate).map(e => e.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('🔴 空の予定を公開させない', () => {
  it('題名も日付も無い行は公開できない', () => {
    expect(canPublish(readEvent(row({}), 'study', null, NOW))).toMatchObject({ ok: false, reason: 'no_title' });
    expect(canPublish(readEvent(row({ content: 'ケースラボ' }), 'study', null, NOW))).toMatchObject({ ok: false, reason: 'no_date' });
  });
  it('題名と日付があれば公開できる', () => {
    expect(canPublish(readEvent(OLD, 'study', null, NOW)).ok).toBe(true);
  });
});
