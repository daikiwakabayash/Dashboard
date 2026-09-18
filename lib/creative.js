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
// ⚠️ **デモ素材と実際の施術素材を混ぜない。** デモを実績や広告の正本として扱わない。
export const ASSET_KINDS = Object.freeze(['demo', 'real']);
export const ASSET_KIND_LABEL = Object.freeze({ demo: 'デモ素材', real: '実際の施術素材' });
// 承認の前に人が確かめる項目。⚠️ 自動で true にしない。
export const CLAIM_CHECKS = Object.freeze([
  { key: 'noFakeTestimonial', label: '架空の体験談を含まない' },
  { key: 'noGuarantee', label: '効果を保証する表現を含まない' },
  { key: 'noFakeBeforeAfter', label: '偽の Before / After を含まない' },
  { key: 'brandFromSource', label: '店舗情報・価格・ロゴは承認済みの正本を使っている' },
]);
export const FILE_KINDS = Object.freeze(['image', 'video']);

const str = (v, n = 200) => String(v == null ? '' : v).slice(0, n);
const arr = (v) => (Array.isArray(v) ? v : []);
const nowMs = (t) => (typeof t === 'number' ? t : Date.now());
const genId = (p) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** 生成設定。⚠️ 知らないキーを生やさない。 */
export function normalizeGenSettings(v) {
  const src = (v && typeof v === 'object') ? v : {};
  return {
    formats: arr(src.formats).map(x => str(x, 30)).filter(Boolean).slice(0, 12),
    brandVersion: str(src.brandVersion, 64),
    mode: DATA_MODES.includes(src.mode) ? src.mode : '',
    preset: str(src.preset, 80),          // ③のテンプレート等（③の申告をそのまま持つ）
    note: str(src.note, 500),
  };
}

/**
 * 制作費。⚠️ **分からないものを 0 にしない。** 未記録は amount:null。
 * 通貨も申告のまま持ち、勝手に円へ換算しない。
 */
export function normalizeCost(v) {
  const src = (v && typeof v === 'object') ? v : {};
  // ⚠️ null / undefined / '' は「未記録」。Number(null) が 0 になるので、先に弾く。
  const raw = src.amount;
  const n = (raw === null || raw === undefined || raw === '') ? NaN : Number(raw);
  return {
    amount: Number.isFinite(n) && n >= 0 ? n : null,
    currency: /^[A-Z]{3}$/.test(str(src.currency, 3)) ? str(src.currency, 3) : (Number.isFinite(n) ? 'JPY' : ''),
    source: ['third_party', 'internal', 'estimate'].includes(src.source) ? src.source : '',
    note: str(src.note, 200),
  };
}

export function emptyClaims() {
  return { ...Object.fromEntries(CLAIM_CHECKS.map(c => [c.key, false])), by: '', at: null };
}
/** 承認前の確認。⚠️ 自動で true にしない。人が押した分だけ記録する。 */
export function normalizeClaims(v, ctx = {}, t) {
  const src = (v && typeof v === 'object') ? v : {};
  const out = Object.fromEntries(CLAIM_CHECKS.map(c => [c.key, !!src[c.key]]));
  const any = Object.values(out).some(Boolean);
  return { ...out, by: any ? str(ctx.actorId, 64) : '', at: any ? nowMs(t) : null };
}
export function claimsOk(claims) {
  const c = (claims && typeof claims === 'object') ? claims : {};
  return CLAIM_CHECKS.every(x => c[x.key] === true);
}

export function canTransition(from, to) {
  return STATUSES.includes(from) && STATUSES.includes(to) && (NEXT[from] || []).includes(to);
}

// ── ファイル1件 ──────────────────────────────────────────────────────
// ⚠️ **保存先URLを画面・③へ渡さない。**
//    Vercel Blob は公開URLしか発行できないので、保存先には暗号文だけを置き、
//    復号鍵は①のサーバーだけが持つ（lib/creative-crypto.js）。
//    画面が使うのは「①の認証付き配信口」への参照だけ。
//    ③が作ったファイルも同じで、③の認証付き取得口を①が中継する。

// 許可する保存先ホスト。**任意URLは受け取らない。**
const STORAGE_HOST = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i;
export const FILE_SOURCES = Object.freeze(['storage', 'job']);
export const ENC_ALG = 'A256GCM-CHUNK1M';

