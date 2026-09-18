import { describe, it, expect } from 'vitest';
import {
  createSession, setMode, toggleMode, setDraft, decideIntent, submit,
  applyAnswer, failAnswer, retry, requestHqReview, applyCorrection,
  setFeedback, feedbackCount, questionStatus, isAiMessage, CHAT_AI_SESSION_VERSION,
  newRequestId,
} from '../lib/chat-ai-session.js';

const S = (over = {}) => createSession({ roomId: 'store_A', roomName: 'A院', viewerId: 's1', viewerName: '佐藤', viewerRole: 'staff', ...over });
const ANSWER = { sources: [{ kind: 'faq', id: 'f1', title: '福利厚生規程', version: '1.2', updatedAt: '2026-09-12T00:00:00Z' }], confidence: 0.9, raw: '2親等までです。', sample: true };

describe('chat-ai-session: モードと起動条件', () => {
  it('既定は通常モード。トグルで AI モードへ', () => {
    expect(CHAT_AI_SESSION_VERSION).toBe('chat-ai-session-1');
    expect(S().mode).toBe('normal');
    expect(toggleMode(S()).mode).toBe('ai');
    expect(toggleMode(toggleMode(S())).mode).toBe('normal');
    expect(setMode(S(), 'ai').mode).toBe('ai');
  });
  it('通常投稿では AI を自動起動しない', () => {
    const r = submit(S(), { text: '今日の予約どう？' });
    expect(r.posted.askedAi).toBe(false);
    expect(r.aiRequest).toBeUndefined();
  });
  it('本文に @AI が含まれるだけでは起動しない（引用・貼り付け対策）', () => {
    const quoted = '（転記）Aさん: @AI 家族施術のルール教えて';
    const r = submit(S(), { text: quoted });
    expect(r.aiRequest).toBeUndefined();
    expect(decideIntent(S(), {}).ai).toBe(false);
  });
  it('AI モードでの送信、または @AI を明示的に選んだときだけ起動する', () => {
    expect(submit(setMode(S(), 'ai'), { text: '家族施術のルール' }).aiRequest).toBeTruthy();
    expect(submit(S(), { text: '@AI 家族施術のルール', mentionPicked: true }).aiRequest).toBeTruthy();
    expect(decideIntent(setMode(S(), 'ai'), {}).reason).toBe('ai_mode');
    expect(decideIntent(S(), { mentionPicked: true }).reason).toBe('mention_picked');
  });
  it('AI は質問と同じルームにしか返信しない', () => {
    const r = submit(setMode(S(), 'ai'), { text: 'q' });
    expect(r.aiRequest.roomId).toBe('store_A');
    const a = applyAnswer(r.state, { questionId: r.aiRequest.questionId, ...ANSWER });
    expect(a.answer.roomId).toBe('store_A');
    expect(a.answer.replyToId).toBe(r.aiRequest.questionId);
  });
});

describe('chat-ai-session: 重複防止', () => {
  it('同じ clientId の二重送信は1件しか投稿しない', () => {
    const s0 = setMode(S(), 'ai');
    const r1 = submit(s0, { text: 'q', clientId: 'c1' });
    const r2 = submit(r1.state, { text: 'q', clientId: 'c1' });
    expect(r2.skipped).toBe('duplicate_client_id');
    expect(r2.state.messages.length).toBe(1);
  });
  it('同じ質問に2つ目の回答を作らない（複数タブ・再試行）', () => {
    const r = submit(setMode(S(), 'ai'), { text: 'q' });
    const qid = r.aiRequest.questionId;
    const a1 = applyAnswer(r.state, { questionId: qid, ...ANSWER });
    const a2 = applyAnswer(a1.state, { questionId: qid, ...ANSWER });
    expect(a2.skipped).toBe('already_answered');
    expect(a2.state.messages.filter(m => m.replyToId === qid).length).toBe(1);
  });
  it('回答済みの質問は再試行しない', () => {
    const r = submit(setMode(S(), 'ai'), { text: 'q' });
    const qid = r.aiRequest.questionId;
    const a = applyAnswer(r.state, { questionId: qid, ...ANSWER });
    expect(retry(a.state, qid).skipped).toBe('already_answered');
  });
  it('AI の投稿を契機に AI が再起動しない', () => {
    const r = submit(setMode(S(), 'ai'), { text: 'q' });
    const a = applyAnswer(r.state, { questionId: r.aiRequest.questionId, ...ANSWER });
    const aiMsgId = a.answer.id;
    expect(isAiMessage(a.answer)).toBe(true);
    expect(applyAnswer(a.state, { questionId: aiMsgId, ...ANSWER }).skipped).toBe('ai_message');
  });
});

