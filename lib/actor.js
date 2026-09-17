// ── サーバー側 本人確認（Actor Resolution）────────────────────────
// 「リクエストを送ってきたのは誰か」をサーバー側で確定する。
// lib/authz.js は「誰が何をしてよいか」だけを判定する純粋な層で、
// 「誰であるか」はここが決める。この2つを分けておくと、認証方式が増えても
// 権限表を触らずに済む。
//
// ⚠️ 現状の /api/plan-store はクライアントが名乗った actor をそのまま使っている。
//    ここが埋まるまで、authz の判定結果は「参考情報」でしかない。
//    そのため cc_authz は既定 'off' で、'enforce' に上げるのは
//    この resolveActor が全経路で機能することを確認してから（AUTHORIZATION_PLAN.md §6）。
//
// 確認の優先順:
//   1. SalonOne Bearer（SSO）      … 上流の /me で検証。役割・アクセス店舗も取れる
//   2. オーナートークン            … 既存 settlement-auth と同じハッシュ照合
//   3. root トークン               … DASHBOARD_PASSWORD 由来
//   4. CRON_SECRET                 … Vercel Cron
//   5. エージェントトークン         … サーバー間のみ。フロントには絶対に出さない
//   いずれも無ければ guest（verified:false）。

import { normalizeActor } from './authz.js';

const str = (v, n) => String(v == null ? '' : v).slice(0, n);

export function bearerOf(req) {
  const h = (req && req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  return (typeof h === 'string' && /^Bearer\s+/i.test(h)) ? h : '';
}
function headerOf(req, name) {
  const h = (req && req.headers) || {};
  return str(h[name] || h[String(name).toLowerCase()], 200);
}

// 依存（トークン検証関数・環境変数）は差し替えられるようにする＝テストで実物を呼ばない。
export async function resolveActor(req, deps) {
  const d = deps || {};
  const env = d.env || process.env;
  const body = (req && req.body) || {};
  const claimed = (body.actor && typeof body.actor === 'object') ? body.actor : {};

  // 1) SalonOne Bearer（SSO）
  const bearer = bearerOf(req);
  if (bearer && d.verifySalonOneBearer) {
    const so = await d.verifySalonOneBearer(bearer).catch(() => null);
    if (so) {
      return normalizeActor({
        id: so.userId || so.loginId || '',
        name: so.loginId || '',
        role: so.role,                       // brand_admin / shop_admin / shop_staff → authz 側で写像
        source: 'ui',
        shops: so.root ? null : (so.shopNames || []),
        verified: true,
      });
    }
  }

  // 2) エージェントトークン（サーバー間。role は名乗れても source は agent で固定）
  const agentToken = headerOf(req, 'x-cc-agent-token');
  if (agentToken && env.CC_AGENT_TOKEN && safeEqual(agentToken, env.CC_AGENT_TOKEN)) {
    return normalizeActor({
      id: str(claimed.id, 60) || 'agent',
      name: str(claimed.name, 80) || 'AI Agent',
      role: 'admin',                          // 読み取りに足りる高さ。承認系は source=agent で必ず拒否される
      source: 'agent',
      shops: null,
      verified: true,
    });
  }

  // 3) Vercel Cron
  const auth = headerOf(req, 'authorization');
  if (env.CRON_SECRET && auth === `Bearer ${env.CRON_SECRET}`) {
    return normalizeActor({ id: 'cron', name: 'cron', role: 'admin', source: 'cron', shops: null, verified: true });
  }

  // 4) root トークン
  const owner = str(body.owner || claimed.id, 60);
  const token = str(body.token, 200);
  if (token && d.rootToken && safeEqual(token, d.rootToken())) {
    return normalizeActor({ id: owner || '__root__', name: '管理者', role: 'root', source: 'ui', shops: null, verified: true });
  }

  // 5) オーナートークン（既存 settlement-auth と同じ照合）
  if (owner && token && d.verifyOwnerToken && d.loadAccounts) {
    const acct = await d.loadAccounts().catch(() => null);
    if (acct && d.verifyOwnerToken(acct.passwords, owner, token)) {
      const meta = (acct.metaMap && acct.metaMap[owner]) || {};
      const shops = (acct.shopsMap && acct.shopsMap[owner]) || [];
      return normalizeActor({
        id: owner, name: meta.staffName || owner,
        role: meta.role || 'owner',           // 'hq' は authz 側で admin に写像
        source: 'ui',
        shops: (meta.role === 'hq' || meta.role === 'admin') ? null : shops,
        verified: true,
      });
    }
  }

  // 6) 確認できなかった。名乗りは残すが verified:false（authz がほぼ全て拒否する）
  return normalizeActor({
    id: str(claimed.id, 60), name: str(claimed.name, 80),
    role: str(claimed.role, 20), source: 'ui', shops: null, verified: false,
  });
}

// 長さの差で早期に返らない比較（タイミング差から秘密を推測されにくくする）
export function safeEqual(a, b) {
  const x = String(a == null ? '' : a), y = String(b == null ? '' : b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
