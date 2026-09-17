// ── 社内チャット サーバー側 identity 解決 ────────────────────────────────
// リクエスト（ヘッダ + body の申告値）から「検証済み actor」を作る。
// CHAT_PERMISSION_MATRIX.md §6 の検証優先順位を実装する:
//   1) Authorization: Bearer <SalonOne access_token>  → /me で検証（verified）
//   2) X-Chat-Owner / X-Chat-Token（settlement-auth のトークン）→ root/hq を検証（verified）
//   3) いずれも無い → body の申告値を使う（verified:false）
//
// ⚠️ verified:false のセッションは enforcementMode='strict' で書き込みを拒否する。
//    既定は 'shadow' なので、既存クライアント（ヘッダを送らない）でも従来どおり動作する。
//
// 純粋部分（ヘッダ抽出・actor 組み立て）と I/O 部分（SalonOne /me 検証）を分離し、
// 純粋部分は tests/chat-identity.test.js でカバーする。

import { makeActor, DEFAULT_TENANT_ID } from './chat-authz.js';
import { hashOwnerToken } from './settlement.js';
import { verifySalonOneBearer, bearerFromReq } from './salonone-auth.js';

const str = (v) => String(v == null ? '' : v);
const arr = (v) => (Array.isArray(v) ? v : []);

// テナント解決。ヘッダ > 環境変数 > 既定。
// （将来のホワイトラベル運用を見据え、いまから全レコードに tenantId を持たせる）
export function resolveTenantId(req, env = {}) {
  const h = (req && req.headers) || {};
  const fromHeader = str(h['x-tenant-id'] || h['X-Tenant-Id']);
  return fromHeader || str(env.TENANT_ID) || DEFAULT_TENANT_ID;
}

// settlement-auth と同じソルト既定値（lib/handlers/settlement-auth.js と一致させること）
export const DEFAULT_AUTH_SALT = 'naoru-settlement-2026';
export const ROOT_OWNER = '__root__';

// settlement-auth が発行する rootToken と同じ値を再計算する。
export function rootTokenOf(password, salt) {
  if (!password) return '';
  return hashOwnerToken(ROOT_OWNER, String(password), salt || DEFAULT_AUTH_SALT);
}

// ヘッダから認証材料を取り出す（純粋）
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

// body の申告値から actor を作る（未検証）。既存クライアント互換のため
// { staffId, root, shops, role } という従来の形をそのまま受ける。
export function claimedActor(body = {}, tenantId = DEFAULT_TENANT_ID) {
  return makeActor({
    tenantId,
    actorId: str(body.staffId || body.actorId),
    role: body.role || (body.root ? 'root' : ''),
    root: !!body.root,
    storeIds: arr(body.storeIds),
    shopNames: arr(body.shopNames || body.shops),
    verified: false,
  });
}

// SalonOne の /me 結果 → actor（純粋）
export function actorFromSalonOne(me, tenantId = DEFAULT_TENANT_ID) {
  if (!me) return null;
  // フロント（index.html の chatMyId）は staff_id ?? user_id を本人IDに使う。
  // サーバー側も同じ優先順位にし、両方を altIds に入れて取り違えを防ぐ。
  const staffId = str(me.staffId) || str(me.userId);
  return makeActor({
    tenantId,
    actorId: staffId,
    altIds: [staffId, str(me.userId)],
    role: me.role,                       // brand_admin/shop_admin/shop_staff は normalizeRole が写像
    storeIds: arr(me.shopIds),
    shopNames: arr(me.shopNames),
    verified: true,
  });
}

// root / hq の settlement-auth トークン → actor（純粋）
// hq も settlement-auth が rootToken を発行するため、同じトークンで検証できる。
// role ヘッダが 'hq' のときは role を hq のまま保持する（表示名が本人名になる既存仕様）。
export function actorFromRootToken(headers, env = {}, tenantId = DEFAULT_TENANT_ID) {
  const expected = rootTokenOf(env.DASHBOARD_PASSWORD, env.AUTH_SALT || DEFAULT_AUTH_SALT);
  if (!expected || !headers || str(headers.token) !== expected) return null;
  const role = str(headers.role) === 'hq' ? 'hq' : 'root';
  const owner = str(headers.owner) || ROOT_OWNER;
  return makeActor({
    tenantId,
    // root 共有ログインのチャットIDは '__root__'。本部(hq)は本人名（or 紐付けた staffId）。
    actorId: role === 'hq' ? owner : ROOT_OWNER,
    altIds: [owner, ROOT_OWNER],
    role,
    verified: true,
  });
}

// リクエスト → actor（I/O あり）。検証できなければ申告値を verified:false で返す。
// verifyBearer は差し替え可能（テスト用）。
export async function resolveActorFromRequest(req, opts = {}) {
  const env = opts.env || process.env || {};
  const tenantId = resolveTenantId(req, env);
  const body = (req && req.body) || {};
  const headers = authHeaders(req);

  // 1) SalonOne SSO Bearer
  if (headers.bearer) {
    const verify = opts.verifyBearer || verifySalonOneBearer;
    const me = await verify(headers.bearer).catch(() => null);
    const a = actorFromSalonOne(me, tenantId);
    if (a && a.actorId) return a;
  }

  // 2) settlement-auth の root/hq トークン
  const rootActor = actorFromRootToken(headers, env, tenantId);
  if (rootActor) return rootActor;

  // 3) 未検証（申告値）
  return claimedActor(body, tenantId);
}

// サーバー側で確認できた別ID（例: accountmeta に保存された本部アカウントの staffId）を足す。
// クライアントの申告ではなくサーバーが持つデータから足すこと（DM の可視判定に効くため）。
export function withAltIds(actor, ids) {
  const extra = arr(ids).map(str).filter(Boolean);
  if (!actor || !extra.length) return actor;
  return makeActor({ ...actor, altIds: [...arr(actor.altIds), ...extra] });
}
