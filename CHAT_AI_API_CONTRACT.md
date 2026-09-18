# CHAT_AI_API_CONTRACT — @AI 実接続の入出力（②→①の合意案）

チャット担当（②）から共通基盤担当（①）への **API 契約の提案**。
②はこの形に合わせて **クライアント側だけ**実装済み（`lib/chat-ai-adapter.js`）。
サーバー実装・認可・保存・本番反映は①の担当です。

- **基準 commit: `main` = `1e51b66`**（#392「@AI 実接続（本部/root限定・検証用Roomのみ・フラグ既定OFF）」まで反映）
  ②のブランチはこの commit へ rebase 済みです。
- **①が本契約を実装済み**（`lib/chatai.js` / `?type=chatai`）。以下は①の実装に合わせて更新しています。
- 以下は**①の実装済みの仕様に合わせて更新**しました（`lib/actor.js` / `api/plan-store.js` の実コードを確認）。

---

## 0. 大原則

1. **role / tenant / 所属店舗 / 資料の可視範囲は、すべてサーバーが確定する。**
   クライアントが送るのは「質問」「room_id」「冪等キー」「（任意の）参考候補ヒント」だけ。
2. **クライアントが作った `dataContext` を、権限チェック済みの資料として扱わない。**
   送っても構わないが、サーバーは*ヒント*としてのみ扱い、実際に渡す資料はサーバーが選び直す。
3. **「AIへ渡した参考資料」と「回答の根拠として検証された出典」は別物**として返す（§3）。
4. 冪等キー（`request_id`）が同じリクエストは、**同じ回答を返す**（新しい回答を作らない）。
5. AI の回答は **質問と同じ room_id にだけ**作られる。別ルームの指定はサーバーが拒否する。

---

## 1. リクエスト

```
POST <①が決めるエンドポイント>          例) /api/plan-store （body.type='chatai', body.action='ask'）
Authorization: Bearer <SalonOne SSO>    // SSO
X-CC-Owner: <encodeURIComponent(アカウント名)>   // ①の lib/actor.js が読むヘッダ
X-CC-Token: <settlement-auth のトークン>
```
> **実仕様に合わせた点（②の修正済み）**
> - 認証ヘッダは **`X-CC-Owner` / `X-CC-Token`**（旧案の `X-Chat-*` は誤りでした）。日本語アカウント名は
>   ヘッダに直接載せられないため **percent-encode** します（サーバーは `decodeURIComponent` 済み）。
> - `POST` は **`body.type` / `body.action`** で振り分けられるため、body にも `type` / `action` を載せます。
> - クライアントは **role / tenant をヘッダにも body にも入れません**（申告は認可の材料にしない）。

```jsonc
{
  "type": "chatai", "action": "ask",       // ①の振り分け規約に合わせる
  "question": "家族施術のルールは？",       // 必須
  "room_id": "store_A",                    // 必須。回答が投稿されるルーム
  "request_id": "req_l3f9_ab12",           // 必須。冪等キー（再試行・複数タブで同値）
  "client_id": "tab_9f2",                  // 任意。どのタブから来たかの診断用
  "question_message_id": "m_l3f9_77",      // 任意。質問を先に投稿済みならその ID
  "context_hint": {                        // 任意。**権限チェック済みではない“候補”**
    "doc_ids": ["faq_family"],
    "history_message_ids": ["m_1", "m_2"]
  }
}
```

- `context_hint` は**送らなくても動く**こと。サーバーは無視してよい。
- ②のクライアントは `context_hint` に**本文を載せません**（ID のみ）。本文を持ち回らないことで、
  「クライアントが持っている資料＝渡してよい資料」という誤解を避けます。

## 2. 成功レスポンス

