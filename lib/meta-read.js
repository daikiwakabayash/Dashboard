// ── Meta読取API クライアントのロジック（純粋関数）────────────────────
// 契約は META_READ_API_CONTRACT.md（api_version='meta-read-1'）。
// ③ naoru-ai-platform が提供する読取専用APIの応答を検証・正規化する。
// 取得（I/O）は api/plan-store.js が行い、ここには入れない。tests/meta-read.test.js でカバー。
//
// このモジュールが守る約束:
//   1. **未接続を 0 にしない / 欠損を 0 にしない。** value=null と 0 を最後まで区別する。
//   2. **サンプルデータには必ず印を付ける。** 実データと混同させない。
//   3. **知らない版は表示しない。** api_version が違えば「表示できない」と言う。
//   4. Meta の成果件数と SalonOne の予約数を**同じものとして扱わない**。

export const META_API_VERSION = 'meta-read-1';
export const QUALITIES = Object.freeze(['VERIFIED', 'ESTIMATED', 'MISSING', 'NOT_CONNECTED']);
export const LEVELS = Object.freeze(['campaign', 'adset', 'ad']);
export const METRIC_KEYS = Object.freeze(['spend', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm', 'results']);

const str = (v, n = 200) => String(v == null ? '' : v).slice(0, n);
const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// 指標1つを正規化する。**value が無ければ null。0 に落とさない。**
export function normalizeMetric(raw, key) {
  const m = (raw && typeof raw === 'object') ? raw : {};
  const value = numOrNull(m.value);
  let quality = QUALITIES.includes(m.quality) ? m.quality : (value === null ? 'MISSING' : 'VERIFIED');
  // 値が無いのに VERIFIED を主張する応答は信用しない（0円表示の元になる）
  if (value === null && quality === 'VERIFIED') quality = 'MISSING';
  return {
    key: str(key, 40),
    value,
    unit: ['JPY', 'count', 'ratio'].includes(m.unit) ? m.unit : 'count',
    display: value === null ? '—' : str(m.display, 40) || String(value),
    quality,
    source: str(m.source, 40) || 'Meta',
    missingReason: value === null ? (str(m.missing_reason ?? m.missingReason, 200) || '理由が返されていません') : null,
  };
}

export function normalizeMetrics(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = {};
  for (const k of METRIC_KEYS) out[k] = normalizeMetric(src[k], k);
  return out;
}

function normalizeRow(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const level = LEVELS.includes(r.level) ? r.level : 'campaign';
  const cr = (r.creative && typeof r.creative === 'object') ? r.creative : null;
  return {
    level,
    id: str(r.id, 64),
    parentId: r.parent_id == null ? null : str(r.parent_id, 64),
    name: str(r.name, 200) || '(名称なし)',
    status: str(r.status, 40) || 'UNKNOWN',
    effectiveStatus: str(r.effective_status ?? r.effectiveStatus, 40) || 'UNKNOWN',
    metrics: normalizeMetrics(r.metrics),
    creative: cr ? {
      // 権限が確認できたものだけ表示する。denied/unknown はURLを使わない。
      thumbnailUrl: cr.permission === 'granted' ? (str(cr.thumbnail_url ?? cr.thumbnailUrl, 500) || null) : null,
      permission: ['granted', 'denied', 'unknown'].includes(cr.permission) ? cr.permission : 'unknown',
      type: str(cr.type, 20) || 'unknown',
    } : null,
  };
}

/**
 * ③の応答を画面が使える形にする。
 * @param raw   APIの生応答
 * @param opts  { fixture: true でサンプルデータとして印を付ける }
 */
export function normalizeOverview(raw, opts = {}) {
  const d = (raw && typeof raw === 'object') ? raw : {};
  const isFixture = opts.fixture === true || d._fixture === true;

  // 知らない版は表示しない。勝手に解釈すると、意味の違う数字を出してしまう。
  if (str(d.api_version, 40) !== META_API_VERSION) {
    return {
      ok: false,
      connected: false,
      isSample: isFixture,
      error: {
        code: 'UNSUPPORTED_VERSION',
        message: `対応していないAPI版です（受信: ${str(d.api_version, 40) || '不明'} / 対応: ${META_API_VERSION}）`,
        retryable: false,
      },
      freshness: normalizeFreshness(d.freshness),
    };
  }

  if (d.status === 'error') {
    const e = (d.error && typeof d.error === 'object') ? d.error : {};
    return {
      ok: false,
      connected: str(e.code, 40) !== 'NOT_CONNECTED',
      isSample: isFixture,
      error: {
        code: str(e.code, 40) || 'UPSTREAM_ERROR',
        message: str(e.message, 300) || '取得できませんでした',
        retryable: e.retryable === true,
      },
      // エラーでも「いつの数字までは取れているか」は返す
      freshness: normalizeFreshness(d.freshness),
    };
  }

  const acc = (d.account && typeof d.account === 'object') ? d.account : {};
  const per = (d.period && typeof d.period === 'object') ? d.period : {};
  const rows = (Array.isArray(d.rows) ? d.rows : []).slice(0, 1000).map(normalizeRow);

  return {
    ok: true,
    connected: true,
    isSample: isFixture,
    partial: d.status === 'partial',
    apiVersion: META_API_VERSION,
    tenantId: str(d.tenant_id, 64) || 'naoru',
    generatedAt: str(d.generated_at, 40),
    account: {
      id: str(acc.id, 64),
      name: str(acc.name, 200) || '(名称なし)',
      currency: str(acc.currency, 8) || null,
      timezone: str(acc.timezone, 64) || null,
      status: str(acc.status, 40) || 'UNKNOWN',
      storeMapping: (Array.isArray(acc.store_mapping) ? acc.store_mapping : []).slice(0, 200).map(s => ({
        storeId: str(s && s.store_id, 64),
        storeName: str(s && s.store_name, 200) || '(未対応)',
        confidence: ['confirmed', 'inferred', 'unmapped'].includes(s && s.confidence) ? s.confidence : 'unmapped',
      })),
    },
    period: {
      from: str(per.from, 20),
      to: str(per.to, 20),
      timezone: str(per.timezone, 64) || str(acc.timezone, 64) || null,
      completeDaysOnly: per.complete_days_only === true,
      excludedToday: per.excluded_today === true,
    },
    totals: normalizeMetrics(d.totals),
    rows,
    freshness: normalizeFreshness(d.freshness),
    errors: (Array.isArray(d.errors) ? d.errors : []).slice(0, 20).map(e => ({
      code: str(e && e.code, 40), message: str(e && e.message, 300), scope: str(e && e.scope, 40),
    })),
    definitions: (d.definitions && typeof d.definitions === 'object') ? d.definitions : {},
  };
}

export function normalizeFreshness(raw) {
  const f = (raw && typeof raw === 'object') ? raw : {};
  return {
    lastSuccessAt: str(f.last_success_at ?? f.lastSuccessAt, 40) || null,
    lastAttemptAt: str(f.last_attempt_at ?? f.lastAttemptAt, 40) || null,
    lagMinutes: numOrNull(f.lag_minutes ?? f.lagMinutes),
  };
}

// 親子を組み立てた表示順（campaign → その adset → その ad）。
// 親が見つからない行も落とさずに末尾へ出す（黙って消さない）。
export function buildTree(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byParent = new Map();
  for (const r of list) {
    const k = r.parentId || '__root__';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(r);
  }
  const seen = new Set();
  const out = [];
  const walk = (parentKey, depth) => {
    for (const r of (byParent.get(parentKey) || [])) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ ...r, depth });
      walk(r.id, depth + 1);
    }
  };
  walk('__root__', 0);
  for (const r of list) if (!seen.has(r.id)) out.push({ ...r, depth: 0, orphan: true });
  return out;
}

