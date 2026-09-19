// ── 業務AIの回答を画面に出すための共通契約 ───────────────────────────
//
// 正本は naoru-ai-platform/AGENTS.md §3（共通実行契約）と §4（業務AI一覧）。
// ここは**①ダッシュボード側の受け皿**で、③が返す回答を画面に出すときの決まりを持つ。
//
// ⚠️ 守ること（AGENTS.md より）
//   1. 業務データとモデルの推測を**区別する**。
//      → 出典の無い主張は「事実」として出さない。必ず「仮説」へ落とす（demoteUncited）。
//      → モデルが作った値は、たとえ出典欄が埋まっていても実績にしない。
//   2. 数値には**対象期間・単位・出典・集計定義版**を付ける。
//      → どれかが欠けている数値は、数値として出さない（理由を出す）。
//   3. **未取得を 0 で埋めない。** 取れなかったものは「未取得」と出す。
//   4. 根拠不足・取得不能は「判断不能」で返す。別の期間や他店の値で穴埋めしない。
//   5. 外向きの操作（公開・送信・課金・配信変更）は**必ず人の承認**を通す。
//      ここは提案を並べるだけで、実行はしない（実行は lib/approvals.js の先）。
//   6. 鮮度（いつ時点のデータか）を必ず出す。分からなければ「不明」と出す。
//
// ⚠️ 8人それぞれに別画面を作らない。既存の画面の中に置く（ROADMAP §2）。
//
// tests/ai-answer.test.js でカバー。

const str = (v, n = 200) => String(v == null ? '' : v).slice(0, n);
const arr = (v) => (Array.isArray(v) ? v : []);

/** 業務AI。key は AGENTS.md §4 の並びに合わせる。screen は「どの既存画面に置くか」。 */
export const AGENTS = Object.freeze([
  { key: 'chief',     label: 'Chief of Staff',    ja: '経営の相談役',   screen: 'home' },
  { key: 'marketing', label: 'Marketing Analyst', ja: '集客の分析',     screen: 'mktg' },
  { key: 'finance',   label: 'Finance Analyst',   ja: 'お金の分析',     screen: 'planning' },
  { key: 'storerisk', label: 'Store Risk Agent',  ja: '店舗の変化検知', screen: 'zenkanri' },
  { key: 'sns',       label: 'SNS Intelligence',  ja: 'SNSの企画',      screen: 'creative' },
  { key: 'content',   label: 'Content Studio',    ja: '制作',           screen: 'creative' },
  { key: 'product',   label: 'Product Engineer',  ja: '開発',           screen: 'settings' },
  { key: 'knowledge', label: 'Knowledge Manager', ja: '資料の整理',     screen: 'knowledge' },
]);
export const AGENT_KEYS = AGENTS.map(a => a.key);
export function agentOf(key) { return AGENTS.find(a => a.key === str(key, 40)) || null; }
export function agentsForScreen(screen) {
  const s = str(screen, 40);
  return AGENTS.filter(a => a.screen === s);
}

/** 回答の状態。AGENTS.md §5 の実行状態と揃える。 */
export const STATUSES = Object.freeze(['queued', 'running', 'completed', 'failed', 'cancelled']);
export function normalizeStatus(v) {
  return STATUSES.includes(str(v, 20)) ? str(v, 20) : 'queued';
}

/**
 * 値の出どころ。
 *   'source' … 確定集計API・正本から取った値
 *   'model'  … モデルが作った値（⚠️ **実績として出さない**）
 */
export function normalizeOrigin(v) {
  return str(v, 20) === 'source' ? 'source' : 'model';
}

/** 出典。id と label が無ければ出典として数えない（それらしい出典を作らない）。 */
export function normalizeCitation(raw) {
  const c = (raw && typeof raw === 'object') ? raw : {};
  const id = str(c.id, 80);
  if (!id) return null;
  return {
    id,
    label: str(c.label, 120) || id,
    // 正式台帳の版。CURRENT 以外は画面に「過去版」と出すための印（AGENTS.md §8）
    version: str(c.version, 40),
    current: c.current === true,
    url: /^https:\/\//.test(str(c.url, 500)) ? str(c.url, 500) : '',
  };
}