```jsonc
{
  "ok": true,
  "question_message_id": "m_l3f9_77",   // サーバーが確定した質問の ID
  "answer_message_id": "a_l3f9_88",     // 同じ request_id なら常に同じ値
  "room_id": "store_A",                 // 回答が入ったルーム（質問と必ず同じ）
  "body": "家族施術制度は…",
  "mode": "live",                        // "live" | "sample"（sample はモック/検証用）
  "sources": {
    "verification": "server_verified",   // "server_verified" | "unverified" | "none"
    "verified": [                        // ← サーバーが資料ID・版・該当箇所まで確認したもの
      { "doc_id": "faq_family", "title": "家族施術制度", "version": "1.2",
        "updated_at": "2026-09-12T00:00:00Z", "locator": "§3", "confidence": "exact|partial" }
    ],
    "candidates": [                      // ← モデルへ渡した参考資料（未検証）
      { "doc_id": "faq_shift", "title": "シフト提出ルール", "reason": "passed_to_model" }
    ]
  },
  "hq_review": { "status": "none",       // "none" | "pending" | "resolved"
                 "request_id": null, "notified": false, "channel": "not_connected" },
  "usage": { "model": "…", "tokens_in": 0, "tokens_out": 0 }   // 任意
}
```

### 表示のしかた（②の実装）

> **「確認済み」の意味**: 出典の **実在・版・参照箇所** をサーバーが確かめた、という意味です。
> **回答内容の正解保証・正式承認ではありません。** 画面にもその注記を出します。
> 本部による確認・訂正の状態は、この出典確認とは**別の表示**にしています。

| `verification` | 画面表示 |
|---|---|
| `server_verified` かつ `verified[]` あり | **「出典を確認済み（実在・版・参照箇所）」**（資料名・版・更新日・該当箇所）＋「回答内容の正しさを保証するものではありません」 |
| `unverified`（候補のみ） | **「参照候補として渡した資料（未検証）」** ＋「正式な社内規程としての回答ではありません」 |
| `none` | **「根拠不足・本部確認が必要」**（回答を正式規程として断定しない） |

- **資料の件数で回答の正しさを保証しません。**「出典N件に基づく」といった表示はしません。
- `verification` が省略された場合、②は **`unverified` として扱います**（安全側）。

## 3. エラーレスポンス

①の既存形式（`?type=chat` が実際に返している形）と、契約形式のどちらでも②は解釈できます。

```jsonc
// ①の既存形式（実サーバーで確認済み）
{ "ok": false, "error": "forbidden", "code": "chat_admin_only", "message": "チャットは本部・管理者のみ…" }
// 契約形式（retryable を明示できる）
{ "ok": false, "error": { "code": "forbidden_room", "message": "…", "retryable": false } }
```
②の `normalizeError()` が両方を `{ code, message, retryable }` に正規化します。
`retryable` が無い場合は **コード表と HTTP ステータスから安全側に判定**します（403/401/400 → 再試行しない）。

| code | 意味 | retryable | ②の画面 |
|---|---|---|---|
| `chat_admin_only` | チャットが本部・管理者限定（①の現行仕様） | false | 「チャットは本部・管理者のみ利用できます（再ログインが必要な場合があります）」 |
| `invalid_request` | 必須項目不足 | false | 「送信内容を確認してください」 |
| `rollout_disabled` | そのロールにはチャット/AI が未公開 | false | 機能を出さない（タブ自体を隠す） |
| `forbidden_room` | 非参加ルーム / 別ルーム宛 | false | 「このルームでは利用できません」 |
| `tenant_mismatch` | 別テナント | false | 同上（詳細は出さない） |
| `not_member` | ルームのメンバーでない | false | 同上 |
| `ai_message_source` | AI の投稿を質問として起動しようとした | false | 何もしない（無限返信の防止） |
| `rate_limited` | レート制限 | true | 「混み合っています。少し待って再試行」 |
| `upstream_failed` | モデル/上流の失敗 | true | 「再試行」ボタンを出す |
| `internal` | その他 | true | 同上 |

