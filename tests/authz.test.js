import { describe, it, expect } from 'vitest';
import { can, check, enforce, normalizeActor, inScope, isAgent, roleRank, needsReverify, decisionRecord, ACTIONS, ROLES, DEFAULT_TENANT, REVERIFY_ACTIONS } from '../lib/authz.js';

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

// ────────────────────────────────────────────────────────────────
// cc_authz=log 拡張（本部エイリアス / tenant / Chat操作 / 再検証）
// ────────────────────────────────────────────────────────────────
describe('authz - 役割エイリアス（headquarters / 本部）', () => {
  it('headquarters は admin（本部）として扱う', () => {
    expect(normalizeActor({ role: 'headquarters' }).role).toBe('admin');
  });
  it('日本語の「本部」も admin として扱う', () => {
    expect(normalizeActor({ role: '本部' }).role).toBe('admin');
  });
  it('既存の hq / brand_admin / shop_admin / shop_staff も従来どおり', () => {
    expect(normalizeActor({ role: 'hq' }).role).toBe('admin');
    expect(normalizeActor({ role: 'brand_admin' }).role).toBe('root');
    expect(normalizeActor({ role: 'shop_admin' }).role).toBe('owner');
    expect(normalizeActor({ role: 'shop_staff' }).role).toBe('staff');
  });
  it('headquarters は admin と同じ権限を持つ', () => {
    const hq = { id: 'u_hq2', role: 'headquarters', source: 'ui', verified: true, shops: null };
    expect(can(hq, 'flag.change', {}).allow).toBe(can(A.admin, 'flag.change', {}).allow);
  });
});

describe('authz - tenant 分離', () => {
  it('tenantId 未指定は既定テナント（naoru）', () => {
    expect(normalizeActor({ role: 'root' }).tenantId).toBe(DEFAULT_TENANT);
  });
  it('tenantId は大小文字を無視して正規化される', () => {
    expect(normalizeActor({ role: 'root', tenantId: 'ClientX' }).tenantId).toBe('clientx');
    expect(normalizeActor({ role: 'root', tenantId: '  ClientX  ' }).tenantId).toBe('clientx');
  });
  it('大小文字違いは同一テナントとして通す（分断を防ぐ）', () => {
    const a = { id: 'u', role: 'root', source: 'ui', verified: true, shops: null, tenantId: 'clientx' };
    expect(can(a, 'flag.change', { tenantId: 'ClientX' }).allow).toBe(true);
  });
  it('別テナントへの操作は root でも拒否（cross_tenant）', () => {
    const d = can(A.root, 'flag.change', { tenantId: 'other' });
    expect(d.allow).toBe(false);
    expect(d.code).toBe('cross_tenant');
  });
  it('同じテナントなら通常どおり判定', () => {
    expect(can(A.root, 'flag.change', { tenantId: DEFAULT_TENANT }).allow).toBe(true);
  });
  it('対象に tenantId が無ければテナント判定はしない（既存呼び出しを壊さない）', () => {
    expect(can(A.root, 'flag.change', {}).allow).toBe(true);
  });
});

describe('authz - Chat 操作', () => {
  it('staff も通常のチャット送信・DM・グループ作成はできる', () => {
    for (const a of ['chat.send', 'chat.dm', 'chat.group_create']) {
      expect(can(A.staff, a, EBISU).allow, a).toBe(true);
    }
  });
  it('staff はメンバー追加・削除はできない（店長以上）', () => {
    expect(can(A.staff, 'chat.member_add', EBISU).allow).toBe(false);
    expect(can(A.manager, 'chat.member_add', EBISU).allow).toBe(true);
  });
  it('複数店舗への一斉送信は owner 以上', () => {
    expect(can(A.staff, 'chat.broadcast', {}).allow).toBe(false);
    expect(can(A.manager, 'chat.broadcast', {}).allow).toBe(false);
    expect(can(A.owner, 'chat.broadcast', {}).allow).toBe(true);
  });
  it('全社一斉送信は本部（admin）以上のみ', () => {
    expect(can(A.staff, 'chat.broadcast_all', {}).allow).toBe(false);
    expect(can(A.owner, 'chat.broadcast_all', {}).allow).toBe(false);
    expect(can(A.admin, 'chat.broadcast_all', {}).allow).toBe(true);   // 本部＝全社発信は業務上必要
    expect(can(A.root, 'chat.broadcast_all', {}).allow).toBe(true);
  });
  it('宛先が多すぎる一斉送信は拒否（too_many_recipients）', () => {
    const d = can(A.owner, 'chat.broadcast', { recipientCount: 10000 });
    expect(d.allow).toBe(false);
    expect(d.code).toBe('too_many_recipients');
  });
  it('本部・管理者は宛先数の上限を超えられる（誤爆の歯止めは現場向け）', () => {
    expect(can(A.admin, 'chat.broadcast', { recipientCount: 10000 }).allow).toBe(true);
  });
  it('上限以内の宛先なら許可', () => {
    expect(can(A.owner, 'chat.broadcast', { recipientCount: 10 }).allow).toBe(true);
  });
  it('AI Agent はチャット送信できるが、ルームのアーカイブはできない（humanOnly）', () => {
    expect(can(A.agent, 'chat.send', EBISU).allow).toBe(true);
    expect(can(A.agent, 'chat.room_archive', EBISU).allow).toBe(false);
  });
  it('AI Agent も人間の権限を超える宛先には送れない（全社一斉は root 相当でも humanOnly ではないが rank で制御）', () => {
    const lowAgent = { id: 'a1', role: 'staff', source: 'agent', verified: true, shops: ['恵比寿'] };
    expect(can(lowAgent, 'chat.broadcast', {}).allow).toBe(false);
  });
  it('店舗スコープ外のチャット送信は拒否', () => {
    expect(can(A.staff, 'chat.send', { shop: '渋谷' }).allow).toBe(false);
  });
});

