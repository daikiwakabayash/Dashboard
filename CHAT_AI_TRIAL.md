# CHAT_AI_TRIAL — @AI 試用版（合成データ・保護された Preview 用）

チャット担当（②）の @AI 試用版。**質問 → @AIモードで送信 → 同じルームにAI回答 → 出典確認 → 本部に確認 → 本部が訂正**までを画面で通しで試せます。

- 基準 commit: `main` = `45ad3e3`（#379 Command Center Foundation マージ後）
- **共有ファイルは無変更**（`index.html` / `api/plan-store.js` / `lib/authz.js` / `lib/actor.js` / `lib/chat.js` / `scripts/precompile.mjs`）
- 追加は新規ファイルのみ: `chat-ai-trial.html` / `lib/chat-ai-session.js` / `lib/chat-ai-adapter.js` / テスト2本 / 本書

## 1. 試し方

```bash
npx serve .     # もしくは python3 -m http.server 8931
# → http://localhost:8931/chat-ai-trial.html
```
Preview URL で開けるようにするには、`scripts/precompile.mjs` のコピー対象に1行追加が必要です（①へ依頼・§5）。

### 試せる操作
1. 通常メッセージを送る（貼り付け文に「@AI」が入っていても **AIは動きません**）
2. 「🤖 AIに質問」を押す → 入力欄の上に **AIに質問中** バーが出る（「通常に戻す」で解除）
3. 質問を送る → 同じルームに **AI回答カード** が出る
4. カードで **使用した出典（版・更新日）** を確認する
5. 「🙋 本部に確認」を押す（**連打しても依頼は増えません**。通知は「未接続」と表示）
6. 右上で **本部 太郎** に切り替え → 「✏️ 回答を訂正」（スタッフでは押せません）
7. 訂正が **元回答を残したまま** 追記され、ナレッジ反映は「承認候補」と表示される
8. 「来期の役員人事を教えて」のように資料が無い質問 → **根拠不足・本部確認が必要** と表示（作文しません）

## 2. mock と実AI接続の区別

| | mock（既定） | 実AI接続 |
|---|---|---|
| 表示 | 画面上部に「🧪 サンプル回答（mock）— 合成データによる動作確認用です。社内規程の正式な回答ではありません」／各回答カードに「サンプル回答（mock）」バッジ | 「実AI接続」 |
| 実装 | `createMockAdapter()` | `createApiAdapter()` → **既存の** `POST /api/chat { agent:'faq', question, history, dataContext }` → `{ message }` |
| 出典 | 合成 FAQ（版・更新日つき） | **渡した資料のみ**。モデルの自己申告では作りません |

- 試用版は **mock 固定**です（実接続に切り替えるのは①/③の配線が済んでから）。
- **新しい AI エンドポイントも、新しい全社 Knowledge 基盤も作っていません。** 既存の `/api/chat`（`agent:'faq'`）をそのまま使う Adapter だけを用意しています。

## 3. 守っている決まり

| 指示 | 実装 |
|---|---|
| 通常投稿でAIを自動起動しない | `decideIntent()` は **AIモード or @AIを明示選択** のときだけ true |
| 引用・貼り付けの「@AI」で起動しない | 本文の文字列判定では起動しない（`isAiTrigger` は表示用のみ） |
| AIは同じルームにしか返信しない | 回答は `roomId` を質問と同じ値で作り、宛先を選べない |
| AIがAIに反応し続けない | `applyAnswer` は AI 投稿を質問として受け付けない（`ai_message`） |
| 二重クリック・再試行・複数タブで重複しない | `clientId` の重複送信を弾き、1質問1回答（`already_answered`） |
| 失敗しても質問・下書きを消さない | `failAnswer` が下書きを戻し、「再試行 / 本部に確認」を出す |
| 本部確認は増殖しない | 1質問1件（`already_requested`）。**通知は「未接続」と表示し、通知済みとは書かない** |
| 訂正は上書きしない | 元回答は保持し、訂正者・日時・内容を追記（複数回の履歴も保持） |
| 👍や訂正でナレッジを自動更新しない | `knowledgeCandidates` に「承認候補」として積むだけ |
| AIの自己申告（正答率等）を出さない | 表示は「出典 N件に基づく回答」のみ。根拠が無ければ「根拠不足・本部確認が必要」 |
| 参照範囲（§6） | `buildContext()` が **今回の質問 / このルームの履歴 / このルームに共有された資料** だけを渡し、他店舗・他ルーム・人事情報・Private を理由つきで除外 |
| 音声入力 | 外部アプリの文字起こしを**貼り付けて使う**だけ（音声認識基盤は作っていません） |

