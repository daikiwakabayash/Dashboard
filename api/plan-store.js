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

import { getVotingState, validateVote, upsertVote, removeVote } from '../lib/thanksgift.js';

// Vercel KV / Upstash Redis / Vercel Redis いずれの環境変数名でも動くよう両対応（REST APIは共通）
const KV_URL = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_REST_API_URL || '';
const KV_TOKEN = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_API_TOKEN || '';
const SB_URL = () => process.env.SUPABASE_URL || '';
const SB_KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
const GAS_URL = () => process.env.PLAN_GAS_URL || process.env.SETTLEMENT_GAS_URL || '';
const GOALS_KEY = 'naoru:plan:goals';
const ACTIONS_KEY = 'naoru:plan:actions';
const ALLOWANCE_KEY = 'naoru:allowance:v1'; // { submissions:[...], productivity:{staffId:{'YYYY-MM':gross}} }
const ACCTMETA_KEY = 'naoru:accountmeta:v1'; // { owner: { role, staffId, staffName } }
const ZKTHERAPIST_KEY = 'naoru:zktherapist:v1'; // { 'shopName|YYYY-MM': count } 全体管理シートのセラピスト数 手動上書き
const THANKSGIFT_KEY = 'naoru:thanksgift:v1'; // { votes:[{id,period,fromStaffId,fromStaffName,fromShop,toStaffId,toStaffName,toShop,comment,createdAt}] } サンクスギフト投票

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

  // ── 全体管理シート セラピスト数の手動上書き: ?type=zktherapist ──
  // { 'shopName|YYYY-MM': count } を全端末で共有。SalonOne売上分析の店舗別セラピスト数もこの値を優先。
  const isZkTher = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'zktherapist';
  if (isZkTher) {
    if (!hasKV && !hasSB && !gas) return res.status(200).json({ overrides: {}, configured: false });
    try {
      const cur = (await blobGet(ZKTHERAPIST_KEY, hasKV, hasSB, gas)) || {};
      const overrides = (cur && typeof cur === 'object') ? cur : {};
      if (req.method === 'GET') return res.status(200).json({ overrides, configured: true });
      const body = req.body || {};
      if (body.action === 'set' && body.key) {
        const next = { ...overrides };
        if (body.value == null || body.value === '') delete next[String(body.key)];
        else next[String(body.key)] = Number(body.value) || 0;
        await blobSet(ZKTHERAPIST_KEY, next, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ ok: false, error: 'invalid zktherapist action' });
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
    }
  }

  // ── サンクスギフト（感謝の投票）ストア: ?type=thanksgift ──
  // スタッフが月1票（前月の対象月へ）感謝を送る。全端末共有・月別に蓄積。
  const isThanks = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'thanksgift';
  if (isThanks) {
    if (!hasKV && !hasSB && !gas) return res.status(200).json({ votes: [], votingState: getVotingState(), configured: false });
    try {
      const cur = (await blobGet(THANKSGIFT_KEY, hasKV, hasSB, gas)) || {};
      const votes = Array.isArray(cur.votes) ? cur.votes : [];
      const log = Array.isArray(cur.log) ? cur.log : []; // 送信履歴（追記のみ・編集履歴を残す）
      const test = (cur.test && typeof cur.test === 'object') ? cur.test : { open: false, period: '' };
      // 公開済みの対象月（root が【公開】した月のみ、受け取った側に感謝内容が表示される）
      const published = Array.isArray(cur.published) ? cur.published.filter(p => /^\d{4}-\d{2}$/.test(String(p))).map(String) : [];
      // 全店ディレクトリ（店舗・スタッフ）: SSOでスコープされたスタッフでも「他店」へ感謝を送れるよう、
      // 広い閲覧権限のセッション（root/brand_admin等）が保存した全店の店舗・スタッフ一覧を共有する。
      const dir = (cur.dir && typeof cur.dir === 'object') ? { shops: Array.isArray(cur.dir.shops) ? cur.dir.shops : [], staff: Array.isArray(cur.dir.staff) ? cur.dir.staff : [], updatedAt: cur.dir.updatedAt || '' } : { shops: [], staff: [], updatedAt: '' };
      // テストモード: root が任意の対象月を「受付中」にできる（期間外テスト用）。通常は期間ロジックに従う。
      const base = getVotingState();
      const state = (test.open && /^\d{4}-\d{2}$/.test(String(test.period || '')))
        ? { ...base, open: true, targetMonth: String(test.period), test: true }
        : { ...base, test: false };
      if (req.method === 'GET') {
        return res.status(200).json({ votes, log, votingState: state, test, published, dir, configured: true });
      }
      const body = req.body || {};
      const action = body.action;
      // 全店ディレクトリの保存（マージ）: 店舗・スタッフをidでupsert。広い権限のセッションが呼ぶ。
      if (action === 'setdir') {
        const mergeById = (base, incoming, keys) => {
          const map = new Map((Array.isArray(base) ? base : []).map(x => [String(x.id), x]));
          for (const it of (Array.isArray(incoming) ? incoming : [])) {
            const id = String(it && it.id || '');
            if (!id) continue;
            const prev = map.get(id) || {};
            const next = { id };
            for (const k of keys) next[k] = (it[k] != null && it[k] !== '') ? it[k] : prev[k];
            map.set(id, next);
          }
          return [...map.values()];
        };
        const nextDir = {
          shops: mergeById(dir.shops, body.shops, ['name']).slice(0, 500),
          staff: mergeById(dir.staff, body.staff, ['name', 'shopId', 'deleted']).slice(0, 8000),
          updatedAt: new Date().toISOString(),
        };
        await blobSet(THANKSGIFT_KEY, { votes, log, test, published, dir: nextDir }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, dir: nextDir });
      }
      // テストモードの切替（root用UIから。期間外でも指定月を受付にできる）
      if (action === 'settest') {
        const nextTest = { open: !!body.open, period: String(body.period || '') };
        await blobSet(THANKSGIFT_KEY, { votes, log, test: nextTest, published, dir }, hasKV, hasSB, gas);
        const st2 = (nextTest.open && /^\d{4}-\d{2}$/.test(nextTest.period))
          ? { ...base, open: true, targetMonth: nextTest.period, test: true }
          : { ...base, test: false };
        return res.status(200).json({ ok: true, test: nextTest, votingState: st2 });
      }
      // 公開/非公開の切替（root用UIから。指定した対象月の感謝を受け取った側に表示するか）
      if (action === 'publish' && /^\d{4}-\d{2}$/.test(String(body.period || ''))) {
        const p = String(body.period);
        const set = new Set(published);
        if (body.publish === false) set.delete(p); else set.add(p);
        const nextPublished = [...set];
        await blobSet(THANKSGIFT_KEY, { votes, log, test, published: nextPublished, dir }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, published: nextPublished });
      }
      if (action === 'vote' && body.vote) {
        const v = body.vote;
        // サーバー側でも投票期間・対象月・自分不可を強制（UIすり抜け防止）
        if (!state.open) return res.status(200).json({ ok: false, error: 'closed', votingState: state });
        if (String(v.period) !== String(state.targetMonth)) return res.status(200).json({ ok: false, error: 'wrong_period', votingState: state });
        const chk = validateVote(v);
        if (!chk.ok) return res.status(200).json({ ok: false, error: chk.error });
        const rec = {
          period: String(v.period),
          fromStaffId: String(v.fromStaffId), fromStaffName: String(v.fromStaffName || ''), fromShop: String(v.fromShop || ''),
          toStaffId: String(v.toStaffId), toStaffName: String(v.toStaffName || ''), toShop: String(v.toShop || ''),
          comment: String(v.comment || '').slice(0, 500),
          createdAt: new Date().toISOString(),
        };
        const next = upsertVote(votes, rec);
        // 送信履歴に追記（編集も1件ずつ残す）。上限3000件でリングバッファ。
        const already = votes.some(x => x && x.id === `${rec.period}__${rec.fromStaffId}`);
        const nextLog = [...log, { ...rec, action: already ? 'edit' : 'submit', id: `${rec.period}__${rec.fromStaffId}__${Date.now()}` }].slice(-3000);
        await blobSet(THANKSGIFT_KEY, { votes: next, log: nextLog, test, published, dir }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, id: `${rec.period}__${rec.fromStaffId}` });
      }
      if (action === 'delete' && body.period && body.fromStaffId) {
        if (!state.open || String(body.period) !== String(state.targetMonth)) {
          return res.status(200).json({ ok: false, error: 'closed', votingState: state });
        }
        const next = removeVote(votes, String(body.period), String(body.fromStaffId));
        const nextLog = [...log, { period: String(body.period), fromStaffId: String(body.fromStaffId), action: 'delete', createdAt: new Date().toISOString(), id: `${body.period}__${body.fromStaffId}__${Date.now()}` }].slice(-3000);
        await blobSet(THANKSGIFT_KEY, { votes: next, log: nextLog, test, published, dir }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ ok: false, error: 'invalid thanksgift action' });
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
