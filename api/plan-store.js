// ── 事業計画(SalonOne計画)の目標・アクション 共有ストアAPI ───────────────
// 計画タブで入力した「目標」と「アクション(施策)」を GAS スプレッドシートに保存し、
// 全デバイス・全スタッフ間で同期する（従来はブラウザのlocalStorageのみで端末ローカルだった）。
//
// 環境変数:
//   SETTLEMENT_GAS_URL （返金明細書と同じGAS Webアプリを再利用）
//     もしくは PLAN_GAS_URL（専用に分けたい場合）
//   ※GAS側は gas/settlement-gas-sample.js の planStore 対応版を配置・再デプロイすること
//
// GET  /api/plan-store            → { goals:{...}, actions:[...], configured:boolean }
// POST /api/plan-store {goals,actions} → { ok:true }

const GAS_URL = () => process.env.PLAN_GAS_URL || process.env.SETTLEMENT_GAS_URL || '';

async function callGas(url, method, payload) {
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

  const url = GAS_URL();
  if (!url) {
    // 未設定でもフロントが壊れないよう 200 で空を返す（localStorageにフォールバック）
    return res.status(200).json({ goals: {}, actions: [], configured: false });
  }

  try {
    if (req.method === 'GET') {
      const j = await callGas(`${url}?type=planStore`, 'GET');
      return res.status(200).json({
        goals: (j && j.goals) || {},
        actions: Array.isArray(j && j.actions) ? j.actions : [],
        configured: true,
      });
    }
    if (req.method === 'POST') {
      const body = req.body || {};
      const j = await callGas(url, 'POST', {
        action: 'savePlanStore',
        goals: body.goals || {},
        actions: Array.isArray(body.actions) ? body.actions : [],
      });
      if (j && j.ok) return res.status(200).json({ ok: true });
      return res.status(200).json({ ok: false, error: (j && j.error) || 'save_failed' });
    }
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    // 失敗してもフロントはlocalStorageで継続できるよう 200
    return res.status(200).json({ ok: false, configured: true, error: String(err && err.message || err) });
  }
}
