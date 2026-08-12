import { defineConfig } from "drizzle-kit";

// 制御プレーン D1 (DB_CONTROL) のマイグレーション生成用設定。
// テナント DB (migrations-tenant/) は動的作成のため drizzle-kit の対象外。
export default defineConfig({
  dialect: "sqlite",
  driver: "d1-http",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
