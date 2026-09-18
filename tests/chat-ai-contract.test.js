// ── 契約準拠テスト（CHAT_AI_API_CONTRACT.md）────────────────────────────
// ⚠️ これは「①のサーバーを模した参照実装」に対するクライアント側の準拠テストであり、
//    **①の実サーバーを通した実運用テストではない**。実運用テストは接続後に別途行う。
//    ここで確かめるのは「サーバーがこう返したとき、クライアントが正しく振る舞うか」。

import { describe, it, expect } from 'vitest';
import { createLiveAdapter, buildContext, resolveSources } from '../lib/chat-ai-adapter.js';
import {
  createSession, setMode, submit, applyAnswer, failAnswer, retry,
  requestHqReview, applyCorrection, questionStatus,
} from '../lib/chat-ai-session.js';

// ── ①のサーバーを模した参照実装（契約どおりに振る舞う）──────────────────
function createRefServer(opts = {}) {
  const answered = new Map();     // request_id → 応答（冪等）
  const rooms = opts.rooms || { store_A: { members: ['s1', 'hq1'], tenant: 'naoru' } };
  const actor = opts.actor || { id: 's1', role: 'staff', tenant: 'naoru', rolloutOn: true };
  const calls = [];
  const err = (code, retryable) => ({ ok: false, error: { code, message: code, retryable } });

  return {
    calls,
    async fetch(url, init) {
      const body = JSON.parse(init.body);
      calls.push(body);
      const json = (o) => ({ json: async () => o });

      if (!body.question || !body.room_id || !body.request_id) return json(err('invalid_request', false));
      if (!actor.rolloutOn) return json(err('rollout_disabled', false));
      const room = rooms[body.room_id];
      if (!room) return json(err('forbidden_room', false));
      if (room.tenant !== actor.tenant) return json(err('tenant_mismatch', false));
      if (!room.members.includes(actor.id)) return json(err('not_member', false));
      if (opts.aiSource) return json(err('ai_message_source', false));
      if (opts.failWith) return json(err(opts.failWith, opts.failWith === 'rate_limited' || opts.failWith === 'upstream_failed'));

      // 冪等: 同じ request_id は同じ回答を返す
      if (answered.has(body.request_id)) return json(answered.get(body.request_id));
      const n = answered.size + 1;
      const res = {
        ok: true,
        question_message_id: body.question_message_id || `m_srv_${n}`,
        answer_message_id: `a_srv_${n}`,
        room_id: body.room_id,                       // 必ず質問と同じルーム
        body: '家族施術制度は2親等以内が対象です。',
        mode: 'live',
        sources: opts.unverified
          ? { verification: 'unverified', verified: [], candidates: [{ doc_id: 'faq_family', title: '家族施術制度' }] }
          : { verification: 'server_verified',
              verified: [{ doc_id: 'faq_family', title: '家族施術制度', version: '1.2', updated_at: '2026-09-12T00:00:00Z', locator: '§3', confidence: 'exact' }],
              candidates: [{ doc_id: 'faq_shift', title: 'シフト提出ルール' }] },
        hq_review: { status: 'none', request_id: null, notified: false, channel: 'not_connected' },
      };
      answered.set(body.request_id, res);
      return json(res);
    },
  };
}

const ctx = () => buildContext({ roomId: 'store_A', shopId: 'A', tenantId: 'naoru', docs: [
  { id: 'faq_family', title: '家族施術制度', visibility: 'company', keywords: ['家族'], answer: '…' },
] });

const ask = async (adapter, over = {}) => adapter.ask({
  question: '家族施術のルールは？', roomId: 'store_A', requestId: 'req_1', clientId: 'tab_1',
  questionMessageId: 'm_1', context: ctx(), ...over,
});

describe('契約: リクエストの形', () => {
  it('question / room_id / request_id / client_id を送り、本文ではなく ID のヒントだけを送る', async () => {
    const srv = createRefServer();
    await ask(createLiveAdapter({ fetch: srv.fetch }));
    expect(srv.calls[0]).toMatchObject({
      question: '家族施術のルールは？', room_id: 'store_A', request_id: 'req_1', client_id: 'tab_1',
      question_message_id: 'm_1', context_hint: { doc_ids: ['faq_family'] },
    });
    expect(JSON.stringify(srv.calls[0])).not.toMatch(/dataContext|本文/);
  });
  it('認証情報はヘッダでそのまま渡す（クライアントは role を主張しない）', async () => {
    let headers = null;
    const adapter = createLiveAdapter({
      headers: () => ({ Authorization: 'Bearer tok', 'X-Chat-Token': 't' }),
      fetch: async (u, i) => { headers = i.headers; return { json: async () => ({ ok: true, body: 'x', answer_message_id: 'a1', room_id: 'store_A' }) }; },
    });
    await ask(adapter);
    expect(headers.Authorization).toBe('Bearer tok');
    expect(JSON.stringify(headers)).not.toMatch(/role|tenant/i);
  });
  it('room_id / request_id が無いまま問い合わせない', async () => {
    const srv = createRefServer();
    const a = createLiveAdapter({ fetch: srv.fetch });
    expect((await ask(a, { roomId: '' })).error).toMatchObject({ code: 'invalid_request', retryable: false });
    expect((await ask(a, { requestId: '' })).error).toMatchObject({ code: 'invalid_request', retryable: false });
    expect(srv.calls.length).toBe(0);
  });
});

