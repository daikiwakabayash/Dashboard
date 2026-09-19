// ── 勉強会・イベント: 項目の読み取りと追加項目 ────────────────────────
//
// ⚠️ 設計方針
//   1. **旧データを壊さない。** いまの行は `cells`（文字列・各300文字）に入っている。
//      そこへ画像や長文を詰め込まない。新しい項目は**別のキー**に持つ。
//   2. **旧データをそのまま読めるようにする。** 新しい項目が無い行も、いままでどおり出す。
//   3. 分類（study / event / bukatsu）の**キーは変えない**。表示名だけ変える。
//      「交流イベント」は既存 event の呼び名の変更で、過去データはそのまま。
//   4. 勝手に内容を書き換えない。日付や時間の解釈に失敗したら「未定」として扱い、
//      それらしい値を作らない（カレンダー登録も作らない）。
//
// 新しい項目の保存先: naoru:events:meta:<rowId>
//
// tests/event-fields.test.js でカバー。

import { parseEventDate } from './events.js';
import { normalizeRecap } from './event-recap.js';

export const META_PREFIX = 'naoru:events:meta:';
export const SECTION_KEYS = Object.freeze(['study', 'event', 'bukatsu']);
// ⚠️ キーは変えない。呼び名だけ変える（過去データを失わないため）。
export const SECTION_LABEL = Object.freeze({ study: '勉強会', event: '交流イベント', bukatsu: '部活' });
export const SECTION_LATIN = Object.freeze({ study: 'STUDY SESSION', event: 'SOCIAL', bukatsu: 'CLUB' });
export const SECTION_TONE = Object.freeze({ study: 'lab', event: 'social', bukatsu: 'club' });
export const SECTION_WORD = Object.freeze({
  study: 'MEET.\nLEARN.', event: 'GATHER.\nENJOY.', bukatsu: 'PLAY.\nTOGETHER.',
});
// 主催者が設定したときだけ出す（勝手に「初参加歓迎」と書かない）
export const WELCOME_FLAGS = Object.freeze([
  { key: 'firstTimer', label: '初参加歓迎' },
  { key: 'listenOnly', label: '聞くだけOK' },
  { key: 'partial', label: '途中参加OK' },
]);

const str = (v, n = 200) => String(v == null ? '' : v).slice(0, n);
const arr = (v) => (Array.isArray(v) ? v : []);

export function metaKey(rowId) { return `${META_PREFIX}${str(rowId, 64)}`; }

/** 送信済みのお知らせ。{ open: ms, cancelled: ms } だけを持つ。 */
export function normalizeNotified(v) {
  const src = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  const out = {};
  for (const k of ['open', 'cancelled']) {
    const n = Number(src[k]);
    if (Number.isFinite(n) && n > 0) out[k] = Math.floor(n);
  }
  return out;
}

/** 追加項目を整える。⚠️ 知らないキーを生やさない。 */
export function normalizeMeta(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const w = (src.welcome && typeof src.welcome === 'object') ? src.welcome : {};
  return {
    title: str(src.title, 120),
    summary: str(src.summary, 300),          // 何が得られるか（短く）
    gains: arr(src.gains).map(x => str(x, 60)).filter(Boolean).slice(0, 5),
    target: str(src.target, 120),            // 対象者
    fee: str(src.fee, 60),                   // 料金（自由文のまま。0円と勝手に決めない）
    online: !!src.online,
    url: /^https:\/\//.test(str(src.url, 500)) ? str(src.url, 500) : '',
    startTime: /^\d{1,2}:\d{2}$/.test(str(src.startTime, 5)) ? str(src.startTime, 5) : '',
    endTime: /^\d{1,2}:\d{2}$/.test(str(src.endTime, 5)) ? str(src.endTime, 5) : '',
    tz: str(src.tz, 40) || 'Asia/Tokyo',
    coverImgId: str(src.coverImgId, 64),
    welcome: Object.fromEntries(WELCOME_FLAGS.map(f => [f.key, !!w[f.key]])),
    featured: !!src.featured,                // 注目イベント（編集者が1件だけ指定）
    status: ['draft', 'open', 'cancelled'].includes(src.status) ? src.status : 'open',
    cancelReason: str(src.cancelReason, 200),
    tags: arr(src.tags).map(x => str(x, 24)).filter(Boolean).slice(0, 6),
    updatedAt: Number(src.updatedAt) || 0,
    updatedBy: str(src.updatedBy, 64),
    // ⚠️ どのお知らせを送り終えたか。**同じ知らせを重ねて送らない**ための記録。
    notified: normalizeNotified(src.notified),
    // 過去の開催のふりかえり（レポート・写真・配布資料・録画）。実体は別キー、ここにはIDだけ。
    recap: normalizeRecap(src.recap),
  };
}

