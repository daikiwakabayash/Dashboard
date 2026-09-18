import { describe, it, expect } from 'vitest';
import { parseSourceUrl, isSyncable, contentFingerprint, applyFetched, markReviewed, syncSummary, KIND_LABEL } from '../lib/knowledge-sync.js';

const SHEET = 'https://docs.google.com/spreadsheets/d/1osh7Cu59jh3tFIULiCs9p2oW-Om3h6XNnNyw7bZOwAY/edit#gid=0';
const SLIDE = 'https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345678/edit';
const DOC = 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345678/edit';
const base = (over = {}) => ({ id: 'k1', title: '議事録', body: '元の本文', source: SHEET, ...over });

describe('出典URLの読み取り', () => {
  it('スプレッドシート・スライド・ドキュメントを見分ける', () => {
    expect(parseSourceUrl(SHEET).kind).toBe('spreadsheet');
    expect(parseSourceUrl(SLIDE).kind).toBe('presentation');
    expect(parseSourceUrl(DOC).kind).toBe('document');
    expect(parseSourceUrl(SHEET).fileId).toBe('1osh7Cu59jh3tFIULiCs9p2oW-Om3h6XNnNyw7bZOwAY');
  });
  it('🔴 Google以外・自由文は対象にしない（勝手に別のものを読みに行かない）', () => {
    for (const u of ['議事録', 'https://example.com/a', 'http://docs.google.com/spreadsheets/d/xxxxxxxxxxxxxxxxxxxxxx',
                     'https://docs.google.com/spreadsheets/d/short', 'https://evil.com/docs.google.com/document/d/aaaaaaaaaaaaaaaaaaaaaa', '']) {
      expect(parseSourceUrl(u), u).toBe(null);
    }
  });
  it('自動更新をOFFにしたものは対象外', () => {
    expect(isSyncable(base())).toBe(true);
    expect(isSyncable(base({ autoSync: false }))).toBe(false);
    expect(isSyncable(base({ source: '議事録' }))).toBe(false);
  });
});

describe('中身が変わったかの判定', () => {
  it('空白や改行の揺れは「変わった」としない', () => {
    expect(contentFingerprint('あ  い\n\n\n う')).toBe(contentFingerprint('あ い\n\nう'));
  });
  it('中身が違えば変わる', () => {
    expect(contentFingerprint('あいう')).not.toBe(contentFingerprint('あいえ'));
  });
});

describe('取得結果の反映', () => {
  it('変わっていなければ書き換えない', () => {
    const r = applyFetched(base(), { ok: true, body: '元の本文' }, 1000);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe('unchanged');
    expect(r.doc.body).toBe('元の本文');
    expect(r.doc.sync.lastCheckedAt).toBe(1000);
  });
  it('🔴 変わっていたら本文を新しくし、前の本文を履歴へ残す', () => {
    const r = applyFetched(base(), { ok: true, body: '新しい本文', title: '議事録 2026-09' }, 2000);
    expect(r.changed).toBe(true);
    expect(r.doc.body).toBe('新しい本文');
    expect(r.doc.title).toBe('議事録 2026-09');
    expect(r.doc.revisions[0].previousBody).toBe('元の本文');
    expect(r.doc.updatedBy).toBe('自動更新');
  });
  it('🔴 更新したら「未確認」が立ち、本部が確認するまで消えない', () => {
    const r = applyFetched(base(), { ok: true, body: '新しい本文' }, 2000);
    expect(r.doc.sync.needsReview).toBe(true);
    const seen = markReviewed(r.doc, { name: '若林' }, 3000);
    expect(seen.sync.needsReview).toBe(false);
    expect(seen.sync.reviewedBy).toBe('若林');
    expect(seen.sync.reviewedAt).toBe(3000);
  });
  it('🔴 取得に失敗しても前の本文を消さない', () => {
    const r = applyFetched(base(), { ok: false, error: '権限がありません' }, 2000);
    expect(r.changed).toBe(false);
    expect(r.doc.body).toBe('元の本文');
    expect(r.doc.sync.lastError).toBe('権限がありません');
  });
  it('🔴 空で返ってきたら前の本文を残す（共有解除・権限切れ対策）', () => {
    const r = applyFetched(base(), { ok: true, body: '   ' }, 2000);
    expect(r.changed).toBe(false);
    expect(r.doc.body).toBe('元の本文');
    expect(r.doc.sync.lastError).toContain('空');
  });
  it('Google以外の出典は触らない', () => {
    const r = applyFetched(base({ source: '議事録' }), { ok: true, body: 'x' }, 2000);
    expect(r.reason).toBe('not_a_google_url');
    expect(r.doc.body).toBe('元の本文');
  });
  it('履歴は増えすぎない', () => {
    let d = base();
    for (let i = 0; i < 30; i++) d = applyFetched(d, { ok: true, body: `本文${i}` }, 1000 + i).doc;
    expect(d.revisions).toHaveLength(20);
    expect(d.revisions[0].previousBody).toBe('本文28');    // 直前のものが先頭
  });
});

describe('まとめ', () => {
  it('未確認・失敗の件数と一覧を出す', () => {
    const docs = [
      applyFetched(base({ id: 'a', title: 'A' }), { ok: true, body: '新A' }, 1000).doc,
      applyFetched(base({ id: 'b', title: 'B' }), { ok: false, error: '権限なし' }, 1000).doc,
      base({ id: 'c', source: '手入力' }),
    ];
    const s = syncSummary(docs);
    expect(s.total).toBe(3);
    expect(s.syncable).toBe(2);
    expect(s.needsReview).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.pendingTitles[0]).toMatchObject({ id: 'a', title: 'A', kind: KIND_LABEL.spreadsheet });
    expect(s.failedTitles[0]).toMatchObject({ id: 'b', error: '権限なし' });
  });
});

// 取得に失敗したとき、理由が画面まで届くこと（マウスを乗せないと読めない状態にしない）
describe('失敗の理由が集計に出る', () => {
  it('同じ理由はまとめて、重複なく返す', () => {
    const docs = [
      { id: 'a', title: 'A', source: 'https://docs.google.com/spreadsheets/d/1AAAAAAAAAAAAAAAAAAAAAAAA/edit',
        autoSync: true, sync: { lastError: 'unauthorized' } },
      { id: 'b', title: 'B', source: 'https://docs.google.com/presentation/d/1BBBBBBBBBBBBBBBBBBBBBBBB/edit',
        autoSync: true, sync: { lastError: 'unauthorized' } },
      { id: 'c', title: 'C', source: 'https://docs.google.com/document/d/1CCCCCCCCCCCCCCCCCCCCCCCC/edit',
        autoSync: true, sync: { lastError: 'このファイルを開く権限がありません（共有設定をご確認ください）' } },
    ];
    const s = syncSummary(docs);
    expect(s.failed).toBe(3);
    expect(s.failedReasons).toEqual(['unauthorized', 'このファイルを開く権限がありません（共有設定をご確認ください）']);
  });

  it('失敗がなければ空（余計な表示を出さない）', () => {
    expect(syncSummary([]).failedReasons).toEqual([]);
  });
});
