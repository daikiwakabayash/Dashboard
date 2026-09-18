// ── チャット内 @AI の「会話の進み方」を決める純粋ロジック ────────────────────
// 画面（chat-ai-trial.html）と実サーバ実装の両方から使える形にしてある。
// I/O・タイマー・DOM を一切持たない。テスト: tests/chat-ai-session.test.js
//
// ここで守る決まり（指示 §3 / §7 / §8）:
//   - 通常投稿では AI を自動起動しない。
//   - 引用・貼り付け文に「@AI」が含まれるだけでは起動しない（**明示的に選択されたときだけ**）。
//   - AI は「人が明示的に質問した同じルーム」にしか返信しない（宛先を自分で選ばない）。
//   - AI 自身の回答を契機に AI が再起動しない。
//   - 二重クリック・再試行・複数タブで回答が重複しない（質問 message_id で束ねる）。
//   - 失敗しても質問と下書きを消さない。
//   - 「本部に確認」は何度押しても依頼が増えない。
//   - 本部の訂正は元回答を黙って上書きせず、訂正者・日時・内容を残す。

import { buildAiAnswerMessage, AI_STAFF_ID } from './chat-ai-ux.js';

export const CHAT_AI_SESSION_VERSION = 'chat-ai-session-1';

const str = (v) => String(v == null ? '' : v);
const arr = (v) => (Array.isArray(v) ? v : []);
const now = (t) => (typeof t === 'number' ? t : Date.now());
const genId = (p) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export function createSession(input = {}) {
  return {
    version: CHAT_AI_SESSION_VERSION,
    roomId: str(input.roomId),
    roomName: str(input.roomName),
    viewerId: str(input.viewerId),
    viewerName: str(input.viewerName),
    viewerRole: str(input.viewerRole) || 'staff',
    participants: arr(input.participants),
    mode: 'normal',              // 'normal' | 'ai'
    draft: '',
    messages: arr(input.messages),
    pending: {},                 // questionId → { clientIds:Set相当の配列, startedAt }
    answersByQuestion: {},       // questionId → answerId
    hqRequests: {},              // questionId → { id, by, at, status }
    corrections: {},             // answerId → [{id, by, role, at, text}]
    feedback: {},                // answerId → { [staffId]: verdict }
    knowledgeCandidates: [],     // 承認候補（自動では Knowledge に入れない）
    errors: {},                  // questionId → メッセージ
    retryable: {},               // questionId → 再試行してよいか（権限エラー等は false）
  };
}

export const setMode = (s, mode) => ({ ...s, mode: mode === 'ai' ? 'ai' : 'normal' });
export const toggleMode = (s) => setMode(s, s.mode === 'ai' ? 'normal' : 'ai');
export const setDraft = (s, text) => ({ ...s, draft: str(text) });

// 送信の意図を判定する。**本文に @AI が含まれるかどうかでは決めない。**
//   mode==='ai' … AI 質問モードで送信
//   mentionPicked=true … 入力補完から @AI を選んだ（明示的な選択）
export function decideIntent(state, opts = {}) {
  const explicit = state.mode === 'ai' || opts.mentionPicked === true;
  return { ai: explicit, reason: explicit ? (state.mode === 'ai' ? 'ai_mode' : 'mention_picked') : 'normal_post' };
}

// 送信。戻り値 { state, posted, aiRequest, skipped }
//   aiRequest が返ったときだけ、呼び出し側が AI へ問い合わせる。
export function submit(state, opts = {}, t) {
  const text = str(opts.text != null ? opts.text : state.draft).trim();
  if (!text) return { state, skipped: 'empty' };

  const intent = decideIntent(state, opts);
  const at = now(t);
  const message = {
    id: str(opts.messageId) || genId('m'),
    roomId: state.roomId,
    fromStaffId: state.viewerId,
    fromName: state.viewerName,
    text,
    createdAt: new Date(at).toISOString(),
    askedAi: intent.ai,
    clientId: str(opts.clientId) || '',
  };

  // 二重送信ガード（同じ clientId の再送は1回だけ扱う）
  if (message.clientId && state.messages.some(m => m.clientId && m.clientId === message.clientId)) {
    return { state, skipped: 'duplicate_client_id' };
  }

  const next = {
    ...state,
    messages: [...state.messages, message],
    draft: '',                      // 送信できたときだけ下書きを消す
  };
  if (!intent.ai) return { state: next, posted: message };

  // AI へ問い合わせる（同じ質問に対する二重起動は防ぐ）
  if (next.pending[message.id]) return { state: next, posted: message, skipped: 'already_pending' };
  next.pending = { ...next.pending, [message.id]: { startedAt: at, clientIds: [message.clientId].filter(Boolean) } };
  return {
    state: next,
    posted: message,
    aiRequest: { questionId: message.id, roomId: state.roomId, question: text, askedBy: state.viewerId },
  };
}

