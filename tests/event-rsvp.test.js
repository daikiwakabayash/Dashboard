import { describe, it, expect } from 'vitest';
import {
  RSVP_PREFIX, STATES, STATE_LABEL, CHAT_ONLY_LABEL, rsvpKey, normalizeRsvp, parseCapacity,
  counts, myState, applyRsvp, promote, roster, canSeeRoster, chatOnlyMembers,
} from '../lib/event-rsvp.js';

const T = Date.parse('2026-09-18T10:00:00Z');
const PEOPLE = [
  { id: 'a', name: '青木', shop: 'NAORU 鶴見院' }, { id: 'b', name: '石田', shop: 'NAORU 関内院' },
  { id: 'c', name: '上野', shop: 'NAORU 仙台院' }, { id: 'd', name: '江川', shop: '本部' },
];
const go = (st, id, cap, at) => applyRsvp(st, { staffId: id, want: 'going', capacity: cap, at: at || T }).state;

describe('保存先と形の矯正', () => {
  it('イベント行ごとの小さなキーにする', () => {
    expect(rsvpKey('r1')).toBe(`${RSVP_PREFIX}r1`);
  });
  it('壊れた値・知らない状態を通さない', () => {
    expect(normalizeRsvp(null).v).toEqual({});
    expect(normalizeRsvp({ v: { a: { s: 'ゆるい' } } }).v).toEqual({});
    expect(normalizeRsvp({ v: [] }).v).toEqual({});
    expect(normalizeRsvp({ v: { a: { s: 'going', at: T, seq: 1 } } }).v.a).toMatchObject({ s: 'going', at: T });
  });
  it('件数の上限がある（異常膨張の歯止め）', () => {
    const big = {}; for (let i = 0; i < 20; i++) big[`s${i}`] = { s: 'going', seq: i + 1 };
    expect(Object.keys(normalizeRsvp({ v: big }, 5).v)).toHaveLength(5);
  });
  it('状態は5つ', () => { expect(STATES).toHaveLength(5); });
});

describe('🔴 定員: 自由文を無理に数にしない', () => {
  it('数だけを席として扱う', () => {
    for (const s of ['20', '20名', '20人', '10席', '定員 20人', '定員:15']) {
      expect(parseCapacity(s), s).toMatchObject({ kind: 'number' });
    }
  });
  it('🔴 「各店1名」「先着順」は数にしない（運営の確認が要る）', () => {
    for (const s of ['各店1名', '先着順', '応相談', '20名程度', 'なし', '店舗ごと2名まで']) {
      expect(parseCapacity(s), s).toMatchObject({ kind: 'text' });
    }
  });
  it('未設定は none', () => {
    expect(parseCapacity('')).toEqual({ kind: 'none' });
    expect(parseCapacity(null)).toEqual({ kind: 'none' });
  });
  it('🔴 席を管理できないときは「残り0」と言わない', () => {
    const st = go(go({}, 'a', '各店1名'), 'b', '各店1名');
    const c = counts(st, '各店1名');
    expect(c.going).toBe(2);
    expect(c.seatsLeft).toBe(null);          // 分からないものを0にしない
    expect(c.full).toBe(false);
    expect(c.capacityText).toBe('各店1名');
  });
});

describe('🔴 「気になる」は保存だけ（参加でもグループ所属でもない）', () => {
  it('気になるを押しても参加予定にならない', () => {
    const st = applyRsvp({}, { staffId: 'a', want: 'interested', capacity: '10', at: T }).state;
    expect(myState(st, 'a')).toBe('interested');
    expect(counts(st, '10').going).toBe(0);
  });
  it('🔴 参加予定の人が「気になる」を押しても参加が消えない', () => {
    const st = go({}, 'a', '10');
    const r = applyRsvp(st, { staffId: 'a', want: 'interested', capacity: '10' });
    expect(myState(r.state, 'a')).toBe('going');
    expect(r.result).toBe('unchanged');
  });
  it('2回押しても1件', () => {
    let st = applyRsvp({}, { staffId: 'a', want: 'interested' }).state;
    st = applyRsvp(st, { staffId: 'a', want: 'interested' }).state;
    expect(counts(st, '').interested).toBe(1);
  });
});

