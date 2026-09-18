// ── Creative Library（①Dashboard 側）────────────────────────────────
// 素材を登録し、③へ生成を依頼し、出てきた案を見比べ、修正を依頼し、承認して
// 完成ファイルを受け取るまでの**状態と記録**だけを持つ。
//
// このファイルがやらないこと（③の担当。ここに実装しない）:
//   ・画像/動画の生成そのもの
//   ・新しいKPIや指標の計算
// ①は「依頼を出す・結果を預かる・人が判断した記録を残す」までを担当する。
//
// 守る約束:
//   1. **sample と実生成を混ぜない。** 未接続・sample・実生成を最後まで区別し、
//      sample を実績や正式な完成ファイルとして扱わない。
//   2. **承認は人が押す。** 生成が成功しただけでは approved にしない。
//   3. **素材権利が未確認のものを承認できない。** 権利の確認は承認の前提。
//   4. **修正履歴を消さない。** 誰がいつ何を依頼したかを残す。
//   5. 状態遷移は決められた順序だけ（勝手に戻さない・飛ばさない）。

export const CREATIVE_KEY = 'naoru:creative:v1';
export const CREATIVE_CAP = 2000;

// 下書き / 生成中 / 失敗 / 確認待ち / 承認済み
export const STATUSES = Object.freeze(['draft', 'generating', 'failed', 'review', 'approved']);
export const STATUS_LABEL = Object.freeze({
  draft: '下書き', generating: '生成中', failed: '失敗', review: '確認待ち', approved: '承認済み',
});
// 次に進める先。ここに無い遷移は拒否する。
const NEXT = Object.freeze({
  draft: ['generating', 'review'],      // 依頼する / 手元の素材をそのまま案にする
  generating: ['review', 'failed'],
  failed: ['generating', 'draft'],
  review: ['approved', 'draft'],        // 承認する / 修正を依頼して下書きへ戻す
  approved: [],                          // 終端。直したいときは新しい版を作る
});

export const CHANNELS = Object.freeze(['meta', 'google', 'line', 'instagram', 'other']);
export const ORIGINS = Object.freeze(['uploaded', 'generated']);
// 未接続 / sample / 実生成。**live 以外を実生成として扱わない。**
export const DATA_MODES = Object.freeze(['not_connected', 'sample', 'live']);
export const RIGHTS = Object.freeze(['confirmed', 'unconfirmed', 'restricted']);
export const FILE_KINDS = Object.freeze(['image', 'video']);

const str = (v, n = 200) => String(v == null ? '' : v).slice(0, n);
const arr = (v) => (Array.isArray(v) ? v : []);
const nowMs = (t) => (typeof t === 'number' ? t : Date.now());
const genId = (p) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export function canTransition(from, to) {
  return STATUSES.includes(from) && STATUSES.includes(to) && (NEXT[from] || []).includes(to);
}

