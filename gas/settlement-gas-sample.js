/**
 * 返金明細書ストア用 GAS Web アプリ（サンプル）
 * ------------------------------------------------------------------
 * NAORUダッシュボードの「返金明細書」機能で、本社が生成した明細書と
 * オーナーの確認状況/修正依頼をスプレッドシートに保存・共有するためのGAS。
 *
 * 【セットアップ手順】
 *  1. Google スプレッドシートを新規作成し、シート名「返金明細書」を用意
 *     （なければ本スクリプトが自動作成します）
 *  2. 拡張機能 → Apps Script でこのコードを貼り付け
 *  3. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *       - 実行するユーザー: 自分
 *       - アクセスできるユーザー: 全員
 *  4. 発行された Web アプリ URL を Vercel の環境変数 SETTLEMENT_GAS_URL に設定
 *
 * 【シート1「返金明細書」列構成（1行目ヘッダー）】
 *   month | shopId | shopName | owner | status | revisionNote |
 *   snapshot(JSON) | publishedAt | confirmedAt | updatedAt
 *  - キーは (month, shopId) の組。同キーは upsert（上書き）
 *  - status: draft / published / confirmed / revision_requested
 *
 * 【シート2「オーナー設定」列構成】（自動作成。ダッシュボードのオーナー管理UIから編集）
 *   owner | password | shops(カンマ区切り店舗名) | updatedAt | role | staffId | staffName
 *   （role/staffId/staffName は自動で追記。既存4列シートも初回アクセス時に移行）
 *  - オーナー別ログインPASSとアクセス可能店舗を保存。環境変数の再デプロイ不要
 *  - password はサーバー間通信でのみ読み出し（ブラウザには返さない）
 */

var SHEET_NAME = '返金明細書';
var HEADERS = ['month', 'shopId', 'shopName', 'owner', 'status', 'revisionNote', 'snapshot', 'publishedAt', 'confirmedAt', 'updatedAt'];
// オーナーアカウント（パスワード・アクセス店舗）シート
var OWNER_SHEET = 'オーナー設定';
// shops はカンマ区切り店舗名。role/staffId/staffName は後方互換のため末尾に追加。
//  role='owner'|'staff'（未設定はダッシュボード側で owner 既定）／staffId・staffName は staff の SalonOne 配属スタッフ紐付け。
var OWNER_HEADERS = ['owner', 'password', 'shops', 'updatedAt', 'role', 'staffId', 'staffName'];
// 事業計画(SalonOne計画)の目標・アクション 共有ストア（全デバイス同期）
var PLAN_SHEET = '計画設定';
var PLAN_HEADERS = ['key', 'json', 'updatedAt']; // key: 'goals' | 'actions'

function getPlanSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(PLAN_SHEET);
  if (!sh) {
    sh = ss.insertSheet(PLAN_SHEET);
    sh.getRange(1, 1, 1, PLAN_HEADERS.length).setValues([PLAN_HEADERS]);
  }
  return sh;
}
function readPlanStore_() {
  var sh = getPlanSheet_();
  var values = sh.getDataRange().getValues();
  var out = { goals: {}, actions: [] };
  for (var r = 1; r < values.length; r++) {
    var key = String(values[r][0] || '');
    var json = String(values[r][1] || '');
    if (!key || !json) continue;
    try { out[key] = JSON.parse(json); } catch (e) {}
  }
  if (!out.goals) out.goals = {};
  if (!out.actions) out.actions = [];
  return out;
}
function writePlanKey_(key, obj) {
  var sh = getPlanSheet_();
  var values = sh.getDataRange().getValues();
  var now = new Date().toISOString();
  var json = JSON.stringify(obj || (key === 'actions' ? [] : {}));
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]) === key) { sh.getRange(r + 1, 1, 1, 3).setValues([[key, json, now]]); return; }
  }
  sh.appendRow([key, json, now]);
}

