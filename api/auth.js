// ── 認証API: パスワードベースの簡易認証 ──────────────────────────
// 環境変数 DASHBOARD_PASSWORD にパスワードを設定
// セッションはクライアント側でlocalStorageに保存（トークンベース）

import { createHash } from 'crypto';

function hashPassword(password, salt) {
  return createHash('sha256').update(password + salt).digest('hex');
}

// req.body が文字列で渡ってきた場合でもパースできるようにする
function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return {}; }
  }
  return body;
}

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // 認証レスポンスはキャッシュさせない
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const parsed = parseBody(req.body);
    const { action, password, token } = parsed;

    const correctPassword = process.env.DASHBOARD_PASSWORD;
    if (!correctPassword) {
      // パスワード未設定の場合は認証をスキップ（開発環境向け）
      return res.status(200).json({ authenticated: true, token: 'dev-mode', message: 'No password configured' });
    }

    // ── ログイン ──
    if (action === 'login') {
      if (!password) {
        return res.status(400).json({ authenticated: false, error: 'パスワードを入力してください' });
      }
      if (password === correctPassword) {
        // シンプルなトークン生成（パスワード + ソルトのハッシュ）
        const salt = process.env.AUTH_SALT || 'naoru-dashboard-2024';
        const authToken = hashPassword(correctPassword, salt);
        return res.status(200).json({ authenticated: true, token: authToken });
      }
      return res.status(401).json({ authenticated: false, error: 'パスワードが正しくありません' });
    }

    // ── トークン検証 ──
    if (action === 'verify') {
      if (!token) {
        return res.status(401).json({ authenticated: false });
      }
      const salt = process.env.AUTH_SALT || 'naoru-dashboard-2024';
      const expectedToken = hashPassword(correctPassword, salt);
      if (token === expectedToken) {
        return res.status(200).json({ authenticated: true });
      }
      return res.status(401).json({ authenticated: false });
    }

    return res.status(400).json({ error: 'Invalid action. Use "login" or "verify".' });
  } catch (err) {
    // 予期せぬエラーも必ず JSON で返す（HTMLエラーページを返さないように）
    console.error('[auth] Unexpected error:', err);
    return res.status(500).json({
      authenticated: false,
      error: 'サーバー内部エラー',
      message: err?.message || String(err),
    });
  }
}
