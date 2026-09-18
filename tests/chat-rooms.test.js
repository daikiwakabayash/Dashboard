import { describe, it, expect } from 'vitest';
import {
  CHAT_SYNC_VERSION, DEFAULT_LIMITS, normalizeShopName, indexShopsByName, staffStoreIds,
  checkSourceHealth, planStoreRoomSync, planEventRoomSync, planChatSync,
  isNoop, applyPlanForTest, summarizePlan,
  readyItems, heldItems, staffStoreScope, APPLY_HOLD, APPLY_READY,
} from '../lib/chat-rooms.js';

// ── 合成データ（本番データは一切使わない）────────────────────────────────
const SHOPS = [
  { id: '100', name: 'NAORU渋谷院' },
  { id: '200', name: 'NAORU梅田院' },
];
const STAFFS = [
  { id: 's1', name: 'スタッフA', shop_id: '100' },
  { id: 's2', name: 'スタッフB', shop_id: '100' },
  { id: 's3', name: 'スタッフC', shop_id: '200' },
];
// 既存の店舗ルーム（store_<店舗名> ＝ storeId 未設定の従来データ）
const LEGACY_ROOMS = [
  { id: 'store_NAORU渋谷院', kind: 'store', name: 'NAORU渋谷院', shop: 'NAORU渋谷院', members: [] },
  { id: 'store_NAORU梅田院', kind: 'store', name: 'NAORU梅田院', shop: 'NAORU梅田院', members: [] },
];
// C. 完全性フラグを明示した入力（破壊的操作＝削除・アーカイブを許可するのに必要）
const COMPLETE = { shopsComplete: true, staffsComplete: true };
const base = (over = {}) => ({ rooms: LEGACY_ROOMS, shops: SHOPS, staffs: STAFFS, ...over });

describe('chat-rooms: 前提', () => {
  it('バージョンがある / plan は dryRun である', () => {
    expect(CHAT_SYNC_VERSION).toBe('chat-rooms-sync-1');
    expect(planStoreRoomSync(base()).dryRun).toBe(true);
  });
  it('店舗名の正規化は接辞を落とさない（似た名前を同一視しない）', () => {
    expect(normalizeShopName(' ＮＡＯＲＵ渋谷院 ')).toBe('naoru渋谷院');
    expect(normalizeShopName('NAORU渋谷院')).not.toBe(normalizeShopName('NAORU渋谷西院'));
    expect(normalizeShopName('NAORU梅田院')).not.toBe(normalizeShopName('NAORU梅田中央院'));
  });
});

describe('chat-rooms: 既存 Room の ID 紐付け', () => {
  it('既存 Room の ID は変えず storeId を後付けする', () => {
    const plan = planStoreRoomSync(base());
    expect(plan.bind).toEqual([
      { roomId: 'store_NAORU渋谷院', storeId: '100', shopName: 'NAORU渋谷院', matchedBy: 'exact_name', apply: 'ready' },
      { roomId: 'store_NAORU梅田院', storeId: '200', shopName: 'NAORU梅田院', matchedBy: 'exact_name', apply: 'ready' },
    ]);
    expect(plan.create).toEqual([]);      // 既存があるので新規作成しない
  });

  it('部分一致では紐付けない（権限を広げない）→ 要確認に出す', () => {
    const rooms = [{ id: 'store_渋谷', kind: 'store', name: '渋谷', shop: '渋谷', members: [] }];
    const plan = planStoreRoomSync(base({ rooms }));
    expect(plan.bind).toEqual([]);
    expect(plan.review.some(r => r.kind === 'room_bind' && /完全一致する店舗名が無い/.test(r.reason))).toBe(true);
    // 「渋谷」で NAORU渋谷院 に紐付いてしまわないこと
    expect(plan.bind.find(b => b.storeId === '100')).toBeUndefined();
  });

  it('似た名前の店舗（渋谷院 / 渋谷西院）を混同しない', () => {
    const shops = [...SHOPS, { id: '101', name: 'NAORU渋谷西院' }];
    const plan = planStoreRoomSync(base({ shops }));
    expect(plan.bind.find(b => b.roomId === 'store_NAORU渋谷院').storeId).toBe('100');
    // 渋谷西院は Room が無いので新規作成予定になる
    expect(plan.create.map(c => c.storeId)).toContain('101');
  });
});

