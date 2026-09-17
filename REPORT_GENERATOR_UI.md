# 資料生成 UI / データ契約（REPORT_GENERATOR_UI）

作成日: 2026-09-17 / ブランチ: `feature/cc-foundation` / 状態: **設計**
関連: `MARKETING_DASHBOARD_PLAN.md`／`KPI_UI_SPEC.md`／`INTEGRATION_PLAN.md` §F（Platform接続）／`DASHBOARD_GROUP_ANALYTICS_PLAN.md`

> ⚠️ **改訂（2026-09-17）**: Report Snapshot の `scope` に **`campaigns` / `creatives` を追加**する
> （[DASHBOARD_GROUP_ANALYTICS_PLAN.md](DASHBOARD_GROUP_ANALYTICS_PLAN.md) §11）。
> スライド構成にも **媒体比較・Creative比較** を含める。数値は Platform の確定 Metric を固定して使う。

> 目的: 画面で見ている**そのままの条件**（期間・店舗・媒体）で、
> 会議に出せるレポートを1クリックで作る。**数字は画面と1円もずれない。**

---

## 1. 基本の考え方

| 原則 | 理由 |
|---|---|
| **画面のフィルタ状態がそのまま資料の条件になる** | 「どの期間のどの店の話か」の取り違えを構造的に防ぐ |
| **数値は生成時に固定（スナップショット）** | あとで元データが更新されても、配った資料と食い違わない |
| **新規ファイルとして作る。既存資料を上書きしない** | 誤って過去の報告書を壊さない |
| **出力（Google Slides への書き出し）は承認センター経由** | 外部への書き出しは人が承認してから |
| **AI考察は「事実／仮説／データ不足」を分けたまま載せる** | 仮説を事実として配らない |

---

## 2. 入口（ボタンの置き場所）

マーケティングタブのヘッダー右、既存の期間・店舗セレクタの隣に **`資料を作成`**。

```
[ 2026年8月 ▾ ] [ 全店（8） ▾ ] [ 媒体: すべて ▾ ]   [ 再取得 ] [ 📄 資料を作成 ]
```

- フラグ `cc_report`（既定OFF）。OFFなら**ボタン自体が出ない**
- 権限: root / hq / owner。staff には出さない
- データ品質が `Missing` を含む場合はボタン横に `⚠` を出す（作れるが注記が必須になる）

---

## 3. 作成モーダル（3ステップ）

### Step 1 — 条件の確認（変更不可・画面の状態を引き継ぐ）

```
┌─ 資料を作成 ───────────────────────── 1 / 3 ─┐
│                                               │
│ 対象期間   2026年8月（2026/08/01 – 08/31）     │
│ 店舗       全店（8店舗）                       │
│ 媒体       すべて（Meta / Google / HPB / …）   │
│ 比較       前月比・前年比                      │
│                                               │
│ ⚠ 山形天童院の広告費が未入力のため、           │
│   CPA・CAC・ROAS の集計から除外されます        │
│                                               │
│ データ品質  ● Partial                          │
│ 最終更新    SalonOne 09/17 05:30 / Square 06:00│
│                                               │
│                        [ キャンセル ] [ 次へ ] │
└───────────────────────────────────────────────┘
```

条件を変えたい場合は「戻って画面のフィルタを変える」。
**モーダル内で条件を変えられるようにしない**（画面と資料がずれる原因になる）。

### Step 2 — 載せる内容を選ぶ

チェックボックス。既定は全部ON。並び順はドラッグで変更可。

