import { describe, it, expect } from 'vitest';
import {
  STATUSES, CHANNELS, canTransition, normalizeFile, normalizeFiles,
  buildAsset, confirmRights, buildCreative, startJob, completeJob,
  requestRevision, approve, deliverables, compareSet, normalizeStore,
  publicFile, publicAsset, publicCreative, buildGenerateRequest, pendingRevision,
  jobProgress, DEFAULT_FORMATS,
} from '../lib/creative.js';

const CTX = { tenantId: 'naoru', actorId: '__root__', actorName: '本部' };
// 保存先には**暗号文しか置かない**。記録は「保存先URL＋包んだ鍵」を持ち、画面へは渡さない。
const STORE = 'https://abc123.public.blob.vercel-storage.com/creative/';
const encOf = (n) => ({ alg: 'A256GCM-CHUNK1M', key: 'd3JhcHBlZC1rZXktYjY0', plainBytes: n });
const IMG = { storageUrl: `${STORE}a.png`, contentType: 'image/png', bytes: 1234, enc: encOf(1234) };
const MOV = { storageUrl: `${STORE}a.mp4`, contentType: 'video/mp4', bytes: 9999, enc: encOf(9999) };
const asset = (over = {}) => buildAsset({ title: '春キャンペーン素材', files: [IMG], channel: 'meta', ...over }, CTX, 1000).asset;
const confirmed = () => confirmRights(asset(), 'confirmed', CTX, 1000).asset;

describe('ファイル: 保存先を偽らせない・平文で置かせない', () => {
  it('🔴 許可した保存先以外は受け取らない（任意URLを画面で開かせない）', () => {
    for (const u of ['http://x/a.png', 'https://evil.example/a.png', 'data:image/png;base64,AAA',
                     'blob:http://x/1', 'javascript:alert(1)', '']) {
      expect(normalizeFile({ ...IMG, storageUrl: u }), u).toBe(null);
    }
  });
  it('🔴 暗号化されていない保存物は受け取らない（URLを隠すだけの公開保存にしない）', () => {
    expect(normalizeFile({ ...IMG, enc: undefined })).toBe(null);
    expect(normalizeFile({ ...IMG, enc: { alg: 'none', key: 'k', plainBytes: 1 } })).toBe(null);
    expect(normalizeFile({ ...IMG, enc: { alg: 'A256GCM-CHUNK1M', key: '', plainBytes: 1 } })).toBe(null);
  });
  it('🔴 画像でも動画でもないものは案に載せない', () => {
    expect(normalizeFile({ ...IMG, contentType: 'application/pdf' })).toBe(null);
    expect(normalizeFile({ ...IMG, contentType: '' })).toBe(null);
  });
  it('contentType から種別を決める（申告任せにしない）', () => {
    expect(normalizeFile(IMG).kind).toBe('image');
    expect(normalizeFile(MOV).kind).toBe('video');
  });
  it('③のジョブ成果物は jobId と番号で受け取る（URLは受け取らない）', () => {
    const f = normalizeFile({ src: 'job', jobId: 'job_1', index: 0, contentType: 'video/mp4', bytes: 10 });
    expect(f).toMatchObject({ src: 'job', jobId: 'job_1', index: 0, kind: 'video' });
    expect(normalizeFile({ src: 'job', jobId: '', index: 0, contentType: 'video/mp4' })).toBe(null);
  });
  it('壊れたファイルは落として、残りは通す', () => {
    expect(normalizeFiles([IMG, { storageUrl: 'ftp://x' }, MOV])).toHaveLength(2);
  });
  it('sha256 は64桁の16進だけ受け取る（偽の照合値を持たない）', () => {
    expect(normalizeFile({ ...IMG, sha256: 'a'.repeat(64) }).sha256).toBe('a'.repeat(64));
    expect(normalizeFile({ ...IMG, sha256: 'zz' }).sha256).toBe('');
  });
});

