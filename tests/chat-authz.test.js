import { describe, it, expect } from 'vitest';
import {
  CHAT_AUTHZ_VERSION, DEFAULT_TENANT_ID, ROLES,
  normalizeRole, makeActor, agentActor, isTenantAdmin, sameTenant, sameActor,
  can, capabilities, roomInStoreScope, canViewRoom, canPostRoom, canManageRoom,
  canDeleteRoom, canCreateRoom, staffInScope, filterRooms, filterRecipients,
  enforcementMode, killSwitchOn, isSendAction, authorizeChatAction,
} from '../lib/chat-authz.js';

// テスト用の actor ヘルパ（storeIds が正・shopNames は移行期のフォールバック）
const A = (role, opts = {}) => makeActor({ actorId: opts.id || 'u1', role, storeIds: opts.storeIds || [], shopNames: opts.shopNames || [], tenantId: opts.tenantId, verified: opts.verified !== false });

const announce = { id: 'announce_all', kind: 'announce' };
const storeA = { id: 'store_s_100', kind: 'store', storeId: '100', name: 'A院', shop: 'A院', members: [] };
const storeB = { id: 'store_s_200', kind: 'store', storeId: '200', name: 'B院', shop: 'B院', members: [] };
const legacyStore = { id: 'store_A院', kind: 'store', name: 'A院', shop: 'A院', members: [] };
const group = { id: 'g1', kind: 'group', members: ['u1', 'u2'], createdBy: 'u1' };
const dm = { id: 'd1', kind: 'dm', members: ['u2', 'u3'] };
const event = { id: 'event_e1', kind: 'event', eventId: 'e1', members: ['u2'], createdBy: 'u2' };

describe('chat-authz: 基本', () => {
  it('バージョンとロール一覧が定義されている', () => {
    expect(CHAT_AUTHZ_VERSION).toBe('chat-authz-1');
    expect(ROLES).toEqual(expect.arrayContaining(['root', 'hq', 'owner', 'manager', 'staff', 'agent']));
  });
  it('SalonOne のロール名を写像する', () => {
    expect(normalizeRole('brand_admin')).toBe('root');
    expect(normalizeRole('shop_admin')).toBe('owner');
    expect(normalizeRole('shop_staff')).toBe('staff');
  });
  it('role 未指定でも root フラグがあれば root（既存クライアント互換）', () => {
    expect(normalizeRole('', { root: true })).toBe('root');
    expect(makeActor({ root: true }).role).toBe('root');
    expect(makeActor({}).role).toBe('staff');   // 既定は最小権限
  });
  it('hq は root と同じ capability を持ちつつ role は hq のまま', () => {
    const hq = A('hq');
    expect(isTenantAdmin(hq)).toBe(true);
    expect(hq.role).toBe('hq');
    expect(capabilities(hq)).toEqual(capabilities(A('root')));
  });
});

describe('chat-authz: capability', () => {
  it('broadcast.all は root/hq のみ', () => {
    expect(can(A('root'), 'broadcast.all')).toBe(true);
    expect(can(A('hq'), 'broadcast.all')).toBe(true);
    expect(can(A('owner'), 'broadcast.all')).toBe(false);
    expect(can(A('manager'), 'broadcast.all')).toBe(false);
    expect(can(A('staff'), 'broadcast.all')).toBe(false);
  });
  it('broadcast.store は staff には無い', () => {
    expect(can(A('owner'), 'broadcast.store')).toBe(true);
    expect(can(A('manager'), 'broadcast.store')).toBe(true);
    expect(can(A('staff'), 'broadcast.store')).toBe(false);
  });
  it('staff は AI 回答の修正（fix）ができない', () => {
    expect(can(A('staff'), 'ai.feedback')).toBe(true);
    expect(can(A('staff'), 'ai.feedback.fix')).toBe(false);
    expect(can(A('owner'), 'ai.feedback.fix')).toBe(true);
  });
  it('chat.admin は root/hq のみ', () => {
    expect(can(A('root'), 'chat.admin')).toBe(true);
    expect(can(A('owner'), 'chat.admin')).toBe(false);
  });
  it('全ロールが chat.view を持つ（チャットは全員が使える）', () => {
    ['root', 'hq', 'owner', 'manager', 'staff'].forEach(r => expect(can(A(r), 'chat.view')).toBe(true));
  });
});

