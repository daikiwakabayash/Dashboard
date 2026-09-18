// ── Chat 宛先解決（Recipient Resolver）─────────────────────────────
// 「東京の店舗全部に、恵比寿を除いて送って」のような指示を、確定した
// store_id / staff_id の集合へ変換する。純粋関数のみ。tests/chat-recipients.test.js でカバー。
//
// 設計の芯（絶対に崩さない3点）:
//   1. AIは**構造化された宛先指定(spec)を提案するだけ**。誰に届くかを決めるのはこのモジュール。
//      自由文の解釈でそのまま送信しない＝AIの言い間違いが誤送信にならない。
//   2. 曖昧な宛先は**絶対に推測しない**。同名2人なら status='needs_confirmation' を返して止まる。
//      「たぶんこっち」で送った結果は取り消せないため、止まる方を常に選ぶ。
//   3. 宛先は**依頼した人間の権限を超えない**。AIが代行しても、その人が送れない先へは送れない。
//      権限外は黙って落とさず denied.outOfScope に載せて「送れなかった」と言えるようにする。
//
// 真実は名前ではなく **store_id / staff_id**。名前は入口の検索語としてのみ扱う。

// ⚠️ lib/authz.js には**依存しない**。認可は ctx.can として外から注入する。
//    理由: このモジュールは authz とは別のPRで進んでおり、どちらが先に入っても
//    動く必要があるため。authz が入ったら ctx.can = (actor, action, target) => can(...)
//    を渡すだけで接続できる（index.html / api 側の1行）。
//    注入が無い場合は下の fallbackCan（店舗スコープのみを見る保守的な既定）を使う。

// 役割の高さ。authz.js の ROLES と同じ並び・同じ数値に保つこと。
const RANK = Object.freeze({ root: 100, admin: 90, hq: 90, headquarters: 90, owner: 60, manager: 40, staff: 20, guest: 0 });
const MIN_RANK = Object.freeze({
  'chat.send': 20, 'chat.dm': 20, 'chat.group_create': 20,
  'chat.broadcast': 60, 'chat.broadcast_all': 90,
});

export function normalizeActor(raw) {
  const a = (raw && typeof raw === 'object') ? raw : {};
  const role = RANK[String(a.role || '').trim()] !== undefined ? String(a.role).trim() : 'guest';
  return {
    id: String(a.id || '').slice(0, 60),
    name: String(a.name || '').slice(0, 80),
    role,
    source: ['ui', 'agent', 'cron'].includes(a.source) ? a.source : 'ui',
    shops: Array.isArray(a.shops) ? a.shops.map(String) : null,   // null = 全店
    tenantId: String(a.tenantId || 'naoru').trim().toLowerCase(),
    verified: a.verified === true,
  };
}

// 注入が無いときの既定。authz.js より**厳しめ**に倒す（見落としで広く送るより、狭く止める）。
function fallbackCan(actor, action, target) {
  const a = normalizeActor(actor);
  const t = (target && typeof target === 'object') ? target : {};
  const need = MIN_RANK[action];
  if (need === undefined) return { allow: false, code: 'unknown_action', reason: `未定義の操作です: ${action}` };
  if ((RANK[a.role] || 0) < need) return { allow: false, code: 'role_too_low', reason: 'この操作の権限がありません' };
  if (a.shops && t.shop && !a.shops.some(s => normName(s) === normName(t.shop))) {
    return { allow: false, code: 'out_of_scope', reason: 'この店舗へ送る権限がありません' };
  }
  return { allow: true, code: '', reason: '' };
}

// 一括送信で追加確認を要求するしきい値（人数）。
export const BULK_CONFIRM_THRESHOLD = 20;

// 表記ゆれを吸収する。全角英数→半角、空白・記号の除去、店/店舗の接尾辞を落とす。
// 「恵比寿店」「恵比寿 店舗」「ＮＡＯＲＵ恵比寿」を同じ土俵に乗せるため。
export function normName(v) {
  let s = String(v == null ? '' : v);
  s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  s = s.toLowerCase();
  s = s.replace(/[\s　・,，、\-–—_/（）()【】\[\]]/g, '');
  s = s.replace(/(店舗|店|サロン|整骨院)$/g, '');
  return s.trim();
}

