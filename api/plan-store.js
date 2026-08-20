// ── 事業計画(SalonOne計画)の目標・アクション 共有ストアAPI ───────────────
// 計画タブで入力した「目標」と「アクション(施策)」をサーバーに保存し、
// 全デバイス・全スタッフ間で同期する（従来はブラウザのlocalStorageのみで端末ローカルだった）。
//
// 保存先の優先順位:
//   1) Vercel KV / Upstash Redis  … 環境変数 KV_REST_API_URL / KV_REST_API_TOKEN
//      （VercelのStorageでKVを作成すると自動で入る。GAS不要・推奨）
//   2) Supabase                    … 環境変数 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
//      事前にテーブル作成: create table plan_store (key text primary key, value jsonb, updated_at timestamptz default now());
//   3) GAS スプレッドシート        … 環境変数 PLAN_GAS_URL または SETTLEMENT_GAS_URL
//   いずれも未設定なら configured:false を返し、フロントは localStorage で継続。
//
// GET  /api/plan-store            → { goals:{...}, actions:[...], configured:boolean }
// POST /api/plan-store {goals,actions} → { ok:true }

const KV_URL = () => process.env.KV_REST_API_URL || '';
const KV_TOKEN = () => process.env.KV_REST_API_TOKEN || '';
const SB_URL = () => process.env.SUPABASE_URL || '';
const SB_KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
const GAS_URL = () => process.env.PLAN_GAS_URL || process.env.SETTLEMENT_GAS_URL || '';
const GOALS_KEY = 'naoru:plan:goals';
const ACTIONS_KEY = 'naoru:plan:actions';
const ALLOWANCE_KEY = 'naoru:allowance:v1'; // { submissions:[...], productivity:{staffId:{'YYYY-MM':gross}} }
const ACCTMETA_KEY = 'naoru:accountmeta:v1'; // { owner: { role, staffId, staffName } }

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

// ── Supabase (PostgREST) ──
async function sbGet(key) {
  const r = await fetch(`${SB_URL()}/rest/v1/plan_store?key=eq.${encodeURIComponent(key)}&select=value`, {
    headers: { apikey: SB_KEY(), Authorization: `Bearer ${SB_KEY()}` },
  });
  if (!r.ok) throw new Error(`SB get ${r.status}`);
  const arr = await r.json().catch(() => []);
  return (Array.isArray(arr) && arr[0]) ? arr[0].value : null;
}
async function sbSet(key, value) {
  const r = await fetch(`${SB_URL()}/rest/v1/plan_store`, {
    method: 'POST',
    headers: { apikey: SB_KEY(), Authorization: `Bearer ${SB_KEY()}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`SB set ${r.status}`);
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

// ── 汎用 blob get/set（有効なバックエンドへ振り分け。手当ストア等で使用） ──
async function blobGet(key, hasKV, hasSB, gas) {
  if (hasKV) return await kvGet(key);
  if (hasSB) return await sbGet(key);
  const j = await gasCall(`${gas}?type=kv&key=${encodeURIComponent(key)}`, 'GET');
  return (j && j.value != null) ? j.value : null;
}
async function blobSet(key, value, hasKV, hasSB, gas) {
  if (hasKV) return await kvSet(key, value);
  if (hasSB) return await sbSet(key, value);
  return await gasCall(gas, 'POST', { action: 'saveKv', key, value });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const hasKV = !!(KV_URL() && KV_TOKEN());
  const hasSB = !!(SB_URL() && SB_KEY());
  const gas = GAS_URL();

  // ── 手当（領収書）ストア: ?type=allowance / body.type==='allowance' ──
  const isAllowance = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'allowance';
  if (isAllowance) {
    if (!hasKV && !hasSB && !gas) return res.status(200).json({ submissions: [], productivity: {}, configured: false });
    try {
      const cur = (await blobGet(ALLOWANCE_KEY, hasKV, hasSB, gas)) || {};
      const submissions = Array.isArray(cur.submissions) ? cur.submissions : [];
      const productivity = (cur.productivity && typeof cur.productivity === 'object') ? cur.productivity : {};
      if (req.method === 'GET') {
        return res.status(200).json({ submissions, productivity, configured: true });
      }
      const body = req.body || {};
      const action = body.action;
      if (action === 'submit' && body.submission && body.submission.id) {
        const s = body.submission;
        const next = submissions.filter(x => x && x.id !== s.id);
        next.push(s);
        await blobSet(ALLOWANCE_KEY, { submissions: next, productivity }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, id: s.id });
      }
      if (action === 'delete' && body.id) {
        const next = submissions.filter(x => x && x.id !== body.id);
        await blobSet(ALLOWANCE_KEY, { submissions: next, productivity }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      if (action === 'recordProductivity' && body.staffId && body.month) {
        const p = { ...productivity };
        p[String(body.staffId)] = { ...(p[String(body.staffId)] || {}), [String(body.month)]: Number(body.gross) || 0 };
        await blobSet(ALLOWANCE_KEY, { submissions, productivity: p }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ ok: false, error: 'invalid allowance action' });
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
    }
  }

  // ── アカウント拡張情報（role/staffId/staffName）ストア: ?type=accountmeta ──
  // GAS「オーナー設定」の列に依存せず、KV/Supabase/GASのblobで role/staff を保持する。
  const isAcctMeta = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'accountmeta';
  if (isAcctMeta) {
    if (!hasKV && !hasSB && !gas) return res.status(200).json({ meta: {}, configured: false });
    try {
      const cur = (await blobGet(ACCTMETA_KEY, hasKV, hasSB, gas)) || {};
      const meta = (cur && typeof cur === 'object') ? cur : {};
      if (req.method === 'GET') return res.status(200).json({ meta, configured: true });
      const body = req.body || {};
      if (body.action === 'set' && body.owner) {
        const next = { ...meta };
        next[String(body.owner)] = { role: String(body.role || 'owner'), staffId: String(body.staffId || ''), staffName: String(body.staffName || '') };
        await blobSet(ACCTMETA_KEY, next, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      if (body.action === 'delete' && body.owner) {
        const next = { ...meta }; delete next[String(body.owner)];
        await blobSet(ACCTMETA_KEY, next, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ ok: false, error: 'invalid accountmeta action' });
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
    }
  }

  if (!hasKV && !hasSB && !gas) {
    // 保存先未設定 → フロントはlocalStorageで継続（壊さない）
    return res.status(200).json({ goals: {}, actions: [], configured: false });
  }

  try {
    if (req.method === 'GET') {
      if (hasKV) {
        const [goals, actions] = await Promise.all([kvGet(GOALS_KEY), kvGet(ACTIONS_KEY)]);
        return res.status(200).json({ goals: goals || {}, actions: Array.isArray(actions) ? actions : [], configured: true });
      }
      if (hasSB) {
        const [goals, actions] = await Promise.all([sbGet(GOALS_KEY), sbGet(ACTIONS_KEY)]);
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
      if (hasSB) {
        await Promise.all([sbSet(GOALS_KEY, goals), sbSet(ACTIONS_KEY, actions)]);
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