describe('chat-authz: AI Agent は人間の権限を超えない', () => {
  it('agent の capability は actingFor の部分集合', () => {
    const staffAgent = agentActor(A('staff'));
    const rootAgent = agentActor(A('root'));
    expect(can(staffAgent, 'recipient.resolve')).toBe(true);
    expect(can(staffAgent, 'broadcast.all')).toBe(false);
    // root の代理でも agent 自身は送信・作成をしない
    expect(can(rootAgent, 'broadcast.all')).toBe(false);
    expect(can(rootAgent, 'room.create.group')).toBe(false);
    expect(can(rootAgent, 'chat.admin')).toBe(false);
  });
  it('actingFor の無い agent は何もできない', () => {
    const orphan = makeActor({ actorId: '__ai__', role: 'agent' });
    expect(can(orphan, 'chat.view')).toBe(false);
    expect(can(orphan, 'recipient.resolve')).toBe(false);
  });
  it('agent の入れ子は禁止（agent が agent の代理にならない）', () => {
    const nested = makeActor({ role: 'agent', actingFor: { role: 'agent', actorId: 'x' } });
    expect(nested.actingFor).toBe(null);
  });
  it('agent は投稿できない（送信するのは常に人間）', () => {
    expect(canPostRoom(agentActor(A('root')), storeA)).toBe(false);
  });
});

describe('chat-authz: Room 可視', () => {
  it('全社アナウンスは全員に見える', () => {
    expect(canViewRoom(A('staff'), announce)).toBe(true);
  });
  it('全社アナウンスへ投稿できるのは root/hq のみ', () => {
    expect(canPostRoom(A('root'), announce)).toBe(true);
    expect(canPostRoom(A('hq'), announce)).toBe(true);
    expect(canPostRoom(A('owner'), announce)).toBe(false);
    expect(canPostRoom(A('staff'), announce)).toBe(false);
  });
  it('店舗ルームは storeId スコープで判定される', () => {
    const s = A('staff', { storeIds: ['100'] });
    expect(canViewRoom(s, storeA)).toBe(true);
    expect(canViewRoom(s, storeB)).toBe(false);
    expect(canPostRoom(s, storeA)).toBe(true);
    expect(canPostRoom(s, storeB)).toBe(false);
  });
  it('storeId 未設定の旧ルームは店舗名の部分一致で判定（移行期の互換）', () => {
    const s = A('staff', { shopNames: ['A院'] });
    expect(roomInStoreScope(s, legacyStore)).toBe(true);
    expect(canViewRoom(s, legacyStore)).toBe(true);
    expect(canViewRoom(A('staff', { shopNames: ['B院'] }), legacyStore)).toBe(false);
  });
  it('明示メンバーならスコープ外の店舗ルームも見える', () => {
    const s = A('staff', { id: 'u9', storeIds: ['999'] });
    expect(canViewRoom(s, { ...storeA, members: ['u9'] })).toBe(true);
  });
  it('root/hq は全店舗ルームが見える', () => {
    expect(canViewRoom(A('root'), storeB)).toBe(true);
    expect(canViewRoom(A('hq'), storeB)).toBe(true);
  });
  it('group はメンバーのみ（root でもメンバー外は不可ではない＝管理者は見える）', () => {
    expect(canViewRoom(A('staff', { id: 'u2' }), group)).toBe(true);
    expect(canViewRoom(A('staff', { id: 'u8' }), group)).toBe(false);
    expect(canViewRoom(A('root', { id: 'r1' }), group)).toBe(true);
  });
  it('DM は root/hq でも非メンバーは見られない（プライバシー・既存挙動）', () => {
    expect(canViewRoom(A('root', { id: 'r1' }), dm)).toBe(false);
    expect(canViewRoom(A('hq', { id: 'h1' }), dm)).toBe(false);
    expect(canViewRoom(A('staff', { id: 'u3' }), dm)).toBe(true);
  });
  it('archived / closed のルームは閲覧できるが投稿できない', () => {
    const archived = { ...storeA, status: 'archived' };
    const s = A('staff', { storeIds: ['100'] });
    expect(canViewRoom(s, archived)).toBe(true);
    expect(canPostRoom(s, archived)).toBe(false);
    expect(canPostRoom(A('root'), archived)).toBe(false);
  });
  it('filterRooms が見える Room だけを返す', () => {
    const s = A('staff', { id: 'u2', storeIds: ['100'] });
    // u2 は group・dm・event のメンバー。storeB は管轄外なので落ちる。
    const ids = filterRooms(s, [announce, storeA, storeB, group, dm, event]).map(r => r.id);
    expect(ids).toEqual(['announce_all', 'store_s_100', 'g1', 'd1', 'event_e1']);
  });
});

