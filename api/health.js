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
    },
    runtime: {
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      uptimeS: Math.round(process.uptime()),
    },
  });
}