describe('chat-rooms: 店舗名変更', () => {
  it('店舗名が変わっても同じ Room を維持し、表示名だけ更新する', () => {
    const rooms = [{ id: 'store_NAORU渋谷院', kind: 'store', name: 'NAORU渋谷院', shop: 'NAORU渋谷院', storeId: '100', members: [] }];
    const shops = [{ id: '100', name: 'NAORU渋谷道玄坂院' }];
    const plan = planStoreRoomSync({ rooms, shops, staffs: [{ id: 's1', name: 'A', shop_id: '100' }], source: COMPLETE });
    expect(plan.rename).toEqual([{ roomId: 'store_NAORU渋谷院', from: 'NAORU渋谷院', to: 'NAORU渋谷道玄坂院', storeId: '100', apply: 'ready' }]);
    expect(plan.create).toEqual([]);      // 新しい Room を作らない＝過去ログが分断されない
    expect(plan.archive).toEqual([]);
  });
});

describe('chat-rooms: 同名店舗', () => {
  const SAME = [{ id: '300', name: 'NAORU本院' }, { id: '301', name: 'NAORU本院' }];
  it('同名の店舗が複数ある既存 Room は紐付けず要確認に出す', () => {
    const rooms = [{ id: 'store_NAORU本院', kind: 'store', name: 'NAORU本院', shop: 'NAORU本院', members: [] }];
    const plan = planStoreRoomSync({ rooms, shops: SAME, staffs: [] });
    expect(plan.bind).toEqual([]);
    const rv = plan.review.find(r => r.kind === 'room_bind');
    expect(rv.reason).toMatch(/同名の店舗が 2 件/);
    expect(rv.candidates.map(c => c.id)).toEqual(['300', '301']);
  });
  it('同名店舗の新規 Room は store_id 付きの別 ID で作り、既存 Room を横取りしない', () => {
    const plan = planStoreRoomSync({ rooms: [], shops: SAME, staffs: [] });
    expect(plan.create.map(c => c.roomId)).toEqual(['store_NAORU本院__300', 'store_NAORU本院__301']);
    expect(plan.review.filter(r => r.kind === 'room_create').length).toBe(2);
  });
  it('既存 Room ID と衝突する新規店舗は別 ID で作る', () => {
    const rooms = [{ id: 'store_NAORU渋谷院', kind: 'store', name: 'NAORU渋谷院', shop: 'NAORU渋谷院', storeId: '999', members: [] }];
    const shops = [{ id: '999', name: '旧店舗' }, { id: '100', name: 'NAORU渋谷院' }];
    const plan = planStoreRoomSync({ rooms, shops, staffs: [] });
    const created = plan.create.find(c => c.storeId === '100');
    expect(created.roomId).toBe('store_NAORU渋谷院__100');
  });
});

