import { describe, it, expect } from 'vitest';
import {
  buildSearchRequest, parsePlacesResponse, normalizeAddress, addressMatch,
  PLACES_TEXT_SEARCH_URL, PLACES_FIELD_MASK,
} from '../lib/places.js';

describe('buildSearchRequest', () => {
  it('空クエリは null', () => {
    expect(buildSearchRequest('')).toBeNull();
    expect(buildSearchRequest('   ')).toBeNull();
  });
  it('textQuery と既定の言語/地域を組み立てる', () => {
    const r = buildSearchRequest('NAORU整体 恵比寿院');
    expect(r.url).toBe(PLACES_TEXT_SEARCH_URL);
    expect(r.method).toBe('POST');
    expect(r.fieldMask).toBe(PLACES_FIELD_MASK);
    expect(r.body.textQuery).toBe('NAORU整体 恵比寿院');
    expect(r.body.languageCode).toBe('ja');
    expect(r.body.regionCode).toBe('JP');
  });
  it('FieldMask に評価・件数・住所を含む', () => {
    expect(PLACES_FIELD_MASK).toContain('places.rating');
    expect(PLACES_FIELD_MASK).toContain('places.userRatingCount');
    expect(PLACES_FIELD_MASK).toContain('places.formattedAddress');
  });
});

describe('parsePlacesResponse', () => {
  it('places が無ければ null', () => {
    expect(parsePlacesResponse({})).toBeNull();
    expect(parsePlacesResponse({ places: [] })).toBeNull();
  });
  it('先頭の店舗を整形する', () => {
    const json = { places: [{
      id: 'abc', displayName: { text: 'NAORU整体 恵比寿院' }, formattedAddress: '東京都渋谷区恵比寿1-2-3',
      rating: 4.6, userRatingCount: 42, businessStatus: 'OPERATIONAL', googleMapsUri: 'https://maps.google.com/?cid=1',
    }] };
    const p = parsePlacesResponse(json);
    expect(p.placeId).toBe('abc');
    expect(p.name).toBe('NAORU整体 恵比寿院');
    expect(p.address).toBe('東京都渋谷区恵比寿1-2-3');
    expect(p.rating).toBe(4.6);
    expect(p.userRatingCount).toBe(42);
    expect(p.businessStatus).toBe('OPERATIONAL');
  });
  it('userRatingCount 欠落は 0 扱い', () => {
    const p = parsePlacesResponse({ places: [{ id: 'x', displayName: { text: 'A' }, formattedAddress: 'B' }] });
    expect(p.userRatingCount).toBe(0);
    expect(p.rating).toBeNull();
  });
});

describe('normalizeAddress', () => {
  it('郵便番号・「日本」・全角を除去して正規化', () => {
    const n = normalizeAddress('〒150-0013 日本、東京都渋谷区恵比寿１−２−３');
    expect(n).not.toContain('150');
    expect(n).not.toContain('日本');
    expect(n).toContain('1-2-3');
  });
  it('漢数字の丁目を算用数字に', () => {
    const n = normalizeAddress('東京都渋谷区恵比寿一丁目2番3号');
    expect(n).toContain('1-2-3');
  });
});

describe('addressMatch', () => {
  it('表記ゆれ（丁目 vs ハイフン）でも一致', () => {
    const m = addressMatch('東京都渋谷区恵比寿1丁目2-3', '東京都渋谷区恵比寿1-2-3 NAORUビル2F');
    expect(m.match).toBe(true);
  });
  it('番地違いは不一致', () => {
    const m = addressMatch('東京都渋谷区恵比寿1-2-3', '東京都渋谷区恵比寿1-2-9');
    expect(m.match).toBe(false);
  });
  it('町名違いは不一致', () => {
    const m = addressMatch('東京都渋谷区恵比寿1-2-3', '東京都新宿区西新宿1-2-3');
    expect(m.match).toBe(false);
  });
  it('空は不一致', () => {
    expect(addressMatch('', '東京都渋谷区').match).toBe(false);
  });
});
