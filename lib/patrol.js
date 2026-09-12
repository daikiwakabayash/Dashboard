/**
 * lib/patrol.js — AIパトロール（自発チェック）ロジック（純粋関数・テスト対象）
 *
 * 役割: 各店舗の SalonOne 実績（当月/先月）＋ Googleマップ情報（口コミ・住所）から、
 *       「プロのマーケティング担当の視点」で注意喚起・アドバイスの項目を組み立て、
 *       各店舗のグループチャットに投稿する文面を生成する。
 *
 * 設計方針:
 *  - 判定はすべてこの純粋関数群に集約（サーバー api/plan-store.js ?type=patrol から利用）。数字は捏造しない。
 *  - しきい値は PATROL_THRESHOLDS に集約（業界ベンチマークに準拠）。
 *  - Googleマップ（口コミ/住所）は GOOGLE_PLACES_API_KEY 未設定なら SalonOne のみで動作（graceful degrade）。
 *
 * level: 'warn'（⚠️要対応） / 'info'（💡改善余地） / 'good'（✅好調）
 */

import { addressMatch } from './places.js';

export const PATROL_THRESHOLDS = {
  newDropPct: 20,      // 新規来店 前月比 これ以上の減少で警告
  newGrowPct: 20,      // 新規来店 前月比 これ以上の増加で好調
  salesDropPct: 15,    // 総売上 前月比 これ以上の減少で警告
  joinRateWarn: 30,    // 入会率 これ未満で警告（業界: 要改善水域）
  joinRateGood: 55,    // 入会率 これ以上で好調（業界: 優秀水域）
  newCountLow: 10,     // 月間新規来店 これ未満で集客強化を促す
  reviewCountLow: 20,  // Google クチコミ これ未満で獲得強化を促す
  ratingWarn: 4.0,     // Google 評価 これ未満で警告
  reviewCaptureMinNew: 5,   // この新規来店数以上のとき「口コミ獲得率」を評価
  reviewCaptureWarn: 15,    // 新規に対する今月の口コミ獲得率(%) これ未満で警告
  reviewCaptureGood: 30,    // 口コミ獲得率(%) これ以上で好調（目標値）
};

const EMOJI = { warn: '⚠️', info: '💡', good: '✅' };

// 前月比（%）。prev<=0 なら null（比較不能）。四捨五入して整数。
export function pctChange(cur, prev) {
  const c = Number(cur) || 0, p = Number(prev) || 0;
  if (p <= 0) return null;
  return Math.round(((c - p) / p) * 100);
}

const yen = (n) => '¥' + Math.round(Number(n) || 0).toLocaleString('en-US');

/**
 * 1店舗を分析して注意喚起・アドバイス項目の配列を返す。
 * @param {object} store { name, cur, prev, places, addresses }
 *   - cur/prev: { gross, newCount, joinCount, joinRate, bookingCount, hasData }
 *   - places:   { rating, userRatingCount, address } | null（Googleマップ・任意）
 *   - addresses:{ hp, hotpepper } 登録住所（住所一致チェック用・任意）
 * @param {object} [th] しきい値（省略時 PATROL_THRESHOLDS）
 * @returns {{shop, items, hasData}}
 */
