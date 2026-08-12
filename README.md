# Cloudflare SaaS Skeleton

Cloudflare Workers 上で動くマルチテナント SaaS の最小スケルトン。
テナント毎に D1 データベースを動的に作成し、Cloudflare REST API 経由で
アクセスする構成を核とする。

## アーキテクチャ

```
                         ┌─────────────────────┐
  Host: acme.example.com │      Worker          │
  ─────────────────────► │  (src/index.ts)      │
                         │                       │
                         │  1. tenantMiddleware  │──► KV (台帳キャッシュ, 60s TTL)
                         │     Host からサブドメイン │
                         │     を抽出→台帳を引く    │──► DB_CONTROL (中央 D1, 静的バインディング)
                         │                       │       tenants / users / organization /
                         │  2. /api/auth/**      │       member / subscriptions ...
                         │     better-auth       │
                         │     (organization)    │
                         │                       │
                         │  3. /api/tenants      │──► Cloudflare REST API
                         │     プロビジョニング     │     POST /accounts/{id}/d1/database
                         │                       │     POST .../d1/database/{uuid}/query
                         │  4. テナントAPI         │       (テナント毎 D1, 動的作成・
                         │     (TenantDb 経由)     │        静的バインディング不可)
                         │                       │
                         │  5. SPA (ASSETS)      │
                         └─────────────────────┘
```

- **中央 D1 (`DB_CONTROL`)**: `tenants` (台帳), better-auth のコアテーブル
  (`user`/`session`/`account`/`verification`) と organization プラグインの
  テーブル (`organization`/`member`/`invitation`)、`subscriptions` を持つ。
  Drizzle でスキーマ管理し `wrangler.jsonc` に静的バインディングされる。
- **テナント D1 (テナント毎)**: `POST /api/tenants` でサインアップ後に作成。
  D1 は「テナント数だけ動的に増える」ため wrangler.jsonc に事前バインドできず、
  Cloudflare REST API (`/accounts/{account_id}/d1/database`, `.../query`) を
  `fetch` で叩く薄いクライアント `TenantDb` (`src/lib/tenant-db.ts`) 経由で
  アクセスする。
- **テナントルーティング**: `src/middleware/tenant.ts` が Host ヘッダの
  サブドメインから台帳を引き、`c.set("tenant", ...)` / `c.set("tenantDb", ...)`
  する。apex/www (ルートドメイン) は素通しし SPA・認証ルートに委ねる。

## ディレクトリ構成

```
src/
  index.ts            # Hono エントリポイント (ミドルウェア/ルート登録)
  db/schema.ts         # 中央 D1 の Drizzle スキーマ (better-auth + tenants + subscriptions)
  lib/
    auth.ts            # better-auth + better-auth-cloudflare + organization プラグイン
    tenant-db.ts        # Cloudflare REST API 経由の D1 作成・クエリ実行クライアント
  middleware/tenant.ts # サブドメイン→テナント解決ミドルウェア
  routes/tenants.ts    # POST /api/tenants (D1作成→台帳登録→初期マイグレーション)
  shared/schemas.ts    # サーバ・クライアント共有の zod スキーマ
  types/               # CloudflareBindings の secrets 拡張, ?raw import 宣言
  client/               # React SPA (Vite, TanStack Router/Query, shadcn/ui 風コンポーネント)
migrations/            # 中央 D1 用マイグレーション (drizzle-kit generate で生成)
migrations-tenant/     # テナント D1 用の素の SQL (プロビジョニング時に適用)
```

## セットアップ

パッケージマネージャは pnpm (`package.json` の `packageManager` フィールドで
バージョン固定)。Node.js に付属の corepack で用意する。