⚠️ **フロントの絞り込みは UX であり、セキュリティ境界ではありません。** 参照権限・回答先 room_id・投稿権限の最終判定はサーバー側（①の authz）で行う前提です。

## 4. テスト

```
npx vitest run tests/chat-ai-session.test.js   → 20 passed
npx vitest run tests/chat-ai-adapter.test.js   → 11 passed
npx vitest run tests/chat-ai-ux.test.js        → 29 passed
npm test                                        → 全体グリーン
chat-ai-trial.html（headless Chromium で全手順を操作）→ PAGEERROR なし
```

## 5. ①へ渡す接続事項（②では実装しません）

| # | 依頼 | 内容 |
|---|---|---|
| C-1 | `chat.ai_reply` 相当のアクション | `lib/authz.js` の `ACTIONS` に AI 返信専用の権限を追加し、**AI に一般の `chat.send` を無制限に許可しない**。AI は「人が質問したルームへの返信」のみ |
| C-2 | 参照範囲のサーバー側検証 | `buildContext` と同じ判定をサーバーでも行う（回答先 room_id・資料の可視範囲・DM/Private の除外）。本部の個人権限と「ルームに公開してよい情報」を区別 |
| C-3 | AI 実行記録 | `lib/agentlog.js`（`source:'chat'`）へ接続。②は `buildAgentRunInput` / `buildAgentRunOutcome` を用意済み |
| C-4 | 本部確認の通知・監査 | 共通の通知/監査へ接続。未接続の間は画面に「未接続」と出す（現状の実装） |
| C-5 | 訂正 → ナレッジ | 訂正は `knowledgeCandidates` として出すので、①の承認センター（`lib/approvals.js`）の承認候補として受け取る |
| C-6 | Knowledge の取得 | 承認済み FAQ の限定取得のみ。③の Meta 作業の優先順位は変えない前提で、契約（`buildContext` に渡す `docs` の形）だけ用意 |
| C-7 | Preview 配信 | `scripts/precompile.mjs` のコピー対象に `chat-ai-trial.html` と `chat-sync-preview.html` を追加（各1行） |

### `docs` の契約（③/①が供給する側の形）
```jsonc
{ "id": "faq_family", "kind": "faq|knowledge", "title": "家族施術制度",
  "version": "1.2", "updatedAt": "2026-09-12T00:00:00Z",
  "visibility": "company|shop|room",     // これ以外は渡さない（unknown は除外）
  "shopId": "A", "roomId": "store_A",     // visibility に応じて必須
  "personnel": false, "private": false,   // true のものは渡さない
  "answer": "…", "body": "…", "keywords": ["家族施術"] }
```

## 6. 本番（本部/root 限定）までの残作業

1. C-1〜C-4 の接続（①）。とくに **`chat.ai_reply` 相当** と **参照範囲のサーバー検証**が入るまで本番接続はしません。
2. `index.html` への組み込みは①と担当箇所を合わせてから（`CHAT_SHARED_FILE_PLAN.md` の S-1 / S-2）。差分は入力欄まわりと AI 回答の描画に限定します。
3. 本番で試すときも **本部/root のみが参加する検証ルーム**に限定し、スタッフが入っている既存ルームへは投稿・通知しません。
4. owner / manager / staff への公開は行いません（`naoru:chat:rollout` / `cc_*` フラグは OFF のまま）。
