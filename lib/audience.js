// ── 送信先の絞り込み（エリア・店舗・未読）────────────────────────────────
// 「神奈川のエリアに送る」「大阪以外に送る」「まだ既読がついていない人にもう一度送る」を
// 既にあるデータだけで組み立てる。新しい個人情報は増やさない。
//   - 所属店舗    : chat の dir.staff = [{id,name,shop}]
//   - 店舗→都道府県: lib/geo.js（店舗名の地名キーワードから推定。SalonOneに都道府県が無いため）
//   - 既読        : chat の reads = { staffId: { roomId: 最後に読んだ時刻(ms) } }
// 保存は増やさず、送信そのものは既存のルーム作成＋メッセージ送信をそのまま使う。
// tests/audience.test.js でカバー。
//
// ⚠️ 店舗名からの推定なので、地名を含まない店舗名は「その他」に入る。
//    画面では必ず**対象者の氏名を出してから送る**こと（黙って外れた人が出ないように）。

import { shopGeoRank, regionOf } from './geo.js';

// prefRank（1=北海道 … 47=沖縄）→ 都道府県名。950=国内その他 / 1000=海外。
export const PREF_NAMES = {
  1: '北海道', 2: '青森県', 3: '岩手県', 4: '宮城県', 5: '秋田県', 6: '山形県', 7: '福島県',
  8: '茨城県', 9: '栃木県', 10: '群馬県', 11: '埼玉県', 12: '千葉県', 13: '東京都', 14: '神奈川県',
  15: '新潟県', 16: '富山県', 17: '石川県', 18: '福井県', 19: '山梨県', 20: '長野県', 21: '岐阜県',
  22: '静岡県', 23: '愛知県', 24: '三重県', 25: '滋賀県', 26: '京都府', 27: '大阪府', 28: '兵庫県',
  29: '奈良県', 30: '和歌山県', 31: '鳥取県', 32: '島根県', 33: '岡山県', 34: '広島県', 35: '山口県',
  36: '徳島県', 37: '香川県', 38: '愛媛県', 39: '高知県', 40: '福岡県', 41: '佐賀県', 42: '長崎県',
  43: '熊本県', 44: '大分県', 45: '宮崎県', 46: '鹿児島県', 47: '沖縄県',
  950: 'エリア未設定', 1000: '海外',
};

// 店舗名 → { rank, pref, region }
export function areaOf(shopName) {
  const rank = shopGeoRank(shopName);
  return { rank, pref: PREF_NAMES[rank] || 'エリア未設定', region: regionOf(rank) };
}

const arr = (v) => (Array.isArray(v) ? v : []);
const sid = (v) => String((v && v.id) != null ? v.id : '');

// 条件（filter）の形:
//   { prefs:['神奈川県'], regions:['関東'], shops:['NAORU 関内院'], exclude:false }
//   exclude=true なら「その条件**以外**の人」（例: 大阪以外に送る）
// 条件が何も選ばれていないときは「全員」。
export function isEmptyFilter(filter) {
  const f = filter || {};
  return !arr(f.prefs).length && !arr(f.regions).length && !arr(f.shops).length;
}

// 1人がその条件に当てはまるか（exclude は見ない＝素の一致判定）
export function matchesFilter(person, filter) {
  const f = filter || {};
  if (isEmptyFilter(f)) return true;
  const shop = String((person && person.shop) || '');
  const a = areaOf(shop);
  if (arr(f.prefs).some(p => String(p) === a.pref)) return true;
  if (arr(f.regions).some(r => String(r) === a.region)) return true;
  // 店舗は表記ゆれ（「NAORU 関内院」/「関内院」）があるので、双方向の部分一致で見る
  if (arr(f.shops).some(s => { const t = String(s); return t && shop && (shop.includes(t) || t.includes(shop)); })) return true;
  return false;
}

