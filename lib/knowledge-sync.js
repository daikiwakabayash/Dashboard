// ── ナレッジ資料の自動更新（Google スプレッドシート／スライド／ドキュメント）──
// 「出典」に貼った Google の URL から、1日1回 本文を取り直す。
//
// 守る約束:
//   1. **勝手に消さない。** 取得に失敗したら前の本文をそのまま残す（空で上書きしない）。
//   2. **変更は残す。** 更新のたびに前の本文を履歴へ積み、誰でも後から比べられる。
//   3. **反映は自動、確認は人。** 本文は自動で新しくなるが「更新あり・未確認」の印が付き、
//      本部が確認するまで消えない。
//   4. 認証情報はここに持たない。取得は既存の Apps Script（GAS）に任せる。

export const KIND_LABEL = Object.freeze({
  spreadsheet: 'スプレッドシート', presentation: 'スライド', document: 'ドキュメント',
});
export const SYNC_KINDS = Object.freeze(Object.keys(KIND_LABEL));
export const REVISION_CAP = 20;          // 資料1件あたりの履歴保持数

const str = (v, n = 4000) => String(v == null ? '' : v).slice(0, n);
const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * Google の URL から「種類」と「ファイルID」を取り出す。
 * 対応: /spreadsheets/d/<id> /presentation/d/<id> /document/d/<id>
 * ⚠️ 取り出せない URL は自動更新の対象にしない（勝手に別のものを読みに行かない）。
 */
export function parseSourceUrl(raw) {
  const u = String(raw == null ? '' : raw).trim();
  const m = u.match(/^https:\/\/docs\.google\.com\/(spreadsheets|presentation|document)\/d\/([A-Za-z0-9_-]{20,})/);
  if (!m) return null;
  const kind = { spreadsheets: 'spreadsheet', presentation: 'presentation', document: 'document' }[m[1]];
  return { kind, fileId: m[2], url: u.slice(0, 500) };
}

// 自動更新できる資料か（出典がGoogleのURLで、自動更新をONにしてある）
export function isSyncable(doc) {
  return !!(doc && doc.autoSync !== false && parseSourceUrl(doc.source));
}

// 本文の指紋。空白の揺れは無視して「中身が変わったか」だけを見る。
export function contentFingerprint(body) {
  // 行ごとに前後の空白を落としてから、空行の連続をまとめる。
  // これをしないと、行頭の空白1つで「変わった」と誤判定してしまう。
  const t = String(body == null ? '' : body)
    .replace(/\r\n/g, '\n')
    .split('\n').map(line => line.replace(/[ \t\u3000]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < t.length; i++) {
    h1 = Math.imul(h1 ^ t.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + t.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return `${t.length.toString(36)}_${h1.toString(16)}${h2.toString(16)}`;
}

/**
 * 取得結果を1件の資料へ反映する。**書き換えるべきかどうかもここで決める。**
 * @returns { changed, doc, reason }
 */
export function applyFetched(doc, fetched, t) {
  const at = typeof t === 'number' ? t : Date.now();
  const base = { ...(doc || {}) };
  const src = parseSourceUrl(base.source);
  if (!src) return { changed: false, doc: base, reason: 'not_a_google_url' };

  // 取得に失敗 → **前の本文を残す**。失敗したことだけ記録して次回また試す。
  if (!fetched || fetched.ok === false) {
    return {
      changed: false,
      doc: { ...base, sync: { ...(base.sync || {}), kind: src.kind, lastTriedAt: at,
        lastError: str(fetched && fetched.error, 300) || '取得できませんでした' } },
      reason: 'fetch_failed',
    };
  }
  const body = str(fetched.body, 200000);
  // 空で返ってきたものは信用しない（共有解除・権限切れで空になることがある）
  if (!body.trim()) {
    return {
      changed: false,
      doc: { ...base, sync: { ...(base.sync || {}), kind: src.kind, lastTriedAt: at,
        lastError: '中身が空で返ってきたため、前の内容を残しました' } },
      reason: 'empty_body',
    };
  }
  const fp = contentFingerprint(body);
  const prevFp = (base.sync && base.sync.fingerprint) || contentFingerprint(base.body);
  const syncBase = { ...(base.sync || {}), kind: src.kind, fileId: src.fileId,
    lastTriedAt: at, lastError: '', fingerprint: fp };

  if (fp === prevFp) {
    return { changed: false, doc: { ...base, sync: { ...syncBase, lastCheckedAt: at } }, reason: 'unchanged' };
  }
  // 変わっていた → 本文を新しくし、前の本文を履歴へ積み、「未確認」を立てる
  return {
    changed: true,
    reason: 'updated',
    doc: {
      ...base,
      body,
      title: str(fetched.title, 200) || base.title,
      updatedAt: new Date(at).toISOString(),
      updatedBy: '自動更新',
      sync: { ...syncBase, lastSyncedAt: at, lastCheckedAt: at,
        // 自動で反映はするが、本部が確認するまで印は消えない
        needsReview: true, reviewedAt: null, reviewedBy: '' },
      revisions: [{ at, by: '自動更新', bytes: body.length,
        previousBody: str(base.body, 200000), previousFingerprint: prevFp }, ...arr(base.revisions)].slice(0, REVISION_CAP),
    },
  };
}

// 本部が「確認しました」を押したとき
export function markReviewed(doc, actor, t) {
  const at = typeof t === 'number' ? t : Date.now();
  if (!doc) return null;
  return { ...doc, sync: { ...(doc.sync || {}), needsReview: false, reviewedAt: at,
    reviewedBy: String((actor && (actor.name || actor.id)) || '').slice(0, 100) } };
}

// 画面・通知用のまとめ
export function syncSummary(docs) {
  const list = arr(docs);
  const targets = list.filter(isSyncable);
  const pending = targets.filter(d => d.sync && d.sync.needsReview);
  const failed = targets.filter(d => d.sync && d.sync.lastError);
  return {
    total: list.length, syncable: targets.length,
    needsReview: pending.length, failed: failed.length,
    lastRunAt: targets.reduce((a, d) => Math.max(a, (d.sync && d.sync.lastCheckedAt) || 0), 0) || null,
    pendingTitles: pending.slice(0, 20).map(d => ({ id: d.id, title: d.title || '無題',
      at: d.sync.lastSyncedAt || null, kind: KIND_LABEL[d.sync.kind] || '' })),
    failedTitles: failed.slice(0, 20).map(d => ({ id: d.id, title: d.title || '無題', error: d.sync.lastError })),
    // 同じ理由でまとめて失敗することが多いので、重複を畳んで画面にそのまま出せる形にする
    failedReasons: [...new Set(failed.map(d => String(d.sync.lastError || '')).filter(Boolean))].slice(0, 5),
  };
}
