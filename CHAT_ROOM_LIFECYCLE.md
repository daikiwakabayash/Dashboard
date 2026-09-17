# CHAT_ROOM_LIFECYCLE

Chat Room の生成・更新・Archive のライフサイクル仕様。
**⚠️ この文書は「既存実装の延長」として書かれている。**
Store Room / Event Room の自動生成は**すでに動いている**（`CHAT_EXISTING_INTEGRATION_AUDIT.md` §4・§5）。
新しいロジックで作り直さず、既存の関数を拡張する。

---

## 0. 既存実装（＝正式な Room Lifecycle 基盤）

| 目的 | 既存の実装 | 置き換えるか |
|---|---|---|
| 店舗ルーム自動生成 | `index.html: chatEnsureRooms()` → `api/plan-store ?type=chat&action=ensureRooms` → `lib/chat.js: ensureBaseRooms()` | **しない（延長する）** |
| 全社アナウンス | `ensureBaseRooms()` が `announce_all` を作る | しない |
| 全社スタッフ名簿 | `ensureRooms` が `dir.staff=[{id,name,shop}]` を保存 | しない |
| イベント/勉強会のグループ | `index.html: evSaveChat()` → `createRoom`（`kind:'group'`・`icon:'📅'`）＋行に `cells.roomId` を保存 | **しない（延長する）** |
| イベント参加 | `index.html: evJoinChat()` → `action:'join'` | しない |
| メンバー変更 | `action:'setMembers'` / `'join'` / `'leave'` | しない |
| 重複アカウント統合 | `action:'remapUser'`（root専用） | しない |

**新規に追加するのは「SalonOne の store_id 紐付け」と「異動・退職の membership 同期」だけ。**

---

## 1. 原則

1. **既存の Room ID を変えない。** 既存ルームは `store_<店舗名>` のままで、`storeId` を**後付け**する。
   （ID を変えると過去ログが分断され、`cells.roomId` で紐付いたイベント行も壊れる）
2. **`store_id` / SalonOne の ID が正。** 店舗名は表示と、`storeId` 未設定ルームのフォールバックにのみ使う。
3. membership 同期は**冪等**で、**差分（plan）を返す純粋関数**として実装する（適用は呼び出し側）。
4. 自動生成はするが**自動削除はしない**。不要になったら `status:'archived'`。

---

## 2. Room ID 規約（既存＋追加）

| kind | 既存の id | 新規作成時の id | 備考 |
|---|---|---|---|
| `announce` | `announce_all` | 同left | 変更なし |
| `store` | `store_<店舗名>` | `store_<店舗名>`（**当面維持**） | `storeId` フィールドを後付けして ID 依存をなくす |
| `group`（イベント含む） | `room_<rand>` | 同left | イベントは `icon:'📅'` ＋ 行の `cells.roomId` で紐付く（既存） |
| `dm` | `room_<rand>` | 同left | `findDmRoom` で再利用（既存） |

> 将来 `store_s_<store_id>` へ移行する場合も、**旧 ID の Room をそのまま使い続ける**（`storeId` で引く）。
> 新旧2つできてしまった場合のみ `mergedInto` で片方を退避する。

---

## 3. Store Room：既存の `ensureRooms` をどう延長するか

### 3.1 現状（そのまま使う）
```js
// lib/chat.js
ensureBaseRooms(rooms, shops)   // shops = [{name}]
//  → announce_all と store_<name> を「無ければ」作る（冪等）
```
トリガは「ログイン済みセッションで店舗/スタッフが2件以上揃ったとき」（`index.html` の useEffect）。
**Phase 1 以降は「チャットが公開されているセッション（root/hq）」だけが実行する。**

### 3.2 追加する2点

**(A) `storeId` の後付け（既存ルームを壊さない）**
```js
ensureBaseRooms(rooms, shops)   // shops = [{ id, name }] を受け取れるようにする（後方互換：id 無しでも動く）
//  - 既存の store ルームで storeId が未設定 かつ 名前が一致 → { ...room, storeId: shop.id } を付ける
//  - 新規店舗 → 従来どおり store_<name> を作り、最初から storeId を持たせる
//  - 店舗名が変わった場合 → storeId 一致のルームの name/shop を更新（ID は変えない）
```

