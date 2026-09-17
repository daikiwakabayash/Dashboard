import { describe, it, expect } from 'vitest';
import { resolveActor, safeEqual, bearerOf } from '../lib/actor.js';

const req = (over = {}) => ({ headers: {}, body: {}, ...over });

describe('actor - 定数時間比較', () => {
  it('一致・不一致を正しく判定する', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual(null, '')).toBe(true);
  });
});

describe('actor - Bearer の取り出し', () => {
  it('Bearer 形式のみ受理する', () => {
    expect(bearerOf(req({ headers: { authorization: 'Bearer xyz' } }))).toBe('Bearer xyz');
    expect(bearerOf(req({ headers: { authorization: 'Basic xyz' } }))).toBe('');
    expect(bearerOf(req())).toBe('');
  });
});

describe('actor - 確認できないものは verified:false', () => {
  it('何も無ければ guest 相当', async () => {
    const a = await resolveActor(req(), { env: {} });
    expect(a.verified).toBe(false);
  });
  it('クライアントが root を名乗っても verified:false のまま', async () => {
    const a = await resolveActor(req({ body: { actor: { id: 'x', role: 'root', name: 'なりすまし' } } }), { env: {} });
    expect(a.role).toBe('root');       // 名乗りは残すが
    expect(a.verified).toBe(false);    // 検証は通っていない → authz が拒否する
  });
  it('トークンが違えば検証を通さない', async () => {
    const a = await resolveActor(req({ body: { owner: '__root__', token: 'wrong' } }), { env: {}, rootToken: () => 'correct' });
    expect(a.verified).toBe(false);
  });
});

describe('actor - SalonOne SSO', () => {
  it('brand_admin は root・全店', async () => {
    const a = await resolveActor(req({ headers: { authorization: 'Bearer t' } }), {
      env: {},
      verifySalonOneBearer: async () => ({ root: true, role: 'brand_admin', shopNames: [], userId: '7', loginId: 'wakabayashi' }),
    });
    expect(a.verified).toBe(true);
    expect(a.role).toBe('root');
    expect(a.shops).toBeNull();
  });
  it('shop_staff は staff・所属店舗のみ', async () => {
    const a = await resolveActor(req({ headers: { authorization: 'Bearer t' } }), {
      env: {},
      verifySalonOneBearer: async () => ({ root: false, role: 'shop_staff', shopNames: ['恵比寿院'], userId: '9', loginId: 'c' }),
    });
    expect(a.role).toBe('staff');
    expect(a.shops).toEqual(['恵比寿院']);
  });
  it('上流の検証が失敗したら次の手段へ進む（例外で落ちない）', async () => {
    const a = await resolveActor(req({ headers: { authorization: 'Bearer t' } }), {
      env: {}, verifySalonOneBearer: async () => { throw new Error('upstream down'); },
    });
    expect(a.verified).toBe(false);
  });
});

describe('actor - エージェントトークン', () => {
  it('正しいトークンなら source=agent で確定する', async () => {
    const a = await resolveActor(req({ headers: { 'x-cc-agent-token': 'secret' }, body: { actor: { id: 'a1', name: 'Meta Ads Operator' } } }), { env: { CC_AGENT_TOKEN: 'secret' } });
    expect(a.verified).toBe(true);
    expect(a.source).toBe('agent');
    expect(a.name).toBe('Meta Ads Operator');
  });
  it('エージェントが root を名乗っても source は agent のまま', async () => {
    const a = await resolveActor(req({ headers: { 'x-cc-agent-token': 'secret' }, body: { actor: { role: 'root' } } }), { env: { CC_AGENT_TOKEN: 'secret' } });
    expect(a.source).toBe('agent');    // ここが崩れると承認をすり抜ける
  });
  it('トークンが違えば agent にならない', async () => {
    const a = await resolveActor(req({ headers: { 'x-cc-agent-token': 'wrong' } }), { env: { CC_AGENT_TOKEN: 'secret' } });
    expect(a.verified).toBe(false);
  });
  it('CC_AGENT_TOKEN 未設定なら agent 経路は成立しない', async () => {
    const a = await resolveActor(req({ headers: { 'x-cc-agent-token': 'anything' } }), { env: {} });
    expect(a.verified).toBe(false);
  });
});

describe('actor - cron とオーナートークン', () => {
  it('CRON_SECRET 一致で source=cron', async () => {
    const a = await resolveActor(req({ headers: { authorization: 'Bearer cs' } }), { env: { CRON_SECRET: 'cs' } });
    expect(a.source).toBe('cron');
    expect(a.verified).toBe(true);
  });
  it('オーナートークンで管轄店舗が入る', async () => {
    const a = await resolveActor(req({ body: { owner: 'オーナーA', token: 'tk' } }), {
      env: {},
      verifyOwnerToken: () => true,
      loadAccounts: async () => ({ passwords: {}, shopsMap: { 'オーナーA': ['恵比寿'] }, metaMap: { 'オーナーA': { role: 'owner', staffName: 'A' } } }),
    });
    expect(a.verified).toBe(true);
    expect(a.role).toBe('owner');
    expect(a.shops).toEqual(['恵比寿']);
  });
  it('hq アカウントは admin へ写像され全店になる', async () => {
    const a = await resolveActor(req({ body: { owner: '若林', token: 'tk' } }), {
      env: {},
      verifyOwnerToken: () => true,
      loadAccounts: async () => ({ passwords: {}, shopsMap: { '若林': ['恵比寿'] }, metaMap: { '若林': { role: 'hq', staffName: '若林' } } }),
    });
    expect(a.role).toBe('admin');
    expect(a.shops).toBeNull();
  });
});
