// ── ニュース: 記事の項目（カテゴリー・公開対象・確認要否・期限・ピックアップ・表紙）──
//
// ⚠️ 設計方針
//   - **既存の投稿を壊さない。** 項目が無い古い投稿も、そのまま一覧・詳細に出る。
//     新しい項目は「未設定」として扱い、勝手に既定値を書き込まない。
//   - 公開対象（誰に向けた記事か）は、状況一覧の**分母**にもなる。
//     いまは「全員」と「店舗を指定」の2つだけ。曖昧な指定を作らない。
//   - 期限は「いつまでに確認してほしいか」。過ぎても記事は消さない（期限切れと出すだけ）。
//   - 表紙の写真は、既にある添付画像の中から選ぶ。別枠でアップロードしない。
//
// tests/news-post.test.js でカバー。

const str = (v) => String(v == null ? '' : v);
const arr = (v) => (Array.isArray(v) ? v : []);

// カテゴリー。画面の並び順どおり。'' は未設定（古い投稿）。
export const CATEGORIES = [
  { key: 'notice', label: 'お知らせ', color: 'slate' },
  { key: 'event', label: 'イベント', color: 'red' },
  { key: 'rule', label: 'ルール・手順', color: 'indigo' },
  { key: 'study', label: '勉強会・教育', color: 'teal' },
  { key: 'case', label: '症例・事例', color: 'amber' },
  { key: 'praise', label: '表彰・お祝い', color: 'pink' },
];
export const CATEGORY_KEYS = CATEGORIES.map(c => c.key);
export function categoryLabel(key) {
  const c = CATEGORIES.find(x => x.key === str(key));
  return c ? c.label : '';
}

/** 公開対象。'all'（全員）か、店舗を指定。 */
export function normalizeAudience(a) {
  const src = (a && typeof a === 'object') ? a : {};
  const shops = [...new Set(arr(src.shops).map(s => str(s).slice(0, 80)).filter(Boolean))].slice(0, 100);
  // ⚠️ 「店舗指定なのに店舗が空」は全員送信になってしまうので、all に倒さず shops:[] のまま返し、
  //    canPublish で止める。黙って全員に広げない。
  return { kind: src.kind === 'shops' ? 'shops' : 'all', shops };
}