/** 時間の自由文から開始・終了を読む。読めなければ空（それらしい値を作らない）。 */
export function parseTimeRange(raw) {
  const s = String(raw == null ? '' : raw).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).trim();
  const two = s.match(/(\d{1,2})\s*[:：]\s*(\d{2})\s*[-–—~〜ー]\s*(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (two) return { start: `${two[1].padStart(2, '0')}:${two[2]}`, end: `${two[3].padStart(2, '0')}:${two[4]}` };
  const one = s.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (one) return { start: `${one[1].padStart(2, '0')}:${one[2]}`, end: '' };
  return { start: '', end: '' };
}

/**
 * 1行を画面で使える形にする。**旧 cells だけの行もそのまま読める。**
 *   row      … { id, cells, updatedBy, updatedAt }
 *   section  … 'study' | 'event' | 'bukatsu'
 *   meta     … naoru:events:meta:<id> の中身（無くてよい）
 */
export function readEvent(row, section, meta, now = new Date()) {
  const r = (row && typeof row === 'object') ? row : {};
  const c = (r.cells && typeof r.cells === 'object') ? r.cells : {};
  const m = normalizeMeta(meta);
  const sec = SECTION_KEYS.includes(section) ? section : 'study';
  const dateRaw = str(c.date, 60);
  const parsed = parseEventDate(dateRaw, now);
  const t = parseTimeRange(c.time);
  const startTime = m.startTime || t.start;
  const endTime = m.endTime || t.end;
  // 旧データは「内容」が本文。新しい要約があればそちらを優先する。
  const content = str(c.content, 300);
  return {
    id: str(r.id, 64),
    section: sec,
    sectionLabel: SECTION_LABEL[sec],
    // 題名: 新しい title → 旧 chatTitle → 内容の冒頭 → 分類名
    title: m.title || str(c.chatTitle, 120) || content.slice(0, 40) || SECTION_LABEL[sec],
    summary: m.summary || content,
    gains: m.gains,
    target: m.target,
    fee: m.fee,
    dateRaw,
    // ⚠️ 読めない日付・繰り返しは「日付なし」。それらしい日付を作らない。
    date: (parsed && !parsed.recurring && parsed.date) ? parsed.date : null,
    recurring: !!(parsed && parsed.recurring),
    timeRaw: str(c.time, 60),
    startTime, endTime, tz: m.tz,
    place: str(c.place, 120),
    online: m.online,
    url: m.url,
    owner: str(c.owner, 80) || str(c.charge, 80),
    ownerId: str(c.ownerId, 64),
    teacher: str(c.teacher, 80),
    club: str(c.club, 80),
    capacityRaw: str(c.capacity, 60),
    contact: str(c.contact, 160),
    roomId: str(c.roomId, 64),
    chatTitle: str(c.chatTitle, 120),
    coverImgId: m.coverImgId,
    welcome: m.welcome,
    featured: m.featured,
    status: m.status,
    cancelReason: m.cancelReason,
    tags: m.tags,
    recap: m.recap,                       // 過去の開催のふりかえり
    updatedBy: str(r.updatedBy, 64),
    updatedAt: str(r.updatedAt, 40),
    hasMeta: !!(meta && typeof meta === 'object'),
  };
}

/** 終わった会か（過ぎた日付だけ。繰り返し・未定は終わりにしない）。 */
export function isPast(ev, now = new Date()) {
  if (!ev || !ev.date) return false;
  const end = new Date(ev.date.getFullYear(), ev.date.getMonth(), ev.date.getDate(), 23, 59, 59);
  return end.getTime() < (now instanceof Date ? now : new Date(now)).getTime();
}

/** 検索。題名・内容・場所・講師/担当・タグを対象にする。 */
export function matches(ev, query) {
  const q = String(query || '').normalize('NFKC').toLowerCase().trim();
  if (!q) return true;
  return [ev.title, ev.summary, ev.place, ev.teacher, ev.owner, ev.club, ev.sectionLabel, ...(ev.tags || [])]
    .map(x => String(x || '').normalize('NFKC').toLowerCase()).join(' ').includes(q);
}

/** 開催日順（日付なし・繰り返しは後ろ）。 */
export function byDate(a, b) {
  const ta = a && a.date ? a.date.getTime() : Infinity;
  const tb = b && b.date ? b.date.getTime() : Infinity;
  if (ta !== tb) return ta - tb;
  return String(a && a.title).localeCompare(String(b && b.title));
}

/** 公開してよいか。⚠️ 中身が空の行を公開させない（空の予定が並ぶのを防ぐ）。 */
export function canPublish(ev) {
  if (!ev) return { ok: false, reason: 'empty' };
  const hasTitle = !!String(ev.title || '').trim() && ev.title !== ev.sectionLabel;
  if (!hasTitle) return { ok: false, reason: 'no_title' };
  if (!String(ev.dateRaw || '').trim()) return { ok: false, reason: 'no_date' };
  return { ok: true };
}
