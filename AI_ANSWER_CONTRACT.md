# 業務AIの回答をダッシュボードに出すための受け渡し（①⇄③）

最終更新: 2026-09-19 / 記録者: Claude Opus 5（①統括窓口）

正本の契約は `naoru-ai-platform/AGENTS.md` §3（共通実行契約）と §4（業務AI一覧）です。
この文書は**①ダッシュボード側の受け口**だけを書いたものです。判定・集計・生成は③が行います。

⚠️ **①は回答を作りません。**③が入れたものだけを画面に出します。
入っていなければ**何も出しません**（それらしい提案を並べません）。

---

## 1. 入れ口

```
POST /api/plan-store
{ "type": "aianswer", "action": "put", "answer": { ... } }
```

認証は**ヘッダ `X-CC-Agent-Token`（サーバー間）**、または管理者のログイン。
⚠️ 画面から名乗るだけでは書けません（403）。

読み出し（社内のログイン済みユーザー）:

```
GET /api/plan-store?type=aianswer&screen=home       画面ごと
GET /api/plan-store?type=aianswer&agent=marketing   担当ごと
```

## 2. `answer` の形

| 欄 | 必須 | 説明 |
|---|---|---|
| `agent` | ✅ | `chief` / `marketing` / `finance` / `storerisk` / `sns` / `content` / `product` / `knowledge` |
| `status` | ✅ | `queued` / `running` / `completed` / `failed` / `cancelled` |
| `citations[]` | ✅ | `{ id, label, version, current, url }`。`id` が無いものは出典として数えません |
| `facts[]` |  | 出典のある主張。下の §3 を満たさないものは**仮説へ落とします** |
| `hypotheses[]` |  | モデルの見立て |
| `missing_data[]` |  | 取れなかったもの。⚠️ **0 で埋めないでください** |
| `proposed_actions[]` |  | `{ id, kind, title, why, citationIds, approvalId }` |
| `freshness` | ✅ | `{ at: <ms>, note }`。無ければ画面に「更新日時が不明」と出ます |
| `usage` |  | `{ calls, tokens, costJpy }` |
| `error` |  | 失敗の理由（要約。原文・秘密を入れない） |

主張ひとつの形:

```json
{ "text": "当月の新規来店", "value": 132, "unit": "人",
  "period": "2026-09-01〜2026-09-18", "defVersion": "agg-v2",
  "citationIds": ["c1"], "origin": "source" }
```

## 3. 🔴 サーバーが保存時に確かめること

次のいずれかに当てはまる `facts` の要素は、**保存の時点で `hypotheses` へ移します**。
何を落としたかは応答の `demoted` に返します（黙って捨てません）。

| 落とす条件 | 理由 |
|---|---|
| `origin` が `source` でない | AIが作った値を実績として出さない（AGENTS.md §4 Command Center Service） |
| `citationIds` が空 | 引用のない事実主張を出さない（§6 の検出対象） |
| `citationIds` が `citations` に無いIDを指す | それらしい出典を作らせない |
| 数値なのに `period` が無い | 数値には対象期間を付ける（§3） |
| 数値なのに `unit` が無い | 同上 |
| 数値なのに `defVersion` が無い | 集計定義版を付ける（§3） |

⚠️ `origin` の既定は `model` です。**実績として出したい値には必ず `"origin": "source"` を付けてください。**

## 4. 画面での出方

- 「わかっていること（出典のある事実）」「AIの見立て（まだ裏が取れていません）」「取れていないもの（0 では埋めていません）」「やってはどうか（AIは実行しません）」の4区分で出します
- 数値のそばに**対象期間 / 出典 / 集計定義**を必ず添えます。欠けていれば「不明」と書きます
- 鮮度が24時間より古い、または分からないときは色を変えて知らせます
- 事実が1つも無く `missing_data` があるときは「**判断できませんでした（根拠が足りません）**」と出します。穴埋めはしません

## 5. 🔴 提案の実行について

**この画面から実行はできません。実行ボタンを置いていません。**
`proposed_actions` は並べるだけで、外向きの操作（配信変更・公開・送信・課金）は
`lib/approvals.js`（承認センター）を通して人が承認してから実行します。

⚠️ `kind` が空、または `read_` で始まらないものは、**承認が要る側に倒します**。
読み取りだけの提案は `kind` を `read_*` にしてください。

## 6. いまの状態

| | 状態 |
|---|---|
| 受け口（API・検証・保存） | ✅ 本番反映済み |
| 画面（経営ホーム / マーケティング） | ✅ 本番反映済み（フラグ `cc_ai_agents` の内側） |
| 残り6画面への設置 | ⬜ ③の接続後に、実際に返る内容を見てから置きます |
| ③からの実接続 | ⛔ 未接続。`CC_AGENT_TOKEN` の共有が要ります |

⚠️ フラグ `cc_ai_agents` は既定 OFF です。ON にしても、③が回答を入れるまで画面には何も出ません。
