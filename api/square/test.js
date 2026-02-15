export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const results = { steps: [] };

  // Step 1: import square
  try {
    const sq = await import('square');
    results.steps.push({ step: 'import square', ok: true, keys: Object.keys(sq).slice(0, 10) });
  } catch (err) {
    results.steps.push({ step: 'import square', ok: false, error: err.message });
    return res.status(200).json(results);
  }

  // Step 2: create client
  try {
    const { Client, Environment } = await import('square');
    const client = new Client({
      accessToken: process.env.SQUARE_ACCESS_TOKEN,
      environment: process.env.SQUARE_ENVIRONMENT === 'production'
        ? Environment.Production
        : Environment.Sandbox,
    });
    results.steps.push({ step: 'create client', ok: true });
  } catch (err) {
    results.steps.push({ step: 'create client', ok: false, error: err.message });
    return res.status(200).json(results);
  }

  // Step 3: list subscriptions (first page only)
  try {
    const { Client, Environment } = await import('square');
    const client = new Client({
      accessToken: process.env.SQUARE_ACCESS_TOKEN,
      environment: process.env.SQUARE_ENVIRONMENT === 'production'
        ? Environment.Production
        : Environment.Sandbox,
    });

    const { result } = await client.subscriptionsApi.searchSubscriptions({
      query: {
        filter: {
          locationIds: [process.env.SQUARE_LOCATION_ID],
        },
      },
    });

    const count = result.subscriptions ? result.subscriptions.length : 0;
    results.steps.push({ step: 'search subscriptions', ok: true, count });
  } catch (err) {
    results.steps.push({
      step: 'search subscriptions',
      ok: false,
      error: err.message,
      code: err.statusCode || null,
    });
  }

  return res.status(200).json(results);
}
