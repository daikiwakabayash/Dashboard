# ③ High修正 独立レビュー結果（9ファイル）

- 対象: `CREATIVE_REVIEW3_BUNDLE.md` 記載の9ファイル
- 検査者: ①（独立レビュー）
- 検査日: 2026-09-19（JST）
- 検査方法: 静的読取 ＋ **隔離サンドボックスでの実行**（実gunicorn・実プロセス・実HTTP）
- ③のコードは一切変更していない。GitHubへの投稿・push・環境変数登録・本番操作は行っていない。

## 結論

**High-1 / High-2 / Medium-1 / Medium-2 / Medium-3 は、すべて閉じた。**
新規の指摘は Medium 1件・Low 2件で、いずれも配備前に直せば足りる。

---

## 0. 対象の同一性とテスト

9ファイルを抽出し、記載SHA256と照合 → **9/9一致**。
変更されていない5ファイル（`creative_render.py` 他）は前回バンドルの検証済みコピーを使用。

| 実行 | 結果 |
| --- | --- |
| `test_creative_jobs` / `test_creative_library` / `test_creative_deployment` | 43件 合格 |
| `test_creative_review2`（今回の新規） | **7件 合格** |
| `test_creative_consumer_443`（#443固定consumer） | **1件 合格** |
| 合計 | **51/51 合格**（Python 3.11.15 / gunicorn 26.2.0） |

⚠️ 当初 `test_supervisor_remains_available_while_stopped_and_after_restart` が落ちましたが、
**私の環境に gunicorn が入っていなかったため**です。`gunicorn==26.2.0` を入れて再実行し、合格を確認しました。
実Pillow/FFmpegを使うレンダリングは依然として未実行です（未導入）。

### #443 の固定consumer

③の `tests/references/dashboard-creative-6f6cb67.mjs` を、
①の main（`6f6cb67a1ba664d76ea03c2cace47cb4a36a50f2`）の `lib/creative.js` と**直接照合**しました。

```
③のfixture  9519787fc97a7e77954e0c8466711ad3dd37370e0dc94a7bc8ff5ab59c51e05e
①のmain     9519787fc97a7e77954e0c8466711ad3dd37370e0dc94a7bc8ff5ab59c51e05e
cmp         バイト単位で完全一致
```

`CREATIVE_CONSUMER_PIN_443.json` の記載（commit・head 30083ce との一致・旧79d試験の保持）も、
私の側の記録と食い違いません。**再固定は正しく行われています。**

---

## 1. High-1 — `stop` がサービス全体を落とす

**閉じた。** 実プロセスで2通り確認しました。

### (a) 実gunicorn（③の監督起動）

`test_creative_review2` の該当試験を実gunicornで通し、
**起動 → 200 → `stop` → 監督プロセス生存 かつ API 200 → terminate → exit 0**、
これを**停止フラグを保持したまま2周**することを確認しました。

### (b) 私の側の独立再現（wsgiref serve + worker、前回の再現手順そのまま）

| 手順 | 前回（旧版） | 今回 |
| --- | --- | --- |
| 起動直後 | API 200 / worker 生存 | API 200 / worker 生存 |
| `stop` 発行の2秒後 | **worker プロセス 0** | **worker 生存・API 200** ✓ |
| 停止フラグを持ったまま worker 再起動 | **即 exit 0** | 生存を継続 ✓ |

さらに、停止中のふるまいが**契約どおり**であることも確認しました。

```
停止中 POST /v1/creative/generate  → 503 READ_OR_RENDER_DISABLED   （新jobを止める）
停止中 file('j1',0)                → 503 READ_OR_RENDER_DISABLED   （asset返却を止める）
停止中 status('j1')                → 'completed'                  （①が状況を見られる）
resume --actor … --reason … の後   → 202                          （受付が戻る）
```

前回は「APIごと落ちるので、契約に書かれた停止中のふるまいをそもそも観測できない」状態でした。
**いまは観測でき、書かれたとおりに動いています。**

`worker_loop` が `READ_OR_RENDER_DISABLED` だけを待機に変換し、他の `JobError` を上げる形も妥当です
（`test_unexpected_error_not_swallowed` で握りつぶしていないことが担保されています）。

## 2. High-2 — 公開bind

**閉じた。** preflight と監督起動の**両方**で拒否されます。

```
preflight(CREATIVE_BIND=0.0.0.0)            → ValueError: loopback_required
start_creative_service.py (BIND=0.0.0.0)    → creative_preflight_failed / exit 1
```

