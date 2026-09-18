import { describe, it, expect } from 'vitest';
import {
  MANAGED_FIELDS, normalizeManaged, stripManaged, carryManaged,
  isAutoMember, canAutoRemove, reconcileAutoMembers, applyMemberChange,
} from '../lib/chat-room-fields.js';
import { ensureBaseRooms } from '../lib/chat.js';

describe('管理フィールドはクライアントから書けない', () => {
  it('🔴 入力から storeId / eventId / status / autoMembers を取り除く', () => {
    const r = stripManaged({ name: 'x', storeId: '9', eventId: 'e', status: 'archived', autoMembers: ['spy'] });
    expect(r.name).toBe('x');
    for (const k of MANAGED_FIELDS) expect(r, k).not.toHaveProperty(k);
  });
  it('🔴 autoMembers を送りつけて自動所属を偽装できない', () => {
    const merged = carryManaged(null, { id: 'g1', members: ['me'], autoMembers: ['me'] });
    expect(merged.autoMembers).toBeUndefined();
    expect(isAutoMember(merged, 'me')).toBe(false);
  });
  it('元のオブジェクトを壊さない', () => {
    const src = { name: 'x', storeId: '9' };
    stripManaged(src);
    expect(src.storeId).toBe('9');
  });
});

describe('既存Roomの付加フィールドが消えない（回帰）', () => {
  const prev = { id: 'store_A', kind: 'store', name: 'A院', members: ['s1'], storeId: '11', eventId: '', status: 'active', autoMembers: ['s1'] };

  it('🔴 createRoom 相当の作り直しでも引き継がれる', () => {
    const rebuilt = { id: 'store_A', kind: 'store', name: 'A院（改名）', members: ['s1', 's2'] };
    const merged = carryManaged(prev, rebuilt);
    expect(merged.storeId).toBe('11');
    expect(merged.status).toBe('active');
    expect(merged.autoMembers).toEqual(['s1']);
    expect(merged.name).toBe('A院（改名）');    // 名前の更新は通る
  });
  it('🔴 クライアントが別の storeId を送っても、既存の値が勝つ', () => {
    const merged = carryManaged(prev, { id: 'store_A', storeId: '99', autoMembers: ['attacker'] });
    expect(merged.storeId).toBe('11');
    expect(merged.autoMembers).toEqual(['s1']);
  });
  it('新規Room（既存なし）では付加フィールドが付かない', () => {
    const merged = carryManaged(null, { id: 'g1', name: 'x' });
    for (const k of MANAGED_FIELDS) expect(merged, k).not.toHaveProperty(k);
  });
  it('setMembers 相当でも消えない', () => {
    const next = applyMemberChange(prev, ['s1', 's2'], { by: 'human' });
    expect(next.storeId).toBe('11');
    expect(next.status).toBe('active');
  });
  it('🔴 ensureRooms は既存Roomを作り直さない（付加フィールドが残る）', () => {
    const out = ensureBaseRooms([prev], [{ name: 'A院' }, { name: 'B院' }]);
    const kept = out.find(r => r.id === 'store_A');
    expect(kept.storeId).toBe('11');
    expect(kept.autoMembers).toEqual(['s1']);
    expect(out.some(r => r.name === 'B院')).toBe(true);   // 新規は追加される
  });
});

describe('normalizeManaged - 未設定と空を区別する', () => {
  it('🔴 値が無ければキーを作らない（旧Roomと区別できなくなるため）', () => {
    expect(normalizeManaged({})).toEqual({});
    expect(normalizeManaged({ storeId: '', eventId: null })).toEqual({});
  });
  it('autoMembers は空配列でも「設定済み」として残す', () => {
    expect(normalizeManaged({ autoMembers: [] })).toEqual({ autoMembers: [] });
  });
  it('重複と空要素を除く', () => {
    expect(normalizeManaged({ autoMembers: ['a', 'a', '', null, 'b'] }).autoMembers).toEqual(['a', 'b']);
  });
});