```
┌─ 資料を作成 ───────────────────────── 2 / 3 ─┐
│ ☑ 表紙（期間・店舗・作成者・作成日時）          │
│ ☑ サマリー（KPI 15指標・前月比・前年比）        │
│ ☑ グラフ                                       │
│     ☑ 広告費推移      ☑ CPA推移                │
│     ☑ CAC推移         ☑ LTV推移                │
│     ☑ LTV/CAC推移     ☐ ARPU推移               │
│     ☑ 媒体別広告費    ☑ 媒体別CPA              │
│     ☑ 広告費 vs 売上  ☐ CAC vs LTV 散布図      │
│     ☐ コホート残存率  ☑ Funnel                 │
│ ☑ 店舗ランキング（CPA / LTV）      上位 [10] 件 │
│ ☑ 媒体比較表                                   │
│ ☑ AI考察（事実 / 仮説 / データ不足）            │
│ ☑ 改善提案（AI・承認前の下書き）                │
│ ☑ 注記（データ源・品質・除外した店舗）  ← 外せない│
│                                               │
│                          [ 戻る ] [ 次へ ]     │
└───────────────────────────────────────────────┘
```

**「注記」は外せない**（データ源・品質・除外を必ず資料に残すため）。

### Step 3 — 出力先と承認

```
┌─ 資料を作成 ───────────────────────── 3 / 3 ─┐
│ タイトル  [ 2026年8月 マーケティング報告      ] │
│                                               │
│ 出力先                                         │
│  ◉ 画面で確認（ダウンロード可）  ← 承認不要      │
│  ○ Google Slides に新規作成      ← 承認が必要   │
│                                               │
│ ⚠ Google Slides への書き出しは、承認センターで  │
│   承認されてから実行されます。                  │
│   既存のスライドを上書きすることはありません。   │
│                                               │
│                      [ 戻る ] [ 作成する ]     │
└───────────────────────────────────────────────┘
```

| 出力先 | 承認 | 理由 |
|---|---|---|
| 画面で確認 / ダウンロード | **不要** | 社外に出ない。自分で見るだけ |
| Google Slides に新規作成 | **必要**（`kind: 'report_export'`） | 外部サービスへの書き出し＝`PERMISSIONS.md` の承認対象 |

---

## 4. データ契約（Report Snapshot）

「作成する」を押した時点で、**画面が持っている確定値をそのまま固めて**この形にする。
**この JSON が資料の唯一の入力**。Slides 側は再計算しない。

