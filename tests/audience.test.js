import { describe, it, expect } from 'vitest';
import { PREF_NAMES, areaOf, isEmptyFilter, matchesFilter, selectAudience,
         audienceOptions, audienceLabel, audienceRoomId, unreadStaff, readSummary } from '../lib/audience.js';

// 実在の店舗名に寄せたテスト用スタッフ（氏名は架空）
const STAFF = [
  { id: 's1', name: '青木', shop: 'NAORU 関内院' },        // 神奈川
  { id: 's2', name: '石田', shop: 'NAORU 武蔵小杉院' },     // 神奈川
  { id: 's3', name: '上野', shop: 'NAORU 溝の口院' },       // 神奈川
  { id: 's4', name: '江川', shop: 'NAORU 渋谷院' },         // 東京
  { id: 's5', name: '大西', shop: 'NAORU 大阪京橋院' },     // 大阪
  { id: 's6', name: '加藤', shop: 'NAORU 江坂院' },         // 大阪
  { id: 's7', name: '木下', shop: 'NAORU 博多院' },         // 福岡
  { id: 's8', name: '工藤', shop: '' },                     // 所属なし
];

describe('店舗名から都道府県・地域を出す', () => {
  it('神奈川の店舗は神奈川県・関東になる', () => {
    expect(areaOf('NAORU 関内院')).toMatchObject({ pref: '神奈川県', region: '関東' });
    expect(areaOf('NAORU 武蔵小杉院').pref).toBe('神奈川県');
    expect(areaOf('上溝院').pref).toBe('神奈川県');
  });
  it('大阪・福岡・沖縄も出る', () => {
    expect(areaOf('NAORU 江坂院').pref).toBe('大阪府');
    expect(areaOf('NAORU 博多院').pref).toBe('福岡県');
    expect(areaOf('NAORU 浦添院').pref).toBe('沖縄県');
  });
  it('地名が読み取れない店舗は「エリア未設定」（黙って他県に混ぜない）', () => {
    expect(areaOf('').pref).toBe('エリア未設定');
    expect(areaOf('NAORU 本院').pref).toBe('エリア未設定');
  });
  it('47都道府県すべてに名前がある', () => {
    for (let i = 1; i <= 47; i++) expect(typeof PREF_NAMES[i]).toBe('string');
  });
});

describe('「神奈川のエリアに送る」', () => {
  it('神奈川県の3名だけになる', () => {
    const got = selectAudience(STAFF, { prefs: ['神奈川県'] });
    expect(got.map(p => p.name)).toEqual(['上野', '青木', '石田']);   // 同県内は氏名順（漢字の並び）
  });
  it('地域（関東）だと東京も入る', () => {
    const got = selectAudience(STAFF, { regions: ['関東'] });
    expect(got.map(p => p.name).sort()).toEqual(['上野', '石田', '江川', '青木'].sort());
  });
  it('店舗名は表記ゆれがあっても当たる（「関内院」で「NAORU 関内院」に届く）', () => {
    expect(selectAudience(STAFF, { shops: ['関内院'] }).map(p => p.name)).toEqual(['青木']);
  });
  it('複数の条件はどれかに当たれば対象（神奈川＋福岡）', () => {
    const got = selectAudience(STAFF, { prefs: ['神奈川県', '福岡県'] });
    expect(got.map(p => p.name)).toEqual(['上野', '青木', '石田', '木下']);   // 神奈川3名が先、そのあと福岡
  });
});

describe('「大阪以外に送る」（exclude）', () => {
  it('大阪の2名だけが外れる', () => {
    const got = selectAudience(STAFF, { prefs: ['大阪府'], exclude: true });
    expect(got.map(p => p.name)).not.toContain('大西');
    expect(got.map(p => p.name)).not.toContain('加藤');
    expect(got).toHaveLength(6);
  });
  it('所属なしの人は「大阪以外」に**含まれる**（意図せず落とさない）', () => {
    expect(selectAudience(STAFF, { prefs: ['大阪府'], exclude: true }).map(p => p.id)).toContain('s8');
  });
  it('条件が空のまま「以外」にしても0人にはしない（全員のまま）', () => {
    expect(selectAudience(STAFF, { exclude: true })).toHaveLength(8);
  });
});

