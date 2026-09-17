import { describe, it, expect } from 'vitest';
import { can, check, enforce, normalizeActor, inScope, isAgent, roleRank, ACTIONS, ROLES } from '../lib/authz.js';

// ── 検証用の主体（fixture）。verified=true はトークン検証を通った状態 ──
const A = {
  root:    { id: 'u_root',    name: '管理者',       role: 'root',    source: 'ui',    verified: true, shops: null },
  admin:   { id: 'u_admin',   name: '本部 若林',    role: 'admin',   source: 'ui',    verified: true, shops: null },
  hq:      { id: 'u_hq',      name: '本部（旧hq）', role: 'hq',      source: 'ui',    verified: true, shops: null },
  owner:   { id: 'u_owner',   name: 'オーナーA',    role: 'owner',   source: 'ui',    verified: true, shops: ['恵比寿'] },
  manager: { id: 'u_mgr',     name: '店長B',        role: 'manager', source: 'ui',    verified: true, shops: ['恵比寿'] },
  staff:   { id: 'u_staff',   name: 'セラピストC',  role: 'staff',   source: 'ui',    verified: true, shops: ['恵比寿'] },
  agent:   { id: 'a_meta',    name: 'Meta Ads Operator', role: 'root', source: 'agent', verified: true, shops: null },
  cron:    { id: 'cron',      name: 'cron',         role: 'root',    source: 'cron',  verified: true, shops: null },
  guest:   { id: '',          name: '',             role: 'guest',   source: 'ui',    verified: false, shops: null },
};
const EBISU = { shop: '恵比寿院' };

describe('authz - 役割の正規化', () => {
  it('hq は admin の別名として扱う（既存アカウントを作り直さない）', () => {
    expect(normalizeActor(A.hq).role).toBe('admin');
    expect(roleRank(A.hq)).toBe(roleRank(A.admin));
  });
  it('SalonOne の役割も写像する', () => {
    expect(normalizeActor({ role: 'brand_admin' }).role).toBe('root');
    expect(normalizeActor({ role: 'shop_admin' }).role).toBe('owner');
    expect(normalizeActor({ role: 'shop_staff' }).role).toBe('staff');
  });
  it('未知の役割は guest へ落とす（昇格させない）', () => {
    expect(normalizeActor({ role: 'superuser' }).role).toBe('guest');
    expect(normalizeActor({ role: 'ROOT' }).role).toBe('guest');
    expect(normalizeActor(null).role).toBe('guest');
  });
  it('未知の source は ui へ落とす', () => {
    expect(normalizeActor({ role: 'root', source: 'magic' }).source).toBe('ui');
  });
});

describe('authz - AIエージェントは承認者になれない（最重要）', () => {
  const humanOnly = ['approval.approve', 'approval.reject', 'approval.request_changes', 'flag.change', 'killswitch.engage', 'killswitch.release', 'audit.read'];
  for (const action of humanOnly) {
    it(`agent は ${action} を行えない（role が root でも）`, () => {
      const d = can(A.agent, action, EBISU);
      expect(d.allow).toBe(false);
      expect(d.code).toBe('agent_forbidden');
    });
  }
  it('isAgent は source で判定する（role では回避できない）', () => {
    expect(isAgent(A.agent)).toBe(true);
    expect(isAgent(A.root)).toBe(false);
  });
  it('agent でも提案の作成と実行記録はできる', () => {
    expect(can(A.agent, 'approval.create', EBISU).allow).toBe(true);
    expect(can(A.agent, 'agentlog.write', EBISU).allow).toBe(true);
    expect(can(A.agent, 'audit.write', {}).allow).toBe(true);
  });
  it('agent は Agent Activity を閲覧できない（自分の記録を読ませない）', () => {
    expect(can(A.agent, 'agentlog.read', EBISU).allow).toBe(false);
  });
});

