# CHAT_RECIPIENT_RESOLVER

自然言語の宛先指定を、確定した Recipient 集合に解決する仕様。
**AI は候補を作るだけで、送信はしない。送信するのは常に人間。**

---

## 1. パイプライン

```
Natural Language（入力）
   ↓ ① Normalize        全角/半角・表記ゆれ・敬称の除去
   ↓ ② Intent Parse     送信タイプ・対象・除外・本文の分離
   ↓ ③ Master Search    Store Master / Staff Master を検索（store_id / staff_id）
   ↓ ④ Recipient Resolve 集合演算（include − exclude）・重複排除
   ↓ ⑤ Authz Filter     actor の権限で必ず後段フィルタ（← ここが最終防衛線）
   ↓ ⑥ Preview          人間に表示（件数警告・除外明示）
   ↓ ⑦ Human Confirm    [送信] / [修正] / [キャンセル]
   ↓ ⑧ Send             監査レコードを書いてから送信
```

②のみ LLM（`api/chat.js` の構造化出力）、①③④⑤は**決定的な純粋関数**（`lib/chat-resolver.js` / `lib/chat-recipients.js`）。
→ LLM が壊れても「解決できない」になるだけで、誤送信にはならない。

---

## 2. Intent スキーマ（LLM の出力形式）

LLM には**必ず JSON のみ**を返させる。自由文は返させない。

```jsonc
{
  "version": "resolver-1",
  "sendType": "store_group | multiple_groups | dm | broadcast",
  "include": [
    { "type": "store",  "value": "新宿" },      // 店舗名（部分一致・候補提示用）
    { "type": "area",   "value": "関西" },      // エリア（lib/geo.js の地域名）
    { "type": "role",   "value": "manager" },   // 役職
    { "type": "staff",  "value": "田中" },      // 氏名（部分一致）
    { "type": "group",  "value": "教育Team" },  // 既存グループ名
    { "type": "all",    "value": "" }           // 全社
  ],
  "exclude": [ { "type": "store", "value": "大阪" } ],
  "body": "本文（宛先指定を取り除いた本文）",
  "confidence": 0.0,          // 0..1
  "ambiguous": ["田中"],      // 一意に決まらなかったトークン
  "notes": ""
}
```

### 入力例 → Intent

| 入力 | sendType | include | exclude |
|------|----------|---------|---------|
| 「新宿、渋谷、池袋だけに送って」 | `multiple_groups` | store:新宿, store:渋谷, store:池袋 | — |
| 「大阪店以外の全店舗に送って」 | `broadcast` | all | store:大阪 |
| 「関西エリアの院長全員に送って」 | `multiple_groups` | area:関西 + role:manager | — |
| 「恵比寿院の田中さんと佐藤さんにDM」 | `dm` | staff:田中(@恵比寿), staff:佐藤(@恵比寿) | — |

---

## 3. Master Search

### Store Master
入力: SalonOne `shops`（`store_id` / `name` / `area_id`）+ `lib/geo.js` の都道府県・地域。
- 正規化: 全角半角・「NAORU」「整骨院」「院」「店」等の接辞を落として比較（接辞リストは**設定値**。core にハードコードしない）。
- `area` は `lib/geo.js` の地域グルーピングを使用（関西 / 関東 / 九州 …）。
- 一致は「完全一致 > 前方一致 > 部分一致」の優先度。**複数一致は候補として全部返す**（勝手に選ばない）。

### Staff Master
入力: SalonOne `staffs` + 共有 dir（`?type=chat` の `dir.staff`）+ プロフィール（`?type=profile`）。
検索キー:
| キー | 例 | 状態 |
|------|----|------|
| `name` | 佐藤拓磨 | 実装 |
| `nameKana` | サトウタクマ | 実装（profile にあれば） |
| `shopName` | NAORU銀座院 | 実装 |
| `role` | 院長 / マネージャー | 実装 |
| `alias` / 旧姓 / nickname | たくちゃん / 旧姓:鈴木 | **将来拡張**（`profile.aliases: []` を予約） |

`aliases` は Phase 5 時点ではスキーマだけ用意し、検索対象に含める実装のみ入れる（データ入力 UI は後続）。

---

## 4. Recipient Resolve（集合演算）

```
resolved = union(include の展開) − union(exclude の展開)
```
- 店舗 → その店舗の `store` Room（`sendType` が group 系のとき）
- 店舗 → その店舗の在籍スタッフ（`sendType` が dm のとき）
- エリア → 該当店舗群へ展開
- 役職 → 該当スタッフへ展開（店舗条件と AND）
- 重複排除は `store_id` / `staff_id` で行う（表示名では行わない）

出力:
```jsonc
{
  "sendType": "multiple_groups",
  "storeIds": ["10293","10294"],
  "staffIds": [],
  "roomIds": ["store_s_10293","store_s_10294"],
  "excludedStoreIds": ["10300"],
  "excludedStaffIds": [],
  "storeCount": 2, "roomCount": 2, "staffCount": 14,
  "ambiguous": [],            // 要確認の候補（§6）
  "deniedStoreIds": [],       // 権限外として落ちたもの（Preview で明示）
  "resolverVersion": "resolver-1",
  "confidence": 0.93
}
```

---

## 5. Authz Filter（最終防衛線）

