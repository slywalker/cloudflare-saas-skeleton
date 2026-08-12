#!/usr/bin/env node
/**
 * `pnpm run setup:local` — ローカル開発を即座に始めるための一発セットアップ。
 *
 * 1. .dev.vars が無ければ .dev.vars.example からコピーする
 *    (secrets未設定でもローカルテナントDBモードに自動フォールバックするため、
 *    値を埋めなくてもそのまま動く)
 * 2. 中央D1 (DB_CONTROL) にローカルマイグレーションを適用する
 *
 * このスクリプト自体はローカル専用。本番セットアップは README の
 * 「セットアップ」節 (wrangler d1 create 等) を参照すること。
 */
import { existsSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const devVarsPath = join(rootDir, ".dev.vars");
const devVarsExamplePath = join(rootDir, ".dev.vars.example");

if (!existsSync(devVarsPath)) {
  copyFileSync(devVarsExamplePath, devVarsPath);
  console.log("[setup:local] .dev.vars.example から .dev.vars を作成しました。");
} else {
  console.log("[setup:local] .dev.vars は既に存在するためスキップします。");
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
