// ── AI Agent Activity ログ データモデル ────────────────────────────
// エージェント（Meta Ads Operator 等）が「いつ・何を見て・何を提案し・何が起きたか」を残す。
// 目的は3つ:
//   1. 暴走の検知（想定外の action が並んでいないか）
//   2. コストの可視化（tokens / cost を積む）
//   3. 承認センターとの突き合わせ（approvalId で提案 → 判断 → 実行が繋がる）
//
// ⚠️ ここに本文・顧客情報・秘密を書かない（naoru-ai-platform/PERMISSIONS.md §7 と同じ制約）。
//    reason / result は「要約」であって原文ではない。

export const AGENTLOG_KEY = 'naoru:cc:agentlog:v1';
export const AGENTLOG_CAP = 2000;

// status は naoru-ai-platform/AGENTS.md §5 の実行状態に合わせる。
export const RUN_STATUSES = Object.freeze({
  queued:    { label: '待機中',   terminal: false },
  running:   { label: '実行中',   terminal: false },
  completed: { label: '完了',     terminal: true },
  failed:    { label: '失敗',     terminal: true },
  cancelled: { label: '中止',     terminal: true },
});

// action の分類。UIの色分けとフィルタに使う。
export const ACTION_KINDS = Object.freeze({
  analyze:  { label: '分析',       tone: 'neutral' },
  detect:   { label: '異常検知',   tone: 'warn' },
  propose:  { label: '提案',       tone: 'info' },
  draft:    { label: '下書き作成', tone: 'info' },
  notify:   { label: '通知',       tone: 'neutral' },
  execute:  { label: '実行',       tone: 'danger' },
  sync:     { label: '同期',       tone: 'neutral' },
});

// source = 何をきっかけに動いたか
export const SOURCES = Object.freeze(['cron', 'manual', 'rule', 'chat', 'webhook', 'approval']);

const nowMs = (now) => (typeof now === 'number' ? now : Date.now());
const str = (v, n) => String(v == null ? '' : v).slice(0, n);

