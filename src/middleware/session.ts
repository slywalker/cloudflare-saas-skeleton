/**
 * better-auth のセッション検証ミドルウェア。
 * 認証必須のルートに適用し、`c.set("user"/"session")` する。
 * 未認証は 401 を返してチェーンを打ち切る。
 */
import { createMiddleware } from "hono/factory";
import { createAuth } from "../lib/auth";

export type SessionEnv = {
  Bindings: CloudflareBindings;
  Variables: {
    user: { id: string; email: string; name: string } | null;
    session: { id: string; userId: string; activeOrganizationId?: string | null } | null;
  };
};

export const requireSession = createMiddleware<SessionEnv>(async (c, next) => {
  const auth = createAuth(c.env, c.req.raw.cf);
  const result = await auth.api.getSession({ headers: c.req.raw.headers });

  if (!result) {
    return c.json({ error: "認証が必要です" }, 401);
  }

  c.set("user", result.user);
  c.set("session", result.session);
  await next();
});
