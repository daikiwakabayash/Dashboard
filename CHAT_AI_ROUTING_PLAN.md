# CHAT_AI_ROUTING_PLAN

NAORU Dashboard の社内チャットを「AI対応・自然言語宛先指定・自動グループ生成」へ拡張する全体計画。
**このブランチ（`feature/chat-ai-routing`）は main / Production に自動マージしない。**

---

## 0. 目的（最終ゴール）

100〜200店舗規模になっても、本部 / オーナー / 院長（マネージャー）/ スタッフが LINE 等の外部ツールを使わず、
Dashboard 内の Chat を社内コミュニケーションの中心として使える状態にする。

さらに **SalonOne（店舗 / スタッフ / イベント情報）→ Chat** を自動連携し、
店舗やイベントの発生に応じて必要な Chat Room を自動生成・更新する。

将来的に SalonOne AI として他社提供（White Label）できるよう、**すべて `tenant_id` 前提**で設計する。

---

## 1. 現状（Before）

| 項目 | 現状 |
|------|------|
| 利用可能ロール | `chat` タブは `rootOnly: true`（root / hq のみ） |
| Room 種別 | `announce` / `store` / `group` / `dm` |
| store room の ID | `store_<店舗名>`（**店舗名が主キー**＝改名でルームが分裂する） |
| メンバー | `store` は members 空のまま「店舗名の部分一致」で可視判定 |
| 認可 | **UI レベルのみ**。`/api/plan-store?type=chat` はサーバー認証なし（`root:true` はクライアント申告） |
| AI | `@AI` or 「AIに質問」ボタン →`chatAiReply`。出典表示・Feedback なし |
| 宛先 | 手動でルーム選択のみ。複数宛先・自然言語指定なし |
| 監査 | なし |
| テナント | 単一（キーは `naoru:` 固定プレフィクス） |

## 2. 目標（After）

| 項目 | 目標 |
|------|------|
| 利用可能ロール | root / hq / owner / manager / staff |
| Room の主キー | `store_id` / `event_id`（**名称変更でルームを維持**） |
| メンバー | SalonOne 由来の `staff_id` を実体として同期（異動・退職・配属変更に追従） |
| 認可 | `lib/authz.js`・`lib/actor.js` を Dashboard 共通の正本とし、Chat 固有は `lib/chat-policy.js`。フロントとサーバーが同じ関数を通す |
| AI | `@AI` メンション・AI Question Mode・出典 / 更新日時 / Confidence・本部エスカレ・👍👎修正 Feedback |
| 宛先 | 自然言語 → Intent Parse → Resolve → **Preview → 人間承認 → 送信** |
| 監査 | 全送信に `CHAT_AUDIT_MODEL.md` の 20 フィールドを記録 |
| テナント | 全キー・全レコードに `tenant_id`。クロステナント参照は構造的に不可能 |

---

## 3. 設計原則（Non-negotiable）

1. **AI は直接送信しない。** Resolver の出力は必ず Preview を経由し、人間が `[送信]` を押して初めて送信される。
2. **AI Agent は人間の権限を超える Recipient を作れない。** Resolver は actor の authz スコープで必ず後段フィルタされる。
3. **AI Agent 自身は承認者になれない。** `approved_by` に AI の actor_id は入らない。
4. **staff_id / store_id が正。** 表示名（氏名・店舗名）は解決の入力にしか使わない。同姓同名は必ず人間に確認する。
5. **サーバー側が最終防衛線。** フロントのフィルタは UX であり、セキュリティ境界ではない。
6. **既存データを壊さない。** 既存の `naoru:chat:*` blob をそのまま読め、旧クライアントも動く（後方互換）。
7. **NAORU 固有名を core logic にハードコードしない。** 店舗名・法人名・ロール名の日本語ラベルは表示層 or 設定に置く。
8. **index.html の編集は最小限。** ロジックは `lib/*.js` に出し、`index.html` は薄い呼び出しに留める（Meta 開発とのコンフリクト最小化）。

---

## 4. モジュール構成（新規追加）

