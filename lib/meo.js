// ── MEO（Googleマップ最適化）ロジック ─────────────────────────────
// 各店のGoogleマップ「口コミ数・評価」の履歴を保存し、増減トレンド／要対応アラートを算出する。
// Places API から取得した値（lib/places.js parsePlacesResponse）を入力に、純粋関数だけで判定する。
// 保存は api/plan-store.js（?type=meo）、表示は index.html。tests/meo.test.js でカバー。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// now → JSTの 'YYYY-MM-DD'
export function jstYmd(now = new Date()) {
  const t = (now instanceof Date) ? now.getTime() : Number(now);
  const j = new Date(t + JST_OFFSET_MS);
  return `${j.getUTCFullYear()}-${String(j.getUTCMonth() + 1).padStart(2, '0')}-${String(j.getUTCDate()).padStart(2, '0')}`;
}

export const MEO_THRESHOLDS = {
  reviewCountLow: 20,  // 口コミ これ未満で獲得強化
  ratingWarn: 4.0,     // 平均評価 これ未満で警告
  photosLow: 10,       // 写真 これ未満で追加を促す
  lowStar: 2,          // 直近レビューで これ以下の星は「低評価」
};

// スナップショットを履歴に記録（同日は上書き・日付昇順・上限400）。snap={date,count,rating}
export function recordSnapshot(history, snap) {
  const list = Array.isArray(history) ? history.slice() : [];
  const date = String(snap.date || jstYmd());
  const rec = { date, count: Number(snap.count) || 0, rating: (snap.rating == null ? null : Number(snap.rating)) };
  const next = list.filter(h => h && h.date !== date);
  next.push(rec);
  next.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return next.slice(-400);
}

// 増減を算出。前回スナップショット比＋当月頭比（今月の新規口コミ数）＋約30日前比。
export function computeDeltas(history, now = new Date()) {
  const list = (Array.isArray(history) ? history : []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!list.length) return { count: 0, rating: null, deltaPrev: null, newThisMonth: null, delta30: null, lastDate: '', hasHistory: false };
  const last = list[list.length - 1];
  const prev = list.length >= 2 ? list[list.length - 2] : null;
  const ym = jstYmd(now).slice(0, 7);
  // 今月の新規口コミ数 = 「今月開始前の最後のスナップショット（先月末など）」から現在までの増加。
  //   その基準が無い場合は「今月最初のスナップショット」から現在まで。どちらも当該スナップショットが現在と同一（＝計測基準が1点だけ）なら null（まだ計測不能）。
  const beforeMonth = list.filter(h => String(h.date).slice(0, 7) < ym);
  const baseline = beforeMonth.length ? beforeMonth[beforeMonth.length - 1] : null;
  const firstThisMonth = list.find(h => String(h.date).slice(0, 7) === ym);
  let newThisMonth = null;
  if (firstThisMonth && firstThisMonth !== last) newThisMonth = last.count - firstThisMonth.count; // 今月の2点目以降＝月初基準からの増加
  else if (baseline) newThisMonth = last.count - baseline.count;                                    // 今月まだ1点だが先月末の基準がある
  // 約30日前に最も近いスナップショット
  const target = new Date((now instanceof Date ? now.getTime() : Number(now)) - 30 * 24 * 3600 * 1000);
  const targetYmd = jstYmd(target);
  let s30 = null; for (const h of list) { if (String(h.date) <= targetYmd) s30 = h; }
  // 削除検知: 今月の基準（baseline or 今月最初）以降のピーク値と現在値を比較。
  //   Google は口コミを勝手に消すことがあるため、「ピークから減った分」を削除の観測値とする。
  //   純増(net)=増えた−消えた。増えた分(推定)=net＋削除観測。減った分(推定)=削除観測。
  const baseCount = baseline ? baseline.count : (firstThisMonth ? firstThisMonth.count : (last ? last.count : 0));
  const inWindow = list.filter(h => String(h.date) >= String((baseline || firstThisMonth || last || {}).date || ''));
  const peak = inWindow.length ? Math.max(...inWindow.map(h => h.count)) : last.count;
  const deletedThisMonth = (newThisMonth == null) ? null : Math.max(0, peak - last.count);
  const addedThisMonth = (newThisMonth == null) ? null : (newThisMonth + (deletedThisMonth || 0));
  return {
    count: last.count,                                               // 現在の合計
    rating: last.rating,
    lastDate: last.date,
    deltaPrev: prev ? last.count - prev.count : null,                 // 前回スキャン比
    ratingDeltaPrev: (prev && prev.rating != null && last.rating != null) ? Math.round((last.rating - prev.rating) * 10) / 10 : null,
    newThisMonth,                                                     // 今月の純増（net＝増−減。計測不能時は null）
    addedThisMonth,                                                   // 今月 増えた分（推定＝純増＋削除観測）
    deletedThisMonth,                                                 // 今月 減った分（推定＝ピークからの減少＝Google削除）
    baseCount,                                                        // 今月開始時点の合計
    delta30: s30 ? last.count - s30.count : null,                     // 約30日前比
    hasHistory: list.length >= 2,
    baseMonthDate: (baseline || firstThisMonth || last || {}).date || '',
  };
}