// AI 自身の投稿から AI を再起動しないための判定（保険）
export const isAiMessage = (m) => str(m && m.fromStaffId) === AI_STAFF_ID;

// 回答の適用。同じ質問に2つ目の回答は作らない（複数タブ・再試行対策）。
export function applyAnswer(state, input = {}, t) {
  const questionId = str(input.questionId);
  if (!questionId) return { state, skipped: 'no_question' };
  if (state.answersByQuestion[questionId]) return { state, skipped: 'already_answered' };
  const q = state.messages.find(m => m.id === questionId);
  if (!q) return { state, skipped: 'question_not_found' };
  // AI の投稿に対しては回答しない（AI が AI に反応し続けない）
  if (isAiMessage(q)) return { state, skipped: 'ai_message' };

  const at = now(t);
  const built = buildAiAnswerMessage({ ...input, question: q.text, answeredAt: new Date(at).toISOString() });
  // サーバーが answer_message_id を返した場合はそれを ID にする（複数タブで同じ回答になる）
  const serverAnswerId = str(input.answerMessageId);
  if (serverAnswerId && state.messages.some(m => m.id === serverAnswerId)) {
    return { state, skipped: 'already_answered' };
  }
  const answer = {
    ...built,
    id: serverAnswerId || str(input.answerId) || genId('a'),
    roomId: state.roomId,                 // 質問と同じルームにしか出さない
    replyToId: questionId,
    sample: !!input.sample,               // mock のときは「サンプル回答」と明示する
    createdAt: new Date(at).toISOString(),
  };
  const pending = { ...state.pending }; delete pending[questionId];
  const errors = { ...state.errors }; delete errors[questionId];
  return {
    state: {
      ...state,
      messages: [...state.messages, answer],
      answersByQuestion: { ...state.answersByQuestion, [questionId]: answer.id },
      pending, errors,
    },
    answer,
  };
}

// 失敗。質問も下書きも消さず、再試行/本部確認を選べる状態にする。
export function failAnswer(state, input = {}, t) {
  const questionId = str(input.questionId);
  const pending = { ...state.pending }; delete pending[questionId];
  // retryable:false（権限・ルーム不正など）は自動でも手動でも再試行させない。
  const retryable = input.retryable !== false;
  return {
    state: {
      ...state,
      pending,
      errors: { ...state.errors, [questionId]: str(input.error) || '回答の取得に失敗しました' },
      retryable: { ...(state.retryable || {}), [questionId]: retryable },
      draft: state.draft || str(input.keepDraft || ''),
    },
  };
}

// 再試行（同じ質問をもう一度 AI へ）。回答済みなら何もしない。
export function retry(state, questionId, t) {
  const qid = str(questionId);
  const q = state.messages.find(m => m.id === qid);
  if (!q) return { state, skipped: 'question_not_found' };
  if (state.answersByQuestion[qid]) return { state, skipped: 'already_answered' };
  if (state.pending[qid]) return { state, skipped: 'already_pending' };
  if ((state.retryable || {})[qid] === false) return { state, skipped: 'not_retryable' };
  const errors = { ...state.errors }; delete errors[qid];
  return {
    state: { ...state, errors, pending: { ...state.pending, [qid]: { startedAt: now(t), clientIds: [] } } },
    aiRequest: { questionId: qid, roomId: state.roomId, question: q.text, askedBy: q.fromStaffId },
  };
}

