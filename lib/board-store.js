// ── 掲示板ストアの保存ロジック（投稿と既読の分離）────────────────
//
// 【直したい問題】
// 掲示板は `naoru:board:v1` に { posts:[...], reads:{staffId:ms} } を1つの塊で持っていた。
// そのため「誰かが掲示板を開いて既読になる」たびに、**投稿配列ごと丸ごと書き戻していた**。
//
//   Aさん: 読む {posts:[1,2,3]} ──投稿──> 書く {posts:[4,1,2,3]}
//   Bさん: 読む {posts:[1,2,3]} ──既読──> 書く {posts:[1,2,3], reads:{B:…}}   ← 4 が消える
//
// 閲覧者が多いほど踏み潰す確率が上がる。チャットが先に同じ問題に当たり、
// 既読を別キー(naoru:chat:reads:v1)へ分離して解決している。掲示板にはその対策が無かった。
//
// 【方針】
//   1. 既読は別キー `naoru:board:reads:v1` に置く。**既読の書き込みは posts に一切触れない**。
//   2. 移行期間は新旧どちらも読む（旧 blob の reads と新キーをマージ）。
//   3. 投稿側の更新には版（_v）を持たせ、古い版での上書きを 409 で弾く。
//   4. 投稿は clientId で冪等化（二重送信・再送で重複しない）。
//
// 【Rollback】
//   旧コードへ戻しても posts は壊れない。旧コードは blob 内の reads だけを見るため、
//   新キーに書かれた既読は反映されなくなる（＝未読バッジが一度だけ再表示される）だけで、
//   投稿・コメントは失われない。そのため安全に戻せる。

export const BOARD_READS_KEY = 'naoru:board:reads:v1';

const toMs = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

// { staffId: ms } の形に矯正する。壊れた値・巨大な件数を通さない。
export function normalizeReads(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (n++ >= 5000) break;                 // 異常膨張の歯止め
    const id = String(k).slice(0, 64);
    const ms = toMs(v);
    if (id && ms) out[id] = ms;
  }
  return out;
}

// 旧(blob内)と新(別キー)をマージする。**新しい方＝大きい方を採用**。
// 移行期間はこれで「どちらに書かれていても既読が効く」状態になる。
export function mergeReads(legacy, split) {
  const a = normalizeReads(legacy);
  const b = normalizeReads(split);
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (!out[k] || v > out[k]) out[k] = v;
  }
  return out;
}

// 既読を進める。**巻き戻さない**（古いタイムスタンプが後から届いても未読に戻さない）。
export function bumpRead(reads, staffId, ts) {
  const cur = normalizeReads(reads);
  const id = String(staffId || '').slice(0, 64);
  if (!id) return cur;
  const t = toMs(ts) || Date.now();
  if (!cur[id] || t > cur[id]) cur[id] = t;
  return cur;
}

// ── 版（楽観ロック）──────────────────────────────────────────
// 投稿側を書き換える操作は版を1つ進める。クライアントが見ていた版と違えば 409。
export function versionOf(blob) {
  const v = Number(blob && blob._v);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

// expected が未指定なら検査しない（＝古いクライアントは従来どおり動く）。
export function isStale(expected, actual) {
  if (expected === undefined || expected === null || expected === '') return false;
  const e = Number(expected);
  if (!Number.isFinite(e)) return false;
  return e !== Number(actual);
}

// ── 投稿の追加（冪等）─────────────────────────────────────────
// 同じ clientId / id の投稿が既にあれば**追加しない**（二重送信・再送で重複しない）。
// 戻り値 { posts, added, existing }
export function upsertPost(posts, rec, cap) {
  const list = Array.isArray(posts) ? posts.filter(Boolean) : [];
  const limit = Number.isFinite(cap) && cap > 0 ? cap : 500;
  const cid = rec && rec.clientId ? String(rec.clientId) : '';
  const existing = list.find(p =>
    (cid && String(p.clientId || '') === cid) || (rec && rec.id && p.id === rec.id)
  );
  if (existing) return { posts: list, added: false, existing };
  return { posts: [rec, ...list].slice(0, limit), added: true, existing: null };
}

// コメントの追加（冪等）。同じ clientId のコメントは二重に入らない。
// 戻り値 { posts, added, target, existing }
export function upsertComment(posts, postId, rec, cap) {
  const list = Array.isArray(posts) ? posts.filter(Boolean) : [];
  const limit = Number.isFinite(cap) && cap > 0 ? cap : 500;
  const cid = rec && rec.clientId ? String(rec.clientId) : '';
  let target = null, existing = null;
  const next = list.map(p => {
    if (!p || p.id !== String(postId)) return p;
    target = p;
    const comments = Array.isArray(p.comments) ? p.comments : [];
    existing = comments.find(c => (cid && String(c.clientId || '') === cid) || (rec && rec.id && c.id === rec.id)) || null;
    if (existing) return p;
    return { ...p, comments: [...comments, rec].slice(-limit) };
  });
  return { posts: next, added: !!target && !existing, target, existing };
}
