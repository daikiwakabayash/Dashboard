# SalonOne 分析API 契約書（SALONONE_API_CONTRACT）

作成日: 2026-09-17 / ブランチ: `feature/cc-foundation` / 状態: **現行実装の調査結果。接続は一切変更していない**
対象コード: `lib/salonone.js`（純粋ロジック）／`api/salonone.js`（プロキシ）／`lib/salonone-auth.js`（SSO検証）

> ⚠️ **本書にAPIキー・トークン・秘密の実値は一切含まれていません。**
> 記載しているのは「変数名」と「ヘッダ名」だけです。実値は Vercel の環境変数にのみ存在します。

---

## 1. Base URL

```
https://salonone.net/api/analytics/v1
```

- 定義場所: `lib/salonone.js` の `ANALYTICS_BASE`
- 上書き: 環境変数 `SALONONE_API_BASE`（任意。未設定なら上記）
- **ブランド単位でスコープ**される（キーを発行したブランドのデータのみ）

---

## 2. 使用Endpoint

`lib/salonone.js` の `ENDPOINTS` が**許可リスト**。ここにないリソースは `404 not_found` で上流に到達しない。

### 2-1. 集計系（`kind: 'summary'`）

| リソース | パス | 必須 | 任意 |
|---|---|---|---|
| `sales/summary` | `/sales/summary` | `from`, `to` | `shop_id`, `group_by` |
| `marketing/by-channel` | `/marketing/by-channel` | `from`, `to` | `shop_id` |
| `marketing/by-staff` | `/marketing/by-staff` | `from`, `to` | `shop_id` |
| `marketing/retention` | `/marketing/retention` | `from`, `to` | `shop_id` |
| `marketing/new-customers` | `/marketing/new-customers` | `from`, `to` | `shop_id`, `limit`, `cursor` |
| `marketing/by-forced-link` | `/marketing/by-forced-link` | `from`, `to` | `shop_id` |

### 2-2. 明細系（`kind: 'detail'`）— 共通で `limit` / `cursor` / `updated_since` / `shop_id`

`shops` ／ `staffs` ／ `menus` ／ `menu-categories` ／ `visit-sources` ／ `customer-tags` ／ `customers` ／ `appointments` ／ `appointment-menus`

### 2-3. メタ・認証系

| リソース | パス | Method | 用途 |
|---|---|---|---|
| `meta` | `/meta` | GET | 疎通確認（`?diagnostic=1`） |
| `me` | `/me` | GET | ログイン中ユーザーの役割・アクセス店舗 |
| `auth/login` | `/auth/login` | **POST** | SSO ログイン |
| `auth/refresh` | `/auth/refresh` | **POST** | アクセストークン更新 |
| `auth/logout` | `/auth/logout` | **POST** | ログアウト |

> ⚠️ `marketing/by-forced-link` はコード中コメントによると**上流が404を返すことがある**。
> 施策リンク単位の集計はこれに依存せず、`appointments` の `forced_link_id` から再構築している（§17）。

---

## 3. HTTP Method

| 対象 | Method | 備考 |
|---|---|---|
| データ取得すべて | **GET のみ** | 読み取り専用API |
| `auth/login` / `auth/refresh` / `auth/logout` | **POST** | ホワイトリストのみ許可 |
| それ以外の POST | **拒否** | `405 method_not_allowed`（**書き込み経路を持たない**） |

`auth/*` の POST 本文は `pickAuthBody()` で**許可フィールドのみ**に絞ってから転送する:

| リソース | 転送を許す本文フィールド |
|---|---|
| `auth/login` | `login_id`, `password`, `brand_code` |
| `auth/refresh` | `refresh_token` |
| `auth/logout` | （なし） |

---

## 4. 認証方式

**2階建て**になっている。

```
① ブランドキー（必須）   運営が発行。ブランド全体のデータにアクセスする
② ユーザートークン（任意） サロンワンのID/PASSでログインして得る。SSO用
```

| 種別 | 保管場所 | フロントから見えるか |
|---|---|---|
| ブランドキー | Vercel 環境変数 `SALONONE_API_KEY` | **見えない**（`/api/salonone` プロキシがサーバー側で付与） |
| アクセストークン | ブラウザ localStorage `naoru_so_at`（有効60分） | 見える（そのユーザー自身のもの） |
| リフレッシュトークン | ブラウザ localStorage `naoru_so_rt`（有効14日） | 同上 |

### 4-1. データ取得のフォールバック（重要）