// 1つの検索語に対する候補を返す。完全一致が1件でもあれば部分一致は見ない
// （「恵比寿」と「恵比寿西口」が両方あるとき、完全一致の「恵比寿」を勝たせる）。
export function matchCandidates(query, items, field = 'name') {
  const q = normName(query);
  if (!q) return [];
  const list = Array.isArray(items) ? items : [];
  const exact = list.filter(x => normName(x && x[field]) === q);
  if (exact.length) return exact;
  return list.filter(x => normName(x && x[field]).includes(q));
}

// 検索語の集合を解決する。
//   resolved   : 候補がちょうど1件だった語（確定）
//   ambiguous  : 候補が2件以上だった語（人に選ばせる。推測しない）
//   unresolved : 候補が0件だった語（存在しない。勝手に近い名前へ寄せない）
export function resolveNames(queries, items, field = 'name') {
  const out = { resolved: [], ambiguous: [], unresolved: [] };
  for (const q of (Array.isArray(queries) ? queries : [])) {
    const text = String(q == null ? '' : q).trim();
    if (!text) continue;
    const c = matchCandidates(text, items, field);
    if (c.length === 1) out.resolved.push({ query: text, item: c[0] });
    else if (c.length === 0) out.unresolved.push({ query: text });
    else out.ambiguous.push({ query: text, candidates: c.slice(0, 10) });
  }
  return out;
}

// 宛先指定(spec)を正規化する。AIが欠けたキーを返しても落ちないようにする。
export function normalizeSpec(raw) {
  const s = (raw && typeof raw === 'object') ? raw : {};
  const arr = (v) => (Array.isArray(v) ? v.map(x => String(x == null ? '' : x).trim()).filter(Boolean).slice(0, 500) : []);
  const ex = (s.exclude && typeof s.exclude === 'object') ? s.exclude : {};
  return {
    scope: ['store', 'staff', 'role', 'area', 'all', 'mixed'].includes(s.scope) ? s.scope : 'mixed',
    shops: arr(s.shops),
    staff: arr(s.staff),
    roles: arr(s.roles),
    areas: arr(s.areas),
    exclude: { shops: arr(ex.shops), staff: arr(ex.staff) },
    raw: String(s.raw || '').slice(0, 500),
  };
}

// 店舗の集合を組み立てる（shops / areas / all を合わせ、exclude.shops を引く）。
function collectShops(spec, dir) {
  const shops = Array.isArray(dir.shops) ? dir.shops : [];
  const picked = new Map();
  const notes = { ambiguous: [], unresolved: [] };

  if (spec.scope === 'all') for (const s of shops) picked.set(String(s.id), s);

  const byName = resolveNames(spec.shops, shops, 'name');
  for (const r of byName.resolved) picked.set(String(r.item.id), r.item);
  notes.ambiguous.push(...byName.ambiguous.map(a => ({ ...a, type: 'shop' })));
  notes.unresolved.push(...byName.unresolved.map(u => ({ ...u, type: 'shop' })));

  // エリア指定。エリア名が辞書に無ければ「該当なし」として扱い、近いエリアへ寄せない。
  for (const a of spec.areas) {
    const hit = shops.filter(s => normName(s.area) === normName(a));
    if (!hit.length) notes.unresolved.push({ query: a, type: 'area' });
    for (const s of hit) picked.set(String(s.id), s);
  }

  // 除外。除外語が曖昧なときは「除外し損ね＝送ってはいけない先へ送る」ことになるので
  // 解決できない除外は ambiguous / unresolved として止める（黙って無視しない）。
  const exRes = resolveNames(spec.exclude.shops, shops, 'name');
  const excluded = [];
  for (const r of exRes.resolved) {
    if (picked.delete(String(r.item.id))) excluded.push(r.item);
  }
  notes.ambiguous.push(...exRes.ambiguous.map(a => ({ ...a, type: 'exclude_shop' })));
  notes.unresolved.push(...exRes.unresolved.map(u => ({ ...u, type: 'exclude_shop' })));

  return { shops: [...picked.values()], excluded, notes };
}

