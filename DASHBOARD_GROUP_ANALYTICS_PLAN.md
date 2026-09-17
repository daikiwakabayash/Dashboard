# Group Analytics 設計（DASHBOARD_GROUP_ANALYTICS_PLAN）

作成日: 2026-09-17 / ブランチ: `feature/cc-foundation` / 状態: **設計。本番未反映**
関連: `INTEGRATION_PLAN.md`（全体方針）／`MARKETING_DASHBOARD_PLAN.md`／`KPI_UI_SPEC.md`／`SALONONE_API_CONTRACT.md`／`REPORT_GENERATOR_UI.md`／`AUTHORIZATION_PLAN.md`

> **本書は方針転換を含む。** 以前の設計では Dashboard 側で KPI を計算する前提だったが、
> 今後は **naoru-ai-platform の Group Data Platform が計算し、Dashboard は表示・操作・承認に徹する**。
> 既存ドキュメントの該当箇所は本書で上書きする（各文書の冒頭に改訂注記を付けた）。

---

## 1. 役割分担の確定

```
  SalonOne                      naoru-ai-platform                 NAORU Dashboard
  （業務の正本）          →     （Group Data Platform）      →    （表示・操作・承認UI）
  ┌──────────────────┐         ┌──────────────────────┐        ┌────────────────────┐
  │ 顧客             │         │ 100〜200店舗を横断統合 │        │ 画面・フィルタ      │
  │ 予約 / 来店 / 購入│  ───→   │ 指標の計算（唯一の場所）│ ───→  │ 承認センター        │
  │ tracking link    │         │ 品質判定・突合         │        │ Agent Activity     │
  │ 広告費（全媒体）  │         │ AI分析                │        │ 資料生成            │
  │ Meta広告データ    │         │ Metric / Analytics API │        │ （計算はしない）    │
  │ Square 顧客/決済  │         └──────────────────────┘        └────────────────────┘
  └──────────────────┘
        ↑ Meta Marketing API / Square API を SalonOne が直接接続（今後）
```

| 層 | 責務 | 責務でないもの |
|---|---|---|
| **SalonOne** | 業務データの正本。Meta / Square との接続もここが持つ | 100店舗横断の集計 |
| **naoru-ai-platform** | 横断統合・**指標の計算**・品質判定・AI分析 | 画面 |
| **Metric / Analytics API** | Dashboard への**唯一の入口** | — |
| **Dashboard** | 表示・絞り込み・ドリルダウン・**承認**・資料生成 | **KPIの計算** |

### 1-1. 「Dashboard は計算しない」を実際に守る方法

問題: Dashboard には既に指標計算が入っている（`lib/cohort.js` 172行、`plan-calc.js` 82行、`soflmap.js` 144行 ほか計726行）。
一方 Platform は ROADMAP の Phase 0（未構築）。**数ヶ月は Dashboard が計算し続けるしかない。**

解決: **先に契約（Metric API）を決め、同じ契約を満たす「ローカル実装」を挟む。**

```
画面（1度だけ書く）
   │  metricsClient.fetch({ scope, period, metrics, breakdown })   ← 契約は常に同じ
   ├──────────────── cc_source='local' ─────→  ローカルアダプタ
   │                                            （既存 lib/ を呼ぶだけ・新規計算は書かない）
   └──────────────── cc_source='platform' ──→  Platform の Metric API
```

これで **Platform が来ても画面を書き直さない**。切替はKVフラグ1つ。

**運用ルール（これを破らない）**

| ルール | 意味 |
|---|---|
| **新しい指標の計算を Dashboard に書かない** | MRR / ARR / Churn / Expected LTV / CAC Payback は **最初から Platform 側**。ローカルアダプタは「未取得」を返す |
| 既存の `lib/*.js` は**凍結**する | バグ修正のみ。新しい指標・新しい軸を足さない |
| ローカルアダプタは**既存関数を呼ぶだけ** | アダプタ内で新しい計算式を書かない |
| 指標定義の正は **Platform の `metric_definitions`** | Dashboard は `definition.version` を表示するだけ |

---

## 2. Data Contract（Metric / Analytics API）

Dashboard が叩くのは **`/api/cc?fn=metrics`（サーバー側プロキシ）だけ**。
SalonOne / Square / Meta へ個別に問い合わせる新規コードは書かない。

### 2-1. リクエスト

