// ── Actor（実行者）の共通表現 ─────────────────────────────────────────────
// Dashboard 全体で「誰が操作しているか」を1つの形に揃える。
// Identity / Permission の Source of Truth は **SalonOne**（CHAT_EXISTING_INTEGRATION_AUDIT.md §8）。
// Dashboard が独自に持つのは root / 本部(hq) の Override だけ。
//
//   actor = {
//     tenant_id, user_id, staff_id, role,
//     accessible_store_ids: [],      // SalonOne の accessible_shops[].id が正
//     source: 'salonone'|'dashboard'|'claimed'|'system'|'agent',
//     verified: boolean,             // サーバー側で身元を検証できたか
//     alt_ids: [],                   // 同一人物の別ID（user_id / staff_id / '__root__' など）
//     store_names: [],               // 移行期のフォールバック（store_id が無いデータ用）
//     acting_for: actor|null,        // AI Agent が代理している人間
//   }
//
// 検証の優先順位（サーバー側）:
//   1) Authorization: Bearer <SalonOne access_token>  → /me で検証（source='salonone'・verified）
//   2) X-Chat-Token（settlement-auth の rootトークン）→ root / 本部(hq)（source='dashboard'・verified）
//   3) いずれも無い → 申告値（source='claimed'・verified:false）＝ 原則 DENY 扱い
//
// I/O は resolveActorFromRequest のみ。他はすべて純粋関数。テスト: tests/actor.test.js

import { hashOwnerToken } from './settlement.js';
import { verifySalonOneBearer, bearerFromReq } from './salonone-auth.js';

export const DEFAULT_TENANT_ID = 'default';
export const ROOT_OWNER = '__root__';
// settlement-auth と同じソルト既定値（lib/handlers/settlement-auth.js と一致させること）
export const DEFAULT_AUTH_SALT = 'naoru-settlement-2026';

export const ROLES = ['root', 'hq', 'owner', 'manager', 'staff', 'agent', 'system'];

const str = (v) => String(v == null ? '' : v);
const arr = (v) => (Array.isArray(v) ? v : []);
const uniq = (a) => [...new Set(a)];

// SalonOne のロール名も受け付けて正規化する（brand_admin / shop_admin / shop_staff）。
export function normalizeRole(role, opts = {}) {
  const r = str(role).toLowerCase();
  if (r === 'brand_admin') return 'root';
  if (r === 'shop_admin') return 'owner';
  if (r === 'shop_staff') return 'staff';
  if (ROLES.includes(r)) return r;
  if (opts.root) return 'root';     // role 未指定でも root フラグがあれば root（既存クライアント互換）
  return 'staff';                   // 既定は最小権限
}

// actor を組み立てる（未知フィールドは落とす）。camelCase の入力も受ける。
export function makeActor(input = {}) {
  const i = input || {};
  const role = normalizeRole(i.role, { root: !!i.root });
  const staffId = str(i.staff_id ?? i.staffId);
  const userId = str(i.user_id ?? i.userId);
  const actor = {
    tenant_id: str(i.tenant_id ?? i.tenantId) || DEFAULT_TENANT_ID,
    user_id: userId,
    staff_id: staffId || userId,                     // チャットの本人IDは staff_id を優先
    role,
    accessible_store_ids: uniq(arr(i.accessible_store_ids ?? i.storeIds).map(str).filter(Boolean)),
    store_names: uniq(arr(i.store_names ?? i.shopNames ?? i.shops).map(str).filter(Boolean)),
    source: ['salonone', 'dashboard', 'claimed', 'system', 'agent'].includes(str(i.source)) ? str(i.source) : 'claimed',
    verified: !!i.verified,
    alt_ids: [],
    acting_for: null,
  };
  actor.alt_ids = uniq([actor.staff_id, userId, ...arr(i.alt_ids ?? i.altIds).map(str)].filter(Boolean));
  if (role === 'agent') {
    const human = i.acting_for ?? i.actingFor;
    const h = human ? makeActor(human) : null;
    actor.acting_for = (h && h.role === 'agent') ? null : h;   // agent の入れ子は禁止
    actor.source = 'agent';
  }
  return actor;
}

// AI エージェントの actor を人間から作る（権限は必ず人間の部分集合）。
export function agentActor(human) {
  const h = makeActor(human || {});
  return makeActor({
    tenant_id: h.tenant_id,
    staff_id: '__ai__',
    role: 'agent',
    accessible_store_ids: h.accessible_store_ids,
    store_names: h.store_names,
    verified: h.verified,
    acting_for: h,
  });
}

// この ID は自分か（別IDも含めて判定）。SSO の user_id/staff_id 取り違え対策。
export function isSelfId(actor, id) {
  const target = str(id);
  if (!target) return false;
  return arr((actor || {}).alt_ids).map(str).includes(target);
}