// ── 汎用KVブロブ（手当/accountmeta/全体管理セラピスト数/サンクスギフト等の共有ストア） ──
// api/plan-store.js の blobGet/blobSet が使う。Vercel KV/Supabase 未設定時のGASフォールバック。
// GET  ?type=kv&key=... → { value }
// POST { action:'saveKv', key, value } → { ok:true }
// 値はJSON文字列で1セルに格納（Sheetsのセル上限=約50,000文字。超える規模ならVercel KV推奨）。
var KV_SHEET = 'KVStore';
var KV_HEADERS = ['key', 'value', 'updatedAt'];
function getKvSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(KV_SHEET);
  if (!sh) { sh = ss.insertSheet(KV_SHEET); sh.getRange(1, 1, 1, KV_HEADERS.length).setValues([KV_HEADERS]); }
  return sh;
}
function readKvBlob_(key) {
  if (!key) return null;
  var sh = getKvSheet_();
  var values = sh.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]) === String(key)) {
      var s = String(values[r][1] || '');
      if (!s) return null;
      try { return JSON.parse(s); } catch (e) { return null; }
    }
  }
  return null;
}
function writeKvBlob_(key, value) {
  if (!key) return;
  var sh = getKvSheet_();
  var values = sh.getDataRange().getValues();
  var now = new Date().toISOString();
  var json = JSON.stringify(value == null ? null : value);
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]) === String(key)) { sh.getRange(r + 1, 1, 1, 3).setValues([[String(key), json, now]]); return; }
  }
  sh.appendRow([String(key), json, now]);
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
  return sh;
}

function getOwnerSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(OWNER_SHEET);
  if (!sh) {
    sh = ss.insertSheet(OWNER_SHEET);
    sh.getRange(1, 1, 1, OWNER_HEADERS.length).setValues([OWNER_HEADERS]);
  } else {
    // 旧シート（owner|password|shops|updatedAt の4列）へ role/staffId/staffName 列を追記して移行。
    // 先頭4列の名称は不変のため、ヘッダ行を上書きしても既存データは壊れない。
    var head = sh.getRange(1, 1, 1, OWNER_HEADERS.length).getValues()[0];
    var needs = false;
    for (var i = 0; i < OWNER_HEADERS.length; i++) { if (String(head[i] || '') !== OWNER_HEADERS[i]) { needs = true; break; } }
    if (needs) sh.getRange(1, 1, 1, OWNER_HEADERS.length).setValues([OWNER_HEADERS]);
  }
  return sh;
}

function readOwners_() {
  var sh = getOwnerSheet_();
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var head = values[0], idx = {};
  OWNER_HEADERS.forEach(function (h) { idx[h] = head.indexOf(h); });
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var owner = idx.owner >= 0 ? String(row[idx.owner]) : '';
    if (!owner) continue;
    rows.push({
      _row: r + 1, owner: owner,
      password: idx.password >= 0 ? String(row[idx.password]) : '',
      shops: idx.shops >= 0 ? String(row[idx.shops] || '') : '',
      updatedAt: idx.updatedAt >= 0 ? String(row[idx.updatedAt] || '') : '',
      role: idx.role >= 0 ? String(row[idx.role] || '') : '',
      staffId: idx.staffId >= 0 ? String(row[idx.staffId] || '') : '',
      staffName: idx.staffName >= 0 ? String(row[idx.staffName] || '') : '',
    });
  }
  return rows;
}

function readAll_(sh) {
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var head = values[0];
  var idx = {};
  HEADERS.forEach(function (h) { idx[h] = head.indexOf(h); });
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var obj = { _row: r + 1 };
    HEADERS.forEach(function (h) { obj[h] = idx[h] >= 0 ? row[idx[h]] : ''; });
    if (String(obj.month) && String(obj.shopId)) rows.push(obj);
  }
  return rows;
}

function keyOf_(month, shopId) { return String(month) + '|' + String(shopId); }

