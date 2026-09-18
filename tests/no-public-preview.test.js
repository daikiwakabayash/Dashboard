import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 実データを貼り付けられる静的ページを、ログイン保護のないURLへ出さない。
describe('認証の無い静的ページを配信しない', () => {
  const precompile = readFileSync(resolve(ROOT, 'scripts/precompile.mjs'), 'utf8');

  it('🔴 chat-sync-preview.html を public/ へコピーしない', () => {
    expect(precompile).not.toContain('chat-sync-preview.html');
  });

  it('🔴 配信対象に入れてよいのは、認証を通る画面と静的アセットだけ', () => {
    // コピー対象の一覧を取り出し、想定外の .html が混ざっていないか見る
    const copied = [...precompile.matchAll(/'([^']+\.html)'/g)].map(m => m[1]);
    const allowed = new Set(['index.html', 'owner.html']);
    for (const f of copied) expect(allowed.has(f), `${f} が配信対象に入っています`).toBe(true);
  });

  it('開発用ツールには公開禁止の注意書きがある', () => {
    const html = readFileSync(resolve(ROOT, 'chat-sync-preview.html'), 'utf8');
    expect(html).toMatch(/public\/ へコピーしないでください|配信しないでください/);
  });
});
