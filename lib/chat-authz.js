// ── 社内チャット 認可コア（純粋関数・マルチテナント前提）──────────────────
// CHAT_PERMISSION_MATRIX.md の唯一の実装。フロント（表示の出し分け）と
// サーバー（api/plan-store.js ?type=chat）は必ずこのモジュールを通す。
//
// 設計原則（CHAT_AI_ROUTING_PLAN.md §3）:
//   - staff_id / store_id が正。表示名（氏名・店舗名）は移行期のフォールバックにのみ使う。
//   - AI Agent は人間（actingFor）の権限を超える capability / Recipient を持てない。
//   - AI Agent は承認者になれない。
//   - サーバー側が最終防衛線。フロントのフィルタは UX であってセキュリティ境界ではない。
//   - NAORU 固有名（店舗名・法人名）は core にハードコードしない。
//
// I/O は一切持たない（fetch も KV も触らない）。テスト: tests/chat-authz.test.js

export const CHAT_AUTHZ_VERSION = 'chat-authz-1';

export const DEFAULT_TENANT_ID = 'default';

// ロール（表示ラベルは UI 側に置く＝core に日本語を持ち込まない）
export const ROLES = ['root', 'hq', 'owner', 'manager', 'staff', 'agent', 'system'];

// テナント全体を見られるロール（DM のプライバシー例外は別途）
const TENANT_ADMIN_ROLES = ['root', 'hq'];

// 店舗スコープで動くロール
const SCOPED_ROLES = ['owner', 'manager', 'staff'];

export const CAPS = [
  'chat.view',
  'room.create.group',
  'room.create.dm',
  'broadcast.store',
  'broadcast.all',
  'recipient.resolve',
  'schedule.manage',
  'audit.read',
  'audit.read.all',
  'ai.feedback',
  'ai.feedback.fix',
  'ai.escalate.receive',
  'chat.admin',        // ensureRooms / remapUser など運用操作
];

// ロール → capability（Room 個別の可否は canViewRoom/canPostRoom で別途判定）
const ROLE_CAPS = {
  root: ['chat.view', 'room.create.group', 'room.create.dm', 'broadcast.store', 'broadcast.all', 'recipient.resolve', 'schedule.manage', 'audit.read', 'audit.read.all', 'ai.feedback', 'ai.feedback.fix', 'ai.escalate.receive', 'chat.admin'],
  hq: ['chat.view', 'room.create.group', 'room.create.dm', 'broadcast.store', 'broadcast.all', 'recipient.resolve', 'schedule.manage', 'audit.read', 'audit.read.all', 'ai.feedback', 'ai.feedback.fix', 'ai.escalate.receive', 'chat.admin'],
  owner: ['chat.view', 'room.create.group', 'room.create.dm', 'broadcast.store', 'recipient.resolve', 'schedule.manage', 'audit.read', 'ai.feedback', 'ai.feedback.fix'],
  manager: ['chat.view', 'room.create.group', 'room.create.dm', 'broadcast.store', 'recipient.resolve', 'schedule.manage', 'audit.read', 'ai.feedback', 'ai.feedback.fix'],
  staff: ['chat.view', 'room.create.group', 'room.create.dm', 'recipient.resolve', 'audit.read', 'ai.feedback'],
  agent: ['chat.view', 'recipient.resolve'],   // AI は解決するだけ。送信も作成もしない
  system: ['chat.view', 'chat.admin'],         // 自動生成（Room 同期など）
};

// 送信系 action（Kill Switch の停止対象）
const SEND_ACTIONS = ['send', 'broadcast', 'resend', 'schedule.create', 'noteAdd'];

const str = (v) => String(v == null ? '' : v);
const arr = (v) => (Array.isArray(v) ? v : []);
const uniq = (a) => [...new Set(a)];

// ── actor ────────────────────────────────────────────────────────────────

// 旧実装の { root:true } 表現や SalonOne のロール名も受け付けて正規化する。
export function normalizeRole(role, opts = {}) {
  const r = str(role).toLowerCase();
  if (r === 'brand_admin') return 'root';
  if (r === 'shop_admin') return 'owner';
  if (r === 'shop_staff') return 'staff';
  if (ROLES.includes(r)) return r;
  // role 未指定でも root フラグが立っていれば root として扱う（既存クライアント互換）
  if (opts.root) return 'root';
  return 'staff';
}

