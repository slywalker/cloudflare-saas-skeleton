#!/usr/bin/env node
/**
 * `pnpm run reset:local` — ローカルのD1/KV/Workflow/DurableObject状態を
 * 初期化し、中央D1 (DB_CONTROL) にローカルマイグレーションを再適用する
 * (`setup:local` のマイグレーション適用部分を再実行する)。
 *
 * 【削除対象】`.wrangler/state/v3` 配下の以下ディレクトリのみ:
 *   - `d1`: 中央D1 (DB_CONTROL) / 共有ローカルテナントD1 (DB_TENANT_LOCAL)
 *   - `kv`: セッション/テナント台帳キャッシュ
 *   - `workflows`: TENANT_MIGRATIONS (src/workflows/tenant-migrations.ts) の
 *     実行インスタンス状態。D1 だけ消して Workflow の実行履歴が残ると、
 *     存在しないテナント/データを参照したまま不整合な状態になりうるため
 *     一緒に消す。
 *   - `do`: Durable Objects の永続化状態 (Workflow はDurable Objectsの上に
 *     実装されているため、`workflows` と合わせて消しておく必要がある)。
 * `targets` の中身は上記の固定リストのみで、外部入力を受け付けない。
 * 削除前に「解決済み絶対パスが `.wrangler/state/v3/` 配下にあること」を
 * 検証しているが、これは今のところ実際に脱出しうる入力経路が無いため
 * 発火しない防御的チェックであり、「厳密な安全弁」というより将来
 * `targets` がパラメータ化された場合に備えた保険的な検証である。
 *
 * seed (`pnpm run seed:local`) はここでは行わない (dev サーバの起動が
 * 前提のため)。実行後は `pnpm run dev` → `pnpm run seed:local` の順で
 * データを復元すること。
 */
import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, sep } from "node:path";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const stateDir = resolve(rootDir, ".wrangler", "state", "v3");

const targets = ["d1", "kv", "workflows", "do"].map((name) => resolve(stateDir, name));

for (const target of targets) {
  // 保険的チェック: 解決後のパスが必ず `${stateDir}${sep}` 配下にあることを
  // 検証してから削除する (現状の固定リストでは発火しないが、将来
  // targets がパラメータ化された場合の保険として維持する)。
  if (!target.startsWith(stateDir + sep)) {
    console.error(`[reset:local] 想定外のパスのため中断します: ${target}`);
    process.exit(1);
  }
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    console.log(`[reset:local] 削除しました: ${target}`);
  } else {
    console.log(`[reset:local] 存在しないためスキップします: ${target}`);
  }
}

console.log("[reset:local] 中央D1 (DB_CONTROL) にローカルマイグレーションを再適用します...");
const result = spawnSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "DB_CONTROL", "--local"], {
  cwd: rootDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.status !== 0) {
  console.error("[reset:local] マイグレーション適用に失敗しました。");
  process.exit(result.status ?? 1);
}

console.log(
  "\n[reset:local] 完了しました。KVも初期化されているため、`pnpm run dev` を起動してから" +
    " `pnpm run seed:local` を実行してデータを復元してください。"
);
