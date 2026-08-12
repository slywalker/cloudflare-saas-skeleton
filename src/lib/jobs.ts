/**
 * Cloudflare Queues (`QUEUE_JOBS`) へジョブを投入する唯一の入口。
 *
 * 【原則】Stripe / Resend 等の外部 API を API ハンドラから直接呼ばない
 * (CLAUDE.md「約束事」)。外部 API 呼び出しを伴う処理は、必ずこの
 * `enqueueJob` でメッセージをキューへ積み、実際の呼び出しは consumer
 * (`src/queues/consumer.ts`) 側で行うこと。
 *
 * 【エラー設計】このヘルパーは検証失敗・送信失敗のいずれも例外として
 * 呼び出し元へそのまま伝播させる (内部で握りつぶさない)。呼び出し側
 * (API ハンドラ等) が catch し、5xx を返す/リトライするといった判断を
 * 行う責務を負う。
 *   - `jobMessageSchema.parse` が投げる `ZodError`: job の形が不正な場合。
 *     zod のオブジェクトスキーマは既定で未知キーを黙って無視して剥がす
 *     (strict 化していない) ため、呼び出し側の型が緩んでいても余分な
 *     フィールドがあるだけでは失敗しない点に注意 (必須フィールド欠落や
 *     型不一致のみ検出できる)。
 *   - `env.QUEUE_JOBS.send` が投げる例外: キュー未作成・一時的な障害等。
 */
import { jobMessageSchema, type JobMessage } from "../shared/jobs";

export async function enqueueJob(env: CloudflareBindings, job: JobMessage): Promise<void> {
  // send() 時点でも型崩れ (呼び出し側の型エラー握りつぶし等) を検知できるよう、
  // 実行時にもスキーマ検証してから投入する。
  const parsed = jobMessageSchema.parse(job);
  await env.QUEUE_JOBS.send(parsed);
}
