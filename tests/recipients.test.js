import { describe, it, expect } from 'vitest';
import { normalize, matchKey, parseRecipientText, resolveRecipients,
         recipientLabel, canSend, splitSoft } from '../lib/recipients.js';

// 架空のスタッフ（氏名は実在の人物ではありません）
const STAFF = [
  { id: 'w1', name: '若林大樹', shop: '本部' },
  { id: 's1', name: '佐藤健一', shop: '本部' },
  { id: 's2', name: '佐藤美咲', shop: 'NAORU 新宿院' },
  { id: 'y1', name: '八代ゆかり', shop: 'NAORU 鶴見院' },
  { id: 'r1', name: '中村怜', shop: 'NAORU 関内院' },
  { id: 't1', name: '小林透子', shop: 'NAORU 鶴見院' },
  { id: 'd1', name: '田中翔', shop: 'NAORU 新宿院' },
  { id: 'd2', name: '田中彩', shop: 'NAORU 大阪京橋院' },
  { id: 'k1', name: '木下ゆう', shop: 'NAORU 博多院' },
];
const SHOPS = ['本部', 'NAORU 新宿院', 'NAORU 鶴見院', 'NAORU 関内院', 'NAORU 大阪京橋院', 'NAORU 博多院'];
const CTX = { staff: STAFF, shops: SHOPS };
const ids = (r) => r.people.map(p => p.id).sort();

describe('文字の揃え方', () => {
  it('全角英数と空白をそろえる', () => {
    expect(normalize('ＮＡＯＲＵ　鶴見院')).toBe('NAORU 鶴見院');
  });
  it('店舗の飾りと敬称を落として照合する', () => {
    expect(matchKey('NAORU 鶴見院')).toBe('鶴見');
    expect(matchKey('佐藤さん')).toBe('佐藤');
    expect(matchKey(' 本部 ')).toBe('本部');
  });
});

describe('「鶴見と関内に以下の文章を送ってほしい」', () => {
  const r = resolveRecipients('鶴見と関内に以下の文章を送ってほしい', CTX);
  it('鶴見と関内の在籍者だけになる', () => {
    expect(ids(r)).toEqual(['r1', 't1', 'y1']);
  });
  it('「に送ってほしい」を名前として拾わない', () => {
    expect(r.unknown).toEqual([]);
  });
  it('どの言葉が誰に当たったかが分かる', () => {
    expect(r.groups.map(g => g.label)).toEqual(['NAORU 鶴見院', 'NAORU 関内院']);
    expect(r.groups.every(g => g.kind === 'shop')).toBe(true);
  });
  it('そのまま送れる', () => {
    expect(canSend(r)).toEqual({ ok: true });
    expect(recipientLabel(r)).toBe('NAORU 鶴見院・NAORU 関内院（3名）');
  });
});

describe('「若林と佐藤（本部の佐藤）、あと八代、怜、透子、田中（新宿の田中）」', () => {
  const r = resolveRecipients('若林と佐藤（本部の佐藤）、あと八代、怜、透子、田中（新宿の田中）', CTX);

  it('補足で同姓を絞り込める（本部の佐藤／新宿の田中）', () => {
    expect(ids(r)).toContain('s1');      // 佐藤健一（本部）
    expect(ids(r)).not.toContain('s2');  // 佐藤美咲（新宿）は入らない
    expect(ids(r)).toContain('d1');      // 田中翔（新宿）
    expect(ids(r)).not.toContain('d2');  // 田中彩（大阪）は入らない
  });
  it('苗字だけ・下の名前だけでも当たる', () => {
    expect(ids(r)).toContain('w1');   // 若林
    expect(ids(r)).toContain('y1');   // 八代
    expect(ids(r)).toContain('r1');   // 怜（中村怜）
    expect(ids(r)).toContain('t1');   // 透子（小林透子）
  });
  it('6名ちょうど、取りこぼしも余りもない', () => {
    expect(r.total).toBe(6);
    expect(r.unknown).toEqual([]);
    expect(r.ambiguous).toEqual([]);
  });
});

describe('曖昧なものは勝手に決めない', () => {
  it('「佐藤」だけだと2人の候補として返し、宛先には入れない', () => {
    const r = resolveRecipients('佐藤', CTX);
    expect(r.people).toEqual([]);
    expect(r.ambiguous).toHaveLength(1);
    expect(r.ambiguous[0].candidates.map(c => c.id).sort()).toEqual(['s1', 's2']);
    expect(canSend(r)).toEqual({ ok: false, reason: 'ambiguous' });
  });
  it('候補には所属も付く（どちらの佐藤か選べる）', () => {
    const r = resolveRecipients('佐藤', CTX);
    expect(r.ambiguous[0].candidates.map(c => c.shop).sort()).toEqual(['NAORU 新宿院', '本部']);
  });
  it('曖昧な人がいると、他が当たっていても送れない', () => {
    const r = resolveRecipients('若林、佐藤', CTX);
    expect(ids(r)).toEqual(['w1']);
    expect(canSend(r).ok).toBe(false);
  });
});