describe('chat-ai-session: 失敗時', () => {
  it('質問は残り、下書きも消えず、再試行できる', () => {
    const s0 = setDraft(setMode(S(), 'ai'), '家族施術のルール');
    const r = submit(s0, {});
    const qid = r.aiRequest.questionId;
    const f = failAnswer(r.state, { questionId: qid, error: 'timeout', keepDraft: '家族施術のルール' });
    expect(f.state.messages.length).toBe(1);                 // 質問は消えない
    expect(f.state.draft).toBe('家族施術のルール');            // 下書きも戻る
    expect(questionStatus(f.state, qid).error).toBe('timeout');
    const again = retry(f.state, qid);
    expect(again.aiRequest.questionId).toBe(qid);
    expect(questionStatus(again.state, qid).error).toBe('');
  });
  it('失敗した質問にも本部確認を出せる', () => {
    const r = submit(setMode(S(), 'ai'), { text: 'q' });
    const f = failAnswer(r.state, { questionId: r.aiRequest.questionId, error: 'timeout' });
    expect(requestHqReview(f.state, { questionId: r.aiRequest.questionId }).created).toBe(true);
  });
});

describe('chat-ai-session: 本部に確認', () => {
  const setup = () => {
    const r = submit(setMode(S(), 'ai'), { text: '家族施術のルール' });
    const qid = r.aiRequest.questionId;
    const a = applyAnswer(r.state, { questionId: qid, ...ANSWER });
    return { state: a.state, qid, answerId: a.answer.id };
  };
  it('依頼は1件だけ。何度押しても増えない', () => {
    const { state, qid } = setup();
    const h1 = requestHqReview(state, { questionId: qid });
    expect(h1.created).toBe(true);
    const h2 = requestHqReview(h1.state, { questionId: qid });
    expect(h2.created).toBe(false);
    expect(h2.reason).toBe('already_requested');
    expect(Object.keys(h2.state.hqRequests).length).toBe(1);
  });
  it('通知が未接続なら「通知済み」にしない', () => {
    const { state, qid } = setup();
    const h = requestHqReview(state, { questionId: qid });
    expect(h.request.notified).toBe(false);
    expect(h.request.notifyChannel).toBe('not_connected');
  });
  it('回答と紐づく（どの質問・どの回答への確認か分かる）', () => {
    const { state, qid, answerId } = setup();
    const h = requestHqReview(state, { questionId: qid });
    expect(h.request.questionId).toBe(qid);
    expect(h.request.answerId).toBe(answerId);
  });
});

describe('chat-ai-session: 本部の訂正', () => {
  const setup = () => {
    const r = submit(setMode(S(), 'ai'), { text: '家族施術のルール' });
    const qid = r.aiRequest.questionId;
    const a = applyAnswer(r.state, { questionId: qid, ...ANSWER });
    const h = requestHqReview(a.state, { questionId: qid });
    return { state: h.state, qid, answerId: a.answer.id, original: a.answer.text };
  };
  it('元回答を上書きせず、訂正者・日時・内容を残す', () => {
    const { state, answerId, original } = setup();
    const c = applyCorrection(state, { answerId, text: '正しくは3親等までです', by: 'hq1', byName: '本部 太郎', role: 'hq' });
    expect(c.ok).toBe(true);
    const answer = c.state.messages.find(m => m.id === answerId);
    expect(answer.text).toBe(original);                       // 元回答はそのまま
    expect(c.state.corrections[answerId][0]).toMatchObject({ by: 'hq1', byName: '本部 太郎', role: 'hq', text: '正しくは3親等までです' });
    expect(c.state.corrections[answerId][0].at).toBeTruthy();
  });
  it('訂正は追記。複数回の訂正が履歴として残る', () => {
    const { state, answerId } = setup();
    const c1 = applyCorrection(state, { answerId, text: '訂正1', by: 'hq1', role: 'hq' });
    const c2 = applyCorrection(c1.state, { answerId, text: '訂正2', by: 'hq2', role: 'hq' });
    expect(c2.state.corrections[answerId].map(x => x.text)).toEqual(['訂正1', '訂正2']);
  });
  it('訂正しても全社 Knowledge を自動更新せず、承認候補に積むだけ', () => {
    const { state, answerId } = setup();
    const c = applyCorrection(state, { answerId, text: '正しくはこう', by: 'hq1', role: 'hq' });
    expect(c.candidate.status).toBe('candidate');
    expect(c.state.knowledgeCandidates.length).toBe(1);
    expect(c.state.knowledgeCandidates[0].correction).toBe('正しくはこう');
  });
  it('訂正すると本部確認は解決済みになる', () => {
    const { state, answerId, qid } = setup();
    const c = applyCorrection(state, { answerId, text: 'x', by: 'hq1', role: 'hq' });
    expect(c.state.hqRequests[qid].status).toBe('resolved');
    expect(c.state.hqRequests[qid].resolvedBy).toBe('hq1');
  });
  it('権限が無ければ訂正できない（判定は共通基盤の結果を受け取る）', () => {
    const { state, answerId } = setup();
    expect(applyCorrection(state, { answerId, text: 'x', canCorrect: false }).error).toBe('forbidden');
    expect(applyCorrection(state, { answerId, text: '' }).error).toBe('empty_correction');
  });
});

