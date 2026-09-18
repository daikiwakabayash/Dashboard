import { describe, it, expect } from 'vitest';
import { prKey, normalizePr, markRead, markAck, dedupeAudience,
         postStatus, canSeeDetail, outOfAudience, BOARD_PR_PREFIX } from '../lib/board-status.js';

const AUD = [
  { id: 'a', name: '青木', shop: 'NAORU 鶴見院' },
  { id: 'b', name: '石田', shop: 'NAORU 関内院' },
  { id: 'c', name: '上野', shop: 'NAORU 仙台院' },
  { id: 'd', name: '江川', shop: '本部' },
];
const POST = { id: 'p1', authorId: 'hq1', reactions: { '👍': ['a'], '🎉': ['b', 'a'] } };
const T = Date.parse('2026-09-18T10:00:00Z');

describe('保存先と形の矯正', () => {
  it('投稿ごとの小さなキーにする', () => {
    expect(prKey('p1')).toBe(`${BOARD_PR_PREFIX}p1`);
  });
  it('壊れた値を通さない', () => {
    expect(normalizePr(null)).toEqual({ r: {}, a: {} });
    expect(normalizePr({ r: { x: 0, y: 'abc', z: T } })).toEqual({ r: { z: T }, a: {} });
    expect(normalizePr({ r: [] })).toEqual({ r: {}, a: {} });
  });
  it('件数の上限がある（異常膨張の歯止め）', () => {
    const big = {}; for (let i = 0; i < 20; i++) big[`s${i}`] = T;
    expect(Object.keys(normalizePr({ r: big }, 5).r)).toHaveLength(5);
  });
});

describe('既読の記録', () => {
  it('記事を表示できたら記録される', () => {
    expect(markRead({}, 'a', T).r).toEqual({ a: T });
  });
  it('⚠️ 最初に読めた時刻を残す（あとから上書きしない）', () => {
    const first = markRead({}, 'a', T);
    expect(markRead(first, 'a', T + 99999).r.a).toBe(T);
  });
  it('idが無ければ何も記録しない（取れていない記録を作らない）', () => {
    expect(markRead({}, '', T).r).toEqual({});
    expect(markRead({}, null, T).r).toEqual({});
  });
});

describe('「確認しました」の記録', () => {
  it('既読とは別に持つ', () => {
    const pr = markAck({}, 'a', T);
    expect(pr.a).toEqual({ a: T });
    expect(pr.r.a).toBe(T);                   // 押せた＝読めているので既読も付く
  });
  it('既読があっても「確認しました」は自動で付かない', () => {
    const pr = markRead({}, 'b', T);
    expect(pr.a).toEqual({});
  });
  it('2回押しても時刻は最初のまま', () => {
    const p1 = markAck({}, 'a', T);
    expect(markAck(p1, 'a', T + 5000).a.a).toBe(T);
  });
});

describe('分母は投稿の対象者（重複して数えない）', () => {
  it('同じ人が複数店舗で出てきても1人', () => {
    const dup = [...AUD, { id: 'a', name: '青木', shop: 'NAORU 関内院' }];
    expect(dedupeAudience(dup)).toHaveLength(4);
    expect(postStatus(POST, dup, {}).total).toBe(4);
  });
  it('idの無い行は数えない', () => {
    expect(dedupeAudience([{ name: '名前だけ' }, null])).toEqual([]);
  });
});

describe('投稿1件の状況', () => {
  const pr = markAck(markRead(markRead({}, 'a', T), 'b', T + 1000), 'a', T + 2000);
  const st = postStatus(POST, AUD, pr);

  it('既読と未読の人数が合う', () => {
    expect(st.counts.read).toBe(2);        // a, b
    expect(st.counts.unread).toBe(2);      // c, d
    expect(st.counts.read + st.counts.unread).toBe(st.total);
  });
  it('「確認しました」は押した人だけ', () => {
    expect(st.counts.acked).toBe(1);       // a
    expect(st.people.acked.map(p => p.id)).toEqual(['a']);
  });
  it('リアクションは既存のスタンプから数える（同じ人を二重に数えない）', () => {
    expect(st.counts.reacted).toBe(2);     // a, b（a は 2種類押している）
    expect(st.counts.notReacted).toBe(2);
  });
  it('氏名と所属が出る（誰が未読か分かる）', () => {
    expect(st.people.unread.map(p => p.name)).toEqual(['上野', '江川']);
    expect(st.people.unread[0].shop).toBe('NAORU 仙台院');
  });
  it('⚠️ 未読の人に時刻を作らない', () => {
    expect(st.people.unread.every(p => p.at === null)).toBe(true);
    expect(st.people.read.find(p => p.id === 'a').at).toBe(T);
  });
  it('「未リアクションには未読も含む」と画面に出す文がある', () => {
    expect(st.note).toContain('まだ読んでいない人も含まれます');
  });
  it('誰も読んでいなければ全員未読', () => {
    expect(postStatus(POST, AUD, {}).counts.read).toBe(0);
    expect(postStatus(POST, AUD, {}).counts.unread).toBe(4);
  });
  it('対象者が空でも落ちない', () => {
    expect(postStatus(POST, [], pr).total).toBe(0);
    expect(postStatus(null, AUD, null).counts.read).toBe(0);
  });
});

describe('詳細（氏名の一覧）を見られる人', () => {
  it('本部の管理者は見られる', () => {
    expect(canSeeDetail({ id: 'x', role: 'root', verified: true }, POST)).toBe(true);
    expect(canSeeDetail({ id: 'y', role: 'admin', verified: true }, POST)).toBe(true);
  });
  it('その投稿の投稿者本人は見られる', () => {
    expect(canSeeDetail({ id: 'hq1', role: 'staff', verified: true }, POST)).toBe(true);
  });
  it('⚠️ ほかのスタッフには開かない', () => {
    expect(canSeeDetail({ id: 'a', role: 'staff', verified: true }, POST)).toBe(false);
    expect(canSeeDetail({ id: 'a', role: 'owner', verified: true }, POST)).toBe(false);
  });
  it('⚠️ 本人確認できていないセッションは、役割を名乗っても見られない', () => {
    expect(canSeeDetail({ id: 'x', role: 'root', verified: false }, POST)).toBe(false);
    expect(canSeeDetail({ id: 'hq1', role: 'root' }, POST)).toBe(false);
    expect(canSeeDetail(null, POST)).toBe(false);
  });
  it('投稿者が分からない古い投稿は、管理者だけが見られる', () => {
    const old = { id: 'p0', reactions: {} };
    expect(canSeeDetail({ id: 'a', role: 'staff', verified: true }, old)).toBe(false);
    expect(canSeeDetail({ id: 'x', role: 'root', verified: true }, old)).toBe(true);
  });
});

describe('対象者が変わった・退職した場合', () => {
  it('対象外になった人の記録は残すが、分母には入れない', () => {
    const pr = markRead(markRead({}, 'a', T), 'zz_退職', T);
    const st = postStatus(POST, AUD, pr);
    expect(st.total).toBe(4);
    expect(st.counts.read).toBe(1);                    // 対象内の a だけ
    expect(outOfAudience(AUD, pr)).toMatchObject({ count: 1, ids: ['zz_退職'] });
  });
  it('対象外がいなければ0件', () => {
    expect(outOfAudience(AUD, markRead({}, 'a', T)).count).toBe(0);
  });
});
