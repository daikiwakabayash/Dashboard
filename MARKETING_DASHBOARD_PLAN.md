# Marketing / LTV / Unit Economics ダッシュボード 設計（MARKETING_DASHBOARD_PLAN）

作成日: 2026-09-17 / ブランチ: `feature/cc-foundation` / 状態: **設計。実装は次フェーズ**
関連: `KPI_UI_SPEC.md`（KPI定義とカード仕様）／`REPORT_GENERATOR_UI.md`（資料生成）／`INTEGRATION_PLAN.md`（全体方針）

> ⚠️ **改訂（2026-09-17）**: 本書 §8 の「AIの役割分担」と §8-1 の `lib/unitecon.js`（Dashboard側で指標を計算する案）は、
> **[DASHBOARD_GROUP_ANALYTICS_PLAN.md](DASHBOARD_GROUP_ANALYTICS_PLAN.md) §1 で上書き**された。
> 指標の計算は naoru-ai-platform の Group Data Platform が担い、**Dashboard では新しい指標計算を書かない**。
> Dashboard は `/api/cc?fn=metrics` の契約（同 §2）に対して1度だけ画面を書き、データ源をフラグで切り替える。
> 本書の Source of Truth（§1）・KPI・グラフ・ドリルダウンの内容は引き続き有効。

---

## 1. Source of Truth（正式データソース）

**この表がこのダッシュボードの憲法。ここに書いていない出所の数字は画面に出さない。**

| データ | 正式データソース | Dashboard での扱い |
|---|---|---|
| **広告費（全社・店舗別・媒体別）** | **SalonOne API** `marketing/by-channel` の `ad_spend` | **正式値。これを表示する** |
| 予約・来店・購入・集客情報 | **SalonOne API** `marketing/new-customers`（受付日コホート）／`by-channel` | 正式値 |
| 売上・課金・返金 | **Square API** | 正式値 |
| Meta広告の詳細Performance<br>（Campaign / AdSet / Ad / Creative / CTR / CPC / CPM / Frequency） | **Meta Marketing API 経由の naoru-ai-platform** | Platform から取得して表示 |
| AI分析・確定Metric | **naoru-ai-platform** | Platform の確定値を使う |

### 1-1. 「広告費 = Meta API」にしない理由（明文化）

Meta以外に **HotPepper・チラシ・その他媒体**があり、Meta Marketing API では全広告費を賄えない。
全社広告費・CPA・CAC・ROAS の**分母を一本化**するため、**SalonOne を全広告費の正式値**とする。

Meta API は「Metaの中身を分解する」ためだけに使う:

```
SalonOne ad_spend（Meta媒体分） … 表示する金額の正
        ↓ 按分比率だけ Meta API から取る
Campaign / AdSet / Ad / Creative 別の内訳
```

→ **Meta API の金額をそのまま画面の広告費として表示しない。**
　 合計は必ず SalonOne と一致する（内訳の比率だけ Meta API を使う）。

### 1-2. 差異があったとき

Meta API の期間合計と SalonOne の Meta媒体 `ad_spend` が一致しない場合:

- **表示値は SalonOne のまま**（勝手に合算・平均・置換しない）
- KPIカードに **`⚠ 広告費データ差異あり`** を表示
- 差額・差異率・両方の値・取得時刻を展開表示
- 差異率がしきい値（既定 5%）を超えたらアラート基盤へ `ad_spend_mismatch` を起票

詳細は `KPI_UI_SPEC.md` §4。

---

## 2. 画面構成

既存の「マーケティング」タブ（`id='mktg'`）を拡張する。**新規タブは作らない。**
サブタブ（`soView`）に追加する形なので、既存の `acq` / `forced` / `customers` は変更しない。

```
マーケティング（既存タブ）
 ├ ダッシュボード          soView='acq'        ← 既存
 ├ 施策リンク別            soView='forced'     ← 既存
 ├ 新規顧客一覧            soView='customers'  ← 既存
 ├ ★ Unit Economics       soView='unit'       ← 新規（本設計の中心）
 └ ★ ドリルダウン          soView='drill'      ← 新規（店舗→媒体→Meta階層）
```

