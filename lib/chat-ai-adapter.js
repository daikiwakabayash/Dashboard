// ── AI 応答の Adapter（mock / 既存API / ①の実接続）─────────────────────────
// 契約は CHAT_AI_API_CONTRACT.md。サーバー実装・認可・保存は①の担当。
//
// ⚠️ この層の約束:
//   - role / tenant / 所属 / 資料の可視範囲は **サーバーが確定する**。ここでの絞り込みは UX。
//   - クライアントが作った dataContext を「権限チェック済みの資料」として扱わない。
//   - 「AIへ渡した参考資料（候補）」と「回答の根拠として検証された出典」を必ず区別する。
//   - ②は新しい全社 Knowledge 基盤を作らない（承認済み FAQ の限定取得か mock のみ）。
//
// テスト: tests/chat-ai-adapter.test.js / tests/chat-ai-contract.test.js

const str = (v) => String(v == null ? '' : v);
const arr = (v) => (Array.isArray(v) ? v : []);

// ── ①の実サーバー仕様（main = 20f80dc 時点）────────────────────────────
// 認証ヘッダは lib/actor.js の resolveActor が読むものに合わせる:
//   Authorization: Bearer <SalonOne SSO>
//   X-CC-Owner / X-CC-Token … アカウント名（percent-encode 必須）とトークン
//   X-CC-Agent-Token        … サーバー間（②のブラウザからは使わない）
// ⚠️ ヘッダは ISO-8859-1 しか運べないため、日本語のアカウント名は encodeURIComponent する。
export function ccAuthHeaders(auth = {}) {
  const h = {};
  const bearer = str(auth.bearer);
  const owner = str(auth.owner);
  const token = str(auth.token);
  if (bearer) h.Authorization = /^Bearer\s+/i.test(bearer) ? bearer : `Bearer ${bearer}`;
  if (owner) h['X-CC-Owner'] = encodeURIComponent(owner);
  if (token) h['X-CC-Token'] = token;
  return h;
}

// サーバーの応答をクライアント共通のエラー形へ正規化する。
// ①の既存レスポンスは { ok:false, error:'forbidden', code:'chat_admin_only', message } 形式。
// 契約（CHAT_AI_API_CONTRACT.md）の { error:{code,message,retryable} } 形式も受ける。
const NON_RETRYABLE = Object.freeze([
  'forbidden', 'chat_admin_only', 'forbidden_room', 'not_member', 'tenant_mismatch',
  'rollout_disabled', 'ai_message_source', 'invalid_request', 'not_found', 'bad_image', 'too_large',
]);
const RETRYABLE = Object.freeze(['rate_limited', 'upstream_failed', 'internal', 'timeout']);

export function normalizeError(payload, httpStatus) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const e = (p.error && typeof p.error === 'object') ? p.error : null;
  const code = str(e ? e.code : (p.code || p.error)) || (httpStatus === 403 ? 'forbidden' : 'internal');
  const message = str(e ? e.message : p.message) || code;
  let retryable;
  if (e && typeof e.retryable === 'boolean') retryable = e.retryable;
  else if (NON_RETRYABLE.includes(code)) retryable = false;
  else if (RETRYABLE.includes(code)) retryable = true;
  else if (httpStatus === 403 || httpStatus === 401 || httpStatus === 400) retryable = false;
  else retryable = true;
  return { code, message, retryable };
}

// 画面に出す文言（権限拒否はユーザーに詳細を出しすぎない）
export function errorMessageFor(err) {
  const code = str(err && err.code);
  const map = {
    chat_admin_only: 'チャットは本部・管理者のみ利用できます（再ログインが必要な場合があります）',
    forbidden: 'この操作は許可されていません',
    forbidden_room: 'このルームでは利用できません',
    not_member: 'このルームのメンバーではありません',
    tenant_mismatch: 'このルームでは利用できません',
    rollout_disabled: 'この機能はまだ公開されていません',
    ai_message_source: '',
    invalid_request: '送信内容を確認してください',
    rate_limited: '混み合っています。少し待ってから再試行してください',
    upstream_failed: '回答の取得に失敗しました',
  };
  return map[code] != null && map[code] !== '' ? map[code] : (str(err && err.message) || '回答の取得に失敗しました');
}

// 出典の検証状態。既定は unverified（安全側）。
export const VERIFICATION = Object.freeze(['server_verified', 'unverified', 'none']);
export const normalizeVerification = (v) => (VERIFICATION.includes(str(v)) ? str(v) : 'unverified');