describe('見つからない言葉を黙って捨てない', () => {
  it('在籍しない名前は unknown に出る', () => {
    const r = resolveRecipients('若林、山田太郎', CTX);
    expect(r.unknown).toEqual(['山田太郎']);
    expect(canSend(r)).toEqual({ ok: false, reason: 'unknown' });
  });
  it('誰も当たらなければ送れない', () => {
    expect(canSend(resolveRecipients('だれか', CTX))).toEqual({ ok: false, reason: 'unknown' });
    expect(canSend(resolveRecipients('', CTX))).toEqual({ ok: false, reason: 'no_recipients' });
  });
  it('在籍者がいない店舗名も unknown 扱い（0名に送ったことにしない）', () => {
    const r = resolveRecipients('博多', { staff: STAFF.filter(p => p.id !== 'k1'), shops: SHOPS });
    expect(r.unknown).toEqual(['博多']);
    expect(r.people).toEqual([]);
  });
});

describe('エリアの言葉も使える', () => {
  it('「神奈川」で鶴見・関内の人が入る', () => {
    expect(ids(resolveRecipients('神奈川', CTX))).toEqual(['r1', 't1', 'y1']);
  });
  it('「神奈川県」でも同じ', () => {
    expect(ids(resolveRecipients('神奈川県', CTX))).toEqual(['r1', 't1', 'y1']);
  });
  it('「関東」でまとめて指定できる', () => {
    expect(ids(resolveRecipients('関東', CTX))).toEqual(['d1', 'r1', 's2', 't1', 'y1']);
  });
});

describe('やりたいこと（グループか個別か）を読み取る', () => {
  it('「グループを組んで」でグループ', () => {
    expect(parseRecipientText('若林と八代でグループを組んで').intent).toBe('group');
    expect(resolveRecipients('鶴見と関内でグループを作って', CTX).intent).toBe('group');
  });
  it('「一人ずつ」「DM」で個別', () => {
    expect(parseRecipientText('若林と八代に一人ずつ送って').intent).toBe('dm');
    expect(parseRecipientText('若林にDMして').intent).toBe('dm');
  });
  it('指定がなければ null（画面の既定に任せる）', () => {
    expect(parseRecipientText('若林、八代').intent).toBe(null);
  });
  it('「グループを組んで」の文字を宛先として拾わない', () => {
    const r = resolveRecipients('鶴見と関内でグループを組んで', CTX);
    expect(r.unknown).toEqual([]);
    expect(ids(r)).toEqual(['r1', 't1', 'y1']);
  });
});

describe('同じ人を二重に入れない', () => {
  it('店舗と個人で重なっても1回だけ', () => {
    const r = resolveRecipients('鶴見と八代', CTX);
    expect(ids(r)).toEqual(['t1', 'y1']);       // 八代は鶴見所属。重複しない
    expect(r.total).toBe(2);
  });
  it('同じ言葉を2回書いても増えない', () => {
    expect(resolveRecipients('鶴見、鶴見', CTX).total).toBe(2);
  });
});

describe('書き方の揺れ', () => {
  it('読点・中黒・スラッシュ・全角空白で区切れる', () => {
    for (const t of ['若林、八代', '若林・八代', '若林/八代', '若林　八代', '若林と八代']) {
      expect(ids(resolveRecipients(t, CTX))).toEqual(['w1', 'y1']);
    }
  });
  it('敬称が付いていても当たる', () => {
    expect(ids(resolveRecipients('若林さん、八代さん', CTX))).toEqual(['w1', 'y1']);
  });
  it('「NAORU 鶴見院」とフルで書いても当たる', () => {
    expect(ids(resolveRecipients('NAORU 鶴見院', CTX))).toEqual(['t1', 'y1']);
  });
  it('「本部の佐藤」形式（かっこ無し）でも絞れる', () => {
    expect(ids(resolveRecipients('本部の佐藤', CTX))).toEqual(['s1']);
  });
});

describe('壊れた入力でも落ちない', () => {
  it('null / 空 / スタッフ無し', () => {
    expect(resolveRecipients(null, CTX).people).toEqual([]);
    expect(resolveRecipients('若林', {}).people).toEqual([]);
    expect(resolveRecipients('若林', null).people).toEqual([]);
    expect(recipientLabel(null)).toBe('');
    expect(splitSoft(null)).toEqual([]);
  });
  it('idの無い行は数えない', () => {
    expect(resolveRecipients('若林', { staff: [{ name: '若林大樹', shop: '本部' }] }).people).toEqual([]);
  });
});
