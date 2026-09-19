// ── 勉強会・イベント: 過去の開催のふりかえり ──────────────────────────
//
// 終わった会に「レポート・写真・配布資料・録画」を残す。
//
// ⚠️ 設計方針
//   - 保存先は既存の追加項目（naoru:events:meta:<rowId>）の中。**新しいキーを増やさない**。
//   - 写真と配布資料の**実体は別キー**（画像はチャットと同じ保存先、資料は掲示板と同じ保存先）。
//     meta にはIDだけを持つ。長いデータを meta に詰め込まない。
//   - ⚠️ **写真の掲載許可を確かめるまで公開しない。** 人が写っている写真を、
//     確認なしで社内に配らない（架空の同意を自動で立てない）。
//   - 録画は**URLの持ち込みだけ**。動画そのものはここに置かない。
//   - 中身が無いふりかえりは「まだありません」と出す。空の枠を作らない。
//
// tests/event-recap.test.js でカバー。

const str = (v, n = 200) => String(v == null ? '' : v).slice(0, n);
const arr = (v) => (Array.isArray(v) ? v : []);

export const MAX_PHOTOS = 12;
export const MAX_FILES = 8;
export const NOTE_MAX = 2000;

/** 録画のURL。https のものだけ受ける（http や javascript: は採らない）。 */
export function normalizeVideoUrl(v) {
  const u = str(v, 500).trim();
  return /^https:\/\/[^\s]+$/i.test(u) ? u : '';
}

/** ふりかえりを整える。⚠️ 知らないキーを生やさない。 */
export function normalizeRecap(input) {
  const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  return {
    note: str(src.note, NOTE_MAX),
    photoIds: [...new Set(arr(src.photoIds).map(x => str(x, 64)).filter(Boolean))].slice(0, MAX_PHOTOS),
    files: arr(src.files).slice(0, MAX_FILES).map(f => ({
      id: str(f && f.id, 64),
      name: str(f && f.name, 120) || 'file',
      type: str(f && f.type, 80),
      size: Number(f && f.size) || 0,
    })).filter(f => f.id),
    videoUrl: normalizeVideoUrl(src.videoUrl),
    // ⚠️ 写っている人の掲載許可を確かめたか。**自動では立てない**。
    consent: src.consent === true,
    updatedAt: Number(src.updatedAt) || 0,
    updatedBy: str(src.updatedBy, 64),
  };
}

export function emptyRecap() { return normalizeRecap(null); }

/** 中身の数。画面の「写真3枚・資料1件」に使う。 */
export function recapCounts(r) {
  const x = normalizeRecap(r);
  return { photos: x.photoIds.length, files: x.files.length, hasVideo: !!x.videoUrl, hasNote: !!x.note.trim() };
}

/** 何か入っているか（空の枠を出さないための判定）。 */
export function hasRecap(r) {
  const c = recapCounts(r);
  return c.hasNote || c.photos > 0 || c.files > 0 || c.hasVideo;
}

/**
 * 保存してよいか。
 * ⚠️ 写真があるのに掲載許可が未確認なら止める。理由を返す（黙って落とさない）。
 * @returns {ok:true} | {ok:false, reason:'empty'|'consent_unconfirmed'}
 */
export function recapReady(r) {
  const x = normalizeRecap(r);
  if (!hasRecap(x)) return { ok: false, reason: 'empty' };
  if (x.photoIds.length > 0 && !x.consent) return { ok: false, reason: 'consent_unconfirmed' };
  return { ok: true };
}

export const RECAP_REASON = Object.freeze({
  empty: 'ふりかえりの内容がありません。',
  consent_unconfirmed: '写真に写っている方の掲載許可を確かめてから保存してください。',
});

/**
 * ふりかえりを書けるのは**主催者と本部だけ**（既存の編集権限と同じ）。
 * @param ctx { isHq:boolean, meId:string }
 */
export function canEditRecap(ctx, ev) {
  const c = (ctx && typeof ctx === 'object') ? ctx : {};
  if (c.isHq === true) return true;
  const me = str(c.meId, 64);
  const owner = str(ev && ev.ownerId, 64);
  return !!me && !!owner && me === owner;
}

/**
 * ふりかえりを出してよい場面か。
 * ⚠️ **終わった会にだけ**出す。これから開く会に「ふりかえり」を出さない。
 */
export function recapVisible(ev, isPast) {
  if (!isPast) return false;
  return !!ev && ev.status !== 'draft';
}

/** 一覧のカードに出す短い一言。中身が無ければ空（「0件」と書かない）。 */
export function recapSummary(r) {
  const c = recapCounts(r);
  const parts = [];
  if (c.hasNote) parts.push('レポート');
  if (c.photos) parts.push(`写真${c.photos}枚`);
  if (c.files) parts.push(`資料${c.files}件`);
  if (c.hasVideo) parts.push('録画');
  return parts.join('・');
}
