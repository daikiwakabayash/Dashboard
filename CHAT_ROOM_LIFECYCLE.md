# CHAT_ROOM_LIFECYCLE

Chat Room の生成・更新・Archive・Close のライフサイクル仕様。
**Source of truth は SalonOne（店舗・スタッフ）と Events（イベント）であり、Chat はそれに追従する。**

---

## 1. 原則

1. **`store_id` / `event_id` が正。店舗名・イベント名は表示専用。**
   店舗名が変わっても Room は同じ（= 過去ログが分断されない）。
2. Room は**自動生成されるが自動削除されない**。不要になったら `archived` / `closed` に遷移させる。
3. membership の同期は**冪等**（何度実行しても同じ結果）。
4. 既存の Room / メッセージを**壊さない**。移行は「旧 ID を新 ID に紐づける」方式で行い、削除しない。

---

## 2. Room ID 規約

| kind | id | 決定方法 |
|------|----|----------|
| `announce` | `announce_all` | 固定（既存互換） |
| `store` | `store_s_<store_id>` | `storeRoomIdFromStoreId(storeId)` |
| `store`（旧） | `store_<店舗名>` | 既存データ。移行対象（§4） |
| `event` | `event_<event_id>` | `eventRoomId(eventId)` |
| `group` | `room_<rand>` | 作成時に採番（既存互換） |
| `dm` | `room_<rand>` | 2名の組で一意（`findDmRoom` で再利用） |

テナント分離はキー側（`t:<tenant>:chat:*`）で行い、Room ID 自体には含めない
（ただしレコードの `tenantId` フィールドは必須）。

---

## 3. Store Room の自動生成・同期

### 3.1 トリガ
- 広い権限のセッション（root / hq / brand_admin）が Dashboard を開いたとき（既存 `ensureRooms` 相当）
- 日次 cron（`/api/plan-store?type=chat&action=syncstores`）※Phase 2 で追加
- 手動実行（root のみ・「店舗ルームを同期」ボタン）

### 3.2 入力
SalonOne `shops`（`{ id, name, area_id, ... }`）と `staffs`（`{ id, name, shop_id, deleted }`）。

### 3.3 処理（`lib/chat-rooms.js: syncStoreRooms`）
```
for each shop in shops:
  roomId = store_s_<shop.id>
  if room 不在 → 作成 { kind:'store', storeId, name: shop.name, source:'salonone', status:'active' }
  if room 存在 → name を更新（id は不変）、status が 'archived' なら 'active' へ復帰
  members = 当該店舗の在籍 staff_id + 所属オーナー staff_id + 常駐本部メンバー
for each room(kind=store) が shops に存在しない:
  → status='archived'（削除はしない。閉店・統合の可能性があるため）
```

### 3.4 membership の更新（異動 / 退職 / 配属変更）
- **異動**: `staff.shop_id` が変わる → 旧店舗 Room の members から除去、新店舗 Room へ追加。
  過去ログは残す（閲覧可否は authz が `storeIds` で判定するため、異動後は旧店舗が見えなくなる）。
- **退職**: `staff.deleted = true` → 全 `store` / `event` Room の members から除去。
  `group` / `dm` は自動で外さない（本人が作ったグループの履歴を壊さないため。root が手動で整理）。
- **複数店舗兼務**: `accessible_shops` / アカウントの `shops` 設定から複数 Room に所属。
- **本部メンバー**: 設定（`naoru:chat:hqmembers`）で「全店舗 Room に自動参加する staff_id」を指定可能。

### 3.5 差分レポート
同期関数は副作用を持たず、**差分（plan）を返す純粋関数**とする:
```js
{ create: [room...], update: [{id, patch}], archive: [roomId...],
  memberAdd: [{roomId, staffIds}], memberRemove: [{roomId, staffIds}] }
```
呼び出し側（API）がこれを適用する。→ テスト容易・shadow 実行（適用せず差分だけ表示）も可能。

---

## 4. 旧 `store_<店舗名>` からの移行

**削除も ID 変更もしない。** 次の手順で「同じ Room」として扱う:

1. `migrateStoreRooms(rooms, shops)` が、旧 Room の `name`/`shop` と shops を突き合わせ、
   一致した旧 Room に `storeId` を後付けする（`{...room, storeId}`）。