// 条件 → 送る相手。並び順は北→南、同じ県内は氏名順（画面でそのまま出せる形）。
export function selectAudience(staff, filter) {
  const f = filter || {};
  const empty = isEmptyFilter(f);
  const hit = arr(staff).filter(p => {
    if (!p || !sid(p)) return false;
    const m = matchesFilter(p, f);
    // 条件なしのときは exclude を効かせない（「全員以外」＝0人、は事故のもと）
    return empty ? true : (f.exclude ? !m : m);
  });
  return hit.slice().sort((a, b) => {
    const ra = shopGeoRank(a.shop), rb = shopGeoRank(b.shop);
    if (ra !== rb) return ra - rb;
    return String(a.name || '').localeCompare(String(b.name || ''), 'ja');
  });
}

// 選べる条件を人数つきで作る（画面のチェックボックス用）。0人の選択肢は出さない。
export function audienceOptions(staff) {
  const prefs = new Map(), regions = new Map(), shops = new Map();
  for (const p of arr(staff)) {
    if (!p || !sid(p)) continue;
    const shop = String(p.shop || '');
    const a = areaOf(shop);
    prefs.set(a.pref, { key: a.pref, label: a.pref, rank: a.rank, count: (prefs.get(a.pref)?.count || 0) + 1 });
    regions.set(a.region, { key: a.region, label: a.region, rank: a.rank, count: (regions.get(a.region)?.count || 0) + 1 });
    if (shop) shops.set(shop, { key: shop, label: shop, rank: a.rank, count: (shops.get(shop)?.count || 0) + 1 });
  }
  const byRank = (m) => [...m.values()].sort((x, y) => (x.rank - y.rank) || String(x.label).localeCompare(String(y.label), 'ja'));
  return { prefs: byRank(prefs), regions: byRank(regions), shops: byRank(shops) };
}

// 画面とルーム名に出す説明文。「誰に送るのか」が一目で分かる言葉にする。
export function audienceLabel(filter) {
  const f = filter || {};
  if (isEmptyFilter(f)) return '全員';
  const parts = [...arr(f.regions).map(String), ...arr(f.prefs).map(String), ...arr(f.shops).map(String)];
  const head = parts.slice(0, 3).join('・') + (parts.length > 3 ? `ほか${parts.length - 3}件` : '');
  return f.exclude ? `${head} 以外` : head;
}

// 同じ条件は同じルームに送る（送るたびにルームが増えないように）。
// 条件を並べ替えて詰めた決定的なID。長くなりすぎないよう簡単なハッシュで畳む。
export function audienceRoomId(filter) {
  const f = filter || {};
  if (isEmptyFilter(f)) return 'announce_all';
  const key = [
    'r:' + arr(f.regions).map(String).sort().join(','),
    'p:' + arr(f.prefs).map(String).sort().join(','),
    's:' + arr(f.shops).map(String).sort().join(','),
    'x:' + (f.exclude ? '1' : '0'),
  ].join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return `aud_${h.toString(36)}`;
}

// ── 未読の人 ───────────────────────────────────────────────────────────
// 「この投稿をまだ読んでいない人」＝ reads[staffId][roomId] がその投稿より前（または無い）。
//   people   : 対象にする人 [{id,name,shop}]（ルームのメンバー、announce なら全員）
//   reads    : { staffId: { roomId: ms } }
//   sinceMs  : 対象の投稿時刻（この時刻より後に読んでいれば既読）
//   excludeIds: 送った本人など、最初から外す人
export function unreadStaff(people, reads, roomId, sinceMs, excludeIds) {
  const rid = String(roomId || '');
  const since = Number(sinceMs) || 0;
  const skip = new Set(arr(excludeIds).map(String));
  const r = (reads && typeof reads === 'object') ? reads : {};
  return arr(people).filter(p => {
    const id = sid(p);
    if (!id || skip.has(id)) return false;
    const last = Number((r[id] || {})[rid]) || 0;
    return last < since;
  });
}

// 既読の状況をひとことで（画面の「◯名中◯名が未読」用）
export function readSummary(people, reads, roomId, sinceMs, excludeIds) {
  const target = arr(people).filter(p => sid(p) && !new Set(arr(excludeIds).map(String)).has(sid(p)));
  const unread = unreadStaff(target, reads, roomId, sinceMs, excludeIds);
  return { total: target.length, unread: unread.length, read: target.length - unread.length, unreadPeople: unread };
}
