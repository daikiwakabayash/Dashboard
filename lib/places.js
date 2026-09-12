/**
 * lib/places.js — Google Places API (New) 連携ロジック（純粋関数・テスト対象）
 *
 * 用途: AIパトロールが「店舗のGoogleマップ情報（口コミ件数・評価・住所）」を取得し、
 *       口コミ不足の検知や、Googleマップ/HP/ホットペッパー間の住所一致チェックに使う。
 *
 * 方針:
 *  - APIキー（GOOGLE_PLACES_API_KEY）はサーバー側（api/plan-store.js の ?type=patrol）に隠す。
 *    このモジュールは「リクエストの組み立て」「レスポンスの解釈」「住所の正規化・照合」のみを担う（fetchはしない）。
 *  - Places API (New) の Text Search を使用（v1/places:searchText）。FieldMask で必要項目だけ取得しコストを抑える。
 */

// Places API (New) Text Search エンドポイント
export const PLACES_TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

// 取得フィールド（FieldMask）: 必要最小限に絞ってコスト・レスポンスを軽くする（パトロールの住所/口コミ判定用）
export const PLACES_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.rating',
  'places.userRatingCount',
  'places.businessStatus',
  'places.googleMapsUri',
].join(',');

// MEO詳細用（口コミ本文・営業時間・HP・電話・写真枚数・カテゴリまで取得）。コストは上がるためMEOスキャン時のみ。
export const PLACES_DETAIL_FIELD_MASK = [
  ...PLACES_FIELD_MASK.split(','),
  'places.reviews',
  'places.regularOpeningHours',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.photos',
  'places.primaryTypeDisplayName',
].join(',');

/**
 * Text Search リクエストを組み立てる（サーバー側で fetch する材料）。
 * @param {string} query 検索クエリ（例: "NAORU整体 恵比寿院"）
 * @param {object} [opts] { languageCode='ja', regionCode='JP', detailed=false }
 *   detailed=true で口コミ本文・営業時間・HP・電話・写真までのフィールドを要求（MEO用）。
 * @returns {{url,fieldMask,body,method,headers}|null}
 */
export function buildSearchRequest(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return null;
  const languageCode = opts.languageCode || 'ja';
  const regionCode = opts.regionCode || 'JP';
  return {
    url: PLACES_TEXT_SEARCH_URL,
    method: 'POST',
    fieldMask: opts.detailed ? PLACES_DETAIL_FIELD_MASK : PLACES_FIELD_MASK,
    // Content-Type / X-Goog-Api-Key / X-Goog-FieldMask はサーバー側で付与する
    body: { textQuery: q, languageCode, regionCode, pageSize: 3 },
  };
}

/**
 * Text Search のレスポンスから先頭の店舗を取り出して整形する。
 * detailed 要求時は reviews/openingHours/website/phone/photoCount/primaryType も含める（無ければ既定値）。
 * @param {object} json Places API のレスポンス
 * @returns {{placeId,name,address,rating,userRatingCount,businessStatus,mapsUri,...}|null}
 */
export function parsePlacesResponse(json) {
  const places = json && Array.isArray(json.places) ? json.places : [];
  if (!places.length) return null;
  const p = places[0] || {};
  const name = (p.displayName && (p.displayName.text || p.displayName)) || '';
  const out = {
    placeId: String(p.id || ''),
    name: String(name || ''),
    address: String(p.formattedAddress || ''),
    rating: typeof p.rating === 'number' ? p.rating : null,
    userRatingCount: typeof p.userRatingCount === 'number' ? p.userRatingCount : 0,
    businessStatus: String(p.businessStatus || ''),
    mapsUri: String(p.googleMapsUri || ''),
  };
  // ── 詳細フィールド（MEO用・存在時のみ）──
  if ('websiteUri' in p) out.websiteUri = String(p.websiteUri || '');
  if ('nationalPhoneNumber' in p) out.phone = String(p.nationalPhoneNumber || '');
  if ('regularOpeningHours' in p) out.hasHours = !!(p.regularOpeningHours && Array.isArray(p.regularOpeningHours.periods) && p.regularOpeningHours.periods.length);
  if ('photos' in p) out.photoCount = Array.isArray(p.photos) ? p.photos.length : 0;
  if (p.primaryTypeDisplayName) out.primaryType = String(p.primaryTypeDisplayName.text || p.primaryTypeDisplayName || '');
  if (Array.isArray(p.reviews)) {
    out.reviews = p.reviews.slice(0, 5).map(r => ({
      rating: typeof r.rating === 'number' ? r.rating : null,
      text: String((r.text && (r.text.text || r.text)) || (r.originalText && (r.originalText.text || r.originalText)) || ''),
      author: String((r.authorAttribution && r.authorAttribution.displayName) || ''),
      when: String(r.relativePublishTimeDescription || ''),
      publishTime: String(r.publishTime || ''),
    }));
  }
  return out;
}

// ── 旧 Places API（Place Details）で「新着順」の口コミを取得 ──
//   Places API(New) は口コミを最大5件・関連度順でしか返さないため「今月の新規口コミ」を掴めない。
//   旧API(Place Details) は reviews_sort=newest で「新着5件」を返せるので、今月分のカウントに使う（キーが旧API有効時のみ）。
export const PLACES_LEGACY_DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';

