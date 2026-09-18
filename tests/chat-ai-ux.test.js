import { describe, it, expect } from 'vitest';
import {
  CHAT_AI_UX_VERSION, AI_STAFF_ID, AI_DISPLAY_NAME,
  isAiTrigger, composeAiQuestion, stripAiMention, parseAiReply,
  confidenceLevel, CONFIDENCE_LABEL, shouldEscalate, DEFAULT_SENSITIVE_TOPICS, formatSources,
  buildAiAnswerMessage, buildAgentRunInput, buildAgentRunOutcome,
  canSubmitFeedback, buildFeedbackRecord, correctionHints, normalizeQuestion,
  buildSystemNotice, NOTICE_SOURCES,
} from '../lib/chat-ai-ux.js';
// ①の共通基盤（再実装せず、入力が受け付けられることだけを確認する）
import { startRun, finishRun, ACTION_KINDS, SOURCES } from '../lib/agentlog.js';

describe('chat-ai-ux: @AI の起動判定（既存挙動の維持）', () => {
  it('半角@・全角＠・大文字小文字・前後の空白に対応', () => {
    ['@AI 教えて', '＠ai 教えて', '@ai教えて', 'メモ @Ai これ何', '@ AI 教えて'].forEach(t =>
      expect(isAiTrigger(t)).toBe(true));
  });
  it('別の語には反応しない', () => {
    ['@aiden さん', '@aiko', 'AIについて', 'mail@aiu.example', '@airi'].forEach(t =>
      expect(isAiTrigger(t)).toBe(false));
    expect(isAiTrigger('')).toBe(false);
  });
  it('既存の判定式 /[@＠]\\s*ai\\b/i と同じ結果になる（既存仕様の維持）', () => {
    const legacy = (t) => /[@＠]\s*ai\b/i.test(t);
    const samples = [
      '@AI 教えて', '＠ai 教えて', '@ai教えて', '@ AI 教えて', 'メモ @Ai これ何',
      '@aiden さん', '@aiko', '@airi', 'mail@aiu.example', 'AIについて',
      '普通のメッセージ', '', '@ai', '＠AI？', 'ai だけ',
    ];
    samples.forEach(t => expect(isAiTrigger(t)).toBe(legacy(t)));
  });
  it('AI Question Mode は @AI を1回だけ付ける（二重付与しない）', () => {
    expect(composeAiQuestion('家族施術のルール')).toBe('@AI 家族施術のルール');
    expect(composeAiQuestion('@AI 家族施術のルール')).toBe('@AI 家族施術のルール');
    expect(composeAiQuestion('＠ai 家族施術')).toBe('＠ai 家族施術');
    expect(composeAiQuestion('   ')).toBe('');
  });
  it('モデルに渡す質問からは @AI を取り除く', () => {
    expect(stripAiMention('@AI 家族施術制度のルール教えて')).toBe('家族施術制度のルール教えて');
    expect(stripAiMention('＠ai  客単価は？')).toBe('客単価は？');
  });
});

describe('chat-ai-ux: 回答の解釈', () => {
  it('1行目の NEEDS_HQ を検出して本文と分ける（既存の合図をそのまま使う）', () => {
    expect(parseAiReply('NEEDS_HQ: わかりません')).toEqual({ needsHq: true, body: 'わかりません' });
    expect(parseAiReply('NEEDS_HQ\n本文')).toEqual({ needsHq: true, body: '本文' });
    expect(parseAiReply('通常の回答')).toEqual({ needsHq: false, body: '通常の回答' });
  });
  it('確信度 → 高/中/低', () => {
    expect(confidenceLevel(0.95)).toBe('high');
    expect(confidenceLevel(0.8)).toBe('high');
    expect(confidenceLevel(0.6)).toBe('mid');
    expect(confidenceLevel(0.49)).toBe('low');
    expect(confidenceLevel(undefined)).toBe('low');
    expect(CONFIDENCE_LABEL.high).toBe('高');
  });
  it('出典は「タイトル（更新日）」で整形し、無ければ空文字', () => {
    expect(formatSources([{ title: '福利厚生規程', updatedAt: '2026-09-12T00:00:00Z' }]))
      .toBe('📚 出典: 福利厚生規程（2026/09/12 更新）');
    expect(formatSources([])).toBe('');
  });
});

