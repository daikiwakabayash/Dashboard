// ── オーナー別PASS認証API（返金明細書ポータル用） ──────────────────
// パスワード/アクセス店舗は「GASオーナー設定シート」＋環境変数の両方から読む
// （GASを優先）。GASはUIから編集できるため再デプロイ不要。
//
// 環境変数:
//   SETTLEMENT_OWNER_PASSWORDS - JSON { "オーナー名": "パスワード", ... }（フォールバック/初期値）
//   SETTLEMENT_OWNER_SHOPS     - JSON { "オーナー名": ["店舗名の一部", ...] }（アクセス店舗・フォールバック）
//   SETTLEMENT_GAS_URL         - オーナー設定を保存するGAS（あればこちらを優先）
//   DASHBOARD_PASSWORD         - root（全アクセス）ログイン用パスワード
//   AUTH_SALT                  - トークン用ソルト
//
// POST { action:'login',  owner?, password } → { ok, owner, token, root, shops }
// POST { action:'verify', owner, token }     → { ok, root }
// GET                                         → { configured, owners:[...], shops:{...}, rootConfigured }

import { hashOwnerToken, parseOwnerPasswords, parseOwnerShops, verifyOwnerLogin, verifyOwnerToken, allowedShopsFor } from '../settlement.js';
import { kvConfigured, kvBlobGet, ACCT_PASS_KEY } from '../kvblob.js';

const SALT = () => process.env.AUTH_SALT || 'naoru-settlement-2026';
const ROOT = '__root__';
const ACCTMETA_KEY = 'naoru:accountmeta:v1'; // { owner: { role, staffId, staffName } }（plan-store と共通）
const HQ_ROLE = 'hq';                        // 本部＝個人名でログインする root権限アカウント
const splitShops = (csv) => String(csv || '').split(',').map(s => s.trim()).filter(Boolean);

async function loadGasOwners() {
  const url = process.env.SETTLEMENT_GAS_URL;
  if (!url) return [];
  try {
    const resp = await fetch(`${url}?type=owners`, { headers: { Accept: 'application/json' }, redirect: 'follow' });
    if (!resp.ok) return [];
    const j = await resp.json().catch(() => ({}));
    return Array.isArray(j.owners) ? j.owners : [];
  } catch (_) { return []; }
}

// 環境変数 + GAS をマージして { passwords, shopsMap, metaMap } を作る（GAS優先）
// metaMap[owner] = { role, staffId, staffName }
async function loadAccounts() {
  const passwords = parseOwnerPasswords(process.env.SETTLEMENT_OWNER_PASSWORDS);
  const shopsMap = parseOwnerShops(process.env.SETTLEMENT_OWNER_SHOPS);
  const metaMap = {};
  const gas = await loadGasOwners();
  for (const o of gas) {
    if (!o || !o.owner) continue;
    if (o.password != null && String(o.password) !== '') passwords[o.owner] = String(o.password);
    const shops = splitShops(o.shops);
    if (shops.length) shopsMap[o.owner] = shops;
    metaMap[o.owner] = { role: o.role || 'owner', staffId: o.staffId || '', staffName: o.staffName || '' };
  }
  // KVのパスワードを最優先で上書き（スプレッドシートの型変換で壊れた値＝先頭0落ち等を回避）
  if (kvConfigured()) {
    const kvPass = (await kvBlobGet(ACCT_PASS_KEY)) || {};
    for (const [owner, pw] of Object.entries(kvPass)) {
      if (pw != null && String(pw) !== '') passwords[owner] = String(pw);
    }
    // KVのアカウント拡張情報（role/staffId/staffName）を最優先で反映（GAS列の再デプロイに依存しない）。
    // これにより本部(hq)判定が KV だけでも成立する（フロントの loadAcctMeta と同じ優先度）。
    try {
      const kvMeta = (await kvBlobGet(ACCTMETA_KEY)) || {};
      for (const [owner, m] of Object.entries(kvMeta)) {
        if (!m || typeof m !== 'object') continue;
        const prev = metaMap[owner] || {};
        metaMap[owner] = {
          role: m.role || prev.role || 'owner',
          staffId: m.staffId || prev.staffId || '',
          staffName: m.staffName || prev.staffName || '',
        };
      }
    } catch (_) {}
  }
  return { passwords, shopsMap, metaMap };
}

