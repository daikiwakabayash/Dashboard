#!/usr/bin/env node
// ── チャット同期 差分プレビュー（CLI・dry-run のみ）────────────────────────
// 使い方:
//   node scripts/chat-sync-demo.mjs                 … 全シナリオを実行
//   node scripts/chat-sync-demo.mjs rename          … 1シナリオだけ
//   node scripts/chat-sync-demo.mjs --json rename   … plan を JSON で出力
//   node scripts/chat-sync-demo.mjs --file input.json … 自分で用意した入力で試す
//
// ⚠️ 本番の Room / メンバーには一切書き込まない。合成データで「何が変わるか」を見るだけ。

// ⚠️ このファイルは chat-sync-preview.html（ブラウザ）からも import される。
//    Node 専用の API はトップレベルで import せず、CLI 実行時のみ動的 import する。
import { planChatSync, summarizePlan, isNoop, readyItems, heldItems } from '../lib/chat-rooms.js';

const SHOPS = [
  { id: '100', name: 'NAORU渋谷院' },
  { id: '200', name: 'NAORU梅田院' },
  { id: '300', name: 'NAORU札幌院' },
];
const STAFFS = [
  { id: 's1', name: '佐藤 一郎', shop_id: '100' },
  { id: 's2', name: '鈴木 二郎', shop_id: '100' },
  { id: 's3', name: '高橋 三郎', shop_id: '200' },
  { id: 's4', name: '田中 四郎', shop_id: '300' },
];
const ROOMS = [
  { id: 'store_NAORU渋谷院', kind: 'store', name: 'NAORU渋谷院', shop: 'NAORU渋谷院', members: ['s1'], autoMembers: ['s1'] },
  { id: 'store_NAORU梅田院', kind: 'store', name: 'NAORU梅田院', shop: 'NAORU梅田院', members: [], autoMembers: [] },
  { id: 'g1', kind: 'group', name: '9月勉強会', members: ['s1'], autoMembers: ['s1'] },
];
const EVENTS = [
  { id: 'e1', cells: { eventId: 'e1', roomId: 'g1', chatTitle: '9月勉強会', date: '2026-09-20', ownerId: 's1', participantIds: ['s2', 's3'] } },
];

const COMPLETE = { shopsComplete: true, staffsComplete: true };