```bash
corepack enable
corepack prepare pnpm@10.34.5 --activate   # package.json の packageManager と揃える

pnpm install --frozen-lockfile

# 中央 D1 の作成 (発行された database_id を wrangler.jsonc の
# d1_databases[0].database_id に反映する)
pnpm exec wrangler d1 create saas-control

# セッション/台帳キャッシュ用 KV の作成 (id を wrangler.jsonc の
# kv_namespaces[0].id に反映する)
pnpm exec wrangler kv namespace create KV

# 中央 D1 マイグレーションの適用
pnpm run db:migrate:local   # ローカル (wrangler dev 用)
pnpm run db:migrate:remote  # 本番

# secrets の設定 (機密情報は wrangler.jsonc に書かず secret で渡す)
pnpm exec wrangler secret put CLOUDFLARE_ACCOUNT_ID
pnpm exec wrangler secret put CLOUDFLARE_API_TOKEN   # D1 Edit 権限が必要 (テナントDB作成用)
pnpm exec wrangler secret put BETTER_AUTH_SECRET

pnpm run dev      # vite dev (Workers ランタイムと統合)
pnpm run build    # 型チェック無しのビルド確認 (client + worker)
pnpm run typecheck
pnpm run deploy
```

### CLOUDFLARE_API_TOKEN の作成指針

`src/lib/tenant-db.ts` がこのトークンで Cloudflare REST API (`/accounts/{account_id}/d1/database*`)
を叩き、テナント D1 の動的作成・クエリ実行を行う。[Cloudflareダッシュボード → My Profile → API Tokens]
で以下のように作成すること。

- **アカウントスコープの「D1:Edit」権限のみ**を付与した最小権限トークンにする。
  他の権限(Workers編集、DNS編集等)は不要なので付与しない。
- D1 は個々のデータベースをリソースとして指定した権限の絞り込みが (2026年8月時点で)
  できないため、「アカウント内の全D1データベースへのEdit権限」となる点に留意する。
- **このトークンが漏洩すると、そのアカウント配下の全テナントDBに影響する**
  (読み書き・削除が可能になる)。`wrangler secret put` でのみ保管し、
  コードや `.dev.vars`(ローカル開発用ファイル)へのコミットは厳禁。
  `.dev.vars` は `.gitignore` 済みだが、誤ってコミットしないよう十分注意すること。

`wrangler.jsonc` の `vars.APP_ROOT_DOMAIN` を実際のベースドメインに、
`vars.BETTER_AUTH_URL` を実際のオリジンに書き換えること。

## ローカル開発

Cloudflare アカウントを持っていなくても、`git clone → pnpm install --frozen-lockfile → 数コマンド →
pnpm run dev` だけでサインアップ〜テナント作成〜`/api/items` までひと通り
動かせる。`@cloudflare/vite-plugin` が Miniflare でD1/KVをローカルに模擬する
ため、`wrangler.jsonc` の `database_id`/`kv_namespaces[].id` が `"TODO"` の
プレースホルダのままでも `pnpm run dev` は問題なく起動する
(Miniflareはこれらの値をローカルの識別子としてのみ使う)。

1. **依存インストール**
   ```bash
   pnpm install --frozen-lockfile
   ```
2. **一発セットアップ** (`.dev.vars` の用意 + 中央D1へのローカルマイグレーション適用)
   ```bash
   pnpm run setup:local
   ```
   内部的には次を行っている(個別に実行してもよい):
   - `.dev.vars.example` → `.dev.vars` のコピー (無ければ)
   - `pnpm run db:migrate:local` (`wrangler d1 migrations apply DB_CONTROL --local`)
3. **開発サーバ起動**
   ```bash
   pnpm run dev
   ```
   `http://localhost:5173` でSPA・APIともに動く。
4. **テナントのサブドメイン動作を試す**: ブラウザでは `http://acme.localhost:5173`
   のような URL がそのまま使える(crossSubDomainCookies が有効で、
   `*.localhost` 間でセッションCookieが共有されるため)。`curl` で試す場合は
   `--resolve acme.localhost:5173:127.0.0.1` を付けること
   (`curl` の Cookie ジャーは `.localhost` ワイルドカードドメインの
   Cookieをクロスホスト送信時に添付しないことがあるため、`curl` での
   動作確認は `-H "Cookie: <値>"` で明示的に付ける方が確実)。

### テナントDBのローカル対応(核心の割り切り)

