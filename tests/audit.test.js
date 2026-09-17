import { describe, it, expect } from 'vitest';
import { buildEntry, redact, isSecretKey, listEntries } from '../lib/audit.js';

const T0 = 1_760_000_000_000;

describe('audit - 秘密の伏字', () => {
  it('秘密らしいキー名を判定する', () => {
    for (const k of ['password', 'PASSWORD', 'api_key', 'apiKey', 'Authorization', 'accessToken', 'client-secret', 'privateKey']) {
      expect(isSecretKey(k)).toBe(true);
    }
    for (const k of ['shop', 'dailyBudget', 'name', 'keyword']) {
      expect(isSecretKey(k)).toBe(false);
    }
  });
  it('値を [REDACTED] に置き換える', () => {
    const r = redact({ shop: '恵比寿院', password: 'p@ss', nested: { apiKey: 'sk-123', ok: 1 } });
    expect(r.shop).toBe('恵比寿院');
    expect(r.password).toBe('[REDACTED]');
    expect(r.nested.apiKey).toBe('[REDACTED]');
    expect(r.nested.ok).toBe(1);
  });
  it('長い文字列・深い構造・巨大配列を切り詰める', () => {
    expect(redact('a'.repeat(500)).length).toBe(401);
    expect(redact({ a: { b: { c: { d: { e: { f: 1 } } } } } }).a.b.c.d.e).toBe('…');
    expect(redact(new Array(100).fill(1))).toHaveLength(50);
  });
  it('null / undefined を壊さない', () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeNull();
  });
});

describe('audit - エントリ', () => {
  it('action と entity は必須', () => {
    expect(buildEntry({ entity: 'approval' }, T0).error).toBe('action_and_entity_required');
    expect(buildEntry({ action: 'update' }, T0).error).toBe('action_and_entity_required');
  });
  it('実行者・前後の値・出所が残る', () => {
    const { ok, entry } = buildEntry({
      action: 'flag_change', entity: 'ccflags', entityId: 'cc_approval',
      actor: { id: 'u1', name: '若林', role: 'root' }, source: 'ui',
      before: { cc_approval: false }, after: { cc_approval: true },
    }, T0);
    expect(ok).toBe(true);
    expect(entry.ts).toBe(T0);
    expect(entry.actorName).toBe('若林');
    expect(entry.actorRole).toBe('root');
    expect(entry.source).toBe('ui');
    expect(entry.before).toEqual({ cc_approval: false });
    expect(entry.after).toEqual({ cc_approval: true });
    expect(entry.id).toMatch(/^au_/);
  });
  it('保存時点で秘密を伏せる', () => {
    const { entry } = buildEntry({
      action: 'update', entity: 'settings',
      after: { SQUARE_TOKENS: 'sq_live_xxx', shop: '恵比寿院' },
    }, T0);
    expect(entry.after.SQUARE_TOKENS).toBe('[REDACTED]');
    expect(entry.after.shop).toBe('恵比寿院');
  });
});

describe('audit - 一覧', () => {
  const rows = [
    buildEntry({ action: 'approve', entity: 'approval', entityId: 'ap_1', actor: { id: 'u1' } }, T0 + 3).entry,
    buildEntry({ action: 'update', entity: 'ccflags', entityId: 'cc_approval', actor: { id: 'u2' } }, T0 + 2).entry,
    buildEntry({ action: 'reject', entity: 'approval', entityId: 'ap_2', actor: { id: 'u1' } }, T0 + 1).entry,
  ];
  it('新しい順', () => {
    expect(listEntries(rows, {})[0].ts).toBe(T0 + 3);
  });
  it('entity / entityId / actorId / action で絞れる', () => {
    expect(listEntries(rows, { entity: 'approval' })).toHaveLength(2);
    expect(listEntries(rows, { entityId: 'ap_1' })).toHaveLength(1);
    expect(listEntries(rows, { actorId: 'u1' })).toHaveLength(2);
    expect(listEntries(rows, { action: 'update' })).toHaveLength(1);
  });
  it('since で期間を絞れる', () => {
    expect(listEntries(rows, { since: T0 + 2 })).toHaveLength(2);
  });
});