// actor を組み立てる。未知フィールドは落とす（信頼できる形に正規化する）。
export function makeActor(input = {}) {
  const role = normalizeRole(input.role, { root: !!input.root });
  const actorId = str(input.actorId || input.staffId);
  const actor = {
    tenantId: str(input.tenantId) || DEFAULT_TENANT_ID,
    actorId,
    // 同一人物の別ID（SalonOne の user_id と staff_id、root 共有ログインの '__root__' と本人名など）。
    // ルームの members はクライアント側の ID で作られているため、別IDでも本人として扱う。
    altIds: uniq([actorId, ...arr(input.altIds).map(str)].filter(Boolean)),
    role,
    storeIds: uniq(arr(input.storeIds).map(str).filter(Boolean)),
    shopNames: uniq(arr(input.shopNames || input.shops).map(str).filter(Boolean)),
    verified: !!input.verified,
    actingFor: null,
  };
  if (role === 'agent') {
    const human = input.actingFor ? makeActor({ ...input.actingFor, role: input.actingFor.role }) : null;
    actor.actingFor = human && human.role === 'agent' ? null : human;  // agent の入れ子は禁止
  }
  return actor;
}

// AI エージェントの actor を人間から作る（権限は必ず人間の部分集合）。
export function agentActor(human) {
  const h = makeActor(human || {});
  return makeActor({
    tenantId: h.tenantId,
    actorId: '__ai__',
    role: 'agent',
    storeIds: h.storeIds,
    shopNames: h.shopNames,
    verified: h.verified,
    actingFor: h,
    altIds: ['__ai__'],
  });
}

export function isTenantAdmin(actor) {
  const a = actor || {};
  return TENANT_ADMIN_ROLES.includes(a.role);
}

export function isScopedRole(actor) {
  return SCOPED_ROLES.includes((actor || {}).role);
}

// テナント一致（レコード側に tenantId が無い＝既定テナントの既存データとみなす）
export function sameTenant(actor, rec) {
  const at = str((actor || {}).tenantId) || DEFAULT_TENANT_ID;
  const rt = str((rec || {}).tenantId) || DEFAULT_TENANT_ID;
  return at === rt;
}

// 同一人物か（テナントをまたいだ staff_id の衝突を防ぐため tenant 込みで比較）
export function sameActor(a, b) {
  if (!a || !b) return false;
  const ka = `${str(a.tenantId) || DEFAULT_TENANT_ID}:${str(a.actorId || a.staffId)}`;
  const kb = `${str(b.tenantId) || DEFAULT_TENANT_ID}:${str(b.actorId || b.staffId)}`;
  return !!str(a.actorId || a.staffId) && ka === kb;
}

// capability 判定。agent は actingFor の部分集合しか持てない。
export function can(actor, cap) {
  const a = actor || {};
  const own = ROLE_CAPS[a.role] || [];
  if (!own.includes(cap)) return false;
  if (a.role === 'agent') {
    if (!a.actingFor) return false;             // 代理元が無い agent は何もできない
    return can(a.actingFor, cap);               // 人間の権限を超えられない
  }
  return true;
}

export function capabilities(actor) {
  return CAPS.filter(c => can(actor, c));
}

// ── Room スコープ ────────────────────────────────────────────────────────

// 店舗ルームが actor のスコープ内か。
//   1) storeId（正） … actor.storeIds に含まれるか
//   2) 店舗名（移行期のフォールバック） … 部分一致（既存 roomVisibleTo と同じ緩い一致）
export function roomInStoreScope(actor, room) {
  const a = actor || {}, r = room || {};
  const rid = str(r.storeId);
  if (rid && a.storeIds.length) return a.storeIds.includes(rid);
  const rs = str(r.shop || r.name);
  if (!rs) return false;
  return arr(a.shopNames).some(p => p && (rs.includes(p) || p.includes(rs)));
}

// この ID は自分か（別IDも含めて判定）
export function isSelfId(actor, id) {
  const a = actor || {};
  const target = str(id);
  if (!target) return false;
  const ids = arr(a.altIds).length ? arr(a.altIds).map(str) : [str(a.actorId)];
  return ids.filter(Boolean).includes(target);
}

const isMember = (room, actor) =>
  arr((room || {}).members).map(str).some(id => isSelfId(actor, id));

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
  const status = str(r.status) || 'active';
  if (status !== 'active') return false;
  if (r.kind === 'announce') return can(a, 'broadcast.all');
  return true;
}

