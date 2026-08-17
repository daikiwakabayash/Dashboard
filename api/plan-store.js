// ── 事業計画(SalonOne計画)の目標・アクション 共有ストアAPI ───────────────
// 計画タブで入力した「目標」と「アクション(施策)」をサーバーに保存し、
// 全デバイス・全スタッフ間で同期する（従来はブラウザのlocalStorageのみで端末ローカルだった）。
//
// 保存先の優先順位:
//   1) Vercel KV / Upstash Redis  … 環境変数 KV_REST_API_URL / KV_REST_API_TOKEN
//      （VercelのStorageでKVを作成すると自動で入る。GAS不要・推奨）
//   2) GAS スプレッドシート        … 環境変数 PLAN_GAS_URL または SETTLEMENT_GAS_URL
//   どちらも未設定なら configured:false を返し、フロントは localStorage で継続。
//
// GET  /api/plan-store            → { goals:{...}, actions:[...], configured:boolean }
// POST /api/plan-store {goals,actions} → { ok:true }

const KV_URL = () => process.env.KV_REST_API_URL || '';
const KV_TOKEN = () => process.env.KV_REST_API_TOKEN || '';
const GAS_URL = () => process.env.PLAN_GAS_URL || process.env.SETTLEMENT_GAS_URL || '';
const GOALS_KEY = 'naoru:plan:goals';
const ACTIONS_KEY = 'naoru:plan:actions';

// ── Vercel KV (Upstash REST) ──
async function kvGet(key) {
  const r = await fetch(`${KV_URL()}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN()}` },
  });
  if (!r.ok) throw new Error(`KV get ${r.status}`);
  const j = await r.json().catch(() => ({}));
  if (j && j.result != null) { try { return JSON.parse(j.result); } catch { return null; } }
  return null;
}
async function kvSet(key, value) {
  const r = await fetch(`${KV_URL()}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN()}`, 'Content-Type': 'text/plain' },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`KV set ${r.status}`);
  return true;
}

// ── GAS フォールバック ──
async function gasCall(url, method, payload) {
  const opt = { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, redirect: 'follow' };
  if (method === 'POST') opt.body = JSON.stringify(payload);
  const resp = await fetch(url, opt);
  if (!resp.ok) throw new Error(`GAS ${resp.status}`);
  return resp.json().catch(() => ({}));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const hasKV = !!(KV_URL() && KV_TOKEN());
  const gas = GAS_URL();
  if (!hasKV && !gas) {
    // 保存先未設定 → フロントはlocalStorageで継続（壊さない）
    return res.status(200).json({ goals: {}, actions: [], configured: false });
  }

  try {
    if (req.method === 'GET') {
      if (hasKV) {
        const [goals, actions] = await Promise.all([kvGet(GOALS_KEY), kvGet(ACTIONS_KEY)]);
        return res.status(200).json({ goals: goals || {}, actions: Array.isArray(actions) ? actions : [], configured: true });
      }
      const j = await gasCall(`${gas}?type=planStore`, 'GET');
      return res.status(200).json({ goals: (j && j.goals) || {}, actions: Array.isArray(j && j.actions) ? j.actions : [], configured: true });
    }
    if (req.method === 'POST') {
      const body = req.body || {};
      const goals = body.goals || {};
      const actions = Array.isArray(body.actions) ? body.actions : [];
      if (hasKV) {
        await Promise.all([kvSet(GOALS_KEY, goals), kvSet(ACTIONS_KEY, actions)]);
        return res.status(200).json({ ok: true });
      }
      const j = await gasCall(gas, 'POST', { action: 'savePlanStore', goals, actions });
      return res.status(200).json((j && j.ok) ? { ok: true } : { ok: false, error: (j && j.error) || 'save_failed' });
    }
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    // 失敗してもフロントはlocalStorageで継続できるよう 200
    return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
  }
}
