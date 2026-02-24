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
  // キャッシュサイズ制限（100エントリ超で古いものをバッチ削除）
  if (accountCache.size > 100) {
    const now = Date.now();
    // 期限切れエントリを優先削除
    for (const [key, entry] of accountCache) {
      if (now - entry.timestamp >= CACHE_TTL_MS) accountCache.delete(key);
    }
    // まだ多い場合は最も古い10件を削除
    if (accountCache.size > 100) {
      let oldest = null;
      let oldestTs = Infinity;
      const toDelete = [];
      for (const [key, entry] of accountCache) {
        if (entry.timestamp < oldestTs) {
          oldestTs = entry.timestamp;
          oldest = key;
        }
        if (toDelete.length < 10 || entry.timestamp < oldestTs) {
          toDelete.push(key);
        }
      }
      toDelete.slice(0, 10).forEach(key => accountCache.delete(key));
    }
  }
}

// ── 並列実行ユーティリティ（同時実行数制限付き・エラー耐性あり） ──
async function parallelWithLimit(items, limit, fn) {
  const results = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        console.error(`[parallelWithLimit] item ${i} failed:`, err.message);
        results[i] = undefined;
      }
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
// パース診断情報（?info=1で返却）
let _tokenParseInfo = null;

function getTokenConfigs() {
  const parseInfo = { source: null, error: null, rawLength: 0, parsedCount: 0 };

  if (process.env.SQUARE_TOKENS) {
    const raw = process.env.SQUARE_TOKENS.trim();
    parseInfo.source = 'SQUARE_TOKENS';
    parseInfo.rawLength = raw.length;
    // JSON冒頭・末尾を表示（トークン値をマスク）
    const masked = raw.replace(/"token"\s*:\s*"[^"]*"/g, '"token":"***"');
    parseInfo.rawStart = masked.substring(0, 120);
    parseInfo.rawEnd = masked.length > 120 ? masked.substring(masked.length - 60) : '';

    try {
      const tokens = JSON.parse(raw);
      if (Array.isArray(tokens) && tokens.length > 0) {
        parseInfo.parsedCount = tokens.length;
        parseInfo.names = tokens.map((t, i) => t.name || `(名前なし:${i})`);
        _tokenParseInfo = parseInfo;
        return tokens;
      }
      parseInfo.error = `JSON配列が空またはオブジェクト型 (type: ${typeof tokens}, isArray: ${Array.isArray(tokens)})`;
    } catch (e) {
      parseInfo.error = `JSONパースエラー: ${e.message}`;
      // エラー位置付近を表示（トークンマスク済み）
      const posMatch = e.message.match(/position (\d+)/);
      if (posMatch) {
        const pos = parseInt(posMatch[1], 10);
        const start = Math.max(0, pos - 40);
        const snippet = masked.substring(start, pos + 40);
        parseInfo.errorContext = `...${snippet}...  ← position ${pos}付近`;
      }
      console.error('SQUARE_TOKENS parse error:', e.message);
    }
  }
  if (process.env.SQUARE_ACCESS_TOKEN) {
    parseInfo.source = parseInfo.source ? `SQUARE_TOKENS解析失敗→SQUARE_ACCESS_TOKENフォールバック` : 'SQUARE_ACCESS_TOKEN';
    parseInfo.parsedCount = 1;
    _tokenParseInfo = parseInfo;
    return [{
      name: '',
      token: process.env.SQUARE_ACCESS_TOKEN,
      env: process.env.SQUARE_ENVIRONMENT || 'production',
    }];
  }
  parseInfo.source = '環境変数未設定';
  _tokenParseInfo = parseInfo;
  return [];
}