describe('chat-rooms: 所属メンバー（複数店舗・兼務・異動・退職）', () => {
  const bound = [
    { id: 'r100', kind: 'store', name: 'NAORU渋谷院', shop: 'NAORU渋谷院', storeId: '100', members: [], autoMembers: [] },
    { id: 'r200', kind: 'store', name: 'NAORU梅田院', shop: 'NAORU梅田院', storeId: '200', members: [], autoMembers: [] },
  ];
  it('在籍スタッフを自動所属に追加する', () => {
    const plan = planStoreRoomSync({ rooms: bound, shops: SHOPS, staffs: STAFFS });
    expect(plan.memberAdd.find(m => m.roomId === 'r100').staffIds).toEqual(['s1', 's2']);
    expect(plan.memberAdd.find(m => m.roomId === 'r200').staffIds).toEqual(['s3']);
  });
  it('複数店舗の権限（accessible_store_ids）を持つ人は全店舗ルームに入る', () => {
    const accounts = { s1: { storeIds: ['100', '200'] } };
    const plan = planStoreRoomSync({ rooms: bound, shops: SHOPS, staffs: STAFFS, accounts });
    expect(plan.memberAdd.find(m => m.roomId === 'r200').staffIds).toEqual(expect.arrayContaining(['s1', 's3']));
  });
  it('兼務は shop_ids（配列）でも表現できる', () => {
    expect(staffStoreIds({ id: 'x', shop_ids: ['100', '200'] })).toEqual(['100', '200']);
    expect(staffStoreIds({ id: 'x', shop_id: '100' })).toEqual(['100']);
    expect(staffStoreIds({ id: 'x', shop_id: '100' }, { x: { storeIds: ['200'] } })).toEqual(['200']);
  });
  it('本部メンバーは全店舗ルームに入る', () => {
    const plan = planStoreRoomSync({ rooms: bound, shops: SHOPS, staffs: STAFFS, hqMembers: ['hq1'] });
    expect(plan.memberAdd.every(m => m.staffIds.includes('hq1'))).toBe(true);
  });
  it('異動: 旧店舗から外し、新店舗へ入れる（自動所属のみ）', () => {
    const rooms = [
      { ...bound[0], members: ['s1'], autoMembers: ['s1'] },
      { ...bound[1], members: [], autoMembers: [] },
    ];
    const staffs = [{ id: 's1', name: 'A', shop_id: '200' }];   // 100 → 200 へ異動
    const plan = planStoreRoomSync({ rooms, shops: SHOPS, staffs, source: COMPLETE });
    expect(plan.memberRemove).toEqual([{ roomId: 'r100', storeId: '100', staffIds: ['s1'], reason: expect.any(String), apply: 'ready' }]);
    expect(plan.memberAdd.find(m => m.roomId === 'r200').staffIds).toEqual(['s1']);
  });
  it('退職: 自動所属から外れ、アクセス失効は別処理として記録される', () => {
    const rooms = [{ ...bound[0], members: ['s1', 's2'], autoMembers: ['s1', 's2'] }];
    const staffs = [{ id: 's1', name: 'A', shop_id: '100', deleted: true }, { id: 's2', name: 'B', shop_id: '100' }];
    const plan = planStoreRoomSync({ rooms, shops: [SHOPS[0]], staffs, source: COMPLETE });
    expect(plan.memberRemove[0].staffIds).toEqual(['s1']);
    expect(plan.accessNotes[0].staffIds).toEqual(['s1']);
    expect(plan.accessNotes[0].note).toMatch(/即時に失効/);
  });
  it('手動追加 / self-join のメンバーは自動削除しない', () => {
    // m1 は autoMembers に居ない＝人が手で入れた人
    const rooms = [{ ...bound[0], members: ['s1', 'm1'], autoMembers: ['s1'] }];
    const staffs = [{ id: 's1', name: 'A', shop_id: '100' }];
    const plan = planStoreRoomSync({ rooms, shops: [SHOPS[0]], staffs, source: COMPLETE });
    expect(plan.memberRemove).toEqual([]);
  });
  it('退職者が手動メンバーとして残る場合は削除せず要確認に出す', () => {
    const rooms = [{ ...bound[0], members: ['m1'], autoMembers: [] }];
    const staffs = [{ id: 'm1', name: 'M', shop_id: '100', deleted: true }];
    const plan = planStoreRoomSync({ rooms, shops: [SHOPS[0]], staffs, source: COMPLETE });
    expect(plan.memberRemove).toEqual([]);
    const rv = plan.review.find(r => r.kind === 'member_manual_retired');
    expect(rv.staffIds).toEqual(['m1']);
    expect(rv.reason).toMatch(/閲覧権限は authz 側で即時失効/);
  });
  it('名簿に居ないのに権限だけある ID は追加せず要確認に出す', () => {
    const accounts = { ghost: { storeIds: ['100'] } };
    const plan = planStoreRoomSync({ rooms: bound, shops: SHOPS, staffs: STAFFS, accounts });
    expect(plan.memberAdd.every(m => !m.staffIds.includes('ghost'))).toBe(true);
    expect(plan.review.some(r => r.kind === 'member' && r.subject === 'ghost')).toBe(true);
  });
});

