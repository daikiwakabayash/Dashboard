import { describe, it, expect } from 'vitest';
import { makeActor, agentActor } from '../lib/actor.js';
import {
  CHAT_POLICY_VERSION, can, capabilities, roomInStoreScope, isRoomMember,
  canViewRoom, canPostRoom, canManageRoom, canDeleteRoom, canCreateRoom, canInviteMember,
  filterRooms, filterRecipients, isSendAction, authorizeChatAction,
} from '../lib/chat-policy.js';

// 検証済み SalonOne actor を作るヘルパ
const A = (role, opts = {}) => makeActor({
  staff_id: opts.id || 'u1', role,
  accessible_store_ids: opts.storeIds || [],
  store_names: opts.names || [],
  source: opts.source || 'salonone', verified: opts.verified !== false,
  tenant_id: opts.tenantId,
});
const ROLLOUT_ALL = { root: true, hq: true, owner: true, manager: true, staff: true };

const announce = { id: 'announce_all', kind: 'announce' };
const storeA = { id: 'store_s_100', kind: 'store', storeId: '100', name: 'A院', shop: 'A院', members: [] };
const storeB = { id: 'store_s_200', kind: 'store', storeId: '200', name: 'B院', shop: 'B院', members: [] };
const legacyStore = { id: 'store_A院', kind: 'store', name: 'A院', shop: 'A院', members: [] };  // storeId 無し（既存データ）
const group = { id: 'g1', kind: 'group', members: ['u1', 'u2'], createdBy: 'u1' };
const evRoom = { id: 'g2', kind: 'group', icon: '📅', members: ['u2'], createdBy: 'u2' };       // 既存のイベントグループ
const dm = { id: 'd1', kind: 'dm', members: ['u2', 'u3'] };

describe('chat-policy: capability', () => {
  it('バージョンが定義されている', () => expect(CHAT_POLICY_VERSION).toBe('chat-policy-1'));
  it('全ロールが chat.view を持つ', () => {
    ['root', 'hq', 'owner', 'manager', 'staff'].forEach(r => expect(can(A(r), 'chat.view')).toBe(true));
  });
  it('broadcast.all は root/hq のみ・broadcast.store は staff 以外', () => {
    expect(can(A('root'), 'broadcast.all')).toBe(true);
    expect(can(A('owner'), 'broadcast.all')).toBe(false);
    expect(can(A('manager'), 'broadcast.store')).toBe(true);
    expect(can(A('staff'), 'broadcast.store')).toBe(false);
  });
  it('staff は AI 回答の修正ができない', () => {
    expect(can(A('staff'), 'ai.feedback')).toBe(true);
    expect(can(A('staff'), 'ai.feedback.fix')).toBe(false);
  });
  it('hq は root と同じ capability', () => {
    expect(capabilities(A('hq'))).toEqual(capabilities(A('root')));
  });
});

describe('chat-policy: AI Agent は人間を超えない', () => {
  it('agent は送信・作成・管理ができない', () => {
    const ai = agentActor(A('root'));
    expect(can(ai, 'recipient.resolve')).toBe(true);
    expect(can(ai, 'broadcast.all')).toBe(false);
    expect(can(ai, 'room.create.group')).toBe(false);
    expect(canPostRoom(ai, storeA)).toBe(false);
    expect(canManageRoom(ai, group)).toBe(false);
  });
  it('acting_for の無い agent は何もできない', () => {
    const orphan = makeActor({ staff_id: '__ai__', role: 'agent' });
    expect(can(orphan, 'chat.view')).toBe(false);
  });
});

