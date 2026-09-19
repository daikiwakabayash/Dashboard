import { describe, it, expect } from 'vitest';
import { REGIONS, regionMeta, regionKeyOf, groupByRegion, MAP_PATHS, mapPathOf, MAP_NOTE, COLLAPSE_OVER, defaultOpen } from '../lib/org-map.js';
import { shopGeoRank } from '../lib/geo.js';

const shop = (id, name) => ({ id, name, rank: shopGeoRank(name) });

describe('地域の並び', () => {
  it('北から南、そのあと海外、最後に本部', () => {
    expect(REGIONS.map(r => r.key)).toEqual([
      'hokkaido', 'tohoku', 'kanto', 'chubu', 'kansai', 'chugoku', 'shikoku', 'kyushu', 'okinawa',
      'australia', 'malaysia', 'other', 'hq',
    ]);
  });
  it('日本語と英字の見出しを持つ', () => {
    expect(regionMeta('kansai')).toMatchObject({ ja: '関西', latin: 'KANSAI' });
    expect(regionMeta('hq')).toMatchObject({ ja: '本部', latin: 'HEADQUARTERS' });
  });
  it('知らないキーは「その他」になる', () => {
    expect(regionMeta('zzz').ja).toBe('その他');
  });
});

describe('店舗を地域へ振り分ける', () => {
  it('国内の店舗を地域へ入れる', () => {
    expect(regionKeyOf(shopGeoRank('NAORU 札幌院'), 'NAORU 札幌院')).toBe('hokkaido');
    expect(regionKeyOf(shopGeoRank('NAORU 仙台院'), 'NAORU 仙台院')).toBe('tohoku');
    expect(regionKeyOf(shopGeoRank('NAORU 渋谷院'), 'NAORU 渋谷院')).toBe('kanto');
    expect(regionKeyOf(shopGeoRank('NAORU 名古屋院'), 'NAORU 名古屋院')).toBe('chubu');
    expect(regionKeyOf(shopGeoRank('NAORU 梅田院'), 'NAORU 梅田院')).toBe('kansai');
    expect(regionKeyOf(shopGeoRank('NAORU 広島院'), 'NAORU 広島院')).toBe('chugoku');
    expect(regionKeyOf(shopGeoRank('NAORU 高松院'), 'NAORU 高松院')).toBe('shikoku');
    expect(regionKeyOf(shopGeoRank('NAORU 博多院'), 'NAORU 博多院')).toBe('kyushu');
    expect(regionKeyOf(shopGeoRank('NAORU 那覇院'), 'NAORU 那覇院')).toBe('okinawa');
  });
  it('「近畿」は画面では「関西」として出す（中身は同じ）', () => {
    expect(regionMeta(regionKeyOf(shopGeoRank('NAORU 京都院'), 'NAORU 京都院')).ja).toBe('関西');
  });
  it('海外は国ごとに分ける', () => {
    expect(regionKeyOf(1000, 'NAORU Sydney')).toBe('australia');
    expect(regionKeyOf(1000, 'NAORU ゴールドコースト院')).toBe('australia');
    expect(regionKeyOf(1000, 'NAORU KLCC')).toBe('malaysia');
    expect(regionKeyOf(1000, 'NAORU モントキアラ院')).toBe('malaysia');
  });
  it('🔴 海外でも国が分からなければ、勝手にどちらかへ入れない', () => {
    expect(regionKeyOf(1000, 'NAORU Overseas Test')).toBe('other');
  });
  it('🔴 地名が読み取れない店舗も、勝手にどこかの地域へ入れない', () => {
    expect(regionKeyOf(shopGeoRank('NAORU 新店'), 'NAORU 新店')).toBe('other');
  });
});

describe('地域ごとにまとめる', () => {
  const shops = [shop(1, 'NAORU 札幌院'), shop(2, 'NAORU 仙台院'), shop(3, 'NAORU 山形院'),
    shop(4, 'NAORU 渋谷院'), shop(5, 'NAORU Sydney'), shop(6, 'NAORU 新店')];
  const got = groupByRegion(shops);
  it('北から南の順に並ぶ', () => {
    expect(got.map(g => g.ja)).toEqual(['北海道', '東北', '関東', 'オーストラリア', 'その他']);
  });
  it('地域の中は北から南の順', () => {
    expect(got[1].shops.map(s => s.name)).toEqual(['NAORU 仙台院', 'NAORU 山形院']);
  });
  it('🔴 店舗が1つも無い地域は出さない（空の見出しを並べない）', () => {
    expect(got.map(g => g.key)).not.toContain('okinawa');
  });
  it('壊れた入力でも落ちない', () => {
    expect(groupByRegion(null)).toEqual([]);
    expect(groupByRegion([null, {}, { name: 'x' }])).toEqual([]);
  });
});

describe('🔴 地図は飾りだと分かるようにする', () => {
  it('どの地域にもかたちがある', () => {
    for (const r of REGIONS) expect(mapPathOf(r.key), r.key).toBeTruthy();
  });
  it('同じ大きさの枠に収まる（0〜100）', () => {
    for (const [k, d] of Object.entries(MAP_PATHS)) {
      const nums = String(d).match(/-?\d+(\.\d+)?/g).map(Number);
      expect(Math.min(...nums), k).toBeGreaterThanOrEqual(0);
      expect(Math.max(...nums), k).toBeLessThanOrEqual(100);
    }
  });
  it('本部は地図ではない（建物のかたち）', () => {
    expect(mapPathOf('hq')).not.toBe(mapPathOf('other'));
  });
  it('「正確な地図ではない」と画面に出す文がある', () => {
    expect(MAP_NOTE).toContain('飾り');
    expect(MAP_NOTE).toContain('正確');
  });
});

describe('地域の開閉', () => {
  const many = { shops: new Array(200).fill(0).map((_, i) => ({ id: i })) };
  const few = { shops: [{ id: 1 }] };
  it('🔴 オーナー指示により、店舗数にかかわらず最初から開く', () => {
    expect(COLLAPSE_OVER).toBe(Infinity);
    expect(defaultOpen(many)).toBe(true);
    expect(defaultOpen(few)).toBe(true);
  });
  it('🔴 検索中はすべて開く（探しているものが隠れない）', () => {
    expect(defaultOpen(many, { searching: true })).toBe(true);
  });
  it('壊れた入力でも落ちない', () => {
    expect(defaultOpen(null)).toBe(true);
  });
});
