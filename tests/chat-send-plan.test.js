// 送信指示の分離・送信前確認・配信計画・送信直前の再確認・再通知の重複防止
import { describe, it, expect } from 'vitest';
import {
  splitInstruction, looksLikeInstruction, buildConfirmation, confirmationLine,
  deliveryModeFor, recheckBeforeSend, planRenotify, markSent, dedupeKey, DELIVERY,
} from '../lib/chat-send-plan.js';
import { resolveRecipients } from '../lib/chat-recipients.js';

const DIR = {
  shops: [{ id: 's1', name: 'NAORU恵比寿院' }, { id: 's2', name: 'NAORU渋谷院' }, { id: 's3', name: 'NAORU新宿院' }],
  staff: [
    { id: 'p1', name: '佐藤 健', shop: 'NAORU恵比寿院' },
    { id: 'p2', name: '鈴木 一郎', shop: 'NAORU渋谷院' },
    { id: 'p3', name: '佐藤 健', shop: 'NAORU新宿院' },      // 同姓同名
  ],
};
const allow = () => ({ allow: true });
const rootCtx = { dir: DIR, actor: { id: 'hq1', name: '本部', role: 'root' }, can: allow };

describe('本文と送信指示を分ける', () => {
  it('「本文:」で明示されていれば、その前後で分ける', () => {
    const r = splitInstruction('恵比寿院と渋谷院だけに送って\n本文: 明日の朝礼は9時からです');
    expect(r.status).toBe('ok');
    expect(r.instruction).toBe('恵比寿院と渋谷院だけに送って');
    expect(r.body).toBe('明日の朝礼は9時からです');
  });

  it('「」で囲まれた部分を本文として扱う', () => {
    const r = splitInstruction('新宿院を除く全店に「棚卸しは金曜です」と送って');
    expect(r.status).toBe('ok');
    expect(r.body).toBe('棚卸しは金曜です');
    expect(r.instruction).toContain('新宿院を除く');
    expect(r.instruction).not.toContain('棚卸しは金曜です');   // 指示に本文を混ぜない
  });

  it('区切りが無ければ、先頭の指示らしい行だけを指示にする', () => {
    const r = splitInstruction('恵比寿院と渋谷院に送ってください\n\n明日の朝礼は9時からです。\n遅れる人は連絡してください。');
    expect(r.status).toBe('ok');
    expect(r.instruction).toBe('恵比寿院と渋谷院に送ってください');
    expect(r.body).toContain('明日の朝礼は9時からです');
    expect(r.body).toContain('遅れる人は連絡');
  });

  it('本文が無ければ送らない（指示文を本文にしない）', () => {
    const r = splitInstruction('恵比寿院と渋谷院に送って');
    expect(r.status).toBe('needs_body');
    expect(r.body).toBe('');
  });

  it('指示が無ければ送らない（本文だけでは宛先が決まらない）', () => {
    const r = splitInstruction('明日の朝礼は9時からです');
    expect(r.status).toBe('needs_instruction');
    expect(r.instruction).toBe('');
  });

  it('URLや引用で始まる行は指示と見なさない', () => {
    expect(looksLikeInstruction('https://example.com/送信の手引き')).toBe(false);
    expect(looksLikeInstruction('「全店に送ります」')).toBe(false);
    expect(looksLikeInstruction('恵比寿院だけに送って')).toBe(true);
  });
});

