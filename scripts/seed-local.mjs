#!/usr/bin/env node
/**
 * `pnpm run seed:local` — ローカル開発サーバ (http://localhost:5173) に対して、
 * better-auth の HTTP API とテナントプロビジョニング API (`POST /api/tenants`)
 * を fetch で叩き、開発用アカウント/テナントを冪等に作成する。
 *
 * 前提: `pnpm run dev` が起動していること (このスクリプト自身は dev サーバを
 * 起動しない)。
 *
 * 【冪等性】
 * - サインアップ (`POST /api/auth/sign-up/email`) が「既に存在する」エラーを
 *   返した場合は、サインイン (`POST /api/auth/sign-in/email`) に切り替えて
 *   セッションを取得する。
 * - テナント作成 (`POST /api/tenants`) が 409 (slug 重複) を返した場合は
 *   「既存テナントとみなしてスキップ」する (エラーにしない)。
 *
 * 作成するアカウント:
 *   - alice@example.com (Acme Inc, slug: acme, owner)
 *   - bob@example.com   (Widget Co, slug: widgetco, owner)
 *   - eve@example.com   (テナント所属なし)
 *
 * 【本番誤爆防止】このスクリプトはパスワードを平文でハードコードしており、
 * 世界中に公開されているコード (本リポジトリ) にそのまま載っている。
 * `SEED_BASE_URL` を本番相当のURLに向けて実行すると、公開済みパスワードの
 * owner アカウントを本番に作ってしまう事故になるため、`BASE_URL` の
 * hostname がローカルホスト相当 (localhost / 127.0.0.1 / ::1 / *.localhost)
 * でない場合は即座にエラーで中断する (下記 `assertLocalBaseUrl` 参照)。
 */

const BASE_URL = process.env.SEED_BASE_URL ?? "http://localhost:5173";

/**
 * `BASE_URL` がローカルホスト相当かどうかを検証し、そうでなければ
 * 即座にエラーで中断する。`SEED_BASE_URL` に本番/ステージング等の外部URLを
 * 誤って指定した場合に、公開済みパスワードのアカウントを作ってしまう事故を
 * 防ぐための最終防衛線。
 */
function assertLocalBaseUrl(baseUrl) {
  let hostname;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    console.error(`[seed:local] SEED_BASE_URL が不正なURLです: ${baseUrl}`);
    process.exit(1);
  }

  const isLocalHostname =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost");

  if (!isLocalHostname) {
    console.error(
      `[seed:local] SEED_BASE_URL (${baseUrl}) はローカルホストではありません。中断します。`
    );
    console.error(
      "  このスクリプトは平文パスワードをハードコードした開発専用シードです。" +
        " ローカルホスト (localhost / 127.0.0.1 / ::1 / *.localhost) 以外への実行は許可しません。"
    );
    process.exit(1);
  }
}

assertLocalBaseUrl(BASE_URL);

const ACCOUNTS = [
  {
    email: "alice@example.com",
    password: "Passw0rd!local",
    name: "Alice",
    tenant: { slug: "acme", name: "Acme Inc" },
  },
  {
    email: "bob@example.com",
    password: "Passw0rd!local",
    name: "Bob",
    tenant: { slug: "widgetco", name: "Widget Co" },
  },
  {
    email: "eve@example.com",
    password: "Passw0rd!local",
    name: "Eve",
    tenant: null,
  },
];

/**
 * dev サーバが起動しているか確認する。未起動なら明示的なエラーで中断する
 * (fetch の ECONNREFUSED をそのまま見せても分かりにくいため)。
 */
