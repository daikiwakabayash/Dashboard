// Square API からサブスクリプションデータを取得
// 複数Squareアカウント対応・全店舗・顧客名＋インボイス付き
// 75店舗対応: 並列処理 + インメモリキャッシュ + バッチ取得

let _squareModule = null;
async function getSquareModule() {
  if (!_squareModule) _squareModule = await import('square');
  return _squareModule;
}

// ── インメモリキャッシュ（Vercel serverless: コールドスタート間で共有） ──
const CACHE_TTL_MS = 5 * 60 * 1000; // 5分
const accountCache = new Map(); // key: accountIndex, value: { data, timestamp }

function getCachedAccount(idx) {
  const entry = accountCache.get(idx);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) {
    console.log(`[cache] アカウント${idx} キャッシュヒット (${Math.round((Date.now() - entry.timestamp) / 1000)}秒前)`);
    return entry.data;
  }
  return null;
}

function setCachedAccount(idx, data) {
  accountCache.set(idx, { data, timestamp: Date.now() });
  // キャッシュサイズ制限（100エントリ超で古いものを削除）
  if (accountCache.size > 100) {
    const oldest = [...accountCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
    if (oldest) accountCache.delete(oldest[0]);
  }
}

// ── 並列実行ユーティリティ（同時実行数制限付き） ──
async function parallelWithLimit(items, limit, fn) {
  const results = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── タイムアウト付きPromise: 指定時間超過でfallback値を返す ──
async function withTimeout(promise, ms, fallback, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label || 'API'} timeout (${ms}ms)`)), ms);
      }),
    ]);
  } catch (e) {
    if (e.message && e.message.includes('timeout')) {
      console.warn(`[timeout] ${label || 'API'}: ${ms}ms超過 → fallback使用`);
      return fallback;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
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

// ── ロケーション並列版: サブスクリプション取得 ──
async function fetchAllSubscriptions(client, locationIds) {
  const allSubs = await parallelWithLimit(locationIds, 3, async (locId) => {
    const subs = [];
    let cursor = undefined;
    do {
      try {
        const { result } = await client.subscriptionsApi.searchSubscriptions({
          query: { filter: { locationIds: [locId] } },
          cursor,
        });
        if (result.subscriptions) subs.push(...result.subscriptions);
        cursor = result.cursor;
      } catch (err) {
        console.error(`  Subscriptions error (${locId}):`, err.message);
        cursor = undefined;
      }
    } while (cursor);
    return subs;
  });
  return allSubs.flat();
}

async function fetchPlanDetails(client, planVariationIds) {
  const plans = {};
  if (planVariationIds.length === 0) return plans;
  const uniqueIds = [...new Set(planVariationIds)];

  for (let i = 0; i < uniqueIds.length; i += 100) {
    const batch = uniqueIds.slice(i, i + 100);
    try {
      // バッチ単位タイムアウト: 全体タイムアウトで部分結果を失わないよう各バッチに10秒上限
      const { result } = await Promise.race([
        client.catalogApi.batchRetrieveCatalogObjects({
          objectIds: batch,
          includeRelatedObjects: true,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Plan batch timeout (10s)')), 10000)),
      ]);
      // objects + relatedObjects の両方からプラン情報を抽出
      const allObjects = [...(result.objects || []), ...(result.relatedObjects || [])];
      for (const obj of allObjects) {
        if (plans[obj.id]) continue; // 既に処理済み
        if (obj.subscriptionPlanVariationData) {
          const data = obj.subscriptionPlanVariationData;
          const phases = data.phases || [];
          let amount = 0, cadence = 'MONTHLY', currency = 'JPY';
          let pricingExtracted = false;
          // 全フェーズを走査し、最初の有料フェーズの価格を使用（トライアルフェーズをスキップ）
          for (const phase of phases) {
            if (phase.pricing && phase.pricing.priceMoney) {
              const phaseAmount = toNumber(phase.pricing.priceMoney.amount);
              if (phaseAmount > 0 || pricingExtracted === false) {
                amount = phaseAmount;
                currency = phase.pricing.priceMoney.currency || 'JPY';
                cadence = phase.cadence || 'MONTHLY';
                pricingExtracted = true;
                if (phaseAmount > 0) break; // 有料フェーズが見つかればそこで終了
              }
            }
          }
          plans[obj.id] = {
            name: data.name || obj.id,
            amount, currency, cadence,
            monthlyPrice: Math.round(normalizeToMonthly(amount, cadence)),
            pricingExtracted, // 価格情報が正常に取得できたかのフラグ
          };
        }
      }
    } catch (err) {
      console.error(`Catalog batch fetch error (batch ${i / 100 + 1}):`, err.message);
      // 部分結果を保持して続行（タイムアウトでも取得済みプランは失わない）
    }
  }
  return plans;
}

// ── ロケーション並列版: 売上データ取得 ──
async function fetchSalesPayments(client, locationIds, diag) {
  const beginTime = new Date();
  beginTime.setMonth(beginTime.getMonth() - 13);
  const beginStr = beginTime.toISOString();
  let hasError = false;

  const allPayments = await parallelWithLimit(locationIds, 3, async (locId) => {
    const payments = [];
    let cursor = undefined;
    do {
      try {
        const { result } = await client.paymentsApi.listPayments(
          beginStr, undefined, 'DESC', cursor, locId,
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
        hasError = true;
        cursor = undefined;
      }
    } while (cursor);
    return payments;
  });

  const flat = allPayments.flat();
  if (hasError && flat.length === 0) return null;
  diag.paymentsApi = `ok: ${flat.length}件`;
  console.log(`  Payments API: ${flat.length}件取得`);
  return flat;
}

// ── ロケーション並列版: 返品データ取得 ──
async function fetchRefundsFromApi(client, locationIds, diag) {
  const beginTime = new Date();
  beginTime.setMonth(beginTime.getMonth() - 13);
  const beginStr = beginTime.toISOString();
  let hasError = false;

  const allRefunds = await parallelWithLimit(locationIds, 3, async (locId) => {
    const refunds = [];
    let cursor = undefined;
    do {
      try {
        const { result } = await client.refundsApi.listPaymentRefunds(
          beginStr, undefined, 'DESC', cursor, locId,
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
        hasError = true;
        cursor = undefined;
      }
    } while (cursor);
    return refunds;
  });

  const flat = allRefunds.flat();
  if (hasError && flat.length === 0) return null;
  diag.refundsApi = `ok: ${flat.length}件`;
  console.log(`  Refunds API: ${flat.length}件取得`);
  return flat;
}

// ── ロケーション並列版: Orders APIフォールバック ──
async function fetchSalesFromOrders(client, locationIds, diag) {
  const beginTime = new Date();
  beginTime.setMonth(beginTime.getMonth() - 13);
  const beginStr = beginTime.toISOString();
  const stateCount = {};

  const allResults = await parallelWithLimit(locationIds, 3, async (locId) => {
    const payments = [];
    const refunds = [];
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
    return { payments, refunds };
  });

  const payments = allResults.flatMap(r => r.payments);
  const refunds = allResults.flatMap(r => r.refunds);
  diag.ordersFallback = `${payments.length}件売上, ${refunds.length}件返品`;
  diag.orderStates = stateCount;
  console.log(`  Orders API fallback: ${payments.length}件売上, ${refunds.length}件返品`);
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

// ── ロケーション並列版: インボイス取得 ──
async function fetchInvoices(client, locationIds) {
  const allInvoices = await parallelWithLimit(locationIds, 3, async (locId) => {
    const invoices = [];
    let cursor = undefined;
    do {
      try {
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
      } catch (err) {
        console.error(`  Invoices error (${locId}):`, err.message);
        cursor = undefined;
      }
    } while (cursor);
    return invoices;
  });
  return allInvoices.flat();
}

// 全顧客名を取得
async function fetchAllCustomers(client) {
  const customers = {};
  let cursor = undefined;
  do {
    try {
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
    } catch (err) {
      console.error('  Customers API error:', err.message);
      cursor = undefined;
    }
  } while (cursor);
  return customers;
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
        console.log(`[${accountName}] ${before - stores.length}件のロケーションを除外 (excludeLocations)`);
      }
    }
    // 複数ロケーション時: 法人名ロケーション（株式会社・合同会社等）を自動除外
    // Squareがビジネスエンティティ用に自動作成するデフォルトロケーションを除外
    if (stores.length > 1) {
      const corpPatterns = ['株式会社', '合同会社', '有限会社', '一般社団法人'];
      const nonCorpStores = stores.filter(s => !corpPatterns.some(p => s.name && s.name.startsWith(p)));
      if (nonCorpStores.length > 0 && nonCorpStores.length < stores.length) {
        console.log(`[${accountName}] ${stores.length - nonCorpStores.length}件の法人ロケーションを自動除外`);
        stores = nonCorpStores;
      }
    }
    if (stores.length === 0) {
      stores = [{ id: `default-${accountName}`, name: accountName || 'メイン店舗' }];
    }
    // アカウント名が設定されている場合は常に店舗名として使用
    if (accountName) {
      stores = stores.map(s => ({ ...s, name: `${accountName}` + (stores.length > 1 ? ` (${s.name})` : '') }));
    }
    const locationIds = stores.map(s => s.id);

    // 診断情報トラッキング
    const diag = {};

    // サブスク＋インボイス＋売上＋返品＋顧客を並列取得（各API個別タイムアウト付き）
    // 顧客取得はサブスクに依存しないためフェーズ1で並列実行し、合計時間を短縮
    const API_TIMEOUT = 25000; // 各API最大25秒
    const [rawSubs, invoices, paymentsApiData, refundsApiData, customers] = await Promise.all([
      withTimeout(fetchAllSubscriptions(client, locationIds), API_TIMEOUT, [], 'Subscriptions'),
      withTimeout(fetchInvoices(client, locationIds), API_TIMEOUT, [], 'Invoices'),
      withTimeout(fetchSalesPayments(client, locationIds, diag), API_TIMEOUT, null, 'Payments'),
      withTimeout(fetchRefundsFromApi(client, locationIds, diag), API_TIMEOUT, null, 'Refunds'),
      withTimeout(fetchAllCustomers(client), 20000, {}, 'Customers'),
    ]);

    let payments = paymentsApiData;
    let refunds = refundsApiData;

    // Payments/Refunds APIが使えない場合、Orders APIフォールバック（タイムアウト付き）
    if (payments === null || refunds === null) {
      console.log(`  -> Orders APIフォールバック (payments=${payments === null ? '必要' : 'OK'}, refunds=${refunds === null ? '必要' : 'OK'})`);
      const ordersData = await withTimeout(
        fetchSalesFromOrders(client, locationIds, diag),
        15000,
        { payments: [], refunds: [] },
        'Orders fallback'
      );
      if (payments === null) payments = ordersData.payments;
      if (refunds === null) refunds = ordersData.refunds;
    }
    payments = payments || [];
    refunds = refunds || [];

    // プラン詳細を取得（サブスクデータに依存するため順次実行・バッチ単位タイムアウトで部分結果を保持）
    const planVariationIds = rawSubs.map(s => s.planVariationId).filter(Boolean);
    const plans = await fetchPlanDetails(client, planVariationIds);
    const plansLoadedCount = Object.keys(plans).length;
    const plansRequestedCount = [...new Set(planVariationIds)].length;
    if (plansRequestedCount > 0) {
      console.log(`[${accountName || 'main'}] Plans: ${plansLoadedCount}/${plansRequestedCount} loaded`);
      if (plansLoadedCount < plansRequestedCount) {
        diag.plansPartial = `${plansLoadedCount}/${plansRequestedCount}`;
      }
    }

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
    console.error(`Account "${accountName}" error:`, detail);
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
    totalStores: merged.stores.length,
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

  // ── アカウント一覧モード: ?info=1 ──
  if (req.query && req.query.info === '1') {
    return sendJson(res, 200, {
      success: true,
      accounts: configs.map((cfg, i) => ({ index: i, name: cfg.name || `アカウント${i + 1}` })),
      totalAccounts: configs.length,
    });
  }

  // ── バッチアカウントモード: ?accounts=0,1,2,3 (複数アカウントを1リクエストで取得) ──
  if (req.query && req.query.accounts !== undefined) {
    const indices = req.query.accounts.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n >= 0 && n < configs.length);
    if (indices.length === 0) {
      return sendJson(res, 400, { success: false, error: 'アカウントインデックスが無効です' });
    }

    const merged = {
      stores: [], subscriptions: [], customers: {},
      invoices: [], payments: [], refunds: [], plans: {},
    };
    const failedAccounts = [];
    const allDiag = [];

    // バッチ内アカウントを並列取得（最大3並列、1アカウント最大90秒タイムアウト）
    await parallelWithLimit(indices, 3, async (idx) => {
      const cfg = configs[idx];
      try {
        // キャッシュ確認
        let r = getCachedAccount(idx);
        if (!r) {
          // アカウント単位タイムアウト: バッチ全体を守る
          // 内部API個別タイムアウト(25s) + Ordersフォールバック(15s) + プラン(10s) = 最大50sを考慮
          r = await Promise.race([
            fetchAccountData(cfg, true),
            new Promise((_, reject) => setTimeout(() => reject(new Error('アカウント取得タイムアウト (90秒)')), 90000)),
          ]);
          if (r && !r._failed) setCachedAccount(idx, r);
        }
        if (!r || r._failed) {
          failedAccounts.push({ name: cfg.name || `アカウント${idx + 1}`, error: r && r._errorDetail ? r._errorDetail : 'トークンが空または無効です' });
          return;
        }
        merged.stores.push(...r.stores);
        merged.subscriptions.push(...r.subscriptions);
        Object.assign(merged.customers, r.customers);
        merged.invoices.push(...r.invoices);
        merged.payments.push(...r.payments);
        merged.refunds.push(...(r.refunds || []));
        Object.assign(merged.plans, r.plans);
        if (r._diag) allDiag.push({ account: cfg.name, ...r._diag });
      } catch (err) {
        failedAccounts.push({ name: cfg.name || `アカウント${idx + 1}`, error: err.message });
      }
    });

    const summaryMode = req.query && req.query.summary === '1';
    if (merged.stores.length === 0 && failedAccounts.length > 0) {
      return sendJson(res, 200, {
        success: false, error: 'バッチ内の全アカウントのデータ取得に失敗しました',
        stores: [], meta: { failedAccounts, generatedAt: new Date().toISOString() },
      });
    }
    return sendJson(res, 200, buildResponse(merged, failedAccounts, allDiag, configs, summaryMode, false));
  }

  // ── 単一アカウントモード: ?account=N ──
  if (req.query && req.query.account !== undefined) {
    const idx = parseInt(req.query.account, 10);
    if (isNaN(idx) || idx < 0 || idx >= configs.length) {
      return sendJson(res, 400, { success: false, error: `アカウントインデックスが無効です: ${req.query.account}` });
    }
    try {
      const cfg = configs[idx];

      // キャッシュ確認
      let r = getCachedAccount(idx);
      if (!r) {
        r = await Promise.race([
          fetchAccountData(cfg, configs.length > 1),
          new Promise((_, reject) => setTimeout(() => reject(new Error('アカウント取得タイムアウト (90秒)')), 90000)),
        ]);
        if (r && !r._failed) setCachedAccount(idx, r);
      }

      if (!r || r._failed) {
        return sendJson(res, 200, {
          success: false,
          error: r && r._errorDetail ? r._errorDetail : 'トークンが空または無効です',
          accountName: cfg.name,
        });
      }
      return sendJson(res, 200, {
        success: true,
        stores: r.stores,
        subscriptions: r.subscriptions,
        customers: r.customers,
        invoices: r.invoices,
        payments: r.payments,
        refunds: r.refunds || [],
        plans: r.plans,
        _diag: r._diag,
      });
    } catch (err) {
      console.error(`Square API error (account ${idx}):`, err);
      let errorMessage = err.message || 'Square API request failed';
      try {
        if (err.result && err.result.errors) {
          errorMessage = err.result.errors.map(e => `${e.code}: ${e.detail}`).join('; ');
        }
      } catch (_) {}
      return sendJson(res, 200, { success: false, error: errorMessage, accountName: configs[idx].name });
    }
  }

  // ── 全アカウント一括モード（後方互換） ──
  const isMultiAccount = configs.length > 1;
  const summaryMode = req.query && req.query.summary === '1';
  const merged = {
    stores: [], subscriptions: [], customers: {}, invoices: [],
    payments: [], refunds: [], plans: {},
  };
  const failedAccounts = [];
  const allDiag = [];

  let deadlineReached = false;
  const deadlineTimer = setTimeout(() => { deadlineReached = true; }, 90000);

  try {
    // 全アカウント並列取得（最大5並列、75店舗対応）
    await parallelWithLimit(configs, 5, async (cfg, j) => {
      if (deadlineReached) {
        failedAccounts.push({ name: cfg.name || `アカウント${j + 1}`, error: 'タイムアウト: 処理時間超過' });
        return;
      }
      try {
        // キャッシュ確認
        let r = getCachedAccount(j);
        if (!r) {
          r = await fetchAccountData(cfg, isMultiAccount);
          if (r && !r._failed) setCachedAccount(j, r);
        }
        if (!r || r._failed) {
          failedAccounts.push({ name: cfg.name || `アカウント${j + 1}`, error: r && r._errorDetail ? r._errorDetail : 'トークンが空または無効です' });
          return;
        }
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
    clearTimeout(deadlineTimer);

    if (merged.stores.length === 0) {
      return sendJson(res, 200, {
        success: false, error: '全アカウントのデータ取得に失敗しました',
        stores: [], meta: { failedAccounts, generatedAt: new Date().toISOString() },
      });
    }
    return sendJson(res, 200, buildResponse(merged, failedAccounts, allDiag, configs, summaryMode, deadlineReached));
  } catch (err) {
    clearTimeout(deadlineTimer);
    console.error('Square API error:', err);
    return sendJson(res, 500, { success: false, error: err.message || 'Square API request failed' });
  }
}
