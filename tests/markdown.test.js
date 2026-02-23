import { describe, it, expect } from 'vitest';
import { parseMarkdown, parseInlineMarkdown } from '../lib/markdown.js';

// ── parseMarkdown: 見出し ─────────────────────────────────────────

describe('parseMarkdown - 見出し', () => {
  it('h1をパースする', () => {
    const tokens = parseMarkdown('# タイトル');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({ type: 'h1', content: 'タイトル' });
  });

  it('h2をパースする', () => {
    const tokens = parseMarkdown('## セクション');
    expect(tokens[0]).toEqual({ type: 'h2', content: 'セクション' });
  });

  it('h3をパースする', () => {
    const tokens = parseMarkdown('### サブセクション');
    expect(tokens[0]).toEqual({ type: 'h3', content: 'サブセクション' });
  });
});

// ── parseMarkdown: リスト ─────────────────────────────────────────

describe('parseMarkdown - リスト', () => {
  it('箇条書きリストをパースする', () => {
    const tokens = parseMarkdown('- 項目1\n- 項目2\n- 項目3');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('unordered-list');
    expect(tokens[0].items).toEqual(['項目1', '項目2', '項目3']);
  });

  it('番号付きリストをパースする', () => {
    const tokens = parseMarkdown('1. 最初\n2. 次\n3. 最後');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('ordered-list');
    expect(tokens[0].items).toEqual(['最初', '次', '最後']);
  });

  it('* でも箇条書きリストをパースする', () => {
    const tokens = parseMarkdown('* 項目A\n* 項目B');
    expect(tokens[0].type).toBe('unordered-list');
    expect(tokens[0].items).toHaveLength(2);
  });

  it('リスト種別が変わったら別リストにする', () => {
    const tokens = parseMarkdown('- 箇条書き\n\n1. 番号付き');
    expect(tokens).toHaveLength(2);
    expect(tokens[0].type).toBe('unordered-list');
    expect(tokens[1].type).toBe('ordered-list');
  });
});

// ── parseMarkdown: テーブル ───────────────────────────────────────

describe('parseMarkdown - テーブル', () => {
  it('基本的なテーブルをパースする', () => {
    const md = '| 指標 | 値 |\n|------|------|\n| CPA | ¥10,000 |';
    const tokens = parseMarkdown(md);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('table');
    expect(tokens[0].header).toEqual(['指標', '値']);
    expect(tokens[0].body).toHaveLength(1);
    expect(tokens[0].body[0]).toEqual(['CPA', '¥10,000']);
  });

  it('複数行のテーブルをパースする', () => {
    const md = [
      '| 店舗 | 売上 | 新規数 |',
      '|------|------|--------|',
      '| 恵比寿院 | ¥500,000 | 20 |',
      '| 千葉駅院 | ¥300,000 | 15 |',
    ].join('\n');
    const tokens = parseMarkdown(md);
    expect(tokens[0].type).toBe('table');
    expect(tokens[0].header).toEqual(['店舗', '売上', '新規数']);
    expect(tokens[0].body).toHaveLength(2);
  });

  it('テーブル行間の空行があっても正しくパースする', () => {
    const md = [
      '| 指標 | 値 |',
      '',
      '|------|------|',
      '',
      '| CPA | ¥10,000 |',
      '| ROAS | 300% |',
    ].join('\n');
    const tokens = parseMarkdown(md);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('table');
    expect(tokens[0].header).toEqual(['指標', '値']);
    expect(tokens[0].body).toHaveLength(2);
  });

  it('テーブルの後に別の要素が続く場合', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |\n\n## 次のセクション';
    const tokens = parseMarkdown(md);
    expect(tokens).toHaveLength(2);
    expect(tokens[0].type).toBe('table');
    expect(tokens[1].type).toBe('h2');
  });
});

// ── parseMarkdown: 区切り線 ──────────────────────────────────────

describe('parseMarkdown - 区切り線', () => {
  it('---を区切り線として認識する', () => {
    const tokens = parseMarkdown('テスト\n\n---\n\n次');
    expect(tokens.some(t => t.type === 'hr')).toBe(true);
  });

  it('***を区切り線として認識する', () => {
    const tokens = parseMarkdown('***');
    expect(tokens[0].type).toBe('hr');
  });
});

// ── parseMarkdown: 段落 ──────────────────────────────────────────

describe('parseMarkdown - 段落', () => {
  it('通常のテキストを段落として認識する', () => {
    const tokens = parseMarkdown('これは普通のテキストです');
    expect(tokens[0]).toEqual({ type: 'paragraph', content: 'これは普通のテキストです' });
  });
});

// ── parseMarkdown: 複合テスト ────────────────────────────────────

describe('parseMarkdown - 複合', () => {
  it('見出し + リスト + テーブルの複合コンテンツ', () => {
    const md = [
      '## 分析結果',
      '',
      '### ポイント',
      '- CPA改善が必要',
      '- 入会率は良好',
      '',
      '| 指標 | 実績 | 目標 |',
      '|------|------|------|',
      '| CPA | ¥15,000 | ¥10,000 |',
      '| 入会率 | 45% | 50% |',
      '',
      '### アクション',
      '1. HPB広告を最適化',
      '2. Google広告を増額',
    ].join('\n');

    const tokens = parseMarkdown(md);
    const types = tokens.map(t => t.type);

    expect(types).toContain('h2');
    expect(types).toContain('h3');
    expect(types).toContain('unordered-list');
    expect(types).toContain('table');
    expect(types).toContain('ordered-list');
  });

  it('空のテキストは空配列を返す', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown(null)).toEqual([]);
    expect(parseMarkdown(undefined)).toEqual([]);
  });
});

// ── parseInlineMarkdown ─────────────────────────────────────────

describe('parseInlineMarkdown', () => {
  it('太字をパースする', () => {
    const tokens = parseInlineMarkdown('これは**重要**です');
    expect(tokens).toHaveLength(3);
    expect(tokens[0]).toEqual({ type: 'text', content: 'これは' });
    expect(tokens[1]).toEqual({ type: 'bold', content: '重要' });
    expect(tokens[2]).toEqual({ type: 'text', content: 'です' });
  });

  it('リンクをパースする', () => {
    const tokens = parseInlineMarkdown('[HPB管理画面](https://example.com)にアクセス');
    expect(tokens[0]).toEqual({ type: 'link', text: 'HPB管理画面', url: 'https://example.com' });
    expect(tokens[1]).toEqual({ type: 'text', content: 'にアクセス' });
  });

  it('コードをパースする', () => {
    const tokens = parseInlineMarkdown('コマンド `npm test` を実行');
    expect(tokens[1]).toEqual({ type: 'code', content: 'npm test' });
  });

  it('複数のインライン要素を含むテキスト', () => {
    const tokens = parseInlineMarkdown('**CPA**: ¥10,000 [詳細](https://x.com)');
    expect(tokens.some(t => t.type === 'bold' && t.content === 'CPA')).toBe(true);
    expect(tokens.some(t => t.type === 'link' && t.text === '詳細')).toBe(true);
  });

  it('マークダウンなしのテキストはそのまま返す', () => {
    const tokens = parseInlineMarkdown('普通のテキスト');
    expect(tokens).toEqual([{ type: 'text', content: '普通のテキスト' }]);
  });

  it('nullやundefinedを安全に処理する', () => {
    expect(parseInlineMarkdown(null)[0].content).toBe('');
    expect(parseInlineMarkdown(undefined)[0].content).toBe('');
  });
});
