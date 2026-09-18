// ── チャット Room 情報 / 所属同期の「差分（plan）計算」──────────────────────
// ⚠️ このモジュールは **何も実行しない**。「実行したら何を変更するか」だけを返す純粋関数。
//    保存・送信・招待は一切行わず、I/O も持たない（依存ゼロ＝共通基盤の変更を待たずに検証できる）。
//
// 方針（CHAT_EXISTING_INTEGRATION_AUDIT.md / CHAT_ROOM_LIFECYCLE.md）:
//   - 既存 Room ID は変えない。`storeId` / `eventId` を後付けするだけ。
//   - 店舗名の**部分一致では絶対に紐付けない**（権限が広がるため）。完全一致のみ。
//     一意に決まらないものは `review`（要確認）に出して、勝手に決めない。
//   - 自動所属メンバー（`autoMembers`）と手動追加/self-join メンバーを区別し、
//     **手動で入った人を自動削除しない**。
//   - 名簿の取得失敗・ページ欠落では**絶対に大量削除しない**（abort か「追加のみ」に落とす）。
//   - 退職・権限剥奪の「アクセス拒否」は authz 側（SalonOne /me + chat-policy）が即時に行う。
//     ここが計算するのは **表示上のメンバー一覧の更新**だけ（遅れても権限は残らない）。
//
// テスト: tests/chat-rooms.test.js（合成データのみ）

export const CHAT_SYNC_VERSION = 'chat-rooms-sync-1';

// 既定の安全上限（1回の同期で消してよい上限）。超えたら削除をやめて review に落とす。
export const DEFAULT_LIMITS = Object.freeze({
  maxRemovePerRun: 50,       // 1回の同期で自動削除してよい人数の上限（延べ）
  maxRemoveRatio: 0.3,       // 現在の自動メンバー総数に対する削除比率の上限
  removeFloor: 5,            // これ以下の人数なら比率judgeを適用しない（通常の異動・退職を止めないため）
  ratioMinPopulation: 20,    // 比率judgeを適用する母集団の最小人数（小規模店で誤検知しない）
  minShopRatio: 0.7,         // 前回より店舗数がこの比率を下回ったら取得失敗とみなす
  minStaffRatio: 0.7,        // 同上（スタッフ）
});

const str = (v) => String(v == null ? '' : v);
const arr = (v) => (Array.isArray(v) ? v : []);
const uniq = (a) => [...new Set(a)];

// ── 店舗名の正規化 ───────────────────────────────────────────────────────
// 全角→半角・空白除去・英字小文字化まで。**接辞（NAORU/整骨院/院/店）は落とさない。**
// 「渋谷院」と「渋谷西院」、「梅田院」と「梅田中央院」を同一視しないため。
export function normalizeShopName(name) {
  return str(name)
    .normalize('NFKC')
    .replace(/[\s　]+/g, '')
    .toLowerCase();
}

// 店舗一覧から「正規化名 → その名前を持つ店舗の配列」を作る（同名店舗の検出用）
export function indexShopsByName(shops) {
  const map = new Map();
  for (const s of arr(shops)) {
    const id = str(s && s.id);
    const name = str(s && s.name);
    if (!id || !name) continue;
    const key = normalizeShopName(name);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ id, name });
  }
  return map;
}

// Room が店舗ルームか
const isStoreRoom = (r) => r && r.kind === 'store';
// Room の表示名（既存データは name / shop のどちらにも入っている）
const roomShopName = (r) => str((r && (r.shop || r.name)) || '');

// ── スタッフ → 所属店舗ID（複数店舗・兼務に対応）───────────────────────────
// 優先順位:
//   1) accounts[staffId].storeIds … SalonOne の accessible_shops 由来（兼務・複数店舗権限の正）
//   2) staff.shop_ids（配列）
//   3) staff.shop_id（単一・従来の配属）
//
// ⚠️ A. **確認済みの空配列と、未取得・項目欠落を区別する。**
//    accounts[id].storeIds が配列として存在し complete!==false なら、
//    たとえ空配列でも「アクセス可能店舗なし」が確定した情報として扱い、名簿へ戻さない。
//    storeIds が無い / complete:false のときだけ名簿（shop_ids / shop_id）へフォールバックする。
export function staffStoreScope(staff, accounts) {
  const id = str(staff && staff.id);
  const acc = (accounts && typeof accounts === 'object') ? accounts[id] : null;
  const hasField = !!acc && Array.isArray(acc.storeIds);
  const confirmed = hasField && acc.complete !== false;
  if (confirmed) {
    return { storeIds: uniq(acc.storeIds.map(str).filter(Boolean)), source: 'account', authoritative: true };
  }
  const multi = arr(staff && staff.shop_ids).map(str).filter(Boolean);
  if (multi.length) return { storeIds: uniq(multi), source: 'roster', authoritative: false, unknownAccount: !!acc };
  const one = str(staff && staff.shop_id);
  if (one) return { storeIds: [one], source: 'roster', authoritative: false, unknownAccount: !!acc };
  return { storeIds: [], source: 'none', authoritative: false, unknownAccount: !!acc };
}

