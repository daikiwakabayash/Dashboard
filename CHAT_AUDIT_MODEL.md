# CHAT_AUDIT_MODEL

チャット送信の監査（Audit）モデル。**全送信を記録する。**

---

## 1. 記録対象

| 対象 | 記録する |
|------|----------|
| 通常の 1 Room 送信 | ✅ |
| 複数 Room 一斉送信（Broadcast） | ✅（1 送信 = 1 audit、宛先は配列で保持） |
| DM | ✅ |
| Resolver 経由の送信 | ✅（`original_instruction` / `resolved_instruction` 付き） |
| 予約 / 定期送信 | ✅（作成・実行・取消をそれぞれ記録） |
| 未読者再送 | ✅（`resend_of` に元 `message_id`） |
| AI の回答投稿 | ✅（`ai_used: true`・`actor_role: 'agent'`・`approved_by` は起動した人間） |
| 権限違反（拒否 / shadow 検知） | ✅（`status: 'denied'` / `'violation'`） |

---

## 2. スキーマ（必須フィールド）

```jsonc
{
  "message_id": "m_l2x9_ab12",          // 送信されたメッセージID（複数Roomなら配列 message_ids）
  "tenant_id": "default",
  "actor_id": "staff_123",              // 実行者（staff_id が正）
  "actor_role": "root|hq|owner|manager|staff|agent",
  "room_id": "store_s_10293",           // 単一。複数Roomなら room_ids に配列
  "message_type": "text|image|file|video|system|ai_answer",
  "recipient_store_ids": ["10293","10294"],
  "recipient_staff_ids": ["staff_1","staff_2"],
  "recipient_count": 238,               // 実人数（重複排除後）
  "original_instruction": "大阪店以外の全店舗に送って",  // 人が入力した原文（null可）
  "resolved_instruction": { /* Resolver の resolved オブジェクト */ },
  "message_body": "本文",               // §4 の保存ポリシーに従う
  "ai_used": true,
  "resolver_version": "resolver-1",
  "resolver_confidence": 0.93,
  "created_at": "2026-09-17T01:00:00.000Z",  // 監査レコード生成時刻
  "approved_at": "2026-09-17T01:00:12.000Z", // 人間が[送信]を押した時刻
  "sent_at": "2026-09-17T01:00:12.400Z",     // 実送信完了時刻
  "status": "draft|pending_approval|approved|sent|partial|failed|cancelled|denied|violation"
}
```

### 補助フィールド（optional）
| field | 用途 |
|-------|------|
| `audit_id` | 監査レコード自身の ID（`audit_<rand>`） |
| `room_ids` / `message_ids` | 複数 Room 送信時 |
| `approved_by` | 承認した**人間**の staff_id（AI は入らない） |
| `input_source` | `text` / `voice`（音声入力） |
| `excluded_store_ids` / `excluded_staff_ids` | 明示的に除外した宛先 |
| `denied_store_ids` / `denied_staff_ids` | 権限で落ちた宛先 |
| `schedule_id` | 予約送信の場合 |
| `resend_of` | 未読者再送の元 message_id |
| `ai` | AI 回答のメタ（sources / confidence / escalated） |
| `deny_reason` | `status: denied|violation` のときの理由コード |
| `client` | `{ ua, appVersion }`（デバッグ用・個人特定情報は含めない） |

---

## 3. status の遷移

```
draft ─▶ pending_approval ─▶ approved ─▶ sent
                │                 │         └─▶ partial（一部Roomで失敗）
                │                 └─▶ failed
                └─▶ cancelled

denied     … 権限チェックで拒否（strict）
violation  … shadow モードで「本来なら拒否」を検知（実行はされた）
```

- `pending_approval` は Preview 表示中の状態。**この段階では 1 通も送信されていない。**
- `approved_at` が null のまま `sent` になることは**ない**（＝人間の承認なしの送信は構造上あり得ない）。
  例外: システム送信（Room 自動生成のシステムメッセージ）は `actor_role: 'system'` / `approved_by: 'system'`。

---

## 4. 本文（message_body）の保存ポリシー

- 既定では**本文を保存する**（社内連絡の監査のため）。
- 保存上限 4,000 文字（超過分は切り詰め、`body_truncated: true`）。
- 画像・動画・ファイルは**本体を保存せず**、`media_refs: [{ kind, id|url, name, size }]` のみ。
- DM の本文保存は設定で切替可能（`CHAT_AUDIT_DM_BODY=none|hash|full`、既定 `hash`）。
  `hash` は `sha256(body)` のみ保存し、内容は残さない（プライバシーと監査の両立）。

---

## 5. 保存先

| 種別 | キー |
|------|------|
| 監査ログ（月別） | `naoru:chat:audit:<YYYY-MM>` … 配列（上限 5,000 件 / 月。超過で古いものから別キーへ退避） |
| テナント分離 | `t:<tenant_id>:chat:audit:<YYYY-MM>` |
| インデックス | なし（月キー + 線形走査。件数が増えたら外部 DB へ移行） |

- 監査ログは**メッセージ本体とは別キー**（blob 肥大・競合回避）。
- 追記は KV のアトミック追記（既存 `kvAppendJson` と同じ方式）を使う。
- 監査ログの**削除・改変 API は提供しない**（root でも不可）。退避のみ。

---

## 6. 閲覧

- `GET /api/plan-store?type=chataudit&month=YYYY-MM` … `audit.read` 保持者のみ
- root / hq: 全件。owner / manager / staff: `actor_id === 自分` のみ。
- 返却時に `message_body` は `audit.read` のスコープに従ってマスクする（他人の DM 本文は返さない）。

---

## 7. 未読管理（再送の前提）

「昨日送った連絡を未読者だけに再送」を可能にするため、以下を正確に持つ:

```jsonc
// naoru:chat:reads:v1（既存・拡張）
{ "<staff_id>": { "<room_id>": 1758000000000 } }   // lastReadMs（既存）

// naoru:chat:receipt:<room_id>（新規・Phase 6）
{ "<message_id>": { "<staff_id>": 1758000001234 } } // read_at（メッセージ単位）
```
- 既存の `lastReadMs` だけでも「未読者」は算出できる（`read_at < message.createdAt` の人）。
  メッセージ単位の `receipt` は精度が要るケース（重要連絡の既読確認）のみ記録する。
- 再送時は `resend_of` を付け、Preview で「対象人数 / 未読者一覧」を表示してから送る。

---

## 8. 保持期間

- 既定 **24 ヶ月**。超過した月キーは削除ではなく `archived` フラグ付きで退避（運用で外部保管）。
- テナントごとに `CHAT_AUDIT_RETENTION_MONTHS` で上書き可。

---

## 9. テスト要件（`tests/chat-audit.test.js`）

- 必須 20 フィールドが欠けているレコードを `validateAudit()` が弾く
- `sent` なのに `approved_at` が null のレコードを弾く
- `approved_by` に agent actor を入れたら弾く
- 複数 Room 送信で `room_ids` / `recipient_count` が正しい
- DM 本文が `hash` 設定でハッシュのみになる
- shadow モードの違反が `status: 'violation'` で記録される
- テナント違いのレコードが読み出しでフィルタされる
