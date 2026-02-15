// Square クライアント初期化（動的importで依存関係の読み込み失敗を防止）
async function getClient() {
  const { Client, Environment } = await import('square');
  return new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: process.env.SQUARE_ENVIRONMENT === 'production'
      ? Environment.Production
      : Environment.Sandbox,
  });
}

// BigInt を Number に安全変換
function toNumber(val) {
  if (val === undefined || val === null) return 0;
  if (typeof val === 'bigint') return Number(val);
  return Number(val) || 0;
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

  const uniqueIds = [...new Set(planVariationIds)];

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
                  amount: toNumber(pricing.priceMoney.amount),
                  currency: pricing.priceMoney.currency || 'JPY',
                  cadence: phases[0].cadence || 'MONTHLY',
                };
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('Catalog batch fetch error:', err.message);
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

  // --- アクティブサブスクリプション ---
  const active = subscriptions.filter(s => s.status === 'ACTIVE');
  const memberCount = new Set(active.map(s => s.customerId)).size;

  // --- MRR計算 ---
  let mrr = 0;
  for (const sub of active) {
    const planId = sub.planVariationId;
    if (sub.priceOverrideMoney) {
      const amount = toNumber(sub.priceOverrideMoney.amount);
      mrr += normalizeToMonthly(amount, 'MONTHLY');
    } else if (planPrices[planId]) {
      const { amount, cadence } = planPrices[planId];
      mrr += normalizeToMonthly(amount, cadence);
    }
  }

  // --- 解約率計算（過去30日間） ---
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const recentCanceled = subscriptions.filter(s => {
    if (s.status !== 'CANCELED' && s.status !== 'DEACTIVATED') return false;
    const cancelDate = s.canceledDate ? new Date(s.canceledDate) : null;
    return cancelDate && cancelDate >= thirtyDaysAgo;
  });

  const activeAtStart = active.length + recentCanceled.length;
  const churnRate = activeAtStart > 0
    ? (recentCanceled.length / activeAtStart) * 100
    : 0;

  // --- 継続率 ---
  const retentionRate = 100 - churnRate;

  // --- LTV計算 ---
  const avgMonthlyRevPerMember = memberCount > 0 ? mrr / memberCount : 0;
  const monthlyChurnRate = churnRate / 100;
  const ltv = monthlyChurnRate > 0
    ? avgMonthlyRevPerMember / monthlyChurnRate
    : avgMonthlyRevPerMember * 24;

  // --- 月別推移データ（過去12ヶ月） ---
  const monthlyData = [];
  for (let i = 11; i >= 0; i--) {
    const targetDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = toYearMonth(targetDate.toISOString());
    const endOfMonth = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0);

    const activeAtMonth = subscriptions.filter(s => {
      const startDate = s.startDate ? new Date(s.startDate) : (s.createdAt ? new Date(s.createdAt) : null);
      if (!startDate || startDate > endOfMonth) return false;
      if (s.status === 'ACTIVE' || s.status === 'PAUSED') return true;
      const cancelDate = s.canceledDate ? new Date(s.canceledDate) : null;
      if (cancelDate && cancelDate > endOfMonth) return true;
      return false;
    });

    const monthMemberCount = new Set(activeAtMonth.map(s => s.customerId)).size;

    let monthMrr = 0;
    for (const sub of activeAtMonth) {
      const planId = sub.planVariationId;
      if (sub.priceOverrideMoney) {
        monthMrr += normalizeToMonthly(toNumber(sub.priceOverrideMoney.amount), 'MONTHLY');
      } else if (planPrices[planId]) {
        const { amount, cadence } = planPrices[planId];
        monthMrr += normalizeToMonthly(amount, cadence);
      }
    }

    const newEnrolled = subscriptions.filter(s => {
      const startDate = s.startDate ? new Date(s.startDate) : (s.createdAt ? new Date(s.createdAt) : null);
      return startDate && toYearMonth(startDate.toISOString()) === ym;
    }).length;

    const canceled = subscriptions.filter(s => {
      if (s.status !== 'CANCELED' && s.status !== 'DEACTIVATED') return false;
      const cancelDate = s.canceledDate ? new Date(s.canceledDate) : null;
      return cancelDate && toYearMonth(cancelDate.toISOString()) === ym;
    }).length;

    monthlyData.push({ month: ym, memberCount: monthMemberCount, mrr: monthMrr, newEnrolled, canceled });
  }

  // --- 前月比 ---
  const currentMonthData = monthlyData[monthlyData.length - 1];
  const prevMonthData = monthlyData.length >= 2 ? monthlyData[monthlyData.length - 2] : null;

  const mrrChange = prevMonthData
    ? (prevMonthData.mrr > 0 ? ((currentMonthData.mrr - prevMonthData.mrr) / prevMonthData.mrr) * 100 : 0)
    : 0;

  const memberChange = prevMonthData
    ? currentMonthData.memberCount - prevMonthData.memberCount
    : 0;

  return {
    summary: {
      mrr: Math.round(mrr),
      memberCount,
      churnRate: Math.round(churnRate * 100) / 100,
      retentionRate: Math.round(retentionRate * 100) / 100,
      ltv: Math.round(ltv),
      mrrChange: Math.round(mrrChange * 100) / 100,
      memberChange,
    },
    monthlyTrends: monthlyData.map(m => ({ ...m, mrr: Math.round(m.mrr) })),
    meta: {
      totalSubscriptions: subscriptions.length,
      activeSubscriptions: active.length,
      locationId: process.env.SQUARE_LOCATION_ID,
      currency: 'JPY',
      generatedAt: now.toISOString(),
    },
  };
}

