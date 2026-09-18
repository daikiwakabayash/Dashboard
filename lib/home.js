// ── 経営ホーム: 重要指標・要確認店舗・承認待ち ────────────────────────
//
// ⚠️ 設計方針（ここを崩すと「数字を信じられないダッシュボード」になる）
//   1. **未取得・不明を 0 で埋めない。** 取れていないものは null のまま返し、
//      画面には「未取得」と出す。0件と未取得を混ぜない。
//   2. **ここで新しい指標を作らない。** すでにある値を並べ替えて見せるだけ。
//      集計期間・基準日・タイムゾーン・指標定義は Platform / SalonOne が正本。
//   3. **出典と対象期間と更新時刻を必ず添える。** どこから来た数字か分からない札を出さない。
//   4. 「要確認」は**事実の並び**であって診断ではない。理由を必ず添える。
//
// tests/home.test.js でカバー。

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const str = (v, n = 200) => String(v == null ? '' : v).slice(0, n);
const arr = (v) => (Array.isArray(v) ? v : []);

/** 表示用の1枚。⚠️ value が null なら「未取得」。0 と混ぜない。 */
export function metric(input = {}) {
  const value = input.value === null || input.value === undefined ? null : num(input.value);
  const prev = input.prev === null || input.prev === undefined ? null : num(input.prev);
  const diff = (value !== null && prev !== null) ? value - prev : null;
  const ratio = (value !== null && prev !== null && prev !== 0) ? (value - prev) / Math.abs(prev) : null;
  return {
    key: str(input.key, 40),
    label: str(input.label, 40),
    value,
    unit: str(input.unit, 10),
    prev, diff, ratio,
    // ⚠️ 出典・対象期間・更新時刻。無ければ空のまま出し、「不明」と書ける状態にする。
    source: str(input.source, 60),
    period: str(input.period, 60),
    updatedAt: str(input.updatedAt, 40),
    // 取れていない理由（画面にそのまま出す）
    missing: value === null ? (str(input.missing, 120) || '未取得') : '',
  };
}

/** 良し悪しの向き。'up' は増えるほど良い、'down' は減るほど良い、'' は判断しない。 */
export const METRIC_DIR = Object.freeze({
  sales: 'up', newVisit: 'up', repeat: 'up', cancelRate: 'down', cpa: 'down', adSpend: '',
});
export function tone(m) {
  if (!m || m.value === null || m.ratio === null) return 'none';
  const dir = METRIC_DIR[m.key] || '';
  if (!dir) return 'none';
  if (Math.abs(m.ratio) < 0.02) return 'flat';        // 2%未満は「横ばい」
  const better = dir === 'up' ? m.ratio > 0 : m.ratio < 0;
  return better ? 'good' : 'bad';
}

/**
 * 要確認の店舗。**事実と理由だけ**を返す（診断も断定もしない）。
 *   shops: [{ id, name, sales, prevSales, newVisit, prevNewVisit, repeatRate, cancelRate, updatedAt }]
 *   rules: { salesDrop: 0.15, newDrop: 0.2, cancelHigh: 0.2, repeatLow: 0.3 }
 * ⚠️ 値が無い店舗は「悪い」ではなく **「未取得」** として分けて返す。
 */
export const DEFAULT_RULES = Object.freeze({ salesDrop: 0.15, newDrop: 0.2, cancelHigh: 0.2, repeatLow: 0.3 });

