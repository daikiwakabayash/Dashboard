// ── Dashboard 共通 Authorization（正本）───────────────────────────────────
// 「どのロールが / どの店舗に / どの機能を」使えるかの共通判断。
// Chat 固有のルール（Room の可視・投稿・DM・Broadcast）は lib/chat-policy.js に分ける。
//
// 権限解決の優先順位（CHAT_EXISTING_INTEGRATION_AUDIT.md §8）:
//   1. root / 本部(hq) の Dashboard Override（accountmeta などサーバー側データ）
//   2. SalonOne の正式 Permission（/me の role + accessible_shops[].id・Bearer 検証済み）
//   3. それ以外は DENY
//
// テスト: tests/authz.test.js

import { makeActor, isSelfId, sameTenant, DEFAULT_TENANT_ID } from './actor.js';

const str = (v) => String(v == null ? '' : v);
const arr = (v) => (Array.isArray(v) ? v : []);
const uniq = (a) => [...new Set(a)];

// テナント全体を見られるロール
const TENANT_ADMIN_ROLES = ['root', 'hq'];
// 店舗スコープで動くロール
export const SCOPED_ROLES = ['owner', 'manager', 'staff'];

export function isTenantAdmin(actor) {
  return TENANT_ADMIN_ROLES.includes((actor || {}).role);
}

export function isScopedRole(actor) {
  return SCOPED_ROLES.includes((actor || {}).role);
}

// ── 権限の出どころ（Permission Resolution）──────────────────────────────
// override: root/HQ 用の Dashboard 側設定 { role?, storeIds?, chat? }（サーバー側データのみ渡すこと）
// 戻り値: { actor, source:'override'|'salonone'|'deny', reason }
export function resolvePermission(actor, override) {
  const a = makeActor(actor || {});
  if (!a.verified) return { actor: a, source: 'deny', reason: 'unverified_identity' };

  if (isTenantAdmin(a) && override && typeof override === 'object') {
    // root / 本部だけ Dashboard 側で上書きできる（アクセス店舗・管理対象・Chat権限）
    const next = makeActor({
      ...a,
      role: override.role || a.role,
      accessible_store_ids: arr(override.storeIds).length ? arr(override.storeIds) : a.accessible_store_ids,
      store_names: arr(override.storeNames).length ? arr(override.storeNames) : a.store_names,
    });
    return { actor: next, source: 'override', reason: '' };
  }
  if (a.source === 'salonone') return { actor: a, source: 'salonone', reason: '' };
  if (isTenantAdmin(a) && a.source === 'dashboard') return { actor: a, source: 'override', reason: '' };
  return { actor: a, source: 'deny', reason: 'no_permission_source' };
}

// ── 店舗スコープ ────────────────────────────────────────────────────────

// store_id 単位のアクセス可否（root/hq は全店）
export function canAccessStore(actor, storeId) {
  const a = actor || {};
  if (isTenantAdmin(a)) return true;
  const id = str(storeId);
  if (!id) return false;
  return arr(a.accessible_store_ids).map(str).includes(id);
}

// 移行期のフォールバック: store_id が判らないレコード（旧 store_<店舗名> ルーム等）を店舗名で判定。
// ⚠️ store_id が判る場合は必ず canAccessStore を使うこと。
export function canAccessStoreName(actor, storeName) {
  const a = actor || {};
  if (isTenantAdmin(a)) return true;
  const n = str(storeName);
  if (!n) return false;
  return arr(a.store_names).some(p => p && (n.includes(p) || p.includes(n)));
}

// actor が扱える店舗だけに絞る（stores: [{id,name}]）
export function scopeStores(actor, stores) {
  return arr(stores).filter(s => canAccessStore(actor, (s || {}).id));
}

export function scopeStoreIds(actor, storeIds) {
  return uniq(arr(storeIds).map(str)).filter(id => canAccessStore(actor, id));
}

