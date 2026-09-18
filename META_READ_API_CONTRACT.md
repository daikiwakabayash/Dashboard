# META_READ_API_CONTRACT — Meta読取API 接続契約 v`meta-read-1`

**この契約の所在**: `daikiwakabayash/Dashboard` / `META_READ_API_CONTRACT.md`
**版**: `meta-read-1`（`api_version` フィールドで返すこと）
**提供**: ③ naoru-ai-platform ／ **利用**: ① Dashboard

> ⚠️ **読取専用。** この契約に書き込み系（予算変更・停止・再開・クリエイティブ差替）は含めません。
> Dashboard 側は今回、**広告変更を一切行いません**。

---

## 0. 役割分担（重要）

| | 担当 | 持つもの |
|---|---|---|
| ③ Platform | Meta Marketing API への接続・トークン管理・正規化 | **Metaのアクセストークン**（Dashboardには渡さない） |
| ① Dashboard | 表示のみ | ③のAPIを叩くサービスキー（サーバー側のみ） |

**Dashboard のブラウザに Meta トークンを渡してはいけません。** Dashboard の
サーバー（`/api/plan-store?type=meta`）が③のAPIを呼び、結果だけをブラウザへ返します。

---

## 1. エンドポイント

| | パス | 用途 |
|---|---|---|
| 接続状態 | `GET {BASE}/v1/meta/status` | 接続済みアカウント一覧・未接続理由 |
| 実績取得 | `GET {BASE}/v1/meta/overview` | 期間の実績（totals + Campaign/AdSet/Ad） |

`{BASE}` は Dashboard 側の環境変数 `META_READ_API_BASE` で指定（**①は設定しません。人が設定します**）。

### 認証

```
Authorization: Bearer <META_READ_API_KEY>
X-Tenant-Id: <tenant_id>
```
`META_READ_API_KEY` は Dashboard のサーバー側環境変数。**ブラウザに出しません。**

### リクエスト（`/v1/meta/overview`）

| パラメータ | 例 | 必須 | 説明 |
|---|---|---|---|
| `account_id` | `act_1234567890` | ✅ | Meta広告アカウント |
| `from` / `to` | `2026-09-10` / `2026-09-16` | ✅ | **完了済みの日**のみ（当日は含めない） |
| `level` | `campaign,adset,ad` | | 既定 `campaign,adset,ad` |
| `tenant_id` | `naoru` | ✅ | ヘッダと一致しなければ 403 |

---

## 2. レスポンス（成功）

```jsonc
{
  "api_version": "meta-read-1",
  "status": "ok",                       // ok | partial
  "tenant_id": "naoru",
  "generated_at": "2026-09-18T03:10:00+09:00",

  "account": {
    "id": "act_1234567890",
    "name": "NAORU 広告アカウント",
    "currency": "JPY",                  // 通貨は**必ず**返す（表示に使う）
    "timezone": "Asia/Tokyo",           // アカウントのタイムゾーン
    "status": "ACTIVE",
    "store_mapping": [                  // アカウント↔店舗の対応
      { "store_id": "11", "store_name": "サンプルA院", "confidence": "confirmed" }
      // confidence: confirmed | inferred | unmapped
    ]
  },

  "period": {
    "from": "2026-09-10", "to": "2026-09-16",
    "timezone": "Asia/Tokyo",
    "complete_days_only": true,         // 当日や未確定日を含めていないこと
    "excluded_today": true
  },

  "totals": { "spend": { … }, "impressions": { … }, "clicks": { … },
              "ctr": { … }, "cpc": { … }, "cpm": { … }, "results": { … } },

  "rows": [
    {
      "level": "campaign",              // campaign | adset | ad
      "id": "23851234567890123",
      "parent_id": null,                // adset は campaign の、ad は adset のID
      "name": "9月_恵比寿_リタゲ",
      "status": "ACTIVE",               // 設定上の状態
      "effective_status": "ACTIVE",     // 実際の配信状態（審査落ち等を含む）
      "metrics": { "spend": { … }, "impressions": { … }, … },
      "creative": {                     // 取れた場合だけ。取れなければ null
        "thumbnail_url": "https://…",   // ③が短命URLへ変換して返す
        "permission": "granted",        // granted | denied | unknown
        "type": "image"                 // image | video | carousel
      }
    }
  ],

  "freshness": {
    "last_success_at": "2026-09-18T03:00:00+09:00",   // 最終**成功**取得日時
    "last_attempt_at": "2026-09-18T03:05:00+09:00",
    "lag_minutes": 10
  },

  "errors": [                            // status:"partial" のとき、取れなかった範囲
    { "code": "CREATIVE_PERMISSION_DENIED", "message": "…", "scope": "creative" }
  ],

  "definitions": {                       // 指標の定義（画面に出す）
    "spend": { "code": "meta_spend", "version": 1, "formula": "Meta Insights.spend", "label": "Meta配信消化額" },
    "ctr":   { "code": "meta_ctr",   "version": 1, "formula": "clicks / impressions" },
    "results": { "code": "meta_results", "version": 1, "formula": "Meta の成果件数（最適化イベント）",
                 "note": "SalonOneの予約数とは別物。同じCPAとして扱わない" }
  }
}
```

### 2-1. 指標オブジェクトの形（**全指標で共通・例外なし**）

```jsonc
{
  "value": 123456,            // ★ 取れなければ **null**。0 にしない
  "unit": "JPY",              // JPY | count | ratio
  "display": "¥123,456",
  "quality": "VERIFIED",      // VERIFIED | ESTIMATED | MISSING | NOT_CONNECTED
  "source": "Meta",
  "missing_reason": null      // quality が MISSING/NOT_CONNECTED のとき必須
}
```

