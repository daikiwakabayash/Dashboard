# CHAT_PERMISSION_MATRIX — チャットの権限表

**対象**: 社内チャットの送信・ルーム操作 / **判定**: `lib/authz.js`（`feature/cc-foundation`）
**接続**: `lib/chat-recipients.js` が `ctx.can` で注入を受ける

---

## 1. 役割

| 役割 | rank | 範囲 | 想定 |
|---|---|---|---|
| `root` | 100 | 全店 | 共有PASS（`DASHBOARD_PASSWORD`）でログインした管理者 |
| `admin`（本部 / `hq` / `headquarters`） | 90 | 全店 | 個人名の本部アカウント |
| `owner` | 60 | 管轄店舗 | FCオーナー・複数店管轄 |
| `manager` | 40 | 所属店舗 | 店長 |
| `staff` | 20 | 所属店舗 | セラピスト |
| `guest` | 0 | なし | 未認証 |

**AI Agent は役割ではなく `source:'agent'`。** `role` では制限を回避できない。

---

## 2. 操作の権限表

| 操作 | 必要な役割 | 店舗スコープ | AI可 | 人のみ | 再検証 |
|---|---|---|---|---|---|
| `chat.send` 送信 | staff | ✅ | ✅ | | |
| `chat.dm` 個別 | staff | ✅ | ✅ | | |
| `chat.group_create` グループ作成 | staff | ✅ | ✅ | | |
| `chat.member_add` メンバー追加 | manager | ✅ | ✅ | | |
| `chat.member_remove` メンバー削除 | manager | ✅ | ✅ | | |
| `chat.broadcast` 複数店舗一斉 | owner | — | ✅ | | |
| `chat.broadcast_all` 全社一斉 | admin（本部） | — | ❌ | | ✅ |
| `chat.schedule` 予約送信 | manager | ✅ | ✅ | | |
| `chat.resend_unread` 未読者再送 | manager | ✅ | ✅ | | |
| `chat.room_archive` ルームを畳む | owner | ✅ | | ✅ | |

- **店舗スコープ ✅** = 対象店舗が自分の管轄外なら拒否
- **人のみ** = `source:'agent'` は拒否（`humanOnly`）
- **再検証** = Bearer の60秒キャッシュを使わず毎回 `/me` を引き直す（`REVERIFY_ACTIONS`）

### なぜ全社一斉だけ AI 不可なのか

一斉送信の中で、**取り消しが最も効かない**のが全社一斉。100〜200店舗の全員に届いたあと、
誤りに気づいても訂正のほうが届かない。ここだけは人が押す。

### なぜグループ作成が staff から可能か

現行の運用（部活・勉強会）を壊さないため。作成は増えるだけで既存の連絡経路を壊さない。
**メンバーの追加削除は manager 以上**にしてある（人の出し入れは影響が大きい）。

---

## 3. 宛先数の上限

| 役割 | `chat.broadcast` の宛先上限 |
|---|---|
| staff / manager | そもそも送れない |
| owner | **200件**（`maxRecipients`） |
| admin / root | 上限なし |

現場の誤操作の歯止めが目的。本部は業務上200件を超える必要があるため除外している。
上限を超えると `too_many_recipients` で拒否され、`needs_confirmation` にはならない
（「200件までなら送れます」と部分送信させない）。

---

## 4. AI代行のときの判定

```
resolveRecipients(spec, { actor: AI, onBehalfOf: 依頼者 })
```

権限は **`onBehalfOf`（依頼した人間）** で判定する。

| 依頼者 | AIができること |
|---|---|
| staff | 自店へ送る。他店・全社は不可 |
| owner | 管轄店舗への一斉まで |
| admin | 全社一斉も通る（ただし `chat.broadcast_all` は `agentAllowed:false` なので**AIは実行できない**。宛先の下書きまで） |

`onBehalfOf` が無いAI単独実行（定期パトロール等）は、AI自身に与えた役割で判定される。
この場合も `humanOnly` / `agentAllowed:false` の操作は通らない。

---

## 5. ルームの見え方（既存 `lib/chat.js` の `roomVisibleTo`）

| ルーム種別 | 見える人 |
|---|---|
| `announce` 全社アナウンス | 全員 |
| `store` 店舗ルーム | その店舗の所属/アクセス者 ＋ root |
| `group` グループ | メンバーとして明示された人のみ |
| `dm` 個別 | 当事者2名のみ（**root でも非メンバーのDMは見えない**） |

DMだけは root も覗けない。ここを開けると、社内チャット自体が使われなくなる。

---

## 6. まだ塞げていないこと（正直に）

| 項目 | 状況 | 影響 |
|---|---|---|
| `plan-store` にサーバー認証がない | 既存の信頼モデル（thanksgift / chat と同じ） | APIを直接叩けば権限表を迂回できる。**UIレベルの制御** |
| `manager` 役割のアカウントが未作成 | 「オーナー設定」に選択肢がない | 店長は当面 `owner` か `staff` |
| Bearer 60秒キャッシュ | 高リスク操作のみ再検証済み | 通常のチャット送信は失効の反映が最大60秒遅れる |

**厳密なサーバー側分離が必要になった時点で、`plan-store` にプロキシ認証を追加する**
（`AUTHORIZATION_PLAN.md` §6-4）。それまでは社内利用前提。
