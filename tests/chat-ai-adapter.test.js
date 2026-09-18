import { describe, it, expect } from 'vitest';
import {
  buildContext, createMockAdapter, createLegacyApiAdapter, createLiveAdapter,
  adapterBadge, resolveSources, DOC_VISIBILITY,
} from '../lib/chat-ai-adapter.js';
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

  it('資料に当たれば回答を返すが、出典は「候補（未検証）」にとどめる', async () => {
    const r = await adapter.ask({ question: '家族施術のルールは？', context: ctx });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('sample');
    expect(r.body).toBe('2親等まで対象です。');
    expect(r.sources.verification).toBe('unverified');
    expect(r.sources.verified).toEqual([]);
    expect(r.sources.candidates[0]).toMatchObject({ doc_id: 'f1', title: '家族施術制度', version: '1.2' });
  });
  it('mock は決して server_verified を名乗らない', async () => {
    const r = await adapter.ask({ question: '家族施術のルールは？', context: ctx });
    const info = resolveSources(r, ctx);
    expect(info.verification).toBe('unverified');
    expect(info.label).toBe('参照候補として渡した資料（未検証）');
    expect(info.caution).toMatch(/正式な社内規程としての回答ではありません/);
    // 未検証なので断定しない（エスカレ扱い）
    const msg = buildAiAnswerMessage({ raw: r.body, question: 'q', sourceInfo: info, confidence: 0.9 });
    expect(msg.ai.escalated).toBe(true);
  });
  it('資料が無ければ答えを作らず、根拠不足として返す', async () => {
    const r = await adapter.ask({ question: '来期の役員人事は？', context: ctx });
    expect(r.sources.verification).toBe('none');
    expect(parseAiReply(r.body).needsHq).toBe(true);
    const info = resolveSources(r, { candidates: [] });
    expect(info.label).toBe('根拠なし');
    const msg = buildAiAnswerMessage({ raw: r.body, question: '来期の役員人事は？', sourceInfo: info, confidence: 0.9 });
    expect(msg.ai.escalated).toBe(true);
    expect(msg.ai.escalateReasons).toContain('no_source');
  });
  it('mock であることが必ず分かる', () => {
    expect(adapterBadge(adapter).label).toBe('サンプル回答（mock）');
    expect(adapterBadge(adapter).note).toMatch(/正式な回答ではありません/);
  });
  it('失敗も再現できる（失敗時の画面確認用）', async () => {
    const failing = createMockAdapter({ failOn: 'こわす' });
    const r = await failing.ask({ question: 'こわす', context: ctx });
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'upstream_failed', retryable: true });
  });
});

describe('chat-ai-adapter: 既存 API の暫定利用（新しいエンドポイントを作らない）', () => {
  const ctx = buildContext({ roomId: 'store_A', shopId: 'A', docs: [DOCS[0]], history: [] });
  it('POST /api/chat に agent:faq / question / history / dataContext を送る', async () => {
    let seen = null;
    const adapter = createLegacyApiAdapter({
      fetch: async (url, opts) => { seen = { url, body: JSON.parse(opts.body) }; return { json: async () => ({ message: '回答です' }) }; },
    });
    const r = await adapter.ask({ question: '家族施術は？', roomId: 'store_A', context: ctx });
    expect(seen.url).toBe('/api/chat');
    expect(seen.body.agent).toBe('faq');
    expect(seen.body.dataContext).toMatch(/家族施術制度/);
    expect(r.ok).toBe(true);
    // ⚠️ クライアントが渡した資料は検証済みにしない
    expect(r.sources.verification).toBe('unverified');
    expect(r.sources.verified).toEqual([]);
    expect(r.sources.candidates.map(s => s.id)).toEqual(['f1']);
  });
  it('room_id が無いまま問い合わせない', async () => {
    const adapter = createLegacyApiAdapter({ fetch: async () => ({ json: async () => ({ message: 'x' }) }) });
    expect((await adapter.ask({ question: 'q' })).error).toMatchObject({ code: 'invalid_request', retryable: false });
  });
  it('空応答・通信エラーは失敗として返す（画面は下書きを保持する）', async () => {
    const empty = createLegacyApiAdapter({ fetch: async () => ({ json: async () => ({}) }) });
    expect((await empty.ask({ question: 'q', roomId: 'store_A' })).error).toMatchObject({ code: 'upstream_failed', retryable: true });
    const boom = createLegacyApiAdapter({ fetch: async () => { throw new Error('network'); } });
    expect((await boom.ask({ question: 'q', roomId: 'store_A' })).error.message).toBe('network');
  });
  it('接続の種類が画面で分かる', () => {
    expect(adapterBadge(createLegacyApiAdapter({ fetch: async () => ({}) })).label).toBe('暫定接続（既存 /api/chat）');
    expect(adapterBadge(createLiveAdapter({ fetch: async () => ({}) })).label).toBe('実接続（①の共通基盤）');
    expect(adapterBadge(createMockAdapter()).label).toBe('サンプル回答（mock）');
  });
});

