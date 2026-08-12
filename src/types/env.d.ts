/**
 * `wrangler types` は wrangler.jsonc の vars/bindings のみを型生成する。
 * secrets (`wrangler secret put`) はここで手動追加する。
 */
export {};

declare global {
  interface CloudflareBindings {
    /**
     * `wrangler secret put CLOUDFLARE_ACCOUNT_ID`
     * ローカル開発では未設定でよい (isLocalTenantDbMode が CLOUDFLARE_API_TOKEN
     * 未設定を検知して自動的にローカルモードへフォールバックするため)。
     */
    CLOUDFLARE_ACCOUNT_ID?: string;
    /** `wrangler secret put CLOUDFLARE_API_TOKEN` (D1 Edit 権限が必要)。未設定時はローカルモード扱い。 */
    CLOUDFLARE_API_TOKEN?: string;
    /** `wrangler secret put BETTER_AUTH_SECRET` */
    BETTER_AUTH_SECRET: string;
    /**
     * "local" を指定すると CLOUDFLARE_API_TOKEN の有無に関わらず強制的に
     * ローカルテナントDBモード (DB_TENANT_LOCAL 共有) を使う。
     * 通常は未設定のままでよい (.dev.vars.example 参照)。
     */
    TENANT_DB_MODE?: "local";
  }
}
