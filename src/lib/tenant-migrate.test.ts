import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalTenantDb } from "./tenant-db";
import type { TenantMigration } from "../tenant-migrations";

/**
 * tenantMigrations (src/tenant-migrations.ts) は import.meta.glob で
 * migrations-tenant/*.sql をビルド時に取り込む固定リストのため、テストで
 * 「途中失敗するダミーマイグレーション」を注入できない。vi.mock で差し替え、
 * 各テストが mockMigrations を直接書き換えることで内容を制御する
 * (applyPendingMigrations は呼び出しの都度 tenantMigrations を参照するため、
 * 呼び出し前に配列の中身を書き換えれば反映される)。
 */
const mockMigrations = vi.hoisted(() => [] as TenantMigration[]);
vi.mock("../tenant-migrations", () => ({ tenantMigrations: mockMigrations }));

// vi.mock 適用後に動的 import する (静的 import だとホイスティングの都合上
// モック前の実体を掴む可能性があるため、他のテストと同様 import 文で問題ない
// ケースが大半だが、ここでは明示的にモック後の対象を使う意図を示すため
// 通常の import 文で揃える)。
import { applyPendingMigrations } from "./tenant-migrate";

function setMigrations(migrations: TenantMigration[]) {
  mockMigrations.length = 0;
  mockMigrations.push(...migrations);
}

describe("applyPendingMigrations", () => {
  beforeEach(() => {
    setMigrations([]);
  });

  it("初回適用で管理表が作成され、マイグレーションが記録される", async () => {
    const db = new LocalTenantDb(env.DB_TENANT_LOCAL);
    setMigrations([
      { name: "0001_init.sql", sql: "CREATE TABLE widgets (id INTEGER PRIMARY KEY);" },
    ]);

    const applied = await applyPendingMigrations(db);

    expect(applied).toEqual(["0001_init.sql"]);

    const progress = await db
      .prepare("SELECT name, statements_total, statements_applied, applied_at FROM d1_tenant_migrations WHERE name = ?")
      .bind("0001_init.sql")
      .first<{ name: string; statements_total: number; statements_applied: number; applied_at: string | null }>();
    expect(progress).not.toBeNull();
    expect(progress?.statements_total).toBe(1);
    expect(progress?.statements_applied).toBe(1);
    expect(progress?.applied_at).not.toBeNull();

    // widgets テーブルが実際に作成されている (SQL自体が適用されたことの確認)。
    const inserted = await db.prepare("INSERT INTO widgets (id) VALUES (1)").run();
    expect(inserted).toBeTruthy();
  });

  it("再実行では適用ゼロになる (冪等)", async () => {
    const db = new LocalTenantDb(env.DB_TENANT_LOCAL);
    setMigrations([
      { name: "0001_init.sql", sql: "CREATE TABLE widgets (id INTEGER PRIMARY KEY);" },
    ]);

    const firstRun = await applyPendingMigrations(db);
    expect(firstRun).toEqual(["0001_init.sql"]);

    const secondRun = await applyPendingMigrations(db);
    expect(secondRun).toEqual([]);

    const progress = await db
      .prepare("SELECT statements_applied FROM d1_tenant_migrations WHERE name = ?")
      .bind("0001_init.sql")
      .first<{ statements_applied: number }>();
    expect(progress?.statements_applied).toBe(1);
  });

  it("途中失敗した文から再開し、成功済みの文は再実行しない", async () => {
    const db = new LocalTenantDb(env.DB_TENANT_LOCAL);

    // 1文目は成功、2文目はわざと失敗させる (存在しないテーブルへのINSERT)。
    setMigrations([
      {
        name: "0002_resume.sql",
        sql: [
          "CREATE TABLE resume_marker (id INTEGER PRIMARY KEY);",
          "INSERT INTO this_table_does_not_exist (id) VALUES (1);",
        ].join("\n"),
      },
    ]);

    await expect(applyPendingMigrations(db)).rejects.toThrow();

    // 1文目までは進捗が記録され、完了はしていない。
    const progressAfterFailure = await db
      .prepare(
        "SELECT statements_total, statements_applied, applied_at FROM d1_tenant_migrations WHERE name = ?"
      )
      .bind("0002_resume.sql")
      .first<{ statements_total: number; statements_applied: number; applied_at: string | null }>();
    expect(progressAfterFailure?.statements_total).toBe(2);
    expect(progressAfterFailure?.statements_applied).toBe(1);
    expect(progressAfterFailure?.applied_at).toBeNull();

    // 1文目が既に実行されていることを確認する (再実行なら CREATE TABLE の
    // 重複エラーになるはずなので、ここでは INSERT の成功で間接的に確認)。
    const markerBefore = await db
      .prepare("SELECT COUNT(*) as count FROM resume_marker")
      .first<{ count: number }>();
    expect(markerBefore?.count).toBe(0);

    // 2文目を成功する内容に差し替えて再実行する (文数は変えない)。
    // statements_total (2) は初回実行時に既に記録されているため一致させる。
    setMigrations([
      {
        name: "0002_resume.sql",
        sql: [
          "CREATE TABLE resume_marker (id INTEGER PRIMARY KEY);",
          "INSERT INTO resume_marker (id) VALUES (1);",
        ].join("\n"),
      },
    ]);

    const resumed = await applyPendingMigrations(db);
    expect(resumed).toEqual(["0002_resume.sql"]);

    const progressAfterResume = await db
      .prepare(
        "SELECT statements_total, statements_applied, applied_at FROM d1_tenant_migrations WHERE name = ?"
      )
      .bind("0002_resume.sql")
      .first<{ statements_total: number; statements_applied: number; applied_at: string | null }>();
    expect(progressAfterResume?.statements_total).toBe(2);
    expect(progressAfterResume?.statements_applied).toBe(2);
    expect(progressAfterResume?.applied_at).not.toBeNull();

    // 1文目 (CREATE TABLE) が再実行されていれば "table already exists" で
    // 例外になるはずだが、resumed の成功自体がそれをある程度示す。
    // より直接的に「1文目は1回しか実行されていない」ことを確認するため、
    // resume_marker に重複INSERTによる主キー衝突が起きていないか (2文目が
    // 複数回実行されていないか) を件数で確認する。
    const markerAfter = await db
      .prepare("SELECT COUNT(*) as count FROM resume_marker")
      .first<{ count: number }>();
    expect(markerAfter?.count).toBe(1);
  });
});
