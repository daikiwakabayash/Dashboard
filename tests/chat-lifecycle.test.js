import { describe, it, expect } from 'vitest';
import {
  planStoreRooms, syncStoreMembers, shouldArchiveEventRoom, archiveRoom, unarchiveRoom,
  visibleRooms, canArchive, eventRoomId, EVENT_ARCHIVE_GRACE_DAYS,
} from '../lib/chat-lifecycle.js';
import { storeRoomId, ANNOUNCE_ROOM_ID } from '../lib/chat.js';

const SHOPS = [{ id: 'sh1', name: '恵比寿' }, { id: 'sh2', name: '渋谷' }];

describe('planStoreRooms - 店舗が増えたら自動でルームを作る', () => {
  it('新店舗ぶんだけ作成される', () => {
    const p = planStoreRooms([], SHOPS);
    expect(p.create.map(r => r.id)).toEqual([storeRoomId('恵比寿'), storeRoomId('渋谷')]);
  });
  it('既にあるルームは作り直さない', () => {
    const rooms = [{ id: storeRoomId('恵比寿'), kind: 'store', name: '恵比寿', shop: '恵比寿' }];
    const p = planStoreRooms(rooms, SHOPS);
    expect(p.create.map(r => r.id)).toEqual([storeRoomId('渋谷')]);
  });
  it('店舗名が変わったら名前だけ直す（ルームは作り直さない＝履歴を切らない）', () => {
    const rooms = [{ id: storeRoomId('恵比寿'), kind: 'store', name: '旧・恵比寿', shop: '恵比寿' }];
    const p = planStoreRooms(rooms, [{ id: 'sh1', name: '恵比寿' }]);
    expect(p.rename).toEqual([{ id: storeRoomId('恵比寿'), from: '旧・恵比寿', to: '恵比寿' }]);
    expect(p.create).toHaveLength(0);
  });
  it('店舗一覧から消えたら畳む（消さない）', () => {
    const rooms = [
      { id: storeRoomId('恵比寿'), kind: 'store', name: '恵比寿', shop: '恵比寿' },
      { id: storeRoomId('閉店A'), kind: 'store', name: '閉店A', shop: '閉店A' },
    ];
    const p = planStoreRooms(rooms, [{ id: 'sh1', name: '恵比寿' }]);
    expect(p.archive).toEqual([{ id: storeRoomId('閉店A'), reason: 'shop_removed' }]);
  });
  it('🔴 店舗一覧が空（APIの失敗）のとき、全店を畳まない', () => {
    const rooms = [{ id: storeRoomId('恵比寿'), kind: 'store', name: '恵比寿', shop: '恵比寿' }];
    const p = planStoreRooms(rooms, []);
    expect(p.archive).toHaveLength(0);
    expect(p.skippedArchive).toBe(true);
  });
  it('既に畳んだルームを二重に畳まない', () => {
    const rooms = [{ id: storeRoomId('閉店A'), kind: 'store', name: '閉店A', shop: '閉店A', archived: true }];
    expect(planStoreRooms(rooms, SHOPS).archive).toHaveLength(0);
  });
  it('店舗以外のルーム（グループ・DM）は触らない', () => {
    const rooms = [{ id: 'g1', kind: 'group', name: '部活', members: ['a'] }, { id: 'd1', kind: 'dm', members: ['a', 'b'] }];
    const p = planStoreRooms(rooms, SHOPS);
    expect(p.archive).toHaveLength(0);
  });
  it('壊れた入力でも落ちない', () => {
    expect(() => planStoreRooms(null, null)).not.toThrow();
    expect(planStoreRooms(null, [{ name: '' }]).create).toHaveLength(0);
  });
});

