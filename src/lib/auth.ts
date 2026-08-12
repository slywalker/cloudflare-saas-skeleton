/**
 * better-auth インスタンス。better-auth-cloudflare で D1 + KV を接続し、
 * organization プラグインでマルチテナントの認証境界 (organization = テナント)
 * を表現する。
 */
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import { withCloudflare } from "better-auth-cloudflare";
import * as schema from "../db/schema";

/**
 * @param env - Workers bindings/vars/secrets
 * @param cf - リクエストの `cf` プロパティ (`c.req.raw.cf`)。Workers ランタイムの
 *   `fetch` イベントでのみ取得できるため、呼び出し側 (index.ts) から明示的に渡す。
 *   これを渡さない場合は geolocation トラッキングを無効化する
 *   (存在しないフィールドを "有効" と偽って扱わないため)。
 */
export function createAuth(env: CloudflareBindings, cf?: Request["cf"]) {
  const db = drizzle(env.DB_CONTROL, { schema });
  const rootDomain = env.APP_ROOT_DOMAIN;
  // Request["cf"] は送信側/受信側で型が異なる union (RequestInitCfProperties |
  // IncomingRequestCfProperties) になっているが、Workers ランタイムが実際に
  // fetch イベントへ渡すのは常に IncomingRequestCfProperties 側。
  const incomingCf = cf as IncomingRequestCfProperties | undefined;

  return betterAuth(
    withCloudflare(
      {
        autoDetectIpAddress: true,
        geolocationTracking: Boolean(incomingCf),
        cf: incomingCf,
        d1: { db, options: { schema } },
        kv: env.KV,
      },
      {
        baseURL: env.BETTER_AUTH_URL,
        secret: env.BETTER_AUTH_SECRET,
        emailAndPassword: {
          enabled: true,
        },
        advanced: {
          // acme.example.com / www.example.com / example.com 間でセッションCookieを
          // 共有するため、ルートドメインを起点に crossSubDomainCookies を有効化する。
          // rootDomain が "localhost" のローカル開発でも、`acme.localhost` の
          // ようなHostでテナント動作を確認できるよう同様に有効化する
          // (Chrome/curl 等の主要クライアントは ".localhost" ドメインの
          // Cookieを問題なく扱う)。rootDomain が空 (未設定) の場合のみ無効。
          crossSubDomainCookies: {
            enabled: Boolean(rootDomain),
            domain: rootDomain ? `.${rootDomain}` : undefined,
          },
        },
        plugins: [
          organization({
            // organization.id をそのままテナント台帳 (tenants.id) と紐付ける運用。
            // サインアップ後の POST /api/tenants で organization 作成とテナント
            // プロビジョニングを連動させる (src/routes/tenants.ts 参照)。
            allowUserToCreateOrganization: true,
          }),
        ],
      }
    )
  );
}

export type Auth = ReturnType<typeof createAuth>;