// 個人の集合を組み立てる（staff / roles、および確定した店舗の在籍者）。
function collectStaff(spec, dir, shopList) {
  const staff = Array.isArray(dir.staff) ? dir.staff : [];
  const picked = new Map();
  const notes = { ambiguous: [], unresolved: [] };

  const byName = resolveNames(spec.staff, staff, 'name');
  for (const r of byName.resolved) picked.set(String(r.item.id), r.item);
  // 同名は必ずここに落ちる。店舗や役職で絞れるよう候補をそのまま返す。
  notes.ambiguous.push(...byName.ambiguous.map(a => ({ ...a, type: 'staff' })));
  notes.unresolved.push(...byName.unresolved.map(u => ({ ...u, type: 'staff' })));

  for (const role of spec.roles) {
    const hit = staff.filter(s => normName(s.role) === normName(role));
    if (!hit.length) notes.unresolved.push({ query: role, type: 'role' });
    for (const s of hit) picked.set(String(s.id), s);
  }

  const shopNames = new Set(shopList.map(s => normName(s.name)));
  if (shopNames.size) {
    for (const s of staff) if (shopNames.has(normName(s.shop))) picked.set(String(s.id), s);
  }

  const exRes = resolveNames(spec.exclude.staff, staff, 'name');
  const excluded = [];
  for (const r of exRes.resolved) {
    if (picked.delete(String(r.item.id))) excluded.push(r.item);
  }
  notes.ambiguous.push(...exRes.ambiguous.map(a => ({ ...a, type: 'exclude_staff' })));
  notes.unresolved.push(...exRes.unresolved.map(u => ({ ...u, type: 'exclude_staff' })));

  return { staff: [...picked.values()], excluded, notes };
}

// どの authz 操作として判定するか。宛先の広さで決める。
export function actionForSpec(spec, shopCount) {
  if (spec.scope === 'all') return 'chat.broadcast_all';
  if (shopCount > 1) return 'chat.broadcast';
  return 'chat.send';
}

/**
 * 宛先を解決する。
 * @param spec  AIまたはUIが組み立てた宛先指定（自由文ではない）
 * @param ctx   { dir:{shops:[{id,name,area}], staff:[{id,name,shop,role}]}, actor, onBehalfOf }
 * @returns {{status:'resolved'|'needs_confirmation'|'denied'|'empty', ...}}
 *
 * status の意味:
 *   resolved            送ってよい。shops/staff が確定している
 *   needs_confirmation  人に確認させる。ambiguities / unresolved / requiresBulkConfirm を見せる
 *   denied              権限が足りない。送信ボタンを出さない
 *   empty               宛先が0件。送らない
 */