```jsonc
{
  "scope": {
    "level": "group",                  // group | country | area | shop | channel | campaign | creative
    "ids": [],                         // 空 = その階層の全件
    "country": "jp",                   // jp | au | my | all
    "channelGroup": "all"              // all | meta | google | hotpepper | flyer | other
  },
  "period":  { "from": "2026-08-01", "to": "2026-08-31" },
  "compare": ["prev_month", "prev_year"],
  "metrics": ["revenue", "ad_spend", "cac", "ltv_expected", "ltv_cac"],
  "breakdown": "shop",                 // null | shop | country | area | channel | campaign | creative | month
  "limit": 200, "cursor": null,
  "sort": { "key": "ltv_cac", "dir": "asc" }
}
```

### 2-2. レスポンス（**1指標ごとに出所・鮮度・品質を必ず持つ**）

```jsonc
{
  "status": "ok",
  "scope": { … }, "period": { … },
  "metrics": {
    "ad_spend": {
      "value": 1940000, "unit": "JPY", "display": "¥1,940,000",
      "compare": {
        "prev_month": { "value": 1793000, "delta_rate": 0.082 },
        "prev_year":  { "value": 1420000, "delta_rate": 0.366 }
      },
      "source": "SalonOne",                          // ← 画面に必ず出す
      "updated_at": "2026-09-18T01:00:00+09:00",     // ← 画面に必ず出す
      "quality": "VERIFIED",                         // ← 画面に必ず出す
      "definition": { "code": "ad_spend", "version": 3, "formula": "Σ by-channel.ad_spend" },
      "reconciliation": {                            // 差異があるときだけ
        "status": "WARNING",
        "left":  { "source": "SalonOne", "value": 1000000 },
        "right": { "source": "Meta",     "value": 985000  },
        "diff": 15000, "diff_rate": 0.015, "tolerance": 0.05
      }
    },
    "cac_payback": { "value": null, "quality": "MISSING", "missing_reason": "粗利率が未設定" }
  },
  "rows": [                                          // breakdown 指定時
    { "key": "shop:11", "label": "サンプルA院",
      "metrics": { "ad_spend": { "value": 420000, "quality": "VERIFIED" }, "ltv_cac": { "value": 2.1, "quality": "ESTIMATED" } } }
  ],
  "paging":  { "has_more": true, "next_cursor": "…" },
  "freshness": { "salonone": "…", "square": "…", "meta": "…", "platform": "…" },
  "missing": ["cac_payback: 粗利率が未設定"],
  "definitions_version": "2026-09-01"
}
```

**規則**

- `value: null` ＋ `quality: "MISSING"` で「計算できない」を表す。**0 で埋めない**
- `quality` は `VERIFIED / PROVISIONAL / PARTIAL / ESTIMATED / STALE / WARNING / MISSING`（`KPI_UI_SPEC.md` §4）
- Dashboard は `display` があればそれを出す（丸め・通貨の判断も Platform 側に寄せる）
- Platform が落ちたら `status: "degraded"` ＋ 取得できた分だけ返す。**画面は残りを「未取得」で描く**

### 2-3. 認可

`/api/cc?fn=metrics` は `AUTHORIZATION_PLAN.md` の `actor` で店舗スコープを強制し、
Platform 側でも再検証する（二重チェック）。Platform のトークンはサーバー側に隠蔽し、フロントに出さない。

---

## 3. 指標一覧（20）と計算の持ち主

| # | 指標 | 主なデータ源 | 計算 | 備考 |
|---|---|---|---|---|
| 1 | **Revenue** | Square（＋SalonOne） | Platform | 売上 |
| 2 | **Ad Spend** | **SalonOne** | Platform | **全媒体の正式値。Meta APIの金額は使わない** |
| 3 | **Reservations** | SalonOne | Platform | 受付日コホート |
| 4 | **Visits** | SalonOne | Platform | 初回来店 |
| 5 | **Purchases** | SalonOne | Platform | 入会 |
| 6 | **CPA** | 2 ÷ 3 | Platform | 予約単価 |
| 7 | **CPO** | 2 ÷ 5 | Platform | 購入単価 |
| 8 | **CAC** | (2＋獲得関連費) ÷ 5 | Platform | 費目は要確定（§13-1） |
| 9 | **CVR** | 4÷3、5÷4、5÷3 | Platform | 3種を返す |
| 10 | **ARPU** | Square | Platform | |
| 11 | **Actual LTV** | Square＋SalonOne | Platform | **実績のみ** |
| 12 | **Expected LTV** | Square＋SalonOne | **Platform のみ** | Dashboardでは算出しない |
| 13 | **LTV/CAC** | 12 ÷ 8 | Platform | **Group View の主指標**（§9） |
| 14 | **CAC Payback** | 8 ÷ 月次粗利ARPU | **Platform のみ** | 粗利率未取得なら MISSING |
| 15 | **Retention** | Square＋SalonOne | Platform | 継続率カーブ |
| 16 | **Churn** | Square | Platform | 離反率 |
| 17 | **MRR** | **Square（サブスク）** | **Platform のみ** | 新規 |
| 18 | **ARR** | 17 × 12 | **Platform のみ** | 新規 |
| 19 | **ROAS** | 1 ÷ 2 | Platform | |
| 20 | **Impressions / Clicks / CTR / CPC / CPM / Frequency** | **Meta（SalonOne経由）** | Platform | **Meta のときだけ** |