// 後方互換の薄いラッパ（店舗ID配列だけが欲しいとき）
export function staffStoreIds(staff, accounts) {
  return staffStoreScope(staff, accounts).storeIds;
}

// ── 入力の健全性チェック（取得失敗で大量削除しないためのガード）─────────────
export function checkSourceHealth(input) {
  const { shops, staffs, source = {}, previous = {}, limits = {} } = input || {};
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const problems = [];
  const shopList = arr(shops), staffList = arr(staffs);

  // 明示的に false ＝ 取得失敗が判明している → 中止
  if (source.shopsComplete === false) problems.push({ code: 'shops_incomplete', level: 'abort', message: '店舗一覧の取得が不完全（ページ取得漏れ / API障害）' });
  if (!shopList.length) problems.push({ code: 'shops_empty', level: 'abort', message: '店舗一覧が0件（取得失敗とみなす）' });
  // ⚠️ C. 未指定（undefined）を「全件取得済み」と推定しない。破壊的操作（削除・アーカイブ）だけ保留する。
  if (source.shopsComplete === undefined) problems.push({ code: 'shops_completeness_unknown', level: 'no_destructive', message: '店舗一覧の完全性が不明（shopsComplete 未指定）のため、アーカイブと削除を保留' });

  if (source.staffsComplete === false) problems.push({ code: 'staffs_incomplete', level: 'no_remove', message: 'スタッフ名簿の取得が不完全のため、追加のみ行い削除は保留' });
  if (!staffList.length) problems.push({ code: 'staffs_empty', level: 'no_remove', message: 'スタッフ名簿が0件のため、削除は行わない' });
  if (source.staffsComplete === undefined) problems.push({ code: 'staffs_completeness_unknown', level: 'no_remove', message: 'スタッフ名簿の完全性が不明（staffsComplete 未指定）のため、削除を保留' });

  const prevShops = Number(previous.shopCount) || 0;
  const prevStaffs = Number(previous.staffCount) || 0;
  if (prevShops && shopList.length < prevShops * lim.minShopRatio) {
    problems.push({ code: 'shops_shrunk', level: 'abort', message: `店舗数が前回(${prevShops})から${shopList.length}へ急減。取得失敗の可能性` });
  }
  if (prevStaffs && staffList.length < prevStaffs * lim.minStaffRatio) {
    problems.push({ code: 'staffs_shrunk', level: 'no_remove', message: `スタッフ数が前回(${prevStaffs})から${staffList.length}へ急減。削除は保留` });
  }

  const abort = problems.some(p => p.level === 'abort');
  const blocked = (lv) => problems.some(p => p.level === lv);
  return {
    problems,
    abort,
    // 削除（メンバー除外）を実行してよいか
    allowRemove: !abort && !blocked('no_remove') && !blocked('no_destructive'),
    // アーカイブ（閉店扱い）を実行してよいか
    allowArchive: !abort && !blocked('no_destructive'),
  };
}

const emptyPlan = () => ({
  version: CHAT_SYNC_VERSION,
  dryRun: true,
  aborted: false,
  problems: [],
  create: [], bind: [], rename: [], archive: [],
  memberAdd: [], memberRemove: [],
  review: [], accessNotes: [],
  stats: {},
});

// D. 実行候補と保留を必ず区別する。
//    plan の各項目は apply:'ready'（そのまま実行してよい）か apply:'hold'（人の確認が要る）を持つ。
export const APPLY_READY = 'ready';
export const APPLY_HOLD = 'hold';
const ready = (item) => ({ ...item, apply: APPLY_READY });
const hold = (item, holdReason) => ({ ...item, apply: APPLY_HOLD, holdReason: str(holdReason) });

