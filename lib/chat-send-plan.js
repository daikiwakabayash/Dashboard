// ── 送信指示の分離・送信前確認・配信計画 ────────────────────────────────
// 「A店とB店だけに送って。明日の朝礼は9時からです」のような1通から、
//   ・送信指示（誰に送るか）
//   ・本文（何を送るか）
// を分け、宛先解決（lib/chat-recipients.js）の結果と合わせて
//   ・人が見て確かめられる送信前確認（実際の店舗・人・件数・本文）
//   ・実際の配信計画（1人1通のDMなど）
//   ・送信直前の再確認（所属・権限・未読・重複）
// を組み立てる。I/O は持たない純粋関数。tests/chat-send-plan.test.js でカバー。
//
// 崩さない決まり:
//   1. **本文と送信指示を分ける。** 送信指示の文はそのまま本文にしない。
//      分けられなければ送らない（status='needs_body' / 'needs_instruction'）。
//   2. **曖昧なら送らない。** 同姓同名・店舗名の曖昧さ・除外の解決不能は
//      needs_confirmation のまま止める（resolveRecipients の判定を弱めない）。
//   3. **一括DMを勝手にグループDMへ変えない。** 個別DMは1人1通のまま。
//      受け手に他の宛先を見せない（cc/宛先一覧を本文にも混ぜない）。
//   4. **送信時点でもう一度確かめる。** 確認画面を見た時点と送信時点で
//      所属・権限が変わっていれば、その人には送らない（黙って送らない・理由を残す）。
//   5. **同じ人へ二度送らない。** 予約送信・未読者への再通知は、送信済み台帳と
//      突き合わせて重複を落とす。

const str = (v) => String(v == null ? '' : v);
const arr = (v) => (Array.isArray(v) ? v : []);
const uniq = (a) => [...new Set(a)];

