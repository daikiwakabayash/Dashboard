// ── 勉強会・イベント: 参加の状態 ────────────────────────────────────
//
// ⚠️ 設計方針（ここを崩すと「行くつもりがないのに参加者に数えられる」事故になる）
//   1. **「気になる」は保存だけ。** 参加でもグループ所属でもない。
//   2. **参加は本人が押したときだけ。** チャットに入っていることを根拠に参加予定にしない。
//   3. 招待済み / 気になる / 参加予定 / キャンセル待ち / 取消 は**別の状態**。
//      さらに「実際に出席したか」は**まったく別**に持つ（予定人数と混ぜない）。
//   4. 定員は**サーバーで原子的に**判定する。連打・同時申込・再送でも重複・超過を作らない。
//   5. 旧データの自由文の定員（「各店1名」など）を無理に数値にしない。席の管理をしない。
//   6. 取消が出たらキャンセル待ちの**先着順**で繰り上げる。勝手に順番を入れ替えない。
//
// 保存はイベント行ごとの小さなキー（naoru:events:rsvp:<rowId>）。
//   { v: { staffId: { s: 状態, at: ms, seq: 申込順, by: 'self'|'host' } }, n: 次の申込順 }
//
// tests/event-rsvp.test.js でカバー。

export const RSVP_PREFIX = 'naoru:events:rsvp:';
export const STATES = Object.freeze(['invited', 'interested', 'going', 'waitlist', 'cancelled']);
export const STATE_LABEL = Object.freeze({
  invited: '招待済み', interested: '気になる', going: '参加予定',
  waitlist: 'キャンセル待ち', cancelled: '取消', none: '未回答',
});
// 「チャットには入っているが、出席の回答はしていない」。参加予定と混ぜない。
export const CHAT_ONLY_LABEL = 'チャット参加中・出欠未回答';

const str = (v, n = 64) => String(v == null ? '' : v).slice(0, n);
const arr = (v) => (Array.isArray(v) ? v : []);
const toMs = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0; };

export function rsvpKey(rowId) { return `${RSVP_PREFIX}${str(rowId)}`; }

/** 保存形を矯正する。壊れた値・知らない状態・異常な件数を通さない。 */
export function normalizeRsvp(raw, cap = 3000) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const from = (src.v && typeof src.v === 'object' && !Array.isArray(src.v)) ? src.v : {};
  const v = {};
  let i = 0, maxSeq = 0;
  for (const [k, val] of Object.entries(from)) {
    if (i++ >= cap) break;
    const id = str(k);
    if (!id || !val || typeof val !== 'object') continue;
    const s = STATES.includes(val.s) ? val.s : '';
    if (!s) continue;
    const seq = toMs(val.seq);
    if (seq > maxSeq) maxSeq = seq;
    v[id] = { s, at: toMs(val.at), seq, by: val.by === 'host' ? 'host' : 'self' };
  }
  const n = Math.max(toMs(src.n), maxSeq + 1, 1);
  return { v, n };
}

/**
 * 定員の読み取り。
 *   { kind:'number', n } … 席の管理ができる
 *   { kind:'text', raw } … 自由文（「各店1名」など）。⚠️ 無理に数値化せず、席の管理をしない
 *   { kind:'none' }      … 未設定
 */
export function parseCapacity(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { kind: 'none' };
  // ⚠️ **数だけ**（「20」「20名」「定員20人」）を席として扱う。
  //    「各店1名」「先着順・応相談」のような自由文は数にしない（運営の確認が要るため）。
  const m = s.match(/^(?:定員)?\s*[:：]?\s*(\d{1,4})\s*(?:名|人|席)?$/);
  if (m) {
    const n = Number(m[1]);
    if (n > 0 && n <= 9999) return { kind: 'number', n };
  }
  return { kind: 'text', raw: s.slice(0, 120) };
}

const ordered = (v, s) => Object.entries(v).filter(([, x]) => x.s === s)
  .sort((a, b) => (a[1].seq || 0) - (b[1].seq || 0)).map(([id, x]) => ({ id, ...x }));

/** 人数。⚠️ 残席は「数の定員」があるときだけ出す（自由文・未設定は null）。 */
export function counts(state, capacityRaw) {
  const st = normalizeRsvp(state);
  const cap = parseCapacity(capacityRaw);
  const c = { going: 0, waitlist: 0, interested: 0, invited: 0, cancelled: 0 };
  for (const x of Object.values(st.v)) if (c[x.s] !== undefined) c[x.s]++;
  return {
    ...c,
    capacity: cap.kind === 'number' ? cap.n : null,
    capacityText: cap.kind === 'text' ? cap.raw : '',
    // ⚠️ 席を管理できないときは「残り0」と言わない。null（分からない）を返す。
    seatsLeft: cap.kind === 'number' ? Math.max(0, cap.n - c.going) : null,
    full: cap.kind === 'number' ? c.going >= cap.n : false,
  };
}

export function myState(state, staffId) {
  const st = normalizeRsvp(state);
  const x = st.v[str(staffId)];
  return x ? x.s : 'none';
}

