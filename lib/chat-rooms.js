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
export function staffStoreIds(staff, accounts) {
  const id = str(staff && staff.id);
  const acc = (accounts && typeof accounts === 'object') ? accounts[id] : null;
  const fromAcc = arr(acc && acc.storeIds).map(str).filter(Boolean);
  if (fromAcc.length) return uniq(fromAcc);
  const multi = arr(staff && staff.shop_ids).map(str).filter(Boolean);
  if (multi.length) return uniq(multi);
  const one = str(staff && staff.shop_id);
  return one ? [one] : [];
}

// ── 入力の健全性チェック（取得失敗で大量削除しないためのガード）─────────────
export function checkSourceHealth(input) {
  const { shops, staffs, source = {}, previous = {}, limits = {} } = input || {};
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const problems = [];
  const shopList = arr(shops), staffList = arr(staffs);

  if (source.shopsComplete === false) problems.push({ code: 'shops_incomplete', level: 'abort', message: '店舗一覧の取得が不完全（ページ取得漏れ / API障害）' });
  if (!shopList.length) problems.push({ code: 'shops_empty', level: 'abort', message: '店舗一覧が0件（取得失敗とみなす）' });
  if (source.staffsComplete === false) problems.push({ code: 'staffs_incomplete', level: 'no_remove', message: 'スタッフ名簿の取得が不完全のため、追加のみ行い削除は保留' });
  if (!staffList.length) problems.push({ code: 'staffs_empty', level: 'no_remove', message: 'スタッフ名簿が0件のため、削除は行わない' });

  const prevShops = Number(previous.shopCount) || 0;
  const prevStaffs = Number(previous.staffCount) || 0;
  if (prevShops && shopList.length < prevShops * lim.minShopRatio) {
    problems.push({ code: 'shops_shrunk', level: 'abort', message: `店舗数が前回(${prevShops})から${shopList.length}へ急減。取得失敗の可能性` });
  }
  if (prevStaffs && staffList.length < prevStaffs * lim.minStaffRatio) {
    problems.push({ code: 'staffs_shrunk', level: 'no_remove', message: `スタッフ数が前回(${prevStaffs})から${staffList.length}へ急減。削除は保留` });
  }
  return {
    problems,
    abort: problems.some(p => p.level === 'abort'),
    allowRemove: !problems.some(p => p.level === 'no_remove' || p.level === 'abort'),
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

// ── 店舗ルームの差分 ─────────────────────────────────────────────────────
export function planStoreRoomSync(input) {
  const plan = emptyPlan();
  const { rooms = [], shops = [], staffs = [], accounts = {}, hqMembers = [], limits = {} } = input || {};
  const lim = { ...DEFAULT_LIMITS, ...limits };

  const health = checkSourceHealth(input);
  plan.problems = health.problems;
  if (health.abort) {
    plan.aborted = true;
    plan.review.push({ kind: 'source', subject: '同期の中止', reason: health.problems.filter(p => p.level === 'abort').map(p => p.message).join(' / ') });
    return plan;
  }
  const allowRemove = health.allowRemove;

  const storeRooms = arr(rooms).filter(isStoreRoom);
  const byName = indexShopsByName(shops);
  const shopById = new Map(arr(shops).map(s => [str(s && s.id), s]).filter(([id]) => id));

  // 1) 既存 store ルーム → store_id の紐付け（ID は変えない）
  const roomOfStore = new Map();          // storeId → room
  const boundRoomIds = new Set();
  for (const room of storeRooms) {
    const rid = str(room.id);
    const already = str(room.storeId);
    if (already) {
      if (!shopById.has(already)) {
        // SalonOne 側に無い店舗（閉店・統合・ID変更）→ 削除せず archive 候補
        if (str(room.status || 'active') === 'active') {
          plan.archive.push({ roomId: rid, reason: `SalonOne の店舗一覧に store_id=${already} が存在しない（閉店/統合の可能性）` });
        }
        continue;
      }
      roomOfStore.set(already, room); boundRoomIds.add(rid);
      const shop = shopById.get(already);
      if (normalizeShopName(shop.name) !== normalizeShopName(roomShopName(room))) {
        // 店舗名が変わった → 同じ Room のまま表示名だけ更新
        plan.rename.push({ roomId: rid, from: roomShopName(room), to: str(shop.name), storeId: already });
      }
      continue;
    }
    // storeId 未設定 → 完全一致でのみ紐付ける（部分一致は禁止）
    const key = normalizeShopName(roomShopName(room));
    const hits = byName.get(key) || [];
    if (hits.length === 1) {
      const hit = hits[0];
      if (roomOfStore.has(hit.id)) {
        plan.review.push({ kind: 'room_bind', subject: rid, reason: `store_id=${hit.id} には既に別の Room(${str(roomOfStore.get(hit.id).id)}) が紐付いている`, candidates: hits });
        continue;
      }
      plan.bind.push({ roomId: rid, storeId: hit.id, shopName: hit.name, matchedBy: 'exact_name' });
      roomOfStore.set(hit.id, { ...room, storeId: hit.id }); boundRoomIds.add(rid);
    } else if (hits.length > 1) {
      plan.review.push({ kind: 'room_bind', subject: rid, reason: `同名の店舗が ${hits.length} 件あり store_id を一意に決められない`, candidates: hits });
    } else {
      plan.review.push({ kind: 'room_bind', subject: rid, reason: '店舗一覧に完全一致する店舗名が無い（部分一致では紐付けない）', candidates: [] });
    }
  }

  // 2) Room が無い店舗 → 作成予定（ID は既存規約 store_<店舗名>。衝突時のみ store_id を付ける）
  const usedRoomIds = new Set(arr(rooms).map(r => str(r && r.id)));
  for (const s of arr(shops)) {
    const sid = str(s && s.id); const sname = str(s && s.name);
    if (!sid || !sname) continue;
    if (roomOfStore.has(sid)) continue;
    let newId = `store_${sname.trim()}`;
    const sameName = (byName.get(normalizeShopName(sname)) || []).length > 1;
    if (usedRoomIds.has(newId) || sameName) {
      // 同名店舗・ID 衝突 → 既存 Room を横取りせず、別 ID で作る（要確認にも出す）
      newId = `store_${sname.trim()}__${sid}`;
      plan.review.push({ kind: 'room_create', subject: newId, reason: sameName ? `同名の店舗が複数あるため store_id 付きの Room ID で作成する（${sname}）` : `Room ID ${'store_' + sname.trim()} が既に使われているため store_id 付きで作成する` });
    }
    usedRoomIds.add(newId);
    plan.create.push({ roomId: newId, kind: 'store', name: sname, storeId: sid, reason: '店舗に対応する Room が無い' });
    roomOfStore.set(sid, { id: newId, kind: 'store', name: sname, shop: sname, storeId: sid, members: [], autoMembers: [] });
  }

  // 3) 所属メンバーの差分（自動所属のみを対象にする）
  const hq = uniq(arr(hqMembers).map(str).filter(Boolean));
  const desiredByStore = new Map();       // storeId → Set(staffId)
  const retired = new Set();
  for (const st of arr(staffs)) {
    const id = str(st && st.id);
    if (!id) continue;
    if (st.deleted) { retired.add(id); continue; }
    for (const sid of staffStoreIds(st, accounts)) {
      if (!desiredByStore.has(sid)) desiredByStore.set(sid, new Set());
      desiredByStore.get(sid).add(id);
    }
  }
  // accounts 側にだけ現れる兼務（名簿に居ない人）は勝手に入れない
  for (const [staffId, acc] of Object.entries(accounts || {})) {
    const known = arr(staffs).some(s => str(s && s.id) === str(staffId));
    if (!known && arr(acc && acc.storeIds).length) {
      plan.review.push({ kind: 'member', subject: str(staffId), reason: 'アクセス権限（accessible_store_ids）はあるがスタッフ名簿に存在しない。名簿の取得漏れか退職済みの可能性' });
    }
  }

  let totalAutoNow = 0, pendingRemove = [];
  for (const [storeId, room] of roomOfStore.entries()) {
    const rid = str(room.id);
    const current = uniq(arr(room.members).map(str));
    const auto = uniq(arr(room.autoMembers).map(str));
    totalAutoNow += auto.length;
    const desired = uniq([...(desiredByStore.get(storeId) || []), ...hq]);

    const add = desired.filter(id => !current.includes(id));
    if (add.length) plan.memberAdd.push({ roomId: rid, storeId, staffIds: add, reason: '在籍/アクセス権限に基づく自動所属' });

    // 削除対象は「自動で入れた人のうち、もう所属していない人」だけ。
    // 手動追加・self-join（auto に無い）は対象外。
    const remove = auto.filter(id => current.includes(id) && !desired.includes(id));
    if (remove.length) pendingRemove.push({ roomId: rid, storeId, staffIds: remove, reason: '異動 / 退職 / 権限剥奪により自動所属から外れた' });

    // 退職者が手動メンバーとして残っている場合は自動削除せず要確認に出す
    const manualRetired = current.filter(id => retired.has(id) && !auto.includes(id));
    if (manualRetired.length) {
      plan.review.push({ kind: 'member_manual_retired', subject: rid, reason: '退職者だが手動追加メンバーのため自動削除しない（表示のみの問題。閲覧権限は authz 側で即時失効）', staffIds: manualRetired });
    }
  }

  // 4) 削除の安全弁
  const removeCount = pendingRemove.reduce((n, r) => n + r.staffIds.length, 0);
  // 比率の判定は「母集団が十分にあり、かつ削除が少数でない」ときだけ使う。
  // （1人の異動・退職のような通常運用を止めないため）
  const ratioTripped = removeCount > lim.removeFloor
    && totalAutoNow >= lim.ratioMinPopulation
    && (removeCount / totalAutoNow) > lim.maxRemoveRatio;
  if (!allowRemove) {
    for (const r of pendingRemove) plan.review.push({ kind: 'member_remove_held', subject: r.roomId, reason: '名簿の取得が不完全なため削除を保留', staffIds: r.staffIds });
  } else if (removeCount > lim.maxRemovePerRun || ratioTripped) {
    plan.problems.push({ code: 'remove_cap', level: 'no_remove', message: `削除予定 ${removeCount} 件が上限（${lim.maxRemovePerRun} 件 / ${Math.round(lim.maxRemoveRatio * 100)}%）を超えたため保留` });
    for (const r of pendingRemove) plan.review.push({ kind: 'member_remove_held', subject: r.roomId, reason: '1回の同期で削除しすぎるため保留（取得漏れの可能性）', staffIds: r.staffIds });
  } else {
    plan.memberRemove = pendingRemove;
  }

  // 5) アクセス失効は別処理であることを明示（表示更新を待たない）
  if (retired.size) {
    plan.accessNotes.push({
      kind: 'access_revocation',
      staffIds: [...retired],
      note: '退職/削除されたスタッフの閲覧権限は SalonOne の権限（/me）と authz で即時に失効する。Room メンバー表示の更新（本 plan）を待たない。',
    });
  }

  plan.stats = {
    shops: arr(shops).length, staffs: arr(staffs).length, storeRooms: storeRooms.length,
    create: plan.create.length, bind: plan.bind.length, rename: plan.rename.length,
    archive: plan.archive.length,
    memberAdd: plan.memberAdd.reduce((n, r) => n + r.staffIds.length, 0),
    memberRemove: plan.memberRemove.reduce((n, r) => n + r.staffIds.length, 0),
    review: plan.review.length,
    allowRemove,
  };
  return plan;
}

// ── イベント（勉強会・部活等）ルームの差分 ────────────────────────────────
// 既存の evSaveChat / evJoinChat の仕組みをそのまま使う前提:
//   - Room は kind:'group'（変更しない）／行の cells.roomId で紐付く
//   - 責任者(ownerId) と 参加者(participantIds) を自動所属、self-join は手動扱い
export function planEventRoomSync(input) {
  const plan = emptyPlan();
  const { rooms = [], events = [], staffs = [], now = Date.now(), autoCloseDays = null } = input || {};
  const roomById = new Map(arr(rooms).map(r => [str(r && r.id), r]).filter(([id]) => id));
  const knownStaff = new Set(arr(staffs).filter(s => s && !s.deleted).map(s => str(s.id)));

  for (const ev of arr(events)) {
    const cells = (ev && ev.cells) || {};
    const evId = str(cells.eventId || ev.id);
    const title = str(cells.chatTitle || ev.title || '').trim();
    const roomId = str(cells.roomId);
    const owner = str(cells.ownerId);
    const participants = uniq(arr(cells.participantIds).map(str).filter(Boolean));
    const wanted = uniq([owner, ...participants].filter(Boolean));

    // 名簿に居ない参加者は勝手に入れない（IDの取り違え防止）
    const unknown = wanted.filter(id => knownStaff.size && !knownStaff.has(id));
    const desired = wanted.filter(id => !unknown.includes(id));
    if (unknown.length) plan.review.push({ kind: 'event_member', subject: evId || title, reason: 'スタッフ名簿に存在しない参加者IDのため追加しない', staffIds: unknown });

    if (!roomId) {
      if (!title) { plan.review.push({ kind: 'event_room', subject: evId, reason: 'グループ名（chatTitle）が空のため Room を作成できない' }); continue; }
      plan.create.push({ roomId: '(新規)', kind: 'group', name: title, eventId: evId, members: desired, reason: 'イベント行に紐付く Room が無い' });
      continue;
    }
    const room = roomById.get(roomId);
    if (!room) { plan.review.push({ kind: 'event_room', subject: evId || title, reason: `行に記録された roomId=${roomId} の Room が存在しない（削除済みの可能性）` }); continue; }

    if (evId && !str(room.eventId)) plan.bind.push({ roomId, eventId: evId, matchedBy: 'event_row', name: title });
    if (title && normalizeShopName(room.name) !== normalizeShopName(title)) plan.rename.push({ roomId, from: str(room.name), to: title, eventId: evId });

    const current = uniq(arr(room.members).map(str));
    const add = desired.filter(id => !current.includes(id));
    if (add.length) plan.memberAdd.push({ roomId, eventId: evId, staffIds: add, reason: 'イベントの責任者 / 参加者' });

    // ⚠️ イベントは self-join（本人が「グループチャットへ参加」）があるため、
    //    参加者リストに無い人を自動削除しない。削除は人手で行う。
    const auto = uniq(arr(room.autoMembers).map(str));
    const strayAuto = auto.filter(id => current.includes(id) && !desired.includes(id));
    if (strayAuto.length) plan.review.push({ kind: 'event_member_remove', subject: roomId, reason: '参加者リストから外れたが、self-join の可能性があるため自動削除しない', staffIds: strayAuto });

    // 終了後の扱い（既定は何もしない）
    if (autoCloseDays && str(room.status || 'active') === 'active') {
      const d = Date.parse(str(cells.date));
      if (Number.isFinite(d) && now - d > autoCloseDays * 86400000) {
        plan.archive.push({ roomId, reason: `イベント終了から ${autoCloseDays} 日経過（メッセージは残す）`, eventId: evId });
      }
    }
  }
  plan.stats = {
    events: arr(events).length,
    create: plan.create.length, bind: plan.bind.length, rename: plan.rename.length,
    archive: plan.archive.length,
    memberAdd: plan.memberAdd.reduce((n, r) => n + r.staffIds.length, 0),
    memberRemove: 0,
    review: plan.review.length,
  };
  return plan;
}

// 店舗ルーム＋イベントルームの差分をまとめて返す
export function planChatSync(input) {
  const store = planStoreRoomSync(input);
  const event = store.aborted ? emptyPlan() : planEventRoomSync(input);
  const merged = emptyPlan();
  merged.aborted = store.aborted;
  merged.problems = [...store.problems, ...event.problems];
  for (const k of ['create', 'bind', 'rename', 'archive', 'memberAdd', 'memberRemove', 'review', 'accessNotes']) {
    merged[k] = [...store[k], ...event[k]];
  }
  merged.stats = { store: store.stats, event: event.stats };
  return merged;
}

// 差分がゼロか（＝同期しても何も変わらない）。冪等性の確認に使う。
export function isNoop(plan) {
  if (!plan) return true;
  return ['create', 'bind', 'rename', 'archive', 'memberAdd', 'memberRemove'].every(k => arr(plan[k]).length === 0);
}

// ── テスト / プレビュー用: plan を rooms に適用した結果を返す（本番では使わない）──
// 実際の適用は既存の ensureRooms / setMembers / setRoom を通して行う（ここでは行わない）。
export function applyPlanForTest(rooms, plan) {
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
  const count = (k) => arr(p[k]).length;
  const people = (k) => arr(p[k]).reduce((n, r) => n + arr(r.staffIds).length, 0);
  return {
    aborted: !!p.aborted,
    noop: isNoop(p),
    createRooms: count('create'),
    bindIds: count('bind'),
    renames: count('rename'),
    archives: count('archive'),
    addPeople: people('memberAdd'),
    removePeople: people('memberRemove'),
    reviews: count('review'),
    problems: arr(p.problems).length,
  };
}