// デモデータ生成
function generateDemoData() {
  const now = new Date();
  const monthlyTrends = [];

  // 12ヶ月分のリアルなトレンドデータ
  let baseMemberCount = 42;
  let baseMrr = 378000; // ¥37.8万

  for (let i = 11; i >= 0; i--) {
    const targetDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}`;

    // 自然な成長トレンド + 季節変動
    const seasonFactor = 1 + 0.05 * Math.sin((targetDate.getMonth() - 3) * Math.PI / 6);
    const growthRate = 1.03 + Math.random() * 0.04; // 月3-7%成長

    const newEnrolled = Math.floor(4 + Math.random() * 6); // 月4-9名入会
    const canceled = Math.floor(1 + Math.random() * 3);    // 月1-3名解約

    baseMemberCount = Math.max(10, baseMemberCount + newEnrolled - canceled);
    baseMrr = Math.round(baseMemberCount * (8500 + Math.random() * 1500) * seasonFactor);

    monthlyTrends.push({
      month: ym,
      memberCount: baseMemberCount,
      mrr: baseMrr,
      newEnrolled,
      canceled,
    });
  }

  const current = monthlyTrends[monthlyTrends.length - 1];
  const prev = monthlyTrends[monthlyTrends.length - 2];
  const mrrChange = prev.mrr > 0 ? Math.round(((current.mrr - prev.mrr) / prev.mrr) * 10000) / 100 : 0;
  const memberChange = current.memberCount - prev.memberCount;

  // 過去30日間の解約数
  const recentCanceled = current.canceled;
  const activeAtStart = current.memberCount + recentCanceled;
  const churnRate = Math.round((recentCanceled / activeAtStart) * 10000) / 100;
  const retentionRate = Math.round((100 - churnRate) * 100) / 100;
  const avgRevPerMember = current.memberCount > 0 ? current.mrr / current.memberCount : 0;
  const ltv = churnRate > 0 ? Math.round(avgRevPerMember / (churnRate / 100)) : Math.round(avgRevPerMember * 24);

  return {
    success: true,
    demo: true,
    summary: {
      mrr: current.mrr,
      memberCount: current.memberCount,
      churnRate,
      retentionRate,
      ltv,
      mrrChange,
      memberChange,
    },
    monthlyTrends,
    meta: {
      totalSubscriptions: current.memberCount + 18,
      activeSubscriptions: current.memberCount,
      locationId: 'DEMO_LOCATION',
      currency: 'JPY',
      generatedAt: now.toISOString(),
    },
  };
}

export default async function handler(req, res) {
  // 全レスポンスをJSONとして返すことを保証
  res.setHeader('Content-Type', 'application/json');

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // デモモード: ?demo=true でダミーデータを返す
  if (req.query.demo === 'true') {
    return res.status(200).json(generateDemoData());
  }

  // 環境変数チェック
  if (!process.env.SQUARE_ACCESS_TOKEN) {
    return res.status(500).json({ success: false, error: 'SQUARE_ACCESS_TOKEN が未設定です。Vercelの環境変数を確認してください。' });
  }
  if (!process.env.SQUARE_LOCATION_ID) {
    return res.status(500).json({ success: false, error: 'SQUARE_LOCATION_ID が未設定です。Vercelの環境変数を確認してください。' });
  }
  if (!process.env.SQUARE_ENVIRONMENT) {
    return res.status(500).json({ success: false, error: 'SQUARE_ENVIRONMENT が未設定です。Vercelの環境変数に "production" を設定してください。' });
  }

  try {
    const client = await getClient();
    const locationId = process.env.SQUARE_LOCATION_ID;

    const [subscriptions, invoices] = await Promise.all([
      fetchAllSubscriptions(client, locationId),
      fetchSubscriptionInvoices(client, locationId),
    ]);

    const planVariationIds = subscriptions
      .map(s => s.planVariationId)
      .filter(Boolean);
    const planPrices = await fetchPlanPrices(client, planVariationIds);

    const metrics = calculateMetrics(subscriptions, planPrices, invoices);

    return res.status(200).json({ success: true, ...metrics });
  } catch (err) {
    console.error('Square API error:', err);

    let errorMessage = err.message || 'Square API request failed';
    let errorDetail = null;

    if (err.result && err.result.errors) {
      errorDetail = err.result.errors.map(e => `${e.category}: ${e.code} - ${e.detail}`).join('; ');
      errorMessage = errorDetail;
    } else if (err.errors) {
      errorDetail = err.errors.map(e => `${e.category}: ${e.code} - ${e.detail}`).join('; ');
      errorMessage = errorDetail;
    }

    return res.status(500).json({ success: false, error: errorMessage, detail: errorDetail });
  }
}
