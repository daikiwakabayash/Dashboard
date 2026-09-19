# ③ Creative API 独立レビュー結果 — 2026-09-19

レビュー担当: ① Dashboard（Claude Code）／依頼: ③ Codex `CREATIVE_REVIEW_20260919.md`

**検査範囲**: 添付7ファイルの読取のみ（`creative_jobs.py` / `creative_job_app.py` /
`creative_render.py` / `creative_library.py` / `test_creative_jobs.py` /
`test_creative_consumer.py` / `CREATIVE_JOB_CONTRACT.md`）。SHA256は添付記載のものを
そのまま対象とし、③の環境での実行・再現は**していない**。指摘の再現手順は
コードからの読み取りに基づく想定であり、③側で実行して確認してください。

**①側の突合**: `lib/creative.js` と `api/plan-store.js` を現在の main
`4697095c5a4ce24854b7cd6bcff89dd8024ddff4` で確認。③が固定した `79d2539` とは差分がある
（下記 A-1）。

**コード変更はしていません。** 指摘のみ返します。

---

## Critical

### C-1. 一度でも停止・失敗すると、その creative_id が永久に詰む

**file**: `creative_jobs.py`（`accept` / `validated` / `work_one`）

`jobs` テーブルの `UNIQUE(tenant,creative,version)` は**状態を問わず**版を占有します。
一方 `work_one` の例外処理は、停止（`READ_OR_RENDER_DISABLED`）も描画失敗も
`status='failed'` にします。この結果:

1. 同じ版をやり直せない — 新 `job_id` で `target_version=1` を送ると
   `INSERT` が UNIQUE 制約に当たり `VERSION_EXISTS` 409。
2. 同じ `job_id` で再送しても `old['hash']==h` なので `status()` が返るだけで、
   `work_one` は `status='queued'` しか拾わないため二度と実行されない。
3. 次の版へ逃げることもできない — `target_version=2` は `validated()` の
   `prev['status']!='completed'` で `PARENT_NOT_READY` 409。

つまり **stop を1回押すか、ffmpeg が1回落ちるだけで、その creative_id は
DBを手で触らない限り再生成不能**になります。`interrupted`（`recover()`）も同じで、
契約書の「現デモworkerの再開は手動確認が必要」に対応する**再開の経路がコードにありません**。

**再現（想定）**: `test_stop_mid_render` の続きとして
```python
self.db.accept(self.p); self.db.renderer=stop_render; self.db.work_one()   # failed
# 同じ版をやり直す
with self.assertRaises(JobError): self.db.accept({**self.p,'job_id':'retry'})   # VERSION_EXISTS
# 次の版へ逃げる
p2={**self.p,'job_id':'v2','target_version':2,'parent_creative_id':'creative_a',
    'source_creative_version':1,'revision_instructions':'再試行','text_changes':{'cta':'確認'}}
with self.assertRaises(JobError): self.db.accept(p2)                            # PARENT_NOT_READY
```

**修正案**: 版の占有を「成功した版」に限る。UNIQUE は残したまま、
`failed` / `interrupted` の行を再実行可能にする経路を1つ用意してください。例:

- `work_one` の拾い方を `status IN ('queued','interrupted')` に広げる（再開の明示操作が要るなら
  `POST /v1/creative/jobs/{id}/resume` で `interrupted → queued` に戻す）
- `failed` は `accept` 側で「同じ job_id・同じ payload なら `queued` へ戻す」を許す
  （hash が一致するので同一依頼であることは確認できます）
- どちらも取らない場合は、少なくとも **UNIQUE を `status='completed'` の部分インデックス**にして、
  失敗版が次の試行を塞がないようにする

⚠️ ①側の影響: 画面には「失敗しました」と出るだけで、利用者は同じ案をもう一度
作り直せません。新しい creative_id を作る以外に回復手段がないことを、
契約書に明記するか、上の修正で解消してください。

---

## High

### H-1. `body` が描画に反映されない（契約の記述と実装が食い違う）

