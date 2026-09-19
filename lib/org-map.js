// ── 組織図: 地域の並びと地図のかたち ──────────────────────────────────
//
// ⚠️ ここで扱うのは「並び順」と「見出し」と「飾りの地図」だけです。
//   - 地図のかたちは**簡略化した飾り**です。実際の国土や県境を正確に表すものではありません。
//     位置の確認や距離の判断には使えません（画面にもそう書きます）。
//   - 店舗がどの地域かは、店舗名の地名から推定した都道府県ランク（lib/geo.js）で決めます。
//     推定できない店舗は「その他」にまとめ、**勝手にどこかの地域へ入れません**。
//
// tests/org-map.test.js でカバー。

import { regionOf } from './geo.js';

// 並び順は北→南、そのあと海外、最後に本部。
export const REGIONS = Object.freeze([
  { key: 'hokkaido', ja: '北海道', latin: 'HOKKAIDO', order: 10 },
  { key: 'tohoku', ja: '東北', latin: 'TOHOKU', order: 20 },
  { key: 'kanto', ja: '関東', latin: 'KANTO', order: 30 },
  { key: 'chubu', ja: '中部', latin: 'CHUBU', order: 40 },
  { key: 'kansai', ja: '関西', latin: 'KANSAI', order: 50 },
  { key: 'chugoku', ja: '中国', latin: 'CHUGOKU', order: 60 },
  { key: 'shikoku', ja: '四国', latin: 'SHIKOKU', order: 70 },
  { key: 'kyushu', ja: '九州', latin: 'KYUSHU', order: 80 },
  { key: 'okinawa', ja: '沖縄', latin: 'OKINAWA', order: 90 },
  { key: 'australia', ja: 'オーストラリア', latin: 'AUSTRALIA', order: 100 },
  { key: 'malaysia', ja: 'マレーシア', latin: 'MALAYSIA', order: 110 },
  { key: 'other', ja: 'その他', latin: 'OTHERS', order: 900 },
  { key: 'hq', ja: '本部', latin: 'HEADQUARTERS', order: 1000 },
]);

const BY_KEY = Object.fromEntries(REGIONS.map(r => [r.key, r]));
export function regionMeta(key) { return BY_KEY[key] || BY_KEY.other; }

// lib/geo.js の地域名 → ここでのキー（「近畿」は画面では「関西」と呼ぶ）
const FROM_JA = Object.freeze({
  '北海道': 'hokkaido', '東北': 'tohoku', '関東': 'kanto', '中部': 'chubu',
  '近畿': 'kansai', '関西': 'kansai', '中国': 'chugoku', '四国': 'shikoku',
  '九州': 'kyushu', '沖縄': 'okinawa',
});

// 海外の国を店舗名から見分ける（lib/geo.js は海外をひとまとめにしているため、ここで分ける）
const AU = /(オーストラリア|Australia|シドニー|Sydney|メルボルン|Melbourne|パース|Perth|ブリスベン|Brisbane|ゴールドコースト|Gold\s?Coast|アデレード|Adelaide|ケアンズ|Cairns)/i;
const MY = /(マレーシア|Malaysia|クアラルンプール|Kuala\s?Lumpur|KLCC|KL|ペナン|Penang|ジョホール|Johor|モントキアラ|Mont\s?Kiara|Sunway|Bangsar|Damansara|Cheras|Petaling|Velocity)/i;

/**
 * 店舗が属する地域のキーを返す。
 *   rank … lib/geo.js の shopGeoRank
 * ⚠️ 海外でも国が分からなければ 'other'（勝手にどちらかの国へ入れない）。
 */
export function regionKeyOf(rank, shopName) {
  const name = String(shopName == null ? '' : shopName);
  const ja = regionOf(rank);
  if (ja === '海外') {
    if (AU.test(name)) return 'australia';
    if (MY.test(name)) return 'malaysia';
    return 'other';
  }
  return FROM_JA[ja] || 'other';
}

/**
 * 地域ごとにまとめる。
 *   shops: [{ id, name, rank }]
 * ⚠️ 店舗が1つも無い地域は**出さない**（空の見出しを並べない）。
 */
export function groupByRegion(shops) {
  const bucket = new Map();
  for (const s of (Array.isArray(shops) ? shops : [])) {
    if (!s || !s.id) continue;
    const key = regionKeyOf(s.rank, s.name);
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key).push(s);
  }
  return [...bucket.entries()]
    .map(([key, list]) => ({
      key, ...regionMeta(key),
      shops: list.slice().sort((a, b) => {
        const ra = Number(a.rank) || 0, rb = Number(b.rank) || 0;
        return ra !== rb ? ra - rb : String(a.name).localeCompare(String(b.name), 'ja');
      }),
    }))
    .sort((a, b) => a.order - b.order);
}

// ── 飾りの地図（簡略化したかたち）────────────────────────────────
// ⚠️ **正確な地図ではありません。** おおよその輪郭だけを表した飾りです。
//    viewBox は 0 0 100 100。どの地域も同じ大きさの枠に収まるようにしています。
// 地域のシルエット。⚠️ **簡略化した飾り**で、位置や距離を正確に示すものではない。
// 出典: Natural Earth（パブリックドメイン）。scripts/build-org-map.mjs が作る。
export { MAP_PATHS } from './org-map-paths.js';
import { MAP_PATHS as PATHS } from './org-map-paths.js';

export function mapPathOf(key) { return PATHS[key] || PATHS.other; }

/** 画面に必ず出す注記。地図を根拠にしないための断り書き。 */
export const MAP_NOTE = '地図は簡略化した飾りです（出典: Natural Earth／パブリックドメイン）。位置や距離を正確に示すものではありません。';

/** 店舗数が多い地域は、はじめは閉じておく（画面が長くなりすぎないように）。 */
export const COLLAPSE_OVER = 12;
export function defaultOpen(group, opts = {}) {
  if (opts.searching) return true;                 // 検索中はすべて開く
  return (group && Array.isArray(group.shops) ? group.shops.length : 0) <= COLLAPSE_OVER;
}