function doGet(e) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var p = (e && e.parameter) || {};
    // 事業計画の目標・アクション（全デバイス同期）
    if (String(p.type) === 'planStore') {
      return json_(readPlanStore_());
    }
    // 汎用KVブロブ取得（手当/accountmeta/サンクスギフト等）
    if (String(p.type) === 'kv') {
      return json_({ value: readKvBlob_(String(p.key || '')) });
    }
    // オーナーアカウント一覧（サーバー間通信のみ・password含む）
    if (String(p.type) === 'owners') {
      var owners = readOwners_().map(function (o) {
        return { owner: o.owner, password: o.password, shops: o.shops, updatedAt: o.updatedAt, role: o.role, staffId: o.staffId, staffName: o.staffName };
      });
      return json_({ owners: owners });
    }
    var sh = getSheet_();
    var month = String(p.month || '');
    var owner = String(p.owner || '');
    var all = readAll_(sh);
    var records = all.filter(function (row) {
      if (month && String(row.month) !== month) return false;
      if (owner && String(row.owner) !== owner) return false;
      return true;
    }).map(function (row) {
      return {
        month: String(row.month), shopId: String(row.shopId), shopName: String(row.shopName),
        owner: String(row.owner), status: String(row.status || 'published'),
        revisionNote: String(row.revisionNote || ''), snapshot: String(row.snapshot || '{}'),
        publishedAt: String(row.publishedAt || ''), confirmedAt: String(row.confirmedAt || ''),
        updatedAt: String(row.updatedAt || ''),
      };
    });
    return json_({ records: records });
  } catch (err) {
    return json_({ error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    // ── 事業計画の目標・アクションを保存（全デバイス同期） ──
    if (body.action === 'savePlanStore') {
      writePlanKey_('goals', body.goals || {});
      writePlanKey_('actions', body.actions || []);
      return json_({ ok: true });
    }

    // ── 汎用KVブロブ保存（手当/accountmeta/サンクスギフト等） ──
    if (body.action === 'saveKv') {
      writeKvBlob_(String(body.key || ''), body.value);
      return json_({ ok: true });
    }

    // ── オーナーアカウントの upsert / delete（本社/root操作） ──
    if (body.action === 'upsertOwner' || body.action === 'deleteOwner') {
      var osh = getOwnerSheet_();
      var owners = readOwners_();
      var found = null;
      owners.forEach(function (o) { if (o.owner === String(body.owner)) found = o; });
      if (body.action === 'deleteOwner') {
        if (found) osh.deleteRow(found._row);
        return json_({ ok: true });
      }
      var now = new Date().toISOString();
      // password 未指定なら既存を保持
      var pw = (body.password != null && String(body.password) !== '') ? String(body.password) : (found ? found.password : '');
      var shops = body.shops != null ? String(body.shops) : (found ? found.shops : '');
      var role = body.role != null ? String(body.role) : (found ? found.role : '');
      var staffId = body.staffId != null ? String(body.staffId) : (found ? found.staffId : '');
      var staffName = body.staffName != null ? String(body.staffName) : (found ? found.staffName : '');
      var meta = { owner: String(body.owner), password: pw, shops: shops, updatedAt: now, role: role, staffId: staffId, staffName: staffName };
      var vals = OWNER_HEADERS.map(function (h) { return meta[h] != null ? meta[h] : ''; });
      if (found) osh.getRange(found._row, 1, 1, OWNER_HEADERS.length).setValues([vals]);
      else osh.appendRow(vals);
      return json_({ ok: true });
    }

    var sh = getSheet_();
    var all = readAll_(sh);
    var byKey = {};
    all.forEach(function (row) { byKey[keyOf_(row.month, row.shopId)] = row; });

    // ── 一括 upsert（本社の公開） ──
    if (body.action === 'upsert') {
      var records = body.records || [];
      records.forEach(function (rec) {
        var key = keyOf_(rec.month, rec.shopId);
        var existing = byKey[key];
        var rowVals = HEADERS.map(function (h) {
          if (h === 'snapshot') return typeof rec.snapshot === 'string' ? rec.snapshot : JSON.stringify(rec.snapshot || {});
          return rec[h] != null ? rec[h] : (existing ? existing[h] : '');
        });
        if (existing) {
          // 既存のオーナー確認状況(confirmed/revision)は保持（本社の再公開で上書きしない）
          var sIdx = HEADERS.indexOf('status'), rnIdx = HEADERS.indexOf('revisionNote'), cIdx = HEADERS.indexOf('confirmedAt');
          if (existing.status === 'confirmed' || existing.status === 'revision_requested') {
            rowVals[sIdx] = existing.status;
            rowVals[rnIdx] = existing.revisionNote;
            rowVals[cIdx] = existing.confirmedAt;
          }
          sh.getRange(existing._row, 1, 1, HEADERS.length).setValues([rowVals]);
        } else {
          sh.appendRow(rowVals);
        }
      });
      return json_({ ok: true, saved: records.length });
    }

    // ── 単一行 update（オーナーの確認/修正依頼。owner 一致行のみ） ──
    if (body.action === 'update') {
      var key2 = keyOf_(body.month, body.shopId);
      var row = byKey[key2];
      if (!row) return json_({ ok: false, error: 'not_found' });
      if (body.owner && String(row.owner) !== String(body.owner)) {
        return json_({ ok: false, error: 'owner_mismatch' });
      }
      var patch = {
        status: body.status != null ? body.status : row.status,
        revisionNote: body.revisionNote != null ? body.revisionNote : row.revisionNote,
        confirmedAt: body.confirmedAt != null ? body.confirmedAt : row.confirmedAt,
        updatedAt: body.updatedAt || new Date().toISOString(),
      };
      HEADERS.forEach(function (h, i) {
        if (patch[h] != null) sh.getRange(row._row, i + 1).setValue(patch[h]);
      });
      return json_({ ok: true });
    }

    return json_({ ok: false, error: 'invalid_action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
