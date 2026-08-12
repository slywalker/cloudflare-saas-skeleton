# cloudflare-saas-skeleton

Cloudflare 上のマルチテナント SaaS の「型」となるスケルトン。詳細なアーキテクチャとセットアップは README.md を参照。

## アーキテクチャの要点

- **中央 D1(`DB_CONTROL`)** = 制御プレーン: tenants 台帳 + better-auth(organization プラグイン)。スキーマは `src/db/schema.ts`、マイグレーションは `migrations/`(drizzle-kit 生成)。
- **テナント毎 D1** = 静的バインディング不可のため、Worker 内から Cloudflare REST API で動的作成・クエリする(`src/lib/tenant-db.ts`)。テナント DB のスキーマは `migrations-tenant/*.sql`(手書き SQL)。
- **テナント解決と認可は別物**: `src/middleware/tenant.ts` は Host サブドメイン→台帳引き(KV キャッシュ)の「解決」のみ。データを返すルートには必ず `src/middleware/authz.ts` の `requireTenantMember` を併用する。
- `tenants.id` は better-auth の `organization.id` と同一(1:1)。テナント作成は必ず organization 作成とセットで行い、失敗時は D1・台帳・organization を全てロールバックする(`src/routes/tenants.ts`)。

## ローカル開発の割り切り(重要)

- `TENANT_DB_MODE=local`(`.dev.vars`)では REST API を使わず、共有ローカル D1 `DB_TENANT_LOCAL` に全テナントが同居する。**テナント間のデータ分離はローカルでは検証できない**。
- 台帳の `d1DatabaseId` はローカルでは文字列 `"local"`。
- 初回は `pnpm run setup:local`(.dev.vars 生成+中央 D1 マイグレーション適用)。
- `compatibility_date` はローカル workerd の対応上限に合わせてある。安易に日付を進めると `pnpm run dev` が起動しなくなる。

## 約束事

- better-auth のスキーマは手書き(`src/db/schema.ts`)。better-auth を更新したら、プラグインが要求する列(例: `invitation.createdAt`)との整合を必ず確認する。
- Stripe / Resend 等の外部 API を API ハンドラから直接呼ばない。必ず Queues を挟む(未実装、導入時の原則)。
- 依存管理は pnpm。`pnpm-lock.yaml` の手編集禁止。新しい lifecycle script が必要な依存は `pnpm-workspace.yaml` の `onlyBuiltDependencies` に理由付きで追加し、README のセキュリティ節も更新する。
- zod スキーマは `src/shared/` に置き、サーバ(@hono/zod-validator)とクライアントで共有する。
- 検証コマンド: `pnpm run typecheck` / `pnpm run build`。テナント DB 群へのマイグレーション追随は未実装(Workflows で実装予定)。

## コミュニケーション

- コード内文字列・コミットメッセージ・ドキュメントは標準語(日本語または英語)で書く。
