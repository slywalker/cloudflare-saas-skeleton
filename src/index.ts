import { Hono } from "hono";
import { createAuth } from "./lib/auth";
import { tenantMiddleware, type TenantEnv } from "./middleware/tenant";
import { requireTenantMember, type TenantAuthzEnv } from "./middleware/authz";
import { tenantsRoute } from "./routes/tenants";

// テナントDB群へのマイグレーション追随バッチ (手動起動: `wrangler workflows
// trigger tenant-migrations`)。wrangler.jsonc の workflows[].class_name から
// 参照されるため、Worker のエントリポイントから re-export しておく必要がある。
export { TenantMigrationsWorkflow } from "./workflows/tenant-migrations";

const app = new Hono<TenantEnv>();

// Host ヘッダのサブドメインからテナントを解決し、c.set("tenant"/"tenantDb") する。
// ルートドメイン (apex/www) は素通しし、SPA・認証ルートに委ねる。
app.use("*", tenantMiddleware);

// better-auth のルート一式 (/api/auth/**)。organization プラグインにより
// マルチテナントの認証境界 (サインアップ/サインイン/組織作成/招待) を提供する。
app.on(["POST", "GET"], "/api/auth/**", (c) => {
  const auth = createAuth(c.env, c.req.raw.cf);
  return auth.handler(c.req.raw);
});

// サインアップ後にフロントから叩く、テナント (D1) プロビジョニング API。
// ルート内部で requireSession により認証必須にしている。
app.route("/api/tenants", tenantsRoute);

app.get("/api/health", (c) => c.json({ ok: true }));

// テナントスコープの最小サンプル API (items テーブル)。
// requireTenantMember: セッション必須 + 当該テナント(organization)のmemberであること。
// テナントDBはリクエスト毎に REST 経由で解決される (静的バインディング不可のため)。
const itemsApp = new Hono<TenantAuthzEnv>();
itemsApp.use("*", requireTenantMember);
itemsApp.get("/", async (c) => {
  const tenantDb = c.get("tenantDb");
  if (!tenantDb) {
    return c.json({ error: "テナントコンテキストがありません" }, 400);
  }
  const { results } = await tenantDb.prepare("SELECT * FROM items ORDER BY created_at DESC LIMIT 50").all();
  return c.json({ items: results });
});
app.route("/api/items", itemsApp);

// 上記以外は SPA (Workers Static Assets) に委ねる。
// wrangler.jsonc の assets.not_found_handling: "single-page-application" により
// 未知のパスは index.html にフォールバックする。
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