/**
 * 主張ひとつ。
 * @returns {{text, value, unit, period, defVersion, citationIds, origin}}
 * ⚠️ value は数値のときだけ数値。未取得は null（0 にしない）。
 */
export function normalizeClaim(raw) {
  const c = (raw && typeof raw === 'object') ? raw : {};
  const n = Number(c.value);
  return {
    text: str(c.text, 400),
    // ⚠️ null / undefined / '' は「未取得」。Number('') === 0 に落ちないよう先に弾く
    value: (c.value === null || c.value === undefined || c.value === '' || !Number.isFinite(n)) ? null : n,
    unit: str(c.unit, 20),
    period: str(c.period, 60),          // 対象期間（例: 2026-09-01〜2026-09-18）
    defVersion: str(c.defVersion, 40),  // 集計定義版
    citationIds: [...new Set(arr(c.citationIds).map(x => str(x, 80)).filter(Boolean))].slice(0, 10),
    origin: normalizeOrigin(c.origin),
  };
}

/**
 * その主張を「事実」として出してよいか。
 * ⚠️ 出典が無い／モデルが作った値／数値なのに期間・単位・定義版が欠けている、のいずれでも不可。
 * @returns {ok:true} | {ok:false, reason}
 */
export function claimIsFact(claim) {
  const c = normalizeClaim(claim);
  if (c.origin !== 'source') return { ok: false, reason: 'model_generated' };
  if (!c.citationIds.length) return { ok: false, reason: 'no_citation' };
  if (c.value !== null) {
    if (!c.period) return { ok: false, reason: 'no_period' };
    if (!c.unit) return { ok: false, reason: 'no_unit' };
    if (!c.defVersion) return { ok: false, reason: 'no_def_version' };
  }
  return { ok: true };
}

export const CLAIM_REASON = Object.freeze({
  model_generated: 'AIが作った値のため、実績としては出しません',
  no_citation: '出典が無いため、事実としては出しません',
  no_period: '対象期間が無いため、数値としては出しません',
  no_unit: '単位が無いため、数値としては出しません',
  no_def_version: '集計定義の版が無いため、数値としては出しません',
});

/** 提案ひとつ。⚠️ ここでは実行しない。外向きの操作は必ず承認を通す。 */
export const OUTWARD_KINDS = Object.freeze([
  'meta_budget_change', 'meta_pause', 'meta_resume', 'creative_replace',
  'knowledge_publish', 'sns_post', 'lp_change',
]);
export function normalizeAction(raw) {
  const a = (raw && typeof raw === 'object') ? raw : {};
  return {
    id: str(a.id, 64),
    kind: str(a.kind, 60),
    title: str(a.title, 160),
    why: str(a.why, 400),
    citationIds: [...new Set(arr(a.citationIds).map(x => str(x, 80)).filter(Boolean))].slice(0, 10),
    approvalId: str(a.approvalId, 64),   // 承認センターに積まれていれば、その id
  };
}
/** 外向きの操作か（＝人の承認が要るか）。⚠️ 分からない種別は**承認が要る側**に倒す。 */
export function actionNeedsApproval(action) {
  const a = normalizeAction(action);
  if (!a.kind) return true;
  return OUTWARD_KINDS.includes(a.kind) || !a.kind.startsWith('read_');
}

