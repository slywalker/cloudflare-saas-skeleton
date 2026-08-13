/**
 * `@cloudflare/vitest-pool-workers` の `cloudflare:test` から取得する `env` の型
 * (`ProvidedEnv`) を、実行時バインディング型 (`CloudflareBindings`,
 * worker-configuration.d.ts + src/types/env.d.ts) と一致させる。
 * これにより `import { env } from "cloudflare:test"` のテストコードで
 * 実際のバインディング名 (DB_TENANT_LOCAL 等) が補完・型チェックされる。
 */
declare module "cloudflare:test" {
  interface ProvidedEnv extends CloudflareBindings {}
}
