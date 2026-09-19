// ── 日報・集客速報の自動送信（テンプレート生成／設定／二重送信の防止）─────────────
//
// ⚠️ このモジュールは **何も送らない・何も取得しない**。純粋関数だけ。
//    「この入力なら、どの文面を、送ってよいか」を返す。送信と取得は呼び出し側（api/plan-store.js）。
//    依存ゼロなので合成データだけで検証できる（tests/daily-report.test.js）。
//
// 目的（オーナー指示）:
//   ① 営業開始後（通常時）… SalonOne の「集計実行」を押すと売上に反映される。それを合図に
//      指定テンプレートでグループチャットへ自動送信する。**全店一括ではなく、設定で
//      「日報を自動送信する」にチェックを入れた店舗だけ。**
//   ② オープン前 … 「集計実行」が無いので指定時刻に送る。予約表から人数・流入媒体を見て
//      「どの媒体から何人新規予約が入っているか」「目標に対してあと何人か」を返す。
//
// 🔴 未確認事項（既存事実として扱わない・AGENTS.md §2）:
//   ・SalonOne に「集計実行が押された」を知らせる **Webhook があるかは未確認**。
//     現状 API からその操作は直接観測できない。そこで本モジュールは代理シグナル
//     （当日の digest_sales＝入金ベース売上が動き、その後しばらく動かない）を
//     `detectAggregationRun()` として提供する。これは **仮案** であり、
//     Webhook が確認できればそちらへ差し替える（入口だけ変えれば文面側は無変更）。
//   ・Vercel の Cron を何分おきに回せるかは契約プラン次第で未確認。間隔は設定値にしてある。
//
// 安全既定:
//   ・`enabled` は既定 false。店舗ごとにチェックを入れた所だけ。
//   ・送信先ルーム未設定なら送らない（どこへ出るか曖昧な一斉送信をしない）。
//   ・同じ店舗・同じ日・同じ種別は 1 回だけ（`shouldSend`）。再実行しても二重に出ない。
//   ・取れなかった数値は **0 で埋めず「未取得」** と書く。
//   ・全部未取得なら送らない（中身の無い定型文を流さない）。
//   ・文面末尾に必ず 出典 / 対象期間 / 取得時刻 を付ける。

export const REPORT_VERSION = 'daily-report-1';

// 送信の種別
export const CLOSING = 'closing';   // ① 営業後の日報
export const PREOPEN = 'preopen';   // ② オープン前の集客速報
export const KINDS = Object.freeze([CLOSING, PREOPEN]);

// ① のきっかけ。既定は「集計実行のあと」＝代理シグナル待ち。
//   'aggregate' … digest_sales の動きを見て送る（仮案・Webhook が付いたら差し替え）
//   'time'      … 指定時刻に送る（代理シグナルを使わない運用）
//   'manual'    … 人が「いま送る」を押したときだけ
export const TRIGGERS = Object.freeze(['aggregate', 'time', 'manual']);

const str = (v) => String(v == null ? '' : v);
const arr = (v) => (Array.isArray(v) ? v : []);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ── 時刻（JST固定）────────────────────────────────────────────────────────
// 店舗もオーナーも日本時間で動く。サーバーのTZに依存させない。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function jstParts(ms) {
  const t = isNum(ms) ? ms : Date.now();
  const d = new Date(t + JST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    hh: d.getUTCHours(), mm: d.getUTCMinutes(), w: d.getUTCDay(),
  };
}

const pad2 = (n) => String(n).padStart(2, '0');

// 'YYYY-MM-DD'（JST）
export function jstYmd(ms) {
  const p = jstParts(ms);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

// 'HH:MM'（JST）
export function jstHm(ms) {
  const p = jstParts(ms);
  return `${pad2(p.hh)}:${pad2(p.mm)}`;
}

const WDAY = ['日', '月', '火', '水', '木', '金', '土'];

// '9/19(金)' 表示用。読めない値は空文字（NaN や Invalid Date を出さない）。
export function ymdLabel(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(ymd));
  if (!m) return '';
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(t)) return '';
  return `${Number(m[2])}/${Number(m[3])}(${WDAY[new Date(t).getUTCDay()]})`;
}

