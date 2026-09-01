import { describe, it, expect } from 'vitest';
import {
  ANALYTICS_BASE,
  ENDPOINTS,
  MAX_LIMIT,
  RATE_LIMIT_HEADERS,
  listResources,
  getEndpoint,
  validateQuery,
  buildUpstreamUrl,
  pickAuthBody,
  utcToJstIso,
  SalonOneValidationError,
} from '../lib/salonone.js';

// ── エンドポイント登録簿 ─────────────────────────────────────────
describe('ENDPOINTS registry', () => {
  it('仕様の全エンドポイントを網羅している', () => {
    const expected = [
      'meta', 'me', 'sales/summary',
      'auth/login', 'auth/refresh', 'auth/logout',
      'marketing/by-channel', 'marketing/by-staff', 'marketing/retention',
      'shops', 'staffs', 'menus', 'menu-categories',
      'visit-sources', 'customer-tags', 'customers', 'appointments', 'appointment-menus',
    ];
    expect(listResources().sort()).toEqual(expected.sort());
  });

  it('全エンドポイントが path と kind を持つ', () => {
    for (const [key, def] of Object.entries(ENDPOINTS)) {
      expect(def.path, key).toMatch(/^\//);
      expect(['meta', 'summary', 'detail', 'auth']).toContain(def.kind);
    }
  });

  it('auth/* は POST・bodyFields を持つ', () => {
    for (const key of ['auth/login', 'auth/refresh', 'auth/logout']) {
      expect(ENDPOINTS[key].kind).toBe('auth');
      expect(ENDPOINTS[key].method).toBe('POST');
      expect(Array.isArray(ENDPOINTS[key].bodyFields)).toBe(true);
    }
    expect(ENDPOINTS['auth/login'].bodyFields).toEqual(['login_id', 'password', 'brand_code']);
  });

  it('sales/summary は from/to を必須にする', () => {
    expect(ENDPOINTS['sales/summary'].required).toEqual(['from', 'to']);
  });
});

// ── pickAuthBody（認証POSTの本文フィルタ）─────────────────────────
describe('pickAuthBody', () => {
  it('許可フィールドのみ抽出し、未知キーは捨てる', () => {
    const ep = getEndpoint('auth/login');
    const out = pickAuthBody(ep, { login_id: 'yamada', password: 'pw', evil: 'x', role: 'brand_admin' });
    expect(out).toEqual({ login_id: 'yamada', password: 'pw' });
  });
  it('空文字・null・undefined は除外する', () => {
    const ep = getEndpoint('auth/refresh');
    expect(pickAuthBody(ep, { refresh_token: '' })).toEqual({});
    expect(pickAuthBody(ep, { refresh_token: null })).toEqual({});
    expect(pickAuthBody(ep, {})).toEqual({});
    expect(pickAuthBody(ep, { refresh_token: 'rt_1' })).toEqual({ refresh_token: 'rt_1' });
  });
  it('bodyFields が空(logout)なら常に空オブジェクト', () => {
    const ep = getEndpoint('auth/logout');
    expect(pickAuthBody(ep, { anything: 1 })).toEqual({});
  });
  it('brand_code は任意で通す', () => {
    const ep = getEndpoint('auth/login');
    const out = pickAuthBody(ep, { login_id: 'a', password: 'b', brand_code: 'NAORU' });
    expect(out).toEqual({ login_id: 'a', password: 'b', brand_code: 'NAORU' });
  });
});

// ── getEndpoint ─────────────────────────────────────────────────
describe('getEndpoint', () => {
  it('既知のリソースを返す', () => {
    expect(getEndpoint('customers').path).toBe('/customers');
  });

  it('先頭・末尾スラッシュを許容する', () => {
    expect(getEndpoint('/meta').key).toBe('meta');
    expect(getEndpoint('sales/summary/').key).toBe('sales/summary');
  });

  it('未知のリソースは null', () => {
    expect(getEndpoint('unknown')).toBeNull();
    expect(getEndpoint('')).toBeNull();
    expect(getEndpoint(null)).toBeNull();
    expect(getEndpoint(undefined)).toBeNull();
  });

  it('プロトタイプ汚染キーを拾わない', () => {
    expect(getEndpoint('constructor')).toBeNull();
    expect(getEndpoint('toString')).toBeNull();
  });
});

// ── validateQuery ───────────────────────────────────────────────
describe('validateQuery', () => {
  it('必須欠落は invalid_request を throw（fieldsに欠落名）', () => {
    const ep = getEndpoint('sales/summary');
    try {
      validateQuery(ep, { from: '2026-07-01' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SalonOneValidationError);
      expect(err.code).toBe('invalid_request');
      expect(err.fields).toEqual(['to']);
    }
  });

  it('許可パラメータだけを抽出し、未知パラメータは無視する', () => {
    const ep = getEndpoint('sales/summary');
    const { params } = validateQuery(ep, {
      from: '2026-07-01', to: '2026-07-31', shop_id: '3',
      evil: 'DROP TABLE', limit: '10',
    });
    expect(params).toEqual({ from: '2026-07-01', to: '2026-07-31', shop_id: '3' });
  });

  it('日付形式が不正なら invalid_request', () => {
    const ep = getEndpoint('sales/summary');
    expect(() => validateQuery(ep, { from: '2026/07/01', to: '2026-07-31' }))
      .toThrowError(/Invalid parameter/);
  });

  it('group_by=shop は許可、それ以外の group_by は弾く', () => {
    const ep = getEndpoint('sales/summary');
    expect(validateQuery(ep, { from: '2026-08-01', to: '2026-08-31', group_by: 'shop' }).params.group_by).toBe('shop');
    expect(() => validateQuery(ep, { from: '2026-08-01', to: '2026-08-31', group_by: 'staff' }))
      .toThrow(SalonOneValidationError);
  });

  it('存在しない日付を弾く', () => {
    const ep = getEndpoint('sales/summary');
    expect(() => validateQuery(ep, { from: '2026-02-30', to: '2026-07-31' }))
      .toThrow(SalonOneValidationError);
  });

  it('limit は 1..1000 の整数のみ許可', () => {
    const ep = getEndpoint('customers');
    expect(validateQuery(ep, { limit: '200' }).params.limit).toBe('200');
    expect(validateQuery(ep, { limit: String(MAX_LIMIT) }).params.limit).toBe('1000');
    expect(() => validateQuery(ep, { limit: '0' })).toThrow(SalonOneValidationError);
    expect(() => validateQuery(ep, { limit: '1001' })).toThrow(SalonOneValidationError);
    expect(() => validateQuery(ep, { limit: 'abc' })).toThrow(SalonOneValidationError);
    expect(() => validateQuery(ep, { limit: '10.5' })).toThrow(SalonOneValidationError);
  });

  it('空文字パラメータは未指定扱い（転送しない）', () => {
    const ep = getEndpoint('customers');
    const { params } = validateQuery(ep, { cursor: '', shop_id: '5' });
    expect(params).toEqual({ shop_id: '5' });
  });

  it('明細エンドポイントはページング系パラメータを通す', () => {
    const ep = getEndpoint('appointments');
    const { params } = validateQuery(ep, {
      limit: '500', cursor: 'abc', updated_since: '2026-08-01T00:00:00Z', shop_id: '2',
    });
    expect(params).toEqual({
      limit: '500', cursor: 'abc', updated_since: '2026-08-01T00:00:00Z', shop_id: '2',
    });
  });
});

// ── buildUpstreamUrl ────────────────────────────────────────────
describe('buildUpstreamUrl', () => {
  it('meta の完全URLを組み立てる', () => {
    const { url, endpoint } = buildUpstreamUrl('meta', {});
    expect(url).toBe(`${ANALYTICS_BASE}/meta`);
    expect(endpoint.kind).toBe('meta');
  });

  it('sales/summary にクエリを付与する', () => {
    const { url } = buildUpstreamUrl('sales/summary', {
      from: '2026-07-01', to: '2026-07-31', shop_id: '1',
    });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/analytics/v1/sales/summary');
    expect(parsed.searchParams.get('from')).toBe('2026-07-01');
    expect(parsed.searchParams.get('to')).toBe('2026-07-31');
    expect(parsed.searchParams.get('shop_id')).toBe('1');
  });

  it('未知リソースは not_found (404) を throw', () => {
    try {
      buildUpstreamUrl('secrets', {});
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SalonOneValidationError);
      expect(err.code).toBe('not_found');
      expect(err.status).toBe(404);
    }
  });

  it('カスタムベースURLを尊重する', () => {
    const { url } = buildUpstreamUrl('shops', {}, 'https://example.test/v1/');
    expect(url).toBe('https://example.test/v1/shops');
  });
});

// ── utcToJstIso ─────────────────────────────────────────────────
describe('utcToJstIso', () => {
  it('UTCを+9hのJST表記へ変換する', () => {
    expect(utcToJstIso('2026-08-11T06:00:00+00:00')).toBe('2026-08-11T15:00:00+09:00');
  });

  it('Zサフィックスも扱える', () => {
    expect(utcToJstIso('2026-08-11T00:00:00Z')).toBe('2026-08-11T09:00:00+09:00');
  });

  it('日付をまたぐ変換', () => {
    expect(utcToJstIso('2026-08-11T20:00:00Z')).toBe('2026-08-12T05:00:00+09:00');
  });

  it('無効値は null', () => {
    expect(utcToJstIso('')).toBeNull();
    expect(utcToJstIso(null)).toBeNull();
    expect(utcToJstIso('not-a-date')).toBeNull();
  });
});

// ── 定数 ────────────────────────────────────────────────────────
describe('constants', () => {
  it('ベースURLは本番の分析API', () => {
    expect(ANALYTICS_BASE).toBe('https://salonone.net/api/analytics/v1');
  });

  it('レート制限ヘッダ名を保持する', () => {
    expect(RATE_LIMIT_HEADERS).toContain('x-ratelimit-limit');
    expect(RATE_LIMIT_HEADERS).toContain('x-ratelimit-remaining');
    expect(RATE_LIMIT_HEADERS).toContain('retry-after');
  });
});