describe('isAutoMember - 旧Roomを自動所属と推定しない（最重要）', () => {
  it('🔴 autoMembers が無いRoomは、メンバー全員を自動所属と推定しない', () => {
    const legacy = { id: 'g1', members: ['a', 'b', 'c'] };
    for (const id of ['a', 'b', 'c']) expect(isAutoMember(legacy, id), id).toBe(false);
  });
  it('🔴 追加理由が分からない人は自動削除の対象にしない', () => {
    const legacy = { id: 'g1', members: ['a'] };
    expect(canAutoRemove(legacy, 'a')).toBe(false);
  });
  it('autoMembers にいる人だけ自動所属', () => {
    const room = { id: 'g1', members: ['a', 'b'], autoMembers: ['a'] };
    expect(isAutoMember(room, 'a')).toBe(true);
    expect(isAutoMember(room, 'b')).toBe(false);
    expect(canAutoRemove(room, 'b')).toBe(false);
  });
});

describe('自動所属と手動追加が重なったとき', () => {
  const room = { id: 'g1', members: ['a', 'b'], autoMembers: ['a', 'b'] };

  it('🔴 人が新しく入れた人は手動へ昇格し、以後は自動削除されない', () => {
    const next = applyMemberChange(room, ['a', 'b', 'c'], { by: 'human' });
    expect(next.autoMembers).toEqual(['a', 'b']);       // c は自動所属にならない
    expect(canAutoRemove(next, 'c')).toBe(false);
  });
  it('🔴 自動所属の人を人が入れ直したら手動になる（同期が取り消せない）', () => {
    const removed = applyMemberChange(room, ['a'], { by: 'sync' });      // 同期が b を外す
    expect(removed.autoMembers).toEqual(['a']);
    const readded = applyMemberChange(removed, ['a', 'b'], { by: 'human' });  // 人が b を戻す
    expect(readded.autoMembers).toEqual(['a']);          // b は手動
    expect(canAutoRemove(readded, 'b')).toBe(false);     // ← 次の同期で消えない
  });
  it('同期による追加は自動所属のまま', () => {
    const next = applyMemberChange(room, ['a', 'b', 'c'], { by: 'sync' });
    expect(next.autoMembers).toEqual(['a', 'b']);        // c は同期側が別途記録する
  });
  it('メンバーから外れた人は記録からも消える', () => {
    const next = applyMemberChange(room, ['a'], { by: 'human' });
    expect(next.autoMembers).toEqual(['a']);
  });
  it('🔴 autoMembers が無いRoomでは作らない（勝手に自動所属を発生させない）', () => {
    const legacy = { id: 'g1', members: ['a'] };
    expect(reconcileAutoMembers(legacy, ['a', 'b'])).toBe(null);
    expect(applyMemberChange(legacy, ['a', 'b'])).not.toHaveProperty('autoMembers');
  });
});

describe('autoMembers は権限の正本ではない', () => {
  it('自動所属に入っていても、それ自体は閲覧・送信の許可を意味しない', () => {
    // autoMembers は「同期が追加した」という履歴。権限は authz が都度判定する。
    const room = { id: 'g1', members: ['a'], autoMembers: ['a'] };
    expect(isAutoMember(room, 'a')).toBe(true);
    // このモジュールは許可を返す関数を持たない（＝権限判定に使えない）
    expect(Object.keys({ isAutoMember, canAutoRemove })).not.toContain('canView');
  });
});

describe('壊れた入力', () => {
  it('null / 文字列でも落ちない', () => {
    expect(() => carryManaged(null, null)).not.toThrow();
    expect(() => applyMemberChange(null, null)).not.toThrow();
    expect(() => normalizeManaged('x')).not.toThrow();
    expect(isAutoMember(null, 'a')).toBe(false);
  });
  it('members が配列でなければ空にする', () => {
    expect(applyMemberChange({ id: 'g' }, 'not-an-array').members).toEqual([]);
  });
});
