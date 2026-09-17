import { describe, it, expect } from 'vitest';
import { startRun, finishRun, durationMs, listRuns, summarize, anomalies, RUN_STATUSES } from '../lib/agentlog.js';

const T0 = 1_760_000_000_000;
const mk = (over = {}) => startRun({
  agentName: 'Meta Ads Operator', action: 'analyze', reason: '日次巡回',
  source: 'cron', shop: '恵比寿院', ...over,
}, T0).run;

describe('agentlog - 開始', () => {
  it('agentName は必須', () => {
    expect(startRun({ action: 'analyze' }, T0).error).toBe('agent_name_required');
  });
  it('未知の action は拒否', () => {
    expect(startRun({ agentName: 'X', action: 'delete_everything' }, T0).error).toBe('unknown_action');
  });
  it('既定は running・必須フィールドが揃う', () => {
    const r = mk();
    expect(r.status).toBe('running');
    expect(r.startedAt).toBe(T0);
    expect(r.completedAt).toBeNull();
    expect(r.approvalRequired).toBe(false);
    expect(r.error).toBe('');
    expect(r.result).toBeNull();
  });
  it('未知の source は manual へ落とす', () => {
    expect(mk({ source: 'telepathy' }).source).toBe('manual');
    expect(mk({ source: 'webhook' }).source).toBe('webhook');
  });
});

describe('agentlog - 終了', () => {
  it('completed で result と所要時間が残る', () => {
    const f = finishRun(mk(), { status: 'completed', result: { checked: 8 } }, T0 + 4200);
    expect(f.ok).toBe(true);
    expect(f.run.status).toBe('completed');
    expect(f.run.result).toEqual({ checked: 8 });
    expect(durationMs(f.run)).toBe(4200);
  });
  it('failed で error が残る', () => {
    const f = finishRun(mk(), { status: 'failed', error: 'SalonOne 429' }, T0 + 100);
    expect(f.run.status).toBe('failed');
    expect(f.run.error).toBe('SalonOne 429');
  });
  it('二重終了を拒否する', () => {
    const done = finishRun(mk(), { status: 'completed' }, T0 + 1).run;
    expect(finishRun(done, { status: 'failed' }, T0 + 2).error).toBe('already_finished');
  });
  it('startRun の戻り値をそのまま渡す取り違えを拒否する', () => {
    const wrapper = startRun({ agentName: 'A', action: 'analyze' }, T0);   // {ok, run} であって run ではない
    expect(finishRun(wrapper, { status: 'completed' }, T0 + 1).error).toBe('invalid_run');
  });
  it('終端でない status は拒否する', () => {
    expect(finishRun(mk(), { status: 'running' }, T0 + 1).error).toBe('invalid_status');
  });
  it('usage は数値に矯正される', () => {
    const f = finishRun(mk(), { status: 'completed', usage: { tokensIn: '1200', tokensOut: -5, costJpy: 3.456, model: 'claude-sonnet-5' } }, T0 + 1);
    expect(f.run.usage).toEqual({ tokensIn: 1200, tokensOut: 0, costJpy: 3.46, model: 'claude-sonnet-5' });
  });
  it('未完了の所要時間は null', () => {
    expect(durationMs(mk())).toBeNull();
  });
});

describe('agentlog - 承認との紐付け', () => {
  it('提案時に approvalId を持てる', () => {
    const r = mk({ action: 'propose', approvalRequired: true });
    const f = finishRun(r, { status: 'completed', approvalId: 'ap_1', result: { proposed: 1 } }, T0 + 500);
    expect(f.run.approvalRequired).toBe(true);
    expect(f.run.approvalId).toBe('ap_1');
  });
});

describe('agentlog - 集計', () => {
  const rows = [
    finishRun(mk({ action: 'analyze' }), { status: 'completed', usage: { costJpy: 12 } }, T0 + 1).run,
    finishRun(mk({ action: 'propose', approvalRequired: true }), { status: 'completed', approvalId: 'ap_1', usage: { costJpy: 8 } }, T0 + 2).run,
    finishRun(mk({ action: 'detect' }), { status: 'failed', error: 'x' }, T0 + 3).run,
    mk({ action: 'sync' }),
  ];
  it('新しい順に並ぶ', () => {
    const l = listRuns(rows, {});
    expect(l.length).toBe(4);
    expect(l[0].startedAt).toBeGreaterThanOrEqual(l[1].startedAt);
  });
  it('status / action で絞れる', () => {
    expect(listRuns(rows, { status: 'failed' })).toHaveLength(1);
    expect(listRuns(rows, { action: 'propose' })).toHaveLength(1);
  });
  it('サマリーが実行中・提案・承認待ち・費用を出す', () => {
    const s = summarize(rows, 0, T0 + 10);
    expect(s.total).toBe(4);
    expect(s.completed).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.running).toBe(1);
    expect(s.proposals).toBe(1);
    expect(s.awaitingApproval).toBe(1);
    expect(s.costJpy).toBe(20);
    expect(s.agents['Meta Ads Operator']).toBe(4);
  });
});

describe('agentlog - 異常検知', () => {
  it('連続失敗を拾う', () => {
    const fails = [3, 2, 1].map(i => finishRun(startRun({ agentName: 'A', action: 'analyze' }, T0 + i).run, { status: 'failed', error: 'e' }, T0 + i + 1).run);
    expect(anomalies(fails, { failStreak: 3 })).toEqual([{ kind: 'fail_streak', agentName: 'A', count: 3 }]);
  });
  it('成功が挟まれば連続失敗ではない', () => {
    const rows = [
      finishRun(startRun({ agentName: 'A', action: 'analyze' }, T0 + 3).run, { status: 'completed' }, T0 + 4).run,
      finishRun(startRun({ agentName: 'A', action: 'analyze' }, T0 + 2).run, { status: 'failed', error: 'e' }, T0 + 3).run,
      finishRun(startRun({ agentName: 'A', action: 'analyze' }, T0 + 1).run, { status: 'failed', error: 'e' }, T0 + 2).run,
    ];
    expect(anomalies(rows, { failStreak: 2 })).toEqual([]);
  });
  it('日次コスト超過を拾う', () => {
    const rows = [finishRun(startRun({ agentName: 'A', action: 'analyze' }, T0).run, { status: 'completed', usage: { costJpy: 900 } }, T0 + 1).run];
    const a = anomalies(rows, { dailyCostLimitJpy: 500, now: T0 + 1000 });
    expect(a[0]).toEqual({ kind: 'cost_over', costJpy: 900, limitJpy: 500 });
  });
});
