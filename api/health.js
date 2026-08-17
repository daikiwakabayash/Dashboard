export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache');

  // SQUARE_TOKENS のアカウント数を安全にカウント
  let tokenCount = 0;
  if (process.env.SQUARE_TOKENS) {
    try {
      const parsed = JSON.parse(process.env.SQUARE_TOKENS);
      if (Array.isArray(parsed)) tokenCount = parsed.length;
    } catch (_) {}
  }

  res.status(200).json({
    ok: true,
    node: process.version,
    timestamp: new Date().toISOString(),
    env: {
      hasAccessToken: !!process.env.SQUARE_ACCESS_TOKEN,
      hasSquareTokens: !!process.env.SQUARE_TOKENS,
      squareAccountCount: tokenCount,
      hasLocationId: !!process.env.SQUARE_LOCATION_ID,
      hasEnvironment: !!process.env.SQUARE_ENVIRONMENT,
      // 計画共有ストア(api/plan-store.js)の保存先が有効か（同期の疎通確認用）
      planStore: {
        kv: !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN),
        supabase: !!(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY)),
        gas: !!(process.env.PLAN_GAS_URL || process.env.SETTLEMENT_GAS_URL),
      },
    },
    runtime: {
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      uptimeS: Math.round(process.uptime()),
    },
  });
}