フラグ: `cc_marketing`（既定OFF）。OFFのあいだサブタブは現れない。

---

## 3. 全体KPI（15指標）

定義・計算式・出所は `KPI_UI_SPEC.md` が正。ここでは並びと役割だけ示す。

| 段 | KPI | 役割 |
|---|---|---|
| **投下** | 広告費 | いくら使ったか |
| **獲得ファネル** | 予約数 → 来店数 → 購入数 | どこで落ちているか |
| **獲得効率** | CPA（予約単価）／ CPO（購入単価）／ CAC（顧客獲得単価） | 1件いくらか |
| **転換率** | CVR（来店CVR／入会CVR／総CVR） | 何%通過したか |
| **顧客価値** | ARPU ／ Actual LTV ／ Expected LTV | 1人いくら生むか |
| **採算** | LTV/CAC ／ CAC Payback ／ ROAS | 儲かっているか |

**並びの意図**: 左から「使った → 集まった → 効率 → 価値 → 採算」。
経営会議で上から順に読めば、そのまま話の筋になる。

---

## 4. 絞り込み（フィルタ）

すべてのKPI・グラフ・表に同じフィルタが効く（1箇所で変えると全部変わる）。

| フィルタ | 値 | データ源 |
|---|---|---|
| スコープ | 全社 / 店舗（複数選択） | SalonOne `shops` |
| 都道府県・エリア | 北→南の地域グループ | 既存 `lib/geo.js` |
| 国内 / 海外 | 日本 / 豪州 / 馬来 | 既存 `lib/country.js`（`soRegion`） |
| 媒体 | 個別 visit_source 名 | SalonOne `by-channel` |
| **channel_group** | Meta / Google / HotPepper / Flyer / その他 | **新規 `lib/channelgroup.js`**（§4-1） |
| 月 | 単月 | — |
| 期間 | 任意の from/to | — |
| 比較 | 前月比 / 前年比 / 比較なし | — |

### 4-1. `lib/channelgroup.js`（新規・テスト付き）

SalonOne の `visit_source_name` は表記ゆれがあるため、**正規化して5グループへ寄せる**。

```js
// 例（実際の値は本番の visit_source 一覧を見て確定する）
Meta      ← META, Meta, Facebook, FB, Instagram, IG, Meta広告
Google    ← Google, GoogleAds, google広告, GDN, P-MAX, リスティング
HotPepper ← HPB, ホットペッパー, ホットペッパービューティー
Flyer     ← チラシ, ポスティング, 折込, フライヤー
その他     ← 上記以外（紹介・看板・LINE・自社サイト 等）
除外       ← 既存 / 未設定 / 会員 / 「N分」メニュー（既存 isNonNew と同じ規則）
```

**未知の媒体名は「その他」に入れ、画面に `未分類: N件` を出す**（黙って捨てない）。
本部が `?type=channelmap` で対応表を追記できるようにする（`naoru:channelmap:v1`）。

---

## 5. 媒体別比較

`Meta / Google / HotPepper / Flyer / その他` を同一画面で横並び比較する。

| 列 | 内容 |
|---|---|
| 広告費 / 構成比 | SalonOne |
| 予約 / 来店 / 購入 | SalonOne（受付日コホート） |
| CPA / CPO / CAC | 算出 |
| 来店CVR / 入会CVR | 算出 |
| ARPU / Actual LTV | Square + SalonOne |
| LTV/CAC | 算出 |
| ROAS | 算出 |
| 前月比 / 前年比 | 各指標の差分 |

**Meta の行だけ「▸」で展開でき**、Campaign 階層へ入れる（§7）。

---

## 6. グラフ（14種）

すべて「期間フィルタ」に連動。凡例クリックで系列の表示/非表示。

