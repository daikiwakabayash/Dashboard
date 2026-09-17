# Serverless Function 枠 監査（FUNCTION_SLOT_AUDIT）

作成日: 2026-09-17 / ブランチ: `feature/cc-foundation` / 状態: **調査結果のみ。この段階では削除しない**

## 1. 現状

Vercel Hobby プランの Serverless Function 上限は **12**。`api/` 直下の `.js` が1ファイル＝1関数。

```
使用中 11 / 12（残り 1）
```

| # | ファイル | 役割 | 呼び出し元 | 状態 |
|---|---|---|---|---|
| 1 | `api/plan-store.js` | 全社データストア（`?type=` 25種） | index.html 多数 | 使用中 |
| 2 | `api/chat.js` | Claude AI（経営顧問／FAQアシスタント） | index.html | 使用中 |
| 3 | `api/salonone.js` | SalonOne 分析APIプロキシ | index.html | 使用中 |
| 4 | `api/square.js` | → `square-metrics` / `settlement` / `test` | index.html | 使用中 |
| 5 | `api/finance.js` | → `finance-chat` / `finance-pdf` | index.html | 使用中 |
| 6 | `api/settlement.js` | → `settlement-auth` / `owners` / `store` | index.html, owner.html | 使用中（ログインの中核） |
| 7 | `api/gas.js` | → `gas-proxy` / `customers` | index.html | 使用中 |
| 8 | `api/health.js` | ヘルスチェック | index.html | 使用中 |
| 9 | `api/feedback.js` | フィードバックGAS連携 | index.html | 使用中 |
| 10 | `api/auth.js` | 旧認証（`DASHBOARD_PASSWORD` 単純照合） | **なし** | ⚠️ 要確認 |
| 11 | `api/tasks.js` | タスク管理GAS連携 | **なし** | ⚠️ 削除候補 |

> 本ブランチで追加した承認センター・AI Agent Activity・フラグ・監査ログは
> **`api/plan-store.js` の `?type=` 分岐として同居**させたため、**関数枠の消費は 0**。

---

## 2. `api/tasks.js` — 削除候補（証拠あり）

### 調査した範囲と結果

| 調べたこと | コマンド | 結果 |
|---|---|---|
| フロントからの fetch | `grep "fetch('/api/tasks"` を `index.html` / `owner.html` | **0件** |
| 文字列としての出現 | `grep -rn "api/tasks"` （node_modules除く） | **自ファイルのコメント2行のみ** |
| rewrite 経由の到達 | `vercel.json` の `rewrites` | **tasks への記述なし** |
| 他の api / lib からの参照 | `grep -rn "tasks"` in `api/` `lib/` | **なし** |
| 追加された経緯 | `git log -- api/tasks.js` | `7db0b05 feat: スタッフタスク管理ページを追加（月次目標 + 週次タスク + GAS連携）` |

**結論**: 追加時に存在した「スタッフタスク管理ページ」は現在の `index.html` から削除されており、
`api/tasks.js` は**呼び出し元を失った孤児**。環境変数 `TASKS_GAS_URL` も同ファイル以外から参照されない。

```
使用箇所: api/tasks.js 内のコメント2行のみ（自己言及）
外部からの到達経路: なし（直接URLを叩く以外）
```

### 削除した場合の効果と影響

- **効果**: 関数枠 11 → 10（**空き2枠**）。AI Agent 実行用の `api/cc.js` を置いても1枠残る。
- **影響**: `TASKS_GAS_URL` を設定している場合、外部ツールが `/api/tasks` を直接叩いている可能性は
  コードからは**否定できない**。→ **削除前に「この URL への直近アクセスログが0であること」を Vercel 側で確認**する。
- **戻し方**: `git revert` 1コマンド。GAS 側のスプレッドシートは触らないため、データ損失はない。

### 推奨手順（実行は人間の承認後）

1. Vercel のログで `/api/tasks` へのリクエストが直近30日で0件であることを確認
2. 別PR（`feature/cc-slot-reclaim`）で `api/tasks.js` のみ削除
3. Preview でログイン〜主要タブの動作確認
4. 承認後に main へ

---

## 3. `PATIENT_DB_GAS_URL` — **使用中。削除候補ではない**

| 調べたこと | 結果 |
|---|---|
| 参照元 | `lib/handlers/customers.js:21`（`process.env.PATIENT_DB_GAS_URL`） |
| 到達経路 | `index.html:1358` `CUSTOMERS_API_URL = '/api/customers'` → `vercel.json` rewrite → `api/gas.js?fn=customers` → `lib/handlers/customers.js` |
| 画面 | `index.html:22220` `currentPage === 'customers'`（患者DBページ） |
| 未設定時の案内UI | `index.html:22283` に「Vercelの環境変数に `PATIENT_DB_GAS_URL` を追加」の表示あり |

**結論**: 経路が生きている。**環境変数もハンドラも残す。**
なお `lib/handlers/` 配下は Function 数にカウントされないため、そもそも枠の節約対象ではない。

---

## 4. 付随して見つかった点（今回は変更しない）

### 4-1. `api/auth.js` も呼び出し元が見当たらない

CLAUDE.md に「現在メインログインでは未使用（後方互換で残置）」と明記されており、
実際にフロントは `/api/settlement-auth` を使っている。ただし
**「後方互換で意図的に残している」と文書に書かれているため、`tasks.js` と同列には扱わない。**
削除するなら「後方互換が不要になったこと」を人が判断する必要がある。→ 判断待ち。

### 4-2. ナビから到達できないページが複数ある（要確認）

`navSections` に無いが render コードが残っているページ:
`dashboard` / `charts` / `marketing` / `customers` / `finance`

このうち **`marketing`** は注意が必要。既存の唯一のアラート `cpaAlerts`（サイドバーのベル）は
`mktData` から計算され、`mktData` は `currentPage === 'marketing'` のときにしか読み込まれない
（`index.html:7853`）。ナビから `marketing` に行けないなら、**ベルのアラートは常に空の可能性**がある。

`?tab=` の深リンクやモバイルナビなど別経路があるかは未確認。
→ **「CPAアラートが実際に出ているか」を運用側に確認したい**（出ていないなら、
これは Meta Ads Control Center の Alert 画面が置き換える対象そのもの）。

これらのページは `tests/html-structure.test.js` が文字列の存在を検査しているため、
**今回は一切触っていない。**

---

## 5. 枠が足りなくなったときの選択肢（優先順）

| 手段 | 効果 | 副作用 |
|---|---|---|
| ① 新機能を `plan-store.js` の `?type=` に同居させる（今回採用） | ±0 | 1ファイルが肥大する。`lib/` へロジックを出して緩和 |
| ② `api/tasks.js` を削除 | **+1** | §2の確認が必要 |
| ③ `api/feedback.js` `api/health.js` を既存ディスパッチャへ統合 | +1〜2 | 既存URLは rewrite で維持できる |
| ④ `api/auth.js` を削除 | +1 | 後方互換の要否を人が判断 |
| ⑤ Vercel Pro へ移行 | 上限緩和 | 費用。cron頻度・実行時間の制約も同時に解消 |

現時点の空き1枠は **AI Agent 実行用の `api/cc.js`**（長時間処理・認可必須）に確保しておく想定。
