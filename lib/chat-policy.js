// ── Chat 固有の Authorization Policy ─────────────────────────────────────
// 共通の actor / 店舗スコープ / Rollout は lib/actor.js・lib/authz.js が正本。
// ここには「チャットだけのルール」を置く:
//   canViewRoom / canPostRoom / canManageRoom / canCreateRoom / canInviteMember /
//   filterRecipients / DM rules / Broadcast rules
//
// 仕様は CHAT_PERMISSION_MATRIX.md。テスト: tests/chat-policy.test.js

import { makeActor, isSelfId, sameTenant } from './actor.js';
import {
  isTenantAdmin, canAccessStore, canAccessStoreName, staffInScope,
  killSwitchOn, chatRolloutAllows,
} from './authz.js';

export const CHAT_POLICY_VERSION = 'chat-policy-1';

const str = (v) => String(v == null ? '' : v);
const arr = (v) => (Array.isArray(v) ? v : []);
const uniq = (a) => [...new Set(a)];

export const CHAT_CAPS = [
  'chat.view',
  'room.create.group',
  'room.create.dm',
  'room.invite',
  'broadcast.store',
  'broadcast.all',
  'recipient.resolve',
  'schedule.manage',
  'audit.read',
  'audit.read.all',
  'ai.feedback',
  'ai.feedback.fix',
  'ai.escalate.receive',
  'chat.admin',        // ensureRooms / remapUser / rollout 変更などの運用操作
];

const ROLE_CAPS = {
  root: ['chat.view', 'room.create.group', 'room.create.dm', 'room.invite', 'broadcast.store', 'broadcast.all', 'recipient.resolve', 'schedule.manage', 'audit.read', 'audit.read.all', 'ai.feedback', 'ai.feedback.fix', 'ai.escalate.receive', 'chat.admin'],
  hq: ['chat.view', 'room.create.group', 'room.create.dm', 'room.invite', 'broadcast.store', 'broadcast.all', 'recipient.resolve', 'schedule.manage', 'audit.read', 'audit.read.all', 'ai.feedback', 'ai.feedback.fix', 'ai.escalate.receive', 'chat.admin'],
  owner: ['chat.view', 'room.create.group', 'room.create.dm', 'room.invite', 'broadcast.store', 'recipient.resolve', 'schedule.manage', 'audit.read', 'ai.feedback', 'ai.feedback.fix'],
  manager: ['chat.view', 'room.create.group', 'room.create.dm', 'room.invite', 'broadcast.store', 'recipient.resolve', 'schedule.manage', 'audit.read', 'ai.feedback', 'ai.feedback.fix'],
  staff: ['chat.view', 'room.create.group', 'room.create.dm', 'room.invite', 'recipient.resolve', 'audit.read', 'ai.feedback'],
  agent: ['chat.view', 'recipient.resolve'],   // AI は解決するだけ。送信も作成も承認もしない
  system: ['chat.view', 'chat.admin'],         // 自動生成（Room 同期など）
};

// 送信系 action（Kill Switch の停止対象）
const SEND_ACTIONS = ['send', 'broadcast', 'resend', 'schedule.create', 'noteAdd'];
export function isSendAction(action) { return SEND_ACTIONS.includes(str(action)); }

// capability 判定。agent は acting_for の部分集合しか持てない。
export function can(actor, cap) {
  const a = actor || {};
  if (!(ROLE_CAPS[a.role] || []).includes(cap)) return false;
  if (a.role === 'agent') {
    if (!a.acting_for) return false;
    return can(a.acting_for, cap);
  }
  return true;
}

export function capabilities(actor) {
  return CHAT_CAPS.filter(c => can(actor, c));
}

// ── Room スコープ ────────────────────────────────────────────────────────

// 店舗ルームが actor のスコープ内か。store_id（正）→ 店舗名（移行期のフォールバック）。
export function roomInStoreScope(actor, room) {
  const r = room || {};
  const sid = str(r.storeId ?? r.store_id);
  if (sid) return canAccessStore(actor, sid);
  return canAccessStoreName(actor, str(r.shop || r.name));
}

const isMember = (room, actor) =>
  arr((room || {}).members).map(str).some(id => isSelfId(actor, id));

export function isRoomMember(room, actor) { return isMember(room, actor); }

// Room 閲覧可否（CHAT_PERMISSION_MATRIX.md §4）
export function canViewRoom(actor, room) {
  const a = actor || {}, r = room || {};
  if (!r.kind) return false;
  if (!sameTenant(a, r)) return false;                 // テナント違いは「存在しない」
  if (!can(a, 'chat.view')) return false;
  if (r.kind === 'dm') return isMember(r, a);          // root/hq でも非メンバーの DM は不可
  if (r.kind === 'announce') return true;
  if (isTenantAdmin(a)) return true;
  if (isMember(r, a)) return true;
  if (r.kind === 'store') return roomInStoreScope(a, r);
  return false;                                        // group / event はメンバーのみ
}