const rootToken = () => hashOwnerToken(ROOT, process.env.DASHBOARD_PASSWORD || '', SALT());

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── root（DASHBOARD_PASSWORD）は GAS(オーナー設定)の読込を待たずに即応答してログインを高速化。 ──
  //    root はオーナー一覧を必要としないため、GAS往復（コールド時に数秒）をスキップする。
  if (req.method === 'POST') {
    const b = req.body || {};
    if (b.action === 'login' && process.env.DASHBOARD_PASSWORD && b.password === process.env.DASHBOARD_PASSWORD) {
      return res.status(200).json({ ok: true, owner: ROOT, root: true, token: rootToken(), shops: null, role: 'root', staffId: '', staffName: '' });
    }
    if (b.action === 'verify' && b.owner === ROOT) {
      return res.status(b.token === rootToken() ? 200 : 401).json({ ok: b.token === rootToken(), root: true });
    }
    // rootToken 保持者（root＝__root__ / 本部hq＝個人名）はGAS往復なしで即 root 検証。
    if (b.action === 'verify' && b.token && b.token === rootToken()) {
      return res.status(200).json({ ok: true, root: true });
    }
  }

  const { passwords, shopsMap, metaMap } = await loadAccounts();
  const configured = Object.keys(passwords).length > 0;
  const rootConfigured = !!process.env.DASHBOARD_PASSWORD;

  if (req.method === 'GET') {
    return res.status(200).json({ configured, owners: Object.keys(passwords), shops: shopsMap, meta: metaMap, rootConfigured });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, owner, password, token } = req.body || {};

  if (action === 'login') {
    // root（全アクセス）※上で先行処理済みだが後方互換のため残す
    if (process.env.DASHBOARD_PASSWORD && password === process.env.DASHBOARD_PASSWORD) {
      return res.status(200).json({ ok: true, owner: ROOT, root: true, token: rootToken(), shops: null, role: 'root', staffId: '', staffName: '' });
    }
    const r = verifyOwnerLogin(passwords, { owner, password }, SALT());
    if (!r) return res.status(401).json({ ok: false, error: 'パスワードが正しくありません' });
    const meta = metaMap[r.owner] || { role: 'owner', staffId: '', staffName: '' };
    // 本部(hq)＝個人名でログインする root権限アカウント。認可トークンは rootToken を発行し、
    // サーバー側でも root と同等（settlement-owners/settlement-store 等）に扱う。表示名/roleは本人のものを保持。
    if (meta.role === HQ_ROLE) {
      return res.status(200).json({ ok: true, owner: r.owner, root: true, token: rootToken(), shops: null, role: HQ_ROLE, staffId: meta.staffId || '', staffName: meta.staffName || '' });
    }
    return res.status(200).json({ ok: true, owner: r.owner, root: false, token: r.token, shops: allowedShopsFor(shopsMap, r.owner) || [], role: meta.role || 'owner', staffId: meta.staffId || '', staffName: meta.staffName || '' });
  }

  if (action === 'verify') {
    if (token && token === rootToken()) return res.status(200).json({ ok: true, root: true }); // root / 本部hq
    if (owner === ROOT) return res.status(token === rootToken() ? 200 : 401).json({ ok: token === rootToken(), root: true });
    const ok = verifyOwnerToken(passwords, owner, token, SALT());
    return res.status(ok ? 200 : 401).json({ ok, root: false });
  }

  return res.status(400).json({ error: 'Invalid action. Use "login" or "verify".' });
}
