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
export function normalizeMetric(raw, key, currency) {
  const m = (raw && typeof raw === 'object') ? raw : {};
  const resolvedUnit = normalizeUnit(m.unit, currency, key);
  // 通貨が照合できない金額は **数字を出さない**（0にも落とさない）。
  const unitOk = resolvedUnit !== null;
  const value = unitOk ? numOrNull(m.value) : null;
  // ⚠️ **知らない quality を VERIFIED へ昇格させない。**
  //    未知の値は「確かめられていない」＝ESTIMATED 扱いにし、確定値として見せない。
  //    quality が無い場合だけ、値の有無から控えめに決める。
  const hasQuality = m.quality != null && m.quality !== '';
  let quality;
  if (!hasQuality) quality = (value === null ? 'MISSING' : 'VERIFIED');
  else if (QUALITIES.includes(m.quality)) quality = m.quality;
  else quality = (value === null ? 'MISSING' : 'ESTIMATED');
  // 値が無いのに VERIFIED を主張する応答は信用しない（0円表示の元になる）
  if (value === null && quality === 'VERIFIED') quality = 'MISSING';
  return {
    key: str(key, 40),
    value,
    // 照合できなかったときの表示用単位。**金額指標を 'count' へ寄せない**
    //（値は null なので表示されないが、下流が単位を誤解しないようにする）。
    unit: unitOk ? resolvedUnit
        : (accountCurrencyOf(currency) || (isMoneyMetric(key) ? null : 'count')),
    display: value === null ? '—' : str(m.display, 40) || String(value),
    quality,
    source: str(m.source, 40) || 'Meta',
    missingReason: value === null
      ? (unitOk ? (str(m.missing_reason ?? m.missingReason, 200) || '理由が返されていません')
                : (isMoneyMetric(key)
                    ? '金額の単位が広告アカウントの通貨と一致しません（金額指標に count/ratio は使えません）'
                    : '金額の単位が広告アカウントの通貨と一致しません'))
      : null,
  };
}

// 単位。**外貨を count（件数）に潰さない**。
// 以前は ['JPY','count','ratio'] 以外を一律 'count' にしていたため、豪州(AUD)や
// マレーシア(MYR)の広告アカウントの「消化額」が「件数」として下流へ渡っていた。
// 金額は広告アカウントの通貨コードをそのまま保持する（勝手に円へ寄せない）。
const UNIT_KINDS = ['count', 'ratio'];

// ⚠️ **金額指標は metric 名で固定する。** 上流の unit 申告に任せると、
//    spend に 'count'、cpc に 'ratio' が来たときそのまま数字が通ってしまう
//    （単位が違えば桁も意味も違う数字を実績として見せることになる）。
//    この3つは「アカウント通貨と厳密一致」以外を受け付けない。
export const MONEY_METRICS = Object.freeze(['spend', 'cpc', 'cpm']);
export const isMoneyMetric = (key) => MONEY_METRICS.includes(String(key || ''));

// 広告アカウントの通貨コード。ISO 4217 は英字3桁。
export function accountCurrencyOf(raw) {
  const c = String(raw == null ? '' : raw).trim().toUpperCase();
  return (/^[A-Z]{3}$/.test(c) && !UNIT_KINDS.includes(c.toLowerCase())) ? c : null;
}

/**
 * 単位を決める。**外貨を count（件数）に潰さない。**
 * @param raw       上流が申告した単位
 * @param currency  広告アカウントの通貨（省略時は照合しない＝従来どおり保持）
 * @returns 'count' | 'ratio' | ISO通貨コード、または照合できないとき null
 *
 * ⚠️ currency を渡した場合、**金額の単位はアカウント通貨と一致しなければ null** を返す。
 *    AUD のアカウントに JPY の金額が来るのは「取り違え」であり、
 *    そのまま表示すると桁も意味も違う数字を実績として見せてしまう。
 *    通貨が確認できないときも同じく null（黙って円やcountへ寄せない）。
 */