// Room 投稿可否。archived / closed は投稿不可（閲覧はできる）。
export function canPostRoom(actor, room) {
  const a = actor || {}, r = room || {};
  if (!canViewRoom(a, r)) return false;
  if (a.role === 'agent') return false;                // AI 自身は送信しない（人間が実行する）
  if ((str(r.status) || 'active') !== 'active') return false;
  if (r.kind === 'announce') return can(a, 'broadcast.all');   // 全社一斉は root/hq のみ
  return true;
}

// Room 管理（名前/アイコン/ピン/メンバー変更）
export function canManageRoom(actor, room) {
  const a = actor || {}, r = room || {};
  if (!canViewRoom(a, r)) return false;
  if (a.role === 'agent') return false;
  if (a.role === 'system') return true;
  if (isTenantAdmin(a)) return true;
  if (r.kind === 'group' || r.kind === 'event') {
    if (arr(r.managers).map(str).some(id => isSelfId(a, id))) return true;
    if (str(r.createdBy) && isSelfId(a, str(r.createdBy))) return true;
    // owner / manager は管轄内なら管理可。staff は自分が作った Group のみ（上の分岐）
    return (a.role === 'owner' || a.role === 'manager') && (isMember(r, a) || roomInStoreScope(a, r));
  }
  if (r.kind === 'store') return a.role === 'owner' || a.role === 'manager';
  return false;
}

// Room 削除（announce / store は不可＝既存挙動を維持）
export function canDeleteRoom(actor, room) {
  const r = room || {};
  if (r.kind === 'announce' || r.kind === 'store') return false;
  if (!canViewRoom(actor, r)) return false;
  if (isTenantAdmin(actor)) return true;
  return isSelfId(actor, str(r.createdBy));
}

// Room 作成可否。members が actor のスコープ外の人を含む場合は不可。
//   knownStaff: [{ id, storeId?/shop_id?, shop? }]（省略時はメンバー検査をスキップ＝移行期）
export function canCreateRoom(actor, room, knownStaff) {
  const a = actor || {}, r = room || {};
  const kind = str(r.kind) || 'group';
  if (kind === 'dm') { if (!can(a, 'room.create.dm')) return false; }
  else if (kind === 'group' || kind === 'event') { if (!can(a, 'room.create.group')) return false; }
  else return false;                                    // announce / store は自動生成のみ
  if (!sameTenant(a, r)) return false;
  if (isTenantAdmin(a)) return true;
  if (!Array.isArray(knownStaff) || !knownStaff.length) return true;
  return arr(r.members).map(str).filter(id => !isSelfId(a, id))
    .every(id => staffInScope(a, knownStaff.find(s => str(s && s.id) === id)));
}

// メンバー招待可否（招待する相手が actor のスコープ内であること）
export function canInviteMember(actor, room, staffId, knownStaff) {
  const a = actor || {};
  if (!can(a, 'room.invite')) return false;
  if (!canManageRoom(a, room)) return false;
  if (isTenantAdmin(a)) return true;
  if (!Array.isArray(knownStaff) || !knownStaff.length) return true;
  return staffInScope(a, knownStaff.find(s => str(s && s.id) === str(staffId)));
}

// 表示用: 見える Room だけに絞る
export function filterRooms(actor, rooms) {
  return arr(rooms).filter(r => canViewRoom(actor, r));
}

// ── Recipient のスコープフィルタ（Phase 3/5 の最終防衛線）────────────────
export function filterRecipients(actor, resolved, ctx = {}) {
  const a = actor || {};
  const src = resolved || {};
  const rooms = arr(ctx.rooms);
  const staff = arr(ctx.knownStaff);

  const allowedStore = [], deniedStore = [];
  for (const id of uniq(arr(src.storeIds).map(str))) {
    (canAccessStore(a, id) ? allowedStore : deniedStore).push(id);
  }
  const allowedStaff = [], deniedStaff = [];
  for (const id of uniq(arr(src.staffIds).map(str))) {
    const s = staff.find(x => str(x && x.id) === id) || null;
    (staffInScope(a, s) ? allowedStaff : deniedStaff).push(id);
  }
  const allowedRoom = [], deniedRoom = [];
  for (const id of uniq(arr(src.roomIds).map(str))) {
    const room = rooms.find(x => str(x && x.id) === id) || null;
    // Room 一覧が渡されていない（移行期）なら検査をスキップ。渡されているのに見つからない＝存在しない宛先は拒否。
    const allowed = rooms.length ? (!!room && canPostRoom(a, room)) : true;
    if (allowed) allowedRoom.push(id); else deniedRoom.push(id);
  }
  // 全社一斉は broadcast.all を持つ者のみ。持たない場合は黙って縮小せず deny を立てる。
  const broadcastDenied = str(src.sendType) === 'broadcast' && !can(a, 'broadcast.all');
  return {
    ...src,
    storeIds: broadcastDenied ? [] : allowedStore,
    staffIds: broadcastDenied ? [] : allowedStaff,
    roomIds: broadcastDenied ? [] : allowedRoom,
    deniedStoreIds: broadcastDenied ? allowedStore.concat(deniedStore) : deniedStore,
    deniedStaffIds: broadcastDenied ? allowedStaff.concat(deniedStaff) : deniedStaff,
    deniedRoomIds: broadcastDenied ? allowedRoom.concat(deniedRoom) : deniedRoom,
    denied: broadcastDenied || !!(deniedStore.length || deniedStaff.length || deniedRoom.length),
    denyReason: broadcastDenied ? 'broadcast_forbidden'
      : ((deniedStore.length || deniedStaff.length || deniedRoom.length) ? 'out_of_scope' : ''),
  };
}

