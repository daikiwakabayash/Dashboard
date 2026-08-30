// ── KV(Upstash/Vercel Redis) 汎用ブロブ 共有ヘルパー ────────────────
// アカウントのパスワード等、スプレッドシートに置くと型変換で壊れる値（例: 先頭0が消える
// 数字パスワード 0123456789→123456789）を、KVにテキストとして安全に保存/取得するための最小実装。
// REST APIは Upstash 互換（/get/:key, /set/:key）。env名は複数フォーマットに両対応。

const KV_URL = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_REST_API_URL || '';
const KV_TOKEN = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_API_TOKEN || '';

export function kvConfigured() {
  return !!(KV_URL() && KV_TOKEN());
}

export async function kvBlobGet(key) {
  if (!kvConfigured()) return null;
  try {
    const r = await fetch(`${KV_URL()}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN()}` } });
    if (!r.ok) return null;
    const j = await r.json().catch(() => ({}));
    if (j && j.result != null) { try { return JSON.parse(j.result); } catch { return null; } }
  } catch {}
  return null;
}

export async function kvBlobSet(key, value) {
  if (!kvConfigured()) return false;
  try {
    const r = await fetch(`${KV_URL()}/set/${encodeURIComponent(key)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN()}`, 'Content-Type': 'text/plain' }, body: JSON.stringify(value),
    });
    return r.ok;
  } catch { return false; }
}

// アカウントのパスワードストア（owner→password のテキスト保持）
export const ACCT_PASS_KEY = 'naoru:acctpass:v1';
