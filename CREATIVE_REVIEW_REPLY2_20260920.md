# ③ 修正版 再レビュー結果（creative-library-1 / 16ファイル）

- 対象: `CREATIVE_REVIEW_FIXED_20260920.md` 記載の16ファイル
- 検査者: ①（独立レビュー）
- 検査日: 2026-09-19（JST）
- 検査方法: 静的読取 **＋ 隔離サンドボックスへ展開しての実行**
- ③のコードは一切変更していない。GitHubへの投稿・push・環境変数登録・本番操作は行っていない。

---

## 0. 対象の同一性

添付16ファイルをmarkdownから抽出し、記載SHA256と照合した。**16/16一致**。
以下の指摘はこの16ファイルのバイト列に対するもの。

| 実行したもの | 結果 |
| --- | --- |
| `test_creative_jobs.py` | 22件 合格 |
| `test_creative_library.py` | 16件 合格 |
| `test_creative_deployment.py` | 5件 合格 |
| 合計 | **43/43 合格**（Python 3.11.15） |

**未実行**: `test_creative_consumer.py`（Node未導入）、実Pillow/FFmpegレンダリング（未導入）。
したがって③の「507件=504合格+旧版期待失敗3」および `CREATIVE_REAL_RENDER_REVISION_RESULT.json` の
「本文だけ変更してPNG/MP4のデコード後画素が変わる」は**私の側では再現していない**。
H-1については実行の代わりに座標計算で検証した（下記）。

---

## 1. 初版指摘の再検証 — C-1 / H-1〜H-5 はすべて閉じた

| 指摘 | 判定 | 根拠（実行または行） |
| --- | --- | --- |
| **C-1 / H-5** 中断ジョブが暗黙に再実行される | **閉** | `retry(job,actor,reason)` は `failed/interrupted` のみ受理し `validated()` を再実行、`RETRY_STATE_INVALID(409)` / `OPERATOR_REQUIRED(403)` を持つ。通常POSTの再送は `old['hash']==h` で `status()` を返すだけで再queueしない。`test_explicit_retry_after_crash` / `test_stop_requires_manual_release_then_retry` 合格を確認。 |
| **H-1** 本文が見出し・CTAに重なる／箱から溢れる | **閉** | `draw_body()` 追加。1:1/4:5/9:16 と動画の4カンバスで最大長（body 120字=4行）を座標計算した。下表のとおり全て余白あり。 |
| **H-2** manifest差し替えが検出されない | **閉** | `CreativeLibrary.__init__(root, expected_manifest_sha256)` ＋ `verify_manifest()` を `__init__` と `get()` の両方で実行。`test_manifest_rewrite_rejected` 合格。 |
| **H-3** `status()` が権限を再確認しない | **閉** | `status()` が `require_scope(p)` を呼ぶ。`file()` は `status()` 経由なので同時に閉じる。`test_revoked_store_read_rejected` 合格。 |
| **H-4** 文字数上限が①へ伝わらない | **閉** | 実際にWSGIを叩いて確認した（下記）。 |
| **M-2** 検証前に `r.update()` | 閉 | `r.update(...)` → `validate_record(r)` の順。 |
| **M-5** 失敗時に中間生成物が残る | 閉 | `except` 節で `shutil.rmtree(out)`。 |

### H-1 の座標検証（本文120字 = 4行 × 行送り32px、フォント28px）

| カンバス | 見出し下端 | 本文 | CTA箱 上端 | 余白 |
| --- | --- | --- | --- | --- |
| 1:1 (1080) | 649 | 720〜844 | 895 | 51px |
| 4:5 (1350) | 919 | 990〜1114 | 1165 | 51px |
| 9:16 (1920) | 1489 | 1560〜1684 | 1735 | 51px |
| 動画 (箱 1360〜1810) | 1493 | 1550〜1674 | 1710 | 36px |

見出し（最大28字＝14字×2行, 57px）も本文開始位置と71px空く。**重なり・溢れとも解消**。

### H-4 の実測（WSGI直接呼出）

```
GET /v1/creative/limits
200 {"api_version":"creative-library-1","template_version":"abstract-card-v1","mode":"sample",
     "text_limits":{"headline":28,"body":120,"cta":14},
     "revision_instructions_max":1000,"max_artifact_bytes":67108864}

POST /v1/creative/generate  (body = 121文字)
422 {"ok":false,...,"error":{"code":"INVALID_TEXT_CHANGE","field":"body","max":120,"got":121}}
```

