import { describe, it, expect } from 'vitest';
import {
  normName, matchCandidates, resolveNames, normalizeSpec, actionForSpec,
  resolveRecipients, describeRecipients, BULK_CONFIRM_THRESHOLD,
} from '../lib/chat-recipients.js';

// 全社ディレクトリ（store_id / staff_id が真実。名前は検索語にすぎない）
const DIR = {
  shops: [
    { id: 'sh_ebisu',    name: 'NAORU整骨院 恵比寿',     area: '東京' },
    { id: 'sh_ebisu_w',  name: 'NAORU整骨院 恵比寿西口', area: '東京' },
    { id: 'sh_shibuya',  name: 'NAORU整骨院 渋谷',       area: '東京' },
    { id: 'sh_osaka',    name: 'NAORU整骨院 梅田',       area: '大阪' },
  ],
  staff: [
    { id: 'st_1', name: '田中 太郎', shop: 'NAORU整骨院 恵比寿',   role: 'staff' },
    { id: 'st_2', name: '田中 花子', shop: 'NAORU整骨院 渋谷',     role: 'staff' },
    { id: 'st_3', name: '佐藤 一郎', shop: 'NAORU整骨院 恵比寿',   role: 'manager' },
    { id: 'st_4', name: '鈴木 次郎', shop: 'NAORU整骨院 梅田',     role: 'owner' },
  ],
};
const ROOT    = { id: 'u_root',  name: '管理者',     role: 'root',    source: 'ui', verified: true, shops: null };
const ADMIN   = { id: 'u_hq',    name: '本部 若林',  role: 'admin',   source: 'ui', verified: true, shops: null };
const OWNER   = { id: 'u_own',   name: 'オーナーA',  role: 'owner',   source: 'ui', verified: true, shops: ['NAORU整骨院 恵比寿', 'NAORU整骨院 渋谷'] };
const STAFF   = { id: 'u_st',    name: 'セラピストC', role: 'staff',  source: 'ui', verified: true, shops: ['NAORU整骨院 恵比寿'] };
const AI      = { id: 'a_chat',  name: 'AIアシスタント', role: 'root', source: 'agent', verified: true, shops: null };
const ctx = (actor, extra = {}) => ({ dir: DIR, actor, ...extra });

describe('normName - 表記ゆれの吸収', () => {
  it('全角・空白・店/店舗の接尾辞を無視する', () => {
    expect(normName('恵比寿店')).toBe(normName('恵比寿'));
    expect(normName('恵比寿 店舗')).toBe(normName('恵比寿'));
    expect(normName('ＮＡＯＲＵ')).toBe(normName('naoru'));
  });
  it('null / undefined / 数値でも落ちない', () => {
    expect(normName(null)).toBe('');
    expect(normName(undefined)).toBe('');
    expect(normName(123)).toBe('123');
  });
});

describe('matchCandidates - 完全一致を部分一致より優先', () => {
  it('「恵比寿」は恵比寿西口に吸われない', () => {
    const c = matchCandidates('NAORU整骨院 恵比寿', DIR.shops);
    expect(c).toHaveLength(1);
    expect(c[0].id).toBe('sh_ebisu');
  });
  it('部分一致が複数あればすべて返す（推測して1件に絞らない）', () => {
    expect(matchCandidates('恵比寿', DIR.shops).length).toBe(2);
  });
  it('空の検索語は候補なし', () => {
    expect(matchCandidates('', DIR.shops)).toHaveLength(0);
    expect(matchCandidates('   ', DIR.shops)).toHaveLength(0);
  });
});

describe('resolveNames - 確定 / 曖昧 / 不明の3分類', () => {
  it('1件だけ一致＝確定', () => {
    const r = resolveNames(['渋谷'], DIR.shops);
    expect(r.resolved).toHaveLength(1);
    expect(r.resolved[0].item.id).toBe('sh_shibuya');
  });
  it('2件以上一致＝曖昧（候補を返して止める）', () => {
    const r = resolveNames(['恵比寿'], DIR.shops);
    expect(r.ambiguous).toHaveLength(1);
    expect(r.ambiguous[0].candidates.map(x => x.id)).toEqual(['sh_ebisu', 'sh_ebisu_w']);
    expect(r.resolved).toHaveLength(0);       // ← 片方を勝手に選ばない
  });
  it('0件＝不明（近い名前へ寄せない）', () => {
    const r = resolveNames(['名古屋'], DIR.shops);
    expect(r.unresolved).toHaveLength(1);
    expect(r.resolved).toHaveLength(0);
  });
});