> 12 / 14 / 17 / 18 は **Dashboard に実装しない**。ローカルアダプタは `MISSING` を返し、
> 画面には「Platform 接続後に表示されます」と出す。**ここが「重複を作らない」の具体的な線引き。**

---

## 4. 切替軸（scope）

| 軸 | 値 | 現状 | Platform後 |
|---|---|---|---|
| 全社 | group | ✅ | ✅ |
| 国内 / 海外 | jp / au / my | ✅（`lib/country.js`） | Platform が保持 |
| エリア | 都道府県・地域 | △（`lib/geo.js` の推定） | **Platform の正式なエリアマスタ** |
| 店舗 | shop_id | ✅ | ✅ |
| 媒体 | channel_group | ❌ | ✅ |
| **Campaign** | campaign_id | ❌ | ✅（Meta のみ） |
| **Creative** | creative_id | ❌ | ✅ |
| 期間 | from / to ＋ 前月比 / 前年比 | ✅ | ✅ |

⚠️ 現在のエリア判定は**店舗名から都道府県を推定**しており、辞書にない店舗は「その他」になる。
100〜200店舗では破綻するため、**Platform 側に正式な店舗マスタ（エリア・国・開店日）を持つ**こと。

---

## 5. Customer Journey / Attribution 画面

```
Creative → Tracking Link → Reservation → Visit → Purchase → Square Payment → LTV
```

### 5-1. 画面構成

- 上段: ファネル（各段の件数・通過率・離脱数）。段をクリックで該当一覧へ
- 中段: 経路別の内訳（Creative × Tracking Link の組み合わせ上位）
- 下段: 時間軸（受付 → 来店までのリードタイム分布、購入までの日数）

### 5-2. 個人情報の扱い（必要最小限）

| 段階 | 既定の表示 | 詳細表示（権限つき） |
|---|---|---|
| 集計・ファネル | **件数のみ。個人は出さない** | — |
| 一覧 | `顧客ID下4桁` ＋ 店舗 ＋ 受付日 ＋ 媒体 ＋ 状態 | 氏名は **root / admin のみ**、かつ**クリックで1件ずつ開く** |
| 金額 | LTV は**帯**で表示（〜3万 / 3〜10万 / 10万〜） | 実額は root / admin のみ |
| エクスポート | **既定で不可** | 承認センター経由（`kind: 'customer_export'`） |

- 氏名・連絡先を**一覧に並べない**（画面キャプチャ1枚で名簿にならないように）
- 個人を開いた操作は**監査ログに残す**（`entity: 'customer'`, `action: 'view'`）
- 施術・健康に関する情報は**この画面では扱わない**

---

## 6. Creative Library（マルチチャネル）

**Meta 専用にしない。** チャネル切替を前提にする。

```
[ ALL ] [ META ] [ FLYER ] [ HOTPEPPER ] [ GOOGLE ] [ OTHER ]
```

### 6-1. 全チャネル共通の指標

Spend ／ Reservation ／ Visit ／ Purchase ／ CPA ／ CPO ／ CAC ／ CVR ／ Revenue ／ ARPU ／ LTV ／ LTV/CAC ／ ROAS

### 6-2. META のときだけ追加

Impressions ／ Clicks ／ CTR ／ CPC ／ CPM ／ Frequency

→ **Meta 以外を選ぶとこの列は消える**（空欄や 0 を出さない）。
→ チラシ・ホットペッパーは「クリエイティブ＝紙面 / 掲載枠」として同じ器で扱う。

### 6-3. 「クリエイティブ」の定義がチャネルで違う点

