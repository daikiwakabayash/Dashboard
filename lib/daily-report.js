// ── 日報・集客レポートの自動配信（テンプレート生成／設定／二重送信の防止）───────────
//
// ⚠️ このモジュールは **何も送らない・何も取得しない**。純粋関数だけ。
//    「この入力なら、どの文面を、送ってよいか」を返す。送信と取得は呼び出し側（api/plan-store.js）。
//    依存ゼロなので合成データだけで検証できる（tests/daily-report.test.js）。
//
// 店舗は3つの期間を通る。**期間ごとに別のテンプレート**を出す（オーナー指示）。
//   1. prep    … オープン前。プレオープンが始まるまで。集客の積み上げを見る（売上はまだ無い）
//   2. preopen … プレオープン期間。プレオープン日〜本オープン前日。当日の実績＋本オープンまでの集客
//   3. open    … オープン後。通常営業の日報（売上・来店・入会・媒体別）
// どの期間かは店舗ごとの プレオープン日 / 本オープン日 と今日の日付で決まる（phaseOf）。
// 日付が未設定の店舗＝既存店なので open として扱う。
//
// 🔴 未確認事項（既存事実として扱わない・AGENTS.md §2）:
//   ・SalonOne に「集計実行が押された」を知らせる Webhook があるかは未確認。
//     `detectAggregationRun()` は入金ベース売上の動きを見る **代理シグナル（仮案）**。
//   ・Vercel の Cron を何分おきに回せるかは契約プラン次第で未確認。
//
// 安全既定:
//   ・`enabled` は既定 false。店舗ごとにチェックを入れた所だけ。
//   ・送信先ルーム未設定なら送らない。
//   ・同じ店舗・同じ日・同じ期間は 1 回だけ（`shouldSend`）。
//   ・取れなかった数値は **0 で埋めず「未取得」**。全部未取得なら送らない。
//   ・文面末尾に必ず 出典 / 対象期間 / 取得時刻 を付ける。

export const REPORT_VERSION = 'daily-report-2';

// ── 期間 ──────────────────────────────────────────────────────────────────
export const PREP = 'prep';        // オープン前（プレオープン開始まで）
export const PREOPEN = 'preopen';  // プレオープン期間
export const OPEN = 'open';        // オープン後（通常営業）
export const PHASES = Object.freeze([PREP, PREOPEN, OPEN]);

export const PHASE_LABEL = Object.freeze({
  prep: 'オープン前 集客レポート',
  preopen: 'プレオープン日報',
  open: '日報',
});

// ① のきっかけ（open のときだけ使う）
export const TRIGGERS = Object.freeze(['aggregate', 'time', 'manual']);

const str = (v) => String(v == null ? '' : v);
const arr = (v) => (Array.isArray(v) ? v : []);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ── 時刻（JST固定）────────────────────────────────────────────────────────
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

export function jstYmd(ms) {
  const p = jstParts(ms);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

export function jstHm(ms) {
  const p = jstParts(ms);
  return `${pad2(p.hh)}:${pad2(p.mm)}`;
}

const WDAY = ['日', '月', '火', '水', '木', '金', '土'];

const ymdParts = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(ymd));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  // 2月30日のような存在しない日を弾く
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, m: mo, d, t, w: dt.getUTCDay() };
};

// '9/19(土)'
export function ymdLabel(ymd) {
  const p = ymdParts(ymd);
  if (!p) return '';
  return `${p.m}/${p.d}(${WDAY[p.w]})`;
}

// '2026/09/19（土）'
export function ymdLabelFull(ymd) {
  const p = ymdParts(ymd);
  if (!p) return '';
  return `${p.y}/${pad2(p.m)}/${pad2(p.d)}（${WDAY[p.w]}）`;
}

// 日付の前後比較。どちらかが読めなければ null（「分からない」を false と混同しない）。
export function compareYmd(a, b) {
  const pa = ymdParts(a), pb = ymdParts(b);
  if (!pa || !pb) return null;
  return pa.t === pb.t ? 0 : (pa.t < pb.t ? -1 : 1);
}