describe('authz - 指定された10操作の可否', () => {
  const table = [
    // action,                  root,  admin, owner, manager, staff, agent
    ['approval.create',         true,  true,  true,  true,    true,  true ],
    ['approval.approve',        true,  true,  true,  false,   false, false],
    ['approval.reject',         true,  true,  true,  false,   false, false],
    ['flag.change',             true,  true,  false, false,   false, false],
    ['killswitch.engage',       true,  true,  true,  true,    false, false],
    ['killswitch.release',      true,  true,  false, false,   false, false],
    ['agentlog.read',           true,  true,  true,  true,    false, false],
    ['audit.read',              true,  true,  false, false,   false, false],
    ['meta.budget_change',      true,  true,  true,  false,   false, true ],
    ['sns.post',                true,  true,  false, false,   false, false],
    ['lp.change',               true,  true,  false, false,   false, false],
  ];
  for (const [action, r, ad, ow, mg, st, ag] of table) {
    it(`${action}`, () => {
      // 外向き操作は「承認済み」を前提に可否だけを見る
      const t = { ...EBISU, risk: 'medium', approvalStatus: 'approved' };
      expect(can(A.root, action, t).allow, 'root').toBe(r);
      expect(can(A.admin, action, t).allow, 'admin').toBe(ad);
      expect(can(A.owner, action, t).allow, 'owner').toBe(ow);
      expect(can(A.manager, action, t).allow, 'manager').toBe(mg);
      expect(can(A.staff, action, t).allow, 'staff').toBe(st);
      expect(can(A.agent, action, t).allow, 'agent').toBe(ag);
    });
  }
});

describe('authz - キルスイッチは「止めるのは緩く、解除は厳しく」', () => {
  it('owner / manager でも緊急停止できる', () => {
    expect(can(A.owner, 'killswitch.engage', {}).allow).toBe(true);
    expect(can(A.manager, 'killswitch.engage', {}).allow).toBe(true);
  });
  it('解除できるのは root / admin だけ', () => {
    expect(can(A.owner, 'killswitch.release', {}).allow).toBe(false);
    expect(can(A.manager, 'killswitch.release', {}).allow).toBe(false);
    expect(can(A.admin, 'killswitch.release', {}).allow).toBe(true);
  });
});

describe('authz - リスクによる引き上げ', () => {
  it('高リスクの承認は本部以上のみ', () => {
    expect(can(A.owner, 'approval.approve', { ...EBISU, risk: 'low' }).allow).toBe(true);
    expect(can(A.owner, 'approval.approve', { ...EBISU, risk: 'medium' }).allow).toBe(true);
    expect(can(A.owner, 'approval.approve', { ...EBISU, risk: 'high' }).allow).toBe(false);
    expect(can(A.admin, 'approval.approve', { ...EBISU, risk: 'high' }).allow).toBe(true);
  });
  it('低リスクなら manager も承認できる', () => {
    expect(can(A.manager, 'approval.approve', { ...EBISU, risk: 'low' }).allow).toBe(true);
  });
  it('risk 未指定は medium として扱う（安全側）', () => {
    expect(can(A.manager, 'approval.approve', EBISU).allow).toBe(false);
  });
  it('高リスクは提案者本人が承認できない', () => {
    const t = { ...EBISU, risk: 'high', proposedByActorId: 'u_admin' };
    expect(can(A.admin, 'approval.approve', t).code).toBe('self_approval_forbidden');
    expect(can(A.root, 'approval.approve', t).allow).toBe(true);
  });
});

describe('authz - 店舗スコープ', () => {
  it('root / admin は全店', () => {
    expect(inScope(A.root, '千葉駅院')).toBe(true);
    expect(inScope(A.admin, '千葉駅院')).toBe(true);
  });
  it('owner は管轄店舗のみ（部分一致）', () => {
    expect(inScope(A.owner, '恵比寿院')).toBe(true);
    expect(inScope(A.owner, '千葉駅院')).toBe(false);
  });
  it('管轄外の承認は拒否される', () => {
    const d = can(A.owner, 'approval.approve', { shop: '千葉駅院', risk: 'medium' });
    expect(d.allow).toBe(false);
    expect(d.code).toBe('out_of_scope');
  });
  it('店舗限定の役割で shops が無ければ拒否（空なら全店ではない）', () => {
    expect(inScope({ role: 'owner', source: 'ui', verified: true, shops: null }, '恵比寿院')).toBe(false);
  });
});

