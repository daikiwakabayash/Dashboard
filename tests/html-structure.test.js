import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf-8');

// ── index.html 構造チェック ──────────────────────────────────────

describe('index.html - 基本構造', () => {
  it('HTML doctype宣言がある', () => {
    expect(html).toMatch(/<!DOCTYPE html>/i);
  });

  it('必要なReact CDNスクリプトがある', () => {
    expect(html).toContain('react');
    expect(html).toContain('babel');
  });

  it('Tailwind CSSが読み込まれている', () => {
    expect(html).toContain('tailwindcss');
  });
});

describe('index.html - 必須コンポーネント', () => {
  it('全タブのIDが定義されている', () => {
    expect(html).toContain("'dashboard'");
    expect(html).toContain("'charts'");
    expect(html).toContain("'marketing'");
    expect(html).toContain("'square'");
    expect(html).toContain("'planning'");
    expect(html).toContain("'finance'");
  });

  it('ナビゲーション（カテゴリー別）が定義されている', () => {
    // サイドバーはカテゴリー別 navSections で構成し、モバイル用に menuItems へフラット化
    expect(html.match(/navSections\s*=\s*\[/)).not.toBeNull();
    expect(html).toContain('menuItems');
  });

  it('店舗選択セレクトボックスがplanningタブにある', () => {
    expect(html).toContain('planSelectedBranch');
    expect(html).toContain('setPlanSelectedBranch');
  });

  it('AIチャット送信関数がある', () => {
    expect(html).toContain('handlePlanSubmit');
    expect(html).toContain('planMessages');
    expect(html).toContain('planLoading');
  });

  it('Markdownレンダラー関数がある', () => {
    expect(html).toContain('renderMarkdown');
  });

  it('参考リンク管理のstateがある', () => {
    expect(html).toContain('planLinks');
    expect(html).toContain('setPlanLinks');
    expect(html).toContain('naoru_plan_links');
  });

  it('computePlanActualsが店舗名を引数に取る', () => {
    expect(html).toContain('computePlanActuals(planSelectedBranch)');
  });
});

describe('index.html - 認証', () => {
  it('認証stateが定義されている', () => {
    expect(html).toContain('authState');
    expect(html).toContain('setAuthState');
  });

  it('ログイン画面がある', () => {
    expect(html).toContain('handleLogin');
    expect(html).toContain('authPassword');
    expect(html).toContain('パスワードを入力');
  });

  it('ログアウト機能がある', () => {
    expect(html).toContain('handleLogout');
    expect(html).toContain('ログアウト');
  });

  it('認証トークンをlocalStorageに保存する', () => {
    expect(html).toContain('naoru_auth_token');
  });

  it('トークン検証APIを呼び出す', () => {
    expect(html).toContain('/api/settlement-auth');
    expect(html).toContain("action: 'verify'");
  });
  it('アカウント制ログイン（ID＋PASS・店舗アクセス）を持つ', () => {
    expect(html).toContain("action: 'login'");
    expect(html).toContain('naoru_auth_shops');
    expect(html).toContain('naoru_auth_root');
  });
});

describe('index.html - API呼び出し', () => {
  it('GAS APIがプロキシ経由になっている', () => {
    expect(html).toContain('/api/gas-proxy');
  });

  it('マーケティングAPIがプロキシ経由になっている', () => {
    expect(html).toContain('MARKETING_API_URL');
    expect(html).toContain('/api/gas-proxy');
  });

  it('Square APIのURLが定義されている', () => {
    expect(html).toContain('SQUARE_API_URL');
  });

  it('チャットAPIの呼び出しがストリーミング対応', () => {
    expect(html).toContain("stream: true");
    expect(html).toContain('getReader');
  });
});

describe('index.html - セキュリティ', () => {
  it('APIキーがハードコードされていない', () => {
    expect(html).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
    expect(html).not.toMatch(/ANTHROPIC_API_KEY\s*=\s*['"][^'"]+['"]/);
    expect(html).not.toMatch(/sq_live_[a-zA-Z0-9]+/);
  });

  it('GAS URLがフロントエンドにハードコードされていない', () => {
    expect(html).not.toContain('script.google.com/macros/s/');
  });

  it('Google Apps Script deployment IDが露出していない', () => {
    expect(html).not.toMatch(/AKfycb[a-zA-Z0-9_-]+/);
  });
});

// ── ニュース（旧「重要掲示板」）の名称 ──────────────────────────────
// 画面タイトルとメニュー名を「ニュース」に統一する（オーナー指示・UI試作V3）。
// ⚠️ 内部ID（board / type=board / naoru:board:v1）は変えない。既存データを失わないため。
describe('index.html - ニュースの名称', () => {
  it('画面名としての「掲示板」「お知らせ」が残っていない', () => {
    expect(html).not.toContain('掲示板');
    // 「お知らせ」はニュースの**カテゴリー名**としてだけ残す（画面名ではない）
    const hits = html.match(/お知らせ/g) || [];
    expect(hits).toHaveLength(1);
    expect(html).toContain("{ key: 'notice', label: 'お知らせ'");
  });
  it('メニューと画面タイトルが「ニュース」', () => {
    expect(html).toContain("label: 'ニュース'");
    expect(html).toMatch(/>ニュース<\/h1>/);
  });
  it('内部IDは board のまま（保存先を変えない）', () => {
    expect(html).toContain("{ id: 'board'");
    expect(html).toContain("type: 'board'");
  });
});
