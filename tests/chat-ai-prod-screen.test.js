// ── 本番で使う画面（index.html「@AI 検証」）の確認 ────────────────────────
// ②は index.html を変更しません（①の共有ファイル）。ここで確認しているのは
// 「本番の画面から、合意した request_id の扱いと、名前での選択が呼ばれているか」です。
// 直っていない項目は it.fails で記録し、①が直すとテストが失敗して気づける形にしています。

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let html = '';
let trialScreen = '';
beforeAll(() => {
  html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  // 「@AI 検証」画面の描画部分だけを切り出す（他画面の文言に引っかからないように）
  const from = html.indexOf('@AI 検証');
  trialScreen = from >= 0 ? html.slice(Math.max(0, from - 2000), from + 12000) : '';
});

// index.html から関数の定義を1つ取り出して評価する（本番のコードそのものを動かす）
function extractFn(name) {
  const marker = `const ${name} = `;
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const end = html.indexOf('\n            };', start);
  if (end < 0) return null;
  const src = html.slice(start + marker.length, end + '\n            }'.length);
  // eslint-disable-next-line no-new-func
  return new Function(`return (${src.trim().replace(/;$/, '')})`)();
}

describe('本番画面: @AI 検証 の入口', () => {
  it('タブは root/本部のみ・cc_ai_trial フラグ付きで定義されている', () => {
    expect(html).toContain("id: 'aitrial'");
    const row = html.slice(html.indexOf("id: 'aitrial'"), html.indexOf("id: 'aitrial'") + 400);
    expect(row).toContain('rootOnly: true');
    expect(row).toContain("flag: 'cc_ai_trial'");
  });

  it('リクエストは body に type/action を載せて /api/plan-store へ送っている', () => {
    expect(html).toContain("type: 'chatai'");
    expect(html).toContain("action: 'ask'");
    expect(html).toContain("action: 'hq_review'");
    expect(html).toContain("action: 'correct'");
    expect(html).toContain("action: 'get'");
  });

  it('sample と実AI を画面で区別している', () => {
    expect(trialScreen).toContain('サンプル回答');
    expect(trialScreen).toContain('実AI');
  });

  it('本部の訂正は出典表示とは別の枠で、元回答を残して表示している', () => {
    expect(trialScreen).toContain('本部による訂正（元の回答は上に残しています）');
  });

  it('失敗しても質問の下書きを消さない', () => {
    expect(trialScreen).toContain('質問の下書きは消していません');
  });
});

describe('本番画面: request_id の扱い', () => {
  // ⚠️ 未修正（①へ報告）: index.html の aiMakeRequestId は
  //    `${room_id}|${質問本文}` のハッシュで固定IDを作っている。
  //    → 同じ人が同じ質問をもう一度送ると、必ず `replay` になり新しい回答が作れない。
  //    合意した仕様は「新しい送信には新しいID／同じ送信の再試行だけ同じID」。
  //    直し方の一例: lib/chat-ai-session.js の newRequestId() と同じく
  //    `req_<時刻36進>_<乱数>` を送信ごとに発行し、再試行時だけ保持した値を使う。
  it.fails('【未修正】新しい送信のたびに違う request_id になる', () => {
    const make = extractFn('aiMakeRequestId');
    expect(typeof make).toBe('function');
    expect(make('g_trial', '家族施術のルールは？')).not.toBe(make('g_trial', '家族施術のルールは？'));
  });

  it('【現状の記録】いまは質問本文とルームから固定IDを作っている', () => {
    const make = extractFn('aiMakeRequestId');
    expect(typeof make).toBe('function');
    expect(make('g_trial', 'A')).toBe(make('g_trial', 'A'));     // 同じ本文 → 同じID（＝新規送信ができない）
    expect(make('g_trial', 'A')).not.toBe(make('g_trial', 'B'));
  });
});

describe('本番画面: ルーム・資料の選び方', () => {
  // ⚠️ 未修正（①へ報告）: 検証ルームの <option> も許可FAQの表示も**内部IDそのもの**。
  //    設定欄でもIDを手入力する必要がある。
  //    合意した形は「名前で選び、送るのは①が許可したID」。
  //    ②の lib/chat-ai-adapter.js の buildTrialTargets / pickedTarget がそのまま使えます。
  it.fails('【未修正】検証ルームは名前で選べる（IDをそのまま出さない）', () => {
    expect(trialScreen).toMatch(/<option key=\{r\} value=\{r\}>\{\s*(?!r\s*\})/);
  });

  it.fails('【未修正】許可資料はタイトルで表示する（IDの羅列にしない）', () => {
    expect(trialScreen).not.toContain('docs.join');
  });

  it('【現状の記録】いまはルームIDと許可FAQのIDがそのまま表示されている', () => {
    expect(trialScreen).toContain('<option key={r} value={r}>{r}</option>');
    expect(trialScreen).toContain("docs.join(', ')");
  });
});