describe('🔴 保存先URLと鍵を画面・③へ渡さない', () => {
  const f = normalizeFile(IMG);
  it('画面が受け取るのは①の認証付き配信口だけ', () => {
    const p = publicFile(f, 'asset', 'as_1');
    expect(p.src).toBe(`/api/plan-store?type=creative&action=file&owner=asset&ownerId=as_1&fileId=${f.fileId}`);
    expect(JSON.stringify(p)).not.toContain('blob.vercel-storage.com');
    expect(JSON.stringify(p)).not.toContain('d3JhcHBlZC1rZXktYjY0');
    expect(p.storageUrl).toBeUndefined();
    expect(p.enc).toBeUndefined();
  });
  it('素材・案を画面へ返すときも落ちている', () => {
    const a = buildAsset({ title: 'x', files: [IMG] }, CTX, 1000).asset;
    expect(JSON.stringify(publicAsset(a))).not.toContain('blob.vercel-storage.com');
    const c = buildCreative(a, { origin: 'uploaded', files: [MOV] }, CTX, 1000).creative;
    expect(JSON.stringify(publicCreative(c))).not.toContain('blob.vercel-storage.com');
  });
  it('修正履歴の中にも保存先を残さない', () => {
    const c = buildCreative(buildAsset({ title: 'x', files: [IMG] }, CTX).asset,
      { origin: 'uploaded', files: [IMG] }, CTX).creative;
    const r = requestRevision(c, { text: '直して' }, CTX).creative;
    expect(JSON.stringify(publicCreative(r))).not.toContain('blob.vercel-storage.com');
    expect(r.revisions[0].snapshot.files[0]).toBe(c.files[0].fileId);
  });
  it('完成ファイル・比較でも配信口だけを渡す', () => {
    const a = confirmRights(buildAsset({ title: 'x', files: [IMG] }, CTX).asset, 'confirmed', CTX).asset;
    const up = approve(buildCreative(a, { origin: 'uploaded', files: [IMG] }, CTX).creative, a, CTX).creative;
    expect(deliverables(up).files[0].src).toContain('action=file');
    expect(JSON.stringify(deliverables(up))).not.toContain('blob.vercel-storage.com');
    expect(JSON.stringify(compareSet([up], a.id))).not.toContain('blob.vercel-storage.com');
  });
});

describe('🔴 IDを指定して既存レコードを上書きできない', () => {
  it('素材のIDはサーバーが発番する（クライアントの申告を採用しない）', () => {
    const a = buildAsset({ id: 'as_他社の素材', title: 'x', files: [IMG] }, CTX).asset;
    expect(a.id).not.toBe('as_他社の素材');
    expect(a.id.startsWith('as_')).toBe(true);
  });
  it('案のIDもサーバーが発番する', () => {
    const a = buildAsset({ title: 'x', files: [IMG] }, CTX).asset;
    const c = buildCreative(a, { id: 'cr_他社の案', origin: 'uploaded', files: [IMG] }, CTX).creative;
    expect(c.id).not.toBe('cr_他社の案');
    expect(c.id.startsWith('cr_')).toBe(true);
  });
  it('2回作っても同じIDにならない', () => {
    const ids = new Set();
    for (let i = 0; i < 50; i++) ids.add(buildAsset({ title: 'x', files: [IMG] }, CTX).asset.id);
    expect(ids.size).toBe(50);
  });
});

describe('状態遷移: 下書き/生成中/失敗/確認待ち/承認済み', () => {
  it('決められた順序だけ通す', () => {
    expect(canTransition('draft', 'generating')).toBe(true);
    expect(canTransition('generating', 'review')).toBe(true);
    expect(canTransition('review', 'approved')).toBe(true);
    expect(canTransition('review', 'draft')).toBe(true);       // 修正依頼
    expect(canTransition('failed', 'generating')).toBe(true);
  });
  it('🔴 生成を飛ばして承認できない / 承認済みから戻せない', () => {
    expect(canTransition('draft', 'approved')).toBe(false);
    expect(canTransition('generating', 'approved')).toBe(false);
    expect(canTransition('approved', 'draft')).toBe(false);
    expect(canTransition('approved', 'review')).toBe(false);
  });
});

