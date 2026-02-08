// マーケティングダッシュボード用 Google Apps Script
//
// 整体院の広告媒体別・店舗別マーケティングデータを
// ダッシュボードで表示できるJSON形式に変換します。
//
// スプレッドシートの横展開（媒体が横に並ぶ）構造を
// 縦型（1行=1店舗×1媒体）に自動変換します。
//
// ===== セットアップ手順 =====
// 1. マーケティングデータのスプレッドシートを開く
// 2. メニュー「拡張機能」→「Apps Script」を開く
// 3. エディタ内のコードを全て削除し、このコードを貼り付ける
// 4. 下の SPREADSHEET_ID と SHEET_NAME を自分のものに書き換える
// 5. 上部のセレクターで「testGetData」を選択 → 実行
//    → 権限の承認ダイアログが出るので「許可」する
// 6. 「デプロイ」→「新しいデプロイ」
//    → 種類: ウェブアプリ
//    → 次のユーザーとして実行: 自分
//    → アクセスできるユーザー: 全員
//    → 「デプロイ」をクリック
// 7. URLをコピー（ダッシュボードに設定済み）

// ============================================================
// ここを自分のスプレッドシートに合わせて変更してください
// ============================================================
// 注意: 他のGASファイルに既にSPREADSHEET_IDがある場合は
// この2行を削除してそちらのIDを使ってください
var MARKETING_SS_ID = 'ここにスプレッドシートIDを貼り付け';
// シート名の指定方法:
//   '*'            → 全シートを対象（シート名が「月」列に自動セット）
//   '数値まとめ'   → 名前に「数値まとめ」を含むシートのみ対象
//   'シート1'      → 完全一致の特定シートのみ対象
var MARKETING_SHEET_NAME = '数値まとめ';
// ============================================================


