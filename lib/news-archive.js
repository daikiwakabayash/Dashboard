// ── ニュース: 下書きと、過去記事の年月・追加読込 ────────────────────────
//
// ⚠️ 設計方針
//   - **既存の投稿を壊さない。** `status` を持たない古い投稿は「公開済み」として扱う。
//     過去の投稿に既定値を書き込まない。
//   - 下書きは**一覧に混ぜない**。書いた本人と本部にだけ、一覧の上にまとめて出す
//     （勉強会・イベントの下書きと同じ扱い）。
//   - 年月は**日本時間**で決める。UTCで切ると、日本の夜に書いた記事が翌月に寄ってしまう。
//   - 日付が読めない記事を「1970年」や「今月」に寄せない。**「日付なし」**として分ける。
//
// tests/news-archive.test.js でカバー。

const str = (v) => String(v == null ? '' : v);
const arr = (v) => (Array.isArray(v) ? v : []);

export const DRAFT = 'draft';
export const PUBLISHED = 'published';

/** 公開状態。⚠️ 未設定（古い投稿）は「公開済み」。勝手に下書きへ倒さない。 */
export function normalizeStatus(v) {
  return str(v) === DRAFT ? DRAFT : PUBLISHED;
}

export function isDraft(p) {
  return normalizeStatus(p && p.status) === DRAFT;
}

/**
 * その下書きを見てよいか。
 * @param p      記事
 * @param viewer { ids:[本人と同一人物の別IDも含む], hq:true=本部・管理者 }
 * ⚠️ ids は**サーバーが確かめた本人**から作る。画面の名乗りをそのまま渡さない。
 */
export function canSeeDraft(p, viewer) {
  const v = (viewer && typeof viewer === 'object') ? viewer : {};
  if (v.hq === true) return true;
  const ids = arr(v.ids).map(str).filter(Boolean);
  const author = str(p && p.authorId);
  return !!author && ids.includes(author);
}

/** 一覧に出してよい記事。⚠️ 他人の下書きは落とす。 */
export function visibleFor(posts, viewer) {
  return arr(posts).filter(p => p && (!isDraft(p) || canSeeDraft(p, viewer)));
}

/** その人に見せる下書きだけ（新しい順）。 */
export function draftsFor(posts, viewer) {
  return arr(posts)
    .filter(p => p && isDraft(p) && canSeeDraft(p, viewer))
    .slice()
    .sort((a, b) => (parseAt(b.updatedAt || b.createdAt) || 0) - (parseAt(a.updatedAt || a.createdAt) || 0));
}

/** 公開済みだけ（一覧・ピックアップ・未読の数え上げに使う）。 */
export function publishedOnly(posts) {
  return arr(posts).filter(p => p && !isDraft(p));
}

/**
 * 日時 → ミリ秒。タイムゾーンが付いていない文字列は**日本時間**とみなす。
 * 読めなければ null（0 で埋めない）。
 */
export function parseAt(v) {
  const s = str(v).trim();
  if (!s) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = Date.parse(s.replace(' ', 'T'));
    return Number.isFinite(t) ? t : null;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) { const t = Date.parse(s); return Number.isFinite(t) ? t : null; }
  const [, y, mo, d, hh, mi, ss] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh || 0) - 9, Number(mi || 0), Number(ss || 0));
}

/** 日本時間の 'YYYY-MM'。読めなければ ''。 */
export function monthKeyOf(iso) {
  const t = parseAt(iso);
  if (t == null) return '';
  const d = new Date(t + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 'YYYY-MM' → '2026年9月'。'' は「日付なし」。 */
export function monthLabel(key) {
  const k = str(key);
  const m = k.match(/^(\d{4})-(\d{2})$/);
  if (!m) return '日付なし';
  return `${Number(m[1])}年${Number(m[2])}月`;
}

/**
 * 年月ごとにまとめる。**入力の並び順をそのまま保つ**（並べ替えは呼び出し側の責任）。
 * ⚠️ 日付が読めない記事は捨てずに「日付なし」の束へ入れる。
 */
export function groupByMonth(posts) {
  const out = [];
  const byKey = new Map();
  for (const p of arr(posts)) {
    if (!p) continue;
    const key = monthKeyOf(p.createdAt);
    let g = byKey.get(key);
    if (!g) { g = { key, label: monthLabel(key), posts: [] }; byKey.set(key, g); out.push(g); }
    g.posts.push(p);
  }
  return out;
}

/** 一覧に出ている記事から、年月の選択肢を作る（新しい順・「日付なし」は最後）。 */
export function monthOptions(posts) {
  const count = new Map();
  for (const p of arr(posts)) {
    if (!p) continue;
    const k = monthKeyOf(p.createdAt);
    count.set(k, (count.get(k) || 0) + 1);
  }
  return [...count.entries()]
    .sort((a, b) => (a[0] && b[0]) ? (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0) : (a[0] ? -1 : b[0] ? 1 : 0))
    .map(([key, n]) => ({ key, label: monthLabel(key), count: n }));
}

/** 追加読込の1回分。 */
export const PAGE = 12;

/**
 * いま何件まで出すか。
 * @returns { items, hasMore, remaining, next }  next = 「もっと読む」を押した後の件数
 */
export function pageOf(posts, shown) {
  const list = arr(posts);
  const n = Math.max(PAGE, Math.min(Number(shown) || PAGE, list.length || PAGE));
  const items = list.slice(0, n);
  const remaining = Math.max(0, list.length - items.length);
  return { items, hasMore: remaining > 0, remaining, next: n + PAGE };
}
