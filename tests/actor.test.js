import { describe, it, expect } from 'vitest';
import {
  ROLES, DEFAULT_TENANT_ID, ROOT_OWNER, DEFAULT_AUTH_SALT,
  normalizeRole, makeActor, agentActor, isSelfId, sameTenant, sameActor, withAltIds,
  resolveTenantId, rootTokenOf, authHeaders, actorFromSalonOne, actorFromRootToken,
  claimedActor, resolveActorFromRequest,
} from '../lib/actor.js';
import { hashOwnerToken } from '../lib/settlement.js';

const req = (headers = {}, body = {}) => ({ headers, body });

describe('actor: ロール正規化', () => {
  it('SalonOne のロール名を写像する（Source of Truth は SalonOne）', () => {
    expect(normalizeRole('brand_admin')).toBe('root');
    expect(normalizeRole('shop_admin')).toBe('owner');
    expect(normalizeRole('shop_staff')).toBe('staff');
  });
  it('未知・未指定は最小権限の staff', () => {
    expect(normalizeRole('')).toBe('staff');
    expect(normalizeRole('なにか')).toBe('staff');
    expect(normalizeRole('', { root: true })).toBe('root');
  });
  it('ロール一覧に manager を含む', () => {
    expect(ROLES).toEqual(expect.arrayContaining(['root', 'hq', 'owner', 'manager', 'staff', 'agent', 'system']));
  });
});

describe('actor: makeActor の形', () => {
  it('要求された必須フィールドを持つ', () => {
    const a = makeActor({ user_id: '7', staff_id: '9', role: 'shop_admin', accessible_store_ids: ['1', '2'], source: 'salonone', verified: true });
    expect(a).toMatchObject({
      tenant_id: 'default', user_id: '7', staff_id: '9', role: 'owner',
      accessible_store_ids: ['1', '2'], source: 'salonone', verified: true,
    });
  });
  it('staff_id が無ければ user_id を使う', () => {
    expect(makeActor({ user_id: '7' }).staff_id).toBe('7');
  });
  it('複数店舗はそのまま配列で保持される（1店舗なら1要素）', () => {
    expect(makeActor({ accessible_store_ids: ['A', 'B', 'C'] }).accessible_store_ids).toEqual(['A', 'B', 'C']);
    expect(makeActor({ accessible_store_ids: ['A'] }).accessible_store_ids).toEqual(['A']);
    expect(makeActor({}).accessible_store_ids).toEqual([]);
  });
  it('alt_ids に user_id / staff_id の両方が入る（SSOの取り違え対策）', () => {
    const a = makeActor({ user_id: '7', staff_id: '9' });
    expect(isSelfId(a, '7')).toBe(true);
    expect(isSelfId(a, '9')).toBe(true);
    expect(isSelfId(a, '8')).toBe(false);
  });
  it('source は既定で claimed（未検証）', () => {
    expect(makeActor({}).source).toBe('claimed');
    expect(makeActor({}).verified).toBe(false);
  });
});

describe('actor: AI Agent', () => {
  it('agent は acting_for を持ち、入れ子は禁止', () => {
    const ai = agentActor(makeActor({ staff_id: '1', role: 'root', verified: true }));
    expect(ai.role).toBe('agent');
    expect(ai.source).toBe('agent');
    expect(ai.acting_for.role).toBe('root');
    const nested = makeActor({ role: 'agent', acting_for: { role: 'agent', staff_id: 'x' } });
    expect(nested.acting_for).toBe(null);
  });
  it('agent は人間のアクセス店舗を引き継ぐ（超えない）', () => {
    const ai = agentActor(makeActor({ staff_id: '1', role: 'staff', accessible_store_ids: ['10'] }));
    expect(ai.accessible_store_ids).toEqual(['10']);
  });
});

describe('actor: テナント', () => {
  it('レコードに tenant_id が無ければ既定テナント扱い（既存データ互換）', () => {
    expect(sameTenant(makeActor({}), { kind: 'store' })).toBe(true);
    expect(makeActor({}).tenant_id).toBe(DEFAULT_TENANT_ID);
  });
  it('テナントが違えば不一致', () => {
    expect(sameTenant(makeActor({ tenant_id: 'tA' }), { tenantId: 'tB' })).toBe(false);
  });
  it('sameActor はテナント込みで比較する', () => {
    const a = makeActor({ tenant_id: 'tA', staff_id: '1' });
    const b = makeActor({ tenant_id: 'tB', staff_id: '1' });
    expect(sameActor(a, a)).toBe(true);
    expect(sameActor(a, b)).toBe(false);
  });
  it('ヘッダ > 環境変数 > 既定 でテナントを決める', () => {
    expect(resolveTenantId(req({ 'x-tenant-id': 'tA' }), { TENANT_ID: 'tB' })).toBe('tA');
    expect(resolveTenantId(req(), { TENANT_ID: 'tB' })).toBe('tB');
    expect(resolveTenantId(req(), {})).toBe('default');
  });
});

