// ── オーナーアカウント管理API（本社/root専用） ──────────────────
// GAS スプレッドシートの「オーナー設定」シートで、オーナーの
// パスワード・アクセス店舗を追加/変更/削除する。UIから管理でき、
// 環境変数の再デプロイが不要になる。
//
// 認可: 本社ダッシュボードのトークン（DASHBOARD_PASSWORD由来）または root。
//
// GET  /api/settlement-owners?hqToken=...            → { owners: [{owner, shops[], hasPassword, updatedAt}] }（passwordは返さない）
// POST /api/settlement-owners { hqToken, action:'upsert', owner, password?, shops:[] }
// POST /api/settlement-owners { hqToken, action:'delete', owner }

import { createHash } from 'crypto';
import { hashOwnerToken } from '../settlement.js';
import { kvConfigured, kvBlobGet, kvBlobSet, ACCT_PASS_KEY } from '../kvblob.js';

// パスワードをKVにテキスト保存（スプレッドシートの数値化＝先頭0落ち等を回避）。
async function kvSavePassword(owner, password) {
  if (!kvConfigured() || password == null || String(password) === '') return;
  const cur = (await kvBlobGet(ACCT_PASS_KEY)) || {};
  cur[String(owner)] = String(password);
  await kvBlobSet(ACCT_PASS_KEY, cur);
}
async function kvDeletePassword(owner) {
  if (!kvConfigured()) return;
  const cur = (await kvBlobGet(ACCT_PASS_KEY)) || {};
  if (cur[String(owner)] != null) { delete cur[String(owner)]; await kvBlobSet(ACCT_PASS_KEY, cur); }
}

const ROOT = '__root__';
const rootToken = () => hashOwnerToken(ROOT, process.env.DASHBOARD_PASSWORD || '', process.env.AUTH_SALT || 'naoru-settlement-2026');

function hqTokenValid(token) {
  const pw = process.env.DASHBOARD_PASSWORD;
  if (!pw) return true; // 未設定（開発）→ 認可スキップ
  const salt = process.env.AUTH_SALT || 'naoru-dashboard-2024';
  const expected = createHash('sha256').update(pw + salt).digest('hex');
  // 旧: api/auth 形式 / 新: settlement-auth の rootToken（メインダッシュボードのroot統一ログイン）
  return token === expected || token === rootToken() || token === 'dev-mode';
}

async function callGas(url, method, payload) {
  const opt = { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, redirect: 'follow' };
  if (method === 'POST') opt.body = JSON.stringify(payload);
  const resp = await fetch(url, opt);
  if (!resp.ok) throw new Error(`GAS ${resp.status}`);
  return resp.json().catch(() => ({}));
}

const splitShops = (csv) => String(csv || '').split(',').map(s => s.trim()).filter(Boolean);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const gasUrl = process.env.SETTLEMENT_GAS_URL;
  if (!gasUrl) return res.status(503).json({ ok: false, error: 'SETTLEMENT_GAS_URL が未設定です', setupRequired: true });

  const token = req.method === 'GET' ? String(req.query.hqToken || '') : ((req.body || {}).hqToken || '');
  if (!hqTokenValid(token)) return res.status(401).json({ ok: false, error: '本社認証が必要です' });

  try {
    if (req.method === 'GET') {
      const data = await callGas(`${gasUrl}?type=owners`, 'GET');
      const owners = (data.owners || []).map(o => ({
        owner: o.owner, shops: splitShops(o.shops), hasPassword: !!o.password, updatedAt: o.updatedAt || '',
        role: o.role || 'owner', staffId: o.staffId || '', staffName: o.staffName || '',
      }));
      return res.status(200).json({ ok: true, owners });
    }

    if (req.method === 'POST') {
      const { action, owner } = req.body || {};
      if (!owner) return res.status(400).json({ ok: false, error: 'owner が必要です' });
      if (action === 'delete') {
        const out = await callGas(gasUrl, 'POST', { action: 'deleteOwner', owner });
        await kvDeletePassword(owner);
        return res.status(200).json({ ok: true, gas: out });
      }
      if (action === 'upsert') {
        const shops = Array.isArray(req.body.shops) ? req.body.shops.map(String).map(s => s.trim()).filter(Boolean).join(',') : undefined;
        const payload = { action: 'upsertOwner', owner };
        if (req.body.password != null && String(req.body.password) !== '') payload.password = String(req.body.password);
        if (shops != null) payload.shops = shops;
        if (req.body.role != null) payload.role = String(req.body.role);
        if (req.body.staffId != null) payload.staffId = String(req.body.staffId);
        if (req.body.staffName != null) payload.staffName = String(req.body.staffName);
        const out = await callGas(gasUrl, 'POST', payload);
        // パスワードはKVにテキスト保存（スプレッドシートの先頭0落ち等を回避・ログインはKV優先）
        if (req.body.password != null && String(req.body.password) !== '') await kvSavePassword(owner, req.body.password);
        return res.status(200).json({ ok: true, gas: out });
      }
      return res.status(400).json({ ok: false, error: 'Invalid action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[settlement-owners] error:', err);
    return res.status(502).json({ ok: false, error: 'GAS連携に失敗', message: err.message });
  }
}