- `retryable:false` のときは②は**自動再試行しません**（人が「本部に確認」を選べる状態にします）。
- どの場合でも、質問と入力中の下書きは消しません。

## 4. 冪等性・重複防止（責任分界）

| 誰が | 何を |
|---|---|
| ②（クライアント） | **同じ送信の再試行では同じ `request_id` を維持する**／**新しい送信には新しい `request_id` を採る**／**回答カードの重複表示を防ぐ**（同じ `answer_message_id` は1枚しか描かない） |
| ①（サーバー） | **同じ `request_id` の重複実行を防ぐ**（`replay` / `pending` / `conflict` の判定と、回答の単一生成） |

- 「同じ本文を人が意図的に2回送る」のは**正常な操作**です。送信IDが別なので、2件になるのが正しい挙動です。
- ①の実装（`lib/chatai.js`）: 冪等キー = `tenant | actor | request_id`。
  `classifyRequest()` が `new` / `pending` / `replay` / `conflict` を返し、
  `conflict`（同じIDで本文やRoomが違う）は `request_conflict`（`retryable:false`）で拒否されます。
- ⚠️ **未解決**: 同じ `request_id` を**同時に**送ると、pending の記録が read-modify-write のため
  取り合いになり、回答が複数作られます（②のローカル結合テストで再現・`it.fails` で記録）。
  KV の CAS／SETNX 等で「pending を先に立てた1つだけが生成する」形にすれば解決します。
  逐次の再送（`replay`）は正しく1件に収束することを確認済みです。

## 5. 本部確認（HQ review）

- 「🙋 本部に確認」は別アクション（例 `action=hq_review`）で、**同じ質問につき1件**。
  サーバーは既に `pending` があれば `created:false` と既存の request を返す。
- 通知・監査は①の共通機能へ接続。**未接続の間は `notified:false` / `channel:"not_connected"`** を返し、
  ②は「通知済み」とは表示しません（現在は「通知: 未接続」と明示）。

## 6. 訂正（本部）

- 訂正は**追記**（`corrections[]`）。元回答は保持し、訂正者・日時・本文を残す。
- 訂正・👍で **Knowledge を自動更新しない**。①の承認センター（`lib/approvals.js`）の**承認候補**として渡す。

## 7. 不足 ID・スコープの扱い（重要）

`room_id` / `shop_id` / `tenant_id` が欠けたときに、**制約が消えて他店舗の資料が通ることがあってはいけません。**

| 状況 | サーバー | ②のクライアント |
|---|---|---|
| `room_id` 無し | `invalid_request` で拒否 | 送信しない（AI を起動しない） |
| 資料の `visibility` 不明 | 渡さない | 候補から除外し「要確認」に出す |
| `visibility:'shop'` なのに `shop_id` 不明 | 渡さない | 同上（**全店扱いにしない**） |
| `visibility:'room'` なのに `room_id` 不明 | 渡さない | 同上 |
| `tenant_id` 不一致・不明 | 拒否 | 候補から除外 |

②の `buildContext()` は上記のとおり実装済み（`tests/chat-ai-adapter.test.js` で固定）。
**ただしこれは UX 上の絞り込みであり、最終判定はサーバーです。**

## 8. ②が使う既存処理（新規作成しないもの）

- 回答生成そのものは既存の `POST /api/chat { agent:'faq', question, history, dataContext } → { message }` を利用可能。
  ①が上記の契約でラップしてくだされば、②は**エンドポイントを1つ差し替えるだけ**で実接続に移れます。
- 認可は `lib/authz.js`、AI 実行履歴は `lib/agentlog.js`（`source:'chat'`）、
  承認は `lib/approvals.js`、監査は `lib/audit.js` に接続してください（②では作りません）。
- **`chat.ai_reply` 相当のアクション**を `ACTIONS` に追加し、AI に一般の `chat.send` を無制限に与えないでください。