**絶対の規則**
- **未接続を `0` にしない。** `value: null` ＋ `quality: "NOT_CONNECTED"` ＋ `missing_reason`
- **欠損を `0` にしない。** `value: null` ＋ `quality: "MISSING"` ＋ `missing_reason`
- 定義が未確定の指標は**返さない**（推測値を混ぜない）

### 2-2. 成果指標（`results`）の扱い

`results` は **Meta の最適化イベント件数**です。**SalonOne の予約数とは別物**として返し、
Dashboard も別欄に表示します。両者を同じ CPA として扱いません。
定義が確認できるまで `results` は `quality: "MISSING"` で構いません。

---

## 3. レスポンス（エラー）

```jsonc
{
  "api_version": "meta-read-1",
  "status": "error",
  "error": {
    "code": "NOT_CONNECTED",
    "message": "この広告アカウントはまだ接続されていません",
    "retryable": false,
    "detail": {}
  }
}
```

| code | HTTP | 意味 | Dashboard の表示 |
|---|---|---|---|
| `NOT_CONNECTED` | 200 | 未接続 | 「未接続」＋理由。**0円と出さない** |
| `AUTH_FAILED` | 401 | サービスキー不正 | 「接続設定を確認してください」 |
| `TOKEN_EXPIRED` | 200 | Metaトークン失効 | 「Meta側の再認証が必要です」 |
| `RATE_LIMITED` | 429 | Meta側の上限 | 「取得制限中。最終成功取得日時を表示」 |
| `UPSTREAM_ERROR` | 502 | Meta側の障害 | 「取得できませんでした」＋最終成功日時 |
| `INVALID_REQUEST` | 400 | 引数不正 | 開発用（利用者には出さない） |
| `TENANT_MISMATCH` | 403 | テナント不一致 | 表示しない（拒否） |

**エラー時も、直前に成功した取得があれば `freshness.last_success_at` を返してください。**
利用者にとって「いつの数字か」が最重要です。

---

## 4. 版の管理

- `api_version` は**必ず**返す。Dashboard は `meta-read-1` 以外を受け取ったら表示せず警告する
- 破壊的変更は `meta-read-2` を新設し、両版を一定期間並走させる
- この契約の変更は **本ファイルのcommitで記録**し、双方が同じ版を参照する

| 版 | commit | 状態 |
|---|---|---|
| `meta-read-1` | 初版 | ③の実装待ち（**破壊的変更なし**・下の追記は後方互換） |

### meta-read-1 への追記（2026-09-18・後方互換）

既存の形は変えていないため**版は上げません**。③は以下を満たしてください。

| # | 追加要件 | 理由 |
|---|---|---|
| 1 | `tenant_id` は Dashboard が送った値と**必ず一致**させる。違えば `TENANT_MISMATCH` | Dashboard は不一致を検出したら表示しません |
| 2 | `account.id` / `period.from` / `period.to` も**要求と一致**させる | 不一致は `RESPONSE_MISMATCH` として表示しません（他社・他アカウントの数字を出さないため） |
| 3 | モック／サンプルを返すときは `mode: "mock"`（または `sample: true`）を**必ず付ける** | Dashboard は接続先がモックでも「サンプルデータ」と表示し続けます。**URLとキーが設定されていることを実データの根拠にしません** |
| 4 | `quality` は `VERIFIED` / `ESTIMATED` / `MISSING` / `NOT_CONNECTED` のみ | 知らない値は Dashboard 側で `ESTIMATED` へ落とします（確定値として見せません） |
| 5 | HTTP のステータスコードを正しく返す（401/403/429/5xx） | Dashboard は 2xx 以外を「接続成功」に昇格させません |
| 6 | `period` は**広告アカウントのタイムゾーン**の日付で返す | UTC基準だと日本のアカウントで1日ずれます |
| 7 | `account.currency` は JPY 以外もそのまま返す | Dashboard は勝手に円へ変換しません |
| 8 | 行が多い場合は `paging: { has_more, next_cursor }` を返す | Dashboard は上限で切った旨を画面に表示します |

**参照commit**: この契約の最新版は `META_READ_API_CONTRACT.md` の本コミットです（下の「双方の参照commit」を参照）。

---

## 5. Dashboard 側の接続状態（③が未提供でも動く）

`META_READ_API_BASE` が未設定のあいだ、Dashboard は **fixture**（`fixtures/meta-overview-sample.json`）で
画面を描画し、**「サンプルデータ」を常時表示**します。実データと取り違えないためです。

| `META_READ_API_BASE` | Dashboard の動き |
|---|---|
| 未設定 | fixture 表示＋「サンプルデータ」バッジ常時表示＋未接続理由 |
| 設定済み・③が応答 | 実データ表示 |
| 設定済み・③がエラー | エラーコードに応じた表示＋最終成功取得日時 |

環境変数の設定は**人が行います**（①は設定しません）。

---

## 6. ③へのお願い（実装時の確認事項）

1. `value: null` と `0` を**必ず区別**してください（0円表示が最も危険です）
2. `currency` / `timezone` は必ず返してください（円以外・時差ありの想定）
3. `period.complete_days_only: true` ＝ **当日を含めない**でください（途中の日は過少になります）
4. `creative.thumbnail_url` は**短命URL**にしてください。権限が無ければ `permission: "denied"` で null
5. `freshness.last_success_at` はエラー時も返してください
6. `results` の定義（どの最適化イベントか）が確定したら `definitions.results.note` に明記してください