describe('chat-rooms: 取得失敗・不完全な名簿', () => {
  it('店舗一覧が空なら中止（何もしない）', () => {
    const plan = planStoreRoomSync({ rooms: LEGACY_ROOMS, shops: [], staffs: STAFFS });
    expect(plan.aborted).toBe(true);
    expect(isNoop(plan)).toBe(true);
    expect(plan.problems.some(p => p.code === 'shops_empty')).toBe(true);
  });
  it('店舗一覧が不完全（ページ取得漏れ）なら中止', () => {
    const plan = planStoreRoomSync({ ...base(), source: { shopsComplete: false } });
    expect(plan.aborted).toBe(true);
    expect(isNoop(plan)).toBe(true);
  });
  it('店舗数が前回から急減したら中止（API障害の疑い）', () => {
    const plan = planStoreRoomSync({ ...base({ shops: [SHOPS[0]] }), previous: { shopCount: 10 } });
    expect(plan.aborted).toBe(true);
    expect(plan.problems.some(p => p.code === 'shops_shrunk')).toBe(true);
  });
  it('スタッフ名簿が空でも「全員退職扱い」にしない（追加のみ・削除は保留）', () => {
    const rooms = [{ id: 'r100', kind: 'store', name: 'NAORU渋谷院', shop: 'NAORU渋谷院', storeId: '100', members: ['s1', 's2'], autoMembers: ['s1', 's2'] }];
    const plan = planStoreRoomSync({ rooms, shops: [SHOPS[0]], staffs: [], source: { shopsComplete: true } });
    expect(plan.aborted).toBe(false);
    expect(readyItems(plan, 'memberRemove')).toEqual([]);          // 実行はしない
    expect(heldItems(plan).some(h => h.kind === 'memberRemove')).toBe(true);   // 保留として残る
  });
  it('スタッフ名簿が不完全なら削除を保留する', () => {
    const rooms = [{ id: 'r100', kind: 'store', name: 'NAORU渋谷院', shop: 'NAORU渋谷院', storeId: '100', members: ['s1'], autoMembers: ['s1'] }];
    const plan = planStoreRoomSync({ rooms, shops: [SHOPS[0]], staffs: [{ id: 's9', name: 'X', shop_id: '100' }], source: { shopsComplete: true, staffsComplete: false } });
    expect(readyItems(plan, 'memberRemove')).toEqual([]);
    expect(heldItems(plan).some(h => h.kind === 'memberRemove')).toBe(true);
  });
  it('1回の同期で削除しすぎる場合は保留する（上限）', () => {
    const many = Array.from({ length: 60 }, (_, i) => `x${i}`);
    const rooms = [{ id: 'r100', kind: 'store', name: 'NAORU渋谷院', shop: 'NAORU渋谷院', storeId: '100', members: many, autoMembers: many }];
    const staffs = [{ id: 'keep', name: 'K', shop_id: '100' }];
    const plan = planStoreRoomSync({ rooms, shops: [SHOPS[0]], staffs, source: COMPLETE });
    expect(readyItems(plan, 'memberRemove')).toEqual([]);
    expect(plan.problems.some(p => p.code === 'remove_cap')).toBe(true);
    expect(DEFAULT_LIMITS.maxRemovePerRun).toBe(50);
  });
  it('通常の異動・退職（少人数の削除）は上限に引っかからない', () => {
    const many = Array.from({ length: 30 }, (_, i) => `x${i}`);
    const rooms = [{ id: 'r100', kind: 'store', name: 'NAORU渋谷院', shop: 'NAORU渋谷院', storeId: '100', members: many, autoMembers: many }];
    const staffs = many.slice(0, 27).map(id => ({ id, name: id, shop_id: '100' }));   // 3人だけ抜ける
    const plan = planStoreRoomSync({ rooms, shops: [SHOPS[0]], staffs, source: COMPLETE });
    expect(readyItems(plan, 'memberRemove')[0].staffIds.length).toBe(3);
    expect(plan.problems.some(p => p.code === 'remove_cap')).toBe(false);
  });
  it('母集団が十分ある中で比率を超える削除は保留する', () => {
    const many = Array.from({ length: 30 }, (_, i) => `x${i}`);
    const rooms = [{ id: 'r100', kind: 'store', name: 'NAORU渋谷院', shop: 'NAORU渋谷院', storeId: '100', members: many, autoMembers: many }];
    const staffs = many.slice(0, 15).map(id => ({ id, name: id, shop_id: '100' }));   // 15人（50%）が消える
    const plan = planStoreRoomSync({ rooms, shops: [SHOPS[0]], staffs, source: COMPLETE });
    expect(readyItems(plan, 'memberRemove')).toEqual([]);
    expect(plan.problems.some(p => p.code === 'remove_cap')).toBe(true);
  });
  it('checkSourceHealth 単体: 正常なら削除を許可', () => {
    const h = checkSourceHealth({ shops: SHOPS, staffs: STAFFS, source: COMPLETE });
    expect(h.abort).toBe(false);
    expect(h.allowRemove).toBe(true);
    expect(h.allowArchive).toBe(true);
  });
  it('SalonOne に無い店舗の Room は削除せず archive 候補にする', () => {
    const rooms = [{ id: 'r900', kind: 'store', name: '閉店A', shop: '閉店A', storeId: '900', members: [] }];
    const plan = planStoreRoomSync({ rooms, shops: SHOPS, staffs: STAFFS, source: COMPLETE });
    expect(plan.archive).toEqual([{ roomId: 'r900', storeId: '900', reason: expect.stringMatching(/store_id=900 が存在しない/), apply: 'ready' }]);
  });
});

