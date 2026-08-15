// ── 返金明細書ストアAPI（GAS＋スプレッドシート連携） ─────────────────
// 本社が生成した明細書スナップショットと、オーナーの確認状況/修正依頼を
// スプレッドシートに保存し、本社↔オーナー間で共有する。
//
// 環境変数:
//   SETTLEMENT_GAS_URL         - 返金明細書用GAS WebアプリURL（gas/settlement-gas-sample.js を配置）
//   SETTLEMENT_OWNER_PASSWORDS - オーナー別PASS（オーナーの操作を検証するため）
//   AUTH_SALT                  - トークン用ソルト
//   DASHBOARD_PASSWORD         - 本社操作(publish)の認可に使用（トークン照合）
//
// GET  /api/settlement-store?month=YYYY-MM[&owner=名]  → { records: [...] }
// POST /api/settlement-store  { action, ... }
//   - action:'publish'          本社: records(配列) を upsert（要 hqToken）
//   - action:'confirm'          オーナー: shopId+month を確認済みに（要 owner+token）
//   - action:'requestRevision'  オーナー: 修正依頼(note)を登録（要 owner+token）

import { createHash } from 'crypto';
import { parseOwnerPasswords, verifyOwnerToken, normalizeRecord, parseOwnerShops, allowedShopsFor, SETTLEMENT_STATUS } from '../lib/settlement.js';

const SALT = () => process.env.AUTH_SALT || 'naoru-settlement-2026';

function hqTokenValid(token) {
  const pw = process.env.DASHBOARD_PASSWORD;
  if (!pw) return true; // パスワード未設定（開発）→ 認可スキップ
  const salt = process.env.AUTH_SALT || 'naoru-dashboard-2024';
  const expected = createHash('sha256').update(pw + salt).digest('hex');
  return token === expected || token === 'dev-mode';
}

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const gasUrl = process.env.SETTLEMENT_GAS_URL;
  if (!gasUrl) {
    if (req.method === 'GET') return res.status(200).json({ records: [], configured: false, message: 'SETTLEMENT_GAS_URL 未設定' });
    return res.status(503).json({ ok: false, error: 'SETTLEMENT_GAS_URL が未設定です', setupRequired: true });
  }

  // ── GET: 月（＋任意でオーナー）で明細レコードを取得 ──
  if (req.method === 'GET') {
    const month = String(req.query.month || '');
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM が必要です' });
    const owner = req.query.owner ? String(req.query.owner) : '';
    try {
      const q = new URLSearchParams({ month }); if (owner) q.set('owner', owner);
      const data = await callGas(`${gasUrl}?${q.toString()}`, 'GET');
      const rows = Array.isArray(data) ? data : (data.records || []);
      // アクセス制御: SETTLEMENT_OWNER_SHOPS があれば許可店舗のみ、無ければ owner タグ一致
      const shopsMap = parseOwnerShops(process.env.SETTLEMENT_OWNER_SHOPS);
      const allowed = owner ? allowedShopsFor(shopsMap, owner) : null;
      const records = rows.map(normalizeRecord).filter(Boolean).filter(r => {
        if (!owner) return true;
        if (allowed) return allowed.some(p => String(r.shopName || '').includes(p));
        return r.owner === owner;
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ records, configured: true });
    } catch (err) {
      return res.status(502).json({ error: 'GAS取得に失敗', message: err.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const action = body.action;

  try {
    // ── 本社: 一括公開（スナップショットの upsert） ──
    if (action === 'publish') {
      if (!hqTokenValid(body.hqToken)) return res.status(401).json({ ok: false, error: '本社認証が必要です' });
      const records = (Array.isArray(body.records) ? body.records : []).map(normalizeRecord).filter(Boolean);
      if (records.length === 0) return res.status(400).json({ ok: false, error: '保存対象がありません' });
      const now = new Date().toISOString();
      const payload = records.map(r => ({
        ...r,
        status: r.status || SETTLEMENT_STATUS.PUBLISHED,
        publishedAt: r.publishedAt || now,
        updatedAt: now,
        snapshot: JSON.stringify(r.snapshot || {}),
      }));
      const out = await callGas(gasUrl, 'POST', { action: 'upsert', records: payload });
      return res.status(200).json({ ok: true, saved: payload.length, gas: out });
    }

    // ── オーナー: 確認済み / 修正依頼（本人の店舗のみ） ──
    if (action === 'confirm' || action === 'requestRevision') {
      const passwords = parseOwnerPasswords(process.env.SETTLEMENT_OWNER_PASSWORDS);
      if (!verifyOwnerToken(passwords, body.owner, body.token, SALT())) {
        return res.status(401).json({ ok: false, error: 'オーナー認証が必要です' });
      }
      const shopId = String(body.shopId || '');
      const month = String(body.month || '');
      if (!shopId || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ ok: false, error: 'shopId と month が必要です' });
      const now = new Date().toISOString();
      const patch = action === 'confirm'
        ? { status: SETTLEMENT_STATUS.CONFIRMED, confirmedAt: now, revisionNote: '' }
        : { status: SETTLEMENT_STATUS.REVISION, revisionNote: String(body.note || '').slice(0, 2000), confirmedAt: '' };
      // GAS 側は owner 一致行のみ更新（他オーナーの明細は変更不可）
      const out = await callGas(gasUrl, 'POST', {
        action: 'update', owner: body.owner, shopId, month, updatedAt: now, ...patch,
      });
      return res.status(200).json({ ok: true, gas: out });
    }

    return res.status(400).json({ ok: false, error: 'Invalid action' });
  } catch (err) {
    console.error('[settlement-store] error:', err);
    return res.status(502).json({ ok: false, error: 'GAS連携に失敗', message: err.message });
  }
}
