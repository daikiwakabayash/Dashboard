import { describe, it, expect } from 'vitest';
import { makeActor, agentActor } from '../lib/actor.js';
import {
  isTenantAdmin, isScopedRole, resolvePermission,
  canAccessStore, canAccessStoreName, scopeStores, scopeStoreIds, staffInScope,
  DEFAULT_CHAT_ROLLOUT, normalizeRollout, chatRolloutAllows, featureEnabled,
  canManageRollout, isDevOpen, enforcementMode, killSwitchOn,
} from '../lib/authz.js';

const so = (role, storeIds = [], extra = {}) =>
  makeActor({ staff_id: extra.id || 'u1', role, accessible_store_ids: storeIds, store_names: extra.names || [], source: 'salonone', verified: true, ...extra });

describe('authz: ロール', () => {
  it('root / hq がテナント管理者', () => {
    expect(isTenantAdmin(so('root'))).toBe(true);
    expect(isTenantAdmin(so('hq'))).toBe(true);
    expect(isTenantAdmin(so('owner'))).toBe(false);
    expect(isScopedRole(so('manager'))).toBe(true);
  });
});

describe('authz: Permission Resolution（override → SalonOne → deny）', () => {
  it('未検証は常に deny', () => {
    const r = resolvePermission(makeActor({ role: 'root' }));
    expect(r.source).toBe('deny');
    expect(r.reason).toBe('unverified_identity');
  });
  it('SalonOne の権限をそのまま採用する（通常ユーザー）', () => {
    const r = resolvePermission(so('owner', ['A', 'B']));
    expect(r.source).toBe('salonone');
    expect(r.actor.accessible_store_ids).toEqual(['A', 'B']);
  });
  it('root / HQ は Dashboard Override が最優先', () => {
    const r = resolvePermission(so('hq', ['A']), { storeIds: ['A', 'B', 'C'] });
    expect(r.source).toBe('override');
    expect(r.actor.accessible_store_ids).toEqual(['A', 'B', 'C']);
  });
  it('通常ユーザーに Override は効かない（二重管理しない）', () => {
    const r = resolvePermission(so('staff', ['A']), { storeIds: ['A', 'B', 'C'] });
    expect(r.source).toBe('salonone');
    expect(r.actor.accessible_store_ids).toEqual(['A']);
  });
  it('SalonOne でも Dashboard root でもない検証済み actor は deny', () => {
    const r = resolvePermission(makeActor({ role: 'staff', source: 'dashboard', verified: true }));
    expect(r.source).toBe('deny');
  });
});

describe('authz: 店舗スコープ（store_id が正）', () => {
  it('root / hq は全店', () => {
    expect(canAccessStore(so('root'), '999')).toBe(true);
    expect(canAccessStore(so('hq'), '999')).toBe(true);
  });
  it('複数店舗ユーザーは全部の店舗にアクセスできる', () => {
    const a = so('owner', ['store_A', 'store_B', 'store_C']);
    expect(canAccessStore(a, 'store_A')).toBe(true);
    expect(canAccessStore(a, 'store_B')).toBe(true);
    expect(canAccessStore(a, 'store_C')).toBe(true);
    expect(canAccessStore(a, 'store_D')).toBe(false);
  });
  it('1店舗のユーザーは1店舗だけ', () => {
    const a = so('staff', ['store_A']);
    expect(canAccessStore(a, 'store_A')).toBe(true);
    expect(canAccessStore(a, 'store_B')).toBe(false);
  });
  it('店舗名フォールバックは store_id が無いときだけ使う', () => {
    const a = so('staff', [], { names: ['渋谷'] });
    expect(canAccessStoreName(a, 'NAORU渋谷院')).toBe(true);
    expect(canAccessStoreName(a, 'NAORU新宿院')).toBe(false);
  });
  it('scopeStores / scopeStoreIds が絞り込む', () => {
    const a = so('manager', ['1', '3']);
    expect(scopeStores(a, [{ id: '1' }, { id: '2' }, { id: '3' }]).map(s => s.id)).toEqual(['1', '3']);
    expect(scopeStoreIds(a, ['1', '2', '3', '3'])).toEqual(['1', '3']);
  });
  it('staffInScope は store_id 優先・名簿に無い ID は拒否', () => {
    const a = so('manager', ['100'], { names: ['A院'] });
    expect(staffInScope(a, { id: 'x', shop_id: '100' })).toBe(true);
    expect(staffInScope(a, { id: 'x', shop_id: '200' })).toBe(false);
    expect(staffInScope(a, { id: 'x', shop: 'A院' })).toBe(true);
    expect(staffInScope(a, null)).toBe(false);
    expect(staffInScope(so('root'), null)).toBe(true);
  });
});