describe('chat-authz: テナント分離', () => {
  it('テナントが違う Room は存在しないものとして扱う', () => {
    const a = A('root', { tenantId: 'tenantA' });
    const roomB = { ...storeA, tenantId: 'tenantB' };
    expect(canViewRoom(a, roomB)).toBe(false);
    expect(canPostRoom(a, roomB)).toBe(false);
    expect(filterRooms(a, [roomB])).toEqual([]);
  });
  it('tenantId 未設定のレコードは既定テナントとみなす（既存データ互換）', () => {
    expect(sameTenant(A('root'), storeA)).toBe(true);
    expect(makeActor({}).tenantId).toBe(DEFAULT_TENANT_ID);
  });
  it('sameActor はテナントを跨いだ staff_id 衝突を区別する', () => {
    const a = { tenantId: 'tA', actorId: '1' };
    const b = { tenantId: 'tB', actorId: '1' };
    expect(sameActor(a, a)).toBe(true);
    expect(sameActor(a, b)).toBe(false);
    expect(sameActor({ tenantId: 'tA', actorId: '' }, { tenantId: 'tA', actorId: '' })).toBe(false);
  });
});

describe('chat-authz: Room 管理・作成・削除', () => {
  it('group は作成者・管理者・テナント管理者が管理できる', () => {
    expect(canManageRoom(A('staff', { id: 'u1' }), group)).toBe(true);   // createdBy
    expect(canManageRoom(A('staff', { id: 'u2' }), group)).toBe(false);  // ただのメンバー
    expect(canManageRoom(A('root', { id: 'r1' }), group)).toBe(true);
  });
  it('announce / store は削除できない', () => {
    expect(canDeleteRoom(A('root'), announce)).toBe(false);
    expect(canDeleteRoom(A('root'), storeA)).toBe(false);
  });
  it('group/dm は作成者か管理者のみ削除できる', () => {
    expect(canDeleteRoom(A('staff', { id: 'u1' }), group)).toBe(true);
    expect(canDeleteRoom(A('staff', { id: 'u2' }), group)).toBe(false);
    expect(canDeleteRoom(A('root', { id: 'r1' }), group)).toBe(true);
  });
  it('staff はスコープ外のスタッフを含む Group を作れない', () => {
    const roster = [{ id: 'u2', storeId: '100' }, { id: 'u5', storeId: '200' }];
    const me = A('staff', { id: 'u1', storeIds: ['100'] });
    expect(canCreateRoom(me, { kind: 'group', members: ['u1', 'u2'] }, roster)).toBe(true);
    expect(canCreateRoom(me, { kind: 'group', members: ['u1', 'u5'] }, roster)).toBe(false);
  });
  it('名簿に無い staff_id は許可しない', () => {
    const roster = [{ id: 'u2', storeId: '100' }];
    const me = A('staff', { id: 'u1', storeIds: ['100'] });
    expect(canCreateRoom(me, { kind: 'dm', members: ['u1', 'unknown'] }, roster)).toBe(false);
  });
  it('announce / store は手動作成できない（自動生成のみ）', () => {
    expect(canCreateRoom(A('root'), { kind: 'store', members: [] })).toBe(false);
    expect(canCreateRoom(A('root'), { kind: 'announce', members: [] })).toBe(false);
  });
  it('staffInScope は storeId を優先し、店舗名はフォールバック', () => {
    const me = A('manager', { storeIds: ['100'], shopNames: ['A院'] });
    expect(staffInScope(me, { id: 'x', storeId: '100' })).toBe(true);
    expect(staffInScope(me, { id: 'x', storeId: '200' })).toBe(false);
    expect(staffInScope(me, { id: 'x', shop: 'A院' })).toBe(true);
    expect(staffInScope(me, null)).toBe(false);
    expect(staffInScope(A('root'), null)).toBe(true);
  });
});

