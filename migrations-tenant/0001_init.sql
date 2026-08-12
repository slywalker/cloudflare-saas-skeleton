-- テナント D1 の初期マイグレーション。
-- 各テナントのプロビジョニング時 (POST /api/tenants) に REST API 経由で適用される。
-- 中央 D1 (drizzle-kit 管理) とは別系統: テナント DB は動的作成のため
-- drizzle-kit の対象外とし、プレーン SQL で手動管理する。
--
-- 【既存テナントへの追随】このファイルを含む migrations-tenant/*.sql は、
-- Cloudflare Workflows (src/workflows/tenant-migrations.ts, binding:
-- TENANT_MIGRATIONS) により既存の全テナントDBへも後から適用される
-- (`wrangler workflows trigger tenant-migrations`)。
--
-- 【新規マイグレーション作成時の注意】
-- - 各文は極力冪等に書くこと (`CREATE TABLE IF NOT EXISTS` /
--   `CREATE INDEX IF NOT EXISTS` 等)。適用は文単位で進捗記録されるが、
--   将来別マイグレーションから同じ対象に触れる可能性や、進捗管理表
--   (d1_tenant_migrations) 導入前に手動適用されたテナントとの整合を
--   考えると、非冪等な文 (例: `ALTER TABLE ... ADD COLUMN` を
--   IF NOT EXISTS 無しで) は再適用時にエラーとなり得るため避ける。
-- - 適用は `src/lib/tenant-db.ts` の `splitSqlStatements` で `;` 区切りに
--   分割してから1文ずつ実行する。行コメント (`--`) 以外のコメント
--   (`/* */`) や、トリガ定義・文字列リテラル内の `;`/`--` には対応しない。

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_created_at ON items (created_at);