①はこの `limits` を入力欄上限に使う方向で了解した（§4）。

---

## 2. 新規指摘

### High-1 — `stop` がworkerプロセスごと落とし、監督起動ではサービス全体が停止する

**場所**: `creative_job_app.py`（workerループ）、`start_creative_service.py`

```python
# creative_job_app.py
try:
 while True:
  if not jobs.work_one():time.sleep(.5)
except (KeyboardInterrupt,JobError):pass     # ← work_one() 冒頭の check() が 503 を投げる
```

`work_one()` の1行目は `self.check()` で、停止中は `JobError('READ_OR_RENDER_DISABLED',503)` を投げる。
これが `except (KeyboardInterrupt,JobError)` に捕まり、**ループを抜けてworkerが正常終了(0)する**。
`start_creative_service.py` は `if any(p.poll() is not None for p in children):return 1` なので、
続けて gunicorn も SIGTERM で落とす。

**再現（実施済み）**
1. `python3 creative_job_app.py worker` を起動 → プロセス生存を確認
2. 別プロセスで `python3 creative_job_app.py stop`
3. 2秒後 worker プロセス数 = **0**
4. `stopped=1` のまま worker を再起動 → **即座に exit 0**（10秒timeoutを待たず終了）

**影響**
- 契約は「local stopは新job/処理中checkpoint/asset返却を止める」としており、`status()` は `check()` を呼ばないので
  停止中も状態照会は返る設計に見える。しかし実際にはAPIごと落ちるため、①からは状態照会すら不能になる。
- `stopped=1` が永続するため、監督プロセスを外部のプロセスマネージャで自動再起動する構成では
  **起動 → worker即死 → 全体停止 → 再起動 のクラッシュループ**になる。解除は `resume` CLIを先に打つしかない。

**提案**: ループ内で `READ_OR_RENDER_DISABLED` だけを捕捉して `sleep` を続け、それ以外の致命例外でのみ終了する。
`except JobError` で全JobErrorを握りつぶしている点も、想定外コードを静かに終了へ変えるので分離したい。

---

### High-2 — `CREATIVE_BIND=0.0.0.0` を許可している（平文HTTP・Bearerのみ）

**場所**: `start_creative_service.py`

```python
host=os.environ.get('CREATIVE_BIND','127.0.0.1')
if host not in ('127.0.0.1','0.0.0.0'):raise ValueError('bind')
...
[sys.executable,'-m','gunicorn','--bind',f'{host}:{port}', ...]
```

一方で `creative_job_app.py` の先頭docstringは「**No public bind** and no real asset ingestion」、
契約書 §冒頭は「HTTPローカル実装は creative_job_app.py（**デモ限定・127.0.0.1**）」と書いている。
配備候補ファイルだけが `0.0.0.0` を明示的に許可しており、記述と実装が食い違う。

**影響**
- gunicorn は TLS終端を持たないので、`0.0.0.0` に開くと `Authorization: Bearer <サービス鍵>` が平文で流れる。
- `preflight()` は bind を一切検査しない（承認フラグ・鍵長・素材台帳・ディスクのみ）。
  つまり「公開bindしていないこと」を検査する場所が現状どこにもない。
- 環境変数の入力ミス1つ（`CREATIVE_BIND=0.0.0.0`）で全インタフェースに開く。

**提案**: `0.0.0.0` を許可リストから外す。必要になったら `CREATIVE_BIND_PUBLIC_APPROVED=1` のような
**別の明示承認**と、前段TLS終端の前提を契約書に書いた上で通す。現段階は未配備なので外して困らないはず。

---

### Medium-1 — 非ASCIIの `Authorization` ヘッダで未捕捉 TypeError（401にならず500）

**場所**: `creative_job_app.py` `Application.__call__` 末尾の再認証ブロック

```python
finally:
 if db:db.close()
current=self.env.get('CREATIVE_GEN_API_KEY','')
if not current or not hmac.compare_digest(e.get('HTTP_AUTHORIZATION',''),'Bearer '+current):  # ← try の外
```

`hmac.compare_digest` はstr同士の場合ASCII以外で `TypeError` を投げる。
try内の最初の比較でも投げるが、そちらは `except Exception` が500に畳む。
**問題はこの再認証ブロックがtry/exceptの外にある**こと。ここで例外が出ると `start_response` が
一度も呼ばれないままWSGIアプリが例外送出する。

