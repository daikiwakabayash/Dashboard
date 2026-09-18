// ── チャット内 AI（@AI / AI Question Mode / 透明性 / Feedback）の純粋ロジック ──
// 仕様: CHAT_AI_UX_SPEC.md
//
// ⚠️ 担当範囲（②）を守るための約束:
//   - 認可は再実装しない。権限判定は共通基盤（lib/authz.js の can()）の結果を **引数で受け取る**。
//   - 監査・AI実行履歴も再実装しない。共通の lib/agentlog.js / lib/audit.js に渡す**入力を組み立てるだけ**。
//   - 送信・保存・API 呼び出しは行わない（このファイルは I/O ゼロ・依存ゼロ）。
//
// テスト: tests/chat-ai-ux.test.js

export const CHAT_AI_UX_VERSION = 'chat-ai-ux-1';

// AI の表示名・ID（既存実装と同じ値を使う。変更すると過去の投稿と一致しなくなる）
export const AI_STAFF_ID = '__ai__';
export const AI_DISPLAY_NAME = '🤖 NAORUアシスタント';

// 既存の合図（api/chat.js が1行目に出す）。変更しない。
export const NEEDS_HQ_MARKER = 'NEEDS_HQ';

const str = (v) => String(v == null ? '' : v);
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// ── ① @AI の起動判定 ────────────────────────────────────────────────────
// 既存挙動（/[@＠]\s*ai\b/i）と同じ結果になるようにする。
// 直後が英数字・アンダースコアのとき（@aiden / @ai2 / mail@aiu…）だけ別語として弾く。
// 直後が日本語のとき（@ai教えて）は既存どおり起動する。
export function isAiTrigger(text) {
  const t = str(text);
  if (!t) return false;
  return /[@＠]\s*ai(?![0-9a-z_])/i.test(t);
}

// AI Question Mode で送るときに本文へ「@AI」を1回だけ付ける（二重付与しない）。
export function composeAiQuestion(text) {
  const t = str(text).trim();
  if (!t) return '';
  return isAiTrigger(t) ? t : `@AI ${t}`;
}

// 本文から @AI を取り除いて、モデルに渡す質問だけにする。
export function stripAiMention(text) {
  return str(text).replace(/[@＠]\s*ai(?![0-9a-z_])/ig, '').replace(/\s+/g, ' ').trim();
}

// ── ② 回答の解釈 ────────────────────────────────────────────────────────
// 1行目の NEEDS_HQ を検出し、本文と分離する（既存の合図をそのまま使う）。
export function parseAiReply(raw) {
  const t = str(raw);
  const m = /^\s*NEEDS_HQ\b[:：]?\s*/.exec(t);
  return { needsHq: !!m, body: (m ? t.slice(m[0].length) : t).trim() };
}

// 確信度の段階。表示は「高 / 中 / 低」、内部では数値を保持する。
export const CONFIDENCE_THRESHOLDS = Object.freeze({ high: 0.8, mid: 0.5 });
export function confidenceLevel(score) {
  const n = num(score);
  if (n >= CONFIDENCE_THRESHOLDS.high) return 'high';
  if (n >= CONFIDENCE_THRESHOLDS.mid) return 'mid';
  return 'low';
}
export const CONFIDENCE_LABEL = Object.freeze({ high: '高', mid: '中', low: '低' });

// 断定させない話題（設定値。特定企業の固有名は入れない）。
// 呼び出し側で差し替え・追加ができる。
export const DEFAULT_SENSITIVE_TOPICS = Object.freeze([
  '給与', '賃金', '報酬', '雇用', '労務', '解雇', '残業',
  '契約', '法令', '法律', '訴訟', '税', '個人情報',
  '医療広告', '薬機', '効果効能', '返金', '解約',
]);

// 本部へエスカレすべきか。理由も返す（画面に出すため）。
//   { needsHq(モデルの申告), sources, confidence, question, sensitiveTopics, minConfidence }
export function shouldEscalate(input = {}) {
  const reasons = [];
  const sources = arr(input.sources);
  const conf = num(input.confidence);
  const min = input.minConfidence == null ? CONFIDENCE_THRESHOLDS.mid : num(input.minConfidence);
  const topics = arr(input.sensitiveTopics).length ? arr(input.sensitiveTopics) : DEFAULT_SENSITIVE_TOPICS;
  const q = str(input.question);

  if (input.needsHq) reasons.push('model_needs_hq');
  if (!sources.length) reasons.push('no_source');
  if (conf < min) reasons.push('low_confidence');
  const hit = topics.filter(t => t && q.includes(t));
  if (hit.length) reasons.push('sensitive_topic');

  return { escalate: reasons.length > 0, reasons, sensitiveHits: hit };
}