async function assertDevServerRunning() {
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    if (!res.ok) {
      throw new Error(`unexpected status ${res.status}`);
    }
  } catch (err) {
    console.error(
      `[seed:local] 開発サーバ (${BASE_URL}) に接続できません。先に \`pnpm run dev\` を起動してください。`
    );
    console.error(`  詳細: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * Response の Set-Cookie を「次のリクエストの Cookie ヘッダ」用文字列に変換する。
 * Node (undici) の `Headers.getSetCookie()` は複数の Set-Cookie を配列で
 * 取得できる (単純な `get("set-cookie")` はカンマ結合されて壊れるため使わない)。
 */
function extractCookieHeader(res) {
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  if (setCookies.length === 0) return null;
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

/**
 * サインアップを試み、失敗 (既に登録済み等) した場合はサインインにフォール
 * バックしてセッション Cookie を取得する。
 */
async function getSessionCookie(email, password, name) {
  const signUpRes = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({ email, password, name }),
  });

  if (signUpRes.ok) {
    const cookie = extractCookieHeader(signUpRes);
    if (cookie) {
      return { cookie, mode: "signed-up (new)" };
    }
    // サインアップは成功したが自動サインインでセッションが返らなかった場合。
    // 明示的にサインインし直す。
  }

  const signInRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({ email, password }),
  });

  if (!signInRes.ok) {
    const text = await signInRes.text();
    throw new Error(
      `sign-in に失敗しました (email=${email}): ${signInRes.status} ${text}\n` +
        "  → パスワードが変更済みの可能性があります。`pnpm run reset:local` でローカル状態を" +
        " 初期化してから再度 `pnpm run dev` → `pnpm run seed:local` を実行してください。"
    );
  }
  const cookie = extractCookieHeader(signInRes);
  if (!cookie) {
    throw new Error(`sign-in はしたがセッション Cookie を取得できませんでした (email=${email})`);
  }
  return { cookie, mode: "signed-in (existing)" };
}

/**
 * テナントを作成する。slug が既に使用されている (409) 場合はスキップ扱いで
 * null を返す (エラーにしない = 冪等)。
 */
async function createTenant(cookie, slug, name) {
  const res = await fetch(`${BASE_URL}/api/tenants`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL, Cookie: cookie },
    body: JSON.stringify({ slug, name }),
  });

  if (res.status === 409) {
    // slug が既に使われているだけで、それが「このアカウントが過去に作った
    // テナント」だとは限らない (他アカウントが同じ slug を先に取っていた
    // 場合も 409 になる)。所有者を確認する手段がここには無いため、
    // 断定的な表現は避ける。
    console.log(
      `  [tenants] slug "${slug}" は既に使用されているためスキップします (冪等。所有者は未確認です)。`
    );
    return null;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`テナント作成に失敗しました (slug=${slug}): ${res.status} ${text}`);
  }
  return res.json();
}

async function main() {
  await assertDevServerRunning();

  // アカウント毎に「このスクリプト実行でテナントを実際に作成できたか」を
  // 記録する (409 スキップの場合、そのテナントを本当にこのアカウントが
  // 所有しているかはここでは確認できないため、サマリで断定しないため)。
  const tenantOwnershipConfirmed = new Map();

  for (const account of ACCOUNTS) {
    console.log(`\n[seed:local] ${account.email} ...`);
    const { cookie, mode } = await getSessionCookie(account.email, account.password, account.name);
    console.log(`  session: ${mode}`);

    if (account.tenant) {
      const created = await createTenant(cookie, account.tenant.slug, account.tenant.name);
      if (created) {
        console.log(`  tenant "${account.tenant.slug}" を作成しました (status=${created.status})`);
        tenantOwnershipConfirmed.set(account.email, true);
      } else {
        tenantOwnershipConfirmed.set(account.email, false);
      }
    }
  }

  console.log("\n=== seed:local 完了 ===");
  console.log("以下のアカウントでログインできます:\n");
  for (const account of ACCOUNTS) {
    let tenantInfo = "(テナント未所属)";
    if (account.tenant) {
      const confirmed = tenantOwnershipConfirmed.get(account.email);
      tenantInfo = confirmed
        ? `(tenant: ${account.tenant.slug} / ${account.tenant.name})`
        : `(tenant: ${account.tenant.slug} 相当を意図。slug 既存のためスキップ済み、所有者未確認)`;
    }
    console.log(`  ${account.email} / ${account.password} ${tenantInfo}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error("[seed:local] エラー:", err);
  process.exit(1);
});
