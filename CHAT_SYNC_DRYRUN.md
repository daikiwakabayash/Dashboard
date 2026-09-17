# CHAT_SYNC_DRYRUN — Room 情報 / 所属同期の差分検証（担当②）

チャット担当（②）の作業記録と引継ぎ事項。
**このブランチは共通ファイル（`lib/actor.js` / `lib/authz.js` / `lib/chat-policy.js` / `api/plan-store.js` / `index.html`）を一切変更していません。**
追加したのは新規ファイルだけで、①の共通基盤の統合を待たずに単体で検証できます。

| 追加ファイル | 役割 |
|---|---|
| `lib/chat-rooms.js` | 「実行したら何を変更するか」だけを返す純粋関数（依存ゼロ・I/O なし） |
| `tests/chat-rooms.test.js` | 合成データのみ 40 ケース |
| `scripts/chat-sync-demo.mjs` | CLI の差分プレビュー（dry-run） |
| `chat-sync-preview.html` | 本部 / root 向けの差分プレビュー画面（dry-run） |
| `CHAT_SYNC_DRYRUN.md` | 本書（引継ぎ事項・仕様メモ） |

---

## 1. 試し方（どちらも本番には一切書き込みません）

### CLI（最速・準備不要）
```bash
node scripts/chat-sync-demo.mjs                 # 全シナリオ
node scripts/chat-sync-demo.mjs transfer retire # 個別シナリオ
node scripts/chat-sync-demo.mjs --json base     # plan を JSON で
node scripts/chat-sync-demo.mjs --file input.json   # 自分で用意した入力
```

### 画面（本部 / root 向けの差分プレビュー）
```bash
npx serve .          # もしくは python3 -m http.server 8931
# → http://localhost:8931/chat-sync-preview.html
```
シナリオ切替（base / rename / samename / similar / transfer / retire / apifail / shopsdown）と、
自前 JSON の貼り付けに対応。表示は **作成予定 Room / ID 紐付け予定 / 追加予定メンバー / 除外予定メンバー / 判断できない項目と理由**。

> ⚠️ `chat-sync-preview.html` は `scripts/precompile.mjs` のコピー対象に入っていないため、現状 Vercel には配信されません。
> Preview に載せる場合は ① に「コピー対象へ1行追加」を依頼します（§5 の引継ぎ事項 D）。

### テスト
```bash
npx vitest run tests/chat-rooms.test.js    # 40 passed
```

---

## 2. 再利用した既存処理（作り直していないもの）

| 既存 | 扱い |
|---|---|
| SalonOne と同じ ID/PASS のログイン（`settlement-auth` → `auth/login` の二段フォールバック） | そのまま。触れていない |
| `/me` によるロール・アクセス店舗の更新 | そのまま。権限変更の反映経路として利用 |
| `ensureRooms` / `ensureBaseRooms`（店舗ルーム自動生成） | そのまま。**差分関数は「この仕組みに何を足すか」だけを出す** |
| `evSaveChat` / `evJoinChat`（イベントのグループ生成・self-join） | そのまま。`kind:'group'` も `cells.roomId` 紐付けも変更しない |
| 既存の DM / Group / Message / Read | 触れていない |
| 複数店舗権限の継承（`accessible_shops[].id`） | ①の `authState.storeIds` 取り込みを前提に `accounts[staffId].storeIds` として受け取る |

## 3. 新しく追加した処理（`lib/chat-rooms.js`）

- `planStoreRoomSync()` — 店舗ルームの差分（作成 / storeId 後付け / 表示名更新 / アーカイブ候補 / メンバー増減 / 要確認）
- `planEventRoomSync()` — イベント行の差分（eventId 後付け / 責任者・参加者の追加 / 要確認）
- `planChatSync()` — 上2つの統合
- `checkSourceHealth()` — 取得失敗・件数急減の検知
- `applyPlanForTest()` / `isNoop()` / `summarizePlan()` — テストと画面表示用

### 決めたルール（安全側）
| 論点 | ルール |
|---|---|
| Room ID | **変えない**。`storeId` / `eventId` を後付けするだけ |
| 店舗名の紐付け | **完全一致のみ**（NFKC＋空白除去＋英字小文字化。接辞は落とさない）。部分一致では絶対に紐付けない |
| 同名店舗 | 一意に決まらないので**紐付けない**→要確認。新規作成は `store_<名前>__<store_id>` の別 ID |
| 店舗名変更 | 同じ Room を維持し `name` だけ更新（過去ログを分断しない） |
| 複数店舗・兼務 | `accounts[staffId].storeIds`（SalonOne 由来）→ `staff.shop_ids` → `staff.shop_id` の順。全担当店舗の Room に所属 |
| 手動追加 / self-join | `autoMembers`（同期が入れた人）と区別し、**手動の人は自動削除しない** |
| 退職 | 自動所属からのみ外す。手動メンバーとして残る場合は要確認に出す |
| アクセス拒否 | **メンバー表示の更新とは別処理**。退職・権限剥奪の閲覧不可は SalonOne の権限と authz が即時に行い、本同期の完了を待たない |
| 取得失敗 | 店舗一覧が空 / 不完全 / 前回比 -30% 超 → **中止**。スタッフ名簿が空 / 不完全 → **追加のみ・削除は保留** |
| 大量削除 | 1回 50 名超、または（母集団20名以上で）30% 超の削除は保留して要確認へ |
| 冪等性 | plan を適用 → 再計算すると差分ゼロ（テスト済み） |

## 4. テスト結果（合成データ・40 ケース）

