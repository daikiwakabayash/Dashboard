/**
 * ナレッジ資料の自動更新（Dashboard から1日1回呼ばれます）
 *
 * ■ 置き場所
 *   既に使っている Apps Script プロジェクト（PLAN_GAS_URL / SETTLEMENT_GAS_URL の接続先）へ、
 *   このファイルの中身を追加してください。新しいプロジェクトは作らなくて大丈夫です。
 *
 * ■ 入れたあとにすること
 *   「デプロイ」→「デプロイを管理」→ 既存のウェブアプリを「編集（鉛筆）」→
 *   バージョンを「新バージョン」にして「デプロイ」。
 *   ⚠️ URL は変わりません。秘密値の設定後に Dashboard も再デプロイしてください。
 *
 * ■ できること
 *   スプレッドシート・スライド・ドキュメントの「中身の文字」を返します。
 *   このスクリプトを動かしている Google アカウントが開けるファイルだけが対象です。
 *   URL を知っているだけで社内資料が読めてしまわないよう、Dashboard と
 *   この スクリプトで「合言葉」を共有します。合言葉は setupKnowledgeSecret を
 *   1回実行すれば自動で作られ、このプロジェクトに保存されます。表示された値を
 *   Vercel の環境変数 KNOWLEDGE_GAS_SECRET（Production）へ貼り付けてください。
 *   合言葉はコードに書きません。CRON_SECRET とは別の値です。
 *
 * ■ しないこと
 *   ファイルを書き換えたり、消したりはしません。読むだけです。
 */

// ■ 既存の doPost に、この2行を足してください（いちばん上、body を読んだ直後）
//
//     if (body.action === 'readKnowledgeDoc') {
//       return ContentService.createTextOutput(JSON.stringify(readKnowledgeDoc_(body)))
//         .setMimeType(ContentService.MimeType.JSON);
//     }
//
//   ※ 既存コードで body の変数名が違う場合（例: params, data）は、そちらに合わせてください。
//   ※ doPost がまだ無いプロジェクトなら、下の doPost をそのまま使えます（コメントを外す）。
//
// function doPost(e) {
//   var body = {};
//   try { body = JSON.parse(e.postData.contents); } catch (err) {}
//   if (body.action === 'readKnowledgeDoc') {
//     return ContentService.createTextOutput(JSON.stringify(readKnowledgeDoc_(body)))
//       .setMimeType(ContentService.MimeType.JSON);
//   }
//   return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'unknown action' }))
//     .setMimeType(ContentService.MimeType.JSON);
// }

// ── ここから下の3つは、Apps Script の「実行する関数」から選んで実行できます ──
//    （⚠️ 関数名の末尾に _ を付けると実行メニューに出ないため、この3つは _ なしにしています）

/**
 * 【1回だけ実行】合言葉（KNOWLEDGE_GAS_SECRET）を作って、この プロジェクトに保存します。
 *
 *   手順: 上の「実行する関数」で setupKnowledgeSecret を選ぶ → 「実行」
 *         → 下の「実行ログ」に 48文字の文字列が出ます
 *         → その文字列をコピーして、Vercel の環境変数 KNOWLEDGE_GAS_SECRET に貼り付け
 *
 *   ⚠️ すでに保存済みの場合は作り直しません（Dashboard 側とズレないように）。
 *      作り直したいときは、下の resetKnowledgeSecret を実行してください。
 */
function setupKnowledgeSecret() {
  var props = PropertiesService.getScriptProperties();
  var cur = props.getProperty('KNOWLEDGE_GAS_SECRET') || '';
  if (cur.length >= 32) {
    Logger.log('すでに設定済みです。Vercel にはこの値を貼り付けてください:\n' + cur);
    return;
  }
  var v = makeKnowledgeSecret_();
  props.setProperty('KNOWLEDGE_GAS_SECRET', v);
  Logger.log('合言葉を保存しました。この値を Vercel の KNOWLEDGE_GAS_SECRET に貼り付けてください:\n' + v);
}

/** 【作り直したいときだけ】合言葉を作り直します。Vercel 側も同じ値に更新が必要です。 */
function resetKnowledgeSecret() {
  var v = makeKnowledgeSecret_();
  PropertiesService.getScriptProperties().setProperty('KNOWLEDGE_GAS_SECRET', v);
  Logger.log('作り直しました。⚠️ Vercel の KNOWLEDGE_GAS_SECRET も必ずこの値に更新してください:\n' + v);
}

/**
 * 【動作確認】1つのファイルを実際に読んでみます。
 *   下の FILE_ID に、読ませたいスプレッドシートのID（URL の /d/ と /edit のあいだ）を貼ってから実行。
 *   実行ログに中身の先頭が出れば成功です。
 */
function testReadKnowledgeDoc() {
  var FILE_ID = 'ここにファイルIDを貼る';
  var secret = PropertiesService.getScriptProperties().getProperty('KNOWLEDGE_GAS_SECRET') || '';
  if (secret.length < 32) { Logger.log('NG: 先に setupKnowledgeSecret を実行してください'); return; }
  var r = readKnowledgeDoc_({ action: 'readKnowledgeDoc', kind: 'spreadsheet', fileId: FILE_ID, secret: secret });
  Logger.log(r.ok ? ('OK: ' + r.title + ' / ' + String(r.body).slice(0, 300)) : ('NG: ' + r.error));
}

