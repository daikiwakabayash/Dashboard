# サーバー側 認可 設計（AUTHORIZATION_PLAN）

作成日: 2026-09-17 / ブランチ: `feature/cc-foundation` / 状態: **実装済み・既定OFF（`cc_authz=off`）**
関連: `INTEGRATION_PLAN.md` §2.4／`DATA_CONSISTENCY_PLAN.md`

> 現状の `/api/plan-store` は **クライアントが名乗った actor をそのまま信じている**。
> URLを知っていれば誰でも読み書きできる状態であり、AI Command Center を本番運用する前に必ず塞ぐ必要がある。
> ただし一気に塞ぐと既存クライアントが全部落ちるため、**計測 → 警告 → 強制**の3段階で入れる。

---

## 1. 2層に分ける（誰か／何をしてよいか）

```
リクエスト
   │
   ├─ lib/actor.js   「誰か」を確定する（トークン検証）      → { id, name, role, source, shops, verified }
   │
   └─ lib/authz.js   「何をしてよいか」を判定する（純粋関数） → { allow, code, reason }
                                                              ↓
                                          lib/authz.js enforce(mode, decision)
                                          off / log / warn → 通す　　enforce → 403
```

分ける理由: 認証方式が増えても（SSO・エージェントトークン・将来のSSO統合）**権限表を触らずに済む**。
逆に権限表を変えても認証コードに影響しない。`lib/authz.js` は副作用なしでテストできる。

---

## 2. 役割（6種）

既存の `root / hq / owner / staff` を壊さずに `admin / manager` を足す。
**`hq` は `admin` の別名として受理**するので、既存アカウントの作り直しは不要。

| 役割 | rank | 範囲 | 想定 |
|---|---|---|---|
| `root` | 100 | 全店 | 共有PASS（`DASHBOARD_PASSWORD`）の管理者 |
| `admin` | 90 | 全店 | 本部。個人名でログインする root 相当（**旧 `hq`**） |
| `owner` | 60 | 管轄店舗 | FCオーナー |
| `manager` | 40 | 所属店舗 | 店長・マネージャー（**新設**。現在は staff に混在） |
| `staff` | 20 | 所属店舗 | セラピスト |
| `guest` | 0 | なし | 未認証。既定の落とし所 |

**SalonOne SSO の写像**: `brand_admin → root` ／ `shop_admin → owner` ／ `shop_staff → staff`
**未知の役割は必ず `guest` へ落とす**（`superuser` などを名乗っても昇格しない）。

### 2-1. 「AIエージェント」は役割ではなく主体の種別

ここが設計の肝。エージェントに `agent` という役割を与えると、
**うっかり rank を上げた瞬間に承認をすり抜ける**。そこで役割とは独立の軸を持つ。

```
role   … root / admin / owner / manager / staff / guest   （どこまで見えるか）
source … ui / api / cron / agent / system                （何が動かしているか）
```

判定は `source` を最優先で見る:

```js
if (actor.source === 'agent') {
  if (spec.humanOnly) return deny('agent_forbidden');   // role が root でも必ず拒否
}
```

→ **AIエージェントは人間の承認者になれない。** テストで固定済み（`tests/authz.test.js`）。

---

## 3. 権限表（指定された操作）

`✓` = 可 ／ `—` = 不可。店舗限定の役割は **管轄店舗の対象のみ**。

| 操作 | root | admin | owner | manager | staff | **AI agent** |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Approval 作成 | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** |
| **Approval 承認** | ✓ | ✓ | ✓ | △ | — | **—** |
| **Approval 却下** | ✓ | ✓ | ✓ | △ | — | **—** |
| Approval 修正依頼 | ✓ | ✓ | ✓ | ✓ | — | **—** |
| Approval 閲覧 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Feature Flag 変更** | ✓ | ✓ | — | — | — | **—** |
| **Kill Switch 作動（止める）** | ✓ | ✓ | ✓ | ✓ | — | **—** |
| **Kill Switch 解除** | ✓ | ✓ | — | — | — | **—** |
| **Agent Activity 閲覧** | ✓ | ✓ | ✓ | ✓ | — | **—** |
| **Audit Log 閲覧** | ✓ | ✓ | — | — | — | **—** |
| Meta広告 予算変更/停止/再開/Creative差替 | ✓ | ✓ | ✓ | — | — | ✓ ※ |
| **SNS 投稿** | ✓ | ✓ | — | — | — | **—** |
| **LP 変更** | ✓ | ✓ | — | — | — | **—** |
| Knowledge 正式版変更 | ✓ | ✓ | — | — | — | **—** |

△ = **低リスクの提案のみ**（§3-2）　※ = **承認済みの提案の実行のみ**（§3-3）

### 3-1. Kill Switch は「止めるのは緩く、解除は厳しく」

| 方向 | 権限 | 理由 |
|---|---|---|
| 止める | owner / manager でも可 | **事故のときに誰も止められない状況を作らない** |
| 解除する | root / admin のみ | 止めた理由を確認せずに再開させない |