// 'HH:MM' を 0時からの分に。不正なら null（0 に丸めない＝未設定と 0:00 を混同しない）。
export function hmToMinutes(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(str(hm).trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

export function normalizeHm(hm, fallback) {
  const v = hmToMinutes(hm);
  if (v == null) return fallback == null ? '' : fallback;
  return `${pad2(Math.floor(v / 60))}:${pad2(v % 60)}`;
}

// ── 店舗ごとの設定 ────────────────────────────────────────────────────────
export const DEFAULT_PREOPEN_AT = '10:00';   // オープン前の速報を出す時刻（JST）
export const DEFAULT_CLOSING_AT = '22:00';   // trigger='time' のときの日報時刻（JST）
export const SETTINGS_KEY = 'naoru:dailyreport:v1';
export const LOG_KEY = 'naoru:dailyreport:log:v1';
export const LOG_CAP = 2000;

export const DEFAULT_SHOP_SETTING = Object.freeze({
  shopId: '',
  shopName: '',
  enabled: false,          // 🔴 既定OFF。チェックを入れた店舗だけ送る。
  roomId: '',              // 送信先グループチャット（未設定なら送らない）
  closing: false,          // ① 営業後の日報を送る
  preopen: false,          // ② オープン前の集客速報を送る
  trigger: 'aggregate',    // ① のきっかけ
  closingAt: DEFAULT_CLOSING_AT,
  preopenAt: DEFAULT_PREOPEN_AT,
  targetNew: null,         // 1日の新規目標人数。null＝未設定（0人が目標、とは書かない）
  updatedAt: 0,
  updatedBy: '',
});

// 目標人数の正規化。0 は「0人が目標」として有効、負値・非数は未設定(null)。
function normTarget(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

export function normalizeShopSetting(raw, shopId) {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const id = str(shopId || r.shopId).slice(0, 40);
  return {
    shopId: id,
    shopName: str(r.shopName).slice(0, 80),
    enabled: r.enabled === true,
    roomId: str(r.roomId).slice(0, 80),
    closing: r.closing === true,
    preopen: r.preopen === true,
    trigger: TRIGGERS.includes(r.trigger) ? r.trigger : 'aggregate',
    closingAt: normalizeHm(r.closingAt, DEFAULT_CLOSING_AT),
    preopenAt: normalizeHm(r.preopenAt, DEFAULT_PREOPEN_AT),
    targetNew: normTarget(r.targetNew),
    updatedAt: isNum(r.updatedAt) && r.updatedAt > 0 ? r.updatedAt : 0,
    updatedBy: str(r.updatedBy).slice(0, 80),
  };
}

export function normalizeSettings(raw) {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const shopsIn = (r.shops && typeof r.shops === 'object' && !Array.isArray(r.shops)) ? r.shops : {};
  const shops = {};
  for (const [id, v] of Object.entries(shopsIn)) {
    const key = str(id).slice(0, 40);
    if (!key) continue;
    shops[key] = normalizeShopSetting(v, key);
  }
  return { version: REPORT_VERSION, shops };
}

// 送信対象の店舗だけを返す（enabled かつ その種別が ON かつ 送信先あり）。
// 🔴 ここが「全店一括にしない」ための唯一の入口。呼び出し側は必ずこれを通す。
export function targetsFor(settings, kind) {
  if (!KINDS.includes(kind)) return [];
  const s = normalizeSettings(settings);
  return Object.values(s.shops).filter((x) => {
    if (!x.enabled) return false;
    if (!x.roomId) return false;
    return kind === CLOSING ? x.closing : x.preopen;
  });
}

// 設定が「送れる状態か」を人に説明するための理由つき判定（画面の注意書き用）。
export const SETTING_REASON = Object.freeze({
  ok: '',
  disabled: '自動送信がOFFです。',
  no_room: '送信先のグループチャットが選ばれていません。',
  no_kind: '送る種類（日報／集客速報）が選ばれていません。',
});

export function settingReady(setting) {
  const s = normalizeShopSetting(setting);
  if (!s.enabled) return { ok: false, reason: 'disabled' };
  if (!s.closing && !s.preopen) return { ok: false, reason: 'no_kind' };
  if (!s.roomId) return { ok: false, reason: 'no_room' };
  return { ok: true, reason: 'ok' };
}

// ── 数値の出し方 ──────────────────────────────────────────────────────────
// 🔴 取れなかったものを 0 と書かない。「未取得」と書いて missing に積む。
export const NOT_FETCHED = '未取得';

export function yen(v) {
  if (!isNum(v)) return NOT_FETCHED;
  return `¥${Math.round(v).toLocaleString('ja-JP')}`;
}

export function people(v, unit = '名') {
  if (!isNum(v)) return NOT_FETCHED;
  return `${Math.round(v)}${unit}`;
}

export function percent(v) {
  if (!isNum(v)) return NOT_FETCHED;
  return `${Math.round(v * 10) / 10}%`;
}

// 入会率＝入会数 ÷ 新規来店数。分母が無い／0 のときは率を作らない（0% と書かない）。
export function rate(numer, denom) {
  if (!isNum(numer) || !isNum(denom) || denom <= 0) return null;
  return (numer / denom) * 100;
}

// 取得できた数値だけを拾う。undefined / null / NaN は number にしない＝「未取得」のまま。
function pick(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  const v = obj[key];
  return isNum(v) ? v : null;
}

// ── 出典フッター ──────────────────────────────────────────────────────────
// 「回答と分析には出典・対象期間・更新日時を付ける」を文面レベルで担保する。
export function footer({ sources, ymd, fetchedAt, note }) {
  const src = arr(sources).filter(Boolean).join(' / ') || NOT_FETCHED;
  const lines = [
    '────────',
    `出典: SalonOne ${src}`,
    `対象期間: ${str(ymd) || NOT_FETCHED}（1日）`,
    `取得時刻: ${isNum(fetchedAt) ? `${jstYmd(fetchedAt)} ${jstHm(fetchedAt)} JST` : NOT_FETCHED}`,
  ];
  if (note) lines.push(`※ ${note}`);
  return lines;
}

// ── ① 営業後の日報 ───────────────────────────────────────────────────────
// input:
//   shopName  店舗名
//   ymd       'YYYY-MM-DD'（JST）
//   summary   sales/summary を正規化したもの（取れなければ null）
//             { grossSales, newSales, repeatSales, newVisit, repeatVisit, cancel, noShow }
//   channels  marketing/by-channel を正規化した配列（取れなければ null）
//             [{ name, booking, visit, join, cancel }]
//   target    その日の新規目標人数（null＝未設定）
//   fetchedAt 取得時刻(ms)
export function buildClosingReport(input) {
  const i = input && typeof input === 'object' ? input : {};
  const shopName = str(i.shopName) || '(店舗名未取得)';
  const ymd = str(i.ymd);
  const sum = (i.summary && typeof i.summary === 'object') ? i.summary : null;
  const chs = Array.isArray(i.channels) ? i.channels : null;
  const target = normTarget(i.target);
  const missing = [];

  const gross = pick(sum, 'grossSales');
  const newSales = pick(sum, 'newSales');
  const repeatSales = pick(sum, 'repeatSales');
  const newVisit = pick(sum, 'newVisit');
  const repeatVisit = pick(sum, 'repeatVisit');
  const cancel = pick(sum, 'cancel');
  const noShow = pick(sum, 'noShow');

  if (gross == null) missing.push('売上');
  if (newVisit == null) missing.push('新規来店数');
  if (chs == null) missing.push('媒体別');

  const visits = (isNum(newVisit) && isNum(repeatVisit)) ? newVisit + repeatVisit : null;
  const joins = chs ? chs.reduce((a, c) => a + (isNum(c && c.join) ? c.join : 0), 0) : null;
  const joinRate = rate(joins, newVisit);

  const lines = [];
  lines.push(`【日報】${shopName}　${ymdLabel(ymd) || ymd}`);
  lines.push('');
  lines.push('■ 売上');
  lines.push(`　売上合計　${yen(gross)}`);
  lines.push(`　新規 ${yen(newSales)} ／ 既存 ${yen(repeatSales)}`);
  lines.push('');
  lines.push('■ 来店');
  lines.push(`　来店 ${people(visits)}（新規 ${people(newVisit)} ／ 既存 ${people(repeatVisit)}）`);
  lines.push(`　キャンセル ${people(cancel, '件')} ／ 無断 ${people(noShow, '件')}`);
  lines.push('');
  lines.push('■ 新規');
  if (joins == null) {
    lines.push(`　入会 ${NOT_FETCHED}`);
  } else {
    lines.push(`　入会 ${people(joins)}${joinRate == null ? '' : `（入会率 ${percent(joinRate)}）`}`);
  }
  if (target != null) {
    const diff = isNum(newVisit) ? target - newVisit : null;
    lines.push(`　目標 ${people(target)}${diff == null ? `　達成状況 ${NOT_FETCHED}` : (diff > 0 ? `　あと ${people(diff)}` : '　達成')}`);
  }

  if (chs && chs.length) {
    lines.push('');
    lines.push('■ 媒体別（新規予約）');
    for (const c of chs.slice(0, 8)) {
      const name = str(c && c.name) || '未設定';
      lines.push(`　${name}　予約 ${people(pick(c, 'booking'), '件')} ／ 来店 ${people(pick(c, 'visit'))} ／ 入会 ${people(pick(c, 'join'))}`);
    }
  } else if (chs == null) {
    lines.push('');
    lines.push(`■ 媒体別（新規予約）　${NOT_FETCHED}`);
  }

  lines.push('');
  lines.push(...footer({
    sources: ['sales/summary', 'marketing/by-channel'],
    ymd, fetchedAt: i.fetchedAt,
    note: '「集計実行」の前に取得した場合は確定前の値になることがあります。',
  }));

  return {
    kind: CLOSING, shopId: str(i.shopId), shopName, ymd,
    text: lines.join('\n'), lines, missing,
    facts: { gross, newSales, repeatSales, newVisit, repeatVisit, cancel, noShow, joins, joinRate, target },
  };
}

// ── ② オープン前の集客速報 ───────────────────────────────────────────────
// 予約表（marketing/by-channel）から「どの媒体から何人 新規予約が入っているか」と
// 「目標に対してあと何人足りないか」を返す。まだ来店していないので売上は出さない。
export function buildPreOpenReport(input) {
  const i = input && typeof input === 'object' ? input : {};
  const shopName = str(i.shopName) || '(店舗名未取得)';
  const ymd = str(i.ymd);
  const chs = Array.isArray(i.channels) ? i.channels : null;
  const target = normTarget(i.target);
  const missing = [];
  if (chs == null) missing.push('媒体別の予約');

  // 本日の新規予約数。booking_count（予約が入った数）を人数として扱う。
  const booking = chs ? chs.reduce((a, c) => a + (isNum(c && c.booking) ? c.booking : 0), 0) : null;
  const cancel = chs ? chs.reduce((a, c) => a + (isNum(c && c.cancel) ? c.cancel : 0), 0) : null;
  const live = (isNum(booking) && isNum(cancel)) ? Math.max(0, booking - cancel) : booking;
  const remain = (target != null && isNum(live)) ? target - live : null;

  const lines = [];
  lines.push(`【本日の集客速報】${shopName}　${ymdLabel(ymd) || ymd}${isNum(i.fetchedAt) ? ` ${jstHm(i.fetchedAt)} 時点` : ''}`);
  lines.push('');
  lines.push(`　本日の新規予約　${people(live)}`);
  if (target == null) {
    lines.push('　目標　未設定（設定画面で1日の新規目標を入れてください）');
  } else if (remain == null) {
    lines.push(`　目標 ${people(target)}　→　残り ${NOT_FETCHED}`);
  } else if (remain > 0) {
    lines.push(`　目標 ${people(target)}　→　あと ${people(remain)}`);
  } else {
    lines.push(`　目標 ${people(target)}　→　達成（${people(live)}）`);
  }
  if (isNum(cancel) && cancel > 0) lines.push(`　（うちキャンセル ${people(cancel, '件')}を差し引き済み）`);

  lines.push('');
  if (chs && chs.length) {
    lines.push('■ 媒体別（本日の新規予約）');
    for (const c of chs.slice(0, 8)) {
      const name = str(c && c.name) || '未設定';
      lines.push(`　${name}　${people(pick(c, 'booking'), '件')}`);
    }
  } else {
    lines.push(`■ 媒体別（本日の新規予約）　${NOT_FETCHED}`);
  }

  lines.push('');
  lines.push(...footer({
    sources: ['marketing/by-channel'],
    ymd, fetchedAt: i.fetchedAt,
    note: '予約時点の数字です。来店・入会の結果は営業後の日報で出します。',
  }));

  return {
    kind: PREOPEN, shopId: str(i.shopId), shopName, ymd,
    text: lines.join('\n'), lines, missing,
    facts: { booking, cancel, live, target, remain },
  };
}

export function buildReport(kind, input) {
  if (kind === PREOPEN) return buildPreOpenReport(input);
  return buildClosingReport(input);
}

// ── 送ってよいか ──────────────────────────────────────────────────────────
export const READY_REASON = Object.freeze({
  ok: '',
  no_data: '数字がまったく取れていないので送りません。',
  no_room: '送信先のグループチャットが未設定です。',
});

// facts のうち「設定から来た値」。取得できたかの判定には数えない。
// 🔴 ここを数えると、目標人数を入れただけの店舗へ中身が全部「未取得」の定型文が飛ぶ。
const CONFIGURED_FACT_KEYS = Object.freeze(['target']);

// 中身が空（取得できた数字が1つも無い）の定型文を流さない。
export function reportReady(report) {
  const r = report && typeof report === 'object' ? report : {};
  const f = r.facts && typeof r.facts === 'object' ? r.facts : {};
  const anyNumber = Object.entries(f)
    .filter(([k]) => !CONFIGURED_FACT_KEYS.includes(k))
    .some(([, v]) => isNum(v));
  if (!anyNumber) return { ok: false, reason: 'no_data' };
  return { ok: true, reason: 'ok' };
}

// ── 二重送信の防止 ────────────────────────────────────────────────────────
// 同じ店舗・同じ日・同じ種別は 1 回だけ。Cron の再実行・多重起動・再デプロイでも増えない。
export function sendKey(shopId, ymd, kind) {
  return `${str(shopId)}|${str(ymd)}|${str(kind)}`;
}

// 文面の指紋。中身が変わったかを見るためのもの（暗号用途ではない）。
export function contentHash(text) {
  const s = str(text);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0; h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = (h2 + c) >>> 0; h2 = Math.imul(h2, 2246822519) >>> 0;
  }
  return `${h1.toString(16)}${h2.toString(16)}`;
}

export const SEND_REASON = Object.freeze({
  ok: '',
  already: 'この店舗の本日ぶんは送信済みです。',
  same_content: '前回と同じ内容なので送りません。',
  not_ready: '送れる状態ではありません。',
});

// log: { [sendKey]: { at, hash, messageId, roomId } }
export function alreadySent(log, key) {
  const l = (log && typeof log === 'object' && !Array.isArray(log)) ? log : {};
  const e = l[str(key)];
  return (e && typeof e === 'object') ? e : null;
}

// 送ってよいか最終判定。force=true でも「同じ内容」は止める（押し間違いの連投を防ぐ）。
export function shouldSend({ log, key, hash, force }) {
  const prev = alreadySent(log, key);
  if (!prev) return { send: true, reason: 'ok' };
  if (str(prev.hash) === str(hash)) return { send: false, reason: 'same_content' };
  if (force === true) return { send: true, reason: 'ok' };
  return { send: false, reason: 'already' };
}

export function recordSent(log, key, entry) {
  const l = (log && typeof log === 'object' && !Array.isArray(log)) ? { ...log } : {};
  l[str(key)] = {
    at: isNum(entry && entry.at) ? entry.at : Date.now(),
    hash: str(entry && entry.hash),
    messageId: str(entry && entry.messageId).slice(0, 80),
    roomId: str(entry && entry.roomId).slice(0, 80),
  };
  // 古い記録を落とす（日付キーの昇順で後ろを残す）。無制限に増やさない。
  const keys = Object.keys(l);
  if (keys.length > LOG_CAP) {
    keys.sort((a, b) => (l[a].at || 0) - (l[b].at || 0));
    for (const k of keys.slice(0, keys.length - LOG_CAP)) delete l[k];
  }
  return l;
}

// ── ① のきっかけ（仮案）────────────────────────────────────────────────
// 🔴 「集計実行」ボタンが押されたことは API から直接わからない（Webhook 未確認）。
//    代わりに「当日の入金ベース売上(digest_sales)が動き、その後 stableMinutes 動かない」
//    を “集計が走り終えた” の代理とする。**これは推測であり確定ではない。**
//    文面には確定前の可能性がある旨を必ず入れる（buildClosingReport の note）。
export const DEFAULT_STABLE_MINUTES = 30;

// prev: 前回観測 { digest, at } / cur: 今回観測 { digest, at }
export function detectAggregationRun(prev, cur, stableMinutes = DEFAULT_STABLE_MINUTES) {
  const p = (prev && typeof prev === 'object') ? prev : null;
  const c = (cur && typeof cur === 'object') ? cur : null;
  const cd = pick(c, 'digest');
  if (cd == null) return { changed: false, settled: false, reason: 'no_data' };
  if (!p) return { changed: false, settled: false, reason: 'first_observation' };
  const pd = pick(p, 'digest');
  if (pd == null) return { changed: false, settled: false, reason: 'first_observation' };
  if (cd !== pd) return { changed: true, settled: false, reason: 'moved' };
  // 動いていない。最後に動いた時刻からの経過を見る。
  const lastMoved = isNum(p.lastMovedAt) ? p.lastMovedAt : null;
  if (lastMoved == null) return { changed: false, settled: false, reason: 'never_moved' };
  const now = isNum(c.at) ? c.at : Date.now();
  const mins = (now - lastMoved) / 60000;
  if (mins >= stableMinutes) return { changed: false, settled: true, reason: 'settled' };
  return { changed: false, settled: false, reason: 'waiting' };
}

// 観測値の更新（呼び出し側が保存する）。
export function advanceObservation(prev, cur) {
  const c = (cur && typeof cur === 'object') ? cur : {};
  const cd = pick(c, 'digest');
  const at = isNum(c.at) ? c.at : Date.now();
  const p = (prev && typeof prev === 'object') ? prev : {};
  const pd = pick(p, 'digest');
  const moved = cd != null && pd != null && cd !== pd;
  return {
    digest: cd,
    at,
    lastMovedAt: moved ? at : (isNum(p.lastMovedAt) ? p.lastMovedAt : (pd == null && cd != null ? at : null)),
  };
}

// ── 指定時刻に達したか ────────────────────────────────────────────────────
// Cron は分単位でぴったり来ない。「その時刻を過ぎていて、まだ今日送っていない」で判定する。
export function timeReached(hm, nowMs) {
  const target = hmToMinutes(hm);
  if (target == null) return false;
  const p = jstParts(nowMs);
  return (p.hh * 60 + p.mm) >= target;
}

// ── 実行計画（何を送る予定か）────────────────────────────────────────────
// 送信そのものはしない。「この時点で送る対象はどれか」を列挙して返す＝画面でも確認できる。
export function planRun({ settings, kind, log, nowMs }) {
  const now = isNum(nowMs) ? nowMs : Date.now();
  const ymd = jstYmd(now);
  const out = [];
  for (const s of targetsFor(settings, kind)) {
    const key = sendKey(s.shopId, ymd, kind);
    const prev = alreadySent(log, key);
    if (prev) { out.push({ setting: s, key, ymd, due: false, reason: 'already' }); continue; }
    if (kind === PREOPEN) {
      const due = timeReached(s.preopenAt, now);
      out.push({ setting: s, key, ymd, due, reason: due ? 'ok' : 'waiting' });
    } else if (s.trigger === 'time') {
      const due = timeReached(s.closingAt, now);
      out.push({ setting: s, key, ymd, due, reason: due ? 'ok' : 'waiting' });
    } else if (s.trigger === 'manual') {
      out.push({ setting: s, key, ymd, due: false, reason: 'manual_only' });
    } else {
      // 'aggregate' … 呼び出し側が detectAggregationRun で判定してから送る
      out.push({ setting: s, key, ymd, due: false, reason: 'needs_aggregate_check' });
    }
  }
  return out;
}

// ── SalonOne の応答を、この文面が使う形へ ─────────────────────────────────
// 🔴 画面側の soNum() は欠けた項目を 0 にするが、ここでは **0 にしない**。
//    「0円だった日」と「取れなかった日」を同じ文面にしないため、欠けは null のまま返す。
//    （対応する上流の項目名は index.html の normalizeSalonSummary / normalizeMkChannels と同じ）
function numOrNull(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

// sales/summary の data（1店舗・1日ぶん）
export function normalizeSummary(data) {
  const s = (data && typeof data === 'object' && !Array.isArray(data)) ? data
          : (Array.isArray(data) && data[0] && typeof data[0] === 'object') ? data[0]
          : null;
  if (!s) return null;
  return {
    // 売上＝会計済み(digest＝入金ベース)。予測を含む粗売上は後ろに置く（画面と同じ優先順位）。
    grossSales: numOrNull(s, 'digest_sales', 'gross_sales', 'grossSales'),
    newSales: numOrNull(s, 'new_customer_sales', 'newCustomerSales'),
    repeatSales: numOrNull(s, 'repeat_customer_sales', 'repeatCustomerSales'),
    newVisit: numOrNull(s, 'new_visit_count', 'newVisitCount'),
    repeatVisit: numOrNull(s, 'repeat_visit_count', 'repeatVisitCount'),
    cancel: numOrNull(s, 'cancel_count', 'cancelCount'),
    noShow: numOrNull(s, 'no_show_count', 'noShowCount'),
    digest: numOrNull(s, 'digest_sales', 'digestSales'),
  };
}

// marketing/by-channel の data（媒体別）
export function normalizeChannels(data) {
  if (!Array.isArray(data)) return null;
  return data.map((c) => ({
    name: str(c && c.name) || '未設定',
    booking: numOrNull(c, 'booking_count'),
    visit: numOrNull(c, 'visit_count'),
    cancel: numOrNull(c, 'cancel_count'),
    join: numOrNull(c, 'join_count'),
  })).filter((c) => (isNum(c.booking) && c.booking > 0) || (isNum(c.visit) && c.visit > 0))
    .sort((a, b) => (b.booking || 0) - (a.booking || 0));
}