| チャネル | 何を1件とするか | 画像/動画 | 配信期間 |
|---|---|---|---|
| META | Ad（広告） | あり | あり |
| GOOGLE | 広告グループ / アセット | 一部 | あり |
| HOTPEPPER | 掲載クーポン・枠 | あり | あり |
| FLYER | 配布した紙面・エリア | あり（画像） | 配布日 |
| OTHER | tracking link 単位 | なし | — |

→ **共通キーは `tracking_link_id`**（§7）。これがあれば全チャネルを同じ表に並べられる。

---

## 7. Tracking Link（Attribution の主キー）

### 7-1. 位置づけ

```
Creative ──(1..n)── Tracking Link ──(1..n)── Reservation ── Visit ── Purchase ── Payment ── LTV
```

`tracking_link_id` を **広告アトリビューションの主キー**として画面に出す。

### 7-2. 現状との差分（重要）

現在のコードは **`forced_link_id`（強制リンク）** を使っている
（`lib/soflmap.js` が `appointments` から顧客へ帰属させる仕組み）。
SalonOne 側が `tracking_link_id` を正式に持つなら、**用語とキーを揃える必要がある**。

| 確認したいこと | なぜ |
|---|---|
| `tracking_link_id` は `forced_link_id` の後継か、別物か | 既存の施策リンク別集計をそのまま移行できるか決まる |
| 既存データの `forced_link_id` は引き継がれるか | 過去分の比較ができるか決まる |
| 1予約に複数の link が付くことはあるか | 帰属ルール（最古を採用）を変えるか決まる |

→ **これが決まるまで `lib/soflmap.js` は凍結**（現行の挙動を維持。新機能は足さない）。

### 7-3. Creative Detail からのドリルダウン

```
Creative
  └ Tracking Link（複数）
       ├ 予約数     → 一覧へ
       ├ 来店       → 一覧へ
       ├ 購入       → 一覧へ
       ├ 売上
       └ LTV（実績 / 予測）
```

各段で `source / updated_at / quality` を表示する（§8）。

---

## 8. Data Quality の表示

すべての指標に **Source / Last Updated / Quality Status** を出す（`KPI_UI_SPEC.md` §1 の共通カード）。

```
広告費
¥1,940,000
─────────────────
Source   SalonOne
Updated  01:00
Quality  ● VERIFIED
```

差異があるとき:

```
広告費
¥1,000,000
─────────────────
⚠ WARNING  広告費データ差異あり
SalonOne  ¥1,000,000
Meta      ¥985,000
Difference 1.5%
─────────────────
表示は SalonOne の値です（正式値）。Meta の値で上書きはしません。
```

- 許容差（既定 5%）を超えたら `WARNING` ＋ アラート起票（`dedupeKey = ad_spend_mismatch|<店舗>|<年月>`）
- 突合の結果は **Platform が `reconciliation` として返す**。Dashboard は描くだけ

---

## 9. Group View（100〜200店舗）

### 9-1. 一目で分かるようにするための構成

| ブロック | 中身 |
|---|---|
| **異常店舗** | 閾値超過・急悪化。**最優先で上に置く** |
| **改善店舗** | 前月比で最も良くなった店舗（横展開の材料） |
| **上位店舗** | LTV/CAC 上位 |
| **店舗ランキング** | 指標を選んで並べ替え。ヒートマップ列つき |
| **媒体比較** | channel_group 横並び |
| **Creative比較** | 全チャネル横断の上位 |

### 9-2. 200店舗を扱うためのUI要件

| 要件 | 対応 |
|---|---|
| 一覧の描画 | **仮想スクロール**（200行を一度に描かない） |
| 並び替え・絞り込み | **サーバー側**（`sort` / `cursor` を API に渡す）。クライアントで全件ソートしない |
| 一覧の既定 | **全件ではなく「要対応」＋「上位/下位10」** |
| 比較の見せ方 | 数値の羅列ではなく**ヒートマップ**＋中央値からの乖離 |
| 店舗の探し方 | 名前検索＋エリア絞り込みを常設 |

### 9-3. AI Insights の優先順位（変更点）

**「CPAが悪い店舗」より「LTV/CACが悪い店舗」を優先して出す。**

理由: CPA が高くても LTV が高ければ健全。CPA だけを見ると、
**優良顧客を連れてくる媒体を止めてしまう**。

```
優先度1  LTV/CAC < 1.0        赤字で顧客を獲得している
優先度2  LTV/CAC < 3.0 かつ悪化中
優先度3  CAC Payback が長期化
優先度4  Churn 急増 / Retention 低下
優先度5  CPA 閾値超過          ← 従来これだけだった
```