// ── 参照してよい情報の範囲（指示 §6 / 契約 §7）────────────────────────────
// 「今回の質問」「そのルームの履歴」「そのルームへ共有が許可された資料」だけ。
// ⚠️ ID やスコープが欠けたときに制約が消えないこと。不明な可視範囲は **除外して要確認**。
export const DOC_VISIBILITY = Object.freeze(['room', 'shop', 'company']);

export function buildContext(input = {}) {
  const roomId = str(input.roomId);
  const shopId = str(input.shopId);
  const tenantId = str(input.tenantId);
  const kept = [], rejected = [];

  for (const d of arr(input.docs)) {
    const vis = str(d && d.visibility);
    const docTenant = str(d && (d.tenantId ?? d.tenant_id));
    const reason =
      !DOC_VISIBILITY.includes(vis) ? 'unknown_visibility'
      // テナントは「一致が確認できたものだけ」通す。未指定どうしは既定テナントとして扱う。
      : (tenantId && docTenant && docTenant !== tenantId) ? 'other_tenant'
      : (docTenant && !tenantId) ? 'tenant_unknown'
      // room 限定は room_id が確定していないと通さない（不明＝全社扱いにしない）
      : (vis === 'room' && !roomId) ? 'room_unknown'
      : (vis === 'room' && str(d.roomId) !== roomId) ? 'other_room'
      // shop 限定は shop_id が両側で確定していないと通さない
      : (vis === 'shop' && !shopId) ? 'shop_unknown'
      : (vis === 'shop' && !str(d.shopId)) ? 'doc_shop_unknown'
      : (vis === 'shop' && str(d.shopId) !== shopId) ? 'other_shop'
      : d.private === true ? 'private'
      : d.personnel === true ? 'personnel'
      : '';
    if (reason) rejected.push({ id: str(d && d.id), title: str(d && d.title), reason });
    else kept.push(d);
  }

  // 履歴は「そのルームの直近のみ」。room_id が無ければ履歴は渡さない。
  const history = !roomId ? [] : arr(input.history)
    .filter(m => str(m && m.roomId) === roomId)
    .slice(-(Number(input.historyLimit) || 10))
    .map(m => ({ role: str(m.fromStaffId) === '__ai__' ? 'assistant' : 'user', content: str(m.text).slice(0, 1000) }));

  const dataContext = kept.map(d => `【${str(d.title)}${d.version ? ` v${str(d.version)}` : ''}】\n${str(d.body).slice(0, 4000)}`).join('\n\n');

  return {
    roomId, shopId, tenantId, history, dataContext,
    docs: kept,
    // ⚠️ これは「AIへ渡した参考資料（候補）」であって、検証済みの出典ではない。
    candidates: kept.map(d => ({
      kind: str(d.kind) || 'faq', id: str(d.id), doc_id: str(d.id), title: str(d.title),
      version: str(d.version), updatedAt: str(d.updatedAt), reason: 'passed_to_model',
    })),
    rejected,
    // サーバーへ送るヒント（本文は載せない＝ID のみ）
    hint: { doc_ids: kept.map(d => str(d.id)).filter(Boolean) },
  };
}

// 回答結果の出典を「検証済み / 候補のみ / 無し」に正規化する。
//   戻り値: { verification, verified:[], candidates:[], label, caution }
export function resolveSources(result = {}, context = {}) {
  const src = (result && result.sources) || {};
  const verified = arr(src.verified).map(s => ({
    kind: str(s.kind) || 'faq',
    docId: str(s.doc_id ?? s.docId ?? s.id),
    title: str(s.title),
    version: str(s.version),
    updatedAt: str(s.updated_at ?? s.updatedAt),
    locator: str(s.locator),
    confidence: str(s.confidence),
  })).filter(s => s.docId || s.title);

  const candidates = (arr(src.candidates).length ? arr(src.candidates) : arr(context.candidates)).map(s => ({
    kind: str(s.kind) || 'faq',
    docId: str(s.doc_id ?? s.docId ?? s.id),
    title: str(s.title),
    version: str(s.version),
    updatedAt: str(s.updatedAt ?? s.updated_at),
  })).filter(s => s.docId || s.title);

  let verification = normalizeVerification(src.verification);
  if (verified.length && verification !== 'server_verified') verification = 'unverified'; // 申告が無ければ昇格させない
  if (!verified.length && verification === 'server_verified') verification = candidates.length ? 'unverified' : 'none';
  if (!verified.length && !candidates.length) verification = 'none';

  // ⚠️ 「確認済み」は **出典の実在・版・参照箇所をサーバーが確かめた** という意味であり、
  //    回答内容の正しさ（正解保証・正式承認）を表すものではない。
  //    本部の確認・訂正の状態は、この出典確認とは別に扱う（session 側で保持）。
  return {
    verification, verified, candidates,
    label: verification === 'server_verified' ? '出典を確認済み（実在・版・参照箇所）'
      : verification === 'unverified' ? '参照候補として渡した資料（未検証）'
      : '根拠なし',
    note: verification === 'server_verified'
      ? '出典の実在・版・参照箇所を確認したものです。回答内容の正しさを保証するものではありません'
      : '',
    caution: verification === 'server_verified' ? ''
      : verification === 'unverified' ? 'サーバーで出典の検証がされていないため、正式な社内規程としての回答ではありません'
      : '根拠不足・本部確認が必要です（社内規程に基づく回答ではありません）',
  };
}

