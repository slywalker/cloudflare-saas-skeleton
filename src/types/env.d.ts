/**
 * `wrangler types` は wrangler.jsonc の vars/bindings のみを型生成する。
 * secrets (`wrangler secret put`) はここで手動追加する。
 *
 * 【既知の問題】ここでの手書き型 (例: `QUEUE_JOBS: Queue<JobMessage>`) と
 * `cf-typegen` (`wrangler types`) が生成する worker-configuration.d.ts の
 * 型は二重定義になっており、将来的な整理が必要 (今回は据え置き)。
 * `cf-typegen` を実行する際は `.dev.vars` を退避しておくこと
 * (実行時に読み込まれ、意図しない値が使われる可能性がある)。
 */
import type { JobMessage } from "../shared/jobs";

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
    /**
     * テナントDB群へのマイグレーション追随バッチ (src/workflows/tenant-migrations.ts)。
     * `wrangler types` は workflows[] からもバインディング型を生成できるが、
     * このプロジェクトは env.d.ts での手動管理に統一しているため、
     * wrangler.jsonc の `workflows` binding 名と合わせてここに追記する
     * (wrangler.jsonc 変更時は両方を更新すること)。
     */
    TENANT_MIGRATIONS: Workflow;
    /**
     * ジョブキュー (producer)。外部 API (Stripe/Resend 等) 呼び出しは API
     * ハンドラから直接行わず、必ず `src/lib/jobs.ts` の `enqueueJob` で
     * ここへ投入し、consumer (`src/queues/consumer.ts`) 側で処理する
     * (CLAUDE.md「約束事」参照)。`wrangler types` は queues[].producers から
     * バインディング型を生成できるが、このプロジェクトは env.d.ts での
     * 手動管理に統一しているため、wrangler.jsonc の binding 名と合わせて
     * ここに追記する (wrangler.jsonc 変更時は両方を更新すること)。
     */
    QUEUE_JOBS: Queue<JobMessage>;
  }
}
