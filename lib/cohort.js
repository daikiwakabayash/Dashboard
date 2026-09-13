// ── コホートLTV / 継続（チャーン）分析ロジック（テスト用分離モジュール） ────────────────
//
// 目的: 「加入月コホート（その月に獲得/加入した顧客）」を起点に、経過月ごとの
//   ・LTV（累計売上／1人）＝獲得あたり・入会(加入)あたりの両方
//   ・ARPU（その月齢の1人あたり売上）＝「何ヶ月目に単価が変わるか」
//   ・継続率／離反（チャーン）＝「何ヶ月目の離反が多いか」・平均継続月数
//   を投資家グレードで正確に出す。
//
// 設計方針: **データ源に依存しない**。顧客(または契約)1件ごとに
//   { shopId, cohortMonth, joined, started, revByMonth, churnMonth } を渡せば曲線を返す。
//   churnMonth の決め方は呼び出し側（＝データ源）が担当する:
//     ・Square基点  … 解約(canceledDate)／課金停止の月
//     ・SalonOne基点 … 来店が途絶えた月（下記 churnOf の運用ルール）
//
// 来店ベース離反ルール（SalonOne用ヘルパ churnOf・運用定義）:
//   離反月 = 最終来店月。ある暦月が丸々来店ゼロで、その空白月が完全に終わったら最終来店月を離反月とする。
//   例) 最終来店9/13 → 10月ゼロ → 11月到達で「9月離反」／ 来店9・10月 → 11月ゼロ → 12月到達で「10月離反」
//   式: (現在月 − 最終来店月) ≥ 2ヶ月 で離反確定。1ヶ月以内は継続中(active)。
//
// tests/cohort.test.js でカバー。

// 'YYYY-MM-DD...' → 'YYYY-MM'（先頭7文字。タイムゾーン補正は呼び出し側で吸収済み前提）
export function ym(s) {
  const t = String(s || '');
  return t.length >= 7 ? t.slice(0, 7) : '';
}

// 'YYYY-MM' → 通し月インデックス（比較・差分用）。無効は null。
export function ymIndex(m) {
  const t = String(m || '');
  if (!/^\d{4}-\d{2}$/.test(t)) return null;
  const y = Number(t.slice(0, 4)), mo = Number(t.slice(5, 7));
  if (!y || mo < 1 || mo > 12) return null;
  return y * 12 + (mo - 1);
}

// 月インデックス → 'YYYY-MM'
export function ymFromIndex(idx) {
  if (idx == null || !isFinite(idx)) return '';
  const y = Math.floor(idx / 12), mo = (idx % 12) + 1;
  return `${y}-${String(mo).padStart(2, '0')}`;
}

// a→b の月数差（b - a）。無効は null。
export function ymDiff(a, b) {
  const ia = ymIndex(a), ib = ymIndex(b);
  if (ia == null || ib == null) return null;
  return ib - ia;
}

// 'YYYY-MM' に n ヶ月加算
export function ymAdd(m, n) {
  const i = ymIndex(m);
  return i == null ? '' : ymFromIndex(i + (Number(n) || 0));
}

function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

// ── SalonOne（来店）用: 来店月配列から離反状態を判定する（上記ルール） ──
//   visitMonths: ['2026-09','2026-10', ...]（'YYYY-MM'・重複/順不同/空 可）
//   asOf: 現在月 'YYYY-MM'
//   戻り: { lastVisit:'YYYY-MM'|null, churnMonth:'YYYY-MM'|null, active:bool }
export function churnOf(visitMonths, asOf) {
  const idxs = (Array.isArray(visitMonths) ? visitMonths : []).map(ymIndex).filter(v => v != null);
  if (!idxs.length) return { lastVisit: null, churnMonth: null, active: false };
  const lastIdx = Math.max(...idxs);
  const nowIdx = ymIndex(asOf);
  const lastVisit = ymFromIndex(lastIdx);
  if (nowIdx != null && (nowIdx - lastIdx) >= 2) return { lastVisit, churnMonth: lastVisit, active: false };
  return { lastVisit, churnMonth: null, active: true };
}

// ── Square（課金）用: 月別課金と解約日から churnMonth を決める（課金停止ベース） ──
//   billMonths: 課金があった月 ['YYYY-MM', ...]
//   canceledMonth: 解約月 'YYYY-MM'|null（Squareのcanceled_date由来・あれば最優先）
//   asOf: 現在月。gapMonths: 何ヶ月 課金が無ければ離反とみなすか（既定2＝丸1ヶ月空き）
//   戻り: churnMonth 'YYYY-MM'|null（null=継続中）
export function churnFromBilling(billMonths, canceledMonth, asOf, gapMonths = 2) {
  const cm = ymIndex(canceledMonth);
  const idxs = (Array.isArray(billMonths) ? billMonths : []).map(ymIndex).filter(v => v != null);
  if (cm != null) {
    // 解約日があれば「最後の課金月」と「解約月」の早い方を離反月に（解約後も名目請求が残るケースを吸収）
    const lastBill = idxs.length ? Math.max(...idxs) : cm;
    return ymFromIndex(Math.min(cm, lastBill));
  }
  if (!idxs.length) return null;
  const lastIdx = Math.max(...idxs);
  const nowIdx = ymIndex(asOf);
  if (nowIdx != null && (nowIdx - lastIdx) >= gapMonths) return ymFromIndex(lastIdx);
  return null;
}

