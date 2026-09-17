import { describe, it, expect } from 'vitest';
import {
  buildApproval, decide, repropose, recordExecution, effectiveStatus,
  canTransition, isApprover, contentHash, listApprovals, pendingCount, APPROVAL_KINDS,
} from '../lib/approvals.js';

const T0 = 1_760_000_000_000;
const root = { id: 'u1', name: '本部 若林', role: 'root' };
const owner = { id: 'u2', name: 'オーナーA', role: 'owner' };
const staff = { id: 'u3', name: 'セラピストB', role: 'staff' };
const agent = { id: 'a1', name: 'Meta Ads Operator', role: 'root', source: 'agent' };

const mk = (over = {}) => buildApproval({
  kind: 'meta_budget_change', title: '恵比寿院 日予算を 12,000 → 8,000 に',
  scope: { shop: '恵比寿院', campaignId: 'c_123' },
  payload: { before: { dailyBudget: 12000 }, after: { dailyBudget: 8000 } },
  proposedBy: { agent: 'Meta Ads Operator', runId: 'run_1', actorId: 'a1' },
  ...over,
}, T0).approval;

describe('approvals - 作成', () => {
  it('必須項目を検証する', () => {
    expect(buildApproval({ kind: 'nope', title: 'x' }, T0).error).toBe('unknown_kind');
    expect(buildApproval({ kind: 'meta_pause', title: '' }, T0).error).toBe('title_required');
  });
  it('既定で pending・7日期限・contentHash 付き', () => {
    const a = mk();
    expect(a.status).toBe('pending');
    expect(a.expiresAt).toBe(T0 + 7 * 24 * 3600 * 1000);
    expect(a.contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(a.history).toHaveLength(1);
  });
  it('kind ごとの既定リスクが入る', () => {
    expect(mk({ kind: 'sns_post', title: 'x' }).risk).toBe('high');
    expect(mk({ kind: 'meta_pause', title: 'x' }).risk).toBe('medium');
  });
});

describe('approvals - contentHash', () => {
  it('キーの並び順が違っても同じハッシュになる', () => {
    const h1 = contentHash({ kind: 'k', scope: { a: 1, b: 2 }, payload: { x: 1 } });
    const h2 = contentHash({ kind: 'k', scope: { b: 2, a: 1 }, payload: { x: 1 } });
    expect(h1).toBe(h2);
  });
  it('中身が変われば変わる', () => {
    const h1 = contentHash({ kind: 'k', scope: {}, payload: { dailyBudget: 8000 } });
    const h2 = contentHash({ kind: 'k', scope: {}, payload: { dailyBudget: 9000 } });
    expect(h1).not.toBe(h2);
  });
});

describe('approvals - 承認者の制限', () => {
  it('root / hq / owner は承認できる', () => {
    expect(isApprover(root)).toBe(true);
    expect(isApprover(owner)).toBe(true);
    expect(isApprover({ role: 'hq' })).toBe(true);
  });
  it('staff は承認できない', () => {
    expect(isApprover(staff)).toBe(false);
    expect(decide(mk(), 'approve', staff, {}, T0).error).toBe('not_authorized');
  });
  it('エージェントは承認者になれない（roleがrootでも）', () => {
    expect(isApprover(agent)).toBe(false);
    expect(decide(mk(), 'approve', agent, {}, T0).error).toBe('not_authorized');
  });
});

describe('approvals - 状態遷移', () => {
  it('許可された遷移のみ通す', () => {
    expect(canTransition('pending', 'approved')).toBe(true);
    expect(canTransition('rejected', 'approved')).toBe(false);
    expect(canTransition('executed', 'pending')).toBe(false);
  });
  it('承認 → 実行記録まで進む', () => {
    const a = mk();
    const ap = decide(a, 'approve', root, { seenHash: a.contentHash }, T0 + 1000);
    expect(ap.ok).toBe(true);
    expect(ap.approval.status).toBe('approved');
    expect(ap.approval.decidedBy.name).toBe('本部 若林');
    const ex = recordExecution(ap.approval, { ok: true, detail: { applied: true } }, T0 + 2000);
    expect(ex.ok).toBe(true);
    expect(ex.approval.status).toBe('executed');
    expect(ex.approval.executedAt).toBe(T0 + 2000);
  });
  it('却下は終端で、そこから承認できない', () => {
    const r = decide(mk(), 'reject', root, { note: '予算据え置き' }, T0 + 1000);
    expect(r.approval.status).toBe('rejected');
    expect(decide(r.approval, 'approve', root, {}, T0 + 2000).error).toMatch(/invalid_transition/);
  });
  it('修正依頼には理由が必須', () => {
    expect(decide(mk(), 'request_changes', root, {}, T0).error).toBe('note_required');
    const ok = decide(mk(), 'request_changes', root, { note: '減額幅が大きすぎる' }, T0);
    expect(ok.approval.status).toBe('changes_requested');
  });
  it('修正して再提案すると pending に戻り hash が更新される', () => {
    const cr = decide(mk(), 'request_changes', root, { note: '減額幅が大きい' }, T0).approval;
    const re = repropose(cr, { payload: { before: { dailyBudget: 12000 }, after: { dailyBudget: 10000 } } }, root, T0 + 500);
    expect(re.ok).toBe(true);
    expect(re.approval.status).toBe('pending');
    expect(re.approval.contentHash).not.toBe(cr.contentHash);
    expect(re.approval.decidedBy).toBeNull();
  });
  it('実行失敗は failed になり error が残る', () => {
    const a = mk();
    const ap = decide(a, 'approve', root, {}, T0 + 1).approval;
    const ex = recordExecution(ap, { ok: false, error: 'Meta API 429' }, T0 + 2);
    expect(ex.approval.status).toBe('failed');
    expect(ex.approval.error).toBe('Meta API 429');
  });
});

describe('approvals - 安全側の拒否', () => {
  it('期限切れは承認できない', () => {
    const a = mk({ ttlMs: 1000 });
    expect(effectiveStatus(a, T0 + 5000)).toBe('expired');
    const r = decide(a, 'approve', root, {}, T0 + 5000);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('expired');
    expect(r.approval.status).toBe('expired');   // 呼び出し側が保存できるよう返す
  });
  it('見ていた内容と違えば承認を拒否する（差し替え防止）', () => {
    const a = mk();
    const r = decide(a, 'approve', root, { seenHash: 'deadbeefdeadbeef' }, T0 + 1);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('content_changed');
  });
  it('高リスクは提案者本人が承認できない', () => {
    const a = mk({ kind: 'sns_post', title: 'X投稿', proposedBy: { agent: 'X', runId: 'r', actorId: 'u1' } });
    expect(a.risk).toBe('high');
    const r = decide(a, 'approve', root, {}, T0 + 1);   // root.id === 'u1' === 提案者
    expect(r.error).toBe('self_approval_forbidden');
    expect(decide(a, 'approve', owner, {}, T0 + 1).ok).toBe(true);  // 別人ならOK
  });
  it('承認後に payload が書き換えられていたら実行させない', () => {
    const a = mk();
    const ap = decide(a, 'approve', root, {}, T0 + 1).approval;
    const tampered = { ...ap, payload: { before: { dailyBudget: 12000 }, after: { dailyBudget: 1 } } };
    expect(recordExecution(tampered, { ok: true }, T0 + 2).error).toBe('content_changed');
  });
});

describe('approvals - 一覧', () => {
  const rows = [
    mk({ id: 'a', ttlMs: 5 * 24 * 3600 * 1000 }),
    mk({ id: 'b', ttlMs: 2 * 24 * 3600 * 1000 }),
    decide(mk({ id: 'c' }), 'reject', root, { note: 'no' }, T0 + 10).approval,
    mk({ id: 'd', kind: 'sns_post', title: 'X投稿', scope: { shop: '千葉駅院' } }),
  ];
  it('承認待ちを先頭に、期限が近い順で並べる', () => {
    const l = listApprovals(rows, {}, T0 + 100);
    expect(l[0].id).toBe('b');            // 期限2日が最短
    expect(l[l.length - 1].id).toBe('c'); // 却下済みは後ろ
  });
  it('kind / group / shop で絞れる', () => {
    expect(listApprovals(rows, { kind: 'sns_post' }, T0).map(r => r.id)).toEqual(['d']);
    expect(listApprovals(rows, { group: 'meta' }, T0).every(r => APPROVAL_KINDS[r.kind].group === 'meta')).toBe(true);
    expect(listApprovals(rows, { shop: '千葉駅院' }, T0).map(r => r.id)).toEqual(['d']);
  });
  it('未処理件数に期限切れを含めない', () => {
    expect(pendingCount(rows, T0 + 100)).toBe(3);
    expect(pendingCount(rows, T0 + 10 * 24 * 3600 * 1000)).toBe(0);  // 全部期限切れ
  });
});
