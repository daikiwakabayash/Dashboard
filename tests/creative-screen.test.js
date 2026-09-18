// ⚠️ **これは「表示の確認」ではありません。**
//    index.html の**記述**（配線・条件・文言）が抜けていないかを見るだけの試験です。
//    ここが緑でも「画像が実際に開ける／動画が実際に再生できる」ことは何も示しません。
//
//    実際の表示・再生の確認は **scripts/creative-screen-check.mjs**（実ブラウザ）で行い、
//    報告も分けてください:
//      ・コード保存 …… この試験（記述の確認）
//      ・デモでの確認 … scripts/creative-screen-check.mjs（ローカル実画面＋スタブAPI）
//      ・本番での確認 … 配備先で同じ手順を人が確認したとき
//
//    実行方法は scripts/creative-screen-check.mjs の先頭に書いてあります。
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let html = '', screen = '';
beforeAll(() => {
  html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  // 画面のJSXブロック（最初の出現はポーリング登録なので、JSX側の目印で切り出す）
  const marker = "{currentPage === 'creative' && ccOn('cc_creative_library') && (() => {";
  const from = html.indexOf(marker);
  screen = from >= 0 ? html.slice(from, from + 30000) : '';
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

describe('クリエイティブ画面: 実ファイルを出す配線がある（表示できたことの確認ではない）', () => {
  it('動画は <video controls> を書いている', () => {
    expect(html).toContain('<video data-cv-media="video"');
    expect(html).toContain('controls');
  });
  it('画像は <img> を書いている（URLの羅列で終わらせない）', () => {
    expect(html).toContain('<img data-cv-media="image"');
  });
  it('🔴 保存先URLを画面で使わない（①の認証付き配信口だけを見る）', () => {
    expect(screen).not.toContain('f.url');
    const media = html.slice(html.indexOf('const CvMedia'), html.indexOf('const CvMedia') + 1800);
    expect(media).toContain('cvMediaFetch(key)');
    const fetcher = html.slice(html.indexOf('const cvMediaFetch'), html.indexOf('const CvMedia'));
    expect(fetcher).toContain('cvMediaAuth.headers()');
    expect(html).toContain('cvMediaAuth.headers = () => ccAuthHeaders();');
  });
  it('🔴 保存先へは暗号文だけを送る（平文をアップロードしない）', () => {
    const up = html.slice(html.indexOf('const cvUpload'), html.indexOf('const cvBusy'));
    expect(up).toContain('cvcEncrypt(dataKey, fileId, plain)');
    expect(up).toContain("__blobUpload(`creative/${fileId}.enc`");
    expect(up).not.toContain('__blobUpload(`creative/${Date.now()}');
  });
  it('🔴 生成は受付だけして、進み具合を聞きに行く（同期で待たない）', () => {
    expect(html).toContain("action: 'job_status'");
    const poll = html.slice(html.indexOf('const cvPoll ='), html.indexOf('const cvGenerate'));
    expect(poll).toContain('Math.min(10000');          // 無制限に叩かない
  });
  it('承認の前に確認する項目がある（自動でチェックを入れない）', () => {
    expect(html).toContain('承認の前に確認してください');
    for (const k of ['noFakeTestimonial', 'noGuarantee', 'noFakeBeforeAfter', 'brandFromSource']) expect(html, k).toContain(k);
    expect(html).toContain('claims: {}');                   // 既定は空（全部 false）
    expect(html).toContain('CV_CLAIM_CHECKS.every(ck => c.claims[ck.key])');   // 全部そろうまで押せない
  });
  it('デモ素材と実際の施術素材を選べる', () => {
    expect(html).toContain('data-cv-kind');
    expect(html).toContain('実際の施術素材');
    expect(html).toContain('写真の利用許可を得ていますか');
  });
  it('🔴 制作費は分からないものを 0 と書かない', () => {
    expect(screen).toContain("制作費:");
    expect(screen).toContain("'未記録'");
  });
  it('🔴 複数案を横に並べて見比べられる', () => {
    expect(screen).toContain('複数案を比較');
    expect(screen).toContain('c.comparing.creatives.map');
    expect(screen).toContain('overflow-x-auto');
  });
  it('🔴 完成ファイルは認証付きで取ってから保存する（保存先URLを開かない）', () => {
    expect(screen).toContain('完成ファイルを取得');
    expect(screen).toContain('cvDownload(f)');
    const dl = html.slice(html.indexOf('const cvDownload'), html.indexOf('const cvBusy'));
    expect(dl).toContain('cvMediaFetch(f && f.src)');
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
