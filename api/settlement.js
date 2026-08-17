// ── 返金明細書 統合ディスパッチャ ───────────────────────────────
// Vercel Hobbyの関数数上限(12)対策で、返金明細書系の3ハンドラを1関数に集約。
// 実体は lib/handlers/ に分離（lib配下はServerless Functionとしてカウントされない）。
// 旧URLは vercel.json の rewrites で ?fn= を付与して振り分ける（フロントは変更不要）:
//   /api/settlement-auth   → /api/settlement?fn=auth
//   /api/settlement-owners → /api/settlement?fn=owners
//   /api/settlement-store  → /api/settlement?fn=store（既定）
import authHandler from '../lib/handlers/settlement-auth.js';
import ownersHandler from '../lib/handlers/settlement-owners.js';
import storeHandler from '../lib/handlers/settlement-store.js';

export default function handler(req, res) {
  const fn = (req.query && req.query.fn) || 'store';
  if (fn === 'auth') return authHandler(req, res);
  if (fn === 'owners') return ownersHandler(req, res);
  return storeHandler(req, res);
}