describe('authz - 高リスク操作の再検証', () => {
  it('承認・実行・フラグ変更・キルスイッチは再検証が必要', () => {
    for (const a of ['approval.approve', 'approval.execute', 'flag.change', 'killswitch.release']) {
      expect(needsReverify(a), a).toBe(true);
    }
  });
  it('広告・SNS・LP・Knowledge の変更も再検証が必要', () => {
    for (const a of ['meta.budget_change', 'meta.pause', 'meta.resume', 'meta.creative_replace', 'sns.post', 'lp.change', 'knowledge.publish']) {
      expect(needsReverify(a), a).toBe(true);
    }
  });
  it('全社一斉送信は再検証が必要（取り消せないため）', () => {
    expect(needsReverify('chat.broadcast_all')).toBe(true);
  });
  it('閲覧や通常のチャット送信は再検証不要（60秒キャッシュのままでよい）', () => {
    expect(needsReverify('approval.view')).toBe(false);
    expect(needsReverify('chat.send')).toBe(false);
  });
  it('未知の操作名は再検証不要（既定で false）', () => {
    expect(needsReverify('nope')).toBe(false);
    expect(needsReverify(null)).toBe(false);
  });
});

describe('authz - decisionRecord（誰が・どのrole・どのtenant・どの店舗・何を・ALLOW/DENY）', () => {
  it('ユーザーの要求した項目をすべて含む', () => {
    const rec = decisionRecord(A.owner, 'chat.broadcast', { shop: '恵比寿' }, can(A.owner, 'chat.broadcast', { shop: '恵比寿' }), 'log');
    expect(rec.actorId).toBe('u_owner');
    expect(rec.actorName).toBe('オーナーA');
    expect(rec.role).toBe('owner');
    expect(rec.source).toBe('ui');
    expect(rec.tenantId).toBe(DEFAULT_TENANT);
    expect(rec.shop).toBe('恵比寿');
    expect(rec.action).toBe('chat.broadcast');
    expect(rec.decision).toBe('ALLOW');
    expect(rec.mode).toBe('log');
  });
  it('拒否されるべき操作は DENY と理由コードを記録する', () => {
    const rec = decisionRecord(A.staff, 'flag.change', {}, can(A.staff, 'flag.change', {}), 'log');
    expect(rec.decision).toBe('DENY');
    expect(rec.code).toBeTruthy();
    expect(rec.reason).toBeTruthy();
  });
  it('AI Agent の操作も source=agent として記録される', () => {
    const rec = decisionRecord(A.agent, 'approval.approve', {}, can(A.agent, 'approval.approve', {}), 'log');
    expect(rec.source).toBe('agent');
    expect(rec.decision).toBe('DENY');
  });
  it('未検証（verified=false）も記録に残る', () => {
    const rec = decisionRecord(A.guest, 'approval.view', {}, can(A.guest, 'approval.view', {}), 'log');
    expect(rec.verified).toBe(false);
  });
  it('記録に秘密情報（トークン等）を含めない', () => {
    const rec = decisionRecord({ ...A.root, token: 'secret-token' }, 'flag.change', {}, can(A.root, 'flag.change', {}), 'log');
    expect(JSON.stringify(rec)).not.toContain('secret-token');
  });
});
