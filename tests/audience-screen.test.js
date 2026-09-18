import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PREF_NAMES, areaOf, selectAudience, unreadStaff } from '../lib/audience.js';

// ⚠️ これは **index.html の記述チェック**（HTMLの文字列を読んでいるだけ）です。
//    実際の表示・クリックの確認は scripts/audience-screen-check.mjs（実ブラウザ）で別に行います。
const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf-8');

describe('画面側の判定が lib/audience.js とずれていない', () => {
  it('都道府県名の対応表が同じ（片方だけ直して食い違うのを防ぐ）', () => {
    const m = html.match(/const AUD_PREF_NAMES = (\{[^;]*?\});/);
    expect(m).toBeTruthy();
    // eslint-disable-next-line no-new-func
    const inline = new Function(`return ${m[1]}`)();
    for (const [k, v] of Object.entries(PREF_NAMES)) expect(inline[k]).toBe(v);
    expect(Object.keys(inline).length).toBe(Object.keys(PREF_NAMES).length);
  });

  it('組織図の地名表と同じ土台を使っている（3つ目の対応表を作らない）', () => {
    expect(html).toContain('const audAreaOf = (shopName) => { const rank = orgGeoRank(shopName);');
  });
});

describe('画面に絞り込みの部品がある', () => {
  it('「エリアでまとめて選ぶ」の枠がある', () => {
    expect(html).toContain('エリアでまとめて選ぶ');
  });
  it('「選んだエリア以外に送る」が選べる（大阪以外に送る）', () => {
    expect(html).toContain('選んだエリア以外に送る');
    expect(html).toContain('data-aud-exclude');
  });
  it('都道府県と地域のボタンが人数つきで出る', () => {
    expect(html).toContain('data-aud-pref');
    expect(html).toContain('data-aud-region');
    expect(html).toMatch(/\{o\.key\} \{o\.count\}名/);
  });
  it('送る前に対象者の氏名が出る（黙って外れる人を作らない）', () => {
    expect(html).toContain('data-aud-preview');
    expect(html).toMatch(/hit\.slice\(0, 8\)\.map\(p => p\.name\)/);
  });
  it('「この◯名をメンバーに入れる」で反映できる', () => {
    expect(html).toContain('data-aud-apply');
    expect(html).toContain('この{hit.length}名をメンバーに入れる');
  });
});

describe('画面に「未読の人にもう一度送る」がある', () => {
  it('自分の投稿のメニューに出る', () => {
    expect(html).toContain('data-remind-unread');
    expect(html).toContain('未読の{un.length}名にもう一度送る');
  });
  it('送る前に人数と氏名を確認する', () => {
    expect(html).toContain('まだ読めていない ${ids.length}名');
  });
  it('未読の人を@メンションする（通知が確実に届く）', () => {
    expect(html).toContain("mentions.map(x => '@' + x.name)");
  });
  it('同じルームに送る（送るたびにルームを増やさない）', () => {
    expect(html).toMatch(/const roomId = chatRoomId;\s*\n\s*const mentions = ids\.map/);
  });
});

// lib 側の振る舞いを、ユーザーの言葉のまま1回だけ確かめる（詳細は tests/audience.test.js）
describe('依頼された使い方がそのまま通る', () => {
  const staff = [
    { id: 'a', name: '青木', shop: 'NAORU 関内院' },
    { id: 'b', name: '石田', shop: 'NAORU 溝の口院' },
    { id: 'c', name: '江川', shop: 'NAORU 渋谷院' },
    { id: 'd', name: '大西', shop: 'NAORU 江坂院' },
  ];
  it('「神奈川のエリアに送る」', () => {
    expect(selectAudience(staff, { prefs: ['神奈川県'] }).map(p => p.name).sort()).toEqual(['石田', '青木']);
  });
  it('「大阪以外に送る」', () => {
    expect(selectAudience(staff, { prefs: ['大阪府'], exclude: true }).map(p => p.id).sort()).toEqual(['a', 'b', 'c']);
  });
  it('「送信後にまだ既読がついていない人に送る」', () => {
    const T = Date.parse('2026-09-18T10:00:00Z');
    const reads = { a: { r: T + 1 }, c: { r: T + 1 } };
    expect(unreadStaff(staff, reads, 'r', T, []).map(p => p.id)).toEqual(['b', 'd']);
  });
  it('地名が読み取れない店舗は勝手に他県へ混ぜない', () => {
    expect(areaOf('NAORU 本院').pref).toBe('エリア未設定');
  });
});
