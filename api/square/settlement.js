// ── Square 精算データ（返金明細書用）: 店舗×月の 売上・手数料・返金 ──
//
// FC返金明細書のために、Square決済から「総売上・決済手数料・返金」を店舗単位・月単位で集計する。
// 既存の metrics.js は決済額(total_money)のみ取得し手数料を拾わないため、本エンドポイントで
// processing_fee（実手数料）と /v2/refunds（返金）を取得する。
//
// 使い方:
//   GET /api/square/settlement?month=2026-07&location=静岡
//   GET /api/square/settlement?locations=1   ← 全ロケーション名を一覧（マッチ確認用）
//
// 環境変数: SQUARE_TOKENS（JSON配列）または SQUARE_ACCESS_TOKEN

export const config = { maxDuration: 60 };

function parseTokens() {
  if (process.env.SQUARE_TOKENS) {
    try {
      const t = JSON.parse(process.env.SQUARE_TOKENS.trim());
      if (Array.isArray(t) && t.length) return t;
    } catch (_) {}
  }
  if (process.env.SQUARE_ACCESS_TOKEN) {
    return [{ name: '', token: process.env.SQUARE_ACCESS_TOKEN, env: process.env.SQUARE_ENVIRONMENT || 'production' }];
  }
  return [];
}

const toNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const baseUrlFor = (env) => env === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';

// 店舗名の正規化（「NAORU整体 静岡院」→「静岡院」等）してから部分一致
function normName(name) {
  if (!name) return '';
  return String(name)
    .replace(/^JCB対応版[_\s　]*/i, '')
    .replace(/^[Nn][Aa][Oo][Rr][Uu][\s　]*整体?[\s　]*/i, '')
    .replace(/^[\s　]+|[\s　]+$/g, '');
}

async function sq(url, token) {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'Square-Version': '2025-01-23', 'Content-Type': 'application/json' },
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${t.slice(0, 160)}`);
  }
  return resp.json();
}

async function listLocations(token, env) {
  const data = await sq(`${baseUrlFor(env)}/v2/locations`, token);
  return (data.locations || []).map(l => ({ id: l.id, name: l.name || l.id, timezone: l.timezone || 'Asia/Tokyo' }));
}

// 指定ロケーション・期間の 決済(総売上/手数料) と 返金 を集計
async function fetchSettlement(token, env, locationId, beginIso, endIso) {
  const base = baseUrlFor(env);
  let grossSales = 0, fees = 0, paymentCount = 0, refunds = 0, refundCount = 0;

  // Payments（総売上・実手数料）
  let cursor = null;
  do {
    const p = new URLSearchParams({ begin_time: beginIso, end_time: endIso, location_id: locationId, sort_order: 'ASC', limit: '100' });
    if (cursor) p.set('cursor', cursor);
    const data = await sq(`${base}/v2/payments?${p}`, token);
    for (const pay of (data.payments || [])) {
      if (pay.status !== 'COMPLETED') continue;
      grossSales += toNum(pay.total_money && pay.total_money.amount);
      paymentCount++;
      for (const f of (pay.processing_fee || [])) fees += toNum(f.amount_money && f.amount_money.amount);
    }
    cursor = data.cursor || null;
  } while (cursor);

  // Refunds（返金）
  cursor = null;
  do {
    const p = new URLSearchParams({ begin_time: beginIso, end_time: endIso, location_id: locationId, sort_order: 'ASC', limit: '100' });
    if (cursor) p.set('cursor', cursor);
    const data = await sq(`${base}/v2/refunds?${p}`, token);
    for (const r of (data.refunds || [])) {
      if (r.status === 'REJECTED' || r.status === 'FAILED') continue;
      refunds += toNum(r.amount_money && r.amount_money.amount);
      refundCount++;
    }
    cursor = data.cursor || null;
  } while (cursor);

  return { grossSales, fees, paymentCount, refunds, refundCount, net: grossSales - fees - refunds };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const tokens = parseTokens();
  if (tokens.length === 0) {
    return res.status(500).json({ error: 'SQUARE_TOKENS/SQUARE_ACCESS_TOKEN is not configured', setupRequired: true });
  }

  try {
    // ロケーション一覧モード（マッチ確認用）
    if (req.query.locations === '1') {
      const out = [];
      for (const t of tokens) {
        try {
          const locs = await listLocations(t.token, t.env || 'production');
          locs.forEach(l => out.push({ account: t.name || '(main)', id: l.id, name: l.name, normalized: normName(l.name), timezone: l.timezone }));
        } catch (e) { out.push({ account: t.name || '(main)', error: e.message }); }
      }
      res.setHeader('Cache-Control', 's-maxage=300');
      return res.status(200).json({ count: out.length, locations: out });
    }

    const month = String(req.query.month || '');
    const locQuery = String(req.query.location || '');
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM が必要です' });
    if (!locQuery && !req.query.location_id) return res.status(400).json({ error: 'location（店舗名の一部）または location_id が必要です' });

    // 月範囲（JST基準 → UTC ISO）: JST月初 = UTC前月末15:00
    const [y, m] = month.split('-').map(Number);
    const beginIso = new Date(Date.UTC(y, m - 1, 1, -9, 0, 0)).toISOString();
    const endIso = new Date(Date.UTC(y, m, 1, -9, 0, 0)).toISOString();

    // 店舗識別は SQUARE_TOKENS の name（店舗名）。まず name で候補アカウントを絞り、
    // 該当アカウントのみ locations を取得（全88アカウントを走査せず高速化）。
    const candidateTokens = req.query.location_id
      ? tokens
      : tokens.filter(t => normName(t.name || '').includes(locQuery) || (t.name || '').includes(locQuery));
    const matches = [];
    for (const t of candidateTokens) {
      const env = t.env || 'production';
      let locs;
      try { locs = await listLocations(t.token, env); } catch (e) { continue; }
      for (const l of locs) {
        if (req.query.location_id && String(l.id) !== String(req.query.location_id)) continue;
        matches.push({ token: t.token, env, account: t.name || '(main)', location: l });
      }
    }
    if (matches.length === 0) return res.status(404).json({ error: `ロケーション「${locQuery || req.query.location_id}」が見つかりません`, hint: '?locations=1 で一覧を確認' });

    // マッチ全店を合算（通常は1件）
    const agg = { grossSales: 0, fees: 0, paymentCount: 0, refunds: 0, refundCount: 0, net: 0 };
    const detail = [];
    for (const mt of matches) {
      const r = await fetchSettlement(mt.token, mt.env, mt.location.id, beginIso, endIso);
      ['grossSales', 'fees', 'paymentCount', 'refunds', 'refundCount', 'net'].forEach(k => agg[k] += r[k]);
      detail.push({ account: mt.account, locationId: mt.location.id, locationName: mt.location.name, timezone: mt.location.timezone, ...r });
    }

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');
    return res.status(200).json({
      month, location: locQuery || req.query.location_id,
      period: { beginIso, endIso },
      squareGrossSales: agg.grossSales,   // Square 総決済額（税込）
      squareFees: agg.fees,               // Square 実決済手数料
      refunds: agg.refunds,               // 返金
      netDeposit: agg.net,                // 純額（総決済 - 手数料 - 返金）
      paymentCount: agg.paymentCount,
      refundCount: agg.refundCount,
      matchedLocations: detail.map(d => ({ account: d.account, name: d.locationName, timezone: d.timezone })),
      detail,
    });
  } catch (err) {
    console.error('[square/settlement] error:', err);
    return res.status(502).json({ error: 'Square API error', message: err.message });
  }
}