// ── 本部に確認 ───────────────────────────────────────────────────────────
// 何度押しても依頼は増えない（同じ質問につき1件）。
export function requestHqReview(state, input = {}, t) {
  const questionId = str(input.questionId);
  if (!questionId) return { state, created: false, reason: 'no_question' };
  const existing = state.hqRequests[questionId];
  if (existing && existing.status === 'pending') return { state, created: false, reason: 'already_requested', request: existing };
  const req = {
    id: str(input.id) || genId('hq'),
    questionId,
    answerId: str(state.answersByQuestion[questionId] || ''),
    by: str(input.by) || state.viewerId,
    byName: str(input.byName) || state.viewerName,
    at: new Date(now(t)).toISOString(),
    status: 'pending',
    // 通知・監査は①の共通機能へ接続する。未接続なら「未接続」と表示し、
    // 「通知済み」とは表示しない。
    notified: input.notified === true,
    notifyChannel: str(input.notifyChannel) || 'not_connected',
  };
  return { state: { ...state, hqRequests: { ...state.hqRequests, [questionId]: req } }, created: true, request: req };
}

// ── 本部の訂正 ───────────────────────────────────────────────────────────
// 元回答は残したまま、訂正を追記する（黙って上書きしない）。
// 訂正しても全社 Knowledge は自動更新せず、「承認候補」に積むだけ。
export function applyCorrection(state, input = {}, t) {
  const answerId = str(input.answerId);
  const text = str(input.text).trim();
  if (!answerId) return { state, ok: false, error: 'no_answer' };
  if (!text) return { state, ok: false, error: 'empty_correction' };
  if (input.canCorrect === false) return { state, ok: false, error: 'forbidden' };
  const answer = state.messages.find(m => m.id === answerId);
  if (!answer) return { state, ok: false, error: 'answer_not_found' };

  const at = new Date(now(t)).toISOString();
  const rec = { id: genId('fix'), answerId, by: str(input.by), byName: str(input.byName), role: str(input.role), at, text };
  const list = [...arr(state.corrections[answerId]), rec];
  const candidate = {
    id: genId('kc'),
    kind: 'correction',
    questionId: str(answer.replyToId),
    question: str((state.messages.find(m => m.id === answer.replyToId) || {}).text),
    original: str(answer.text),
    correction: text,
    by: rec.by, at,
    status: 'candidate',        // Knowledge への反映は別の承認で行う
  };
  // 質問に付いた本部確認は解決済みにする
  const hq = { ...state.hqRequests };
  const qid = str(answer.replyToId);
  if (hq[qid] && hq[qid].status === 'pending') hq[qid] = { ...hq[qid], status: 'resolved', resolvedAt: at, resolvedBy: rec.by };

  return {
    state: {
      ...state,
      corrections: { ...state.corrections, [answerId]: list },
      knowledgeCandidates: [...state.knowledgeCandidates, candidate],
      hqRequests: hq,
    },
    ok: true, correction: rec, candidate,
  };
}

// ── 参考になった / ならなかった ───────────────────────────────────────────
export function setFeedback(state, input = {}) {
  const answerId = str(input.answerId);
  const verdict = ['up', 'down'].includes(str(input.verdict)) ? str(input.verdict) : '';
  if (!answerId || !verdict) return { state, ok: false };
  const by = str(input.by) || state.viewerId;
  const cur = { ...(state.feedback[answerId] || {}) };
  if (cur[by] === verdict) delete cur[by]; else cur[by] = verdict;   // 同じものを再度押すと取り消し
  return { state: { ...state, feedback: { ...state.feedback, [answerId]: cur } }, ok: true };
}

// 表示用の集計
export function feedbackCount(state, answerId) {
  const m = state.feedback[str(answerId)] || {};
  const vals = Object.values(m);
  return { up: vals.filter(v => v === 'up').length, down: vals.filter(v => v === 'down').length, mine: m[state.viewerId] || '' };
}

// ある質問の状態（画面表示用）
export function questionStatus(state, questionId) {
  const qid = str(questionId);
  return {
    pending: !!state.pending[qid],
    answered: !!state.answersByQuestion[qid],
    answerId: str(state.answersByQuestion[qid] || ''),
    error: str(state.errors[qid] || ''),
    retryable: (state.retryable || {})[qid] !== false,
    hq: state.hqRequests[qid] || null,
  };
}
