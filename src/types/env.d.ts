/**
 * `wrangler types` は wrangler.jsonc の vars/bindings のみを型生成する。
 * secrets (`wrangler secret put`) はここで手動追加する。
 */
export {};

declare global {
  interface CloudflareBindings {
    /** `wrangler secret put CLOUDFLARE_ACCOUNT_ID` */
    CLOUDFLARE_ACCOUNT_ID: string;
    /** `wrangler secret put CLOUDFLARE_API_TOKEN` (D1 Edit 権限が必要) */
    CLOUDFLARE_API_TOKEN: string;
    /** `wrangler secret put BETTER_AUTH_SECRET` */
    BETTER_AUTH_SECRET: string;
  }
}