// 'YYYY-MM' の月初・月末
export function monthRange(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(str(ym));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${y}-${pad2(mo)}-01`, to: `${y}-${pad2(mo)}-${pad2(last)}`, label: `${mo}月` };
}

export function monthOf(ymd) {
  const p = ymdParts(ymd);
  return p ? `${p.y}-${pad2(p.m)}` : '';
}

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

export function timeReached(hm, nowMs) {
  const target = hmToMinutes(hm);
  if (target == null) return false;
  const p = jstParts(nowMs);
  return (p.hh * 60 + p.mm) >= target;
}

// ── 店舗ごとの設定 ────────────────────────────────────────────────────────
export const DEFAULT_SEND_AT = '19:00';      // 集客レポートの配信時刻（JST）
export const DEFAULT_CLOSING_AT = '22:00';   // open で trigger='time' のときの日報時刻
export const SETTINGS_KEY = 'naoru:dailyreport:v1';
export const LOG_KEY = 'naoru:dailyreport:log:v1';
export const SNAP_KEY = 'naoru:dailyreport:snap:v1';
export const LOG_CAP = 2000;

function normTarget(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

const normYmd = (v) => (ymdParts(v) ? str(v) : '');

export function normalizeShopSetting(raw, shopId) {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const id = str(shopId || r.shopId).slice(0, 40);
  const openDate = normYmd(r.openDate);
  return {
    shopId: id,
    shopName: str(r.shopName).slice(0, 80),
    enabled: r.enabled === true,          // 🔴 既定OFF
    roomId: str(r.roomId).slice(0, 80),

    // 期間を決める日付。未設定＝既存店（常に open）
    preOpenDate: normYmd(r.preOpenDate),
    openDate,

    // 集客の目標（prep / preopen で使う）
    targetNew: normTarget(r.targetNew),
    targetDeadline: normYmd(r.targetDeadline),
    // 対象月＝「何月の新規来店予約を数えるか」。未設定なら本オープンの月。
    targetMonth: /^\d{4}-\d{2}$/.test(str(r.targetMonth)) ? str(r.targetMonth) : monthOf(openDate),

    // 配信
    sendAt: normalizeHm(r.sendAt, DEFAULT_SEND_AT),
    closingAt: normalizeHm(r.closingAt, DEFAULT_CLOSING_AT),
    trigger: TRIGGERS.includes(r.trigger) ? r.trigger : 'aggregate',

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

// ── いまどの期間か ────────────────────────────────────────────────────────
// 日付が未設定＝既存店なので open。
// プレオープン日より前 → prep ／ プレオープン日〜本オープン前日 → preopen ／ 本オープン日以降 → open
export function phaseOf(setting, nowMs) {
  const s = normalizeShopSetting(setting);
  const today = jstYmd(nowMs);
  const beforePre = compareYmd(today, s.preOpenDate);
  const beforeOpen = compareYmd(today, s.openDate);
  if (beforePre === null && beforeOpen === null) return OPEN;   // 日付なし＝既存店
  if (beforeOpen !== null && beforeOpen >= 0) return OPEN;       // 本オープン日以降
  if (beforePre !== null && beforePre < 0) return PREP;          // プレオープンより前
  if (beforePre !== null) return PREOPEN;                        // プレオープン日以降・本オープン前
  // プレオープン日が無く、本オープン前 → 準備期間として扱う
  return PREP;
}

// 送信対象の店舗（enabled かつ 送信先あり）。🔴 全店一括にしないための唯一の入口。
export function targetsFor(settings) {
  const s = normalizeSettings(settings);
  return Object.values(s.shops).filter((x) => x.enabled && x.roomId);
}

export const SETTING_REASON = Object.freeze({
  ok: '',
  disabled: '自動送信がOFFです。',
  no_room: '送信先のグループチャットが選ばれていません。',
});

export function settingReady(setting) {
  const s = normalizeShopSetting(setting);
  if (!s.enabled) return { ok: false, reason: 'disabled' };
  if (!s.roomId) return { ok: false, reason: 'no_room' };
  return { ok: true, reason: 'ok' };
}

// ── 数値の出し方 ──────────────────────────────────────────────────────────
// 🔴 取れなかったものを 0 と書かない。
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

export function rate(numer, denom) {
  if (!isNum(numer) || !isNum(denom) || denom <= 0) return null;
  return (numer / denom) * 100;
}

// 符号つき（本日の予約増減 +7 / -2）。未取得は「未取得」。
export function signed(v, unit = '件') {
  if (!isNum(v)) return NOT_FETCHED;
  const n = Math.round(v);
  return `${n > 0 ? '+' : ''}${n}${unit}`;
}

function pick(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  const v = obj[key];
  return isNum(v) ? v : null;
}

// 🔴 画面側の soNum() は欠けた項目を 0 にするが、ここでは **0 にしない**。
//    「0円だった日」と「取れなかった日」を同じ文面にしないため、欠けは null のまま返す。
function numOrNull(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

// 足し算。**1つでも未取得があれば結果も未取得**（欠けたまま合計を出さない）。
export function sumStrict(values) {
  let total = 0;
  for (const v of arr(values)) {
    if (!isNum(v)) return null;
    total += v;
  }
  return total;
}

// ── 出典フッター ──────────────────────────────────────────────────────────
export function footer({ sources, period, fetchedAt, note }) {
  const src = arr(sources).filter(Boolean).join(' / ') || NOT_FETCHED;
  const lines = [
    '────────',
    `出典: SalonOne ${src}`,
    `対象期間: ${str(period) || NOT_FETCHED}`,
    `取得時刻: ${isNum(fetchedAt) ? `${jstYmd(fetchedAt)} ${jstHm(fetchedAt)} JST` : NOT_FETCHED}`,
  ];
  if (note) lines.push(`※ ${note}`);
  return lines;
}

// ── 前日との差分（本日の新規／取消）────────────────────────────────────────
// SalonOne に「今日入った予約」を直接返す口は確認できていないので、
// **毎日の累計スナップショットの差**で出す。前日の記録が無い初日は null（0にしない）。
//
// snap: { [媒体名]: { booking, cancel, remaining } }
export function snapshotOf(channels) {
  const out = {};
  for (const c of arr(channels)) {
    const name = str(c && c.name) || '未設定';
    out[name] = {
      booking: pick(c, 'booking'),
      cancel: pick(c, 'cancel'),
      remaining: pick(c, 'remaining'),
    };
  }
  return out;
}

// 前日と今日の累計から、その日ぶんの増分を出す。
// 戻り値: { rows:[{name, added, cancelled, total}], today:{added, cancelled, net}, hasPrev }
export function dailyDelta(prevSnap, curSnap) {
  const prev = (prevSnap && typeof prevSnap === 'object' && !Array.isArray(prevSnap)) ? prevSnap : null;
  const cur = (curSnap && typeof curSnap === 'object' && !Array.isArray(curSnap)) ? curSnap : {};
  const rows = [];
  for (const [name, c] of Object.entries(cur)) {
    const p = prev ? prev[name] : null;
    const diff = (key) => {
      if (!prev) return null;                        // 前日の記録なし＝出せない
      // 前日に無かった媒体は、昨日の実績が 0 だったということ（初めてその媒体から予約が入った）。
      // normalizeChannels が件数ゼロの行を落とすので、実在する媒体が欠けて増分が膨らむことはない。
      const a = pick(c, key), b = p ? pick(p, key) : 0;
      if (a == null || b == null) return null;
      return a - b;
    };
    rows.push({
      name,
      added: diff('booking'),
      cancelled: diff('cancel'),
      total: pick(c, 'remaining'),                   // 累計の有効予約（取消済みを除く）
    });
  }
  rows.sort((a, b) => (b.total || 0) - (a.total || 0));
  // 🔴 前日の記録が無い、または今日ぶんが1件も取れていないときは「0件」と書かない。
  //    sumStrict([]) は 0 を返すので、ここで明示的に未取得へ倒す。
  const blank = !prev || !rows.length;
  return {
    rows,
    hasPrev: !!prev,
    today: blank ? { added: null, cancelled: null } : {
      added: sumStrict(rows.map(r => r.added)),
      cancelled: sumStrict(rows.map(r => r.cancelled)),
    },
  };
}

// ── 広告費 ────────────────────────────────────────────────────────────────
// 既存の広告費ストア（?type=adspend）の形 { 媒体名: 金額 } を受ける。
// 入っていない媒体は 0 にせず落とす（「広告費0円」と「未入力」を混同しない）。
export function normalizeSpend(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const items = [];
  for (const [name, v] of Object.entries(raw)) {
    // ⚠️ Number('') は 0 になる。空欄を「広告費0円」にしないため、先に弾く。
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    items.push({ name: str(name).slice(0, 60), yen: n });
  }
  if (!items.length) return null;
  items.sort((a, b) => b.yen - a.yen);
  return items;
}

export function spendTotal(items) {
  // 🔴 未入力（items が null / 空）を「合計0円」にしない。0 にすると CPA が ¥0/名 になり、
  //    さらに「数字が1つも取れていない」判定もすり抜けて空のレポートが飛ぶ。
  if (!Array.isArray(items) || !items.length) return null;
  return sumStrict(items.map(i => i && i.yen));
}

// 獲得単価。人数が0以下、または費用が無ければ作らない（¥0/名 と書かない）。
export function cpa(totalYen, count) {
  if (!isNum(totalYen) || !isNum(count) || count <= 0) return null;
  return Math.round(totalYen / count);
}

// ── ① オープン前 集客レポート（prep）─────────────────────────────────────
// 見本のデザインに合わせた構造を card として返し、チャット用の text も作る。
//
// input:
//   shopId, shopName
//   ymd        今日（JST）
//   fetchedAt  取得時刻(ms)
//   setting    正規化済みの店舗設定（プレオープン日・本オープン日・目標・締切・対象月）
//   channels   marketing/by-channel を正規化した配列（対象月ぶんの累計。取れなければ null）
//   prevSnap   前日の累計スナップショット（無ければ null）
//   spend      広告費 { 媒体名: 金額 }（無ければ null）
export function buildPrepReport(input) {
  const i = input && typeof input === 'object' ? input : {};
  const s = normalizeShopSetting(i.setting || {});
  const shopName = str(i.shopName || s.shopName) || '(店舗名未取得)';
  const ymd = str(i.ymd);
  const fetchedAt = isNum(i.fetchedAt) ? i.fetchedAt : null;
  const chs = Array.isArray(i.channels) ? i.channels : null;
  const missing = [];
  if (chs == null) missing.push('媒体別の予約');

  const curSnap = chs ? snapshotOf(chs) : {};
  const delta = dailyDelta(i.prevSnap || null, curSnap);
  const current = chs ? sumStrict(delta.rows.map(r => r.total)) : null;
  const target = s.targetNew;
  const remain = (target != null && isNum(current)) ? target - current : null;
  const achieved = rate(current, target);

  const spendItems = normalizeSpend(i.spend);
  if (!spendItems) missing.push('広告費');
  const totalYen = spendTotal(spendItems);
  const unitCost = cpa(totalYen, current);

  const mr = monthRange(s.targetMonth);
  const scopeLabel = mr ? `${mr.label}の新規来店予約が対象` : '対象月が未設定です';

  const card = {
    kind: PREP,
    brand: 'NAORU × SalonOne',
    title: PHASE_LABEL.prep,
    badge: '速報',
    atLabel: `${ymdLabelFull(ymd) || ymd} ${fetchedAt != null ? jstHm(fetchedAt) : ''}時点・日本時間`.replace('  ', ' '),
    milestones: [
      { label: 'プレオープン', value: ymdLabel(s.preOpenDate) || '未設定' },
      { label: '本オープン', value: ymdLabel(s.openDate) || '未設定' },
    ],
    goal: {
      headline: target == null ? '目標が未設定です'
        : remain == null ? `目標まで、あと${NOT_FETCHED}`
        : remain > 0 ? `目標まで、あと${people(remain)}` : `目標を達成（${people(current)}）`,
      note: target == null ? '設定画面で目標人数と締切を入れてください'
        : `目標${people(target)}・集客目標の締切 ${ymdLabel(s.targetDeadline) || '未設定'}`,
      current, target, rate: achieved,
    },
    scope: { left: scopeLabel, right: '取消・重複を除く' },
    today: [
      { label: '本日の新規予約', value: delta.today.added, unit: '件' },
      { label: '本日のキャンセル', value: delta.today.cancelled, unit: '件' },
      {
        label: '本日の予約増減',
        value: (isNum(delta.today.added) && isNum(delta.today.cancelled))
          ? delta.today.added - delta.today.cancelled : null,
        unit: '件', signed: true,
      },
    ],
    // 🔴 前日の記録が無い日は「増減が出せない理由」を書く（0件と書かない）
    todayNote: delta.hasPrev ? '' : '前日の記録がないため、本日ぶんの増減はまだ出せません。',
    channels: {
      header: '媒体別の予約状況',
      note: fetchedAt != null ? `本日 00:00〜${jstHm(fetchedAt)}` : '本日',
      rows: delta.rows,
      total: { added: delta.today.added, cancelled: delta.today.cancelled, total: current },
    },
    spend: {
      header: '累計広告費・獲得単価',
      note: mr ? `${mr.from}〜${ymd}・税別` : '税別',
      items: spendItems, totalYen, cpa: unitCost,
    },
    footer: {
      source: `SalonOne・更新 ${ymdLabel(ymd)} ${fetchedAt != null ? jstHm(fetchedAt) : ''}`.trim(),
      schedule: `毎日${s.sendAt}配信`,
    },
  };

  // ── チャット用の文字（カードを出せない場所でも読める形）──────────────
  const lines = [];
  lines.push(`【オープン前 集客レポート】${shopName}`);
  lines.push(card.atLabel);
  lines.push('');
  lines.push(`プレオープン ${card.milestones[0].value}　／　本オープン ${card.milestones[1].value}`);
  lines.push('');
  lines.push(`■ ${card.goal.headline}`);
  lines.push(`　${card.goal.note}`);
  lines.push(`　累計の有効予約人数 ${people(current)} ／ 目標 ${target == null ? '未設定' : people(target)}　達成率 ${percent(achieved)}`);
  lines.push(`　（${scopeLabel}・取消・重複を除く）`);
  lines.push('');
  lines.push('■ 本日の動き');
  lines.push(`　新規予約 ${people(delta.today.added, '件')} ／ キャンセル ${people(delta.today.cancelled, '件')} ／ 増減 ${signed(isNum(delta.today.added) && isNum(delta.today.cancelled) ? delta.today.added - delta.today.cancelled : null)}`);
  if (card.todayNote) lines.push(`　※ ${card.todayNote}`);
  lines.push('');
  lines.push(`■ 媒体別の予約状況（${card.channels.note}）`);
  if (delta.rows.length) {
    for (const r of delta.rows.slice(0, 10)) {
      lines.push(`　${r.name}　新規 ${people(r.added, '件')} ／ 取消 ${people(r.cancelled, '件')} ／ 累計 ${people(r.total)}`);
    }
    lines.push(`　合計　新規 ${people(delta.today.added, '件')} ／ 取消 ${people(delta.today.cancelled, '件')} ／ 累計 ${people(current)}`);
  } else {
    lines.push(`　${NOT_FETCHED}`);
  }
  lines.push('');
  lines.push(`■ ${card.spend.header}（${card.spend.note}）`);
  if (spendItems) {
    for (const it of spendItems) lines.push(`　${it.name}　${yen(it.yen)}`);
    lines.push(`　合計広告費 ${yen(totalYen)}　／　CPA（有効予約ベース） ${unitCost == null ? NOT_FETCHED : `${yen(unitCost)} / 名`}`);
  } else {
    lines.push(`　${NOT_FETCHED}（広告費が入力されていません）`);
  }
  lines.push('');
  lines.push(...footer({
    sources: ['marketing/by-channel'],
    period: mr ? `${mr.from}〜${mr.to}（${mr.label}来店予定ぶんの累計）` : ymd,
    fetchedAt,
    note: '予約時点の数字です。来店・入会の結果はオープン後の日報で出します。',
  }));

  return {
    kind: PREP, shopId: str(i.shopId || s.shopId), shopName, ymd,
    text: lines.join('\n'), lines, card, missing,
    snapshot: curSnap,
    facts: { current, target, remain, achieved, totalYen, cpa: unitCost,
             addedToday: delta.today.added, cancelledToday: delta.today.cancelled },
  };
}

// ── ② プレオープン日報（preopen）────────────────────────────────────────
// 見本（03 / 比較テーブル型）どおり、**セラピスト別・店舗合計の横並び**が主役。
// きっかけは「集計実行」の完了後（オープン後の日報と同じ）。オープン前だけが時刻配信。
//
// input: setting, shopName, ymd, fetchedAt, summary(全体), staff(normalizeStaff済み)
export function buildPreOpenReport(input) {
  const i = input && typeof input === 'object' ? input : {};
  const s = normalizeShopSetting(i.setting || {});
  const shopName = str(i.shopName || s.shopName) || '(店舗名未取得)';
  const ymd = str(i.ymd);
  const fetchedAt = isNum(i.fetchedAt) ? i.fetchedAt : null;
  const staff = Array.isArray(i.staff) ? i.staff : null;
  const sum = (i.summary && typeof i.summary === 'object') ? i.summary : null;
  const missing = [];
  if (staff == null) missing.push('セラピスト別の実績');

  const table = buildStaffTable(staff || []);
  const rowOf = (label) => table.rows.find(r => r.label === label) || { total: null };
  // 売上は店舗全体の値を優先し、取れなければセラピスト別の合計で補う。
  const salesTotal = pick(sum, 'grossSales') != null ? pick(sum, 'grossSales') : rowOf('本日売上（税抜）').total;
  const visitTotal = rowOf('新規来店数').total;
  const joinTotal = rowOf('入会人数').total;
  const repeatTotal = rowOf('リピート数（次回予約）').total;
  if (salesTotal == null) missing.push('売上');
  if (repeatTotal == null) missing.push('次回予約数（取得元が未確認）');
  if (rowOf('前金あり').total == null) missing.push('前金あり（取得元が未確認）');

  const card = {
    kind: PREOPEN,
    brand: 'NAORU × SalonOne',
    title: 'プレオープン日報',
    badge: preOpenDayLabel(s.preOpenDate, ymd),
    atLabel: `対象日：${ymdLabelFull(ymd) || ymd}`,
    atRight: fetchedAt != null ? `集計実行 ${jstHm(fetchedAt)}・当日時点` : '当日時点',
    milestones: [
      { label: 'プレオープン', value: ymdLabel(s.preOpenDate) || '未設定' },
      { label: '本オープン', value: ymdLabel(s.openDate) || '未設定' },
    ],
    highlight: {
      label: '本日売上', value: salesTotal, money: true,
      note: `新規来店${people(visitTotal)}・入会${people(joinTotal)}・次回予約${people(repeatTotal)}`,
    },
    table: { header: 'セラピスト別・店舗合計', note: '同じ指標を横並びで確認', ...table },
    // 見本の脚注。どう数えた値かを必ず添える。
    notes: [
      '入会率＝入会人数 ÷ 新規来店数',
      'リピート率＝次回予約獲得人数 ÷ 新規来店数（再来店数とは別）',
      '売上：SalonOneの当日計上額・税抜　／　前金あり・口コミは当日獲得人数',
    ],
    footer: { source: `SalonOne・更新 ${fetchedAt != null ? jstHm(fetchedAt) : NOT_FETCHED}`,
              schedule: '「集計実行」の完了後に、店舗グループへ自動投稿' },
  };

  // ── チャット用の文字（カードを出せない場所でも読める形）──────────────
  const lines = [];
  lines.push(`【プレオープン日報】${shopName}　${card.badge}`);
  lines.push(`${card.atLabel}　${card.atRight}`);
  lines.push(`プレオープン ${card.milestones[0].value}　／　本オープン ${card.milestones[1].value}`);
  lines.push('');
  lines.push(`■ 本日売上 ${yen(salesTotal)}`);
  lines.push(`　${card.highlight.note}`);
  lines.push('');
  lines.push(`■ ${card.table.header}`);
  if (table.staff.length) {
    lines.push(`　　　　${table.staff.map(x => x.name).join(' ／ ')}　＝ 店舗合計`);
    for (const r of table.rows) {
      const fmt = (v) => r.money ? yen(v) : r.percent ? percent(v) : people(v, r.unit || '名');
      lines.push(`　${r.label}　${r.values.map(fmt).join(' ／ ')}　＝ ${fmt(r.total)}`);
    }
  } else {
    lines.push(`　${NOT_FETCHED}`);
  }
  lines.push('');
  for (const n of card.notes) lines.push(`※ ${n}`);
  lines.push('');
  lines.push(...footer({
    sources: ['sales/summary', 'marketing/by-staff'],
    period: `${ymd}（1日・当日時点）`,
    fetchedAt,
    note: '「集計実行」の完了後に出しています。その後に会計が動くと数字が変わることがあります。',
  }));

  return {
    kind: PREOPEN, shopId: str(i.shopId || s.shopId), shopName, ymd,
    text: lines.join('\n'), lines, card, missing,
    facts: { salesTotal, visitTotal, joinTotal, repeatTotal,
             bookingTotal: rowOf('当日予約数（取消を含む）').total,
             cancelTotal: rowOf('キャンセル数').total,
             prepaidTotal: rowOf('前金あり').total, reviewTotal: rowOf('Google口コミ').total },
  };
}

// ── ③ オープン後の日報（open）────────────────────────────────────────────
export function buildOpenReport(input) {
  const i = input && typeof input === 'object' ? input : {};
  const s = normalizeShopSetting(i.setting || {});
  const shopName = str(i.shopName || s.shopName) || '(店舗名未取得)';
  const ymd = str(i.ymd);
  const fetchedAt = isNum(i.fetchedAt) ? i.fetchedAt : null;
  const sum = (i.summary && typeof i.summary === 'object') ? i.summary : null;
  const chs = Array.isArray(i.channels) ? i.channels : null;
  const target = s.targetNew;
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

  const visits = sumStrict([newVisit, repeatVisit]);
  const joins = chs ? sumStrict(chs.map(c => pick(c, 'join'))) : null;
  const joinRate = rate(joins, newVisit);

  const card = {
    kind: OPEN,
    brand: 'NAORU × SalonOne',
    title: PHASE_LABEL.open,
    badge: '日報',
    atLabel: `${ymdLabelFull(ymd) || ymd}・日本時間`,
    today: [
      { label: '売上合計', value: gross, unit: '円', money: true },
      { label: '来店', value: visits, unit: '名' },
      { label: '入会', value: joins, unit: '名' },
    ],
    channels: {
      header: '媒体別（新規予約）', note: ymd,
      rows: arr(chs).map(c => ({ name: str(c && c.name) || '未設定',
        booking: pick(c, 'booking'), visit: pick(c, 'visit'), join: pick(c, 'join') })),
    },
    footer: { source: `SalonOne・更新 ${ymdLabel(ymd)} ${fetchedAt != null ? jstHm(fetchedAt) : ''}`.trim(),
              schedule: `毎日${s.closingAt}配信` },
  };

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
  lines.push(`　入会 ${people(joins)}${joinRate == null ? '' : `（入会率 ${percent(joinRate)}）`}`);
  if (target != null) {
    const diff = isNum(newVisit) ? target - newVisit : null;
    lines.push(`　目標 ${people(target)}${diff == null ? `　達成状況 ${NOT_FETCHED}` : (diff > 0 ? `　あと ${people(diff)}` : '　達成')}`);
  }
  if (chs && chs.length) {
    lines.push('');
    lines.push('■ 媒体別（新規予約）');
    for (const c of chs.slice(0, 10)) {
      lines.push(`　${str(c && c.name) || '未設定'}　予約 ${people(pick(c, 'booking'), '件')} ／ 来店 ${people(pick(c, 'visit'))} ／ 入会 ${people(pick(c, 'join'))}`);
    }
  } else if (chs == null) {
    lines.push('');
    lines.push(`■ 媒体別（新規予約）　${NOT_FETCHED}`);
  }
  lines.push('');
  lines.push(...footer({
    sources: ['sales/summary', 'marketing/by-channel'],
    period: `${ymd}（1日）`,
    fetchedAt,
    note: '「集計実行」の前に取得した場合は確定前の値になることがあります。',
  }));

  return {
    kind: OPEN, shopId: str(i.shopId || s.shopId), shopName, ymd,
    text: lines.join('\n'), lines, card, missing,
    facts: { gross, newSales, repeatSales, newVisit, repeatVisit, cancel, noShow, joins, joinRate, target },
  };
}

// 期間で振り分ける。未知の期間は日報（いちばん当たり障りのない形）へ。
export function buildReport(phase, input) {
  if (phase === PREP) return buildPrepReport(input);
  if (phase === PREOPEN) return buildPreOpenReport(input);
  return buildOpenReport(input);
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
export function sendKey(shopId, ymd, phase) {
  return `${str(shopId)}|${str(ymd)}|${str(phase)}`;
}

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

export function alreadySent(log, key) {
  const l = (log && typeof log === 'object' && !Array.isArray(log)) ? log : {};
  const e = l[str(key)];
  return (e && typeof e === 'object') ? e : null;
}

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
  const keys = Object.keys(l);
  if (keys.length > LOG_CAP) {
    keys.sort((a, b) => (l[a].at || 0) - (l[b].at || 0));
    for (const k of keys.slice(0, keys.length - LOG_CAP)) delete l[k];
  }
  return l;
}

// ── open のきっかけ（仮案）───────────────────────────────────────────────
// 🔴 「集計実行」が押されたことは API から直接わからない（Webhook 未確認）。
export const DEFAULT_STABLE_MINUTES = 30;

export function detectAggregationRun(prev, cur, stableMinutes = DEFAULT_STABLE_MINUTES) {
  const p = (prev && typeof prev === 'object') ? prev : null;
  const c = (cur && typeof cur === 'object') ? cur : null;
  const cd = pick(c, 'digest');
  if (cd == null) return { changed: false, settled: false, reason: 'no_data' };
  if (!p) return { changed: false, settled: false, reason: 'first_observation' };
  const pd = pick(p, 'digest');
  if (pd == null) return { changed: false, settled: false, reason: 'first_observation' };
  if (cd !== pd) return { changed: true, settled: false, reason: 'moved' };
  const lastMoved = isNum(p.lastMovedAt) ? p.lastMovedAt : null;
  if (lastMoved == null) return { changed: false, settled: false, reason: 'never_moved' };
  const now = isNum(c.at) ? c.at : Date.now();
  if ((now - lastMoved) / 60000 >= stableMinutes) return { changed: false, settled: true, reason: 'settled' };
  return { changed: false, settled: false, reason: 'waiting' };
}

export function advanceObservation(prev, cur) {
  const c = (cur && typeof cur === 'object') ? cur : {};
  const cd = pick(c, 'digest');
  const at = isNum(c.at) ? c.at : Date.now();
  const p = (prev && typeof prev === 'object') ? prev : {};
  const pd = pick(p, 'digest');
  const moved = cd != null && pd != null && cd !== pd;
  return {
    digest: cd, at,
    lastMovedAt: moved ? at : (isNum(p.lastMovedAt) ? p.lastMovedAt : (pd == null && cd != null ? at : null)),
  };
}

// ── 実行計画（何を送る予定か）────────────────────────────────────────────
// 送信そのものはしない。「この時点で送る対象はどれか」を期間つきで列挙する。
export function planRun({ settings, log, nowMs }) {
  const now = isNum(nowMs) ? nowMs : Date.now();
  const ymd = jstYmd(now);
  const out = [];
  for (const s of targetsFor(settings)) {
    const phase = phaseOf(s, now);
    const key = sendKey(s.shopId, ymd, phase);
    if (alreadySent(log, key)) { out.push({ setting: s, phase, key, ymd, due: false, reason: 'already' }); continue; }
    // 🔴 プレオープンとオープン後は **「集計実行」の完了後**に出す（見本の指定）。
    //    オープン前だけは「集計実行」が無いので指定時刻に出す。
    if (phase === OPEN || phase === PREOPEN) {
      if (s.trigger === 'manual') { out.push({ setting: s, phase, key, ymd, due: false, reason: 'manual_only' }); continue; }
      if (s.trigger === 'time') {
        const due = timeReached(s.closingAt, now);
        out.push({ setting: s, phase, key, ymd, due, reason: due ? 'ok' : 'waiting' });
        continue;
      }
      out.push({ setting: s, phase, key, ymd, due: false, reason: 'needs_aggregate_check' });
      continue;
    }
    const due = timeReached(s.sendAt, now);
    out.push({ setting: s, phase, key, ymd, due, reason: due ? 'ok' : 'waiting' });
  }
  return out;
}

// ── SalonOne の応答を、この文面が使う形へ ─────────────────────────────────
// ── セラピスト別の指標 ────────────────────────────────────────────────────
// プレオープン日報は「セラピスト別・店舗合計」の横並びが主役。2つの応答を staff_id で突き合わせる。
//   sales/summary の by_staff   … 売上(digest_sales)・Google口コミ(google_review_count)
//   marketing/by-staff          … 新規予約・新規来店・キャンセル・入会(purchase_count)
//
// 🔴 未確認（AGENTS.md §2・既存事実として扱わない）:
//   「次回予約数（リピート数）」と「前金あり」に対応する項目は、いまの SalonOne の応答から
//   確認できていない。下の候補キーはいずれも**推測**で、当たらなければ「未取得」のままにする。
//   実際の項目名が分かったら、この配列に足すだけでよい。
const NEXT_BOOKING_KEYS = ['next_booking_count', 'rebooking_count', 'repeat_booking_count', 'next_reservation_count'];
const PREPAID_KEYS = ['prepaid_count', 'advance_payment_count', 'deposit_count'];

export function normalizeStaff(summaryByStaff, mkByStaff) {
  const byId = new Map();
  const put = (id, name, patch) => {
    const key = str(id);
    if (!key) return;
    const cur = byId.get(key) || { id: key, name: str(name) || '(不明)',
      sales: null, booking: null, visit: null, cancel: null, join: null,
      repeat: null, prepaid: null, review: null };
    if (name && cur.name === '(不明)') cur.name = str(name);
    byId.set(key, { ...cur, ...patch });
  };
  for (const r of arr(summaryByStaff)) {
    if (!r || typeof r !== 'object') continue;
    put(r.staff_id ?? r.id, r.staff_name || r.name, {
      sales: numOrNull(r, 'digest_sales', 'gross_sales'),
      review: numOrNull(r, 'google_review_count'),
      prepaid: numOrNull(r, ...PREPAID_KEYS),
    });
  }
  for (const r of arr(mkByStaff)) {
    if (!r || typeof r !== 'object') continue;
    if (r.is_total === true) continue;                 // 合計行は列にしない（合計は足して出す）
    const patch = {
      booking: numOrNull(r, 'new_booking_count'),
      visit: numOrNull(r, 'new_visit_count'),
      cancel: numOrNull(r, 'cancel_count'),
      join: numOrNull(r, 'purchase_count'),            // 入会＝購入（画面の「購入数」と同じ定義）
      repeat: numOrNull(r, ...NEXT_BOOKING_KEYS),
    };
    const pre = numOrNull(r, ...PREPAID_KEYS);
    if (pre != null) patch.prepaid = pre;
    put(r.staff_id ?? r.id, r.staff_name || r.name, patch);
  }
  const rows = [...byId.values()];
  if (!rows.length) return null;
  // 売上の多い順。取れていない人は後ろへ。
  rows.sort((a, b) => (isNum(b.sales) ? b.sales : -1) - (isNum(a.sales) ? a.sales : -1));
  return rows;
}

// 見本の10行をそのまま作る。値が無い列は 0 にせず null のままにする。
export function buildStaffTable(staff) {
  const list = arr(staff);
  const col = (k) => list.map(x => (x && isNum(x[k]) ? x[k] : null));
  const tot = (k) => sumStrict(col(k));
  const visitTotal = tot('visit');
  const row = (label, key, o = {}) => ({ label, values: col(key), total: tot(key), ...o });
  return {
    staff: list.map(x => ({ id: x.id, name: x.name })),
    rows: [
      row('本日売上（税抜）', 'sales', { money: true }),
      row('当日予約数（取消を含む）', 'booking', { unit: '件' }),
      row('新規来店数', 'visit', { unit: '名' }),
      row('キャンセル数', 'cancel', { unit: '件' }),
      row('入会人数', 'join', { unit: '名' }),
      { label: '入会率', percent: true,
        values: list.map(x => rate(x && x.join, x && x.visit)), total: rate(tot('join'), visitTotal) },
      row('リピート数（次回予約）', 'repeat', { unit: '名' }),
      { label: 'リピート率', percent: true,
        values: list.map(x => rate(x && x.repeat, x && x.visit)), total: rate(tot('repeat'), visitTotal) },
      row('前金あり', 'prepaid', { unit: '名' }),
      row('Google口コミ', 'review', { unit: '名' }),
    ],
  };
}

// 「プレオープン初日」「プレオープン2日目」。日付が読めなければ期間名だけ。
export function preOpenDayLabel(preOpenDate, ymd) {
  const a = ymdParts(preOpenDate), b = ymdParts(ymd);
  if (!a || !b) return 'プレオープン';
  const n = Math.round((b.t - a.t) / 86400000) + 1;
  if (n < 1) return 'プレオープン';
  return n === 1 ? 'プレオープン初日' : `プレオープン${n}日目`;
}

export function normalizeSummary(data) {
  const s = (data && typeof data === 'object' && !Array.isArray(data)) ? data
          : (Array.isArray(data) && data[0] && typeof data[0] === 'object') ? data[0]
          : null;
  if (!s) return null;
  return {
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

// marketing/by-channel。
// remaining_count = 予約 − 来店 − キャンセル ＝ **まだ来ていない有効な新規予約**
// （index.html の soLoadFutureNew と同じ定義。SalonOne の「残新規」と一致する）
export function normalizeChannels(data) {
  if (!Array.isArray(data)) return null;
  return data.map((c) => ({
    name: str(c && c.name) || '未設定',
    booking: numOrNull(c, 'booking_count'),
    visit: numOrNull(c, 'visit_count'),
    cancel: numOrNull(c, 'cancel_count'),
    join: numOrNull(c, 'join_count'),
    remaining: numOrNull(c, 'remaining_count'),
  })).filter((c) => [c.booking, c.visit, c.remaining].some(v => isNum(v) && v > 0))
    .sort((a, b) => (b.booking || 0) - (a.booking || 0));
}
