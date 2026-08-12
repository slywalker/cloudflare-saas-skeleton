import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// React SPA (src/client) + Workers (src/index.ts) を単一の vite ビルドで扱う。
// @cloudflare/vite-plugin が Worker のビルド/デプロイと dev サーバの統合を担う。
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
});