// 旧APIの Place Details（新着口コミ）リクエストURLを組み立てる（keyはサーバー側で付与）。
export function buildLegacyReviewsRequest(placeId, opts = {}) {
  const id = String(placeId || '').trim();
  if (!id) return null;
  const language = opts.language || 'ja';
  const sort = opts.sort || 'newest';
  const p = new URLSearchParams({ place_id: id, fields: 'reviews', reviews_sort: sort, reviews_no_translations: 'true', language });
  return { url: `${PLACES_LEGACY_DETAILS_URL}?${p.toString()}`, method: 'GET' };
}

// 旧API Place Details のレスポンスから口コミ配列を整形（New API の reviews と同じ形に揃える）。
//   status!=OK（REQUEST_DENIED＝旧API未有効 等）は空配列を返す（呼び出し側でフォールバック）。
export function parseLegacyReviews(json) {
  if (!json || json.status !== 'OK') return [];
  const revs = (json.result && Array.isArray(json.result.reviews)) ? json.result.reviews : [];
  return revs.slice(0, 5).map(r => ({
    rating: typeof r.rating === 'number' ? r.rating : null,
    text: String(r.text || ''),
    author: String(r.author_name || ''),
    when: String(r.relative_time_description || ''),
    // 旧APIは time=UNIX秒。New APIと同じ publishTime(ISO) に変換して月判定に使う。
    publishTime: (typeof r.time === 'number' && r.time > 0) ? new Date(r.time * 1000).toISOString() : '',
  }));
}

// 口コミ投稿の依頼URL（placeId から。スタッフ/患者に配布して口コミを増やす）
export function reviewRequestUrl(placeId) {
  const id = String(placeId || '').trim();
  return id ? `https://search.google.com/local/writereview?placeid=${encodeURIComponent(id)}` : '';
}

// 全角英数字・記号 → 半角
function toHalf(s) {
  return String(s || '').replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');
}

// 漢数字 → アラビア数字（住所の丁目・番地に現れる 1〜99 程度を想定した簡易変換）
const KANJI_DIGIT = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function kanjiNumToArabic(s) {
  return String(s || '').replace(/[〇一二三四五六七八九十]+/g, (seg) => {
    // 「十」を含む複合（十二=12, 二十=20, 二十三=23）と単純列（一二三→123ではなく、住所は普通"十"表記なので複合優先）
    if (seg.indexOf('十') >= 0) {
      let total = 0;
      const parts = seg.split('十');
      const tens = parts[0] === '' ? 1 : (KANJI_DIGIT[parts[0]] ?? 0);
      const ones = parts[1] === '' || parts[1] == null ? 0 : (KANJI_DIGIT[parts[1]] ?? 0);
      total = tens * 10 + ones;
      return String(total);
    }
    // 十を含まない場合は各桁を連結（丁目などで一桁が多い）
    let out = '';
    for (const ch of seg) out += String(KANJI_DIGIT[ch] ?? '');
    return out;
  });
}

/**
 * 住所を照合用に正規化する。
 *  - 郵便番号（〒123-4567 / 123-4567）を除去
 *  - 全角→半角、漢数字→算用数字
 *  - 丁目/番地/番/号/ハイフン/中黒/空白 を統一区切り「-」に寄せて除去し、数字の並びで比較できるようにする
 * @param {string} addr
 * @returns {string} 正規化済み文字列
 */
export function normalizeAddress(addr) {
  let s = toHalf(addr);
  s = s.replace(/〒?\s*\d{3}-?\d{4}/g, ''); // 郵便番号
  s = s.replace(/日本[、,\s]*/g, '');       // 「日本」プレフィックス（Places の formattedAddress に付くことがある）
  s = kanjiNumToArabic(s);
  s = s.toLowerCase();
  // 丁目・番地・番・号・ハイフン各種・中黒・空白 → 単一の "-"
  s = s.replace(/丁目|丁|番地|番|号/g, '-');
  s = s.replace(/[‐‑‒–—―ー−\-・\s]+/g, '-');
  s = s.replace(/-+/g, '-').replace(/^-|-$/g, '');
  s = s.replace(/[,、]/g, '');
  return s.trim();
}

/**
 * 2つの住所が実質同一かを判定する。
 * 「都道府県〜番地の数字列」がすべて一致すれば match とみなす（ビル名・建物名の差は許容）。
 * @returns {{match:boolean, score:number, a:string, b:string}}
 */
export function addressMatch(a, b) {
  const na = normalizeAddress(a);
  const nb = normalizeAddress(b);
  if (!na || !nb) return { match: false, score: 0, a: na, b: nb };
  // 住所番号（丁目-番-号）＝最初の数字ハイフン連続を抽出して厳密比較（末尾のビル階数などは無視）
  const nums = (s) => (s.match(/\d+(?:-\d+)*/) || [''])[0];
  const da = nums(na), db = nums(nb);
  const numMatch = !!da && da === db;
  // 文字（数字以外）の重なりで町名などの一致度をざっくり測る
  const stripNum = (s) => s.replace(/[\d-]/g, '');
  const ca = stripNum(na), cb = stripNum(nb);
  const shorter = ca.length <= cb.length ? ca : cb;
  const longer = ca.length <= cb.length ? cb : ca;
  let overlap = 0;
  for (let i = 0; i < shorter.length - 1; i++) { if (longer.indexOf(shorter.substr(i, 2)) >= 0) overlap++; }
  const textScore = shorter.length > 1 ? overlap / (shorter.length - 1) : (ca === cb ? 1 : 0);
  const match = numMatch && textScore >= 0.6;
  return { match, score: Math.round((numMatch ? 0.5 : 0) * 100 + textScore * 50) / 100, a: na, b: nb };
}