describe('chat-rooms: 冪等性（同じ同期を繰り返しても重複しない）', () => {
  it('1回目の plan を適用すると 2回目は差分ゼロ', () => {
    const input = base();
    const plan1 = planStoreRoomSync(input);
    expect(isNoop(plan1)).toBe(false);
    const rooms2 = applyPlanForTest(input.rooms, plan1);
    const plan2 = planStoreRoomSync({ ...input, rooms: rooms2 });
    expect(isNoop(plan2)).toBe(true);
    const rooms3 = applyPlanForTest(rooms2, plan2);
    expect(rooms3.length).toBe(rooms2.length);        // Room が増えない
  });
  it('Room が無い状態から2回同期しても Room が重複しない', () => {
    const input = { rooms: [], shops: SHOPS, staffs: STAFFS };
    const rooms2 = applyPlanForTest([], planStoreRoomSync(input));
    const plan2 = planStoreRoomSync({ ...input, rooms: rooms2 });
    expect(isNoop(plan2)).toBe(true);
    expect(rooms2.filter(r => r.storeId === '100').length).toBe(1);
  });
  it('イベントの同期も2回目は差分ゼロ', () => {
    const rooms = [{ id: 'g1', kind: 'group', name: '9月勉強会', members: [], autoMembers: [] }];
    const events = [{ id: 'e1', cells: { eventId: 'e1', roomId: 'g1', chatTitle: '9月勉強会', ownerId: 's1', participantIds: ['s2'] } }];
    const p1 = planEventRoomSync({ rooms, events, staffs: STAFFS });
    const rooms2 = applyPlanForTest(rooms, p1);
    expect(isNoop(planEventRoomSync({ rooms: rooms2, events, staffs: STAFFS }))).toBe(true);
  });
});

describe('chat-rooms: イベント Room（既存の evSaveChat / evJoinChat を前提）', () => {
  const events = [{ id: 'e1', cells: { eventId: 'e1', roomId: 'g1', chatTitle: '9月勉強会', ownerId: 's1', participantIds: ['s2', 's3'] } }];
  it('責任者と参加者を追加し、eventId を後付けする（kind は group のまま）', () => {
    const rooms = [{ id: 'g1', kind: 'group', name: '9月勉強会', members: ['s1'], autoMembers: ['s1'] }];
    const plan = planEventRoomSync({ rooms, events, staffs: STAFFS, source: COMPLETE });
    expect(plan.bind).toEqual([{ roomId: 'g1', eventId: 'e1', matchedBy: 'event_row', name: '9月勉強会', apply: 'ready' }]);
    expect(plan.memberAdd[0].staffIds).toEqual(['s2', 's3']);
    expect(plan.create).toEqual([]);
  });
  it('self-join で入った人は参加者リストに無くても自動削除しない', () => {
    const rooms = [{ id: 'g1', kind: 'group', name: '9月勉強会', members: ['s1', 's2', 's3', 'joined'], autoMembers: ['s1', 's2', 's3', 'joined'] }];
    const plan = planEventRoomSync({ rooms, events, staffs: [...STAFFS, { id: 'joined', name: 'J', shop_id: '100' }] });
    expect(plan.memberRemove).toEqual([]);
    expect(plan.review.some(r => r.kind === 'event_member_remove' && r.staffIds.includes('joined'))).toBe(true);
  });
  it('roomId が無い行は作成予定に出す（グループ名が空なら要確認）', () => {
    const plan = planEventRoomSync({ rooms: [], events: [{ id: 'e2', cells: { chatTitle: 'BBQ', ownerId: 's1' } }, { id: 'e3', cells: {} }], staffs: STAFFS });
    expect(plan.create[0]).toMatchObject({ kind: 'group', name: 'BBQ', eventId: 'e2', members: ['s1'] });
    expect(plan.review.some(r => r.kind === 'event_room' && /chatTitle/.test(r.reason))).toBe(true);
  });
  it('存在しない roomId は要確認（新しい Room を勝手に作らない）', () => {
    const plan = planEventRoomSync({ rooms: [], events, staffs: STAFFS });
    expect(plan.create).toEqual([]);
    expect(plan.review.some(r => /roomId=g1 の Room が存在しない/.test(r.reason))).toBe(true);
  });
  it('名簿に無い参加者IDは追加しない', () => {
    const rooms = [{ id: 'g1', kind: 'group', name: '9月勉強会', members: [], autoMembers: [] }];
    const ev = [{ id: 'e1', cells: { roomId: 'g1', chatTitle: '9月勉強会', ownerId: 's1', participantIds: ['ghost'] } }];
    const plan = planEventRoomSync({ rooms, events: ev, staffs: STAFFS, source: COMPLETE });
    expect(plan.memberAdd[0].staffIds).toEqual(['s1']);
    expect(plan.review.some(r => r.kind === 'event_member_held' && r.staffIds.includes('ghost'))).toBe(true);
  });
  it('autoCloseDays 指定時のみ、終了後の Room を archive 候補にする', () => {
    const rooms = [{ id: 'g1', kind: 'group', name: '9月勉強会', members: [], status: 'active' }];
    const ev = [{ id: 'e1', cells: { roomId: 'g1', chatTitle: '9月勉強会', date: '2026-01-01', ownerId: 's1' } }];
    const now = Date.parse('2026-06-01');
    expect(planEventRoomSync({ rooms, events: ev, staffs: STAFFS, now }).archive).toEqual([]);
    expect(planEventRoomSync({ rooms, events: ev, staffs: STAFFS, now, autoCloseDays: 30 }).archive.length).toBe(1);
  });
});