export function analyzeStore(store, th = PATROL_THRESHOLDS, opts = {}) {
  const name = (store && store.name) || '';
  const cur = (store && store.cur) || {};
  const prev = (store && store.prev) || {};
  const places = (store && store.places) || null;
  const addresses = (store && store.addresses) || {};
  const meo = (store && store.meo) || null; // { newReviewsThisMonth, totalReviews } MEOスナップショット由来（任意）
  const items = [];
  const push = (level, code, title, detail) => items.push({ level, code, title, detail: detail || '' });
  const hasData = !!cur.hasData;

  // ── 月の進捗を考慮（当月は途中経過なので、フロー指標＝新規/売上は「前月の同日時点ペース」と比較し着地見込みも示す）──
  //   progress = 経過日数 / その月の日数（0<prog<1 なら当月途中、1以上＝確定月）。入会率などの比率指標は日付でブレないので按分しない。
  const rawProg = Number(opts.progress);
  const prog = (rawProg > 0 && rawProg < 1) ? rawProg : 1;
  const partial = prog < 1;
  const dayTag = (opts.elapsedDays && opts.totalDays) ? `${opts.elapsedDays}/${opts.totalDays}日時点` : '進行中';
  const project = (v) => Math.round((Number(v) || 0) / prog);   // 着地見込み（今のペースを月末まで延長）

  // ── 新規来店（新患）トレンド：当月は「前月同ペース」と比較（早い時期に誤って減少判定しない）──
  if ((prev.newCount || 0) > 0 && cur.newCount != null) {
    if (partial) {
      const expected = prev.newCount * prog;                    // 前月を同じ進捗まで按分した基準
      const pace = pctChange(cur.newCount, expected);
      const proj = project(cur.newCount);
      if (pace != null && pace <= -th.newDropPct) push('warn', 'new_drop', `新規来店が前月ペース比 ${pace}%（${dayTag}: ${cur.newCount}名／着地見込 ${proj}名 vs 前月 ${prev.newCount}名）`,
        'クーポンの見直し・予約枠の空き確認・サムネ画像の刷新を。ホットペッパー/Googleの初回オファーが競合に負けていないか点検を。');
      else if (pace != null && pace >= th.newGrowPct) push('good', 'new_grow', `新規来店が前月ペース比 +${pace}%（着地見込 ${proj}名 vs 前月 ${prev.newCount}名）好調`,
        '好調要因（媒体・クーポン・スタッフ）を言語化し、他店へ横展開を。');
    } else {
      const newPct = pctChange(cur.newCount, prev.newCount);
      if (newPct != null && newPct <= -th.newDropPct) push('warn', 'new_drop', `新規来店が前月比 ${newPct}%（${prev.newCount}→${cur.newCount}名）`,
        'クーポンの見直し・予約枠の空き確認・サムネ画像の刷新を。ホットペッパー/Googleの初回オファーが競合に負けていないか点検を。');
      else if (newPct != null && newPct >= th.newGrowPct) push('good', 'new_grow', `新規来店が前月比 +${newPct}%（${prev.newCount}→${cur.newCount}名）好調`,
        '好調要因（媒体・クーポン・スタッフ）を言語化し、他店へ横展開を。');
    }
  }

  // ── 総売上トレンド：当月は前月同ペースと比較＋着地見込み（12日で先月の1/3、は減少ではない）──
  if ((prev.gross || 0) > 0 && cur.gross != null) {
    if (partial) {
      const expected = prev.gross * prog;
      const pace = pctChange(cur.gross, expected);
      const proj = project(cur.gross);
      if (pace != null && pace <= -th.salesDropPct) push('warn', 'sales_drop', `総売上が前月ペース比 ${pace}%（${dayTag}: ${yen(cur.gross)}／着地見込 ${yen(proj)} vs 前月 ${yen(prev.gross)}）`,
        '新規・入会率・客単価・継続のどれが落ちたかを分解し、最も効くレバーから改善を。');
    } else {
      const salesPct = pctChange(cur.gross, prev.gross);
      if (salesPct != null && salesPct <= -th.salesDropPct) push('warn', 'sales_drop', `総売上が前月比 ${salesPct}%（${yen(prev.gross)}→${yen(cur.gross)}）`,
        '新規・入会率・客単価・継続のどれが落ちたかを分解し、最も効くレバーから改善を。');
    }
  }

  // ── 入会率（比率指標＝日付でブレないので按分しない）──
  if (hasData && (cur.newCount || 0) >= 5) {
    if ((cur.joinRate || 0) < th.joinRateWarn) push('warn', 'join_low', `入会率 ${cur.joinRate}%（${th.joinRateWarn}%割れ）`,
      'カウンセリングのトークスクリプト見直し・ロープレを。初回体験の設計と価格提示を点検。');
    else if ((cur.joinRate || 0) >= th.joinRateGood) push('good', 'join_high', `入会率 ${cur.joinRate}% 優秀`,
      'カウンセリング手法を録画・言語化し、全店に共有を。');
  }

  // ── 新規来店の絶対数（当月は着地見込みで判定＝月初に誤って「少ない」と出さない）──
  const projNew = partial ? project(cur.newCount) : (cur.newCount || 0);
  if (hasData && (cur.newCount || 0) > 0 && projNew < th.newCountLow) push('info', 'new_few',
    `新規来店 ${partial ? `着地見込 ${projNew}名` : `${cur.newCount}名`}/月（${th.newCountLow}名未満）`,
    'HPB枠の追加・MEO強化・クーポン改善で新規の入口を広げましょう。');

  // ── ★MEO最重要: 新規来店に対する「Google口コミの獲得率」（新規は来ているのに口コミが取れていないを検知）──
  if (meo && meo.newReviewsThisMonth != null && (cur.newCount || 0) >= th.reviewCaptureMinNew) {
    const nv = cur.newCount || 0;
    const rr = nv > 0 ? Math.round((meo.newReviewsThisMonth / nv) * 100) : 0;
    if (rr < th.reviewCaptureWarn) push('warn', 'meo_capture_low',
      `MEO要強化: 今月 新規${nv}名に対しGoogle口コミ +${meo.newReviewsThisMonth}件（獲得率 ${rr}%）`,
      `新規は来ているのに口コミが取れていません。施術後の口コミ依頼を仕組み化（QRカード/LINE/会計時の声かけ台本）。目標は新規の${th.reviewCaptureGood}%以上。`);
    else if (rr >= th.reviewCaptureGood) push('good', 'meo_capture_ok',
      `MEO好調: 新規${nv}名→今月Google口コミ +${meo.newReviewsThisMonth}件（獲得率 ${rr}%）`,
      'この口コミ依頼フローを他店へ横展開しましょう。');
  }

  // ── Googleマップ 口コミ・評価（MEOの土台）──
  if (places) {
    const cnt = Number(places.userRatingCount) || 0;
    if (cnt === 0) push('warn', 'gmb_no_review', 'Googleクチコミが 0件',
      '施術後の声かけを仕組み化し、Googleクチコミの依頼を徹底しましょう（新規の30%を目標）。');
    else if (cnt < th.reviewCountLow) push('info', 'gmb_few_review', `Googleクチコミ ${cnt}件（${th.reviewCountLow}件未満）`,
      'クチコミ依頼の声かけ・QRカード設置で件数を増やしましょう。');
    if (places.rating != null && places.rating < th.ratingWarn) push('warn', 'gmb_low_rating',
      `Google評価 ★${places.rating}（${th.ratingWarn}未満）`,
      '低評価の内容を確認し、接客・待ち時間・施術説明の改善と、丁寧な返信対応を。');
  }

  // ── 住所の一致チェック（Googleマップ vs 登録住所） ──
  if (places && places.address) {
    for (const [label, key] of [['HP', 'hp'], ['ホットペッパー', 'hotpepper']]) {
      const other = addresses[key];
      if (other && String(other).trim()) {
        const m = addressMatch(places.address, other);
        if (!m.match) push('warn', 'addr_mismatch_' + key, `住所不一致（Googleマップ vs ${label}）`,
          `Googleマップ「${places.address}」 / ${label}「${other}」。NAP（名称・住所・電話）の不一致はMEO評価を下げます。表記を統一してください。`);
      }
    }
  }

  if (hasData && !items.length) push('good', 'ok', '大きな問題は検知されませんでした', 'この調子で新規獲得と口コミ獲得を継続しましょう。');

  return { shop: name, items, hasData };
}