describe('chat-authz: Recipient フィルタ（最終防衛線）', () => {
  const rooms = [storeA, storeB];
  const roster = [{ id: 's1', storeId: '100' }, { id: 's2', storeId: '200' }];
  it('権限外の店舗・スタッフ・Room を denied に落とす', () => {
    const me = A('manager', { storeIds: ['100'] });
    const out = filterRecipients(me, { sendType: 'multiple_groups', storeIds: ['100', '200'], staffIds: ['s1', 's2'], roomIds: ['store_s_100', 'store_s_200'] }, { rooms, knownStaff: roster });
    expect(out.storeIds).toEqual(['100']);
    expect(out.deniedStoreIds).toEqual(['200']);
    expect(out.staffIds).toEqual(['s1']);
    expect(out.roomIds).toEqual(['store_s_100']);
    expect(out.denied).toBe(true);
    expect(out.denyReason).toBe('out_of_scope');
  });
  it('root は全部通る', () => {
    const out = filterRecipients(A('root'), { sendType: 'broadcast', storeIds: ['100', '200'], roomIds: ['store_s_100'] }, { rooms, knownStaff: roster });
    expect(out.storeIds).toEqual(['100', '200']);
    expect(out.denied).toBe(false);
  });
  it('broadcast.all を持たない actor の全社送信は縮小せず deny する', () => {
    const out = filterRecipients(A('owner', { storeIds: ['100'] }), { sendType: 'broadcast', storeIds: ['100'], roomIds: [] }, { rooms, knownStaff: roster });
    expect(out.storeIds).toEqual([]);
    expect(out.denyReason).toBe('broadcast_forbidden');
  });
  it('存在しない Room は拒否される', () => {
    const out = filterRecipients(A('root'), { sendType: 'multiple_groups', roomIds: ['ghost'] }, { rooms });
    expect(out.roomIds).toEqual([]);
    expect(out.deniedRoomIds).toEqual(['ghost']);
  });
  it('AI が代理でも人間の範囲を超えない', () => {
    const ai = agentActor(A('staff', { storeIds: ['100'] }));
    const out = filterRecipients(ai, { sendType: 'multiple_groups', storeIds: ['100', '200'] }, { rooms, knownStaff: roster });
    expect(out.storeIds).toEqual(['100']);
    expect(out.deniedStoreIds).toEqual(['200']);
  });
});