`CREATIVE_HOSTED_APPROVED=1` を立てても解除できないこと（preflight の先頭で判定）も読みで確認しました。
`localhost` や `::1` も通りません。厳しすぎるとは思いません。**現段階はこれでよいと考えます。**

「Renderへそのまま公開できるとは扱わない」「TLS終端・分離は承認後の別対応」という整理にも同意します。

## 3. Medium-1 / 2 / 3

| 指摘 | 判定 | 実測 |
| --- | --- | --- |
| **M-1** 非ASCII認証で未捕捉TypeError → 500 | **閉** | `curl -H $'Authorization: Bearer \xc3\xa9'` → **401**（前回は例外送出）。try内・再認証の両方が `authorized()` を通る |
| **M-2** 監査の actor 列が定数 | **閉** | `resume --actor operator_taro` → `('*','operator_taro','local demo resume approved')` |
| **M-3** controls行欠落で恒久503・resume不能 | **閉** | tenant_b は 503（**自動では開かない**＝正しい）。明示 `resume` で upsert され復旧、actor も残る |
| **Low-2一部** limits がDBを開く | 閉 | `db=self.jobs()` が分岐の中へ移動。limits は接続しない |
| 掃除失敗時の `ARTIFACT_CLEANUP_REQUIRED` | 追加 | 失敗確定を掃除の成否に巻き込まない形になっており、良い追加だと思います |

---

## 4. 新規の指摘

### Medium-新1 — `stop` にだけ操作者が残らない

`resume` / `retry` は実actorを監査列へ入れるようになりましたが、**`stop` は定数のまま**です。

```python
def stop(self):
 with self.db:
  self.db.execute('UPDATE controls SET stopped=1 WHERE tenant=?',(self.tenant,))
  self.event('*','enabled','stopped','operator_stop')      # ← actor 省略＝定数
```

**実測**
```
('authenticated_demo_operator', 'operator_stop')     ← 誰が止めたか分からない
('operator_taro',               'reviewed')          ← 解除した人は分かる
```

CLI 側も `stop` は `--actor/--reason` を取りません。

停止はサービスを丸ごと止める、この系でいちばん影響の大きい操作です。
**解除だけ追えて停止が追えないのは向きが逆**だと思います。
直し方は `resume` と同じ形（`stop(self, actor, reason)` ＋ CLI 引数）で済むはずです。

### Low-新1 — `serve` / `worker` は preflight を通らないので、非ASCIIの鍵で起動できてしまう

`creative_job_app.py serve|worker` は `Application(load())` を呼ぶだけで、`preflight()` を通りません。
`Application.__init__` の鍵検査は `len >= 32` だけなので、**非ASCIIの鍵でも起動します**。
そして `authorized()` は `key.isascii()` を要求するため、**正しい鍵を送っても必ず401**になります。

**実測**
```
Application(..., CREATIVE_GEN_API_KEY='鍵'*40)  → 起動できた
authorized('Bearer '+K, K)                      → False     （全リクエストが401）
preflight(..., 同じ鍵)                          → invalid_service_key  （配備経路では弾かれる）
```

配備経路では弾かれるので実害は開発時に限られますが、**原因の分からない401**になります。
`Application.__init__` に `isascii()` を足すだけで消えます。

### Low-新2 — 監督起動は子を再起動しないので、まれな例外でも同じ形の停止になる

High-1 の修正で `READ_OR_RENDER_DISABLED` は待機になりましたが、
`work_one()` の受付トランザクションで `sqlite3.OperationalError`（database is locked）等が出た場合は
worker を抜け、監督が API も落とします。**High-1 と同じ形の全体停止**です。

⚠️ **これは再現していません**（推論です）。書込トランザクションは短く、WAL＋`timeout=10` なので
起きにくいはずですが、外部のプロセス管理が無いと自動復旧しない点だけ記録しておきます。
「監督は再起動しない」は契約書に書かれているので、**どの外部管理下で動かすか**が決まれば解消する話だと思います。

### 継続（③が「未完了」と明示済み・こちらも合意）

Medium-4（終端しない `interrupted`/`failed` を畳む `cancel`）、CLI必須引数、
`draw_body` の固定折返し、`CreativeLibrary.__init__` のhash不一致テスト、成果物の保持/削除方針。

`cancel` の①側は、状態一覧に `cancelled` を足し、画面では「中断（理由）」として
**自動pollを止めるが記録は残す**扱いにする想定です。③の次差分に合わせます。

---

## 5. 素材契約への回答（③の修正提案 1〜7）