```jsonc
{
  "schemaVersion": "1.0",
  "reportId": "rep_20260917_a1b2c3",
  "title": "2026年8月 マーケティング報告",
  "createdAt": "2026-09-17T13:20:00Z",
  "createdBy": { "id": "u1", "name": "若林 大樹", "role": "hq" },

  // ── 条件（画面のフィルタをそのまま） ──
  "scope": {
    "period":  { "from": "2026-08-01", "to": "2026-08-31", "label": "2026年8月", "status": "confirmed" },
    "compare": { "prevMonth": { "from": "2026-07-01", "to": "2026-07-31" },
                 "prevYear":  { "from": "2025-08-01", "to": "2025-08-31" } },
    "shops":   { "mode": "all", "ids": ["1","2"], "names": ["恵比寿院","千葉駅院"], "excluded": ["山形天童院"] },
    "region":  "jp",
    "channels": { "mode": "all", "groups": ["Meta","Google","HotPepper","Flyer","Other"] }
  },

  // ── 出所と鮮度（KPI_UI_SPEC §4） ──
  "provenance": {
    "sources": {
      "salonOne": { "fetchedAt": "2026-09-17T05:30:00Z", "resources": ["marketing/by-channel","marketing/new-customers"] },
      "square":   { "fetchedAt": "2026-09-17T06:00:00Z" },
      "platform": { "fetchedAt": null, "connected": false }
    },
    "quality": { "overall": "Partial",
                 "reasons": ["山形天童院の広告費が未入力のため集計から除外",
                             "獲得関連人件費が未取得のため CAC は広告費のみ"] },
    "reconciliation": { "adSpendMismatch": false, "diffRate": 0.0121, "tolerance": 0.05 }
  },

  // ── KPI（値・比較・品質を1件ずつ持つ） ──
  "kpis": [
    { "key": "ad_spend", "label": "広告費", "value": 1940000, "unit": "JPY",
      "prevMonth": { "value": 1793000, "deltaRate": 0.082 },
      "prevYear":  { "value": 1420000, "deltaRate": 0.366 },
      "source": "SalonOne", "quality": "Verified",
      "formula": "Σ by-channel.ad_spend" },
    { "key": "cac", "label": "CAC（広告費のみ）", "value": 8050, "unit": "JPY",
      "prevMonth": { "value": 7210, "deltaRate": 0.117 }, "prevYear": null,
      "source": "SalonOne", "quality": "Partial",
      "formula": "広告費 1,940,000 ÷ 購入数 241",
      "note": "獲得関連の人件費は未取得" }
    // … 15指標
  ],

  // ── グラフ（描画に必要な値を全部持つ。再取得させない） ──
  "charts": [
    { "key": "ad_spend_trend", "type": "stacked_bar", "title": "広告費推移",
      "x": ["2026-03","2026-04","2026-05","2026-06","2026-07","2026-08"],
      "series": [ { "name": "Meta",   "data": [880000, 920000, 1010000, 1080000, 1150000, 1180000] },
                  { "name": "Google", "data": [310000, 300000, 330000, 340000, 360000, 380000] } ],
      "unit": "JPY", "source": "SalonOne", "quality": "Verified" },
    { "key": "funnel", "type": "funnel", "title": "新規→予約→来店→購入",
      "steps": [ { "name": "新規予約", "value": 586 }, { "name": "来店", "value": 405 }, { "name": "購入", "value": 241 } ],
      "dropouts": [ { "name": "キャンセル", "value": 118 }, { "name": "未来店", "value": 63 } ],
      "source": "SalonOne", "quality": "Verified" }
  ],

  "rankings": [
    { "key": "cpa_by_shop", "title": "店舗別CPA", "order": "asc", "limit": 10,
      "rows": [ { "name": "山形院", "value": 3191, "deltaRate": -0.04 } ], "unit": "JPY" }
  ],

  "channelComparison": {
    "columns": ["広告費","予約","来店","購入","CPA","CPO","CAC","来店CVR","入会CVR","ARPU","LTV","LTV/CAC","ROAS"],
    "rows": [ { "group": "Meta", "values": [1180000, 356, 246, 147, 3315, 8027, 8027, 0.691, 0.598, 24800, 58420, 7.28, 3.19] } ]
  },

  // ── AI考察（Platform の確定Metricに基づく説明。数値は作らせない） ──
  "aiInsights": {
    "generatedBy": { "agent": "Marketing Analyst", "runId": "run_x1", "model": "claude-sonnet-5" },
    "facts":       [ { "text": "全社CPAは前月比 +12.4%（¥4,262→¥4,790）", "citations": ["salonOne:by-channel:2026-08"] } ],
    "hypotheses":  [ { "text": "恵比寿院のクリエイティブ疲弊が全社CPAを押し上げた可能性", "confidence": "medium" } ],
    "missingData": [ "予約〜来店のリードタイムが未取得", "Meta の Frequency は Platform 未接続のため不明" ]
  },

  "recommendations": [
    { "title": "恵比寿院の日予算を ¥12,000 → ¥8,000 に減額",
      "rationale": "CPAが閾値を37.7%超過。来店率も全社平均以下",
      "expectedEffect": { "metric": "CPA", "delta": "-18%（推定）", "confidence": "medium" },
      "approvalKind": "meta_budget_change", "approvalId": null }
  ],

  "notes": [ "山形天童院は広告費未入力のため全集計から除外しています（0円として扱っていません）",
             "CACは広告費のみで算出しています（獲得関連人件費が未取得のため）" ]
}
```

### 4-1. 保存

| 何を | どこに | 理由 |
|---|---|---|
| Report Snapshot（上記JSON） | `naoru:cc:report:<reportId>`（1件1キー） | 再現性。ブロブ肥大を避ける |
| 一覧用の索引 | `naoru:cc:report:index:v1`（**原子的追記**） | `DATA_CONSISTENCY_PLAN.md` §4 の追記型 |
| 生成の記録 | Agent Activity（`action: 'draft'`） | 誰がいつ何を作ったか |
| 書き出しの承認 | 承認センター（`kind: 'report_export'`） | 外部出力は承認必須 |

