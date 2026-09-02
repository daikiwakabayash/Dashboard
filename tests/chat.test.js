import { describe, it, expect } from 'vitest';
import {
  genId, storeRoomId, ANNOUNCE_ROOM_ID, ensureBaseRooms, roomVisibleTo,
  unreadCount, firstUnreadIndex, extractLinks, toggleReaction, groupRooms,
  dmPartnerId, findDmRoom,
} from '../lib/chat.js';

describe('chat: id helpers', () => {
  it('genId is unique-ish and prefixed', () => {
    const a = genId('m'), b = genId('m');
    expect(a).not.toBe(b);
    expect(a.startsWith('m_')).toBe(true);
  });
  it('storeRoomId is deterministic per shop', () => {
    expect(storeRoomId('成増店')).toBe('store_成増店');
    expect(storeRoomId(' 成増店 ')).toBe('store_成増店');
  });
});

describe('chat: ensureBaseRooms', () => {
  it('creates announce + store rooms, preserving existing', () => {
    const rooms = ensureBaseRooms([], [{ name: '成増店' }, { name: '川越店' }]);
    expect(rooms.find(r => r.id === ANNOUNCE_ROOM_ID)).toBeTruthy();
    expect(rooms.find(r => r.id === 'store_成増店')).toBeTruthy();
    expect(rooms.find(r => r.id === 'store_川越店')).toBeTruthy();
  });
  it('does not duplicate on re-run and keeps existing group rooms', () => {
    const first = ensureBaseRooms([{ id: 'g1', kind: 'group', name: '技術委員会', members: ['1'] }], [{ name: '成増店' }]);
    const second = ensureBaseRooms(first, [{ name: '成増店' }]);
    expect(second.filter(r => r.id === 'store_成増店').length).toBe(1);
    expect(second.find(r => r.id === 'g1')).toBeTruthy();
  });
});

describe('chat: roomVisibleTo', () => {
  const announce = { id: ANNOUNCE_ROOM_ID, kind: 'announce' };
  const store = { id: 'store_成増店', kind: 'store', shop: '成増店', name: '成増店', members: [] };
  const group = { id: 'g1', kind: 'group', members: ['1', '2'] };
  const dm = { id: 'd1', kind: 'dm', members: ['1', '9'] };
  it('announce is visible to everyone', () => {
    expect(roomVisibleTo(announce, { staffId: '5', shops: [] })).toBe(true);
  });
  it('store visible to root, matching shop, or explicit member', () => {
    expect(roomVisibleTo(store, { root: true })).toBe(true);
    expect(roomVisibleTo(store, { staffId: '3', shops: ['成増'] })).toBe(true);
    expect(roomVisibleTo(store, { staffId: '3', shops: ['川越'] })).toBe(false);
    expect(roomVisibleTo({ ...store, members: ['3'] }, { staffId: '3', shops: ['川越'] })).toBe(true);
  });
  it('group/dm visible only to members (even root cannot see non-member DM)', () => {
    expect(roomVisibleTo(group, { staffId: '2' })).toBe(true);
    expect(roomVisibleTo(group, { staffId: '8' })).toBe(false);
    expect(roomVisibleTo(dm, { staffId: '8', root: true })).toBe(false);
    expect(roomVisibleTo(dm, { staffId: '9' })).toBe(true);
  });
});

describe('chat: unread', () => {
  const msgs = [
    { id: 'a', fromStaffId: '2', createdAt: '2026-09-01T00:00:00Z' },
    { id: 'b', fromStaffId: '5', createdAt: '2026-09-01T01:00:00Z' }, // mine
    { id: 'c', fromStaffId: '2', createdAt: '2026-09-01T02:00:00Z' },
  ];
  it('counts only others messages after lastRead', () => {
    const last = Date.parse('2026-09-01T00:30:00Z');
    expect(unreadCount(msgs, last, '5')).toBe(1); // only c (b is mine)
  });
  it('firstUnreadIndex points at first unread others message', () => {
    const last = Date.parse('2026-09-01T00:30:00Z');
    expect(firstUnreadIndex(msgs, last, '5')).toBe(2);
    expect(firstUnreadIndex(msgs, Date.parse('2026-09-01T05:00:00Z'), '5')).toBe(-1);
  });
});

describe('chat: extractLinks', () => {
  it('extracts urls, dedups, strips trailing punctuation', () => {
    expect(extractLinks('見て https://example.com/a 。あと https://example.com/a も')).toEqual(['https://example.com/a']);
    expect(extractLinks('なし')).toEqual([]);
  });
});

describe('chat: toggleReaction', () => {
  it('adds then removes a reaction per user', () => {
    let r = toggleReaction({}, '👍', '3');
    expect(r['👍']).toEqual(['3']);
    r = toggleReaction(r, '👍', '4');
    expect(r['👍']).toEqual(['3', '4']);
    r = toggleReaction(r, '👍', '3');
    expect(r['👍']).toEqual(['4']);
    r = toggleReaction(r, '👍', '4');
    expect(r['👍']).toBeUndefined(); // emptied → key removed
  });
});

describe('chat: groupRooms / dm helpers', () => {
  const rooms = [
    { id: ANNOUNCE_ROOM_ID, kind: 'announce' },
    { id: 'store_a', kind: 'store' },
    { id: 'g1', kind: 'group' },
    { id: 'd1', kind: 'dm', members: ['1', '9'] },
  ];
  it('groups by kind and sorts by last message time', () => {
    const g = groupRooms([{ id: 'x', kind: 'store' }, { id: 'y', kind: 'store' }], r => (r.id === 'y' ? 100 : 1));
    expect(g.store.map(r => r.id)).toEqual(['y', 'x']);
  });
  it('dmPartnerId returns the other member', () => {
    expect(dmPartnerId(rooms[3], '1')).toBe('9');
  });
  it('findDmRoom finds an existing 1:1 room', () => {
    expect(findDmRoom(rooms, '9', '1').id).toBe('d1');
    expect(findDmRoom(rooms, '9', '2')).toBeNull();
  });
});