**(B) membership 同期（新規・差分を返す純粋関数）**
```js
planStoreMembership({ rooms, shops, staffs, hqMembers })
//  → { memberAdd:[{roomId,staffIds}], memberRemove:[{roomId,staffIds}], patch:[{roomId,storeId,name}] }
```
| 事象 | 差分 |
|---|---|
| 新規スタッフ配属 | 該当店舗ルームに `memberAdd` |
| 異動（`staff.shop_id` 変更） | 旧店舗ルームから `memberRemove`・新店舗ルームへ `memberAdd`（**過去ログは残す**） |
| 退職（`staff.deleted`） | 全 `store` ルームから `memberRemove`（`group`/`dm` は触らない） |
| 複数店舗の owner/manager | SalonOne の `accessible_shops` 全店の store ルームに `memberAdd` |
| 閉店（shops に無い） | `patch` で `status:'archived'`（削除しない） |

- `members` が入っても**可視判定は変わらない**（`canViewRoom` は「メンバー or store_id スコープ」の OR）。
  → 同期が未実行でも従来どおり見える＝**段階導入できる**。
- 在籍判定は既存の `chatStoreStaff()` と同じ規則（プロフィール手入力を優先 → SalonOne `shop_id`）を使う。

### 3.3 反映タイミング
SalonOne 側の権限変更は、**次回ログインまたは起動時の `/me`** で `authState` に反映される（既存の仕組み）。
店舗ルームの membership は、その後の `ensureRooms`（または日次 cron）で追従する。

---

## 4. Event Room：既存の `evSaveChat` をどう延長するか

### 4.1 現状（そのまま使う）
```
勉強会・イベントの行
  ├ cells.chatTitle / cells.date / cells.ownerId（責任者）
  └ cells.roomId  ←── evSaveChat() が作成した group ルームの id を保存（＝実質の event_id 紐付け）

evSaveChat: 未作成なら createRoom（kind:'group'・icon:'📅'・members=[作成者,責任者]）
            作成済みなら setRoom（名前更新）＋ setMembers（メンバー統合）
evJoinChat: 参加者本人が join（システムメッセージ「〇〇が参加しました」）
```
対象は既存の3セクション（勉強会 / イベント / 部活）＝ BBQ・幹部研修・海外研修・新店舗立ち上げもここに含まれる。

### 4.2 追加する3点（すべて任意フィールド・既存行を壊さない）
| 追加 | 内容 |
|---|---|
| `eventId` | 行に無ければ生成して `cells.eventId` に保存。Room 側にも `eventId` を持たせる（`roomId` 紐付けは維持） |
| 参加者の一括招待 | 「参加者確定 → 参加Staffを自動招待」を **既存の `setMembers`** で行う（新しい招待APIは作らない） |
| 終了後の扱い | `lib/events.js: isPastEvent()` が true の行に対し、**継続 / Archive / 自動Close(既定30日)** を選択。`room.status='archived'` にするだけで、メッセージは残す |

- **`kind` は `group` のまま変更しない**（`event` に変えると既存ルームの可視・一覧表示が変わるため）。
  イベント由来かどうかは `eventId` の有無で判定する。

---

## 5. 自由 Group Chat（既存の createRoom を使う）

保持する属性（既存＋追加）:
```jsonc
{
  "createdBy": "staff_123",      // 既存
  "members": ["staff_123"],      // 既存
  "name": "新店舗立ち上げTeam",   // 既存
  "icon": "📅",                  // 既存
  "managers": ["staff_123"],     // 追加（既定は createdBy）
  "purpose": "",                 // 追加（目的・検索対象）
  "eventId": "",                 // 追加（イベント由来のときだけ）
  "storeId": "",                 // 追加（store ルームのみ）
  "status": "active",            // 追加（未設定は active 扱い）
  "tenantId": "default",         // 追加（ホワイトラベル前提）
  "smart": null                  // 将来: Smart Group の条件式
}
```
メンバー候補は **actor の権限範囲内のスタッフのみ**（`canInviteMember` / `canCreateRoom` が検査）。

---

## 6. 状態遷移

```
 create ──▶ active ──archive──▶ archived ──restore──▶ active
                                  （閲覧のみ・投稿不可・メッセージは残す）
```
- `status` 未設定は `active` 扱い（既存データ互換）。
- `announce` / `store` は削除不可（既存挙動を維持）。`archived` にはできる。

---

## 7. テスト要件（`tests/chat-rooms.test.js`・Phase 2）

- `ensureBaseRooms` に `{id,name}` を渡しても**既存ルームの id が変わらない**／`storeId` だけが付く
- 店舗名変更で `name` だけ更新され、Room と過去ログが保持される
- 同じ入力で2回実行しても差分が空（冪等）
- 異動で旧店舗から remove・新店舗へ add、`group`/`dm` は不変
- 退職で `store` からのみ remove
- 複数店舗の owner が全担当店舗ルームに add される
- 閉店で `archived`、再開で `active`
- イベント行の未知フィールドが保持される（既存データを壊さない）
