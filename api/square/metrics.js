// Square API からサブスクリプションデータを取得
// 複数Squareアカウント対応・全店舗・顧客名＋インボイス付き

let _squareModule = null;
async function getSquareModule() {
  if (!_squareModule) _squareModule = await import('square');
  return _squareModule;
}

// 環境変数からトークン設定を取得
// SQUARE_TOKENS: JSON配列 [{"name":"恵比寿院","token":"xxx","env":"production"}, ...]
// SQUARE_ACCESS_TOKEN: 後方互換（単一アカウント用）
function getTokenConfigs() {
  if (process.env.SQUARE_TOKENS) {
    try {
      const tokens = JSON.parse(process.env.SQUARE_TOKENS);
      if (Array.isArray(tokens) && tokens.length > 0) return tokens;
    } catch (e) {
      console.error('SQUARE_TOKENS parse error:', e.message);
    }
  }
  if (process.env.SQUARE_ACCESS_TOKEN) {
    return [{
      name: '',
      token: process.env.SQUARE_ACCESS_TOKEN,
      env: process.env.SQUARE_ENVIRONMENT || 'production',
    }];
  }
  return [];
}

async function createClient(tokenConfig) {
  const { Client, Environment } = await getSquareModule();
  return new Client({
    accessToken: tokenConfig.token,
    environment: tokenConfig.env === 'production' ? Environment.Production : Environment.Sandbox,
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

// 全決済データ取得（売上サマリー用 - Orders API）
async function fetchPayments(client, locationIds) {
  const payments = [];
  const beginTime = new Date();
  beginTime.setMonth(beginTime.getMonth() - 13);
  const beginStr = beginTime.toISOString();

  let cursor = undefined;
  do {
    try {
      const body = {
        locationIds,
        query: {
          filter: {
            dateTimeFilter: {
              closedAt: { startAt: beginStr },
            },
            stateFilter: { states: ['COMPLETED'] },
          },
          sort: { sortField: 'CLOSED_AT', sortOrder: 'DESC' },
        },
      };
      if (cursor) body.cursor = cursor;
      const { result } = await client.ordersApi.searchOrders(body);
      if (result.orders) {
        for (const o of result.orders) {
          payments.push({
            amount: toNumber(o.totalMoney && o.totalMoney.amount),
            createdAt: o.closedAt || o.createdAt,
            locationId: o.locationId,
          });
        }
      }
      cursor = result.cursor;
    } catch (err) {
      console.error('fetchPayments (orders) error:', err.message);
      cursor = undefined;
    }
  } while (cursor);
  return payments;
}

// 全顧客名を取得
async function fetchAllCustomers(client) {
  const customers = {};
  let cursor = undefined;
  do {
    const { result } = cursor
      ? await client.customersApi.listCustomers(cursor)
      : await client.customersApi.listCustomers();
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

// 1つのSquareアカウントの全データを取得
async function fetchAccountData(tokenConfig, isMultiAccount) {
  const accountName = tokenConfig.name || '';
  try {
    const client = await createClient(tokenConfig);

    let stores = await fetchLocations(client);
    if (stores.length === 0) {
      stores = [{ id: `default-${accountName}`, name: accountName || 'メイン店舗' }];
    }
    // 複数アカウント時は店舗名にアカウント名を付与
    if (isMultiAccount && accountName) {
      stores = stores.map(s => ({ ...s, name: `${accountName}` + (stores.length > 1 ? ` (${s.name})` : '') }));
    }
    const locationIds = stores.map(s => s.id);

    // サブスク＋インボイス＋決済を並列取得
    const [rawSubs, invoices, payments] = await Promise.all([
      fetchAllSubscriptions(client, locationIds),
      fetchInvoices(client, locationIds),
      fetchPayments(client, locationIds),
    ]);

    // 顧客名＋プラン詳細を並列取得
    const planVariationIds = rawSubs.map(s => s.planVariationId).filter(Boolean);
    const [customers, plans] = await Promise.all([
      fetchAllCustomers(client),
      fetchPlanDetails(client, planVariationIds),
    ]);

    // サブスクリプションを整形
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

    console.log(`[${accountName || 'main'}] ${stores.length} stores, ${subscriptions.length} subs, ${invoices.length} inv, ${payments.length} payments`);
    return { stores, subscriptions, customers, invoices, payments, plans };
  } catch (err) {
    console.error(`Account "${accountName}" error:`, err.message);
    return null;
  }
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

    const configs = getTokenConfigs();
    if (configs.length === 0) {
      return sendJson(res, 500, {
        success: false,
        error: '環境変数が未設定です: SQUARE_ACCESS_TOKEN または SQUARE_TOKENS を設定してください',
      });
    }

    const isMultiAccount = configs.length > 1;

    // 全アカウントのデータを並列取得（最大10アカウントずつ）
    const merged = {
      stores: [],
      subscriptions: [],
      customers: {},
      invoices: [],
      payments: [],
      plans: {},
    };

    const BATCH_SIZE = 10;
    for (let i = 0; i < configs.length; i += BATCH_SIZE) {
      const batch = configs.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(cfg => fetchAccountData(cfg, isMultiAccount))
      );
      for (const r of results) {
        if (!r) continue;
        merged.stores.push(...r.stores);
        merged.subscriptions.push(...r.subscriptions);
        Object.assign(merged.customers, r.customers);
        merged.invoices.push(...r.invoices);
        merged.payments.push(...r.payments);
        Object.assign(merged.plans, r.plans);
      }
    }

    if (merged.stores.length === 0) {
      return sendJson(res, 500, { success: false, error: 'ロケーションが見つかりません' });
    }

    return sendJson(res, 200, {
      success: true,
      stores: merged.stores,
      plans: merged.plans,
      subscriptions: merged.subscriptions,
      customers: merged.customers,
      invoices: merged.invoices,
      payments: merged.payments,
      meta: {
        totalSubscriptions: merged.subscriptions.length,
        totalInvoices: merged.invoices.length,
        totalPayments: merged.payments.length,
        totalAccounts: configs.length,
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
