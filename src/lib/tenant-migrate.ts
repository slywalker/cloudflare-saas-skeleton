/**
 * テナント D1 に対して、未適用のマイグレーション (src/tenant-migrations.ts) を
 * 順に適用するヘルパー。プロビジョニング時 (routes/tenants.ts) と、既存テナント
 * 群への追随バッチ (workflows/tenant-migrations.ts) の両方から使う共通処理。
 *
 * 文単位で進捗を記録し、途中失敗(REST API のタイムアウト・一時的な障害等)
 * しても再実行時に「失敗した文」から再開できるようにする (exec で複数文を
 * まとめて流すと、1文目は成功したが3文目で失敗した場合に部分適用のまま
 * 「未適用」扱いになり、再実行で1文目から再度流して衝突する恐れがあるため)。
 */
import { splitSqlStatements, type TenantDbLike } from "./tenant-db";
import { tenantMigrations } from "../tenant-migrations";

/**
 * 適用進捗を記録する管理表。存在しなければ先に作成する。
 * - statements_total / statements_applied: 文単位の進捗。再開時にどこから
 *   続けるかの判断に使う。
 * - applied_at: 全文適用が完了した時刻。NULL の間は「未完了 (再開対象)」。
 *
 * 【同時実行に関する注意】
 * `INSERT OR IGNORE` で pending 行を予約することで「複数の Workflow 実行が
 * 同時に同じマイグレーションへ INSERT する」二重予約は防げるが、
 * 「今まさに他の実行が statements_applied を更新中かどうか」を検知する
 * 仕組みはここには無い (D1 に行ロック取得のAPIが無いため)。
 * このため、同一テナントDBに対して `wrangler workflows trigger
 * tenant-migrations` を多重起動しない運用を前提とする (README 参照)。
 */
const MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS d1_tenant_migrations (
  name TEXT PRIMARY KEY,
  statements_total INTEGER NOT NULL,
  statements_applied INTEGER NOT NULL DEFAULT 0,
  applied_at TEXT
)`;

interface MigrationProgressRow {
  statements_total: number;
  statements_applied: number;
  applied_at: string | null;
}

/**
 * 未適用 (または前回途中で失敗した) マイグレーションを、ファイル名昇順・
 * 文単位で適用する。
 *
 * 戻り値: このコールで新たに完了 (applied_at が記録) したマイグレーション名の配列。
 * 既に完了済みのマイグレーションはスキップする。
 */
export async function applyPendingMigrations(db: TenantDbLike): Promise<string[]> {
  await db.exec(MIGRATIONS_TABLE_SQL);

  const appliedNow: string[] = [];

  for (const migration of tenantMigrations) {
    const statements = splitSqlStatements(migration.sql);

    // (a) pending 行を予約する。既に存在する場合 (前回の途中失敗、または
    //     完了済み) は何もしない。
    await db
      .prepare(
        "INSERT OR IGNORE INTO d1_tenant_migrations (name, statements_total, statements_applied) VALUES (?, ?, 0)"
      )
      .bind(migration.name, statements.length)
      .run();

    // (b) 現在の進捗を読む。完了済みならスキップ。
    const row = await db
      .prepare(
        "SELECT statements_total, statements_applied, applied_at FROM d1_tenant_migrations WHERE name = ?"
      )
      .bind(migration.name)
      .first<MigrationProgressRow>();

    if (!row) {
      // INSERT 直後の SELECT のため通常到達しないが、型を絞り込むためのガード。
      throw new Error(`マイグレーション進捗行の取得に失敗しました: ${migration.name}`);
    }
    if (row.applied_at) {
      continue;
    }

    // (c) 失敗した文から再開し、1文実行するごとに進捗を更新する。
    for (let i = row.statements_applied; i < statements.length; i++) {
      await db.prepare(statements[i]).run();
      await db
        .prepare("UPDATE d1_tenant_migrations SET statements_applied = ? WHERE name = ?")
        .bind(i + 1, migration.name)
        .run();
    }

    // (d) 全文完了を記録する。
    await db
      .prepare("UPDATE d1_tenant_migrations SET applied_at = datetime('now') WHERE name = ?")
      .bind(migration.name)
      .run();

    appliedNow.push(migration.name);
  }

  return appliedNow;
}
