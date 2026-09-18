// ── 勉強会・イベント: カレンダー登録（ICS）────────────────────────────
//
// ⚠️ 設計方針
//   1. **日付や時間が読めないものではカレンダーを作らない。** 適当な日時を作ると、
//      スタッフの予定表に間違った時間が入ってしまう。作れないときは理由を返す。
//   2. 時間帯は日本時間（既定 Asia/Tokyo）として扱い、UTC に直して書き出す。
//   3. 本人の操作で作る。勝手に配信・招待しない。
//
// tests/event-ics.test.js でカバー。

const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s == null ? '' : s)
  .replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// 対応する時間帯（ここに無いものは作らない）。※固定のずれを持つ地域だけを扱う。
const TZ_OFFSET = Object.freeze({ 'Asia/Tokyo': 9, 'Asia/Seoul': 9, 'Asia/Kuala_Lumpur': 8, 'Asia/Singapore': 8, UTC: 0 });

const utcStamp = (d) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;

/**
 * カレンダーに入れられるか。
 * 返り値 { ok:true, startUtc, endUtc } / { ok:false, reason }
 *   reason: 'no_date'（日付なし・繰り返し）/ 'no_time'（時間が読めない）/ 'bad_tz'
 */
export function resolveTimes(ev) {
  if (!ev || !ev.date || ev.recurring) return { ok: false, reason: 'no_date' };
  const off = TZ_OFFSET[String(ev.tz || 'Asia/Tokyo')];
  if (off === undefined) return { ok: false, reason: 'bad_tz' };
  const st = String(ev.startTime || '');
  if (!/^\d{1,2}:\d{2}$/.test(st)) return { ok: false, reason: 'no_time' };
  const [sh, sm] = st.split(':').map(Number);
  if (sh > 23 || sm > 59) return { ok: false, reason: 'no_time' };
  const y = ev.date.getFullYear(), mo = ev.date.getMonth(), da = ev.date.getDate();
  const startUtc = new Date(Date.UTC(y, mo, da, sh - off, sm));
  let endUtc;
  const et = String(ev.endTime || '');
  if (/^\d{1,2}:\d{2}$/.test(et)) {
    const [eh, em] = et.split(':').map(Number);
    if (eh > 23 || em > 59) return { ok: false, reason: 'no_time' };
    endUtc = new Date(Date.UTC(y, mo, da, eh - off, em));
    // 終わりが始まりより前なら日をまたいだものとして1日足す
    if (endUtc <= startUtc) endUtc = new Date(endUtc.getTime() + 86400000);
  } else {
    endUtc = new Date(startUtc.getTime() + 3600000);      // 終了が無ければ1時間
  }
  return { ok: true, startUtc, endUtc };
}

/**
 * ICS を作る。作れないときは { ok:false, reason }。
 * ⚠️ 予定の内容・場所は入力のまま入れる。人数や参加者は入れない。
 */
export function toIcs(ev, opts = {}) {
  const t = resolveTimes(ev);
  if (!t.ok) return t;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const uid = `${String(ev.id || 'event')}@naoru-dashboard`;
  const place = ev.online ? (ev.url || 'オンライン') : String(ev.place || '');
  const desc = [ev.summary, ev.target ? `対象: ${ev.target}` : '', ev.fee ? `料金: ${ev.fee}` : '',
    opts.link ? `詳細: ${opts.link}` : ''].filter(Boolean).join('\n');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NAORU//Dashboard//JA', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${esc(uid)}`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART:${utcStamp(t.startUtc)}`,
    `DTEND:${utcStamp(t.endUtc)}`,
    `SUMMARY:${esc(ev.title)}`,
    ...(place ? [`LOCATION:${esc(place)}`] : []),
    ...(desc ? [`DESCRIPTION:${esc(desc)}`] : []),
    ...(String(ev.status) === 'cancelled' ? ['STATUS:CANCELLED'] : ['STATUS:CONFIRMED']),
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return { ok: true, text: lines.join('\r\n') + '\r\n', filename: icsFilename(ev) };
}

export function icsFilename(ev) {
  const base = String((ev && ev.title) || 'event').replace(/[^\w\u3040-\u30FF\u4E00-\u9FFF-]/g, '_').slice(0, 40);
  return `${base || 'event'}.ics`;
}

/** カレンダーに入れられない理由を、利用者の言葉にする。 */
export const ICS_REASON = Object.freeze({
  no_date: '開催日が決まっていないため、カレンダーに追加できません',
  no_time: '開始時間が読み取れないため、カレンダーに追加できません',
  bad_tz: '時間帯の設定が正しくないため、カレンダーに追加できません',
});
