/**
 * POST /api/tenants: サインアップ後に呼ぶテナントプロビジョニング API。
 * 認証必須 (requireSession)。
 *
 * 1. better-auth の organization を作成 (auth.api.createOrganization) し、
 *    その organization.id をそのまま tenants.id として採番する
 * 2. 台帳 (中央 D1 の tenants テーブル) に登録 (UNIQUE違反は409)
 * 3. D1 データベースを用意する
 *    - 本番: Cloudflare REST API で新しい D1 データベースを作成
 *    - ローカル開発 (isLocalTenantDbMode): D1作成はスキップし、
 *      wrangler.jsonc の DB_TENANT_LOCAL (共有D1) をそのまま使う。
 *      台帳の d1DatabaseId には "local" を記録する
 *      (テナント間のデータ分離は無い。README「ローカル開発」節参照)。
 * 4. テナント DB に初期マイグレーション (migrations-tenant/0001_init.sql) を適用
 *
 * 3-4 のいずれかに失敗した場合は、作成済みの D1 (あれば・本番のみ)・台帳の行・
 * better-auth の organization レコードをすべて削除し、再試行可能な状態に
 * 戻す(中途半端な"failed"状態を残さない)。ロールバック自体の失敗は
 * console.error でログに残し、クライアントへは元のプロビジョニング失敗
 * エラーを返す。
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { createTenantSchema } from "../shared/schemas";
import { tenants, member, organization } from "../db/schema";
import { createTenantDatabase, deleteTenantDatabase } from "../lib/tenant-db";
import { isLocalTenantDbMode, resolveTenantDb } from "../lib/tenant-db-factory";
import { createAuth } from "../lib/auth";
import { requireSession, type SessionEnv } from "../middleware/session";
import migrationSql from "../../migrations-tenant/0001_init.sql?raw";

/** ローカル開発モードで台帳に記録する d1DatabaseId のセンチネル値。 */
const LOCAL_DATABASE_ID = "local";

export const tenantsRoute = new Hono<SessionEnv>();

tenantsRoute.use("*", requireSession);

tenantsRoute.post("/", zValidator("json", createTenantSchema), async (c) => {
  const { slug, name } = c.req.valid("json");
  const env = c.env;
  const user = c.get("user");
  if (!user) {
    // requireSession を通過していれば通常到達しないが、型を絞り込むためのガード。
    return c.json({ error: "認証が必要です" }, 401);
  }

  const db = drizzle(env.DB_CONTROL);

  // 1. better-auth 側の organization を作成する。organization.id をテナント
  //    台帳の主キーとして再利用し、認証境界(organization)とテナント台帳を
  //    1:1で対応させる。
  const auth = createAuth(env, c.req.raw.cf);
  let organizationId: string;
  try {
    const org = await auth.api.createOrganization({
      headers: c.req.raw.headers,
      body: { name, slug, userId: user.id },
    });
    if (!org) {
      return c.json({ error: "組織の作成に失敗しました" }, 500);
    }
    organizationId = org.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    // better-auth 側もslugのユニーク制約を見ているため、重複時はここで409相当。
    return c.json({ error: `組織の作成に失敗しました: ${message}` }, 409);
  }

  const now = new Date();

  // 2. 台帳に登録。slug の UNIQUE 制約違反は 409 として返す。
  try {
    await db.insert(tenants).values({
      id: organizationId,
      slug,
      name,
      d1DatabaseId: null,
      status: "provisioning",
      createdAt: now,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("UNIQUE")) {
      return c.json({ error: "このサブドメインは既に使用されています" }, 409);
    }
    return c.json({ error: `台帳登録に失敗しました: ${message}` }, 500);
  }

  // 3-4. D1 用意 + 初期マイグレーション適用。失敗時は台帳・D1をロールバックし
  //      再試行可能な状態に戻す。
  const localMode = isLocalTenantDbMode(env);
  const cfConfig = {
    accountId: env.CLOUDFLARE_ACCOUNT_ID ?? "",
    apiToken: env.CLOUDFLARE_API_TOKEN ?? "",
  };
  let createdDatabaseId: string | null = null;

  try {
    const databaseId = localMode ? LOCAL_DATABASE_ID : (await createTenantDatabase(cfConfig, `tenant-${slug}`)).uuid;
    if (!localMode) {
      createdDatabaseId = databaseId;
    }

    const tenantDb = resolveTenantDb(env, databaseId);
    if (!tenantDb) {
      throw new Error("テナントDBの解決に失敗しました");
    }
    await tenantDb.exec(migrationSql);

    await db
      .update(tenants)
      .set({ d1DatabaseId: databaseId, status: "active" })
      .where(eq(tenants.id, organizationId));

    return c.json({
      id: organizationId,
      slug,
      name,
      d1DatabaseId: databaseId,
      status: "active",
    });
  } catch (err) {
    // ロールバック: 作成済みD1(本番のみ。ローカルは共有DBなので削除しない)・
    // 台帳行・better-authのorganizationを削除し、再試行可能な状態に戻す。
    // ロールバック自体が失敗しても握りつぶさず console.error でログに残す
    // (孤立リソースの調査に必要な情報のため)が、クライアントへは元の
    // プロビジョニング失敗エラーを返す(ロールバック失敗をユーザ向け
    // エラーにすり替えない)。
    if (createdDatabaseId) {
      try {
        await deleteTenantDatabase(cfConfig, createdDatabaseId);
      } catch (cleanupErr) {
        console.error(
          `[tenants] rollback failed: could not delete D1 database ${createdDatabaseId} for tenant ${organizationId} (slug=${slug}):`,
          cleanupErr
        );
      }
    }

    try {
      await db.delete(tenants).where(eq(tenants.id, organizationId));
    } catch (cleanupErr) {
      console.error(
        `[tenants] rollback failed: could not delete ledger row for tenant ${organizationId} (slug=${slug}):`,
        cleanupErr
      );
    }

    // better-auth の organization レコードを削除する。auth.api.deleteOrganization
    // は「セッションのアクティブ組織」や権限チェックに依存する箇所があるため、
    // API 経由での削除に失敗した場合は organization/member テーブルを直接
    // 削除するフォールバックを行う(理由: 作成直後のロールバックであり
    // 業務データが絡まないため、テーブル直接操作でも安全に整合を保てる)。
    try {
      await auth.api.deleteOrganization({
        headers: c.req.raw.headers,
        body: { organizationId },
      });
    } catch (cleanupErr) {
      console.error(
        `[tenants] rollback via auth.api.deleteOrganization failed for organization ${organizationId} (slug=${slug}), falling back to direct table delete:`,
        cleanupErr
      );
      try {
        await db.delete(member).where(eq(member.organizationId, organizationId));
        await db.delete(organization).where(eq(organization.id, organizationId));
      } catch (fallbackErr) {
        console.error(
          `[tenants] rollback fallback also failed: could not delete organization ${organizationId} (slug=${slug}) directly:`,
          fallbackErr
        );
      }
    }

    const message = err instanceof Error ? err.message : "unknown error";
    return c.json({ error: `テナントプロビジョニングに失敗しました: ${message}` }, 500);
  }
});
