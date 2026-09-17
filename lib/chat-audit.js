// ── Chat 送信の監査記録（純粋関数）────────────────────────────────
// 「誰が・誰の代わりに・どの宛先へ・何を・いつ送ったか」を、あとから説明できる形で残す。
// tests/chat-audit.test.js でカバー。保存は呼び出し側（api/plan-store ?type=audit）。
//
// なぜ必要か: AIが宛先を解釈して代行送信できるようになると、「なぜこの人に届いたのか」を
// 人が再現できないと運用に乗せられない。解決の過程（何が曖昧で、誰が確定させたか）まで残す。
//
// 残さないもの: 本文全文（個人情報が混ざるため冒頭のみ）、トークン、画像の中身。

export const BODY_PREVIEW_LEN = 120;

// 記録に残してはいけないキー。値ごと落とす。
const SECRET_KEYS = /(token|password|secret|apikey|api_key|authorization|bearer)/i;

function safeMeta(obj, depth = 0) {
  if (obj == null || depth > 3) return undefined;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.slice(0, 50).map(v => safeMeta(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEYS.test(k)) continue;
    const sv = safeMeta(v, depth + 1);
    if (sv !== undefined) out[k] = sv;
  }
  return out;
}

/**
 * 送信1件の監査記録を作る。
 * @param input {
 *   actor, onBehalfOf, tenantId, roomId, roomKind,
 *   resolution,   // resolveRecipients() の戻り値
 *   body,         // 本文（冒頭のみ保存）
 *   channel,      // 'ui' | 'ai' | 'scheduled' | 'resend_unread'
 *   confirmedBy,  // 曖昧な宛先を人が確定させた場合、その人のID
 *   nowIso
 * }
 */
export function buildChatAudit(input) {
  const i = (input && typeof input === 'object') ? input : {};
  const a = (i.actor && typeof i.actor === 'object') ? i.actor : {};
  const b = (i.onBehalfOf && typeof i.onBehalfOf === 'object') ? i.onBehalfOf : null;
  const r = (i.resolution && typeof i.resolution === 'object') ? i.resolution : {};
  const body = String(i.body == null ? '' : i.body);

  if (!a.id && !a.name) return { ok: false, error: 'missing_actor' };
  const channel = ['ui', 'ai', 'scheduled', 'resend_unread'].includes(i.channel) ? i.channel : 'ui';

  return {
    ok: true,
    entry: {
      at: i.nowIso || new Date().toISOString(),
      tenantId: String(i.tenantId || a.tenantId || 'naoru').toLowerCase(),
      channel,
      // 誰が押したか（AI代行なら source='agent'）と、誰の権限で送ったか
      actorId: String(a.id || '').slice(0, 60),
      actorName: String(a.name || '').slice(0, 80),
      actorRole: String(a.role || '').slice(0, 20),
      source: String(a.source || 'ui').slice(0, 10),
      onBehalfOfId: b ? String(b.id || '').slice(0, 60) : '',
      onBehalfOfName: b ? String(b.name || '').slice(0, 80) : '',
      // どこへ
      roomId: String(i.roomId || '').slice(0, 80),
      roomKind: String(i.roomKind || '').slice(0, 20),
      action: String(r.action || 'chat.send').slice(0, 40),
      shopIds: (Array.isArray(r.shops) ? r.shops : []).map(s => String(s.id)).slice(0, 300),
      staffIds: (Array.isArray(r.staffIds) ? r.staffIds : []).map(String).slice(0, 1000),
      recipientCount: Number(r.recipientCount) || 0,
      excludedShopIds: (Array.isArray(r.excludedShops) ? r.excludedShops : []).map(s => String(s.id)).slice(0, 300),
      // どう決まったか（再現できるように）
      specRaw: String((i.spec && i.spec.raw) || r.specRaw || '').slice(0, 300),
      hadAmbiguity: Array.isArray(r.ambiguities) && r.ambiguities.length > 0,
      confirmedBy: String(i.confirmedBy || '').slice(0, 60),
      outOfScopeCount: Array.isArray(r.outOfScope) ? r.outOfScope.length : 0,
      // 何を（冒頭のみ。全文は messages 本体にある）
      bodyPreview: body.slice(0, BODY_PREVIEW_LEN),
      bodyLength: body.length,
      hasAttachment: !!i.hasAttachment,
      meta: safeMeta(i.meta) || {},
    },
  };
}

// 送らなかったこと自体も記録する。「AIが止めた」「権限で弾いた」が見えないと、
// 届いていない理由を誰も説明できない。
export function buildBlockedAudit(input) {
  const built = buildChatAudit({ ...input, body: '' });
  if (!built.ok) return built;
  const r = (input && input.resolution) || {};
  return {
    ok: true,
    entry: {
      ...built.entry,
      blocked: true,
      blockedStatus: String(r.status || 'denied').slice(0, 30),
      blockedCode: String(r.code || '').slice(0, 40),
      blockedReason: String(r.reason || '').slice(0, 200),
      recipientCount: 0,          // 届いていないので0で固定する
    },
  };
}

// 一覧の絞り込み（監査画面用）。テナントは常に一致必須。
export function filterAudit(entries, q = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const tenant = q.tenantId ? String(q.tenantId).toLowerCase() : null;
  return list.filter(e => {
    if (!e || typeof e !== 'object') return false;
    if (tenant && String(e.tenantId || '').toLowerCase() !== tenant) return false;
    if (q.actorId && String(e.actorId) !== String(q.actorId)) return false;
    if (q.channel && String(e.channel) !== String(q.channel)) return false;
    if (q.source && String(e.source) !== String(q.source)) return false;
    if (q.blocked === true && !e.blocked) return false;
    if (q.blocked === false && e.blocked) return false;
    if (q.shopId && !(Array.isArray(e.shopIds) && e.shopIds.includes(String(q.shopId)))) return false;
    if (q.since && Date.parse(e.at) < Date.parse(q.since)) return false;
    return true;
  });
}
