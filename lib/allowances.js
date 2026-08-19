// ── 手当（領収書提出）ロジック（テスト用分離モジュール） ──────────────
//
// 業務委託の「諸経費」／正社員の「手当」に相当する、領収書ベースの手当を計算する。
// 対象は税込生産性が ALLOWANCE_THRESHOLD（100万円）を超えた月のみ。
//
// 2種類:
//   1) monthly（毎月上限型 / 例: 健康手当）
//      - その月に生産性>100万なら、上限 cap（1万円）まで使える。
//      - 上限超の領収書は cap で頭打ち（例: 1.1万円提出→1万円）。
//      - 生産性≤100万の月は0円。翌月への繰越なし。
//   2) charge（通算チャージ型 / 例: 勉強代手当・アクセス手当）
//      - 生産性>100万の月ごとに accrual（1万円）が年内プールにチャージされる。
//      - 使用（領収書）はプール残高から差し引く。任意の月にまとめて使用可。
//      - 残高を超える分は使用不可（NG）。残高はシステムでカウント。
//      - 年末（12月終了時）に残った枠は失効（翌年に繰越されない）。
//
// テスト: tests/allowances.test.js

export const ALLOWANCE_THRESHOLD = 1000000; // 税込生産性のしきい値（超で対象）

// 手当カテゴリ定義（note は返金明細書の内訳注釈に使う短い名目）
export const ALLOWANCE_CATEGORIES = [
  { key: 'health', label: '健康手当',   type: 'monthly', cap: 10000,     note: '健康手当' },
  { key: 'study',  label: '勉強代手当', type: 'charge',  accrual: 10000, note: '勉強代手当' },
  { key: 'access', label: 'アクセス手当', type: 'charge',  accrual: 10000, note: 'アクセス手当' },
];

export function getAllowanceCategory(key) {
  return ALLOWANCE_CATEGORIES.find((c) => c.key === key) || null;
}
export function allowanceCategoryKeys() {
  return ALLOWANCE_CATEGORIES.map((c) => c.key);
}

const NUM = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// 生産性がしきい値を超えているか
export function isOverThreshold(productivity, threshold = ALLOWANCE_THRESHOLD) {
  return NUM(productivity) > threshold;
}

// ── 毎月上限型 ─────────────────────────────────────────────
// { requested, cap, over } → { eligible, used, requested, capped, rejected }
export function computeMonthlyCap({ requested = 0, cap = 10000, over = false } = {}) {
  const req = Math.max(0, NUM(requested));
  if (!over) return { eligible: false, used: 0, requested: req, capped: false, rejected: req };
  const used = Math.min(req, cap);
  return { eligible: true, used, requested: req, capped: req > cap, rejected: Math.max(0, req - used) };
}

// ── 通算チャージ型 ───────────────────────────────────────────
// months: [{ month:'YYYY-MM', over:boolean, requested:number }]（同一年・昇順）
// 各月: over なら accrual をチャージ→ requested を残高から使用（残高超は rejected）。
// 戻り値: { rows:[{month,over,accrued,requested,used,rejected,balanceAfter}], balanceEnd, forfeited }
export function computeChargeLedger(months = [], { accrual = 10000 } = {}) {
  let balance = 0;
  const rows = [];
  for (const m of (Array.isArray(months) ? months : [])) {
    const over = !!(m && m.over);
    const req = Math.max(0, NUM(m && m.requested));
    const accrued = over ? accrual : 0;
    balance += accrued;
    const used = Math.min(req, balance);
    balance -= used;
    rows.push({
      month: String((m && m.month) || ''),
      over, accrued, requested: req, used,
      rejected: Math.max(0, req - used),
      balanceAfter: balance,
    });
  }
  return { rows, balanceEnd: balance, forfeited: balance };
}

// ── 1スタッフの、指定月に返金明細書へ計上する手当額を算出 ──────────────
// カテゴリ横断で、その月に「使用」できる金額と内訳を返す。
//   category: ALLOWANCE_CATEGORIES の要素
//   targetMonth: 'YYYY-MM'（明細対象月）
//   history: [{ month:'YYYY-MM', over:boolean, requested:number }]（対象月まで含む・同一年・昇順）
// 戻り値: { key, label, note, used, requested, rejected, capped, balanceAfter }
export function computeAllowanceForMonth(category, targetMonth, history = []) {
  if (!category) return null;
  const rowsUpTo = (Array.isArray(history) ? history : []).filter((h) => h && h.month && h.month <= targetMonth);
  if (category.type === 'monthly') {
    const cur = rowsUpTo.find((h) => h.month === targetMonth) || { over: false, requested: 0 };
    const r = computeMonthlyCap({ requested: cur.requested, cap: category.cap, over: cur.over });
    return { key: category.key, label: category.label, note: category.note, used: r.used, requested: r.requested, rejected: r.rejected, capped: r.capped, balanceAfter: null };
  }
  // charge: 年初〜targetMonth まで時系列処理し、targetMonth 行の used を採用
  const led = computeChargeLedger(rowsUpTo, { accrual: category.accrual });
  const row = led.rows.find((x) => x.month === targetMonth) || { used: 0, requested: 0, rejected: 0, balanceAfter: led.balanceEnd };
  return { key: category.key, label: category.label, note: category.note, used: row.used, requested: row.requested, rejected: row.rejected, capped: false, balanceAfter: row.balanceAfter };
}
