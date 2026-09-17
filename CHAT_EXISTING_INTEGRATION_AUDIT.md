# CHAT_EXISTING_INTEGRATION_AUDIT

既存の SalonOne 連携・チャット関連実装の調査結果。
**目的: 同じ目的の処理を二重実装しないこと。** 何をそのまま使い、何だけ追加するかをここで確定する。

調査対象コミット: `feature/chat-ai-routing-phase1`（`main` = `99b7f50` 時点の実装）
調査日: 2026-09-17

---

## 1. SalonOne → Dashboard ログインフロー（既存・そのまま使う）

### 1.1 入口は1つ（ID＋PASS）
`index.html` のログイン画面（`authLogin`）は **1つの ID / PASS 欄**しかなく、内部で2系統を**並列**に試す。

```
[ID + PASS]
   ├─ ① POST /api/settlement-auth {action:'login'}         … 本社root(DASHBOARD_PASSWORD) / 本部(hq) / GASオーナーアカウント
   │     └─ 最大3.5秒でタイムアウト（遅い GAS で SSO を待たせない）
   └─ ② soLogin(id, pw) → POST /api/salonone?resource=auth/login … サロンワンSSO
         └─ 429 は Retry-After を尊重して最大5回リトライ

①が成功 → applySettlement()／①不一致・タイムアウト → ②の結果 applySso()
②も失敗 → ①の実結果を待って再判定（オーナーの取りこぼし防止）
```

- **新しいチャット専用ログインは不要。この二段フォールバックをそのまま使う。**
- SSO トークン: `naoru_so_at`（access・60分）/ `naoru_so_rt`（refresh・14日）/ `naoru_so_atexp`
- `window.fetch` インターセプタが `/api/salonone?resource=me`・`/api/settlement-store`・`/api/settlement-owners`（Phase 1 で `/api/plan-store` を追加）に Bearer を自動付与し、401 時に `auth/refresh` で1回だけ自動更新→再試行。

### 1.2 セッション復元（起動時）
| provider | 検証方法 |
|---|---|
| `salonone` | `GET /api/salonone?resource=me`（Bearer）→ ロール・アクセス店舗を**毎回最新化** |
| `settlement` | `POST /api/settlement-auth {action:'verify'}` ＋ `?type=accountmeta`（KV）で role/staffId/staffName を補完 |

→ **SalonOne 側で権限が変わると、次回ログインまたは起動時の `/me` で自動反映される。**（要件6を既存機構が満たしている）

### 1.3 サーバー側の Bearer 検証（既存）
`lib/salonone-auth.js: verifySalonOneBearer(bearer)` が `/me` を叩いて
`{ root, role, shopIds[], shopNames[], userId, staffId, loginId }` を返す。
既に `settlement-store` / `settlement-owners` の認可に使われている。**チャットもこれを使う（新規実装しない）。**

---

## 2. SalonOne から取得している role / shop / staff 情報

| 情報 | 取得元 | 現在の保存先 | 備考 |
|---|---|---|---|
| ロール | `/me` の `role` | `authState.role` | `mapSalonOneRole()` で写像: `brand_admin`→`root` / `shop_admin`→`owner` / `shop_staff`→`staff` |
| アクセス店舗 | `/me` の `accessible_shops[]` | `authState.shops` = **名前の配列**（`.name` のみ） | ⚠️ **`.id` を捨てている**（要修正・§4） |
| ユーザーID | `/me` の `user_id` | `authState.owner`（login_id 優先） | |
| スタッフID | `/me` の `staff_id ?? user_id` | `authState.staffId` | チャットの本人ID（`chatMyId`）になる |
| 店舗マスタ | `GET ?resource=shops&limit=1000` | `soShopsRaw[{id,name,area_id,timezone,address}]` | **キーのみ取得＝誰がログインしてもブランド全店**（`api/salonone.js` の既定動作） |
| スタッフマスタ | `GET ?resource=staffs&limit=1000` | `soStaffs[{id,name,shop_id,deleted,acceptsRes}]` | 同上 |

> 🔴 **最重要の発見**: SalonOne は `accessible_shops[].id`（＝store_id）を返しているのに、
> フロントは `.name` だけを `authState.shops` に保存しており、以降の権限判定はすべて
> **店舗名の部分一致**（`s.name.includes(pattern)`）で行われている（`soShops` / `soShopsMine` / `roomVisibleTo`）。
> → 要件2「store_id を正とする」を満たすには**取り込み口（`authStateFromSo`）を直すだけ**でよい。

---

## 3. 複数店舗権限の現在の表現

```js
// index.html authStateFromSo()
const shops = role === 'root' ? null
  : (u.accessible_shops || []).map(s => s.name).filter(Boolean);   // ← 名前の配列
```

