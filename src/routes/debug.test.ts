/**
 * `/debug/*` の二重ガード (src/index.ts のミドルウェア + debugRoute 内部の
 * 保険) を、実際の Hono アプリ (src/index.ts の `app`) を通して検証する。
 *
 * 【検証方針】
 * - (a) `TENANT_DB_MODE` 未設定時: `/debug/tenants` のような既知パスへの
 *   リクエストと、全く無関係の未知パス (`/totally-unknown-path`) への
 *   リクエストが、SPA フォールバック (`env.ASSETS.fetch`) を経由して
 *   「見分けの付かない」応答になることを、実際に両方叩いて比較する形で
 *   確認する (テストダブルで済ませず、両方とも同じ `app` インスタンス /
 *   同じミドルウェアチェーンを通す)。
 * - (b) `TENANT_DB_MODE=local` 時: `/debug/tenant-migrations` が実際に
 *   応答し、ガードで弾かれないことを確認する (実データを
 *   `applyPendingMigrations` で投入した上で内容も検証する)。
 *
 * `DB_CONTROL`/`QUEUE_JOBS`/`TENANT_MIGRATIONS` は vitest.config.ts で
 * バインドしていないため、それらに依存するルート (`/debug/tenants`,
 * `/debug/enqueue`, `/debug/trigger-migrations`) は (a) のガード確認
 * (=ハンドラの中身に到達しないこと) にのみ使い、(b) の「応答すること」の
 * 確認は `DB_TENANT_LOCAL` のみに依存する `/debug/tenant-migrations` で行う。
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../index";
import { applyPendingMigrations } from "../lib/tenant-migrate";
import { LocalTenantDb } from "../lib/tenant-db";

const SPA_MARKER = "spa-fallback-marker";

/**
 * SPA フォールバックの代わりに固定レスポンスを返すダミー Fetcher。
 * 実際の静的アセットの中身は本テストの関心事ではなく、「ガード不成立時に
 * 未知パスと全く同じ経路 (env.ASSETS.fetch) を通っているか」だけを見たい
 * ため、既知パス/未知パスの両方から同一の呼び出しが行われれば十分に検証
 * できる。
 */
function makeAssetsStub(): Fetcher {
  return {
    fetch: async () => new Response(SPA_MARKER, { status: 200, headers: { "X-Test-Marker": "spa" } }),
  } as unknown as Fetcher;
}

/**
 * テストに必要な最小限の env を組み立てる。
 * - `DB_TENANT_LOCAL` は vitest.config.ts が用意する実バインディングをそのまま使う。
 * - `ASSETS` はダミー Fetcher に差し替える (本番の静的アセット配信はテスト対象外)。
 * - Host ヘッダを root domain 相当にしてテナント解決 (tenantMiddleware) を
 *   素通りさせる (KV/DB_CONTROL への依存を避けるため)。
 */
function makeEnv(overrides: Partial<CloudflareBindings> = {}): CloudflareBindings {
  return {
    ...(env as unknown as CloudflareBindings),
    ASSETS: makeAssetsStub(),
    APP_ROOT_DOMAIN: "localhost",
    ...overrides,
  } as CloudflareBindings;
}

describe("/debug ガード: TENANT_DB_MODE 未設定時 (本番相当)", () => {
  it("/debug/tenants は SPA フォールバックと同じ応答になる", async () => {
    const testEnv = makeEnv({ TENANT_DB_MODE: undefined });

    const debugRes = await app.request("http://localhost/debug/tenants", {}, testEnv);
    const unknownRes = await app.request("http://localhost/totally-unknown-path", {}, testEnv);

    const debugBody = await debugRes.text();
    const unknownBody = await unknownRes.text();
    expect(debugRes.status).toBe(unknownRes.status);
    expect(debugBody).toBe(unknownBody);
    expect(debugBody).toBe(SPA_MARKER);
  });

  it("/debug/tenant-migrations も同様に SPA フォールバックと同じ応答になる", async () => {
    const testEnv = makeEnv({ TENANT_DB_MODE: undefined });

    const debugRes = await app.request("http://localhost/debug/tenant-migrations", {}, testEnv);
    const unknownRes = await app.request("http://localhost/another-unknown-path", {}, testEnv);

    expect(debugRes.status).toBe(unknownRes.status);
    expect(await debugRes.text()).toBe(await unknownRes.text());
  });

  it("POST /debug/enqueue も同様に SPA フォールバックへ落ちる (ハンドラの中身 = QUEUE_JOBS 未設定 には到達しない)", async () => {
    const testEnv = makeEnv({ TENANT_DB_MODE: undefined });

    const res = await app.request(
      "http://localhost/debug/enqueue",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "email.send", to: "a@example.com", subject: "s", body: "b" }),
      },
      testEnv
    );

    // QUEUE_JOBS バインディングが無いため、もしガードを抜けてハンドラの
    // 中身まで実行されれば例外で 500 等になるはず。SPA フォールバックの
    // マーカーが返ってきていれば、ガードで止まっていることの証拠になる。
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SPA_MARKER);
  });
});

describe("/debug ガード: TENANT_DB_MODE=local 時 (ローカル開発相当)", () => {
  it("/debug/tenant-migrations はガードを通過して実データを返す", async () => {
    const testEnv = makeEnv({ TENANT_DB_MODE: "local" });

    // 実際にマイグレーションを1件適用し、管理表に行があることを保証してから
    // 読み出す (ガードを通過しているだけでなく、実処理が動くところまで確認する)。
    await applyPendingMigrations(new LocalTenantDb(testEnv.DB_TENANT_LOCAL));

    const res = await app.request("http://localhost/debug/tenant-migrations", {}, testEnv);
    expect(res.status).toBe(200);

    const body = await res.json<{ migrations: { name: string }[] }>();
    expect(Array.isArray(body.migrations)).toBe(true);
    expect(body.migrations.length).toBeGreaterThan(0);
    expect(body.migrations.some((m) => m.name === "0001_init.sql")).toBe(true);
  });

  it("未知パスは相変わらず SPA フォールバックのまま (ガード自体は /debug/* のみに限定される)", async () => {
    const testEnv = makeEnv({ TENANT_DB_MODE: "local" });

    const res = await app.request("http://localhost/still-unknown-path", {}, testEnv);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SPA_MARKER);
  });
});
