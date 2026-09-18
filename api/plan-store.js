// ── 事業計画(SalonOne計画)の目標・アクション 共有ストアAPI ───────────────
// 計画タブで入力した「目標」と「アクション(施策)」をサーバーに保存し、
// 全デバイス・全スタッフ間で同期する（従来はブラウザのlocalStorageのみで端末ローカルだった）。
//
// 保存先の優先順位:
//   1) Vercel KV / Upstash Redis  … 環境変数 KV_REST_API_URL / KV_REST_API_TOKEN
//      （VercelのStorageでKVを作成すると自動で入る。GAS不要・推奨）
//   2) Supabase                    … 環境変数 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
//      事前にテーブル作成: create table plan_store (key text primary key, value jsonb, updated_at timestamptz default now());
//   3) GAS スプレッドシート        … 環境変数 PLAN_GAS_URL または SETTLEMENT_GAS_URL
//   いずれも未設定なら configured:false を返し、フロントは localStorage で継続。
//
// GET  /api/plan-store            → { goals:{...}, actions:[...], configured:boolean }
// POST /api/plan-store {goals,actions} → { ok:true }

import { getVotingState, validateVote, upsertVote, removeVote, isPeriodPublished, autoPublishLabel, listPeriods } from '../lib/thanksgift.js';
import { ensureBaseRooms, extractLinks, toggleReaction, genId } from '../lib/chat.js';
import { carryManaged, stripManaged, applyMemberChange } from '../lib/chat-room-fields.js';
import {
  CHATAI_STORE_KEY, CHATAI_CFG_KEY, AI_STAFF_ID, AI_NAME,
  errorOf as aiError, normalizeAskInput, requestKey as aiRequestKey, classifyRequest, isStalePending,
  makeRequestRecord, buildSources, needsHqReview, wrapDocsAsData, upsertReview, appendCorrection,
  isTrialRoom, normalizeConfig as normalizeAiCfg, pickAllowedDocs,
} from '../lib/chatai.js';
import { videoEmbed } from '../lib/board.js';
import { analyzeStore, couponReminderItems, buildStoreMessage } from '../lib/patrol.js';
import { buildSearchRequest, parsePlacesResponse, reviewRequestUrl, buildLegacyReviewsRequest, parseLegacyReviews } from '../lib/places.js';
import { recordSnapshot, computeDeltas, meoFlags, meoScore, alertWeight, jstYmd, reviewsInMonth } from '../lib/meo.js';
import { mergeAppointments, mergeDismissed, flatten as soflFlatten } from '../lib/soflmap.js';
import { ALLOWANCE_LOG_KEY, ALLOWANCE_PROD_KEY, ALLOWANCE_LOG_CAP, makeEntry as makeAllowanceEntry, mergeSubmissions, isDuplicateSubmit, mergeProductivity, bumpProductivity } from '../lib/allowance-store.js';
import { BOARD_READS_KEY, normalizeReads, mergeReads, bumpRead, versionOf, isStale, upsertPost, upsertComment } from '../lib/board-store.js';
// ── Command Center（Phase 0〜2）。既存の type= には一切触れない追加のみ ──
import { FLAGS_KEY, DEFAULT_FLAGS, normalizeFlags, applyFlagChange, killAll } from '../lib/ccflags.js';
import { AUDIT_KEY, AUDIT_CAP, buildEntry as buildAuditEntry, listEntries as listAuditEntries } from '../lib/audit.js';
import { APPROVAL_KEY, APPROVAL_CAP, buildApproval, decide as decideApproval, repropose as reproposeApproval, recordExecution, listApprovals, pendingCount } from '../lib/approvals.js';
import { AGENTLOG_KEY, AGENTLOG_CAP, startRun, finishRun, listRuns, summarize as summarizeRuns, anomalies as runAnomalies } from '../lib/agentlog.js';
import { check as authzCheck, can as authzCan, enforce as authzEnforce, decisionRecord, needsReverify, DEFAULT_TENANT, canViewRoom } from '../lib/authz.js';
import { resolveActor } from '../lib/actor.js';
import { normalizeOverview as normalizeMetaOverview, connectionState as metaConnectionState, lastCompleteDays, looksLikeSample as metaLooksLikeSample, META_API_VERSION } from '../lib/meta-read.js';
import META_FIXTURE from '../fixtures/meta-overview-sample.json' with { type: 'json' };
import { verifySalonOneBearer } from '../lib/salonone-auth.js';
import { hashOwnerToken, verifyOwnerToken, parseOwnerPasswords, parseOwnerShops } from '../lib/settlement.js';
import { kvConfigured, kvBlobGet, ACCT_PASS_KEY } from '../lib/kvblob.js';

// Vercel KV / Upstash Redis / Vercel Redis いずれの環境変数名でも動くよう両対応（REST APIは共通）
const KV_URL = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_REST_API_URL || '';
const KV_TOKEN = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_API_TOKEN || '';
const SB_URL = () => process.env.SUPABASE_URL || '';
const SB_KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
const GAS_URL = () => process.env.PLAN_GAS_URL || process.env.SETTLEMENT_GAS_URL || '';
const GOALS_KEY = 'naoru:plan:goals';
const ACTIONS_KEY = 'naoru:plan:actions';
const ALLOWANCE_KEY = 'naoru:allowance:v1'; // { submissions:[...], productivity:{…} } 旧形式。提出は追記ログ(ALLOWANCE_LOG_KEY)・生産性は別キー(ALLOWANCE_PROD_KEY)へ移行済み。ここはRollback用の写しとして維持
const ACCTMETA_KEY = 'naoru:accountmeta:v1'; // { owner: { role, staffId, staffName } }
const ZKTHERAPIST_KEY = 'naoru:zktherapist:v1'; // { 'shopName|YYYY-MM': count } 全体管理シートのセラピスト数 手動上書き
const THANKSGIFT_KEY = 'naoru:thanksgift:v1'; // { votes:[{id,period,fromStaffId,fromStaffName,fromShop,toStaffId,toStaffName,toShop,comment,createdAt}] } サンクスギフト投票
const CHAT_KEY = 'naoru:chat:v1';             // { rooms:[...], messages:{roomId:[...]}, dir:{staff:[...]}, notes:{...} } 社内チャット
const CHAT_READS_KEY = 'naoru:chat:reads:v1'; // 既読ポインタ { staffId:{roomId:ms} } を別キーに分離（頻繁なread書込がmessagesを巻き込んで消す競合を防止）
const CHAT_MSGS_KEY = 'naoru:chat:msgs:v1';   // 旧: メッセージ集約 { roomId:[...] }（移行元。現在はルーム別キーへ分割）
const CHAT_MSG_PREFIX = 'naoru:chat:m:';      // メッセージはルーム別キー naoru:chat:m:<roomId> に保存（別ルーム同士の送信が互いを消さない）
// ※以前あった索引(midx)は廃止。送信時に空ベースから作り直して他ルームを消す不具合があったため、
//   GETは権威ある rooms 一覧から per-room キーをMGETでまとめて引く方式に変更した。
const CHAT_IMG_PREFIX = 'naoru:chat:img:';    // 画像は1枚1キーで別保存（blob肥大化を避ける）
const CHAT_MSG_CAP = 400;                     // 1ルームあたり保持する最大メッセージ数（古いものから破棄）
const BOARD_KEY = 'naoru:board:v1';           // { posts:[...], reads:{…旧}, _v } 掲示板（全社発信）。既読は BOARD_READS_KEY へ分離済み（旧readsは移行用に残す）
const BOARD_FILE_PREFIX = 'naoru:board:file:';// 添付ファイルは1件1キーで別保存
const BOARD_POST_CAP = 500;                   // 保持する最大投稿数
const PUSH_KEY = 'naoru:push:v1';             // { subs:[{endpoint,keys,staffId,name,createdAt}] } Webプッシュ購読
const EVENTS_KEY = 'naoru:events:v1';         // { sections:{study:[row],event:[row],bukatsu:[row]} } 勉強会・イベント日程（共有編集）
const PROFILE_KEY = 'naoru:profile:v1';       // { profiles:{pid:{kind,nameKanji,nameKana,bio,mainImg,subImgs,sns,shops,birthday,updatedAt}} } スタッフ/オーナーのプロフィール（組織図で表示・店舗割当の上書き・birthday=誕生日の当日表示）
const ADSPEND_KEY = 'naoru:adspend:v1';       // { spend:{ 'YYYY-MM'|rangeKey : { 媒体名: 金額(円) } } } 媒体別広告費（従来は端末localStorageのみ→全社共有＝AIアシスタントも参照可）
const FAQ_KEY = 'naoru:faq:v1';               // { faqs:[{id,q,a,tags:[],shopScope:''|店舗名,updatedAt,updatedBy}] } 社内FAQ（AIアシスタントの回答根拠・本部が育てる）
const AILOG_KEY = 'naoru:ailog:v1';           // { logs:[{id,ts,shop,staffId,staffName,question,escalated}] } AIアシスタントの質問ログ（自己解決率・よくある質問の可視化用）
const KNOWLEDGE_KEY = 'naoru:knowledge:v1';   // { docs:[{id,title,body,shopScope,source,updatedAt,updatedBy}] } ナレッジ資料（長文: 議事録の文字起こし/スプレッドシート・スライドの中身/マニュアル）。AIが根拠に使う
const KNOWCAND_KEY = 'naoru:knowcand:v1';     // { cands:[{id,ts,roomId,shop,fromName,question,answer}] } 本部チャット回答のナレッジ候補（承認でFAQ化）
const PATROL_KEY = 'naoru:patrol:v1';         // { addresses:{shopName:{hp,hotpepper}}, queries:{shopName:検索クエリ} } AIパトロール設定（住所照合・Google検索クエリ上書き）
const ACQEXCLUDE_KEY = 'naoru:acqexclude:v1'; // { ids:{ customer_id: {by,name,shop,at} } } マーケ集計から手動除外した予約（スタッフのテスト予約でキャンセル率等が狂うのを防ぐ・全社共有）
const MEO_KEY = 'naoru:meo:v1';               // { shops:{ 店舗名:{ history:[{date,count,rating}], latest:{...Places}, placeId, query, updatedAt } } } MEO（Googleマップ）口コミ数・評価の履歴と最新情報
const SOFL_KEY = 'naoru:soflmap:v1';          // { cust:{ customer_id:{fl,ca} }, cursor, updatedAt, stats } appointmentsを差分同期した「顧客→施策リンクID」対応表（新規顧客一覧へJOINして施策リンク別を再構築）
const PRESENCE_KEY = 'naoru:presence:v1';     // { users:{ id:{name,role,page,at} } } 今アクセス中のアカウント（スプシ風・上部バー表示）。at=最終ハートビート(ms)。TTL超過は都度prune

// ── Webプッシュ送信（VAPID設定時のみ動作・未設定なら黙ってスキップ） ──
const VAPID_PUBLIC = () => process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = () => process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = () => process.env.VAPID_SUBJECT || 'mailto:admin@naoru.example';
// 対象購読へ通知を送る。web-push は動的import（未インストール環境でもハンドラは壊れない）。
// filterStaffIds が配列なら、その staffId の購読のみへ送信（未指定＝全員）。
// 購読者ごとの通知設定を正規化。board=掲示板/お知らせハブ, chat='all'|'mention'|'off'
function normalizePrefs(p) {
  p = (p && typeof p === 'object') ? p : {};
  return { board: p.board !== false, chat: ['all', 'mention', 'off'].includes(p.chat) ? p.chat : 'all' };
}
async function sendPush(hasKV, hasSB, gas, payload, filterStaffIds, opts) {
  try {
    if (!VAPID_PUBLIC() || !VAPID_PRIVATE()) return; // 未設定＝無効
    const mod = await import('web-push').catch(() => null);
    const webpush = mod && (mod.default || mod);
    if (!webpush) return;
    webpush.setVapidDetails(VAPID_SUBJECT(), VAPID_PUBLIC(), VAPID_PRIVATE());
    const store = (await blobGet(PUSH_KEY, hasKV, hasSB, gas)) || {};
    let subs = Array.isArray(store.subs) ? store.subs : [];
    const only = Array.isArray(filterStaffIds) ? new Set(filterStaffIds.map(String)) : null;
    const kind = (payload && payload.kind) || '';
    const o = opts || {};
    const mentionSet = new Set((o.mentionIds || []).map(String));
    const mentionAll = !!o.mentionAll;
    // 各購読者の設定で配信可否を判定
    const allow = (s) => {
      const p = normalizePrefs(s && s.prefs);
      if (kind === 'board') return p.board;
      if (kind === 'chat') {
        if (p.chat === 'off') return false;
        if (p.chat === 'mention') return mentionAll || mentionSet.has(String(s.staffId));
        return true; // 'all'
      }
      return true;
    };
    const targets = (only ? subs.filter(s => only.has(String(s.staffId))) : subs).filter(allow);
    const body = JSON.stringify(payload);
    const dead = [];
    await Promise.all(targets.map(async (s) => {
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body); }
      catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.push(s.endpoint); }
    }));
    if (dead.length) { // 失効した購読を掃除
      const next = subs.filter(s => !dead.includes(s.endpoint));
      await blobSet(PUSH_KEY, { subs: next }, hasKV, hasSB, gas);
    }
  } catch (_) { /* 送信失敗は投稿処理を止めない */ }
}

// ── Vercel KV (Upstash REST) ──
async function kvGet(key) {
  const r = await fetch(`${KV_URL()}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN()}` },
  });
  if (!r.ok) throw new Error(`KV get ${r.status}`);
  const j = await r.json().catch(() => ({}));
  if (j && j.result != null) { try { return JSON.parse(j.result); } catch { return null; } }
  return null;
}
async function kvSet(key, value) {
  const r = await fetch(`${KV_URL()}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN()}`, 'Content-Type': 'text/plain' },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`KV set ${r.status}`);
  return true;
}
// Luaスクリプトをサーバー側でアトミックに実行（Upstash EVAL）。
async function kvEval(script, keys, args) {
  const r = await fetch(KV_URL(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['EVAL', script, String(keys.length), ...keys, ...args]),
  });
  if (!r.ok) throw new Error(`KV eval ${r.status}`);
  const j = await r.json().catch(() => ({}));
  return j.result;
}
// JSON配列キーに1要素をアトミックに追記し、末尾cap件へトリム（read-modify-writeの競合＝同時送信で消えるのを防ぐ）。
const KV_APPEND_LUA = "local raw=redis.call('GET',KEYS[1]) local arr if raw then arr=cjson.decode(raw) else arr={} end arr[#arr+1]=cjson.decode(ARGV[1]) local cap=tonumber(ARGV[2]) if #arr>cap then local res={} local s=#arr-cap+1 for i=s,#arr do res[#res+1]=arr[i] end arr=res end redis.call('SET',KEYS[1],cjson.encode(arr)) return #arr";
// 版(_v)を照合してから書き込む compare-and-set。
// 読んでから書くまでの間に他のリクエストが書いていたら -1 を返して書かない。
// これが無いと、同時投稿が数百ミリ秒の窓で互いを踏む（expectedVersion だけでは
// 「読んだ時点の版」しか見ないため、この窓は閉じられない）。
const KV_CAS_LUA = "local raw=redis.call('GET',KEYS[1]) local curv=0 if raw then local ok,d=pcall(cjson.decode,raw) if ok and type(d)=='table' and d._v then curv=tonumber(d._v) or 0 end end if curv~=tonumber(ARGV[1]) then return -1 end redis.call('SET',KEYS[1],ARGV[2]) return 1";
async function kvCasSet(key, expectedV, value) {
  const r = await kvEval(KV_CAS_LUA, [key], [String(expectedV), JSON.stringify(value)]);
  return Number(r) === 1;
}

// 既読マップの1キーだけを「大きい方を採用」で原子的に更新する。
// 既読は別キーなので、仮にこれが失敗して read-modify-write に落ちても投稿は壊れない。
const KV_BUMP_READ_LUA = "local raw=redis.call('GET',KEYS[1]) local m={} if raw then local ok,d=pcall(cjson.decode,raw) if ok and type(d)=='table' then m=d end end local k=ARGV[1] local t=tonumber(ARGV[2]) local cur=tonumber(m[k]) or 0 if t>cur then m[k]=t end redis.call('SET',KEYS[1],cjson.encode(m)) return 1";
async function kvBumpRead(key, staffId, ts) {
  return await kvEval(KV_BUMP_READ_LUA, [key], [String(staffId), String(ts)]);
}
async function kvAppendJson(key, item, cap) {
  return await kvEval(KV_APPEND_LUA, [key], [JSON.stringify(item), String(cap)]);
}
// 複数キーを1リクエストで取得（Upstash MGET）。索引を使わずルーム別キーをまとめて読むために使用。
async function kvMGet(keys) {
  if (!keys || !keys.length) return [];
  const r = await fetch(KV_URL(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['MGET', ...keys]),
  });
  if (!r.ok) throw new Error(`KV mget ${r.status}`);
  const j = await r.json().catch(() => ({}));
  const arr = Array.isArray(j.result) ? j.result : [];
  return arr.map(v => { if (v == null) return null; try { return JSON.parse(v); } catch { return null; } });
}