export function normalizeUnit(raw, currency, key) {
  const u = String(raw == null ? '' : raw).trim();
  const declared = /^[A-Za-z]{3}$/.test(u) ? u.toUpperCase() : null;
  const account = accountCurrencyOf(currency);

  // 金額指標（spend/cpc/cpm）: **count / ratio の申告も受け付けない。**
  // ⚠️ 照合を求められたとき（currency が渡されたとき）だけ適用する。
  //    currency 省略＝単体での単位解決なので、従来どおりの緩い判定を残す。
  if (isMoneyMetric(key) && currency !== undefined) {
    if (!account || !declared || declared !== account) return null;
    return declared;
  }

  if (UNIT_KINDS.includes(u)) return u;
  if (currency === undefined) return declared || 'count';    // 従来の呼び出し（照合なし）
  if (!declared) return 'count';          // 金額単位ですらない申告は控えめに count
  if (!account || declared !== account) return null;         // 不一致・通貨不明は表示しない
  return declared;
}

// 金額単位かどうか（表示側が通貨記号を付けるかの判定に使う）
export function isCurrencyUnit(unit) {
  return /^[A-Z]{3}$/.test(String(unit || '')) && !UNIT_KINDS.includes(String(unit || ''));
}

export function normalizeMetrics(raw, currency) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = {};
  for (const k of METRIC_KEYS) out[k] = normalizeMetric(src[k], k, currency);
  return out;
}

