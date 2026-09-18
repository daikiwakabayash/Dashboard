// ── AI 応答の Adapter（mock / 既存API）───────────────────────────────────
// 共通基盤（①）や Knowledge 基盤（③）が未接続でも画面を試せるようにするための差し替え口。
// ⚠️ ②は新しい全社 Knowledge 基盤を作らない。使うのは「承認済み FAQ の限定取得」か mock のみ。
//
// Adapter の契約:
//   ask({ question, roomId, context }) → { ok, message, sources, sample, error }
//     message … 生のテキスト（1行目が NEEDS_HQ なら根拠不足として扱う）
//     sources … 実際に使った資料だけ（作らない・推測しない）
//     sample  … true なら「サンプル回答」と画面に明示する
//
// テスト: tests/chat-ai-adapter.test.js

const str = (v) => String(v == null ? '' : v);
const arr = (v) => (Array.isArray(v) ? v : []);

// ── 参照してよい情報の範囲（指示 §6）─────────────────────────────────────
// AI へ渡してよいのは「今回の質問」「そのルームの履歴」「そのルームへ共有が許可された資料」だけ。
// DM / Private AI Chat / 他店舗の資料 / 人事情報は混ぜない。
// ⚠️ ここはクライアント側の絞り込み。**最終判定はサーバー側（①の authz）で行う。**
export const DOC_VISIBILITY = Object.freeze(['room', 'shop', 'company']);

export function buildContext(input = {}) {
  const roomId = str(input.roomId);
  const shopId = str(input.shopId);
  const kept = [], rejected = [];
  for (const d of arr(input.docs)) {
    const vis = str(d && d.visibility);
    const reason =
      !DOC_VISIBILITY.includes(vis) ? 'unknown_visibility'
      : (vis === 'room' && str(d.roomId) !== roomId) ? 'other_room'
      : (vis === 'shop' && shopId && str(d.shopId) && str(d.shopId) !== shopId) ? 'other_shop'
      : d.private === true ? 'private'
      : d.personnel === true ? 'personnel'
      : '';
    if (reason) rejected.push({ id: str(d && d.id), title: str(d && d.title), reason });
    else kept.push(d);
  }
  // 履歴は「そのルームの直近のみ」。DM や他ルームの発言は入れない。
  const history = arr(input.history)
    .filter(m => str(m && m.roomId) === roomId)
    .slice(-(Number(input.historyLimit) || 10))
    .map(m => ({ role: str(m.fromStaffId) === '__ai__' ? 'assistant' : 'user', content: str(m.text).slice(0, 1000) }));

  const dataContext = kept.map(d => `【${str(d.title)}${d.version ? ` v${str(d.version)}` : ''}】\n${str(d.body).slice(0, 4000)}`).join('\n\n');
  return {
    roomId, shopId, history, dataContext,
    docs: kept,
    sources: kept.map(d => ({ kind: str(d.kind) || 'faq', id: str(d.id), title: str(d.title), version: str(d.version), updatedAt: str(d.updatedAt) })),
    rejected,
  };
}

// ── mock アダプタ（合成データ・「サンプル回答」と明示）────────────────────
// 資料が1件も無い質問には**答えを作らない**（根拠不足として本部確認へ回す）。
export function createMockAdapter(options = {}) {
  const delay = Number(options.delayMs) || 0;
  const failOn = str(options.failOn);
  return {
    name: 'mock',
    sample: true,
    async ask({ question, context } = {}) {
      if (delay) await new Promise(r => setTimeout(r, delay));
      const q = str(question);
      if (failOn && q.includes(failOn)) return { ok: false, error: 'mock_failure', sample: true };
      const ctx = context || { sources: [], docs: [] };
      const hits = arr(ctx.docs).filter(d => matchDoc(d, q));
      if (!hits.length) {
        return {
          ok: true, sample: true, sources: [],
          message: `${'NEEDS_HQ'}: この質問に対応する資料が見つかりませんでした。`,
        };
      }
      const body = hits.map(d => str(d.answer) || str(d.body)).join('\n\n');
      return {
        ok: true, sample: true,
        sources: hits.map(d => ({ kind: str(d.kind) || 'faq', id: str(d.id), title: str(d.title), version: str(d.version), updatedAt: str(d.updatedAt) })),
        message: body,
      };
    },
  };
}

// 質問と資料の素朴な突き合わせ（mock 用。実運用は③/①の検索に置き換える）
function matchDoc(doc, question) {
  const q = str(question).normalize('NFKC').toLowerCase();
  const keys = arr(doc && doc.keywords).map(k => str(k).normalize('NFKC').toLowerCase()).filter(Boolean);
  if (keys.some(k => q.includes(k))) return true;
  const title = str(doc && doc.title).normalize('NFKC').toLowerCase();
  return !!title && q.includes(title);
}

// ── 既存 API アダプタ（再利用: POST /api/chat { agent:'faq' } → { message }）──
// ⚠️ 新しい AI エンドポイントは作らない。既存の処理をそのまま使う。
export function createApiAdapter(options = {}) {
  const fetchImpl = options.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  const endpoint = str(options.endpoint) || '/api/chat';
  return {
    name: 'api',
    sample: false,
    async ask({ question, context } = {}) {
      if (!fetchImpl) return { ok: false, error: 'fetch_unavailable' };
      const ctx = context || {};
      try {
        const r = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // 既存の契約に合わせる（agent:'faq' / question / history / dataContext）
          body: JSON.stringify({ agent: 'faq', question: str(question), history: arr(ctx.history), dataContext: str(ctx.dataContext) }),
        });
        const j = await r.json().catch(() => null);
        const message = j && j.message ? str(j.message) : '';
        if (!message) return { ok: false, error: 'empty_response' };
        // 出典は「渡した資料」からのみ。モデルの自己申告では作らない。
        return { ok: true, sample: false, message, sources: arr(ctx.sources) };
      } catch (e) {
        return { ok: false, error: str(e && e.message) || 'request_failed' };
      }
    },
  };
}

// 接続状態の表示用（mock か実接続かを画面に必ず出す）
export function adapterBadge(adapter) {
  const name = str(adapter && adapter.name);
  if (name === 'api') return { label: '実AI接続', tone: 'live', note: '既存の /api/chat（agent:faq）に接続しています' };
  return { label: 'サンプル回答（mock）', tone: 'mock', note: '合成データによる動作確認用です。社内規程の正式な回答ではありません' };
}