describe('authz - 未認証と未定義', () => {
  it('未認証は読み取りも通さない（フラグ取得だけ例外）', () => {
    expect(can(A.guest, 'approval.read', EBISU).code).toBe('unauthenticated');
    expect(can(A.guest, 'agentlog.read', EBISU).code).toBe('unauthenticated');
    expect(can(A.guest, 'flag.read', {}).allow).toBe(true);   // 画面を描くのに必要
  });
  it('検証を通っていない actor は role が root でも拒否', () => {
    expect(can({ ...A.root, verified: false }, 'flag.change', {}).code).toBe('unauthenticated');
  });
  it('未定義の操作は既定拒否', () => {
    expect(can(A.root, 'database.drop', {}).code).toBe('unknown_action');
  });
});

describe('authz - 外向き操作は承認済みを要求', () => {
  for (const action of ['meta.budget_change', 'meta.pause', 'sns.post', 'lp.change', 'knowledge.publish']) {
    it(`${action} は未承認だと拒否`, () => {
      expect(can(A.root, action, { ...EBISU, approvalStatus: 'pending' }).code).toBe('approval_required');
      expect(can(A.root, action, { ...EBISU, approvalStatus: 'approved' }).allow).toBe(true);
    });
  }
  it('cron は外向き操作を行えない', () => {
    expect(can(A.cron, 'meta.pause', { ...EBISU, approvalStatus: 'approved' }).code).toBe('cron_forbidden');
  });
});

describe('authz - 段階導入（既存の動きを変えない）', () => {
  const denied = can(A.staff, 'flag.change', {});
  it('off はブロックもログもしない', () => {
    const e = enforce('off', denied);
    expect(e.blocked).toBe(false);
    expect(e.shouldLog).toBe(false);
  });
  it('log は記録するがブロックしない', () => {
    const e = enforce('log', denied);
    expect(e.blocked).toBe(false);
    expect(e.shouldLog).toBe(true);
  });
  it('warn は警告するがブロックしない', () => {
    const e = enforce('warn', denied);
    expect(e.blocked).toBe(false);
    expect(e.shouldWarn).toBe(true);
  });
  it('enforce で初めてブロックする', () => {
    expect(enforce('enforce', denied).blocked).toBe(true);
  });
  it('許可された操作は enforce でもブロックされない', () => {
    expect(enforce('enforce', can(A.root, 'flag.change', {})).blocked).toBe(false);
  });
  it('未知の mode は off として扱う（安全側＝既存を壊さない）', () => {
    expect(enforce('yolo', denied).blocked).toBe(false);
  });
  it('check は判定と段階適用をまとめて行う', () => {
    expect(check(A.agent, 'approval.approve', EBISU, 'enforce').blocked).toBe(true);
    expect(check(A.agent, 'approval.approve', EBISU, 'off').blocked).toBe(false);
  });
});

describe('authz - 表の網羅性', () => {
  it('全ての操作が minRank と scoped を持つ', () => {
    for (const [name, spec] of Object.entries(ACTIONS)) {
      expect(typeof spec.minRank, name).toBe('number');
      expect(typeof spec.scoped, name).toBe('boolean');
    }
  });
  it('役割の rank は root > admin > owner > manager > staff > guest', () => {
    const r = (k) => ROLES[k].rank;
    expect(r('root')).toBeGreaterThan(r('admin'));
    expect(r('admin')).toBeGreaterThan(r('owner'));
    expect(r('owner')).toBeGreaterThan(r('manager'));
    expect(r('manager')).toBeGreaterThan(r('staff'));
    expect(r('staff')).toBeGreaterThan(r('guest'));
  });
});