**再現（実施済み）**
```
HTTP_AUTHORIZATION = 'Bearer é'  →  TypeError: comparing strings with non-ASCII characters is not supported
（start_response 未呼出）
```
PEP3333 で `HTTP_*` は latin-1 デコードされるので、`curl -H $'Authorization: Bearer \xc3\xa9'` で
**認証前に誰でも到達できる**。High-2（公開bind）と重なると外部から踏める。

**影響**: 401契約が守られず、サーバ側の500とtracebackログになる。状態破壊・秘密漏えいは確認していない。

**提案**: `header.isascii()` を先に見て非ASCIIは即401にする、もしくは両辺を
`.encode('latin-1','replace')` してbytes同士で比較する。

---

### Medium-2 — 監査の `actor` 列が定数で、実オペレータは `reason` の文字列に埋まる

**場所**: `creative_jobs.py` `Jobs.event()`

```python
self.db.execute('INSERT INTO events(...) VALUES(?,?,?,?,?,?,?,?)',
  (self.tenant,job,'authenticated_demo_operator','Content Studio Agent',reason,...))
```

`retry(job,actor,reason)` / `resume(approved_by,reason)` は actor を `reason` カラムへJSONで押し込む。

**実測（retry後のeventsテーブル）**
```
('job_a','authenticated_demo_operator','Content Studio Agent','generation_requested')
('job_a','authenticated_demo_operator','Content Studio Agent','restart_no_automatic_reexecution')
('job_a','authenticated_demo_operator','Content Studio Agent','{"actor":"operator_taro","reason":"crash reviewed","operation":"explicit_retry"}')
```

C-1の是正（actor/reason必須）の価値が、`WHERE actor=?` の監査クエリに現れない。
append-only trigger を入れてまで守っている表なので、`event()` に actor 引数を通して列へ入れるべき。

---

### Medium-3 — `controls` 行は DB新規作成時のみ INSERT。行が無いテナントは恒久503で、`resume` でも復旧しない

**場所**: `creative_jobs.py` `Jobs.__init__` / `check` / `resume`

```python
new_store=not (self.root/'jobs.sqlite').exists()
...
if new_store:self.db.execute('INSERT INTO controls VALUES(?,0)',(tenant,))
```
```python
def check(self):
 r=...fetchone()
 if not r or r[0]:raise JobError('READ_OR_RENDER_DISABLED',503)   # 行が無い = 停止扱い
def resume(...):
 self.db.execute('UPDATE controls SET stopped=0 WHERE tenant=?',(self.tenant,))  # 0行更新でも成功
```

**再現（実施済み）**: 同じ `storage_path` に tenant_a → tenant_b の順で `Jobs` を作ると、
tenant_b は `check()` が 503。`resume('operator','unblock')` を打っても **503のまま**。

fail-closedなので安全側だが、**原因が読み取れない恒久停止**で、CLIからの回復手段が無い。
現demoは単一テナント固定なので実害は出にくいが、`INSERT ... ON CONFLICT(tenant) DO NOTHING` にするか、
`resume` で行が無ければ作るのが素直。

---

### Medium-4 — 終端しない `interrupted` / `failed` を畳む操作が無い

**再現（実施済み）**: 素材の権利が失効（assets台帳から抹消）した状態で
```
retry('job_a', ...)                       → ASSET_NOT_AUTHORIZED 403
accept(同creative/同version の新job_id)    → ASSET_NOT_AUTHORIZED 403
accept(target_version=2 へ繰上げ)          → ASSET_NOT_AUTHORIZED 403
status('job_a')                           → 'interrupted'（変わらない）
```

拒否自体は正しいfail-closed。問題は **そのジョブが `interrupted` のまま永久に残る**こと。
①側は契約の「最大30分で自動pollを打ち切り『状態確認が必要』と表示」しか出口がなく、
画面には理由の分からない中断ジョブが残り続ける。

**提案**: actor/reason 必須の `cancel` をCLIに追加し、契約書の状態一覧に `cancelled` を入れる。
`retry` と同じく履歴追記・completed拒否でよい。

---

### Low（配備前に潰せれば十分）

