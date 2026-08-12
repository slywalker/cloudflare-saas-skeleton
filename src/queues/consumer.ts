/**
 * Cloudflare Queues (`QUEUE_JOBS`) のコンシューマ。wrangler.jsonc の
 * queues.consumers[].queue = "jobs" に対応する。src/index.ts の default export
 * の `queue` ハンドラから呼び出される。
 *
 * 【型について】引数は producer 側 (`Queue<JobMessage>`) と型で繋げるため
 * `MessageBatch<JobMessage>` を受け取るが、これはあくまで「自分の
 * enqueueJob 経由で入った分は JobMessage のはず」という *宣言的* な型で
 * あり、ランタイムでの保証ではない (旧デプロイの producer が異なる形の
 * メッセージを送った、キュー内に前バージョンのメッセージが残っている等の
 * ケースがあり得る)。そのため内部では message.body を信頼せず改めて
 * `unknown` として扱い、`jobMessageSchema.safeParse` で検証してから使う。
 *
 * 【メッセージ不正時の扱い】
 * jobMessageSchema でパースできないメッセージは、リトライしても内容が変わる
 * わけではなく直る見込みがないため message.retry() はせず、console.error で
 * 記録した上で message.ack() する (毒メッセージでリトライ回数を空費しない)。
 * 本当に DLQ 側で調査したい場合は ack() の代わりに retry() して
 * max_retries 枯渇による自然な DLQ 送りに委ねる設計も取り得るが、
 * 「パース不能 = そもそも仕様外のメッセージ」であり再送でも解決しないため、
 * ここでは ack() を採用する。
 * 【重要】ack() は「復元不能」を意味する: このキューには DLQ 以外の永続化先が
 * 無く、ack 済みメッセージはどこにも残らない。そのため ack する前に必ず
 * `message.id` と message.body (先頭数KBに切り詰め) を console.error に
 * 残し、後から Cloudflare の観測性ログ (Logpush 等) で追跡できるようにする。
 *
 * 【処理中の例外】
 * ハンドラ内 (Resend/Stripe 呼び出し等、将来実装分) で例外が発生した場合は
 * 一時的な障害の可能性があるため message.retry() する。max_retries (3) を
 * 使い切ると wrangler.jsonc の dead_letter_queue ("jobs-dlq") へ自動的に
 * 送られる。
 *
 * 【網羅性チェック】switch の default 節で `const _exhaustive: never = job`
 * を行い、JobMessage に新しい type を追加したのに case を足し忘れた場合に
 * ビルド時 (tsc) で検知できるようにしている。万一 (旧デプロイの consumer が
 * 新種別のメッセージを受け取った等で) 実行時にここへ到達した場合は、
 * 「知らない種別だから黙って捨てる」のではなく retry() する。新しい種別を
 * デプロイした producer と、それをまだ理解できない古い consumer が同時に
 * 動いている過渡期を想定しており、リトライを重ねる間に consumer 側の
 * デプロイが追いつけば処理できる可能性があるため。それでも解決しなければ
 * 最終的に DLQ へ退避される。
 */
import { jobMessageSchema, type JobMessage } from "../shared/jobs";

/** ログに残す message.body の切り詰め上限 (文字数)。 */
const BODY_LOG_TRUNCATE_LENGTH = 2000;

export async function handleJobsBatch(batch: MessageBatch<JobMessage>, _env: CloudflareBindings): Promise<void> {
  for (const message of batch.messages) {
    // producer 側の型宣言 (Queue<JobMessage>) は信用せず、実行時に unknown として
    // 改めて検証する (コメント参照)。
    const parsed = jobMessageSchema.safeParse(message.body as unknown);
    if (!parsed.success) {
      const rawBody = JSON.stringify(message.body);
      const truncatedBody =
        rawBody.length > BODY_LOG_TRUNCATE_LENGTH
          ? `${rawBody.slice(0, BODY_LOG_TRUNCATE_LENGTH)}...(truncated)`
          : rawBody;
      console.error(
        "[queues/consumer] 不正なメッセージ形式のため ack して破棄します (復元不能。要調査ならこのログを確認):",
        { messageId: message.id, body: truncatedBody, error: parsed.error.message }
      );
      message.ack();
      continue;
    }

    const job = parsed.data;
    try {
      switch (job.type) {
        case "email.send":
          // TODO: Resend 連携は未実装。実装時は src/lib 配下に Resend クライアント
          // を追加し、ここから呼び出すこと (API ハンドラから直接呼ばない)。
          console.log("[queues/consumer] email.send (プレースホルダ、Resend 連携は未実装):", {
            to: job.to,
            subject: job.subject,
          });
          break;
        case "stripe.webhook.process":
          // TODO: Stripe webhook 処理は未実装。実装時は src/lib 配下に Stripe
          // クライアントを追加し、event.eventId を使って `events.retrieve()` で
          // Stripe から正規のイベント内容を取得してから処理すること
          // (payload をキューに載せない設計。src/shared/jobs.ts のコメント参照)。
          console.log("[queues/consumer] stripe.webhook.process (プレースホルダ、Stripe 連携は未実装):", {
            eventId: job.eventId,
            eventType: job.eventType,
          });
          break;
        default: {
          // JobMessage に新しい type を追加した際、ここの case 追加を忘れると
          // tsc がこの代入をコンパイルエラーにする (網羅性チェック)。
          const _exhaustive: never = job;
          console.error(
            "[queues/consumer] 未知のジョブ種別のため retry します (新種別デプロイ中の過渡期を想定。解決しなければ最終的に DLQ へ):",
            { messageId: message.id, job: _exhaustive }
          );
          message.retry();
          continue;
        }
      }
      message.ack();
    } catch (err) {
      console.error("[queues/consumer] ジョブ処理中に例外が発生したため retry します:", err);
      message.retry();
    }
  }
}
