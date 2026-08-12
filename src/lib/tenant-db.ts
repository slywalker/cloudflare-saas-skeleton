/**
 * テナント毎 D1 データベースへの薄いアクセス層。
 *
 * テナント DB は静的な wrangler バインディングを持てない(テナント数だけ
 * 動的に増える)ため、Cloudflare REST API (`/accounts/{account_id}/d1/database*`)
 * を fetch で直接叩く。prepare/bind/all 風の最小インターフェースを提供し、
 * 呼び出し側が D1Database バインディングと似た感覚で使えるようにする。
 */

export interface CloudflareD1RestConfig {
  accountId: string;
  apiToken: string;
}

interface CfApiResponse<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  messages: unknown[];
  result: T;
}

interface D1CreateResult {
  uuid: string;
  name: string;
}

interface D1QueryResult {
  results: Record<string, unknown>[];
  success: boolean;
  meta: {
    duration: number;
    rows_read?: number;
    rows_written?: number;
    last_row_id?: number;
    changes?: number;
  };
}

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

async function cfFetch<T>(
  config: CloudflareD1RestConfig,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${CF_API_BASE}/accounts/${config.accountId}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  // 5xx 等でボディが JSON でない場合(HTML エラーページ等)に body.json() が
  // 例外を投げて元のステータス/本文が失われないよう、まず text で受けてから
  // JSON パースを試みる。
  const rawText = await res.text();
  let body: CfApiResponse<T> | undefined;
  try {
    body = rawText ? (JSON.parse(rawText) as CfApiResponse<T>) : undefined;
  } catch {
    body = undefined;
  }

  if (!res.ok || !body || !body.success) {
    const message =
      body?.errors?.map((e) => `[${e.code}] ${e.message}`).join(", ") ||
      `HTTP ${res.status} ${res.statusText}: ${rawText.slice(0, 500)}`;
    throw new Error(`Cloudflare API error: ${message}`);
  }
  return body.result;
}

/**
 * 新しいテナント用 D1 データベースを作成する。
 * 戻り値の uuid を台帳 (tenants.d1DatabaseId) に保存すること。
 */
export async function createTenantDatabase(
  config: CloudflareD1RestConfig,
  databaseName: string
): Promise<D1CreateResult> {
  return cfFetch<D1CreateResult>(config, "/d1/database", {
    method: "POST",
    body: JSON.stringify({ name: databaseName }),
  });
}

export async function deleteTenantDatabase(
  config: CloudflareD1RestConfig,
  databaseId: string
): Promise<void> {
  await cfFetch<null>(config, `/d1/database/${databaseId}`, { method: "DELETE" });
}

/**
 * REST API の /query エンドポイント経由でテナント D1 に任意 SQL を発行する
 * 最小クライアント。D1Database の prepare().bind().all() に近い形にして
 * ワーカーのネイティブバインディングと呼び出し感を揃えている。
 */
export class TenantDb {
  constructor(
    private readonly config: CloudflareD1RestConfig,
    private readonly databaseId: string
  ) {}

  prepare(sql: string): TenantStatement {
    return new TenantStatement(this.config, this.databaseId, sql, []);
  }

  /** マイグレーション適用など、複数SQL文をまとめて流すためのヘルパー。 */
  async exec(sql: string): Promise<D1QueryResult[]> {
    // Cloudflare の /query は1リクエストにつき複数ステートメントを
    // `;` 区切りで送ると分割して実行してくれるが、確実性のため
    // 空文でないステートメント毎に分けて逐次実行する。
    const statements = splitSqlStatements(sql);
    const results: D1QueryResult[] = [];
    for (const statement of statements) {
      results.push(await this.rawQuery(statement, []));
    }
    return results;
  }

  async rawQuery(sql: string, params: unknown[]): Promise<D1QueryResult> {
    const results = await cfFetch<D1QueryResult[]>(
      this.config,
      `/d1/database/${this.databaseId}/query`,
      {
        method: "POST",
        body: JSON.stringify({ sql, params }),
      }
    );
    // REST API はバッチ実行時に配列を返すが、単一ステートメントでも配列で返る。
    // 空配列が返るケース(APIの想定外挙動)に備えてガードする。
    const first = results[0];
    if (!first) {
      throw new Error(`Cloudflare D1 query returned no result for: ${sql.slice(0, 200)}`);
    }
    return first;
  }
}

class TenantStatement {
  constructor(
    private readonly config: CloudflareD1RestConfig,
    private readonly databaseId: string,
    private readonly sql: string,
    private readonly params: unknown[]
  ) {}

  bind(...params: unknown[]): TenantStatement {
    return new TenantStatement(this.config, this.databaseId, this.sql, params);
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; meta: D1QueryResult["meta"] }> {
    const db = new TenantDb(this.config, this.databaseId);
    const result = await db.rawQuery(this.sql, this.params);
    return { results: result.results as T[], meta: result.meta };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const { results } = await this.all<T>();
    return results[0] ?? null;
  }

  async run(): Promise<D1QueryResult["meta"]> {
    const db = new TenantDb(this.config, this.databaseId);
    const result = await db.rawQuery(this.sql, this.params);
    return result.meta;
  }
}

/**
 * マイグレーション用 SQL ファイルを、REST API の /query に1文ずつ投げられる
 * ステートメントの配列に分解する。
 *
 * 行単位で `--` 行コメントを除去してから `;` で分割することで、
 * 「ファイル冒頭のコメント + 最初の CREATE TABLE」がまるごとコメント扱いされ
 * 消える不具合 (単純に `s.startsWith("--")` で文全体を除外していたための事故)
 * を防ぐ。ブロックコメント (/* *\/) や文字列リテラル内の `;` `--` までは
 * 対応しない (このプロジェクトのマイグレーションSQLでは使用しない前提)。
 */
export function splitSqlStatements(sql: string): string[] {
  const withoutLineComments = sql
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("--")) return "";
      return line;
    })
    .join("\n");

  return withoutLineComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