const PLAN_ITEM_KEYS = ['create', 'bind', 'rename', 'archive', 'memberAdd', 'memberRemove'];

// 実行してよい項目だけを取り出す
export function readyItems(plan, key) {
  const pick = (k) => arr(plan && plan[k]).filter(x => x && x.apply !== APPLY_HOLD);
  if (key) return pick(key);
  return Object.fromEntries(PLAN_ITEM_KEYS.map(k => [k, pick(k)]));
}
// 保留中の項目（＋要確認）をまとめて取り出す
export function heldItems(plan) {
  const out = [];
  for (const k of PLAN_ITEM_KEYS) {
    for (const x of arr(plan && plan[k])) if (x && x.apply === APPLY_HOLD) out.push({ kind: k, ...x });
  }
  return out;
}

// E. テナント一致（レコードに tenantId が無ければ対象テナントのものとみなす＝既存データ互換）
const sameTenant = (rec, tenantId) => {
  const t = str((rec && (rec.tenantId ?? rec.tenant_id)) || '');
  return !t || t === tenantId;
};

// ── 店舗ルームの差分 ─────────────────────────────────────────────────────
export function planStoreRoomSync(input) {
  const plan = emptyPlan();
  const {
    rooms = [], shops = [], staffs = [], accounts = {}, hqMembers = [],
    limits = {}, tenantId: rawTenant, scope = null,
  } = input || {};
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const tenantId = str(rawTenant) || 'default';

  // E. 別テナントのレコードは同じ plan に混ぜない（数えるだけ）
  const roomsT = arr(rooms).filter(r => sameTenant(r, tenantId));
  const shopsT = arr(shops).filter(x => sameTenant(x, tenantId));
  const staffsT = arr(staffs).filter(x => sameTenant(x, tenantId));
  const excludedByTenant = {
    rooms: arr(rooms).length - roomsT.length,
    shops: arr(shops).length - shopsT.length,
    staffs: arr(staffs).length - staffsT.length,
  };

  const health = checkSourceHealth({ ...input, shops: shopsT, staffs: staffsT });
  plan.problems = health.problems;
  plan.tenantId = tenantId;
  if (health.abort) {
    plan.aborted = true;
    plan.review.push({ kind: 'source', subject: '同期の中止', reason: health.problems.filter(p => p.level === 'abort').map(p => p.message).join(' / ') });
    plan.stats = { excludedByTenant };
    return plan;
  }
  const allowRemove = health.allowRemove;
  const allowArchive = health.allowArchive;

  // E. この同期が対象にしている店舗の範囲（部分取得のとき）。
  //    範囲外の店舗が一覧に無くても「閉店」と解釈しない。
  const scopeIds = arr(scope && scope.storeIds).map(str).filter(Boolean);
  const scoped = scopeIds.length > 0;
  const inScope = (storeId) => !scoped || scopeIds.includes(str(storeId));

  const storeRooms = roomsT.filter(isStoreRoom);
  const byName = indexShopsByName(shopsT);
  const shopById = new Map(shopsT.map(x => [str(x && x.id), x]).filter(([id]) => id));

  // 1) 既存 store ルーム → store_id の紐付け（ID は変えない）
  const roomOfStore = new Map();
  const ambiguousRoomIds = new Set();      // D. 要確認に出した Room は自動適用しない
  for (const room of storeRooms) {
    const rid = str(room.id);
    const already = str(room.storeId);
    if (already) {
      if (!shopById.has(already)) {
        if (!inScope(already)) {
          // 取得対象外の店舗 → 閉店ではない。何もしない（保留として記録）。
          plan.archive.push(hold({ roomId: rid, storeId: already, reason: '今回の取得範囲外の店舗のため状態を判断できない' }, 'out_of_scope'));
        } else if (!allowArchive) {
          plan.archive.push(hold({ roomId: rid, storeId: already, reason: `店舗一覧に store_id=${already} が無いが、一覧の完全性が確認できない` }, 'source_completeness_unknown'));
        } else if (str(room.status || 'active') === 'active') {
          plan.archive.push(ready({ roomId: rid, storeId: already, reason: `SalonOne の店舗一覧に store_id=${already} が存在しない（閉店/統合の可能性）` }));
        }
        continue;
      }
      roomOfStore.set(already, room);
      const shop = shopById.get(already);
      if (normalizeShopName(shop.name) !== normalizeShopName(roomShopName(room))) {
        plan.rename.push(ready({ roomId: rid, from: roomShopName(room), to: str(shop.name), storeId: already }));
      }
      continue;
    }
    // storeId 未設定 → 完全一致でのみ紐付ける（部分一致は禁止）
    const key = normalizeShopName(roomShopName(room));
    const hits = byName.get(key) || [];
    if (hits.length === 1) {
      const hit = hits[0];
      if (roomOfStore.has(hit.id)) {
        ambiguousRoomIds.add(rid);
        plan.review.push({ kind: 'room_bind', subject: rid, reason: `store_id=${hit.id} には既に別の Room(${str(roomOfStore.get(hit.id).id)}) が紐付いている`, candidates: hits });
        continue;
      }
      plan.bind.push(ready({ roomId: rid, storeId: hit.id, shopName: hit.name, matchedBy: 'exact_name' }));
      roomOfStore.set(hit.id, { ...room, storeId: hit.id });
    } else if (hits.length > 1) {
      ambiguousRoomIds.add(rid);
      plan.review.push({ kind: 'room_bind', subject: rid, reason: `同名の店舗が ${hits.length} 件あり store_id を一意に決められない`, candidates: hits });
    } else {
      ambiguousRoomIds.add(rid);
      plan.review.push({ kind: 'room_bind', subject: rid, reason: '店舗一覧に完全一致する店舗名が無い（部分一致では紐付けない）', candidates: [] });
    }
  }

  // 2) Room が無い店舗 → 作成予定（同名店舗は要確認扱いで保留）
  const usedRoomIds = new Set(roomsT.map(r => str(r && r.id)));
  for (const sp of shopsT) {
    const sid = str(sp && sp.id); const sname = str(sp && sp.name);
    if (!sid || !sname) continue;
    if (roomOfStore.has(sid)) continue;
    if (!inScope(sid)) continue;
    const sameName = (byName.get(normalizeShopName(sname)) || []).length > 1;
    const plainId = `store_${sname.trim()}`;
    const collides = usedRoomIds.has(plainId);
    let newId = plainId;
    let holdReason = '';
    if (sameName) { newId = `${plainId}__${sid}`; holdReason = 'same_name_shops'; plan.review.push({ kind: 'room_create', subject: newId, reason: `同名の店舗が複数あるため、自動では作成しない（${sname} / store_id=${sid}）` }); }
    else if (collides) { newId = `${plainId}__${sid}`; holdReason = 'room_id_collision'; plan.review.push({ kind: 'room_create', subject: newId, reason: `Room ID ${plainId} が既に使われているため、自動では作成しない` }); }
    usedRoomIds.add(newId);
    const item = { roomId: newId, kind: 'store', name: sname, storeId: sid, reason: '店舗に対応する Room が無い' };
    plan.create.push(holdReason ? hold(item, holdReason) : ready(item));
    // 保留中の Room はメンバー計算の対象にしない（作られないため）
    if (!holdReason) roomOfStore.set(sid, { id: newId, kind: 'store', name: sname, shop: sname, storeId: sid, members: [], autoMembers: [] });
  }

  // 3) 所属メンバーの差分（自動所属のみを対象にする）
  const hq = uniq(arr(hqMembers).map(str).filter(Boolean));
  const desiredByStore = new Map();
  const retired = new Set();
  for (const st of staffsT) {
    const id = str(st && st.id);
    if (!id) continue;
    if (st.deleted) { retired.add(id); continue; }
    const sc = staffStoreScope(st, accounts);
    if (sc.source === 'roster' && sc.unknownAccount) {
      plan.review.push({ kind: 'member_scope_unknown', subject: id, reason: 'アクセス権限（accessible_store_ids）が未取得のため、名簿の配属で暫定的に判断した' });
    }
    for (const sid of sc.storeIds) {
      if (!desiredByStore.has(sid)) desiredByStore.set(sid, new Set());
      desiredByStore.get(sid).add(id);
    }
  }
  // accounts 側にだけ現れる（名簿に居ない）人は勝手に入れない
  for (const [staffId, acc] of Object.entries(accounts || {})) {
    const known = staffsT.some(x => str(x && x.id) === str(staffId));
    if (!known && arr(acc && acc.storeIds).length) {
      plan.review.push({ kind: 'member', subject: str(staffId), reason: 'アクセス権限（accessible_store_ids）はあるがスタッフ名簿に存在しない。名簿の取得漏れか退職済みの可能性' });
    }
  }

  let totalAutoNow = 0; const pendingRemove = [];
  for (const [storeId, room] of roomOfStore.entries()) {
    const rid = str(room.id);
    if (ambiguousRoomIds.has(rid)) continue;                 // D. 要確認の Room は触らない
    const current = uniq(arr(room.members).map(str));
    const auto = uniq(arr(room.autoMembers).map(str));
    totalAutoNow += auto.length;
    const desired = uniq([...(desiredByStore.get(storeId) || []), ...hq]);

    const add = desired.filter(id => !current.includes(id));
    if (add.length) plan.memberAdd.push(ready({ roomId: rid, storeId, staffIds: add, reason: '在籍/アクセス権限に基づく自動所属' }));

    const remove = auto.filter(id => current.includes(id) && !desired.includes(id));
    if (remove.length) pendingRemove.push({ roomId: rid, storeId, staffIds: remove, reason: '異動 / 退職 / 権限剥奪により自動所属から外れた' });

    const manualRetired = current.filter(id => retired.has(id) && !auto.includes(id));
    if (manualRetired.length) {
      plan.review.push({ kind: 'member_manual_retired', subject: rid, reason: '退職者だが手動追加メンバーのため自動削除しない（表示のみの問題。閲覧権限は authz 側で即時失効）', staffIds: manualRetired });
    }
  }

  // 4) 削除の安全弁
  const removeCount = pendingRemove.reduce((n, r) => n + r.staffIds.length, 0);
  const ratioTripped = removeCount > lim.removeFloor
    && totalAutoNow >= lim.ratioMinPopulation
    && (removeCount / totalAutoNow) > lim.maxRemoveRatio;
  if (!allowRemove) {
    for (const r of pendingRemove) plan.memberRemove.push(hold(r, '名簿の取得状況が確認できないため削除を保留'));
  } else if (removeCount > lim.maxRemovePerRun || ratioTripped) {
    plan.problems.push({ code: 'remove_cap', level: 'no_remove', message: `削除予定 ${removeCount} 件が上限（${lim.maxRemovePerRun} 件 / ${Math.round(lim.maxRemoveRatio * 100)}%）を超えたため保留` });
    for (const r of pendingRemove) plan.memberRemove.push(hold(r, '1回の同期で削除しすぎるため保留（取得漏れの可能性）'));
  } else {
    for (const r of pendingRemove) plan.memberRemove.push(ready(r));
  }

  // 5) アクセス失効は別処理であることを明示（表示更新を待たない）
  if (retired.size) {
    plan.accessNotes.push({
      kind: 'access_revocation',
      staffIds: [...retired],
      note: '退職/削除されたスタッフの閲覧権限は SalonOne の権限（/me）と authz で即時に失効する。Room メンバー表示の更新（本 plan）を待たない。',
    });
  }

  const cnt = (k, f = (x) => 1) => arr(plan[k]).filter(x => x.apply !== APPLY_HOLD).reduce((n, x) => n + f(x), 0);
  plan.stats = {
    tenantId, excludedByTenant, scoped,
    shops: shopsT.length, staffs: staffsT.length, storeRooms: storeRooms.length,
    create: cnt('create'), bind: cnt('bind'), rename: cnt('rename'), archive: cnt('archive'),
    memberAdd: cnt('memberAdd', x => x.staffIds.length),
    memberRemove: cnt('memberRemove', x => x.staffIds.length),
    held: heldItems(plan).length,
    review: plan.review.length,
    allowRemove, allowArchive,
  };
  return plan;
}