describe('選択肢（人数つき）', () => {
  const opt = audienceOptions(STAFF);
  it('都道府県が北→南の順に、人数つきで出る', () => {
    expect(opt.prefs.map(o => `${o.label}:${o.count}`)).toEqual(
      ['東京都:1', '神奈川県:3', '大阪府:2', '福岡県:1', 'エリア未設定:1']);
  });
  it('地域でもまとまる', () => {
    const kanto = opt.regions.find(o => o.key === '関東');
    expect(kanto.count).toBe(4);
  });
  it('店舗も人数つきで出る（所属なしは店舗に出さない）', () => {
    expect(opt.shops.every(o => o.key !== '')).toBe(true);
    expect(opt.shops.find(o => o.key === 'NAORU 関内院').count).toBe(1);
  });
});

describe('条件の見せ方と送り先ルーム', () => {
  it('画面に出す言葉が条件そのままになる', () => {
    expect(audienceLabel({ prefs: ['神奈川県'] })).toBe('神奈川県');
    expect(audienceLabel({ prefs: ['大阪府'], exclude: true })).toBe('大阪府 以外');
    expect(audienceLabel({})).toBe('全員');
  });
  it('同じ条件は同じルームに送る（送るたびにルームが増えない）', () => {
    const a = audienceRoomId({ prefs: ['神奈川県', '福岡県'] });
    const b = audienceRoomId({ prefs: ['福岡県', '神奈川県'] });   // 並び順が違うだけ
    expect(a).toBe(b);
  });
  it('「神奈川」と「神奈川以外」は別のルーム', () => {
    expect(audienceRoomId({ prefs: ['神奈川県'] })).not.toBe(audienceRoomId({ prefs: ['神奈川県'], exclude: true }));
  });
  it('条件なしは全社アナウンスのまま', () => {
    expect(audienceRoomId({})).toBe('announce_all');
  });
});

describe('「まだ既読がついていない人」', () => {
  const T = Date.parse('2026-09-18T10:00:00Z');
  const reads = {
    s1: { r1: T + 60000 },        // 投稿より後に読んだ＝既読
    s2: { r1: T - 60000 },        // 投稿より前＝未読
    s3: { r2: T + 60000 },        // 別のルームしか読んでいない＝このルームは未読
    // s4 は reads そのものが無い＝未読
  };
  const people = STAFF.slice(0, 4);

  it('既読の人は外れる', () => {
    const got = unreadStaff(people, reads, 'r1', T, []);
    expect(got.map(p => p.id)).toEqual(['s2', 's3', 's4']);
  });
  it('送った本人は数えない', () => {
    const got = unreadStaff(people, reads, 'r1', T, ['s4']);
    expect(got.map(p => p.id)).toEqual(['s2', 's3']);
  });
  it('既読の集計が出る（◯名中◯名が未読）', () => {
    const s = readSummary(people, reads, 'r1', T, ['s4']);
    expect(s).toMatchObject({ total: 3, unread: 2, read: 1 });
    expect(s.unreadPeople.map(p => p.name)).toEqual(['石田', '上野']);   // 未読は元の並びのまま
  });
  it('誰も読んでいなければ全員が未読', () => {
    expect(unreadStaff(people, {}, 'r1', T, []).length).toBe(4);
  });
  it('reads が壊れていても落ちない', () => {
    expect(unreadStaff(people, null, 'r1', T, []).length).toBe(4);
    expect(unreadStaff(null, reads, 'r1', T, []).length).toBe(0);
  });
});

describe('絞り込みと未読を組み合わせる', () => {
  it('神奈川の人のうち、まだ読んでいない人だけを出せる', () => {
    const T = Date.parse('2026-09-18T10:00:00Z');
    const kanagawa = selectAudience(STAFF, { prefs: ['神奈川県'] });
    const reads = { s1: { aud_x: T + 1000 } };              // 青木だけ既読
    const got = unreadStaff(kanagawa, reads, 'aud_x', T, []);
    expect(got.map(p => p.name)).toEqual(['上野', '石田']);
  });
});

describe('入力が壊れていても落ちない', () => {
  it('staff が配列でない / id が無い行は静かに捨てる', () => {
    expect(selectAudience(null, {})).toEqual([]);
    expect(selectAudience([{ name: 'id無し' }, null, { id: 's1', name: '青木', shop: '' }], {})).toHaveLength(1);
  });
  it('filter が null でも全員を返す', () => {
    expect(selectAudience(STAFF, null)).toHaveLength(8);
    expect(isEmptyFilter(null)).toBe(true);
    expect(matchesFilter({ shop: 'NAORU 関内院' }, null)).toBe(true);
  });
});
