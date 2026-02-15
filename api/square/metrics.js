const { Client, Environment } = require('square');

// Square クライアント初期化
function getClient() {
  return new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: process.env.SQUARE_ENVIRONMENT === 'production'
      ? Environment.Production
      : Environment.Sandbox,
  });
}

// 全サブスクリプションを取得（ページネーション対応）
async function fetchAllSubscriptions(client, locationId) {
  const subscriptions = [];
  let cursor = undefined;

  do {
    const { result } = await client.subscriptionsApi.searchSubscriptions({
      query: {
        filter: {
          locationIds: [locationId],
        },
      },
      cursor,
    });

    if (result.subscriptions) {
      subscriptions.push(...result.subscriptions);
    }
    cursor = result.cursor;
  } while (cursor);

  return subscriptions;
}

// カタログからサブスクリプションプランの価格情報を取得
async function fetchPlanPrices(client, planVariationIds) {
  const prices = {};
  if (planVariationIds.length === 0) return prices;

  // 重複を除去
  const uniqueIds = [...new Set(planVariationIds)];

  // バッチで取得（最大1000件）
  for (let i = 0; i < uniqueIds.length; i += 100) {
    const batch = uniqueIds.slice(i, i + 100);
    try {
      const { result } = await client.catalogApi.batchRetrieveCatalogObjects({
        objectIds: batch,
        includeRelatedObjects: true,
      });

      if (result.objects) {
        for (const obj of result.objects) {
          if (obj.subscriptionPlanVariationData) {
            const phases = obj.subscriptionPlanVariationData.phases || [];
            if (phases.length > 0) {
              const pricing = phases[0].pricing;
              if (pricing && pricing.priceMoney) {
                prices[obj.id] = {
                  amount: Number(pricing.priceMoney.amount) || 0,
                  currency: pricing.priceMoney.currency || 'JPY',
                  cadence: phases[0].cadence || 'MONTHLY',
                };
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(`Catalog batch fetch error:`, err.message);
    }
  }

  return prices;
}

// インボイスからサブスクリプション売上を取得
async function fetchSubscriptionInvoices(client, locationId) {
  const invoices = [];
  let cursor = undefined;

  do {
    const { result } = await client.invoicesApi.listInvoices({
      locationId,
      cursor,
    });

    if (result.invoices) {
      for (const inv of result.invoices) {
        if (inv.subscriptionId && inv.status === 'PAID') {
          invoices.push(inv);
        }
      }
    }
    cursor = result.cursor;
  } while (cursor);

  return invoices;
}

// 月額に正規化（cadenceによる換算）
function normalizeToMonthly(amount, cadence) {
  switch (cadence) {
    case 'DAILY': return amount * 30;
    case 'WEEKLY': return amount * 4.33;
    case 'EVERY_TWO_WEEKS': return amount * 2.17;
    case 'MONTHLY': return amount;
    case 'EVERY_TWO_MONTHS': return amount / 2;
    case 'QUARTERLY': return amount / 3;
    case 'EVERY_FOUR_MONTHS': return amount / 4;
    case 'EVERY_SIX_MONTHS': return amount / 6;
    case 'ANNUAL': return amount / 12;
    default: return amount;
  }
}

// 日付文字列を YYYY-MM 形式に変換
function toYearMonth(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// 指標を計算
function calculateMetrics(subscriptions, planPrices, invoices) {
  const now = new Date();
  const currentYM = toYearMonth(now.toISOString());
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevYM = toYearMonth(prevMonth.toISOString());

  // --- アクティブサブスクリプション ---
  const active = subscriptions.filter(s => s.status === 'ACTIVE');
  const memberCount = new Set(active.map(s => s.customerId)).size;

  // --- MRR計算 ---
  let mrr = 0;
  for (const sub of active) {
    const planId = sub.planVariationId;
    if (sub.priceOverrideMoney) {
      const amount = Number(sub.priceOverrideMoney.amount) || 0;
      mrr += normalizeToMonthly(amount, 'MONTHLY');
    } else if (planPrices[planId]) {
      const { amount, cadence } = planPrices[planId];
      mrr += normalizeToMonthly(amount, cadence);
    }
  }

  // --- 解約率計算 ---
  // 過去30日間の解約
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const recentCanceled = subscriptions.filter(s => {
    if (s.status !== 'CANCELED' && s.status !== 'DEACTIVATED') return false;
    const cancelDate = s.canceledDate ? new Date(s.canceledDate) : null;
    return cancelDate && cancelDate >= thirtyDaysAgo;
  });

  // 30日前時点のアクティブ会員数（近似）
  const activeAtStart = active.length + recentCanceled.length;
  const churnRate = activeAtStart > 0
    ? (recentCanceled.length / activeAtStart) * 100
    : 0;

  // --- 継続率 ---
  const retentionRate = 100 - churnRate;

  // --- LTV計算 ---
  // 方法: 平均月額売上 / 月次解約率
  const avgMonthlyRevPerMember = memberCount > 0 ? mrr / memberCount : 0;
  const monthlyChurnRate = churnRate / 100;
  const ltv = monthlyChurnRate > 0
    ? avgMonthlyRevPerMember / monthlyChurnRate
    : avgMonthlyRevPerMember * 24; // 解約率0の場合は24ヶ月分と仮定

  // --- 月別推移データ（過去12ヶ月） ---
  const monthlyData = [];
  for (let i = 11; i >= 0; i--) {
    const targetDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = toYearMonth(targetDate.toISOString());
    const endOfMonth = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0);

    // その月末時点でアクティブだったサブスクリプション
    const activeAtMonth = subscriptions.filter(s => {
      const startDate = s.startDate ? new Date(s.startDate) : (s.createdAt ? new Date(s.createdAt) : null);
      if (!startDate || startDate > endOfMonth) return false;

      if (s.status === 'ACTIVE' || s.status === 'PAUSED') return true;

      // 解約日がその月末より後なら、その月はまだアクティブ
      const cancelDate = s.canceledDate ? new Date(s.canceledDate) : null;
      if (cancelDate && cancelDate > endOfMonth) return true;

      return false;
    });

    const monthMemberCount = new Set(activeAtMonth.map(s => s.customerId)).size;

    // その月のMRR
    let monthMrr = 0;
    for (const sub of activeAtMonth) {
      const planId = sub.planVariationId;
      if (sub.priceOverrideMoney) {
        monthMrr += normalizeToMonthly(Number(sub.priceOverrideMoney.amount) || 0, 'MONTHLY');
      } else if (planPrices[planId]) {
        const { amount, cadence } = planPrices[planId];
        monthMrr += normalizeToMonthly(amount, cadence);
      }
    }

    // その月の新規入会
    const newEnrolled = subscriptions.filter(s => {
      const startDate = s.startDate ? new Date(s.startDate) : (s.createdAt ? new Date(s.createdAt) : null);
      return startDate && toYearMonth(startDate.toISOString()) === ym;
    }).length;

    // その月の解約
    const canceled = subscriptions.filter(s => {
      if (s.status !== 'CANCELED' && s.status !== 'DEACTIVATED') return false;
      const cancelDate = s.canceledDate ? new Date(s.canceledDate) : null;
      return cancelDate && toYearMonth(cancelDate.toISOString()) === ym;
    }).length;

    monthlyData.push({
      month: ym,
      memberCount: monthMemberCount,
      mrr: monthMrr,
      newEnrolled,
      canceled,
    });
  }

  // --- 前月比 ---
  const currentMonthData = monthlyData[monthlyData.length - 1];
  const prevMonthData = monthlyData.length >= 2 ? monthlyData[monthlyData.length - 2] : null;

  const mrrChange = prevMonthData
    ? (prevMonthData.mrr > 0
      ? ((currentMonthData.mrr - prevMonthData.mrr) / prevMonthData.mrr) * 100
      : 0)
    : 0;

  const memberChange = prevMonthData
    ? currentMonthData.memberCount - prevMonthData.memberCount
    : 0;

  // --- インボイスベースの実績売上（参考値） ---
  const invoiceRevenue = {};
  for (const inv of invoices) {
    const ym = toYearMonth(inv.paymentRequests?.[0]?.dueDate || inv.createdAt);
    if (!ym) continue;
    const amount = Number(inv.paymentRequests?.[0]?.computedAmountMoney?.amount) || 0;
    invoiceRevenue[ym] = (invoiceRevenue[ym] || 0) + amount;
  }

  return {
    // TOP画面指標
    summary: {
      mrr: Math.round(mrr),
      memberCount,
      churnRate: Math.round(churnRate * 100) / 100,
      retentionRate: Math.round(retentionRate * 100) / 100,
      ltv: Math.round(ltv),
      mrrChange: Math.round(mrrChange * 100) / 100,
      memberChange,
    },
    // 推移データ
    monthlyTrends: monthlyData.map(m => ({
      ...m,
      mrr: Math.round(m.mrr),
    })),
    // メタ情報
    meta: {
      totalSubscriptions: subscriptions.length,
      activeSubscriptions: active.length,
      locationId: process.env.SQUARE_LOCATION_ID,
      currency: 'JPY',
      generatedAt: now.toISOString(),
    },
  };
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 環境変数チェック
  if (!process.env.SQUARE_ACCESS_TOKEN) {
    return res.status(500).json({ error: 'SQUARE_ACCESS_TOKEN is not configured' });
  }
  if (!process.env.SQUARE_LOCATION_ID) {
    return res.status(500).json({ error: 'SQUARE_LOCATION_ID is not configured' });
  }

  try {
    const client = getClient();
    const locationId = process.env.SQUARE_LOCATION_ID;

    // 並行でデータ取得
    const [subscriptions, invoices] = await Promise.all([
      fetchAllSubscriptions(client, locationId),
      fetchSubscriptionInvoices(client, locationId),
    ]);

    // プランの価格情報を取得
    const planVariationIds = subscriptions
      .map(s => s.planVariationId)
      .filter(Boolean);
    const planPrices = await fetchPlanPrices(client, planVariationIds);

    // 指標計算
    const metrics = calculateMetrics(subscriptions, planPrices, invoices);

    return res.status(200).json({
      success: true,
      ...metrics,
    });
  } catch (err) {
    console.error('Square API error:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Square API request failed',
    });
  }
};