// ── action 単位の認可（サーバーのエントリポイント）───────────────────────
//   ctx: { room, knownStaff, message, env, killSwitch, rollout }
//   返り値: { allow:boolean, reason:string }
export function authorizeChatAction(actor, action, ctx = {}) {
  const a = makeActor(actor || {});
  const act = str(action);
  const room = ctx.room || null;
  const deny = (reason) => ({ allow: false, reason });
  const ok = { allow: true, reason: '' };

  // Rollout（Feature Flag）は最優先のゲート。未公開ロールはサーバー側でも拒否する。
  if (ctx.rollout !== undefined && !chatRolloutAllows(a, ctx.rollout)) return deny('chat_rollout_disabled');
  if (!can(a, 'chat.view')) return deny('no_chat_access');
  if (isSendAction(act) && killSwitchOn(ctx.env || {}, ctx.killSwitch)) return deny('kill_switch');

  switch (act) {
    case 'read':
    case 'react':
    case 'noteReact':
      return room ? (canViewRoom(a, room) ? ok : deny('room_not_visible')) : ok;

    case 'uploadImage':
      return ok;                                     // 画像の投入だけでは送信されない

    case 'send':
    case 'noteAdd':
      if (!room) return deny('no_room');
      return canPostRoom(a, room) ? ok : deny(canViewRoom(a, room) ? 'room_not_writable' : 'room_not_visible');

    case 'createRoom':
      return canCreateRoom(a, ctx.room || ctx.newRoom || {}, ctx.knownStaff) ? ok : deny('create_forbidden');

    case 'setMembers': {
      if (!room) return deny('no_room');
      if (!canManageRoom(a, room)) return deny('room_not_manageable');
      const added = arr(ctx.addMembers).map(str);
      if (added.length && !added.every(id => canInviteMember(a, room, id, ctx.knownStaff))) return deny('invite_out_of_scope');
      return ok;
    }

    case 'setRoom':
    case 'pinMsg':
      if (!room) return deny('no_room');
      return canManageRoom(a, room) ? ok : deny('room_not_manageable');

    case 'join':
      if (!room) return deny('no_room');
      return canViewRoom(a, room) ? ok : deny('room_not_visible');

    case 'leave':
      return ok;                                     // 自分が抜けるのは常に可

    case 'deleteRoom':
      if (!room) return deny('no_room');
      return canDeleteRoom(a, room) ? ok : deny('delete_forbidden');

    case 'deleteMsg':
    case 'noteDelete':
    case 'noteEdit': {
      if (!room) return deny('no_room');
      if (!canViewRoom(a, room)) return deny('room_not_visible');
      // ctx.message が無い＝所有者未確定。ルーム単位で判定し、本人判定は呼び出し側の
      // レコード単位チェックに委ねる（api/plan-store.js は既に本人 or root で絞っている）。
      if (!ctx.message) return ok;
      const owner = str(ctx.message.fromStaffId);
      if (owner && isSelfId(a, owner)) return ok;
      return isTenantAdmin(a) || canManageRoom(a, room) ? ok : deny('not_owner');
    }

    case 'ensureRooms':
    case 'syncStores':
    case 'remapUser':
    case 'migrateMsgs':
    case 'setRollout':
    case 'setdir':
      return can(a, 'chat.admin') ? ok : deny('admin_only');

    case 'resolveRecipients':
      return can(a, 'recipient.resolve') ? ok : deny('resolve_forbidden');

    case 'auditRead':
      return can(a, 'audit.read') ? ok : deny('audit_forbidden');

    default:
      // 未知の action は「不明＝拒否」。新しい action を足すときは必ずここに追記する。
      return deny('unknown_action');
  }
}