export const SCENARIOS = {
  base: {
    title: '通常同期（storeId の後付け・新店舗の Room 作成・所属追加）',
    input: { rooms: ROOMS, shops: SHOPS, staffs: STAFFS, events: EVENTS, hqMembers: ['hq_wakabayashi'], source: COMPLETE },
  },
  rename: {
    title: '店舗名の変更（同じ Room を維持して表示名だけ更新）',
    input: {
      rooms: [{ id: 'store_NAORU渋谷院', kind: 'store', name: 'NAORU渋谷院', shop: 'NAORU渋谷院', storeId: '100', members: ['s1'], autoMembers: ['s1'] }],
      shops: [{ id: '100', name: 'NAORU渋谷道玄坂院' }], staffs: [STAFFS[0]], source: COMPLETE,
    },
  },
  samename: {
    title: '同名店舗（勝手に紐付けない・別IDで作る）',
    input: {
      rooms: [{ id: 'store_NAORU本院', kind: 'store', name: 'NAORU本院', shop: 'NAORU本院', members: [] }],
      shops: [{ id: '400', name: 'NAORU本院' }, { id: '401', name: 'NAORU本院' }], staffs: [], source: COMPLETE,
    },
  },
  similar: {
    title: '似た名前の店舗（部分一致では紐付けない）',
    input: {
      rooms: [{ id: 'store_渋谷', kind: 'store', name: '渋谷', shop: '渋谷', members: [] }],
      shops: [{ id: '100', name: 'NAORU渋谷院' }, { id: '101', name: 'NAORU渋谷西院' }], staffs: [], source: COMPLETE,
    },
  },
  transfer: {
    title: '異動・兼務（複数店舗権限をそのまま継承）',
    input: {
      rooms: [
        { id: 'r100', kind: 'store', name: 'NAORU渋谷院', shop: 'NAORU渋谷院', storeId: '100', members: ['s1', 's2'], autoMembers: ['s1', 's2'] },
        { id: 'r200', kind: 'store', name: 'NAORU梅田院', shop: 'NAORU梅田院', storeId: '200', members: [], autoMembers: [] },
      ],
      shops: SHOPS.slice(0, 2),
      staffs: [{ id: 's1', name: '佐藤 一郎', shop_id: '200' }, { id: 's2', name: '鈴木 二郎', shop_id: '100' }],
      accounts: { s2: { storeIds: ['100', '200'] } },   // 兼務（SalonOne の accessible_shops 由来）
      source: COMPLETE,
    },
  },
  retire: {
    title: '退職（自動所属からは外す／手動追加メンバーは外さない）',
    input: {
      rooms: [{ id: 'r100', kind: 'store', name: 'NAORU渋谷院', shop: 'NAORU渋谷院', storeId: '100', members: ['s1', 's2', 'manual1'], autoMembers: ['s1', 's2'] }],
      shops: [SHOPS[0]],
      staffs: [{ id: 's1', name: '佐藤 一郎', shop_id: '100', deleted: true }, { id: 's2', name: '鈴木 二郎', shop_id: '100' }, { id: 'manual1', name: '手動 太郎', shop_id: '100', deleted: true }],
      source: COMPLETE,
    },
  },
  apifail: {
    title: 'API障害・取得漏れ（大量削除をせずに中止/保留する）',
    input: {
      rooms: [{ id: 'r100', kind: 'store', name: 'NAORU渋谷院', shop: 'NAORU渋谷院', storeId: '100', members: ['s1', 's2'], autoMembers: ['s1', 's2'] }],
      shops: [SHOPS[0]], staffs: [], source: { staffsComplete: false },
    },
  },
  shopsdown: {
    title: '店舗一覧の取得失敗（同期そのものを中止）',
    input: { rooms: ROOMS, shops: [], staffs: STAFFS, previous: { shopCount: 90 } },
  },
  noaccess: {
    title: 'A: アクセス可能店舗なし（確認済みの空配列）→ 名簿へ戻さない',
    input: {
      rooms: [{ id: 'r100', kind: 'store', name: 'NAORU渋谷院', shop: 'NAORU渋谷院', storeId: '100', members: ['s1', 's2'], autoMembers: ['s1', 's2'] }],
      shops: [SHOPS[0]],
      staffs: [{ id: 's1', name: '佐藤 一郎', shop_id: '100' }, { id: 's2', name: '鈴木 二郎', shop_id: '100' }],
      accounts: { s1: { storeIds: [] }, s2: { note: '未取得（storeIds が無い）' } },
      source: COMPLETE,
    },
  },
  unknownflags: {
    title: 'C: 完全性フラグ未指定 → 削除・アーカイブを保留（追加はする）',
    input: {
      rooms: [
        { id: 'r100', kind: 'store', name: 'NAORU渋谷院', shop: 'NAORU渋谷院', storeId: '100', members: ['gone'], autoMembers: ['gone'] },
        { id: 'r900', kind: 'store', name: '閉店A', shop: '閉店A', storeId: '900', members: [] },
      ],
      shops: [SHOPS[0]], staffs: [{ id: 's1', name: '佐藤 一郎', shop_id: '100' }],
    },
  },
  partialscope: {
    title: 'E: 取得範囲が一部（scope）→ 範囲外の店舗を閉店扱いしない',
    input: {
      rooms: [
        { id: 'r100', kind: 'store', name: 'NAORU渋谷院', shop: 'NAORU渋谷院', storeId: '100', members: [], autoMembers: [] },
        { id: 'r200', kind: 'store', name: 'NAORU梅田院', shop: 'NAORU梅田院', storeId: '200', members: [], autoMembers: [] },
      ],
      shops: [SHOPS[0]], staffs: [{ id: 's1', name: '佐藤 一郎', shop_id: '100' }],
      scope: { storeIds: ['100'] }, source: COMPLETE,
    },
  },
  tenants: {
    title: 'E: 別テナントのデータを同じ plan に混ぜない',
    input: {
      rooms: [
        { id: 'r100', kind: 'store', name: 'A院', shop: 'A院', storeId: '100', members: [], autoMembers: [], tenantId: 'naoru' },
        { id: 'rX', kind: 'store', name: 'X院', shop: 'X院', storeId: '900', members: [], autoMembers: [], tenantId: 'other' },
      ],
      shops: [{ id: '100', name: 'A院', tenantId: 'naoru' }, { id: '900', name: 'X院', tenantId: 'other' }],
      staffs: [{ id: 's1', name: 'A', shop_id: '100', tenantId: 'naoru' }, { id: 'x1', name: 'X', shop_id: '900', tenantId: 'other' }],
      tenantId: 'naoru', source: COMPLETE,
    },
  },
};