describe('resolveRecipients - 同名の人物は絶対に推測しない', () => {
  it('「田中さん」は2人いるので確認待ちになる', () => {
    const r = resolveRecipients({ scope: 'staff', staff: ['田中'] }, ctx(ROOT));
    expect(r.status).toBe('needs_confirmation');
    expect(r.ambiguities[0].candidates.map(c => c.id).sort()).toEqual(['st_1', 'st_2']);
  });
  it('フルネームまで言えば確定する', () => {
    const r = resolveRecipients({ scope: 'staff', staff: ['田中 太郎'] }, ctx(ROOT));
    expect(r.status).toBe('resolved');
    expect(r.staffIds).toEqual(['st_1']);
  });
  it('曖昧が1件でもあれば、解決できた分だけでも送らない', () => {
    const r = resolveRecipients({ scope: 'staff', staff: ['田中', '佐藤 一郎'] }, ctx(ROOT));
    expect(r.status).toBe('needs_confirmation');   // ← 佐藤さんにだけ先に送る、をしない
  });
  it('存在しない名前は不明として止まる', () => {
    const r = resolveRecipients({ scope: 'staff', staff: ['山田 三郎'] }, ctx(ROOT));
    expect(r.status).toBe('needs_confirmation');
    expect(r.unresolved[0].query).toBe('山田 三郎');
  });
});

describe('resolveRecipients - 店舗・エリア・全社', () => {
  it('エリア指定でその地域の店舗が入る', () => {
    const r = resolveRecipients({ scope: 'area', areas: ['東京'] }, ctx(ROOT));
    expect(r.status).toBe('resolved');
    expect(r.shops.map(s => s.id).sort()).toEqual(['sh_ebisu', 'sh_ebisu_w', 'sh_shibuya']);
  });
  it('存在しないエリアは不明として止まる', () => {
    const r = resolveRecipients({ scope: 'area', areas: ['北海道'] }, ctx(ROOT));
    expect(r.status).toBe('needs_confirmation');
  });
  it('scope=all は全店になり、操作は chat.broadcast_all になる', () => {
    const r = resolveRecipients({ scope: 'all' }, ctx(ROOT));
    expect(r.action).toBe('chat.broadcast_all');
    expect(r.shops).toHaveLength(4);
  });
  it('複数店舗は chat.broadcast、1店舗は chat.send として判定される', () => {
    expect(resolveRecipients({ scope: 'store', shops: ['渋谷', '梅田'] }, ctx(ROOT)).action).toBe('chat.broadcast');
    expect(resolveRecipients({ scope: 'store', shops: ['渋谷'] }, ctx(ROOT)).action).toBe('chat.send');
  });
});

describe('resolveRecipients - 除外つき一斉送信', () => {
  it('「東京全部、恵比寿西口は除く」が効く', () => {
    const r = resolveRecipients({ scope: 'area', areas: ['東京'], exclude: { shops: ['恵比寿西口'] } }, ctx(ROOT));
    expect(r.status).toBe('resolved');
    expect(r.shops.map(s => s.id).sort()).toEqual(['sh_ebisu', 'sh_shibuya']);
    expect(r.excludedShops[0].id).toBe('sh_ebisu_w');
  });
  it('除外語が曖昧なら止める（除外し損ねて誤送信するより止める）', () => {
    const r = resolveRecipients({ scope: 'area', areas: ['東京'], exclude: { shops: ['恵比寿'] } }, ctx(ROOT));
    expect(r.status).toBe('needs_confirmation');
    expect(r.ambiguities.some(a => a.type === 'exclude_shop')).toBe(true);
  });
  it('除外語が存在しないときも止める（黙って全員に送らない）', () => {
    const r = resolveRecipients({ scope: 'all', exclude: { shops: ['福岡'] } }, ctx(ROOT));
    expect(r.status).toBe('needs_confirmation');
  });
  it('個人の除外も効く', () => {
    const r = resolveRecipients({ scope: 'store', shops: ['NAORU整骨院 恵比寿'], exclude: { staff: ['佐藤 一郎'] } }, ctx(ROOT));
    expect(r.staffIds).not.toContain('st_3');
    expect(r.excludedStaff[0].id).toBe('st_3');
  });
});

describe('resolveRecipients - 権限を超える宛先は送れない', () => {
  it('スタッフは自店だけ。他店を指定したら確認へ回し、落とした先を報告する', () => {
    const r = resolveRecipients({ scope: 'store', shops: ['NAORU整骨院 恵比寿', '渋谷'] }, ctx(STAFF));
    expect(r.shops.map(s => s.id)).toEqual(['sh_ebisu']);
    expect(r.outOfScope.some(o => o.shop === 'NAORU整骨院 渋谷')).toBe(true);
    expect(r.status).toBe('needs_confirmation');   // ← 黙って恵比寿だけに送らない
  });
  it('スタッフは全社一斉を送れない', () => {
    const r = resolveRecipients({ scope: 'all' }, ctx(STAFF));
    expect(r.status).toBe('denied');
    expect(r.code).toBe('role_too_low');
  });
  it('オーナーは管轄2店舗への一斉は送れる', () => {
    const r = resolveRecipients({ scope: 'store', shops: ['NAORU整骨院 恵比寿', '渋谷'] }, ctx(OWNER));
    expect(r.status).toBe('resolved');
    expect(r.shops).toHaveLength(2);
  });
  it('本部は全社一斉を送れる', () => {
    expect(resolveRecipients({ scope: 'all' }, ctx(ADMIN)).status).toBe('resolved');
  });
  it('権限外しか宛先が無ければ empty になり、送信させない', () => {
    const r = resolveRecipients({ scope: 'store', shops: ['梅田'] }, ctx(STAFF));
    expect(['empty', 'denied']).toContain(r.status);
    expect(r.shops).toHaveLength(0);
  });
});