```
① まずキーのみ（Bearerなし）で取得   → ブランド全体が返る
② user_auth_required が返った場合のみ、ユーザーのBearerを付けて再取得 → そのスタッフのスコープ
```

`/me` だけは常に Bearer を付ける。
→ **全店表示を維持するには `SALONONE_API_KEY` を「ログイン必須を解除」キーにする**必要がある。

---

## 5. 使用するHeader名

### 5-1. Dashboard → SalonOne（上流へ）

| ヘッダ名 | 値 | 備考 |
|---|---|---|
| `X-SalonOne-Api-Key` | `<SALONONE_API_KEY の値>` | **サーバー側でのみ付与。実値は本書に記載しない** |
| `Authorization` | `Bearer <アクセストークン>` | SSO時のみ。クライアントから透過 |
| `Accept` | `application/json` | |
| `Content-Type` | `application/json` | POST（auth/*）のみ |

### 5-2. ブラウザ → `/api/salonone`（プロキシへ）

| ヘッダ名 | 備考 |
|---|---|
| `Authorization` | `Bearer …`（SSOセッション時のみ。`window.fetch` のラッパが自動付与） |

### 5-3. `/api/salonone` → ブラウザ（レスポンス）

| ヘッダ名 | 意味 |
|---|---|
| `x-ratelimit-limit` / `x-ratelimit-remaining` / `retry-after` | 上流のレート制限情報を**そのまま透過** |
| `X-SO-Cache` | `HIT` / `MISS` / `STALE`（プロキシ側の短期キャッシュ） |
| `Cache-Control` | 集計系 `s-maxage=300` ／ 明細系 `s-maxage=60` ／ 認証系 `no-store` |

---

## 6. Request Parameters

| 名前 | 型 | 検証 | 備考 |
|---|---|---|---|
| `from` / `to` | `YYYY-MM-DD` | **厳密に検証**（実在する日付か。うるう年も判定） | 集計系で必須 |
| `shop_id` | 文字列 | そのまま転送 | 未指定＝ブランド全体 |
| `group_by` | `shop` のみ | **`shop` 以外は拒否** | 全店内訳を1リクエストで取る |
| `limit` | 整数 | `1 〜 1000`（`MAX_LIMIT`）。既定200 | 範囲外は `invalid_request` |
| `cursor` | 文字列 | そのまま転送 | ページング |
| `updated_since` | 文字列 | そのまま転送 | 明細系の差分取得 |

**許可リストにないパラメータは黙って捨てる**（上流へ余計な情報を送らない）。

---

## 7. Response Schema

共通の外側:

```jsonc
{
  "data": { … } または [ … ],    // 集計系はオブジェクト、明細系は配列
  "meta": {                       // 明細系・ページングのある集計系
    "has_more": true,
    "next_cursor": "…"
  }
}
```

エラー時（`api/salonone.js` が整形した形）:

```jsonc
{ "error": { "code": "invalid_request", "message": "…", "fields": ["from"] } }
```

---

## 8. 取得可能なField

### `sales/summary`

| Field | 意味 |
|---|---|
| `digest_sales` | **会計済み売上（入金ベース）**。Dashboard はこれを売上として採用 |
| `gross_sales` | 粗売上（予測を含む）。フォールバックのみ |
| `consumed_sales` | 消化売上 |
| `new_customer_sales` / `repeat_customer_sales` | 新規／リピート売上 |
| `new_visit_count` / `repeat_visit_count` | 新規／リピート来店数 |
| `cancel_count` / `no_show_count` | キャンセル／無断キャンセル |
| `period_utilization_rate` | 稼働率 |
| `by_day[]` | 日次内訳。`media_breakdown[]`（媒体×件数）・`payment_breakdown[]`（決済×金額・`is_sales`） |
| `by_staff[]` | スタッフ別（`gross` / `treatments`） |
| `amounts_jpy` | **円換算額**。`group_by=shop` の全店合計はこれを使う（トップレベルは店舗通貨のまま） |

### `shops`

`id` ／ `name` ／ `area_id` ／ `timezone` ／ `address`
→ **海外判定は `area_id` を最優先**（`900000341`=マレーシア／`900000342`=オーストラリア）、次に `timezone`、最後に住所・名前（`lib/country.js`）

---

## 9. 広告費関連Field 🔴 正式値

`marketing/by-channel` の各行:

| Field | 意味 | 用途 |
|---|---|---|
| **`ad_spend`** | **広告費（円）** | **全社・店舗別・媒体別の広告費の正式値**（`MARKETING_DASHBOARD_PLAN.md` §1） |
| `cpa` | 上流が算出したCPA | 参考。Dashboard は自前でも算出する |
| `roas` | 上流が算出したROAS | 同上 |
| `impressions` | 表示回数 | |
| `clicks` | クリック数 | |

> **Meta Marketing API の金額を広告費として表示しない。** Meta以外に HotPepper・チラシ等があるため、
> 全広告費の分母は SalonOne に一本化する。Meta API は CTR/CPC/CPM/Frequency と Campaign 階層の分解にのみ使う。

---

## 10. 媒体関連Field

| Field | 意味 |
|---|---|
| `visit_source_id` | 媒体ID |
| `name` | 媒体名（表記ゆれあり。`lib/channelgroup.js` で5グループへ正規化する予定） |
| `platform_type` | プラットフォーム種別 |

**「新規でない媒体」の除外規則**（既存コードの `isNonNew`）:
`既存` ／ `未設定` ／ 名前に `会員` を含む ／ `N分` のようなメニュー名 → マーケ集計から除外。

媒体マスタは `visit-sources` エンドポイントでも取得できる。

---

## 11. 予約関連Field

### `marketing/by-channel`（媒体別の集計）

`booking_count`（予約数）／ `cancel_count`（キャンセル）／ `remaining_count`（未来店）

### `marketing/new-customers`（1人1行）

| Field | 意味 |
|---|---|
| `received_at` | **受付日時**。コホートの起点（この日が期間内なら対象） |
| `reserved_at` | 予約日時 |
| `first_appointment_status` | 初回予約の状態（`completed` / `visited` / `cancelled` …） |
| `customer_id` | 顧客ID |
| `shop_id` | 店舗ID |
| `visit_source_name` | 媒体名 |

### `appointments`（明細）

`customer_id` ／ `forced_link_id`（施策リンク）／ `created_at` ／ `updated_at` ／ `cancelled_at` ／ `dismissed_at`

> ⚠️ **`dismissed_at`（予約取り消し）と `cancelled_at`（予約キャンセル）は別物。**
> `dismissed_at` はスタッフによるテスト/無効予約の取り消しで、**新規顧客コホートから完全除外**する
> （予約にもキャンセルにも数えない）。

---

## 12. 来店関連Field

| Field | 出所 | 意味 |
|---|---|---|
| `visit_count` | `by-channel` | 来店数 |
| `visited_completed` | `new-customers` | 初回来店したか |
| `first_appointment_status` | `new-customers` | `completed` / `visited` → 来店、`cancelled` → 実キャンセル |
| `new_visit_count` | `sales/summary` | 新規来店数 |

**3状態の区別（重要）**:

```
新規予約 = 来店 ＋ キャンセル ＋ 未来店
  来店      first_appointment_status ∈ {completed, visited}
  キャンセル first_appointment_status === 'cancelled'   ← 実キャンセルのみ
  未来店     残り（予約済みで来店日が未到来）＝まだ失敗ではない
```
→ **未来店をキャンセルに含めない**（過去にこの取り違えでキャンセル率が過大表示された経緯あり）。

---

## 13. 購入関連Field

| Field | 出所 | 意味 |
|---|---|---|
| `joined` | `new-customers` | 入会したか（**購入の判定はこれ**） |
| `join_count` | `by-channel` | 入会数。⚠️ **遡及して増える**ため月次推移には使わない |
| `join_in_period_count` | `by-channel` | 期間内の入会数（月次推移はこちら） |
| `join_rate` | `by-channel` | 入会率。⚠️ **分母が来店数なので100%を超えうる** |
| `ltv` | `new-customers` | その顧客のLTV |
| `purchase_count` / `purchase_amount` / `purchase_unit_price` | `by-staff` | 担当者別の購入 |
| `new_customer_sales_total` | `by-staff` | 新規顧客売上 |

媒体比較には `join_rate_by_booking`（分母＝予約数）を使う。

---

## 14. 店舗IDの紐付け方法

```
SalonOne shops.id ──┬─→ 各APIの shop_id パラメータ
                    ├─→ 画面の店舗フィルタ（soShopSel）
                    └─→ 店舗名 ──→ 他システムとの突合（名前ベース）
```

| 突合先 | 方法 | 注意 |
|---|---|---|
| Square | **店舗名**（`SQUARE_TOKENS` の `name`） | IDでの対応表はない。名前の表記ゆれに弱い |
| 返金明細書・手当 | **店舗名**（アカウントの管轄店舗は部分一致） | |
| 広告費の手入力 | **店舗名**（`spend[rk].__shops__[店舗名]`） | |
| 組織図・地域 | 店舗名 → 都道府県推定（`lib/geo.js`） | 辞書にない店舗は「その他」 |
| 国判定 | `area_id` → `timezone` → 住所/名前（`lib/country.js`） | `area_id` を最優先 |

**全店を1リクエストで取る**: `sales/summary?group_by=shop` が全店の内訳を返す（各行に `shop_id` / `gross_sales` / `new_visit_count` / `amounts_jpy`）。店舗ごとに叩かない＝レート制限回避。

> ⚠️ **店舗IDの正規の対応表が存在しない**のが構造的な弱点。名前の一致に依存している。
> `naoru-ai-platform/DATABASE.md` の `entity_mappings` に相当する対応表を将来持つべき。

---

## 15. Pagination

```
GET …?limit=200&cursor=<前回のnext_cursor>
  ↓
{ "data": [...], "meta": { "has_more": true, "next_cursor": "..." } }
```

| 項目 | 値 |
|---|---|
| `limit` | 既定 200／最大 **1000**（`MAX_LIMIT`） |
| 終端 | `meta.has_more === false` |
| `appointments` のカーソル形式 | `updated_at` 昇順（`{"u":"…","i":…}` の形） |

Dashboard 側のループ上限: 新規顧客一覧は最大30ページ／30,000件で打ち切り（無限ループ防止）。

---

## 16. Rate Limit

| 項目 | 値 |
|---|---|
| 制限 | **60 リクエスト/分** |
| ヘッダ | `x-ratelimit-limit` / `x-ratelimit-remaining` / `retry-after`（**そのまま透過**） |
| 超過時 | `429` |

**設計上の対策**:
- `group_by=shop` で全店を1リクエストにまとめる
- 確定した過去月は共有キャッシュ（`naoru:sb:<from_to>`）に保存し、2回目以降は取得ゼロ
- プロキシ側に短期キャッシュ（集計系300秒／明細系60秒）

---

## 17. Incremental Sync方法

| データ | 方式 |
|---|---|
| 明細系（`appointments` 等） | `updated_since` または `cursor`（`updated_at` 昇順） |
| 施策リンク対応表 | **カーソル保存方式**（`naoru:soflmap:v1`） |
| MEO口コミ | 日次cronでスナップショットを積む（`naoru:meo:v1`） |
| 確定過去月の売上 | 1度取ったら共有キャッシュへ凍結 |

### 施策リンク対応表の同期（`lib/soflmap.js`）

```
appointments を updated_at 昇順の cursor で取得
  → forced_link_id を持つ予約のうち created_at が最古のものを「獲得時の施策リンク」として顧客に帰属
  → 最後に前進できた next_cursor を保存し、次回そこから再開
  → has_more:false（末尾）でも最後の非null cursor を保持
     （新しい予約はその cursor 以降に現れるので、updated_since なしで差分が取れる）
```

- 手動1回: `?type=soflmap&action=sync`（時間バジェット45秒・最大40ページ）
- 日次: `?type=soflmap&action=cronsync`（`vercel.json` の cron・20:30 UTC）
- 全再スキャン: `action=sync&reset=1`

---

## 18. Error Response

### プロキシが返す形

```jsonc
{ "error": { "code": "…", "message": "…", "fields": ["from"] } }
```

| HTTP | code | 意味 |
|---|---|---|
| 400 | `invalid_request` | 必須欠け・日付不正・`limit` 範囲外・`group_by` 不正 |
| 404 | `not_found` | 許可リストにないリソース |
| 405 | `method_not_allowed` | データリソースへの POST など |
| 500 | （設定エラー） | `SALONONE_API_KEY` 未設定 |
| 502 | `upstream_error` | 上流への到達失敗・タイムアウト |
| 上流のまま | `user_auth_required` / `invalid_token` / `shop_forbidden` | 認証・スコープ関連 |

### 上流固有のコード

| code | 意味 | Dashboard の挙動 |
|---|---|---|
| `user_auth_required` | キーが「ログイン必須」設定 | ユーザーのBearerを付けて再取得 |
| `invalid_token` | アクセストークン期限切れ | `auth/refresh` で1回だけ更新して再試行 |
| `shop_forbidden` | そのユーザーの権限外の店舗 | エラー表示 |

---

## 19. Retry方針

### サーバー側（`api/salonone.js` の `fetchSalonOneResilient`）

```
429 を受けたら Retry-After を尊重して待ち、再試行する
  待ち時間 = min(Retry-After秒 + 0.5秒, maxWaitMs)
  時間バジェット（budgetMs）を超えるなら待たずに最後の結果を返す
  古いキャッシュがあれば待たずに STALE を返す（画面を止めない）
```

| 経路 | budgetMs | maxWaitMs |
|---|---|---|
| データ取得 | 55,000ms（キャッシュがあれば 0＝待たない） | 既定 |
| `/me` | 26,000ms（STALEがあれば 0） | 24,000ms |
| `auth/login` | 52,000ms | 50,000ms |
| `auth/logout` | 0（再試行しない） | — |

認証エラー（400/401/422）は**待たずに即返す**（待っても回復しないため）。

### クライアント側（`index.html`）

```
429 または 5xx → 700ms × 試行回数 で待って最大3回
失敗 → その店舗はスキップし、他の店舗の取得を続行（全体を止めない）
401(invalid_token) → auth/refresh で1回だけ更新して再試行
```

---

## 20. 現在Dashboardのどこで使用しているか

| 画面 / 機能 | 使用リソース |
|---|---|
| **全体管理シート**（`zenkanri`） | `sales/summary?group_by=shop`（全店1リクエスト） |
| **SalonOne売上**（`salonone`） | `sales/summary`（店舗別・スタッフ別・日報）、`shops`, `staffs` |
| **マーケティング**（`mktg`） | `marketing/new-customers`（受付日コホート・主軸）、`marketing/by-channel`（広告費・クリック）、`marketing/by-staff`、`appointments`（施策リンク） |
| **コホートLTV/継続**（`cohort`） | `marketing/new-customers`, `sales/summary` |
| **事業計画**（`planning`） | `sales/summary` |
| **組織図**（`org`） | `sales/summary` の `by_staff`（月別・売上>0のスタッフ） |
| **サンクスギフト**（`thanksgift`） | `sales/summary?shop_id=…` の `by_staff`（投票候補）、`shops` |
| **AIアシスタント / AIに質問** | `sales/summary` ＋ `marketing/by-channel`（今月・先月の店舗スナップショット） |
| **AIパトロール**（`patrol`） | 各店の `sales/summary` ＋ `marketing/by-channel` |
| **返金明細書**（`settlement`） | `sales/summary`（個人別 gross・生産性）、`staffs`（在籍セラピスト） |
| **手当・領収書**（`allowance`） | `staffs`（本人の紐付け） |
| **SSOログイン** | `auth/login` / `auth/refresh` / `auth/logout` / `me` |
| **返金明細書の認可** | `me`（`lib/salonone-auth.js` がサーバー側で検証） |
| **施策リンク同期**（cron） | `appointments`（差分同期） |
| **疎通確認** | `meta`（`/api/salonone?diagnostic=1`） |

---

## 21. fixture（実データを含まない検証用サンプル）

```
fixtures/salonone-api-sample.json
```

- **匿名化済み**。実在する顧客・スタッフ・金額ではない
- **APIキー・トークン・秘密を含まない**（`tests/fixtures.test.js` が機械的に検査）
- 個人名は `サンプル太郎` 等のダミー、顧客IDは `cust_0001` 等の連番
- 用途: レスポンス整形ロジック（`normalizeSalonSummary` / `normalizeMkChannels` 等）の検証、
  Marketing / KPI 画面を**上流に接続せずに**組み立てるための仮データ

---

## 22. この契約書で確認できなかったこと

| # | 項目 | なぜ |
|---|---|---|
| 1 | `by-forced-link` の正式なレスポンス形 | コード中コメントに「上流404」とあり、実レスポンスを確認できていない |
| 2 | `platform_type` の取り得る値 | コードは値を判定に使っていない |
| 3 | `first_appointment_status` の全種類 | `completed` / `visited` / `cancelled` 以外の値があるか未確認 |
| 4 | `area_id` の全マッピング | 海外2件（馬来/豪州）のみコードに存在 |
| 5 | レート制限の単位（ブランド単位かキー単位か） | ドキュメント未確認 |
| 6 | `updated_since` の厳密な意味（境界を含むか） | 実装は cursor 方式を採用しているため未検証 |

→ Marketing / KPI 画面の実装前に、**①③⑤ は SalonOne 運営に確認したい**。