describe('契約: 重複防止（複数タブ・再試行）', () => {
  it('同じ request_id なら同じ answer_message_id が返り、回答カードは1つ', async () => {
    const srv = createRefServer();
    const adapter = createLiveAdapter({ fetch: srv.fetch });
    const r1 = await ask(adapter);
    const r2 = await ask(adapter);                      // 別タブからの再送（同じ request_id）
    expect(r1.answerMessageId).toBe(r2.answerMessageId);

    let s = createSession({ roomId: 'store_A', viewerId: 's1', viewerName: '佐藤' });
    s = submit(setMode(s, 'ai'), { text: '家族施術のルールは？', messageId: 'm_1' }).state;
    s = applyAnswer(s, { questionId: 'm_1', raw: r1.body, sourceInfo: resolveSources(r1, ctx()), answerMessageId: r1.answerMessageId }).state;
    const second = applyAnswer(s, { questionId: 'm_1', raw: r2.body, sourceInfo: resolveSources(r2, ctx()), answerMessageId: r2.answerMessageId });
    expect(second.skipped).toBe('already_answered');
    expect(s.messages.filter(m => m.fromStaffId === '__ai__').length).toBe(1);
  });
  it('別セッション（別タブ）でも answer_message_id が同じなら二重に描かない', async () => {
    const srv = createRefServer();
    const adapter = createLiveAdapter({ fetch: srv.fetch });
    const r = await ask(adapter);
    let tab2 = createSession({ roomId: 'store_A', viewerId: 's1', viewerName: '佐藤' });
    tab2 = submit(setMode(tab2, 'ai'), { text: 'q', messageId: 'm_1' }).state;
    tab2 = applyAnswer(tab2, { questionId: 'm_1', raw: r.body, answerMessageId: r.answerMessageId }).state;
    const again = applyAnswer(tab2, { questionId: 'm_1', raw: r.body, answerMessageId: r.answerMessageId });
    expect(again.skipped).toBe('already_answered');
  });
});

describe('契約: 拒否されるケース（クライアントは自動再試行しない）', () => {
  const cases = [
    ['非参加ルーム', { rooms: { store_B: { members: ['s1'], tenant: 'naoru' } } }, 'forbidden_room'],
    ['メンバー外', { rooms: { store_A: { members: ['other'], tenant: 'naoru' } } }, 'not_member'],
    ['別テナント', { rooms: { store_A: { members: ['s1'], tenant: 'other' } } }, 'tenant_mismatch'],
    ['未公開ロール', { actor: { id: 's1', role: 'staff', tenant: 'naoru', rolloutOn: false } }, 'rollout_disabled'],
    ['AI投稿からの起動', { aiSource: true }, 'ai_message_source'],
  ];
  for (const [label, opts, code] of cases) {
    it(`${label} は ${code} で拒否され、再試行もしない`, async () => {
      const srv = createRefServer(opts);
      const r = await ask(createLiveAdapter({ fetch: srv.fetch }));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe(code);
      expect(r.error.retryable).toBe(false);

      let s = createSession({ roomId: 'store_A', viewerId: 's1', viewerName: '佐藤' });
      s = submit(setMode(s, 'ai'), { text: 'q', messageId: 'm_1' }).state;
      s = failAnswer(s, { questionId: 'm_1', error: r.error.code, retryable: r.error.retryable, keepDraft: 'q' }).state;
      expect(questionStatus(s, 'm_1').retryable).toBe(false);
      expect(retry(s, 'm_1').skipped).toBe('not_retryable');
      expect(s.messages.length).toBe(1);               // 質問は残る
      expect(s.draft).toBe('q');                        // 下書きも残る
    });
  }
  it('一時的な失敗（rate_limited / upstream_failed）は再試行できる', async () => {
    for (const code of ['rate_limited', 'upstream_failed']) {
      const srv = createRefServer({ failWith: code });
      const r = await ask(createLiveAdapter({ fetch: srv.fetch }));
      expect(r.error).toMatchObject({ code, retryable: true });
      let s = createSession({ roomId: 'store_A', viewerId: 's1' });
      s = submit(setMode(s, 'ai'), { text: 'q', messageId: 'm_1' }).state;
      s = failAnswer(s, { questionId: 'm_1', error: code, retryable: true }).state;
      expect(retry(s, 'm_1').aiRequest.questionId).toBe('m_1');
    }
  });
});