describe('🔴 参加は本人が押したときだけ・定員を超えない', () => {
  it('定員まで参加でき、超えるとキャンセル待ちになる', () => {
    let st = {};
    for (const id of ['a', 'b', 'c']) st = go(st, id, '2');
    const c = counts(st, '2');
    expect(c.going).toBe(2);
    expect(c.waitlist).toBe(1);
    expect(c.seatsLeft).toBe(0);
    expect(c.full).toBe(true);
    expect(myState(st, 'c')).toBe('waitlist');
  });
  it('🔴 連打しても席は1つしか取らない（冪等）', () => {
    let st = {};
    for (let i = 0; i < 5; i++) st = go(st, 'a', '3');
    expect(counts(st, '3').going).toBe(1);
    expect(counts(st, '3').seatsLeft).toBe(2);
  });
  it('🔴 キャンセル待ちの人が連打しても二重に並ばない', () => {
    let st = go(go({}, 'a', '1'), 'b', '1');
    st = go(st, 'b', '1');
    expect(counts(st, '1').waitlist).toBe(1);
  });
  it('🔴 同時に申し込んでも定員を超えない（同じ状態から始めた2人）', () => {
    const base = go({}, 'a', '2');
    // ⚠️ 実際の同時申込は compare-and-set でやり直しになる。やり直した後の結果を確かめる。
    const first = applyRsvp(base, { staffId: 'b', want: 'going', capacity: '2' });
    const second = applyRsvp(first.state, { staffId: 'c', want: 'going', capacity: '2' });
    expect(counts(second.state, '2').going).toBe(2);
    expect(second.result).toBe('waitlist');
  });
  it('定員が無ければ何人でも参加できる', () => {
    let st = {};
    for (const id of ['a', 'b', 'c', 'd']) st = go(st, id, '');
    expect(counts(st, '').going).toBe(4);
    expect(counts(st, '').waitlist).toBe(0);
  });
  it('本人が分からなければ何も記録しない', () => {
    expect(applyRsvp({}, { staffId: '', want: 'going' }).ok).toBe(false);
    expect(applyRsvp({}, { staffId: 'a', want: 'なんとなく' }).ok).toBe(false);
  });
});

describe('取消とキャンセル待ちの繰り上げ', () => {
  it('取消すと席が空き、キャンセル待ちの先頭が1人だけ繰り上がる', () => {
    let st = {};
    st = go(st, 'a', '2', T); st = go(st, 'b', '2', T + 1); st = go(st, 'c', '2', T + 2); st = go(st, 'd', '2', T + 3);
    expect(counts(st, '2')).toMatchObject({ going: 2, waitlist: 2 });
    const r = applyRsvp(st, { staffId: 'a', want: 'cancel', capacity: '2', at: T + 10 });
    expect(r.promoted).toBe('c');                       // 先に並んだ人
    expect(myState(r.state, 'c')).toBe('going');
    expect(myState(r.state, 'd')).toBe('waitlist');
    expect(counts(r.state, '2')).toMatchObject({ going: 2, waitlist: 1, cancelled: 1 });
  });
  it('キャンセル待ちの人が取消しても席は動かない', () => {
    let st = go(go({}, 'a', '1'), 'b', '1');
    const r = applyRsvp(st, { staffId: 'b', want: 'cancel', capacity: '1' });
    expect(r.promoted).toBe(null);
    expect(counts(r.state, '1').going).toBe(1);
  });
  it('🔴 自由文の定員では勝手に繰り上げない（運営の確認が要る）', () => {
    let st = go(go({}, 'a', '各店1名'), 'b', '各店1名');
    const r = applyRsvp(st, { staffId: 'a', want: 'cancel', capacity: '各店1名' });
    expect(r.promoted).toBe(null);
  });
  it('取消した人がもう一度参加できる', () => {
    const st = applyRsvp(go({}, 'a', '3'), { staffId: 'a', want: 'cancel', capacity: '3' }).state;
    expect(myState(applyRsvp(st, { staffId: 'a', want: 'going', capacity: '3' }).state, 'a')).toBe('going');
  });
  it('繰り上げる人がいなければ何も起きない', () => {
    expect(promote(go({}, 'a', '5'), '5', T).promoted).toBe(null);
  });
});