// ── mock アダプタ（合成データ・「サンプル回答」と明示）────────────────────
// mock は **決して server_verified を名乗らない**（候補どまり）。
export function createMockAdapter(options = {}) {
  const delay = Number(options.delayMs) || 0;
  const failOn = str(options.failOn);
  return {
    name: 'mock', mode: 'sample', sample: true,
    async ask({ question, context } = {}) {
      if (delay) await new Promise(r => setTimeout(r, delay));
      const q = str(question);
      if (failOn && q.includes(failOn)) return { ok: false, mode: 'sample', error: { code: 'upstream_failed', message: 'mock_failure', retryable: true } };
      const ctx = context || { candidates: [], docs: [] };
      const hits = arr(ctx.docs).filter(d => matchDoc(d, q));
      if (!hits.length) {
        return {
          ok: true, mode: 'sample',
          body: `${'NEEDS_HQ'}: この質問に対応する資料が見つかりませんでした。`,
          sources: { verification: 'none', verified: [], candidates: [] },
        };
      }
      return {
        ok: true, mode: 'sample',
        body: hits.map(d => str(d.answer) || str(d.body)).join('\n\n'),
        sources: {
          verification: 'unverified',          // mock は検証していない
          verified: [],
          candidates: hits.map(d => ({ kind: str(d.kind) || 'faq', doc_id: str(d.id), title: str(d.title), version: str(d.version), updatedAt: str(d.updatedAt) })),
        },
      };
    },
  };
}

function matchDoc(doc, question) {
  const q = str(question).normalize('NFKC').toLowerCase();
  const keys = arr(doc && doc.keywords).map(k => str(k).normalize('NFKC').toLowerCase()).filter(Boolean);
  if (keys.some(k => q.includes(k))) return true;
  const title = str(doc && doc.title).normalize('NFKC').toLowerCase();
  return !!title && q.includes(title);
}