describe('素材', () => {
  it('題名とファイルが要る', () => {
    expect(buildAsset({ files: [IMG] }, CTX).error).toBe('title_required');
    expect(buildAsset({ title: 'x' }, CTX).error).toBe('file_required');
  });
  it('🔴 権利は既定で未確認（勝手に確認済みにしない）', () => {
    expect(asset().rights.status).toBe('unconfirmed');
    expect(asset().rights.confirmedAt).toBe(null);
  });
  it('確認すると確認者と日時が残る', () => {
    const a = confirmRights(asset(), 'confirmed', CTX, 2000).asset;
    expect(a.rights.status).toBe('confirmed');
    expect(a.rights.confirmedBy).toBe('__root__');
    expect(a.rights.confirmedAt).toBe(2000);
  });
  it('企業・店舗・媒体を持つ', () => {
    const a = asset({ companyId: 'c1', shopId: 's1', channel: 'line' });
    expect([a.companyId, a.shopId, a.channel]).toEqual(['c1', 's1', 'line']);
    expect(CHANNELS).toContain(a.channel);
  });
  it('知らない媒体は other に落とす', () => {
    expect(asset({ channel: 'tiktok' }).channel).toBe('other');
  });
});

describe('案の作成と生成依頼', () => {
  it('生成依頼の案は下書きから始まり、未接続として始まる', () => {
    const c = buildCreative(asset(), { origin: 'generated' }, CTX, 1000).creative;
    expect(c.status).toBe('draft');
    expect(c.dataMode).toBe('not_connected');
    expect(c.version).toBe(1);
  });
  it('手元の素材をそのまま案にする場合はファイルが要る', () => {
    expect(buildCreative(asset(), { origin: 'uploaded' }, CTX).error).toBe('file_required');
    expect(buildCreative(asset(), { origin: 'uploaded', files: [IMG] }, CTX).creative.status).toBe('review');
  });
  it('依頼すると生成中になり、依頼の記録が残る', () => {
    const c = buildCreative(asset(), {}, CTX, 1000).creative;
    const r = startJob(c, { ...CTX, jobId: 'job_1' }, 2000);
    expect(r.creative.status).toBe('generating');
    expect(r.job).toMatchObject({ id: 'job_1', creativeId: c.id, requestedBy: '__root__', mode: 'not_connected' });
  });
  it('🔴 生成中のものを二重に依頼できない', () => {
    const c = startJob(buildCreative(asset(), {}, CTX).creative, CTX).creative;
    expect(startJob(c, CTX).error).toBe('invalid_transition');
  });
});

describe('生成結果の受け取り', () => {
  const gen = () => startJob(buildCreative(asset(), {}, CTX, 1000).creative, CTX, 1000).creative;
  it('ファイルが返れば確認待ちになる', () => {
    const r = completeJob(gen(), { ok: true, files: [IMG, MOV], mode: 'live', headline: '見出し' }, 3000);
    expect(r.creative.status).toBe('review');
    expect(r.creative.files).toHaveLength(2);
    expect(r.creative.headline).toBe('見出し');
  });
  it('🔴 ③の申告をそのまま持つ（勝手に live へ上げない）', () => {
    expect(completeJob(gen(), { ok: true, files: [IMG], mode: 'sample' }).creative.dataMode).toBe('sample');
    expect(completeJob(gen(), { ok: true, files: [IMG] }).creative.dataMode).toBe('not_connected');
    expect(completeJob(gen(), { ok: true, files: [IMG], mode: 'LIVE' }).creative.dataMode).toBe('not_connected');
  });
  it('🔴 ファイルが無い「成功」は失敗として扱う（空のカードを出さない）', () => {
    const r = completeJob(gen(), { ok: true, files: [] });
    expect(r.creative.status).toBe('failed');
    expect(r.creative.failureReason).toContain('ファイル');
  });
  it('失敗は理由とともに残る', () => {
    expect(completeJob(gen(), { ok: false, reason: '素材が読めません' }).creative.failureReason).toBe('素材が読めません');
  });
});