| # | グラフ | 形式 | X軸 | Y軸 / 系列 | データ源 | 補足 |
|---|---|---|---|---|---|---|
| 1 | 広告費推移 | 積み上げ棒 | 月 | channel_group 別の広告費 | SalonOne | 合計線を重ねる |
| 2 | CPA推移 | 折れ線 | 月 | 全社CPA ＋ 媒体別 | SalonOne | 閾値ライン（既定 ¥5,000）を水平線で |
| 3 | CAC推移 | 折れ線 | 月 | 全社CAC | SalonOne + Square | 目標CACを水平線で |
| 4 | LTV推移 | 折れ線 | 加入月 | Actual LTV ／ Expected LTV | Square + SalonOne | 2本並べて乖離を見る |
| 5 | LTV/CAC推移 | 折れ線 | 月 | 倍率 | 算出 | **3.0x の基準線**を引く |
| 6 | ARPU推移 | 折れ線 | 月 | ARPU | Square | — |
| 7 | 店舗別CPAランキング | 横棒 | CPA | 店舗 | SalonOne | 閾値超過は赤。クリックでドリルダウン |
| 8 | 店舗別LTVランキング | 横棒 | LTV | 店舗 | Square + SalonOne | 同上 |
| 9 | 媒体別広告費 | ドーナツ | — | channel_group | SalonOne | 中心に合計金額 |
| 10 | 媒体別CPA | 横棒 | CPA | channel_group | SalonOne | 全社平均線 |
| 11 | 広告費 vs 売上 | 複合（棒＋折れ線） | 月 | 棒=広告費 / 線=売上 | SalonOne + Square | 第2軸にROAS |
| 12 | **CAC vs LTV 散布図** | 散布 | CAC | LTV | 算出 | 1点=1店舗。**LTV=CAC の対角線**と **LTV=3×CAC 線**を引き、右下＝危険 |
| 13 | コホート残存率 | 折れ線（多系列） | 経過月 | 残存率% | 既存 `lib/cohort.js` | 加入月ごとに1本 |
| 14 | **新規→予約→来店→購入 Funnel** | ファネル | — | 各段の件数と通過率 | SalonOne | 各段クリックで該当顧客一覧へ |

**Funnel の段階定義**（既存の3状態ロジックを踏襲）:
```
新規予約   = 期間内に受付(received_at)がある新規客
  ├ 来店     first_appointment_status = completed / visited
  ├ キャンセル first_appointment_status = cancelled   ← 実キャンセルのみ
  └ 未来店    予約済みで来店日が未到来（＝まだ失敗ではない）
購入(入会) = joined
```
⚠️ **未来店をキャンセルに含めない**（既存コードで修正済みの落とし穴。ここでも同じ規則）。

---

## 7. ドリルダウン

```
全社
 └─ 店舗をクリック
      広告費 / 媒体構成 / CPA / CPO / CAC / CVR / LTV / ARPU / Retention / ROAS
      └─ 媒体をクリック
           ├─ Meta 以外 … 媒体×店舗の実績のみ（それ以上の階層は媒体側にデータが無い）
           └─ Meta      … Campaign → AdSet → Ad → Creative
                           CTR / CPC / CPM / Frequency / Spend / 予約 / 来店 / 購入
```

### 7-1. Meta階層のデータ契約（Platform → Dashboard）

Dashboard は Platform の API を**サーバー側プロキシ経由**で呼ぶ（トークンはフロントに出さない。`INTEGRATION_PLAN.md` §F-3）。

```jsonc
// GET /api/cc?fn=platform&resource=meta/hierarchy&shop=恵比寿院&from=2026-08-01&to=2026-08-31
{
  "status": "ok",
  "facts": {
    "level": "campaign",
    "rows": [{
      "id": "23851...", "name": "肩こり_8月_初回2980",
      "status": "ACTIVE",
      "spend": 182400,            // Meta API の値（※表示は SalonOne 按分後）
      "impressions": 412300, "clicks": 5840,
      "ctr": 1.42, "cpc": 31.2, "cpm": 442.4, "frequency": 2.8,
      "bookings": 62, "visits": 41, "orders": 24,   // SalonOne 側と突合した結果
      "children": "adset"
    }]
  },
  "reconciliation": {             // ★ 差異の明示
    "salonOneSpend": 1180000, "metaApiSpend": 1194300,
    "diff": 14300, "diffRate": 0.0121, "withinTolerance": true
  },
  "freshness": { "salonOne": "2026-09-17T05:30:00Z", "metaApi": "2026-09-17T13:00:00Z" },
  "missing_data": [],
  "citations": []
}
```

