// ── 社内チャット ロジック（純粋関数） ──────────────────────────────────
// スタッフ同士・グループ・店舗ごとのチャット。保存は api/plan-store.js（?type=chat・KV/Supabase/GAS）、
// 表示は index.html。ここには保存・表示に依存しない純粋ロジックのみ置き、tests/chat.test.js でカバーする。
//
// データモデル（共有ストア blob = naoru:chat:v1）:
//   rooms:    [{ id, kind:'announce'|'store'|'group'|'dm', name, shop, members:[staffId], createdBy, createdAt }]
//   messages: { [roomId]: [{ id, roomId, fromStaffId, fromName, fromShop, text, imgIds:[], links:[], mentions:[{id,name}], createdAt }] }
//   reads:    { [staffId]: { [roomId]: lastReadMs } }   // 既読ポインタ（この時刻より後＝未読）
//   dir:      { staff:[{id,name,shop}], updatedAt }      // メンバー選択用の全社ディレクトリ
//   reactions は messages[].reactions = { [emoji]: [staffId] } に保持
//
// ⚠️ plan-store はサーバー認証を持たない（thanksgift と同じ信頼モデル）。fromStaffId/name はクライアント申告。
//    UIレベルの社内利用を前提。厳密なサーバー側分離が必要なら別途プロキシ認証が必要。

// 決定的でない一意ID（時刻＋乱数）。衝突をほぼ避けつつ短く。
export function genId(prefix = 'm') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 店舗ルームの決定的ID（1店舗1ルーム）。店舗名をキーにする。
export function storeRoomId(shopName) {
  return `store_${String(shopName || '').trim()}`;
}

export const ANNOUNCE_ROOM_ID = 'announce_all';

// 全社アナウンス＋店舗ルームの既定セットを作る（既存があれば温存してマージ）。
// shops: [{name}]。返り値は rooms 配列（announce → store順）。
export function ensureBaseRooms(rooms, shops) {
  const list = Array.isArray(rooms) ? rooms.slice() : [];
  const byId = new Map(list.map(r => [String(r.id), r]));
  if (!byId.has(ANNOUNCE_ROOM_ID)) {
    const r = { id: ANNOUNCE_ROOM_ID, kind: 'announce', name: '全社アナウンス', shop: '', members: [], createdBy: '__system__', createdAt: new Date().toISOString() };
    list.push(r); byId.set(ANNOUNCE_ROOM_ID, r);
  }
  for (const s of (Array.isArray(shops) ? shops : [])) {
    const name = String((s && s.name) || '').trim();
    if (!name) continue;
    const id = storeRoomId(name);
    if (!byId.has(id)) {
      const r = { id, kind: 'store', name, shop: name, members: [], createdBy: '__system__', createdAt: new Date().toISOString() };
      list.push(r); byId.set(id, r);
    }
  }
  return list;
}

// あるルームがユーザーに見えるか。
//   me = { staffId, root:boolean, shops:[店舗名の一部...] }
//   announce … 全員
//   store    … root、または所属/アクセス店舗が一致、またはメンバー明示
//   group/dm … メンバーに含まれる場合のみ（rootでも非メンバーのDMは見えない＝プライバシー）
export function roomVisibleTo(room, me) {
  if (!room) return false;
  const u = me || {};
  const sid = String(u.staffId || '');
  const members = (Array.isArray(room.members) ? room.members : []).map(String);
  if (room.kind === 'announce') return true;
  if (room.kind === 'store') {
    if (u.root) return true;
    if (sid && members.includes(sid)) return true;
    const shops = Array.isArray(u.shops) ? u.shops : [];
    const rs = String(room.shop || room.name || '');
    return shops.some(p => p && (rs.includes(p) || p.includes(rs)));
  }
  // group / dm
  return !!sid && members.includes(sid);
}

// 未読件数（lastReadMs より後に来た、自分以外の投稿）。
export function unreadCount(msgs, lastReadMs, myStaffId) {
  const last = Number(lastReadMs) || 0;
  const mine = String(myStaffId || '');
  return (Array.isArray(msgs) ? msgs : []).reduce((n, m) => {
    if (!m) return n;
    const t = Date.parse(m.createdAt || '') || 0;
    if (t > last && String(m.fromStaffId) !== mine) return n + 1;
    return n;
  }, 0);
}

// 「ここから未読」の区切りを入れる位置（lastReadMs より後の最初の他人投稿のindex）。無ければ -1。
export function firstUnreadIndex(msgs, lastReadMs, myStaffId) {
  const last = Number(lastReadMs) || 0;
  const mine = String(myStaffId || '');
  const arr = Array.isArray(msgs) ? msgs : [];
  for (let i = 0; i < arr.length; i++) {
    const m = arr[i]; if (!m) continue;
    const t = Date.parse(m.createdAt || '') || 0;
    if (t > last && String(m.fromStaffId) !== mine) return i;
  }
  return -1;
}