describe('修正依頼', () => {
  const reviewed = () => completeJob(startJob(buildCreative(asset(), {}, CTX, 1000).creative, CTX, 1000).creative,
    { ok: true, files: [IMG], mode: 'live', headline: '元の見出し' }, 2000).creative;
  it('🔴 元の内容を消さず履歴に残し、版を上げて下書きへ戻す', () => {
    const r = requestRevision(reviewed(), { text: '文字を大きく' }, CTX, 3000);
    expect(r.creative.status).toBe('draft');
    expect(r.creative.version).toBe(2);
    expect(r.creative.revisions).toHaveLength(1);
    expect(r.creative.revisions[0]).toMatchObject({ text: '文字を大きく', by: '__root__', fromVersion: 1 });
    expect(r.creative.revisions[0].snapshot.headline).toBe('元の見出し');
  });
  it('内容の無い修正依頼は受け付けない', () => {
    expect(requestRevision(reviewed(), { text: '  ' }, CTX).error).toBe('text_required');
  });
  it('🔴 承認済みには修正依頼を出せない（新しい版を作る）', () => {
    const a = confirmed();
    const c = completeJob(startJob(buildCreative(a, {}, CTX).creative, CTX).creative, { ok: true, files: [IMG], mode: 'live' }).creative;
    const ap = approve(c, a, CTX, 4000).creative;
    expect(requestRevision(ap, { text: 'x' }, CTX).error).toBe('invalid_transition');
  });
});

describe('承認', () => {
  const live = (a) => completeJob(startJob(buildCreative(a, {}, CTX).creative, CTX).creative,
    { ok: true, files: [IMG], mode: 'live' }).creative;
  it('🔴 sample は承認できない（完成ファイルにしない）', () => {
    const a = confirmed();
    const s = completeJob(startJob(buildCreative(a, {}, CTX).creative, CTX).creative, { ok: true, files: [IMG], mode: 'sample' }).creative;
    expect(approve(s, a, CTX).error).toBe('sample_not_approvable');
  });
  it('🔴 未接続のまま承認できない', () => {
    const a = confirmed();
    const n = completeJob(startJob(buildCreative(a, {}, CTX).creative, CTX).creative, { ok: true, files: [IMG] }).creative;
    expect(approve(n, a, CTX).error).toBe('sample_not_approvable');
  });
  it('🔴 素材権利が未確認なら承認できない', () => {
    const a = asset();                       // unconfirmed
    expect(approve(live(a), a, CTX).error).toBe('rights_unconfirmed');
    const r = confirmRights(a, 'restricted', CTX).asset;
    expect(approve(live(r), r, CTX).error).toBe('rights_unconfirmed');
  });
  it('権利確認済み＋実生成なら承認でき、確認者が残る', () => {
    const a = confirmed();
    const r = approve(live(a), a, CTX, 5000);
    expect(r.creative.status).toBe('approved');
    expect(r.creative.reviewer).toMatchObject({ id: '__root__', name: '本部', at: 5000 });
  });
  it('手元の素材をそのまま使う案は、権利確認済みなら承認できる', () => {
    const a = confirmed();
    const up = buildCreative(a, { origin: 'uploaded', files: [IMG] }, CTX).creative;
    expect(approve(up, a, CTX).creative.status).toBe('approved');
  });
});

describe('完成ファイルの取得', () => {
  it('🔴 承認済みのものだけ渡す', () => {
    const a = confirmed();
    const c = completeJob(startJob(buildCreative(a, {}, CTX).creative, CTX).creative, { ok: true, files: [IMG, MOV], mode: 'live' }).creative;
    expect(deliverables(c).ok).toBe(false);          // まだ確認待ち
    const ap = approve(c, a, CTX).creative;
    const d = deliverables(ap);
    expect(d.ok).toBe(true);
    expect(d.files).toHaveLength(2);
    expect(d.files[0].src).toContain('action=file');
    expect(d.dataMode).toBe('live');
  });
});