**規則**:
- `spend` の表示値は `salonOneSpend × (metaApiSpend行 ÷ metaApiSpend合計)` で按分する
- `withinTolerance=false` なら画面に「広告費データ差異あり」を出す
- Platform が落ちていたら **Meta階層だけ「未取得」と表示**し、上位のKPIは SalonOne で通常どおり出す

---

## 8. AI Insights の役割分担

**AIに数値を計算させない。** 数値は SalonOne / Square / Platform の確定Metricを使う。

| 担当 | 内容 |
|---|---|
| 集計エンジン（決定的） | 広告費・CPA・CAC・LTV・ROAS などすべての**数値** |
| AI（naoru-ai-platform） | **なぜそうなったかの説明と仮説**:<br>・なぜCPAが上がったのか<br>・なぜLTVが下がったのか<br>・どの店舗が危険か<br>・どの媒体を改善すべきか |

表示は **`facts`（確認できた事実）／`hypotheses`（仮説）／`missing_data`（データ不足）を必ず3分割**。
仮説を事実として見せない。出典（`citations`）を併記する。

```
┌─ 確認できた事実 ────────────────────────────┐
│ 恵比寿院のMeta CPAは8月 ¥6,885（前月比 +24%）  │
│ 同期間の来店率は 62.2%（全社平均 69.1%）        │
│ 出典: SalonOne by-channel / 2026-09-17 05:30   │
├─ 仮説（AIの推定・検証が必要） ────────────────┤
│ 予約から来店までの日数が伸びており、             │
│ リマインド運用の変更が影響した可能性             │
├─ データ不足 ────────────────────────────────┤
│ 予約〜来店のリードタイムは未取得。              │
│ Meta の Frequency は Platform 未接続のため不明   │
└────────────────────────────────────────────┘
```

---

## 9. 実装フェーズ

| Phase | 内容 | 依存 | フラグ |
|---|---|---|---|
| M0 | `lib/channelgroup.js` ＋ テスト。既存マーケ画面には出さない | なし | — |
| M1 | Unit Economics サブタブ（KPI 15指標・SalonOne + Square のみ） | M0 | `cc_marketing` |
| M2 | グラフ 1〜11・13・14（Meta階層を必要としないもの） | M1 | 同上 |
| M3 | 店舗ドリルダウン（媒体まで） | M1 | 同上 |
| M4 | CAC vs LTV 散布図（#12）＋アラート連携 | M2 | `cc_meta_alerts` |
| M5 | **Meta階層ドリルダウン**（Campaign/AdSet/Ad/Creative） | **Platform 接続** | `cc_source='platform'` |
| M6 | AI Insights（facts/hypotheses/missing_data） | Platform 接続 | `cc_meta_reco` |
| M7 | 資料生成（`REPORT_GENERATOR_UI.md`） | M2 + 承認センター | `cc_report` |

**M0〜M4 は Platform 未接続でも作れる**（既存の SalonOne / Square データだけで動く）。
M5 以降は Platform 側の構築完了が前提。

---

## 10. 未解決（人の判断が必要）

| # | 論点 | 誰に |
|---|---|---|
| 1 | **CAC の定義**。広告費のみか、販促人件費・インセンティブを含むか | 経営・財務 |
| 2 | **CAC Payback を粗利ベースで出すか売上ベースか**（粗利率が未取得） | 財務 |
| 3 | LTV/CAC の目標倍率（一般に 3.0x。NAORUの基準は？） | 経営 |
| 4 | CPA 閾値。現在コードは全店一律 ¥5,000。店舗・媒体別に変えるか | マーケ責任者 |
| 5 | `visit_source_name` の実際の一覧（channel_group の対応表を確定させたい） | マーケ責任者 |
| 6 | 広告費の過去分を SalonOne に寄せるか（手入力と差がある月の扱い） | マーケ責任者 |
| 7 | Meta広告アカウントと店舗の対応（Meta Account Registry の設計は Platform 側） | Platform / マーケ |
