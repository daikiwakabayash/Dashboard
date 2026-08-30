// ── サンクスギフト（感謝の投票）ロジック ─────────────────────────────
// スタッフが毎月1人だけ「お世話になった人」に感謝コメントを送る仕組み。
// 仕様:
//   ・1人につき月1票（複数人には送れない）。自分への投票は不可。1票=1ポイント。
//   ・同店/他店どちらにも送れる。匿名にはせず、誰からの投票か見える（記名）。
//   ・投票期間は毎月「1日00:01〜2日23:59（JST）」の2日間のみ。
//     この期間の投票は「前月（対象月）」に助けてくれた人への感謝として記録する。
//     例: 9月1日〜2日に投票 → 対象月=8月分。
//   ・月別に過去データとして蓄積する。
// 純粋関数のみ（保存は api/plan-store.js、表示は index.html）。tests/thanksgift.test.js でカバー。

export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// UTC基準の now を JST の壁時計に変換した Date（getUTC* で JSTの年月日時分が読める）
export function toJst(now) {
  const t = (now instanceof Date) ? now.getTime() : Number(now);
  return new Date(t + JST_OFFSET_MS);
}

// Date → 'YYYY-MM'（UTCゲッターで読む＝toJst後の壁時計）
export function ymOf(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// 'YYYY-MM' の前月（年跨ぎ対応）
export function prevYM(ym) {
  let [y, m] = String(ym).split('-').map(Number);
  m -= 1;
  if (m < 1) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

// 'YYYY-MM' → 表示ラベル（例 '2026-08' → '2026年8月'）
export function monthLabel(ym) {
  const [y, m] = String(ym).split('-');
  return `${y}年${Number(m)}月`;
}

// 現在の投票状態を返す。
//   open        : いま投票できるか（1日00:01〜2日23:59 JST）
//   targetMonth : 投票対象の月（＝前月・'YYYY-MM'）。感謝の対象となる稼働月。
//   votingYM    : 投票が行われている月（＝当月）。
//   nextOpenMonth: 次に投票できる月（表示用・'YYYY-MM'）
export function getVotingState(now = new Date()) {
  const jst = toJst(now);
  const day = jst.getUTCDate();
  const hh = jst.getUTCHours();
  const mm = jst.getUTCMinutes();
  const votingYM = ymOf(jst);
  const targetMonth = prevYM(votingYM);
  let open = false;
  if (day === 1) open = (hh > 0 || mm >= 1); // 1日は00:01以降
  else if (day === 2) open = true;           // 2日は終日（23:59まで）
  // それ以外（3日〜末日、1日00:00〜00:00）は投票不可
  const nextOpenMonth = open ? votingYM : ymOf(jst); // 参考値（当月）
  return { open, targetMonth, votingYM, nextOpenMonth, day };
}

// 決定的な投票ID（対象月×投票者＝1票に自然に制約）
export function voteId(period, fromStaffId) {
  return `${period}__${fromStaffId}`;
}

// 投票の妥当性チェック（1人1票・自分不可・必須項目）
export function validateVote(vote) {
  const v = vote || {};
  if (!v.period || !/^\d{4}-\d{2}$/.test(String(v.period))) return { ok: false, error: 'invalid_period' };
  if (!v.fromStaffId) return { ok: false, error: 'missing_from' };
  if (!v.toStaffId) return { ok: false, error: 'missing_to' };
  if (String(v.fromStaffId) === String(v.toStaffId)) return { ok: false, error: 'self_vote' };
  return { ok: true };
}

// 1人1票を保証して投票を反映（同一 対象月×投票者 の既存票を置き換えて追加）
export function upsertVote(votes, vote) {
  const list = Array.isArray(votes) ? votes : [];
  const id = voteId(vote.period, vote.fromStaffId);
  const rec = { ...vote, id };
  const next = list.filter(x => x && x.id !== id);
  next.push(rec);
  return next;
}

// 投票の取り消し（本人の対象月の票のみ）
export function removeVote(votes, period, fromStaffId) {
  const id = voteId(period, fromStaffId);
  return (Array.isArray(votes) ? votes : []).filter(x => x && x.id !== id);
}

// 受け取った票（誰から・内容）を対象月降順で返す。書かれなければ空。
export function receivedFor(votes, staffId) {
  const sid = String(staffId);
  return (Array.isArray(votes) ? votes : [])
    .filter(v => v && String(v.toStaffId) === sid)
    .sort((a, b) => (b.period || '').localeCompare(a.period || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
}

// ランキング集計（受け取ったポイント＝票数）。period 指定でその月のみ、未指定で全期間。
// 返り値: [{ toStaffId, toStaffName, toShop, points, voters:[{fromStaffId, fromStaffName, fromShop, comment, period, createdAt}] }] を points 降順。
export function tallyRanking(votes, period) {
  const list = (Array.isArray(votes) ? votes : []).filter(v => v && (!period || v.period === period));
  const map = {};
  for (const v of list) {
    const key = String(v.toStaffId);
    if (!map[key]) map[key] = { toStaffId: key, toStaffName: v.toStaffName || '', toShop: v.toShop || '', points: 0, voters: [] };
    map[key].points += 1;
    if (v.toStaffName) map[key].toStaffName = v.toStaffName;
    if (v.toShop) map[key].toShop = v.toShop;
    map[key].voters.push({
      fromStaffId: v.fromStaffId, fromStaffName: v.fromStaffName || '', fromShop: v.fromShop || '',
      comment: v.comment || '', period: v.period, createdAt: v.createdAt || '',
    });
  }
  return Object.values(map).sort((a, b) => b.points - a.points || String(a.toStaffName).localeCompare(String(b.toStaffName)));
}

// 全期間の一覧（対象月の降順ユニーク）
export function listPeriods(votes) {
  const set = new Set((Array.isArray(votes) ? votes : []).map(v => v && v.period).filter(Boolean));
  return [...set].sort((a, b) => b.localeCompare(a));
}
