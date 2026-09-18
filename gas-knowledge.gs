/**
 * ナレッジ資料の自動更新（Dashboard から1日1回呼ばれます）
 *
 * ■ 置き場所
 *   既に使っている Apps Script プロジェクト（gas-code.gs と同じもの）へ、
 *   このファイルの中身を追加してください。新しいプロジェクトは作らなくて大丈夫です。
 *
 * ■ 入れたあとにすること
 *   「デプロイ」→「デプロイを管理」→ 既存のウェブアプリを「編集（鉛筆）」→
 *   バージョンを「新バージョン」にして「デプロイ」。
 *   ⚠️ URL は変わりません。Dashboard 側の設定変更は不要です。
 *
 * ■ できること
 *   スプレッドシート・スライド・ドキュメントの「中身の文字」を返します。
 *   このスクリプトを動かしている Google アカウントが開けるファイルだけが対象です。
 *   （＝新しい認証情報や共有設定は要りません）
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

// ■ 入れたあとの動作確認（Apps Script の画面で実行できます）
//   1) 下の testReadKnowledgeDoc_ の FILE_ID に、読ませたいスプレッドシートのIDを入れる
//      （URL の /d/ と /edit のあいだの文字列）
//   2) 関数を選んで「実行」。実行ログに中身の先頭が出れば成功。
function testReadKnowledgeDoc_() {
  var FILE_ID = 'ここにファイルIDを貼る';
  var r = readKnowledgeDoc_({ action: 'readKnowledgeDoc', kind: 'spreadsheet', fileId: FILE_ID });
  Logger.log(r.ok ? (r.title + ' / ' + String(r.body).slice(0, 300)) : ('NG: ' + r.error));
}

// Dashboard からの呼び出し口（本体）
function readKnowledgeDoc_(body) {
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