// ── イベント（勉強会・部活等）ルームの差分 ────────────────────────────────
// 既存の evSaveChat / evJoinChat の仕組みをそのまま使う前提:
//   - Room は kind:'group'（変更しない）／行の cells.roomId で紐付く
//   - 責任者(ownerId) と 参加者(participantIds) を自動所属、self-join は手動扱い
export function planEventRoomSync(input) {
  const plan = emptyPlan();
  const {
    rooms = [], events = [], staffs = [], now = Date.now(), autoCloseDays = null,
    source = {}, tenantId: rawTenant,
  } = input || {};
  const tenantId = str(rawTenant) || 'default';
  plan.tenantId = tenantId;

  // E. 別テナントのレコードは混ぜない
  const roomsT = arr(rooms).filter(r => sameTenant(r, tenantId));
  const eventsT = arr(events).filter(e => sameTenant(e, tenantId));
  const staffsT = arr(staffs).filter(x => sameTenant(x, tenantId));

  const roomById = new Map(roomsT.map(r => [str(r && r.id), r]).filter(([id]) => id));
  const knownStaff = new Set(staffsT.filter(x => x && !x.deleted).map(x => str(x.id)));
  // B. 名簿が0件・不完全でも「全員有効」としない。名簿で確認できた人だけ追加する。
  const rosterUsable = knownStaff.size > 0 && source.staffsComplete !== false;

  for (const ev of eventsT) {
    const cells = (ev && ev.cells) || {};
    const evId = str(cells.eventId || ev.id);
    const title = str(cells.chatTitle || ev.title || '').trim();
    const roomId = str(cells.roomId);
    const owner = str(cells.ownerId);
    const participants = uniq(arr(cells.participantIds).map(str).filter(Boolean));
    const wanted = uniq([owner, ...participants].filter(Boolean));

    // 名簿で在籍が確認できた人だけを追加対象にする（確認できない人は保留）
    const verified = wanted.filter(id => knownStaff.has(id));
    const unverified = wanted.filter(id => !knownStaff.has(id));
    if (unverified.length) {
      plan.review.push({
        kind: 'event_member_held', subject: evId || title || roomId,
        reason: rosterUsable
          ? 'スタッフ名簿に存在しない参加者IDのため追加を保留'
          : 'スタッフ名簿が0件/不完全で在籍を確認できないため追加を保留',
        staffIds: unverified,
      });
    }

    if (!roomId) {
      if (!title) { plan.review.push({ kind: 'event_room', subject: evId, reason: 'グループ名（chatTitle）が空のため Room を作成できない' }); continue; }
      const item = { roomId: '(新規)', kind: 'group', name: title, eventId: evId, members: verified, reason: 'イベント行に紐付く Room が無い' };
      // 参加者を1人も確認できない場合は、作成そのものを保留（空の招待を避ける）
      plan.create.push(verified.length ? ready(item) : hold(item, '在籍を確認できる参加者が居ない'));
      continue;
    }
    const room = roomById.get(roomId);
    if (!room) { plan.review.push({ kind: 'event_room', subject: evId || title, reason: `行に記録された roomId=${roomId} の Room が存在しない（削除済みの可能性）` }); continue; }

    if (evId && !str(room.eventId)) plan.bind.push(ready({ roomId, eventId: evId, matchedBy: 'event_row', name: title }));
    if (title && normalizeShopName(room.name) !== normalizeShopName(title)) plan.rename.push(ready({ roomId, from: str(room.name), to: title, eventId: evId }));

    const current = uniq(arr(room.members).map(str));
    const add = verified.filter(id => !current.includes(id));
    if (add.length) plan.memberAdd.push(ready({ roomId, eventId: evId, staffIds: add, reason: 'イベントの責任者 / 参加者（在籍を確認済み）' }));

    // ⚠️ self-join があるため、参加者リストに無い人を自動削除しない。
    const auto = uniq(arr(room.autoMembers).map(str));
    const strayAuto = auto.filter(id => current.includes(id) && !verified.includes(id));
    if (strayAuto.length) plan.review.push({ kind: 'event_member_remove', subject: roomId, reason: '参加者リストから外れたが、self-join の可能性があるため自動削除しない', staffIds: strayAuto });

    // 終了後の扱い（既定は何もしない）
    if (autoCloseDays && str(room.status || 'active') === 'active') {
      const d = Date.parse(str(cells.date));
      if (Number.isFinite(d) && now - d > autoCloseDays * 86400000) {
        plan.archive.push(ready({ roomId, reason: `イベント終了から ${autoCloseDays} 日経過（メッセージは残す）`, eventId: evId }));
      }
    }
  }
  const cnt = (k, f = () => 1) => arr(plan[k]).filter(x => x.apply !== APPLY_HOLD).reduce((n, x) => n + f(x), 0);
  plan.stats = {
    tenantId, events: eventsT.length, rosterUsable,
    create: cnt('create'), bind: cnt('bind'), rename: cnt('rename'), archive: cnt('archive'),
    memberAdd: cnt('memberAdd', x => x.staffIds.length),
    memberRemove: 0,
    held: heldItems(plan).length,
    review: plan.review.length,
  };
  return plan;
}