const L = (s = '') => console.log(s);
function render(name, sc) {
  const plan = planChatSync(sc.input);
  const sum = summarizePlan(plan);
  L('─'.repeat(72));
  L(`▼ ${name}  ${sc.title}`);
  L('─'.repeat(72));
  if (plan.problems.length) {
    L('【入力の問題】');
    plan.problems.forEach(p => L(`  ${p.level === 'abort' ? '⛔' : '⚠️ '} [${p.code}] ${p.message}`));
  }
  if (plan.aborted) { L('  ⛔ 同期を中止しました（Room・メンバーは一切変更しません）'); L(''); return; }
  if (isNoop(plan)) L('  ✅ 実行予定はありません（冪等 / すべて保留）');
  const R = readyItems(plan);
  if (R.create.length) { L('【作成予定 Room（実行可能）】'); R.create.forEach(c => L(`  + ${c.roomId}  kind=${c.kind}  name=${c.name}${c.storeId ? `  storeId=${c.storeId}` : ''}${c.eventId ? `  eventId=${c.eventId}` : ''}`)); }
  if (R.bind.length) { L('【ID 紐付け予定（実行可能）】'); R.bind.forEach(b => L(`  ~ ${b.roomId} → ${b.storeId ? `storeId=${b.storeId}` : `eventId=${b.eventId}`}  (${b.matchedBy})`)); }
  if (R.rename.length) { L('【表示名の更新（Room は維持）】'); R.rename.forEach(r => L(`  ~ ${r.roomId}: 「${r.from}」→「${r.to}」`)); }
  if (R.archive.length) { L('【アーカイブ候補（削除はしない）】'); R.archive.forEach(a => L(`  # ${a.roomId}  ${a.reason}`)); }
  if (R.memberAdd.length) { L('【追加予定メンバー】'); R.memberAdd.forEach(m => L(`  + ${m.roomId}: ${m.staffIds.join(', ')}  （${m.reason}）`)); }
  if (R.memberRemove.length) { L('【除外予定メンバー】'); R.memberRemove.forEach(m => L(`  - ${m.roomId}: ${m.staffIds.join(', ')}  （${m.reason}）`)); }
  const held = heldItems(plan);
  if (held.length) { L('【保留（人の確認が要る・自動実行しない）】'); held.forEach(h => L(`  ⏸ [${h.kind}] ${h.roomId || ''}${h.staffIds ? ': ' + h.staffIds.join(', ') : ''}  理由=${h.holdReason || h.reason}`)); }
  if (plan.review.length) { L('【判断できない項目（要確認・自動では触らない）】'); plan.review.forEach(r => L(`  ? [${r.kind}] ${r.subject}: ${r.reason}${r.staffIds ? ` → ${r.staffIds.join(', ')}` : ''}`)); }
  if (plan.accessNotes.length) { L('【アクセス権限について（メンバー表示とは別処理）】'); plan.accessNotes.forEach(n => L(`  ! ${n.staffIds.join(', ')}: ${n.note}`)); }
  L(`【集計】実行: 作成${sum.createRooms} / 紐付け${sum.bindIds} / 改名${sum.renames} / アーカイブ${sum.archives} / 追加${sum.addPeople}名 / 除外${sum.removePeople}名　保留: ${sum.heldItems}件(${sum.heldPeople}名) / 要確認${sum.reviews}`);
  L('');
}

// ── CLI 実行時のみ動作（ブラウザから import しても何も起きない）────────────
const isCli = typeof process !== 'undefined'
  && Array.isArray(process.argv)
  && String(process.argv[1] || '').endsWith('chat-sync-demo.mjs');

if (isCli) {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const fileIdx = argv.indexOf('--file');
  const fileArg = fileIdx >= 0 ? argv[fileIdx + 1] : null;
  const names = argv.filter(a => !a.startsWith('--') && a !== fileArg);

  if (fileIdx >= 0) {
    const { readFileSync } = await import('node:fs');
    const input = JSON.parse(readFileSync(fileArg, 'utf8'));
    const plan = planChatSync(input);
    if (asJson) console.log(JSON.stringify(plan, null, 2));
    else render('file', { title: fileArg, input });
  } else {
    const keys = names.length ? names : Object.keys(SCENARIOS);
    if (asJson) {
      console.log(JSON.stringify(Object.fromEntries(keys.map(k => [k, planChatSync(SCENARIOS[k].input)])), null, 2));
    } else {
      L('');
      L('チャット同期 差分プレビュー（dry-run・本番には一切書き込みません）');
      keys.forEach(k => SCENARIOS[k] ? render(k, SCENARIOS[k]) : L(`（不明なシナリオ: ${k}）`));
    }
  }
}