/**
 * 参加・気になる・取消を反映する。**原子的に使うこと**（呼び出し側が CAS で書く）。
 *   want: 'going' | 'interested' | 'cancel' | 'invite'
 * 返り値 { ok, state, result, reason }
 *   result: 'going' | 'waitlist' | 'interested' | 'cancelled' | 'invited' | 'unchanged'
 *
 * ⚠️ 同じ人が連打しても席は1つしか取らない（冪等）。
 * ⚠️ 満席なら going にせず waitlist にする。勝手に定員を超えない。
 */
export function applyRsvp(state, input = {}) {
  const st = normalizeRsvp(state);
  const id = str(input.staffId);
  if (!id) return { ok: false, reason: 'no_staff' };
  const want = String(input.want || '');
  const at = toMs(input.at) || Date.now();
  const cap = parseCapacity(input.capacity);
  const cur = st.v[id] || null;

  const put = (s, keepSeq) => {
    const seq = (keepSeq && cur && cur.seq) ? cur.seq : st.n;
    const next = { v: { ...st.v, [id]: { s, at, seq, by: input.by === 'host' ? 'host' : 'self' } },
                   n: Math.max(st.n, seq + 1) };
    return next;
  };

  if (want === 'invite') {
    // 招待。⚠️ すでに本人が答えている（気になる・参加・待ち）なら**上書きしない**。
    if (cur && cur.s !== 'cancelled') return { ok: true, state: st, result: 'unchanged' };
    return { ok: true, state: put('invited'), result: 'invited' };
  }

  if (want === 'interested') {
    // ⚠️ 参加予定の人が「気になる」を押しても、参加を取り消さない（別操作）。
    if (cur && (cur.s === 'going' || cur.s === 'waitlist')) return { ok: true, state: st, result: 'unchanged', reason: 'already_going' };
    if (cur && cur.s === 'interested') return { ok: true, state: st, result: 'unchanged' };
    return { ok: true, state: put('interested'), result: 'interested' };
  }

  if (want === 'cancel') {
    if (!cur || cur.s === 'cancelled') return { ok: true, state: st, result: 'unchanged' };
    const freed = cur.s === 'going';
    let next = put('cancelled', true);
    // ⚠️ 席が空いたらキャンセル待ちの**先着順**で1人だけ繰り上げる。
    if (freed && cap.kind === 'number') {
      const p = promote(next, input.capacity, at);
      next = p.state;
      return { ok: true, state: next, result: 'cancelled', promoted: p.promoted };
    }
    return { ok: true, state: next, result: 'cancelled', promoted: null };
  }

  if (want === 'going') {
    if (cur && cur.s === 'going') return { ok: true, state: st, result: 'going' };       // 連打しても1席
    if (cur && cur.s === 'waitlist') return { ok: true, state: st, result: 'waitlist' }; // 二重に並ばせない
    const going = Object.values(st.v).filter(x => x.s === 'going').length;
    if (cap.kind === 'number' && going >= cap.n) {
      return { ok: true, state: put('waitlist'), result: 'waitlist' };
    }
    return { ok: true, state: put('going'), result: 'going' };
  }

  return { ok: false, reason: 'bad_want' };
}

/** キャンセル待ちの先頭を1人だけ繰り上げる。空きが無ければ何もしない。 */
export function promote(state, capacityRaw, at) {
  const st = normalizeRsvp(state);
  const cap = parseCapacity(capacityRaw);
  if (cap.kind !== 'number') return { state: st, promoted: null };
  const going = Object.values(st.v).filter(x => x.s === 'going').length;
  if (going >= cap.n) return { state: st, promoted: null };
  const wl = ordered(st.v, 'waitlist');
  if (!wl.length) return { state: st, promoted: null };
  const first = wl[0];
  return {
    state: { v: { ...st.v, [first.id]: { ...st.v[first.id], s: 'going', at: toMs(at) || Date.now() } }, n: st.n },
    promoted: first.id,
  };
}

/** 状態ごとの人数と、氏名の一覧（氏名は権限を確かめてから渡すこと）。 */
export function roster(state, people) {
  const st = normalizeRsvp(state);
  const byId = new Map(arr(people).filter(p => p && p.id).map(p => [String(p.id), p]));
  const out = { going: [], waitlist: [], interested: [], invited: [], cancelled: [] };
  for (const s of Object.keys(out)) {
    out[s] = ordered(st.v, s).map(x => {
      const p = byId.get(x.id) || {};
      return { id: x.id, name: String(p.name || ''), shop: String(p.shop || ''), at: x.at, by: x.by };
    });
  }
  return out;
}

/**
 * 氏名の一覧を見てよいか。
 * ⚠️ クライアントの申告（body.root など）を根拠にしない。サーバーが確かめた actor で判定する。
 * 本部の管理者（root / admin）か、そのイベントの主催者だけ。
 */
export function canSeeRoster(actor, event) {
  const a = actor || {};
  if (a.verified !== true) return false;
  if (['root', 'admin'].includes(String(a.role || ''))) return true;
  const owner = String((event && (event.ownerId || event.createdBy)) || '');
  return !!owner && String(a.id || '') === owner;
}

/**
 * チャットに入っているだけの人を、参加予定として扱わないための突き合わせ。
 * ⚠️ **members を根拠に出席や参加予定を確定しない。** 「出欠未回答」として返し、
 *    回答してもらう導線を画面側で出す。
 */
export function chatOnlyMembers(state, memberIds) {
  const st = normalizeRsvp(state);
  return [...new Set(arr(memberIds).map(String))].filter(id => id && !st.v[id]);
}