`lib/chat-authz.js` の `filterRecipients(actor, resolved)` を**必ず**通す。
- actor のスコープ外の `store_id` / `staff_id` は `deniedStoreIds` / `deniedStaffIds` へ移し、送信対象から除外。
- `broadcast.all` を持たない actor が `sendType: broadcast` を要求したら **deny**（黙って縮小しない）。
- AI Agent が actor の代理で解決した場合も、**actingFor の権限でフィルタ**する（AI は人間の権限を超えられない）。

---

## 6. 曖昧性の扱い（同姓同名対策）

**AI は絶対に自動で選ばない。** 候補が複数ある場合は `ambiguous` に入れて Preview で人間に選ばせる。

```
「佐藤さん」に一致する候補が3名います。誰に送りますか？

 ○ [写真] 佐藤拓磨   NAORU銀座院 / 院長
 ○ [写真] 佐藤 ○○   NAORU新宿院 / セラピスト
 ○ [写真] 佐藤 ○○   NAORU梅田院 / セラピスト
```
表示項目: **氏名 / 所属店舗 / 役職 / プロフィール画像**（`?type=profile` の `mainImg`。無ければイニシャル）。

- 選択されるまで送信ボタンは**無効**。
- 「全員に送る」も選択肢として出す（明示的な人間の意思表示）。
- `staff_id` を選択結果として保持し、以降の再送・監査にはこの `staff_id` を使う。

---

## 7. Safety（送信を止める条件）

以下のいずれかに該当したら **送信ボタンを無効化し、理由を表示**する（`lib/chat-recipients.js: safetyCheck`）:

| # | 条件 | メッセージ |
|---|------|-----------|
| 1 | Recipient 0 人 / 0 Room | 「送信先が0件です」 |
| 2 | `ambiguous` が残っている | 「宛先が確定していません」 |
| 3 | 権限外の店舗 / スタッフが含まれる | 「権限のない送信先が含まれます」 |
| 4 | 存在しない `staff_id` / `store_id` | 「存在しない送信先です」 |
| 5 | Kill Switch ON | 「送信機能が一時停止中です」 |
| 6 | 異常な大量送信（既定: 50 Room 超 or 300 名超） | 「大量送信の確認が必要です」＋二重確認 |
| 7 | Room membership が不正（members に未知の staff_id） | 「ルームのメンバー情報が不正です」 |
| 8 | 本文が空 | 「本文が空です」 |

- 6 は**ブロックではなく二重確認**（root / hq のみ続行可）。owner / manager は上限 20 Room。
- 閾値は設定値（`CHAT_BULK_WARN_ROOMS` / `CHAT_BULK_WARN_STAFF`）。テナントごとに上書き可。

---

## 8. Recipient Preview（UI 仕様）

送信前に必ず表示（`CHAT_AI_UX_SPEC.md` §5 に UI 詳細）:

```
┌─ 送信内容の確認 ───────────────────────────┐
│ 送信タイプ： 複数グループ                  │
│ 対象店舗　： 92店舗                        │
│ 対象Group ： 92                            │
│ 対象Staff ： 238名                         │
│ 除外　　　： 大阪店（1店舗）               │
│                                            │
│ ⚠️ 92店舗 / 238名 へ送信します              │
│                                            │
│ ▼ 対象一覧（展開）                         │
│ ・NAORU新宿院 (12名)                       │
│ ・NAORU渋谷院 (9名)                        │
│ …                                          │
│                                            │
│ 本文：                                     │
│ ───────────────────────────────            │
│ 〜〜〜                                     │
│                                            │
│   [送信]   [修正]   [キャンセル]           │
└────────────────────────────────────────────┘
```
- 件数が閾値超のときは警告行を**赤地・太字**で強調し、`[送信]` を二段階（チェックボックス → 送信）にする。
- `[修正]` は Intent（宛先チップ）と本文を編集できる状態に戻す。AI に再解釈させず、人間が直接編集できる。

---

## 9. 音声入力との分離

```
Speech to Text（Provider 依存）
   ↓ プレーンテキスト
Recipient Resolver（本仕様）
   ↓
Preview → Send
```
- Speech Provider（Web Speech API / 外部 STT）は `lib/speech.js` に閉じ込め、**戻り値は文字列のみ**。
- Chat 側は「テキストがどこから来たか」を知らない（`inputSource: 'voice'|'text'` を監査に記録するだけ）。
- Provider 変更時に Chat / Resolver のコードは変更しない。

---

## 10. バージョニング

- `resolverVersion`（例: `resolver-1`）を Intent・解決結果・監査レコードに必ず含める。
- プロンプトや正規化ルールを変えたら**必ずバージョンを上げる**（過去の監査ログの再現性のため）。

## 11. テスト要件（`tests/chat-resolver.test.js` / `tests/chat-recipients.test.js`）

- §2 の 4 例が期待どおりの Intent → Recipient になる
- exclude が include より強い（「大阪以外の全店」で大阪が確実に落ちる）
- 同姓同名が `ambiguous` に入り、resolved には入らない
- 権限外店舗が `deniedStoreIds` に落ちる（staff が全店を指定しても自店のみ）
- Safety 8 条件それぞれで送信が止まる
- 0 件・空本文・Kill Switch
- LLM 出力が壊れた JSON でも例外を投げず `ambiguous` 扱いになる