// 要対応アラート（要素の配列 {level:'warn'|'info'|'good', code, title}）。latest=parsePlacesResponse相当。
export function meoFlags(latest = {}, deltas = {}, th = MEO_THRESHOLDS) {
  const items = [];
  const push = (level, code, title) => items.push({ level, code, title });
  const cnt = Number(latest.userRatingCount) || 0;
  const rating = latest.rating;
  if (cnt < th.reviewCountLow) push('warn', 'reviews_low', `口コミが少ない（${cnt}件・${th.reviewCountLow}件未満）`);
  if (rating != null && rating < th.ratingWarn) push('warn', 'rating_low', `平均評価が低い（★${rating}）`);
  if (deltas && deltas.hasHistory && deltas.newThisMonth === 0) push('warn', 'no_new_reviews', '今月の新規口コミが0件');
  if (deltas && typeof deltas.newThisMonth === 'number' && deltas.newThisMonth > 0) push('good', 'reviews_up', `今月 +${deltas.newThisMonth}件の新規口コミ`);
  // 直近レビューに低評価
  const lowRecent = (Array.isArray(latest.reviews) ? latest.reviews : []).filter(r => r && typeof r.rating === 'number' && r.rating <= th.lowStar);
  if (lowRecent.length) push('warn', 'low_star_recent', `直近に★${th.lowStar}以下の口コミ ${lowRecent.length}件（要返信）`);
  // プロフィール整備
  if ('websiteUri' in latest && !latest.websiteUri) push('info', 'no_website', 'HP/予約リンクが未設定');
  if ('phone' in latest && !latest.phone) push('info', 'no_phone', '電話番号が未設定');
  if ('hasHours' in latest && !latest.hasHours) push('info', 'no_hours', '営業時間が未設定');
  if ('photoCount' in latest && Number(latest.photoCount) < th.photosLow) push('info', 'photos_low', `写真が少ない（${Number(latest.photoCount) || 0}枚・${th.photosLow}枚未満）`);
  return items;
}

// 0〜100のMEOスコア（口コミ数40＋評価30＋プロフィール整備30）。ざっくり健全度の把握用。
export function meoScore(latest = {}, th = MEO_THRESHOLDS) {
  const cnt = Number(latest.userRatingCount) || 0;
  const rating = latest.rating;
  let s = 0;
  s += Math.min(40, Math.round((cnt / 50) * 40));                 // 口コミ50件で満点
  s += rating != null ? Math.round(Math.max(0, (rating - 3) / 2) * 30) : 0; // ★3→0, ★5→30
  let prof = 0, keys = 0;
  if ('websiteUri' in latest) { keys++; if (latest.websiteUri) prof++; }
  if ('phone' in latest) { keys++; if (latest.phone) prof++; }
  if ('hasHours' in latest) { keys++; if (latest.hasHours) prof++; }
  if ('photoCount' in latest) { keys++; if (Number(latest.photoCount) >= th.photosLow) prof++; }
  s += keys ? Math.round((prof / keys) * 30) : 0;
  return Math.max(0, Math.min(100, s));
}

// アラートの重大度合計（要対応店の並べ替え用）。warn=2, info=1。
export function alertWeight(items) {
  return (Array.isArray(items) ? items : []).reduce((a, it) => a + (it.level === 'warn' ? 2 : it.level === 'info' ? 1 : 0), 0);
}
