// ── 勉強会・イベント日程 ロジック（純粋関数） ──────────────────────────
// スプレッドシート風の共有編集表（部活／飲み会イベント／勉強会）。保存は api/plan-store.js（?type=events）。
// 日付が過ぎた行を自動でグレーアウトするための日付解釈をここに集約。tests/events.test.js でカバー。

// 繰り返し・未定を表すキーワード（＝日付超過にはしない）
const RECURRING_RE = /(毎週|毎月|毎日|隔週|未定|自由|随時|通年)/;

// 日付文字列を解釈する。
//   戻り値: { recurring:true }               … 毎週/未定など（グレーアウトしない）
//           { recurring:false, date: Date }  … 具体日
//           null                              … 解釈不能（グレーアウトしない）
// 対応例: '3/13' '3月13日' '8月22日(金)' '12月7日8日' '9/1,9/8'（先頭を採用）
export function parseEventDate(str, now = new Date()) {
  const s = String(str || '').trim();
  if (!s) return null;
  if (RECURRING_RE.test(s)) return { recurring: true };
  const m = s.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})/);
  if (!m) return null;
  const month = Number(m[1]), day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const y = now.getFullYear();
  let date = new Date(y, month - 1, day);
  // 年跨ぎ対策: 現在より半年以上「先」に見える日付は前年のもの（去年の残り）とみなす。
  const MS = 24 * 3600 * 1000;
  if ((date - now) / MS > 183) date = new Date(y - 1, month - 1, day);
  return { recurring: false, date };
}

// その行（日付セル）が「過ぎた予定」か。繰り返し・未定・解釈不能は false。
export function isPastEvent(str, now = new Date()) {
  const p = parseEventDate(str, now);
  if (!p || p.recurring) return false;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return p.date < today;
}

// 一意ID
export function genId(prefix = 'r') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// セクション定義（列）。フロント/バックで共有できるよう純粋データで持つ。
export const EVENT_SECTIONS = [
  {
    key: 'study', title: '勉強会', accent: '#6BA368',
    cols: [
      { key: 'date', label: '日付', w: 110 }, { key: 'time', label: '時間', w: 120 },
      { key: 'place', label: '場所', w: 130 }, { key: 'owner', label: '責任者', w: 90 },
      { key: 'teacher', label: '講師', w: 90 }, { key: 'capacity', label: '定員', w: 70 },
      { key: 'content', label: '内容', w: 220 }, { key: 'contact', label: 'コンタクト方法', w: 160 },
    ],
  },
  {
    key: 'event', title: '飲み会などのイベント', accent: '#E8934A',
    cols: [
      { key: 'date', label: '日付', w: 110 }, { key: 'time', label: '時間', w: 120 },
      { key: 'place', label: '場所', w: 120 }, { key: 'owner', label: '責任者', w: 100 },
      { key: 'content', label: '内容', w: 220 }, { key: 'capacity', label: '定員', w: 80 },
      { key: 'contact', label: 'コンタクト方法', w: 150 },
    ],
  },
  {
    key: 'bukatsu', title: '部活', accent: '#D64545',
    cols: [
      { key: 'date', label: '日付', w: 110 }, { key: 'time', label: '時間', w: 120 },
      { key: 'place', label: '場所', w: 130 }, { key: 'club', label: '部活', w: 110 },
      { key: 'content', label: '内容', w: 200 }, { key: 'charge', label: '担当', w: 90 },
    ],
  },
];