describe('複数案の比較', () => {
  it('同じ素材から出た案だけを並べ、状態と生成元を添える', () => {
    const a = asset();
    const c1 = buildCreative(a, { origin: 'uploaded', files: [IMG], headline: 'A案' }, CTX, 1000).creative;
    const c2 = buildCreative(a, { origin: 'uploaded', files: [MOV], headline: 'B案' }, CTX, 2000).creative;
    const other = buildCreative(asset({ title: '別素材' }), { origin: 'uploaded', files: [IMG] }, CTX, 3000).creative;
    const set = compareSet([c1, c2, other], a.id);
    expect(set).toHaveLength(2);
    expect(set.map(x => x.headline).sort()).toEqual(['A案', 'B案']);
    expect(set[0].statusLabel).toBe('確認待ち');
    expect(set[0].dataMode).toBe('not_connected');
  });
});

describe('保存形', () => {
  it('未知のキーを生やさない', () => {
    expect(Object.keys(normalizeStore({ assets: {}, evil: 1 })).sort()).toEqual(['assets', 'creatives', 'jobs']);
    expect(normalizeStore(null)).toEqual({ assets: {}, creatives: {}, jobs: {} });
  });
  it('状態の一覧は5つ', () => { expect(STATUSES).toHaveLength(5); });
});

describe('🔴 修正依頼は「対象版・元素材・人の原文」とセットで③へ渡す', () => {
  const a = () => buildAsset({ title: '春キャンペーン素材', files: [IMG], shopId: 'shop_鶴見' }, CTX, 1000).asset;
  const reviewed = (as) => completeJob(startJob(buildCreative(as, { appeal: '産後ケア', headline: '元の見出し', body: '元の本文' }, CTX, 1000).creative, CTX, 1000).creative,
    { ok: true, files: [IMG], mode: 'sample' }, 2000).creative;

  it('初回の依頼には、元素材・対象版・形式・ブランド版が入る', () => {
    const as = a();
    const c = buildCreative(as, { appeal: '産後ケア' }, CTX).creative;
    const r = buildGenerateRequest(c, as, { jobId: 'job_1' });
    expect(r.ok).toBe(true);
    expect(r.isRevision).toBe(false);
    expect(r.request).toMatchObject({
      job_id: 'job_1', creative_id: c.id, asset_id: as.id, tenant_id: 'naoru',
      store_id: 'shop_鶴見', target_version: 1, mode: 'sample', brand_version: 'demo_brand_v1',
    });
    expect(r.request.source_asset_ids).toEqual([as.id]);
    expect(r.request.formats).toEqual([...DEFAULT_FORMATS]);
    expect(r.request.parent_creative_id).toBeUndefined();
  });

  it('修正版には parent / 直前の版 / 人の原文 / 明示の文言変更が入る', () => {
    const as = a();
    const v1 = reviewed(as);
    const c = requestRevision(v1, { text: '文字をもっと大きく、価格は出さないで' }, CTX, 3000).creative;
    const r = buildGenerateRequest(c, as, { jobId: 'job_2' });
    expect(r.isRevision).toBe(true);
    expect(r.request).toMatchObject({
      parent_creative_id: c.id,
      source_creative_version: 1,
      target_version: 2,
      revision_instructions: '文字をもっと大きく、価格は出さないで',
    });
    // ③は自由文だけだと 422 を返す契約。明示の文言も必ず添える。
    expect(r.request.text_changes).toMatchObject({ headline: '元の見出し', body: '元の本文' });
    expect(r.request.source_asset_ids).toContain(as.id);
    expect(r.request.source_file_ids).toEqual([v1.files[0].fileId]);
  });

  it('見出し・本文を書き換えて依頼すると、その値が text_changes に入る', () => {
    const as = a();
    const c = requestRevision(reviewed(as), { text: '見出しを変えて',
      textChanges: { headline: '新しい見出し', cta: '今すぐ予約' } }, CTX, 3000).creative;
    const r = buildGenerateRequest(c, as, { jobId: 'job_3' });
    expect(r.request.text_changes).toEqual({ headline: '新しい見出し', body: '元の本文', cta: '今すぐ予約' });
    expect(c.headline).toBe('新しい見出し');
  });

  it('🔴 保存先URLを③へ送らない（参照は ID だけ）', () => {
    const as = a();
    const c = requestRevision(reviewed(as), { text: '直して' }, CTX).creative;
    const r = buildGenerateRequest(c, as, { jobId: 'job_4' });
    expect(JSON.stringify(r.request)).not.toContain('blob.vercel-storage.com');
    expect(JSON.stringify(r.request)).not.toContain('https://');
  });

  it('いまの下書きを作った依頼だけを対象にする（古い依頼を混ぜない）', () => {
    const as = a();
    const v2 = requestRevision(reviewed(as), { text: '1回目' }, CTX, 3000).creative;
    const back = completeJob(startJob(v2, CTX).creative, { ok: true, files: [IMG], mode: 'sample' }).creative;
    const v3 = requestRevision(back, { text: '2回目' }, CTX, 4000).creative;
    expect(pendingRevision(v3).text).toBe('2回目');
    expect(buildGenerateRequest(v3, as, { jobId: 'j' }).request.source_creative_version).toBe(2);
  });

  it('job_id が無ければ依頼を組み立てない', () => {
    const as = a();
    expect(buildGenerateRequest(buildCreative(as, {}, CTX).creative, as, {}).error).toBe('job_id_required');
    expect(buildGenerateRequest(null, as, { jobId: 'j' }).error).toBe('not_found');
    expect(buildGenerateRequest(buildCreative(as, {}, CTX).creative, null, { jobId: 'j' }).error).toBe('asset_not_found');
  });

  it('🔴 ①が勝手に live を名乗らない', () => {
    const as = a();
    const c = buildCreative(as, {}, CTX).creative;
    expect(buildGenerateRequest(c, as, { jobId: 'j' }).request.mode).toBe('sample');
    expect(buildGenerateRequest(c, as, { jobId: 'j', mode: 'なんでも' }).request.mode).toBe('sample');
  });
});

