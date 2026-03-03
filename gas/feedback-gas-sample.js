// ============================================================
// GAS (Google Apps Script) - フィードバック管理スクリプト
// ============================================================
//
// 【セットアップ手順】
// 1. Google スプレッドシートを新規作成
// 2. シート名を「フィードバック」にリネーム
// 3. A1〜F1 に以下のヘッダーを入力:
//    | 日付 | カテゴリ | 質問 | 悪い回答 | 良い回答 | 有効 |
// 4. 拡張機能 → Apps Script を開く
// 5. 以下のコードを貼り付けてデプロイ
//    - 「デプロイ」→「新しいデプロイ」→ 種類: ウェブアプリ
//    - 実行者: 自分、アクセス: 全員
// 6. デプロイURLを Vercel 環境変数 FEEDBACK_GAS_URL に設定
//
// 【運用方法】
// - ダッシュボードのチャットで「改善FB」ボタンを押すとフィードバックが送信される
// - スプレッドシートの「有効」列を TRUE にすると、次回チャット時にシステムプロンプトに注入される
// - 「有効」を FALSE にすれば無効化（削除不要）
// ============================================================

const SHEET_NAME = 'フィードバック';

// ── GET: 有効なフィードバックを返す ──
function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const data = sheet.getDataRange().getValues();
  const headers = data[0]; // [日付, カテゴリ, 質問, 悪い回答, 良い回答, 有効]
  const examples = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const isActive = row[5]; // 有効 列
    if (isActive === true || isActive === 'TRUE' || isActive === 'true') {
      examples.push({
        date: row[0],
        category: row[1] || '一般',
        question: row[2] || '',
        badAnswer: row[3] || '',
        goodAnswer: row[4] || '',
      });
    }
  }

  return ContentService.createTextOutput(JSON.stringify(examples))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── POST: フィードバックを追記する ──
function doPost(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);

  // シートがなければ自動作成
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['日付', 'カテゴリ', '質問', '悪い回答', '良い回答', '有効']);
    // ヘッダー行の書式設定
    sheet.getRange(1, 1, 1, 6).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'Invalid JSON' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 新しい行を追加（有効列はデフォルト FALSE → 運用チームが確認後 TRUE にする）
  sheet.appendRow([
    body.date || new Date().toISOString().slice(0, 10),
    body.category || '一般',
    body.question || '',
    body.badAnswer || '',
    body.goodAnswer || '',
    false, // 有効: デフォルト FALSE（レビュー後に TRUE にする）
  ]);

  return ContentService.createTextOutput(JSON.stringify({ success: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
