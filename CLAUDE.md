# NAORU Dashboard

## プロジェクト概要
NAORU整骨院グループの経営ダッシュボード。GAS(Google Apps Script)・Square API・Claude AIを統合した分析ツール。

## 技術スタック
- **フロントエンド**: React (CDN/Babel standalone) + Tailwind CSS — `index.html` 単一ファイル
- **バックエンド**: Vercel Serverless Functions (`api/`)
- **テスト**: Vitest
- **AI**: Claude API (`api/chat.js`)
- **決済**: Square API (`api/square/`)
- **認証**: パスワードベース (`api/auth.js`)

## コマンド

### テスト実行（必須）
```bash
npm test          # 全テスト実行（変更後は必ず実行）
npm run test:watch  # ウォッチモード
```

### デプロイ
Vercelにpushすると自動デプロイ。

## テスト構成

| ファイル | 内容 |
|----------|------|
| `tests/auth-api.test.js` | 認証API（ログイン・トークン検証・パスワード未設定時の挙動） |
| `tests/chat-api.test.js` | API バリデーション・メッセージ構築・システムプロンプト検証 |
| `tests/markdown.test.js` | Markdownパーサー（見出し・リスト・テーブル・インライン要素） |
| `tests/plan-calc.test.js` | 事業計画データ計算（店舗別集計・媒体別CPA・ランキング） |
| `tests/html-structure.test.js` | フロントエンド構造検証（認証・API・セキュリティ） |

## ファイル構成
```
index.html          # フロントエンド（React SPA・本社/管理者向け）
owner.html          # 返金明細書 オーナーポータル（オーナー別PASSログイン・閲覧/確認/修正依頼）
api/
  auth.js           # 認証API（パスワード検証・トークン発行）
  gas-proxy.js      # GAS APIプロキシ（秘密URL隠蔽）
  chat.js           # Claude AI チャットAPI（フィードバック動的注入対応）
  feedback.js       # フィードバックAPI（GAS連携・取得/送信）
  health.js         # ヘルスチェック
  salonone.js       # SalonOne 分析APIプロキシ（APIキー隠蔽・GET限定・許可リスト）
  settlement-auth.js  # 返金明細書オーナー別PASS認証（GASオーナー設定＋環境変数・root対応）
  settlement-store.js # 返金明細書ストア（GAS保存: スナップショット/確認状況/修正依頼・トークン検証）
  settlement-owners.js # オーナーアカウント管理（GAS「オーナー設定」の追加/変更/削除・本社/root専用）
  square/
    metrics.js      # Square サブスクデータ集計
    settlement.js   # Square 精算（返金明細書用: 総売上/実手数料/返金を店舗×月で集計）
    test.js         # Square API接続テスト
lib/
  markdown.js       # Markdownパーサー（テスト用分離モジュール）
  plan-calc.js      # 事業計画計算ロジック（テスト用分離モジュール）
  salonone.js       # SalonOne API連携ロジック（エンドポイント許可リスト・検証・URL組立）
  settlement.js     # 返金明細書 共通ロジック（オーナー認証トークン・スナップショット・計算・期日/注意書き）
gas/
  feedback-gas-sample.js    # フィードバック用GASサンプルスクリプト
  settlement-gas-sample.js  # 返金明細書ストア用GASサンプル（スプレッドシートupsert/update）
tests/              # Vitestテスト
```

## セキュリティ
- **認証**: `DASHBOARD_PASSWORD` 環境変数でパスワード保護。未設定時は認証スキップ（開発用）
- **秘密情報**: GAS URL等はサーバーサイド(`api/gas-proxy.js`)経由。フロントにハードコードしない
- **環境変数**: Vercelの環境変数に以下を設定
  - `DASHBOARD_PASSWORD` — ダッシュボードログインパスワード
  - `GAS_API_URL` — 経営データ用GAS URL
  - `MARKETING_API_URL` — マーケティングデータ用GAS URL
  - `ANTHROPIC_API_KEY` — Claude AI APIキー
  - `SQUARE_TOKENS` — Square APIトークン（JSON配列）
  - `FEEDBACK_GAS_URL` — フィードバック用GAS WebアプリURL（オプション）
  - `SALONONE_API_KEY` — SalonOne 分析APIのアクセスキー（運営が「API連携」から発行・再表示不可）
  - `SALONONE_API_BASE` — SalonOne 分析APIのベースURL上書き（オプション・既定は本番）
  - `SETTLEMENT_OWNER_PASSWORDS` — 返金明細書オーナーポータルのPASS（JSON `{"オーナー名":"パスワード"}`・オーナー毎に一意）
  - `SETTLEMENT_OWNER_SHOPS` — オーナー別アクセス権限（オプション・JSON `{"オーナー名":["店舗名の一部",...]}`）。設定時はこれが公開範囲の唯一の基準。未設定時は `OWNER_BRANCHES` にフォールバック
  - `SETTLEMENT_GAS_URL` — 返金明細書ストア用GAS WebアプリURL（`gas/settlement-gas-sample.js` を配置）
  - `AUTH_SALT` — トークン用ソルト（オプション・オーナー認証で使用）