describe('招待', () => {
  it('招待は「招待済み」として残る', () => {
    const st = applyRsvp({}, { staffId: 'a', want: 'invite', by: 'host' }).state;
    expect(myState(st, 'a')).toBe('invited');
    expect(counts(st, '').going).toBe(0);            // 招待＝参加ではない
  });
  it('🔴 本人がすでに答えていれば、招待で上書きしない', () => {
    const st = go({}, 'a', '10');
    const r = applyRsvp(st, { staffId: 'a', want: 'invite', by: 'host' });
    expect(r.result).toBe('unchanged');
    expect(myState(r.state, 'a')).toBe('going');
  });
  it('招待を2回送っても1件（重複しない）', () => {
    let st = applyRsvp({}, { staffId: 'a', want: 'invite' }).state;
    st = applyRsvp(st, { staffId: 'a', want: 'invite' }).state;
    expect(counts(st, '').invited).toBe(1);
  });
});

describe('氏名の一覧', () => {
  it('状態ごとに申込順で並ぶ', () => {
    let st = go(go({}, 'b', '5', T), 'a', '5', T + 1);
    st = applyRsvp(st, { staffId: 'c', want: 'interested', at: T + 2 }).state;
    const r = roster(st, PEOPLE);
    expect(r.going.map(x => x.name)).toEqual(['石田', '青木']);
    expect(r.interested.map(x => x.name)).toEqual(['上野']);
    expect(r.going[0].shop).toBe('NAORU 関内院');
  });
  it('名簿に無い人でもIDだけは残る（勝手に消さない）', () => {
    const st = go({}, 'zz_退職', '5');
    expect(roster(st, PEOPLE).going).toEqual([{ id: 'zz_退職', name: '', shop: '', at: T, by: 'self' }]);
  });
  it('🔴 本人確認できていないセッションには開かない', () => {
    expect(canSeeRoster({ id: 'x', role: 'root', verified: false }, {})).toBe(false);
    expect(canSeeRoster(null, {})).toBe(false);
  });
  it('本部の管理者と主催者だけが見られる', () => {
    expect(canSeeRoster({ id: 'x', role: 'root', verified: true }, {})).toBe(true);
    expect(canSeeRoster({ id: 'h1', role: 'staff', verified: true }, { ownerId: 'h1' })).toBe(true);
    expect(canSeeRoster({ id: 'a', role: 'staff', verified: true }, { ownerId: 'h1' })).toBe(false);
  });
});

describe('🔴 チャットに入っていることを参加の根拠にしない', () => {
  it('回答していないチャット参加者を「出欠未回答」として返す', () => {
    const st = go({}, 'a', '10');
    expect(chatOnlyMembers(st, ['a', 'b', 'c'])).toEqual(['b', 'c']);
    expect(CHAT_ONLY_LABEL).toContain('未回答');
  });
  it('回答済みの人は含めない（気になる・取消も回答のうち）', () => {
    let st = applyRsvp({}, { staffId: 'b', want: 'interested' }).state;
    st = applyRsvp(go(st, 'c', '10'), { staffId: 'c', want: 'cancel', capacity: '10' }).state;
    expect(chatOnlyMembers(st, ['b', 'c', 'd'])).toEqual(['d']);
  });
  it('一度も押していない人は、押していない扱いのまま（取消にしない）', () => {
    const st = applyRsvp({}, { staffId: 'c', want: 'cancel' });
    expect(st.result).toBe('unchanged');
    expect(myState(st.state, 'c')).toBe('none');
  });
  it('人数には数えない', () => {
    expect(counts(go({}, 'a', '10'), '10').going).toBe(1);
  });
});

describe('画面に出す言葉', () => {
  it('状態ごとに日本語がある', () => {
    for (const s of [...STATES, 'none']) expect(STATE_LABEL[s], s).toBeTruthy();
    expect(STATE_LABEL.going).toBe('参加予定');
    expect(STATE_LABEL.waitlist).toBe('キャンセル待ち');
  });
});