// スタッフが actor のスコープ内か（store_id 優先・店舗名はフォールバック）
export function staffInScope(actor, staff) {
  const a = actor || {};
  if (isTenantAdmin(a)) return true;
  if (!staff) return false;                       // 名簿に無い staff_id は許可しない
  if (!sameTenant(a, staff)) return false;
  if (isSelfId(a, str(staff.id))) return true;
  const sid = str(staff.storeId ?? staff.store_id ?? staff.shopId ?? staff.shop_id);
  if (sid) return canAccessStore(a, sid);
  return canAccessStoreName(a, str(staff.shop ?? staff.shopName ?? staff.store_name));
}

// ── Chat Rollout（Feature Flag / KV Config・再デプロイ不要）──────────────
// 既定は「root と 本部(hq) だけ ON」。設定ミスで公開されない向きに倒す。
export const DEFAULT_CHAT_ROLLOUT = Object.freeze({
  root: true, hq: true, owner: false, manager: false, staff: false,
  features: Object.freeze({
    recipientPreview: false,   // 複数宛先 / Recipient Preview
    aiMention: false,          // @AI メンション（新UX）
    schedule: false,           // 予約送信
    unreadResend: false,       // 未読者再送
    smartGroup: false,         // Smart Group
    approvals: false,          // 承認センター
    agentActivity: false,      // AI Agent Activity
    authzLog: false,           // Chat Authorization Log
  }),
});

const FEATURE_KEYS = Object.keys(DEFAULT_CHAT_ROLLOUT.features);

// 保存値を正規化（未知キーを落とし、欠けたキーは既定値で埋める）
export function normalizeRollout(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const f = (r.features && typeof r.features === 'object') ? r.features : {};
  const out = { features: {} };
  for (const role of ['root', 'hq', 'owner', 'manager', 'staff']) {
    out[role] = typeof r[role] === 'boolean' ? r[role] : DEFAULT_CHAT_ROLLOUT[role];
  }
  for (const k of FEATURE_KEYS) {
    out.features[k] = typeof f[k] === 'boolean' ? f[k] : DEFAULT_CHAT_ROLLOUT.features[k];
  }
  out.updatedAt = str(r.updatedAt);
  out.updatedBy = str(r.updatedBy);
  return out;
}

// このロールに Chat を公開しているか。
// ⚠️ 身元が検証できていない actor は常に false（UIで隠すだけにしない・サーバー側でも拒否）。
export function chatRolloutAllows(actor, rollout) {
  const a = actor || {};
  const r = normalizeRollout(rollout);
  if (!a.verified) return false;
  if (a.role === 'agent') return chatRolloutAllows(a.acting_for, rollout);
  if (a.role === 'system') return true;
  return r[a.role] === true;
}

export function featureEnabled(rollout, key) {
  const r = normalizeRollout(rollout);
  return r.features[str(key)] === true;
}

// Rollout を変更できるのは root / hq のみ（検証済みであること）
export function canManageRollout(actor) {
  const a = actor || {};
  return !!a.verified && isTenantAdmin(a);
}

// 開発環境（DASHBOARD_PASSWORD も SalonOne キーも未設定＝認証スキップ運用）では
// identity を検証できないため、Rollout ゲートを開ける。本番では必ず false になる。
export function isDevOpen(env = {}) {
  return !str(env.DASHBOARD_PASSWORD) && !str(env.SALONONE_API_KEY);
}

// ── enforcement / kill switch ───────────────────────────────────────────

// 'strict' = 拒否する / 'shadow' = 判定だけして通す（違反を記録）/ 'off' = 判定しない
export function enforcementMode(env = {}) {
  const v = str(env.CHAT_AUTHZ_ENFORCE).toLowerCase();
  if (v === 'strict' || v === 'shadow' || v === 'off') return v;
  return 'shadow';
}

export function killSwitchOn(env = {}, storeFlag) {
  if (storeFlag === true) return true;
  const v = str(env.CHAT_KILL_SWITCH).toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export { DEFAULT_TENANT_ID };
