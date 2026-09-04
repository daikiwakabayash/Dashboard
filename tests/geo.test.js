import { describe, it, expect } from 'vitest';
import { regionOf, shopGeoRank, compareShopsByGeo, groupShopsByRegion } from '../lib/geo.js';

describe('geo: shopGeoRank', () => {
  it('maps known place names to prefecture rank', () => {
    expect(shopGeoRank('NAORU 札幌院')).toBe(1);
    expect(shopGeoRank('NAORU 仙台院')).toBe(4);
    expect(shopGeoRank('NAORU 銀座院')).toBe(13);
    expect(shopGeoRank('NAORU 武蔵小杉院')).toBe(14); // 神奈川（小杉/杉より長いキー優先）
    expect(shopGeoRank('NAORU 静岡院')).toBe(22);
    expect(shopGeoRank('NAORU 江坂院')).toBe(27); // 大阪
    expect(shopGeoRank('NAORU 博多院')).toBe(40); // 福岡
    expect(shopGeoRank('NAORU 那覇院')).toBe(47);
  });
  it('maps expanded real store locations correctly (no longer その他)', () => {
    expect(shopGeoRank('NAORU 上溝院')).toBe(14);   // 相模原/神奈川
    expect(shopGeoRank('NAORU 新馬場院')).toBe(13);  // 品川/東京
    expect(shopGeoRank('NAORU 綱島院')).toBe(14);
    expect(shopGeoRank('NAORU センター南院')).toBe(14);
    expect(shopGeoRank('NAORU 浦添院')).toBe(47);   // 沖縄
    expect(shopGeoRank('NAORU 諫早院')).toBe(42);   // 長崎
    expect(shopGeoRank('NAORU Sunway Velocity')).toBe(1000); // 海外
  });
  it('overseas → 1000, unknown → 950', () => {
    expect(shopGeoRank('NAORU シドニー院')).toBe(1000);
    expect(shopGeoRank('NAORU Perth')).toBe(1000);
    expect(shopGeoRank('NAORU ふしぎ院')).toBe(950);
  });
});

describe('geo: regionOf', () => {
  it('maps ranks to region names', () => {
    expect(regionOf(1)).toBe('北海道');
    expect(regionOf(4)).toBe('東北');
    expect(regionOf(13)).toBe('関東');
    expect(regionOf(22)).toBe('中部');
    expect(regionOf(27)).toBe('近畿');
    expect(regionOf(40)).toBe('九州');
    expect(regionOf(47)).toBe('沖縄');
    expect(regionOf(1000)).toBe('海外');
    expect(regionOf(950)).toBe('その他');
  });
});

describe('geo: ordering', () => {
  it('sorts north→south, overseas last', () => {
    const shops = [
      { name: 'NAORU シドニー院' }, { name: 'NAORU 博多院' }, { name: 'NAORU 札幌院' },
      { name: 'NAORU 銀座院' }, { name: 'NAORU 江坂院' },
    ];
    const sorted = shops.slice().sort(compareShopsByGeo).map(s => s.name);
    expect(sorted).toEqual(['NAORU 札幌院', 'NAORU 銀座院', 'NAORU 江坂院', 'NAORU 博多院', 'NAORU シドニー院']);
  });
  it('groups by region in north→south order with overseas last', () => {
    const groups = groupShopsByRegion([
      { name: 'NAORU シドニー院' }, { name: 'NAORU 札幌院' }, { name: 'NAORU 銀座院' }, { name: 'NAORU 荻窪院' },
    ]);
    expect(groups.map(g => g.region)).toEqual(['北海道', '関東', '海外']);
    expect(groups[1].shops.length).toBe(2); // 関東に2店舗
  });
});
