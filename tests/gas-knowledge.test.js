import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// gas-knowledge.gs は Apps Script に貼り付けてもらうファイル。
// オーナーが画面で操作するので、「実行する関数」に出るかどうかが動作に直結する。
// ⚠️ Apps Script では **関数名の末尾が _ だと実行メニューに出ない**。
const gs = readFileSync(resolve(process.cwd(), 'gas-knowledge.gs'), 'utf-8');
const fns = [...gs.matchAll(/^function ([A-Za-z0-9_]+)/gm)].map(m => m[1]);

describe('Apps Script に貼るファイル', () => {
  it('構文として読める', () => {
    expect(() => new Function(`${gs}\nreturn true;`)).not.toThrow();
  });

  it('オーナーが実行する3つが「実行する関数」に出る（末尾 _ にしない）', () => {
    for (const n of ['setupKnowledgeSecret', 'resetKnowledgeSecret', 'testReadKnowledgeDoc']) {
      expect(fns).toContain(n);
      expect(n.endsWith('_')).toBe(false);
    }
  });

  it('内部用は実行メニューに出さない（誤操作を防ぐ）', () => {
    for (const n of ['readKnowledgeDoc_', 'readSpreadsheet_', 'readPresentation_', 'readDocument_', 'makeKnowledgeSecret_']) {
      expect(fns).toContain(n);
    }
  });

  it('合言葉は32文字以上を作る（Dashboard 側の下限に合わせる）', () => {
    const make = new Function(`${gs.match(/function makeKnowledgeSecret_\(\)[\s\S]*?\n}/)[0]}\nreturn makeKnowledgeSecret_;`)();
    const v = make();
    expect(v.length).toBeGreaterThanOrEqual(32);
    expect(v).toMatch(/^[A-Za-z0-9]+$/);
    expect(make()).not.toBe(v);                 // 毎回ちがう値
  });

  it('合言葉をコードに書き込んでいない', () => {
    expect(gs).not.toMatch(/KNOWLEDGE_GAS_SECRET\s*=\s*['"][A-Za-z0-9]{16,}/);
  });

  it('合言葉が合わなければ、ファイルを開く前に断る（fail closed）', () => {
    const body = gs.slice(gs.indexOf('function readKnowledgeDoc_'));
    const unauthorizedAt = body.indexOf("error: 'unauthorized'");
    const openAt = body.search(/openById/);
    expect(unauthorizedAt).toBeGreaterThan(-1);
    expect(openAt === -1 || unauthorizedAt < openAt).toBe(true);
  });

  it('未設定・短すぎる合言葉では通さない', () => {
    expect(gs).toMatch(/expected\.length < 32/);
  });

  it('エラー本文にファイル名や内部パスを載せない', () => {
    expect(gs).toContain('読み取りに失敗しました');
    expect(gs).not.toMatch(/return \{ ok: false, error: String\(e/);
  });
});
