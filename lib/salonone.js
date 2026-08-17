// ── SalonOne 分析API 連携ロジック（テスト用分離モジュール） ──────────────
//
// SalonOne の「分析API」(https://salonone.net/api/analytics/v1) は、
// キーを発行したブランドのデータを取得する【読み取り専用（GETのみ）】API。
// 認証は運営発行のアクセスキーをヘッダ `X-SalonOne-Api-Key` に付与する。
//
// このモジュールは URL に依存しない純粋ロジックのみを持ち、
// 実際の fetch / 環境変数アクセスは api/salonone.js 側で行う。

export const ANALYTICS_BASE = 'https://salonone.net/api/analytics/v1';

// 明細系エンドポイント共通のクエリパラメータ（ページング・絞り込み）
const DETAIL_PARAMS = ['limit', 'cursor', 'updated_since', 'shop_id'];

// ── エンドポイント登録簿（許可リスト） ─────────────────────────────
// path     : ベースURLからの相対パス
// params   : 転送を許可するクエリパラメータ（それ以外は無視）
// required : 必須パラメータ（欠けると invalid_request）
// kind     : 'summary'（集計） / 'detail'（明細） / 'meta'
export const ENDPOINTS = {
  'meta':             { path: '/meta',             params: [],             required: [],             kind: 'meta' },
  'sales/summary':    { path: '/sales/summary',    params: ['from', 'to', 'shop_id'], required: ['from', 'to'], kind: 'summary' },
  'marketing/by-channel': { path: '/marketing/by-channel', params: ['from', 'to', 'shop_id'], required: ['from', 'to'], kind: 'summary' },
  'marketing/by-staff':   { path: '/marketing/by-staff',   params: ['from', 'to', 'shop_id'], required: ['from', 'to'], kind: 'summary' },
  'marketing/retention':  { path: '/marketing/retention',  params: ['from', 'to', 'shop_id'], required: ['from', 'to'], kind: 'summary' },
  // 強制リンク(クリエイティブ)単位の集計・マスタ 候補（API提供有無を検証中）
  'marketing/by-forced-link': { path: '/marketing/by-forced-link', params: ['from', 'to', 'shop_id'], required: ['from', 'to'], kind: 'summary' },
  'marketing/by-creative':    { path: '/marketing/by-creative',    params: ['from', 'to', 'shop_id'], required: ['from', 'to'], kind: 'summary' },
  'marketing/by-link':        { path: '/marketing/by-link',        params: ['from', 'to', 'shop_id'], required: ['from', 'to'], kind: 'summary' },
  'forced-links':     { path: '/forced-links',     params: DETAIL_PARAMS, required: [], kind: 'detail' },
  'creatives':        { path: '/creatives',        params: DETAIL_PARAMS, required: [], kind: 'detail' },
  'shops':            { path: '/shops',            params: DETAIL_PARAMS,  required: [], kind: 'detail' },
  'staffs':           { path: '/staffs',           params: DETAIL_PARAMS,  required: [], kind: 'detail' },
  'menus':            { path: '/menus',            params: DETAIL_PARAMS,  required: [], kind: 'detail' },
  'menu-categories':  { path: '/menu-categories',  params: DETAIL_PARAMS,  required: [], kind: 'detail' },
  'visit-sources':    { path: '/visit-sources',    params: DETAIL_PARAMS,  required: [], kind: 'detail' },
  'customer-tags':    { path: '/customer-tags',    params: DETAIL_PARAMS,  required: [], kind: 'detail' },
  'customers':        { path: '/customers',        params: DETAIL_PARAMS,  required: [], kind: 'detail' },
  'appointments':     { path: '/appointments',     params: DETAIL_PARAMS,  required: [], kind: 'detail' },
  'appointment-menus':{ path: '/appointment-menus',params: DETAIL_PARAMS,  required: [], kind: 'detail' },
};

