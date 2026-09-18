import { describe, it, expect } from 'vitest';
import { buildEventLink, extractEventLinks, resolveEvent, joinState,
         resolvePostEvents, JOIN_LABEL } from '../lib/news-event.js';

const ORIGIN = 'https://dash.example.com';
const SECTIONS = {
  '勉強会': [
    { id: 'row_okinawa', cells: { date: '2026-10-05', chatTitle: '沖縄セミナー 10/5', roomId: 'room_okn', ownerId: 's1' } },
    { id: 'row_nochat', cells: { date: '2026-11-01', chatTitle: 'まだ部屋なし' } },
  ],
  '社内研修': [
    { id: 'row_tokyo', cells: { date: '2026-10-20', roomId: 'room_tky' } },   // chatTitle 無し
  ],
};
const ROOMS = [
  { id: 'room_okn', kind: 'group', name: '沖縄セミナー 10/5', members: ['s1', 's2'] },
  { id: 'room_tky', kind: 'group', name: '東京研修', members: ['s9'] },
];

describe('イベントリンクを作る', () => {
  it('Dashboard 自身のURLになる', () => {
    expect(buildEventLink(ORIGIN, 'row_okinawa')).toBe(`${ORIGIN}/?tab=events&ev=row_okinawa`);
  });
  it('末尾のスラッシュが重ならない', () => {
    expect(buildEventLink(`${ORIGIN}/`, 'row_x')).toBe(`${ORIGIN}/?tab=events&ev=row_x`);
  });
  it('IDが無ければ作らない', () => {
    expect(buildEventLink(ORIGIN, '')).toBe('');
    expect(buildEventLink(ORIGIN, null)).toBe('');
  });
});

describe('本文からイベントリンクだけを拾う', () => {
  it('本文に混ざっていても拾える', () => {
    const t = `沖縄のイベントを開催します。\n詳細はこちら ${ORIGIN}/?tab=events&ev=row_okinawa\nよろしくお願いします。`;
    expect(extractEventLinks(t, ORIGIN)).toEqual([{ url: `${ORIGIN}/?tab=events&ev=row_okinawa`, rowId: 'row_okinawa' }]);
  });
  it('⚠️ 別サイトのURLは受け付けない（外部を読みに行かない）', () => {
    expect(extractEventLinks(`https://evil.example/?tab=events&ev=row_okinawa`, ORIGIN)).toEqual([]);
  });
  it('イベントリンクでないURLは無視する', () => {
    expect(extractEventLinks(`${ORIGIN}/?tab=chat`, ORIGIN)).toEqual([]);
    expect(extractEventLinks(`${ORIGIN}/?tab=events`, ORIGIN)).toEqual([]);   // ev が無い
  });
  it('同じイベントを2回貼っても1件', () => {
    const t = `${ORIGIN}/?tab=events&ev=row_okinawa と ${ORIGIN}/?tab=events&ev=row_okinawa`;
    expect(extractEventLinks(t, ORIGIN)).toHaveLength(1);
  });
  it('複数のイベントを貼れる', () => {
    const t = `${ORIGIN}/?tab=events&ev=row_okinawa\n${ORIGIN}/?tab=events&ev=row_tokyo`;
    expect(extractEventLinks(t, ORIGIN).map(x => x.rowId)).toEqual(['row_okinawa', 'row_tokyo']);
  });
  it('末尾の句読点を巻き込まない', () => {
    expect(extractEventLinks(`詳細は ${ORIGIN}/?tab=events&ev=row_okinawa。`, ORIGIN)[0].rowId).toBe('row_okinawa');
  });
  it('壊れた入力でも落ちない', () => {
    expect(extractEventLinks(null, ORIGIN)).toEqual([]);
    expect(extractEventLinks('http://', ORIGIN)).toEqual([]);
    expect(extractEventLinks(`${ORIGIN}/?tab=events&ev=x`, '')).toEqual([]);
  });
});

