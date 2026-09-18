// 本番で使う画面（index.html「クリエイティブ」）の確認。
// カードが出るだけで完成にせず、実ファイルを表示・再生・比較できることを表明する。
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let html = '', screen = '';
beforeAll(() => {
  html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  // 画面のJSXブロック（最初の出現はポーリング登録なので、JSX側の目印で切り出す）
  const marker = "{currentPage === 'creative' && ccOn('cc_creative_library') && (() => {";
  const from = html.indexOf(marker);
  screen = from >= 0 ? html.slice(from, from + 22000) : '';
});

describe('クリエイティブ画面: 入口と権限', () => {
  it('タブは root/本部のみ・cc_creative_library フラグ付き', () => {
    const row = html.slice(html.indexOf("id: 'creative'"), html.indexOf("id: 'creative'") + 300);
    expect(row).toContain('rootOnly: true');
    expect(row).toContain("flag: 'cc_creative_library'");
  });
  it('リクエストは body に type/action を載せて /api/plan-store へ送る', () => {
    expect(html).toContain("type: 'creative'");
    for (const a of ['list', 'asset_create', 'asset_rights', 'creative_create', 'generate', 'revise', 'approve', 'deliverables', 'compare']) {
      expect(html, a).toContain(`action: '${a}'`);
    }
  });
  it('認証ヘッダを付けて送る', () => {
    expect(html.slice(html.indexOf('const cvPost'), html.indexOf('const cvLoad'))).toContain('ccAuthHeaders()');
  });
});

describe('クリエイティブ画面: 実ファイルを表示・再生する', () => {
  it('🔴 動画は <video controls> で再生できる', () => {
    expect(screen).toContain('<video src={f.url}');
    expect(screen).toContain('controls');
  });
  it('🔴 画像は <img> で表示する（URLの羅列で終わらせない）', () => {
    expect(screen).toContain('<img src={f.url}');
  });
  it('🔴 複数案を横に並べて見比べられる', () => {
    expect(screen).toContain('複数案を比較');
    expect(screen).toContain('c.comparing.creatives.map');
    expect(screen).toContain('overflow-x-auto');
  });
  it('🔴 完成ファイルはダウンロードできる', () => {
    expect(screen).toContain('完成ファイルを取得');
    expect(screen).toContain('download');
  });
});

describe('クリエイティブ画面: 未接続・sample・実生成を区別する', () => {
  it('🔴 3つの状態にそれぞれ別の表示を持つ', () => {
    expect(screen).toContain("live: { cls:");
    expect(screen).toContain("sample: { cls:");
    expect(screen).toContain("not_connected: { cls:");
    expect(screen).toContain('サンプル（実データではありません）');
    expect(screen).toContain('未接続');
    expect(screen).toContain('実生成');
  });
  it('🔴 生成API未接続のときは理由を出し、サンプルを作らないと明示する', () => {
    expect(screen).toContain('③の生成APIが未接続です');
    expect(screen).toContain('サンプルを作りません');
  });
});

describe('クリエイティブ画面: 状態と履歴', () => {
  it('5つの状態を日本語で出す', () => {
    for (const w of ['下書き', '生成中', '失敗', '確認待ち', '承認済み']) expect(screen, w).toContain(w);
  });
  it('🔴 確認待ちのときだけ「修正を依頼」「承認する」を出す', () => {
    expect(screen).toContain("cr.status === 'review' && (");
    expect(screen).toContain('修正を依頼');
    expect(screen).toContain('承認する');
  });
  it('🔴 承認済みのときだけ完成ファイルを取得できる', () => {
    expect(screen).toContain("cr.status === 'approved' && (");
  });
  it('修正履歴・確認者・素材権利・計測リンクを出す', () => {
    expect(screen).toContain('修正履歴');
    expect(screen).toContain('承認:');
    expect(screen).toContain('権利 ');
    expect(screen).toContain('計測リンク:');
  });
  it('素材ID・creative ID・版を出す', () => {
    expect(screen).toContain('素材ID');
    expect(screen).toContain('ID {cr.id}');
    expect(screen).toContain('v{cr.version}');
  });
});

describe('クリエイティブ画面: 二重操作を防ぐ', () => {
  it('処理中は操作を受け付けない', () => {
    expect(html.slice(html.indexOf('const cvBusy'), html.indexOf('const cvAct'))).toContain('if (cv.busy) return;');
    expect(screen).toContain('disabled={c.busy');
  });
  it('🔴 ①で生成そのものや指標計算をしていない（③の担当）', () => {
    const client = html.slice(html.indexOf('const cvPost'), html.indexOf('const aiTrialReview'));
    expect(client).not.toContain('ANTHROPIC');
    expect(client).not.toMatch(/\b(cpa|roas|ctr)\b/i);
  });
});