// ── ①の実接続アダプタ（CHAT_AI_API_CONTRACT.md）──────────────────────────
// 認証情報はブラウザの既存の仕組み（Bearer / X-Chat-*）をそのまま使う。
// クライアントは question / room_id / request_id / client_id と、**ID だけの候補ヒント**を送る。
export function createLiveAdapter(options = {}) {
  const fetchImpl = options.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  // ①の実装（main #392）: POST /api/plan-store に body.type='chatai' / body.action で振り分け
  const endpoint = str(options.endpoint) || '/api/plan-store';
  // 認証は①の既存ヘッダ（Authorization / X-CC-Owner / X-CC-Token）に合わせる
  const headersOf = typeof options.headers === 'function' ? options.headers
    : (options.auth ? () => ccAuthHeaders(options.auth) : () => (options.headers || {}));
  // ①の plan-store は POST を body.type / body.action で振り分ける（GET は query.type）。
  // その規約に合わせて body にも type/action を載せる。
  const bodyType = str(options.type) || 'chatai';
  const bodyAction = str(options.action) || 'ask';
  return {
    name: 'live', mode: 'live', sample: false,
    async ask({ question, roomId, requestId, clientId, questionMessageId, context } = {}) {
      if (!fetchImpl) return { ok: false, error: { code: 'internal', message: 'fetch_unavailable', retryable: false } };
      // room_id が無いまま問い合わせない（制約が消えた状態で投げない）
      if (!str(roomId)) return { ok: false, error: { code: 'invalid_request', message: 'room_id_required', retryable: false } };
      if (!str(requestId)) return { ok: false, error: { code: 'invalid_request', message: 'request_id_required', retryable: false } };
      const ctx = context || {};
      try {
        const r = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headersOf() },
          body: JSON.stringify({
            type: bodyType,
            action: bodyAction,
            question: str(question),
            room_id: str(roomId),
            request_id: str(requestId),
            client_id: str(clientId),
            question_message_id: str(questionMessageId) || undefined,
            // ⚠️ 本文は送らない。あくまで「候補のヒント」（サーバーが選び直す）
            context_hint: { doc_ids: arr(ctx.hint && ctx.hint.doc_ids).map(str) },
          }),
        });
        const j = await r.json().catch(() => null);
        const status = Number(r && r.status) || 0;
        if (!j) return { ok: false, httpStatus: status, error: normalizeError(null, status) };
        // ①の既存形式（error:'forbidden', code:'chat_admin_only'）も契約形式も受ける
        if (j.ok === false || j.error || (status && status >= 400)) {
          return { ok: false, httpStatus: status, mode: str(j.mode) || 'live', error: normalizeError(j, status) };
        }
        // 生成中（同じ request_id の再送）。回答カードを作らず pending のままにする。
        if (str(j.status) === 'pending') {
          return { ok: true, pending: true, questionMessageId: str(j.question_message_id), roomId: str(j.room_id) || str(roomId) };
        }
        const body = str(j.body ?? j.message);
        if (!body) return { ok: false, error: { code: 'internal', message: 'empty_response', retryable: true } };
        return {
          ok: true,
          replay: j.replay === true,       // 同じ request_id の再送に対する再生（新規生成ではない）
          mode: str(j.mode) === 'sample' ? 'sample' : 'live',
          questionMessageId: str(j.question_message_id),
          answerMessageId: str(j.answer_message_id),
          roomId: str(j.room_id) || str(roomId),
          body,
          // サーバーが返した検証結果のみを採用（クライアント側の候補で埋めない）
          sources: j.sources || { verification: 'unverified', verified: [], candidates: [] },
          hqReview: j.hq_review || null,
          usage: j.usage || null,
        };
      } catch (e) {
        return { ok: false, error: { code: 'internal', message: str(e && e.message) || 'request_failed', retryable: true } };
      }
    },

    // 本部確認の依頼（①: action='hq_review'）。同じ質問につき1件はサーバーが保証する。
    async hqReview({ questionMessageId, answerMessageId, roomId } = {}) {
      return post({ type: bodyType, action: 'hq_review',
        question_message_id: str(questionMessageId), answer_message_id: str(answerMessageId), room_id: str(roomId) });
    },

    // 本部による訂正（①: action='correct'）。元回答は残り、訂正が追記される。
    async correct({ answerMessageId, text } = {}) {
      return post({ type: bodyType, action: 'correct', answer_message_id: str(answerMessageId), text: str(text) });
    },

    // 検証用Room・許可FAQの設定を読む（root/本部のみ。変更は①の画面で行う）
    async getConfig() {
      return post({ type: bodyType, action: 'config' }, 'GET');
    },
  };

  // 共通の POST 実行（認証ヘッダとエラー正規化を1箇所に）
  async function post(payload, method) {
    if (!fetchImpl) return { ok: false, error: { code: 'internal', message: 'fetch_unavailable', retryable: false } };
    try {
      const r = await fetchImpl(endpoint, {
        method: method === 'GET' ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...headersOf() },
        body: method === 'GET' ? undefined : JSON.stringify(payload),
      });
      const j = await r.json().catch(() => null);
      const status = Number(r && r.status) || 0;
      if (!j) return { ok: false, httpStatus: status, error: normalizeError(null, status) };
      if (j.ok === false || j.error || (status && status >= 400)) {
        return { ok: false, httpStatus: status, error: normalizeError(j, status) };
      }
      return { ...j, ok: true };
    } catch (e) {
      return { ok: false, error: { code: 'internal', message: str(e && e.message) || 'request_failed', retryable: true } };
    }
  }
}

