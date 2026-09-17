# CHAT_PERMISSION_MATRIX

社内チャットの権限モデル。**この表が `lib/chat-authz.js` の唯一の仕様**であり、
フロント（表示の出し分け）とサーバー（`api/plan-store.js?type=chat`）は同じ関数を通す。

---

## 1. ロール定義

| role | 日本語 | 由来 | スコープ |
|------|--------|------|----------|
| `root` | 管理者 | `DASHBOARD_PASSWORD` 共有ログイン / SalonOne `brand_admin` | テナント内すべて |
| `hq` | 本部 | オーナー設定で発行（個人名 + PASS） | テナント内すべて（= root 相当、表示名は本人名） |
| `owner` | オーナー | オーナー設定 / SalonOne `shop_admin` | 自分が管理する法人・店舗・その所属スタッフ |
| `manager` | 院長 / マネージャー | オーナー設定（新規） / SalonOne `shop_admin` で単店 | 自店舗 + 管理対象店舗 |
| `staff` | スタッフ | オーナー設定 / SalonOne `shop_staff` | 自店舗 + 参加 Group + 許可された DM |

- `manager` は**新規ロール**。既存アカウントは `owner` / `staff` のままで動作する（後方互換）。
- `hq` は既に `root` トークンへ昇格される実装があるため、authz 上は `root` と同じ capability を持ち、`role` は `hq` を保持する。
- **AI Agent** は擬似 actor `{ role: 'agent', actingFor: <人間の actor> }`。capability は常に `actingFor` の**部分集合**。

## 2. Capability 一覧

| capability | 意味 |
|------------|------|
| `chat.view` | チャットタブを開ける |
| `room.view` | 個別 Room を閲覧できる |
| `room.post` | 個別 Room に投稿できる |
| `room.create.group` | 自由 Group を作成できる |
| `room.create.dm` | DM を開始できる |
| `room.members.manage` | Room のメンバーを変更できる |
| `room.admin` | Room 名 / アイコン / ピン / 削除 |
| `broadcast.store` | 複数店舗 Room への一斉送信 |
| `broadcast.all` | 全社アナウンスへの送信 |
| `recipient.resolve` | 自然言語 Recipient Resolver を使える |
| `schedule.manage` | 予約 / 定期送信の作成・取消 |
| `audit.read` | 監査ログを閲覧できる |
| `ai.feedback` | AI 回答に 👍 / 👎 / 修正 を付けられる |
| `ai.escalate.receive` | AI のエスカレ先になる |

## 3. ロール × Capability

| capability | root | hq | owner | manager | staff | agent |
|------------|:----:|:--:|:-----:|:-------:|:-----:|:-----:|
| `chat.view` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `room.view` | 全 Room（DM 除く） | 全 Room（DM 除く） | 管轄内 | 管轄内 | 自店舗 + 参加 | actingFor と同一 |
| `room.post` | ✅ | ✅ | 管轄内 | 管轄内 | 閲覧可能な Room | ❌（送信は人間が実行） |
| `room.create.group` | ✅ | ✅ | ✅ | ✅ | ✅（メンバーは権限範囲内） | ❌ |
| `room.create.dm` | ✅ | ✅ | ✅ | ✅ | ✅（相手は権限範囲内） | ❌ |
| `room.members.manage` | ✅ | ✅ | 管轄内 | 管轄内 | 自分が作成した Group のみ | ❌ |
| `room.admin` | ✅ | ✅ | 管轄内 | 管轄内 | 自分が作成した Group のみ | ❌ |
| `broadcast.store` | ✅ | ✅ | 管轄店舗のみ | 管轄店舗のみ | ❌ | ❌ |
| `broadcast.all` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `recipient.resolve` | ✅ | ✅ | ✅ | ✅ | ✅（自分の範囲のみ） | — |
| `schedule.manage` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| `audit.read` | ✅ | ✅ | 自分の送信のみ | 自分の送信のみ | 自分の送信のみ | ❌ |
| `ai.feedback` | ✅ | ✅ | ✅ | ✅ | 👍👎のみ（修正は不可） | ❌ |
| `ai.escalate.receive` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |

> **DM は例外**: root / hq であっても、**自分がメンバーでない DM は閲覧できない**（プライバシー）。
> これは既存実装（`roomVisibleTo`）の挙動であり、変更しない。

## 4. Room 種別 × 可視・投稿ルール

| kind | 可視 | 投稿 |
|------|------|------|
| `announce`（全社アナウンス） | 全員 | `broadcast.all` を持つ者のみ（root / hq） |
| `store`（店舗） | root / hq、その店舗が `scopeStoreIds` に含まれる者、明示メンバー | 可視者すべて |
| `event`（イベント） | 参加者（members）+ root / hq | members |
| `group`（自由グループ） | members のみ | members |
| `dm` | members（2名）のみ。**root でも非メンバーは不可** | members |

## 5. スコープの表現

```js
actor = {
  tenantId: 'default',
  actorId: 'staff_123',        // staff_id（正）／root 共有ログインは '__root__'
  role: 'root'|'hq'|'owner'|'manager'|'staff'|'agent',
  storeIds: ['10293','10294'], // 権限のある store_id（正）
  shopNames: ['NAORU渋谷院'],   // 後方互換（store_id 未確定時のみ使う部分一致キー）
  verified: true,              // サーバーで検証済みの identity か
  actingFor: null,             // agent のときのみ
}
```

- **`storeIds` が正**。`shopNames` は SalonOne の store_id が未同期な移行期間のフォールバックであり、
  Phase 2 完了後は `storeIds` のみで判定する。
- `root` / `hq` は `storeIds` を無視して全店許可（`isTenantAdmin(actor) === true`）。

## 6. サーバー側 enforcement

`api/plan-store.js` の `?type=chat` は、すべての **write action** で以下を実行する:

```
1. resolveActorFromRequest(req)    → 検証済み actor（lib/chat-identity.js）
2. authorizeChatAction(actor, action, ctx) → { allow, reason }
3. allow=false かつ ENFORCE=strict → 403 { error: 'forbidden', reason }
   allow=false かつ ENFORCE=shadow → 実行はするが audit に violation を記録
```

### identity の検証優先順位
1. `Authorization: Bearer <SalonOne access_token>` → `verifySalonOneBearer()`（`lib/salonone-auth.js`）→ `verified: true`
2. `X-Chat-Auth: <settlement-auth token>` → オーナー / 本部トークン検証 → `verified: true`
3. いずれも無い → body の申告値を使い `verified: false`
   - `shadow`: 従来どおり動作（互換）
   - `strict`: `room.view` 以外の書き込みを拒否

### Kill Switch
`CHAT_KILL_SWITCH=1`（環境変数）または共有ストアの `naoru:chat:killswitch` が真のとき、
**すべての送信系 action を 503 で停止**する（閲覧は可能）。Resolver / 予約送信も停止対象。

## 7. マルチテナント

- actor の `tenantId` と対象レコードの `tenantId` が**一致しないものは存在しないものとして扱う**（404 ではなく不可視）。
- ストレージキーもテナントで分離（`t:<tenant_id>:chat:*`）。既定テナント `default` のみ旧キー `naoru:chat:*` を使用。
- クロステナントの `staff_id` 衝突を避けるため、内部 ID は `<tenant_id>:<staff_id>` で比較する関数を用意する
  （`sameActor(a, b)`）。表示・保存は従来どおり `staff_id` 単体。

## 8. テスト要件

`tests/chat-authz.test.js` で最低限カバーすること:
- 5 ロール × 主要 capability の allow/deny
- DM は root でも非メンバー不可
- staff が管轄外店舗の Room を見られない / 投稿できない
- agent は actingFor の部分集合しか持てない（超えようとしたら deny）
- 未検証 identity は strict で書き込み不可
- テナント違いは不可視
- Kill Switch で送信系が全停止