async function createClient(tokenConfig) {
  const { Client, Environment } = await getSquareModule();
  return new Client({
    accessToken: tokenConfig.token,
    environment: tokenConfig.env === 'production' ? Environment.Production : Environment.Sandbox,
    httpClientOptions: { timeout: 120000 }, // 120秒（デフォルト60秒→大規模ロケーションのページネーション完走用）
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

async function fetchLocations(client, diag) {
  try {
    const { result } = await client.locationsApi.listLocations();
    const locs = (result.locations || []).map(loc => ({
      id: loc.id,
      name: loc.name || loc.id,
    }));
    if (diag) diag.locationsApi = `ok: ${locs.length}件`;
    return locs;
  } catch (err) {
    const errMsg = extractApiError(err);
    console.error('Failed to fetch locations:', errMsg);
    if (diag) diag.locationsApi = `error: ${errMsg}`;
    return [];
  }
}

// ── サブスクリプション取得（ロケーション別並列クエリ・リトライ付き） ──
// 全ロケーション一括の逐次ページネーションでは大規模アカウント（1800件超）でタイムアウトするため
// ロケーション別に並列取得（fetchInvoicesと同じパターン）
async function fetchAllSubscriptions(client, locationIds, diag, timeoutMs = 180000) {
  const errors = [];
  const startTime = Date.now();
  let timedOut = false;

  const results = await parallelWithLimit(locationIds, 8, async (locId) => {
    const locSubs = [];
    let cursor = undefined;
    do {
      if (Date.now() - startTime > timeoutMs) {
        timedOut = true;
        break;
      }
      // 500系エラー時のリトライ（最大2回、指数バックオフ）
      let succeeded = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { result } = await client.subscriptionsApi.searchSubscriptions({
            query: { filter: { locationIds: [locId] } },
            limit: 200,
            cursor,
          });
          if (result.subscriptions) {
            locSubs.push(...result.subscriptions);
          }
          cursor = result.cursor;
          succeeded = true;
          break;
        } catch (err) {
          const is500 = err.statusCode >= 500 || (err.message && err.message.includes('500'));
          if (is500 && attempt < 2) {
            const delay = 1000 * (attempt + 1); // 1s, 2s
            console.warn(`  Subscriptions 500 error (${locId}), retry ${attempt + 1}/2 in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          const errMsg = extractApiError(err);
          console.error(`  Subscriptions error (${locId}):`, errMsg);
          errors.push(`${locId}: ${errMsg}`);
          cursor = undefined;
          succeeded = true; // エラー処理完了、リトライループ脱出
          break;
        }
      }
      if (!succeeded) cursor = undefined;
    } while (cursor);
    return locSubs;
  });

  const rawSubs = results.filter(Boolean).flat();
  // ロケーション別並列取得で同一サブスクが複数返される場合があるためIDで重複排除
  const seenIds = new Set();
  const allSubs = [];
  for (const s of rawSubs) {
    if (seenIds.has(s.id)) continue;
    seenIds.add(s.id);
    allSubs.push(s);
  }
  const dedupCount = rawSubs.length - allSubs.length;
  if (diag) {
    const dedupSuffix = dedupCount > 0 ? `, 重複排除${dedupCount}件` : '';
    if (timedOut) {
      diag.subscriptionsApi = `${allSubs.length}件取得 (部分結果・タイムアウト${timeoutMs / 1000}s${dedupSuffix})`;
    } else {
      diag.subscriptionsApi = errors.length > 0
        ? `${allSubs.length}件取得, エラー${errors.length}件: ${errors.join('; ')}${dedupSuffix}`
        : `ok: ${allSubs.length}件${dedupSuffix}`;
    }
  }
  if (dedupCount > 0) console.log(`  Subscriptions: ${dedupCount}件の重複を排除 (${rawSubs.length} → ${allSubs.length})`);
  console.log(`  Subscriptions API: ${allSubs.length}件取得${timedOut ? ' (partial/timeout)' : ''}${errors.length > 0 ? `, errors: ${errors.length}` : ''}`);
  return allSubs;
}

async function fetchPlanDetails(client, planVariationIds) {
  const plans = {};
  if (planVariationIds.length === 0) return plans;
  const uniqueIds = [...new Set(planVariationIds)];

  for (let i = 0; i < uniqueIds.length; i += 100) {
    const batch = uniqueIds.slice(i, i + 100);
    try {
      // バッチ単位タイムアウト: 全体タイムアウトで部分結果を失わないよう各バッチに20秒上限
      let timer;
      const { result } = await Promise.race([
        client.catalogApi.batchRetrieveCatalogObjects({
          objectIds: batch,
          includeRelatedObjects: true,
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Plan batch timeout (20s)')), 20000);
        }),
      ]).finally(() => clearTimeout(timer));
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

// ── 売上・返品データ取得: Payments REST API を直接使用 ──
// Square SDK v39の@apimaticライブラリにバグがあり、listPayments/listPaymentRefundsの
// 位置引数でundefinedがクエリ文字列に&&として直列化されINVALID_URLエラーが発生するため
// SDKを使わずREST APIを直接呼び出す。
// また、Orders APIはPOS以外の決済（端末直接・カードオンファイル等）を含まないため
// Payments APIの方がSquare管理画面の売上合計と一致する。
// ──
async function fetchSalesFromPayments(token, env, locationIds, diag, timeoutMs = 180000) {
  const baseUrl = env === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
  const beginTime = new Date();
  beginTime.setMonth(beginTime.getMonth() - 13);
  const beginStr = beginTime.toISOString();
  const errors = [];
  const startTime = Date.now();
  let timedOut = false;

  const allResults = await parallelWithLimit(locationIds, 8, async (locId) => {
    const payments = [];
    const refunds = [];

    // ── Payments取得 ──
    let cursor = null;
    do {
      if (Date.now() - startTime > timeoutMs) { timedOut = true; break; }
      let succeeded = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const params = new URLSearchParams({
            begin_time: beginStr,
            location_id: locId,
            sort_order: 'DESC',
            limit: '200',
          });
          if (cursor) params.set('cursor', cursor);
          const resp = await fetch(`${baseUrl}/v2/payments?${params}`, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Square-Version': '2025-01-23',
              'Content-Type': 'application/json',
            },
          });
          if (resp.status >= 500) {
            throw Object.assign(new Error(`HTTP ${resp.status}`), { statusCode: resp.status });
          }
          if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 200)}`);
          }
          const data = await resp.json();
          if (data.payments) {
            for (const p of data.payments) {
              if (p.status === 'COMPLETED') {
                payments.push({
                  id: p.id,
                  amount: toNumber(p.total_money && p.total_money.amount),
                  createdAt: p.created_at,
                  locationId: p.location_id || locId,
                });
              }
            }
          }
          cursor = data.cursor || null;
          succeeded = true;
          break;
        } catch (err) {
          const is500 = err.statusCode >= 500;
          if (is500 && attempt < 2) {
            const delay = 1000 * (attempt + 1);
            console.warn(`  Payments API 500 error (${locId}), retry ${attempt + 1}/2 in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          console.error(`  Payments API error (${locId}):`, err.message);
          errors.push(`payments ${locId}: ${err.message}`);
          cursor = null;
          succeeded = true;
          break;
        }
      }
      if (!succeeded) cursor = null;
    } while (cursor);

    // ── Refunds取得 ──
    cursor = null;
    do {
      if (Date.now() - startTime > timeoutMs) { timedOut = true; break; }
      let succeeded = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const params = new URLSearchParams({
            begin_time: beginStr,
            location_id: locId,
            sort_order: 'DESC',
            limit: '200',
          });
          if (cursor) params.set('cursor', cursor);
          const resp = await fetch(`${baseUrl}/v2/refunds?${params}`, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Square-Version': '2025-01-23',
              'Content-Type': 'application/json',
            },
          });
          if (resp.status >= 500) {
            throw Object.assign(new Error(`HTTP ${resp.status}`), { statusCode: resp.status });
          }
          if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 200)}`);
          }
          const data = await resp.json();
          if (data.refunds) {
            for (const r of data.refunds) {
              if (r.status === 'COMPLETED') {
                refunds.push({
                  id: r.id,
                  amount: toNumber(r.amount_money && r.amount_money.amount),
                  createdAt: r.created_at,
                  locationId: r.location_id || locId,
                });
              }
            }
          }
          cursor = data.cursor || null;
          succeeded = true;
          break;
        } catch (err) {
          const is500 = err.statusCode >= 500;
          if (is500 && attempt < 2) {
            const delay = 1000 * (attempt + 1);
            console.warn(`  Refunds API 500 error (${locId}), retry ${attempt + 1}/2 in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          console.error(`  Refunds API error (${locId}):`, err.message);
          errors.push(`refunds ${locId}: ${err.message}`);
          cursor = null;
          succeeded = true;
          break;
        }
      }
      if (!succeeded) cursor = null;
    } while (cursor);

    return { payments, refunds };
  });

  const rawPayments = allResults.filter(Boolean).flatMap(r => r.payments);
  const rawRefunds = allResults.filter(Boolean).flatMap(r => r.refunds);
  // ロケーション別並列取得で同一決済/返品が複数返される場合があるためIDで重複排除
  const seenPayIds = new Set();
  const payments = [];
  for (const p of rawPayments) {
    if (p.id && seenPayIds.has(p.id)) continue;
    if (p.id) seenPayIds.add(p.id);
    payments.push(p);
  }
  const seenRefIds = new Set();
  const refunds = [];
  for (const r of rawRefunds) {
    if (r.id && seenRefIds.has(r.id)) continue;
    if (r.id) seenRefIds.add(r.id);
    refunds.push(r);
  }
  const payDedupCount = rawPayments.length - payments.length;
  const refDedupCount = rawRefunds.length - refunds.length;
  if (diag) {
    const suffix = timedOut ? ` (部分結果・タイムアウト${timeoutMs / 1000}s)` : '';
    const payDedup = payDedupCount > 0 ? `, 重複排除${payDedupCount}件` : '';
    const refDedup = refDedupCount > 0 ? `, 重複排除${refDedupCount}件` : '';
    diag.paymentsApi = errors.length > 0
      ? `Payments API: ${payments.length}件売上, エラー${errors.length}件${suffix}${payDedup}`
      : `ok: ${payments.length}件 (Payments API)${suffix}${payDedup}`;
    diag.refundsApi = errors.length > 0
      ? `Refunds API: ${refunds.length}件返品, エラー${errors.length}件${suffix}${refDedup}`
      : `ok: ${refunds.length}件 (Refunds API)${suffix}${refDedup}`;
  }
  if (payDedupCount > 0) console.log(`  Payments: ${payDedupCount}件の重複を排除 (${rawPayments.length} → ${payments.length})`);
  if (refDedupCount > 0) console.log(`  Refunds: ${refDedupCount}件の重複を排除 (${rawRefunds.length} → ${refunds.length})`);
  console.log(`  Payments API: ${payments.length}件売上, ${refunds.length}件返品${timedOut ? ' (partial/timeout)' : ''}${errors.length > 0 ? `, errors: ${errors.length}` : ''}`);
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

// ── インボイス取得（タイムアウト時は部分結果を返す・古いインボイスは打ち切り） ──
async function fetchInvoices(client, locationIds, diag, timeoutMs = 180000) {
  const errors = [];
  const allInvoices = [];
  const startTime = Date.now();
  let timedOut = false;
  // 25ヶ月前より古いインボイスは不要（ソートDESCなので打ち切り可能）
  // 選択可能月12ヶ月 + チャート表示12ヶ月 + バッファ1ヶ月 = 25ヶ月
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - 25);
  const cutoffStr = cutoffDate.toISOString();

  await parallelWithLimit(locationIds, 8, async (locId) => {
    let cursor = undefined;
    let locCount = 0;
    let reachedCutoff = false;
    do {
      if (Date.now() - startTime > timeoutMs) {
        timedOut = true;
        if (locCount > 0) errors.push(`${locId}: ページネーション途中 (${locCount}件取得済)`);
        break;
      }
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
            // 25ヶ月以上前のインボイスはスキップ（DESCソートなので以降も古い）
            if (inv.createdAt && inv.createdAt < cutoffStr) {
              reachedCutoff = true;
              break;
            }
            const pr = inv.paymentRequests && inv.paymentRequests[0];
            allInvoices.push({
              id: inv.id,
              customerId: inv.primaryRecipient ? inv.primaryRecipient.customerId : null,
              subscriptionId: inv.subscriptionId || null,
              status: inv.status,
              amount: pr ? toNumber(pr.computedAmountMoney && pr.computedAmountMoney.amount) : 0,
              dueDate: pr ? pr.dueDate : null,
              createdAt: inv.createdAt,
              locationId: locId,
            });
            locCount++;
          }
        }
        if (reachedCutoff) {
          cursor = undefined; // 打ち切り
        } else {
          cursor = result.cursor;
        }
      } catch (err) {
        const errMsg = extractApiError(err);
        console.error(`  Invoices error (${locId}):`, errMsg);
        errors.push(`${locId}: ${errMsg}`);
        cursor = undefined;
      }
    } while (cursor);
  });
  // ロケーション別並列取得で同一インボイスが複数返される場合があるためIDで重複排除
  const seenInvIds = new Set();
  const dedupedInvoices = [];
  for (const inv of allInvoices) {
    if (seenInvIds.has(inv.id)) continue;
    seenInvIds.add(inv.id);
    dedupedInvoices.push(inv);
  }
  const invDedupCount = allInvoices.length - dedupedInvoices.length;
  if (diag) {
    const withSubId = dedupedInvoices.filter(inv => inv.subscriptionId).length;
    const dedupSuffix = invDedupCount > 0 ? `, 重複排除${invDedupCount}件` : '';
    if (timedOut) {
      diag.invoicesApi = `${dedupedInvoices.length}件取得 (部分結果・タイムアウト${timeoutMs / 1000}s, サブスク紐付: ${withSubId}件${dedupSuffix})`;
    } else {
      diag.invoicesApi = errors.length > 0
        ? `${dedupedInvoices.length}件取得 (サブスク紐付: ${withSubId}件), エラー${errors.length}件: ${errors.join('; ')}${dedupSuffix}`
        : `ok: ${dedupedInvoices.length}件 (サブスク紐付: ${withSubId}件${dedupSuffix})`;
    }
  }
  if (invDedupCount > 0) console.log(`  Invoices: ${invDedupCount}件の重複を排除 (${allInvoices.length} → ${dedupedInvoices.length})`);
  console.log(`  Invoices API: ${dedupedInvoices.length}件取得${timedOut ? ' (partial/timeout)' : ''}${errors.length > 0 ? `, errors: ${errors.length}` : ''}`);
  return dedupedInvoices;
}

// 全顧客名を取得
async function fetchAllCustomers(client, diag) {
  const customers = {};
  let cursor = undefined;
  let hasError = false;
  let errorMsg = '';
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
      errorMsg = extractApiError(err);
      console.error('  Customers API error:', errorMsg);
      hasError = true;
      cursor = undefined;
    }
  } while (cursor);
  const count = Object.keys(customers).length;
  if (diag) {
    diag.customersApi = hasError
      ? `${count}件取得, error: ${errorMsg}`
      : `ok: ${count}件`;
  }
  return customers;
}

// 1つのSquareアカウントの全データを取得
async function fetchAccountData(tokenConfig, isMultiAccount) {
  const accountName = tokenConfig.name || '';
  console.log(`[${accountName || 'main'}] データ取得開始...`);
  try {
    if (!tokenConfig.token) {
      console.error(`[${accountName}] トークンが空です`);
      return null;
    }
    const client = await createClient(tokenConfig);

    // 診断情報トラッキング（早期初期化）
    const diag = {};

    let stores = await fetchLocations(client, diag);
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
    // 店舗リスト構築: accountNameが設定されている場合は全ロケーションを
    // そのアカウント名で1店舗に統合（SQUARE_TOKENSの1エントリ=1店舗）
    // accountNameが未設定の場合のみ個別ロケーションとして返す
    if (accountName) {
      const allLocIds = stores.map(s => s.id);
      stores = [{ id: allLocIds[0], name: accountName, locationIds: allLocIds }];
    } else {
      stores = stores.map(s => ({ ...s, locationIds: [s.id] }));
    }
    const locationIds = stores.flatMap(s => s.locationIds);

    // サブスク＋インボイス＋売上(Payments REST API)＋顧客を並列取得（各API個別タイムアウト付き）
    // Payments/Refunds APIはSDKバグ回避のためREST APIを直接呼び出す
    const API_TIMEOUT = 240000; // 各API最大240秒（Vercel maxDuration:300s、大規模アカウントのページネーション完走用）
    // サブスク・インボイスは内部で部分結果を管理するため withTimeout を使わない
    // プラン詳細はサブスクデータに依存するため、サブスク取得完了後に即座にチェーン実行
    // （他APIの完了を待たずに並列で開始することで10-30秒短縮）
    let plans = {};
    const [rawSubs, invoices, paymentsData, customers] = await Promise.all([
      fetchAllSubscriptions(client, locationIds, diag, API_TIMEOUT).then(async (subs) => {
        const planVariationIds = subs.map(s => s.planVariationId).filter(Boolean);
        plans = await fetchPlanDetails(client, planVariationIds);
        return subs;
      }),
      fetchInvoices(client, locationIds, diag, API_TIMEOUT),
      fetchSalesFromPayments(tokenConfig.token, tokenConfig.env, locationIds, diag, API_TIMEOUT),
      withTimeout(fetchAllCustomers(client, diag), 120000, {}, 'Customers'),
    ]);

    // タイムアウト検出: withTimeoutがfallbackを返した場合、diagに記録がない
    // Note: subscriptionsApi/invoicesApiは各関数内部で設定済み
    if (!diag.subscriptionsApi) diag.subscriptionsApi = 'timeout (240s)';
    if (!diag.invoicesApi) diag.invoicesApi = 'timeout (240s)';
    if (!diag.paymentsApi) diag.paymentsApi = 'timeout (240s)';
    if (!diag.refundsApi) diag.refundsApi = 'timeout (240s)';
    if (!diag.customersApi) diag.customersApi = 'timeout (120s)';

    const payments = paymentsData.payments || [];
    const refunds = paymentsData.refunds || [];
    const plansLoadedCount = Object.keys(plans).length;
    const planVariationIds = rawSubs.map(s => s.planVariationId).filter(Boolean);
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
        pausedDate: s.status === 'PAUSED' ? (s.chargedThroughDate || null) : null,
        chargedThroughDate: s.chargedThroughDate || null,
        monthlyPrice,
      };
    });

    // サブスクリプション状態別集計を診断情報に追加
    if (subscriptions.length > 0) {
      const statusCounts = {};
      for (const s of subscriptions) {
        statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
      }
      diag.subscriptionStatuses = statusCounts;
    }

    console.log(`[${accountName || 'main'}] ${stores.length} stores, ${subscriptions.length} subs, ${invoices.length} inv, ${payments.length} payments, ${refunds.length} refunds`);
    console.log(`[${accountName || 'main'}] diag:`, JSON.stringify(diag));
    return { stores, subscriptions, customers, invoices, payments, refunds, plans, _diag: diag };
  } catch (err) {
    let detail = err.message;
    try {
      if (err.result && err.result.errors) {
        detail = err.result.errors.map(e => `${e.code}: ${e.detail}`).join('; ');
      }
    } catch (_) {}
    console.error(`Account "${accountName}" error:`, detail);
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

  // ── キャッシュクリアモード: ?clearCache=1 ──
  if (req.query && req.query.clearCache === '1') {
    const size = accountCache.size;
    accountCache.clear();
    return sendJson(res, 200, {
      success: true,
      message: `${size}件のキャッシュをクリアしました`,
    });
  }

  // ── アカウント一覧モード: ?info=1 ──
  if (req.query && req.query.info === '1') {
    return sendJson(res, 200, {
      success: true,
      accounts: configs.map((cfg, i) => ({ index: i, name: cfg.name || `アカウント${i + 1}` })),
      totalAccounts: configs.length,
      cacheSize: accountCache.size,
      tokenParseInfo: _tokenParseInfo || null,
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
    // アカウント間の重複排除用Set
    const seenSubIds = new Set();
    const seenInvIds = new Set();
    const seenPayIds = new Set();
    const seenRefIds = new Set();
    const failedAccounts = [];
    const allDiag = [];

    // バッチ内アカウントを並列取得（最大3並列、1アカウント最大100秒タイムアウト）
    await parallelWithLimit(indices, 3, async (idx) => {
      const cfg = configs[idx];
      try {
        // キャッシュ確認
        let r = getCachedAccount(idx);
        if (!r) {
          // アカウント単位タイムアウト: バッチ全体を守る
          let batchTimer;
          r = await Promise.race([
            fetchAccountData(cfg, true),
            new Promise((_, reject) => {
              batchTimer = setTimeout(() => reject(new Error('アカウント取得タイムアウト (280秒)')), 280000);
            }),
          ]).finally(() => clearTimeout(batchTimer));
          if (r && !r._failed) setCachedAccount(idx, r);
        }
        if (!r || r._failed) {
          failedAccounts.push({ name: cfg.name || `アカウント${idx + 1}`, error: r && r._errorDetail ? r._errorDetail : 'トークンが空または無効です' });
          return;
        }
        // 店舗をlocationIdで重複排除（名前ではなく物理ロケーションで判定）
        for (const store of r.stores) {
          const storeLocIds = store.locationIds || [store.id];
          const existing = merged.stores.find(s => {
            const existingLocIds = s.locationIds || [s.id];
            return storeLocIds.some(id => existingLocIds.includes(id));
          });
          if (existing) {
            existing.locationIds = [...new Set([...(existing.locationIds || [existing.id]), ...storeLocIds])];
          } else {
            merged.stores.push({ ...store, locationIds: [...storeLocIds] });
          }
        }
        // アカウント間の重複排除付きマージ
        for (const s of r.subscriptions) { if (!seenSubIds.has(s.id)) { seenSubIds.add(s.id); merged.subscriptions.push(s); } }
        Object.assign(merged.customers, r.customers);
        for (const inv of r.invoices) { if (!seenInvIds.has(inv.id)) { seenInvIds.add(inv.id); merged.invoices.push(inv); } }
        for (const p of r.payments) { if (!p.id || !seenPayIds.has(p.id)) { if (p.id) seenPayIds.add(p.id); merged.payments.push(p); } }
        for (const rf of (r.refunds || [])) { if (!rf.id || !seenRefIds.has(rf.id)) { if (rf.id) seenRefIds.add(rf.id); merged.refunds.push(rf); } }
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
        let singleTimer;
        r = await Promise.race([
          fetchAccountData(cfg, configs.length > 1),
          new Promise((_, reject) => {
            singleTimer = setTimeout(() => reject(new Error('アカウント取得タイムアウト (280秒)')), 280000);
          }),
        ]).finally(() => clearTimeout(singleTimer));
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
  // アカウント間の重複排除用Set
  const seenSubIds = new Set();
  const seenInvIds = new Set();
  const seenPayIds = new Set();
  const seenRefIds = new Set();
  const failedAccounts = [];
  const allDiag = [];

  let deadlineReached = false;
  const deadlineTimer = setTimeout(() => { deadlineReached = true; }, 280000);

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
        // 店舗をlocationIdで重複排除（名前ではなく物理ロケーションで判定）
        for (const store of r.stores) {
          const storeLocIds = store.locationIds || [store.id];
          const existing = merged.stores.find(s => {
            const existingLocIds = s.locationIds || [s.id];
            return storeLocIds.some(id => existingLocIds.includes(id));
          });
          if (existing) {
            existing.locationIds = [...new Set([...(existing.locationIds || [existing.id]), ...storeLocIds])];
          } else {
            merged.stores.push({ ...store, locationIds: [...storeLocIds] });
          }
        }
        // アカウント間の重複排除付きマージ
        for (const s of r.subscriptions) { if (!seenSubIds.has(s.id)) { seenSubIds.add(s.id); merged.subscriptions.push(s); } }
        Object.assign(merged.customers, r.customers);
        for (const inv of r.invoices) { if (!seenInvIds.has(inv.id)) { seenInvIds.add(inv.id); merged.invoices.push(inv); } }
        for (const p of r.payments) { if (!p.id || !seenPayIds.has(p.id)) { if (p.id) seenPayIds.add(p.id); merged.payments.push(p); } }
        for (const rf of (r.refunds || [])) { if (!rf.id || !seenRefIds.has(rf.id)) { if (rf.id) seenRefIds.add(rf.id); merged.refunds.push(rf); } }
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