// ファイル1件。**URLは保存先が発行したものだけ**を受け取り、種別を偽らせない。
export function normalizeFile(raw) {
  const f = (raw && typeof raw === 'object') ? raw : {};
  const url = str(f.url, 1000);
  if (!/^https:\/\//.test(url)) return null;                  // http/data/blob は受け取らない
  const contentType = str(f.contentType || f.content_type, 100).toLowerCase();
  const kind = FILE_KINDS.includes(f.kind) ? f.kind
    : (contentType.startsWith('video/') ? 'video' : (contentType.startsWith('image/') ? 'image' : ''));
  if (!kind) return null;                                      // 画像でも動画でもないものは案に載せない
  const bytes = Number(f.bytes);
  return {
    url, kind, contentType,
    bytes: Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : null,
    posterUrl: /^https:\/\//.test(str(f.posterUrl || f.poster_url, 1000)) ? str(f.posterUrl || f.poster_url, 1000) : null,
    name: str(f.name, 200),
  };
}

export function normalizeFiles(raw) {
  return arr(raw).map(normalizeFile).filter(Boolean).slice(0, 10);
}

// ── 素材（もとの写真・動画・文言のたね）────────────────────────────
export function buildAsset(input = {}, ctx = {}, t) {
  const at = nowMs(t);
  const files = normalizeFiles(input.files);
  const title = str(input.title, 200).trim();
  if (!title) return { ok: false, error: 'title_required' };
  if (!files.length) return { ok: false, error: 'file_required' };
  const channel = CHANNELS.includes(input.channel) ? input.channel : 'other';
  const rights = RIGHTS.includes(input.rightsStatus) ? input.rightsStatus : 'unconfirmed';
  return {
    ok: true,
    asset: {
      id: str(input.id, 64) || genId('as'),
      tenantId: str(ctx.tenantId, 64),
      companyId: str(input.companyId, 64),
      shopId: str(input.shopId, 64),
      channel, title,
      note: str(input.note, 2000),
      files,
      // 素材権利。**未確認のままでは承認できない。**
      rights: {
        status: rights,
        note: str(input.rightsNote, 500),
        confirmedBy: rights === 'confirmed' ? str(ctx.actorId, 64) : '',
        confirmedName: rights === 'confirmed' ? str(ctx.actorName, 100) : '',
        confirmedAt: rights === 'confirmed' ? at : null,
      },
      createdBy: str(ctx.actorId, 64),
      createdName: str(ctx.actorName, 100),
      createdAt: at,
      updatedAt: at,
    },
  };
}

export function confirmRights(asset, status, ctx = {}, t) {
  if (!asset) return { ok: false, error: 'not_found' };
  if (!RIGHTS.includes(status)) return { ok: false, error: 'invalid_rights' };
  const at = nowMs(t);
  return {
    ok: true,
    asset: {
      ...asset, updatedAt: at,
      rights: {
        ...asset.rights, status,
        confirmedBy: str(ctx.actorId, 64), confirmedName: str(ctx.actorName, 100), confirmedAt: at,
        note: ctx.note === undefined ? asset.rights.note : str(ctx.note, 500),
      },
    },
  };
}

// ── 案（creative）────────────────────────────────────────────────
export function buildCreative(asset, input = {}, ctx = {}, t) {
  if (!asset) return { ok: false, error: 'asset_not_found' };
  const at = nowMs(t);
  const origin = ORIGINS.includes(input.origin) ? input.origin : 'generated';
  const files = normalizeFiles(input.files);
  // 手元の素材をそのまま案にする場合はファイルが要る。生成依頼はこれから出来る。
  if (origin === 'uploaded' && !files.length) return { ok: false, error: 'file_required' };
  return {
    ok: true,
    creative: {
      id: str(input.id, 64) || genId('cr'),
      assetId: asset.id,
      tenantId: asset.tenantId,
      companyId: asset.companyId,
      shopId: asset.shopId,
      channel: asset.channel,
      version: 1,
      origin,
      // 生成元がどこかを最後まで持つ。未接続のまま数字や完成ファイルを名乗らせない。
      dataMode: 'not_connected',
      appeal: str(input.appeal, 200),
      headline: str(input.headline, 200),
      body: str(input.body, 4000),
      files,
      status: origin === 'uploaded' ? 'review' : 'draft',
      jobId: '', failureReason: '',
      // 計測リンクとの対応。①は対応を持つだけで、成果の計算はしない（③の担当）。
      measurement: { linkId: str(input.measurementLinkId, 100), url: '', confidence: 'unmapped' },
      reviewer: null,
      approvalId: '',
      revisions: [],
      createdBy: str(ctx.actorId, 64),
      createdName: str(ctx.actorName, 100),
      createdAt: at,
      updatedAt: at,
    },
  };
}

// ③へ生成を依頼する（依頼の記録だけ。生成そのものは③）。
export function startJob(creative, ctx = {}, t) {
  if (!creative) return { ok: false, error: 'not_found' };
  if (!canTransition(creative.status, 'generating')) return { ok: false, error: 'invalid_transition' };
  const at = nowMs(t);
  const jobId = str(ctx.jobId, 64) || genId('job');
  return {
    ok: true,
    creative: { ...creative, status: 'generating', jobId, failureReason: '', updatedAt: at },
    job: {
      id: jobId, creativeId: creative.id, assetId: creative.assetId, tenantId: creative.tenantId,
      requestedBy: str(ctx.actorId, 64), requestedName: str(ctx.actorName, 100),
      requestedAt: at, status: 'requested', mode: 'not_connected',
    },
  };
}

// ③からの結果を受け取る。**mode は③の申告をそのまま持ち、勝手に live へ上げない。**
export function completeJob(creative, result = {}, t) {
  if (!creative) return { ok: false, error: 'not_found' };
  if (creative.status !== 'generating') return { ok: false, error: 'invalid_transition' };
  const at = nowMs(t);
  if (result.ok === false) {
    return { ok: true, creative: { ...creative, status: 'failed',
      failureReason: str(result.reason, 300) || '生成に失敗しました', updatedAt: at } };
  }
  const files = normalizeFiles(result.files);
  if (!files.length) {
    return { ok: true, creative: { ...creative, status: 'failed',
      failureReason: '生成結果にファイルがありませんでした', updatedAt: at } };
  }
  const mode = DATA_MODES.includes(result.mode) ? result.mode : 'not_connected';
  return {
    ok: true,
    creative: {
      ...creative, status: 'review', files, dataMode: mode, failureReason: '',
      appeal: str(result.appeal, 200) || creative.appeal,
      headline: str(result.headline, 200) || creative.headline,
      body: str(result.body, 4000) || creative.body,
      updatedAt: at,
    },
  };
}

// 修正依頼。**元の内容は消さず履歴に残し、下書きへ戻す。**
export function requestRevision(creative, input = {}, ctx = {}, t) {
  if (!creative) return { ok: false, error: 'not_found' };
  if (!canTransition(creative.status, 'draft')) return { ok: false, error: 'invalid_transition' };
  const text = str(input.text, 2000).trim();
  if (!text) return { ok: false, error: 'text_required' };
  const at = nowMs(t);
  return {
    ok: true,
    creative: {
      ...creative,
      status: 'draft',
      version: (Number(creative.version) || 1) + 1,
      updatedAt: at,
      revisions: [...arr(creative.revisions), {
        id: genId('rev'), at, kind: 'request', text,
        by: str(ctx.actorId, 64), byName: str(ctx.actorName, 100),
        fromVersion: Number(creative.version) || 1,
        snapshot: { appeal: creative.appeal, headline: creative.headline, body: creative.body,
                    files: arr(creative.files).map(f => f.url), dataMode: creative.dataMode },
      }].slice(-50),
    },
  };
}

// 承認。**人が押したときだけ。sample と権利未確認は通さない。**
export function approve(creative, asset, ctx = {}, t) {
  if (!creative) return { ok: false, error: 'not_found' };
  if (!canTransition(creative.status, 'approved')) return { ok: false, error: 'invalid_transition' };
  if (!arr(creative.files).length) return { ok: false, error: 'file_required' };
  // ⚠️ sample を承認済みの完成ファイルにしない（未接続も同じ）。
  if (creative.dataMode !== 'live' && creative.origin !== 'uploaded') {
    return { ok: false, error: 'sample_not_approvable' };
  }
  if (!asset || asset.rights.status !== 'confirmed') return { ok: false, error: 'rights_unconfirmed' };
  const at = nowMs(t);
  return {
    ok: true,
    creative: {
      ...creative, status: 'approved', updatedAt: at,
      reviewer: { id: str(ctx.actorId, 64), name: str(ctx.actorName, 100), at },
      approvalId: str(ctx.approvalId, 64) || creative.approvalId,
    },
  };
}

// 完成ファイル。**承認済みのものだけ**を渡す。
export function deliverables(creative) {
  if (!creative || creative.status !== 'approved') return { ok: false, error: 'not_approved', files: [] };
  return {
    ok: true,
    creativeId: creative.id,
    version: creative.version,
    dataMode: creative.dataMode,
    files: arr(creative.files),
    measurement: creative.measurement,
    approvedBy: creative.reviewer,
  };
}

// 見比べ用。同じ素材から出た案を並べる（数字の計算はしない）。
export function compareSet(creatives, assetId) {
  return arr(creatives)
    .filter(c => c && String(c.assetId) === String(assetId))
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    .map(c => ({
      id: c.id, version: c.version, status: c.status, statusLabel: STATUS_LABEL[c.status] || c.status,
      origin: c.origin, dataMode: c.dataMode,
      appeal: c.appeal, headline: c.headline, body: c.body,
      files: arr(c.files), revisionCount: arr(c.revisions).length,
      measurement: c.measurement, reviewer: c.reviewer,
    }));
}

// 保存形の矯正（未知キーを生やさない）
export function normalizeStore(raw) {
  const s = (raw && typeof raw === 'object') ? raw : {};
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  return { assets: obj(s.assets), creatives: obj(s.creatives), jobs: obj(s.jobs) };
}
