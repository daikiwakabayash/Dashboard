// Square API からサブスクリプションデータを取得
// 全店舗対応・顧客名＋インボイス付き

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
              amount, currency, cadence,
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

// 全顧客名を取得
async function fetchAllCustomers(client) {
  const customers = {};
  let cursor = undefined;
  do {
    const { result } = await client.customersApi.listCustomers(cursor, 100);
    if (result.customers) {
      for (const c of result.customers) {
        customers[c.id] = {
          name: `${c.familyName || ''} ${c.givenName || ''}`.trim() || c.id,
        };
      }
    }
    cursor = result.cursor;
  } while (cursor);
  return customers;
}

// インボイス取得（全ステータス）
async function fetchInvoices(client, locationIds) {
  const invoices = [];
  let cursor = undefined;
  do {
    const { result } = await client.invoicesApi.searchInvoices({
      query: {
        filter: { locationIds },
        sort: { field: 'INVOICE_SORT_DATE', order: 'DESC' },
      },
      cursor,
    });
    if (result.invoices) {
      for (const inv of result.invoices) {
        const pr = inv.paymentRequests && inv.paymentRequests[0];
        invoices.push({
          id: inv.id,
          customerId: inv.primaryRecipient ? inv.primaryRecipient.customerId : null,
          subscriptionId: inv.subscriptionId || null,
          status: inv.status,
          amount: pr ? toNumber(pr.computedAmountMoney && pr.computedAmountMoney.amount) : 0,
          dueDate: pr ? pr.dueDate : null,
          createdAt: inv.createdAt,
        });
      }
    }
    cursor = result.cursor;
  } while (cursor);
  return invoices;
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

    // 1. ロケーション取得
    let stores = await fetchLocations(client);
    if (process.env.SQUARE_LOCATION_ID && stores.length === 0) {
      stores = [{ id: process.env.SQUARE_LOCATION_ID, name: 'メイン店舗' }];
    }
    if (stores.length === 0) {
      return sendJson(res, 500, { success: false, error: 'ロケーションが見つかりません' });
    }
    const locationIds = stores.map(s => s.id);

    // 2. サブスク＋インボイスを並列取得
    const [rawSubs, invoices] = await Promise.all([
      fetchAllSubscriptions(client, locationIds),
      fetchInvoices(client, locationIds),
    ]);

    // 3. 顧客名＋プラン詳細を並列取得
    const customerIds = [...new Set(rawSubs.map(s => s.customerId).filter(Boolean))];
    const planVariationIds = rawSubs.map(s => s.planVariationId).filter(Boolean);
    const [customers, plans] = await Promise.all([
      fetchAllCustomers(client),
      fetchPlanDetails(client, planVariationIds),
    ]);

    // 4. サブスクリプションを整形
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
      customers,
      invoices,
      meta: {
        totalSubscriptions: subscriptions.length,
        totalInvoices: invoices.length,
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