| シナリオ | 結果 |
|---|---|
| 店舗名変更 | Room ID 維持・`rename` のみ・新規作成なし ✅ |
| 同名店舗（2件） | 既存 Room は紐付けず要確認、新規は `__<store_id>` 付きで作成 ✅ |
| 似た名前（渋谷院 / 渋谷西院、梅田院 / 梅田中央院） | 同一視しない ✅ |
| 部分一致（「渋谷」→ NAORU渋谷院） | **紐付けない**（要確認） ✅ |
| 複数店舗 / 兼務 | `accessible_store_ids`・`shop_ids` の両方に対応し全店に所属 ✅ |
| 異動 | 旧店舗から除外・新店舗へ追加（自動所属のみ） ✅ |
| 退職 | 自動所属から除外＋アクセス失効は別処理として記録 ✅ |
| 退職者が手動メンバー | 自動削除せず要確認 ✅ |
| 名簿に無い ID に権限だけある | 追加せず要確認 ✅ |
| 店舗一覧が空 / 不完全 / 急減 | 同期中止（差分ゼロ） ✅ |
| スタッフ名簿が空 / 不完全 | 全員退職扱いにせず削除保留 ✅ |
| 大量削除（60名 / 50%） | 保留して要確認 ✅ |
| 通常の少人数削除（3名 / 30名中） | 保留に引っかからない ✅ |
| 2回同期 | Room も招待も重複しない（差分ゼロ） ✅ |
| イベント: 責任者・参加者 | 追加され `eventId` が後付けされる（`kind` は group のまま） ✅ |
| イベント: self-join | 参加者リストに無くても自動削除しない ✅ |
| イベント: 存在しない roomId / 名前空 | 勝手に作らず要確認 ✅ |

---

## 5. ①（共通基盤担当）への引継ぎ事項

### A. 基準 commit
本ブランチ `feature/chat-room-sync-dryrun` は **`main`（`581a660`）から分岐**しています。
共通ファイルに触れていないため #384 / #379 の統合順序に関係なくマージできます。
次のチャット実装（適用系）は、**①が指定する統合後の commit** を基準に切り直します。

### B. 共通仕様として①にお願いしたい入出力（②では実装しません）
| # | 依頼内容 | 理由 / 想定 |
|---|---|---|
| B-1 | `actor` に `accessible_store_ids` が入ること（#384 で実装済みの理解） | 差分関数の `accounts[staffId].storeIds` の供給源 |
| B-2 | Room レコードに `autoMembers: string[]` を保持できること（任意フィールド） | 手動追加 / self-join と自動所属の区別。**これが無いと「手動の人を消さない」保証ができない** |
| B-3 | Room の任意フィールド `storeId` / `eventId` / `status` の保存を許可 | 既存 ID を変えずに紐付けるため |
| B-4 | 同期の実行は `chat.admin`（root/hq）のみ、かつ dry-run → 承認 → 適用の2段階 | ②は plan までを担当。適用系は承認センター（①）の下で実行 |
| B-5 | 名簿取得の完全性フラグ（`shopsComplete` / `staffsComplete`）を取得側で立てられること | ページ取得漏れでの大量削除を防ぐ唯一の手段 |

### C. Chat Authorization Log（②では別ログを作りません）
①の共通監査ログに、チャット固有イベントとして下記を**受け付けてほしい**という要件のみ整理します。

| event | 主なフィールド | 発生源 |
|---|---|---|
| `chat.authz.denied` | `actor_id, role, source, verified, action, room_id, reason`（`chat_rollout_disabled` / `room_not_visible` / `invite_out_of_scope` 等） | `authorizeChatAction` の deny |
| `chat.rollout.changed` | `actor_id, before, after` | `setRollout` |
| `chat.sync.previewed` | `actor_id, plan_summary(作成/紐付け/追加/除外/要確認の件数), source_health` | 本 dry-run プレビュー |
| `chat.sync.applied` | `actor_id, approved_by, plan_id, applied_counts` | 将来の適用系（①の承認センター経由） |
| `chat.room.membership_changed` | `room_id, added[], removed[], by(`sync`/`manual`)` | 同期・手動どちらも |

表示要件（①の画面に置く前提・②では画面を作りません）:
- 直近の deny を「誰が / いつ / どのルームで / 理由」で一覧できること
- `chat.sync.*` は plan の要約（件数）と要確認件数が見えること
- 個人名ではなく **staff_id を主キー**にし、表示名は解決結果を添えるだけにすること

### D. 小さな依頼
`scripts/precompile.mjs` のコピー対象に `chat-sync-preview.html` を1行追加していただければ、Preview URL でも差分プレビューを開けます（②では共通ファイルを触らないため未実施）。

---

## 6. 本番未変更の範囲（今回まったく触っていないもの）

- 本番の Room・メッセージ・メンバー・招待（**書き込み API を一度も呼んでいません**）
- `api/plan-store.js`（チャットの保存・認可）
- `index.html`（ダッシュボード本体）
- `lib/actor.js` / `lib/authz.js` / `lib/chat-policy.js` / `lib/chat.js`
- SalonOne の権限・アカウント
- 既存の Store Room 自動生成・Event Room 自動生成の動作

## 7. 次に @AI へ進むための残作業

1. **適用系の設計合意**（①）: dry-run plan → 承認 → 適用。承認センターは①の実装を利用し、②は plan の生成と表示のみを担当。
2. **B-2（`autoMembers`）の確定**: これが無いと「手動の人を消さない」保証がコード上で担保できない。
3. **プレビュー画面の設置場所**: 単体 HTML のままにするか、①の統合後に `index.html` の本部向けタブへ移すか（同時編集を避けるため①の統合完了後）。
4. 上記が固まれば、②は **@AI メンション UX（`CHAT_AI_UX_SPEC.md`）** に着手できます。@AI は認可・監査ともに①の共通基盤に乗せる前提で、②は「AI Question Mode の UI」「出典・確信度の表示」「👍👎修正の入力」のみを担当します。
