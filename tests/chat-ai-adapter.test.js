import { describe, it, expect } from 'vitest';
import { buildContext, createMockAdapter, createApiAdapter, adapterBadge, DOC_VISIBILITY } from '../lib/chat-ai-adapter.js';
import { parseAiReply, buildAiAnswerMessage } from '../lib/chat-ai-ux.js';

const DOCS = [
  { id: 'f1', kind: 'faq', title: '家族施術制度', version: '1.2', updatedAt: '2026-09-12T00:00:00Z', visibility: 'company', keywords: ['家族施術'], answer: '2親等まで対象です。' },
  { id: 'f2', kind: 'faq', title: 'A院の掃除当番', visibility: 'shop', shopId: 'A', roomId: 'store_A', keywords: ['掃除'], answer: '当番表のとおりです。' },
  { id: 'd1', kind: 'knowledge', title: '他店の議事録', visibility: 'shop', shopId: 'B', keywords: ['議事録'], body: '他店の内容' },
  { id: 'r9', kind: 'knowledge', title: '別ルーム限定メモ', visibility: 'room', roomId: 'store_B', keywords: ['メモ'], body: '別ルーム' },
  { id: 'p1', kind: 'knowledge', title: '人事評価シート', visibility: 'company', personnel: true, keywords: ['評価'], body: '人事情報' },
  { id: 'x1', kind: 'knowledge', title: '個人相談ログ', visibility: 'company', private: true, keywords: ['相談'], body: 'Private AI Chat' },
  { id: 'n1', kind: 'knowledge', title: '区分不明の資料', keywords: ['不明'], body: 'visibility 未設定' },
];

describe('chat-ai-adapter: 参照してよい範囲（§6）', () => {
  const ctx = buildContext({ roomId: 'store_A', shopId: 'A', docs: DOCS, history: [] });
  it('全社・当該店舗・当該ルームの資料だけを渡す', () => {
    expect(ctx.docs.map(d => d.id)).toEqual(['f1', 'f2']);
    expect(DOC_VISIBILITY).toEqual(['room', 'shop', 'company']);
  });
  it('他店舗・他ルーム・人事情報・Private AI Chat・区分不明は除外し、理由を残す', () => {
    expect(ctx.rejected).toEqual([
      { id: 'd1', title: '他店の議事録', reason: 'other_shop' },
      { id: 'r9', title: '別ルーム限定メモ', reason: 'other_room' },
      { id: 'p1', title: '人事評価シート', reason: 'personnel' },
      { id: 'x1', title: '個人相談ログ', reason: 'private' },
      { id: 'n1', title: '区分不明の資料', reason: 'unknown_visibility' },
    ]);
  });
  it('履歴は同じルームの分だけ（DM・他ルームは混ぜない）', () => {
    const history = [
      { roomId: 'store_A', fromStaffId: 's1', text: 'このルームの発言' },
      { roomId: 'dm_1', fromStaffId: 's2', text: '他人のDM' },
      { roomId: 'store_B', fromStaffId: 's3', text: '他店の発言' },
      { roomId: 'store_A', fromStaffId: '__ai__', text: 'AIの回答' },
    ];
    const c = buildContext({ roomId: 'store_A', shopId: 'A', docs: [], history });
    expect(c.history).toEqual([
      { role: 'user', content: 'このルームの発言' },
      { role: 'assistant', content: 'AIの回答' },
    ]);
  });
  it('dataContext には資料の題名と版が入る', () => {
    expect(ctx.dataContext).toMatch(/【家族施術制度 v1.2】/);
    expect(ctx.dataContext).not.toMatch(/人事情報/);
  });
});

describe('chat-ai-adapter: mock（サンプル回答）', () => {
  const adapter = createMockAdapter();
  const ctx = buildContext({ roomId: 'store_A', shopId: 'A', docs: DOCS });

  it('資料に当たれば回答と出典（版・更新日）を返す', async () => {
    const r = await adapter.ask({ question: '家族施術のルールは？', context: ctx });
    expect(r.ok).toBe(true);
    expect(r.sample).toBe(true);
    expect(r.message).toBe('2親等まで対象です。');
    expect(r.sources).toEqual([{ kind: 'faq', id: 'f1', title: '家族施術制度', version: '1.2', updatedAt: '2026-09-12T00:00:00Z' }]);
  });
  it('資料が無ければ答えを作らず、根拠不足として返す', async () => {
    const r = await adapter.ask({ question: '来期の役員人事は？', context: ctx });
    expect(r.sources).toEqual([]);
    expect(parseAiReply(r.message).needsHq).toBe(true);
    // 出典ゼロ＝必ずエスカレ表示になる
    const msg = buildAiAnswerMessage({ raw: r.message, question: '来期の役員人事は？', sources: r.sources, confidence: 0.9 });
    expect(msg.ai.escalated).toBe(true);
    expect(msg.ai.escalateReasons).toContain('no_source');
  });
  it('mock であることが必ず分かる', () => {
    expect(adapterBadge(adapter).label).toBe('サンプル回答（mock）');
    expect(adapterBadge(adapter).note).toMatch(/正式な回答ではありません/);
  });
  it('失敗も再現できる（失敗時の画面確認用）', async () => {
    const failing = createMockAdapter({ failOn: 'こわす' });
    expect((await failing.ask({ question: 'こわす', context: ctx })).ok).toBe(false);
  });
});

describe('chat-ai-adapter: 既存 API の再利用（新しいエンドポイントを作らない）', () => {
  it('POST /api/chat に agent:faq / question / history / dataContext を送る', async () => {
    let seen = null;
    const adapter = createApiAdapter({
      fetch: async (url, opts) => { seen = { url, body: JSON.parse(opts.body) }; return { json: async () => ({ message: '回答です' }) }; },
    });
    const ctx = buildContext({ roomId: 'store_A', shopId: 'A', docs: [DOCS[0]], history: [] });
    const r = await adapter.ask({ question: '家族施術は？', context: ctx });
    expect(seen.url).toBe('/api/chat');
    expect(seen.body.agent).toBe('faq');
    expect(seen.body.question).toBe('家族施術は？');
    expect(seen.body.dataContext).toMatch(/家族施術制度/);
    expect(r.ok).toBe(true);
    expect(r.sample).toBe(false);
    // 出典は渡した資料からのみ（モデルの自己申告では作らない）
    expect(r.sources.map(s => s.id)).toEqual(['f1']);
  });
  it('空応答・通信エラーは失敗として返す（画面は下書きを保持する）', async () => {
    const empty = createApiAdapter({ fetch: async () => ({ json: async () => ({}) }) });
    expect((await empty.ask({ question: 'q' })).error).toBe('empty_response');
    const boom = createApiAdapter({ fetch: async () => { throw new Error('network'); } });
    expect((await boom.ask({ question: 'q' })).error).toBe('network');
  });
  it('実接続であることが分かる表示になる', () => {
    expect(adapterBadge(createApiAdapter({ fetch: async () => ({}) })).label).toBe('実AI接続');
  });
});