describe('chat-ai-ux: エスカレーション（断定させない）', () => {
  const ok = { needsHq: false, sources: [{ id: 'f1' }], confidence: 0.9, question: 'シフトの出し方' };
  it('十分な根拠と確信度があればエスカレしない', () => {
    expect(shouldEscalate(ok).escalate).toBe(false);
  });
  it('根拠0件・低確信度・モデルの申告でエスカレする', () => {
    expect(shouldEscalate({ ...ok, sources: [] }).reasons).toContain('no_source');
    expect(shouldEscalate({ ...ok, confidence: 0.3 }).reasons).toContain('low_confidence');
    expect(shouldEscalate({ ...ok, needsHq: true }).reasons).toContain('model_needs_hq');
  });
  it('金銭・労務・法令などの話題は確信度が高くてもエスカレする', () => {
    const r = shouldEscalate({ ...ok, question: '給与の計算方法を教えて' });
    expect(r.escalate).toBe(true);
    expect(r.reasons).toContain('sensitive_topic');
    expect(r.sensitiveHits).toContain('給与');
  });
  it('対象語は差し替えできる（固有名をコードに埋めない）', () => {
    expect(DEFAULT_SENSITIVE_TOPICS).toContain('労務');
    const r = shouldEscalate({ ...ok, question: 'いちご狩りの予定', sensitiveTopics: ['いちご'] });
    expect(r.reasons).toEqual(['sensitive_topic']);
  });
});

describe('chat-ai-ux: AI 回答メッセージの組み立て', () => {
  const base = {
    raw: '家族施術は…です。', question: '家族施術のルール', shop: 'A院',
    sources: [{ kind: 'faq', id: 'f1', title: '福利厚生規程', updatedAt: '2026-09-12T00:00:00Z' }],
    confidence: 0.9, answeredAt: '2026-09-18T01:00:00.000Z', runId: 'run_1',
  };
  it('既存の投稿者ID・表示名を変えない', () => {
    const m = buildAiAnswerMessage(base);
    expect(m.fromStaffId).toBe('__ai__');
    expect(m.fromName).toBe(AI_DISPLAY_NAME);
    expect(AI_STAFF_ID).toBe('__ai__');
    expect(CHAT_AI_UX_VERSION).toBe('chat-ai-ux-1');
  });
  it('ai メタ（出典・確信度・エスカレ）を付ける（既存フィールドは壊さない）', () => {
    const m = buildAiAnswerMessage(base);
    expect(m.ai).toMatchObject({ used: true, agent: 'faq', confidence: 0.9, level: 'high', escalated: false, runId: 'run_1' });
    expect(m.ai.sources[0].title).toBe('福利厚生規程');
    expect(m.text).toBe('家族施術は…です。');
    expect(m.mentions).toEqual([]);
  });
  it('エスカレ時は本文に案内を足し、本部をメンションする', () => {
    const m = buildAiAnswerMessage({ ...base, sources: [], hqMentions: [{ id: 'hq1', name: '本部 太郎' }] });
    expect(m.ai.escalated).toBe(true);
    expect(m.ai.escalateReasons).toContain('no_source');
    expect(m.text).toMatch(/本部の確認が必要です/);
    // 実際にはまだ依頼していないので「依頼しました」とは書かない
    expect(m.text).not.toMatch(/依頼しました/);
    expect(m.mentions).toEqual([{ id: 'hq1', name: '本部 太郎' }]);
  });
  it('NEEDS_HQ 付きの生回答でもエスカレ扱いになる', () => {
    const m = buildAiAnswerMessage({ ...base, raw: 'NEEDS_HQ: 判断できません' });
    expect(m.ai.escalated).toBe(true);
    expect(m.text).toMatch(/^🙋 判断できません/);
  });
});

describe('chat-ai-ux: AI Agent Activity（共通 lib/agentlog.js に接続）', () => {
  it('buildAgentRunInput が共通の startRun にそのまま通る', () => {
    const input = buildAgentRunInput({ question: '@AI 客単価は？', roomId: 'store_A', shop: 'A院', askedBy: 's1' });
    expect(ACTION_KINDS[input.action]).toBeTruthy();
    expect(SOURCES).toContain(input.source);
    const r = startRun(input, 1700000000000);
    expect(r.ok).toBe(true);
    expect(r.run.source).toBe('chat');
    expect(r.run.scope).toEqual({ roomId: 'store_A', askedBy: 's1' });
    expect(r.run.approvalRequired).toBe(false);
  });
  it('buildAgentRunOutcome が共通の finishRun にそのまま通る', () => {
    const run = startRun(buildAgentRunInput({ question: 'q', roomId: 'r' }), 1700000000000).run;
    const msg = buildAiAnswerMessage({ raw: 'ok', question: 'q', sources: [{ id: 'f1' }], confidence: 0.9 });
    const done = finishRun(run, buildAgentRunOutcome(msg), 1700000001000);
    expect(done.ok).toBe(true);
    expect(done.run.status).toBe('completed');
    expect(done.run.result.sourceCount).toBe(1);
  });
  it('失敗時は failed として記録できる', () => {
    const run = startRun(buildAgentRunInput({ question: 'q' }), 1700000000000).run;
    const done = finishRun(run, buildAgentRunOutcome(null, { failed: true, error: 'timeout' }), 1700000002000);
    expect(done.run.status).toBe('failed');
    expect(done.run.error).toBe('timeout');
  });
});