// 店舗ルーム＋イベントルームの差分をまとめて返す
export function planChatSync(input) {
  const store = planStoreRoomSync(input);
  const event = store.aborted ? emptyPlan() : planEventRoomSync(input);
  const merged = emptyPlan();
  merged.tenantId = store.tenantId;
  merged.aborted = store.aborted;
  merged.problems = [...store.problems, ...event.problems];
  for (const k of ['create', 'bind', 'rename', 'archive', 'memberAdd', 'memberRemove', 'review', 'accessNotes']) {
    merged[k] = [...store[k], ...event[k]];
  }
  merged.stats = { store: store.stats, event: event.stats };
  return merged;
}

// 実行予定（apply:'ready'）がゼロか。保留（hold）は「実行しない」ので noop 扱い。
export function isNoop(plan) {
  if (!plan) return true;
  const r = readyItems(plan);
  return PLAN_ITEM_KEYS.every(k => r[k].length === 0);
}

// ── テスト / プレビュー専用: plan を rooms に適用した結果を返す ──────────────
// ⚠️ **本番の適用エンジンとして使ってはいけない。**
//    競合制御・権限確認・監査・承認を一切行わないため、実データへの適用は
//    既存の ensureRooms / setMembers / setRoom（＋①の承認・監査）を通すこと。
//    apply:'hold' の項目は適用しない（要確認のものを自動で流さない）。
export function applyPlanForTest(rooms, plan) {
  const only = readyItems(plan);
  plan = { ...plan, ...only };
  let out = arr(rooms).map(r => ({ ...r, members: uniq(arr(r.members).map(str)), autoMembers: uniq(arr(r.autoMembers).map(str)) }));
  const byId = new Map(out.map(r => [str(r.id), r]));
  for (const c of arr(plan && plan.create)) {
    if (str(c.roomId) === '(新規)') continue;
    const room = {
      id: str(c.roomId), kind: c.kind || 'group', name: str(c.name), shop: c.kind === 'store' ? str(c.name) : '',
      storeId: str(c.storeId || ''), eventId: str(c.eventId || ''), members: uniq(arr(c.members).map(str)),
      autoMembers: uniq(arr(c.members).map(str)), status: 'active', createdBy: '__system__',
    };
    out.push(room); byId.set(room.id, room);
  }
  for (const b of arr(plan && plan.bind)) {
    const r = byId.get(str(b.roomId)); if (!r) continue;
    if (b.storeId) r.storeId = str(b.storeId);
    if (b.eventId) r.eventId = str(b.eventId);
  }
  for (const rn of arr(plan && plan.rename)) {
    const r = byId.get(str(rn.roomId)); if (!r) continue;
    r.name = str(rn.to); if (r.kind === 'store') r.shop = str(rn.to);
  }
  for (const a of arr(plan && plan.archive)) {
    const r = byId.get(str(a.roomId)); if (!r) continue; r.status = 'archived';
  }
  for (const m of arr(plan && plan.memberAdd)) {
    const r = byId.get(str(m.roomId)); if (!r) continue;
    r.members = uniq([...r.members, ...arr(m.staffIds).map(str)]);
    r.autoMembers = uniq([...r.autoMembers, ...arr(m.staffIds).map(str)]);
  }
  for (const m of arr(plan && plan.memberRemove)) {
    const r = byId.get(str(m.roomId)); if (!r) continue;
    const del = new Set(arr(m.staffIds).map(str));
    r.members = r.members.filter(id => !del.has(id));
    r.autoMembers = r.autoMembers.filter(id => !del.has(id));
  }
  return out;
}

// 画面表示用のサマリ（同期差分プレビューで使う）
export function summarizePlan(plan) {
  const p = plan || emptyPlan();
  const r = readyItems(p);
  const count = (k) => arr(r[k]).length;
  const people = (k) => arr(r[k]).reduce((n, x) => n + arr(x.staffIds).length, 0);
  const held = heldItems(p);
  const heldPeople = held.reduce((n, x) => n + arr(x.staffIds).length, 0);
  return {
    aborted: !!p.aborted,
    noop: isNoop(p),
    tenantId: str(p.tenantId) || 'default',
    createRooms: count('create'),
    bindIds: count('bind'),
    renames: count('rename'),
    archives: count('archive'),
    addPeople: people('memberAdd'),
    removePeople: people('memberRemove'),
    heldItems: held.length,
    heldPeople,
    reviews: arr(p.review).length,
    problems: arr(p.problems).length,
  };
}