describe('authz: Chat Rollout（Feature Flag）', () => {
  it('既定は root / hq だけ ON', () => {
    expect(DEFAULT_CHAT_ROLLOUT.root).toBe(true);
    expect(DEFAULT_CHAT_ROLLOUT.hq).toBe(true);
    expect(DEFAULT_CHAT_ROLLOUT.owner).toBe(false);
    expect(DEFAULT_CHAT_ROLLOUT.manager).toBe(false);
    expect(DEFAULT_CHAT_ROLLOUT.staff).toBe(false);
  });
  it('未設定（KV が空）でも root/hq のみ許可される', () => {
    expect(chatRolloutAllows(so('root'), null)).toBe(true);
    expect(chatRolloutAllows(so('hq'), undefined)).toBe(true);
    expect(chatRolloutAllows(so('owner'), null)).toBe(false);
    expect(chatRolloutAllows(so('manager'), {})).toBe(false);
    expect(chatRolloutAllows(so('staff'), {})).toBe(false);
  });
  it('未検証 identity は role を詐称しても常に拒否', () => {
    const fake = makeActor({ role: 'root', staff_id: 'x' });   // verified:false
    expect(chatRolloutAllows(fake, { root: true })).toBe(false);
  });
  it('KV で owner を ON にすれば公開できる（再デプロイ不要）', () => {
    expect(chatRolloutAllows(so('owner'), { owner: true })).toBe(true);
  });
  it('AI Agent は代理元のロールで判定される', () => {
    expect(chatRolloutAllows(agentActor(so('root')), null)).toBe(true);
    expect(chatRolloutAllows(agentActor(so('staff')), null)).toBe(false);
  });
  it('normalizeRollout は未知キーを落とし既定で埋める', () => {
    const r = normalizeRollout({ owner: true, evil: true, features: { schedule: true, nope: true } });
    expect(r.owner).toBe(true);
    expect(r.root).toBe(true);
    expect(r.evil).toBeUndefined();
    expect(r.features.schedule).toBe(true);
    expect(r.features.nope).toBeUndefined();
    expect(r.features.aiMention).toBe(false);
  });
  it('機能フラグは既定すべて OFF', () => {
    expect(featureEnabled(null, 'aiMention')).toBe(false);
    expect(featureEnabled({ features: { aiMention: true } }, 'aiMention')).toBe(true);
    expect(featureEnabled({ features: { aiMention: true } }, 'schedule')).toBe(false);
  });
  it('Rollout を変更できるのは検証済みの root / hq のみ', () => {
    expect(canManageRollout(so('root'))).toBe(true);
    expect(canManageRollout(so('hq'))).toBe(true);
    expect(canManageRollout(so('owner'))).toBe(false);
    expect(canManageRollout(makeActor({ role: 'root' }))).toBe(false);   // 未検証
  });
  it('開発環境（認証未設定）だけ isDevOpen が true', () => {
    expect(isDevOpen({})).toBe(true);
    expect(isDevOpen({ DASHBOARD_PASSWORD: 'x' })).toBe(false);
    expect(isDevOpen({ SALONONE_API_KEY: 'x' })).toBe(false);
  });
});

describe('authz: enforcement / kill switch', () => {
  it('既定は shadow', () => {
    expect(enforcementMode({})).toBe('shadow');
    expect(enforcementMode({ CHAT_AUTHZ_ENFORCE: 'strict' })).toBe('strict');
    expect(enforcementMode({ CHAT_AUTHZ_ENFORCE: 'off' })).toBe('off');
  });
  it('Kill Switch は環境変数でもストアのフラグでも有効', () => {
    expect(killSwitchOn({ CHAT_KILL_SWITCH: '1' })).toBe(true);
    expect(killSwitchOn({}, true)).toBe(true);
    expect(killSwitchOn({})).toBe(false);
  });
});