| # | 内容 | 場所 |
| --- | --- | --- |
| L-1 | CLI の `--job/--actor/--reason` が `required=True` でない。欠落時は `JobError` のtracebackで落ちる。契約は「actor/reason必須」なので、引数パーサで弾いて読める文言を出したい。 | `creative_job_app.py` `__main__` |
| L-2 | HTTPリクエスト毎に `Jobs()` を生成し `executescript`（`PRAGMA journal_mode=WAL` ＋ CREATE TABLE/TRIGGER）を毎回実行。DB不要の `GET /v1/creative/limits` でも接続を開閉する。 | `Application.jobs()` |
| L-3 | `file()` は Range 指定でも成果物全体（最大64MiB）をメモリへ読んでから切り出す。gunicorn `--threads 2` で瞬間 ~128MiB。`preflight` はディスクのみ検査しメモリ前提が無い。18秒MP4の再生が主用途なら効いてくる。 | `creative_jobs.py` `file()` / `Application.__call__` |
| L-4 | 成功ジョブの中間生成物（`demo-source-*.png`、`demo-source-segment-*.mp4`、`caption-*.png`、`contact-sheet.jpg`、concat txt）が残り続ける。保持期限・削除方針が契約書に無い。`preflight` の512MB下限はジョブ数に対して早く枯れる。 | `creative_render.py` `render()` |
| L-5 | `draw_body` は30「文字」固定の機械折返し（M-1の headline 14字分割と同種）。全角前提で、半角主体の本文では1行が極端に短くなる。溢れはしないので後続改善で可。③も契約書に「より自然な改行は後続改善」と明記済み。 | `creative_render.py` `draw_body()` |
| L-6 | `CreativeLibrary.__init__` に誤ったhashを渡して弾かれることを直接確認するテストが無い（`get()` 経由は `test_manifest_rewrite_rejected` で担保）。H-2の是正の半分が未テスト。 | `test_creative_library.py` |

---

## 3. 指摘しない（③の説明を受入れた）もの

- `retry` が先頭で `check()` を呼ぶため停止中は `resume` が先に必要 — 契約書に明記済み、テストあり。妥当。
- CLI実行権限だけで stop/resume/retry できる点 — ③が「引数の名前だけで本人確認する本番Approval Engineではない」と
  明記しており、demo限定の前提として受入れる。ただし **High-2 を直さないとこの前提が崩れる**（公開bindした瞬間に
  ローカル管理者前提が成立しなくなる）ので、2点はセットで扱ってほしい。
- `start_creative_service.py` が子プロセスを再起動しない — 契約書に記載あり。ただし High-1 と組むと
  クラッシュループになるので、High-1側で対処されれば解消する。
- `package_creative.py` が `creative_library.py` を含まない — HTTP経路（service→app→jobs→render）は
  依存していないので欠落ではない。①がサーバ側でlibrary読取を使う段になったら追加が要る、という将来の注記のみ。

---

## 4. ①側の宿題（③の指定に沿う）

1. **`GET /v1/creative/limits` を①が取得して入力欄の上限に使う。** 実測値を確認済み
   （headline 28 / body 120 / cta 14 / revision_instructions 1000 / max_artifact_bytes 64MiB）。
   ①側にハードコードのfallbackは置かない。limits取得に失敗したら「未取得」として送信自体を止める。
   数値を①のコードに焼くと、③がテンプレを変えた瞬間に画面だけ古い上限を出すため。
2. **受入区分2の画面検査スクリプト**は③のURLを環境変数で差し替え可能にする。HTML内文字列検査だけでは合格にしない、
   という③の条件に合わせ、実handler→HTTP③ の往復を通す。
3. **素材の逆方向（①→③）契約**は③が提示した要件（専用read-only credential、tenant/store/asset/versionの
   サーバー確認、metadataにhash/MIME/bytes/rights/有効期限、固定origin/pathのGET・redirect拒否、
   画像20MB・動画100MB、timeout10秒・429/5xxのみ最大2回再試行）で①が書く。
   保存先は「URLを隠すだけの公開保存」を採らない方針で一致している。

---

## 5. 境界の確認

- ③のファイルは**1バイトも変更していない**。検証は隔離したサンドボックスへ展開して実行しただけで、
  ③のリポジトリにも実行環境にも触れていない。
- **main merge・本番設定変更・課金・広告操作の許可は、このレビュー依頼から一切推測していない。**
- トークンの追加共有は求めない。`CC_AGENT_TOKEN` は一時入力のみで③に実値が渡っていない、という説明で確定として扱う。
- 実データ・秘密は本文書に含まれない。検証に使ったのは全て合成値。
- localhostでの成功は配備成功ではない、という③の区分に同意する。本文書は**区分1の再検証**であり、
  区分2（①画面）・区分3（配備環境）は未実施。