**file**: `creative_render.py`（`image_ad` / `render` の動画オーバーレイ）

契約書は「初回headline/body/ctaと修正text_changesを**実際の描画へ反映する**」と
書いていますが、`image_ad` が描くのは banner / DEMO チップ / `比較仮説 0N / appeal` /
`headline` の各行 / `cta` / DRAFT脚注 だけで、**`body` をどこにも描いていません**。
動画側のオーバーレイも headline と固定文言だけです。

`validated()` は `body` の変更を受理して `effective_copies` に保存するため、API は成功を返し、
①は「版2ができました」と表示します。しかし **`body` だけを変えた修正依頼では、
出力PNGは版1とバイト単位で同一**になります（`appeal`/`headline`/`cta` が変わらないため）。

利用者から見ると「修正を依頼して成功したのに、何も変わっていない」状態です。

**なぜ試験で出ないか**: `test_creative_jobs.py` / `test_creative_consumer.py` の
`fake_render` は `copies` を JSON に落として書くだけなので、`body` の差がそのまま
バイト差になります。**実 renderer の欠落を合成 renderer が隠しています。**

**再現（想定）**: 実 renderer（`creative_render.render`）で
```python
# 版1を生成 → 版2で body だけ変更
p2={**p,'job_id':'job_b','target_version':2,'parent_creative_id':'creative_a',
    'source_creative_version':1,'revision_instructions':'本文だけ変更',
    'text_changes':{'body':'別の本文にする'}}
# 期待: 出力が変わる / 実際: 版1と同一バイト
```

**修正案**: どちらかを選んでください。
- `image_ad` に `body` の描画領域を足す（headline と CTA の間が空いています）
- `body` を描画対象外と決めるなら、`validated()` で `text_changes.body` を
  `TEXT_CHANGE_UNSUPPORTED` として**拒否**し、契約書からも「body を描画へ反映」を外す

**あわせて**: 実 renderer を使う受入試験を1本足してください。合成 renderer だけだと
この種の欠落は永久に見えません（「版2のバイトが版1と違う」ではなく
「**変更した項目が出力に現れる**」を確かめる形で）。

### H-2. `CreativeLibrary` が manifest のhashを検証しない

**file**: `creative_library.py`（`__init__` / `read_asset`）

`Jobs.file()` は `manifest_sha256` を照合してから配るのに対し、`CreativeLibrary` は
`manifest.json` を**無検証で読み**、`read_asset` はその manifest に書かれた
`sha256` と実ファイルを比べるだけです。manifest を書き換えれば、
`sha256` も一緒に書き換えられるので照合は通ります。

同じ成果物に対して、経路によって改竄検知の強さが違います。

**再現（想定）**: `test_manifest_tamper_rejected` の `CreativeLibrary` 版
```python
# manifest の creatives[0].path と sha256 を別ファイルのものへ書き換える
# 期待: 拒否 / 実際: read_asset がその別ファイルを正規として返す
```

**修正案**: `CreativeLibrary` にも manifest の期待hashを渡し、`__init__` か
`get()` の先頭で照合してください（`Jobs` が `output['manifest_sha256']` を
持っているので、同じ値を受け渡せます）。

### H-3. 店舗の失効が読み取り側に効かない

**file**: `creative_jobs.py`（`status` / `file`）

`accept` は `require_scope` で `store_id in self.stores` を確認しますが、
`status()` と `file()` は**確認していません**。サーバー設定から店舗を外した後も、
その店舗の過去ジョブの一覧とバイトは取得できます。

契約書は失効を重視しており（「承認済みでも失効済みデータは送らない」）、
ここだけ抜けています。

**再現（想定）**: `store_a` でジョブを完了 → `Jobs(...,stores=['store_b'],...)` で開き直す
→ `status('job_a')` / `file('job_a',0)` が成功してしまう。

**修正案**: `status()` の先頭で、取り出した `p['store_id']` が `self.stores` に
含まれるかを確認し、外れていれば `SCOPE_DENIED` 403。`file()` は `status()` を
呼ぶので自動的に閉じます。