### 3-2. リスクによる引き上げ

承認は対象のリスクで必要な役割が上がる。

| リスク | 必要 | 例 |
|---|---|---|
| low | manager 以上 | 軽微な設定 |
| medium | owner 以上 | Meta 予算変更・広告停止・Creative差し替え |
| high | **admin 以上** | SNS投稿・LP変更・Knowledge正式版変更 |

**risk が指定されていなければ `medium` として扱う**（安全側）。
さらに **high は提案者本人が承認できない**（作成者と承認者の分離）。

### 3-3. 外向き操作は「承認済み」を要求

Meta広告・SNS・LP・Knowledge は、権限があっても `approvalStatus === 'approved'` でなければ拒否する。

```js
if (spec.requiresApproval && target.approvalStatus !== 'approved') return deny('approval_required');
```

`cron` からは外向き操作も承認系も一切できない（`cron_forbidden`）。

### 3-4. 既定拒否

**表にない操作は必ず拒否**（`unknown_action`）。新しい操作を足すときに表への追記を強制するための設計。
`flag.read` だけは未認証でも通す（画面を描くのにフラグが要るため。中身は ON/OFF の真偽値のみで、業務データを含まない）。

---

## 4. 本人確認（`lib/actor.js`）

優先順に試し、**最初に成功したものを採用**する。

| # | 方式 | ヘッダ / 本文 | 得られる情報 | 備考 |
|---|---|---|---|---|
| 1 | SalonOne SSO | `Authorization: Bearer …` | 役割・アクセス店舗 | 上流 `/me` で検証（`lib/salonone-auth.js`） |
| 2 | エージェントトークン | `X-CC-Agent-Token` | source=agent 固定 | **サーバー間のみ。フロントには絶対に出さない** |
| 3 | Vercel Cron | `Authorization: Bearer $CRON_SECRET` | source=cron | |
| 4 | root トークン | body `token` | role=root | `hashOwnerToken('__root__', DASHBOARD_PASSWORD, AUTH_SALT)` |
| 5 | オーナートークン | body `owner` + `token` | 役割・管轄店舗 | 既存 settlement-auth と同じ照合 |
| 6 | いずれも無し | — | `verified: false` | authz がほぼ全て拒否する |

**名乗りは残すが信じない**: 確認できなかった場合も `role` は body の値を残す（ログで「何を名乗ったか」が分かる）が、
`verified: false` なので authz は `unauthenticated` で拒否する。

**エージェントが `role: 'root'` を名乗っても `source` は `agent` に固定**される。これが崩れると承認をすり抜けるため、テストで固定している。

秘密の比較は長さ差で早期 return しない実装（`safeEqual`）。

---

## 5. 段階導入

`cc_authz` フラグ（KV・`naoru:cc:flags:v1`）で切り替える。**環境変数ではないので再デプロイ不要。**

| mode | 判定 | 記録 | ブロック | 用途 |
|---|:--:|:--:|:--:|---|
| **`off`（既定）** | **しない** | — | — | 現在。本人確認すら呼ばないので**追加コスト0・従来と完全に同一動作** |
| `log` | する | 拒否相当を監査ログへ | しない | **どれだけ拒否が出るかを実データで測る** |
| `warn` | する | 同上 | しない（`X-CC-Authz` ヘッダで警告） | フロントの未対応箇所を洗い出す |
| `enforce` | する | する | **403** | 本番適用 |

レスポンスには常に `X-CC-Authz: <mode>:<allow|コード>` を付ける（`off` のときは付けない）。

### 昇格の条件

```
off → log      … いつでも可（影響なし）
log → warn     … log で1週間運用し、拒否の中身を確認してから
warn → enforce … 実データの拒否件数が 0 になってから（§8-1）
```

---

## 6. 既知の穴（`enforce` に上げる前に必ず塞ぐ）

### 6-1. 🔴 フロントがまだトークンを送っていない

現在フロントは `/api/plan-store` に `Authorization` も `owner`/`token` も送っていない。
`enforce` に上げると **全てのCC機能が 401/403 になる**。

→ **対応**: 既存の `window.fetch` インターセプタ（`/api/salonone` と `/api/settlement-store` に既にある仕組み）を
`/api/plan-store` にも広げ、SSOセッションなら Bearer、オーナーPASSなら `owner`/`token` を自動付与する。
**これを先に入れないと `log` の数字も読めない。**

### 6-2. 🟠 オーナーアカウントの読み込みが env と KV のみ

`ccLoadAccounts()` は `SETTLEMENT_OWNER_PASSWORDS` と KV の `naoru:acctpass:v1` しか読まない。
**GAS「オーナー設定」シートにしか存在しないアカウントは確認できない**（GASは遅いためリクエスト毎に呼べない）。

→ **対応案**: `lib/handlers/settlement-auth.js` の `loadAccounts()` を `lib/accounts.js` へ抽出し、
結果を短時間（60秒程度）メモ化して共有する。