export function attentionShops(shops, rules = DEFAULT_RULES, opts = {}) {
  const r = { ...DEFAULT_RULES, ...(rules && typeof rules === 'object' ? rules : {}) };
  const out = [], unknown = [];
  for (const s of arr(shops)) {
    if (!s || !str(s.id)) continue;
    const reasons = [];
    const sales = num(s.sales), prevSales = num(s.prevSales);
    const nv = num(s.newVisit), pnv = num(s.prevNewVisit);
    const rep = num(s.repeatRate), can = num(s.cancelRate);
    const haveAny = [sales, nv, rep, can].some(x => x !== null);
    if (!haveAny) { unknown.push({ id: str(s.id, 64), name: str(s.name, 80), missing: '数値が未取得です' }); continue; }
    if (sales !== null && prevSales !== null && prevSales > 0) {
      const d = (sales - prevSales) / prevSales;
      if (d <= -r.salesDrop) reasons.push({ key: 'sales', text: `売上が前月より ${Math.round(Math.abs(d) * 100)}% 少ない`, value: d });
    }
    if (nv !== null && pnv !== null && pnv > 0) {
      const d = (nv - pnv) / pnv;
      if (d <= -r.newDrop) reasons.push({ key: 'newVisit', text: `新規が前月より ${Math.round(Math.abs(d) * 100)}% 少ない`, value: d });
    }
    if (can !== null && can >= r.cancelHigh) reasons.push({ key: 'cancelRate', text: `キャンセル率が ${Math.round(can * 100)}%`, value: can });
    if (rep !== null && rep <= r.repeatLow) reasons.push({ key: 'repeat', text: `2回目来店率が ${Math.round(rep * 100)}%`, value: rep });
    if (reasons.length) {
      out.push({
        id: str(s.id, 64), name: str(s.name, 80), reasons,
        // 並べる順は「理由の数 → 売上の落ち幅」。⚠️ 点数を付けて順位を断定しない。
        drop: (sales !== null && prevSales !== null && prevSales > 0) ? (sales - prevSales) / prevSales : 0,
        updatedAt: str(s.updatedAt, 40),
      });
    }
  }
  out.sort((a, b) => (b.reasons.length - a.reasons.length) || (a.drop - b.drop));
  const limit = Number(opts.limit) || 5;
  return { shops: out.slice(0, limit), total: out.length, unknown };
}

/**
 * 承認待ち。既存の承認センターの項目をそのまま並べる（新しい状態を作らない）。
 * ⚠️ 期限切れを「承認済み」にしない。古い順に出して、人が判断する。
 */
export function pendingApprovals(items, now = Date.now(), limit = 5) {
  const list = arr(items)
    .filter(x => x && String(x.status || 'pending') === 'pending')
    .map(x => ({
      id: str(x.id, 64),
      title: str(x.title || x.action, 120),
      who: str(x.requestedName || x.requestedBy, 80),
      at: Number(x.requestedAt) || 0,
      waitedMs: Math.max(0, now - (Number(x.requestedAt) || now)),
    }))
    .sort((a, b) => a.at - b.at);
  return { items: list.slice(0, limit), total: list.length };
}

/** 待ち時間の言い方（「3日待ち」など）。0 を「すぐ」と偽らない。 */
export function waitedLabel(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  const h = Math.floor(n / 3600000);
  if (h < 1) return '1時間以内';
  if (h < 24) return `${h}時間待ち`;
  return `${Math.floor(h / 24)}日待ち`;
}

/**
 * 画面に出す注記。**出典・対象期間・更新時刻**を1行にまとめる。
 * ⚠️ 分からないものは「不明」と書く（空欄で誤魔化さない）。
 */
export function sourceNote(m) {
  const src = str(m && m.source) || '出典不明';
  const per = str(m && m.period) || '対象期間不明';
  const up = str(m && m.updatedAt) || '更新時刻不明';
  return `${src}／${per}／${up}`;
}

/** 経営ホームの組み立て。⚠️ ここで計算しない。渡された値を並べるだけ。 */
export function buildHome(input = {}) {
  const metrics = arr(input.metrics).map(metric);
  const att = attentionShops(input.shops, input.rules, { limit: input.shopLimit });
  const ap = pendingApprovals(input.approvals, input.now, input.approvalLimit);
  const missing = metrics.filter(m => m.value === null).map(m => m.label);
  return {
    metrics, attention: att, approvals: ap,
    // ⚠️ 取れていない指標がある事実を、画面の上に必ず出す。
    notice: missing.length ? `${missing.join('・')}は未取得です（0ではありません）` : '',
  };
}