**1. キー自体に許可tenant/storeを紐付ける** — 同意します。ご指摘のとおり、
鍵の一致＋申告 `X-Tenant-Id` の一致だけではテナント境界になりません。①側の設定名案:

| 名前 | 中身 |
| --- | --- |
| `CREATIVE_ASSET_READ_KEY` | 鍵そのもの（32文字以上・ASCII・空白なし） |
| `CREATIVE_ASSET_READ_SCOPE` | JSON `{"tenant_id":"naoru","store_ids":["…"]}` |

**空・未設定・解析不能はすべて全拒否**（「未設定なら全許可」にしない）。範囲外は403。

**2. 新Functionを前提にしない** — 同意です。①も同じ制約（Vercelの関数上限）を抱えています。
固定routeは `/api/plan-store?type=creative-asset&action=metadata|file&asset_id=…&version=…` を候補にします。
**未知クエリは無視ではなく400**、も採用します（draft-1 の「無視する」は撤回します）。

**3. 実体返却の直前に再確認・304/Rangeでも認可を省かない** — 同意します。
①の既存の `action=file` も毎回 `mine()` と鍵解決を通しており、同じ方針で揃えられます。

**4. 推定期限を作らない** — 同意します。**①には `expires_at` を持つ項目がまだありません。**
項目と画面ができるまで、`real` 素材はこの口から出しません（`demo` のみ）。

**5. 転送上限（画像20MiB / 動画100MiB）** — ご指摘のとおり**①が確認すべき値**で、
**私はまだ確認していません**。Vercel の関数レスポンス上限・実行時間と整合するかを調べ、
満たせなければ下げるか、承認済みのprivate配信経路へ変える前提で draft-2 に入れます。
それまで数値は**候補のまま**にしてください。

**6. 失効の扱い** — 同意します。403を一律削除にしない（スコープ誤設定と権利取消を区別）、
既配信物は人間判断、という整理が正しいです。draft-1 の「保持している複製を削除する」は、
**410（期限切れ）に限る**と直します。

**7. env差替えだけで即時失効とはしない** — **ご指摘が正しく、draft-1 の記述は言い過ぎでした。**
Vercel の環境変数は再デプロイまで実行中のインスタンスに反映されません。
「即時」を撤回し、反映経路（再デプロイ／実行中インスタンスの入れ替わり）と
その間の猶予時間を draft-2 に明記します。

→ 以上を反映した **draft-2 を①が書き、次回お渡しします。**

---

## 6. 境界の確認

- ③のファイルは**1バイトも変更していません**。検証は隔離したサンドボックスへ展開して実行しただけです。
- **①の main へのmergeは、若林さんの明示の指示（「マージOKです」）で①が行いました。**
  ③のレビュー依頼から推測したものではありません。③がmergeを行っていないことも理解しています。
- **素材口の新規公開・鍵の登録・課金は、どれも未承認のままです。** ①も実装していません。
- 実データ・秘密は本文書に含まれません。検証に使ったのは全て合成値です。
- localhost での成功は配備成功ではない、という区分に同意します。
  本文書は**区分1の再検証**です。区分2（①画面＋実handler→HTTP③）は①が検査台を作成中で、
  現時点では**上限取得までしか通っていません**（§7）。

## 7. 受入区分2 の進み具合（①側・進行中）

①の実 `api/plan-store.js` を載せた検査台（`scripts/creative-gen-check.mjs`）を作り、
③のデモサービスを実際に起動して繋ぎました。**いま通っているのはここまでです。**

```
OK  ③から文字数上限を取れる（①のhandler経由・実HTTP）  見出し28 / 本文120 / ボタン14
OK  ③の応答が2秒以内（契約の目標）  5〜9ms
OK  ③へのリダイレクトを受け取っていない
OK  ①の共通ログインを通る（認可は本物のコード）
OK  クリエイティブ画面が開く
—   以降（生成依頼・画像表示・動画再生・修正依頼・version2・download・失効拒否）は未到達
```

⚠️ **まだ合格ではありません。** ブラウザ側の画面検査に詰めが残っています。

また、この先に**設計上の宿題**があります。③の asset registry は起動時の設定に
`asset_id` を持つ必要がありますが、**①の素材IDはサーバー発番**（`as_...`）なので、
③の設定へ事前に書けません。区分2の「生成依頼」から先を流すには、

- ③が①の素材IDをどう受け取るか（登録API／起動後の追加／demo時の読み替え）

が決まる必要があります。素材契約 draft-2 と同じ話なので、そちらへ含めます。
検査台は、決まりしだい続きを足せる形にしてあります。
