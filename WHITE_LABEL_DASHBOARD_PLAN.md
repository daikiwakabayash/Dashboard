# ホワイトラベル化 設計（WHITE_LABEL_DASHBOARD_PLAN）

作成日: 2026-09-17 / ブランチ: `feature/cc-foundation` / 状態: **調査と設計のみ。コードは1行も変更していない**
関連: `INTEGRATION_PLAN.md`／`DASHBOARD_GROUP_ANALYTICS_PLAN.md`

> 目的: 既存 Dashboard を SalonOne クライアントへホワイトラベル提供できるようにする。
> **今回は棚卸しと設計のみ。** 現在のNAORU UIを壊す大規模リファクタリングは行わない。

---

## 1. 結論を先に

| | 内容 |
|---|---|
| **すぐ config 化できる** | ロゴ・会社名・ブランドカラー・アプリ名・AIの名前 — **見た目と呼び名だけ**。7項目・影響は局所的 |
| **次の段階** | メニュー・機能のON/OFF・KPIセット・レポート意匠 — **既存のフラグ基盤に乗せられる** |
| **まだやらない** | 保存キーの接頭辞・業種固有の用語と機能・単一ファイル構造 — **データ移行や大規模改修を伴う** |

**最大の落とし穴**: 保存キーが `naoru:` / `naoru_` で固定されている（KV 25種・localStorage 25種）。
これをテナントごとに変えると**既存データの移行が必要**になる。
→ **接頭辞を「設定値にして、既定値を `naoru` にする」**。NAORUは移行不要、新テナントだけ別接頭辞になる。

---

## 2. 現在ハードコードされているNAORU固有要素（棚卸し）

### 2-1. 出現数

| ファイル | `NAORU`/`naoru` の出現 | 主な中身 |
|---|---:|---|
| `index.html` | **143** | 表示名・ロゴ参照・localStorageキー・AIの名前 |
| `api/plan-store.js` | 38 | KVキーの接頭辞 |
| `api/chat.js` | 13 | **AI人格の定義**（後述） |
| `sw.js` | 7 | 通知タイトル・PWA |
| `owner.html` | 4 | 返金明細書ポータルの表示名 |
| `manifest.webmanifest` | 3 | アプリ名・説明 |
| `lib/geo.js` | 3 | 店舗名→都道府県の辞書 |
| その他 `lib/`・`lib/handlers/` | 各1〜2 | コメント・既定値 |

### 2-2. 分類表

| # | 分類 | 具体例 | 現在の場所 | config化 | 難易度 |
|---|---|---|---|:--:|:--:|
| 1 | **会社名・アプリ名** | 「NAORU」「NAORU ダッシュボード」「NAORU整骨院グループ 経営ダッシュボード」 | `manifest.webmanifest`, `index.html`, `owner.html`, `sw.js` | ✅ | 低 |
| 2 | **ロゴ・アイコン** | `logo.png` `naoru_heart.png` `Naoru_landscape.png` `icon-192/512(-maskable).png` `apple-touch-icon.png`（計7ファイル） | リポジトリ直下 | ✅ | 低 |
| 3 | **ブランドカラー** | `brand.50〜900`（橙 `#FF6B35` / `#E53F03`）、`ink`（紺）、`theme_color: #F37021` | `tailwind.config.js` ＋ `index.html` 内インライン設定 ＋ `manifest` | ✅ | 低〜中 |
| 4 | **AI人格** | 「NAORUアドバイザー」「NAORUアシスタント」／「整骨院チェーンを0→30店舗」／**代表・若林大樹の名前と言葉づかい** | `api/chat.js` の `SYSTEM_PROMPT` / `ASSISTANT_SYSTEM_PROMPT` | ✅ | 中 |
| 5 | **メニュー構成** | `navSections` の5カテゴリ・20項目のラベルと並び | `index.html`（Sidebar） | △ | 中 |
| 6 | **利用可能な機能** | 返金明細書・手当・サンクスギフト・MEO・AIパトロール… | `index.html`（`rootOnly` 等の条件） | △ | 中 |
| 7 | **KPIセット** | 表示する指標・閾値（`CPA_ALERT_THRESHOLD = 5000` 等） | `index.html`, `lib/*.js` | △ | 中 |
| 8 | **レポート意匠** | Slides テンプレート・スライド構成 | `REPORT_GENERATOR_UI.md`（未実装） | △ | 中 |
| 9 | **保存キーの接頭辞** | KV `naoru:*`（25種）／localStorage `naoru_*`（25種） | `api/plan-store.js`, `index.html` | ⚠️ | **高** |
| 10 | **業種固有の用語** | セラピスト（49）／施術（13）／整骨院（4）／オーナー（88）／店舗（806） | `index.html` 全体 | ⚠️ | **高** |
| 11 | **業種固有の機能** | 返金明細書（FC精算）・手当（勉強代/健康/アクセス）・サンクスギフト | `index.html`, `lib/settlement.js`, `lib/allowances.js` | ⚠️ | **高** |
| 12 | **地域辞書** | 店舗名から都道府県を推定する辞書 | `lib/geo.js` | ⚠️ | 中 |
| 13 | **外部接続** | SalonOne APIキー（ブランド単位）・Square トークン・GAS URL | 環境変数 | ✅ | 既に分離済み |