describe('イベントIDを実在の行に結びつける', () => {
  it('見つかると名前・日付・ルームが取れる', () => {
    expect(resolveEvent('row_okinawa', SECTIONS)).toMatchObject({
      found: true, section: '勉強会', title: '沖縄セミナー 10/5', date: '2026-10-05', roomId: 'room_okn',
    });
  });
  it('chatTitle が無ければセクション名を使う', () => {
    expect(resolveEvent('row_tokyo', SECTIONS).title).toBe('社内研修');
  });
  it('⚠️ 実在しないIDは「ある」ことにしない', () => {
    expect(resolveEvent('row_zzz', SECTIONS)).toEqual({ found: false, reason: 'not_found' });
    expect(resolveEvent('', SECTIONS)).toEqual({ found: false, reason: 'no_id' });
  });
  it('イベント表が壊れていても落ちない', () => {
    expect(resolveEvent('row_okinawa', null).found).toBe(false);
    expect(resolveEvent('row_okinawa', { '勉強会': [null, 'x'] }).found).toBe(false);
  });
});

describe('参加ボタンの状態', () => {
  const ev = resolveEvent('row_okinawa', SECTIONS);
  it('未参加なら「参加」', () => {
    expect(joinState(ev, ROOMS, 's9')).toBe('can_join');
    expect(JOIN_LABEL.can_join).toBe('グループチャットへ参加');
  });
  it('参加済みなら「開く」（作り直さない）', () => {
    expect(joinState(ev, ROOMS, 's2')).toBe('joined');
    expect(JOIN_LABEL.joined).toBe('グループチャットを開く');
  });
  it('グループが無いイベントは「未作成」（勝手に作らない）', () => {
    expect(joinState(resolveEvent('row_nochat', SECTIONS), ROOMS, 's9')).toBe('no_room');
  });
  it('見えないルームは参加させない', () => {
    expect(joinState(ev, [], 's9')).toBe('no_access');
  });
  it('自分が誰か分からなければ参加させない', () => {
    expect(joinState(ev, ROOMS, '')).toBe('no_access');
  });
  it('イベントが消えていれば「見つかりません」', () => {
    expect(joinState(resolveEvent('row_zzz', SECTIONS), ROOMS, 's9')).toBe('no_event');
  });
});

describe('記事を開いたときの見え方', () => {
  const text = `沖縄のイベントです。${ORIGIN}/?tab=events&ev=row_okinawa\n`
    + `こちらはまだ部屋なし ${ORIGIN}/?tab=events&ev=row_nochat\n`
    + `外部リンク https://example.com/?tab=events&ev=row_okinawa`;

  it('自分のイベントだけが2件出る（外部リンクは出ない）', () => {
    const got = resolvePostEvents(text, { origin: ORIGIN, sections: SECTIONS, rooms: ROOMS, myId: 's9' });
    expect(got.map(x => x.rowId)).toEqual(['row_okinawa', 'row_nochat']);
  });
  it('状態ごとに出す言葉が変わる', () => {
    const got = resolvePostEvents(text, { origin: ORIGIN, sections: SECTIONS, rooms: ROOMS, myId: 's9' });
    expect(got[0]).toMatchObject({ state: 'can_join', label: 'グループチャットへ参加' });
    expect(got[1]).toMatchObject({ state: 'no_room' });
    expect(got[1].label).toContain('まだグループチャットがありません');
  });
  it('参加済みの人には「開く」と出る', () => {
    const got = resolvePostEvents(text, { origin: ORIGIN, sections: SECTIONS, rooms: ROOMS, myId: 's2' });
    expect(got[0].state).toBe('joined');
  });
  it('イベント名と日付が記事に出せる', () => {
    const got = resolvePostEvents(text, { origin: ORIGIN, sections: SECTIONS, rooms: ROOMS, myId: 's9' });
    expect(got[0].event).toMatchObject({ title: '沖縄セミナー 10/5', date: '2026-10-05' });
  });
  it('リンクが無い記事では何も出ない', () => {
    expect(resolvePostEvents('ただのお知らせです', { origin: ORIGIN, sections: SECTIONS, rooms: ROOMS, myId: 's9' })).toEqual([]);
  });
  it('引数が無くても落ちない', () => {
    expect(resolvePostEvents(text, {})).toEqual([]);
    expect(resolvePostEvents(text)).toEqual([]);
  });
});