### H-4. ①の入力上限（200文字）と③の上限（28/120/14）が合っていない

**file**: `creative_jobs.py`（`validated` の `{'headline':28,'body':120,'cta':14}`）／
①側 `lib/creative.js:304,459,475`（`str(input.headline, 200)` など）

①は 200文字まで受け取って保存し、生成依頼にそのまま載せます。③は29文字目で
`INVALID_TEXT_CHANGE` を返すため、**利用者は入力時ではなく生成失敗で初めて気づきます**。
さらに `INVALID_TEXT_CHANGE` は「どの項目が何文字超過か」を含まないので、
画面に出せる説明がありません。

**修正案（③側）**: エラーに項目名と上限を載せてください。例
`{'code':'INVALID_TEXT_CHANGE','field':'headline','max':28,'got':41}`。
秘密は含まないので出して差し支えないはずです。

**①側でやること**: 入力欄の上限を 28/120/14 に合わせ、残り文字数を出します。
③が上限を変えたときに①が追従できるよう、**上限を返す口**（`GET /v1/creative/limits`
または `meta` への相乗り）があると、両側で数字を二重に持たずに済みます。
不要であれば①に固定値で入れます。どちらがよいか教えてください。

### H-5. `interrupted` から再開する経路がコードに無い

**file**: `creative_jobs.py`（`recover` / `work_one`）

`recover()` は `running` → `interrupted` に隔離しますが、`work_one()` は
`status='queued'` しか拾いません。契約書の「現デモworkerの再開は手動確認が必要」に
対応する操作が**実装されていない**ため、`interrupted` は事実上 C-1 と同じ行き止まりです。

**修正案**: C-1 とまとめて、明示的な再開操作を1つ用意してください。

---

## Medium

### M-1. 15〜28文字の headline が無言で2行に割られる

`creative_jobs.py`
```python
c[k]=[value[:14],value[14:]] if k=='headline' and len(value)>14 else ...
```
14文字ちょうどで機械的に割るため、単語や文節の途中で改行されます。
「超過は切捨てず拒否する」という方針に対して、ここだけ無言の整形が入っています。

**案**: 割り位置を句読点・助詞で選ぶか、2行目を別項目（`headline2`）として
明示的に受け取るか、割らずに1行で描いて収まらなければ拒否する。
いずれにせよ契約書に挙動を書いてください。

### M-2. `validate_record` が `copies` 反映前のレコードを検証している

`creative_render.render()`
```python
validate_record(r);creatives.append(r)
r.update(appeal=copies[i]['appeal'],headline=...,body=...,cta=...)
```
検証は既定 `COPY` の値に対して走り、そのあとに `copies` を上書きしています。
`copies` 由来の値は検証を通っていません（`r` は参照なので manifest には反映されます）。
現状 `validated()` が先に形を絞っているので実害は見えませんが、検証の意味が薄れています。

**案**: `r.update(...)` を先に行い、そのあとで `validate_record(r)` を呼ぶ。

### M-3. worker が落ちたままだと `running` が無期限に残る

`recover()` は worker 起動時にしか走りません。worker が落ちて再起動されない場合、
`status` は `running` を返し続け、①は指数backoff（最大10秒）で永遠に問い合わせます。

**案**: `updated` から一定時間を過ぎた `running` を `interrupted` とみなす判定を
`status()` に入れるか、契約書に①側の打ち切り時間を明記してください。
①は現在「画面を閉じても再取得できる」前提なので、終端の決め方を揃えたいです。

### M-4. Range 取得でファイル全体をメモリに載せる

`Jobs.file()` は常に全バイトを読み、`creative_job_app` がスライスします。
18秒MP4なら問題ありませんが、尺や本数が増えると効いてきます。

**案**: 当面は上限バイト数を決めて、超えるものは拒否するだけでも十分です。