describe('生成ジョブの進み具合（非同期）', () => {
  it('queued / running のあいだは終わったことにしない', () => {
    expect(jobProgress({ status: 'queued', poll_after_ms: 1000 })).toMatchObject({ done: false, status: 'queued', pollAfterMs: 1000 });
    expect(jobProgress({ status: 'running' }).done).toBe(false);
  });
  it('待ち時間は1〜10秒に収める（無制限に叩かない・急かさない）', () => {
    expect(jobProgress({ status: 'running', poll_after_ms: 1 }).pollAfterMs).toBe(1000);
    expect(jobProgress({ status: 'running', poll_after_ms: 999999 }).pollAfterMs).toBe(10000);
  });
  it('completed ならファイルと mode を持って返す', () => {
    const p = jobProgress({ status: 'completed', files: [IMG], mode: 'sample', headline: 'H' });
    expect(p.done).toBe(true);
    expect(p.result).toMatchObject({ ok: true, mode: 'sample', headline: 'H' });
  });
  it('🔴 中断は「失敗」として人に見せる（勝手に再実行しない）', () => {
    const p = jobProgress({ status: 'interrupted' });
    expect(p.done).toBe(true);
    expect(p.result.ok).toBe(false);
    expect(p.result.reason).toContain('中断');
  });
  it('🔴 状態が分からないときに成功にも失敗にもしない', () => {
    expect(jobProgress({})).toMatchObject({ done: false, unknown: true });
    expect(jobProgress(null).done).toBe(false);
  });
  it('失敗は理由が残る', () => {
    expect(jobProgress({ status: 'failed', error: { message: '素材が読めません' } }).result.reason).toBe('素材が読めません');
  });
});
