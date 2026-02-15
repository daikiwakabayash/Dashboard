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
  // Square APIはlocationIds を1つずつしか受け付けない
  for (const locId of locationIds) {
    let cursor = undefined;
    do {
      const { result } = await client.subscriptionsApi.searchSubscriptions({
        query: { filter: { locationIds: [locId] } },
        cursor,
      });
      if (result.subscriptions) subscriptions.push(...result.subscriptions);
      cursor = result.cursor;
    } while (cursor);
  }
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

// 売上データ取得（Payments API - Square管理画面の「総売上高」と一致）
async function fetchSalesPayments(client, locationIds, diag) {
  const payments = [];
  const beginTime = new Date();
  beginTime.setMonth(beginTime.getMonth() - 13);
  const beginStr = beginTime.toISOString();

  for (const locId of locationIds) {
    let cursor = undefined;
    do {
      try {
        const { result } = await client.paymentsApi.listPayments(
          beginStr,     // beginTime
          undefined,    // endTime
          'DESC',       // sortOrder
          cursor,       // cursor
          locId,        // locationId
        );
        if (result.payments) {
          for (const p of result.payments) {
            if (p.status === 'COMPLETED') {
              payments.push({
                amount: toNumber(p.totalMoney && p.totalMoney.amount),
                createdAt: p.createdAt,
                locationId: p.locationId || locId,
              });
            }
          }
        }
        cursor = result.cursor;
      } catch (err) {
        const errMsg = extractApiError(err);
        console.error(`  Payments API error (${locId}):`, errMsg);
        diag.paymentsApi = `error: ${errMsg}`;
        if (payments.length === 0) return null;
        cursor = undefined;
      }
    } while (cursor);
  }
  diag.paymentsApi = `ok: ${payments.length}件`;
  console.log(`  Payments API: ${payments.length}件取得`);
  return payments;
}

// 返品データ取得（Refunds API）
async function fetchRefundsFromApi(client, locationIds, diag) {
  const refunds = [];
  const beginTime = new Date();
  beginTime.setMonth(beginTime.getMonth() - 13);
  const beginStr = beginTime.toISOString();

  for (const locId of locationIds) {
    let cursor = undefined;
    do {
      try {
        const { result } = await client.refundsApi.listPaymentRefunds(
          beginStr,     // beginTime
          undefined,    // endTime
          'DESC',       // sortOrder
          cursor,       // cursor
          locId,        // locationId
        );
        if (result.refunds) {
          for (const r of result.refunds) {
            if (r.status === 'COMPLETED') {
              refunds.push({
                amount: toNumber(r.amountMoney && r.amountMoney.amount),
                createdAt: r.createdAt,
                locationId: r.locationId || locId,
              });
            }
          }
        }
        cursor = result.cursor;
      } catch (err) {
        const errMsg = extractApiError(err);
        console.error(`  Refunds API error (${locId}):`, errMsg);
        diag.refundsApi = `error: ${errMsg}`;
        if (refunds.length === 0) return null;
        cursor = undefined;
      }
    } while (cursor);
  }
  diag.refundsApi = `ok: ${refunds.length}件`;
  console.log(`  Refunds API: ${refunds.length}件取得`);
  return refunds;
}

