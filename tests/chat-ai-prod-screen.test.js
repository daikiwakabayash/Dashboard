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
  trialScreen = from >= 0 ? html.slice(Math.max(0, from - 2000), from + 20000) : '';
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
  // ①が修正済み。固定ハッシュをやめ、送信ごとに新しいIDを発行する。
  it('🔴 新しい送信のたびに違う request_id になる', () => {
    const make = extractFn('aiMakeRequestId');
    expect(typeof make).toBe('function');
    const a = make(); const b = make();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^req_[0-9a-z]+_[0-9a-z]+$/);
  });

  it('🔴 質問本文やルームからIDを作らない（同じ本文でも新規送信できる）', () => {
    const src = html.slice(html.indexOf('const aiMakeRequestId'), html.indexOf('const aiMakeRequestId') + 300);
    expect(src).not.toContain('0x811c9dc5');      // 旧: 本文のハッシュ
    expect(src).not.toContain('${rid}|');
  });

  it('🔴 再試行のときだけ、発行済みのIDを使い回す', () => {
    const ask = html.slice(html.indexOf('const aiTrialAsk'), html.indexOf('const aiTrialRetry'));
    expect(ask).toContain('retry && aiTrial.lastRequestId ? aiTrial.lastRequestId : aiMakeRequestId()');
    expect(html).toContain('const aiTrialRetry = () => aiTrialAsk({ retry: true });');
  });
});

describe('本番画面: ルーム・資料の選び方', () => {
  // ①が修正済み。判定はサーバー（②の buildTrialTargets）が行い、画面は名前を出すだけ。
  it('🔴 検証ルームは名前で選ぶ（IDをそのまま出さない）', () => {
    expect(trialScreen).not.toContain('<option key={r} value={r}>{r}</option>');
    expect(trialScreen).toContain('<option key={r.id} value={r.id}>');
    expect(trialScreen).toContain('{r.name}');
  });

  it('🔴 許可資料はタイトルで表示する（IDの羅列にしない）', () => {
    expect(trialScreen).not.toContain("docs.join(', ')");
    expect(trialScreen).toContain('docs.map(d => d.title)');
  });

  it('🔴 設定欄でも内部IDを手入力させない（名前で選ぶ）', () => {
    // 設定欄は切り出し窓の外にあるので html 全体で確認する
    expect(html).not.toContain('検証用ルームID（カンマ区切り）');
    expect(html).not.toContain('許可するFAQのID（カンマ区切り・少数のみ）');
    expect(html).toContain('検証に使うルーム（名前で選びます）');
    expect(html).toContain('AIに渡すFAQ（タイトルで選びます');
  });

  it('参加者名も選択肢に出す（誰が入っているルームか分かる）', () => {
    expect(trialScreen).toContain('memberNames(r)');
  });

  it('対象の判定はサーバーが返す（画面でIDを突き合わせない）', () => {
    expect(html).toContain('j.targets');
    expect(html).not.toContain('buildTrialTargets');   // 同じ判定を画面側で書き直さない
  });
});

describe('本番画面: 再試行ボタン', () => {
  const askSrc = () => html.slice(html.indexOf('const aiTrialAsk'), html.indexOf('const aiTrialReview'));
  const screen = () => {
    const i = html.indexOf('AIに質問する');
    return html.slice(Math.max(0, i - 3000), i + 3000);
  };

  it('🔴 ボタンが画面に接続されている（定義だけで終わっていない）', () => {
    expect(html).toContain('const aiTrialRetry = () => aiTrialAsk({ retry: true });');
    expect(screen()).toContain('onClick={aiTrialRetry}');
    expect(screen()).toContain('同じ送信を再試行');
  });

  it('🔴 再試行できる失敗のときだけ表示する（サーバーの retryable に従う）', () => {
    expect(screen()).toContain('{t.canRetry && (');
    expect(askSrc()).toContain('canRetry: j.error.retryable === true');
  });

  it('🔴 再試行では新しい request_id を発行しない', () => {
    expect(askSrc()).toContain('retry && aiTrial.lastRequestId ? aiTrial.lastRequestId : aiMakeRequestId()');
  });

  it('🔴 再試行は元の質問本文・room_id を維持する（入力欄の編集に引きずられない）', () => {
    expect(askSrc()).toContain("const q = retry ? String(aiTrial.lastQuestion || '') : aiTrial.q.trim();");
    expect(askSrc()).toContain("const rid = retry ? String(aiTrial.lastRoomId || '') : aiTrial.roomId;");
    expect(askSrc()).toContain('lastHintDocIds');       // 渡した資料も送信時のまま
  });

  it('🔴 実行中は二重クリックできない', () => {
    expect(askSrc()).toContain('if (aiTrial.busy) return;');
    expect(screen()).toContain('onClick={aiTrialRetry} disabled={t.busy}');
  });

  it('🔴 自動再試行はしない（押すのは人）', () => {
    expect(askSrc()).not.toMatch(/setTimeout\s*\([^)]*aiTrialAsk/);
    expect(askSrc()).toContain('if (retry && !aiTrial.canRetry) return;');
  });

  it('🔴 新規質問と再試行を別のボタンにしている', () => {
    expect(screen()).toContain('onClick={() => aiTrialAsk()}');   // 新規: 引数なし = 新しいID
    expect(screen()).toContain('onClick={aiTrialRetry}');         // 再試行: 同じID
  });

  it('再試行できない失敗では、やり直しではなく入力し直しを促す', () => {
    expect(screen()).toContain('この失敗は同じ送信のやり直しでは解消しません');
  });
});