/**
 * サーバーが保持するファイル記録を作る。
 *   src='storage' … ①が暗号化して保存したもの。storageUrl と 包んだ鍵 enc.key を持つ。
 *   src='job'     … ③のジョブ成果物。①が認証付きで取りに行くための jobId と index を持つ。
 * 条件を満たさないものは null（案に載せない）。
 */
export function normalizeFile(raw) {
  const f = (raw && typeof raw === 'object') ? raw : {};
  const contentType = str(f.contentType || f.content_type, 100).toLowerCase();
  const kind = FILE_KINDS.includes(f.kind) ? f.kind
    : (contentType.startsWith('video/') ? 'video' : (contentType.startsWith('image/') ? 'image' : ''));
  if (!kind) return null;                                      // 画像でも動画でもないものは案に載せない
  const bytes = Number(f.bytes);
  const base = {
    fileId: str(f.fileId, 64) || genId('f'),
    kind, contentType,
    bytes: Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : null,
    sha256: /^[0-9a-f]{64}$/.test(str(f.sha256, 64)) ? str(f.sha256, 64) : '',
    name: str(f.name, 200),
  };
  const src = FILE_SOURCES.includes(f.src) ? f.src : (f.jobId ? 'job' : 'storage');
  if (src === 'job') {
    const jobId = str(f.jobId, 64);
    const index = Number(f.index);
    if (!jobId || !Number.isFinite(index) || index < 0) return null;
    return { ...base, src: 'job', jobId, index: Math.floor(index) };
  }
  const storageUrl = str(f.storageUrl || f.url, 1000);
  // ⚠️ 保存先は**許可したストレージのみ**。http/data/blob/任意ホストは受け取らない。
  //    任意URLをそのまま開くと、外部の中身を①の画面で読ませてしまう。
  if (!STORAGE_HOST.test(storageUrl)) return null;
  const enc = (f.enc && typeof f.enc === 'object') ? f.enc : null;
  // ⚠️ 暗号化されていない保存物は受け取らない。「URLを隠すだけの公開保存」を作らない。
  if (!enc || enc.alg !== ENC_ALG || !str(enc.key, 400)) return null;
  const plainBytes = Number(enc.plainBytes);
  if (!Number.isFinite(plainBytes) || plainBytes < 0) return null;
  return {
    ...base,
    bytes: base.bytes === null ? Math.floor(plainBytes) : base.bytes,
    src: 'storage', storageUrl,
    // 素材から案へ写したファイルは、鍵を包んだときの持ち主（素材のID）を覚えておく。
    ...(str(f.fromAssetId, 64) ? { fromAssetId: str(f.fromAssetId, 64) } : {}),
    enc: { alg: ENC_ALG, key: str(enc.key, 400), plainBytes: Math.floor(plainBytes) },
  };
}

export function normalizeFiles(raw) {
  return arr(raw).map(normalizeFile).filter(Boolean).slice(0, 10);
}

/**
 * 画面・③へ渡す形。**storageUrl・包んだ鍵・③の内部参照を落とす。**
 *   owner … 'asset' | 'creative'、ownerId … その記録のID
 * src は①の認証付き配信口。ブラウザはこれだけを見る。
 */
export function publicFile(f, owner, ownerId) {
  if (!f) return null;
  const q = `type=creative&action=file&owner=${encodeURIComponent(owner || '')}`
    + `&ownerId=${encodeURIComponent(ownerId || '')}&fileId=${encodeURIComponent(f.fileId)}`;
  return {
    fileId: f.fileId, kind: f.kind, contentType: f.contentType,
    bytes: f.bytes, sha256: f.sha256 || '', name: f.name,
    src: `/api/plan-store?${q}`,
  };
}
export function publicFiles(files, owner, ownerId) {
  return arr(files).map(f => publicFile(f, owner, ownerId)).filter(Boolean);
}