describe('送信前確認: 実際の店舗・人・件数・本文を出す', () => {
  it('店舗ルームへの送信は、実際の店舗名と件数と本文を返す', () => {
    const resolved = resolveRecipients({ shops: ['恵比寿', '渋谷'] }, rootCtx);
    const conf = buildConfirmation({ resolved, body: '明日の朝礼は9時からです', spec: { shops: ['恵比寿', '渋谷'] } });
    expect(conf.canSend).toBe(true);
    expect(conf.mode).toBe(DELIVERY.ROOMS);
    expect(conf.count).toBe(2);
    expect(conf.targets.map(t => t.label)).toEqual(['NAORU恵比寿院', 'NAORU渋谷院']);
    expect(conf.body).toBe('明日の朝礼は9時からです');       // 本文はそのまま見せる
    expect(confirmationLine(conf)).toContain('NAORU恵比寿院');
    expect(confirmationLine(conf)).toContain('2件');
  });

  it('除外指定は「どこへ送らないか」も見せる', () => {
    const spec = { scope: 'all', exclude: { shops: ['新宿'] } };
    const resolved = resolveRecipients(spec, rootCtx);
    const conf = buildConfirmation({ resolved, body: '棚卸しは金曜です', spec });
    expect(conf.targets.map(t => t.label)).not.toContain('NAORU新宿院');
    expect(conf.excludedShops.map(s => s.name)).toContain('NAORU新宿院');
  });

  it('本文が空なら送れない', () => {
    const resolved = resolveRecipients({ shops: ['恵比寿'] }, rootCtx);
    const conf = buildConfirmation({ resolved, body: '   ' });
    expect(conf.canSend).toBe(false);
    expect(conf.blockers.map(b => b.code)).toContain('no_body');
  });

  it('店舗を指定しただけで個別DMに変えない（店舗ルームのまま）', () => {
    const spec = { shops: ['恵比寿'] };
    const conf = buildConfirmation({ resolved: resolveRecipients(spec, rootCtx), body: 'お知らせ', spec });
    expect(conf.mode).toBe(DELIVERY.ROOMS);
    expect(conf.dmEach).toBe(false);
  });

  it('同姓同名が解決できなければ送れない（推測しない）', () => {
    const spec = { staff: ['佐藤 健'] };
    const resolved = resolveRecipients(spec, rootCtx);
    expect(resolved.status).toBe('needs_confirmation');
    const conf = buildConfirmation({ resolved, body: '面談の件です', spec });
    expect(conf.canSend).toBe(false);
    expect(conf.blockers.map(b => b.code)).toContain('ambiguous_recipients');
    expect(conf.ambiguities.length).toBeGreaterThan(0);
  });

  it('店舗名が曖昧・存在しないときも送れない', () => {
    const resolved = resolveRecipients({ shops: ['池袋'] }, rootCtx);
    const conf = buildConfirmation({ resolved, body: 'お知らせ' });
    expect(conf.canSend).toBe(false);
    expect(conf.unresolved.length).toBeGreaterThan(0);
  });
});

describe('一括DM: 1人1通・宛先同士を見せない', () => {
  const spec = { shops: ['恵比寿', '渋谷'], dm: true };
  const resolved = resolveRecipients(spec, rootCtx);

  it('個人宛はグループDMにせず、1人1通にする', () => {
    expect(deliveryModeFor(spec, resolved)).toBe(DELIVERY.DM_EACH);
    const conf = buildConfirmation({ resolved, body: '今月のシフト希望を出してください', spec });
    expect(conf.dmEach).toBe(true);
    expect(conf.targets.every(t => t.kind === 'dm')).toBe(true);
    expect(conf.count).toBe(conf.staff.length);                 // 人数ぶんの通数
    expect(new Set(conf.targets.map(t => t.to)).size).toBe(conf.count);   // 1人1通
  });

  it('宛先同士が互いに見えないことを確認画面で明示する', () => {
    const conf = buildConfirmation({ resolved, body: 'シフト希望', spec });
    expect(conf.recipientsHiddenFromEachOther).toBe(true);
    expect(confirmationLine(conf)).toContain('宛先は互いに見えません');
  });

  it('本文には宛先一覧を混ぜない', () => {
    const conf = buildConfirmation({ resolved, body: 'シフト希望', spec });
    for (const t of conf.targets) expect(conf.body).not.toContain(t.label);
  });
});