describe('resolveRecipients - AIは人間の権限を超えられない', () => {
  it('AIが代行しても、依頼者がスタッフなら他店へは送れない', () => {
    const r = resolveRecipients({ scope: 'store', shops: ['渋谷'] }, ctx(AI, { onBehalfOf: STAFF }));
    expect(r.shops).toHaveLength(0);
    expect(r.outOfScope.length).toBeGreaterThan(0);
  });
  it('AIが代行しても、依頼者がスタッフなら全社一斉は拒否', () => {
    const r = resolveRecipients({ scope: 'all' }, ctx(AI, { onBehalfOf: STAFF }));
    expect(r.status).toBe('denied');
  });
  it('依頼者が本部なら、AI代行でも全社一斉は通る', () => {
    const r = resolveRecipients({ scope: 'all' }, ctx(AI, { onBehalfOf: ADMIN }));
    expect(r.status).toBe('resolved');
    expect(r.onBehalfOf.id).toBe('u_hq');
    expect(r.bySource).toBe('agent');       // ← 誰が実行したかも残す
  });
  it('onBehalfOf が無いAI単独実行は、AI自身の権限で判定される', () => {
    const r = resolveRecipients({ scope: 'store', shops: ['渋谷'] }, ctx(AI));
    expect(r.onBehalfOf).toBe(null);
    expect(r.bySource).toBe('agent');
  });
});

describe('resolveRecipients - 一括送信の追加確認', () => {
  it('しきい値以上の人数なら requiresBulkConfirm が立つ', () => {
    const many = { shops: [{ id: 'sh_x', name: 'X', area: '東京' }], staff: [] };
    for (let i = 0; i < BULK_CONFIRM_THRESHOLD + 1; i++) many.staff.push({ id: `s${i}`, name: `人${i}`, shop: 'X', role: 'staff' });
    const r = resolveRecipients({ scope: 'store', shops: ['X'] }, { dir: many, actor: ROOT });
    expect(r.recipientCount).toBeGreaterThanOrEqual(BULK_CONFIRM_THRESHOLD);
    expect(r.requiresBulkConfirm).toBe(true);
  });
  it('少人数なら追加確認は不要', () => {
    const r = resolveRecipients({ scope: 'staff', staff: ['田中 太郎'] }, ctx(ROOT));
    expect(r.requiresBulkConfirm).toBe(false);
  });
  it('全社一斉は人数に関わらず追加確認が必要', () => {
    expect(resolveRecipients({ scope: 'all' }, ctx(ROOT)).requiresBulkConfirm).toBe(true);
  });
});

describe('resolveRecipients - 壊れた入力', () => {
  it('spec が null でも落ちない（宛先0件）', () => {
    const r = resolveRecipients(null, ctx(ROOT));
    expect(r.status).toBe('empty');
  });
  it('ctx が空でも落ちない', () => {
    expect(() => resolveRecipients({ scope: 'all' }, {})).not.toThrow();
  });
  it('未検証の主体は送れない（fallbackCan は role で判定するため guest 扱い）', () => {
    const r = resolveRecipients({ scope: 'store', shops: ['渋谷'] }, ctx({ role: 'guest', verified: false }));
    expect(['denied', 'empty']).toContain(r.status);
  });
  it('認可を外から注入できる（authz.js 接続用）', () => {
    const calls = [];
    const r = resolveRecipients({ scope: 'store', shops: ['渋谷'] }, ctx(ROOT, {
      can: (a, action, t) => { calls.push(action); return { allow: true, code: '', reason: '' }; },
    }));
    expect(calls.length).toBeGreaterThan(0);
    expect(r.status).toBe('resolved');
  });
});

describe('describeRecipients - 送信前プレビュー', () => {
  it('店舗数・人数・除外を1行で説明する', () => {
    const r = resolveRecipients({ scope: 'area', areas: ['東京'], exclude: { shops: ['恵比寿西口'] } }, ctx(ROOT));
    const t = describeRecipients(r);
    expect(t).toContain('店舗 2件');
    expect(t).toContain('除外');
  });
  it('宛先が無ければ「宛先なし」', () => {
    expect(describeRecipients({})).toBe('宛先なし');
  });
});

describe('actionForSpec', () => {
  it('scope=all は全社一斉', () => {
    expect(actionForSpec(normalizeSpec({ scope: 'all' }), 4)).toBe('chat.broadcast_all');
  });
  it('複数店舗は broadcast、単店は send', () => {
    expect(actionForSpec(normalizeSpec({ scope: 'store' }), 3)).toBe('chat.broadcast');
    expect(actionForSpec(normalizeSpec({ scope: 'store' }), 1)).toBe('chat.send');
  });
});
