// ============================================================
// GAS (Google Apps Script) - スタッフタスク管理スクリプト
// ============================================================
//
// 【セットアップ手順】
// 1. Google スプレッドシートを新規作成
// 2. シート名を「月次目標」と「週次タスク」の2つ作成
// 3. 各シートのヘッダー（A1行）:
//
//    ■「月次目標」シート:
//    | id | yearMonth | title | description | completed | createdAt | updatedAt |
//
//    ■「週次タスク」シート:
//    | id | goalId | yearMonth | weekNumber | title | assignee | completed | createdAt | updatedAt |
//
// 4. 拡張機能 → Apps Script を開く
// 5. 以下のコードを貼り付けてデプロイ
//    - 「デプロイ」→「新しいデプロイ」→ 種類: ウェブアプリ
//    - 実行者: 自分、アクセス: 全員
// 6. デプロイURLを Vercel 環境変数 TASKS_GAS_URL に設定
//
// 【API仕様】
// GET  ?action=list&yearMonth=2026-03       → 月次目標 + 週次タスク一覧
// POST { action: "upsertGoal", ... }        → 月次目標の追加/更新
// POST { action: "deleteGoal", id: "xxx" }  → 月次目標の削除
// POST { action: "upsertTask", ... }        → 週次タスクの追加/更新
// POST { action: "deleteTask", id: "xxx" }  → 週次タスクの削除
// POST { action: "toggleGoal", id, completed } → 月次目標の完了切替
// POST { action: "toggleTask", id, completed } → 週次タスクの完了切替
// ============================================================

const GOALS_SHEET = '月次目標';
const TASKS_SHEET = '週次タスク';

// ── ユーティリティ ──
function generateId() {
  return Utilities.getUuid().replace(/-/g, '').substring(0, 12);
}

function getOrCreateSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function sheetToObjects(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

function findRowById(sheet, id) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === id) return i + 1; // 1-indexed row number
  }
  return -1;
}

// ── GET: データ取得 ──
function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const yearMonth = (e && e.parameter && e.parameter.yearMonth) || '';

  const goalsSheet = getOrCreateSheet(ss, GOALS_SHEET,
    ['id', 'yearMonth', 'title', 'description', 'completed', 'createdAt', 'updatedAt']);
  const tasksSheet = getOrCreateSheet(ss, TASKS_SHEET,
    ['id', 'goalId', 'yearMonth', 'weekNumber', 'title', 'assignee', 'completed', 'createdAt', 'updatedAt']);

  let goals = sheetToObjects(goalsSheet);
  let tasks = sheetToObjects(tasksSheet);

  // yearMonth フィルタ
  if (yearMonth) {
    goals = goals.filter(g => g.yearMonth === yearMonth);
    tasks = tasks.filter(t => t.yearMonth === yearMonth);
  }

  // completed をbooleanに正規化
  goals = goals.map(g => ({ ...g, completed: g.completed === true || g.completed === 'TRUE' || g.completed === 'true' }));
  tasks = tasks.map(t => ({ ...t, completed: t.completed === true || t.completed === 'TRUE' || t.completed === 'true' }));

  return ContentService.createTextOutput(JSON.stringify({ goals, tasks }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── POST: データ変更 ──
function doPost(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'Invalid JSON' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const now = new Date().toISOString();
  const action = body.action;

  // ── 月次目標: 追加/更新 ──
  if (action === 'upsertGoal') {
    const sheet = getOrCreateSheet(ss, GOALS_SHEET,
      ['id', 'yearMonth', 'title', 'description', 'completed', 'createdAt', 'updatedAt']);
    const id = body.id || generateId();
    const rowNum = body.id ? findRowById(sheet, body.id) : -1;

    if (rowNum > 0) {
      // 更新
      sheet.getRange(rowNum, 2).setValue(body.yearMonth || '');
      sheet.getRange(rowNum, 3).setValue(body.title || '');
      sheet.getRange(rowNum, 4).setValue(body.description || '');
      sheet.getRange(rowNum, 5).setValue(body.completed || false);
      sheet.getRange(rowNum, 7).setValue(now);
    } else {
      // 新規追加
      sheet.appendRow([id, body.yearMonth || '', body.title || '', body.description || '', false, now, now]);
    }
    return ContentService.createTextOutput(JSON.stringify({ success: true, id }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // ── 月次目標: 削除 ──
  if (action === 'deleteGoal') {
    const sheet = ss.getSheetByName(GOALS_SHEET);
    if (sheet) {
      const rowNum = findRowById(sheet, body.id);
      if (rowNum > 0) sheet.deleteRow(rowNum);
    }
    // 関連する週次タスクも削除
    const tasksSheet = ss.getSheetByName(TASKS_SHEET);
    if (tasksSheet) {
      const data = tasksSheet.getDataRange().getValues();
      for (let i = data.length - 1; i >= 1; i--) {
        if (data[i][1] === body.id) tasksSheet.deleteRow(i + 1);
      }
    }
    return ContentService.createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // ── 月次目標: 完了切替 ──
  if (action === 'toggleGoal') {
    const sheet = ss.getSheetByName(GOALS_SHEET);
    if (sheet) {
      const rowNum = findRowById(sheet, body.id);
      if (rowNum > 0) {
        sheet.getRange(rowNum, 5).setValue(body.completed === true || body.completed === 'true');
        sheet.getRange(rowNum, 7).setValue(now);
      }
    }
    return ContentService.createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // ── 週次タスク: 追加/更新 ──
  if (action === 'upsertTask') {
    const sheet = getOrCreateSheet(ss, TASKS_SHEET,
      ['id', 'goalId', 'yearMonth', 'weekNumber', 'title', 'assignee', 'completed', 'createdAt', 'updatedAt']);
    const id = body.id || generateId();
    const rowNum = body.id ? findRowById(sheet, body.id) : -1;

    if (rowNum > 0) {
      sheet.getRange(rowNum, 2).setValue(body.goalId || '');
      sheet.getRange(rowNum, 3).setValue(body.yearMonth || '');
      sheet.getRange(rowNum, 4).setValue(body.weekNumber || 1);
      sheet.getRange(rowNum, 5).setValue(body.title || '');
      sheet.getRange(rowNum, 6).setValue(body.assignee || '');
      sheet.getRange(rowNum, 7).setValue(body.completed || false);
      sheet.getRange(rowNum, 9).setValue(now);
    } else {
      sheet.appendRow([id, body.goalId || '', body.yearMonth || '', body.weekNumber || 1, body.title || '', body.assignee || '', false, now, now]);
    }
    return ContentService.createTextOutput(JSON.stringify({ success: true, id }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // ── 週次タスク: 削除 ──
  if (action === 'deleteTask') {
    const sheet = ss.getSheetByName(TASKS_SHEET);
    if (sheet) {
      const rowNum = findRowById(sheet, body.id);
      if (rowNum > 0) sheet.deleteRow(rowNum);
    }
    return ContentService.createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // ── 週次タスク: 完了切替 ──
  if (action === 'toggleTask') {
    const sheet = ss.getSheetByName(TASKS_SHEET);
    if (sheet) {
      const rowNum = findRowById(sheet, body.id);
      if (rowNum > 0) {
        sheet.getRange(rowNum, 7).setValue(body.completed === true || body.completed === 'true');
        sheet.getRange(rowNum, 9).setValue(now);
      }
    }
    return ContentService.createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput(JSON.stringify({ error: 'Unknown action: ' + action }))
    .setMimeType(ContentService.MimeType.JSON);
}
