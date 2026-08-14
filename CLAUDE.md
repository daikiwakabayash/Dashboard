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
index.html          # フロントエンド（React SPA）
api/
  auth.js           # 認証API（パスワード検証・トークン発行）
  gas-proxy.js      # GAS APIプロキシ（秘密URL隠蔽）
  chat.js           # Claude AI チャットAPI（フィードバック動的注入対応）
  feedback.js       # フィードバックAPI（GAS連携・取得/送信）
  health.js         # ヘルスチェック
  salonone.js       # SalonOne 分析APIプロキシ（APIキー隠蔽・GET限定・許可リスト）
  square/
    metrics.js      # Square サブスクデータ集計
    test.js         # Square API接続テスト
lib/
  markdown.js       # Markdownパーサー（テスト用分離モジュール）
  plan-calc.js      # 事業計画計算ロジック（テスト用分離モジュール）
  salonone.js       # SalonOne API連携ロジック（エンドポイント許可リスト・検証・URL組立）
gas/
  feedback-gas-sample.js  # フィードバック用GASサンプルスクリプト
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

## SalonOne 分析API連携
SalonOne（`https://salonone.net`）の**読み取り専用**分析APIと連携する。
- **認証**: 運営発行のアクセスキーをヘッダ `X-SalonOne-Api-Key` に付与。キーは `SALONONE_API_KEY` 環境変数でサーバー側に隠蔽し、`/api/salonone` プロキシ経由でのみ利用（フロントに出さない）
- **フロント呼び出し**: `fetchSalonOne('sales/summary', { from, to })` / `/api/salonone?resource=<name>&...`
- **疎通確認**: `GET /api/salonone?diagnostic=1`（`/meta` への到達性を段階検査）
- **利用可能リソース**: `meta` / `sales/summary` / `marketing/by-channel` / `marketing/by-staff` / `marketing/retention` / `shops` / `staffs` / `menus` / `menu-categories` / `visit-sources` / `customer-tags` / `customers` / `appointments` / `appointment-menus`
- **マーケ集計**: 「その期間に初めて予約した新規客」が母集団。`by-channel`（媒体別 予約/来店/入会/入会率/売上）・`by-staff`（担当者別 新規予約/来店/購入/購入率）・`retention`（継続）。入会率 `join_rate` は分母=来店数で100%超あり（媒体比較は `join_rate_by_booking`）、`join_count` は遡及増加あり（月次推移は `join_in_period_count`）
- **制約**: GETのみ・ブランド単位でスコープ・レート制限60/分（`X-RateLimit-*`透過）・明細の日時はUTC（JST表示は+9h、`utcToJstIso`）
- ロジックは `lib/salonone.js` に分離し `tests/salonone.test.js` でカバー

## 開発ルール
- `index.html` を編集したら `npm test` を実行して構造テストを通す
- `api/chat.js` を編集したら `tests/chat-api.test.js` のテストを通す
- 新しいビジネスロジックは `lib/` に分離してテストを書く
- **絶対にAPIキーやトークンをコードにハードコードしない**（`.env` + Vercel環境変数を使う）
- GAS URLはフロントに直接書かず、`/api/gas-proxy` 経由にする
