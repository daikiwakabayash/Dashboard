import { describe, it, expect } from 'vitest';
import {
  STATUSES, CHANNELS, canTransition, normalizeFile, normalizeFiles,
  buildAsset, confirmRights, buildCreative, startJob, completeJob,
  requestRevision, approve, deliverables, compareSet, normalizeStore,
} from '../lib/creative.js';

const CTX = { tenantId: 'naoru', actorId: '__root__', actorName: '本部' };
const IMG = { url: 'https://blob.test/a.png', contentType: 'image/png', bytes: 1234 };
const MOV = { url: 'https://blob.test/a.mp4', contentType: 'video/mp4', bytes: 9999 };
const asset = (over = {}) => buildAsset({ title: '春キャンペーン素材', files: [IMG], channel: 'meta', ...over }, CTX, 1000).asset;
const confirmed = () => confirmRights(asset(), 'confirmed', CTX, 1000).asset;

describe('ファイル: 実ファイルだけを受け取る', () => {
  it('🔴 https 以外は受け取らない（data:/blob:/http で画面に出させない）', () => {
    for (const u of ['http://x/a.png', 'data:image/png;base64,AAA', 'blob:http://x/1', 'javascript:alert(1)', '']) {
      expect(normalizeFile({ url: u, contentType: 'image/png' }), u).toBe(null);
    }
  });
  it('🔴 画像でも動画でもないものは案に載せない', () => {
    expect(normalizeFile({ url: 'https://b/a.pdf', contentType: 'application/pdf' })).toBe(null);
    expect(normalizeFile({ url: 'https://b/a.png', contentType: '' })).toBe(null);
  });
  it('contentType から種別を決める（申告任せにしない）', () => {
    expect(normalizeFile(IMG).kind).toBe('image');
    expect(normalizeFile(MOV).kind).toBe('video');
  });
  it('壊れたファイルは落として、残りは通す', () => {
    expect(normalizeFiles([IMG, { url: 'ftp://x' }, MOV])).toHaveLength(2);
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