// Room 管理（名前/アイコン/ピン/メンバー変更）
export function canManageRoom(actor, room) {
  const a = actor || {}, r = room || {};
  if (!canViewRoom(a, r)) return false;
  if (a.role === 'agent' || a.role === 'system') return a.role === 'system';
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
//   knownStaff: [{ id, storeId?, shop? }]（省略時はメンバーのスコープ検査をスキップ＝移行期）
export function canCreateRoom(actor, room, knownStaff) {
  const a = actor || {}, r = room || {};
  const kind = str(r.kind) || 'group';
  if (kind === 'dm') { if (!can(a, 'room.create.dm')) return false; }
  else if (kind === 'group') { if (!can(a, 'room.create.group')) return false; }
  else if (kind === 'event') { if (!can(a, 'room.create.group')) return false; }
  else return false;                                    // announce / store は自動生成のみ
  if (!sameTenant(a, r)) return false;
  if (isTenantAdmin(a)) return true;
  if (!Array.isArray(knownStaff) || !knownStaff.length) return true;  // 名簿が無ければ検査しない
  const members = arr(r.members).map(str).filter(id => !isSelfId(a, id));
  return members.every(id => staffInScope(a, knownStaff.find(s => str(s && s.id) === id)));
}

// スタッフが actor のスコープ内か（storeId 優先・店舗名はフォールバック）
export function staffInScope(actor, staff) {
  const a = actor || {};
  if (isTenantAdmin(a)) return true;
  if (!staff) return false;                              // 名簿に無い staff_id は許可しない
  if (!sameTenant(a, staff)) return false;
  if (isSelfId(a, str(staff.id))) return true;
  const sid = str(staff.storeId || staff.shopId || staff.shop_id);
  if (sid && a.storeIds.length) return a.storeIds.includes(sid);
  const sn = str(staff.shop || staff.shopName);
  if (!sn) return false;
  return arr(a.shopNames).some(p => p && (sn.includes(p) || p.includes(sn)));
}

// 表示用: 見える Room だけに絞る
export function filterRooms(actor, rooms) {
  return arr(rooms).filter(r => canViewRoom(actor, r));
}

// ── Recipient のスコープフィルタ（Phase 3/5 の最終防衛線・先に用意しておく）──
// resolved: { storeIds, staffIds, roomIds, sendType, ... }
// rooms / knownStaff を渡すと Room 単位・スタッフ単位でも検査する。
export function filterRecipients(actor, resolved, ctx = {}) {
  const a = actor || {};
  const src = resolved || {};
  const rooms = arr(ctx.rooms);
  const staff = arr(ctx.knownStaff);
  const admin = isTenantAdmin(a);

  const allowedStore = [], deniedStore = [];
  for (const id of uniq(arr(src.storeIds).map(str))) {
    (admin || a.storeIds.includes(id) ? allowedStore : deniedStore).push(id);
  }
  const allowedStaff = [], deniedStaff = [];
  for (const id of uniq(arr(src.staffIds).map(str))) {
    const s = staff.find(x => str(x && x.id) === id) || null;
    (admin || staffInScope(a, s) ? allowedStaff : deniedStaff).push(id);
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
    denyReason: broadcastDenied ? 'broadcast_forbidden' : (deniedStore.length || deniedStaff.length || deniedRoom.length ? 'out_of_scope' : ''),
  };
}

// ── enforcement / kill switch ────────────────────────────────────────────

// 'strict' = 拒否する / 'shadow' = 判定だけして通す（違反を記録）/ 'off' = 判定しない
export function enforcementMode(env = {}) {
  const v = str(env.CHAT_AUTHZ_ENFORCE).toLowerCase();
  if (v === 'strict' || v === 'shadow' || v === 'off') return v;
  return 'shadow';   // 既定は shadow（既存クライアントを壊さない）
}

export function killSwitchOn(env = {}, storeFlag) {
  if (storeFlag === true) return true;
  const v = str(env.CHAT_KILL_SWITCH).toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export function isSendAction(action) {
  return SEND_ACTIONS.includes(str(action));
}

// ── action 単位の認可（サーバーのエントリポイント）───────────────────────
//   ctx: { room, rooms, message, knownStaff, targetStaffId, killSwitch }
//   返り値: { allow:boolean, reason:string }
export function authorizeChatAction(actor, action, ctx = {}) {
  const a = makeActor(actor || {});
  const act = str(action);
  const room = ctx.room || null;
  const deny = (reason) => ({ allow: false, reason });
  const ok = { allow: true, reason: '' };

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

    case 'setMembers':
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
      // ctx.message が渡されない場合は「所有者が未確定」＝ルーム単位の可否だけ判定し、
      // 本人かどうかの最終判定は呼び出し側のレコード単位チェックに委ねる
      // （api/plan-store.js の deleteMsg / noteEdit は既に本人 or root で絞っている）。
      if (!ctx.message) return ok;
      const owner = str(ctx.message.fromStaffId);
      if (owner && isSelfId(a, owner)) return ok;
      return isTenantAdmin(a) || canManageRoom(a, room) ? ok : deny('not_owner');
    }

    case 'ensureRooms':
    case 'syncStores':
    case 'remapUser':
    case 'migrateMsgs':
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