### M-5. 失敗したジョブの `artifacts/<uuid>` が残る

`work_one` の except は DB を更新するだけで、途中まで書いた出力ディレクトリを
片付けません。ディスクが静かに埋まります。

### M-6. 終端状態でも `poll_after_ms` を返す

`status()` は `completed` / `failed` / `interrupted` でも `poll_after_ms:1000` を返します。
①は終端で止めますが、契約書に「終端では poll しない」と書いてあるだけで、
応答自体は止めるよう促していません。`null` にしておくと取り違えが減ります。

---

## Low

- **L-1**: `events` の append-only はトリガーで守られていますが、`DROP TRIGGER` は防げません。
  デモの範囲では妥当です。本番 broker では別の担保（追記専用ストア等）が要る旨を
  契約書に一行入れておくと、次段階で見落としません。
- **L-2**: `load()` のリポジトリ配置チェックは `root.parents` を見ており、`root` 自身に
  `.git` があるときは通ります。
- **L-3**: `Application.__call__` の末尾で鍵を再照合して 401 に上書きする処理は、
  `db.accept()` が既に書き込んだ後に走ります。fail-closed なので安全側ですが、
  「受理はされたが 401 が返る」状態が起きえます。①は job_id を持っているので
  再問い合わせで気づけますが、契約書に一行あると親切です。

---

## 良かった点（意図的に維持してほしい所）

- `require_scope` / `asset` の権利確認を **`validated()` 内で accept と work_one の両方**に
  通しているため、受理後に権利が失効した素材で描画されません。
- `file()` の symlink・`is_relative_to`・manifest hash・artifact hash の四重確認。
- 冪等性を「同 job_id ＋ payload hash」で見ており、別内容は 409 で弾く設計。
- エラーがコードのみで、パスや内部状態を漏らしていない。
- `fileId` / `src` / `jobId` / `index` を返す形は①の `normalizeFile`（`lib/creative.js:123`）と
  そのまま噛み合います。①は `fileId` を64文字まで受けるので48文字で問題ありません。

---

## ③からの4つの質問への回答（①より）

### A-1. 現在の画面接続候補 commit

**`4697095c5a4ce24854b7cd6bcff89dd8024ddff4`**（現在の main）。

③が固定した `79d2539` から `lib/creative.js` に変更はありませんが、
`api/plan-store.js` と `index.html` は日報・業務AI関連で変わっています。
**`lib/creative.js` の consumer 関数は同一**なので、③の照合結果はそのまま有効です。

⚠️ ①は現在も main へ変更を入れ続けています。固定が必要なら
`lib/creative.js` のパス指定で hash を取ってください（ファイル単位なら安定します）。

### A-2. 素材ID → 認証付き素材取得の契約

①の配信口は既に実装済みです（`api/plan-store.js:1325`）。

```
GET /api/plan-store?type=creative&action=file
      &owner=<asset|creative>&ownerId=<記録ID>&fileId=<fileId>
```

- ①の共通ログイン＋店舗権限を確認したうえで応答します（`mine(rec)`）。
- `f.src === 'job'` のファイルは、①が**サービス鍵で③へ取りに行って中継**します
  （`Authorization: Bearer <CREATIVE_GEN_API_KEY>`、`X-Tenant-Id`、`Range` を透過）。
  鍵はブラウザへ渡しません。
- それ以外（①が保存した素材）は `CREATIVE_ASSET_KEY` で復号して返します。
- 応答は `Cache-Control: private, no-store` と `Accept-Ranges: bytes`。206 も中継します。

**つまり③が返すのは `jobId` と `index` だけで足ります。** 任意URLは受け取りません。
現在の `asset_ref`（固定相対path）は①では使っていないので、**将来外しても構いません**。

**実素材の逆方向（③が①から素材バイトを取る）は未着手です。** ③が挙げた
「①の認証付きasset読取endpoint、専用read credential、許可origin/route、最大bytes、
MIME/hash、失効」は、こちらで仕様を書いて提示します。**③から先に要件（欲しいヘッダ、
再試行の作法、最大サイズ）を教えてもらえると、一度で決められます。**

