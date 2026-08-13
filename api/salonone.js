// ── SalonOne 分析API プロキシ ──────────────────────────────────────
//
// SalonOne の読み取り専用「分析API」への安全なゲートウェイ。
// アクセスキー(SALONONE_API_KEY)をサーバーサイドに隠蔽し、フロントには出さない。
// （既存の api/gas-proxy.js・api/square/ と同じ秘密情報隠蔽パターン）
//
// 使い方（フロント）:
//   GET /api/salonone?resource=meta
//   GET /api/salonone?resource=sales/summary&from=2026-07-01&to=2026-07-31&shop_id=1
//   GET /api/salonone?resource=customers&limit=200&cursor=<next_cursor>
//   GET /api/salonone?diagnostic=1            ← 疎通確認（/meta を叩く）
//
// 環境変数:
//   SALONONE_API_KEY      - 運営が発行したアクセスキー（必須）
//   SALONONE_API_BASE     - ベースURL上書き（任意・既定は本番）

import {
  ANALYTICS_BASE,
  RATE_LIMIT_HEADERS,
  buildUpstreamUrl,
  getEndpoint,
  listResources,
  SalonOneValidationError,
} from '../lib/salonone.js';

export const config = {
  maxDuration: 60,
};

const HEADER_NAME = 'X-SalonOne-Api-Key';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  // 上流も書き込みを拒否する。プロキシでも GET のみ許可する。
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { code: 'method_not_allowed', message: 'GET only' } });
  }

  const apiKey = process.env.SALONONE_API_KEY;
  const base = process.env.SALONONE_API_BASE || ANALYTICS_BASE;

  if (!apiKey) {
    return res.status(500).json({
      error: {
        code: 'not_configured',
        message: 'SALONONE_API_KEY is not configured',
      },
      hint: 'Vercelの環境変数に SALONONE_API_KEY を設定してください（ブランド選択画面の「API連携」から運営が発行）。',
      setupRequired: true,
    });
  }

  // 疎通確認モード: 構造化した診断結果を返す（api/square/test.js と同様）
  if (req.query.diagnostic === '1' || req.query.diagnostic === 'true') {
    return runDiagnostic(res, base, apiKey);
  }

  const { resource, diagnostic, ...rest } = req.query;

  let upstream;
  try {
    upstream = buildUpstreamUrl(resource, rest, base);
  } catch (err) {
    if (err instanceof SalonOneValidationError) {
      const body = { error: { code: err.code, message: err.message, fields: err.fields } };
      if (err.code === 'not_found') body.availableResources = listResources();
      return res.status(err.status).json(body);
    }
    throw err;
  }

  try {
    const { status, headers, data } = await fetchSalonOne(upstream.url, apiKey);

    // レート制限ヘッダを透過（フロントが残数を把握できる）
    for (const name of RATE_LIMIT_HEADERS) {
      const v = headers.get(name);
      if (v !== null && v !== undefined) res.setHeader(name, v);
    }

    // キャッシュ方針: 集計は5分、明細/メタは短め（更新差分取得を妨げない）
    if (status === 200) {
      const ttl = upstream.endpoint.kind === 'summary' ? 300 : 60;
      res.setHeader('Cache-Control', `s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}`);
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }

    return res.status(status).json(data);
  } catch (err) {
    console.error('[salonone] proxy error:', err);
    const message = err.name === 'AbortError'
      ? 'SalonOne API timed out'
      : err.message;
    return res.status(502).json({ error: { code: 'upstream_error', message } });
  }
}

// ── 上流へGETリクエスト（55秒タイムアウト） ──
async function fetchSalonOne(url, apiKey) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 55000);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        [HEADER_NAME]: apiKey,
        Accept: 'application/json',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    // 上流は常にJSONを返す想定。JSONでなければ生テキストを包む。
    let data;
    const text = await response.text();
    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      data = { error: { code: 'invalid_upstream_response', message: text.slice(0, 500) } };
    }
    return { status: response.status, headers: response.headers, data };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── 疎通確認: キーの有無 → /meta 到達性 を段階的に検査 ──
async function runDiagnostic(res, base, apiKey) {
  const results = { steps: [], timestamp: new Date().toISOString() };

  results.steps.push({ step: 'config', ok: true, hasApiKey: !!apiKey, base });

  const endpoint = getEndpoint('meta');
  try {
    const { url } = buildUpstreamUrl('meta', {}, base);
    const { status, headers, data } = await fetchSalonOne(url, apiKey);
    const rate = {};
    for (const name of RATE_LIMIT_HEADERS) {
      const v = headers.get(name);
      if (v !== null && v !== undefined) rate[name] = v;
    }
    results.steps.push({
      step: 'GET /meta',
      ok: status === 200,
      status,
      rateLimit: Object.keys(rate).length ? rate : undefined,
      // 認証NG時の切り分けを助ける（本文はエラーコードのみ）
      error: status === 200 ? undefined : (data?.error?.code || `HTTP ${status}`),
    });
  } catch (err) {
    results.steps.push({ step: 'GET /meta', ok: false, error: err.message });
  }

  void endpoint;
  const passed = results.steps.filter((s) => s.ok).length;
  const failed = results.steps.length - passed;
  results.summary = { total: results.steps.length, passed, failed, allPassed: failed === 0 };
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(results);
}
