import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifySalonOneBearer, bearerFromReq } from '../lib/salonone-auth.js';

describe('bearerFromReq', () => {
  it('Bearer トークンを取り出す（大文字小文字ヘッダ両対応）', () => {
    expect(bearerFromReq({ headers: { authorization: 'Bearer so_at_1' } })).toBe('Bearer so_at_1');
    expect(bearerFromReq({ headers: { Authorization: 'Bearer so_at_2' } })).toBe('Bearer so_at_2');
  });
  it('Bearer 形式でない/欠落は空文字', () => {
    expect(bearerFromReq({ headers: { authorization: 'Basic xxx' } })).toBe('');
    expect(bearerFromReq({ headers: {} })).toBe('');
    expect(bearerFromReq({})).toBe('');
  });
});

describe('verifySalonOneBearer', () => {
  const OLD = process.env.SALONONE_API_KEY;
  beforeEach(() => { process.env.SALONONE_API_KEY = 'so_analytics_test'; });
  afterEach(() => { process.env.SALONONE_API_KEY = OLD; vi.unstubAllGlobals(); });

  it('Bearer 形式でなければ /me を呼ばず null', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await verifySalonOneBearer('')).toBeNull();
    expect(await verifySalonOneBearer('Basic x')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('APIキー未設定なら null', async () => {
    process.env.SALONONE_API_KEY = '';
    expect(await verifySalonOneBearer('Bearer so_at_1')).toBeNull();
  });

  it('brand_admin は root=true（全店）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { user_id: 1, role: 'brand_admin', accessible_shops: [] } }),
    })));
    const so = await verifySalonOneBearer('Bearer so_at_1');
    expect(so.root).toBe(true);
    expect(so.role).toBe('brand_admin');
  });

  it('shop_admin は root=false・アクセス店舗を持つ', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { user_id: 2, login_id: 'owner1', role: 'shop_admin', accessible_shops: [{ id: 25, name: '渋谷院' }, { id: 26, name: '恵比寿院' }] } }),
    })));
    const so = await verifySalonOneBearer('Bearer so_at_2');
    expect(so.root).toBe(false);
    expect(so.role).toBe('shop_admin');
    expect(so.shopIds).toEqual(['25', '26']);
    expect(so.shopNames).toEqual(['渋谷院', '恵比寿院']);
    expect(so.loginId).toBe('owner1');
  });

  it('/me が 401 なら null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    expect(await verifySalonOneBearer('Bearer bad')).toBeNull();
  });

  it('user 情報が無ければ null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: {} }) })));
    expect(await verifySalonOneBearer('Bearer so_at_3')).toBeNull();
  });
});