describe('chat-rooms: planChatSync / summarizePlan', () => {
  it('店舗とイベントの差分をまとめて返す', () => {
    const events = [{ id: 'e1', cells: { roomId: 'g1', chatTitle: '勉強会', ownerId: 's1' } }];
    const rooms = [...LEGACY_ROOMS, { id: 'g1', kind: 'group', name: '勉強会', members: [], autoMembers: [] }];
    const plan = planChatSync({ rooms, shops: SHOPS, staffs: STAFFS, events });
    // 店舗2件 + イベント行の eventId 後付け1件
    expect(plan.bind.filter(b => b.storeId).length).toBe(2);
    expect(plan.bind.filter(b => b.eventId).length).toBe(1);
    expect(plan.bind.length).toBe(3);
    expect(plan.memberAdd.length).toBeGreaterThan(0);
    const s = summarizePlan(plan);
    expect(s.aborted).toBe(false);
    expect(s.bindIds).toBe(3);
  });
  it('中止時はイベント側も含めて何も出さない', () => {
    const plan = planChatSync({ rooms: LEGACY_ROOMS, shops: [], staffs: STAFFS, events: [] });
    expect(plan.aborted).toBe(true);
    expect(isNoop(plan)).toBe(true);
    expect(summarizePlan(plan).noop).toBe(true);
  });
  it('indexShopsByName は同名店舗をまとめて返す', () => {
    const m = indexShopsByName([{ id: '1', name: 'A院' }, { id: '2', name: 'A院' }, { id: '3', name: 'B院' }]);
    expect(m.get('a院').length).toBe(2);
    expect(m.get('b院').length).toBe(1);
  });
});

// ── #385 追加確認（A〜E）─────────────────────────────────────────────────
describe('chat-rooms A: 店舗権限の空配列は「確認済み」として扱う', () => {
  const room100 = { id: 'r100', kind: 'store', name: 'NAORU渋谷院', shop: 'NAORU渋谷院', storeId: '100', members: ['s1'], autoMembers: ['s1'] };
  const staff = { id: 's1', name: 'A', shop_id: '100' };

  it('confirmed な空配列は名簿へ戻さない（所属候補を復活させない）', () => {
    const sc = staffStoreScope(staff, { s1: { storeIds: [] } });
    expect(sc).toEqual({ storeIds: [], source: 'account', authoritative: true });
    const plan = planStoreRoomSync({ rooms: [room100], shops: [SHOPS[0]], staffs: [staff], accounts: { s1: { storeIds: [] } }, source: COMPLETE });
    expect(readyItems(plan, 'memberRemove')[0].staffIds).toEqual(['s1']);   // アクセス無し＝所属から外す
    expect(plan.memberAdd).toEqual([]);
  });

  it('項目欠落（storeIds が無い）は未取得として名簿へフォールバックする', () => {
    const sc = staffStoreScope(staff, { s1: { note: 'メモだけ' } });
    expect(sc.storeIds).toEqual(['100']);
    expect(sc.source).toBe('roster');
    expect(sc.authoritative).toBe(false);
    const plan = planStoreRoomSync({ rooms: [room100], shops: [SHOPS[0]], staffs: [staff], accounts: { s1: {} }, source: COMPLETE });
    expect(readyItems(plan, 'memberRemove')).toEqual([]);                   // 消さない
    expect(plan.review.some(r => r.kind === 'member_scope_unknown')).toBe(true);
  });

  it('complete:false の空配列は「未取得」なので名簿へフォールバックする', () => {
    const sc = staffStoreScope(staff, { s1: { storeIds: [], complete: false } });
    expect(sc.storeIds).toEqual(['100']);
    expect(sc.authoritative).toBe(false);
  });

  it('accounts が無い場合は従来どおり名簿を使う（後方互換）', () => {
    expect(staffStoreScope(staff, {}).storeIds).toEqual(['100']);
    expect(staffStoreScope({ id: 'x', shop_ids: ['1', '2'] }, {}).storeIds).toEqual(['1', '2']);
    expect(staffStoreScope({ id: 'x' }, {}).storeIds).toEqual([]);
  });
});

