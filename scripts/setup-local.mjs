#!/usr/bin/env node
/**
 * `pnpm run setup:local` — ローカル開発を即座に始めるための一発セットアップ。
 *
 * 1. .dev.vars が無ければ .dev.vars.example からコピーする
 *    (secrets未設定でもローカルテナントDBモードに自動フォールバックするため、
 *    値を埋めなくてもそのまま動く)
 *    既に .dev.vars がある場合はコピーせず、.dev.vars.example に存在する
 *    キーのうち .dev.vars に無い(コメントアウトされているものを含む)ものを
 *    検出して警告表示する(自動追記はしない。値の上書きによる事故を避ける)。
 * 2. 中央D1 (DB_CONTROL) にローカルマイグレーションを適用する
 *
 * このスクリプト自体はローカル専用。本番セットアップは README の
 * 「セットアップ」節 (wrangler d1 create 等) を参照すること。
 */
import { existsSync, copyFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const devVarsPath = join(rootDir, ".dev.vars");
const devVarsExamplePath = join(rootDir, ".dev.vars.example");

/**
 * `KEY=...` 形式の行から「そのファイルに存在するキー名」を抽出する
 * (値の中身は問わない)。コメント行 (`#` 始まり) や空行は無視する
 * (= コメントアウトされている行は「無い」扱いになる)。
 * `.dev.vars.example` 側のキー一覧 (=「本来存在すべきキーの集合」) を
 * 得るために使う。
 */
function extractKeys(content) {
  const keys = new Set();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match) keys.add(match[1]);
  }
  return keys;
}

/**
 * `CLOUDFLARE_ACCOUNT_ID=`/`CLOUDFLARE_API_TOKEN=` のように、空値のままで
 * 正当に運用できるキー。これらは「未設定」警告の対象から除外する
 * (isLocalTenantDbMode が CLOUDFLARE_API_TOKEN 未設定を検知して自動的に
 * ローカルモードへフォールバックする設計のため、空のままが通常運用)。
 */
const ALLOW_EMPTY_VALUE_KEYS = new Set(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);

/**
 * `.dev.vars` 側で「意味のある値が設定されている」とみなせるキー名の集合を
 * 抽出する。`KEY=` (空値) は `ALLOW_EMPTY_VALUE_KEYS` に含まれない限り
 * 「未設定」として扱う (例: `TENANT_DB_MODE=` は空文字なので警告対象。
 * コメントアウト `# TENANT_DB_MODE=local` も同様に警告対象)。
 */
function extractSetKeys(content) {
  const keys = new Set();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (value.trim().length > 0 || ALLOW_EMPTY_VALUE_KEYS.has(key)) {
      keys.add(key);
    }
  }
  return keys;
}

if (!existsSync(devVarsPath)) {
  copyFileSync(devVarsExamplePath, devVarsPath);
  console.log("[setup:local] .dev.vars.example から .dev.vars を作成しました。");
} else {
  console.log("[setup:local] .dev.vars は既に存在するためスキップします。");

  const exampleKeys = extractKeys(readFileSync(devVarsExamplePath, "utf-8"));
  const currentSetKeys = extractSetKeys(readFileSync(devVarsPath, "utf-8"));
  const missingKeys = [...exampleKeys].filter((key) => !currentSetKeys.has(key));
  if (missingKeys.length > 0) {
    console.warn(
      `[setup:local] 警告: .dev.vars.example にあるが .dev.vars で未設定(欠落・コメントアウト・空値のいずれか)のキー: ${missingKeys.join(", ")}`
    );
    console.warn("[setup:local]   自動追記はしません。必要に応じて .dev.vars に手動で追記してください。");
  }
}

console.log("[setup:local] 中央D1 (DB_CONTROL) にローカルマイグレーションを適用します...");
const result = spawnSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "DB_CONTROL", "--local"], {
  cwd: rootDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.status !== 0) {
  console.error("[setup:local] マイグレーション適用に失敗しました。");
  process.exit(result.status ?? 1);
}

console.log("\n[setup:local] 完了しました。`pnpm run dev` でローカル開発サーバを起動できます。");