// ── Supabase (PostgREST) ──
async function sbGet(key) {
  const r = await fetch(`${SB_URL()}/rest/v1/plan_store?key=eq.${encodeURIComponent(key)}&select=value`, {
    headers: { apikey: SB_KEY(), Authorization: `Bearer ${SB_KEY()}` },
  });
  if (!r.ok) throw new Error(`SB get ${r.status}`);
  const arr = await r.json().catch(() => []);
  return (Array.isArray(arr) && arr[0]) ? arr[0].value : null;
}
async function sbSet(key, value) {
  const r = await fetch(`${SB_URL()}/rest/v1/plan_store`, {
    method: 'POST',
    headers: { apikey: SB_KEY(), Authorization: `Bearer ${SB_KEY()}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`SB set ${r.status}`);
  return true;
}

// ── GAS フォールバック ──
async function gasCall(url, method, payload) {
  const opt = { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, redirect: 'follow' };
  if (method === 'POST') opt.body = JSON.stringify(payload);
  const resp = await fetch(url, opt);
  if (!resp.ok) throw new Error(`GAS ${resp.status}`);
  return resp.json().catch(() => ({}));
}

// ── 汎用 blob get/set（有効なバックエンドへ振り分け。手当ストア等で使用） ──
async function blobGet(key, hasKV, hasSB, gas) {
  if (hasKV) return await kvGet(key);
  if (hasSB) return await sbGet(key);
  const j = await gasCall(`${gas}?type=kv&key=${encodeURIComponent(key)}`, 'GET');
  return (j && j.value != null) ? j.value : null;
}
async function blobSet(key, value, hasKV, hasSB, gas) {
  if (hasKV) return await kvSet(key, value);
  if (hasSB) return await sbSet(key, value);
  return await gasCall(gas, 'POST', { action: 'saveKv', key, value });
}
// 複数キーをまとめて取得（KVはMGETで1往復、それ以外は並列get）
async function blobMGet(keys, hasKV, hasSB, gas) {
  if (!keys || !keys.length) return [];
  if (hasKV) return await kvMGet(keys);
  return await Promise.all(keys.map(k => blobGet(k, hasKV, hasSB, gas)));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const hasKV = !!(KV_URL() && KV_TOKEN());
  const hasSB = !!(SB_URL() && SB_KEY());
  const gas = GAS_URL();

  // ── Vercel Blob アップロード用クライアントトークン発行: ?type=blobupload（動画/PDF/ファイル添付） ──
  // クライアントの @vercel/blob upload() が handleUploadUrl として叩く。大容量ファイルは
  // サーバー(4.5MB上限)を経由せず Blob ストレージへ直接アップロードされる。
  // 有効化には Vercel の Storage で Blob を作成（BLOB_READ_WRITE_TOKEN が自動注入）すること。
  // ⚠️ @vercel/blob の client upload() はトークン発行POSTの body に独自の type
  //    ('blob.generate-client-token') を入れるため、body.type では判定できない。
  //    handleUploadUrl のクエリ ?type=blobupload で判定する（body.type は後方互換）。
  // ── 認証ゲート（すべての type= ハンドラより前に通す）──────────────────────
  // ⚠️ ここより後ろに個別ハンドラを足す場合も、この判定を必ず通ること。
  //    以前はチャットの直前に置いていたため、掲示板など先に定義されたハンドラが
  //    ゲートを通らずに応答していた（＝塞げていなかった）。
  const chatSalt = () => process.env.AUTH_SALT || 'naoru-settlement-2026';
  const chatResolveActor = () => resolveActor(req, {
    env: process.env,
    verifySalonOneBearer,
    // 秘密が未設定なら root 経路を閉じる（環境変数の欠落で認証が外れない）
    rootToken: () => (process.env.DASHBOARD_PASSWORD ? hashOwnerToken('__root__', process.env.DASHBOARD_PASSWORD, chatSalt()) : ''),
    verifyOwnerToken: (pw, owner, token) => verifyOwnerToken(pw, owner, token, chatSalt()),
    loadAccounts: async () => {
      const passwords = parseOwnerPasswords(process.env.SETTLEMENT_OWNER_PASSWORDS);
      const shopsMap = parseOwnerShops(process.env.SETTLEMENT_OWNER_SHOPS);
      if (kvConfigured()) {
        const kvPass = await kvBlobGet(ACCT_PASS_KEY).catch(() => null);
        if (kvPass && typeof kvPass === 'object') for (const [o, pw] of Object.entries(kvPass)) if (pw) passwords[o] = String(pw);
      }
      const metaMap = (await blobGet(ACCTMETA_KEY, hasKV, hasSB, gas).catch(() => null)) || {};
      return { passwords, shopsMap, metaMap };
    },
  }).catch(() => null);

  // ⚠️ knowcand（ナレッジ候補）は**本部がチャットで送った回答の本文**をそのまま保持する。
  //    実体はチャット本文なので、公開範囲もチャットと同じ（本部/root限定）に揃える。
  const chatTypes = ['chat', 'profile', 'chatai', 'knowcand'];
  // ── 社内限定データ: **ログインしていること**を要求する（役割は問わない）────────
  // ⚠️ チャットの「本部/root限定」をここへ広げない。
  //    掲示板・イベント・サンクスギフト・手当・FAQ などは、スタッフ／オーナーが
  //    現に使う（または今後開放する）機能なので、**正規ユーザーの利用は維持**し、
  //    「誰でも取れる／誰でも書ける」状態だけを塞ぐ。
  //    店舗単位の絞り込みは既存のUI側の責務のまま（本PRでは変更しない）。
  const authnTypes = [
    'board',        // 掲示板（投稿者名・本文）
    'events',       // 勉強会・イベント（社内予定）
    'thanksgift',   // サンクスギフト（**匿名性が前提**。誰が誰に送ったかが読めてはいけない）
    'presence',     // 今アクセス中の人（個人の行動）
    'allowance',    // 手当・領収書（氏名・金額・生産性）
    'adspend',      // 広告費（経営数値）
    'faq',          // 社内FAQ（業務手順）
    'knowledge',    // ナレッジ資料（社内資料）
    'meo',          // MEO（店舗の外部連携情報）
    'patrol',       // AIパトロール設定
    'acqexclude',   // マーケ集計の手動除外
    'sbcache',      // 店舗別売上のキャッシュ
    'soflmap',      // 顧客→施策リンクの対応表
    'accountmeta',  // アカウントの役割・staffId 紐付け
    'zktherapist',
    'ailog',        // AI質問ログ（氏名・店舗・質問文）
    'push',         // Webプッシュ購読（個人の端末・通知設定。未認証で他人のstaffIdを名乗れないようにする）
    'blobcheck',    // 添付保存先の設定状況（インフラ情報）
  ];
  const reqType = (req.method === 'GET' ? req.query.type : (req.body || {}).type);
  let chatActor = null;
  if (chatTypes.includes(reqType) || authnTypes.includes(reqType)) {
    chatActor = await chatResolveActor();
    const verified = !!chatActor && chatActor.verified === true;
    if (chatTypes.includes(reqType)) {
      // チャット系は従来どおり本部/root限定（公開範囲は変えない）。
      // ⚠️ body.root / body.staffId / 申告 role は本人確認の代わりにしない。
      // ⚠️ cc_authz の log / shadow はあくまで計測用で、この拒否を無効化しない。
      if (!verified || !['root', 'admin'].includes(chatActor.role)) {
        return res.status(403).json({ ok: false, error: 'forbidden', code: 'chat_admin_only',
          message: 'チャットは本部・管理者のみが利用できます（再ログインが必要な場合があります）' });
      }
    } else if (!verified) {
      // 社内限定データ: ログインしていれば役割は問わない（スタッフ／オーナーの利用は維持）
      return res.status(403).json({ ok: false, error: 'forbidden', code: 'login_required',
        message: 'ログインが必要です（再ログインが必要な場合があります）' });
    }
  }



  // Blob設定チェック（クライアントが動画/ファイル送信前に確認）
  // ⚠️ 上の認証ゲートを**通した後**に応答する（未認証には設定状況も返さない）。
  if (reqType === 'blobcheck') {
    return res.status(200).json({ ok: true, configured: !!process.env.BLOB_READ_WRITE_TOKEN });
  }

  const isBlobUpload = req.query.type === 'blobupload' || (req.body || {}).type === 'blobupload';
  if (isBlobUpload) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(200).json({ ok: false, configured: false, error: 'blob_not_configured' });
    try {
      const { handleUpload } = await import('@vercel/blob/client');
      const jsonResponse = await handleUpload({
        body: req.body,
        request: { headers: { get: (k) => req.headers[String(k).toLowerCase()] } },
        onBeforeGenerateToken: async () => ({
          allowedContentTypes: ['image/*', 'video/*', 'application/pdf', 'application/*', 'text/*', 'audio/*'],
          maximumSizeInBytes: 314572800, // 300MB（3〜5分の動画を許容）
          addRandomSuffix: true,
        }),
        onUploadCompleted: async () => {},   // 完了URLはクライアントの upload() 戻り値から取得するため何もしない
      });
      return res.status(200).json(jsonResponse);
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Command Center（Phase 0〜2）: ?type=ccflags / approval / agentlog / audit
  // ──────────────────────────────────────────────────────────────────
  // ⚠️ 信頼モデルは既存の chat / thanksgift と同じ＝**サーバー認証なし**。
  //    actor はクライアント申告であり、ここでの role 判定はUIレベルの制御にすぎない。
  //    サーバー側の強制は cc_authz='enforce' を導入する段階（Phase 3）で行う。
  //    それまでの間、この4種は「既定OFFのフラグの内側」でのみ画面に出る。
  // ⚠️ 新しいServerless Functionは増やさない（Hobby上限12・現在11使用済み）。
  //    そのため plan-store の ?type= 分岐として同居させる。
  // ══════════════════════════════════════════════════════════════════
  // ── 環境スコープ（重要）────────────────────────────────────────
  // Vercel の環境変数は既定で Production / Preview が同じ値を共有するため、
  // Preview からフラグを ON にすると **本番のフラグまで ON になってしまう**。
  // そこで Command Center のキーだけ環境ごとに分ける。VERCEL_ENV は Vercel が
  // 自動で入れるシステム変数なので、環境変数の追加設定は要らない。
  //   production → naoru:cc:flags:v1        （従来どおり）
  //   preview    → naoru:cc:flags:v1:preview（本番とは別物）
  // ⚠️ 既存の type=（chat/board/allowance 等）のキーは**一切変えない**。
  //    既存データの参照先が変わると社内の運用が壊れるため、新規キーのみ対象。
  const CC_ENV = String(process.env.VERCEL_ENV || process.env.CC_ENV || 'development');
  const ccKey = (base) => (CC_ENV === 'production' ? base : `${base}:${CC_ENV}`);

  // ── @AI 実接続（検証用・本部/root限定）────────────────────────────────
  // 契約: CHAT_AI_API_CONTRACT.md（②合意版 7a02420）。
  // ⚠️ **実際のエンドポイントは POST /api/plan-store で、type は本文（クエリではない）**。
  //    既存ルーターが POST のとき body.type を見るため、契約書の `?type=...&action=...` 例は使えない。
  // ⚠️ 認証ヘッダは X-CC-Owner / X-CC-Token（または SSO の Authorization）に統一。
  //    X-Chat-* は現行実装では**受け付けない**（自己申告の role も使わない）。
  if (reqType === 'chatai') {
    const body = req.body || {};
    const action = String(body.action || req.query.action || '').slice(0, 40);
    const tenantId = String(chatActor.tenantId || DEFAULT_TENANT).slice(0, 64);
    const actorId = String(chatActor.id || '').slice(0, 64);

    // フラグ: OFF ならAI呼び出しも投稿も行わない（画面で隠すだけにしない）
    const aiFlags = normalizeFlags(await blobGet(ccKey(FLAGS_KEY), hasKV, hasSB, gas).catch(() => null));
    const aiOn = aiFlags.cc_all !== false && aiFlags.cc_ai_trial === true;

    const cfg = normalizeAiCfg(await blobGet(ccKey(CHATAI_CFG_KEY), hasKV, hasSB, gas).catch(() => null));
    // メッセージの読み書き（チャット本体と同じルーム別キー。形式を変えない）
    const getRoomMsgs = async (rid) => {
      const a = await blobGet(CHAT_MSG_PREFIX + String(rid), hasKV, hasSB, gas);
      return Array.isArray(a) ? a : [];
    };
    const saveRoomMsgs = (rid, arr) => blobSet(CHAT_MSG_PREFIX + String(rid), Array.isArray(arr) ? arr : [], hasKV, hasSB, gas);
    // 監査は共通のものへ（新しいログは作らない）。失敗しても本処理は止めない。
    const audit = async (input) => {
      try {
        const built = buildAuditEntry({ ...input, actor: chatActor, source: chatActor.source });
        if (built.ok && hasKV) await kvAppendJson(ccKey(AUDIT_KEY), built.entry, AUDIT_CAP);
      } catch (_) {}
    };
    const loadAi = async () => {
      const cur = (await blobGet(ccKey(CHATAI_STORE_KEY), hasKV, hasSB, gas)) || {};
      return {
        requests: (cur.requests && typeof cur.requests === 'object') ? cur.requests : {},
        answers: (cur.answers && typeof cur.answers === 'object') ? cur.answers : {},
        reviews: (cur.reviews && typeof cur.reviews === 'object') ? cur.reviews : {},
        corrections: (cur.corrections && typeof cur.corrections === 'object') ? cur.corrections : {},
      };
    };
    const saveAi = (next) => blobSet(ccKey(CHATAI_STORE_KEY), next, hasKV, hasSB, gas);

    // 設定の参照・更新（root/本部のみ。検証用Roomと許可FAQを人が決める）
    if (action === 'config') {
      if (req.method === 'GET') return res.status(200).json({ ok: true, config: cfg, enabled: aiOn });
      const next = normalizeAiCfg({ ...cfg, ...(body.config || {}), updatedAt: new Date().toISOString(), updatedBy: actorId });
      await blobSet(ccKey(CHATAI_CFG_KEY), next, hasKV, hasSB, gas);
      await audit({ action: 'chatai_config', entity: 'chatai', entityId: 'config', after: next });
      return res.status(200).json({ ok: true, config: next });
    }

    if (!aiOn) return res.status(200).json(aiError('rollout_disabled'));

    // 現在のルーム一覧（可視判定に使う）
    const roomsCur = (await blobGet(CHAT_KEY, hasKV, hasSB, gas)) || {};
    const roomsAll = Array.isArray(roomsCur.rooms) ? roomsCur.rooms : [];
    const roomOf = (rid) => roomsAll.find(r => r && String(r.id) === String(rid)) || null;

    if (action === 'ask') {
      const input = normalizeAskInput(body);
      if (!input.question || !input.roomId || !input.requestId) return res.status(200).json(aiError('invalid_request'));

      // 回答先のルームを確定する。**クライアントの申告ではなくサーバーが決める。**
      const room = roomOf(input.roomId);
      if (!room) return res.status(200).json(aiError('forbidden_room'));
      if (room.tenantId && String(room.tenantId) !== tenantId) return res.status(200).json(aiError('tenant_mismatch'));
      if (!canViewRoom(chatActor, room)) return res.status(200).json(aiError('forbidden_room'));
      // 検証用Roomの許可リストに載っているものだけ（既定は空＝どこも許可しない）
      if (!isTrialRoom(cfg, input.roomId)) return res.status(200).json(aiError('forbidden_room', 'このルームは検証対象ではありません'));

      // 生成開始時の認可（AIがこのルームへ返信してよいか）
      const aiActor = { id: AI_STAFF_ID, name: AI_NAME, role: 'root', source: 'agent', verified: true, shops: null, tenantId };
      const pre = authzCan(aiActor, 'chat.ai_reply', { shop: room.shop || '', room });
      if (!pre.allow) return res.status(200).json(aiError('forbidden_room', pre.reason));

      const st = await loadAi();
      const key = aiRequestKey(tenantId, actorId, input.requestId);
      const prev = st.requests[key];
      const kind = classifyRequest(prev, { roomId: input.roomId, qfp: makeRequestRecord(input, { tenantId, actorId }).qfp });
      if (kind === 'conflict') return res.status(200).json(aiError('request_conflict'));
      if (kind === 'replay') {
        const ans = st.answers[prev.answerMessageId] || {};
        return res.status(200).json({ ok: true, replay: true,
          question_message_id: prev.questionMessageId, answer_message_id: prev.answerMessageId,
          room_id: prev.roomId, body: ans.body || '', mode: ans.mode || 'sample',
          sources: ans.sources || { verification: 'none', verified: [], candidates: [] },
          hq_review: st.reviews[prev.questionMessageId] || { status: 'none', notified: false, channel: 'not_connected' } });
      }
      if (kind === 'pending' && !isStalePending(prev)) {
        return res.status(200).json({ ok: true, status: 'pending',
          question_message_id: prev.questionMessageId || '', answer_message_id: '', room_id: prev.roomId });
      }

      // 質問を先に確定させる（AIが失敗しても質問は失われない）。
      // 既に投稿済みの質問IDが渡されていれば**新しく作らない**（2件にしない）。
      const msgs = await getRoomMsgs(input.roomId);
      let qMsgId = '';
      const claimed = input.questionMessageId && msgs.find(m => m && String(m.id) === input.questionMessageId);
      if (claimed) {
        // 渡された質問IDが本当にこのルームの、AI以外の投稿かを確認する
        if (String(claimed.fromStaffId) === AI_STAFF_ID) return res.status(200).json(aiError('ai_message_source'));
        qMsgId = String(claimed.id);
      } else {
        const qm = { id: genId('m'), roomId: input.roomId, fromStaffId: actorId, fromName: String(chatActor.name || '本部'),
          fromShop: '', text: input.question, imgIds: [], links: [], mentions: [], createdAt: new Date().toISOString() };
        await saveRoomMsgs(input.roomId, msgs.concat(qm).slice(-CHAT_MSG_CAP));
        qMsgId = qm.id;
      }

      const rec = makeRequestRecord(input, { tenantId, actorId });
      rec.questionMessageId = qMsgId;
      st.requests[key] = rec;
      await saveAi(st);                           // pending を永続化（再起動・複数プロセスでも重複しない）

      // 許可済みFAQだけを資料として渡す（許可リストが空なら資料なし）
      const faqStore = (await blobGet(FAQ_KEY, hasKV, hasSB, gas).catch(() => null)) || {};
      const docs = pickAllowedDocs(faqStore.faqs, cfg, input.hintDocIds);
      const dataContext = wrapDocsAsData(docs);

      // 既存のFAQ回答生成処理を再利用する（新しいAI経路は作らない）
      const runStart = Date.now();
      let answerText = '';
      let mode = 'sample';
      try {
        const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
        // プロトコルは転送ヘッダを優先。無い場合、ローカル/検証環境は http、それ以外は https。
        // （決め打ちで https にすると、検証環境で自分自身を呼べない）
        const proto = String(req.headers['x-forwarded-proto']
          || (/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host) ? 'http' : 'https'));
        if (process.env.ANTHROPIC_API_KEY && host) {
          const r = await fetch(`${proto}://${host}/api/chat`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent: 'faq', question: input.question, history: [], dataContext }),
          });
          const j = await r.json().catch(() => ({}));
          if (r.ok && j && j.message) { answerText = String(j.message); mode = 'live'; }
          else if (r.status === 429) { throw Object.assign(new Error('rate'), { code: 'rate_limited' }); }
          else { throw new Error('upstream'); }
        } else {
          // 実AIが未設定の環境（検証用）。**サンプルであることを必ず申告する。**
          answerText = `［サンプル回答］${input.question}\n\n（このDashboardでは ANTHROPIC_API_KEY が未設定のため、モック回答を返しています）`;
          mode = 'sample';
        }
      } catch (e) {
        rec.status = 'failed';
        st.requests[key] = rec;
        await saveAi(st);                          // 質問は残る。下書きも失わない
        return res.status(200).json(aiError(e && e.code === 'rate_limited' ? 'rate_limited' : 'upstream_failed'));
      }

      const sources = buildSources(docs, docs.map(d => ({ id: d.id, title: d.title, reason: 'passed_to_model' })));
      // mock は決して server_verified を名乗らない
      if (mode !== 'live') sources.verification = sources.verified.length ? 'unverified' : 'none';

      // 保存/配信直前にもう一度認可（生成中に権限が変わっていないか）
      const roomNow = roomOf(input.roomId);
      const post = roomNow ? authzCan(aiActor, 'chat.ai_reply', { shop: roomNow.shop || '', room: roomNow }) : { allow: false };
      if (!roomNow || !post.allow || !isTrialRoom(normalizeAiCfg(await blobGet(ccKey(CHATAI_CFG_KEY), hasKV, hasSB, gas).catch(() => null)), input.roomId)) {
        rec.status = 'failed'; st.requests[key] = rec; await saveAi(st);
        return res.status(200).json(aiError('forbidden_room', '配信直前の確認で権限がありませんでした'));
      }

      const aMsg = { id: genId('a'), roomId: input.roomId, fromStaffId: AI_STAFF_ID, fromName: AI_NAME,
        fromShop: '', text: answerText, imgIds: [], links: [], mentions: [], createdAt: new Date().toISOString(),
        ai: { mode, verification: sources.verification, requestId: input.requestId } };
      const cur2 = await getRoomMsgs(input.roomId);
      await saveRoomMsgs(input.roomId, cur2.concat(aMsg).slice(-CHAT_MSG_CAP));

      rec.status = 'done'; rec.answerMessageId = aMsg.id;
      st.requests[key] = rec;
      st.answers[aMsg.id] = { body: answerText, mode, sources, roomId: input.roomId, tenantId,
        questionMessageId: qMsgId, createdAt: aMsg.createdAt };

      // 根拠が無い／未検証なら本部確認へ回す（同じ質問につき1件）
      let hq = { status: 'none', request_id: null, notified: false, channel: 'not_connected' };
      if (needsHqReview(sources, answerText)) {
        const up = upsertReview(st.reviews, { tenantId, roomId: input.roomId, questionMessageId: qMsgId,
          answerMessageId: aMsg.id, requestedBy: actorId, notified: false, channel: 'not_connected' });
        st.reviews = up.map;
        hq = { status: up.review.status, request_id: up.review.id, notified: up.review.notified, channel: up.review.channel };
      }
      await saveAi(st);

      // 共通の Agent Activity・監査へ接続（新しいログは作らない）
      try {
        const run = startRun({ agentName: 'NAORU Chat Assistant', action: 'draft', reason: 'チャットからの質問に回答',
          source: 'chat', shop: roomNow.shop || '', approvalRequired: false });
        if (run.ok) {
          const fin = finishRun(run.run, { status: 'success', result: `mode=${mode} verification=${sources.verification}` });
          if (fin.ok && hasKV) await kvAppendJson(ccKey(AGENTLOG_KEY), fin.run, AGENTLOG_CAP);
        }
      } catch (_) {}
      await audit({ action: 'chatai_answer', entity: 'chatai', entityId: aMsg.id,
        after: { roomId: input.roomId, mode, verification: sources.verification, ms: Date.now() - runStart } });

      return res.status(200).json({ ok: true, question_message_id: qMsgId, answer_message_id: aMsg.id,
        room_id: input.roomId, body: answerText, mode, sources, hq_review: hq });
    }

    // 本部確認の依頼（同じ質問につき1件。連打で増やさない）
    if (action === 'hq_review') {
      const qid = String(body.question_message_id || '').slice(0, 80);
      const aid = String(body.answer_message_id || '').slice(0, 80);
      if (!qid && !aid) return res.status(200).json(aiError('invalid_request'));
      const st = await loadAi();
      const ans = st.answers[aid];
      // 参照権限を都度確認（保存済みでも、いま見てよいかを確かめる）
      const rid = (ans && ans.roomId) || String(body.room_id || '');
      const room = roomOf(rid);
      if (!room || !canViewRoom(chatActor, room)) return res.status(200).json(aiError('forbidden_room'));
      if (ans && ans.tenantId && ans.tenantId !== tenantId) return res.status(200).json(aiError('tenant_mismatch'));
      const up = upsertReview(st.reviews, { tenantId, roomId: rid, questionMessageId: qid, answerMessageId: aid,
        requestedBy: actorId, notified: false, channel: 'not_connected' });
      st.reviews = up.map;
      await saveAi(st);
      await audit({ action: 'chatai_hq_review', entity: 'chatai', entityId: qid || aid, after: { created: up.created } });
      return res.status(200).json({ ok: true, created: up.created,
        hq_review: { status: up.review.status, request_id: up.review.id, notified: up.review.notified, channel: up.review.channel } });
    }

    // 本部による訂正（元回答は残して追記）
    if (action === 'correct') {
      const aid = String(body.answer_message_id || '').slice(0, 80);
      const text = String(body.text || '').slice(0, 4000);
      if (!aid || !text.trim()) return res.status(200).json(aiError('invalid_request'));
      const st = await loadAi();
      const ans = st.answers[aid];
      if (!ans) return res.status(200).json(aiError('invalid_request'));
      const room = roomOf(ans.roomId);
      if (!room || !canViewRoom(chatActor, room)) return res.status(200).json(aiError('forbidden_room'));
      if (ans.tenantId && ans.tenantId !== tenantId) return res.status(200).json(aiError('tenant_mismatch'));
      const ap = appendCorrection(st.corrections, { answerMessageId: aid, text,
        byId: actorId, byName: String(chatActor.name || '本部') });
      if (!ap.added) return res.status(200).json(aiError('invalid_request'));
      st.corrections = ap.map;
      // 依頼が残っていれば解決済みにする
      if (ans.questionMessageId && st.reviews[ans.questionMessageId]) {
        st.reviews[ans.questionMessageId] = { ...st.reviews[ans.questionMessageId], status: 'resolved', resolvedAt: new Date().toISOString(), resolvedBy: actorId };
      }
      await saveAi(st);
      await audit({ action: 'chatai_correction', entity: 'chatai', entityId: aid,
        after: { byId: actorId, knowledgeStatus: ap.correction.knowledgeStatus } });
      return res.status(200).json({ ok: true, correction: ap.correction,
        // Knowledge へは自動反映しない。承認候補として渡すだけ。
        knowledge: { auto_published: false, status: 'approval_candidate' } });
    }

    // 保存済みの回答・出典・依頼・訂正の再取得（**その都度いまの閲覧権限を確認**）
    if (action === 'get' || req.method === 'GET') {
      const st = await loadAi();
      const rid = String(body.room_id || req.query.roomId || '').slice(0, 80);
      const room = roomOf(rid);
      if (!room || !canViewRoom(chatActor, room)) return res.status(200).json(aiError('forbidden_room'));
      const answers = {};
      for (const [id, a] of Object.entries(st.answers)) {
        if (String(a.roomId) === rid && String(a.tenantId || tenantId) === tenantId) {
          answers[id] = { body: a.body, mode: a.mode, sources: a.sources, questionMessageId: a.questionMessageId,
            corrections: st.corrections[id] || [], hq_review: st.reviews[a.questionMessageId] || null };
        }
      }
      return res.status(200).json({ ok: true, room_id: rid, answers });
    }

    return res.status(200).json(aiError('invalid_request'));
  }

  const ccType = (req.method === 'GET' ? req.query.type : (req.body || {}).type);

  // ── Meta運用画面の読み取り: ?type=meta（読取専用）────────────────────────
  // ⚠️ Meta のアクセストークンは **Dashboard には存在しません**。③ naoru-ai-platform が
  //    保持し、Dashboard はサーバー側からそのAPIを呼ぶだけ。ブラウザには結果しか返しません。
  //    契約は META_READ_API_CONTRACT.md（api_version='meta-read-1'）。
  //    広告の変更・予算変更・自動運用はこのエンドポイントに含めません（GETのみ）。
  if (ccType === 'meta') {
    // 本部/root 限定は **UIだけでなくここでも強制**する。名乗りは信用しない。
    const salt = process.env.AUTH_SALT || 'naoru-settlement-2026';
    const actor = await resolveActor(req, {
      env: process.env,
      verifySalonOneBearer,
      rootToken: () => (process.env.DASHBOARD_PASSWORD ? hashOwnerToken('__root__', process.env.DASHBOARD_PASSWORD, salt) : ''),
      verifyOwnerToken: (pw, owner, token) => verifyOwnerToken(pw, owner, token, salt),
      loadAccounts: async () => {
        const passwords = parseOwnerPasswords(process.env.SETTLEMENT_OWNER_PASSWORDS);
        const shopsMap = parseOwnerShops(process.env.SETTLEMENT_OWNER_SHOPS);
        if (kvConfigured()) {
          const kvPass = await kvBlobGet(ACCT_PASS_KEY).catch(() => null);
          if (kvPass && typeof kvPass === 'object') for (const [o, pw] of Object.entries(kvPass)) if (pw) passwords[o] = String(pw);
        }
        const metaMap = (await blobGet(ACCTMETA_KEY, hasKV, hasSB, gas).catch(() => null)) || {};
        return { passwords, shopsMap, metaMap };
      },
    }).catch(() => null);
    const isAdmin = !!actor && actor.verified === true && ['root', 'admin'].includes(actor.role);
    if (!isAdmin) {
      return res.status(403).json({ ok: false, error: 'forbidden', code: 'admin_only',
        message: 'この画面は本部・管理者のみが利用できます' });
    }
    const chatActorForMeta = actor;   // tenant はこの検証済み actor から決める（クエリでは切り替えない）
    if (req.method !== 'GET') {
      // 読取専用。書き込み系は存在しない（広告変更はここから行えない）。
      return res.status(405).json({ ok: false, error: 'read_only', message: 'Meta運用画面は読み取り専用です' });
    }

    // (3) 機能フラグ＋キルスイッチをサーバー側でも確認する。
    //     OFF のときは URL を直接叩いても上流へ取りに行かない（画面で隠すだけにしない）。
    const metaFlags = normalizeFlags(await blobGet(ccKey(FLAGS_KEY), hasKV, hasSB, gas).catch(() => null));
    if (metaFlags.cc_all === false || metaFlags.cc_meta_overview !== true) {
      return res.status(403).json({ ok: false, error: 'forbidden', code: 'feature_disabled',
        message: 'Meta運用画面は現在無効です' });
    }

    const base = String(process.env.META_READ_API_BASE || '').trim().replace(/\/+$/, '');
    const key = String(process.env.META_READ_API_KEY || '').trim();

    // (1) tenant は **検証済み actor から決める**。クエリで会社を切り替えられないようにする。
    const tenantId = String((chatActorForMeta && chatActorForMeta.tenantId) || DEFAULT_TENANT).slice(0, 64);

    // (2) accountId は **そのテナントに許可されたアカウントのみ**。
    //     許可一覧は環境変数（META_AD_ACCOUNT_IDS: カンマ区切り）で人が設定する。
    //     未設定なら META_AD_ACCOUNT_ID の1件のみを許可する。
    const allowList = String(process.env.META_AD_ACCOUNT_IDS || process.env.META_AD_ACCOUNT_ID || '')
      .split(',').map(x => x.trim()).filter(Boolean)
      // 形式が明らかに不正なものは許可リストとして採用しない（Metaの広告アカウントは act_ で始まる）
      .filter(x => /^act_[A-Za-z0-9]+$/.test(x));
    const requested = String(req.query.accountId || '').slice(0, 64);
    const accountId = requested || allowList[0] || '';
    if (requested && allowList.length && !allowList.includes(requested)) {
      return res.status(403).json({ ok: false, error: 'forbidden', code: 'account_not_allowed',
        message: 'この広告アカウントは許可されていません' });
    }
    // 🔴 実Credential が入っているのに許可リストが空／不正なら、**上流を呼ばない**。
    //    「未接続なのでサンプルを出す」状態とは区別し、設定の誤りとして明示する。
    //    （許可リストが空のまま実データを取りに行くと、対象外のアカウントを読んでしまう）
    const liveCreds = !!(base && key);
    if (liveCreds && (!allowList.length || !accountId || !allowList.includes(accountId))) {
      return res.status(200).json({
        ok: true,
        sample: false,                     // ← サンプル表示ではない
        connection: {
          connected: false, mode: 'misconfigured',
          reason: !allowList.length
            ? '広告アカウントの許可リスト（META_AD_ACCOUNT_IDS）が未設定または不正です'
            : 'この広告アカウントは許可リストにありません',
          hint: '実データの取得は行いませんでした。許可リストの設定を確認してください（設定は人が行います）',
        },
        data: {
          ok: false, connected: false, isSample: false,
          error: { code: 'ACCOUNT_NOT_ALLOWED', message: '許可された広告アカウントが設定されていません', retryable: false },
          freshness: { lastSuccessAt: null, lastAttemptAt: null, lagMinutes: null },
        },
        apiVersion: META_API_VERSION,
      });
    }

    // (6) 期間は**広告アカウントのタイムゾーン**基準。未設定なら環境変数、既定は Asia/Tokyo。
    const acctTz = String(req.query.tz || process.env.META_AD_ACCOUNT_TZ || 'Asia/Tokyo').slice(0, 64);
    const period = (req.query.from && req.query.to)
      ? { from: String(req.query.from).slice(0, 10), to: String(req.query.to).slice(0, 10), timeZone: acctTz }
      : lastCompleteDays(7, new Date(), acctTz);
    // ※ 認証情報はヘッダ（X-CC-Owner / X-CC-Token / Authorization）から取る。クエリには載せない。

    // 接続先が無い＝③のAPIがまだ来ていない。**0円を返さず**サンプルで画面を出す。
    if (!base || !key) {
      const state = metaConnectionState(process.env);
      return res.status(200).json({
        ok: true,
        connection: state,
        data: normalizeMetaOverview(META_FIXTURE, { fixture: true }),
        // 画面は必ず「サンプルデータ」と出す
        sample: true,
        apiVersion: META_API_VERSION,
      });
    }

    try {
      const url = `${base}/v1/meta/overview?account_id=${encodeURIComponent(accountId)}`
        + `&from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}`
        + `&tenant_id=${encodeURIComponent(tenantId)}`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      let up;
      try {
        up = await fetch(url, {
          headers: { Authorization: `Bearer ${key}`, 'X-Tenant-Id': tenantId, Accept: 'application/json' },
          signal: ctrl.signal,
        });
      } finally { clearTimeout(t); }
      const raw = await up.json().catch(() => null);
      // (5) HTTP エラーを「接続成功」へ昇格させない。上流が 4xx/5xx なら数字を作らない。
      if (!up.ok) {
        const code = up.status === 401 || up.status === 403 ? 'AUTH_FAILED'
          : up.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR';
        const data = {
          ok: false, connected: true, isSample: metaLooksLikeSample(raw),
          error: { code, message: `接続先が ${up.status} を返しました`, retryable: up.status >= 500 || up.status === 429 },
          freshness: { lastSuccessAt: null, lastAttemptAt: new Date().toISOString(), lagMinutes: null },
        };
        return res.status(200).json({ ok: true, connection: metaConnectionState(process.env, data), data, sample: data.isSample, apiVersion: META_API_VERSION });
      }
      // (2) 要求した tenant / account / 期間と一致しているかを確認する
      const data = normalizeMetaOverview(raw, {
        fixture: false,
        expect: { tenantId, accountId: accountId || undefined, from: period.from, to: period.to },
      });
      // (4) 接続先がモックを返した場合も、外側の sample まで一貫してサンプル表示にする
      return res.status(200).json({
        ok: true,
        connection: metaConnectionState(process.env, data),
        data,
        sample: data.isSample === true,
        apiVersion: META_API_VERSION,
      });
    } catch (e) {
      // 取得できなかった。**数字を作らない**。理由だけ返す。
      const data = {
        ok: false, connected: true, isSample: false,
        error: { code: 'UPSTREAM_ERROR', message: '接続先から取得できませんでした', retryable: true },
        freshness: { lastSuccessAt: null, lastAttemptAt: new Date().toISOString(), lagMinutes: null },
      };
      return res.status(200).json({ ok: true, connection: metaConnectionState(process.env, data), data, sample: false, apiVersion: META_API_VERSION });
    }
  }

  const isCC = ['ccflags', 'approval', 'agentlog', 'audit'].includes(ccType);
  if (isCC) {
    const hasStore = !!(hasKV || hasSB || gas);
    // ストアが無い＝フラグを読めない＝fail closed（全新機能OFF）。既存機能には影響しない。
    if (!hasStore) {
      if (ccType === 'ccflags') return res.status(200).json({ flags: { ...DEFAULT_FLAGS, cc_all: false, configured: false, env: CC_ENV, store: 'none' }, configured: false });
      return res.status(200).json({ items: [], configured: false });
    }

    const body = req.body || {};
    const actorOf = () => {
      const a = (body.actor && typeof body.actor === 'object') ? body.actor : {};
      return {
        id: String(a.id || '').slice(0, 60),
        name: String(a.name || '').slice(0, 80),
        role: String(a.role || '').slice(0, 20),
        source: String(a.source || 'ui').slice(0, 20),
      };
    };
    // 配列キーへの追記。KVならLuaで原子的（同時書き込みで消えない）、それ以外は read-modify-write。
    const appendRow = async (key, row, cap) => {
      if (hasKV) { await kvAppendJson(key, row, cap); return; }
      const cur = (await blobGet(key, hasKV, hasSB, gas)) || [];
      const arr = Array.isArray(cur) ? cur : [];
      arr.push(row);
      await blobSet(key, arr.slice(-cap), hasKV, hasSB, gas);
    };
    const readRows = async (key) => {
      const cur = (await blobGet(key, hasKV, hasSB, gas)) || [];
      return Array.isArray(cur) ? cur : [];
    };
    // ── 認可（段階導入）─────────────────────────────────────────
    // cc_authz='off' のあいだは resolveActor も authzCheck も呼ばない（＝追加コスト0・従来と同一動作）。
    // 'log'/'warn' は判定して記録するだけでブロックしない。'enforce' で初めて 403 を返す。
    const ccActionFor = (type, b) => {
      const act = String((b && b.action) || '');
      if (type === 'ccflags') {
        if (act === 'kill') return 'killswitch.engage';
        if (act === 'set' && b.key === 'cc_all' && b.value === true) return 'killswitch.release';
        if (act === 'set') return 'flag.change';
        return 'flag.read';
      }
      if (type === 'approval') {
        if (act === 'create') return 'approval.create';
        if (act === 'decide') return `approval.${String(b.decision || 'approve')}`;
        if (act === 'repropose') return 'approval.create';
        if (act === 'record') return 'approval.execute';
        return 'approval.read';
      }
      if (type === 'agentlog') return (act === 'start' || act === 'finish') ? 'agentlog.write' : 'agentlog.read';
      if (type === 'audit') return act === 'add' ? 'audit.write' : 'audit.read';
      return 'flag.read';
    };
    // 環境変数＋KV からアカウントを組み立てる（GAS は遅いのでここでは読まない。AUTHORIZATION_PLAN.md §6-2 の既知の穴）
    const ccLoadAccounts = async () => {
      const passwords = parseOwnerPasswords(process.env.SETTLEMENT_OWNER_PASSWORDS);
      const shopsMap = parseOwnerShops(process.env.SETTLEMENT_OWNER_SHOPS);
      if (kvConfigured()) {
        const kvPass = await kvBlobGet(ACCT_PASS_KEY).catch(() => null);
        if (kvPass && typeof kvPass === 'object') for (const [o, pw] of Object.entries(kvPass)) if (pw) passwords[o] = String(pw);
      }
      const metaMap = (await blobGet(ACCTMETA_KEY, hasKV, hasSB, gas).catch(() => null)) || {};
      return { passwords, shopsMap, metaMap };
    };
    const ccSalt = () => process.env.AUTH_SALT || 'naoru-settlement-2026';
    // 本人確認済みの主体を取り出す（cc_authz のモードとは無関係に使える）
    const ccVerify = (action) => resolveActor(req, {
      env: process.env,
      verifySalonOneBearer,
      // 未設定なら空を返す → resolveActor は root 経路を閉じる（fail closed）
      rootToken: () => (process.env.DASHBOARD_PASSWORD ? hashOwnerToken('__root__', process.env.DASHBOARD_PASSWORD, ccSalt()) : ''),
      verifyOwnerToken: (pw, owner, token) => verifyOwnerToken(pw, owner, token, ccSalt()),
      loadAccounts: ccLoadAccounts,
      skipCache: needsReverify(action),   // 取り返しがつかない操作は毎回確かめる
    }).catch(() => null);

    let ccActor = actorOf();          // 既定はクライアント申告（従来どおり）
    const ccFlagsNow = normalizeFlags(await blobGet(ccKey(FLAGS_KEY), hasKV, hasSB, gas).catch(() => null));
    const ccAuthzMode = ccFlagsNow.cc_authz || 'off';

    // ── 常時強制するゲート（cc_authz のモードに依存しない）──────────────────
    // 「制御そのものを変える操作」＝フラグ変更・キルスイッチ・承認の決裁/実行 は、
    // 観測（log）では足りない。ここだけは常にサーバー側で本人確認を要求する。
    // cc_authz は**既存機能の観測**用であり、**新しい制御面の保護**とは別物として扱う。
    const CONTROL_ACTIONS = new Set(['flag.change', 'killswitch.engage', 'killswitch.release',
                                     'approval.approve', 'approval.reject', 'approval.execute']);
    const ccActionNow = ccActionFor(ccType, body);
    // Command Center の書き込みは**すべて**本人確認を要求する。
    // これらは今回追加する新しいAPIで、旧クライアントは存在しない＝互換のために
    // 開けておく理由がない。開けたままだと、誰でも承認提案や監査ログを書き込める。
    // ・書き込み全般 … 本人確認済みであること（AIエージェントのトークンも可）
    // ・制御面(CONTROL_ACTIONS) … さらに管理者(root/本部)であること
    if (req.method === 'POST') {
      const verified = await ccVerify(ccActionNow);
      // ⚠️ 申告値(body.actor)は使わない。名乗るだけで通ってはいけない。
      const isVerified = !!verified && verified.verified === true;
      const isAdmin = isVerified && ['root', 'admin'].includes(verified.role);
      const needsAdmin = CONTROL_ACTIONS.has(ccActionNow);
      const okRole = needsAdmin ? isAdmin : isVerified;
      if (!okRole) {
        try {
          const e = buildAuditEntry({
            action: 'authz_deny', entity: 'authz', entityId: ccActionNow,
            actor: verified || ccActor, source: (verified || ccActor).source,
            note: needsAdmin ? 'control_action_requires_verified_admin' : 'cc_write_requires_verified_actor',
            after: { action: ccActionNow, decision: 'DENY', code: needsAdmin ? 'unverified_admin' : 'unverified', mode: 'always' },
          });
          if (e.ok && hasKV) await kvAppendJson(ccKey(AUDIT_KEY), e.entry, AUDIT_CAP);
        } catch (_) { /* 記録失敗で拒否は覆さない */ }
        return res.status(403).json({ ok: false, error: 'forbidden', code: needsAdmin ? 'unverified_admin' : 'unverified',
          message: needsAdmin ? 'この操作には本人確認済みの管理者権限が必要です' : 'この操作には本人確認が必要です' });
      }
      ccActor = verified;
    }

    if (ccAuthzMode !== 'off') {
      const ccAction = ccActionNow;
      const resolved = await ccVerify(ccAction);
      if (resolved) ccActor = { ...resolved };
      const target = {
        shop: String(body.shop || (body.approval && body.approval.scope && body.approval.scope.shop) || req.query.shop || ''),
        tenantId: String(body.tenantId || req.query.tenantId || '') || undefined,
        risk: body.risk || '', approvalStatus: body.approvalStatus || '',
        recipientCount: Number(body.recipientCount) || 0,
      };
      const decision = authzCan(ccActor, ccAction, target);
      const verdict = authzEnforce(ccAuthzMode, decision);
      res.setHeader('X-CC-Authz', `${verdict.mode}:${verdict.allowed ? 'allow' : (verdict.code || 'deny')}`);
      // log / warn / enforce では **ALLOW も DENY も** 記録する。
      // 「本来どちらになるはずか」を貯めるのが目的で、拒否だけ見ていると
      // 正しく通っていた量が分からず、enforce に上げてよいか判断できない。
      if (ccAuthzMode !== 'off') {
        try {
          const rec = decisionRecord(ccActor, ccAction, target, decision, ccAuthzMode);
          const e = buildAuditEntry({
            action: decision.allow ? 'authz_allow' : 'authz_deny',
            entity: 'authz', entityId: ccAction,
            actor: ccActor, source: ccActor.source,
            note: rec.code || rec.decision,
            after: rec,
          });
          if (e.ok && hasKV) await kvAppendJson(ccKey(AUDIT_KEY), e.entry, AUDIT_CAP);
        } catch (_) { /* 記録失敗で本処理を止めない */ }
      }
      if (verdict.blocked) return res.status(403).json({ ok: false, error: 'forbidden', code: verdict.code, message: verdict.reason });
    }

    // 監査ログは本処理を止めない（失敗しても握りつぶす）。
    const audit = async (input) => {
      try {
        const built = buildAuditEntry({ ...input, actor: ccActor, source: (input && input.source) || ccActor.source });
        if (built.ok) await appendRow(ccKey(AUDIT_KEY), built.entry, AUDIT_CAP);
      } catch (_) { /* 監査の失敗で業務処理を落とさない */ }
    };

    try {
      // ── フィーチャーフラグ ──
      if (ccType === 'ccflags') {
        const cur = normalizeFlags(await blobGet(ccKey(FLAGS_KEY), hasKV, hasSB, gas));
        const storeName = hasKV ? 'kv' : (hasSB ? 'supabase' : 'gas');
        const decorate = (f) => ({ ...f, configured: true, env: CC_ENV, store: storeName, key: ccKey(FLAGS_KEY) });
        if (req.method === 'GET') return res.status(200).json({ flags: decorate(cur), configured: true, env: CC_ENV });
        if (body.action === 'set') {
          const next = applyFlagChange(cur, String(body.key || ''), body.value, actorOf());
          if (!next) return res.status(400).json({ ok: false, error: 'invalid_flag' });
          await blobSet(ccKey(FLAGS_KEY), next, hasKV, hasSB, gas);
          await audit({ action: 'flag_change', entity: 'ccflags', entityId: String(body.key || ''), before: { [body.key]: cur[body.key] }, after: { [body.key]: next[body.key] }, note: `env=${CC_ENV}` });
          return res.status(200).json({ ok: true, flags: decorate(next) });
        }
        if (body.action === 'kill') {                     // キルスイッチ
          const next = killAll(cur, actorOf());
          await blobSet(ccKey(FLAGS_KEY), next, hasKV, hasSB, gas);
          await audit({ action: 'kill_switch', entity: 'ccflags', entityId: 'cc_all', before: { cc_all: cur.cc_all }, after: { cc_all: false }, note: `env=${CC_ENV} ${String(body.note || '').slice(0, 380)}` });
          return res.status(200).json({ ok: true, flags: decorate(next) });
        }
        return res.status(400).json({ ok: false, error: 'invalid ccflags action' });
      }

      // ── 承認センター ──
      if (ccType === 'approval') {
        const rows = await readRows(ccKey(APPROVAL_KEY));
        if (req.method === 'GET') {
          const filter = { status: req.query.status || 'all', kind: req.query.kind || 'all', group: req.query.group || 'all', shop: req.query.shop || '' };
          return res.status(200).json({ items: listApprovals(rows, filter), pending: pendingCount(rows), configured: true });
        }
        if (body.action === 'create') {
          const built = buildApproval(body.approval || {});
          if (!built.ok) return res.status(400).json({ ok: false, error: built.error });
          await appendRow(ccKey(APPROVAL_KEY), built.approval, APPROVAL_CAP);
          await audit({ action: 'create', entity: 'approval', entityId: built.approval.id, after: { kind: built.approval.kind, title: built.approval.title, risk: built.approval.risk }, source: 'agent' });
          return res.status(200).json({ ok: true, approval: built.approval });
        }
        // 以降は既存行の更新。楽観ロック: クライアントが見ていた updatedAt と一致しなければ 409。
        const id = String(body.id || '');
        const idx = rows.findIndex(r => r && r.id === id);
        if (idx < 0) return res.status(404).json({ ok: false, error: 'not_found' });
        const before = rows[idx];
        if (body.expectedUpdatedAt != null && Number(body.expectedUpdatedAt) !== Number(before.updatedAt)) {
          return res.status(409).json({ ok: false, error: 'stale', current: before });
        }
        let out = null;
        if (body.action === 'decide') {
          out = decideApproval(before, String(body.decision || ''), actorOf(), { note: body.note, seenHash: body.seenHash });
        } else if (body.action === 'repropose') {
          out = reproposeApproval(before, body.patch || {}, actorOf());
        } else if (body.action === 'record') {
          out = recordExecution(before, body.result || {});
        } else {
          return res.status(400).json({ ok: false, error: 'invalid approval action' });
        }
        // decide() は期限切れ時に「期限切れへ倒した行」を返すので、それは保存する。
        const toSave = out.ok ? out.approval : (out.approval || null);
        if (toSave) {
          const next = rows.slice();
          next[idx] = toSave;
          await blobSet(ccKey(APPROVAL_KEY), next, hasKV, hasSB, gas);
        }
        if (!out.ok) return res.status(409).json({ ok: false, error: out.error, approval: toSave || before });
        await audit({ action: body.action === 'decide' ? String(body.decision || 'decide') : String(body.action), entity: 'approval', entityId: id, before: { status: before.status }, after: { status: out.approval.status }, note: String(body.note || '').slice(0, 400) });
        return res.status(200).json({ ok: true, approval: out.approval });
      }

      // ── AI Agent Activity ──
      if (ccType === 'agentlog') {
        const rows = await readRows(ccKey(AGENTLOG_KEY));
        if (req.method === 'GET') {
          const since = Number(req.query.since) || 0;
          const filter = { agentName: req.query.agentName || 'all', status: req.query.status || 'all', action: req.query.action || 'all', source: req.query.source || 'all', shop: req.query.shop || '', since };
          const dayAgo = Date.now() - 24 * 3600 * 1000;
          return res.status(200).json({
            items: listRuns(rows, filter),
            summary: summarizeRuns(rows, since || dayAgo),
            anomalies: runAnomalies(rows, { failStreak: 3, dailyCostLimitJpy: Number(req.query.costLimit) || 0 }),
            configured: true,
          });
        }
        if (body.action === 'start') {
          const built = startRun(body.run || {});
          if (!built.ok) return res.status(400).json({ ok: false, error: built.error });
          await appendRow(ccKey(AGENTLOG_KEY), built.run, AGENTLOG_CAP);
          return res.status(200).json({ ok: true, run: built.run });
        }
        if (body.action === 'finish') {
          const id = String(body.id || '');
          const idx = rows.findIndex(r => r && r.id === id);
          if (idx < 0) return res.status(404).json({ ok: false, error: 'not_found' });
          const out = finishRun(rows[idx], body.outcome || {});
          if (!out.ok) return res.status(409).json({ ok: false, error: out.error });
          const next = rows.slice();
          next[idx] = out.run;
          await blobSet(ccKey(AGENTLOG_KEY), next, hasKV, hasSB, gas);
          return res.status(200).json({ ok: true, run: out.run });
        }
        return res.status(400).json({ ok: false, error: 'invalid agentlog action' });
      }

      // ── 監査ログ ──
      if (ccType === 'audit') {
        const rows = await readRows(ccKey(AUDIT_KEY));
        if (req.method === 'GET') {
          const filter = { entity: req.query.entity || 'all', entityId: req.query.entityId || '', actorId: req.query.actorId || '', action: req.query.action || 'all', since: Number(req.query.since) || 0 };
          return res.status(200).json({ items: listAuditEntries(rows, filter).slice(0, 500), configured: true });
        }
        if (body.action === 'add') {
          const built = buildAuditEntry({ ...(body.entry || {}), actor: actorOf() });
          if (!built.ok) return res.status(400).json({ ok: false, error: built.error });
          await appendRow(ccKey(AUDIT_KEY), built.entry, AUDIT_CAP);
          return res.status(200).json({ ok: true, entry: built.entry });
        }
        return res.status(400).json({ ok: false, error: 'invalid audit action' });
      }
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
    }
  }

  // ── 手当（領収書）ストア: ?type=allowance / body.type==='allowance' ──
  const isAllowance = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'allowance';
  if (isAllowance) {
    if (!hasKV && !hasSB && !gas) return res.status(200).json({ submissions: [], productivity: {}, configured: false });
    try {
      // 旧blob（Rollback用の写し）／提出の追記ログ／生産性の別キー の3つを読む。
      const [curRaw, logRaw, prodRaw] = await Promise.all([
        blobGet(ALLOWANCE_KEY, hasKV, hasSB, gas).catch(() => null),
        blobGet(ALLOWANCE_LOG_KEY, hasKV, hasSB, gas).catch(() => null),
        blobGet(ALLOWANCE_PROD_KEY, hasKV, hasSB, gas).catch(() => null),
      ]);
      const cur = curRaw || {};
      const legacySubs = Array.isArray(cur.submissions) ? cur.submissions : [];
      const log = Array.isArray(logRaw) ? logRaw : [];
      const submissions = mergeSubmissions(legacySubs, log);
      const productivity = mergeProductivity(cur.productivity, prodRaw);

      if (req.method === 'GET') {
        return res.status(200).json({ submissions, productivity, configured: true });
      }
      const body = req.body || {};
      const action = body.action;

      // 追記専用。既存の要素を読んで書き直さないので、同時提出で互いを踏まない。
      // 戻り値 { ok, atomic } … ok=false は「保存できなかった」＝呼び出し側がエラーを返す。
      const hasEntry = (arr, e) => Array.isArray(arr) && arr.some(x => x && x.id === e.id && x.op === e.op && x.at === e.at);
      const appendLog = async (entry) => {
        if (hasKV) {                                          // KV: Lua で原子的に追記（本番はこちら）
          await kvAppendJson(ALLOWANCE_LOG_KEY, entry, ALLOWANCE_LOG_CAP);
          return { ok: true, atomic: true };
        }
        // ⚠️ Supabase / GAS は原子的な追記ができない。読んで書くだけだと同時提出で消える。
        //    そこで「書く→読み直して入っているか確認する」を最大3回繰り返す。
        //    それでも入らなければ **黙って成功にせず** 失敗を返す（領収書が消えるより、
        //    利用者に「保存できませんでした」と出すほうが良い）。
        for (let i = 0; i < 3; i++) {
          const fresh = await blobGet(ALLOWANCE_LOG_KEY, hasKV, hasSB, gas).catch(() => null);
          const arr = Array.isArray(fresh) ? fresh : [];
          if (hasEntry(arr, entry)) return { ok: true, atomic: false };      // 既に入っていた
          await blobSet(ALLOWANCE_LOG_KEY, [...arr, entry].slice(-ALLOWANCE_LOG_CAP), hasKV, hasSB, gas);
          const after = await blobGet(ALLOWANCE_LOG_KEY, hasKV, hasSB, gas).catch(() => null);
          if (hasEntry(after, entry)) return { ok: true, atomic: false };    // 書けたことを確認
          await new Promise(r => setTimeout(r, 60 * (i + 1)));               // 少し待ってやり直す
        }
        return { ok: false, atomic: false };
      };
      // 旧blobへの写し。Rollback しても提出が残るように保つ。
      // ⚠️ 生産性(productivity)はここでは書かない。旧blobの値をそのまま保持する
      //    （返金明細書の表示のたびに走る recordProductivity が提出を巻き込んでいたのが元の不具合）。
      const mirrorLegacy = async (nextSubs) => {
        try { await blobSet(ALLOWANCE_KEY, { submissions: nextSubs, productivity: cur.productivity || {} }, hasKV, hasSB, gas); }
        catch (_) { /* 写しの失敗はログが正なので致命的ではない */ }
      };

      if (action === 'submit' && body.submission && body.submission.id) {
        const s = body.submission;
        if (isDuplicateSubmit(log, s)) {                    // 同じ内容の再送＝何もしない
          return res.status(200).json({ ok: true, id: s.id, duplicate: true });
        }
        const entry = makeAllowanceEntry('submit', s);
        if (!entry) return res.status(400).json({ ok: false, error: 'invalid_submission' });
        const w = await appendLog(entry);                    // ← 正。これが通れば提出は失われない
        if (!w.ok) return res.status(503).json({ ok: false, error: 'not_durable', message: '保存できませんでした。もう一度お試しください。' });
        await mirrorLegacy(mergeSubmissions(legacySubs, [...log, entry]));
        return res.status(200).json({ ok: true, id: s.id, atomic: w.atomic });
      }
      if (action === 'delete' && body.id) {
        const entry = makeAllowanceEntry('delete', { id: body.id });
        if (!entry) return res.status(400).json({ ok: false, error: 'invalid_id' });
        const w = await appendLog(entry);
        if (!w.ok) return res.status(503).json({ ok: false, error: 'not_durable', message: '取り消しを保存できませんでした。もう一度お試しください。' });
        await mirrorLegacy(mergeSubmissions(legacySubs, [...log, entry]));
        return res.status(200).json({ ok: true });
      }
      if (action === 'recordProductivity' && body.staffId && body.month) {
        // 生産性は別キーへ。**提出データには一切触れない**。
        const next = bumpProductivity(prodRaw, body.staffId, body.month, body.gross);
        await blobSet(ALLOWANCE_PROD_KEY, next, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ ok: false, error: 'invalid allowance action' });
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
    }
  }

  // ── アカウント拡張情報（role/staffId/staffName）ストア: ?type=accountmeta ──
  // GAS「オーナー設定」の列に依存せず、KV/Supabase/GASのblobで role/staff を保持する。
  const isAcctMeta = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'accountmeta';
  if (isAcctMeta) {
    if (!hasKV && !hasSB && !gas) return res.status(200).json({ meta: {}, configured: false });
    try {
      const cur = (await blobGet(ACCTMETA_KEY, hasKV, hasSB, gas)) || {};
      const meta = (cur && typeof cur === 'object') ? cur : {};
      if (req.method === 'GET') return res.status(200).json({ meta, configured: true });
      const body = req.body || {};
      if (body.action === 'set' && body.owner) {
        const next = { ...meta };
        next[String(body.owner)] = { role: String(body.role || 'owner'), staffId: String(body.staffId || ''), staffName: String(body.staffName || '') };
        await blobSet(ACCTMETA_KEY, next, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      if (body.action === 'delete' && body.owner) {
        const next = { ...meta }; delete next[String(body.owner)];
        await blobSet(ACCTMETA_KEY, next, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ ok: false, error: 'invalid accountmeta action' });
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
    }
  }

  // ── 全体管理シート セラピスト数の手動上書き: ?type=zktherapist ──
  // { 'shopName|YYYY-MM': count } を全端末で共有。SalonOne売上分析の店舗別セラピスト数もこの値を優先。
  const isZkTher = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'zktherapist';
  if (isZkTher) {
    if (!hasKV && !hasSB && !gas) return res.status(200).json({ overrides: {}, configured: false });
    try {
      const cur = (await blobGet(ZKTHERAPIST_KEY, hasKV, hasSB, gas)) || {};
      const overrides = (cur && typeof cur === 'object') ? cur : {};
      if (req.method === 'GET') return res.status(200).json({ overrides, configured: true });
      const body = req.body || {};
      if (body.action === 'set' && body.key) {
        const next = { ...overrides };
        if (body.value == null || body.value === '') delete next[String(body.key)];
        else next[String(body.key)] = Number(body.value) || 0;
        await blobSet(ZKTHERAPIST_KEY, next, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ ok: false, error: 'invalid zktherapist action' });
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
    }
  }

  // ── 媒体別広告費ストア（全社共有・AIアシスタントも参照）: ?type=adspend ──
  // 従来は端末のlocalStorage(so_adspend_v1)のみ＝端末間で共有されず、サーバー側(AIボット)から読めなかった。
  // これを共有ストアへ移し、広告費/CPAを全社・AIで共通に扱えるようにする。
  const isAdSpend = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'adspend';
  if (isAdSpend) {
    if (!hasKV && !hasSB && !gas) return res.status(200).json({ spend: {}, configured: false });
    try {
      const cur = (await blobGet(ADSPEND_KEY, hasKV, hasSB, gas)) || {};
      const spend = (cur.spend && typeof cur.spend === 'object') ? cur.spend : {};
      if (req.method === 'GET') return res.status(200).json({ spend, configured: true });
      const body = req.body || {};
      // 1媒体だけ更新（rangeKey=対象期間キー・media=媒体名・yen=金額文字列/数値）
      // body.shop があれば店舗別（spend[rk].__shops__[shop][media]）、無ければ全社合計（spend[rk][media]）。
      if (body.action === 'set' && body.rangeKey && body.media != null) {
        const rk = String(body.rangeKey).slice(0, 40);
        const md = String(body.media).slice(0, 60);
        const shop = body.shop != null ? String(body.shop).slice(0, 60) : '';
        const yenRaw = String(body.yen == null ? '' : body.yen);
        const yenNum = Number(yenRaw.replace(/[^\d.-]/g, ''));
        const del = !Number.isFinite(yenNum) || yenRaw.trim() === '';
        const bucket = { ...(spend[rk] || {}) };
        if (shop) {
          const shops = { ...(bucket.__shops__ || {}) };
          const srow = { ...(shops[shop] || {}) };
          if (del) delete srow[md]; else srow[md] = yenNum;
          shops[shop] = srow;
          bucket.__shops__ = shops;
        } else {
          if (del) delete bucket[md]; else bucket[md] = yenNum;
        }
        const nextSpend = { ...spend, [rk]: bucket };
        await blobSet(ADSPEND_KEY, { spend: nextSpend }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, spend: nextSpend });
      }
      // まとめて上書き（移行・一括保存用）: body.spend 全体を置換
      if (body.action === 'replace' && body.spend && typeof body.spend === 'object') {
        await blobSet(ADSPEND_KEY, { spend: body.spend }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, spend: body.spend });
      }
      return res.status(400).json({ ok: false, error: 'invalid adspend action' });
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
    }
  }

  // ── マーケ集計 手動除外（テスト予約を全マーケ指標から除外・全社共有）: ?type=acqexclude ──
  const isAcqExclude = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'acqexclude';
  if (isAcqExclude) {
    if (!hasKV && !hasSB && !gas) return res.status(200).json({ ids: {}, configured: false });
    try {
      const cur = (await blobGet(ACQEXCLUDE_KEY, hasKV, hasSB, gas)) || {};
      const ids = (cur.ids && typeof cur.ids === 'object') ? cur.ids : {};
      if (req.method === 'GET') return res.status(200).json({ ids, configured: true });
      const body = req.body || {};
      if (body.action === 'add' && body.id != null) {
        const id = String(body.id).slice(0, 80);
        const next = { ...ids, [id]: { by: String(body.by || '').slice(0, 60), name: String(body.name || '').slice(0, 80), shop: String(body.shop || '').slice(0, 60), at: Date.now() } };
        await blobSet(ACQEXCLUDE_KEY, { ids: next }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, ids: next });
      }
      if (body.action === 'remove' && body.id != null) {
        const id = String(body.id).slice(0, 80);
        const next = { ...ids }; delete next[id];
        await blobSet(ACQEXCLUDE_KEY, { ids: next }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, ids: next });
      }
      return res.status(400).json({ ok: false, error: 'invalid acqexclude action' });
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
    }
  }

  // ── プレゼンス（今アクセス中のアカウント・スプレッドシート風の上部バー表示）: ?type=presence ──
  //   信頼モデルは chat/thanksgift と同じ（サーバー認証なし・UIレベル社内利用前提）。
  //   users[id] = { name, role, page, at }。at は最終ハートビート(ms)。GET/POST 双方で TTL 超過分を prune。
  const isPresence = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'presence';
  if (isPresence) {
    const PRESENCE_TTL = 75 * 1000; // 75秒ハートビートが途切れたら離脱扱い（クライアントは30秒間隔で送信）
    if (!hasKV && !hasSB && !gas) return res.status(200).json({ users: [], configured: false });
    try {
      const cur = (await blobGet(PRESENCE_KEY, hasKV, hasSB, gas)) || {};
      const users = (cur.users && typeof cur.users === 'object') ? cur.users : {};
      const now = Date.now();
      const prune = (map) => { const out = {}; for (const k in map) { const u = map[k]; if (u && typeof u === 'object' && (now - (Number(u.at) || 0)) < PRESENCE_TTL) out[k] = u; } return out; };
      const toList = (map) => Object.entries(map).map(([id, u]) => ({ id, name: u.name || '', role: u.role || '', page: u.page || '', at: Number(u.at) || 0 })).sort((a, b) => b.at - a.at);
      if (req.method === 'GET') {
        return res.status(200).json({ users: toList(prune(users)), configured: true });
      }
      const body = req.body || {};
      const id = String(body.id || '').slice(0, 80);
      if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
      if (body.action === 'leave') {
        const next = prune(users); delete next[id];
        await blobSet(PRESENCE_KEY, { users: next }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, users: toList(next) });
      }
      // 既定=beat（ハートビート）: 自分のエントリを upsert し、TTL超過分を掃除
      const next = prune(users);
      next[id] = { name: String(body.name || '').slice(0, 60), role: String(body.role || '').slice(0, 20), page: String(body.page || '').slice(0, 40), at: now };
      await blobSet(PRESENCE_KEY, { users: next }, hasKV, hasSB, gas);
      return res.status(200).json({ ok: true, users: toList(next) });
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, users: [], error: String((err && err.message) || err) });
    }
  }

  // ── 店舗別売上の共有キャッシュ（確定した過去月は全社で1回だけ集計・全デバイス即表示）: ?type=sbcache ──
  // pkey='YYYY-MM-DD_YYYY-MM-DD'（from_確定to）。確定月のみ保存し、以後は誰が開いても再取得不要にする。
  const isSbCache = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'sbcache';
  if (isSbCache) {
    const hasStore = !!(hasKV || hasSB || gas);
    const pkeyOf = (v) => { const s = String(v || ''); return /^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; };
    if (!hasStore) return res.status(200).json({ shops: null, configured: false });
    try {
      if (req.method === 'GET') {
        const pkey = pkeyOf(req.query.pkey);
        if (!pkey) return res.status(200).json({ shops: null, configured: true });
        const cur = (await blobGet(`naoru:sb:${pkey}`, hasKV, hasSB, gas)) || null;
        return res.status(200).json({ shops: (cur && cur.shops) || null, ts: (cur && cur.ts) || 0, configured: true });
      }
      const body = req.body || {};
      if (body.action === 'save') {
        const pkey = pkeyOf(body.pkey);
        if (!pkey) return res.status(400).json({ ok: false, error: 'invalid_pkey' });
        const shops = (body.shops && typeof body.shops === 'object' && !Array.isArray(body.shops)) ? body.shops : null;
        if (!shops || Object.keys(shops).length > 300) return res.status(400).json({ ok: false, error: 'invalid_shops' });
        await blobSet(`naoru:sb:${pkey}`, { shops, ts: Date.now() }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ ok: false, error: 'invalid sbcache action' });
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
    }
  }

  // ── MEO（Googleマップ最適化）: ?type=meo ──
  // 各店の口コミ数・評価の履歴を保存し、増減トレンド・要対応アラート・口コミ依頼リンクを返す。
  // scanone=1店をPlacesで取得しスナップショット保存（フロントが全店ぶんループ）。GOOGLE_PLACES_API_KEY 未設定でも履歴表示は可能。
  const isMeo = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'meo';
  if (isMeo) {
    const GKEY = process.env.GOOGLE_PLACES_API_KEY || '';
    const googleEnabled = !!GKEY;
    const hasStore = !!(hasKV || hasSB || gas);
    if (!hasStore) return res.status(200).json({ shops: {}, googleEnabled, configured: false });
    const loadAll = async () => { const c = (await blobGet(MEO_KEY, hasKV, hasSB, gas)) || {}; return (c.shops && typeof c.shops === 'object') ? c : { shops: {} }; };
    // 1店の履歴＋最新から、表示用（増減・アラート・スコア・口コミ依頼URL）を組み立てる
    const decorate = (name, rec) => {
      const history = Array.isArray(rec.history) ? rec.history : [];
      const latest = (rec.latest && typeof rec.latest === 'object') ? rec.latest : {};
      const deltas = computeDeltas(history);
      // 「今月獲得口コミ数」の即時推定（スナップショット履歴が1点だけの初回でも出す）。
      //   旧API(Place Details)で取れた"新着順"口コミ(reviewsNewest)を優先。無ければ New APIの関連度順レビューで代替。
      //   publishTime から当月分をカウント＝下限値（5件返却の頭打ちあり）。スナップショット純増が測れればそれを正。
      const revForMonth = (latest && Array.isArray(latest.reviewsNewest) && latest.reviewsNewest.length)
        ? latest.reviewsNewest
        : ((latest && Array.isArray(latest.reviews)) ? latest.reviews : []);
      const seen = reviewsInMonth(revForMonth);
      const monthReviews = (typeof deltas.newThisMonth === 'number')
        ? { value: deltas.newThisMonth, source: 'snapshot', atLeast: false }   // 履歴からの純増（正確）
        : { value: seen.count, source: 'recent', atLeast: !!seen.capped };     // 直近レビューからの下限推定
      return {
        name, placeId: rec.placeId || '', query: rec.query || '', updatedAt: rec.updatedAt || '',
        latest, history, deltas,
        reviewsSeenThisMonth: seen.count, reviewsSeenCapped: seen.capped, monthReviews,
        flags: meoFlags(latest, deltas), score: meoScore(latest),
        reviewUrl: reviewRequestUrl(rec.placeId || (latest && latest.placeId) || ''),
        mapsUri: (latest && latest.mapsUri) || '',
      };
    };
    // 1店をPlacesでスキャンして parse 済み place を返す（POST scanone と 日次cron で共用）。
    //   withLegacy=true のときだけ旧API(新着口コミ)も試す（cronはスナップショット目的なので不要＝高速化）。
    const scanShop = async (query, { withLegacy = true } = {}) => {
      const def = buildSearchRequest(String(query || '').slice(0, 200), { detailed: true });
      if (!def) return { error: 'invalid_query' };
      const r = await fetch(def.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GKEY, 'X-Goog-FieldMask': def.fieldMask }, body: JSON.stringify(def.body) });
      if (!r.ok) return { error: `places_http_${r.status}` };
      const place = parsePlacesResponse(await r.json().catch(() => null));
      if (!place) return { error: 'no_result' };
      if (withLegacy) {
        try {
          const legReq = buildLegacyReviewsRequest(place.placeId, { sort: 'newest' });
          if (legReq) {
            const lj = await (await fetch(`${legReq.url}&key=${encodeURIComponent(GKEY)}`)).json().catch(() => null);
            const newest = parseLegacyReviews(lj);
            if (newest.length) place.reviewsNewest = newest;
            else if (lj && lj.status && lj.status !== 'OK') place.legacyReviewsStatus = String(lj.status);
          }
        } catch (e) { /* 旧API不可でもNew APIの口コミで継続 */ }
      }
      return { place };
    };
    try {
      if (req.method === 'GET') {
        // ── 日次自動スキャン（Vercel Cron）: 全店を1日1回スキャンしてスナップショットを蓄積 ──
        //   これで翌月以降は「今月の獲得口コミ数」がスナップショット純増から手動操作なしで正確に出る。
        if (String(req.query.action || '') === 'cronscan') {
          const secret = process.env.CRON_SECRET || '';
          if (secret && String(req.headers.authorization || '') !== `Bearer ${secret}`) return res.status(401).json({ ok: false, error: 'unauthorized' });
          if (!GKEY) return res.status(200).json({ ok: false, error: 'google_not_configured' });
          const started = Date.now(); const BUDGET_MS = 55000; const today = jstYmd();
          const cur = await loadAll();
          const shops = { ...(cur.shops || {}) };
          // 今日未スキャンを優先（最終スナップショット日が古い順）
          const entries = Object.entries(shops).filter(([n, rec]) => rec && (rec.query || n))
            .sort((a, b) => { const da = (a[1].history || []).slice(-1)[0]?.date || ''; const db = (b[1].history || []).slice(-1)[0]?.date || ''; return String(da).localeCompare(String(db)); });
          let scanned = 0, failed = 0, skipped = 0, idx = 0;
          const worker = async () => {
            while (idx < entries.length) {
              if (Date.now() - started > BUDGET_MS) return;
              const [nm, rec] = entries[idx++];
              if (((rec.history || []).slice(-1)[0]?.date) === today) { skipped++; continue; } // 今日は済み
              try {
                const { place, error } = await scanShop(rec.query || nm, { withLegacy: false });
                if (error || !place) { failed++; continue; }
                rec.history = recordSnapshot(rec.history, { date: today, count: place.userRatingCount, rating: place.rating });
                rec.latest = place; rec.placeId = place.placeId || rec.placeId || ''; rec.updatedAt = new Date().toISOString();
                scanned++;
              } catch (e) { failed++; }
            }
          };
          await Promise.all(Array.from({ length: Math.min(5, entries.length || 1) }, worker));
          await blobSet(MEO_KEY, { shops }, hasKV, hasSB, gas);
          return res.status(200).json({ ok: true, scanned, failed, skipped, total: entries.length, ms: Date.now() - started });
        }
        const cur = await loadAll();
        const shops = {};
        for (const [name, rec] of Object.entries(cur.shops || {})) shops[name] = decorate(name, rec || {});
        return res.status(200).json({ shops, googleEnabled, configured: true });
      }
      const body = req.body || {};
      const action = String(body.action || '');
      const name = String(body.name || '').slice(0, 80);
      if (action === 'setquery' && name) {
        const cur = await loadAll();
        const shops = { ...(cur.shops || {}) };
        shops[name] = { ...(shops[name] || {}), query: String(body.query || '').slice(0, 200) };
        await blobSet(MEO_KEY, { shops }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, shop: decorate(name, shops[name]) });
      }
      if (action === 'scanone' && name) {
        if (!GKEY) return res.status(200).json({ ok: false, error: 'google_not_configured', googleEnabled: false });
        const query = String(body.query || name).slice(0, 200);
        let place = null;
        try {
          const r = await scanShop(query, { withLegacy: true }); // 手動スキャンは旧API(新着口コミ)も試す
          if (r.error) return res.status(200).json({ ok: false, error: r.error });
          place = r.place;
        } catch (e) { return res.status(200).json({ ok: false, error: String((e && e.message) || e) }); }
        if (!place) return res.status(200).json({ ok: false, error: 'no_result' });
        const cur = await loadAll();
        const shops = { ...(cur.shops || {}) };
        const prev = shops[name] || {};
        const history = recordSnapshot(prev.history, { date: jstYmd(), count: place.userRatingCount, rating: place.rating });
        shops[name] = { history, latest: place, placeId: place.placeId || prev.placeId || '', query, updatedAt: new Date().toISOString() };
        await blobSet(MEO_KEY, { shops }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, shop: decorate(name, shops[name]) });
      }
      return res.status(400).json({ ok: false, error: 'invalid meo action' });
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
    }
  }

  // ── 施策リンク（強制リンク）背景同期: ?type=soflmap ────────────────────────
  //   appointments を updated_at 昇順カーソルで差分同期し「顧客→施策リンクID」対応表を作る。
  //   GET                 → { cust:{customer_id:forced_link_id}, caughtUp, count, updatedAt, configured }
  //   GET  action=sync    → 1回分ページング（手動・初回バックフィルの継続）
  //   GET  action=cronsync→ 日次Cron（同上・CRON_SECRET任意）
  const isSofl = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'soflmap';
  if (isSofl) {
    const hasStore = !!(hasKV || hasSB || gas);
    if (!hasStore) return res.status(200).json({ cust: {}, configured: false });
    const SO_KEY = process.env.SALONONE_API_KEY || '';
    const SO_BASE = (process.env.SALONONE_API_BASE || 'https://salonone.net/api/analytics/v1').replace(/\/+$/, '');
    const loadState = async () => {
      const c = (await blobGet(SOFL_KEY, hasKV, hasSB, gas)) || {};
      return { cust: (c.cust && typeof c.cust === 'object') ? c.cust : {}, dismissed: (c.dismissed && typeof c.dismissed === 'object') ? c.dismissed : {}, cursor: c.cursor || '', caughtUp: !!c.caughtUp, updatedAt: c.updatedAt || '', stats: c.stats || {} };
    };
    // appointments を1ページ取得（キーのみ＝ブランド全店。ログイン必須解除キー前提）
    const fetchAppts = async (cursor) => {
      const u = new URL(SO_BASE + '/appointments');
      u.searchParams.set('limit', '1000');
      if (cursor) u.searchParams.set('cursor', cursor);
      const r = await fetch(u.toString(), { headers: { 'X-SalonOne-Api-Key': SO_KEY, 'Accept': 'application/json' } });
      if (!r.ok) return { error: `so_http_${r.status}` };
      const j = await r.json().catch(() => null);
      if (!j) return { error: 'parse_error' };
      const rows = Array.isArray(j.data) ? j.data : [];
      const meta = j.meta || {};
      return { rows, hasMore: !!meta.has_more, nextCursor: meta.next_cursor || '' };
    };
    // 差分同期を1回実行（時間バジェット内で複数ページ）。resumable: 最後の非nullカーソルを保存。
    const runSync = async (reset = false) => {
      if (!SO_KEY) return { ok: false, error: 'salonone_not_configured' };
      const started = Date.now(); const BUDGET_MS = 45000; const MAX_PAGES = 40;
      const st = await loadState();
      let cursor = reset ? '' : (st.cursor || '');   // reset=先頭から全再スキャン（dismissed遡及収集用）
      let cust = st.cust;
      let dismissed = st.dismissed;
      let pages = 0, fetched = 0, mapped0 = Object.keys(cust).length, hadError = null;
      let reachedEnd = false;
      while (pages < MAX_PAGES) {
        if (Date.now() - started > BUDGET_MS) break;
        const p = await fetchAppts(cursor);
        if (p.error) { hadError = p.error; break; }
        pages++; fetched += p.rows.length;
        mergeAppointments(cust, p.rows);
        mergeDismissed(dismissed, p.rows);          // 予約取り消し（dismissed_at）の顧客IDを収集
        if (p.nextCursor) cursor = p.nextCursor;   // 非nullのみ前進（末尾でnullでも位置を失わない）
        if (!p.hasMore) { reachedEnd = true; break; } // 末尾＝追いついた（cursorは最後の非nullを保持）
      }
      const stats = { pages, fetched, mapped: Object.keys(cust).length, dismissed: Object.keys(dismissed).length, added: Object.keys(cust).length - mapped0, ms: Date.now() - started, error: hadError || undefined, at: new Date().toISOString() };
      await blobSet(SOFL_KEY, { cust, dismissed, cursor, caughtUp: reachedEnd ? true : st.caughtUp, updatedAt: new Date().toISOString(), stats }, hasKV, hasSB, gas);
      return { ok: !hadError, reachedEnd, stats };
    };
    try {
      if (req.method === 'GET') {
        const action = String(req.query.action || '');
        if (action === 'sync' || action === 'cronsync') {
          if (action === 'cronsync') {
            const secret = process.env.CRON_SECRET || '';
            if (secret && String(req.headers.authorization || '') !== `Bearer ${secret}`) return res.status(401).json({ ok: false, error: 'unauthorized' });
          }
          const r = await runSync(String(req.query.reset || '') === '1');
          return res.status(200).json({ configured: true, ...r });
        }
        const st = await loadState();
        return res.status(200).json({ cust: soflFlatten(st.cust), dismissed: st.dismissed, caughtUp: st.caughtUp, count: Object.keys(st.cust).length, dismissedCount: Object.keys(st.dismissed).length, updatedAt: st.updatedAt, stats: st.stats, configured: true });
      }
      // POST でも sync を許可（手動トリガ用）
      const body = req.body || {};
      if (String(body.action || '') === 'sync') { const r = await runSync(); return res.status(200).json({ configured: true, ...r }); }
      return res.status(400).json({ ok: false, error: 'invalid soflmap action' });
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
    }
  }

  // ── 社内FAQストア（AIアシスタントの回答根拠・本部が育てる）: ?type=faq ──
  const isFaq = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'faq';
  if (isFaq) {
    if (!hasKV && !hasSB && !gas) return res.status(200).json({ faqs: [], configured: false });
    try {
      const cur = (await blobGet(FAQ_KEY, hasKV, hasSB, gas)) || {};
      const faqs = Array.isArray(cur.faqs) ? cur.faqs : [];
      if (req.method === 'GET') return res.status(200).json({ faqs, configured: true });
      const body = req.body || {};
      const clean = (f) => ({
        id: String(f.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6))),
        q: String(f.q || '').slice(0, 500),
        a: String(f.a || '').slice(0, 4000),
        tags: Array.isArray(f.tags) ? f.tags.map(t => String(t).slice(0, 30)).slice(0, 12) : [],
        shopScope: String(f.shopScope || '').slice(0, 60), // '' = 全社共通 / 店舗名 = その店舗限定
        updatedAt: new Date().toISOString(),
        updatedBy: String(f.updatedBy || '').slice(0, 60),
      });
      if ((body.action === 'add' || body.action === 'update') && body.faq) {
        const rec = clean(body.faq);
        const exists = faqs.some(x => x && x.id === rec.id);
        const next = exists ? faqs.map(x => x && x.id === rec.id ? rec : x) : faqs.concat(rec);
        await blobSet(FAQ_KEY, { faqs: next.slice(0, 2000) }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, faq: rec });
      }
      if (body.action === 'delete' && body.id) {
        const next = faqs.filter(x => x && x.id !== String(body.id));
        await blobSet(FAQ_KEY, { faqs: next }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      // 一括投入（シード/移行）: body.faqs 配列を追記マージ（id一致は置換）
      if (body.action === 'bulk' && Array.isArray(body.faqs)) {
        const map = new Map(faqs.map(x => [String(x.id), x]));
        for (const f of body.faqs) { const rec = clean(f); map.set(rec.id, rec); }
        const next = [...map.values()].slice(0, 2000);
        await blobSet(FAQ_KEY, { faqs: next }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, count: next.length });
      }
      return res.status(400).json({ ok: false, error: 'invalid faq action' });
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
    }
  }

  // ── ナレッジ資料（長文: 文字起こし/シート・スライドの中身/マニュアル）: ?type=knowledge ──
  const isKnow = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'knowledge';
  if (isKnow) {
    if (!hasKV && !hasSB && !gas) return res.status(200).json({ docs: [], configured: false });
    try {
      const cur = (await blobGet(KNOWLEDGE_KEY, hasKV, hasSB, gas)) || {};
      const docs = Array.isArray(cur.docs) ? cur.docs : [];
      if (req.method === 'GET') return res.status(200).json({ docs, configured: true });
      const body = req.body || {};
      const clean = (d) => ({
        id: String(d.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6))),
        title: String(d.title || '').slice(0, 200),
        body: String(d.body || '').slice(0, 40000),          // 長文（1資料上限4万字）
        shopScope: String(d.shopScope || '').slice(0, 60),   // '' = 全社共通
        source: String(d.source || '').slice(0, 200),        // 例: Googleスライドのタイトル/URL、議事録2026-09 等
        updatedAt: new Date().toISOString(),
        updatedBy: String(d.updatedBy || '').slice(0, 60),
      });
      if ((body.action === 'add' || body.action === 'update') && body.doc) {
        const rec = clean(body.doc);
        const exists = docs.some(x => x && x.id === rec.id);
        const next = exists ? docs.map(x => x && x.id === rec.id ? rec : x) : docs.concat(rec);
        await blobSet(KNOWLEDGE_KEY, { docs: next.slice(0, 1000) }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, doc: rec });
      }
      if (body.action === 'delete' && body.id) {
        const next = docs.filter(x => x && x.id !== String(body.id));
        await blobSet(KNOWLEDGE_KEY, { docs: next }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      if (body.action === 'bulk' && Array.isArray(body.docs)) {
        const map = new Map(docs.map(x => [String(x.id), x]));
        for (const d of body.docs) { const rec = clean(d); map.set(rec.id, rec); }
        const next = [...map.values()].slice(0, 1000);
        await blobSet(KNOWLEDGE_KEY, { docs: next }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, count: next.length });
      }
      return res.status(400).json({ ok: false, error: 'invalid knowledge action' });
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
    }
  }

  // ── 本部チャット回答のナレッジ候補（承認でFAQ化）: ?type=knowcand ──
  const isKnowCand = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'knowcand';
  if (isKnowCand) {
    if (!hasKV && !hasSB && !gas) return res.status(200).json({ cands: [], configured: false });
    try {
      const cur = (await blobGet(KNOWCAND_KEY, hasKV, hasSB, gas)) || {};
      const cands = Array.isArray(cur.cands) ? cur.cands : [];
      if (req.method === 'GET') return res.status(200).json({ cands, configured: true });
      const body = req.body || {};
      if (body.action === 'add' && body.cand) {
        const c = body.cand;
        const rec = {
          id: String(c.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6))),
          ts: new Date().toISOString(),
          roomId: String(c.roomId || '').slice(0, 80),
          shop: String(c.shop || '').slice(0, 60),
          fromName: String(c.fromName || '').slice(0, 60),
          question: String(c.question || '').slice(0, 500),
          answer: String(c.answer || '').slice(0, 4000),
        };
        if (!rec.answer.trim()) return res.status(200).json({ ok: false, error: 'empty' });
        const next = [...cands, rec].slice(-2000);
        await blobSet(KNOWCAND_KEY, { cands: next }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      if (body.action === 'delete' && body.id) {
        const next = cands.filter(x => x && x.id !== String(body.id));
        await blobSet(KNOWCAND_KEY, { cands: next }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ ok: false, error: 'invalid knowcand action' });
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
    }
  }

  // ── AIアシスタント質問ログ（自己解決率・よくある質問の可視化）: ?type=ailog ──
  const isAiLog = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'ailog';
  if (isAiLog) {
    if (!hasKV && !hasSB && !gas) return res.status(200).json({ logs: [], configured: false });
    try {
      const cur = (await blobGet(AILOG_KEY, hasKV, hasSB, gas)) || {};
      const logs = Array.isArray(cur.logs) ? cur.logs : [];
      if (req.method === 'GET') return res.status(200).json({ logs, configured: true });
      const body = req.body || {};
      if (body.action === 'add' && body.entry) {
        const e = body.entry;
        const rec = {
          id: String(e.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6))),
          ts: new Date().toISOString(),
          shop: String(e.shop || '').slice(0, 60),
          staffId: String(e.staffId || '').slice(0, 40),
          staffName: String(e.staffName || '').slice(0, 60),
          question: String(e.question || '').slice(0, 500),
          escalated: !!e.escalated,
        };
        const next = [...logs, rec].slice(-3000); // リングバッファ
        await blobSet(AILOG_KEY, { logs: next }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      if (body.action === 'delete' && body.id) {
        const next = logs.filter(l => l && l.id !== String(body.id));
        await blobSet(AILOG_KEY, { logs: next }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ ok: false, error: 'invalid ailog action' });
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
    }
  }

  // ── AIパトロール（自発チェック・マーケ巡回）: ?type=patrol ──
  // SalonOne実績（クライアントから受領）＋Googleマップ（Places API・キーはサーバー隠蔽）で各店を分析し、
  // 注意喚起・アドバイス項目を返す。住所照合・Google検索クエリの上書きは設定として保存。
  // Googleマップ連携は GOOGLE_PLACES_API_KEY 未設定でも SalonOne のみで動作（graceful degrade）。
  const isPatrol = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'patrol';
  if (isPatrol) {
    const GKEY = process.env.GOOGLE_PLACES_API_KEY || '';
    const googleEnabled = !!GKEY;
    const hasStore = !!(hasKV || hasSB || gas);
    const body = req.body || {};
    const action = req.method === 'GET' ? 'get' : String(body.action || '');
    // Google Places (New) Text Search でその店舗の口コミ件数・評価・住所を取得
    const lookupPlace = async (query) => {
      if (!GKEY) return null;
      const def = buildSearchRequest(query);
      if (!def) return null;
      try {
        const r = await fetch(def.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GKEY, 'X-Goog-FieldMask': def.fieldMask },
          body: JSON.stringify(def.body),
        });
        if (!r.ok) return { error: `places_http_${r.status}` };
        const j = await r.json().catch(() => null);
        return parsePlacesResponse(j) || { error: 'no_result' };
      } catch (e) { return { error: String((e && e.message) || e) }; }
    };
    const loadCfg = async () => {
      if (!hasStore) return {};
      const c = (await blobGet(PATROL_KEY, hasKV, hasSB, gas)) || {};
      return (c && typeof c === 'object') ? c : {};
    };
    try {
      if (action === 'get') {
        const cfg = await loadCfg();
        return res.status(200).json({ config: { addresses: cfg.addresses || {}, queries: cfg.queries || {} }, googleEnabled, configured: hasStore });
      }
      if (action === 'config') {
        if (!hasStore) return res.status(200).json({ ok: false, configured: false });
        const cfg = await loadCfg();
        const next = { ...cfg };
        if (body.addresses && typeof body.addresses === 'object') next.addresses = body.addresses;
        if (body.queries && typeof body.queries === 'object') next.queries = body.queries;
        await blobSet(PATROL_KEY, next, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      if (action === 'places') {
        // 接続テスト・単店ルックアップ
        const p = await lookupPlace(String(body.query || ''));
        return res.status(200).json({ ok: true, place: p, googleEnabled });
      }
      if (action === 'analyze') {
        const cfg = await loadCfg();
        const addresses = (cfg.addresses && typeof cfg.addresses === 'object') ? cfg.addresses : {};
        const queries = (cfg.queries && typeof cfg.queries === 'object') ? cfg.queries : {};
        const stores = Array.isArray(body.stores) ? body.stores.slice(0, 60) : [];
        const wantPlaces = body.wantPlaces !== false && googleEnabled;
        const jstNow = new Date(Date.now() + 9 * 3600 * 1000); // JST基準でクーポン月初判定
        const couponItems = couponReminderItems(jstNow);       // 月初のみ（各店メッセージに合流）
        // 月の進捗（当月は途中経過なのでフロー指標を按分比較する）。elapsed/total（JST基準）。
        const elapsedDays = jstNow.getUTCDate();
        const totalDays = new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth() + 1, 0)).getUTCDate();
        const progress = totalDays > 0 ? elapsedDays / totalDays : 1;
        const anOpts = { progress, elapsedDays, totalDays };
        // MEOスナップショット（口コミの今月増加数）を店舗名でひける形にする（あれば口コミ獲得率チェックに使う）。
        let meoShops = {};
        try { const mc = (await blobGet(MEO_KEY, hasKV, hasSB, gas)) || {}; meoShops = (mc.shops && typeof mc.shops === 'object') ? mc.shops : {}; } catch { meoShops = {}; }
        const meoFor = (nm) => { const rec = meoShops[nm]; if (!rec || !Array.isArray(rec.history)) return null; const dl = computeDeltas(rec.history); return { newReviewsThisMonth: dl.newThisMonth, totalReviews: dl.count }; };
        const reports = [];
        for (const st of stores) {
          const name = String((st && st.name) || '');
          if (!name) continue;
          let places = null, placesError = '';
          if (wantPlaces) {
            const q = queries[name] || (st && st.query) || `NAORU整体 ${name}`;
            const p = await lookupPlace(q);
            if (p && !p.error) places = p; else if (p && p.error) placesError = p.error;
            await new Promise(r => setTimeout(r, 120)); // Places レート制限に配慮
          }
          const rep = analyzeStore({ name, cur: (st && st.cur) || {}, prev: (st && st.prev) || {}, places, addresses: addresses[name] || {}, meo: meoFor(name) }, undefined, anOpts);
          const items = [...rep.items, ...couponItems];
          const message = buildStoreMessage(name, items, { date: jstNow });
          reports.push({ shop: name, items, places, placesError, message });
        }
        return res.status(200).json({ ok: true, reports, coupon: couponItems, googleEnabled });
      }
      return res.status(400).json({ ok: false, error: 'invalid patrol action' });
    } catch (err) {
      return res.status(200).json({ ok: false, error: String((err && err.message) || err) });
    }
  }

  // ── 勉強会・イベント日程ストア（共有編集グリッド）: ?type=events ──
  const isEvents = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'events';
  if (isEvents) {
    if (!hasKV && !hasSB && !gas) return res.status(200).json({ sections: {}, configured: false });
    try {
      const cur = (await blobGet(EVENTS_KEY, hasKV, hasSB, gas)) || {};
      const sections = (cur.sections && typeof cur.sections === 'object') ? cur.sections : {};
      if (req.method === 'GET') return res.status(200).json({ sections, configured: true });
      const body = req.body || {};
      const sk = String(body.section || '');
      if (!['study', 'event', 'bukatsu'].includes(sk)) return res.status(400).json({ ok: false, error: 'bad_section' });
      const rows = Array.isArray(sections[sk]) ? sections[sk] : [];
      if (body.action === 'upsertRow' && body.row && body.row.id) {
        const cells = (body.row.cells && typeof body.row.cells === 'object') ? body.row.cells : {};
        const clean = {}; for (const k of Object.keys(cells)) clean[String(k)] = String(cells[k] ?? '').slice(0, 300);
        const rec = { id: String(body.row.id), cells: clean, updatedBy: String(body.row.updatedBy || ''), updatedAt: new Date().toISOString() };
        const exists = rows.some(r => r && r.id === rec.id);
        const next = exists ? rows.map(r => r && r.id === rec.id ? rec : r) : rows.concat(rec);
        const nextSections = { ...sections, [sk]: next.slice(0, 400) };
        await blobSet(EVENTS_KEY, { sections: nextSections }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, row: rec });
      }
      if (body.action === 'deleteRow' && body.id) {
        const next = rows.filter(r => r && r.id !== String(body.id));
        await blobSet(EVENTS_KEY, { sections: { ...sections, [sk]: next } }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      if (body.action === 'reorder' && Array.isArray(body.order)) {
        const map = new Map(rows.map(r => [String(r.id), r]));
        const next = body.order.map(id => map.get(String(id))).filter(Boolean);
        // 並べ替えに含まれない行は末尾に温存
        for (const r of rows) if (!body.order.map(String).includes(String(r.id))) next.push(r);
        await blobSet(EVENTS_KEY, { sections: { ...sections, [sk]: next } }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ ok: false, error: 'invalid events action' });
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
    }
  }

  // ── 掲示板（全社発信）ストア: ?type=board ──
  const isBoard = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'board';
  if (isBoard) {
    if (!hasKV && !hasSB && !gas) return res.status(200).json({ posts: [], reads: {}, version: 0, configured: false });
    try {
      // 添付ファイル取得: GET ?type=board&file=<id> → { name, dataUrl }
      if (req.method === 'GET' && req.query.file) {
        const f = await blobGet(BOARD_FILE_PREFIX + String(req.query.file), hasKV, hasSB, gas);
        if (!f) return res.status(404).json({ ok: false, error: 'not_found' });
        return res.status(200).json({ ok: true, ...f });
      }

      const body = req.body || {};
      const action = body.action;

      // ══ 既読の更新は投稿に一切触れない（これが今回の修正の核心）══
      // 従来は read アクションが { posts, reads } を丸ごと書き戻していたため、
      // 「誰かが掲示板を開く」たびに、その直前に投稿された記事を踏み潰す可能性があった。
      if (req.method === 'POST' && action === 'read' && body.staffId) {
        const staffId = String(body.staffId).slice(0, 64);
        const ts = Number(body.ts) || Date.now();
        try {
          if (hasKV) await kvBumpRead(BOARD_READS_KEY, staffId, ts);           // 原子的
          else {
            const cur = await blobGet(BOARD_READS_KEY, hasKV, hasSB, gas);      // 小さな別キーのRMW
            await blobSet(BOARD_READS_KEY, bumpRead(cur, staffId, ts), hasKV, hasSB, gas);
          }
        } catch (_) {
          const cur = await blobGet(BOARD_READS_KEY, hasKV, hasSB, gas).catch(() => null);
          await blobSet(BOARD_READS_KEY, bumpRead(cur, staffId, ts), hasKV, hasSB, gas).catch(() => {});
        }
        return res.status(200).json({ ok: true });
      }

      // 投稿側。旧 blob の reads は**移行のためそのまま保持**する（旧コードへ戻しても既読が消えない）。
      const cur = (await blobGet(BOARD_KEY, hasKV, hasSB, gas)) || {};
      const posts = Array.isArray(cur.posts) ? cur.posts : [];
      const legacyReads = (cur.reads && typeof cur.reads === 'object') ? cur.reads : {};
      const version = versionOf(cur);
      // 投稿側の書き換えはここだけを通す。reads には触れず、版を1つ進める。
      // KV では compare-and-set で書く。読んでから書くまでの間に他の人が書いていたら
      // **最新を読み直して同じ操作をやり直す**（最大3回）。これで同時投稿が消えない。
      // ⚠️ Supabase/GAS では CAS が使えないため従来どおりの書き込みになる（§既知の制約）。
      const mutatePosts = async (applyFn) => {
        if (!hasKV) {                                        // 非KV: 従来どおり（本番では到達しない）
          await blobSet(BOARD_KEY, { posts: applyFn(posts), reads: legacyReads, _v: version + 1 }, hasKV, hasSB, gas);
          return { ok: true, atomic: false };
        }
        let base = { posts, legacyReads, version };
        for (let attempt = 0; attempt < 5; attempt++) {
          const next = applyFn(base.posts);
          if (next === null) return { ok: false, reason: 'not_found' };   // 対象が消えていた
          const done = await kvCasSet(BOARD_KEY, base.version, { posts: next, reads: base.legacyReads, _v: base.version + 1 });
          if (done) return { ok: true, atomic: true, posts: next };
          // 誰かが先に書いた→少しばらつかせて待ってから読み直す。
          // 全員が同時にやり直すと再び衝突するため、待ち時間に乱数を入れて散らす
          // （実機Redisでの計測: 10件同時で成功 6/10 → 9/10 に改善）。
          await new Promise(r => setTimeout(r, Math.round((10 + Math.random() * 40) * (attempt + 1))));
          const fresh = (await blobGet(BOARD_KEY, hasKV, hasSB, gas)) || {};
          base = {
            posts: Array.isArray(fresh.posts) ? fresh.posts : [],
            legacyReads: (fresh.reads && typeof fresh.reads === 'object') ? fresh.reads : {},
            version: versionOf(fresh),
          };
        }
        return { ok: false, reason: 'conflict' };
      };
      // 既存の呼び出し形（配列をそのまま渡す）を保つための薄い包み。
      const savePosts = async (nextPosts) => {
        const r = await mutatePosts(() => nextPosts);
        if (!r.ok) throw new Error('board_write_conflict');
        return r;
      };
      // 投稿者・コメント者・リアクションした人の既読も進める（別キーなので投稿を巻き込まない）。
      const bumpActor = async (staffId) => {
        if (!staffId) return;
        try {
          if (hasKV) await kvBumpRead(BOARD_READS_KEY, String(staffId), Date.now());
          else {
            const r = await blobGet(BOARD_READS_KEY, hasKV, hasSB, gas);
            await blobSet(BOARD_READS_KEY, bumpRead(r, staffId, Date.now()), hasKV, hasSB, gas);
          }
        } catch (_) { /* 既読の失敗で投稿処理を止めない */ }
      };

      if (req.method === 'GET') {
        // 移行期間: 旧 blob 内の既読と新キーの既読を両方読む
        const split = await blobGet(BOARD_READS_KEY, hasKV, hasSB, gas).catch(() => null);
        return res.status(200).json({ posts, reads: mergeReads(legacyReads, split), version, configured: true });
      }

      // 古い版で上書きしようとしていないか（expectedVersion 未指定なら検査しない＝旧クライアントも動く）
      if (isStale(body.expectedVersion, version)) {
        return res.status(409).json({ ok: false, error: 'stale', version, posts });
      }

      if (action === 'post' && body.post) {
        const p = body.post;
        const text = String(p.text || '').slice(0, 8000);
        const title = String(p.title || '').slice(0, 200);
        const rec = {
          id: genId('post'),
          clientId: String(p.clientId || '').slice(0, 64),   // 二重送信・再送の重複を防ぐ
          authorId: String(p.authorId || ''),
          authorName: String(p.authorName || '').slice(0, 80),
          authorShop: String(p.authorShop || '').slice(0, 80),
          authorRoot: !!p.authorRoot,
          title,
          important: !!p.important,
          text,
          link: /^https?:\/\//.test(String(p.link || '')) ? String(p.link).slice(0, 500) : '',
          links: extractLinks(text),
          imgIds: (Array.isArray(p.imgIds) ? p.imgIds : []).map(String).slice(0, 8),
          files: (Array.isArray(p.files) ? p.files : []).slice(0, 8).map(f => ({ id: String(f.id || ''), name: String(f.name || 'file').slice(0, 120), type: String(f.type || ''), size: Number(f.size) || 0 })),
          videoUrl: (() => { const v = videoEmbed(p.videoUrl); return v ? String(p.videoUrl).slice(0, 500) : ''; })(),
          pinned: false,
          createdAt: new Date().toISOString(),
        };
        if (!upsertPost(posts, rec, BOARD_POST_CAP).added) {  // 再送＝既にある。通知も送り直さない
          await bumpActor(rec.authorId);
          return res.status(200).json({ ok: true, post: upsertPost(posts, rec, BOARD_POST_CAP).existing, duplicate: true });
        }
        // 再試行のたびに最新の posts へ当て直す。clientId があるので二重に入らない。
        let dup = false;
        const w = await mutatePosts((cur) => {
          const u = upsertPost(cur, rec, BOARD_POST_CAP);
          if (!u.added) { dup = true; return cur; }
          return u.posts;
        });
        if (!w.ok) return res.status(409).json({ ok: false, error: 'conflict', message: '他の投稿と重なりました。もう一度お試しください。' });
        if (dup) { await bumpActor(rec.authorId); return res.status(200).json({ ok: true, post: rec, duplicate: true }); }
        await bumpActor(rec.authorId);
        sendPush(hasKV, hasSB, gas, { kind: 'board', title: 'NAORU', body: `${rec.important ? '❗' : '📣'} 重要掲示板／${title || rec.authorName || 'お知らせ'}：${text}`.slice(0, 150) || '新しい掲示があります', url: '/?tab=board' });
        return res.status(200).json({ ok: true, post: rec });
      }
      if (action === 'uploadImage' && body.dataUrl) {
        const dataUrl = String(body.dataUrl);
        if (!/^data:image\/(png|jpe?g|gif|webp);base64,/.test(dataUrl)) return res.status(400).json({ ok: false, error: 'bad_image' });
        if (dataUrl.length > 3_500_000) return res.status(413).json({ ok: false, error: 'too_large' });
        const id = genId('img');
        await blobSet(CHAT_IMG_PREFIX + id, dataUrl, hasKV, hasSB, gas); // 画像はチャットと同じ保存先を再利用
        return res.status(200).json({ ok: true, id });
      }
      if (action === 'uploadFile' && body.dataUrl && body.name) {
        const dataUrl = String(body.dataUrl);
        if (!/^data:[^;]+;base64,/.test(dataUrl)) return res.status(400).json({ ok: false, error: 'bad_file' });
        if (dataUrl.length > 6_000_000) return res.status(413).json({ ok: false, error: 'too_large' }); // ~4.4MBまで
        const id = genId('file');
        await blobSet(BOARD_FILE_PREFIX + id, { name: String(body.name).slice(0, 120), type: String(body.fileType || ''), dataUrl }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, id });
      }
      if (action === 'pin' && body.id) {
        await savePosts(posts.map(p => p && p.id === String(body.id) ? { ...p, pinned: !!body.pinned } : p));
        return res.status(200).json({ ok: true });
      }
      if (action === 'react' && body.id && body.emoji && body.staffId) {
        await savePosts(posts.map(p => p && p.id === String(body.id) ? { ...p, reactions: toggleReaction(p.reactions, String(body.emoji), String(body.staffId)) } : p));
        await bumpActor(String(body.staffId));   // リアクション＝閲覧とみなす（別キーへ）
        return res.status(200).json({ ok: true });
      }
      // コメント投稿（返信＝parentId・メンション対応）
      if (action === 'comment' && body.id && body.comment) {
        const c = body.comment;
        const text = String(c.text || '').slice(0, 2000);
        if (!text) return res.status(400).json({ ok: false, error: 'empty' });
        const rec = {
          id: genId('cm'),
          clientId: String(c.clientId || '').slice(0, 64),
          parentId: c.parentId ? String(c.parentId) : '',
          fromStaffId: String(c.fromStaffId || ''),
          fromName: String(c.fromName || '').slice(0, 80),
          fromShop: String(c.fromShop || '').slice(0, 80),
          text,
          mentions: (Array.isArray(c.mentions) ? c.mentions : []).filter(x => x && x.id && x.name).map(x => ({ id: String(x.id).slice(0, 64), name: String(x.name).slice(0, 80) })).slice(0, 30),
          createdAt: new Date().toISOString(),
        };
        const probe = upsertComment(posts, String(body.id), rec, 500);
        if (!probe.target) return res.status(404).json({ ok: false, error: 'not_found' });
        if (!probe.added) {                                    // 再送＝既にある
          await bumpActor(rec.fromStaffId);
          return res.status(200).json({ ok: true, comment: probe.existing, duplicate: true });
        }
        let cmDup = false, target = probe.target;
        const w = await mutatePosts((cur) => {
          const u = upsertComment(cur, String(body.id), rec, 500);
          if (!u.target) return null;                          // 投稿が消えていた
          if (!u.added) { cmDup = true; return cur; }
          target = u.target;
          return u.posts;
        });
        if (!w.ok) {
          if (w.reason === 'not_found') return res.status(404).json({ ok: false, error: 'not_found' });
          return res.status(409).json({ ok: false, error: 'conflict', message: '他の書き込みと重なりました。もう一度お試しください。' });
        }
        if (cmDup) { await bumpActor(rec.fromStaffId); return res.status(200).json({ ok: true, comment: rec, duplicate: true }); }
        await bumpActor(rec.fromStaffId);
        // 通知: 投稿者＋メンション＋（返信なら親コメント投稿者）へ
        const set = new Set();
        if (target.authorId && String(target.authorId) !== rec.fromStaffId) set.add(String(target.authorId));
        rec.mentions.forEach(m => { if (m.id && m.id !== rec.fromStaffId && m.id !== '__all__') set.add(String(m.id)); });
        if (rec.parentId) { const parent = (target.comments || []).find(x => x.id === rec.parentId); if (parent && parent.fromStaffId && String(parent.fromStaffId) !== rec.fromStaffId) set.add(String(parent.fromStaffId)); }
        const hasAll = rec.mentions.some(m => m.id === '__all__');
        const list = hasAll ? null : [...set];
        if (!(Array.isArray(list) && list.length === 0)) sendPush(hasKV, hasSB, gas, { kind: 'board', title: 'NAORU', body: `💬 ${(target.title || 'お知らせ')}／${rec.fromName}：${text}`.slice(0, 150), url: '/?tab=board' }, list);
        return res.status(200).json({ ok: true, comment: rec });
      }
      if (action === 'deleteComment' && body.id && body.commentId) {
        await savePosts(posts.map(p => { if (p && p.id === String(body.id)) { const comments = (Array.isArray(p.comments) ? p.comments : []).filter(c => !(c.id === String(body.commentId) && (body.root || String(c.fromStaffId) === String(body.staffId)))); return { ...p, comments }; } return p; }));
        return res.status(200).json({ ok: true });
      }
      if (action === 'delete' && body.id) {
        await savePosts(posts.filter(p => {
          if (!p || p.id !== String(body.id)) return true;
          return !(body.root || String(p.authorId) === String(body.staffId)); // 本人/rootのみ削除
        }));
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ ok: false, error: 'invalid board action' });
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
    }
  }

  // ── プロフィールストア: ?type=profile ──
  // 各スタッフ/オーナーが自分のプロフィール（写真・名前・自己紹介・SNS・担当店舗）を編集。
  // 組織図でホバー表示し、店舗割当はSalonOneをベースにしつつ本人の設定を優先する。
  // ── チャット系のアクセス制御（本人確認した root / 本部のみ）────────────────
  // ⚠️ 既存の認証（lib/actor.js）をそのまま使う。チャット専用の認証系は作らない。
  //    対象: ?type=chat（ルーム一覧・本文・名簿・ノート・画像・添付・書込）と
  //          ?type=profile（同じ画像ストアを読む迂回経路・スタッフ名簿）。
  //    owner / manager / staff への公開はまだ行わない（サーバー側で拒否する）。

  const isProfile = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'profile';
  if (isProfile) {
    if (!hasKV && !hasSB && !gas) return res.status(200).json({ profiles: {}, configured: false });
    try {
      // 画像1枚取得（チャットと同じ保存先を再利用）: GET ?type=profile&img=<id>
      if (req.method === 'GET' && req.query.img) {
        const dataUrl = await blobGet(CHAT_IMG_PREFIX + String(req.query.img), hasKV, hasSB, gas);
        if (!dataUrl) return res.status(404).json({ ok: false, error: 'not_found' });
        return res.status(200).json({ ok: true, dataUrl });
      }
      const cur = (await blobGet(PROFILE_KEY, hasKV, hasSB, gas)) || {};
      const profiles = (cur.profiles && typeof cur.profiles === 'object') ? cur.profiles : {};
      const hidden = Array.isArray(cur.hidden) ? cur.hidden.map(String) : []; // 組織図から非表示にした人（root操作）
      if (req.method === 'GET') return res.status(200).json({ profiles, hidden, configured: true });

      const body = req.body || {};
      const action = body.action;

      // 画像アップロード（チャットと同じ 1枚1キー・別保存）
      if (action === 'uploadImage' && body.dataUrl) {
        const dataUrl = String(body.dataUrl);
        if (!/^data:image\/(png|jpe?g|gif|webp);base64,/.test(dataUrl)) return res.status(400).json({ ok: false, error: 'bad_image' });
        if (dataUrl.length > 3_500_000) return res.status(413).json({ ok: false, error: 'too_large' });
        const id = genId('img');
        await blobSet(CHAT_IMG_PREFIX + id, dataUrl, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, id });
      }

      // 保存（本人 or root）。pid＝本人の識別子（staffId or owner:<name>）。
      if (action === 'save' && body.pid && body.profile) {
        const pid = String(body.pid);
        if (!(body.root || String(body.staffId) === pid)) return res.status(403).json({ ok: false, error: 'forbidden' });
        const p = body.profile;
        const clean = {
          pid,
          kind: (p.kind === 'owner' || p.kind === 'hq') ? p.kind : 'therapist',
          nameKanji: String(p.nameKanji || '').slice(0, 60),
          nameKana: String(p.nameKana || '').slice(0, 60),
          bio: String(p.bio || '').slice(0, 2000),
          mainImg: String(p.mainImg || '').slice(0, 64),
          // メイン写真の切り抜き元（未加工の元画像ID）。再トリミング時に元画像から切り抜くため保持（画質劣化防止）。
          mainImgRaw: String(p.mainImgRaw || '').slice(0, 64),
          // メイン写真の表示位置（object-position "X% Y%"）。旧プロフィール後方互換（切り抜き前の位置調整）。
          mainPos: (() => { const v = String(p.mainPos || '').trim(); return /^\d{1,3}% \d{1,3}%$/.test(v) ? v : ''; })(),
          subImgs: (Array.isArray(p.subImgs) ? p.subImgs : []).map(String).slice(0, 3),
          sns: (() => {
            const s = (p.sns && typeof p.sns === 'object') ? p.sns : {};
            const pick = {}; for (const k of ['instagram', 'x', 'youtube', 'tiktok', 'facebook', 'line', 'website']) { if (s[k]) pick[k] = String(s[k]).slice(0, 300); }
            return pick;
          })(),
          shops: (Array.isArray(p.shops) ? p.shops : []).map(x => String(x).slice(0, 80)).slice(0, 50),
          // 生年月日（任意）。YYYY-MM-DD または MM-DD のみ許可。誕生日の当日表示に使用。
          birthday: (() => { const b = String(p.birthday || '').trim(); return /^(\d{4}-)?\d{2}-\d{2}$/.test(b) ? b : ''; })(),
          updatedAt: new Date().toISOString(),
        };
        const next = { ...profiles, [pid]: clean };
        await blobSet(PROFILE_KEY, { profiles: next, hidden }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, profile: clean });
      }

      // 削除（本人 or root）
      if (action === 'delete' && body.pid) {
        const pid = String(body.pid);
        if (!(body.root || String(body.staffId) === pid)) return res.status(403).json({ ok: false, error: 'forbidden' });
        const next = { ...profiles }; delete next[pid];
        await blobSet(PROFILE_KEY, { profiles: next, hidden }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }

      // 組織図から非表示/再表示（root専用）。SalonOne由来の人はこのリストで隠す。
      if (action === 'hide' && body.id) {
        if (!body.root) return res.status(403).json({ ok: false, error: 'forbidden' });
        const nextHidden = [...new Set([...hidden, String(body.id)])].slice(0, 5000);
        await blobSet(PROFILE_KEY, { profiles, hidden: nextHidden }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, hidden: nextHidden });
      }
      if (action === 'unhide' && body.id) {
        if (!body.root) return res.status(403).json({ ok: false, error: 'forbidden' });
        const nextHidden = hidden.filter(x => x !== String(body.id));
        await blobSet(PROFILE_KEY, { profiles, hidden: nextHidden }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, hidden: nextHidden });
      }

      return res.status(400).json({ ok: false, error: 'invalid profile action' });
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
    }
  }

  // ── Webプッシュ購読ストア: ?type=push ──
  const isPush = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'push';
  if (isPush) {
    try {
      // 公開鍵とプッシュ有効状態を返す（フロントが購読に使う）。staffId指定時はその人の通知設定も返す。
      if (req.method === 'GET') {
        let prefs = null;
        if (req.query.staffId && (hasKV || hasSB || gas)) {
          try { const st = (await blobGet(PUSH_KEY, hasKV, hasSB, gas)) || {}; const found = (Array.isArray(st.subs) ? st.subs : []).find(x => String(x.staffId) === String(req.query.staffId) && x.prefs); prefs = normalizePrefs(found && found.prefs); } catch { prefs = null; }
        }
        return res.status(200).json({ enabled: !!(VAPID_PUBLIC() && VAPID_PRIVATE()), publicKey: VAPID_PUBLIC(), configured: !!(hasKV || hasSB || gas), prefs });
      }
      if (!hasKV && !hasSB && !gas) return res.status(200).json({ ok: false, configured: false });
      const body = req.body || {};
      const store = (await blobGet(PUSH_KEY, hasKV, hasSB, gas)) || {};
      const subs = Array.isArray(store.subs) ? store.subs : [];
      if (body.action === 'subscribe' && body.subscription && body.subscription.endpoint) {
        const s = body.subscription;
        // 通知設定: 明示指定→それ／既存の同一staffId購読→引き継ぎ／なければ既定
        const inherited = subs.find(x => x && String(x.staffId) === String(body.staffId || '') && x.prefs);
        const prefs = normalizePrefs(body.prefs || (inherited && inherited.prefs));
        const rec = { endpoint: String(s.endpoint), keys: s.keys || {}, staffId: String(body.staffId || ''), name: String(body.name || '').slice(0, 80), prefs, createdAt: new Date().toISOString() };
        const next = subs.filter(x => x && x.endpoint !== rec.endpoint).concat(rec).slice(-5000);
        await blobSet(PUSH_KEY, { subs: next }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, prefs });
      }
      // 通知設定の更新（同一staffIdの全購読に反映）
      if (body.action === 'setPrefs' && body.staffId) {
        const prefs = normalizePrefs(body.prefs);
        const next = subs.map(x => (x && String(x.staffId) === String(body.staffId)) ? { ...x, prefs } : x);
        await blobSet(PUSH_KEY, { subs: next }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, prefs });
      }
      if (body.action === 'unsubscribe' && body.endpoint) {
        const next = subs.filter(x => x && x.endpoint !== String(body.endpoint));
        await blobSet(PUSH_KEY, { subs: next }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ ok: false, error: 'invalid push action' });
    } catch (err) {
      return res.status(200).json({ ok: false, error: String((err && err.message) || err) });
    }
  }

  // ── 社内チャット ストア: ?type=chat ──
  // rooms / messages / reads / dir を1つのblobで共有。画像は別キー(CHAT_IMG_PREFIX+id)。
  const isChat = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'chat';
  if (isChat) {
    if (!hasKV && !hasSB && !gas) return res.status(200).json({ rooms: [], messages: {}, reads: {}, dir: { staff: [] }, configured: false });
    try {
      // 画像1枚取得: GET ?type=chat&img=<id>（&raw=1 で生バイナリ配信＝LINE風に高速・ブラウザキャッシュ可）
      if (req.method === 'GET' && req.query.img) {
        const dataUrl = await blobGet(CHAT_IMG_PREFIX + String(req.query.img), hasKV, hasSB, gas);
        if (!dataUrl) return res.status(404).json({ ok: false, error: 'not_found' });
        if (req.query.raw) {
          const m = /^data:([^;]+);base64,(.*)$/s.exec(String(dataUrl));
          if (m) {
            res.setHeader('Content-Type', m[1]);
            // ⚠️ 私用のチャット画像。CDN や共有キャッシュに載せない（認証必須のため）
            res.setHeader('Cache-Control', 'private, no-store');
            return res.status(200).send(Buffer.from(m[2], 'base64'));
          }
        }
        return res.status(200).json({ ok: true, dataUrl });
      }
      const cur = (await blobGet(CHAT_KEY, hasKV, hasSB, gas)) || {};
      const rooms = Array.isArray(cur.rooms) ? cur.rooms : [];
      // メッセージはルーム別キー(naoru:chat:m:<roomId>)に保存。
      // ⚠️ 可変な索引(midx)は使わない：送信時に索引を空ベースから作り直して他ルームを消す不具合があったため、
      //    権威ある rooms 一覧からキーを引く方式に変更（索引の巻き込み消失を根本回避）。
      const readsCur = await blobGet(CHAT_READS_KEY, hasKV, hasSB, gas);
      const reads = (readsCur && typeof readsCur === 'object') ? readsCur : ((cur.reads && typeof cur.reads === 'object') ? cur.reads : {});
      const dir = (cur.dir && typeof cur.dir === 'object') ? { staff: Array.isArray(cur.dir.staff) ? cur.dir.staff : [], updatedAt: cur.dir.updatedAt || '' } : { staff: [], updatedAt: '' };
      const notes = (cur.notes && typeof cur.notes === 'object') ? cur.notes : {};   // { [roomId]: [{id,fromStaffId,fromName,text,imgIds,createdAt}] } ノート
      // 旧集約(移行元)。per-roomキーが無いルームの補完に使う。必要時のみ1回だけ読む。
      let aggFallback = null;
      const loadAgg = async () => {
        if (aggFallback === null) {
          const a = await blobGet(CHAT_MSGS_KEY, hasKV, hasSB, gas);
          aggFallback = (a && typeof a === 'object') ? a : ((cur.messages && typeof cur.messages === 'object') ? cur.messages : {});
        }
        return aggFallback;
      };
      // 1ルームぶんのメッセージを読む（per-roomキー→無ければ旧集約から）。
      const getRoomMsgs = async (rid) => {
        const a = await blobGet(CHAT_MSG_PREFIX + String(rid), hasKV, hasSB, gas);
        if (Array.isArray(a)) return a;
        const agg = await loadAgg(); const m = agg[String(rid)];
        return Array.isArray(m) ? m : [];
      };
      // 1ルームぶんのメッセージだけを書く（他ルームの送信と競合しない・索引更新なし）。
      const saveRoomMsgs = (rid, arr) => blobSet(CHAT_MSG_PREFIX + String(rid), Array.isArray(arr) ? arr : [], hasKV, hasSB, gas);
      const saveReads = (r) => blobSet(CHAT_READS_KEY, r, hasKV, hasSB, gas);
      // save は rooms/dir/notes のみ書き込む（messages/reads は一切触らない＝競合しない）。
      const save = (patch) => blobSet(CHAT_KEY, { rooms, dir, notes, ...patch }, hasKV, hasSB, gas);

      if (req.method === 'GET') {
        // 見えるルームだけを返す（本文もサーバー側で出さない）。
        // ⚠️ **root / 本部でも、参加していないDMは返さない**（lib/authz.js の canViewRoom）。
        //    ここでフィルタしないと、DMの本文が一覧と一緒に全部返ってしまう。
        const visible = rooms.filter(r => canViewRoom(chatActor, r));
        const keys = visible.map(r => CHAT_MSG_PREFIX + String(r.id));
        const arrs = await blobMGet(keys, hasKV, hasSB, gas);
        const messages = {};
        const missing = [];
        visible.forEach((r, i) => { const a = arrs[i]; if (Array.isArray(a) && a.length) messages[String(r.id)] = a; else missing.push(String(r.id)); });
        if (missing.length) { const agg = await loadAgg(); for (const rid of missing) { const m = agg[rid]; if (Array.isArray(m) && m.length) messages[rid] = m; } }
        // ノートも見えるルームぶんだけ
        const visibleIds = new Set(visible.map(r => String(r.id)));
        const scopedNotes = {};
        for (const [rid, arr] of Object.entries(notes || {})) if (visibleIds.has(String(rid))) scopedNotes[rid] = arr;
        return res.status(200).json({ rooms: visible, messages, reads, dir, notes: scopedNotes, configured: true,
          filtered: visible.length !== rooms.length });
      }

      const body = req.body || {};
      const action = body.action;

      // 全社アナウンス＋店舗ルーム＋スタッフディレクトリを用意（広い権限のセッションが呼ぶ）
      if (action === 'ensureRooms') {
        const nextRooms = ensureBaseRooms(rooms, Array.isArray(body.shops) ? body.shops : []);
        let nextDir = dir;
        if (Array.isArray(body.staff) && body.staff.length) {
          const map = new Map((dir.staff || []).map(s => [String(s.id), s]));
          for (const s of body.staff) {
            const id = String((s && s.id) || ''); if (!id) continue;
            map.set(id, { id, name: String(s.name || ''), shop: String(s.shop || '') });
          }
          nextDir = { staff: [...map.values()].slice(0, 8000), updatedAt: new Date().toISOString() };
        }
        await save({ rooms: nextRooms, dir: nextDir });
        return res.status(200).json({ ok: true, rooms: nextRooms, dir: nextDir });
      }

      // ルーム作成（group/dm）。members・name・kind をそのまま採用。
      if (action === 'createRoom' && body.room) {
        // ⚠️ storeId / eventId / status / autoMembers は**サーバー管理**。
        //    クライアント入力からは受け取らない（stripManaged）。
        //    既に同じIDのRoomがある場合は、その値を引き継ぐ（createRoom は作り直すため）。
        const r = stripManaged(body.room);
        const room = {
          id: r.id ? String(r.id) : genId('room'),
          kind: (r.kind === 'dm' || r.kind === 'group') ? r.kind : 'group',
          name: String(r.name || '').slice(0, 60),
          icon: String(r.icon || '').slice(0, 16),
          iconImg: String(r.iconImg || '').slice(0, 64),
          shop: String(r.shop || ''),
          members: (Array.isArray(r.members) ? r.members : []).map(String).slice(0, 500),
          createdBy: String(r.createdBy || ''),
          createdAt: new Date().toISOString(),
        };
        const prevRoom = rooms.find(x => x && String(x.id) === String(room.id)) || null;
        // ⚠️ 既存IDを指定した createRoom で、**見えないRoomを作り直せない**ようにする。
        //    （他人のDMや別店舗のルームのIDを当てて、名前やメンバーを書き換える経路を塞ぐ）
        if (prevRoom && !canViewRoom(chatActor, prevRoom)) {
          return res.status(403).json({ ok: false, error: 'forbidden', code: 'room_not_visible',
            message: 'このルームを操作する権限がありません' });
        }
        const merged = carryManaged(prevRoom, room);      // 付加情報を消さない
        const nextRooms = rooms.filter(x => x && x.id !== merged.id).concat(merged);
        await save({ rooms: nextRooms });
        return res.status(200).json({ ok: true, room: merged });
      }

      // グループのメンバー変更（招待/退会）。group のみ・メンバー or root。
      if (action === 'setMembers' && body.roomId && Array.isArray(body.members)) {
        const rid = String(body.roomId);
        const room = rooms.find(r => r && r.id === rid);
        if (!room || room.kind !== 'group') return res.status(400).json({ ok: false, error: 'not_group' });
        // ⚠️ メンバー変更も認可する。body.root / body.staffId の申告ではなく、
        //    検証済み actor がそのルームを見られることを条件にする。
        if (!canViewRoom(chatActor, room)) {
          return res.status(403).json({ ok: false, error: 'forbidden', code: 'room_not_visible' });
        }
        const oldM = (room.members || []).map(String);
        const members = [...new Set(body.members.map(String))].slice(0, 500);
        // 付加フィールドを保ったままメンバーを差し替える。
        // 人が新しく入れた人は autoMembers から外れる＝手動参加に昇格し、以後は同期が外せない。
        // ⚠️ 一般のリクエストが「システム同期」を名乗れないようにする。
        //    bySync を認めるのは、サーバー間のエージェントトークン（source='agent'）または
        //    cron で本人確認できた場合だけ。クライアントの申告だけでは human 扱いにする。
        //    （sync 扱いだと、人が入れた人を自動削除の対象にできてしまう）
        const syncAllowed = body.bySync === true && !!chatActor && chatActor.verified === true
          && (chatActor.source === 'agent' || chatActor.source === 'cron');
        const nextRooms = rooms.map(r => (r && r.id === rid)
          ? applyMemberChange(r, members, { by: syncAllowed ? 'sync' : 'human' })
          : r);
        // システムメッセージ（追加/退出させた）＝ actorName + names が渡された時のみ生成（events等の内部更新では出さない）
        let sysArr = null;
        if (body.actorName && body.names && typeof body.names === 'object') {
          const nm = (id) => String(body.names[id] || 'メンバー');
          const sys = [];
          members.filter(id => !oldM.includes(id)).forEach(id => sys.push(`${body.actorName} が ${nm(id)} を追加しました`));
          oldM.filter(id => !members.includes(id)).forEach(id => sys.push(`${body.actorName} が ${nm(id)} を退出させました`));
          if (sys.length) {
            const base = await getRoomMsgs(rid);
            sysArr = base.concat(sys.map(text => ({ id: genId('m'), roomId: rid, system: true, text, createdAt: new Date().toISOString() }))).slice(-CHAT_MSG_CAP);
          }
        }
        await save({ rooms: nextRooms }); if (sysArr) await saveRoomMsgs(rid, sysArr);
        return res.status(200).json({ ok: true, members });
      }

      // 自己退出（グループを離れる）。group のみ・システムメッセージ「〇〇が退出しました」。
      if (action === 'leave' && body.roomId && body.staffId) {
        const rid = String(body.roomId);
        const room = rooms.find(r => r && r.id === rid);
        if (!room || room.kind !== 'group') return res.status(400).json({ ok: false, error: 'not_group' });
        const members = (room.members || []).map(String).filter(id => id !== String(body.staffId));
        const nextRooms = rooms.map(r => r && r.id === rid ? { ...r, members } : r);
        const rec = { id: genId('m'), roomId: rid, system: true, text: `${String(body.name || 'メンバー')} が退出しました`, createdAt: new Date().toISOString() };
        const arr = (await getRoomMsgs(rid)).concat(rec).slice(-CHAT_MSG_CAP);
        await save({ rooms: nextRooms }); await saveRoomMsgs(rid, arr);
        return res.status(200).json({ ok: true, members });
      }

      // 自己参加（勉強会・イベントの「グループチャットへ」導線／招待受諾）。group のみ・自分を追加。
      if (action === 'join' && body.roomId && body.staffId) {
        const rid = String(body.roomId);
        const room = rooms.find(r => r && r.id === rid);
        if (!room || room.kind !== 'group') return res.status(400).json({ ok: false, error: 'not_group' });
        const already = (room.members || []).map(String).includes(String(body.staffId));
        const members = [...new Set([...(room.members || []).map(String), String(body.staffId)])].slice(0, 500);
        const nextRooms = rooms.map(r => r && r.id === rid ? { ...r, members } : r);
        let joinArr = null;
        if (!already && body.name) {
          const rec = { id: genId('m'), roomId: rid, system: true, text: `${String(body.name)} が参加しました`, createdAt: new Date().toISOString() };
          joinArr = (await getRoomMsgs(rid)).concat(rec).slice(-CHAT_MSG_CAP);
        }
        await save({ rooms: nextRooms }); if (joinArr) await saveRoomMsgs(rid, joinArr);
        return res.status(200).json({ ok: true, members });
      }

      // グループ名・アイコン変更。group のみ・メンバー or root。
      if (action === 'setRoom' && body.roomId) {
        const rid = String(body.roomId);
        const room = rooms.find(r => r && r.id === rid);
        if (!room || room.kind !== 'group') return res.status(400).json({ ok: false, error: 'not_group' });
        const isMember = (room.members || []).map(String).includes(String(body.staffId));
        if (!(body.root || isMember)) return res.status(403).json({ ok: false, error: 'forbidden' });
        // ⚠️ patch には管理フィールドを入れない（クライアントから書かせない）
        const patch = {};
        if (typeof body.name === 'string') patch.name = body.name.slice(0, 60);
        // アイコン: 絵文字(icon) と 画像(iconImg=画像ID) は排他。片方を設定するともう片方はクリア。
        if (typeof body.icon === 'string') { patch.icon = body.icon.slice(0, 16); if (patch.icon) patch.iconImg = ''; }
        if (typeof body.iconImg === 'string') { patch.iconImg = body.iconImg.slice(0, 64); if (patch.iconImg) patch.icon = ''; }
        const safePatch = stripManaged(patch);
        const nextRooms = rooms.map(r => r && r.id === rid ? { ...r, ...safePatch } : r);
        await save({ rooms: nextRooms });
        return res.status(200).json({ ok: true, room: { ...room, ...safePatch } });
      }

      // メッセージをルーム上部に固定（アナウンス）／解除。room.pinned にスナップショットを保持。
      if (action === 'pinMsg' && body.roomId) {
        const rid = String(body.roomId);
        const room = rooms.find(r => r && r.id === rid);
        if (!room) return res.status(400).json({ ok: false, error: 'no_room' });
        const p = body.pinned;
        const pinned = p ? {
          id: String(p.id || '').slice(0, 40),
          text: String(p.text || '').slice(0, 300),
          fromName: String(p.fromName || '').slice(0, 80),
          by: String(body.staffId || '').slice(0, 64),
          createdAt: String(p.createdAt || '').slice(0, 40) || new Date().toISOString(),
        } : null;
        const nextRooms = rooms.map(r => r && r.id === rid ? { ...r, pinned } : r);
        await save({ rooms: nextRooms });
        return res.status(200).json({ ok: true, pinned });
      }

      // メッセージ送信（画像は先に uploadImage で入れて imgIds を渡す）
      if (action === 'send' && body.roomId && body.msg) {
        const rid = String(body.roomId);
        const m = body.msg;
        const text = String(m.text || '').slice(0, 4000);
        const rec = {
          id: genId('m'),
          roomId: rid,
          fromStaffId: String(m.fromStaffId || ''),
          fromName: String(m.fromName || '').slice(0, 80),
          fromShop: String(m.fromShop || '').slice(0, 80),
          text,
          imgIds: (Array.isArray(m.imgIds) ? m.imgIds : []).map(String).slice(0, 6),
          // 動画/PDF/ファイル添付（Vercel Blobの公開URLのみ許可）。{url,name,type,size,kind}
          media: (Array.isArray(m.media) ? m.media : [])
            .filter(x => x && typeof x.url === 'string' && /^https:\/\/[a-z0-9.-]*\.?(public\.)?blob\.vercel-storage\.com\//i.test(x.url))
            .map(x => ({ url: String(x.url).slice(0, 600), name: String(x.name || '').slice(0, 160), type: String(x.type || '').slice(0, 80), size: Number(x.size) || 0, kind: (x.kind === 'video' || x.kind === 'image' || x.kind === 'file') ? x.kind : 'file' }))
            .slice(0, 6),
          links: extractLinks(text),
          mentions: (Array.isArray(m.mentions) ? m.mentions : [])
            .filter(x => x && x.id && x.name)
            .map(x => ({ id: String(x.id).slice(0, 64), name: String(x.name).slice(0, 80) }))
            .slice(0, 30),
          replyTo: (m.replyTo && m.replyTo.id) ? { id: String(m.replyTo.id).slice(0, 40), name: String(m.replyTo.name || '').slice(0, 80), text: String(m.replyTo.text || '').slice(0, 140) } : null,
          reactions: {},
          createdAt: new Date().toISOString(),
        };
        const nextReads = { ...reads, [rec.fromStaffId]: { ...(reads[rec.fromStaffId] || {}), [rid]: Date.parse(rec.createdAt) } };
        // このルームのメッセージのみ書込。KVはアトミック追記（同時送信でも消えない）。失敗時は読込→追記→書込へフォールバック。
        if (hasKV) {
          try { await kvAppendJson(CHAT_MSG_PREFIX + rid, rec, CHAT_MSG_CAP); }
          catch { await saveRoomMsgs(rid, (await getRoomMsgs(rid)).concat(rec).slice(-CHAT_MSG_CAP)); }
        } else {
          await saveRoomMsgs(rid, (await getRoomMsgs(rid)).concat(rec).slice(-CHAT_MSG_CAP));
        }
        await saveReads(nextReads);                    // 送信者の既読を更新（別キー）
        // プッシュ通知（通知は1メッセージにつき1通のみ＝重複防止）。メンション情報を渡し、
        // 「メンションのみ受信」設定の人には該当時だけ届く（sendPush側で購読者ごとに判定）。
        const room = rooms.find(r => r && r.id === rid);
        const mentionAll = rec.mentions.some(x => x.id === '__all__');
        const mentionIds = rec.mentions.map(x => String(x.id)).filter(id => id && id !== '__all__' && id !== rec.fromStaffId);
        const mediaLabel = rec.media && rec.media.length ? (rec.media[0].kind === 'video' ? '🎬 動画' : '📎 ファイル') : '';
        const bodyText = (rec.text || (rec.imgIds.length ? '📷 画像' : (mediaLabel || '新着メッセージ'))).slice(0, 120);
        if (room && (room.kind === 'group' || room.kind === 'dm' || room.kind === 'announce')) {
          // ⚠️ iOSのWebプッシュは「タイトルがアプリ名と異なる」と自動で "from NAORU" を付ける。
          //    タイトルをアプリ名(NAORU)に合わせ、送信者名/ルーム名は本文に入れて "from NAORU" 行を消す検証。
          const title = 'NAORU';
          const body = room.kind === 'dm' ? `${rec.fromName}：${bodyText}` : `${room.name}／${rec.fromName}：${bodyText}`;
          const targets = (room.kind === 'announce') ? null // 全員
            : (room.members || []).map(String).filter(id => id !== rec.fromStaffId); // 送信者以外のメンバー
          if (!(Array.isArray(targets) && targets.length === 0)) {
            sendPush(hasKV, hasSB, gas, { kind: 'chat', roomId: rid, title, body: body.slice(0, 150), url: '/?tab=chat' }, targets, { mentionIds, mentionAll });
          }
        } else if (room && room.kind === 'store' && mentionIds.length) {
          // 店舗ルームは通常のルーム通知はしない（スパム回避）が、名指しされた本人にだけ1通届ける。
          sendPush(hasKV, hasSB, gas, { kind: 'chat', roomId: rid, title: 'NAORU', body: `🔔 ${room.name || 'チャット'}／${rec.fromName}：${bodyText}`.slice(0, 150), url: '/?tab=chat' }, mentionIds, { mentionIds, mentionAll });
        }
        return res.status(200).json({ ok: true, message: rec });
      }

      // 画像アップロード（1枚1キー）。dataUrl（data:image/...;base64,） を保存し id を返す。
      if (action === 'uploadImage' && body.dataUrl) {
        const dataUrl = String(body.dataUrl);
        if (!/^data:image\/(png|jpe?g|gif|webp);base64,/.test(dataUrl)) return res.status(400).json({ ok: false, error: 'bad_image' });
        if (dataUrl.length > 3_500_000) return res.status(413).json({ ok: false, error: 'too_large' }); // ~2.6MB相当
        const id = genId('img');
        await blobSet(CHAT_IMG_PREFIX + id, dataUrl, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, id });
      }

      // リアクション トグル
      if (action === 'react' && body.roomId && body.msgId && body.emoji && body.staffId) {
        const rid = String(body.roomId);
        const arr = (await getRoomMsgs(rid)).map(msg =>
          msg && msg.id === String(body.msgId) ? { ...msg, reactions: toggleReaction(msg.reactions, String(body.emoji), String(body.staffId)) } : msg
        );
        await saveRoomMsgs(rid, arr);
        return res.status(200).json({ ok: true });
      }

      // 既読ポインタ更新
      if (action === 'read' && body.roomId && body.staffId) {
        const sid = String(body.staffId), rid = String(body.roomId);
        const ts = Number(body.ts) || Date.now();
        const nextReads = { ...reads, [sid]: { ...(reads[sid] || {}), [rid]: ts } };
        await saveReads(nextReads);                    // 既読のみ別キーへ（messages/rooms を巻き込まない）
        return res.status(200).json({ ok: true });
      }

      // メッセージ削除（本人 or root）
      if (action === 'deleteMsg' && body.roomId && body.msgId) {
        const rid = String(body.roomId);
        const arr = (await getRoomMsgs(rid)).filter(msg => {
          if (!msg || msg.id !== String(body.msgId)) return true;
          return !(body.root || String(msg.fromStaffId) === String(body.staffId)); // 本人/rootのみ削除可
        });
        await saveRoomMsgs(rid, arr);
        return res.status(200).json({ ok: true });
      }

      // ルーム削除（group/dm のみ・作成者 or root）。announce/store は消せない。
      if (action === 'deleteRoom' && body.roomId) {
        const rid = String(body.roomId);
        const target = rooms.find(r => r && r.id === rid);
        if (!target || target.kind === 'announce' || target.kind === 'store') return res.status(400).json({ ok: false, error: 'not_deletable' });
        if (!(body.root || String(target.createdBy) === String(body.staffId))) return res.status(403).json({ ok: false, error: 'forbidden' });
        const nextRooms = rooms.filter(r => r && r.id !== rid);
        await save({ rooms: nextRooms }); await saveRoomMsgs(rid, []);   // ルーム削除＝そのルームのメッセージも空に（索引からも除去）
        return res.status(200).json({ ok: true });
      }

      // ノート更新をメンバーへ通知（📌）。add/edit 共通。
      const notifyNote = (room, rec, verb) => {
        if (!room) return;
        const roomLabel = room.name || (room.kind === 'dm' ? rec.fromName : 'ノート');
        const targets = room.kind === 'announce' ? null : (room.members || []).map(String).filter(id => id !== String(rec.fromStaffId));
        if (Array.isArray(targets) && targets.length === 0) return;
        const snippet = (rec.text || '📷 画像').slice(0, 80);
        sendPush(hasKV, hasSB, gas, { kind: 'chat', roomId: room.id, title: 'NAORU', body: `📌 ${roomLabel}／ノートが${verb}されました: ${snippet}`.slice(0, 150), url: '/?tab=chat' }, targets, {});
      };
      // ノート追加（ルームの固定メモ。テキスト＋画像＋リンク＋リアクション）。ルームメンバー or root。
      if (action === 'noteAdd' && body.roomId && body.note) {
        const rid = String(body.roomId);
        const room = rooms.find(r => r && r.id === rid);
        if (!room) return res.status(404).json({ ok: false, error: 'not_found' });
        const n = body.note;
        const now = new Date().toISOString();
        const rec = {
          id: genId('note'),
          fromStaffId: String(n.fromStaffId || ''),
          fromName: String(n.fromName || '').slice(0, 80),
          text: String(n.text || '').slice(0, 4000),
          imgIds: (Array.isArray(n.imgIds) ? n.imgIds : []).map(String).slice(0, 6),
          links: extractLinks(String(n.text || '')),
          reactions: {},
          createdAt: now, updatedAt: now,
        };
        if (!rec.text && rec.imgIds.length === 0) return res.status(400).json({ ok: false, error: 'empty' });
        const arr = [rec, ...(Array.isArray(notes[rid]) ? notes[rid] : [])].slice(0, 200);
        await save({ notes: { ...notes, [rid]: arr } });
        notifyNote(room, rec, '追加');
        return res.status(200).json({ ok: true, note: rec });
      }
      // ノート編集（投稿者本人 or root）。
      if (action === 'noteEdit' && body.roomId && body.noteId && body.note) {
        const rid = String(body.roomId);
        const room = rooms.find(r => r && r.id === rid);
        const cur = Array.isArray(notes[rid]) ? notes[rid] : [];
        const idx = cur.findIndex(x => x && x.id === String(body.noteId));
        if (idx < 0) return res.status(404).json({ ok: false, error: 'not_found' });
        const target = cur[idx];
        if (!(body.root || String(target.fromStaffId) === String(body.staffId))) return res.status(403).json({ ok: false, error: 'forbidden' });
        const n = body.note;
        const text = String(n.text || '').slice(0, 4000);
        const imgIds = (Array.isArray(n.imgIds) ? n.imgIds : []).map(String).slice(0, 6);
        if (!text && imgIds.length === 0) return res.status(400).json({ ok: false, error: 'empty' });
        const updated = { ...target, text, imgIds, links: extractLinks(text), updatedAt: new Date().toISOString() };
        const arr = cur.map((x, i) => i === idx ? updated : x);
        await save({ notes: { ...notes, [rid]: arr } });
        notifyNote(room, updated, '更新');
        return res.status(200).json({ ok: true, note: updated });
      }
      // ノートへのリアクション（スタンプ）トグル。
      if (action === 'noteReact' && body.roomId && body.noteId && body.emoji && body.staffId) {
        const rid = String(body.roomId);
        const arr = (Array.isArray(notes[rid]) ? notes[rid] : []).map(x => x && x.id === String(body.noteId) ? { ...x, reactions: toggleReaction(x.reactions, String(body.emoji), String(body.staffId)) } : x);
        await save({ notes: { ...notes, [rid]: arr } });
        return res.status(200).json({ ok: true });
      }
      if (action === 'noteDelete' && body.roomId && body.noteId) {
        const rid = String(body.roomId);
        const arr = (Array.isArray(notes[rid]) ? notes[rid] : []).filter(x => !(x.id === String(body.noteId) && (body.root || String(x.fromStaffId) === String(body.staffId))));
        await save({ notes: { ...notes, [rid]: arr } });
        return res.status(200).json({ ok: true });
      }
      // 管理: あるユーザーID(fromId)のチャット所属・発言・既読を別ID(toId)へ付け替える（root専用）。
      // 重複アカウント削除時に、旧IDで参加/受信していたルームを現アカウントに引き継ぐための復旧用。
      if (action === 'remapUser' && body.root && body.fromId && body.toId) {
        const from = String(body.fromId), to = String(body.toId);
        let changed = 0;
        const nextRooms = rooms.map(r => {
          if (!r) return r;
          const mem = (Array.isArray(r.members) ? r.members : []).map(String);
          const hit = mem.includes(from);
          const nm = [...new Set(mem.map(x => (x === from ? to : x)))];
          const cb = String(r.createdBy) === from ? to : r.createdBy;
          if (hit || cb !== r.createdBy) changed++;
          return { ...r, members: nm, createdBy: cb };
        });
        await save({ rooms: nextRooms });
        // 発言者IDの付け替え：全ルームのメッセージを読み、該当分を書き換える
        for (const r of nextRooms) {
          if (!r || !r.id) continue;
          const arr = await getRoomMsgs(r.id);
          if (!arr.length || !arr.some(m => m && String(m.fromStaffId) === from)) continue;
          const na = arr.map(m => (m && String(m.fromStaffId) === from ? { ...m, fromStaffId: to } : m));
          await saveRoomMsgs(r.id, na);
        }
        const nextReads = { ...reads };
        if (nextReads[from]) { nextReads[to] = { ...(nextReads[to] || {}), ...nextReads[from] }; delete nextReads[from]; }
        await saveReads(nextReads);
        return res.status(200).json({ ok: true, remapped: { from, to }, roomsChanged: changed });
      }

      // 管理: 旧集約メッセージをルーム別キーへ移行（root専用）。索引は廃止したので作らない。
      // per-roomキーが未作成のルームだけ、旧集約(CHAT_MSGS_KEY)/旧CHAT_KEY.messages から書き出す。
      if (action === 'migrateMsgs' && body.root) {
        const agg = await loadAgg();
        let migrated = 0;
        for (const [rid, arr] of Object.entries(agg)) {
          if (!Array.isArray(arr) || !arr.length) continue;
          const existing = await blobGet(CHAT_MSG_PREFIX + String(rid), hasKV, hasSB, gas);
          if (Array.isArray(existing) && existing.length) continue; // 既に移行済み
          await blobSet(CHAT_MSG_PREFIX + String(rid), arr, hasKV, hasSB, gas);
          migrated++;
        }
        return res.status(200).json({ ok: true, migrated });
      }
      return res.status(400).json({ ok: false, error: 'invalid chat action' });
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
    }
  }

  // ── サンクスギフト（感謝の投票）ストア: ?type=thanksgift ──
  // スタッフが月1票（前月の対象月へ）感謝を送る。全端末共有・月別に蓄積。
  const isThanks = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'thanksgift';
  if (isThanks) {
    if (!hasKV && !hasSB && !gas) return res.status(200).json({ votes: [], votingState: getVotingState(), configured: false });
    try {
      const cur = (await blobGet(THANKSGIFT_KEY, hasKV, hasSB, gas)) || {};
      const votes = Array.isArray(cur.votes) ? cur.votes : [];
      const log = Array.isArray(cur.log) ? cur.log : []; // 送信履歴（追記のみ・編集履歴を残す）
      const test = (cur.test && typeof cur.test === 'object') ? cur.test : { open: false, period: '' };
      // 公開済みの対象月。published=本部が手動で【前倒し公開】した月／unpublished=本部が緊急で【非公開に戻した】月。
      // 実効公開＝手動非公開でない かつ（手動公開 or 自動公開スケジュール到達）。自動公開＝翌月第2火曜13:00 JST（lib/thanksgift.js）。
      const published = Array.isArray(cur.published) ? cur.published.filter(p => /^\d{4}-\d{2}$/.test(String(p))).map(String) : [];
      const unpublished = Array.isArray(cur.unpublished) ? cur.unpublished.filter(p => /^\d{4}-\d{2}$/.test(String(p))).map(String) : [];
      // 全店ディレクトリ（店舗・スタッフ）: SSOでスコープされたスタッフでも「他店」へ感謝を送れるよう、
      // 広い閲覧権限のセッション（root/brand_admin等）が保存した全店の店舗・スタッフ一覧を共有する。
      const dir = (cur.dir && typeof cur.dir === 'object') ? { shops: Array.isArray(cur.dir.shops) ? cur.dir.shops : [], staff: Array.isArray(cur.dir.staff) ? cur.dir.staff : [], updatedAt: cur.dir.updatedAt || '' } : { shops: [], staff: [], updatedAt: '' };
      // スタッフ名寄せ（重複登録の統合）: { "重複ID": "正となるID" }。付け替え済みの票に加え、
      // 相手候補リスト（フロント）から重複IDを畳み込むために保持する。
      const merges = (cur.merges && typeof cur.merges === 'object' && !Array.isArray(cur.merges)) ? cur.merges : {};
      // テストモード: root が任意の対象月を「受付中」にできる（期間外テスト用）。通常は期間ロジックに従う。
      const base = getVotingState();
      const state = (test.open && /^\d{4}-\d{2}$/.test(String(test.period || '')))
        ? { ...base, open: true, targetMonth: String(test.period), test: true }
        : { ...base, test: false };
      if (req.method === 'GET') {
        // 実効公開（自動公開スケジュール＋本部の手動上書き）を算出してフロントへ返す。
        const now = Date.now();
        const periods = [...new Set([...listPeriods(votes), ...published, ...unpublished])];
        const effectivePublished = periods.filter(p => isPeriodPublished(p, published, unpublished, now));
        const publishSchedule = {};
        periods.forEach(p => { publishSchedule[p] = { effective: isPeriodPublished(p, published, unpublished, now), manualPub: published.includes(p), manualHide: unpublished.includes(p), autoLabel: autoPublishLabel(p) }; });
        return res.status(200).json({ votes, log, votingState: state, test, published: effectivePublished, publishManual: published, publishHidden: unpublished, publishSchedule, dir, merges, configured: true });
      }
      const body = req.body || {};
      const action = body.action;
      // 全店ディレクトリの保存（マージ）: 店舗・スタッフをidでupsert。広い権限のセッションが呼ぶ。
      if (action === 'setdir') {
        const mergeById = (base, incoming, keys) => {
          const map = new Map((Array.isArray(base) ? base : []).map(x => [String(x.id), x]));
          for (const it of (Array.isArray(incoming) ? incoming : [])) {
            const id = String(it && it.id || '');
            if (!id) continue;
            const prev = map.get(id) || {};
            const next = { id };
            for (const k of keys) next[k] = (it[k] != null && it[k] !== '') ? it[k] : prev[k];
            map.set(id, next);
          }
          return [...map.values()];
        };
        const nextDir = {
          shops: mergeById(dir.shops, body.shops, ['name']).slice(0, 500),
          staff: mergeById(dir.staff, body.staff, ['name', 'shopId', 'deleted']).slice(0, 8000),
          updatedAt: new Date().toISOString(),
        };
        await blobSet(THANKSGIFT_KEY, { votes, log, test, published, unpublished, dir: nextDir, merges }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, dir: nextDir });
      }
      // テストモードの切替（root用UIから。期間外でも指定月を受付にできる）
      if (action === 'settest') {
        const nextTest = { open: !!body.open, period: String(body.period || '') };
        await blobSet(THANKSGIFT_KEY, { votes, log, test: nextTest, published, unpublished, dir, merges }, hasKV, hasSB, gas);
        const st2 = (nextTest.open && /^\d{4}-\d{2}$/.test(nextTest.period))
          ? { ...base, open: true, targetMonth: nextTest.period, test: true }
          : { ...base, test: false };
        return res.status(200).json({ ok: true, test: nextTest, votingState: st2 });
      }
      // 公開/非公開の切替（root用UIから。指定した対象月の感謝を受け取った側に表示するか）
      if (action === 'publish' && /^\d{4}-\d{2}$/.test(String(body.period || ''))) {
        const p = String(body.period);
        const pub = new Set(published), unpub = new Set(unpublished);
        if (body.publish === false) { unpub.add(p); pub.delete(p); }   // 緊急で非公開に戻す（自動公開も上書きで隠す）
        else { pub.add(p); unpub.delete(p); }                          // 前倒しで公開（非公開上書きを解除）
        const nextPublished = [...pub], nextUnpublished = [...unpub];
        await blobSet(THANKSGIFT_KEY, { votes, log, test, published: nextPublished, unpublished: nextUnpublished, dir, merges }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, published: nextPublished, unpublished: nextUnpublished });
      }
      if (action === 'vote' && body.vote) {
        const v = body.vote;
        // サーバー側でも投票期間・対象月・自分不可を強制（UIすり抜け防止）
        if (!state.open) return res.status(200).json({ ok: false, error: 'closed', votingState: state });
        if (String(v.period) !== String(state.targetMonth)) return res.status(200).json({ ok: false, error: 'wrong_period', votingState: state });
        const chk = validateVote(v);
        if (!chk.ok) return res.status(200).json({ ok: false, error: chk.error });
        const rec = {
          period: String(v.period),
          fromStaffId: String(v.fromStaffId), fromStaffName: String(v.fromStaffName || ''), fromShop: String(v.fromShop || ''),
          toStaffId: String(v.toStaffId), toStaffName: String(v.toStaffName || ''), toShop: String(v.toShop || ''),
          comment: String(v.comment || '').slice(0, 500),
          createdAt: new Date().toISOString(),
        };
        const next = upsertVote(votes, rec);
        // 送信履歴に追記（編集も1件ずつ残す）。上限3000件でリングバッファ。
        const already = votes.some(x => x && x.id === `${rec.period}__${rec.fromStaffId}`);
        const nextLog = [...log, { ...rec, action: already ? 'edit' : 'submit', id: `${rec.period}__${rec.fromStaffId}__${Date.now()}` }].slice(-3000);
        await blobSet(THANKSGIFT_KEY, { votes: next, log: nextLog, test, published, unpublished, dir, merges }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, id: `${rec.period}__${rec.fromStaffId}` });
      }
      if (action === 'delete' && body.period && body.fromStaffId) {
        if (!state.open || String(body.period) !== String(state.targetMonth)) {
          return res.status(200).json({ ok: false, error: 'closed', votingState: state });
        }
        const next = removeVote(votes, String(body.period), String(body.fromStaffId));
        const nextLog = [...log, { period: String(body.period), fromStaffId: String(body.fromStaffId), action: 'delete', createdAt: new Date().toISOString(), id: `${body.period}__${body.fromStaffId}__${Date.now()}` }].slice(-3000);
        await blobSet(THANKSGIFT_KEY, { votes: next, log: nextLog, test, published, unpublished, dir, merges }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      // 管理者用: 指定(period+fromStaffId)の票を votes と log の両方から完全削除（テストデータ整理）。
      // items: [{period, fromStaffId}, ...]。送信履歴(log)からも消えるため送信者/受信者どちらの画面にも残らない。
      if (action === 'purge' && Array.isArray(body.items) && body.items.length) {
        const keyset = new Set(body.items.map(it => `${String(it.period)}__${String(it.fromStaffId)}`));
        const nextVotes = votes.filter(v => !keyset.has(`${String(v.period)}__${String(v.fromStaffId)}`));
        const nextLog = log.filter(l => !keyset.has(`${String(l.period)}__${String(l.fromStaffId)}`));
        await blobSet(THANKSGIFT_KEY, { votes: nextVotes, log: nextLog, test, published, unpublished, dir, merges }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, removedVotes: votes.length - nextVotes.length, removedLog: log.length - nextLog.length });
      }
      // 管理者用: スタッフ名寄せ（重複登録の統合）。fromId 宛/発の全票を toId へ付け替え、
      // fromId を merges マップに記録して以降の相手候補からも畳み込む。
      // body: { fromId, toId, toName?, toShop? }
      if (action === 'reassignStaff' && body.fromId && body.toId && String(body.fromId) !== String(body.toId)) {
        const fromId = String(body.fromId), toId = String(body.toId);
        const toName = String(body.toName || '');
        const toShop = String(body.toShop || '');
        let changed = 0;
        const rewrite = (v) => {
          if (!v || typeof v !== 'object') return v;
          let nv = v, hit = false;
          if (String(v.toStaffId) === fromId) {
            nv = { ...nv, toStaffId: toId, toStaffName: toName || nv.toStaffName, toShop: toShop || nv.toShop };
            hit = true;
          }
          if (String(v.fromStaffId) === fromId) {
            nv = { ...nv, fromStaffId: toId, fromStaffName: toName || nv.fromStaffName, fromShop: toShop || nv.fromShop };
            if (nv.id) nv.id = `${nv.period}__${toId}`;
            hit = true;
          }
          if (hit) changed++;
          return nv;
        };
        // 票を付け替え、fromStaffId 変更で id 衝突が起きた場合は後勝ちで1件に統合。
        const rewritten = votes.map(rewrite);
        const vmap = new Map();
        for (const v of rewritten) vmap.set(`${v.period}__${v.fromStaffId}`, v);
        const nextVotes = [...vmap.values()];
        const nextLog = log.map(rewrite);
        // dir から重複スタッフを非表示化（deleted）し、merges に記録。
        const nextDir = { ...dir, staff: (dir.staff || []).map(s => String(s.id) === fromId ? { ...s, deleted: true } : s) };
        const nextMerges = { ...merges, [fromId]: toId };
        await blobSet(THANKSGIFT_KEY, { votes: nextVotes, log: nextLog, test, published, unpublished, dir: nextDir, merges: nextMerges }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, changed, votes: nextVotes.length, merges: nextMerges });
      }
      return res.status(400).json({ ok: false, error: 'invalid thanksgift action' });
    } catch (err) {
      return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
    }
  }

  if (!hasKV && !hasSB && !gas) {
    // 保存先未設定 → フロントはlocalStorageで継続（壊さない）
    return res.status(200).json({ goals: {}, actions: [], configured: false });
  }

  try {
    if (req.method === 'GET') {
      if (hasKV) {
        const [goals, actions] = await Promise.all([kvGet(GOALS_KEY), kvGet(ACTIONS_KEY)]);
        return res.status(200).json({ goals: goals || {}, actions: Array.isArray(actions) ? actions : [], configured: true });
      }
      if (hasSB) {
        const [goals, actions] = await Promise.all([sbGet(GOALS_KEY), sbGet(ACTIONS_KEY)]);
        return res.status(200).json({ goals: goals || {}, actions: Array.isArray(actions) ? actions : [], configured: true });
      }
      const j = await gasCall(`${gas}?type=planStore`, 'GET');
      return res.status(200).json({ goals: (j && j.goals) || {}, actions: Array.isArray(j && j.actions) ? j.actions : [], configured: true });
    }
    if (req.method === 'POST') {
      const body = req.body || {};
      const goals = body.goals || {};
      const actions = Array.isArray(body.actions) ? body.actions : [];
      if (hasKV) {
        await Promise.all([kvSet(GOALS_KEY, goals), kvSet(ACTIONS_KEY, actions)]);
        return res.status(200).json({ ok: true });
      }
      if (hasSB) {
        await Promise.all([sbSet(GOALS_KEY, goals), sbSet(ACTIONS_KEY, actions)]);
        return res.status(200).json({ ok: true });
      }
      const j = await gasCall(gas, 'POST', { action: 'savePlanStore', goals, actions });
      return res.status(200).json((j && j.ok) ? { ok: true } : { ok: false, error: (j && j.error) || 'save_failed' });
    }
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    // 失敗してもフロントはlocalStorageで継続できるよう 200
    return res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err) });
  }
}
