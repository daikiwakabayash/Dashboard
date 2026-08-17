import { describe, it, expect } from 'vitest';
import { validateRequest, buildMessages, normalizeImages, SYSTEM_PROMPT } from '../api/chat.js';

// ── validateRequest ──────────────────────────────────────────────

describe('validateRequest', () => {
  it('有効なリクエストを受け付ける', () => {
    const result = validateRequest({ question: 'テスト質問' });
    expect(result).toEqual({ valid: true });
  });

  it('questionが空文字ならエラー', () => {
    const result = validateRequest({ question: '' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('question');
  });

  it('questionがない場合はエラー', () => {
    expect(validateRequest({}).valid).toBe(false);
    expect(validateRequest(null).valid).toBe(false);
    expect(validateRequest(undefined).valid).toBe(false);
  });

  it('questionがスペースのみの場合はエラー', () => {
    expect(validateRequest({ question: '   ' }).valid).toBe(false);
  });

  it('historyが配列でなければエラー', () => {
    const result = validateRequest({ question: 'test', history: 'not-array' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('history');
  });

  it('historyが配列なら有効', () => {
    const result = validateRequest({
      question: 'test',
      history: [{ role: 'user', content: 'hello' }]
    });
    expect(result.valid).toBe(true);
  });

  it('historyがundefinedでも有効（オプショナル）', () => {
    expect(validateRequest({ question: 'test' }).valid).toBe(true);
  });
});

// ── buildMessages ────────────────────────────────────────────────

describe('buildMessages', () => {
  it('質問のみでメッセージを構築する', () => {
    const msgs = buildMessages('売上を分析して');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('売上を分析して');
  });

  it('dataContextを付与する', () => {
    const msgs = buildMessages('分析して', [], '売上: ¥100,000');
    expect(msgs[0].content).toContain('分析して');
    expect(msgs[0].content).toContain('データコンテキスト');
    expect(msgs[0].content).toContain('売上: ¥100,000');
  });

  it('空のdataContextは無視する', () => {
    const msgs = buildMessages('test', [], '');
    expect(msgs[0].content).toBe('test');
  });

  it('スペースのみのdataContextは無視する', () => {
    const msgs = buildMessages('test', [], '   ');
    expect(msgs[0].content).toBe('test');
  });

  it('会話履歴を含める', () => {
    const history = [
      { role: 'user', content: '最初の質問' },
      { role: 'assistant', content: '回答です' },
    ];
    const msgs = buildMessages('次の質問', history);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toEqual({ role: 'user', content: '最初の質問' });
    expect(msgs[1]).toEqual({ role: 'assistant', content: '回答です' });
    expect(msgs[2].content).toBe('次の質問');
  });

  it('履歴を20件に制限する', () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg-${i}`
    }));
    const msgs = buildMessages('latest', history);
    // 20件の履歴 + 1件の最新質問 = 21
    expect(msgs).toHaveLength(21);
    // 最初の10件（index 0-9）はスキップされる
    expect(msgs[0].content).toBe('msg-10');
  });

  it('不正なroleをassistantに変換する', () => {
    const history = [{ role: 'system', content: 'test' }];
    const msgs = buildMessages('q', history);
    expect(msgs[0].role).toBe('assistant');
  });

  it('画像なしのときcontentは文字列のまま', () => {
    const msgs = buildMessages('質問', [], '', []);
    expect(typeof msgs[msgs.length - 1].content).toBe('string');
  });

  it('画像ありのとき最新ターンをimage+textブロック配列にする', () => {
    const images = [{ mediaType: 'image/png', data: 'AAAA' }];
    const msgs = buildMessages('この画像は？', [], 'ctx', images);
    const last = msgs[msgs.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    expect(last.content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
    const textBlock = last.content[last.content.length - 1];
    expect(textBlock.type).toBe('text');
    expect(textBlock.text).toContain('この画像は？');
    expect(textBlock.text).toContain('ctx');
  });
});

// ── normalizeImages ──────────────────────────────────────────────

describe('normalizeImages', () => {
  it('配列でなければ空配列', () => {
    expect(normalizeImages(undefined)).toEqual([]);
    expect(normalizeImages(null)).toEqual([]);
    expect(normalizeImages('x')).toEqual([]);
  });

  it('許可された画像タイプのみ image ブロックに変換する', () => {
    const out = normalizeImages([
      { mediaType: 'image/jpeg', data: 'abc' },
      { mediaType: 'image/svg+xml', data: 'bad' },   // 非許可
      { mediaType: 'image/webp', data: '' },          // dataなし
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'abc' } });
  });

  it('最大4枚に制限する', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ mediaType: 'image/png', data: 'd' + i }));
    expect(normalizeImages(many)).toHaveLength(4);
  });
});

// ── SYSTEM_PROMPT ────────────────────────────────────────────────

describe('SYSTEM_PROMPT', () => {
  it('NAORUアドバイザーとして定義されている', () => {
    expect(SYSTEM_PROMPT).toContain('NAORUアドバイザー');
  });

  it('業界ベンチマークを含む', () => {
    expect(SYSTEM_PROMPT).toContain('CPA');
    expect(SYSTEM_PROMPT).toContain('入会率');
    expect(SYSTEM_PROMPT).toContain('退会率');
  });

  it('Markdownフォーマット指示を含む', () => {
    expect(SYSTEM_PROMPT).toContain('Markdown');
    expect(SYSTEM_PROMPT).toContain('表形式');
  });

  it('参考リンク指示を含む', () => {
    expect(SYSTEM_PROMPT).toContain('[タイトル](URL)');
  });
});
