import { describe, it, expect } from 'vitest';
import { buildChatAudit, buildBlockedAudit, filterAudit, BODY_PREVIEW_LEN } from '../lib/chat-audit.js';

const ACTOR = { id: 'u1', name: '若林', role: 'admin', source: 'ui', tenantId: 'naoru' };
const AI = { id: 'a_chat', name: 'AIアシスタント', role: 'root', source: 'agent' };
const RES = {
  action: 'chat.broadcast',
  shops: [{ id: 'sh1', name: '恵比寿' }, { id: 'sh2', name: '渋谷' }],
  staffIds: ['st1', 'st2'],
  recipientCount: 2,
  excludedShops: [{ id: 'sh3', name: '梅田' }],
  ambiguities: [], outOfScope: [],
};

describe('buildChatAudit - 誰が誰の代わりにどこへ送ったか', () => {
  it('必要な項目がすべて入る', () => {
    const { ok, entry } = buildChatAudit({ actor: ACTOR, resolution: RES, roomId: 'r1', roomKind: 'store', body: 'おつかれさまです' });
    expect(ok).toBe(true);
    expect(entry.actorId).toBe('u1');
    expect(entry.actorRole).toBe('admin');
    expect(entry.source).toBe('ui');
    expect(entry.tenantId).toBe('naoru');
    expect(entry.action).toBe('chat.broadcast');
    expect(entry.shopIds).toEqual(['sh1', 'sh2']);
    expect(entry.staffIds).toEqual(['st1', 'st2']);
    expect(entry.recipientCount).toBe(2);
    expect(entry.excludedShopIds).toEqual(['sh3']);
  });
  it('AI代行は「誰の権限で送ったか」も残る', () => {
    const { entry } = buildChatAudit({ actor: AI, onBehalfOf: ACTOR, resolution: RES, body: 'x', channel: 'ai' });
    expect(entry.source).toBe('agent');
    expect(entry.onBehalfOfId).toBe('u1');
    expect(entry.onBehalfOfName).toBe('若林');
    expect(entry.channel).toBe('ai');
  });
  it('曖昧だった宛先を誰が確定させたかが残る', () => {
    const { entry } = buildChatAudit({ actor: ACTOR, resolution: { ...RES, ambiguities: [{ query: '田中' }] }, confirmedBy: 'u1', body: 'x' });
    expect(entry.hadAmbiguity).toBe(true);
    expect(entry.confirmedBy).toBe('u1');
  });
  it('本文は冒頭だけ残す（全文は messages 本体にある）', () => {
    const long = 'あ'.repeat(500);
    const { entry } = buildChatAudit({ actor: ACTOR, resolution: RES, body: long });
    expect(entry.bodyPreview).toHaveLength(BODY_PREVIEW_LEN);
    expect(entry.bodyLength).toBe(500);
  });
  it('トークン・パスワードは記録しない', () => {
    const { entry } = buildChatAudit({ actor: ACTOR, resolution: RES, body: 'x', meta: { token: 'secret-abc', apiKey: 'k-123', ok: 1 } });
    expect(JSON.stringify(entry)).not.toContain('secret-abc');
    expect(JSON.stringify(entry)).not.toContain('k-123');
    expect(entry.meta.ok).toBe(1);
  });
  it('入れ子の中のトークンも落とす', () => {
    const { entry } = buildChatAudit({ actor: ACTOR, resolution: RES, body: 'x', meta: { a: { b: { authorization: 'Bearer zzz' } } } });
    expect(JSON.stringify(entry)).not.toContain('zzz');
  });
  it('送信者が分からない記録は作らない', () => {
    expect(buildChatAudit({ resolution: RES, body: 'x' }).ok).toBe(false);
  });
  it('未知のチャネルは ui に倒す', () => {
    expect(buildChatAudit({ actor: ACTOR, resolution: RES, body: 'x', channel: 'なにか' }).entry.channel).toBe('ui');
  });
  it('予約送信・未読者再送もチャネルとして残せる', () => {
    expect(buildChatAudit({ actor: ACTOR, resolution: RES, body: 'x', channel: 'scheduled' }).entry.channel).toBe('scheduled');
    expect(buildChatAudit({ actor: ACTOR, resolution: RES, body: 'x', channel: 'resend_unread' }).entry.channel).toBe('resend_unread');
  });
  it('resolution が無くても落ちない', () => {
    expect(buildChatAudit({ actor: ACTOR, body: 'x' }).ok).toBe(true);
  });
});

describe('buildBlockedAudit - 送らなかったことも残す', () => {
  it('止めた理由と状態が残り、宛先数は0になる', () => {
    const { entry } = buildBlockedAudit({
      actor: AI, onBehalfOf: ACTOR, channel: 'ai',
      resolution: { ...RES, status: 'needs_confirmation', reason: '宛先が確定していません', ambiguities: [{ query: '田中' }] },
    });
    expect(entry.blocked).toBe(true);
    expect(entry.blockedStatus).toBe('needs_confirmation');
    expect(entry.blockedReason).toContain('確定');
    expect(entry.recipientCount).toBe(0);
  });
  it('権限で弾いた場合はコードが残る', () => {
    const { entry } = buildBlockedAudit({ actor: ACTOR, resolution: { status: 'denied', code: 'role_too_low', reason: '権限不足' } });
    expect(entry.blockedCode).toBe('role_too_low');
  });
  it('本文は残さない', () => {
    const { entry } = buildBlockedAudit({ actor: ACTOR, body: '秘密の本文', resolution: { status: 'denied' } });
    expect(entry.bodyPreview).toBe('');
  });
});

describe('filterAudit - 監査画面の絞り込み', () => {
  const rows = [
    { at: '2026-09-01T00:00:00Z', tenantId: 'naoru', actorId: 'u1', channel: 'ui', source: 'ui', shopIds: ['sh1'] },
    { at: '2026-09-05T00:00:00Z', tenantId: 'naoru', actorId: 'u2', channel: 'ai', source: 'agent', shopIds: ['sh2'], blocked: true },
    { at: '2026-09-06T00:00:00Z', tenantId: 'clientx', actorId: 'u3', channel: 'ui', source: 'ui', shopIds: ['sh1'] },
  ];
  it('テナントを跨いで見えない', () => {
    expect(filterAudit(rows, { tenantId: 'naoru' })).toHaveLength(2);
    expect(filterAudit(rows, { tenantId: 'clientx' })).toHaveLength(1);
  });
  it('AIの操作だけを取り出せる', () => {
    expect(filterAudit(rows, { source: 'agent' }).map(r => r.actorId)).toEqual(['u2']);
  });
  it('止まった送信だけを取り出せる', () => {
    expect(filterAudit(rows, { blocked: true })).toHaveLength(1);
    expect(filterAudit(rows, { blocked: false })).toHaveLength(2);
  });
  it('店舗・期間で絞れる', () => {
    expect(filterAudit(rows, { shopId: 'sh1' })).toHaveLength(2);
    expect(filterAudit(rows, { since: '2026-09-05T00:00:00Z' })).toHaveLength(2);
  });
  it('壊れた行は落とす', () => {
    expect(filterAudit([null, 'x', { at: '2026-09-01T00:00:00Z' }])).toHaveLength(1);
  });
});