| ロール | `authState.shops` | 判定方法 |
|---|---|---|
| root / hq | `null`（＝全店） | `authState.root === true` で全許可 |
| owner / staff（SSO） | `['NAORU渋谷院','NAORU恵比寿院']` | 店舗名の**部分一致** |
| owner / staff（GASアカウント） | GAS「オーナー設定」の店舗パターン | 同上（**Dashboard 独自の二重管理**） |

- **複数店舗はすでに配列で扱えている**（1店舗のユーザーは1要素）。構造変更は不要で、**中身を name → store_id にするだけ**。
- GAS「オーナー設定」の店舗指定は**返金明細書の公開範囲**として必要なので残すが、
  **チャットの認可には使わない**（要件3「二重管理しない」）。

---

## 4. 既存の Store Room 自動生成ロジック（延長して使う）

### 4.1 トリガ
`index.html` L4753 付近:
```js
useEffect(() => {
  if (!authState.authenticated) return;
  if (soShopsRaw.length >= 2 || soStaffs.length >= 2) chatEnsureRooms(soShopsRaw, soStaffs);
}, [authState.authenticated, soShopsRaw.length, soStaffs.length]);
```
- ログイン済みで店舗/スタッフ一覧が2件以上揃ったセッションが実行（`chatEnsuredRef` で同一セッション1回）。
- AIパトロール（`patrolFindRoom` 失敗時）からも再実行される。

### 4.2 処理
`chatEnsureRooms` → `POST /api/plan-store {type:'chat', action:'ensureRooms', shops, staff}`
→ `lib/chat.js: ensureBaseRooms(rooms, shops)`

```js
ANNOUNCE_ROOM_ID = 'announce_all'
storeRoomId(shopName) = `store_${shopName}`        // ← 店舗「名」が主キー
{ id, kind:'store', name: shopName, shop: shopName, members: [], createdBy:'__system__', createdAt }
```
同時に `dir.staff = [{id, name, shop}]`（全社スタッフ名簿・最大8000件）を保存。

### 4.3 membership
- **store ルームの `members` は空のまま。** 可視判定は `roomVisibleTo()` の
  「root か、`me.shops` の文字列と `room.shop` が部分一致するか、明示メンバーか」で行う。
- **SalonOne からの membership 同期は存在しない**（異動・退職に追従する仕組みは無い）。
- `chatStoreStaff(storeName)` は @メンション候補の算出にのみ使われ、
  「プロフィールの担当店舗（手入力・優先）→ SalonOne `shop_id` 一致」の順で在籍者を出す。
  **この判定ロジックは店舗メンバー解決の実装として再利用できる。**

### 4.4 評価
| 要素 | 状態 | 方針 |
|---|---|---|
| 自動生成のトリガ | ✅ ある | **そのまま使う** |
| 冪等性 | ✅ ある（`byId` で重複防止） | そのまま |
| Room ID | ⚠️ 店舗名が主キー | **`storeId` フィールドを後付け**（ID は変えない＝過去ログを守る） |
| membership | ❌ 無い（名前一致で代用） | **追加**（`members` は空のままでも動くよう、可視判定は storeId → 名前の順にフォールバック） |
| 店舗名変更 | ❌ 別ルームが増える | `storeId` 後付け後は同一ルームを維持できる |

---

## 5. 既存の Event Room 自動生成ロジック（延長して使う）

`index.html` L4317〜「勉強会・イベント: グループチャット連携」

| 関数 | 処理 |
|---|---|
| `evSaveChat(section,row,secTitle)` | 行から `chatTitle`/`date`/`ownerId` を読み、**`kind:'group'`・`icon:'📅'`** のルームを作成。members = `[作成者, 責任者]`。作成後 **行の `cells.roomId` に room.id を保存**（`evUpsertRow`）。既存 roomId があれば `setRoom`（名前更新）＋`setMembers`（メンバー統合）で**更新**する |
| `evJoinChat(roomId)` | 参加者本人が「グループチャットへ参加」→ `action:'join'`（自分を members に追加＋システムメッセージ）→ チャットタブへ遷移 |
| `evUsers` | 責任者候補＝管理者＋SalonOneロスター＋共有dir＋本部(orgHq) |

### 評価
| 要素 | 状態 | 方針 |
|---|---|---|
| イベント→Room 自動生成 | ✅ ある | **そのまま使う**（作り直さない） |
| Room と行の紐付け | ✅ `cells.roomId` | そのまま（**これが実質の event_id 紐付け**） |
| 参加者の招待 | ✅ 責任者は自動、参加者は self-join | そのまま。将来「参加者確定→一括招待」を**同じ `setMembers` で**追加 |
| kind | `group`（`event` ではない） | **`kind` は変えない**（既存ルームが消える/見えなくなるため）。代わりに `eventId`/`section` を**任意フィールドで後付け** |
| 終了後の扱い | ❌ 無い（`lib/events.js: isPastEvent` でグレーアウトのみ） | `status:'archived'` を**追加**（既定は何もしない＝現状維持） |