describe('chat-authz: enforcement / kill switch', () => {
  it('既定は shadow（既存クライアントを壊さない）', () => {
    expect(enforcementMode({})).toBe('shadow');
    expect(enforcementMode({ CHAT_AUTHZ_ENFORCE: 'strict' })).toBe('strict');
    expect(enforcementMode({ CHAT_AUTHZ_ENFORCE: 'off' })).toBe('off');
    expect(enforcementMode({ CHAT_AUTHZ_ENFORCE: 'なにか' })).toBe('shadow');
  });
  it('Kill Switch は環境変数でもストアのフラグでも有効になる', () => {
    expect(killSwitchOn({ CHAT_KILL_SWITCH: '1' })).toBe(true);
    expect(killSwitchOn({ CHAT_KILL_SWITCH: 'true' })).toBe(true);
    expect(killSwitchOn({}, true)).toBe(true);
    expect(killSwitchOn({})).toBe(false);
  });
  it('送信系 action を識別する', () => {
    expect(isSendAction('send')).toBe(true);
    expect(isSendAction('noteAdd')).toBe(true);
    expect(isSendAction('read')).toBe(false);
  });
});

describe('chat-authz: authorizeChatAction', () => {
  const staff100 = A('staff', { id: 'u1', storeIds: ['100'] });
  it('自店舗へは送信できる / 他店舗へは送信できない', () => {
    expect(authorizeChatAction(staff100, 'send', { room: storeA }).allow).toBe(true);
    const r = authorizeChatAction(staff100, 'send', { room: storeB });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe('room_not_visible');
  });
  it('Kill Switch ON で送信系だけが止まる（閲覧は可）', () => {
    const env = { CHAT_KILL_SWITCH: '1' };
    expect(authorizeChatAction(staff100, 'send', { room: storeA, env }).reason).toBe('kill_switch');
    expect(authorizeChatAction(staff100, 'read', { room: storeA, env }).allow).toBe(true);
  });
  it('ensureRooms / remapUser は管理者のみ', () => {
    expect(authorizeChatAction(A('root'), 'ensureRooms', {}).allow).toBe(true);
    expect(authorizeChatAction(staff100, 'ensureRooms', {}).reason).toBe('admin_only');
    expect(authorizeChatAction(staff100, 'remapUser', {}).reason).toBe('admin_only');
  });
  it('自分のメッセージは削除できる / 他人のものは管理者のみ', () => {
    const mine = { fromStaffId: 'u1' }, others = { fromStaffId: 'u2' };
    expect(authorizeChatAction(staff100, 'deleteMsg', { room: storeA, message: mine }).allow).toBe(true);
    expect(authorizeChatAction(staff100, 'deleteMsg', { room: storeA, message: others }).reason).toBe('not_owner');
    expect(authorizeChatAction(A('root'), 'deleteMsg', { room: storeA, message: others }).allow).toBe(true);
  });
  it('message コンテキストが無い削除はルーム単位で判定し、所有者判定は呼び出し側に委ねる', () => {
    // サーバーはメッセージ本文を読まずに認可するため、所有者不明でもルームが書ける人は通す。
    expect(authorizeChatAction(staff100, 'deleteMsg', { room: storeA }).allow).toBe(true);
    expect(authorizeChatAction(staff100, 'deleteMsg', { room: storeB }).allow).toBe(false);
  });
  it('migrateMsgs は管理者のみ', () => {
    expect(authorizeChatAction(A('root'), 'migrateMsgs', {}).allow).toBe(true);
    expect(authorizeChatAction(staff100, 'migrateMsgs', {}).reason).toBe('admin_only');
  });
  it('未知の action は拒否する（fail-closed）', () => {
    expect(authorizeChatAction(A('root'), 'somethingNew', {}).reason).toBe('unknown_action');
  });
  it('leave は常に許可（自分が抜けるだけ）', () => {
    expect(authorizeChatAction(staff100, 'leave', { room: group }).allow).toBe(true);
  });
  it('非メンバーの DM には送信も既読もできない', () => {
    expect(authorizeChatAction(A('root', { id: 'r1' }), 'send', { room: dm }).allow).toBe(false);
    expect(authorizeChatAction(A('root', { id: 'r1' }), 'read', { room: dm }).allow).toBe(false);
  });
});