2. 以降、`store_id` での検索は `storeId` フィールドを見る（ID の文字列一致に依存しない）。
3. 新規店舗のみ `store_s_<id>` 形式で作られる。
4. 1 店舗に旧 Room と新 Room が両方できてしまった場合は、`mergeStoreRooms()` で
   **古い方のメッセージを新しい方へ追記**し、古い方を `status='merged', mergedInto: <id>` にする（メッセージは残す）。

> 移行は Phase 2 で shadow 実行（差分表示のみ）→ 確認後に適用する。

---

## 5. Event Room

### 5.1 入力
既存の「勉強会・イベント」タブ（`?type=events`・`sections: study|event|bukatsu` の行）。
既存データは**行の自由入力**であり壊さない。行に `eventId`（無ければ生成して付与）と
`chatRoomId` を**追加フィールドとして**保存する。

### 5.2 生成フロー
```
イベント行作成/編集
  → 参加者確定（参加者列 or 参加登録 UI）
  → 「グループチャットを作る」→ event Room 自動生成
  → 参加 Staff を自動招待（members に staff_id を投入・システムメッセージ「〇〇が参加しました」）
```
対象: 勉強会 / BBQ / 幹部研修 / 海外研修 / 新店舗立ち上げ / 部活動（= 既存3セクションすべて）。

### 5.3 終了後の扱い（イベント日が過ぎた後）
`lib/events.js: isPastEvent()` が true になった Room に対して、作成者 / root が選択:

| 選択 | 挙動 |
|------|------|
| **継続**（`active`） | 何もしない。通常の Group として使い続ける |
| **Archive**（`archived`） | 一覧の「アーカイブ」に移動。閲覧・検索は可能、投稿は不可 |
| **自動 Close**（`closed`） | イベント終了 N 日後（既定 30 日）に自動で `archived` へ。通知を1回送る |

- 既定は「自動 Close（30日）」。設定は Room の `autoCloseDays`（null = 継続）。
- `archived` / `closed` でも**メッセージは削除しない**。復帰は root / 作成者が `active` に戻せる。

---

## 6. 自由 Group Chat

Staff / Owner も権限範囲内で自由に作成可能（`CHAT_PERMISSION_MATRIX.md` §3）。

保持する属性:
```jsonc
{
  "createdBy": "staff_123",     // 作成者
  "managers": ["staff_123"],    // 管理者（複数可・作成者は既定で管理者）
  "members": ["staff_123", "staff_456"],
  "purpose": "新店舗立ち上げTeam", // 目的（自由記述・検索対象）
  "createdAt": "2026-09-17T...",
  "source": "manual",
  "smart": null                  // Smart Group のとき条件式（Phase 6）
}
```

- メンバー候補は **actor の authz スコープ内のスタッフのみ**（staff が全社名簿から任意に選べてしまわないようにする）。
- 将来の拡張点: `smart` が非 null なら Dynamic Group（`CHAT_AI_ROUTING_PLAN.md` §6 Phase 6）。
  固定 members と Smart 条件は併用可（`members` = 固定 + 条件展開の和集合）。

---

## 7. 状態遷移

```
            ┌──────────┐  archive   ┌───────────┐
 create ──▶ │  active  │ ─────────▶ │ archived  │
            └──────────┘ ◀───────── └───────────┘
                 │         restore        │
                 │ merge                  │ （閲覧のみ・投稿不可）
                 ▼                        ▼
            ┌──────────┐           （削除しない）
            │  merged  │
            └──────────┘
```

- `status` 未設定の既存 Room は `active` とみなす（後方互換）。
- `announce` / `store` は削除不可（既存実装を維持）。`archived` にはできる。

---

## 8. テスト要件（`tests/chat-rooms.test.js`）

- 同じ shops で 2 回 sync しても差分が空（冪等）
- 店舗名変更で Room ID が変わらない / name だけ更新される
- 店舗が消えたら archive、復活したら active に戻る
- 異動で旧店舗から除去・新店舗へ追加される
- 退職で store/event から除去され、group/dm は保持される
- 旧 `store_<名前>` に storeId が後付けされ、新規作成が発生しない
- イベント終了 + autoCloseDays 経過で archived になる
- 既存 events 行のフィールドを壊さない（未知フィールドを保持する）