// Orders APIフォールバック（売上＋返品を同時取得）
// stateFilterなし → COMPLETED + 支払い済みOPEN注文を含む
async function fetchSalesFromOrders(client, locationIds, diag) {
  const payments = [];
  const refunds = [];
  const stateCount = {};
  const beginTime = new Date();
  beginTime.setMonth(beginTime.getMonth() - 13);
  const beginStr = beginTime.toISOString();

  // ロケーションごとにクエリ（複数渡すとエラーになる場合がある）
  for (const locId of locationIds) {
    let cursor = undefined;
    do {
      try {
        const body = {
          locationIds: [locId],
          query: {
            filter: {
              dateTimeFilter: { createdAt: { startAt: beginStr } },
            },
            sort: { sortField: 'CREATED_AT', sortOrder: 'DESC' },
          },
        };
        if (cursor) body.cursor = cursor;
        const { result } = await client.ordersApi.searchOrders(body);
        if (result.orders) {
          for (const o of result.orders) {
            stateCount[o.state || 'UNKNOWN'] = (stateCount[o.state || 'UNKNOWN'] || 0) + 1;

            if (o.state === 'DRAFT' || o.state === 'CANCELED') continue;

            if (o.state === 'COMPLETED' || (o.tenders && o.tenders.length > 0)) {
              payments.push({
                amount: toNumber(o.totalMoney && o.totalMoney.amount),
                createdAt: o.closedAt || o.createdAt,
                locationId: o.locationId,
              });
            }

            if (o.returnAmounts && o.returnAmounts.totalMoney) {
              const returnAmt = toNumber(o.returnAmounts.totalMoney.amount);
              if (returnAmt > 0) {
                refunds.push({
                  amount: returnAmt,
                  createdAt: o.updatedAt || o.closedAt || o.createdAt,
                  locationId: o.locationId,
                });
              }
            }
          }
        }
        cursor = result.cursor;
      } catch (err) {
        console.error(`  Orders API error (${locId}):`, err.message);
        cursor = undefined;
      }
    } while (cursor);
  }
  diag.ordersFallback = `${payments.length}件売上, ${refunds.length}件返品`;
  diag.orderStates = stateCount;
  console.log(`  Orders API fallback: ${payments.length}件売上, ${refunds.length}件返品, states:`, JSON.stringify(stateCount));
  return { payments, refunds };
}