/**
 * 月初のクーポン更新リマインド項目（当月1〜graceDays日のみ返す）。
 * 8月のクーポンが9月に残っている、といった「先月クーポンの残置」を防ぐ。
 */
export function couponReminderItems(now = new Date(), graceDays = 7) {
  const d = now.getDate();
  const month = now.getMonth() + 1;
  if (d > graceDays) return [];
  return [{
    level: 'warn', code: 'coupon_refresh',
    title: `${month}月のクーポン・サムネは更新しましたか？`,
    detail: `先月のクーポン（${month === 1 ? 12 : month - 1}月分）が残っていないか、ホットペッパー/Google/HPを確認してください。初回オファー価格・掲載画像（サムネ）・予約枠の空きも合わせて点検を。`,
  }];
}

/** 手動送信用: 月に関わらずクーポン点検の文面を返す（UIの「クーポン更新リマインド」ボタン用）。 */
export function buildCouponMessage(now = new Date()) {
  const month = now.getMonth() + 1;
  const prev = month === 1 ? 12 : month - 1;
  return [
    `📣 【${month}月 クーポン点検のお願い】`,
    '',
    `${prev}月のクーポンが残っていないか、下記を今日中に確認してください。`,
    `1. ホットペッパー：${month}月のクーポン・サムネ画像は最新ですか？（${prev}月分の掲載残りに注意）`,
    '2. Googleマップ：投稿・クーポン・写真は最新ですか？',
    '3. 自社HP：キャンペーン表記は当月のものですか？',
    '4. 初回オファー価格・予約枠の空き状況も合わせて点検を。',
    '',
    '― AIパトロール（NAORU本部）',
  ].join('\n');
}

/**
 * analyzeStore の結果から、店舗チャットへ投稿する文面を組み立てる。
 * items が空（＝好調のみ/データ無し）なら空文字を返す場合もある（opts.postGood=false）。
 * @param {string} shopName
 * @param {Array} items analyzeStore().items
 * @param {object} [opts] { date=new Date(), postGood=true }
 * @returns {string}
 */
export function buildStoreMessage(shopName, items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const postGood = opts.postGood !== false;
  const warns = list.filter(i => i.level === 'warn');
  const infos = list.filter(i => i.level === 'info');
  const goods = list.filter(i => i.level === 'good');
  if (!warns.length && !infos.length && !postGood) return '';
  const d = opts.date instanceof Date ? opts.date : new Date();
  const ymd = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  const lines = [`🔎 AIパトロール｜${shopName}（${ymd}）`, ''];
  const section = (arr) => arr.forEach(it => {
    lines.push(`${EMOJI[it.level] || '・'} ${it.title}`);
    if (it.detail) lines.push(`　${it.detail}`);
  });
  if (warns.length) section(warns);
  if (infos.length) section(infos);
  if (goods.length && (postGood || !warns.length)) section(goods);
  lines.push('');
  lines.push('※ SalonOne実績とGoogleマップ情報をもとにAIが自動作成。詳しい打ち手はチャットで「@AI」に質問できます。');
  return lines.join('\n');
}

/** レポート群の集計（UIのサマリー表示用）。 */
export function summarizeReports(reports) {
  const r = Array.isArray(reports) ? reports : [];
  let warn = 0, info = 0, good = 0;
  for (const rep of r) for (const it of (rep.items || [])) {
    if (it.level === 'warn') warn++; else if (it.level === 'info') info++; else if (it.level === 'good') good++;
  }
  return { stores: r.length, warn, info, good };
}
