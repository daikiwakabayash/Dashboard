// ── 承認センター データモデル ──────────────────────────────────────
// AI（またはルールエンジン）が出した「操作の提案」を、人が承認/却下/修正依頼するための器。
// 実行そのものはここでは行わない。ここが持つのは「提案 → 判断 → 実行結果の記録」だけ。
//
// 設計方針:
//  1. **エージェントは承認者になれない**（naoru-ai-platform/AGENTS.md §5 と同じ原則）。
//     decide() は actor.role が承認可能ロールであることを要求する。
//  2. **承認後に内容が変わったら承認は無効**。提案内容の contentHash を保存し、
//     実行直前に再検証する（差し替え・宛先すり替えを防ぐ）。
//  3. **期限切れは承認できない**。expiresAt を過ぎた提案は expired。
//  4. 履歴は追記のみ（history）。状態は上書きするが、経緯は消えない。

export const APPROVAL_KEY = 'naoru:cc:approval:v1';
export const APPROVAL_CAP = 1000;              // 保持する最大件数（古いものから破棄）

// 承認対象の操作種別。将来ここに足していく（UIは kind を知らなくても表示できる作り）。
export const APPROVAL_KINDS = Object.freeze({
  meta_budget_change:  { label: 'Meta 予算変更',      group: 'meta',      defaultRisk: 'medium' },
  meta_pause:          { label: 'Meta 広告停止',      group: 'meta',      defaultRisk: 'medium' },
  meta_resume:         { label: 'Meta 広告再開',      group: 'meta',      defaultRisk: 'medium' },
  creative_replace:    { label: 'Creative 差し替え',  group: 'meta',      defaultRisk: 'medium' },
  knowledge_publish:   { label: 'Knowledge 正式版変更', group: 'knowledge', defaultRisk: 'high' },
  sns_post:            { label: 'SNS 投稿',           group: 'content',   defaultRisk: 'high' },
  lp_change:           { label: 'LP 変更',            group: 'content',   defaultRisk: 'high' },
});

export const RISKS = Object.freeze(['low', 'medium', 'high']);

// 状態。terminal = これ以上動かない。
export const STATUSES = Object.freeze({
  pending:           { label: '承認待ち',   terminal: false },
  changes_requested: { label: '修正依頼中', terminal: false },
  approved:          { label: '承認済み',   terminal: false },  // → executed / failed へ進む
  rejected:          { label: '却下',       terminal: true },
  expired:           { label: '期限切れ',   terminal: true },
  executed:          { label: '実行済み',   terminal: true },
  failed:            { label: '実行失敗',   terminal: true },
});

// 許可する状態遷移。ここに無い遷移は必ず拒否する。
const TRANSITIONS = Object.freeze({
  pending:           ['approved', 'rejected', 'changes_requested', 'expired'],
  changes_requested: ['pending', 'rejected', 'expired'],
  approved:          ['executed', 'failed', 'expired'],
  rejected:          [],
  expired:           [],
  executed:          [],
  failed:            [],
});

// 承認できるロール。staff は承認できない。エージェントは actor.source==='agent' で弾く。
const APPROVER_ROLES = Object.freeze(['root', 'hq', 'owner']);