describe('chat-rooms B: イベントの名簿が空・不完全でも参加者を全部有効にしない', () => {
  const rooms = [{ id: 'g1', kind: 'group', name: '勉強会', members: [], autoMembers: [] }];
  const events = [{ id: 'e1', cells: { eventId: 'e1', roomId: 'g1', chatTitle: '勉強会', ownerId: 's1', participantIds: ['s2'] } }];

  it('名簿0件なら追加せず保留する', () => {
    const plan = planEventRoomSync({ rooms, events, staffs: [], source: { staffsComplete: true } });
    expect(plan.memberAdd).toEqual([]);
    const held = plan.review.find(r => r.kind === 'event_member_held');
    expect(held.staffIds).toEqual(['s1', 's2']);
    expect(held.reason).toMatch(/確認できない/);
  });

  it('名簿が不完全なら、確認できた人だけ追加し残りは保留する', () => {
    const plan = planEventRoomSync({ rooms, events, staffs: [{ id: 's1', name: 'A' }], source: { staffsComplete: false } });
    expect(plan.memberAdd[0].staffIds).toEqual(['s1']);
    expect(plan.review.find(r => r.kind === 'event_member_held').staffIds).toEqual(['s2']);
  });

  it('参加者を1人も確認できない新規 Room は作成そのものを保留する', () => {
    const plan = planEventRoomSync({ rooms: [], events: [{ id: 'e2', cells: { chatTitle: 'BBQ', ownerId: 'unknown' } }], staffs: [{ id: 's1', name: 'A' }] });
    expect(plan.create[0].apply).toBe(APPLY_HOLD);
    expect(readyItems(plan, 'create')).toEqual([]);
  });
});

describe('chat-rooms C: 完全性フラグ未指定を「全件取得済み」と推定しない', () => {
  const rooms = [
    { id: 'r100', kind: 'store', name: 'NAORU渋谷院', shop: 'NAORU渋谷院', storeId: '100', members: ['s1', 'gone'], autoMembers: ['s1', 'gone'] },
    { id: 'r900', kind: 'store', name: '閉店A', shop: '閉店A', storeId: '900', members: [] },
  ];
  const staffs = [{ id: 's1', name: 'A', shop_id: '100' }];

  it('未指定なら削除・アーカイブを保留する（追加・紐付けは行う）', () => {
    const plan = planStoreRoomSync({ rooms, shops: [SHOPS[0]], staffs });
    expect(plan.problems.map(p => p.code)).toEqual(expect.arrayContaining(['shops_completeness_unknown', 'staffs_completeness_unknown']));
    expect(readyItems(plan, 'memberRemove')).toEqual([]);
    expect(readyItems(plan, 'archive')).toEqual([]);
    expect(plan.archive[0].apply).toBe(APPLY_HOLD);
    expect(plan.stats.allowRemove).toBe(false);
    expect(plan.stats.allowArchive).toBe(false);
  });

  it('true を明示したときだけ削除・アーカイブが実行候補になる', () => {
    const plan = planStoreRoomSync({ rooms, shops: [SHOPS[0]], staffs, source: COMPLETE });
    expect(readyItems(plan, 'memberRemove')[0].staffIds).toEqual(['gone']);
    expect(readyItems(plan, 'archive')[0].roomId).toBe('r900');
  });
});

