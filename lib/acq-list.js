// ── 新規顧客一覧: 重複をなくし、時間軸どおりに並べる ────────────────────
//
// ⚠️ なぜ必要か（実際に起きていた不具合）
//   1. ページング（cursor）で取りに行くとき、次のカーソルが前と同じでも読み続けてしまい、
//      **同じ人が何度も入っていた**。1,769件のうち中身は数人、ということが起きる。
//   2. 同じ人が何度も入ると、画面の行の対応付け（key）が崩れて、
//      **並べ替えたのに表示が入れ替わらない**。9/10 の次に 9/8 が出るのはこれ。
//   3. 受付日時の形式が2通りある（`2026-09-10T17:45:00+09:00` と `2026-09-10 17:45:00`）。
//      後者は時間帯が無いので、**日本時間として読む**。UTC として読むと9時間ずれる。
//
// tests/acq-list.test.js でカバー。

const str = (v) => String(v == null ? '' : v);

/**
 * 受付日時・初回来店予定をミリ秒にする。
 * ⚠️ 読めないものは null（0 にしない）。0 にすると1970年として先頭に来てしまう。
 * ⚠️ 時間帯の指定が無い文字列は **日本時間** として読む（サーバーが日本時間で返すため）。
 */
export function parseAt(v) {
  const s = str(v).trim();
  if (!s) return null;
  // すでに時間帯が付いている（Z / +09:00 / -05:00）ならそのまま
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = Date.parse(s.replace(' ', 'T'));
    return Number.isFinite(t) ? t : null;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) { const t = Date.parse(s); return Number.isFinite(t) ? t : null; }
  const [, y, mo, d, hh, mi, ss] = m;
  // 日本時間 → UTC（-9時間）
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh || 0) - 9, Number(mi || 0), Number(ss || 0));
}

/** 顧客の見分け方。customer_id → customer_code の順。 */
export function idOf(c) {
  const id = str(c && c.customer_id);
  return id || str(c && c.customer_code);
}

/**
 * 同じ人を1件にまとめる。
 * ⚠️ **後から来たものを採用する**（差分同期であとから施策リンクや状態が付くため）。
 * ⚠️ IDが無い行は捨てずに残す（取りこぼしを作らない）。並び順の中では最後に回る。
 */
export function dedupeCustomers(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const map = new Map();
  const noId = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const id = idOf(c);
    if (!id) { noId.push(c); continue; }
    map.set(id, c);                      // 後勝ち
  }
  return [...map.values(), ...noId];
}

/**
 * ページングが進んでいるか。
 * ⚠️ 次のカーソルが前と同じ／空なら**そこで止める**（同じページを読み続けない）。
 */
export function nextCursor(prev, meta) {
  const m = (meta && typeof meta === 'object') ? meta : {};
  if (!m.has_more) return '';
  const next = str(m.next_cursor);
  if (!next || next === str(prev)) return '';     // 進んでいない＝終わり
  return next;
}

/**
 * 並べ替え。
 *   key  … 'received' | 'reserved' | 'link'
 *   dir  … 'asc' | 'desc'
 * ⚠️ 読めない日時は**常に末尾**（先頭にも中間にも混ぜない）。
 * ⚠️ 同じ時刻は顧客IDで固定して、描き直すたびに入れ替わらないようにする。
 */
export function sortCustomers(rows, key, dir, linkOf) {
  const list = [...(Array.isArray(rows) ? rows : [])];
  const asc = dir !== 'desc';
  const getLink = typeof linkOf === 'function' ? linkOf : () => '';
  const at = (c) => key === 'reserved' ? parseAt(c && c.reserved_at) : parseAt(c && c.received_at);
  const tie = (a, b) => idOf(a).localeCompare(idOf(b));
  if (key === 'link') {
    return list.sort((a, b) => {
      const la = getLink(a), lb = getLink(b);
      if (!la !== !lb) return la ? -1 : 1;                 // リンクなしは末尾
      const r = str(la).localeCompare(str(lb), 'ja');
      return (asc ? r : -r) || tie(a, b);
    });
  }
  return list.sort((a, b) => {
    const ta = at(a), tb = at(b);
    if (ta === null && tb === null) return tie(a, b);
    if (ta === null) return 1;                             // 読めない日時は末尾
    if (tb === null) return -1;
    if (ta !== tb) return asc ? ta - tb : tb - ta;
    return tie(a, b);
  });
}

/** 一覧に出す行を作る（重複をなくしてから並べる）。 */
export function buildRows(rows, { key = 'received', dir = 'desc', linkOf } = {}) {
  return sortCustomers(dedupeCustomers(rows), key, dir, linkOf);
}

/** 画面の行キー。⚠️ 同じ値が2つ出ないようにする（出ると表示が入れ替わる）。 */
export function rowKey(c, i) {
  const id = idOf(c);
  return id ? `${id}` : `row_${i}`;
}