凡例: ✅ すぐ／△ 次の段階／⚠️ まだやらない

---

## 3. テナント設定の形（提案）

### 3-1. 置き場所

```
naoru-ai-platform（Group Data Platform）
   └ tenants テーブル ── テナント設定の正本
          │
          ▼  GET /api/cc?fn=tenant   （サーバー側プロキシ・キャッシュ可）
   Dashboard
      起動時に1回読み、window.__TENANT__ に載せる
```

**暫定**: Platform ができるまでは KV `naoru:cc:tenant:v1` に置き、
未設定なら **現在のNAORUの値を既定値として使う**（＝何もしなければ今のまま）。

### 3-2. 設定の形

```jsonc
{
  "id": "naoru",                          // 保存キーの接頭辞にもなる（既定 "naoru"＝移行不要）
  "brand": {
    "companyName": "NAORU整骨院グループ",
    "appName": "NAORU ダッシュボード",
    "shortName": "NAORU",
    "description": "経営ダッシュボード",
    "logo":       { "main": "/logo.png", "mark": "/naoru_heart.png", "landscape": "/Naoru_landscape.png" },
    "icons":      { "192": "/icon-192.png", "512": "/icon-512.png", "maskable": "/icon-512-maskable.png", "apple": "/apple-touch-icon.png" },
    "colors": {
      "brand":  { "50": "#FFF4EE", "400": "#FF6B35", "500": "#E53F03", "900": "#451200" },
      "accent": { "…": "…" },
      "theme":  "#F37021"
    }
  },
  "terms": {                              // 業種固有の呼び名（§5-3）
    "staff": "セラピスト", "shop": "店舗", "owner": "オーナー", "hq": "本部"
  },
  "menu": {                               // 表示する項目と並び（未指定は既定）
    "hidden": ["meo", "patrol"],
    "labels": { "settlement": "精算書" },
    "order":  ["chat", "board", "zenkanri", "salonone"]
  },
  "features": {                           // 機能のON/OFF（既存のフラグ基盤に相乗り）
    "settlement": true, "allowance": true, "thanksgift": false, "meo": false
  },
  "kpi": {
    "visible": ["revenue", "ad_spend", "cpa", "cac", "ltv_cac", "roas"],
    "thresholds": { "cpa_alert": 5000, "ltv_cac_target": 3.0 }
  },
  "agents": { "enabled": ["marketing_analyst", "store_risk"] },   // 利用可能Agent
  "report": { "template": "default", "cover": { "logo": true, "color": "#E53F03" } },
  "ai": {
    "advisorName": "NAORUアドバイザー",
    "assistantName": "NAORUアシスタント",
    "personaDocId": "knowledge:persona:naoru"   // 人格はナレッジ資料として外出し（§4）
  }
}
```

**規則**: **未指定の項目は必ず現在のNAORUの値にフォールバックする。**
設定が空でも今と同じ画面になることを、実装の前提条件にする。

---

## 4. AI人格の外出し（ここが一番デリケート）

`api/chat.js` には以下がハードコードされている:

- 「NAORUアドバイザー」「NAORUアシスタント」という名前
- 「整骨院チェーンを0店舗から30店舗まで急成長させた伝説の経営者」という経歴
- **「NAORU代表・若林大樹（わかばやし だいき）の"分身"として」** という人格定義
- 「NAORU経営陣の判断基準」というナレッジの見出し
- サンプルデータ内の氏名・プラン名

**方針**:

| 要素 | どうするか |
|---|---|
| 名前（アドバイザー／アシスタント） | `tenant.ai.*` から差し込む |
| 骨組み（回答の4段構成・出典の付け方・NEEDS_HQ の作法） | **共通のまま残す**。これは製品の品質そのもの |
| 人格・価値観・判断軸 | **ナレッジ資料として外出し**（既存の `?type=knowledge` の仕組みをそのまま使う） |
| サンプルデータ内の氏名 | 匿名化（`fixtures/salonone-api-sample.json` と同じ方針） |

> ⚠️ **特定個人の名前と言葉づかいを他社テナントへ引き継がない。**
> 「若林大樹の分身」はNAORUテナント固有の設定であり、テナント設定から外した瞬間に
> 中立的な「〇〇アシスタント」に戻る作りにする。

---

## 5. 難しい3つと、その扱い方

### 5-1. 保存キーの接頭辞（⚠️ 最重要）

現状: KV `naoru:*` 25種／localStorage `naoru_*` 25種 が**文字列リテラルで固定**。

```
naoru:chat:v1  naoru:board:v1  naoru:allowance:v1  naoru:thanksgift:v1 …
naoru_auth_token  naoru_so_at  naoru_board_seen …
```

**やってはいけないこと**: いきなり `${tenant}:chat:v1` に変える → **既存データが全部見えなくなる**。

**やること**:

```js
// 既定は 'naoru'。設定が無ければ今までと同じキーになる＝移行不要。
const NS = tenant.id || 'naoru';
const KEY = (name) => `${NS}:${name}`;      // naoru:chat:v1 … 既存と完全一致
```