### 6-3. 🟠 `manager` を持つアカウントがまだ存在しない

役割は定義したが、「オーナー設定」タブの役割選択に `manager` がない。
→ **対応**: 役割選択に追加（UI変更なので別PR）。それまで店長は `owner` か `staff` のまま。

### 6-4. 🟡 `/api/salonone` は対象外

CLAUDE.md にあるとおり「データGETはブランド全体を既定にする」設計のため、ここは未認証GETのまま。
**本設計の対象外**であることを明記しておく（店舗の絞り込みはUIレベル）。

### 6-5. 🟡 `CC_AGENT_TOKEN` は未設定

エージェント経路は**環境変数が設定されるまで成立しない**（未設定なら誰も agent になれない＝安全側）。
設定は人が行う（`INTEGRATION_PLAN.md` §J-2）。

---

## 7. 検証（Preview / fixture）

### 7-1. fixture テスト（実装済み・自動）

`tests/authz.test.js` **53件** — 6種類の主体 × 指定された全操作を表で網羅。

- AIエージェントが承認系を1つも通せないこと（`role: 'root'` を名乗っても）
- キルスイッチの非対称（止める↔解除）
- リスク別の引き上げ・提案者本人の承認禁止
- 店舗スコープ（管轄外の拒否・`shops` 未設定は全店ではない）
- 未認証・未定義操作の既定拒否
- `off`/`log`/`warn` が**決してブロックしない**こと

`tests/actor.test.js` **15件** — 本人確認。

- クライアントが `root` を名乗っても `verified: false` のまま
- エージェントが `role: 'root'` を名乗っても `source` は `agent`
- `CC_AGENT_TOKEN` 未設定なら agent 経路が成立しない
- 上流の `/me` が落ちても例外にならず次の手段へ進む

### 7-2. Preview で確認すること（人の手）

| # | 手順 | 期待 |
|---|---|---|
| 1 | `cc_authz` が `off` のまま全機能を操作 | **今までと完全に同じ**。`X-CC-Authz` ヘッダも付かない |
| 2 | `log` に上げて同じ操作 | 動作は変わらない。監査ログに `authz_deny` が溜まる |
| 3 | 監査ログの `authz_deny` を読む | **どの操作が誰に拒否されているか**が分かる（§6-1 の未対応が見える） |
| 4 | `warn` でレスポンスヘッダ `X-CC-Authz` を確認 | `warn:unauthenticated` 等が返る |
| 5 | `enforce` にして staff アカウントでフラグ変更 | **403** が返り、画面にエラーが出る |
| 6 | `enforce` を `off` に戻す | 即座に元通り（再デプロイ不要） |

⚠️ **`enforce` の end-to-end 検証には共有ストア（KV）が必要**。ストア未設定の環境では
フラグが読めず `off` 扱いになるため、上の 2〜6 は Preview に KV がある場合のみ実施できる。

---

## 8. `enforce` へ上げる判断基準

### 8-1. 満たすべき条件

- [ ] §6-1 のフロント側トークン付与が入っている
- [ ] §6-2 のアカウント読み込みが GAS を含む
- [ ] `log` モードで **1週間以上**運用した
- [ ] その期間の `authz_deny` のうち、**正当な操作に対する拒否が 0 件**
- [ ] `manager` 役割を持つアカウントが作成済み（§6-3）
- [ ] `CC_AGENT_TOKEN` が設定済み（§6-5）
- [ ] 戻し方（`cc_authz` を `off` に）を運用者が実際に試した

### 8-2. 承認者

`INTEGRATION_PLAN.md` §J-8 のとおり **技術責任者の承認が必要**。

---

## 9. この設計で守れないこと（正直に）

| 守れないこと | なぜ |
|---|---|
| フロントに置いた秘密の保護 | ブラウザに渡した時点で読める。だから `CC_AGENT_TOKEN` はサーバー間専用 |
| SalonOne 側のデータ分離 | `/api/salonone` は未認証GET（§6-4）。厳密な分離には別途プロキシ認証が要る |
| 役割の詐称そのものの防止 | トークンを盗まれたらその人として動ける。トークンの有効期限・失効は別課題（`INTEGRATION_PLAN.md` §2.4） |
| 承認済み提案の「実行」の正しさ | 実行するのは naoru-ai-platform 側。Dashboard は承認状態を渡すだけ |

---

## 10. 未解決（人の判断が必要）

| # | 論点 | 誰に |
|---|---|---|
| 1 | `manager` を誰に付与するか（店長の定義） | 経営 |
| 2 | owner が **自店の高リスク提案**（SNS投稿等）を承認できなくてよいか | 経営 |
| 3 | `CC_AGENT_TOKEN` の発行・保管・ローテーション | 技術責任者 |
| 4 | トークンに有効期限を入れるか（現在は無期限） | 技術責任者 |
| 5 | `enforce` へ上げる時期 | 技術責任者 |
