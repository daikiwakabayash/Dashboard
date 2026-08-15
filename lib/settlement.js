// ── 返金明細書（FC精算）共通ロジック ─────────────────────────────
// 本社（index.html）とオーナーポータル（owner.html）、およびサーバー側
// （api/settlement-auth.js / api/settlement-store.js）で共有する純粋関数群。
// テスト: tests/settlement.test.js
//
// - オーナー別PASS認証のトークン生成/検証
// - 明細書スナップショットの検証・正規化
// - 期日スケジュール・注意書き（単一ソース）

import { createHash } from 'crypto';

// ── 期日スケジュール・注意書き（本社/オーナー双方で表示する唯一の定義） ──
export const SETTLEMENT_SCHEDULE = [
  { day: '2日', label: '売上確定', by: true },
  { day: '5日', label: '返金明細書作成', by: true },
  { day: '10日', label: 'オーナーチェック', by: true },
  { day: '15日', label: '振り込み', by: false },
];

export const SETTLEMENT_NOTES = [
  '6日〜10日までの間に必ずオーナーは内容をご確認ください。',
  '期日（10日）を過ぎた場合、修正対応はできません。',
];

// ステータス定義（GAS保存値と一致）
export const SETTLEMENT_STATUS = {
  DRAFT: 'draft',                 // 本社作成中（未公開）
  PUBLISHED: 'published',         // 公開済み（オーナー確認待ち）
  CONFIRMED: 'confirmed',         // オーナー確認済み
  REVISION: 'revision_requested', // オーナーが修正依頼
};

export const STATUS_LABEL = {
  draft: '下書き',
  published: '確認待ち',
  confirmed: '確認済み',
  revision_requested: '修正依頼あり',
};

// ── オーナー別PASS認証 ───────────────────────────────────────────
// SETTLEMENT_OWNER_PASSWORDS 環境変数（JSON: { "オーナー名": "パスワード", ... }）を解析
export function parseOwnerPasswords(raw) {
  if (!raw) return {};
  try {
    const o = JSON.parse(String(raw).trim());
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch (_) {
    return {};
  }
}

// ── オーナー別 店舗アクセス権限 ─────────────────────────────────
// SETTLEMENT_OWNER_SHOPS（任意, JSON: { "オーナー名": ["店舗名の一部", ...] }）を解析。
// 未設定/そのオーナーに定義が無い場合は OWNER_BRANCHES ベースのタグにフォールバック。
export function parseOwnerShops(raw) {
  if (!raw) return {};
  try {
    const o = JSON.parse(String(raw).trim());
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    const out = {};
    for (const [owner, list] of Object.entries(o)) {
      if (Array.isArray(list)) out[owner] = list.map(String).filter(Boolean);
    }
    return out;
  } catch (_) {
    return {};
  }
}

// そのオーナーの許可店舗パターン配列（未定義なら null）
export function allowedShopsFor(shopsMap, owner) {
  const list = shopsMap && shopsMap[owner];
  return Array.isArray(list) && list.length ? list : null;
}

// 店舗名がオーナーの許可リストに含まれるか（部分一致）。定義が無ければ null（判定不能）。
export function ownerCanAccessShop(shopsMap, owner, shopName) {
  const allowed = allowedShopsFor(shopsMap, owner);
  if (!allowed) return null;
  const name = String(shopName || '');
  return allowed.some(p => name.includes(p));
}

// トークン = sha256(owner + ':' + password + ':' + salt)
export function hashOwnerToken(owner, password, salt) {
  return createHash('sha256').update(`${owner}:${password}:${salt}`).digest('hex');
}

// ログイン検証。owner 指定時はその名前で照合、未指定なら PASS が一致する
// オーナーを全体から検索（PASS はオーナー毎に一意である前提）。
// 成功: { owner, token } / 失敗: null
export function verifyOwnerLogin(passwords, { owner, password }, salt) {
  if (!password) return null;
  const entries = Object.entries(passwords || {});
  let matchedOwner = null;
  if (owner) {
    if (passwords[owner] != null && String(passwords[owner]) === String(password)) matchedOwner = owner;
  } else {
    const hit = entries.find(([, pw]) => String(pw) === String(password));
    if (hit) matchedOwner = hit[0];
  }
  if (!matchedOwner) return null;
  return { owner: matchedOwner, token: hashOwnerToken(matchedOwner, String(passwords[matchedOwner]), salt) };
}

// トークン検証（owner + token）。passwords からそのオーナーの正解トークンを再計算して照合
export function verifyOwnerToken(passwords, owner, token, salt) {
  if (!owner || !token) return false;
  const pw = passwords[owner];
  if (pw == null) return false;
  return hashOwnerToken(owner, String(pw), salt) === token;
}

// ── 明細書スナップショット ───────────────────────────────────────
// 本社が生成した完成済み明細（表示に必要な全値）を保存し、オーナーは
// これをそのまま閲覧する。再計算しないため本社/オーナーで数値が完全一致する。
const NUM = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// 1明細レコードを正規化（保存前・読込後どちらでも安全に通す）
export function normalizeRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const shopId = String(r.shopId ?? r.shop_id ?? '');
  const month = String(r.month ?? '');
  if (!shopId || !/^\d{4}-\d{2}$/.test(month)) return null;
  const snap = (r.snapshot && typeof r.snapshot === 'object') ? r.snapshot
             : (typeof r.snapshot === 'string' ? safeParse(r.snapshot) : {});
  const status = SETTLEMENT_STATUS[Object.keys(SETTLEMENT_STATUS).find(k => SETTLEMENT_STATUS[k] === r.status)]
             ? r.status : SETTLEMENT_STATUS.PUBLISHED;
  return {
    shopId,
    shopName: String(r.shopName ?? r.shop_name ?? ''),
    owner: String(r.owner ?? ''),
    month,
    status,
    revisionNote: String(r.revisionNote ?? r.revision_note ?? ''),
    snapshot: snap || {},
    publishedAt: r.publishedAt || r.published_at || '',
    confirmedAt: r.confirmedAt || r.confirmed_at || '',
    updatedAt: r.updatedAt || r.updated_at || '',
  };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

// 明細書の請求合計・返金額を算出（本社の生成時にスナップショットへ格納する値の検算にも使用）
// 引数はすべて金額(円)。royaltyBase = 現金 + スクエア売上 + HPB
export function computeSettlement({ cash = 0, squareSales = 0, hpb = 0, royaltyRate = 15, taxRate = 10,
                                    squareFees = 0, spotip = 0, metaTotal = 0, adjTotal = 0 }) {
  const royaltyBase = NUM(cash) + NUM(squareSales) + NUM(hpb);
  const royalty = Math.round(royaltyBase * NUM(royaltyRate) / 100);
  const billTotal = royalty + NUM(squareFees) + NUM(spotip) + NUM(metaTotal) + NUM(adjTotal);
  const tax = Math.round(billTotal * NUM(taxRate) / (100 + NUM(taxRate)));
  const refundAmount = NUM(squareSales) - billTotal;
  const feeRate = NUM(squareSales) > 0 ? Math.round(NUM(squareFees) / NUM(squareSales) * 10000) / 100 : null;
  return { royaltyBase, royalty, billTotal, tax, refundAmount, feeRate };
}
