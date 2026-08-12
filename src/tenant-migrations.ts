/**
 * テナント D1 用マイグレーション SQL の一覧。
 *
 * `migrations-tenant/*.sql` を vite の import.meta.glob (?raw, eager) で
 * ビルド時に取り込み、ファイル名昇順の配列として公開する。プロビジョニング
 * (src/routes/tenants.ts) と Workflow (src/workflows/tenant-migrations.ts) の
 * どちらもこの一覧を「適用すべきマイグレーション」の唯一の情報源として使う
 * (適用ロジック自体は src/lib/tenant-migrate.ts に集約)。
 */
const modules = import.meta.glob("../migrations-tenant/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

export interface TenantMigration {
  /** マイグレーションファイル名 (例: "0001_init.sql")。適用済み管理表のキーになる。 */
  name: string;
  sql: string;
}

export const tenantMigrations: TenantMigration[] = Object.entries(modules)
  .map(([path, sql]) => ({ name: path.split("/").pop() as string, sql }))
  .sort((a, b) => a.name.localeCompare(b.name));