/** 英数字48文字のランダム値を作る（推測されにくい長さにする） */
function makeKnowledgeSecret_() {
  var CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var out = '';
  for (var i = 0; i < 48; i++) out += CHARS.charAt(Math.floor(Math.random() * CHARS.length));
  return out;
}

// Dashboard からの呼び出し口（本体）
function readKnowledgeDoc_(body) {
  body = body || {};
  var expected = PropertiesService.getScriptProperties().getProperty('KNOWLEDGE_GAS_SECRET') || '';
  var supplied = typeof body.secret === 'string' ? body.secret : '';
  // Fail closed before opening any file. Keep the secret out of logs and responses.
  if (expected.length < 32 || supplied.length !== expected.length) {
    return { ok: false, error: 'unauthorized' };
  }
  var difference = 0;
  for (var i = 0; i < expected.length; i++) {
    difference |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  }
  if (difference !== 0) return { ok: false, error: 'unauthorized' };
  var kind = String(body.kind || '');
  var fileId = String(body.fileId || '');
  if (!/^[A-Za-z0-9_-]{20,}$/.test(fileId)) {
    return { ok: false, error: 'ファイルIDの形式が不正です' };
  }
  try {
    if (kind === 'spreadsheet') return readSpreadsheet_(fileId);
    if (kind === 'presentation') return readPresentation_(fileId);
    if (kind === 'document') return readDocument_(fileId);
    return { ok: false, error: '対応していない種類です: ' + kind };
  } catch (e) {
    // ⚠️ 例外の中身をそのまま返さない（ファイル名や内部パスが混ざることがあるため）
    var msg = String((e && e.message) || e);
    if (msg.indexOf('permission') >= 0 || msg.indexOf('権限') >= 0 || msg.indexOf('Access denied') >= 0) {
      return { ok: false, error: 'このファイルを開く権限がありません（共有設定をご確認ください）' };
    }
    if (msg.indexOf('not found') >= 0 || msg.indexOf('見つかりません') >= 0) {
      return { ok: false, error: 'ファイルが見つかりません（削除・移動された可能性があります）' };
    }
    return { ok: false, error: '読み取りに失敗しました' };
  }
}

/** スプレッドシート: 全シートを「シート名＋行」のテキストにする */
function readSpreadsheet_(fileId) {
  var ss = SpreadsheetApp.openById(fileId);
  var out = [];
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i];
    if (sh.isSheetHidden()) continue;                 // 非表示シートは読まない
    var range = sh.getDataRange();
    if (!range) continue;
    var values = range.getDisplayValues();            // 表示されているとおりの文字（数式の結果・書式込み）
    if (!values.length) continue;
    out.push('【シート: ' + sh.getName() + '】');
    for (var r = 0; r < values.length; r++) {
      var row = values[r].map(function (c) { return String(c == null ? '' : c).trim(); });
      while (row.length && row[row.length - 1] === '') row.pop();   // 右端の空セルを落とす
      if (!row.length) continue;
      out.push(row.join('\t'));
    }
    out.push('');
  }
  return { ok: true, title: ss.getName(), body: out.join('\n') };
}

/** スライド: ページごとに、置いてある文字とスピーカーノートを拾う */
function readPresentation_(fileId) {
  var pres = SlidesApp.openById(fileId);
  var slides = pres.getSlides();
  var out = [];
  for (var i = 0; i < slides.length; i++) {
    out.push('【' + (i + 1) + 'ページ】');
    var shapes = slides[i].getShapes();
    for (var j = 0; j < shapes.length; j++) {
      try {
        var t = shapes[j].getText().asString().trim();
        if (t) out.push(t);
      } catch (e) {}                                   // 文字を持たない図形は飛ばす
    }
    // 表の中身も拾う（料金表・条件表がスライドに入っていることが多いため）
    var tables = slides[i].getTables();
    for (var k = 0; k < tables.length; k++) {
      var tb = tables[k];
      for (var r = 0; r < tb.getNumRows(); r++) {
        var cells = [];
        for (var c = 0; c < tb.getNumColumns(); c++) {
          try { cells.push(tb.getCell(r, c).getText().asString().trim()); } catch (e) { cells.push(''); }
        }
        if (cells.join('')) out.push(cells.join('\t'));
      }
    }
    try {
      var note = slides[i].getNotesPage().getSpeakerNotesShape().getText().asString().trim();
      if (note) out.push('（ノート）' + note);
    } catch (e) {}
    out.push('');
  }
  return { ok: true, title: pres.getName(), body: out.join('\n') };
}

/** ドキュメント: 本文をそのまま */
function readDocument_(fileId) {
  var doc = DocumentApp.openById(fileId);
  return { ok: true, title: doc.getName(), body: doc.getBody().getText() };
}