**Snapshot は作成後に書き換えない。** 条件を変えたいときは新しい `reportId` で作り直す。

---

## 5. Google Slides への書き出し（承認後）

### 5-1. スライド構成（既定テンプレート）

| # | スライド | 中身 |
|---|---|---|
| 1 | 表紙 | タイトル・対象期間・対象店舗・作成者・作成日時 |
| 2 | サマリー | KPI 15指標のタイル（前月比・前年比つき） |
| 3 | ファネル | 新規→予約→来店→購入 と各段の通過率 |
| 4 | 広告費 | 広告費推移（積み上げ）＋ 媒体別構成 |
| 5 | 効率 | CPA推移・CAC推移・媒体別CPA |
| 6 | 顧客価値 | LTV推移・ARPU推移・LTV/CAC |
| 7 | 店舗ランキング | CPA / LTV の上位下位 |
| 8 | 媒体比較 | 媒体比較表 |
| 9 | AI考察 | **事実 / 仮説 / データ不足 を3ブロックに分けて** |
| 10 | 改善提案 | 提案と期待効果（**承認前の下書きである旨を明記**） |
| 11 | 注記 | データ源・最終更新・品質・除外した店舗 |

### 5-2. 実行の流れ

```
① 画面で「Google Slides に新規作成」を選ぶ
② 承認センターに kind='report_export' が起票される
       payload: { reportId, title, destinationFolder, slideCount }
       contentHash: Report Snapshot のハッシュ
③ 承認者が内容を確認して承認
④ naoru-ai-platform の出力アダプターが Slides を新規作成
       ⚠ 実行直前に contentHash を再検証（承認後に中身が変わっていたら実行しない）
       ⚠ 同じ approvalId での二重実行を拒否（冪等）
⑤ 作成された Slides の URL を承認センターと Agent Activity に記録
```

**Dashboard は Slides を直接作らない。** Google の認証情報は Platform 側にのみ置く
（`INTEGRATION_PLAN.md` §F-3 のトークン隠蔽と同じ理由）。

---

## 6. できないこと（この設計の範囲外）

| できないこと | 理由 |
|---|---|
| 既存スライドの上書き | 事故時に戻せない。新規作成のみ |
| 自動配布・自動共有 | 宛先の承認が別途必要（`PERMISSIONS.md` §5） |
| PowerPoint / PDF への直接出力 | 初期は Slides のみ。必要なら別途 |
| 資料内での数値の再計算 | Snapshot を唯一の入力にするため。ずれの原因になる |
| Platform 未接続時の AI考察・Meta階層 | 該当スライドは「未接続のため省略」と明記して出す |

---

## 7. 実装フェーズ

| Phase | 内容 | 依存 | フラグ |
|---|---|---|---|
| R1 | `lib/report.js`（Snapshot の組み立て・検証）＋テスト | `MARKETING_DASHBOARD_PLAN.md` M2 | — |
| R2 | 作成モーダル（Step1〜3）＋ 画面プレビュー＋ダウンロード | R1 | `cc_report` |
| R3 | 資料一覧（過去に作った Snapshot の再表示） | R2 | 同上 |
| R4 | 承認センター連携（`report_export`） | R2 ＋ 承認センター | `cc_approval` |
| R5 | **Google Slides 書き出し** | **Platform 接続 ＋ Google の出力先承認** | `cc_source='platform'` |

**R1〜R3 は Platform 未接続でも作れる**（画面での確認・ダウンロードまで）。

---

## 8. 未解決（人の判断が必要）

| # | 論点 | 誰に |
|---|---|---|
| 1 | Google Slides の出力先フォルダ（専用フォルダを用意するか） | 制作・情報管理責任者 |
| 2 | Slides のテンプレート（既存の報告書フォーマットに合わせるか） | 経営 |
| 3 | Google への書き込み資格情報を Platform 側に置く前提でよいか | 技術責任者 |
| 4 | 資料の保存期間（Snapshot をいつまで残すか） | 経営・情報管理 |
| 5 | 誰が `report_export` を承認できるか（root のみ / owner も可） | 経営 |