function normalizeRow(raw, currency) {
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
    metrics: normalizeMetrics(r.metrics, currency),
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
// 上流が「これはサンプルだ」と申告しているか。
// ⚠️ URLとキーが設定されていることは、実データである保証にならない。
//    接続先がモックを返している場合も、外側までサンプル表示を貫く。
const SAMPLE_MODE_RE = /^(sample|mock|fixture|demo|test|sandbox)$/i;
const LIVE_MODE_RE = /^live$/i;

export function looksLikeSample(raw) {
  const d = (raw && typeof raw === 'object') ? raw : {};
  if (d._fixture === true || d.sample === true || d.mock === true) return true;
  // ⚠️ mode と data_mode は**独立に**見る。片方が live でも、もう片方がサンプル印なら
  //    サンプルとして扱う（矛盾した申告を live 側へ寄せない＝安全側）。
  if (SAMPLE_MODE_RE.test(str(d.mode, 40)) || SAMPLE_MODE_RE.test(str(d.data_mode, 40))) return true;
  if (typeof d.environment === 'string' && /^(mock|fixture|sandbox|demo)$/i.test(d.environment)) return true;
  const acc = (d.account && typeof d.account === 'object') ? d.account : {};
  if (typeof acc.id === 'string' && /^act_0+$/.test(acc.id)) return true;          // 明らかな作り物
  return false;
}

/**
 * 上流が申告した「実データか否か」の状態。
 *   'live'        … 実データだと明示している
 *   'sample'      … サンプル/モックだと明示している
 *   'unconfirmed' … mode/data_mode を申告しているが live でもサンプル印でもない（例: 'unknown'）
 *   （'unstated' は廃止。申告が無い応答も 'unconfirmed' として数値を出さない）
 * ⚠️ **'unconfirmed' を live へ昇格させない。** 確かめられない数字は実績として見せない。
 */
export function declaredMode(raw) {
  const d = (raw && typeof raw === 'object') ? raw : {};
  // サンプル印が1つでもあれば sample（B1の合成データはここで「サンプル表示」を維持する）
  if (looksLikeSample(d)) return 'sample';
  // ⚠️ **最初に見つかった申告だけで決めない。** 以前は find() で mode='live' を拾うと
  //    data_mode='unknown' を無視していたため、確認できない数字が live として表示された。
  const vals = [d.mode, d.data_mode].map(v => (typeof v === 'string' ? v.trim() : ''));
  // live 以外の申告（'unknown' など）が混ざっていれば確認できない
  if (vals.some(v => v && !LIVE_MODE_RE.test(v))) return 'unconfirmed';
  // ⚠️ **未申告を live にしない。** 片方でも欠けていれば「実データだ」と言い切れない。
  //    旧形式（mode/data_mode なし）も同じ扱い＝金額は fail closed。
  if (vals.some(v => !v)) return 'unconfirmed';
  return 'live';
}

/**
 * mode と data_mode の食い違いを取り出す。
 * ⚠️ 矛盾を**黙って**片方へ寄せない。サンプル側へ倒して表示は残すが、
 *    「なぜサンプル扱いなのか」を画面に出せるよう理由を返す。
 * @returns {{mode:string, dataMode:string, message:string}|null}
 */
export function modeConflictOf(raw) {
  const d = (raw && typeof raw === 'object') ? raw : {};
  const mode = str(d.mode, 40).trim();
  const dataMode = str(d.data_mode, 40).trim();
  if (!mode || !dataMode || mode.toLowerCase() === dataMode.toLowerCase()) return null;
  const sampleSide = SAMPLE_MODE_RE.test(mode) ? 'mode' : (SAMPLE_MODE_RE.test(dataMode) ? 'data_mode' : '');
  const liveSide = LIVE_MODE_RE.test(mode) ? 'mode' : (LIVE_MODE_RE.test(dataMode) ? 'data_mode' : '');
  if (!sampleSide || !liveSide) return null;          // live×sample の食い違いだけを矛盾として扱う
  return {
    mode, dataMode,
    message: `接続先の申告が食い違っています（mode=${mode} / data_mode=${dataMode}）。`
      + '実データとは断定できないため、サンプル扱いで表示しています。',
  };
}

export function normalizeOverview(raw, opts = {}) {
  const d = (raw && typeof raw === 'object') ? raw : {};
  const isFixture = opts.fixture === true || looksLikeSample(d);
  const conflict = modeConflictOf(d);

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

  // 🔴 実データかサンプルか **確認できない応答は、数値を表示しない。**
  //    ③が data_mode/mode を 'unknown' として返した場合がこれにあたる。
  //    「接続できた」ことと「実Metaの数字である」ことは別物として扱う。
  if (d.status !== 'error' && declaredMode(d) === 'unconfirmed') {
    return {
      ok: false,
      connected: true,
      isSample: false,
      error: {
        code: 'MODE_UNCONFIRMED',
        message: 'データの状態（実データ／サンプル）が確認できないため、数値を表示しません',
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
  const ROW_CAP = 1000;
  const accountCurrency = str(acc.currency, 8);
  const allRows = Array.isArray(d.rows) ? d.rows : [];
  const rows = allRows.slice(0, ROW_CAP).map(r => normalizeRow(r, accountCurrency));

  // (2) 要求と応答の食い違いを検出する。別テナント・別アカウント・別期間の数字を
  //     そのまま表示すると、誰も気づかないまま他社/他アカウントの実績を見ることになる。
  const expect = (opts && typeof opts.expect === 'object') ? opts.expect : null;
  const mismatch = [];
  if (expect) {
    const eq = (a, b) => String(a || '').trim() === String(b || '').trim();
    if (expect.tenantId && !eq(expect.tenantId, d.tenant_id)) mismatch.push({ field: 'tenant', expected: expect.tenantId, got: str(d.tenant_id, 64) });
    if (expect.accountId && !eq(expect.accountId, acc.id)) mismatch.push({ field: 'account', expected: expect.accountId, got: str(acc.id, 64) });
    if (expect.from && !eq(expect.from, per.from)) mismatch.push({ field: 'from', expected: expect.from, got: str(per.from, 20) });
    if (expect.to && !eq(expect.to, per.to)) mismatch.push({ field: 'to', expected: expect.to, got: str(per.to, 20) });
  }
  if (mismatch.length) {
    return {
      ok: false, connected: true, isSample: isFixture,
      error: {
        code: 'RESPONSE_MISMATCH',
        message: '要求した対象と違う内容が返されたため表示しません（' + mismatch.map(m => m.field).join(', ') + '）',
        retryable: false, detail: mismatch,
      },
      freshness: normalizeFreshness(d.freshness),
    };
  }

  return {
    ok: true,
    connected: true,
    isSample: isFixture,
    // 🔴 申告の食い違い。isSample で数値は出すが、**実データへ昇格させない**理由を明示する。
    modeConflict: conflict,
    notices: conflict
      ? [{ code: 'MODE_CONFLICT', severity: 'warning', message: conflict.message }]
      : [],
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
    totals: normalizeMetrics(d.totals, accountCurrency),
    rows,
    // (6) 行数上限で切った場合は黙って捨てない。画面に「省略している」と出す。
    truncated: allRows.length > ROW_CAP,
    rowCountTotal: allRows.length,
    rowCap: ROW_CAP,
    paging: (d.paging && typeof d.paging === 'object')
      ? { hasMore: d.paging.has_more === true || d.paging.hasMore === true, nextCursor: str(d.paging.next_cursor ?? d.paging.nextCursor, 200) || null }
      : { hasMore: false, nextCursor: null },
    freshness: normalizeFreshness(d.freshness),
    errors: (Array.isArray(d.errors) ? d.errors : []).slice(0, 20).map(e => ({
      code: str(e && e.code, 40), message: str(e && e.message, 300), scope: str(e && e.scope, 40),
    })),
    definitions: (d.definitions && typeof d.definitions === 'object') ? d.definitions : {},
  };
}

// 通貨記号。JPY以外も保持し、勝手に円にしない。
export function currencySymbol(code) {
  const c = String(code || '').toUpperCase();
  const map = { JPY: '¥', USD: '$', EUR: '€', GBP: '£', AUD: 'A$', MYR: 'RM', SGD: 'S$', KRW: '₩', TWD: 'NT$', THB: '฿' };
  return map[c] || '';
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
/**
 * 「直近の完了済み days 日」。当日は未確定なので含めない。
 * ⚠️ 基準は**広告アカウントのタイムゾーン**。UTCで切ると、日本のアカウントでは
 *    午前9時前に「昨日」がずれ、1日ぶん多い／少ない期間を要求してしまう。
 * @param timeZone IANA名（例 'Asia/Tokyo'）。不正・未指定なら UTC。
 */
export function lastCompleteDays(days = 7, now = new Date(), timeZone = 'UTC') {
  const tz = String(timeZone || 'UTC');
  // そのタイムゾーンでの「今日」の年月日を得る
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch (_) {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  }
  const todayUtcMidnight = Date.parse(`${parts}T00:00:00Z`);   // 日付の足し引きだけに使う
  const to = new Date(todayUtcMidnight - 86400000);            // 昨日
  const from = new Date(to.getTime() - (Math.max(1, days) - 1) * 86400000);
  const ymd = (x) => x.toISOString().slice(0, 10);
  return { from: ymd(from), to: ymd(to), timeZone: tz };
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
  // 🔴 **サンプルを live と表示しない。** URLとキーが設定されていても、
  //    接続先がモック/サンプルを返しているなら接続表示も live にはしない。
  //    （申告の食い違いでサンプル扱いになった場合も同じ。理由をそのまま出す。）
  if (result && result.isSample === true) {
    return {
      connected: true, mode: 'sample',
      reason: (result.modeConflict && result.modeConflict.message)
        || '接続先がサンプル（モック）データを返しています',
      code: result.modeConflict ? 'MODE_CONFLICT' : 'SAMPLE_DATA',
    };
  }
  return { connected: true, mode: 'live', reason: '' };
}

/**
 * 広告アカウント許可リストを解釈する。**部分採用しない。**
 * 1件でも形式が不正／重複があれば、リスト全体を無効として扱う。
 * `act_` + 数字のみを認める（③ naoru-ai-platform の規則と揃える）。
 * 旧・単数 META_AD_ACCOUNT_ID は許可リストとして**使わない**。
 * 設定が残っている場合は黙って無視せず、移行が必要なことを reason で知らせる。
 * @returns { ids, valid, reason }
 */
export function parseAccountAllowList(env = {}) {
  const raw = String(env.META_AD_ACCOUNT_IDS || '').trim();
  const legacy = String(env.META_AD_ACCOUNT_ID || '').trim();
  if (!raw) {
    return { ids: [], valid: false,
      reason: legacy
        ? '許可リストが未設定です。旧 META_AD_ACCOUNT_ID（単数）は使用しません。META_AD_ACCOUNT_IDS へ移行してください'
        : '広告アカウントの許可リスト（META_AD_ACCOUNT_IDS）が未設定です' };
  }
  const parts = raw.split(',').map(x => x.trim());
  const bad = parts.filter(x => !/^act_[0-9]+$/.test(x));
  if (bad.length) {
    return { ids: [], valid: false,
      reason: `許可リストに使用できない値があります（${bad.slice(0, 3).map(x => x.slice(0, 32) || '(空)').join(', ')}）。act_ + 数字のみです。一部だけを採用せずリスト全体を無効にしました` };
  }
  if (new Set(parts).size !== parts.length) {
    return { ids: [], valid: false, reason: '許可リストに重複があります。リスト全体を無効にしました' };
  }
  return { ids: parts, valid: true, reason: '' };
}
