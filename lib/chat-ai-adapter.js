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

  return {
    verification, verified, candidates,
    label: verification === 'server_verified' ? '検証済みの出典'
      : verification === 'unverified' ? '参照候補として渡した資料（未検証）'
      : '根拠なし',
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
  const endpoint = str(options.endpoint) || '/api/plan-store?type=chatai&action=ask';
  const headersOf = typeof options.headers === 'function' ? options.headers : () => (options.headers || {});
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
        if (!j) return { ok: false, error: { code: 'internal', message: 'invalid_response', retryable: true } };
        if (j.ok === false || j.error) {
          const e = j.error || {};
          return { ok: false, mode: str(j.mode) || 'live', error: { code: str(e.code) || 'internal', message: str(e.message), retryable: e.retryable === true } };
        }
        const body = str(j.body ?? j.message);
        if (!body) return { ok: false, error: { code: 'internal', message: 'empty_response', retryable: true } };
        return {
          ok: true,
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
  };
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
