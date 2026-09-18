// ── ニュース記事に貼ったイベントリンク → グループチャットへの参加 ──────────
// 勉強会・イベントの行に付いているグループチャット（cells.roomId）へ、
// 記事を読んだ人が「グループチャットへ参加」で自分から入れるようにする。
//
// ⚠️ 設計方針
//   - **押した本人だけが参加する。** リンクを貼っただけで全員を参加させない。
//   - **自前のイベントリンクだけを受け付ける。** 外のURLを読みに行かない（fetchしない）。
//     解決は、いま画面が持っているイベント表の中を探すだけ。
//   - **グループが無いイベントは、勝手に作らない。** 「未作成」と出して投稿者に任せる。
//   - 参加済みなら作り直さず、そのまま開く（何度押しても増えない）。
//
// tests/news-event.test.js でカバー。

const str = (v) => String(v == null ? '' : v);
const arr = (v) => (Array.isArray(v) ? v : []);

// イベント行への共有リンク。Dashboard 自身のURLだけを使う。
export function buildEventLink(origin, rowId) {
  const id = str(rowId).trim();
  if (!id) return '';
  const base = str(origin).replace(/\/+$/, '');
  return `${base}/?tab=events&ev=${encodeURIComponent(id)}`;
}

/**
 * 文章の中から、自分のイベントリンクだけを取り出す。
 * ⚠️ 別サイトのURLは受け付けない（origin 一致が条件）。ここでリンク先を取りに行くことはしない。
 * 返り値: [{ url, rowId }]（重複なし・最大10件）
 */
export function extractEventLinks(text, origin) {
  const host = (() => { try { return new URL(str(origin)).host; } catch { return ''; } })();
  const found = str(text).match(/https?:\/\/[^\s<>"'）)】」]+/g) || [];
  const out = [], seen = new Set();
  for (const raw of found) {
    const url = raw.replace(/[.,、。]+$/, '');
    let u; try { u = new URL(url); } catch { continue; }
    if (!host || u.host !== host) continue;                 // 別サイトは対象外
    if (u.searchParams.get('tab') !== 'events') continue;
    const rowId = str(u.searchParams.get('ev')).trim();
    if (!rowId || seen.has(rowId)) continue;
    seen.add(rowId);
    out.push({ url, rowId });
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * イベントID → 実在するイベント行。見つからなければ found:false。
 *   sections: { [セクション名]: [{ id, cells:{ date, chatTitle, roomId, ownerId, ... } }] }
 * ⚠️ 実在しないIDを「あることにしない」。削除済み・別テナントのIDはここで落とす。
 */
export function resolveEvent(rowId, sections) {
  const id = str(rowId).trim();
  if (!id) return { found: false, reason: 'no_id' };
  const map = (sections && typeof sections === 'object') ? sections : {};
  for (const [section, rows] of Object.entries(map)) {
    for (const row of arr(rows)) {
      if (!row || str(row.id) !== id) continue;
      const cells = (row.cells && typeof row.cells === 'object') ? row.cells : {};
      return {
        found: true, section, rowId: id,
        title: str(cells.chatTitle).trim() || section,
        date: str(cells.date),
        roomId: str(cells.roomId),
        ownerId: str(cells.ownerId),
      };
    }
  }
  return { found: false, reason: 'not_found' };
}

/**
 * 参加ボタンの状態。
 *   'no_event'  … イベントが見つからない（削除済みなど）
 *   'no_room'   … イベントにグループチャットがまだ無い（勝手に作らない）
 *   'no_access' … ルームが自分から見えない（別のルームを名乗られた等）
 *   'joined'    … すでに参加済み → そのまま開く
 *   'can_join'  … 参加できる
 */
export function joinState(ev, rooms, myId) {
  if (!ev || !ev.found) return 'no_event';
  if (!ev.roomId) return 'no_room';
  const room = arr(rooms).find(r => r && str(r.id) === str(ev.roomId));
  if (!room) return 'no_access';
  const me = str(myId);
  if (!me) return 'no_access';
  return arr(room.members).map(String).includes(me) ? 'joined' : 'can_join';
}

// 画面に出す一言（状態ごとに、次に何が起きるかが分かる言葉にする）
export const JOIN_LABEL = {
  no_event: 'このイベントは見つかりません（削除された可能性があります）',
  no_room: 'このイベントにはまだグループチャットがありません',
  no_access: 'このグループチャットを開く権限がありません',
  joined: 'グループチャットを開く',
  can_join: 'グループチャットへ参加',
};

/**
 * 投稿本文からイベントを解決して、画面に出せる形にまとめる。
 * 返り値: [{ url, rowId, event, state, label }]
 */
export function resolvePostEvents(text, { origin, sections, rooms, myId } = {}) {
  return extractEventLinks(text, origin).map(({ url, rowId }) => {
    const event = resolveEvent(rowId, sections);
    const state = joinState(event, rooms, myId);
    return { url, rowId, event, state, label: JOIN_LABEL[state] };
  });
}