本番の `TenantDb` (`src/lib/tenant-db.ts`) は Cloudflare REST API 前提で、
ローカルには存在しないAPIのため動かない。そこで `src/lib/tenant-db-factory.ts`
の `resolveTenantDb` が本番/ローカルを自動判定する:

- **判定条件**: `CLOUDFLARE_API_TOKEN` が未設定(`.dev.vars` を埋めていない
  通常のローカル開発)、または `TENANT_DB_MODE=local` を明示した場合に
  ローカルモードになる。
- **ローカルモードの動作**: `wrangler.jsonc` に静的バインディングした
  `DB_TENANT_LOCAL` という **共有D1を全テナントで使い回す** 、という
  スケルトンとしての割り切りを行っている。テナント作成時もCloudflare REST
  APIでのD1作成はスキップし、台帳の `d1DatabaseId` には固定値 `"local"` を
  記録するだけ。**テナント間のデータ分離はローカルでは無い**
  (`items` テーブルは全テナント共通)。本番相当のテナント分離を確認したい
  場合は `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` を実際に設定して
  本番モードで動かす必要がある。
- **インターフェース**: `TenantDb` (REST版) と `LocalTenantDb` (ローカル版)
  はどちらも共通の `TenantDbLike` インターフェース (`prepare().bind().all()/
  first()/run()`, `exec()`) を実装しており、呼び出し側 (`routes/tenants.ts`,
  `middleware/tenant.ts`, `index.ts`) は本番/ローカルを分岐するコードを
  一切書いていない。

## D1 の制約に関する注意

- **単一データベースあたり 10GB** が上限。テナント毎 D1 の設計はこの上限を
  「テナント単位」に分散させることで回避する狙いだが、1テナントが 10GB を
  超える成長をした場合の分割・移行戦略は別途検討が必要 (このスケルトンには
  含まれない)。
- **単一ライタ (単一プライマリリージョン) モデル**。D1 は書き込みが単一の
  プライマリロケーションに集約されるため、グローバルに分散した大量同時書き込み
  ワークロードには向かない。読み取りは Read Replication で分散可能。
- REST API 経由のテナント D1 アクセスは **HTTPラウンドトリップのレイテンシ**
  が乗る (ネイティブバインディングと比べて明確に遅い)。高頻度アクセスが
  必要になった場合は Durable Objects 経由のプロキシや、テナント数が少ない
  間はネイティブバインディングへの切り替えも検討候補。
- テナント D1 の作成・削除は Cloudflare アカウント単位の **D1 データベース数
  上限** (プラン依存) に影響される。