// テナント一致（レコード側に tenant_id が無い＝既定テナントの既存データとみなす）
export function sameTenant(actor, rec) {
  const at = str((actor || {}).tenant_id) || DEFAULT_TENANT_ID;
  const rt = str((rec || {}).tenant_id ?? (rec || {}).tenantId) || DEFAULT_TENANT_ID;
  return at === rt;
}

// 同一人物か（テナントを跨いだ staff_id 衝突を区別する）
export function sameActor(a, b) {
  if (!a || !b) return false;
  const ka = `${str(a.tenant_id) || DEFAULT_TENANT_ID}:${str(a.staff_id)}`;
  const kb = `${str(b.tenant_id) || DEFAULT_TENANT_ID}:${str(b.staff_id)}`;
  return !!str(a.staff_id) && ka === kb;
}

// サーバー側で確認できた別ID（例: accountmeta に保存された本部アカウントの staffId）を足す。
// ⚠️ クライアントの申告ではなく、サーバーが持つデータから足すこと。
export function withAltIds(actor, ids) {
  const extra = arr(ids).map(str).filter(Boolean);
  if (!actor || !extra.length) return actor;
  return makeActor({ ...actor, alt_ids: [...arr(actor.alt_ids), ...extra] });
}

// ── リクエストからの identity 解決 ───────────────────────────────────────

export function resolveTenantId(req, env = {}) {
  const h = (req && req.headers) || {};
  const fromHeader = str(h['x-tenant-id'] || h['X-Tenant-Id']);
  return fromHeader || str(env.TENANT_ID) || DEFAULT_TENANT_ID;
}

// settlement-auth が発行する rootToken と同じ値を再計算する。
export function rootTokenOf(password, salt) {
  if (!password) return '';
  return hashOwnerToken(ROOT_OWNER, String(password), salt || DEFAULT_AUTH_SALT);
}

export function authHeaders(req) {
  const h = (req && req.headers) || {};
  const pick = (k) => str(h[k] || h[k.toLowerCase()] || h[k.toUpperCase()]);
  return {
    bearer: bearerFromReq(req),
    owner: pick('x-chat-owner'),
    token: pick('x-chat-token'),
    role: pick('x-chat-role'),
  };
}

// SalonOne の /me 結果 → actor（純粋）。**accessible_shops[].id を店舗権限の正とする。**
export function actorFromSalonOne(me, tenantId = DEFAULT_TENANT_ID) {
  if (!me) return null;
  return makeActor({
    tenant_id: tenantId,
    user_id: str(me.userId ?? me.user_id),
    staff_id: str(me.staffId ?? me.staff_id) || str(me.userId ?? me.user_id),
    role: me.role,                                   // brand_admin/shop_admin/shop_staff を写像
    accessible_store_ids: arr(me.shopIds ?? me.shop_ids),
    store_names: arr(me.shopNames ?? me.shop_names),
    source: 'salonone',
    verified: true,
  });
}

// settlement-auth の rootトークン → actor（root / 本部hq）。Dashboard 側 Override の担い手。
export function actorFromRootToken(headers, env = {}, tenantId = DEFAULT_TENANT_ID) {
  const expected = rootTokenOf(env.DASHBOARD_PASSWORD, env.AUTH_SALT || DEFAULT_AUTH_SALT);
  if (!expected || !headers || str(headers.token) !== expected) return null;
  const role = str(headers.role) === 'hq' ? 'hq' : 'root';
  const owner = str(headers.owner) || ROOT_OWNER;
  return makeActor({
    tenant_id: tenantId,
    user_id: owner,
    // root 共有ログインのチャットIDは '__root__'。本部(hq)は本人名（or 紐付けた staff_id）。
    staff_id: role === 'hq' ? owner : ROOT_OWNER,
    alt_ids: [owner, ROOT_OWNER],
    role,
    source: 'dashboard',
    verified: true,
  });
}

// body の申告値（未検証）。既存クライアント互換のため従来の形もそのまま受ける。
export function claimedActor(body = {}, tenantId = DEFAULT_TENANT_ID) {
  return makeActor({
    tenant_id: tenantId,
    staff_id: str(body.staffId || body.actorId),
    role: body.role || (body.root ? 'root' : ''),
    root: !!body.root,
    accessible_store_ids: arr(body.storeIds),
    store_names: arr(body.shopNames || body.shops),
    source: 'claimed',
    verified: false,
  });
}

// リクエスト → actor（I/O あり）。verifyBearer はテストで差し替え可能。
export async function resolveActorFromRequest(req, opts = {}) {
  const env = opts.env || process.env || {};
  const tenantId = resolveTenantId(req, env);
  const body = (req && req.body) || {};
  const headers = authHeaders(req);

  if (headers.bearer) {
    const verify = opts.verifyBearer || verifySalonOneBearer;
    const me = await verify(headers.bearer).catch(() => null);
    const a = actorFromSalonOne(me, tenantId);
    if (a && a.staff_id) return a;
  }
  const rootActor = actorFromRootToken(headers, env, tenantId);
  if (rootActor) return rootActor;
  return claimedActor(body, tenantId);
}