// 既存 API をそのまま叩く簡易アダプタ（①のラッパーが未実装の間の暫定）。
// ⚠️ 出典を検証できないため、必ず unverified（候補どまり）で返す。
export function createLegacyApiAdapter(options = {}) {
  const fetchImpl = options.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  const endpoint = str(options.endpoint) || '/api/chat';
  return {
    name: 'legacy', mode: 'live', sample: false, unverifiedOnly: true,
    async ask({ question, roomId, context } = {}) {
      if (!fetchImpl) return { ok: false, error: { code: 'internal', message: 'fetch_unavailable', retryable: false } };
      if (!str(roomId)) return { ok: false, error: { code: 'invalid_request', message: 'room_id_required', retryable: false } };
      const ctx = context || {};
      try {
        const r = await fetchImpl(endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: 'faq', question: str(question), history: arr(ctx.history), dataContext: str(ctx.dataContext) }),
        });
        const j = await r.json().catch(() => null);
        const status = Number(r && r.status) || 0;
        if (j && (j.ok === false || j.error || (status && status >= 400))) {
          return { ok: false, httpStatus: status, error: normalizeError(j, status) };
        }
        const body = j && j.message ? str(j.message) : '';
        if (!body) return { ok: false, error: { code: 'upstream_failed', message: 'empty_response', retryable: true } };
        return {
          ok: true, mode: 'live', body,
          // クライアントが渡した資料は「候補」にとどめる（検証済みにしない）
          sources: { verification: 'unverified', verified: [], candidates: arr(ctx.candidates) },
        };
      } catch (e) {
        return { ok: false, error: { code: 'internal', message: str(e && e.message) || 'request_failed', retryable: true } };
      }
    },
  };
}

// 接続状態の表示用（mock / 実接続 / 暫定接続 が必ず画面で分かるように）
export function adapterBadge(adapter) {
  const name = str(adapter && adapter.name);
  if (name === 'live') return { label: '実接続（①の共通基盤）', tone: 'live', note: 'role・tenant・資料の可視範囲はサーバーが確定します' };
  if (name === 'legacy') return { label: '暫定接続（既存 /api/chat）', tone: 'warn', note: '出典の検証がないため、回答は参照候補どまりです' };
  return { label: 'サンプル回答（mock）', tone: 'mock', note: '合成データによる動作確認用です。社内規程の正式な回答ではありません' };
}

// ── 試用画面の選択肢（Room名・参加者・FAQタイトル）────────────────────────
// 内部IDを手入力させないための一覧を作る。**名前を選ばせ、送るのはID**。
// 決まり:
//   ・①が許可したIDだけを選択肢にする（trialRooms / allowedDocIds）。
//   ・許可リストが空なら選択肢も空。「無いから全部出す」はしない。
//   ・参加者はサーバーが確定した room.members の表示専用（ここでは編集しない）。
export function buildTrialTargets(input = {}) {
  const cfg = (input.config && typeof input.config === 'object') ? input.config : {};
  const trial = new Set(arr(cfg.trialRooms).map(str).filter(Boolean));
  const allowedDocs = new Set(arr(cfg.allowedDocIds).map(str).filter(Boolean));
  const names = (input.names && typeof input.names === 'object') ? input.names : {};

  const rooms = arr(input.rooms)
    .filter(r => r && trial.has(str(r.id)))
    .map(r => ({
      id: str(r.id),
      name: str(r.name) || str(r.id),
      kind: str(r.kind),
      shopId: str(r.shopId || r.shop),
      members: arr(r.members).map(str).filter(Boolean)
        .map(id => ({ id, name: str(names[id]) || id })),
    }));

  const docs = arr(input.docs)
    .filter(d => d && allowedDocs.has(str(d.id)))
    .map(d => ({ id: str(d.id), title: str(d.title || d.q) || str(d.id) }));

  const reasons = [];
  if (!trial.size) reasons.push('no_trial_room');
  else if (!rooms.length) reasons.push('trial_room_not_found');
  if (!allowedDocs.size) reasons.push('no_allowed_doc');
  else if (!docs.length) reasons.push('allowed_doc_not_found');
  return { rooms, docs, reasons };
}

// 選択結果 → 送信値。**選択肢に無いIDは送らない**（手入力・古い選択の持ち越し対策）。
export function pickedTarget(targets, roomId, docIds) {
  const t = targets || { rooms: [], docs: [] };
  const room = arr(t.rooms).find(r => str(r.id) === str(roomId)) || null;
  const allowed = new Set(arr(t.docs).map(d => str(d.id)));
  const hintDocIds = arr(docIds).map(str).filter(id => allowed.has(id));
  return { room, roomId: room ? room.id : '', hintDocIds, ok: !!room };
}
