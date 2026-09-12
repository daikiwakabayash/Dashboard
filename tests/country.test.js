import { describe, it, expect } from 'vitest';
import { shopCountry, isOverseas, primaryCountry, COUNTRY_LABELS } from '../lib/country.js';

describe('shopCountry（timezone優先）', () => {
  it('Asia/Tokyo は日本', () => {
    expect(shopCountry({ timezone: 'Asia/Tokyo', name: 'NAORU 千葉駅院' })).toBe('jp');
  });
  it('Australia/* はオーストラリア', () => {
    expect(shopCountry({ timezone: 'Australia/Brisbane', name: 'NAORU Ascot' })).toBe('au');
    expect(shopCountry({ timezone: 'Australia/Sydney' })).toBe('au');
  });
  it('Asia/Kuala_Lumpur はマレーシア', () => {
    expect(shopCountry({ timezone: 'Asia/Kuala_Lumpur', name: 'NAORU Mont Kiara' })).toBe('my');
    expect(shopCountry({ timezone: 'Asia/Kuching' })).toBe('my');
  });
});

describe('shopCountry（area_id 最優先＝既存全体管理と同基準）', () => {
  it('area_id 900000342 は豪州・900000341 は馬来（timezone無くても）', () => {
    expect(shopCountry({ area_id: '900000342', name: 'NAORU Ascot' })).toBe('au');
    expect(shopCountry({ area_id: '900000341', name: 'NAORU Mont Kiara' })).toBe('my');
    expect(shopCountry({ area_id: '45', name: 'NAORU 千葉駅院' })).toBe('jp');
  });
});

describe('shopCountry（住所/名前フォールバック）', () => {
  it('timezone無し・マレーシア住所', () => {
    expect(shopCountry({ name: 'NAORU Bukit Jalil', address: 'Kuala Lumpur, Malaysia' })).toBe('my');
  });
  it('timezone無し・豪州住所', () => {
    expect(shopCountry({ name: 'NAORU Mt.Gravatt', address: '7/1412 Logan Road, Mount Gravatt, QLD 4122' })).toBe('au');
  });
  it('timezone無し・日本語住所は日本', () => {
    expect(shopCountry({ name: 'NAORU 静岡院', address: '静岡県静岡市葵区御幸町' })).toBe('jp');
  });
  it('判定不能は日本を既定', () => {
    expect(shopCountry({})).toBe('jp');
    expect(shopCountry({ name: 'NAORU' })).toBe('jp');
  });
});

describe('isOverseas', () => {
  it('日本以外は海外', () => {
    expect(isOverseas({ timezone: 'Asia/Tokyo' })).toBe(false);
    expect(isOverseas({ timezone: 'Australia/Brisbane' })).toBe(true);
    expect(isOverseas({ timezone: 'Asia/Kuala_Lumpur' })).toBe(true);
  });
});

describe('primaryCountry（ユーザーの主な国）', () => {
  it('空は日本', () => { expect(primaryCountry([])).toBe('jp'); });
  it('単一国はその国', () => {
    expect(primaryCountry([{ timezone: 'Australia/Brisbane' }, { timezone: 'Australia/Brisbane' }])).toBe('au');
    expect(primaryCountry([{ timezone: 'Asia/Kuala_Lumpur' }])).toBe('my');
  });
  it('混在は日本優先', () => {
    expect(primaryCountry([{ timezone: 'Asia/Tokyo' }, { timezone: 'Australia/Brisbane' }])).toBe('jp');
  });
});

describe('COUNTRY_LABELS', () => {
  it('ラベル', () => {
    expect(COUNTRY_LABELS.jp).toBe('日本');
    expect(COUNTRY_LABELS.au).toBe('オーストラリア');
    expect(COUNTRY_LABELS.my).toBe('マレーシア');
  });
});
