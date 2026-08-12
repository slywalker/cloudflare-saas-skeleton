/**
 * Cloudflare Queues (`QUEUE_JOBS`) に投入するジョブメッセージのスキーマ。
 * API ハンドラは Stripe / Resend 等の外部 API を直接呼ばず、必ずここで定義した
 * メッセージを `src/lib/jobs.ts` の `enqueueJob` 経由でキューへ投入し、実際の
 * 外部呼び出しは consumer (`src/queues/consumer.ts`) 側に閉じ込める
 * (CLAUDE.md「約束事」参照)。
 *
 * 現時点ではジョブ種別のプレースホルダのみで、consumer 側の実処理
 * (Resend送信・Stripe webhook処理本体) は未実装。
 *
 * 新しいジョブ種別を追加する手順:
 *   1. 下記 discriminatedUnion に新しい z.object({ type: z.literal("xxx.yyy"), ... }) を追加する
 *   2. src/queues/consumer.ts の switch 文に対応する case を追加する
 *   3. 呼び出し側 (API ハンドラ等) から enqueueJob({ type: "xxx.yyy", ... }) を呼ぶ
 */
import { z } from "zod";

export const jobMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("email.send"),
    to: z.string().email(),
    subject: z.string().min(1),
    body: z.string(),
  }),
  z.object({
    type: z.literal("stripe.webhook.process"),
    eventId: z.string().min(1),
    eventType: z.string().min(1),
    // payload は意図的に持たせない (Stripe 推奨パターン)。理由:
    //   1) Queues の1メッセージサイズ上限 (128KB) を、大きい Stripe イベントの
    //      payload がそのまま乗ると超過しうる。
    //   2) z.unknown() は「フィールドが存在してもしなくても検証を通す」ため、
    //      実質 optional 扱いになり、payload 欠落や型崩れを検知できない。
    //   3) キュー上の payload はメッセージ改竄・なりすましイベント注入のリスクを
    //      増やす (webhook 署名検証を経ていない値がそのまま consumer に渡る)。
    // 代わりに consumer 側で Stripe API (`events.retrieve(eventId)`) を呼び、
    // Stripe 自身から正規のイベント内容を再取得してから処理する。
  }),
]);

export type JobMessage = z.infer<typeof jobMessageSchema>;