describe('chat-policy: Room 可視（store_id が正・名前はフォールバック）', () => {
  it('全社アナウンスは全員閲覧・投稿は root/hq のみ', () => {
    expect(canViewRoom(A('staff'), announce)).toBe(true);
    expect(canPostRoom(A('root'), announce)).toBe(true);
    expect(canPostRoom(A('owner'), announce)).toBe(false);
  });
  it('複数店舗ユーザーは担当店舗すべての Store Room を使える', () => {
    const owner = A('owner', { storeIds: ['100', '200'] });
    expect(canViewRoom(owner, storeA)).toBe(true);
    expect(canViewRoom(owner, storeB)).toBe(true);
    expect(canPostRoom(owner, storeB)).toBe(true);
  });
  it('1店舗ユーザーは他店の Store Room を見られない', () => {
    const s = A('staff', { storeIds: ['100'] });
    expect(canViewRoom(s, storeA)).toBe(true);
    expect(canViewRoom(s, storeB)).toBe(false);
  });
  it('storeId が無い既存ルームは店舗名で判定（移行期の互換）', () => {
    const s = A('staff', { storeIds: ['100'], names: ['A院'] });
    expect(roomInStoreScope(s, legacyStore)).toBe(true);
    expect(canViewRoom(s, legacyStore)).toBe(true);
    expect(canViewRoom(A('staff', { names: ['B院'] }), legacyStore)).toBe(false);
  });
  it('root/hq は全店舗ルームが見える', () => {
    expect(canViewRoom(A('root'), storeB)).toBe(true);
    expect(canViewRoom(A('hq'), storeB)).toBe(true);
  });
  it('DM は root/hq でも非メンバーは不可（既存のプライバシー挙動）', () => {
    expect(canViewRoom(A('root', { id: 'r1' }), dm)).toBe(false);
    expect(canViewRoom(A('staff', { id: 'u3' }), dm)).toBe(true);
  });
  it('既存のイベントグループ（kind=group）はメンバーのみ・root は見える', () => {
    expect(canViewRoom(A('staff', { id: 'u2' }), evRoom)).toBe(true);
    expect(canViewRoom(A('staff', { id: 'u9' }), evRoom)).toBe(false);
    expect(canViewRoom(A('root', { id: 'r1' }), evRoom)).toBe(true);
  });
  it('archived は閲覧のみ', () => {
    const arch = { ...storeA, status: 'archived' };
    const s = A('staff', { storeIds: ['100'] });
    expect(canViewRoom(s, arch)).toBe(true);
    expect(canPostRoom(s, arch)).toBe(false);
  });
  it('テナント違いは存在しない扱い', () => {
    const a = A('root', { tenantId: 'tA' });
    expect(canViewRoom(a, { ...storeA, tenantId: 'tB' })).toBe(false);
    expect(filterRooms(a, [{ ...storeA, tenantId: 'tB' }])).toEqual([]);
  });
  it('isRoomMember は user_id / staff_id のどちらでも本人と判定', () => {
    const a = makeActor({ user_id: '7', staff_id: '9', role: 'staff', verified: true });
    expect(isRoomMember({ members: ['7'] }, a)).toBe(true);
    expect(isRoomMember({ members: ['9'] }, a)).toBe(true);
    expect(isRoomMember({ members: ['8'] }, a)).toBe(false);
  });
});

describe('chat-policy: 管理・作成・招待', () => {
  it('group は作成者・管理者・テナント管理者が管理できる', () => {
    expect(canManageRoom(A('staff', { id: 'u1' }), group)).toBe(true);
    expect(canManageRoom(A('staff', { id: 'u2' }), group)).toBe(false);
    expect(canManageRoom(A('root', { id: 'r1' }), group)).toBe(true);
  });
  it('announce / store は削除できない', () => {
    expect(canDeleteRoom(A('root'), announce)).toBe(false);
    expect(canDeleteRoom(A('root'), storeA)).toBe(false);
  });
  it('staff はスコープ外のスタッフを含む Group を作れない', () => {
    const roster = [{ id: 'u2', shop_id: '100' }, { id: 'u5', shop_id: '200' }];
    const me = A('staff', { id: 'u1', storeIds: ['100'] });
    expect(canCreateRoom(me, { kind: 'group', members: ['u1', 'u2'] }, roster)).toBe(true);
    expect(canCreateRoom(me, { kind: 'group', members: ['u1', 'u5'] }, roster)).toBe(false);
    expect(canCreateRoom(me, { kind: 'dm', members: ['u1', 'unknown'] }, roster)).toBe(false);
  });
  it('招待できるのは権限範囲内のスタッフのみ', () => {
    const roster = [{ id: 'u2', shop_id: '100' }, { id: 'u5', shop_id: '200' }];
    const me = A('staff', { id: 'u1', storeIds: ['100'] });
    expect(canInviteMember(me, group, 'u2', roster)).toBe(true);
    expect(canInviteMember(me, group, 'u5', roster)).toBe(false);
    expect(canInviteMember(A('root'), group, 'u5', roster)).toBe(true);
  });
});

describe('chat-policy: Recipient フィルタ（最終防衛線）', () => {
  const rooms = [storeA, storeB];
  const roster = [{ id: 's1', shop_id: '100' }, { id: 's2', shop_id: '200' }];
  it('権限外の店舗・スタッフ・Room を denied に落とす', () => {
    const me = A('manager', { storeIds: ['100'] });
    const out = filterRecipients(me, { sendType: 'multiple_groups', storeIds: ['100', '200'], staffIds: ['s1', 's2'], roomIds: ['store_s_100', 'store_s_200'] }, { rooms, knownStaff: roster });
    expect(out.storeIds).toEqual(['100']);
    expect(out.staffIds).toEqual(['s1']);
    expect(out.roomIds).toEqual(['store_s_100']);
    expect(out.denyReason).toBe('out_of_scope');
  });
  it('複数店舗ユーザーは担当店舗すべてに送れる', () => {
    const owner = A('owner', { storeIds: ['100', '200'] });
    const out = filterRecipients(owner, { sendType: 'multiple_groups', storeIds: ['100', '200'] }, { rooms, knownStaff: roster });
    expect(out.storeIds).toEqual(['100', '200']);
    expect(out.denied).toBe(false);
  });
  it('broadcast.all が無い actor の全社送信は縮小せず deny', () => {
    const out = filterRecipients(A('owner', { storeIds: ['100'] }), { sendType: 'broadcast', storeIds: ['100'] }, { rooms, knownStaff: roster });
    expect(out.storeIds).toEqual([]);
    expect(out.denyReason).toBe('broadcast_forbidden');
  });
  it('存在しない Room は拒否', () => {
    const out = filterRecipients(A('root'), { sendType: 'multiple_groups', roomIds: ['ghost'] }, { rooms });
    expect(out.roomIds).toEqual([]);
  });
  it('AI が代理でも人間の範囲を超えない', () => {
    const ai = agentActor(A('staff', { storeIds: ['100'] }));
    const out = filterRecipients(ai, { sendType: 'multiple_groups', storeIds: ['100', '200'] }, { rooms, knownStaff: roster });
    expect(out.storeIds).toEqual(['100']);
  });
});

