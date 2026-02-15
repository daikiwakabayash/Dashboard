// Square API からサブスクリプションデータを取得
// 全店舗対応・フロントエンドで分析計算を行う設計

async function getClient() {
  const { Client, Environment } = await import('square');
  return new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: process.env.SQUARE_ENVIRONMENT === 'production'
      ? Environment.Production
      : Environment.Sandbox,
  });
}

function toNumber(val) {
  if (val === undefined || val === null) return 0;
  if (typeof val === 'bigint') return Number(val);
  return Number(val) || 0;
}

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

// 全ロケーション取得
async function fetchLocations(client) {
  try {
    const { result } = await client.locationsApi.listLocations();
    return (result.locations || []).map(loc => ({
      id: loc.id,
      name: loc.name || loc.id,
    }));
  } catch (err) {
    console.error('Failed to fetch locations:', err.message);
    return [];
  }
}

// 全サブスクリプション取得（複数ロケーション対応）
async function fetchAllSubscriptions(client, locationIds) {
  const subscriptions = [];
  let cursor = undefined;
  do {
    const { result } = await client.subscriptionsApi.searchSubscriptions({
      query: { filter: { locationIds } },
      cursor,
    });
    if (result.subscriptions) subscriptions.push(...result.subscriptions);
    cursor = result.cursor;
  } while (cursor);
  return subscriptions;
}

// カタログからプラン詳細取得（名前＋価格）
async function fetchPlanDetails(client, planVariationIds) {
  const plans = {};
  if (planVariationIds.length === 0) return plans;
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
            const data = obj.subscriptionPlanVariationData;
            const phases = data.phases || [];
            let amount = 0, cadence = 'MONTHLY', currency = 'JPY';
            if (phases.length > 0 && phases[0].pricing && phases[0].pricing.priceMoney) {
              amount = toNumber(phases[0].pricing.priceMoney.amount);
              currency = phases[0].pricing.priceMoney.currency || 'JPY';
              cadence = phases[0].cadence || 'MONTHLY';
            }
            plans[obj.id] = {
              name: data.name || obj.id,
              amount,
              currency,
              cadence,
              monthlyPrice: Math.round(normalizeToMonthly(amount, cadence)),
            };
          }
        }
      }
    } catch (err) {
      console.error('Catalog batch fetch error:', err.message);
    }
  }
  return plans;
}

function safeJson(obj) {
  return JSON.stringify(obj, (_, v) => typeof v === 'bigint' ? Number(v) : v);
}

function sendJson(res, status, data) {
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).end(safeJson(data));
}

export default async function handler(req, res) {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });
    if (req.method !== 'GET') return sendJson(res, 405, { success: false, error: 'Method not allowed' });

    const missing = [];
    if (!process.env.SQUARE_ACCESS_TOKEN) missing.push('SQUARE_ACCESS_TOKEN');
    if (!process.env.SQUARE_ENVIRONMENT) missing.push('SQUARE_ENVIRONMENT');
    if (missing.length > 0) {
      return sendJson(res, 500, {
        success: false,
        error: `環境変数が未設定です: ${missing.join(', ')}`,
      });
    }

    const client = await getClient();

    // 1. 全ロケーション取得
    let stores = await fetchLocations(client);
    if (process.env.SQUARE_LOCATION_ID && stores.length === 0) {
      stores = [{ id: process.env.SQUARE_LOCATION_ID, name: 'メイン店舗' }];
    }
    if (stores.length === 0) {
      return sendJson(res, 500, { success: false, error: 'ロケーションが見つかりません' });
    }
    const locationIds = stores.map(s => s.id);

    // 2. 全サブスクリプション取得
    const rawSubs = await fetchAllSubscriptions(client, locationIds);

    // 3. プラン詳細取得
    const planVariationIds = rawSubs.map(s => s.planVariationId).filter(Boolean);
    const plans = await fetchPlanDetails(client, planVariationIds);

    // 4. サブスクリプションを整形して返却
    const subscriptions = rawSubs.map(s => {
      const plan = plans[s.planVariationId];
      let monthlyPrice = 0;
      if (s.priceOverrideMoney) {
        monthlyPrice = Math.round(normalizeToMonthly(toNumber(s.priceOverrideMoney.amount), 'MONTHLY'));
      } else if (plan) {
        monthlyPrice = plan.monthlyPrice;
      }
      return {
        id: s.id,
        customerId: s.customerId,
        locationId: s.locationId,
        planVariationId: s.planVariationId,
        status: s.status,
        startDate: s.startDate || (s.createdAt ? s.createdAt.split('T')[0] : null),
        canceledDate: s.canceledDate || null,
        monthlyPrice,
      };
    });

    return sendJson(res, 200, {
      success: true,
      stores,
      plans,
      subscriptions,
      meta: {
        totalSubscriptions: subscriptions.length,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('Square API error:', err);
    let errorMessage = err.message || 'Square API request failed';
    let errorDetail = null;
    try {
      if (err.result && err.result.errors) {
        errorDetail = err.result.errors.map(e => `${e.category}: ${e.code} - ${e.detail}`).join('; ');
        errorMessage = errorDetail;
      } else if (err.errors) {
        errorDetail = err.errors.map(e => `${e.category}: ${e.code} - ${e.detail}`).join('; ');
        errorMessage = errorDetail;
      }
    } catch (_) {}
    return sendJson(res, 500, { success: false, error: errorMessage, detail: errorDetail });
  }
}
