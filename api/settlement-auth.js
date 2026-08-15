// ── オーナー別PASS認証API（返金明細書ポータル用） ──────────────────
// 環境変数:
//   SETTLEMENT_OWNER_PASSWORDS - JSON { "オーナー名": "パスワード", ... }（オーナー毎に一意なPASS）
//   AUTH_SALT                  - トークン用ソルト（未設定時は既定値）
//
// POST /api/settlement-auth  { action: 'login',  owner?, password } → { ok, owner, token }
// POST /api/settlement-auth  { action: 'verify', owner, token }     → { ok }
// GET  /api/settlement-auth                                          → { configured, owners: [...] }（PASS露出なし）

import { parseOwnerPasswords, verifyOwnerLogin, verifyOwnerToken, parseOwnerShops, allowedShopsFor } from '../lib/settlement.js';

const SALT = () => process.env.AUTH_SALT || 'naoru-settlement-2026';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const passwords = parseOwnerPasswords(process.env.SETTLEMENT_OWNER_PASSWORDS);
  const shopsMap = parseOwnerShops(process.env.SETTLEMENT_OWNER_SHOPS);
  const configured = Object.keys(passwords).length > 0;

  // オーナー名の一覧＋店舗アクセス設定を返す（本社UI用・PASSは返さない）
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ configured, owners: Object.keys(passwords), shops: shopsMap });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!configured) {
    return res.status(503).json({ ok: false, error: 'SETTLEMENT_OWNER_PASSWORDS が未設定です', setupRequired: true });
  }

  const { action, owner, password, token } = req.body || {};

  if (action === 'login') {
    const r = verifyOwnerLogin(passwords, { owner, password }, SALT());
    if (!r) return res.status(401).json({ ok: false, error: 'パスワードが正しくありません' });
    res.setHeader('Cache-Control', 'no-store');
    // そのオーナーの許可店舗（設定があれば）も返す。owner.html の店舗フィルタ用
    return res.status(200).json({ ok: true, owner: r.owner, token: r.token, shops: allowedShopsFor(shopsMap, r.owner) || [] });
  }

  if (action === 'verify') {
    const ok = verifyOwnerToken(passwords, owner, token, SALT());
    return res.status(ok ? 200 : 401).json({ ok });
  }

  return res.status(400).json({ error: 'Invalid action. Use "login" or "verify".' });
}