## SalonOne 分析API連携
SalonOne（`https://salonone.net`）の**読み取り専用**分析APIと連携する。
- **認証**: 運営発行のアクセスキーをヘッダ `X-SalonOne-Api-Key` に付与。キーは `SALONONE_API_KEY` 環境変数でサーバー側に隠蔽し、`/api/salonone` プロキシ経由でのみ利用（フロントに出さない）
- **フロント呼び出し**: `fetchSalonOne('sales/summary', { from, to })` / `/api/salonone?resource=<name>&...`
- **疎通確認**: `GET /api/salonone?diagnostic=1`（`/meta` への到達性を段階検査）
- **利用可能リソース**: `meta` / `sales/summary` / `marketing/by-channel` / `marketing/by-staff` / `marketing/retention` / `shops` / `staffs` / `menus` / `menu-categories` / `visit-sources` / `customer-tags` / `customers` / `appointments` / `appointment-menus`
- **マーケ集計**: 「その期間に初めて予約した新規客」が母集団。`by-channel`（媒体別 予約/来店/入会/入会率/売上）・`by-staff`（担当者別 新規予約/来店/購入/購入率）・`retention`（継続）。入会率 `join_rate` は分母=来店数で100%超あり（媒体比較は `join_rate_by_booking`）、`join_count` は遡及増加あり（月次推移は `join_in_period_count`）
- **制約**: GETのみ・ブランド単位でスコープ・レート制限60/分（`X-RateLimit-*`透過）・明細の日時はUTC（JST表示は+9h、`utcToJstIso`）
- ロジックは `lib/salonone.js` に分離し `tests/salonone.test.js` でカバー

## 返金明細書（FC精算）とオーナー共有
FC店舗ごとの「返金明細書」を SalonOne（現金/HPB/スクエア売上内訳）＋ Square API（総決済/実手数料/返金）から自動生成し、オーナーに共有・確認してもらう仕組み。
- **本社（`index.html` 返金明細書タブ）**: 店舗×月で明細書を生成・手動項目（Spotip/広告費/調整/料率）を編集。明細を表示/編集すると**自動でオーナーに共有**（スナップショットをGAS保存、公開ボタン不要）。明細書を先頭に表示し、オーナー管理・確認状況は下部に配置
- **オーナー（`owner.html`）**: PASSでログイン→月・店舗で検索→自分の店舗の明細書のみ閲覧→「確認済み」ボタン／「修正依頼」テキスト送信／**PDF保存・印刷**（`window.print` で各自ダウンロード保存。スプレッドシートは裏側の保存先でオーナーは触らない）
- **オーナー管理UI（本社/root）**: 返金明細書タブの「オーナー管理」でパスワード発行・変更、アクセス店舗の設定、追加/削除を画面上で実施（`api/settlement-owners.js`→GAS「オーナー設定」シート。環境変数の再デプロイ不要）
- **root権限**: `DASHBOARD_PASSWORD` で `owner.html` にログインすると全店舗を閲覧可能（`__root__` トークン）。本社ダッシュボードも同権限
- **アカウントの読み込み**: `api/settlement-auth.js` が GAS「オーナー設定」＋環境変数（`SETTLEMENT_OWNER_PASSWORDS`/`SETTLEMENT_OWNER_SHOPS`）をマージ（GAS優先）
- **アクセス権限**: オーナーが閲覧できる店舗をアカウント毎に設定。`settlement-store.js` の GET はトークン検証必須で、許可店舗のみ返す。本社の公開タグ付けも同設定を優先（`stOwnerFor`）
- **保存**: `api/settlement-store.js` 経由で `SETTLEMENT_GAS_URL`（スプレッドシート）に upsert/update。オーナーの更新は本人トークン＋owner一致行のみ許可（rootは全て可）
- **スナップショット方式**: 本社が算出した完成値を保存し、オーナーは再計算せず同じ値を表示（数値が完全一致）
- **照合**: SalonOneスクエア売上 と Square(総決済−返金) が不一致なら明細に ⚠️ を表示
- **期日/注意書き**: `lib/settlement.js` の `SETTLEMENT_SCHEDULE`/`SETTLEMENT_NOTES` が唯一の定義（2日売上確定→5日明細作成→10日オーナーチェック→15日振込、期日超過で修正不可）
- ロジックは `lib/settlement.js` に分離し `tests/settlement.test.js` でカバー

## 開発ルール
- `index.html` を編集したら `npm test` を実行して構造テストを通す
- `api/chat.js` を編集したら `tests/chat-api.test.js` のテストを通す
- 新しいビジネスロジックは `lib/` に分離してテストを書く
- **絶対にAPIキーやトークンをコードにハードコードしない**（`.env` + Vercel環境変数を使う）
- GAS URLはフロントに直接書かず、`/api/gas-proxy` 経由にする
