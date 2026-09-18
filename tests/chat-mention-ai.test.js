// チャットのメンション候補に AI が出ること。
// ⚠️ 挿入される文字列は `@AI`。既存の起動条件 /[@＠]\s*ai\b/i と同じでなければ、
//    メンションしてもAIが反応しない。
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let html = '', cands = '', picker = '';
beforeAll(() => {
  html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  const c = html.indexOf('const chatMentionCandidates');
  cands = html.slice(c, c + 1800);
  const p = html.indexOf('メンションする相手');
  picker = html.slice(p - 500, p + 2500);
});

describe('チャットのメンション候補: AI', () => {
  it('🔴 候補に AI がいる', () => {
    expect(cands).toContain("id: '__ai__'");
  });
  it('🔴 挿入されるのは @AI（既存の起動条件と同じ）', () => {
    expect(cands).toContain("name: 'AI'");
    // 起動条件そのもの
    expect(html).toContain('/[@＠]\\s*ai\\b/i.test(t)');
  });
  it('候補の先頭に出す（全員より上）', () => {
    expect(cands.indexOf("id: '__ai__'")).toBeGreaterThan(cands.indexOf("id: '__all__'"));  // unshift順＝後のunshiftが先頭
  });
  it('人と見分けられる表示にする', () => {
    expect(cands).toContain('NAORUアシスタント');
    expect(picker).toContain("c.id === '__ai__'");
    expect(picker).toContain('{c.label || c.name}');
  });
  it('🔴 表示名でも絞り込める（「アシ」でも辿り着ける）', () => {
    const filter = html.slice(html.indexOf('const chatOnDraft'), html.indexOf('const chatPickMention'));
    expect(filter).toContain('c.label');
  });
  it('DMでも使える（AIに質問ボタンと同じ範囲）', () => {
    // 全員は dm で出さないが、AI はその条件の外側で unshift している
    const ai = cands.indexOf("id: '__ai__'");
    const dmGuard = cands.indexOf("room.kind !== 'dm'");
    expect(ai).toBeGreaterThan(dmGuard);
  });
});