// レスポンスに含まれ得るレート制限ヘッダ（プロキシで透過させる）
export const RATE_LIMIT_HEADERS = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'retry-after'];

// 1回の取得件数の上限（仕様: 既定200・最大1000）
export const MAX_LIMIT = 1000;

// ── 利用可能なリソース名の一覧 ──
export function listResources() {
  return Object.keys(ENDPOINTS);
}

// ── リソース名を正規化して定義を返す（未知なら null） ──
// 先頭/末尾のスラッシュを許容し、`/meta` や `sales/summary/` も受け付ける。
export function getEndpoint(resource) {
  if (!resource || typeof resource !== 'string') return null;
  const key = resource.trim().replace(/^\/+|\/+$/g, '');
  return Object.prototype.hasOwnProperty.call(ENDPOINTS, key)
    ? { key, ...ENDPOINTS[key] }
    : null;
}

// ── 検証エラー（api/salonone.js が HTTP ステータスへ変換する） ──
export class SalonOneValidationError extends Error {
  constructor(code, message, { status = 400, fields = [] } = {}) {
    super(message);
    this.name = 'SalonOneValidationError';
    this.code = code;       // 'not_found' | 'invalid_request'
    this.status = status;
    this.fields = fields;   // 問題のあったパラメータ名
  }
}

// YYYY-MM-DD 形式か（売上サマリの from/to 用）
function isValidDate(value) {
  if (typeof value !== 'string') return false;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const [, y, mo, d] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// ── クエリを検証し、許可されたパラメータだけを抽出する ──
// 戻り値: { params: {...} }（転送してよい値のみ）
// 失敗時: SalonOneValidationError を throw
export function validateQuery(endpoint, query = {}) {
  const invalidFields = [];

  // 必須チェック
  const missing = endpoint.required.filter(
    (name) => query[name] === undefined || query[name] === null || query[name] === ''
  );
  if (missing.length > 0) {
    throw new SalonOneValidationError(
      'invalid_request',
      `Missing required parameter(s): ${missing.join(', ')}`,
      { fields: missing }
    );
  }

  const out = {};
  for (const name of endpoint.params) {
    const raw = query[name];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = String(raw);

    if ((name === 'from' || name === 'to') && !isValidDate(value)) {
      invalidFields.push(name);
      continue;
    }

    if (name === 'limit') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
        invalidFields.push(name);
        continue;
      }
      out[name] = String(n);
      continue;
    }

    out[name] = value;
  }

  if (invalidFields.length > 0) {
    throw new SalonOneValidationError(
      'invalid_request',
      `Invalid parameter(s): ${invalidFields.join(', ')}`,
      { fields: invalidFields }
    );
  }

  return { params: out };
}

// ── 上流（SalonOne）へのリクエストURLを組み立てる ──
// resource が未知なら not_found を throw、パラメータ不正なら invalid_request を throw。
export function buildUpstreamUrl(resource, query = {}, base = ANALYTICS_BASE) {
  const endpoint = getEndpoint(resource);
  if (!endpoint) {
    throw new SalonOneValidationError(
      'not_found',
      `Unknown resource: ${resource}`,
      { status: 404, fields: ['resource'] }
    );
  }
  const { params } = validateQuery(endpoint, query);
  const url = new URL(base.replace(/\/+$/, '') + endpoint.path);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return { url: url.toString(), endpoint };
}

// ── UTC ISO文字列を日本時間(+9h)へ変換 ──
// 明細の日時項目（start_at, created_at 等）はUTC。表示用にJSTへ寄せる。
// 戻り値は "YYYY-MM-DDTHH:mm:ss+09:00"。パースできなければ null。
export function utcToJstIso(isoUtc) {
  if (!isoUtc) return null;
  const d = new Date(isoUtc);
  if (isNaN(d.getTime())) return null;
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())}` +
    `T${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}:${p(jst.getUTCSeconds())}+09:00`
  );
}