describe('送信時点で所属・権限を再確認する', () => {
  const spec = { shops: ['恵比寿', '渋谷'], dm: true };
  const conf = buildConfirmation({ resolved: resolveRecipients(spec, rootCtx), body: 'シフト希望', spec });

  it('変化が無ければそのまま送る', () => {
    const r = recheckBeforeSend(conf, { dir: DIR, can: allow });
    expect(r.canSend).toBe(true);
    expect(r.changed).toBe(false);
    expect(r.count).toBe(conf.count);
  });

  it('確認後に退職した人へは送らない', () => {
    const dir = { ...DIR, staff: DIR.staff.filter(s => s.id !== 'p1') };
    const r = recheckBeforeSend(conf, { dir, can: allow });
    expect(r.dropped.map(d => d.code)).toContain('left');
    expect(r.send.map(s => s.to)).not.toContain('p1');
  });

  it('確認後に異動した人は落として理由を残す', () => {
    const dir = { ...DIR, staff: DIR.staff.map(s => (s.id === 'p1' ? { ...s, shop: 'NAORU新宿院' } : s)) };
    const r = recheckBeforeSend(conf, { dir, can: allow });
    const moved = r.dropped.find(d => d.to === 'p1');
    expect(moved.code).toBe('moved');
    expect(moved.reason).toContain('NAORU新宿院');
  });

  it('送信時点で権限が無くなっていれば送らない', () => {
    const r = recheckBeforeSend(conf, { dir: DIR, can: () => ({ allow: false, code: 'out_of_scope' }) });
    expect(r.canSend).toBe(false);
    expect(r.count).toBe(0);
    expect(r.dropped.every(d => d.code === 'out_of_scope')).toBe(true);
  });

  it('全部落ちたら「0件送信」を成功にしない', () => {
    const r = recheckBeforeSend(conf, { dir: { shops: [], staff: [] }, can: allow });
    expect(r.canSend).toBe(false);
  });
});

describe('予約送信・未読者への再通知: 重複を防ぐ', () => {
  const candidates = [
    { id: 'p1', name: '佐藤 健', shop: 'NAORU恵比寿院' },
    { id: 'p2', name: '鈴木 一郎', shop: 'NAORU渋谷院' },
    { id: 'p1', name: '佐藤 健', shop: 'NAORU恵比寿院' },      // 候補に重複
  ];

  it('既読の人には再通知しない', () => {
    const r = planRenotify({ campaignId: 'c1', candidates, readBy: ['p2'], ledger: {} });
    expect(r.send.map(x => x.id)).toEqual(['p1']);
    expect(r.skipped.find(s => s.id === 'p2').code).toBe('already_read');
  });

  it('同じ配信で送信済みの人には二度送らない', () => {
    const ledger = markSent({}, 'c1', ['p1']);
    const r = planRenotify({ campaignId: 'c1', candidates, readBy: [], ledger });
    expect(r.send.map(x => x.id)).toEqual(['p2']);
    expect(r.skipped.find(s => s.id === 'p1').code).toBe('already_sent');
  });

  it('候補に同じ人が2回入っていても1通だけにする', () => {
    const r = planRenotify({ campaignId: 'c1', candidates, readBy: [], ledger: {} });
    expect(r.send.map(x => x.id)).toEqual(['p1', 'p2']);
    expect(r.duplicatesInCandidates).toBe(1);
  });

  it('別の配信なら送れる（台帳は配信ごと）', () => {
    const ledger = markSent({}, 'c1', ['p1', 'p2']);
    const r = planRenotify({ campaignId: 'c2', candidates, readBy: [], ledger });
    expect(r.count).toBe(2);
    expect(dedupeKey('c1', 'p1')).not.toBe(dedupeKey('c2', 'p1'));
  });

  it('再通知の直前にも所属・権限を確かめる（recheck と組み合わせる）', () => {
    const r = planRenotify({ campaignId: 'c3', candidates, readBy: [], ledger: {} });
    const conf = { targets: r.send.map(x => ({ kind: 'dm', to: x.id, label: x.name, shop: x.shop })) };
    const after = recheckBeforeSend(conf, { dir: { ...DIR, staff: DIR.staff.filter(s => s.id !== 'p2') }, can: allow });
    expect(after.send.map(s => s.to)).toEqual(['p1']);
    expect(after.dropped.map(d => d.code)).toContain('left');
  });
});