---

## 10. AI Agent 連携

| Agent | 担当 | 出す提案の例 |
|---|---|---|
| **Marketing Analyst** | 媒体・Creative の効率 | 媒体配分の見直し |
| **Store Risk Agent** | 店舗の異常 | 危険店舗の特定と要因 |
| **Meta Ads Operator** | Meta の運用 | 予算変更・停止・Creative差し替え |
| **Creative Agent** | クリエイティブ | 疲弊検知・差し替え候補 |
| **Finance Analyst** | 採算 | LTV/CAC・Payback の悪化要因 |

### 10-1. 表示の契約（5項目を必ず出す）

```jsonc
{
  "recommendation": "恵比寿院の Meta 日予算を ¥12,000 → ¥8,000 に減額",
  "reason": "LTV/CAC が 1.8（全社中央値 3.4）。CACが3ヶ月連続で悪化",
  "expected_impact": { "metric": "ltv_cac", "from": 1.8, "to": 2.4, "basis": "過去の類似3件の平均" },
  "confidence": "medium",
  "data_source": ["Platform metrics v2026-09-01", "SalonOne 2026-09-18 01:00", "Square 2026-09-18 02:00"]
}
```

- **数値は Platform の確定 Metric**。AI に計算させない
- `expected_impact` は**推定であり保証ではない**と画面に明記
- 実行が要るものは **承認センターへ送る**（`kind` は `approvals.js` の表に対応）
- 実行の記録は **Agent Activity** に残る

---

## 11. 資料生成

`REPORT_GENERATOR_UI.md` の Report Snapshot に **Campaign / Creative を追加**する。

```jsonc
"scope": {
  "period": {...}, "shops": {...}, "region": "jp",
  "channels": { "mode": "selected", "groups": ["meta"] },
  "campaigns": { "mode": "selected", "ids": ["23851..."] },   // 追加
  "creatives": { "mode": "all", "ids": [] }                    // 追加
}
```

Slides に含める: KPI ／ グラフ ／ 店舗ランキング ／ **媒体比較** ／ **Creative比較** ／ AI分析 ／ 改善提案 ／ 注記。
**画面のフィルタ状態がそのまま資料の条件になる**（取り違え防止）。

---

## 12. Phase 表 — どの画面がいつ使えるようになるか

**凡例**: 🟢 使える ／ 🟡 一部（ローカルデータ・限定表示） ／ ⚪ 未 ／ 🔒 Platform 接続が前提

| 画面 | G0<br>安全基盤 | G1<br>データ保全 | G2<br>契約整備 | G3<br>Meta CC | G4<br>Group View | G5<br>Journey | G6<br>Platform |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| 承認センター | 🟡 | 🟢 | 🟢 | 🟢 | 🟢 | 🟢 | 🟢 |
| AI Agent Activity | 🟡 | 🟢 | 🟢 | 🟢 | 🟢 | 🟢 | 🟢 |
| Command Center フラグ / Kill Switch | 🟢 | 🟢 | 🟢 | 🟢 | 🟢 | 🟢 | 🟢 |
| 監査ログ閲覧 | ⚪ | 🟡 | 🟢 | 🟢 | 🟢 | 🟢 | 🟢 |
| Meta Overview | ⚪ | ⚪ | ⚪ | 🟡 | 🟡 | 🟡 | 🟢 |
| Meta Alert | ⚪ | ⚪ | ⚪ | 🟡 | 🟢 | 🟢 | 🟢 |
| AI Recommendation | ⚪ | ⚪ | ⚪ | 🟡 | 🟡 | 🟡 | 🟢 |
| Creative Library（ALL/媒体切替） | ⚪ | ⚪ | ⚪ | 🟡 | 🟡 | 🟡 | 🟢 |
| Autopilot Settings | ⚪ | ⚪ | ⚪ | 🟡 | 🟡 | 🟡 | 🟢 |
| Unit Economics（20指標） | ⚪ | ⚪ | 🟡 | 🟡 | 🟢 | 🟢 | 🟢 |
| Group View（店舗ランキング・異常店舗） | ⚪ | ⚪ | ⚪ | ⚪ | 🟢 | 🟢 | 🟢 |
| Customer Journey / Attribution | ⚪ | ⚪ | ⚪ | ⚪ | ⚪ | 🔒 | 🟢 |
| 資料生成 | ⚪ | ⚪ | ⚪ | ⚪ | 🟡 | 🟡 | 🟢 |