// テキストからURLを抽出（http/https）。重複除去・最大10件。
export function extractLinks(text) {
  const re = /https?:\/\/[^\s<>"'）)】」]+/g;
  const found = String(text || '').match(re) || [];
  const seen = new Set(); const out = [];
  for (const u of found) {
    const url = u.replace(/[.,、。]+$/, '');
    if (!seen.has(url)) { seen.add(url); out.push(url); }
    if (out.length >= 10) break;
  }
  return out;
}

// リアクションのトグル（1ユーザー1絵文字＝押下で付与/解除）。reactions を新しいオブジェクトで返す。
export function toggleReaction(reactions, emoji, staffId) {
  const r = { ...(reactions && typeof reactions === 'object' ? reactions : {}) };
  const sid = String(staffId || '');
  const cur = Array.isArray(r[emoji]) ? r[emoji].map(String) : [];
  r[emoji] = cur.includes(sid) ? cur.filter(x => x !== sid) : [...cur, sid];
  if (r[emoji].length === 0) delete r[emoji];
  return r;
}

// 表示用にルームを種別ごとにグループ化し、それぞれ最新メッセージ時刻の降順で並べる。
//   lastMsgAt(room) を渡すと並び順に使う。
export function groupRooms(rooms, lastMsgAt = () => 0) {
  const groups = { announce: [], group: [], store: [], dm: [] };
  for (const r of (Array.isArray(rooms) ? rooms : [])) {
    const k = groups[r.kind] ? r.kind : 'group';
    groups[k].push(r);
  }
  for (const k of Object.keys(groups)) {
    groups[k].sort((a, b) => (lastMsgAt(b) || 0) - (lastMsgAt(a) || 0));
  }
  return groups;
}

// DMルームの相手を1人だけ選ぶ（members から自分を除いた先頭）。
export function dmPartnerId(room, myStaffId) {
  const mine = String(myStaffId || '');
  return (Array.isArray(room && room.members) ? room.members : []).map(String).find(x => x !== mine) || '';
}

// ── @メンション ────────────────────────────────────────────────
// カーソル直前の「@入力中」文字列を返す（例: "…@若" → "若"、"@"直後 → ""）。無ければ null。
// 名前にスペースを含むため、入力中は空白なしの部分文字列のみを対象にする（候補選択でフルネームを挿入）。
export function parseMentionQuery(textBeforeCaret) {
  // 半角@・全角＠の両方をトリガーにする（日本語キーボードで＠になっても機能する）。
  const m = /(?:^|[\s　])[@＠]([^\s@＠　]{0,40})$/.exec(String(textBeforeCaret || ''));
  return m ? m[1] : null;
}

// カーソル位置の「@入力中」を「@名前 」へ置換。{ value, caret } を返す。
export function applyMention(value, caret, name) {
  const v = String(value);
  const c = Math.max(0, Math.min(Number(caret) || 0, v.length));
  const before = v.slice(0, c);
  const after = v.slice(c);
  const m = /(^|[\s　])[@＠]([^\s@＠　]{0,40})$/.exec(before);
  const start = m ? (before.length - m[0].length + m[1].length) : c; // 先頭の空白は残す
  const insert = '@' + String(name || '') + ' ';
  return { value: v.slice(0, start) + insert + after, caret: start + insert.length };
}

// 本文から候補({id,name})に一致する @メンションを抽出（長い名前優先・id重複排除）。
export function extractMentions(text, candidates) {
  let t = String(text || '').replace(/＠/g, '@'); // 全角＠も半角@として扱う
  const out = [];
  const seen = new Set();
  (Array.isArray(candidates) ? candidates.slice() : [])
    .sort((a, b) => String((b && b.name) || '').length - String((a && a.name) || '').length)
    .forEach((c) => {
      if (!c || !c.name || seen.has(String(c.id))) return;
      const token = '@' + c.name;
      if (t.includes(token)) {
        seen.add(String(c.id));
        out.push({ id: String(c.id), name: String(c.name) });
        t = t.split(token).join(' '); // 一致箇所を消し、短い名前が長い名前の一部に誤マッチしないようにする
      }
    });
  return out;
}

// 既存の1:1 DMルームを探す（同じ2人）。無ければ null。
export function findDmRoom(rooms, aId, bId) {
  const a = String(aId), b = String(bId);
  return (Array.isArray(rooms) ? rooms : []).find(r => {
    if (r.kind !== 'dm') return false;
    const mem = (Array.isArray(r.members) ? r.members : []).map(String);
    return mem.length === 2 && mem.includes(a) && mem.includes(b);
  }) || null;
}
