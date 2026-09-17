import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveActor, safeEqual, bearerOf, _clearBearerCache } from '../lib/actor.js';

// Bearer 検証の結果はトークン単位でキャッシュされる（本番では同じトークン＝同じ人なので正しい）。
// テスト間で持ち越さないよう毎回クリアする。
beforeEach(() => _clearBearerCache());

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


describe('actor - ポーリングで上流を叩きすぎない', () => {
  it('同じBearerの連続リクエストで /me は1回しか呼ばれない', async () => {
    const spy = vi.fn(async () => ({ root: true, role: 'brand_admin', shopNames: [], userId: '7', loginId: 'u' }));
    const req = { headers: { authorization: 'Bearer same-token' }, body: {} };
    for (let i = 0; i < 10; i++) await resolveActor(req, { env: {}, verifySalonOneBearer: spy });
    expect(spy).toHaveBeenCalledTimes(1);          // ← SalonOne のレート制限(60/分)を守るため
  });

  it('別のBearerなら別途検証する', async () => {
    const spy = vi.fn(async () => ({ root: true, role: 'brand_admin', shopNames: [], userId: '7', loginId: 'u' }));
    await resolveActor({ headers: { authorization: 'Bearer aaa' }, body: {} }, { env: {}, verifySalonOneBearer: spy });
    await resolveActor({ headers: { authorization: 'Bearer bbb' }, body: {} }, { env: {}, verifySalonOneBearer: spy });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('ローカルで判定できる場合は /me を呼ばない（rootトークン）', async () => {
    const spy = vi.fn(async () => ({ root: true, role: 'brand_admin', shopNames: [] }));
    const a = await resolveActor(
      { headers: { authorization: 'Bearer x' }, body: { owner: '__root__', token: 'rt' } },
      { env: {}, rootToken: () => 'rt', verifySalonOneBearer: spy });
    expect(a.role).toBe('root');
    expect(spy).not.toHaveBeenCalled();            // ← ネットワークを使わない
  });

  it('cron も /me を呼ばない', async () => {
    const spy = vi.fn(async () => ({ root: true, role: 'brand_admin' }));
    const a = await resolveActor({ headers: { authorization: 'Bearer cs' }, body: {} }, { env: { CRON_SECRET: 'cs' }, verifySalonOneBearer: spy });
    expect(a.source).toBe('cron');
    expect(spy).not.toHaveBeenCalled();            // cronの秘密で /me を叩かない
  });

  it('エージェントトークンも /me を呼ばない', async () => {
    const spy = vi.fn(async () => ({ root: true, role: 'brand_admin' }));
    const a = await resolveActor({ headers: { 'x-cc-agent-token': 'ag', authorization: 'Bearer x' }, body: {} }, { env: { CC_AGENT_TOKEN: 'ag' }, verifySalonOneBearer: spy });
    expect(a.source).toBe('agent');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('resolveActor - Bearer検証の失敗もキャッシュする', () => {
  it('無効トークンの連打で上流を何度も叩かない（60回/分の保護）', async () => {
    let calls = 0;
    const d = { verifySalonOneBearer: async () => { calls++; return null; } };
    const req = { headers: { authorization: 'Bearer bad-token' }, body: {}, query: {} };
    for (let i = 0; i < 5; i++) await resolveActor(req, d);
    expect(calls).toBe(1);
  });
  it('失敗キャッシュに当たっても verified:false の主体を返す（誤って許可しない）', async () => {
    const d = { verifySalonOneBearer: async () => null };
    const req = { headers: { authorization: 'Bearer bad-token2' }, body: { actor: { role: 'root' } }, query: {} };
    await resolveActor(req, d);
    const a = await resolveActor(req, d);
    expect(a.verified).toBe(false);
  });
  it('高リスク操作（skipCache）は失敗キャッシュも使わず毎回確かめる', async () => {
    let calls = 0;
    const d = { verifySalonOneBearer: async () => { calls++; return null; }, skipCache: true };
    const req = { headers: { authorization: 'Bearer bad-token3' }, body: {}, query: {} };
    await resolveActor(req, d);
    await resolveActor(req, d);
    expect(calls).toBe(2);
  });
  it('60秒経てば再検証する（失効の反映が最大60秒遅れる仕様の確認）', async () => {
    let calls = 0;
    const d = { verifySalonOneBearer: async () => { calls++; return null; } };
    const req = { headers: { authorization: 'Bearer bad-token4' }, body: {}, query: {} };
    await resolveActor(req, { ...d, now: 1_000_000 });
    await resolveActor(req, { ...d, now: 1_000_000 + 61_000 });
    expect(calls).toBe(2);
  });
});