### 各 Phase の中身

| Phase | 内容 | 前提 | この Phase を終える条件 |
|---|---|---|---|
| **G0 安全基盤**<br>（**完了**） | フラグ・Kill Switch・監査ログ・承認センター・Agent Activity・認可設計 | なし | Preview で承認〜キルスイッチまで操作できる |
| **G1 データ保全**<br>（**次**） | 掲示板の既読分離、手当の保存方式、楽観ロック | G0 | 同時操作で入力が消えないことを確認 |
| **G2 契約整備** | `/api/cc?fn=metrics` の**契約を確定**し、ローカルアダプタを実装。`lib/*.js` を凍結 | G1 | ローカルとPlatformで**同じ契約**が満たせる |
| **G3 Meta Control Center** | Overview / Alert / Recommendation / Creative Library / Autopilot を**契約経由**で実装 | G2 | フラグOFFで既存と完全一致・ONで5画面が出る |
| **G4 Group View** | 店舗ランキング・異常店舗・媒体比較。仮想スクロール・サーバー側ソート | G2 | 200店舗で操作が重くならない |
| **G5 Customer Journey** | Creative→Link→予約→来店→購入→決済→LTV。個人情報は最小表示 | **G6の一部** | 個人情報の表示範囲を所有者が承認 |
| **G6 Platform 接続** | `cc_source='platform'` へ切替。MRR/ARR/Expected LTV/CAC Payback が初めて出る | **Platform 構築完了** | ローカルとPlatformの数値を突合し差異が説明できる |

**G2 が要**。ここで契約を決めておけば、G3〜G5 の画面は **Platform 接続時に書き直さずに済む**。

### 12-1. 「まだ出せないもの」を画面でどう見せるか

Platform 未接続のあいだ、MRR / ARR / Expected LTV / CAC Payback は値を出さない。

```
MRR
—
─────────────────
Quality  ● MISSING
Platform 接続後に表示されます
```

**0 や「計算中」と出さない。** 見えないことが正しい状態だと分かるようにする。

---

## 13. 未解決（人の判断が必要）

| # | 論点 | 誰に | これが決まらないと |
|---|---|---|---|
| 1 | **CAC に含める費目**（広告費のみ / 人件費・インセンティブ込み） | 経営・財務 | CAC・LTV/CAC・Payback が確定しない |
| 2 | 粗利率の取得元 | 財務 | CAC Payback が出せない |
| 3 | LTV/CAC の自社目標倍率（一般に 3.0x） | 経営 | Group View の危険判定の線が引けない |
| 4 | **`tracking_link_id` と `forced_link_id` の関係**（§7-2） | SalonOne / 技術 | 施策リンク別の移行可否 |
| 5 | Platform の Metric API の**実際の形**（本書は提案） | Platform / 技術 | G2 の契約確定 |
| 6 | 店舗マスタ（エリア・国・開店日）を Platform が持つか | Platform / 経営 | エリア軸が名前推定のままになる |
| 7 | Customer Journey の**個人情報の表示範囲**（§5-2 でよいか） | 情報管理・経営 | G5 に進めない |
| 8 | MRR / ARR の定義（サブスクのみか、回数券を含むか） | 財務 | 17・18 が確定しない |
| 9 | Meta / Square を SalonOne が接続する時期 | SalonOne / 経営 | G3・G6 の時期 |

---

## 14. 既存ドキュメントへの反映

| 文書 | 変更 |
|---|---|
| `MARKETING_DASHBOARD_PLAN.md` | §8 AI の役割・`lib/unitecon.js` 案を本書 §1-1 で上書き（Dashboardで計算しない） |
| `KPI_UI_SPEC.md` | 指標に MRR / ARR / Churn / Retention を追加。計算の持ち主を Platform に変更 |
| `REPORT_GENERATOR_UI.md` | Snapshot に Campaign / Creative を追加 |
| `INTEGRATION_PLAN.md` | §F の接続方式は有効。§G の境界に Group Data Platform を明記 |
| `SALONONE_API_CONTRACT.md` | **現行の直接接続の記録として維持**。G6 以降は Platform 経由へ移るが、SalonOne 自体の契約は変わらない |

**既存の直接接続（`/api/salonone` 等）は壊さない。** G6 で新しい画面を Platform に向けたあとも、
既存画面は当面そのまま動かし、**両方の数値が一致することを確認してから**順次切り替える。
