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
  pickAuthBody,
  SalonOneValidationError,
} from '../lib/salonone.js';
import { kvConfigured, kvBlobGet, kvBlobSet } from '../lib/kvblob.js';
import { createHash } from 'crypto';

// ── サーバー側 応答キャッシュ（KV）──────────────────────────────
// 全店取得(最大90店)を全ユーザーで共有キャッシュし、SalonOneのレート制限(60/分)
// 超過を防ぐ。Bearer無し（＝ブランド全体）のデータGETのみ対象。
const SO_CACHE_TTL_MS = (kind) => (kind === 'summary' ? 300000 : 120000); // 集計5分・明細2分
function soCacheKey(resource, params) {
  const q = Object.keys(params || {}).sort().map(k => `${k}=${params[k]}`).join('&');
  return `naoru:so:cache:${resource}:${q}`;
}

export const config = {
  maxDuration: 60,
};

const HEADER_NAME = 'X-SalonOne-Api-Key';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  // データ取得は GET のみ。POST はサロンワン ユーザー認証(auth/*)に限り許可する。
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: { code: 'method_not_allowed', message: 'GET or POST(auth) only' } });
  }

  const apiKey = process.env.SALONONE_API_KEY;
  const base = process.env.SALONONE_API_BASE || ANALYTICS_BASE;
  // 連携先ユーザーのトークン（Bearer）。あれば上流へ透過し「誰として見るか」を伝える。
  const bearer = (() => {
    const h = req.headers['authorization'] || req.headers['Authorization'] || '';
    return typeof h === 'string' && /^Bearer\s+/i.test(h) ? h : '';
  })();

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

  // ── サロンワン ユーザー認証(auth/*): POSTで本文を転送 ──
  const ep = getEndpoint(resource);
  if (ep && ep.kind === 'auth') {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: { code: 'method_not_allowed', message: `${resource} requires POST` } });
    }
    const url = `${base.replace(/\/+$/, '')}${ep.path}`;
    const payload = pickAuthBody(ep, req.body || {});
    try {
      // logout はトークンの破棄なので Bearer が必要。login/refresh は本文で完結。
      // ローンチ時の大量ログインで auth/login が 60/分 を超過し429になるため、Retry-After を
      // 尊重してサーバー側で待機・再試行（logoutは待たない）。認証エラー(4xx)は即返す。
      const isLogout = resource === 'auth/logout';
      const { status, headers, data } = await postSalonOneResilient(
        url, apiKey, payload, isLogout ? bearer : '',
        { budgetMs: isLogout ? 0 : 52000, maxWaitMs: 50000 }
      );
      for (const name of RATE_LIMIT_HEADERS) { const v = headers.get(name); if (v != null) res.setHeader(name, v); }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(status).json(data);
    } catch (err) {
      console.error('[salonone] auth proxy error:', err);
      return res.status(502).json({ error: { code: 'upstream_error', message: err.message } });
    }
  }

  // データ取得は GET のみ。
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { code: 'method_not_allowed', message: 'GET only for data resources' } });
  }

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
    const alwaysBearer = resource === 'me';
    // ── /me はBearer単位で短期キャッシュ（60秒）──────────────────────
    // /me は起動/セッション復元のたびに毎回呼ばれ、ユーザー個別(Bearer)なので共有不可。
    // ローンチ時に200名が同時ログイン→復元すると /me が 60/分 を圧迫するため、同一トークンの
    // 連続 /me を短期キャッシュで吸収する。429時は期限切れでも古い値を返してセッション復元を継続。
    // （返金明細書の認可 verifySalonOneBearer は別経路＝上流を直接叩くのでキャッシュ影響なし）
    if (alwaysBearer && bearer && kvConfigured()) {
      const meKey = `naoru:so:me:${createHash('sha256').update(bearer).digest('hex').slice(0, 24)}`;
      let meStale = null;
      try {
        const c = await kvBlobGet(meKey);
        if (c && c.ts && c.data) {
          meStale = c.data;
          if ((Date.now() - c.ts) < 60000) {
            res.setHeader('X-SO-Cache', 'HIT');
            res.setHeader('Cache-Control', 'no-store');
            return res.status(200).json(c.data);
          }
        }
      } catch (_) { /* キャッシュ不通は素通り */ }
      // 復元をブロックしすぎないよう待機は短め（stale があれば待たない）
      const { status, headers, data } = await fetchSalonOneResilient(upstream.url, apiKey, bearer, { budgetMs: meStale ? 0 : 26000, maxWaitMs: 24000 });
      const isErr = status !== 200 || (data && data.error);
      if (isErr && meStale) {
        res.setHeader('X-SO-Cache', 'STALE');
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json(meStale);
      }
      if (status === 200 && data && !data.error) {
        kvBlobSet(meKey, { ts: Date.now(), data }).catch(() => {});
        res.setHeader('X-SO-Cache', 'MISS');
      }
      for (const name of RATE_LIMIT_HEADERS) { const v = headers.get(name); if (v != null) res.setHeader(name, v); }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(status).json(data);
    }
    // データGETはKVで全ユーザー共有キャッシュ（レート制限対策）。ブランド全体（キーのみ）で
    // 取得した結果は誰にとっても同じなので、クライアントがBearerを送っていてもキャッシュを配信・
    // 蓄積してよい（旧フロントの全店取得もキャッシュに乗せて上流負荷を即座に下げるため）。
    // ただしログイン必須キーで「Bearerフォールバック＝ユーザー個別スコープ」になった応答は蓄積しない。
    const cacheable = !alwaysBearer && kvConfigured();
    const ckey = cacheable ? soCacheKey(resource, rest) : '';
    let cachedStale = null; // 期限切れでも保持（レート制限時のフォールバック用）
    if (cacheable) {
      try {
        const c = await kvBlobGet(ckey);
        if (c && c.ts && c.data) {
          cachedStale = c.data;
          if ((Date.now() - c.ts) < SO_CACHE_TTL_MS(upstream.endpoint.kind)) {
            res.setHeader('X-SO-Cache', 'HIT');
            res.setHeader('Cache-Control', `s-maxage=${Math.round(SO_CACHE_TTL_MS(upstream.endpoint.kind) / 1000)}, stale-while-revalidate=600`);
            return res.status(200).json(c.data);
          }
        }
      } catch (_) { /* キャッシュ不通は素通りで上流取得 */ }
    }

    // 全店ビューはまず【キーのみ】で取得＝全店。ログイン必須キーで user_auth_required の
    // ときのみ Bearer を付けて再取得（そのスタッフのスコープ）。me は常に Bearer。
    let usedFallback = false; // Bearerフォールバック＝ユーザー個別スコープ（＝共有キャッシュに載せない）
    // 429（レート制限）は Retry-After を待って再試行。ただし古いキャッシュがあれば待たず即STALE配信。
    const resilientOpts = { budgetMs: cachedStale ? 0 : 55000 };
    let { status, headers, data } = await fetchSalonOneResilient(upstream.url, apiKey, alwaysBearer ? bearer : '', resilientOpts);
    if (!alwaysBearer && bearer && status === 401) {
      const code = data && data.error && data.error.code;
      if (code === 'user_auth_required' || code === 'invalid_token' || code === 'unauthorized') {
        usedFallback = true;
        ({ status, headers, data } = await fetchSalonOneResilient(upstream.url, apiKey, bearer, resilientOpts));
      }
    }
    // レート制限/エラー時は、古いキャッシュがあればそれを返す（エラー連鎖・再試行の嵐を防ぐ）。
    const isErr = status !== 200 || (data && data.error);
    if (cacheable && !usedFallback && isErr && cachedStale) {
      res.setHeader('X-SO-Cache', 'STALE');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(cachedStale);
    }
    // 成功応答をKVへ（fire-and-forget）。フォールバック（ユーザー個別）は載せない。
    if (cacheable && !usedFallback && status === 200 && data && !data.error) {
      kvBlobSet(ckey, { ts: Date.now(), data }).catch(() => {});
      res.setHeader('X-SO-Cache', 'MISS');
    }

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