function extractApiError(err) {
  try {
    if (err.result && err.result.errors) {
      return err.result.errors.map(e => `${e.code}: ${e.detail}`).join('; ');
    }
  } catch (_) {}
  return err.message || 'unknown error';
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
  // Square APIはlocationIds を1つずつしか受け付けない
  for (const locId of locationIds) {
    let cursor = undefined;
    do {
      const { result } = await client.invoicesApi.searchInvoices({
        query: {
          filter: { locationIds: [locId] },
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
  }
  return invoices;
}

// 1つのSquareアカウントの全データを取得
async function fetchAccountData(tokenConfig, isMultiAccount) {
  const accountName = tokenConfig.name || '';
  console.log(`[${accountName || 'main'}] データ取得開始... (token: ${tokenConfig.token ? tokenConfig.token.slice(0, 8) + '...' : 'EMPTY'})`);
  try {
    if (!tokenConfig.token) {
      console.error(`[${accountName}] トークンが空です`);
      return null;
    }
    const client = await createClient(tokenConfig);

    let stores = await fetchLocations(client);
    console.log(`[${accountName || 'main'}] ロケーション取得: ${stores.length}件`, stores.map(s => s.name));
    if (stores.length === 0) {
      stores = [{ id: `default-${accountName}`, name: accountName || 'メイン店舗' }];
    }
    // excludeLocations: 不要なロケーションを除外（例: ["株式会社SSiM"]）
    if (tokenConfig.excludeLocations && Array.isArray(tokenConfig.excludeLocations)) {
      const before = stores.length;
      stores = stores.filter(s => !tokenConfig.excludeLocations.some(ex => s.name && s.name.includes(ex)));
      if (stores.length < before) {
        console.log(`[${accountName}] ${before - stores.length}件のロケーションを除外`);
      }
      if (stores.length === 0) {
        stores = [{ id: `default-${accountName}`, name: accountName || 'メイン店舗' }];
      }
    }
    // アカウント名が設定されている場合は常に店舗名として使用
    if (accountName) {
      stores = stores.map(s => ({ ...s, name: `${accountName}` + (stores.length > 1 ? ` (${s.name})` : '') }));
    }
    const locationIds = stores.map(s => s.id);

    // 診断情報トラッキング
    const diag = {};

    // サブスク＋インボイス＋売上＋返品を並列取得
    const [rawSubs, invoices, paymentsApiData, refundsApiData] = await Promise.all([
      fetchAllSubscriptions(client, locationIds),
      fetchInvoices(client, locationIds),
      fetchSalesPayments(client, locationIds, diag),
      fetchRefundsFromApi(client, locationIds, diag),
    ]);

    let payments = paymentsApiData;
    let refunds = refundsApiData;

    // Payments/Refunds APIが使えない場合、Orders APIフォールバック
    if (payments === null || refunds === null) {
      console.log(`  → Orders APIフォールバック (payments=${payments === null ? '必要' : 'OK'}, refunds=${refunds === null ? '必要' : 'OK'})`);
      const ordersData = await fetchSalesFromOrders(client, locationIds, diag);
      if (payments === null) payments = ordersData.payments;
      if (refunds === null) refunds = ordersData.refunds;
    }
    payments = payments || [];
    refunds = refunds || [];

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

    console.log(`[${accountName || 'main'}] ${stores.length} stores, ${subscriptions.length} subs, ${invoices.length} inv, ${payments.length} payments, ${refunds.length} refunds`);
    return { stores, subscriptions, customers, invoices, payments, refunds, plans, _diag: diag };
  } catch (err) {
    let detail = err.message;
    try {
      if (err.result && err.result.errors) {
        detail = err.result.errors.map(e => `${e.code}: ${e.detail}`).join('; ');
      }
    } catch (_) {}
    console.error(`❌ Account "${accountName}" error:`, detail);
    console.error(`   Token prefix: ${tokenConfig.token ? tokenConfig.token.slice(0, 12) + '...' : 'EMPTY'}`);
    console.error(`   Environment: ${tokenConfig.env}`);
    return { _failed: true, _errorDetail: detail, _accountName: accountName };
  }
}

function safeJson(obj) {
  return JSON.stringify(obj, (_, v) => typeof v === 'bigint' ? Number(v) : v);
}

function sendJson(res, status, data) {
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).end(safeJson(data));
}

// レスポンス生成ヘルパー
function buildResponse(merged, failedAccounts, allDiag, configs, summaryMode, partial) {
  const meta = {
    totalSubscriptions: merged.subscriptions.length,
    totalInvoices: merged.invoices.length,
    totalPayments: merged.payments.length,
    totalRefunds: merged.refunds.length,
    totalAccounts: configs.length,
    failedAccounts: failedAccounts.length > 0 ? failedAccounts : undefined,
    diagnostics: allDiag,
    partial: partial || undefined,
    generatedAt: new Date().toISOString(),
  };

  if (summaryMode) {
    const salesByMonth = {};
    merged.payments.forEach(p => {
      const ym = p.createdAt ? p.createdAt.slice(0, 7) : 'unknown';
      if (!salesByMonth[ym]) salesByMonth[ym] = { total: 0, count: 0 };
      salesByMonth[ym].total += p.amount;
      salesByMonth[ym].count++;
    });
    const refundsByMonth = {};
    merged.refunds.forEach(r => {
      const ym = r.createdAt ? r.createdAt.slice(0, 7) : 'unknown';
      if (!refundsByMonth[ym]) refundsByMonth[ym] = { total: 0, count: 0 };
      refundsByMonth[ym].total += r.amount;
      refundsByMonth[ym].count++;
    });
    return { success: true, stores: merged.stores, salesByMonth, refundsByMonth, meta };
  }

  return {
    success: true,
    stores: merged.stores,
    plans: merged.plans,
    subscriptions: merged.subscriptions,
    customers: merged.customers,
    invoices: merged.invoices,
    payments: merged.payments,
    refunds: merged.refunds,
    meta,
  };
}

export default async function handler(req, res) {
  // グローバルデッドライン: Vercelの60秒制限の前に必ずJSONを返す
  const DEADLINE_MS = 50000;
  let hasResponded = false;

  function respond(status, data) {
    if (hasResponded) return;
    hasResponded = true;
    sendJson(res, status, data);
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return respond(200, { ok: true });
  if (req.method !== 'GET') return respond(405, { success: false, error: 'Method not allowed' });

  const configs = getTokenConfigs();
  if (configs.length === 0) {
    return respond(500, {
      success: false,
      error: '環境変数が未設定です: SQUARE_ACCESS_TOKEN または SQUARE_TOKENS を設定してください',
    });
  }

  const isMultiAccount = configs.length > 1;
  const summaryMode = req.query && req.query.summary === '1';

  // 共有データ（各アカウントが完了次第マージ）
  const merged = {
    stores: [], subscriptions: [], customers: {}, invoices: [],
    payments: [], refunds: [], plans: {},
  };
  const failedAccounts = [];
  const allDiag = [];

  // デッドラインタイマー: 50秒で部分データを返す
  const deadlineTimer = setTimeout(() => {
    console.warn('⏰ デッドライン到達 - 部分データで応答します');
    const remaining = configs.filter((cfg, i) =>
      !failedAccounts.some(f => f.name === cfg.name) &&
      !merged.stores.some(s => s.name && s.name.includes(cfg.name))
    );
    remaining.forEach(cfg => {
      failedAccounts.push({ name: cfg.name || 'unknown', error: 'タイムアウト: 処理時間超過' });
    });

    if (merged.stores.length > 0) {
      respond(200, buildResponse(merged, failedAccounts, allDiag, configs, summaryMode, true));
    } else {
      respond(200, {
        success: false,
        error: 'データ取得がタイムアウトしました。再読み込みしてください。',
        stores: [], meta: { failedAccounts, partial: true, generatedAt: new Date().toISOString() },
      });
    }
  }, DEADLINE_MS);

  try {
    // 各アカウントを並列実行、完了次第mergedにマージ
    const accountPromises = configs.map(async (cfg, j) => {
      try {
        const r = await fetchAccountData(cfg, isMultiAccount);
        if (!r || r._failed) {
          const errorDetail = r && r._errorDetail ? r._errorDetail : 'トークンが空または無効です';
          failedAccounts.push({ name: cfg.name || `アカウント${j + 1}`, error: errorDetail });
          console.error(`❌ アカウント「${cfg.name}」失敗: ${errorDetail}`);
          return;
        }
        // 完了次第マージ
        merged.stores.push(...r.stores);
        merged.subscriptions.push(...r.subscriptions);
        Object.assign(merged.customers, r.customers);
        merged.invoices.push(...r.invoices);
        merged.payments.push(...r.payments);
        merged.refunds.push(...(r.refunds || []));
        Object.assign(merged.plans, r.plans);
        if (r._diag) allDiag.push({ account: cfg.name, ...r._diag });
      } catch (err) {
        failedAccounts.push({ name: cfg.name || `アカウント${j + 1}`, error: err.message });
      }
    });

    await Promise.allSettled(accountPromises);
    clearTimeout(deadlineTimer);

    if (hasResponded) return; // デッドラインで既に応答済み

    if (merged.stores.length === 0) {
      return respond(200, {
        success: false,
        error: '全アカウントのデータ取得に失敗しました',
        stores: [], meta: { failedAccounts, generatedAt: new Date().toISOString() },
      });
    }

    return respond(200, buildResponse(merged, failedAccounts, allDiag, configs, summaryMode, false));
  } catch (err) {
    clearTimeout(deadlineTimer);
    console.error('Square API error:', err);
    let errorMessage = err.message || 'Square API request failed';
    try {
      if (err.result && err.result.errors) {
        errorMessage = err.result.errors.map(e => `${e.category}: ${e.code} - ${e.detail}`).join('; ');
      }
    } catch (_) {}
    return respond(500, { success: false, error: errorMessage });
  }
}