// ── 通常チャット入力欄からの @AI（本部/root・フラグON・検証Roomのみ）──────
// ②が index.html に足した接続。ライブラリだけでなく**画面から呼ばれているか**を固定する。
describe('本番画面: 通常チャット入力欄からの @AI', () => {
  const chatSrc = () => html.slice(html.indexOf('const chatSend = async'), html.indexOf('const chatSend = async') + 4000);
  const askSrc = () => html.slice(html.indexOf('const chatAiAskVerified'), html.indexOf('const chatSend = async'));

  it('検証Roomの一覧はサーバーの targets を使う（画面で判定を書き直さない）', () => {
    expect(html).toContain("fetch('/api/plan-store?type=chatai&action=config'");
    expect(html).toContain('(j.targets && j.targets.rooms)');
    expect(html).toContain('const chatAiRoomOk = (roomId) =>');
  });

  it('root かつ cc_ai_trial ON のときだけ検証Roomを読む', () => {
    const eff = html.slice(html.indexOf('const chatAiRoomOk') - 1200, html.indexOf('const chatAiRoomOk'));
    expect(eff).toContain('chatIsRoot');
    expect(eff).toContain("ccOn('cc_ai_trial')");
  });

  it('入力欄の @AI は、検証Roomでは出典つきの新しい経路を使う', () => {
    expect(chatSrc()).toContain('chatAiRoomOk(roomId)');
    expect(chatSrc()).toContain('chatAiAskVerified(roomId, t)');
  });

  it('検証Room以外は従来の動きを変えない', () => {
    expect(chatSrc()).toContain('chatAiReply(roomId, t)');
  });

  it('新しい送信には新しい依頼ID、再試行だけ同じIDを使う', () => {
    expect(askSrc()).toContain('retry && chatAiVerified.lastRequestId ? chatAiVerified.lastRequestId : chatAiNewRequestId()');
    expect(askSrc()).not.toContain('question}|');        // 本文からIDを作らない
  });

  it('再試行は元の質問と Room を使う（入力欄の編集に引きずられない）', () => {
    expect(askSrc()).toContain("const q = retry ? String(chatAiVerified.lastQuestion || '')");
    expect(askSrc()).toContain("const rid = retry ? String(chatAiVerified.lastRoomId || '')");
  });

  it('再試行できない失敗は繰り返さない・自動再試行もしない', () => {
    expect(askSrc()).toContain('if (retry && !chatAiVerified.canRetry) return;');
    expect(askSrc()).toContain('canRetry: e.retryable === true');
    expect(askSrc()).not.toMatch(/setTimeout\s*\([^)]*chatAiAskVerified/);
  });

  it('実行中は二重に走らない', () => {
    expect(askSrc()).toContain('if (chatAiVerified.busy) return;');
  });

  it('「同じ送信を再試行」ボタンが入力欄に出る（定義だけで終わっていない）', () => {
    expect(html).toContain('同じ送信を再試行');
    expect(html).toContain("chatAiAskVerified(chatRoomId, '', { retry: true })");
  });
});
