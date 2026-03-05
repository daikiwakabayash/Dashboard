// ── GAS プロキシAPI: GAS URLをサーバーサイドに隠蔽 ──────────────
// 環境変数:
//   GAS_API_URL       - 経営データ用GAS URL
//   MARKETING_API_URL - マーケティングデータ用GAS URL

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { type } = req.query;

  let targetUrl;
  if (type === 'business') {
    targetUrl = process.env.GAS_API_URL;
  } else if (type === 'marketing') {
    targetUrl = process.env.MARKETING_API_URL;
  } else {
    return res.status(400).json({ error: 'Invalid type. Use "business" or "marketing".' });
  }

  if (!targetUrl) {
    return res.status(500).json({
      error: `${type === 'business' ? 'GAS_API_URL' : 'MARKETING_API_URL'} is not configured`,
      message: 'Vercelの環境変数に設定してください。'
    });
  }

  const maxRetries = 2;
  const timeoutMs = 25000; // 25秒（Vercelのデフォルト関数タイムアウト内に収める）
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      if (attempt > 0) {
        const delay = 2000 * attempt; // 2秒, 4秒
        await new Promise(r => setTimeout(r, delay));
        console.log(`GAS proxy retry ${attempt}/${maxRetries} for ${type}`);
      }

      const response = await fetch(targetUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        redirect: 'follow',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`GAS API returned ${response.status}`);
      }

      const data = await response.json();

      // キャッシュヘッダー（5分）
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
      return res.status(200).json(data);
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        lastError = new Error('GAS APIがタイムアウトしました（25秒）');
      } else {
        lastError = err;
      }
      console.error(`GAS proxy error (${type}) attempt ${attempt + 1}:`, lastError.message);
    }
  }

  return res.status(504).json({
    error: 'GAS APIへの接続がタイムアウトしました',
    message: lastError.message,
    retryable: true,
  });
}
