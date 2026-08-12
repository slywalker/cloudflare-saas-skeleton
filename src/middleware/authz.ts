/**
 * テナントスコープAPI向けの認可ミドルウェア。
 * tenantMiddleware の後段で使う前提: 「セッション必須 + 当該テナント
 * (organization) の member であること」を検証する。
 */
import { createMiddleware } from "hono/factory";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { createAuth } from "../lib/auth";
import { member } from "../db/schema";
import type { TenantEnv } from "./tenant";

export type TenantAuthzEnv = TenantEnv & {
  Variables: TenantEnv["Variables"] & {
    user: { id: string; email: string; name: string };
  };
};

export const requireTenantMember = createMiddleware<TenantAuthzEnv>(async (c, next) => {
  const tenant = c.get("tenant");
  if (!tenant) {
    return c.json({ error: "テナントコンテキストがありません" }, 400);
  }

  const auth = createAuth(c.env, c.req.raw.cf);
  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!result) {
    return c.json({ error: "認証が必要です" }, 401);
  }

  const db = drizzle(c.env.DB_CONTROL);
  const membership = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, tenant.id), eq(member.userId, result.user.id)))
    .get();

  if (!membership) {
    return c.json({ error: "このテナントへのアクセス権限がありません" }, 403);
  }

  c.set("user", result.user);
  await next();
});
