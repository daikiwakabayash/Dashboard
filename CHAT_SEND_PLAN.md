# CHAT_SEND_PLAN — 自然言語の宛先指定と送信前確認（②）

本部/root のみで検証します。**送信は人が確認ボタンを押したときだけ**行います。
実装は `lib/chat-recipients.js`（宛先解決・Phase1で作成済みを再利用）と
`lib/chat-send-plan.js`（本書）。どちらも I/O を持たない純粋関数で、
認可は `ctx.can` として外から注入します（①の `lib/authz.js` をそのまま渡せます）。

## 1. 本文と送信指示を分ける

`splitInstruction(text)` が1通を「送信指示」と「本文」に分けます。

| 入力 | 指示 | 本文 |
|---|---|---|
| `恵比寿院と渋谷院だけに送って` ＋ 改行 ＋ `本文: 明日の朝礼は9時からです` | 前半 | 後半 |
| `新宿院を除く全店に「棚卸しは金曜です」と送って` | 鉤括弧の外 | 鉤括弧の中 |
| 指示らしい行 ＋ 空行 ＋ 本文 | 先頭の指示行 | 残り |

- **指示文を本文にしません。** 本文が取れなければ `needs_body` で止めます。
- **本文だけでは送りません。** 宛先の指示が無ければ `needs_instruction` で止めます。
- URL・鉤括弧で始まる行は指示と見なしません。

## 2. 宛先の確定（推測しない）

`resolveRecipients(spec, ctx)` は名前ではなく **store_id / staff_id** を返します。
次のいずれかが残っていれば **送信させません**（`needs_confirmation`）。

- 同姓同名（例: 佐藤 健が2名）→ 候補を出して人に選ばせる
- 店舗名の曖昧さ・存在しない店舗
- **除外指定が解決できない**（除外し損ねは「送ってはいけない先へ送る」ことになるため）
- 依頼者の権限の外にある宛先（黙って落とさず `outOfScope` に載せる）

## 3. 送信前確認（実物を出す）

`buildConfirmation({ resolved, body, spec })` が返すもの:

| 項目 | 内容 |
|---|---|
| `body` | **本文そのまま**（要約しない） |
| `targets` | 実際の宛先（店舗名／氏名）。件数だけにしない |
| `count` | 件数 |
| `excludedShops` / `excludedStaff` | どこへ送らないか |
| `outOfScope` / `ambiguities` / `unresolved` | 送れない・確定していない宛先 |
| `dmEach` / `recipientsHiddenFromEachOther` | 個別DMか、宛先同士が見えないか |
| `requiresBulkConfirm` | 大量送信（既定20件以上／全社一斉）の追加確認 |
| `canSend` | すべて満たしたときだけ true |

`confirmationLine(conf)` は「個別DM（1人1通・宛先は互いに見えません）：佐藤 健、鈴木 一郎（2件）」のような1行を返します。

## 4. 一括DMはグループDMにしない

- 個別DMは **1人1通**。宛先をまとめてグループDMに変えません。
- 受け手に**他の宛先を見せません**（本文にも宛先一覧を混ぜません）。
- 個別DMになるのは **指示が明示したときだけ**（`dm: true`、または個人・役職だけを名指ししたとき）。
  店舗を指定しただけで全員への個別DMに化けません。

## 5. 送信時点でもう一度確かめる

`recheckBeforeSend(confirmation, ctx)` — 確認画面を見た時点と送信時点のズレを見ます。

| 変化 | 扱い |
|---|---|
| 退職・在籍が確認できない | その人には送らない（`left`） |
| 異動（所属が変わった） | 送らない・**変更内容を理由に残す**（`moved`） |
| 権限が無くなった | 送らない（`forbidden` / `out_of_scope`） |
| 全部落ちた | `canSend:false`。**0件送信を成功にしない** |

## 6. 予約送信・未読者への再通知

`planRenotify({ campaignId, candidates, readBy, ledger })` と `markSent(ledger, campaignId, ids)`。

- 既読になった人には再通知しません（`already_read`）。
- 同じ配信で送信済みの人には二度送りません（`already_sent`・台帳は配信ごと）。
- 候補に同じ人が複数回入っていても **1通だけ**にします。
- 実行直前に `recheckBeforeSend` と組み合わせ、所属・権限も確かめます。

## 7. 確認した内容が送信時に変わらない（完了条件）

人が「これで送る」と押したのは **その本文・その宛先** です。送信要求には確認内容の
指紋（`digest`）を添え、**サーバー側で作り直した指紋**と突き合わせます。

| 関数 | 役割 |
|---|---|
| `sealConfirmation(conf)` | 確認内容に封をする（`digest` ＋ 説明用の `bodyDigest` / `targetsDigest`） |
| `requiresReconfirm(sealed, current)` | 本文・宛先・配信の形が変わったかを返す（並び順の違いでは再確認にしない） |
| `verifySendRequest(request, ctx)` | **サーバー側の最終確認**。下記のとおり |

`verifySendRequest` の決まり:

1. **クライアントが送ってきた宛先リストを使いません。** サーバーが自分の名簿（`ctx.dir`）と
   認可（`ctx.can`）で宛先を組み立て直し、その結果で指紋を作ります。
   → 画面側で宛先を水増ししても増えません（テスト済み）。
2. 指紋が一致しなければ `needs_reconfirm`。**本文を差し替えた送信要求は通りません。**
   何が変わったか（`body` / `targets` / `mode`）を返します。
3. 送信直前に所属・権限を再確認し、**落ちる宛先があれば勝手に減らして送らず**
   `needs_reconfirm` で確認へ戻します。全員いなくなったら `empty`（0件送信を成功にしない）。
4. 指紋が添えられていない送信要求は送りません。

⚠️ この関数は②の純粋関数です。**実際にこれを呼ぶのはサーバー（①）**で、
`ctx = { dir, can, principal, resolve }` を渡します（`can` は①の `lib/authz.js`、
`resolve` は `resolveRecipients`）。画面だけの確認で送信を通さない設計です。

## テスト

```
tests/chat-recipients.test.js  → 40 passed（Phase1 のものを再利用・変更なし）
tests/chat-send-plan.test.js   → 37 passed
```

## まだ行わないこと

- 画面（`index.html` の通常チャット入力欄）への接続 … ①の共有ファイルのため、
  変更箇所と基準commitを先にそろえてから行います。
- 実スタッフへの送信 … 本部/root 専用Roomでの検証のみ。owner/manager/staff への公開は別の承認項目です。