```
lib/
  actor.js             # 共通 actor（SalonOne認証結果が正）                  … Phase 1
  authz.js             # Dashboard 共通認可＋Chat Rollout（Feature Flag）    … Phase 1
  chat-policy.js       # Chat 固有ポリシー（canViewRoom 等）                 … Phase 1
  chat-rooms.js        # 既存 ensureRooms / evSaveChat の延長・membership 同期 … Phase 2
  chat-recipients.js   # Recipient 集合の解決・展開・重複排除・除外          … Phase 3
  chat-resolver.js     # 自然言語 → Intent → Recipient（決定的部分）         … Phase 5
  chat-audit.js        # 監査レコードの生成・検証                            … Phase 3
  chat-schedule.js     # 予約 / 定期送信                                     … Phase 6
  chat-smartgroup.js   # 条件グループ（Dynamic Group）の評価                 … Phase 6
```

いずれも **純粋関数＋テスト必須**（`tests/*.test.js`）。I/O（KV 読み書き・fetch）は `api/plan-store.js` 側に残す。

---

## 5. データモデル方針

### 5.1 テナント
- `tenant_id` は `resolveTenantId(req)` で決定（既定 `process.env.TENANT_ID || 'default'`）。
- ストレージキー: 既存 `naoru:chat:v1` は `default` テナントの互換キーとして残し、
  新テナントは `t:<tenant_id>:chat:v1` を使う（`chatKey(tenantId, suffix)` に集約）。
- **すべてのレコードに `tenantId` を持たせ、読み出し時にも必ずフィルタ**（キー分離＋レコード検査の二重化）。

### 5.2 Room
```jsonc
{
  "id": "store_s_10293",          // 主キー。store は storeRoomIdFromStoreId(store_id)
  "tenantId": "default",
  "kind": "announce|store|group|dm|event",
  "name": "NAORU渋谷院",          // 表示名。変更されても id は不変
  "storeId": "10293",             // kind=store のとき必須
  "eventId": "ev_xxx",            // kind=event のとき必須
  "shop": "NAORU渋谷院",          // 後方互換（旧クライアントが使う）
  "members": ["staff_1", "staff_2"],
  "managers": ["staff_1"],        // 管理者（グループ設定変更・メンバー変更可）
  "purpose": "新店舗立ち上げ",     // 目的（自由グループ）
  "source": "salonone|manual|event",
  "status": "active|archived|closed",
  "createdBy": "staff_1",
  "createdAt": "2026-09-17T00:00:00.000Z"
}
```
既存の `store_<店舗名>` ルームは **削除せず**、`storeId` を後付けして同一ルームを引き継ぐ（`CHAT_ROOM_LIFECYCLE.md` 参照）。

### 5.3 Message
既存フィールドに以下を追加（すべて optional・旧クライアントは無視できる）:
`tenantId` / `ai` (`{ used, agent, sources[], confidence, answeredAt }`) / `audit` (`{ auditId, resolverVersion }`) / `deliveryId`。

---

## 6. Phase 計画

| Phase | 内容 | 主な成果物 | 状態 |
|-------|------|-----------|------|
| **1** | Chat Permission（SalonOne権限の継承 + server-side authz + Rollout） | `lib/actor.js` / `lib/authz.js` / `lib/chat-policy.js` / plan-store 適用 | 実装（**本番は root/hq のみ ON**） |
| **2** | SalonOne Store Room 自動生成 / Event Room 自動生成 | `lib/chat-rooms.js` / store_id 移行 / membership 同期 | 予定 |
| **3** | Multiple Recipient / DM / Recipient Preview + Audit | `lib/chat-recipients.js` / `lib/chat-audit.js` / Preview UI | 予定 |
| **4** | @AI Mention + AI Question UX（出典 / Confidence / Feedback） | `api/chat.js` 拡張 / `?type=aifeedback` | 予定 |
| **5** | Natural Language Recipient Resolver | `lib/chat-resolver.js` / Intent Parse / 同姓同名確認 | 予定 |
| **6** | Scheduled / Unread Resend / Smart Group / 音声入力 | `lib/chat-schedule.js` / `lib/chat-smartgroup.js` | 予定 |

各 Phase は **1 Phase = 1 feature branch = 1 PR = 1 Vercel Preview**。
PR の向き先は `feature/chat-ai-routing`（統合ブランチ）。**main には自動 merge しない。**

