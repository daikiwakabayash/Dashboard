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

import { getVotingState, validateVote, upsertVote, removeVote } from '../lib/thanksgift.js';
import { ensureBaseRooms, extractLinks, toggleReaction, genId } from '../lib/chat.js';
import { videoEmbed } from '../lib/board.js';

// Vercel KV / Upstash Redis / Vercel Redis いずれの環境変数名でも動くよう両対応（REST APIは共通）
const KV_URL = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_REST_API_URL || '';
const KV_TOKEN = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_API_TOKEN || '';
const SB_URL = () => process.env.SUPABASE_URL || '';
const SB_KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
const GAS_URL = () => process.env.PLAN_GAS_URL || process.env.SETTLEMENT_GAS_URL || '';
const GOALS_KEY = 'naoru:plan:goals';
const ACTIONS_KEY = 'naoru:plan:actions';
const ALLOWANCE_KEY = 'naoru:allowance:v1'; // { submissions:[...], productivity:{staffId:{'YYYY-MM':gross}} }
const ACCTMETA_KEY = 'naoru:accountmeta:v1'; // { owner: { role, staffId, staffName } }
const ZKTHERAPIST_KEY = 'naoru:zktherapist:v1'; // { 'shopName|YYYY-MM': count } 全体管理シートのセラピスト数 手動上書き
const THANKSGIFT_KEY = 'naoru:thanksgift:v1'; // { votes:[{id,period,fromStaffId,fromStaffName,fromShop,toStaffId,toStaffName,toShop,comment,createdAt}] } サンクスギフト投票
const CHAT_KEY = 'naoru:chat:v1';             // { rooms:[...], messages:{roomId:[...]}, reads:{staffId:{roomId:ms}}, dir:{staff:[...]} } 社内チャット
const CHAT_IMG_PREFIX = 'naoru:chat:img:';    // 画像は1枚1キーで別保存（blob肥大化を避ける）
const CHAT_MSG_CAP = 400;                     // 1ルームあたり保持する最大メッセージ数（古いものから破棄）
const BOARD_KEY = 'naoru:board:v1';           // { posts:[...], reads:{staffId:ms} } 掲示板（全社発信）
const BOARD_FILE_PREFIX = 'naoru:board:file:';// 添付ファイルは1件1キーで別保存
const BOARD_POST_CAP = 500;                   // 保持する最大投稿数
const PUSH_KEY = 'naoru:push:v1';             // { subs:[{endpoint,keys,staffId,name,createdAt}] } Webプッシュ購読
const EVENTS_KEY = 'naoru:events:v1';         // { sections:{study:[row],event:[row],bukatsu:[row]} } 勉強会・イベント日程（共有編集）
const PROFILE_KEY = 'naoru:profile:v1';       // { profiles:{pid:{kind,nameKanji,nameKana,bio,mainImg,subImgs,sns,shops,birthday,updatedAt}} } スタッフ/オーナーのプロフィール（組織図で表示・店舗割当の上書き・birthday=誕生日の当日表示）