describe('chat-policy: authorizeChatAction', () => {
  const staff100 = A('staff', { id: 'u1', storeIds: ['100'] });
  it('自店舗へは送信できる / 他店舗へはできない', () => {
    expect(authorizeChatAction(staff100, 'send', { room: storeA, rollout: ROLLOUT_ALL }).allow).toBe(true);
    expect(authorizeChatAction(staff100, 'send', { room: storeB, rollout: ROLLOUT_ALL }).reason).toBe('room_not_visible');
  });
  it('Rollout が OFF のロールはサーバー側でも拒否される', () => {
    expect(authorizeChatAction(staff100, 'read', { room: storeA, rollout: { root: true, hq: true } }).reason).toBe('chat_rollout_disabled');
    expect(authorizeChatAction(A('root'), 'read', { room: storeA, rollout: { root: true, hq: true } }).allow).toBe(true);
    expect(authorizeChatAction(A('hq'), 'send', { room: storeA, rollout: { root: true, hq: true } }).allow).toBe(true);
  });
  it('未検証セッションは Rollout ゲートで落ちる', () => {
    const unverified = makeActor({ staff_id: 'x', role: 'root' });
    expect(authorizeChatAction(unverified, 'read', { room: storeA, rollout: { root: true } }).reason).toBe('chat_rollout_disabled');
  });
  it('Kill Switch は送信系のみ止める', () => {
    const env = { CHAT_KILL_SWITCH: '1' };
    expect(authorizeChatAction(staff100, 'send', { room: storeA, env, rollout: ROLLOUT_ALL }).reason).toBe('kill_switch');
    expect(authorizeChatAction(staff100, 'read', { room: storeA, env, rollout: ROLLOUT_ALL }).allow).toBe(true);
  });
  it('運用操作（ensureRooms / setRollout / remapUser）は root/hq のみ', () => {
    expect(authorizeChatAction(A('root'), 'ensureRooms', { rollout: ROLLOUT_ALL }).allow).toBe(true);
    expect(authorizeChatAction(A('root'), 'setRollout', { rollout: ROLLOUT_ALL }).allow).toBe(true);
    expect(authorizeChatAction(staff100, 'ensureRooms', { rollout: ROLLOUT_ALL }).reason).toBe('admin_only');
    expect(authorizeChatAction(staff100, 'setRollout', { rollout: ROLLOUT_ALL }).reason).toBe('admin_only');
  });
  it('スコープ外のスタッフを招待しようとすると拒否', () => {
    const roster = [{ id: 'u5', shop_id: '200' }];
    const me = A('staff', { id: 'u1', storeIds: ['100'] });
    const r = authorizeChatAction(me, 'setMembers', { room: group, addMembers: ['u5'], knownStaff: roster, rollout: ROLLOUT_ALL });
    expect(r.reason).toBe('invite_out_of_scope');
  });
  it('自分の投稿は削除できる / 他人のものは管理者のみ', () => {
    expect(authorizeChatAction(staff100, 'deleteMsg', { room: storeA, message: { fromStaffId: 'u1' }, rollout: ROLLOUT_ALL }).allow).toBe(true);
    expect(authorizeChatAction(staff100, 'deleteMsg', { room: storeA, message: { fromStaffId: 'u2' }, rollout: ROLLOUT_ALL }).reason).toBe('not_owner');
    expect(authorizeChatAction(A('root'), 'deleteMsg', { room: storeA, message: { fromStaffId: 'u2' }, rollout: ROLLOUT_ALL }).allow).toBe(true);
  });
  it('message コンテキスト無しの削除はルーム単位で判定（所有者判定は呼び出し側）', () => {
    expect(authorizeChatAction(staff100, 'deleteMsg', { room: storeA, rollout: ROLLOUT_ALL }).allow).toBe(true);
  });
  it('未知の action は拒否（fail-closed）', () => {
    expect(authorizeChatAction(A('root'), 'somethingNew', { rollout: ROLLOUT_ALL }).reason).toBe('unknown_action');
  });
  it('送信系 action を識別する', () => {
    expect(isSendAction('send')).toBe(true);
    expect(isSendAction('read')).toBe(false);
  });
});
