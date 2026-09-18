# Creative Library（①Dashboard 側）の約束ごと

素材を登録し、③へ生成を依頼し、出てきた案を見比べ、修正を依頼し、承認して完成ファイルを
受け取るまでを①が受け持ちます。**画像・動画の生成そのものと、指標の計算は③の担当**です。

対応する③の契約: `naoru-ai-platform` の `CREATIVE_JOB_CONTRACT.md`（非同期制作契約 creative-library-1）

---

## 1. 素材・制作物の保存（暗号化＋認証付き配信）

**「URLを隠すだけの公開保存」は採用していません。**

Vercel Blob は公開URLしか発行できません（`@vercel/blob@0.27.3` は `access:'public'` のみ）。
長いURLは、1度でも漏れればログインしていない誰でも中身を取れてしまいます。
そこで**保存先には暗号文しか置きません**。

| どこ | 何が置かれるか |
|---|---|
| Vercel Blob | 暗号文だけ（`creative/<fileId>.enc`） |
| KV（`naoru:creative:v1`） | 保存先URL＋**親鍵で包んだデータ鍵**（平文の鍵は保存しない） |
| 環境変数 `CREATIVE_ASSET_KEY` | 親鍵のもと（**32文字以上**。未設定なら素材を登録できない） |
| ブラウザ | ①の認証付き配信口への参照だけ（保存先URL・鍵は渡らない） |

手順:

1. ブラウザがデータ鍵を作り、ファイルを暗号化してから Blob へ送る（平文は送らない）
2. データ鍵は①のサーバーへ渡す。サーバーが `CREATIVE_ASSET_KEY` で包んで保存する
3. 表示・取得は `GET /api/plan-store?type=creative&action=file&owner=…&ownerId=…&fileId=…`
   本部/root のログインを確かめてから、復号したバイトを返す

形式 `A256GCM-CHUNK1M`（`lib/creative-crypto.js`）:

- 平文を **1MiB ごと**に区切り、区切りごとに `[IV 12byte][暗号文][認証タグ 16byte]`
- 最後以外の区切りは同じ長さなので、平文の位置から暗号文の位置を計算できる
  → **Range 対応**（動画の再生・シークで、必要な区切りだけを取り出して復号する）
- AAD に `fileId` と区切り番号を入れる
  → 区切りの入れ替え・他ファイルからの差し替えを検知する
- 1byte でも書き換えられていれば**返さない**（一部だけ正しいふりをしない）

配信のヘッダは `Cache-Control: private, no-store`（共有キャッシュ・CDN に載せない）。

### ③の成果物

③のジョブ成果物は `{ src:'job', jobId, index }` で持ち、①が
`GET /v1/creative/jobs/{job_id}/files/{index}` へサービス鍵を付けて取りに行き、中継します。
**③のサービス鍵はブラウザへ渡しません。**

---

## 2. ③への依頼（非同期）

受付は **202 で即返し**、進み具合は `job_status` で聞きます（長い動画を同期で待ちません）。

初回:

```
job_id, creative_id, asset_id, tenant_id, store_id, channel, mode,
target_version, source_asset_ids, brand_version, formats,
appeal, headline, body
```

修正版は上に加えて:

```
parent_creative_id        … 同じ creative_id
source_creative_version   … 直前の版
revision_instructions     … 人が書いた原文
text_changes              … { headline, body, cta? } の明示値
source_file_ids           … 直す対象の版のファイルID
```

- ③は「曖昧な自由文だけ」では 422 `STRUCTURED_TEXT_CHANGE_REQUIRED` を返す契約なので、
  `text_changes` を必ず添えます（指定が無ければ、いまの見出し・本文をそのまま入れます）
- **参照する原制作物は tenant + creative + version から③が解決**します。
  ①は任意のファイルURLを送りません（送っていないことを試験で固定しています）
- `mode` は①からは常に `sample`。**①が勝手に `live` を名乗りません**

進み具合:

| ③の status | ①の扱い |
|---|---|
| queued / running | 生成中のまま。`poll_after_ms`（1〜10秒）で聞き直す |
| completed | 確認待ちへ。`mode` は③の申告をそのまま持つ |
| failed | 失敗。理由を残す |
| interrupted | **失敗として人に見せる**（自動で再実行しない） |
| 取得できなかった | 失敗にしない。生成中のまま、もう一度聞く |

---

## 3. 上書きと権限

- `asset_create` / `creative_create` の **IDは必ずサーバーが発番**します。
  クライアントが `id` を送っても採用しません（他テナントを含む既存レコードを上書きできない）
- 画面は `chat` と同じ**本部/root限定ゲート**（`resolveActor` で検証した actor）を通ります。
  役割を名乗るだけでは通りません
- フラグ `cc_creative_library` が ON のときだけ動きます（画面で隠すだけにしません）
- 承認は**人が押したときだけ**。`sample`・未接続・素材権利が未確認のものは承認できません

---

## 4. 必要な環境変数

| 名前 | 用途 | 未設定のとき |
|---|---|---|
| `CREATIVE_ASSET_KEY` | 素材の暗号化の親鍵（**32文字以上**） | 素材を登録できない（画面に理由を出す） |
| `CREATIVE_GEN_API_BASE` | ③生成APIの接続先 | 「未接続」と出す。**サンプルを作らない** |
| `CREATIVE_GEN_API_KEY` | ③生成APIの認証キー | 同上 |

---

## 5. 確認の3区分

| 区分 | 何で確かめるか |
|---|---|
| コード保存 | `tests/creative.test.js` / `creative-crypto.test.js` / `creative-api.test.js`（動き）<br>`tests/creative-screen.test.js`（**HTMLの記述だけ**。表示の確認ではない） |
| デモでの確認 | `scripts/creative-screen-check.mjs`（実ブラウザ＋スタブAPI）<br>実際に開ける画像・再生できる動画・保存できる完成ファイルを条件にしている |
| 本番での確認 | 配備先で人が同じ手順を確認したとき（未実施なら未実施と書く） |

デモでの確認の実行:

```
DASHBOARD_ROOT=<repo>/public CDN_DIR=/tmp/cdn \
CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
PLAYWRIGHT_PATH=<repo>/node_modules/playwright/index.mjs \
OUT_DIR=/tmp node scripts/creative-screen-check.mjs
```

素材はスクリプトがブラウザ自身で作ります（デモ素材。**施術素材は使いません**）。
