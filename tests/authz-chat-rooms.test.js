import { describe, it, expect } from 'vitest';
import {
  canViewRoom, canPostRoom, isRoomMember, normalizeActor,
  bulkThreshold, confirmLevel, isOrgWideSend, DEFAULT_BULK_THRESHOLDS, can,
} from '../lib/authz.js';

// 5ロール＋AI。Preview で切り替えて検証するのと同じ顔ぶれ。
const U = {
  root:    { id: 'u_root', name: '管理者',   role: 'root',    source: 'ui', verified: true, shops: null },
  hq:      { id: 'u_hq',   name: '本部若林', role: 'hq',      source: 'ui', verified: true, shops: null },
  owner:   { id: 'u_own',  name: 'オーナー', role: 'owner',   source: 'ui', verified: true, shops: ['恵比寿', '渋谷'] },
  manager: { id: 'u_mgr',  name: '店長',     role: 'manager', source: 'ui', verified: true, shops: ['恵比寿'] },
  staff:   { id: 'u_st',   name: 'セラピスト', role: 'staff', source: 'ui', verified: true, shops: ['恵比寿'] },
  other:   { id: 'u_ot',   name: '他店',     role: 'staff',   source: 'ui', verified: true, shops: ['梅田'] },
  agent:   { id: 'a_ai',   name: 'AI',       role: 'root',    source: 'agent', verified: true, shops: null },
};
const R = {
  announce: { id: 'announce_all', kind: 'announce', name: '全社アナウンス', members: [] },
  ebisu:    { id: 'store_恵比寿', kind: 'store', shop: '恵比寿', members: [] },
  umeda:    { id: 'store_梅田',   kind: 'store', shop: '梅田',   members: [] },
  group:    { id: 'g1', kind: 'group', name: '部活', members: ['u_st', 'u_mgr'] },
  dm:       { id: 'd1', kind: 'dm', members: ['u_st', 'u_mgr'] },
  archived: { id: 'g2', kind: 'group', members: ['u_st'], status: 'archived' },
};

describe('canViewRoom - 全社アナウンス', () => {
  it('全ロールが読める', () => {
    for (const k of ['root', 'hq', 'owner', 'manager', 'staff']) {
      expect(canViewRoom(U[k], R.announce), k).toBe(true);
    }
  });
  it('未認証（guest）は読めない', () => {
    expect(canViewRoom({ role: 'guest' }, R.announce)).toBe(false);
  });
});

describe('canViewRoom - 店舗ルーム', () => {
  it('本部・管理者は全店見える', () => {
    expect(canViewRoom(U.root, R.umeda)).toBe(true);
    expect(canViewRoom(U.hq, R.umeda)).toBe(true);
  });
  it('オーナーは管轄店舗のみ', () => {
    expect(canViewRoom(U.owner, R.ebisu)).toBe(true);
    expect(canViewRoom(U.owner, R.umeda)).toBe(false);
  });
  it('マネージャーは管理店舗のみ', () => {
    expect(canViewRoom(U.manager, R.ebisu)).toBe(true);
    expect(canViewRoom(U.manager, R.umeda)).toBe(false);
  });
  it('スタッフは所属店舗のみ', () => {
    expect(canViewRoom(U.staff, R.ebisu)).toBe(true);
    expect(canViewRoom(U.staff, R.umeda)).toBe(false);
  });
});

describe('canViewRoom - DM は非メンバーから見えない', () => {
  it('当事者は見える', () => {
    expect(canViewRoom(U.staff, R.dm)).toBe(true);
    expect(canViewRoom(U.manager, R.dm)).toBe(true);
  });
  it('🔴 root / 本部でも他人のDMは見えない', () => {
    expect(canViewRoom(U.root, R.dm)).toBe(false);
    expect(canViewRoom(U.hq, R.dm)).toBe(false);
  });
  it('無関係のスタッフも見えない', () => {
    expect(canViewRoom(U.other, R.dm)).toBe(false);
  });
  it('別IDで参加している場合も本人と判定する（SSOのID取り違え対策）', () => {
    const me = { ...U.other, altIds: ['u_st'] };
    expect(isRoomMember(me, R.dm)).toBe(true);
    expect(canViewRoom(me, R.dm)).toBe(true);
  });
});

describe('canViewRoom - グループ', () => {
  it('メンバーは見える', () => {
    expect(canViewRoom(U.staff, R.group)).toBe(true);
  });
  it('非メンバーのスタッフは見えない', () => {
    expect(canViewRoom(U.other, R.group)).toBe(false);
  });
  it('root / 本部は運営上の必要から見える（DMとは扱いが違う）', () => {
    expect(canViewRoom(U.root, R.group)).toBe(true);
    expect(canViewRoom(U.hq, R.group)).toBe(true);
  });
  it('オーナーは非メンバーなら見えない（店舗スコープ持ちのため）', () => {
    expect(canViewRoom(U.owner, R.group)).toBe(false);
  });
});

describe('canViewRoom - テナント分離', () => {
  it('別テナントのルームは root でも見えない', () => {
    expect(canViewRoom(U.root, { ...R.announce, tenantId: 'clientx' })).toBe(false);
  });
  it('同じテナントなら見える（大小文字は無視）', () => {
    expect(canViewRoom({ ...U.root, tenantId: 'naoru' }, { ...R.announce, tenantId: 'NAORU' })).toBe(true);
  });
});

describe('canPostRoom - 全社アナウンスは本部/管理者のみ', () => {
  it('root / 本部は投稿できる', () => {
    expect(canPostRoom(U.root, R.announce).allow).toBe(true);
    expect(canPostRoom(U.hq, R.announce).allow).toBe(true);
  });
  it('オーナー・店長・スタッフは投稿できない（読めるが書けない）', () => {
    for (const k of ['owner', 'manager', 'staff']) {
      const d = canPostRoom(U[k], R.announce);
      expect(d.allow, k).toBe(false);
      expect(d.code, k).toBe('announce_hq_only');
    }
  });
});