// 1コホート（1店舗×1加入月、またはその集合）を集計する。
//   custs: [{
//     shopId, cohortMonth:'YYYY-MM'（加入/獲得月）,
//     joined: bool（入会/契約か）, started: bool（初回課金or来店したか）,
//     revByMonth: { 'YYYY-MM': 金額 }（月別売上・累計LTVはこれを合算）,
//     churnMonth: 'YYYY-MM' | null（null=継続中。決め方はデータ源側）,
//   }]  ※テスト/キャンセル/海外/期間外は呼び出し側で除外済みの純粋コホートを渡す
//   opts: { asOf:'YYYY-MM', horizon: 最大月齢（既定 24） }
export function buildCohort(custs, opts = {}) {
  const rows = Array.isArray(custs) ? custs : [];
  const asOf = opts.asOf || '';
  const H = Math.max(1, Number(opts.horizon) || 24);
  const cohortMonth = rows.length ? ((rows.find(r => r && r.cohortMonth) || {}).cohortMonth || '') : '';
  const cIdx = ymIndex(cohortMonth);
  const maxAge = (cIdx != null && ymIndex(asOf) != null) ? Math.max(0, ymIndex(asOf) - cIdx) : 0; // 今この時点でこのコホートが到達している月齢（曲線の有効範囲）
  const size = rows.length;
  let joined = 0, started = 0;
  const churnByAge = new Array(H + 1).fill(0);
  const revByAgeTotal = new Array(H + 1).fill(0);
  const activeByAge = new Array(H + 1).fill(0);
  const lifetimes = [];

  for (const r of rows) {
    if (!r) continue;
    if (r.joined) joined += 1;
    if (r.started) started += 1;
    const rev = (r.revByMonth && typeof r.revByMonth === 'object') ? r.revByMonth : {};
    for (const [mm, amt] of Object.entries(rev)) {
      const age = cIdx != null ? ymDiff(cohortMonth, mm) : null;
      if (age == null || age < 0 || age > H) continue;
      revByAgeTotal[age] += num(amt);
    }
    const churnAge = (r.churnMonth && cIdx != null) ? ymDiff(cohortMonth, r.churnMonth) : null;
    if (churnAge != null && churnAge >= 0 && churnAge <= H) { churnByAge[churnAge] += 1; lifetimes.push(churnAge); }
    // 継続者数（分母は「開始した人」＝started）: 離反していない月齢をカウント
    if (r.started) {
      for (let a = 0; a <= H; a++) { if (churnAge == null || a <= churnAge) activeByAge[a] += 1; }
    }
  }

  const ltvByAgeBooking = [], ltvByAgeJoin = [], arpuByAge = [], retentionByAge = [];
  let cum = 0;
  for (let a = 0; a <= H; a++) {
    cum += revByAgeTotal[a];
    ltvByAgeBooking.push(size > 0 ? Math.round(cum / size) : 0);
    ltvByAgeJoin.push(joined > 0 ? Math.round(cum / joined) : 0);
    arpuByAge.push(activeByAge[a] > 0 ? Math.round(revByAgeTotal[a] / activeByAge[a]) : 0);
    retentionByAge.push(started > 0 ? Math.round(activeByAge[a] / started * 1000) / 10 : 0);
  }
  const avgLifetimeMonths = lifetimes.length
    ? Math.round((lifetimes.reduce((s, v) => s + v, 0) / lifetimes.length) * 10) / 10 : 0;

  return {
    cohortMonth, size, joined, started, maxAge,
    churnByAge, activeByAge, revByAgeTotal, retentionByAge,
    ltvByAgeBooking, ltvByAgeJoin, arpuByAge,
    ltvBooking: ltvByAgeBooking[Math.min(H, maxAge)], ltvJoin: ltvByAgeJoin[Math.min(H, maxAge)],
    avgLifetimeMonths, churnedTotal: lifetimes.length,
  };
}

// 複数コホートをまとめて集計（店舗×加入月／全店合算×加入月）。
export function buildCohortMatrix(custs, opts = {}) {
  const rows = Array.isArray(custs) ? custs : [];
  const byShopMonth = new Map();
  const byMonth = new Map();
  for (const r of rows) {
    if (!r || !r.cohortMonth) continue;
    const sk = `${r.shopId == null ? '' : r.shopId}||${r.cohortMonth}`;
    if (!byShopMonth.has(sk)) byShopMonth.set(sk, []);
    byShopMonth.get(sk).push(r);
    if (!byMonth.has(r.cohortMonth)) byMonth.set(r.cohortMonth, []);
    byMonth.get(r.cohortMonth).push(r);
  }
  const byCohort = {};
  for (const [k, arr] of byShopMonth) byCohort[k] = buildCohort(arr, opts);
  const allByMonth = {};
  for (const [m, arr] of byMonth) allByMonth[m] = buildCohort(arr, opts);
  return { byCohort, allByMonth };
}