/** 画面へ返す素材。保存先URLと鍵を落とす。 */
export function publicAsset(a) {
  if (!a) return null;
  return { ...a, files: publicFiles(a.files, 'asset', a.id) };
}
/** 画面へ返す案。保存先URLと鍵を落とし、履歴の中の内部参照も落とす。 */
export function publicCreative(c) {
  if (!c) return null;
  return {
    ...c,
    files: publicFiles(c.files, 'creative', c.id),
    revisions: arr(c.revisions).map(r => ({ ...r, snapshot: r && r.snapshot
      ? { ...r.snapshot, files: arr(r.snapshot.files).map(x => str(x && x.fileId ? x.fileId : x, 64)) }
      : r && r.snapshot })),
  };
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
  // ⚠️ 区分の申告が無ければ **デモ素材** として扱う。実素材だと勝手に名乗らせない。
  const kind = ASSET_KINDS.includes(input.kind) ? input.kind : 'demo';
  return {
    ok: true,
    asset: {
      // ⚠️ IDは**必ずサーバーが発番する**。クライアントの id を採用すると、
      //    既存レコード（他テナントのものを含む）を指定して上書きできてしまう。
      id: genId('as'),
      tenantId: str(ctx.tenantId, 64),
      companyId: str(input.companyId, 64),
      shopId: str(input.shopId, 64),
      channel, title,
      kind,                                     // 'demo' | 'real'
      kindLabel: ASSET_KIND_LABEL[kind],
      note: str(input.note, 2000),
      files,
      // 写真・声の利用許可。⚠️ 実素材は**許可の確認が承認の前提**。
      consent: {
        photo: !!input.consentPhoto,
        voice: !!input.consentVoice,
        note: str(input.consentNote, 500),
        confirmedBy: (input.consentPhoto || input.consentVoice) ? str(ctx.actorId, 64) : '',
        confirmedAt: (input.consentPhoto || input.consentVoice) ? at : null,
      },
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
  const prevConsent = (asset.consent && typeof asset.consent === 'object') ? asset.consent
    : { photo: false, voice: false, note: '', confirmedBy: '', confirmedAt: null };
  // 写真・声の許可も同じ操作で記録できる（指定が無ければ前のまま）。
  const photo = ctx.consentPhoto === undefined ? prevConsent.photo : !!ctx.consentPhoto;
  const voice = ctx.consentVoice === undefined ? prevConsent.voice : !!ctx.consentVoice;
  const changed = photo !== prevConsent.photo || voice !== prevConsent.voice;
  return {
    ok: true,
    asset: {
      ...asset, updatedAt: at,
      rights: {
        ...asset.rights, status,
        confirmedBy: str(ctx.actorId, 64), confirmedName: str(ctx.actorName, 100), confirmedAt: at,
        note: ctx.note === undefined ? asset.rights.note : str(ctx.note, 500),
      },
      consent: {
        photo, voice,
        note: ctx.consentNote === undefined ? prevConsent.note : str(ctx.consentNote, 500),
        confirmedBy: changed ? str(ctx.actorId, 64) : prevConsent.confirmedBy,
        confirmedAt: changed ? at : (prevConsent.confirmedAt || null),
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
      // ⚠️ IDは**必ずサーバーが発番する**（既存の案を指定して上書きさせない）。
      id: genId('cr'),
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
      cta: str(input.cta, 100),
      files,
      // 版のつながり。⚠️ 修正版は**元の版を消さず**、親と元の版を持つ。
      parentCreativeId: str(input.parentCreativeId, 64),
      sourceCreativeVersion: 0,
      // 生成設定（どの条件で作らせたか）。③の申告を含め、あとから追えるようにする。
      genSettings: normalizeGenSettings(input.genSettings),
      // 制作費。⚠️ 分からないものを 0 にしない（未記録は null）。
      cost: normalizeCost(input.cost),
      // 承認時に人が確かめた項目（架空の体験談・効果保証・偽のBefore/After・正本の使用）
      claims: emptyClaims(),
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

// ── ③へ渡す依頼の形（非同期制作契約 creative-library-1）─────────────
// ⚠️ **修正依頼は、人の原文・対象版・元素材とセットで渡す。**
//    どの版を直すのか（source_creative_version）、どの素材から作るのか（source_asset_ids）が
//    無いと、③は別の版を直したり、元素材と無関係なものを作ってしまう。
//    ③は「曖昧な自由文だけ」だと 422 STRUCTURED_TEXT_CHANGE_REQUIRED を返す契約なので、
//    明示の文言変更（text_changes）も必ず添える。
//    ⚠️ 参照する原制作物は tenant+creative+version から**③が解決する**。
//       ①は任意のファイルURLを送らない。

export const DEFAULT_FORMATS = Object.freeze(['1:1', '4:5', '9:16', 'video_9:16']);

export function buildGenerateRequest(creative, asset, opts = {}) {
  if (!creative) return { ok: false, error: 'not_found' };
  if (!asset) return { ok: false, error: 'asset_not_found' };
  const jobId = str(opts.jobId, 64);
  if (!jobId) return { ok: false, error: 'job_id_required' };
  // ③は sample と live を区別する。①は勝手に live を名乗らない。
  const mode = DATA_MODES.includes(opts.mode) ? opts.mode : 'sample';
  const formats = arr(opts.formats).map(x => str(x, 30)).filter(Boolean);
  const targetVersion = Number(creative.version) || 1;
  const req = {
    job_id: jobId,
    creative_id: creative.id,
    asset_id: creative.assetId,
    tenant_id: creative.tenantId,
    store_id: str(creative.shopId, 64),
    channel: creative.channel,
    mode,
    target_version: targetVersion,
    // 元素材。③は台帳で範囲と権利を再確認する（①の申告だけで通さない）。
    source_asset_ids: [creative.assetId, ...arr(opts.extraAssetIds).map(x => str(x, 64))]
      .filter((v, i, a) => v && a.indexOf(v) === i),
    brand_version: str(opts.brandVersion, 64) || 'demo_brand_v1',
    formats: formats.length ? formats : [...DEFAULT_FORMATS],
    appeal: str(creative.appeal, 200),
    headline: str(creative.headline, 200),
    body: str(creative.body, 4000),
    cta: str(creative.cta, 100),
  };
  const rev = pendingRevision(creative);
  if (rev) {
    // 修正版。**直前の版と人の原文を必ず添える。**
    req.parent_creative_id = str(creative.parentCreativeId, 64) || creative.id;
    req.source_creative_version = Number(rev.fromVersion) || (targetVersion - 1);
    req.revision_instructions = str(rev.text, 2000);
    req.text_changes = normalizeTextChanges(rev.textChanges);
    if (rev.snapshot && arr(rev.snapshot.files).length) {
      // 直す対象がどの版のどのファイルかを、③が照合できるようにする（URLは渡さない）。
      req.source_file_ids = arr(rev.snapshot.files).map(x => str(x, 64)).filter(Boolean);
    }
  }
  return { ok: true, request: req, isRevision: !!rev };
}

// ③のジョブ状態 → ①の状態。**queued/running のあいだは「生成中」のまま**。
export const JOB_STATES = Object.freeze(['queued', 'running', 'completed', 'failed', 'interrupted']);
export function jobProgress(raw) {
  const j = (raw && typeof raw === 'object') ? raw : {};
  const status = JOB_STATES.includes(j.status) ? j.status : '';
  const pollAfterMs = Math.min(10000, Math.max(1000, Math.floor(Number(j.poll_after_ms) || 1000)));
  if (!status) return { done: false, unknown: true, status: '', pollAfterMs };
  if (status === 'queued' || status === 'running') return { done: false, status, pollAfterMs };
  if (status === 'completed') {
    return { done: true, status, result: { ok: true, files: j.files, mode: j.mode,
      appeal: j.appeal, headline: j.headline, body: j.body } };
  }
  // ⚠️ interrupted は「失敗」として人に見せる。勝手に再実行しない（③も自動再実行しない）。
  return { done: true, status, result: { ok: false,
    reason: str((j.error && j.error.message) || j.reason, 300)
      || (status === 'interrupted' ? '生成が中断されました（③側で手動確認が必要です）' : '生成に失敗しました') } };
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
      cta: str(result.cta, 100) || str(creative.cta, 100),
      // どの条件で作られたかを残す（③の申告をそのまま持つ）
      genSettings: { ...normalizeGenSettings(creative.genSettings), ...normalizeGenSettings(result.genSettings), mode },
      // ③が制作費を返すならそのまま持つ。返さなければ未記録のまま（0にしない）。
      cost: result.cost ? normalizeCost(result.cost) : normalizeCost(creative.cost),
      updatedAt: at,
    },
  };
}

// 修正依頼。**元の内容は消さず履歴に残し、下書きへ戻す。**
// ③は「曖昧な自由文だけ」では修正を理解したふりをせず 422 を返す契約なので、
// 人の原文（text）に加えて、**明示の文言変更（textChanges）も一緒に残す**。
export function normalizeTextChanges(v) {
  const src = (v && typeof v === 'object') ? v : {};
  const out = {};
  if (src.headline !== undefined) out.headline = str(src.headline, 200);
  if (src.body !== undefined) out.body = str(src.body, 4000);
  if (src.cta !== undefined) out.cta = str(src.cta, 100);
  return out;
}

export function requestRevision(creative, input = {}, ctx = {}, t) {
  if (!creative) return { ok: false, error: 'not_found' };
  if (!canTransition(creative.status, 'draft')) return { ok: false, error: 'invalid_transition' };
  const text = str(input.text, 2000).trim();
  if (!text) return { ok: false, error: 'text_required' };
  const at = nowMs(t);
  const fromVersion = Number(creative.version) || 1;
  // 指定が無ければ「いまの見出し・本文」をそのまま明示値として持つ（③へ空を送らない）。
  const explicit = normalizeTextChanges(input.textChanges);
  const textChanges = {
    headline: explicit.headline !== undefined ? explicit.headline : str(creative.headline, 200),
    body: explicit.body !== undefined ? explicit.body : str(creative.body, 4000),
    ...(explicit.cta !== undefined ? { cta: explicit.cta } : {}),
  };
  return {
    ok: true,
    creative: {
      ...creative,
      status: 'draft',
      version: fromVersion + 1,
      headline: textChanges.headline,
      body: textChanges.body,
      cta: textChanges.cta !== undefined ? textChanges.cta : str(creative.cta, 100),
      // ⚠️ どの版を直しているのかを、記録にも残す（あとから追えるように）。
      parentCreativeId: str(creative.parentCreativeId, 64) || str(creative.id, 64),
      sourceCreativeVersion: fromVersion,
      // 版が変われば、承認前の確認はやり直し（前の確認を引き継がない）
      claims: emptyClaims(),
      updatedAt: at,
      revisions: [...arr(creative.revisions), {
        id: genId('rev'), at, kind: 'request', text, textChanges,
        by: str(ctx.actorId, 64), byName: str(ctx.actorName, 100),
        fromVersion,
        // ⚠️ 元の版の中身を残す。保存先URLは残さない（fileId だけ）。
        snapshot: { appeal: creative.appeal, headline: creative.headline, body: creative.body,
                    cta: str(creative.cta, 100), files: arr(creative.files).map(f => f.fileId),
                    dataMode: creative.dataMode, genSettings: creative.genSettings || null },
      }].slice(-50),
    },
  };
}

/**
 * いまの下書きのもとになった修正依頼。**その版を作った依頼だけ**を返す。
 * （version N の下書きは、fromVersion === N-1 の依頼から生まれている）
 */
export function pendingRevision(creative) {
  const v = Number(creative && creative.version) || 1;
  if (v <= 1) return null;
  const rs = arr(creative && creative.revisions);
  for (let i = rs.length - 1; i >= 0; i--) {
    if (rs[i] && rs[i].kind === 'request' && Number(rs[i].fromVersion) === v - 1) return rs[i];
  }
  return null;
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
  // ⚠️ 実際の施術素材は、**写真の利用許可の確認が承認の前提**。
  if (asset.kind === 'real' && !(asset.consent && asset.consent.photo)) {
    return { ok: false, error: 'consent_unconfirmed' };
  }
  // ⚠️ 架空の体験談・効果保証・偽のBefore/After を作らないための確認。
  //    人がすべて確かめたときだけ承認できる（自動で埋めない）。
  const claims = ctx.claims === undefined ? creative.claims : normalizeClaims(ctx.claims, ctx, t);
  if (!claimsOk(claims)) return { ok: false, error: 'claims_unchecked' };
  const at = nowMs(t);
  return {
    ok: true,
    creative: {
      ...creative, status: 'approved', updatedAt: at, claims,
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
    // ⚠️ 完成ファイルも保存先URLでは渡さない。①の認証付き配信口だけを渡す。
    files: publicFiles(creative.files, 'creative', creative.id),
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
      files: publicFiles(c.files, 'creative', c.id), revisionCount: arr(c.revisions).length,
      measurement: c.measurement, reviewer: c.reviewer,
    }));
}

// 保存形の矯正（未知キーを生やさない）
export function normalizeStore(raw) {
  const s = (raw && typeof raw === 'object') ? raw : {};
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  return { assets: obj(s.assets), creatives: obj(s.creatives), jobs: obj(s.jobs) };
}