// GETリクエストを処理（ダッシュボードからのAPI呼び出し）
function doGet(e) {
  try {
    const data = getMarketingData();
    const menuData = getMenuAnalysisData();
    return ContentService
      .createTextOutput(JSON.stringify({
        success: true,
        data: data,
        menuData: menuData,
        count: data.length,
        timestamp: new Date().toISOString()
      }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    Logger.log('doGet エラー: ' + error.toString());
    return ContentService
      .createTextOutput(JSON.stringify({
        success: false,
        error: error.toString(),
        timestamp: new Date().toISOString()
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}


// メインのデータ取得・変換関数
// SHEET_NAME='*' の場合は全シートをループ処理
function getMarketingData() {
  var ssId = (typeof SPREADSHEET_ID !== 'undefined') ? SPREADSHEET_ID : MARKETING_SS_ID;
  var sheetNameFilter = (typeof SHEET_NAME !== 'undefined') ? SHEET_NAME : MARKETING_SHEET_NAME;
  const ss = SpreadsheetApp.openById(ssId);

  const allSheets = ss.getSheets();
  let targetSheets;

  if (sheetNameFilter === '*') {
    targetSheets = allSheets;
    Logger.log('全シートモード: ' + allSheets.length + 'シート');
  } else {
    // 完全一致 or 部分一致
    const exact = allSheets.filter(function(s) { return s.getName() === sheetNameFilter; });
    if (exact.length > 0) {
      targetSheets = exact;
    } else {
      targetSheets = allSheets.filter(function(s) { return s.getName().indexOf(sheetNameFilter) >= 0; });
    }
    Logger.log('対象シート (' + sheetNameFilter + '): ' + targetSheets.length + '件');
  }

  const allResults = [];
  targetSheets.forEach(function(sheet) {
    try {
      const sheetData = processSheet(sheet);
      if (sheetData.length > 0) {
        Logger.log('  ✅ ' + sheet.getName() + ' → ' + parseSheetMonth(sheet.getName()) + ': ' + sheetData.length + '件');
        allResults.push.apply(allResults, sheetData);
      }
    } catch (e) {
      Logger.log('  ⚠ ' + sheet.getName() + ': スキップ（' + e.message + '）');
    }
  });

  return allResults;
}


// 1シート分のデータを処理
// 横展開のスプレッドシートを縦型の配列に変換
function processSheet(sheet) {
  const sheetName = parseSheetMonth(sheet.getName());
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 3 || lastCol < 10) return [];

  // 全データを一括取得（パフォーマンスのため）
  const allData = sheet.getRange(1, 1, lastRow, lastCol).getValues();

  // ヘッダー行を検出（"No"と"店舗"が含まれる行）
  let headerRowIdx = -1;
  for (let r = 0; r < Math.min(10, allData.length); r++) {
    const row = allData[r];
    const hasNo = row.some(c => String(c).trim() === 'No');
    const hasStore = row.some(c => String(c).trim() === '店舗');
    if (hasNo && hasStore) {
      headerRowIdx = r;
      break;
    }
  }

  // ヘッダーが見つからない場合はこのシートをスキップ
  if (headerRowIdx === -1) return [];

  const headers = allData[headerRowIdx].map(h => String(h).trim());
  Logger.log('シート "' + sheetName + '": ヘッダー行=' + (headerRowIdx + 1) + ', 列数=' + headers.length);

  // ===== メイン列（Meta広告の集計列）のインデックスを取得 =====
  const mainCols = {
    no:           findCol(headers, 'No'),
    area:         findCol(headers, 'エリア'),
    store:        findCol(headers, '店舗'),
    budget:       findCol(headers, '予算'),
    totalRes:     findColContains(headers, 'Total', '予約'),
    metaRes:      findColContains(headers, 'meta', '予約'),
    visits:       findColAfter(headers, '実来院', 0),
    cancelCount:  findColAfter(headers, 'キャンセル数', 0),
    cancelRate:   findColAfter(headers, 'C率', 0),
    enroll:       findColAfter(headers, '入会', 0, true),
    enrollRate:   findColAfter(headers, '入会率', 0),
    review:       findColAfter(headers, '口コミ', 0, true),
    reviewRate:   findColAfter(headers, '口コミ率', 0),
    cpaRes:       findColContains(headers, 'CPA', '予約'),
    cpaVisit:     findColContains(headers, 'CPA', '来院'),
    spent:        findColContains(headers, '消化'),
    imp:          findCol(headers, 'IMP'),
    clicks:       findColAfter(headers, 'クリック', 0, true),
    cpm:          findCol(headers, 'CPM'),
    cpc:          findCol(headers, 'CPC'),
    ctr:          findCol(headers, 'CTR'),
    cvr:          findCol(headers, 'CVR'),
    monthlySales: findColContains(headers, '当月売上'),
    futureSales:  findColContains(headers, '翌月', '見込'),
  };

  Logger.log('メイン列マッピング: ' + JSON.stringify(mainCols));

  // ===== 媒体セクションを検出 =====
  // 「X経由」パターンでセクションヘッダーを探す
  // ヘッダー行の1-2行上のセクション行もチェック
  const mediaSections = detectMediaSections(allData, headerRowIdx, headers);
  Logger.log('検出した媒体セクション: ' + mediaSections.map(s => s.name).join(', '));

  // ===== データ行を処理 =====
  const results = [];
  for (let r = headerRowIdx + 1; r < allData.length; r++) {
    const row = allData[r];

    // 店舗名を取得
    const storeName = mainCols.store >= 0 ? String(row[mainCols.store]).trim() : '';
    if (!storeName || storeName === '' || storeName === 'undefined') continue;

    // 合計行をスキップ
    const noVal = mainCols.no >= 0 ? String(row[mainCols.no]).trim() : '';
    if (!noVal || isNaN(Number(noVal))) continue;

    const area = mainCols.area >= 0 ? String(row[mainCols.area]).trim() : '';

    // 1) Meta広告の合計レコード
    const metaRecord = {
      月: sheetName,
      店舗: storeName,
      エリア: area,
      媒体: 'Meta広告',
      予約数: getNum(row, mainCols.metaRes),
      実来院: getNum(row, mainCols.visits),
      キャンセル数: getNum(row, mainCols.cancelCount),
      キャンセル率: getPercent(row, mainCols.cancelRate),
      入会数: getNum(row, mainCols.enroll),
      入会率: getPercent(row, mainCols.enrollRate),
      口コミ数: getNum(row, mainCols.review),
      口コミ率: getPercent(row, mainCols.reviewRate),
      CPA予約: getNum(row, mainCols.cpaRes),
      CPA来院: getNum(row, mainCols.cpaVisit),
      広告費: getNum(row, mainCols.spent),
      IMP: getNum(row, mainCols.imp),
      クリック数: getNum(row, mainCols.clicks),
      CTR: getPercent(row, mainCols.ctr),
      CVR: getPercent(row, mainCols.cvr),
      当月売上: getNum(row, mainCols.monthlySales),
      見込売上: getNum(row, mainCols.futureSales),
      予算: getNum(row, mainCols.budget),
    };
    results.push(metaRecord);

    // 2) 各媒体セクションのレコード
    for (const section of mediaSections) {
      const record = extractMediaRecord(row, section, storeName, area, sheetName);
      if (record && (record.予約数 > 0 || record.実来院 > 0 || record.入会数 > 0)) {
        results.push(record);
      }
    }
  }

  // 3) 合計行を作成（店舗ごと全媒体合計）
  const storeMap = {};
  results.forEach(r => {
    if (!storeMap[r.店舗]) {
      storeMap[r.店舗] = {
        月: r.月, 店舗: r.店舗, エリア: r.エリア, 媒体: '全媒体合計',
        予約数: 0, 実来院: 0, キャンセル数: 0, 入会数: 0, 口コミ数: 0,
        広告費: 0, 当月売上: 0, 見込売上: 0, 予算: 0,
      };
    }
    const t = storeMap[r.店舗];
    t.予約数 += r.予約数 || 0;
    t.実来院 += r.実来院 || 0;
    t.キャンセル数 += r.キャンセル数 || 0;
    t.入会数 += r.入会数 || 0;
    t.口コミ数 += r.口コミ数 || 0;
    t.広告費 += r.広告費 || 0;
    t.当月売上 += r.当月売上 || 0;
    t.見込売上 += r.見込売上 || 0;
    t.予算 = Math.max(t.予算, r.予算 || 0);
  });

  // 合計行の率を計算
  const totals = Object.values(storeMap).map(t => {
    t.入会率 = t.実来院 > 0 ? Math.round((t.入会数 / t.実来院) * 100) : 0;
    t.キャンセル率 = t.予約数 > 0 ? Math.round((t.キャンセル数 / t.予約数) * 100) : 0;
    t.口コミ率 = t.実来院 > 0 ? Math.round((t.口コミ数 / t.実来院) * 100) : 0;
    t.CPA予約 = t.予約数 > 0 ? Math.round(t.広告費 / t.予約数) : 0;
    t.CPA来院 = t.実来院 > 0 ? Math.round(t.広告費 / t.実来院) : 0;
    return t;
  });

  return [...totals, ...results];
}


// ===== ヘルパー関数群 =====

// シート名から月ラベルを生成
// "数値まとめ(R8.2)" → "26年2月"  (令和8年=2026年)
// "META API(202601)" → "26年1月"
// それ以外 → シート名そのまま
function parseSheetMonth(name) {
  // 令和パターン: R7.12, R8.2 など
  var rMatch = name.match(/R(\d+)\.(\d+)/);
  if (rMatch) {
    var westernYear = 2018 + parseInt(rMatch[1]);
    var month = parseInt(rMatch[2]);
    return (westernYear % 100) + '年' + month + '月';
  }
  // 西暦パターン: 202601, 202512 など
  var apiMatch = name.match(/(\d{4})(\d{2})/);
  if (apiMatch) {
    var year = parseInt(apiMatch[1]);
    var month2 = parseInt(apiMatch[2]);
    if (month2 >= 1 && month2 <= 12) {
      return (year % 100) + '年' + month2 + '月';
    }
  }
  return name;
}

// ヘッダー行から完全一致でカラムインデックスを取得
function findCol(headers, name) {
  const idx = headers.indexOf(name);
  return idx;
}

// ヘッダー行から部分一致でカラムインデックスを取得（複数キーワードAND）
function findColContains(headers, keyword1, keyword2) {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (h.includes(keyword1) && (!keyword2 || h.includes(keyword2))) return i;
  }
  return -1;
}

// 指定位置以降で最初に見つかるカラムを取得
// exactMatch=trueの場合は完全一致のみ
function findColAfter(headers, name, afterIdx, exactMatch) {
  for (let i = afterIdx; i < headers.length; i++) {
    if (exactMatch ? headers[i] === name : headers[i].includes(name)) return i;
  }
  return -1;
}

// セルから数値を取得（通貨記号・カンマを除去）
function getNum(row, colIdx) {
  if (colIdx < 0 || colIdx >= row.length) return 0;
  const val = row[colIdx];
  if (val === '' || val === null || val === undefined || val === '-') return 0;
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  const cleaned = String(val).replace(/[¥,%\s円]/g, '').replace(/,/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '#DIV/0!') return 0;
  const num = Number(cleaned);
  return isNaN(num) ? 0 : num;
}

// セルからパーセント値を取得（0-100のスケール）
function getPercent(row, colIdx) {
  if (colIdx < 0 || colIdx >= row.length) return 0;
  const val = row[colIdx];
  if (val === '' || val === null || val === undefined || val === '-' || val === '#DIV/0!') return 0;
  if (typeof val === 'number') {
    // 0.5 → 50%, 50 → 50%
    return val > 0 && val <= 1 ? Math.round(val * 100) : Math.round(val);
  }
  const cleaned = String(val).replace(/[%\s]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '#DIV/0!') return 0;
  const num = Number(cleaned);
  if (isNaN(num)) return 0;
  return num > 0 && num <= 1 ? Math.round(num * 100) : Math.round(num);
}


// 媒体セクションを自動検出
// ヘッダー行の上の行（セクション行）を調べて「X経由」パターンを見つける
function detectMediaSections(allData, headerRowIdx, headers) {
  const sections = [];

  // ヘッダー行の1-2行上をセクション行として探索
  for (let offset = 1; offset <= 3; offset++) {
    const sectionRowIdx = headerRowIdx - offset;
    if (sectionRowIdx < 0) continue;

    const sectionRow = allData[sectionRowIdx];
    for (let c = 0; c < sectionRow.length; c++) {
      const cell = String(sectionRow[c]).trim();
      if (cell.includes('経由')) {
        // 媒体名を抽出（"HPB\n経由" → "HPB"）
        const name = cell.replace(/\n/g, '').replace(/経由/g, '').trim();

        // このセクション内のカラムを特定
        // セクション開始位置の次のカラムからメトリクスを探す
        const sectionCols = mapSectionColumns(headers, c, sectionRow);

        if (sectionCols) {
          sections.push({
            name: name,
            startCol: c,
            cols: sectionCols,
          });
        }
      }
    }
  }

  // セクション行で見つからない場合、ヘッダー行自体も調べる
  if (sections.length === 0) {
    for (let c = 0; c < headers.length; c++) {
      const h = headers[c];
      if (h.includes('経由')) {
        const name = h.replace(/\n/g, '').replace(/経由/g, '').trim();
        const sectionCols = mapSectionColumnsFromHeader(headers, c);
        if (sectionCols) {
          sections.push({ name: name, startCol: c, cols: sectionCols });
        }
      }
    }
  }

  return sections;
}


// セクション内のカラムをマッピング
// セクション開始位置から右に向かって、次のセクションまでのカラムを特定
function mapSectionColumns(headers, startCol, sectionRow) {
  // セクション開始位置から次のセクション（or 空でない次のセクションヘッダー）までの範囲を特定
  let endCol = headers.length;
  for (let c = startCol + 1; c < sectionRow.length; c++) {
    const cell = String(sectionRow[c]).trim();
    // 次のセクションヘッダーまたは別のデータブロック
    if (cell && (cell.includes('経由') || cell.includes('合計'))) {
      endCol = c;
      break;
    }
  }

  // この範囲内でメトリクスを探す
  const rangeHeaders = headers.slice(startCol, endCol);

  return {
    reservations: findInRange(rangeHeaders, '予約数', startCol),
    visits: findInRange(rangeHeaders, '実来院', startCol),
    cancelCount: findInRange(rangeHeaders, 'キャンセル数', startCol),
    cancelRate: findInRange(rangeHeaders, 'C率', startCol),
    enroll: findInRangeExact(rangeHeaders, '入会', startCol),
    enrollRate: findInRange(rangeHeaders, '入会率', startCol),
    review: findInRangeExact(rangeHeaders, '口コミ', startCol),
    reviewRate: findInRange(rangeHeaders, '口コミ率', startCol),
    cpaRes: findInRange(rangeHeaders, 'CPA', startCol, '予約'),
    cpaVisit: findInRange(rangeHeaders, 'CPA', startCol, '来院'),
    adSpend: findInRange(rangeHeaders, '消化', startCol) !== -1
      ? findInRange(rangeHeaders, '消化', startCol)
      : findInRange(rangeHeaders, '月額費用', startCol),
    monthlySales: findInRange(rangeHeaders, '当月売上', startCol) !== -1
      ? findInRange(rangeHeaders, '当月売上', startCol)
      : findInRange(rangeHeaders, '売上概算', startCol),
  };
}


function mapSectionColumnsFromHeader(headers, startCol) {
  // startColから30列以内を探索
  const endCol = Math.min(startCol + 30, headers.length);
  const rangeHeaders = headers.slice(startCol, endCol);
  return {
    reservations: findInRange(rangeHeaders, '予約数', startCol),
    visits: findInRange(rangeHeaders, '実来院', startCol),
    cancelCount: findInRange(rangeHeaders, 'キャンセル数', startCol),
    cancelRate: findInRange(rangeHeaders, 'C率', startCol),
    enroll: findInRangeExact(rangeHeaders, '入会', startCol),
    enrollRate: findInRange(rangeHeaders, '入会率', startCol),
    review: findInRangeExact(rangeHeaders, '口コミ', startCol),
    reviewRate: findInRange(rangeHeaders, '口コミ率', startCol),
    cpaRes: -1,
    cpaVisit: findInRange(rangeHeaders, '来店CPA', startCol),
    adSpend: findInRange(rangeHeaders, '月額費用', startCol),
    monthlySales: findInRange(rangeHeaders, '当月売上', startCol),
  };
}


function findInRange(rangeHeaders, keyword, offset, keyword2) {
  for (let i = 0; i < rangeHeaders.length; i++) {
    const h = rangeHeaders[i];
    if (h.includes(keyword) && (!keyword2 || h.includes(keyword2))) return offset + i;
  }
  return -1;
}

function findInRangeExact(rangeHeaders, keyword, offset) {
  for (let i = 0; i < rangeHeaders.length; i++) {
    if (rangeHeaders[i] === keyword) return offset + i;
  }
  return -1;
}


// 媒体セクションからレコードを抽出
function extractMediaRecord(row, section, storeName, area, sheetName) {
  const c = section.cols;
  return {
    月: sheetName,
    店舗: storeName,
    エリア: area,
    媒体: section.name,
    予約数: getNum(row, c.reservations),
    実来院: getNum(row, c.visits),
    キャンセル数: getNum(row, c.cancelCount),
    キャンセル率: getPercent(row, c.cancelRate),
    入会数: getNum(row, c.enroll),
    入会率: getPercent(row, c.enrollRate),
    口コミ数: getNum(row, c.review),
    口コミ率: getPercent(row, c.reviewRate),
    CPA予約: getNum(row, c.cpaRes),
    CPA来院: getNum(row, c.cpaVisit),
    広告費: getNum(row, c.adSpend),
    当月売上: getNum(row, c.monthlySales),
  };
}


// テスト用関数（★初回は必ずこれを実行して権限を承認★）
function testGetData() {
  try {
    const data = getMarketingData();
    Logger.log('========================================');
    Logger.log('✅ 取得したデータ数: ' + data.length);
    Logger.log('========================================');

    if (data.length > 0) {
      // カラム一覧
      Logger.log('\n【カラム一覧】');
      Object.keys(data[0]).forEach(function(key, i) {
        Logger.log('  ' + (i + 1) + '. ' + key);
      });

      // 店舗一覧
      const stores = [];
      data.forEach(function(row) {
        if (stores.indexOf(row['店舗']) === -1) stores.push(row['店舗']);
      });
      Logger.log('\n【店舗一覧】 ' + stores.length + '店舗');
      stores.forEach(function(s) { Logger.log('  - ' + s); });

      // 媒体一覧
      const media = [];
      data.forEach(function(row) {
        if (media.indexOf(row['媒体']) === -1) media.push(row['媒体']);
      });
      Logger.log('\n【媒体一覧】 ' + media.length + '種類');
      media.forEach(function(m) { Logger.log('  - ' + m); });

      // サンプルデータ
      Logger.log('\n【サンプル: 先頭5件】');
      data.slice(0, 5).forEach(function(row, i) {
        Logger.log('--- ' + (i + 1) + ': ' + row['店舗'] + ' / ' + row['媒体'] + ' ---');
        Logger.log(JSON.stringify(row));
      });
    } else {
      Logger.log('データが見つかりません。');
      Logger.log('SPREADSHEET_ID と SHEET_NAME を確認してください。');
    }

    Logger.log('\n✅ テスト完了！デプロイに進んでください。');
  } catch (error) {
    Logger.log('❌ エラー: ' + error.toString());
    Logger.log('\n確認事項:');
    Logger.log('1. SPREADSHEET_ID が正しいか');
    Logger.log('2. SHEET_NAME が正しいか');
    Logger.log('3. スプレッドシートにアクセス権があるか');
  }
}


// 予約進捗管理シートからメニュー別分析データを取得
// J列のメニュー名を基に、予約・来院・キャンセル・入会・口コミを集計
function getMenuAnalysisData() {
  try {
    var ssId = (typeof SPREADSHEET_ID !== 'undefined') ? SPREADSHEET_ID : MARKETING_SS_ID;
    const ss = SpreadsheetApp.openById(ssId);
    const allSheets = ss.getSheets();

    // 「予約進捗管理」を含むシート名を対象
    const reservationSheets = allSheets.filter(function(s) {
      return s.getName().indexOf('予約進捗管理') >= 0;
    });

    if (reservationSheets.length === 0) {
      Logger.log('⚠ 予約進捗管理シートが見つかりません');
      return [];
    }

    Logger.log('📋 予約進捗管理シート: ' + reservationSheets.length + '件');

    const menuMap = {};

    reservationSheets.forEach(function(sheet) {
      var sheetName = sheet.getName();
      var month = parseSheetMonth(sheetName);
      var lastRow = sheet.getLastRow();
      var lastCol = sheet.getLastColumn();
      if (lastRow < 3 || lastCol < 10) return;

      var allData = sheet.getRange(1, 1, lastRow, lastCol).getValues();

      // ヘッダー行を検出（「メール受信日」「店舗」「名前」などが含まれる行）
      var headerRowIdx = -1;
      for (var r = 0; r < Math.min(5, allData.length); r++) {
        var rowStr = allData[r].map(function(c) { return String(c).trim(); });
        if (rowStr.some(function(c) { return c === '店舗' || c === '院名'; }) &&
            rowStr.some(function(c) { return c === '名前' || c.indexOf('メール') >= 0; })) {
          headerRowIdx = r;
          break;
        }
      }

      if (headerRowIdx === -1) {
        // ヘッダーが見つからない場合はデフォルト位置を試す
        headerRowIdx = 0;
      }

      var headers = allData[headerRowIdx].map(function(h) { return String(h).trim(); });

      // 各列のインデックスを検出
      var storeCol = findMenuCol(headers, ['店舗', '院名']);
      var menuCol = findMenuColJ(headers, allData, headerRowIdx);
      var statusCol = findMenuCol(headers, ['来店・キャン', '来店', 'キャン']);
      var enrollCol = findMenuColExact(headers, '入会');
      var reviewCol = findMenuColExact(headers, '口コミ');

      Logger.log('  ' + sheetName + ': store=' + storeCol + ', menu=' + menuCol + ', status=' + statusCol + ', enroll=' + enrollCol + ', review=' + reviewCol);

      if (menuCol < 0) {
        Logger.log('  ⚠ メニュー列が見つかりません: ' + sheetName);
        return;
      }

      // データ行を処理
      for (var r = headerRowIdx + 1; r < allData.length; r++) {
        var row = allData[r];
        var menuName = String(row[menuCol]).trim();

        // 空行やヘッダーのような行をスキップ
        if (!menuName || menuName === '' || menuName === 'undefined' || menuName === '要望') continue;
        // メニュー名っぽくないものをスキップ（短すぎるor数字のみ）
        if (menuName.length < 3) continue;

        var storeName = storeCol >= 0 ? String(row[storeCol]).trim() : '';
        var status = statusCol >= 0 ? String(row[statusCol]).trim() : '';
        var enrollVal = enrollCol >= 0 ? String(row[enrollCol]).trim() : '';
        var reviewVal = reviewCol >= 0 ? String(row[reviewCol]).trim() : '';

        if (!menuMap[menuName]) {
          menuMap[menuName] = {
            menuName: menuName,
            reservations: 0,
            actualVisits: 0,
            advanceCancels: 0,
            sameDayCancels: 0,
            enrollments: 0,
            reviews: 0
          };
        }

        var m = menuMap[menuName];
        m.reservations++;

        // 来店・キャンセル判定
        if (status.indexOf('実来院') >= 0 || status === '来店') {
          m.actualVisits++;
        } else if (status.indexOf('事前') >= 0) {
          m.advanceCancels++;
        } else if (status.indexOf('当日') >= 0) {
          m.sameDayCancels++;
        } else if (status.indexOf('振替') >= 0) {
          m.advanceCancels++; // 振替もキャンセル扱い
        }

        // 入会判定
        if (enrollVal === '入会' || (enrollVal.indexOf('入会') >= 0 && enrollVal.indexOf('未入会') < 0 && enrollVal.indexOf('未') < 0)) {
          m.enrollments++;
        }

        // 口コミ判定
        if (reviewVal && reviewVal !== '' && reviewVal !== '-' && reviewVal !== '0' && reviewVal !== 'undefined') {
          m.reviews++;
        }
      }
    });

    var result = Object.values(menuMap).filter(function(m) { return m.reservations > 0; });

    Logger.log('✅ メニュー分析完了: ' + result.length + '種類のメニュー');
    return result;
  } catch (error) {
    Logger.log('❌ メニュー分析エラー: ' + error.toString());
    return [];
  }
}


// ヘッダー行から列を検出（複数キーワード候補対応）
function findMenuCol(headers, keywords) {
  for (var i = 0; i < headers.length; i++) {
    for (var k = 0; k < keywords.length; k++) {
      if (headers[i].indexOf(keywords[k]) >= 0) return i;
    }
  }
  return -1;
}


// ヘッダー行から完全一致で列を検出
function findMenuColExact(headers, keyword) {
  for (var i = 0; i < headers.length; i++) {
    if (headers[i] === keyword) return i;
  }
  // 完全一致が見つからない場合は部分一致
  for (var i = 0; i < headers.length; i++) {
    if (headers[i].indexOf(keyword) >= 0) return i;
  }
  return -1;
}


// メニュー列（J列）を検出
// ヘッダー名「要望」「メニュー」「コース」で探し、
// 見つからない場合は実データから円・コースを含む列を推定
function findMenuColJ(headers, allData, headerRowIdx) {
  // まずヘッダー名で探す
  var byHeader = findMenuCol(headers, ['要望', 'メニュー', 'コース名']);
  if (byHeader >= 0) return byHeader;

  // ヘッダーで見つからない場合、実データからメニュー名っぽい列を探す
  // （「円」「コース」「整体」「限定」を含む文字列が多い列）
  var sampleRows = allData.slice(headerRowIdx + 1, Math.min(headerRowIdx + 20, allData.length));
  var bestCol = -1;
  var bestScore = 0;

  for (var c = 0; c < Math.min(40, headers.length); c++) {
    var score = 0;
    for (var r = 0; r < sampleRows.length; r++) {
      var val = String(sampleRows[r][c]).trim();
      if (val.indexOf('円') >= 0) score += 2;
      if (val.indexOf('コース') >= 0) score += 2;
      if (val.indexOf('整体') >= 0) score += 2;
      if (val.indexOf('限定') >= 0) score += 1;
      if (val.indexOf('新規') >= 0) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCol = c;
    }
  }

  if (bestScore >= 5) return bestCol;

  // フォールバック: J列（インデックス9）
  return 9;
}


// スプレッドシート構造の確認（デバッグ用）
function checkStructure() {
  try {
    var ssId = (typeof SPREADSHEET_ID !== 'undefined') ? SPREADSHEET_ID : MARKETING_SS_ID;
    var sheetNameFilter = (typeof SHEET_NAME !== 'undefined') ? SHEET_NAME : MARKETING_SHEET_NAME;
    const ss = SpreadsheetApp.openById(ssId);
    Logger.log('スプレッドシート: ' + ss.getName());

    ss.getSheets().forEach(function(sheet, i) {
      Logger.log('  シート' + (i + 1) + ': ' + sheet.getName() +
                 ' (' + sheet.getLastRow() + '行 × ' + sheet.getLastColumn() + '列)');
    });

    const sheet = ss.getSheetByName(sheetNameFilter);
    if (sheet) {
      Logger.log('\n【先頭5行の内容】');
      const preview = sheet.getRange(1, 1, Math.min(5, sheet.getLastRow()), Math.min(40, sheet.getLastColumn())).getValues();
      preview.forEach(function(row, r) {
        const cells = row.map(function(c, i) {
          return c ? (String.fromCharCode(65 + i) + ':' + String(c).substring(0, 15)) : '';
        }).filter(Boolean);
        Logger.log('行' + (r + 1) + ': ' + cells.join(' | '));
      });
    }
  } catch (error) {
    Logger.log('❌ エラー: ' + error.toString());
  }
}