---

## 6. 既存の Chat membership 同期

**存在しない。** 現状の membership は次の3経路のみ:

1. `createRoom` 時に指定した `members`（グループ作成・DM）
2. `setMembers`（グループのメンバー編集・イベントの責任者統合）
3. `join` / `leave`（本人操作）

加えて `remapUser`（root専用・重複アカウント統合時の付け替え）がある。
→ **SalonOne の異動・退職を反映する仕組みは無い。ここだけが純粋な新規追加ポイント。**

---

## 7. 再利用するもの / 追加するもの

### そのまま使う（再実装しない）
- ログイン2系統フォールバック（`settlement-auth` ＋ サロンワン `auth/login`）と `window.fetch` インターセプタ
- `lib/salonone-auth.js: verifySalonOneBearer()`（サーバー側の身元検証）
- 起動時の `/me` 再検証（権限変更の反映経路）
- `chatEnsureRooms` → `ensureRooms` → `ensureBaseRooms`（店舗ルーム自動生成）
- `evSaveChat` / `evJoinChat`（イベントのグループ自動生成・参加）
- `createRoom` / `setMembers` / `join` / `leave` / `send` / `read` / `react` の各アクション
- `chatStoreStaff()` の在籍判定（プロフィール手入力優先 → SalonOne `shop_id`）
- `dir.staff` 全社名簿（Recipient Resolver の入力に流用できる）

### 追加するもの（最小限）
| # | 追加 | 影響範囲 |
|---|---|---|
| 1 | `authStateFromSo` で `accessible_shops[].id` を取り込み `storeIds` として保持 | `index.html` 数行 |
| 2 | `lib/actor.js` — SalonOne 認証結果 → 共通 actor（`user_id`/`staff_id`/`tenant_id`/`role`/`accessible_store_ids`/`source`/`verified`） | 新規 |
| 3 | `lib/authz.js` — Dashboard 共通認可（ロール・店舗スコープ・root/HQ Override・Rollout 判定） | 新規 |
| 4 | `lib/chat-policy.js` — Chat 固有ポリシーのみ（canViewRoom/canPostRoom/…/filterRecipients） | 新規（`chat-authz.js` から改名・分割） |
| 5 | Rollout フラグ（KV `naoru:chat:rollout`）＋サーバー側の強制 | `api/plan-store.js` |
| 6 | `ensureBaseRooms` に `storeId` の後付け（既存ルームは ID を変えない） | `lib/chat.js` 追記 |
| 7 | SalonOne 由来の membership 同期（差分を返す純粋関数） | 新規（Phase 2） |

### やらないこと
- ❌ チャット専用のログイン / ユーザー管理基盤
- ❌ Store Room / Event Room の別ロジックでの再実装
- ❌ 既存 Room ID の変更・既存 Room の作り直し・既存メッセージの削除
- ❌ 通常ユーザーの店舗権限を Dashboard 側で二重管理すること（root/HQ の Override のみ例外）

---

## 8. 権限解決の優先順位（要件3の実装方針）

```
1. root / HQ の Dashboard Override   … accountmeta(KV) に保存。アクセス店舗・管理対象・Chat権限
2. SalonOne の正式 Permission        … /me の role + accessible_shops[].id（Bearer 検証済みのみ）
3. それ以外                          … DENY
```

- 「それ以外」＝ **身元が検証できないセッション**（GAS オーナーPASSのみのアカウント、ヘッダ無しの旧クライアント）。
  → チャットについては **DENY**（閲覧も不可）。返金明細書など既存機能の認可は従来どおり（この変更は Chat のみ）。
- ⚠️ 現在 `api/plan-store` は他の type（board / events / thanksgift 等）でサーバー認証を持たない。
  今回の変更は **`?type=chat` のみ**に適用し、他の type の挙動は変えない（段階導入）。

---

## 9. 本番ロールアウト（要件7）

```jsonc
// KV: naoru:chat:rollout（再デプロイ不要で変更可能）
{ "root": true, "hq": true, "owner": false, "manager": false, "staff": false,
  "features": { "recipientPreview": false, "aiMention": false, "schedule": false,
                "unreadResend": false, "smartGroup": false } }
```
- サーバー（`?type=chat`）は **GET / POST の両方**でこのフラグを評価し、
  許可されていないロールには **403 `chat_rollout_disabled`** を返す（UI で隠すだけにしない）。
- 既定値（KV 未設定時）も `root:true / hq:true / 他 false`。**設定ミスで公開されることがない向き**に倒す。
- 変更は root の UI（または KV 直編集）から。**再デプロイ不要。**