/** 期限（YYYY-MM-DD）。形式が違えば空。 */
export function normalizeDue(v) {
  const d = str(v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
}

/** 記事の新しい項目だけを整える。⚠️ 既存項目（title/text/imgIds…）には触れない。 */
export function normalizeMeta(p) {
  const src = (p && typeof p === 'object') ? p : {};
  const category = CATEGORY_KEYS.includes(str(src.category)) ? str(src.category) : '';
  return {
    category,
    audience: normalizeAudience(src.audience),
    needsAck: !!src.needsAck,                 // 「確認しました」を求めるか
    dueDate: normalizeDue(src.dueDate),       // いつまでに確認してほしいか
    featured: !!src.featured,                 // ピックアップ
    // 表紙は添付画像のどれか。添付に無いIDは採用しない（存在しない画像を表紙にしない）
    coverImgId: (() => {
      const id = str(src.coverImgId).slice(0, 64);
      if (!id) return '';
      const ids = arr(src.imgIds).map(String);
      return ids.includes(id) ? id : '';
    })(),
  };
}

/**
 * 投稿してよいか。⚠️ 曖昧な宛先のまま出させない。
 * 返り値 { ok } / { ok:false, reason }
 */
export function canPublish(p) {
  const src = (p && typeof p === 'object') ? p : {};
  const hasBody = !!str(src.text).trim() || !!str(src.title).trim()
    || arr(src.imgIds).length || arr(src.files).length || str(src.videoUrl) || str(src.link);
  if (!hasBody) return { ok: false, reason: 'empty' };
  const a = normalizeAudience(src.audience);
  if (a.kind === 'shops' && !a.shops.length) return { ok: false, reason: 'no_shops' };
  if (src.needsAck && !normalizeDue(src.dueDate)) return { ok: false, reason: 'no_due' };
  return { ok: true };
}

/** この記事は自分に向けられているか（公開対象の判定）。対象外なら一覧に出さない。 */
export function isForMe(post, me) {
  const a = normalizeAudience(post && post.audience);
  if (a.kind === 'all') return true;
  const shops = [...arr(me && me.shops).map(String), str(me && me.shop)].filter(Boolean);
  if (!shops.length) return false;
  return a.shops.some(t => shops.some(s => s.includes(t) || t.includes(s)));
}

/** 状況一覧の分母。公開対象に合う人だけにする。 */
export function audienceFor(post, people) {
  const a = normalizeAudience(post && post.audience);
  if (a.kind === 'all') return arr(people);
  return arr(people).filter(p => {
    const shops = [...arr(p && p.shops).map(String), str(p && p.shop)].filter(Boolean);
    return shops.some(s => a.shops.some(t => s.includes(t) || t.includes(s)));
  });
}

/** 期限の状態。'none' / 'ok' / 'soon'（3日以内） / 'over'（過ぎた） */
export function dueState(post, now = new Date()) {
  const d = normalizeDue(post && post.dueDate);
  if (!d) return 'none';
  const end = Date.parse(`${d}T23:59:59+09:00`);
  if (!Number.isFinite(end)) return 'none';
  const t = (now instanceof Date ? now : new Date(now)).getTime();
  if (t > end) return 'over';
  return (end - t) <= 3 * 24 * 3600 * 1000 ? 'soon' : 'ok';
}

/** 表紙にする画像。未設定なら1枚目。画像が無ければ空（代替表紙は画面側で出す）。 */
export function coverOf(post) {
  const p = (post && typeof post === 'object') ? post : {};
  const ids = arr(p.imgIds).map(String).filter(Boolean);
  const c = str(p.coverImgId);
  if (c && ids.includes(c)) return c;
  return ids[0] || '';
}

/**
 * 一覧の絞り込み。
 *   filter = { category, q, featuredOnly, unreadOnly }
 *   isUnread(post) … 未読かどうか（呼び出し側の判定を渡す）
 */
export function filterPosts(posts, filter, isUnread) {
  const f = (filter && typeof filter === 'object') ? filter : {};
  const q = str(f.q).normalize('NFKC').toLowerCase().trim();
  const unread = typeof isUnread === 'function' ? isUnread : () => false;
  return arr(posts).filter(p => {
    if (!p) return false;
    if (f.category && str(p.category) !== str(f.category)) return false;
    if (f.featuredOnly && !p.featured) return false;
    if (f.unreadOnly && !unread(p)) return false;
    if (q) {
      const hay = [p.title, p.text, p.authorName, categoryLabel(p.category)]
        .map(x => str(x).normalize('NFKC').toLowerCase()).join(' ');
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** 年月ごとにまとめる（過去記事の表示用）。新しい順。 */
export function groupByMonth(posts) {
  const map = new Map();
  for (const p of arr(posts)) {
    const t = Date.parse(str(p && p.createdAt)) || 0;
    if (!t) continue;
    const d = new Date(t + 9 * 3600 * 1000);          // JST
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  }
  return [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, list]) => ({
      month,
      label: `${month.slice(0, 4)}年${Number(month.slice(5))}月`,
      count: list.length,
      posts: list,
    }));
}

// ── 一覧カードの表紙 ──────────────────────────────────────────────
// ⚠️ 写真が無い記事でも、一覧が味気なくならないようにする。
//    生成画像や実在しない写真は使わない。**文字だけの表紙**にする。
//    色と言葉はカテゴリーから決める（記事ごとに勝手に変えない＝見分けがつく）。
export const COVER_TONES = Object.freeze(['dark', 'red', 'grey', 'indigo', 'teal', 'amber', 'pink']);
// journal … ピックアップ（大きい1件）で使う肩書き
// caption … ピックアップの下に出す短い言葉。⚠️ **カテゴリーごとに固定**。記事の中身を要約しない
//            （AIが勝手に言葉を作って、書いていないことを言わないようにする）
const COVER_BY_CAT = Object.freeze({
  notice: { kicker: 'NOWL / BRIEFING', journal: 'NOWL / HQ BRIEFING', line1: 'HQ', line2: 'BRIEFING.',
            caption: '決まったことを、まっすぐに。', tone: 'grey' },
  event: { kicker: 'NOWL / EVENT', journal: 'NOWL / EVENT JOURNAL', line1: 'LEARN', line2: 'TOGETHER.',
           caption: '集まるほど、できることが増える。', tone: 'red' },
  rule: { kicker: 'NOWL / STANDARD', journal: 'NOWL / STANDARD BOOK', line1: 'NEW', line2: 'STANDARD.',
          caption: '同じやり方が、安心をつくる。', tone: 'indigo' },
  study: { kicker: 'NOWL / STORIES', journal: 'NOWL / KNOWLEDGE JOURNAL', line1: 'KNOWLEDGE', line2: 'IN MOTION.',
           caption: '学びは、つながるほど強くなる。', tone: 'dark' },
  case: { kicker: 'NOWL / CASES', journal: 'NOWL / CASE JOURNAL', line1: 'REAL', line2: 'RESULTS.',
          caption: '現場の一例が、次の答えになる。', tone: 'amber' },
  praise: { kicker: 'NOWL / PEOPLE', journal: 'NOWL / PEOPLE JOURNAL', line1: 'WELL', line2: 'DONE.',
            caption: 'よかったことは、みんなで。', tone: 'pink' },
});
const COVER_DEFAULT = Object.freeze({ kicker: 'NOWL / UPDATES', journal: 'NOWL / TEAM JOURNAL',
  line1: 'TEAM', line2: 'UPDATE.', caption: 'チームの今を、もっと近くに。', tone: 'grey' });

/**
 * 表紙の見た目を決める。
 *   { imgId }       … 添付写真がある記事（写真をそのまま出す）
 *   { kicker, line1, line2, tone } … 写真が無い記事（文字だけの表紙）
 * ⚠️ ピックアップは濃い色にして、一覧の中で沈まないようにする。
 */
export function coverStyle(post, opts = {}) {
  const p = (post && typeof post === 'object') ? post : {};
  const imgId = coverOf(p);
  if (imgId) return { imgId, kicker: '', journal: '', line1: '', line2: '', caption: '', tone: '' };
  const base = COVER_BY_CAT[str(p.category)] || COVER_DEFAULT;
  // ピックアップ（大きい1件）は濃い色にして、肩書きも journal を使う
  return { imgId: '', ...base, tone: (p.featured || opts.hero) ? 'dark' : base.tone };
}
