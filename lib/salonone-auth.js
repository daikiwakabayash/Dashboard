// ── サロンワン ユーザートークンのサーバー側検証（SSO→返金明細書などの認可ブリッジ）──
// フロントが持つサロンワンのアクセストークン(Bearer)を、サーバー側で /me を叩いて検証し、
// 「誰か・どの店舗まで・ブランド管理者か」を返す。これにより settlement-store 等の
// GAS/オーナーPASSに依存しない認可（サロンワンのロール・アクセス店舗）を実現する。
//
// 依存: 環境変数 SALONONE_API_KEY（＝プロキシと同じキー）。SALONONE_API_BASE で上書き可。

import { ANALYTICS_BASE } from './salonone.js';

// Bearer を検証して { root, role, shopIds:[], shopNames:[], userId, loginId } を返す。無効なら null。
export async function verifySalonOneBearer(bearer) {
  if (!bearer || typeof bearer !== 'string' || !/^Bearer\s+/i.test(bearer)) return null;
  const key = process.env.SALONONE_API_KEY;
  if (!key) return null;
  const base = (process.env.SALONONE_API_BASE || ANALYTICS_BASE).replace(/\/+$/, '');
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    let r;
    try {
      r = await fetch(`${base}/me`, {
        headers: { 'X-SalonOne-Api-Key': key, Authorization: bearer, Accept: 'application/json' },
        signal: controller.signal,
      });
    } finally { clearTimeout(t); }
    if (!r || !r.ok) return null;
    const j = await r.json().catch(() => ({}));
    const u = (j && j.data) || (j && j.user) || j;
    if (!u || (!u.role && !u.user_id)) return null;
    const role = u.role || 'shop_staff';
    const shops = Array.isArray(u.accessible_shops) ? u.accessible_shops : [];
    return {
      root: role === 'brand_admin',
      role,
      shopIds: shops.map(s => String(s && s.id)).filter(Boolean),
      shopNames: shops.map(s => s && s.name).filter(Boolean),
      userId: String(u.user_id || ''),
      loginId: u.login_id || '',
    };
  } catch { return null; }
}

// req から Authorization ヘッダ（Bearer）を取り出す小ヘルパー。
export function bearerFromReq(req) {
  const h = (req && req.headers && (req.headers['authorization'] || req.headers['Authorization'])) || '';
  return (typeof h === 'string' && /^Bearer\s+/i.test(h)) ? h : '';
}