/** 鮮度。ミリ秒。取れていなければ null（「不明」と出す）。 */
export function normalizeFreshness(raw) {
  const f = (raw && typeof raw === 'object') ? raw : {};
  const at = Number(f.at);
  return {
    at: Number.isFinite(at) && at > 0 ? Math.floor(at) : null,
    note: str(f.note, 120),
  };
}
export function freshnessLabel(freshness, now = Date.now()) {
  const f = normalizeFreshness(freshness);
  if (f.at == null) return '更新日時が不明';
  const s = Math.max(0, Math.floor((now - f.at) / 1000));
  if (s < 60) return 'たった今の情報';
  if (s < 3600) return `${Math.floor(s / 60)}分前の情報`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前の情報`;
  return `${Math.floor(s / 86400)}日前の情報`;
}
/** 古すぎないか。⚠️ 鮮度が分からないものは「古いかもしれない」側に倒す。 */
export function isStale(freshness, now = Date.now(), maxAgeMs = 24 * 3600 * 1000) {
  const f = normalizeFreshness(freshness);
  if (f.at == null) return true;
  return (now - f.at) > maxAgeMs;
}

/** 回答まるごとを整える。⚠️ 知らないキーを生やさない。 */
export function normalizeAnswer(raw) {
  const a = (raw && typeof raw === 'object') ? raw : {};
  const citations = arr(a.citations).map(normalizeCitation).filter(Boolean).slice(0, 30);
  return {
    agent: AGENT_KEYS.includes(str(a.agent, 40)) ? str(a.agent, 40) : '',
    status: normalizeStatus(a.status),
    question: str(a.question, 400),
    facts: arr(a.facts).map(normalizeClaim).slice(0, 30),
    hypotheses: arr(a.hypotheses).map(normalizeClaim).slice(0, 30),
    missingData: arr(a.missingData ?? a.missing_data).map(x => str(x, 200)).filter(Boolean).slice(0, 20),
    citations,
    proposedActions: arr(a.proposedActions ?? a.proposed_actions).map(normalizeAction).slice(0, 20),
    freshness: normalizeFreshness(a.freshness),
    usage: (() => {
      const u = (a.usage && typeof a.usage === 'object') ? a.usage : {};
      const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
      return { calls: num(u.calls), tokens: num(u.tokens), costJpy: num(u.costJpy) };
    })(),
    error: str(a.error, 200),
  };
}

/**
 * 🔴 出典の無い主張・モデルが作った値を、事実から**仮説へ落とす**。
 * これを通さずに facts を画面へ出さない。
 * @returns {answer, demoted:[{claim, reason}]}
 */
export function demoteUncited(raw) {
  const a = normalizeAnswer(raw);
  const known = new Set(a.citations.map(c => c.id));
  const facts = [], demoted = [];
  for (const f of a.facts) {
    const chk = claimIsFact(f);
    // ⚠️ 出典IDが citations に無いものも「出典なし」と同じ扱いにする
    const cited = f.citationIds.some(id => known.has(id));
    if (chk.ok && cited) { facts.push(f); continue; }
    demoted.push({ claim: f, reason: chk.ok ? 'no_citation' : chk.reason });
  }
  return { answer: { ...a, facts, hypotheses: [...a.hypotheses, ...demoted.map(d => d.claim)] }, demoted };
}

/** 画面に出す値。⚠️ 未取得は「未取得」。0 で埋めない。 */
export function displayValue(claim) {
  const c = normalizeClaim(claim);
  if (c.value === null) return '未取得';
  const n = Math.abs(c.value) >= 1000 ? Math.round(c.value).toLocaleString('ja-JP') : String(c.value);
  return c.unit ? `${n}${c.unit}` : n;
}

/** 数値のそばに必ず出す但し書き（対象期間・出典・集計定義版）。欠けていれば「不明」と書く。 */
export function claimNote(claim, citations) {
  const c = normalizeClaim(claim);
  const list = arr(citations).map(normalizeCitation).filter(Boolean);
  const names = c.citationIds.map(id => (list.find(x => x.id === id) || {}).label || id).filter(Boolean);
  return [
    `対象期間: ${c.period || '不明'}`,
    `出典: ${names.length ? names.join('・') : '不明'}`,
    `集計定義: ${c.defVersion || '不明'}`,
  ].join(' / ');
}

/**
 * この回答を出してよいか。
 * ⚠️ 根拠が無い／失敗した回答は「判断不能」として返す。穴埋めをしない。
 * @returns 'ok' | 'insufficient' | 'running' | 'failed'
 */
export function answerVerdict(raw, now = Date.now()) {
  const a = normalizeAnswer(raw);
  if (a.status === 'failed' || a.status === 'cancelled') return 'failed';
  if (a.status === 'queued' || a.status === 'running') return 'running';
  const { answer } = demoteUncited(a);
  if (!answer.facts.length && !answer.hypotheses.length && !answer.proposedActions.length) return 'insufficient';
  if (!answer.facts.length && answer.missingData.length) return 'insufficient';
  return 'ok';
}

export const VERDICT_LABEL = Object.freeze({
  ok: '',
  insufficient: '判断できませんでした（根拠が足りません）',
  running: '調べています…',
  failed: '取得できませんでした',
});
