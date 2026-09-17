# CHAT_AUDIT_MODEL — チャット送信の監査記録

**ロジック**: `lib/chat-audit.js` / **テスト**: `tests/chat-audit.test.js`（18件）
**保存先**: `/api/plan-store?type=audit`（既存の監査ログと同じ経路・環境スコープ済み）

---

## 1. 何のために残すか

AIが宛先を解釈して代行送信できるようになると、**「なぜこの人に届いたのか」を人が
再現できないと運用に乗せられない**。だから結果（誰に届いたか）だけでなく、
**過程**（何が曖昧で、誰が確定させたか）まで残す。

---

## 2. 残す項目

| 項目 | 例 | なぜ要るか |
|---|---|---|
| `at` | `2026-09-17T…` | いつ |
| `tenantId` | `naoru` | ホワイトラベル時にテナントを跨いで見えないようにする |
| `channel` | `ui` / `ai` / `scheduled` / `resend_unread` | どの経路で送られたか |
| `actorId` / `actorName` / `actorRole` | `a_chat` / AIアシスタント / root | **押した主体** |
| `source` | `ui` / `agent` / `cron` | 人かAIか |
| `onBehalfOfId` / `onBehalfOfName` | `u1` / 若林 | **誰の権限で送ったか** |
| `roomId` / `roomKind` | `store_恵比寿` / `store` | どこへ |
| `action` | `chat.broadcast` | どの権限で判定したか |
| `shopIds` / `staffIds` | `['sh1','sh2']` | **実際の宛先（名前ではなくID）** |
| `recipientCount` | `28` | 規模 |
| `excludedShopIds` | `['sh3']` | 除外した先 |
| `specRaw` | 「東京の店舗全部に…」 | **元の依頼文**（再現用） |
| `hadAmbiguity` | `true` | 曖昧な宛先があったか |
| `confirmedBy` | `u1` | **誰が確定させたか** |
| `outOfScopeCount` | `1` | 権限で落ちた宛先の数 |
| `bodyPreview` / `bodyLength` | 冒頭120字 / 500 | 何を |
| `hasAttachment` | `true` | 添付の有無 |

---

## 3. 残さないもの

| 残さないもの | 理由 |
|---|---|
| 本文の全文 | 個人情報・健康情報が混ざる。全文は `messages` 本体にあり、そちらは既存の可視性ルールに従う |
| トークン・パスワード・APIキー | `SECRET_KEYS` で**入れ子の奥まで**落とす（テスト済み） |
| 画像・ファイルの中身 | 有無だけ |
| 受信者の既読状態 | `reads` 側の話。監査で追跡すると監視になる |

---

## 4. 送らなかったことも残す（`buildBlockedAudit`）

**届いていない理由を誰も説明できない**、が最悪の状態。止めた送信も記録する。

| 追加項目 | 例 |
|---|---|
| `blocked` | `true` |
| `blockedStatus` | `needs_confirmation` / `denied` / `empty` |
| `blockedCode` | `role_too_low` / `out_of_scope` / `too_many_recipients` |
| `blockedReason` | 「宛先が確定していません」 |
| `recipientCount` | **0 に固定**（届いていないので） |
| `bodyPreview` | **空**（送っていない本文は残さない） |

これにより「AIに頼んだのに届いていない」という問い合わせに、
**「9/17 14:32、田中さんが2人いたため確認待ちで止まりました」** と即答できる。

---

## 5. 監査画面での絞り込み（`filterAudit`）

| 条件 | 用途 |
|---|---|
| `tenantId` | **常に一致必須**。テナントを跨いで見えない |
| `source: 'agent'` | AIが行った操作だけを見る |
| `blocked: true` | 止まった送信だけを見る（運用の詰まりを探す） |
| `shopId` | ある店舗宛の送信を追う |
| `actorId` | ある人の送信を追う |
| `since` | 期間 |
| 壊れた行 | 自動で落とす |

---

## 6. 既存の監査ログとの関係

`lib/audit.js`（`feature/cc-foundation`）は Command Center の操作全般（フラグ変更・承認など）。
`lib/chat-audit.js` は**チャット送信に特化**して項目を増やしたもの。

| | `lib/audit.js` | `lib/chat-audit.js` |
|---|---|---|
| 対象 | フラグ・承認・認可判定 | チャット送信 |
| 保存先 | `naoru:cc:audit:v1` | 同じキーに `entity:'chat'` として入れる想定 |
| 秘匿 | `redact()` | `SECRET_KEYS` |

**同じキーに入れる**ので、監査画面は1つで済む。`entity` で絞り込む。

---

## 7. 保持期間（未決・人の判断が必要）

| 案 | 保持 | 備考 |
|---|---|---|
| A | 直近 2,000 件（リングバッファ） | 既存の `AUDIT_CAP` と同じ。実装が簡単 |
| B | 90日 | 労務トラブルの調査に耐える |
| C | 1年 | 監査要件がある顧客（ホワイトラベル）向け |

現状は**A**（既存の実装に合わせる）。ホワイトラベル提供時に B / C の要否を判断する。
