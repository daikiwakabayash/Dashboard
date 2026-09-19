// ── ニュースの下書き・年月・追加読込が index.html に**記述されている**ことの確認 ──
// ⚠️ これは記述の確認。実際に表示・操作できるかは scripts/news-draft-screen-check.mjs（実ブラウザ）で確かめる。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');

describe('下書き', () => {
  it('入力と下見を切り替えられる', () => {
    expect(html).toContain('data-news-composer-tab="edit"');
    expect(html).toContain('data-news-composer-tab="preview"');
    expect(html).toContain('data-news-preview');
  });
  it('下書きに保存するボタンと、投稿するボタンが別にある', () => {
    expect(html).toContain('data-news-save-draft');
    expect(html).toContain('data-news-publish');
  });
  it('出せない理由を画面に書く（押せないだけにしない）', () => {
    expect(html).toContain('data-news-publish-why');
    expect(html).toContain('公開対象で店舗を1つ以上えらんでください。');
  });
  it('下書きの帯と、書き直す・投稿する・消すの操作がある', () => {
    expect(html).toContain('data-news-drafts');
    expect(html).toContain('data-news-draft-edit');
    expect(html).toContain('data-news-draft-publish');
    expect(html).toContain('data-news-draft-delete');
  });
  it('下書きは本人と本部だけに見えると画面に書いてある', () => {
    expect(html).toContain('あなたと本部にだけ見えています');
  });
  it('下書きは未読にも更新履歴にもしない', () => {
    expect(html).toContain('const boardIsUnread = (p) => !newsIsDraft(p)');
    expect(html).toContain('// ⚠️ 下書きは更新履歴に出さない');
  });
});

describe('過去記事の年月と追加読込', () => {
  it('年月ごとの見出しを出す', () => {
    expect(html).toContain('data-news-month=');
    expect(html).toContain('nowl-month');
  });
  it('年月で絞れる', () => {
    expect(html).toContain('data-news-months');
    expect(html).toContain('data-news-month-btn');
    expect(html).toContain('すべての期間');
  });
  it('「もっと読む」で追加読込する', () => {
    expect(html).toContain('data-news-more');
    expect(html).toContain('もっと読む');
    expect(html).toContain('setBoardShown(page.next)');
  });
  it('絞り込みを変えたら出す件数を最初に戻す', () => {
    expect(html).toMatch(/setBoardShown\(NEWS_PAGE\);\s*\}, \[boardFilter, boardCatFilter, boardSearch, boardMonth, boardSort\]\)/);
  });
  it('年月は日本時間で決める（UTCで切らない）', () => {
    expect(html).toContain('const newsMonthKeyOf');
    expect(html).toContain('t + 9 * 3600 * 1000');
  });
});