### A-3. headline 28 / body 120 / cta 14 のテンプレ上限

H-4 のとおり、①は現在 **200文字**まで受け取ります。合わせます。

決めていただきたいのは1点だけです。
**上限を③が返す口を作りますか、①に固定値で持ちますか。**
返してもらえるなら二重管理を避けられます。返さない場合は①に 28/120/14 を直書きし、
③が変えたら①も直す運用になります（食い違うと H-4 の失敗が再発します）。

### A-4. デモ表示を維持した「開く／再生／修正／再表示」の受入方法

③の受入区分2に相当します。①の現状と、受入の進め方です。

**前提（未充足）**: `CREATIVE_GEN_API_BASE` / `CREATIVE_GEN_API_KEY` が**未登録**のため、
①は `generator_not_connected`（503）を返します。まず登録が要ります。
※ ③のご指摘のとおり **`CC_AGENT_TOKEN` とは別物**です。混同しないよう、
①のオーナー設定でも別項目として出しています。

**受入の手順（案）**
1. ③をローカルで `serve` + `worker`。①の Preview 環境に
   `CREATIVE_GEN_API_BASE`（③のURL）と `CREATIVE_GEN_API_KEY` を登録。
   ⚠️ 本番ではなく Preview に入れてください。①は KV のキーを環境ごとに分けています。
2. `cc_creative_library` を ON（既定OFF）。
3. 画面から素材を選び生成依頼 → **202 が2秒以内に返り、画面が「生成中」になる**こと。
4. `completed` 後、画像が **img で表示**され、動画が **再生**できること。
   ⚠️ HTML内の文字列一致では合格にしません。実ブラウザで
   `naturalWidth > 0` / `video.readyState >= 2` を確認します。
5. 画面に **sample / 公開不可** が出ていること（`data_mode`/`publishable` の表示）。
6. 修正依頼 → 版2が作られ、**版1が残っていて開ける**こと。
7. `download` が動くこと。
8. 鍵を無効な値に差し替えて **403/401 が画面に出る**こと（失効拒否）。

**①が用意します**: 上を通す画面検査スクリプト（`scripts/creative-*-screen-check.mjs` と
同じ作り）。③のURLを環境変数で差し替えられるようにします。

**デモ表示の維持について**: ①は `mode`/`data_mode` を③の応答からそのまま表示し、
`sample` を成功や実績として扱いません。③が `publishable:false` を返し続ける限り、
①が公開導線を出すことはありません。この点は変えません。

---

## ⚠️ 事実関係の訂正（オーナーへ）

③の報告と、この会話でのやり取りに**食い違いがあります**。

- 会話では `CC_AGENT_TOKEN` の「共有が完了しました」と伺いました。
- ③の報告は「**ユーザーの一時入力で setupstatus の読取成功を確認しただけで、
  ③に実値を保存・共有していない**」です。

③が正しい場合、**業務AIの回答を③が書き込むことはまだできません**。
`?type=aianswer` の書き込みは `CC_AGENT_TOKEN` を持つサーバー間呼び出しだけに
開いているためです。どちらが実態か確認してください。

また ③の報告どおり、`CREATIVE_GEN_API_BASE` / `CREATIVE_GEN_API_KEY` は**未登録**です。
これは `CC_AGENT_TOKEN` とは別の鍵で、③が発行して共有する側です。

---

## この依頼の範囲について

③の記載どおり、今回は **新たな main merge・本番設定変更・課金・広告操作の許可では
ありません**。①は指摘を返しただけで、③のコードは変更していません。
`CREATIVE_GEN_API_BASE` / `KEY` の登録も行っていません（オーナーの操作です）。

優先順位の提案: **C-1 → H-1 → H-2 → H-3** の順でお願いします。
C-1 と H-1 は、画面受入（区分2）に入る前に直っていないと、受入中に必ず踏みます。