describe('canPostRoom - その他の規則', () => {
  it('見えないルームへは投稿できない', () => {
    expect(canPostRoom(U.staff, R.umeda).code).toBe('room_not_visible');
  });
  it('アーカイブ済みは読み取り専用', () => {
    expect(canPostRoom(U.staff, R.archived).code).toBe('room_readonly');
  });
  it('🔴 AIエージェントはどのルームにも投稿できない', () => {
    expect(canPostRoom(U.agent, R.ebisu).allow).toBe(false);
    expect(canPostRoom(U.agent, R.announce).allow).toBe(false);
  });
  it('自店の店舗ルームには全ロールが投稿できる', () => {
    for (const k of ['root', 'hq', 'owner', 'manager', 'staff']) {
      expect(canPostRoom(U[k], R.ebisu).allow, k).toBe(true);
    }
  });
  it('ルームが無ければ投稿できない', () => {
    expect(canPostRoom(U.root, null).allow).toBe(false);
  });
});

describe('can() にルームを渡すと種別規則も効く', () => {
  it('スタッフの全社アナウンスへの送信は拒否される', () => {
    const d = can(U.staff, 'chat.send', { shop: '恵比寿', room: R.announce });
    expect(d.allow).toBe(false);
    expect(d.code).toBe('announce_hq_only');
  });
  it('本部の全社アナウンスへの送信は通る', () => {
    expect(can(U.hq, 'chat.send', { room: R.announce }).allow).toBe(true);
  });
  it('ルームを渡さない従来の呼び出しは影響を受けない', () => {
    expect(can(U.staff, 'chat.send', { shop: '恵比寿' }).allow).toBe(true);
  });
});

describe('一括送信しきい値 - 役割別', () => {
  it('推奨初期値のとおり', () => {
    expect(bulkThreshold(U.staff)).toBe(20);
    expect(bulkThreshold(U.manager)).toBe(20);
    expect(bulkThreshold(U.owner)).toBe(50);
    expect(bulkThreshold(U.hq)).toBe(100);
    expect(bulkThreshold(U.root)).toBe(100);
  });
  it('テナント設定で上書きできる', () => {
    const cfg = { bulkThresholds: { staff: 5, owner: 200 } };
    expect(bulkThreshold(U.staff, cfg)).toBe(5);
    expect(bulkThreshold(U.owner, cfg)).toBe(200);
    expect(bulkThreshold(U.root, cfg)).toBe(100);   // 未指定は既定のまま
  });
  it('壊れた設定値は無視して既定に戻す', () => {
    for (const bad of [{ bulkThresholds: { staff: 0 } }, { bulkThresholds: { staff: -1 } }, { bulkThresholds: { staff: 'x' } }, null]) {
      expect(bulkThreshold(U.staff, bad)).toBe(DEFAULT_BULK_THRESHOLDS.staff);
    }
  });
});

describe('confirmLevel - 確認の強さ', () => {
  it('しきい値未満は確認なし', () => {
    expect(confirmLevel('chat.broadcast', { recipientCount: 19 }, U.staff)).toBe('none');
    expect(confirmLevel('chat.broadcast', { recipientCount: 49 }, U.owner)).toBe('none');
  });
  it('しきい値以上は人数を明示した確認', () => {
    expect(confirmLevel('chat.broadcast', { recipientCount: 20 }, U.staff)).toBe('confirm');
    expect(confirmLevel('chat.broadcast', { recipientCount: 50 }, U.owner)).toBe('confirm');
    expect(confirmLevel('chat.broadcast', { recipientCount: 100 }, U.root)).toBe('confirm');
  });
  it('🔴 全社送信は人数に関わらず必ず強い最終確認', () => {
    expect(confirmLevel('chat.broadcast_all', { recipientCount: 1 }, U.root)).toBe('strong');
  });
  it('🔴 全店舗送信も人数に関わらず強い最終確認', () => {
    expect(confirmLevel('chat.broadcast', { recipientCount: 2, allShops: true }, U.root)).toBe('strong');
    expect(confirmLevel('chat.broadcast', { recipientCount: 2, scope: 'all' }, U.root)).toBe('strong');
  });
  it('テナントでしきい値を下げれば早く確認が出る', () => {
    expect(confirmLevel('chat.broadcast', { recipientCount: 6 }, U.root, { bulkThresholds: { root: 5 } })).toBe('confirm');
  });
});

describe('isOrgWideSend', () => {
  it('全社・全店舗を判別する', () => {
    expect(isOrgWideSend('chat.broadcast_all', {})).toBe(true);
    expect(isOrgWideSend('chat.broadcast', { allShops: true })).toBe(true);
    expect(isOrgWideSend('chat.broadcast', { scope: 'all' })).toBe(true);
  });
  it('通常の複数店舗送信は該当しない', () => {
    expect(isOrgWideSend('chat.broadcast', { recipientCount: 300 })).toBe(false);
  });
});

describe('normalizeActor - altIds', () => {
  it('別IDを保持する', () => {
    expect(normalizeActor({ role: 'staff', id: 'a', altIds: ['b', 'c'] }).altIds).toEqual(['b', 'c']);
  });
  it('未指定なら空配列（落ちない）', () => {
    expect(normalizeActor({ role: 'staff' }).altIds).toEqual([]);
  });
  it('空文字は除去する', () => {
    expect(normalizeActor({ role: 'staff', altIds: ['', 'b', null] }).altIds).toEqual(['b']);
  });
});