describe('chat-ai-ux: Feedback（権限は共通基盤の結果を受け取る）', () => {
  const HQ = { feedback: true, feedbackFix: true };
  const STAFF = { feedback: true, feedbackFix: false };
  it('staff は 👍👎 のみ、修正は本部/オーナー以上', () => {
    expect(canSubmitFeedback(STAFF, 'up')).toBe(true);
    expect(canSubmitFeedback(STAFF, 'down')).toBe(true);
    expect(canSubmitFeedback(STAFF, 'fix')).toBe(false);
    expect(canSubmitFeedback(HQ, 'fix')).toBe(true);
    expect(canSubmitFeedback(null, 'up')).toBe(false);
    expect(canSubmitFeedback(HQ, 'unknown')).toBe(false);
  });
  it('修正には本文が必須', () => {
    expect(buildFeedbackRecord({ verdict: 'fix', correction: '' }, HQ)).toEqual({ ok: false, error: 'correction_required' });
    const r = buildFeedbackRecord({ verdict: 'fix', correction: '正しくはこう', messageId: 'm1', question: 'q', answer: 'a', byStaffId: 'hq1', byRole: 'hq' }, HQ);
    expect(r.ok).toBe(true);
    expect(r.record).toMatchObject({ verdict: 'fix', correction: '正しくはこう', byRole: 'hq' });
  });
  it('権限が無ければレコードを作らない', () => {
    expect(buildFeedbackRecord({ verdict: 'fix', correction: 'x' }, STAFF)).toEqual({ ok: false, error: 'forbidden' });
  });
  it('未知の理由コードは捨てる', () => {
    const r = buildFeedbackRecord({ verdict: 'down', reasons: ['stale', 'evil'] }, STAFF);
    expect(r.record.reasons).toEqual(['stale']);
  });
  it('同じ質問への修正だけを補正ヒントに使う（部分一致では混ぜない）', () => {
    const fbs = [
      { verdict: 'fix', question: '家族施術のルールは？', correction: '2親等まで', createdAt: '2026-09-01' },
      { verdict: 'fix', question: '家族施術のルールは？', correction: '2親等まで（改定）', createdAt: '2026-09-10' },
      { verdict: 'fix', question: '家族施術の料金は？', correction: '別の話', createdAt: '2026-09-11' },
      { verdict: 'down', question: '家族施術のルールは？', correction: '', createdAt: '2026-09-12' },
    ];
    const hints = correctionHints(fbs, '@AI 家族施術のルールは？');
    expect(hints.map(h => h.correction)).toEqual(['2親等まで（改定）', '2親等まで']);
  });
  it('質問の正規化は表記ゆれを吸収する', () => {
    expect(normalizeQuestion('@AI 家族施術の　ルールは？')).toBe(normalizeQuestion('家族施術のルールは'));
  });
});

describe('chat-ai-ux: システム通知の形（将来の拡張余地のみ・送信はしない）', () => {
  it('ai / sync / system は作れる', () => {
    const r = buildSystemNotice({ source: 'sync', kind: 'room_sync', title: '同期結果', body: '3件' });
    expect(r.ok).toBe(true);
    expect(r.notice.delivery).toBe('manual');     // 自動送信はしない
  });
  it('external（将来の外部連携）は既定で拒否する', () => {
    expect(buildSystemNotice({ source: 'external', title: 'x', body: 'y' }))
      .toEqual({ ok: false, error: 'external_source_not_enabled' });
    // 明示的に許可したときだけ形を作れる（それでも送信はしない）
    const r = buildSystemNotice({ source: 'external', kind: 'alert', title: 'x', body: 'y' }, { allowExternal: true });
    expect(r.ok).toBe(true);
    expect(r.notice.source).toBe('external');
    expect(r.notice.delivery).toBe('manual');
  });
  it('未知の source と空の通知は作らない', () => {
    expect(buildSystemNotice({ source: 'whatever', title: 'x' }).error).toBe('unknown_source');
    expect(buildSystemNotice({ source: 'ai' }).error).toBe('empty');
    expect(NOTICE_SOURCES).toEqual(['ai', 'sync', 'system', 'external']);
  });
  it('リンクは http(s) のみ通す', () => {
    expect(buildSystemNotice({ source: 'ai', title: 't', link: 'javascript:alert(1)' }).notice.link).toBe('');
    expect(buildSystemNotice({ source: 'ai', title: 't', link: 'https://example.com' }).notice.link).toBe('https://example.com');
  });
});
