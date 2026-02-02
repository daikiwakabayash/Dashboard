/**
 * 整体院経営管理ダッシュボード - Google Apps Script
 *
 * このスクリプトは以下を実行します：
 * 1. スプレッドシートからデータを読み取る
 * 2. JSON形式に変換する
 * 3. Web APIとして公開する
 *
 * セットアップ手順：
 * 1. Google スプレッドシートを開く
 * 2. 拡張機能 > Apps Script を選択
 * 3. このコードを貼り付ける
 * 4. デプロイ > 新しいデプロイ > ウェブアプリとして実行
 * 5. 「次のユーザーとして実行」: 自分
 * 6. 「アクセスできるユーザー」: 全員
 */

// スプレッドシートのIDを設定（URLから取得）
const SPREADSHEET_ID = '1osh7Cu59jh3tFIULiCs9p2oW-Om3h6XNnNyw7bZOwAY'; // 実際のスプレッドシートIDに置き換えてください
const SHEET_NAME = '新規入会/退会率'; // シート名を適切に設定してください

/**
 * GET リクエストを処理
 */
function doGet(e) {
  try {
    const data = getSpreadsheetData();

    // CORS対応
    const output = ContentService.createTextOutput(JSON.stringify({
      success: true,
      data: data,
      timestamp: new Date().toISOString()
    }));

    output.setMimeType(ContentService.MimeType.JSON);
    return output;

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: error.toString(),
      timestamp: new Date().toISOString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * スプレッドシートからデータを取得して整形
 */
function getSpreadsheetData() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    throw new Error(`シート "${SHEET_NAME}" が見つかりません`);
  }

  // データ範囲を取得（ヘッダー含む）
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  if (lastRow < 2) {
    return []; // データがない場合は空配列を返す
  }

  // ヘッダー行を取得（1行目）
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  // データ行を取得（2行目以降）
  const dataRows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  // カラムインデックスをマッピング
  const columnMap = createColumnMap(headers);

  // データを整形
  const formattedData = dataRows
    .filter(row => row[columnMap['日付']] && row[columnMap['名前']]) // 空行をスキップ
    .map(row => formatRowData(row, columnMap));

  return formattedData;
}

/**
 * ヘッダーからカラムインデックスのマップを作成
 */
function createColumnMap(headers) {
  const map = {};
  headers.forEach((header, index) => {
    if (header) {
      map[header.toString().trim()] = index;
    }
  });
  return map;
}

/**
 * 1行のデータを整形
 */
function formatRowData(row, columnMap) {
  // 安全に値を取得するヘルパー関数
  const getValue = (colName, defaultValue = '') => {
    const index = columnMap[colName];
    return index !== undefined ? row[index] : defaultValue;
  };

  const getNumber = (colName, defaultValue = 0) => {
    const value = getValue(colName);
    if (value === '' || value === null || value === undefined) return defaultValue;
    const num = Number(value);
    return isNaN(num) ? defaultValue : num;
  };

  const getDate = (colName) => {
    const value = getValue(colName);
    if (value instanceof Date) {
      return formatJapaneseDate(value);
    }
    return value.toString();
  };

  return {
    // 基本情報
    month: getDate('日付'),
    name: getValue('名前'),
    branch: getValue('院名'),

    // 新規顧客関連
    newCount: getNumber('新規数'),
    newEnroll: getNumber('新規入会数'),
    enrollRate: getNumber('入会率'),
    newAvgPrice: getNumber('新規平均単価'),
    newSales: getNumber('新規合計売上'),

    // 会員関連
    prevMembers: getNumber('先月会員数'),
    churnCount: getNumber('今月退会数'),
    churnRate: getNumber('退会率'),
    gap: getNumber('GAP'),

    // 口コミ
    gReviews: getNumber('G口コミ'),
    hReviews: getNumber('H口コミ'),

    // 売上
    individualSales: getNumber('個別税込売上'),
    recurringSales: getNumber('継続売上'),

    // 福利厚生・手当（チェック項目 + 金額）
    healthCheck: getNumber('健康診断'),
    healthAllowance: getNumber('健康手当'),
    marathon: getNumber('フルマラソン'),
    studyAllowance: getNumber('勉強代手当'),
    birthdayAllowance: getNumber('誕生日手当'),
    childAllowance: getNumber('子供手当'),
    dental: getNumber('歯クリーニング'),
    familyAllowance: getNumber('家族手当'),
    accessAllowance: getNumber('イベントアクセス手当'),
    welcomeAllowance: getNumber('ウェルカムファミリー手当'),
    goalAllowance: getNumber('目標達成手当'),

    // パフォーマンス指標
    productivity: getNumber('個人生産性（税込）'),
    conversionRate: getNumber('成約率'),
    adRatio: getNumber('広告費率'),
    referrals: getNumber('紹介数'),
    taskMiss: getNumber('タスク漏れ'),

    // 評価
    totalScore: getNumber('各セラピスト合計得点'),
    status: getValue('達成/未達成'),
    achieveCount: getNumber('達成回数'),

    // 残高
    healthBalance: getNumber('健康残高'),
    studyBalance: getNumber('勉強残高')
  };
}

/**
 * 日付を日本語形式に変換（例：2026年1月）
 */
function formatJapaneseDate(date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  return `${year}年${month}月`;
}

/**
 * テスト用関数（Apps Script エディタで実行可能）
 */
function testGetData() {
  const data = getSpreadsheetData();
  Logger.log(`取得したデータ数: ${data.length}`);
  if (data.length > 0) {
    Logger.log('サンプルデータ:');
    Logger.log(JSON.stringify(data[0], null, 2));
  }
  return data;
}

/**
 * スプレッドシートの構造を確認する関数（デバッグ用）
 */
function checkSheetStructure() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    Logger.log(`エラー: シート "${SHEET_NAME}" が見つかりません`);
    Logger.log(`利用可能なシート: ${ss.getSheets().map(s => s.getName()).join(', ')}`);
    return;
  }

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  Logger.log('=== スプレッドシートの列構造 ===');
  headers.forEach((header, index) => {
    if (header) {
      Logger.log(`列 ${index + 1} (${String.fromCharCode(65 + index)}): ${header}`);
    }
  });

  Logger.log(`\n総行数: ${sheet.getLastRow()}`);
  Logger.log(`総列数: ${sheet.getLastColumn()}`);
}