export function canTransition(from, to) {
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

export function isApprover(actor) {
  if (!actor || typeof actor !== 'object') return false;
  if (actor.source === 'agent') return false;             // エージェントは承認者になれない
  return APPROVER_ROLES.includes(String(actor.role || ''));
}

// 提案内容のハッシュ。承認後に payload/scope/kind が変わったことを検出する。
// 暗号学的強度は不要（改ざん検知ではなく「変わったか」の検出）。決定的であることが要件。
export function contentHash(proposal) {
  const canon = JSON.stringify({
    kind: proposal && proposal.kind,
    scope: sortedClone(proposal && proposal.scope),
    payload: sortedClone(proposal && proposal.payload),
  });
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < canon.length; i++) {
    const c = canon.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
}

// キー順を固定してJSON化するためのクローン（キーの並びでhashが変わらないように）
function sortedClone(v) {
  if (v == null || typeof v !== 'object') return v === undefined ? null : v;
  if (Array.isArray(v)) return v.map(sortedClone);
  const out = {};
  for (const k of Object.keys(v).sort()) out[k] = sortedClone(v[k]);
  return out;
}

const nowMs = (now) => (typeof now === 'number' ? now : Date.now());
const str = (v, n) => String(v == null ? '' : v).slice(0, n);

// 新しい承認リクエストを組み立てる。保存は呼び出し側。
// 戻り値 { ok, approval } / { ok:false, error }
export function buildApproval(input, now) {
  const t = nowMs(now);
  const kind = str(input && input.kind, 40);
  if (!APPROVAL_KINDS[kind]) return { ok: false, error: 'unknown_kind' };
  const title = str(input && input.title, 160);
  if (!title) return { ok: false, error: 'title_required' };

  const ttlMs = Number(input && input.ttlMs);
  const expiresAt = t + (Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 7 * 24 * 3600 * 1000); // 既定7日
  const risk = RISKS.includes(input && input.risk) ? input.risk : APPROVAL_KINDS[kind].defaultRisk;

  const proposal = {
    kind,
    scope: (input && input.scope && typeof input.scope === 'object') ? input.scope : {},
    payload: (input && input.payload && typeof input.payload === 'object') ? input.payload : {},
  };

  const approval = {
    id: str(input && input.id, 60) || `ap_${t.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: t,
    updatedAt: t,
    kind,
    title,
    summary: str(input && input.summary, 1200),
    scope: proposal.scope,
    payload: proposal.payload,               // { before, after } を想定
    expectedEffect: (input && input.expectedEffect && typeof input.expectedEffect === 'object') ? input.expectedEffect : null,
    risk,
    status: 'pending',
    expiresAt,
    contentHash: contentHash(proposal),
    proposedBy: {
      agent: str(input && input.proposedBy && input.proposedBy.agent, 60),
      runId: str(input && input.proposedBy && input.proposedBy.runId, 60),
      actorId: str(input && input.proposedBy && input.proposedBy.actorId, 60),
      actorName: str(input && input.proposedBy && input.proposedBy.actorName, 80),
    },
    decidedBy: null, decidedAt: null, decisionNote: '',
    executedAt: null, executionResult: null, error: '',
    history: [{ at: t, status: 'pending', by: str(input && input.proposedBy && input.proposedBy.agent, 60) || 'system', note: '提案を作成' }],
  };
  return { ok: true, approval };
}

// 期限切れを反映した「実効ステータス」。保存値を書き換えずに判定したいときに使う。
export function effectiveStatus(approval, now) {
  if (!approval) return 'expired';
  const s = String(approval.status || '');
  if (STATUSES[s] && STATUSES[s].terminal) return s;
  if (s === 'approved' || s === 'pending' || s === 'changes_requested') {
    if (Number(approval.expiresAt) > 0 && nowMs(now) > Number(approval.expiresAt)) return 'expired';
  }
  return s;
}

// 人が判断する（approve / reject / request_changes）。
// 戻り値 { ok, approval } / { ok:false, error }
export function decide(approval, action, actor, opts, now) {
  const t = nowMs(now);
  if (!approval) return { ok: false, error: 'not_found' };
  if (!isApprover(actor)) return { ok: false, error: 'not_authorized' };

  const cur = effectiveStatus(approval, t);
  if (cur === 'expired' && approval.status !== 'expired') {
    return { ok: false, error: 'expired', approval: { ...approval, status: 'expired', updatedAt: t,
      history: [...(approval.history || []), { at: t, status: 'expired', by: 'system', note: '期限切れ' }] } };
  }

  const to = action === 'approve' ? 'approved'
           : action === 'reject' ? 'rejected'
           : action === 'request_changes' ? 'changes_requested'
           : '';
  if (!to) return { ok: false, error: 'unknown_action' };
  if (!canTransition(cur, to)) return { ok: false, error: `invalid_transition:${cur}->${to}` };

  // 承認は「見たときの内容」に対して行われる。提案が差し替わっていたら承認させない。
  const seen = opts && opts.seenHash;
  if (to === 'approved' && seen && seen !== approval.contentHash) {
    return { ok: false, error: 'content_changed' };
  }
  // 高リスクは提案者本人が承認できない（作成者と承認者の分離）
  if (to === 'approved' && approval.risk === 'high') {
    const proposer = approval.proposedBy && approval.proposedBy.actorId;
    if (proposer && String(proposer) === String(actor.id || '')) return { ok: false, error: 'self_approval_forbidden' };
  }

  const note = str(opts && opts.note, 1000);
  if (to === 'changes_requested' && !note) return { ok: false, error: 'note_required' };

  const next = {
    ...approval,
    status: to,
    updatedAt: t,
    decidedBy: { id: str(actor.id, 60), name: str(actor.name, 80), role: str(actor.role, 20) },
    decidedAt: t,
    decisionNote: note,
    history: [...(approval.history || []), { at: t, status: to, by: str(actor.name || actor.id, 80), note }],
  };
  return { ok: true, approval: next };
}

// 修正して再提案（changes_requested → pending）。内容が変わるので contentHash を振り直す。
export function repropose(approval, patch, actor, now) {
  const t = nowMs(now);
  if (!approval) return { ok: false, error: 'not_found' };
  const cur = effectiveStatus(approval, t);
  if (!canTransition(cur, 'pending')) return { ok: false, error: `invalid_transition:${cur}->pending` };

  const proposal = {
    kind: approval.kind,
    scope: (patch && patch.scope) || approval.scope,
    payload: (patch && patch.payload) || approval.payload,
  };
  const next = {
    ...approval,
    scope: proposal.scope,
    payload: proposal.payload,
    summary: patch && patch.summary != null ? str(patch.summary, 1200) : approval.summary,
    status: 'pending',
    updatedAt: t,
    contentHash: contentHash(proposal),
    decidedBy: null, decidedAt: null, decisionNote: '',
    history: [...(approval.history || []), { at: t, status: 'pending', by: str(actor && (actor.name || actor.id), 80), note: '修正して再提案' }],
  };
  return { ok: true, approval: next };
}

// 実行結果の記録（approved → executed / failed）。実行そのものは呼び出し側の責務。
// 実行直前に contentHash を再検証する（承認時と中身が違えば実行させない）。
export function recordExecution(approval, result, now) {
  const t = nowMs(now);
  if (!approval) return { ok: false, error: 'not_found' };
  const cur = effectiveStatus(approval, t);
  const to = (result && result.ok) ? 'executed' : 'failed';
  if (!canTransition(cur, to)) return { ok: false, error: `invalid_transition:${cur}->${to}` };

  const expected = contentHash({ kind: approval.kind, scope: approval.scope, payload: approval.payload });
  if (expected !== approval.contentHash) return { ok: false, error: 'content_changed' };

  const next = {
    ...approval,
    status: to,
    updatedAt: t,
    executedAt: t,
    executionResult: (result && result.detail != null) ? result.detail : null,
    error: to === 'failed' ? str(result && result.error, 500) : '',
    history: [...(approval.history || []), { at: t, status: to, by: 'system', note: to === 'executed' ? '実行完了' : `実行失敗: ${str(result && result.error, 200)}` }],
  };
  return { ok: true, approval: next };
}

// 一覧の絞り込み・並び替え。UIはこれを使う（期限切れは実効ステータスで判定）。
export function listApprovals(all, filter, now) {
  const t = nowMs(now);
  const f = filter || {};
  let rows = (Array.isArray(all) ? all : []).map(a => ({ ...a, status: effectiveStatus(a, t) }));
  if (f.status && f.status !== 'all') rows = rows.filter(a => a.status === f.status);
  if (f.kind && f.kind !== 'all') rows = rows.filter(a => a.kind === f.kind);
  if (f.group && f.group !== 'all') rows = rows.filter(a => (APPROVAL_KINDS[a.kind] || {}).group === f.group);
  if (f.shop) rows = rows.filter(a => String((a.scope || {}).shop || '') === String(f.shop));
  // 承認待ち → 期限が近い順。それ以外は更新が新しい順。
  rows.sort((a, b) => {
    const pa = a.status === 'pending' ? 0 : 1, pb = b.status === 'pending' ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (pa === 0) return (a.expiresAt || 0) - (b.expiresAt || 0);
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  return rows;
}

// 未処理件数（バッジ用）
export function pendingCount(all, now) {
  const t = nowMs(now);
  return (Array.isArray(all) ? all : []).filter(a => {
    const s = effectiveStatus(a, t);
    return s === 'pending' || s === 'changes_requested';
  }).length;
}