// 実行開始を記録する（queued または running）。
export function startRun(input, now) {
  const t = nowMs(now);
  const agentName = str(input && input.agentName, 60);
  if (!agentName) return { ok: false, error: 'agent_name_required' };
  const action = str(input && input.action, 40);
  if (!ACTION_KINDS[action]) return { ok: false, error: 'unknown_action' };

  return {
    ok: true,
    run: {
      id: str(input && input.id, 60) || `run_${t.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      agentName,
      action,
      reason: str(input && input.reason, 800),           // なぜ動いたか（要約）
      source: SOURCES.includes(input && input.source) ? input.source : 'manual',
      status: (input && input.status === 'queued') ? 'queued' : 'running',
      startedAt: t,
      completedAt: null,
      approvalRequired: !!(input && input.approvalRequired),
      approvalId: str(input && input.approvalId, 60) || null,
      shop: str(input && input.shop, 60),
      scope: (input && input.scope && typeof input.scope === 'object') ? input.scope : {},
      result: null,
      error: '',
      usage: null,                                        // { tokensIn, tokensOut, costJpy, model }
    },
  };
}

// 実行終了を記録する。status は completed / failed / cancelled のみ。
export function finishRun(run, outcome, now) {
  const t = nowMs(now);
  if (!run) return { ok: false, error: 'not_found' };
  // startRun() の戻り値 {ok, run} をそのまま渡す取り違えを黙って通さない。
  // 通すと agentName の無い壊れた行がログに積まれ、集計・異常検知が静かに狂う。
  if (!run.agentName || !Number.isFinite(Number(run.startedAt))) return { ok: false, error: 'invalid_run' };
  if (RUN_STATUSES[run.status] && RUN_STATUSES[run.status].terminal) {
    return { ok: false, error: 'already_finished' };
  }
  const status = (outcome && outcome.status) || 'completed';
  if (!RUN_STATUSES[status] || !RUN_STATUSES[status].terminal) return { ok: false, error: 'invalid_status' };

  return {
    ok: true,
    run: {
      ...run,
      status,
      completedAt: t,
      result: (outcome && outcome.result != null) ? outcome.result : null,
      error: status === 'failed' ? str(outcome && outcome.error, 500) : '',
      approvalId: str((outcome && outcome.approvalId) || run.approvalId, 60) || null,
      approvalRequired: outcome && outcome.approvalRequired != null ? !!outcome.approvalRequired : !!run.approvalRequired,
      usage: normalizeUsage(outcome && outcome.usage),
    },
  };
}

function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : 0);
  return {
    tokensIn: n(u.tokensIn), tokensOut: n(u.tokensOut),
    costJpy: Number.isFinite(Number(u.costJpy)) ? Math.round(Number(u.costJpy) * 100) / 100 : 0,
    model: str(u.model, 60),
  };
}

// 所要時間(ms)。未完了なら null。
export function durationMs(run) {
  if (!run || !run.completedAt || !run.startedAt) return null;
  const d = Number(run.completedAt) - Number(run.startedAt);
  return Number.isFinite(d) && d >= 0 ? d : null;
}

// 一覧の絞り込み・並び替え（新しい順）
export function listRuns(all, filter) {
  const f = filter || {};
  let rows = Array.isArray(all) ? all.slice() : [];
  if (f.agentName && f.agentName !== 'all') rows = rows.filter(r => r.agentName === f.agentName);
  if (f.status && f.status !== 'all') rows = rows.filter(r => r.status === f.status);
  if (f.action && f.action !== 'all') rows = rows.filter(r => r.action === f.action);
  if (f.source && f.source !== 'all') rows = rows.filter(r => r.source === f.source);
  if (f.shop) rows = rows.filter(r => String(r.shop || '') === String(f.shop));
  if (f.since) rows = rows.filter(r => Number(r.startedAt || 0) >= Number(f.since));
  rows.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return rows;
}

// 期間サマリー（今日の活動を1行で言えるようにする）
export function summarize(all, sinceMs, now) {
  const t = nowMs(now);
  const since = Number.isFinite(Number(sinceMs)) ? Number(sinceMs) : 0;
  const rows = (Array.isArray(all) ? all : []).filter(r => Number(r.startedAt || 0) >= since);
  const out = {
    total: rows.length, running: 0, completed: 0, failed: 0, cancelled: 0,
    proposals: 0, awaitingApproval: 0, executed: 0, costJpy: 0, agents: {},
  };
  for (const r of rows) {
    if (r.status === 'running' || r.status === 'queued') out.running++;
    else if (r.status === 'completed') out.completed++;
    else if (r.status === 'failed') out.failed++;
    else if (r.status === 'cancelled') out.cancelled++;
    if (r.action === 'propose') out.proposals++;
    if (r.approvalRequired && r.approvalId) out.awaitingApproval++;
    if (r.action === 'execute' && r.status === 'completed') out.executed++;
    if (r.usage && Number.isFinite(Number(r.usage.costJpy))) out.costJpy += Number(r.usage.costJpy);
    const k = String(r.agentName || '不明');
    out.agents[k] = (out.agents[k] || 0) + 1;
  }
  out.costJpy = Math.round(out.costJpy * 100) / 100;
  out.now = t;
  return out;
}

// 直近の異常を拾う（連続失敗・コスト急増）。アラート基盤へ渡す前段。
export function anomalies(all, opts) {
  const o = opts || {};
  const failStreak = Number(o.failStreak) || 3;
  const costLimit = Number(o.dailyCostLimitJpy) || 0;
  const rows = listRuns(all, {});
  const out = [];

  let streak = 0, streakAgent = '';
  for (const r of rows) {                                   // 新しい順に見る
    if (r.status === 'failed') {
      if (!streakAgent) streakAgent = r.agentName;
      if (r.agentName === streakAgent) streak++; else break;
    } else break;
  }
  if (streak >= failStreak) out.push({ kind: 'fail_streak', agentName: streakAgent, count: streak });

  if (costLimit > 0) {
    const dayAgo = nowMs(o.now) - 24 * 3600 * 1000;
    const cost = summarize(all, dayAgo, o.now).costJpy;
    if (cost > costLimit) out.push({ kind: 'cost_over', costJpy: cost, limitJpy: costLimit });
  }
  return out;
}