describe('chat-ai-adapter: 不足ID・スコープ（制約が消えないこと）', () => {
  const docs = [
    { id: 'room1', title: 'ルーム限定', visibility: 'room', roomId: 'store_A', keywords: ['x'] },
    { id: 'shop1', title: '店舗限定', visibility: 'shop', shopId: 'A', keywords: ['x'] },
    { id: 'shopNoId', title: '店舗限定だが店舗不明', visibility: 'shop', keywords: ['x'] },
    { id: 'all1', title: '全社', visibility: 'company', keywords: ['x'] },
  ];
  it('roomId が無ければ room 限定資料も履歴も渡さない（全社扱いにしない）', () => {
    const c = buildContext({ shopId: 'A', docs, history: [{ roomId: 'store_A', text: 'x' }] });
    expect(c.docs.map(d => d.id)).toEqual(['shop1', 'all1']);
    expect(c.rejected.find(r => r.id === 'room1').reason).toBe('room_unknown');
    expect(c.history).toEqual([]);
  });
  it('shopId が不明なら shop 限定資料を渡さない', () => {
    const c = buildContext({ roomId: 'store_A', docs });
    expect(c.docs.map(d => d.id)).toEqual(['room1', 'all1']);
    expect(c.rejected.find(r => r.id === 'shop1').reason).toBe('shop_unknown');
  });
  it('資料側の shopId が無い shop 限定資料も渡さない', () => {
    const c = buildContext({ roomId: 'store_A', shopId: 'A', docs });
    expect(c.docs.map(d => d.id)).toEqual(['room1', 'shop1', 'all1']);
    expect(c.rejected.find(r => r.id === 'shopNoId').reason).toBe('doc_shop_unknown');
  });
  it('tenant が違う / 片方だけ不明な資料は渡さない', () => {
    const t = [{ id: 'o', title: '他テナント', visibility: 'company', tenantId: 'other', keywords: ['x'] },
               { id: 'u', title: 'テナント不明の照合', visibility: 'company', tenantId: 'naoru', keywords: ['x'] }];
    expect(buildContext({ roomId: 'r', tenantId: 'naoru', docs: t }).rejected.map(r => r.reason)).toEqual(['other_tenant']);
    expect(buildContext({ roomId: 'r', docs: t }).rejected.map(r => r.reason)).toEqual(['tenant_unknown', 'tenant_unknown']);
  });
  it('候補は「渡した資料」であって出典ではない（hint は ID のみ）', () => {
    const c = buildContext({ roomId: 'store_A', shopId: 'A', docs });
    expect(c.candidates.every(x => x.reason === 'passed_to_model')).toBe(true);
    expect(c.hint).toEqual({ doc_ids: ['room1', 'shop1', 'all1'] });
    expect(JSON.stringify(c.hint)).not.toMatch(/全社|ルーム限定/);   // 本文・題名を送らない
  });
});

describe('chat-ai-adapter: resolveSources（出典表示の判定）', () => {
  it('サーバーが検証した出典だけを「検証済み」にする', () => {
    const info = resolveSources({ sources: { verification: 'server_verified', verified: [{ doc_id: 'f1', title: 'T', version: '1.0', locator: '§1' }], candidates: [] } });
    expect(info.verification).toBe('server_verified');
    expect(info.label).toBe('検証済みの出典');
    expect(info.verified[0]).toMatchObject({ docId: 'f1', version: '1.0', locator: '§1' });
    expect(info.caution).toBe('');
  });
  it('候補しか無ければ未検証（件数で正しさを保証しない）', () => {
    const info = resolveSources({ sources: { verification: 'unverified', verified: [], candidates: [{ doc_id: 'a' }, { doc_id: 'b' }, { doc_id: 'c' }] } });
    expect(info.verification).toBe('unverified');
    expect(info.label).toBe('参照候補として渡した資料（未検証）');
  });
  it('verification が無い応答は未検証として扱う（安全側）', () => {
    expect(resolveSources({ sources: { candidates: [{ doc_id: 'a' }] } }).verification).toBe('unverified');
    expect(resolveSources({}, { candidates: [{ id: 'a', title: 'A' }] }).verification).toBe('unverified');
    expect(resolveSources({}, {}).verification).toBe('none');
  });
  it('verified が空なのに server_verified を名乗る応答は昇格させない', () => {
    expect(resolveSources({ sources: { verification: 'server_verified', verified: [], candidates: [{ doc_id: 'a' }] } }).verification).toBe('unverified');
    expect(resolveSources({ sources: { verification: 'server_verified', verified: [], candidates: [] } }).verification).toBe('none');
  });
});