- **テナントDB群へのマイグレーション追随**: `migrations-tenant/*.sql` は
  ファイル名昇順に管理される。新規テナントのプロビジョニング時
  (`POST /api/tenants`) は未適用分を全て順に適用する
  (`src/lib/tenant-migrate.ts` の `applyPendingMigrations`。適用済みかどうかは
  各テナントDBの `d1_tenant_migrations` 管理表で判定する)。
  既存テナント群への追随は Cloudflare Workflows
  (`src/workflows/tenant-migrations.ts`, binding: `TENANT_MIGRATIONS`) が
  台帳から `status = 'active'` かつ `d1DatabaseId` 設定済みのテナント
  (または `tenantIds` で指定した対象) を列挙し、テナント毎に
  `applyPendingMigrations` を適用する。1テナントの失敗
  (リトライを使い切った場合を含む) が他テナントへの適用を止めないよう
  テナント毎に独立した Workflow step にしてあるが、失敗が1件でもあれば
  最後に Error を投げて **Workflow インスタンス自体は失敗ステータスで
  終わる** (実行結果とログには成功/失敗の内訳を残す)。テナントDBが
  解決できない場合 (secrets 未設定など) はリトライせず即座に失敗する
  (`NonRetryableError`)。
  - **新しいマイグレーションの追加手順**: `migrations-tenant/000N_xxx.sql`
    を追加 → デプロイ → `wrangler workflows trigger tenant-migrations` で
    既存テナントに追随させる。`{"tenantIds": ["..."]}` を渡すと対象を絞れる
    (空配列は検証エラーになる。「全件」を意図する場合は `tenantIds` 自体を
    省略すること)。
  - **同時実行**: 進捗管理表への書き込みに行ロック等の排他制御は無いため、
    同一テナントDBに対して `wrangler workflows trigger tenant-migrations`
    を多重起動しない運用を前提とする。
  - **ローカルでの挙動**: `TENANT_DB_MODE=local` は全テナントが共有D1
    (`DB_TENANT_LOCAL`) に同居するため、`d1_tenant_migrations` 管理表も
    共有になり、実質「DB全体に対して1回だけ」適用される (テナント毎の
    個別履歴にはならない)。Workflow は `TENANT_DB_MODE=local` が明示されて
    いる場合のみローカルDBを使い、それ以外で本番用 secrets が欠けている
    場合は (意図せずローカルへフォールバックせず) 即座に失敗する。
  - **導入前に作成済みのテナントDBとの互換性**: この仕組み導入前に
    プロビジョニングされたテナントDBには `d1_tenant_migrations` 管理表が
    無いため、初回実行時に `0001_init.sql` が (管理表作成後) 未適用扱いで
    再適用される。同ファイルは `IF NOT EXISTS` のみで構成されているため
    無害。
  - **新規マイグレーション作成時の注意**: 適用は `src/lib/tenant-db.ts` の
    `splitSqlStatements` で `;` 区切りに分割してから1文ずつ実行するため、
    ブロックコメント (`/* */`) やトリガ定義・文字列リテラル内の `;`/`--` は
    未対応。既存の `0001_init.sql` と同じ書式 (行コメント `--`、文末 `;`)
    に揃え、各文は極力冪等 (`IF NOT EXISTS` 等) に書くこと。
  - **スケール上の制約 (スコープ外)**: テナント数が数千規模になると、
    Workflow の総ステップ数上限や1回の実行結果のペイロードサイズ上限に
    抵触しうる。その場合は `tenantIds` によるチャンク分割起動、または
    複数インスタンスへの分割実行が必要になるが、本スケルトンの
    スコープ外とする。

## Queues (ジョブキュー基盤)

Stripe / Resend 等の外部 API を API ハンドラから直接呼ばない原則
(CLAUDE.md「約束事」) を支える基盤として、Cloudflare Queues の骨組みを導入
済み。実際の外部 API 連携 (Stripe決済・Resendメール送信) 自体はスコープ外
で、ジョブ型とディスパッチのプレースホルダのみ用意している。

- **メッセージ型**: `src/shared/jobs.ts` の `jobMessageSchema`
  (zod discriminatedUnion)。現状は `email.send` と
  `stripe.webhook.process` の2種のプレースホルダ。
- **投入**: `src/lib/jobs.ts` の `enqueueJob(env, job)`。API ハンドラは
  外部 API を直接呼ばず、必ずこれでキューへ投入すること。
- **消費**: `src/queues/consumer.ts` の `handleJobsBatch`
  (`src/index.ts` の default export の `queue` から配線)。
  - 不正なメッセージ形式 (`jobMessageSchema` でパース不能) はリトライしても
    直らないため `message.ack()` して破棄する。**この ack は復元不能**:
    このキューには DLQ 以外の永続化先が無く、ack 済みメッセージはどこにも
    残らない。そのため ack する前に `message.id` と message.body (先頭
    2000文字に切り詰め) を必ず `console.error` へ残す。後から調査する
    場合は Cloudflare の観測性ログ (Logpush 等) を頼ることになる。
  - ジョブ処理中の例外、および (将来 JobMessage に型を追加した際に consumer
    側の case 追加が漏れていた場合の) 未知のジョブ種別は `message.retry()`
    する。`wrangler.jsonc` の `queues.consumers[].max_retries` (3) を
    使い切ると `dead_letter_queue` (`jobs-dlq`) へ自動的に送られる。
  - 現状の各 `case` は `console.log` のプレースホルダで、実際の
    Resend/Stripe 連携は未実装 (TODO コメントを参照)。
  - switch 文には `default` 節で `const _exhaustive: never = job` による
    網羅性チェックを入れてあり、`JobMessage` に新しい type を追加したのに
    consumer 側の case 追加を忘れると `tsc` がコンパイルエラーにする。
