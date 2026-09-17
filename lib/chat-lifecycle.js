// ── Chat ルームのライフサイクル（純粋関数）──────────────────────────
// SalonOne に店舗が増えたら店舗ルームが自動で生まれ、配属が変われば在籍者が自動で入れ替わり、
// 終わったイベントのルームは静かに畳まれる。tests/chat-lifecycle.test.js でカバー。
//
// 既存の lib/chat.js（ensureBaseRooms / roomVisibleTo）は変更しない。ここは**その上の層**で、
// 「誰がいつ入る・出る・畳む」という時間軸の判断だけを持つ。
//
// 原則:
//   - 自動で**入れる**のは安全側（見えるようになるだけ）。自動で**出す**のは慎重に行う。
//   - 人が手で入れたメンバー（pinnedMembers）は自動同期で外さない。
//   - ルームは**消さない**（archive するだけ）。過去のやり取りは監査の対象なので残す。

import { storeRoomId, ANNOUNCE_ROOM_ID } from './chat.js';

export const EVENT_ROOM_PREFIX = 'event_';
// イベント終了から何日で自動アーカイブするか。直後だと片付け・振り返りの投稿が入らない。
export const EVENT_ARCHIVE_GRACE_DAYS = 7;

export function eventRoomId(eventId) {
  return `${EVENT_ROOM_PREFIX}${String(eventId || '').trim()}`;
}

// SalonOne の店舗一覧と現在のルームを突き合わせ、「作る / 名前を直す / 畳む」を決める。
// 実際の書き込みは呼び出し側（api/plan-store）が行う。ここは判断だけ。
export function planStoreRooms(rooms, shops, opts = {}) {
  const list = Array.isArray(rooms) ? rooms : [];
  const shopList = (Array.isArray(shops) ? shops : []).filter(s => s && s.name);
  const byShopKey = new Map();
  for (const r of list) {
    if (r && r.kind === 'store') byShopKey.set(String(r.id), r);
  }
  const create = [];
  const rename = [];
  const archive = [];
  const seen = new Set();

  for (const s of shopList) {
    const name = String(s.name).trim();
    const id = storeRoomId(name);
    seen.add(id);
    const existing = byShopKey.get(id);
    if (!existing) {
      create.push({ id, kind: 'store', name, shop: name, shopId: String(s.id || ''), members: [], createdBy: '__system__' });
    } else if (existing.name !== name) {
      rename.push({ id, from: existing.name, to: name });
    }
  }

  // 一覧から消えた店舗＝閉店/改名。**消さずに畳む**。過去のやり取りは残す必要がある。
  // ただし店舗一覧が空で返ってきたとき（APIの失敗）に全店を畳まないよう、明示的に守る。
  if (shopList.length > 0) {
    for (const r of byShopKey.values()) {
      if (!seen.has(String(r.id)) && !r.archived) archive.push({ id: String(r.id), reason: 'shop_removed' });
    }
  }
  return { create, rename, archive, skippedArchive: shopList.length === 0 };
}

// 在籍情報から店舗ルームの在籍者を計算する。
// pinnedMembers（人が手で入れた本部・エリア長など）は配属に関わらず残す。
export function syncStoreMembers(room, staff, opts = {}) {
  const r = (room && typeof room === 'object') ? room : {};
  const shopName = String(r.shop || '').trim();
  const cur = new Set((Array.isArray(r.members) ? r.members : []).map(String));
  const pinned = new Set((Array.isArray(r.pinnedMembers) ? r.pinnedMembers : []).map(String));
  const belongs = new Set(
    (Array.isArray(staff) ? staff : [])
      .filter(s => s && String(s.shop || '').trim() === shopName)
      .map(s => String(s.id)),
  );
  const add = [...belongs].filter(id => !cur.has(id));
  // 配属から外れた人を出す。ただし pinned と、自動同期を切っている場合は出さない。
  const remove = opts.autoRemove === false ? []
    : [...cur].filter(id => !belongs.has(id) && !pinned.has(id));
  const members = [...new Set([...belongs, ...pinned])];
  return { add, remove, members, changed: add.length > 0 || remove.length > 0 };
}

// イベントルームを畳むべきか。終了日＋猶予を過ぎ、かつ未アーカイブなら true。
export function shouldArchiveEventRoom(room, event, nowMs = Date.now()) {
  const r = (room && typeof room === 'object') ? room : {};
  if (r.archived) return false;
  const e = (event && typeof event === 'object') ? event : {};
  const end = Date.parse(e.endAt || e.date || '');
  if (!Number.isFinite(end)) return false;          // 日付が読めないものは畳まない（未定・毎週など）
  const grace = (Number(r.graceDays) || EVENT_ARCHIVE_GRACE_DAYS) * 86400000;
  return nowMs > end + grace;
}

// ルームを畳む（消さない）。理由と時刻を残し、あとから戻せるようにする。
export function archiveRoom(room, reason, nowIso = new Date().toISOString()) {
  const r = (room && typeof room === 'object') ? { ...room } : {};
  if (r.archived) return r;
  r.archived = true;
  r.archivedAt = nowIso;
  r.archivedReason = String(reason || '').slice(0, 120);
  return r;
}

export function unarchiveRoom(room) {
  const r = (room && typeof room === 'object') ? { ...room } : {};
  delete r.archived; delete r.archivedAt; delete r.archivedReason;
  return r;
}

// 畳まれたルームは既定の一覧から隠すが、明示的に求められたら出す。
export function visibleRooms(rooms, { includeArchived = false } = {}) {
  return (Array.isArray(rooms) ? rooms : []).filter(r => includeArchived || !(r && r.archived));
}

// 全社アナウンスと店舗ルームは畳めない（業務の土台なので消えると連絡経路が失われる）。
export function canArchive(room) {
  const r = (room && typeof room === 'object') ? room : {};
  if (String(r.id) === ANNOUNCE_ROOM_ID) return { ok: false, reason: '全社アナウンスは畳めません' };
  if (r.kind === 'store') return { ok: false, reason: '店舗ルームは店舗一覧の変更でのみ畳まれます' };
  return { ok: true, reason: '' };
}