export function resolveRecipients(spec, ctx) {
  const s = normalizeSpec(spec);
  const c = (ctx && typeof ctx === 'object') ? ctx : {};
  const dir = (c.dir && typeof c.dir === 'object') ? c.dir : { shops: [], staff: [] };
  const actor = normalizeActor(c.actor);
  // AIが代行するとき、権限の基準は**依頼した人間**。AI自身の role では広げられない。
  const principal = c.onBehalfOf ? normalizeActor(c.onBehalfOf) : actor;

  const can = typeof c.can === 'function' ? c.can : fallbackCan;

  const shopPart = collectShops(s, dir);
  const staffPart = collectStaff(s, dir, shopPart.shops);

  const ambiguities = [...shopPart.notes.ambiguous, ...staffPart.notes.ambiguous];
  const unresolved = [...shopPart.notes.unresolved, ...staffPart.notes.unresolved];

  // 権限の外にある店舗は落とす。ただし黙って落とさず、何を落としたか返す。
  const allowedShops = [];
  const outOfScope = [];
  // ここで見るのは**その店舗へ届くか**だけ（chat.send）。
  // 「一斉送信そのものを行えるか」は下の verdict で別に判定する。
  // 混ぜると、スタッフが2店舗を指定したときに全部が消えて理由が分からなくなる。
  for (const shop of shopPart.shops) {
    const d = can(principal, 'chat.send', { shop: shop.name });
    if (d.allow) allowedShops.push(shop); else outOfScope.push({ shop: shop.name, code: d.code });
  }
  const allowedStaff = staffPart.staff.filter(x => {
    if (!x.shop) return true;
    return can(principal, 'chat.send', { shop: x.shop }).allow;
  });
  const staffOutOfScope = staffPart.staff
    .filter(x => x.shop && !can(principal, 'chat.send', { shop: x.shop }).allow)
    .map(x => ({ staff: x.name, shop: x.shop, code: 'out_of_scope' }));

  const action = actionForSpec(s, allowedShops.length);
  const recipientCount = allowedStaff.length || allowedShops.length;

  // 操作そのものの可否（全社一斉は本部以上、など）。宛先数の上限もここで効く。
  const verdict = can(principal, action, { recipientCount });
  const base = {
    action,
    shops: allowedShops.map(x => ({ id: String(x.id), name: x.name })),
    staffIds: allowedStaff.map(x => String(x.id)),
    staff: allowedStaff.map(x => ({ id: String(x.id), name: x.name, shop: x.shop || '' })),
    excludedShops: shopPart.excluded.map(x => ({ id: String(x.id), name: x.name })),
    excludedStaff: staffPart.excluded.map(x => ({ id: String(x.id), name: x.name })),
    ambiguities,
    unresolved,
    outOfScope: [...outOfScope, ...staffOutOfScope],
    recipientCount,
    onBehalfOf: c.onBehalfOf ? { id: principal.id, name: principal.name, role: principal.role } : null,
    bySource: actor.source,
  };

  if (!verdict.allow) {
    return { ...base, status: 'denied', code: verdict.code, reason: verdict.reason, requiresBulkConfirm: false };
  }
  // 曖昧・不明が1つでも残っていたら、解決できた分だけで送らない。
  // 「一部だけ届いた」は本人も受け手も気づけないため、全体を止めて人に返す。
  if (ambiguities.length || unresolved.length) {
    return { ...base, status: 'needs_confirmation', reason: '宛先が確定していません', requiresBulkConfirm: false };
  }
  // 権限の外で落ちた宛先があるときも確認へ回す。「渋谷にも送ったつもり」を防ぐため、
  // 落ちた先を見せた上で、残りに送るかを人が決める。
  if (base.outOfScope.length) {
    // 全部が権限外＝確認する余地がない。送信させずに拒否として返す。
    if (recipientCount === 0) {
      return { ...base, status: 'denied', code: 'out_of_scope', reason: '指定された宛先はすべて権限の外です', requiresBulkConfirm: false };
    }
    return { ...base, status: 'needs_confirmation', reason: '権限のない宛先が含まれています', requiresBulkConfirm: false };
  }
  if (recipientCount === 0) {
    return { ...base, status: 'empty', reason: '宛先が0件です', requiresBulkConfirm: false };
  }
  const requiresBulkConfirm = recipientCount >= BULK_CONFIRM_THRESHOLD || action === 'chat.broadcast_all';
  return { ...base, status: 'resolved', reason: '', requiresBulkConfirm };
}

// 送信前プレビュー用の説明文。人が読んで「これで合っている」と言えるだけの情報に絞る。
export function describeRecipients(result) {
  const r = (result && typeof result === 'object') ? result : {};
  const parts = [];
  if (Array.isArray(r.shops) && r.shops.length) parts.push(`店舗 ${r.shops.length}件（${r.shops.slice(0, 5).map(s => s.name).join('、')}${r.shops.length > 5 ? ' ほか' : ''}）`);
  if (Array.isArray(r.staff) && r.staff.length) parts.push(`個人 ${r.staff.length}名`);
  if (Array.isArray(r.excludedShops) && r.excludedShops.length) parts.push(`除外 ${r.excludedShops.map(s => s.name).join('、')}`);
  if (!parts.length) parts.push('宛先なし');
  return parts.join(' / ');
}
