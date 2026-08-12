/**
 * Vite の import.meta.glob (?raw eager 版) の最小型定義。
 * プロジェクトの tsconfig.json は "vite/client" を含めていないため、
 * src/tenant-migrations.ts で使う形だけをここで補う。
 */
interface ImportMeta {
  glob(
    pattern: string,
    options: { query: "?raw"; import: "default"; eager: true }
  ): Record<string, string>;
}
