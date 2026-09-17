// ── 監査ログ（Audit Log）基盤 ──────────────────────────────────────
// 「誰が・いつ・何を・どう変えたか」を追記のみで残す。既存ストアは上書き保存なので、
// 経緯を追える唯一の場所がここになる。
//
// ⚠️ 秘密・個人情報を書かない。値は redact() を通してから保存する。

export const AUDIT_KEY = 'naoru:cc:audit:v1';
export const AUDIT_CAP = 5000;

// キー名にこれらを含む値は伏せる（大文字小文字は無視）
const SECRET_HINTS = ['password', 'passwd', 'token', 'secret', 'apikey', 'api_key', 'authorization', 'cookie', 'credential', 'privatekey', 'private_key'];

const str = (v, n) => String(v == null ? '' : v).slice(0, n);

export function isSecretKey(key) {
  const k = String(key || '').toLowerCase().replace(/[-\s]/g, '_');
  return SECRET_HINTS.some(h => k.includes(h));
}

// 値を安全な形に落とす。深さ・要素数・文字列長に上限を設ける（ログが肥大しないように）。
export function redact(value, depth) {
  const d = Number.isFinite(depth) ? depth : 0;
  if (d > 4) return '…';
  if (value == null) return null;
  const t = typeof value;
  if (t === 'string') return value.length > 400 ? value.slice(0, 400) + '…' : value;
  if (t === 'number' || t === 'boolean') return value;
  if (t !== 'object') return String(t);
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redact(v, d + 1));
  const out = {};
  for (const k of Object.keys(value).slice(0, 50)) {
    out[k] = isSecretKey(k) ? '[REDACTED]' : redact(value[k], d + 1);
  }
  return out;
}

// 監査エントリを組み立てる。保存は呼び出し側（追記）。
export function buildEntry(input, now) {
  const t = typeof now === 'number' ? now : Date.now();
  const action = str(input && input.action, 60);
  const entity = str(input && input.entity, 60);
  if (!action || !entity) return { ok: false, error: 'action_and_entity_required' };

  const actor = (input && input.actor) || {};
  return {
    ok: true,
    entry: {
      id: `au_${t.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ts: t,
      actorId: str(actor.id, 60),
      actorName: str(actor.name, 80),
      actorRole: str(actor.role, 20),
      source: str((input && input.source) || actor.source || 'ui', 20),   // ui | cron | agent | api
      action,                                                            // create | update | delete | approve | flag_change …
      entity,                                                            // approval | agentlog | ccflags | board …
      entityId: str(input && input.entityId, 80),
      shop: str(input && input.shop, 60),
      before: redact(input && input.before),
      after: redact(input && input.after),
      requestId: str(input && input.requestId, 60),
      note: str(input && input.note, 400),
    },
  };
}

export function listEntries(all, filter) {
  const f = filter || {};
  let rows = Array.isArray(all) ? all.slice() : [];
  if (f.entity && f.entity !== 'all') rows = rows.filter(e => e.entity === f.entity);
  if (f.entityId) rows = rows.filter(e => String(e.entityId) === String(f.entityId));
  if (f.actorId) rows = rows.filter(e => String(e.actorId) === String(f.actorId));
  if (f.action && f.action !== 'all') rows = rows.filter(e => e.action === f.action);
  if (f.since) rows = rows.filter(e => Number(e.ts || 0) >= Number(f.since));
  rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return rows;
}
