// ── ニュース: 閲覧・リアクション状況 ────────────────────────────────────
// 投稿ごとに「既読／未読／確認しました／リアクション済み／未リアクション」を出す。
//
// ⚠️ 設計方針
//   - **3つは別のデータ**として扱う。
//       既読       … 記事を開いて表示できたとき（自動）
//       確認しました … 本人がボタンを押したとき（明示）
//       リアクション … スタンプ（既存の post.reactions）
//     「未リアクション」には未読の人も含まれる。画面にもそう書く。
//   - **分母は投稿の対象者**。同じ人が複数店舗に出てきても1人として数える。
//   - **取れていない時刻を作らない。** 記録が無い人は「未読」であって「0時0分に読んだ」ではない。
//   - 詳細（氏名の一覧）は本部の管理者と投稿者だけ。誰でも他人の行動一覧を見られる状態にしない。
//
// 保存は投稿ごとの小さなキー（naoru:board:pr:<postId>）。
//   { r: { staffId: ms }, a: { staffId: ms } }
// 既存の未読バッジ（naoru:board:reads:v1 の「最後に見た時刻」）はそのまま残す。
//
// tests/board-status.test.js でカバー。

export const BOARD_PR_PREFIX = 'naoru:board:pr:';

const toMs = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
const str = (v) => String(v == null ? '' : v);
const arr = (v) => (Array.isArray(v) ? v : []);

export function prKey(postId) {
  return `${BOARD_PR_PREFIX}${str(postId).slice(0, 64)}`;
}

// { r: {id: ms}, a: {id: ms} } に矯正する。壊れた値・異常な件数を通さない。
export function normalizePr(raw, cap = 5000) {
  const one = (o) => {
    const out = {};
    if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
    let n = 0;
    for (const [k, v] of Object.entries(o)) {
      if (n++ >= cap) break;
      const id = str(k).slice(0, 64); const ms = toMs(v);
      if (id && ms) out[id] = ms;
    }
    return out;
  };
  const src = (raw && typeof raw === 'object') ? raw : {};
  return { r: one(src.r), a: one(src.a) };
}

/**
 * 既読を記録する。⚠️ **最初に読めた時刻を残す**（あとから来た記録で上書きしない）。
 * 記事が表示できたときだけ呼ぶこと。一覧を開いただけで全件呼ばない。
 */
export function markRead(pr, staffId, ts) {
  const cur = normalizePr(pr);
  const id = str(staffId).slice(0, 64);
  if (!id) return cur;
  if (!cur.r[id]) cur.r[id] = toMs(ts) || Date.now();
  return cur;
}

/** 「確認しました」を記録する。既読とは別に持つ（押していない人を既読で埋めない）。 */
export function markAck(pr, staffId, ts) {
  const cur = normalizePr(pr);
  const id = str(staffId).slice(0, 64);
  if (!id) return cur;
  const t = toMs(ts) || Date.now();
  if (!cur.a[id]) cur.a[id] = t;
  if (!cur.r[id]) cur.r[id] = t;         // 押せたということは読めている
  return cur;
}

// 対象者を1人1件に畳む（同じ人が複数店舗に出てきても重複して数えない）
export function dedupeAudience(audience) {
  const map = new Map();
  for (const a of arr(audience)) {
    const id = str(a && a.id);
    if (!id || map.has(id)) continue;
    map.set(id, { id, name: str(a.name), shop: str(a.shop) });
  }
  return [...map.values()];
}

/**
 * 投稿1件の状況。
 *   post      … { id, authorId, reactions }
 *   audience  … [{id,name,shop}]（投稿の対象者。分母）
 *   pr        … { r, a }
 * 返り値の people は氏名つき。counts だけなら誰に見せてもよいが、
 * people は呼び出し側で権限を確かめてから出すこと（canSeeDetail）。
 */
export function postStatus(post, audience, pr) {
  const list = dedupeAudience(audience);
  const cur = normalizePr(pr);
  const reactions = (post && post.reactions && typeof post.reactions === 'object') ? post.reactions : {};
  const reacted = new Set(Object.values(reactions).flatMap(ids => arr(ids).map(String)));

  const read = [], unread = [], acked = [], notAcked = [], didReact = [], notReact = [];
  for (const p of list) {
    (cur.r[p.id] ? read : unread).push({ ...p, at: cur.r[p.id] || null });
    (cur.a[p.id] ? acked : notAcked).push({ ...p, at: cur.a[p.id] || null });
    (reacted.has(p.id) ? didReact : notReact).push({ ...p, at: null });
  }
  return {
    total: list.length,
    counts: {
      read: read.length, unread: unread.length,
      acked: acked.length, notAcked: notAcked.length,
      reacted: didReact.length, notReacted: notReact.length,
    },
    people: { read, unread, acked, notAcked, reacted: didReact, notReacted: notReact },
    // ⚠️ 画面に必ず出す注記。未リアクションには「まだ読んでいない人」も含まれる。
    note: '「未リアクション」には、まだ読んでいない人も含まれます。',
  };
}

/**
 * 詳細（氏名の一覧）を見てよいか。
 *   actor: { id, role, verified }
 * 本部の管理者（root / admin）か、その投稿の投稿者本人だけ。
 */
export function canSeeDetail(actor, post) {
  const a = actor || {};
  if (a.verified !== true) return false;
  if (['root', 'admin'].includes(str(a.role))) return true;
  // 同一人物の別ID（SSOの staff_id / user_id、本部アカウントに紐付けた staffId）も本人として扱う。
  // これが無いと、自分が書いた記事なのに本人と判定されないことがある。
  const ids = [str(a.id), ...(Array.isArray(a.altIds) ? a.altIds.map(str) : [])].filter(Boolean);
  const author = str(post && post.authorId);
  return !!author && ids.includes(author);
}

/**
 * 対象者が変わった・退職したときの扱い。
 *   いま対象でない人の記録は**消さない**（過去の事実なので残す）が、
 *   集計の分母には入れない。画面には「対象外の記録」として件数だけ出す。
 */
export function outOfAudience(audience, pr) {
  const ids = new Set(dedupeAudience(audience).map(p => p.id));
  const cur = normalizePr(pr);
  const extra = new Set([...Object.keys(cur.r), ...Object.keys(cur.a)].filter(id => !ids.has(id)));
  return { count: extra.size, ids: [...extra] };
}
