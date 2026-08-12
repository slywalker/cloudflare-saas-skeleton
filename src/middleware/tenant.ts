/**
 * Host ヘッダのサブドメインからテナントを解決する Hono ミドルウェア。
 *
 * - apex / www / 未設定サブドメインは "ルートドメイン" とみなしテナント解決を
 *   スキップして素通しする (SPA配信・認証ルートはここで処理される)。
 * - サブドメインがある場合、台帳 (中央 D1 の tenants テーブル) を引く。
 *   結果は KV にキャッシュし、リクエスト毎の D1 参照を避ける。
 * - 解決できたテナントは c.set("tenant", ...) で下流に渡し、
 *   テナントDBアクセスオブジェクト (本番: REST経由のTenantDb, ローカル開発:
 *   共有D1のLocalTenantDb) も c.set("tenantDb", ...) で注入する
 *   (どちらを使うかは lib/tenant-db-factory.ts が判定する)。
 *
 * Host ヘッダはクライアントが自由に偽装できるため、本番では
 * wrangler.jsonc の `routes` でこの Worker が応答するホスト名パターンを
 * 制限し、DNS に存在しないサブドメインへのなりすましを genとして防ぐ
 * (台帳に存在しないslugはいずれにせよ404になるが、DNSレベルの制限を
 * 二重の防御として推奨する)。
 */
import { createMiddleware } from "hono/factory";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { tenants } from "../db/schema";
import type { TenantDbLike } from "../lib/tenant-db";
import { resolveTenantDb } from "../lib/tenant-db-factory";

export interface TenantRecord {
  id: string;
  slug: string;
  name: string;
  d1DatabaseId: string | null;
  status: string;
}

export type TenantEnv = {
  Bindings: CloudflareBindings;
  Variables: {
    tenant: TenantRecord | null;
    tenantDb: TenantDbLike | null;
  };
};

const TENANT_CACHE_TTL_SECONDS = 60;
/**
 * 存在しないテナントへの探索を都度 D1 に流さないための短命ネガティブキャッシュ。
 * Cloudflare KV の expirationTtl は最小60秒という制約があるため、
 * 実運用上の最短値である60を採用する (10等のより短いTTLは
 * `KV PUT failed: 400 Invalid expiration_ttl` で例外になる)。
 */
const NOT_FOUND_CACHE_TTL_SECONDS = 60;
const NOT_FOUND_SENTINEL = "__NOT_FOUND__";

/**
 * ルートドメイン (アプリのベースドメイン。例: example.com) をあらかじめ
 * 知っている必要がある。wrangler の vars で APP_ROOT_DOMAIN として渡す想定。
 * ローカル開発では `acme.localhost` のような形でも動作するよう、
 * APP_ROOT_DOMAIN の設定値に関わらず "localhost" も常にルート候補として扱う。
 */
export function extractSubdomain(host: string, rootDomain: string): string | null {
  const hostname = host.split(":")[0]?.toLowerCase() ?? ""; // ポート番号を除去 + 小文字正規化
  const roots = [rootDomain.toLowerCase(), "localhost"].filter((r, i, arr) => r && arr.indexOf(r) === i);

  for (const root of roots) {
    if (hostname === root || hostname === `www.${root}`) {
      return null;
    }
    if (hostname.endsWith(`.${root}`)) {
      return hostname.slice(0, -(`.${root}`.length));
    }
  }
  // ローカル開発 (127.0.0.1 等) やドメイン不一致は素通し扱い
  return null;
}

export const tenantMiddleware = createMiddleware<TenantEnv>(async (c, next) => {
  const host = c.req.header("host") ?? "";
  const rootDomain = c.env.APP_ROOT_DOMAIN ?? "";
  const subdomain = extractSubdomain(host, rootDomain);

  if (!subdomain) {
    c.set("tenant", null);
    c.set("tenantDb", null);
    await next();
    return;
  }

  const cacheKey = `tenant:${subdomain}`;
  let tenant: TenantRecord | null = null;

  const cached = await c.env.KV.get(cacheKey, "text");
  if (cached === NOT_FOUND_SENTINEL) {
    return c.json({ error: "テナントが見つかりません" }, 404);
  }
  if (cached) {
    tenant = JSON.parse(cached) as TenantRecord;
  } else {
    const db = drizzle(c.env.DB_CONTROL);
    const row = await db.select().from(tenants).where(eq(tenants.slug, subdomain)).get();
    if (row) {
      tenant = {
        id: row.id,
        slug: row.slug,
        name: row.name,
        d1DatabaseId: row.d1DatabaseId,
        status: row.status,
      };
      await c.env.KV.put(cacheKey, JSON.stringify(tenant), {
        expirationTtl: TENANT_CACHE_TTL_SECONDS,
      });
    } else {
      await c.env.KV.put(cacheKey, NOT_FOUND_SENTINEL, {
        expirationTtl: NOT_FOUND_CACHE_TTL_SECONDS,
      });
    }
  }

  if (!tenant) {
    return c.json({ error: "テナントが見つかりません" }, 404);
  }
  if (tenant.status !== "active") {
    return c.json({ error: `テナントは現在利用できません (status: ${tenant.status})` }, 503);
  }

  c.set("tenant", tenant);
  // 本番/ローカルの分岐は resolveTenantDb に集約している (ローカルでは
  // d1DatabaseId の値に関わらず共有D1にフォールバックする)。
  c.set("tenantDb", resolveTenantDb(c.env, tenant.d1DatabaseId));

  await next();
});