// ── 上流へGET（レート制限429は Retry-After を尊重してサーバー側で待って再試行） ──
// SalonOne は 60/分。全店コールドロード時などに一時的に429になるが、
// Retry-After（例: 14〜43秒）を待てば枠がリセットされ200になる。クライアントに429を
// そのまま返すと「エラー」になるため、関数の実行予算(≦60秒)内で1〜数回待って再試行する。
// KVキャッシュが温まれば以降は全ユーザーがHITするので、この待機は真にコールドな初回のみ。
async function fetchSalonOneResilient(url, apiKey, bearer = '', { budgetMs = 55000, maxWaitMs = 52000 } = {}) {
  const start = Date.now();
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    last = await fetchSalonOne(url, apiKey, bearer);
    if (last.status !== 429) return last;
    const raRaw = last.headers && last.headers.get ? Number(last.headers.get('retry-after')) : NaN;
    const waitMs = Math.min((Number.isFinite(raRaw) && raRaw > 0 ? raRaw : 3) * 1000 + 500, maxWaitMs);
    // 予算超過なら429のまま返す（呼び出し側が古いキャッシュ等でフォールバック）
    if (Date.now() - start + waitMs > budgetMs) return last;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return last;
}

// ── 上流へGETリクエスト（55秒タイムアウト。bearerがあればユーザー認証を透過） ──
async function fetchSalonOne(url, apiKey, bearer = '') {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 55000);
  try {
    const headers = { [HEADER_NAME]: apiKey, Accept: 'application/json' };
    if (bearer) headers.Authorization = bearer;
    const response = await fetch(url, {
      method: 'GET',
      headers,
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

// ── 上流へPOST（429は Retry-After を尊重してサーバー側で待機・再試行） ──
// auth/login の大量同時実行(ローンチ)でレート制限になっても、枠リセットを待って成功させる。
// 認証エラー(400/401/422等)は待たず即返す。budgetMs=0 なら再試行しない（logout用）。
async function postSalonOneResilient(url, apiKey, payload, bearer = '', { budgetMs = 52000, maxWaitMs = 50000 } = {}) {
  const start = Date.now();
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    last = await postSalonOne(url, apiKey, payload, bearer);
    if (last.status !== 429) return last;
    if (budgetMs <= 0) return last;
    const raRaw = last.headers && last.headers.get ? Number(last.headers.get('retry-after')) : NaN;
    const waitMs = Math.min((Number.isFinite(raRaw) && raRaw > 0 ? raRaw : 3) * 1000 + 500, maxWaitMs);
    if (Date.now() - start + waitMs > budgetMs) return last;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return last;
}

// ── 上流へPOST（サロンワン ユーザー認証 auth/* 専用・20秒タイムアウト） ──
async function postSalonOne(url, apiKey, payload, bearer = '') {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  try {
    const headers = { [HEADER_NAME]: apiKey, Accept: 'application/json', 'Content-Type': 'application/json' };
    if (bearer) headers.Authorization = bearer;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload || {}),
      redirect: 'follow',
      signal: controller.signal,
    });
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
    // 429は一時的なので Retry-After を待って再試行し、真の到達性を報告する
    const { status, headers, data } = await fetchSalonOneResilient(url, apiKey);
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