describe('actor: SalonOne SSO（Identity の正本）', () => {
  it('brand_admin → root、accessible_shops の id が accessible_store_ids になる', () => {
    const a = actorFromSalonOne({ role: 'brand_admin', userId: '7', staffId: '9', shopIds: ['100', '200'], shopNames: ['A院', 'B院'] });
    expect(a.role).toBe('root');
    expect(a.accessible_store_ids).toEqual(['100', '200']);
    expect(a.store_names).toEqual(['A院', 'B院']);
    expect(a.source).toBe('salonone');
    expect(a.verified).toBe(true);
  });
  it('複数店舗の shop_admin をそのまま引き継ぐ', () => {
    const a = actorFromSalonOne({ role: 'shop_admin', userId: '3', shopIds: ['A', 'B', 'C'] });
    expect(a.role).toBe('owner');
    expect(a.accessible_store_ids).toEqual(['A', 'B', 'C']);
  });
  it('1店舗のみの shop_staff は1店舗だけ', () => {
    const a = actorFromSalonOne({ role: 'shop_staff', userId: '5', shopIds: ['100'] });
    expect(a.role).toBe('staff');
    expect(a.accessible_store_ids).toEqual(['100']);
  });
  it('null は null', () => { expect(actorFromSalonOne(null)).toBe(null); });
});

describe('actor: settlement-auth の rootトークン', () => {
  it('settlement-auth と同じトークンを再計算できる', () => {
    expect(rootTokenOf('pw123')).toBe(hashOwnerToken(ROOT_OWNER, 'pw123', DEFAULT_AUTH_SALT));
    expect(rootTokenOf('')).toBe('');
  });
  it('正しいトークンで root actor（source=dashboard）', () => {
    const a = actorFromRootToken({ token: rootTokenOf('pw') }, { DASHBOARD_PASSWORD: 'pw' });
    expect(a.role).toBe('root');
    expect(a.staff_id).toBe(ROOT_OWNER);
    expect(a.source).toBe('dashboard');
    expect(a.verified).toBe(true);
  });
  it('role=hq なら本人名を staff_id にしつつ hq を保持', () => {
    const a = actorFromRootToken({ token: rootTokenOf('pw'), role: 'hq', owner: '若林' }, { DASHBOARD_PASSWORD: 'pw' });
    expect(a.role).toBe('hq');
    expect(a.staff_id).toBe('若林');
    expect(isSelfId(a, ROOT_OWNER)).toBe(true);
  });
  it('誤トークン / 未設定は null', () => {
    expect(actorFromRootToken({ token: 'bad' }, { DASHBOARD_PASSWORD: 'pw' })).toBe(null);
    expect(actorFromRootToken({ token: rootTokenOf('pw') }, {})).toBe(null);
  });
});

describe('actor: resolveActorFromRequest', () => {
  it('Bearer が検証できれば SSO の actor（申告の root は無視）', async () => {
    const a = await resolveActorFromRequest(req({ authorization: 'Bearer x' }, { staffId: 'u1', root: true }), {
      env: {}, verifyBearer: async () => ({ role: 'shop_staff', userId: '9', shopIds: ['100'] }),
    });
    expect(a.role).toBe('staff');
    expect(a.source).toBe('salonone');
    expect(a.accessible_store_ids).toEqual(['100']);
  });
  it('Bearer 無効なら rootトークン → 申告値の順', async () => {
    const a = await resolveActorFromRequest(req({ authorization: 'Bearer bad', 'x-chat-token': rootTokenOf('pw') }, {}), {
      env: { DASHBOARD_PASSWORD: 'pw' }, verifyBearer: async () => null,
    });
    expect(a.role).toBe('root');
    expect(a.verified).toBe(true);
  });
  it('材料が無ければ未検証の申告 actor', async () => {
    const a = await resolveActorFromRequest(req({}, { staffId: 'u1', shops: ['A院'] }), { env: {}, verifyBearer: async () => null });
    expect(a.verified).toBe(false);
    expect(a.source).toBe('claimed');
    expect(a.staff_id).toBe('u1');
  });
  it('verifyBearer が例外でも落ちない', async () => {
    const a = await resolveActorFromRequest(req({ authorization: 'Bearer x' }, { staffId: 'u1' }), {
      env: {}, verifyBearer: async () => { throw new Error('boom'); },
    });
    expect(a.verified).toBe(false);
  });
});

describe('actor: 補助', () => {
  it('authHeaders は大文字小文字どちらでも拾う', () => {
    expect(authHeaders(req({ 'x-chat-owner': 'o', 'x-chat-token': 't', 'x-chat-role': 'hq' })))
      .toEqual({ bearer: '', owner: 'o', token: 't', role: 'hq' });
    expect(authHeaders(req({ Authorization: 'Bearer z' })).bearer).toBe('Bearer z');
    expect(authHeaders(req({ authorization: 'Basic z' })).bearer).toBe('');
  });
  it('withAltIds はサーバー確認済みの別IDを足す', () => {
    const a = withAltIds(makeActor({ staff_id: '若林', role: 'hq', verified: true }), ['123']);
    expect(isSelfId(a, '123')).toBe(true);
    expect(a.role).toBe('hq');
  });
  it('claimedActor は必ず verified:false', () => {
    expect(claimedActor({ staffId: 'x', root: true }).verified).toBe(false);
  });
});