- **本番デプロイ前の準備**: キューは事前に作成しておく必要がある。
  ```
  wrangler queues create jobs
  wrangler queues create jobs-dlq
  ```
  `jobs-dlq` の作成を忘れると、`dead_letter_queue` が存在しないキューを
  指すことになり `wrangler deploy` がエラーで失敗する。
- **DLQ (`jobs-dlq`) の性質**: DLQ 自体には consumer を配線していない
  (溜まったメッセージを処理する仕組みは無く、今後の課題)。また Cloudflare
  Queues のメッセージ保持期間は既定で4日であり、それを過ぎると DLQ に
  退避したメッセージも失われる。「DLQに送られたので後で必ず追える」わけ
  ではない点に注意。
- **ローカルでの動作確認**: `@cloudflare/vite-plugin` (`pnpm run dev`) は
  wrangler.jsonc の `queues.producers`/`consumers` 設定を miniflare の
  Worker オプションへ変換して起動する。ローカルの `vite dev` で実際に
  producer (`enqueueJob`) → consumer (`handleJobsBatch`) → (リトライ枯渇
  時の) DLQ 退避までの一連の流れを実測済み: 例外を投げるジョブを投入すると
  初回実行 + `max_retries` (3) 回のリトライの後、メッセージが `jobs-dlq`
  へ移動することを確認した。キューの事前作成は不要 (ローカルでは
  miniflare が自動的に用意する)。ただし本スケルトンには `enqueueJob` を
  実際に呼び出す HTTP ルートがまだ無いため、通常の開発フロー
  (`pnpm run typecheck` / `pnpm run build` / `pnpm run dev`) の中で
  日常的に確認する経路は無い。次に Stripe/Resend 連携を実装し
  `enqueueJob` の呼び出し箇所ができた時点で、通常のエンドツーエンド確認が
  可能になる。

## スコープ外 (今回未実装)

Stripe 決済、Resend メール送信の実処理は本スケルトンの対象外。
`subscriptions` テーブルと `src/routes/` 以下にディレクトリの空きと TODO
コメント程度の下地のみ用意している。Queues はジョブキュー基盤(上記参照)を
導入済みだが、Resend/Stripe の実処理自体は未実装。Workflows は
テナントDBマイグレーション追随のみ実装済み (上記参照)。

## セキュリティ (依存関係・サプライチェーン)

パッケージマネージャは pnpm (`package.json` の `packageManager` フィールドで
`pnpm@10.34.5` に固定)。以下の3方針でサプライチェーンリスクを下げている。
設定は `pnpm-workspace.yaml` に集約している(pnpm 10.x/11.x では
`minimumReleaseAge`/`onlyBuiltDependencies` の正式な設定箇所は
`.npmrc`/`package.json`の`pnpm`フィールドではなく`pnpm-workspace.yaml`)。

1. **lockfile 厳守**: `pnpm install --frozen-lockfile` を CI・セットアップ
   手順の両方で使う。`pnpm-lock.yaml` に無いバージョンへ暗黙に解決されることを
   防ぐ。ローカルで依存を追加/更新した場合は必ず `pnpm-lock.yaml` の差分を
   コミットに含めること。
2. **minimumReleaseAge (公開から7日間はインストールしない)**:
   `pnpm-workspace.yaml` に `minimumReleaseAge: 10080` (分単位=7日) を設定。
   npmアカウント乗っ取りによる悪意あるバージョンの即時公開・即時流通
   (2025年以降に実際に多発した攻撃パターン) に対し、公開直後の数日で
   コミュニティが異常検知・撤回するまでの猶予を稼ぐ。緊急に最新版が必要な
   パッケージは `minimumReleaseAgeExclude` で個別に除外できる(現状未使用)。
