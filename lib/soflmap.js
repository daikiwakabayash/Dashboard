// ── 施策リンク（強制リンク）背景同期ロジック（テスト用分離モジュール） ──────────────
//
// 目的: SalonOne の new-customers（新規顧客一覧・受付日コホート）には「施策リンク（強制リンク）」が
//       付いていない。一方 appointments には customer_id と forced_link_id がある。
//       そこで appointments を差分同期して `customer_id → forced_link_id` の対応表を作り、
//       フロントで新規顧客一覧（custRows）に JOIN して「施策リンク別」をコホート基準で再構築する。
//
// 施策リンクのタイトル/媒体/メニュー名は by-forced-link が返す（フロントが既に取得済み）ため、
// このストアは「顧客→施策リンクID」だけを持てばよい（タイトル解決はフロント側で JOIN）。
//
// appointments のカーソルは updated_at 昇順（{"u":"...","i":...}）。
//   ・最後に前進できた next_cursor を保存し、次回そこから再開＝差分だけ取得（初回だけ重い/以降軽い）。
//   ・has_more:false（末尾）に達したら最後の非null cursor を保持。新しい予約が入ると
//     その cursor 以降に現れるので次回取得できる（updated_since 不要の統一方式）。
//
// 顧客への施策リンク帰属ルール:
//   その顧客の「forced_link_id を持つ予約のうち created_at が最も古いもの」＝獲得時の施策リンク。
//   施策リンクを持つ予約が1つも無い顧客は保存しない（フロントで「リンクなし」に既定）。
//   ※「最初は直接予約→後日キャンペーン」の稀なケースはリンク有り扱いになるが、運用上許容。
//
// tests/soflmap.test.js でカバー。

// 1件の appointment 行を cust マップへ取り込む（破壊的に cur を更新して返す）。
//   cur: { <customer_id>: { fl:<forced_link_id>, ca:<created_at> } }
//   row: appointments の1行（customer_id / forced_link_id / created_at を参照）
// forced_link_id か customer_id が無ければ無視。既存より created_at が古ければ置換。
export function mergeAppointment(cur, row) {
  const map = (cur && typeof cur === 'object') ? cur : {};
  if (!row || typeof row !== 'object') return map;
  const cid = row.customer_id;
  const fl = row.forced_link_id;
  if (cid == null || fl == null) return map;      // 顧客未確定 or 施策リンク無しは対象外
  const key = String(cid);
  const ca = String(row.created_at || row.updated_at || '');
  const prev = map[key];
  // まだ無い、または今回の予約の方が古い（＝より獲得時に近い）なら採用
  if (!prev || (ca && (!prev.ca || ca < prev.ca))) {
    map[key] = { fl, ca };
  }
  return map;
}

// appointments の行配列をまとめて取り込む。
export function mergeAppointments(cur, rows) {
  const map = (cur && typeof cur === 'object') ? cur : {};
  if (!Array.isArray(rows)) return map;
  for (const r of rows) mergeAppointment(map, r);
  return map;
}

// 予約取り消し（SalonOneの「予約取り消し」＝スタッフが dismiss したテスト/無効予約）の顧客IDを集める。
//   dismissed_at が入っている予約 = 取り消し。キャンセル(cancelled_at・dismissed_atなし)とは区別する。
//   その顧客は新規顧客コホートから完全除外する（予約にもキャンセルにも数えない）。
export function mergeDismissed(set, rows) {
  const out = (set && typeof set === 'object') ? set : {};
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (!r || r.customer_id == null) continue;
    if (r.dismissed_at) out[String(r.customer_id)] = 1;
  }
  return out;
}

// GET 応答用に cust マップを「customer_id → forced_link_id」の素直な形へ落とす（ca を除く）。
export function flatten(cur) {
  const out = {};
  const map = (cur && typeof cur === 'object') ? cur : {};
  for (const [k, v] of Object.entries(map)) {
    if (v && v.fl != null) out[k] = v.fl;
  }
  return out;
}

// by-forced-link の rows から forced_link_id → {t:title, m:media, n:menu} を組み立てる（フロント/テスト共用）。
export function linkMetaFromForced(rows) {
  const out = {};
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (!r || r.forced_link_id == null) continue;
    out[String(r.forced_link_id)] = {
      t: r.title || '',
      m: r.visit_source_name || '',
      n: r.menu_name || '',
    };
  }
  return out;
}

// 新規顧客一覧（custRows）を施策リンク別に集計する（受付日コホート基準・フロントの再構築ロジック）。
//   custRows: new-customers の行（customer_id / visited_completed / joined / ltv / visit_source_name）。
//             ※テスト/海外/期間外の除外は呼び出し側で済ませておく（純粋な対象コホートのみ渡す）。
//   custMap : flatten() 済み { customer_id: forced_link_id }
//   linkMeta: linkMetaFromForced() 済み { forced_link_id: {t,m,n} }
//   戻り値: [{ key, title, media, menu, booking, visit, visitRate, cancel, cancelRate, join, joinRate, ltv, avgLtv }]
//           key='__none__' はリンクなし。予約数(=顧客数)降順。
export function buildLinkCohort(custRows, custMap, linkMeta) {
  const rows = Array.isArray(custRows) ? custRows : [];
  const cm = (custMap && typeof custMap === 'object') ? custMap : {};
  const lm = (linkMeta && typeof linkMeta === 'object') ? linkMeta : {};
  const groups = new Map();
  for (const c of rows) {
    if (!c || c.customer_id == null) continue;
    const flid = cm[String(c.customer_id)];
    const meta = (flid != null) ? lm[String(flid)] : null;
    // グルーピングキー: リンク有り＝タイトル文言（同一文言は合算・1文字でも違えば別）。無し＝__none__。
    const title = meta && meta.t ? meta.t : '';
    const key = (flid != null && title) ? `t:${title}` : '__none__';
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        title: key === '__none__' ? 'リンクなし' : title,
        media: key === '__none__' ? (c.visit_source_name || '') : (meta && meta.m) || '',
        menu: (meta && meta.n) || '',
        booking: 0, visit: 0, cancel: 0, join: 0, ltv: 0,
        _mediaSet: new Set(),
      };
      groups.set(key, g);
    }
    g.booking += 1;
    const visited = !!(c.visited_completed || c.visited_by_time);
    if (visited) g.visit += 1;
    else g.cancel += 1;                      // 来店しなかった＝キャンセル/未来店（コホート定義）
    if (c.joined || c.joined_in_period) g.join += 1;
    g.ltv += Number(c.ltv || 0);
    if (c.visit_source_name) g._mediaSet.add(c.visit_source_name);
  }
  const out = [];
  for (const g of groups.values()) {
    // リンクなしは複数媒体が混在し得るので媒体は「複数」表現に寄せる
    if (g.key === '__none__') {
      const arr = [...g._mediaSet];
      g.media = arr.length <= 1 ? (arr[0] || '') : `${arr.length}媒体`;
    }
    delete g._mediaSet;
    g.visitRate = g.booking ? Math.round((g.visit / g.booking) * 1000) / 10 : 0;
    g.cancelRate = g.booking ? Math.round((g.cancel / g.booking) * 1000) / 10 : 0;
    g.joinRate = g.visit ? Math.round((g.join / g.visit) * 1000) / 10 : 0;  // 入会率=入会/来店（コホート）
    g.avgLtv = g.booking ? Math.round(g.ltv / g.booking) : 0;
    out.push(g);
  }
  out.sort((a, b) => b.booking - a.booking);
  return out;
}
