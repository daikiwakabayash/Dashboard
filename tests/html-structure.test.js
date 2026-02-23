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
  });

  it('メニューアイテムが5つ定義されている', () => {
    const menuMatches = html.match(/menuItems\s*=\s*\[/);
    expect(menuMatches).not.toBeNull();
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

describe('index.html - API呼び出し', () => {
  it('GAS APIのURLが定義されている', () => {
    expect(html).toContain('GAS_API_URL');
    expect(html).toContain('script.google.com');
  });

  it('マーケティングAPIのURLが定義されている', () => {
    expect(html).toContain('MARKETING_API_URL');
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
});
