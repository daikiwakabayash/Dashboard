// ── 手当（領収書）の保存ロジック ───────────────────────────────
//
// 【直したい問題】
// 手当は naoru:allowance:v1 に { submissions:[…], productivity:{…} } を1つの塊で持っていた。
// 提出も生産性の記録も、毎回「全部読む → 編集 → 全部書き戻す」方式だった。
//
// 特に危ないのが **recordProductivity**。これは本部が返金明細書を表示するたびに
// 個人別の売上を記録するため呼ばれる。つまり
//
//   スタッフ: 読む {submissions:[A,B]} ──提出──> 書く {submissions:[A,B,C]}
//   本部    : 読む {submissions:[A,B]} ──明細表示──> 書く {submissions:[A,B], productivity:…}  ← C が消える
//
// 提出は**毎月2日23:59の締切前に集中**し、消えると返金明細書に計上されない＝金銭影響が出る。
//
// 【方針】
//   1. 提出は **追記専用ログ**（naoru:allowance:log:v1）に積む。上書きをしないので消えない。
//      現在の状態はログを畳んで求める（同じidは後勝ち、delete は取り消し）。
//   2. 生産性は **別キー**（naoru:allowance:prod:v1）。提出データに一切触れない。
//   3. 移行期間は旧blobとログの両方を読む。旧blobへも提出を書き続ける（Rollback用の写し）。
//
// 【なぜ消えないのか】
//   追記は「配列の末尾に足す」だけで、既存の要素を読んで書き直さない。
//   KVでは Lua で原子的に追記するため、同時に何人が提出しても互いを踏まない。

export const ALLOWANCE_LOG_KEY = 'naoru:allowance:log:v1';
export const ALLOWANCE_PROD_KEY = 'naoru:allowance:prod:v1';
export const ALLOWANCE_LOG_CAP = 5000;   // ログの保持件数。溢れた分は旧blob側の写しに残る

const str = (v, n) => String(v == null ? '' : v).slice(0, n);

// ログ1件を作る。op は 'submit' か 'delete'。
export function makeEntry(op, payload, now) {
  const at = typeof now === 'number' ? now : Date.now();
  if (op === 'delete') {
    // payload は { id } か id そのもの。オブジェクトをそのまま String() すると
    // "[object Object]" というゴミidでログを汚すため、文字列/数値のときだけ直接値として扱う。
    const raw = (payload && typeof payload === 'object') ? payload.id
              : (typeof payload === 'string' || typeof payload === 'number') ? payload : '';
    const id = str(raw, 80);
    return id ? { op: 'delete', id, at } : null;
  }
  const s = (payload && typeof payload === 'object') ? payload : null;
  const id = s ? str(s.id, 80) : '';
  return id ? { op: 'submit', id, at, submission: { ...s, id } } : null;
}

// ログを畳んで「今の提出一覧」を求める。
// 同じ id は**後の方が勝つ**。delete が来ていたら消える。
export function foldLog(entries) {
  const byId = new Map();
  const deleted = new Set();
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (!e || !e.id) continue;
    const id = String(e.id);
    if (e.op === 'delete') { deleted.add(id); byId.delete(id); continue; }
    if (e.op === 'submit' && e.submission) { deleted.delete(id); byId.set(id, e.submission); }
  }
  return { byId, deleted };
}

// 旧blobの submissions と ログを合成する。**ログが勝つ**（新しいため）。
// ログの delete は旧blob側の提出も取り消す。
export function mergeSubmissions(legacy, entries) {
  const { byId, deleted } = foldLog(entries);
  const out = [];
  const seen = new Set();
  for (const s of (Array.isArray(legacy) ? legacy : [])) {
    if (!s || !s.id) continue;
    const id = String(s.id);
    if (deleted.has(id)) continue;          // ログで取り消されている
    if (byId.has(id)) { out.push(byId.get(id)); }  // ログの方が新しい
    else { out.push(s); }
    seen.add(id);
  }
  for (const [id, s] of byId) if (!seen.has(id)) out.push(s);   // ログにしか無いもの
  return out;
}

// 同じ内容の再送かどうか（二重送信の検出）。内容が変わっていれば別物として扱う。
export function isDuplicateSubmit(entries, submission) {
  if (!submission || !submission.id) return false;
  const { byId } = foldLog(entries);
  const prev = byId.get(String(submission.id));
  if (!prev) return false;
  return stableJson(prev) === stableJson({ ...submission, id: String(submission.id) });
}

function stableJson(v) {
  if (v == null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
}

// ── 生産性（別キー）──────────────────────────────────────────
// { staffId: { 'YYYY-MM': 金額 } }
export function normalizeProductivity(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let n = 0;
  for (const [staffId, months] of Object.entries(raw)) {
    if (n++ >= 3000) break;
    if (!months || typeof months !== 'object' || Array.isArray(months)) continue;
    const id = str(staffId, 64);
    if (!id) continue;
    const m = {};
    for (const [month, gross] of Object.entries(months)) {
      if (!/^\d{4}-\d{2}$/.test(String(month))) continue;
      const g = Number(gross);
      if (Number.isFinite(g)) m[String(month)] = g;
    }
    if (Object.keys(m).length) out[id] = m;
  }
  return out;
}

// 旧blob内の productivity と新キーを合成する。**新キーが勝つ**。
export function mergeProductivity(legacy, split) {
  const a = normalizeProductivity(legacy);
  const b = normalizeProductivity(split);
  const out = {};
  for (const [id, months] of Object.entries(a)) out[id] = { ...months };
  for (const [id, months] of Object.entries(b)) out[id] = { ...(out[id] || {}), ...months };
  return out;
}

// 1人・1ヶ月ぶんだけ更新する（他の人・他の月に触れない）。
export function bumpProductivity(prod, staffId, month, gross) {
  const cur = normalizeProductivity(prod);
  const id = str(staffId, 64);
  const m = String(month || '');
  if (!id || !/^\d{4}-\d{2}$/.test(m)) return cur;
  const g = Number(gross);
  cur[id] = { ...(cur[id] || {}), [m]: Number.isFinite(g) ? g : 0 };
  return cur;
}
