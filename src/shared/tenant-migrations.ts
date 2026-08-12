/**
 * `TenantMigrationsWorkflow` (src/workflows/tenant-migrations.ts) の起動
 * パラメータ用スキーマ。`wrangler workflows trigger tenant-migrations
 * '{"tenantIds": [...]}'` のように任意JSONが渡されるため、Workflow の
 * run() 冒頭で必ず safeParse すること。
 *
 * tenantIds を渡す場合は 1件以上必須とする (空配列は「全件対象」の意味に
 * 解釈せず、検証エラーとして弾く。「全件」を意図するなら tenantIds 自体を
 * 省略する)。
 */
import { z } from "zod";

export const tenantMigrationsParamsSchema = z.object({
  tenantIds: z.array(z.string().min(1)).min(1).optional(),
});
export type TenantMigrationsParams = z.infer<typeof tenantMigrationsParamsSchema>;
