import { describe, it, expect } from 'vitest';
import {
  resolveTenantId, rootTokenOf, authHeaders, claimedActor,
  actorFromSalonOne, actorFromRootToken, resolveActorFromRequest,
  DEFAULT_AUTH_SALT, ROOT_OWNER,
} from '../lib/chat-identity.js';
import { hashOwnerToken } from '../lib/settlement.js';

const req = (headers = {}, body = {}) => ({ headers, body });

describe('chat-identity: テナント解決', () => {
  it('ヘッダ > 環境変数 > 既定', () => {
    expect(resolveTenantId(req({ 'x-tenant-id': 'tA' }), { TENANT_ID: 'tB' })).toBe('tA');
    expect(resolveTenantId(req(), { TENANT_ID: 'tB' })).toBe('tB');
    expect(resolveTenantId(req(), {})).toBe('default');
  });
});

describe('chat-identity: root トークン', () => {
  it('settlement-auth と同じトークンを再計算できる', () => {
    const expected = hashOwnerToken(ROOT_OWNER, 'pw123', DEFAULT_AUTH_SALT);
    expect(rootTokenOf('pw123')).toBe(expected);
    expect(rootTokenOf('pw123', 'other-salt')).not.toBe(expected);
    expect(rootTokenOf('')).toBe('');
  });
  it('正しいトークンで検証済み root actor になる', () => {
    const token = rootTokenOf('pw123');
    const a = actorFromRootToken({ token }, { DASHBOARD_PASSWORD: 'pw123' });
    expect(a.role).toBe('root');
    expect(a.verified).toBe(true);
    expect(a.actorId).toBe(ROOT_OWNER);
  });
  it('role ヘッダが hq なら hq を保持する（表示名が本人名になる既存仕様）', () => {
    const token = rootTokenOf('pw123');
    const a = actorFromRootToken({ token, role: 'hq', owner: '若林' }, { DASHBOARD_PASSWORD: 'pw123' });
    expect(a.role).toBe('hq');
    expect(a.actorId).toBe('若林');
  });
  it('誤ったトークン / パスワード未設定では null', () => {
    expect(actorFromRootToken({ token: 'wrong' }, { DASHBOARD_PASSWORD: 'pw123' })).toBe(null);
    expect(actorFromRootToken({ token: rootTokenOf('pw123') }, {})).toBe(null);
    expect(actorFromRootToken(null, { DASHBOARD_PASSWORD: 'pw123' })).toBe(null);
  });
});

describe('chat-identity: SalonOne SSO', () => {
  it('brand_admin は root・アクセス店舗が storeIds になる', () => {
    const a = actorFromSalonOne({ role: 'brand_admin', userId: '7', shopIds: ['100', '200'], shopNames: ['A院', 'B院'] });
    expect(a.role).toBe('root');
    expect(a.storeIds).toEqual(['100', '200']);
    expect(a.verified).toBe(true);
  });
  it('shop_staff は staff・自店のみ', () => {
    const a = actorFromSalonOne({ role: 'shop_staff', userId: '9', shopIds: ['100'] });
    expect(a.role).toBe('staff');
    expect(a.storeIds).toEqual(['100']);
  });
  it('null なら null', () => {
    expect(actorFromSalonOne(null)).toBe(null);
  });
});

describe('chat-identity: 未検証（申告値）', () => {
  it('既存クライアントの {staffId, root, shops} 形式を受け取れる', () => {
    const a = claimedActor({ staffId: 'u1', root: true, shops: ['A院'] });
    expect(a.role).toBe('root');
    expect(a.shopNames).toEqual(['A院']);
    expect(a.verified).toBe(false);          // ← 申告値は検証済みにしない
  });
  it('何も申告が無ければ最小権限の staff', () => {
    const a = claimedActor({});
    expect(a.role).toBe('staff');
    expect(a.verified).toBe(false);
  });
});

describe('chat-identity: resolveActorFromRequest', () => {
  it('Bearer が検証できれば SSO の actor（申告値の root を無視する）', async () => {
    const r = req({ authorization: 'Bearer abc' }, { staffId: 'u1', root: true });
    const a = await resolveActorFromRequest(r, {
      env: {},
      verifyBearer: async () => ({ role: 'shop_staff', userId: '9', shopIds: ['100'] }),
    });
    expect(a.role).toBe('staff');            // 申告の root:true に引きずられない
    expect(a.verified).toBe(true);
    expect(a.actorId).toBe('9');
  });
  it('Bearer が無効なら root トークン → 申告値の順にフォールバックする', async () => {
    const token = rootTokenOf('pw');
    const a = await resolveActorFromRequest(
      req({ authorization: 'Bearer bad', 'x-chat-token': token }, { staffId: 'u1' }),
      { env: { DASHBOARD_PASSWORD: 'pw' }, verifyBearer: async () => null },
    );
    expect(a.role).toBe('root');
    expect(a.verified).toBe(true);
  });
  it('検証材料が無ければ未検証の申告 actor', async () => {
    const a = await resolveActorFromRequest(req({}, { staffId: 'u1', shops: ['A院'] }), { env: {}, verifyBearer: async () => null });
    expect(a.verified).toBe(false);
    expect(a.actorId).toBe('u1');
  });
  it('verifyBearer が例外を投げても落ちない', async () => {
    const a = await resolveActorFromRequest(req({ authorization: 'Bearer x' }, { staffId: 'u1' }), {
      env: {}, verifyBearer: async () => { throw new Error('boom'); },
    });
    expect(a.verified).toBe(false);
    expect(a.actorId).toBe('u1');
  });
});

describe('chat-identity: authHeaders', () => {
  it('大文字小文字どちらのヘッダ名でも拾う', () => {
    expect(authHeaders(req({ 'x-chat-owner': 'o', 'x-chat-token': 't', 'x-chat-role': 'hq' })))
      .toEqual({ bearer: '', owner: 'o', token: 't', role: 'hq' });
    expect(authHeaders(req({ Authorization: 'Bearer z' })).bearer).toBe('Bearer z');
    expect(authHeaders(req({ authorization: 'Basic z' })).bearer).toBe('');
  });
});
