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
// 確認の優先順（**ネットワークを使わない方法を先に試す**）:
//   1. エージェントトークン         … ヘッダ照合のみ。サーバー間専用でフロントには出さない
//   2. CRON_SECRET                 … ヘッダ照合のみ
//   3. root トークン               … ハッシュ照合のみ（DASHBOARD_PASSWORD 由来）
//   4. オーナートークン            … ハッシュ照合のみ（既存 settlement-auth と同じ）
//   5. SalonOne Bearer（SSO）      … **上流の /me を叩く＝唯一ネットワークが要る**
//   いずれも無ければ guest（verified:false）。
//
// ⚠️ なぜ Bearer を最後にするか
//   /api/plan-store はチャット6秒・掲示板8秒・プレゼンス30秒で常時ポーリングされる。
//   Bearer を先に試すと、そのたびに SalonOne の /me を呼ぶことになり、
//   レート制限（60/分）を即座に超過してログインまで巻き添えで落ちる。
//   ローカルで判定できるものを先に片付け、Bearer は他に手段が無いときだけ使う。
//   さらに検証結果を短時間キャッシュして、同じトークンで何度も /me を叩かないようにする。

import { normalizeActor } from './authz.js';

const str = (v, n) => String(v == null ? '' : v).slice(0, n);

// ── Bearer 検証の短期キャッシュ ──
// 同じトークンで /me を何度も叩かないための、インスタンス内キャッシュ。
// Serverless は使い捨てなので万能ではないが、連続するポーリングはまとめて吸収できる。
const BEARER_TTL_MS = 60 * 1000;
const bearerCache = new Map();   // key: トークンの短い指紋 → { at, actor }
function fingerprint(token) {                       // トークンそのものを鍵にしない
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 0x01000193) >>> 0;
  return `${token.length}:${h.toString(16)}`;
}
export function _clearBearerCache() { bearerCache.clear(); }   // テスト用

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

  // 1) エージェントトークン（サーバー間。role は名乗れても source は agent で固定）
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

  // 2) Vercel Cron
  const auth = headerOf(req, 'authorization');
  if (env.CRON_SECRET && auth === `Bearer ${env.CRON_SECRET}`) {
    return normalizeActor({ id: 'cron', name: 'cron', role: 'admin', source: 'cron', shops: null, verified: true });
  }

  // 3) root トークン（ハッシュ照合のみ・ネットワーク不要）
  // ⚠️ 秘密（DASHBOARD_PASSWORD）が未設定のときは **絶対に照合しない**。
  //    未設定だと rootToken() は「空文字のハッシュ」＝誰でも計算できる値になり、
  //    それを送るだけで root を名乗れてしまう。環境変数の欠落が認証の無効化に
  //    つながる経路は作らない（未設定なら root 経路そのものを閉じる＝fail closed）。
  // owner/token は本文（POST）だけでなくヘッダ（GET）からも受ける。
  // ⚠️ クエリ文字列からは**受けない**。URLはアクセスログ・Referer・ブラウザ履歴に残るため、
  //    トークンを載せる場所として適さない。GET でもヘッダを使う。
  // ヘッダは ISO-8859-1 しか運べないため、フロントは percent-encode して送る。
  // 日本語のアカウント名（本部の個人名など）を素で入れると fetch 自体が失敗する。
  const unesc = (v) => { const t = str(v, 300); if (!t) return ''; try { return decodeURIComponent(t); } catch (_) { return t; } };
  const owner = str(body.owner || unesc(headerOf(req, 'x-cc-owner')) || claimed.id, 60);
  const token = str(body.token || unesc(headerOf(req, 'x-cc-token')), 200);
  const expectedRoot = d.rootToken ? str(d.rootToken(), 200) : '';
  if (token && expectedRoot && safeEqual(token, expectedRoot)) {
    return normalizeActor({ id: owner || '__root__', name: '管理者', role: 'root', source: 'ui', shops: null, verified: true });
  }

  // 4) オーナートークン（ハッシュ照合のみ・ネットワーク不要）
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

  // 5) SalonOne Bearer（SSO）— ここだけ上流 /me を叩く。結果は短時間キャッシュする。
  const bearer = bearerOf(req);
  if (bearer && d.verifySalonOneBearer) {
    const fp = fingerprint(bearer);
    const now = typeof d.now === 'number' ? d.now : Date.now();
    // ⚠️ 取り返しがつかない操作（承認・フラグ変更・広告変更・SNS投稿など）では
    //    キャッシュを使わず毎回上流へ確かめる。キャッシュに頼ると、トークンを失効
    //    させても最大60秒は有効に見えてしまうため。判定は lib/authz.js の needsReverify()。
    if (!d.skipCache) {
      const hit = bearerCache.get(fp);
      // actor:null = 直近の検証が失敗した。この場合は下の「確認できなかった」へ落とす。
      if (hit && (now - hit.at) < BEARER_TTL_MS && hit.actor) return hit.actor;   // /me を呼ばない
      if (hit && (now - hit.at) < BEARER_TTL_MS) return unverified(claimed);
    }
    const so = await d.verifySalonOneBearer(bearer).catch(() => null);
    if (!so && !d.skipCache) {
      // 失敗（期限切れ・無効トークン）も短時間キャッシュする。ダッシュボードは
      // チャット6秒・掲示板8秒で /api/plan-store を叩くため、ここを素通しにすると
      // 無効トークン1本で SalonOne の 60回/分 を使い切ってしまう。
      bearerCache.set(fp, { at: now, actor: null });
      if (bearerCache.size > 500) bearerCache.clear();
    }
    if (so) {
      const actor = normalizeActor({
        id: so.userId || so.loginId || '',
        name: so.loginId || '',
        role: so.role,                       // brand_admin / shop_admin / shop_staff → authz 側で写像
        source: 'ui',
        shops: so.root ? null : (so.shopNames || []),
        verified: true,
      });
      if (!d.skipCache) bearerCache.set(fp, { at: now, actor });
      if (bearerCache.size > 500) bearerCache.clear();              // 上限を超えたら捨てる
      return actor;
    }
  }

  // 6) 確認できなかった。名乗りは残すが verified:false（authz がほぼ全て拒否する）
  return unverified(claimed);
}

// 本人確認が取れなかったときの主体。名乗りは記録のために残すが verified:false。
function unverified(claimed) {
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
