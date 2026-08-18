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
api/                # ⚠️ Vercel Hobbyの関数数上限(12)対策で「1エンドポイント=1ファイル」から統合ディスパッチャ方式に変更。
                    #    実体は lib/handlers/ に分離（lib配下はServerless Functionにカウントされない）。旧URLは vercel.json の rewrites で ?fn= に振り分け（フロントは変更不要）。maxDuration は全て ≤60（Hobby上限）。
  auth.js           # 認証API（パスワード検証・トークン発行）
  chat.js           # Claude AI チャットAPI（フィードバック動的注入・画像添付対応）。body.images=[{mediaType,data(base64)}] を渡すと最新ターンをimage+textブロックで送信（JPEG/PNG/GIF/WebP・最大4枚）
  feedback.js       # フィードバックAPI（GAS連携・取得/送信）
  health.js         # ヘルスチェック（env.planStore で保存先の有効状態も返す）
  salonone.js       # SalonOne 分析APIプロキシ（APIキー隠蔽・GET限定・許可リスト）
  plan-store.js     # SalonOne計画の目標・アクション共有ストア（全デバイス同期）。保存先=Vercel KV(推奨) or Supabase or GAS。未設定時はlocalStorage継続
  tasks.js          # タスク系API
  settlement.js     # 返金明細書ディスパッチャ → /api/settlement-auth|owners|store（?fn=auth/owners/store・rewrite）
  square.js         # Squareディスパッチャ → /api/square/metrics|settlement|test（?fn=metrics/settlement/test・rewrite）
  finance.js        # 財務ディスパッチャ → /api/finance-chat|pdf（?fn=chat/pdf・rewrite・bodyParser 50mb）
  gas.js            # GAS系ディスパッチャ → /api/gas-proxy|customers（?fn=proxy/customers・rewrite）
lib/
  markdown.js       # Markdownパーサー（テスト用分離モジュール）
  plan-calc.js      # 事業計画計算ロジック（テスト用分離モジュール）
  salonone.js       # SalonOne API連携ロジック（エンドポイント許可リスト・検証・URL組立）
  settlement.js     # 返金明細書 共通ロジック（オーナー認証トークン・スナップショット・計算・期日/注意書き）
  handlers/         # api/ ディスパッチャから呼ばれる実ハンドラ群（Serverless Functionにカウントされない）
    settlement-auth.js / settlement-owners.js / settlement-store.js
    square-metrics.js / square-settlement.js / square-test.js
    finance-chat.js / finance-pdf.js
    gas-proxy.js / customers.js
gas/
  feedback-gas-sample.js    # フィードバック用GASサンプルスクリプト
  settlement-gas-sample.js  # 返金明細書ストア用GASサンプル（スプレッドシートupsert/update）
tests/              # Vitestテスト
```

## セキュリティ
- **認証（アカウント制）**: ダッシュボード本体のログインは **ID（氏名）＋PASS のアカウント制**。ログインは `/api/settlement-auth`（`?fn=auth`）を使い、返金明細書のオーナーアカウント（GAS「オーナー設定」＋`SETTLEMENT_OWNER_*`）と共通。ログイン後は **アカウントに割り当てた店舗のみ表示**（`soShops` を `authState.shops` パターンでフィルタ。root=全店）。root は `DASHBOARD_PASSWORD` でログイン（全店舗・`__root__` トークン）。localStorageに `naoru_auth_token`/`naoru_auth_owner`/`naoru_auth_root`/`naoru_auth_shops` を保存。`DASHBOARD_PASSWORD`・アカウント共に未設定なら認証スキップ（開発用）
  - アカウント管理は「オーナー設定」タブ（root専用。非rootには非表示）。「店舗一覧からまとめてアカウント作成」で店舗名＝ID・アクセス＝その店舗のアカウントを共通初期PASSで一括発行（`stBulkCreate`）
  - 認可トークン: 本社操作(hqToken)は `settlement-owners`/`settlement-store` が `settlement-auth` の rootToken も受理（メインダッシュボードのroot統一ログイン）
  - ⚠️ 店舗絞り込みはUIレベル（SalonOneプロキシ `/api/salonone` 自体は未認証GET）。UIで見える範囲をアカウント毎に制御する用途。厳密なサーバー側データ分離が必要なら別途プロキシ認証が必要
- **旧認証**: `api/auth.js`（`DASHBOARD_PASSWORD` 単純照合）は現在メインログインでは未使用（後方互換で残置）
- **秘密情報**: GAS URL等はサーバーサイド(`api/gas-proxy.js`)経由。フロントにハードコードしない
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
  - `KV_REST_API_URL` / `KV_REST_API_TOKEN` — 計画の目標・アクション共有ストア（`api/plan-store.js`）用のVercel KV。VercelのStorageでKVを作成すると自動注入（GAS不要・推奨）
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
- **広告宣伝費(Meta)の既定2行**: 「請求内容」の広告宣伝費は既定で2行（`Meta広告運用代行費（N月）`／`Meta広告費用立替費（N月）`）。`（N月）`はフィルターで選択中の月を反映し、引き継ぎ時も当月に更新（`stDefaultMetaAds`／`stRefreshMetaMonth`）
- **セラピスト諸経費（住宅/美容の自動判定）**: 明細の「請求内容」に、在籍セラピスト（SalonOne `staffs` を店舗で絞込）ごとの値引きを自動計上。名目は偽装業務委託リスク回避のため「諸経費（氏名）」で統一し、内訳（「手当」の語は使わず `住宅2万・美容1万・子供N名・誕生日1万`）は注釈表示。ルール＝**税込生産性>100万→住宅2万＋美容1万（自動）／100万以下→自動なし**。子供1人5,000円・誕生日月1万円は随時入力し前月から引き継ぐ。生産性は当月のSalonOne個人売上（`sales/summary` の `by_staff` gross）を自動取得（空欄で自動・入力で上書き）。ロジックは `lib/settlement.js` の `computeTherapistShokei`／`computeSettlement(shokeiTotal)` に分離しテスト済み。手動入力は `settlement_manual_v1`（localStorage）の `therapists:[{id,name,productivity,children,birthday,extras}]` に保存（extrasは計算のみ・UI非表示）
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
