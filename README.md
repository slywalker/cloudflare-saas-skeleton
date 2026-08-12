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

```bash
npm install

# 中央 D1 の作成 (発行された database_id を wrangler.jsonc の
# d1_databases[0].database_id に反映する)
npx wrangler d1 create saas-control

# セッション/台帳キャッシュ用 KV の作成 (id を wrangler.jsonc の
# kv_namespaces[0].id に反映する)
npx wrangler kv namespace create KV

# 中央 D1 マイグレーションの適用
npm run db:migrate:local   # ローカル (wrangler dev 用)
npm run db:migrate:remote  # 本番

# secrets の設定 (機密情報は wrangler.jsonc に書かず secret で渡す)
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put CLOUDFLARE_API_TOKEN   # D1 Edit 権限が必要 (テナントDB作成用)
npx wrangler secret put BETTER_AUTH_SECRET

npm run dev      # vite dev (Workers ランタイムと統合)
npm run build    # 型チェック無しのビルド確認 (client + worker)
npm run typecheck
npm run deploy
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
- **テナントDB群へのマイグレーション追随は未実装**。`migrations-tenant/`
  以下に新しいマイグレーションファイルを追加しても、既存の全テナントDBへ
  自動で適用する仕組みは今のところ無い(プロビジョニング時に最新の
  `0001_init.sql` を適用するだけ)。テナント数が増えた際は Workflows で
  「全テナントを列挙して順にマイグレーションSQLを流す」バッチ処理を実装する
  予定 (今回のスコープ外)。

## スコープ外 (今回未実装)

Stripe 決済、Resend メール送信、Queues、Workflows は本スケルトンの対象外。
`subscriptions` テーブルと `src/routes/` 以下にディレクトリの空きと TODO
コメント程度の下地のみ用意している。

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
  (`npm run typecheck` は両方を実行する)。