- NAORU は接頭辞が `naoru` のままなので**1件も移行しない**
- 新テナントは最初から自分の接頭辞で書き始めるので**衝突しない**
- Rollback しても既存キーは無傷

**それでも残る課題**: 1つのKVインスタンスを複数テナントで共有すると、
**キーの取り違えが情報漏えいになる**。テナントごとにKVを分けるのが安全。→ §7-1

### 5-2. 業種固有の機能

**返金明細書（FC精算）／手当（勉強代・健康・アクセス）／サンクスギフト** は
NAORUの制度そのもので、他社にそのままは使えない。

**方針**: **無理に汎用化しない。** 機能フラグで**丸ごとOFFにできる**ようにするだけ。

```
tenant.features.settlement = false  → タブも計算も一切出ない
```

汎用化（項目名を設定可能にする等）は、**実際に使いたいテナントが現れてから**。
先回りして抽象化すると、NAORUの運用が回りにくくなる。

### 5-3. 業種固有の用語

「セラピスト」49箇所・「施術」13箇所・「オーナー」88箇所・「店舗」806箇所。

**方針**: **用語辞書（`tenant.terms`）を作るが、一括置換はしない。**

- 新しく書く画面から `t('staff')` のような参照に切り替える
- 既存画面は**触らない**（806箇所の置換は事故のもと）
- 「店舗」は他業種でも通じるため優先度が低い。まず `staff`（セラピスト）だけで足りる

---

## 6. 段階（Phase）

| Phase | 内容 | 影響範囲 | 前提 |
|---|---|---|---|
| **W0（今回）** | **棚卸しと設計のみ。コード変更なし** | なし | — |
| **W1 見た目** | 会社名・アプリ名・ロゴ・ブランドカラー・アイコンを設定値に。未設定ならNAORUの値 | `manifest` / `tailwind.config.js` / ヘッダー数箇所 | `cc_tenant` フラグ |
| **W2 AI名** | AIの名前を設定値に。人格はナレッジ資料へ外出し | `api/chat.js` | W1 |
| **W3 メニュー・機能** | メニューの表示/並び/ラベル、機能のON/OFF | `index.html` の `navSections` | 既存フラグ基盤 |
| **W4 KPI・レポート** | 表示するKPIと閾値、レポート意匠 | Metric API の契約に相乗り | `DASHBOARD_GROUP_ANALYTICS_PLAN.md` G2 |
| **W5 名前空間** | 保存キーの接頭辞を設定値に（既定 `naoru`） | `api/plan-store.js` / `index.html` | **テナント分離の方針決定（§7-1）** |
| **W6 用語** | 新規画面から用語辞書を使う。既存画面は据え置き | 新規画面のみ | W3 |

**W1・W2 だけでも「他社のロゴと色で動く」状態になる。** ここまでは1〜2PRで届く範囲。

---

## 7. 未解決（人の判断が必要）

### 7-1. テナント分離の方式（最優先）

| 方式 | 分離の強さ | コスト | 備考 |
|---|---|---|---|
| A. **テナントごとに Vercel + KV を分ける** | **強い** | 高 | 設定はテナント別の環境変数。**情報漏えいのリスクが最小** |
| B. 1つの環境でキー接頭辞だけ分ける | 弱い | 低 | 実装ミスが即座に他テナントのデータ露出になる |
| C. Platform 側でテナント分離し、Dashboard は表示のみ | 中〜強 | 中 | `DASHBOARD_GROUP_ANALYTICS_PLAN.md` の方向と整合 |

→ **推奨は A または C。** B は安いが、`/api/plan-store` が現在サーバー認証を持たない
（`AUTHORIZATION_PLAN.md` §6）ことを考えると、**今の状態で B を選ぶべきではない**。

### 7-2. その他

| # | 論点 | 誰に |
|---|---|---|
| 1 | ホワイトラベル提供の形態（SaaS共用 / テナント専用環境 / ソース提供） | 経営 |
| 2 | NAORU固有機能（返金明細書・手当・サンクスギフト）を他社に見せるか | 経営 |
| 3 | AI人格（若林代表の分身）を**他テナントへ引き継がない**運用の確認 | 経営・情報管理 |
| 4 | ロゴ・アイコンの差し替え方法（ファイル置換 / URL指定 / アップロード） | 技術 |
| 5 | SalonOne APIキーをテナントごとに持つ前提でよいか | SalonOne |
| 6 | 用語の翻訳（多言語）まで視野に入れるか（海外店舗が既にある） | 経営 |

---

## 8. 今回やらないこと（明記）

- `index.html`（25,250行）の分割
- 806箇所の「店舗」など既存文言の一括置換
- 保存キーの実際の変更（設計のみ）
- 返金明細書・手当・サンクスギフトの汎用化
- テナント切替のUI

**現在のNAORU UIは1pxも変えない。** ホワイトラベル化は、
`DASHBOARD_GROUP_ANALYTICS_PLAN.md` の安全基盤（フラグ・認可・データ保全）が
固まってから着手するのが順序として正しい。