// 「直近の完了済み7日」。当日は未確定なので含めない（過少な数字を出さないため）。
export function lastCompleteDays(days = 7, now = new Date()) {
  const d = new Date(now.getTime());
  d.setUTCHours(0, 0, 0, 0);
  const to = new Date(d.getTime() - 86400000);              // 昨日
  const from = new Date(to.getTime() - (days - 1) * 86400000);
  const ymd = (x) => x.toISOString().slice(0, 10);
  return { from: ymd(from), to: ymd(to) };
}

// 未接続の理由を利用者の言葉にする。**金額は絶対に出さない。**
export function connectionState(env = {}, result = null) {
  const base = String(env.META_READ_API_BASE || '').trim();
  if (!base) {
    return {
      connected: false, mode: 'sample',
      reason: 'Meta読取APIの接続先（META_READ_API_BASE）が未設定です',
      hint: '接続はプラットフォーム側の準備と環境変数の設定が必要です（設定は人が行います）',
    };
  }
  if (!String(env.META_READ_API_KEY || '').trim()) {
    return {
      connected: false, mode: 'sample',
      reason: 'Meta読取APIの認証キー（META_READ_API_KEY）が未設定です',
      hint: '接続先は設定済みですが、認証キーがありません',
    };
  }
  if (result && result.ok === false) {
    return { connected: false, mode: 'error', reason: result.error.message, code: result.error.code };
  }
  return { connected: true, mode: 'live', reason: '' };
}