describe('chat-rooms D: 要確認と実行候補を混ぜない', () => {
  const SAME = [{ id: '300', name: 'NAORU本院' }, { id: '301', name: 'NAORU本院' }];

  it('同名店舗の作成候補は hold になり、実行候補には出ない', () => {
    const plan = planStoreRoomSync({ rooms: [], shops: SAME, staffs: [], source: COMPLETE });
    expect(plan.create.every(c => c.apply === APPLY_HOLD)).toBe(true);
    expect(readyItems(plan, 'create')).toEqual([]);
    expect(heldItems(plan).map(h => h.holdReason)).toEqual(['same_name_shops', 'same_name_shops']);
    expect(isNoop(plan)).toBe(true);                       // 実行予定はゼロ
  });

  it('applyPlanForTest は hold を適用しない', () => {
    const plan = planStoreRoomSync({ rooms: [], shops: SAME, staffs: [], source: COMPLETE });
    expect(applyPlanForTest([], plan)).toEqual([]);         // Room は1つも作られない
  });

  it('要確認になった Room のメンバーは計算対象にしない', () => {
    const rooms = [{ id: 'store_NAORU本院', kind: 'store', name: 'NAORU本院', shop: 'NAORU本院', members: [], autoMembers: [] }];
    const plan = planStoreRoomSync({ rooms, shops: SAME, staffs: [{ id: 's1', name: 'A', shop_id: '300' }], source: COMPLETE });
    expect(plan.memberAdd).toEqual([]);
    expect(plan.review.some(r => r.kind === 'room_bind')).toBe(true);
  });

  it('summarizePlan は実行候補と保留を分けて数える', () => {
    const plan = planStoreRoomSync({ rooms: [], shops: SAME, staffs: [], source: COMPLETE });
    const s = summarizePlan(plan);
    expect(s.createRooms).toBe(0);
    expect(s.heldItems).toBe(2);
  });
});

describe('chat-rooms E: tenant と取得範囲', () => {
  it('別 tenant の Room・店舗・スタッフを同じ plan に混ぜない', () => {
    const rooms = [
      { id: 'r100', kind: 'store', name: 'A院', shop: 'A院', storeId: '100', members: [], autoMembers: [], tenantId: 'naoru' },
      { id: 'rX', kind: 'store', name: 'X院', shop: 'X院', storeId: '900', members: [], autoMembers: [], tenantId: 'other' },
    ];
    const shops = [{ id: '100', name: 'A院', tenantId: 'naoru' }, { id: '900', name: 'X院', tenantId: 'other' }];
    const staffs = [{ id: 's1', name: 'A', shop_id: '100', tenantId: 'naoru' }, { id: 'x1', name: 'X', shop_id: '900', tenantId: 'other' }];
    const plan = planStoreRoomSync({ rooms, shops, staffs, tenantId: 'naoru', source: COMPLETE });

    expect(plan.tenantId).toBe('naoru');
    expect(plan.stats.excludedByTenant).toEqual({ rooms: 1, shops: 1, staffs: 1 });
    expect(plan.memberAdd.map(m => m.roomId)).toEqual(['r100']);
    expect(plan.memberAdd[0].staffIds).toEqual(['s1']);        // 他テナントのスタッフは入らない
    expect(plan.archive).toEqual([]);                          // 他テナントの Room を閉店扱いしない
    expect(plan.create).toEqual([]);                           // 他テナントの店舗の Room を作らない
  });

  it('取得対象外（scope 外）の店舗が一覧に無くても閉店と解釈しない', () => {
    const rooms = [
      { id: 'r100', kind: 'store', name: 'A院', shop: 'A院', storeId: '100', members: [], autoMembers: [] },
      { id: 'r200', kind: 'store', name: 'B院', shop: 'B院', storeId: '200', members: [], autoMembers: [] },
    ];
    // 今回は store 100 だけを対象に取得した
    const plan = planStoreRoomSync({ rooms, shops: [{ id: '100', name: 'A院' }], staffs: [], scope: { storeIds: ['100'] }, source: COMPLETE });
    expect(readyItems(plan, 'archive')).toEqual([]);
    const held = plan.archive.find(a => a.roomId === 'r200');
    expect(held.apply).toBe(APPLY_HOLD);
    expect(held.holdReason).toBe('out_of_scope');
  });

  it('scope 外の店舗の Room は新規作成しない', () => {
    const plan = planStoreRoomSync({ rooms: [], shops: [{ id: '100', name: 'A院' }, { id: '200', name: 'B院' }], staffs: [], scope: { storeIds: ['100'] }, source: COMPLETE });
    expect(plan.create.map(c => c.storeId)).toEqual(['100']);
  });

  it('tenantId 未指定のレコードは対象テナントとして扱う（既存データ互換）', () => {
    const plan = planStoreRoomSync({ rooms: LEGACY_ROOMS, shops: SHOPS, staffs: STAFFS, tenantId: 'naoru', source: COMPLETE });
    expect(plan.stats.excludedByTenant).toEqual({ rooms: 0, shops: 0, staffs: 0 });
    expect(readyItems(plan, 'bind').length).toBe(2);
  });
});