3. **install スクリプト許可制 (onlyBuiltDependencies)**: pnpm は既定で
   依存の `preinstall`/`install`/`postinstall` ライフサイクルスクリプトを
   ブロックする。本プロジェクトで実際にビルド(ネイティブバイナリ取得等)が
   必要で許可しているのは以下の2つのみ (`pnpm-workspace.yaml` 参照):
   - **`esbuild`**: `drizzle-kit`(内部の `@esbuild-kit/*`)や `wrangler`
     経由で必要。postinstallスクリプトがプラットフォーム対応のネイティブ
     バイナリを取得するために必須(スクリプトを止めるとesbuild自体が
     動作しない)。
   - **`workerd`**: `wrangler`/`@cloudflare/vite-plugin`/`miniflare` が
     ローカル開発 (`pnpm run dev`) で使う Workers ランタイム本体。
     postinstallでプラットフォーム対応バイナリを取得する。これが無いと
     `pnpm run dev` 自体が起動しない。
   これ以外の依存で `Ignored build scripts` 警告が出た場合は、
   `pnpm why <package>` で依存経路を確認し、本当に必要かを検討してから
   `onlyBuiltDependencies` に追加すること(安易な許可は避ける)。
4. **CI での監査**: `.github/workflows/ci.yml` で
   `pnpm audit --prod --audit-level high` を実行し、本番依存に
   high以上の既知脆弱性が無いことを毎回確認する(失敗時はCIが赤くなる)。

## 実装上の判断メモ

- **better-auth スキーマ生成**: `npx @better-auth/cli generate` は実行時の
  auth 設定 (D1 バインディング含む) を introspect する都合上、D1 未接続の
  スケルトン単体では安定して動かせなかったため、公式ドキュメントのデフォルト
  スキーマ (core + organization plugin + better-auth-cloudflare の
  geolocation 拡張フィールド) に忠実な手書き Drizzle スキーマとした
  (`src/db/schema.ts` 冒頭のコメント参照)。フィールド名を変更する場合は
  better-auth 側の期待値とズレないよう要注意。
- **organization ⇔ tenants の対応**: `organization.id` をそのまま
  `tenants.id` として再利用する 1:1 対応とした。将来 1つの organization が
  複数テナントを持つ要件が出た場合はこの前提を見直す必要がある。
- **認証・認可**: `POST /api/tenants` は `src/middleware/session.ts` の
  `requireSession` で認証必須 (未認証は401)。テナントスコープAPI
  (`/api/items` 等) は `src/middleware/authz.ts` の `requireTenantMember` で
  「セッション必須 + 当該テナント(organization)の member であること」まで
  検証する (member でなければ403)。
- **テナント作成 = organization作成**: `POST /api/tenants` は
  `auth.api.createOrganization` で better-auth 側の organization を先に作り、
  その `organization.id` を台帳 (`tenants.id`) にそのまま採番する
  (`crypto.randomUUID` による独自採番は廃止)。D1作成やマイグレーション適用に
  失敗した場合は、作成済みD1の削除・台帳行の削除まで行い再試行可能な状態に
  戻す (中途半端な"failed"行を残さない)。
- **予約サブドメイン**: `www`/`api`/`app`/`admin`/`auth` 等は
  `src/shared/schemas.ts` の `RESERVED_TENANT_SLUGS` でテナントslugとして
  拒否する。
- **Hostヘッダ偽装対策**: `wrangler.jsonc` で `workers_dev: false` とし、
  `routes` でこのWorkerが応答するホスト名パターンを本番ドメインに限定する
  (プレースホルダはコメントアウトしてあるため、実ドメイン確定後に有効化する
  こと)。台帳に存在しないslugはいずれにせよ404になるが、DNS/ルートレベルの
  制限を多層防御として推奨する。
- **tsconfig を worker/client で分離**: ルートの `tsconfig.json` は
  `hono/jsx` + Workers 向け型 (`lib: ESNext`のみ)、`tsconfig.client.json` は
  `react` JSX + DOM 型という前提の違いがあるため2ファイルに分割した
  (`pnpm run typecheck` は両方を実行する)。
