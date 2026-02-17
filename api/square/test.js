// Square API 接続テスト - 各API の疎通確認
// ?account=N で個別アカウントをテスト、省略時は最初のアカウントをテスト

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache');

  const results = { steps: [], timestamp: new Date().toISOString() };

  // Step 1: Square SDK インポート
  let Client, Environment;
  try {
    const sq = await import('square');
    Client = sq.Client;
    Environment = sq.Environment;
    results.steps.push({ step: 'import square', ok: true, version: sq.DEFAULT_CONFIGURATION ? 'v39+' : 'unknown' });
  } catch (err) {
    results.steps.push({ step: 'import square', ok: false, error: err.message });
    return res.status(200).json(results);
  }

  // Step 2: トークン設定の確認
  let tokenConfig;
  if (process.env.SQUARE_TOKENS) {
    try {
      const tokens = JSON.parse(process.env.SQUARE_TOKENS);
      const idx = parseInt(req.query?.account || '0', 10);
      if (!Array.isArray(tokens) || tokens.length === 0) {
        results.steps.push({ step: 'parse tokens', ok: false, error: 'SQUARE_TOKENS is empty array' });
        return res.status(200).json(results);
      }
      if (idx < 0 || idx >= tokens.length) {
        results.steps.push({ step: 'parse tokens', ok: false, error: `Account index ${idx} out of range (0-${tokens.length - 1})` });
        return res.status(200).json(results);
      }
      tokenConfig = tokens[idx];
      results.steps.push({ step: 'parse tokens', ok: true, totalAccounts: tokens.length, testingAccount: idx, name: tokenConfig.name });
    } catch (e) {
      results.steps.push({ step: 'parse tokens', ok: false, error: e.message });
      return res.status(200).json(results);
    }
  } else if (process.env.SQUARE_ACCESS_TOKEN) {
    tokenConfig = {
      name: 'default',
      token: process.env.SQUARE_ACCESS_TOKEN,
      env: process.env.SQUARE_ENVIRONMENT || 'production',
    };
    results.steps.push({ step: 'parse tokens', ok: true, totalAccounts: 1, source: 'SQUARE_ACCESS_TOKEN' });
  } else {
    results.steps.push({ step: 'parse tokens', ok: false, error: 'No SQUARE_TOKENS or SQUARE_ACCESS_TOKEN configured' });
    return res.status(200).json(results);
  }

  // Step 3: クライアント作成
  let client;
  try {
    client = new Client({
      accessToken: tokenConfig.token,
      environment: tokenConfig.env === 'production' ? Environment.Production : Environment.Sandbox,
    });
    results.steps.push({ step: 'create client', ok: true, environment: tokenConfig.env });
  } catch (err) {
    results.steps.push({ step: 'create client', ok: false, error: err.message });
    return res.status(200).json(results);
  }

  // Step 4: Locations API
  try {
    const { result } = await client.locationsApi.listLocations();
    const locs = (result.locations || []).map(l => ({ id: l.id, name: l.name }));
    results.steps.push({ step: 'list locations', ok: true, count: locs.length, locations: locs.slice(0, 5) });
  } catch (err) {
    results.steps.push({ step: 'list locations', ok: false, error: err.message, code: err.statusCode || null });
  }

  // Step 5: Subscriptions API (first page)
  try {
    const { result: locResult } = await client.locationsApi.listLocations();
    const firstLocId = locResult.locations?.[0]?.id;
    if (firstLocId) {
      const { result } = await client.subscriptionsApi.searchSubscriptions({
        query: { filter: { locationIds: [firstLocId] } },
      });
      results.steps.push({ step: 'search subscriptions', ok: true, count: result.subscriptions?.length || 0, hasMore: !!result.cursor });
    } else {
      results.steps.push({ step: 'search subscriptions', ok: false, error: 'No locations found' });
    }
  } catch (err) {
    results.steps.push({ step: 'search subscriptions', ok: false, error: err.message, code: err.statusCode || null });
  }

  // Step 6: Customers API (first page)
  try {
    const { result } = await client.customersApi.listCustomers();
    results.steps.push({ step: 'list customers', ok: true, count: result.customers?.length || 0, hasMore: !!result.cursor });
  } catch (err) {
    results.steps.push({ step: 'list customers', ok: false, error: err.message, code: err.statusCode || null });
  }

  // Step 7: Invoices API (first page)
  try {
    const { result: locResult } = await client.locationsApi.listLocations();
    const firstLocId = locResult.locations?.[0]?.id;
    if (firstLocId) {
      const { result } = await client.invoicesApi.searchInvoices({
        query: { filter: { locationIds: [firstLocId] }, sort: { field: 'INVOICE_SORT_DATE', order: 'DESC' } },
      });
      results.steps.push({ step: 'search invoices', ok: true, count: result.invoices?.length || 0, hasMore: !!result.cursor });
    } else {
      results.steps.push({ step: 'search invoices', ok: false, error: 'No locations found' });
    }
  } catch (err) {
    results.steps.push({ step: 'search invoices', ok: false, error: err.message, code: err.statusCode || null });
  }

  // 結果サマリー
  const passed = results.steps.filter(s => s.ok).length;
  const failed = results.steps.filter(s => !s.ok).length;
  results.summary = { total: results.steps.length, passed, failed, allPassed: failed === 0 };

  return res.status(200).json(results);
}
