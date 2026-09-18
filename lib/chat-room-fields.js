// ── Room の付加フィールド（storeId / eventId / status / autoMembers）────────
// ②の差分計算（lib/chat-rooms.js）が出した結果を保存できるようにするための、
// **保存側の約束**だけを持つモジュール。差分計算そのものは②の実装を使い、①では作らない。
//
// 設計の芯:
//   1. これらは **サーバーが管理する**フィールド。任意のクライアントが自由に書けない。
//      createRoom / setRoom の本文に入っていても**無視**する（なりすまし防止）。
//   2. 既存Roomを更新するときに **黙って消えない**こと（createRoom は作り直すため要注意）。
//   3. `autoMembers` は「同期が追加した人の記録」。**閲覧・送信権限の正本ではない**。
//      権限は authz（lib/authz.js）が都度判定する。ここは履歴にすぎない。

// サーバーが管理するフィールド（クライアントからは書けない）
export const MANAGED_FIELDS = Object.freeze(['storeId', 'eventId', 'status', 'autoMembers']);

const arr = (v, cap = 500) =>
  (Array.isArray(v) ? v.filter(x => x != null && x !== '').map(String).slice(0, cap) : []);
const str = (v, n = 64) => String(v == null ? '' : v).slice(0, n);

// 付加フィールドを正規化する。値が無ければ **キー自体を作らない**
// （空配列を置くと「同期対象だが誰もいない」と読めてしまい、旧Roomと区別できなくなる）。
export function normalizeManaged(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const out = {};
  if (r.storeId != null && r.storeId !== '') out.storeId = str(r.storeId);
  if (r.eventId != null && r.eventId !== '') out.eventId = str(r.eventId);
  if (r.status != null && r.status !== '') out.status = str(r.status, 24);
  if (Array.isArray(r.autoMembers)) out.autoMembers = [...new Set(arr(r.autoMembers))];
  return out;
}

// クライアント入力から管理フィールドを**取り除く**。
// 「autoMembers を自分で送って自動所属を偽装する」経路を作らないため。
export function stripManaged(input) {
  const r = (input && typeof input === 'object') ? { ...input } : {};
  for (const k of MANAGED_FIELDS) delete r[k];
  return r;
}

/**
 * 既存Roomの管理フィールドを、新しいRoomオブジェクトへ引き継ぐ。
 * createRoom は room を作り直すため、これを通さないと付加情報が消える。
 * @param prev 既存Room（無ければ null）
 * @param next これから保存するRoom（クライアント入力由来）
 */
export function carryManaged(prev, next) {
  const base = stripManaged(next);
  if (!prev || typeof prev !== 'object') return base;
  return { ...base, ...normalizeManaged(prev) };
}

/**
 * 「自動所属」かどうか。**autoMembers が無いRoomは判定しない**。
 * 旧Roomには autoMembers が無い。そこで「メンバー全員が自動所属」と推定すると、
 * 手で入れた人まで同期が外してしまう。無い場合は常に false（＝手動扱い＝守る）。
 */
export function isAutoMember(room, staffId) {
  const r = (room && typeof room === 'object') ? room : {};
  if (!Array.isArray(r.autoMembers)) return false;   // ← 未設定は推定しない
  return r.autoMembers.map(String).includes(String(staffId));
}

// 同期が自動で外してよい人か。自動所属として記録されている人だけ。
// 追加理由が分からない人（autoMembers に無い人）は外さない。
export function canAutoRemove(room, staffId) {
  return isAutoMember(room, staffId);
}

/**
 * 人が members を編集したときの autoMembers の更新。
 *
 * 決めごと（同じ人が自動所属と手動追加の両方に該当する場合）:
 *   - 人が**新しく追加した**人は autoMembers から外す＝**手動参加に昇格**する。
 *     以後その人は同期の自動削除の対象外になる。「人が入れた」意図を、
 *     あとから同期が取り消せないようにするため。
 *   - members から外れた人は autoMembers からも外す（記録を残さない）。
 *   - それ以外（元からいる人）は触らない。
 *
 * @param room      既存Room
 * @param nextMembers 変更後のメンバー
 * @param opts      { by: 'human' | 'sync' }  sync のときは昇格させない
 */
export function reconcileAutoMembers(room, nextMembers, opts = {}) {
  const r = (room && typeof room === 'object') ? room : {};
  if (!Array.isArray(r.autoMembers)) return null;     // 未設定のRoomは作らない（推定しない）
  const before = new Set((r.members || []).map(String));
  const after = new Set(arr(nextMembers));
  const auto = new Set(r.autoMembers.map(String));

  for (const id of auto) if (!after.has(id)) auto.delete(id);          // 抜けた人は記録も消す
  if (opts.by !== 'sync') {
    for (const id of after) if (!before.has(id)) auto.delete(id);      // 人が入れた＝手動へ昇格
  }
  return [...auto];
}

// 保存直前のRoomへ管理フィールドを反映する（members変更に追随させる）。
export function applyMemberChange(room, nextMembers, opts = {}) {
  const next = { ...(room || {}), members: arr(nextMembers) };
  const auto = reconcileAutoMembers(room, nextMembers, opts);
  if (auto) next.autoMembers = auto; else delete next.autoMembers;
  return next;
}
