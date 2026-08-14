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
 * 【列構成（1行目ヘッダー）】
 *   month | shopId | shopName | owner | status | revisionNote |
 *   snapshot(JSON) | publishedAt | confirmedAt | updatedAt
 *
 *  - キーは (month, shopId) の組。同キーは upsert（上書き）
 *  - status: draft / published / confirmed / revision_requested
 */

var SHEET_NAME = '返金明細書';
var HEADERS = ['month', 'shopId', 'shopName', 'owner', 'status', 'revisionNote', 'snapshot', 'publishedAt', 'confirmedAt', 'updatedAt'];

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
  return sh;
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
    var sh = getSheet_();
    var p = (e && e.parameter) || {};
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
