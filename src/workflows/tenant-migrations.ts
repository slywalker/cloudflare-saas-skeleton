/**
 * migrations-tenant/*.sql を既存の全テナント D1 へ追随させる Workflow。
 *
 * 起動は手動 (`wrangler workflows trigger tenant-migrations`) を主用途とする
 * (HTTP ルートは設けない。README「運用」節参照)。同一テナントDBに対する
 * 多重起動は進捗管理表の同時書き込み衝突を招きうるため運用上禁止する
 * (src/lib/tenant-migrate.ts のコメント参照)。
 *
 * 1テナントの失敗が他テナントへの適用を止めないよう、テナント毎に
 * `step.do` を分け、リトライを使い切って最終的に失敗した場合も
 * ループ側で catch して結果に集約する。ただし全体としては「失敗が
 * あったのに気づかれない」事態を避けるため、失敗が1件でもあれば
 * 最後に Error を投げて Workflow インスタンス自体を失敗ステータスにする。
 */
import { WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { tenants } from "../db/schema";
import { resolveTenantDbStrict } from "../lib/tenant-db-factory";
import { applyPendingMigrations } from "../lib/tenant-migrate";
import { tenantMigrationsParamsSchema, type TenantMigrationsParams } from "../shared/tenant-migrations";

export type { TenantMigrationsParams };

interface TenantMigrationFailure {
  tenantId: string;
  error: string;
}

interface TenantMigrationsResult {
  totalTenants: number;
  /** 1件以上マイグレーションを適用した(または適用対象が0件で成功した)テナント数。 */
  succeededTenants: number;
  /** テナントID -> このWorkflow実行で新たに完了したマイグレーション名。 */
  appliedByTenant: Record<string, string[]>;
  failures: TenantMigrationFailure[];
}

export class TenantMigrationsWorkflow extends WorkflowEntrypoint<CloudflareBindings, TenantMigrationsParams> {
  async run(
    event: WorkflowEvent<TenantMigrationsParams>,
    step: WorkflowStep
  ): Promise<TenantMigrationsResult> {
    // 0. パラメータ検証。tenantIds を渡す場合は1件以上必須 (空配列は「全件」
    //    の意味には解釈しない)。不正なパラメータでのリトライは無意味なため
    //    NonRetryableError で即座に失敗させる。
    const parsed = tenantMigrationsParamsSchema.safeParse(event.payload);
    if (!parsed.success) {
      throw new NonRetryableError(
        `Workflow パラメータが不正です: ${parsed.error.message}`,
        "InvalidTenantMigrationsParams"
      );
    }
    const { tenantIds } = parsed.data;

    // 1. 対象テナントを台帳 (DB_CONTROL) から列挙する。
    //    プロビジョニング未完了 (status != active) や d1DatabaseId 未設定の
    //    テナントは適用対象外 (テナントDBがまだ存在しない/不整合な状態のため)。
    const targets = await step.do("list-tenants", async () => {
      const db = drizzle(this.env.DB_CONTROL);
      const conditions = [eq(tenants.status, "active"), isNotNull(tenants.d1DatabaseId)];
      if (tenantIds) {
        conditions.push(inArray(tenants.id, tenantIds));
      }
      return db
        .select({ id: tenants.id, d1DatabaseId: tenants.d1DatabaseId })
        .from(tenants)
        .where(and(...conditions));
    });

    const appliedByTenant: Record<string, string[]> = {};
    const failures: TenantMigrationFailure[] = [];

    // 2. テナント毎に独立した step でマイグレーションを適用する。
    //    リトライを使い切った最終失敗はここで catch し、次のテナントの
    //    処理を継続する (1テナントの障害が全体を止めない)。
    for (const tenant of targets) {
      try {
        const applied = await step.do(
          `migrate:${tenant.id}`,
          {
            retries: {
              limit: 3,
              delay: "10 seconds",
              backoff: "exponential",
            },
            timeout: "2 minutes",
          },
          async () => {
            // 暗黙のローカルフォールバックは許さない (TENANT_DB_MODE=local が
            // 明示されている場合のみローカルDBを使う)。secrets 未設定などで
            // 解決できない場合はリトライしても直らないため NonRetryableError。
            const tenantDb = resolveTenantDbStrict(this.env, tenant.d1DatabaseId);
            if (!tenantDb) {
              throw new NonRetryableError(
                `テナントDBを解決できませんでした (tenantId=${tenant.id}, d1DatabaseId=${tenant.d1DatabaseId ?? "null"}). ` +
                  "TENANT_DB_MODE=local の明示、または CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN の設定を確認してください。",
                "TenantDbUnresolvable"
              );
            }
            return applyPendingMigrations(tenantDb);
          }
        );
        appliedByTenant[tenant.id] = applied;
      } catch (err) {
        failures.push({
          tenantId: tenant.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const result: TenantMigrationsResult = {
      totalTenants: targets.length,
      succeededTenants: Object.keys(appliedByTenant).length,
      appliedByTenant,
      failures,
    };

    // 3. 失敗の可視化: 結果サマリは常にログし、失敗が1件でもあれば
    //    Workflow インスタンス自体を失敗ステータスで終える(黙って
    //    「一部成功」を返さない)。
    console.log("[tenant-migrations] result:", JSON.stringify(result));
    if (failures.length > 0) {
      console.error(
        `[tenant-migrations] ${failures.length}/${targets.length} テナントで失敗: ` +
          failures.map((f) => f.tenantId).join(", ")
      );
      throw new Error(
        `テナントマイグレーションが ${failures.length}/${targets.length} 件失敗しました (tenantIds: ${failures
          .map((f) => f.tenantId)
          .join(", ")})`
      );
    }

    return result;
  }
}