// ── Webプッシュ送信（VAPID設定時のみ動作・未設定なら黙ってスキップ） ──
const VAPID_PUBLIC = () => process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = () => process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = () => process.env.VAPID_SUBJECT || 'mailto:admin@naoru.example';
// 対象購読へ通知を送る。web-push は動的import（未インストール環境でもハンドラは壊れない）。
// filterStaffIds が配列なら、その staffId の購読のみへ送信（未指定＝全員）。
async function sendPush(hasKV, hasSB, gas, payload, filterStaffIds) {
  try {
    if (!VAPID_PUBLIC() || !VAPID_PRIVATE()) return; // 未設定＝無効
    const mod = await import('web-push').catch(() => null);
    const webpush = mod && (mod.default || mod);
    if (!webpush) return;
    webpush.setVapidDetails(VAPID_SUBJECT(), VAPID_PUBLIC(), VAPID_PRIVATE());
    const store = (await blobGet(PUSH_KEY, hasKV, hasSB, gas)) || {};
    let subs = Array.isArray(store.subs) ? store.subs : [];
    const only = Array.isArray(filterStaffIds) ? new Set(filterStaffIds.map(String)) : null;
    const targets = only ? subs.filter(s => only.has(String(s.staffId))) : subs;
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const hasKV = !!(KV_URL() && KV_TOKEN());
  const hasSB = !!(SB_URL() && SB_KEY());
  const gas = GAS_URL();

  // ── 手当（領収書）ストア: ?type=allowance / body.type==='allowance' ──
  const isAllowance = (req.method === 'GET' ? req.query.type : (req.body || {}).type) === 'allowance';
  if (isAllowance) {
    if (!hasKV && !hasSB && !gas) return res.status(200).json({ submissions: [], productivity: {}, configured: false });
    try {
      const cur = (await blobGet(ALLOWANCE_KEY, hasKV, hasSB, gas)) || {};
      const submissions = Array.isArray(cur.submissions) ? cur.submissions : [];
      const productivity = (cur.productivity && typeof cur.productivity === 'object') ? cur.productivity : {};
      if (req.method === 'GET') {
        return res.status(200).json({ submissions, productivity, configured: true });
      }
      const body = req.body || {};
      const action = body.action;
      if (action === 'submit' && body.submission && body.submission.id) {
        const s = body.submission;
        const next = submissions.filter(x => x && x.id !== s.id);
        next.push(s);
        await blobSet(ALLOWANCE_KEY, { submissions: next, productivity }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, id: s.id });
      }
      if (action === 'delete' && body.id) {
        const next = submissions.filter(x => x && x.id !== body.id);
        await blobSet(ALLOWANCE_KEY, { submissions: next, productivity }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      if (action === 'recordProductivity' && body.staffId && body.month) {
        const p = { ...productivity };
        p[String(body.staffId)] = { ...(p[String(body.staffId)] || {}), [String(body.month)]: Number(body.gross) || 0 };
        await blobSet(ALLOWANCE_KEY, { submissions, productivity: p }, hasKV, hasSB, gas);
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
    if (!hasKV && !hasSB && !gas) return res.status(200).json({ posts: [], reads: {}, configured: false });
    try {
      // 添付ファイル取得: GET ?type=board&file=<id> → { name, dataUrl }
      if (req.method === 'GET' && req.query.file) {
        const f = await blobGet(BOARD_FILE_PREFIX + String(req.query.file), hasKV, hasSB, gas);
        if (!f) return res.status(404).json({ ok: false, error: 'not_found' });
        return res.status(200).json({ ok: true, ...f });
      }
      const cur = (await blobGet(BOARD_KEY, hasKV, hasSB, gas)) || {};
      const posts = Array.isArray(cur.posts) ? cur.posts : [];
      const reads = (cur.reads && typeof cur.reads === 'object') ? cur.reads : {};
      if (req.method === 'GET') return res.status(200).json({ posts, reads, configured: true });

      const body = req.body || {};
      const action = body.action;

      if (action === 'post' && body.post) {
        const p = body.post;
        const text = String(p.text || '').slice(0, 8000);
        const title = String(p.title || '').slice(0, 200);
        const rec = {
          id: genId('post'),
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
        const nextPosts = [rec, ...posts].slice(0, BOARD_POST_CAP);
        await blobSet(BOARD_KEY, { posts: nextPosts, reads: { ...reads, [rec.authorId]: Date.now() } }, hasKV, hasSB, gas);
        // 全員へプッシュ（購読者全員）
        sendPush(hasKV, hasSB, gas, { kind: 'board', title: `${rec.important ? '❗' : '📣'} ${title || rec.authorName || 'お知らせ'}`, body: (title ? text : text).slice(0, 120) || '新しい掲示があります', url: '/?tab=board' });
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
        const nextPosts = posts.map(p => p && p.id === String(body.id) ? { ...p, pinned: !!body.pinned } : p);
        await blobSet(BOARD_KEY, { posts: nextPosts, reads }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      if (action === 'react' && body.id && body.emoji && body.staffId) {
        const nextPosts = posts.map(p => p && p.id === String(body.id) ? { ...p, reactions: toggleReaction(p.reactions, String(body.emoji), String(body.staffId)) } : p);
        // リアクション＝閲覧とみなし、その人の既読も進める
        const nextReads = { ...reads, [String(body.staffId)]: Math.max(Number(reads[String(body.staffId)]) || 0, Date.now()) };
        await blobSet(BOARD_KEY, { posts: nextPosts, reads: nextReads }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      if (action === 'delete' && body.id) {
        const nextPosts = posts.filter(p => {
          if (!p || p.id !== String(body.id)) return true;
          return !(body.root || String(p.authorId) === String(body.staffId)); // 本人/rootのみ削除
        });
        await blobSet(BOARD_KEY, { posts: nextPosts, reads }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      if (action === 'read' && body.staffId) {
        await blobSet(BOARD_KEY, { posts, reads: { ...reads, [String(body.staffId)]: Number(body.ts) || Date.now() } }, hasKV, hasSB, gas);
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
          kind: p.kind === 'owner' ? 'owner' : 'therapist',
          nameKanji: String(p.nameKanji || '').slice(0, 60),
          nameKana: String(p.nameKana || '').slice(0, 60),
          bio: String(p.bio || '').slice(0, 2000),
          mainImg: String(p.mainImg || '').slice(0, 64),
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
      // 公開鍵とプッシュ有効状態を返す（フロントが購読に使う）
      if (req.method === 'GET') {
        return res.status(200).json({ enabled: !!(VAPID_PUBLIC() && VAPID_PRIVATE()), publicKey: VAPID_PUBLIC(), configured: !!(hasKV || hasSB || gas) });
      }
      if (!hasKV && !hasSB && !gas) return res.status(200).json({ ok: false, configured: false });
      const body = req.body || {};
      const store = (await blobGet(PUSH_KEY, hasKV, hasSB, gas)) || {};
      const subs = Array.isArray(store.subs) ? store.subs : [];
      if (body.action === 'subscribe' && body.subscription && body.subscription.endpoint) {
        const s = body.subscription;
        const rec = { endpoint: String(s.endpoint), keys: s.keys || {}, staffId: String(body.staffId || ''), name: String(body.name || '').slice(0, 80), createdAt: new Date().toISOString() };
        const next = subs.filter(x => x && x.endpoint !== rec.endpoint).concat(rec).slice(-5000);
        await blobSet(PUSH_KEY, { subs: next }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
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
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // 画像はid固定=不変
            return res.status(200).send(Buffer.from(m[2], 'base64'));
          }
        }
        return res.status(200).json({ ok: true, dataUrl });
      }
      const cur = (await blobGet(CHAT_KEY, hasKV, hasSB, gas)) || {};
      const rooms = Array.isArray(cur.rooms) ? cur.rooms : [];
      const messages = (cur.messages && typeof cur.messages === 'object') ? cur.messages : {};
      const reads = (cur.reads && typeof cur.reads === 'object') ? cur.reads : {};
      const dir = (cur.dir && typeof cur.dir === 'object') ? { staff: Array.isArray(cur.dir.staff) ? cur.dir.staff : [], updatedAt: cur.dir.updatedAt || '' } : { staff: [], updatedAt: '' };
      const save = (patch) => blobSet(CHAT_KEY, { rooms, messages, reads, dir, ...patch }, hasKV, hasSB, gas);

      if (req.method === 'GET') {
        return res.status(200).json({ rooms, messages, reads, dir, configured: true });
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
        const r = body.room;
        const room = {
          id: r.id ? String(r.id) : genId('room'),
          kind: (r.kind === 'dm' || r.kind === 'group') ? r.kind : 'group',
          name: String(r.name || '').slice(0, 60),
          icon: String(r.icon || '').slice(0, 16),
          shop: String(r.shop || ''),
          members: (Array.isArray(r.members) ? r.members : []).map(String).slice(0, 500),
          createdBy: String(r.createdBy || ''),
          createdAt: new Date().toISOString(),
        };
        const nextRooms = rooms.filter(x => x && x.id !== room.id).concat(room);
        await save({ rooms: nextRooms });
        return res.status(200).json({ ok: true, room });
      }

      // グループのメンバー変更（招待/退会）。group のみ・メンバー or root。
      if (action === 'setMembers' && body.roomId && Array.isArray(body.members)) {
        const rid = String(body.roomId);
        const room = rooms.find(r => r && r.id === rid);
        if (!room || room.kind !== 'group') return res.status(400).json({ ok: false, error: 'not_group' });
        const isMember = (room.members || []).map(String).includes(String(body.staffId));
        if (!(body.root || isMember)) return res.status(403).json({ ok: false, error: 'forbidden' });
        const members = [...new Set(body.members.map(String))].slice(0, 500);
        const nextRooms = rooms.map(r => r && r.id === rid ? { ...r, members } : r);
        await save({ rooms: nextRooms });
        return res.status(200).json({ ok: true, members });
      }

      // グループ名・アイコン変更。group のみ・メンバー or root。
      if (action === 'setRoom' && body.roomId) {
        const rid = String(body.roomId);
        const room = rooms.find(r => r && r.id === rid);
        if (!room || room.kind !== 'group') return res.status(400).json({ ok: false, error: 'not_group' });
        const isMember = (room.members || []).map(String).includes(String(body.staffId));
        if (!(body.root || isMember)) return res.status(403).json({ ok: false, error: 'forbidden' });
        const patch = {};
        if (typeof body.name === 'string') patch.name = body.name.slice(0, 60);
        if (typeof body.icon === 'string') patch.icon = body.icon.slice(0, 16);
        const nextRooms = rooms.map(r => r && r.id === rid ? { ...r, ...patch } : r);
        await save({ rooms: nextRooms });
        return res.status(200).json({ ok: true, room: { ...room, ...patch } });
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
          links: extractLinks(text),
          mentions: (Array.isArray(m.mentions) ? m.mentions : [])
            .filter(x => x && x.id && x.name)
            .map(x => ({ id: String(x.id).slice(0, 64), name: String(x.name).slice(0, 80) }))
            .slice(0, 30),
          reactions: {},
          createdAt: new Date().toISOString(),
        };
        const arr = (Array.isArray(messages[rid]) ? messages[rid] : []).concat(rec).slice(-CHAT_MSG_CAP);
        const nextMessages = { ...messages, [rid]: arr };
        const nextReads = { ...reads, [rec.fromStaffId]: { ...(reads[rec.fromStaffId] || {}), [rid]: Date.parse(rec.createdAt) } };
        await save({ messages: nextMessages, reads: nextReads });
        // プッシュ通知: グループ/DM/全社アナウンスの新着を対象者へ（店舗ルームはスパム回避のため送らない）
        const room = rooms.find(r => r && r.id === rid);
        if (room && (room.kind === 'group' || room.kind === 'dm' || room.kind === 'announce')) {
          const title = room.kind === 'dm' ? `💬 ${rec.fromName}` : `💬 ${room.name}`;
          const bodyText = (rec.text || (rec.imgIds.length ? '📷 画像' : '新着メッセージ')).slice(0, 120);
          const targets = (room.kind === 'announce') ? null // 全員
            : (room.members || []).map(String).filter(id => id !== rec.fromStaffId); // 送信者以外のメンバー
          if (!(Array.isArray(targets) && targets.length === 0)) {
            sendPush(hasKV, hasSB, gas, { kind: 'chat', roomId: rid, title, body: bodyText, url: '/?tab=chat' }, targets);
          }
        }
        // メンション通知: 店舗ルーム等でルーム通知の対象外でも、名指しされた本人には必ず届ける。
        // @全員(__all__)は全員宛（announceで既に全員に送っている場合は送信者以外へ）。
        if (rec.mentions.length && room) {
          const roomTitle = room.kind === 'dm' ? rec.fromName : (room.name || 'チャット');
          const mBody = (rec.text || '📷 画像').slice(0, 120);
          const hasAll = rec.mentions.some(x => x.id === '__all__');
          const mentionTargets = hasAll ? null : rec.mentions.map(x => String(x.id)).filter(id => id && id !== rec.fromStaffId);
          // group/dm/announce は上でルーム通知済み。店舗ルームや、@全員以外の名指しのみ追加送信。
          if (room.kind === 'store' || (mentionTargets && mentionTargets.length)) {
            const t2 = (mentionTargets && mentionTargets.length) ? mentionTargets : null;
            if (!(Array.isArray(t2) && t2.length === 0)) {
              sendPush(hasKV, hasSB, gas, { kind: 'chat', roomId: rid, title: `🔔 ${rec.fromName} さんがメンション`, body: `${roomTitle}: ${mBody}`, url: '/?tab=chat' }, t2);
            }
          }
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
        const arr = (Array.isArray(messages[rid]) ? messages[rid] : []).map(msg =>
          msg && msg.id === String(body.msgId) ? { ...msg, reactions: toggleReaction(msg.reactions, String(body.emoji), String(body.staffId)) } : msg
        );
        await save({ messages: { ...messages, [rid]: arr } });
        return res.status(200).json({ ok: true });
      }

      // 既読ポインタ更新
      if (action === 'read' && body.roomId && body.staffId) {
        const sid = String(body.staffId), rid = String(body.roomId);
        const ts = Number(body.ts) || Date.now();
        const nextReads = { ...reads, [sid]: { ...(reads[sid] || {}), [rid]: ts } };
        await save({ reads: nextReads });
        return res.status(200).json({ ok: true });
      }

      // メッセージ削除（本人 or root）
      if (action === 'deleteMsg' && body.roomId && body.msgId) {
        const rid = String(body.roomId);
        const arr = (Array.isArray(messages[rid]) ? messages[rid] : []).filter(msg => {
          if (!msg || msg.id !== String(body.msgId)) return true;
          return !(body.root || String(msg.fromStaffId) === String(body.staffId)); // 本人/rootのみ削除可
        });
        await save({ messages: { ...messages, [rid]: arr } });
        return res.status(200).json({ ok: true });
      }

      // ルーム削除（group/dm のみ・作成者 or root）。announce/store は消せない。
      if (action === 'deleteRoom' && body.roomId) {
        const rid = String(body.roomId);
        const target = rooms.find(r => r && r.id === rid);
        if (!target || target.kind === 'announce' || target.kind === 'store') return res.status(400).json({ ok: false, error: 'not_deletable' });
        if (!(body.root || String(target.createdBy) === String(body.staffId))) return res.status(403).json({ ok: false, error: 'forbidden' });
        const nextRooms = rooms.filter(r => r && r.id !== rid);
        const nextMessages = { ...messages }; delete nextMessages[rid];
        await save({ rooms: nextRooms, messages: nextMessages });
        return res.status(200).json({ ok: true });
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
      // 公開済みの対象月（root が【公開】した月のみ、受け取った側に感謝内容が表示される）
      const published = Array.isArray(cur.published) ? cur.published.filter(p => /^\d{4}-\d{2}$/.test(String(p))).map(String) : [];
      // 全店ディレクトリ（店舗・スタッフ）: SSOでスコープされたスタッフでも「他店」へ感謝を送れるよう、
      // 広い閲覧権限のセッション（root/brand_admin等）が保存した全店の店舗・スタッフ一覧を共有する。
      const dir = (cur.dir && typeof cur.dir === 'object') ? { shops: Array.isArray(cur.dir.shops) ? cur.dir.shops : [], staff: Array.isArray(cur.dir.staff) ? cur.dir.staff : [], updatedAt: cur.dir.updatedAt || '' } : { shops: [], staff: [], updatedAt: '' };
      // テストモード: root が任意の対象月を「受付中」にできる（期間外テスト用）。通常は期間ロジックに従う。
      const base = getVotingState();
      const state = (test.open && /^\d{4}-\d{2}$/.test(String(test.period || '')))
        ? { ...base, open: true, targetMonth: String(test.period), test: true }
        : { ...base, test: false };
      if (req.method === 'GET') {
        return res.status(200).json({ votes, log, votingState: state, test, published, dir, configured: true });
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
        await blobSet(THANKSGIFT_KEY, { votes, log, test, published, dir: nextDir }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, dir: nextDir });
      }
      // テストモードの切替（root用UIから。期間外でも指定月を受付にできる）
      if (action === 'settest') {
        const nextTest = { open: !!body.open, period: String(body.period || '') };
        await blobSet(THANKSGIFT_KEY, { votes, log, test: nextTest, published, dir }, hasKV, hasSB, gas);
        const st2 = (nextTest.open && /^\d{4}-\d{2}$/.test(nextTest.period))
          ? { ...base, open: true, targetMonth: nextTest.period, test: true }
          : { ...base, test: false };
        return res.status(200).json({ ok: true, test: nextTest, votingState: st2 });
      }
      // 公開/非公開の切替（root用UIから。指定した対象月の感謝を受け取った側に表示するか）
      if (action === 'publish' && /^\d{4}-\d{2}$/.test(String(body.period || ''))) {
        const p = String(body.period);
        const set = new Set(published);
        if (body.publish === false) set.delete(p); else set.add(p);
        const nextPublished = [...set];
        await blobSet(THANKSGIFT_KEY, { votes, log, test, published: nextPublished, dir }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, published: nextPublished });
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
        await blobSet(THANKSGIFT_KEY, { votes: next, log: nextLog, test, published, dir }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, id: `${rec.period}__${rec.fromStaffId}` });
      }
      if (action === 'delete' && body.period && body.fromStaffId) {
        if (!state.open || String(body.period) !== String(state.targetMonth)) {
          return res.status(200).json({ ok: false, error: 'closed', votingState: state });
        }
        const next = removeVote(votes, String(body.period), String(body.fromStaffId));
        const nextLog = [...log, { period: String(body.period), fromStaffId: String(body.fromStaffId), action: 'delete', createdAt: new Date().toISOString(), id: `${body.period}__${body.fromStaffId}__${Date.now()}` }].slice(-3000);
        await blobSet(THANKSGIFT_KEY, { votes: next, log: nextLog, test, published, dir }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true });
      }
      // 管理者用: 指定(period+fromStaffId)の票を votes と log の両方から完全削除（テストデータ整理）。
      // items: [{period, fromStaffId}, ...]。送信履歴(log)からも消えるため送信者/受信者どちらの画面にも残らない。
      if (action === 'purge' && Array.isArray(body.items) && body.items.length) {
        const keyset = new Set(body.items.map(it => `${String(it.period)}__${String(it.fromStaffId)}`));
        const nextVotes = votes.filter(v => !keyset.has(`${String(v.period)}__${String(v.fromStaffId)}`));
        const nextLog = log.filter(l => !keyset.has(`${String(l.period)}__${String(l.fromStaffId)}`));
        await blobSet(THANKSGIFT_KEY, { votes: nextVotes, log: nextLog, test, published, dir }, hasKV, hasSB, gas);
        return res.status(200).json({ ok: true, removedVotes: votes.length - nextVotes.length, removedLog: log.length - nextLog.length });
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
