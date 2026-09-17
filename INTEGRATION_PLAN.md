# NAORU Command Center — 統合設計案（INTEGRATION_PLAN）

> 本書は **設計案のみ**。本番機能の追加・既存挙動の変更は含まない。
> 前提: 別アプリを作らず、既存 `index.html` / `api/` / `lib/` にモジュールを追加する形で進化させる。
> UI・ナビゲーション・既存機能は維持し、追加分は「オフでも従来どおり動く」ことを全フェーズの必須条件とする。

作成日: 2026-09-17 / 対象ブランチ: `claude/happy-maxwell-rfijnn`

> ⚠️ **第I部を読む前に**: 本番Vercel接続を前提とした運用ガードレール（main直push禁止・`feature/*`運用・
> 環境変数/DBスキーマの無断変更禁止・Instant Rollback単位）と `naoru-ai-platform` との接続設計は
> **[第II部](#第ii部--本番運用環境platform接続追記--2026-09-17)** に定義した。
> 第I部 §2.1 / §3 の Supabase テーブル追加案は第II部 §D-3・§J-3 で**「承認待ちの提案」に格下げ**されている。

---

## 0. エグゼクティブサマリ（経営判断用）

現ダッシュボードは **機能面ではすでにCommand Centerに近い**（売上・マーケ・コホート・MEO・パトロール・チャット・掲示板・AI）。
弱いのは機能ではなく **土台（データの持ち方・履歴・権限・通知）** で、ここが次の拡張のボトルネックになっている。

| 弱点 | 今どうなっているか | 経営上のリスク | 打ち手の方向 |
|---|---|---|---|
| データ保持 | 全機能が1つのKVに「JSONの塊」で保存。**58箇所が読んで→書き戻す**方式 | 同時操作で**他人の入力が消える**。監査に耐えない | 保存層を抽象化し、原子的更新＋Supabaseを正式なDBへ昇格 |
| 履歴管理 | 上書きのみ。誰がいつ何を変えたか**残らない**（MEOの口コミ履歴のみ例外） | 数字が変わった理由を追えない。FC精算の説明責任が果たせない | 追記型イベントログ＋バージョン管理 |
| AI Knowledge | FAQ・資料を**全件ブラウザに落として**キーワードで詰め込み（18,000字上限） | 資料が増えるほど精度劣化・通信量増。回答根拠が示せない | サーバー側Retrieval（分割＋ベクトル検索＋出典ID） |
| 権限管理 | `/api/plan-store` は**認証なし**（UIレベルのみ）。トークンは無期限 | URLを知れば全社データの読み書きが可能 | 認可モジュールを新設し、計測→警告→強制の3段階で導入 |
| アラート基盤 | CPAアラートは**画面を開いている人にだけ**表示。パトロールは手動ボタン | 異常の発見が属人的。夜間・休日に気づけない | ルール登録制のアラート基盤＋配信（プッシュ/チャット/掲示板） |
| AI Agent連携 | AIは「質問に答える」まで。**自分で調べて動く**仕組みがない | 本部の手作業が減らない | ツール登録制のAgent基盤（読み取り専用から開始・書込は承認制） |

**進め方の原則**: 一度に作り替えない。各フェーズは **旧方式を残したまま**（フィーチャーフラグ＋二重書き）進め、
問題があれば環境変数1つで元に戻せる状態を常に維持する。

---

## 1. 現状調査（実測ベース）

### 1.1 コード構造

```
index.html                 25,250行 / 2.4MB … React SPA全体が単一 <script type="text/babel"> 内の1コンポーネント
owner.html                 24KB      … 返金明細書オーナーポータル（JSXなし）
api/*.js                   11ファイル … Vercel Serverless Function（⚠️ Hobby上限12・残り1枠）
lib/*.js                   20ファイル … テスト可能な純ロジック層
lib/handlers/*.js          10ファイル … ディスパッチャの実体（Function数にカウントされない）
tests/*.test.js            21ファイル … Vitest
scripts/precompile.mjs               … esbuildでJSX事前変換＋Tailwind事前ビルド → public/
```

**ビルド**: `vercel.json` の `buildCommand` が `precompile.mjs` を実行。
`<script type="text/babel">` をesbuildで変換し `DOMContentLoaded` 後に実行する `<script>` に差し替え。
失敗しても Play CDN のままフォールバック出力するため本番は壊れない。**この安全弁の設計思想を本計画でも踏襲する。**

### 1.2 API構成と「関数枠」の制約（最重要の物理制約）

Vercel Hobby の Serverless Function 上限は12。現在 **11使用済み・残り1枠**。

```
api/auth.js  chat.js  feedback.js  finance.js  gas.js  health.js
api/plan-store.js  salonone.js  settlement.js  square.js  tasks.js
```

`settlement.js` / `square.js` / `finance.js` / `gas.js` は `?fn=` で `lib/handlers/` へ振り分けるディスパッチャ。
旧URLは `vercel.json` の `rewrites` で吸収しているため、**フロントを変えずに裏側を再編できる**。
→ Command Center の新規モジュールも **この方式に必ず乗せる**（新規に関数ファイルを乱立させない）。

### 1.3 データ保持方式

`api/plan-store.js`（1,839行）が **事実上の全社データベースAPI**。1ファイル内で21種類を分岐処理:

```
blobcheck  allowance  accountmeta  zktherapist  adspend  acqexclude  presence
sbcache    meo        soflmap      faq          knowledge knowcand    ailog
patrol     events     board        profile      push      chat        thanksgift
```

保存先は3系統のフォールバック（`blobGet` / `blobSet`）:

1. **KV (Upstash/Vercel Redis REST)** — `KV_REST_API_URL` / `KV_REST_API_TOKEN` … 推奨・現行の主系
2. **Supabase (PostgREST)** — `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
   　※ テーブルは `plan_store (key text primary key, value jsonb, updated_at timestamptz)` の**1枚だけ**。
   　**リレーショナルDBをKVとしてしか使っていない**（＝現状のSupabase連携はKVの代替手段に過ぎない）
3. **GAS スプレッドシート** — `PLAN_GAS_URL` / `SETTLEMENT_GAS_URL`（`type=kv` / `action=saveKv` 実装が必要）

いずれも未設定なら `configured:false` を返し、フロントは localStorage で継続する（graceful degrade）。

**データの形**: すべて `naoru:<機能>:v1` の単一JSONブロブ。肥大対策として一部だけキーを分割している。

| キー | 分割方針 |
|---|---|
| `naoru:chat:m:<roomId>` | ルーム別。1ルーム最大400件のリングバッファ |
| `naoru:chat:reads:v1` | 既読ポインタを本体から分離（頻繁な書込がmessagesを巻き込むのを回避） |
| `naoru:chat:img:<id>` / `naoru:board:file:<id>` | 添付は1件1キー |
| `naoru:sb:<from_to>` | 確定過去月の店舗別売上キャッシュ |
| Vercel Blob | 動画・大容量ファイル（最大300MB・クライアント直アップロード） |

#### ⚠️ 弱点の核心: read-modify-write 競合

`await blobSet(...)` の呼び出しは **58箇所**。ほぼすべてが
「①ブロブ全体をGET → ②JSで編集 → ③ブロブ全体をSET」という非原子的な更新である。

```
A さん: GET {posts:[1,2,3]} ──編集──> SET {posts:[1,2,3,4]}
B さん: GET {posts:[1,2,3]} ──編集──> SET {posts:[1,2,3,5]}   ← 4 が消える
```

原子的なのは **チャット送信のみ**（`kvAppendJson` が Upstash `EVAL` でLuaを実行）。
コード中のコメントにも「同時送信で消える不具合」「索引が他ルームを消す不具合」への対処痕跡があり、
**この競合は既に実害として現れている**。掲示板・手当・イベント表・FAQ・投票など残り全機能は未対策。

#### ⚠️ 弱点: 履歴が無い

- 上書き保存のみで**過去の値が残らない**。「先月の目標はいくつだったか」「誰が数字を直したか」を追えない。
- 例外は `naoru:meo:v1` の `history:[{date,count,rating}]`（追記型）と `naoru:soflmap:v1` の `cursor`（差分同期）のみ。
  **この2つが唯一の「時系列を持つ」設計であり、全社標準に引き上げる価値がある。**
- 多くの書込で **actor（誰が）が記録されていない**。`updatedBy` を持つのは FAQ / knowledge / profile など一部だけ。

### 1.4 認証・権限

**ログイン**: `/api/settlement-auth`（`api/settlement.js?fn=auth`）が3系統をマージ（GAS/KV優先）。

- 環境変数 `SETTLEMENT_OWNER_PASSWORDS` / `SETTLEMENT_OWNER_SHOPS`
- GAS「オーナー設定」シート（UIから編集可・再デプロイ不要）
- KV `naoru:acctpass:v1`（先頭0落ち等のスプレッドシート型変換対策）／ `naoru:accountmeta:v1`（role/staffId/staffName）

**トークン**: `hashOwnerToken(owner, password, AUTH_SALT)` の固定ハッシュ。
→ **有効期限・失効・ローテーションが無い**。パスワード変更まで同じ値が有効。

**ロール**: `root`（共有PASS）/ `hq`（個人名のroot権限）/ `owner` / `staff`。
`localStorage` の `naoru_auth_*` に保持し、`authState` として全画面が参照。

**SSO**: SalonOne の ID/PASS でもログイン可（`auth/login` → Bearer）。
`lib/salonone-auth.js` の `verifySalonOneBearer()` がサーバー側で `/me` を叩き `{root, role, shopIds, shopNames}` を返す。

**認可の実装状況（ここが不均一）**:

| エンドポイント | サーバー側の認可 |
|---|---|
| `/api/settlement-store` `/api/settlement-owners` | ✅ オーナートークン検証＋SSO Bearer＋店舗一致チェック（401/403あり） |
| `/api/plan-store` **全21種** | ❌ **認可なし**。CRON用2アクションの `CRON_SECRET` のみ |
| `/api/salonone` | ❌ 未認証GET（キーはサーバー隠蔽。データGETは既定でブランド全体） |

→ チャット・掲示板・手当・投票・FAQ・広告費・プレゼンスは **URLを知っていれば誰でも読み書きできる**。
CLAUDE.md にも「UIレベル・社内利用前提」と明記されており設計上の既知の割り切りだが、
Command Center として権限管理を掲げる以上、**最優先で塞ぐべき箇所**。

### 1.5 各画面の依存関係

```
                    ┌─────────────── authState (root/hq/owner/staff, shops[], staffId) ───────────────┐
                    │  → Sidebar の canShow(rootOnly/hideForStaff/thanksOnly) でタブ出し分け         │
                    │  → soShopsRegion / soSalesShops で「取得する店舗ユニバース」を決定             │
                    └──────────────────────────────────────────────────────────────────────────────┘
                                   │
   ┌───────────────────────────────┼─────────────────────────────────┐
   │                               │                                 │
SalonOne分析API              plan-store (KV)                    Square / GAS / Places
/api/salonone                /api/plan-store?type=…             /api/square, /api/gas, (server内)
   │                               │                                 │
   ├ 全体管理シート(zenkanri)       ├ chat / board / events / org     ├ サブスク分析(square)
   ├ SalonOne売上(salonone)         ├ thanksgift / allowance          ├ 財務(finance)
   ├ マーケティング(mktg)           ├ adspend / faq / knowledge        └ MEO/パトロール(Places)
   ├ コホート(cohort)               ├ profile / presence / push
   └ 事業計画(planning)             └ sbcache / soflmap / acqexclude
```

**共有ロジック層**（テスト済み・再利用の起点）:
`cohort.js` `salonone.js` `settlement.js` `allowances.js` `thanksgift.js` `chat.js` `board.js`
`events.js` `geo.js` `country.js` `patrol.js` `places.js` `meo.js` `soflmap.js` `markdown.js` `plan-calc.js`

**フロントのポーリング**: presence 30s / 各種 25s / chat 6s(表示中)・25s / board 8s・30s / events 12s・45s。
→ 機能追加ごとにポーリングが増える構造。**購読を1本に束ねる余地がある**（後述 §2.5）。

### 1.6 アラートとAIの現状

**アラート**: `cpaAlerts`（index.html:9535）が唯一のUIアラート。
`mktData` に対する `useMemo` で最新月のCPAが閾値超えの店舗×媒体を抽出しサイドバーのベルに出す。
→ **クライアント計算・非永続・通知なし・既読/解決の概念なし**。画面を開いた人しか気づけない。

その他の「検知ロジック」はすでに存在するが、通知経路が繋がっていない:
- `lib/patrol.js` — 前月比±20%、入会率<30%、クチコミ0件、NAP不一致 等 → **人が手動でボタンを押した時だけ**動く
- `lib/meo.js` — `meoFlags` / `alertWeight` / `meoScore` → 日次cronは**スナップショット保存のみ**で通知しない
- `subsalert`（サブスク決済アラート） / `churn`（月別離反者） → 画面内表示のみ

**AI**: `api/chat.js` に2人格。
`SYSTEM_PROMPT`（経営顧問・フィードバック注入・thinking有）と `ASSISTANT_SYSTEM_PROMPT`（`agent:'faq'`・`claude-sonnet-5`→`claude-haiku-4-5`）。

Knowledge の流れは **クライアント側RAG**（`aiFetchFaq` index.html:3321）:
1. `?type=faq` で **FAQ全件** をブラウザに取得 → `shopScope` で絞り `q/a` を最大200件連結
2. `?type=knowledge` で **資料全件** を取得 → `aiRelevance()`（素朴なキーワードスコア）で並べ替え
3. 合計 **18,000字** の予算まで先頭から詰めて `dataContext` として送信

→ 資料が増えるほど **通信量・コンテキスト圧迫・精度劣化** が同時に進む。
→ 文書は分割されないため長い議事録1本で予算を食い潰す。**出典（どの資料の何行目か）を回答に付けられない。**

---

## 2. 補強設計案

> 共通方針: **既存の型・URL・localStorageキーを変えない**。新機能は新しい `type=` / 新モジュールとして足し、
> 旧経路は `CC_*` フィーチャーフラグが未設定なら**従来どおり**動く。

### 2.1 データ保持 — ストレージ抽象層 `lib/store/`

現状の `blobGet` / `blobSet` を `api/plan-store.js` から切り出し、**バックエンド非依存のポートを定義**する。

```
lib/store/
  index.js       … createStore(env) → { get, set, cas, append, mget, tx } を返すファサード
  kv.js          … 現行の Upstash REST 実装（EVAL/MGET含む）をそのまま移設
  supabase.js    … 現行の plan_store 実装 ＋ 新しいリレーショナル実装
  gas.js         … 現行のGAS実装を移設
  memory.js      … テスト用インメモリ（Vitestでストア依存のハンドラを検証可能にする）
```

**追加する2つのプリミティブ（これが競合対策の本体）**:

| API | 意味 | 実装 |
|---|---|---|
| `cas(key, expectedVersion, next)` | 楽観ロック付き更新。バージョン不一致なら `409` を返す | KV=Lua `EVAL` で `GET`→比較→`SET` を原子的に / Supabase=`UPDATE … WHERE version = $n` |
| `append(key, item, cap)` | 配列への原子的追記 | 既存 `kvAppendJson` を全機能へ一般化 |

- ブロブに `_v`（整数バージョン）と `_at` を埋め込み、GET応答に含める。
  フロントは受け取った `_v` を書込時に返送し、`409` なら **再取得してマージ→再送**（既存のポーリングと相性が良い）。
- 58箇所の `blobSet` は **一度に変えない**。競合の実害が大きい順に移行する:
  **① 掲示板(board) ② 手当(allowance) ③ イベント表(events) ④ 投票(thanksgift) ⑤ FAQ/knowledge ⑥ 残り**

**Supabaseの位置づけを変更**（現状はKV代替）:
`plan_store` テーブルは残したまま、Command Center用に**正規化テーブルを別途追加**する。
KVは「速い・軽い・現在値」、Supabaseは「履歴・検索・集計・ベクトル」と役割を分ける。

```sql
-- 追加のみ。既存 plan_store には一切触れない。
create table cc_events (              -- 追記専用イベントログ（§2.2の土台）
  id bigserial primary key,
  ts timestamptz not null default now(),
  actor_id text, actor_name text, actor_role text,
  entity text not null,               -- 'board' | 'allowance' | 'plan' | 'settlement' …
  entity_id text,
  action text not null,               -- 'create' | 'update' | 'delete' | 'publish' …
  shop text,
  before jsonb, after jsonb,
  source text                         -- 'ui' | 'cron' | 'agent'
);
create index on cc_events (entity, entity_id, ts desc);
create index on cc_events (shop, ts desc);

create table cc_snapshots (           -- 日次/月次の確定値スナップショット
  id bigserial primary key,
  taken_on date not null,
  kind text not null,                 -- 'sales_daily' | 'marketing_monthly' | 'meo_daily' …
  shop text, period text,
  payload jsonb not null,
  unique (kind, shop, period, taken_on)
);

create table cc_alerts (              -- §2.5
  id bigserial primary key,
  dedupe_key text unique not null,
  rule text not null, severity text not null,
  shop text, title text, detail jsonb,
  state text not null default 'open',       -- open | acked | resolved | muted
  opened_at timestamptz default now(), acked_by text, acked_at timestamptz,
  resolved_at timestamptz, delivered jsonb
);

create table cc_kdocs (               -- §2.3
  id bigserial primary key,
  doc_id text not null, title text, source text, shop_scope text,
  chunk_no int not null, body text not null,
  embedding vector(1536),             -- pgvector。未導入ならNULL可でキーワード検索にフォールバック
  updated_at timestamptz default now(),
  unique (doc_id, chunk_no)
);
```

**移行の安全策**: フラグ `CC_STORE_DUAL_WRITE=1` の間は **KVとSupabaseへ二重書き**し、読み取りは従来どおりKV。
一定期間の差分監視後に `CC_STORE_READ=supabase` へ切替。問題があれば環境変数を戻すだけで復旧できる。

### 2.2 履歴管理 — 追記型イベントログ＋バージョン

**設計の中心: 「現在値」と「起きたこと」を分ける。**

```
書込リクエスト
   ├→ 現在値を cas() で更新（KV: 速い・画面表示用）
   └→ cc_events へ append（Supabase: 遅くてよい・監査用）   ※失敗しても本処理は止めない
```

- **actor の標準化**: すべての書込に `{actorId, actorName, actorRole, source}` を必須化。
  現在は `updatedBy` が一部にしか無いため、まず **共通の `actorFromReq(req)` ヘルパ**を `lib/authz.js`（§2.4）に置き、
  plan-store の各分岐から呼ぶ形に統一する（既存の引数は後方互換で受け続ける）。
- **表示**: 各カードの「…」メニューに **「変更履歴」** を追加（新規タブは作らない＝UI維持）。
  `?type=history&entity=board&id=…` が `cc_events` を返し、モーダルで差分表示。
- **確定値の凍結**: 既存の `sbcache`（確定過去月の店舗別売上）を `cc_snapshots` に一般化。
  日次cronで `sales_daily` / `meo_daily` を積むと、**「3ヶ月前の任意の日の数字」が再取得ゼロで再現できる**。
  これは FC精算・オーナー説明の証跡として直接価値がある。
- 保持期間: `cc_events` は2年、`cc_snapshots` は無期限（行が小さい）。月次で古いイベントを集約テーブルへ圧縮。

### 2.3 AI Knowledge — サーバー側Retrieval `lib/knowledge/`

現在のクライアント側全件取得を、**サーバー側の検索API**へ置き換える（旧経路は残す）。

```
lib/knowledge/
  chunk.js      … 資料を見出し/段落単位で 800〜1,200字に分割（重なり100字）
  embed.js      … 埋め込み生成（未設定時は自動でキーワードのみにフォールバック）
  retrieve.js   … ハイブリッド検索: ベクトル類似 + キーワード(既存 aiRelevance を流用) + shopScope
  pack.js       … トークン予算内に詰め、各断片に [K12#3] のような出典IDを付与
```

**新API**: `GET /api/plan-store?type=knowledge&action=retrieve&q=…&shop=…&budget=…`
→ `{ context: "…[K12#3]…", sources: [{id, title, source, chunk}] }`

**フロント変更は最小**: `aiFetchFaq()` の中身を
「`CC_RAG=1` なら retrieve を呼ぶ / それ以外は現行の全件取得」に**差し替えるだけ**。
呼び出し側（`chatAiReply` / `askAiSend` / patrol）は無変更。

**効果**:
- 通信量: 全件（資料が増えるほど線形に増加）→ **上位k件のみの固定量**
- 精度: 長文1本が予算を食う問題を解消。関連段落だけが入る
- **出典表示**: `ASSISTANT_SYSTEM_PROMPT` に「根拠には `[K12#3]` を付ける」を追加し、
  フロントは `renderMarkdown` 後に出典チップへ変換 → **「この回答どこから？」に答えられる**
- 評価: 既存 `ailog` に `sources` と `escalated` を併記し、
  FAQ管理タブに **「エスカレ率」「出典が無かった質問トップ20」** を表示（＝ナレッジの穴が可視化される）

**取込元の拡張（将来）**: 掲示板投稿・チャットの本部回答（既存 `knowcand`）・議事録に加え、
Google Drive / スプレッドシートを日次cronで `cc_kdocs` へ同期（`source` に出典URLを保持）。

### 2.4 権限管理 — 認可モジュール `lib/authz.js`

**課題**: `/api/plan-store` の21種すべてが無認可。いきなり塞ぐと既存クライアントが壊れる。
→ **3段階で導入する**（各段階は環境変数で切替）。

```
Phase A (CC_AUTHZ=log)    … 判定するがブロックしない。拒否相当を記録するだけ → 影響範囲を実データで把握
Phase B (CC_AUTHZ=warn)   … レスポンスに警告ヘッダを付ける。フロントの未対応箇所を洗い出す
Phase C (CC_AUTHZ=enforce)… 401/403 を返す
```

**モジュール構成**:

```js
// lib/authz.js
export async function actorFromReq(req)   // ①SalonOne Bearer(verifySalonOneBearer) ②オーナートークン
                                          // ③rootトークン ④CRON_SECRET → { id, name, role, shops[], source }
export function can(actor, type, action, target)  // ケイパビリティ行列の判定
export function scopeShops(actor, shops)          // 店舗スコープの絞り込み（既存 allowedShopsFor を再利用）
```

**ケイパビリティ行列（抜粋・設計案）**:

| type | root/hq | owner | staff | 未認証 |
|---|---|---|---|---|
| `faq` `knowledge` | RW | R | R | ✕ |
| `board` | RW + pin/delete | R + post | R + post | ✕ |
| `chat` | 所属ルームRW | 所属ルームRW | 所属ルームRW | ✕ |
| `allowance` | RW全件 | 管轄店舗R | **本人分のみRW** | ✕ |
| `thanksgift` | 集計R | R | 投票W・本人受信R | ✕ |
| `adspend` `patrol` `meo` | RW | R | ✕ | ✕ |
| `accountmeta` | RW | ✕ | ✕ | ✕ |
| `presence` | RW | RW | RW | ✕ |

**トークンの改善**（既存ログインUIは変更しない）:
- `hashOwnerToken` に `exp`（発行時刻＋有効期間）と `kid` を含め、**期限切れを検証**。
  既存の無期限トークンも一定期間は受理し、検証成功時に新形式へ**静かに差し替える**（ユーザーは再ログイン不要）。
- 「オーナー設定」タブに **「このアカウントのトークンを失効」** を追加（`kid` 世代を進めるだけ）。

**同時に塞ぐ**: `/api/plan-store` の書込は `actor` 必須。読み取りは Phase C で認証必須。
`/api/salonone` は「キーのみで全店取得」の既存挙動を壊せないため対象外とし、**その旨を本書に明記して残置**。

### 2.5 アラート基盤 — `lib/alerts/`

**設計の中心: 「検知」「状態」「配信」を分離する。** 検知ロジックはすでに多数あるので、**束ねる箱**を作る。

```
lib/alerts/
  rules/                … ルールは1ファイル1関数。既存ロジックを呼ぶだけ（重複実装しない）
    cpa.js              … index.html の cpaAlerts を lib へ移設（フロントは lib を import）
    patrol.js           … lib/patrol.js の analyzeStore を再利用
    meo.js              … lib/meo.js の meoFlags / alertWeight を再利用
    subscription.js     … 既存 subsalert（サブスク決済失敗）
    churn.js            … 既存 churn（離反）
    plan.js             … 事業計画の目標未達（新規・目標データは既存 naoru:plan:goals）
  engine.js             … ルールを回し、dedupeKey で cc_alerts を upsert（状態遷移を管理）
  deliver.js            … 配信アダプタ: web-push / 店舗チャット / 掲示板 / （将来）メール
```

**アラートの型（統一スキーマ）**:
```js
{ rule:'cpa_high', severity:'warn'|'critical'|'info',
  shop:'恵比寿院', title:'META CPAが閾値超過',
  detail:{ cpa:18400, threshold:15000, month:'2026-08' },
  dedupeKey:'cpa_high|恵比寿院|META|2026-08' }   // ← 同じ事象を何度も通知しないための鍵
```

**状態遷移**: `open → acked（誰かが確認）→ resolved（条件が解消）`。`muted` で一定期間の抑止。
→ **今は「毎回同じ警告が出続ける／誰も対応していないことに気づけない」状態を解消する。**

**評価タイミング**: 既存cronは2本（枠に余裕あり。Hobbyは日次cron推奨）。
`/api/plan-store?type=alerts&action=cronscan` を1本追加し、日次で全ルールを評価。
即時性が要るもの（サブスク決済失敗）はデータ取得時にフックする。

**UIへの出し方（既存UIを維持）**:
- サイドバーの**既存ベルアイコンをそのまま使う**。中身を `cpaAlerts` から `cc_alerts` の `open` 一覧に差し替え。
  `CC_ALERTS` が未設定なら従来の `cpaAlerts` のまま（ロールバック可能）。
- 重大度 `critical` のみ web-push ＋ 該当店舗チャットへ投稿（既存 `sendPush` / `chatPost` を再利用）。
- 各アラートに「確認」ボタン（`acked`）。誰がいつ確認したかは `cc_events` に残る。

**ポーリング統合**（副次的改善）: 現在 presence/chat/board/events が別々にポーリングしている。
`?type=poll&since=…` で **未読数・アラート件数・presence をまとめて返す1本**に集約すれば、
通知系を足してもリクエスト数が増えない（既存の個別APIは残す）。

### 2.6 AI Agent連携 — `lib/agents/`

**現状**: AIは「聞かれたら答える」。パトロールは「人が押したら分析する」。
**目標**: 「AIが自分で必要なデータを取りに行き、必要なら人に承認を求めて動く」。

```
lib/agents/
  tools.js       … ツール登録（Anthropic tool_use 形式のJSON Schemaで定義）
  runner.js      … tool_use ループ（最大反復・タイムアウト・コスト上限）
  policy.js      … actor のロールで使えるツールを制限（§2.4 の can() を再利用）
  runlog.js      … 実行ログを cc_events に記録（source:'agent'）
```

**ツールは読み取り専用から開始**（安全側の既定）:

| ツール | 実体 | 権限 |
|---|---|---|
| `get_shop_metrics(shop, period)` | 既存 `aiBuildContext` のサーバー版 | 全ロール（店舗スコープ適用） |
| `search_knowledge(query, shop)` | §2.3 の retrieve | 全ロール |
| `get_alerts(shop, state)` | §2.5 の cc_alerts | root/hq/owner |
| `get_history(entity, id)` | §2.2 の cc_events | root/hq |
| `compare_periods(shop, a, b)` | 既存 `lib/cohort.js` / `plan-calc.js` | root/hq/owner |

**書込ツールは「提案 → 人が承認 → 実行」の2段階**（自動実行しない）:

| ツール | 承認者 | 備考 |
|---|---|---|
| `draft_store_message(shop, text)` | 送信ボタンを押す人 | 既存パトロールの文面生成と同じ思想 |
| `draft_faq(q, a, shop)` | root | 既存 `knowcand` の承認フローを再利用 |
| `open_alert(rule, shop, detail)` | 自動可（`severity<=warn`） | Agentが異常を見つけたらアラート化 |

**最初に作るAgent＝「AIパトロールの自走版」**（新機能ではなく既存機能の昇格）:
現在 `patrol` は本部が押して初めて動くが、日次cronで `runner` が全店を巡回し、
異常があれば `cc_alerts` に `open` を立て、`critical` のみ本部に通知 → 本部が文面を確認して送信。
**既存の手動ボタンはそのまま残す**（人が任意のタイミングで回せる）。

**コスト管理**: `runner` に1実行あたりのトークン上限・1日あたりの実行回数上限を設け、
`cc_events` に実測トークン数を記録（`api/chat.js` のモデルフォールバック `claude-sonnet-5`→`claude-haiku-4-5` を踏襲）。

### 2.7 フロントエンドの拡張方式（UI維持の担保）

`index.html` は 25,250行の単一ファイル。**ここを分割する提案はしない**（リスクが利益を上回る）。
代わりに以下のルールで足す:

1. **新規タブを作らない。** 既存タブ内のセクション／既存モーダル／既存ベルの中身として出す。
   例外は将来の「Command Center ホーム」だが、これは**既存タブの集約ビュー**として最後に検討する。
2. 新しい状態は `useState` を既存App内に足すのではなく、**`lib/` の純関数 + 薄いフック**に寄せ、
   `tests/` でロジック単体をテストできるようにする（既存の `lib` 分離方針と同じ）。
3. すべての新UIは **フラグでオフにできる**。`window.__CC_FLAGS__`（サーバーの `/api/health` が返す）で判定し、
   未設定なら描画しない＝**既存の見た目が1pxも変わらない**。
4. `tailwind.config.js` の `safelist` を確認してから動的クラス（`bg-${x}`）を使う（既存の運用ルール）。
5. `tests/html-structure.test.js` が参照している識別子
   （`navSections` / `menuItems` / `authState` / `handleLogin` / `planSelectedBranch` 等）は**改名しない**。

---

## 3. 段階的ロードマップ

各フェーズは独立してリリース可能。**前フェーズが本番で安定してから次へ進む。**

| Phase | 内容 | 主な変更 | 新規Function枠 | ロールバック |
|---|---|---|---|---|
| **0. 土台** | `lib/store/` 抽象化・`lib/authz.js` の actor 解決・`cc_*` テーブル作成 | 既存挙動は完全に不変（内部リファクタのみ） | 0 | コード差し戻し |
| **1. 履歴** | `cc_events` 追記開始（二重書き）・actor 標準化 | 書込時にログを1本足すだけ | 0 | `CC_EVENTS=0` |
| **2. 競合対策** | `cas()` / `append()` を board→allowance→events→thanksgift の順に適用 | 409時の再取得マージをフロントに追加 | 0 | フラグで旧 `blobSet` へ |
| **3. 権限** | `CC_AUTHZ=log` → `warn` → `enforce`／トークン有効期限 | plan-store 各分岐に `can()` を1行 | 0 | `CC_AUTHZ=off` |
| **4. アラート** | `lib/alerts/` ＋ 日次cron ＋ 既存ベルの中身差し替え | cron 1本追加（`vercel.json`） | 0 | `CC_ALERTS=0` |
| **5. Knowledge** | `lib/knowledge/` ＋ `action=retrieve` ＋ 出典表示 | `aiFetchFaq` の中身のみ差し替え | 0 | `CC_RAG=0` |
| **6. Agent** | `lib/agents/` 読み取りツール ＋ パトロール自走版 | cron 1本追加 | **1（`api/cc.js`）** | `CC_AGENT=0` |

**関数枠について（重要）**: Phase 0〜5 は **既存 `api/plan-store.js` に `type=` を足すだけで0枠**。
Phase 6 で最後の1枠を `api/cc.js`（Agent実行・長時間処理・**認可必須**のディスパッチャ）に使う。
これ以上増える場合は **Vercel Pro への移行**（上限緩和）か、`plan-store` を `?type=` 方式のまま維持する。
`api/auth.js`（旧認証・後方互換で残置）と `api/tasks.js` の実使用状況を棚卸しすれば、**+1〜2枠を回収できる可能性**がある。

---

## 4. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| `cas()` 導入で書込が失敗しやすくなる | 入力が保存されない体感 | 409時は**自動で再取得→マージ→再送**（最大3回）。それでも失敗したらUIに明示。イベント表は既存の `evEditingRef` と同じく編集中のポーリング取込を停止 |
| `CC_AUTHZ=enforce` で既存クライアントが401 | 全社的に機能停止 | Phase A/B で**実データの拒否件数が0になるまで**enforceに進まない。enforce後も環境変数1つで戻せる |
| Supabase移行でKVとの不整合 | 数字が画面ごとに違う | 二重書き期間中に**日次で差分チェック**するcronを回し、不一致を `cc_alerts` に出す（＝アラート基盤の最初の実用例） |
| ベクトル検索のコスト・pgvector未導入 | RAGが動かない | `embedding` はNULL可。未設定なら**既存の `aiRelevance` キーワード検索にフォールバック**（現行と同等の挙動） |
| Agentの暴走・コスト超過 | 予期しない投稿・請求 | 書込ツールは**すべて人の承認必須**。実行回数・トークン上限。全実行を `cc_events` に記録 |
| `index.html` の肥大（現2.4MB） | 初回表示の劣化 | 新UIはフラグで描画制御。Phase 6 以降に**ビルド時コード分割**（precompile.mjs で遅延読込チャンク生成）を別途検討 |
| Vercel関数枠12の逼迫 | デプロイ不能 | §3の方針を厳守。`auth.js`/`tasks.js` の棚卸しを Phase 0 で実施 |

---

## 5. 次にやること（承認をいただきたい判断ポイント）

1. **Supabaseを正式なDBとして採用するか**
   → 採用なら `cc_*` テーブル作成と pgvector 有効化。不採用ならKV内で履歴を持つ縮小版になる（検索・集計は弱くなる）。
2. **権限強制（Phase 3 enforce）をいつ実施するか**
   → 社内利用前提の現在の割り切りを続けるか、Command Centerとして塞ぐか。**塞ぐことを推奨。**
3. **Vercel Pro への移行是非**
   → 関数枠・cron頻度・実行時間の制約が Phase 6 以降のAgent機能を直接縛る。
4. **Phase 0〜2（土台・履歴・競合対策）から着手してよいか**
   → この3つは**UIも挙動も一切変わらない内部改善**であり、単独で「入力が消える」実害を解消する。最優先を推奨。

---

## 付録A. 現状の主要キー一覧（KV）

```
naoru:plan:goals / naoru:plan:actions      事業計画の目標・アクション
naoru:allowance:v1                         手当（提出・個人別生産性）
naoru:accountmeta:v1                       アカウント拡張（role/staffId/staffName）
naoru:acctpass:v1                          アカウントPASS（lib/kvblob.js）
naoru:zktherapist:v1                       全体管理シート セラピスト数の手動上書き
naoru:thanksgift:v1                        サンクスギフト（votes/log/published/dir）
naoru:chat:v1 / :reads:v1 / :m:<roomId> / :img:<id>   社内チャット
naoru:board:v1 / :file:<id>                掲示板
naoru:push:v1                              Webプッシュ購読
naoru:events:v1                            勉強会・イベント日程
naoru:profile:v1                           スタッフ/オーナープロフィール
naoru:adspend:v1                           媒体別・店舗別 広告費
naoru:faq:v1 / knowledge:v1 / knowcand:v1 / ailog:v1   AIナレッジ系
naoru:patrol:v1                            AIパトロール設定（住所照合・検索クエリ）
naoru:acqexclude:v1                        マーケ集計の手動除外
naoru:meo:v1                               MEO 口コミ履歴（★唯一の追記型履歴）
naoru:soflmap:v1                           顧客→施策リンクID 対応表（★唯一のカーソル差分同期）
naoru:presence:v1                          今アクセス中のアカウント（TTL 75秒）
naoru:sb:<from_to>                         確定過去月の店舗別売上キャッシュ
```

## 付録B. 追加予定キー／テーブル（本計画）

```
KV        naoru:cc:alerts:v1          アラートの現在値（表示用の速い側）
KV        naoru:cc:flags:v1           フィーチャーフラグ（/api/health が公開）
Supabase  cc_events                   追記型イベントログ（監査・履歴）
Supabase  cc_snapshots                日次/月次の確定スナップショット
Supabase  cc_alerts                   アラートの正（状態遷移・履歴）
Supabase  cc_kdocs                    ナレッジ分割＋埋め込み
```

## 付録C. 追加予定の環境変数（すべて任意・未設定なら従来動作）

```
CC_STORE_DUAL_WRITE=1        KVとSupabaseへ二重書き（移行期間）
CC_STORE_READ=kv|supabase    読み取り元の切替
CC_EVENTS=1                  イベントログ記録
CC_AUTHZ=off|log|warn|enforce   認可の段階導入
CC_ALERTS=1                  アラート基盤の有効化
CC_RAG=1                     サーバー側Retrievalの有効化
CC_AGENT=1                   Agent基盤の有効化
CC_AGENT_DAILY_LIMIT=50      1日あたりのAgent実行上限
EMBEDDING_API_KEY            埋め込み生成（未設定ならキーワード検索へフォールバック）
```

---
---

# 第II部 — 本番運用・環境・Platform接続（追記 / 2026-09-17）

> 本追記は、本番Vercelに接続済みであることを前提とした**運用ガードレール**と、
> 別リポジトリ `daikiwakabayash/naoru-ai-platform`（設計文書 `design/v0.1` / commit `1e6af1c`）との接続設計を定義する。
> **第I部 §2.1 / §3 のSupabaseテーブル追加案は、後述 §I-6 の承認を得るまで実行しない**（本追記で上書き）。

## 0. 作業ガードレール（全フェーズで厳守）

| # | ルール | 本計画での担保方法 |
|---|---|---|
| 1 | **mainへ直接pushしない** | 作業は `feature/*`。mainへの push はPR経由のみ |
| 2 | **新機能は `feature/*` ブランチ** | `feature/cc-<機能名>` 命名。1ブランチ=1機能=1フラグ |
| 3 | **Preview Deploymentで確認できる状態にする** | PRを立てた時点でVercelがPreview URLを自動発行。確認手順をPR本文に記載 |
| 4 | **人間承認前にmainへmergeしない** | PRは「レビュー＋Preview確認＋承認」が揃うまでmergeしない |
| 5 | **本番Environment Variablesを勝手に変更しない** | 追加が必要な変数は**PR本文に一覧で提案するのみ**。設定は人間が実施。<br>⚠️ そのため機能ON/OFFは**環境変数ではなくKVフラグ**を第一手段とする（§I-2） |
| 6 | **Supabase本番DBのschema変更・migrationを勝手に実行しない** | SQLは `docs/sql/*.sql` に**提案として置くだけ**。実行は人間。<br>第I部の `cc_*` テーブルは全て「承認待ちの提案」に格下げ |
| 7 | **既存の認証・チャット・売上・マーケを壊さない** | 新機能は追加のみ。既存関数・state・localStorageキー・API URLを改変しない。`npm test`（21ファイル）を全PRで実行 |
| 8 | **Instant Rollback可能な単位で変更する** | 1デプロイ=1機能。フラグOFFで即時無効化できない変更はマージしない（§I） |

**⚠️ 現在のブランチについて**: 本ドキュメントはセッション指定の `claude/happy-maxwell-rfijnn` 上にある
（内容は設計文書のみで本番影響なし）。**実装フェーズからは `feature/cc-*` に切り替える。**
現時点で `origin/main` と作業ブランチは同一コミット（`eebd60c`）＝差分なしのクリーンな起点。

---

## A. 現在のVercel構成

### A-1. ビルド・出力

| 項目 | 設定 | 出典 |
|---|---|---|
| Build Command | `node scripts/precompile.mjs` | `vercel.json` |
| Output Directory | `public` | `vercel.json` |
| ビルド内容 | ① `index.html` のJSXをesbuildで事前変換し `@babel/standalone` を除去<br>② Tailwind v3 をCSSに事前ビルド（Play CDNを `<link>` に差替）<br>③ `BUILD_ID` 埋込＋`version.json` 出力（クライアントが60秒毎に比較し自動再読込） | `scripts/precompile.mjs` |
| フォールバック | Tailwindビルド失敗時は**Play CDNのまま出力**（見た目は壊れない）。<br>ビルド自体が失敗した場合Vercelは**直前の正常デプロイを配信し続ける** | 同上 |

### A-2. Serverless Functions（⚠️ 最大の物理制約）

**11個使用中 / 上限12**（CLAUDE.md記載のHobbyプラン前提。※プラン実態は要確認 → §J-7）

| ファイル | memory | maxDuration | 役割 |
|---|---|---|---|
| `api/plan-store.js` | 256 | 60 | **全社データストア（21種の `?type=`）** |
| `api/chat.js` | 512 | 60 | Claude AI（経営顧問／FAQアシスタント2人格） |
| `api/salonone.js` | (既定) | (既定) | SalonOne分析APIプロキシ（キー隠蔽・GET限定） |
| `api/square.js` | 1024 | 60 | → `square-metrics` / `settlement` / `test` |
| `api/finance.js` | 1024 | 60 | → `finance-chat` / `finance-pdf`（bodyParser 50mb） |
| `api/settlement.js` | 256 | 60 | → `settlement-auth` / `owners` / `store` |
| `api/gas.js` | 256 | 60 | → `gas-proxy` / `customers` |
| `api/auth.js` | 128 | 10 | 旧認証（**現在メインログイン未使用・後方互換で残置**） |
| `api/health.js` | 128 | 10 | ヘルスチェック |
| `api/feedback.js` | (既定) | (既定) | フィードバックGAS連携 |
| `api/tasks.js` | (既定) | (既定) | タスク系（`TASKS_GAS_URL`） |

`lib/handlers/` 配下（10ファイル）は**Function数にカウントされない**。
旧URLは `vercel.json` の `rewrites` で `?fn=` に吸収 → **フロントを変えずに裏側を再編できる**。

→ **新機能は原則 `api/plan-store.js` の `?type=` 追加で0枠**。
　 AI/Agent系の長時間処理だけ最後の1枠を `api/cc.js` に使う（§H-3）。

### A-3. Cron

```
0  20 * * *   /api/plan-store?type=meo&action=cronscan       （05:00 JST）MEO口コミ日次スキャン
30 20 * * *   /api/plan-store?type=soflmap&action=cronsync   （05:30 JST）施策リンクマップ差分同期
```
`CRON_SECRET` が設定されていれば `Authorization: Bearer` を検証（任意）。
**Cronは Production Deployment でのみ実行される**（Previewでは動かない＝Previewが本番データを書き換える経路にならない）。

### A-4. キャッシュ・セキュリティヘッダ

- `/api/plan-store(.*)` と `/api/settlement-*` → `no-store`（認証・可変データ）
- `/api/square/metrics` → `s-maxage=300`、その他 `/api/(.*)` → `s-maxage=60`
- `/`, `index.html`, `owner.html`, `sw.js`, `manifest.webmanifest` → `no-cache, must-revalidate`（CDN含む）
- 全体: `X-Content-Type-Options: nosniff` / `X-Frame-Options: DENY` / `Referrer-Policy: strict-origin-when-cross-origin`
- Service Worker (`sw.js`) は**キャッシュせずパススルー**（古いビルドが residual しない設計）

### A-5. 外部ストレージ

- **Vercel Blob**（`BLOB_READ_WRITE_TOKEN`）: 動画・大容量添付。クライアント直アップロード、最大300MB、`addRandomSuffix`
- **Vercel KV / Upstash Redis**（REST）: 全社データの主系

---

## B. 現在のGitHubブランチ / deployフロー

### B-1. 現状

| 項目 | 実態 |
|---|---|
| リポジトリ | `daikiwakabayash/Dashboard`（`origin` = https://github.com/daikiwakabayash/Dashboard） |
| デフォルトブランチ | `main` |
| CI | **なし**（`.github/workflows/` が存在しない）→ テストは手元の `npm test` のみ |
| デプロイ | Vercel の Git Integration。**main への push = Production Deployment 更新** |
| Preview | main以外のブランチ／PRに対してVercelが自動発行 |
| 関連リポジトリ | `daikiwakabayash/naoru-ai-platform`（private・設計文書7本）、`daikiwakabayash/naoru-dashboard`（public・別物） |

### B-2. 採用するフロー（本計画）

```
feature/cc-<機能名>
   │  ① 実装（1機能のみ・KVフラグ既定OFF）
   │  ② ローカル npm test（21ファイル）
   ├──> push（feature/* のみ。main へは push しない）
   │  ③ PR作成 → Vercel が Preview URL を自動発行
   │  ④ Preview で動作確認（確認手順はPR本文のチェックリスト）
   │  ⑤ 人間レビュー＋承認   ← ここを越えるまで merge しない
   └──> main へ squash merge → Production Deployment 更新
        ⑥ 本番でフラグOFFのまま配信されていることを確認
        ⑦ KVフラグを ON（＝機能公開。再デプロイ不要）
        ⑧ 異常があればフラグを OFF（秒。デプロイもenv変更も不要）
```

**ポイント**: ⑤でmergeしても**機能はまだ出ない**（フラグOFF）。
コード配信と機能公開を分離することで、**mergeのリスクとfeature公開のリスクを別々にロールバックできる**。

### B-3. 追加を推奨するCI（別途承認）

`.github/workflows/ci.yml` に `npm ci && npm test` のみ。**デプロイもsecretも扱わない**読み取り専用CI。
→ 現在「テストを実行せずにmainへ入る」経路が開いているため、ガードレール#7の機械的な担保になる。

---

## C. Environment Variables 一覧と用途

> **値・Secretは記載しない。** コード内 `process.env.*` の全出現（33個）を棚卸しした結果。
> 「Preview可否」は §E の分離方針に基づく**推奨**であり、現在の設定状況ではない。

### C-1. 認証・セッション

| 変数 | 用途 | 必須 | Preview |
|---|---|---|---|
| `DASHBOARD_PASSWORD` | root（管理者・全店）ログインの共有PASS | ◯ | ❌ 本番値を置かない（Preview専用値） |
| `AUTH_SALT` | オーナートークンのハッシュソルト | 任意 | ❌ 別値 |
| `SETTLEMENT_OWNER_PASSWORDS` | オーナー別PASS（JSON） | 任意 | ❌ |
| `SETTLEMENT_OWNER_SHOPS` | オーナー別アクセス店舗（JSON） | 任意 | ⚠️ 匿名店舗名のみ |

### C-2. データストア

| 変数 | 用途 | 必須 | Preview |
|---|---|---|---|
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Vercel KV（主系ストア）。Storage作成で自動注入 | ◯(推奨) | ❌ **別KVインスタンス必須**（§E-2） |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | 上記の別名（同一実装で両対応） | — | 同上 |
| `REDIS_REST_API_URL` / `_TOKEN` | 上記の別名 | — | 同上 |
| `SUPABASE_URL` | Supabase PostgREST エンドポイント | 任意 | ❌ 別プロジェクト |
| `SUPABASE_SERVICE_ROLE_KEY` | **service_role キー（RLSを迂回する最強権限）** | 任意 | ❌ **絶対にPreviewへ置かない** |
| `SUPABASE_KEY` | 上記のフォールバック名 | — | 同上 |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob（動画・大容量添付）。Storage作成で自動注入 | 任意 | ❌ 別Blob store |

### C-3. 外部業務システム

| 変数 | 用途 | 必須 | Preview |
|---|---|---|---|
| `SALONONE_API_KEY` | SalonOne分析API（**読み取り専用**・サーバー隠蔽） | ◯ | ⚠️ 読取専用なので同一可。ただし別キー推奨（レート制限の分離） |
| `SALONONE_API_BASE` | ベースURL上書き | 任意 | ◯ |
| `SQUARE_TOKENS` | Square APIトークン（JSON配列・全店分） | ◯ | ❌ **本番決済アカウント。Previewへ置かない** |
| `SQUARE_ACCESS_TOKEN` / `SQUARE_ENVIRONMENT` / `SQUARE_LOCATION_ID` | 単一アカウント方式（後方互換） | 任意 | ❌ |
| `GOOGLE_PLACES_API_KEY` | Places API (New)（MEO・パトロール） | 任意 | ⚠️ 課金従量。Previewは未設定推奨（graceful degrade済み） |

### C-4. GAS（Google Apps Script）連携

| 変数 | 用途 | 必須 | Preview |
|---|---|---|---|
| `GAS_API_URL` | 経営データ用GAS | ◯ | ❌ |
| `MARKETING_API_URL` | マーケティングデータ用GAS | ◯ | ❌ |
| `SETTLEMENT_GAS_URL` | 返金明細書ストア（スプレッドシート upsert） | 任意 | ❌ **本番スプレッドシートに書き込む** |
| `PLAN_GAS_URL` | plan-store のGASフォールバック先 | 任意 | ❌ |
| `FEEDBACK_GAS_URL` | フィードバック収集 | 任意 | ❌ |
| `TASKS_GAS_URL` | タスク系API（`api/tasks.js`） | 任意 | ❌ |
| `PATIENT_DB_GAS_URL` | 患者DB連携 | 任意 | ❌ |

> ⚠️ `TASKS_GAS_URL` と `PATIENT_DB_GAS_URL` は**コードに存在するがCLAUDE.mdに未記載**。
> 現在使用中か棚卸しが必要（未使用なら `api/tasks.js` を整理して**Function枠を1つ回収できる可能性**）。

### C-5. AI・通知・運用

| 変数 | 用途 | 必須 | Preview |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Claude API（`api/chat.js`） | ◯ | ⚠️ **別キー＋利用上限**（Previewの試行が本番予算を食う） |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Webプッシュ通知 | 任意 | ❌ **未設定にする**（Previewから本番端末へ通知が飛ぶのを防ぐ） |
| `CRON_SECRET` | Cron呼び出しの認証 | 任意 | — （PreviewでCronは動かない） |

### C-6. 本計画で**追加を提案**する変数（設定は人間が実施・§J-2）

| 変数 | 用途 |
|---|---|
| `AI_PLATFORM_URL` | naoru-ai-platform のAPIベースURL（§F） |
| `AI_PLATFORM_TOKEN` | Platform専用の**読み取り専用**サービストークン（サーバー隠蔽） |
| `CC_ENV` | `production` / `preview` / `development`（自己申告。§E-3のガード用） |
| `EMBEDDING_API_KEY` | 埋め込み生成（未設定ならキーワード検索へフォールバック） |

> 第I部 付録Cの `CC_AUTHZ` / `CC_ALERTS` / `CC_RAG` / `CC_AGENT` などの**機能フラグは環境変数にしない**。
> ガードレール#5（env変更禁止）と Instant Rollback の要求から、**KVフラグ**（§I-2）へ移す。

---

## D. Supabase接続方式

### D-1. 現状（実装ベース）

| 項目 | 実態 |
|---|---|
| 接続方式 | **PostgREST を素の `fetch` で呼ぶ**。`@supabase/supabase-js` は依存に**入っていない** |
| 認証 | `apikey` ヘッダ＋`Authorization: Bearer` に **`SUPABASE_SERVICE_ROLE_KEY`** |
| 呼び出し箇所 | `api/plan-store.js` の `sbGet()` / `sbSet()` のみ（2関数） |
| テーブル | **`plan_store` 1枚だけ** — `key text primary key, value jsonb, updated_at timestamptz default now()` |
| 書込 | `POST /rest/v1/plan_store` ＋ `Prefer: resolution=merge-duplicates,return=minimal`（upsert） |
| 優先順位 | **KV → Supabase → GAS** のフォールバック。KVが設定されていればSupabaseは使われない |
| マイグレーション | **リポジトリに存在しない**（SQLはコメント中に1行あるのみ） |
| RLS | **実質無効**。service_role キーはRLSを迂回するため、行レベル制御が効かない |

```js
// lib/store の実態（api/plan-store.js 内）
async function blobGet(key, hasKV, hasSB, gas) {
  if (hasKV) return await kvGet(key);      // ← 通常はここで返る
  if (hasSB) return await sbGet(key);      // ← KV未設定時のみ
  return (await gasCall(...)).value;
}
```

### D-2. 評価

- ✅ **既存Supabaseは「KVの代替」でしかない**。リレーショナルDBとして一切使っていない。
- ⚠️ service_role キー1本で全操作。**Platform側 PERMISSIONS.md の「service roleをPreviewへ出さない」原則に照らすと、Preview環境の分離が前提条件**。
- ⚠️ `updated_at` は保持しているが**履歴は残らない**（upsertで上書き）。
- ⚠️ マイグレーション管理がないため、**スキーマ変更の追跡・ロールバック手段がない**。

### D-3. 方針（ガードレール#6を反映）

1. **既存 `plan_store` には一切触れない。** 列追加も型変更もしない。
2. 新規テーブルが必要になった場合、**SQLは `docs/sql/NNN_*.sql` に提案として置くだけ**。実行は人間が Supabase Studio で行う。
3. 新規テーブルは**追加のみ（additive）**。`DROP` / `ALTER COLUMN` / `NOT NULL` 追加を含む案は出さない。
4. マイグレーション管理を始めるなら、`supabase/migrations/` と `supabase db diff` の導入を**別PRで提案**する（本計画のスコープ外）。
5. **中長期の推奨**: 構造化データ・履歴・ベクトル索引は **Platform側の新規Supabase**（§F）が担い、
   Dashboard側Supabaseは現状の役割（KVフォールバック）のまま据え置く。
   → 第I部 §2.1 の `cc_*` テーブル案は、**Dashboard側ではなくPlatform側に置くのが設計上正しい**（§G-3）。

---

## E. 本番 / Preview 環境の分離方法

### E-1. 何が危険か（現状の実害リスク）

Preview Deployment は**同じ環境変数を引き継ぐのが Vercel の既定**。このままだと:

| 危険 | 具体例 |
|---|---|
| **本番データの汚染** | Preview上のチャット送信・掲示板投稿・手当提出が**本番KVに書き込まれる**（`/api/plan-store` は認証なし） |
| **本番スプレッドシート更新** | Preview上で返金明細を表示すると `SETTLEMENT_GAS_URL` 経由で本番シートに upsert される |
| **本番端末への誤通知** | Preview上の投稿が VAPID 経由で**全社員のスマホに push される** |
| **課金** | Preview の試行が `ANTHROPIC_API_KEY` / `GOOGLE_PLACES_API_KEY` の本番枠を消費 |
| **決済情報の露出** | `SQUARE_TOKENS` が Preview ビルドの実行環境に存在する |

### E-2. 分離の3層

**① Vercel の環境スコープを使い分ける（Vercel管理画面・人間が実施）**

Vercelの環境変数は `Production` / `Preview` / `Development` にスコープ指定できる。

```
Production のみ : SQUARE_TOKENS, SETTLEMENT_GAS_URL, GAS_API_URL, MARKETING_API_URL,
                  PLAN_GAS_URL, FEEDBACK_GAS_URL, TASKS_GAS_URL, PATIENT_DB_GAS_URL,
                  VAPID_*, DASHBOARD_PASSWORD(本番値), SETTLEMENT_OWNER_PASSWORDS
Preview  専用値 : KV_REST_API_URL/TOKEN（別KVインスタンス）, SUPABASE_*（別プロジェクト or 未設定）,
                  ANTHROPIC_API_KEY（上限付き別キー）, DASHBOARD_PASSWORD（Preview専用）,
                  CC_ENV=preview
Preview  未設定 : VAPID_*, SQUARE_TOKENS, *_GAS_URL, GOOGLE_PLACES_API_KEY, BLOB_READ_WRITE_TOKEN
両方     共通可 : SALONONE_API_KEY（読み取り専用。別キー推奨）, SALONONE_API_BASE
```

→ **未設定にしても壊れない**のが既存設計の強み。
　 `plan-store` は `configured:false` を返して localStorage 継続、Places未設定ならSalonOneのみでパトロール動作、
　 VAPID未設定なら通知機能が自動でオフ。**graceful degrade がすでに全体に効いている。**

**② コード側の安全弁（本計画で実装・Previewの事故を機械的に止める）**

`lib/env-guard.js`（新規・小さい純関数）:

```js
export function isProd(env) { return (env.CC_ENV || '') === 'production' || env.VERCEL_ENV === 'production'; }
export function assertWritable(env, op) {   // 外部に影響する操作の直前に呼ぶ
  if (isProd(env)) return;                  // 本番は従来どおり
  if (env.CC_ALLOW_PREVIEW_WRITE === '1') return;  // 明示的に許可した時だけ
  throw new PreviewBlocked(op);             // → 200 {ok:false, blocked:'preview'} を返す
}
```

適用対象（**外向き・不可逆な操作のみ**。読み取りとKV書込は止めない）:
`sendPush()` / `SETTLEMENT_GAS_URL` への書込 / Platform への書込系 / 将来の外部通知・SNS・Slides出力。

→ 万一 Preview に本番キーが残っていても、**通知の誤送信と本番シート更新だけは物理的に起きない**。

**③ Cron は Production のみ**（Vercelの仕様）

既存2本＋今後追加する Alert/Agent の Cron は Preview で動かない。
→ **Preview が勝手に本番データを書き換え続ける経路は構造的に存在しない。**

### E-3. Preview の見分け（運用上の事故防止）

`CC_ENV !== 'production'` のとき、画面上部に**常時バナー**を出す:
`⚠️ PREVIEW環境 — ここでの操作は本番に反映されません`
既存の上部バー（presence表示エリア）に1行足すだけで、UIレイアウトを変えない。

---

## F. naoru-ai-platform との接続方法

### F-1. 相手方の現状（調査結果）

| 項目 | 実態 |
|---|---|
| リポジトリ | `daikiwakabayash/naoru-ai-platform`（private） |
| 中身 | **Markdown 7本のみ**（README / ARCHITECTURE / DATABASE / AGENTS / DATA_SOURCES / PERMISSIONS / ROADMAP） |
| 状態 | `design/v0.1` — **設計スナップショット。アプリ・SQL・OAuth・Webhook・デプロイは未作成** |
| 想定機能 | F01〜F12（Knowledge Hub / Command Center / AI Chatbot / Marketing Analyst / Finance Analyst / Store Risk Agent / SNS Intelligence / Content Studio / Drive Sync / Zoom Sync / Alert Engine / Report Generator） |
| 進捗段階 | ROADMAP の **Phase 0（設計）**。Phase 1（隔離検証）以降は未着手 |

### F-2. ⚠️ 設計上の緊張点（判断が必要）

`naoru-ai-platform/ARCHITECTURE.md` §2・§8 は明確にこう定めている:

> - 「UI / BFF: **TypeScript・Next.jsを候補とする新規Vercelアプリ**」
> - 「認証・DB・ファイル: **新規Supabase**。既存Supabaseのテーブル、RLS、Auth、Storageを再利用しない」
> - 設計判断「**既存とは別のSupabase / Vercel** — 変更・障害・認証情報の影響を分離」
> - F02 の名称がそのまま「**NAORU Command Center**」

一方、今回のご依頼は「**既存Dashboardを NAORU Command Center へ進化させる／別アプリは作らない**」。
つまり **Command Center のUIをどちらが持つか**が、両設計で食い違っている。

**提案する解決（両者の意図を両立させる）**:

> **既存Dashboard = Command Center の「UI層」。naoru-ai-platform = その「データ・AI層」。**
> UIを新規Vercelアプリに作らず既存Dashboardに寄せる一方で、
> **DB・認証情報・ジョブ実行・取込は Platform 側に完全分離したまま**にする。
> ARCHITECTURE が守りたかったのは「**DBとキーと障害の分離**」であり、「UIが別アプリであること」自体ではない
> （同 §2 にも「UIと業務APIは初期には1アプリ内のモジュールでよい」とある）。

→ ただしこれは**設計文書の変更を伴う判断**なので、§J-6 の承認事項に含める。
　 承認されるまでは、Dashboard側は **Platform未接続でも完全に動く**状態のまま実装を進める。

### F-3. 接続方式（既存 `/api/salonone` と同じ「サーバー隠蔽プロキシ」パターン）

```
ブラウザ (index.html)
    │  ① fetch('/api/cc?fn=platform&resource=insights&shop=…')
    │     ※ Platformのトークンはブラウザに一切出さない
    ▼
Dashboard Vercel  api/cc.js（新規・最後の1枠）
    │  ② 呼び出し元を authz で確認（actor: role + shops[]）
    │  ③ リソース許可リストで検証（未登録リソースは即拒否）
    │  ④ AI_PLATFORM_TOKEN を付与し、actor の店舗スコープをクエリに強制付加
    ▼
naoru-ai-platform  （別Vercel・別Supabase）
    │  ⑤ Platform 側でも独自に認可（AGENTS.md §3 の共通実行契約）
    ▼
    返却: { status, facts, hypotheses, missing_data, citations, freshness, usage }
```

**厳守する境界**:

| ルール | 理由 |
|---|---|
| Dashboard は **Platform の Supabase に直接接続しない** | ARCHITECTURE §2「既存Supabaseのテーブル・RLS・Authを再利用しない」の裏返し。DB結合を作らない |
| Platform は **Dashboard の KV / GAS / Square に書き込まない** | ARCHITECTURE §1「元システムへの書き戻し経路は初期構成に持たない」 |
| 接続は **読み取り専用・片方向** | 同上 |
| `AI_PLATFORM_TOKEN` は **サーバー側のみ**。フロント・ログ・Previewへ出さない | PERMISSIONS §6「service roleや管理トークンをフロントエンド、プロンプト、ログ、Previewへ出さない」 |
| 店舗スコープは **Dashboard側で強制付加し、Platform側でも再検証** | 二重チェック。片方が壊れても漏れない |
| **Platform が落ちても既存機能は全て動く** | ARCHITECTURE §6「1つの同期障害で他ソースや既存SalonOneを止めない」 |

**レスポンス契約**（`AGENTS.md` §3 をそのまま採用）:
```
入力: tenant_id, actor_id, purpose, allowed_scope, time_range, source_versions, policy_version, request_id
出力: status, facts, hypotheses, missing_data, citations, proposed_actions, freshness, usage
```
→ UI側は **`facts`（確認できた事実）/ `hypotheses`（仮説）/ `missing_data`（データ不足）を必ず別々に表示する**。
　 これは「AIの推測を実績として出さない」ための表示規約であり、UIコンポーネント側で強制する。

### F-4. 未接続期間の扱い（Platform は Phase 0 なので、当面こちらが先行する）

Platform が使えるようになるまでは、**Dashboard内の既存データだけで同じUIを動かす**:

| 機能 | 当面のデータ源（Dashboard内） | Platform稼働後 |
|---|---|---|
| AI Insights | SalonOne実績＋既存 `lib/cohort.js` `plan-calc.js` | Platform `aggregate_snapshots` |
| 危険店舗アラート | 既存 `lib/patrol.js` `lib/meo.js` | Platform `alert_rules` / `alerts` |
| Knowledge Search | 既存 `naoru:faq:v1` / `naoru:knowledge:v1` | Platform `document_chunks`（Drive/Zoom横断） |
| Marketing Analyst | 既存 by-channel / soflmap / adspend | Platform `ad_daily_metrics` |
| Finance Analyst | 既存 `api/finance.js`（PDF取込） | Platform `financial_facts` |
| SNS Intelligence | **データ源なし → 機能を出さない** | Platform `social_posts` |

→ 切替は**同じUIのままデータ源だけ差し替える**（`CC_SOURCE=local|platform` をKVフラグで）。
　 UIを作り直さないので、Platform接続は**後から差し込める**。

---

## G. API / DB / Knowledge の境界

### G-1. 管理先の責務（Platform README の3分割を、Dashboardを含む4分割に拡張）

| 管理先 | 責務（正本） | 置いてはいけないもの |
|---|---|---|
| **SalonOne / Square / GAS** | 予約・売上・決済・patient の**取引正本** | — （既存のまま。書き戻さない） |
| **GitHub** | コード、仕様、プロンプト、**Source Registry**、指標定義・承認・運用ルール | 個人情報、顧客生データ、会議全文、財務明細、APIキー |
| **Google Drive** | 原本資料、議事録、財務資料（CURRENT/HISTORY/ARCHIVE） | アプリの実行DB・秘密管理の代替 |
| **Platform Supabase**（新規・未作成） | 構造化データ、検索索引、埋め込み、承認、同期状態、アラート、agent_runs | 原本資料・正式台帳の**唯一の**保管先 |
| **Dashboard KV**（既存） | **UI状態と社内コミュニケーション**: チャット、掲示板、イベント表、プレゼンス、投票、手当、UI設定、表示用キャッシュ | 経営指標の正本、監査記録、横断ナレッジの正本 |

→ **Dashboard KV の役割を「UIとコミュニケーション」に限定する**のが、この境界の要点。
　 現在ここに混在している `faq` / `knowledge` / `meo` / `soflmap` は、将来 Platform へ移す候補（§G-3）。

### G-2. 3つの層の責務（誰が数字を出すか）

```
┌─ API層（Dashboard api/） ────────────────────────────┐
│  ・認可（actor解決・店舗スコープ強制）                 │
│  ・外部キーの隠蔽（SalonOne / Places / Platform）      │
│  ・短時間処理のみ（maxDuration ≤ 60）                  │
│  ✗ ここで重い集計をしない ✗ LLM生成SQLを実行しない     │
├─ DB層（Platform Supabase / Dashboard KV） ───────────┤
│  ・数値の算出は「登録済み指標定義に基づくクエリ」で行う │
│  ・LLMは説明と仮説のみ。数値を作らない                 │
│  ・未取得 / ゼロ / 暫定 / 確定 を区別する（欠損≠0）    │
├─ Knowledge層（Platform document_chunks / 既存faq） ──┤
│  ・CURRENT を既定参照。HISTORY は過去版と明示          │
│  ・ARCHIVE は通常のAI検索から除外                      │
│  ・回答には必ず citations（出典版＋位置）を付ける       │
│  ・出典の権限を確認できなければ回答を拒否               │
└──────────────────────────────────────────────────────┘
```

**Dashboard に置く「純ロジック」と、Platform に置く「データ」の分け方**:
既存 `lib/*.js`（cohort / patrol / meo / plan-calc / salonone…）は**計算式であって数字ではない**。
これらは Dashboard に残し、**入力データだけを local ↔ platform で差し替える**。
→ 指標定義が1箇所に残るので、**Platform接続の前後で数字が変わらない**ことを検証できる。

### G-3. 既存データの移管方針（急がない）

| 現在のKVキー | 将来 | 移管タイミング |
|---|---|---|
| `naoru:faq:v1` | **Dashboard に残す**（社内FAQ・本部が直接編集する運用が確立している） | 移さない |
| `naoru:knowledge:v1` | Platform `documents` / `document_chunks` へ | Platform Phase 2（Drive同期）以降 |
| `naoru:meo:v1` の `history` | Platform `social_metric_snapshots` 相当へ | Platform Phase 3 |
| `naoru:soflmap:v1` | Platform `ad_daily_metrics` / `entity_mappings` へ | Platform Phase 3 |
| `naoru:chat:*` / `board` / `events` / `presence` | **Dashboard に残す**（社内コミュニケーション＝Platformの責務外） | 移さない |
| `naoru:allowance` / `thanksgift` / `accountmeta` | **Dashboard に残す**（人事・社内制度） | 移さない |

→ **移管は「両方に同じデータがある期間」を作ってから切り替える**（第I部 §2.1 の二重書きと同じ手順）。

---

## H. 機能追加の推奨順序

### H-1. 10機能の依存関係

```
            ┌─────────────────────────────────────────┐
            │ ① 承認センター  ② AI Agent Activity      │  ← 先に作る「ガードレール」
            │   （draft→承認→実行）（実行ログ・費用）   │     他の全機能がこの中に着地する
            └───────────────┬─────────────────────────┘
                            │
      ┌─────────────────────┼──────────────────────┐
      │                     │                      │
 ③ 危険店舗アラート    ④ AI Insights        ⑤ Knowledge Search
 （既存patrol/meo）    （既存KPI要約）       （既存faq/knowledge）
      │                     │                      │
      └─────────┬───────────┴──────────┬───────────┘
                │                      │
          ⑥ AI Chat（既存askaiの強化）  │
                │                      │
      ┌─────────┴──────────┐           │
 ⑦ Marketing Analyst  ⑧ Finance Analyst │
      └─────────┬──────────┘           │
                │                      │
          ⑨ Report Generator ───────────┘
                │
          ⑩ SNS Intelligence   ← 外部契約・媒体API・権利確認が前提（最後）
```

### H-2. 推奨順序と根拠

| # | 機能 | なぜこの順か | 前提 | Platform |
|---|---|---|---|---|
| 1 | **承認センター** | AIが「下書き→人が承認→実行」の器を先に作る。これが無いまま生成系を足すと**承認なしの外部送信経路ができてしまう** | なし | 不要 |
| 2 | **AI Agent Activity** | 何が動いて何円使ったかを最初から可視化。**暴走とコスト超過の唯一の検知手段** | なし | 不要 |
| 3 | **危険店舗アラート** | 検知ロジック（`lib/patrol.js` `lib/meo.js`）が**すでに完成している**。通知経路を繋ぐだけで最短で価値が出る | 第I部 §2.5 | 不要 |
| 4 | **AI Insights** | 既存KPIの要約。新データ源が不要で、`facts/hypotheses/missing_data` の表示規約を最初に確立できる | 3 | 不要 |
| 5 | **Knowledge Search** | 既存 `faq`/`knowledge` に対するサーバー側Retrieval（第I部 §2.3）。**⑥AI Chatの品質を決める土台** | 第I部 §2.3 | 後で強化 |
| 6 | **AI Chat** | 既存「AIに質問」タブの強化（**新規タブを作らない**）。⑤の出典付き検索＋④のKPIを束ねる | 4, 5 | 後で強化 |
| 7 | **Marketing Analyst** | 既存マーケ指標が揃っている（by-channel / soflmap / adspend）。⑥の上に専門ビューを載せる | 6 | 後で強化 |
| 8 | **Finance Analyst** | 既存 `api/finance.js` はPDF取込ベース。**会計正本・締め日・税区分が未確定**（ROADMAP §5）なので⑦の後 | 6 ＋ 財務責任者の確認 | 望ましい |
| 9 | **Report Generator** | ④〜⑧の出力を固定スナップショットで再現可能にする。**①承認センターが必須**（外部送信を伴うため） | 1, 4, 7, 8 | 望ましい |
| 10 | **SNS Intelligence** | 媒体API契約・アカウント権限・素材権利が未確認（ROADMAP Phase 5）。**データ源が無い状態で作らない** | 外部契約 | **必須** |

**①②を先に置く理由（最重要）**: ③以降はすべて「AIが何かを提案・生成する」機能。
承認と実行ログの器が無い状態で追加すると、後から権限を締めるのが極めて難しくなる（第I部 §2.4 と同じ構造の問題）。
**器を先に作れば、③〜⑩はその中に置くだけで自動的にガードされる。**

### H-3. 左メニューへの配置（既存構造を維持したまま自然に追加）

現在の5セクション（コミュニケーション / 経営・分析 / 海外 / 店舗運営 / 管理）は**そのまま**。
既存項目の並び・ラベル・アイコンも**変更しない**。追加は以下のみ:

```
コミュニケーション
  チャット / 重要掲示板 / 勉強会・イベント / 組織図
  🤖 AIに質問              ← ⑥AI Chat として中身を強化（★タブ自体は既存のまま）
  🔍 ナレッジ検索           ← ⑤ 新規

経営・分析
  全体管理シート / SalonOne売上 / マーケティング / サブスク分析 / コホートLTV/継続 / 事業計画
  ✨ AI Insights           ← ④ 新規（先頭付近に置くと「まず見る場所」になる）
  🚨 危険店舗アラート        ← ③ 新規（既存「AIパトロール」の隣）
  AIパトロール / MEO対策      ← 既存のまま
  📊 Marketing Analyst     ← ⑦ 新規（「マーケティング」タブのサブビューでも可）
  💰 Finance Analyst       ← ⑧ 新規
  📱 SNS Intelligence      ← ⑩ 新規（データ源が揃うまで非表示）
  📄 Report Generator      ← ⑨ 新規

海外 / 店舗運営            ← 変更なし

管理
  オーナー設定 / FAQ管理（AI）   ← 既存のまま
  ✅ 承認センター            ← ① 新規
  🤖 AI Agent Activity     ← ② 新規
```

**実装上の担保**:
- 追加項目は全て `rootOnly: true` で開始（本部・管理者のみ）→ 安定後に段階開放。既存の `canShow()` をそのまま使う。
- 各項目に `flag: 'cc_insights'` 等を持たせ、**KVフラグがOFFならメニューに出ない**。
  → フラグOFF時の左メニューは**現在と1pxも変わらない**。
- `tests/html-structure.test.js` が参照する識別子（`navSections` / `menuItems` / `authState` ほか）は改名しない。
- セクションが増えすぎないよう、**経営・分析が10項目を超えたらサブグループ化を再検討**（UIの見やすさ優先）。

---

## I. Rollback方針

### I-1. 3層のロールバック（速い順）

| 層 | 手段 | 所要 | 影響範囲 | 誰が |
|---|---|---|---|---|
| **① 機能フラグ** | KV `naoru:cc:flags:v1` の該当キーを `false` | **数秒**（再デプロイ・env変更なし） | その機能だけ | 運用者（画面から） |
| **② Instant Rollback** | Vercel ダッシュボードで直前の Production Deployment へ戻す | **数十秒** | デプロイ単位（コード全体） | 人間 |
| **③ データ復旧** | `cc_events` / スナップショットから再構成 | 分〜時間 | 該当データ | 人間＋確認 |

### I-2. なぜフラグを環境変数にしないのか（設計判断）

Vercelの環境変数は**ビルド時に注入される**ため、値を変えても**再デプロイしないと反映されない**。
つまり env フラグは「Instant Rollback」にならず、さらにガードレール#5（env変更禁止）にも抵触する。

→ **フラグはKVに置く。**

```
naoru:cc:flags:v1 = {
  cc_insights:false, cc_alerts:false, cc_chat:false, cc_knowledge:false,
  cc_marketing:false, cc_finance:false, cc_sns:false, cc_report:false,
  cc_agent:false, cc_approval:false,
  cc_source:'local',            // 'local' | 'platform'
  cc_authz:'off',               // 'off' | 'log' | 'warn' | 'enforce'
  _updatedBy:'…', _updatedAt:…
}
```

- `/api/health` がこのフラグを返し、フロントは起動時＋ポーリングで取得。
- 「管理 > 承認センター」内に**フラグ操作パネル**（root専用・変更は `cc_events` に記録）。
- **キルスイッチ**: `cc_all:false` で新機能を一括停止（既存機能には一切影響しない）。
- ⚠️ KV障害時は**フラグ取得失敗＝全てOFF扱い**（fail closed）。既存機能は従来どおり動く。

### I-3. ロールバック可能な変更単位（ガードレール#8の具体化）

**1 PR = 1機能 = 1フラグ = 1デプロイ。** 以下をマージ条件とする:

| 条件 | 確認方法 |
|---|---|
| フラグOFFで**既存と完全に同じ挙動**になる | Preview でフラグOFF状態を目視＋`npm test` |
| 既存ファイルの変更が**追加のみ**（既存関数の書き換えを含まない） | `git diff` レビュー |
| DBスキーマ変更を**含まない**（含むなら別PR＋人間実行） | §J-3 |
| 環境変数の**追加を必須としない**（未設定でも動く） | 未設定でPreview起動を確認 |
| 既存の `npm test` 21ファイルが**全て通る** | CI（§B-3）または手元実行 |
| ロールバック手順がPR本文に**1行で書ける** | PRテンプレート |

→ この条件を満たせない変更は、**満たせる単位に分割してから出す**。

### I-4. データ側のロールバック原則

- **破壊的変更をしない**: 第I部 §2.2 の追記型イベントログにより、上書きではなく「次の版」を積む。
  → ロールバック＝「前の版を CURRENT に戻す」であり、データ削除を伴わない。
- **DBの後方互換を優先**（Platform ROADMAP §4 と同じ原則）: 追加列・追加テーブルのみ。
  破壊的ロールバックを自動実行しない。
- **削除は soft delete**（`deleted_at`）。物理削除は人間の承認後のバッチのみ。
- Platform接続を切り戻す場合は `cc_source:'local'` に戻すだけ（§F-4）。**UIは変わらない。**

### I-5. 事故シナリオ別の初動

| 事故 | 初動 | 次 |
|---|---|---|
| 新機能でエラーが多発 | ① フラグOFF | ログ確認 → 修正PR |
| 本番の見た目が崩れた | ② Instant Rollback | precompile/Tailwindのフォールバックを確認 |
| 通知が誤送信された | ① `cc_alerts:false` ＋ VAPID停止判断 | 送信先・件数を `cc_events` から特定 |
| Platform応答が異常 | `cc_source:'local'` | Platform側の調査（Dashboardは既存データで継続） |
| 権限漏れの疑い | `cc_authz:'enforce'` ＋ 該当フラグOFF | 影響範囲調査 → 報告 → 是正後に再開 |
| KV障害 | 自動で fail closed（新機能OFF・既存はlocalStorage継続） | KV復旧を待つ |

---

## J. 本番影響がある操作の承認ポイント

> 以下は**私（Claude Code）が単独で実行しない操作**。
> 該当する場面では作業を止め、提案内容と手順を提示して承認を求める。

| # | 操作 | 承認者 | 承認時に提示するもの | 現在の方針 |
|---|---|---|---|---|
| **J-1** | **mainへのmerge / Production Deployment更新** | 技術責任者 | PR差分、Preview URL、確認結果、`npm test` 結果、ロールバック手順 | **人間承認前にmergeしない** |
| **J-2** | **Environment Variables の追加・変更・削除** | 技術責任者 | 変数名、用途、スコープ（Prod/Preview）、未設定時の挙動。**値は人間が入力** | **私は設定しない。一覧を提案するのみ** |
| **J-3** | **Supabase のschema変更・migration実行** | 技術責任者＋データ所有者 | `docs/sql/*.sql`（追加のみ）、影響範囲、ロールバックSQL、検証手順 | **私は実行しない。SQLを置くだけ** |
| **J-4** | **Cron の追加・変更** | 技術責任者 | 実行内容、頻度、想定実行時間、失敗時の影響、`CRON_SECRET` の要否 | Alert/Agent で1〜2本追加を提案（§H） |
| **J-5** | **Webプッシュの一斉送信を伴う機能の有効化** | 運用責任者 | 送信条件、対象者数、dedupe/cooldown、停止手順 | フラグOFFで出荷 → 承認後にON |
| **J-6** | **naoru-ai-platform との接続開始／設計文書の方針変更** | 技術責任者＋経営 | §F-2 の緊張点（Command CenterのUIをどちらが持つか）、接続範囲、トークン権限 | **未承認。当面はlocalデータで先行実装** |
| **J-7** | **Vercel プラン変更（Hobby→Pro）** | 経営 | 現在11/12関数、cron頻度・実行時間の制約、費用 | Function枠が尽きる段階で提案 |
| **J-8** | **`CC_AUTHZ` を `enforce` にする（認可の強制開始）** | 技術責任者 | `log`/`warn` 期間の拒否件数（**0件が条件**）、影響しうる画面の一覧 | 段階導入（第I部 §2.4） |
| **J-9** | **KVキーの削除・構造変更・大量書換** | 技術責任者 | 対象キー、件数、バックアップ手段、復元手順 | 実行しない（追加のみ） |
| **J-10** | **外部への送信（Slides出力 / 外部通知 / SNS / 広告変更）** | 業務所有者（操作ごと） | 内容、宛先、素材権利、実行者、有効期限 | **初期対象外**。承認センター（§H-1 ①）の器だけ先に作る |
| **J-11** | **GAS（本番スプレッドシート）への書込を伴う変更** | 業務所有者 | 対象シート、書込内容、既存データへの影響 | 返金明細書の既存経路以外は追加しない |
| **J-12** | **`SQUARE_TOKENS` / `SALONONE_API_KEY` に触れる変更** | 技術責任者 | 変更理由、影響する店舗、ロールバック | 触れない（読み取り用途のまま） |

**私の標準動作**: 上記に該当する作業が必要になった時点で **手を止め、該当番号を挙げて承認を求める**。
承認が無い状態で「とりあえず進めておく」ことはしない。

---

## 次のステップ（ご確認いただきたいこと）

1. **§F-2 の判断** — Command Center のUIを既存Dashboardに置く方針で、`naoru-ai-platform` 側の設計文書
   （ARCHITECTURE §2・§8）を更新してよいか。※文書の更新自体も別リポジトリへのPRとして承認を得る形にする。
2. **§H-2 の順序** — ①承認センター ②AI Agent Activity を先に作る案でよいか
   （見た目の派手さは③以降だが、ここを飛ばすと後から権限を締められなくなる）。
3. **§E-2 の Preview 分離** — Preview用の別KV／別Anthropicキーを用意していただけるか。
   用意できない場合は、**Preview では新機能のフラグを一切ONにしない**運用で代替する。
4. **§A-2 の棚卸し** — `api/tasks.js`（`TASKS_GAS_URL`）と `PATIENT_DB_GAS_URL` は現在使用中か。
   未使用ならFunction枠を回収でき、`api/cc.js` に余裕が生まれる。
5. **着手の可否** — 上記が固まる前でも、**第I部 Phase 0〜2（UIも挙動も変わらない内部改善）** は
   `feature/cc-foundation` で先行できる。ここから始めてよいか。

**本ドキュメントの時点では、mainへのmerge・本番反映・環境変数変更・DB変更は一切行っていない。**