describe('契約: 回答先ルームと無限返信の防止', () => {
  it('サーバーは質問と同じ room_id を返し、クライアントもその前提で描く', async () => {
    const srv = createRefServer();
    const r = await ask(createLiveAdapter({ fetch: srv.fetch }));
    expect(r.roomId).toBe('store_A');
    let s = createSession({ roomId: 'store_A', viewerId: 's1' });
    s = submit(setMode(s, 'ai'), { text: 'q', messageId: 'm_1' }).state;
    s = applyAnswer(s, { questionId: 'm_1', raw: r.body, answerMessageId: r.answerMessageId }).state;
    expect(s.messages.find(m => m.fromStaffId === '__ai__').roomId).toBe('store_A');
  });
  it('AI の回答を質問として再起動できない（無限返信の防止）', async () => {
    const srv = createRefServer();
    const r = await ask(createLiveAdapter({ fetch: srv.fetch }));
    let s = createSession({ roomId: 'store_A', viewerId: 's1' });
    s = submit(setMode(s, 'ai'), { text: 'q', messageId: 'm_1' }).state;
    s = applyAnswer(s, { questionId: 'm_1', raw: r.body, answerMessageId: r.answerMessageId }).state;
    const aiId = s.messages.find(m => m.fromStaffId === '__ai__').id;
    expect(applyAnswer(s, { questionId: aiId, raw: 'again' }).skipped).toBe('ai_message');
  });
});

describe('契約: 出典の扱い', () => {
  it('server_verified のときだけ「検証済みの出典」として表示する', async () => {
    const srv = createRefServer();
    const r = await ask(createLiveAdapter({ fetch: srv.fetch }));
    const info = resolveSources(r, ctx());
    expect(info.verification).toBe('server_verified');
    expect(info.verified[0]).toMatchObject({ docId: 'faq_family', version: '1.2', locator: '§3' });
    expect(info.label).toBe('出典を確認済み（実在・版・参照箇所）');
    // 「確認済み」は出典の実在・版・参照箇所の確認であって、回答の正解保証ではない
    expect(info.note).toMatch(/正しさを保証するものではありません/);
    expect(info.label).not.toMatch(/正解|承認/);
  });
  it('未検証で返ってきたら「参照候補として渡した資料」として表示する', async () => {
    const srv = createRefServer({ unverified: true });
    const r = await ask(createLiveAdapter({ fetch: srv.fetch }));
    const info = resolveSources(r, ctx());
    expect(info.verification).toBe('unverified');
    expect(info.verified).toEqual([]);
    expect(info.label).toBe('参照候補として渡した資料（未検証）');
  });
  it('クライアントが渡した候補をサーバーの検証結果に格上げしない', async () => {
    const srv = createRefServer({ unverified: true });
    const r = await ask(createLiveAdapter({ fetch: srv.fetch }));
    const info = resolveSources(r, ctx());   // ctx には faq_family が入っているが…
    expect(info.verified).toEqual([]);        // …検証済みにはならない
  });
});

describe('契約: 本部確認・訂正', () => {
  const setup = async () => {
    const srv = createRefServer();
    const r = await ask(createLiveAdapter({ fetch: srv.fetch }));
    let s = createSession({ roomId: 'store_A', viewerId: 's1', viewerName: '佐藤' });
    s = submit(setMode(s, 'ai'), { text: 'q', messageId: 'm_1' }).state;
    s = applyAnswer(s, { questionId: 'm_1', raw: r.body, sourceInfo: resolveSources(r, ctx()), answerMessageId: r.answerMessageId }).state;
    return { s, answerId: r.answerMessageId, hq: r.hqReview };
  };
  it('通知が未接続なら「通知済み」と表示しない', async () => {
    const { s, hq } = await setup();
    expect(hq).toMatchObject({ status: 'none', notified: false, channel: 'not_connected' });
    const r = requestHqReview(s, { questionId: 'm_1', by: 's1' });
    expect(r.request.notified).toBe(false);
    expect(r.request.notifyChannel).toBe('not_connected');
  });
  it('本部確認は何度押しても1件', async () => {
    const { s } = await setup();
    const a = requestHqReview(s, { questionId: 'm_1' });
    const b = requestHqReview(a.state, { questionId: 'm_1' });
    expect(b.created).toBe(false);
    expect(Object.keys(b.state.hqRequests).length).toBe(1);
  });
  it('訂正は追記履歴で、Knowledge へ自動反映しない', async () => {
    const { s, answerId } = await setup();
    const c1 = applyCorrection(s, { answerId, text: '訂正1', by: 'hq1', role: 'hq' });
    const c2 = applyCorrection(c1.state, { answerId, text: '訂正2', by: 'hq1', role: 'hq' });
    expect(c2.state.corrections[answerId].map(x => x.text)).toEqual(['訂正1', '訂正2']);
    expect(c2.state.messages.find(m => m.id === answerId).text).toMatch(/2親等以内が対象/);  // 元回答は残る
    expect(c2.state.knowledgeCandidates.every(k => k.status === 'candidate')).toBe(true);
  });
});