```
main
 └── feature/chat-ai-routing            （設計ドキュメント・統合ブランチ）
      ├── feature/chat-ai-routing-phase1  → PR → feature/chat-ai-routing
      ├── feature/chat-ai-routing-phase2  → PR → feature/chat-ai-routing
      └── …
```

---

## 7. コンフリクト最小化方針（Meta / Marketing 開発との並行）

`index.html` は 25,000 行超の単一ファイルで、他 feature と同時編集すると衝突する。したがって:

1. **新規ロジックは必ず `lib/` の新規ファイル**に置く（新規ファイル同士は衝突しない）。
2. `index.html` の編集は **Chat 関連の局所ブロックのみ**（`navSections` の chat 行、`chatMe`、`chatRoomVisible` 等）。
   Meta / Marketing 側が触るのは `mktg` / `acq*` / `soFl*` 系であり、行が離れているため衝突確率は低い。
3. `CLAUDE.md` への追記は**ファイル末尾に新セクションとして追加**（中間挿入しない）。
4. 1 Phase あたりの `index.html` 差分は **200 行以内** を目安とし、超える場合は `lib/` への抽出を先に行う。
5. Phase 着手前に `git fetch origin main && git merge origin/main` を統合ブランチで実行し、差分を小さく保つ。

---

## 7.5 本番ロールアウト（Feature Flag）

```jsonc
// KV: naoru:chat:rollout（再デプロイ不要で変更可能・既定値もこの通り）
{ "root": true, "hq": true, "owner": false, "manager": false, "staff": false,
  "features": { "recipientPreview": false, "aiMention": false, "schedule": false,
                "unreadResend": false, "smartGroup": false, "approvals": false,
                "agentActivity": false, "authzLog": false } }
```
- **owner / manager / staff への公開は明示承認まで行わない。** UI で隠すだけでなく `?type=chat` が 403 を返す。
- 新機能（複数店舗送信 / Recipient Preview / @AI / 予約送信 / 未読者再送 / Smart Group）も
  `features.*` で root/HQ 限定に順次開放する。

## 8. 既存機能への影響（互換性の約束）

- 既存の Room / Message / 既読 / リアクション / 画像 / 動画 / ノートのデータ形式は**変更しない**（追加のみ）。
- 旧クライアント（キャッシュに残った古い `index.html`）でも読み書きが壊れないこと。
- `CHAT_AUTHZ_ENFORCE` 環境変数で `shadow`（判定はするが拒否しない・ログのみ）/ `strict`（拒否する）を切替。
  **既定は `shadow`**。Preview で十分検証してから `strict` に切り替える。

---

## 9. リスクと対策

| リスク | 対策 |
|--------|------|
| plan-store にサーバー認証が無い（現状） | Phase 1 で `lib/actor.js` を導入。SSO Bearer / rootトークンを検証し、**未検証セッションは Rollout ゲートでチャットAPI自体を 403**（閲覧も不可） |
| 店舗名主キーからの移行でルームが二重化 | `chat-rooms.js` の移行関数で「同一店舗の旧ID→新ID」をマージし、メッセージは旧キーを読み続ける（Phase 2） |
| 大量送信の事故 | Recipient Preview 必須 + 件数警告 + Kill Switch + レート上限（`CHAT_RECIPIENT_RESOLVER.md` §7） |
| AI の誤宛先 | AI は候補提示のみ。曖昧・0 件・権限外は必ず停止（`CHAT_RECIPIENT_RESOLVER.md` §6） |
| AI の誤情報 | 出典・更新日時・Confidence を必ず表示。低 Confidence は `NEEDS_HQ` で人間へエスカレ |
| KV blob の肥大 / 競合 | ルーム別キー方式を維持。監査ログは別キー（`naoru:chat:audit:<YYYY-MM>`）へ月別分割 |

---

## 10. 関連ドキュメント

- `CHAT_PERMISSION_MATRIX.md` — ロール × 操作の権限表
- `CHAT_ROOM_LIFECYCLE.md` — Room の生成 / 更新 / Archive / Close
- `CHAT_RECIPIENT_RESOLVER.md` — 自然言語宛先解決の仕様
- `CHAT_AI_UX_SPEC.md` — @AI / AI Question Mode / 透明性 / Feedback の UX 仕様
- `CHAT_AUDIT_MODEL.md` — 監査レコードのスキーマと保存