// 送信指示と受け取れる言い回し。**本文の中の一部ではなく、行として独立しているもの**を見る。
// 「〜に送って」「〜へ送信」「〜だけに」「〜を除いて」など。
const INSTRUCTION_HINTS = [
  /送(っ|信|る|付)/, /届け/, /通知/, /配信/, /だけに/, /のみに/, /を除/, /以外/, /全店/, /個別(に)?(DM|ＤＭ)/i, /[@＠]/,
];
// 本文側に紛れやすい定型（指示ではない）
const NOT_INSTRUCTION = [/^[「『]/, /^https?:\/\//i];

export function looksLikeInstruction(line) {
  const t = str(line).trim();
  if (!t) return false;
  if (NOT_INSTRUCTION.some(re => re.test(t))) return false;
  return INSTRUCTION_HINTS.some(re => re.test(t));
}

// 1通のテキストを「送信指示」と「本文」に分ける。
//   ・明示の区切り（本文: / 内容: / --- / 「」）があればそれを最優先。
//   ・無ければ、先頭の指示らしい行を指示、残りを本文とみなす。
// どちらかが空なら status で止める（推測して送らない）。
export function splitInstruction(input) {
  const raw = str(input).replace(/\r\n/g, '\n');
  if (!raw.trim()) return { status: 'empty', instruction: '', body: '', how: 'none' };

  // 明示の区切り: 「本文:」「内容:」「メッセージ:」
  const labeled = raw.match(/^([\s\S]*?)(?:^|\n)\s*(?:本文|内容|メッセージ|message)\s*[:：]\s*([\s\S]+)$/im);
  if (labeled) {
    const instruction = labeled[1].trim();
    const body = labeled[2].trim();
    if (!body) return { status: 'needs_body', instruction, body: '', how: 'label' };
    if (!instruction) return { status: 'needs_instruction', instruction: '', body, how: 'label' };
    return { status: 'ok', instruction, body, how: 'label' };
  }
  // 明示の区切り: 引用符で囲まれた本文
  const quoted = raw.match(/[「『"]([\s\S]+?)[」』"]/);
  if (quoted && quoted[1].trim()) {
    const instruction = raw.replace(quoted[0], '').trim();
    if (!instruction) return { status: 'needs_instruction', instruction: '', body: quoted[1].trim(), how: 'quote' };
    return { status: 'ok', instruction, body: quoted[1].trim(), how: 'quote' };
  }
  // 区切りなし: 行単位で、先頭の指示らしい行だけを指示として切り出す
  const lines = raw.split('\n');
  const head = [];
  let i = 0;
  while (i < lines.length && (!lines[i].trim() || looksLikeInstruction(lines[i]))) {
    if (lines[i].trim()) head.push(lines[i].trim());
    i += 1;
  }
  const instruction = head.join('\n').trim();
  const body = lines.slice(i).join('\n').trim();
  if (!instruction) return { status: 'needs_instruction', instruction: '', body: raw.trim(), how: 'lines' };
  if (!body) return { status: 'needs_body', instruction, body: '', how: 'lines' };
  return { status: 'ok', instruction, body, how: 'lines' };
}

// 配信の形。
//   'rooms'   … 店舗ルーム等へ1件ずつ投稿（参加者には他の宛先が見えて構わない場所）
//   'dm_each' … 個別DM。**1人1通**。グループDMには絶対にしない。
export const DELIVERY = Object.freeze({ ROOMS: 'rooms', DM_EACH: 'dm_each' });

// ⚠️ 「解決結果に個人が含まれる」ことは DM の合図にしない。
//    店舗を指定すると resolveRecipients はその店舗の在籍者も返すため、
//    それを合図にすると「店舗ルームへ送るつもりが全員へ個別DM」になってしまう。
//    個別DMは **指示が明示しているときだけ**（dm=true、または個人・役職だけを名指ししたとき）。
export function deliveryModeFor(spec, resolved) {
  const s = (spec && typeof spec === 'object') ? spec : {};
  const r = (resolved && typeof resolved === 'object') ? resolved : {};
  if (s.dm === true) return DELIVERY.DM_EACH;
  const namedPeople = arr(s.staff).length > 0 || arr(s.roles).length > 0;
  const namedPlaces = arr(s.shops).length > 0 || arr(s.areas).length > 0 || s.scope === 'all';
  if (namedPeople && !namedPlaces) return DELIVERY.DM_EACH;
  if (!namedPeople && !namedPlaces && arr(r.staff).length > 0 && arr(r.shops).length === 0) return DELIVERY.DM_EACH;
  return DELIVERY.ROOMS;
}

// 送信前確認。**人が読んで「これで合っている」と言えるだけの実物**を返す。
// 件数だけ・要約だけにしない（誰に届くのかが分からないまま押させない）。
export function buildConfirmation(input = {}) {
  const resolved = (input.resolved && typeof input.resolved === 'object') ? input.resolved : {};
  const body = str(input.body).trim();
  const mode = str(input.mode) || deliveryModeFor(input.spec, resolved);
  const blockers = [];

  if (!body) blockers.push({ code: 'no_body', message: '本文がありません' });
  if (resolved.status === 'needs_confirmation') {
    blockers.push({ code: 'ambiguous_recipients', message: str(resolved.reason) || '宛先が確定していません' });
  }
  if (resolved.status === 'denied') blockers.push({ code: str(resolved.code) || 'denied', message: str(resolved.reason) || '送信できません' });
  if (resolved.status === 'empty') blockers.push({ code: 'empty', message: '宛先が0件です' });

  const shops = arr(resolved.shops).map(s => ({ id: str(s.id), name: str(s.name) }));
  const staff = arr(resolved.staff).map(s => ({ id: str(s.id), name: str(s.name), shop: str(s.shop) }));
  const targets = mode === DELIVERY.DM_EACH
    ? staff.map(s => ({ kind: 'dm', to: s.id, label: s.name, shop: s.shop }))
    : shops.map(s => ({ kind: 'room', to: s.id, label: s.name, shop: s.name }));

  return {
    // 何を送るか（本文はそのまま見せる。要約しない）
    body,
    mode,
    // 誰に届くか（実物）
    shops, staff, targets,
    count: targets.length,
    // どこへ届かないか（黙って落とさない）
    excludedShops: arr(resolved.excludedShops).map(s => ({ id: str(s.id), name: str(s.name) })),
    excludedStaff: arr(resolved.excludedStaff).map(s => ({ id: str(s.id), name: str(s.name) })),
    outOfScope: arr(resolved.outOfScope),
    ambiguities: arr(resolved.ambiguities),
    unresolved: arr(resolved.unresolved),
    // 個別DMであることと、宛先同士が見えないことを画面で明示するための印
    dmEach: mode === DELIVERY.DM_EACH,
    recipientsHiddenFromEachOther: mode === DELIVERY.DM_EACH,
    requiresBulkConfirm: resolved.requiresBulkConfirm === true,
    blockers,
    canSend: blockers.length === 0 && targets.length > 0,
  };
}

// 確認画面に出す一行。件数の前に**実際の宛先**を出す。
export function confirmationLine(conf) {
  const c = (conf && typeof conf === 'object') ? conf : {};
  const names = arr(c.targets).map(t => str(t.label));
  const head = names.length <= 5 ? names.join('、') : `${names.slice(0, 5).join('、')} ほか${names.length - 5}名`;
  const where = c.dmEach ? '個別DM（1人1通・宛先は互いに見えません）' : '店舗ルーム';
  return `${where}：${head}（${arr(c.targets).length}件）`;
}

// ── 送信直前の再確認 ────────────────────────────────────────────────────
// 確認画面を見た時点と送信時点で、所属・権限・在籍が変わっていることがある。
// 変わっていたらその宛先だけ落とし、**落とした理由を残す**（黙って送らない・黙って落とさない）。
export function recheckBeforeSend(confirmation, ctx = {}) {
  const c = (confirmation && typeof confirmation === 'object') ? confirmation : {};
  const dir = (ctx.dir && typeof ctx.dir === 'object') ? ctx.dir : { shops: [], staff: [] };
  const can = typeof ctx.can === 'function' ? ctx.can : () => ({ allow: true });
  const principal = ctx.principal || ctx.actor || {};
  const staffById = new Map(arr(dir.staff).map(s => [str(s.id), s]));
  const shopById = new Map(arr(dir.shops).map(s => [str(s.id), s]));

  const send = [], dropped = [];
  for (const t of arr(c.targets)) {
    const id = str(t.to);
    if (t.kind === 'dm') {
      const cur = staffById.get(id);
      if (!cur) { dropped.push({ ...t, code: 'left', reason: '在籍が確認できません' }); continue; }
      const shopNow = str(cur.shop);
      if (str(t.shop) && shopNow && shopNow !== str(t.shop)) {
        dropped.push({ ...t, code: 'moved', reason: `所属が変わりました（${str(t.shop)} → ${shopNow}）`, shopNow });
        continue;
      }
      const d = can(principal, 'chat.dm', { shop: shopNow || str(t.shop), staffId: id });
      if (!d.allow) { dropped.push({ ...t, code: str(d.code) || 'forbidden', reason: '送信する権限がありません' }); continue; }
      send.push({ ...t, shop: shopNow || str(t.shop) });
    } else {
      const cur = shopById.get(id);
      if (!cur) { dropped.push({ ...t, code: 'gone', reason: 'ルームが確認できません' }); continue; }
      const d = can(principal, 'chat.send', { shop: str(cur.name) });
      if (!d.allow) { dropped.push({ ...t, code: str(d.code) || 'forbidden', reason: '送信する権限がありません' }); continue; }
      send.push({ ...t, label: str(cur.name) });
    }
  }
  return {
    send, dropped,
    count: send.length,
    changed: dropped.length > 0,
    // 全部落ちたら送らない。「0件送信」を成功として扱わない。
    canSend: send.length > 0,
  };
}

// ── 予約送信・未読者への再通知 ──────────────────────────────────────────
// 実行直前に「まだ未読か」「同じ人へ送っていないか」を確かめる。
//   ledger: { [key]: { at } } … 送信済み台帳（key は dedupeKey で作る）
export const dedupeKey = (campaignId, staffId) => `${str(campaignId)}::${str(staffId)}`;

export function planRenotify(input = {}) {
  const campaignId = str(input.campaignId);
  const ledger = (input.ledger && typeof input.ledger === 'object') ? input.ledger : {};
  const readBy = new Set(arr(input.readBy).map(str));            // 既読になった人
  const candidates = arr(input.candidates);                       // [{id,name,shop}]
  const send = [], skipped = [];

  for (const p of candidates) {
    const id = str(p && p.id);
    if (!id) { skipped.push({ id: '', code: 'no_id', reason: '宛先IDがありません' }); continue; }
    if (readBy.has(id)) { skipped.push({ id, name: str(p.name), code: 'already_read', reason: 'すでに読まれています' }); continue; }
    if (ledger[dedupeKey(campaignId, id)]) { skipped.push({ id, name: str(p.name), code: 'already_sent', reason: 'この配信ではすでに送っています' }); continue; }
    send.push({ id, name: str(p.name), shop: str(p.shop) });
  }
  // 同じ人が候補に2回入っていても1回だけにする
  const seen = new Set();
  const deduped = send.filter(x => (seen.has(x.id) ? false : (seen.add(x.id), true)));
  const dupInCandidates = send.length - deduped.length;
  return { send: deduped, skipped, count: deduped.length, duplicatesInCandidates: dupInCandidates };
}

// 送信できた分を台帳へ記録する（次回の再通知で二度送らないため）。
export function markSent(ledger, campaignId, ids, at) {
  const next = { ...((ledger && typeof ledger === 'object') ? ledger : {}) };
  const t = at || new Date().toISOString();
  for (const id of uniq(arr(ids).map(str).filter(Boolean))) next[dedupeKey(campaignId, id)] = { at: t };
  return next;
}
