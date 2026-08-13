/**
 * ローカル開発専用のデバッグルート群。
 *
 * 【セキュリティ上の意図】自動セキュリティレビューで、この種のルート
 * (キュー直接投入・Workflow起動・内部管理表の閲覧) が本番に混入すると
 * 深刻な脆弱性 (認証を経由しないキュー汚染・DB内容の漏洩等) になりうる
 * と指摘された。そのため、下記の二重ガードを必ず維持すること:
 *
 *   (a) `src/index.ts` 側で `/debug/*` にマウントしたミドルウェアが、
 *       毎リクエスト `env.TENANT_DB_MODE !== "local"` を見て、条件を
 *       満たさなければ `env.ASSETS.fetch(c.req.raw)` で SPA フォールバック
 *       と全く同じ応答を返す (このファイルの `debugRoute` 自体には
 *       到達させない)。
 *   (b) このファイル内のミドルウェア・各ハンドラでも同条件を再チェックし、
 *       同じく `env.ASSETS.fetch(c.req.raw)` を返す (index.ts 側のガードが
 *       将来の変更で抜けた場合の保険。直接 `debugRoute` を import して別の
 *       場所にマウントされるケースへの防御でもある)。
 *
 *   【`c.notFound()` を使わない理由】ガード不成立時に Hono の既定 404
 *   (`c.notFound()`) を返すと、"/debug/tenants" のような既知パスだけ他の
 *   未知パス (SPA フォールバックで 200 になる) と応答が異なってしまい、
 *   1リクエストで `/debug` という名前空間の存在自体が露見する
 *   (実測で確認済み)。そのため、ガード不成立時は SPA フォールバックと
 *   完全に同じ経路 (`env.ASSETS.fetch`) を通し、未知パスと不可分の応答に
 *   する。
 *
 *   【ビルド時除外について】Vite のビルドであるため、`import.meta.env.DEV`
 *   や `define` を使ってこのルート自体を本番バンドルから tree-shake する
 *   ことも技術的には可能。あえて採用しなかったのは、ローカル用と本番用で
 *   バンドルの中身 (含まれるルートの集合) 自体が分岐すると、「ローカルの
 *   `pnpm run build`/テストでは常に debug ルートが同梱された状態でしか検証
 *   されず、本番ビルドだけがビルド時除外の欠陥 (除外し忘れ・条件式の誤り)
 *   で壊れる/または露出する」というカテゴリの不具合を作り込みうるため。
 *   単一バンドル + 実行時ガード (上記 (a)(b)) であれば、ローカルで通した
 *   検証がそのまま本番の挙動 (`TENANT_DB_MODE` 未設定 = 常に閉じる) の
 *   検証にもなる。
 *
 * 本番では `TENANT_DB_MODE` を設定しないこと。設定するとこのルートが
 * 開いてしまう (README「ローカル開発」節参照)。
 */
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { jobMessageSchema } from "../shared/jobs";
import { enqueueJob } from "../lib/jobs";
import { tenantMigrationsParamsSchema } from "../shared/tenant-migrations";
import { tenants } from "../db/schema";

export type DebugEnv = {
  Bindings: CloudflareBindings;
};

export function isLocalDebugMode(env: CloudflareBindings): boolean {
  return env.TENANT_DB_MODE === "local";
}

export const debugRoute = new Hono<DebugEnv>();

// ガード (b): ローカルモード以外は SPA フォールバックと同じ応答を返す
// (詳細はファイル冒頭コメント参照)。
debugRoute.use("*", async (c, next) => {
  if (!isLocalDebugMode(c.env)) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  await next();
});

/**
 * POST /debug/enqueue
 * body を `jobMessageSchema` で検証してから `enqueueJob` で正常投入する。
 * `?raw=1` のときのみ検証を迂回し、`QUEUE_JOBS.send` へ body をそのまま
 * 投入する (consumer の不正メッセージ処理 (ack/破棄) を確認するための
 * 経路。意図的に壊れたメッセージを送れるようにしている)。
 */
debugRoute.post("/enqueue", async (c) => {
  // ガード (b): 保険としての再チェック。
  if (!isLocalDebugMode(c.env)) {
    return c.env.ASSETS.fetch(c.req.raw);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "リクエストボディが不正なJSONです" }, 400);
  }

  const raw = c.req.query("raw") === "1";
  if (raw) {
    // 意図的に型検証を迂回する経路 (不正メッセージの consumer 挙動確認用)。
    // QUEUE_JOBS は `Queue<JobMessage>` 型のため、検証前の unknown な body を
    // そのまま渡すにはここでキャストが必要になる (呼び出し元の型崩れを
    // 検知する仕組みではなく、意図的な迂回であることの表明でもある)。
    await c.env.QUEUE_JOBS.send(body as Parameters<typeof c.env.QUEUE_JOBS.send>[0]);
    return c.json({ ok: true, mode: "raw" });
  }

  const parsed = jobMessageSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  await enqueueJob(c.env, parsed.data);
  return c.json({ ok: true, mode: "validated" });
});

/**
 * POST /debug/trigger-migrations
 * body (任意で `{ tenantIds: string[] }`) を検証し、
 * `TENANT_MIGRATIONS.create()` で Workflow インスタンスを起動する。
 * インスタンス id と (取得できれば) 現在の status を返す。
 */
debugRoute.post("/trigger-migrations", async (c) => {
  if (!isLocalDebugMode(c.env)) {
    return c.env.ASSETS.fetch(c.req.raw);
  }

  let body: unknown = {};
  const rawText = await c.req.text();
  if (rawText.length > 0) {
    try {
      body = JSON.parse(rawText);
    } catch {
      return c.json({ error: "リクエストボディが不正なJSONです" }, 400);
    }
  }

  const parsed = tenantMigrationsParamsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const instance = await c.env.TENANT_MIGRATIONS.create({ params: parsed.data });

  let status: unknown = null;
  try {
    status = await instance.status();
  } catch (err) {
    // status 取得は失敗しても致命的ではない (id さえ分かればCLIから追える)。
    console.error("[debug] Workflow status の取得に失敗しました:", err);
  }

  return c.json({ id: instance.id, status });
});

/**
 * GET /debug/tenant-migrations
 * ローカル共有D1 (DB_TENANT_LOCAL) の `d1_tenant_migrations` 管理表を
 * 全件返す (`TENANT_DB_MODE=local` では全テナントがこのDBを共有するため、
 * テナント毎の内訳ではなく DB 全体の適用状況になる点に注意。
 * README「テナントDBのローカル対応」節参照)。
 */
debugRoute.get("/tenant-migrations", async (c) => {
  if (!isLocalDebugMode(c.env)) {
    return c.env.ASSETS.fetch(c.req.raw);
  }

  const { results } = await c.env.DB_TENANT_LOCAL.prepare(
    "SELECT name, statements_total, statements_applied, applied_at FROM d1_tenant_migrations ORDER BY name"
  ).all();

  return c.json({ migrations: results });
});

/**
 * GET /debug/tenants
 * 中央D1 (DB_CONTROL) の台帳 (`tenants` テーブル) を全件返す。
 */
debugRoute.get("/tenants", async (c) => {
  if (!isLocalDebugMode(c.env)) {
    return c.env.ASSETS.fetch(c.req.raw);
  }

  const db = drizzle(c.env.DB_CONTROL);
  const rows = await db.select().from(tenants).all();
  return c.json({ tenants: rows });
});