// 出典の表示文字列（「📚 出典: 福利厚生規程（2026/09/12 更新）」）。
export function formatSources(sources, opts = {}) {
  const list = arr(sources).filter(s => s && (s.title || s.id)).slice(0, num(opts.max) || 3);
  if (!list.length) return '';
  const one = (s) => {
    const title = str(s.title) || str(s.id);
    const d = str(s.updatedAt).slice(0, 10).replace(/-/g, '/');
    return d ? `${title}（${d} 更新）` : title;
  };
  return `📚 出典: ${list.map(one).join(' / ')}`;
}

// ── ③ AI 回答メッセージの組み立て（保存も送信もしない）────────────────────
// 既存のメッセージ形式に `ai` を**追加するだけ**（旧クライアントは無視できる）。
export function buildAiAnswerMessage(input = {}) {
  const { needsHq, body } = parseAiReply(input.raw);
  const sources = arr(input.sources).map(s => ({
    kind: ['faq', 'knowledge', 'shop_data'].includes(str(s && s.kind)) ? str(s.kind) : 'faq',
    id: str(s && s.id).slice(0, 64),
    title: str(s && s.title).slice(0, 120),
    updatedAt: str(s && s.updatedAt).slice(0, 40),
  })).slice(0, 5);
  const confidence = num(input.confidence);
  const esc = shouldEscalate({
    needsHq, sources, confidence,
    question: str(input.question),
    sensitiveTopics: input.sensitiveTopics,
    minConfidence: input.minConfidence,
  });
  // ⚠️ 実際の依頼・通知は人が「本部に確認」を押したときに作られる。
  //    ここで「依頼しました」と書くと、していないことを書いたことになる。
  const text = esc.escalate
    ? `🙋 ${body}\n\n（根拠が不足しています。この内容は本部の確認が必要です）`
    : body;

  return {
    fromStaffId: AI_STAFF_ID,
    fromName: AI_DISPLAY_NAME,
    fromShop: str(input.shop),
    text,
    mentions: esc.escalate ? arr(input.hqMentions).filter(m => m && m.id && m.name)
      .map(m => ({ id: str(m.id), name: str(m.name) })).slice(0, 10) : [],
    ai: {
      used: true,
      agent: str(input.agent) || 'faq',
      sources,
      confidence,
      level: confidenceLevel(confidence),
      escalated: esc.escalate,
      escalateReasons: esc.reasons,
      answeredAt: str(input.answeredAt) || new Date().toISOString(),
      runId: str(input.runId) || '',       // lib/agentlog.js の run と突き合わせる
    },
  };
}

// ── ④ AI Agent Activity（共通 lib/agentlog.js へ渡す入力を作るだけ）────────
// startRun() が受け取れる形にする。action は共通側の ACTION_KINDS に合わせる。
export function buildAgentRunInput(input = {}) {
  return {
    agentName: str(input.agentName) || AI_DISPLAY_NAME,
    action: ['analyze', 'draft', 'propose', 'notify', 'detect', 'sync', 'execute'].includes(str(input.action))
      ? str(input.action) : 'draft',
    reason: `チャットの質問に回答: ${str(input.question).slice(0, 200)}`,
    source: 'chat',
    status: 'running',
    shop: str(input.shop),
    scope: { roomId: str(input.roomId), askedBy: str(input.askedBy) },
    approvalRequired: false,        // 回答の投稿は外向き操作ではないため承認は不要
  };
}

// finishRun() へ渡す outcome を作る。
export function buildAgentRunOutcome(message, extra = {}) {
  const ai = (message && message.ai) || {};
  return {
    status: extra.failed ? 'failed' : 'completed',
    result: {
      escalated: !!ai.escalated,
      confidence: num(ai.confidence),
      level: str(ai.level),
      sourceCount: arr(ai.sources).length,
      chars: str(message && message.text).length,
    },
    error: str(extra.error),
    usage: extra.usage || null,
  };
}

// ── ⑤ Feedback（👍 / 👎 / 修正）──────────────────────────────────────────
export const FEEDBACK_VERDICTS = Object.freeze(['up', 'down', 'fix']);
export const FEEDBACK_REASONS = Object.freeze(['wrong_fact', 'stale', 'off_topic', 'tone', 'other']);

