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
  // ── サロンワン ユーザー認証（SSO）───────────────────────────────
  // ログインのみ POST。トークン(access/refresh)を発行/更新/破棄する。
  // 本文は bodyFields のみ転送を許可（それ以外は無視）。
  'auth/login':       { path: '/auth/login',       params: [], required: [], kind: 'auth', method: 'POST', bodyFields: ['login_id', 'password', 'brand_code'] },
  'auth/refresh':     { path: '/auth/refresh',     params: [], required: [], kind: 'auth', method: 'POST', bodyFields: ['refresh_token'] },
  'auth/logout':      { path: '/auth/logout',      params: [], required: [], kind: 'auth', method: 'POST', bodyFields: [] },
  'me':               { path: '/me',               params: [], required: [], kind: 'meta' },
  'sales/summary':    { path: '/sales/summary',    params: ['from', 'to', 'shop_id', 'group_by'], required: ['from', 'to'], kind: 'summary' },
  'marketing/by-channel': { path: '/marketing/by-channel', params: ['from', 'to', 'shop_id'], required: ['from', 'to'], kind: 'summary' },
  'marketing/by-staff':   { path: '/marketing/by-staff',   params: ['from', 'to', 'shop_id'], required: ['from', 'to'], kind: 'summary' },
  'marketing/retention':  { path: '/marketing/retention',  params: ['from', 'to', 'shop_id'], required: ['from', 'to'], kind: 'summary' },
  // 注: 強制リンク(クリエイティブ)単位の集計/マスタは SalonOne APIに存在しない（by-forced-link 等は上流404・
  //     appointments の forced_link_id もほぼ未設定）。クリエイティブ分析タブは media(by-channel)単位で実装。
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

    // group_by は 'shop'（店舗別内訳を1リクエストで返す）のみ許可
    if (name === 'group_by' && value !== 'shop') {
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

// ── 認証(POST)エンドポイントの本文を、許可フィールドだけに絞る ──
// 未知のキーは転送しない（余計な情報を上流へ送らない）。
export function pickAuthBody(endpoint, body = {}) {
  const allow = Array.isArray(endpoint && endpoint.bodyFields) ? endpoint.bodyFields : [];
  const out = {};
  const src = (body && typeof body === 'object') ? body : {};
  for (const k of allow) {
    if (src[k] !== undefined && src[k] !== null && src[k] !== '') out[k] = src[k];
  }
  return out;
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
