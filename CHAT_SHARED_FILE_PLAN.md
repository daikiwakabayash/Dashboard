# CHAT_SHARED_FILE_PLAN — 共有ファイルの変更予定（②→①の事前申告）

チャット担当（②）が**将来触る予定の共有ファイル**と、その基準 commit を先に明示するための表。
①（共通基盤・本番反映）と同時編集しないための調整用。**本書に「申告済」と書いた変更も、①の合意まで着手しません。**

- 最終更新: 2026-09-18
- ②の作業ブランチ: `feature/chat-room-sync-dryrun`（PR #385）／ `feature/chat-ai-mention-logic`（本ブランチ）
- **②は同じブランチへ複数セッションから同時 push しません。**1ブランチ＝1作業として、着手前にここへ追記します。

---

## 1. 基準 commit

| ブランチ | 基準 commit | 共有ファイルの変更 |
|---|---|---|
| `feature/chat-room-sync-dryrun`（PR #385） | `main` = `581a660`（#379 マージ前） | **なし**（新規5ファイルのみ） |
| `feature/chat-ai-mention-logic`（本ブランチ） | `main` = `45ad3e3`（#379 Command Center Foundation マージ後） | **なし**（新規3ファイルのみ） |

②が push 済みのブランチに、共有ファイルの変更は1件もありません。
PR #385 は #379 より前の main から分岐していますが、共有ファイルに触れていないため競合しません。

### ①の Command Center Foundation（#379）との整合
`lib/authz.js` に `chat.send` / `chat.dm` / `chat.group_create` / `chat.member_add` / `chat.member_remove` /
`chat.broadcast` / `chat.broadcast_all` / `chat.schedule` / `chat.resend_unread` / `chat.room_archive` が
既に定義されていることを確認しました。**②はこれを再実装しません。**

- ②の PR #384（`lib/chat-policy.js` 等）は①の `lib/authz.js` と役割が重なるため、**統合は①の判断に従います**
  （②からは main へマージしません）。Room 単位の可視判定など①に無い部分だけを残す／捨てるの判断も①にお任せします。
- AI Agent の実行記録は `lib/agentlog.js`（`source:'chat'` が既に定義済み）へ、
  認可の拒否記録は `lib/audit.js` へ接続します。**②は別ログを作りません。**

---

## 2. 今後 ②が変更を希望する共有ファイル（未着手・要合意）

| # | ファイル | 変更したい箇所（範囲を限定） | 目的 | 前提 |
|---|---|---|---|---|
| S-1 | `index.html` | チャット入力欄まわりのみ（`chatSend` 近辺・コンポーザーの JSX 1ブロック） | AI Question Mode のトグル表示（通常送信と @AI 送信の取り違え防止） | ①の統合完了後。差分は 150 行以内に収める |
| S-2 | `index.html` | AI 回答メッセージの描画部分のみ（`ChatMessageList` の AI 分岐） | 出典・更新日時・確信度・「本部に確認する」の表示 | 同上 |
| S-3 | `index.html` | 本部向けタブに「同期差分プレビュー」を組み込む場合のみ | `chat-sync-preview.html` の取り込み（単体 HTML のままにするなら不要） | ①の判断待ち |
| S-4 | `api/plan-store.js` | `?type=aifeedback` の追加のみ（既存 type には触れない） | 👍👎 / 修正の保存。保存先キーは `naoru:chat:aifeedback:v1` | ①の認可（`ai.feedback` / `ai.feedback.fix`）に乗せる |
| S-5 | `scripts/precompile.mjs` | コピー対象に1行追加 | `chat-sync-preview.html` を Preview で開けるようにする（任意） | ①に依頼済み（PR #385） |

- `lib/authz.js` / `lib/actor.js` / `lib/chat-policy.js` … **②からは変更しません。** 必要な入出力は「引継ぎ事項」として文書で依頼します。
- `lib/chat.js`（既存の Room ロジック）も②からは変更しません。追加ロジックは新規ファイルに置きます。

### ②から①への依頼（コード変更ではなく仕様）
| # | 依頼 | 理由 |
|---|---|---|
| B-2（再掲・最重要） | Room レコードに任意フィールド `autoMembers: string[]` を許可 | 「手動で入れた人を自動で消さない」保証がこれ無しでは担保できない |
| B-6 | AI 回答メッセージに任意フィールド `ai: {...}`（出典・確信度・エスカレ）を許可 | 透明性表示。旧クライアントは無視できる追加のみ |
| B-7 | `ai.feedback` / `ai.feedback.fix` の capability 判定結果を、フロントから参照できる形で公開 | ②は権限判定を再実装せず、①の結果をそのまま使う |

---

## 3. 通知形式の拡張余地（実装はしません）

将来、外部の監視・アラート（例: Meta 関連のアラート）をチャットへ流す可能性があるため、
**通知ペイロードの形だけ**拡張できるようにしておきます。

```js
buildSystemNotice({ source, kind, title, body, link })
//  source: 'ai' | 'sync' | 'system'                … 現在使える発信元
//          'external'                              … 将来の外部連携用（既定では拒否）
```
- `source:'external'` は **`allowExternal: true` を明示しない限り必ず拒否**されます（既定 false）。
- ②は **外部連携の実装も、実アカウント情報の投稿も、自動通知の開始も行いません。**
  形（誰から / 種別 / 本文 / リンク）を決めておくだけで、実際の接続は③（API・データ取得）と①（権限・本番反映）の担当です。
- 送信そのものは行わず、`buildSystemNotice()` は**メッセージ用オブジェクトを返すだけ**の純粋関数です。

---

## 4. ②が触らないもの（担当外として明記）

- Meta Connector / Meta 画面 / Meta のデータ取得・運用エンジン（①・③の担当）
- 共通 Authorization（`lib/authz.js` / `lib/actor.js`）の再実装
- 承認センター / AI Agent Activity / 共通監査ログの再実装（①の実装を利用）
- 既存の Store Room / Event Room 自動生成の作り直し
- 既存の DM / Group / Message / Read の仕様変更