// 権限は共通基盤で判定した結果を受け取る（②では判定しない）。
//   caps = { feedback:boolean, feedbackFix:boolean }
export function canSubmitFeedback(caps, verdict) {
  const c = caps || {};
  if (!FEEDBACK_VERDICTS.includes(str(verdict))) return false;
  if (!c.feedback) return false;
  if (verdict === 'fix') return !!c.feedbackFix;
  return true;
}

// 保存用レコードを組み立てる（保存は共通ストア側の担当）。
export function buildFeedbackRecord(input = {}, caps) {
  const verdict = str(input.verdict);
  if (!canSubmitFeedback(caps, verdict)) return { ok: false, error: 'forbidden' };
  const correction = str(input.correction).trim();
  if (verdict === 'fix' && !correction) return { ok: false, error: 'correction_required' };
  return {
    ok: true,
    record: {
      id: str(input.id) || `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      tenantId: str(input.tenantId) || 'default',
      messageId: str(input.messageId).slice(0, 64),
      roomId: str(input.roomId).slice(0, 64),
      runId: str(input.runId).slice(0, 64),
      question: str(input.question).slice(0, 2000),
      answer: str(input.answer).slice(0, 4000),
      verdict,
      reasons: arr(input.reasons).map(str).filter(r => FEEDBACK_REASONS.includes(r)).slice(0, 5),
      correction: correction.slice(0, 4000),
      sources: arr(input.sources).slice(0, 5),
      byStaffId: str(input.byStaffId).slice(0, 64),
      byRole: str(input.byRole).slice(0, 20),
      createdAt: str(input.createdAt) || new Date().toISOString(),
    },
  };
}

// 同じ誤回答を繰り返さないための補正ヒント（FAQ 化されるまでの暫定）。
// 過去の fix フィードバックから、同じ質問に対する訂正だけを抜き出して短く返す。
export function correctionHints(feedbacks, question, opts = {}) {
  const q = normalizeQuestion(question);
  if (!q) return [];
  const max = num(opts.max) || 3;
  return arr(feedbacks)
    .filter(f => f && f.verdict === 'fix' && str(f.correction))
    .filter(f => normalizeQuestion(f.question) === q)
    .sort((a, b) => str(b.createdAt).localeCompare(str(a.createdAt)))
    .slice(0, max)
    .map(f => ({ question: str(f.question), correction: str(f.correction), by: str(f.byStaffId), at: str(f.createdAt) }));
}

// 質問の同一判定用の正規化（表記ゆれを吸収。厳密一致のみで、部分一致では混ぜない）
export function normalizeQuestion(text) {
  return stripAiMention(text).normalize('NFKC').replace(/[\s　]+/g, '').replace(/[。．.、,？?！!]/g, '').toLowerCase();
}

// ── ⑥ システム通知の形（将来の外部連携のための拡張余地のみ）───────────────
// ⚠️ ②は外部連携そのものを実装しない。ここは「形」を決めるだけで、送信は一切行わない。
//    'external'（将来の外部アラート等）は allowExternal を明示しない限り必ず拒否する。
export const NOTICE_SOURCES = Object.freeze(['ai', 'sync', 'system', 'external']);

export function buildSystemNotice(input = {}, opts = {}) {
  const source = str(input.source);
  if (!NOTICE_SOURCES.includes(source)) return { ok: false, error: 'unknown_source' };
  if (source === 'external' && !opts.allowExternal) {
    // 外部連携は担当外。既定では作らせない（自動通知を始めないための安全弁）。
    return { ok: false, error: 'external_source_not_enabled' };
  }
  const title = str(input.title).trim();
  const body = str(input.body).trim();
  if (!title && !body) return { ok: false, error: 'empty' };
  return {
    ok: true,
    notice: {
      source,
      kind: str(input.kind).slice(0, 40) || 'info',
      title: title.slice(0, 120),
      body: body.slice(0, 2000),
      link: /^https?:\/\//.test(str(input.link)) ? str(input.link).slice(0, 600) : '',
      roomId: str(input.roomId).slice(0, 64),
      createdAt: str(input.createdAt) || new Date().toISOString(),
      // 送信はしない。呼び出し側が承認・権限判定を通してから使う。
      delivery: 'manual',
    },
  };
}