describe('chat-ai-session: 参考になった / ならなかった', () => {
  it('付け外しできて、集計できる', () => {
    const r = submit(setMode(S(), 'ai'), { text: 'q' });
    const a = applyAnswer(r.state, { questionId: r.aiRequest.questionId, ...ANSWER });
    let st = setFeedback(a.state, { answerId: a.answer.id, verdict: 'up' }).state;
    expect(feedbackCount(st, a.answer.id)).toEqual({ up: 1, down: 0, mine: 'up' });
    st = setFeedback(st, { answerId: a.answer.id, verdict: 'up' }).state;       // もう一度押すと取り消し
    expect(feedbackCount(st, a.answer.id)).toEqual({ up: 0, down: 0, mine: '' });
    st = setFeedback(st, { answerId: a.answer.id, verdict: 'down', by: 'other' }).state;
    expect(feedbackCount(st, a.answer.id).down).toBe(1);
  });
});

// ── 依頼ID（request_id）の発行 ────────────────────────────────────────────
// 決まり:
//   ・送信のたびに新しい request_id を発行する（質問本文＋ルームから固定IDを作らない）。
//   ・**同じ送信の再試行**だけ同じ request_id を維持する。
//   ・別々に新規質問した場合は、本文が同じでも別の依頼として扱う（別タブでも同じ）。
// 責任分界: 同じ request_id の重複実行防止はサーバー（①）。回答カードの重複表示防止はここ（②）。
describe('chat-ai-session: 依頼ID（request_id）', () => {
  const ask = (st, text) => submit(setMode(st, 'ai'), { text });

  it('AI送信ごとに新しい依頼IDを発行する', () => {
    const r = ask(S(), '家族施術のルールは？');
    expect(r.aiRequest.requestId).toBeTruthy();
    expect(r.posted.requestId).toBe(r.aiRequest.requestId);
  });

  it('同じ本文を別々に新規送信すると、別の依頼IDになる', () => {
    const r1 = ask(S(), '家族施術のルールは？');
    const r2 = ask(r1.state, '家族施術のルールは？');
    expect(r2.aiRequest.requestId).not.toBe(r1.aiRequest.requestId);
  });

  it('同じ本文・同じルームでも依頼IDは本文から作られていない', () => {
    const a = ask(S(), '同じ本文').aiRequest;
    const b = ask(S(), '同じ本文').aiRequest;
    expect(a.roomId).toBe(b.roomId);
    expect(a.requestId).not.toBe(b.requestId);
    expect(a.requestId).not.toContain('同じ本文');
  });

  it('同じ送信の再試行は同じ依頼IDを維持する', () => {
    const r = ask(S(), '再試行の確認');
    const failed = failAnswer(r.state, { questionId: r.posted.id, error: 'timeout' }).state;
    const again = retry(failed, r.posted.id);
    expect(again.aiRequest.requestId).toBe(r.aiRequest.requestId);
    // 何度再試行しても変わらない
    const failed2 = failAnswer(again.state, { questionId: r.posted.id, error: 'timeout' }).state;
    expect(retry(failed2, r.posted.id).aiRequest.requestId).toBe(r.aiRequest.requestId);
  });

  it('別タブが同じ送信レコードを共有して再試行しても同じ依頼ID（新規質問とは区別する）', () => {
    const r = ask(S(), '共有された同じ送信');
    // 別タブ = 同じ質問メッセージを持つ別セッション
    const otherTab = failAnswer({ ...S(), messages: [r.posted] }, { questionId: r.posted.id, error: 'timeout' }).state;
    expect(retry(otherTab, r.posted.id).aiRequest.requestId).toBe(r.aiRequest.requestId);
    // 別タブが「自分で新しく質問した」場合は別の依頼
    expect(ask(S(), '共有された同じ送信').aiRequest.requestId).not.toBe(r.aiRequest.requestId);
  });

  it('依頼IDが欠けた質問を再試行するときは1回だけ発行して固定する', () => {
    const q = { id: 'm_old', roomId: 'store_A', fromStaffId: 's1', text: '古い状態', askedAi: true };
    let st = { ...S(), messages: [q] };
    const first = retry(st, 'm_old');
    expect(first.aiRequest.requestId).toBeTruthy();
    const failed = failAnswer(first.state, { questionId: 'm_old', error: 'timeout' }).state;
    expect(retry(failed, 'm_old').aiRequest.requestId).toBe(first.aiRequest.requestId);
  });

  it('newRequestId は毎回異なる', () => {
    expect(new Set([newRequestId(), newRequestId(), newRequestId()]).size).toBe(3);
  });
});