describe('syncStoreMembers - 配属が変わったら在籍者も変わる', () => {
  const room = { id: storeRoomId('恵比寿'), kind: 'store', shop: '恵比寿', members: ['st1'] };
  const staff = [{ id: 'st1', shop: '恵比寿' }, { id: 'st2', shop: '恵比寿' }, { id: 'st3', shop: '渋谷' }];

  it('新しく配属された人が入る', () => {
    const r = syncStoreMembers(room, staff);
    expect(r.add).toEqual(['st2']);
    expect(r.members.sort()).toEqual(['st1', 'st2']);
  });
  it('配属から外れた人は出る', () => {
    const r = syncStoreMembers({ ...room, members: ['st1', 'st3'] }, staff);
    expect(r.remove).toEqual(['st3']);
  });
  it('手で入れた人（本部・エリア長）は自動で外さない', () => {
    const r = syncStoreMembers({ ...room, members: ['st1', 'u_hq'], pinnedMembers: ['u_hq'] }, staff);
    expect(r.remove).not.toContain('u_hq');
    expect(r.members).toContain('u_hq');
  });
  it('autoRemove:false なら誰も外さない（移行期間の安全弁）', () => {
    const r = syncStoreMembers({ ...room, members: ['st1', 'st3'] }, staff, { autoRemove: false });
    expect(r.remove).toHaveLength(0);
  });
  it('変更が無ければ changed:false', () => {
    expect(syncStoreMembers({ ...room, members: ['st1', 'st2'] }, staff).changed).toBe(false);
  });
  it('在籍情報が空でも落ちない', () => {
    expect(() => syncStoreMembers(room, null)).not.toThrow();
  });
});

describe('shouldArchiveEventRoom - 終わったイベントは静かに畳む', () => {
  const room = { id: eventRoomId('e1'), kind: 'group' };
  const day = 86400000;
  const end = Date.parse('2026-09-01T00:00:00Z');

  it('終了直後は畳まない（振り返りの投稿が入るため）', () => {
    expect(shouldArchiveEventRoom(room, { endAt: '2026-09-01T00:00:00Z' }, end + day)).toBe(false);
  });
  it('猶予を過ぎたら畳む', () => {
    expect(shouldArchiveEventRoom(room, { endAt: '2026-09-01T00:00:00Z' }, end + (EVENT_ARCHIVE_GRACE_DAYS + 1) * day)).toBe(true);
  });
  it('日付が読めないイベント（未定・毎週）は畳まない', () => {
    expect(shouldArchiveEventRoom(room, { date: '毎週火曜' }, Date.now())).toBe(false);
    expect(shouldArchiveEventRoom(room, {}, Date.now())).toBe(false);
  });
  it('既に畳んであれば false', () => {
    expect(shouldArchiveEventRoom({ ...room, archived: true }, { endAt: '2020-01-01T00:00:00Z' }, Date.now())).toBe(false);
  });
  it('ルームごとに猶予日数を上書きできる', () => {
    expect(shouldArchiveEventRoom({ ...room, graceDays: 1 }, { endAt: '2026-09-01T00:00:00Z' }, end + 2 * day)).toBe(true);
  });
});

describe('archiveRoom / unarchiveRoom - 消さずに畳む', () => {
  it('理由と時刻が残る', () => {
    const r = archiveRoom({ id: 'g1' }, 'event_ended', '2026-09-10T00:00:00Z');
    expect(r.archived).toBe(true);
    expect(r.archivedReason).toBe('event_ended');
    expect(r.archivedAt).toBe('2026-09-10T00:00:00Z');
  });
  it('元のルームを書き換えない（純粋関数）', () => {
    const src = { id: 'g1' };
    archiveRoom(src, 'x');
    expect(src.archived).toBeUndefined();
  });
  it('二重に畳んでも時刻が上書きされない', () => {
    const once = archiveRoom({ id: 'g1' }, 'a', '2026-09-01T00:00:00Z');
    expect(archiveRoom(once, 'b', '2026-09-09T00:00:00Z').archivedAt).toBe('2026-09-01T00:00:00Z');
  });
  it('戻せる', () => {
    const r = unarchiveRoom(archiveRoom({ id: 'g1' }, 'x'));
    expect(r.archived).toBeUndefined();
    expect(r.archivedReason).toBeUndefined();
  });
});

describe('visibleRooms / canArchive', () => {
  const rooms = [{ id: 'a' }, { id: 'b', archived: true }];
  it('既定では畳んだルームを隠す', () => {
    expect(visibleRooms(rooms).map(r => r.id)).toEqual(['a']);
  });
  it('求められれば出す', () => {
    expect(visibleRooms(rooms, { includeArchived: true })).toHaveLength(2);
  });
  it('全社アナウンスは畳めない', () => {
    expect(canArchive({ id: ANNOUNCE_ROOM_ID, kind: 'announce' }).ok).toBe(false);
  });
  it('店舗ルームは手動では畳めない（店舗一覧の変更でのみ）', () => {
    expect(canArchive({ id: storeRoomId('恵比寿'), kind: 'store' }).ok).toBe(false);
  });
  it('グループ・イベントは畳める', () => {
    expect(canArchive({ id: 'g1', kind: 'group' }).ok).toBe(true);
  });
});
