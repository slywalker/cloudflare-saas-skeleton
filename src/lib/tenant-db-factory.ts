/**
 * TenantDb (本番: Cloudflare REST API) / LocalTenantDb (ローカル開発:
 * 共有D1バインディング) のどちらを使うかを1箇所で判定するファクトリ。
 * 呼び出し側 (middleware/tenant.ts, routes/tenants.ts) はここだけを見れば
 * よく、分岐ロジックが散らばらないようにする。
 */
import { TenantDb, LocalTenantDb, type TenantDbLike } from "./tenant-db";

/**
 * ローカル開発モードかどうかの判定。
 * - `TENANT_DB_MODE=local` を明示した場合は常にローカルモード
 * - それ以外は `CLOUDFLARE_API_TOKEN` が未設定であれば自動的にローカルモード
 *   とみなす (本番 secrets を設定していない = ローカル開発中、という前提)。
 */
export function isLocalTenantDbMode(env: CloudflareBindings): boolean {
  return env.TENANT_DB_MODE === "local" || !env.CLOUDFLARE_API_TOKEN;
}

/**
 * テナントDBへのアクセスオブジェクトを解決する。
 * ローカルモードでは `d1DatabaseId` の値に関わらず共有D1 (DB_TENANT_LOCAL) を返す。
 * 本番モードで `d1DatabaseId` が無ければ null (未プロビジョニングのテナント)。
 */
export function resolveTenantDb(env: CloudflareBindings, d1DatabaseId: string | null): TenantDbLike | null {
  if (isLocalTenantDbMode(env)) {
    return new LocalTenantDb(env.DB_TENANT_LOCAL);
  }
  if (!d1DatabaseId || !env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    return null;
  }
  return new TenantDb({ accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN }, d1DatabaseId);
}
